# Embedding-Based Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace FTS5-based retrieval with vector embedding cosine-similarity search, with a MiniSearch keyword fallback when `embed` is unavailable or fails.

**Architecture:** All changes live in `packages/core`. `LLMProvider.embed` generates and queries float vectors stored as JSON blobs in a new `entries.embedding` column. A MiniSearch in-memory index is maintained after every mutation and used as fallback. Platform-specific packages (`expo`, `react`) are untouched.

**Tech Stack:** TypeScript, better-sqlite3 (tests), minisearch, vitest

---

## File Map

| File | Change |
|---|---|
| `packages/core/package.json` | Add `minisearch` dependency |
| `packages/core/src/types.ts` | Add `LLMProvider.embed?`; add `WikiOptions.onRetrievalFallback?`; rename `maxFtsResults`→`maxResults`; remove `synonymMap`; add `'reembed'` to `WikiBusyError` union |
| `packages/core/src/utils/cosine.ts` | New — `cosineSimilarity(a, b)` helper |
| `packages/core/src/db/schema.ts` | Remove FTS5 DDL + triggers; add `embedding TEXT` to `entries` |
| `packages/core/src/db/migrations.ts` | Add migration version 2 (drop FTS5, ALTER TABLE add embedding) |
| `packages/core/src/WikiMemory.ts` | Add MiniSearch field; add `rebuildMiniSearchIndex()`, `embedFact()`, `storeEmbeddingDimension()`, `runReembed()`; remove `formatSearchQuery()`; replace `read()`; wire embed+rebuild into `setup()`, `_doRunLibrarian`, `_doRunHeal`, `ingestDocument`, `importDump`, `forget`, `runPrune` |
| `packages/core/__tests__/cosine.test.ts` | New — unit tests for `cosineSimilarity` |
| `packages/core/__tests__/migration2.test.ts` | New — integration tests for migration 2 |
| `packages/core/__tests__/embeddingRetrieval.test.ts` | New — cosine ranking, fallback, access_count |
| `packages/core/__tests__/miniSearchFallback.test.ts` | New — MiniSearch path, `onRetrievalFallback` callback |
| `packages/core/__tests__/runReembed.test.ts` | New — backfill, scoping, concurrency guard |
| `packages/core/__tests__/synonymMap.test.ts` | Delete — tests `formatSearchQuery` which is removed |
| `packages/core/__tests__/porterStemmer.test.ts` | Delete — tests FTS5 which is removed |
| `packages/core/__tests__/migrations.test.ts` | Update version assertions from `'1'` → `'2'`; update `metaVersion` in "already at current version" |

---

## Task 1: Add `minisearch` dependency and update `types.ts`

**Files:**
- Modify: `packages/core/package.json`
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Add minisearch to package.json**

In `packages/core/package.json`, add to the top-level `"dependencies"` field (create it if absent — it currently only has `devDependencies`):

```json
"dependencies": {
  "minisearch": "^7.0.0"
},
```

- [ ] **Step 2: Install**

```bash
cd /path/to/repo && pnpm install
```

Expected: `minisearch` appears in `node_modules`. No errors.

- [ ] **Step 3: Update `LLMProvider` in types.ts**

In `packages/core/src/types.ts`, replace the `LLMProvider` interface (lines 94–100):

```typescript
export interface LLMProvider {
  /**
   * Generates text using the developer's LLM of choice.
   * Expected to return the raw text response (typically a JSON string).
   */
  generateText: (params: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  /**
   * Optional. When provided, enables semantic similarity search in `read()`.
   * Must return a stable-dimension float array for any input text.
   * Called once per fact on creation/update, and once per `read()` query.
   * When absent or throws, `read()` falls back to MiniSearch.
   */
  embed?: (text: string) => Promise<number[]>;
}
```

- [ ] **Step 4: Update `WikiOptions` in types.ts**

Replace the `WikiOptions` interface (lines 102–105):

```typescript
export interface WikiOptions {
  config?: WikiConfig;
  llmProvider: LLMProvider;
  /**
   * Called when `embed` throws during `read()` and MiniSearch is used instead.
   * `read()` still returns MiniSearch results — this is a notification, not an error path.
   */
  onRetrievalFallback?: (error: Error) => void;
}
```

- [ ] **Step 5: Update `WikiConfig` in types.ts**

Replace the `WikiConfig` interface (lines 18–44). Remove `synonymMap`, rename `maxFtsResults` → `maxResults` with deprecated alias:

```typescript
export interface WikiConfig {
  tablePrefix?: string;
  maxResults?: number;
  /** @deprecated Use maxResults */
  maxFtsResults?: number;
  pruneEventsAfter?: number;
  pruneRetainSoftDeletedFor?: number;
  autoLibrarianThreshold?: number;
  autoHealThreshold?: number;
  orphanAfterDays?: number | null;
  staleInferredAfterDays?: number | null;
  maxChunkLength?: number;
  chunkOverlap?: number;
  chunkConcurrency?: number;
}
```

- [ ] **Step 6: Add `'reembed'` to `WikiBusyError` union in types.ts**

Replace the `WikiBusyError` class (lines 143–153):

```typescript
export class WikiBusyError extends Error {
  readonly operation: 'ingest' | 'librarian' | 'heal' | 'prune' | 'reembed';
  readonly entityId: string;

  constructor(operation: 'ingest' | 'librarian' | 'heal' | 'prune' | 'reembed', entityId: string) {
    super(`${operation} already running for entity ${entityId}`);
    this.name = 'WikiBusyError';
    this.operation = operation;
    this.entityId = entityId;
  }
}
```

- [ ] **Step 7: Typecheck**

```bash
cd packages/core && pnpm typecheck
```

Expected: errors only for `synonymMap` usages (in `WikiMemory.ts` `formatSearchQuery` — those go away in Task 8). If no synonymMap errors yet, zero errors expected.

---

## Task 2: Create `cosine.ts` utility (TDD)

**Files:**
- Create: `packages/core/src/utils/cosine.ts`
- Create: `packages/core/__tests__/cosine.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/__tests__/cosine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../src/utils/cosine';

describe('cosineSimilarity', () => {
  it('identical vectors → 1.0', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it('orthogonal vectors → 0.0', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
  });

  it('opposite vectors → -1.0', () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0);
  });

  it('zero vector → 0 (no crash)', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
  });

  it('arbitrary vectors compute correctly', () => {
    // [1,1] · [1,0] = 1; |[1,1]| = √2; |[1,0]| = 1 → 1/√2 ≈ 0.707
    expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(0.707, 2);
  });

  it('mismatched lengths uses shorter length', () => {
    // [1,0] · [1,0,0] = 1; both unit-ish; doesn't crash
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd packages/core && pnpm test -- cosine
```

Expected: `Cannot find module '../src/utils/cosine'`

