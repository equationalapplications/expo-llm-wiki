# supersede() keeps a record of an overwritten scheduled end, and reopen() restores a superseded fact

**Status:** Implemented (2026-11-23, PR #470; owner-approved 2026-11-23, all open-question defaults accepted)
**Date:** 2026-11-23
**Anchor:** issue #451 (`core-llm-wiki: supersede overwrites a future valid_to
with no record; no reopen API`), filed from SynapseTree's forget-erasure
flow (its R21).
**Intent check:** Rule 12 names four host verbs that move a fact between
states; this spec adds a fifth, `reopen()`, which moves a fact from
*superseded* back to *live* once its replacement has been forgotten. That
is an addition to the rule's text, so it needs a dated INTENT amendment
in the same PR (rule 12's verb list and the glossary's Superseded entry;
see "Open questions", Q1). It does not change any promise: it moves a
fact in the one direction privacy promises never depend on (toward
*live*, over text the host already retains), and it leaves `forget`,
`runPrune` and `erase()` untouched. Rule 2 (additive migration only:
one nullable column, no drop, no backfill). Rule 5 (an
`immutable_document` fact is never superseded, so it is never
reopened; the guard is kept defensively). Rule 6 (the replaced scheduled
end is reported through a diagnostic on both the host and the librarian
path, and `reopen()` returns what it restored). Rule 13 (the new column
is a timestamp on the entries row: erasure covers it because the row is
deleted whole, and export/import carry it like the other temporal
columns). The expire spec's D3b ruling (2026-11-17: a future-dated end
stays supersedable and is overwritten) is **kept**, not reversed — this
spec records the overwrite instead of refusing it.

## Problem

`supersede()` on a fact whose `valid_to` is in the future — set by
`expire({ at: future })`, by an OKF import carrying `valid_to`
frontmatter, or by a dump import — writes the supersede time over that
scheduled end and keeps the old value nowhere. The host cannot restore the
predecessor exactly afterwards. There is also no public verb that reopens
a superseded fact at all: `EntryRepository.setTemporal` is internal, so a
host that erases a replacement (SynapseTree does this when the replacement
was derived from material the user is forgetting) has to clear
`superseded_by` with raw SQL and guess `valid_to`. `NULL` is right in the
common case and wrong whenever a scheduled end was overwritten.

Raw SQL also skips three things the engine does on every temporal write:
the outbox `UPDATE` row (`EntryRepository.ts:1123-1126`), the search-index
resync and the read-cache eviction (`TemporalService.ts:131-132`). A host
reopen done by hand leaves the Prisma outbox and the search index behind
the row.

## Root cause (with evidence)

Line cites are against `main` at v9.14.0 (`dd6e2a4c`).

**The overwrite is deliberate and ratified; the record is missing.**
`TemporalService.supersedeInTx` (`packages/core/src/services/TemporalService.ts:26-53`)
rejects an *ended* fact at `:34` (`valid_to <= max(now, Date.now())` →
`already_expired`) and lets a *future* `valid_to` through. The write at
`:49` is `setTemporal(oldId, entityId, { valid_to: t, superseded_by:
newId, superseded_at: now }, tx)`: the old `valid_to` is replaced with
`t`. `setTemporal` (`EntryRepository.ts:1109-1129`) writes only the four
temporal columns and pushes an outbox payload carrying the **new**
values, so no copy of the prior value survives anywhere the engine owns.
`specs/expire/spec.md` D3b ruled this overwrite on 2026-11-17 ("a
future-dated end stays supersable — supersede's normal semantics
overwrite it") because refusing would strand the librarian's already
inserted replacement as a live, unlinked, contradictory fact. The
temporal guide documents it
(`apps/docs/src/content/docs/guides/temporal-facts.md:61-65`) and
`opsLibrarian.test.ts:207-222` pins it ("SUPERSEDE of a fact with a
future-dated valid_to succeeds and overwrites the end").

**No reopen path exists.** `WikiMemory` exposes `supersede`, `expire`
and `history` (`packages/core/src/WikiMemory.ts:1191-1216`) and nothing
that clears `superseded_by`. No service outside `TemporalService` and
`ImportExportService` writes `superseded_by`
(grep over `packages/core/src/services` and `repositories`), so
`forget()` of a replacement leaves the predecessor pointing at a
soft-deleted row. `history()` then returns the predecessor alone
(`findByIds` filters `deleted_at IS NULL`, `EntryRepository.ts:189`),
and current reads still exclude it because `valid_to` is set.

**Schema.** `valid_from`, `valid_to`, `superseded_by`, `superseded_at`
were added by migration v13 (`packages/core/src/db/migrations.ts:320-351`)
with the idempotent `PRAGMA table_info` guard; v16 (`:372-386`) is the
most recent single-column precedent. `CURRENT_SCHEMA_VERSION` is 17
(`:470-472`). The Rust crate pins the same number
(`crates/graphrag-core/src/schema_check.rs:20`, `REQUIRED_SCHEMA_VERSION
= 17`) and `crates/graphrag-core/tests/schema_parity.rs` fails the Rust
job when the pin drifts from the highest `version:` in `migrations.ts`
— the lockstep issue #387 introduced after v12–v16 shipped without a
bump. The crate's required-column list (`schema_check.rs:23-47`) names
only columns the crate reads; the temporal columns are not on it.

**Reproduction** (run 2026-11-23 against the unfixed tree in
`packages/core`, both cases green, i.e. the defect is present; the file
was not committed):

```ts
// insert 'old' (user_stated, created_at 100) → expire at now+7d → supersede at 5_000
await wiki.expire('e1', 'old', { at: future });
const { newId } = await wiki.supersede('e1', 'old', { title: 'SF', body: 'b' }, { validFrom: 5_000 });
const row = await db.getFirstAsync(`SELECT * FROM llm_wiki_entries WHERE id='old'`);
expect(row.valid_to).toBe(5_000);                     // scheduled end gone
expect(Object.keys(row).filter((k) => /prior|supersed/i.test(k)).sort())
  .toEqual(['superseded_at', 'superseded_by']);         // no column records it
expect(logTables).toEqual([]);                          // no log table either
expect(diagnostics.map((d) => d.code)).toEqual([]);     // nothing reported
expect(dump.entities.e1.facts.find((f) => f.id === 'old').valid_to).toBe(5_000); // dump has only the new value

// second case: forget the successor
await wiki.forget('e1', { entryId: newId });
expect(await temporal('old')).toEqual({ valid_to: 5_000, superseded_by: newId }); // dangling link
expect((await wiki.history('e1', 'old')).map((f) => f.id)).toEqual(['old']);
expect(typeof (wiki as any).reopen).toBe('undefined');
```

## Options considered

The issue offers (a) store the prior value and (b) a reopen API. Two more
were weighed: (c) refuse the supersede, and (d) report the overwrite
without storing it.

| | (a1) `prior_valid_to` column | (a2) supersede log table | (b) `reopen()` alone | (c) refuse | (d) diagnostic only |
|---|---|---|---|---|---|
| INTENT fit | Rule 6: nothing lost. Rule 12 untouched. | Same, plus a second place that outlives the fact. | Rule 12 gains a verb (amendment). Alone it cannot restore the exact value. | Reverses expire D3b (owner-ratified); strands the librarian's replacement live and unlinked — the double-live failure D3b named. | Rule 6 satisfied for the *report*; the engine still cannot restore. |
| Schema additivity (rule 2) | One nullable `INTEGER` on `entries`, v18, PRAGMA-guarded. | New table; also additive. | None. | None. | None. |
| Erasure / export / import | Row-level: erase and prune delete the row whole (`EntryRepository.ts:954`). Export/import ride the existing temporal path (`setTemporal` key list, `formatOkfBundle`, `parseOkfBundle`). A timestamp is content-free. | Needs its own erase step (rows outlive the facts they name), its own dump section, entity-wipe and `merge:false` handling, and a prune policy — the forget-erasure spec enumerates tables, so a new one widens that audit. | Nothing new to cover. | Nothing new. | Nothing new. |
| Honest reporting | Stored value + `info` diagnostic on both paths. `reopen()` returns what it restored. | Same, and the log doubles as audit. | Return value only. | A rejection reason, but the librarian path turns it into a stranded fact. | Diagnostic only; the host must keep its own ledger. |
| API surface | One optional field on `WikiFact` (present only when non-null). | New table + read API to be useful. | One method, one or two `WikiSupersedeReason` members. | None. | One diagnostic code. |
| Semver | MINOR (migration precedent: v16 → 9.1.0, v17 → 9.2.0). Rust pin 17→18 in the same PR. | MINOR, same pin bump. | MINOR. | Behavior change hosts and the librarian rely on; PATCH-shaped but reverses a ruling. | MINOR. |

(a1) is the smallest change that makes the lost value recoverable; (a2)
buys an audit log nobody asked for at the cost of a new erasure and
portability surface. (b) is needed either way, because without it the
stored value is only reachable through raw SQL that skips the outbox,
search and cache. (c) is rejected unless the owner re-rules D3b. (d) is
kept as the reporting half of the recommendation, not as a substitute.

## Proposed change — (a1) + (b) + (d)

### D1 — `prior_valid_to` column (migration v18)

`ALTER TABLE {prefix}entries ADD COLUMN prior_valid_to INTEGER`, nullable,
no default, no backfill, no index. Migration v18 follows the v16 shape
(`PRAGMA table_info` guard, runs outside any explicit transaction).
`schema.ts`'s fresh-store DDL gains the column next to `superseded_at`.
`crates/graphrag-core/src/schema_check.rs` `REQUIRED_SCHEMA_VERSION`
becomes 18 in the same commit (the parity test fails otherwise);
`REQUIRED_ENTRIES_COLUMNS` is unchanged because the crate does not read
the column.

Meaning: *the `valid_to` this row carried immediately before its current
supersession*. `NULL` means the row was open-ended when superseded, or
the supersession predates schema 18. Liveness predicates never read it.

### D2 — `supersedeInTx` records the replaced end

The write at `:49` becomes `setTemporal(oldId, entityId, { valid_to: t,
superseded_by: newId, superseded_at: now, prior_valid_to: old.valid_to },
tx)`. The key is always written (null when `old.valid_to` is null), so a
stale value can never survive a supersede; the diagnostic (D3) fires only
for a non-null end. Import coerces it to null when the row's
`superseded_by` is null (D5). `supersedeInTx` returns `{ replacedScheduledEnd: number | null }`
so both callers can report it (D3). Guard order and every existing reason
are unchanged; the overwrite semantics D3b ruled are unchanged.

`TemporalFields` and `setTemporal`'s key list gain `prior_valid_to`, so
the outbox `UPDATE` payload carries it like the other temporal columns.
`TemporalRow` / `findTemporalRow` select it.

### D3 — report the replaced end (rule 6)

New diagnostic code `supersede_scheduled_end_replaced`, severity `info`,
detail `{ factId: oldId, priorValidTo: <epoch ms> }` (a timestamp is not
content; `external_deletion_pending` already carries one). Emitted:

- by `TemporalService.supersede()` after its transaction commits
  (`operation: 'supersede'`, `trigger: 'call'`), through `emitDiagnostic`
  — `TemporalService` already holds `WikiOptions` (`TemporalService.ts:15`);
- by the librarian ops path (`apply.ts:224-234`) into `input.diagnostics`
  (`operation: 'librarian'`, flushed after commit by `ops/index.ts:100`).

`SEVERITY` and `MESSAGE` maps in `utils/diagnostics.ts`, the
`WikiDiagnosticCode` union and `WikiDiagnosticDetail.priorValidTo` are the
type-level changes. No diagnostic when `old.valid_to` was null.

### D4 — `reopen(entityId, factId): Promise<{ valid_to: number | null }>`

`WikiMemory.reopen` → `TemporalService.reopen`. One transaction, mirroring
`expire()`'s shape (`TemporalService.ts:117-133`):

1. `findTemporalRow(factId, tx)`; missing or `deleted_at != null` →
   `WikiSupersedeError('not_found', 'reopen()')`.
2. `entity_id !== entityId` → `cross_entity`.
3. `superseded_by == null` → **`not_superseded`** (new reason). An
   `expire()`-ended row is therefore rejected: `reopen()` undoes a
   supersession, not an archive (Q2).
4. `source_type === 'immutable_document'` → `immutable_target`
   (unreachable through `supersede()`, reachable through import; kept
   for rule 5).
5. Read the direct successor `superseded_by`. If it exists and
   `deleted_at == null` → **`successor_live`** (new reason): reopening
   would put two live facts in the store with no link, the failure D3b
   guards against. A forgotten (soft-deleted) or gone (absent) successor
   passes. The successor's entity is not consulted and nothing about it
   is surfaced (rule 3).
6. `setTemporal(factId, entityId, { valid_to: row.prior_valid_to,
   superseded_by: null, superseded_at: null, prior_valid_to: null }, tx)`;
   `changes === 0` → `cross_entity` (expire D2's backstop).

After commit: `searchService.syncEntries(entityId, [factId])` and
`evictCache(entityId)`, exactly as `expire()`. No embedding call (the row
kept its vector). Returns the restored `valid_to`.

Review r1 (Sonnet, 2026-11-23): a stored `prior_valid_to` that is non-integer or not after the fact's start (`valid_from ?? created_at`) — only a crafted dump can carry one — restores `NULL` instead.

Consequences, documented: a restored `prior_valid_to` that has since
passed leaves the fact *expired* (an archive) — `reopen()` restores the
host's declaration, it does not revalidate; a supersession recorded
before schema 18 restores to `NULL`, which is what hosts guess today, so
no case gets worse. `valid_from` is untouched. A reopened fact can be
superseded again; the next supersede records its then-current `valid_to`.
`history()` of the reopened fact returns it alone (the forgotten
successor is filtered as today).

### D5 — export, import, OKF

`WikiFact` gains `prior_valid_to?: number | null`, present on mapped
facts only when non-null (`mapRowToFact` pattern, `EntryRepository.ts:103-108`).
`formatOkfBundle` emits the flat epoch key beside `superseded_at`
(`formatOkfBundle.ts:103-107`); `parseOkfBundle` reads it with
`optionalEpoch` (`parseOkfBundle.ts:290-293`). `importDump`'s temporal
write (`ImportExportService.ts:505-512`) adds `prior_valid_to:
fact.prior_valid_to ?? null` — replace semantics, absent clears, same as
the four existing keys. `upsertForImport`'s SQL is untouched (the
temporal columns are written by `setTemporal`, not by that statement).
A pre-v18 dump imports with the column null, which is honest.

Review r1 (2026-11-23): an absent-key-keeps variant was tried and reverted — keeping a stored prior can stitch one supersession's scheduled end onto another's metadata. As landed, import coerces `prior_valid_to` to null when the row's `superseded_by` is null (as D2 says).

### D6 — erasure and retention

Nothing new. The column lives on the entries row: `runPrune` and
`erase()` hard-delete forgotten rows whole (`EntryRepository.ts:954`), and
a timestamp on a live or superseded row is not text. `exportDump`'s
`includeForgotten` default and the tombstone-wins import guard are
unchanged. `forget({ includeChain })` is unchanged.

### D7 — docs

- `guides/temporal-facts.md` — the Rules bullet at `:61-65` says the
  scheduled end is recorded in `prior_valid_to` and reported as
  `supersede_scheduled_end_replaced`; new section "Reopen a superseded
  fact" with the guards, the forgotten-successor requirement, and the
  two consequences above.
- `reference/wiki-memory.md` — table row for `reopen()`.
- `reference/types.md` — `prior_valid_to` on `WikiFact`.
- `reference/errors.md:36` — `WikiSupersedeError` verb list gains
  `reopen()`; reasons `not_superseded`, `successor_live`.
- `guides/diagnostics.md` — row for `supersede_scheduled_end_replaced`.
- `guides/deleting-data.md` — one sentence: after forgetting a
  replacement, `reopen()` restores the predecessor.
- `WikiMemory.ts` JSDoc for `supersede()` and the new `reopen()`.
- `INTENT.md` — rule 12 amendment (Q1).

### Release

MINOR, `feat(core)`: new column (additive migration v18), new method,
new diagnostic code, two new `WikiSupersedeReason` members (precedent:
expire added two as MINOR). No `BREAKING CHANGE` footer. The
`graphrag-core` pin bump rides the same PR as a `fix(graphrag-core)`
commit. Curated Thoughts pins an exact core version and re-pins on
upgrade; a CT build at pin 17 opened on a store already migrated to 18
fails its startup check by design, as every prior bump did.

## Rejected alternatives

- **Refuse to supersede a future-dated fact** — reverses expire D3b; the
  librarian path would strand a live, contradictory, unlinked
  replacement (`apply.ts:224-234` inserts before `supersedeInTx`).
- **Supersede log table** — a second erasure and portability surface
  for one nullable integer; see the comparison table.
- **Diagnostic only** — the host must run its own ledger; the engine
  still cannot restore the value it overwrote.
- **`reopen()` also un-expires an `expire()`-ended fact** — the expire
  spec's non-goals rule out `unexpire()`; widening needs its own ruling
  (Q2).
- **Reopen with a live successor (host's responsibility)** — recreates
  the double-live state every supersede guard exists to prevent.
- **Walk the whole forward chain before reopening** — a chain
  `A→B→C` with B forgotten and C live: whether A should return to live
  beside C is the host's call; the engine checks the direct link only
  and documents it (Q3).
- **Host-transaction overload `reopen(…, tx)`** — `upsertGraph` is the
  one precedent and it pushes the search resync onto the host after
  commit; SynapseTree's flow is two engine calls (`forget` then
  `reopen`) that already run in separate transactions. Deferred (Q4).
- **Backfill `prior_valid_to`** — nothing to backfill from.

## Files touched

- `packages/core/src/db/migrations.ts` — v18.
- `packages/core/src/db/schema.ts` — fresh-store column.
- `crates/graphrag-core/src/schema_check.rs` — pin 17 → 18.
- `packages/core/src/repositories/EntryRepository.ts` — `TemporalFields`,
  `TemporalRow`, `findTemporalRow`, `setTemporal` key list, `mapRowToFact`.
- `packages/core/src/services/TemporalService.ts` — D2, D3 emission, D4.
- `packages/core/src/services/librarian/ops/apply.ts` — D3 diagnostic.
- `packages/core/src/WikiMemory.ts` — `reopen()` facade + JSDoc.
- `packages/core/src/types.ts` — `WikiFact.prior_valid_to`,
  `WikiDiagnosticCode`, `WikiDiagnosticDetail.priorValidTo`,
  `WikiSupersedeReason` (`not_superseded`, `successor_live`).
- `packages/core/src/utils/diagnostics.ts` — `SEVERITY`, `MESSAGE`.
- `packages/core/src/utils/formatOkfBundle.ts`, `parseOkfBundle.ts`,
  `packages/core/src/services/ImportExportService.ts` — D5.
- Tests: `packages/core/__tests__/supersede.test.ts`, new
  `reopen.test.ts`, new `migration18.test.ts`, `opsLibrarian.test.ts`,
  `temporalRoundTrip.test.ts`.
- Docs listed in D7; `INTENT.md` amendment.

## Test plan

RED first: 1–4 and 6–12 must fail on the unfixed tree for the stated
reason; 5 and 13 pin existing behavior and pass before and after.

1. Migration v18: fresh store has `prior_valid_to`; a v17-shaped store
   (drop the column, stamp 17) gains it on `setup()`; re-running is
   idempotent; `CURRENT_SCHEMA_VERSION === 18`. (`migration13.test.ts`
   pattern.)
2. `supersede()` on a fact with a future `valid_to` writes
   `prior_valid_to = <old valid_to>` and `valid_to = t`; one
   `supersede_scheduled_end_replaced` diagnostic with `factId` and
   `priorValidTo`.
3. `supersede()` on an open-ended fact leaves `prior_valid_to` null and
   emits no such diagnostic.
4. Ops librarian: extend `opsLibrarian.test.ts:207` — the overwrite
   still happens, `prior_valid_to` is recorded, the diagnostic appears
   with `operation: 'librarian'`.
5. All existing `supersede.test.ts` guard cases stay green.
6. `reopen()` after `forget(successor)`: `superseded_by`,
   `superseded_at`, `prior_valid_to` all null; `valid_to` restored to
   the prior future value; return value matches; current reads include
   the fact again; `history()` returns it alone.
7. `reopen()` of a fact superseded while open-ended restores
   `valid_to = null`.
8. `reopen()` where the prior end has since passed restores it and the
   fact reads as expired (asOf before it returns the fact).
9. Guards, each leaving the row byte-identical and pushing no outbox
   row: `not_found` (missing, soft-deleted), `cross_entity`,
   `not_superseded` (never superseded; `expire()`-ended), `successor_live`,
   `immutable_target` (crafted by raw SQL).
10. Outbox: one `UPDATE` payload carrying the four restored keys plus
    `prior_valid_to: null`; supersede's payload carries `prior_valid_to`.
11. Round trip: `exportDump` → `importDump` preserves `prior_valid_to`;
    OKF `formatOkfBundle` → `parseOkfBundle` preserves it; a dump
    without the key imports null.
12. Re-supersede after reopen succeeds and records the then-current end.
13. Prune: a reopened row whose restored end has passed enters
    `findExpiredIds` and is pruned under `pruneSupersededAfter` like any
    expired row.
14. `cargo test` in `crates/graphrag-core` (parity test) green with the
    pin at 18; root `pnpm test`, typecheck and docs build green.

## Plan sketch

1. Migration v18 + `schema.ts` column + Rust pin + `migration18.test.ts`
   (test 1, 14).
2. Repository plumbing: `TemporalFields`, `TemporalRow`,
   `findTemporalRow`, `setTemporal`, `mapRowToFact`; `WikiFact` type.
3. `supersedeInTx` records the end and returns it; `supersede.test.ts`
   cases (tests 2, 3, 5, 10).
4. Diagnostic code, severity, message, detail field; emission in
   `supersede()` and `apply.ts`; ops test (test 4).
5. `TemporalService.reopen` + `WikiMemory.reopen` + two new reasons;
   `reopen.test.ts` (tests 6–9, 12, 13).
6. Export/import/OKF plumbing; `temporalRoundTrip.test.ts` (test 11).
7. Docs (D7) and `WikiMemory` JSDoc; docs build.
8. INTENT.md rule 12 amendment with dated note (after Q1 is ruled).
9. Spec status flip + plan/ledger cleanup commit; `gh pr ready`.

## Non-goals

- No `unexpire()`; `reopen()` rejects an `expire()`-ended fact (Q2).
- No change to the overwrite semantics expire D3b ruled.
- No supersede audit log; no `prior_superseded_by` or other history
  beyond the one value the issue names.
- No react/expo wrapper exposure (nothing forwards `supersede()` or
  `expire()` either); no MCP-server tool.
- No host-transaction overload in this cycle (Q4).
- No backfill of `prior_valid_to` for pre-v18 supersessions.

## Open questions for Kurt

- **Q1 [ANSWERED: default accepted 2026-11-23] — INTENT rule 12 amendment.** Rule 12 says "Four host verbs".
  Default: amend to five in this PR, adding `reopen()` ("returns a
  superseded fact to live once its replacement is forgotten or gone")
  and extending the glossary's Superseded entry; dated amendment note.
  *Reason:* the rule enumerates the verbs, so a new verb is a text
  change that INTENT's own step 7 says must go through an amendment.
- **Q2 [ANSWERED: default accepted 2026-11-23] — reopen scope.** Default: superseded facts only;
  `expire()`-ended facts reject with `not_superseded`. *Reason:* the
  expire spec's non-goals ruled out `unexpire()`, and widening it is a
  separate decision.
- **Q3 [ANSWERED: default accepted 2026-11-23] — successor guard.** Default: the direct successor must be
  forgotten or gone; a live one rejects `successor_live`; the forward
  chain beyond it is not walked. *Reason:* prevents the double-live
  state without the engine guessing the host's intent for longer chains.
- **Q4 [ANSWERED: default accepted 2026-11-23] — host-transaction overload.** Default: none now; `reopen()`
  opens its own transaction like `expire()`. *Reason:* the one precedent
  (`upsertGraph`) hands the post-commit resync to the host, and the
  filing host's flow is already two separate engine calls.
- **Q5 [ANSWERED: default accepted 2026-11-23] — diagnostic on overwrite.** Default: emit
  `supersede_scheduled_end_replaced` at `info` on both paths. *Reason:*
  on the librarian path a diagnostic is the only way a host learns a
  scheduled end it declared was changed (rule 6).
- **Q6 [ANSWERED: default accepted 2026-11-23] — name.** Default: `reopen()`. *Reason:* the issue's own word,
  and it reads as a state verb beside `supersede`/`expire`/`forget`;
  `unsupersede()` is the alternative.

## Schema coordination (owner ruling 2026-11-23)

Three pending changes share ONE schema version, v18: PR #468 (#443,
partial index; merges first and creates v18), this PR (#470), and PR #469
(#450). Until #468 merges, this branch implements its column as v18 with
the DDL in its own named, exported, idempotent helper
(`addPriorValidToColumn`) that the v18 migration body calls, so that
rebasing onto #468 reduces to adding one helper call to its v18 body. The
Rust `REQUIRED_SCHEMA_VERSION` 17 to 18 bump is the same edit #468 makes;
the rebase dedupes it.
