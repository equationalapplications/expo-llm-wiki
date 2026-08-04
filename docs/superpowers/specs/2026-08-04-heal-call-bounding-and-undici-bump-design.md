# Heal Call Bounding and Undici Advisory Bump

**Date:** 2026-08-04
**Status:** Implemented
**Addresses:** #67 (bound heal's LLM calls per pass), 5 open Dependabot alerts
(#96, #99, #102, #105, #108 — all `undici`)

## Problem

### #67 — heal has no per-pass call bound

[#66](https://github.com/equationalapplications/expo-llm-wiki/pull/66) bounded heal's prompt
*size* via `runBatched` (`packages/core/src/services/BoundedLlmCall.ts`), fixing #63/#65. It did
not bound the *number* of calls a single `runHeal` pass makes.

`doRunHeal` (`packages/core/src/services/MaintenanceService.ts:503`) calls
`findHealCandidatesByEntityId`, which returns every live mutable fact for the entity with no
`LIMIT`. `runBatched` then sends roughly one request per ~10 candidates. On the corpus behind #63
that's 3-4 calls; on an entity with 10,000 mutable facts it's ~1,000 sequential provider calls
inside one `runHeal`, with the `heal` job lock (`JobManager`) held for the entire duration.

`doRunOntologyBackfill` already has the shape to copy: `findUntypedByEntityId` takes a `batchSize`
and a `recheckCutoff` (`ontology_checked_at` cooldown column, `ONTOLOGY_BACKFILL_RECHECK_MS`), and
`OntologyBackfillResult.remaining` lets a host loop passes to convergence
(`while (result.remaining > 0)`). Heal has no equivalent: no per-pass cap, no cooldown so
successive passes advance, and no way for a caller to know whether a corpus was fully covered by
one pass.

#### Where heal differs from ontology backfill

The shape transfers, but three properties of backfill that make it safe to bound do **not** hold
for heal, and each needs explicit handling below rather than a straight copy:

1. **Backfill's candidate predicate is monotone; heal's is not.** Typing a fact removes it from
   `okf_type IS NULL` permanently, and backfill never creates untyped facts. Heal's predicate is
   `deleted_at IS NULL AND source_type != 'immutable_document'` — the steady-state corpus — and
   every `librarian_inferred` fact heal synthesizes is itself immediately an eligible candidate.
   Without care, a `while (remaining > 0)` host loop chases heal's own output (see A4).
2. **Heal reads its full candidate set for a second purpose.** `healFactsForDedupe`
   (`MaintenanceService.ts:572`) is the fuzzy-dedupe corpus that stops heal re-synthesizing facts
   it already created. Bounding the candidate query silently bounds the dedupe corpus too (see A2,
   A4). Backfill has no analogous whole-corpus read tied to its candidate query — its full-breadth
   read (`findTitleIndexByEntityId`) is already a separate query.
3. **Heal has a caller that never loops.** `WriteService.runLibrarianThenMaybeHeal`
   (`WriteService.ts:110-136`) auto-runs heal on a write checkpoint and advances the checkpoint
   unconditionally. Backfill has no auto-run caller. Bounding heal without touching this path caps
   auto-heal coverage at one batch per `autoHealThreshold` events (see A5).

### Dependency alerts — `undici` < 7.29.0

[2026-08-04-maintenance-bounding-and-dependency-hygiene-design.md](2026-08-04-maintenance-bounding-and-dependency-hygiene-design.md)
(#66) pinned `undici` via a `pnpm-workspace.yaml` override to close prior advisories. Five new
`undici` advisories were published since (GHSA-8xcm-r25x-g524, GHSA-4cwx-7wf7-3272,
GHSA-v3r7-h72x-cjcm, GHSA-jr45-8vmc-qm54, GHSA-m8rv-5g2x-5cg5), all fixed in 7.29.0. The current
override caps at `7.28.0`, one patch release below the fix. All five alerts are the same root
cause and the same fix.

## Design

### Workstream A — bound heal (#67)

Copies `doRunOntologyBackfill`'s shape.

#### A1: schema — `heal_checked_at`

Migration v8, following the exact v7 pattern (`packages/core/src/db/migrations.ts:115-131`): `ALTER
TABLE entries ADD COLUMN heal_checked_at INTEGER`, guarded by `PRAGMA table_info` and run outside a
transaction (SQLite/expo-sqlite requirement, same as v2/v3/v5/v7). Added to `schema.ts`'s
`CREATE TABLE` for fresh databases alongside `ontology_checked_at`.

#### A2: repository (`EntryRepository`)

- `findHealCandidatesByEntityId(entityId, limit, recheckCutoff, tx?)` — adds `LIMIT ?` and
  `AND (heal_checked_at IS NULL OR heal_checked_at <= ?)` to the existing query. Ordering changes
  from `updated_at DESC` to `updated_at ASC` (oldest-first), matching `findUntypedByEntityId`: with
  a cooldown in place, newest-first would keep re-selecting recently-touched facts every pass while
  older ones wait indefinitely to even enter a batch.
- `countHealCandidatesByEntityId(entityId, recheckCutoff, tx?)` → `{ eligible, deferred }`, same
  shape as `countUntypedByEntityId`.
- `markHealChecked(ids, entityId, now, tx)` — stamps `heal_checked_at`, chunked like
  `markOntologyChecked`. Never touches `updated_at`, for the same reason: import merge resolution
  is last-write-wins on `updated_at`, and a bump here would make an unchanged local fact beat a
  genuinely newer remote edit. Carries `markOntologyChecked`'s `AND deleted_at IS NULL` guard, so
  candidates heal soft-deletes earlier in the same transaction are not stamped. That is correct and
  intentional — a deleted row is no longer a candidate under any future pass, so its cooldown value
  is irrelevant — but it means the stamped-id count can be lower than the offered-candidate count,
  and A6's tests must not assert equality between them.
- `findInferredTitlesByEntityId(entityId, tx?)` → `Array<{ id: string; title: string }>` — live
  `librarian_inferred` facts, id and title only, no `LIMIT`. This is the dedupe corpus, split out
  from the candidate query (see A4's dedupe note). Deliberately mirrors `findTitleIndexByEntityId`:
  full breadth, projected to the two columns the caller needs, so a whole-corpus read stays cheap
  even though the candidate read is now bounded.

#### A3: constants

```ts
export const HEAL_BATCH_SIZE = 25;                              // candidates fetched per pass
export const HEAL_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;         // 7 days, matches ontology backfill
```

`HEAL_BATCH_SIZE` bounds the pool `runBatched` draws from, not the size of an individual LLM call —
`runBatched` still packs ~10 candidates per request and splits further on failure. At the default,
one pass costs at most ~2-3 calls instead of the current unbounded count.

#### A4: `doRunHeal`

- **Signature change.** `doRunHeal` is currently `(entityId: string, promptOverride?: string)` —
  positional, not an options object (`MaintenanceService.ts:469`). It becomes
  `(entityId: string, options?: { promptOverride?: string; batchSize?: number })`, matching
  `doRunOntologyBackfill`. This is a parameter-level breaking change on a method that appears in the
  published `.d.ts`; call sites updated are `MaintenanceService.runHeal` (:173), `WriteService`
  (:132, passes no options), and `MaintenanceService.test.ts:157` (passes a bare
  `'custom heal override'` string). Chosen over a third positional parameter so heal and backfill
  read the same at every layer.
- `batchSize` defaults to `HEAL_BATCH_SIZE` and is validated identically to `doRunOntologyBackfill`
  (`Number.isInteger(batchSize) && batchSize >= 1`, else throw).
- Orphan-marking and stale-inferred-downgrade (`MaintenanceService.ts:484-501`) stay unbounded: pure
  SQL updates against the full entity, not LLM calls, so they're not part of the #67 problem. They
  do however feed the result counters — `markOrphaned` already returns its ids and
  `downgradeStaleInferred` is changed to return ids rather than a row count, so `deleted` and
  `downgraded` are unions of the SQL-pass ids and the model-directed ids. Without this a pass that
  soft-deletes 50 orphans but offers no candidates would report `deleted: 0`. Union rather than sum:
  the orphan pass runs before candidate selection so its ids cannot also be model-deleted, but a
  fact the stale pass downgraded can be downgraded again by the model in the same pass.
- `findHealCandidatesByEntityId` call gains `batchSize` and `recheckCutoff = now - HEAL_RECHECK_MS`.
- If no candidates are eligible, return early with a zeroed result and
  `remaining = (await countHealCandidatesByEntityId(...)).eligible` (mirrors the
  `doRunOntologyBackfill` empty-candidates early return).
- After `runBatched` resolves, every candidate offered this pass — whether it landed in a
  successful batch or in `outcome.skipped` — gets `heal_checked_at` stamped via `markHealChecked`
  in the same transaction as the fact mutations. Skipped candidates get the same cooldown as
  processed ones, matching ontology backfill's reasoning: otherwise they'd stay at the head of the
  `updated_at ASC` queue and starve everything behind them.
- **Dedupe corpus is decoupled from the candidate window.** `healFactsForDedupe`
  (`MaintenanceService.ts:572`) currently seeds from `healCandidates`. Left as-is, bounding the
  candidate query would shrink the dedupe corpus from "every mutable fact" to "`batchSize` mutable
  facts," letting a synthesized fact that duplicates a `librarian_inferred` fact outside the window
  pass the Jaccard check — and a convergence loop would then multiply those duplicates across
  passes. So the seed changes to `findInferredTitlesByEntityId(entityId)` (A2), which is full
  breadth and independent of `batchSize`. The in-pass `healFactsForDedupe.push(...)` after each
  insert stays, so facts synthesized earlier in the same pass still dedupe against later ones. The
  loop's `if (existing.source_type !== 'librarian_inferred') continue;` filter is dropped: the new
  query already restricts to that source type, so the projected `{ id, title }` rows carry
  everything `titleTokens`/`jaccardScore` need.
- **Facts heal creates are stamped at insert** with `heal_checked_at = now`, in the same
  transaction as the `upsert`. Without this, every synthesized fact is an eligible candidate the
  instant it is written — `remaining` is nonzero immediately after a pass that fully covered the
  pre-existing queue, and a host `while (remaining > 0)` loop feeds on heal's own output. Stamping
  is also the semantically right answer independent of convergence: heal just wrote these facts,
  so there is nothing for the next pass to heal about them until the cooldown lapses.
- Final `remaining`/`deferred` come from `countHealCandidatesByEntityId` after the pass, same as
  ontology backfill's post-pass count. With the two rules above the count is well-founded: every
  candidate offered this pass is stamped or deleted, and every fact created this pass is stamped,
  so `remaining` strictly decreases across passes and a convergence loop terminates.

#### A5: return type (breaking change)

```ts
export interface HealResult {
  /** Heal candidates sent to the model this run. */
  scanned: number;
  /** Facts downgraded (immutable_document → mutable-eligible, or similar). */
  downgraded: number;
  /** Facts soft-deleted. */
  deleted: number;
  /** New facts synthesized by heal. */
  newFactsCreated: number;
  /** Candidates a batch could not process even alone, skipped so the pass could finish. */
  skipped: number;
  /** Heal candidates still eligible after this run — convergence signal: loop while > 0. */
  remaining: number;
  /** Heal candidates inside the recheck cooldown. */
  deferred: number;
}
```

**`remaining` does not mean the same thing it means for ontology backfill**, and the JSDoc must say
so. Untyped facts are a finite backlog that drains permanently. Heal's candidates are the live
mutable corpus, so `remaining` reaching `0` means "every mutable fact is inside the 7-day cooldown,"
not "there is no more work" — it climbs back as the cooldown lapses and as new facts are written.
A host loop still terminates (per A4), but it converges to "corpus swept once this cooldown window,"
which is the intended reading of a heal pass and worth stating outright so nobody writes a loop
expecting a drain.

`MaintenanceService.runHeal` / `doRunHeal`, `WikiMemory.runHeal` (`WikiMemory.ts:310`), and
`useWikiMaintenance().runHeal` (`packages/react/src/useWikiMaintenance.ts:37`) all change from
`Promise<void>` to `Promise<HealResult>`. `runHeal`'s options type gains `batchSize?: number`
alongside `promptOverride` at each layer — additive, non-breaking, unlike `doRunHeal`'s positional
change in A4. `runHeal`'s JSDoc on `WikiMemory` gets a convergence-loop note matching the block
already on `runOntologyBackfill`, including the `remaining` caveat above.

Call sites, all five:

| Site | Change |
|---|---|
| `MaintenanceService.runHeal` (:170) | `return await this.doRunHeal(...)` inside the existing lock `try` |
| `WikiMemory.runHeal` (:310) | return type + `batchSize` passthrough |
| `useWikiMaintenance().runHeal` (:37,:43) | return type; returns the result rather than discarding it |
| `MaintenanceTab.tsx` (:104) | reads the result — see below |
| `WriteService.runLibrarianThenMaybeHeal` (:132) | **A6** — behavioral, not just typed |

`MaintenanceTab.tsx`'s Heal button changes behaviorally, not only in type: it goes from healing the
whole entity to healing at most `HEAL_BATCH_SIZE` facts per press. The button surfaces `remaining`
in its result line so that cap is visible to whoever presses it, rather than silently doing a
fraction of the previous work.

This is a breaking change in both directions on `doRunHeal` (return type *and* parameter shape) and
return-type-only on the other three public entry points. Test call sites needing updates:
`MaintenanceService.test.ts:157` (positional override → options object) and `WriteService.test.ts:57`
(`doRunHeal` mock must resolve a `HealResult`, not `undefined`, once A6 reads the return value) with
its assertion at `:140`.

#### A6: auto-heal checkpoint (`WriteService`)

`runLibrarianThenMaybeHeal` (`WriteService.ts:110-136`) runs heal when
`currentEventCount - healCheckpoint >= autoHealThreshold` (default 100) and then advances the
checkpoint to `currentEventCount` unconditionally. Bounding `doRunHeal` without touching this
caps auto-heal at `HEAL_BATCH_SIZE` facts per `autoHealThreshold` events — on any corpus larger
than one batch, most facts would never be auto-healed. That is a straight regression against
today's behavior, where one auto-heal covers the entity.

**Fix:** advance the heal checkpoint only when the pass converged.

```ts
const result = await this.maintenanceService.doRunHeal(entityId);
if (result.remaining === 0) {
  await this.metadataRepo.updateCheckpoint(entityId, { heal: currentEventCount }, this.db);
}
```

Holding the checkpoint back is necessary but not sufficient. `runLibrarianThenMaybeHeal` only runs
after a librarian pass, and a successful librarian pass advances `memory` to `currentEventCount`, so
a partial heal at event 100 would not retry at event 101 — it would wait for the next librarian
threshold crossing (event 120 by default), or never retry if no further librarian pass runs. So the
heal check is also extracted into `maybeRunHeal(entityId, eventCount)` and scheduled from `write()`
on every write, guarded by `isBlocked('librarian', entityId)` so heal still never overlaps a
librarian pass and by `tryAcquireAutoHealLock` so a burst of writes cannot stack passes. With both
halves in place the next write runs another bounded pass, so a large corpus converges across
successive writes instead of inside one call. That is the trade this workstream is making: heal work is spread over many writes rather than
concentrated in one unbounded run, which is the point of #67. Cost per write stays bounded — a
librarian run plus ~2-3 heal calls — and once converged the checkpoint advances and heal goes quiet
for another `autoHealThreshold` events.

Two failure modes to keep in mind while implementing:

- The heal lock is `tryAcquireAutoHealLock`, so a concurrent manual `runHeal` makes the auto path
  skip rather than block. Unchanged by this.
- If `doRunHeal` throws, the checkpoint is not advanced today and still is not — the `finally` only
  releases the lock. The added `if` must sit inside the existing `try`, after the call, so a throw
  keeps its current behavior.

#### A7: testing

- `healQueries.test.ts` — extend for `LIMIT`, cooldown filtering, and `ASC` ordering on
  `findHealCandidatesByEntityId`; add coverage for `countHealCandidatesByEntityId`,
  `markHealChecked` (including that a soft-deleted row is not stamped, per A2), and
  `findInferredTitlesByEntityId` (full breadth, live + `librarian_inferred` only).
- `heal-retention-boundary.test.ts` / `MaintenanceService.test.ts` — a test asserting a corpus
  larger than `batchSize` requires multiple passes to fully cover (`remaining > 0` after pass one,
  `0` after enough passes), mirroring the existing `ontologyBackfill.test.ts` convergence test.
- A regression test confirming a fact stamped with `heal_checked_at` in pass N is excluded from pass
  N+1's candidates while inside the cooldown.
- **Convergence under synthesis** (A4): a pass whose model output creates new facts still reports
  `remaining === 0` when the pre-existing queue is exhausted — i.e. synthesized facts are stamped at
  insert and do not re-enter the candidate set. This is the test that would fail if the stamping
  rule were dropped, and the loop it protects is the one a host is told to write.
- **Dedupe breadth** (A4): with `batchSize` smaller than the corpus, a synthesized fact duplicating
  a `librarian_inferred` fact *outside* the candidate window is still deduped. Directly exercises
  the `findInferredTitlesByEntityId` split; would pass trivially if dedupe still seeded from
  `healCandidates` only because the fixture happened to fit in one batch, so the fixture must be
  larger than `batchSize` by construction.
- **Auto-heal checkpoint** (A6), in `WriteService.test.ts`: checkpoint does not advance when
  `doRunHeal` resolves `remaining > 0`, does advance on `remaining === 0`, and still does not
  advance when `doRunHeal` throws.

### Workstream B — undici bump

One-line change: `pnpm-workspace.yaml`'s override moves from
`undici@>=7.0.0 <7.28.0: 7.28.0` to `undici@>=7.0.0 <7.29.0: 7.29.0`. This is the single existing
override entry that governs all five alerts (`pnpm-lock.yaml` is the only manifest they're filed
against — the alert against root `package-lock.json`, #107, is already `state: fixed` because that
file was removed in #66's C1).

**Verification:** `pnpm install`, confirm the lockfile diff touches only `undici`/`undici-types`
entries, then full `pnpm test`.

The override range is 7.x-scoped, and undici has since published an 8.x line (8.10.0 at spec time)
that the override does not cover. That is correct for these five advisories — all are filed against
the 7.x range and fixed in 7.29.0 — but it means the lockfile check must confirm that nothing in the
tree resolves to an 8.x undici, not merely that the only entries that moved were undici's. If an
8.x resolution does appear, it is outside this override and needs its own alert check rather than a
widened range.

## Sequencing

1. **Workstream B** — one-line, isolated, unblocks a clean lockfile before touching application
   code.
2. **Workstream A** — schema migration (A1), repository (A2/A3), service (A4), the four public
   call sites (A5), and the auto-heal checkpoint (A6). A6 depends on A5's return type, so it lands
   last; A4's dedupe split depends on A2's new query.

## Public API impact

- `MaintenanceService.runHeal`, `WikiMemory.runHeal`: return type `Promise<void>` →
  `Promise<HealResult>`; options gain `batchSize?: number`. **Breaking** (return type; the option is
  additive).
- `useWikiMaintenance().runHeal`: same. **Breaking.**
- `MaintenanceService.doRunHeal`: return type as above, **and** signature
  `(entityId, promptOverride?: string)` → `(entityId, options?: { promptOverride?, batchSize? })`.
  **Breaking in both parameter and return position** — the one entry point where existing callers
  break on arguments, not just on the value they ignore.
- Behavioral, not type-visible: a single `runHeal` call now covers at most `HEAL_BATCH_SIZE`
  candidates rather than the whole entity. Callers that relied on one call sweeping the corpus must
  loop on `remaining` (hosts) — `WriteService`'s auto-heal path is adjusted for this in A6. This is
  the change most likely to surprise, since it does not produce a compile error.
- New exported type `HealResult`.
- New exported constants `HEAL_BATCH_SIZE`, `HEAL_RECHECK_MS`.
- New repository method `EntryRepository.findInferredTitlesByEntityId`.
- Repo uses `semantic-release` off conventional commits (current version 4.23.0, already past 1.0).
  The commit introducing the `HealResult` return-type change must carry a `BREAKING CHANGE:` footer
  so `semantic-release` cuts a major version bump automatically; a plain `fix:`/`feat:` commit here
  would under-version a real breaking change.

## Out of scope

- The other three hardening ideas raised alongside this request (root `.npmrc` with
  `save-exact=true`, exact `workspace:` pinning, `--frozen-lockfile` in `deploy.yml`) — deferred to
  a separate follow-up per user decision; `pnpm.overrides` in root `package.json` specifically
  rejected, since `pnpm-workspace.yaml` already carries a comment recording that pnpm 10 silently
  drops the `pnpm-workspace.yaml` override set when both exist.
- Any other Dependabot alerts beyond the five `undici` ones — none were open at spec time; if new
  ones appear before this branch merges, re-run the alert query and decide per-alert.
- Bounding the orphan-marking and stale-inferred-downgrade SQL passes inside `doRunHeal` — not LLM
  calls, not the subject of #67.
- Retrofitting a host-side convergence-loop UI for heal (e.g., a "run to convergence" button) —
  `HealResult.remaining` makes it possible, but no UI consumer asked for it yet; `MaintenanceTab.tsx`
  is updated only to not discard the new return value.
