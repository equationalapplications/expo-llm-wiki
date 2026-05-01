# Spec: Vector Retrieval Spike

**Date:** 2026-05-01
**Status:** Spike (research only — no code shipped)
**Branch:** TBD

---

## Problem

`expo-llm-wiki` retrieval is FTS5-only. Porter stemming + caller-supplied `synonymMap` cover regular morphology and known domain vocabulary, but they fail on:

- Paraphrase: `"physical activity"` does not match a fact about `"exercise"`.
- Cross-language synonyms not in the user's map.
- Conceptual proximity: `"weekend plans"` should partially match facts about `"Saturday hiking"`.

Vector embeddings address all three. CodeGraph uses sqlite-vss + ONNX-runtime locally with the nomic-embed model. The same approach on Expo is plausible but uncertain — this spike resolves the unknowns before committing to a feature spec.

---

## Goals (of the spike)

Produce a written go/no-go recommendation with measured evidence on:

1. **Extension loading on Expo SQLite.** Can we load sqlite-vec on iOS and Android in current Expo SDK?
2. **Bundle size cost.** Per-platform increase from sqlite-vec native module + any embedding model.
3. **Embedding source.** JS-side via user's `LLMProvider` (cheap to integrate, expensive at runtime) vs bundled ONNX/Core ML model (large bundle, fast on-device).
4. **Hybrid ranking quality.** Linear blend of FTS5 bm25 + cosine similarity vs FTS5 alone, on a small benchmark set.
5. **Migration path.** How a config-gated vector layer interacts with the existing FTS5 read path without breaking non-vector consumers.

## Non-Goals

- Shipping any vector code in the next release.
- Choosing a final embedding model.
- Building a benchmarking harness beyond a one-off measurement script.

---

## Investigation Plan

### A. Extension loading

- Check current `expo-sqlite` API for `loadExtension(libPath, entryPoint)`. Confirm:
  - Available on iOS? Android?
  - Requires custom dev client / EAS build, or works in Expo Go?
  - Architecture support (arm64, x86_64, simulator).
- Test loading sqlite-vec (https://github.com/asg017/sqlite-vec) — single `.dylib` / `.so` per platform.
- If extension loading is unavailable: investigate alternative WASM-based vector libs runnable in pure JS over an existing SQLite blob column.

**Deliverable:** matrix of `(platform, build mode) → can/cannot load sqlite-vec`.

### B. Bundle size

- Measure prebuilt sqlite-vec binary size per architecture.
- Measure smallest viable embedding model:
  - `all-MiniLM-L6-v2` quantized: ~22MB (384-dim).
  - `nomic-embed-text-v1.5` quantized: ~80MB (384-dim).
- Total app bundle delta with model + ONNX runtime.

**Deliverable:** table of bundle deltas.

### C. Embedding source

Two candidates:

1. **Extend `LLMProvider`:**
   ```ts
   interface LLMProvider {
     generateText: (...) => Promise<string>;
     embed?: (text: string) => Promise<number[]>;
   }
   ```
   Pros: zero bundle cost, user picks model, can use cloud APIs. Cons: latency + cost per write, requires network.
2. **Bundle ONNX model + runtime:** offline, fast, no per-call cost. Cons: large bundle, model lock-in, dimension lock-in across upgrades.

**Deliverable:** recommendation with cost/latency estimate for a typical write.

### D. Hybrid ranking

- Build a 50-pair benchmark set: `(query, expected fact id)` covering paraphrase, morphology, exact match, conceptual.
- Compare:
  - FTS5 only (current).
  - Vector only.
  - Linear blend `score = α * bm25 + (1 - α) * cosine`, sweep α.
- Report mean reciprocal rank per strategy.

**Deliverable:** measured MRR table; recommended default α.

### E. Migration path

- Schema additions: `{prefix}embeddings(rowid INTEGER PRIMARY KEY, entry_rowid INTEGER, vec BLOB)` joined to `entries.rowid`.
- Config: `vectorEnabled?: boolean`, `embeddingDimension?: number`.
- Behaviour when disabled: no schema change, no embed call, FTS5-only path unchanged.
- Behaviour when enabled mid-life: backfill embeddings for existing entries via a maintenance method `runReembed(entityId)`.
- Dimension change handling: store dimension in `meta` table; refuse to load with mismatched config.

**Deliverable:** sketch of schema + new public API surface.

---

## Open Questions

- Does `expo-sqlite`'s SQLCipher variant break extension loading?
- Is there an Expo-blessed path to ship native binaries without custom prebuild config?
- For React Native New Architecture (Fabric), do native SQLite extensions still load the same way?
- If users switch embedding models, do we re-embed automatically or invalidate?

---

## Output

A short follow-up spec `2026-MM-DD-vector-retrieval.md` containing:

- Final recommendation: ship / don't ship / ship with caveats.
- If shipping: schema, API surface, default config, migration plan, test plan.
- If not shipping: documented blockers and revisit conditions.

No code is committed during this spike beyond a throwaway measurement script in `scripts/` (gitignored or removed before merge).