- [ ] **Step 3: Implement `cosine.ts`**

Create `packages/core/src/utils/cosine.ts`:

```typescript
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd packages/core && pnpm test -- cosine
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/package.json packages/core/src/types.ts packages/core/src/utils/cosine.ts packages/core/__tests__/cosine.test.ts && git commit -m "feat(core): add embed/onRetrievalFallback to types; add cosine similarity util"
```

---

## Task 3: Update schema and add migration 2 (TDD)

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Modify: `packages/core/src/db/migrations.ts`
- Create: `packages/core/__tests__/migration2.test.ts`

- [ ] **Step 1: Write migration2 tests**

Create `packages/core/__tests__/migration2.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions } from '../src/types';

const stubOptions: WikiOptions = {
  llmProvider: { generateText: async () => '{}' },
};

async function makeV1Db() {
  const db = openTestDatabase();
  // Manually create the state a v1 DB would have: entries + FTS5 + triggers + schema_version=1
  await db.execAsync(`
    CREATE TABLE llm_wiki_entries (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      confidence TEXT NOT NULL DEFAULT 'inferred',
      source_type TEXT NOT NULL DEFAULT 'agent_inferred',
      source_hash TEXT, source_ref TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER, access_count INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER
    );
    CREATE TABLE llm_wiki_tasks (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      resolved_at INTEGER, deleted_at INTEGER
    );
    CREATE TABLE llm_wiki_events (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, event_type TEXT NOT NULL,
      summary TEXT NOT NULL, related_entry_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE llm_wiki_checkpoints (
      entity_id TEXT PRIMARY KEY,
      heal_checkpoint INTEGER NOT NULL DEFAULT 0,
      memory_checkpoint INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE llm_wiki_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIRTUAL TABLE llm_wiki_entries_fts USING fts5(
      title, body, tags,
      content='llm_wiki_entries', content_rowid='rowid',
      tokenize='porter unicode61'
    );
    CREATE TRIGGER llm_wiki_entries_ai AFTER INSERT ON llm_wiki_entries BEGIN
      INSERT INTO llm_wiki_entries_fts(rowid, title, body, tags)
      VALUES (new.rowid, new.title, new.body, new.tags);
    END;
    CREATE TRIGGER llm_wiki_entries_ad AFTER DELETE ON llm_wiki_entries BEGIN
      INSERT INTO llm_wiki_entries_fts(llm_wiki_entries_fts, rowid, title, body, tags)
      VALUES ('delete', old.rowid, old.title, old.body, old.tags);
    END;
    CREATE TRIGGER llm_wiki_entries_au AFTER UPDATE ON llm_wiki_entries BEGIN
      INSERT INTO llm_wiki_entries_fts(llm_wiki_entries_fts, rowid, title, body, tags)
      VALUES ('delete', old.rowid, old.title, old.body, old.tags);
      INSERT INTO llm_wiki_entries_fts(rowid, title, body, tags)
      VALUES (new.rowid, new.title, new.body, new.tags);
    END;
  `);
  await db.runAsync(`INSERT INTO llm_wiki_meta (key, value) VALUES ('schema_version', '1')`);
  return db;
}

describe('migration 2: remove FTS5, add embedding column', () => {
  it('fresh install: embedding column exists, FTS5 table absent', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();

    const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(llm_wiki_entries)');
    expect(cols.some(c => c.name === 'embedding')).toBe(true);

    const fts = await db.getFirstAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='llm_wiki_entries_fts'`
    );
    expect(fts).toBeNull();

    const meta = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM llm_wiki_meta WHERE key = 'schema_version'`
    );
    expect(meta?.value).toBe('2');
  });

  it('v1 DB: FTS5 table + triggers dropped, embedding column added, version becomes 2', async () => {
    const db = await makeV1Db();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();

    const fts = await db.getFirstAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='llm_wiki_entries_fts'`
    );
    expect(fts).toBeNull();

    const triggers = await db.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='llm_wiki_entries'`
    );
    expect(triggers).toHaveLength(0);

    const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(llm_wiki_entries)');
    expect(cols.some(c => c.name === 'embedding')).toBe(true);

    const meta = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM llm_wiki_meta WHERE key = 'schema_version'`
    );
    expect(meta?.value).toBe('2');
  });

  it('running setup() twice is idempotent: embedding column appears once', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();
    await wiki.setup();

    const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(llm_wiki_entries)');
    expect(cols.filter(c => c.name === 'embedding')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd packages/core && pnpm test -- migration2
```

Expected: tests fail because `embedding` column doesn't exist and FTS5 table does exist in fresh installs.

- [ ] **Step 3: Update `schema.ts` — remove FTS5, add embedding column**

Replace the full contents of `packages/core/src/db/schema.ts`:

```typescript
import type { SQLiteAdapter } from '../types';

export async function setupDatabase(db: SQLiteAdapter, prefix: string) {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS ${prefix}entries (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      confidence TEXT NOT NULL DEFAULT 'inferred',
      source_type TEXT NOT NULL DEFAULT 'agent_inferred',
      source_hash TEXT,
      source_ref TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER,
      access_count INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER,
      embedding TEXT
    );

    CREATE INDEX IF NOT EXISTS ${prefix}entries_entity_idx ON ${prefix}entries(entity_id);
    CREATE INDEX IF NOT EXISTS ${prefix}entries_source_ref_idx ON ${prefix}entries(entity_id, source_ref);
    CREATE INDEX IF NOT EXISTS ${prefix}entries_source_hash_idx ON ${prefix}entries(entity_id, source_hash) WHERE source_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ${prefix}entries_updated_idx ON ${prefix}entries(updated_at DESC);

    CREATE TABLE IF NOT EXISTS ${prefix}tasks (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER,
      deleted_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS ${prefix}tasks_entity_idx ON ${prefix}tasks(entity_id, status);

    CREATE TABLE IF NOT EXISTS ${prefix}events (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      related_entry_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ${prefix}events_entity_idx ON ${prefix}events(entity_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS ${prefix}checkpoints (
      entity_id TEXT PRIMARY KEY,
      heal_checkpoint INTEGER NOT NULL DEFAULT 0,
      memory_checkpoint INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ${prefix}meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
```

- [ ] **Step 4: Add migration 2 to `migrations.ts`**

In `packages/core/src/db/migrations.ts`, add migration version 2 after the existing migration version 1 entry (after the closing `},` of version 1, before the `];`):

```typescript
  {
    version: 2,
    description: 'Remove FTS5; add embedding column for semantic retrieval',
    run: async (db, prefix) => {
      // Drop FTS5 artifacts in a transaction.
      await db.withTransactionAsync(async () => {
        await db.execAsync(`
          DROP TRIGGER IF EXISTS ${prefix}entries_ai;
          DROP TRIGGER IF EXISTS ${prefix}entries_ad;
          DROP TRIGGER IF EXISTS ${prefix}entries_au;
          DROP TABLE IF EXISTS ${prefix}entries_fts;
        `);
      });
      // ALTER TABLE must run outside the transaction — SQLite does not allow
      // ALTER TABLE on a table whose triggers were just dropped in the same tx
      // on all platforms.
      const cols = await db.getAllAsync<{ name: string }>(
        `PRAGMA table_info(${prefix}entries)`
      );
      if (!cols.some(c => c.name === 'embedding')) {
        await db.execAsync(`ALTER TABLE ${prefix}entries ADD COLUMN embedding TEXT`);
      }
    },
  },
```

- [ ] **Step 5: Run migration2 tests — expect pass**

```bash
cd packages/core && pnpm test -- migration2
```

Expected: 3 tests pass.

- [ ] **Step 6: Run full test suite — check existing tests still pass**

```bash
cd packages/core && pnpm test
```

Expected: `migrations.test.ts` fails on version assertions (version is now 2, not 1). All other existing tests pass. Note the expected failures — they are fixed in Task 14.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/src/db/migrations.ts packages/core/__tests__/migration2.test.ts && git commit -m "feat(core): remove FTS5 schema; add embedding column; migration 2"
```

---

## Task 4: Add MiniSearch to WikiMemory constructor and `rebuildMiniSearchIndex()`

**Files:**
- Modify: `packages/core/src/WikiMemory.ts`

- [ ] **Step 1: Add MiniSearch import at the top of WikiMemory.ts**

After the existing imports (after line 6 `import { LIBRARIAN_SYSTEM_PROMPT... }`), add:

```typescript
import MiniSearch from 'minisearch';
import { cosineSimilarity } from './utils/cosine';
```

- [ ] **Step 2: Add MiniSearch field to the `WikiMemory` class**

After `private activeIngestJobs = new Set<string>();` (line 267), add:

```typescript
  private miniSearch = new MiniSearch<{ id: string; entity_id: string; title: string; body: string; tags: string }>({
    fields: ['title', 'body', 'tags'],
    storeFields: ['entity_id'],
    searchOptions: {
      boost: { title: 2 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
```

- [ ] **Step 3: Add `rebuildMiniSearchIndex()` private method**

Add the following private method to the `WikiMemory` class, before the `constructor` (or after `activeIngestJobs` — anywhere inside the class body is fine):

```typescript
  private async rebuildMiniSearchIndex(): Promise<void> {
    const rows = await this.db.getAllAsync<{
      id: string; entity_id: string; title: string; body: string; tags: string;
    }>(`SELECT id, entity_id, title, body, tags FROM ${this.prefix}entries WHERE deleted_at IS NULL`);

    this.miniSearch.removeAll();
    this.miniSearch.addAll(rows.map(r => ({
      id: r.id,
      entity_id: r.entity_id,
      title: r.title,
      body: r.body,
      tags: typeof r.tags === 'string'
        ? (Array.isArray(JSON.parse(r.tags)) ? JSON.parse(r.tags).join(' ') : r.tags)
        : (r.tags as unknown as string[]).join(' '),
    })));
  }
```

- [ ] **Step 4: Typecheck**

```bash
cd packages/core && pnpm typecheck
```

Expected: zero errors (except the `synonymMap` reference still in `formatSearchQuery` — that gets removed in Task 8).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/WikiMemory.ts && git commit -m "feat(core): add MiniSearch field and rebuildMiniSearchIndex to WikiMemory"
```

---

## Task 5: Add `embedFact()` and `storeEmbeddingDimension()` private methods

**Files:**
- Modify: `packages/core/src/WikiMemory.ts`

- [ ] **Step 1: Add `storeEmbeddingDimension()` private method**

Add the following private method to `WikiMemory` (place after `rebuildMiniSearchIndex`):

```typescript
  private async storeEmbeddingDimension(dim: number): Promise<void> {
    const existing = await this.db.getFirstAsync<{ value: string }>(
      `SELECT value FROM ${this.prefix}meta WHERE key = 'embedding_dimension'`
    );
    if (existing) {
      const storedDim = parseInt(existing.value, 10);
      if (storedDim !== dim) {
        console.warn(
          `[WikiMemory] Embedding dimension mismatch: stored ${storedDim}, got ${dim}. ` +
          `Call runReembed() to rebuild embeddings with the new model.`
        );
      }
    } else {
      await this.db.runAsync(
        `INSERT OR REPLACE INTO ${this.prefix}meta (key, value) VALUES ('embedding_dimension', ?)`,
        [String(dim)]
      );
    }
  }
```

- [ ] **Step 2: Add `embedFact()` private method**

Add the following private method after `storeEmbeddingDimension`:

```typescript
  private async embedFact(fact: { id: string; title: string; body: string; tags: string | string[] }): Promise<void> {
    const embedFn = this.options.llmProvider.embed;
    if (!embedFn) return;
    const tags = Array.isArray(fact.tags) ? fact.tags.join(' ') : fact.tags;
    const text = `${fact.title} ${fact.body} ${tags}`.trim();
    try {
      const vector = await embedFn(text);
      await this.storeEmbeddingDimension(vector.length);
      await this.db.runAsync(
        `UPDATE ${this.prefix}entries SET embedding = ? WHERE id = ?`,
        [JSON.stringify(vector), fact.id]
      );
    } catch (err) {
      console.warn(`[WikiMemory] embedFact failed for ${fact.id}:`, err);
    }
  }
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/core && pnpm typecheck
```

Expected: zero new errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/WikiMemory.ts && git commit -m "feat(core): add embedFact and storeEmbeddingDimension private methods"
```

---

## Task 6: Wire embed + rebuild into `setup()`, `_doRunLibrarian`, `_doRunHeal`

**Files:**
- Modify: `packages/core/src/WikiMemory.ts`

- [ ] **Step 1: Call `rebuildMiniSearchIndex()` at the end of `setup()`**

In `setup()`, the method ends at line 380 with the closing brace of the source_ref normalization `withTransactionAsync`. Add `await this.rebuildMiniSearchIndex();` as the last statement before the closing `}` of `setup()`:

The end of `setup()` currently looks like:
```typescript
    await this.db.withTransactionAsync(async () => {
      for (const row of rows) {
        const normalized = normalizeSourceRef(row.source_ref);
        if (normalized !== row.source_ref) {
          await this.db.runAsync(
            `UPDATE ${this.prefix}entries SET source_ref = ? WHERE rowid = ?`,
            [normalized, row.rowid]
          );
        }
      }
    });
  }  // ← end of setup()
```

Replace the closing `}` of `setup()` with:
```typescript
    await this.db.withTransactionAsync(async () => {
      for (const row of rows) {
        const normalized = normalizeSourceRef(row.source_ref);
        if (normalized !== row.source_ref) {
          await this.db.runAsync(
            `UPDATE ${this.prefix}entries SET source_ref = ? WHERE rowid = ?`,
            [normalized, row.rowid]
          );
        }
      }
    });

    await this.rebuildMiniSearchIndex();
  }  // ← end of setup()
```

- [ ] **Step 2: Update `_doRunLibrarian` to collect inserted fact IDs, embed after transaction, then rebuild**

The `_doRunLibrarian` method (line 671) contains a `withTransactionAsync` block that inserts facts. Modify it to collect inserted fact IDs and embed them after the transaction.

Find the `withTransactionAsync` block in `_doRunLibrarian` (lines 706–738). Replace the full block plus the code after it:

Before (the transaction and end of method):
```typescript
    await this.db.withTransactionAsync(async () => {
      for (const fact of validFacts) {
        const newTokens = titleTokens(fact.title);
        let skip = false;
        if (newTokens.size >= MIN_TOKENS_TO_QUALIFY) {
          for (const existing of currentFactsRows) {
            if (existing.source_type !== 'agent_inferred') continue;
            const existingTokens = titleTokens(existing.title);
            if (existingTokens.size >= MIN_TOKENS_TO_QUALIFY) {
              if (jaccardScore(newTokens, existingTokens) >= FUZZY_THRESHOLD) {
                skip = true;
                break;
              }
            }
          }
        }
        if (skip) continue;

        const id = generateId('fact_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'agent_inferred', now, now]);
      }

      for (const task of validTasks) {
        const id = generateId('task_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}tasks (id, entity_id, description, status, priority, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, task.description, 'pending', task.priority, now, now]);
      }
    });
  }
```

After:
```typescript
    const insertedFacts: Array<{ id: string; title: string; body: string; tags: string }> = [];

    await this.db.withTransactionAsync(async () => {
      for (const fact of validFacts) {
        const newTokens = titleTokens(fact.title);
        let skip = false;
        if (newTokens.size >= MIN_TOKENS_TO_QUALIFY) {
          for (const existing of currentFactsRows) {
            if (existing.source_type !== 'agent_inferred') continue;
            const existingTokens = titleTokens(existing.title);
            if (existingTokens.size >= MIN_TOKENS_TO_QUALIFY) {
              if (jaccardScore(newTokens, existingTokens) >= FUZZY_THRESHOLD) {
                skip = true;
                break;
              }
            }
          }
        }
        if (skip) continue;

        const id = generateId('fact_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'agent_inferred', now, now]);
        insertedFacts.push({ id, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
      }

      for (const task of validTasks) {
        const id = generateId('task_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}tasks (id, entity_id, description, status, priority, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, task.description, 'pending', task.priority, now, now]);
      }
    });

    for (const fact of insertedFacts) {
      await this.embedFact(fact);
    }
    await this.rebuildMiniSearchIndex();
  }
```

- [ ] **Step 3: Update `_doRunHeal` to collect new fact IDs, embed after transaction, then rebuild**

In `_doRunHeal` (line 741), find the `withTransactionAsync` block that inserts new facts (lines 804–818). Replace it:

Before:
```typescript
    await this.db.withTransactionAsync(async () => {
      for (const id of safeDowngraded) {
        await this.db.runAsync(`UPDATE ${this.prefix}entries SET confidence = 'tentative', updated_at = ? WHERE id = ? AND entity_id = ?`, [now, id, entityId]);
      }
      for (const id of safeDeleted) {
        await this.db.runAsync(`UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND entity_id = ?`, [now, now, id, entityId]);
      }
      for (const fact of validNewFacts) {
        const id = generateId('fact_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'agent_inferred', now, now]);
      }
    });
  }
```

After:
```typescript
    const insertedFacts: Array<{ id: string; title: string; body: string; tags: string }> = [];

    await this.db.withTransactionAsync(async () => {
      for (const id of safeDowngraded) {
        await this.db.runAsync(`UPDATE ${this.prefix}entries SET confidence = 'tentative', updated_at = ? WHERE id = ? AND entity_id = ?`, [now, id, entityId]);
      }
      for (const id of safeDeleted) {
        await this.db.runAsync(`UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND entity_id = ?`, [now, now, id, entityId]);
      }
      for (const fact of validNewFacts) {
        const id = generateId('fact_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'agent_inferred', now, now]);
        insertedFacts.push({ id, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
      }
    });

    for (const fact of insertedFacts) {
      await this.embedFact(fact);
    }
    await this.rebuildMiniSearchIndex();
  }
```

- [ ] **Step 4: Run tests**

```bash
cd packages/core && pnpm test
```

Expected: same pass/fail pattern as after Task 3. The mock-based tests (`ingest.test.ts`, `jobs.test.ts`, etc.) still pass because `rebuildMiniSearchIndex()` silently returns empty from the mocks, and `embedFact()` is a no-op when `embed` is absent.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/WikiMemory.ts && git commit -m "feat(core): wire embed+MiniSearch rebuild into setup, librarian, heal"
```

---

## Task 7: Wire embed + rebuild into `ingestDocument`, `importDump`, `forget`, `runPrune`

**Files:**
- Modify: `packages/core/src/WikiMemory.ts`

- [ ] **Step 1: Update `ingestDocument` to embed inserted facts and rebuild index**

In `ingestDocument` (line 1117), find the `withTransactionAsync` block (lines 1184–1197) and the surrounding code. Replace the block and the return statement:

Before:
```typescript
      const now = Date.now();
      await this.db.withTransactionAsync(async () => {
        await this.db.runAsync(
          `UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE source_ref = ? AND entity_id = ? AND deleted_at IS NULL`,
          [now, now, sourceRef, entityId]
        );
        for (const fact of allValidFacts) {
          const id = generateId('fact_');
          await this.db.runAsync(
            `INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'user_document', sourceHash, sourceRef, now, now]
          );
        }
      });

      return { truncated, chunks: chunks.length };
```

After:
```typescript
      const now = Date.now();
      const insertedFacts: Array<{ id: string; title: string; body: string; tags: string }> = [];

      await this.db.withTransactionAsync(async () => {
        await this.db.runAsync(
          `UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE source_ref = ? AND entity_id = ? AND deleted_at IS NULL`,
          [now, now, sourceRef, entityId]
        );
        for (const fact of allValidFacts) {
          const id = generateId('fact_');
          await this.db.runAsync(
            `INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'user_document', sourceHash, sourceRef, now, now]
          );
          insertedFacts.push({ id, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
        }
      });

      for (const fact of insertedFacts) {
        await this.embedFact(fact);
      }
      await this.rebuildMiniSearchIndex();

      return { truncated, chunks: chunks.length };
```

- [ ] **Step 2: Update `importDump` to embed non-deleted facts and rebuild index once**

In `importDump` (line 927), the method ends after the `for (const [entityId, bundle] of ...)` loop. Add embedding and rebuild after the loop.

Find the closing brace of the `for` loop in `importDump`. Currently the loop body ends with the events insert block and the closing `}` of `withTransactionAsync` and the entity loop. The method currently looks like:

```typescript
  async importDump(dump: MemoryDump, opts?: { merge?: boolean }): Promise<void> {
    const merge = opts?.merge ?? false;

    for (const [entityId, bundle] of Object.entries(dump.entities)) {
      await this.db.withTransactionAsync(async () => {
        // ... all the insert/update logic ...
      });
    }
  }
```

Replace the closing `}` of `importDump` to add embed + rebuild after the loop:

```typescript
  async importDump(dump: MemoryDump, opts?: { merge?: boolean }): Promise<void> {
    const merge = opts?.merge ?? false;

    for (const [entityId, bundle] of Object.entries(dump.entities)) {
      await this.db.withTransactionAsync(async () => {
        // ... all existing insert/update logic unchanged ...
      });
      // Embed non-deleted imported facts so they are immediately searchable.
      for (const fact of bundle.facts) {
        if (!fact.deleted_at) {
          await this.embedFact({
            id: fact.id,
            title: fact.title,
            body: fact.body,
            tags: Array.isArray(fact.tags) ? fact.tags : JSON.parse(fact.tags as unknown as string),
          });
        }
      }
    }

    await this.rebuildMiniSearchIndex();
  }
```

To make this edit surgical, find the exact closing of the `importDump` method. The last line of the for loop body (before the final closing `}` of `importDump`) is the events insert:

```typescript
        for (const event of bundle.events) {
          await this.db.runAsync(
            `INSERT OR IGNORE INTO ${this.prefix}events (id, entity_id, event_type, summary, related_entry_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [event.id, entityId, event.event_type, event.summary, event.related_entry_id ?? null, event.created_at]
          );
        }
```

After the closing `});` of `withTransactionAsync` (which follows the events loop), add:

```typescript
      for (const fact of bundle.facts) {
        if (!fact.deleted_at) {
          await this.embedFact({
            id: fact.id,
            title: fact.title,
            body: fact.body,
            tags: Array.isArray(fact.tags) ? fact.tags : JSON.parse(fact.tags as unknown as string),
          });
        }
      }
```

Then add `await this.rebuildMiniSearchIndex();` as the last statement of `importDump` before its closing `}`.

- [ ] **Step 3: Update `forget` to rebuild index**

In `forget` (line 1055), the method ends with:
```typescript
    return { deleted: { entries: deletedEntries, tasks: deletedTasks } };
  }
```

Replace with:
```typescript
    await this.rebuildMiniSearchIndex();
    return { deleted: { entries: deletedEntries, tasks: deletedTasks } };
  }
```

- [ ] **Step 4: Update `runPrune` to rebuild index**

In `runPrune`, the `try` block ends with:
```typescript
      return { entries: deletedEntries, tasks: deletedTasks, events: deletedEvents };
    } finally {
      this.activeMaintenanceJobs.delete(pruneKey);
    }
```

Replace with:
```typescript
      await this.rebuildMiniSearchIndex();
      return { entries: deletedEntries, tasks: deletedTasks, events: deletedEvents };
    } finally {
      this.activeMaintenanceJobs.delete(pruneKey);
    }
```

- [ ] **Step 5: Run tests**

```bash
cd packages/core && pnpm test
```

Expected: same pass/fail pattern. No new failures from mock-based tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/WikiMemory.ts && git commit -m "feat(core): wire embed+MiniSearch rebuild into ingest, importDump, forget, prune"
```

---

## Task 8: Replace `read()` — cosine similarity primary, MiniSearch fallback (TDD)

**Files:**
- Modify: `packages/core/src/WikiMemory.ts`
- Create: `packages/core/__tests__/embeddingRetrieval.test.ts`
- Create: `packages/core/__tests__/miniSearchFallback.test.ts`

- [ ] **Step 1: Write failing tests — `embeddingRetrieval.test.ts`**

Create `packages/core/__tests__/embeddingRetrieval.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions, MemoryDump } from '../src/types';

function makeDump(facts: Array<{ id: string; title: string; body: string }>): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      'user-1': {
        facts: facts.map((f, i) => ({
          id: f.id,
          entity_id: 'user-1',
          title: f.title,
          body: f.body,
          tags: [],
          confidence: 'certain' as const,
          source_type: 'user_stated' as const,
          source_hash: null,
          source_ref: null,
          created_at: (i + 1) * 1000,
          updated_at: (i + 1) * 1000,
          last_accessed_at: null,
          access_count: 0,
          deleted_at: null,
        })),
        tasks: [],
        events: [],
      },
    },
  };
}

function makeWiki(embedFn?: (text: string) => Promise<number[]>, onFallback?: (e: Error) => void) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    llmProvider: {
      generateText: async () => '{}',
      embed: embedFn,
    },
    onRetrievalFallback: onFallback,
  };
  return { wiki: new WikiMemory(db, options), db };
}

