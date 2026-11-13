# Librarian guidance and the general leave-out rule

**Status:** Draft
**Date:** 2026-11-13
**Intent check:** Rule 3 — the per-entity value keeps one database's many
memories separate, and neither value is stored, so nothing mixes. Rule 5 —
guidance changes what ingest selects, never what a stored document fact
says; this spec states that invariant and tests it. Rule 6 — over-cap
guidance and resolver failures are refused with a diagnostic, never
silently; model-side omissions that the leave-out rule itself can cause
are not engine-diagnosable, and that risk is accepted by the owner's
ruling (see The general leave-out rule). Rule 7 — a length
cap bounds the text resent on every librarian call, and prompt volume is
reported, not billed tokens. Rule 10 — this spec first. Rule 11 — the
change is verified by cheap targeted tests for plumbing and prompt
construction. This spec claims no accuracy or cost effect at all, so
rule 11's "measured before it is claimed" is not triggered; the
2026-11-10 ruling on benchmarks (recorded in `specs/targeted-diagnostics`
and restated in roadmap step 1) is background, not a claim that these
unit tests replace benchmark suites. This is roadmap
step 1 (`docs/ROADMAP.md` — created by PR #378, which merges before
this PR does; until then the cite points forward). Owner rulings
2026-11-12 and 2026-11-13. Minor release (8.5.0): see Release.

## Problem

A host cannot give the librarian domain instructions without giving up
the `ops` chain. `prompts.librarianSystemPrompt` replaces the whole
prompt and only `legacy` reads it (`PromptService.buildLibrarianPrompt`,
`packages/core/src/services/PromptService.ts:117`); `ops` — the default
since 8.0.0 — sends the fixed `OPS_EXTRACT_SYSTEM_PROMPT` and takes no
host text at all (`PromptService.ts:273-284`). A host that sets the
override gets pointed back to `legacy` by `changedDefaultWarnings`
(`packages/core/src/utils/engineDefaults.ts:36`). A whole-prompt
override also replaces the JSON output contract the engine parses, and
freezes the host out of every later improvement to the built-in prompt.

Separately, memory keeps too much that a better record already holds.
In a prototype over one product's notes, roughly a third of extracted
statements restated what the code or a spec says (hand count on a random
56 of 448; rough). Those statements go stale when the record changes.

## Root cause (with evidence)

Two facts in the code:

1. The only host-text channel is a whole-prompt override read by one
   strategy (`packages/core/src/types.ts:45`,
   `PromptService.ts:117`). There is no short-guidance channel and no
   per-entity one: `PromptService` is built once per database from
   `globalOverrides`, and `LibrarianContext` carries only a
   `promptOverride` for the legacy whole prompt
   (`services/librarian/types.ts`, `MaintenanceService.ts:463`).
2. The built-in prompts say nothing about deferring to better records.
   `INGEST_SYSTEM_PROMPT`, `LIBRARIAN_SYSTEM_PROMPT` and
   `OPS_EXTRACT_SYSTEM_PROMPT` (`packages/core/src/prompts.ts`) extract
   "stable facts" from whatever they are given, with no leave-out
   instruction. Librarian facts are written with `source_ref: null`
   (`ops/apply.ts:88`, `legacy.ts:168`), so nothing downstream can
   check an extracted statement against its source either.

Evidence for the scale of the restatement problem is the prototype hand
count above; it is a sizing figure, not a measured result (rule 11).

## Proposed change

### The setting

`prompts.guidance` — a short plain-text string, set by the host in
`WikiConfig.prompts`. Set in two places:

- **Database default:** `config.prompts.guidance`. Same emptiness rule
  as below: a value that is empty or whitespace-only after trimming
  counts as unset.
- **Per entity:** `config.prompts.guidanceForEntity?: (entityId: string)
  => string | undefined`. A per-entity return of a **non-empty string
  wins** — non-empty after trimming, so a whitespace-only return falls
  back to the default; a non-empty value is otherwise sent verbatim, no
  trimming applied; an empty or `undefined` return falls back to the
  default.

