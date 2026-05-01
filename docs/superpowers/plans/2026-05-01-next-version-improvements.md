# Next-Version Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `formatContext`, `hasChanged`, schema-versioned migrations, and `runPrune` to `expo-llm-wiki`.

**Architecture:** Four independent features land on top of the existing `WikiMemory` class and SQLite adapter. The migration registry replaces the inline porter probe in `setup()`. The other three features each add a new method or utility with no dependencies on each other.

**Tech Stack:** TypeScript, expo-sqlite, vitest, React hooks

---

## File Map

| File | Change |
|---|---|
| `src/types.ts` | Add `FormatContextOptions`; extend `WikiBusyError.operation` union with `'prune'`; add `pruneRetainSoftDeletedFor` to `WikiConfig` |
| `src/db/schema.ts` | Add `{prefix}meta` table to `setupDatabase` |
| `src/db/migrations.ts` | **NEW** — migration registry: `Migration` interface + `MIGRATIONS` array |
| `src/WikiMemory.ts` | Refactor `setup()` to use registry; add `hasChanged()`, `runPrune()`, `_pruneKey()` |
| `src/utils/formatContext.ts` | **NEW** — pure `formatContext(bundle, options?)` function |
| `src/index.ts` | Re-export `formatContext` |
| `src/react/useWikiHasChanged.ts` | **NEW** — mutation hook wrapping `wiki.hasChanged()` |
| `src/react/useWikiMaintenance.ts` | Extend with `runPrune` |
| `src/react/index.ts` | Export `useWikiHasChanged` |
| `src/__tests__/formatContext.test.ts` | **NEW** |
| `src/__tests__/hasChanged.test.ts` | **NEW** |
| `src/__tests__/migrations.test.ts` | **NEW** |
| `src/__tests__/prune.test.ts` | **NEW** |
| `README.md` | Document four new APIs |
| `CHANGELOG.md` | v-next entry |

---

## Task 1: Types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Update `WikiConfig`, `WikiBusyError`, and add `FormatContextOptions`**

Open `src/types.ts`. Make three changes:

**a) Add `pruneRetainSoftDeletedFor` to `WikiConfig`** (after `pruneEventsAfter`):
```ts
  pruneEventsAfter?: number;
  pruneRetainSoftDeletedFor?: number;
```

**b) Add `FormatContextOptions` interface** (after `FormattedMemoryDump`):
```ts
export interface FormatContextOptions {
  format?: 'markdown' | 'plain';
  maxFacts?: number;
  maxTasks?: number;
  maxEvents?: number;
  includeConfidence?: boolean;
  includeTags?: boolean;
  factWeights?: {
    confidence?: number;
    accessCount?: number;
    recency?: number;
  };
}
```

**c) Extend `WikiBusyError.operation`** — change the constructor and readonly field:
```ts
export class WikiBusyError extends Error {
  readonly operation: 'ingest' | 'librarian' | 'heal' | 'prune';
  readonly entityId: string;

  constructor(operation: 'ingest' | 'librarian' | 'heal' | 'prune', entityId: string) {
    super(`${operation} already running for entity ${entityId}`);
    this.name = 'WikiBusyError';
    this.operation = operation;
    this.entityId = entityId;
  }
}
```

- [ ] **Step 2: Run typecheck to confirm no errors**

```bash
cd /Users/equationalapplications/code/src/github.com/equationalapplications/expo-llm-wiki
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add FormatContextOptions, pruneRetainSoftDeletedFor, extend WikiBusyError prune op"
```

---

## Task 2: `formatContext` — TDD

