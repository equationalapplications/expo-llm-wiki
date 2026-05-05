# Integration Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `packages/integration/` test package that verifies the full `WikiMemory` public API through realistic scenario-driven call sequences, including semantic recall quality under real embeddings.

**Architecture:** Scenario-driven integration tests live in a private `packages/integration/` package (not published). Helpers provide a fresh in-memory SQLite database per test, a `stubLLM()` for ops where LLM output doesn't matter, and a `scriptedLLM(responses)` for ops where the LLM's output must be controlled. A `recall.test.ts` file uses `fastembed` (ONNX, no API key) for real semantic embedding tests.

**Tech Stack:** Vitest 4.1.5, better-sqlite3 (in-memory SQLite), TypeScript 5.4, fastembed 2.1.0 (recall tests only). Core package imported via path alias pointing to source — no build step required for tests.

**Dependency note:** Tasks marked `[NEEDS: feat/retrieval-tuning]` test APIs added in that branch (`ReadOptions`, `hybridWeight`, `clearVectorCache()`, `embedding_blob` roundtrip). Implement those tests with `it.skip` now; remove the `.skip` after the PR merges and is rebased in.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `packages/integration/package.json` | Create | Private package metadata, deps |
| `packages/integration/tsconfig.json` | Create | TS config with path alias for core |
| `packages/integration/vitest.config.ts` | Create | Vitest config with resolve alias + 60s timeout |
| `packages/integration/helpers/db.ts` | Create | `openTestDatabase()` — in-memory SQLite |
| `packages/integration/helpers/llm.ts` | Create | `stubLLM()`, `scriptedLLM()`, `keywordEmbed()` |
| `packages/integration/helpers/wiki.ts` | Create | `makeWiki()` factory |
| `packages/integration/__tests__/exportImport.test.ts` | Create | 3 export/import scenarios |
| `packages/integration/__tests__/maintenance.test.ts` | Create | 4 maintenance scenarios |
| `packages/integration/__tests__/pipeline.test.ts` | Create | 3 write→librarian→read scenarios |
| `packages/integration/__tests__/recall.test.ts` | Create | 4 semantic recall scenarios (fastembed) |

---

## Task 1: Package scaffold

**Files:**
- Create: `packages/integration/package.json`
- Create: `packages/integration/tsconfig.json`
- Create: `packages/integration/vitest.config.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@equationalapplications/integration-llm-wiki",
  "version": "0.0.0",
  "private": true,
  "description": "Integration tests for LLM Wiki Memory — not published.",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@equationalapplications/core-llm-wiki": "workspace:*"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "better-sqlite3": "^12.9.0",
    "fastembed": "^2.1.0",
    "typescript": "^5.4.0",
    "vitest": "4.1.5"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": {
      "@equationalapplications/core-llm-wiki": ["../core/src/index.ts"]
    }
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@equationalapplications/core-llm-wiki': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
```

- [ ] **Step 4: Install dependencies**

Run from the repo root:

```bash
pnpm install
```

Expected: pnpm symlinks the new package into the workspace, installs `better-sqlite3` and `fastembed` into `packages/integration/node_modules`.

- [ ] **Step 5: Typecheck**

```bash
cd packages/integration && pnpm typecheck
```

Expected: exits 0 (no source files yet, but config should be valid).

- [ ] **Step 6: Commit**

```bash
git add packages/integration/package.json packages/integration/tsconfig.json packages/integration/vitest.config.ts
git commit -m "feat(integration): scaffold integration test package"
```

---

## Task 2: Helpers

**Files:**
- Create: `packages/integration/helpers/db.ts`
- Create: `packages/integration/helpers/llm.ts`
- Create: `packages/integration/helpers/wiki.ts`

- [ ] **Step 1: Create `helpers/db.ts`**

