# Spec: Ontology curation — machine typing, choke-point matching, and type-curation receipts

**Status: Draft, 2026-11-20. Lane 2 E+ (lands alone or first; shares `IngestionService` regions with 7b-ingest).**
**Revisions:** 2026-11-20 T1.5 self-review fold: stale open questions closed by R-MAINT-TYPING and R-EDGE rulings (new section 11, PR 4 boundary entry); appendix prompt wording aligned to the ruled quote; non-strict person-door miss behavior stated; release-surface claim corrected.
2026-11-20 T3 gate fold (Opus, $0.45, REQUEST CHANGES → folded): receipt mechanism pinned (`validateAndNormalizeFact` widened return, per-emitter mode gates); all four merge callers emit rejections; person-door `node_type_dropped` contradiction resolved; audit-join claim limited; lint matching pinned to the normalized resolver; section 11 build decisions pinned (`'typing'` job, default list, locking, pending check, budget unit, report fields); files-touched and test plan extended to match.
**Base: `origin/main` @ `e43095c8`. Every pin below was re-verified live against `e43095c8`.**  
**Intent check:** implements the owner-approved D1 block of the Lane 2 ontology consult (rulings session 2026-11-20; approved text in
`records/investigations/2026-11-20-lane2-ontology-strict-consult/memo-r3.md` §D1, as amended by ADJUDICATION-r3a.md and ADJUDICATION-r3b.md).
The owner ruled machine curation (OI-2). Models decide types. Deterministic
code only checks them against the manifest. Receipts let a person audit.
No host-declared alias tables; owner ruled them out for this cycle.

## Problem

The engine types facts by ontology manifest, but it curates badly in four ways:

- The strict prompt tells the model to omit a type when nothing fits
  (`packages/core/src/prompts/ontology.ts:22`). With broad manifests, "animal
  → thing" is the correct answer, and the wording works against it. The
  backfill prompt repeats the same instruction
  (`packages/core/src/prompts.ts:64`).
- Edge-type matching has a second, unguarded door. `upsertGraphCore` matches
  edge types inline instead of through `resolveEdgeDefinitions`
  (`packages/core/src/services/IngestionService.ts:719-722`), so the two
  doors can disagree.
- The engine drops silent gaps. A full re-ingest by `sourceRef` soft-deletes
  prior facts and their edges, then writes nothing, with no receipt when the
  new run yields zero facts (`packages/core/src/services/IngestionService.ts:745-750`).
  Emergent proposals are silently discarded by the merge loop
  (`packages/core/src/utils/ontology.ts:175-247`). Partial ingest writes
  `okf_type: null` for every fact and resolves no edges
  (`packages/core/src/services/IngestionService.ts:1036`), although the full
  path types and resolves (`packages/core/src/services/IngestionService.ts:864`).
- The typing queue never expires stale work. `findUntypedByEntityId` filters
  on `deleted_at` only, so soft-deleted-row survivors pile up as untyped
  candidates forever (`packages/core/src/repositories/EntryRepository.ts:1805-1808`).

## Root cause

Node types resolve through one choke point. `validateAndNormalizeFact` calls
`resolveNodeType` and throws only under strict
(`packages/core/src/services/OntologyService.ts:103-128`), and every typing
door already calls it (`RememberService.ts:29`, `IngestionService.ts:646`,
`IngestionService.ts:864`, `librarian/ops/apply.ts:106`,
`librarian/legacy.ts:156`, `MaintenanceService.ts:2425`).

`resolveNodeType` matches one way: exact slug, case-insensitive
(`packages/core/src/utils/ontology.ts:17-23`). `relates_to` never matches a
manifest that declares `relates-to`. The same one-way matching lives in
`resolveEdgeDefinitions` (`packages/core/src/utils/ontology.ts:24-30`).

The engine has no receipt vocabulary for type outcomes. Existing diagnostics
report classifier rejects and overflow only
(`packages/core/src/services/MaintenanceService.ts:2334-2343`), and edge
drops carry slugs only
(`packages/core/src/utils/ontology.ts:243-254`). A host cannot audit which
type the machine folded where.

## Proposed change

### 1. One matching order inside the choke points

Extend both resolvers in `packages/core/src/utils/ontology.ts`:

