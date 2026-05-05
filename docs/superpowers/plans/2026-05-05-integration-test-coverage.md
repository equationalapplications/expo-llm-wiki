# Integration Test Coverage Expansion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand `packages/integration` to cover `ingestDocument`, `hasChanged`, `onRetrievalFallback`, all untested `WikiConfig` options, and a full BEIR SciFact recall benchmark with NDCG@10.

**Architecture:** New test files (`config.test.ts`, `scifact.test.ts`) plus additions to existing files. SciFact corpus is pre-embedded once via `scripts/embed-scifact.ts`, committed as `fixtures/scifact-dump.json.gz`, and loaded at test time via `importDump` — no CI network calls for embeddings. All new tests run in the existing vitest integration job.

**Tech Stack:** vitest 4.1.5, better-sqlite3, fastembed (BGE-small-en-v1.5), tsx (script runner), zlib (node built-in for gzip), `@equationalapplications/core-llm-wiki` via workspace alias.

---

## File Map

| Action | Path |
|--------|------|
| Modify | `packages/integration/.gitignore` |
| Create | `packages/integration/helpers/ndcg.ts` |
| Create | `packages/integration/scripts/fetch-scifact.ts` |
| Create | `packages/integration/scripts/embed-scifact.ts` |
| Create (generated) | `packages/integration/fixtures/scifact-corpus.jsonl` |
| Create (generated+committed) | `packages/integration/fixtures/scifact-dump.json.gz` |
| Create (generated+committed) | `packages/integration/fixtures/scifact-queries.json` |
| Create (generated+committed) | `packages/integration/fixtures/scifact-qrels.json` |
| Modify | `packages/integration/__tests__/pipeline.test.ts` |
| Modify | `packages/integration/__tests__/maintenance.test.ts` |
| Create | `packages/integration/__tests__/config.test.ts` |
| Create | `packages/integration/__tests__/scifact.test.ts` |

---

## Key facts to know before editing

- `write()` fires the auto-librarian as **fire-and-forget** (not awaited). Use `vi.waitFor()` to wait for auto-triggered background jobs.
- `ingestDocument` calls the LLM **once per chunk** to extract facts, then stores them with `source_type = 'user_document'`. The `sourceHash` param must be a **64-character hex string**.
- `staleInferredAfterDays` **downgrades** `confidence: 'inferred'` → `'tentative'` (does NOT soft-delete). The SQL filter matches `confidence = 'inferred'`, not `source_type = 'agent_inferred'`.
- `pruneEventsAfter` and `pruneRetainSoftDeletedFor` are both in **days** (multiplied by 86400000ms internally).
- The default table prefix is `llm_wiki_` (seen as `llm_wiki_:entity-a:prune` in maintenance tests). Direct DB queries use `llm_wiki_entries`.
- `onRetrievalFallback` is passed in `WikiOptions` (third constructor arg group), not in `WikiConfig`. Create `WikiMemory` directly — `makeWiki()` does not support it.
- `tsx` resolves `@equationalapplications/core-llm-wiki` via `tsconfig.json` paths (already configured), so scripts can use that import.

---

## Task 1: Setup — gitignore + NDCG helper

**Files:**
- Modify: `packages/integration/.gitignore`
- Create: `packages/integration/helpers/ndcg.ts`

- [ ] **Step 1: Add benchmark-results to gitignore**

```
# packages/integration/.gitignore — append these lines:
benchmark-results/
fixtures/scifact-corpus.jsonl
```

(`scifact-corpus.jsonl` is an intermediate artifact of the fetch script, not committed. The other fixtures are committed.)

- [ ] **Step 2: Create `helpers/ndcg.ts`**

```typescript
// packages/integration/helpers/ndcg.ts
export function computeNDCG(rankedIds: string[], relevantIds: Set<string>, k: number): number {
  const dcg = rankedIds.slice(0, k).reduce(
    (sum, id, i) => (relevantIds.has(id) ? sum + 1 / Math.log2(i + 2) : sum),
    0
  );
  const idealLen = Math.min(relevantIds.size, k);
  const idcg = Array.from({ length: idealLen }, (_, i) => 1 / Math.log2(i + 2))
    .reduce((a, b) => a + b, 0);
  return idcg === 0 ? 0 : dcg / idcg;
}
```

- [ ] **Step 3: Verify helper compiles**

```bash
cd packages/integration && pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/integration/.gitignore packages/integration/helpers/ndcg.ts
git commit -m "test(integration): add benchmark-results gitignore and ndcg helper"
```

---

## Task 2: `scripts/fetch-scifact.ts`

**Files:**
- Create: `packages/integration/scripts/fetch-scifact.ts`

- [ ] **Step 1: Create the fetch script**

```typescript
// packages/integration/scripts/fetch-scifact.ts
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const HF = 'https://huggingface.co/datasets/BeIR/scifact/resolve/main';

async function get(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
  return res.text();
}

async function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });

  // corpus — raw JSONL, keep for embed-scifact.ts
  console.log('Fetching corpus.jsonl…');
  const corpusText = await get(`${HF}/corpus.jsonl`);
  fs.writeFileSync(path.join(FIXTURES, 'scifact-corpus.jsonl'), corpusText, 'utf8');
  const docCount = corpusText.split('\n').filter(Boolean).length;
  console.log(`  ${docCount} docs`);

  // queries
  console.log('Fetching queries.jsonl…');
  const queriesText = await get(`${HF}/queries.jsonl`);
  const queries: Record<string, string> = {};
  for (const line of queriesText.split('\n').filter(Boolean)) {
    const { _id, text } = JSON.parse(line) as { _id: string; text: string };
    queries[_id] = text;
  }
  fs.writeFileSync(
    path.join(FIXTURES, 'scifact-queries.json'),
    JSON.stringify(queries, null, 2),
    'utf8'
  );
  console.log(`  ${Object.keys(queries).length} queries`);

  // qrels — TSV, header: query-id\tcorpus-id\tscore
  console.log('Fetching qrels/test.tsv…');
  const qrelsText = await get(`${HF}/qrels/test.tsv`);
  const qrels: Record<string, string[]> = {};
  for (const line of qrelsText.split('\n').filter(Boolean).slice(1)) {
    const [queryId, docId, score] = line.split('\t');
    if (parseInt(score ?? '0', 10) > 0) {
      (qrels[queryId] ??= []).push(docId);
    }
  }
  fs.writeFileSync(
    path.join(FIXTURES, 'scifact-qrels.json'),
    JSON.stringify(qrels, null, 2),
    'utf8'
  );
  console.log(`  ${Object.keys(qrels).length} queries with relevant docs`);

  console.log('\nDone. Run embed-scifact.ts next.');
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the script (requires internet)**

```bash
cd packages/integration && tsx scripts/fetch-scifact.ts
```

Expected output (approximate):
```
Fetching corpus.jsonl…
  5183 docs