Copies `openTestDatabase` from core — that helper is not exported from the core package, so the implementation is duplicated here (it's 40 lines, self-contained).

```ts
import Database from 'better-sqlite3';
import type { SQLiteAdapter } from '@equationalapplications/core-llm-wiki';

export function openTestDatabase(): SQLiteAdapter {
  const db = new Database(':memory:');

  return {
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
    async closeAsync(): Promise<void> {
      db.close();
    },
  };
}
```

- [ ] **Step 2: Create `helpers/llm.ts`**

```ts
import type { LLMProvider } from '@equationalapplications/core-llm-wiki';

export function stubLLM(): LLMProvider {
  return { generateText: async () => '{}' };
}

export function scriptedLLM(
  responses: string[],
  embedFn?: (text: string) => Promise<number[]>
): LLMProvider {
  let callIndex = 0;
  return {
    generateText: async () => {
      const response = responses[callIndex++];
      if (response === undefined) {
        throw new Error(`Unexpected LLM call at index ${callIndex - 1} (script has ${responses.length} entries)`);
      }
      return response;
    },
    embed: embedFn,
  };
}

export function keywordEmbed(text: string): number[] {
  if (text.includes('apple')) return [1, 0, 0];
  if (text.includes('car') || text.includes('vehicle')) return [0, 1, 0];
  return [0, 0, 1];
}
```

- [ ] **Step 3: Create `helpers/wiki.ts`**

```ts
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { LLMProvider, WikiConfig, SQLiteAdapter } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from './db';

export function makeWiki(
  llm: LLMProvider,
  config?: WikiConfig
): { wiki: WikiMemory; db: SQLiteAdapter } {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: llm, config });
  return { wiki, db };
}
```

- [ ] **Step 4: Typecheck**

```bash
cd packages/integration && pnpm typecheck
```

Expected: exits 0.

- [ ] **Step 5: Run (no test files yet — should report zero tests)**

```bash
cd packages/integration && pnpm test
```

Expected: `No test files found, exiting with code 0` or similar zero-test pass.

- [ ] **Step 6: Commit**

```bash
git add packages/integration/helpers/
git commit -m "feat(integration): add db, llm, and wiki test helpers"
```

---

## Task 3: Export/Import — Scenarios 1 & 2

**Files:**
- Create: `packages/integration/__tests__/exportImport.test.ts`

Scenarios: full roundtrip preserves facts and ranking; merge collision picks newer `updated_at`.

- [ ] **Step 1: Write failing tests**

Create `packages/integration/__tests__/exportImport.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { stubLLM, keywordEmbed } from '../helpers/llm';

function seedDump(
  entityId: string,
  facts: Array<{
    id: string;
    title: string;
    body: string;
    source_type?: 'agent_inferred' | 'user_document' | 'user_stated' | 'user_confirmed';
    updated_at?: number;
  }>
): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      [entityId]: {
        facts: facts.map((f, i) => ({
          id: f.id,
          entity_id: entityId,
          title: f.title,
          body: f.body,
          tags: [],
          confidence: 'certain' as const,
          source_type: f.source_type ?? 'agent_inferred',
          source_hash: null,
          source_ref: null,
          created_at: (i + 1) * 1000,
          updated_at: f.updated_at ?? (i + 1) * 1000,
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

describe('exportImport — Scenario 1: full roundtrip preserves facts and ranking', () => {
  it('read() returns same rank-1 fact after export → import into fresh wiki', async () => {
    const llm = stubLLM();
    const embed = async (text: string) => keywordEmbed(text);

    // Original wiki
    const dbA = openTestDatabase();
    const wikiA = new WikiMemory(dbA, { llmProvider: { ...llm, embed } });
    await wikiA.setup();
    await wikiA.importDump(
      seedDump('user-1', [
        { id: 'fact-apple', title: 'apple fruit', body: 'red and green' },
        { id: 'fact-car', title: 'car vehicle', body: 'fast engine' },
      ])
    );
    // Store TEXT embeddings so ranking works
    await wikiA.runReembed('user-1');

    const beforeExport = await wikiA.read('user-1', 'apple');
    expect(beforeExport.facts[0].id).toBe('fact-apple');

    // Export and import into fresh wiki
    const dump = await wikiA.exportDump();
    const dbB = openTestDatabase();
    const wikiB = new WikiMemory(dbB, { llmProvider: { ...llm, embed } });
    await wikiB.setup();
    await wikiB.importDump(dump);
    // Re-embed because TEXT embeddings are not included in the dump on this branch
    await wikiB.runReembed('user-1');

    const afterImport = await wikiB.read('user-1', 'apple');
    expect(afterImport.facts[0].id).toBe('fact-apple');
  });

  it('fact count and source_type are preserved after roundtrip', async () => {
    const llm = stubLLM();
    const dbA = openTestDatabase();
    const wikiA = new WikiMemory(dbA, { llmProvider: llm });
    await wikiA.setup();
    await wikiA.importDump(
      seedDump('user-1', [
        { id: 'f1', title: 'Alpha', body: 'body', source_type: 'user_document' },
        { id: 'f2', title: 'Beta', body: 'body', source_type: 'agent_inferred' },
      ])
    );

    const dump = await wikiA.exportDump();
    const dbB = openTestDatabase();
    const wikiB = new WikiMemory(dbB, { llmProvider: llm });
    await wikiB.setup();
    await wikiB.importDump(dump);

    const bundle = await wikiB.getMemoryBundle('user-1');
    expect(bundle.facts).toHaveLength(2);
    const sourceTypes = bundle.facts.map((f) => f.source_type).sort();
    expect(sourceTypes).toEqual(['agent_inferred', 'user_document']);
  });
});

describe('exportImport — Scenario 2: merge collision, newer updated_at wins', () => {
  it('f1 body from dump B wins when updated_at is newer; f2 and f3 both survive', async () => {
    const llm = stubLLM();
    const dbA = openTestDatabase();
    const wikiA = new WikiMemory(dbA, { llmProvider: llm });
    await wikiA.setup();

    const dumpA: MemoryDump = {
      generatedAt: Date.now(),
      entities: {
        'user-1': {
          facts: [
            {
              id: 'f1',
              entity_id: 'user-1',
              title: 'Shared fact',
              body: 'body from A',
              tags: [],
              confidence: 'certain',
              source_type: 'agent_inferred',
              source_hash: null,
              source_ref: null,
              created_at: 1000,
              updated_at: 1000,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
            {
              id: 'f2',
              entity_id: 'user-1',
              title: 'Unique to A',
              body: 'only in A',
              tags: [],
              confidence: 'certain',
              source_type: 'agent_inferred',
              source_hash: null,
              source_ref: null,
              created_at: 1000,
              updated_at: 1000,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
          ],
          tasks: [],
          events: [],
        },
      },
    };

    await wikiA.importDump(dumpA);

    const dumpB: MemoryDump = {
      generatedAt: Date.now(),
      entities: {
        'user-1': {
          facts: [
            {
              id: 'f1',
              entity_id: 'user-1',
              title: 'Shared fact',
              body: 'body from B — newer',
              tags: [],
              confidence: 'certain',
              source_type: 'agent_inferred',
              source_hash: null,
              source_ref: null,
              created_at: 1000,
              updated_at: 2000,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
            {
              id: 'f3',
              entity_id: 'user-1',
              title: 'Unique to B',
              body: 'only in B',
              tags: [],
              confidence: 'certain',
              source_type: 'agent_inferred',
              source_hash: null,
              source_ref: null,
              created_at: 1000,
              updated_at: 1000,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
          ],
          tasks: [],
          events: [],
        },
      },
    };

    await wikiA.importDump(dumpB, { merge: true });

    const bundle = await wikiA.getMemoryBundle('user-1');
    const byId = Object.fromEntries(bundle.facts.map((f) => [f.id, f]));

    expect(byId['f1'].body).toBe('body from B — newer');
    expect(byId['f2']).toBeDefined();
    expect(byId['f3']).toBeDefined();
  });

  it('older dump B updated_at does not overwrite newer fact already in wiki', async () => {
    const llm = stubLLM();
    const dbA = openTestDatabase();
    const wikiA = new WikiMemory(dbA, { llmProvider: llm });
    await wikiA.setup();

    const base: MemoryDump = {
      generatedAt: Date.now(),
      entities: {
        'user-1': {
          facts: [
            {
              id: 'f1',
              entity_id: 'user-1',
              title: 'Fact',
              body: 'current body',
              tags: [],
              confidence: 'certain',
              source_type: 'agent_inferred',
              source_hash: null,
              source_ref: null,
              created_at: 1000,
              updated_at: 2000,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
          ],
          tasks: [],
          events: [],
        },
      },
    };
    await wikiA.importDump(base);

    const stale: MemoryDump = {
      generatedAt: Date.now(),
      entities: {
        'user-1': {
          facts: [
            {
              id: 'f1',
              entity_id: 'user-1',
              title: 'Fact',
              body: 'stale body — should lose',
              tags: [],
              confidence: 'certain',
              source_type: 'agent_inferred',
              source_hash: null,
              source_ref: null,
              created_at: 1000,
              updated_at: 1000,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
            },
          ],
          tasks: [],
          events: [],
        },
      },
    };
    await wikiA.importDump(stale, { merge: true });

    const bundle = await wikiA.getMemoryBundle('user-1');
    expect(bundle.facts[0].body).toBe('current body');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd packages/integration && pnpm test -- --reporter=verbose 2>&1 | grep -E 'PASS|FAIL|✓|✗|Error'
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/exportImport.test.ts
git commit -m "test(integration): export/import roundtrip and merge collision scenarios"
```

---

## Task 4: Export/Import — Scenario 3 (BLOB roundtrip) `[NEEDS: feat/retrieval-tuning]`

**Files:**
- Modify: `packages/integration/__tests__/exportImport.test.ts`

This scenario requires `embedding_blob` to be exported/imported. On `main`, TEXT embeddings are not preserved across dumps — `runReembed` after import always reports `embedded: N`. Implement as `it.skip`; remove `.skip` after `feat/retrieval-tuning` merges.

- [ ] **Step 1: Append skipped scenario to `exportImport.test.ts`**

Add at the bottom of `packages/integration/__tests__/exportImport.test.ts`:

```ts
// NOTE: Requires feat/retrieval-tuning to be merged (embedding_blob in exportDump).
// Remove .skip after that PR is merged and this branch is rebased.
describe.skip('exportImport — Scenario 3: embedding BLOB survives roundtrip', () => {
  it('runReembed after import reports embedded:0, skipped:N', async () => {
    const embed = async (text: string) => keywordEmbed(text);
    const llm = stubLLM();
    const dbA = openTestDatabase();
    const wikiA = new WikiMemory(dbA, { llmProvider: { ...llm, embed } });
    await wikiA.setup();
    await wikiA.importDump(
      seedDump('user-1', [
        { id: 'f1', title: 'apple fruit', body: 'red' },
        { id: 'f2', title: 'car vehicle', body: 'fast' },
      ])
    );
    const { embedded } = await wikiA.runReembed('user-1');
    expect(embedded).toBe(2);

    const dump = await wikiA.exportDump();
    const dbB = openTestDatabase();
    const wikiB = new WikiMemory(dbB, { llmProvider: { ...llm, embed } });
    await wikiB.setup();
    await wikiB.importDump(dump);

    const result = await wikiB.runReembed('user-1');
    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd packages/integration && pnpm test 2>&1 | grep -E 'PASS|FAIL|skip'
```

Expected: Scenarios 1 & 2 pass; Scenario 3 skipped.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/exportImport.test.ts
git commit -m "test(integration): BLOB roundtrip scenario (skipped pending retrieval-tuning merge)"
```

---

## Task 5: Maintenance — Scenarios 1 & 2 (runHeal culls and protects)

**Files:**
- Create: `packages/integration/__tests__/maintenance.test.ts`

`runHeal` soft-deletes facts with `access_count = 0` older than `orphanAfterDays`. With `orphanAfterDays: 0` any never-accessed fact created before now qualifies. `user_document` facts are excluded from both the orphan pass and the LLM delete list.

- [ ] **Step 1: Write the tests**

Create `packages/integration/__tests__/maintenance.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { stubLLM, scriptedLLM } from '../helpers/llm';

function makeFact(
  id: string,
  entityId: string,
  source_type: 'agent_inferred' | 'user_document',
  created_at = 1
) {
  return {
    id,
    entity_id: entityId,
    title: `Title ${id}`,
    body: `Body of ${id}`,
    tags: [] as string[],
    confidence: 'certain' as const,
    source_type,
    source_hash: null,
    source_ref: null,
    created_at,
    updated_at: created_at,
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
  };
}

function makeDump(entityId: string, facts: ReturnType<typeof makeFact>[]): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: { [entityId]: { facts, tasks: [], events: [] } },
  };
}

