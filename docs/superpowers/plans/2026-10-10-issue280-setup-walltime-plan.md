# Issue #280 `setup()` Wall Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** rev 7 (2026-10-13) — PR-A tasks A0–A7 DONE and ticked; Task A8 rewritten so it can run without the original sandbox machine (see "Resume here" and Task A8). rev 6 — written fresh against **spec rev 11** (`cfb56fe`). Rev 5 mirrored spec rev 7 and is RETIRED in full; nothing below inherits from it. Two tracks: **PR-A** (fully expanded, execute now) and **PR-B** (task-level, re-expanded as plan rev 7 in Task B0 against post-PR-A `main`, because PR-A moves the code PR-B edits).

**Goal:** Make every `wiki.setup()` open of an up-to-date store O(state-change) instead of O(database), give hosts a lever to keep one-time migration work out of the writer lease, and make FTS init failures recoverable instead of index-destroying.

**Architecture:**
- PR-A replaces the two every-open survival scans:
  - a partial covering index serves the legacy `source_type` probe;
  - a stamp-checked, two-pass, rowid-watermarked `source_ref` normalize runs once, outside the migrations loop.
- PR-A adds a read-only migration gate (`setup({ migrations: 'refuse' })` → `WikiMigrationRequiredError`). It runs before any DDL.
- PR-A's RC-6 guard: `probeFts5` classifies its errors, `init()` gets one 250 ms retry, and failures install `UnavailableIndexStrategy`, never `detachFts5`. Each of the six keyword-search call sites is pinned to its spec behavior.
- PR-B replaces the single-transaction FTS rebuild with the `rebuilding` state machine: windowed chunks, fingerprints, orphan sweep, rename-retire, and budgeted drains.

**Tech Stack:** TypeScript 5.9 strict (`target` ES2020, `lib` includes `ES2022.Error`), vitest, pnpm workspace, better-sqlite3 13.0.3 (FTS5 + json1), sql.js 1.14.2 (no FTS5 — the module-absent fixture), Node ≥ 24.

**Spec:** `docs/superpowers/specs/2026-10-10-issue280-setup-walltime-design.md` (rev 11). Read its **Normative summary** first; the per-Change sections carry rationale. Investigation: `docs/superpowers/investigations/2026-10-10-issue280-setup-walltime-investigation.md`. **If this plan and the spec disagree, the spec wins: stop and report.**

## Global Constraints

- **Branches:**
  - PR-A lands on `spec/issue280-setup-walltime` (PR #281, draft until Task A8).
  - PR-B goes on a NEW branch `feat/issue280-fts-state-machine`, cut from `main` after PR-A merges.
  - No worktrees.
- **Issue linkage:** PR-A body says `Refs #280` (never `Fixes`/`Closes` — that would auto-close the issue on PR-A's merge). PR-B body says `Fixes #280`.
- **Commands** (repo root):
  - one file: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/<file>.test.ts`
  - suite: `pnpm --filter @equationalapplications/core-llm-wiki test`
  - types: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`
  - build: `pnpm -r build`
- **Local suite caveat:** the full core suite on this machine can report vitest `Worker exited unexpectedly` with zero assertion failures. The gate is "no assertion failures; completed counts ≥ baseline + new tests" (baseline recorded in Task A0). **CI is authoritative.** For a red phase with many failures, re-run that file with `--pool=threads`.
- **Commit types:** `feat(core)`, `fix(core)`, `perf(core)`, `test(core)`, `docs(spec)`, `docs(plan)`. **Never start a commit-body line with `BREAKING CHANGE`** (semantic-release parses it as a footer and cuts a major). Nothing here is breaking: `setup(opts)`, both error classes and `setupBudgetMs` are additive. The `'auto'` changes fix a measured crash path.
- **Proxy-safe error checks:** never call `err instanceof X` or `err.message` bare inside a catch. A hostile Proxy's `getPrototypeOf`/`get` trap can throw (issue #96 audit). Use the `try { … } catch { return false; }` helpers this plan defines.
- **Spec edits** are appended as revisions; existing revision text is never rewritten. **This plan file is gitignored:** commit it with `git add -f`.
- **Merging is the maintainer's call;** merge commits only, never squash.
- **Every-open path rule:**
  - Never add a full-table scan, an unbounded loop, or a non-`IF NOT EXISTS` DDL to the every-open path.
  - New indexes are created ONLY by migrations and the fresh-store path, never by `setupDatabase`.
- **Measured constants you may rely on** (investigation §2):
  - partial-index probe 0.4 ms;
  - glob scan 1.13 s and legacy scan 0.60 s @1M;
  - rebuild/drain chunk throughput 7.6–8.1k rows/s, max chunk 733–1010 ms @1M;
  - DROP+CREATE @1M 22.3 s.
  - **The normalize rate is UNMEASURED** — Task A8 measures it.

---

## Resume here (rev 7 handoff, 2026-10-13)

**Read this block first. Everything you need to continue PR-A is here; do not re-run A0–A7.**

- **Branch:** `spec/issue280-setup-walltime`, head `584ba94` (pushed). **PR #281** is a DRAFT, body says `Refs #280` (no `Fixes`), CI green at `584ba94`.
- **Baseline now:** core suite 176 files / **1891 tests**, 0 failures; `pnpm typecheck` exit 0; `pnpm -r build` clean. This supersedes the A0 baseline line.
- **Done (A0–A7)** — where each landed:
  | Task | Commits |
  |---|---|
  | A1 idempotent `normalizeSourceRef`, A2 v14 partial index | `fcbf8ca`, `d761d9d` (fresh-store finalize atomic) |
  | A3 stamped normalize, A4 gate (`'allow' \| 'refuse' \| 'auto'`) | `0f00747`…`920f71d`, `830e39e`, `fcbf8ca` |
  | Review fixes (policy `TypeError`, VACUUM resets normalize watermarks in `MaintenanceService.runPrune`, shared `detectSchemaVersion`, fingerprinted probe watermarks, `upsertGraphCore` normalizes) | `33c9cf7` (spec rev 11b `4a6688b`) |
  | A5 RC-6 guard | `ddff88e` |
  | A6 six call sites | `8b9d081` |
  | A7 docs | `69d2a00` (spec rev 11c `584ba94`) |
- **Deviations already applied — do NOT "fix" them back to the plan text:**
  1. The gate API shipped as `migrations: 'allow' | 'refuse' | 'auto'` and `PendingMigrationWork` = `schema_migration` / `source_ref_normalize` (spec rev 11a "Shipped gate contract"). Plan code in A4 that says `'run'`, `normalizeRequired` or `retiredTables` is historical.
  2. A4's `readSchemaVersion` lives as `detectSchemaVersion` in `src/db/sourceRefNormalize.ts`; `probePendingWork(db, meta, prefix)` takes `db` first.
  3. The VACUUM watermark reset is in `MaintenanceService.runPrune` (via `resetNormalizeWatermarks`), not in `MetadataRepository.vacuum()` (that would be an import cycle).
  4. Plan test fixes: A5's "every sync entry point stays off the full-read path" test warms the store first (`warm` helper option); A6's (o) heal test sets `orphanAfterDays: null` / `staleInferredAfterDays: null`; `getLibrarianWatermark` takes a tx argument.
- **Remaining for PR-A (rev 7a, maintainer decision 2026-10-13):** measurements are NOT a merge gate. The changes are required for structural reasons; tuning and metrics come later. The merge gate is correctness only: a review of the full PR diff against the spec's PR-A contract, fixes for any real bugs, CI green, then `gh pr ready 281` and merge (merge commit). Task A8 below is DEFERRED to a follow-up (it can run on `main` after PR-A merges); do not run it as part of PR-A.
- **Not in scope:** anything under Track PR-B.

---

# Track PR-A — warm open, migration gate, RC-6 guard (`Refs #280`)

## PR-A file map

| File | Responsibility | Tasks |
|---|---|---|
| `packages/core/src/utils/pure.ts` | `normalizeSourceRef` becomes idempotent | A1 |
| `packages/core/src/db/schema.ts` | export `legacySourceTypeIndexDdl(prefix)` (NOT added to `setupDatabase`) | A2 |
| `packages/core/src/db/migrations.ts` | append v14 (creates the partial index only) | A2 |
| `packages/core/src/db/sourceRefNormalize.ts` (new) | stamp/watermark keys, `stampMatches`, `writeNormalizeStamp`, `runSourceRefNormalize` (two passes) | A3 |
| `packages/core/src/db/migrationGate.ts` (new) | `readSchemaVersion`, `probePendingWork` | A4 |
| `packages/core/src/types.ts` | `WikiSetupOptions`, `WikiMigrationRequiredError`, `WikiSearchUnavailableError`, `isWikiSearchUnavailableError`, doc comments | A4, A5, A8 |
| `packages/core/src/WikiMemory.ts` | `setup(opts)` ordering; fresh path; normalize call; `syncSearchIndex()` init retry | A2–A5 |
| `packages/core/src/repositories/EntryRepository.ts` | delete `findRowsForSourceRefMigration`; add `hasStoredEmbedding` | A3, A6 |
| `packages/core/src/repositories/MetadataRepository.ts` | `vacuum()` resets normalize watermarks | A3 |
| `packages/core/src/services/search/createIndexStrategy.ts` | probe classification, retry, never-demote | A5 |
| `packages/core/src/services/search/UnavailableIndexStrategy.ts` (new) | degraded strategy | A5 |
| `packages/core/src/services/SearchService.ts` | `isKeywordAvailable()` | A5 |
| `packages/core/src/services/RetrievalService.ts` | `:223` local catch | A6 |
| `packages/core/src/services/MaintenanceService.ts` | heal pre-check before `runBatched` | A6 |
| `packages/core/src/services/librarian/ops/gate.ts`, `ops/index.ts` | `gateNeedsKeyword` + pre-extract abort | A6 |

---

### Task A0 (controller): baseline

- [x] **Step 1:** on `cfb56fe`, run the full core suite. Append under Global Constraints: `Baseline (cfb56fe): <files> files, <tests> tests completed, <n> fork errors, 0 assertion failures`.
- [x] **Step 2:** `git add -f docs/superpowers/plans/2026-10-10-issue280-setup-walltime-plan.md && git commit -m "docs(plan): record issue280 PR-A suite baseline"`

---

### Task A1: idempotent `normalizeSourceRef` (spec 7(q))

**Files:**
- Modify: `packages/core/src/utils/pure.ts:907-911`
- Test: `packages/core/__tests__/normalizeSourceRef.test.ts` (new)

**Interfaces:**
- Produces: `normalizeSourceRef(value: string): string | null`, unchanged signature, now a fixed point (`n(n(x)) === n(x)`). Tasks A3 and A4 rely on the fixed point: "violating" ⇔ `normalizeSourceRef(v) !== v`.

- [x] **Step 1: Write the failing test**

```typescript
// packages/core/__tests__/normalizeSourceRef.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeSourceRef } from '../src/utils/pure';

const ALPHABET = 'ab Z09._-/\\\u0000日 \t';
function lcg(seed: number) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

describe('normalizeSourceRef', () => {
  it('trims a trailing space exposed by the 255-char cut (was non-idempotent)', () => {
    const raw = 'a'.repeat(254) + ' ' + 'tail';
    const once = normalizeSourceRef(raw);
    expect(once).toBe('a'.repeat(254));
    expect(normalizeSourceRef(once!)).toBe(once);
  });

  it('is a fixed point: n(n(x)) === n(x) for 5000 generated strings', () => {
    const rnd = lcg(280);
    for (let i = 0; i < 5000; i++) {
      const len = Math.floor(rnd() * 600);
      let s = '';
      for (let j = 0; j < len; j++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
      const n = normalizeSourceRef(s);
      if (n !== null) expect(normalizeSourceRef(n)).toBe(n);
    }
  });

  it('keeps existing behavior for ordinary refs', () => {
    expect(normalizeSourceRef('  docs/a b.md ')).toBe('docsa b.md');
    expect(normalizeSourceRef('///')).toBeNull();
    expect(normalizeSourceRef('日本語')).toBeNull();
    expect(normalizeSourceRef('a/b')).toBe('ab');
  });
});
```

- [x] **Step 2: Run to verify failure** — `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/normalizeSourceRef.test.ts`. Expected: FAIL on the first case (`received` ends with a space).
- [x] **Step 3: Implement** — in `pure.ts` replace the `cleaned` line:

```typescript
export function normalizeSourceRef(value: string): string | null {
  if (typeof value !== 'string') return null;
  // trimEnd after the cut: a 255-char slice can end in a space, and without
  // it the function is not a fixed point (spec #280 rev 8 M5, 7(q)).
  const cleaned = value.replace(/[^A-Za-z0-9._\- ]/g, '').trim().slice(0, 255).trimEnd();
  return cleaned.length > 0 ? cleaned : null;
}
```

- [x] **Step 4: Run to verify pass** (same command). Then run `hasChanged.test.ts`, `hasChangedBatched.test.ts`, `ingest.test.ts`, `importDump.test.ts` — all PASS.
- [x] **Step 5: Commit** — `git add packages/core/src/utils/pure.ts packages/core/__tests__/normalizeSourceRef.test.ts && git commit -m "fix(core): make normalizeSourceRef idempotent at the 255-char cut (#280)"`

---

### Task A2: partial legacy index — v14 migration + fresh path (spec Change 2, 7(h), part of 7(b))

**Files:**
- Modify: `packages/core/src/db/schema.ts` (new export below `setupDatabase`)
- Modify: `packages/core/src/db/migrations.ts` (append the v14 entry after v13, before `CURRENT_SCHEMA_VERSION` at :358)
- Modify: `packages/core/src/WikiMemory.ts:266-268` (fresh branch of `setup()`)
- Modify: `packages/core/__tests__/migration13.test.ts:39-40,63` (v13 is no longer last)
- Test: `packages/core/__tests__/legacyProbeIndex.test.ts` (new)

**Interfaces:**
- Produces: `legacySourceTypeIndexDdl(prefix: string): string` (exported from `db/schema.ts`), plus `MIGRATIONS` entry `{ version: 14 }`. `CURRENT_SCHEMA_VERSION` becomes 14 automatically.

- [x] **Step 1: Write the failing test**

```typescript
// packages/core/__tests__/legacyProbeIndex.test.ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/db/migrations';
import { openTestDatabase } from './helpers/sqliteAdapter';

const P = 'llm_wiki_';
const stub = { llmProvider: { generateText: async () => '{}' } } as const;
const PROBE = `SELECT 1 AS one FROM ${P}entries WHERE source_type IN ('user_document', 'agent_inferred') LIMIT 1`;

async function indexExists(db: ReturnType<typeof openTestDatabase>) {
  return (await db.getFirstAsync(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='${P}entries_legacy_source_type_idx'`)) != null;
}

