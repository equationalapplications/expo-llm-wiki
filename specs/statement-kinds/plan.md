# Plan: statement kinds + areas — the 9.0.0 breaking release

Spec: `specs/statement-kinds/spec.md` (Status: Reviewed, 2026-11-13).
Commits land on the PR branch in this order. Each commit keeps its
suite green. Conventional commit messages name the spec section the
commit fulfills. Versions and CHANGELOG stay with release tooling.

## C1 — schema: statement kinds, area, edges, removals (spec §Proposed change, §Counts)

Edit `packages/schema-software-org/src/index.ts`:

- Add 6 node rows: `statement` (abstract), `rule`, `decision`,
  `lesson`, `trap` (children of `statement`), `area`.
- Descriptions carry exactly: content definition + "holds one claim"
  per kind; abstract line + attachment sentence on `statement`;
  `name` + `patterns_file` on `area`. No vouching or label text.
- Add 4 edge rows: `partOf` (area → software_application), `about`
  (statement → area / software_application / organization).
- Remove `handoff`, `session_recap` node rows and both `handoffFor`
  rows. Update the doc comment counts to 21 node types / 42 edges.
- Append new rows after the 28 warm rows (order test pins the warm
  block first).

Tests (`__tests__/manifest.test.ts` + snapshot): test plan items 1-3.
Count assertions: 28+12 → 28+14, node set 17 → 21, counts 21/42,
removed property rows go, test names at `:88`/`:103` and comment at
`:96` updated, property-conventions table gains the `area` row.
Verification: `pnpm test` in the package; snapshot regenerates only
for the manifest block.

## C2 — core: remove `prompts.librarianSystemPrompt`, add the notice, export the builder (spec §Removals item 3, §The three labels)

- `types.ts`: delete the key from `PromptOverrides`.
- `PromptService.ts`: delete both config reads (`:212`, `:405`).
- `engineDefaults.ts`: replace the two warning blocks (`:36-51`) with
  the removal notice reading the key through `Record<string,
  unknown>`; reword the doc comment (`:20-23`).
- `WikiMemory.ts:850` doc comment line.
- `src/index.ts`: export `buildOntologyPromptAppendix` (additive).

Tests: test plan items 4-5. `engineDefaults.test.ts` assertions move
to the removal notice; `changedDefaultWarnings` tests in
`librarianGuidance.test.ts:229,236` likewise. Config-path tests get
`// @ts-expect-error` on the key and assert prompt-unchanged only;
`guidance :167` and the `:112`/`:115` tests move the override to
`runtimeOverride` and keep ordering assertions; `:201` golden
scenario and `capture-guidance-golden.ts:42` retire with their
recorded goldens — every remaining scenario stays byte-identical.
A core test pins strict-mode behavior (test plan item 5): a minimal
inline manifest in the test defines the removed and new types — core
never imports the schema package (dependency direction). Verification:
`pnpm test` + `pnpm typecheck` in `packages/core`; golden generator
`pnpm exec tsx __tests__/__fixtures__/capture-guidance-golden.ts`
diff-empty.

## C3 — schema: prompt-plumbing test + README statements section (spec §The three labels, test plan items 2, 7-CI)

- `manifest.test.ts` (or a sibling): build the real prompt from the
  manifest via core's exported `buildOntologyPromptAppendix`; assert
  the four definitions and the abstract line are present.
- README: counts, type catalog, and the statements-and-areas section
  carrying the label mapping (vouching with the `human:` prefix rule,
  standing, dates) and the leave-out pointer for `patterns_file`.
- `package.json` description counts.
Verification: package suite; README count grep.

## C4 — benchmarks: classification-fixture subcommand (spec test plan item 7)

- New subcommand under `packages/benchmarks/src/cli.ts` with the
  shared `--dry-run` / `--yes` / `--out` guard; seeds an in-memory
  `WikiMemory` with the new manifest and calls `remember()`; engine
  assembles the prompt internally. DevDependency on
  `schema-software-org`. Committed fixture: ≥6 statements per kind,
  each with expected kind + expected `about` target title and type;
  seed nodes inserted first. README command list gains the subcommand.
Verification: package suite; `--dry-run` prints an estimate and
spends nothing.

## C5 — docs + count surfaces (spec §Files touched, §Release)

- 8 sibling package READMEs: the one count row each (21/42).
- Docs site: `ontologies.md` (counts, catalog rows out, statements
  section), `knowledge-graph.md` (counts, statements),
  `prompts.md` / `configuration.md` / `maintenance.md` (examples go,
  point at `prompts.guidance`), new `upgrading-9.md` (key removal,
  row handling, `setOntologyManifest` step).
- `docs/ROADMAP.md`: step-2 done mark (`:72`, format `:28-31`).
- INTENT.md: the 9.0.0 ruling amendment entry (mirrors the 8.0.0
  entry at `:403-411`).
Verification: docs site build; grep for stale `17`/`40` counts.

## C6 — measured run + Errata (spec test plan item 7, §Errata and evidence)

Run `--dry-run` first; announce the token estimate to the owner as a
budget before `--yes`. Run once against the real provider; the result
file lands in the benchmarks `results/` tree; this spec's Errata
section records per-kind results, about-proposal rate, model name,
prompt, and the small-sample caveat. Commit the Errata update.
Verification: Errata numbers match the result file.

## C7 — cleanup (repo lifecycle)

One final commit: spec Status → `Implemented`, delete `plan.md` and
`LEDGER.md`, `gh pr ready`. CodeRabbit fires on the ready-flip;
adjudicate on the PR with HEAD evidence. CI must be green before the
merge ask; pre-merge comment sweep twice; owner merges.

## Risks

- Golden byte-parity: the retired override scenario must remove its
  recorded goldens without touching the others; the diff-empty gate
  proves it.
- The `Record<string, unknown>` notice read must not trip typecheck
  lint rules; if it does, cast through `unknown` explicitly.
- Schema-core dev-cycle: the schema package already depends on core;
  the benchmarks devDependency is one-way; no reverse edge is added.
- The measured run spends real tokens; it stays behind `--yes` and
  its budget is announced before the run.
