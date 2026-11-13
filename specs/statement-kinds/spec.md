# Statement kinds (rule, decision, lesson, trap) and areas — the 9.0.0 breaking release

**Status:** Draft (plan.md and LEDGER.md land in this folder when this
spec's review gate closes, per the repo flow)
**Date:** 2026-11-13
**Owner rulings:** 2026-11-12 and 2026-11-13, recorded in issue #376 and in
the vault note `sharper-memory-design-rulings-2026-11-13.md`. The 9.0.0
breaking ruling covers exactly the removals listed in §Removals — no
other removal rides this release.
**Intent check:** Rule 2 — the removals drop no stored data: fact rows
keep their stored `okf_type`; only the manifest rows and one config key
go. Rule 10 — this spec is the required spec-first step. Rule 11 — the
spec claims no accuracy or cost effect. The rule/decision dependability
question is measured by the cheap targeted test in §Test plan, and the
result is recorded with its model and caveats, not claimed in advance.
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
the two warning blocks (`engineDefaults.ts:36-52`), and the doc comment
(`WikiMemory.ts:850`). A grep from the repo root finds `handoff` and
`session_recap` outside the schema package in exactly four places, none
of them core code: the legacy historical spec
(`docs/superpowers/specs/2026-08-28-schema-ea-executive-ontology-spec.md`,
dated record — see below), the ROADMAP plan line (`docs/ROADMAP.md:81`,
which already documents the planned removal), the generated contract
mirror (see below), and frozen benchmark fixtures (see below). Both
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
  a fact as one of the four kinds, never as `statement`. A test asserts
  this text is present.
- The text stays organization-neutral: it says "the organization",
  never a specific company.

The kinds belong to this schema, not to core. The warm-agent manifest
(`schema-org-llm-wiki`) is unchanged; other schemas define their own.

### The three labels ride existing fields — no new fields

The engine already stores every label the ruling names. The
descriptions point at them; the engine gains no field:

| Label | Field(s) today |
|---|---|
| Who vouches | `okf_verified` (chronological entries; latest surfaces as `last_verified_by`), `packages/core/src/types.ts:539` |
| Standing | `lifecycle_status` (`stable` = current, `deprecated` = replaced) plus `superseded_by` as the link to what replaced it (`types.ts:531`, `:568`) |
| Dates | `valid_from` / `valid_to` (`types.ts:564`, `:566`) |

"Filled only when the source says so in plain words" is a convention
for writers, not schema: the `statement` description states it for the
vouching label. This mapping is what the issue's "where the three
labels live" question resolves to, and it needs no core change.

### Areas

One new node type `area`: a named part of a `software_application`,
such as "deploy" or "billing". One new edge `partOf`
(`area` → `software_application`). The `area` description states the
expected frontmatter properties: `name`, `patterns` (the area's file
globs; the host keeps them in its own repo and they change in the same
PR as the code, per the ruling). A statement attaches to the most
specific thing it concerns: an `area`, the whole `software_application`,
or the `organization`.

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
   `changedDefaultWarnings` (`engineDefaults.ts:36-52`), and the doc
   comment reference (`WikiMemory.ts:850`). The builder's own
   `runtimeOverride` parameter stays — it is the builder-level channel
   tests and per-call callers use; only the config key and its reads
   go. The rule is: no config path reaches `librarianSystemPrompt`
   after 9.0.0, on either librarian strategy; if implementation finds
   a config-fed caller this list misses, the caller goes too.

Nothing else is removed. The ruling covers exactly this list.

### Removal consequences, stated

- **Existing rows stay.** Facts stored with `okf_type` `handoff` or
  `session_recap` keep their rows and their type strings (rule 2:
  migrations never drop data). Strict mode rejects new writes of those
  types — the type is no longer in the manifest. Hosts re-type or
  leave the rows.
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
  hand-editing it violates its own provenance. The SynapseTree
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
  `apps/docs/src/content/docs/concepts/knowledge-graph.md` — counts and
  a short statements section.
- `packages/core/src/types.ts` — delete `librarianSystemPrompt` from
  `PromptOverrides`.
- `packages/core/src/services/PromptService.ts` — delete both config
  reads of `librarianSystemPrompt` (`:212`, `:405`).
- `packages/core/src/utils/engineDefaults.ts` — replace the two warning
  blocks with the removal notice.
- `packages/core/src/WikiMemory.ts` — doc comment line.
- `packages/core/__tests__/engineDefaults.test.ts` — warning assertions.
- `packages/core/__tests__/WikiMemory.test.ts`,
  `packages/core/__tests__/services/MaintenanceService.test.ts`,
  `packages/core/__tests__/services/PromptService.test.ts`,
  `packages/core/__tests__/librarianGuidance.test.ts`,
  `packages/core/__tests__/groundingLibrarian.test.ts` — the config
  override tests convert per test plan item 5.
- `packages/core/__tests__/__fixtures__/capture-guidance-golden.ts` —
  the config-override golden scenario retires; see test plan item 5.
- Docs in the same PR, latest version only. CHANGELOG and versions stay
  with release tooling.

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
   states the vouching convention and names the three label field
   groups.
3. **Parent and rows.** The four kinds declare `parent_type:
   'statement'`; `statement` declares no parent; the three `about`
   rows and the `partOf` row exist with the declared endpoints; the
   two `handoffFor` rows and the two removed node types are absent
   (negative assertions, so a silent restore fails).
4. **Warm-agent parity unchanged.** The existing D2 parity test passes
   untouched — no warm-agent row changes.
5. **Override removal (core).** With
   `prompts.librarianSystemPrompt` set on a 9.0.0 engine: the key is
   absent from the type surface (typecheck is the assertion), the
   built librarian prompt is byte-identical to the no-override prompt,
   and `changedDefaultWarnings` emits exactly the removal notice once.
   A host pinning `librarian.strategy: 'legacy'` gets the same single
   notice, not the #375 messages. Six test files set the key today and
   change with the removal: config-path tests
   (`WikiMemory.test.ts:215,238,271`, `MaintenanceService.test.ts:101`,
   `PromptService.test.ts:108`, `groundingLibrarian.test.ts:69`)
   become removal tests — the key set, the prompt unchanged, one
   warning; the two `changedDefaultWarnings` assertions in
   `librarianGuidance.test.ts:229,236` update to the removal notice;
   per-call behavior tests in `PromptService.test.ts` and
   `librarianGuidance.test.ts:167,201` move to the builder's
   `runtimeOverride` parameter, which stays. The golden fixture
   `__tests__/__fixtures__/capture-guidance-golden.ts:42` exercises
   the config override as one scenario; that scenario retires with the
   key, its recorded goldens move out in the same PR, and every
   remaining scenario stays byte-identical (the diff-empty golden
   gate proves it).
6. **Removed types in strict mode.** Seeding the new manifest and
   writing a fact with `okf_type: 'handoff'` is rejected in strict
   mode; a pre-existing stored row with that type still reads back
   (the row is not dropped, and no migration touches it).
7. **Statement attach end-to-end (stub).** With the manifest seeded and
   a scripted stub provider, a librarian pass writes a fact typed
   `rule` with an `about` edge to an `software_application` node, and
   the traversal returns it; a `decision` superseding an older
   `decision` carries `superseded_by` and `lifecycle_status:
   'deprecated'` on the old row — the standing label working through
   existing mechanics.
8. **Rule/decision dependability (cheap, targeted, no benchmark run).**
   A committed fixture holds labeled statement texts (at least 6 per
   kind, written to be discriminating: same subject matter, different
   kind). A CI test asserts the classification prompt carries all four
   definitions — plumbing only. A separate opt-in runner
   (environment-flag gated, so CI never spends tokens) sends the
   fixture through the classification prompt to a real provider once
   and reports per-kind results. The runner runs once before merge and
   the LEDGER records the result with model name, prompt, and the
   small-sample caveat. This measures the split the issue flags; the
   spec claims no number in advance.

## Release

Major. `core-llm-wiki` publishes 9.0.0: the config key removal is the
breaking change, carried by a `refactor!`/`feat!` commit citing the
owner ruling (2026-11-13: fix now while adoption is near-zero). The
`BREAKING CHANGE` footer is written with the ruling's citation — the
AGENTS.md rule bars footers without a ruling; this one has it.
`schema-software-org` publishes its own major for the type removals.
Commit `docs:` changes separately from the manifest and core changes
(spec and code in separate commits; AGENTS.md).

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