The host passes both in. The engine stores neither (rule 3: nothing to
mix across memories; rule 2: no schema or table change). The resolver is
synchronous and returns `string | undefined`; it is resolved **once per
pass or call** — one librarian pass, one ingest call, one
`getInstructions` call — not once per prompt build, so values may change
between passes but never mid-pass. A resolver failure is
guidance-shaped, never a write failure: if it throws, returns a Promise,
or returns any non-string value, the engine treats it as "no value"
(falls back to the default, or to none) and emits a
`guidance_resolver_failed` diagnostic carrying the entity id — same
cadence as the cap diagnostic: at most once per pass or call. A returned
thenable that later rejects gets a no-op rejection handler attached
before it is discarded, so a JS host's async resolver can never surface
as an unhandled rejection; the call's outcome is decided synchronously
from the return value alone.

### Where guidance is added

The engine adds the effective guidance, inside a clearly marked section,
to the three prompts that author fact text from events and documents:

- `INGEST_SYSTEM_PROMPT` (ingest — `buildIngestPrompt`,
  `PromptService.ts:92`);
- `LIBRARIAN_SYSTEM_PROMPT` (legacy librarian — `buildLibrarianPrompt`,
  `PromptService.ts:117`);
- `OPS_EXTRACT_SYSTEM_PROMPT` (ops extract — `buildOpsExtractPrompt`,
  `PromptService.ts:273-284`).

Marked section shape (exact delimiters fixed at implementation, and
asserted by test). Insertion point: the section is appended to the
**already-hydrated** system prompt — after ontology context, immediately
before `appendGrounding` — and the guidance text itself is never run
through placeholder hydration, so guidance containing
`{{documentChunk}}` or similar cannot change a builder's template branch
or be expanded with data (test plan item 2 covers this):

```
--- Host guidance ---
<the effective guidance text>
--- End host guidance ---
```

`OPS_RESOLVE_SYSTEM_PROMPT`, `HEAL_SYSTEM_PROMPT` and
`ONTOLOGY_BACKFILL_SYSTEM_PROMPT` do **not** receive guidance in this
release. Resolve and heal manage duplicate and stale facts but do not
author new claims from events; the restatement problem this release
targets happens at extraction. Backfill writes ontology node
descriptions, not fact content. If hosts or the Curated Thoughts twin
report restated merged bodies, extending guidance to resolve and heal is
a small follow-up; it is deliberately not in this one.

### The general leave-out rule

One fixed sentence, written by the engine, appended immediately after
the guidance section:

> Memory leaves out what a better record already holds, and points to
> that record.

It is added **only when a host sets guidance** — i.e. only on a prompt
build where the effective guidance is **sent**: non-empty and within
the cap. An over-cap value is not sent (§Length cap and diagnostic), so
the prompt carries neither the guidance section nor the rule sentence.
With no guidance anywhere in play, every prompt is byte-identical to
today's (test plan item 1). No record is named in the rule, so it
changes little for a host with none; but the engine still withholds
it, because the ruling is
that an upgrade changes nothing for a host that opted into nothing.

Turning the rule on for every host, always, is EXPLORATORY on the
roadmap and is gated on a test this repo does not have yet; nothing here
builds toward it silently.

**The pointer channel in this release.** The ruled sentence says memory
"points to that record". Today a librarian fact has nowhere structured
to point: `source_ref` is `null` (`ops/apply.ts:88`, `legacy.ts:168`)
and the pointer is #377's work. In this release the only channel is the
fact's own text — the model can name the record it deferred to, e.g.
"recorded in `docs/ROADMAP.md`". Guidance should name its records by
title so the model has something concrete to name; the example guidance
in the handoff ("the code and the specs are the record") works this way.
A test asserts the rule sentence appears exactly as ruled.

**Omission risk, stated.** The leave-out rule is an instruction to the
model, and a model following it can omit a fact that no better record
actually holds — a false omission. No diagnostic can see it: the engine
receives nothing to report. That is inherent to what was ruled; the
owner accepts it as the price of not restating records, and the
alternative (no rule) is the restatement problem this release solves.
Nothing here measures the false-omission rate; any future measurement
is new work, not part of this release.

### Plumbing

- The three write-path builders gain one optional trailing parameter,
  `guidance?: string` — the **already-resolved, already-capped**
  effective text — and `buildInstructionTemplates` gains it as a third
  parameter, `(ontologyContext, librarianStrategy, guidance?)`. The
  builders never call the resolver themselves.