describe('legacy source_type partial index', () => {
  it('v14 is the last migration', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(14);
    expect(MIGRATIONS[MIGRATIONS.length - 1].version).toBe(14);
  });

  it('fresh store gets the index; the probe uses it', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stub).setup();
    expect(await indexExists(db)).toBe(true);
    for (let i = 0; i < 1000; i++) {
      await db.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at) VALUES (?, 'e', 't', 'b', 1, 1)`, [`f${i}`]);
    }
    const plan = await db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${PROBE}`);
    expect(plan.map((r) => r.detail).join(' ')).toContain('entries_legacy_source_type_idx');
  });

  it('v13 store gains the index through v14, not through setupDatabase', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stub).setup();
    await db.execAsync(`DROP INDEX ${P}entries_legacy_source_type_idx`);
    await db.runAsync(`UPDATE ${P}meta SET value = '13' WHERE key = 'schema_version'`);
    await new WikiMemory(db, stub).setup();
    expect(await indexExists(db)).toBe(true);
    const v = await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key='schema_version'`);
    expect(v?.value).toBe('14');
  });

  it('a current-version store missing the index is NOT repaired by every-open DDL', async () => {
    // Pins "new indexes only via migrations/fresh path": setupDatabase must not build it.
    const db = openTestDatabase();
    await new WikiMemory(db, stub).setup();
    await db.execAsync(`DROP INDEX ${P}entries_legacy_source_type_idx`);
    await new WikiMemory(db, stub).setup();
    expect(await indexExists(db)).toBe(false);
  });

  it('probe still fails closed when a legacy row exists', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stub).setup();
    await db.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, source_type, created_at, updated_at) VALUES ('x','e','t','b','user_document',1,1)`);
    await expect(new WikiMemory(db, stub).setup()).rejects.toThrow(/legacy source_type/);
  });
});
```

- [x] **Step 2: Run to verify failure** — expected FAIL: `CURRENT_SCHEMA_VERSION` is 13; the index doesn't exist.
- [x] **Step 3: Implement**

In `schema.ts`, after `setupDatabase`:

```typescript
/**
 * Partial covering index for the every-open legacy source_type probe
 * (`EntryRepository.hasLegacySourceTypes` — its WHERE must stay textually
 * identical to this index's WHERE so the planner uses it). Created only by
 * migration v14 and the fresh-store path, never by setupDatabase: on an
 * existing store this build is unchunkable work the migration gate defers
 * out of the writer lease (spec #280 rev 11, Change 1/2).
 */
export function legacySourceTypeIndexDdl(prefix: string): string {
  return `CREATE INDEX IF NOT EXISTS ${prefix}entries_legacy_source_type_idx
    ON ${prefix}entries(source_type) WHERE source_type IN ('user_document', 'agent_inferred');`;
}
```

In `migrations.ts`, change the import to `import { createTemporalIndexesIfColumnsExist, legacySourceTypeIndexDdl } from './schema';` and append after the v13 entry:

```typescript
  {
    version: 14,
    description: 'Partial covering index for the legacy source_type probe (#280). The source_ref normalize is a stamp-checked step after the migrations loop, not part of this migration',
    run: async (db, prefix) => {
      await db.execAsync(legacySourceTypeIndexDdl(prefix));
    },
  },
```

In `WikiMemory.ts` add `legacySourceTypeIndexDdl` to the `./db/schema` import. In the fresh branch (`if (!entriesExistedBeforeSetup)`), make the index the first statement:

```typescript
    if (!entriesExistedBeforeSetup) {
      await this.db.execAsync(legacySourceTypeIndexDdl(this.prefix));
      await this.metadataRepo.setMeta('schema_version', String(CURRENT_SCHEMA_VERSION), this.db);
      currentVersion = CURRENT_SCHEMA_VERSION;
    } else {
```

In `migration13.test.ts`:
- replace the "is the last migration" body with `expect(MIGRATIONS.some((m) => m.version === 13)).toBe(true);`;
- at :63 change `toBe('13')` to `toBe(String(CURRENT_SCHEMA_VERSION))`.

- [x] **Step 4: Run to verify pass** — run `legacyProbeIndex.test.ts`, `migration13.test.ts`, `migrations.test.ts`, then `grep -rn "toBe('13')\|toBe(13)" packages/core/__tests__` → no remaining hits. Then typecheck.
- [x] **Step 5: Commit** — `perf(core): partial covering index for the legacy source_type probe via v14 (#280 RC-2)`

---

### Task A3: two-pass stamped `source_ref` normalize (spec Change 1; 7(c)(d)(l)(p normalize side)(s))

**Files:**
- Create: `packages/core/src/db/sourceRefNormalize.ts`
- Modify: `packages/core/src/WikiMemory.ts:301-309` (replace the normalize block) and the fresh branch (write the stamp)
- Modify: `packages/core/src/repositories/EntryRepository.ts:1242-1255` (delete `findRowsForSourceRefMigration`; keep `updateSourceRefByRowid`)
- Modify: `packages/core/src/repositories/MetadataRepository.ts:160-163` (`vacuum()` resets the normalize watermarks)
- Test: `packages/core/__tests__/sourceRefNormalize.test.ts` (new)

**Interfaces:**
- Consumes: `normalizeSourceRef` (A1); `MIGRATIONS[14]` (A2).
- Produces (all exported from `db/sourceRefNormalize.ts`):
  - `SOURCE_REF_NORMALIZE_ALG = 1`
  - `NORMALIZE_STAMP_KEY = 'source_ref_normalize_stamp'`
  - `ENTRIES_WM_KEY = 'normalize_v14_entries_wm'`
  - `SRI_WM_KEY = 'normalize_v14_sri_wm'`
  - `stampMatches(raw: string | null): boolean`
  - `writeNormalizeStamp(meta: MetadataRepository, tx: SQLiteAdapter): Promise<void>`
  - `runSourceRefNormalize(db: SQLiteAdapter, prefix: string, meta: MetadataRepository): Promise<void>`
  - Task A4 consumes `stampMatches` + `NORMALIZE_STAMP_KEY`.

- [x] **Step 1: Write the failing test**

```typescript
// packages/core/__tests__/sourceRefNormalize.test.ts
import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import {
  ENTRIES_WM_KEY, NORMALIZE_STAMP_KEY, SOURCE_REF_NORMALIZE_ALG, SRI_WM_KEY,
} from '../src/db/sourceRefNormalize';

const P = 'llm_wiki_';
const stub = { llmProvider: { generateText: async () => '{}' } } as const;
type Db = ReturnType<typeof openTestDatabase>;

const meta = async (db: Db, k: string) =>
  (await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = ?`, [k]))?.value ?? null;
const ref = async (db: Db, id: string) =>
  (await db.getFirstAsync<{ source_ref: string | null }>(`SELECT source_ref FROM ${P}entries WHERE id = ?`, [id]))!.source_ref;
