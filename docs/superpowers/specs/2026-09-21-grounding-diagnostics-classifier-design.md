# Grounding, Diagnostics & Classifier Hook: Design

**Date:** 2026-09-21
**Status:** Draft revision 3 — review rounds 1–2 incorporated; not implemented
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
  | 'fact_rejected'                // validateFact/validateTask returned null
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
  | 'ingest' | 'upsertGraph' | 'librarian' | 'heal' | 'ontologyBackfill' | 'reembed' | 'write';

export interface WikiDiagnostic {
  code: WikiDiagnosticCode;
  severity: WikiDiagnosticSeverity;
  operation: WikiDiagnosticOperation;
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
4. **Post-commit for transactional work.** Diagnostics describing writes inside `withTransactionAsync` (edge drops, dedupe, grounding) are buffered per operation and flushed after commit. If the transaction rolls back, buffered diagnostics are discarded — the operation throws and that exception is the signal.
5. **Aggregation.** Per-item codes emitted in bulk (e.g. 40 edges dropped for `target_not_found` in one ingest) may be aggregated into one diagnostic per `(code, reason)` with `detail.count`. `ingest_chunk_failed` is aggregated per `(reason)` per ingest call so a large all-fail ingest cannot flood a synchronous hook. Per-fact codes that a reviewer would act on (`grounding_*`) are never aggregated.

### 4.3 Disclosure [REQ-DIAG-03]

Diagnostics are an exfiltration surface if they carry content. `message` is a fixed template per code; `detail` carries IDs, counts and reason slugs only. Titles, bodies, evidence quotes, target titles, LLM responses and provider error messages are forbidden. Every diagnostic carries exactly one `entityId`; an operation spanning entities emits per entity.

### 4.4 Emission sites (minimum)

| Site | Code | Reason slugs |
|---|---|---|
| `IngestionService` chunk catch | `ingest_chunk_failed` | `parse`, `llm` |
| `validateFact`/`validateTask` null (ingest, librarian, heal) | `fact_rejected` | `invalid_shape` |
| Jaccard dedupe skip (librarian, heal); ingest title dedupe | `fact_deduplicated` | `fuzzy_title`, `exact_title` |
| `OntologyService.resolveEdges` | `edge_dropped` | `no_source_type`, `type_not_in_manifest`, `target_not_found`, `target_type_mismatch` |
| non-strict `upsertGraphCore` manifest drop | `edge_dropped` | `manifest_violation` |
| `EmbeddingService` warn sites | `embedding_failed` / `hook_failed` | `invalid_vector`, `float32_overflow`, `embed_threw`, `persist_failed` |
| `WriteService` auto-librarian / auto-heal `.catch` | `background_job_failed` | `librarian`, `heal` |
| heal `onSkip` | `heal_skipped` | existing skip reason |

### 4.5 Tests

- Each row of §4.4 has a test asserting code, severity, operation, entityId, and absence of content (assert serialized diagnostic contains no fixture title/body strings).
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

### 5.2 Review API [REQ-DRAFT-02]

On `WikiMemory`:

```ts
listDrafts(entityId: string, options?: { limit?: number; cursor?: string }): Promise<{ facts: WikiFact[]; nextCursor: string | null }>;
promoteDraft(entryId: string, entityId: string, reviewer: { by: string }): Promise<void>;
```

- `listDrafts` is entity-scoped in SQL (disclosure boundary), excludes soft-deleted rows, orders by `created_at DESC, id DESC`, default limit 50, max 500, opaque cursor. Returns hydrated `WikiFact` (no `embedding_blob`).
- `promoteDraft` in one transaction: `setLifecycleStatus(entryId, entityId, 'stable')` then `writeOkfTrust(entryId, entityId, [{ by, at: now ISO }])`. Both are metadata writes (no `updated_at` bump, no outbox — existing DAO discipline). `by` must be a non-empty string; hosts should pass `human:<id>` so `trustTier` becomes `human-reviewed` (documented, not enforced). Promoting a non-draft or missing/foreign fact throws a typed `WikiNotFoundError`-style error (reuse the existing not-found error class; verify name at plan time).
- Rejection needs no new API: `setLifecycleStatus(..., 'deprecated')` or `forget`.

### 5.3 Tool manifests

`core-llm-tools`: add optional `excludeDrafts` to the read and traverse manifests' input schemas. No review tools in this series (review is a human action; hosts wire their own UI).

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
  maxEvidence?: number;      // default 3 per fact
  maxEvidenceChars?: number; // default 300 per quote
};
```

Default `'off'` keeps 7.x write behavior identical (lifecycle of LLM-authored facts is observable in OKF export). Flipping the default is a future major decision, out of scope.

### 6.2 Prompt contract

When mode is `'draft'`, `PromptService` appends an evidence instruction block, after any override, to the system prompt of **each writer listed in `grounding.writers` and no other**. Writers outside that list get no block and their facts are written exactly as today. Ingest and librarian can reuse the path that appends ontology context (`appendOntology`, reached from `buildIngestPrompt`/`buildLibrarianPrompt`). Heal has no such mechanism: `buildHealPrompt` takes no ontology context and returns the template unchanged in both branches (`PromptService.ts:119-178`), so PR 3 adds a direct append there, covering both the placeholder and the non-placeholder branch. The block requires each fact to carry:

```json
"evidence": ["exact substring copied from the SOURCE section"]
```

`validateFact` gains evidence validation: must be an array of strings; entries trimmed; non-string entries are ignored. **Every** string quote (up to a hard ceiling of 10) is checked under §6.4 before any retention cap applies, so a fabricated quote cannot hide beyond a cap; more than 10 quotes makes the fact ungrounded (`grounding_failed`, reason `too_many_quotes`). The ceiling counts every non-empty string entry after trimming, including entries shorter than `minEvidenceChars`. Quotes shorter than `minEvidenceChars` count as absent, not as passes. `maxEvidence`/`maxEvidenceChars` limit only what is retained. A fact with no qualifying quote is **ungrounded** — it is not rejected.

### 6.3 Evidence corpus [REQ-GROUND-02]

Evidence is checked only against the source material the model was shown, never against the whole prompt (instructions and manifest text would otherwise ground trivially):

| Writer | Corpus |
|---|---|
| Ingest (full and partial paths) | the chunk text passed to `buildIngestPrompt` |
| Librarian | the event contents included in the prompt |
| Heal `newFacts` | the recent-event contents actually included at the attempt's degradation level, plus the bodies of document anchors whose `lifecycle_status` is not `draft` |

Normative rules:

- **Raw values, never serialized prompt text.** The librarian and heal prompts embed events and facts as `JSON.stringify(..., null, 2)` (`PromptService.ts:88-93`; heal `:170`). The corpus is built from the in-memory string values that were serialized, joined with a newline separator, so JSON escape sequences (`\"`, `\n`) in the prompt do not cause false `grounding_failed`. Tests must include events containing quotes, backslashes and newlines.
- **No circular grounding.** Both prompts also show existing facts ("Current Facts" / the heal dump). Fact bodies are excluded from the corpus: otherwise a new inference could be grounded by quoting an earlier, possibly ungrounded, inference. A quote copied from a shown fact is therefore not found and fails. The one exception is heal's document anchors (`immutable_document` facts), which stand in for source text; only non-draft anchors count.
- **Degradation.** Heal drops recent events from L2 upward (`PromptService.ts:128-130`). At those levels only anchors remain in the corpus, so the expected result is more `draft` facts, not an error. The heal result's existing `degraded` reporting covers the attempt level.
- **Writer scope.** `grounding.writers` defaults to `['ingest']`, whose corpus is the document itself. The librarian and heal synthesize across events, so their pass rates are unknown. Hosts may opt them in; before recommending that, a follow-up must measure pass rates on a representative event log.

### 6.4 Check

Deterministic, no LLM:

1. Normalize corpus and quote identically: Unicode NFKC, collapse all whitespace runs to a single space, trim. Case-sensitive.
2. Quote passes if it is a substring of the normalized corpus.
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

### 6.6 Tests

- Grounded / missing / fabricated / mixed-quote facts on each writer.
- Quote copied from instructions or manifest text → fails (corpus excludes them).
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
- **Edges are not proposed in classifier mode** — a classifier cannot extract target titles. Result reports `edgesProposed: 0`; hosts wanting edges run with `classifier: 'llm'`. Documented explicitly.
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

Read-only, entity-scoped in every statement. Counts use SQL aggregates, except `manifestViolations`, which needs the effective manifest (a JS object): compute it by streaming the entity's edges joined to endpoint `okf_type` in pages and checking in JS, or by binding the manifest's allowed triples as a temporary table. The plan picks one. Dangling targets remain stored (baseline decision); lint reports, never repairs.

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

PRs 1, 2 and 4 may proceed in parallel worktrees from `main`. Each PR merges as a merge commit. Each PR updates the README/API docs for the surface it adds, with signatures grepped from source.

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
