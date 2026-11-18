# expire() — end a fact's validity without a replacement (archive, not deletion)

**Status: Draft (2026-11-17)**  
**Design ratified by the owner 2026-11-17** ("thin `setTemporal` wrapper,
archive-without-replacement") as the T11 follow-up lane of the forget-erasure
cycle; INTENT rule 12 ("Four states and their verbs") already names the verb.
No dedicated issue: the anchor is forget-erasure `plan.md` T11 and INTENT.md
rule 12.

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
`asOf` reads honor it — but an **inverted interval is rejected**: after the
row is read, `at < (row.valid_from ?? row.created_at)` throws `TypeError`
(same convention as `supersede`'s replacement-shape validation); a fact
whose validity ended before it began would vanish from every read mode
while being archived under none. `supersede()` has the same pre-existing
gap (`TemporalService.ts:43` never checks `t` against the old row's start);
that is a separate concern and is filed as its own issue at
implementation time, not folded into this MINOR.

**D2 — semantics: one column, nothing else.** Inside a transaction, a single
`setTemporal(id, entityId, { valid_to: t }, tx)` (the outbox UPDATE is
pushed by `setTemporal` itself). `expire()` never touches `superseded_by`,
`superseded_at`, or `deleted_at`. The fact stays in the store: current reads
(`liveAtSql('current')`) exclude it once `valid_to <= now`, `asOf` reads at
`T < valid_to` still return it, and `history()` keeps it in the chain. This
is the "archive, not a deletion" wording of INTENT rule 12.

**D3 — guards (reuse `WikiSupersedeError`, thin; precedence fixed).**
`expire()` reuses `supersedeInTx`'s guard set, evaluated in this order:
`not_found` → `immutable_target` → `already_superseded` → `already_expired`
(superseded rows also carry `valid_to` — `supersedeInTx` writes it at
`TemporalService.ts:43` — so precedence decides which reason a host sees;
`already_superseded` wins, matching supersede's own guard order):

- `not_found` — fact missing or `deleted_at != null`;
- `immutable_target` — `source_type === 'immutable_document'` (same rule as
  supersede: documents are host property, never verb-mutated);
- `already_superseded` — `superseded_by != null` (end validity through the
  chain, not a second verb);
- `already_expired` — `valid_to != null` (no silent overwrite; the host
  decides). **This extends `WikiSupersedeReason`** with one member; the
  class constructor grows an optional verb (`supersede()` default, `expire()`
  from the new path) so messages stay accurate without breaking callers.

**D4 — post-commit effects (mirror `supersede`).** After the transaction
commits: `searchService.syncEntries(entityId, [factId])` (the same call
`supersede` makes — the index drops the now-non-live row) and
`evictCache(entityId)`. No embedding call: `expire()` creates no new row, and
the stored fact's embedding stays with it (retrieval already excludes
non-live facts); there is no vector removal — the fact is not forgotten.

**D5 — prune relationship: stated, and INTENT catches up.** Rows with
`valid_to` set — expired by this verb **and** superseded rows — enter the
prune path through `findExpiredIds`
(`EntryRepository.ts:1158`, "valid_to IS NOT NULL"), which
`runPrune` soft-deletes only when `pruneSupersededAfter` is set (off by
default), after their retention window (`MaintenanceService.ts:331-353`);
retention is host policy. `expire()` itself deletes nothing. The engine
already documents the expired-or-superseded pairing
(`packages/core/src/types.ts:309-311`: "expired and superseded history is
soft-deleted here"), but INTENT rule 12 names only superseded — so this
PR carries a **one-clause INTENT rule 12 amendment**
("turn superseded — or expired — into forgotten") so INTENT stays the top
authority on the new verb's afterlife (AGENTS.md rule). No prune code
changes.

**D6 — exposure: core only.** The react/expo wrappers do not forward
`supersede()` today (grep-verified); `expire()` matches. No wrapper, no
schema migration (no new columns or tables).

**D7 — docs.** apps/docs: the temporal/supersession API page gains `expire()`
alongside `supersede`/`history`, and the temporal guide names it per INTENT
rule 12's wording ("an archive, not a deletion").

## Files touched

- `packages/core/src/services/TemporalService.ts` — `expire()`.
- `packages/core/src/WikiMemory.ts` — facade method + JSDoc citing INTENT
  rule 12.
- `packages/core/src/types.ts` — `WikiSupersedeReason` gains
  `'already_expired'`; `WikiSupersedeError` gains the verb parameter.
- `INTENT.md` — rule 12, one clause: "turn superseded — or expired — into
  forgotten" (D5).
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
   (soft-deleted fact), `immutable_target`, `already_superseded`,
   `already_expired` — each leaves the row byte-identical; a superseded
   row (has both `superseded_by` and `valid_to`) reports
   `already_superseded`, never `already_expired` (precedence). [V]
3. Default `at` = now; explicit past `at` honored; non-epoch `at` throws
   `TypeError`; `at` earlier than the row's `valid_from ?? created_at`
   throws `TypeError` (inverted interval, D1). [V]
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
  exactly what `already_superseded` guards against on the supersede side.
- **Also clearing the embedding** — that is forget semantics; expire archives.
- **Exposing in react/expo now** — nothing forwards `supersede()` either;
  wrapper exposure is its own decision when a host asks.

## Release

MINOR (`core-llm-wiki`), no migration. INTENT rule 12 already names the
verb; the PR adds the one-clause afterlife amendment (D5) so INTENT stays
the top authority. This closes the gap between INTENT and API without a
second intent cycle.

## Non-goals

- No batch expire, no entity-wide expire (hosts loop; measure later if asked).
- No `unexpire()` — `valid_to` rewrites stay rejected (D3); re-open validity
  is a supersede-shaped change and out of this cycle.
