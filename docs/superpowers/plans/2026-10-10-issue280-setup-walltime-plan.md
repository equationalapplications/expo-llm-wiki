# Issue #280 `setup()` Wall Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** rev 8 (2026-10-13) — PR-A merged (`459b84e`, PR #281). Task B0 done: Track PR-B expanded into full TDD steps against post-PR-A `main` on `feat/issue280-fts-state-machine`, and every cited path, line and signature re-checked (B0 findings D1–D11, F1–F13; F1, F3, F5, F6, F7, F8 and F12 need a maintainer decision before the affected task runs). The new baseline is 176 files / 1904 tests. This expansion is numbered rev 8 because rev 7/7a was already used by the PR-A handoff (Task B0's "plan rev 7" text predates that). Resume at Task B1. rev 7 (2026-10-13) — PR-A tasks A0–A7 DONE and ticked; Task A8 rewritten so it can run without the original sandbox machine (see "Resume here" and Task A8). rev 6 — written fresh against **spec rev 11** (`cfb56fe`). Rev 5 mirrored spec rev 7 and is RETIRED in full; nothing below inherits from it. Two tracks: **PR-A** (fully expanded, execute now) and **PR-B** (task-level, re-expanded as plan rev 7 in Task B0 against post-PR-A `main`, because PR-A moves the code PR-B edits).

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

## Resume here (rev 8, 2026-10-13) — start at Task B4 (B3 done, commit 9074cb5)

- **PR-A is merged:** PR #281 → `main` as merge commit `459b84e`. Issue #280 is open again (a stray closing keyword in commit `cfb56fe` had auto-closed it). Only PR-B's PR body may say `Fixes #280`. No commit message may contain a closing keyword followed by an issue number.
- **Branch:** `feat/issue280-fts-state-machine`, cut from `main` @ `459b84e`. It is not pushed and has no PR yet. Its only commit so far is this plan (rev 8).
- **Baseline (B0, on `459b84e`):** core suite **176 files / 1904 tests, 0 failures**; `typecheck` exit 0.
- **Next:** Task B4 (B1-B3 done). B2 needs F3 and F12 (approved 2026-10-13), B4 needs F1 and F7, B5 needs F5 and F6, B8 needs F8.
- **Ignore** `.superpowers/sdd/2026-10-10-issue280-setup-walltime-plan/NEXT_SESSION_HANDOFF.md`: it is stale (it says A2–A7 failed; all of them shipped).
- Task A8 (measurements) is still deferred. B8 needs its harness (F10).
- The rev 7 block below is historical.

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

**Rev 8 note (2026-10-13):** the expansion above was committed as **plan rev 8** (rev 7/7a was taken by the PR-A handoff). Each task below keeps its rev-6 **Scope**/**Tests** bullets verbatim (still binding), then adds "Rev 8 source check" and step-level TDD. Where rev 8 had to read or extend the scope, it says so under "Rev 8 findings" and in the B0 findings list; it never silently narrows scope.

## PR-B file map (rev 8, verified against `main` @ `459b84e`)

| File | Responsibility | Tasks |
|---|---|---|
| `packages/core/src/utils/monotonicNow.ts` (new) | `monotonicNow()` moved out of `WikiMemory.ts:65-66` so the strategy and `setup()` share one clock | B1 |
| `packages/core/src/utils/setupDefaults.ts` (new) | `DEFAULT_SETUP_BUDGET_MS = 1500` | B1 |
| `packages/core/src/index.ts` | export `DEFAULT_SETUP_BUDGET_MS` | B1 |
| `packages/core/src/types.ts` | `WikiConfig.setupBudgetMs` (next to `migrations`, `:386-394`); third `PendingMigrationWork` variant only if B8 hands reclamation off | B1, B8 |
| `packages/core/src/services/search/IndexStrategy.ts` | `DrainOptions`; `drain?(opts?)`; delete `rebuildFromSource?` (`:130-131`) | B1, B2 |
| `packages/core/src/services/search/fts5Sql.ts` | `idDrainChunkSql`, `entityDrainHiSql`/`entityDrainChunkSql`, `fts5PendingIndexesDdl`, rebuild meta keys, `windowHiSql`/`windowChunkSql`, `sweepHiSql`/`sweepChunkSql`, retired-table keys; delete `rebuildSql` (`:84-92`) | B1–B4 |
| `packages/core/src/services/search/fts5Progress.ts` (new) | `writeRebuildStart`, `readRebuildProgress`, `reanchorRebuildFingerprint`, `restartRebuildAfterVacuum` | B2, B3, B6 |
| `packages/core/src/services/search/Fts5IndexStrategy.ts` | budgeted `drain(opts)`, `init(opts)` state machine, windows/sweep/flip, rename-retire, reclamation, corruption repair; delete `rebuildFromSource` (`:40-42`) + `rebuildInTx` (`:141-145`) | B1–B4 |
| `packages/core/src/services/search/UnavailableIndexStrategy.ts` | `drain(_opts?: DrainOptions)` | B1 |
| `packages/core/src/services/search/createIndexStrategy.ts` | `opts?: { setupBudgetMs?; entriesExisted? }` threaded into the strategy | B1, B2 |
| `packages/core/src/services/SearchService.ts` | `drainTurn(entityId, opts)`; `sync(entityId?, opts?)`, `syncEntries`, `syncStale(opts?)` pass modes/ids/deadline | B1, B5 |
| `packages/core/src/db/migrations.ts` | `MIGRATIONS[15]` (fts_pending indexes, only where the ledger exists) | B1 |
| `packages/core/src/WikiMemory.ts` | `openDeadline`, budget plumbing, `entriesExisted` plumbing, upsert id stash, `syncSearchIndex` stash drain, docs | B1, B2, B5 |
| `packages/core/src/repositories/EntryRepository.ts` | `bulkDeletePruned` (`:813-845`) re-anchors the fingerprint in-tx | B3 |
| `packages/core/src/services/ImportExportService.ts` | `:444-453` merge=false passes touched ids | B5 |
| `packages/core/src/services/MaintenanceService.ts` | `runPrune` vacuum branch (`:346-350`) restarts a `rebuilding` index | B6 |
| `packages/core/src/db/migrationGate.ts` + `sourceRefNormalize.ts` | retired-table pending work, only on hand-off | B8 |

---

### Task B0 (controller): branch + plan rev 7

- [x] After PR-A merges: `git switch main && git pull && git switch -c feat/issue280-fts-state-machine`.
- [x] Re-read the spec's Normative summary "PR-B contract" + Change 3 + DDL note (rev 11 rename-retire). Expand B1–B8 below into full steps (failing test code, implementation code, commands) against current source. Commit as plan rev 7: `docs(plan): issue280 rev 7 - expand PR-B track`.

**Rev 8 record (2026-10-13):** done on `feat/issue280-fts-state-machine` cut from `main` @ `459b84e` (PR-A merge). Committed as **plan rev 8** with `docs(plan): issue280 rev 8 - expand PR-B track`. Baseline on `459b84e`: core suite **176 files / 1904 tests, 0 failures**; `typecheck` exit 0. This supersedes the rev-7 "Resume here" baseline (1891).

**B0 findings (plan vs source, and plan vs spec) — report to the maintainer; F1, F3, F5, F6, F7, F8 need a decision before the affected task runs:**

- **Source drift (plan text wrong, expansion uses current source):**
  - D1. `markStale` in `upsertGraph` is at `WikiMemory.ts:900` (not `:845`); `upsertGraph` spans `:855-903`, its doc `:812-854`; `syncSearchIndex` is `:709-744`, its doc `:680-708` (spec's `:765-768` is stale).
  - D2. `bulkDeletePruned` is `EntryRepository.ts:813`, its DELETE `:826` (plan said `:816`); its only caller is `MaintenanceService.ts:302` (spec said `:301`). Grep confirms it is the ONLY hard delete of `entries` in `src/`.
  - D3. `ImportExportService.ts:452` (`sync(entityId)`), the `:444-448` comment and the merge path `:450` are unchanged. Touched-id sets: `upsertedFactIds` (`:132`) and `softDeletedFactIds` (`:136`), both in `doImportEntity`.
  - D4. Dead code: `rebuildSql` (`fts5Sql.ts:84-92`; test `fts5Sql.test.ts:3,51`), `rebuildInTx` (`Fts5IndexStrategy.ts:141-145`, called `:34`), `rebuildFromSource` (`Fts5IndexStrategy.ts:40-42`, interface `IndexStrategy.ts:130-131`). **No test references `rebuildFromSource`** (B2 said "method, interface member, tests") and nothing in `src/` calls it.
  - D5. B6 says `MetadataRepository.vacuum()` already clears the normalize watermarks. False: PR-A deviation 3 put that in `MaintenanceService.runPrune` (`:346-350`, `resetNormalizeWatermarks` then `metadataRepo.vacuum()`). B6 targets `runPrune`. The PR-A file map row for `MetadataRepository.ts` is stale for the same reason.
  - D6. Interfaces table: `EntryRepository.hasStoredEmbedding` does not exist. The shipped ops gate is `gateNeedsKeyword` (`gate.ts:112`), using private `loadStoredVectors` (`gate.ts:90`) and `EntryRepository.hasLiveEntry` (`:152`). Also `readSchemaVersion` shipped as `detectSchemaVersion`, and `probePendingWork` lives in `db/sourceRefNormalize.ts:104` (`db/migrationGate.ts` holds `setupDatabaseWithGate`).
  - D7. `SearchService.drainTurn` (`:108-122`) calls `drain!()` with no arguments, and `syncEntries` under a drain strategy discards its ids (`:183`). `markStale` no-ops under drain at `:249` (spec cites `:243`). Spec's `SearchService.ts:96-116` reference is stale.
  - D8. `createIndexStrategy` is the 2-try loop at `:91-105` (`FTS5_INIT_RETRY_MS` `:12`); `detachFts5` runs only for pinned `'minisearch'` (`:74`) and module-absent (`:87`). `UnavailableIndexStrategy.search` returns `[]` for empty `entityIds` (`:19`). No-arg `syncSearchIndex()` re-init uses `monotonicNow()` with 5 s→5 min doubling backoff (`WikiMemory.ts:55-66`, `:715-737`); its success path calls `searchService.sync()` (a full quantum after B1).
  - D9. The tokenizer regex the spec cites at `WikiMemory.ts:277` now lives in `detectSchemaVersion` (`sourceRefNormalize.ts:59`). `init()` has no tokenizer check today; B4 adds one.
  - D10. `createIndexStrategy.test.ts` no longer asserts `'detached'` after an `auto` fallback (spec acceptance 8's `:69,89`); PR-A rewrote those to assert `'live'` (`:64`, `:91`). What B2/B7 must rewrite instead: every fixture that calls `createIndexStrategy`/`init()` on a `setupDatabase`-only store and expects `'live'` (it becomes `rebuilding` without `entriesExisted: false`), and the `fts5IndexStrategy.test.ts` `init` block (`:33-71`).
  - D11. No PR-B task touches `runPendingMaintenance` or the ops gate; PR-A's changes there need nothing from PR-B.
- **Plan vs spec (spec wins; decision needed where marked):**
  - **F1 (decision).** B4's last bullet and spec 7(u)(iv) say the gate reports `retiredTables > 0`. The spec's normative "Shipped gate contract" (rev 11a) says PR-B adds a **third `PendingMigrationWork` variant** instead. The expansion follows the spec, but the spec gives no name or shape. Proposed: `{ type: 'fts_retired_tables'; tables: number }`. It only ships if B8's measurement says hand-off.
  - F2. Plan B1 assigns 7(i) (drain before rebuild within a quantum) to B1, but rebuild chunks don't exist until B3. The expansion tests the "write turns stay drain-only" leg in B1 and moves the arbitration-order leg to B3.
  - **F3 (decision).** B2 ("no rebuild") alone cannot converge rows that existed before init, so B2 must rewrite the fixtures that relied on init's single-tx rebuild. One integration test (`fts5Integration.test.ts:71-82`, re-attach hits) can only assert `rebuilding` until B3 lands. The expansion does that and B3 restores it. Alternative: run B2+B3 as one review gate.
  - F4. `MIGRATIONS[15]` cannot index `fts_pending` on a store with no ledger (MiniSearch, detached, or never FTS-initialised). The expansion creates the indexes in v15 only when `fts_pending` exists, and in `init()`'s create/re-arm/reset transactions together with the table. Fresh stores never run v15 (they are stamped `CURRENT` directly). The fast path never runs index DDL. This is an addition to the spec's "v15 creates them", not a contradiction.
  - **F5 (decision).** Spec/plan: the stash goes "in place of" `markStale`. Removing `markStale` breaks MiniSearch hosts, because it IS their upsertGraph sync path (and is already a no-op under a ledger strategy). The expansion keeps `markStale` and adds the stash.
  - **F6 (decision).** The spec fixes `SearchService.sync(entityId?, opts?: { deadline? })` and says `importDump(merge=false)` passes its touched ids "into the sync call". Doing both needs `opts.ids`. The alternative, switching to `syncEntries`, gives MiniSearch the chunked id-read cost the `:444-448` comment avoids. The expansion adds `ids?` to `sync`'s opts.
  - **F7 (decision).** Corruption scope. The expansion reads "an error from FTS-only statements ⇒ reset path" as an SQLITE_CORRUPT-class code from an FTS-only statement, or SQLITE_CORRUPT_VTAB (extended code 267) from anywhere. A transient BUSY/IOERR from an FTS-only statement keeps retry→`UnavailableIndexStrategy`. A `live` fast path also gains one FTS-only seek (`SELECT rowid FROM entries_fts ORDER BY rowid DESC LIMIT 1`, O(log n)); otherwise a live store never touches FTS in `init()` and the repair could never trigger.
  - **F8 (decision).** The spec caps the sweep at ≤ one bounded tx per full quantum, and the plan bounds each tx to a window of ≤500 `fts_map` rows. At 1M map rows that is ~2000 full quanta before the flip can happen, so the sweep, not the windows, gates convergence. The expansion implements the spec as written (`FTS5_SWEEP_CHUNK = 500`). Recommend allowing sweep txs to repeat until the deadline (still each bounded), or a larger scan window; decide before B8 measures.
  - F9. "Watermark ≥ snapshot" can never hold if the rows nearest the snapshot were hard-deleted, because a window's `hi` lands only on existing rows. The expansion's window tx sets `wm = { rowid: snapshot, id: null }` when no rows remain in `(wm, snapshot]`.
  - F10. B8's @1M measurements need A8's `bench/issue280` harness, which is deferred and not on `main`. B8 Step 1 builds it first (A8 Steps 1–2).
  - F11. `setupBudgetMs` validation (non-finite or ≤ 0 ⇒ `TypeError`, before any probe) is not in the spec; it was added for fail-closed parity with the `migrations` policy check.
  - F12. Plan B2's "detach guard: the deferred-detach cleanup no-ops on `rebuilding`" (spec review-log M5) has no target on `main`, because PR-A never added a deferred detach. `detachFts5` runs only for pinned `'minisearch'`, where the transition table REQUIRES `rebuilding → detached`, and for module-absent. The expansion adds a regression test pinning that behavior and no guard code; confirm.
  - F13. The reclamation `merge` page count N is unspecified. The expansion uses `FTS5_RECLAIM_MERGE_PAGES = 500`, to be tuned by B8.

---

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

**Rev 8 source check:** `Fts5IndexStrategy.drain()` (`:44-56`) loops `drainHiSql`/`drainChunkSql` to empty, with no options. `SearchService.drainTurn` (`:108`) passes nothing. `setup()` (`WikiMemory.ts:290-342`) calls `searchService.sync()` at `:341`. `WikiConfig.migrations` is at `types.ts:394`; `setupBudgetMs` goes next to it. `monotonicNow` is module-private at `WikiMemory.ts:65-66`. `CURRENT_SCHEMA_VERSION` derives from `MIGRATIONS` (`migrations.ts:379`), so v15 moves it to 15 and the gate covers it with no gate change. No test pins `14` as the current version (they compare against `CURRENT_SCHEMA_VERSION`).

**Rev 8 findings:** F2 (the 7(i) arbitration leg moves to B3), F4 (v15 only where the ledger exists), F11 (budget validation). Between B1 and B5 in this same PR, `importDump(merge=false)` drains one entity chunk instead of its whole touched set. B5 closes that.

**Interfaces:**
- Produces: `DrainOptions { deadline?: number; mode?: 'ledger' | 'full'; ids?: readonly string[]; entityId?: string }` (`IndexStrategy.ts`); `IndexStrategy.drain?(opts?: DrainOptions)`; `Fts5IndexStrategy` constructor `(db, prefix, metadataRepo, budgetMs = DEFAULT_SETUP_BUDGET_MS)`; `createIndexStrategy(db, prefix, metadataRepo, preferred, opts?: { setupBudgetMs?: number })`; `SearchService.sync(entityId?: string, opts?: { deadline?: number })`; `fts5PendingIndexesDdl(p)`, `idDrainChunkSql(p)`, `entityDrainHiSql(p)`, `entityDrainChunkSql(p)`; `monotonicNow()`; `DEFAULT_SETUP_BUDGET_MS`. Deadlines are `monotonicNow()` timestamps.
- Consumes: nothing new.

- [x] **Step 1: Write the failing strategy tests** — create `packages/core/__tests__/fts5Drain.test.ts`:

```typescript
// packages/core/__tests__/fts5Drain.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import {
  fts5TablesDdl, fts5PendingIndexesDdl, idDrainChunkSql, entityDrainChunkSql, entityDrainHiSql,
} from '../src/services/search/fts5Sql';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
let db: SQLiteAdapter;
let meta: MetadataRepository;

beforeEach(async () => {
  db = openTestDatabase();
  await setupDatabase(db, P);
  meta = new MetadataRepository(db, P);
});

async function bulk(entity: string, n: number, idPrefix = entity): Promise<void> {
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < n; i++) {
      await tx.runAsync(
        `INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, 'b', '[]', 1, 1)`,
        [`${idPrefix}_${i}`, entity, `filler ${i}`]);
    }
  });
}
const pending = async () => (await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}fts_pending`))!.n;
const indexed = async (id: string) => (await db.getFirstAsync(`SELECT 1 AS x FROM ${P}fts_map WHERE id = ?`, [id])) !== null;

/** A live, empty FTS5 store (B2 makes this `init({ entriesExisted: false })`). */
async function liveStrategy(budgetMs?: number): Promise<Fts5IndexStrategy> {
  const s = new Fts5IndexStrategy(db, P, meta, budgetMs);
  await s.init();
  return s;
}