**Files:**
- Create: `src/utils/formatContext.ts`
- Create: `src/__tests__/formatContext.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/formatContext.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatContext } from '../utils/formatContext';
import type { MemoryBundle, WikiFact, WikiTask, WikiEvent } from '../types';

function makeFact(overrides: Partial<WikiFact> = {}): WikiFact {
  return {
    id: 'f1',
    entity_id: 'e1',
    title: 'A fact',
    body: 'Body text',
    tags: ['tag1'],
    confidence: 'certain',
    source_type: 'agent_inferred',
    source_hash: null,
    source_ref: null,
    created_at: 0,
    updated_at: Date.now(),
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<WikiTask> = {}): WikiTask {
  return {
    id: 't1',
    entity_id: 'e1',
    description: 'A task',
    status: 'pending',
    priority: 0,
    created_at: 0,
    updated_at: 0,
    resolved_at: null,
    deleted_at: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<WikiEvent> = {}): WikiEvent {
  return {
    id: 'ev1',
    entity_id: 'e1',
    event_type: 'observation',
    summary: 'Something happened',
    related_entry_id: null,
    created_at: new Date('2026-05-01T00:00:00Z').getTime(),
    ...overrides,
  };
}

const emptyBundle: MemoryBundle = { facts: [], tasks: [], events: [] };

describe('formatContext', () => {
  it('returns empty string for empty bundle', () => {
    const result = formatContext(emptyBundle);
    expect(result.trim()).toBe('');
  });

  it('produces markdown headers by default', () => {
    const bundle: MemoryBundle = {
      facts: [makeFact()],
      tasks: [],
      events: [],
    };
    const result = formatContext(bundle);
    expect(result).toContain('##');
    expect(result).toContain('A fact');
  });

  it('plain format contains no markdown headers or bold', () => {
    const bundle: MemoryBundle = {
      facts: [makeFact()],
      tasks: [makeTask()],
      events: [makeEvent()],
    };
    const result = formatContext(bundle, { format: 'plain' });
    expect(result).not.toMatch(/^#{1,6} /m);
    expect(result).not.toContain('**');
  });

  it('plain format still contains fact title and body', () => {
    const bundle: MemoryBundle = {
      facts: [makeFact({ title: 'My Fact', body: 'My body' })],
      tasks: [],
      events: [],
    };
    const result = formatContext(bundle, { format: 'plain' });
    expect(result).toContain('My Fact');
    expect(result).toContain('My body');
  });

  it('respects maxFacts truncation', () => {
    const bundle: MemoryBundle = {
      facts: [
        makeFact({ id: 'f1', title: 'Fact 1' }),
        makeFact({ id: 'f2', title: 'Fact 2' }),
        makeFact({ id: 'f3', title: 'Fact 3' }),
      ],
      tasks: [],
      events: [],
    };
    const result = formatContext(bundle, { maxFacts: 2 });
    const matches = (result.match(/Fact \d/g) || []).length;
    expect(matches).toBe(2);
  });

  it('respects maxTasks truncation', () => {
    const bundle: MemoryBundle = {
      facts: [],
      tasks: [
        makeTask({ id: 't1', description: 'Task 1' }),
        makeTask({ id: 't2', description: 'Task 2' }),
        makeTask({ id: 't3', description: 'Task 3' }),
      ],
      events: [],
    };
    const result = formatContext(bundle, { maxTasks: 1 });
    const matches = (result.match(/Task \d/g) || []).length;
    expect(matches).toBe(1);
  });

  it('respects maxEvents truncation', () => {
    const bundle: MemoryBundle = {
      facts: [],
      tasks: [],
      events: [
        makeEvent({ id: 'ev1', summary: 'Event 1' }),
        makeEvent({ id: 'ev2', summary: 'Event 2' }),
        makeEvent({ id: 'ev3', summary: 'Event 3' }),
      ],
    };
    const result = formatContext(bundle, { maxEvents: 2 });
    const matches = (result.match(/Event \d/g) || []).length;
    expect(matches).toBe(2);
  });

  it('includeConfidence=false omits confidence labels', () => {
    const bundle: MemoryBundle = {
      facts: [makeFact({ confidence: 'tentative' })],
      tasks: [],
      events: [],
    };
    const withConf = formatContext(bundle, { includeConfidence: true });
    const withoutConf = formatContext(bundle, { includeConfidence: false });
    expect(withConf).toContain('tentative');
    expect(withoutConf).not.toContain('tentative');
  });

  it('includeTags=false omits tag labels', () => {
    const bundle: MemoryBundle = {
      facts: [makeFact({ tags: ['alpha', 'beta'] })],
      tasks: [],
      events: [],
    };
    const withTags = formatContext(bundle, { includeTags: true });
    const withoutTags = formatContext(bundle, { includeTags: false });
    expect(withTags).toContain('alpha');
    expect(withoutTags).not.toContain('alpha');
  });

  it('ranks certain above inferred above tentative', () => {
    const now = Date.now();
    const bundle: MemoryBundle = {
      facts: [
        makeFact({ id: 'f1', title: 'Tentative fact', confidence: 'tentative', updated_at: now, access_count: 0 }),
        makeFact({ id: 'f2', title: 'Certain fact', confidence: 'certain', updated_at: now, access_count: 0 }),
        makeFact({ id: 'f3', title: 'Inferred fact', confidence: 'inferred', updated_at: now, access_count: 0 }),
      ],
      tasks: [],
      events: [],
    };
    const result = formatContext(bundle);
    const certIdx = result.indexOf('Certain fact');
    const infIdx = result.indexOf('Inferred fact');
    const tentIdx = result.indexOf('Tentative fact');
    expect(certIdx).toBeLessThan(infIdx);
    expect(infIdx).toBeLessThan(tentIdx);
  });

  it('recency: fresher fact ranks above stale fact of same confidence', () => {
    const now = Date.now();
    const bundle: MemoryBundle = {
      facts: [
        makeFact({ id: 'f1', title: 'Stale fact', confidence: 'certain', updated_at: now - 90 * 86400000, access_count: 0 }),
        makeFact({ id: 'f2', title: 'Fresh fact', confidence: 'certain', updated_at: now, access_count: 0 }),
      ],
      tasks: [],
      events: [],
    };
    const result = formatContext(bundle);
    expect(result.indexOf('Fresh fact')).toBeLessThan(result.indexOf('Stale fact'));
  });

  it('events render newest-first', () => {
    const bundle: MemoryBundle = {
      facts: [],
      tasks: [],
      events: [
        makeEvent({ id: 'ev1', summary: 'Old event', created_at: 1000 }),
        makeEvent({ id: 'ev2', summary: 'New event', created_at: 9000 }),
      ],
    };
    const result = formatContext(bundle);
    expect(result.indexOf('New event')).toBeLessThan(result.indexOf('Old event'));
  });

  it('tasks render by priority DESC, created_at ASC', () => {
    const bundle: MemoryBundle = {
      facts: [],
      tasks: [
        makeTask({ id: 't1', description: 'Low priority', priority: 1, created_at: 100 }),
        makeTask({ id: 't2', description: 'High priority', priority: 10, created_at: 200 }),
        makeTask({ id: 't3', description: 'High priority early', priority: 10, created_at: 100 }),
      ],
      events: [],
    };
    const result = formatContext(bundle);
    const hp1 = result.indexOf('High priority early');
    const hp2 = result.indexOf('High priority (');  // match 'High priority (pending)', not 'High priority early'
    const lp = result.indexOf('Low priority');
    expect(hp1).toBeLessThan(hp2);
    expect(hp2).toBeLessThan(lp);
  });

  it('custom weight overrides change ranking', () => {
    const now = Date.now();
    // With accessCount weight = 10, a high-access inferred fact beats a certain fact
    const bundle: MemoryBundle = {
      facts: [
        makeFact({ id: 'f1', title: 'Certain low-access', confidence: 'certain', access_count: 0, updated_at: now }),
        makeFact({ id: 'f2', title: 'Inferred high-access', confidence: 'inferred', access_count: 100, updated_at: now }),
      ],
      tasks: [],
      events: [],
    };
    const result = formatContext(bundle, { factWeights: { confidence: 1.0, accessCount: 10, recency: 0.5 } });
    expect(result.indexOf('Inferred high-access')).toBeLessThan(result.indexOf('Certain low-access'));
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/equationalapplications/code/src/github.com/equationalapplications/expo-llm-wiki
npx vitest run src/__tests__/formatContext.test.ts
```

Expected: multiple failures — `formatContext` does not exist yet.

- [ ] **Step 3: Implement `formatContext`**

Create `src/utils/formatContext.ts`:

```ts
import type { MemoryBundle, WikiFact, WikiTask, WikiEvent, FormatContextOptions } from '../types';

const CONFIDENCE_WEIGHT: Record<string, number> = {
  certain: 1.0,
  inferred: 0.6,
  tentative: 0.3,
};

function scoreFactFor(fact: WikiFact, weights: Required<NonNullable<FormatContextOptions['factWeights']>>): number {
  const confW = CONFIDENCE_WEIGHT[fact.confidence] ?? 0.3;
  const ageDays = (Date.now() - fact.updated_at) / 86400000;
  const recencyDecay = Math.exp(-ageDays / 30);
  return (
    confW * weights.confidence +
    Math.log(1 + fact.access_count) * weights.accessCount +
    recencyDecay * weights.recency
  );
}

function renderFactMarkdown(fact: WikiFact, opts: Required<FormatContextOptions>): string {
  const lines: string[] = [];
  const confPart = opts.includeConfidence ? ` (${fact.confidence})` : '';
  const tagPart = opts.includeTags && fact.tags.length > 0 ? ` [${fact.tags.join(', ')}]` : '';
  lines.push(`- **${fact.title}**${confPart}${tagPart}`);
  lines.push(`  ${fact.body}`);
  return lines.join('\n');
}

function renderFactPlain(fact: WikiFact, opts: Required<FormatContextOptions>): string {
  const confPart = opts.includeConfidence ? ` (${fact.confidence})` : '';
  const tagPart = opts.includeTags && fact.tags.length > 0 ? ` [${fact.tags.join(', ')}]` : '';
  return `${fact.title}${confPart}${tagPart}: ${fact.body}`;
}

function renderTaskMarkdown(task: WikiTask): string {
  return `- [P${task.priority}] ${task.description} (${task.status})`;
}

function renderTaskPlain(task: WikiTask): string {
  return `[P${task.priority}] ${task.description} (${task.status})`;
}

function renderEventMarkdown(event: WikiEvent): string {
  const ts = new Date(event.created_at).toISOString();
  return `- [${event.event_type} @ ${ts}] ${event.summary}`;
}

function renderEventPlain(event: WikiEvent): string {
  const ts = new Date(event.created_at).toISOString();
  return `[${event.event_type} @ ${ts}] ${event.summary}`;
}

export function formatContext(bundle: MemoryBundle, options?: FormatContextOptions): string {
  const opts: Required<FormatContextOptions> = {
    format: options?.format ?? 'markdown',
    maxFacts: options?.maxFacts ?? 10,
    maxTasks: options?.maxTasks ?? 10,
    maxEvents: options?.maxEvents ?? 10,
    includeConfidence: options?.includeConfidence ?? true,
    includeTags: options?.includeTags ?? true,
    factWeights: {
      confidence: options?.factWeights?.confidence ?? 1.0,
      accessCount: options?.factWeights?.accessCount ?? 0.3,
      recency: options?.factWeights?.recency ?? 0.5,
    },
  };

  const weights = opts.factWeights as Required<NonNullable<FormatContextOptions['factWeights']>>;

  const sortedFacts = [...bundle.facts]
    .sort((a, b) => scoreFactFor(b, weights) - scoreFactFor(a, weights))
    .slice(0, opts.maxFacts);

  const sortedTasks = [...bundle.tasks]
    .sort((a, b) => b.priority - a.priority || a.created_at - b.created_at)
    .slice(0, opts.maxTasks);

  const sortedEvents = [...bundle.events]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, opts.maxEvents);

  if (sortedFacts.length === 0 && sortedTasks.length === 0 && sortedEvents.length === 0) {
    return '';
  }

  const sections: string[] = [];
  const isMd = opts.format === 'markdown';

  if (isMd) {
    sections.push('## Memory');
  }

  if (sortedFacts.length > 0) {
    if (isMd) {
      sections.push('\n### Known Facts');
      for (const f of sortedFacts) sections.push(renderFactMarkdown(f, opts));
    } else {
      sections.push('KNOWN FACTS:');
      for (const f of sortedFacts) sections.push(renderFactPlain(f, opts));
    }
  }

  if (sortedTasks.length > 0) {
    if (isMd) {
      sections.push('\n### Open Tasks');
      for (const t of sortedTasks) sections.push(renderTaskMarkdown(t));
    } else {
      sections.push('OPEN TASKS:');
      for (const t of sortedTasks) sections.push(renderTaskPlain(t));
    }
  }

  if (sortedEvents.length > 0) {
    if (isMd) {
      sections.push('\n### Recent Events');
      for (const e of sortedEvents) sections.push(renderEventMarkdown(e));
    } else {
      sections.push('RECENT EVENTS:');
      for (const e of sortedEvents) sections.push(renderEventPlain(e));
    }
  }

  return sections.join('\n');
}
```