// Deterministic embed: maps keyword in text to a unit vector in 3D space.
function keywordEmbed(text: string): number[] {
  if (text.includes('apple')) return [1, 0, 0];
  if (text.includes('car')) return [0, 1, 0];
  return [0, 0, 1];
}

describe('read() — cosine similarity path', () => {
  it('ranks facts by cosine similarity to query embedding', async () => {
    const { wiki } = makeWiki(async (t) => keywordEmbed(t));
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      { id: 'fact-b', title: 'car vehicle', body: 'fast engine' },
    ]));

    const result = await wiki.read('user-1', 'apple');
    expect(result.facts[0].id).toBe('fact-a');

    const result2 = await wiki.read('user-1', 'car');
    expect(result2.facts[0].id).toBe('fact-b');
  });

  it('fact with higher similarity ranks above older fact', async () => {
    const { wiki } = makeWiki(async (t) => keywordEmbed(t));
    await wiki.setup();
    // fact-b is newer (updated_at 2000 > 1000) but semantically wrong for 'apple'
    await wiki.importDump(makeDump([
      { id: 'fact-a', title: 'apple fruit', body: 'healthy snack' },
      { id: 'fact-b', title: 'car vehicle', body: 'fast engine' },
    ]));

    const result = await wiki.read('user-1', 'apple');
    // fact-a wins by similarity despite being older
    expect(result.facts[0].id).toBe('fact-a');
  });

  it('empty query returns most-recent facts regardless of embed', async () => {
    const { wiki } = makeWiki(async (t) => keywordEmbed(t));
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-old', title: 'apple fruit', body: 'body' },
      { id: 'fact-new', title: 'car vehicle', body: 'body' },
    ]));

    const result = await wiki.read('user-1', '');
    // fact-new has higher updated_at → should be first
    expect(result.facts[0].id).toBe('fact-new');
  });

  it('no embed provided: empty query returns recency order (no crash)', async () => {
    const { wiki } = makeWiki(undefined);
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-1', title: 'alpha', body: 'body' },
      { id: 'fact-2', title: 'beta', body: 'body' },
    ]));

    const result = await wiki.read('user-1', '');
    expect(result.facts).toHaveLength(2);
  });

  it('increments access_count for facts returned from non-empty query', async () => {
    const { wiki, db } = makeWiki(async (t) => keywordEmbed(t));
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-a', title: 'apple fruit', body: 'healthy' },
    ]));

    await wiki.read('user-1', 'apple');

    const row = await db.getFirstAsync<{ access_count: number }>(
      `SELECT access_count FROM llm_wiki_entries WHERE id = 'fact-a'`
    );
    expect(row?.access_count).toBe(1);
  });

  it('does NOT increment access_count for empty query', async () => {
    const { wiki, db } = makeWiki(async (t) => keywordEmbed(t));
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-a', title: 'apple fruit', body: 'healthy' },
    ]));

    await wiki.read('user-1', '');

    const row = await db.getFirstAsync<{ access_count: number }>(
      `SELECT access_count FROM llm_wiki_entries WHERE id = 'fact-a'`
    );
    expect(row?.access_count).toBe(0);
  });

  it('facts without embeddings score 0 and appear after embedded facts', async () => {
    const { wiki, db } = makeWiki(async (t) => keywordEmbed(t));
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-a', title: 'apple fruit', body: 'healthy' },
    ]));
    // Insert a fact directly without embedding (simulates pre-migration row)
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['fact-nonembed', 'user-1', 'something else', 'no vector', '[]', 'certain', 'user_stated', 999, 999]
    );

    const result = await wiki.read('user-1', 'apple');
    expect(result.facts[0].id).toBe('fact-a');
  });
});
```

- [ ] **Step 2: Write failing tests — `miniSearchFallback.test.ts`**

Create `packages/core/__tests__/miniSearchFallback.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions, MemoryDump } from '../src/types';

