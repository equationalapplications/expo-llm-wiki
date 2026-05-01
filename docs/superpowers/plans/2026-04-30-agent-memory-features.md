# Agent Memory Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add FTS5 porter stemmer, static `synonymMap` query expansion, and row-level last-write-wins (LWW) merge in `importDump` — all backward-compatible.

**Architecture:** Schema gains `tokenize='porter unicode61'` on the FTS5 table; `setup()` detects pre-porter installs and rebuilds the FTS5 table inside one transaction. `formatSearchQuery` reads `WikiConfig.synonymMap` to expand tokens at query time (no DB writes). `importDump({ merge: true })` switches from coarse per-entity skip to row-level LWW by `updated_at` for facts and tasks; events stay append-only by id.

**Tech Stack:** TypeScript, expo-sqlite, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-30-agent-memory-features.md`.

---

## File Structure

- `src/db/schema.ts` — FTS5 `CREATE VIRTUAL TABLE` gains `tokenize='porter unicode61'`.
- `src/types.ts` — `WikiConfig.synonymMap?: Record<string, string[]>`.
- `src/WikiMemory.ts` — porter detect+rebuild in `setup()`; synonym expansion in `formatSearchQuery`; LWW merge in `importDump`.
- `src/__tests__/helpers/sqliteAdapter.ts` — **new**, dev-only adapter that exposes a `better-sqlite3` instance behind the subset of `expo-sqlite`'s `SQLiteDatabase` API used by `WikiMemory`.
- `src/__tests__/porterStemmer.test.ts` — new.
- `src/__tests__/synonymMap.test.ts` — new.
- `src/__tests__/importDumpMerge.test.ts` — new.
- `package.json` — add `better-sqlite3` and `@types/better-sqlite3` to devDependencies.

No new runtime files outside `src/`. No `prompts.ts` change. No `WikiTask.resolution_note`.

**Why a real-SQLite adapter?** The existing `vi.mock('expo-sqlite', ...)` in `src/__tests__/importDump.test.ts` is a hand-written in-memory mock that does not implement FTS5, the porter tokenizer, or `sqlite_master` introspection. Spec acceptance criteria such as *"Query `running` matches fact body `User runs every morning`"* and *"setup() detects pre-porter FTS5 and rebuilds"* can only be verified against a real SQLite engine. `better-sqlite3` ships a recent SQLite (FTS5 + porter built-in), is sync, and is trivial to wrap behind the small async API surface (`execAsync`, `runAsync`, `getFirstAsync`, `getAllAsync`, `withTransactionAsync`) that `WikiMemory` consumes.

---

## Task 0: SQLite test adapter (better-sqlite3)

**Files:**
- Modify: `package.json`
- Create: `src/__tests__/helpers/sqliteAdapter.ts`

- [ ] **Step 1: Install better-sqlite3**

```bash
npm install --save-dev better-sqlite3 @types/better-sqlite3
```

- [ ] **Step 2: Create the adapter**

Create `src/__tests__/helpers/sqliteAdapter.ts`:

```ts
import Database from 'better-sqlite3';
import type * as SQLite from 'expo-sqlite';

/**
 * Test-only adapter: exposes a real better-sqlite3 in-memory database behind
 * the subset of the expo-sqlite SQLiteDatabase API used by WikiMemory.
 *
 * Implements: execAsync, runAsync, getAllAsync, getFirstAsync,
 * withTransactionAsync. Does NOT attempt full expo-sqlite parity.
 */
