# Spec: Ingest Parse Resilience

**Date:** 2026-08-15 (revised)
**Status:** Implemented (closes issue #92 — 7 commits on branch `docs/spec-revise-ingest-parse-resilience`, 1024/1024 core tests + 41/41 integration tests green as of 2026-08-15)
**Approach:** A revised — strict + single container-aware repair pass on raw text, partial per-chunk commit with retry semantics, prompt tightening

Closes issue #92.

---

## Problem

`parseJsonResponse` (`packages/core/src/utils/pure.ts:3`) extracts JSON from an LLM ingest response with a hand-rolled brace-matching scanner:

```js
if (ch === '"') { inString = !inString; continue; }
```

The scanner has zero tolerance for a single unescaped `"` inside the model's raw output. If the model emits one literal `"` where valid JSON requires `\"`, every subsequent `"` in the response flips string-tracking state the wrong way, the depth counter desyncs, and `JSON.parse` on the mis-sliced substring throws — a hard failure with no recovery attempt.

This failure mode is reproducible in the wild: real documents contain quoted example prose (e.g. a spec with `("I told you, I hate cilantro")` as a worked example). Asked to copy that verbatim into a JSON string body, the model must re-escape the embedded quotes as `\"` — and in practice models (observed: `zai.glm-4.7-flash` via Bedrock) sometimes don't.

The blast radius is bigger than "one bad chunk." `IngestionService.ingestDocument` (`packages/core/src/services/IngestionService.ts:40`) chunks a document and extracts each chunk independently via `withConcurrency`, then calls `parseJsonResponse` per chunk result. The `withConcurrency` helper (`packages/core/src/utils/pure.ts:213`) is fail-fast: the first `parseJsonResponse` throw propagates out of the per-chunk task, the helper rejects, and chunk results are never aggregated. **One malformed chunk discards the facts extracted from every sibling chunk of the same document**, not just its own. A document can silently contribute zero facts to the graph, forever — every retry re-derives the same chunking and the same prompt, so a deterministic failure never self-heals. The host (`aws-cloud-agent`) currently has no visibility into *which* chunk failed or *why* beyond the raw `SyntaxError` message — it only knows the whole document failed.

`parseJsonResponse` has four call sites today (`IngestionService.ts:115` plus three in `MaintenanceService.ts` at lines 453, 660, 863). All four inherit the same brittleness; three of them run one LLM call at a time so a single throw is already surfaced, but the parser is the underlying defect everywhere.

---

## Goals

1. **Container-aware parser recovery.** `parseJsonResponse<T>(text)` returns a `T` even when the LLM emits one or more bare quote characters inside string bodies. Single repair pass over the raw text from `start` (not over the existing scanner's slice — see §1.3) with a container-context stack that distinguishes object-key/value position from array-element position. Throws `WikiParseError` only when repair yields no parsable candidate.
2. **Partial per-chunk commit with retry semantics.** A `parseJsonResponse` or `llmProvider.generateText` failure on one chunk does not void siblings. Sibling facts commit; the host is told which chunks failed and why. **On partial failure, the document's `(entity, sourceHash) → sourceRef` ownership is NOT recorded, so `hasChanged` returns `true` on every subsequent run and the failed chunks are retried.** When all chunks succeed, normal supersession and ownership recording proceed.
3. **Typed diagnostics.** A new `WikiParseError` carries `{ tier, position, slice }`. A new `WikiIngestEmptyError` is thrown when every chunk of a document failed (so a silent zero-fact ingest can never happen). `ChunkFailure.source: 'ontologyContext'` is **reserved but never produced** by the per-chunk catch — `buildPromptContext` failures propagate as DB-systemic errors (see §3).
4. **Prompt-tightening for the verbatim-quote tension.** `INGEST_SYSTEM_PROMPT` and `ONTOLOGY_BACKFILL_SYSTEM_PROMPT` explicitly call out JSON-escape discipline for source content and echoed titles.
5. **No silent regression.** Hosts that destructure `{ truncated, chunks }` on `IngestDocumentResult` see no behavior change for the happy path. All four `parseJsonResponse` callers benefit transparently from the container-aware repair.

## Non-Goals

- LLM-side retry ("please re-emit valid JSON" second prompt) — outside this spec's scope; could be a follow-up if metrics show partial commits are still sparse.
- Persisting raw LLM responses (privacy-sensitive; raw output may contain document content).
- A "strict-mode" opt-in flag — repairs are always-on; no API change to `parseJsonResponse`.
- New configuration knobs. Everything behavior-changing is on by default; nothing is wired through `WikiOptions`.
- Reparability of `MaintenanceService` partial-commit semantics — those three call sites run one LLM call at a time, so a throw there is already a known surfaced error. Out of scope by YAGNI.
- A new dependency. The earlier draft listed `json5` as Tier 3; it was removed during revision (see §1.4).

---

## Design

### 1. Container-aware repair pass in `parseJsonResponse`

Single function refactor in `packages/core/src/utils/pure.ts`. Same public signature: `export function parseJsonResponse<T>(text: string): T`.

Recovery flow:

```
strict JSON.parse(slice)              // tier 1: unchanged
   │ fail
   ▼
containerAwareRepair(text, start)     // tier 2: re-scan raw text from `start`
   │ JSON.parse(candidate)
   │ fail (or no candidate)
   ▼
throw WikiParseError(...)
```

#### 1.1 What `slice` and `start` are

The existing scanner (`pure.ts:3-45`) finds the first `{` or `[` and walks depth until depth returns to 0, producing `slice = text.slice(start, end + 1)`. The bug is that the scanner's `inString` toggles on every `"`, so a bare quote inside a string mis-tracks state and produces either a truncated slice (early exit at a false positive `depth === 0`) or no slice at all (`end === -1`).

For tier 1 we keep the existing scanner — it is correct whenever the input has no bare quotes. We only invoke tier 2 when tier 1 throws.

#### 1.2 What tier 2 does differently

Tier 2 does **not** reuse the scanner's slice. It re-walks the raw text from `start` (the index of the first `{` or `[`) with a walker that:

- Tracks `inString`, `escape`, **and a container-context stack** (`'object' | 'array'`).
- For every `"`, classifies it as **structural** (open or close a string) or **content** (needs `\` prefix) using a peek-ahead rule:
  - If `!inString`: it's an opening quote; push `inString = true`. (No escape; an opening quote is always structural.)
  - If `inString`:
    - Skip whitespace ahead.
    - If the next non-whitespace character is one of `,`, `}`, `]`, `:`, or `"` (followed by `:`), the quote is **closing** → pop `inString = false`.
    - Otherwise the quote is **content** → insert `\` before it and stay `inString = true`.

The container stack is pushed on `{` or `[`, popped on `}` or `]`. It is consulted only to disambiguate the peek-ahead rule in nested positions; the walker itself is the same code for objects and arrays. An array element position does not expect a closing quote before `,` or `]` to be ambiguous — the same peek-ahead rule works because in an array the next structural token after a value is `,` or `]` and both are in the closing-quote set.

The walker produces a stream of candidate substrings by recording every position at which the top of the container stack returns to empty (i.e., a balanced `{}` or `[]` ends). Each candidate is fed to `JSON.parse` in **largest-first** order (the first balanced span is the outermost; we stop at the first parse success).

**Bounded retries:** at most `MAX_REPAIR_CANDIDATES = 5` candidates are tried; if none parse, `WikiParseError` is thrown.

**O(n) over the raw text**, with a small constant-factor peek-ahead (bounded by run of whitespace, in practice a few chars).

#### 1.3 Why the existing scanner's slice is unfit for tier 2

The scanner's slice can be arbitrarily truncated by a single bare quote mid-string — by the time the walker would have to repair it, the slice already ends mid-string. Running the walker on the raw text from `start` (not on `text.slice(start, scanner_end + 1)`) is the only way to get a complete container span to repair against. This is why tier 2 operates on the raw text, and why the earlier draft's tier-2a-on-slice / tier-2b-on-raw-text split collapses to a single pass.

#### 1.4 What was removed from the earlier draft

The earlier draft specified three tiers (2a on slice, 2b on raw text, **3 = `JSON5.parse`**) and listed the `json5` npm dependency. **Tier 3 is removed.** `json5` is permissive about trailing commas, comments, single-quoted strings, and unquoted keys — none of which is the failure mode of issue #92. Verified empirically: the issue's repro and the draft's own test inputs all fail `JSON5.parse` with `invalid character` at the position of the bare quote. The dependency buys nothing for the stated problem and is removed from this revision.

If a different drift class surfaces in telemetry (e.g., trailing-comma responses from a model), a future tier can be added without touching this spec's invariants.

#### 1.5 `WikiParseError` shape

`packages/core/src/types.ts`:

```ts
export class WikiParseError extends Error {
  readonly tier: 'strict' | 'repair' | 'all';
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

- `tier: 'strict'` — the existing scanner produced no usable slice (either no `{`/`[` or no balanced close). `slice` is the full `text`; `position` is `start` (where the open char was found, or `null` when none was found).
- `tier: 'repair'` — tier 1 found a slice but `JSON.parse` failed; tier 2 produced no parsable candidate within `MAX_REPAIR_CANDIDATES`. `slice` is the best candidate (the largest balanced span the walker found); `position` is the offset of the first parse failure within that candidate, when known.
- `tier: 'all'` — generic catch-all used only if both tiers fail in a way that doesn't fit the above.

### 2. Per-chunk partial commit in `IngestionService.ingestDocument`

The per-chunk task inside the existing `withConcurrency(...)` block (lines 107-124) is wrapped in a `try`/`catch`. `withConcurrency` itself is unchanged — its public contract (throw on first error) stays intact for any future callers.

```ts
type ChunkResult =
  | { status: 'ok';      facts: ExtractedFact[]; ontology_updates?: OntologyUpdates }
  | { status: 'failed';  error: ChunkFailure };

interface ChunkFailure {
  chunkIndex: number;
  sourceRef: string;        // captured from line 53; closure scope
  source: 'parse' | 'llm';  // 'ontologyContext' is RESERVED but never produced (see §3)
  tier?: 'strict' | 'repair' | 'all';   // only when source === 'parse'
  position: number | null;
  message: string;
}
```

The `try` block covers **`buildIngestPrompt`, `llmProvider.generateText`, and `parseJsonResponse`** only. **`buildPromptContext` is OUTSIDE the try** — see §3.

A network/rate-limit error from `generateText` (e.g. Bedrock `ThrottlingException`) is caught alongside a `WikiParseError` and tagged `source: 'llm'`; the host can distinguish the two by inspecting `parseFailures[*].source`.

`console.warn` fires **exactly once per failed chunk** in a fixed format:
```
[WikiMemory] ingest chunk 3/7 parse failed (sourceRef=doc://spec, tier=repair): <message>
[WikiMemory] ingest chunk 5/7 llm failed (sourceRef=doc://spec): <message>
```

The raw LLM response body is **never** included in the warn line — it may contain document content. Tests assert this.

### 3. `buildPromptContext` failures propagate

`this.ontologyService?.buildPromptContext(entityId)` is the **first** `await` in the per-chunk task (line 108). It is intentionally OUTSIDE the per-chunk `try`/`catch`. Rationale:

- `buildPromptContext` is a DB read (`OntologyService.ts:81`); its failures are systemic to the database connection, not per-chunk.
- Swallowing it turns one DB fault into `WikiIngestEmptyError` with the real cause buried in seven identical `parseFailures` entries.
- A DB fault should surface immediately, not after the host has spent LLM tokens on every chunk.

The `ChunkFailure.source` union does NOT include `'ontologyContext'`. If a future change moves `buildPromptContext` inside the try (e.g., for per-chunk ontology overrides), the union value must be added back — but the spec asserts today that ontology context is document-global.

### 4. Aggregation & persistence

#### 4.1 On the happy path (`failedChunks === 0`)

- Dedup loop at lines 126-138: skip `status === 'failed'` slots; only iterate `status === 'ok'` slots through `seen`/dedup exactly as today.
- Per-chunk `ontology_updates` merge at line 190 only fires for `status === 'ok'` slots — failed chunks contribute zero ontology updates.
- Filtered `orderedChunkFacts` is fed to `upsertGraphCore` with the same shape and same downstream code path. **Zero change to the persistence layer.**
- `upsertGraphCore` runs its full supersession sequence: soft-delete prior facts for `sourceRef` (line 449), soft-delete prior edges (452), clear prior `source_ref_index` row (455), take ownership of `(entity, sourceHash) → sourceRef` via `sourceRefIndexRepo.upsert` (458), insert facts and edges.

#### 4.2 On partial failure (`0 < failedChunks < chunks.length`)

The partial path is implemented by a dedicated **private** sibling method on `IngestionService`:

```ts
private async appendPartialFacts(
  entityId: string,
  sourceRef: string,
  sourceHash: string,
  dedupedFacts: ExtractedFact[],
  tx: SQLiteAdapter,
): Promise<{ inserted: number; skippedDuplicate: number }>
```

Contract:

- Runs **inside the caller's `tx`** — does not open a nested transaction. Matches the `upsertGraphCore` convention.
- **No supersession.** `entryRepo.softDeleteBySource` is NOT called; prior facts for `sourceRef` (from any prior attempt, complete or partial) remain live.
- **No ownership update.** `sourceRefIndexRepo.upsert` is NOT called for `(entity, sourceHash)`. The `source_ref_index` is unchanged.
- **Entry-level dedup against the live set for `sourceRef`.** Loads the current live `(sourceRef, *)` rows via `entryRepo.findIdsBySource(entityId, sourceRef, null, tx, false)`, builds a `Set<normalizedTitle>` of titles already present, and skips any fact whose normalized title collides. Returns `{ inserted, skippedDuplicate }`.
- **Facts only.** Edges from new facts are NOT resolved on this path (no ontology-context build, no `resolveEdges`, no `mergeEmergentUpdates`). Stale edges from prior attempts that point at soon-to-be-replaced titles are left in place; the next full run's supersession cleans them via `upsertGraphCore` step (e). Cross-`sourceRef` edges from new facts are recovered on the next full run. This is consistent with the existing rule that failed chunks contribute zero ontology updates.
- **No post-commit work.** Search sync, embedding, and cache eviction remain `ingestDocument`'s responsibility and run after this method returns.

Consequence of skipping ownership: `findLatestSourceHash(entityId, sourceRef)` returns the most-recently-committed hash (the prior complete attempt's hash, or `null` on first attempt) and `sourceRefIndexRepo.findActiveByEntityAndHash(entityId, sourceHash)` returns `null` until a full success occurs. `hasChanged` keeps returning `true` on every subsequent run for this `(entityId, sourceRef, sourceHash)` until a full ingest succeeds; deterministic chunking means the failed chunk set is reproducible, so each retry re-attempts only the failed chunks. When a retry achieves `failedChunks === 0`, normal `upsertGraphCore` runs and replaces **both** the prior complete attempt and any accumulated partial attempts in one transaction — yielding a single clean final state.

This method is `private` — it is an implementation detail of `ingestDocument`'s partial-commit branch, not part of the public `WikiMemory` facade. The choice of a sibling method over a flag on `upsertGraphCore` preserves `upsertGraphCore`'s atomicity invariants (its steps a–j form an indivisible supersession + ownership + write sequence that callers — including the public `WikiMemory.upsertGraph` — depend on). Conditional branches inside `upsertGraphCore` would pollute that contract and make transaction rollback boundaries harder to reason about.

#### 4.3 On total failure (`failedChunks === chunks.length`)

`ingestDocument` throws `WikiIngestEmptyError` (see §5). No persistence runs. `source_ref_index` is unchanged.

### 5. Return shape and `WikiIngestEmptyError`

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

When `failedChunks === chunks.length`, `ingestDocument` **throws**:

```ts
export class WikiIngestEmptyError extends Error {
  readonly parseFailures: ChunkFailure[];
  readonly sourceRef: string;
  readonly chunks: number;
}
```

A silent zero-fact ingest is a worse regression than a typed throw — matches existing host semantics (`aws-cloud-agent` Writer Lambda today sees `ingestDocument` throw on any failure).

**Backward-compat:** Destructure-by-`truncated` or `chunks` is unaffected. Pattern-matching the entire return shape picks up two new fields and the new optional `parseFailures`. README release notes for the next minor will flag this as a non-breaking widening under typical usage but a strict-equality break for `exactOptionalPropertyTypes` users.

### 6. Prompt tightening (text-only)

This is the cheapest independent win and can ship on its own if the parser changes are delayed. Both prompts add a sentence that names the failure mode explicitly.

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
| `packages/core/src/utils/pure.ts` | Refactor `parseJsonResponse` to add tier-2 container-aware walker; add `containerAwareRepair` helper. |
| `packages/core/src/types.ts` | Add `WikiParseError`, `WikiIngestEmptyError`, `ChunkFailure`. |
| `packages/core/src/services/IngestionService.ts` | Per-chunk try/catch around `buildIngestPrompt` + `generateText` + `parseJsonResponse` only; `buildPromptContext` stays outside the try. Aggregation skip on failed slots. Return-shape new fields. Throw `WikiIngestEmptyError` on total failure. **New private `appendPartialFacts` sibling method** (see §4.2) for the partial-commit path; `upsertGraphCore` is unchanged. |
| `packages/core/src/prompts.ts` | Two-prompt text changes (above). |
| `packages/core/__tests__/parseJsonResponse.test.ts` | New: walker behavior cases (see Testing). |
| `packages/core/__tests__/ingest.test.ts` | Extend: per-chunk-resilience cases including the no-ownership-on-partial-failure assertion. |
| `packages/core/__tests__/services/PromptService.test.ts` (or new `prompts.test.ts`) | Snapshot for the two new sentences. |
| `packages/integration/__tests__/ingestParseResilience.test.ts` | New: canned-LLM-output integration test covering the issue's repro pattern. |
| `README.md` (each published package's) | Release-note for the new return-shape fields under non-breaking widening. |

---

## Testing

### Unit — `packages/core/__tests__/parseJsonResponse.test.ts` (new)

| # | Input | Assertion |
|---|---|---|
| 1 | strict happy path | `{"facts":[]}` | Returns `{facts: []}`, no warning |
| 2 | array happy path | `[1,2,3]` | Returns `[1,2,3]` |
| 3 | walker repairs bare quote in object body | `{"body":"she said "hi""}` | Tier 2 walker finds the bare `"`, re-escapes, `JSON.parse` succeeds; result has `body: 'she said "hi"'` |
| 4 | walker repairs bare quote in array element | `["he said "hi""]` | Tier 2 walker finds the bare `"`, re-escapes, `JSON.parse` succeeds |
| 5 | walker repairs multiple bare quotes (prose shape) | `{"body":"He said "hi", then left."}` | Tier 2 walker re-escapes both bare quotes; result has `body: 'He said "hi", then left.'` |
| 6 | walker repairs mid-string bare quote at end of value | `{"body":"He said "hi""}` (closing pair) | Tier 2 re-escapes both bare quotes; result has `body: 'He said "hi"'` |
| 7 | all tiers fail on truly broken input, throws typed error | `{` (truncated mid-key — no balanced close) | `WikiParseError` thrown with `tier: 'strict'`, `position: 0`, `slice === text` |
| 8 | no JSON object/array at all | `no braces at all` | `WikiParseError` thrown with `tier: 'strict'`, `position: null`, `slice === text` |
| 9 | walker does NOT corrupt already-valid JSON | `["a","b","c"]` | Tier 1 succeeds; tier 2 never runs |
| 10 | peek-ahead respects object key/value disambiguation | `{"a":"b","c":"d"}` | Tier 1 succeeds |
| 11 | walker handles nested object in object | `{"a":{"b":"he said "x""}}` | Tier 2 repairs, `JSON.parse` succeeds |

### Unit — extend `packages/core/__tests__/ingest.test.ts`

| Test | Mock setup | Assertion |
|---|---|---|
| one chunk parse-fails, siblings commit | One bad-quote response, rest good | `ingestedChunks === 6`, `failedChunks: 1`, `parseFailures[0].source === 'parse'`, sibling facts reach `entryRepo.upsert` |
| one chunk LLM-fails, siblings commit | `generateText` throws on one chunkIndex | `failedChunks: 1`, `parseFailures[0].source === 'llm'` |
| all chunks fail | Every response malformed | `WikiIngestEmptyError` thrown with full `parseFailures` |
| mixed: 1 parse + 2 LLM + 4 ok | Per-index matrix | `ingestedChunks: 4, failedChunks: 3`, sources correct per row |
| dedup preserved | Two chunks emit same title | Only one `entryRepo.upsert` call with that title |
| console.warn fires once per failure | Mocked warn | Called exactly `failedChunks` times |
| raw response body not logged | Capture warn args | Args do not include response text |
| **partial commit does NOT update source_ref_index** | One chunk fails; mock `sourceRefIndexRepo.upsert` | `upsert` NOT called for `(entity, sourceHash)`; subsequent `hasChanged(entityId, sourceRef, sourceHash)` returns `true` |
| **partial commit does NOT supersede prior facts** | Prior complete version exists; new ingest partial-fails | `entryRepo.softDeleteBySource` NOT called; prior rows remain live |
| **partial commit dedups against prior facts for same sourceRef** | Prior attempt's fact `F` succeeded; new attempt's failed chunk includes `F` in its sibling facts | `F` inserted only once for this sourceRef |
| **full success after retry replaces partial + prior in one transaction** | First run partial; second run full | `entryRepo.softDeleteBySource` called on second run; final live set is the second run's facts only |
| **ontologyContext failure propagates, does NOT become WikiIngestEmptyError** | `buildPromptContext` throws | The throw escapes `ingestDocument` unchanged; no `parseFailures` are produced |

### Unit — extend `packages/core/__tests__/services/PromptService.test.ts`

```ts
expect(INGEST_SYSTEM_PROMPT).toContain('re-escape');
expect(INGEST_SYSTEM_PROMPT).toContain('\\n');
expect(ONTOLOGY_BACKFILL_SYSTEM_PROMPT).toContain('preserve every JSON escape');
```

### Integration — `packages/integration/__tests__/ingestParseResilience.test.ts` (new)

- **Repro subset**: 5 canned responses, one of which is the verbatim-quote case from issue #92. Verify `parseFailures[0].source === 'parse'`, recovery tier recorded, `ingestedChunks === 4`.
- **All-fail subset**: 5 canned responses, all malformed. Verify `WikiIngestEmptyError` thrown.
- **Retry subset**: First call partial (1 of 5 fails); second call all-succeed. Verify final live set has all 5 chunks' facts, no duplication, prior partial attempt's facts are gone.

### What we don't test

- Real LLM calls against `zai.glm-4.7-flash` via Bedrock — out of bandwidth, requires creds and is non-deterministic.
- Performance benchmarks for `containerAwareRepair` — single-digit KB strings, not worth benchmarking unless a regression is reported.

---

## Risk & Rollout

- **Behavioral risk**: A previously-thrown `SyntaxError` from `parseJsonResponse` is replaced by a successful parse in some cases. Downstream code (`validateFact` filter, `mergeEmergentUpdates`) still gates on `facts`/`ontology_updates` shape and so cannot accept invalid data. Net confidence: high — the worst case is "wrong facts ingested," which is the same risk class as any LLM extraction (already accepted).
- **No dependency risk**: `json5` was removed in revision. The walker is hand-rolled; no new transitive supply-chain surface.
- **Compatibility surface**: `parseJsonResponse` signature unchanged; three of four callers see no behavior change in the happy path (which still hits tier 1). `IngestionService.ingestDocument`'s return shape widens (additive). The new partial-commit semantic changes **observable retry behavior**: a host that today sees `WikiParseError` on chunk failure and treats it as fatal will, after this change, see a successful return with `parseFailures[]` set. Hosts must either (a) inspect `failedChunks` and act on partial commits, or (b) treat `failedChunks > 0` like a failure. **The host `aws-cloud-agent` needs to be updated to read `parseFailures[]` (or to fail the plan when `failedChunks > 0`); otherwise today's loud FAILED log line becomes today's silent partial commit.**
- **Visibility risk (the silent-forever bug, one layer up)**: Without §4.2's "no ownership on partial failure" rule, a 6-of-7 partial commit would stamp the full document hash into `source_ref_index`. `hasChanged` would then return `false` on every subsequent run, chunk 5's facts would never be retried, and `aws-cloud-agent`'s plan phase (which drops documents where `changed === false`) would never re-enter the loop. **§4.2 closes this by construction.**
- **Data-loss risk on re-ingest (supersession interaction)**: Without §4.2's "no supersession on partial failure" rule, a re-ingest where one chunk trips a throttle would replace a complete prior version with a partial one (since `upsertGraphCore` step (d) soft-deletes prior facts for `sourceRef` unconditionally). §4.2 closes this by skipping supersession too — partial facts append alongside the prior version, and the next full run replaces both atomically.
- **Rollout**: Released as a patch on `@equationalapplications/core-llm-wiki` and the workspace root (`expo-llm-wiki`), bumping `5.4.0` → `5.4.1`. README release notes call out: (a) the new partial-commit behavior including the no-ownership invariant; (b) the new return-shape fields; (c) the new error types `WikiParseError` and `WikiIngestEmptyError`; (d) the prompt-tightening text changes. The host (`aws-cloud-agent`) Writer Lambda must be updated in the same release to honor `failedChunks` and surface `parseFailures`.

---

## Open Questions

None at design completion (revised). All decisions resolved during revision:
- **Repair strategy**: Strict → container-aware walker on raw text → throw. (Tiers 2a/2b collapsed into one walker; tier 3 / `json5` removed.)
- **Failure surface**: Per-chunk try/catch around LLM + parse only; `buildPromptContext` propagates as DB-systemic.
- **Partial-commit semantics**: Successful chunks append (with dedup against prior live rows for the sourceRef); supersession and `source_ref_index` ownership update are SKIPPED on partial failure. The next full run supersedes everything for the sourceRef in one transaction.
- **Repair mode**: Always-on (no API change).
- **LLM error scope**: Catch LLM + parse errors per-chunk; tag by source (`parse` or `llm`).