describe('fts5 drain SQL (#280 B1)', () => {
  it('prepares against the schema and the index DDL is idempotent', () => {
    const raw = new Database(':memory:');
    raw.exec(`CREATE TABLE p_entries (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', deleted_at INTEGER)`);
    raw.exec(fts5TablesDdl('p_'));
    for (const s of [...idDrainChunkSql('p_'), ...entityDrainChunkSql('p_'), entityDrainHiSql('p_')]) {
      expect(() => raw.prepare(s)).not.toThrow();
    }
    raw.exec(fts5PendingIndexesDdl('p_'));
    raw.exec(fts5PendingIndexesDdl('p_'));
    const idx = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'p_fts_pending' ORDER BY name`).all() as { name: string }[];
    expect(idx.map((r) => r.name)).toEqual(['p_fts_pending_entity', 'p_fts_pending_id']);
  });
});

describe('Fts5IndexStrategy.drain modes (#280 B1)', () => {
  it('7(m) ledger mode: own ids drain to completion under a 5k foreign backlog, plus exactly one foreign chunk', async () => {
    const s = await liveStrategy();
    await bulk('e2', 5000);
    await bulk('e1', 1200, 'mine');
    const mine = Array.from({ length: 1200 }, (_, i) => `mine_${i}`);
    await s.drain({ mode: 'ledger', entityId: 'e1', ids: mine });
    for (const id of ['mine_0', 'mine_599', 'mine_1199']) expect(await indexed(id)).toBe(true);
    expect(await pending()).toBe(4500); // own 1200 to completion + ONE seq-ordered foreign chunk of 500
    expect((await s.search('filler', { entityIds: ['e1'], limit: 5000 })).length).toBe(1200);
  });

  it('ledger mode, entity target, no ids: one entity-targeted chunk (counts as the foreign chunk)', async () => {
    const s = await liveStrategy();
    await bulk('e2', 1000);
    await bulk('e1', 700);
    await s.drain({ mode: 'ledger', entityId: 'e1' });
    const left = await db.getAllAsync<{ entity_id: string; n: number }>(
      `SELECT entity_id, count(*) AS n FROM ${P}fts_pending GROUP BY entity_id ORDER BY entity_id`);
    expect(left).toEqual([{ entity_id: 'e1', n: 200 }, { entity_id: 'e2', n: 1000 }]);
  });

  it('full mode (the default) with room in the budget drains the whole ledger', async () => {
    const s = await liveStrategy();
    await bulk('e1', 1203);
    await s.drain();
    expect(await pending()).toBe(0);
  });

  it('full mode checks the deadline between chunks: an overrun deadline runs exactly one chunk, and calls converge', async () => {
    const s = await liveStrategy();
    await bulk('e1', 2600);
    await s.drain({ mode: 'full', deadline: 0 });
    expect(await pending()).toBe(2100);
    for (let i = 0; i < 10 && (await pending()) > 0; i++) await s.drain({ mode: 'full', deadline: 0 });
    expect(await pending()).toBe(0);
  });

  it('ids with no ledger row (already drained, or never written) are a no-op', async () => {
    const s = await liveStrategy();
    await bulk('e1', 3);
    await s.drain();
    await expect(s.drain({ mode: 'ledger', ids: ['e1_0', 'nope'] })).resolves.toBeUndefined();
    expect(await indexed('e1_0')).toBe(true);
  });
});
```

- [x] **Step 2: Run it — expect FAIL.** `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/fts5Drain.test.ts` → FAIL: `fts5PendingIndexesDdl`/`idDrainChunkSql` are not exported, and the 7(m) assertion fails (`pending` is 0 because today's drain empties the ledger).

- [x] **Step 3: Shared clock + budget default.** Create `packages/core/src/utils/monotonicNow.ts`:

```typescript
/** Monotonic clock (ms): a wall-clock step must not stretch or skip a deadline or a cooldown. */
export const monotonicNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
```

Create `packages/core/src/utils/setupDefaults.ts`:

```typescript
/**
 * Default `setupBudgetMs`: the wall time each keyword-index quantum (one per
 * `setup()` and per no-arg `syncSearchIndex()`) may spend on drain/rebuild
 * chunks, checked between chunk transactions (spec #280 Config surface).
 */
export const DEFAULT_SETUP_BUDGET_MS = 1500;
```

In `packages/core/src/WikiMemory.ts`, delete the local `monotonicNow` (`:64-66`, keep the comment's meaning in the new file) and add `import { monotonicNow } from './utils/monotonicNow';` and `import { DEFAULT_SETUP_BUDGET_MS } from './utils/setupDefaults';`. In `packages/core/src/index.ts`, after the `DEFAULT_MAX_EMBED_CHARS` export line (`:18`), add `export { DEFAULT_SETUP_BUDGET_MS } from './utils/setupDefaults';`.

- [x] **Step 4: SQL.** In `packages/core/src/services/search/fts5Sql.ts`, after `drainChunkSql` add:

```typescript
/**
 * fts_pending indexes for the ids-first and entity-targeted drains (spec #280
 * schema v15). Created by MIGRATIONS[15] where the ledger already exists, and
 * by Fts5IndexStrategy.init together with the ledger table otherwise — never
 * by setupDatabase and never on the init fast path.
 */
export function fts5PendingIndexesDdl(p: string): string {
  return `
CREATE INDEX IF NOT EXISTS ${p}fts_pending_id ON ${p}fts_pending(id);
CREATE INDEX IF NOT EXISTS ${p}fts_pending_entity ON ${p}fts_pending(entity_id);`;
}

/**
 * One ids-first drain chunk (the caller's own writes). Every statement binds
 * `?` = a JSON array of ≤ FTS5_DRAIN_CHUNK ids. Ids with no ledger row are
 * skipped: chunkIds is filtered through fts_pending.
 */
export function idDrainChunkSql(p: string): readonly string[] {
  const chunkIds = `SELECT id FROM ${p}fts_pending WHERE id IN (SELECT value FROM json_each(?))`;
  return [
    `DELETE FROM ${p}entries_fts WHERE rowid IN (SELECT m.fts_rowid FROM ${p}fts_map m WHERE m.id IN (${chunkIds}))`,
    `DELETE FROM ${p}fts_map WHERE id IN (${chunkIds})`,
    `INSERT INTO ${p}fts_map (id, entity_id)
       SELECT e.id, e.entity_id FROM ${p}entries e WHERE e.id IN (${chunkIds}) AND e.deleted_at IS NULL`,
    `INSERT INTO ${p}entries_fts (rowid, id, entity_id, title, body, tags)
       SELECT m.fts_rowid, e.id, e.entity_id, e.title, e.body, ${tagsExpr('e.tags')}
       FROM ${p}fts_map m JOIN ${p}entries e ON e.id = m.id
       WHERE m.id IN (${chunkIds})`,
    `DELETE FROM ${p}fts_pending WHERE id IN (SELECT value FROM json_each(?))`,
  ];
}

/** hi for an entity-targeted chunk. Binds `?` = entity_id. */
export function entityDrainHiSql(p: string): string {
  return `SELECT max(seq) AS hi FROM (SELECT seq FROM ${p}fts_pending WHERE entity_id = ? ORDER BY seq LIMIT ${FTS5_DRAIN_CHUNK})`;
}

/** One entity-targeted drain chunk. Every statement binds [entity_id, hi]. */
export function entityDrainChunkSql(p: string): readonly string[] {
  const chunkIds = `SELECT id FROM ${p}fts_pending WHERE entity_id = ? AND seq <= ?`;
  return [
    `DELETE FROM ${p}entries_fts WHERE rowid IN (SELECT m.fts_rowid FROM ${p}fts_map m WHERE m.id IN (${chunkIds}))`,
    `DELETE FROM ${p}fts_map WHERE id IN (${chunkIds})`,
    `INSERT INTO ${p}fts_map (id, entity_id)
       SELECT e.id, e.entity_id FROM ${p}entries e WHERE e.id IN (${chunkIds}) AND e.deleted_at IS NULL`,
    `INSERT INTO ${p}entries_fts (rowid, id, entity_id, title, body, tags)
       SELECT m.fts_rowid, e.id, e.entity_id, e.title, e.body, ${tagsExpr('e.tags')}
       FROM ${p}fts_map m JOIN ${p}entries e ON e.id = m.id
       WHERE m.id IN (${chunkIds})`,
    `DELETE FROM ${p}fts_pending WHERE entity_id = ? AND seq <= ?`,
  ];
}
```

`idDrainChunkSql`'s first four statements each bind ONE `?` and the fifth binds one; call each with `[json]`. `entityDrainChunkSql`'s statements each bind two; call each with `[entityId, hi]`.

- [x] **Step 5: Interface.** In `packages/core/src/services/search/IndexStrategy.ts`, above `export interface IndexStrategy`, add:

```typescript
/** One drain turn's shape (spec #280 Change 3 "drain interface"). */
export interface DrainOptions {
  /** `monotonicNow()` timestamp, checked between chunk transactions. Full mode only; default now + the strategy's budget. */
  deadline?: number;
  /**
   * `'ledger'` (write turns): `ids` to completion, then at most ONE foreign
   * chunk. `'full'` (setup(), no-arg syncSearchIndex()): `ids`, then the
   * ledger until the deadline, then rebuild work. Default `'full'`.
   */
  mode?: 'ledger' | 'full';
  /** The caller's own ledger ids: drained first, to completion, ≤500 per transaction. */
  ids?: readonly string[];
  /** With empty `ids` in ledger mode, the one foreign chunk is `fts_pending WHERE entity_id = ?`. */
  entityId?: string;
}
```

and replace the `drain?(): Promise<void>;` member (`:128`) with `drain?(opts?: DrainOptions): Promise<void>;` (keep its doc comment, adding: "Bounded by `opts` — see DrainOptions."). In `UnavailableIndexStrategy.ts:26` change to `async drain(_opts?: DrainOptions): Promise<void> {}` and import `DrainOptions`.

- [x] **Step 6: Strategy drain.** In `Fts5IndexStrategy.ts`: import `DrainOptions`, `FTS5_DRAIN_CHUNK`, `fts5PendingIndexesDdl`, `idDrainChunkSql`, `entityDrainHiSql`, `entityDrainChunkSql`, `monotonicNow`, `DEFAULT_SETUP_BUDGET_MS`. Constructor gains `private readonly budgetMs: number = DEFAULT_SETUP_BUDGET_MS`. In `init()`'s rebuild transaction (`:31-37`), after `tx.execAsync(fts5TablesDdl(this.prefix));` add `await tx.execAsync(fts5PendingIndexesDdl(this.prefix));` (B2 rewrites init; this keeps fresh stores indexed meanwhile). Replace `drain()` (`:44-56`) with:

```typescript
  async drain(opts: DrainOptions = {}): Promise<void> {
    const ids = opts.ids ?? [];
    if (ids.length > 0) await this.drainIds(ids);
    if (opts.mode === 'ledger') {
      // Write turn: at most ONE foreign chunk after the caller's own ids.
      if (ids.length === 0 && opts.entityId !== undefined) await this.drainEntityChunk(opts.entityId);
      else await this.drainLedgerChunk();
      return;
    }
    await this.fullQuantum(opts.deadline ?? monotonicNow() + this.budgetMs);
  }

  /** Full quantum. B3 extends it with rebuild windows, the sweep and the flip. */
  private async fullQuantum(deadline: number): Promise<void> {
    await this.drainLedgerUntil(deadline);
  }

  /** Seq-ordered ledger chunks until empty or the deadline. True when a chunk ran and the deadline was then reached. */
  private async drainLedgerUntil(deadline: number): Promise<boolean> {
    let ran = false;
    while (await this.drainLedgerChunk()) {
      ran = true;
      if (monotonicNow() >= deadline) return true;
    }
    return ran && monotonicNow() >= deadline;
  }

  /** The caller's own ids, to completion, ≤ FTS5_DRAIN_CHUNK per transaction. */
  private async drainIds(ids: readonly string[]): Promise<void> {
    const unique = [...new Set(ids)];
    const chunk = idDrainChunkSql(this.prefix);
    for (let i = 0; i < unique.length; i += FTS5_DRAIN_CHUNK) {
      const json = JSON.stringify(unique.slice(i, i + FTS5_DRAIN_CHUNK));
      await this.db.withTransactionAsync(async (tx) => {
        for (const sql of chunk) await tx.runAsync(sql, [json]);
      });
    }
  }

  /** One seq-ordered chunk. False when the ledger was empty. */
  private async drainLedgerChunk(): Promise<boolean> {
    const hiSql = drainHiSql(this.prefix);
    const chunk = drainChunkSql(this.prefix);
    // A local, not the callback's return value: host adapters may resolve withTransactionAsync to void.
    let ran = false;
    await this.db.withTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<{ hi: number | null }>(hiSql);
      if (row?.hi == null) return;
      for (const sql of chunk) await tx.runAsync(sql, [row.hi]);
      ran = true;
    });
    return ran;
  }

  /** One entity-targeted chunk (ORDER BY seq, ≤ FTS5_DRAIN_CHUNK). */
  private async drainEntityChunk(entityId: string): Promise<void> {
    const hiSql = entityDrainHiSql(this.prefix);
    const chunk = entityDrainChunkSql(this.prefix);
    await this.db.withTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<{ hi: number | null }>(hiSql, [entityId]);
      if (row?.hi == null) return;
      for (const sql of chunk) await tx.runAsync(sql, [entityId, row.hi]);
    });
  }
```

- [x] **Step 7: Run Step 1's file — expect PASS** (same command as Step 2).

- [x] **Step 8: Write the failing SearchService routing test** — append to `packages/core/__tests__/searchServiceDrain.test.ts`, inside the existing `describe('SearchService in drain mode', ...)`:

```typescript
  it('passes mode/ids/deadline per entry point (#280 B1): write turns are ledger-only', async () => {
    const { svc, strategy } = setup();
    await svc.sync(undefined, { deadline: 42 });
    await svc.sync('e1');
    await svc.syncEntries('e1', ['a', 'a', 'b']);
    await svc.syncStale();
    expect((strategy.drain as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      { mode: 'full', deadline: 42 },
      { mode: 'ledger', entityId: 'e1' },
      { mode: 'ledger', entityId: 'e1', ids: ['a', 'b'] },
      { mode: 'full' },
    ]);
  });
```

Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/searchServiceDrain.test.ts` → FAIL (`drain` is called with `undefined`).

- [x] **Step 9: SearchService.** In `packages/core/src/services/SearchService.ts` import `DrainOptions` and change:

```typescript
  private drainTurn(entityId: string | undefined, opts: DrainOptions): Promise<void> {
    const work = this.syncChain.then(async () => {
      try {
        try {
          await this.indexStrategy.drain!(opts);
        } finally {
          this.evictCache(entityId);
        }
      } catch (err) {
        console.warn(`[WikiMemory] search index drain failed for ${entityId ?? '*'}:`, err);
      }
    });
    this.syncChain = work;
    return work;
  }
```

`sync` becomes `async sync(entityId?: string, opts?: { deadline?: number }): Promise<void>` with first line:

```typescript
    if (this.indexStrategy.drain) {
      // No entity: a full quantum (setup(), re-init). An entity: a write turn, ledger-only.
      return this.drainTurn(entityId, entityId === undefined
        ? { mode: 'full', deadline: opts?.deadline }
        : { mode: 'ledger', entityId });
    }
```

and add to its doc comment: "With a ledger strategy, `sync()` runs one full quantum bounded by `opts.deadline`; `sync(entityId)` is a write turn (ledger only)." In `syncEntries` replace `:183` with:

```typescript
    if (this.indexStrategy.drain) return this.drainTurn(entityId, { mode: 'ledger', entityId, ids: [...new Set(ids)] });
```

In `syncStale` replace `:261` with `if (this.indexStrategy.drain) return this.drainTurn(undefined, { mode: 'full' });`. (vitest's `toEqual` ignores `undefined`-valued keys, so a call made as `{ mode: 'full', deadline: undefined }` matches `{ mode: 'full' }`.)

- [x] **Step 10: Run Step 8's file — expect PASS.**

- [x] **Step 11: Write the failing budget + v15 tests** — create `packages/core/__tests__/setupBudget.test.ts`:

```typescript
// packages/core/__tests__/setupBudget.test.ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { DEFAULT_SETUP_BUDGET_MS } from '../src/index';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
const stub = { llmProvider: { generateText: async () => '{}' } } as const;
const open = (db: SQLiteAdapter, config: Record<string, unknown> = {}) =>
  new WikiMemory(db, { ...stub, config: { indexStrategy: 'fts5', ...config } });
const pending = async (db: SQLiteAdapter) => (await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}fts_pending`))!.n;
const indexes = async (db: SQLiteAdapter) => (await db.getAllAsync<{ name: string }>(
  `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name`, [`${P}fts_pending`])).map((r) => r.name);
async function backlog(db: SQLiteAdapter, n: number): Promise<void> {
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < n; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'b', '[]', 1, 1)`, [`b_${i}`, `t ${i}`]);
    }
  });
}

describe('setupBudgetMs (#280 B1)', () => {
  it('defaults to 1500 and is exported', () => {
    expect(DEFAULT_SETUP_BUDGET_MS).toBe(1500);
  });

  it('rejects a non-positive or non-finite budget before touching the store', async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const db = openTestDatabase();
      await expect(open(db, { setupBudgetMs: bad }).setup()).rejects.toThrow(TypeError);
      expect(await db.getFirstAsync(`SELECT name FROM sqlite_master WHERE name = '${P}entries'`)).toBeNull();
    }
  });

  it('setupBudgetMs: 1 leaves a backlog on one open and converges across opens', async () => {
    const db = openTestDatabase();
    await open(db).setup();
    await backlog(db, 3000);
    await open(db, { setupBudgetMs: 1 }).setup();
    expect(await pending(db)).toBeGreaterThan(0);
    for (let i = 0; i < 20 && (await pending(db)) > 0; i++) await open(db, { setupBudgetMs: 1 }).setup();
    expect(await pending(db)).toBe(0);
  });
});

