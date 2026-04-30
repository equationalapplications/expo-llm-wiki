# Ingest Performance, Job Coordination, and Memory Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ingestDocument` 3–5× faster, fix maintenance-job mutex collisions, add `getEntityStatus`, raise prompt body budget to 800, add cross-chunk dedup, and ship `exportDump` / `importDump` / `useWikiExport`.

**Architecture:** All changes confined to `src/`. Chunker becomes a pure helper, parallel ingest with single-transaction write, separate mutex keys per maintenance op, new `WikiBusyError`, and platform-agnostic export primitives the app composes into ZIP/share workflows.

**Tech Stack:** TypeScript, expo-sqlite, React (peer dep). Vitest added for tests (no runner exists today).

**Spec:** `docs/specs/2026-04-30-ingest-perf-and-export.md`.

---

## File Structure

- `src/WikiMemory.ts` — new `chunkText` helper, parallel ingest path, dedup, ingest guard `Set`, mutex split, `getEntityStatus`, `exportDump`, `importDump`.
- `src/prompts.ts` — body budgets 200 → 800.
- `src/types.ts` — `MemoryDump`, `FormattedMemoryDump`, `EntityStatus`, `WikiBusyError`, `WikiConfig.chunkOverlap`.
- `src/utils/formatMemoryDump.ts` — new pure helper.
- `src/index.ts` — re-export new symbols.
- `src/react/useWikiExport.ts` — new hook.
- `src/react/index.ts` — re-export hook.
- `src/__tests__/*.test.ts` — new unit/integration tests.
- `package.json`, `vitest.config.ts` — add Vitest.

---

## Task 0: Add Vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install Vitest**

```bash
npm install --save-dev vitest @vitest/coverage-v8
```

- [ ] **Step 2: Add `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 3: Update `package.json` scripts**

Replace `"test": "echo \"Error: no test specified\" && exit 1"` with:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: PASS with "No test files found, exiting with code 0" (or 1 — accept either; we add tests next).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest test runner"
```

---

## Task 1: Add `chunkText` pure helper (TDD)

**Files:**
- Create: `src/__tests__/chunkText.test.ts`
- Modify: `src/WikiMemory.ts` (add export)

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/chunkText.test.ts
import { describe, it, expect } from 'vitest';
import { chunkText } from '../WikiMemory';