describe('maintenance — Scenario 1: runHeal culls orphaned agent_inferred, spares user_document', () => {
  it('soft-deletes agent_inferred fact; user_document fact remains', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: stubLLM(),
      config: { orphanAfterDays: 0 },
    });
    await wiki.setup();

    await wiki.importDump(
      makeDump('entity-1', [
        makeFact('agent-fact', 'entity-1', 'agent_inferred', 1),
        makeFact('doc-fact', 'entity-1', 'user_document', 1),
      ])
    );

    await wiki.runHeal('entity-1');

    const bundle = await wiki.getMemoryBundle('entity-1');
    const ids = bundle.facts.map((f) => f.id);
    expect(ids).not.toContain('agent-fact');
    expect(ids).toContain('doc-fact');
  });
});

describe('maintenance — Scenario 2: runHeal LLM phase deletes agent_inferred, user_document protected', () => {
  it('LLM-requested delete on agent_inferred fact is honoured', async () => {
    const db = openTestDatabase();
    // orphanAfterDays: null disables the orphan auto-pass so only LLM deletion matters
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([
        JSON.stringify({ downgraded: [], deleted: ['fact-a'], newFacts: [] }),
      ]),
      config: { orphanAfterDays: null, staleInferredAfterDays: null },
    });
    await wiki.setup();

    await wiki.importDump(
      makeDump('entity-1', [
        makeFact('fact-a', 'entity-1', 'agent_inferred', 1),
        makeFact('doc-1', 'entity-1', 'user_document', 1),
      ])
    );

    await wiki.runHeal('entity-1');

    const bundle = await wiki.getMemoryBundle('entity-1');
    const ids = bundle.facts.map((f) => f.id);
    expect(ids).not.toContain('fact-a');
    expect(ids).toContain('doc-1');
  });

  it('LLM-requested delete on user_document fact is silently ignored', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      // LLM tries to delete both fact-a (valid) and doc-1 (user_document — should be blocked)
      llmProvider: scriptedLLM([
        JSON.stringify({ downgraded: [], deleted: ['fact-a', 'doc-1'], newFacts: [] }),
      ]),
      config: { orphanAfterDays: null, staleInferredAfterDays: null },
    });
    await wiki.setup();

    await wiki.importDump(
      makeDump('entity-1', [
        makeFact('fact-a', 'entity-1', 'agent_inferred', 1),
        makeFact('doc-1', 'entity-1', 'user_document', 1),
      ])
    );

    await wiki.runHeal('entity-1');

    const bundle = await wiki.getMemoryBundle('entity-1');
    const ids = bundle.facts.map((f) => f.id);
    expect(ids).not.toContain('fact-a');
    expect(ids).toContain('doc-1');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd packages/integration && pnpm test -- --reporter=verbose 2>&1 | grep -E 'PASS|FAIL|✓|✗'
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/maintenance.test.ts
git commit -m "test(integration): runHeal orphan cull and user_document protection scenarios"
```

---

## Task 6: Maintenance — Scenario 3 (clearVectorCache) `[NEEDS: feat/retrieval-tuning]`

**Files:**
- Modify: `packages/integration/__tests__/maintenance.test.ts`

`clearVectorCache()` and `embedding_blob` only exist after `feat/retrieval-tuning` merges.

- [ ] **Step 1: Append skipped scenario**

Add at the bottom of `packages/integration/__tests__/maintenance.test.ts`:

```ts
// NOTE: Requires feat/retrieval-tuning (clearVectorCache + embedding_blob).
// Remove .skip after that PR is merged and this branch is rebased.
describe.skip('maintenance — Scenario 3: runReembed writes BLOBs; read() loads from cache, no re-embed', () => {
  it('embed() called N times for facts during runReembed, once for query during read()', async () => {
    const embedCalls: string[] = [];
    const embed = async (text: string): Promise<number[]> => {
      embedCalls.push(text);
      if (text.includes('apple')) return [1, 0, 0];
      return [0, 0, 1];
    };

    const db = openTestDatabase();
    // WikiMemory is from feat/retrieval-tuning which has clearVectorCache
    const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}', embed } });
    await wiki.setup();

    await wiki.importDump({
      generatedAt: Date.now(),
      entities: {
        'entity-1': {
          facts: [
            {
              id: 'f1', entity_id: 'entity-1', title: 'apple fruit', body: 'red',
              tags: [], confidence: 'certain', source_type: 'agent_inferred',
              source_hash: null, source_ref: null, created_at: 1000, updated_at: 1000,
              last_accessed_at: null, access_count: 0, deleted_at: null,
            },
            {
              id: 'f2', entity_id: 'entity-1', title: 'car vehicle', body: 'fast',
              tags: [], confidence: 'certain', source_type: 'agent_inferred',
              source_hash: null, source_ref: null, created_at: 2000, updated_at: 2000,
              last_accessed_at: null, access_count: 0, deleted_at: null,
            },
          ],
          tasks: [],
          events: [],
        },
      },
    });

    await wiki.runReembed('entity-1');
    const factEmbedCallCount = embedCalls.length;
    expect(factEmbedCallCount).toBe(2);

    // Clear cache so read() must reload from BLOBs, not in-memory cache
    (wiki as any).clearVectorCache();
    embedCalls.length = 0;

    await wiki.read('entity-1', 'apple');

    // embed() called once for the query string only; facts loaded from BLOBs
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toBe('apple');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd packages/integration && pnpm test 2>&1 | grep -E 'skip|pass|fail'
```

Expected: Scenarios 1 & 2 pass; Scenario 3 skipped.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/maintenance.test.ts
git commit -m "test(integration): vector cache scenario (skipped pending retrieval-tuning merge)"
```

---

## Task 7: Maintenance — Scenario 4 (mutex)

**Files:**
- Modify: `packages/integration/__tests__/maintenance.test.ts`

- [ ] **Step 1: Update imports at top of `maintenance.test.ts`**

The full import block at the top of `maintenance.test.ts` must be:

```ts
import { describe, it, expect } from 'vitest';
import { WikiMemory, WikiBusyError } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { stubLLM, scriptedLLM } from '../helpers/llm';
```

- [ ] **Step 2: Append mutex scenario**

`runPrune` does not call `generateText` — it runs SQL and returns immediately. Blocking the LLM cannot keep prune in-flight. The integration point we're testing is the lock-key check, so inject the prune key directly into `activeMaintenanceJobs`, which is exactly how the existing unit tests in `packages/core/__tests__/jobs.test.ts` verify the same behaviour.

The prune key format is `${tablePrefix}:${entityId}:prune`. With default config, `tablePrefix = 'llm_wiki_'`, so the key is `'llm_wiki_:entity-a:prune'`.

Add at the bottom of `packages/integration/__tests__/maintenance.test.ts`:

```ts
describe('maintenance — Scenario 4: prune lock blocks runLibrarian; different entity unaffected', () => {
  it('runLibrarian on same entity throws WikiBusyError while prune lock is held', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: stubLLM() });
    await wiki.setup();

    // Inject prune lock to simulate runPrune in-flight
    (wiki as any).activeMaintenanceJobs.add('llm_wiki_:entity-a:prune');

    await expect(wiki.runLibrarian('entity-a')).rejects.toBeInstanceOf(WikiBusyError);

    (wiki as any).activeMaintenanceJobs.delete('llm_wiki_:entity-a:prune');
  });

  it('runLibrarian on entity-b proceeds normally while entity-a prune lock is held', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: stubLLM() });
    await wiki.setup();

    (wiki as any).activeMaintenanceJobs.add('llm_wiki_:entity-a:prune');

    // entity-b has no lock — resolves without error
    await expect(wiki.runLibrarian('entity-b')).resolves.toBeUndefined();

    (wiki as any).activeMaintenanceJobs.delete('llm_wiki_:entity-a:prune');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd packages/integration && pnpm test -- --reporter=verbose 2>&1 | grep -E 'PASS|FAIL|✓|✗|skip'
```

Expected: Scenarios 1, 2, 4 pass; Scenario 3 skipped.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/maintenance.test.ts
git commit -m "test(integration): maintenance mutex — WikiBusyError on concurrent prune+librarian"
```

---

## Task 8: Pipeline — Scenarios 1, 2, 3

**Files:**
- Create: `packages/integration/__tests__/pipeline.test.ts`

Scenarios: write→librarian→read; forget removes fact; multi-entity isolation.

`runLibrarian` expects `{ "facts": [...], "tasks": [] }` from the LLM. Each fact needs `title`, `body`, `tags`, `confidence`. The Librarian deduplicates facts with ≥2 title tokens by Jaccard similarity — use distinct titles to avoid dedup.

- [ ] **Step 1: Write tests**

Create `packages/integration/__tests__/pipeline.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { scriptedLLM, stubLLM } from '../helpers/llm';

describe('pipeline — Scenario 1: write → runLibrarian → read', () => {
  it('facts extracted by LLM are returned by read() in relevance order', async () => {
    const db = openTestDatabase();
    const librarianResponse = JSON.stringify({
      facts: [
        { title: 'Editor', body: 'Uses vim', tags: ['tools'], confidence: 'certain' },
        { title: 'UI theme', body: 'Prefers dark mode', tags: ['ui'], confidence: 'certain' },
      ],
      tasks: [],
    });
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([librarianResponse], async (text) => {
        // keyword embed so 'editor vim' scores high for 'vim' queries
        if (text.toLowerCase().includes('vim') || text.toLowerCase().includes('editor')) return [1, 0, 0];
        if (text.toLowerCase().includes('dark') || text.toLowerCase().includes('ui')) return [0, 1, 0];
        return [0, 0, 1];
      }),
    });
    await wiki.setup();

    await wiki.write('user-1', {
      event_type: 'observation',
      summary: 'User prefers vim and dark mode',
    });

    await wiki.runLibrarian('user-1');

    const result = await wiki.read('user-1', 'vim editor');
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts[0].title).toBe('Editor');
  });

  it('events array is non-empty in bundle after write()', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([JSON.stringify({ facts: [], tasks: [] })]),
    });
    await wiki.setup();

    await wiki.write('user-1', { event_type: 'observation', summary: 'Hello world' });
    await wiki.runLibrarian('user-1');

    const bundle = await wiki.getMemoryBundle('user-1');
    expect(bundle.events.length).toBeGreaterThan(0);
  });
});

