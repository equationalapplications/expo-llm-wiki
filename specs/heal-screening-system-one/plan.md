# Plan — Step 12: Heal screening from System-One (lane A)

Spec: `specs/heal-screening-system-one/spec.md` (Status: Approved by owner
2026-11-22, Discord thread `1570840529388965951`, msg `1574148740716175392`).
The eight open-question rulings in the spec are BINDING and are not re-opened
here: 1(a) `{id, confidence}` contract with bare-string wire compat; 2 receipts
on both surfaces; 3 SQL passes get no receipts; 4 two flat arrays; 5 withheld
ids keep the cooldown stamp; 6 one prompt for ALL hosts; 7 pair-withhold
deferred; 8 receipts fire in EVERY mode.

Ledger: `specs/heal-screening-system-one/LEDGER.md`. Base: lane tip
`09f5678b` (spec-only commits since `206936cc`; the controller's measured
baseline at `a39dc80c` still holds).

## Pin re-verification (plan author, 2026-11-22, live tree)

Every pin the plan relies on was re-checked against this worktree and matches
the spec:

| Pin | Live |
|---|---|
| engineDefaults import line | `MaintenanceService.ts:15` (single line) |
| `HEAL_RECHECK_MS` | `MaintenanceService.ts:89` |
| `deliverHealRemovals` helper | `MaintenanceService.ts:1460` |
| `doRunHeal` / `diagBase` | `:1710` / `:1723` |
| keyword-outage `heal_skipped` emit | `:1772` |
| `callLlm` / parse | `:1860` / `:1861-1870` (`parseJsonResponse` at `:1862`) |
| guard loop | `:1889-1908` (`mutableIds` checks `:1901-1902`) |
| `safeDowngraded`/`safeDeleted` | `:1910-1911` |
| `diagBuffer` created | `:1912` |
| `uniqueDeletedFactIds` | `:1929` |
| tx / apply | `:1947` / `:1948-1949` |
| `findInferredTitlesByEntityId` (dedupe read) | `:1952` |
| `heal_skipped` per-fact push | `:2031` |
| `healSyncIds` / sync / removals | `:2040` / `:2047` / `:2049` |
| `allDowngraded`/`allDeleted` / counts | `:2085-2086` / `:2091-2092` |
| `SystemOneThresholdSite` / `edges?` / `minConfidence?` | `systemOne.ts:13` / `:33` / `:35` |
| `resolveSystemOneEdges` / `isEdgesFloor` / `resolveEdgesMinConfidence` | `engineDefaults.ts:159` / `:221` / `:231` |
| `HealResult` / `healSystemPrompt?` / `systemOne?` doc | `types.ts:211` / `:45` / `:403-409` |
| `heal_skipped` code / SEVERITY / MESSAGE | `types.ts:927` / `diagnostics.ts:27` / `:82` |
| `edgeDropDiagnostic` | `diagnostics.ts:271` |
| heal schema id lists | `prompts.ts:44-45` |
| resolver exports | `index.ts:29-32` |
| export-surface lock | `systemOneConfig.test.ts:543` (`public export surface (step 10)`) |

## INVARIANTS (repeated verbatim in every wave brief)

1. `EntryRepository` method signatures unchanged.
2. `MaintenanceService.ts` edits are confined to the heal region (~L1710-2100)
   plus the engineDefaults import line (`:15`).
3. No edge machinery: no changes to `OntologyService`, `resolveEdges`, or
   `EdgeDropReason`.
4. No `'off'` mode.
5. `??` not `||` everywhere.
6. Union members are added as ONE line each.
7. No prettier reformatting.
8. No `BREAKING CHANGE` footer (it needs a ruling, and none is being sought
   this cycle).

Lane rules on top of the invariants:
- Never touch the `'resolve'` member, its resolvers, or its tests (PR #461's
  lane). This lane adds `'healScreen'` only.
- No `CHANGELOG.md` or `"version"` edits. pnpm only. Merge commits, not
  squash. This lane opens NO PR until PR #461 resolves.
- Ledger boxes are ticked only after the task's gate passes. At the start of
  every wave, reconcile the ledger against the disk (`git log`, file contents).
  If they disagree, trust the disk, roll the ledger back, and log it.
