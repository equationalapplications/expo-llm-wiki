# expire() — end a fact's validity without a replacement (archive, not deletion)

**Status: Draft (2026-11-17)**  
**Design ratified by the owner 2026-11-17** ("thin `setTemporal` wrapper,
archive-without-replacement") as the T11 follow-up lane of the forget-erasure
cycle; INTENT rule 12 already names the verb. No dedicated issue: the anchor
is forget-erasure `plan.md` T11 and INTENT.md rule 12.  
**Intent check:** INTENT rule 12 (the verb exists in wording, not in API)
and the INTENT glossary (~:97-104), which already classifies
expire-ended facts as Superseded ("An archive is a superseded fact") —
this spec builds the verb the INTENT text already promises; the only
INTENT.md edit is the stale spec-home sentence (:346-347), updated to
point at `specs/expire/`.

## Problem

INTENT rule 12 promises four verbs that move a fact between states:
"supersede/expire end a fact's validity (supersede names a replacement;
`expire()` ends a fact's validity without a replacement — an archive, not a
deletion)". Only `supersede()` exists
(`packages/core/src/services/TemporalService.ts`, `WikiMemory.supersede` at
`packages/core/src/WikiMemory.ts:1179`). A host that wants to end a fact's
validity without naming a replacement — the "as of this date this was no
longer true, but keep it in the archive" case — has no API and must fake it
with a supersede plus a throwaway replacement row, which pollutes the
supersession chain and the entity's fact list.

## Root cause