- `resolveNodeType` (`:17`): try exact case-insensitive slug first. Then try
  a separator-and-case-normalized match (`_`, `-`, and whitespace collapse
  to one canonical form). Accept the normalized match only when exactly one
  manifest entry matches.
- `resolveEdgeDefinitions` (`:24`): the same two-step order, returning the
  unique normalized match when the exact pass misses.

Constraints, both hard:

- Normalized matching must never throw on an existing manifest.
  `validateManifest` runs on every manifest read
  (`packages/core/src/repositories/MetadataRepository.ts:273`), and a throw
  there makes the entity unreadable. Normalization resolves only on a unique
  match; ambiguity returns null, never an error.
- Normalization must never change a slug that a person stored. It only maps
  a model's spelling to the manifest's spelling.

### 2. Close the edge door

`upsertGraphCore` must resolve edge types through `resolveEdgeDefinitions`
instead of its inline filter
(`packages/core/src/services/IngestionService.ts:719-722`). Behavior stays
the same when the exact match hits; it gains the normalized fallback.
Strict-mode edge throws keep their existing shape
(`packages/core/src/services/IngestionService.ts:724-725`).

### 3. Doors and throws stay split by writer

The rule from the ruling block, unchanged by this PR:

- A door where a person or the host supplies the type — `remember`
  (`RememberService.ts:29`), `upsertGraph` nodes
  (`IngestionService.ts:646`), and `supersede` once PR 4 adds a type
  parameter — throws when the normalized type misses the manifest.
- A door where a model supplies the type — ingest full and partial,
  librarian (`ops/apply.ts:106`, `legacy.ts:156`), backfill
  (`MaintenanceService.ts:2425`) — never throws on a type. It stores the
  fact untyped, keeps it in the typing queue, and reports it.

The engine never replaces a type a person stated. Backfill already never
overwrites (`EntryRepository.ts:1836` guards `okf_type IS NULL`). In the
non-strict modes, a person-door miss stores the fact untyped and emits
`node_type_dropped`; it never throws.

### 4. Receipts at every type door

Receipts ride the existing diagnostic channel: `DiagnosticBuffer.push` plus
`flush` after commit (`packages/core/src/utils/diagnostics.ts:162-176`),
mirroring the backfill pattern
(`packages/core/src/services/MaintenanceService.ts:2332-2348`). All are
content-free — slugs and ids only, each slug capped at 64 characters — and
all are emitted only when the entity's ontology mode is not `'off'`
(`MaintenanceService.ts:2071-2074` gives the mode check).

New codes on `WikiDiagnosticCode` (`packages/core/src/types.ts:872`):

- `node_type_dropped {factId, nodeType, reason}` — at every type door,
  model- or person-supplied, when the type misses the manifest.
- `node_type_folded {factId, from, to, via: 'normalize'}` — when step 1
  changed the slug. Extraction-time folds are self-contained rows (`from`,
  `to` on the receipt). The `factId` join to `node_type_assigned`
  reconstructs the audit only for facts a later backfill types; the spec's
  audit claim is limited to that pair.
- `node_type_assigned {factId, okfType, writer, confidence?}` — whenever
  typing happens after the fact was written. `writer` is
  `'classifier' | 'llm' | 'inherited'`. `'inherited'` fires only in PR 4.
- `ontology_update_rejected {reason}` — one per emergent proposal the merge
  drops, including the strict-mode blanket rejection.
- `ingest_zero_facts {sourceRef, chunks}` — when a full re-ingest by
  `sourceRef` soft-deletes prior facts and edges and then writes zero facts
  (`IngestionService.ts:745-750` is the exact site). Operation: `'ingest'`.

Mechanism: `validateAndNormalizeFact` returns only
`{okf_type, edges}` today (`OntologyService.ts:103-128`), so it cannot feed
a receipt. Widen its return to also carry
`match?: { raw: string; canonical: string; via: 'exact' | 'normalize' }`;
on a miss, `match` is absent. Each emitter compares or reads `match` from
that one shared check; callers do not re-run resolution. Ingest and
remember do not check the mode today, so each emitter performs its own
mode≠`'off'` gate before pushing a receipt; the shared check stays
mode-free.

`classification_abstained` is S1-0's code (see boundary section). This PR
wires no abstain mechanics.