- Stop and ask: if a pin in this plan, the spec, or the tree disagree, halt
  the wave and report it to the controller. Do not invent a resolution.

## Gate commands (controller)

- `G-unit <file>`: `cd packages/core && npx vitest run __tests__/<file>`
- `G-full`: `cd packages/core && npx vitest run` and `pnpm -r typecheck` from
  the repo root. If `@equationalapplications/core-okf` fails to resolve, first
  run `pnpm -r --filter './packages/*' build`.
- `G-fence`: `git diff <base>..HEAD -- packages/core/src/services/MaintenanceService.ts`
  must show hunks only at `:15` and inside `doRunHeal`. `git diff` must show
  no change to `EntryRepository*`, `OntologyService*`, `CHANGELOG.md`, or any
  `"version"` field. `grep -n "||" ` over the added lines must show no
  defaulting `||`.

---

## Wave 1: baseline and leaf surfaces (5 tasks)

### T1.1: BASELINE STOP-GATE
- Files: none (ledger only).
- Do: run `G-full` before changing any code.
- Accept: 255 test files and 3014 tests all pass, and typecheck is clean in
  every package. Record the counts, wall time, and HEAD sha in LEDGER row W1.
- On mismatch: HALT the wave, change no code, and report the delta to the
  controller.
- Gate: `G-full`.

### T1.2: Rule-11 bench BEFORE baseline (spec test item 14, part 1)
- Files: none in source. Run artifacts go to
  `.sdd/step12/bench-before.json` (untracked scratch; numbers are copied into
  the LEDGER).
- Do, at base HEAD before any heal edit:
  (a) Prompt-volume measurement of `HEAL_SYSTEM_PROMPT` (characters, plus
  tokens if the harness reports them) via `packages/benchmarks`
  `promptVolume.ts`. This is the default-path prompt cost, which ruling 6
  changes for every host.
  (b) `pnpm --filter benchmarks ... supersession --strategy legacy --dry-run`
  for the spend estimate (the legacy strategy exercises a heal pass, per the
  `cli.ts:481` doc comment).
  (c) Only after the controller approves the dry-run estimate, run the same
  command with `--yes --out .sdd/step12/bench-before.json`.
- Accept: the LEDGER records the prompt char/token count, the dry-run
  estimate, and (if approved) the measured heal-call tokens and outcome
  metrics, with sha and date. The harness opens only in-memory or cache SQLite
  files; never point it at a live store. If spend is not approved, record
  "not run, reason" and carry the gap to the PR body. Make no unmeasured
  claims anywhere.
- Gate: artifacts exist and the LEDGER row is filled.

### T1.3: `systemOne.ts`: union member and engagement key (spec §1, §2, §9)
- Files: `packages/core/src/config/systemOne.ts`.
- Do: L13 becomes `'typing' | 'edges' | 'healScreen'`, a ONE-line addition
  with the existing line shape kept. Add `healScreen?: 'auto' | 'llm';` beside
  `edges?` (`:33`) with the spec §2 docstring verbatim. Update the fence
  comment (`:2-9`) so `'healScreen'` is past tense, and change "Exactly two
  members today" (`:12`) to three.
- Accept: typecheck is clean. `minConfidence.healScreen` type-checks through
  the existing `Partial<Record<…>>` (`:35`). No `'off'` literal anywhere.
- Gate: `pnpm -r typecheck`.

### T1.4: Diagnostic codes, severities, messages, `HealResult` fields (spec §5, §6, item 10)
- Files: `packages/core/src/types.ts`, `packages/core/src/utils/diagnostics.ts`,
  and the vocabulary test (see note).
- Do: add `| 'heal_deleted'` and `| 'heal_downgraded'` to `WikiDiagnosticCode`
  after `heal_skipped` (`types.ts:927`), one line each. Add both to SEVERITY
  as `'info'` and to MESSAGE using the spec §5 suggested text, in both
  exhaustive maps in `diagnostics.ts`. Add `downgradedIds?: string[]` and
  `deletedIds?: string[]` to `HealResult` (`types.ts:211-249`) with the
  spec §6 docstrings verbatim. Do not touch `types.ts:403-409` yet (T3.3 does
  it, after the peer lane).
