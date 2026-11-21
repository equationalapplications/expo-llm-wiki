# Ontology Curation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Machine-typed ontology curation per the approved spec: normalized matching in both resolvers, one edge door, receipts at every type door, merge-rejection reporting, partial-ingest typing, recheck option, current-facts typing queue, lint node-type counts, prompt amendments, and the ruled `'typing'` maintenance job.

**Architecture:** All typing flows through `validateAndNormalizeFact` → `resolveNodeType` (the choke point). This PR widens the resolver matching order, widens the shared check's return to carry fold evidence, and emits content-free receipts through the existing `DiagnosticBuffer` channel at each door. No new storage, no host-facing alias tables.

**Tech Stack:** TypeScript, Expo/React Native monorepo, `pnpm --filter @equationalapplications/core-llm-wiki test` (vitest).

**Spec:** `specs/ontology-curation/spec.md` (APPROVED, owner ruling 2026-11-21; `okf_label` stays deferred). The plan argues from the spec; executors read both. Spec base `origin/main @ e43095c8`; every file:line below was re-verified live on the spec branch at plan time.

## Global Constraints

- Machine curation (OI-2): models decide types; deterministic code only checks them against the manifest. No host-declared alias tables (ruled out).
- Normalized matching never throws on an existing manifest; ambiguity returns null, never an error. It only maps a model's spelling to the manifest's spelling — never changes a slug a person stored.
- All receipts are content-free (slugs and ids only, each slug capped at 64 chars) and emit only when the entity's ontology mode ≠ `'off'` (`MaintenanceService.ts:2071-2074` is the mode-check pattern).
- Person doors (remember, upsertGraph nodes) throw on a type miss under strict; in non-strict modes they store the fact untyped and emit `node_type_dropped` — never throw. Model doors (ingest full/partial, librarian, backfill) never throw on a type, in any mode.
- Backfill never overwrites a stored type (`EntryRepository.ts:1836` guards `okf_type IS NULL`).
- `importDump` stays verbatim — restores `okf_type` as stored, never re-judges.
- No claim of prompt-accuracy improvement anywhere (spec rule 11).
- Commits: author `Tessera <tessera@equational.app>` (`git -c user.name=Tessera -c user.email=tessera@equational.app commit …`). Only files under the repo source paths named in the tasks plus `specs/ontology-curation/plan.md` and (at ship time, Task 14) `specs/ontology-curation/LEDGER.md` + the spec Status line; never merge, undraft, rebase, or force-push.
- Full suite gate: `pnpm --filter @equationalapplications/core-llm-wiki test` passes at every task boundary before commit.

## Merge position and first-lander rule (binding assumption)