### 5. Emergent-rejection reporting

`mergeOntologyUpdates` drops bad proposals silently today
(`packages/core/src/utils/ontology.ts:175-247`). Change the return to carry
rejections alongside the merged manifest, without changing what merges:
same first-seen-wins node loop, same edge-triple dedupe, same parent gate.
All four merge callers emit `ontology_update_rejected {reason}` for each
rejected proposal: ingest (`IngestionService.ts:855`), backfill
(`MaintenanceService.ts:2401`), librarian legacy (`librarian/legacy.ts:112`),
and librarian ops (`librarian/ops/apply.ts:92`). The merge runs only in
`'emergent'` mode, so the caller produces the receipt, not the merge
helper. In strict mode the caller never reaches the merge; it emits one
`'mode_strict'` receipt per proposal and drops them. The return-shape
change travels through `MetadataRepository.mergeManifestUpdates`
(`packages/core/src/repositories/MetadataRepository.ts:312-321`).

### 6. Partial ingest types and resolves

`appendPartialFacts` must type facts against the current manifest and
resolve edges against the title index, exactly as the full path does
(`IngestionService.ts:860-868` is the pattern; `IngestionService.ts:829-836`
shows the title-index build). This is safe: the next full run hard-deletes
edges whose source facts it retires
(`IngestionService.ts:749-750`, `packages/core/src/repositories/EdgeRepository.ts:98`). Partial ingest
never merges emergent updates; it types against the manifest as it stands.

### 7. Recheck option, no automatic reset

Add a `runOntologyBackfill({ recheckCheckedBefore })` call option.
`doRunOntologyBackfill` computes its cutoff from the fixed constant today
(`packages/core/src/services/MaintenanceService.ts:2062`,
`ONTOLOGY_BACKFILL_RECHECK_MS` at `MaintenanceService.ts:50`). A host that
edits a manifest passes an old cutoff to re-queue already-checked facts.
Default stays the constant, so no host sees new spend. Validate like
`batchSize` does: a non-integer or negative value throws
(`MaintenanceService.ts:2056-2059` is the precedent).

### 8. Typing queue sees current facts only

`findUntypedByEntityId` must also exclude facts whose validity window is
closed, the same live-mode filter reads use
(`packages/core/src/utils/temporal.ts:14-18`,
`packages/core/src/services/RetrievalService.ts:169-170` are the pattern).
Soft-deleted facts stay out through the existing `deleted_at IS NULL` guard
(`EntryRepository.ts:1806`).

### 9. Lint counts node-type violations

`LintService.lint` (`packages/core/src/services/LintService.ts:19-50`) now
also counts live facts whose stored `okf_type` is not in the effective
manifest, plus up to 20 sample ids, mirroring the edge-violation scan
(`LintService.ts:29-42`). Add `nodeTypeViolations` and
`nodeTypeViolationIds` to `WikiLintReport`
(`packages/core/src/types.ts:1693-1708`). Untyped facts stay in the existing
`untypedFacts` count; the new count is wrong-type facts only. A stored
slug counts as "in the effective manifest" when the normalized resolver
resolves it — the same matching the type doors use (section 1), never an
exact-only check.

### 10. Prompt amendments (both prompts, no accuracy claim)

- Strict appendix rule (`packages/core/src/prompts/ontology.ts:22`) changes
  to: choose the closest type the fact is an example of; omit only when
  none applies even broadly.
- Backfill system prompt line (`packages/core/src/prompts.ts:64`) gets the
  same instruction.
- Ontology appendix field block (`packages/core/src/prompts/ontology.ts:3-7`)
  adds, with the ruled wording: "Each node is a fact. To link two things with
  an edge, each must exist as its own fact, titled by the same name you use
  in `target_title`."
- No claim of accuracy improvement accompanies this change (rule 11). The
  statement-kinds bench reports regressions only; it does not gate this PR.

### 11. Typing joins runPendingMaintenance (ruled)

The owner ruled this (R-MAINT-TYPING, handoff ruling ledger 2026-11-20). Typing
joins the `runPendingMaintenance` job set for entities whose ontology mode is
not `'off'`, inside the host-passed token budget. Nothing triggers typing on a
write. The release notes state both facts.

