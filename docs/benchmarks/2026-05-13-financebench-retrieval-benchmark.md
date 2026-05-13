# FinanceBench retrieval benchmark — 2026-05-13

First run of the FinanceBench benchmark added in `packages/integration`. Measures **Hit Rate@5**, **Hit Rate@10**, and **MRR@10** over the 150-question open-source FinanceBench sample (`PatronusAI/financebench`).

## Commit and environment

| Field | Value |
|-------|--------|
| **Date (UTC)** | 2026-05-13 |
| **Git revision** | `6b2f7f6` |
| **Package** | `packages/integration` (`@equationalapplications/integration-llm-wiki`) |
| **Test file** | `__tests__/financebench.test.ts` |

## Embedding model and dimensions

| Setting | Value |
|---------|--------|
| **Model** | FastEmbed `EmbeddingModel.BGESmallENV15` (`bge-small-en-v1.5`) |
| **Vector width** | 384 |

Corpus embeddings are **frozen** in `fixtures/financebench-embeddings.json.gz` and restored directly into `embedding_blob` before the test runs. Only the 150 query embeddings are computed at test time via `FlagEmbedding.init`.

## What was tested

| Suite | Corpus | Queries | Metrics | Asserted floor |
|-------|--------|---------|---------|----------------|
| **FinanceBench** | 180 unique evidence texts from 150 10-K/earnings filings | 150 | MRR@10, Hit Rate@5, Hit Rate@10 | MRR@10 ≥ **0.30** |

### Corpus construction

Evidence texts are deduplicated across all 150 rows. Fact IDs are derived from:

```
fact_id = sha256(doc_name + "||" + evidence_text).slice(0, 16)
```

Each unique `(doc_name, evidence_text)` pair becomes one WikiMemory fact under entity `financebench-corpus`. 150 questions × ~1–2 evidence passages each → 180 unique corpus facts.

### Fixtures

| File | Size | Contents |
|------|------|----------|
| `fixtures/financebench-corpus.jsonl` | ~90 KB | Raw corpus (gitignored, re-generate with fetch script) |
| `fixtures/financebench-queries.json` | ~30 KB | 150 question strings keyed by `financebench_id` |
| `fixtures/financebench-qrels.json` | ~15 KB | Relevant fact IDs per query |
| `fixtures/financebench-dump.json.gz` | 0.1 MB | WikiMemory text-only dump (no blobs) |
| `fixtures/financebench-embeddings.json.gz` | 0.6 MB | Precomputed 384-dim float32 vectors |

## Results

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
| **MRR@10** | **0.7017** | ≥ 0.30 | ✅ pass (2.3× floor) |
| **Hit Rate@5** | **0.9067** | — | observed |
| **Hit Rate@10** | **0.9667** | — | observed |
| **Query count** | 150 | — | — |

MRR@10 of 0.70 means the median first-hit rank is between position 1 and 2. Hit Rate@10 of 0.97 indicates the correct evidence passage appears in the top 10 for all but ~5 of the 150 questions.

## Retrieve command

```bash
cd packages/integration
pnpm test -- --reporter=verbose financebench
```

To regenerate fixtures from scratch:

```bash
npx tsx scripts/fetch-financebench.ts
npx tsx scripts/embed-financebench.ts
```