describe('schema v15 (#280 B1)', () => {
  it('CURRENT_SCHEMA_VERSION is 15', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(15);
  });

  it('a fresh FTS5 store gets the fts_pending indexes from init (v15 never runs on it)', async () => {
    const db = openTestDatabase();
    await open(db).setup();
    expect(await indexes(db)).toEqual([`${P}fts_pending_entity`, `${P}fts_pending_id`]);
  });

  it("'refuse' on a v14 store throws schema_migration 14 -> 15 with zero mutation; plain setup() migrates", async () => {
    const db = openTestDatabase();
    await open(db).setup();
    await db.execAsync(`DROP INDEX ${P}fts_pending_id; DROP INDEX ${P}fts_pending_entity;`);
    await db.runAsync(`UPDATE ${P}meta SET value = '14' WHERE key = 'schema_version'`);
    await expect(open(db).setup({ migrations: 'refuse' })).rejects.toMatchObject({
      name: 'WikiMigrationRequiredError',
      pendingWork: { type: 'schema_migration', fromVersion: 14, toVersion: 15 },
    });
    expect(await indexes(db)).toEqual([]);
    expect((await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = 'schema_version'`))!.value).toBe('14');
    await open(db).setup();
    expect(await indexes(db)).toEqual([`${P}fts_pending_entity`, `${P}fts_pending_id`]);
  });

  it('v15 on a store without a ledger (MiniSearch) is a no-op', async () => {
    const db = openTestDatabase();
    await open(db, { indexStrategy: 'minisearch' }).setup();
    await db.runAsync(`UPDATE ${P}meta SET value = '14' WHERE key = 'schema_version'`);
    await open(db, { indexStrategy: 'minisearch' }).setup();
    expect((await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = 'schema_version'`))!.value).toBe('15');
    expect(await db.getFirstAsync(`SELECT name FROM sqlite_master WHERE name = '${P}fts_pending'`)).toBeNull();
  });
});
```

Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/setupBudget.test.ts` → FAIL (`DEFAULT_SETUP_BUDGET_MS` undefined until Step 3 is exported; v15 missing; budget not validated or honoured).

- [x] **Step 12: v15.** In `packages/core/src/db/migrations.ts` add `import { fts5PendingIndexesDdl } from '../services/search/fts5Sql';` and append after the v14 entry:

```typescript
  {
    version: 15,
    description: 'fts_pending(id) and fts_pending(entity_id) indexes for the ids-first and entity-targeted drains',
    run: async (db, prefix) => {
      // Only where the ledger exists. A MiniSearch or detached store has none;
      // Fts5IndexStrategy.init creates these with the table when it (re)attaches.
      const row = await db.getFirstAsync<{ n: number }>(
        `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`, [`${prefix}fts_pending`]);
      if (row?.n) await db.execAsync(fts5PendingIndexesDdl(prefix));
    },
  },
```

(`fts5Sql.ts` imports nothing, so there is no cycle.)

- [x] **Step 13: Config + setup plumbing.** In `types.ts`, after `migrations?: MigrationPolicy;` (`:394`) add:

```typescript
  /**
   * Wall-time budget (ms) for each keyword-index quantum: one per `setup()`
   * (shared by the whole open — the deadline is captured when setup() starts)
   * and one per no-arg `syncSearchIndex()`. Checked between chunk
   * transactions, so one quantum can overrun it by up to two chunks.
   * Convergence of a large backlog or rebuild continues on later opens and
   * `syncSearchIndex()` calls. Must be a positive finite number.
   * @default 1500 (DEFAULT_SETUP_BUDGET_MS)
   */
  setupBudgetMs?: number;
```

In `createIndexStrategy.ts`, change the signature to `createIndexStrategy(db, prefix, metadataRepo, preferred, opts: { setupBudgetMs?: number } = {})` and construct `new Fts5IndexStrategy(db, prefix, metadataRepo, opts.setupBudgetMs)`. In `WikiMemory.setup()` (`:290`), make the first statements:

```typescript
    const setupBudgetMs = this.options.config?.setupBudgetMs ?? DEFAULT_SETUP_BUDGET_MS;
    if (typeof setupBudgetMs !== 'number' || !Number.isFinite(setupBudgetMs) || setupBudgetMs <= 0) {
      throw new TypeError(`setupBudgetMs must be a positive finite number; got ${String(setupBudgetMs)}`);
    }
    // One deadline per open (spec #280 Change 3): captured here, never re-budgeted per turn.
    const openDeadline = monotonicNow() + setupBudgetMs;
```

pass `{ setupBudgetMs }` as `createIndexStrategy`'s fifth argument at `:333-338` and in `syncSearchIndex`'s re-init (`:721-722`, using `this.options.config?.setupBudgetMs ?? DEFAULT_SETUP_BUDGET_MS`), and change `:341` to `await this.searchService.sync(undefined, { deadline: openDeadline });`. Extend `setup()`'s JSDoc with: "Keyword-index catch-up work is bounded by `config.setupBudgetMs`; anything left converges on later opens and no-arg `syncSearchIndex()` calls."

- [x] **Step 14: Run Step 11's file — expect PASS.** Then run the touched neighbours: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/fts5IndexStrategy.test.ts __tests__/fts5Integration.test.ts __tests__/createIndexStrategy.test.ts __tests__/searchUnavailable.test.ts __tests__/migrations.test.ts` → PASS.

- [x] **Step 15: Gate.** Full suite (gate per Global Constraints vs the rev-8 baseline 1904/176 + the new tests) and `pnpm --filter @equationalapplications/core-llm-wiki typecheck` → exit 0.

- [x] **Step 16: Commit.**

```bash
git add packages/core/src/utils/monotonicNow.ts packages/core/src/utils/setupDefaults.ts packages/core/src/index.ts \
  packages/core/src/types.ts packages/core/src/WikiMemory.ts packages/core/src/db/migrations.ts \
  packages/core/src/services/SearchService.ts packages/core/src/services/search/IndexStrategy.ts \
  packages/core/src/services/search/fts5Sql.ts packages/core/src/services/search/Fts5IndexStrategy.ts \
  packages/core/src/services/search/UnavailableIndexStrategy.ts packages/core/src/services/search/createIndexStrategy.ts \
  packages/core/__tests__/fts5Drain.test.ts packages/core/__tests__/searchServiceDrain.test.ts packages/core/__tests__/setupBudget.test.ts
git commit -m "feat(core): budgeted FTS drain modes, setupBudgetMs and schema v15 (#280 B1)"
```

---

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

**Rev 8 source check:** `init()` is `Fts5IndexStrategy.ts:23-38` (live+triggers ⇒ IF NOT EXISTS DDL; else one tx DROP+CREATE+`rebuildInTx`+triggers+`live`). `setup()` computes `entriesExistedBeforeSetup` at `WikiMemory.ts:291` and does not pass it down (`:332-339`). Dead code per D4. `fts5IndexStrategy.test.ts`'s `init` block (`:33-71`) and every test that inserts rows before `init()` (`:74-217`) depend on the old single-tx rebuild; so do `createIndexStrategy.test.ts:39-43,56-69,81-93`, which call `createIndexStrategy` on a `setupDatabase`-only store and expect `'live'`.

**Rev 8 findings:** F3 (no convergence until B3, so fixtures are rewritten here), F12 (the detach guard has no target). The reset path in B2 is `DROP TABLE` + CREATE; B4 swaps it for rename-retire behind the same private method `retireFtsTable(tx)`.

**Interfaces:**
- Produces: `IndexStrategy.init?(opts?: { entriesExisted?: boolean })`; `createIndexStrategy(..., opts?: { setupBudgetMs?: number; entriesExisted?: boolean })`; meta keys in `fts5Sql.ts`: `FTS5_REBUILD_WM_KEY = 'fts5_rebuild_wm'` (JSON `{ rowid: number; id: string | null }`), `FTS5_REBUILD_SNAPSHOT_KEY = 'fts5_rebuild_snapshot'` (JSON `{ entries: number; map: number }`), `FTS5_SWEEP_CURSOR_KEY = 'fts5_orphan_sweep_cursor'` (decimal integer); `fts5Progress.ts`: `writeRebuildStart(tx, prefix, meta)`, `readRebuildProgress(meta, tx?) → RebuildProgress | null`, types `RebuildWatermark`, `RebuildProgress`. `Fts5IndexStrategy` private: `rearmInTx(tx)`, `resetAndRearm()`, `retireFtsTable(tx)`, `keepMapConsistent()`.
- Consumes: B1's `fts5PendingIndexesDdl`.

- [x] **Step 1: Write the failing transition tests** — create `packages/core/__tests__/fts5StateMachine.test.ts`:

```typescript
// packages/core/__tests__/fts5StateMachine.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { createIndexStrategy } from '../src/services/search/createIndexStrategy';
import { MiniSearchIndexStrategy } from '../src/services/search/MiniSearchIndexStrategy';
import {
  FTS5_STATE_KEY, FTS5_REBUILD_WM_KEY, FTS5_REBUILD_SNAPSHOT_KEY, FTS5_SWEEP_CURSOR_KEY, fts5TriggerNames,
} from '../src/services/search/fts5Sql';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
let db: SQLiteAdapter;
let meta: MetadataRepository;

beforeEach(async () => {
  db = openTestDatabase();
  await setupDatabase(db, P);
  meta = new MetadataRepository(db, P);
});

async function bulk(n: number, entity = 'e1'): Promise<void> {
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < n; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, 'b', '[]', 1, 1)`,
        [`${entity}_${i}`, entity, `cedar ${i}`]);
    }
  });
}
const count = async (t: string) => (await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}${t}`))!.n;
const state = () => meta.getMeta(FTS5_STATE_KEY);
const triggers = async () => (await db.getAllAsync<{ name: string }>(
  `SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)).map((r) => r.name);
const ftsDdl = () => meta.getTableDdl(`${P}entries_fts`);

/** A live store with n indexed rows. */
async function liveStore(n: number): Promise<Fts5IndexStrategy> {
  const s = new Fts5IndexStrategy(db, P, meta);
  await s.init({ entriesExisted: false });
  await bulk(n);
  await s.drain();
  expect(await state()).toBe('live');
  return s;
}