async function fact(db: Db, id: string, sourceRef: string | null) {
  await db.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, source_ref, created_at, updated_at) VALUES (?, 'e', 't', 'b', ?, 1, 1)`, [id, sourceRef]);
}
async function sri(db: Db, id: string, sourceRef: string, hash: string) {
  await db.runAsync(`INSERT INTO ${P}source_ref_index (id, entity_id, source_hash, source_ref, created_at) VALUES (?, 'e', ?, ?, 1)`, [id, hash, sourceRef]);
}
/** A built store with the stamp removed — the shape of an upgraded v13 store. */
async function unstamped(): Promise<Db> {
  const db = openTestDatabase();
  await new WikiMemory(db, stub).setup();
  await db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [NORMALIZE_STAMP_KEY]);
  return db;
}

describe('v14 source_ref normalize', () => {
  it('fresh store is stamped and has no watermark keys (7(b))', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stub).setup();
    expect(JSON.parse((await meta(db, NORMALIZE_STAMP_KEY))!)).toEqual({ schema_version: 14, normalize_alg: SOURCE_REF_NORMALIZE_ALG });
    expect(await meta(db, ENTRIES_WM_KEY)).toBeNull();
    expect(await meta(db, SRI_WM_KEY)).toBeNull();
  });

  it('normalizes entries incl. >255 and trim-before-truncate cases, then stamps', async () => {
    const db = await unstamped();
    await fact(db, 'slash', 'docs/a.md');
    await fact(db, 'long', 'x'.repeat(300));
    await fact(db, 'edge', 'a'.repeat(254) + ' tail');
    await fact(db, 'null', '///');
    await new WikiMemory(db, stub).setup();
    expect(await ref(db, 'slash')).toBe('docsa.md');
    expect(await ref(db, 'long')).toBe('x'.repeat(255));
    expect(await ref(db, 'edge')).toBe('a'.repeat(254));
    expect(await ref(db, 'null')).toBeNull();
    expect(await meta(db, NORMALIZE_STAMP_KEY)).not.toBeNull();
    expect(await meta(db, ENTRIES_WM_KEY)).toBeNull();
    expect(await meta(db, SRI_WM_KEY)).toBeNull();
  });

  it('pass 2: rewrites drifted source_ref_index refs, soft-deletes NULL-normalizing ones (7(s))', async () => {
    const db = await unstamped();
    await sri(db, 'sri:e:h1', 'a/b', 'h1');
    await sri(db, 'sri:e:h2', '///', 'h2');
    await sri(db, 'sri:e:h3', '日本語', 'h3');
    await new WikiMemory(db, stub).setup();
    const rows = await db.getAllAsync<{ id: string; source_ref: string; deleted_at: number | null }>(
      `SELECT id, source_ref, deleted_at FROM ${P}source_ref_index ORDER BY id`);
    expect(rows.find((r) => r.id === 'sri:e:h1')).toMatchObject({ source_ref: 'ab', deleted_at: null });
    expect(rows.find((r) => r.id === 'sri:e:h2')!.deleted_at).not.toBeNull();
    expect(rows.find((r) => r.id === 'sri:e:h3')!.deleted_at).not.toBeNull();
    expect(rows.every((r) => r.source_ref !== null)).toBe(true);
    expect(await meta(db, NORMALIZE_STAMP_KEY)).not.toBeNull();
  });

  it('a stamped store performs zero normalize reads on the next open', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stub).setup();
    const spy = vi.spyOn(db, 'getAllAsync');
    await new WikiMemory(db, stub).setup();
    const scans = spy.mock.calls.filter(([sql]) => /SELECT rowid, id, source_ref FROM/.test(String(sql)));
    expect(scans).toEqual([]);
  });

  it('runs to completion across many chunks in one open (>500 rows) (7(l))', async () => {
    const db = await unstamped();
    for (let i = 0; i < 1200; i++) await fact(db, `f${i}`, `dir/f${i}`);
    await new WikiMemory(db, stub).setup();
    const bad = await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}entries WHERE source_ref LIKE '%/%'`);
    expect(bad!.n).toBe(0);
    expect(await meta(db, ENTRIES_WM_KEY)).toBeNull();
  });

  it('alg mismatch forces exactly one rescan; version=14 + missing stamp self-heals (7(c)(d))', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stub).setup();
    await fact(db, 'late', 'p/q');
    await db.runAsync(`UPDATE ${P}meta SET value = ? WHERE key = ?`, [JSON.stringify({ schema_version: 14, normalize_alg: 0 }), NORMALIZE_STAMP_KEY]);
    await new WikiMemory(db, stub).setup();
    expect(await ref(db, 'late')).toBe('pq');
    expect(JSON.parse((await meta(db, NORMALIZE_STAMP_KEY))!).normalize_alg).toBe(SOURCE_REF_NORMALIZE_ALG);
  });

  it('resumes from a valid watermark; restarts when its fingerprint row moved (7(p))', async () => {
    const db = await unstamped();
    for (let i = 0; i < 10; i++) await fact(db, `f${i}`, `d/f${i}`);
    const at5 = await db.getFirstAsync<{ rowid: number; id: string }>(`SELECT rowid, id FROM ${P}entries WHERE id = 'f5'`);
    // A valid checkpoint means the prefix through the watermark row is already normalized.
    for (let i = 0; i <= 5; i++) await db.runAsync(`UPDATE ${P}entries SET source_ref = ? WHERE id = ?`, [`df${i}`, `f${i}`]);
    await db.runAsync(`INSERT INTO ${P}meta (key, value) VALUES (?, ?)`, [ENTRIES_WM_KEY, JSON.stringify(at5)]);
    await new WikiMemory(db, stub).setup();
    expect(await ref(db, 'f9')).toBe('df9');    // after the watermark: normalized
    expect(await ref(db, 'f2')).toBe('df2');    // seeded prefix stays normalized
    for (let i = 0; i < 10; i++) expect(await ref(db, `f${i}`)).toBe(`df${i}`); // every row normalized after resume

    const db2 = await unstamped();
    for (let i = 0; i < 10; i++) await fact(db2, `f${i}`, `d/f${i}`);
    const r5 = await db2.getFirstAsync<{ rowid: number }>(`SELECT rowid FROM ${P}entries WHERE id = 'f5'`);
    await db2.runAsync(`INSERT INTO ${P}meta (key, value) VALUES (?, ?)`, [ENTRIES_WM_KEY, JSON.stringify({ rowid: r5!.rowid, id: 'not-f5' })]);
    await new WikiMemory(db2, stub).setup();
    expect(await ref(db2, 'f2')).toBe('df2');   // fingerprint mismatch ⇒ pass restarted from 0
  });

  it('engine VACUUM clears normalize watermarks (7(p))', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stub);
    await wiki.setup();
    await db.runAsync(`INSERT INTO ${P}meta (key, value) VALUES (?, '{"rowid":1,"id":"x"}'), (?, '{"rowid":1,"id":"y"}')`, [ENTRIES_WM_KEY, SRI_WM_KEY]);
    await (wiki.__testAccess as any).metadataRepo.vacuum();
    expect(await meta(db, ENTRIES_WM_KEY)).toBeNull();
    expect(await meta(db, SRI_WM_KEY)).toBeNull();
  });

  it('empty tables complete immediately and stamp', async () => {
    const db = await unstamped();
    await new WikiMemory(db, stub).setup();
    expect(await meta(db, NORMALIZE_STAMP_KEY)).not.toBeNull();
  });
});
```

- [x] **Step 2: Run to verify failure** — expected FAIL: the module doesn't exist.
- [x] **Step 3: Implement**

```typescript
// packages/core/src/db/sourceRefNormalize.ts
import type { SQLiteAdapter } from '../types';
import type { MetadataRepository } from '../repositories/MetadataRepository';
import { normalizeSourceRef } from '../utils/pure';

/** Id of the current normalizeSourceRef semantics. Bump on any change to it (forces one rescan). */
export const SOURCE_REF_NORMALIZE_ALG = 1;
export const NORMALIZE_STAMP_KEY = 'source_ref_normalize_stamp';
export const ENTRIES_WM_KEY = 'normalize_v14_entries_wm';
export const SRI_WM_KEY = 'normalize_v14_sri_wm';
const CHUNK = 500;

interface Watermark { rowid: number; id: string }

export function stampMatches(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const s = JSON.parse(raw) as { normalize_alg?: unknown };
    return s?.normalize_alg === SOURCE_REF_NORMALIZE_ALG;
  } catch {
    return false;
  }
}

export async function writeNormalizeStamp(meta: MetadataRepository, tx: SQLiteAdapter): Promise<void> {
  await meta.setMeta(NORMALIZE_STAMP_KEY, JSON.stringify({ schema_version: 14, normalize_alg: SOURCE_REF_NORMALIZE_ALG }), tx);
}

/**
 * Resume point for one pass: the stored rowid only when its fingerprint id
 * still sits at that rowid. Otherwise (external VACUUM renumbering, manual
 * SQL) restart from 0 — a restart is idempotent, a stale resume skips rows.
 */
async function resumeRowid(db: SQLiteAdapter, prefix: string, meta: MetadataRepository, table: string, key: string): Promise<number> {
  const raw = await meta.getMeta(key);
  if (!raw) return 0;
  let wm: Partial<Watermark>;
  try { wm = JSON.parse(raw) as Partial<Watermark>; } catch { return 0; }
  if (typeof wm.rowid !== 'number' || typeof wm.id !== 'string') return 0;
  const row = await db.getFirstAsync<{ id: string }>(`SELECT id FROM ${prefix}${table} WHERE rowid = ?`, [wm.rowid]);
  return row?.id === wm.id ? wm.rowid : 0;
}

async function runPass(
  db: SQLiteAdapter, prefix: string, meta: MetadataRepository,
  table: 'entries' | 'source_ref_index', key: string, stampOnCompletion: boolean,
): Promise<void> {
  let cursor = await resumeRowid(db, prefix, meta, table, key);
  for (;;) {
    const done = await db.withTransactionAsync(async (tx) => {
      const rows = await tx.getAllAsync<{ rowid: number; id: string; source_ref: string | null }>(
        `SELECT rowid, id, source_ref FROM ${prefix}${table} WHERE rowid > ? ORDER BY rowid LIMIT ${CHUNK}`, [cursor]);
      for (const r of rows) {
        if (r.source_ref == null) continue;
        const n = normalizeSourceRef(r.source_ref);
        if (n === r.source_ref) continue;
        if (table === 'entries') {
          await tx.runAsync(`UPDATE ${prefix}entries SET source_ref = ? WHERE rowid = ?`, [n, r.rowid]);
        } else if (n === null) {
          // source_ref_index.source_ref is TEXT NOT NULL: soft-delete, never write NULL (spec rev 10 M1).
          await tx.runAsync(`UPDATE ${prefix}source_ref_index SET deleted_at = COALESCE(deleted_at, ?) WHERE rowid = ?`, [Date.now(), r.rowid]);
        } else {
          await tx.runAsync(`UPDATE ${prefix}source_ref_index SET source_ref = ? WHERE rowid = ?`, [n, r.rowid]);
        }
      }
      if (rows.length < CHUNK) {
        await meta.deleteMeta(key, tx);
        if (stampOnCompletion) await writeNormalizeStamp(meta, tx);
        return true;
      }
      const last = rows[rows.length - 1];
      await meta.setMeta(key, JSON.stringify({ rowid: last.rowid, id: last.id }), tx);
      cursor = last.rowid;
      return false;
    });
    if (done) return;
  }
}

/**
 * Spec #280 Change 1: one-time, to-completion normalize of both stored copies
 * of source_ref, in ≤500-row transactions, NOT bounded by setupBudgetMs (a
 * half-normalized store answers hasChanged/forget wrongly). Skipped entirely
 * when the stamp matches. The stamp lands in pass 2's final transaction, so
 * "stamped" always means both passes completed.
 */
export async function runSourceRefNormalize(db: SQLiteAdapter, prefix: string, meta: MetadataRepository): Promise<void> {
  if (stampMatches(await meta.getMeta(NORMALIZE_STAMP_KEY))) return;
  await runPass(db, prefix, meta, 'entries', ENTRIES_WM_KEY, false);
  await runPass(db, prefix, meta, 'source_ref_index', SRI_WM_KEY, true);
}
```

In `WikiMemory.ts`:
- add `import { runSourceRefNormalize, writeNormalizeStamp } from './db/sourceRefNormalize';`;
- in the fresh branch, after the `schema_version` setMeta, add `await writeNormalizeStamp(this.metadataRepo, this.db);`;
- replace the block at :297-309 (legacy assert + `findRowsForSourceRefMigration` + its transaction) with:

```typescript
    if (entriesExistedBeforeSetup) {
      await this.importExportService.assertNoLegacySourceTypes();
      await runSourceRefNormalize(this.db, this.prefix, this.metadataRepo);
    }
```

- remove the now-unused `normalizeSourceRef` import from `WikiMemory.ts` only if nothing else there uses it — it IS used at :349/:371/:433/:810, so keep it.

In `EntryRepository.ts`, delete `findRowsForSourceRefMigration` (verify first: `grep -rn findRowsForSourceRefMigration packages/` → only the deleted definition).

In `MetadataRepository.ts`:

```typescript
  async vacuum(): Promise<void> {
    // VACUUM may renumber implicit rowids; resume watermarks keyed on rowid
    // become meaningless (spec #280 Change 3 VACUUM section, 7(p)).
    await this.deleteMeta(ENTRIES_WM_KEY);
    await this.deleteMeta(SRI_WM_KEY);
    await this.db.execAsync(`PRAGMA wal_checkpoint(TRUNCATE)`);
    await this.db.execAsync(`VACUUM`);
  }