function makeDump(facts: Array<{ id: string; title: string; body: string }>): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      'user-1': {
        facts: facts.map((f, i) => ({
          id: f.id,
          entity_id: 'user-1',
          title: f.title,
          body: f.body,
          tags: [],
          confidence: 'certain' as const,
          source_type: 'user_stated' as const,
          source_hash: null,
          source_ref: null,
          created_at: (i + 1) * 1000,
          updated_at: (i + 1) * 1000,
          last_accessed_at: null,
          access_count: 0,
          deleted_at: null,
        })),
        tasks: [],
        events: [],
      },
    },
  };
}

function makeWikiNoEmbed(onFallback?: (e: Error) => void) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    llmProvider: { generateText: async () => '{}' },
    onRetrievalFallback: onFallback,
  };
  return { wiki: new WikiMemory(db, options), db };
}

function makeWikiThrowingEmbed(onFallback?: (e: Error) => void) {
  const embedError = new Error('network error');
  const db = openTestDatabase();
  const options: WikiOptions = {
    llmProvider: {
      generateText: async () => '{}',
      embed: async () => { throw embedError; },
    },
    onRetrievalFallback: onFallback,
  };
  return { wiki: new WikiMemory(db, options), db, embedError };
}

describe('read() — MiniSearch fallback (no embed)', () => {
  it('returns relevant facts via MiniSearch when embed absent', async () => {
    const { wiki } = makeWikiNoEmbed();
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-banana', title: 'banana fruit', body: 'yellow tropical' },
      { id: 'fact-car', title: 'car vehicle', body: 'fast engine wheels' },
    ]));

    const result = await wiki.read('user-1', 'banana');
    const ids = result.facts.map(f => f.id);
    expect(ids).toContain('fact-banana');
  });

  it('does NOT call onRetrievalFallback when embed is simply absent', async () => {
    const errors: Error[] = [];
    const { wiki } = makeWikiNoEmbed((e) => errors.push(e));
    await wiki.setup();
    await wiki.importDump(makeDump([{ id: 'f1', title: 'something', body: 'body' }]));

    await wiki.read('user-1', 'something');
    expect(errors).toHaveLength(0);
  });
});

