# Competitive memory: temporal facts, op-based librarian, budgeted maintenance: Design

**Date:** 2026-09-29
**Status:** Draft (r1) — awaiting user review
**Branch:** `dev/competitive-memory` (long-lived; cut from `main` at `0f39bf4`, release 7.7.7)
**Package:** `@equationalapplications/core-llm-wiki` (plus a new private `packages/benchmarks`)
**Downstream consumers:** Clanker (Expo), Curated Thoughts (Tauri), SynapseTree (SaaS, SQLite-per-tenant on S3)

## 1. Goal and positioning

Close the feature gap with hosted memory systems (Mem0, Zep/Graphiti, Letta) while keeping core's differentiators: zero runtime dependencies, SQLite anywhere, bring-your-own-inference (BYOI), OKF interop. The pitch this work must be able to back with numbers: **temporal, contradiction-aware memory at a measurable token cost.**

Gap analysis against 7.7.7 (verified in source):

| Rival capability | Core today | Closed by |
|---|---|---|
| Update/supersede ops against similar memories (Mem0) | Librarian is add-only; sends the 100 most recent facts in full as dedupe context; dedupe is title-Jaccard | Phase B |
| Bi-temporal facts, point-in-time queries (Zep/Graphiti) | No validity window; heal resolves contradictions by soft-delete, losing history | Phase A |
| Sleep-time / deferred consolidation (Letta) | Event log + count threshold exists, but runs as a fire-and-forget promise inside `write()` — unsafe on serverless | Phase C |
| Token-reduction claims, published benchmark scores | No read budget; no benchmark harness | Phase 0, Phase D |

### 1.1 Evaluation of the external (Gemini) brainstorm

Recorded so the rejected parts are not re-raised:

- **Similarity "ambiguity band" (≥0.88 auto-append, ≤0.50 auto-new, middle → LLM).** Goal adopted, rule **inverted at the top**. Contradictions ("lives in Seattle" / "moved to SF") are *high*-similarity pairs; auto-appending at ≥0.88 would store both as current. Only near-*identical* content is safe to skip deterministically. See §5.3.
- **JSON-diff ops instead of page rewrites.** Adopted (§5). Core already never rewrites pages; the real cost is the 100-fact context block, which Phase B replaces with per-candidate top-k neighbours.
- **Timestamped claim triples + `is_current`.** Adopted as fact-level validity windows on `entries` (§4), **not** a separate triples table — edges already model relations, and a second representation would have to be taught to every read path, OKF, and the ontology.
- **WAL-style buffering, token threshold, idle trigger.** Buffering already exists (`events` + `autoLibrarianThreshold`). Adopted: token threshold, host-driven deferred mode, idle `drain()` (§6).
- **LoCoMo** is excluded: CC BY-NC licence is incompatible with publishing scores in commercial marketing.
- Unverified claims about rival internals (e.g. specific Mem0 field names) are not design inputs.

## 2. Delivery, compatibility, release rules

