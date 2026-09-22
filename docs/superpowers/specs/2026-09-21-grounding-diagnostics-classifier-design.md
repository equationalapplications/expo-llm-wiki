# Grounding, Diagnostics & Classifier Hook: Design

**Date:** 2026-09-21
**Status:** Implemented — revision 10; PRs 1–5 implemented (#198, #202, #213, #197, #216); docs #209. Follow-ups #214 and #217 implemented in #219 (see `2026-09-22-ingest-grounded-dedup-and-edge-index-design.md`)
**Branch:** `spec/grounding-diagnostics-classify`
**Source baseline:** `ab68b73` (core 7.1.3 + consolidated dependency bumps, #194)
**Delivery:** one docs PR (this spec), then five code PRs (§9). Every code PR is a `feat` minor release; no PR in this series may carry a breaking-change footer.

## 1. Decision and scope

Close the four gaps found when comparing this repository against practitioner lessons on the LLM Wiki pattern (Karpathy gist and its comment thread), and add a non-generative classification hook so hosts can adopt System-One classifiers such as TypeSafe's Jev without core taking a vendor dependency.

| Gap | Today (baseline) | This design |
|---|---|---|
| Silent failure | Edge drops, fact rejections, dedupe drops, embed failures and auto-job failures go to `console.*` or nowhere | Typed `onDiagnostic` stream (PR 1) |
| No review tier | `lifecycle_status` exists but nothing writes `draft` and no read path filters it | Opt-in `excludeDrafts`, `listDrafts`, `promoteDraft` (PR 2) |
| Memory poisoning | LLM-authored facts land `stable` with no check that they are supported by what the model saw | Opt-in deterministic evidence check; ungrounded facts land `draft` (PR 3) |
| Generative-only classification | Ontology typing only via `generateText` + JSON parsing | Optional `LLMProvider.classify` used by ontology backfill (PR 4) |
| No maintenance report | No lint; `hasChanged` is per-source | `lint`, `pendingSources`, `wiki_get_instructions` (PR 5) |

### Non-goals

- No MCP server in this repository (hosts own MCP).
- No vendor SDK or HTTP client in core. Jev/OpenJev/ONNX adapters live in hosts; §7.5 documents the mapping only.
- No change to default read or traversal results. Drafts stay visible unless a caller opts out.
- No migration of existing rows. Nothing in this series rewrites `lifecycle_status` of a pre-existing fact.
- No changes to the native GraphRAG slice (`2026-09-17-native-graphrag-vertical-slice-design.md`); §5.4 records the coordination point.
- Tasks: `lifecycle_status` also exists on tasks, but this series covers facts only.

### Compatibility rules [REQ-COMPAT-01]

1. Every new option defaults to baseline behavior. A host that upgrades without changing configuration observes identical reads, writes, traversal results, and console output.
2. New `WikiOptions`/`WikiConfig`/`ReadOptions`/`GraphTraversalOptions` fields are optional.
3. New `LLMProvider` members are optional; `generateText` remains the only required member.
4. Existing `console.warn`/`console.error` lines are retained whether or not `onDiagnostic` is registered. Removing them would be a behavior change for hosts that scrape logs; a later major may revisit.
5. Capability never implies behavior. Adding an optional provider member (e.g. `classify`) must not change any existing operation's output unless the host also opts in through configuration or a call option (see §7.3).

## 2. Background

### 2.1 Practitioner lessons adopted

- **"The failure is always silence"** — harness and pipeline failures that only reach a log are effectively invisible to the human. → PR 1.
- **Deterministic verification before filing claims** and **trusted writes vs. proposals** — compiled wikis drift toward confidently wrong when unsupported model output is written back as memory. → PR 2 + PR 3.
- **Computed pending state / lint over the unified edge table** — backlinks and linting fall out of a single edge model. This repository already has one `edges` table; PR 5 adds the report.
- **Rules in the knowledge base, fetched before writes** — keep operational guidance retrievable by agents. → `wiki_get_instructions` in PR 5.
- **Memory substrate vs. derived wiki view** — already this repository's architecture (SQLite is durable; OKF markdown is rendered from it). No work.

### 2.2 System-One classifier constraints

Jev (TypeSafe, launched 2026-09-15; also served as `typesafe/jev` on Cloudflare Workers AI) evaluates one `state` against a map of typed questions and returns calibrated probabilities:

- `choice`: one of up to 255 named options → selected option, confidence, per-option probabilities.
- `score`: 2–10 ordered levels → fractional score, confidence, per-level probabilities.
- `noul`: yes/no → single probability.

It **cannot extract** spans, entities, or free text. Consequences for this design:

- Ingest extraction (finding facts and candidate edge targets) stays on `generateText`. A classifier can only label things that already exist.
- Batching is many questions per state, not many states per call. Backfilling N facts is N requests.
- Input tokens are billed; "zero-token" claims are wrong. Early access, self-reported benchmarks, and literal reading (negation failures) are documented caveats.

## 3. Verified baseline facts

Grepped at `ab68b73`; implementation plans must re-verify line numbers.

- `LLMProvider` — `packages/core/src/types.ts:503` (`generateText`, optional `embed`, optional `maxOutputTokens`).
- `WikiOptions` host callbacks precedent — `onRetrievalFallback`, `onVectorRankerFallback` (`types.ts:598ff`).
- Fact inserts always mint new IDs: ingest full path `IngestionService.ts:658`, partial path `:771`, librarian `MaintenanceService.ts:692`, heal `:953`. The upsert INSERT writes `fact.lifecycle_status ?? 'stable'`; the UPDATE branch deliberately preserves prior OKF metadata (`EntryRepository.ts:307-311`). **Therefore setting status at insert time is sufficient for every write path in scope; no downgrade path is needed.**
- Ingest facts are `source_type: 'immutable_document'`; librarian and heal facts are `'librarian_inferred'`.
- Ingest's LLM path routes through `upsertGraphCore` via an internal `hostNodes` shape (`IngestionService.ts:642`) that currently carries no OKF metadata.
- Trust writes — `setLifecycleStatus` and `writeOkfTrust` exist on `WikiMemory` (`WikiMemory.ts:795-808`) and in `db/okf-trust-writes.ts`; they do not bump `updated_at` and do not push outbox events (DAO discipline).
- Trust tier — `deriveTrustTier` (`packages/okf/src/v02-helpers.ts:10`): empty `okf_verified` → `unverified`; any `by` starting `human:` → `human-reviewed`; otherwise `machine-confirmed`.
- Prompt composition — `PromptService` appends ontology context to both default and override prompts unless the override uses placeholders (`PromptService.ts:33-92`).
- Traversal source-type filtering precedent — `excludeSourceTypes` resolves call → config → `[]` (`GraphTraversalService.ts:32`) and is applied in SQL (`EdgeRepository.ts:173`).
- `read()` has several candidate paths (semantic, pre-filtered hybrid, keyword/MiniSearch fallback, empty-query recency) in `RetrievalService.ts`.
- Partial ingest rows are stored with `source_hash: null` **intentionally** so failed chunks are retried (`IngestionService.ts:743-747`). This is not drift and must be preserved.

## 4. PR 1 — Diagnostics stream

### 4.1 Types [REQ-DIAG-01]

In `packages/core/src/types.ts`:

```ts
export type WikiDiagnosticSeverity = 'info' | 'warn' | 'error';

export type WikiDiagnosticCode =
  | 'ingest_chunk_failed'          // per failed chunk (parse or llm)
  | 'fact_rejected'                // validateFact returned null
  | 'task_rejected'                // validateTask returned null
  | 'fact_deduplicated'            // fuzzy/title dedupe skipped a new fact
  | 'edge_dropped'                 // resolveEdges / upsertGraphCore dropped an edge
  | 'embedding_failed'             // embedFact failure or invalid vector
  | 'hook_failed'                  // onEmbeddingPersisted or other host hook threw
  | 'background_job_failed'        // auto-librarian / auto-heal promise rejected
  | 'heal_skipped'                 // existing HealResult.skipped entries
  | 'grounding_missing'            // PR 3
  | 'grounding_failed'             // PR 3
  | 'classification_low_confidence'// PR 4
  | 'classification_invalid';      // PR 4

export type WikiDiagnosticOperation =
  | 'ingest' | 'upsertGraph' | 'librarian' | 'heal' | 'ontologyBackfill' | 'reembed' | 'importDump' | 'write';

export interface WikiDiagnostic {
  code: WikiDiagnosticCode;
  severity: WikiDiagnosticSeverity;
  operation: WikiDiagnosticOperation;
  /** 'auto' when the operation was started by a write threshold (auto-librarian / auto-heal), 'call' when the host invoked it. */
  trigger: 'call' | 'auto';
  entityId: string;
  /** Epoch ms, sampled at emission. */
  at: number;
  /** Stable, content-free explanation (no fact bodies, no LLM output). */
  message: string;
  /** Identifiers only; see REQ-DIAG-03. */
  detail?: {
    factId?: string;
    sourceRef?: string;
    chunkIndex?: number;
    edgeType?: string;
    sourceNodeType?: string; // manifest slug of the edge source, when resolved
    targetNodeType?: string; // manifest slug of the edge target, when resolved
    itemIndex?: number;      // position of a rejected item in the LLM response array
    reason?: string;   // machine-readable sub-reason, e.g. 'target_not_found'
    chunkIndexes?: number[]; // aggregated ingest_chunk_failed only; first 20
    count?: number;    // for aggregated emissions
  };
}
```

`WikiOptions` gains:

```ts
onDiagnostic?: (diagnostic: WikiDiagnostic) => void;
```

The union is closed for this series; adding a code later is a minor change, so hosts must handle unknown codes (documented).

### 4.2 Emission rules [REQ-DIAG-02]

1. **Additive.** Existing console output is unchanged (REQ-COMPAT-01.4).
2. **Isolated.** The hook is invoked inside `try/catch`. A throwing or non-function hook never alters the calling operation's result, never aborts ingest/heal, and is itself reported only to `console.warn` (no recursive diagnostic).
3. **Synchronous, non-awaited.** A returned promise is ignored; a rejected returned promise is caught and swallowed to `console.warn`.
4. **Post-commit for transactional work.** Each operation collects its diagnostics in an operation-scoped buffer and flushes it right after its own transaction commits. Sites that already run after commit (embedding, host-hook failures) emit directly. If the operation throws before commit, the buffer is discarded and the exception is the signal. **Exception — `upsertGraph`:** the host owns that transaction and core never sees its commit, so the buffer is flushed when `upsertGraph` resolves. The docs tell hosts that roll back to disregard those diagnostics. **Exception — a lost duplicate-hash race in `ingestDocument`:** the write rolls back, but the LLM pass already ran for every chunk and the host paid for it. The buffer is flushed selectively (`DiagnosticBuffer.flushOnly`) for the codes that describe the LLM response — `ingest_chunk_failed`, `fact_rejected`, `fact_deduplicated` — and everything else is dropped, because any other buffered code carries a `factId` minted inside the aborted transaction and would name a row that does not exist. The trigger is the `SQLITE_CONSTRAINT_UNIQUE` itself, not the outcome: `source_ref_index` is the only UNIQUE that can raise inside that transaction, so the violation already proves another writer claimed the hash. Every exit below it flushes the same subset — all three `onDuplicateHash` modes, and the re-thrown original error taken when no live canonical ref can be named afterwards (the winner having rolled back in the meantime). What the host learns about the LLM response therefore depends on neither the mode it chose nor whether core could name the winner (#221). A non-UNIQUE transaction failure is not a race and still discards the buffer under rule 4.
5. **Aggregation.** In this series only `ingest_chunk_failed` is aggregated; every other code is emitted once per item so its locator fields survive. `ingest_chunk_failed` is aggregated per `(reason)` per ingest call so a large all-fail ingest cannot flood a synchronous hook. Per-fact codes that a reviewer would act on (`grounding_*`) are never aggregated.

6. **Fixed severity.** Severity is a function of the code: `info` for `fact_deduplicated` and `classification_low_confidence`; `error` for `background_job_failed`; `warn` for every other code.

### 4.3 Disclosure [REQ-DIAG-03]

Diagnostics are an exfiltration surface if they carry content. `message` is a fixed template per code; `detail` carries IDs, counts and reason slugs only. Titles, bodies, evidence quotes, target titles, LLM responses and provider error messages are forbidden. Manifest slugs (`okf_type`, edge types) are ontology vocabulary rather than content, so they are allowed. Hashes of content are forbidden as well: a hash of a short string such as a title can be reversed by dictionary attack. Location comes from IDs instead (`factId`, `sourceRef` + `chunkIndex` + `itemIndex`).

`operation` names the service run that emitted the diagnostic (for example, an edge dropped during ingest reports `'ingest'`; one dropped by the librarian reports `'librarian'`). `trigger` separates host-invoked runs from write-threshold runs. `background_job_failed` reports the failed job as its `operation` with `trigger: 'auto'`. Every diagnostic carries exactly one `entityId`; an operation spanning entities emits per entity.

### 4.4 Emission sites (minimum)

| Site | Code | Reason slugs |
|---|---|---|
| `IngestionService` chunk catch | `ingest_chunk_failed` | `parse`, `llm` |
| `validateFact` null (ingest, librarian, heal) | `fact_rejected` | `missing_title`, `missing_body`, `invalid_shape` |
| `validateTask` null (librarian) | `task_rejected` | `missing_description`, `invalid_shape` |
| Jaccard dedupe skip (librarian, heal) | `fact_deduplicated` | `fuzzy_title` |
| ingest title dedupe — cross-chunk, and partial-path against already-stored facts | `fact_deduplicated` | `exact_title` |
| `OntologyService.validateAndNormalizeFact` + `resolveEdges` | `edge_dropped` | `no_source_type`, `invalid_shape`, `type_not_in_manifest`, `target_not_found`, `target_type_mismatch` |
| non-strict `upsertGraphCore` manifest drop | `edge_dropped` | `manifest_violation` |
| `EmbeddingService.tryEmbedFact` | `embedding_failed` | `invalid_vector`, `float32_overflow`, `embed_threw` (kind `provider_error`), `persist_failed` (kind `storage_error`) |
| `onEmbeddingPersisted` failures (embed success path; ingest, heal orphan and heal delete loops) | `hook_failed` | `on_embedding_persisted` |
| `WriteService` auto-librarian / auto-heal `.catch` | `background_job_failed` (operation = job, trigger `auto`) | `unhandled_rejection` |
| heal `outcome.skipped` (after commit) | `heal_skipped` | `non_convergent`, `call_error` |

**Ingest title dedupe locators.** Both ingest dedupe sites emit `{ sourceRef, chunkIndex, itemIndex, reason: 'exact_title' }`, where the indexes are the *skipped* fact's own position in the LLM response. One code from one operation must not come in two shapes, and the locators are positions rather than content (§4.3), so they are carried whether or not grounding is enabled: `IngestionService` keeps a per-fact ledger of `(chunkIndex, itemIndex)` for every kept fact, with the grounding verdict attached only when grounding ran (#220). The partial path emits this on every retry of a partially-ingested document, so an untraceable batch there is the common case, not an edge case.

### 4.5 Tests

- Each row of §4.4 has a test asserting code, severity, operation, `trigger` (both `'call'` and `'auto'` where the site can be reached both ways), entityId, the reason slug, every locator field the site emits (`factId`, `sourceRef`, `chunkIndex`, `itemIndex`, `edgeType`, `sourceNodeType`, `targetNodeType`), and absence of content (assert serialized diagnostic contains no fixture title/body strings).
- Throwing hook, async-rejecting hook: operation result identical to no-hook run.
- Rolled-back transaction: no buffered diagnostics delivered.
- No-hook run: console output byte-identical to baseline for a fixed fixture (snapshot).

## 5. PR 2 — Draft visibility and review

### 5.1 Read filtering [REQ-DRAFT-01]

- `ReadOptions.excludeDrafts?: boolean` and `GraphTraversalOptions.excludeDrafts?: boolean`.
- `WikiConfig.excludeDrafts?: boolean` as the engine default. Resolution: call → config → `false`, mirroring `excludeSourceTypes`.
- When true, facts whose current stored `lifecycle_status = 'draft'` are excluded **before** `maxResults`, `tierFloors`, and node caps are applied, on every `read()` path (semantic, pre-filtered hybrid, keyword/MiniSearch fallback, empty-query recency). A path that cannot filter in SQL must oversample-then-filter or filter the candidate ID set; it must not return fewer results than exist merely because drafts occupied the cut.
- Status is read from SQLite at query time, not from an in-memory index. `setLifecycleStatus` does not bump `updated_at` or refresh MiniSearch, so any cached status would make promotions invisible.
- Traversal: drafts are dead ends like `excludeSourceTypes` (not discovered, not traversed through). A valid draft **root** is retained, consistent with the existing root exemptions. The induced-edge rule is unchanged.
- `getMemoryBundle`, `exportDump`, and `formatGraphContext` are unchanged.
- Implementation shape (plan-time): one SQLite query per `read()` fetches the draft IDs of the scored entities. Candidate rows and MiniSearch pre-filter results are filtered by that set before any cut. Vector-ranker and keyword limits are padded by the set's size, and the merged `scored` list is filtered before `selectWithFloors`. The empty-query recency path filters in SQL.

### 5.2 Review API [REQ-DRAFT-02]

On `WikiMemory`:

```ts
listDrafts(entityId: string, options?: { limit?: number; cursor?: string }): Promise<{ facts: WikiFact[]; nextCursor: string | null }>;
promoteDraft(entryId: string, entityId: string, reviewer: { by: string }): Promise<void>;
```

- `listDrafts` is entity-scoped in SQL (disclosure boundary), excludes soft-deleted rows, orders by `created_at DESC, id DESC`, default limit 50, max 500, opaque cursor. Returns hydrated `WikiFact` (no `embedding_blob`).
- `promoteDraft` in one transaction: `setLifecycleStatus(entryId, entityId, 'stable')` then `writeOkfTrust(entryId, entityId, [{ by, at: now ISO }])`. Both are metadata writes (no `updated_at` bump, no outbox — existing DAO discipline). `by` must be a non-empty string; hosts should pass `human:<id>` so `trustTier` becomes `human-reviewed` (documented, not enforced). Promoting a fact that is missing, soft-deleted, owned by another entity, or not a draft throws a new `WikiDraftNotFound` error (`code: 'WIKI_DRAFT_NOT_FOUND'`, no constructor arguments, fixed message). Core has no existing not-found class. The error is contextless for the same reason as `WikiGraphNodeOwnershipConflict`.
- Rejection needs no new API: `setLifecycleStatus(..., 'deprecated')` or `forget`.

### 5.3 Tool manifests

`core-llm-tools`: add optional `excludeDrafts` to the `wiki_traverse_graph` manifest's input schema. The package has no read manifest. No review tools in this series (review is a human action; hosts wire their own UI).

### 5.4 Native slice coordination

`GraphTraversalOptions.excludeDrafts` extends the surface that `2026-09-17-native-graphrag-vertical-slice-design.md` pins at core 7.1.3. PR 2 must add a revision note to that spec stating the new option is outside the slice's parity baseline until the slice re-pins. PR 2 does not change native code.

### 5.5 Tests

- Each `read()` path × {drafts excluded, included} with a fixture where drafts outrank stable facts; assert result count equals `min(maxResults, stableMatches)`.
- `tierFloors` with an entity whose only matches are drafts → existing `WikiInvalidReadOptions` semantics unchanged when excluded (floor counts only eligible rows; verify behavior at plan time and pin it).
- Traversal: draft interior node blocks discovery; draft root retained.
- Promote → next `read({excludeDrafts:true})` includes the fact without re-indexing.
- Promotion does not bump `updated_at` (DAO discipline), so a promoted draft keeps its original position in the empty-query recency path. Pin this with a test.
- `listDrafts` cross-entity isolation and cursor stability.

## 6. PR 3 — Grounding check

### 6.1 Configuration [REQ-GROUND-01]

```ts
WikiConfig.grounding?: {
  mode: 'off' | 'draft';     // default 'off'
  writers?: Array<'ingest' | 'librarian' | 'heal'>; // default ['ingest']
  minEvidenceChars?: number; // default 20
  maxEvidence?: number;      // default 3 per fact; clamped to the 10-quote ceiling (§6.2)
  maxEvidenceChars?: number; // default 300 per quote
};
```

Default `'off'` keeps 7.x write behavior identical (lifecycle of LLM-authored facts is observable in OKF export). Flipping the default is a future major decision, out of scope.

### 6.2 Prompt contract

When mode is `'draft'`, `PromptService` appends an evidence instruction block, after any override, to the system prompt of **each writer listed in `grounding.writers` and no other**. Writers outside that list get no block and their facts are written exactly as today. Ingest and librarian can reuse the path that appends ontology context (`appendOntology`, reached from `buildIngestPrompt`/`buildLibrarianPrompt`). Heal has no such mechanism: `buildHealPrompt` takes no ontology context; its placeholder branch only hydrates the template and its default branch returns it as-is (`PromptService.ts:119-178`), so PR 3 adds a direct append there, covering both the placeholder and the non-placeholder branch. The heal prompt shows document anchors as `{ id, title, source_ref }` only, so the model never sees an anchor body (rev 7). When heal is in `grounding.writers` (and only then), each anchor in the heal prompt also carries `body`, clipped to `HEAL_ANCHOR_BODY_CHARS` (800) with `safeSlice`, in both template branches. Outside that case the anchor shape is unchanged. The block requires each fact to carry:

```json
"evidence": ["exact substring copied from the SOURCE section"]
```

`validateFact` gains evidence validation: must be an array of strings; entries trimmed; non-string entries are ignored. **Every** string quote (up to a hard ceiling of 10) is checked under §6.4 before any retention cap applies, so a fabricated quote cannot hide beyond a cap; more than 10 quotes makes the fact ungrounded (`grounding_failed`, reason `too_many_quotes`). The ceiling counts every non-empty string entry after trimming, including entries shorter than `minEvidenceChars`. Quotes shorter than `minEvidenceChars` count as absent, not as passes. `maxEvidence`/`maxEvidenceChars` limit only what is retained. A fact with no qualifying quote is **ungrounded** — it is not rejected.

### 6.3 Evidence corpus [REQ-GROUND-02]

Evidence is checked only against the source material the model was shown, never against the whole prompt (instructions and manifest text would otherwise ground trivially):

| Writer | Corpus |
|---|---|
| Ingest (full and partial paths) | the chunk text passed to `buildIngestPrompt` |
| Librarian | the `summary` of each event included in the prompt |
| Heal `newFacts` | the `summary` of each recent event actually included at the attempt's degradation level, plus the prompt-visible (clipped) bodies of the document anchors in that prompt whose `lifecycle_status` is not `draft` |

The corpus for a heal response is the one built with the exact prompt that produced it. `runBatched` rebuilds prompts while trimming, splitting and escalating, so the corpus is keyed to the prompt object, not to the batch. Event `id`, `event_type` and timestamps are not corpus: they are shown to the model, but they are identifiers, and quoting them would ground trivially.

Normative rules:

- **Raw values, never serialized prompt text.** The librarian and heal prompts embed events and facts as `JSON.stringify(..., null, 2)` (`PromptService.ts:88-93`; heal `:170`). The corpus is built from the in-memory string values that were serialized, kept as one normalized part per value and never concatenated into a single string, so JSON escape sequences (`\"`, `\n`) in the prompt do not cause false `grounding_failed`, and a quote cannot ground across the boundary of two sources. Tests must include events containing quotes, backslashes and newlines.
- **No circular grounding.** Both prompts also show existing facts ("Current Facts" / the heal dump). Fact bodies are excluded from the corpus: otherwise a new inference could be grounded by quoting an earlier, possibly ungrounded, inference. A quote copied from a shown fact is therefore not found and fails. The one exception is heal's document anchors (`immutable_document` facts), which stand in for source text; only non-draft anchors count.
- **Degradation.** Heal drops recent events from L2 upward (`PromptService.ts:128-130`). At those levels only anchors remain in the corpus, so the expected result is more `draft` facts, not an error. The heal result's existing `degraded` reporting covers the attempt level.
- **Writer scope.** `grounding.writers` defaults to `['ingest']`, whose corpus is the document itself. The librarian and heal synthesize across events, so their pass rates are unknown. Hosts may opt them in; before recommending that, a follow-up must measure pass rates on a representative event log.

### 6.4 Check

Deterministic, no LLM:

1. Normalize corpus and quote identically: Unicode NFKC, collapse all whitespace runs to a single space, trim. Case-sensitive.
2. Quote passes if it is a substring of one normalized corpus part. Parts are never concatenated for matching, so a quote spanning the end of one source and the start of the next fails.
3. Fact is **grounded** iff at least one quote passes and no quote fails. (A fabricated quote alongside a real one is a poisoning signal, not noise.)

### 6.5 Outcomes

| Result | `lifecycle_status` | `okf_verified` | Diagnostic |
|---|---|---|---|
| Grounded | `stable` | append `{ by: 'process:grounding-check', at }` → `machine-confirmed` | none |
| No valid evidence | `draft` | unchanged | `grounding_missing` (warn) |
| Any quote not found | `draft` | unchanged | `grounding_failed` (warn) |

- Status and trust are written **at insert** in the same transaction as the fact (§3: every in-scope write path mints a new ID). For ingest this requires extending the internal `hostNodes` shape to carry `lifecycle_status` and a verified entry; the public `upsertGraph` signature does not change and `upsertGraph` callers are never grounded (host-supplied deterministic nodes).
- Evidence quotes are not persisted in this series (open question §10.2).
- Mode `'off'`: no prompt change, no evidence validation, no status/trust writes — byte-identical to baseline.
- Duplicate titles within one ingest call (rev 10, #214): the fact with the best verdict is kept, `grounded` over `missing`/`failed`; on a tie the first seen is kept. The kept fact stays in its own chunk's slot. See `2026-09-22-ingest-grounded-dedup-and-edge-index-design.md` §3.

### 6.6 Tests

- Grounded / missing / fabricated / mixed-quote facts on each writer.
- Quote copied from instructions or manifest text → fails (corpus excludes them).
- Quote stitched across two corpus parts (end of one source + start of the next) → `grounding_failed` (per-part containment).
- Whitespace and NFKC normalization cases; case mismatch fails.
- Partial ingest path grounds identically.
- `promptOverride` without evidence wording still receives the appended block, for in-scope writers only.
- Heal: block appended in both the placeholder and non-placeholder template branches.
- Writer not in `grounding.writers` → no evidence block in its prompt; its facts land `stable` with `okf_verified` unchanged.
- Quote copied from a shown fact (librarian "Current Facts", heal candidates) → `grounding_failed` (no circular grounding).
- Quote copied from a non-draft heal anchor → passes; from a draft anchor → fails.
- Heal at L2+ (no events) → only anchors form the corpus.
- Events containing quotes, backslashes and newlines → no false `grounding_failed` (raw-values rule).
- 11 quotes → `grounding_failed` with reason `too_many_quotes`, including when some are short.
- Mode `'off'` snapshot equals baseline.

## 7. PR 4 — Optional classifier provider

### 7.1 Types [REQ-CLASS-01]

Vendor-neutral names in `types.ts`:

```ts
export type ClassifierQuestion =
  | { kind: 'choice'; options: string[]; instructions?: string }
  | { kind: 'binary'; instructions: string }
  | { kind: 'score'; levels: string[]; instructions?: string };

export interface ClassifyRequest {
  state: string;
  questions: Record<string, ClassifierQuestion>;
}

export type ClassifierAnswer =
  | { kind: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { kind: 'binary'; probability: number }
  | { kind: 'score'; score: number; confidence: number; probabilities: number[] };

export interface LLMProvider {
  // existing members unchanged
  classify?: (request: ClassifyRequest) => Promise<{ answers: Record<string, ClassifierAnswer> }>;
}
```

### 7.2 Output validation [REQ-CLASS-02]

Core treats provider output as untrusted. An answer is invalid (→ `classification_invalid`, fact left untouched) if: its key is missing; `kind` differs from the question; a `choice` is not one of the offered options; any probability/confidence is non-finite or outside [0, 1]; `score` is outside [0, levels−1]. A thrown `classify` is a per-item failure, never a batch abort (same isolation as ingest chunks).

### 7.3 Ontology backfill

- `runOntologyBackfill(entityId, options)` gains `options.classifier?: 'auto' | 'llm'`, with engine default `WikiConfig.ontology.backfillClassifier` (default `'llm'`). Resolution: call → config → `'llm'`. Adding `classify` to a provider alone never changes backfill (REQ-COMPAT-01.5).
- `'auto'` with `provider.classify` present: per untyped fact, one request with `state` = title + body (tags appended), one `choice` question whose options are the effective manifest's node-type slugs. Accept when `confidence >= WikiConfig.ontology.classifyMinConfidence` (default 0.5); otherwise leave untyped and emit `classification_low_confidence`.
- More than 255 node types, or `classify` absent, or `'llm'`: existing generative path, unchanged.
- Accepted answers become ordinary backfill classifications and go through the existing per-batch apply step, unchanged (manifest normalization, cooldown stamping, abort-on-off).
- Counting: an invalid answer counts toward `failedValidation`. A low-confidence answer is an omission (not typed, cooldown-stamped). A thrown `classify` counts toward `skipped` and is **not** cooldown-stamped, matching `call_error`.
- **Edges are not proposed in classifier mode** — a classifier cannot extract target titles. Result reports `edgesAdded: 0`; hosts wanting edges run with `classifier: 'llm'`. Documented explicitly.
- Concurrency reuses `chunkConcurrency`.
- Core does not import any ontology package; options come from the effective manifest (`OntologyConfig`).

### 7.4 Deferred uses (not in PR 4)

Recorded for later specs, each needing its own design: edge-type selection constrained to manifest rows valid for an extracted (source type, target type) pair; `binary` entailment as a second grounding stage; heal duplicate/contradiction detection.

### 7.5 Host adapter mapping (documentation only)

Jev `choice`/`score`/`noul` ↔ `choice`/`score`/`binary`. README gains an adapter example against Cloudflare Workers AI `typesafe/jev`, marked as an example, not a supported package.

### 7.6 Tests

Fake classifier provider covering: accepted choice, low confidence, off-manifest choice, NaN probability, thrown error, >255 types fallback, `'llm'` override, absent `classify` → baseline path snapshot.

## 8. PR 5 — Lint, pending sources, instructions tool

### 8.1 `lint` [REQ-LINT-01]

```ts
lint(entityId: string): Promise<WikiLintReport>;

interface WikiLintReport {
  danglingEdges: number;      // target or source missing/soft-deleted within entity
  manifestViolations: number; // edges whose (source type, edge, target type) is not in the effective manifest
  untypedFacts: number;       // okf_type IS NULL, live
  drafts: number;             // lifecycle_status = 'draft', live
  unverifiedInferred: number; // librarian_inferred, live, okf_verified empty
  sample: { danglingEdgeIds: string[]; manifestViolationEdgeIds: string[] }; // ≤ 20 each
}
```

Read-only, entity-scoped in every statement. Counts use SQL aggregates, except `manifestViolations`, which needs the effective manifest (a JS object): compute it by streaming the entity's edges joined to endpoint `okf_type` in pages and checking in JS, or by binding the manifest's allowed triples as a temporary table. The plan picks one. Dangling targets remain stored (baseline decision); lint reports, never repairs. Lint does not inspect `source_hash`: a null hash on partial-ingest rows is the intended retry state (§3), reported only by `pendingSources` as `partial`, never as an inconsistency.

### 8.2 `pendingSources` [REQ-PENDING-01]

```ts
pendingSources(entityId: string, sources: Array<{ sourceRef: string; sourceHash: string }>):
  Promise<Array<{ sourceRef: string; status: 'new' | 'changed' | 'partial' | 'current' }>>;
```

Batch equivalent of `hasChanged` with one distinction: `partial` = live rows exist for the ref but none carries a hash (the intentional retry state, §3). Chunked queries to respect SQLite variable limits. Input order preserved.

### 8.3 `wiki_get_instructions` tool

`core-llm-tools` manifest returning the effective system prompts (defaults with `WikiConfig.prompts` overrides applied, ontology and grounding blocks appended) for `ingest`, `librarian`, `heal`, `ontologyBackfill`. Scope `memory:read`. Returns templates only, never hydrated prompts containing events or chunks. Override templates are returned verbatim: docs must warn hosts not to embed secrets or private data in `WikiConfig.prompts`, because any `memory:read` client can read them.

## 9. Delivery sequence

| PR | Scope | Release | Depends on |
|---|---|---|---|
| 0 | This spec | none (`docs`) | — |
| 1 | Diagnostics stream (§4) | minor | — |
| 2 | Draft visibility + review (§5) | minor | — |
| 3 | Grounding check (§6) | minor | 1, 2 |
| 4 | Classifier hook + backfill (§7) | minor | 1 |
| 5 | Lint, pending, instructions tool (§8) | minor | 1 (3 for the grounding block in 8.3) |

PRs 1, 2 and 4 may proceed in parallel worktrees. PR 4 is built independently; its `classification_*` diagnostic emissions are the last task of its plan, gated on PR 1 being merged to `main` (merge `main` into the PR 4 branch first). Each PR merges as a merge commit. Each PR updates the README/API docs for the surface it adds, with signatures grepped from source.

## 10. Open questions

1. **Grounding default.** `'off'` in 7.x is recommended; is a default flip wanted in the next major?
2. **Persisting evidence.** Store accepted quotes (e.g. in `okf_sources` extra keys) so reviewers see why a fact was accepted? Needs a size cap and an OKF round-trip check; deferred.
3. **Task drafts.** Librarian-authored tasks could receive the same treatment; deferred.
4. **Re-ingest reconciliation.** A changed source currently supersedes every live fact for its `sourceRef` (soft-delete, then insert with new IDs; `IngestionService.ts:608`). Once PR 2/3 exist, this discards human promotions and `okf_verified` history on every document edit, and leaves inbound edges from other sources pointing at retired IDs. Candidate follow-up (opt-in): match new extractions to prior facts; keep ID and trust only when the prior fact is re-extracted with unchanged body and its evidence still appears in the new source; otherwise supersede as today, but deprecate (not delete) human-reviewed facts and emit a diagnostic. Depends on open question 2 (persisted evidence).
5. **Second-order anchor grounding.** Heal facts may be grounded against document-anchor bodies, which are LLM-extracted text rather than the source document. Only non-draft anchors count, which is defensible. If this needs tightening, require anchors to carry `okf_verified` (for example, from the ingest grounding check).
6. **React surface.** `react-llm-wiki` exposure of diagnostics and drafts (e.g. `useWikiDiagnostics`, `useDrafts`) is left to a follow-up.

## 11. Revision log

- **rev 1 (2026-09-21):** initial draft. Corrects an external draft proposal that (a) keyed grounding on a nonexistent `verbatimQuote` field and failed open, (b) proposed downgrading all automated facts, (c) used a single-question, vendor-named `classify` shape and a generative fallback module, (d) referenced nonexistent files/types (`types/provider.ts`, `InferredFact`, index files), and (e) imported a specific ontology package into core.
- **rev 2 (2026-09-21):** review round 1. §6.3: the corpus is built from raw values, not serialized prompt JSON; fact bodies are excluded (circular grounding); `grounding.writers` defaults to ingest only, pending a librarian/heal pass-rate evaluation. §6.2: every quote is checked before retention caps apply. §7.3 + REQ-COMPAT-01.5: backfill defaults to `'llm'`; provider capability alone never changes behavior. §4.2: `ingest_chunk_failed` is aggregated. §5.5: pin promoted-draft recency. §8.1: manifest-violation computation note. §8.3: override disclosure caveat. Heal corpus: events at the attempt's degradation level plus non-draft document anchors.
- **rev 3 (2026-09-21):** review round 2. §6.2: the evidence block is appended only for writers in `grounding.writers` (it previously contradicted §6.3's ingest-only default). It also records that heal has no ontology-append mechanism (`buildHealPrompt` returns the template as-is), so PR 3 adds a direct append. The quote ceiling is pinned to count all non-empty entries. §6.6: tests added for writer scoping, circular grounding, anchors, degradation, escapes and `too_many_quotes`. Open question 5 records the second-order anchor-grounding tradeoff.
- **rev 4 (2026-09-21):** review round 3.
  - §4.1: added `trigger` and non-content locator fields (`sourceNodeType`, `targetNodeType`, `itemIndex`).
  - §4.3: manifest slugs allowed; content hashes forbidden (short strings can be reversed by dictionary attack); `operation` and `trigger` semantics pinned.
  - §4.4: finer `fact_rejected` reasons.
  - §8.1: lint ignores `source_hash`.
  - Rejected from that review: a code sketch that puts the hook on `WikiConfig`, drops `entityId`/`message`, uses `Record<string, any>`, and adds a console line for every diagnostic (breaks REQ-COMPAT-01.4); a claim that PR 4 routes `resolveEdges` through `classify` (deferred, §7.4); a generative `classify` fallback (rejected in rev 1); "SQLite migrations" for PR 2 (the `lifecycle_status` column already exists).
- **rev 5 (2026-09-21):** review round 4.
  - §4.1/§4.4: `task_rejected` split out from `fact_rejected`, with reasons `missing_description` and `invalid_shape`. `validateTask` rejects on description, not title/body.
  - §4.5: tests assert `trigger`, the reason slug, and every emitted locator field.
  - §6.2: heal placeholder-branch wording corrected.
- **rev 6 (2026-09-21):** plan-time amendments found while mapping the code; approved spec.
  - §4.1: operation `'importDump'` added (`importDump` embeds facts).
  - §4.2: buffer and flush rule per operation; `upsertGraph` flushes on resolve because the host owns its transaction; only `ingest_chunk_failed` aggregates; severity fixed per code.
  - §4.4: `edge_dropped` also covers `validateAndNormalizeFact` (reason `invalid_shape`); embedding kind-to-reason mapping; `hook_failed` reason `on_embedding_persisted`; heal skip reasons named.
  - §5.1: implementation shape for draft filtering.
  - §5.2: new `WikiDraftNotFound` (no existing not-found class).
  - §5.3: only the traverse manifest exists.
  - §7.3: the result field is `edgesAdded`; classifier answers reuse the batch apply step; counting rules.
  - §9: PR 4 diagnostics gated on PR 1.
- **rev 7 (2026-09-21):** PR 3 plan-time amendment, found while mapping heal. The user chose the resolution.
  - §6.2/§6.3: `_selectHealAnchors` returns anchors as `{ id, title, source_ref }`, so anchor bodies were never in the heal prompt and the rev 2 "anchor bodies" corpus clause contradicted the "only what the model was shown" rule. Resolved by showing clipped anchor bodies (`HEAL_ANCHOR_BODY_CHARS` = 800) in the heal prompt when heal is a grounding writer. Draft anchors are shown too, but they are not corpus, so a quote copied from one fails (the §6.6 test). Baseline heal prompts are unchanged.
  - §6.3: the event corpus is pinned to `summary` values (the event text field); identifiers are excluded. The heal corpus is keyed to the exact prompt that produced each response.
  - Rejected alternatives: grounding heal against anchor titles only (weak evidence), and dropping anchors from the heal corpus (every L2+ heal fact would become a draft).
- **rev 8 (2026-09-21):** PR 3 review amendment (#213).
  - §6.3: with a placeholder override, a source enters the corpus only when the template places its placeholder (`{{events}}` for librarian; `{{recentEvents}}` and `{{documentAnchors}}` for heal). A librarian template that places `{{currentFacts}}` without `{{events}}` shows no events, so its corpus is empty. The librarian corpus is built by `buildLibrarianPrompt` alongside its prompt.
  - §6.1: `maxEvidence` is clamped to the 10-quote ceiling, so the prompt never asks for a count that `checkGrounding` rejects as `too_many_quotes`.
- **rev 9 (2026-09-21):** PR 3 review amendment (#213), second review round.
  - §6.3/§6.4: the corpus is per-part. Each source value is normalized as its own part and a quote passes only inside a single part. The rev 2 "joined with a newline separator" wording let a quote stitched across the boundary of two sources (end of one event summary and the start of the next, or a summary into an anchor body) pass `checkGrounding`, grounding a fact on text that appears in no one source. Whitespace normalization collapsed the newline join into a space, making the stitched quote a substring of the joined corpus. Ingest is unaffected (single-part corpus).
- **Status revision (2026-09-22):** Implemented. PR 5 lands as #216, the last PR of the series, and the series docs landed as #209. No spec text changed.
  - Tracked outside this spec: #214 (when ingest dedupes by title, prefer a grounded duplicate) and #217 (index for lint's edge paging).
- **rev 10 (2026-09-22):** post-series amendment (#214).
  - §6.5: ingest title dedup now keeps the best-grounded duplicate instead of the first one seen. Before grounding the choice didn't matter; with `mode: 'draft'` it decided whether a fact landed `stable` or `draft` based only on chunk order. Grounding off is unchanged. Design: `2026-09-22-ingest-grounded-dedup-and-edge-index-design.md` §3.