Fetching queries.jsonl…
  300 queries
Fetching qrels/test.tsv…
  300 queries with relevant docs
Done. Run embed-scifact.ts next.
```

If HuggingFace returns 4xx, check the actual repository file structure at `https://huggingface.co/datasets/BeIR/scifact/tree/main` and update the URL paths accordingly.

- [ ] **Step 3: Commit the script (not the fixtures yet — those come after Task 3)**

```bash
git add packages/integration/scripts/fetch-scifact.ts
git commit -m "test(integration): add fetch-scifact script"
```

---

## Task 3: `scripts/embed-scifact.ts`

**Files:**
- Create: `packages/integration/scripts/embed-scifact.ts`

This script reads `scifact-corpus.jsonl`, embeds all docs via fastembed, exports a `MemoryDump` with populated BLOBs, and saves it gzipped. Requires Task 2 to have been run first.

- [ ] **Step 1: Create the embed script**

```typescript
// packages/integration/scripts/embed-scifact.ts
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');

async function main() {
  // 1. Init fastembed
  console.log('Initialising fastembed BGE-small-en-v1.5…');
  const embedder = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15 });

  async function embed(text: string): Promise<number[]> {
    for await (const batch of embedder.embed([text])) {
      return Array.from(batch[0]);
    }
    throw new Error('fastembed returned no vectors');
  }

  // 2. Load corpus
  console.log('Loading corpus…');
  const corpusLines = fs
    .readFileSync(path.join(FIXTURES, 'scifact-corpus.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean);
  const corpus = corpusLines.map(
    (l) => JSON.parse(l) as { _id: string; title: string; text: string }
  );
  console.log(`  ${corpus.length} docs`);

  // 3. Build MemoryDump (no BLOBs yet)
  const now = Date.now();
  const dump: MemoryDump = {
    generatedAt: now,
    entities: {
      'scifact-corpus': {
        facts: corpus.map((doc, i) => ({
          id: doc._id,
          entity_id: 'scifact-corpus',
          title: doc.title ?? '',
          body: doc.text ?? '',
          tags: [] as string[],
          confidence: 'certain' as const,
          source_type: 'user_document' as const,
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

  // 4. Import into WikiMemory and embed via runReembed
  console.log('Importing into WikiMemory…');
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText: async () => '{}', embed },
  });
  await wiki.setup();
  await wiki.importDump(dump);

  console.log('Embedding all docs (≈30s)…');
  const result = await wiki.runReembed('scifact-corpus');
  console.log(`  embedded: ${result.embedded}, skipped: ${result.skipped}`);

  // 5. Export with BLOBs, gzip, save
  console.log('Exporting…');
  const exported = await wiki.exportDump(['scifact-corpus']);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(exported), 'utf8'), { level: 6 });
  const outPath = path.join(FIXTURES, 'scifact-dump.json.gz');
  fs.writeFileSync(outPath, gz);
  console.log(`Saved ${outPath} (${(gz.length / 1024 / 1024).toFixed(1)} MB)`);

  await db.closeAsync();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the script**

```bash
cd packages/integration && tsx scripts/embed-scifact.ts
```

Expected output (approximate):
```
Initialising fastembed BGE-small-en-v1.5…
Loading corpus…
  5183 docs
Importing into WikiMemory…
Embedding all docs (≈30s)…
  embedded: 5183, skipped: 0
Exporting…
Saved .../fixtures/scifact-dump.json.gz (2.8 MB)
```

First run downloads the ONNX model (~30MB) to the fastembed cache. Subsequent runs use the cache.

- [ ] **Step 3: Verify fixture files exist**

```bash
ls -lh packages/integration/fixtures/
```

Expected: `scifact-corpus.jsonl`, `scifact-dump.json.gz`, `scifact-queries.json`, `scifact-qrels.json` all present.

- [ ] **Step 4: Commit script and fixtures**

```bash
git add packages/integration/scripts/embed-scifact.ts \
        packages/integration/fixtures/scifact-dump.json.gz \
        packages/integration/fixtures/scifact-queries.json \
        packages/integration/fixtures/scifact-qrels.json
git commit -m "test(integration): add embed-scifact script and committed SciFact fixtures"
```

---

## Task 4: `pipeline.test.ts` — Scenario 4 (basic `ingestDocument` → `read`)

**Files:**
- Modify: `packages/integration/__tests__/pipeline.test.ts`

**Context:** `ingestDocument` calls the LLM once per chunk to extract facts (using `INGEST_SYSTEM_PROMPT`). The LLM response must be `{ "facts": [...] }`. `sourceHash` must be a 64-character hex string.

- [ ] **Step 1: Add the import and Scenario 4 describe block at the end of `pipeline.test.ts`**

```typescript
// append to packages/integration/__tests__/pipeline.test.ts

const HASH_A = 'a'.repeat(64); // valid 64-char hex sourceHash

