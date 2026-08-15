# Spec: Ingest Parse Resilience

**Date:** 2026-08-15
**Status:** Draft (Pending Review)
**Approach:** A — strict + repair + JSON5 dep, partial per-chunk commit, prompt tightening

Closes issue #92.

---

## Problem

`parseJsonResponse` (`packages/core/src/utils/pure.ts:3`) extracts JSON from an LLM ingest response with a hand-rolled brace-matching scanner:

```js
if (ch === '"') { inString = !inString; continue; }
```

The scanner has zero tolerance for a single unescaped `"` inside the model's raw output. If the model emits one literal `"` where valid JSON requires `\"`, every subsequent `"` in the response flips string-tracking state the wrong way, the depth counter desyncs, and `JSON.parse` on the mis-sliced substring throws — a hard failure with no recovery attempt.

This failure mode is reproducible in the wild: real documents contain quoted example prose (e.g. a spec with `("I told you, I hate cilantro")` as a worked example). Asked to copy that verbatim into a JSON string body, the model must re-escape the embedded quotes as `\"` — and in practice models (observed: `zai.glm-4.7-flash` via Bedrock) sometimes don't.

The blast radius is bigger than "one bad chunk." `IngestionService.ingestDocument` (packages/core/src/services/IngestionService.ts:40) chunks a document and extracts each chunk independently via `withConcurrency`, then calls `parseJsonResponse` per chunk result. The `withConcurrency` helper (`packages/core/src/utils/pure.ts:213`) is fail-fast: the first `parseJsonResponse` throw propagates out of the per-chunk task, the helper rejects, and chunk results are never aggregated. **One malformed chunk discards the facts extracted from every sibling chunk of the same document**, not just its own. A document can silently contribute zero facts to the graph, forever — every retry re-derives the same chunking and the same prompt, so a deterministic failure never self-heals. The host (`aws-cloud-agent`) currently has no visibility into *which* chunk failed or *why* beyond the raw `SyntaxError` message — it only knows the whole document failed.

`parseJsonResponse` has four call sites today (`IngestionService.ts:115` plus three in `MaintenanceService.ts` at lines 453, 660, 863). All four inherit the same brittleness; three of them run one LLM call at a time so a single throw is already surfaced, but the parser is the underlying defect everywhere.

---

## Goals

1. **Layered parser recovery.** `parseJsonResponse<T>(text)` returns a `T` even when the LLM emits one or more bare quote characters inside string bodies. Layered recovery: strict `JSON.parse` → targeted bare-quote re-escape on the discovered slice → re-scan and re-escape against the raw `text` (handles the case where `findJsonSlice` itself truncated early) → JSON5 permissive parse. Throws only when all tiers fail.
2. **Partial per-chunk commit.** A `parseJsonResponse` or `llmProvider.generateText` failure on one chunk does not void siblings. Sibling facts commit; the host is told which chunks failed and why.
3. **Typed diagnostics.** A new `WikiParseError` carries `{ tier, position, slice }`. A new `WikiIngestEmptyError` is thrown when every chunk of a document failed (so a silent zero-fact ingest can never happen).
4. **Prompt-tightening for the verbatim-quote tension.** `INGEST_SYSTEM_PROMPT` and `ONTOLOGY_BACKFILL_SYSTEM_PROMPT` explicitly call out JSON-escape discipline for source content and echoed titles.
5. **No silent regression.** Hosts that destructure `{ truncated, chunks }` on `IngestDocumentResult` see no behavior change for the happy path. All four `parseJsonResponse` callers benefit transparently from the layered parser.

## Non-Goals

- LLM-side retry ("please re-emit valid JSON" second prompt) — outside this spec's scope; could be a follow-up if metrics show partial commits are still sparse.
- Persisting raw LLM responses (privacy-sensitive; raw output may contain document content).
- A "strict-mode" opt-in flag — repairs are always-on; no API change to `parseJsonResponse`.
- New configuration knobs. Everything behavior-changing is on by default; nothing is wired through `WikiOptions`.
- Reparability of `MaintenanceService` partial-commit semantics — those three call sites run one LLM call at a time, so a throw there is already a known surfaced error. Out of scope by YAGNI.

---

## Design

### 1. Layered parser in `parseJsonResponse`

Single function refactor in `packages/core/src/utils/pure.ts`. Same public signature: `export function parseJsonResponse<T>(text: string): T`.

Layered recovery:

```
strict JSON.parse(slice)
   │ fail
   ▼
tryRepairBareQuotes(slice)         // tier 2a: re-escape bare quotes in slice
   │ fail (or returns null)
   ▼
recoverFromRawText(text, start)    // tier 2b: re-scan raw text, find
   │ fail                          //            longest parsable substring
   ▼
JSON5.parse(slice)                 // tier 3: permissive fallback
   │ fail
   ▼
throw WikiParseError(...)
```

**Tier 2a — `tryRepairBareQuotes(slice: string): string | null`.** Single forward pass over the slice. Tracks `inString` and `escape` exactly as the existing scanner. When `inString === true` and a `"` is encountered whose next character is not a structural delimiter (`,`, `}`, `]`, `:`, whitespace, EOF), insert `\` before it and stay in-string (do NOT toggle `inString`). Returns the modified slice, or `null` if no bare quotes were found. O(n) over the slice.

**Tier 2b — `recoverFromRawText(text: string, start: number): string | null`.** When Tier 2a fails (or `findJsonSlice` itself was truncated by the same `inString`-mis-toggling that produced the bare quote — the slice we have is bad data), re-walk the original text from `start`. The recovery walker treats any `"` inside a contextually-opened string as content (never structural), tracks candidate slice endpoints at every depth==0 close, and runs `JSON.parse` on candidates in length order, returning the first that parses. **Bounded retries:** at most `MAX_RECOVERY_CANDIDATES = 5` candidates (largest first); `null` if none parse within the bound.

**Tier 3 — `JSON5.parse(slice)`.** Delegates to the npm `json5` package (MIT, zero runtime deps). Covers trailing commas, comments, single-quoted strings, multi-line literals — categories of LLM JSON drift beyond bare quotes. Only runs when tiers 1, 2a, and 2b all fail.

**Tier 1 — strict `JSON.parse(slice)`.** Unchanged from today.

**`WikiParseError` shape** (`packages/core/src/types.ts`):

```ts
export class WikiParseError extends Error {
  readonly tier: 'strict' | 'repair' | 'json5' | 'all';
  readonly position: number | null;
  readonly slice: string;
  constructor(message: string, opts: { tier: WikiParseError['tier']; position?: number | null; slice?: string }) {
    super(message);
    this.name = 'WikiParseError';
    this.tier = opts.tier;
    this.position = opts.position ?? null;
    this.slice = opts.slice ?? '';
  }
}
```

Note: `tryRepairBareQuotes` and `recoverFromRawText` must operate on the **whole slice/text** the parser ends up handing to `JSON.parse`, not on arbitrary substrings of the response. The spec asserts this invariant.

### 2. Per-chunk partial commit in `IngestionService.ingestDocument`

The per-chunk task inside the existing `withConcurrency(...)` block (lines 106-124) is wrapped in a `try`/`catch`. `withConcurrency` itself is unchanged — its public contract (`Promise.allSettled` → throw on first error) stays intact for any future callers.

```ts
type ChunkResult =
  | { status: 'ok';      facts: ExtractedFact[]; ontology_updates?: OntologyUpdates }
  | { status: 'failed';  error: ChunkFailure };

interface ChunkFailure {
  chunkIndex: number;
  sourceRef: string;        // captured from line 53; closure scope
  source: 'parse' | 'llm' | 'ontologyContext';
  tier?: 'strict' | 'repair' | 'json5' | 'all';   // only when source === 'parse'
  position: number | null;
  message: string;
}
```

The `try` block covers the **entire** per-chunk body: `buildIngestPrompt`, `llmProvider.generateText`, `parseJsonResponse`. A network/rate-limit error from `generateText` (e.g. Bedrock `ThrottlingException`) is caught alongside a `WikiParseError` and tagged `source: 'llm'`; the host can distinguish the two by inspecting `parseFailures[*].source`.

`console.warn` fires **exactly once per failed chunk** in a fixed format:
```
[WikiMemory] ingest chunk 3/7 parse failed (sourceRef=doc://spec, tier=json5): <message>
[WikiMemory] ingest chunk 5/7 llm failed (sourceRef=doc://spec): <message>
```

The raw LLM response body is **never** included in the warn line — it may contain document content. Tests assert this.

### 3. Aggregation & persistence

- Replace the dedup loop at lines 126-138 with: skip `status === 'failed'` slots; only iterate `status === 'ok'` slots through `seen`/dedup exactly as today.
- Per-chunk `ontology_updates` merge at line 190 only fires for `status === 'ok'` slots — failed chunks contribute zero ontology updates (preserves existing rule that `mergeEmergentUpdates` only fires when a chunk extracted ontologically meaningful work).
- Filtered `orderedChunkFacts` is fed to `upsertGraphCore` with the same shape and same downstream code path. **Zero change to the persistence layer.**
- `entryRepo.upsert` is called only for facts from successful chunks; embedding + cache-eviction paths are unchanged.

