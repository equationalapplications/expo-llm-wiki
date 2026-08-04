# Handoff: write the implementation plan for the maintenance-bounding spec

**For:** the next agent, starting from a cold context.
**Your job:** write an implementation plan. Do not write implementation code.

## Start here

1. Read `docs/superpowers/specs/2026-08-04-maintenance-bounding-and-dependency-hygiene-design.md`
   in full. It is approved and complete — treat it as the source of truth, not as a draft to
   re-litigate.
2. Invoke the `superpowers:writing-plans` skill and follow it. Brainstorming is already done; do
   not re-run it.

## Current state

- Branch: `fix/maintenance-bounding-and-deps`, one commit (`d6a2b38`), spec only. No code written.
- `main` is clean and untouched.
- Repo version 4.22.0. pnpm 10.33.2 is the live package manager.

## What the spec covers

Four defects, three workstreams, sequenced **C1 → B → A**:

- **C1** — delete four stale git-tracked `package-lock.json` files, pin `packageManager`, gitignore.
  Resolves 17 of 36 Dependabot alerts.
- **B** — fix the `SearchService.rebuildIndex` race behind GitHub #64: serialize `sync()`, disable
  `autoVacuum`, guard the rebuild, bump `minisearch`.
- **A** — the large one, behind GitHub #63 and #65: a new `BoundedLlmCall.ts` module providing
  `runBatched`, consumed by both `doRunHeal` and `doRunOntologyBackfill`.
- **C2** — `pnpm update` then targeted `pnpm.overrides`, runtime scope first.

The ordering exists for a reason: C1 gives a clean install, B gives a trustworthy test baseline, and
A is the largest change and benefits from both. Keep it.

## Decisions already made — do not reopen

These were settled with the user during brainstorming. Re-proposing alternatives wastes a round trip.

- **Output bounding uses both** an optional `LlmProvider.maxOutputTokens` hint *and* an always-armed
  halve-and-retry split. Not one or the other.
- **`DEFAULT_BATCH_SIZE = 10`** when no hint is present. The absence of a hint must never size up —
  starting large makes the split path burn tokens on first attempts guaranteed to fail. This was the
  user's explicit note.
- **Sticky downward adaptation** is required, not optional: the successful batch size carries forward
  within a run and never climbs back up. Without it a 1177-fact run rediscovers the ceiling on every
  batch.
- **Heal anchors are relevance-scoped**, not a recent-N window and not referenced-only. The coverage
  tradeoff is accepted and documented in the spec — do not re-argue it in the plan.
- **#64 gets the full fix** (serialize + autoVacuum off + guard), not a bare try/catch.
- **Stale lockfiles get deleted**, not updated.

## Things to get right in the plan

- **A single unsplittable item is skipped, never thrown.** A pass must not fail because one item is
  unprocessable. `skipped` is returned and logged with entity id and item id.
- **Two independent bounds.** `maxPromptChars` (input) and batch sizing (output) both apply; the
  char cap trims whichever batch size wins. Don't collapse them into one.
- **Public API changes are additive only:** `LlmProvider.maxOutputTokens?: number` and
  `OntologyBackfillResult.skipped: number`. Minor version. If the plan finds itself proposing a
  breaking change, something has gone wrong — stop and flag it.
- **The heal anchor source-type filter must be applied after retrieval.** The MiniSearch index holds
  all facts, not only `immutable_document` rows. This is the one correction made post-approval.
- **Removing `findAllByEntityId` from heal makes the `immutable_document` filter at
  `MaintenanceService.ts:473` dead.** Plan its removal explicitly so it isn't orphaned.

## Verification the plan must specify

- `pnpm test` after C1, after B, and after A.
- For B: a test firing N concurrent `sync()` calls for one entity, asserting correct index contents
  and no escaped rejection. **It must fail against current code** — if it passes before the fix, the
  test is wrong.
- For A: `runBatched` unit tests against a synthetic `call` that fails above a threshold size.
- For C2: re-query the Dependabot alert API and record actual before/after counts. **The spec does
  not promise zero alerts** — some transitive advisories may have parents pinning incompatible
  ranges, and leaving one documented beats forcing an override that breaks a parent. Do not write a
  plan step that commits to a zero-alert outcome.

## Context that is not in the spec

- Core cannot see the provider's token ceiling. `LlmProvider` is
  `generateText: (params: { systemPrompt: string; userPrompt: string }) => Promise<string>` at
  `packages/core/src/types.ts:312`. That is why failure detection is string/exception matching rather
  than a token count, and why a misclassified error is designed to cost one wasted retry rather than
  correctness.
- `MaintenanceService.ts` is 726 lines. That is why `runBatched` is extracted rather than inlined
  twice. Resist growing that file further.
- Tests live in `packages/core/__tests__/`, vitest. `SearchService.test.ts` already exists and is the
  right place to extend for B.
- The three GitHub issues are open and unassigned. Nobody has commented on them.