**This plan assumes THIS PR (#441) lands first or alone.** Per the spec's boundary section (controller adjudication 2026-11-20): S1-0 (#442) owns `node_type_assigned` emitters on the backfill typing paths (`writer: 'classifier' | 'llm'`); this PR owns the door receipts (`node_type_dropped`, `node_type_folded`, `ontology_update_rejected`, `ingest_zero_facts`). **Whichever PR lands first emits the typing-path `node_type_assigned` receipts with the exact shape in spec §4; the other reuses the code and adds no second emitter.**

Concretely, under the stated assumption:

- Task 13 INCLUDES the `node_type_assigned` emitters on the backfill typing paths, with `writer: 'classifier' | 'llm'`, shape exactly as spec §4.
- Task 13 INCLUDES the `'typing'` job wiring (`MaintenanceJob`, `LockedMaintenanceJob`, default jobs list, pending detection, scheduler dispatch, `EntityMaintenanceReport` fields) — spec §11 is ruled for this PR.

**If the order flips (S1-0 lands first):**

- Task 13's emitter step is REPLACED by a reuse check: verify S1-0's emitters match spec §4's shape (`factId`, `okfType`, `writer`, `confidence?`); if they drift (S1-0 §7 defines the code without `confidence?` and with a fixed severity), reuse S1-0's LANDED shape and adapt this PR's audit-join tests to it — the audit join does not depend on `confidence`, so the landed shape wins; do not add a second emitter. Steps 13.1–13.4 (job-set wiring) shrink to a conflict check: S1-0 §8 adds the same `'typing'` job to `MaintenanceJob` and the default set at `MaintenanceScheduler.ts:112`, and also claims the `PendingMaintenance` typing-pending field and the `:115` filter widening — if present, verify they exist and only fill gaps this spec pins that S1-0 lacks (the section-8-filtered pending query, `typed`/`untypedRemaining` report fields).
- Every other task is unchanged — door receipts, resolvers, edge door, partial ingest, recheck option, queue filter, lint, prompts are exclusively this PR's regions.

**File seams shared with #442 (S1-0)** — both plans must agree; these are the only overlap regions:

1. `MaintenanceService.ts` option-validation block (`:2056-2062`): this PR adds `recheckCheckedBefore` validation beside `batchSize`; S1-0 adds floor/`minConfidence` validation at the same site. Both are append-only one-clause additions; no shared lines.
2. `MaintenanceService.ts` backfill apply path (`~:2280-2450`): S1-0 owns `node_type_assigned` emitters, `classification_abstained`, `classification_low_confidence`, and the slug-cap region (`:2089`). This PR owns the backfill door receipts (`node_type_dropped`/`node_type_folded` at `:2425-2439`, the type-miss sites) plus, under the first-lander rule, the `node_type_assigned` push — both land inside/adjacent to S1-0's loop, so this is a guaranteed textual conflict if both PRs are open; whichever lands second reconciles textually, semantic ownership stays as stated.
3. `MaintenanceService.ts:2085` typing-mode resolution: S1-0 replaces the inline resolution with `resolveSystemOneTyping(config)`. This PR does not touch line 2085 or its neighborhood; the mode ≠ `'off'` gate this PR adds at emitters reads `getEffectiveState`, not the mode-resolution line.
4. `types.ts`: this PR owns `WikiDiagnosticCode` additions (`:872` region), `WikiLintReport` (`:1693-1708`), `MaintenanceJob` (`:1729`), `EntityMaintenanceReport` (`:1769+`), `budget_too_small.job` widening (`:1767`, from `'librarian' | 'heal'`), and the `PendingMaintenance` typing-pending field (`:1734`) — the pending field and the budget-job widening move into Task 13 under the first-lander rule (S1-0 §8 also claims them; the flip clause below covers reconciliation). S1-0 owns `WikiConfig.systemOne`, `SystemOneThresholdSite`. Disjoint fields; both may edit the same union declarations (`MaintenanceJob`, `PendingMaintenance`) — Task 13 states the exact merged shape so whichever lands second reconciles trivially.
5. `MaintenanceScheduler.ts` default job set (`:112`), pending filter (`:115`), `State`/`openJobs`: both specs wire `'typing'` here (S1-0 §8, this PR §11). Under the first-lander rule Task 13 owns the filter widening (today `:115` drops any entity whose only work is typing — spec test 11 would never fire); same merged shape as seam 4.
6. `MaintenanceService.ts:2163-2177` abstained counting and `:2252-2253` floor reads: S1-0 only. This PR does not touch.

**Boundary fences (ordered steps that never cross):** this PR never edits supersede copy, outbox prior-text, or edge-follow re-ingest (PR 4); never adds heal receipts (PR 6); never adds `classification_abstained`, the abstain sentinel, the typing-mode chain, or `systemOne.*` (S1-0 / #442); never adds `typeOnWrite` (PR 5b); never touches `ImportExportService.ts`.

---

### Task 1: Normalized matching in both resolvers

**Files:**
- Modify: `packages/core/src/utils/ontology.ts:17-30` (`resolveNodeType`, `resolveEdgeDefinitions`)
- Test: `packages/core/__tests__/utils/ontology.test.ts` (beside existing resolver tests; service tests live under `packages/core/__tests__/services/`)

**Interfaces:**
- Consumes: `OntologyManifest` (unchanged).
- Produces: same signatures, new matching order. `resolveNodeType(raw, manifest)` → canonical slug or null; `resolveEdgeDefinitions(rawEdgeType, manifest)` → matching edge defs array. New internal helper `normalizeSlug(raw): string` (lowercase; `_`, `-`, and whitespace runs collapse to a single canonical separator) shared by both.

- [ ] **Step 1: Write failing resolver tests.** Cases: exact case-insensitive hit wins over any normalized candidate; unique normalized hit resolves (`relates_to` → `relates-to`); ambiguous normalized query (`a_b` matching both `a-b` and `a b`) returns null / empty respectively; empty/whitespace input returns null / empty; property test — for a fixture corpus of valid manifests and model-style spellings, resolution never throws. Exact-pass first, then normalized, in that order (a manifest containing both `foo_bar` and `foo-bar` resolves `foo_bar` exactly, never ambiguously).
- [ ] **Step 2: Run** `pnpm --filter @equationalapplications/core-llm-wiki test -- ontology` — expect FAIL (normalized cases unresolved).
- [ ] **Step 3: Implement** the two-step order in both resolvers via `normalizeSlug`; build a one-time normalized map per call; accept only a unique normalized match. No throw path exists — ambiguity is null.
- [ ] **Step 4: Run** the resolver tests — PASS, including the property test.
- [ ] **Step 5: Commit** `feat(ontology): unique-normalized fallback in node/edge resolvers`.

### Task 2: Widen `validateAndNormalizeFact` return (mode-free shared check)

**Files:**
- Modify: `packages/core/src/services/OntologyService.ts:103-128`
- Test: beside existing OntologyService tests

**Interfaces:**
- Produces: return type `{ okf_type: string | null; edges: ExtractedFactEdge[]; match?: { raw: string; canonical: string; via: 'exact' | 'normalize' } }`. On a miss `match` is absent. The check stays mode-free; strict handling and edge-drop side effects unchanged. Every existing caller compiles unchanged (new field optional).

- [ ] **Step 1: Failing tests**: exact hit → `match.via === 'exact'`; normalized hit → `via === 'normalize'` with raw + canonical; miss → `match === undefined` and `okf_type === null`; strict miss still throws `WikiStrictOntologyViolation`; edge-drop accumulation unchanged.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the widened return reading Task 1's resolution; callers do not re-run resolution.
- [ ] **Step 4: Run — PASS** plus full OntologyService suite.
- [ ] **Step 5: Commit** `feat(ontology): carry match evidence on validateAndNormalizeFact`.

### Task 3: Receipt vocabulary (types + emission gate)

**Files:**
- Modify: `packages/core/src/types.ts:872` region (`WikiDiagnosticCode`) AND the severity/description tables in `packages/core/src/utils/diagnostics.ts:22-77` (each new code needs a severity entry and a description entry there, or the buffer rejects it)
- Test: type-level + emission-gate unit test (may live with Task 4's tests)

**Interfaces:**
- Produces: codes `node_type_dropped {factId, nodeType, reason}`, `node_type_folded {factId, from, to, via: 'normalize'}`, `node_type_assigned {factId, okfType, writer: 'classifier'|'llm'|'inherited', confidence?}`, `ontology_update_rejected {reason}`, `ingest_zero_facts {sourceRef, chunks}` on `WikiDiagnosticCode`. Shared helper `shouldEmitOntologyReceipt(mode): boolean` (mode ≠ `'off'`) used by every emitter in Tasks 4–7 and 13. Slug values truncated to 64 chars at emission.

- [ ] **Step 1: Add codes + helper with a test asserting suppression at mode `'off'` and emission otherwise.**
- [ ] **Step 2: Run — PASS. Commit** `feat(ontology): diagnostic codes for type outcomes`.

### Task 4: Edge door + door receipts — remember and upsertGraph

**Files:**
- Modify: `packages/core/src/services/IngestionService.ts:719-725` (`upsertGraphCore` edge door: replace the inline `edge_types.filter` with `resolveEdgeDefinitions`; strict-mode edge throws at `:724-725` keep their existing shape; behavior identical when the exact match hits, gains the normalized fallback otherwise); `packages/core/src/services/RememberService.ts:29` region; `packages/core/src/services/IngestionService.ts:646` region (`upsertGraph` node door)
- Test: beside each service's tests

**Interfaces:**
- Consumes: Task 1 resolvers, Task 2 `match`, Task 3 helper. Produces: edge types resolved only through `resolveEdgeDefinitions` (one matching order — the second, unguarded door is gone); at each person door, non-strict miss → store fact untyped + `node_type_dropped`; fold (`via: 'normalize'`) → `node_type_folded`; strict miss → existing `WikiStrictOntologyViolation` throw (shape unchanged).
- **Door duality (pinned):** `runFullUpsertGraph` resolves at `IngestionService.ts:864` but passes the RAW model slug (`:872`) into `upsertGraphCore`, which resolves again at `:646` with `strict: false` — so `:646` is BOTH the person door (host `upsertGraph`) and the full-ingest model door. Emission lives ONLY at `:646`, labelled by the existing `opts.diag.operation` (`'ingest' | 'upsertGraph'`). `:864` must NOT emit — a second emitter there double-reports every fold and breaks spec test 3 (once per fold).

- [ ] **Step 1: Failing tests.** Edge door: a model-style edge slug (`relates_to` vs manifest `relates-to`) resolves and stores the canonical edge type where today it drops; an exact hit behaves byte-identically to today (regression fixture); strict edge miss still throws with the existing shape. Node doors: untypable type in emergent mode → stored with `okf_type: null`, `node_type_dropped` emitted, no throw; untypable in strict → throws; `relates_to`-style slug in either mode → stored canonical with `node_type_folded`; mode `'off'` → no receipts; a slug a person supplied is never rewritten except through the fold (assert stored `okf_type` equals the manifest's canonical slug).
- [ ] **Step 2: Run — FAIL. Implement the edge-door switch and the emission + non-strict store path. Run — PASS. Commit** `feat(ontology): resolve edges via resolveEdgeDefinitions; door receipts at remember and upsertGraph`.

### Task 5: Door receipts — librarian doors

**Files:**
- Modify: `packages/core/src/services/librarian/ops/apply.ts:106` region; `packages/core/src/services/librarian/legacy.ts:156` region
- Test: beside librarian tests

Same contract as Task 4 but model-supplied: never throws in ANY mode; untypable → untyped + `node_type_dropped`; fold → `node_type_folded`; mode `'off'` suppresses.
- [ ] **Step 1: Failing tests** (mirror Task 4's cases minus the strict-throw cases; add "emergent-mode untypable stays queued" assertion).
- [ ] **Step 2: Run — FAIL. Implement. Run — PASS. Commit** `feat(ontology): librarian door receipts`.

### Task 6: Emergent-rejection reporting

**Files:**
- Modify: `packages/core/src/utils/ontology.ts:175-247` (`mergeOntologyUpdates` return); `packages/core/src/services/OntologyService.ts:93-101` (`mergeEmergentUpdates` — middle of the passthrough chain, returns bare `OntologyManifest` today); `packages/core/src/repositories/MetadataRepository.ts:312-321` (passthrough); `packages/core/src/services/IngestionService.ts:855`, `packages/core/src/services/MaintenanceService.ts:2401`, `packages/core/src/services/librarian/legacy.ts:112`, `packages/core/src/services/librarian/ops/apply.ts:92` (four callers)
- Test: beside each; integration test for the receipt surface

**Interfaces:**
- Produces: merge return carries `{ manifest, rejections: RejectedProposal[] }` (same merged manifest bytes as today — first-seen-wins node loop, edge-triple dedupe, parent gate untouched); the return-shape change travels the FULL chain: `mergeOntologyUpdates` → `OntologyService.mergeEmergentUpdates` (`:93-101`) → `MetadataRepository.mergeManifestUpdates` (`:312-321`). Each caller emits `ontology_update_rejected {reason}` per rejected proposal. Strict-mode callers never reach the merge: they emit one `{reason: 'mode_strict'}` receipt per proposal and drop them.

- [ ] **Step 1: Failing merge tests:** the merged manifest is byte-identical to today's output for an existing fixture corpus (regression guard); rejections list carries one entry per dropped proposal with a reason string.
- [ ] **Step 2: Run — FAIL. Implement** the return widening + passthrough. **Run — PASS.**
- [ ] **Step 3: Failing caller tests:** each of the four callers emits per-rejection receipts in `'emergent'` mode; a strict-mode caller emits `'mode_strict'` per proposal; receipts suppress at mode `'off'`.
- [ ] **Step 4: Run — FAIL. Implement. Run — PASS. Commit** `feat(ontology): ontology_update_rejected receipts at all four merge callers`.

### Task 7: `ingest_zero_facts` receipt

**Files:**
- Modify: `packages/core/src/services/IngestionService.ts` — emission site is in `ingestDocument` AFTER the full-path transaction (the `:396-400` region), NOT in `upsertGraphCore` (`:745-750` is inside `upsertGraphCore`, which host `upsertGraph` also calls with `opts.diag.operation: 'upsertGraph'`; `chunks` is only in scope in `ingestDocument`, `:173`)
- Test: beside IngestionService tests

- [ ] **Step 1: Failing test:** re-ingest a `sourceRef` whose new run extracts zero facts → prior facts tombstoned, prior edges soft-deleted, one `ingest_zero_facts {sourceRef, chunks: chunks.length}` receipt, operation `'ingest'`; emission condition: `insertedFacts.length === 0 && deletedSourceFactIds.length > 0` after the transaction commits; a non-empty run emits nothing; a HOST `upsertGraph` with empty nodes emits nothing (guards the site choice); mode `'off'` suppresses.
- [ ] **Step 2: Run — FAIL. Implement** at the `ingestDocument` post-transaction site. **Run — PASS. Commit** `feat(ontology): ingest_zero_facts receipt on empty re-ingest`.

### Task 8: Partial ingest types and resolves

**Files:**
- Modify: `packages/core/src/services/IngestionService.ts` (`appendPartialFacts`; pattern at `:860-868`, title-index build at `:829-836`)
- Test: beside IngestionService tests

- [ ] **Step 1: Failing test:** chunk-failure partial run now stores typed facts with resolved edges (typed against the current manifest via Task 2's shared check; edges resolved against the title index exactly as the full path); a following full run retires those facts and hard-deletes their edges (existing behavior at `EdgeRepository.ts:98`); partial run never merges emergent updates (assert manifest unchanged); `node_type_dropped`/`node_type_folded` fire per Task 4's contract.
- [ ] **Step 2: Run — FAIL. Implement** by routing `appendPartialFacts` through `validateAndNormalizeFact` + title-index edge resolution. **Run — PASS. Commit** `feat(ontology): partial ingest types facts and resolves edges`.

### Task 9: `recheckCheckedBefore` option

**Files:**
- Modify: `packages/core/src/services/MaintenanceService.ts:2062` (`doRunOntologyBackfill` cutoff) AND the option must reach the host through ALL THREE inline signature sites — `WikiMemory.ts:936`, `MaintenanceService.ts:1035` (`runOntologyBackfill` host wrapper), `MaintenanceService.ts:2048` (`doRunOntologyBackfill`). `RunOntologyBackfillOptions` does NOT exist in `types.ts` today (the spec's files-touched list says it does); either extract it as a named type and use it at all three sites, or extend all three inline signatures.
- Test: `packages/core/__tests__/services/` — through `WikiMemory.runOntologyBackfill` (the host surface), not the internal hook

**Interfaces:**
- Produces: `runOntologyBackfill({ recheckCheckedBefore?: number })` end-to-end from `WikiMemory`; cutoff = option when provided, else `now - ONTOLOGY_BACKFILL_RECHECK_MS` (`MaintenanceService.ts:50`). Validation mirrors `batchSize` (`:2056-2059`): non-integer or negative throws. Default unchanged — no host sees new spend.

- [ ] **Step 1: Failing tests (driven through `WikiMemory.runOntologyBackfill`):** `recheckCheckedBefore: 0` re-queues a checked fact; default call does not; `-1` and `1.5` throw; option reaches `findUntypedByEntityId`'s cutoff parameter (asserted via behavior, not internals).
- [ ] **Step 2: Run — FAIL. Implement. Run — PASS. Commit** `feat(ontology): recheckCheckedBefore option on runOntologyBackfill`.

### Task 10: Typing queue sees current facts only

**Files:**
- Modify: `packages/core/src/repositories/EntryRepository.ts:1805-1808` (`findUntypedByEntityId`) AND `:1815-1826` (`countUntypedByEntityId` — same WHERE clause today; it feeds `remaining`/`deferred` at `MaintenanceService.ts:2074, 2080, 2188, 2225, 2350`)
- Test: beside EntryRepository tests

- [ ] **Step 1: Failing tests:** a fact whose validity window is closed leaves BOTH the queue and the count (`remaining` is a documented host convergence signal — loop while `> 0`, `types.ts:137`; an unfiltered count makes that loop spin forever); a live untyped fact stays in both; soft-deleted rows stay excluded (`deleted_at IS NULL` guard untouched); count and find agree on the same fixture; the queries stay single SQL statements (no post-filter that breaks LIMIT). Note: the `temporal.ts:14-18` live-read pattern (`'current'`) also excludes facts whose `valid_from` is in the future — that is intended here (matches the live filter this spec §8 names as the pattern).
- [ ] **Step 2: Run — FAIL. Implement** the validity-window exclusion inside the WHERE clause. **Run — PASS. Commit** `feat(ontology): typing queue excludes expired facts`.

### Task 11: Lint counts node-type violations

**Files:**
- Modify: `packages/core/src/services/LintService.ts:19-50`; `packages/core/src/repositories/LintRepository.ts` (new paging query over live facts — only `pageLiveEdges` exists today, `:47`); `packages/core/src/types.ts:1693-1708` (`WikiLintReport`)
- Test: beside LintService tests

**Interfaces:**
- Produces: `nodeTypeViolations: number`, `nodeTypeViolationIds: string[]` (≤ 20 samples) on `WikiLintReport`. "In the effective manifest" = the normalized resolver (Task 1) resolves the stored slug — never exact-only. The count gates on the same `constrained` mode check `LintService.ts:25` already applies to the edge scan (hosts with ontology `'off'` see no change — spec release-surface rule).

- [ ] **Step 1: Failing tests:** live fact whose stored slug was later removed from the manifest → counted + sampled; untyped facts stay in `untypedFacts` only, never in the new count; a stored slug that normalizes uniquely into a current manifest slug is NOT a violation; dead/soft-deleted facts not counted; sample cap 20; mode `'off'` → both counts zero.
- [ ] **Step 2: Run — FAIL. Implement** the scan mirroring the edge-violation loop (`LintService.ts:29-42`) with the new `LintRepository` paging query. **Run — PASS. Commit** `feat(ontology): lint node-type violation count with normalized matching`.

### Task 12: Prompt amendments

**Files:**
- Modify: `packages/core/src/prompts/ontology.ts:22` (strict appendix rule), `:3-7` (appendix field block), `packages/core/src/prompts.ts:64` (backfill system prompt)
- Test: beside prompt snapshot tests

- [ ] **Step 1: Failing tests:** strict rule reads "choose the closest type the fact is an example of; omit only when none applies even broadly"; backfill prompt carries the same instruction; appendix carries the ruled sentence verbatim: "Each node is a fact. To link two things with an edge, each must exist as its own fact, titled by the same name you use in `target_title`."
- [ ] **Step 2: Run — FAIL. Apply the exact wording (ruled quote — no paraphrase). Run — PASS. Commit** `feat(ontology): prompt amendments per ruled wording`.

### Task 13: `'typing'` maintenance job + typing-path assigned receipts (first-lander step)

**Files:**
- Modify: `packages/core/src/types.ts:1729-1782` (`MaintenanceJob`, `LockedMaintenanceJob`, `jobs` doc comment at `:1759`, `EntityMaintenanceReport` at `:1769+`, `budget_too_small.job` widening at `:1767` — today typed `'librarian' | 'heal'`, must accept `'typing'` or the scheduler's budget path is unreachable); `packages/core/src/services/MaintenanceScheduler.ts:112-115` region (default job set, pending filter widening, `State`/`openJobs`); `packages/core/src/WikiMemory.ts` (public maintenance surface); `packages/core/src/services/MaintenanceService.ts` (job set + backfill apply path)
- Test: beside each; integration test for the receipt surface

**Interfaces:**
- Produces: `'typing'` as fifth `MaintenanceJob` member; `LockedMaintenanceJob` keeps it (unlike `'externalDeletions'`); default jobs list includes `'typing'`. **Lock (pinned):** the real lock is the `JobManager` operation `'ontologyBackfill'` (`JobManager.ts:13`, taken at `MaintenanceService.ts:1037`) — the typing pass calls `doRunOntologyBackfill` UNDER that existing lock (never a `acquireLock('typing', …)`, which doesn't compile) with the scheduler's shared `meter`, so a host's own `runOntologyBackfill` cannot race the scheduler's pass on the same entity; `'typing'` is reported in `busy[]` via `LockedMaintenanceJob`. Pending detection: a new typing-pending field on `PendingMaintenance` (`types.ts:1734`) set by `getPending` (`MaintenanceScheduler.ts:47-86`) from Task 10's filtered `findUntypedByEntityId`, and the filter at `MaintenanceScheduler.ts:115` widened so an entity whose ONLY work is typing is no longer dropped (today it checks only `pendingEvents`/`healDue`/`reembedPending` — without this widening spec test 11 never fires). The scheduler has no ontology service injected (`MaintenanceScheduler.ts:30-40`): the mode ≠ `'off'` pending check routes through `maintenanceService`, which is injected. **Exit rules (adopt S1-0 §8's, so both plans agree):** typing pending clears when `remaining === 0`, on `budgetStop`, or when a pass types nothing; facts whose classify call threw are not stamped (`MaintenanceService.ts:2302-2303`) and stay eligible — the nothing-typed exit is what stops the scheduler from spinning to the deadline on a failing provider. Scheduler `trigger`: reuse the existing `'call'` the backfill paths already hard-code (`:2282`, `:2333`, `:2387`). One typing unit = one `runOntologyBackfill` batch for the entity, charged against the host `tokenBudget` via the per-batch estimate; `EntityMaintenanceReport` gains `typed: number` and `untypedRemaining: number` (fed from Task 10's filtered count).
- **Assigned-receipt plumbing (pinned):** `node_type_assigned {factId, okfType, writer: 'classifier'|'llm', confidence?}` receipts on the backfill typing paths (first-lander rule; `'inherited'` fires only in PR 4 and is NOT emitted here). Placement: fires ONLY when `result.changes > 0` (the `:2444` region), once per typed fact — not once per classification. `_applyOntologyBackfillBatch` gains a `writer` (and optional confidence) parameter so it knows which path called it; `classifications` carries confidence through (today it is dropped at `:2311`). Shape is spec §4's exactly — it is the contract S1-0 must reuse (see the flip clause for the landed-shape-wins rule).

- [ ] **Step 1: Failing tests:** mode ≠ `'off'` entity with untyped facts is typed inside `runPendingMaintenance` within the host-passed budget; mode `'off'` entity never dispatched; a write triggers no typing (no typing job enqueue on any write path); an entity whose ONLY pending work is typing is NOT dropped by the `:115` filter; an entity with no untyped facts reports `typed: 0, untypedRemaining: 0` and no dispatch; a pass where every classify call throws exits (pending clears / no infinite dispatch) rather than spinning to the deadline; typing pass holds the `'ontologyBackfill'` lock (a concurrent host `runOntologyBackfill` on the same entity serializes, and `busy[]` reports `'typing'`); `'typing'` appears in `budget_too_small.job`; `node_type_assigned` fires once per typed fact, only when `changes > 0`, with shape matching spec §4 byte-faithfully.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the union/doc/default-list changes, scheduler pending check + dispatch (mode route via `maintenanceService`), `WikiMemory` surface, report fields, the lock usage, the exit rules, the emitter plumbing, the backfill door receipts (`node_type_dropped`/`node_type_folded` at the `:2425-2439` type-miss sites — spec §4 says every door; without these the Task 14 audit join has no dropped side), and the `node_type_assigned` push beside S1-0's loop region (seam 2). Touch no `classification_*` line.
- [ ] **Step 4: Release notes (required by spec §11):** the PR/commit body states that typing joins the `runPendingMaintenance` default job set for mode ≠ `'off'` entities inside the host token budget, and that nothing triggers typing on a write. It cannot go in `CHANGELOG.md` (repo AGENTS.md), so the PR description carries it.
- [ ] **Step 5: Run — PASS. Commit** `feat(ontology): typing job in runPendingMaintenance with node_type_assigned and backfill door receipts`.

### Task 14: Integration tests + full suite gate

**Files:**
- Create/extend: integration tests for the receipt surfaces (diagnostic flush-after-commit ordering asserted once, mirroring `MaintenanceService.ts:2332-2348`)

- [ ] **Step 1: Integration tests:** end-to-end — ingest with mixed-slug manifest → folds + drops + assigned receipts across the flushed buffers, audit join reconstructed for a backfill-typed fact (`factId` join between `node_type_dropped` and `node_type_assigned`); NOTE ingest and backfill are separate operations with separate `DiagnosticBuffer`s — the join asserts across TWO flushes joined on `factId`, not one buffer; zero-fact re-ingest surface; strict-mode caller emits `'mode_strict'` per proposal.
- [ ] **Step 2: Run the full gate:** `pnpm --filter @equationalapplications/core-llm-wiki test` — PASS.
- [ ] **Step 3: Housekeeping:** create `specs/ontology-curation/LEDGER.md` (required by `specs/README.md:17,42` to ship with the plan — this is the one file outside the source paths the commit-scope rule names); update the spec's Status line when the work ships (repo AGENTS.md spec-status honesty rule).
- [ ] **Step 4: Commit** `test(ontology): receipt-surface integration coverage` (LEDGER + spec status fold in a follow-up docs commit at ship time).

## Test plan (traceability to spec)

Spec test-plan items 1–12 map to Tasks 1 (1), 4 (2 and the §2 edge door; `:646` emits for both the person and full-ingest callers), 3+4+13 (3), 6 (4), 7 (5), 8 (6), 9 (7), 10 (8), 11 (9), 12 (10), 13 (11 and the backfill door receipts), 14 (12). Spec §1→Task 1, §2→Task 4, §3→Tasks 4–5 (doors/throws split), §4→Tasks 2–5+13, §5→Task 6, §6→Task 8, §7→Task 9, §8→Task 10, §9→Task 11, §10→Task 12, §11→Task 13. No spec section or test item is unowned.

## Out of scope (fenced — a reviewer should flag any step that crosses)

PR 4: supersede edge-copy, inbound-edge index, `writer: 'inherited'` emissions, host `supersede()` type parameter, outbox prior-text receipts, `librarian.destructiveEdits: 'retain'`, edge-follow re-ingest by `sourceRef`. PR 6: heal receipts, heal "replaces" link. S1-0 (#442): typing-mode resolution chain (`engineDefaults.ts`), `minConfidence` floor, `systemOne.onLowConfidence`, abstain sentinel + cap-254 region, `classification_abstained`. PR 5b: `typeOnWrite`. `importDump` verbatim. `okf_label` extraction follow-up: deferred by owner ruling 2026-11-21 — its absence here is compliance, not omission.

## Status

| Rev | Date | Change |
|---|---|---|
| r1 | 2026-11-21 | Initial plan from approved spec; first-lander rule and S1-0 seams named. |
| r2 | 2026-11-21 | T3 gate fold (Opus, $1.67, REQUEST CHANGES → folded): B1 lock/pending-field/budget-job ownership moved into Task 13; M1 full-ingest door duality pinned at `:646` (no emitter at `:864`) and backfill door receipts added; M2 `countUntypedByEntityId` filtered with the queue; M3 `ingest_zero_facts` site moved to `ingestDocument` post-transaction; M4 option reaches the host through all three signatures, tested via `WikiMemory`; M5 assigned-receipt plumbing (writer/confidence param, `changes > 0` gate, severity table) and S1-0 shape-drift rule; M6 scheduler exit rules + trigger named; m1–m7 (merge passthrough chain, test paths, `LintRepository` query + mode gate, two-flush join, LEDGER/release-note/spec-status housekeeping, scheduler mode route, seam-2 conflict wording) folded. |

## Controller coordination decree (2026-11-21)

1. **Scheduler machinery (R-MAINT-TYPING):** S1-0 (#442) owns it unconditionally — its plan implements §8 in full with no collapse contingency. **Task 13 therefore executes the flip clause as written for the "S1-0 lands first" case:** this PR carries the queue/data work and its door receipts; the `'typing'` job, `PendingMaintenance` field, `:115` filter widening, and `budget_too_small.job` union member arrive with S1-0 and are adopted as reuse (gap-fill only if #441 somehow merges first). Coding order is S1-0 first, per roadmap step 5.
2. **Abstain-slug rejection framing:** adopted from the S1-0 plan as ratified by the controller — rejection lives in the write path (`setOntologyManifest`) and the `mergeEmergentUpdates` filter; per-read `validateManifest` stays untouched. This is exactly this spec's rejected-alternatives position (per-read reservation), so no spec change is needed.
