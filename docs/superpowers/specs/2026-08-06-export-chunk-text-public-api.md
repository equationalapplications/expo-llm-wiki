# Spec: Export `chunkText` / `safeSlice` from the Public API

**Date:** 2026-08-06
**Status:** Implemented
**Packages:** `core-llm-wiki` (primary), `expo-llm-wiki` (re-export, no code change needed)
**Issue:** [equationalapplications/expo-llm-wiki#70](https://github.com/equationalapplications/expo-llm-wiki/issues/70)
**PR:** [equationalapplications/expo-llm-wiki#71](https://github.com/equationalapplications/expo-llm-wiki/pull/71)

---

## Problem

`chunkText` and its helper `safeSlice` (`packages/core/src/utils/pure.ts:102` and `:64`)
implement the document-chunking algorithm `IngestionService.ingestDocument` uses to split
text before embedding. Neither is exported from `packages/core/src/index.ts`, so they are
invisible from the package's public entry point (`dist/index.d.ts`) — `expo-llm-wiki`
re-exports everything from `core-llm-wiki` via `export *`, so this is a single-package fix.

A downstream consumer (aws-cloud-agent's cortex judge, spec
`2026-08-05-cortex-judge-design.md`) needs to re-chunk a source document at read time and
rank the resulting chunks against a fact's stored embedding, to recover roughly the passage
a fact was extracted from. That only works if the re-chunking matches what the library did
at ingest time. Lacking a public export, the consumer ported the algorithm verbatim into its
own codebase (`src/judge/chunk.ts`, copied from `chunk-W53E3I44.mjs` lines 996–1064). That
copy will silently drift from the library's actual behavior if `chunkText` ever changes,
degrading passage recovery without any error.

The consumer also needs to know the default `maxChunkLength`/`chunkOverlap` values ingest
uses when a host app doesn't override them (`IngestionService.ts:49-50`, currently the
literals `12000` and `400`), so it can reproduce default-config chunking without guessing.

## Solution

Export `chunkText`, `safeSlice`, and the ingest default constants from
`packages/core/src/index.ts`. No new code, no behavior change — these are pure functions
that already exist and are already used internally; this only changes what's visible from
the package boundary.

As implemented, the constants are declared at their point of use in `IngestionService.ts`
(not in `index.ts` as originally sketched below) and re-exported from `index.ts`:

```ts
// packages/core/src/services/IngestionService.ts
export const DEFAULT_MAX_CHUNK_LENGTH = 12000;
export const DEFAULT_CHUNK_OVERLAP = 400;

// packages/core/src/index.ts
export { chunkText, safeSlice } from './utils/pure';
export { DEFAULT_MAX_CHUNK_LENGTH, DEFAULT_CHUNK_OVERLAP } from './services/IngestionService';
```

This keeps the constant and the ingest-time default as the same binding rather than two
values kept in sync by convention.

All three literal sites in `IngestionService.ingestDocument` — not just `:49-50` — now
reference the constants: the `maxChunkLength`/`rawOverlap` defaults and the sanitizer
fallback used when a caller-supplied `chunkOverlap` is non-finite or negative.

`packages/expo/src/index.ts` requires no change — it already does
`export * from '@equationalapplications/core-llm-wiki'`, so the new exports flow through
automatically.

## Design Decisions

### 1. Export location: `core-llm-wiki`, not `expo-llm-wiki`

`chunkText`/`safeSlice` are pure, platform-independent string functions with no dependency
on `expo-sqlite` or any Expo API. They belong in `core-llm-wiki` alongside the other pure
utilities already exported there (`parseEmbedding`, `formatContext`, etc.). `expo-llm-wiki`
picks them up for free via its existing `export *`.

### 2. Export default chunking constants, not the overlap-clamp logic

`IngestionService.ingestDocument` also clamps a caller-supplied `chunkOverlap` via
`Math.min(rawOverlap, maxChunkLength - 1)` (`IngestionService.ts:51-54`). That clamp only
matters when a caller overrides `chunkOverlap` to a value close to (or exceeding)
`maxChunkLength`. This issue's motivating use case is reproducing *default-config* ingest
chunking, where the clamp is a no-op (`400 < 12000 - 1`). Exporting the clamp function is
out of scope; a future issue can add it if a consumer needs to replicate custom-config
ingest behavior exactly.

### 3. Signatures are unchanged

The existing signatures already match the issue's ask exactly:

```ts
function chunkText(
  input: string,
  maxChunkLength: number,
  overlap: number
): { chunks: string[]; truncated: boolean }

function safeSlice(value: string, start: number, end?: number): string
```

No signature changes are needed — this is a visibility change only.

## Testing

Add `packages/core/__tests__/publicExports.test.ts`, importing from `../src/index` (the
package entry point, not a deep internal path), asserting:

- `chunkText` and `safeSlice` are exported and produce output identical to calling the
  internal `utils/pure` implementations directly (i.e., the export is the same function,
  not a copy).
- `DEFAULT_MAX_CHUNK_LENGTH === 12000` and `DEFAULT_CHUNK_OVERLAP === 400`.

Existing behavioral coverage of the chunking algorithm itself
(`packages/core/__tests__/chunkText.test.ts`, via `WikiMemory.__testables`) is unaffected
and continues to be the source of truth for chunking edge cases.

As implemented, `packages/core/README.md` also gained a "Chunking Utilities" section
documenting `chunkText`/`safeSlice`/the two constants for external consumers, including a
note that `chunkText`'s per-chunk overlap is a maximum (a chunk repeats fewer than `overlap`
characters when the previous chunk was shorter than that), and that `ingestDocument`'s
overlap-clamp (Decision 2) is evaluated on every call, including when only `maxChunkLength`
is customized — it's a no-op for the shipped defaults, but reduces the effective overlap to
`maxChunkLength - 1` whenever the resolved overlap (default or caller-supplied) would
otherwise be too large.

