# Release 8.0.0: ops + deferred defaults and `wiki_*` tool-name removal

**Status:** Implemented (2026-11-09, ships via PR #342 — merging it publishes 8.0.0).
**Date:** 2026-11-09
**Branch:** `feat/8.0.0`
**Source baseline:** `65d9318b` (7.17.1 + #338, #339)

## Merge blockers

Merging this PR publishes 8.0.0. Don't merge until all are done:

- [x] (a) A minor release after 7.17.0 has shipped (#324 floor). 7.18.0 shipped via #346 and is on npm (confirmed 2026-11-09).
- [x] (b) clanker's default flip is settled. `src/services/wikiService.ts` sets neither `librarian.strategy` nor `maintenance` and relies on `autoLibrarianThreshold` and `autoHealThreshold`. Clanker PR #905 (merged to `staging` 2026-11-09, `814479dc`) pins `'legacy'` and `'auto'`.
- [x] (c) #318 is settled: measured in #343, no gate variant needed, F8 accepted by the owner on 2026-11-09. The issue was closed the same day with the unrun measurements waived.
- [x] (d) Expo SDK 58 is merged (#340). The node-forge clause is **waived by the owner's merge-now ruling of 2026-11-09**: 8.0.0 ships before 1.4.2 clears the gate (2026-11-10 14:09 UTC), and the bump — a `chore(deps)` that cuts no release — lands on main 2026-11-10 and reaches npm at the next release-cutting merge.

## Rulings

Owner rulings, 2026-11-09, given in session in answer to explicit questions:

1. 8.0.0 flips **both** defaults: `librarian.strategy` `'legacy'` → `'ops'`, and `maintenance` `'auto'` → `'deferred'`.
2. 8.0.0 removes the deprecated tool names per #324.
3. 2026-11-09, post-review: merge #342 once checks are green and review threads are clear, **before** the node-forge gate clears. The owner chose the trade-off knowingly: 8.0.0 carries node-forge 1.3.x with 9 open Dependabot alerts, and the 1.4.2 fix (a `chore(deps)` that cuts no release) waits on main for the next release-cutting merge.

**The flips were ruled without benchmark evidence.** LongMemEval is unrun by the owner's choice, and the 7.8.0 supersession results are the only published comparison. So this release makes no accuracy or cost claim about the new defaults.

## Intent check

- Rule 7 (nothing spends your allowance invisibly): `'deferred'` makes it the default. Rule 7's Status is updated by the amendment in this PR.
- Rule 11 (benchmarks gate behavior changes): the rule says a change "is measured before it is claimed". This release changes behavior and claims nothing; docs say the defaults are unbenchmarked. The amendment records that.
- Out-of-scope line ("flipping … before an explicit 8.0.0 ruling"): the ruling above satisfies it, and the line is updated.

## Host audit

No tool-name migration is needed in the sibling repos (audited 2026-11-09):

- clanker imports only `getCurrentTimeManifest`, `escalateToCloudManifest`, `googleSearchManifest`, `buildAuthorizedToolsArray` and `GeminiToolEntry` from `core-llm-tools`. Its `wiki_*` tools are hand-written.
- curated-thoughts has no `core-llm-tools` dependency.
- curated-thoughts-integrations has no package dependency.

So #324's migration condition is met. The default flip is what affects hosts:

- clanker: blocker (b).
- curated-thoughts: `makeWikiOptions` in `src/lib/wiki.ts` sets neither option, but the repo is pinned to exactly 7.13.0. It matters only when that repo upgrades, and the migration guide says so.

## Proposed change

1. **#324.** Remove `wikiTraverseGraphManifest`, `wikiGetOntologyManifest`, `wikiGetInstructionsManifest`, `LEGACY_TOOL_NAMES`, `canonicalToolName()`, `src/legacy.ts` including `renamed()`, `__tests__/legacy.test.ts`, and the 7.15.2 fixture. Schema tests retarget the canonical manifests.
2. **Defaults.** `packages/core/src/utils/engineDefaults.ts` defines both defaults once. Every read site resolves through it: `librarian/index.ts`, `WriteService`, and the `MaintenanceService` prune guard.
3. **Upgrade safety.** The defaults make two 7.x settings silently inert, so `WikiMemory` logs one console warning for each at construction: auto-run thresholds with no explicit `maintenance`, and `prompts.librarianSystemPrompt` with no explicit strategy.
4. **`getInstructions()` follows the strategy.** Under `'ops'`, `librarian` reports the ops extract prompt the engine actually sends. Without this, `instructions_get` would describe a prompt the default never uses.
5. **Callers in this repo.** `apps/scopelab` and `apps/wiki-demo` are long-lived demos that rely on thresholds, so they set `maintenance: 'auto'` and take the new librarian default. Both benchmark baselines state strategy and maintenance explicitly.
6. **Tests.** Tests of legacy or auto behavior spread `LEGACY_AUTO` (`__tests__/helpers/legacyAutoConfig.ts`). None were deleted to pass, apart from the #324 legacy suite. `engineDefaults.test.ts` pins the new defaults.
7. **Docs.** New `project/upgrading-8` guide, updated configuration, maintenance, concepts, quickstart and recipe pages, plus `INTENT.md` and `AGENTS.md`.

## Behavior hosts will see

- With no configuration, events pile up and no facts appear from them until the host runs maintenance.
- `runPrune()` is guarded by default, so events the librarian hasn't processed are kept. A host that never runs maintenance grows its event log and gets `event_retention_held`.
- The ops librarian ignores `prompts.librarianSystemPrompt` and `runLibrarian`'s `promptOverride`.
- Keeping only `{ strategy: 'legacy' }` pairs legacy with `'deferred'`, which drops events beyond the newest 50 in a backlog. The guide says to set both.

## Files touched

`packages/core-llm-tools/**`, `packages/core/src/{utils/engineDefaults.ts,WikiMemory.ts,types.ts}`, `packages/core/src/services/{WriteService.ts,MaintenanceService.ts,PromptService.ts,librarian/index.ts}`, `packages/core/__tests__/**`, `packages/benchmarks/src/{supersession/run.ts,longmemeval/ingest.ts}`, `apps/{scopelab,wiki-demo}`, `apps/docs/**`, `docs/synapsetree-integration.md`, `INTENT.md`, `AGENTS.md`.

## Test plan

`pnpm -r build`, lint, typecheck, `pnpm test`. No LLM-backed benchmark runs.
