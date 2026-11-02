# Plan: forget-pre-v9 (#316)

Spec: `specs/forget-pre-v9/spec.md` (Reviewed). TDD: Tasks 1–2 land failing tests before Tasks 3–4 touch `src/`.
All commands run from the repo root unless noted. Core tests: `pnpm --dir packages/core exec vitest run <file>`.

## Task 1: genuine v8 fixture helper (spec §5)

Create `packages/core/__tests__/helpers/v8Schema.ts`:

- `V8_SCHEMA_DDL(prefix)`: the **verbatim** `setupDatabase` DDL string from `git show 8ebee301:packages/core/src/db/schema.ts` (entries through `heal_checked_at`; tasks through `okf_type`; edges with `edges_entity_idx`; events without `occurred_at`; checkpoints with only `heal_checkpoint`/`memory_checkpoint`; entity_manifests; meta; outbox plus its two indexes). No `source_ref_index`, no `entries_fts`.
- `openV8Database(prefix = 'llm_wiki_')`: `openTestDatabase()`, exec the DDL, `INSERT INTO meta (key,value) VALUES ('schema_version','8')`, return the adapter.
- `insertV8Entry(db, { id, entityId, sourceRef, sourceHash, updatedAt })`: inserts only v8 columns, with `source_type = 'immutable_document'` and `confidence = 'certain'` (current values, so `assertNoLegacySourceTypes` passes).
- `sourceRefIndexExists(db)`, `schemaVersion(db)`: small readers.

Self-check: the top of `forgetPreV9.test.ts` (Task 2) has a test asserting that `PRAGMA table_info(llm_wiki_entries)` on `openV8Database()` lacks `lifecycle_status` and `valid_to`, that `source_ref_index` is absent, and that `schema_version === '8'`. A v8 DB **without** duplicates, run through `setup()`, reaches `String(CURRENT_SCHEMA_VERSION)`.

Verify: `pnpm --dir packages/core exec vitest run __tests__/forgetPreV9.test.ts -t "fixture"` passes.

## Task 2: failing tests (spec §5 tests 1–5)

`packages/core/__tests__/forgetPreV9.test.ts`. Options: `{ llmProvider: { generateText: async () => '{}' }, config: { enableOutbox: true } }`. Fixture `dupFixture()` = v8 DB plus a live duplicate group: entity `ent`, hash `'d'.repeat(64)`, `a.md` (updatedAt 1000, 2 rows: `a1`, `a2`) and `b.md` (1100, 1 row: `b1`).

Export `LIST_DUP_GROUPS_SQL(prefix)` from the helper. Use the exact query the docs will print:

```sql
SELECT entity_id, source_hash, GROUP_CONCAT(DISTINCT source_ref) AS source_refs
FROM llm_wiki_entries
WHERE deleted_at IS NULL AND source_hash IS NOT NULL
GROUP BY entity_id, source_hash
HAVING COUNT(DISTINCT source_ref) > 1;
```

Tests:
1. **case B**: new `WikiMemory`, no setup; `forget('ent', { sourceRef: 'b.md' })` → `{ deleted: { entries: 1, tasks: 0 } }`; `b1.deleted_at` not null; `a1`, `a2` live; `sourceRefIndexExists` false; one outbox row `operation='DELETE', record_id='b1'`.
2. **case C**: `setup({ migrations: 'refuse' })` rejects `WikiMigrationRequiredError`; then the same as test 1.
3. **case A loop**: `setup()` rejects; the message matches the existing prefix regex (`migration9.test.ts` L225-227), plus `/\(entity_id=ent, source_hash=d{12}…, n_refs=2\)/`, plus contains `forget(entityId, { sourceRef: <loser> })` and `then re-run setup().`. Run `LIST_DUP_GROUPS_SQL`; for each row, keep the first ref in sorted order and `forget` the rest. Then `setup()` resolves; `schemaVersion === String(CURRENT_SCHEMA_VERSION)`; live `source_ref_index` rows = exactly `[{ entity_id: 'ent', source_hash: d…, source_ref: 'a.md' }]`.
4. **fresh-instance loop, two groups**: add group 2 (entity `ent2`, hash `'e'.repeat(64)`, `x.md`/`y.md`). Instance 1: `setup()` rejects and reports `Found 2 duplicate`. Then **drop** `source_ref_index` again (simulating a recovery tool run before any `'allow'` open — see spec §2.2). Instance 2 (no setup): forget the losers from the listing query. Instance 3: `setup()` resolves; version CURRENT; two live index rows (`a.md`, `x.md`). Listing query returns `[]`.
5. **post-v9 unchanged**: (5a) fresh v15 DB via `setup()`, ingest-free direct insert of an entry plus an index row (or `ingestDocument` if simpler), `forget({ sourceRef })` → index row `deleted_at` set. (5b) v15 DB, `DROP TABLE source_ref_index`, then `forget({ sourceRef })` rejects; walk `err` and `err.cause` for `/source_ref_index is missing on a schema_version=15 database; run setup\(\)/`; the entry is still live.

