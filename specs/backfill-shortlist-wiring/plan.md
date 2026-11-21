# Plan — PR 2b: the per-fact shortlist in the ontology-backfill prompt

Spec: `specs/backfill-shortlist-wiring/spec.md` (Reviewed 2026-11-21, owner
rulings OQ1–OQ4 recorded). The spec wins on conflict with this plan.
Base: `origin/main` @ `e268b892`. Worktree:
`/home/kv-thinkpad-t420-ubuntu/.hermes/cache/scratch/expo-llm-wiki-2b`,
branch `lane/2b-backfill-shortlist`. Every task is TDD: the pinning tests
land in the same commit as the change they pin, and the implementer
captures RED before the source change goes green.

## Pins (verified live against `e268b892`)

- `buildShortlist(fact, rows, k)` and `shortlistScore` —
  `packages/core/src/utils/shortlist.ts`. Default scorer is lexical.
- Catalog today: `_runGenerativeBackfill` reads
  `findTitleIndexByEntityId(entityId)` (rows `{id, title, okf_type |
  null}`) and calls `buildTitleCatalogBlock` —
  `packages/core/src/services/MaintenanceService.ts:2283-2284`.
- Prompt: `buildOntologyBackfillPrompt(facts, runtimeOverride?,
  ontologyContext?, titleCatalog?)` splices the catalog into the system
  prompt in the default branch; the `{{facts}}`/ontology-placeholder
  branch returns before any splice —
  `packages/core/src/services/PromptService.ts:348-374`.
- Batch size 25: `ONTOLOGY_BACKFILL_BATCH_SIZE` —
  `packages/core/src/services/MaintenanceService.ts:49`. Prompt cap
  40000: `ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS` (line 50).
- Config home: `OntologyConfig` — `packages/core/src/types.ts` (section
  starts near line 91; `backfillClassifier` at line 109). Resolver
  precedent: `resolveSystemOneTyping` —
  `packages/core/src/utils/engineDefaults.ts:122`.
- Tests that reference the catalog today:
  `packages/core/__tests__/services/PromptService.test.ts` (8 hits),
  `packages/core/__tests__/ontologyBackfill.test.ts` (1 hit).

## Tasks (ordered; one commit each)

### T1 — the `shortlistK` knob and its resolver

- `OntologyConfig` gains `shortlistK?: number` with a doc comment:
  default 10.
- `resolveShortlistK(config: OntologyConfig | undefined): number` lands
  beside `resolveSystemOneTyping` in
  `packages/core/src/utils/engineDefaults.ts`. Contract: `undefined`
  config or missing key returns 10. A present value must be a finite
  integer >= 1; any other value throws with the
  `[core-llm-wiki]`-prefixed message pattern the file already uses.
- Tests first (RED): default, valid passthrough, `0`, `-1`, `1.5`,
  `NaN`, `Infinity`, `'10'` throw.
- Commit: `feat(core): shortlistK config knob for the backfill shortlist (spec §3)`

### T2 — the per-fact candidate renderer

- New pure export in `packages/core/src/prompts.ts`:
  `buildCandidateSections(facts, rowsByFact)` or the smallest pure shape
  the implementer verifies against T4's call site — it takes the batch
  facts and each fact's shortlist rows and returns the per-fact section
  text. Line format must reuse the catalog's exact form:
  `- ${JSON.stringify(title)} (${okf_type})`. Section header names the
  fact id. Footer keeps the catalog's non-exclusive instruction: an
  unlisted valid target stays valid; omit `edges` rather than invent a
  target.
- Zero-pool behavior: when the typed pool is empty, the section carries
  the catalog's "no typed nodes yet" wording (adapted per fact).
- Extract a shared line formatter if that avoids duplicating the catalog
  line shape; `buildTitleCatalogBlock` stays exported (its tests and the
  placeholder-branch comment reference it; no caller removal in this PR
  — see T5).
- Tests first (RED): format parity with the catalog line, header names
  the fact id, order follows the given rows (shortlist order, score
  descending — the caller owns ranking), fewer-than-k pool, zero pool.
- Commit: `feat(core): per-fact candidate section renderer (spec §1)`

### T3 — the scoring query reads `body`

- New repository method
  `findShortlistRowsByEntityId(entityId, tx?)` in
  `packages/core/src/repositories/EntryRepository.ts`: `SELECT id,
  title, okf_type, body` with the same WHERE clause as
  `findTitleIndexByEntityId` (live, typed rows only). Do NOT change
  `findTitleIndexByEntityId` — edge resolution
  (`MaintenanceService.ts:2673`) and the catalog share it and must stay
  unchanged.
- Tests first (RED): bodies present, deleted/untyped rows excluded,
  same filters as the title index.