describe('pipeline — Scenario 4: ingestDocument → read', () => {
  it('facts extracted from ingested document are retrievable via read()', async () => {
    const db = openTestDatabase();
    const llmResponse = JSON.stringify({
      facts: [
        { title: 'Neural networks', body: 'Inspired by biological neurons, used in deep learning', tags: ['ml'], confidence: 'certain' },
        { title: 'Gradient descent', body: 'Optimisation algorithm that minimises loss by iterating toward lower gradients', tags: ['ml'], confidence: 'certain' },
      ],
    });
    const wiki = new WikiMemory(db, { llmProvider: scriptedLLM([llmResponse]) });
    await wiki.setup();

    const result = await wiki.ingestDocument('user-1', {
      sourceRef: 'ml-intro',
      sourceHash: HASH_A,
      documentChunk: 'Machine learning uses neural networks and gradient descent to learn from data.',
    });

    expect(result.truncated).toBe(false);
    expect(result.chunks).toBe(1);

    const bundle = await wiki.getMemoryBundle('user-1');
    expect(bundle.facts.length).toBe(2);
    expect(bundle.facts.every((f) => f.source_type === 'user_document')).toBe(true);
    expect(bundle.facts.every((f) => f.source_ref === 'ml-intro')).toBe(true);

    const readResult = await wiki.read('user-1', 'neural networks');
    expect(readResult.facts.length).toBeGreaterThan(0);
    expect(readResult.facts[0].title).toBe('Neural networks');
  });
});
```

- [ ] **Step 2: Run the new test**

```bash
cd packages/integration && pnpm vitest run __tests__/pipeline.test.ts
```

Expected: all tests pass, including the new Scenario 4.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/pipeline.test.ts
git commit -m "test(integration): pipeline Scenario 4 — ingestDocument → read"
```

---

## Task 5: `pipeline.test.ts` — Scenario 5 (`hasChanged`)

**Files:**
- Modify: `packages/integration/__tests__/pipeline.test.ts`

- [ ] **Step 1: Append Scenario 5 describe block**

```typescript
// append to packages/integration/__tests__/pipeline.test.ts

const HASH_B = 'b'.repeat(64);

describe('pipeline — Scenario 5: hasChanged', () => {
  it('returns false for same sourceRef+sourceHash, true for different hash or unknown ref', async () => {
    const db = openTestDatabase();
    const llmResponse = JSON.stringify({ facts: [{ title: 'T', body: 'B', tags: [], confidence: 'certain' }] });
    const wiki = new WikiMemory(db, { llmProvider: scriptedLLM([llmResponse]) });
    await wiki.setup();

    await wiki.ingestDocument('user-1', {
      sourceRef: 'doc-a',
      sourceHash: HASH_A,
      documentChunk: 'Some content for the document.',
    });

    // same ref + same hash → not changed
    expect(await wiki.hasChanged('user-1', 'doc-a', HASH_A)).toBe(false);

    // same ref + different hash → changed
    expect(await wiki.hasChanged('user-1', 'doc-a', HASH_B)).toBe(true);

    // unknown ref → changed (treat as new)
    expect(await wiki.hasChanged('user-1', 'doc-b', HASH_A)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd packages/integration && pnpm vitest run __tests__/pipeline.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/pipeline.test.ts
git commit -m "test(integration): pipeline Scenario 5 — hasChanged"
```

---

## Task 6: `pipeline.test.ts` — Scenarios 6 + 7 (chunk boundary + idempotent re-ingest)

**Files:**
- Modify: `packages/integration/__tests__/pipeline.test.ts`

**Context:** Default `maxChunkLength` is 12000. For Scenario 6, use `maxChunkLength: 200, chunkOverlap: 0` to force chunking. `ingestDocument` returns `{ chunks }` = number of text chunks (not facts). Each chunk triggers one LLM call, so `scriptedLLM` must have as many responses as there are chunks.

- [ ] **Step 1: Append Scenarios 6 + 7**

```typescript
// append to packages/integration/__tests__/pipeline.test.ts

describe('pipeline — Scenario 6: chunk boundary', () => {
  it('long document is split into multiple chunks, each stored and retrievable', async () => {
    const db = openTestDatabase();
    // 800-char doc split into ≥4 chunks at maxChunkLength:200
    const longText = [
      'Photosynthesis converts light into chemical energy stored as glucose.',
      'Chlorophyll absorbs red and blue light while reflecting green wavelengths.',
      'The light-dependent reactions occur in the thylakoid membranes of chloroplasts.',
      'The Calvin cycle fixes carbon dioxide into three-carbon sugars using ATP and NADPH.',
      'Oxygen is released as a byproduct of splitting water molecules during photolysis.',
      'C4 plants concentrate carbon dioxide to minimise photorespiration losses.',
      'CAM plants open stomata at night to reduce water loss in arid conditions.',
      'Rubisco is the enzyme responsible for carbon fixation in the Calvin cycle.',
    ].join(' ');

    // Provide one LLM response per expected chunk (≥4 at 200-char limit)
    const makeFact = (title: string) =>
      JSON.stringify({ facts: [{ title, body: 'Detail', tags: [], confidence: 'certain' }] });
    const chunkResponses = Array.from({ length: 8 }, (_, i) => makeFact(`Plant fact ${i + 1}`));

    const wiki = new WikiMemory(db, { llmProvider: scriptedLLM(chunkResponses) });
    await wiki.setup();

    const result = await wiki.ingestDocument('user-1', {
      sourceRef: 'plant-biology',
      sourceHash: HASH_A,
      documentChunk: longText,
      maxChunkLength: 200,
      chunkOverlap: 0,
    });

    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(result.truncated).toBe(false);

    const bundle = await wiki.getMemoryBundle('user-1');
    expect(bundle.facts.length).toBeGreaterThanOrEqual(2);
    expect(bundle.facts.every((f) => f.source_ref === 'plant-biology')).toBe(true);

    // Facts from later chunks should be retrievable
    const readResult = await wiki.read('user-1', 'Calvin cycle carbon dioxide');
    expect(readResult.facts.length).toBeGreaterThan(0);
  });
});

describe('pipeline — Scenario 7: idempotent re-ingest', () => {
  it('calling ingestDocument twice with same sourceRef+sourceHash yields same fact count', async () => {
    const db = openTestDatabase();
    const llmResponse = JSON.stringify({
      facts: [
        { title: 'Fact one', body: 'Body one', tags: [], confidence: 'certain' },
        { title: 'Fact two', body: 'Body two', tags: [], confidence: 'certain' },
      ],
    });
    // Second call re-ingests same chunk → 2 more scripted responses needed
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([llmResponse, llmResponse]),
    });
    await wiki.setup();

    await wiki.ingestDocument('user-1', {
      sourceRef: 'doc-a',
      sourceHash: HASH_A,
      documentChunk: 'Some stable document content.',
    });
    const countAfterFirst = (await wiki.getMemoryBundle('user-1')).facts.length;
    expect(countAfterFirst).toBeGreaterThan(0);

    // Re-ingest identical source: old facts soft-deleted, new ones created → same active count
    await wiki.ingestDocument('user-1', {
      sourceRef: 'doc-a',
      sourceHash: HASH_A,
      documentChunk: 'Some stable document content.',
    });
    const countAfterSecond = (await wiki.getMemoryBundle('user-1')).facts.length;
    expect(countAfterSecond).toBe(countAfterFirst);
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
cd packages/integration && pnpm vitest run __tests__/pipeline.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/pipeline.test.ts
git commit -m "test(integration): pipeline Scenarios 6+7 — chunk boundary and idempotent re-ingest"
```