### 4. Return shape

```ts
type IngestDocumentResult = {
  truncated: boolean;
  chunks: number;
  ingestedChunks: number;     // status === 'ok' count
  failedChunks: number;       // status === 'failed' count
  duplicateOf?: string;
  parseFailures?: ChunkFailure[];   // present iff failedChunks > 0
};
```

`parseFailures` is included only when at least one chunk failed. Hosts that don't care can ignore it.

**Backward-compat:** Destructure-by-truncated-or-chunks is unaffected. Pattern-matching the entire return shape picks up two new fields and the new optional `parseFailures`. README release notes for the next minor will flag this as a non-breaking widening under typical usage but a strict-equality break for `exactOptionalPropertyTypes` users.

### 5. All-chunks-failed terminal state

When `failedChunks === chunks.length`, `ingestDocument` **throws**:

```ts
export class WikiIngestEmptyError extends Error {
  readonly parseFailures: ChunkFailure[];
  readonly sourceRef: string;
  readonly chunks: number;
}
```

A silent zero-fact ingest is a worse regression than a typed throw — matches existing host semantics (`aws-cloud-agent` Writer Lambda today sees `ingestDocument` throw on any failure).

### 6. Prompt tightening (text-only)

**`INGEST_SYSTEM_PROMPT`** (`packages/core/src/prompts.ts:18`):

```diff
-Extract verbatim factual content. Do not return markdown, just raw JSON.`;
+Extract verbatim factual content. JSON escaping rules: every literal " character in the source must be escaped as \\" inside any JSON string body, and every literal newline as \\n. Source prose containing quotes (e.g. a worked example with "...") must still be reproduced exactly — re-escape, do not omit. Do not return markdown, just raw JSON.`;
```

**`ONTOLOGY_BACKFILL_SYSTEM_PROMPT`** (`packages/core/src/prompts.ts:25`):

The verbatim-prose tension is milder here — there is no source document, but `target_title` references an existing fact's title verbatim, and that title may contain JSON escape sequences from prior extracts that the model must preserve when echoing them into its output.

```diff
-If no manifest type fits a fact, omit that fact from "classifications" entirely — do not guess.
-Do not return markdown, just raw JSON.`;
+If no manifest type fits a fact, omit that fact from "classifications" entirely — do not guess.
+When echoing an existing fact's title verbatim into "target_title", preserve every JSON escape sequence (\\", \\n, \\\\, \\/) exactly as it appeared in the input body — do not strip backslashes, do not add unescaped quotes. Do not return markdown, just raw JSON.`;
```

`LIBRARIAN_SYSTEM_PROMPT` and `HEAL_SYSTEM_PROMPT` are **unchanged** — they process already-stored facts (no verbatim-prose task); their output schemas aren't the failure mode of the issue.

---

## Files Touched

| File | Change |
|---|---|
| `packages/core/src/utils/pure.ts` | Refactor `parseJsonResponse` into layered recovery; add `tryRepairBareQuotes` and `recoverFromRawText` helpers. |
| `packages/core/src/types.ts` | Add `WikiParseError`, `WikiIngestEmptyError`, `ChunkFailure`. |
| `packages/core/src/services/IngestionService.ts` | Per-chunk try/catch; aggregation skip; population of return-shape new fields; throw `WikiIngestEmptyError`. |
| `packages/core/src/prompts.ts` | Two-prompt text changes (above). |
| `packages/core/package.json` | Add `json5` dependency (MIT, zero runtime deps). |
| `packages/core/__tests__/parseJsonResponse.test.ts` | New: 7 cases (see Testing). |
| `packages/core/__tests__/ingest.test.ts` | Extend: 7 per-chunk-resilience cases. |
| `packages/core/__tests__/services/PromptService.test.ts` (or new `prompts.test.ts`) | Snapshot for the two new sentences. |
| `packages/integration-llm-wiki/__tests__/ingestParseResilience.test.ts` | New: canned-LLM-output integration test covering the issue's repro pattern. |
| `README.md` (each published package's) | Release-note for the new return-shape fields under non-breaking widening. |

---

## Testing

### Unit — `packages/core/__tests__/parseJsonResponse.test.ts` (new)

| Test | Input | Assertion |
|---|---|---|
| strict happy path | `{"facts":[]}` | Returns `{}`, no warning |
| array happy path | `[1,2,3]` | Returns `[1,2,3]` |
| tier 2a repairs bare quote in slice | `{"body":"she said "hi""}` | Tier 2a finds the bare `"`, re-escapes, `JSON.parse` succeeds |
| tier 2a+b fail, tier 3 JSON5 succeeds | `{"body":"He said "hello"," world"}` | Tier 3 accepts, returns object |
| all tiers fail, throws typed error | `{` (truncated mid-key) | `WikiParseError` thrown, `tier: 'all'`, `position` non-null, `slice` populated |
| slice desync recovers from raw text | `{ "body": "He said "x", "title": "ok" },` | Tier 2b recovers via raw-text re-scan |
| delimiter-ambiguity JSON5 path | `"description": "He said "yes""}` | Tier 3 returns object cleanly |

