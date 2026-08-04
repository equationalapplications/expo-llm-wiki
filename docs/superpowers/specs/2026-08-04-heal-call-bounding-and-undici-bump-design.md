# Heal Call Bounding and Undici Advisory Bump

**Date:** 2026-08-04
**Status:** Draft
**Addresses:** #67 (bound heal's LLM calls per pass), 5 open Dependabot alerts (#96, #99, #102,
#105, #108 — all `undici`)

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
  genuinely newer remote edit.

#### A3: constants

```ts
export const HEAL_BATCH_SIZE = 25;                              // candidates fetched per pass
export const HEAL_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;         // 7 days, matches ontology backfill
```

`HEAL_BATCH_SIZE` bounds the pool `runBatched` draws from, not the size of an individual LLM call —
`runBatched` still packs ~10 candidates per request and splits further on failure. At the default,
one pass costs at most ~2-3 calls instead of the current unbounded count.

#### A4: `doRunHeal`

- Accepts `options?.batchSize`, validated identically to `doRunOntologyBackfill`
  (`Number.isInteger(batchSize) && batchSize >= 1`, else throw).
- Orphan-marking and stale-inferred-downgrade (`MaintenanceService.ts:484-501`) are unchanged: pure
  SQL updates against the full entity, not LLM calls, so they're not part of the #67 problem and
  stay unbounded.
- `findHealCandidatesByEntityId` call gains `batchSize` and `recheckCutoff = now - HEAL_RECHECK_MS`.
- If no candidates are eligible, return early with a zeroed result and
  `remaining = (await countHealCandidatesByEntityId(...)).eligible` (mirrors the
  `doRunOntologyBackfill` empty-candidates early return).
- After `runBatched` resolves, every candidate offered this pass — whether it landed in a
  successful batch or in `outcome.skipped` — gets `heal_checked_at` stamped via `markHealChecked`
  in the same transaction as the fact mutations. Skipped candidates get the same cooldown as
  processed ones, matching ontology backfill's reasoning: otherwise they'd stay at the head of the
  `updated_at ASC` queue and starve everything behind them.
- Final `remaining`/`deferred` come from `countHealCandidatesByEntityId` after the pass, same as
  ontology backfill's post-pass count.

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

`MaintenanceService.runHeal` / `doRunHeal`, `WikiMemory.runHeal`, and
`useWikiMaintenance().runHeal` (`packages/react/src/useWikiMaintenance.ts`) all change from
`Promise<void>` to `Promise<HealResult>`. `apps/wiki-demo/src/components/MaintenanceTab.tsx` is
updated to read the result instead of ignoring it (matches how a future ontology-backfill UI would
read `remaining`). `runHeal`'s JSDoc on `WikiMemory` gets a convergence-loop note matching the block
already on `runOntologyBackfill`.

This is a minor breaking change (return type only, no parameter changes) — call sites that
`await runHeal(...)` without using the return value are unaffected; call sites destructuring or
type-annotating the old `void` return need updating. None exist in this repo outside the four files
above.

#### A6: testing

- `healQueries.test.ts` — extend for `LIMIT`, cooldown filtering, and `ASC` ordering on
  `findHealCandidatesByEntityId`; add coverage for `countHealCandidatesByEntityId` and
  `markHealChecked`.
- `heal-retention-boundary.test.ts` / `MaintenanceService.test.ts` — a test asserting a corpus
  larger than `batchSize` requires multiple passes to fully cover (`remaining > 0` after pass one,
  `0` after enough passes), mirroring the existing `ontologyBackfill.test.ts` convergence test.
- A regression test confirming a fact stamped with `heal_checked_at` in pass N is excluded from pass
  N+1's candidates while inside the cooldown.

### Workstream B — undici bump

One-line change: `pnpm-workspace.yaml`'s override moves from
`undici@>=7.0.0 <7.28.0: 7.28.0` to `undici@>=7.0.0 <7.29.0: 7.29.0`. This is the single existing
override entry that governs all five alerts (`pnpm-lock.yaml` is the only manifest they're filed
against — the alert against root `package-lock.json`, #107, is already `state: fixed` because that
file was removed in #66's C1).

**Verification:** `pnpm install`, confirm the lockfile diff touches only `undici`/`undici-types`
entries, then full `pnpm test`.

## Sequencing

1. **Workstream B** — one-line, isolated, unblocks a clean lockfile before touching application
   code.
2. **Workstream A** — schema migration, repository, service, and three downstream call sites.

## Public API impact

- `MaintenanceService.runHeal` / `doRunHeal`, `WikiMemory.runHeal`: return type
  `Promise<void>` → `Promise<HealResult>`. **Breaking.**
- `useWikiMaintenance().runHeal`: same. **Breaking.**
- New exported type `HealResult`.
- New exported constants `HEAL_BATCH_SIZE`, `HEAL_RECHECK_MS`.
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
