---
title: Pluggable vector search
description: Delegate semantic ranking to sqlite-vec or an external ANN index with the VectorRanker interface, with fallback policies.
sidebar:
  order: 13
---

By default the engine scores vectors in JavaScript. That's fine for thousands of facts per
entity. For larger corpora, plug in an approximate-nearest-neighbour index through
`VectorRanker`. The engine still handles embedding validation, hybrid blending, and row hydration.

```ts
interface VectorRanker {
  rankBySimilarity(args: {
    entityId: string;
    queryVec: Float32Array | number[]; // treat as read-only
    candidateIds?: string[];           // set when a keyword pre-filter is active
    limit: number;
  }): Promise<Array<{ id: string; semanticScore: number }>>; // higher = more similar

  onEmbeddingPersisted?(e: { entityId: string; factId: string; vector: Float32Array | null }): void | Promise<void>;
}
```

## Example: sqlite-vec

```ts
const sqliteVecRanker: VectorRanker = {
  async rankBySimilarity({ entityId, queryVec, candidateIds, limit }) {
    let sql = `SELECT id, (1.0 - distance) AS semanticScore FROM vec_facts WHERE entity_id = ?`;
    const params: unknown[] = [entityId];
    if (candidateIds) {
      sql += ` AND id IN (${candidateIds.map(() => '?').join(',')})`;
      params.push(...candidateIds);
    }
    sql += ` ORDER BY vec MATCH vec_neighbor(?) LIMIT ?`; // adjust to your sqlite-vec version
    params.push(queryVec, limit);
    return db.getAllAsync(sql, params);
  },

  async onEmbeddingPersisted({ entityId, factId, vector }) {
    if (vector) {
      await db.runAsync(`INSERT OR REPLACE INTO vec_facts (id, entity_id, vec) VALUES (?, ?, ?)`, [factId, entityId, vector]);
    } else {
      await db.runAsync(`DELETE FROM vec_facts WHERE id = ?`, [factId]);
    }
  },
};

createWiki(db, { llmProvider, vectorRanker: sqliteVecRanker });
```

The SQLite `embedding_blob` column stays the **source of truth**. It's written before the hook
is called.

## When the ranker fails

```ts
createWiki(db, {
  llmProvider,
  vectorRanker,
  vectorRankerFallback: 'js-cosine', // default
  onVectorRankerFallback: ({ error, policy }) => log.warn('ranker failed', policy, error),
});
```

| Policy | Behavior | Choose it for |
|---|---|---|
| `'js-cosine'` (default) | Score in-process, the same as having no ranker | Availability |
| `'keyword'` | Keyword results only | Fast degradation |
| `'empty'` | No facts for this read (tasks and events still load) | Strict consistency |
| `'throw'` | Reject the `read()` | Failing fast |

## Rules for adapter authors

- **Parameterize everything.** Never concatenate `entityId`, `factId`, or `candidateIds` into SQL.
- **Filter by `entityId`** in every query, to prevent cross-tenant leaks.
- **Scrub credentials** from errors. The engine also sanitizes them by default (`sanitizeRankerErrors: true`).
- **Cap `limit` and `candidateIds.length`**, and don't keep references to `vector` after the call returns.
- If `onEmbeddingPersisted` is **eventually consistent** (for example a remote index), document the
  lag. Reads may miss new facts until the index catches up.
- If `onEmbeddingPersisted` **throws** while a fact is written or imported, the engine reports
  `hook_failed` with the fact id and carries on, so your index can miss that fact. Reconcile from
  the diagnostic.

:::caution[Deletes must reach your index]
`forget()` and `runPrune()` **reject** if `onEmbeddingPersisted` fails or times out on deletion.
This stops "forgotten" facts from staying retrievable in an external index. See
[Deleting data](/expo-llm-wiki/guides/deleting-data/).
:::

Hybrid blending still applies on top of ranker scores when `hybridWeight` is set.
