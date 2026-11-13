# Statement kinds (rule, decision, lesson, trap) and areas — the 9.0.0 breaking release

**Status:** Implemented (2026-11-13 — implementation PR #380; commits
6d933cdb schema, 3a67ded3 core, 8bb87097 schema docs/tests,
1fb27086 benchmarks subcommand, be81d260 docs/ROADMAP/INTENT,
2027efb6 measured run + Errata. Suites: core 212 files / 2428 tests,
schema 2 / 46, benchmarks 16 / 153, all 0 failed; golden fixture
byte-parity; docs site builds (53 pages). Spec gate closed by the
owner 2026-11-13; written-work ladder converged through T4 Fable
delta ("Approve after conditioned fixes; no blockers"). Measured run
in Errata: kind split 28/28 on GLM-5.3-flash; about-proposal 0/28
filed as #381.)
**Date:** 2026-11-13
**Owner rulings:** 2026-11-12 and 2026-11-13, recorded in issue #376 and in
the vault note `sharper-memory-design-rulings-2026-11-13.md`. The 9.0.0
breaking ruling covers exactly the removals listed in §Removals — no
other removal rides this release.
**Intent check:** Rule 2 — the removals drop no stored data: fact rows
keep their stored `okf_type`; only the manifest rows and one config key
go. Rule 10 — this spec is the required spec-first step. Rule 11 — the
spec claims no accuracy or cost number. It states the one cost it knows
is real: the manifest is serialized into every classification prompt,
so adopting hosts get four more node rows and two more edge rows in
every classification call (6 node and 4 edge rows added, 2 node and 2
edge rows removed, net 17→21 and 40→42), plus the kind definitions;
that growth is unmeasured, and the
cheap targeted test in §Test plan measures the rule/decision split, not
a cost.
Release: **major (9.0.0)** — see §Release.

## Problem

Memory stores what it knows as many free-standing facts. A product, a
service, or a person accumulates dozens of unrelated rows. Nothing says
whether a row is a rule to follow, a decision already made, a lesson
learned, or a trap to avoid. A reader cannot tell which rows carry
authority, and delivery to agents cannot rank them (the ruled drop order
— decisions first, then lessons, then rules, traps last — has nothing to
rank).

Separately, a statement cannot say which part of a software application
it concerns. "Deploy fails if the token expires" concerns the deploy
area, not the whole application, but the schema has no area type.

The removals that 9.0.0 must carry also wait here: the `handoff` and
`session_recap` node types and the whole-prompt librarian override are
deprecated and ruled for removal (owner ruling 2026-11-13; the #375
deprecation said "removed in 9.0.0").

## Root cause (with evidence)

The `schema-software-org` manifest
(`packages/schema-software-org/src/index.ts`) has 17 node types and 40
edge types. None of them is a statement kind or an area. The engine has
exactly one way to type a stored item: `okf_type`, checked against the
manifest (`OntologyNodeType` in `packages/core/src/types.ts:63`; one
`parent_type` level, validated by `validateManifest` in
`packages/core/src/utils/ontology.ts`). A second "kind" label beside the
ontology was considered and rejected in issue #376: each statement must
be its own stored item so the engine can search it, replace it, and
check it against its quote. So the kinds must be node types.

The whole-prompt override exists in code today: the `@deprecated` key
(`packages/core/src/types.ts:46`), two config reads — the
`globalOverrides` fallback (`PromptService.ts:212`) and
`buildInstructionTemplates`'s `o?.librarianSystemPrompt` read
(`PromptService.ts:405`, reached on the `legacy` strategy branch) —
the two warning blocks (`engineDefaults.ts:36-51`), and the doc comment
(`WikiMemory.ts:850`). A grep from the repo root finds the `handoff`
and `session_recap` type names outside the schema package in five
places, none of them core code: the legacy historical spec (a dated
record — see below), the ROADMAP plan line (`docs/ROADMAP.md:81`,
which already documents the planned removal), the generated contract
mirror (see below), the docs site's ontology pages (in Files touched
below), and frozen benchmark fixtures (see below). Both
removals are therefore contained: one data-only package, plus one
config key and its reads.

## Proposed change

### One node per thing

A product, service, or person is one node. What the organization knows
about it attaches to that node as separate statements. This release
changes the schema so statements can exist and attach; it does not
migrate existing rows (see §Existing data).

