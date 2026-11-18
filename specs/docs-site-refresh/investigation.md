# Investigation — docs site vs released v9.2.0 (docs-site-refresh lane)

**Method:** read-only audit. v9.2.0 engine read via `git show v9.2.0:<path>` (throwaway
extract at /tmp/expo-llm-wiki-v920 for grepping); docs pages read from the working tree
and confirmed byte-identical to v9.2.0 (`git diff v9.2.0 -- apps/docs/src/content/docs` is
empty). No lane touched: primary checkout (PR #402's branch) and the forget-erasure
worktree left alone; build output is gitignored.

## API surface (verified at v9.2.0, packages/core/src)

- `storeSource(entityId, { sourceRef, sourceHash, text })` → `Promise<StoreSourceResult>`
  (WikiMemory.ts:1110). Invalid args throw; busy lock throws `WikiBusyError`; refusals
  return `{ stored: false, diagnostics }`.
- `getStoredSource(entityId, sourceRef)` → `Promise<StoredSource | null>` (WikiMemory.ts:1120).
- `listStoredSources(entityId)` → `Promise<StoredSourceSummary[]>` (WikiMemory.ts:1125).
- `listSourceRefs(entityId)` rows gain optional
  `stored?: { charCount: number; staleHash?: true } | null`; `sourceHash` is
  `string | null` (WikiMemory.ts:734-741, EntryRepository.ts:1436-1490). Three states:
  exact pair / `staleHash: true` / null = nothing stored.
- Read option: `ReadOptions.sources?: { query: string; maxPassages?: number (default 8);
  charBudget?: number (default 4000 UTF-16 units) }` (types.ts:433-439; defaults
  RetrievalService.ts:20-21). Surfaces as `MemoryBundle.sources?: SourcePassage[]`,
  per-entity groups, never merged (types.ts:1086-1087).
- `SourcePassage = { entityId, sourceRef, sourceHash, seq, startOffset, endOffset,
  truncated, text }` — UTF-16 offsets (types.ts:1069-1083).
- `StoreSourceResult`: `{ stored: true, sourceRef, sourceHash, charCount, passageCount,
  storedAt } | { stored: false, diagnostics }` (types.ts:1110).
- `StoredSource` (types.ts:1122), `StoredSourceSummary` (1131), `StoredSourceDump` (1140,
  dump-only, `textHash` + `passages [{seq, startOffset, endOffset}]`),
  `ImportDumpResult.skippedSources: Array<{ sourceRef, code }>` (1151),
  `MemoryDumpEntity = MemoryBundle & { storedSources?: StoredSourceDump[] }` (1158).
- `importDump` returns `Promise<ImportDumpResult>` (WikiMemory.ts:1058) — docs say
  `Promise<void>`.
- Config: `WikiConfig.sourceStore?: { maxCharsPerSource?: number; maxTotalChars?: number }`
  (types.ts:295); defaults 200,000 / 5,000,000 (SourceStoreService.ts:10-11) — owner-gated
  refusal guards, not targets.
- Diagnostics (types.ts:893-899), operation `sourceStore` added to the union (types.ts:903):
  `source_store_source_too_large`, `source_store_budget_exceeded`,
  `source_store_hash_mismatch`, `source_store_duplicate_hash`,
  `source_store_text_not_storable` (emitted SourceStoreService.ts:35-38 with
  `detail.sourceRef`).
- Dump export embeds per-entity `storedSources` (ImportExportService.ts:65-66); import
  re-cuts passages and re-derives `text_hash` from text, ignores dump passages, returns
  refused sources in `skippedSources` (ImportExportService.ts:83-95).
- `forget()` deletes stored source text and syncs the passage index for the entity
  (WikiMemory.ts:417, 1098-1101); dryRun skips it. `importDump` re-indexes passages
  (WikiMemory.ts:1062).
- All of the above lives in the single `@equationalapplications/core-llm-wiki` package
  (`packages/core`); nothing in `packages/okf`.

## Coverage confirmation

**No docs page covers the source store.** `grep -rn
'storeSource|getStoredSource|listStoredSources|skippedSources|sourceStore|maxCharsPerSource|maxTotalChars|charBudget|maxPassages|SourcePassage|passage'`
across `apps/docs/src/content/docs` returns exactly one hit —
guides/ingest-documents.md:93, prose about the old `chunkText` recipe. No page mentions
`source_documents`, `source_passages`, the `stored` flag, `storedSources`, or any
`source_store_*` code.

## Gaps (file:line, wrong claim → v9.2.0 truth)

- **reference/wiki-memory.md** — (a) L35 `importDump(dump, { merge? }?)` |
  `Promise<void>` → `Promise<ImportDumpResult>` with `skippedSources`; (b) L87
  `listSourceRefs` row `{ sourceRef, sourceHash, factCount, lastIngestedAt }[]` → adds
  optional `stored?: { charCount, staleHash? } | null`, `sourceHash: string | null`; (c)
  no `storeSource`/`getStoredSource`/`listStoredSources` rows, no `sources` read option;
  (d) L116 forget row silent on stored-text deletion + ref drop.
- **reference/types.md** — (a) L54-69 `MemoryBundle` missing `sources?`; (b) L99-110
  `ReadOptions` missing `sources?`; (c) missing types: `SourcePassage`,
  `StoreSourceResult`, `StoredSource`, `StoredSourceSummary`, `StoredSourceDump`,
  `ImportDumpResult`/`skippedSources`, `MemoryDumpEntity.storedSources`; (d) L72
  `librarian_watermark` "the source store's librarian position" — collides with the new
  feature name; engine adds "(Not the source text store)" note (types.ts:1094).
- **reference/configuration.md** — L39-100 `WikiConfig` table missing
  `config.sourceStore`.
- **reference/errors.md** — no wrong claims; add one-line pointer (storeSource refusals
  return, don't throw; only busy lock throws).
- **guides/diagnostics.md** — codes table L41-62 missing the five `source_store_*` codes
  (operation `sourceStore`).
- **guides/deleting-data.md** — missing the forget-ref-drop behavior: a real forget also
  deletes the entity's stored source text for affected refs and syncs the passage index
  after commit; `listSourceRefs` ref disappears after forget. (Plus inherited
  erasure-content obligation — see spec §3.)
- **guides/ingest-documents.md** — L91-103 chunk-boundary recipe predates the passage
  index; `ReadOptions.sources` gives offsets directly; `storeSource` is the way to keep
  the text.
- **guides/okf.md** — L18-43 dump round-trip: `importDump` return changed
  (`skippedSources`); dump entities may carry `storedSources`, import re-cuts passages.
  L122-126 `source_pointer` prose (v9.1) still accurate.
- **concepts/trust-and-provenance.md** — L36-44 grounding quotes; never names the source
  store as the retained-text mechanism (omission).
- **concepts/how-it-works.md** — L8, L46 "three kinds of records" → four surfaces
  (facts/tasks/events + source documents/passages, migration v17).

## Verified correct — do not touch

guides/maintenance.md, guides/temporal-facts.md, guides/graphrag.mdx,
guides/drafts-and-grounding.md, guides/prompts.md, guides/multi-entity.md,
guides/vector-ranker.md, guides/tune-retrieval.md, reference/types.md ingest-result
section (L113-123), packages/* pages, start pages, index.mdx,
recipes/markdown-knowledge-base.md (silent, not stale).

## Build + layout

- `astro build` in apps/docs: SUCCESS, 53 pages in 10.36 s (+pagefind ~0.3 s); tree stays
  clean (dist/ gitignored).
- Sidebar: six autogen sections; new guide → `guides/source-store.md` with a
  `sidebar.order` between existing guides (deleting-data sits low, order 16;
  ingest-documents is 3); glossary → `reference/glossary.md`, order after types/errors.
  Reference ordering uses `sidebar.order`; Guides/Concepts are pure autogenerate.
- Internal links use `/expo-llm-wiki/<section>/<page>/` (base + trailingSlash).

## Private-repo scrub guard

`SynapseTree` appears 21 times across 6 docs files (index.mdx, start/introduction.md,
start/ecosystem.mdx, recipes/coding-agent-mcp.mdx, guides/serverless-hosting.md,
packages/mcp-server.md). All are issue #405's lane. This PR touches none of them and adds
zero new mentions.

## Inherited-obligation sources (branch `specs/forget-erasure`)

- `specs/forget-erasure/spec.md` §6 (docs) + §8, plan T9 — read 2026-11-17; erasure
  recipe requirements transcribed into spec §3 of this lane.
- Erase diagnostics: four codes verbatim in `packages/core/src/utils/diagnostics.ts` on
  the branch (`erase_secure_delete_off` error, `erase_entity_skipped` warn,
  `erase_registry_sweep_skipped` info, `erase_retired_vtab_undroppable` warn); last two
  names implementation-introduced, may rename under dual review → publish-time re-check.
- Errata: `PRAGMA secure_delete=FULL` is not valid SQLite (silently reads back 0); full
  zeroing = `ON` (reads back 1). Folded upstream in `cc696a59`. Docs must never publish
  "FULL" as a pragma value.
