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

Write the pins BEFORE any production change, against pre-change output. Each test drives the
real prompt builders / chunker with a fixed fixture and asserts exact output:

- `buildOpsResolvePrompt` (via `runResolve`'s buildPrompt path or `PromptService` directly)
  with a fixture candidate → exact-string assert on system+user prompt.
- `buildHealPrompt` with a fixture fact → exact-string assert.
- `buildOpsExtractPrompt` with fixture events → exact-string assert.
- `chunkText` as reached from `ingestDocument` at the default cap → exact chunk-boundary
  assert (fixtures stay in the test file, per spec).

Fixtures are small, self-contained objects (one candidate/fact/event set each); expected
strings are captured from the pre-change tree and pasted literally into the test.

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
  charsPerToken 4; with `charsPerToken: 2` → 5 (doubles the chars/4 estimate — spec test 5).
- Commit: `feat(context-budget): add ContextBudget type and estimateTokensWith wrapper`

### T3 — Resolver module (spec Proposed change 1, 4; rulings R1–R3)

Files: `packages/core/src/config/context.ts` (new; this commit also creates the
`config/` directory).

Exports (imports the constants from their current modules — never duplicates them):
`OPS_RESOLVE_MAX_PROMPT_CHARS` from `services/librarian/ops/resolve.ts`,
`HEAL_MAX_PROMPT_CHARS` from `services/MaintenanceService.ts`,
`OPS_MAX_EXTRACT_CHARS` from `services/librarian/ops/extract.ts`,
`DEFAULT_MAX_CHUNK_LENGTH` from `utils/chunkingDefaults.ts`.

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
  `outputReserveTokens` (when supplied) < 0, non-finite, or ≥ `contextWindowTokens` → throw.
  Throws use the existing invalid-config error style (plain `Error` with a
  `[core-llm-wiki]`-prefixed message, like `engineDefaults` warnings / `ingestDocument`'s
  `Invalid sourceHash` throw — never a silent fallback to `'legacy'`, per R3).
  Defaults per R1: `charsPerToken 4`, `safetyFraction 0.9`, `outputReserveTokens 4000`.
  Derived prompt cap for op:
  `max(OP_FLOOR[op], floor((contextWindowTokens - outputReserveTokens) * safetyFraction * charsPerToken))`
  where `OP_FLOOR = { resolve: 40_000, heal: 40_000, extract: 24_000 }` — the floor is today's
  cap as a one-batch minimum, so a derived value never lands at zero or negative (spec
  Proposed change 4; test 3 clamp case). `resolveDefaultChunkLength` still returns 12000 (R2).

Config type addition rides T4 (same interface `WikiConfig` — one commit per compile-green
unit would split the type from its only consumer; they go together).

- Test (`config/context.test.ts`, modeled on `engineDefaults.test.ts`): constant pin
  (spec test 2 — legacy returns 40_000/40_000/24_000/12000 literally, so a silent constant
  edit fails CI); declared formula outputs for representative windows; every validation throw
  from the list above; the floor clamp (`contextWindowTokens: 8000` → resolve/heal 40_000,
  extract 24_000); chunk default 12000 in both modes.
- Commit: `feat(context-budget): add config/context.ts resolver with legacy/declared modes`

### T4 — Config type + cap swaps (spec Proposed change 3; five one-line edits + threading)

Files: `packages/core/src/types.ts`, `services/librarian/ops/resolve.ts`,
`services/MaintenanceService.ts`, `services/librarian/ops/extract.ts`,
`services/librarian/ops/index.ts`, `services/IngestionService.ts`, plus the 14
`selectBatch(...)` test call sites in three existing test files (see Extract below).

- `types.ts`: add to `WikiConfig` (line ~296):

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
- **Extract:** `selectBatch` (`extract.ts:52`) gains a REQUIRED `budget: ContextBudget`
  parameter as its **LAST** parameter, after `guidance?` — no existing positional argument
  moves, and no default exists (an absent budget is a caller bug, per the no-fallback rule).
  Line 65's cap compare uses `resolveMaxPromptChars(budget, 'extract')`; **line 74 (the
  `RESOLVE_RESERVE_FACTOR` reserve check) is untouched** — it derives from the prompt
  estimate, not from the swapped constant. The caller at `ops/index.ts:33` resolves the
  budget once at librarian-pass entry and passes it. **Test call-site updates are in
  scope:** the 14 existing `selectBatch(...)` call sites across
  `__tests__/opsExtract.test.ts`, `__tests__/services/librarian/ops/extract-merge.test.ts`,
  and `extract-overflow.test.ts` gain the trailing budget argument
  (`resolveContextBudget(undefined)` for legacy behavior); existing suites are unchanged
  behaviorally but not source-identical.
  - `ingestDocument` (`IngestionService.ts:129`): keep the override chain verbatim, swap
    only the final fallback:
    `params.maxChunkLength ?? this.options.config?.maxChunkLength ?? resolveDefaultChunkLength(budget)`
    — explicit host/config `maxChunkLength` always wins; the existing contract at that line
    is preserved.