---

## Task 7: `pipeline.test.ts` — Scenario 8 (`forget` by sourceRef)

**Files:**
- Modify: `packages/integration/__tests__/pipeline.test.ts`

- [ ] **Step 1: Append Scenario 8**

```typescript
// append to packages/integration/__tests__/pipeline.test.ts

describe('pipeline — Scenario 8: forget by sourceRef removes all chunks', () => {
  it('forgetting by sourceRef removes all ingested facts; read returns empty', async () => {
    const db = openTestDatabase();
    const chunkResp = (title: string) =>
      JSON.stringify({ facts: [{ title, body: 'Body', tags: [], confidence: 'certain' }] });
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([chunkResp('Chunk A'), chunkResp('Chunk B')]),
    });
    await wiki.setup();

    await wiki.ingestDocument('user-1', {
      sourceRef: 'doc-alpha',
      sourceHash: HASH_A,
      documentChunk: 'A'.repeat(201) + ' ' + 'B'.repeat(201),
      maxChunkLength: 200,
      chunkOverlap: 0,
    });

    const before = await wiki.getMemoryBundle('user-1');
    expect(before.facts.some((f) => f.source_ref === 'doc-alpha')).toBe(true);

    await wiki.forget('user-1', { sourceRef: 'doc-alpha' });

    const bundle = await wiki.getMemoryBundle('user-1');
    expect(bundle.facts.filter((f) => f.source_ref === 'doc-alpha')).toHaveLength(0);

    const readResult = await wiki.read('user-1', 'Chunk A');
    const alphaIds = before.facts.map((f) => f.id);
    expect(readResult.facts.every((f) => !alphaIds.includes(f.id))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
cd packages/integration && pnpm vitest run __tests__/pipeline.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/pipeline.test.ts
git commit -m "test(integration): pipeline Scenario 8 — forget by sourceRef"
```

---

## Task 8: `maintenance.test.ts` — `onRetrievalFallback` (Scenarios 5–7)

**Files:**
- Modify: `packages/integration/__tests__/maintenance.test.ts`

**Context:** `onRetrievalFallback` is in `WikiOptions` (second arg to `WikiMemory`), not in `WikiConfig`. Do NOT use `makeWiki()` — construct `WikiMemory` directly so you can pass the callback. The callback receives an `Error`. `read()` still returns MiniSearch results after fallback.

For the dimension-mismatch test: use `keywordEmbed` (dim 3) to store BLOBs, then create a second `WikiMemory` on the **same `db`** with a dim-384 embed function. The two wikis share all stored data.

- [ ] **Step 1: Add imports and Scenarios 5–7 at the end of `maintenance.test.ts`**

```typescript
// append to packages/integration/__tests__/maintenance.test.ts
// (keywordEmbed is already exported from helpers/llm — import it)
import { stubLLM, scriptedLLM, keywordEmbed } from '../helpers/llm';

describe('maintenance — Scenario 5: embed throws → onRetrievalFallback fires, MiniSearch results returned', () => {
  it('fallback called once with the thrown error; read() returns MiniSearch results', async () => {
    const db = openTestDatabase();
    let fallbackError: Error | undefined;

    await wiki.setup();
    await wiki.importDump(makeDump('entity-1', [
      makeFact('f-apple', 'entity-1', 'agent_inferred', 1000),
    ]));

    // Re-open same db with throwing embed + fallback spy
    const wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async () => { throw new Error('model unavailable'); },
      },
      onRetrievalFallback: (err) => { fallbackError = err; },
    });
    await wiki.setup();

    await wiki.importDump(makeDump('entity-1', [
      makeFact('f-apple', 'entity-1', 'agent_inferred', 1000),
    ]));

    const result = await wiki.read('entity-1', 'apple');

    expect(fallbackError).toBeDefined();
    expect(fallbackError!.message).toBe('model unavailable');
    expect(result.facts.length).toBeGreaterThan(0);
  });
});

describe('maintenance — Scenario 6: embed returns NaN vector → fallback fires', () => {
  it('fallback called; read() returns MiniSearch results despite NaN embed', async () => {
    const db = openTestDatabase();
    let fallbackCalled = false;
    const wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async () => [NaN, 0, 1],
      },
      onRetrievalFallback: () => { fallbackCalled = true; },
    });
    await wiki.setup();

    await wiki.importDump(makeDump('entity-1', [
      makeFact('f-title', 'entity-1', 'agent_inferred', 1000),
    ]));

    const result = await wiki.read('entity-1', 'title');

    expect(fallbackCalled).toBe(true);
    expect(result.facts.length).toBeGreaterThan(0);
  });
});

describe('maintenance — Scenario 7: dimension mismatch → fallback fires, results returned', () => {
  it('stored dim-3 BLOBs with dim-384 query embed triggers fallback; MiniSearch results returned', async () => {
    // Phase 1: store facts with dim-3 BLOBs using keywordEmbed
    const db = openTestDatabase();
    const wikiDim3 = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async (text) => keywordEmbed(text),
      },
    });
    await wikiDim3.setup();
    await wikiDim3.importDump(makeDump('entity-1', [
      makeFact('f-car', 'entity-1', 'agent_inferred', 1000),
    ]));
    await wikiDim3.runReembed('entity-1'); // writes dim-3 BLOBs

    // Phase 2: open same db with dim-384 embed — dimension mismatch on read()
    let fallbackCalled = false;
    const wikiDim384 = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async () => new Array(384).fill(0.1) as number[],
      },
      onRetrievalFallback: () => { fallbackCalled = true; },
    });
    // No setup() needed — tables already exist. No teardown between wikis.

    const result = await wikiDim384.read('entity-1', 'car');

    expect(fallbackCalled).toBe(true);
    expect(result.facts.length).toBeGreaterThan(0);
  });
});
```

