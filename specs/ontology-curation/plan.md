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
- Commits: author `Tessera <tessera@equational.app>` (`git -c user.name=Tessera -c user.email=tessera@equational.app commit …`). Only files under repo source paths named here plus `specs/ontology-curation/plan.md`; never merge, undraft, rebase, or force-push.
- Full suite gate: `pnpm --filter @equationalapplications/core-llm-wiki test` passes at every task boundary before commit.

## Merge position and first-lander rule (binding assumption)

**This plan assumes THIS PR (#441) lands first or alone.** Per the spec's boundary section (controller adjudication 2026-11-20): S1-0 (#442) owns `node_type_assigned` emitters on the backfill typing paths (`writer: 'classifier' | 'llm'`); this PR owns the door receipts (`node_type_dropped`, `node_type_folded`, `ontology_update_rejected`, `ingest_zero_facts`). **Whichever PR lands first emits the typing-path `node_type_assigned` receipts with the exact shape in spec §4; the other reuses the code and adds no second emitter.**

Concretely, under the stated assumption:

- Task 13 INCLUDES the `node_type_assigned` emitters on the backfill typing paths, with `writer: 'classifier' | 'llm'`, shape exactly as spec §4.
- Task 13 INCLUDES the `'typing'` job wiring (`MaintenanceJob`, `LockedMaintenanceJob`, default jobs list, pending detection, scheduler dispatch, `EntityMaintenanceReport` fields) — spec §11 is ruled for this PR.

**If the order flips (S1-0 lands first):**

- Task 13's emitter step is REPLACED by a reuse check: verify S1-0's emitters match spec §4's shape (`factId`, `okfType`, `writer`, `confidence?`); if they drift, adapt this PR's audit-join tests to the landed shape — do not add a second emitter. Steps 13.1–13.4 (job-set wiring) shrink to a conflict check: S1-0 §8 adds the same `'typing'` job to `MaintenanceJob` and the default set at `MaintenanceScheduler.ts:112`; if present, verify pending detection and report fields exist and only fill gaps this spec pins (the section-8-filtered pending query, `typed`/`untypedRemaining` report fields) that S1-0 lacks.
- Every other task is unchanged — door receipts, resolvers, edge door, partial ingest, recheck option, queue filter, lint, prompts are exclusively this PR's regions.

**File seams shared with #442 (S1-0)** — both plans must agree; these are the only overlap regions:

1. `MaintenanceService.ts` option-validation block (`:2056-2062`): this PR adds `recheckCheckedBefore` validation beside `batchSize`; S1-0 adds floor/`minConfidence` validation at the same site. Both are append-only one-clause additions; no shared lines.
2. `MaintenanceService.ts` backfill apply loop (`~:2280-2350`): S1-0 owns `node_type_assigned` emitters, `classification_abstained`, `classification_low_confidence`, and the slug-cap region (`:2089`). This PR does not touch these lines under the first-lander rule's emit step except adding the `node_type_assigned` push immediately where typing commits (see Task 13); under the flip, zero edits here.
3. `MaintenanceService.ts:2085` typing-mode resolution: S1-0 replaces the inline resolution with `resolveSystemOneTyping(config)`. This PR does not touch line 2085 or its neighborhood; the mode ≠ `'off'` gate this PR adds at emitters reads `getEffectiveState`, not the mode-resolution line.
4. `types.ts`: this PR owns `WikiDiagnosticCode` additions (`:872` region), `WikiLintReport` (`:1693-1708`), `MaintenanceJob` (`:1729`), `EntityMaintenanceReport` (`:1769+`), `RunOntologyBackfillOptions`. S1-0 owns `WikiConfig.systemOne`, `SystemOneThresholdSite`, `PendingMaintenance` typing-pending field (`:1734`), `OntologyBackfillResult` (`:126-127`). Disjoint fields; both may edit the same union declarations (`MaintenanceJob`, `PendingMaintenance`) — Task 13 states the exact merged shape so whichever lands second reconciles trivially.
5. `MaintenanceScheduler.ts` default job set (`:112`) and pending filter (`:115`): both specs wire `'typing'` here (S1-0 §8, this PR §11). Same merged shape as seam 4.
6. `MaintenanceService.ts:2163-2177` abstained counting and `:2252-2253` floor reads: S1-0 only. This PR does not touch.

**Boundary fences (ordered steps that never cross):** this PR never edits supersede copy, outbox prior-text, or edge-follow re-ingest (PR 4); never adds heal receipts (PR 6); never adds `classification_abstained`, the abstain sentinel, the typing-mode chain, or `systemOne.*` (S1-0 / #442); never adds `typeOnWrite` (PR 5b); never touches `ImportExportService.ts`.

---

### Task 1: Normalized matching in both resolvers

**Files:**
- Modify: `packages/core/src/utils/ontology.ts:17-30` (`resolveNodeType`, `resolveEdgeDefinitions`)
- Test: `packages/core/src/utils/__tests__/ontology.test.ts` (beside existing resolver tests)

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
- Modify: `packages/core/src/types.ts:872` region (`WikiDiagnosticCode`)
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
- Modify: `packages/core/src/utils/ontology.ts:175-247` (`mergeOntologyUpdates` return); `packages/core/src/repositories/MetadataRepository.ts:312-321` (passthrough); `packages/core/src/services/IngestionService.ts:855`, `packages/core/src/services/MaintenanceService.ts:2401`, `packages/core/src/services/librarian/legacy.ts:112`, `packages/core/src/services/librarian/ops/apply.ts:92` (four callers)
- Test: beside each; integration test for the receipt surface

**Interfaces:**
- Produces: merge return carries `{ manifest, rejections: RejectedProposal[] }` (same merged manifest bytes as today — first-seen-wins node loop, edge-triple dedupe, parent gate untouched); `MetadataRepository.mergeManifestUpdates` passes rejections through. Each caller emits `ontology_update_rejected {reason}` per rejected proposal. Strict-mode callers never reach the merge: they emit one `{reason: 'mode_strict'}` receipt per proposal and drop them.

- [ ] **Step 1: Failing merge tests:** the merged manifest is byte-identical to today's output for an existing fixture corpus (regression guard); rejections list carries one entry per dropped proposal with a reason string.
- [ ] **Step 2: Run — FAIL. Implement** the return widening + passthrough. **Run — PASS.**
- [ ] **Step 3: Failing caller tests:** each of the four callers emits per-rejection receipts in `'emergent'` mode; a strict-mode caller emits `'mode_strict'` per proposal; receipts suppress at mode `'off'`.
- [ ] **Step 4: Run — FAIL. Implement. Run — PASS. Commit** `feat(ontology): ontology_update_rejected receipts at all four merge callers`.

### Task 7: `ingest_zero_facts` receipt

**Files:**
- Modify: `packages/core/src/services/IngestionService.ts` (site (d)–(e), the post-soft-delete region around `:745-750`)
- Test: beside IngestionService tests

- [ ] **Step 1: Failing test:** re-ingest a `sourceRef` whose new run extracts zero facts → prior facts tombstoned, prior edges soft-deleted, one `ingest_zero_facts {sourceRef, chunks}` receipt, operation `'ingest'`; a non-empty run emits nothing; mode `'off'` suppresses.
- [ ] **Step 2: Run — FAIL. Implement** the count check after step (f) completes (emit only when the transaction's write count is zero). **Run — PASS. Commit** `feat(ontology): ingest_zero_facts receipt on empty re-ingest`.

### Task 8: Partial ingest types and resolves

**Files:**
- Modify: `packages/core/src/services/IngestionService.ts` (`appendPartialFacts`; pattern at `:860-868`, title-index build at `:829-836`)
- Test: beside IngestionService tests

- [ ] **Step 1: Failing test:** chunk-failure partial run now stores typed facts with resolved edges (typed against the current manifest via Task 2's shared check; edges resolved against the title index exactly as the full path); a following full run retires those facts and hard-deletes their edges (existing behavior at `EdgeRepository.ts:98`); partial run never merges emergent updates (assert manifest unchanged); `node_type_dropped`/`node_type_folded` fire per Task 4's contract.
- [ ] **Step 2: Run — FAIL. Implement** by routing `appendPartialFacts` through `validateAndNormalizeFact` + title-index edge resolution. **Run — PASS. Commit** `feat(ontology): partial ingest types facts and resolves edges`.

### Task 9: `recheckCheckedBefore` option

**Files:**
- Modify: `packages/core/src/services/MaintenanceService.ts:2062` (`doRunOntologyBackfill` cutoff), `types.ts` (`RunOntologyBackfillOptions`)
- Test: beside MaintenanceService tests

**Interfaces:**
- Produces: `runOntologyBackfill({ recheckCheckedBefore?: number })`; cutoff = option when provided, else `now - ONTOLOGY_BACKFILL_RECHECK_MS` (`MaintenanceService.ts:50`). Validation mirrors `batchSize` (`:2056-2059`): non-integer or negative throws. Default unchanged — no host sees new spend.

- [ ] **Step 1: Failing tests:** `recheckCheckedBefore: 0` re-queues a checked fact; default call does not; `-1` and `1.5` throw; option flows through to `findUntypedByEntityId`'s cutoff parameter.
- [ ] **Step 2: Run — FAIL. Implement. Run — PASS. Commit** `feat(ontology): recheckCheckedBefore option on runOntologyBackfill`.

### Task 10: Typing queue sees current facts only

**Files:**
- Modify: `packages/core/src/repositories/EntryRepository.ts:1805-1808` (`findUntypedByEntityId`)
- Test: beside EntryRepository tests

- [ ] **Step 1: Failing tests:** a fact whose validity window is closed (ended before now, per the `temporal.ts:14-18` live-filter pattern used at `RetrievalService.ts:169-170`) leaves the queue; a live untyped fact stays; soft-deleted rows stay excluded (`deleted_at IS NULL` guard untouched); the query stays a single SQL statement (no post-filter that breaks LIMIT).
- [ ] **Step 2: Run — FAIL. Implement** the validity-window exclusion inside the WHERE clause. **Run — PASS. Commit** `feat(ontology): typing queue excludes expired facts`.

### Task 11: Lint counts node-type violations

**Files:**
- Modify: `packages/core/src/services/LintService.ts:19-50`; `packages/core/src/types.ts:1693-1708` (`WikiLintReport`)
- Test: beside LintService tests

**Interfaces:**
- Produces: `nodeTypeViolations: number`, `nodeTypeViolationIds: string[]` (≤ 20 samples) on `WikiLintReport`. "In the effective manifest" = the normalized resolver (Task 1) resolves the stored slug — never exact-only.

- [ ] **Step 1: Failing tests:** live fact whose stored slug was later removed from the manifest → counted + sampled; untyped facts stay in `untypedFacts` only, never in the new count; a stored slug that normalizes uniquely into a current manifest slug is NOT a violation; dead/soft-deleted facts not counted; sample cap 20.
- [ ] **Step 2: Run — FAIL. Implement** the scan mirroring the edge-violation loop (`LintService.ts:29-42`). **Run — PASS. Commit** `feat(ontology): lint node-type violation count with normalized matching`.

### Task 12: Prompt amendments

**Files:**
- Modify: `packages/core/src/prompts/ontology.ts:22` (strict appendix rule), `:3-7` (appendix field block), `packages/core/src/prompts.ts:64` (backfill system prompt)
- Test: beside prompt snapshot tests

- [ ] **Step 1: Failing tests:** strict rule reads "choose the closest type the fact is an example of; omit only when none applies even broadly"; backfill prompt carries the same instruction; appendix carries the ruled sentence verbatim: "Each node is a fact. To link two things with an edge, each must exist as its own fact, titled by the same name you use in `target_title`."
- [ ] **Step 2: Run — FAIL. Apply the exact wording (ruled quote — no paraphrase). Run — PASS. Commit** `feat(ontology): prompt amendments per ruled wording`.

### Task 13: `'typing'` maintenance job + typing-path assigned receipts (first-lander step)

**Files:**
- Modify: `packages/core/src/types.ts:1729-1782` (`MaintenanceJob`, `LockedMaintenanceJob`, `jobs` doc comment at `:1759`, `EntityMaintenanceReport` at `:1769+`); `packages/core/src/services/MaintenanceScheduler.ts:112-115` region; `packages/core/src/WikiMemory.ts` (public maintenance surface); `packages/core/src/services/MaintenanceService.ts` (job set + backfill apply path)
- Test: beside each; integration test for the receipt surface

**Interfaces:**
- Produces: `'typing'` as fifth `MaintenanceJob` member; `LockedMaintenanceJob` keeps it (unlike `'externalDeletions'`); default jobs list includes `'typing'`; pending detection uses Task 10's filtered `findUntypedByEntityId` — rows present ⇒ pending typing, checked by `getPendingMaintenance` and `MaintenanceScheduler` before dispatch; one typing unit = one `runOntologyBackfill` batch for the entity, charged against the host `tokenBudget` via the per-batch estimate; `EntityMaintenanceReport` gains `typed: number` and `untypedRemaining: number`; `node_type_assigned {factId, okfType, writer: 'classifier'|'llm', confidence?}` receipts emitted on the backfill typing paths (first-lander rule; `'inherited'` fires only in PR 4 and is not emitted here).

- [ ] **Step 1: Failing tests:** mode ≠ `'off'` entity with untyped facts is typed inside `runPendingMaintenance` within the host-passed budget; mode `'off'` entity never dispatched; a write triggers no typing (no typing job enqueue on any write path); an entity with no untyped facts reports `typed: 0, untypedRemaining: 0` and no dispatch; `'typing'` is lockable (busy/`LockedMaintenanceJob` accepts it); `node_type_assigned` shape matches spec §4 exactly (this is the shape S1-0 must reuse — the contract travels in the spec, keep it byte-faithful).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the union/doc/default-list changes, scheduler pending check + dispatch, `WikiMemory` surface, report fields, and the emitters beside the typing commit sites in the backfill apply path (the region named in seam 2 — add only the `node_type_assigned` push; touch no `classification_*` line).
- [ ] **Step 4: Run — PASS. Commit** `feat(ontology): typing job in runPendingMaintenance with node_type_assigned receipts`.

### Task 14: Integration tests + full suite gate

**Files:**
- Create/extend: integration tests for the receipt surfaces (diagnostic flush-after-commit ordering asserted once, mirroring `MaintenanceService.ts:2332-2348`)

- [ ] **Step 1: Integration tests:** end-to-end — ingest with mixed-slug manifest → folds + drops + assigned receipts in one flushed buffer, audit join reconstructed for a backfill-typed fact (`factId` join between `node_type_dropped` and `node_type_assigned`); zero-fact re-ingest surface; strict-mode caller emits `'mode_strict'` per proposal.
- [ ] **Step 2: Run the full gate:** `pnpm --filter @equationalapplications/core-llm-wiki test` — PASS.
- [ ] **Step 3: Commit** `test(ontology): receipt-surface integration coverage`.

## Test plan (traceability to spec)

Spec test-plan items 1–12 map to Tasks 1 (1), 4 (2 and the §2 edge door), 3+4+13 (3), 6 (4), 7 (5), 8 (6), 9 (7), 10 (8), 11 (9), 12 (10), 13 (11), 14 (12). Spec §1→Task 1, §2→Task 4, §3→Tasks 4–5 (doors/throws split), §4→Tasks 2–5+13, §5→Task 6, §6→Task 8, §7→Task 9, §8→Task 10, §9→Task 11, §10→Task 12, §11→Task 13. No spec section or test item is unowned.

## Out of scope (fenced — a reviewer should flag any step that crosses)

PR 4: supersede edge-copy, inbound-edge index, `writer: 'inherited'` emissions, host `supersede()` type parameter, outbox prior-text receipts, `librarian.destructiveEdits: 'retain'`, edge-follow re-ingest by `sourceRef`. PR 6: heal receipts, heal "replaces" link. S1-0 (#442): typing-mode resolution chain (`engineDefaults.ts`), `minConfidence` floor, `systemOne.onLowConfidence`, abstain sentinel + cap-254 region, `classification_abstained`. PR 5b: `typeOnWrite`. `importDump` verbatim. `okf_label` extraction follow-up: deferred by owner ruling 2026-11-21 — its absence here is compliance, not omission.

## Status

| Rev | Date | Change |
|---|---|---|
| r1 | 2026-11-21 | Initial plan from approved spec; first-lander rule and S1-0 seams named. |