## Minor Considerations

### Constant naming

Checked existing exports in `packages/core/src/index.ts`: none of the current top-level
exports use a package-wide prefix (`formatContext`, `parseEmbedding`, `validateManifest`,
etc. are all bare names); the one prefixed constant, `ONTOLOGY_BACKFILL_SYSTEM_PROMPT`, is
prefixed with its own domain term, not a package-wide tag. `DEFAULT_MAX_CHUNK_LENGTH` and
`DEFAULT_CHUNK_OVERLAP` also already match the field names on `WikiOptions.config`
(`maxChunkLength`, `chunkOverlap`), so keeping the unprefixed names stays consistent with
both established conventions and makes the connection to the config surface obvious.
Decision: keep `DEFAULT_MAX_CHUNK_LENGTH` / `DEFAULT_CHUNK_OVERLAP` as specified — no
prefix change.

### JSDoc

`chunkText`, `safeSlice`, and the two new constants are moving from internal-only to public
API surface consumed by at least one external package (aws-cloud-agent). Add JSDoc comments
to all four at their definition sites (`packages/core/src/utils/pure.ts` for the functions;
`packages/core/src/utils/chunkingDefaults.ts` for the constants — relocated there from
`IngestionService.ts` so importing them doesn't pull in `IngestionService`'s runtime import
graph) covering: what each does, parameter/return semantics for the functions, and — for the
constants — that they are the values `IngestionService` uses when a caller doesn't override
`maxChunkLength`/`chunkOverlap`. This is documentation only; no behavior or signature change.

## Non-Goals

- Changing the chunking algorithm's behavior.
- Exporting the overlap-clamping helper from `IngestionService` (see Decision 2).
- Adding new configuration surface for chunking (existing `WikiOptions.config.maxChunkLength`
  / `chunkOverlap` are untouched).
- Persisting the actual `maxChunkLength`/`chunkOverlap` used per-fact at ingest time (would
  let a consumer reproduce chunking under custom config, not just defaults) — out of scope
  for this issue; the ask is limited to exporting the existing pure functions.