- No existing export changes value or name; the four constants stay exported where they are.
- Run: T1's byte-identity suite again — Expected: PASS unchanged (the swaps resolve to the
  identical numbers under legacy). Then `pnpm -r typecheck`.
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

- Run: `pnpm -r typecheck`; spot-import check (`node -e` via built package or a test import)
  that the five names resolve.
- Commit: `feat(context-budget): export context-budget resolver surface from core index`

### T6 — Remaining tests (spec test plan 3–7; test 1–2 landed with T1/T3)

Files: `packages/core/__tests__/contextBudget.test.ts` (extend),
`packages/core/__tests__/contextBudgetIngest.test.ts` (new).

- Override precedence (spec test 4): `ingestDocument` with explicit `maxChunkLength` ignores
  the resolver (stub provider, assert chunking used the explicit value even under a declared
  config that would derive differently); config-level `maxChunkLength` beats the resolver
  fallback; resolver fallback under legacy equals 12000.
- Estimate wrapper (spec test 5) — landed T2; only cross-check here that a declared budget
  does NOT change meter accounting (meter still calls `estimateTokens`): one test asserting
  a `UsageMeter` fed the same text under a declared budget still accrues chars/4 tokens.
- Backfill exclusion (spec test 6): assert `ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS === 40_000`;
  the reviewer-facing guarantee is also structural — grep-confirm in the final diff that
  `MaintenanceService.ts:2144` is absent from every hunk.
- Declared-mode tests feed the resolver through `resolveContextBudget({ context: {...} })`
  with `contextWindowTokens` set (R3 — reachable now); no directly-constructed-budget
  shortcut is needed (the spec's conditional in test 3 is moot under R3).
- Run: full vitest suite (`pnpm -r --filter=!@equationalapplications/integration-llm-wiki
  test` or the repo's standard unit gate) — all existing suites pass (the T4 signature
  updates are call-site-only; behavior unchanged — the T1 pins make this a real guard).
- Commit: `test(context-budget): override precedence, meter independence, backfill exclusion`

### T7 — Gates + PR wrap

- Full gates: typecheck + unit suite green; `git diff origin/main..HEAD` grep-swept to
  confirm: only the spec's Files-touched set — eight original entries plus
  `ops/index.ts` (spec amendment 2026-11-21) and the three existing test files carrying
  signature-only call-site updates — no `LLMProvider` change, no line-74
  edit, no line-2144 edit, no `estimateTokens` call-site change.
- Update `specs/context-budget/LEDGER.md` (one checkbox per T-task with evidence links) in
  the implementation phase — ledger is transient, deleted by the cleanup commit.
- No merge, no `gh pr ready` from this lane step; controller reviews the converged plan
  before implementation starts.

---

## Implementation order & dependencies

T1 (pins, pre-change) → T2 (type+wrapper) → T3 (resolver) → T4 (type+swaps; depends on T2+T3)
→ T5 (exports) → T6 (remaining tests) → T7 (gates). T2/T3 are independent of T1 but land
after it so the pins exist before any behavior-adjacent code. No task touches files outside
the spec's Files-touched list plus the two test files.

## Execution & review protocol (standing)

- This plan gates implementation: coding starts only after the controller's review of the
  converged plan. Owner rulings R1–R3 are settled; no further owner ask is queued.
- Each task commits separately (conventional commits naming the spec section), ACs green
  before the next task; commits authored as Tessera <tessera@equational.app>.
- Dual review after implementation per lane convention; cleanup commit (step 4) later.

## Spec ambiguities hit while planning, and resolutions

1. **`selectBatch` parameter position and optionality.** Spec says "in the pattern of its
   existing `meter?`/`guidance?` parameters" but those are optional trailing params while
   the budget is always available at the call sites. Resolution (r1 review): REQUIRED and
   LAST, after `guidance?` — no positional argument moves; the 14 existing test call sites
   gain the trailing argument. No default — an absent budget is a caller bug, not a legacy
   fallback.
2. **Where `budget` comes from in `doRunHeal`/`runResolve`.** Both hold service options
   (`this.options.config` / `deps.options.config`); the plan resolves at entry and closes
   over it. No new plumbing.
3. **Declared-mode floor semantics.** Spec text gives both "floors at today's caps" and
   "never zero or negative". Resolution: `max(OP_FLOOR[op], derived)` — one rule satisfying
   both sentences; the clamp test pins it.
4. **`estimateTokensWith` is dead code at ship.** The spec's test 5 explicitly scopes it as a
   unit test of the wrapper; metering keeps `estimateTokens` until the follow-up PR. The
   export is intentional surface, not premature code (T5 exports it).