- [ ] **Step 4: Re-export from `src/index.ts`**

Add after the existing `formatMemoryDump` export:
```ts
export { formatContext } from './utils/formatContext';
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
npx vitest run src/__tests__/formatContext.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Run full suite to confirm no regressions**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/utils/formatContext.ts src/__tests__/formatContext.test.ts src/index.ts
git commit -m "feat(utils): add formatContext for LLM prompt injection"
```

---

## Task 3: Meta table + migration registry + `setup()` refactor — TDD

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations.ts`
- Modify: `src/WikiMemory.ts`
- Create: `src/__tests__/migrations.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/migrations.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

// ── Shared mock state ────────────────────────────────────────────────────────

function makeMockDb(opts: {
  hasEntries?: boolean;
  hasPorter?: boolean;
  metaVersion?: string | null;
}) {
  const {
    hasEntries = false,
    hasPorter = false,
    metaVersion = null,
  } = opts;

  const execCalls: string[] = [];
  const runCalls: Array<{ sql: string; args: any[] }> = [];
  let currentMetaVersion = metaVersion;

  const db = {
    execCalls,
    runCalls,
    getMetaVersion: () => currentMetaVersion,

    async execAsync(sql: string): Promise<void> {
      execCalls.push(sql.replace(/\s+/g, ' ').trim());
    },

    async withTransactionAsync<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },

    async runAsync(sql: string, args: any[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      runCalls.push({ sql: normalized, args });
      if (normalized.includes("INSERT OR REPLACE INTO") && normalized.includes("meta")) {
        if (args[0] === 'schema_version') currentMetaVersion = args[1];
        else if (args[1]) currentMetaVersion = args[1];
      }
      return { changes: 1, lastInsertRowId: 0 };
    },

    async getFirstAsync<T>(sql: string, args: any[] = []): Promise<T | null> {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      // meta version query
      if (normalized.includes('meta') && normalized.includes('schema_version')) {
        return currentMetaVersion != null
          ? ({ value: currentMetaVersion } as unknown as T)
          : null;
      }

      // sqlite_master entries table check
      if (normalized.includes('sqlite_master') && normalized.includes("type='table'")) {
        const name = args[0] as string;
        if (name.endsWith('entries')) {
          return hasEntries ? ({ name } as unknown as T) : null;
        }
        if (name.endsWith('entries_fts')) {
          if (!hasPorter) return ({ sql: 'CREATE VIRTUAL TABLE entries_fts USING fts5(title, body, tokenize="unicode61")' } as unknown as T);
          return ({ sql: "CREATE VIRTUAL TABLE entries_fts USING fts5(title, body, tokenize='porter unicode61')" } as unknown as T);
        }
      }

      // source_ref normalization (pre-existing rows)
      return null;
    },

    async getAllAsync<T>(_sql: string, _args: any[] = []): Promise<T[]> {
      return [];
    },
  };

  return db;
}

vi.mock('expo-sqlite', () => ({ default: {} }));

// ── Tests ────────────────────────────────────────────────────────────────────

import { WikiMemory } from '../WikiMemory';
import type { WikiOptions } from '../types';

const stubOptions: WikiOptions = {
  llmProvider: { generateText: async () => '{}' },
};

function createWiki(db: any) {
  return new WikiMemory(db as any, stubOptions);
}