describe('init transitions (#280 B2)', () => {
  it('fresh store (entriesExisted: false) goes straight to live with the pending indexes', async () => {
    await new Fts5IndexStrategy(db, P, meta).init({ entriesExisted: false });
    expect(await state()).toBe('live');
    expect(await triggers()).toEqual([...fts5TriggerNames(P)].sort());
    expect(await meta.getMeta(FTS5_REBUILD_WM_KEY)).toBeNull();
  });

  it('pre-FTS store (entries exist, no state) enters rebuilding via the re-arm', async () => {
    await bulk(10);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await state()).toBe('rebuilding');
    expect(JSON.parse((await meta.getMeta(FTS5_REBUILD_WM_KEY))!)).toEqual({ rowid: 0, id: null });
    expect(JSON.parse((await meta.getMeta(FTS5_REBUILD_SNAPSHOT_KEY))!)).toEqual({ entries: 10, map: 0 });
    expect(await meta.getMeta(FTS5_SWEEP_CURSOR_KEY)).toBe('0');
  });

  it('7(g) marker loss on an intact store: keep-map re-arm, no DDL change, index rows kept', async () => {
    await liveStore(50);
    const ddl = await ftsDdl();
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [FTS5_STATE_KEY]);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await state()).toBe('rebuilding');
    expect(await ftsDdl()).toBe(ddl);
    expect(await count('entries_fts')).toBe(50);
    expect(await count('fts_map')).toBe(50);
    expect(JSON.parse((await meta.getMeta(FTS5_REBUILD_SNAPSHOT_KEY))!)).toEqual({ entries: 50, map: 50 });
  });

  it('7(g) trigger loss: triggers re-created, ledger cleared, map kept', async () => {
    await liveStore(20);
    await db.execAsync(`DROP TRIGGER ${fts5TriggerNames(P)[1]}`);
    await db.runAsync(`UPDATE ${P}entries SET title = 'changed' WHERE id = 'e1_3'`); // not ledgered: au is gone
    await db.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES ('x','e1','t','b','[]',1,1)`);
    expect(await count('fts_pending')).toBe(1);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await state()).toBe('rebuilding');
    expect(await triggers()).toEqual([...fts5TriggerNames(P)].sort());
    expect(await count('fts_pending')).toBe(0);
    expect(await count('fts_map')).toBe(20);
  });

  it('rebuilding + all triggers present: resume is a no-op', async () => {
    await bulk(5);
    await new Fts5IndexStrategy(db, P, meta).init();
    await meta.setMeta(FTS5_REBUILD_WM_KEY, JSON.stringify({ rowid: 3, id: 'e1_2' }), db);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(JSON.parse((await meta.getMeta(FTS5_REBUILD_WM_KEY))!)).toEqual({ rowid: 3, id: 'e1_2' });
  });

  it('rebuilding + a trigger lost mid-rebuild: restart (watermark back to 0), triggers present', async () => {
    await bulk(5);
    await new Fts5IndexStrategy(db, P, meta).init();
    await meta.setMeta(FTS5_REBUILD_WM_KEY, JSON.stringify({ rowid: 3, id: 'e1_2' }), db);
    await db.execAsync(`DROP TRIGGER ${fts5TriggerNames(P)[0]}`);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(JSON.parse((await meta.getMeta(FTS5_REBUILD_WM_KEY))!)).toEqual({ rowid: 0, id: null });
    expect(await triggers()).toEqual([...fts5TriggerNames(P)].sort());
  });

  it('live + live row + empty map + empty ledger: reset re-arm', async () => {
    await liveStore(5);
    await db.execAsync(`DELETE FROM ${P}fts_map; DELETE FROM ${P}entries_fts;`);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await state()).toBe('rebuilding');
  });

  it('live + empty map + a FULL ledger (crash before first drain): fast path, stays live', async () => {
    await new Fts5IndexStrategy(db, P, meta).init({ entriesExisted: false });
    await bulk(5);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await state()).toBe('live');
    expect(await count('fts_pending')).toBe(5);
  });

  describe('consistency check: failed checks take the reset path', () => {
    const lose = () => db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [FTS5_STATE_KEY]);

    it('ghost FTS rowid beyond max(fts_map.fts_rowid)', async () => {
      await liveStore(10);
      await db.runAsync(`INSERT INTO ${P}entries_fts (rowid, id, entity_id, title, body, tags) VALUES (9999, 'g', 'e1', 'ghost', '', '')`);
      await lose();
      await new Fts5IndexStrategy(db, P, meta).init();
      expect(await count('entries_fts')).toBe(0);
      expect(await count('fts_map')).toBe(0);
      expect(await state()).toBe('rebuilding');
    });

    it('docsize count != fts_map count (a ghost in a gap)', async () => {
      await liveStore(10);
      await db.runAsync(`DELETE FROM ${P}fts_map WHERE fts_rowid = 3`);
      await lose();
      await new Fts5IndexStrategy(db, P, meta).init();
      expect(await count('entries_fts')).toBe(0);
      expect(await count('fts_map')).toBe(0);
    });

    it('fts_map missing while entries_fts has rows', async () => {
      await liveStore(10);
      await db.execAsync(`DROP TABLE ${P}fts_map`);
      await lose();
      await new Fts5IndexStrategy(db, P, meta).init();
      expect(await count('entries_fts')).toBe(0);
      expect(await count('fts_map')).toBe(0);
      expect(await state()).toBe('rebuilding');
    });
  });

  describe('7(f) detached stores', () => {
    it("pinned 'minisearch' keeps a detached store detached", async () => {
      await liveStore(5);
      await createIndexStrategy(db, P, meta, 'minisearch');
      expect(await createIndexStrategy(db, P, meta, 'minisearch')).toBeInstanceOf(MiniSearchIndexStrategy);
      expect(await state()).toBe('detached');
    });

    it.each(['auto', 'fts5'] as const)("'%s' re-attaches a detached store into rebuilding (no single-tx rebuild)", async (pref) => {
      await liveStore(5);
      await createIndexStrategy(db, P, meta, 'minisearch');
      const s = await createIndexStrategy(db, P, meta, pref);
      expect(s).toBeInstanceOf(Fts5IndexStrategy);
      expect(await state()).toBe('rebuilding');
      expect(await count('entries_fts')).toBe(0);
      expect(await count('fts_map')).toBe(0);
    });

    it("F12: pinned 'minisearch' detaches a rebuilding store (transition table: live/rebuilding -> detached)", async () => {
      await bulk(5);
      await new Fts5IndexStrategy(db, P, meta).init();
      expect(await state()).toBe('rebuilding');
      await createIndexStrategy(db, P, meta, 'minisearch');
      expect(await state()).toBe('detached');
    });
  });

  it('every probe runs before the first mutation: a probe failure leaves zero mutation', async () => {
    await liveStore(5);
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [FTS5_STATE_KEY]);
    const orig = db.getFirstAsync.bind(db);
    vi.spyOn(db, 'getFirstAsync').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (sql.includes('entries_fts_docsize')) throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
      return orig(sql, args as never);
    }) as never);
    await expect(new Fts5IndexStrategy(db, P, meta).init()).rejects.toThrow('disk I/O error');
    vi.restoreAllMocks();
    expect(await state()).toBeNull();
    expect(await meta.getMeta(FTS5_REBUILD_WM_KEY)).toBeNull();
  });
});
```

- [x] **Step 2: Run it — expect FAIL.** `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/fts5StateMachine.test.ts` → FAIL: the new keys are not exported and `init` takes no options (it rebuilds to `live`).

- [x] **Step 3: Keys + progress helpers.** In `fts5Sql.ts`, after `FTS5_DRAIN_CHUNK`, add:

```typescript
/** Rebuild watermark: JSON `{ rowid, id }`; `id` is the fingerprint (the entries id at `rowid`), null at 0 and once windows complete. */
export const FTS5_REBUILD_WM_KEY = 'fts5_rebuild_wm';
/** Re-arm snapshot: JSON `{ entries: max(entries.rowid), map: max(fts_map.fts_rowid) }`. */
export const FTS5_REBUILD_SNAPSHOT_KEY = 'fts5_rebuild_snapshot';
/** Orphan-sweep cursor over fts_map.fts_rowid (decimal integer). Spec #280 Change 3. */
export const FTS5_SWEEP_CURSOR_KEY = 'fts5_orphan_sweep_cursor';
```

Delete `rebuildSql` (`:84-92`). Create `packages/core/src/services/search/fts5Progress.ts`:

```typescript
// packages/core/src/services/search/fts5Progress.ts
//
// Rebuild progress for the FTS5 `rebuilding` state (spec #280 Change 3):
// watermark + fingerprint, re-arm snapshot, orphan-sweep cursor.
import type { SQLiteAdapter } from '../../types';
import type { MetadataRepository } from '../../repositories/MetadataRepository';
import { parseJsonObject } from '../../repositories/rowMappers';
import { FTS5_REBUILD_SNAPSHOT_KEY, FTS5_REBUILD_WM_KEY, FTS5_SWEEP_CURSOR_KEY } from './fts5Sql';

export interface RebuildWatermark { rowid: number; id: string | null }
export interface RebuildProgress {
  wm: RebuildWatermark;
  snapshot: { entries: number; map: number };
  cursor: number;
}

/** Starts (or restarts) a rebuild from 0. Call inside the transition transaction. */
export async function writeRebuildStart(tx: SQLiteAdapter, prefix: string, meta: MetadataRepository): Promise<void> {
  const e = await tx.getFirstAsync<{ hi: number }>(`SELECT coalesce(max(rowid), 0) AS hi FROM ${prefix}entries`);
  const m = await tx.getFirstAsync<{ hi: number }>(`SELECT coalesce(max(fts_rowid), 0) AS hi FROM ${prefix}fts_map`);
  await meta.setMeta(FTS5_REBUILD_WM_KEY, JSON.stringify({ rowid: 0, id: null }), tx);
  await meta.setMeta(FTS5_REBUILD_SNAPSHOT_KEY, JSON.stringify({ entries: e?.hi ?? 0, map: m?.hi ?? 0 }), tx);
  await meta.setMeta(FTS5_SWEEP_CURSOR_KEY, '0', tx);
}

/** Parsed progress, or null when any key is missing or malformed (the caller restarts). */
export async function readRebuildProgress(meta: MetadataRepository, tx?: SQLiteAdapter): Promise<RebuildProgress | null> {
  const wm = parseJsonObject<{ rowid?: unknown; id?: unknown }>(await meta.getMeta(FTS5_REBUILD_WM_KEY, tx));
  const snap = parseJsonObject<{ entries?: unknown; map?: unknown }>(await meta.getMeta(FTS5_REBUILD_SNAPSHOT_KEY, tx));
  const rawCursor = await meta.getMeta(FTS5_SWEEP_CURSOR_KEY, tx);
  const cursor = rawCursor === null ? Number.NaN : Number(rawCursor);
  if (typeof wm?.rowid !== 'number' || !(typeof wm.id === 'string' || wm.id === null)) return null;
  if (typeof snap?.entries !== 'number' || typeof snap.map !== 'number' || !Number.isFinite(cursor)) return null;
  return { wm: { rowid: wm.rowid, id: wm.id }, snapshot: { entries: snap.entries, map: snap.map }, cursor };
}
```

- [x] **Step 4: `init()` state machine.** In `Fts5IndexStrategy.ts`, remove `rebuildFromSource` (`:40-42`), `rebuildInTx` (`:141-145`) and the `rebuildSql` import; import the new keys, `fts5PendingIndexesDdl`, `writeRebuildStart`. Replace `init()` with:

```typescript
  /**
   * Resolves the index state (spec #280 Change 3 transition table). Every
   * read-only probe runs before the one transition transaction, so a probe
   * failure leaves zero mutation (Change 4 ordering).
   */
  async init(opts: { entriesExisted?: boolean } = {}): Promise<void> {
    const p = this.prefix;
    const state = await this.metadataRepo.getMeta(FTS5_STATE_KEY);
    const ftsExists = await this.metadataRepo.tableExists(`${p}entries_fts`);
    const mapExists = await this.metadataRepo.tableExists(`${p}fts_map`);
    const pendingExists = await this.metadataRepo.tableExists(`${p}fts_pending`);
    const trig = await this.triggersPresent();

    if (state === null && opts.entriesExisted === false) {
      // Fresh store: nothing to index yet.
      await this.db.withTransactionAsync(async (tx) => {
        await tx.execAsync(fts5TablesDdl(p) + fts5PendingIndexesDdl(p) + fts5TriggersDdl(p));
        await this.metadataRepo.setMeta(FTS5_STATE_KEY, 'live', tx);
      });
      return;
    }
    if (state === 'detached') return this.resetAndRearm(); // re-attach: the map is untrustworthy

    const intact = trig && ftsExists && mapExists && pendingExists;
    if (intact && state === 'rebuilding') return; // resume; each quantum re-verifies the fingerprint
    if (intact && state === 'live') {
      if (await this.liveRowsButNothingIndexed()) return this.resetAndRearm();
      return; // fast path
    }
    // Marker lost, a trigger lost, or a table missing.
    if (ftsExists && mapExists && (await this.keepMapConsistent())) {
      await this.db.withTransactionAsync((tx) => this.rearmInTx(tx));
      return;
    }
    return this.resetAndRearm();
  }

  /** live, a live entry, an empty fts_map and an empty ledger: the index was lost (rev 8 m3 / rev 9 m4). */
  private async liveRowsButNothingIndexed(): Promise<boolean> {
    const p = this.prefix;
    if (await this.db.getFirstAsync(`SELECT 1 AS x FROM ${p}fts_map LIMIT 1`)) return false;
    if (!(await this.db.getFirstAsync(`SELECT 1 AS x FROM ${p}entries WHERE deleted_at IS NULL LIMIT 1`))) return false;
    return (await this.db.getFirstAsync(`SELECT 1 AS x FROM ${p}fts_pending LIMIT 1`)) === null;
  }

  /**
   * Read-only keep-map check (spec DDL note): every surviving entries_fts
   * rowid must have a map row. Max-rowid seek, then docsize vs map counts.
   */
  private async keepMapConsistent(): Promise<boolean> {
    const p = this.prefix;
    const fts = await this.db.getFirstAsync<{ rowid: number }>(`SELECT rowid FROM ${p}entries_fts ORDER BY rowid DESC LIMIT 1`);
    const map = await this.db.getFirstAsync<{ hi: number; n: number }>(
      `SELECT coalesce(max(fts_rowid), 0) AS hi, count(*) AS n FROM ${p}fts_map`);
    if ((fts?.rowid ?? 0) > (map?.hi ?? 0)) return false;
    const doc = await this.db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${p}entries_fts_docsize`);
    return (doc?.n ?? 0) === (map?.n ?? 0);
  }

  /** Keep-map re-arm: triggers, empty ledger, rebuild from 0, state rebuilding. One transaction. */
  private async rearmInTx(tx: SQLiteAdapter): Promise<void> {
    const p = this.prefix;
    await tx.execAsync(fts5TablesDdl(p));
    await tx.execAsync(`DELETE FROM ${p}fts_pending;`);
    await tx.execAsync(fts5PendingIndexesDdl(p) + fts5TriggersDdl(p));
    await writeRebuildStart(tx, p, this.metadataRepo);
    await this.metadataRepo.setMeta(FTS5_STATE_KEY, 'rebuilding', tx);
  }

  /** Reset path: retire entries_fts, recreate it empty, clear map + ledger, then the re-arm. One transaction. */
  private async resetAndRearm(): Promise<void> {
    const p = this.prefix;
    await this.db.withTransactionAsync(async (tx) => {
      await this.retireFtsTable(tx);
      await tx.execAsync(fts5TablesDdl(p));
      await tx.execAsync(`DELETE FROM ${p}fts_map; DELETE FROM ${p}fts_pending;`);
      await this.rearmInTx(tx);
    });
  }

  /** B2: drop. B4 replaces this with rename-retire (DROP only as the RENAME-failure fallback). */
  private async retireFtsTable(tx: SQLiteAdapter): Promise<void> {
    await tx.execAsync(`DROP TABLE IF EXISTS ${this.prefix}entries_fts;`);
  }
```

`triggersPresent()` stays as is. In `IndexStrategy.ts` change `init?(): Promise<void>;` to `init?(opts?: { entriesExisted?: boolean }): Promise<void>;` (doc: "`entriesExisted: false` marks a store `setup()` just created: FTS starts `live` with nothing to index.") and delete `rebuildFromSource?` (`:130-131`).

- [x] **Step 5: Plumb `entriesExisted`.** `createIndexStrategy`'s opts become `{ setupBudgetMs?: number; entriesExisted?: boolean }`, and `attempt()` calls `await strategy.init({ entriesExisted: opts.entriesExisted });`. In `WikiMemory.setup()` pass `{ setupBudgetMs, entriesExisted: entriesExistedBeforeSetup }`. `syncSearchIndex`'s re-init passes only `{ setupBudgetMs }` (the store exists by then).

- [x] **Step 6: Run Step 1's file — expect PASS.**

- [x] **Step 7: Rewrite the fixtures that relied on init's single-tx rebuild (F3).** Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/fts5IndexStrategy.test.ts __tests__/fts5Sql.test.ts __tests__/createIndexStrategy.test.ts __tests__/fts5Drain.test.ts __tests__/fts5Integration.test.ts` and fix exactly these:
  - `fts5Sql.test.ts:3,45-52`: drop `rebuildSql` from the import and the `for (const s of rebuildSql…)` line; rename the test to `'drain chunk SQL prepares against the schema'`.
  - `fts5IndexStrategy.test.ts` `describe('Fts5IndexStrategy.init')` (`:33-71`) → replace the four tests with: (1) `'fresh init installs triggers and marks live'` — `init({ entriesExisted: false })`, assert `live`, triggers, `pending() === 0`; (2) `'second init on a live database does not rebuild'` — unchanged except the first init passes `{ entriesExisted: false }` and `put('a')` moves after it with an explicit `drain()` before the second `put`; (3) `'live with a missing trigger re-arms into rebuilding'` — assert state `rebuilding` and all three triggers present; (4) `'detached state re-arms into rebuilding'`. Convergence of these to indexed rows is asserted in B3.
  - Every other test in `fts5IndexStrategy.test.ts` that calls `put(...)` before `s.init()`: change `s.init()` to `s.init({ entriesExisted: false })` and move the pre-init `put` calls after it, then `await s.drain()` before the assertions. Expectations stay byte-identical. (In `'survives VACUUM'` (`:112`) the 20 puts move after init and a `drain()` follows them.)
  - `fts5Drain.test.ts` `liveStrategy()`: `s.init({ entriesExisted: false })`.
  - `createIndexStrategy.test.ts`: in `:39-43`, `:56-69`, `:71-79`, `:81-93`, `:95-101` and the better-sqlite3 leg of `:103-126`, pass `{ entriesExisted: false }` as the fifth argument to the FIRST `createIndexStrategy` call on each fresh store (the fixture is a fresh store; without the flag it is a pre-FTS store and enters `rebuilding`).
  - `fts5Integration.test.ts:71-82` (`'state changes'`): the store re-attached by `open(db, 'auto')` is now `rebuilding` and cannot converge until B3. Replace the final `expect` with `expect(await c.__testAccess.metadataRepo.getMeta('fts5_index_state')).toBe('rebuilding'); // B3 Step 9 restores the 20-hit assertion`.
  Expected after the edits: those files PASS.

- [x] **Step 8: Gate.** Full suite + typecheck. Any further failure must be a test that indexes rows written before a non-fresh init and then searches. Fix it the same way (init first, or `{ entriesExisted: false }`), and list every such file in the commit body. Any other failure is a real bug: stop and debug (superpowers:systematic-debugging).

- [x] **Step 9: Commit.**

```bash
git add packages/core/src/services/search packages/core/src/services/search/fts5Progress.ts packages/core/src/WikiMemory.ts \
  packages/core/__tests__/fts5StateMachine.test.ts packages/core/__tests__/fts5IndexStrategy.test.ts packages/core/__tests__/fts5Sql.test.ts \
  packages/core/__tests__/createIndexStrategy.test.ts packages/core/__tests__/fts5Drain.test.ts packages/core/__tests__/fts5Integration.test.ts
git commit -m "feat(core): FTS5 init state machine with keep-map re-arm, no single-tx rebuild (#280 B2)"
```

Body: list the rewritten fixtures from Step 7/8 and state that convergence of `rebuilding` stores lands in B3.

---

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

**Rev 8 source check:** `bulkDeletePruned` is `EntryRepository.ts:813-845` (DELETE at `:826`, chunked by 500 inside the caller's tx). It is the only hard delete of `entries` in `src/`, and its only caller is `MaintenanceService.ts:302`. `EntryRepository` has `this.prefix` (BaseRepository) and imports nothing from `services/`; `fts5Progress.ts` imports only types, `rowMappers` and `fts5Sql`, so there is no cycle.

**Rev 8 findings:** F2 (the 7(i) arbitration test lives here), F8 (sweep throughput), F9 (trailing-gap completion).

**Interfaces:**
- Produces: `windowHiSql(p)` (binds `[lo, cap]`), `windowChunkSql(p)` (each statement binds `[lo, hi]`), `sweepHiSql(p)` (binds `[lo, cap]`), `sweepChunkSql(p)` (each binds `[lo, hi]`), `FTS5_SWEEP_CHUNK = 500`; `reanchorRebuildFingerprint(tx, prefix, deletedIds)` in `fts5Progress.ts`.
- Consumes: B2's keys, `RebuildProgress`, `readRebuildProgress`, `rearmInTx`.

- [x] **Step 1: Write the failing convergence tests** — create `packages/core/__tests__/fts5Rebuild.test.ts`:

```typescript
// packages/core/__tests__/fts5Rebuild.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { FTS5_STATE_KEY, FTS5_REBUILD_WM_KEY, fts5TriggerNames } from '../src/services/search/fts5Sql';
import { reanchorRebuildFingerprint } from '../src/services/search/fts5Progress';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
let db: SQLiteAdapter;
let meta: MetadataRepository;

beforeEach(async () => {
  db = openTestDatabase();
  await setupDatabase(db, P);
  meta = new MetadataRepository(db, P);
});

async function bulk(n: number, from = 0, entity = 'e1'): Promise<void> {
  await db.withTransactionAsync(async (tx) => {
    for (let i = from; i < from + n; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, 'b', '[]', 1, 1)`,
        [`r${i}`, entity, `cedar ${i}`]);
    }
  });
}
const state = () => meta.getMeta(FTS5_STATE_KEY);
const wm = async () => JSON.parse((await meta.getMeta(FTS5_REBUILD_WM_KEY))!) as { rowid: number; id: string | null };
const count = async (t: string) => (await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}${t}`))!.n;
const pending = () => count('fts_pending');

/** Exactly-once: one FTS row and one map row per live entry, none for anything else. */
async function expectExactlyOnce(): Promise<void> {
  const live = await db.getAllAsync<{ id: string; title: string }>(`SELECT id, title FROM ${P}entries WHERE deleted_at IS NULL ORDER BY id`);
  const fts = await db.getAllAsync<{ id: string; title: string }>(`SELECT id, title FROM ${P}entries_fts ORDER BY id`);
  expect(fts).toEqual(live);
  expect(await count('fts_map')).toBe(live.length);
  expect(await db.getAllAsync(`SELECT m.id FROM ${P}fts_map m LEFT JOIN ${P}entries_fts f ON f.rowid = m.fts_rowid WHERE f.rowid IS NULL`)).toEqual([]);
}

/** Pre-FTS store of n rows, armed into rebuilding. */
async function armed(n: number): Promise<Fts5IndexStrategy> {
  await bulk(n);
  const s = new Fts5IndexStrategy(db, P, meta);
  await s.init();
  expect(await state()).toBe('rebuilding');
  return s;
}
/** One quantum with an already-overrun deadline: at most one ledger chunk, else exactly one window. */
const step = (s: Fts5IndexStrategy) => s.drain({ mode: 'full', deadline: 0 });
async function converge(s: Fts5IndexStrategy, max = 200): Promise<void> {
  for (let i = 0; i < max && (await state()) !== 'live'; i++) await step(s);
  expect(await state()).toBe('live');
}

describe('rebuild windows (#280 B3)', () => {
  it('converges a pre-FTS store exactly once, one ≤500-row window per overrun quantum', async () => {
    const s = await armed(1200);
    await step(s);
    expect((await wm()).rowid).toBe(500);
    expect((await wm()).id).toBe('r499');
    await converge(s);
    await expectExactlyOnce();
    expect(await meta.getMeta(FTS5_REBUILD_WM_KEY)).toBeNull();
  });

  it('7(j) resume from watermark K on a new instance is exactly-once', async () => {
    let s = await armed(2000);
    await step(s); await step(s);
    expect((await wm()).rowid).toBe(1000);
    s = new Fts5IndexStrategy(db, P, meta); // simulated restart
    await s.init();
    expect((await wm()).rowid).toBe(1000);
    await converge(s);
    await expectExactlyOnce();
  });

  it('7(a) concurrent writers incl. drain-before-window: no duplicate, no stall', async () => {
    const s = await armed(1500);
    await step(s); // window 1: rowids 1..500
    await db.runAsync(`UPDATE ${P}entries SET title = 'zebra' WHERE id = 'r1200'`); // above the watermark
    await s.drain({ mode: 'ledger', entityId: 'e1', ids: ['r1200'] }); // drained BEFORE its window
    expect(await db.getFirstAsync(`SELECT title FROM ${P}entries_fts WHERE id = 'r1200'`)).toEqual({ title: 'zebra' });
    await db.runAsync(`UPDATE ${P}entries SET title = 'yak' WHERE id = 'r10'`); // below the watermark
    await db.runAsync(`UPDATE ${P}entries SET deleted_at = 5 WHERE id = 'r700'`);
    await bulk(30, 5000); // new rows above the snapshot: ledgered only
    await converge(s);
    await expectExactlyOnce();
    expect((await s.search('zebra', { entityIds: ['e1'], limit: 10 })).map((r) => r.id)).toEqual(['r1200']);
  });

  it('7(i) arbitration: ledger first; an overrun ledger drain skips windows; write turns never window', async () => {
    const s = await armed(1200);
    await bulk(600, 5000); // ledgered after the re-arm
    await s.drain({ mode: 'ledger', ids: ['r5000'] });
    expect(await wm()).toEqual({ rowid: 0, id: null }); // write turn: drain-only, never a window
    expect(await pending()).toBe(99); // 600 - 1 own - ONE foreign chunk of 500
    await step(s);
    expect(await pending()).toBe(0); // ledger first
    expect(await wm()).toEqual({ rowid: 0, id: null }); // that ledger chunk overran the deadline: no window
    await step(s);
    expect((await wm()).rowid).toBe(500); // ledger empty: one window
    await s.drain(); // generous deadline: the rest converges in one quantum
    expect(await state()).toBe('live');
    await expectExactlyOnce();
  });

  it('manual rowid change under the fingerprint restarts from 0', async () => {
    const s = await armed(1200);
    await step(s);
    const before = await wm();
    await db.runAsync(`UPDATE ${P}entries SET rowid = 99999 WHERE rowid = ?`, [before.rowid]);
    await step(s);
    expect(await wm()).toEqual({ rowid: 0, id: null });
    await converge(s);
    await expectExactlyOnce();
  });

  it('a hard delete of the fingerprint row re-anchors in-tx: no restart', async () => {
    const s = await armed(1200);
    await step(s);
    expect(await wm()).toEqual({ rowid: 500, id: 'r499' });
    await db.withTransactionAsync(async (tx) => {
      await tx.runAsync(`DELETE FROM ${P}entries WHERE id IN ('r498', 'r499')`);
      await reanchorRebuildFingerprint(tx, P, ['r498', 'r499']);
    });
    expect(await wm()).toEqual({ rowid: 498, id: 'r497' });
    await step(s); // drains the two delete-trigger ledger rows; that overran, so no window
    expect(await wm()).toEqual({ rowid: 498, id: 'r497' }); // fingerprint valid: not restarted
    await step(s);
    expect((await wm()).rowid).toBeGreaterThan(498); // advanced from the re-anchored watermark
    await converge(s);
    await expectExactlyOnce();
  });

  it('re-anchor ignores deletes that do not include the fingerprint id', async () => {
    const s = await armed(1200);
    await step(s);
    await db.withTransactionAsync(async (tx) => {
      await tx.runAsync(`DELETE FROM ${P}entries WHERE id = 'r10'`);
      await reanchorRebuildFingerprint(tx, P, ['r10']);
    });
    expect(await wm()).toEqual({ rowid: 500, id: 'r499' });
  });

  it("7(g') orphans: with triggers down, a hard-deleted row and a renamed row are swept; neither is searchable", async () => {
    await bulk(40);
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init();
    await converge(s);
    for (const t of fts5TriggerNames(P)) await db.execAsync(`DROP TRIGGER ${t}`);
    await db.runAsync(`DELETE FROM ${P}entries WHERE id = 'r5'`);
    await db.runAsync(`UPDATE ${P}entries SET id = 'renamed', title = 'moved' WHERE id = 'r6'`);
    await s.init(); // trigger loss: keep-map re-arm
    expect(await state()).toBe('rebuilding');
    await converge(s);
    await expectExactlyOnce();
    expect(await s.search('cedar 5', { entityIds: ['e1'], limit: 50 }).then((r) => r.map((x) => x.id))).not.toContain('r5');
    expect(await db.getFirstAsync(`SELECT 1 AS x FROM ${P}fts_map WHERE id IN ('r5', 'r6')`)).toBeNull();
  });

  it('the flip still happens under a steady trickle of writes', async () => {
    const s = await armed(1200);
    for (let i = 0; i < 40 && (await state()) !== 'live'; i++) {
      await bulk(10, 10_000 + i * 10);
      await s.drain({ mode: 'full' });
    }
    expect(await state()).toBe('live');
    await s.drain();
    await expectExactlyOnce();
  });

  it('trailing hard deletes cannot strand the watermark below the snapshot (F9)', async () => {
    const s = await armed(1000);
    await db.runAsync(`DELETE FROM ${P}entries WHERE rowid > 990`);
    await converge(s);
    await expectExactlyOnce();
  });

  it('state gate: a live store never reads the watermark', async () => {
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init({ entriesExisted: false });
    await bulk(10);
    const spy = vi.spyOn(meta, 'getMeta');
    await s.drain();
    expect(spy.mock.calls.map((c) => c[0])).not.toContain(FTS5_REBUILD_WM_KEY);
  });
});
```