### The four kinds, as node types

Four node types join `schema-software-org`, all children of one new
parent type `statement` (one-level `parent_type`, D1 — `statement` has
no parent itself). The kinds are defined by content only:

| Type | Definition (the description text carries this) |
|---|---|
| `rule` | A situation, and what to do in it. |
| `decision` | What was chosen, what was rejected, and why. |
| `lesson` | What went wrong, and what to do differently. |
| `trap` | A likely wrong assumption, and the fact that corrects it. |

Rules for the description text (it is the classification signal, D3):

- Each kind carries exactly its content definition above, plus "holds
  one claim" — one claim per statement is the ruled mitigation for
  wrong retirement (the prototype retired three decisions on one
  conflated claim).
- `statement` itself is declared abstract in its description: classify
  a fact as one of the four kinds, never as `statement`. This is
  prompt-level guidance only — the engine's `resolveNodeType` accepts
  any manifest type, so a fact typed `statement` would pass strict
  mode today. The spec accepts that residual: rejecting the abstract
  type at validation is a core change this release does not make (the
  classification prompt is the enforcement, as for every other type).
  A test asserts this text is present in the manifest.
- The `statement` description also tells the classifier how attachment
  works, because the prompt shows the manifest as raw JSON and says
  only "use the row whose types match your fact" (`prompts/ontology.ts`):
  it states that the four kinds attach with `about` to an `area`,
  the `software_application`, or the `organization`, and that the
  `about` rows declared with source `statement` apply to every kind.
  Without that sentence, a `rule` fact sees no row whose `source_type`
  is `rule` and never proposes the edge. A test asserts this text.
- The text stays organization-neutral: it says "the organization",
  never a specific company.

The kinds belong to this schema, not to core. The warm-agent manifest
(`schema-org-llm-wiki`) is unchanged; other schemas define their own.

### The three labels ride existing fields — no new fields

The engine already stores every label the ruling names. The engine
gains no field, and the classification prompt carries none of this:
the classifier can return only `okf_type` and `edges`
(`ExtractedFactWithOntology`, `types.ts:680`), so label text in a
description would be tokens every call pays for with no effect on what
the classifier can return. The label mapping lives in the schema package README's
statements section and in `upgrading-9.md`, where host writers (the
code that actually sets these fields) read it:

| Label | Field(s) today |
|---|---|
| Who vouches | `okf_verified` (chronological entries; latest surfaces as `last_verified_by`), `packages/core/src/types.ts:539`. The README text states: when grounding is on, the grounding writer stamps every grounded fact with a machine verifier (`process:grounding-check`, `packages/core/src/utils/grounding.ts:107`), so a verifier string is a machine unless it starts `human:` — only `human:`-prefixed entries produce the derived `trustTier === 'human-reviewed'` (`types.ts:561`) |
| Standing | `superseded_by` + `valid_to` — set by the existing supersede path (`TemporalService.supersedeInTx` writes only those plus `superseded_at`); `lifecycle_status: 'deprecated'` is set by an explicit `setLifecycleStatus` call (`WikiMemory.ts:1398`) — the host or the memory app makes that call when it accepts the replacement; the engine gains no automatic writer (`types.ts:531`, `:568`) |
| Dates | `valid_from` / `valid_to` (`types.ts:564`, `:566`) |

"Filled only when the source says so in plain words" is a convention
for writers, not schema: the README and `upgrading-9.md` state it for
the vouching label. This mapping is what the issue's "where the three
labels live" question resolves to, and it needs no core change.

### Areas