Not a defect: `expire()` was deliberately deferred from the forget-erasure
lane (T11 note) so that lane stayed scoped to erasure. The temporal
machinery it needs already exists and is exercised by `supersede()`:
`EntryRepository.setTemporal` (`EntryRepository.ts:1035` — "write any subset
of the four temporal columns"), the liveness predicates
(`packages/core/src/utils/temporal.ts` `liveAtSql`/`isLiveAt`), the expired
projection `findExpiredIds` (`EntryRepository.ts:1158`), and the prune hook
that applies retention to expired rows
(`MaintenanceService.ts:340`, gated by `pruneSupersededAfter`, off by
default).

## The decisions

**D1 — API shape.** `WikiMemory.expire(entityId, factId, options?: { at?:
number }): Promise<void>`, implemented by
`TemporalService.expire(entityId, factId, options?)`. `at` defaults to
`Date.now()`; validated with `assertEpochMs` (same rule as `supersede`'s
`validFrom`). A past `at` is legal — expiry is retro-active archiving, and
`asOf` reads honor it — but an **inverted or empty interval is rejected**:
after the row is read, `at <= (row.valid_from ?? row.created_at)` throws
`WikiSupersedeError('invalid_interval')` (a new `WikiSupersedeReason`, so
hosts handling `WikiSupersedeError` catch it — a bare `TypeError` would
slip past them). Liveness is half-open
(`COALESCE(valid_from, created_at) <= T < valid_to`,
`utils/temporal.ts:6-7`), so `at == start` is an empty interval, not a
point-in-time archive. Two documented consequences: a fact recorded today
cannot be expired before its `created_at` (matches `asOf` semantics —
"retro-active" reaches back only to the fact's own validity start), and a
default `at` can reject on a fact whose `valid_from` is future-dated.
`supersede()` has the same pre-existing gap
(`TemporalService.ts:43` never checks `t` against the old row's start);
that is a separate concern and is filed as its own issue at
implementation time, not folded into this MINOR.

**D2 — semantics: one column, nothing else.** Inside a transaction, a single
`setTemporal(id, entityId, { valid_to: t }, tx)` (the outbox UPDATE is
pushed by `setTemporal` itself). `expire()` never touches `superseded_by`,
`superseded_at`, or `deleted_at`. Because `setTemporal` filters
`WHERE id = ? AND entity_id = ?` and returns its `changes` count
(`EntryRepository.ts:1046-1054`), the implementation treats a
**`changes === 0` return as a cross_entity-class failure** — a fact owned
by another entity must fail loudly, never resolve silently as archived.
The fact stays in the store: current reads (`liveAtSql('current')`) exclude
it once `valid_to <= now`, `asOf` reads at `T < valid_to` still return it,
and `history()` keeps it in the chain. This is the "archive, not a
deletion" wording of INTENT rule 12, and the INTENT glossary's own
classification ("An archive is a superseded fact", ~:97-104).

**D3 — guards (reuse `WikiSupersedeError`, thin; order mirrors the code).**
`expire()` reuses `supersedeInTx`'s guard set in `supersedeInTx`'s own
evaluation order (`TemporalService.ts:27-31`: `not_found → cross_entity →
already_superseded → immutable_target`), then its own expiry check last:

- `not_found` — fact missing or `deleted_at != null`;
- `cross_entity` — `old.entity_id !== entityId` (same check as
  `supersedeInTx`, `TemporalService.ts:29`; `findTemporalRow` has no
  entity filter, `EntryRepository.ts:1057-1062`, so the explicit guard is
  load-bearing, backstopped by D2's `changes === 0` rule);
- `already_superseded` — `superseded_by != null` (end validity through the
  chain, not a second verb);
- `immutable_target` — `source_type === 'immutable_document'` (same rule as
  supersede: documents are host property, never verb-mutated);
- `already_expired` — `valid_to != null` (no silent overwrite; the host
  decides). Future-dated expiries are included: a `valid_to` still in the
  future is a scheduled end of validity, and correcting it is out of scope
  (Non-goals).

**D3b — supersede-after-expire is rejected, not silently rewritten.**
Today `supersedeInTx` has no `valid_to` guard, so superseding an expired
fact passes and line 43 **overwrites the archived `valid_to`** with the
new time — the archive date is lost without an error, contradicting this
spec's rejection of silent temporal rewrites. `supersedeInTx` gains the
guard: old row has `valid_to != null` → `WikiSupersedeError
('already_expired')`. **Guard placement:** the check runs **after** the
existing `already_superseded` check (`TemporalService.ts:30`) — every
superseded row also carries `valid_to` (line 43 writes it), so a
misplaced check would turn every double-supersede into `already_expired`
and break the existing expectations (`supersede.test.ts:64-70`). The
librarian path shares the function
(`apply.ts:204`), so the guard covers it too; a host that wants a
replacement for an archived fact supersedes the **successor** fact, not
the archived one. Test plan item 2b pins this, including the
double-supersede regression case.

The `WikiSupersedeReason` union gains `'already_expired'` and
`'invalid_interval'`; the class constructor grows an optional verb
(`supersede()` default, `expire()` from the new path) so messages stay
accurate without breaking callers.

**D4 — post-commit effects (mirror `supersede`).** After the transaction
commits: `searchService.syncEntries(entityId, [factId])` (the same call
`supersede` makes — the index drops the now-non-live row) and
`evictCache(entityId)`. No embedding call: `expire()` creates no new row, and
the stored fact's embedding stays with it (retrieval already excludes
non-live facts); there is no vector removal — the fact is not forgotten.

**D5 — prune relationship: stated, covered by the glossary.** Rows with
`valid_to` set — expired by this verb **and** superseded rows — enter the
prune path through `findExpiredIds`
(`EntryRepository.ts:1158`, "valid_to IS NOT NULL"), which
`runPrune` soft-deletes only when `pruneSupersededAfter` is set (off by
default), after their retention window (`MaintenanceService.ts:335-354`);
retention is host policy. `expire()` itself deletes nothing. No INTENT
rule 12 amendment is needed: the glossary already classifies
expire-ended facts as **Superseded** ("ended without a replacement by
`expire()`. An archive is a superseded fact", INTENT.md ~:97-104), so
rule 12's "turn superseded into forgotten" already covers them, and the
engine documents the expired-or-superseded pairing
(`packages/core/src/types.ts:309-311`). The only INTENT.md edit in this
PR: the stale sentence "expire() is ratified and needs a spec home before
it is built" (:346-347) becomes "expire()'s spec home is `specs/expire/`"
— committed on this PR's branch at implementation time, before merge (the
draft phase carries only `specs/expire/`).
No prune code changes.

**D6 — exposure: core only.** The react/expo wrappers do not forward
`supersede()` today (grep-verified); `expire()` matches. No wrapper, no
schema migration (no new columns or tables).

**D7 — docs.** apps/docs: the temporal/supersession API page gains `expire()`
alongside `supersede`/`history`, and the temporal guide names it per INTENT
rule 12's wording ("an archive, not a deletion"). Both places that describe
`WikiSupersedeError` as supersede-only update too:
`reference/errors.md:36` ("`supersede()` was refused" → shared by
`supersede()`/`expire()`) and `guides/temporal-facts.md:40` (the Rules
section gains the expire rules and the new reasons).

## Files touched

- `packages/core/src/services/TemporalService.ts` — `expire()`.
- `packages/core/src/WikiMemory.ts` — facade method + JSDoc citing INTENT
  rule 12.
- `packages/core/src/types.ts` — `WikiSupersedeReason` gains
  `'already_expired'` and `'invalid_interval'`; `WikiSupersedeError` gains
  the verb parameter.
- `packages/core/src/services/TemporalService.ts` — `expire()` (D1) and
  the `supersedeInTx` `valid_to` guard (D3b).
- `INTENT.md` — one sentence: the spec-home line (:346-347) points at
  `specs/expire/` (D5). No rule wording changes.
- `packages/core/__tests__/temporalRoundTrip.test.ts` (+ a focused new test
  file if the suite style prefers it) — test plan below.
- `apps/docs/src/content/docs/` — API page + guide (D7).

Out of scope: react/expo wrappers (D6), schema/migrations (D6), prune or
retention changes (D5), `forget`/`erase` behavior.

## Test plan (acceptance criteria)

1. `expire()` sets `valid_to` only: row keeps `superseded_by = NULL`,
   `deleted_at = NULL`, body unchanged; `asOf` read at `valid_to - 1`
   returns it, at `valid_to` it does not; current read excludes it. [V]
2. Guards reject without writing: `not_found` (unknown id), `not_found`
   (soft-deleted fact), `cross_entity` (fact owned by another entity —
   row byte-identical, no outbox push), `immutable_target`,
   `already_superseded`, `already_expired` — each leaves the row
   byte-identical; a superseded row (has both `superseded_by` and
   `valid_to`) reports `already_superseded`, never `already_expired`
   (guard order mirrors `supersedeInTx`). [V]
2b. **Supersede-after-expire rejected** (D3b): `supersede()` on a fact
   with `valid_to != null` throws `already_expired` and the row is
   unchanged — the archived `valid_to` is never rewritten; a
   double-supersede (superseded row) still reports `already_superseded`
   (guard runs after the existing check — regression case pinned, D3b).
   [V]
3. Default `at` = now; explicit past `at` honored; non-epoch `at` throws
   `TypeError` (assertEpochMs); `at <= (valid_from ?? created_at)` throws
   `WikiSupersedeError('invalid_interval')` — including `at == start`
   (empty half-open interval, D1). [V]
4. Outbox: one UPDATE payload carrying `id`, `entity_id`, `valid_to`. [V]
5. Search: after `expire()` + sync, search no longer returns the fact
   (mirror the supersede search test). [V]
6. `history()` still traverses through the expired fact. [V]
7. Prune integration: with `pruneSupersededAfter` set, a `runPrune` after
   the window soft-deletes the expired row (existing `findExpiredIds`
   path). [V]
8. Type widening compiles: existing supersede callers unaffected (verb
   default). [V]
9. Docs build green with the new API page content. [V]

## Rejected alternatives

- **Separate `WikiExpireError` type** — two error types for one guard family
  doubles host handling code for no information gain; the reason code
  already disambiguates.
- **Overwrite/lower an existing `valid_to`** — silent temporal rewrites are
  exactly what `already_superseded` guards against on the supersede side;
  D3b extends the same protection to supersede-after-expire.
- **Allow supersede of an expired fact** — `supersedeInTx` line 43 would
  overwrite the archived `valid_to` with no error (the archive date is
  lost); rejected per D3b. A host supersedes the successor fact instead.
- **Reject future-dated `at`** — a scheduled end of validity is meaningful
  (`valid_to > now` stays live until then); correcting one later is
  rejected by `already_expired` and is a Non-goal, not a prohibition here.
- **Also clearing the embedding** — that is forget semantics; expire archives.
- **Exposing in react/expo now** — nothing forwards `supersede()` either;
  wrapper exposure is its own decision when a host asks.

## Release

MINOR (`core-llm-wiki`), no migration. INTENT rule 12 + the glossary
already name the verb and its Superseded-state afterlife; the PR updates
only INTENT's stale spec-home sentence (D5). This closes the gap between
INTENT and API without an intent cycle.

## Non-goals

- No batch expire, no entity-wide expire (hosts loop; measure later if asked).
- No `unexpire()` and no correction of an existing `valid_to` (including a
  future-dated one) — `already_expired` rejects them (D3); re-opening or
  re-scheduling validity is a supersede-shaped change and out of this
  cycle.
- No lower-bound fix for `supersede()`'s own interval gap (D1 note) — its
  own issue at implementation time.
