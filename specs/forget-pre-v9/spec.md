# `forget()` on a database stuck before migration v9 (#316)

**Status:** Implemented (2026-11-01, PR #317)
**Date:** 2026-11-01
**Branch:** `fix/forget-pre-v9`
**Source baseline:** `30922ae1` (main after PR #314)
**Issue:** #316
**Intent check:** INTENT §2 ("Your database stays yours"): its Status footnote promises that "Migration v9 refuses to run, with instructions, if it finds data that an older race condition could have left inconsistent, rather than guessing which rows to keep." This spec keeps the refusal exactly as it is (no auto-resolve, no new destructive step) and makes the *instructions* true. Nothing here adds a migration, drops a table, or changes post-v9 behaviour. No INTENT amendment is needed.

**Delivery:** one PR, draft until implemented, per `specs/README.md`. Commit type `fix(core):`, so semantic-release cuts a 7.x patch. Nobody edits `CHANGELOG.md` or any `"version"` field.

---

## 1. Problem

Migration v9 (`add_source_ref_index`, `packages/core/src/db/migrations.ts` L152-236) aborts when live `entries` rows hold one `(entity_id, source_hash)` under more than one distinct `source_ref`. The error tells the operator to:

> Resolve each by calling forget({ sourceRef: <loser> }) for the offending sourceRef, then re-run setup.

Issue #316 reports that this advice cannot work, because `forget()` queries `source_ref_index`, a table v9 never got to create.

## 2. Root cause (verified against source and by experiment)

The issue is **partly right**. The facts below correct its premise, and the fix depends on them.

### 2.1 What `forget()` touches in `source_ref_index`

`WikiMemory.forget()` (`WikiMemory.ts` L854-860) delegates to `MaintenanceService.forget()` (`services/MaintenanceService.ts` L500-626). That method has no dedupe lookup and no `canonical`, and it never calls `findActiveByEntityAndHash`. Its only `source_ref_index` access is in the `sourceRef` branch (L568-570):

```ts
const sourceRefIndexPromise = sourceRef
  ? this.sourceRefIndexRepo.softDeleteByEntityAndSourceRef(entityId, sourceRef, tx)…
```

That runs `UPDATE …source_ref_index SET deleted_at = … WHERE entity_id = ? AND source_ref = ? AND deleted_at IS NULL` (`repositories/SourceRefIndexRepository.ts` L52-66). When the table is missing, the UPDATE throws, the whole transaction rolls back, and the caller sees `Transaction failed`. The `clearAll`, `entryId`, `taskId`, `sourceHash`-only and `dryRun` paths never touch `source_ref_index`.

(`findActiveByEntityAndHash` *is* called from `WikiMemory.hasChangedBatch` L480, `findSourceRefsByHash` L593 and the `upsertGraph` probe L987. Those are ingest and audit paths, not part of the recovery loop, and stay out of scope. See §6.)

### 2.2 When the table is actually missing

`setup()` runs `setupDatabaseWithGate` → `setupDatabase` (`db/schema.ts` L3; the `source_ref_index` DDL is L53-63), and its every-open DDL includes `CREATE TABLE IF NOT EXISTS …source_ref_index` plus its partial UNIQUE index. **That runs before the migrations loop.** So whenever `setup()` gets as far as the v9 abort, `source_ref_index` exists (empty), and the existing test `migration9.test.ts` "abort path" already asserts this (L228-235: "Table and index exist … recreated by setupDatabase's IF NOT EXISTS").

Experiment (scratch repro, three cases, baseline `30922ae1`; fixture = fresh v15 DB, two live rows `a.md`/`b.md` sharing a hash, `source_ref_index` dropped, `schema_version` set to `8`):

| Case | Sequence | Result today |
|---|---|---|
| A | `setup()` throws v9 → `forget('ent', { sourceRef: 'b.md' })` on the same instance → `setup()` | **Works.** Table exists after the failed setup; forget deletes 1 entry; re-setup reaches v15; `source_ref_index` backfilled with `a.md`. |
| B | new `WikiMemory` on that DB, **no** `setup()` → `forget(…sourceRef…)` | **Fails**: `Transaction failed` (no such table). |
| C | `setup({ migrations: 'refuse' })` throws `WikiMigrationRequiredError` *before* the DDL → `forget(…sourceRef…)` | **Fails**: `Transaction failed`. `'auto'` behaves the same way, because a pending schema migration also throws before the DDL. |

So the loop the error message describes (case A) works on released versions. The table persists in the database file, so it is not tied to one instance: once **any** `setup()` under the default `'allow'` policy has opened the database with a v9+ release, a later fresh instance can `forget()` too. Case B fails in the repro only because the fixture dropped the table. What breaks is calling `forget()` on a pre-v9 database that no `'allow'` open has touched since the upgrade: a recovery run from a separate tool before any app open, or a host that opens only under `'refuse'`/`'auto'`. The error message is also wrong on its own terms: it shows `forget({ sourceRef })` with no `entityId`, which is not a valid call.

The docs page (`apps/docs/src/content/docs/reference/errors.md` L56-73, from PR #314) inherits the issue's premise. It says "the table isn't created" and "`wiki.forget()` does not work here". Both are wrong for case A.

## 3. Proposed change

### 3.1 `forget()` tolerates a missing `source_ref_index` on a pre-v9 database

In `MaintenanceService.forget()`'s by-source branch, run the `source_ref_index` soft-delete only when the table can exist. Inside the same transaction, before building the promises:

- If `sourceRef` is null, nothing changes (no index access today).
- Otherwise, check `metadataRepo.tableExists(`${prefix}source_ref_index`, tx)`.
  - **Table exists** → soft-delete exactly as today.
  - **Table missing and stored `schema_version` < 9** (read in the same tx with `metadataRepo.getMeta('schema_version', tx)` and parsed inline with `parseInt`; a missing or unparseable value counts as `0`, matching `detectSchemaVersion`. Do not call `detectSchemaVersion` itself: it takes no `tx` and reads through `this.db`) → skip the soft-delete. That is correct, not just tolerated: v9's backfill rebuilds the index from live `entries` only, so there is no index row to retire, and the rows `forget()` just soft-deleted are excluded from that backfill.
  - **Table missing and `schema_version` ≥ 9** → do not skip. Throw `Error(`forget(): source_ref_index is missing on a schema_version=${v} database; run setup()`)` from the pre-check, before any mutation, so the transaction rolls back. A post-v9 database without its index is corrupt, and silently skipping would weaken the TOCTOU guard. Post-v9 still fails, as today, but with an actionable message instead of an opaque `Transaction failed`. Healthy post-v9 databases (table present) behave exactly as before.

Detection is an explicit pre-check, not a `catch` on "no such table". The adapters differ (better-sqlite3 versus expo-sqlite) in whether a failed statement poisons the open transaction, and matching error-message strings is brittle. The check costs one indexed `sqlite_master` lookup per `forget({ sourceRef })` call. The schema-version read happens only when the table is missing.

Concurrency: the `sqlite_master` probe, the version read and the `entries` UPDATE all run on `tx`. SQLite serializes writers, and in WAL mode a stale read snapshot fails the write-lock upgrade (`SQLITE_BUSY_SNAPSHOT`). So a v9 committed on another connection between the probe and the write can only fail `forget()`'s transaction, never make it skip once the index exists. v9 itself runs in autocommit (`WikiMemory.ts` L388-392); its own non-atomicity against a concurrent `forget()` predates this change and is out of scope.

Nothing else in `forget()` changes: the lock, the outbox `DELETE` events, the search-index sync, the embedding hooks, the return shape and `dryRun`.

### 3.2 The v9 error message gives advice that works

In `migrations.ts` v9, replace only the last sentence:

- Old: ``Resolve each by calling forget({ sourceRef: <loser> }) for the offending sourceRef, then re-run setup.``
- New: ``Resolve each group by calling forget(entityId, { sourceRef: <loser> }) for every losing sourceRef (works on pre-v9 databases), then re-run setup().``

The leading prefix (asserted by `migration9.test.ts` L225-227), the group count, and the per-group listing `(entity_id=…, source_hash=<12 chars>…, n_refs=…)` stay byte-for-byte unchanged. So do the abort itself and its position before `CREATE TABLE`.

### 3.3 Docs recovery section

Rewrite the recovery part of `reference/errors.md` § "Migration v9 fails on existing duplicates":

- Correct the "the table isn't created" sentence. Under the default `'allow'` policy, `setup()` creates `source_ref_index` empty, and v9 aborts before the backfill. Nothing is deleted and the schema version doesn't advance.
- Give a read-only SQL query that lists each group's sourceRefs (`GROUP_CONCAT(DISTINCT source_ref)` over the same predicate as v9's check), because the error message names hashes, not refs.
- Lead with `await wiki.forget(entityId, { sourceRef: loser })` for each loser, then `await wiki.setup()`.
- Add one line on versions: before the release that fixes #316, `forget()` works only once some `setup()` under the default `'allow'` policy has opened the database (that attempt creates the table). From the fix on, it works without that step. (The prompt for this work asked for "requires the version with this fix". §2.2 shows that would be untrue for the common path, so the line says what is actually true.)
- Keep the direct-SQL `DELETE` recipe as the fallback for callers without a `WikiMemory` instance. Note that it hard-deletes and emits no outbox events, whereas `forget()` soft-deletes and records CDC events.

## 4. Files touched

| File | Change |
|---|---|
| `packages/core/src/services/MaintenanceService.ts` | §3.1 guard in the by-source branch of `forget()` |
| `packages/core/src/db/migrations.ts` | §3.2 last sentence of the v9 error |
| `packages/core/__tests__/forgetPreV9.test.ts` (new) | §5 tests |
| `apps/docs/src/content/docs/reference/errors.md` | §3.3 |
| `specs/forget-pre-v9/spec.md` | this file; Status flips in the cleanup commit |

`MaintenanceService` already holds `metadataRepo` and `prefix`. If it doesn't, the plan wires them through the existing constructor deps. No public API, type, or export changes.

## 5. Test plan (tests first; each must fail on baseline where stated)

All fixtures use a **genuine v8 schema**: tables and columns as of v8, with no v10-v13 columns, no `source_ref_index`, and `schema_version = '8'`. Build it directly in a test helper from the v8-era DDL (`git show 8ebee301:packages/core/src/db/schema.ts`: `entries` ends at `heal_checked_at`, `tasks` at `okf_type`; includes `meta` and `outbox`; no `entries_fts`, no `source_ref_index`), not by dropping a table from a v15 database, so the path through `forget()` and `setup()` meets the real legacy column set. Fixture rows use current `source_type` values (otherwise `assertNoLegacySourceTypes`, `WikiMemory.ts` L401, fails the follow-up `setup()`). Instances whose outbox is asserted are built with `config.enableOutbox: true`, since the outbox is off by default (`WikiMemory.ts` L143). The helper is checked by asserting that `PRAGMA table_info(entries)` lacks `lifecycle_status`/`valid_to` and that a following `setup()` reaches `CURRENT_SCHEMA_VERSION`.

1. **(a) Pre-v9 forget, no setup (case B)**: v8 DB with duplicates `a.md`/`b.md`. A new `WikiMemory`, without `setup()`, calls `forget('ent', { sourceRef: 'b.md' })`. It resolves `{ deleted: { entries: N_b, tasks: 0 } }`, `b.md`'s rows have `deleted_at` set, `a.md`'s stay live, `source_ref_index` still doesn't exist, and an outbox `DELETE` row exists per deleted entry. *Fails on baseline.*
2. **(a′) Pre-v9 forget after a refused open (case C)**: `setup({ migrations: 'refuse' })` rejects with `WikiMigrationRequiredError`, then the same assertions as test 1. *Fails on baseline.*
3. **(b) Documented recovery loop, same instance (case A)**: `setup()` rejects with the v9 prefix, and the message contains `forget(entityId, { sourceRef: <loser> })` and `then re-run setup()`. Then `forget()` for each loser, then `setup()` resolves, `schema_version === String(CURRENT_SCHEMA_VERSION)`, and `source_ref_index` holds exactly one live row per group whose `source_ref` is the kept ref. The test finds each group's refs with the docs' listing query (§3.3) and runs that query's output through `forget()`, so the documented recipe is the one under test. *Message assertion fails on baseline.*
4. **(b′) Recovery loop from a fresh instance**: same as test 3, but the forgets run on a new `WikiMemory` that never called `setup()`, and then a third instance runs `setup()`. Two groups (two entities, or two hashes) prove that "for each group" iterates. *Fails on baseline.*
5. **Post-v9 behaviour unchanged**: on a v15 DB, `forget({ sourceRef })` soft-deletes the index row (`deleted_at` set) exactly as before. On a v15 DB with `source_ref_index` dropped and `schema_version = CURRENT`, `forget({ sourceRef })` rejects with the §3.1 `source_ref_index is missing` message and nothing is deleted (rows still live), proving the guard does not skip post-v9.
6. **Abort unchanged**: the existing `migration9.test.ts` abort test passes unmodified (prefix, empty table, version stays `8`, no rows deleted). Test 3 also asserts that the group listing in the message still matches `/\(entity_id=ent, source_hash=d{12}…, n_refs=2\)/`.
7. Full `pnpm test` green; `pnpm --dir apps/docs build` green.

## 6. Out of scope

- `hasChangedBatch`, `findSourceRefsByHash` and `upsertGraph` on a pre-v9 open: these are ingest and audit paths, not part of the recovery loop. They still require a completed `setup()`, as every other write path does.
- The `clearAll` TODO about bulk `source_ref_index` soft-delete (`MaintenanceService.ts` L532-535): unrelated.
- Any automatic resolution of duplicates: forbidden by INTENT §2's footnote.

## 7. Review log

**2026-11-01, Fable 5.1 (high), spec review.** It independently verified every source claim in §2 and re-ran cases A/B/C with the same results. Its findings and their outcomes:

| # | Finding | Outcome |
|---|---|---|
| 1 Major | The message lists hashes, not refs, so the operator still needs SQL to find losers | **Partly accepted.** The owner's brief freezes the listing (entity_id, truncated hash, n_refs), so it stays unchanged. Instead, §3.3 adds a read-only listing query to the docs, and test 3 drives the loop through that query. |
| 2 Major | Outbox is off by default, so test 1's outbox assertion would fail | Accepted (§5: `enableOutbox: true`). |
| 3 Minor | `detectSchemaVersion` has no `tx` parameter | Accepted (§3.1: `getMeta(…, tx)` plus an inline parse). |
| 4 Minor | No rationale for the concurrency behaviour | Accepted (§3.1 paragraph). |
| 5 Minor | Post-v9 missing table surfaces as an opaque `Transaction failed` | Accepted (§3.1 explicit error; test 5 asserts it). |
| 6 Minor | "Same instance" is the wrong unit: the table persists per database file | Accepted (§2.2, §3.3 rewording). |
| 7 Nit | Fixture source and the `source_type` trap | Accepted (§5). |
| 8 Nit | `setupDatabase` line cite; `normalizeSourceRef` `trimEnd` drift | Cite fixed. The drift is negligible (only 255-char refs ending in a space), so no change. |

**2026-11-01, Sonnet 5.5 (high), whole-PR review.** No Critical or Major findings. Accepted and fixed:
- the docs outbox claim is now conditional on `enableOutbox`;
- the docs now tell the operator to check `deleted.entries`, because `forget()` normalizes its `sourceRef` and an unnormalized legacy row won't match (old behaviour), and point those rows at the SQL fallback;
- the v9 abort comment in `migrations.ts` no longer contradicts §2.2;
- boundary tests now cover `schema_version` 9 with the table missing (refuses) and a missing or unparseable version (skips). A mutation check (`< 9` → `<= 9`) fails the new test.

The rest were accepted as is: the type-narrowing `&& sourceRef`, the version number missing from the docs line (filled at release time if wanted), and the RED test commit in history (intentional TDD).

**2026-11-01, post-ready review round (Sonnet 5.5 high, second pass; CodeRabbit).** Revision to §3.2/§3.3, appended rather than rewritten:
- **CodeRabbit (Major), accepted.** `forget(entityId, { sourceRef })` soft-deletes that ref across every hash, so a ref that loses one group but keeps another would lose its kept rows. Sonnet raised the same point as a Minor. The v9 message, the docs recipe and the SQL fallback now scope each delete to the group with `sourceHash` (the full hash comes from the listing query). The §3.2 wording departs from the owner's brief, which named only `sourceRef`, for data-integrity reasons. A new test puts one ref in two groups and fails without the scoping.
- **Sonnet, accepted:**
  - custom `tablePrefix` tests, pre-v9 and post-v9;
  - a test that `errors.md` contains the exact listing query under test;
  - docs cautions: legacy refs that aren't normalized can match nothing or a different ref; `GROUP_CONCAT` comma ambiguity;
  - the helper comment now scopes its concurrency claim to *other* connections and notes that a `meta`-less store is unsupported.
- **Not changed:** "run setup()" advice under `'refuse'` (correct for the common case); version number in the docs line; historical line cites above.
