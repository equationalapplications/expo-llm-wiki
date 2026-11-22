# Resolution from System-One — plan

Spec: `specs/resolution-system-one/spec.md`

Authority: INTENT beats spec beats plan. The spec is owner-approved
(2026-11-22, Discord msg `1574134804725760061`). Its eight rulings bind
every task below.

## Conventions

- All paths are relative to `packages/core/` unless they start with `specs/`
  or `docs/`.
- `CORE` means `pnpm --filter @equationalapplications/core-llm-wiki`.
- The full suite command is `CORE test`. The typecheck command is
  `CORE typecheck`.
- A fast loop runs one file: `CORE exec vitest run __tests__/<file>`.
- Each task is red-first. The implementer writes the named test, runs it,
  and sees it fail. Then the implementer writes the code and sees it pass.
- "The screen" means the classifier resolution screen of spec §4.
- "The prologue" means the screening prologue function of spec §5.
  This plan names it `screenResolveCandidates` in `ops/resolve.ts`.
- "Settled" means a candidate that the screen resolved to a terminal NOOP.
- "Fall through" means a candidate goes on to the generative resolve.
- "The floor" means `systemOne.minConfidence.resolve`.
- The implementer never runs prettier. Every diff stays hand-formatted.
- Warn-once tests follow the step-10 isolation pattern in
  `__tests__/systemOneConfig.test.ts:453-541`. Each case uses a distinct
  invalid value, or the test resets modules before it runs.

## Baseline

The controller measures the full core suite at lane base `206936cc`.
`LEDGER.md` records the number on its baseline line. Step 10 landed at
255 files / 3014 tests; the controller re-measures and does not assume it.

## Invariants (no task may break these)

- `runBatched` (`src/services/BoundedLlmCall.ts`) stays untouched.
- `validateOp` (`src/services/librarian/ops/resolve.ts:39-55`) stays untouched.
- `buildOpsResolvePrompt` (`src/services/PromptService.ts`) stays untouched.
  The implementer hoists nothing out of it.
- `src/services/librarian/ops/gate.ts` stays untouched.
- `src/services/librarian/ops/apply.ts` stays untouched.
- `LibrarianResult` (`src/services/librarian/types.ts:109-116`) stays untouched.
- The public export surface gains only `resolveSystemOneResolve` and
  `resolveResolveMinConfidence`.
- With no `systemOne.resolve` key set, the classifier path and the
  generative prompts stay byte-identical to `206936cc`.
- The change adds zero new diagnostic codes. Receipts reuse
  `fact_deduplicated` with `detail.reason: 'classifier'`.
- The resolvers use `??` and never `||`.

## Tasks

1. **Baseline and ledger reconcile.** The controller fills the baseline
   line in `LEDGER.md`. The implementer reconciles the ledger against the
   disk before any edit.
   - Files: `specs/resolution-system-one/LEDGER.md`.
   - Test: none new. Run the existing suite and typecheck at lane base.
   - Verification: `CORE test` and `CORE typecheck`, both green; the
     file and test counts match the ledger baseline line.

2. **Config surface: the `'resolve'` site member and the `resolve` key**
   (spec §1, §2, §8).
   - Test first, in `__tests__/systemOneConfig.test.ts`, a new describe
     block "resolve config surface (resolution-system-one §1, §2)". It
     asserts that a `WikiConfig` literal with
     `systemOne: { resolve: 'auto', minConfidence: { resolve: 0.8 } }`
     typechecks. It also carries a `// @ts-expect-error` line for
     `resolve: 'off'`. This block fails typecheck before the change.
   - Code: `src/config/systemOne.ts`. Change line 13 to
     `'typing' | 'edges' | 'resolve'`. Add `resolve?: 'auto' | 'llm'`
     beside `edges`, with the spec §2 docstring. Update the module
     docstring (lines 5-8) so `'resolve'` joins the shipped sites. Update
     the line-12 docstring to "Exactly three members".
   - Docstring wording: the warning for an unavailable classifier fires
     once per process (ruling Q5). The docstring says "once per process",
     not "once per pass" (see `LEDGER.md` D4).
   - Verification: `CORE typecheck` clean, then
     `CORE exec vitest run __tests__/systemOneConfig.test.ts` green.