- Commit: `feat(core): shortlist scoring rows query (spec §2, OQ2)`

### T4 — PromptService: candidate sections replace the catalog splice

- `buildOntologyBackfillPrompt` signature: the 4th parameter becomes
  `candidateSections?: string`. The default branch appends the sections
  to the USER prompt after the `Facts:` JSON (owner ruling OQ1). The
  system prompt stays the base template + ontology appendix — no catalog
  splice. The placeholder branch stays byte-identical and still returns
  before any splice.
- Update the 8 `TITLE CATALOG` references in
  `packages/core/__tests__/services/PromptService.test.ts` to the new
  shape; keep the #381 history comments where they still hold.
- Tests first (RED): sections appear in `userPrompt` after the facts
  JSON; `systemPrompt` carries no catalog; placeholder branch unchanged;
  `candidateSections === undefined` keeps the current prompt minus the
  catalog.
- Commit: `feat(core): backfill prompt carries per-fact candidate sections (spec §1, OQ1)`

### T5 — MaintenanceService wiring

- In `_runGenerativeBackfill`: read scoring rows once per pass via
  `findShortlistRowsByEntityId`; resolve `k` once per pass via
  `resolveShortlistK(this.options.config)`; inside `buildPrompt`, call
  `buildShortlist(fact, rows, k)` per fact (facts carry `title` and
  `body` already) and render the sections via T2's renderer. The
  `buildTitleCatalogBlock` call leaves the backfill path (owner ruling
  OQ1; spec §1).
- The classifier path (`_runClassifierBackfill`) stays untouched — it
  never used the catalog.
- Update the `ontologyBackfill` doc comment in
  `packages/core/src/types.ts` (~line 1789) that references the
  data-scope note, citing this spec's errata.
- Update the `TITLE CATALOG` reference in
  `packages/core/__tests__/ontologyBackfill.test.ts`; add the integration
  pins: user prompt carries one section per batch fact, no `TITLE
  CATALOG` text anywhere in the prompt, prompt overrides keep the
  placeholder branch, the payload cap still bounds the prompt, fewer
  than k typed nodes renders the whole pool, zero typed nodes renders
  the no-nodes wording, `shortlistK` invalid config throws.
- Tests first (RED) for every new pin.
- Commit: `feat(core): shortlist wiring in the ontology backfill pass (spec §1)`

### T6 — suite gates and the cleanup commit (lifecycle)

- Gates before the cleanup commit: full core suite
  (`pnpm --filter @equationalapplications/core-llm-wiki test`) and the
  benchmarks suite (`pnpm --filter
  @equationalapplications/benchmarks-llm-wiki test`), both green at the
  final head. No new benchmark run is required — this PR changes no
  scorer and no pool; the committed 9.8.0 result stays the evidence.
- Cleanup commit: flip the spec's Status to `Implemented` (cite PR,
  landed commit, test paths), delete `plan.md` and `LEDGER.md`,
  `gh pr ready`.
- This repo has NO prettier/eslint gate — match single-quote style by
  hand; never run default prettier; never hand-edit `CHANGELOG.md`.

## Risks

- **Payload growth.** 25 facts × ~10 candidate lines adds prompt length;
  the 40000-char cap still bounds the whole prompt and oversized lone
  facts still send alone. Pin with a test (T5).
- **Prompt-shape change moves model behavior.** Mitigation is design,
  not tests: validity is not narrowed (unlisted targets stay valid), so
  a shortlist miss degrades the hint, not correctness (owner ruling OQ4).
- **Shared-line-format drift.** The renderer must not fork the catalog
  line format silently; T2's parity test pins the exact form.
- **`{{facts}}` template hosts.** They get no sections, same as they got
  no catalog; documented, unchanged (spec §1, PromptService NOTE).

## Controller decrees

- TDD is binding: every task captures RED (implementation-absence
  failures only) before its source change; RED logs go to the SDD dir.
- The controller re-runs both suite gates itself at each task head and
  at the final head; an implementer's green claim is a claim until the
  controller's own run passes.
- Review ladder: T1.5 (`pr-review`: haiku review-depth high → sonnet
  effort high + review-depth xhigh → haiku review-depth max) on the
  plan, then one Opus T3 rung (`opus-review`) on the plan. Announced
  caps precede every paid launch; house cap $5 for this ladder. Findings
  fold before the next rung; one fix commit between rungs.
- Controller verifies: remote head matches local, independent suite
  re-runs, tree clean including untracked files.
- Merge method: merge commit (`gh pr merge --merge`), never force-push;
  commits authored `user.name=Tessera`,
  `user.email=tessera@equational.app`.
- Merge go is the owner's (Kurt), per the handoff.
