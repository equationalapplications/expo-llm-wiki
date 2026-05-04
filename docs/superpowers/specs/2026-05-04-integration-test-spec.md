# Integration Test Suite — Design Spec

**Date:** 2026-05-04
**Branch:** feat/retrieval-tuning (PR in review)
**Status:** Approved, awaiting implementation

---

## Problem

The core package has 189 unit and feature tests that verify individual behaviours in isolation. What is missing is coverage of the full public API in realistic call sequences: write → librarian → read, export → import → read, maintenance jobs affecting subsequent reads, and semantic recall quality under real embeddings.

Unit tests catch logic bugs inside a function. Integration tests catch ordering bugs, state-leakage, and contract violations that only appear when operations are chained.

---

## Goals

1. **API coverage** — every public method exercised in at least one realistic call sequence.
2. **Ordering correctness** — operations composed in the order a real consumer would call them.
3. **Recall quality** — assert that the retrieval pipeline surfaces semantically relevant facts under real embeddings, not just that ranking logic executes without error.

Not a goal: exhaustive per-method matrix testing (that lives in the feature tests in `packages/core/__tests__/`).

---

## Architecture

### Package

```
packages/integration/
├── package.json
├── vitest.config.ts
├── helpers/
│   ├── db.ts          # re-exports openTestDatabase from core
│   ├── llm.ts         # stubLLM() and scriptedLLM(script)
│   └── wiki.ts        # makeWiki() convenience wrapper
└── __tests__/
    ├── exportImport.test.ts
    ├── maintenance.test.ts
    ├── pipeline.test.ts
    └── recall.test.ts
```

`packages/integration/` is a private package that depends on `@equationalapplications/core-llm-wiki`. It is not published. CI runs it as a separate step after core tests pass.

### Helpers

**`helpers/db.ts`**
Re-exports `openTestDatabase` from `packages/core/__tests__/helpers/sqliteAdapter`. Each test gets a fresh in-memory SQLite instance — no shared state between tests.

**`helpers/llm.ts`**

```ts
// Stub: used where LLM output doesn't affect the assertion
export function stubLLM(): LLMProvider {
  return { generateText: async () => '{}' };
}

// Scripted: call index → JSON string. Throws on unexpected extra calls.
export function scriptedLLM(
  script: Map<number, string>,
  embedFn?: (text: string) => Promise<number[]>
): LLMProvider {
  let callIndex = 0;
  return {
    generateText: async () => {
      const response = script.get(callIndex++);
      if (response === undefined) throw new Error(`Unexpected LLM call at index ${callIndex - 1}`);
      return response;
    },
    embed: embedFn,
  };
}

// Deterministic keyword embed — no network, no model download
export function keywordEmbed(text: string): number[] {
  if (text.includes('apple')) return [1, 0, 0];
  if (text.includes('car') || text.includes('vehicle')) return [0, 1, 0];
  return [0, 0, 1];
}
```

**`helpers/wiki.ts`**

```ts
export function makeWiki(llm: LLMProvider, config?: WikiConfig): { wiki: WikiMemory; db: SQLiteAdapter } {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: llm, config });
  return { wiki, db };
}
```

---

## Test Files

### `exportImport.test.ts`

**Scenario 1 — Full roundtrip preserves facts and ranking**

1. Seed entity `user-1` via `importDump` with 3 facts (two with keyword-embed BLOBs, one without).
2. `exportDump()` → import into fresh `WikiMemory` → `setup()`.
3. `read('user-1', 'apple')` — assert same fact appears at rank 1 in both original and restored wikis.
4. Assert fact count identical, `source_type` and `confidence` preserved.

**Scenario 2 — Merge collision: newer `updated_at` wins**

1. Import dump A: fact `f1` with `updated_at = 1000`, fact `f2` unique to A.
2. Import dump B with `merge: true`: fact `f1` with `updated_at = 2000` (updated body), fact `f3` unique to B.
3. Assert: `f1` has body from dump B, `f2` and `f3` both present.

**Scenario 3 — Embedding BLOB survives roundtrip (`runReembed` reports all skipped)**

1. Seed facts via `importDump`, run `runReembed` to write BLOBs.
2. `exportDump` → import into fresh wiki.
3. `runReembed` on restored wiki — assert `{ embedded: 0, skipped: N }`. Proves BLOBs were exported and re-imported intact.

---

### `maintenance.test.ts`

**Scenario 1 — `runHeal` culls orphaned `agent_inferred`, spares `user_document`**

`runHeal` soft-deletes facts with `access_count = 0` older than `orphanAfterDays`. `runPrune` only hard-deletes already-soft-deleted rows; it does not touch active facts.

1. Create wiki with `config: { orphanAfterDays: 0 }` — threshold of 0 days means any never-accessed fact qualifies immediately.
2. Seed entity via `importDump` with two facts: one `agent_inferred` (`created_at = 1`, `access_count = 0`) and one `user_document` (same `created_at`).
3. `runHeal('entity-1')` with `stubLLM()` (LLM response `{}` — no rewrites, just the orphan pass).
4. `getMemoryBundle('entity-1')` — assert `user_document` fact present (`deleted_at` null), `agent_inferred` fact absent (`deleted_at` non-null).

**Scenario 2 — `runHeal` LLM phase deletes `agent_inferred`, spares `user_document`**

