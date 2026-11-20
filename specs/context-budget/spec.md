# Spec — PR 7a: Context-Budget Resolver

Status: draft (spec stage). Lane 2, wave 1, unconditional.
Base: origin/main @ `e43095c8` (the only commits after `9790dbbf` are dependency-only; every pin below re-verified live against `e43095c8`). Repo: expo-llm-wiki. Product rule: hosts bring their own models. Core stays unopinionated about providers.

## Problem

Core sizes every prompt with compile-time constants. The constants assume a large context window. A host that brings a small-window model gets overflow errors. Core classifies the overflow and skips items (BoundedLlmCall.ts). Skipping is recovery, not fitting. The host cannot tell core how big its window is, because `LLMProvider` has no window field and `WikiConfig` has no budget section. The host also cannot replace the chars/4 token estimate (`estimateTokens`), even when its provider documents a real tokenizer ratio.

## Root cause with evidence

Every input cap is a hardcoded constant at the call site. Core never resolves these values through config. Verified on origin/main @ `e43095c8`:

- `packages/core/src/services/librarian/ops/resolve.ts` — `OPS_RESOLVE_MAX_PROMPT_CHARS = 40_000` (module scope, line 8), wired at `runResolve`'s `runBatched` args, `maxPromptChars: OPS_RESOLVE_MAX_PROMPT_CHARS` (line 104).
- `packages/core/src/services/MaintenanceService.ts` — `HEAL_MAX_PROMPT_CHARS = 40_000` (line 65), wired in `doRunHeal`'s `runBatched` args, `maxPromptChars: HEAL_MAX_PROMPT_CHARS` (line 1815).
- `packages/core/src/services/librarian/ops/extract.ts` — `OPS_MAX_EXTRACT_CHARS = 24_000` (line 12); `selectBatch` caps the event batch with it at line 65; `RESOLVE_RESERVE_FACTOR = 2` (line 14) sizes the meter reserve at line 74.
- `packages/core/src/services/IngestionService.ts` — `ingestDocument` resolves the chunk cap at line 129: `params.maxChunkLength ?? this.options.config?.maxChunkLength ?? DEFAULT_MAX_CHUNK_LENGTH`. `DEFAULT_MAX_CHUNK_LENGTH = 12000` lives in `packages/core/src/utils/chunkingDefaults.ts` (line 7).
- `packages/core/src/utils/usage.ts` — `estimateTokens` returns `Math.ceil(text.length / 4)` (line 6). `UsageMeter` (line 18) and `WikiBudgetExhausted` (line 49) share the same file.
- `packages/core/src/types.ts` — `LLMProvider` (line 724) declares `generateText`, `generateTextWithUsage?`, `embed?`, `maxOutputTokens?`. It declares no context-window field.
- `packages/core/src/services/BoundedLlmCall.ts` — `runBatched` reads `maxPromptChars` from its args (field at line 189, destructure at line 239, fit checks at lines 273 and 286). This is the single enforcement point the swapped caps already flow through.

The enforcement machinery exists. The inputs to it do not resolve from config. `packages/core/src/utils/engineDefaults.ts` shows the established pattern: one resolver module reads config and returns the effective value, so a host that sets nothing gets the same answer everywhere.

## Proposed change

Add two new files. Add one optional config section. Swap four cap sites to resolve through the new module. Under the default, every byte core sends today stays byte-identical.

1. New file `packages/core/src/config/context.ts`. It exports `resolveContextBudget(config)` and `resolveMaxPromptChars(budget, op)`. The config type gains `context?: { budget?: 'legacy' | 'declared'; charsPerToken?: number; safetyFraction?: number; outputReserveTokens?: number }`. The default is `'legacy'`. Under `'legacy'`, the resolver returns today's constants exactly: `OPS_RESOLVE_MAX_PROMPT_CHARS` and `HEAL_MAX_PROMPT_CHARS` = 40_000, `OPS_MAX_EXTRACT_CHARS` = 24_000, `DEFAULT_MAX_CHUNK_LENGTH` = 12000, and a chars/4 estimate. The constants stay exported from their current modules. The resolver imports them; it does not duplicate them.
2. New file `packages/core/src/utils/contextBudget.ts`. It exports `ContextBudget`, the resolved shape. It exports `estimateTokensWith(budget, text)`, which wraps the chars/4 estimate. Under `'declared'`, it applies `charsPerToken` (default 4) instead of the literal 4.
3. Cap swaps, one line each. `resolve.ts` line 104 passes `resolveMaxPromptChars(budget, 'resolve')`. `MaintenanceService.ts` line 1815 passes `resolveMaxPromptChars(budget, 'heal')`. `extract.ts` line 65 compares against `resolveMaxPromptChars(budget, 'extract')`. `IngestionService.ts` line 129 keeps the explicit-override chain and swaps only the final fallback: `?? resolveDefaultChunkLength(budget)`. An explicit `maxChunkLength` from the host or config always wins. This preserves the existing contract at that line.
4. Under `'declared'`, the resolver derives each cap from `contextWindowTokens`-style declared input, `safetyFraction`, and `outputReserveTokens`. The declared-cap formula and defaults are owner rulings (see Open questions). Under `'declared'`, `'legacy'` values stop applying. Tests pin both modes.
5. Export surface. `packages/core/src/index.ts` re-exports the new resolver and type next to the existing default exports (after the `DEFAULT_MAX_CHUNK_LENGTH` export, line 19). No existing export changes value or name.