- Resolution is hoisted to the call boundary, **inside
  `runLibrarianPass`** (`MaintenanceService.ts:896`) — both callers go
  through it: the manual `runLibrarian`/`doRunLibrarian` path and the
  scheduler's deferred drain (`MaintenanceScheduler.ts:164` calls
  `runLibrarianPass` directly, skipping `doRunLibrarian`). Resolving in
  `doRunLibrarian` would leave default-config (deferred) hosts silently
  without guidance. A scheduler drain that runs several passes in a row
  can emit the per-pass diagnostics several times — once per pass is
  the contract. `IngestionService` resolves once, **next to the
  ontology-context hoist** (`:182`), so an ingest that acquires locks
  and then returns early (duplicate hash, no chunks) never runs the
  resolver and never emits a guidance diagnostic for work it did not
  do; `getInstructions` resolves once per call.
- Two new codes join `WikiDiagnosticCode` (`packages/core/src/types.ts`):
  `guidance_too_long` and `guidance_resolver_failed`. The diagnostics
  channel itself is existing and unchanged. Both are severity `warn` —
  each means the host's guidance was silently not applied.
  `guidance_resolver_failed` reuses the existing `reason` detail field,
  which is typed plain `string`; `'threw' | 'non_string'` is a values
  convention, and a returned Promise is reported as `non_string`. No
  detail field ever carries guidance text (`WikiDiagnosticDetail` stays
  identifiers-only). `getInstructions` emits **no** diagnostics — it is
  a read path; it applies the same fallback silently. The existing
  `operation` values cover both codes (`ingest`, `librarian`); no new
  operation is added.
- Composition with overrides: whichever template wins — built-in
  default, `PromptOverrides`, a per-call ingest `promptOverride`, or the
  legacy `runtimeOverride` — receives the guidance section appended at
  the insertion point above. Guidance composes after every override;
  nothing suppresses it except "not set" and "over cap".

### Beside the whole-prompt override

Under `legacy`, `prompts.librarianSystemPrompt` keeps working and
guidance is appended to it in the marked section — the two compose.
Under `ops`, the override stays ignored (unchanged) and guidance works.
Grounding stays last in every prompt: the guidance section is inserted
before `appendGrounding` runs (`PromptService.ts:37`).

### Deprecation

`prompts.librarianSystemPrompt` is marked `@deprecated` in
`WikiConfig` docs in this release, with "removed in 9.0.0". The
`changedDefaultWarnings` message for an override under ops
(`engineDefaults.ts:36-42`) now points at `prompts.guidance` instead of
only telling the host to pin `legacy`. A **second message** covers a
host that set `librarian.strategy: 'ops'` explicitly — today that host
gets no warning and a silently ignored override, and the existing
message's "now defaults to 'ops'" text is false for it. The existing
message and its test assertions (including the `strategy: 'legacy'`
substring at `engineDefaults.test.ts:83`) stay; the new case adds a
message, it does not replace one. Removal itself is #376's release
(owner ruling 2026-11-13; the 9.0.0 break covers exactly the listed
removals and nothing else).

### Length cap and diagnostic

The effective guidance text is capped at **2,000 characters**, counted
as UTF-16 code units (`String.prototype.length` — the measure the
implementation and the diagnostic both report; an emoji counts as 2).
The constant is exported from `packages/core/src/prompts.ts` (or a
constants module, so a host can read the limit). Enforcement happens at
resolution — once per pass or call, alongside the resolver — and the
result applies to every prompt build in that pass:

- At or under the cap: guidance is sent as specified.
- Over the cap: the guidance is **not sent** for that call; the prompt is
  exactly the no-guidance prompt; the engine records a diagnostic (code
  `guidance_too_long` on the existing diagnostics channel — detail
  `guidanceLength` (number, UTF-16 units) and `guidanceSource:
  'per_entity' | 'default'`, both added to `WikiDiagnosticDetail`,
  which stays identifiers-only; severity `warn`) with the offending
  value's length and whether it came from the per-entity value or the
  default. Nothing is truncated and nothing is stored (rule 6).
  The diagnostic is emitted at most once per pass (one librarian pass or
  one ingest call), not once per prompt build — a single ingest of many
  chunks reports the over-cap value once, not once per chunk. The flag
  lives on the pass/call state and is never persisted across passes.
  Over-cap never falls back to the other value: the winning value (the
  per-entity one when it returned a non-empty string, else the default)
  is suppressed for that call, and the prompt is the no-guidance prompt.
  Falling back would silently substitute different instructions, which
  is worse than none.