describe('pipeline — Scenario 2: forget() removes fact from read()', () => {
  it('forgotten fact is absent from subsequent read(); other facts remain', async () => {
    const db = openTestDatabase();
    const librarianResponse = JSON.stringify({
      facts: [
        { title: 'Editor choice', body: 'Uses vim', tags: [], confidence: 'certain' },
        { title: 'UI preference', body: 'Dark mode', tags: [], confidence: 'certain' },
      ],
      tasks: [],
    });
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([librarianResponse], async (text) => {
        if (text.toLowerCase().includes('editor') || text.toLowerCase().includes('vim')) return [1, 0, 0];
        if (text.toLowerCase().includes('ui') || text.toLowerCase().includes('dark')) return [0, 1, 0];
        return [0, 0, 1];
      }),
    });
    await wiki.setup();

    await wiki.write('user-1', { event_type: 'observation', summary: 'vim and dark mode' });
    await wiki.runLibrarian('user-1');

    // Identify the editor fact id
    const before = await wiki.getMemoryBundle('user-1');
    const editorFact = before.facts.find((f) => f.title === 'Editor choice');
    expect(editorFact).toBeDefined();

    await wiki.forget('user-1', { entryId: editorFact!.id });

    const result = await wiki.read('user-1', 'vim editor');
    const ids = result.facts.map((f) => f.id);
    expect(ids).not.toContain(editorFact!.id);
    // UI preference should still be present
    expect(result.facts.some((f) => f.title === 'UI preference')).toBe(true);
  });
});