```

with `import { ENTRIES_WM_KEY, SRI_WM_KEY } from '../db/sourceRefNormalize';`. If that import cycles (`sourceRefNormalize` imports the `MetadataRepository` *type* only, so it should not), move the two key constants to a `db/normalizeKeys.ts` leaf file and import them from both places.

- [x] **Step 4: Run to verify pass** — run `sourceRefNormalize.test.ts`, `legacyProbeIndex.test.ts`, `hasChanged*.test.ts`, `forgetDryRun.test.ts`, `ingestDuplicateHash.test.ts`, `findSourceRefsByHash.test.ts`, `importDump.test.ts`, `migration9.test.ts` — all PASS. Then typecheck.
- [x] **Step 5: Commit** — `feat(core): stamped two-pass source_ref normalize replaces the every-open scan (#280 RC-2/RC-7)`

---

### Task A4: migration gate — `setup({ migrations: 'refuse' })` (spec Change 1 gate, 7(t))

**Files:**
- Create: `packages/core/src/db/migrationGate.ts`
- Modify: `packages/core/src/types.ts` (add `WikiSetupOptions` + `WikiMigrationRequiredError` near the other error classes, ~:1012)
- Modify: `packages/core/src/WikiMemory.ts` (`setup()` signature + gate before `setupDatabase`; version derivation → `readSchemaVersion`)
- Test: `packages/core/__tests__/migrationGate.test.ts` (new)

**Interfaces:**
- Consumes: `stampMatches`, `NORMALIZE_STAMP_KEY`, `ENTRIES_WM_KEY` (A3); `CURRENT_SCHEMA_VERSION`.
- Produces:
  - `interface WikiSetupOptions { migrations?: 'allow' | 'refuse' | 'auto' }` (types.ts, exported via `export * from './types'`);
  - `class WikiMigrationRequiredError extends Error { fromVersion: number; toVersion: number; normalizeRequired: boolean; retiredTables: number }`;
  - `readSchemaVersion(meta: MetadataRepository, prefix: string): Promise<number>`;
  - `interface PendingMigrationWork { fromVersion: number; toVersion: number; normalizeRequired: boolean; retiredTables: number }`;
  - `probePendingWork(meta: MetadataRepository, prefix: string): Promise<PendingMigrationWork | null>`;
  - `WikiMemory.setup(opts?: WikiSetupOptions): Promise<void>`.
  - PR-B Task B4 extends `probePendingWork`'s `retiredTables`.

- [x] **Step 1: Write the failing test**

```typescript
// packages/core/__tests__/migrationGate.test.ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiMigrationRequiredError } from '../src/index';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import { ENTRIES_WM_KEY, NORMALIZE_STAMP_KEY } from '../src/db/sourceRefNormalize';
import { openTestDatabase } from './helpers/sqliteAdapter';

const P = 'llm_wiki_';
const stub = { llmProvider: { generateText: async () => '{}' } } as const;
type Db = ReturnType<typeof openTestDatabase>;
const snapshot = async (db: Db) => ({
  master: await db.getAllAsync(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`),
  meta: await db.getAllAsync(`SELECT key, value FROM ${P}meta ORDER BY key`),
});
/** v13-shaped store: version 13, no partial index, no stamp. */
async function v13(): Promise<Db> {
  const db = openTestDatabase();
  await new WikiMemory(db, stub).setup();
  await db.execAsync(`DROP INDEX ${P}entries_legacy_source_type_idx`);
  await db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [NORMALIZE_STAMP_KEY]);
  await db.runAsync(`UPDATE ${P}meta SET value = '13' WHERE key = 'schema_version'`);
  return db;
}

describe("setup({ migrations: 'refuse' })", () => {
  it('(i) v13 store throws before ANY mutation', async () => {
    const db = await v13();
    const before = await snapshot(db);
    const err = await new WikiMemory(db, stub).setup({ migrations: 'refuse' }).catch((e) => e);
    expect(err).toBeInstanceOf(WikiMigrationRequiredError);
    expect(err).toMatchObject({ name: 'WikiMigrationRequiredError', fromVersion: 13, toVersion: CURRENT_SCHEMA_VERSION, normalizeRequired: true, retiredTables: 0 });
    expect(await snapshot(db)).toEqual(before);
  });

  it('(ii) plain setup() migrates; the next refuse open passes', async () => {
    const db = await v13();
    await new WikiMemory(db, stub).setup();
    await expect(new WikiMemory(db, stub).setup({ migrations: 'refuse' })).resolves.toBeUndefined();
  });

  it('(iii) stamp mismatch at version 14 trips the gate', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stub).setup();
    await db.runAsync(`UPDATE ${P}meta SET value = '{"schema_version":14,"normalize_alg":0}' WHERE key = ?`, [NORMALIZE_STAMP_KEY]);
    await expect(new WikiMemory(db, stub).setup({ migrations: 'refuse' })).rejects.toMatchObject({ fromVersion: 14, normalizeRequired: true });
  });

  it('(iv) fresh store opens normally under refuse', async () => {
    await expect(new WikiMemory(openTestDatabase(), stub).setup({ migrations: 'refuse' })).resolves.toBeUndefined();
  });

  it('(v) mid-normalize crash shape: refuse throws, plain setup resumes and stamps', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, stub).setup();
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [NORMALIZE_STAMP_KEY]);
    await db.runAsync(`INSERT INTO ${P}meta (key, value) VALUES (?, '{"rowid":0,"id":""}')`, [ENTRIES_WM_KEY]);
    await expect(new WikiMemory(db, stub).setup({ migrations: 'refuse' })).rejects.toBeInstanceOf(WikiMigrationRequiredError);
    await new WikiMemory(db, stub).setup();
    expect(await db.getFirstAsync(`SELECT 1 FROM ${P}meta WHERE key = ?`, [NORMALIZE_STAMP_KEY])).not.toBeNull();
  });

  it('(vi) default options ('allow') keep run-migrations behavior; bad values are rejected', async () => {
    const db = await v13();
    await expect(new WikiMemory(db, stub).setup()).resolves.toBeUndefined();
    await expect(new WikiMemory(db, stub).setup({ migrations: 'later' as never })).rejects.toThrow(TypeError);
  });

  it('a store with no meta table counts as pending', async () => {
    const db = openTestDatabase();
    await db.execAsync(`CREATE TABLE ${P}entries (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL)`);
    await expect(new WikiMemory(db, stub).setup({ migrations: 'refuse' })).rejects.toMatchObject({ fromVersion: 0, normalizeRequired: true });
  });
});
```

- [x] **Step 2: Run to verify failure** — expected FAIL: the `WikiMigrationRequiredError` export doesn't exist.
- [x] **Step 3: Implement**

In `types.ts` (next to `WikiBusyError`):

```typescript
/** Options for {@link WikiMemory.setup}. */
export interface WikiSetupOptions {
  /**
   * `'allow'` (default): perform pending one-time migration work inside this
   * call, as setup() always has. `'refuse'`: if any one-time work is pending
   * (schema migration, source_ref normalize, retired FTS table reclamation),
   * throw {@link WikiMigrationRequiredError} BEFORE mutating anything. Hosts
   * that open inside a writer lease use `'refuse'` and run a plain `setup()`
   * outside the lease when it throws (spec #280 rev 11). `'auto'`: auto-run
   * only the stamped source_ref normalize; any other pending work throws.
   * @default 'allow'
   */
  migrations?: 'allow' | 'refuse' | 'auto';
}

/**
 * Thrown by `setup({ migrations: 'refuse' })` when one-time work is pending.
 * Nothing was mutated. Run `setup()` (default options) outside the writer
 * lease to perform it; the work is chunked and crash-resumable.
 */
export class WikiMigrationRequiredError extends Error {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly normalizeRequired: boolean;
  readonly retiredTables: number;

  constructor(params: { fromVersion: number; toVersion: number; normalizeRequired: boolean; retiredTables: number }) {
    const parts = [`schema ${params.fromVersion} → ${params.toVersion}`];
    if (params.normalizeRequired) parts.push('source_ref normalize');
    if (params.retiredTables > 0) parts.push(`${params.retiredTables} retired FTS table(s)`);
    super(`Database has pending one-time work (${parts.join(', ')}); run setup() without migrations: 'refuse' outside the writer lease`);
    this.name = 'WikiMigrationRequiredError';
    this.fromVersion = params.fromVersion;
    this.toVersion = params.toVersion;
    this.normalizeRequired = params.normalizeRequired;
    this.retiredTables = params.retiredTables;
  }
}
```

```typescript
// packages/core/src/db/migrationGate.ts
import type { MetadataRepository } from '../repositories/MetadataRepository';
import { CURRENT_SCHEMA_VERSION } from './migrations';
import { NORMALIZE_STAMP_KEY, stampMatches } from './sourceRefNormalize';