- [x] **Step 2: Run it — expect FAIL.** `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/fts5Rebuild.test.ts` → FAIL: `reanchorRebuildFingerprint` is not exported and no store leaves `rebuilding`.

- [x] **Step 3: Window + sweep SQL.** In `fts5Sql.ts`, add `export const FTS5_SWEEP_CHUNK = 500;` next to `FTS5_DRAIN_CHUNK`, then:

```typescript
/** hi of the next rebuild window: max rowid over the next ≤500 EXISTING entries rows in (lo, cap]. Binds [lo, cap]. */
export function windowHiSql(p: string): string {
  return `SELECT max(rowid) AS hi FROM (SELECT rowid FROM ${p}entries WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ${FTS5_DRAIN_CHUNK})`;
}

/**
 * One rebuild window (spec #280 DDL note). Every statement binds [lo, hi].
 * Never touches fts_pending: an id drained ahead of its window is simply
 * re-done here, and fts_rowid never re-collides because the map is kept.
 */
export function windowChunkSql(p: string): readonly string[] {
  const chunkIds = `SELECT id FROM ${p}entries WHERE rowid > ? AND rowid <= ?`;
  return [
    `DELETE FROM ${p}entries_fts WHERE rowid IN (SELECT m.fts_rowid FROM ${p}fts_map m WHERE m.id IN (${chunkIds}))`,
    `DELETE FROM ${p}fts_map WHERE id IN (${chunkIds})`,
    `INSERT INTO ${p}fts_map (id, entity_id)
       SELECT e.id, e.entity_id FROM ${p}entries e WHERE e.rowid > ? AND e.rowid <= ? AND e.deleted_at IS NULL`,
    `INSERT INTO ${p}entries_fts (rowid, id, entity_id, title, body, tags)
       SELECT m.fts_rowid, e.id, e.entity_id, e.title, e.body, ${tagsExpr('e.tags')}
       FROM ${p}entries e JOIN ${p}fts_map m ON m.id = e.id
       WHERE e.rowid > ? AND e.rowid <= ?`,
  ];
}

/** hi of the next sweep window over fts_map.fts_rowid in (lo, cap]. Binds [lo, cap]. */
export function sweepHiSql(p: string): string {
  return `SELECT max(fts_rowid) AS hi FROM (SELECT fts_rowid FROM ${p}fts_map WHERE fts_rowid > ? AND fts_rowid <= ? ORDER BY fts_rowid LIMIT ${FTS5_SWEEP_CHUNK})`;
}

/** Orphan sweep (spec #280 Change 3): map rows whose entry no longer exists. Both bind [lo, hi]; FTS rows first. */
export function sweepChunkSql(p: string): readonly string[] {
  const orphans = `SELECT m.fts_rowid FROM ${p}fts_map m
     WHERE m.fts_rowid > ? AND m.fts_rowid <= ? AND NOT EXISTS (SELECT 1 FROM ${p}entries e WHERE e.id = m.id)`;
  return [
    `DELETE FROM ${p}entries_fts WHERE rowid IN (${orphans})`,
    `DELETE FROM ${p}fts_map WHERE fts_rowid IN (${orphans})`,
  ];
}
```

Add to `fts5Sql.test.ts`'s `'drain chunk SQL prepares…'` test: `for (const s of [...windowChunkSql('p_'), ...sweepChunkSql('p_'), windowHiSql('p_'), sweepHiSql('p_')]) expect(() => db.prepare(s)).not.toThrow();` (import them).

- [x] **Step 4: Re-anchor helper.** Append to `fts5Progress.ts` (add `FTS5_STATE_KEY` to the import):

```typescript
/**
 * Keeps the rebuild fingerprint valid across an engine hard-delete (spec #280
 * Change 3): call in the deleting transaction, after the DELETE. Only when
 * the fingerprint id is among `deletedIds` does the watermark move to the
 * greatest surviving rowid below it (or 0), so a missing fingerprint at
 * check time always means an external change, which restarts the rebuild.
 * Raw meta SQL: repositories must not depend on MetadataRepository here.
 */
export async function reanchorRebuildFingerprint(tx: SQLiteAdapter, prefix: string, deletedIds: readonly string[]): Promise<void> {
  if (deletedIds.length === 0) return;
  const metaValue = async (key: string) =>
    (await tx.getFirstAsync<{ value: string }>(`SELECT value FROM ${prefix}meta WHERE key = ?`, [key]))?.value ?? null;
  if ((await metaValue(FTS5_STATE_KEY)) !== 'rebuilding') return;
  const wm = parseJsonObject<{ rowid?: unknown; id?: unknown }>(await metaValue(FTS5_REBUILD_WM_KEY));
  if (typeof wm?.rowid !== 'number' || typeof wm.id !== 'string' || !deletedIds.includes(wm.id)) return;
  if ((await tx.getFirstAsync<{ id: string }>(`SELECT id FROM ${prefix}entries WHERE rowid = ?`, [wm.rowid]))?.id === wm.id) return;
  const below = await tx.getFirstAsync<{ rowid: number; id: string }>(
    `SELECT rowid, id FROM ${prefix}entries WHERE rowid < ? ORDER BY rowid DESC LIMIT 1`, [wm.rowid]);
  const next: RebuildWatermark = below ? { rowid: below.rowid, id: below.id } : { rowid: 0, id: null };
  await tx.runAsync(`UPDATE ${prefix}meta SET value = ? WHERE key = ?`, [JSON.stringify(next), FTS5_REBUILD_WM_KEY]);
}
```

In `EntryRepository.bulkDeletePruned`, after the chunk loop and before `return totalChanges;`, add:

```typescript
    // Spec #280 Change 3: an engine hard-delete never strands the FTS rebuild fingerprint.
    if (totalChanges > 0) await reanchorRebuildFingerprint(executor, this.prefix, ids);
```

with `import { reanchorRebuildFingerprint } from '../services/search/fts5Progress';`.

- [x] **Step 5: Full quantum.** In `Fts5IndexStrategy.ts`, import the B3 SQL, `readRebuildProgress`, `RebuildProgress`, `RebuildWatermark`, and replace B1's `fullQuantum` with:

```typescript
  /**
   * One full quantum (spec #280 Change 3): ledger first; then, while
   * `rebuilding`, ≥1 window unless the ledger drain overran the deadline,
   * one sweep tx, and the flip check. A `live` store reads only the state.
   */
  private async fullQuantum(deadline: number): Promise<void> {
    const ledgerOverran = await this.drainLedgerUntil(deadline);
    if ((await this.metadataRepo.getMeta(FTS5_STATE_KEY)) !== 'rebuilding') return;
    const progress = await readRebuildProgress(this.metadataRepo);
    if (!progress || !(await this.fingerprintValid(progress.wm))) return this.restartRebuild();
    if (!ledgerOverran) {
      do {
        if (!(await this.runWindow(progress))) break;
      } while (monotonicNow() < deadline);
      await this.runSweepTx(progress);
    }
    await this.tryFlip();
  }

  /** The id at the watermark's rowid still matches. A null id (start, or windows complete) has nothing to check. */
  private async fingerprintValid(wm: RebuildWatermark, tx: SQLiteAdapter = this.db): Promise<boolean> {
    if (wm.id === null) return true;
    const row = await tx.getFirstAsync<{ id: string }>(`SELECT id FROM ${this.prefix}entries WHERE rowid = ?`, [wm.rowid]);
    return row?.id === wm.id;
  }

  /** External change under the watermark: start over (same re-arm transaction as a trigger-loss restart). */
  private async restartRebuild(): Promise<void> {
    await this.db.withTransactionAsync((tx) => this.rearmInTx(tx));
  }

  /** One window tx. False once no rows remain in (wm, snapshot]; the watermark is then pinned at the snapshot (F9). */
  private async runWindow(pr: RebuildProgress): Promise<boolean> {
    if (pr.wm.rowid >= pr.snapshot.entries) return false;
    const p = this.prefix;
    let next: RebuildWatermark = pr.wm;
    let more = false;
    await this.db.withTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<{ hi: number | null }>(windowHiSql(p), [pr.wm.rowid, pr.snapshot.entries]);
      if (row?.hi == null) {
        next = { rowid: pr.snapshot.entries, id: null };
      } else {
        for (const sql of windowChunkSql(p)) await tx.runAsync(sql, [pr.wm.rowid, row.hi]);
        const fp = await tx.getFirstAsync<{ id: string }>(`SELECT id FROM ${p}entries WHERE rowid = ?`, [row.hi]);
        next = { rowid: row.hi, id: fp!.id };
        more = true;
      }
      await this.metadataRepo.setMeta(FTS5_REBUILD_WM_KEY, JSON.stringify(next), tx);
    });
    pr.wm = next; // only after the tx resolved
    return more;
  }

  /** At most one bounded sweep tx; the cursor advances in the same tx. */
  private async runSweepTx(pr: RebuildProgress): Promise<void> {
    if (pr.cursor >= pr.snapshot.map) return;
    const p = this.prefix;
    let next = pr.cursor;
    await this.db.withTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<{ hi: number | null }>(sweepHiSql(p), [pr.cursor, pr.snapshot.map]);
      const hi = row?.hi ?? pr.snapshot.map;
      for (const sql of sweepChunkSql(p)) await tx.runAsync(sql, [pr.cursor, hi]);
      await this.metadataRepo.setMeta(FTS5_SWEEP_CURSOR_KEY, String(hi), tx);
      next = hi;
    });
    pr.cursor = next;
  }

  /** Completion, re-checked inside the flipping tx; the residual ledger (≤ one chunk) drains in it. */
  private async tryFlip(): Promise<void> {
    const p = this.prefix;
    await this.db.withTransactionAsync(async (tx) => {
      if ((await this.metadataRepo.getMeta(FTS5_STATE_KEY, tx)) !== 'rebuilding') return;
      const pr = await readRebuildProgress(this.metadataRepo, tx);
      if (!pr || pr.wm.rowid < pr.snapshot.entries || pr.cursor < pr.snapshot.map) return;
      if (!(await this.fingerprintValid(pr.wm, tx))) return;
      const residual = await tx.getFirstAsync<{ n: number }>(
        `SELECT count(*) AS n FROM (SELECT 1 FROM ${p}fts_pending LIMIT ${FTS5_DRAIN_CHUNK + 1})`);
      if ((residual?.n ?? 0) > FTS5_DRAIN_CHUNK) return;
      const hi = await tx.getFirstAsync<{ hi: number | null }>(drainHiSql(p));
      if (hi?.hi != null) for (const sql of drainChunkSql(p)) await tx.runAsync(sql, [hi.hi]);
      await this.metadataRepo.deleteMeta(FTS5_REBUILD_WM_KEY, tx);
      await this.metadataRepo.deleteMeta(FTS5_REBUILD_SNAPSHOT_KEY, tx);
      await this.metadataRepo.deleteMeta(FTS5_SWEEP_CURSOR_KEY, tx);
      await this.metadataRepo.setMeta(FTS5_STATE_KEY, 'live', tx);
    });
  }
```

TypeScript narrows `next` inside the callback; if it complains that `next` is `never` after the tx, declare it as `let next = pr.wm as RebuildWatermark;` (same idiom as `sourceRefNormalize.ts:72-73`).

- [x] **Step 6: Run Step 1's file — expect PASS.**

- [x] **Step 7: Restore B2's deferred convergence assertions.** In `fts5IndexStrategy.test.ts`'s rewritten `init` block, extend the `rebuilding` tests to `await s.drain()` and assert rows indexed and state `live`. In `fts5Integration.test.ts:81`, restore `expect((await hits(c, 'cedar')).length).toBe(20); // rebuilt on re-attach, including batch 1`. Run both files → PASS.

- [x] **Step 8: Prune re-anchor at the engine level.** Append to `fts5Rebuild.test.ts`:

```typescript
import { WikiMemory } from '../src/WikiMemory';

describe('runPrune re-anchors the fingerprint (#280 B3)', () => {
  it('prune hard-deletes the fingerprint row: re-anchored, no restart, converges exactly once', async () => {
    const wdb = openTestDatabase();
    const stub = { llmProvider: { generateText: async () => '{}' }, config: { indexStrategy: 'fts5' as const } };
    await new WikiMemory(wdb, stub).setup();
    await wdb.withTransactionAsync(async (tx) => {
      for (let i = 0; i < 1200; i++) {
        await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'b', '[]', 1, 1)`, [`r${i}`, `cedar ${i}`]);
      }
    });
    await wdb.runAsync(`DELETE FROM ${P}meta WHERE key = 'fts5_index_state'`); // marker loss
    const wiki = new WikiMemory(wdb, { ...stub, config: { indexStrategy: 'fts5' as const, setupBudgetMs: 1 } });
    await wiki.setup(); // re-arm + one window
    const wmeta = new MetadataRepository(wdb, P);
    const before = JSON.parse((await wmeta.getMeta(FTS5_REBUILD_WM_KEY))!);
    await wdb.runAsync(`UPDATE ${P}entries SET deleted_at = 1 WHERE id = ?`, [before.id]);
    await wiki.runPrune('e1', { retainSoftDeletedFor: 0, retainEventsFor: null });
    const after = JSON.parse((await wmeta.getMeta(FTS5_REBUILD_WM_KEY))!);
    expect(after.rowid).toBeLessThan(before.rowid);
    expect(after.rowid).toBeGreaterThan(0);
    for (let i = 0; i < 50 && (await wmeta.getMeta('fts5_index_state')) !== 'live'; i++) await wiki.syncSearchIndex();
    expect(await wmeta.getMeta('fts5_index_state')).toBe('live');
    expect((await wdb.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}entries_fts`))!.n).toBe(1199);
  });
});
```

Run the file → PASS (Step 4 already wired `bulkDeletePruned`).

- [x] **Step 9: Gate.** Full suite + typecheck.

- [x] **Step 10: Commit.**

```bash
git add packages/core/src/services/search packages/core/src/repositories/EntryRepository.ts \
  packages/core/__tests__/fts5Rebuild.test.ts packages/core/__tests__/fts5Sql.test.ts \
  packages/core/__tests__/fts5IndexStrategy.test.ts packages/core/__tests__/fts5Integration.test.ts
git commit -m "feat(core): chunked FTS rebuild windows, fingerprint, orphan sweep and flip (#280 B3)"
```

---

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

**Rev 8 source check:** `extractSqliteCode` (`db/sqliteCodes.ts:39`) destructures `err` without a guard, so it is NOT Proxy-safe and maps expo's numeric 267 to `'SQLITE_267'`. The classifier below is self-contained. FTS5's `'merge'` command is a no-op when `total_changes()` grows by less than 2 (FTS5 docs). That is the "did no work" test, sharpening the plan's "unchanged".

**Rev 8 findings:** F1 (variant, not count; nothing ships in the gate until B8), F7 (corruption scope + the fast-path seek), F13 (merge N).

**Interfaces:**
- Produces: `FTS5_RETIRED_TABLES_KEY = 'fts5_retired_tables'` (JSON string array), `FTS5_RETIRED_COUNTER_KEY = 'fts5_retired_counter'`, `FTS5_RECLAIM_MERGE_PAGES = 500`, `retiredTableName(p, n)`, `isRetiredTableName(p, name)` (in `fts5Sql.ts`); `ftsCorruptionClass(err): 'vtab' | 'corrupt' | null` (Proxy-safe, exported from `Fts5IndexStrategy.ts` for tests).
- Consumes: B2's `resetAndRearm`/`retireFtsTable`, B3's `fullQuantum`.

- [ ] **Step 1: Write the failing tests** — create `packages/core/__tests__/fts5RenameRetire.test.ts`:

```typescript
// packages/core/__tests__/fts5RenameRetire.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { Fts5IndexStrategy, ftsCorruptionClass } from '../src/services/search/Fts5IndexStrategy';
import { createIndexStrategy } from '../src/services/search/createIndexStrategy';
import { UnavailableIndexStrategy } from '../src/services/search/UnavailableIndexStrategy';
import { FTS5_STATE_KEY, FTS5_RETIRED_TABLES_KEY } from '../src/services/search/fts5Sql';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
let db: SQLiteAdapter;
let meta: MetadataRepository;
beforeEach(async () => { db = openTestDatabase(); await setupDatabase(db, P); meta = new MetadataRepository(db, P); });
afterEach(() => vi.restoreAllMocks());

async function liveStore(n: number): Promise<Fts5IndexStrategy> {
  const s = new Fts5IndexStrategy(db, P, meta);
  await s.init({ entriesExisted: false });
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < n; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'b', '[]', 1, 1)`, [`r${i}`, `cedar ${i}`]);
    }
  });
  await s.drain();
  return s;
}
/** FTS5 virtual tables only (shadow tables are ordinary tables). */
const tables = async () => (await db.getAllAsync<{ name: string }>(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%' AND name LIKE '${P}entries_fts%' ORDER BY name`,
)).map((r) => r.name);
const retired = async () => JSON.parse((await meta.getMeta(FTS5_RETIRED_TABLES_KEY)) ?? '[]') as string[];
const state = () => meta.getMeta(FTS5_STATE_KEY);
async function swapTokenizer(): Promise<void> {
  await db.execAsync(`DROP TABLE ${P}entries_fts; DELETE FROM ${P}fts_map;
    CREATE VIRTUAL TABLE ${P}entries_fts USING fts5(id UNINDEXED, entity_id UNINDEXED, title, body, tags, tokenize = 'unicode61');
    INSERT INTO ${P}entries_fts (rowid, id, entity_id, title, body, tags) SELECT rowid, id, entity_id, title, body, '' FROM ${P}entries;`);
}

describe('rename-retire (#280 B4, 7(u))', () => {
  it('(i) a tokenizer-mismatch store renames, not drops: retired_1 exists, the new table is empty, converges to live', async () => {
    const s = await liveStore(1200);
    await swapTokenizer();
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await tables()).toEqual([`${P}entries_fts`, `${P}entries_fts_retired_1`]);
    expect(await retired()).toEqual([`${P}entries_fts_retired_1`]);
    expect((await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}entries_fts`))!.n).toBe(0);
    expect(await meta.getTableDdl(`${P}entries_fts`)).toMatch(/porter unicode61/);
    for (let i = 0; i < 20 && (await state()) !== 'live'; i++) await s.drain({ mode: 'full', deadline: 0 });
    expect(await state()).toBe('live');
  });

  it('(ii) full quanta reclaim the retired table in bounded ≤500-row steps, then drop it; the list empties', async () => {
    const s = await liveStore(1200);
    await swapTokenizer();
    await new Fts5IndexStrategy(db, P, meta).init();
    const run = vi.spyOn(db, 'runAsync');
    await s.drain(); // generous deadline: converge + reclaim
    const deletes = run.mock.calls.filter((c) => String(c[0]).startsWith(`DELETE FROM ${P}entries_fts_retired_1`));
    expect(deletes.length).toBe(3); // 500 + 500 + 200
    expect(await tables()).toEqual([`${P}entries_fts`]);
    expect(await retired()).toEqual([]);
    expect(await state()).toBe('live');
  });

  it('(iii) a forced RENAME failure falls back to DROP', async () => {
    await liveStore(10);
    await swapTokenizer();
    const orig = db.execAsync.bind(db);
    vi.spyOn(db, 'execAsync').mockImplementation(async (sql: string) => {
      if (/ALTER TABLE .*entries_fts RENAME TO/.test(sql)) throw new Error('rename failed');
      return orig(sql);
    });
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await tables()).toEqual([`${P}entries_fts`]);
    expect(await retired()).toEqual([]);
    expect(await state()).toBe('rebuilding');
  });

  it('marker loss does NOT take the reset path (no retired table)', async () => {
    await liveStore(10);
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [FTS5_STATE_KEY]);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await tables()).toEqual([`${P}entries_fts`]);
    expect(await state()).toBe('rebuilding');
  });

  it('retired names increase monotonically across resets', async () => {
    await liveStore(10);
    await swapTokenizer();
    await new Fts5IndexStrategy(db, P, meta).init();
    await swapTokenizer();
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await retired()).toEqual([`${P}entries_fts_retired_1`, `${P}entries_fts_retired_2`]);
  });
});

describe('corruption repair (#280 B4, 7(e) corrupt-FTS leg)', () => {
  const corruptVtab = () => Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT_VTAB' });

  it('ftsCorruptionClass is Proxy-safe and classifies codes', () => {
    expect(ftsCorruptionClass(corruptVtab())).toBe('vtab');
    expect(ftsCorruptionClass(new Error('Error code 267: vtable constructor failed'))).toBe('vtab');
    expect(ftsCorruptionClass(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))).toBe('corrupt');
    expect(ftsCorruptionClass(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }))).toBeNull();
    expect(ftsCorruptionClass(new Proxy({}, { get() { throw new Error('trap'); } }))).toBeNull();
    expect(ftsCorruptionClass(null)).toBeNull();
  });

  it.each(['auto', 'fts5'] as const)("SQLITE_CORRUPT_VTAB from the FTS-only fast-path probe repairs under '%s'", async (pref) => {
    await liveStore(10);
    const orig = db.getFirstAsync.bind(db);
    let thrown = false;
    vi.spyOn(db, 'getFirstAsync').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (!thrown && sql.includes(`FROM ${P}entries_fts ORDER BY rowid DESC`)) { thrown = true; throw corruptVtab(); }
      return orig(sql, args as never);
    }) as never);
    const s = await createIndexStrategy(db, P, meta, pref);
    expect(s).toBeInstanceOf(Fts5IndexStrategy);
    expect(await state()).toBe('rebuilding');
    expect(await retired()).toEqual([`${P}entries_fts_retired_1`]);
    expect(await db.getFirstAsync(`SELECT name FROM sqlite_master WHERE name = '${P}fts_pending'`)).not.toBeNull(); // never detached
    await (s as Fts5IndexStrategy).drain();
    expect(await state()).toBe('live');
    expect((await s.search('cedar', { entityIds: ['e1'], limit: 50 })).length).toBe(10);
  });

  it("a generic SQLITE_CORRUPT from entries does NOT reset: 'auto' -> UnavailableIndexStrategy, no retired table", async () => {
    await liveStore(10);
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [FTS5_STATE_KEY]);
    const orig = db.getFirstAsync.bind(db);
    vi.spyOn(db, 'getFirstAsync').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (sql.includes(`coalesce(max(rowid), 0) AS hi FROM ${P}entries`)) throw Object.assign(new Error('malformed'), { code: 'SQLITE_CORRUPT' });
      return orig(sql, args as never);
    }) as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await createIndexStrategy(db, P, meta, 'auto')).toBeInstanceOf(UnavailableIndexStrategy);
    expect(await retired()).toEqual([]);
    expect(await state()).toBeNull(); // the re-arm tx rolled back
  });

  it('a transient SQLITE_BUSY from an FTS-only statement does NOT reset (F7)', async () => {
    await liveStore(10);
    const orig = db.getFirstAsync.bind(db);
    vi.spyOn(db, 'getFirstAsync').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (sql.includes(`FROM ${P}entries_fts ORDER BY rowid DESC`)) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
      return orig(sql, args as never);
    }) as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await createIndexStrategy(db, P, meta, 'auto')).toBeInstanceOf(UnavailableIndexStrategy);
    expect(await retired()).toEqual([]);
    expect(await state()).toBe('live');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.** `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/fts5RenameRetire.test.ts` → FAIL (`ftsCorruptionClass` and `FTS5_RETIRED_TABLES_KEY` are not exported; no rename).

- [ ] **Step 3: Keys + names.** In `fts5Sql.ts` add:

```typescript
/** Retired entries_fts tables awaiting reclamation: JSON array of table names (spec #280 rev 11 rename-retire). */
export const FTS5_RETIRED_TABLES_KEY = 'fts5_retired_tables';
/** Monotonic counter for retired-table names, so names never collide. */
export const FTS5_RETIRED_COUNTER_KEY = 'fts5_retired_counter';
/** Pages per reclamation 'merge' step (tuned by the B8 measurement). */
export const FTS5_RECLAIM_MERGE_PAGES = 500;

export function retiredTableName(p: string, n: number): string {
  return `${p}entries_fts_retired_${n}`;
}
/** Only engine-shaped names are ever interpolated into reclamation SQL. */
export function isRetiredTableName(p: string, name: unknown): name is string {
  return typeof name === 'string' && name.startsWith(`${p}entries_fts_retired_`) && /^\d+$/.test(name.slice(`${p}entries_fts_retired_`.length));
}
```

- [ ] **Step 4: Rename-retire.** Replace B2's `retireFtsTable` with:

```typescript
  /** Rename-retire entries_fts (spec #280 rev 11); DROP only when the RENAME throws. */
  private async retireFtsTable(tx: SQLiteAdapter): Promise<void> {
    const p = this.prefix;
    if (!(await this.metadataRepo.tableExists(`${p}entries_fts`, tx))) return;
    const n = Number((await this.metadataRepo.getMeta(FTS5_RETIRED_COUNTER_KEY, tx)) ?? '0') + 1;
    const name = retiredTableName(p, n);
    try {
      await tx.execAsync(`ALTER TABLE ${p}entries_fts RENAME TO ${name}`);
    } catch {
      // Shadow tables too damaged to rename: today's DROP, with its measured floor, for this case only.
      await tx.execAsync(`DROP TABLE ${p}entries_fts`);
      return;
    }
    await this.metadataRepo.setMeta(FTS5_RETIRED_TABLES_KEY, JSON.stringify([...(await this.retiredList(tx)), name]), tx);
    await this.metadataRepo.setMeta(FTS5_RETIRED_COUNTER_KEY, String(n), tx);
  }

  private async retiredList(tx: SQLiteAdapter = this.db): Promise<string[]> {
    const raw = parseJsonArray<unknown>(await this.metadataRepo.getMeta(FTS5_RETIRED_TABLES_KEY, tx), []);
    return raw.filter((n): n is string => isRetiredTableName(this.prefix, n));
  }
```

(Import `parseJsonArray` from `../../repositories/rowMappers`; its signature is `parseJsonArray<T>(s: unknown, fallback: T[]): T[]`, `rowMappers.ts:11`.)

- [ ] **Step 5: Tokenizer check + fast-path seek + corruption classification.** In `init()`'s probes add, after `trig`:

```typescript
    const ftsDdl = ftsExists ? await this.metadataRepo.getTableDdl(`${p}entries_fts`) : null;
    const tokenizerOk = ftsDdl === null || /tokenize\s*=\s*['"]porter\s+unicode61['"]/i.test(ftsDdl);
```

and route `!tokenizerOk` (when `state !== null || ftsExists`) to `resetAndRearm()` before the `intact` checks. On the `intact && state === 'live'` path, before `liveRowsButNothingIndexed`, run the FTS-only seek through `ftsOnly`: `await this.ftsOnly(() => this.db.getFirstAsync(\`SELECT rowid FROM ${p}entries_fts ORDER BY rowid DESC LIMIT 1\`));` (F7). Wrap the two FTS-only reads inside `keepMapConsistent` (`entries_fts ORDER BY rowid DESC`, `entries_fts_docsize`) in `this.ftsOnly(...)`. Rename the body of `init` to `private async initOnce(opts)` and make `init`:

```typescript
  async init(opts: { entriesExisted?: boolean } = {}): Promise<void> {
    try {
      await this.initOnce(opts);
    } catch (err) {
      const wrapped = unwrapFtsOnly(err);
      const cls = ftsCorruptionClass(wrapped.cause);
      // Corruption confined to FTS tables: entries is untouched, so a reset re-arm is safe (spec #280 Change 4).
      if (cls === 'vtab' || (cls === 'corrupt' && wrapped.ftsOnly)) {
        await this.resetAndRearm();
        return;
      }
      throw wrapped.cause; // generic errors keep the retry -> UnavailableIndexStrategy path; pinned 'fts5' sees them raw
    }
  }

  /** Marks errors from statements that touch only FTS tables (entries_fts + shadows). */
  private async ftsOnly<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new FtsOnlyStatementError(err);
    }
  }
```

and at module level:

```typescript
class FtsOnlyStatementError extends Error {
  readonly ftsOnlyCause: unknown;
  constructor(cause: unknown) {
    super('FTS-only statement failed');
    this.ftsOnlyCause = cause;
  }
}

/** Proxy-safe unwrap (issue #96): never `instanceof` a caught value bare. */
function unwrapFtsOnly(err: unknown): { cause: unknown; ftsOnly: boolean } {
  try {
    if (err instanceof FtsOnlyStatementError) return { cause: err.ftsOnlyCause, ftsOnly: true };
  } catch { /* hostile Proxy */ }
  return { cause: err, ftsOnly: false };
}

/**
 * 'vtab' for SQLITE_CORRUPT_VTAB (extended code 267, any statement), 'corrupt'
 * for another SQLITE_CORRUPT* code, else null. Proxy-safe: any trap ⇒ null.
 */
export function ftsCorruptionClass(err: unknown): 'vtab' | 'corrupt' | null {
  let code: unknown;
  let message: unknown;
  try {
    code = (err as { code?: unknown }).code;
    message = (err as { message?: unknown }).message;
  } catch {
    return null;
  }
  if (code === 'SQLITE_CORRUPT_VTAB' || (typeof message === 'string' && /^Error code 267:/.test(message))) return 'vtab';
  if ((typeof code === 'string' && code.startsWith('SQLITE_CORRUPT')) || (typeof message === 'string' && /^Error code 11:/.test(message))) return 'corrupt';
  return null;
}
```

If the reset itself throws (RENAME and DROP both fail), that error propagates to `createIndexStrategy`'s retry → `UnavailableIndexStrategy` (or raw under pinned `'fts5'`).

- [ ] **Step 6: Reclamation.** Append to `fullQuantum` (after `await this.tryFlip();`, and also reached by a `live` store: move the `live` early-return so it skips only the rebuild block):

```typescript
  private async fullQuantum(deadline: number): Promise<void> {
    const ledgerOverran = await this.drainLedgerUntil(deadline);
    if ((await this.metadataRepo.getMeta(FTS5_STATE_KEY)) === 'rebuilding') {
      const progress = await readRebuildProgress(this.metadataRepo);
      if (!progress || !(await this.fingerprintValid(progress.wm))) return this.restartRebuild();
      if (!ledgerOverran) {
        do {
          if (!(await this.runWindow(progress))) break;
        } while (monotonicNow() < deadline);
        await this.runSweepTx(progress);
      }
      await this.tryFlip();
    }
    await this.reclaimRetired(deadline); // never blocks the flip
  }

  /** Bounded reclamation steps, each its own tx, until the deadline or nothing is retired. */
  private async reclaimRetired(deadline: number): Promise<void> {
    while (monotonicNow() < deadline) {
      const [name] = await this.retiredList();
      if (name === undefined) return;
      await this.reclaimStep(name);
    }
  }

  /** (1) delete ≤500 rows, else (2) one bounded merge, else (3) DROP + delist. */
  private async reclaimStep(name: string): Promise<void> {
    if (!(await this.metadataRepo.tableExists(name))) return this.delistRetired(name, false);
    if (await this.db.getFirstAsync(`SELECT rowid FROM ${name} LIMIT 1`)) {
      await this.db.withTransactionAsync(async (tx) => {
        await tx.runAsync(`DELETE FROM ${name} WHERE rowid IN (SELECT rowid FROM ${name} ORDER BY rowid LIMIT ${FTS5_DRAIN_CHUNK})`);
      });
      return;
    }
    let merged = false;
    await this.db.withTransactionAsync(async (tx) => {
      const before = await tx.getFirstAsync<{ n: number }>(`SELECT total_changes() AS n`);
      await tx.runAsync(`INSERT INTO ${name}(${name}, rank) VALUES('merge', ${FTS5_RECLAIM_MERGE_PAGES})`);
      const after = await tx.getFirstAsync<{ n: number }>(`SELECT total_changes() AS n`);
      merged = (after?.n ?? 0) - (before?.n ?? 0) >= 2; // FTS5 docs: < 2 means the merge did no work
    });
    if (!merged) await this.delistRetired(name, true);
  }

  private async delistRetired(name: string, drop: boolean): Promise<void> {
    await this.db.withTransactionAsync(async (tx) => {
      if (drop) await tx.execAsync(`DROP TABLE IF EXISTS ${name}`);
      const rest = (await this.retiredList(tx)).filter((n) => n !== name);
      await this.metadataRepo.setMeta(FTS5_RETIRED_TABLES_KEY, JSON.stringify(rest), tx);
    });
  }
```

Note on Step 1's `(ii)` count: the three `DELETE FROM …retired_1` calls go through `runAsync`; the merge is an `INSERT`, so it is not counted.

- [ ] **Step 7: Run Step 1's file — expect PASS.** Then re-run `__tests__/fts5StateMachine.test.ts __tests__/fts5Rebuild.test.ts` — PASS (the B2 reset-path tests now see a retired table instead of a drop; their assertions only check the live `entries_fts`/`fts_map` counts, which are unchanged).

- [ ] **Step 8: Gate `retiredTables` (F1).** No gate change in B4: `probePendingWork` keeps returning `null` for retired tables until B8 decides hand-off. Add one test to `fts5RenameRetire.test.ts` pinning that:

```typescript
import { probePendingWork } from '../src/db/sourceRefNormalize';
it('until B8 decides hand-off, retired tables are not pending migration work', async () => {
  await liveStore(10);
  await swapTokenizer();
  await new Fts5IndexStrategy(db, P, meta).init();
  await meta.setMeta('schema_version', '15', db);
  await meta.setMeta('source_ref_normalize_stamp', JSON.stringify({ schema_version: 14, normalize_alg: 1 }), db);
  expect(await probePendingWork(db, meta, P)).toBeNull();
});
```

- [ ] **Step 9: Gate.** Full suite + typecheck.

- [ ] **Step 10: Commit.**

```bash
git add packages/core/src/services/search packages/core/__tests__/fts5RenameRetire.test.ts
git commit -m "feat(core): rename-retire FTS resets, bounded reclamation, corruption-class repair (#280 B4)"
```

---

### Task B5: id threading

- **Scope:**
  - `upsertGraph` stashes `params.nodes[].id` per entity (capped; overflow ⇒ entity-targeted drain), in place of the `markStale` call at `WikiMemory.ts:845`.
  - `syncSearchIndex(entityId)` drains that entity's stash first.
  - No-arg `syncSearchIndex()` drains ALL stashed ids first, then runs the quantum, and clears what it drained.
  - `importDump(merge=false)` passes upserted + soft-deleted ids into the sync call (`ImportExportService.ts:452`), and the comment at :444-448 is updated.
  - Update the `upsertGraph` and `syncSearchIndex` docs to state the bounded-sync contract for both forms.
- **Tests:** 7(r) via both forms under a 5k backlog; 7(m′) `merge=false` import of 2k facts under a 5k foreign backlog → all searchable on return.

**Rev 8 source check:** `markStale(entityId)` is at `WikiMemory.ts:900` (D1). `syncSearchIndex` (`:709-744`) calls `syncStale()` (`:740`) / `syncEntries(entityId, [])` (`:743`). The import sync is `ImportExportService.ts:449-453`, with touched sets `upsertedFactIds` (`:132`) and `softDeletedFactIds` (`:136`). The upsertGraph doc is `:812-854`; the syncSearchIndex doc is `:680-708`.

**Rev 8 findings:** F5 (keep `markStale`), F6 (`sync` gains `opts.ids`).

**Interfaces:**
- Produces: `SearchService.sync(entityId?, opts?: { deadline?: number; ids?: readonly string[] })`; `SearchService.syncStale(opts?: { ids?: readonly string[] })`; `WikiMemory` private `upsertIdStash: Map<string, Set<string>>`, `static readonly UPSERT_ID_STASH_CAP = 10_000`.
- Consumes: B1's `DrainOptions` (`mode: 'full'` + `ids` = ids first, then the quantum).

- [ ] **Step 1: Write the failing tests** — create `packages/core/__tests__/idThreading.test.ts`:

```typescript
// packages/core/__tests__/idThreading.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
const HASH = (b: number) => 'a'.repeat(56) + b.toString(16).padStart(8, '0');
const stub = { llmProvider: { generateText: async () => '{"facts":[]}' } };
const CAP = WikiMemory.UPSERT_ID_STASH_CAP;
afterEach(() => { (WikiMemory as unknown as { UPSERT_ID_STASH_CAP: number }).UPSERT_ID_STASH_CAP = CAP; });

async function open(db: SQLiteAdapter, budget?: number): Promise<WikiMemory> {
  const w = new WikiMemory(db, { ...stub, config: { indexStrategy: 'fts5', ...(budget ? { setupBudgetMs: budget } : {}) } });
  await w.setup();
  return w;
}
async function rawBacklog(db: SQLiteAdapter, entity: string, n: number): Promise<void> {
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < n; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, ?, 'filler', 'b', '[]', 1, 1)`, [`${entity}_bk_${i}`, entity]);
    }
  });
}
async function upsert(wiki: WikiMemory, db: SQLiteAdapter, entity: string, n: number): Promise<string[]> {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `${entity}_node_${i}`, type: '', title: `juniper ${i}`, body: 'x' }));
  await db.withTransactionAsync((tx) => wiki.upsertGraph(entity, { sourceRef: 'g.ts', sourceHash: HASH(1), nodes, edges: [] }, tx));
  return nodes.map((n) => n.id);
}
const hits = async (wiki: WikiMemory, entity: string, q: string) =>
  (await wiki.__testAccess.searchService.searchKeyword(q, [entity], 100_000)).map((r) => r.id);