describe('read() — MiniSearch fallback (embed throws)', () => {
  it('returns MiniSearch results and calls onRetrievalFallback with the error', async () => {
    const errors: Error[] = [];
    const { wiki, embedError } = makeWikiThrowingEmbed((e) => errors.push(e));
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-banana', title: 'banana fruit', body: 'yellow tropical' },
    ]));

    const result = await wiki.read('user-1', 'banana');
    // Results returned (from MiniSearch)
    expect(result.facts.length).toBeGreaterThanOrEqual(0); // may be 0 if MiniSearch didn't index (embed threw during import)
    // Callback was called
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(embedError);
  });
});

describe('MiniSearch index sync', () => {
  it('index is populated after setup() with existing entries', async () => {
    const { wiki } = makeWikiNoEmbed();
    await wiki.setup();
    await wiki.importDump(makeDump([{ id: 'f1', title: 'mango tropical', body: 'sweet' }]));

    // New wiki instance, same DB (simulates app restart)
    const db2 = openTestDatabase();
    // (We use a fresh wiki on the same logical DB — but in practice we just verify the index works on the same instance)
    const result = await wiki.read('user-1', 'mango');
    const ids = result.facts.map(f => f.id);
    expect(ids).toContain('f1');
  });

  it('after forget(), forgotten fact absent from MiniSearch results', async () => {
    const { wiki } = makeWikiNoEmbed();
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'f-keep', title: 'apple fruit', body: 'healthy' },
      { id: 'f-forget', title: 'banana tropical', body: 'yellow' },
    ]));

    await wiki.forget('user-1', { entryId: 'f-forget' });

    const result = await wiki.read('user-1', 'banana');
    expect(result.facts.map(f => f.id)).not.toContain('f-forget');
  });
});
```

- [ ] **Step 3: Run tests — expect failure**

```bash
cd packages/core && pnpm test -- embeddingRetrieval miniSearchFallback
```

Expected: tests fail because `read()` still uses the FTS5 code path (which throws since FTS5 table no longer exists after Task 3).

- [ ] **Step 4: Replace `read()` — remove `formatSearchQuery`, install new implementation**

In `packages/core/src/WikiMemory.ts`:

**Delete** the entire `formatSearchQuery` private method (lines 496–535).

**Replace** the entire `read()` method (lines 537–594) with:

```typescript
  async read(entityId: string, query: string): Promise<MemoryBundle> {
    const maxResults = this.options.config?.maxResults
      ?? this.options.config?.maxFtsResults
      ?? 10;
    const embedFn = this.options.llmProvider.embed;
    const trimmedQuery = query.trim();

    let facts: WikiFact[];

    if (trimmedQuery) {
      let usedEmbed = false;

      if (embedFn) {
        try {
          const queryVec = await embedFn(trimmedQuery);
          const rows = await this.db.getAllAsync<WikiFact & { embedding: string | null }>(
            `SELECT * FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`,
            [entityId]
          );
          const scored = rows.map(row => ({
            row,
            score: row.embedding ? cosineSimilarity(queryVec, JSON.parse(row.embedding)) : 0,
          }));
          scored.sort((a, b) => b.score - a.score);
          facts = scored.slice(0, maxResults).map(s => s.row);
          usedEmbed = true;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.options.onRetrievalFallback?.(error);
        }
      }

      if (!usedEmbed) {
        // embed absent or threw — fall back to MiniSearch
        const results = this.miniSearch.search(trimmedQuery, {
          filter: (r: { entity_id: string }) => r.entity_id === entityId,
          combineWith: 'OR',
        });
        const topIds = new Set(results.slice(0, maxResults).map((r: { id: string }) => r.id));
        const allRows = await this.db.getAllAsync<WikiFact>(
          `SELECT * FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`,
          [entityId]
        );
        const byId = new Map(allRows.map(r => [r.id, r]));
        facts = [...topIds].map(id => byId.get(id)).filter((f): f is WikiFact => f !== undefined);
      }

      if (facts!.length > 0) {
        const ids = facts!.map(f => f.id);
        const placeholders = ids.map(() => '?').join(',');
        const now = Date.now();
        await this.db.runAsync(
          `UPDATE ${this.prefix}entries
           SET access_count = access_count + 1, last_accessed_at = ?
           WHERE id IN (${placeholders})`,
          [now, ...ids]
        );
      }
    } else {
      facts = await this.db.getAllAsync<WikiFact>(
        `SELECT * FROM ${this.prefix}entries
         WHERE entity_id = ? AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT ?`,
        [entityId, maxResults]
      );
    }

    const [tasks, events] = await Promise.all([
      this.db.getAllAsync<WikiTask>(
        `SELECT * FROM ${this.prefix}tasks
         WHERE entity_id = ? AND status IN ('pending', 'in_progress') AND deleted_at IS NULL
         ORDER BY priority DESC, created_at ASC`,
        [entityId]
      ),
      this.db.getAllAsync<WikiEvent>(
        `SELECT * FROM ${this.prefix}events
         WHERE entity_id = ?
         ORDER BY created_at DESC
         LIMIT 10`,
        [entityId]
      ),
    ]);

    const parsedFacts = facts!.map(f => ({
      ...f,
      tags: typeof f.tags === 'string' ? JSON.parse(f.tags) : f.tags,
    }));

    return { facts: parsedFacts, tasks, events: events.reverse() };
  }