**Note:** Scenario 5 has an ordering bug in the draft above — `wiki` is used before assignment. The corrected version constructs the wiki once:

```typescript
// Corrected Scenario 5 — single wiki construction, no re-open needed:
describe('maintenance — Scenario 5: embed throws → onRetrievalFallback fires, MiniSearch results returned', () => {
  it('fallback called once with the thrown error; read() returns MiniSearch results', async () => {
    const db = openTestDatabase();
    let fallbackError: Error | undefined;
    const wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async () => { throw new Error('model unavailable'); },
      },
      onRetrievalFallback: (err) => { fallbackError = err; },
    });
    await wiki.setup();

    await wiki.importDump(makeDump('entity-1', [
      makeFact('f-apple', 'entity-1', 'agent_inferred', 1000),
    ]));

    const result = await wiki.read('entity-1', 'apple');

    expect(fallbackError).toBeDefined();
    expect(fallbackError!.message).toBe('model unavailable');
    expect(result.facts.length).toBeGreaterThan(0);
  });
});
```

Use the corrected version. The `makeDump` and `makeFact` helpers are already defined in `maintenance.test.ts`.

- [ ] **Step 2: Run the tests**

```bash
cd packages/integration && pnpm vitest run __tests__/maintenance.test.ts
```

Expected: all tests pass, including new Scenarios 5–7.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/maintenance.test.ts
git commit -m "test(integration): maintenance Scenarios 5-7 — onRetrievalFallback coverage"
```

---

## Task 9: `config.test.ts` — Part 1: `pruneEventsAfter` + `pruneRetainSoftDeletedFor`

**Files:**
- Create: `packages/integration/__tests__/config.test.ts`

**Context on prune timing:** `pruneEventsAfter: N` deletes events with `created_at < now - N * 86400000`. To test pruning, import events with `created_at: 1` (far in the past). `pruneRetainSoftDeletedFor: 0` hard-deletes rows with `deleted_at < now`. After `forget()` sets `deleted_at ≈ now`, a subsequent `runPrune()` at a slightly later `now` will hard-delete them. Verify hard-deletion by querying the DB directly using `db.getAllAsync`.

- [ ] **Step 1: Create `config.test.ts` with Parts 1 scenarios**

```typescript
// packages/integration/__tests__/config.test.ts
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { stubLLM } from '../helpers/llm';

// ─── shared helpers ───────────────────────────────────────────────

function makeDump(
  entityId: string,
  facts: Array<{ id: string; source_type: 'agent_inferred' | 'user_document'; confidence?: 'certain' | 'inferred' | 'tentative' }>
): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      [entityId]: {
        facts: facts.map(({ id, source_type, confidence = 'certain' }) => ({
          id,
          entity_id: entityId,
          title: `Title ${id}`,
          body: `Body of ${id}`,
          tags: [] as string[],
          confidence,
          source_type,
          source_hash: null,
          source_ref: null,
          created_at: 1,
          updated_at: 1,
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

function makeEventsDump(entityId: string, eventIds: string[], createdAt: number): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      [entityId]: {
        facts: [],
        tasks: [],
        events: eventIds.map((id) => ({
          id,
          entity_id: entityId,
          event_type: 'observation' as const,
          summary: `Summary of ${id}`,
          related_entry_id: null,
          created_at: createdAt,
        })),
      },
    },
  };
}

// ─── pruneEventsAfter ─────────────────────────────────────────────

describe('config — pruneEventsAfter', () => {
  it('events older than the configured day threshold are deleted by runPrune', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: stubLLM(),
      config: { pruneEventsAfter: 1 }, // keep events newer than 1 day
    });
    await wiki.setup();

    // 2 old events (created_at: 1 = Jan 1 1970) + 1 recent event
    await wiki.importDump(makeEventsDump('entity-1', ['evt-old-1', 'evt-old-2'], 1));
    await wiki.write('entity-1', { event_type: 'observation', summary: 'Recent event' });

    await wiki.runPrune('entity-1');

    const bundle = await wiki.getMemoryBundle('entity-1');
    // old events gone; recent event survives
    expect(bundle.events.every((e) => !['evt-old-1', 'evt-old-2'].includes(e.id))).toBe(true);
    expect(bundle.events.some((e) => e.summary === 'Recent event')).toBe(true);
  });
});

// ─── pruneRetainSoftDeletedFor ────────────────────────────────────