Verify (expected RED): tests 1, 2, 3, 4 and 5b fail; the fixture test and 5a pass. Record the failure lines in the ledger.

## Task 3: guard in `MaintenanceService.forget()` (spec §3.1)

In `packages/core/src/services/MaintenanceService.ts`, by-source branch, before `sourceRefIndexPromise`:

```ts
const touchSourceRefIndex = sourceRef ? await this.sourceRefIndexPresent(tx) : false;
const sourceRefIndexPromise = touchSourceRefIndex
  ? this.sourceRefIndexRepo.softDeleteByEntityAndSourceRef(entityId, sourceRef!, tx).then(() => undefined)
  : null;
```

Private helper (with a doc comment citing spec §3.1 and the concurrency note):

```ts
/** False only on a pre-v9 database without source_ref_index; throws if a v9+ database lost it. */
private async sourceRefIndexPresent(tx: SQLiteAdapter): Promise<boolean> {
  if (await this.metadataRepo.tableExists(`${this.prefix}source_ref_index`, tx)) return true;
  const raw = await this.metadataRepo.getMeta('schema_version', tx);
  const v = raw ? parseInt(raw, 10) : 0;
  const version = Number.isFinite(v) ? v : 0;
  if (version < 9) return false;
  throw new Error(`forget(): source_ref_index is missing on a schema_version=${version} database; run setup()`);
}
```

The check must run **before** `refPromise` and `entryPromise` start, so the throw precedes every mutation. Move the existing promise construction below the helper call. Also confirm `getMeta` accepts `tx` (`MetadataRepository.ts` ~L109).

Verify: tests 1, 2, 4 and 5b now pass. Test 3 still fails on the message only.

## Task 4: v9 error message (spec §3.2)

`packages/core/src/db/migrations.ts` L189: replace only the last string fragment with
`` `Resolve each group by calling forget(entityId, { sourceRef: <loser> }) for every losing sourceRef (works on pre-v9 databases), then re-run setup().` ``

Verify: `forgetPreV9.test.ts` fully green; `migration9.test.ts` green and unmodified. Grep for the old sentence (`rg "forget\(\{ sourceRef: <loser>" -g '!CHANGELOG.md'`) and update any doc or test that quotes it (not CHANGELOG).

## Task 5: docs (spec §3.3)

`apps/docs/src/content/docs/reference/errors.md`, section "Migration v9 fails on existing duplicates":
- Replace "Nothing is deleted, the table isn't created, …" with the accurate version (under the default `'allow'` policy the table is created empty, the backfill doesn't run, nothing is deleted, and the version doesn't advance).
- Steps: (1) list groups with the listing SQL; (2) pick a keeper per group, then `await wiki.forget(entityId, { sourceRef: loser })` for each loser; (3) `await wiki.setup()`.
- One version line: before the #316 fix release, `forget()` works only after some `setup()` under `'allow'` has opened the database; from the fix on, no such step is needed.
- Fallback for callers without a `WikiMemory`: keep the existing SQL `DELETE` recipe, noting that it hard-deletes and emits no outbox events, while `forget()` soft-deletes and records CDC events.

Verify: `pnpm --dir apps/docs build` green.

## Task 6: full verification

`pnpm install` (no lockfile change expected; `git status` must show none), `pnpm test`, `pnpm --dir packages/core exec tsc --noEmit` (or the repo's typecheck script), `pnpm --dir apps/docs build`. Then `git diff origin/main --stat` must show no `CHANGELOG.md` and no `"version"` change.

## Task 7: commits, PR, review, cleanup

Commits (conventional, naming the spec section): `test(core): …(spec §5)`, `fix(core): forget() tolerates missing source_ref_index pre-v9 (spec §3.1)`, `fix(core): v9 error advises a working recovery (spec §3.2)`, `docs: v9 recovery via forget() (spec §3.3)`. No line starts with `BREAKING CHANGE`. Push; open a **draft** PR with "Fixes #316". After the Sonnet review converges: the cleanup commit flips spec Status to Implemented and deletes `plan.md` and `LEDGER.md`; then `gh pr ready`.