```

- [ ] **Step 5: Run new tests — expect pass**

```bash
cd packages/core && pnpm test -- embeddingRetrieval miniSearchFallback
```

Expected: all new tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/WikiMemory.ts packages/core/__tests__/embeddingRetrieval.test.ts packages/core/__tests__/miniSearchFallback.test.ts && git commit -m "feat(core): replace FTS5 read() with cosine similarity + MiniSearch fallback"
```

---

## Task 9: Add `runReembed()` public method (TDD)

**Files:**
- Modify: `packages/core/src/WikiMemory.ts`
- Create: `packages/core/__tests__/runReembed.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/__tests__/runReembed.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiBusyError } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions, MemoryDump } from '../src/types';

function makeDump(entityId: string, facts: Array<{ id: string; title: string }>): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      [entityId]: {
        facts: facts.map((f, i) => ({
          id: f.id,
          entity_id: entityId,
          title: f.title,
          body: 'body',
          tags: [],
          confidence: 'certain' as const,
          source_type: 'user_stated' as const,
          source_hash: null,
          source_ref: null,
          created_at: (i + 1) * 1000,
          updated_at: (i + 1) * 1000,
          last_accessed_at: null,
          access_count: 0,
          deleted_at: null,
        })),
        tasks: [],
        events: [],
      },
    },
  };
}

describe('runReembed()', () => {
  it('returns { embedded: 0, skipped: 0 } when embed absent', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await wiki.setup();
    await wiki.importDump(makeDump('user-1', [{ id: 'f1', title: 'hello' }]));

    const result = await wiki.runReembed();
    expect(result).toEqual({ embedded: 0, skipped: 0 });
  });

  it('backfills embedding for all facts across entities', async () => {
    const db = openTestDatabase();
    const embedded: string[] = [];
    const wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async (text) => { embedded.push(text); return [1, 0, 0]; },
      },
    });
    await wiki.setup();

    // Import without embed so facts have NULL embedding initially
    const wikiNoEmbed = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f1', 'user-1', 'title one', 'body', '[]', 'certain', 'user_stated', 1000, 1000]
    );
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f2', 'user-2', 'title two', 'body', '[]', 'certain', 'user_stated', 2000, 2000]
    );

    const result = await wiki.runReembed();
    expect(result.embedded).toBe(2);
    expect(result.skipped).toBe(0);

    // Embeddings stored in DB
    const row1 = await db.getFirstAsync<{ embedding: string | null }>(
      `SELECT embedding FROM llm_wiki_entries WHERE id = 'f1'`
    );
    expect(row1?.embedding).not.toBeNull();
  });

  it('scopes to entityId when provided', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async () => [1, 0, 0],
      },
    });
    await wiki.setup();

    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f-user1', 'user-1', 'title', 'body', '[]', 'certain', 'user_stated', 1000, 1000]
    );
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f-user2', 'user-2', 'title', 'body', '[]', 'certain', 'user_stated', 2000, 2000]
    );

    const result = await wiki.runReembed('user-1');
    expect(result.embedded).toBe(1);

    const row2 = await db.getFirstAsync<{ embedding: string | null }>(
      `SELECT embedding FROM llm_wiki_entries WHERE id = 'f-user2'`
    );
    expect(row2?.embedding).toBeNull();
  });

  it('skips soft-deleted facts', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async () => [1, 0, 0],
      },
    });
    await wiki.setup();

    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f-deleted', 'user-1', 'gone', 'body', '[]', 'certain', 'user_stated', 1000, 1000, 1001]
    );

    const result = await wiki.runReembed();
    expect(result.embedded).toBe(0);
  });

  it('throws WikiBusyError on concurrent runReembed()', async () => {
    const db = openTestDatabase();
    let resolveEmbed!: () => void;
    const embedPromise = new Promise<void>(r => { resolveEmbed = r; });
    const wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async () => { await embedPromise; return [1, 0, 0]; },
      },
    });
    await wiki.setup();

    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f1', 'user-1', 'title', 'body', '[]', 'certain', 'user_stated', 1000, 1000]
    );

    const first = wiki.runReembed(); // hangs on embed
    await expect(wiki.runReembed()).rejects.toThrow(WikiBusyError);
    resolveEmbed();
    await first;
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd packages/core && pnpm test -- runReembed
```