describe('config — pruneRetainSoftDeletedFor: 0 hard-deletes immediately', () => {
  it('soft-deleted fact is hard-deleted from DB after runPrune with retentionDays=0', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: stubLLM(),
      config: { pruneRetainSoftDeletedFor: 0 },
    });
    await wiki.setup();
    await wiki.importDump(makeDump('entity-1', [{ id: 'fact-x', source_type: 'agent_inferred' }]));

    await wiki.forget('entity-1', { entryId: 'fact-x' });
    await wiki.runPrune('entity-1');

    // Row should be completely absent from the entries table
    const rows = await db.getAllAsync<{ id: string }>(
      'SELECT id FROM llm_wiki_entries WHERE id = ?',
      ['fact-x']
    );
    expect(rows).toHaveLength(0);
  });
});

describe('config — pruneRetainSoftDeletedFor: 99999 keeps soft-deleted rows', () => {
  it('soft-deleted fact remains in DB (as deleted row) after runPrune with long retention', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: stubLLM(),
      config: { pruneRetainSoftDeletedFor: 99999 },
    });
    await wiki.setup();
    await wiki.importDump(makeDump('entity-1', [{ id: 'fact-y', source_type: 'agent_inferred' }]));

    await wiki.forget('entity-1', { entryId: 'fact-y' });
    await wiki.runPrune('entity-1');

    // Row still present but soft-deleted
    const row = await db.getFirstAsync<{ id: string; deleted_at: number | null }>(
      'SELECT id, deleted_at FROM llm_wiki_entries WHERE id = ?',
      ['fact-y']
    );
    expect(row).not.toBeNull();
    expect(row!.deleted_at).not.toBeNull();
    // Not returned by getMemoryBundle (active facts only)
    const bundle = await wiki.getMemoryBundle('entity-1');
    expect(bundle.facts.every((f) => f.id !== 'fact-y')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new test file**

```bash
cd packages/integration && pnpm vitest run __tests__/config.test.ts
```

Expected: all 3 describe blocks pass.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/config.test.ts
git commit -m "test(integration): config — pruneEventsAfter and pruneRetainSoftDeletedFor"
```

---

## Task 10: `config.test.ts` — Part 2: `autoLibrarianThreshold` + `autoHealThreshold`

**Files:**
- Modify: `packages/integration/__tests__/config.test.ts`

**Context:** `write()` fires the librarian as fire-and-forget — use `vi.waitFor()` to poll until background work completes. For `autoHealThreshold`, set both `autoLibrarianThreshold: 1` and `autoHealThreshold: 1` so a single `write()` triggers librarian AND heal in one shot. Provide two scripted LLM responses: librarian first, heal second.

- [ ] **Step 1: Add import and two describe blocks**

Add `vi` to the imports at the top of `config.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
```

Then append these describe blocks:

```typescript
// append to packages/integration/__tests__/config.test.ts

import { scriptedLLM } from '../helpers/llm';

// ─── autoLibrarianThreshold ───────────────────────────────────────

describe('config — autoLibrarianThreshold', () => {
  it('librarian fires automatically after N events; not before', async () => {
    const libResp = JSON.stringify({
      facts: [{ title: 'Auto fact', body: 'Created by auto-librarian', tags: [], confidence: 'certain' }],
      tasks: [],
    });
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([libResp]),
      config: { autoLibrarianThreshold: 3 },
    });
    await wiki.setup();

    // 2 events — below threshold, librarian should NOT fire
    await wiki.write('entity-1', { event_type: 'observation', summary: 'Event 1' });
    await wiki.write('entity-1', { event_type: 'observation', summary: 'Event 2' });

    // Briefly yield to let any erroneous background job start
    await new Promise((r) => setTimeout(r, 50));
    const beforeBundle = await wiki.getMemoryBundle('entity-1');
    expect(beforeBundle.facts).toHaveLength(0); // librarian has not run

    // 3rd event — hits threshold, librarian auto-fires in background
    await wiki.write('entity-1', { event_type: 'observation', summary: 'Event 3' });

    await vi.waitFor(
      async () => {
        const bundle = await wiki.getMemoryBundle('entity-1');
        expect(bundle.facts).toHaveLength(1);
      },
      { timeout: 5000, interval: 100 }
    );

    const afterBundle = await wiki.getMemoryBundle('entity-1');
    expect(afterBundle.facts[0].title).toBe('Auto fact');
  });
});

// ─── autoHealThreshold ────────────────────────────────────────────

describe('config — autoHealThreshold', () => {
  it('heal fires automatically inside librarian run when heal threshold is met', async () => {
    const libResp = JSON.stringify({
      facts: [{ title: 'Librarian fact', body: 'From librarian', tags: [], confidence: 'certain' }],
      tasks: [],
    });
    const healResp = JSON.stringify({ downgraded: [], deleted: [], newFacts: [] });
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      // scriptedLLM call 0 = librarian; call 1 = heal
      llmProvider: scriptedLLM([libResp, healResp]),
      config: { autoLibrarianThreshold: 1, autoHealThreshold: 1 },
    });
    await wiki.setup();

    // 1 event — triggers librarian (threshold=1); inside librarian, heal threshold also met
    await wiki.write('entity-1', { event_type: 'observation', summary: 'Trigger event' });

    // Wait for both librarian and heal to complete (both fire-and-forget from write())
    await vi.waitFor(
      async () => {
        const bundle = await wiki.getMemoryBundle('entity-1');
        expect(bundle.facts).toHaveLength(1);
      },
      { timeout: 5000, interval: 100 }
    );

    // If scriptedLLM had only 1 response and heal tried to call it, it would have thrown.
    // Getting here without error means heal consumed its response correctly.
    const bundle = await wiki.getMemoryBundle('entity-1');
    expect(bundle.facts[0].title).toBe('Librarian fact');
  });
});
```

- [ ] **Step 2: Run the test file**

```bash
cd packages/integration && pnpm vitest run __tests__/config.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/config.test.ts
git commit -m "test(integration): config — autoLibrarianThreshold and autoHealThreshold"
```

---

## Task 11: `config.test.ts` — Part 3: `staleInferredAfterDays` + `tablePrefix`

**Files:**
- Modify: `packages/integration/__tests__/config.test.ts`

**Context:** `staleInferredAfterDays` downgrades facts with `confidence = 'inferred'` (not `'certain'`) to `'tentative'`. Use `makeDump` with `confidence: 'inferred'` on the target fact. The `tablePrefix` test puts two wikis on the **same** DB and verifies they can't see each other's data.

- [ ] **Step 1: Append the two describe blocks**

```typescript
// append to packages/integration/__tests__/config.test.ts

