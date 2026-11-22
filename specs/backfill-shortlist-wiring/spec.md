# Spec — PR 2b: The per-fact shortlist in the ontology-backfill prompt

Status: Reviewed 2026-11-21 — owner approved; rulings OQ1–OQ4 recorded in the
Owner rulings section below (Kurt, Discord msg `1573841239412052079`).
Implementation follows this spec.
Lane 2, PR 2b. Roadmap step 8 ("The shortlist in the backfill prompt",
`docs/ROADMAP.md`). Base: `origin/main` @ `e268b892` (v9.9.0 release cut,
PR #452). Every pin below is re-verified live against `e268b892`.

## Problem

The ontology-backfill prompt carries a title catalog of typed nodes. The
catalog lists every typed node, sorted by title, capped at 200 entries and
8000 chars (`TITLE_CATALOG_MAX_ENTRIES` and `CHAR_BUDGET`,
`packages/core/src/prompts.ts`). The order has no relation to the fact
being classified. A dense memory fills the catalog with irrelevant titles.
The host model must find the right `target_title` inside up to 200 lines.

Roadmap step 7 built a per-fact shortlist and measured its recall. Roadmap
step 8 narrows the catalog to that shortlist. This spec owns the wiring.

This spec also records the errata that supersedes the temporary data-scope
ruling of 2026-11-19 (the #425 ruling, commit `095b564b`). The
all-typed-nodes catalog is no longer acceptable as a permanent shape.

## Root cause with evidence

- The backfill pass reads all typed rows once per pass:
  `findTitleIndexByEntityId(entityId)` returns `{id, title, okf_type}`
  rows (`packages/core/src/repositories/EntryRepository.ts:1878`).
- `buildTitleCatalogBlock(titleRows)` renders one shared block
  (`packages/core/src/services/MaintenanceService.ts:2283-2284`, method
  `_runGenerativeBackfill`).
- The prompt service splices that one block into the system prompt and
  puts all batch facts in the user prompt
  (`packages/core/src/services/PromptService.ts`, `buildOntologyBackfillPrompt`).
- The batch holds 25 facts (`ONTOLOGY_BACKFILL_BATCH_SIZE = 25`,
  `packages/core/src/services/MaintenanceService.ts:49`). All 25 facts
  share one catalog.
- The measured fix exists: `buildShortlist` and `shortlistScore` in
  `packages/core/src/utils/shortlist.ts` (pure, unit-tested in
  `packages/core/__tests__/shortlist.test.ts`). The recall run
  (`packages/benchmarks/results/shortlist-recall-9.8.0-2026-11-21.json`)
  pins k = 10 and the LEXICAL scorer (recall@10 = 0.9643 lexical vs
  0.8214 embedding on `distractor-variants`; see the Result note in
  `specs/shortlist-recall/spec.md`).

Two structural facts drive the design:

1. **The catalog is per-pass; the shortlist is per-fact.** One shared
   block for 25 facts cannot carry per-fact rankings. A per-batch union of
   top-k lists dilutes the ranking and can exceed the entry cap. The
   recall evidence is per-fact, so the wiring must be per-fact.
2. **Title-index rows carry no body.** The benchmark measured rows with
   bodies; the live query selects `id, title, okf_type` only. Scoring
   body-less rows is title-Jaccard only, and the measured recall does not
   transfer to it unchanged.

## Proposed change

### 1. Per-fact candidate blocks in the user prompt (OQ1)

In `_runGenerativeBackfill`, score the typed rows against each fact in
the batch and render one candidate block per fact:

- Call `buildShortlist(fact, typedRows, k)` with the default lexical
  scorer. `typedRows` comes from the scoring query of §2, which mirrors
  the title-index query's filters and adds `body`.
- Render a per-fact section after the facts JSON in the user prompt:
  for each fact id, its top-k lines in the catalog line format
  (`- "title" (okf_type)`).
- The shared `TITLE CATALOG` block leaves the backfill prompt.
  `buildTitleCatalogBlock` stays. Edge resolution still reads the same
  title index. The function also defines the line format the new
  renderer reuses.

Validity is not narrowed. Edge resolution resolves against the full
title index, so the model may still name a node outside the shortlist.
The prompt keeps the non-exclusive wording: an unlisted valid target
remains valid. A shortlist miss degrades the hint, not the validity.
The shortlist read happens once per pass outside the batch transaction
while edge resolution reads inside it; the last-wins/row-order
divergence the catalog already carried (`packages/core/src/prompts.ts:81-85`)
applies unchanged.

Prompt shape: the user prompt gains a per-fact keyed section. Hosts
override the backfill system prompt with `promptOverride`; the
placeholder branch (`{{facts}}` templates) returns before any catalog
splice today and keeps returning no candidate sections after this
change. Documented, unchanged.

### 2. Row bodies in the scoring query (OQ2)

The scoring query must read `body` in addition to `id, title,
okf_type`, so the live scorer is the same ranker the measured evidence
was produced with (INTENT rule 11: alignment with the measured ranker,
not a new performance claim). The
pass already reads every typed row once; the query gains one column.
The candidate renderer keeps showing title and type only.

### 2a. Dated note (2026-11-21, Opus code-review m5): validity-window scope

The scoring query filters live, typed rows like `findTitleIndexByEntityId`
does; it does not apply a validity-window (`liveAt`) filter. This matches
the old catalog and edge resolution, which resolve against the same
index. The candidate queue filters to current facts, so a window-expired
typed node can still appear as a candidate. Kept deliberate for index
consistency: filtering the hint but not the resolver would create a new
divergence. A validity-window pass over the title index is follow-up
scope, not 2b.

### 3. The k knob (OQ3)

`OntologyConfig` gains `shortlistK?: number`
(`packages/core/src/types.ts`, beside `backfillClassifier`).
Validation contract: a finite integer >= 1; an invalid value throws at
use, never falls back silently (same boundary precedent as the
`classifier` option in `doRunOntologyBackfill`). The throw precedent in
code is `resolveContextBudgetOrThrow`
(`packages/core/src/utils/engineDefaults.ts:27`); the OQ3 ruling's
comparison to the system-one-config validation patterns covers key
placement and message style only — those patterns warn-and-fall-back,
which this throw contract overrides. Default 10, the
owner-pinned value from `specs/shortlist-recall/spec.md`.

### 4. Fewer than k typed nodes

`buildShortlist` already returns the whole deduped pool when the pool is
smaller than k. Zero typed nodes render no per-fact candidate sections;
the renderer emits one shared footer line with the non-exclusive
wording ("this memory contains no typed nodes yet" — omit `edges`
rather than invent a target), so the omit-edges instruction never
disappears with the catalog block that used to carry it
(`packages/core/src/prompts.ts:116-120`). A fact classified in the same
response stays a valid target.

### 5. Scorer

The lexical default scorer ships in core. Core gains no embedding
dependency (`buildShortlist`'s injectable `score` parameter stays; the
benchmark injects the embedding scorer, core does not). The owner pinned
LEXICAL for 2b.

### 6. Errata (records the supersession of the #425 ruling)

The 2026-11-19 #425 ruling accepted the all-typed-nodes catalog as
temporary. This errata supersedes it: the catalog shape is replaced by
the per-fact shortlist of roadmap step 7, measured by
`specs/shortlist-recall/spec.md`. The replacement lands in this PR.

## Test plan

- New pure renderer unit tests: per-fact block format, dedupe and
  validity filters (shared with `buildShortlist`), fewer-than-k pool,
  zero-pool shared no-nodes footer (no per-fact sections).
- Config knob tests: default 10, integer >= 1, invalid values throw.
- `MaintenanceService` tests: the backfill user prompt carries one
  candidate section per fact and no shared catalog block; prompt
  overrides keep the placeholder branch behavior; the payload cap
  (`ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS`, 40000) still bounds the prompt.
- Existing suites pass: benchmarks suite
  (`pnpm --filter @equationalapplications/benchmarks-llm-wiki test`) and
  the core suite (`@equationalapplications/core-llm-wiki`). No fixed
  test count is pinned here; the suite passes as a whole (the count
  drifts with every added test).

## Out of scope / rejected alternatives

Out of scope:

- The ontology-backfill prompt cap under the context budget. Roadmap
  step 9 owns it behind its own gate ("steps 6 and 8 merged, and a
  spec"); `specs/context-budget/spec.md` records the same exclusion.
  This PR does not touch the cap constant's wiring.
- Receipts and telemetry for shortlist misses (OQ4 ruled none,
  2026-11-21: a miss is a successful edge resolution; the existing
  `classification_abstained` and edge-drop diagnostics suffice).
- Any roadmap step 9-14 work. Each needs its own spec cycle and owner
  gate.

Rejected alternatives:

- We rejected a per-batch union shortlist in the shared system-prompt
  slot. It dilutes per-fact rankings, can exceed the entry cap, and
  breaks the link to the per-fact recall evidence.
- We rejected an embedding scorer in core. Core stays pure; the owner
  pinned LEXICAL for 2b.
- We rejected scoring on titles only. The measured evidence scored rows
  with bodies; title-only scoring ships an unmeasured ranker.
- We rejected a dated amendment inside
  `specs/shortlist-recall/spec.md`. That spec reads Implemented with
  its scope closed (its section 3 excludes wiring); a new folder keeps
  that status honest.

## Owner rulings (2026-11-21, Discord msg `1573841239412052079`)

- **OQ1 — prompt shape: approved.** The per-fact candidate section renders
  in the user prompt directly after the facts JSON. "The system prompt
  should remain general instructions; the user prompt carries the payload."
- **OQ2 — scoring rows: approved.** The scoring query reads `body`.
  Owner rationale: the measured recall came from Jaccard over full row
  text; title-only scoring degrades to keyword overlap and recall
  "plummet[s]". Reading the body keeps production at the measured
  performance. [Scope note: the measured evidence is shortlist recall@10
  on the committed fixture, not end-to-end classification (INTENT rule
  11); this PR ships the measured ranker, no new performance claim.]
- **OQ3 — k knob: approved.** `OntologyConfig.shortlistK`, default 10
  (the benchmark-proven point), strict boundary validation — finite
  integer >= 1, throws on invalid — matching the system-one-config
  validation patterns. [Clarified 2026-11-21, Opus T3 delta: the
  ruling's last clause conflicts with its own "throws on invalid"
  contract — the system-one-config patterns warn-and-fall-back. Spec §3
  governs: the throw contract stands; the comparison covers key
  placement and message style only. Pending owner confirmation at the
  next check-in.]
- **OQ4 — receipts: confirmed none.** An unlisted-but-valid target is a
  successful edge resolution. A miss diagnostic would be noise. The
  existing `classification_abstained` and edge-drop diagnostics suffice.

## Files touched

- `packages/core/src/services/MaintenanceService.ts` — per-fact
  shortlist build, knob validation, renderer call.
- `packages/core/src/services/PromptService.ts` — user-prompt candidate
  section; catalog splice leaves the backfill path.
- `packages/core/src/prompts.ts` — new pure per-fact renderer (reuses
  the catalog line format).
- `packages/core/src/types.ts` — `OntologyConfig.shortlistK`.
- `packages/core/src/repositories/EntryRepository.ts` — scoring query
  gains `body` (OQ2).
- Tests beside the existing suites (`packages/core/__tests__/`).