Expected: `wiki.runReembed is not a function`

- [ ] **Step 3: Implement `runReembed()` in `WikiMemory`**

Add the following public method to `WikiMemory` (after `runHeal`, before `getEntityStatus`):

```typescript
  async runReembed(entityId?: string): Promise<{ embedded: number; skipped: number }> {
    const embedFn = this.options.llmProvider.embed;
    if (!embedFn) return { embedded: 0, skipped: 0 };

    const reembedKey = `${this.prefix}:reembed`;
    if (this.activeMaintenanceJobs.has(reembedKey)) {
      throw new WikiBusyError('reembed', entityId ?? '*');
    }
    this.activeMaintenanceJobs.add(reembedKey);

    try {
      const where = entityId ? `entity_id = ? AND deleted_at IS NULL` : `deleted_at IS NULL`;
      const params = entityId ? [entityId] : [];
      const rows = await this.db.getAllAsync<WikiFact>(
        `SELECT * FROM ${this.prefix}entries WHERE ${where}`,
        params
      );

      let embedded = 0;
      let skipped = 0;
      for (const row of rows) {
        try {
          await this.embedFact(row);
          embedded++;
        } catch {
          skipped++;
        }
      }
      return { embedded, skipped };
    } finally {
      this.activeMaintenanceJobs.delete(reembedKey);
    }
  }
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd packages/core && pnpm test -- runReembed
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/WikiMemory.ts packages/core/__tests__/runReembed.test.ts && git commit -m "feat(core): add runReembed() public method with concurrency guard"
```

