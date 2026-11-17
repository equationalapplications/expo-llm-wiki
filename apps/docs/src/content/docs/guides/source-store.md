---
title: Source text store
description: Store the verbatim text behind your facts and quote it back — storeSource, getStoredSource, and reading stored passages with read().
sidebar:
  order: 3.5
---

Ingest stores *facts extracted from* a document, not the document itself. The source text store
lets you keep the verbatim text too, so you can quote it back — grounding quotes, a passage window
around a fact, or provenance for a review UI.

Two releases are involved:

- **9.1.0** added *source pointers* on librarian facts — a stored reference to the event a fact came
  from, plus its grounding-verified quote. See [OKF import & export → What round-trips](/expo-llm-wiki/guides/okf/#what-round-trips).
- **9.2.0** added the store itself: `storeSource()`, `getStoredSource()`, `listStoredSources()`,
  stored passages in `read()`, and stored text in dumps. Everything below is 9.2.0.

For the vocabulary — *Sources* as a memory layer beside facts and events — see the
[glossary](/expo-llm-wiki/reference/glossary/).

## Store text

```ts
const result = await wiki.storeSource('user-123', {
  sourceRef: 'handbook.md',
  sourceHash: sha256(text),   // 64-char hex SHA-256 of the text
  text,
});
// stored → { stored: true, sourceRef, sourceHash, charCount, passageCount, storedAt }
// refused → { stored: false, diagnostics: WikiDiagnostic[] }
```

The store cuts the text into passages and indexes them for keyword search, so `read()` can pull
windows later.

- **Refusals return, they don't throw.** A text that is too large, exceeds the store budget,
  doesn't match its hash, reuses a hash already held by another ref (stored text or live facts), or
  contains a NUL or lone surrogate comes back as
  `{ stored: false, diagnostics }`. Each diagnostic also fires on `onDiagnostic` with
  `operation: 'sourceStore'`. See [Diagnostics](/expo-llm-wiki/guides/diagnostics/#codes) for the
  five codes.
- **Throws are for invalid calls only.** A bad `sourceRef`, a `sourceHash` that isn't 64-char hex,
  or a non-string `text` throws before anything is written. A busy lock (`WikiBusyError`) throws
  too — retry later, like any other writer.
- **Re-storing the same ref and hash is a no-op** that returns the existing figures. Re-storing the
  same ref with the *same* hash but *different* text is refused as `source_store_hash_mismatch`. A
  ref with a *changed* hash replaces the old text (and its passages) in one transaction.

## Read it back

```ts
const stored = await wiki.getStoredSource('user-123', 'handbook.md');
// null, or { sourceRef, sourceHash, text, charCount, storedAt } — the text exactly as handed

const list = await wiki.listStoredSources('user-123');
// [{ sourceRef, sourceHash, charCount, passageCount, storedAt }]
```

`listSourceRefs()` puts the store and the fact rows side by side. Its `stored` field has three
states:

```ts
const refs = await wiki.listSourceRefs('user-123');
// [{ sourceRef, sourceHash, factCount, lastIngestedAt, stored }]
```

| `stored` | Meaning |
|---|---|
| `{ charCount }` | Text is stored, and its hash matches the ref's live facts' hash |
| `{ charCount, staleHash: true }` | Text is stored, but the stored text's hash differs from the live facts' hash — re-ingest happened without re-storing |
| `null` | Nothing stored for this ref |

## Read passages with `read()`

Opt in per call. The bundle gains a `sources` array alongside its facts:

```ts
const bundle = await wiki.read('user-123', 'refund policy', {
  sources: { query: 'refund window', maxPassages: 4, charBudget: 2000 },
});
bundle.sources?.[0];
// { entityId, sourceRef, sourceHash, seq, startOffset, endOffset, truncated, text }
```

- Defaults: up to **8** passages per entity (`maxPassages`), each window at most **4,000**
  UTF-16 code units (`charBudget`).
- `startOffset`/`endOffset` are UTF-16 offsets into the stored text:
  `storedText.slice(startOffset, endOffset) === text`. `truncated: true` means the window was cut
  from a larger passage.
- On a multi-entity read, passages stay **per entity** — each entity's group respects its own
  budget, and groups are never merged.
- The store has no effect on a plain `read()` without the `sources` option.

The same offsets are how you can map a fact back to its place in the document — an alternative to
re-chunking with `chunkText` ([Ingest → Reproduce chunk boundaries](/expo-llm-wiki/guides/ingest-documents/#reproduce-chunk-boundaries)),
without needing the document at read time.

## Limits

Set per-entity limits in `config.sourceStore`; both limits are refusal guards, not targets:

```ts
const wiki = createWiki(db, {
  llmProvider,
  config: {
    sourceStore: {
      maxCharsPerSource: 200_000,   // default; UTF-16 code units per document
      maxTotalChars: 5_000_000,     // default; UTF-16 code units per entity's store
    },
  },
});
```

Exceeding either cap refuses the write (`source_store_source_too_large`,
`source_store_budget_exceeded`). Nothing already stored is clipped.

## Delete and dump

- `forget(entityId, { sourceRef })` soft-deletes the ref's facts **and hard-deletes its stored
  text and passages** in the same transaction, then re-syncs the passage index. `forget` with
  `clearAll` removes the entity's whole store; a ref stored but never ingested still needs its own
  `forget({ sourceRef })`. See [Deleting data](/expo-llm-wiki/guides/deleting-data/).
- `exportDump()` embeds each entity's stored sources in the dump (`storedSources`, with the text
  and the passage offsets). `importDump()` re-cuts the passages from the text — the offsets in a
  dump are fidelity information only — and returns
  `{ skippedSources: [{ sourceRef, code }] }` for sources it refused. See
  [OKF import & export](/expo-llm-wiki/guides/okf/#what-round-trips).