Build decisions (this spec pins them so an implementer invents nothing):

- The new job is `'typing'`. `MaintenanceJob` is a closed four-member
  union today (`packages/core/src/types.ts:1729`); add `'typing'` as a
  fifth member. `'typing'` is lockable, so `LockedMaintenanceJob`
  (`types.ts:1732`) keeps it (unlike `'externalDeletions'`). Update the
  `jobs` doc comment that says "Default all four" (`types.ts:1759`) and
  add `'typing'` to the default list.
- Pending work: an entity counts as having pending typing when
  `findUntypedByEntityId` (section 8's filtered query) returns rows.
  `getPendingMaintenance` and `MaintenanceScheduler`
  (`packages/core/src/services/MaintenanceScheduler.ts`) check this before
  dispatching.
- A typing unit is one `runOntologyBackfill` batch for that entity,
  charged against the host-passed `tokenBudget` with the existing
  per-batch cost estimate (`MaintenanceService.ts:2056-2059` is the
  `batchSize` precedent the option rides).
- `EntityMaintenanceReport` (`types.ts:1769+`) gains `typed: number` (facts
  typed in the pass) and `untypedRemaining: number`.
- Files touched beyond `MaintenanceService.ts`:
  `services/MaintenanceScheduler.ts`, `WikiMemory.ts`, `types.ts`.

## Cross-PR boundaries (stated, not absorbed)

- **S1-0** owns the typing-mode resolution chain in
  `packages/core/src/utils/engineDefaults.ts` (the `warnChangedDefaultsOnce`
  pattern at `engineDefaults.ts:54-67` is its precedent), the
  `minConfidence` floor that today is read ad hoc
  (`MaintenanceService.ts:2252-2253`), `systemOne.onLowConfidence`, the
  abstain SENTINEL mechanism (chosen at question build, offered in the
  options at `classifier.ts:32`, caught pre-accept near
  `MaintenanceService.ts:2295-2296`, cap 254 + sentinel at
  `MaintenanceService.ts:2089`), and the `classification_abstained` receipt
  for the generative path's silent omissions
  (`MaintenanceService.ts:2163-2177` counts them only in `scanned`).
- **PR 4** owns supersede edge-copy, the inbound-edge index, the
  `writer: 'inherited'` assigned receipts, host `supersede()` accepting a
  type, outbox prior-text receipts, and `librarian.destructiveEdits: 'retain'`.
  PR 4 also owns the ruled R-EDGE extension of edge-follow to re-ingest by
  `sourceRef` (normalized-title match, plus a receipt).
- **PR 6** owns heal per-fact receipts and any heal "replaces" link.
- **PR 5b** owns `typeOnWrite` and receipts on its door, only after an edge
  path exists.
- **importDump stays verbatim.** Import restores `okf_type` as stored
  (`packages/core/src/services/ImportExportService.ts:483`). It must not
  re-judge types; section 9's lint count is the mismatch report. Manifest
  and mode travel with dumps (ruled; rule 13).

## Files touched

- `packages/core/src/utils/ontology.ts` — normalized matching in both
  resolvers; merge rejections.
- `packages/core/src/services/OntologyService.ts` — `validateAndNormalizeFact`
  return widening (section 4 mechanism); mode-free shared check.
- `packages/core/src/services/RememberService.ts` — receipt emission at the
  remember door.
- `packages/core/src/services/librarian/legacy.ts`,
  `packages/core/src/services/librarian/ops/apply.ts` — receipt emission at
  the librarian merge callers (sections 4 and 5).
- `packages/core/src/repositories/MetadataRepository.ts` — return-shape
  passthrough for merge rejections (section 5).
- `packages/core/src/services/IngestionService.ts` — edge door via
  `resolveEdgeDefinitions`; `ingest_zero_facts`; partial-ingest typing.
- `packages/core/src/services/MaintenanceService.ts` — `recheckCheckedBefore`
  option; new receipt emissions in the backfill apply path; the `'typing'`
  job in the `runPendingMaintenance` job set (section 11).
- `packages/core/src/services/MaintenanceScheduler.ts` — pending-typing
  check and dispatch (section 11).
- `packages/core/src/WikiMemory.ts` — `'typing'` in the public maintenance
  surface (section 11).
- `packages/core/src/repositories/EntryRepository.ts` — current-facts queue
  filter.
- `packages/core/src/services/LintService.ts` — node-type violation count.
- `packages/core/src/types.ts` — new diagnostic codes; `WikiLintReport`
  fields; `RunOntologyBackfillOptions` option.
- `packages/core/src/prompts/ontology.ts`, `packages/core/src/prompts.ts` —
  prompt wording.
- Unit tests beside each; integration tests for the receipt surfaces.

## Test plan

1. Resolver tests: exact hit wins; unique normalized hit folds; ambiguous
   normalized query returns null; no case where normalization throws on any
   valid manifest.
2. Door tests: each type door, model- and person-supplied, stores an
   untypable fact untyped and emits `node_type_dropped` in non-strict
   modes; `remember` and `upsertGraph` still throw under strict; neither
   throws in emergent mode.
3. Receipt tests: `node_type_folded` fires once per fold; for a fact a
   later backfill types, the `factId` join between `dropped` and
   `assigned` reconstructs the audit; receipts suppress in mode `'off'`.
4. Merge-rejection tests: all four callers emit `ontology_update_rejected`;
   a strict-mode caller emits one `'mode_strict'` receipt per proposal.
5. Zero-fact ingest test: re-ingest a `sourceRef` whose new run extracts
   nothing; prior facts tombstone, receipt fires with chunk count.
6. Partial-ingest test: chunk-failure path now stores typed facts with
   resolved edges; a following full run retires and hard-deletes them.
7. Recheck test: `recheckCheckedBefore: 0` re-queues a checked fact; the
   default call does not; invalid values throw.
8. Queue test: an expired fact leaves the typing queue; a live fact stays.
9. Lint test: a fact typed with a slug later removed from the manifest is
   counted and sampled; untyped facts stay out of the new count.
10. Prompt tests: both prompts carry the amended instruction verbatim; the
    appendix carries the facts-not-entities sentence.
11. Maintenance-set test: `runPendingMaintenance` types a mode≠`'off'`
    entity inside the host-passed budget; a write triggers no typing.
12. Full suites: `pnpm --filter @equationalapplications/core-llm-wiki test`
    must pass.

## Rejected alternatives

- **Host-declared alias tables.** Owner ruled machine curation: the work
  must not fall on the host. "Not planned; reopen if a host asks."
- **Embedding-based slug matching.** It needs `embed`, which is optional,
  and it sees only the slug while the backfill sees the fact's text.
- **Untyped fact becomes a draft.** Under machine curation an untyped fact
  waits for the machine, not for a person. The receipt satisfies rule 6.
- **importDump re-judging types against the live manifest.** A dump records
  earlier decisions; judging them again changes the archive. Lint reports.
- **Reserving the abstain slug in `validateManifest`.** It runs on every
  read; a collision would make the entity unreadable. S1-0 chooses the
  sentinel at question build instead.

## Out of scope (owned elsewhere)

S1-0's resolution chain, floor, `onLowConfidence`, and abstain mechanics;
PR 4's supersede edge-copy, index, inherited receipts, prior-text outbox,
`'retain'`; PR 6's heal receipts; PR 5b's `typeOnWrite`. Where this PR and
another touch the same file, the sections above name the owner of each
region. A host verb to set a type (`setOkfType`) is a low-priority
follow-up, derived from R-TRUST + OI-2, not asked for here.

## Open questions for the owner

1. Confirm the extractor `okf_label` follow-up (capture the model's own
   word so extraction-time folds become visible). Deferred here by ruling;
   say if it should move into this cycle.

Former questions 1 and 2 are closed: the owner ruled them (R-MAINT-TYPING
and R-EDGE, handoff ruling ledger 2026-11-20). Section 11 and the PR 4
boundary entry carry them.

## Release surface

Additive public surface (one call option, new diagnostic codes, new lint
fields) plus behavior changes behind host-configured ontology modes.
MINOR release. Hosts with ontology `'off'` see no change: every new receipt
and fold gates on the mode check
(`MaintenanceService.ts:2071-2074`). The section 8 queue filter does not
gate on the mode; it removes dead rows for every host. Typing in
`runPendingMaintenance` (section 11) is the one new automatic behavior; the
release notes carry it.