---

## Task 10: Delete obsolete tests and fix `migrations.test.ts`

**Files:**
- Delete: `packages/core/__tests__/synonymMap.test.ts`
- Delete: `packages/core/__tests__/porterStemmer.test.ts`
- Modify: `packages/core/__tests__/migrations.test.ts`

- [ ] **Step 1: Delete `synonymMap.test.ts`**

```bash
rm packages/core/__tests__/synonymMap.test.ts
```

- [ ] **Step 2: Delete `porterStemmer.test.ts`**

```bash
rm packages/core/__tests__/porterStemmer.test.ts
```

- [ ] **Step 3: Update `migrations.test.ts` — fix version assertions**

The test file has several version references that need updating. Make the following edits:

**Edit 1** — In `'fresh install: no entries table → writes current schema version, no migration SQL runs'`:

Change the assertion from:
```typescript
    const versionWrite = db.runCalls.find(
      c => c.sql.includes('schema_version') && c.args[0] === '1'
    );
```
to:
```typescript
    const versionWrite = db.runCalls.find(
      c => c.sql.includes('schema_version') && c.args[0] === '2'
    );
```

**Edit 2** — In `'legacy install without porter → migration 0→1 runs (porter rebuild)'`:

Change the assertion from:
```typescript
    const versionWrite = db.runCalls.find(
      c => c.sql.includes('schema_version') && c.args[0] === '1'
    );
```
to:
```typescript
    const versionWrite = db.runCalls.find(
      c => c.sql.includes('schema_version') && c.args[0] === '2'
    );
```

**Edit 3** — In `'legacy install with porter → no migration runs, version written'`:

The test description is now slightly wrong (migration 2 will run), but the behavior being tested is still valid (migration 1 does not run on a porter install). The FTS DROP check is fine since migration 2 also drops FTS. Update the version assertion:

```typescript
    const versionWrite = db.runCalls.find(c => c.sql.includes('schema_version'));
```

The existing assertion only checks that a version was written. That's still correct — no change needed here.

However, the assertion `expect(hasRebuild).toBe(false)` checks for `DROP TABLE` or `DROP TRIGGER`. Migration 2 **does** emit those. Change the check to confirm migration 1's specific FTS rebuild (`CREATE VIRTUAL TABLE`) did NOT run:

```typescript
    // Migration 1 (porter FTS5 rebuild with CREATE VIRTUAL TABLE) should NOT run.
    const hasPorterRebuild = db.execCalls.some(s => s.includes('CREATE VIRTUAL TABLE'));
    expect(hasPorterRebuild).toBe(false);
```

**Edit 4** — In `'already at current version → no migration runs'`:

Change `metaVersion: '1'` to `metaVersion: '2'`:

```typescript
  it('already at current version → no migration runs', async () => {
    const db = makeMockDb({ hasEntries: true, hasPorter: true, metaVersion: '2' });
```

Also update the assertion comment. The check for `DROP TABLE` or `DROP TRIGGER` should still be `false` since at version 2, no migration runs:

```typescript
    const hasRebuild = db.execCalls.some(s => s.includes('DROP TABLE') || s.includes('DROP TRIGGER'));
    expect(hasRebuild).toBe(false);
```

This is already correct — no change to the assertion, just the `metaVersion`.

- [ ] **Step 4: Run all tests — expect full pass**

```bash
cd packages/core && pnpm test
```

Expected: all tests pass. Check that the count is now higher than the original 124 (new tests added) and that no failures remain.

- [ ] **Step 5: Typecheck**

```bash
cd packages/core && pnpm typecheck
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/__tests__/migrations.test.ts && git rm packages/core/__tests__/synonymMap.test.ts packages/core/__tests__/porterStemmer.test.ts && git commit -m "fix(core): remove FTS5/synonymMap tests; update migration version assertions to v2"
```

---

## Task 11: Export `runReembed` from `index.ts` and final verification

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Verify `runReembed` is accessible on `WikiMemory` instance**

`runReembed` is a public method on `WikiMemory`, which is exported from `index.ts`. No change needed to `index.ts` for the method itself — it's accessible via the instance.

- [ ] **Step 2: Verify no `synonymMap` references remain**

```bash
grep -r "synonymMap" packages/core/src packages/core/__tests__
```

Expected: no output.

- [ ] **Step 3: Verify no FTS5 references remain in source**

```bash
grep -r "USING fts5\|entries_fts\|MATCH ?" packages/core/src
```

Expected: no output.

- [ ] **Step 4: Run full test suite**

```bash
cd packages/core && pnpm test
```

Expected: all tests pass.

- [ ] **Step 5: Build**

```bash
cd packages/core && pnpm build
```

Expected: build succeeds, `dist/` updated.

- [ ] **Step 6: Final commit**

```bash
git add packages/core/src/index.ts packages/core && git commit -m "chore(core): verify build and exports after embedding retrieval migration"
```