### Unit — extend `packages/core/__tests__/ingest.test.ts`

| Test | Mock setup | Assertion |
|---|---|---|
| one chunk parse-fails, siblings commit | One bad-quote response, rest good | `ingestedChunks === siblings`, `failedChunks: 1`, `parseFailures[0].source === 'parse'`, sibling facts reach `entryRepo.upsert` |
| one chunk LLM-fails, siblings commit | `generateText` throws on one chunkIndex | `failedChunks: 1`, `parseFailures[0].source === 'llm'` |
| all chunks fail | Every response malformed | `WikiIngestEmptyError` thrown with full `parseFailures` |
| mixed: 1 parse + 2 LLM + 4 ok | Per-index matrix | `ingestedChunks: 4, failedChunks: 3`, sources correct per row |
| dedup preserved | Two chunks emit same title | Only one `entryRepo.upsert` call with that title |
| console.warn fires once per failure | Mocked warn | Called exactly `failedChunks` times |
| raw response body not logged | Capture warn args | Args do not include response text |

### Unit — extend `packages/core/__tests__/services/PromptService.test.ts`

```ts
expect(INGEST_SYSTEM_PROMPT).toContain('re-escape');
expect(INGEST_SYSTEM_PROMPT).toContain('\\n');
expect(ONTOLOGY_BACKFILL_SYSTEM_PROMPT).toContain('preserve every JSON escape');
```

### Integration — `packages/integration-llm-wiki/__tests__/ingestParseResilience.test.ts` (new)

- **Repro subset**: 5 canned responses, one of which is the verbatim-quote case from issue #92. Verify `parseFailures[0].source === 'parse'`, recovery tier recorded, `ingestedChunks === 4`.
- **All-fail subset**: 5 canned responses, all malformed. Verify `WikiIngestEmptyError` thrown.

### What we don't test

- Real LLM calls against `zai.glm-4.7-flash` via Bedrock — out of bandwidth, requires creds and is non-deterministic.
- Performance benchmarks for `tryRepairBareQuotes` / `JSON5.parse` — single-digit KB strings, not worth benchmarking unless a regression is reported.

---

## Risk & Rollout

- **Behavioral risk**: A previously-thrown `SyntaxError` from `parseJsonResponse` is replaced by a successful parse in some cases. Downstream code (`validateFact` filter, `mergeEmergentUpdates`) still gates on `facts`/`ontology_updates` shape and so cannot accept invalid data. Net confidence: high — the worst case is "wrong facts ingested," which is the same risk class as any LLM extraction (already accepted).
- **Dependency risk**: `json5` is MIT-licensed, zero runtime deps, ~30 KB unminified, widely audited. License compatibility with the existing MIT codebase is satisfied.
- **Compatibility surface**: `parseJsonResponse` signature unchanged; three of four callers see no behavior change in the happy path (which still hits Tier 1). Only `IngestionService.ingestDocument`'s return shape widens (additive).
- **Rollout**: Released as a patch on `@equationalapplications/core-llm-wiki` and the workspace root (`expo-llm-wiki`), bumping `5.4.0` → `5.4.1`. README release notes call out: (a) the new partial-commit behavior; (b) the new return-shape fields; (c) the new error types `WikiParseError` and `WikiIngestEmptyError`.

---

## Open Questions

None at design completion. All decisions resolved during brainstorming:
- **Scope**: All three tiers (parser, aggregator, prompts).
- **Repair strategy**: Layered strict → repair (slice) → repair (raw text) → JSON5 → throw.
- **Failure surface**: Per-chunk try/catch + warn + return-shape counter + `parseFailures[]`.
- **Repair mode**: Always-on (no API change).
- **Approach**: A (json5 dep).
- **LLM error scope**: Catch all per-chunk errors; tag by source.