export function openTestDatabase(): SQLite.SQLiteDatabase {
  const db = new Database(':memory:');

  const adapter = {
    async execAsync(sql: string): Promise<void> {
      db.exec(sql);
    },

    async runAsync(sql: string, args: unknown[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
      const stmt = db.prepare(sql);
      const info = stmt.run(...(args as any[]));
      return { changes: info.changes, lastInsertRowId: Number(info.lastInsertRowid) };
    },

    async getAllAsync<T>(sql: string, args: unknown[] = []): Promise<T[]> {
      const stmt = db.prepare(sql);
      return stmt.all(...(args as any[])) as T[];
    },

    async getFirstAsync<T>(sql: string, args: unknown[] = []): Promise<T | null> {
      const stmt = db.prepare(sql);
      const row = stmt.get(...(args as any[]));
      return (row ?? null) as T | null;
    },

    async withTransactionAsync<T>(fn: () => Promise<T>): Promise<T> {
      // better-sqlite3's transaction() requires a sync function. WikiMemory
      // uses async fns inside transactions, so we manually issue BEGIN/COMMIT/ROLLBACK.
      db.exec('BEGIN');
      try {
        const result = await fn();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    // expo-sqlite exposes closeAsync; tests may want it.
    async closeAsync(): Promise<void> {
      db.close();
    },
  };

  return adapter as unknown as SQLite.SQLiteDatabase;
}
```

- [ ] **Step 3: Smoke-test the adapter**

Create `src/__tests__/helpers/sqliteAdapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './sqliteAdapter';

describe('sqliteAdapter', () => {
  it('runs basic SQL and returns rows', async () => {
    const db = openTestDatabase();
    await db.execAsync(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
    await db.runAsync(`INSERT INTO t (name) VALUES (?)`, ['alice']);
    await db.runAsync(`INSERT INTO t (name) VALUES (?)`, ['bob']);
    const rows = await db.getAllAsync<{ id: number; name: string }>(`SELECT * FROM t ORDER BY id`);
    expect(rows).toEqual([{ id: 1, name: 'alice' }, { id: 2, name: 'bob' }]);
    const first = await db.getFirstAsync<{ name: string }>(`SELECT name FROM t WHERE id = ?`, [1]);
    expect(first?.name).toBe('alice');
  });

  it('supports FTS5 with porter tokenizer', async () => {
    const db = openTestDatabase();
    await db.execAsync(`CREATE VIRTUAL TABLE fts USING fts5(body, tokenize='porter unicode61')`);
    await db.runAsync(`INSERT INTO fts(body) VALUES (?)`, ['User runs every morning']);
    const rows = await db.getAllAsync<{ body: string }>(`SELECT * FROM fts WHERE fts MATCH ?`, ['running']);
    expect(rows.length).toBe(1);
  });

  it('rolls back failed transactions', async () => {
    const db = openTestDatabase();
    await db.execAsync(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
    await expect(
      db.withTransactionAsync(async () => {
        await db.runAsync(`INSERT INTO t (id) VALUES (1)`);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    const rows = await db.getAllAsync<{ id: number }>(`SELECT * FROM t`);
    expect(rows.length).toBe(0);
  });
});
```

- [ ] **Step 4: Run the adapter tests, confirm pass**

Run: `npx vitest run src/__tests__/helpers/sqliteAdapter.test.ts`
Expected: PASS — three green tests, including the FTS5/porter sanity check.

- [ ] **Step 5: Confirm existing suite still passes**

Run: `npx vitest run`
Expected: PASS — the new adapter is opt-in; existing files that `vi.mock('expo-sqlite', ...)` are unaffected.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/__tests__/helpers/sqliteAdapter.ts src/__tests__/helpers/sqliteAdapter.test.ts
git commit -m "test: add better-sqlite3 adapter for FTS5/LWW tests"
```

---

## Task 1: Schema — porter tokenizer on new installs (TDD)

**Files:**
- Modify: `src/db/schema.ts`
- Test: `src/__tests__/porterStemmer.test.ts`

- [ ] **Step 1: Write the failing test (new install path)**

Create `src/__tests__/porterStemmer.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import type * as SQLite from 'expo-sqlite';
import { WikiMemory } from '../WikiMemory';
import type { LLMProvider, WikiFact } from '../types';
import { openTestDatabase } from './helpers/sqliteAdapter';

const llmProvider: LLMProvider = {
  generateText: async () => '{}',
};

async function openDb() {
  return openTestDatabase();
}

function makeFact(overrides: Partial<WikiFact>): WikiFact {
  const now = Date.now();
  return {
    id: 'f1',
    entity_id: 'user-1',
    title: 'title',
    body: 'body',
    tags: [],
    confidence: 'certain',
    source_type: 'user_stated',
    source_hash: null,
    source_ref: null,
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
    ...overrides,
  };
}

describe('FTS5 porter stemmer', () => {
  let db: SQLite.SQLiteDatabase;
  let wiki: WikiMemory;

  beforeEach(async () => {
    db = await openDb();
    wiki = new WikiMemory(db, { llmProvider });
    await wiki.setup();
  });

  it('matches morphological variants (running → runs)', async () => {
    await wiki.importDump({
      generatedAt: Date.now(),
      entities: { 'user-1': { facts: [makeFact({ id: 'f1', title: 'Morning routine', body: 'User runs every morning' })], tasks: [], events: [] } },
    });
    const result = await wiki.read('user-1', 'running');
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts[0].body).toContain('runs');
  });

  it('matches base form (run → runs)', async () => {
    await wiki.importDump({
      generatedAt: Date.now(),
      entities: { 'user-1': { facts: [makeFact({ id: 'f1', title: 'Routine', body: 'User runs every morning' })], tasks: [], events: [] } },
    });
    const result = await wiki.read('user-1', 'run');
    expect(result.facts.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test, confirm fails**

Run: `npx vitest run src/__tests__/porterStemmer.test.ts`
Expected: FAIL — `running` and `run` do not match `runs` (no porter tokenizer yet). Note: `ran` (irregular past tense) is not handled by Porter — use `run` (base form) for the second test case.

- [ ] **Step 3: Add porter tokenizer to schema**

In `src/db/schema.ts`, replace the FTS5 `CREATE VIRTUAL TABLE` block:

```ts
    -- FTS5 Virtual Table for full-text search
    CREATE VIRTUAL TABLE IF NOT EXISTS ${prefix}entries_fts USING fts5(
      title,
      body,
      tags,
      content='${prefix}entries',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );
```

- [ ] **Step 4: Run test on fresh DB, confirm pass**

Run: `npx vitest run src/__tests__/porterStemmer.test.ts`
Expected: PASS for both tests (fresh in-memory DB picks up new tokenizer).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/__tests__/porterStemmer.test.ts
git commit -m "feat(fts): add porter tokenizer to entries_fts"
```

---

## Task 2: `setup()` — detect & rebuild pre-porter FTS5 table (TDD)

**Files:**
- Modify: `src/WikiMemory.ts` (`setup()`)
- Test: `src/__tests__/porterStemmer.test.ts` (extend)

- [ ] **Step 1: Write the failing upgrade test**

Append to `src/__tests__/porterStemmer.test.ts`:

```ts
describe('FTS5 porter upgrade migration', () => {
  it('rebuilds pre-porter FTS5 table and preserves searchability', async () => {
    const db = await openDb();
    const prefix = 'llm_wiki_';

    // Simulate pre-porter install: create entries + non-porter FTS5 + triggers + a row.
    await db.execAsync(`
      CREATE TABLE ${prefix}entries (
        id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL DEFAULT 'inferred',
        source_type TEXT NOT NULL DEFAULT 'agent_inferred', source_hash TEXT, source_ref TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER, access_count INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER
      );
      CREATE VIRTUAL TABLE ${prefix}entries_fts USING fts5(
        title, body, tags, content='${prefix}entries', content_rowid='rowid'
      );
      CREATE TRIGGER ${prefix}entries_ai AFTER INSERT ON ${prefix}entries BEGIN
        INSERT INTO ${prefix}entries_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
      END;
    `);
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO ${prefix}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['f1', 'user-1', 'Routine', 'User runs every morning', '[]', now, now]
    );

    // Now run setup — must detect missing porter and rebuild.
    const wiki = new WikiMemory(db, { llmProvider });
    await wiki.setup();

    // Confirm new FTS5 sql contains porter.
    const meta = await db.getFirstAsync<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
      [`${prefix}entries_fts`]
    );
    expect(meta?.sql).toContain('porter');

    // Confirm the existing fact is searchable via stem.
    const result = await wiki.read('user-1', 'running');
    expect(result.facts.length).toBeGreaterThan(0);
  });

  it('is idempotent: second setup() does not drop facts', async () => {
    const db = await openDb();
    const wiki = new WikiMemory(db, { llmProvider });
    await wiki.setup();
    await wiki.importDump({
      generatedAt: Date.now(),
      entities: { 'user-1': { facts: [makeFact({ id: 'f1', title: 't', body: 'User runs every morning' })], tasks: [], events: [] } },
    });
    await wiki.setup(); // second call
    const result = await wiki.read('user-1', 'running');
    expect(result.facts.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run, confirm upgrade test fails**

Run: `npx vitest run src/__tests__/porterStemmer.test.ts`
Expected: upgrade test FAILS (`sql` does not contain `porter` after `setup()` because `CREATE VIRTUAL TABLE IF NOT EXISTS` was a no-op).

- [ ] **Step 3: Add detect+rebuild logic in `setup()`**

In `src/WikiMemory.ts`, inside `async setup()` after `await setupDatabase(this.db, this.prefix);` and before the source_ref normalization block, insert:

```ts
    // FTS5 porter migration: pre-porter installs have an FTS5 table without
    // tokenize='porter unicode61'. CREATE VIRTUAL TABLE IF NOT EXISTS is a
    // no-op when the table already exists, so we must explicitly rebuild.
    const ftsMeta = await this.db.getFirstAsync<{ sql: string | null }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
      [`${this.prefix}entries_fts`]
    );
    if (ftsMeta?.sql && !ftsMeta.sql.includes('porter')) {
      // Whole rebuild sequence runs in a single transaction so a failure
      // cannot leave the FTS5 table missing or unindexed.
      await this.db.withTransactionAsync(async () => {
        await this.db.execAsync(`
          DROP TRIGGER IF EXISTS ${this.prefix}entries_ai;
          DROP TRIGGER IF EXISTS ${this.prefix}entries_ad;
          DROP TRIGGER IF EXISTS ${this.prefix}entries_au;
          DROP TABLE IF EXISTS ${this.prefix}entries_fts;
          CREATE VIRTUAL TABLE ${this.prefix}entries_fts USING fts5(
            title, body, tags,
            content='${this.prefix}entries',
            content_rowid='rowid',
            tokenize='porter unicode61'
          );
          INSERT INTO ${this.prefix}entries_fts(rowid, title, body, tags)
            SELECT rowid, title, body, tags FROM ${this.prefix}entries WHERE deleted_at IS NULL;
          CREATE TRIGGER ${this.prefix}entries_ai AFTER INSERT ON ${this.prefix}entries BEGIN
            INSERT INTO ${this.prefix}entries_fts(rowid, title, body, tags)
            VALUES (new.rowid, new.title, new.body, new.tags);
          END;
          CREATE TRIGGER ${this.prefix}entries_ad AFTER DELETE ON ${this.prefix}entries BEGIN
            INSERT INTO ${this.prefix}entries_fts(${this.prefix}entries_fts, rowid, title, body, tags)
            VALUES ('delete', old.rowid, old.title, old.body, old.tags);
          END;
          CREATE TRIGGER ${this.prefix}entries_au AFTER UPDATE ON ${this.prefix}entries BEGIN
            INSERT INTO ${this.prefix}entries_fts(${this.prefix}entries_fts, rowid, title, body, tags)
            VALUES ('delete', old.rowid, old.title, old.body, old.tags);
            INSERT INTO ${this.prefix}entries_fts(rowid, title, body, tags)
            VALUES (new.rowid, new.title, new.body, new.tags);
          END;
        `);
      });
    }
```

- [ ] **Step 4: Run all porter tests, confirm pass**

Run: `npx vitest run src/__tests__/porterStemmer.test.ts`
Expected: PASS — new install, upgrade, and idempotency all pass.

- [ ] **Step 5: Run full suite to confirm no regressions**

Run: `npx vitest run`
Expected: PASS — every existing test still green.

- [ ] **Step 6: Commit**

```bash
git add src/WikiMemory.ts src/__tests__/porterStemmer.test.ts
git commit -m "feat(setup): rebuild pre-porter FTS5 table inside transaction"
```

---

## Task 3: `WikiConfig.synonymMap` type (no behavior yet)

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add the field**

In `src/types.ts`, extend `WikiConfig`:

```ts
export interface WikiConfig {
  tablePrefix?: string;
  maxFtsResults?: number;
  pruneEventsAfter?: number;
  autoLibrarianThreshold?: number;
  autoHealThreshold?: number;
  orphanAfterDays?: number | null;
  staleInferredAfterDays?: number | null;
  maxChunkLength?: number;
  chunkOverlap?: number;
  chunkConcurrency?: number;
  /**
   * Static caller-supplied synonym expansions applied at query time.
   * Keys must be lowercase (lookup is performed after the query is lowercased).
   * Values are appended to the FTS5 query token list, deduped, and sliced to 12.
   */
  synonymMap?: Record<string, string[]>;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add WikiConfig.synonymMap"
```

---

## Task 4: `formatSearchQuery` — synonym expansion + 12-token cap (TDD)

**Files:**
- Modify: `src/WikiMemory.ts` (`formatSearchQuery`)
- Test: `src/__tests__/synonymMap.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/synonymMap.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type * as SQLite from 'expo-sqlite';
import { WikiMemory } from '../WikiMemory';
import type { LLMProvider, WikiConfig } from '../types';

const llmProvider: LLMProvider = { generateText: async () => '{}' };

// Expose private formatSearchQuery via casting for unit testing.
function makeWiki(config?: WikiConfig) {
  // We don't need a real DB to call formatSearchQuery — but constructor needs one.
  // Use a stub that won't be touched.
  const db = {} as unknown as SQLite.SQLiteDatabase;
  const wiki = new WikiMemory(db, { llmProvider, config });
  return wiki as unknown as { formatSearchQuery(q: string): string };
}

describe('formatSearchQuery synonym expansion', () => {
  it('no synonymMap: behaves as before', () => {
    const w = makeWiki();
    const q = w.formatSearchQuery('how was your run today');
    expect(q).toBe('"how"* OR "was"* OR "your"* OR "run"* OR "today"*');
  });

  it('expands a token using synonymMap, deduped', () => {
    const w = makeWiki({ synonymMap: { run: ['jog', 'sprint', 'run'] } });
    const q = w.formatSearchQuery('run');
    expect(q).toContain('"run"*');
    expect(q).toContain('"jog"*');
    expect(q).toContain('"sprint"*');
    // dedup: 'run' present once
    expect(q.match(/"run"\*/g)?.length).toBe(1);
  });

  it('preserves tokens with no synonym entry', () => {
    const w = makeWiki({ synonymMap: { run: ['jog'] } });
    const q = w.formatSearchQuery('today');
    expect(q).toBe('"today"*');
  });

  it('expands multiple tokens independently', () => {
    const w = makeWiki({ synonymMap: { run: ['jog'], partner: ['spouse'] } });
    const q = w.formatSearchQuery('run partner');
    expect(q).toContain('"run"*');
    expect(q).toContain('"jog"*');
    expect(q).toContain('"partner"*');
    expect(q).toContain('"spouse"*');
  });

  it('caps total tokens at 12 after expansion', () => {
    const synonymMap = {
      run: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'],
    };
    const w = makeWiki({ synonymMap });
    const q = w.formatSearchQuery('run');
    const tokenCount = (q.match(/"[^"]+"\*/g) || []).length;
    expect(tokenCount).toBeLessThanOrEqual(12);
  });

  it('empty synonymMap behaves as no synonymMap', () => {
    const w = makeWiki({ synonymMap: {} });
    const q = w.formatSearchQuery('run');
    expect(q).toBe('"run"*');
  });

  it('lowercases synonym values before adding', () => {
    const w = makeWiki({ synonymMap: { run: ['JOG'] } });
    const q = w.formatSearchQuery('run');
    expect(q).toContain('"jog"*');
    expect(q).not.toContain('"JOG"*');
  });
});
```

- [ ] **Step 2: Run, confirm fails**

Run: `npx vitest run src/__tests__/synonymMap.test.ts`
Expected: FAIL — current `formatSearchQuery` slices to 6 and ignores `synonymMap`.

- [ ] **Step 3: Replace `formatSearchQuery` with expansion logic**

In `src/WikiMemory.ts`, replace:

```ts
  private formatSearchQuery(query: string): string {
    const tokens = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length >= 3).slice(0, 6);
    if (tokens.length === 0) return '';
    return tokens.map(t => `"${t}"*`).join(' OR ');
  }
```

with:

```ts
  private formatSearchQuery(query: string): string {
    const baseTokens = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(t => t.length >= 3);
    if (baseTokens.length === 0) return '';

    const synonymMap = this.options.config?.synonymMap;
    const expanded: string[] = [];
    const seen = new Set<string>();
    const push = (t: string) => {
      const lc = t.toLowerCase();
      if (lc.length < 3) return;
      if (seen.has(lc)) return;
      seen.add(lc);
      expanded.push(lc);
    };

    for (const t of baseTokens) {
      push(t);
      if (synonymMap) {
        const syns = synonymMap[t];
        if (Array.isArray(syns)) {
          for (const s of syns) {
            if (typeof s === 'string') push(s);
          }
        }
      }
    }

    const capped = expanded.slice(0, 12);
    return capped.map(t => `"${t}"*`).join(' OR ');
  }
```

- [ ] **Step 4: Run synonym tests, confirm pass**

Run: `npx vitest run src/__tests__/synonymMap.test.ts`
Expected: PASS — all seven tests green.

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/WikiMemory.ts src/__tests__/synonymMap.test.ts
git commit -m "feat(search): synonymMap expansion with 12-token cap"
```

---

## Task 5: `importDump` LWW merge — facts (TDD)

**Files:**
- Modify: `src/WikiMemory.ts` (`importDump` fact branch)
- Test: `src/__tests__/importDumpMerge.test.ts`

- [ ] **Step 1: Write failing tests for facts**

Create `src/__tests__/importDumpMerge.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import type * as SQLite from 'expo-sqlite';
import { WikiMemory } from '../WikiMemory';
import type { LLMProvider, MemoryDump, WikiFact } from '../types';
import { openTestDatabase } from './helpers/sqliteAdapter';

const llmProvider: LLMProvider = { generateText: async () => '{}' };

function makeFact(overrides: Partial<WikiFact>): WikiFact {
  const now = Date.now();
  return {
    id: 'f1',
    entity_id: 'user-1',
    title: 'title',
    body: 'body',
    tags: [],
    confidence: 'certain',
    source_type: 'user_stated',
    source_hash: null,
    source_ref: null,
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
    ...overrides,
  };
}

async function open() {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider });
  await wiki.setup();
  return { db, wiki };
}

describe('importDump LWW — facts', () => {
  it('newer incoming overwrites older local', async () => {
    const { wiki } = await open();
    const oldTs = 1000;
    await wiki.importDump({
      generatedAt: oldTs,
      entities: { 'user-1': { facts: [makeFact({ id: 'f1', body: 'old', updated_at: oldTs })], tasks: [], events: [] } },
    });

    const newTs = 2000;
    await wiki.importDump(
      { generatedAt: newTs, entities: { 'user-1': { facts: [makeFact({ id: 'f1', body: 'new', updated_at: newTs })], tasks: [], events: [] } } },
      { merge: true }
    );

    const bundle = await wiki.read('user-1', '');
    const f = bundle.facts.find(x => x.id === 'f1');
    expect(f?.body).toBe('new');
    expect(f?.updated_at).toBe(newTs);
  });

  it('older incoming does NOT clobber newer local', async () => {
    const { wiki } = await open();
    await wiki.importDump({
      generatedAt: 5000,
      entities: { 'user-1': { facts: [makeFact({ id: 'f1', body: 'local-new', updated_at: 5000 })], tasks: [], events: [] } },
    });

    await wiki.importDump(
      { generatedAt: 1000, entities: { 'user-1': { facts: [makeFact({ id: 'f1', body: 'remote-old', updated_at: 1000 })], tasks: [], events: [] } } },
      { merge: true }
    );

    const bundle = await wiki.read('user-1', '');
    const f = bundle.facts.find(x => x.id === 'f1');
    expect(f?.body).toBe('local-new');
    expect(f?.updated_at).toBe(5000);
  });

  it('novel id is inserted in merge mode', async () => {
    const { wiki } = await open();
    await wiki.importDump({
      generatedAt: 1000,
      entities: { 'user-1': { facts: [makeFact({ id: 'f1', updated_at: 1000 })], tasks: [], events: [] } },
    });

    await wiki.importDump(
      { generatedAt: 2000, entities: { 'user-1': { facts: [makeFact({ id: 'f2', updated_at: 2000, body: 'novel' })], tasks: [], events: [] } } },
      { merge: true }
    );

    const bundle = await wiki.read('user-1', '');
    expect(bundle.facts.find(x => x.id === 'f1')).toBeTruthy();
    expect(bundle.facts.find(x => x.id === 'f2')?.body).toBe('novel');
  });
});
```

- [ ] **Step 2: Run, confirm fails**

Run: `npx vitest run src/__tests__/importDumpMerge.test.ts`
Expected: FAIL — current merge mode skips existing ids unconditionally, so the "newer overwrites" test fails.

- [ ] **Step 3: Replace fact merge branch with LWW**

In `src/WikiMemory.ts`, locate the fact-merge block inside `importDump`. Replace:

```ts
            if (merge) continue; // merge mode: preserve all existing data for this id (even if soft-deleted)
            // replace mode: update the existing row (restores if soft-deleted)
            await this.db.runAsync(
              `UPDATE ${this.prefix}entries SET entity_id = ?, title = ?, body = ?, tags = ?, confidence = ?, source_type = ?, source_hash = ?, source_ref = ?, created_at = ?, updated_at = ?, last_accessed_at = ?, access_count = ?, deleted_at = ? WHERE id = ?`,
              [entityId, fact.title, fact.body, tagsJson, fact.confidence, fact.source_type, fact.source_hash, fact.source_ref, fact.created_at, fact.updated_at, fact.last_accessed_at, fact.access_count, fact.deleted_at, fact.id]
            );
```

with:

```ts
            if (merge) {
              // LWW: incoming wins only if its updated_at is strictly newer than local.
              const localRow = await this.db.getFirstAsync<{ updated_at: number }>(
                `SELECT updated_at FROM ${this.prefix}entries WHERE id = ?`,
                [fact.id]
              );
              if (!localRow || fact.updated_at <= localRow.updated_at) continue;
            }
            // replace mode (or merge LWW winner): update the existing row (restores if soft-deleted)
            await this.db.runAsync(
              `UPDATE ${this.prefix}entries SET entity_id = ?, title = ?, body = ?, tags = ?, confidence = ?, source_type = ?, source_hash = ?, source_ref = ?, created_at = ?, updated_at = ?, last_accessed_at = ?, access_count = ?, deleted_at = ? WHERE id = ?`,
              [entityId, fact.title, fact.body, tagsJson, fact.confidence, fact.source_type, fact.source_hash, fact.source_ref, fact.created_at, fact.updated_at, fact.last_accessed_at, fact.access_count, fact.deleted_at, fact.id]
            );
```

- [ ] **Step 4: Run fact merge tests, confirm pass**

Run: `npx vitest run src/__tests__/importDumpMerge.test.ts`
Expected: PASS for all three fact tests.

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: PASS — existing `importDump.test.ts` still green (default `merge` undefined → replace path unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/WikiMemory.ts src/__tests__/importDumpMerge.test.ts
git commit -m "feat(import): row-level LWW merge for facts by updated_at"
```

---

## Task 6: `importDump` LWW merge — tasks (TDD)

**Files:**
- Modify: `src/WikiMemory.ts` (`importDump` task branch)
- Test: `src/__tests__/importDumpMerge.test.ts` (extend)

- [ ] **Step 1: Append failing tests for tasks**

Append to `src/__tests__/importDumpMerge.test.ts`:

```ts
import type { WikiTask } from '../types';

function makeTask(overrides: Partial<WikiTask>): WikiTask {
  const now = Date.now();
  return {
    id: 't1',
    entity_id: 'user-1',
    description: 'desc',
    status: 'pending',
    priority: 0,
    created_at: now,
    updated_at: now,
    resolved_at: null,
    deleted_at: null,
    ...overrides,
  };
}

describe('importDump LWW — tasks', () => {
  it('newer incoming task overwrites older local', async () => {
    const { wiki } = await open();
    await wiki.importDump({
      generatedAt: 1000,
      entities: { 'user-1': { facts: [], tasks: [makeTask({ id: 't1', description: 'old', updated_at: 1000 })], events: [] } },
    });
    await wiki.importDump(
      { generatedAt: 2000, entities: { 'user-1': { facts: [], tasks: [makeTask({ id: 't1', description: 'new', updated_at: 2000 })], events: [] } } },
      { merge: true }
    );
    const bundle = await wiki.read('user-1', '');
    expect(bundle.tasks.find(t => t.id === 't1')?.description).toBe('new');
  });

  it('older incoming task does NOT clobber newer local', async () => {
    const { wiki } = await open();
    await wiki.importDump({
      generatedAt: 5000,
      entities: { 'user-1': { facts: [], tasks: [makeTask({ id: 't1', description: 'local-new', updated_at: 5000 })], events: [] } },
    });
    await wiki.importDump(
      { generatedAt: 1000, entities: { 'user-1': { facts: [], tasks: [makeTask({ id: 't1', description: 'remote-old', updated_at: 1000 })], events: [] } } },
      { merge: true }
    );
    const bundle = await wiki.read('user-1', '');
    expect(bundle.tasks.find(t => t.id === 't1')?.description).toBe('local-new');
  });
});
```

- [ ] **Step 2: Run, confirm fails**

Run: `npx vitest run src/__tests__/importDumpMerge.test.ts`
Expected: FAIL on the "newer overwrites" task test.

- [ ] **Step 3: Replace task merge branch with LWW**

In `src/WikiMemory.ts`, locate the task-merge block inside `importDump`. Replace:

```ts
            if (merge) continue; // merge mode: preserve all existing data for this id (even if soft-deleted)
            // replace mode: update the existing row (restores if soft-deleted)
            await this.db.runAsync(
              `UPDATE ${this.prefix}tasks SET entity_id = ?, description = ?, status = ?, priority = ?, created_at = ?, updated_at = ?, resolved_at = ?, deleted_at = ? WHERE id = ?`,
              [entityId, task.description, task.status, task.priority, task.created_at, task.updated_at, task.resolved_at, task.deleted_at, task.id]
            );
```

with:

```ts
            if (merge) {
              const localRow = await this.db.getFirstAsync<{ updated_at: number }>(
                `SELECT updated_at FROM ${this.prefix}tasks WHERE id = ?`,
                [task.id]
              );
              if (!localRow || task.updated_at <= localRow.updated_at) continue;
            }
            // replace mode (or merge LWW winner): update the existing row (restores if soft-deleted)
            await this.db.runAsync(
              `UPDATE ${this.prefix}tasks SET entity_id = ?, description = ?, status = ?, priority = ?, created_at = ?, updated_at = ?, resolved_at = ?, deleted_at = ? WHERE id = ?`,
              [entityId, task.description, task.status, task.priority, task.created_at, task.updated_at, task.resolved_at, task.deleted_at, task.id]
            );
```

- [ ] **Step 4: Run task merge tests, confirm pass**

Run: `npx vitest run src/__tests__/importDumpMerge.test.ts`
Expected: PASS — both task tests green.

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/WikiMemory.ts src/__tests__/importDumpMerge.test.ts
git commit -m "feat(import): row-level LWW merge for tasks by updated_at"
```

---

## Task 7: `importDump` events — append-only dedup confirmation (TDD)

**Files:**
- Test: `src/__tests__/importDumpMerge.test.ts` (extend)

Events already use `INSERT OR IGNORE` keyed on `id`. Add tests to lock the contract.

- [ ] **Step 1: Append events tests**

Append to `src/__tests__/importDumpMerge.test.ts`:

```ts
import type { WikiEvent } from '../types';

function makeEvent(overrides: Partial<WikiEvent>): WikiEvent {
  return {
    id: 'e1',
    entity_id: 'user-1',
    event_type: 'observation',
    summary: 's',
    related_entry_id: null,
    created_at: Date.now(),
    ...overrides,
  };
}

describe('importDump LWW — events append-only', () => {
  it('duplicate event id is skipped, novel id is inserted', async () => {
    const { db, wiki } = await open();

    await wiki.importDump({
      generatedAt: 1000,
      entities: { 'user-1': { facts: [], tasks: [], events: [makeEvent({ id: 'e1', summary: 'first' })] } },
    });

    await wiki.importDump(
      { generatedAt: 2000, entities: { 'user-1': { facts: [], tasks: [], events: [
        makeEvent({ id: 'e1', summary: 'second' }),  // duplicate id — must be ignored
        makeEvent({ id: 'e2', summary: 'novel' }),
      ] } } },
      { merge: true }
    );

    const rows = await db.getAllAsync<WikiEvent>(`SELECT * FROM llm_wiki_events WHERE entity_id = ? ORDER BY id`, ['user-1']);
    expect(rows.length).toBe(2);
    expect(rows.find(r => r.id === 'e1')?.summary).toBe('first');
    expect(rows.find(r => r.id === 'e2')?.summary).toBe('novel');
  });
});
```

- [ ] **Step 2: Run, confirm pass without code changes**

Run: `npx vitest run src/__tests__/importDumpMerge.test.ts`
Expected: PASS — `INSERT OR IGNORE` already provides this behavior.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/importDumpMerge.test.ts
git commit -m "test(import): lock event append-only dedup contract"
```

---

## Task 8: Final verification

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`
Expected: PASS — every file in `src/__tests__/` green, including the three new files and all pre-existing ones.

- [ ] **Step 4: Acceptance-criteria self-check**

Verify against the spec checklist:
- [ ] FTS5 created with `tokenize='porter unicode61'` on new install (Task 1)
- [ ] Pre-porter install rebuilt by `setup()` (Task 2)
- [ ] `setup()` idempotent (Task 2)
- [ ] `running` matches `runs` (Task 1)
- [ ] `synonymMap` expansion works (Task 4)
- [ ] Token slice capped at 12 (Task 4)
- [ ] LWW: newer incoming wins for facts and tasks (Tasks 5, 6)
- [ ] LWW: older incoming does not clobber (Tasks 5, 6)
- [ ] Novel ids inserted (Task 5)
- [ ] Events append-only dedup (Task 7)
- [ ] Merge atomic per entity — entire `importDump` per-entity body already wrapped in `withTransactionAsync` (unchanged)
- [ ] No `WikiTask.resolution_note` added (deferred — verified by `grep -r resolution_note src/` returning nothing)
- [ ] All existing tests pass

- [ ] **Step 5: Final commit if any cleanup needed**

```bash
git status
# If clean: nothing to commit. If not: commit cleanup.
```

---

## Self-Review Notes

- **Spec coverage:** every spec section maps to a task — porter (1, 2), synonymMap (3, 4), LWW merge (5, 6, 7), no `resolution_note` (verified in 8).
- **No placeholders:** every code step shows full code.
- **Type consistency:** `synonymMap?: Record<string, string[]>` defined in Task 3, consumed in Task 4. LWW reads `updated_at` field that exists on `WikiFact` and `WikiTask` (verified in `src/types.ts`).
- **Atomicity:** spec says "merge atomic per entity"; existing `importDump` already wraps per-entity work in `withTransactionAsync` — no extra change needed. Noted in Task 8 acceptance check.
- **Cross-entity collision warning:** preserved unchanged in both fact and task LWW branches (the `existing.entity_id !== entityId` check runs before the LWW comparison).
