# Spec — Step 9: The ontology-backfill prompt cap joins the context budget

Status: Implemented 2026-11-22 (PR #455, head `0472dbff`; acceptance tests in
`packages/core/__tests__/contextBudgetBackfill.test.ts` plus the retained
pins; owner-approved by ruling 2026-11-22, msg `1574024786680746015` —
derivation follows the resolve/heal formula. Ladder: GLM-flash rung 1
APPROVE, GLM-flash rung 2 APPROVE, Opus rung 3 approve-once-task-8; all
findings folded in-PR or deferred to issue #456. Plan authored by tier-3
Opus per the owner's same-message directive; controller adjudicated the
classifier-path open point to pass-entry resolve.)
Base: origin/main @ `2b69852a` (PR #454 merge; release v9.10.0). Every pin
below is re-verified live against `2b69852a`. Repo: expo-llm-wiki. Product
rule: hosts bring their own models; core stays unopinionated about providers.

## Problem

Core sizes every prompt but one with the host's declared context window
(PR #438, roadmap step 6). The ontology-backfill prompt cap stays
hardcoded. `ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS = 40_000` sits at
`packages/core/src/services/MaintenanceService.ts:51` and bounds the batch
prompt at `MaintenanceService.ts:2343` through `runBatched`. A host that
declares a small window still gets 40_000-char backfill prompts. The
overflow then takes the skip path (`context_overflow_skipped`), which
recovers instead of fitting. `specs/context-budget/spec.md` excluded this
wiring (its test 6) and named a follow-up as owner. The 2b spec
(`specs/backfill-shortlist-wiring/spec.md`) re-recorded the same exclusion.
Roadmap step 9 owns it. This PR is that follow-up.

## Proposed change

### 1. The constant moves to the leaf caps module

`ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS` moves from `MaintenanceService.ts` to
`packages/core/src/utils/contextCaps.ts`. The name and the value 40_000
stay identical. `MaintenanceService.ts` re-exports it from the leaf; the
in-tree precedent is `HEAL_MAX_PROMPT_CHARS` (`MaintenanceService.ts:76`).
`packages/core/src/index.ts` keeps exporting the constant from
`./services/MaintenanceService`, so the public surface does not change.
The existing test imports (`configContext.test.ts:9`,
`contextBudgetIngest.test.ts:8`, `ontologyBackfill.test.ts:10`) keep their
import paths. The leaf module already documents this move pattern
(`contextCaps.ts` header, specs/context-budget T3).

### 2. The resolver grows a `'backfill'` operation

`ContextBudgetOp` in `packages/core/src/config/context.ts` gains
`'backfill'`. `OP_FLOOR` gains `backfill: ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS`,
read from the leaf. Under `'legacy'`, `resolveMaxPromptChars(budget,
'backfill')` returns 40_000 — today's number. Under `'declared'`, the cap
derives with the resolve/heal formula:
`floor((contextWindowTokens - outputReserveTokens) * safetyFraction * charsPerToken)`,
never below the 40_000 floor. This follows owner ruling R1 of PR #438:
floors sit at today's caps as one-batch minimums, and a window small
enough to bind the floor can still overflow — the ruled tradeoff.

### 3. The backfill site reads the resolver

`MaintenanceService.ts:2343` swaps
`maxPromptChars: ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS` to
`maxPromptChars: resolveMaxPromptChars(resolveContextBudget(this.options.config), 'backfill')`.
The heal site is the precedent (`MaintenanceService.ts:1865`): one resolve
at the `runBatched` call site, not per batch. An invalid `context` section
throws at pass entry and never falls back to legacy (the PR #438 throw rule).

### 4. Byte identity under legacy

Under no `context` section, and under `context.budget: 'legacy'`,
`runBatched` receives the same 40_000 number as today. `trim` therefore
produces the same batch sizes and the same prompts. No prompt builder
changes. The T-pins below guard this.

## Test plan

1. Existing backfill boundary tests stay green unchanged.
   `ontologyBackfill.test.ts` (lines ~342, ~495–539) derives its fixtures
   from `ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS` and exercises the trim and
   oversized-singleton paths. They are the legacy byte-identity guard. The
   PR must not touch them.
2. Constant pins stay. `configContext.test.ts:117` and
   `contextBudgetIngest.test.ts:71` pin the value at 40_000. They stay
   unchanged; their meaning becomes the floor pin.
3. Declared-mode resolver pins. New tests: under
   `{ budget: 'declared', contextWindowTokens: 32_000 }` the resolver
   returns 100_800 for `'backfill'` (the resolve/heal formula). A floor
   test: a tiny window derives below 40_000, and the resolver returns
   40_000 (the mirror of the PR #438 floor-clamp test).
4. Declared-mode backfill boundary. New test in the backfill harness:
   under a declared budget, `runBatched` splits a two-fact batch at the
   derived cap (the analog of the `runResolve 40_000-char batch split`
   test in `contextBudgetByteIdentity.test.ts`).
   B1 and B2 each carry a legacy-control run (issue #456, spec
   `specs/backfill-cap-legacy-control/spec.md`): B1-control proves the B1
   pair splits under legacy; B2-control records that B2's shape is identical
   under legacy (upper-bracket pin only).
5. No silent fallback. A test asserts a malformed `context` section throws
   out of the backfill pass; it never degrades to the legacy number.
6. Suite health. All vitest suites pass. The controller records baseline
   counts at lane open; the expected count is baseline plus the net new
   tests.

## Out of scope / rejected alternatives

Out of scope:

- Any section-, catalog-, or fact-body-level budget inside the backfill
  prompt. REJECTED twice in the 2b trail (plan-ladder delta; CodeRabbit
  round) — adjudicated skips in PR #453. This PR changes where the number
  comes from, not what it bounds.
- Changes to `runBatched`. The oversized-singleton rule stands
  (`BoundedLlmCall.ts` `trim`: a single item that exceeds the cap alone is
  still sent). The split ladder, escalation, and skip semantics stay
  untouched.
- Per-operation `maxPromptChars` config knobs (rejected in PR #438; the
  consult ruled against public catalog knobs).
- A validity-window filter on the title or scoring index (documented
  deliberate in the 2b spec dated note, 2026-11-21, m5 — folding it in
  needs Kurt).
- `estimateTokensWith` metering (out of scope per PR #438; a follow-up
  owns the meter swap).
- The write-path template split in `PromptService.ts` (roadmap step 13
  owns it).

Rejected alternatives:

- We rejected reusing the `'resolve'` op for backfill. A separate
  `'backfill'` op keeps each floor named, so a later change to one cap
  cannot silently move the other.
- We rejected deriving the backfill cap by the extract 24/40 ratio.
  Backfill is a whole-batch generative prompt like resolve/heal, and its
  floor (40_000) equals the resolve/heal floor. The ratio rule exists for
  extract's event-summary batches only.

## Open questions for the owner

1. Under `'declared'`, does the backfill cap derive with the resolve/heal
   formula (recommended), or does it scale by the extract ratio? The
   recommendation follows the rejected-alternatives note above.

## Files touched

- `packages/core/src/utils/contextCaps.ts` — the constant moves in.
- `packages/core/src/config/context.ts` — `ContextBudgetOp`, `OP_FLOOR`,
  `resolveMaxPromptChars`.
- `packages/core/src/services/MaintenanceService.ts` — re-export from the
  leaf; the wiring swap at line 2343.
- `packages/core/__tests__/` — the new declared-mode resolver and boundary
  tests.
- `packages/core/src/index.ts` — NO change; the export path stays.
