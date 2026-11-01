---
title: Review drafts & grounding
description: Keep unreviewed facts out of prompts, promote them after review, and require LLM writers to quote their sources.
sidebar:
  order: 11
---

## Drafts

A fact with `lifecycle_status: 'draft'` is unreviewed. Drafts are **visible by default**.

```ts
// Hide drafts for one call…
await wiki.read('user-1', 'deploy process', { excludeDrafts: true });
await wiki.traverseGraph('user-1', { sourceId, excludeDrafts: true });

// …or engine-wide
createWiki(db, { llmProvider, config: { excludeDrafts: true } });
```

- Drafts are removed **before** the `maxResults`, `tierFloors`, and pre-filter cuts, so they
  never take a slot from a reviewed fact.
- In traversal, a draft is a dead end. The anchor fact is always returned.
- Status is read from SQLite on every call, so a promotion takes effect immediately.

### Review workflow

```ts
const { facts, nextCursor } = await wiki.listDrafts('user-1', { limit: 50 });

await wiki.promoteDraft(facts[0].id, 'user-1', { by: 'human:alice' });
// → stable; trust tier 'human-reviewed' because `by` starts with 'human:'

// Reject instead:
await wiki.setLifecycleStatus(facts[1].id, 'user-1', 'deprecated'); // or forget()
```

`promoteDraft` throws `WikiDraftNotFound` if there's no live draft with that ID. Promotion
doesn't change `updated_at`, so the fact keeps its place in recency ordering.

:::note[React]
There are no dedicated draft hooks. Call `listDrafts` and `promoteDraft` on the instance you get
from `useWiki()`.
:::

## Grounding

Grounding makes LLM writers **quote the text they were shown**. A deterministic check (no LLM
involved) verifies each quote:

```ts
createWiki(db, {
  llmProvider,
  config: {
    grounding: {
      mode: 'draft',          // 'off' (default) | 'draft'
      writers: ['ingest'],    // default; you can add 'librarian' and 'heal'
      minEvidenceChars: 20,   // shorter quotes count as missing
      maxEvidence: 3,         // quotes requested per fact
      maxEvidenceChars: 300,
    },
  },
});
```

| Outcome | Stored as | Diagnostic |
|---|---|---|
| Every quote is found | `stable`, trust tier `machine-confirmed` | — |
| No usable quotes | `draft` | `grounding_missing` (`no_evidence` / `evidence_too_short`) |
| A quote isn't found, or there are more than 10 quotes | `draft` | `grounding_failed` (`quote_not_found` / `too_many_quotes`) |

### What counts as source

- **Ingest:** the chunk text.
- **Librarian:** each event's `summary` in the prompt.
- **Heal:** recent event summaries, plus the bodies of non-draft document anchors (clipped to 800 characters).
- Instructions, the manifest, existing facts, and IDs **never** count, so a model can't "ground"
  a claim by quoting its own instructions.

Matching normalizes both sides with NFKC, collapses whitespace runs, and is case-sensitive. The
quotes themselves aren't stored.

:::tip
Start with `writers: ['ingest']`. The librarian and heal synthesize across events, so their pass
rates vary. Measure them on your own data before you add them.
:::

`upsertGraph()` nodes come from your own code, so they're never grounded.