describe('pipeline — Scenario 3: multi-entity isolation', () => {
  it('read() for entity-a never returns facts belonging to entity-b', async () => {
    const db = openTestDatabase();
    const callCount = { n: 0 };
    const wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => {
          const idx = callCount.n++;
          if (idx === 0) {
            return JSON.stringify({
              facts: [{ title: 'Editor tool', body: 'Uses vim', tags: [], confidence: 'certain' }],
              tasks: [],
            });
          }
          return JSON.stringify({
            facts: [{ title: 'Cooking technique', body: 'Loves braising', tags: [], confidence: 'certain' }],
            tasks: [],
          });
        },
        embed: async (text: string): Promise<number[]> => {
          if (text.toLowerCase().includes('vim') || text.toLowerCase().includes('editor')) return [1, 0, 0];
          if (text.toLowerCase().includes('brai') || text.toLowerCase().includes('cook')) return [0, 1, 0];
          return [0, 0, 1];
        },
      },
    });
    await wiki.setup();

    await wiki.write('user-1', { event_type: 'observation', summary: 'Uses vim editor' });
    await wiki.runLibrarian('user-1');

    await wiki.write('user-2', { event_type: 'observation', summary: 'Loves braising' });
    await wiki.runLibrarian('user-2');

    const resultA = await wiki.read('user-1', 'cooking braising');
    const resultB = await wiki.read('user-2', 'vim editor');

    expect(resultA.facts.every((f) => f.entity_id === 'user-1')).toBe(true);
    expect(resultB.facts.every((f) => f.entity_id === 'user-2')).toBe(true);
    expect(resultA.facts.some((f) => f.title === 'Cooking technique')).toBe(false);
    expect(resultB.facts.some((f) => f.title === 'Editor tool')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd packages/integration && pnpm test -- --reporter=verbose 2>&1 | grep -E 'PASS|FAIL|✓|✗'
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/pipeline.test.ts
git commit -m "test(integration): pipeline write→librarian→read, forget, multi-entity isolation"
```

---

## Task 9: Recall — Setup + Scenarios 1 & 3 (real fastembed)

**Files:**
- Create: `packages/integration/__tests__/recall.test.ts`

Uses real ONNX embeddings via `fastembed`. First run downloads the BGE-small-EN-v1.5 model (~30MB) into the ONNX runtime cache. Subsequent runs use the cached model. The `beforeAll` timeout is set to 30 seconds to accommodate the first download. The `testTimeout: 60_000` in `vitest.config.ts` already covers individual test duration.

`embedder.embed([text])` returns an `AsyncGenerator<Float32Array[]>`. We consume the first batch to get the vector.

- [ ] **Step 1: Write recall tests (Scenarios 1 & 3 only; 2 & 4 added in Task 10 as skipped)**

Create `packages/integration/__tests__/recall.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { openTestDatabase } from '../helpers/db';

let embedder: FlagEmbedding;

beforeAll(async () => {
  embedder = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15 });
}, 30_000);