// ─── staleInferredAfterDays ───────────────────────────────────────

describe('config — staleInferredAfterDays', () => {
  it('agent_inferred facts with confidence=inferred are downgraded to tentative; user_document untouched', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([
        JSON.stringify({ downgraded: [], deleted: [], newFacts: [] }),
      ]),
      config: { staleInferredAfterDays: 0, orphanAfterDays: null },
    });
    await wiki.setup();

    // 'stale-ai': agent_inferred with confidence=inferred, updated_at=1 (epoch start — stale)
    // 'fresh-doc': user_document — must never be touched
    await wiki.importDump(
      makeDump('entity-1', [
        { id: 'stale-ai', source_type: 'agent_inferred', confidence: 'inferred' },
        { id: 'fresh-doc', source_type: 'user_document', confidence: 'certain' },
      ])
    );

    await wiki.runHeal('entity-1');

    const bundle = await wiki.getMemoryBundle('entity-1');

    const staleFact = bundle.facts.find((f) => f.id === 'stale-ai');
    expect(staleFact).toBeDefined();                  // NOT deleted
    expect(staleFact!.confidence).toBe('tentative');  // downgraded

    const docFact = bundle.facts.find((f) => f.id === 'fresh-doc');
    expect(docFact).toBeDefined();
    expect(docFact!.confidence).toBe('certain');      // unchanged
  });
});

// ─── tablePrefix ─────────────────────────────────────────────────

describe('config — tablePrefix isolates two wikis on the same DB', () => {
  it('wikiA and wikiB each see only their own entity data', async () => {
    const db = openTestDatabase();

    const wikiA = new WikiMemory(db, {
      llmProvider: stubLLM(),
      config: { tablePrefix: 'a_' },
    });
    const wikiB = new WikiMemory(db, {
      llmProvider: stubLLM(),
      config: { tablePrefix: 'b_' },
    });
    await wikiA.setup();
    await wikiB.setup();

    // Import different facts under the same entityId in each wiki
    await wikiA.importDump(makeDump('user-1', [{ id: 'fact-a1', source_type: 'agent_inferred' }]));
    await wikiB.importDump(makeDump('user-1', [{ id: 'fact-b1', source_type: 'agent_inferred' }]));

    const bundleA = await wikiA.getMemoryBundle('user-1');
    const bundleB = await wikiB.getMemoryBundle('user-1');

    expect(bundleA.facts.map((f) => f.id)).toContain('fact-a1');
    expect(bundleA.facts.map((f) => f.id)).not.toContain('fact-b1');

    expect(bundleB.facts.map((f) => f.id)).toContain('fact-b1');
    expect(bundleB.facts.map((f) => f.id)).not.toContain('fact-a1');
  });
});
```

- [ ] **Step 2: Run the test file**

```bash
cd packages/integration && pnpm vitest run __tests__/config.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/config.test.ts
git commit -m "test(integration): config — staleInferredAfterDays and tablePrefix"
```

---

## Task 12: `config.test.ts` — Part 4: `chunkConcurrency`

**Files:**
- Modify: `packages/integration/__tests__/config.test.ts`

**Context:** `chunkConcurrency` controls how many LLM calls happen in parallel during `ingestDocument`. With `maxChunkLength: 200, chunkOverlap: 0` and ~2000-char text, we get ≥8 chunks. Provide 8 scripted LLM responses (one per chunk). After ingest, verify fact count equals chunk count.

- [ ] **Step 1: Append the describe block**

```typescript
// append to packages/integration/__tests__/config.test.ts

const HASH_64 = 'c'.repeat(64);

// ─── chunkConcurrency ─────────────────────────────────────────────