- **Phases:** 0 → A → B → C → D, in that order. B depends on A (SUPERSEDE needs somewhere to land). C and D are independent of B in code but ordered for narrative (D's rerun measures B + C).
- **One PR per phase into `dev/competitive-memory`**, each with its own detailed plan (`docs/superpowers/plans/`). Merge commits only — never squash (either into the dev branch or into `main`).
- **The dev branch merges to `main` once**, released as **7.8.0** (`feat:` commits → minor).
- **No `BREAKING CHANGE` footers anywhere on the dev branch.** Every new behaviour is opt-in config; defaults are unchanged. A breaking footer would publish 8.0.0 on merge.
- **Legacy isolation:** the current librarian moves verbatim to `services/librarian/legacy.ts` in its own commit (pure move, no behaviour change) so 8.0.0 can delete it without untangling branches.
- **8.0.0 (out of scope, tracked as a follow-up issue):** flip defaults (`strategy: 'ops'`, possibly `maintenance: 'deferred'` for server hosts), delete `legacy/`, move heal's contradiction path to supersession.
- Spec, plan, and code changes go in separately reviewable commits; spec revisions append to Status rather than replace it.

## 3. Phase 0 — benchmark harness and baseline

New private workspace package `packages/benchmarks` (`"private": true`, never published, excluded from release config).

### 3.1 LongMemEval stratified slice

- Dataset: LongMemEval_S (MIT). **Downloaded at run time** into a gitignored cache; never vendored.
- Sample: ~80 questions, fixed by a committed seed + committed question-id list:
  - knowledge-update 20, temporal-reasoning 20, multi-session 15, single-session (user / preference / assistant) 25 combined.
- Pipeline per question: fresh SQLite DB → replay haystack sessions via `write()` (passing session timestamps once Phase A exists; the baseline run records that timestamps were unavailable) → run maintenance to quiescence → `read()` with the question → answer model → judge model.
- **Models:** any OpenAI-compatible endpoint. Default answer/ingestion model **GLM 5.3 Flash**. Judge model is a **separate** config value; the report always names it (self-judging is lenient; published LongMemEval scores use a GPT-4o-class judge, so cross-system comparisons must state the judge).
- **Ingest cache:** the post-ingest SQLite file is cached per (question id, engine version, flags) so re-judging or re-answering does not re-pay ingestion. Expected full-run cost is ~$10–40 dominated by ingestion (≈80 × ~115k history tokens).
- Run manually via a CLI script, at phase merges and for marketing refreshes. Never in CI.

### 3.2 Supersession suite

~30 hand-written scenarios (relocation, job change, diet change, preference reversal, relationship status, renamed project, date-scoped plans…), each: an event sequence, the expected final current fact set, and the expected op per candidate.

- **Replay mode (CI, zero cost):** recorded LLM responses are replayed; asserts the engine *applies* ops correctly. Runs under the core vitest suite.
- **Live mode (manual):** same scenarios against a real model; measures whether the model *chooses* the right ops. Used to calibrate §5.3 thresholds.
- Against the legacy librarian (Phase 0), most supersession assertions are **expected to fail**; the baseline records the failure count rather than asserting pass.

### 3.3 Instrumentation and report

A provider wrapper records per call: call site (extract / librarian / heal / answer / judge), input and output tokens (provider-reported where available, else estimated and flagged), wall clock. Per question: retrieval payload tokens. Report JSON: engine version, git SHA, strategy flags, models, judge, per-category accuracy, token totals by call site, latency percentiles.

**Deliverable:** `packages/benchmarks/results/baseline-7.7.7.json` committed, plus `packages/benchmarks/README.md` describing methodology and cost.

## 4. Phase A — temporal facts

### 4.1 Schema (migration 13, additive, no backfill)

`${prefix}entries`:

| Column | Type | Meaning |
|---|---|---|
| `valid_from` | `INTEGER NULL` | Epoch ms the fact became true in the world. NULL ⇒ "since `created_at`" (read via `COALESCE`). |
| `valid_to` | `INTEGER NULL` | Epoch ms the fact stopped being true. NULL ⇒ open-ended. |
| `superseded_by` | `TEXT NULL` | Id of the replacing fact. Audit/`history()` only. |
| `superseded_at` | `INTEGER NULL` | Epoch ms the supersession was recorded (transaction time). Audit only. |

Index: `CREATE INDEX ${prefix}entries_superseded_idx ON ${prefix}entries(entity_id, superseded_by) WHERE superseded_by IS NOT NULL`.

`${prefix}events`: `occurred_at INTEGER NULL` — real-world time of the event. `created_at` stays ingestion time and remains the ordering key, so backdated events never reorder the log.

`${prefix}checkpoints`: `librarian_watermark_at INTEGER NULL`, `librarian_watermark_id TEXT NULL` — used by the ops strategy (§5) and deferred mode (§6) instead of the count-based `memory_checkpoint`, which becomes wrong once events are pruned or backdated. Legacy keeps using `memory_checkpoint`.

No foreign keys (consistent with existing migrations). No row rewrites on upgrade — mobile-safe.

### 4.2 Semantics

Valid time is a **half-open interval** `[COALESCE(valid_from, created_at), valid_to)`.

- **Live at T:** `deleted_at IS NULL AND COALESCE(valid_from, created_at) <= T AND (valid_to IS NULL OR valid_to > T)`.
- **Current:** live at `now`. `read()` without `asOf` returns exactly the set `read({ asOf: Date.now() })` would.
- `asOf` is a **valid-time query using current knowledge** ("what do we now know was true at T"). It does **not** filter on `created_at <= T` or `superseded_at`. Rationale: learning today that the user moved to SF last month must make `asOf(two weeks ago)` return SF. A combined valid-time/transaction-time filter returns *neither* fact in that case.
- A supersession with a future `validFrom` leaves the old fact current until that instant.
- Superseding is not deleting: `forget()` and soft-delete semantics are unchanged; superseded rows keep `deleted_at IS NULL`.
- Transaction-time queries ("what did we believe at T", a `knownAt` option) are out of scope; `superseded_at` preserves the data to add them later.

**Compatibility:** legacy code paths never set `valid_to`, and `COALESCE(valid_from, created_at) <= now` holds for every existing row, so default reads return the same rows as 7.7.7 until something supersedes.

### 4.3 API (additive)

- `write(entityId, { event_type, summary, related_entry_id?, occurred_at? })` — `occurred_at` stored in the new column. Librarian prompts render `occurred_at ?? created_at`.
- `supersede(entityId, oldId, replacement, options?: { validFrom?: number })` where `replacement` is a new-fact input or an existing fact id. One transaction:
  - `t = options.validFrom ?? now`; `old.valid_to = t`, `old.superseded_by = newId`, `old.superseded_at = now`.
  - New fact's `valid_from = replacement.valid_from ?? t` (no gap, no overlap).
  - Rejects with a new exported `WikiSupersedeError` carrying `reason: 'not_found' | 'already_superseded' | 'immutable_target' | 'cycle' | 'cross_entity'` (no existing error class fits; core has no not-found/conflict class as of 7.7.7). `immutable_target` covers `old.source_type === 'immutable_document'` — re-ingest is the mutation path for documents. `cycle` = replacement already in old's chain.
  - Emits a `fact_superseded` event and an outbox row when `enableOutbox`.
- `history(entityId, factId): Promise<WikiFact[]>` — walks `superseded_by` both directions via a bounded recursive CTE (depth cap constant), returns versions oldest → newest.
- `read(entityId, query, { asOf? })`, `traverseGraph(entityId, { asOf?, … })`.
- `WikiFact` gains optional `valid_from`, `valid_to`, `superseded_by`, `superseded_at`.

### 4.4 Interactions

- **Edges** carry no validity. An edge is traversable at T only when **both** endpoint facts are live at T. Default traversal uses T = now.
- **Search index** (MiniSearch + vector scan) keeps all non-deleted rows; the validity predicate is applied at candidate selection, so `asOf` needs no second index. The `preFilterLimit` path must apply the predicate *before* truncation, or historical queries starve.
- **Heal** excludes non-current facts from candidates and anchors.
- **Prune:** superseded / expired rows are retained by default. New config `pruneSupersededAfter?: number | null` (days since `valid_to`; default `null` = keep forever).
- **OKF:** export/import carries the four fields under the llm-wiki profile's extension keys; round-trip preserves them. Profile doc updated.
- **Formatters:** `formatContext` / `formatMemoryDump` unchanged for current reads.

### 4.5 Tests

Migration from a 7.7.7 fixture DB; half-open boundaries (T = `valid_from`, T = `valid_to`, T = switch instant returns only the new fact); the "learned-late backdated" case from §4.2; future-dated supersession; all `supersede()` rejections; `history()` both directions and depth cap; edge filtering under `asOf`; `preFilterLimit` with `asOf`; prune retention; OKF round-trip; default-read parity with 7.7.7 fixtures.

## 5. Phase B — op-based, similarity-gated librarian

### 5.1 Flag and layout

`config.librarian.strategy: 'legacy' | 'ops'` (default `'legacy'`).

```
services/librarian/
  legacy.ts      # verbatim move of today's doRunLibrarian body
  ops/extract.ts # step 1
  ops/gate.ts    # steps 2–3 (pure + repository reads)
  ops/resolve.ts # step 4
  ops/apply.ts   # step 5
```

`MaintenanceService.doRunLibrarian` dispatches on strategy; locks, checkpoint/watermark handling, and diagnostics wiring stay in one place.

### 5.2 Step 1 — extract (one LLM call)

- Input: events **after the librarian watermark** (not "last 50"), each labelled `e1…eN` with `occurred_at ?? created_at`; ontology context. **No existing facts in the prompt.**
- Batch size bounded by chars (and by remaining budget under §6); the watermark advances only past events whose batch committed.
- Output: `{ facts: [{ title, body, tags, confidence, evidence, source_event, valid_from?, edges? }], tasks: [...] }`. Validation reuses `validateFact` / `validateTask`; `source_event` must be one of the batch's labels.

### 5.3 Steps 2–3 — neighbours and gate (no LLM)

- Embed each candidate once (vectors reused on insert — no double embed). Top-k **current** facts per candidate, k = 5: cosine when `embed` is available, MiniSearch otherwise.
- Gate per candidate:
  - **NOOP** — normalised title+body identical to a neighbour, **or** cosine ≥ `dupThreshold` (default 0.97) **and** title Jaccard ≥ the existing `FUZZY_THRESHOLD` (0.5, currently private in `MaintenanceService`; moved to a shared librarian module). Touches the neighbour's `last_verified_at`.
  - **ADD** — no neighbour, or best cosine < `novelThreshold` (default 0.55); in keyword mode, zero MiniSearch hits.
  - **Ambiguous** — everything else → step 4.
- `config.librarian.gate: { dupThreshold?, novelThreshold?, k? }`. Defaults are provisional (embedding-model dependent) and are recalibrated from Phase 0 live-mode runs before 7.8.0.
- Diagnostic `librarian_gate` `{ noop, add, ambiguous }` per pass.

### 5.4 Step 4 — resolve (one batched LLM call)

- Each ambiguous candidate is sent with **only its own neighbours**, neighbour ids aliased `n1…nk`, neighbour bodies truncated to a fixed char cap.
- Aliases are **scoped per candidate**: `apply.ts` holds `Map<candidateIndex, Map<alias, factId>>`. An op for candidate *i* resolving an alias outside candidate *i*'s map is an invalid target.
- Runs through `BoundedLlmCall` (truncation → split batch ladder).
- Output, one per candidate: `ADD` | `UPDATE { target, title?, body? }` (same truth, refined detail) | `SUPERSEDE { target, valid_from? }` (prior truth ended) | `NOOP { target }`.

### 5.5 Step 5 — apply (one transaction)

- Invalid / missing target → `ADD` + `librarian_op_rejected` diagnostic.
- `UPDATE` edits in place only when target is `librarian_inferred`; otherwise converted to `SUPERSEDE`. Emits `fact_updated` event.
- `SUPERSEDE` calls Phase A `supersede()` semantics. Target `immutable_document` → candidate stored as **draft** + `contradicts_document` diagnostic.
- `valid_from` default: the candidate's `source_event`'s `occurred_at ?? created_at`; if missing/invalid, the newest event in the batch. The superseded fact's `valid_to` equals the new fact's `valid_from`.
- **Edges on SUPERSEDE:** the new fact carries only the edges extracted for it in step 1; no automatic re-linking. The old fact's edges remain intact for `asOf` history. Accepted tradeoff: third-party edges *into* the old fact become non-traversable in current views. Revisit only if Phase D numbers show it matters.
- Grounding, ontology validation, edge persistence, search sync, and outbox writes follow the existing librarian code paths.

### 5.6 Failure handling

- Extract failure → watermark not advanced (same guarantee as today's checkpoint rollback).
- Resolve failure for a chunk after the bounded ladder → those candidates stored as **drafts** + `resolve_failed` diagnostic. Nothing silently dropped.

### 5.7 Out of scope for B

Heal's model-directed contradiction delete is unchanged (8.0.0 follow-up).

### 5.8 Tests

All ~30 supersession scenarios in replay mode; each gate boundary; per-candidate alias scoping (candidate 2's `n1` never resolves to candidate 1's neighbour); invalid-target fallback; UPDATE→SUPERSEDE conversion; immutable-target draft path; resolve-failure draft path; `valid_from` defaulting; **legacy parity** — `strategy: 'legacy'` output identical before/after the move.

## 6. Phase C — budgeted and deferred maintenance

### 6.1 Mode

`config.maintenance: 'auto' | 'deferred'` (default `'auto'`). In `'deferred'`, `write()` records the event and **never starts a background promise** (no librarian, no heal, no reembed).

### 6.2 API

- `getPendingMaintenance(entityId?)` → per entity `{ pendingEvents, pendingTokensEstimate, healDue, reembedPending }`. SQL only, no LLM.
- `runPendingMaintenance({ entityIds?, tokenBudget?, deadlineMs?, jobs? })`:
  - Job order per entity: librarian → heal → reembed (`jobs` filters).
  - **Fair share:** entities ordered by backlog; each round runs **one batch per entity**, looping rounds until budget, deadline, or work is exhausted. A chatty entity cannot starve others.
  - Librarian batches are sized to the remaining budget.
  - Pre-flight: before each LLM call, estimate prompt tokens; if it does not fit the remaining budget, stop that entity's job for this run.
  - If the smallest possible unit (one event for librarian, one candidate for heal, one fact for reembed) exceeds the **whole** budget: `stoppedReason = { reason: 'budget_too_small', job, entityId, requiredEstimate }`. Never loops.
  - Other stop reasons: `'deadline'`, `'budget_exhausted'`, `'complete'`.
  - Returns `{ perEntity, tokensUsed, estimated: boolean, remaining, stoppedReason }`.
  - **Fully awaitable**: nothing runs after the promise resolves. Safe to push the SQLite file immediately after.
  - Holds the same per-entity `JobManager` locks as manual runs.
- `drain(): Promise<void>` — in `'auto'` mode, awaits all in-flight background jobs (Clanker on `AppState` background, Curated Thoughts on quit). No-op in `'deferred'`.
- `config.autoLibrarianTokenThreshold?: number` — in `'auto'`, the librarian also triggers when pending-event token estimate crosses it (OR with the count threshold).

### 6.3 Token accounting

- New optional provider method `generateTextWithUsage?(params): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>`. When present the engine calls it instead of `generateText`. **`generateText`'s signature is unchanged** (widening its return type would break hosts that call it typed as `LLMProvider['generateText']`). Same `this`-binding contract as `generateText`.
- Estimation (both pre-flight and missing-usage fallback) is **chars / 4**, no tokenizer dependency. Hosts wanting headroom pass a smaller budget.
- Every LLM call emits `llm_usage` `{ operation, inputTokens, outputTokens, estimated }` via `onDiagnostic` — SynapseTree metering and Phase D's rerun both consume it. The diagnostic union and its content-free guarantee are extended accordingly.

### 6.4 Crash safety and pruning

- In deferred mode the watermark advances **only after a batch commits**. A killed invocation re-runs that batch next time; nothing is lost and nothing is duplicated.
- `runPrune` must **not** delete events after the librarian watermark (unprocessed), regardless of `pruneEventsAfter`. Emits a diagnostic when retention is held back by an unprocessed backlog.

### 6.5 Host responsibilities (documented, not implemented)

- Cross-process single-writer per SQLite file (`JobManager` locks are in-process only). SynapseTree's sticky routing must guarantee it.
- `entity_id` scheme per tenant file (SynapseTree review finding M4).

### 6.6 Tests

Deferred `write()` spawns nothing; budget boundaries; `budget_too_small` per job; deadline; fair-share ordering across three entities with skewed backlogs; mid-batch throw leaves watermark unchanged; prune spares unprocessed events; `drain()`; provider with and without `generateTextWithUsage`; token-threshold auto trigger.

## 7. Phase D — budgeted reads, benchmark rerun, docs

### 7.1 Budgeted reads

- `read(entityId, query, { tokenBudget? })` and `traverseGraph(…, { tokenBudget? })`.
- Greedy packing by score ÷ estimated tokens (chars / 4); always include the top-scoring item (body truncated if it alone exceeds the budget). Traversal packs in BFS order. No knapsack solver.
- `formatContext` gains a compact mode (title + body, no metadata lines).
- Diagnostic `read_budget` `{ candidates, packed, tokensUsed }`.

### 7.2 Benchmark rerun

Rerun Phase 0 with `strategy: 'ops'`, `maintenance: 'deferred'` (run to quiescence), and a read `tokenBudget`. Commit `results/report-7.8.0.json` and `docs/benchmarks.md` comparing against baseline: per-category accuracy, ingestion tokens, tokens per answer, latency. **Numbers are published as measured**, including any category where ops underperforms legacy.

### 7.3 Docs

- `docs/synapsetree-integration.md`: recommended config (`ops`, `deferred`, read budget, `onDiagnostic` → metering, `occurred_at` from requests); request lifecycle (pull `.sqlite` from S3 → `new WikiMemory` + `setup()` → handle → optionally `runPendingMaintenance({ tokenBudget, deadlineMs })` → push); single-writer requirement; `entity_id` options.
- READMEs for core, expo, react: temporal API, strategies, deferred mode, budgets.
- OKF profile doc: temporal extension keys.

### 7.4 Open item

`core-llm-tools` schemas for `history` / `asOf` — only if SynapseTree's MCP surface uses that package. Decided when SynapseTree's MCP design exists; not committed work.

## 8. Out of scope

SynapseTree/hosted code; transaction-time (`knownAt`) queries; a separate triples/claims table; LoCoMo; 8.0.0 default flip; heal supersession; tokenizer dependencies.

## 9. Risks

- **Gate thresholds are embedding-model dependent.** Mitigated by config + Phase 0 live calibration; defaults documented as provisional.
- **Two librarian code paths through 7.x.** Mitigated by the verbatim `legacy/` move and the parity test.
- **Benchmark cost / judge bias.** Mitigated by ingest cache, manual-only runs, and naming the judge in every report.
- **Dev branch drift from `main`.** Merge `main` into the dev branch (merge commit) after each 7.7.x release.