describe('7(r) upsertGraph then search under a 5k backlog (#280 B5)', () => {
  it('syncSearchIndex(entityId): the new nodes are searchable even when the backlog is the same entity', async () => {
    const db = openTestDatabase();
    const wiki = await open(db);
    await rawBacklog(db, 'e1', 5000);
    const ids = await upsert(wiki, db, 'e1', 20);
    await wiki.syncSearchIndex('e1');
    expect((await hits(wiki, 'e1', 'juniper')).sort()).toEqual([...ids].sort());
  });

  it('no-arg syncSearchIndex(): stashed ids drain first, across entities, then the quantum', async () => {
    const db = openTestDatabase();
    const wiki = await open(db, 1);
    await rawBacklog(db, 'e1', 5000);
    const a = await upsert(wiki, db, 'e1', 20);
    const b = await upsert(wiki, db, 'e2', 5);
    await wiki.syncSearchIndex();
    expect((await hits(wiki, 'e1', 'juniper')).sort()).toEqual([...a].sort());
    expect((await hits(wiki, 'e2', 'juniper')).sort()).toEqual([...b].sort());
    expect((wiki as unknown as { upsertIdStash: Map<string, Set<string>> }).upsertIdStash.size).toBe(0);
  });

  it('the stash is capped: overflow falls back to the entity-targeted drain and does not grow', async () => {
    (WikiMemory as unknown as { UPSERT_ID_STASH_CAP: number }).UPSERT_ID_STASH_CAP = 5;
    const db = openTestDatabase();
    const wiki = await open(db);
    await upsert(wiki, db, 'e1', 20);
    const stash = (wiki as unknown as { upsertIdStash: Map<string, Set<string>> }).upsertIdStash;
    expect([...stash.values()].reduce((n, s) => n + s.size, 0)).toBeLessThanOrEqual(5);
    await wiki.syncSearchIndex('e1');
    expect((await hits(wiki, 'e1', 'juniper')).length).toBe(20); // 5 own ids + one ≤500-row foreign chunk; no other backlog
  });

  it('MiniSearch hosts still rebuild via markStale (F5)', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { ...stub, config: { indexStrategy: 'minisearch' } });
    await wiki.setup();
    const ids = await upsert(wiki, db, 'e1', 3);
    await wiki.syncSearchIndex('e1');
    expect((await hits(wiki, 'e1', 'juniper')).sort()).toEqual([...ids].sort());
  });
});

