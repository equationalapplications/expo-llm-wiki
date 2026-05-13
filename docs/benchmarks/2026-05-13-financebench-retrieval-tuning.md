# FinanceBench retrieval tuning — 2026-05-13

Follow-up to the [initial FinanceBench benchmark](./2026-05-13-financebench-retrieval-benchmark.md). Evaluated three configurations on the same frozen fixture set to determine the effect of `hybridWeight`, `preFilterLimit`, and `maxResults`.

## Commit and environment

| Field | Value |
|-------|--------|
| **Date (UTC)** | 2026-05-13 |
| **Git branch** | `kv/updates` |
| **Package** | `packages/integration` (`@equationalapplications/integration-llm-wiki`) |
| **Test file** | `__tests__/financebench.test.ts` |

## Embedding model

| Setting | Value |
|---------|--------|
| **Model** | FastEmbed `EmbeddingModel.BGESmallENV15` (`bge-small-en-v1.5`) |
| **Vector width** | 384 |

Corpus embeddings remain frozen in `fixtures/financebench-embeddings.json.gz`. Only the 150 query embeddings are recomputed at test time.

## Configurations tested

| Label | `hybridWeight` | `preFilterLimit` | `maxResults` |
|-------|---------------|-----------------|-------------|
| Baseline (prior run) | `undefined` (pure semantic) | `undefined` | `10` |
| Guided: hw=0.5 | `0.5` | `1000` | `32` |
| Semantic-32 | `undefined` (pure semantic) | `undefined` | `32` |
| hw=0.9 | `0.9` | `undefined` | `32` |

## Results

| Config | MRR@10 | Hit Rate@5 | Hit Rate@10 | Hit Rate@32 |
|--------|--------|-----------|------------|------------|
| Baseline (semantic, maxResults=10) | 0.7017 | 0.9067 | 0.9667 | — |
| **Guided: hw=0.5, preFilterLimit=1000, maxResults=32** | **0.2679** | **0.4133** | **0.6067** | **0.9000** |
| **Semantic-32 (winner)** | **0.7017** | **0.9067** | **0.9667** | **0.9933** |
| hw=0.9, maxResults=32 | 0.6283 | 0.8600 | 0.9400 | 1.0000 |

## Final asserted floor

`MRR@10 ≥ 0.55` (semantic-32 config, actual 0.7017 — 1.27× floor).

## Analysis

### Why guided config (hw=0.5, preFilterLimit=1000) failed

Two compounding issues:

**1. `preFilterLimit` gates embedding search on a small corpus.**
When `preFilterLimit` is set, `WikiMemory` runs MiniSearch first and uses its results as the candidate set. If MiniSearch returns zero matches for a query, `candidateRows` is set to `null` and the cosine similarity scan is skipped entirely — returning an empty result set. Financial queries use natural language ("What was AMD's revenue in 2022?") while the corpus contains formal SEC prose ("Net revenues were $23.6 billion for fiscal year 2022..."). MiniSearch cannot bridge that lexical gap for many queries. With only 180 corpus facts, the pre-filter conferred no efficiency benefit while creating catastrophic recall failures.

**2. `hybridWeight: 0.5` adds keyword noise that outweighs semantic signal.**
BM25/MiniSearch scores are unstable on short, specialized financial passages. A 50% blend introduces ranking noise that pushes the relevant passage from rank ~1–2 (pure semantic) to rank 3–10+, collapsing MRR@10 from 0.70 to 0.27. Even `hybridWeight: 0.9` (10% keyword) drops MRR@10 to 0.63 and Hit Rate@5 by 4.7 points.

### What actually helped: maxResults=32

The only durable improvement from this tuning exercise is increasing `maxResults` from 10 to 32:

- MRR@10 unchanged (the first-hit rank stays the same)
- Hit Rate@32 = **0.9933** — only 1 of 150 queries fails to find the correct passage in the top 32

For downstream LLM use, this means a pipeline sending the top-32 passages as context will miss the answer for only ~1% of questions.

### Guidance applicability

The tuning guidance (hybridWeight=0.5, preFilterLimit=1000) is appropriate for large corpora (thousands of facts) where:
- MiniSearch reliably finds keyword-overlapping candidates
- A full cosine scan is too expensive without pre-filtering

For small, semantically rich corpora where embeddings already rank well, pure semantic retrieval with higher `maxResults` outperforms hybrid approaches.

## Retrieve command

```bash
pnpm test -- --reporter=verbose financebench
```

## Final test configuration

```typescript
config: { maxResults: 32, tablePrefix: TABLE_PREFIX }
```

### How this helps Developers

This is actually **better data** for the repo than a "successful" tuning would have been. It teaches a developer:

1. **Don't pre-filter prematurely:** Unless you have 100k+ rows and are seeing latency spikes, keep `preFilterLimit` unset to ensure 100% semantic recall.
    
2. **Trust the Embeddings:** For professional/formal domains, lean closer to `hybridWeight: 1.0`.
    
3. **Widen the Net:** If using an LLM to "read" the results, prioritize higher `maxResults` to capture that final 2.7% of edge cases.