- Vocabulary test: `ontologyReceiptVocabulary.test.ts` does not reference
  `heal_skipped` today. Grep `packages/core/__tests__` for a test that pins the
  SEVERITY/MESSAGE maps over heal codes and extend that one. If none exists,
  add a `heal receipt vocabulary` describe to
  `ontologyReceiptVocabulary.test.ts`.
- Accept: a new test asserts both codes are severity `info` and their messages
  equal the §5 strings. Existing vocabulary tests still pass. Typecheck is
  clean.
- Gate: `G-unit` on the vocabulary test, plus `pnpm -r typecheck`.

### T1.5: Resolvers, exports, resolver tests (spec §2, §3, item 1)
- Files: `packages/core/src/utils/engineDefaults.ts`,
  `packages/core/src/index.ts`, `packages/core/__tests__/systemOneConfig.test.ts`.
- Do: add `resolveSystemOneHealScreen(config): 'auto' | 'llm'`, mirroring
  `resolveSystemOneEdges` (`:159-169`) verbatim with `config?.systemOne?.healScreen ?? 'llm'`.
  A present invalid value warns once via `warnOnce` and is treated as unset.
  Add `resolveHealScreenMinConfidence(config): number | undefined`, mirroring
  `resolveEdgesMinConfidence` (`:231-243`) and reusing the `isEdgesFloor`
  [0.5, 1] validator. It returns `undefined` unless the mode is `'auto'`. When
  the mode is `'auto'` and the floor is missing or outside the domain, it warns
  once naming `systemOne.minConfidence.healScreen` and returns `undefined`, so
  the site resolves `'llm'`. There is no default floor. Export both from
  `index.ts` beside `:29-32` (sibling lines; do not touch `'resolve'`
  exports). Append three describes: `healScreen config surface
  (heal-screening-system-one §1, §2)`, `resolveSystemOneHealScreen (§2)`, and
  `resolveHealScreenMinConfidence (§3)`.
- Accept (item 1):
  - unset, `{}`, `{systemOne:{}}` → `'llm'`.
  - `'auto'`/`'llm'` pass through.
  - `'hybrid' as never` → warns once (a second call does not warn) and
    resolves `'llm'`.
  - `'auto'` with no floor → warn ONCE naming
    `systemOne.minConfidence.healScreen`, returns `undefined`.
  - floors `0`, `0.3`, `1.01`, `NaN` → warn once, `undefined`.
  - `0.5` and `1` pass through.
  - `'llm'` with a floor present → `undefined`, and the floor is not read
    (no warn).
  - Do not edit the `public export surface (step 10)` lock test here (see
    T4.2).
- Gate: `G-unit systemOneConfig.test.ts`, plus `pnpm -r typecheck`.

Wave 1 exit: `G-full` passes. The test count is baseline + the new tests, and
no existing test changed except the vocabulary extension. `G-fence` shows no
`MaintenanceService.ts` change yet.

---

## Wave 2: prompt, parse, seam, receipts, id lists (4 tasks; `MaintenanceService.ts` heal region only)

All tests for this wave go in a NEW `packages/core/__tests__/healScreen.test.ts`
(beside `healBounding.test.ts`/`healBudget.test.ts`, reusing their
mock-provider/DB harness).

### T2.1: `HEAL_SYSTEM_PROMPT` schema (ruling 1a, ruling 6)
- Files: `packages/core/src/prompts.ts`.
- Do: change `prompts.ts:44-45` so `downgraded`/`deleted` entries are
  `{ "id": "string (fact ID)", "confidence": "number 0-1" }`, plus at most one
  instruction line that `confidence` is the model's confidence in that verdict.
  Use one prompt for ALL hosts. `PromptService.ts` is NOT modified.
- Accept: a test asserts `HEAL_SYSTEM_PROMPT` contains the `confidence` field
  in both arrays. Existing prompt snapshot tests, if any, are updated in this
  task and listed in the commit body.
- Gate: `G-unit` on the affected prompt tests.

### T2.2: Widened parse, confidence carrier, wire compat (spec §4 plumbing 1 and 3, item 5)
- Files: `MaintenanceService.ts` (parse at `:1861-1870`, plus a new merge loop
  inserted between `:1908` and `:1910`), `healScreen.test.ts`.