/** Stored schema_version, or the legacy derivation when the row is absent (moved verbatim from WikiMemory.setup). */
export async function readSchemaVersion(meta: MetadataRepository, prefix: string): Promise<number> {
  const raw = await meta.getMeta('schema_version');
  if (raw) {
    const v = parseInt(raw, 10);
    return Number.isFinite(v) ? v : 0;
  }
  const ftsDdl = await meta.getTableDdl(`${prefix}entries_fts`);
  return /tokenize\s*=\s*['"]porter\s+unicode61['"]/i.test(ftsDdl ?? '') ? 1 : 0;
}

export interface PendingMigrationWork {
  fromVersion: number;
  toVersion: number;
  normalizeRequired: boolean;
  retiredTables: number;
}

/**
 * Read-only probe for one-time work on an EXISTING store (caller checks the
 * entries table exists). Must run before setupDatabase: no DDL, no writes.
 */
export async function probePendingWork(meta: MetadataRepository, prefix: string): Promise<PendingMigrationWork | null> {
  const hasMeta = await meta.tableExists(`${prefix}meta`);
  const fromVersion = hasMeta ? await readSchemaVersion(meta, prefix) : 0;
  const normalizeRequired = !hasMeta || !stampMatches(await meta.getMeta(NORMALIZE_STAMP_KEY));
  const retiredTables = 0; // PR-B (Task B4) counts fts5_retired_tables here.
  if (fromVersion >= CURRENT_SCHEMA_VERSION && !normalizeRequired && retiredTables === 0) return null;
  return { fromVersion, toVersion: CURRENT_SCHEMA_VERSION, normalizeRequired, retiredTables };
}
```

In `WikiMemory.ts`:
- import `probePendingWork, readSchemaVersion` from `./db/migrationGate`;
- import `WikiMigrationRequiredError, type WikiSetupOptions` from `./types`;
- replace the head of `setup()` through the version derivation:

```typescript
  async setup(opts?: WikiSetupOptions) {
    const migrations = opts?.migrations ?? 'allow';
    if (migrations !== 'allow' && migrations !== 'refuse' && migrations !== 'auto') {
      throw new TypeError(`setup: migrations must be 'allow', 'refuse' or 'auto', got ${String(migrations)}`);
    }
    const entriesExistedBeforeSetup = await this.metadataRepo.tableExists(`${this.prefix}entries`);

    // Migration gate (spec #280 rev 11): read-only, and BEFORE setupDatabase,
    // whose IF NOT EXISTS DDL would otherwise build missing tables/indexes.
    if (migrations === 'refuse' && entriesExistedBeforeSetup) {
      const pending = await probePendingWork(this.metadataRepo, this.prefix);
      if (pending) throw new WikiMigrationRequiredError(pending);
    }

    await setupDatabase(this.db, this.prefix);

    let currentVersion: number;

    if (!entriesExistedBeforeSetup) {
      await this.db.execAsync(legacySourceTypeIndexDdl(this.prefix));
      await this.metadataRepo.setMeta('schema_version', String(CURRENT_SCHEMA_VERSION), this.db);
      await writeNormalizeStamp(this.metadataRepo, this.db);
      currentVersion = CURRENT_SCHEMA_VERSION;
    } else {
      currentVersion = await readSchemaVersion(this.metadataRepo, this.prefix);
    }
```

(The rest of `setup()` stays as Task A3 left it.)

- [x] **Step 4: Run to verify pass** — run `migrationGate.test.ts`, `sourceRefNormalize.test.ts`, `legacyProbeIndex.test.ts`, `migrations.test.ts`, `migration*.test.ts` — all PASS. Then typecheck.
- [x] **Step 5: Commit** — `feat(core): setup({ migrations: 'refuse' }) gate with WikiMigrationRequiredError (#280)`

---

### Task A5: RC-6 guard — probe classification, retry, `UnavailableIndexStrategy` (spec Change 4; 7(e) core + probe leg)

**Files:**
- Modify: `packages/core/src/types.ts` (add `WikiSearchUnavailableError` + `isWikiSearchUnavailableError`)
- Create: `packages/core/src/services/search/UnavailableIndexStrategy.ts`
- Modify: `packages/core/src/services/search/createIndexStrategy.ts:17-74`
- Modify: `packages/core/src/services/SearchService.ts` (add `isKeywordAvailable()` after `setIndexStrategy`)
- Modify: `packages/core/src/WikiMemory.ts:685-689` (`syncSearchIndex` retry)
- Modify (REWRITE per spec 8): `packages/core/__tests__/createIndexStrategy.test.ts:53-63` ("'auto' falls back to MiniSearch when FTS5 init throws")
- Test: `packages/core/__tests__/searchUnavailable.test.ts` (new)

**Interfaces:**
- Produces:
  - `class WikiSearchUnavailableError extends Error` (`name` = `'WikiSearchUnavailableError'`, `cause` = the init error);
  - `isWikiSearchUnavailableError(err: unknown): boolean` (Proxy-safe);
  - `class UnavailableIndexStrategy implements IndexStrategy` (constructor `(cause: unknown)`; `drain()` is a PRESENT no-op);
  - `SearchService.isKeywordAvailable(): boolean`;
  - `FTS5_INIT_RETRY_MS = 250` (exported from `createIndexStrategy.ts`);
  - `probeFts5` now THROWS on non-absence errors (still returns `false` only for module-absent).
  - Task A6 consumes `isKeywordAvailable` and `isWikiSearchUnavailableError`.

- [x] **Step 1: Write the failing tests**

Replace the `"'auto' falls back to MiniSearch when FTS5 init throws; 'fts5' re-throws"` case in `createIndexStrategy.test.ts` with:

```typescript
  it("'auto' init failure ×2 → UnavailableIndexStrategy, never detaches; 'fts5' re-throws raw", async () => {
    const db = openTestDatabase(); const meta = await fresh(db);
    await createIndexStrategy(db, P, meta, 'fts5'); // live, ledger present
    const spy = vi.spyOn(Fts5IndexStrategy.prototype, 'init').mockRejectedValue(new Error('rebuild tx lock'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await createIndexStrategy(db, P, meta, 'auto');
    expect(s).toBeInstanceOf(UnavailableIndexStrategy);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await meta.getMeta(FTS5_STATE_KEY)).toBe('live');
    expect((await objects(db)).map((r) => r.name)).toEqual(expect.arrayContaining([`${P}fts_map`, `${P}fts_pending`]));
    await expect(s.search('x', { entityIds: ['e'], limit: 5 })).rejects.toMatchObject({ name: 'WikiSearchUnavailableError', cause: expect.objectContaining({ message: 'rebuild tx lock' }) });
    await expect(createIndexStrategy(db, P, meta, 'fts5')).rejects.toThrow(/rebuild tx lock/);
    spy.mockRestore(); warn.mockRestore();
  });

  it("'auto' init fails once then succeeds → real strategy", async () => {
    const db = openTestDatabase(); const meta = await fresh(db);
    const real = Fts5IndexStrategy.prototype.init;
    const spy = vi.spyOn(Fts5IndexStrategy.prototype, 'init')
      .mockRejectedValueOnce(new Error('busy'))
      .mockImplementation(function (this: Fts5IndexStrategy) { return real.call(this); });
    expect(await createIndexStrategy(db, P, meta, 'auto')).toBeInstanceOf(Fts5IndexStrategy);
    spy.mockRestore();
  });

  it("probe error other than module-absent (SQLITE_IOERR) never detaches (7(e) probe leg)", async () => {
    const db = openTestDatabase(); const meta = await fresh(db);
    await createIndexStrategy(db, P, meta, 'fts5');
    const orig = db.getFirstAsync.bind(db);
    vi.spyOn(db, 'getFirstAsync').mockImplementation(async (sql: string, p?: unknown[]) => {
      if (sql.includes('json_valid')) throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
      return orig(sql, p);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await createIndexStrategy(db, P, meta, 'auto')).toBeInstanceOf(UnavailableIndexStrategy);
    expect(await meta.getMeta(FTS5_STATE_KEY)).toBe('live');
    warn.mockRestore();
  });
```

Add the imports `import { UnavailableIndexStrategy } from '../src/services/search/UnavailableIndexStrategy';`. Keep the two existing module-absent cases (sql.js → MiniSearch; `json_valid` missing → `false`) unchanged: they pin that module-absent still falls back.

```typescript
// packages/core/__tests__/searchUnavailable.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiSearchUnavailableError, isWikiSearchUnavailableError } from '../src/index';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { MiniSearchIndexStrategy } from '../src/services/search/MiniSearchIndexStrategy';
import { UnavailableIndexStrategy } from '../src/services/search/UnavailableIndexStrategy';
import { EntryRepository } from '../src/repositories/EntryRepository';
import { openTestDatabase } from './helpers/sqliteAdapter';

const stub = { llmProvider: { generateText: async () => '{}' } } as const;
afterEach(() => vi.restoreAllMocks());

async function unavailableWiki() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const init = vi.spyOn(Fts5IndexStrategy.prototype, 'init').mockRejectedValue(new Error('locked'));
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, stub);
  await wiki.setup();
  return { db, wiki, init, svc: (wiki.__testAccess as any).searchService };
}

describe('WikiSearchUnavailableError', () => {
  it('stable name, cause chain, package export, Proxy-safe guard', () => {
    const cause = new Error('x');
    const e = new WikiSearchUnavailableError(undefined, cause);
    expect(e.name).toBe('WikiSearchUnavailableError');
    expect(e.cause).toBe(cause);
    expect(isWikiSearchUnavailableError(e)).toBe(true);
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } });
    expect(isWikiSearchUnavailableError(hostile)).toBe(false);
  });
});

describe('unavailable keyword search inside WikiMemory', () => {
  it('setup and every sync entry point stay off the full-read path while unavailable (B1 no-op drain)', async () => {
    const fullRead = vi.spyOn(EntryRepository.prototype, 'findMiniSearchRows');
    const { db, wiki, svc } = await unavailableWiki();
    expect(svc.isKeywordAvailable()).toBe(false);
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, created_at, updated_at) VALUES ('f1','e','apple','b',1,1)`);
    await wiki.syncSearchIndex('e');            // syncEntries path
    await svc.sync();                           // sync path
    expect(fullRead).not.toHaveBeenCalled();
    const pending = await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM llm_wiki_fts_pending`);
    expect(pending!.n).toBeGreaterThan(0);      // ledger rows survive for later convergence
  });

  it('UnavailableIndexStrategy has a present no-op drain; MiniSearch has none', () => {
    expect(typeof new UnavailableIndexStrategy(new Error('x')).drain).toBe('function');
    expect((new MiniSearchIndexStrategy() as unknown as { drain?: unknown }).drain).toBeUndefined();
  });

  it('no-arg syncSearchIndex() retries init and recovers', async () => {
    const { wiki, init, svc } = await unavailableWiki();
    init.mockRestore();
    await wiki.syncSearchIndex();
    expect(svc.isKeywordAvailable()).toBe(true);
  });

  it('a fresh WikiMemory on the same store recovers (next open recovers)', async () => {
    const { db, init } = await unavailableWiki();
    init.mockRestore();
    const again = new WikiMemory(db, stub);
    await again.setup();
    expect((again.__testAccess as any).searchService.isKeywordAvailable()).toBe(true);
  });
});
```

(`findMiniSearchRows` lives on `EntryRepository` — `EntryRepository.ts:1107`; `wiki.write()` writes events, not entries, which is why the test inserts the entries row directly and drives the sync entry points.)

- [x] **Step 2: Run to verify failure** — run both files. Expected FAIL: `UnavailableIndexStrategy` module missing; the old code detaches.
- [x] **Step 3: Implement**

In `types.ts`:

```typescript
/**
 * Thrown per keyword-search query while the keyword index is unavailable
 * (FTS5 init failed after its retry; spec #280 Change 4). Writes keep working
 * and the index converges once a later open or no-arg syncSearchIndex()
 * re-inits successfully. `cause` is the underlying init error.
 */
export class WikiSearchUnavailableError extends Error {
  constructor(message = 'Keyword search is temporarily unavailable', cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'WikiSearchUnavailableError';
  }
}

/** Proxy-safe `instanceof WikiSearchUnavailableError` (issue #96: a hostile getPrototypeOf trap must not throw out of a catch). */
export function isWikiSearchUnavailableError(err: unknown): boolean {
  try { return err instanceof WikiSearchUnavailableError; } catch { return false; }
}
```

```typescript
// packages/core/src/services/search/UnavailableIndexStrategy.ts
import { WikiSearchUnavailableError } from '../../types';
import type { IndexDocument, IndexSearchOptions, IndexSearchResult, IndexStrategy } from './IndexStrategy';

/**
 * Installed when FTS5 init fails after its retry under 'auto' (spec #280
 * Change 4). The ledger and FTS tables are left untouched; entries stay the
 * source of truth and the index converges on the next successful init.
 *
 * `drain` MUST be present: SearchService's drain-less branches
 * (sync/syncEntries/syncStale) fall back to findMiniSearchRows + replaceAll —
 * a full-table read, the measured 1M-entry OOM. A no-op drain keeps every
 * entry point on the ledger path.
 */
export class UnavailableIndexStrategy implements IndexStrategy {
  constructor(private readonly cause: unknown) {}

  async search(_query: string, _options: IndexSearchOptions): Promise<IndexSearchResult[]> {
    throw new WikiSearchUnavailableError(undefined, this.cause);
  }
  async replace(_entityId: string, _ids: readonly string[], _documents: readonly IndexDocument[]): Promise<void> {}
  async replaceEntity(_entityId: string, _documents: readonly IndexDocument[]): Promise<void> {}
  async replaceAll(_documents: readonly IndexDocument[]): Promise<void> {}
  hasIndexedEntity(_entityId: string): boolean { return false; }
  async drain(): Promise<void> {}
}
```

In `createIndexStrategy.ts`:

```typescript
export const FTS5_INIT_RETRY_MS = 250;

/** True only for the errors that mean the module is genuinely absent (permanent). Proxy-safe. */
function isModuleAbsentError(err: unknown): boolean {
  let msg = '';
  try { msg = String((err as { message?: unknown } | null)?.message ?? err); } catch { return false; }
  return /no such module: fts5/i.test(msg) || /no such function: json_valid/i.test(msg);
}

/**
 * Whether this SQLite build has FTS5 and json1. Returns false ONLY when the
 * module is genuinely absent; any other error (SQLITE_IOERR, NOMEM,
 * INTERRUPT, …) is rethrown so the caller treats it as a transient init
 * failure instead of detaching a healthy store (spec #280 rev 10 M5).
 */
export async function probeFts5(db: SQLiteAdapter, prefix: string): Promise<boolean> {
  const name = `temp.${prefix}fts5_probe`;
  try {
    await db.execAsync(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(x)`);
    const row = await db.getFirstAsync<{ ok: number }>(`SELECT json_valid('[]') AS ok`);
    return row?.ok === 1;
  } catch (err) {
    if (isModuleAbsentError(err)) return false;
    throw err;
  } finally {
    try { await db.execAsync(`DROP TABLE IF EXISTS ${name}`); } catch { /* module absent */ }
  }
}
```

and replace `createIndexStrategy`:

```typescript
/** Resolve the keyword-index strategy for this database. Spec 2026-10-05 §PR-2; failure ordering per spec #280 Change 4. */
export async function createIndexStrategy(
  db: SQLiteAdapter,
  prefix: string,
  metadataRepo: MetadataRepository,
  preferred: IndexStrategyPreference,
): Promise<IndexStrategy> {
  if (preferred === 'minisearch') {
    await detachFts5(db, prefix, metadataRepo); // operator's explicit choice
    return new MiniSearchIndexStrategy();
  }
  const attempt = async (): Promise<IndexStrategy | 'absent'> => {
    if (!(await probeFts5(db, prefix))) return 'absent';
    const strategy = new Fts5IndexStrategy(db, prefix, metadataRepo);
    await strategy.init();
    return strategy;
  };
  const absent = async (): Promise<IndexStrategy> => {
    if (preferred === 'fts5') {
      throw new Error(`indexStrategy 'fts5' was requested, but this SQLite build lacks FTS5 or json1.`);
    }
    await detachFts5(db, prefix, metadataRepo); // module genuinely absent: permanent, MiniSearch is valid
    return new MiniSearchIndexStrategy();
  };

  try {
    const s = await attempt();
    return s === 'absent' ? absent() : s;
  } catch (err) {
    if (preferred === 'fts5') throw err; // pinned: surface the raw failure, unchanged contract
  }
  await new Promise((resolve) => setTimeout(resolve, FTS5_INIT_RETRY_MS));
  try {
    const s = await attempt();
    return s === 'absent' ? absent() : s;
  } catch (err) {
    // Never detachFts5 here: a transient failure must not drop the ledger and
    // route a pro-scale store into MiniSearch's full sync (measured OOM).
    console.warn('[WikiMemory] FTS5 init failed after retry; keyword search unavailable until a later open or syncSearchIndex():', err);
    return new UnavailableIndexStrategy(err);
  }
}
```

(import `UnavailableIndexStrategy`).

In `SearchService.ts`, after `setIndexStrategy`:

```typescript
  /** False while the installed strategy is the degraded UnavailableIndexStrategy (spec #280 Change 4). */
  isKeywordAvailable(): boolean {
    return !(this.indexStrategy instanceof UnavailableIndexStrategy);
  }