3. **Mode resolver `resolveSystemOneResolve`** (spec §2; test plan item 2).
   - Test first, in `__tests__/systemOneConfig.test.ts`, a new describe
     block "resolveSystemOneResolve (resolution-system-one §2)". It imports
     from `../src/utils/engineDefaults`. Cases:
     - unset config, unset `systemOne`, unset key → `'llm'`;
     - `'auto'` → `'auto'`; `'llm'` → `'llm'`;
     - an invalid value (`'off'`, `1`, `null`, `1n`) → `'llm'`, plus exactly
       one `console.warn` that names `systemOne.resolve`;
     - the same invalid value twice → still one warning;
     - a provider with `classify` and no key → `'llm'`.
   - Code: `src/utils/engineDefaults.ts`. Add `resolveSystemOneResolve`
     directly after `resolveSystemOneEdges`. It mirrors that function:
     reuse `isTypingMode`, `formatConfigValue`, and `warnOnce`. It returns
     `config?.systemOne?.resolve ?? 'llm'`.
   - Verification: `CORE exec vitest run __tests__/systemOneConfig.test.ts`
     green.

4. **Floor resolver `resolveResolveMinConfidence`** (spec §3; test plan
   item 3).
   - Test first, same file, a new describe block
     "resolveResolveMinConfidence (resolution-system-one §3)". Cases:
     - mode unset or `'llm'`, floor present → `undefined`, zero warnings
       (the resolver reads no floor outside `'auto'`);
     - `'auto'` with no floor → `undefined`, one warning naming
       `systemOne.minConfidence.resolve` as required (posture A);
     - `'auto'` with `NaN`, `0.49`, `1.01`, `-1`, `'0.8'` → `undefined`, one
       warning per value naming the domain [0.5, 1];
     - endpoints `0.5` and `1` → returned unchanged, zero warnings;
     - `0.8` → `0.8`;
     - an invalid mode with a valid floor → `undefined` (the mode warning
       fires; the floor is never read).
   - Code: `src/utils/engineDefaults.ts`. Add `resolveResolveMinConfidence`
     after `resolveEdgesMinConfidence`. It reuses `isEdgesFloor`. It has no
     default floor. The warning text names the data-loss asymmetry: a wrong
     NOOP drops a live fact.
   - Verification: `CORE exec vitest run __tests__/systemOneConfig.test.ts`
     and `CORE exec vitest run __tests__/engineDefaults.test.ts` green.