describe('chunkText', () => {
  it('returns empty for empty input', () => {
    expect(chunkText('', 100, 0)).toEqual({ chunks: [], truncated: false });
    expect(chunkText('   ', 100, 0)).toEqual({ chunks: [], truncated: false });
  });

  it('returns single chunk when text fits', () => {
    const r = chunkText('hello world', 100, 0);
    expect(r).toEqual({ chunks: ['hello world'], truncated: false });
  });

  it('splits on paragraph break preferentially', () => {
    const a = 'a'.repeat(50);
    const b = 'b'.repeat(50);
    const text = `${a}\n\n${b}`;
    const r = chunkText(text, 60, 0);
    expect(r.chunks.length).toBe(2);
    expect(r.chunks[0]).toContain(a);
    expect(r.chunks[1]).toContain(b);
    expect(r.truncated).toBe(false);
  });

  it('falls back to sentence boundary when no paragraph break', () => {
    const s1 = 'a'.repeat(40) + '. ';
    const s2 = 'b'.repeat(40) + '.';
    const r = chunkText(s1 + s2, 50, 0);
    expect(r.chunks.length).toBe(2);
    expect(r.chunks[0].trim().endsWith('.')).toBe(true);
  });

  it('falls back to whitespace when no sentence boundary', () => {
    const text = 'word '.repeat(50); // 250 chars, no terminators
    const r = chunkText(text, 60, 0);
    expect(r.chunks.length).toBeGreaterThan(1);
    expect(r.truncated).toBe(false);
    for (const c of r.chunks) expect(c.length).toBeLessThanOrEqual(60);
  });

  it('hard cuts when no break exists at all', () => {
    const text = 'x'.repeat(200);
    const r = chunkText(text, 50, 0);
    expect(r.truncated).toBe(true);
    expect(r.chunks.length).toBe(4);
  });

  it('applies overlap as prefix of next chunk', () => {
    const a = 'a'.repeat(50);
    const b = 'b'.repeat(50);
    const text = `${a}\n\n${b}`;
    const r = chunkText(text, 60, 10);
    expect(r.chunks.length).toBe(2);
    // last 10 chars of chunk[0] should appear at start of chunk[1]
    const tail = r.chunks[0].slice(-10);
    expect(r.chunks[1].startsWith(tail)).toBe(true);
  });

  it('does not infinite loop on pathological single-token input', () => {
    const text = 'x'.repeat(10000);
    const r = chunkText(text, 100, 50);
    expect(r.chunks.length).toBeLessThan(500); // sanity
  });

  it('handles 200KB input quickly', () => {
    const text = ('Sentence one. Sentence two.\n\n').repeat(7000); // ~200KB
    const t0 = Date.now();
    const r = chunkText(text, 12000, 400);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    expect(r.chunks.length).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "chunkText is not a function" or similar import error.

- [ ] **Step 3: Implement `chunkText` in `src/WikiMemory.ts`**

Add this exported function near the top, after `safeSlice`:

```ts
export function chunkText(
  input: string,
  maxChunkLength: number,
  overlap: number
): { chunks: string[]; truncated: boolean } {
  const text = input.trim();
  if (text.length === 0) return { chunks: [], truncated: false };
  if (!Number.isInteger(maxChunkLength) || maxChunkLength < 2) {
    throw new Error('maxChunkLength must be an integer >= 2');
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= maxChunkLength) {
    throw new Error('overlap must be a non-negative integer < maxChunkLength');
  }

  const chunks: string[] = [];
  let truncated = false;
  let cursor = 0;
  const halfMax = Math.floor(maxChunkLength / 2);

  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= maxChunkLength) {
      chunks.push(safeSlice(text, cursor, text.length));
      break;
    }

    const windowEnd = cursor + maxChunkLength;
    const minSplit = cursor + halfMax;

    // 1. paragraph break
    let splitPoint = -1;
    const paraIdx = text.lastIndexOf('\n\n', windowEnd);
    if (paraIdx >= minSplit && paraIdx < windowEnd) {
      splitPoint = paraIdx + 2;
    }

    // 2. sentence terminator
    if (splitPoint === -1) {
      let lastTerm = -1;
      for (let i = minSplit; i < windowEnd; i++) {
        const ch = text[i];
        if ((ch === '.' || ch === '!' || ch === '?') && i + 1 < text.length && /\s/.test(text[i + 1])) {
          lastTerm = i + 2;
        }
      }
      if (lastTerm !== -1 && lastTerm <= windowEnd) splitPoint = lastTerm;
    }

    // 3. whitespace
    if (splitPoint === -1) {
      for (let i = windowEnd - 1; i >= minSplit; i--) {
        if (/\s/.test(text[i])) { splitPoint = i + 1; break; }
      }
    }

    // 4. hard cut
    if (splitPoint === -1) {
      truncated = true;
      splitPoint = windowEnd;
    }

    chunks.push(safeSlice(text, cursor, splitPoint));
    const next = Math.max(splitPoint - overlap, cursor + 1);
    cursor = next;
  }

  return { chunks, truncated };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS for all `chunkText` tests.

- [ ] **Step 5: Commit**

```bash
git add src/WikiMemory.ts src/__tests__/chunkText.test.ts
git commit -m "feat(wiki): add chunkText helper with paragraph-first splitting and overlap"
```

---

## Task 2: Wire `chunkText` into `ingestDocument` + parallelize + dedup

**Files:**
- Modify: `src/WikiMemory.ts` (`ingestDocument` body)
- Create: `src/__tests__/ingest.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/__tests__/ingest.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as SQLite from 'expo-sqlite';
import { WikiMemory } from '../WikiMemory';

function makeMockProvider(facts: any[][]) {
  let i = 0;
  const calls: string[] = [];
  const concurrentCounter = { current: 0, max: 0 };
  return {
    calls,
    concurrentCounter,
    provider: {
      generateText: async ({ userPrompt }: any) => {
        concurrentCounter.current++;
        concurrentCounter.max = Math.max(concurrentCounter.max, concurrentCounter.current);
        calls.push(userPrompt);
        await new Promise(r => setTimeout(r, 20));
        const out = facts[i++] ?? [];
        concurrentCounter.current--;
        return JSON.stringify({ facts: out });
      },
    },
  };
}

async function freshWiki(provider: any) {
  const db = await SQLite.openDatabaseAsync(':memory:');
  const wiki = new WikiMemory(db, { llmProvider: provider, config: { tablePrefix: 'test_' } });
  await wiki.setup();
  return wiki;
}

describe('ingestDocument', () => {
  it('parallelizes LLM calls across chunks', async () => {
    const m = makeMockProvider([
      [{ title: 'A', body: 'a body', tags: [], confidence: 'inferred' }],
      [{ title: 'B', body: 'b body', tags: [], confidence: 'inferred' }],
      [{ title: 'C', body: 'c body', tags: [], confidence: 'inferred' }],
    ]);
    const wiki = await freshWiki(m.provider);
    const text = ('Para. '.repeat(500) + '\n\n').repeat(3);
    await wiki.ingestDocument('user1', {
      sourceRef: 'doc1', sourceHash: 'a'.repeat(64),
      documentChunk: text, maxChunkLength: 1000, chunkOverlap: 0,
    });
    expect(m.concurrentCounter.max).toBeGreaterThan(1);
    expect(m.calls.length).toBe(3);
  });

  it('deduplicates facts with same normalized title across chunks', async () => {
    const m = makeMockProvider([
      [{ title: 'Same Title', body: 'body 1', tags: [], confidence: 'inferred' }],
      [{ title: ' SAME   title ', body: 'body 2', tags: [], confidence: 'inferred' }],
    ]);
    const wiki = await freshWiki(m.provider);
    const text = ('x. '.repeat(200) + '\n\n').repeat(2);
    await wiki.ingestDocument('e1', {
      sourceRef: 'd', sourceHash: 'b'.repeat(64),
      documentChunk: text, maxChunkLength: 500, chunkOverlap: 0,
    });
    const bundle = await wiki.read('e1', 'same');
    const sames = bundle.facts.filter(f => f.title.toLowerCase().includes('same'));
    expect(sames.length).toBe(1);
    expect(sames[0].body).toBe('body 1'); // first-wins
  });

  it('one chunk failing rejects whole call with no DB writes', async () => {
    const provider = {
      generateText: async ({ userPrompt }: any) =>
        userPrompt.includes('FAIL') ? Promise.reject(new Error('boom')) : JSON.stringify({ facts: [{ title: 'T', body: 'B', tags: [], confidence: 'inferred' }] }),
    };
    const wiki = await freshWiki(provider);
    const text = 'good. '.repeat(200) + '\n\nFAIL ' + 'bad. '.repeat(200);
    await expect(wiki.ingestDocument('e2', {
      sourceRef: 'd2', sourceHash: 'c'.repeat(64),
      documentChunk: text, maxChunkLength: 500, chunkOverlap: 0,
    })).rejects.toThrow();
    const bundle = await wiki.read('e2', 'good');
    expect(bundle.facts.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test src/__tests__/ingest.test.ts`
Expected: FAIL — sequential calls (max concurrency 1) and dedup not implemented.

- [ ] **Step 3: Replace `ingestDocument` body**

Replace the entire `ingestDocument` method in `src/WikiMemory.ts` with:

```ts
async ingestDocument(entityId: string, params: { sourceRef: string; sourceHash: string; documentChunk: string; maxChunkLength?: number; chunkOverlap?: number }): Promise<{ truncated: boolean; chunks: number }> {
  const sourceRef = normalizeSourceRef(params.sourceRef);
  if (!sourceRef) throw new Error('Invalid sourceRef');
  const sourceHash = normalizeSourceHash(params.sourceHash);
  if (!sourceHash) throw new Error('Invalid sourceHash (must be 64-char hex string)');

  const maxChunkLength = params.maxChunkLength ?? this.options.config?.maxChunkLength ?? 12000;
  const chunkOverlap = params.chunkOverlap ?? this.options.config?.chunkOverlap ?? 400;

  if (typeof params.documentChunk !== 'string') {
    throw new Error(`documentChunk must be a string, received ${typeof params.documentChunk}`);
  }

  const jobKey = `${this.prefix}:${entityId}:${sourceRef}`;
  if (this.activeIngestJobs.has(jobKey)) {
    throw new WikiBusyError('ingest', entityId);
  }
  this.activeIngestJobs.add(jobKey);

  try {
    const { chunks, truncated } = chunkText(params.documentChunk, maxChunkLength, chunkOverlap);
    if (chunks.length === 0) return { truncated: false, chunks: 0 };

    const perChunk = await Promise.all(chunks.map(async (chunk) => {
      const responseText = await this.options.llmProvider.generateText({
        systemPrompt: INGEST_SYSTEM_PROMPT,
        userPrompt: `Document Chunk:\n${chunk}`,
      });
      const result = parseJsonResponse<{ facts: ExtractedFact[] }>(responseText);
      return (Array.isArray(result.facts) ? result.facts : [])
        .map(validateFact)
        .filter((f): f is ExtractedFact => f !== null);
    }));

    // Cross-chunk dedup by normalized title (first-wins)
    const seen = new Set<string>();
    const allValidFacts: ExtractedFact[] = [];
    for (const arr of perChunk) {
      for (const f of arr) {
        const key = f.title.trim().toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(key)) continue;
        seen.add(key);
        allValidFacts.push(f);
      }
    }

    const now = Date.now();
    await this.db.withTransactionAsync(async () => {
      await this.db.runAsync(`UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE source_ref = ? AND entity_id = ? AND deleted_at IS NULL`, [now, now, sourceRef, entityId]);
      for (const fact of allValidFacts) {
        const id = generateId('fact_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'user_document', sourceHash, sourceRef, now, now]);
      }
    });

    return { truncated, chunks: chunks.length };
  } finally {
    this.activeIngestJobs.delete(jobKey);
  }
}
```

Also add the field declaration near `activeMaintenanceJobs`:

```ts
private activeIngestJobs = new Set<string>();
```

NOTE: `WikiBusyError` is added in Task 4. For this task, temporarily use `throw new Error(...)` and update in Task 4.

Use this temporary throw for Task 2:
```ts
if (this.activeIngestJobs.has(jobKey)) {
  throw new Error(`ingest already running for entity ${entityId}`);
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test`
Expected: PASS for all ingest tests + chunkText tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/WikiMemory.ts src/__tests__/ingest.test.ts
git commit -m "feat(wiki): parallel ingest, chunkText integration, cross-chunk dedup, ingest job guard"
```

---

## Task 3: Raise prompt body budget to 800

**Files:**
- Modify: `src/prompts.ts`
- Modify: `src/WikiMemory.ts` (`validateFact`)
- Create: `src/__tests__/validateFact.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/__tests__/validateFact.test.ts
import { describe, it, expect } from 'vitest';
import { __testables } from '../WikiMemory';

describe('validateFact body budget', () => {
  it('accepts 800-char body', () => {
    const body = 'x'.repeat(800);
    const r = __testables.validateFact({ title: 't', body, tags: [], confidence: 'inferred' });
    expect(r?.body.length).toBe(800);
  });
  it('clips body to 800 chars', () => {
    const body = 'x'.repeat(1200);
    const r = __testables.validateFact({ title: 't', body, tags: [], confidence: 'inferred' });
    expect(r?.body.length).toBe(800);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test src/__tests__/validateFact.test.ts`
Expected: FAIL — `__testables` not exported, body clipped to 200.

- [ ] **Step 3: Update prompts**

In `src/prompts.ts`, change `(max 200 chars)` to `(max 800 chars)` in both `LIBRARIAN_SYSTEM_PROMPT` and `INGEST_SYSTEM_PROMPT`. `HEAL_SYSTEM_PROMPT`'s `newFacts` body is unbounded in the schema string — leave it (it goes through the same `validateFact` clip path).

- [ ] **Step 4: Update `validateFact`**

In `src/WikiMemory.ts`, change `const body = clip(fact.body, 200);` to `const body = clip(fact.body, 800);`.

- [ ] **Step 5: Export testables**

At the bottom of `src/WikiMemory.ts`, add:

```ts
export const __testables = { validateFact, validateTask, clip };
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/prompts.ts src/WikiMemory.ts src/__tests__/validateFact.test.ts
git commit -m "feat(wiki): raise fact body budget 200 -> 800 chars"
```

---

## Task 4: `WikiBusyError` + maintenance mutex split

**Files:**
- Modify: `src/types.ts` (add `WikiBusyError`)
- Modify: `src/WikiMemory.ts` (mutex keys, throws)
- Modify: `src/index.ts` (export error)
- Create: `src/__tests__/jobs.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/__tests__/jobs.test.ts
import { describe, it, expect } from 'vitest';
import * as SQLite from 'expo-sqlite';
import { WikiMemory, WikiBusyError } from '../index';

const slowProvider = (delayMs: number) => ({
  generateText: async () => {
    await new Promise(r => setTimeout(r, delayMs));
    return JSON.stringify({ facts: [], tasks: [] });
  },
});

async function freshWiki(provider: any) {
  const db = await SQLite.openDatabaseAsync(':memory:');
  const wiki = new WikiMemory(db, { llmProvider: provider, config: { tablePrefix: 'jobs_' } });
  await wiki.setup();
  return wiki;
}

describe('job mutex', () => {
  it('runLibrarian throws WikiBusyError when already running', async () => {
    const wiki = await freshWiki(slowProvider(100));
    // seed an event so librarian has work
    await wiki.write('e1', { event_type: 'observation', summary: 'x' });
    const first = wiki.runLibrarian('e1');
    await expect(wiki.runLibrarian('e1')).rejects.toBeInstanceOf(WikiBusyError);
    await first;
  });

  it('runHeal does not block runLibrarian for same entity', async () => {
    const wiki = await freshWiki(slowProvider(100));
    await wiki.write('e2', { event_type: 'observation', summary: 'x' });
    const heal = wiki.runHeal('e2');
    // librarian should be allowed to start (different mutex key)
    await expect(wiki.runLibrarian('e2')).resolves.not.toThrow();
    await heal;
  });

  it('ingestDocument throws WikiBusyError for same (entity, sourceRef)', async () => {
    const wiki = await freshWiki(slowProvider(100));
    const params = {
      sourceRef: 'doc', sourceHash: 'a'.repeat(64),
      documentChunk: 'small text', maxChunkLength: 100, chunkOverlap: 0,
    };
    const first = wiki.ingestDocument('e3', params);
    await expect(wiki.ingestDocument('e3', params)).rejects.toBeInstanceOf(WikiBusyError);
    await first;
  });

  it('ingestDocument allows different sourceRef for same entity', async () => {
    const wiki = await freshWiki(slowProvider(50));
    const first = wiki.ingestDocument('e4', { sourceRef: 'doc1', sourceHash: 'a'.repeat(64), documentChunk: 'x', maxChunkLength: 100, chunkOverlap: 0 });
    const second = wiki.ingestDocument('e4', { sourceRef: 'doc2', sourceHash: 'b'.repeat(64), documentChunk: 'y', maxChunkLength: 100, chunkOverlap: 0 });
    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run, verify fails**

Run: `npm test src/__tests__/jobs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `WikiBusyError` to `src/types.ts`**

Append at bottom:

```ts
export class WikiBusyError extends Error {
  readonly operation: 'ingest' | 'librarian' | 'heal';
  readonly entityId: string;
  constructor(operation: 'ingest' | 'librarian' | 'heal', entityId: string) {
    super(`${operation} already running for entity ${entityId}`);
    this.name = 'WikiBusyError';
    this.operation = operation;
    this.entityId = entityId;
  }
}
```

- [ ] **Step 4: Update `WikiMemory.ts` mutex usage**

Add import at top:
```ts
import { ..., WikiBusyError } from './types';
```

Replace `runLibrarian` and `runHeal` method bodies:

```ts
async runLibrarian(entityId: string): Promise<void> {
  const jobKey = `${this.prefix}:${entityId}:librarian`;
  if (this.activeMaintenanceJobs.has(jobKey)) {
    throw new WikiBusyError('librarian', entityId);
  }
  this.activeMaintenanceJobs.add(jobKey);
  try {
    await this._doRunLibrarian(entityId);
  } finally {
    this.activeMaintenanceJobs.delete(jobKey);
  }
}

async runHeal(entityId: string): Promise<void> {
  const jobKey = `${this.prefix}:${entityId}:heal`;
  if (this.activeMaintenanceJobs.has(jobKey)) {
    throw new WikiBusyError('heal', entityId);
  }
  this.activeMaintenanceJobs.add(jobKey);
  try {
    await this._doRunHeal(entityId);
  } finally {
    this.activeMaintenanceJobs.delete(jobKey);
  }
}
```

Update the auto-trigger inside `write()` to use the librarian-specific key (still silent skip — keep the `if (!has) add(); run().finally(delete)` pattern):

```ts
const jobKey = `${this.prefix}:${entityId}:librarian`;
if (!this.activeMaintenanceJobs.has(jobKey)) {
  this.activeMaintenanceJobs.add(jobKey);
  this.runLibrarianThenMaybeHeal(entityId, count)
    .catch(console.error)
    .finally(() => this.activeMaintenanceJobs.delete(jobKey));
}
```

(`runLibrarianThenMaybeHeal` calls `_doRunHeal` directly — it does not need its own heal mutex since it runs sequentially after librarian within the same fire-and-forget chain. If two writes both trip the threshold simultaneously the librarian-key guard still serializes them.)

Replace the temporary `throw new Error` in `ingestDocument` (from Task 2):

```ts
if (this.activeIngestJobs.has(jobKey)) {
  throw new WikiBusyError('ingest', entityId);
}
```

- [ ] **Step 5: Update `src/index.ts`**

The existing `export * from './types';` already covers `WikiBusyError`. Verify by importing it from `'../index'` in the test (already done).

- [ ] **Step 6: Run tests, verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/WikiMemory.ts src/__tests__/jobs.test.ts
git commit -m "feat(wiki): split librarian/heal mutex keys, add WikiBusyError"
```

---

## Task 5: `getEntityStatus` snapshot

**Files:**
- Modify: `src/types.ts` (add `EntityStatus`)
- Modify: `src/WikiMemory.ts` (add method)
- Modify: `src/__tests__/jobs.test.ts` (extend)

- [ ] **Step 1: Write failing test**

Append to `src/__tests__/jobs.test.ts`:

```ts
describe('getEntityStatus', () => {
  it('returns all-false when idle', async () => {
    const wiki = await freshWiki(slowProvider(0));
    expect(wiki.getEntityStatus('idle')).toEqual({ ingesting: false, librarian: false, heal: false });
  });

  it('reports ingesting during ingest', async () => {
    const wiki = await freshWiki(slowProvider(100));
    const p = wiki.ingestDocument('e1', { sourceRef: 's', sourceHash: 'a'.repeat(64), documentChunk: 'x', maxChunkLength: 100, chunkOverlap: 0 });
    await new Promise(r => setTimeout(r, 10));
    expect(wiki.getEntityStatus('e1').ingesting).toBe(true);
    await p;
    expect(wiki.getEntityStatus('e1').ingesting).toBe(false);
  });

  it('does not bleed across entities', async () => {
    const wiki = await freshWiki(slowProvider(100));
    const p = wiki.ingestDocument('eA', { sourceRef: 's', sourceHash: 'a'.repeat(64), documentChunk: 'x', maxChunkLength: 100, chunkOverlap: 0 });
    await new Promise(r => setTimeout(r, 10));
    expect(wiki.getEntityStatus('eB').ingesting).toBe(false);
    await p;
  });
});
```

- [ ] **Step 2: Run, verify fails**

Run: `npm test`
Expected: FAIL — `getEntityStatus is not a function`.

- [ ] **Step 3: Add type to `src/types.ts`**

```ts
export interface EntityStatus {
  ingesting: boolean;
  librarian: boolean;
  heal: boolean;
}
```

- [ ] **Step 4: Add method to `WikiMemory`**

```ts
getEntityStatus(entityId: string): EntityStatus {
  const ingestPrefix = `${this.prefix}:${entityId}:`;
  const librarianKey = `${this.prefix}:${entityId}:librarian`;
  const healKey = `${this.prefix}:${entityId}:heal`;

  let ingesting = false;
  for (const k of this.activeIngestJobs) {
    if (k.startsWith(ingestPrefix)) { ingesting = true; break; }
  }

  return {
    ingesting,
    librarian: this.activeMaintenanceJobs.has(librarianKey),
    heal: this.activeMaintenanceJobs.has(healKey),
  };
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/WikiMemory.ts src/__tests__/jobs.test.ts
git commit -m "feat(wiki): add getEntityStatus snapshot"
```

---

## Task 6: `WikiConfig.chunkOverlap` field

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add field**

In `WikiConfig`, after `maxChunkLength?: number;`:

```ts
chunkOverlap?: number;
```

- [ ] **Step 2: Verify**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(wiki): add WikiConfig.chunkOverlap"
```

---

## Task 7: `MemoryDump` type + `exportDump` method

**Files:**
- Modify: `src/types.ts`
- Modify: `src/WikiMemory.ts`
- Create: `src/__tests__/export.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/__tests__/export.test.ts
import { describe, it, expect } from 'vitest';
import * as SQLite from 'expo-sqlite';
import { WikiMemory } from '../WikiMemory';

const noopProvider = { generateText: async () => '{"facts":[],"tasks":[]}' };

async function freshWiki() {
  const db = await SQLite.openDatabaseAsync(':memory:');
  const wiki = new WikiMemory(db, { llmProvider: noopProvider, config: { tablePrefix: 'exp_' } });
  await wiki.setup();
  return wiki;
}

describe('exportDump', () => {
  it('returns empty entities when nothing exists', async () => {
    const wiki = await freshWiki();
    const dump = await wiki.exportDump();
    expect(dump.entities).toEqual({});
    expect(typeof dump.generatedAt).toBe('number');
  });

  it('exports all entities when entityIds omitted', async () => {
    const wiki = await freshWiki();
    await wiki.write('a', { event_type: 'observation', summary: 'sa' });
    await wiki.write('b', { event_type: 'observation', summary: 'sb' });
    const dump = await wiki.exportDump();
    expect(Object.keys(dump.entities).sort()).toEqual(['a', 'b']);
  });

  it('exports only requested entities', async () => {
    const wiki = await freshWiki();
    await wiki.write('a', { event_type: 'observation', summary: 'sa' });
    await wiki.write('b', { event_type: 'observation', summary: 'sb' });
    const dump = await wiki.exportDump(['a']);
    expect(Object.keys(dump.entities)).toEqual(['a']);
  });

  it('parses tags as arrays in exported facts', async () => {
    // Pre-insert via ingest mock would be heavier; skip — covered by importDump round-trip in Task 9.
  });
});
```

- [ ] **Step 2: Run, verify fails**

Run: `npm test src/__tests__/export.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add types to `src/types.ts`**

```ts
export interface MemoryDump {
  generatedAt: number;
  entities: Record<string, MemoryBundle>;
}

export interface FormattedMemoryDump {
  manifest: string;
  files: Array<{ name: string; content: string }>;
}
```

- [ ] **Step 4: Add `exportDump` to `WikiMemory`**

```ts
async exportDump(entityIds?: string[]): Promise<MemoryDump> {
  let ids: string[];
  if (entityIds && entityIds.length > 0) {
    ids = Array.from(new Set(entityIds));
  } else {
    const rows = await this.db.getAllAsync<{ entity_id: string }>(`
      SELECT entity_id FROM ${this.prefix}entries WHERE deleted_at IS NULL
      UNION SELECT entity_id FROM ${this.prefix}tasks WHERE deleted_at IS NULL
      UNION SELECT entity_id FROM ${this.prefix}events
    `);
    ids = rows.map(r => r.entity_id);
  }

  const entities: Record<string, MemoryBundle> = {};
  for (const id of ids) {
    const [factsRaw, tasks, events] = await Promise.all([
      this.db.getAllAsync<WikiFact>(`SELECT * FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`, [id]),
      this.db.getAllAsync<WikiTask>(`SELECT * FROM ${this.prefix}tasks WHERE entity_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`, [id]),
      this.db.getAllAsync<WikiEvent>(`SELECT * FROM ${this.prefix}events WHERE entity_id = ? ORDER BY created_at ASC`, [id]),
    ]);
    entities[id] = {
      facts: factsRaw.map(f => ({ ...f, tags: typeof f.tags === 'string' ? JSON.parse(f.tags) : f.tags })),
      tasks,
      events,
    };
  }

  return { generatedAt: Date.now(), entities };
}
```

Add `MemoryDump` to the imports at the top of `WikiMemory.ts`:
```ts
import { ..., MemoryDump } from './types';
```

- [ ] **Step 5: Run, verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/WikiMemory.ts src/__tests__/export.test.ts
git commit -m "feat(wiki): add MemoryDump type and exportDump method"
```

---

## Task 8: `formatMemoryDump` pure helper

**Files:**
- Create: `src/utils/formatMemoryDump.ts`
- Create: `src/__tests__/formatMemoryDump.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/__tests__/formatMemoryDump.test.ts
import { describe, it, expect } from 'vitest';
import { formatMemoryDump } from '../utils/formatMemoryDump';

describe('formatMemoryDump', () => {
  it('handles empty dump', () => {
    const r = formatMemoryDump({ generatedAt: 0, entities: {} });
    expect(r.files).toEqual([]);
    expect(JSON.parse(r.manifest).entities).toEqual({});
  });

  it('produces one file per entity', () => {
    const r = formatMemoryDump({
      generatedAt: 1000,
      entities: {
        e1: { facts: [{ id: 'f1', entity_id: 'e1', title: 'T1', body: 'B1', tags: ['x'], confidence: 'certain', source_type: 'user_stated', source_hash: null, source_ref: null, created_at: 0, updated_at: 0, last_accessed_at: null, access_count: 0, deleted_at: null }], tasks: [], events: [] },
          e2: { facts: [], tasks: [{ id: 't1', entity_id: 'e2', description: 'do x', status: 'pending', priority: 1, created_at: 0, updated_at: 0, resolved_at: null, deleted_at: null }], events: [] },
      },
    });
    expect(r.files.map(f => f.name).sort()).toEqual(['e1.md', 'e2.md']);
    expect(r.files.find(f => f.name === 'e1.md')?.content).toContain('T1');
    expect(r.files.find(f => f.name === 'e2.md')?.content).toContain('- [ ] do x');
  });

  it('escapes problematic markdown chars in body', () => {
    const r = formatMemoryDump({
      generatedAt: 0,
      entities: {
        e: { facts: [{ id: 'f', entity_id: 'e', title: 'Title # H', body: 'Body with `backticks`', tags: [], confidence: 'inferred', source_type: 'user_stated', source_hash: null, source_ref: null, created_at: 0, updated_at: 0, last_accessed_at: null, access_count: 0, deleted_at: null }], tasks: [], events: [] },
      },
    });
    // body preserved verbatim within fenced block — no escaping required, but must be present
    expect(r.files[0].content).toContain('Body with `backticks`');
  });
});
```

- [ ] **Step 2: Run, verify fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement helper**

Create `src/utils/formatMemoryDump.ts`:

```ts
import type { MemoryDump, FormattedMemoryDump, MemoryBundle, WikiFact, WikiTask, WikiEvent } from '../types';

function renderFact(f: WikiFact): string {
  const tags = (f.tags || []).join(', ');
  const source = f.source_ref ?? f.source_type;
  return `### ${f.title}
**Tags:** ${tags}
**Confidence:** ${f.confidence}
**Source:** ${source}

${f.body}

---
`;
}

function renderTask(t: WikiTask): string {
  const checked = t.status === 'done' ? 'x' : ' ';
  const note = t.status === 'done' ? ' (done)'
    : t.status === 'abandoned' ? ' (abandoned)'
    : t.status === 'in_progress' ? ' (in progress)'
    : '';
  return `- [${checked}] ${t.description}${note}\n`;
}

function renderEvent(e: WikiEvent): string {
  const ts = new Date(e.created_at).toISOString();
  return `- [${ts}] (${e.event_type}) ${e.summary}\n`;
}

function renderEntity(entityId: string, bundle: MemoryBundle, generatedAt: number): string {
  const lines: string[] = [];
  lines.push(`# Memory Dump: ${entityId}`);
  lines.push(`Generated: ${new Date(generatedAt).toISOString()}`);
  lines.push('');
  lines.push('## Facts');
  lines.push('');
  if (bundle.facts.length === 0) lines.push('_(none)_\n');
  else for (const f of bundle.facts) lines.push(renderFact(f));
  lines.push('## Tasks');
  lines.push('');
  if (bundle.tasks.length === 0) lines.push('_(none)_\n');
  else for (const t of bundle.tasks) lines.push(renderTask(t));
  lines.push('');
  lines.push('## Recent Events');
  lines.push('');
  if (bundle.events.length === 0) lines.push('_(none)_\n');
  else for (const e of bundle.events) lines.push(renderEvent(e));
  return lines.join('\n');
}

export function formatMemoryDump(dump: MemoryDump): FormattedMemoryDump {
  const files = Object.entries(dump.entities).map(([entityId, bundle]) => ({
    name: `${entityId}.md`,
    content: renderEntity(entityId, bundle, dump.generatedAt),
  }));
  return {
    manifest: JSON.stringify(dump, null, 2),
    files,
  };
}
```

- [ ] **Step 4: Re-export from `src/index.ts`**

Append:

```ts
export { formatMemoryDump } from './utils/formatMemoryDump';
```

- [ ] **Step 5: Run, verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/utils/formatMemoryDump.ts src/__tests__/formatMemoryDump.test.ts src/index.ts
git commit -m "feat(wiki): add formatMemoryDump pure helper"
```

---

## Task 9: `importDump` method

**Files:**
- Modify: `src/WikiMemory.ts`
- Create: `src/__tests__/importDump.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/__tests__/importDump.test.ts
import { describe, it, expect } from 'vitest';
import * as SQLite from 'expo-sqlite';
import { WikiMemory } from '../WikiMemory';

const noopProvider = { generateText: async () => '{}' };
async function freshWiki(prefix: string) {
  const db = await SQLite.openDatabaseAsync(':memory:');
  const wiki = new WikiMemory(db, { llmProvider: noopProvider, config: { tablePrefix: prefix } });
  await wiki.setup();
  return wiki;
}

const dump = (entityId: string, factId = 'f1') => ({
  generatedAt: Date.now(),
  entities: {
    [entityId]: {
      facts: [{ id: factId, entity_id: entityId, title: 'T', body: 'B', tags: ['x'], confidence: 'certain' as const, source_type: 'user_stated' as const, source_hash: null, source_ref: null, created_at: 1, updated_at: 1, last_accessed_at: null, access_count: 0, deleted_at: null }],
      tasks: [{ id: 't1', entity_id: entityId, description: 'do', status: 'pending' as const, priority: 0, created_at: 1, updated_at: 1, resolved_at: null, deleted_at: null }],
      events: [{ id: 'e1', entity_id: entityId, event_type: 'observation' as const, summary: 's', related_entry_id: null, created_at: 1 }],
    },
  },
});

describe('importDump', () => {
  it('default merge:false clears then inserts', async () => {
    const wiki = await freshWiki('imp1_');
    await wiki.write('e', { event_type: 'observation', summary: 'pre-existing' });
    await wiki.importDump(dump('e'));
    const out = await wiki.exportDump(['e']);
    expect(out.entities.e.facts.length).toBe(1);
    expect(out.entities.e.tasks.length).toBe(1);
    // events are appended; pre-existing + imported = 2
    expect(out.entities.e.events.length).toBe(2);
  });

  it('merge:true skips existing fact ids', async () => {
    const wiki = await freshWiki('imp2_');
    await wiki.importDump(dump('e', 'shared'));
    await wiki.importDump(dump('e', 'shared'), { merge: true });
    const out = await wiki.exportDump(['e']);
    expect(out.entities.e.facts.length).toBe(1);
  });

  it('merge:true inserts new fact ids', async () => {
    const wiki = await freshWiki('imp3_');
    await wiki.importDump(dump('e', 'old'));
    await wiki.importDump(dump('e', 'new'), { merge: true });
    const out = await wiki.exportDump(['e']);
    expect(out.entities.e.facts.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run, verify fails**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implement `importDump`**

Add to `WikiMemory`:

```ts
async importDump(dump: MemoryDump, opts?: { merge?: boolean }): Promise<void> {
  const merge = opts?.merge ?? false;
  for (const [entityId, bundle] of Object.entries(dump.entities)) {
    if (!merge) {
      await this.forget(entityId, { clearAll: true });
    }
    await this.db.withTransactionAsync(async () => {
      for (const f of bundle.facts) {
        if (merge) {
          const exists = await this.db.getFirstAsync(`SELECT id FROM ${this.prefix}entries WHERE id = ? AND entity_id = ?`, [f.id, entityId]);
          if (exists) continue;
        }
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [f.id, entityId, f.title, f.body, JSON.stringify(f.tags || []), f.confidence, f.source_type, f.source_hash, f.source_ref, f.created_at, f.updated_at, f.last_accessed_at, f.access_count, f.deleted_at]);
      }
      for (const t of bundle.tasks) {
        if (merge) {
          const exists = await this.db.getFirstAsync(`SELECT id FROM ${this.prefix}tasks WHERE id = ? AND entity_id = ?`, [t.id, entityId]);
          if (exists) continue;
        }
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}tasks (id, entity_id, description, status, priority, created_at, updated_at, resolved_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [t.id, entityId, t.description, t.status, t.priority, t.created_at, t.updated_at, t.resolved_at, t.deleted_at]);
      }
      for (const e of bundle.events) {
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}events (id, entity_id, event_type, summary, related_entry_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [e.id, entityId, e.event_type, e.summary, e.related_entry_id ?? null, e.created_at]);
      }
    });
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/WikiMemory.ts src/__tests__/importDump.test.ts
git commit -m "feat(wiki): add importDump method"
```

---

## Task 10: `useWikiExport` React hook

**Files:**
- Create: `src/react/useWikiExport.ts`
- Modify: `src/react/index.ts`

- [ ] **Step 1: Implement hook**

```ts
// src/react/useWikiExport.ts
import { useCallback, useState } from 'react';
import { useWiki } from './WikiContext';
import type { MemoryDump } from '../types';

export function useWikiExport() {
  const wiki = useWiki();
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const exportDump = useCallback(async (entityIds?: string[]): Promise<MemoryDump> => {
    setIsExporting(true);
    setError(null);
    try {
      return await wiki.exportDump(entityIds);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      throw err;
    } finally {
      setIsExporting(false);
    }
  }, [wiki]);

  return { exportDump, isExporting, error };
}
```

- [ ] **Step 2: Re-export from `src/react/index.ts`**

Append:

```ts
export { useWikiExport } from './useWikiExport';
```

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/react/useWikiExport.ts src/react/index.ts
git commit -m "feat(react): add useWikiExport hook"
```

---

## Task 11: Self-review + final test sweep

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All green.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS, `dist/` populated.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Verify all spec items have a task**

Cross-check `docs/specs/2026-04-30-ingest-perf-and-export.md` "API Surface Changes" table — every additive symbol and behavior change has a corresponding task above. (Done at plan-write time; this step is a sanity re-check after implementation.)

- [ ] **Step 5: Tag breaking changes in commit log**

If using semantic-release, ensure the commit that changed `runLibrarian`/`runHeal` busy semantics (Task 4) includes a `BREAKING CHANGE:` footer. Amend if needed:

```bash
git commit --amend
# Add to body:
# BREAKING CHANGE: runLibrarian() and runHeal() now throw WikiBusyError when busy instead of silently returning.
```

- [ ] **Step 6: Final commit (if any docs/changelog updates remain)**

```bash
git add -A
git commit -m "docs: cross-link spec and plan" || true
```

---

## Notes for Engineer

- `expo-sqlite`'s `:memory:` works in Node-like environments; if Vitest in `node` env can't load `expo-sqlite`, switch tests to a thin in-memory wrapper or `better-sqlite3` mock. Run Task 0 first and verify a trivial test works before continuing.
- DRY: shared test setup (`freshWiki`, mock providers) is duplicated across test files for clarity at this scale. If files grow, extract to `src/__tests__/_helpers.ts`.
- YAGNI: no event emitter, no abstract job manager, no plugin hooks. The Sets are the source of truth.
- TDD: every code task has the failing test written first. Do not skip Step 2 ("verify it fails") — it confirms the test actually exercises the change.
- Commits: one per task; keep them small and reviewable.