- Do:
  - The parse accepts each array entry as a bare string OR `{id, confidence}`.
    It normalizes to bare string ids in EVERY mode, and drops entries with no
    string id. Per batch it returns `downgraded: string[]`, `deleted: string[]`,
    and two `Map<string, number>` carriers holding only valid confidences:
    finite and in [0, 1]. NaN, negative, >1, or non-numeric values are absent
    from the map, which means MISSING.
  - Guard lines `:1899-1908` stay byte-identical. Immediately after them, add
    one sibling loop over `outcome.results` that rebuilds each batch's
    `mutableIds` and merges ONLY admitted ids' confidences into run-level
    `downgradeConfidence`/`deleteConfidence` maps. The LOWEST value wins on
    duplicate ids.
  - Under resolved `'auto'` only, an admitted verdict with no valid confidence
    triggers one `warnOnce` naming the `{id, confidence}` contract migration
    AND `healSystemPrompt` (spec §8).
- Accept (item 5, `describe('wire compat (§4, OQ1a)')`):
  - Bare-string response under `'auto'` + floor 0.7: every admitted verdict
    applies, `warnOnce` fires once across two runs, and the text contains
    `healSystemPrompt`.
  - Bare-string response under `'llm'`: no warning, and apply args equal the
    pre-PR behaviour.
  - Mixed string/object array: both parse.
  - Object response under `'llm'`: ids normalized and applied, so no silent
    drop.
  - Duplicate id across two batches (0.9 and 0.6): carrier holds 0.6.
  - A verdict on a non-offered id carrying confidence 0.1 does NOT lower an
    admitted duplicate's 0.9 (guard-admitted only).
  - Invalid confidences (`NaN`, `-0.1`, `1.5`, `"high"`) count as missing.
- Gate: `G-unit healScreen.test.ts`, plus `G-unit healBounding.test.ts`.

### T2.3: Mode/floor resolution and the applied-set seam (spec §4, items 3, 4, 7, 9; ruling 5)
- Files: `MaintenanceService.ts` (import line `:15`, entry beside `:1723`, seam
  between `:1911` and `:1929`), `healScreen.test.ts`.
- Do:
  - Import the two resolvers on the existing `:15` line.
  - At entry beside `diagBase`, resolve `healFloor =
    resolveHealScreenMinConfidence(this.options.config)` once. Screening is
    engaged iff `healFloor !== undefined`.
  - At the seam (after `:1911`, before `:1929`), split each side:
    - confidence present and `≥ floor` → applied;
    - confidence present and `< floor` → withheld, recorded with its
      confidence in `withheldDowngraded`/`withheldDeleted`;
    - missing → applied and recorded as unscreened.
  - Rebind so `safeDowngraded`/`safeDeleted`, or `appliedDowngraded`/
    `appliedDeleted` with every later reader switched over, are THE sets all
    five downstream readers see: the apply `:1948-1949`, `uniqueDeletedFactIds`
    `:1929` and its consumers (sync `:2044`, removals `:2049`, `allDeleted`
    `:2086`), and `healSyncIds` `:2043`.
  - When the floor is undefined, the applied sets equal the guard sets
    exactly.
  - Do not touch the SQL passes, `newFacts`, `batchSize` validation, the
    keyword-outage return, or the cooldown-stamp logic (`:2005-2023`).
    Withheld ids are attempted ids, so they keep the stamp (ruling 5).
- Accept (`describe('screen seam (§4)')`):
  - item 3: below-floor delete (0.4 vs floor 0.7) is absent from the
    `softDeleteByIds` args, absent from the `deliverHealRemovals` payload,
    absent from the `syncEntries` ids, and absent from `deletedIds`; the fact
    row stays live. The same holds for a below-floor downgrade
    (`downgradeByIds` args, `healSyncIds`, `downgradedIds`).
  - item 4: floor `1` with fixtures at `0.9`; the orphan pass and the
    stale-inferred pass still run, and their ids appear in
    `deletedIds`/`downgradedIds`.
  - item 7: confidence equal to the floor applies; `0.999` vs floor `1`
    withholds.
  - item 9: one id in both sets is screened independently per action. Cover
    (apply downgrade, withhold delete) and the reverse.
  - ruling 5: a withheld id receives the `heal_checked` stamp and is not
    re-offered on an immediate second run.
