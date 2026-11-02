---
title: Retrieval
description: How read() finds relevant memory — semantic, keyword, hybrid, and graph retrieval, and how they fall back.
sidebar:
  order: 3
---

`read(entityId, query, options?)` returns a **`MemoryBundle`**:

```ts
const { facts, tasks, events } = await wiki.read('user-123', 'weekend plans');
// facts  — ranked by relevance (top maxResults, default 10)
// tasks  — open tasks (pending / in progress)
// events — the 10 most recent events, oldest first
```

Pass an empty query (`''`) to skip search and get the most recently updated facts.

## Three retrieval modes

| Mode | When it's used | Best for |
|---|---|---|
| **Semantic** (vector cosine) | `llmProvider.embed` is set | Natural-language questions ("what do I know about X?") |
| **Keyword** (FTS5 or MiniSearch) | No `embed`, offline, or `hybridWeight: 0` | Exact terms, names, IDs |
| **Hybrid** | `hybridWeight` between 0 and 1 | The best of both. `0.7` is a common default. |
| **Graph** | You call [`traverseGraph()`](/expo-llm-wiki/guides/graphrag/) | Structural questions ("what's connected to Alice?") |

## The decision path

```text
read(entity, query)
 ├─ hybridWeight === 0 ? ───────────────────────────────► keyword only (no embed call)
 ├─ no embed() configured ? ────────────────────────────► keyword only
 └─ embed(query)
     ├─ throws / bad vector ─► onRetrievalFallback(err) ─► keyword only
     └─ ok
         ├─ preFilterLimit set ? ─► keyword top-K → cosine on those K
         └─ else ─────────────────► cosine on all facts (vectors cached)
              └─ hybridWeight set ? ─► blend with keyword score : pure semantic
                   └─ fetch full rows for the top maxResults → MemoryBundle
```

A few properties come out of this design:

- **It never fails because of the network.** A failed embedding falls back to keyword search,
  and `onRetrievalFallback` tells you it happened so you can show an "offline" hint.
- **Two-phase reads.** Scoring reads only minimal columns. Full rows are fetched for the winners only.
- **Vector cache.** Parsed vectors are cached per entity. See [Vector cache](#vector-cache).

## Vector cache

Full-scan semantic reads cache the parsed `Float32Array` vectors in memory, keyed by entity, so a
repeated query doesn't parse them again.

- Up to **16 entities** are cached. When the limit is reached, the oldest-inserted entity is evicted.
- An entity with more than **500** live facts isn't cached at all, and any existing cache for it
  is dropped.
- Only single-entity full-scan reads on the built-in cosine path fill the cache. Reads with
  `preFilterLimit`, multi-entity reads, and reads served by a `vectorRanker` don't fill it. A
  `preFilterLimit` read still reuses vectors that are already cached.
- Any mutation clears it: `runLibrarian`, `runHeal`, `runPrune`, `runReembed`, `ingestDocument`,
  `importDump`, and `forget`.
- On memory-constrained runtimes, call `wiki.clearVectorCache()` to free it yourself.

## Keyword index backends

The `indexStrategy` config option picks the keyword engine:

| Value | Behavior |
|---|---|
| `'auto'` (default) | Uses FTS5 if the SQLite build has it, otherwise MiniSearch. |
| `'fts5'` | The index is stored inside the database file, so memory use stays flat at any size. `setup()` throws if FTS5 or json1 is missing. |
| `'minisearch'` | An in-memory JS index. Memory grows with the total text stored. This was the behavior before 7.11. |

:::note
sql.js ships without FTS5, so browser apps use MiniSearch under `'auto'`. The two backends rank
results slightly differently.
:::

Operational details:

- The first `setup()` that adds FTS5 to an existing database rebuilds the index in bounded
  windows and sweeps, each in its own transaction, so the write lock is not held for the whole
  rebuild. A rebuild continues across later `setup()` and `syncSearchIndex()` calls until it
  finishes.
- Under `'auto'`, a failed FTS5 init is retried once. After that, `setup()` completes with keyword
  search unavailable: keyword reads throw `WikiSearchUnavailableError`. It never quietly switches
  to MiniSearch.
- While search is unavailable, `runHeal` returns `searchUnavailable: true` and
  `runPendingMaintenance` lists skipped jobs in `perEntity[].searchUnavailable`. Calling
  `syncSearchIndex()` with no arguments retries the init, backing off from 5 seconds up to 5
  minutes after a failure.
- MiniSearch keeps all entry text in the JS heap. The measured ceiling is about 1 million entries
  on a default Node heap (`--max-old-space-size`).

## Tuning knobs at a glance

| Option | Default | Effect |
|---|---|---|
| `maxResults` | `10` | How many facts are returned |
| `hybridWeight` | unset (pure semantic) | `0` means pure keyword, `1` means all-semantic, values in between blend |
| `preFilterLimit` | unset | Run cosine scoring only on the top-K keyword matches. Recommended above about 500 facts. |
| `tokenBudget` | unset | Pack facts to fit about N tokens |
| `excludeDrafts` | `false` | Hide unreviewed draft facts |
| `asOf` | now | Answer as of a point in time ([temporal facts](/expo-llm-wiki/guides/temporal-facts/)) |

All of these can be set globally in `config` or per call in `read()` options. See
[Tune retrieval](/expo-llm-wiki/guides/tune-retrieval/).