1. Seed entity with one `agent_inferred` fact (id `fact-a`) and one `user_document` fact (id `doc-1`).
2. `runHeal('entity-1')` with scripted LLM returning `{ "downgraded": [], "deleted": ["fact-a"], "newFacts": [] }`.
3. Assert: `fact-a` is soft-deleted; `doc-1` body is unchanged. Verify the LLM cannot delete `doc-1` even if it tries — add a second scripted variant where LLM returns `{ "deleted": ["fact-a", "doc-1"] }` and assert `doc-1` survives (guarded by `mutableIds` filter).

**Scenario 3 — `runReembed` writes BLOBs; subsequent `read()` loads facts from cache without re-embedding**

1. Seed facts without embeddings (no `embedding_blob` column data).
2. `runReembed('entity-1')` with embed spy — assert spy called N times (once per fact).
3. `clearVectorCache()` to force a cache-cold `read()`.
4. `read('entity-1', 'query')` with the same embed spy — assert spy called exactly once (for the query string only, not for any fact). Facts are loaded from BLOBs into the vector cache, not re-embedded.

**Scenario 4 — Mutex: `runPrune` + concurrent `runLibrarian` on same entity throws `WikiBusyError`**

1. Start `runPrune` on `entity-A` (slow scripted LLM to keep it in-flight).
2. Concurrently call `runLibrarian('entity-A')` — assert `WikiBusyError`.
3. `runLibrarian('entity-B')` — assert resolves normally (no bleed across entities).

---

### `pipeline.test.ts`

**Scenario 1 — Write → Librarian → Read**

1. `write('user-1', { type: 'user_message', content: 'I prefer dark mode and use vim' })` ×3 events.
2. `runLibrarian('user-1')` with scripted LLM returning:
   ```json
   { "facts": [
     { "title": "Editor preference", "body": "Uses vim", "tags": ["tools"], "confidence": "certain" },
     { "title": "UI preference", "body": "Prefers dark mode", "tags": ["ui"], "confidence": "certain" }
   ], "tasks": [] }
   ```
3. `read('user-1', 'editor')` — assert "Editor preference" fact at rank 1.
4. Assert `events` array in returned bundle is non-empty.

**Scenario 2 — Forget removes fact from subsequent `read()`**

1. Full pipeline from Scenario 1.
2. `getMemoryBundle('user-1')` — extract the `id` of the "Editor preference" fact from `bundle.facts`.
3. `forget('user-1', { entryId: editorFactId })`.
4. `read('user-1', 'editor')` — assert editor fact absent from results; UI preference fact still present.

**Scenario 3 — Multi-entity isolation**

1. Run pipeline for `user-1` (editor + UI facts) and `user-2` (separate scripted facts about cooking).
2. `read('user-1', 'cooking')` — assert no cooking facts returned.
3. `read('user-2', 'vim')` — assert no editor facts returned.

---

### `recall.test.ts`

Uses real fastembed embeddings. Model downloaded once in `beforeAll` and cached by the ONNX runtime (approx 30MB, ~3–5s cold start).

**Dev dependency:** `fastembed@^2.1.0`

**Setup:**

```ts
import { EmbeddingModel, FlagEmbedding } from 'fastembed';

let embedder: FlagEmbedding;

beforeAll(async () => {
  embedder = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15 });
}, 30_000);

async function embed(text: string): Promise<number[]> {
  const [vec] = await embedder.embed([text]);
  return Array.from(vec);
}
```

**Scenario 1 — Synonym recall (recall@5 = 1.0)**

1. Seed entity with facts: "automobile is a wheeled motor vehicle", "car is used for personal transportation", "vehicle carries passengers or cargo".
2. `runReembed` with real embed.
3. `read('user-1', 'transportation', { maxResults: 5 })` — assert all 3 facts appear in results.

**Scenario 2 — Hybrid beats keyword-only on semantic queries**

1. Same corpus as Scenario 1.
2. Query `"motorized road travel"` — zero lexical overlap with any fact title.
3. `read` with `hybridWeight: 0` (MiniSearch only) — record facts returned.
4. `read` with `hybridWeight: 0.5` — assert rank-1 fact is semantically closer (verified by cosine score) than rank-1 from keyword-only.

**Scenario 3 — Domain separation (precision@3 = 1.0)**

1. Seed 5 programming facts (recursion, closures, async/await, type inference, garbage collection).
2. Seed 5 cooking facts (sauté, braising, mise en place, emulsification, reduction).
3. `runReembed` with real embed.
4. `read('user-1', 'recursion', { maxResults: 3 })` — assert all 3 results are programming facts.
5. `read('user-1', 'braising', { maxResults: 3 })` — assert all 3 results are cooking facts.

**Scenario 4 — Recall survives export/import roundtrip**

1. Run Scenario 1 setup and verify recall@5 = 1.0.
2. `exportDump` → import into fresh wiki (no `runReembed`).
3. Repeat the same `read` query — assert recall@5 still = 1.0. Proves BLOB roundtrip preserves semantic search quality without re-embedding.

---

## CI Integration

- `packages/core` tests run first (fast, no network).
- `packages/integration` runs as a separate job.
- `recall.test.ts` model download is cached by CI key on the ONNX model filename.
- `recall.test.ts` has a 60s timeout per test; all others use the default vitest timeout.

---

## What Is Not Covered Here

- React hook integration (`packages/react`) — tracked separately; currently failing due to `WikiContext` import issue unrelated to retrieval.
- Expo adapter (`packages/expo`) — existing `adapter.test.ts` covers the SQLite adapter contract.
- Performance / latency benchmarks — out of scope for correctness testing.