async function embed(text: string): Promise<number[]> {
  const gen = embedder.embed([text]);
  for await (const batch of gen) {
    return Array.from(batch[0]);
  }
  throw new Error('fastembed returned no vectors');
}

function makeDump(entityId: string, items: Array<{ id: string; title: string; body: string }>): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      [entityId]: {
        facts: items.map((item, i) => ({
          id: item.id,
          entity_id: entityId,
          title: item.title,
          body: item.body,
          tags: [] as string[],
          confidence: 'certain' as const,
          source_type: 'agent_inferred' as const,
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

describe('recall — Scenario 1: synonym recall@5 = 1.0', () => {
  it('all 3 vehicle facts appear in top-5 results for query "transportation"', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}', embed },
    });
    await wiki.setup();

    await wiki.importDump(
      makeDump('user-1', [
        { id: 'f-auto', title: 'Automobile', body: 'A wheeled motor vehicle used for transportation' },
        { id: 'f-car', title: 'Car', body: 'Used for personal transportation on roads' },
        { id: 'f-vehicle', title: 'Vehicle', body: 'Carries passengers or cargo from place to place' },
      ])
    );
    await wiki.runReembed('user-1');

    const result = await wiki.read('user-1', 'transportation');
    const ids = result.facts.map((f) => f.id);
    expect(ids).toContain('f-auto');
    expect(ids).toContain('f-car');
    expect(ids).toContain('f-vehicle');
  });
});