```

(import `UnavailableIndexStrategy` from `./search/UnavailableIndexStrategy`).

In `WikiMemory.ts`, replace `syncSearchIndex`:

```typescript
  async syncSearchIndex(entityId?: string): Promise<void> {
    if (entityId === undefined) {
      // A long-lived host that never re-opens still recovers from a failed init (spec #280 Change 4).
      if (!this.searchService.isKeywordAvailable()) {
        this.searchService.setIndexStrategy(await createIndexStrategy(
          this.db, this.prefix, this.metadataRepo, this.options.config?.indexStrategy ?? 'auto'));
      }
      return this.searchService.syncStale();
    }
    assertEntityId(entityId);
    return this.searchService.syncEntries(entityId, []);
  }
```

- [x] **Step 4: Run to verify pass** — run `createIndexStrategy.test.ts`, `searchUnavailable.test.ts`, `miniSearchFallback.test.ts`, `fts5IndexStrategy.test.ts`, `fts5Integration.test.ts`, `SearchService.test.ts` (if present), `incrementalSearchIndex.test.ts` — all PASS. Then typecheck.
- [x] **Step 5: Commit** — `fix(core): auto FTS init failures retry and degrade to UnavailableIndexStrategy, never detach (#280 RC-6)`

---

### Task A6: the six call sites (spec Change 3 call-site map; 7(e) heal/gate legs, 7(n), 7(n′), 7(o))

**Files:**
- Modify: `packages/core/src/services/RetrievalService.ts:221-224` (local catch at the `:223` `getKeywordScores` call)
- Modify: `packages/core/src/services/MaintenanceService.ts` (pre-check right after the `healCandidates.length === 0` early return, ~:818, before `findAllPending`)
- Modify: `packages/core/src/repositories/EntryRepository.ts` (add `hasStoredEmbedding`)
- Modify: `packages/core/src/services/librarian/ops/gate.ts` (export `gateNeedsKeyword`)
- Modify: `packages/core/src/services/librarian/ops/index.ts:30-37` (abort between `selectBatch` and `runExtract`)
- Test: `packages/core/__tests__/searchUnavailableCallSites.test.ts` (new)

**Interfaces:**
- Consumes: `SearchService.isKeywordAvailable()`, `WikiSearchUnavailableError`, `isWikiSearchUnavailableError` (A5).
- Produces:
  - `EntryRepository.hasStoredEmbedding(entityId: string): Promise<boolean>`;
  - `gateNeedsKeyword(deps, entityId: string): Promise<boolean>` (exported from `gate.ts`; `deps` typed exactly like `gateCandidates`' first parameter).

Sites `:189` (prefilter), `:550` and `:719` need NO code change: they already propagate through the `:668` catch → `onRetrievalFallback` → `:719` throw. They are pinned by tests only. `gate.ts:143` mid-pass needs no change either (the throw already aborts the pass with the watermark kept); it is pinned by a test.

- [x] **Step 1: Write the failing tests**

```typescript
// packages/core/__tests__/searchUnavailableCallSites.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiDiagnostic, WikiOptions } from '../src/types';

afterEach(() => vi.restoreAllMocks());
const P = 'llm_wiki_';
const vec = async (t: string) => (/apple/i.test(t) ? [1, 0, 0] : [0, 0, 1]);

async function wikiWith(options: Partial<WikiOptions>) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(Fts5IndexStrategy.prototype, 'init').mockRejectedValue(new Error('locked'));
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const generateText = vi.fn(async () => '{"facts":[],"tasks":[]}');
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText, ...(options.llmProvider ?? {}) },
    config: options.config,
    onDiagnostic: (d) => diagnostics.push(d),
    onRetrievalFallback: options.onRetrievalFallback,
  } as WikiOptions);
  await wiki.setup();
  await db.runAsync(`INSERT OR REPLACE INTO ${P}meta (key, value) VALUES ('embedding_dimension', '3')`);
  return { db, wiki, diagnostics, generateText };
}
async function factWithVec(db: ReturnType<typeof openTestDatabase>, id: string, title: string, v: number[], sourceType = 'user_stated') {
  await db.runAsync(
    `INSERT INTO ${P}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding_blob)
     VALUES (?, 'u', ?, 'b', '[]', 'inferred', ?, 1, 1, ?)`,
    [id, title, sourceType, new Uint8Array(new Float32Array(v).buffer)]);
}

describe('keyword outage call-site map', () => {
  it('(n′) hybrid blend (:223) degrades to vector-only results', async () => {
    const { db, wiki } = await wikiWith({ llmProvider: { embed: vec } as any });
    await factWithVec(db, 'f-apple', 'apple fruit', [1, 0, 0]);
    const r = await wiki.read('u', 'apple', { hybridWeight: 0.5 });
    expect(r.facts[0]?.id).toBe('f-apple');
  });

  it('(n) prefilter host (:189) propagates via the two-hop path and fires onRetrievalFallback', async () => {
    const onRetrievalFallback = vi.fn();
    const { db, wiki } = await wikiWith({ llmProvider: { embed: vec } as any, config: { preFilterLimit: 10 } as any, onRetrievalFallback });
    await factWithVec(db, 'f-apple', 'apple fruit', [1, 0, 0]);
    const embeddingLoad = vi.spyOn((wiki.__testAccess as any).entryRepo, 'findWithEmbeddingsByEntityIds');
    await expect(wiki.read('u', 'apple')).rejects.toMatchObject({ name: 'WikiSearchUnavailableError' });
    expect(onRetrievalFallback).toHaveBeenCalled();
    expect(embeddingLoad).not.toHaveBeenCalled(); // no full-candidate embedding load
  });

  it('keyword-only read (no embed provider) propagates (:550/:719)', async () => {
    const { wiki } = await wikiWith({});
    await expect(wiki.read('u', 'apple')).rejects.toMatchObject({ name: 'WikiSearchUnavailableError' });
  });

  it('(o) heal skips the LLM pass: one diagnostic, no generateText, no heal_checked_at stamps', async () => {
    const { db, wiki, diagnostics, generateText } = await wikiWith({});
    await factWithVec(db, 'c1', 'inferred thing', [0, 0, 1], 'librarian_inferred');
    await wiki.runHeal('u');
    expect(generateText).not.toHaveBeenCalled();
    expect(diagnostics.filter((d) => d.code === 'heal_skipped' && d.detail?.reason === 'keyword_search_unavailable')).toHaveLength(1);
    const row = await db.getFirstAsync<{ heal_checked_at: number | null }>(`SELECT heal_checked_at FROM ${P}entries WHERE id = 'c1'`);
    expect(row!.heal_checked_at).toBeNull();
  });

  it('(e-gate i) a pass that cannot need keyword mode RUNS during an outage', async () => {
    const { db, wiki, generateText } = await wikiWith({ llmProvider: { embed: vec } as any, config: { autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' } } as any });
    await factWithVec(db, 'f-apple', 'apple fruit', [1, 0, 0]);
    await db.runAsync(`INSERT INTO ${P}events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','apple',100)`);
    await wiki.runLibrarian('u').catch(() => {});
    expect(generateText).toHaveBeenCalled(); // extraction happened
  });

  it('(e-gate ii) a pass that could need keyword mode aborts before runExtract, watermark kept', async () => {
    const { db, wiki, generateText } = await wikiWith({ config: { autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' } } as any }); // no embed provider
    await db.runAsync(`INSERT INTO ${P}events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','apple',100)`);
    await wiki.runLibrarian('u').catch(() => {});
    expect(generateText).not.toHaveBeenCalled();
    expect(await (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u')).toBeNull();
  });

  it('(e-gate mid-pass) an embed failure routes a candidate into keyword mode at :143 → abort, watermark kept', async () => {
    // Embed provider present + stored vectors ⇒ the pre-check lets the pass run;
    // the candidate's embed then fails, gate.ts falls through to searchKeyword,
    // which throws WikiSearchUnavailableError and aborts the pass.
    const failingEmbed = async () => { throw new Error('embed down'); };
    const { db, wiki, generateText } = await wikiWith({ llmProvider: { embed: failingEmbed } as any, config: { autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' } } as any });
    await factWithVec(db, 'f-apple', 'apple fruit', [1, 0, 0]);
    await db.runAsync(`INSERT INTO ${P}events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','apple',100)`);
    generateText.mockResolvedValueOnce(JSON.stringify({ facts: [{ title: 'apple pie', body: 'b', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] }));
    await wiki.runLibrarian('u').catch(() => {});
    expect(generateText).toHaveBeenCalledTimes(1); // extraction only; no resolve call
    expect(await (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u')).toBeNull();
    expect((await db.getAllAsync(`SELECT 1 FROM ${P}entries`)).length).toBe(1); // no new rows
  });
});
```

Fixture facts (verified 2026-10-12):
- `onRetrievalFallback?: (error: Error) => void` is a top-level `WikiOptions` field (`types.ts:872`).
- Heal candidates are live, non-`immutable_document` rows with `heal_checked_at IS NULL OR ≤ cutoff` (`EntryRepository.ts:635-647`), so the `librarian_inferred` fixture row qualifies.
- If the ops pass needs `embedding_dimension` to match the stored vector length, the `wikiWith` helper already sets it to 3.

- [x] **Step 2: Run to verify failure** — expected FAIL on (n′), (o) and (e-gate ii). The other cases may already pass; they pin existing propagation and must stay green.
- [x] **Step 3: Implement**

`RetrievalService.ts` (the full-scan `else` branch):

```typescript
            if (weight !== undefined && weight < 1) {
              try {
                miniSearchScores = await this.searchService.getKeywordScores(trimmedQuery, scoredEntityIds);
              } catch (err) {
                // Keyword outage degrades the blend, not the read (spec #280 call-site map, :223).
                if (!isWikiSearchUnavailableError(err)) throw err;
                miniSearchScores = new Map();
              }
            }
```

(import `isWikiSearchUnavailableError` from `../types`).

`EntryRepository.ts`:

```typescript
  /** Whether the entity has at least one live row with a stored vector (librarian gate pre-check, spec #280). */
  async hasStoredEmbedding(entityId: string, tx?: SQLiteAdapter): Promise<boolean> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ one: number }>(
      `SELECT 1 AS one FROM ${this.prefix}entries
       WHERE entity_id = ? AND deleted_at IS NULL AND (embedding_blob IS NOT NULL OR embedding IS NOT NULL) LIMIT 1`,
      [entityId],
    );
    return row != null;
  }
```

`gate.ts` (exported next to `gateCandidates`; give `deps` the same type annotation `gateCandidates` uses):

```typescript
/**
 * Whether a gate pass for this entity could route a candidate into keyword
 * mode (gate.ts step 4): no embed provider, or no stored vectors to rank
 * against. An embed failure mid-pass is the remaining route; it surfaces as a
 * WikiSearchUnavailableError from searchKeyword and aborts the pass the same
 * way (spec #280 rev 10 M4).
 */
export async function gateNeedsKeyword(deps: Parameters<typeof gateCandidates>[0], entityId: string): Promise<boolean> {
  if (typeof deps.options.llmProvider.embed !== 'function') return true;
  return !(await deps.entryRepo.hasStoredEmbedding(entityId));
}
```

`ops/index.ts`, between the `sel.batch.length === 0` return and `let ex;`:

```typescript
  // Keyword outage: abort BEFORE paying for extraction, but only when this
  // pass could need keyword mode — an unconditional abort would stall the
  // librarian and hold back event pruning indefinitely (spec #280 rev 10 M4).
  // Throwing keeps the watermark, like resolve's transient-error abort.
  if (!deps.searchService.isKeywordAvailable() && (await gateNeedsKeyword(deps, entityId))) {
    throw new WikiSearchUnavailableError('librarian: keyword search unavailable and this pass may need it; retry the pass');
  }
```

(import `gateNeedsKeyword` from `./gate` and `WikiSearchUnavailableError` from `../../../types`. If `deps` lacks `searchService` at this point, check `gate.ts:142` — it uses `deps.searchService`, so the field exists on the same deps object.)

`MaintenanceService.ts`, immediately after the `if (healCandidates.length === 0) { … }` block:

```typescript
    // Keyword outage: heal anchors need keyword search (:1542), so skip the
    // LLM pass entirely — no spend, no mutation, no heal_checked_at stamps;
    // candidates stay unattempted (spec #280 call-site map). The orphan/stale
    // SQL passes above did run; sync their ids as the empty-candidate path does.
    if (!this.searchService.isKeywordAvailable()) {
      await this.searchService.syncEntries(entityId, Array.from(new Set([...orphanedIds, ...staleDowngradedIds])));
      this.searchService.evictCache(entityId);
      emitDiagnostic(this.options, { ...diagBase, code: 'heal_skipped', detail: { reason: 'keyword_search_unavailable', count: healCandidates.length } });
      const counts = await this.entryRepo.countHealCandidatesByEntityId(entityId, recheckCutoff);
      return {
        scanned: 0,
        downgraded: staleDowngradedIds.length,
        deleted: orphanedIds.length,
        newFactsCreated: 0,
        skipped: [], degraded: [], remaining: counts.eligible, deferred: counts.deferred,
      };
    }
```

Update the `heal_skipped` description in `utils/diagnostics.ts:50` to `'Heal skipped a candidate fact, or the whole LLM pass when keyword search is unavailable.'`.

- [x] **Step 4: Run to verify pass** — run `searchUnavailableCallSites.test.ts`, `hybridScoring.test.ts`, `opsLibrarian.test.ts`, `healAnchorBounding.test.ts`, `healBounding.test.ts`, `diagnosticsMaintenance.test.ts`, `embeddingRetrieval.test.ts` — all PASS. Then typecheck.
- [x] **Step 5: Commit** — `fix(core): pin keyword-outage behavior at all six search call sites (#280 RC-6)`

---

### Task A7: docs + full-suite gate

**Files:**
- Modify: `packages/core/src/types.ts:330-342` (`indexStrategy` doc)
- Modify: `packages/core/src/WikiMemory.ts` (JSDoc on `setup`)
- Modify: `packages/core/README.md` (or the package's existing configuration doc — find it with `grep -rln "indexStrategy" packages/core/*.md docs/ 2>/dev/null`)

- [x] **Step 1:** Replace the last paragraph of the `indexStrategy` doc:

```typescript
   * FTS5 keeps its index inside the database file, fed by triggers on the
   * entries table, so memory stays flat at any size. If FTS5 init fails
   * transiently under 'auto', setup() retries once and then completes with
   * keyword search unavailable (queries throw WikiSearchUnavailableError);
   * it never demotes to MiniSearch. MiniSearch is used only when pinned or
   * when the SQLite build lacks FTS5/json1 — and it holds all entry text in
   * the JS heap: the measured ceiling is ~1M entries on a default Node heap
   * (raise --max-old-space-size for larger stores).
```

- [x] **Step 2:** Add JSDoc above `setup(opts?)`:

```typescript
  /**
   * Opens the store: schema migrations, one-time source_ref normalize, and
   * the keyword index. On an up-to-date store this does only index probes.
   * Pass `{ migrations: 'refuse' }` from inside a writer lease: pending
   * one-time work then throws WikiMigrationRequiredError before any mutation,
   * and the host runs a plain `setup()` outside the lease.
   */
```

- [x] **Step 3:** Add a "Opening inside a writer lease" subsection to the package doc with the host procedure from spec Change 1 (open with `'refuse'` → on `WikiMigrationRequiredError` release the lease → run `setup()` out of lease → re-open).
- [x] **Step 4:** Run the full core suite (gate per Global Constraints vs the Task A0 baseline), typecheck, then `pnpm -r build`. All clean.
- [x] **Step 5: Commit** — `docs(core): document the migration gate and the MiniSearch memory ceiling (#280)`

---

### Task A8 (DEFERRED, rev 7a — not a PR-A merge gate): measurements, spec record

**Rev 7 rewrite.** The original A8 assumed a sandbox (`.sandbox/profile-setup.ts`, a 1M store under `$HOME/issue280-stores`) that only existed on the investigation machine and was never committed. The maintainer authorized proceeding without it (2026-10-13). This task builds a committed replacement, then measures on whatever machine runs it, and records the machine honestly. Numbers from this machine are NOT comparable to the investigation's NVMe ThinkPad rows; never present them as such.

**Files:**
- Create: `bench/issue280/makeStore.ts` — builds a synthetic store.
- Create: `bench/issue280/profileSetup.ts` — times `setup()` legs.
- Create: `bench/issue280/README.md` — how to run, and the measured-machine table.
- Modify: the spec (rev 12 append only), PR #281 title.

**Global rules for A8:**
- Stores go under `ISSUE280_STORE_DIR` (default `$HOME/issue280-stores`). Never `/tmp` (tmpfs undercounts disk cost 2–3×, investigation §2.1). Never commit a `.db` file.
- Run with `node --experimental-strip-types` or `pnpm dlx tsx` against the BUILT core (`pnpm -r build` first; import from `packages/core/dist`), with `better-sqlite3` from the workspace. Use `openTestDatabase`'s adapter shape from `packages/core/__tests__/helpers/sqliteAdapter.ts` but on a FILE path, not `:memory:` (copy the adapter into `bench/issue280/adapter.ts`; do not import from `__tests__`).
- Record for every run: CPU model, OS, disk type (NVMe/SATA/APFS SSD), Node version, `better-sqlite3` version, entry count, `.db` file size.
- If any number misses its target, DO NOT tune code to hit it. Record it and stop; report to the maintainer.

- [ ] **Step 1: `makeStore.ts`.** Args: `--entries N` (default 1,000,000), `--out <path>`. Steps:
  1. Open the file DB, `PRAGMA journal_mode=WAL`, construct `WikiMemory` with `indexStrategy: 'fts5'` and a stub `llmProvider` (`generateText: async () => '{}'`), `await setup()` (fresh store: stamp + v14 index written).
  2. Insert N rows directly into `llm_wiki_entries` in transactions of 10,000, ~1.1 KB per row to match the investigation's 1.12 GB @1M: `id` = `f<i>`, `entity_id` = `e<i % 100>`, `title` = 40 chars, `body` = ~1,000 chars of word-like text (seeded PRNG, fixed seed `280`), `source_ref` = **`dir/<i>.md`** for 50% of rows (violating — contains `/`) and `<i>.md` for the rest, `created_at`/`updated_at` = `Date.now()`. Look up the exact required columns with `PRAGMA table_info(llm_wiki_entries)` and fill every NOT NULL column.
  3. Also insert N/10 `llm_wiki_source_ref_index` rows, 50% with a `/` in `source_ref`.
  4. Run one plain `setup()` so FTS is `live` and the store is stamped, then `PRAGMA wal_checkpoint(TRUNCATE)`. Print entry count and file size.
  Verify: `--entries 10000` finishes in seconds and a second `setup()` on it returns without error.
- [ ] **Step 2: `profileSetup.ts`.** Args: `--store <path>`, `--leg <warm|normalize|gate>`. Each leg works on a COPY of the store (`fs.copyFileSync` of `.db`, after checkpoint) so legs don't contaminate each other. Use `performance.now()`.
  - `warm`: open + `setup()` on the stamped store, 5 runs, report each and the median. Cold-cache variant: on Linux `sync; echo 3 | sudo tee /proc/sys/vm/drop_caches` before each run; on macOS `sudo purge`. If sudo is unavailable, report "cold: not measured" — never fake it.
  - `normalize`: `DELETE FROM llm_wiki_meta WHERE key='source_ref_normalize_stamp'`, then time `setup()`. Also report rows/s (entries + source_ref_index rows ÷ normalize wall) and max chunk-tx commit time: wrap the adapter's `withTransactionAsync` to time each call and report the max.
  - `gate`: delete the stamp on a fresh copy, time `setup({ migrations: 'refuse' })` until it throws `WikiMigrationRequiredError`; assert the stamp is still absent afterwards.
  Verify on a 10k store first: all three legs run and print numbers.
- [ ] **Step 3: Run @1M.** `makeStore --entries 1000000`, then each leg. Targets (spec Acceptance 1): warm ≤ 1 s, cold ≤ 3 s; gate-trip ≪ 1 s. Normalize has no target — it is the measurement Acceptance 6 needs. Put all results and the machine description in `bench/issue280/README.md`.
- [ ] **Step 4 (MAINTAINER — do not attempt): ARM64 + 52.9 MB leg.** The #280 objective also requires `setup()` remeasured on the original 52.9 MB store on the ARM64 target. Write the exact commands into the README for the maintainer and mark this leg "pending maintainer" in the spec record. Do not substitute a local run for it.
- [ ] **Step 5: Commit** — `git add bench/issue280 && git commit -m "test(core): committed issue280 setup() benchmark harness (#280 A8)"` (no `.db` files: check `git status` first).
- [ ] **Step 6: Spec rev 12.** Append (never rewrite earlier text) a rev 12 entry to the spec Status line and a "PR-A measurements" subsection: the machine table; warm/cold medians @1M vs targets; normalize wall, rows/s, max chunk-tx ms; gate-trip wall; Acceptance 6 derivation input = normalize@1M × 4.2 (state it is extrapolated); ARM64 leg = pending maintainer. Commit `docs(spec): issue280 rev 12 - PR-A measurements`.
- [ ] **Step 7: PR #281.** `gh pr edit 281 --title "perf(core): warm-open survival scans, migration gate, RC-6 guard (#280 PR-A)"`. Check `gh pr view 281 --json body -q .body | grep -Ei "fixes|closes"` prints nothing. Push, then `gh pr checks 281` — all green (never claim green without checking).
- [ ] **Step 8: STOP.** Do NOT run `gh pr ready 281` and do not merge. Report the numbers and whether Acceptance 1 targets were met; readiness is the maintainer's call (pending the ARM64 leg). Merge commits only, never squash.

---

# Track PR-B — FTS state machine (`Fixes #280`)

**Why this track is task-level only:** PR-A rewrites `setup()`, `createIndexStrategy`, `SearchService` and `syncSearchIndex`, so PR-B line numbers and some signatures are only knowable on post-merge `main`. Task B0 re-expands B1–B8 into full TDD steps as **plan rev 7** before any PR-B code is written. Everything below is binding scope; the step-level code comes in rev 7.

### Task B0 (controller): branch + plan rev 7

- [ ] After PR-A merges: `git switch main && git pull && git switch -c feat/issue280-fts-state-machine`.
- [ ] Re-read the spec's Normative summary "PR-B contract" + Change 3 + DDL note (rev 11 rename-retire). Expand B1–B8 below into full steps (failing test code, implementation code, commands) against current source. Commit as plan rev 7: `docs(plan): issue280 rev 7 - expand PR-B track`.

### Task B1: `drain` interface, budget, write-turn caps, schema v15

- **Scope:** add `setupBudgetMs?: number` (default 1500, exported `DEFAULT_SETUP_BUDGET_MS`) and the drain interface.
  - **`Fts5IndexStrategy.drain(opts?: { deadline?: number; mode?: 'ledger' | 'full'; ids?: readonly string[]; entityId?: string })`.**
  - **Ids first, to completion:** `SELECT id FROM fts_pending WHERE id IN (SELECT value FROM json_each(?))`, ≤500 ids per tx.
  - **Entity target with empty ids:** `fts_pending WHERE entity_id = ? ORDER BY seq`, ≤500 per tx; counts as foreign.
  - **Write turns** (`syncEntries`, `sync(id)`) use `mode: 'ledger'`: own ids plus at most ONE foreign chunk.
  - **Full quanta** (`setup()`, no-arg `syncSearchIndex()`) drain the ledger until the deadline.
  - **Deadline:** one `openDeadline` captured at `setup()` start and threaded into `sync({ deadline })`; never re-budget per turn.
  - **Schema v15:** `MIGRATIONS[15].run` creates `fts_pending(id)` and `fts_pending(entity_id)` indexes. Not in `setupDatabase`.
  - `SearchService.sync(entityId?, opts?: { deadline?: number })` keeps the `ImportExportService.ts:452` call compiling.
- **Tests:** 7(i) arbitration order; 7(m) read-your-writes under a 5k backlog; a write turn under a 5k backlog drains ≤ own ids + 500; `setupBudgetMs: 1` converges across calls; v15 is covered by the migration gate (`'refuse'` on a v14 store throws).

### Task B2: `init()` state machine (no rebuild)

- **Scope:**
  - **Read-only probes first:** state, `triggersPresent()`, the `entries_fts_docsize` vs `fts_map` count, and the max-rowid check (`SELECT rowid FROM entries_fts ORDER BY rowid DESC LIMIT 1` ≤ `coalesce(max(fts_map.fts_rowid), 0)`).
  - **Keep-map re-arm tx:** create triggers, `DELETE FROM fts_pending`, keep `fts_map` + `entries_fts`, reset the watermark + fingerprint + sweep cursor, snapshot `max(entries.rowid)` + `max(fts_map.fts_rowid)`, set state `rebuilding`.
  - **Transition table:** implement every row exactly (incl. the live-row + empty-map + empty-ledger case).
  - **Fresh-store flag:** plumb `entriesExisted` from `setup()` → `createIndexStrategy` → `init(opts?: { entriesExisted?: boolean })`.
  - **Resume:** on resume, re-verify triggers; missing ⇒ restart.
  - **Detach guard:** the deferred-detach cleanup no-ops on `rebuilding`.
  - **Delete dead code:** `rebuildSql` (export + tests), `rebuildInTx`, `rebuildFromSource` (method, interface member, tests).
- **Tests:** 7(g) marker loss + trigger loss → `rebuilding` with triggers present and no DDL change; the consistency-check cases (ghost rowid beyond the map; count mismatch; map missing while FTS has rows) take the reset path; 7(f) detached under `'minisearch'` stays detached, under `'auto'`/`'fts5'` re-attaches; fresh vs pre-FTS store.

### Task B3: windows, fingerprint, completion, orphan sweep

- **Scope:**
  - **`windowChunkSql(p)`:** 4 statements bound to `chunkIds = SELECT id FROM entries WHERE rowid > ? AND rowid <= ?`:
    1. delete FTS rows via the map;
    2. delete map rows;
    3. insert map rows for live ids;
    4. insert FTS rows.
    It never touches `fts_pending`.
  - **Window bound:** `hi` = max rowid over the next ≤500 existing rows; fingerprint = id at `hi`; the watermark and fingerprint advance in the same tx.
  - **Re-anchor:** `EntryRepository.ts:816`'s hard delete re-anchors the fingerprint in the same tx when it deletes the fingerprint row. A missing fingerprint at check time ⇒ restart.
  - **Orphan sweep:** one bounded tx per full quantum, `DELETE … WHERE fts_rowid > ? AND fts_rowid <= ? AND NOT EXISTS (SELECT 1 FROM entries WHERE entries.id = fts_map.id)` (+ the matching `entries_fts` rows), cursor advanced in the same tx.
  - **Flip tx:** checks watermark ≥ snapshot AND cursor ≥ sweep snapshot AND residual ledger ≤ 1 chunk, drains that residual, then sets `live`.
  - **Full-quantum order:** ledger → ≥1 window (unless the deadline was overrun) → sweep tx.
- **Tests:** 7(a) concurrent writer exactly-once incl. drain-before-window; 7(j) resume from watermark K exactly-once; prune deletes the fingerprint row → re-anchored, no restart; manual rowid change → restart; 7(g′) orphan case; flip under a steady trickle of writes still happens; state gate (a `live` store never reads the watermark).

### Task B4: rename-retire + corruption repair + gate `retiredTables`

- **Scope:**
  - **Reset path:** `ALTER TABLE ${p}entries_fts RENAME TO ${p}entries_fts_retired_<n>` (`<n>` from a meta counter; names appended to the meta JSON list `fts5_retired_tables`), then CREATE empty, clear `fts_map` + `fts_pending`, then the re-arm. RENAME failure ⇒ DROP fallback.
  - **Reclamation in full quanta, after the sweep:**
    - (1) chunked `DELETE … WHERE rowid IN (SELECT rowid FROM <retired> ORDER BY rowid LIMIT 500)`;
    - (2) bounded `INSERT INTO <retired>(<retired>, rank) VALUES('merge', N)` until `total_changes()` is unchanged;
    - (3) `DROP TABLE`, then remove it from the list.
  - **Corruption-class init error:** `SQLITE_CORRUPT_VTAB` / code 267, or an error from FTS-only statements, ⇒ reset path. Generic `SQLITE_CORRUPT` from `entries` ⇒ `UnavailableIndexStrategy`. This applies under pinned `'fts5'` too.
  - **`probePendingWork`:** counts `fts5_retired_tables` entries only when reclamation is handed off (decided by the B8 measurement; until then `retiredTables` stays 0).
- **Tests:** 7(u)(i)–(iv); 7(e) corrupt-FTS leg; tokenizer mismatch takes the reset path; marker loss does not.

### Task B5: id threading

- **Scope:**
  - `upsertGraph` stashes `params.nodes[].id` per entity (capped; overflow ⇒ entity-targeted drain), in place of the `markStale` call at `WikiMemory.ts:845`.
  - `syncSearchIndex(entityId)` drains that entity's stash first.
  - No-arg `syncSearchIndex()` drains ALL stashed ids first, then runs the quantum, and clears what it drained.
  - `importDump(merge=false)` passes upserted + soft-deleted ids into the sync call (`ImportExportService.ts:452`), and the comment at :444-448 is updated.
  - Update the `upsertGraph` and `syncSearchIndex` docs to state the bounded-sync contract for both forms.
- **Tests:** 7(r) via both forms under a 5k backlog; 7(m′) `merge=false` import of 2k facts under a 5k foreign backlog → all searchable on return.

### Task B6: VACUUM reset (rebuild side)

- **Scope:** `MetadataRepository.vacuum()` (already clearing the normalize watermarks since A3) also resets the rebuild watermark, fingerprint and sweep cursor when state is `rebuilding` (restart from 0).
- **Tests:** 7(k) including in-process `runPrune({ vacuum: true })` followed by `syncSearchIndex()` in the same process → completes exactly-once.

### Task B7: integration acceptance + full-suite gate

- Promote the leg harness to integration tests: 7(j), 7(g), 7(a) on a ≥2k-row store; rewrite `createIndexStrategy.test.ts`'s remaining old-rebuild assertions; full suite, typecheck, build. Commit body lists every rewritten test.

### Task B8 (controller): measurements, sign-off, PR-B

- @1M: keep-map window rate (the spec's ≤3.5 s claim is extrapolated until this is measured) and the rename-retire reclamation profile (rename, per-step delete/merge, final DROP). Apply the reclamation rule: bounded ⇒ in-quantum; not bounded ⇒ hand-off via `retiredTables` (finish Task B4's last bullet).
- ~4.7 GB NVMe legs (background, ~30–45 min each): steady-state fence (Acceptance 4), crash backlog (5), first-migration open (6), and the largest observed chunk commit time.
- Record the SynapseTree host-contract sign-off (scheduled no-arg `syncSearchIndex()` + `migrations: 'refuse'` procedure) in the spec review log; spec rev 13 with all numbers.
- Open PR-B with `Fixes #280`; CI green; ready; merge is the maintainer's call.

---

## Interfaces (cross-task contracts)

| Name | Defined in | Consumed by |
|---|---|---|
| `normalizeSourceRef` (fixed point) | A1 `utils/pure.ts` | A3 |
| `legacySourceTypeIndexDdl(prefix)` | A2 `db/schema.ts` | A2 (v14, fresh path) |
| `SOURCE_REF_NORMALIZE_ALG`, `NORMALIZE_STAMP_KEY`, `ENTRIES_WM_KEY`, `SRI_WM_KEY`, `stampMatches`, `writeNormalizeStamp`, `runSourceRefNormalize` | A3 `db/sourceRefNormalize.ts` | A3, A4, `MetadataRepository.vacuum` |
| `readSchemaVersion`, `probePendingWork`, `PendingMigrationWork` | A4 `db/migrationGate.ts` | A4, B4 |
| `WikiSetupOptions`, `WikiMigrationRequiredError` | A4 `types.ts` | A4, hosts |
| `WikiSearchUnavailableError`, `isWikiSearchUnavailableError` | A5 `types.ts` | A5, A6 |
| `UnavailableIndexStrategy` | A5 | A5, `SearchService.isKeywordAvailable` |
| `SearchService.isKeywordAvailable()` | A5 | A5 (`syncSearchIndex`), A6 (heal, ops pass) |
| `FTS5_INIT_RETRY_MS` | A5 `createIndexStrategy.ts` | tests |
| `EntryRepository.hasStoredEmbedding` | A6 | A6 `gateNeedsKeyword` |
| `gateNeedsKeyword` | A6 `librarian/ops/gate.ts` | A6 `ops/index.ts` |
| `drain({ deadline, mode, ids, entityId })`, `DEFAULT_SETUP_BUDGET_MS`, `windowChunkSql`, retired-table meta keys | B1–B4 (rev 7) | B-track |