One new node type `area`: a named part of a `software_application`,
such as "deploy" or "billing". One new edge `partOf`
(`area` → `software_application`). The `area` description states the
expected frontmatter properties: `name`, and `patterns_file` — the
path, inside the host repo, of the small file that holds the area's
file globs. The property is a pointer, not a copy: the ruling places
the patterns in the repo itself, changing in the same PR as the code,
and the leave-out rule says memory points to the better record rather
than duplicating it. A stored glob copy would silently diverge from
the repo file; a stored path cannot. A statement attaches to the most
specific thing it concerns: an `area`, the whole `software_application`,
or the `organization`. This is the ruled target set, taken verbatim
from the ruling sentence ("an area, the whole application, or the
organization"). A statement about a `service`, `role`, or `person`
attaches today through the thing it concerns — the application that
owns the service, the area that covers it, or the organization — and
widening the set later is an additive manifest change (a minor
release), not this one.

### The attach edge

The attach edge reuses the existing name `about`, with three new rows
keyed by target type:

- `about`: `statement` → `area`
- `about`: `statement` → `software_application`
- `about`: `statement` → `organization`

Matching is parent-aware on both endpoints (`typeSatisfies`,
`packages/core/src/utils/ontology.ts` — exact first, one-hop parent,
D1/D6). Declaring the source as the parent `statement` means all four
kinds satisfy the row without four copies; the three targets are three
rows because an edge row carries one target type. This answers the
issue's "one row per target type or a wider target in core" question:
three rows, no core change.

Rejected alternative: widening core's edge row to accept a target list.
It is a core change with no demonstrated need; the parent-aware row
pattern (D6) already keeps the row count down.

### Removals (exactly as ruled)

1. Node types `handoff` and `session_recap` leave
   `schema-software-org`.
2. Edge rows `handoffFor` (`handoff` → `software_application`, `handoff`
   → `service`) leave with them — edges into a removed type are dead
   rows.
3. `prompts.librarianSystemPrompt` leaves core: the key on
   `PromptOverrides` (`packages/core/src/types.ts:46`), both config
   reads — the `globalOverrides` fallback in `buildLibrarianPrompt`
   (`PromptService.ts:212`) and the `o?.librarianSystemPrompt` read in
   `buildInstructionTemplates` (`PromptService.ts:405`, the `legacy`
   strategy branch) — the two warning blocks in
   `changedDefaultWarnings` (`engineDefaults.ts:36-51`; line 52 opens
   the unrelated legacy/`maintenance` warning and stays), the doc
   comment that names the key (`engineDefaults.ts:20-23`, reworded),
   and the doc comment reference (`WikiMemory.ts:850`). The builder's
   own `runtimeOverride` parameter stays — it is the builder-level
   channel tests and per-call callers use; only the config key and its
   reads go. The rule is: no config path reaches `librarianSystemPrompt`
   after 9.0.0, on either librarian strategy; if implementation finds
   a config-fed caller this list misses, the caller goes too.

Nothing else is removed. The ruling covers exactly this list.

### Removal consequences, stated

- **Existing rows stay.** Facts stored with `okf_type` `handoff` or
  `session_recap` keep their rows and their type strings (rule 2:
  migrations never drop data). Stored `handoffFor` edge rows stay too
  and still traverse — nothing rewrites stored edges. Strict mode
  rejects those types on the write paths that enforce it — `remember()`
  and `upsertGraph()` (`RememberService.ts:30`, where `strict` tracks
  the persisted mode; `upsertGraph` decides strictness from the
  persisted mode). `ingestDocument` does NOT enforce: it calls the
  shared graph writer with `strict: false` (`IngestionService.ts:561`,
  `:860`, `:927`), so after 9.0.0 a document chunk classified as a
  removed type stores with `okf_type: null`, exactly like the
  librarian paths (`legacy.ts:156`, `ops/apply.ts:73`) — the same
  behavior any unknown type gets now, unchanged by this release.
  `importDump` copies `okf_type`
  verbatim (`ImportExportService.ts:312`), so re-imported old rows
  keep the stale names. Hosts re-type or leave the rows.
- **Seeded manifests do not re-seed.** `seedManifests` writes only when
  no manifest row exists for the entity (`types.ts`, `OntologyConfig`).
  A host upgrading from 8.x must call `setOntologyManifest` to adopt
  the new manifest. The docs say this in the release notes.
- **The #375 warning tests change.** The two
  `changedDefaultWarnings` blocks for a set-but-ignored override
  disappear. `changedDefaultWarnings` gains one message instead: the
  key was removed in 9.0.0, the value is ignored, use
  `prompts.guidance`. The `engineDefaults.test.ts` assertions on the
  old messages update to the new one; the `strategy: 'legacy'`
  substring assertion of #375 goes with the block it tested.

### Artifacts the sweep names, kept out of scope

Three surfaces reference the removed types and stay untouched, each for
a stated reason:

- **The generated contract mirror**
  (`packages/mcp-server/contract/synapsetree-openapi.subset.json`)
  enumerates `handoffFor`, `handoff`, and `session_recap` in its type
  enums. Its own header says it is generated by SynapseTree's
  `scripts/mcp-contract-subset.py` and "regenerate, do not hand-edit".
  It is the hosted SynapseTree API's surface, not this manifest's;
  hand-editing it violates its own provenance. Its `EdgeType` enum is
  documented open ("the listed values are the schema-software-org
  edges"), so the leftover names there are advisory, not a contract
  break. The SynapseTree
  adaptation lane regenerates it after the engine release ships. The
  mcp-server tests consume the contract as committed; this PR does not
  change it, so they stay green and in scope for nothing. Verified: no
  mcp-server test asserts the removed type names — the tests check
  operations, not the type enums.
- **The legacy spec**
  `docs/superpowers/specs/2026-08-28-schema-ea-executive-ontology-spec.md`
  documents the removed types as of its
  date. It is a dated historical record (pre-2026-11-01 specs stay as
  written); the live manifest is the source of truth after 9.0.0.
- **Frozen benchmark fixtures** (`packages/benchmarks/fixtures/`) embed
  snapshot text that mentions the old rows. They pin recorded benchmark
  outputs (rule 11); benchmark corpora do not track prose changes.
- **The historical migration page**
  `apps/docs/src/content/docs/project/upgrading-8.md` names the then-
  deprecated key as history — migration pages, like dated specs, stay
  as written; `upgrading-9.md` is the new page.

### Counts after this change

21 node types, 42 edge types: minus 2 nodes, minus 2 edge rows, plus 6
nodes (`statement`, the four kinds, `area`) and 4 edge rows (`partOf`,
three `about` rows). Every count-bearing surface updates in the same
PR: the manifest doc comment, `package.json` description, the schema
package README (both sites), the package table row in the READMEs of
core, expo, react, okf, core-llm-tools, mcp-server, schema-org, and
prisma-outbox, the docs pages `packages/ontologies.md` and
`concepts/knowledge-graph.md`, the count test, and the manifest
snapshot.

## Files touched

- `packages/schema-software-org/src/index.ts` — six new node rows, four
  new edge rows, two removed node rows, two removed edge rows, doc
  comment counts.
- `packages/schema-software-org/README.md` — counts (2 sites), type
  catalog table, and a short section on statements and areas.
- `packages/schema-software-org/package.json` — `description` counts.
- `packages/schema-software-org/__tests__/manifest.test.ts` + snapshot —
  new count (21/42), statements block tests (definitions verbatim,
  abstract text, labels text, attach rows, removal assertions), drift
  snapshot regenerates.
- READMEs of `core`, `expo`, `react`, `okf`, `core-llm-tools`,
  `mcp-server`, `schema-org`, `prisma-outbox` — the one package-table
  count row each.
- `apps/docs/src/content/docs/packages/ontologies.md` and
  `apps/docs/src/content/docs/concepts/knowledge-graph.md` — counts,
  the removed rows out of the live catalog (`ontologies.md:69,72`),
  and a short statements section.
- `apps/docs/src/content/docs/guides/prompts.md`,
  `apps/docs/src/content/docs/reference/configuration.md`,
  `apps/docs/src/content/docs/guides/maintenance.md` — the
  `librarianSystemPrompt` examples go; each page points at
  `prompts.guidance` instead.
- `apps/docs/src/content/docs/project/upgrading-9.md` — new migration
  page, modeled on `upgrading-8.md`: the key removal and its
  replacement, the `handoff`/`session_recap` row handling, and the
  `setOntologyManifest` step existing hosts must call. This page, not
  release notes (which semantic-release generates from commits and
  which AGENTS.md forbids hand-editing), is where the migration note
  lives.
- `packages/core/src/types.ts` — delete `librarianSystemPrompt` from
  `PromptOverrides`.
- `packages/core/src/services/PromptService.ts` — delete both config
  reads of `librarianSystemPrompt` (`:212`, `:405`).
- `packages/core/src/utils/engineDefaults.ts` — replace the two warning
  blocks (`:36-51`) with the removal notice; reword the doc comment
  that names the key (`:20-23`).
- `packages/benchmarks/` — the new classification-fixture subcommand
  under the CLI's existing `--dry-run`/`--yes` guard (test plan
  item 7), its README command list, and a devDependency on
  `schema-software-org` for the fixture and manifest.
- `packages/core/src/index.ts` — additive export of
  `buildOntologyPromptAppendix` (test plan item 2's plumbing test
  needs it; the schema package already depends on core).
- `packages/core/src/WikiMemory.ts` — doc comment line.
- `packages/core/__tests__/engineDefaults.test.ts` — warning assertions.
- `packages/core/__tests__/WikiMemory.test.ts`,
  `packages/core/__tests__/services/MaintenanceService.test.ts`,
  `packages/core/__tests__/services/PromptService.test.ts`,
  `packages/core/__tests__/librarianGuidance.test.ts`,
  `packages/core/__tests__/groundingLibrarian.test.ts` — the config
  override tests convert per test plan item 4.
- `packages/core/__tests__/__fixtures__/capture-guidance-golden.ts` —
  the config-override golden scenario retires; see test plan item 4.
- Docs in the same PR, latest version only. CHANGELOG and versions stay
  with release tooling. `docs/ROADMAP.md` gets its step-2 done mark in
  this PR (see §Release).

## Test plan

All zero-token and deterministic unless stated. Suites live in
`packages/schema-software-org/__tests__/` and
`packages/core/__tests__/`.

1. **Manifest validity and counts.** `validateManifest` passes; the
   count test asserts exactly 21 node types and 42 edge types.
2. **Definitions.** Each kind's description contains its content
   definition from the table above (verbatim substring); `statement`'s
   description forbids classifying directly as `statement`; each kind's
   description states "holds one claim"; the `statement` description
   carries the attachment sentence (kinds attach with `about` to an
   `area`, the `software_application`, or the `organization`; the
   `statement`-sourced rows apply to every kind); the `area`
   description names `name` and `patterns_file`. Per the labels
   section, the description carries no vouching or label-field text —
   the classification prompt carries only what the classifier can act
   on. The CI plumbing test lives in `packages/schema-software-org`
   (which already depends on `core-llm-wiki`): core gains an additive
   export of `buildOntologyPromptAppendix` (`packages/core/src/index.ts`
   — today it exports only `validateManifest`), the schema package
   builds the real prompt from its own manifest, and the test asserts
   the four definitions and the abstract line are present in the built
   prompt text, not just in the manifest rows.
3. **Parent and rows.** The four kinds declare `parent_type:
   'statement'`; `statement` declares no parent; the three `about`
   rows and the `partOf` row exist with the declared endpoints; the
   two `handoffFor` rows and the two removed node types are absent
   (negative assertions, so a silent restore fails). The same file's
   count-bearing assertions update with the manifest: the warm-agent
   parity filter stays 28 rows, its "+12" assertion becomes "+14"
   (`manifest.test.ts:81`), the exact-node-set assertion gains the six
   new names and loses `handoff`/`session_recap` (`:88`), the counts
   become 21/42 (`:103`), and the removed types' property-row
   assertions (`:153`, `:155`) go. Text that describes the old
   manifest updates too: the test names at `:88` and `:103` say
   17/40, the `:96` comment says "5 software-org creativework
   subtypes" (it becomes 3), and the property-conventions table
   (`:148-157`) gains an `area` row (`name`, `patterns_file`) so the
   area's expected properties are tested like every other type's. The
   new manifest rows are appended
   after the 28 warm rows — the order test (`:64-73`) requires the
   warm block first and in upstream order. The warm-agent row-for-row
   parity itself passes untouched — no warm-agent row changes, and the
   warm-edge copy test filters on type, source and target, so the new
   `statement`-sourced `about` rows never match it.
4. **Override removal (core).** With
   `prompts.librarianSystemPrompt` set on a 9.0.0 engine: the key is
   absent from the type surface (typecheck is the assertion), the
   built librarian prompt is byte-identical to the no-override prompt,
   and `changedDefaultWarnings` emits exactly the removal notice once.
   A host pinning `librarian.strategy: 'legacy'` gets the removal
   notice too; the assertion is that the notice is present and the
   #375 warning texts are absent — a legacy-pinned host with no
   `maintenance` also collects the pre-existing legacy/deferred
   warning, so the assertion must not demand a single message. The
   removal notice keeps working after the type surface loses the key:
   `changedDefaultWarnings` reads `prompts.librarianSystemPrompt`
   through an untyped shape (`Record<string, unknown>`) — it must
   detect a key the `PromptOverrides` type no longer declares. Six
   test files and one fixture set the key today and
   change with the removal: config-path tests
   (`WikiMemory.test.ts:215,238,271`, `MaintenanceService.test.ts:101`,
   `PromptService.test.ts:108`, `groundingLibrarian.test.ts:69`)
   become removal tests. The ones that build `PromptService` directly
   (`MaintenanceService.test.ts:101`, `PromptService.test.ts:108`) never
   pass through `changedDefaultWarnings`, so their object literals
   carry the removed key under a `// @ts-expect-error` comment — that
   comment is what makes "typecheck is the assertion" true — and
   assert only that the prompt is unchanged; warning assertions live
   only in the `changedDefaultWarnings` and `WikiMemory` tests. The
   assertions in `engineDefaults.test.ts` (`:68,81,108,
   110`) and the two `changedDefaultWarnings` assertions in
   `librarianGuidance.test.ts:229,236` update to the removal notice;
   `librarianGuidance.test.ts:167` ("composes after a whole-prompt
   override") also builds the service directly, so it joins the
   `// @ts-expect-error` group — but it moves the override to the
   `runtimeOverride` argument of `buildLibrarianPrompt` and keeps its
   ordering assertions (host guidance section after the override),
   which stay real behavior the same way the `:112`/`:115` tests
   become plain `runtimeOverride` tests; and
   `:201` is the golden capture scenario, which retires with the key
   (see the golden fixture entry below). The "runtime override over
   global" tests (`MaintenanceService.test.ts:112`,
   `PromptService.test.ts:115`) set the global key only to prove the
   runtime parameter beats it; with the global key gone they become
   plain `runtimeOverride` tests. The golden fixture
   `__tests__/__fixtures__/capture-guidance-golden.ts:42` exercises
   the config override as one scenario; that scenario retires with the
   key, its recorded goldens move out in the same PR, and every
   remaining scenario stays byte-identical (the diff-empty golden
   gate proves it).
5. **Removed types in strict mode.** Seeding the new manifest and
   calling `remember()` with `okf_type: 'handoff'` is rejected in
   strict mode (the enforcing write path); the same call with
   `okf_type: 'statement'` is accepted — the test pins today's
   behavior so the documented prompt-only abstract-type residual is
   visible and a later validation change shows up as an intended
   change; a pre-existing stored row
   with `handoff` still reads back and re-imports through `importDump`
   verbatim (the row is not dropped, and no migration touches it).
6. **Statement attach end-to-end (stub).** With the manifest seeded and
   a scripted stub provider, a librarian pass writes a fact typed
   `rule` with an `about` edge to a `software_application` node, and
   the traversal returns it; a `decision` superseding an older
   `decision` carries `superseded_by` and `valid_to` on the old row
   from the supersede path alone, and the test then makes the explicit
   `setLifecycleStatus` call that marks the old row `deprecated` — the
   standing label working through existing mechanics, no core change.
7. **Rule/decision dependability (cheap, targeted, no benchmark run).**
   A committed fixture holds labeled statement texts (at least 6 per
   kind, written to be discriminating: same subject matter, different
   kind). Each fixture entry carries the statement text, the expected
   kind, and the expected `about` target — a title and target type —
   and the runner first inserts seed nodes (one `software_application`,
   one `area`, one `organization`) so a proposed `about` edge resolves
   through the title index (`OntologyService.ts:163-172`); without
   seeded targets every edge would drop `target_not_found` and the
   reported rate would measure the fixture's shape, not the prompt.
   A CI test (in the schema package, per item 2) asserts the
   classification prompt carries all four
   definitions and the abstract-`statement` line — plumbing only,
   zero tokens. The measured runner lives
   in `packages/benchmarks` as a CLI subcommand under the same guard
   as `longmemeval` and `supersession`: it prints a one-screen token
   estimate and refuses to spend without `--yes` (`--dry-run` for the
   estimate alone, `--out` for the result file). The runner drives the
   real write path: it seeds an in-memory `WikiMemory` with the new
   manifest, stores each statement untyped with `remember()` (which
   has no LLM step), and runs the engine's own classifier —
   `runOntologyBackfill` with the LLM classifier — so the
   classification prompt is assembled internally through
   `buildPromptContext`; the runner names no direct call, and what it
   measures is the prompt
   assembly production actually uses. It sends the fixture
   through the classification prompt to a real provider once and
   reports per-kind results, and next to the kind accuracy reports how
   often a correct `about` edge is proposed — the attachment sentence
   in the `statement` description is measured, not just asserted;
   AGENTS.md's benchmark
   gate therefore
   holds — no token-spending path exists outside that CLI, and the
   run uses an in-memory store, never a host database. The runner
   runs once before merge; the result file lands in the benchmarks
   `results/` tree, and this spec's Errata section records the
   headline numbers with model name, prompt, and the small-sample
   caveat — the durable home, because plan.md and LEDGER.md are
   deleted at cycle close (INTENT.md:338) and rule 11 requires the
   number to outlive the run. This measures the split
   the issue flags; the spec claims no number in advance.

## Release

Major. One release moves all nine packages to 9.0.0 together —
`.releaserc.json`'s `prepareCmd` writes the same
`nextRelease.version` into every package, so `schema-software-org`
does not publish separately; its breaking change is the type removal
inside the shared release. `core-llm-wiki`'s breaking change is the
config key removal, carried by a `refactor!`/`feat!` commit citing the
owner ruling (2026-11-13: fix now while adoption is near-zero). The
`BREAKING CHANGE` footer is written with the ruling's citation — the
AGENTS.md rule bars footers without a ruling; this one has it. The
completing PR also adds the 9.0.0 ruling to INTENT.md's amendment
record, mirroring the 8.0.0 entry (INTENT.md lines 403-411) — each
spec states its amendment status explicitly, and the librarian-guidance
spec does the same when it records that INTENT.md carries no amendment
for its rulings (`specs/librarian-guidance/spec.md:29-30`) — and ticks
the ROADMAP step-2 done mark (step at `docs/ROADMAP.md:72`, done-mark
format at `:28-31`). Commits follow INTENT.md's
spec-then-code commit record (INTENT.md:347): spec and code land in
separate commits.

## Non-goals

- Source pointers on facts (#377) and the engine source store
  (roadmap).
- The warm-agent manifest and any other schema gaining statement kinds
  — schemas define their own.
- Migrating or re-typing existing `handoff`/`session_recap` rows.
- Delivery drop order, budget, and precedence (host guidance, ruled
  separately; not schema).
- Curated Thoughts twin (#343) and the CTI role pack (#96).
- Any accuracy claim for the four-way split (rule 11 — measured, not
  claimed).

## Errata and evidence

**Measured run — 2026-11-13** (result file:
`packages/benchmarks/results/statement-kinds-2026-11-13.json`;
runner: `benchmarks statement-kinds`, in-memory store, engine's own
`runOntologyBackfill` LLM classifier, prompt assembled by
`buildPromptContext` from this manifest):

- **Kind split: 28/28 correct (100%)** — rule 7/7, decision 7/7,
  lesson 7/7, trap 7/7. Model: GLM-5.3-flash (the host's resolved
  provider). Fixture: 28 committed statements, 7 per kind, written to
  discriminate (same subject matter across kinds).
- **About-proposal rate: 0/28 proposed, 0/28 correct-target.** The
  classifier proposed no edges despite resolvable seed targets
  (fixture validation enforces every expected target is a seed node
  with an exact title match). The kind definitions alone carried the
  classification; the attachment sentence did not produce edges under
  this model. Recorded as the known open residual, consistent with
  the accepted prompt-only enforcement of the abstract type: edge
  proposal is prompt-steered, and this measurement shows it did not
  happen for this model on this fixture.
- **Caveats:** single run, no repeats; small sample (28); one model;
  judge is exact-match against the fixture's expected kind and target;
  the runner's classification path (`remember` untyped → backfill
  classifier) was implemented when `remember()` was found to have no
  LLM step (spec test-plan sentence amended in this PR, same cycle).
  No accuracy claim beyond these numbers; the split being dependable
  for other models is unmeasured.
- **Follow-up:** the 0/28 about rate is filed as its own issue rather
  than folded here — it is a delivery-gap question (prompt steering,
  backfill edge surfacing, or model behavior), not a manifest defect.