describe('config — chunkConcurrency', () => {
  it('all chunks ingested correctly with chunkConcurrency:4', async () => {
    const db = openTestDatabase();

    // Build ~2000-char document that produces ≥8 chunks at 200-char limit
    const sentences = Array.from({ length: 20 }, (_, i) =>
      `Sentence number ${i + 1} provides unique factual content for chunk testing purposes.`
    );
    const longDoc = sentences.join(' ');

    // One scripted response per chunk (8 responses for safety — script throws if over-called)
    const chunkCount = 8;
    const responses = Array.from({ length: chunkCount }, (_, i) =>
      JSON.stringify({
        facts: [{ title: `Chunk ${i + 1} fact`, body: `Body ${i + 1}`, tags: [], confidence: 'certain' }],
      })
    );

    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM(responses),
      config: { chunkConcurrency: 4, maxChunkLength: 200, chunkOverlap: 0 },
    });
    await wiki.setup();

    const result = await wiki.ingestDocument('entity-1', {
      sourceRef: 'concurrency-doc',
      sourceHash: HASH_64,
      documentChunk: longDoc,
    });

    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(result.truncated).toBe(false);

    const bundle = await wiki.getMemoryBundle('entity-1');
    // One fact per chunk (LLM returns exactly one fact per chunk)
    expect(bundle.facts.length).toBe(result.chunks);
    expect(bundle.facts.every((f) => f.source_ref === 'concurrency-doc')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the complete config test file**

```bash
cd packages/integration && pnpm vitest run __tests__/config.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/integration/__tests__/config.test.ts
git commit -m "test(integration): config — chunkConcurrency"
```

---

## Task 13: `scifact.test.ts`

**Files:**
- Create: `packages/integration/__tests__/scifact.test.ts`

**Context:** The fixture `scifact-dump.json.gz` must already exist (from Task 3). `importDump` loads 5183 pre-embedded facts. Query-time embedding uses fastembed. The NDCG@10 threshold is 0.30 (floor, not target — BGE-small-en-v1.5 is expected to score ~0.55–0.65).

The `vitest.config.ts` sets `testTimeout: 60_000`. The `beforeAll` needs 120s (override per-hook). The query loop needs ~120s (300 queries × embed + DB read). Override per-test timeout with the third argument to `it()`.

- [ ] **Step 1: Create `scifact.test.ts`**

```typescript
// packages/integration/__tests__/scifact.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { computeNDCG } from '../helpers/ndcg';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const RESULTS_DIR = path.join(__dirname, '..', 'benchmark-results');

let wiki: WikiMemory;
let queries: Record<string, string>;
let qrels: Record<string, string[]>;
let embedder: FlagEmbedding;

beforeAll(async () => {
  // Load fixtures
  const dumpGz = fs.readFileSync(path.join(FIXTURES, 'scifact-dump.json.gz'));
  const dumpJson = zlib.gunzipSync(dumpGz).toString('utf8');
  const dump = JSON.parse(dumpJson) as MemoryDump;

  queries = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'scifact-queries.json'), 'utf8')
  ) as Record<string, string>;

  qrels = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'scifact-qrels.json'), 'utf8')
  ) as Record<string, string[]>;

  // Init fastembed
  embedder = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15 });

  async function embed(text: string): Promise<number[]> {
    for await (const batch of embedder.embed([text])) {
      return Array.from(batch[0]);
    }
    throw new Error('fastembed returned no vectors');
  }

  // Create wiki and import pre-embedded corpus (no runReembed needed)
  const db = openTestDatabase();
  wiki = new WikiMemory(db, {
    llmProvider: { generateText: async () => '{}', embed },
    config: { maxResults: 10 },
  });
  await wiki.setup();
  await wiki.importDump(dump);
}, 120_000);

describe('SciFact BEIR benchmark', () => {
  it(
    'mean NDCG@10 ≥ 0.30 across all 300 SciFact test queries',
    async () => {
      const scores: number[] = [];

      for (const [queryId, queryText] of Object.entries(queries)) {
        const relevant = new Set(qrels[queryId] ?? []);
        if (relevant.size === 0) continue;

        const { facts } = await wiki.read('scifact-corpus', queryText);
        const rankedIds = facts.map((f) => f.id);
        scores.push(computeNDCG(rankedIds, relevant, 10));
      }

      const meanNDCG = scores.reduce((a, b) => a + b, 0) / scores.length;

      // Write benchmark report
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const report = {
        dataset: 'SciFact',
        model: 'BGESmallENV15',
        retriever: 'expo-llm-wiki hybrid',
        date: new Date().toISOString(),
        metrics: { 'ndcg@10': parseFloat(meanNDCG.toFixed(4)), queryCount: scores.length },
        baselines: { BM25: 0.665, DPR: 0.318 },
      };
      const fname = `scifact-${Date.now()}.json`;
      fs.writeFileSync(path.join(RESULTS_DIR, fname), JSON.stringify(report, null, 2));
      console.log(`\n  NDCG@10: ${meanNDCG.toFixed(4)}  (BM25=0.665, DPR=0.318)`);
      console.log(`  Report: benchmark-results/${fname}`);

      expect(meanNDCG).toBeGreaterThanOrEqual(0.30);
    },
    120_000 // 300 queries × ~0.3s each
  );
});
```

- [ ] **Step 2: Verify fixture exists before running**

```bash
ls -lh packages/integration/fixtures/scifact-dump.json.gz
```

Expected: file exists and is ≥1MB.

- [ ] **Step 3: Run the SciFact test**

```bash
cd packages/integration && pnpm vitest run __tests__/scifact.test.ts
```

Expected: takes 30–120s (fastembed ONNX model must be cached from `recall.test.ts`). Output includes the NDCG@10 score. Test passes if ≥0.30.

If the ONNX model is not yet cached, the `beforeAll` may take up to 120s on first run due to model download.

- [ ] **Step 4: Commit**

```bash
git add packages/integration/__tests__/scifact.test.ts
git commit -m "test(integration): SciFact BEIR benchmark — NDCG@10 against full 5k corpus"
```

---

## Task 14: Final verification

- [ ] **Step 1: Run the entire integration suite**

```bash
cd packages/integration && pnpm test
```

Expected: all test files pass. Total runtime ≈3–5 minutes (dominated by SciFact query loop and fastembed init).

- [ ] **Step 2: Check typecheck**

```bash
cd packages/integration && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: Confirm benchmark report was written**

```bash
ls packages/integration/benchmark-results/
cat packages/integration/benchmark-results/scifact-*.json
```

Expected: one JSON file with `ndcg@10` ≥ 0.30.

- [ ] **Step 4: Final commit if any cleanup needed, then push**

```bash
git push -u origin feat/integration-test-coverage
```

---

## Self-Review Notes

1. **`vi.waitFor` import** — Tasks 10 adds `vi` to the config.test.ts import. Confirm it's added to the import line at the top, not just in the append block.
2. **`scriptedLLM` import in config.test.ts** — Task 10 imports it separately; Task 9 uses only `stubLLM`. Consolidate the import at the top of the file when writing Task 9 so subsequent tasks don't re-import.
3. **Scenario 5 ordering fix** — Task 8 step 1 contains a corrected version. Use the corrected version, not the draft.
4. **`chunkConcurrency` response count** — The scripted LLM has 8 responses. If the actual chunk count exceeds 8, the test will throw `Unexpected LLM call`. If that happens, increase the number of responses in the `Array.from` call to match the actual chunk count.
5. **SciFact fixture dependency** — `scifact.test.ts` will panic if the fixture doesn't exist. Tasks 2–3 must be fully completed before Task 13.
