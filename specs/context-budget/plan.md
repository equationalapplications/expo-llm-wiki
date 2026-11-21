# Implementation plan — PR 7a: context-budget resolver

Spec: `specs/context-budget/spec.md` (APPROVED, owner rulings folded 2026-11-21) @ 5be086ea,
branch `spec/context-budget`, PR #438. All file:line cites below were re-verified live against
the tree at 5be086ea (base `e43095c8`). **Intent check (AGENTS.md):** the spec was checked
against `INTENT.md` at authoring time — §241's single maintenance token budget and the
`estimated` marking are untouched (metering is out of scope); the resolver only re-routes
existing constant reads, which INTENT neither names nor constrains. Aligned; no INTENT
amendment needed.

**Merge position:** second among the four wave-1 PRs (roadmap step 6, after S1-0 #442).
**Coordination:** file-wise independent of the other three PRs — this PR creates
`packages/core/src/config/` (new directory), adds `packages/core/src/utils/contextBudget.ts`
(new file), and touches only one-line cap swaps plus a type addition and re-exports. No
overlap with #442 or the other two lanes; merge order only matters for rebase noise, not
semantics. The ontology-backfill cap wiring (`MaintenanceService.ts:2144`, constant at :49,
export at `index.ts:27`) stays **excluded** — PR 2b-follow-up owns it; under every mode its
value stays 40_000.

**Owner rulings in force (do not re-litigate in review):**
- R0: owner spec approval is recorded in the spec's Status line (2026-11-21) and
  these three rulings; coding proceeded on that record. The PR itself is the
  implementation record of that approval — coding does not wait for a separate
  approving GitHub review.
- R1: declared-mode defaults `charsPerToken: 4`, `safetyFraction: 0.9`,
  `outputReserveTokens: 4000`; per-op floors at today's caps as one-batch minimums.
- R2: the ingest chunk default stays **12000 in both modes**.
- R3: `context.contextWindowTokens` ships in this PR; `'declared'` is reachable; missing
  window under `'declared'` throws (never falls back to `'legacy'`).

**Core guarantee ordering:** the byte-identity pins (spec test 1) are the PR's contract with
every existing host. They land FIRST, before any resolver code exists to break them, and stay
green through every later task.

---

## Task breakdown

### T1 — Byte-identity pins on the untouched tree (spec test 1; the core guarantee)

Files: `packages/core/__tests__/contextBudgetByteIdentity.test.ts` (new).

Write the pins BEFORE any production change, against pre-change output. The pins cover BOTH
layers — exact output strings AND batch-splitting decisions (the caps act on batching, not on
builder internals, so string pins alone cannot catch a wrong cap):

- `buildOpsResolvePrompt` (via `runResolve`'s buildPrompt path or `PromptService` directly)
  with a fixture candidate → exact-string assert on system+user prompt.
- `buildHealPrompt` with a fixture fact → exact-string assert.
- `buildOpsExtractPrompt` with fixture events → exact-string assert.
- `chunkText` as reached from `ingestDocument` at the default cap → exact chunk-boundary
  assert (fixtures stay in the test file, per spec).
- **Batch-splitting pins (r2):** fixtures sized just under and just over 40_000 chars driven
  through `runBatched` (resolve and heal) → assert provider-call count and which items land
  in each batch; `selectBatch` with event summaries summing to just under and just over
  24_000 chars → assert `batch.length` on both sides of the boundary. Each pin runs with a
  config with no `context` section AND with `context.budget: 'legacy'` (spec test 1's two
  shapes).

Fixtures are small, self-contained objects (one candidate/fact/event set each; the boundary
fixtures pad with generated filler); expected strings are captured from the pre-change tree
and pasted literally into the test.

- Run: `pnpm vitest run packages/core/__tests__/contextBudgetByteIdentity.test.ts`
  Expected: PASS (nothing has changed yet — this proves the pins match today's behavior).
- Commit: `test(context-budget): pin legacy byte-identity of prompts and chunking (pre-change)`

If any pin cannot reach the builder without a service harness, use the narrowest real seam
(`PromptService` method directly); a pin through a stub that bypasses the real builder is a
plan failure.

### T2 — `ContextBudget` type + estimate wrapper (spec Proposed change 2)

Files: `packages/core/src/utils/contextBudget.ts` (new).

```ts
export interface ContextBudget {
  mode: 'legacy' | 'declared';
  contextWindowTokens?: number;   // set iff mode === 'declared'
  charsPerToken: number;          // 4 under legacy
  safetyFraction: number;         // 0.9 under legacy (unused in math there)
  outputReserveTokens: number;    // 4000 under legacy (unused in math there)
}

export function estimateTokensWith(budget: ContextBudget, text: string): number {
  return Math.ceil(text.length / budget.charsPerToken);
}
```

- `estimateTokensWith` under a legacy budget (`charsPerToken: 4`) is byte-equal to
  `estimateTokens` for every input — trivially, since both are `ceil(len/4)`. The meter keeps
  plain `estimateTokens` this PR (spec Out of scope); the wrapper ships unused by metering.
- Test (`contextBudget.test.ts`): `estimateTokensWith(budget, 'x'.repeat(9))` → 3 at
  charsPerToken 4; with `charsPerToken: 2` → 5 (above the chars/4 estimate of 3 — spec test 5).
- Commit: `feat(context-budget): add ContextBudget type and estimateTokensWith wrapper`

### T3 — Resolver module (spec Proposed change 1, 4; rulings R1–R3)

Files: `packages/core/src/config/context.ts` (new; this commit also creates the
`config/` directory) and `packages/core/src/utils/contextCaps.ts` (new leaf — see below).

**Constant sourcing (r2, M1+M2):** importing the caps from `resolve.ts` /
`MaintenanceService.ts` is impossible twice over — `OPS_RESOLVE_MAX_PROMPT_CHARS`
(`resolve.ts:8`) is not `export`ed, and importing from those service modules would create a
load-order cycle (`MaintenanceService` → `librarian` → `ops/*` → `config/context` →
`MaintenanceService`; the repo already hit this exact shape once — see the comment at
`utils/healConstants.ts:12-15`). Resolution: the four cap values move into a new leaf module
`utils/contextCaps.ts` (names and values unchanged); each current site re-exports or
aliases from the leaf so **the existing names and values are preserved exactly** —
`resolve.ts:8` becomes `export { OPS_RESOLVE_MAX_PROMPT_CHARS } from '../../../utils/contextCaps'`,
`extract.ts:12` and `MaintenanceService.ts:49/65` likewise, `DEFAULT_MAX_CHUNK_LENGTH` stays
where it is (`utils/chunkingDefaults.ts` is already a leaf — the leaf re-exports it).
`config/context.ts` imports only from `utils/contextCaps.ts` and `utils/chunkingDefaults.ts`.
The T1 pins are the guard that the move changed no value. `config/context.ts` computes its
floors by reading the leaf constants inside function bodies (top-level object literals from
imports are fine for true leaf imports, but reading inside the resolver function keeps the
load-order requirement structural, not conventional).

Exports:
`OPS_RESOLVE_MAX_PROMPT_CHARS`, `HEAL_MAX_PROMPT_CHARS`, `OPS_MAX_EXTRACT_CHARS`,
`DEFAULT_MAX_CHUNK_LENGTH` — all via `utils/contextCaps.ts` / `utils/chunkingDefaults.ts`,
never duplicated as literals in `config/context.ts`.

```ts
export function resolveContextBudget(config: WikiConfig | undefined): ContextBudget
export function resolveMaxPromptChars(budget: ContextBudget, op: 'resolve' | 'heal' | 'extract'): number
export function resolveDefaultChunkLength(budget: ContextBudget): number  // always 12000 (R2)
```

Behavior:

- **legacy** (no `context` section, or `context.budget: 'legacy'`, or `context` present with
  no `budget` key): `resolveMaxPromptChars` returns
  `OPS_RESOLVE_MAX_PROMPT_CHARS` / `HEAL_MAX_PROMPT_CHARS` / `OPS_MAX_EXTRACT_CHARS`
  (40_000 / 40_000 / 24_000 — the `'extract'` key returns the batch event-char cap, not a
  prompt cap). `resolveDefaultChunkLength` returns 12000. `charsPerToken: 4`.
- **declared** (`context.budget: 'declared'`): validation first —
  `contextWindowTokens` missing, non-finite, or ≤ 0 → throw;
  `charsPerToken` (when supplied) ≤ 0 or non-finite → throw;
  `safetyFraction` (when supplied) outside (0, 1] → throw;
  the **effective** output reserve (supplied value, else default 4000) < 0, non-finite, or
  ≥ `contextWindowTokens` → throw (r2: validating only a supplied reserve let
  `contextWindowTokens: 3000` with no reserve derive negative behind the floor);
  `budget` present but not `'legacy'`/`'declared'` → throw (r2: a plain-JS host typo like
  `'declard'` must not silently degrade to legacy — R3).
  Throws are plain `Error`s whose message is prefixed `[core-llm-wiki] ` and names the bad
  key and value — same style as the existing `[core-llm-wiki]` diagnostics; never a silent
  fallback to `'legacy'` (per R3). (The plan's earlier examples were inexact —
  `engineDefaults` only warns and `ingestDocument`'s throw has no prefix; the format is
  stated here directly.)
  Defaults per R1: `charsPerToken 4`, `safetyFraction 0.9`, `outputReserveTokens 4000`.
  Derived prompt cap for resolve and heal:
  `max(OP_FLOOR[op], floor((contextWindowTokens - outputReserveTokens) * safetyFraction * charsPerToken))`
  where `OP_FLOOR = { resolve: 40_000, heal: 40_000, extract: 24_000 }` — the floor is today's
  cap as a one-batch minimum, so a derived value never lands at zero or negative (spec
  Proposed change 4; test 3 clamp case).
  **Extract scales by today's ratio (r2, M4 — controller-flagged):** the extract cap bounds
  only the event-summary chars while the extract prompt also carries the system prompt,
  ontology context and guidance; a uniform formula (e.g. window 32_000 → 100_800 event
  chars) can spend the whole window on summaries and force overflow probes/halving on every
  pass. So `extractDerived = floor(resolveDerived * OPS_MAX_EXTRACT_CHARS / OPS_RESOLVE_MAX_PROMPT_CHARS)`
  (i.e. ×24/40 = ×0.6), then `max(OP_FLOOR.extract, …)`. This preserves today's 60% invariant
  under declared budgets; it is an interpretation of the approved formula shape and is
  flagged for the controller to confirm or overrule.
  `resolveDefaultChunkLength` still returns 12000 (R2).

Config type addition rides THIS task (same interface `WikiConfig`): the resolver consumes
`config?.context`, so `WikiConfig` must already carry the `context?` field when T3's commit
compiles — putting the type in T4 would leave the T3 commit non-compiling (a review finding
on the earlier draft; corrected 2026-11-21). The type edit (`packages/core/src/types.ts`,
`WikiConfig.context?` + doc comment) is part of T3's commit; T4 only threads the resolved
budget through the cap sites.

- Test (`packages/core/__tests__/configContext.test.ts` — tests live in `__tests__/`,
  flat, like `engineDefaults.test.ts`): constant pin
  (spec test 2 — legacy returns 40_000/40_000/24_000/12000 literally, so a silent constant
  edit fails CI); declared formula outputs for representative windows; every validation throw
  from the list above; the floor clamp (`contextWindowTokens: 8000` → resolve/heal 40_000,
  extract 24_000); chunk default 12000 in both modes.
- Commit: `feat(context-budget): add config/context.ts resolver with legacy/declared modes`

### T4 — Cap swaps (spec Proposed change 3; five one-line edits + threading)

Files: `services/librarian/ops/resolve.ts`,
`services/MaintenanceService.ts`, `services/librarian/ops/extract.ts`,
`services/librarian/ops/index.ts`, `services/IngestionService.ts`,
`utils/contextCaps.ts` (from T3; its re-export wiring may land in T3 or here), plus the 14
`selectBatch(...)` test call sites in three existing test files (see Extract below).

- `types.ts`: add to `WikiConfig` (line 298):

  ```ts
  context?: {
    budget?: 'legacy' | 'declared';
    contextWindowTokens?: number;
    charsPerToken?: number;
    safetyFraction?: number;
    outputReserveTokens?: number;
  };
  ```

  `WikiOptions.config?` (line ~989) is the same type, so `IngestionService` sees the section.
- **Threading rule (spec): resolve once per public entry, pass down; no resolver call inside
  a batch loop.** Each entry already holds its service options:
  - `runResolve` (`resolve.ts:69`): `const budget = resolveContextBudget(deps.options.config)`
    at entry; line 104 becomes `maxPromptChars: resolveMaxPromptChars(budget, 'resolve')`.
  - `doRunHeal` (`MaintenanceService.ts:1653`): resolve once from `this.options.config`;
    line 1815 becomes `maxPromptChars: resolveMaxPromptChars(budget, 'heal')`.
- **Extract:** `selectBatch` (`extract.ts:52`) currently ends in two optional params
  (`meter?: UsageMeter, guidance?: string`), so a REQUIRED trailing `budget` is a TS1016
  compile error (r2 blocker). Resolution: widen the trailing params to
  `meter: UsageMeter | undefined, guidance: string | undefined, budget: ContextBudget` —
  required-with-`|undefined` types, all after `wm`. No fallback exists: an absent budget is
  a caller bug. The one production caller (`ops/index.ts:33`) passes
  `meter, ctx.guidance, budget` positionally (unchanged positions for meter/guidance when
  both are supplied); the 14 test call sites (5 in `opsExtract.test.ts`, 4 in
  `extract-merge.test.ts`, 5 in `extract-overflow.test.ts`) gain explicit trailing
  arguments (`undefined` gaps filled literally, budget =
  `resolveContextBudget(undefined)` for legacy behavior). Existing suites are unchanged
  behaviorally but not source-identical.
  Line 65's cap compare uses `resolveMaxPromptChars(budget, 'extract')`; **line 74 (the
  `RESOLVE_RESERVE_FACTOR` reserve check) is untouched** — it derives from the prompt
  estimate, not from the swapped constant. The caller at `ops/index.ts:33` resolves the
  budget once at librarian-pass entry and passes it.
  - `ingestDocument` (`IngestionService.ts:129`): resolve `const budget =
    resolveContextBudget(this.options.config)` at method entry (that local is the `budget`
    used below); keep the override chain verbatim, swap
    only the final fallback:
    `params.maxChunkLength ?? this.options.config?.maxChunkLength ?? resolveDefaultChunkLength(budget)`
    — explicit host/config `maxChunkLength` always wins; the existing contract at that line
    is preserved.
- Fail-fast (r2): resolve once in the `WikiMemory`/service construction path, alongside the
  `changedDefaultWarnings` call (`engineDefaults.ts:61`), so a misconfigured declared budget
  throws at construction instead of at first maintenance/ingest call. The constructor
  discards the value; entries still resolve per call (cheap, and keeps behavior identical).
- No existing export changes value or name; the four constants keep their names and values,
  now sourced from `utils/contextCaps.ts` (T3) and re-exported from their current modules.
- Run: T1's byte-identity suite again — Expected: PASS unchanged (the swaps and the leaf move
  resolve to the identical numbers under legacy). Then `pnpm -r typecheck`.
- Commit: `feat(context-budget): resolve prompt/chunk caps through config/context resolver`

### T5 — Export surface (spec Proposed change 5)

Files: `packages/core/src/index.ts`.

After the `DEFAULT_MAX_CHUNK_LENGTH` re-export (line 19), add:

```ts
export { resolveContextBudget, resolveMaxPromptChars, resolveDefaultChunkLength } from './config/context';
export type { ContextBudget } from './utils/contextBudget';
export { estimateTokensWith } from './utils/contextBudget';
```

No existing export changes value or name; the backfill export at line 27 stays as-is
(exclusion per header). Doc comments naming the constants are the only other references —
untouched.

- Run: `pnpm -r typecheck`; a typecheck-time import verifies `ContextBudget` resolves, plus
  a runtime spot-import (built package or test import) that the four value exports resolve.
- Commit: `feat(context-budget): export context-budget resolver surface from core index`

### T6 — Remaining tests (spec test plan 3–7; test 1–2 landed with T1/T3)

Files: `packages/core/__tests__/contextBudget.test.ts` (extend),
`packages/core/__tests__/contextBudgetIngest.test.ts` (new).

- Override precedence (spec test 4): `ingestDocument` with explicit `maxChunkLength` ignores
  the resolver (stub provider, assert chunking used the explicit value even under a declared
  config that would derive differently); config-level `maxChunkLength` beats the resolver
  fallback; resolver fallback under legacy equals 12000.
- Estimate wrapper (spec test 5) — landed T2; only cross-check here that a declared budget
  does NOT change meter accounting (metering still estimates chars/4 in `llmCall.ts`;
  `UsageMeter` records token counts, it never sees text): drive `callLlm` with a stub
  provider under a declared config and assert the `UsageMeter` accrues the same chars/4
  token count.
- Declared-mode extract fit (r2, M4): a full extract prompt (batch at the derived cap plus
  system prompt, ontology context, guidance) fits inside the declared window — e.g.
  `contextWindowTokens: 32000` keeps batch summaries at ~57_600 derived chars (floor 24_000
  does not apply) while resolve/heal derive 100_800.
- Backfill exclusion (spec test 6): assert `ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS === 40_000`;
  the reviewer-facing guarantee is also structural — grep-confirm in the final diff that
  `MaintenanceService.ts:2144` is absent from every hunk.
- Declared-mode tests feed the resolver through `resolveContextBudget({ context: {...} })`
  with `contextWindowTokens` set (R3 — reachable now); no directly-constructed-budget
  shortcut is needed (the spec's conditional in test 3 is moot under R3).
- Run: full vitest suite (`pnpm -r --filter=!@equationalapplications/integration-llm-wiki
  test` or the repo's standard unit gate) — all existing suites pass (the T4 signature
  updates are call-site-only; behavior unchanged — the T1 string AND batch-splitting pins
  make this a real guard).
- Commit: `test(context-budget): override precedence, meter independence, backfill exclusion`

### T7 — Gates + PR wrap

- Full gates: typecheck + unit suite green; `git diff origin/main..HEAD` grep-swept to
  confirm: only the spec's Files-touched set — eight original entries plus `ops/index.ts`,
  `utils/contextCaps.ts` and the four new test files (spec amendments 2026-11-21, r1+r2),
  with the three existing test files carrying signature-only call-site updates — no
  `LLMProvider` change, no line-74 edit, no line-2144 edit, no `estimateTokens` call-site
  change.
- Update `specs/context-budget/LEDGER.md` (one checkbox per T-task with evidence links) in
  the implementation phase — ledger is transient, deleted by the cleanup commit.
- No merge, no `gh pr ready` from this lane step; controller reviews the converged plan
  before implementation starts.

---

## Implementation order & dependencies

T1 (pins, pre-change) → T2 (type+wrapper) → T3 (resolver) → T4 (type+swaps; depends on T2+T3)
→ T5 (exports) → T6 (remaining tests) → T7 (gates). T2/T3 are independent of T1 but land
after it so the pins exist before any behavior-adjacent code. No task touches files outside
the spec's Files-touched list (as amended) plus the new test files.

## Execution & review protocol (standing)

- This plan gates implementation: coding starts only after the controller's review of the
  converged plan. Owner rulings R1–R3 are settled; no further owner ask is queued.
- Each task commits separately (conventional commits naming the spec section), ACs green
  before the next task; commits authored as Tessera <tessera@equational.app>.
- Dual review after implementation per lane convention; cleanup commit (step 4) later.

## Spec ambiguities hit while planning, and resolutions

1. **`selectBatch` parameter signature.** Spec says "in the pattern of its existing
   `meter?`/`guidance?` parameters". r1 ruled REQUIRED-and-LAST; r2's blocker showed a
   required param after optional ones is a TS1016 compile error. Final resolution: widen the
   trailing params to `meter: UsageMeter | undefined, guidance: string | undefined,
   budget: ContextBudget`. The 14 test call sites gain explicit trailing arguments. No
   default — an absent budget is a caller bug, not a legacy fallback.
2. **Where `budget` comes from in `doRunHeal`/`runResolve`.** Both hold service options
   (`this.options.config` / `deps.options.config`); the plan resolves at entry and closes
   over it. No new plumbing.
3. **Declared-mode floor semantics.** Spec text gives both "floors at today's caps" and
   "never zero or negative". Resolution: `max(OP_FLOOR[op], derived)` — one rule satisfying
   both sentences; the clamp test pins it.
4. **`estimateTokensWith` is dead code at ship.** The spec's test 5 explicitly scopes it as a
   unit test of the wrapper; metering keeps `estimateTokens` until the follow-up PR. The
   export is intentional surface, not premature code (T5 exports it).
5. **Cap sourcing vs the no-duplication rule (r2).** The caps cannot be imported from their
   current modules (`OPS_RESOLVE_MAX_PROMPT_CHARS` is unexported; importing
   `MaintenanceService` from a module it transitively imports is a load-order cycle).
   Resolution: leaf module `utils/contextCaps.ts` holds the values; current sites re-export;
   names and values unchanged, guarded by the T1 pins.
6. **Extract scaling in declared mode (r2, CONTROLLER-FLAGGED).** The approved formula shape
   applied uniformly lets the extract batch (event-summary chars only) consume the whole
   window, since the extract prompt also carries fixed parts. Resolution folded here:
   extract derives at ×24/40 of the resolve/heal cap (today's ratio), floor still applied.
   Controller: confirm or overrule this interpretation before implementation.

## Controller decree (2026-11-21)

1. **Ambiguity 6 RATIFIED:** the declared-mode extract cap derives at ×24/40 of the resolve/heal cap, floor still applied. Rationale: preserves today's 60% proportionality; a uniform formula would let extract summaries consume the whole window and force overflow probes every pass. The ruled defaults are provisional by the owner's own ruling — receipts make misjudgment visible and correctable, and the owner can re-rule the ratio later without structural change.
2. **Spec Files-touched amendments RATIFIED:** `ops/index.ts` (threading site) and `utils/contextCaps.ts` (constant leaf) are mechanical completeness fixes with no behavior change — folded during plan review, now part of the approved surface.