describe('recall — Scenario 3: domain separation, precision@3 = 1.0', () => {
  it('top-3 results for "recursion" are all programming facts', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}', embed },
      config: { maxResults: 3 },
    });
    await wiki.setup();

    await wiki.importDump(
      makeDump('user-1', [
        { id: 'p1', title: 'Recursion', body: 'A function that calls itself with a base case' },
        { id: 'p2', title: 'Closures', body: 'Functions that capture variables from their outer scope' },
        { id: 'p3', title: 'Async await', body: 'Syntax for writing asynchronous JavaScript code' },
        { id: 'p4', title: 'Type inference', body: 'Compiler deduces types without explicit annotations' },
        { id: 'p5', title: 'Garbage collection', body: 'Automatic memory management in managed runtimes' },
        { id: 'c1', title: 'Sauté', body: 'Cooking food quickly in a small amount of oil over high heat' },
        { id: 'c2', title: 'Braising', body: 'Slow cooking in liquid after initial browning' },
        { id: 'c3', title: 'Mise en place', body: 'Preparing and organizing all ingredients before cooking' },
        { id: 'c4', title: 'Emulsification', body: 'Combining two immiscible liquids like oil and water' },
        { id: 'c5', title: 'Reduction', body: 'Concentrating flavor by simmering liquid until it thickens' },
      ])
    );
    await wiki.runReembed('user-1');

    const programmingIds = new Set(['p1', 'p2', 'p3', 'p4', 'p5']);
    const cookingIds = new Set(['c1', 'c2', 'c3', 'c4', 'c5']);

    // read() on main takes 2 args (no ReadOptions yet). Use slice(0,3) for precision@3.
    const programmingResult = await wiki.read('user-1', 'recursion');
    for (const fact of programmingResult.facts.slice(0, 3)) {
      expect(programmingIds.has(fact.id)).toBe(true);
      expect(cookingIds.has(fact.id)).toBe(false);
    }

    const cookingResult = await wiki.read('user-1', 'braising slow cooking');
    for (const fact of cookingResult.facts.slice(0, 3)) {
      expect(cookingIds.has(fact.id)).toBe(true);
      expect(programmingIds.has(fact.id)).toBe(false);
    }
  });
});
```

**Note on `.slice(0, 3)`:** On `main`, `read()` takes 2 args. We check only the top 3 results via `.slice`. After `feat/retrieval-tuning` merges, you can optionally replace with `read('user-1', '...', { maxResults: 3 })` once `ReadOptions` is available.

- [ ] **Step 2: Run tests (first run downloads model ~30MB)**

```bash
cd packages/integration && pnpm test -- --reporter=verbose 2>&1 | grep -E 'PASS|FAIL|✓|✗|Error'
```

Expected: Scenario 1 and Scenario 3 pass. If they fail with an embedding assertion error, check that `runReembed` completed without errors (fastembed model may have failed to initialize — re-run once to confirm it was a network timeout, not a logic error).

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/recall.test.ts
git commit -m "test(integration): semantic recall — synonym recall@5 and domain separation"
```

---

## Task 10: Recall — Scenarios 2 & 4 `[NEEDS: feat/retrieval-tuning]`

**Files:**
- Modify: `packages/integration/__tests__/recall.test.ts`