- Gate: `G-unit healScreen.test.ts`, plus `G-unit healBounding.test.ts`,
  `healBudget.test.ts`, `healAnchorBounding.test.ts`, and
  `heal-retention-boundary.test.ts`.

### T2.4: Receipts and changed-id lists (spec §5, §6, items 2, 6, 8, 12; rulings 2, 3, 4, 8)
- Files: `MaintenanceService.ts` (push point beside `:2031`, before the
  `:2033` flush; return at `:2085-2093`), `healScreen.test.ts`, and every
  in-repo test that `toEqual`s a whole `HealResult` (find them by grepping
  `newFactsCreated` across `packages/*/__tests__`).
- Do:
  - At the `heal_skipped` push point, push one receipt per (fact, action),
    carried from the seam with no recomputation:
    - applied with a valid confidence, or any applied verdict when the floor
      is undefined → `{factId, reason:'applied'}`;
    - applied and unscreened under `'auto'` →
      `{factId, reason:'applied_unscreened'}`, no `confidence`;
    - withheld → `{factId, reason:'below_floor', confidence}`.
  - Use code `heal_deleted` for the delete action and `heal_downgraded` for
    the downgrade action. Omit unknown locators; never send null.
  - SQL-pass ids get NO receipts.
  - In the return, add `downgradedIds: Array.from(allDowngraded)` and
    `deletedIds: Array.from(allDeleted)`, and keep the counts.
  - Update the `toEqual` churn in the same task.
  - CONTROLLER ADDITION (2026-11-22): the keyword-outage early return must
    also populate `downgradedIds`/`deletedIds` (the run's actual lists, `[]`
    when none) so the "doRunHeal always populates them" docstring holds on
    every path. Leave that return's `heal_skipped` emit untouched, and add a
    test asserting the early return carries both fields.
- Accept:
  - item 2: `'auto'` + floor 0.7 with verdicts 0.8 and 0.9 → apply args as
    today, one `'applied'` receipt per fact, and the id lists carry the ids.
  - item 6: no `systemOne` keys → applied receipts fire with severity `info`
    and reason `'applied'`, there are no `below_floor`/`applied_unscreened`
    receipts, and `deletedIds.length === deleted` and
    `downgradedIds.length === downgraded`.
  - item 8: N model-directed moves → exactly N receipts, and the
    `heal_skipped` count is unchanged.
  - item 12: an injected `downgradeByIds` throw inside the tx → the run
    rejects and zero `heal_deleted`/`heal_downgraded` diagnostics are
    emitted.
  - The SQL-only run (no model verdicts) emits zero receipts and still
    populates the id lists.
- Gate: `G-full`, plus `G-fence`.

Wave 2 exit: `G-full` and `G-fence` pass. The only pre-existing tests changed
are the enumerated `toEqual`/prompt churn, listed in the LEDGER.

---

## Wave 3: scenario closure, docs, status (4 tasks)

### T3.1: Withheld delete plus paired restate (item 13; ruling 7 disclosure)
- Files: `healScreen.test.ts`.
- Do / Accept: under `'auto'` + floor 0.7, give fact X a delete verdict at 0.4
  plus a `newFacts` restatement at Jaccard ≥ the dedupe threshold against X.
  - `softDeleteByIds` args exclude X.
  - The restatement is skipped with a `fact_deduplicated` diagnostic.
  - X survives.
  - A `heal_deleted` `'below_floor'` receipt fires.
  - X is absent from `deletedIds` and from the removals payload.
  - No new fact row is inserted.
  - No pair-withhold code is added; this test pins the disclosed behaviour.
- Gate: `G-unit healScreen.test.ts`.

