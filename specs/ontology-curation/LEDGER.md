# LEDGER — ontology-curation (PR #441)

Branch `spec/ontology-curation` · baseline main `e43095c8` · PR #441.
Scope: Tasks 1–12 + the door-receipt slice of Task 13 + Task 14. The
scheduler machinery (the `'ontologyBackfill'` job, the `PendingMaintenance` field, the
`:115` filter widening, the `budget_too_small.job` union member, and the
`node_type_assigned` emitters on the typing paths) is S1-0's (#442) per the
controller decree — the flip clause executed (S1-0 lands first); the reuse
check for the `node_type_assigned` shape runs at rebase.

- [x] **Task 1 — normalized matching in both resolvers.** Evidence: `__tests__/utils/ontology.test.ts` "normalized matching (Task 1)" block (74/74); commit `31c08610`.
- [x] **Task 2 — widened `validateAndNormalizeFact` return (`match` evidence).** Evidence: `__tests__/services/OntologyService.test.ts` "match evidence" block (43/43); commit `03769128`.
- [x] **Task 3 — receipt vocabulary (codes, severities, messages, helpers).** Evidence: `__tests__/ontologyReceiptVocabulary.test.ts` (5/5); commit `87eef4d5`.
- [x] **Task 4 — door duality pinned: receipts only in `upsertGraphCore`; edge door via `resolveEdgeDefinitions`.** Evidence: `__tests__/ontologyReceipts.test.ts` person-door + ingest-door blocks; commit `4fde0f0f`.
- [x] **Task 5 — librarian door receipts (`legacy.ts`, `ops/apply.ts`).** Evidence: `__tests__/services/librarian` suites green; commit `4fde0f0f`.
- [x] **Task 6 — merge rejection reporting (`{ manifest, rejected }` through the whole chain; strict emits `mode_strict`).** Evidence: `__tests__/utils/ontologyMergeRejections.test.ts` (7/7) + receipts suite; commit `4fde0f0f`.
- [x] **Task 7 — `ingest_zero_facts`.** Evidence: receipts suite "ingest_zero_facts receipt" block; commit `4fde0f0f`.
- [x] **Task 8 — partial ingest types and resolves edges against the current manifest.** Evidence: receipts suite "partial ingest typing" block; commit `f5eaba41`.
- [x] **Task 9 — `recheckCheckedBefore` option (all three signature sites).** Evidence: `__tests__/backfillRecheckOption.test.ts` (2/2); commit `9d76fd2a`.
- [x] **Task 10 — typing queue + counts see current facts only (`liveAtSql('current')`).** Evidence: backfillRecheckOption "current facts only" block; commit `9d76fd2a`.
- [x] **Task 11 — lint `nodeTypeViolations` + sampled ids.** Evidence: `__tests__/lint.test.ts` (10/10); commit `c42b69a5`.
- [x] **Task 12 — prompt amendments (ingest, classifier, strict appendix), ruled wording (spec §10).** Evidence: strict appendix carries "choose the closest type the fact is an example of; omit only when none applies even broadly"; backfill prompt carries the same instruction; appendix field block carries the ruled edge sentence verbatim; golden fixture regenerated (intentional diff, 3 lines); prompt assertions in `__tests__/coderabbit441Round2.test.ts`; suite 245 files / 2830 tests green. Commit: see the CodeRabbit round-2 fold commit on this branch (`c42b69a5` carried an earlier draft wording and was superseded by the T4 fold).
- [x] **Task 13 (this PR's slice) — backfill door receipts (`node_type_dropped` / `node_type_folded` in `_applyOntologyBackfillBatch`).** The `'ontologyBackfill'` job, `PendingMaintenance` field, `:115` widening, `budget_too_small.job`, and `node_type_assigned` emitters are **NOT** implemented here (S1-0 #442). Evidence: receipts suite backfill block; commit `4fde0f0f`.
- [x] **Task 14 — integration tests + full suite gate.** Evidence: core 2822/2822, okf 194/194, core-llm-tools 59/59, mcp-server 135/135, react/expo/benchmarks/prisma-outbox green, integration 47/47; `pnpm -r typecheck` clean.

What's in flight: nothing — this branch is complete for its scope. Spec
Status moves to Implemented in the ship-time docs commit.