describe('schema migrations', () => {
  it('fresh install: no entries table → writes current schema version, no migration SQL runs', async () => {
    const db = makeMockDb({ hasEntries: false, metaVersion: null });
    const wiki = createWiki(db);
    await wiki.setup();

    const versionWrite = db.runCalls.find(c => c.sql.includes('meta') && c.sql.includes('schema_version'));
    expect(versionWrite).toBeDefined();
    // The written version should be a positive integer (current schema version)
    expect(Number(versionWrite!.args.find((a: any) => /^\d+$/.test(String(a))))).toBeGreaterThan(0);

    // No porter-rebuild exec should have happened (no DROP TABLE entries_fts)
    const hasRebuild = db.execCalls.some(s => s.includes('DROP TABLE') && s.includes('entries_fts'));
    expect(hasRebuild).toBe(false);
  });

  it('legacy install without porter → migration 0→1 runs (porter rebuild)', async () => {
    const db = makeMockDb({ hasEntries: true, hasPorter: false, metaVersion: null });
    const wiki = createWiki(db);
    await wiki.setup();

    // The porter rebuild transaction should have fired
    const hasRebuild = db.execCalls.some(s => s.includes("tokenize='porter unicode61'") || s.includes('tokenize=\'porter unicode61\''));
    expect(hasRebuild).toBe(true);

    // Meta version should be written
    const versionWrite = db.runCalls.find(c => c.sql.includes('meta') && c.sql.includes('schema_version'));
    expect(versionWrite).toBeDefined();
  });

  it('legacy install with porter → no migration runs, version written', async () => {
    const db = makeMockDb({ hasEntries: true, hasPorter: true, metaVersion: null });
    const wiki = createWiki(db);
    await wiki.setup();

    const hasRebuild = db.execCalls.some(s => s.includes('DROP TABLE') && s.includes('entries_fts'));
    expect(hasRebuild).toBe(false);

    const versionWrite = db.runCalls.find(c => c.sql.includes('meta') && c.sql.includes('schema_version'));
    expect(versionWrite).toBeDefined();
  });

  it('already at current version → no migration runs', async () => {
    // Simulate a DB that already has schema_version = '1' in meta
    const db = makeMockDb({ hasEntries: true, hasPorter: true, metaVersion: '1' });
    const wiki = createWiki(db);

    const callsBefore = db.execCalls.length;
    await wiki.setup();

    const hasRebuild = db.execCalls.some((s, i) => i >= callsBefore && s.includes('DROP TABLE') && s.includes('entries_fts'));
    expect(hasRebuild).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/__tests__/migrations.test.ts
```

Expected: failures — migration infrastructure doesn't exist yet.

- [ ] **Step 3: Add `meta` table to `schema.ts`**

In `src/db/schema.ts`, inside the `execAsync` call, add after the `checkpoints` table (before the closing backtick):

```sql
    CREATE TABLE IF NOT EXISTS ${prefix}meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
```

- [ ] **Step 4: Create `src/db/migrations.ts`**

```ts
import * as SQLite from 'expo-sqlite';

export interface Migration {
  version: number;
  description: string;
  run: (db: SQLite.SQLiteDatabase, prefix: string) => Promise<void>;
}

export const CURRENT_SCHEMA_VERSION = 1;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Rebuild FTS5 entries_fts with porter unicode61 tokenizer',
    run: async (db, prefix) => {
      await db.withTransactionAsync(async () => {
        await db.execAsync(`
          DROP TRIGGER IF EXISTS ${prefix}entries_ai;
          DROP TRIGGER IF EXISTS ${prefix}entries_ad;
          DROP TRIGGER IF EXISTS ${prefix}entries_au;
          DROP TABLE IF EXISTS ${prefix}entries_fts;
          CREATE VIRTUAL TABLE ${prefix}entries_fts USING fts5(
            title,
            body,
            tags,
            content='${prefix}entries',
            content_rowid='rowid',
            tokenize='porter unicode61'
          );
          INSERT INTO ${prefix}entries_fts(rowid, title, body, tags)
            SELECT rowid, title, body, tags FROM ${prefix}entries;
          CREATE TRIGGER ${prefix}entries_ai AFTER INSERT ON ${prefix}entries BEGIN
            INSERT INTO ${prefix}entries_fts(rowid, title, body, tags)
            VALUES (new.rowid, new.title, new.body, new.tags);
          END;
          CREATE TRIGGER ${prefix}entries_ad AFTER DELETE ON ${prefix}entries BEGIN
            INSERT INTO ${prefix}entries_fts(${prefix}entries_fts, rowid, title, body, tags)
            VALUES ('delete', old.rowid, old.title, old.body, old.tags);
          END;
          CREATE TRIGGER ${prefix}entries_au AFTER UPDATE ON ${prefix}entries BEGIN
            INSERT INTO ${prefix}entries_fts(${prefix}entries_fts, rowid, title, body, tags)
            VALUES ('delete', old.rowid, old.title, old.body, old.tags);
            INSERT INTO ${prefix}entries_fts(rowid, title, body, tags)
            VALUES (new.rowid, new.title, new.body, new.tags);
          END;
        `);
      });
    },
  },
];
```

- [ ] **Step 5: Refactor `WikiMemory.setup()`**

Replace the existing `async setup()` body in `src/WikiMemory.ts`. The current body has three sections:
1. `await setupDatabase(this.db, this.prefix)` 
2. FTS porter migration block
3. Source_ref normalization block

Add imports at top of `WikiMemory.ts`:
```ts
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from './db/migrations';
```

Replace the FTS porter migration block (everything between `await setupDatabase(...)` and the source_ref normalization block) with the migration runner:

```ts
  async setup() {
    await setupDatabase(this.db, this.prefix);

    // ── Schema-version–driven migrations ────────────────────────────────────
    const metaRow = await this.db.getFirstAsync<{ value: string }>(
      `SELECT value FROM ${this.prefix}meta WHERE key = 'schema_version'`
    );

    let currentVersion: number;

    if (metaRow) {
      currentVersion = parseInt(metaRow.value, 10);
      if (!Number.isFinite(currentVersion)) currentVersion = 0;
    } else {
      // No meta row — infer version from existing schema state.
      const entriesTable = await this.db.getFirstAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
        [`${this.prefix}entries`]
      );
      if (!entriesTable) {
        // Fresh install: start at current version; no migrations needed.
        currentVersion = CURRENT_SCHEMA_VERSION;
        await this.db.runAsync(
          `INSERT OR REPLACE INTO ${this.prefix}meta (key, value) VALUES ('schema_version', ?)`,
          [String(CURRENT_SCHEMA_VERSION)]
        );
      } else {
        // Legacy install without meta row.  Use the porter probe to infer version.
        const ftsMeta = await this.db.getFirstAsync<{ sql: string | null }>(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
          [`${this.prefix}entries_fts`]
        );
        const hasPorter = /tokenize\s*=\s*['"]porter\s+unicode61['"]/i.test(ftsMeta?.sql ?? '');
        currentVersion = hasPorter ? 1 : 0;
      }
    }

    // Apply any pending migrations in order.
    for (const migration of MIGRATIONS) {
      if (migration.version > currentVersion) {
        await migration.run(this.db, this.prefix);
        await this.db.runAsync(
          `INSERT OR REPLACE INTO ${this.prefix}meta (key, value) VALUES ('schema_version', ?)`,
          [String(migration.version)]
        );
        currentVersion = migration.version;
      }
    }

    // Ensure meta row exists for fresh-but-already-current installs that
    // went through the metaRow branch with currentVersion = CURRENT_SCHEMA_VERSION.
    // (runAsync above handles legacy paths; fresh-install path writes it above.)

    // ── Data migration: normalize pre-allowlist source_ref values ────────────
    type Row = { rowid: number; source_ref: string };
    const rows = await this.db.getAllAsync<Row>(`
      SELECT rowid, source_ref FROM ${this.prefix}entries
      WHERE source_ref IS NOT NULL
        AND (
          TRIM(source_ref) != source_ref
          OR INSTR(source_ref, '/') > 0
          OR INSTR(source_ref, '\\') > 0
          OR INSTR(source_ref, CHAR(0)) > 0
          OR source_ref GLOB '*[^-A-Za-z0-9._ ]*'
        )
    `);
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
  }
```

- [ ] **Step 6: Run migration tests**

```bash
npx vitest run src/__tests__/migrations.test.ts
```

Expected: all pass.

- [ ] **Step 7: Run full suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/migrations.ts src/WikiMemory.ts src/__tests__/migrations.test.ts
git commit -m "feat(db): add meta table and migration registry; refactor setup() to version-driven migrations"
```

---

## Task 4: `hasChanged()` — TDD

**Files:**
- Modify: `src/WikiMemory.ts`
- Create: `src/__tests__/hasChanged.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/hasChanged.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

// ── Mock factory ─────────────────────────────────────────────────────────────

type EntryRow = {
  entity_id: string;
  source_ref: string | null;
  source_hash: string | null;
  deleted_at: number | null;
  updated_at: number;
};

function makeMockDb(entries: EntryRow[] = []) {
  return {
    async execAsync(_sql: string): Promise<void> {},
    async withTransactionAsync<T>(fn: () => Promise<T>): Promise<T> { return fn(); },
    async runAsync(_sql: string, _args: any[] = []) { return { changes: 0, lastInsertRowId: 0 }; },
    async getAllAsync<T>(_sql: string, _args: any[] = []): Promise<T[]> { return []; },

    async getFirstAsync<T>(sql: string, args: any[] = []): Promise<T | null> {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      // meta version
      if (normalized.includes('meta') && normalized.includes('schema_version')) return null;

      // sqlite_master checks (for setup)
      if (normalized.includes('sqlite_master')) {
        const name = args[0] as string;
        if (name.endsWith('entries')) return { name } as unknown as T;
        if (name.endsWith('entries_fts')) {
          return { sql: "CREATE VIRTUAL TABLE entries_fts USING fts5(title, body, tokenize='porter unicode61')" } as unknown as T;
        }
        return null;
      }

      // hasChanged query
      if (normalized.includes('source_ref') && normalized.includes('deleted_at IS NULL') && normalized.includes('ORDER BY updated_at DESC LIMIT 1')) {
        const [entityId, sourceRef] = args;
        const match = entries
          .filter(e => e.entity_id === entityId && e.source_ref === sourceRef && e.deleted_at == null)
          .sort((a, b) => b.updated_at - a.updated_at)[0];
        return match ? ({ source_hash: match.source_hash } as unknown as T) : null;
      }

      return null;
    },
  };
}

vi.mock('expo-sqlite', () => ({ default: {} }));

import { WikiMemory } from '../WikiMemory';
import type { WikiOptions } from '../types';

const stubOptions: WikiOptions = {
  llmProvider: { generateText: async () => '{}' },
};

const VALID_HASH = 'a'.repeat(64);
const VALID_HASH_2 = 'b'.repeat(64);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WikiMemory.hasChanged', () => {
  it('returns true when no prior ingests exist', async () => {
    const db = makeMockDb([]);
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();
    const result = await wiki.hasChanged('entity-1', 'doc.md', VALID_HASH);
    expect(result).toBe(true);
  });

  it('returns false when stored hash matches supplied hash', async () => {
    const db = makeMockDb([
      { entity_id: 'entity-1', source_ref: 'doc.md', source_hash: VALID_HASH, deleted_at: null, updated_at: 1000 },
    ]);
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();
    const result = await wiki.hasChanged('entity-1', 'doc.md', VALID_HASH);
    expect(result).toBe(false);
  });

  it('returns true when stored hash differs from supplied hash', async () => {
    const db = makeMockDb([
      { entity_id: 'entity-1', source_ref: 'doc.md', source_hash: VALID_HASH, deleted_at: null, updated_at: 1000 },
    ]);
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();
    const result = await wiki.hasChanged('entity-1', 'doc.md', VALID_HASH_2);
    expect(result).toBe(true);
  });

  it('returns true when all prior rows are soft-deleted', async () => {
    const db = makeMockDb([
      { entity_id: 'entity-1', source_ref: 'doc.md', source_hash: VALID_HASH, deleted_at: 12345, updated_at: 1000 },
    ]);
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();
    const result = await wiki.hasChanged('entity-1', 'doc.md', VALID_HASH);
    expect(result).toBe(true);
  });

  it('uses the most-recently-updated non-deleted row for comparison', async () => {
    const db = makeMockDb([
      { entity_id: 'entity-1', source_ref: 'doc.md', source_hash: VALID_HASH, deleted_at: null, updated_at: 500 },
      { entity_id: 'entity-1', source_ref: 'doc.md', source_hash: VALID_HASH_2, deleted_at: null, updated_at: 2000 },
    ]);
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();
    // Latest row has VALID_HASH_2; we supply VALID_HASH_2 → no change
    expect(await wiki.hasChanged('entity-1', 'doc.md', VALID_HASH_2)).toBe(false);
    // Supplying VALID_HASH (the older row) → changed
    expect(await wiki.hasChanged('entity-1', 'doc.md', VALID_HASH)).toBe(true);
  });

  it('throws for invalid sourceRef', async () => {
    const db = makeMockDb([]);
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();
    await expect(wiki.hasChanged('entity-1', '!!!', VALID_HASH)).rejects.toThrow();
  });

  it('throws for invalid sourceHash', async () => {
    const db = makeMockDb([]);
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();
    await expect(wiki.hasChanged('entity-1', 'doc.md', 'not-a-hash')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/__tests__/hasChanged.test.ts
```

Expected: failures — `wiki.hasChanged` does not exist.

- [ ] **Step 3: Implement `hasChanged()` on `WikiMemory`**

Add to the `WikiMemory` class in `src/WikiMemory.ts` (after `setup()`, before `read()`):

```ts
  async hasChanged(entityId: string, sourceRef: string, sourceHash: string): Promise<boolean> {
    const normalizedRef = normalizeSourceRef(sourceRef);
    if (!normalizedRef) throw new Error(`Invalid sourceRef: ${JSON.stringify(sourceRef)}`);
    const normalizedHash = normalizeSourceHash(sourceHash);
    if (!normalizedHash) throw new Error(`Invalid sourceHash: ${JSON.stringify(sourceHash)}`);

    const row = await this.db.getFirstAsync<{ source_hash: string | null }>(
      `SELECT source_hash FROM ${this.prefix}entries
       WHERE entity_id = ? AND source_ref = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT 1`,
      [entityId, normalizedRef]
    );

    if (!row) return true;
    return row.source_hash !== normalizedHash;
  }
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/hasChanged.test.ts
```

Expected: all pass.

- [ ] **Step 5: Run full suite**

```bash
npx vitest run
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/WikiMemory.ts src/__tests__/hasChanged.test.ts
git commit -m "feat(wiki): add hasChanged() for skip-ingest on unchanged sources"
```

---

## Task 5: `runPrune()` — TDD

**Files:**
- Modify: `src/WikiMemory.ts`
- Create: `src/__tests__/prune.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/prune.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

type EntryRow = {
  id: string;
  entity_id: string;
  source_ref: string | null;
  source_hash: string | null;
  deleted_at: number | null;
  updated_at: number;
  title: string;
  body: string;
  tags: string;
};

type TaskRow = {
  id: string;
  entity_id: string;
  description: string;
  deleted_at: number | null;
};

type EventRow = {
  id: string;
  entity_id: string;
  event_type: string;
  summary: string;
  created_at: number;
};

function makeMockDb(opts: {
  entries?: EntryRow[];
  tasks?: TaskRow[];
  events?: EventRow[];
  hasPorter?: boolean;
} = {}) {
  let entries: EntryRow[] = opts.entries ? [...opts.entries] : [];
  let tasks: TaskRow[] = opts.tasks ? [...opts.tasks] : [];
  let events: EventRow[] = opts.events ? [...opts.events] : [];
  const { hasPorter = true } = opts;

  const pragmaAndVacuumCalls: string[] = [];

  const db = {
    pragmaAndVacuumCalls,
    getEntries: () => entries,
    getTasks: () => tasks,
    getEvents: () => events,

    async execAsync(sql: string): Promise<void> {
      const s = sql.replace(/\s+/g, ' ').trim();
      // Track vacuum/checkpoint calls
      if (s.toUpperCase().includes('VACUUM') || s.toUpperCase().includes('WAL_CHECKPOINT')) {
        pragmaAndVacuumCalls.push(s);
      }
    },

    async withTransactionAsync<T>(fn: () => Promise<T>): Promise<T> { return fn(); },

    async runAsync(sql: string, args: any[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      // meta version write
      if (normalized.includes('meta') && normalized.includes('schema_version')) {
        return { changes: 1, lastInsertRowId: 0 };
      }

      // source_ref normalization
      if (normalized.includes('UPDATE') && normalized.includes('source_ref')) {
        return { changes: 0, lastInsertRowId: 0 };
      }

      // prune entries
      if (normalized.includes('DELETE FROM') && normalized.includes('entries') && normalized.includes('deleted_at IS NOT NULL')) {
        const [entityId, cutoff] = args;
        const before = entries.length;
        entries = entries.filter(e => !(e.entity_id === entityId && e.deleted_at != null && e.deleted_at < cutoff));
        return { changes: before - entries.length, lastInsertRowId: 0 };
      }

      // prune tasks
      if (normalized.includes('DELETE FROM') && normalized.includes('tasks') && normalized.includes('deleted_at IS NOT NULL')) {
        const [entityId, cutoff] = args;
        const before = tasks.length;
        tasks = tasks.filter(t => !(t.entity_id === entityId && t.deleted_at != null && t.deleted_at < cutoff));
        return { changes: before - tasks.length, lastInsertRowId: 0 };
      }

      // prune events
      if (normalized.includes('DELETE FROM') && normalized.includes('events') && normalized.includes('created_at <')) {
        const [entityId, cutoff] = args;
        const before = events.length;
        events = events.filter(ev => !(ev.entity_id === entityId && ev.created_at < cutoff));
        return { changes: before - events.length, lastInsertRowId: 0 };
      }

      return { changes: 0, lastInsertRowId: 0 };
    },

    async getAllAsync<T>(sql: string, _args: any[] = []): Promise<T[]> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      // source_ref normalization query
      if (normalized.includes('source_ref IS NOT NULL') && normalized.includes('GLOB')) return [] as T[];
      return [] as T[];
    },

    async getFirstAsync<T>(sql: string, args: any[] = []): Promise<T | null> {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.includes('meta') && normalized.includes('schema_version')) return { value: '1' } as unknown as T;

      if (normalized.includes('sqlite_master') && normalized.includes("type='table'")) {
        const name = args[0] as string;
        if (name.endsWith('entries')) return { name } as unknown as T;
        if (name.endsWith('entries_fts')) {
          if (!hasPorter) return { sql: 'CREATE VIRTUAL TABLE entries_fts USING fts5(title)' } as unknown as T;
          return { sql: "CREATE VIRTUAL TABLE entries_fts USING fts5(title, tokenize='porter unicode61')" } as unknown as T;
        }
        return null;
      }

      return null;
    },
  };

  return db;
}

vi.mock('expo-sqlite', () => ({ default: {} }));

import { WikiMemory, WikiBusyError } from '../WikiMemory';
import type { WikiOptions } from '../types';

// Re-export WikiBusyError from types for the test
import { WikiBusyError as WikiBusyErrorFromTypes } from '../types';

const stubOptions: WikiOptions = {
  llmProvider: { generateText: async () => '{}' },
};

const now = Date.now();
const EIGHT_DAYS_AGO = now - 8 * 86400000;
const THREE_DAYS_AGO = now - 3 * 86400000;
const THIRTY_ONE_DAYS_AGO = now - 31 * 86400000;

describe('WikiMemory.runPrune', () => {
  it('hard-deletes soft-deleted entries older than retainSoftDeletedFor threshold', async () => {
    const db = makeMockDb({
      entries: [
        { id: 'e1', entity_id: 'ent', source_ref: null, source_hash: null, deleted_at: EIGHT_DAYS_AGO, updated_at: EIGHT_DAYS_AGO, title: 'Old soft-deleted', body: '', tags: '[]' },
        { id: 'e2', entity_id: 'ent', source_ref: null, source_hash: null, deleted_at: THREE_DAYS_AGO, updated_at: THREE_DAYS_AGO, title: 'Recent soft-deleted', body: '', tags: '[]' },
        { id: 'e3', entity_id: 'ent', source_ref: null, source_hash: null, deleted_at: null, updated_at: now, title: 'Live entry', body: '', tags: '[]' },
      ],
    });
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();

    const result = await wiki.runPrune('ent', { retainSoftDeletedFor: 7 });

    expect(result.entries).toBe(1);
    // Old soft-deleted row removed; recent and live remain
    expect(db.getEntries()).toHaveLength(2);
    expect(db.getEntries().map(e => e.id)).not.toContain('e1');
    expect(db.getEntries().map(e => e.id)).toContain('e2');
    expect(db.getEntries().map(e => e.id)).toContain('e3');
  });

  it('hard-deletes soft-deleted tasks older than threshold', async () => {
    const db = makeMockDb({
      tasks: [
        { id: 't1', entity_id: 'ent', description: 'Old task', deleted_at: EIGHT_DAYS_AGO },
        { id: 't2', entity_id: 'ent', description: 'Recent task', deleted_at: THREE_DAYS_AGO },
      ],
    });
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();

    const result = await wiki.runPrune('ent', { retainSoftDeletedFor: 7 });

    expect(result.tasks).toBe(1);
    expect(db.getTasks().map(t => t.id)).not.toContain('t1');
    expect(db.getTasks().map(t => t.id)).toContain('t2');
  });

  it('hard-deletes events older than retainEventsFor threshold', async () => {
    const db = makeMockDb({
      events: [
        { id: 'ev1', entity_id: 'ent', event_type: 'observation', summary: 'Old event', created_at: THIRTY_ONE_DAYS_AGO },
        { id: 'ev2', entity_id: 'ent', event_type: 'observation', summary: 'Recent event', created_at: now - 5 * 86400000 },
      ],
    });
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();

    const result = await wiki.runPrune('ent', { retainEventsFor: 30 });

    expect(result.events).toBe(1);
    expect(db.getEvents().map(e => e.id)).not.toContain('ev1');
    expect(db.getEvents().map(e => e.id)).toContain('ev2');
  });

  it('skips entry/task prune when retainSoftDeletedFor is null', async () => {
    const db = makeMockDb({
      entries: [
        { id: 'e1', entity_id: 'ent', source_ref: null, source_hash: null, deleted_at: EIGHT_DAYS_AGO, updated_at: 0, title: '', body: '', tags: '[]' },
      ],
    });
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();

    const result = await wiki.runPrune('ent', { retainSoftDeletedFor: null });

    expect(result.entries).toBe(0);
    expect(db.getEntries()).toHaveLength(1); // not deleted
  });

  it('skips event prune when retainEventsFor is null', async () => {
    const db = makeMockDb({
      events: [
        { id: 'ev1', entity_id: 'ent', event_type: 'observation', summary: 'Old', created_at: THIRTY_ONE_DAYS_AGO },
      ],
    });
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();

    const result = await wiki.runPrune('ent', { retainEventsFor: null });

    expect(result.events).toBe(0);
    expect(db.getEvents()).toHaveLength(1);
  });

  it('calls VACUUM when vacuum=true', async () => {
    const db = makeMockDb({});
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();

    await wiki.runPrune('ent', { vacuum: true });

    const hasVacuum = db.pragmaAndVacuumCalls.some(s => s.toUpperCase().includes('VACUUM'));
    expect(hasVacuum).toBe(true);
  });

  it('does not call VACUUM when vacuum=false (default)', async () => {
    const db = makeMockDb({});
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();

    await wiki.runPrune('ent');

    const hasVacuum = db.pragmaAndVacuumCalls.some(s => s.toUpperCase().includes('VACUUM'));
    expect(hasVacuum).toBe(false);
  });

  it('throws WikiBusyError when prune is already running', async () => {
    const db = makeMockDb({});
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();

    // First prune — simulate concurrency by holding the first call unresolved
    let resolveFirst!: () => void;
    const firstPruneInflight = new Promise<void>(r => { resolveFirst = r; });
    const originalRunAsync = db.runAsync.bind(db);
    let callCount = 0;
    (db as any).runAsync = async (sql: string, args: any[]) => {
      if (sql.includes('DELETE') && callCount === 0) {
        callCount++;
        await firstPruneInflight;
      }
      return originalRunAsync(sql, args);
    };

    const first = wiki.runPrune('ent');
    // Give the first prune time to register its lock
    await new Promise(r => setTimeout(r, 0));

    await expect(wiki.runPrune('ent')).rejects.toThrow(WikiBusyErrorFromTypes);

    resolveFirst();
    await first;
  });

  it('returns correct counts', async () => {
    const db = makeMockDb({
      entries: [
        { id: 'e1', entity_id: 'ent', source_ref: null, source_hash: null, deleted_at: EIGHT_DAYS_AGO, updated_at: 0, title: '', body: '', tags: '[]' },
        { id: 'e2', entity_id: 'ent', source_ref: null, source_hash: null, deleted_at: EIGHT_DAYS_AGO, updated_at: 0, title: '', body: '', tags: '[]' },
      ],
      tasks: [
        { id: 't1', entity_id: 'ent', description: '', deleted_at: EIGHT_DAYS_AGO },
      ],
      events: [
        { id: 'ev1', entity_id: 'ent', event_type: 'observation', summary: '', created_at: THIRTY_ONE_DAYS_AGO },
        { id: 'ev2', entity_id: 'ent', event_type: 'observation', summary: '', created_at: THIRTY_ONE_DAYS_AGO },
        { id: 'ev3', entity_id: 'ent', event_type: 'observation', summary: '', created_at: THIRTY_ONE_DAYS_AGO },
      ],
    });
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.setup();

    const result = await wiki.runPrune('ent', { retainSoftDeletedFor: 7, retainEventsFor: 30 });

    expect(result.entries).toBe(2);
    expect(result.tasks).toBe(1);
    expect(result.events).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/__tests__/prune.test.ts
```

Expected: failures — `wiki.runPrune` does not exist and `WikiBusyError` is not exported from `WikiMemory`.

- [ ] **Step 3: Export `WikiBusyError` from `WikiMemory.ts`**

`WikiBusyError` is defined in `types.ts` and imported in `WikiMemory.ts`. The test imports it from `WikiMemory` for convenience. Add a re-export to `WikiMemory.ts`:

```ts
export { WikiBusyError } from './types';
```

- [ ] **Step 4: Implement `runPrune()` on `WikiMemory`**

Add after `hasChanged()` in `src/WikiMemory.ts`:

```ts
  private _pruneKey(entityId: string) { return `${this.prefix}:${entityId}:prune`; }

  async runPrune(
    entityId: string,
    options?: {
      retainSoftDeletedFor?: number | null;
      retainEventsFor?: number | null;
      vacuum?: boolean;
    }
  ): Promise<{ entries: number; tasks: number; events: number }> {
    const pruneKey = this._pruneKey(entityId);
    if (this.activeMaintenanceJobs.has(pruneKey)) {
      throw new WikiBusyError('prune', entityId);
    }
    this.activeMaintenanceJobs.add(pruneKey);

    try {
      const now = Date.now();
      const defaultRetainSoftDeleted = this.options.config?.pruneRetainSoftDeletedFor ?? 7;
      const defaultRetainEvents = this.options.config?.pruneEventsAfter ?? 30;

      const retainSoftDeletedFor = options?.retainSoftDeletedFor !== undefined
        ? options.retainSoftDeletedFor
        : defaultRetainSoftDeleted;
      const retainEventsFor = options?.retainEventsFor !== undefined
        ? options.retainEventsFor
        : defaultRetainEvents;
      const vacuum = options?.vacuum ?? false;

      let entriesDeleted = 0;
      let tasksDeleted = 0;
      let eventsDeleted = 0;

      if (retainSoftDeletedFor != null) {
        const cutoff = now - retainSoftDeletedFor * 86400000;

        const entriesResult = await this.db.runAsync(
          `DELETE FROM ${this.prefix}entries
           WHERE entity_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?`,
          [entityId, cutoff]
        );
        entriesDeleted = entriesResult.changes;

        const tasksResult = await this.db.runAsync(
          `DELETE FROM ${this.prefix}tasks
           WHERE entity_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?`,
          [entityId, cutoff]
        );
        tasksDeleted = tasksResult.changes;
      }

      if (retainEventsFor != null) {
        const cutoff = now - retainEventsFor * 86400000;
        const eventsResult = await this.db.runAsync(
          `DELETE FROM ${this.prefix}events
           WHERE entity_id = ? AND created_at < ?`,
          [entityId, cutoff]
        );
        eventsDeleted = eventsResult.changes;
      }

      if (vacuum) {
        await this.db.execAsync(`PRAGMA wal_checkpoint(TRUNCATE); VACUUM;`);
      }

      return { entries: entriesDeleted, tasks: tasksDeleted, events: eventsDeleted };
    } finally {
      this.activeMaintenanceJobs.delete(pruneKey);
    }
  }
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/__tests__/prune.test.ts
```

Expected: all pass.

- [ ] **Step 6: Run full suite**

```bash
npx vitest run
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/WikiMemory.ts src/__tests__/prune.test.ts
git commit -m "feat(wiki): add runPrune() for hard-delete of aged soft-deleted rows and events"
```

---

## Task 6: React hooks

**Files:**
- Create: `src/react/useWikiHasChanged.ts`
- Modify: `src/react/useWikiMaintenance.ts`
- Modify: `src/react/index.ts`

These hooks follow the same mechanical pattern as the other mutation hooks and do not need their own test files (no new logic — they delegate to `WikiMemory` which is already tested). A smoke-compile via typecheck is sufficient.

- [ ] **Step 1: Create `useWikiHasChanged.ts`**

Create `src/react/useWikiHasChanged.ts`:

```ts
import { useState, useCallback, useRef } from 'react';
import { useWiki } from './WikiContext';

export function useWikiHasChanged() {
  const wiki = useWiki();
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastResult, setLastResult] = useState<boolean | null>(null);

  const execute = useCallback(
    async (entityId: string, sourceRef: string, sourceHash: string): Promise<boolean> => {
      setError(null);
      setIsPending(true);
      setLastResult(null);
      try {
        const result = await wikiRef.current.hasChanged(entityId, sourceRef, sourceHash);
        setLastResult(result);
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      } finally {
        setIsPending(false);
      }
    },
    []
  );

  return { execute, lastResult, isPending, error };
}
```

- [ ] **Step 2: Extend `useWikiMaintenance.ts`**

Add `runPrune` to the hook. Open `src/react/useWikiMaintenance.ts`.

Replace:
```ts
  return { runLibrarian, runHeal, lastResult, isPending, error };
```
with:
```ts
  const runPrune = useCallback(
    async (
      entityId: string,
      options?: {
        retainSoftDeletedFor?: number | null;
        retainEventsFor?: number | null;
        vacuum?: boolean;
      }
    ): Promise<{ entries: number; tasks: number; events: number }> => {
      setError(null);
      pendingCount.current += 1;
      setIsPending(true);
      try {
        return await wikiRef.current.runPrune(entityId, options);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      } finally {
        pendingCount.current -= 1;
        if (pendingCount.current === 0) setIsPending(false);
      }
    },
    []
  );

  return { runLibrarian, runHeal, runPrune, lastResult, isPending, error };
```

- [ ] **Step 3: Export new hook from `src/react/index.ts`**

Add after the existing exports:
```ts
export { useWikiHasChanged } from './useWikiHasChanged';
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Run full suite**

```bash
npx vitest run
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/react/useWikiHasChanged.ts src/react/useWikiMaintenance.ts src/react/index.ts
git commit -m "feat(react): add useWikiHasChanged hook; extend useWikiMaintenance with runPrune"
```

---

## Task 7: README + CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document `hasChanged` in README**

In `README.md`, after the `### Forget` section and before the `---` divider that precedes "React / Expo Component API", add:

```markdown
### Check for Changes

Skip re-ingest if a document's content hasn't changed since the last ingest:

```typescript
const changed = await wiki.hasChanged('entity-123', 'preferences.md', sha256(content));
if (changed) {
  await wiki.ingestDocument('entity-123', {
    sourceRef: 'preferences.md',
    sourceHash: sha256(content),
    documentChunk: content,
  });
}
```

Returns `true` if the document has never been ingested, all prior ingest results were forgotten, or the stored hash differs from the supplied one. Returns `false` if the stored hash matches exactly.

Throws `Error` if `sourceRef` or `sourceHash` is invalid (same rules as `ingestDocument`).

### Prune (Hard Delete)

Hard-delete aged soft-deleted entries/tasks and old events to reclaim storage:

```typescript
const result = await wiki.runPrune('entity-123', {
  retainSoftDeletedFor: 7,    // days — hard-delete entries/tasks soft-deleted > 7d ago; null to skip
  retainEventsFor: 30,         // days — hard-delete events older than 30d; null to skip
  vacuum: false,               // set true to VACUUM (slow on mobile, rewrites entire DB)
});
// result: { entries: number; tasks: number; events: number }
```

Defaults: `retainSoftDeletedFor = config.pruneRetainSoftDeletedFor ?? 7`, `retainEventsFor = config.pruneEventsAfter ?? 30`, `vacuum = false`.

Throws `WikiBusyError` if another prune (or maintenance job) is in-flight for the same entity.
```

- [ ] **Step 2: Document `formatContext` in README**

In `README.md`, add a new section after "## Core API" and before "### Read". Actually, add it after the existing "### Background Maintenance" section, before "### Forget":

```markdown
### Format Context

Convert a `MemoryBundle` into a string ready for LLM prompt injection:

```typescript
import { formatContext } from 'expo-llm-wiki';

const bundle = await wiki.read('entity-123', 'weekend plans');
const context = formatContext(bundle, {
  format: 'markdown',        // 'markdown' (default) | 'plain'
  maxFacts: 10,              // default 10
  maxTasks: 10,              // default 10
  maxEvents: 10,             // default 10
  includeConfidence: true,   // default true
  includeTags: true,         // default true
  factWeights: {
    confidence: 1.0,         // default 1.0 — weight for confidence tier
    accessCount: 0.3,        // default 0.3 — weight for log(1 + access_count)
    recency: 0.5,            // default 0.5 — weight for exp(-ageDays/30)
  },
});

// Inject into your system prompt:
const systemPrompt = `You are a helpful assistant.\n\n${context}`;
```

Facts are ranked by a weighted score combining confidence tier, access frequency, and recency. Returns an empty string for an empty bundle.
```

- [ ] **Step 3: Document React hooks additions in README**

In the React / Expo Component API section, add `useWikiHasChanged` and the `runPrune` extension to `useWikiMaintenance`:

After `### useWikiForget()`, add:

```markdown
### `useWikiHasChanged()`

```typescript
const { execute, lastResult, isPending, error } = useWikiHasChanged();
// lastResult: boolean | null

const changed = await execute('entity-123', 'preferences.md', sha256(content));
```

### `useWikiMaintenance()` (extended)

`runPrune` is now available alongside `runLibrarian` and `runHeal`. Shared `isPending` is true if any operation is in-flight:

```typescript
const { runLibrarian, runHeal, runPrune, isPending, error } = useWikiMaintenance();

const result = await runPrune('entity-123', { retainSoftDeletedFor: 7, retainEventsFor: 30 });
// result: { entries: number; tasks: number; events: number }
```
```

- [ ] **Step 4: Add CHANGELOG entry**

At the top of `CHANGELOG.md`, before the existing `# [2.1.0]` entry, add:

```markdown
# [2.2.0] (upcoming)

### Features

* **utils:** add `formatContext(bundle, options?)` for LLM prompt injection with confidence/recency/access-count ranking
* **wiki:** add `hasChanged(entityId, sourceRef, sourceHash)` to skip re-ingest of unchanged documents
* **wiki:** add `runPrune(entityId, options?)` to hard-delete aged soft-deleted entries/tasks and old events
* **db:** schema versioning via `{prefix}meta` table; migrate porter rebuild to numbered migration registry
* **react:** add `useWikiHasChanged` hook
* **react:** extend `useWikiMaintenance` with `runPrune`
* **types:** add `FormatContextOptions`, `pruneRetainSoftDeletedFor` config key, extend `WikiBusyError` operation union with `'prune'`

```

- [ ] **Step 5: Run full suite one final time**

```bash
npx vitest run
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document formatContext, hasChanged, runPrune, useWikiHasChanged, and schema versioning"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `formatContext` util with ranking | Task 2 |
| `FormatContextOptions` type | Task 1 |
| Re-export `formatContext` from index | Task 2 step 4 |
| `formatContext` tests | Task 2 step 1 |
| `hasChanged()` method | Task 4 |
| `hasChanged` throws on invalid input | Task 4 tests |
| `useWikiHasChanged` hook | Task 6 step 1 |
| `hasChanged` tests | Task 4 step 1 |
| `{prefix}meta` table | Task 3 step 3 |
| Migration registry `migrations.ts` | Task 3 step 4 |
| `setup()` refactor with version inference | Task 3 step 5 |
| Migration tests | Task 3 step 1 |
| `runPrune()` method | Task 5 |
| `WikiBusyError` `'prune'` operation | Task 1 |
| `pruneRetainSoftDeletedFor` config key | Task 1 |
| Activate dead `pruneEventsAfter` key | Task 5 step 4 |
| Vacuum option | Task 5 step 4 |
| `runPrune` tests | Task 5 step 1 |
| Extend `useWikiMaintenance` | Task 6 step 2 |
| Export new hook | Task 6 step 3 |
| README documentation | Task 7 |
| CHANGELOG entry | Task 7 |

All spec requirements are covered.