### T3.2: Host clock-set docs and doc test (spec §7, §9, item 11)
- Files: `apps/docs/src/content/docs/reference/configuration.md`,
  `apps/docs/src/content/docs/guides/maintenance.md`, and a new
  `packages/core/__tests__/healScreenDocs.test.ts` (reads the markdown; if
  `apps/docs` cannot be read from core tests, put the light test wherever the
  repo's existing doc-content tests live and log the location).
- Do: document `systemOne.healScreen` and `systemOne.minConfidence.healScreen`
  (both keys required to engage; [0.5, 1]; no default floor). Add the
  consolidated clock set:
  - `orphanAfterDays`: unset = 30, `null` disables.
  - `staleInferredAfterDays`: unset = 60, `null` disables.
  - `pruneEventsAfter` and `pruneRetainSoftDeletedFor`, with the ≥ 7-day
    guidance tied to `HEAL_RECHECK_MS`.
  - `pruneSupersededAfter`.
  - `event_retention_held`.
  Also include:
  - the "heal may forget when the host runs it" ruling (2026-11-20) and the
    spec §7 suggested line;
  - the `healSystemPrompt` override caveat;
  - the withheld-delete/restate disclosure.
  Make no accuracy or cost claims, and include no unmeasured numbers.
- Accept (item 11): the doc test asserts that all five knob names, both
  `systemOne` keys, and the forget-ruling line are present in
  `configuration.md`.
- Gate: `G-unit healScreenDocs.test.ts`, plus the docs build if the repo has
  one (`pnpm --filter docs build`; skip and log if it is absent).

### T3.3: Docstrings, shared doc comment, roadmap, spec status (spec §9)
- Files: `MaintenanceService.ts` (the `doRunHeal` header only), `types.ts:403-409`,
  `docs/ROADMAP.md` (step 12 Done line, following the steps 7-9 pattern at
  `:232,244,255`), and the `spec.md` Status line.
- Do:
  - `doRunHeal` header: add the screen/floor/receipt contract (§4, §5).
  - `types.ts:403-409`: add `resolveSystemOneHealScreen` /
    `resolveHealScreenMinConfidence` to the resolver list as ONE added clause.
    Leave any `'resolve'` text alone.
  - `docs/ROADMAP.md`: add the step 12 Done line pointing at the spec.
  - `spec.md` Status line: "Implemented" with the date. Spec status honesty is
    mandatory.
- Accept: typecheck is clean, and the diff on `types.ts:403-409` is minimal
  (it is a peer-lane conflict zone).
- Gate: `pnpm -r typecheck`, plus `G-fence`.

### T3.4: Rule-11 bench AFTER and publication (item 14, part 2)
- Files: none in source. Artifacts go to `.sdd/step12/bench-after.json`.
  Numbers go into the LEDGER and the PR-body draft at
  `.sdd/step12/pr-body.md`.
- Do: rerun T1.2's exact commands (same harness, flags, and fixture) at the
  wave-3 tip. The `--yes` run needs controller spend approval again.
- Accept: a before/after table with the `HEAL_SYSTEM_PROMPT` char/token delta
  (the default-path prompt change, ruling 6) and the measured heal-call
  tokens/outcomes, both shas, and the date. The PR body states only measured
  numbers and says plainly that the `'auto'` screen's accuracy is not
  benchmarked. If either run was not authorized, the PR body says so and
  makes no claim.
- Gate: the LEDGER rows for T1.2 and T3.4 are filled and the PR-body draft
  carries the table.

---

## Wave 4: peer-lane rebase and handoff (3 tasks; runs only after PR #461 resolves)

### T4.1: Rebase onto post-#461 `main`
- Do: `git fetch` and rebase the lane onto `main` (or merge `main` in).
  Expected one-line conflicts:
  - `systemOne.ts:13`: keep both members. `'resolve'` is #461's line and must
    not be edited. Keep the line shape #461 landed, add `'healScreen'` as its
    one line, and adjust the fence-comment member count to the true total.
  - `engineDefaults.ts` sibling resolvers: keep both.
  - `index.ts:29-32` exports: keep both.
  - `types.ts:403-409` doc comment: keep both clauses.
  - `systemOneConfig.test.ts` describes: keep both.
  - If #461 is closed unmerged, skip the rebase and log it.
- Accept: no `'resolve'`-lane line is altered (check with `git diff main --`
  on those files: only `healScreen` additions), and `G-full` passes.
- Gate: `G-full`, plus `G-fence` against the new base.

### T4.2: Export-surface lock test (second-lander duty)
- Files: `packages/core/__tests__/systemOneConfig.test.ts` (the `public export
  surface` describe, L543 at base).
- Do: if #461 landed first, this lane is second. Extend the lock test so it
  asserts `typeof idx.resolveSystemOneHealScreen` and
  `typeof idx.resolveHealScreenMinConfidence` are `'function'`, with one
  behavioural call each, keeping #461's assertions intact. If this lane lands
  first, leave the lock test for #461 and log it.
- Accept: the lock test passes and covers both lanes' resolvers.
- Gate: `G-unit systemOneConfig.test.ts`, plus `G-full`.

### T4.3: Final gate and review handoff
- Do:
  - Run `G-full` and `G-fence`.
  - Confirm the coverage map below is satisfied and every LEDGER box is
    ticked with its verification.
  - Confirm commit messages carry no `BREAKING CHANGE` footer.
  - Confirm there is no `package-lock.json`, `CHANGELOG.md`, or version edit.
- Accept: the final counts are recorded (baseline 3014 + new tests, all
  passing) and typecheck is clean.
- Gate: `G-full`. Then the review handoff below.

---

## Test-plan coverage map (spec items 1-14 → tasks)

| Spec item | Task(s) |
|---|---|
| 1 Resolvers | T1.5 (T4.2 export lock) |
| 2 Applied verdict + receipts + id lists | T2.4 (seam T2.3) |
| 3 Below-floor withhold, five readers | T2.3 (receipt half T2.4) |
| 4 SQL passes never gated | T2.3 (id-list half T2.4) |
| 5 Wire compat (bare strings, warnOnce, `applied_unscreened`) | T2.2 (receipt half T2.4) |
| 6 Default mode, receipts in every mode | T2.4 |
| 7 Floor boundaries | T2.3 |
| 8 Per-fact volume pin | T2.4 |
| 9 Both-sets fact | T2.3 (receipts T2.4) |
| 10 Vocabulary | T1.4 |
| 11 Retention-clock doc test | T3.2 |
| 12 Transaction rollback → zero receipts | T2.4 |
| 13 Withheld delete + paired restate | T3.1 |
| 14 Rule-11 measured before/after | T1.2 + T3.4 |

Ruling coverage beyond the items: ruling 5 (cooldown stamp) → T2.3; ruling 6
(prompt to all hosts) → T2.1 + T3.4; ruling 3 (no SQL receipts) → T2.4.

## Detail decisions the plan makes (controller-CONFIRMED 2026-11-22; implement as written)

The spec does not pin these. The plan picks the conservative reading; the
controller reviewed and confirmed all four before Wave 2:
1. If an id has both a valid and a missing confidence across admitted
   duplicate verdicts, the lowest VALID confidence is used. The verdict is
   `'applied_unscreened'` only when no admitted verdict for that (id, action)
   declared a valid confidence.
2. `'applied'` receipts carry no `confidence` field. The spec §5 shape is
   `{factId, reason:'applied'}`; only `'below_floor'` includes `confidence`.
3. The migration `warnOnce` fires only under resolved `'auto'`. Spec item 5
   requires no warning under `'llm'`.
4. The guard loop `:1899-1908` is left byte-identical. Carrier admission uses
   a sibling loop rather than editing the guard's membership lines, to honour
   "unchanged by this PR".

## Review handoff

After T4.3 the controller hands the branch to review:
- **Reviewers:** a rung-1 fast pass, then the Opus reviewer. The diff is the
  lane branch vs post-#461 `main`.
- **Checks to give the reviewer:**
  - the INVARIANTS list;
  - `G-fence` output;
  - the five-reader trace for withheld ids (§4);
  - receipts in every mode (ruling 8);
  - `??` usage;
  - no `'off'`;
  - the spec Status line updated;
  - the ROADMAP Done line;
  - the PR body carries only the measured T1.2/T3.4 numbers.
- **Artifacts:**
  - `spec.md`;
  - this plan;
  - `LEDGER.md`;
  - `.sdd/step12/bench-{before,after}.json`;
  - `.sdd/step12/pr-body.md`.
- **PR:** opened only after #461 resolves. Use a merge commit, no squash, and
  no `BREAKING CHANGE` footer.
