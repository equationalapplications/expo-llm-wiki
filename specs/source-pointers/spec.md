# Source pointers on librarian facts

**Status:** Approved (owner gate passed 2026-11-13, in-thread)
**Date:** 2026-11-13
**Owner rulings:** 2026-11-13 (issue #377: the provenance scope, the
additive-schema rule, and the four checks against INTENT.md). This spec
answers the four questions the issue poses; the owner gates the answers.
**Intent check:** Rule 2 — this change adds one nullable column, one
diagnostic code, and one OKF frontmatter key. It drops nothing. Rule 5 —
unchanged. A pointer is provenance, not an edit path; no code may rewrite
a stored fact through it. Rule 5's Planned note names this change, and
that note's text updates in the pull request that ships the behavior.
Rule 6 — a pointer the model names but the engine cannot resolve emits a
diagnostic. Nothing is dropped silently. Rule 10 — this spec comes first.
Rule 11 — this spec claims no accuracy or cost effect. It is a provenance
change, and the test plan runs plumbing tests only.
Release: **minor** (expected 9.1.0; the number is release tooling's). See
§Release.

## Problem

A librarian fact carries no pointer to its source. A reader cannot go
from the fact back to the event it came from. Ingested document facts
carry `source_ref`; librarian facts carry `source_ref: null` and
`source_hash: null` on both strategies
(`packages/core/src/services/librarian/ops/apply.ts:88`,
`packages/core/src/services/librarian/legacy.ts:169`).

The trail exists while the pass runs, and the engine then drops it. The
ops extract prompt already orders the model to name its event
(`OPS_EXTRACT_SYSTEM_PROMPT`, `packages/core/src/prompts.ts:79-85`:
"Every fact must name the single event it comes from in
\"source_event\""). The parser resolves that label to a real event
(`packages/core/src/services/librarian/ops/extract.ts:88-91`), keeps it
only as a `valid_from` fallback, and never writes it to the row.
`apply.ts` never reads the candidate's label (grep count: 0 hits).

## Root cause (with evidence)

1. The write path hardcodes the nulls. The row literals at
   `ops/apply.ts:88` and `legacy.ts:169` set `source_ref: null` and
   `source_hash: null`, and the candidate's resolved label reaches
   neither site.
2. An unknown label degrades silently. `extract.ts:89` maps an unknown
   `source_event` string to `null` with no diagnostic. This is a rule 6
   gap: the model named a pointer, and the engine dropped it without a
   report.
3. Quotes have no home and no position. Grounding checks evidence quotes
   at write time (`packages/core/src/utils/grounding.ts:63-77`), but the
   `entries` table has no `evidence` column
   (`packages/core/src/db/schema.ts:5-40`), so a validated quote dies at
   the end of the pass. No position or character offset exists anywhere
   in the grounding code; matching is normalized substring containment.

## The decisions (the four questions the issue poses)

The issue poses four questions. This section answers them; the sections
after it give the detail.

1. **Reuse or new field — a new field.** The pointer rides a new nullable
   `source_pointer` column on `entries`. It does not reuse `source_ref`.
   §Rejected alternatives gives the reasons.
2. **Pruned events — the pointer survives, dangling.** Prune stays a hard
   delete of event text. The pointer is never rewritten and never nulled
   by prune. §Pruned events gives the semantics.
3. **Several sources — one pointer, not a list.** The ops contract
   already forces a single event. §One pointer, not a list gives the
   rule for a model that names more than one.
4. **OKF — a new optional frontmatter key.** The pointer rides a new
   `source_pointer` key in the OKF frontmatter. Existing `resource` and
   `sources` handling is unchanged. §Export, import, and OKF gives the
   parsing rule.

## Proposed change

### The pointer

A **source pointer** is the structured reference from a librarian fact
to the event it came from, with its supporting quote and its position.
The glossary gains this term in the same pull request.

The column is `source_pointer TEXT` on `entries`, nullable, holding
JSON. The TypeScript shape:

```ts
export type WikiSourcePointer = {
  event_id: string | null;
  ref: string | null;
  quote: string | null;
  position: { start: number; length: number } | null;
};
```

The four slots follow the ruled scope: the event, a host-supplied ref,
the quote, and the position. Two slots have no producer in this release,
and this spec says so plainly:

- `ref` stays `null` always. The engine has no channel for a
  host-supplied ref today: `write()` takes only the event fields
  (`WikiMemory.ts:800`, `Omit<WikiEvent, 'id' | 'entity_id' |
  'created_at'>`), and `remember()` has no ref parameter
  (`RememberInput`, `types.ts:1499-1514`). The slot keeps the shape
  future-proof without inventing a channel.
- `position` stays `null` always. No producer exists: grounding quotes
  carry no offsets (`grounding.ts`), and events carry no offsets. The
  slot exists because the ruling names position; the release does not
  fake one.

`event_id` and `quote` have producers. §Ops path and §Quote rule define
when each is set.

### One pointer, not a list

A fact carries one pointer. The ops prompt contract already says "the
single event" (`prompts.ts:85`), so the engine has exactly one named
event per fact. A list would add shape with no writer.

The parser resolves the pointer only from the raw `source_event` value
in the model's response. The rule, the same on both strategies:

- The field is absent: no pointer, no resolution attempt. On ops this
  emits the `missing` diagnostic (§Diagnostics); on legacy it does not.
- The field is present: its value must be a string that names exactly
  one label of the current batch. Any other present value — a
  non-string, a string naming no batch label — is unresolved and emits
  `unknown_label`. Today the parser resolves absent and invalid values
  through one expression (`extract.ts:89`); the change splits them so
  the two reasons are distinguishable.

The label space is batch-local
(`e1`, `e2`, ...; `text.ts:11-12`), so a pointer from one pass never
collides with another pass's labels: the engine resolves the label to
the real event id at extract time, before any write.

### Ops path

The extract parser already resolves the label to a batch event
(`extract.ts:88-91`). The change is small and mechanical:

- The candidate carries the resolved **event id** (from
  `LabeledEvent.event.id`), not only the label.
- `ops/apply.ts` writes the pointer on every librarian fact it inserts:
  `event_id` from the candidate; `quote` by the quote rule below;
  `ref` and `position` null.
- A missing or unresolved `source_event` produces a null pointer plus a
  `source_pointer_unresolved` diagnostic (§Diagnostics). Today this case
  is silent (`extract.ts:89`); the diagnostic is the rule 6 fix.
- An UPDATE operation on an existing `librarian_inferred` fact never
  adds, changes, or removes its pointer. The UPDATE branch writes title
  and body only today (`ops/apply.ts`), and that stays true.

### Legacy path

The legacy prompt is unchanged. `LIBRARIAN_SYSTEM_PROMPT` keeps its
exact text, so legacy prompts stay byte-identical on upgrade — the same
upgrade-safety posture that the guidance release (#375) ruled. The
legacy parser gains a tolerant read of `source_event` (new parsing,
listed in §Files touched): when a model returns
one and it resolves, the engine writes the pointer; when the field is
absent, the pointer is null and **no diagnostic fires**, because the
legacy contract never promised the field. An unknown label on legacy
behaves as on ops: null pointer, diagnostic. The expected result is that
legacy facts mostly carry a null pointer, and this spec records that gap
as accepted: the ruled scope covers what the librarian writes from now
on, and the ops strategy is the default since 8.0.0.

### Heal restatements

The heal pass writes librarian facts too: it builds a restated
`WikiFact` with null source fields and upserts it
(`packages/core/src/services/MaintenanceService.ts:1268-1275`). This
release does not give heal facts a pointer, and the spec says so
openly: heal's candidates carry no model-named `source_event` — the
heal model restates existing facts, and there is no attribution signal
to persist. Heal's write site keeps writing nulls, and a test pins the
gap (§Test plan 13). Pointer attribution for heal restatements is a
named follow-up.

### Quote rule

The pointer's `quote` slot holds a quote the engine has verified. The
rule, identical on both strategies:

- Grounding on and the verdict **grounded**: `quote` is the verdict's
  first retained quote (`verdict.retained[0]`), or null when `retained`
  is empty. The retained quote — not the model's raw `evidence[0]` — is
  the honest artifact: `checkGrounding` drops quotes shorter than the
  minimum length before checking, and it stores retained quotes in
  normalized, length-capped form (`grounding.ts:68-86`). Persisting
  `evidence[0]` could persist a quote nobody checked. The write sites
  already compute the verdict inline (`checkGrounding` at
  `ops/apply.ts:77`, `legacy.ts:161`); the change captures it so the
  pointer can read `retained`.
- Grounding on and the verdict missing or ungrounded: `quote` is null.
  The fact follows the existing draft path (`grounding.ts:92-112`); the
  pointer's `event_id` still persists, because the attribution is
  independent of the quote check.
- Grounding off: `quote` is null, even when the model returns evidence.
  An unverified quote must not ride provenance (rule 6). The model's
  `evidence` array continues to be validated and checked exactly as
  today; this release only decides what reaches the row.

### Pruned events

Prune hard-deletes event rows after the retention window (30 days by
default; `MaintenanceService.ts:254`, `EventRepository.ts:106-112`). The
pointer is a durable record of where the fact came from, and prune never
touches it:

- Prune deletes event rows only. It never rewrites, nulls, or follows
  `source_pointer`.
- Prune is watermark-guarded: under the ops and deferred strategies it
  deletes only events the librarian has already processed
  (`pruneThrough`, `EventRepository.ts:119-127`), so unprocessed events
  are retention-held, never deleted. The 30-day default retention is
  `pruneEventsAfter ?? 30` (`MaintenanceService.ts:254`).
- Reads never dereference the pointer. No read path joins `events` on
  it, so a pruned target cannot fail a read.
- A pointer to a pruned event means: "this fact came from the event with
  this id; the event's text is gone." The pointer keeps its value as
  provenance even when the target is gone. A dump taken before prune
  preserves both sides: export round-trips events
  (`ImportExportService`, bundle includes `events`), so a restored dump
  keeps pointer and text together.

### Reads

`WikiFact` gains an optional `source_pointer?: WikiSourcePointer | null`,
and `mapRowToFact` (`EntryRepository.ts:55-127`) returns the column.
The field is optional, not required, because `WikiFact` is an exported
type that host and engine code constructs as object literals
(`rememberInput.ts:66`, `TemporalService.ts:65-73`, the heal literal at
`MaintenanceService.ts:1268`); a required field would be a source-level
break for every one of those literals, which rule 2's additive posture
forbids. The engine's librarian write sites set the field explicitly;
an omitted field stores null. Every
read and search surface that returns full facts then carries the
pointer. No new read API is added, and no read dereferences the pointer.

### Export, import, and OKF

**OKF frontmatter.** `formatOkfBundle` emits a new optional
`source_pointer` key: a map with the four slots of §The pointer, and
only when the pointer is non-null; slots that are null are omitted from
the emitted map. `parseOkfBundle` reads the key back: a well-formed map
restores the pointer exactly; an absent key yields null; a malformed
value yields null. The parse is tolerant and carries no diagnostic —
the same posture as the existing optional frontmatter fields. The
existing `resource` (mapped from `source_ref`,
`formatOkfBundle.ts:61`/`:123`, `parseOkfBundle.ts:268`) and `sources`
(`okf_sources`) handling is untouched.

**Dump export and import.** `exportDump` round-trips the column
automatically once the fact type carries it. `importDump` validates: a
null pointer, or a pointer whose value matches the §The pointer shape,
imports as given; any other value imports as null and emits a
`source_pointer_invalid` diagnostic carrying the entry id and no fact
text. Import never rejects the fact over a malformed optional
provenance field. Provenance loss is reported; the fact is not dropped
(rule 6).

### Diagnostics

Two new codes join `WikiDiagnosticCode`
(`packages/core/src/types.ts`), both severity `warn`, both content-free
(detail carries identifiers and reason slugs, never fact text — the
existing `WikiDiagnosticDetail` discipline):

- `source_pointer_unresolved` — the model named a pointer and the engine
  could not resolve it. Detail: `itemIndex` (the fact's index in the
  response, reusing the `fact_rejected` convention) and `reason` with
  values `'missing'` (the field is absent; ops only, because the ops
  contract requires it) or `'unknown_label'` (the field is present but
  is not a string naming exactly one batch label). One diagnostic per
  affected fact, on the existing diagnostics channel.
- `source_pointer_invalid` — import met a malformed pointer value and
  nulled it. Detail: `entryId`.

### forget boundary

`forget({ sourceRef })` and `forget({ sourceHash })`
(`MaintenanceService.ts:607-694`) ignore the pointer entirely; they
keep their exact semantics. The issue asks whether librarian facts
should become removable by source; this release decides **no**: a
`forget({ eventId })` selector is new deletion semantics on a JSON
column, it is not in the ruled scope (persist, return on reads, carry
through export and import), and it is a small additive follow-up issue
that the pointer shape already supports. Nothing in this release blocks
it.

## Rejected alternatives

- **Reuse `source_ref` on librarian facts.** The `source_ref` machinery
  is ingest ownership, not generic provenance: the `entries_source_ref_idx`
  index (`schema.ts:43`), the `source_ref_index` table and its partial
  unique index enforce a re-ingest race invariant
  (`schema.ts:47-61`), and `forget({ sourceRef })` soft-deletes index
  rows as part of that contract (`MaintenanceService.ts:688-694`).
  Writing event ids into that column entangles librarian rows with
  ingest ownership. It risks collisions with host-chosen ref strings.
  It silently changes what `forget({ sourceRef })` deletes.
  The deletion capability it would buy is not in the ruled scope.
- **A list of pointers.** No producer names two events; the ops contract
  forbids it in prose ("the single event"). A list would ship unused
  shape that every reader, exporter, and importer must handle forever.
- **Adding `source_event` to `LIBRARIAN_SYSTEM_PROMPT`.** It would
  change prompts for legacy hosts without their consent and break the
  byte-identical upgrade posture ruled at #375. The legacy strategy is
  a compatibility path; the tolerant parse gets a pointer when a model
  volunteers one, at zero prompt cost.
- **Persisting the model's quotes without verification.** A quote
  nobody checked is a claim, not provenance. Persisting it would put
  model output in a field readers will trust (rule 6).
- **Riding `okf_sources`.** `okf_sources` is the OKF citation surface,
  and import populates it from footnote URLs
  (`parseOkfBundle.ts:249`). Engine-written provenance in the same
  field would mix two authors in one list with no way to tell them
  apart.

## Files touched

- `packages/core/src/db/schema.ts` — the `source_pointer` column and
  the new migration step that adds it (version 16; the schema currently
  runs through version 15). Additive; rule 2.
- `packages/core/src/types.ts` — `WikiSourcePointer`;
  `WikiFact.source_pointer` (optional); the two `WikiDiagnosticCode`
  entries; the new `entryId` key on `WikiDiagnosticDetail`
  (`factId`, `itemIndex`, and `reason` already exist there).
- `packages/core/src/services/librarian/ops/extract.ts` — resolve the
  label to an event id on the candidate; emit the unresolved
  diagnostic on ops.
- `packages/core/src/services/librarian/ops/apply.ts` — write the
  pointer; quote by the quote rule; UPDATE leaves pointers untouched.
- `packages/core/src/services/librarian/legacy.ts` — tolerant parse,
  pointer write, quote by the quote rule, diagnostic on unknown label
  only.
- `packages/core/src/repositories/EntryRepository.ts` — `mapRowToFact`
  returns the column; upsert writes it.
- `packages/core/src/services/MaintenanceService.ts` — the heal pass's
  fact literal sets `source_pointer: null` explicitly, stating the
  non-goal in code; no attribution logic is added (§Heal restatements).
- `packages/core/src/services/ImportExportService.ts` — round-trip; the
  import validation and the `source_pointer_invalid` diagnostic.
- `packages/core/src/utils/formatOkfBundle.ts` and
  `packages/core/src/utils/parseOkfBundle.ts` — the frontmatter key.
- `INTENT.md` — rule 5's Planned note updates to point at the shipped
  behavior (rule 10: in the same pull request).
- `docs/ROADMAP.md` — step 3 receives its Done line in the pull request
  that completes the step (the ROADMAP's own done-mark rule).
- README and docs site — the provenance section documents the pointer,
  latest version only. `CHANGELOG.md` rides release tooling and is
  never hand-edited.

## Test plan

All tests are zero-token and deterministic, in
`packages/core/__tests__/`. No prompt text changes anywhere in this
release, so the existing golden fixtures from #375 and #376 stay
byte-identical and double as the parity gate.

1. **Column and migration.** A fresh setup has the column; running the
   new step (version 16) on a database at the previous version (15)
   adds it; every pre-existing row reads `source_pointer` as null.
2. **Ops pointer write.** A stub model response names the second event
   of a three-event batch; the stored row carries that event's id; a
   read returns it.
3. **Ops diagnostics.** A missing `source_event` emits
   `source_pointer_unresolved` with reason `'missing'`; an unknown
   label emits it with reason `'unknown_label'`; a non-string value
   emits it with reason `'unknown_label'`; detail carries
   `itemIndex` and no fact text; pointer null in all three cases.
4. **Legacy prompt parity.** With a stub returning facts without
   `source_event`, the built legacy prompt is byte-identical to
   today's (golden strings captured from the unmodified code), the
   pointer is null, and no diagnostic fires.
5. **Legacy tolerant parse.** A stub returns `source_event` naming a
   batch label; the pointer persists; an unknown label on legacy emits
   the diagnostic. This test exercises the tolerant read directly;
   no shipped legacy prompt elicits the field, so on default hosts the
   pointer stays null (§Legacy path).
6. **Quote rule.** Grounding on and grounded: `quote` equals
   `verdict.retained[0]`. A short first evidence quote that grounding
   never checks stays out of the pointer. Grounding on and missing:
   `quote` null, draft path fires, `event_id` still set. Grounding off
   with model-supplied evidence: `quote` null.
7. **UPDATE boundary.** An ops UPDATE over an existing
   `librarian_inferred` fact with a pointer leaves the pointer
   byte-identical.
8. **Dump round-trip.** `exportDump` then `importDump` restores the
   pointer exactly. An import payload with a malformed pointer nulls it
   and emits `source_pointer_invalid` with the entry id; the fact
   itself still imports.
9. **OKF round-trip.** `formatOkfBundle` emits the key only for
   non-null pointers and omits null slots; `parseOkfBundle` restores
   the pointer exactly; a bundle without the key parses to null; a
   malformed key parses to null.
10. **Prune semantics.** Run prune past the retention window; the
    surviving fact's pointer is unchanged; reads over the pruned store
    succeed with no event join.
11. **forget boundary.** `forget({ sourceRef })` on an ingest ref does
    not touch librarian rows carrying only a pointer; `forget` by
    entry id still removes such rows.
12. **Entity isolation.** The pointer only ever carries an event id
    from the same entity's batch; a test asserts no cross-entity id can
    reach a pointer (rule 3).
13. **Heal gap pinned.** A heal restatement writes a librarian fact
    whose pointer is null and emits no source-pointer diagnostic; the
    documented gap stays observable.

## Release

Minor; expected 9.1.0. This release builds on 9.0.0, which merged
before this ladder ran; the legacy goldens in test 4 pin the
post-9.0.0 prompts, and the `prompts.librarianSystemPrompt` override
that 9.0.0 removed is not part of any parity claim. The column, the
diagnostic codes, the OKF key, and the TypeScript type are additive
(rule 2); the new `WikiFact` field is optional, so no host literal
breaks (§Reads). No prompt text changes,
so model behavior is unchanged for every host. The new diagnostics
report cases that were silent before — a rule 6 improvement, not a
behavior change. No BREAKING CHANGE footer.

## Non-goals

- Pointer attribution for heal restatements (§Heal restatements; named
  follow-up).
- A `forget({ eventId })` selector (named follow-up; the pointer shape
  supports it).
- A host-supplied ref channel (no producer exists; the source store,
  roadmap step 4, revisits how sources are named).
- Position persistence (no producer; the slot stays null).
- The source store in the engine (roadmap step 4).
- Backfilling pointers onto facts stored before this release (no
  producer existed for them; null is the honest value).
- Curated Thoughts (the Rust twin adapts after the engine ships; its
  prompts are its own).