Rationale: truncation would silently change instructions mid-sentence;
refusal is deterministic and visible. The cap bounds the per-call spend
(rule 7) at roughly one extra page of prompt per librarian call.

### Grounding boundary

Guidance is part of the instructions and can never count as grounding
evidence. The grounding block already instructs the model not to quote
its instructions; the grounding corpus is built from event and document
text only (`buildGroundingCorpus`, `utils/grounding.ts`) and is
unchanged. A test asserts the guidance text never appears in a built
grounding corpus and that the grounding block remains last (test plan
item 3).

### Instructions surface

`WikiMemory.getInstructions(entityId)` (`WikiMemory.ts:697`) resolves
the effective guidance for that entity and returns the four templates —
the ingest and librarian templates carrying the guidance section, heal
and ontology backfill unchanged — so a host rendering its own prompts
sees exactly what the engine would send. On this returned-template
surface, guidance containing `{{…}}` would sit in the template looking
like a real placeholder — the engine never expands it, but a host that
fills the returned template's data placeholders would. The docs
therefore state that guidance must not contain `{{…}}` placeholder
syntax, and a test asserts the section still comes back verbatim in the
returned template. The docs repeat the existing
warning that this text is returned verbatim and must hold no secrets
(guidance is host-provided; the engine adds none of the host's data to
it).

### Rule 5 invariant

Guidance changes what ingest *selects* from a document. It never changes
a stored document fact's text; stored document facts remain immutable
(rule 5). The test asserts what rule 5 actually protects: ingest a
document, then run both librarian strategies and heal with guidance that
tells the model to rewrite document facts, and assert the stored
document rows are unchanged.

## Files touched

- `packages/core/src/types.ts` — `prompts.guidance`,
  `prompts.guidanceForEntity`; `@deprecated` on
  `prompts.librarianSystemPrompt`; two `WikiDiagnosticCode` entries and
  two `WikiDiagnosticDetail` fields (`guidanceLength`,
  `guidanceSource`).
- `packages/core/src/services/PromptService.ts` — guidance resolution
  helper (default → per-entity, cap check, marked section, rule
  sentence); threaded through `buildIngestPrompt`,
  `buildLibrarianPrompt`, `buildOpsExtractPrompt`,
  `buildInstructionTemplates`. Untouched: `buildOpsResolvePrompt`,
  `buildHealPrompt`, ontology backfill builder.
- `packages/core/src/services/librarian/types.ts` — `guidance?: string`
  on `LibrarianContext` / `LibrarianPassContext`.
- `packages/core/src/services/librarian/legacy.ts` and
  `packages/core/src/services/librarian/ops/extract.ts` — pass the
  resolved guidance to `buildLibrarianPrompt` and to **both**
  `buildOpsExtractPrompt` calls (the budget estimate at `extract.ts:55`
  and the real call at `:67` must receive identical guidance, or batch
  sizing undercounts by up to the cap).
- `packages/core/src/WikiMemory.ts` — `getInstructions` resolves the
  entity's effective guidance and passes it to
  `buildInstructionTemplates`.
- `packages/core/src/services/MaintenanceService.ts` — resolve effective
  guidance per entity when building the librarian context.
- `packages/core/src/services/IngestionService.ts` — pass guidance
  through to `buildIngestPrompt`.
- `packages/core/src/utils/engineDefaults.ts` — updated
  `changedDefaultWarnings` message.
- `packages/core/src/prompts.ts` — cap constant; the rule sentence as an
  exported constant (used by tests and by any host inspecting prompts).
- Docs updated in the same PR, latest version only (README config
  section, docs site page for prompts if present, CHANGELOG via release
  tooling — CHANGELOG itself is never hand-edited).

## Test plan

All zero-token and deterministic; no benchmark run, no accuracy or cost
claims published (rule 11). Suites live in `packages/core/__tests__/`.