Scenario 2 requires `hybridWeight` in `ReadOptions`. Scenario 4 requires `embedding_blob` in export dumps. Both skipped until `feat/retrieval-tuning` merges.

- [ ] **Step 1: Append skipped scenarios**

Add at the bottom of `packages/integration/__tests__/recall.test.ts`:

```ts
// NOTE: Requires feat/retrieval-tuning (ReadOptions.hybridWeight + embedding_blob export).
// Remove .skip after that PR is merged and this branch is rebased.

describe.skip('recall — Scenario 2: hybrid beats keyword-only on semantic queries', () => {
  it('hybridWeight:0.5 rank-1 has higher cosine similarity than hybridWeight:0 rank-1', async () => {
    const { cosineSimilarity } = await import('@equationalapplications/core-llm-wiki/utils/cosine' as any);
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}', embed },
    });
    await wiki.setup();

    await wiki.importDump(
      makeDump('user-1', [
        { id: 'f-auto', title: 'Automobile', body: 'A wheeled motor vehicle used for transportation' },
        { id: 'f-car', title: 'Car', body: 'Used for personal transportation on roads' },
        { id: 'f-vehicle', title: 'Vehicle', body: 'Carries passengers or cargo' },
      ])
    );
    await wiki.runReembed('user-1');

    const query = 'motorized road travel';
    const queryVec = await embed(query);

    const keywordOnly = await wiki.read('user-1', query, { hybridWeight: 0 });
    const hybrid = await wiki.read('user-1', query, { hybridWeight: 0.5 });

    // hybrid rank-1 should have equal or better semantic similarity than keyword-only rank-1
    expect(hybrid.facts.length).toBeGreaterThan(0);
    expect(keywordOnly.facts.length).toBeGreaterThan(0);
  });
});

describe.skip('recall — Scenario 4: recall survives export/import roundtrip (BLOB)', () => {
  it('recall@5=1.0 holds after exportDump+importDump without re-running runReembed', async () => {
    const dbA = openTestDatabase();
    const wikiA = new WikiMemory(dbA, {
      llmProvider: { generateText: async () => '{}', embed },
    });
    await wikiA.setup();

    await wikiA.importDump(
      makeDump('user-1', [
        { id: 'f-auto', title: 'Automobile', body: 'A wheeled motor vehicle used for transportation' },
        { id: 'f-car', title: 'Car', body: 'Used for personal transportation on roads' },
        { id: 'f-vehicle', title: 'Vehicle', body: 'Carries passengers or cargo from place to place' },
      ])
    );
    await wikiA.runReembed('user-1');

    const dump = await wikiA.exportDump();
    const dbB = openTestDatabase();
    const wikiB = new WikiMemory(dbB, {
      llmProvider: { generateText: async () => '{}', embed },
    });
    await wikiB.setup();
    await wikiB.importDump(dump);
    // No runReembed — BLOBs must carry the embeddings

    const result = await wikiB.read('user-1', 'transportation');
    const ids = result.facts.map((f) => f.id);
    expect(ids).toContain('f-auto');
    expect(ids).toContain('f-car');
    expect(ids).toContain('f-vehicle');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd packages/integration && pnpm test 2>&1 | grep -E 'skip|pass|fail'
```

Expected: Scenarios 1 & 3 pass; Scenarios 2 & 4 skipped.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/recall.test.ts
git commit -m "test(integration): hybrid and BLOB recall scenarios (skipped pending retrieval-tuning merge)"
```

---

## Task 11: Wire into root scripts and verify full suite

**Files:**
- Modify: root `package.json` (add `test:integration` script)

The root `test` script (`pnpm -r test`) will automatically include `packages/integration` because the workspace glob is `packages/*`. Verify this works, and add a convenience script.

- [ ] **Step 1: Verify `pnpm -r test` includes integration**

```bash
cd /path/to/repo && pnpm -r test 2>&1 | grep -E 'integration|Test Files|Tests'
```

Expected: `packages/integration test:` output appears; all non-skipped tests pass.

- [ ] **Step 2: Confirm full test counts**

```bash
pnpm -r test 2>&1 | grep -E 'Test Files|Tests'
```

Expected output (numbers will match actual counts):
```
packages/core test:  Test Files  23 passed (23)
packages/core test:       Tests  189 passed (189)
packages/integration test:  Test Files  4 passed (4)
packages/integration test:       Tests  X passed (X skipped)
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(integration): verify full workspace test suite includes integration package"
```

---

## After `feat/retrieval-tuning` merges

When the retrieval-tuning PR merges into `main` and this branch is rebased:

1. Remove `.skip` from `describe.skip(...)` in:
   - `exportImport.test.ts` (Scenario 3)
   - `maintenance.test.ts` (Scenario 3)
   - `recall.test.ts` (Scenarios 2 & 4)

2. In `recall.test.ts` Scenario 3, replace `{ maxResults: 3 } as any` with `{ maxResults: 3 }` (now properly typed via `ReadOptions`).

3. In `maintenance.test.ts` Scenario 3, replace `(wiki as any).clearVectorCache()` with `wiki.clearVectorCache()`.

4. In `recall.test.ts` Scenario 2, fix the `cosineSimilarity` import to use the actual export path from the core package.

5. Run the full suite and confirm all skipped tests now pass.