All four wiring edits resolve the budget once per public entry and pass it down. No resolver call sits inside a batch loop.

## Files touched

- `packages/core/src/config/context.ts` — new; resolver module, the one place budget resolution lives.
- `packages/core/src/utils/contextBudget.ts` — new; resolved type and estimate wrapper.
- `packages/core/src/types.ts` — add optional `context` section to the config interface.
- `packages/core/src/services/librarian/ops/resolve.ts` — swap the `maxPromptChars` arg to the resolver (line 104).
- `packages/core/src/services/MaintenanceService.ts` — swap the heal `maxPromptChars` arg to the resolver (line 1815).
- `packages/core/src/services/librarian/ops/extract.ts` — swap the batch char cap to the resolver (line 65).
- `packages/core/src/services/IngestionService.ts` — swap the final chunk-length fallback to the resolver (line 129).
- `packages/core/src/index.ts` — re-export the new public surface.
- `packages/core/__tests__/` — new tests; see Test plan.

## Test plan

1. Byte-identity pins (the core guarantee). Snapshot or exact-string tests assert that, with no `context` section and with `context.budget: 'legacy'`, `buildOpsResolvePrompt`, `buildHealPrompt`, `buildOpsExtractPrompt`, and the ingest chunker receive inputs identical to pre-change output. Fixture prompts stay in the test files.
2. Constant pin. The resolver under `'legacy'` returns 40_000 for resolve and heal, 24_000 for extract, and 12000 for the chunk default. A test asserts these numbers directly, so a silent constant edit fails CI.
3. Declared mode. With `context.budget: 'declared'` and declared inputs, the resolver returns the formula output for each operation. A test clamps: a declared budget smaller than one minimum item yields the documented minimum, never zero or negative.
4. Override precedence. `ingestDocument` with explicit `maxChunkLength` ignores the resolver. Config-level `maxChunkLength` beats the resolver fallback. The resolver fallback under `'legacy'` equals 12000.
5. Estimate swap. Under `'declared'` with `charsPerToken: 2`, `estimateTokensWith` doubles the token estimate versus chars/4. `UsageMeter` accounting uses the swapped estimate end to end in a fake-provider run.
6. Backfill exclusion. A test asserts `ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS` stays 40_000 and its wiring at `MaintenanceService.ts` line 2144 is untouched by this PR's diff surface.
7. Existing suites. All current vitest suites pass unchanged. The byte-identity pins in (1) make this a real guard, not a hope.

## Out of scope / rejected alternatives

Out of scope:

- The ontology-backfill cap wiring (`MaintenanceService.ts` line 2144, constant at line 49, public export at `index.ts` line 27). PR 2b-follow-up owns it. Under `'legacy'` its value stays 40_000.
- A `contextWindowTokens` field on `LLMProvider`, and host auto-sensing of the window. A later PR owns provider-declared windows; this PR reads config only.
- Per-operation `maxPromptChars` overrides in config. The four caps move behind the resolver; the host-facing knobs come later.
- The title catalog size (`TITLE_CATALOG_MAX_ENTRIES`, `prompts.ts` line 75) and any catalog char budget. The consult ruled against public catalog knobs.

Rejected alternatives:

- We rejected putting the resolver in `utils/engineDefaults.ts`. That module owns 8.0.0 engine defaults; budget resolution is a separate concern with its own test surface, and the plan names `config/context.ts`.
- We rejected teaching `BoundedLlmCall.ts` to read config directly. `runBatched` knows nothing about facts, heal, or ontology by design; keeping it config-blind preserves that boundary. Callers resolve and pass numbers.
- We rejected making `'declared'` the default. Silent behavior change would break every existing host. `'legacy'` default plus byte-identity pins is the only compatible shape.
- We rejected replacing the four hardcoded constants with one shared constant file and no resolver. Constants alone do not give hosts a way to declare a window, which is the point of the PR.

## Open questions for the owner

1. Under `context.budget: 'declared'`, what are the default `charsPerToken`, `safetyFraction`, and `outputReserveTokens` values? The consult leaves this to the spec; the owner rules the numbers.
2. Does the declared-mode formula scale the ingest chunk default too, or does the chunk default stay at 12000 in both modes? Ingest chunks feed embeddings as well as generation, so the ruling is not obvious.
3. Which declared input does the resolver read in this PR: a new `context.contextWindowTokens` config field now, or nothing until the provider-declared-window PR lands (leaving `'declared'` unreachable)? Ruling needed, because it decides whether `'declared'` ships reachable in 7a.