describe("7(m') importDump(merge=false) under a 5k foreign backlog (#280 B5)", () => {
  it('every imported fact is searchable when the call returns', async () => {
    const src = openTestDatabase();
    const source = await open(src);
    await src.withTransactionAsync(async (tx) => {
      for (let i = 0; i < 2000; i++) {
        await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'b', '[]', 1, 1)`, [`f${i}`, `walnut ${i}`]);
      }
    });
    const dump = await source.exportDump(['e1']);
    const db = openTestDatabase();
    const wiki = await open(db);
    await rawBacklog(db, 'e2', 5000);
    await wiki.importDump(dump, { merge: false });
    expect((await hits(wiki, 'e1', 'walnut')).length).toBe(2000);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.** `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/idThreading.test.ts` → FAIL (`UPSERT_ID_STASH_CAP` undefined; 7(r) same-entity leg drains only the 500 oldest e1 rows; 7(m′) drains one entity chunk). If `exportDump`/`importDump` rejects the raw-inserted source rows (a missing NOT NULL column, or an import validation such as a null `source_ref`), set that column to a valid value on the source rows: read the field named in the error in `ImportExportService.ts` and `PRAGMA table_info(llm_wiki_entries)`. Never weaken the 2000-hit assertion.

- [ ] **Step 3: SearchService.** Change `sync`'s signature to `sync(entityId?: string, opts?: { deadline?: number; ids?: readonly string[] })`; in its drain branch use `{ mode: 'ledger', entityId, ids: opts?.ids }` for the entity form. Doc: "`opts.ids` are the caller's touched ids: a ledger strategy drains them first, to completion; MiniSearch ignores them and rebuilds the entity in one scan." Change `syncStale` to `async syncStale(opts?: { ids?: readonly string[] }): Promise<void>` with `if (this.indexStrategy.drain) return this.drainTurn(undefined, { mode: 'full', ids: opts?.ids });`. Update Step-8-of-B1's routing test's expected second call to `{ mode: 'ledger', entityId: 'e1', ids: undefined }` (it still matches by `toEqual`) — no edit needed; re-run it.

- [ ] **Step 4: WikiMemory stash.** Add next to the re-init fields (`:273-277`):

```typescript
  /** Max upsertGraph node ids held for their post-commit sync (spec #280 id threading). */
  static readonly UPSERT_ID_STASH_CAP = 10_000;
  /** upsertGraph node ids per entity, awaiting syncSearchIndex(); drained ids are removed. */
  private upsertIdStash = new Map<string, Set<string>>();

  private stashUpsertIds(entityId: string, ids: readonly string[]): void {
    let size = 0;
    for (const s of this.upsertIdStash.values()) size += s.size;
    const cap = (this.constructor as typeof WikiMemory).UPSERT_ID_STASH_CAP;
    const set = this.upsertIdStash.get(entityId) ?? new Set<string>();
    for (const id of ids) {
      if (set.has(id)) continue;
      if (size >= cap) break; // overflow: the entity-targeted / full-quantum drain covers the rest
      set.add(id);
      size++;
    }
    if (set.size > 0) this.upsertIdStash.set(entityId, set);
  }

  private takeStashedIds(entityId?: string): string[] {
    if (entityId !== undefined) {
      const ids = [...(this.upsertIdStash.get(entityId) ?? [])];
      this.upsertIdStash.delete(entityId);
      return ids;
    }
    const all = [...this.upsertIdStash.values()].flatMap((s) => [...s]);
    this.upsertIdStash.clear();
    return all;
  }
```

In `upsertGraph`, replace the comment + call at `:897-900` with:

```typescript
    // Core never sees this commit. Under a ledger strategy the triggers already
    // recorded the rows: stash the node ids so the host's post-commit
    // syncSearchIndex() drains them first, to completion, under any backlog.
    // MiniSearch has no ledger: markStale makes that sync rebuild the entity.
    this.stashUpsertIds(entityId, params.nodes.map((n) => n.id));
    this.searchService.markStale(entityId);
```

In `syncSearchIndex`, change `:740` to `return this.searchService.syncStale({ ids: this.takeStashedIds() });` and `:743` to `return this.searchService.syncEntries(entityId, this.takeStashedIds(entityId));`.

- [ ] **Step 5: Import.** Replace `ImportExportService.ts:444-453` with:

```typescript
    // Index only what this call wrote (#232): a whole-entity rebuild here made
    // chunked imports quadratic. merge=false replaces the entity, so it passes
    // every touched id (upserted + soft-deleted): a ledger strategy drains them
    // to completion under any foreign backlog (spec #280 7(m′)), while MiniSearch
    // ignores the ids and rebuilds the entity in one scan, which beats feeding
    // those same ids back through chunked id-parameterized reads.
    if (merge) {
      await this.searchService.syncEntries(entityId, [...upsertedFactIds]);
    } else {
      await this.searchService.sync(entityId, { ids: [...upsertedFactIds, ...softDeletedFactIds] });
    }
```

- [ ] **Step 6: Docs.** Replace the `syncSearchIndex` JSDoc's second paragraph (`:686-693`) with:

```typescript
   * With `entityId`: drains that entity's pending `upsertGraph` node ids first,
   * to completion, then at most one more ledger chunk — so its new nodes are
   * searchable when the call resolves, under any backlog. Without an
   * argument: drains every stashed `upsertGraph` id across entities first,
   * then runs one keyword-index quantum bounded by `config.setupBudgetMs`
   * (backlog drain, then rebuild work while the index is rebuilding). Hosts
   * with a long-lived process should call the no-arg form on their own
   * schedule: that is what converges a rebuilding index. While keyword search
   * is unavailable it first retries the index init; after a failed attempt it
   * waits at least 5 s, doubling per consecutive failure up to 5 min (longer
   * when an attempt is itself slow), before retrying again.
```

and in the `upsertGraph` JSDoc replace "to make the new nodes keyword-searchable." (`:823`) with "to make the new nodes keyword-searchable: both forms drain this call's node ids first, to completion, so the nodes are searchable under any backlog (up to `WikiMemory.UPSERT_ID_STASH_CAP` pending ids; beyond that they converge with the backlog).".

- [ ] **Step 7: Run Step 1's file — expect PASS.** Re-run `__tests__/fts5Integration.test.ts __tests__/upsertGraphContract.test.ts __tests__/incrementalSearchIndex.test.ts __tests__/searchServiceDrain.test.ts` — PASS.

- [ ] **Step 8: Gate.** Full suite + typecheck.

- [ ] **Step 9: Commit.**

```bash
git add packages/core/src/WikiMemory.ts packages/core/src/services/SearchService.ts packages/core/src/services/ImportExportService.ts \
  packages/core/__tests__/idThreading.test.ts
git commit -m "feat(core): thread upsertGraph and import ids into the FTS drain (#280 B5)"
```

---

### Task B6: VACUUM reset (rebuild side)

- **Scope:** `MetadataRepository.vacuum()` (already clearing the normalize watermarks since A3) also resets the rebuild watermark, fingerprint and sweep cursor when state is `rebuilding` (restart from 0).
- **Tests:** 7(k) including in-process `runPrune({ vacuum: true })` followed by `syncSearchIndex()` in the same process → completes exactly-once.

**Rev 8 source check (D5):** `MetadataRepository.vacuum()` (`:160-163`) only checkpoints and VACUUMs. The normalize reset is in `MaintenanceService.runPrune` (`:346-350`): `resetNormalizeWatermarks` then `metadataRepo.vacuum()`. Putting the FTS reset in `MetadataRepository` would reintroduce the import cycle PR-A avoided, so B6 adds it to the same `runPrune` branch, **after** the VACUUM, so the new snapshot reads post-VACUUM rowids. A quantum that runs between the VACUUM and the reset tx hits the fingerprint check (B3) and restarts on its own.

**Interfaces:**
- Produces: `restartRebuildAfterVacuum(db, prefix, meta)` in `fts5Progress.ts`.
- Consumes: B2's `writeRebuildStart`; B3's fingerprint check.

- [ ] **Step 1: Write the failing tests** — create `packages/core/__tests__/fts5Vacuum.test.ts`:

```typescript
// packages/core/__tests__/fts5Vacuum.test.ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
const stub = { llmProvider: { generateText: async () => '{}' } };
const cfg = (setupBudgetMs?: number) => ({ ...stub, config: { indexStrategy: 'fts5' as const, ...(setupBudgetMs ? { setupBudgetMs } : {}) } });

async function rebuildingStore(): Promise<{ db: SQLiteAdapter; wiki: WikiMemory; meta: MetadataRepository }> {
  const db = openTestDatabase();
  await new WikiMemory(db, cfg()).setup();
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < 1500; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'b', '[]', 1, 1)`, [`r${i}`, `cedar ${i}`]);
    }
  });
  await db.runAsync(`DELETE FROM ${P}meta WHERE key = 'fts5_index_state'`);
  const wiki = new WikiMemory(db, cfg(1));
  await wiki.setup(); // re-arm + one window
  return { db, wiki, meta: new MetadataRepository(db, P) };
}
const wm = async (meta: MetadataRepository) => JSON.parse((await meta.getMeta('fts5_rebuild_wm'))!);
async function expectExactlyOnce(db: SQLiteAdapter): Promise<void> {
  const live = await db.getAllAsync<{ id: string }>(`SELECT id FROM ${P}entries WHERE deleted_at IS NULL ORDER BY id`);
  expect(await db.getAllAsync<{ id: string }>(`SELECT id FROM ${P}entries_fts ORDER BY id`)).toEqual(live);
  expect((await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}fts_map`))!.n).toBe(live.length);
}

describe('7(k) VACUUM guard (#280 B6)', () => {
  it('in-process runPrune({ vacuum: true }) restarts the rebuild from 0; syncSearchIndex() then completes exactly once', async () => {
    const { db, wiki, meta } = await rebuildingStore();
    expect((await wm(meta)).rowid).toBeGreaterThan(0);
    await wiki.runPrune('e1', { retainSoftDeletedFor: null, retainEventsFor: null, vacuum: true });
    expect(await wm(meta)).toEqual({ rowid: 0, id: null });
    expect(await meta.getMeta('fts5_orphan_sweep_cursor')).toBe('0');
    for (let i = 0; i < 50 && (await meta.getMeta('fts5_index_state')) !== 'live'; i++) await wiki.syncSearchIndex();
    expect(await meta.getMeta('fts5_index_state')).toBe('live');
    await expectExactlyOnce(db);
  });

  it('a post-VACUUM open (rowids renumbered outside the engine) detects the stale fingerprint and restarts', async () => {
    const { db, meta } = await rebuildingStore();
    await db.runAsync(`UPDATE ${P}entries SET rowid = rowid + 100000`); // what an external VACUUM may do
    await new WikiMemory(db, cfg(1)).setup();
    const after = await wm(meta);
    expect(after.rowid === 0 || after.rowid > 100000).toBe(true); // restarted, then possibly one window
    for (let i = 0; i < 50 && (await meta.getMeta('fts5_index_state')) !== 'live'; i++) await new WikiMemory(db, cfg(1)).setup();
    expect(await meta.getMeta('fts5_index_state')).toBe('live');
    await expectExactlyOnce(db);
  });

  it('a live store is untouched by the vacuum reset', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, cfg());
    await wiki.setup();
    await wiki.runPrune('e1', { retainSoftDeletedFor: null, retainEventsFor: null, vacuum: true });
    const meta = new MetadataRepository(db, P);
    expect(await meta.getMeta('fts5_index_state')).toBe('live');
    expect(await meta.getMeta('fts5_rebuild_wm')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** on the first test (the watermark survives the VACUUM). `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/fts5Vacuum.test.ts`

- [ ] **Step 3: Implement.** Append to `fts5Progress.ts`:

```typescript
/**
 * After an in-process VACUUM (which may renumber entries rowids): a
 * `rebuilding` index restarts its windows and sweep from 0 against fresh
 * snapshots. A `live` index has nothing to reset.
 */
export async function restartRebuildAfterVacuum(db: SQLiteAdapter, prefix: string, meta: MetadataRepository): Promise<void> {
  await db.withTransactionAsync(async (tx) => {
    if ((await meta.getMeta(FTS5_STATE_KEY, tx)) !== 'rebuilding') return;
    await writeRebuildStart(tx, prefix, meta);
  });
}
```

In `MaintenanceService.runPrune`'s vacuum branch (`:346-350`):

```typescript
      if (vacuum) {
        // VACUUM may renumber rowids; a watermark must never survive it.
        await resetNormalizeWatermarks(this.metadataRepo);
        await this.metadataRepo.vacuum();
        // After it, so the restarted FTS rebuild snapshots the renumbered rowids (spec #280 7(k)).
        await restartRebuildAfterVacuum(this.db, this.prefix, this.metadataRepo);
      }
```

with `import { restartRebuildAfterVacuum } from './search/fts5Progress';`.

- [ ] **Step 4: Run Step 1's file — expect PASS.**
- [ ] **Step 5: Gate.** Full suite + typecheck.
- [ ] **Step 6: Commit.**

```bash
git add packages/core/src/services/search/fts5Progress.ts packages/core/src/services/MaintenanceService.ts packages/core/__tests__/fts5Vacuum.test.ts
git commit -m "feat(core): in-process VACUUM restarts a rebuilding FTS index (#280 B6)"
```

---

### Task B7: integration acceptance + full-suite gate

- Promote the leg harness to integration tests: 7(j), 7(g), 7(a) on a ≥2k-row store; rewrite `createIndexStrategy.test.ts`'s remaining old-rebuild assertions; full suite, typecheck, build. Commit body lists every rewritten test.

**Rev 8 source check:** the "leg harness" (`.sandbox/profile-setup.ts`) was never committed (see A8), so "promote" means writing WikiMemory-level integration tests. B2 Step 7 already rewrote the `createIndexStrategy.test.ts` fixtures (D10). B7 re-greps for leftovers.

- [ ] **Step 1: Write the integration tests** — create `packages/core/__tests__/fts5StateMachineIntegration.test.ts`:

```typescript
// packages/core/__tests__/fts5StateMachineIntegration.test.ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { fts5TriggerNames } from '../src/services/search/fts5Sql';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
const N = 2400;
const stub = { llmProvider: { generateText: async () => '{}' } };
const open = async (db: SQLiteAdapter, setupBudgetMs = 1) => {
  const w = new WikiMemory(db, { ...stub, config: { indexStrategy: 'fts5', setupBudgetMs } });
  await w.setup();
  return w;
};
const stateOf = (db: SQLiteAdapter) => new MetadataRepository(db, P).getMeta('fts5_index_state');
async function builtStore(): Promise<SQLiteAdapter> {
  const db = openTestDatabase();
  await open(db, 1500);
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < N; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'b', '[]', 1, 1)`, [`r${i}`, `cedar ${i}`]);
    }
  });
  await open(db, 60_000); // drain the backlog: live, fully indexed
  expect(await stateOf(db)).toBe('live');
  return db;
}
async function expectExactlyOnce(db: SQLiteAdapter): Promise<void> {
  const live = await db.getAllAsync<{ id: string; title: string }>(`SELECT id, title FROM ${P}entries WHERE deleted_at IS NULL ORDER BY id`);
  expect(await db.getAllAsync(`SELECT id, title FROM ${P}entries_fts ORDER BY id`)).toEqual(live);
  expect((await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}fts_map`))!.n).toBe(live.length);
}
async function convergeByOpens(db: SQLiteAdapter, max = 100): Promise<WikiMemory> {
  let w = await open(db);
  for (let i = 0; i < max && (await stateOf(db)) !== 'live'; i++) w = await open(db);
  expect(await stateOf(db)).toBe('live');
  return w;
}

describe('FTS state machine, integration (#280 B7, ≥2k rows)', () => {
  it('7(g) marker + trigger loss: re-arm on open, triggers present after the transition and after a mid-rebuild resume', async () => {
    const db = await builtStore();
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = 'fts5_index_state'`);
    await db.execAsync(`DROP TRIGGER ${fts5TriggerNames(P)[2]}`);
    await open(db);
    expect(await stateOf(db)).toBe('rebuilding');
    const trig = async () => (await db.getAllAsync(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)).length;
    expect(await trig()).toBe(3);
    await open(db); // mid-rebuild resume
    expect(await trig()).toBe(3);
    const w = await convergeByOpens(db);
    await expectExactlyOnce(db);
    expect((await w.__testAccess.searchService.searchKeyword('cedar', ['e1'], 10_000)).length).toBe(N);
  });

  it('7(j) resume across opens from watermark K is exactly-once', async () => {
    const db = await builtStore();
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = 'fts5_index_state'`);
    await open(db); await open(db); await open(db);
    const wm = JSON.parse((await new MetadataRepository(db, P).getMeta('fts5_rebuild_wm'))!);
    expect(wm.rowid).toBeGreaterThan(0);
    expect(wm.rowid).toBeLessThan(N);
    await convergeByOpens(db);
    await expectExactlyOnce(db);
  });

  it('7(a) concurrent writes between opens, incl. drain-before-window, stay exactly-once', async () => {
    const db = await builtStore();
    await db.runAsync(`DELETE FROM ${P}meta WHERE key = 'fts5_index_state'`);
    const w = await open(db);
    await db.runAsync(`UPDATE ${P}entries SET title = 'zebra' WHERE id = 'r2300'`);
    await w.__testAccess.searchService.syncEntries('e1', ['r2300']); // drained ahead of its window
    for (let i = 0; i < 5; i++) {
      await db.runAsync(`UPDATE ${P}entries SET title = ? WHERE id = ?`, [`yak ${i}`, `r${i * 400}`]);
      await db.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', 'new', 'b', '[]', 1, 1)`, [`n${i}`]);
      await open(db);
    }
    const last = await convergeByOpens(db);
    await expectExactlyOnce(db);
    expect((await last.__testAccess.searchService.searchKeyword('zebra', ['e1'], 10)).map((r) => r.id)).toEqual(['r2300']);
  });
});
```

- [ ] **Step 2: Run it.** `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/fts5StateMachineIntegration.test.ts` → PASS (B1–B6 implement it; a failure here is a real bug: debug it, do not loosen the test).
- [ ] **Step 3: Leftover sweep.** `grep -rn "rebuildSql\|rebuildFromSource\|rebuildInTx\|toBe('live')" packages/core/__tests__/createIndexStrategy.test.ts packages/core/__tests__/fts5*.test.ts`. Every remaining `toBe('live')` must follow either `{ entriesExisted: false }` or a converging drain; rewrite any that doesn't, and note it for the commit body. `rebuild*` must have zero hits.
- [ ] **Step 4: Gate.** Full suite (no assertion failures; completed ≥ 1904 + every B-task test), typecheck, then `pnpm -r build` — all clean.
- [ ] **Step 5: Commit.** `git add packages/core/__tests__ && git commit -m "test(core): FTS state machine integration acceptance on a 2.4k-row store (#280 B7)"`. The body lists every test file rewritten across B2–B7 and why (B2 fixture moves; the B3 convergence restorations; Step 3 leftovers).

---

### Task B8 (controller): measurements, sign-off, PR-B

- @1M: keep-map window rate (the spec's ≤3.5 s claim is extrapolated until this is measured) and the rename-retire reclamation profile (rename, per-step delete/merge, final DROP). Apply the reclamation rule: bounded ⇒ in-quantum; not bounded ⇒ hand-off via `retiredTables` (finish Task B4's last bullet).
- ~4.7 GB NVMe legs (background, ~30–45 min each): steady-state fence (Acceptance 4), crash backlog (5), first-migration open (6), and the largest observed chunk commit time.
- Record the SynapseTree host-contract sign-off (scheduled no-arg `syncSearchIndex()` + `migrations: 'refuse'` procedure) in the spec review log; spec rev 13 with all numbers.
- Open PR-B with `Fixes #280`; CI green; ready; merge is the maintainer's call.

**Rev 8 source check:** there is no committed benchmark harness on `main`; A8 (deferred) defines one (F10). The spec's numbering puts PR-A's measurements at rev 12; if A8 has not run by then, B8's spec revision takes the next free number. Check the spec Status line first and never reuse a number.

- [ ] **Step 1: Harness.** If `bench/issue280/` is absent on the branch, do A8 Steps 1–2 first (same rules: stores under `ISSUE280_STORE_DIR`, never `/tmp`, never commit a `.db`, record the machine). Add a `--leg <window|reclaim>` to `profileSetup.ts`:
  - `window`: on a copy of the 1M store, delete the `fts5_index_state` meta row (marker loss), open once with `setupBudgetMs: 1500`, then time `syncSearchIndex()` calls until `live`. Report the per-quantum wall (median, max), windows per quantum, rows/s, and the max single window-tx commit time (wrap `withTransactionAsync`).
  - `reclaim`: on a copy, force the tokenizer-mismatch reset (B4 test recipe), time the RENAME tx, then each reclamation step (delete-chunk, merge, final DROP) separately until `fts5_retired_tables` is empty. Report the count, median and max per step type, and the final DROP time.
  Verify both legs on a 10k store first.
- [ ] **Step 2: Run @1M**, then add the results to `bench/issue280/README.md` with the machine table.
- [ ] **Step 3: Reclamation rule.** If the final DROP after reclamation is bounded (≪ 22.3 s, same order as one chunk), keep reclamation in-quantum and stop here. If not, implement the hand-off (F1 shape, after the maintainer confirms the name):
  - `types.ts`: add `| { type: 'fts_retired_tables'; tables: number }` to `PendingMigrationWork`.
  - `sourceRefNormalize.ts` `probePendingWork`: after the normalize check, `const retired = parseJsonArray<unknown>(await meta.getMeta('fts5_retired_tables'), [])`; if `retired.length > 0` return `{ type: 'fts_retired_tables', tables: retired.length }`.
  - `migrationGate.ts`: `'auto'` lets it through (like the normalize); `describePending` gets a third branch: `` `${pending.tables} retired keyword-index table(s) await reclamation` ``.
  - `Fts5IndexStrategy`: in-quantum reclamation is skipped; plain `setup()` under `'allow'`/`'auto'` reclaims every retired table to completion after `init()` (not budgeted).
  - Test 7(u)(iv): a store with a retired table → `setup({ migrations: 'refuse' })` rejects with `pendingWork: { type: 'fts_retired_tables', tables: 1 }`; a plain `setup()` then drops it, and a following `'refuse'` open passes.
  - Commit `feat(core): hand retired FTS table reclamation to the migration gate (#280 B8)`.
- [ ] **Step 4: 4.7 GB legs** (background, ~30–45 min each, NVMe): Acceptance 4, 5, 6 and the largest chunk commit. Do not tune code to hit a target; record and report misses.
- [ ] **Step 5: Spec revision (append only).** Add a new revision entry to the spec Status line and a "PR-B measurements" subsection with every number from Steps 2–4, the reclamation decision, and the SynapseTree host-contract sign-off in the review log. **Do not record the sign-off without the maintainer's explicit confirmation.** Commit `docs(spec): issue280 rev <N> - PR-B measurements and sign-off`.
- [ ] **Step 6: PR.** Push the branch; `gh pr create --base main --title "feat(core): FTS state machine, budgeted drains, rename-retire (#280 PR-B)"`. The body says `Fixes #280` (the ONLY place that keyword may appear) and ends with the attribution line. Then run `git log main..HEAD --format=%B | grep -Ei "(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved) #[0-9]+"`; it must print nothing. Run `gh pr checks <n>` and do not claim green without seeing it.
- [ ] **Step 7: STOP.** Report. `gh pr ready` and the merge (merge commit, never squash) are the maintainer's call.

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
| `monotonicNow()` | B1 `utils/monotonicNow.ts` (moved from `WikiMemory.ts:65-66`) | B1 `setup()` deadline + re-init backoff, `Fts5IndexStrategy` |
| `DEFAULT_SETUP_BUDGET_MS = 1500`, `WikiConfig.setupBudgetMs` | B1 `utils/setupDefaults.ts`, `types.ts` (exported from `index.ts`) | B1 `setup()`, `createIndexStrategy`, `Fts5IndexStrategy` ctor |
| `DrainOptions { deadline?; mode?: 'ledger' \| 'full'; ids?; entityId? }`, `IndexStrategy.drain?(opts?)` | B1 `search/IndexStrategy.ts` | B1 `SearchService.drainTurn`, `UnavailableIndexStrategy`, B3/B4 `fullQuantum` |
| `Fts5IndexStrategy(db, prefix, metadataRepo, budgetMs = DEFAULT_SETUP_BUDGET_MS)` | B1 | `createIndexStrategy` |
| `createIndexStrategy(db, prefix, metadataRepo, preferred, opts?: { setupBudgetMs?; entriesExisted? })` | B1 (budget), B2 (`entriesExisted`) | `WikiMemory.setup()` (both), `syncSearchIndex()` re-init (budget only) |
| `SearchService.sync(entityId?, opts?: { deadline?; ids? })`, `syncStale(opts?: { ids? })` | B1 (`deadline`), B5 (`ids`, F6) | `setup()` (`deadline: openDeadline`), `ImportExportService` merge=false, `syncSearchIndex()` |
| `fts5PendingIndexesDdl`, `idDrainChunkSql`, `entityDrainHiSql`, `entityDrainChunkSql` | B1 `fts5Sql.ts` | B1 `MIGRATIONS[15]`, `Fts5IndexStrategy` |
| `IndexStrategy.init?(opts?: { entriesExisted? })` | B2 | `createIndexStrategy` |
| `FTS5_REBUILD_WM_KEY` (`'fts5_rebuild_wm'`), `FTS5_REBUILD_SNAPSHOT_KEY` (`'fts5_rebuild_snapshot'`), `FTS5_SWEEP_CURSOR_KEY` (`'fts5_orphan_sweep_cursor'`) | B2 `fts5Sql.ts` | B2–B6 |
| `RebuildWatermark`, `RebuildProgress`, `writeRebuildStart`, `readRebuildProgress` | B2 `search/fts5Progress.ts` | B2 re-arm, B3 quantum/flip, B6 |
| `windowHiSql`, `windowChunkSql`, `sweepHiSql`, `sweepChunkSql`, `FTS5_SWEEP_CHUNK` | B3 `fts5Sql.ts` | B3 `Fts5IndexStrategy` |
| `reanchorRebuildFingerprint(tx, prefix, deletedIds)` | B3 `fts5Progress.ts` | B3 `EntryRepository.bulkDeletePruned` |
| `FTS5_RETIRED_TABLES_KEY` (`'fts5_retired_tables'`), `FTS5_RETIRED_COUNTER_KEY`, `FTS5_RECLAIM_MERGE_PAGES`, `retiredTableName`, `isRetiredTableName`, `ftsCorruptionClass` | B4 `fts5Sql.ts`, `Fts5IndexStrategy.ts` | B4, B8 (hand-off) |
| `restartRebuildAfterVacuum(db, prefix, meta)` | B6 `fts5Progress.ts` | B6 `MaintenanceService.runPrune` |
| `WikiMemory.UPSERT_ID_STASH_CAP`, private `upsertIdStash` | B5 | B5 `upsertGraph`, `syncSearchIndex` |
| `PendingMigrationWork` third variant (proposed `{ type: 'fts_retired_tables'; tables }`, F1) | B8, only on hand-off | `probePendingWork`, `setupDatabaseWithGate` |

**Rev 8 correction note (A rows above are kept as written):** `EntryRepository.hasStoredEmbedding` was never shipped. `gateNeedsKeyword` (`librarian/ops/gate.ts:112`) uses the private `loadStoredVectors` (`gate.ts:90`) and `EntryRepository.hasLiveEntry` (`EntryRepository.ts:152`). `readSchemaVersion` shipped as `detectSchemaVersion`, and `probePendingWork(db, meta, prefix)` lives in `db/sourceRefNormalize.ts`, with `db/migrationGate.ts` holding `setupDatabaseWithGate`. The normalize-watermark VACUUM reset is in `MaintenanceService.runPrune`, not `MetadataRepository.vacuum`.