5. **The prologue `screenResolveCandidates`** (spec §4, §5; test plan items
   4 and 5, unit level). Hold the question text and the budget path until
   the controller answers `LEDGER.md` D3 and D5.
   - Test first, in `__tests__/opsResolve.test.ts`, a new describe block
     "screenResolveCandidates (resolution-system-one §4, §5)". The tests
     call the prologue directly with a fake classifier. Cases:
     - mode `'llm'` → `settled` empty, `rest` equals the input, and the
       fake classifier records zero calls;
     - mode `'auto'` with no floor → `settled` empty, `warnReason: 'no-floor'`,
       zero classifier calls;
     - mode `'auto'`, floor set, `classify` absent →
       `warnReason: 'no-classifier'`, `settled` empty, `rest` equals input;
     - YES at `probability >= floor` → a NOOP on `neighbours[0].id`;
     - YES at exactly the floor value → settled (the comparison is `>=`);
     - NO and uncertain-band answers → the candidate stays in `rest`;
     - malformed answers (missing key, `kind: 'choice'`, `NaN`, `1.5`,
       a throwing getter) → the candidate stays in `rest`, no throw;
     - one `ClassifyRequest` per candidate, with exactly one `binary`
       question, keyed to `neighbours[0].ref` only;
     - per-candidate scoping: a YES for candidate A never settles
       candidate B, and B's NOOP never targets A's neighbour;
     - an update-shaped pair ("Alice lives in Berlin" against "Alice lives
       in Paris") does not settle. The fake classifier models the
       duplicate-only question: it answers YES only when the claims match.
       The test also pins the question text to the spec §4 wording;
     - all-or-nothing: the classifier throws on the second candidate →
       `settled` is empty, `rest` equals the whole input, and the result
       carries `warnReason: 'no-classifier'` (see `LEDGER.md` D5 for the
       budget case);
     - a candidate with no neighbours never reaches the screen (the gate
       routes it to ADD); the test asserts the prologue skips it safely.
   - Code: `src/services/librarian/ops/resolve.ts`. Add and export
     `screenResolveCandidates`. Its inputs are the ambiguous candidates,
     the resolved mode, the resolved floor, and a classify function. It
     calls the classifier through `callClassify` (`src/utils/llmCall.ts:79`),
     the one wrapper every classify call site must use. It validates each
     answer with `validateClassifierAnswer` (`src/utils/classifier.ts`).
     It builds the state with `classifierStateForFact`. It returns
     `{ settled, rest, warnReason? }`.
   - Verification: `CORE exec vitest run __tests__/opsResolve.test.ts`
     green, and the existing `validateOp` and `runResolve` cases there
     pass unchanged.

6. **Wire the prologue into `runResolve`** (spec §5, §7; test plan items 1
   and 5). Hold the return-shape choice until the controller answers
   `LEDGER.md` D2.
   - Test first, in `__tests__/opsResolve.test.ts`, a new describe block
     "runResolve with the screen (resolution-system-one §5, §7)". Cases:
     - compatibility: with no key, with `'llm'`, and with `classify`
       present but no key, the test captures every argument passed to
       `buildOpsResolvePrompt` and every prompt string passed to the LLM.
       All three runs match a no-classifier run byte for byte. The fake
       classifier records zero calls;
     - a mixed batch: the LLM receives only `rest`; settled candidates
       appear in `ops` as NOOPs; `rest` items keep their generative ops;
     - an all-settled batch → zero LLM calls;
     - classifier absent or throwing → one warning per process, the whole
       batch goes to the LLM, and the outcome matches a no-screen run;
     - overflow skips: a settled candidate never appears in
       `overflowSkipped`.
   - Code: `src/services/librarian/ops/resolve.ts`. `runResolve` resolves
     the mode and floor, calls the prologue, emits the unavailable warning
     through `warnOnce` with one fixed message, and passes only `rest` to
     `runBatched`. An empty `rest` skips the LLM call, as line 77 does
     today. `runResolve` copies settled ops into `out.ops`.
   - Verification: `CORE exec vitest run __tests__/opsResolve.test.ts` green.

7. **Receipt emission loop in `ops/index.ts`** (spec §6; test plan item 6).
   Hold until the controller answers `LEDGER.md` D2.
   - Test first: task 9 writes the pass-level receipt tests. The
     implementer writes those receipt cases before this code.
   - Code: `src/services/librarian/ops/index.ts`. After `runResolve`
     returns, push one `fact_deduplicated` diagnostic per settled candidate
     into the pass-level `DiagnosticBuffer`, with
     `detail: { itemIndex, reason: 'classifier' }`. The loop sits beside the
     `overflowSkipped` loop and before the `budgetStop` check, so a budget
     stop discards the receipts with the pass.
   - Verification: the task 9 receipt cases go green.

8. **Public exports** (spec "Files touched"; invariant on export surface).
   - Test first, in `__tests__/systemOneConfig.test.ts`, a new describe
     block "public export surface (step 11)". It imports `../src/index` and
     asserts both new resolvers are functions that return the expected
     values. It asserts `screenResolveCandidates` is absent from the index.
     Task 10 audits the full export diff.
   - Code: `src/index.ts`. Add `resolveSystemOneResolve` and
     `resolveResolveMinConfidence` to the existing `engineDefaults` export
     block. The implementer does not export `screenResolveCandidates`.
   - Verification: `CORE exec vitest run __tests__/systemOneConfig.test.ts`
     green.

9. **Pass-level tests** (spec §4-§6; test plan items 4, 5, 6 end to end).
   - Test first: a new file `__tests__/opsResolveSystemOne.test.ts`, beside
     `__tests__/opsLibrarian.test.ts`, reusing its wiki and provider setup.
     Cases:
     - screen → apply: a confident YES drops the candidate; no row is
       written; the neighbour is unchanged;
     - receipts: the pass emits exactly one `fact_deduplicated` with
       `detail.reason: 'classifier'` per settled candidate;
     - zero new codes: the test lists every emitted code and asserts each
       one appears in a fixed list of the codes this file expects;
     - the pass result carries only `processedThrough`, `factsWritten`,
       and the other keys it carries at `206936cc` (task 10 audits the type);
     - keyword mode: the screen engages (ruling Q4);
     - fall through: NO, uncertain, and malformed answers reach the
       generative resolve, and apply handles their ops as today;
     - classifier absent or throwing: one warning, whole-batch fall
       through, and the pass still applies and advances the watermark;
     - budget stop in the generative leg discards the classifier receipts.
   - Verification: `CORE exec vitest run __tests__/opsResolveSystemOne.test.ts`
     and `CORE exec vitest run __tests__/opsLibrarian.test.ts` green.

10. **Invariant audit.**
    - Test: none new. The existing pins must pass unchanged:
      `__tests__/opsResolve.test.ts` (original cases), `opsGate.test.ts`,
      `opsPrompts.test.ts`, `opsLibrarian.test.ts`, `opsConfig.test.ts`,
      `opsAutoFirstBatch.test.ts`, `engineDefaults.test.ts`, and the step-10
      blocks in `systemOneConfig.test.ts`.
    - Verification: run from the repo root:
      `git diff --stat 206936cc -- packages/core/src/services/BoundedLlmCall.ts packages/core/src/services/PromptService.ts packages/core/src/services/librarian/ops/gate.ts packages/core/src/services/librarian/ops/apply.ts packages/core/src/services/librarian/types.ts packages/core/src/types.ts packages/core/src/utils/diagnostics.ts`
      prints nothing. That empty diff proves `LibrarianResult` and the
      diagnostic code union are unchanged.
      `git diff 206936cc -- packages/core/src/index.ts` shows exactly two
      added lines: the two resolver names. The reviewer reads `git diff 206936cc -- packages/core/src/services/librarian/ops/resolve.ts`
      and confirms no hunk touches `validateOp`. The reviewer confirms no
      diff hunk reformats untouched lines.

11. **Suite health** (test plan item 7).
    - Test: the full suite.
    - Verification: `CORE test` green with the baseline count plus the new
      tests and no removed tests; `CORE typecheck` clean; root `pnpm test`
      green.

12. **Cleanup commit** (`specs/README.md` lifecycle step 4). Hold the
    roadmap line until the controller answers `LEDGER.md` D1.
    - Files: `specs/resolution-system-one/spec.md` (Status flips to
      Implemented), `plan.md` and `LEDGER.md` (deleted), and
      `docs/ROADMAP.md` (step 11 gains its one-line Done mark).
    - Timing: after the tiered review loops converge, and before
      `gh pr ready`.
    - Verification: `ls specs/resolution-system-one` lists only `spec.md`;
      `grep -n "Status:" specs/resolution-system-one/spec.md` shows
      Implemented; `CORE test` stays green.