1. **No-guidance parity.** For both strategies and for ingest: with no
   `prompts.guidance` and no resolver return, every built prompt is
   byte-identical to today's. The oracle is a set of **golden strings
   committed from the unmodified code before any change lands** — one
   per builder that gains the parameter: `buildIngestPrompt` (default,
   configured override, per-call override), `buildLibrarianPrompt`
   (no-placeholder and placeholder templates), `buildOpsExtractPrompt`,
   and `buildInstructionTemplates` for both strategies, each with and
   without ontology and grounding. (`librarianPrompt.test.ts` has no
   snapshots today and never calls the ops or ingest builders; the only
   existing snapshot file covers legacy parity.) A golden-file
   difference in the engine's prompt construction, after this change,
   for a no-guidance host, is a defect — not an update.
2. **Guidance placement.** With guidance set (and with a per-entity
   value overriding the default): the marked section appears exactly
   once, contains the effective value verbatim, the rule sentence
   follows it, grounding block still last. Under `legacy` with
   `librarianSystemPrompt` also set, the override still leads and the
   section is appended. Guidance text containing `{{...}}` placeholder
   syntax passes through verbatim and never triggers hydration or
   changes a builder's template branch. The rule sentence is asserted
   character-for-character against the ruled text.
3. **Grounding boundary.** Guidance text never appears in
   `buildGroundingCorpus` output for any writer; the grounding block's
   position is unchanged with and without guidance.
4. **Scheduler path.** A deferred drain driven by
   `MaintenanceScheduler` (the 8.0.0 default path) delivers guidance to
   its librarian passes — drive the scheduler and assert the built
   prompt carries the entity's effective guidance.
5. **Cap and diagnostic.** A 2,001-character value produces the
   no-guidance prompt plus a `guidance_too_long` diagnostic carrying
   detail `guidanceLength` and `guidanceSource`; a 2,000-character value
   passes; a value at the boundary counted in UTF-16 units (e.g. 1,000
   two-unit characters) behaves by the same count. A resolver returning
   a long string over a short default is diagnosed as per-entity, and
   suppresses guidance for that call with **no fallback** to the
   default. The diagnostic fires once per pass, not once per chunk. The
   ops budget estimate and the real extract prompt receive **identical**
   guidance (assert both built prompts are equal).
6. **Resolution and resolver failures.** Per-entity wins over default;
   `undefined`/empty/whitespace-only resolver return falls back, and the
   same applies to a whitespace-only default; a resolver that throws,
   returns a Promise (including one that later rejects), or returns a
   non-string value falls back and emits `guidance_resolver_failed`
   with the entity id, at most once per pass; the resolver is called
   exactly once per pass (assert the call count); resolver not called
   at all when no default and no resolver are configured (no surprise
   invocations).
7. **Instructions surface.** `getInstructions(entityId)` reflects the
   entity's effective guidance in all returned templates that carry it,
   and omits it where this spec says guidance is not sent.
8. **Warning text.** `changedDefaultWarnings` with an override under ops
   mentions `prompts.guidance` — when `librarian.strategy` is left
   unset via the existing message (its `strategy: 'legacy'` substring
   assertion stays), and via a **second message** when it is set to
   `'ops'` explicitly. `getInstructions` emits no diagnostics.

## Release

Minor (the number is release tooling's; expected 8.5.0). The setting
and the marked section are additive. The
built-in prompts change model output **only for hosts that set
guidance** — new opt-in behavior, not changed behavior for an existing
host — because the rule sentence rides the guidance section and nothing
is added when guidance is absent. The `changedDefaultWarnings` text
change is a message improvement, not a behavior change. Deprecation
notice on `librarianSystemPrompt` is the ruling's placement (deprecate
now, remove in 9.0.0 with the #376 breaks).

## Non-goals

- Statement kinds and areas (#376); source pointers (#377); the source
  store (roadmap step 4).
- Curated Thoughts (Rust librarian, own prompts — its twin is
  curated-thoughts#343) and the CTI role pack
  (curated-thoughts-integrations#96).
- Re-processing facts already stored: guidance applies to what the
  librarian writes from now on only (owner ruling 2026-11-13).
- Any check of a statement against real code. The leave-out rule is an
  instruction to the model; nothing in the engine can verify it.
- The always-on variant of the leave-out rule (EXPLORATORY, roadmap).
