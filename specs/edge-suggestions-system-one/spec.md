# Spec — Step 10: Edge suggestions from System-One

Status: Draft 2026-11-22 — pending owner approval; owner ruling 2026-11-22
msg 1574082000854188136 (reply '1' to the presented menu): **classifier-first** —
the small classifier starts proposing/screening edges, gated by a confidence
floor (`minConfidence.edges`, the exact shape S1-0 reserved), falling back to
the generative model when the classifier is missing or below floor — because
step 11 uses this identical pattern in its own wording, and S1-0 reserved
`edges` as a threshold site, not a switch.
Base: origin/main @ `c0aa79e3`. Every pin below re-verified live against the
worktree (line numbers match origin/main). Repo: expo-llm-wiki. Product
rule: hosts bring their own models; core stays unopinionated about providers.

## Problem

The ontology-backfill generative path proposes edges
(`packages/core/src/services/MaintenanceService.ts:2343-2350` parses
`classifications[].edges`; `_applyOntologyBackfillBatch` validates, stages,
and persists them at `:2719`, `:2734`, `:2779-2781`, `:2786-2791`), but the
classifier path proposes none (`MaintenanceService.ts:2469`;
`packages/core/src/config/systemOne.ts:17`), and no host knob engages,
tunes, or floors classifier edge proposal. Roadmap step 10 says the
edge-suggestion site "opts in to the configured model" (`docs/ROADMAP.md:262-267`),
and step 11 states the target pattern outright: when the configured model is
unavailable or below threshold, the fact falls through to the generative
path. The S1-0 spec reserved exactly one new `'edges'` line in
`SystemOneThresholdSite` for this PR (`specs/system-one-config/spec.md:67-71`)
and fenced `edges (PR 3)` out of S1-0 (`spec.md:265-272`) — as a *threshold
site*: `systemOne.minConfidence` is already
`Partial<Record<SystemOneThresholdSite, number>>` (`systemOne.ts:21-22`), so
the union member exists to carry a floor, not a boolean switch. No
`systemOne.edges`-adjacent key exists today.

## Root cause with evidence

- `SystemOneThresholdSite` is `'typing'` only
  (`systemOne.ts:12`); the docstring already promises `'edges'` as a
  one-line sibling addition (`systemOne.ts:5-6`).
- The classifier machinery for a screen already exists end to end:
  `resolveSystemOneTyping` gates the classifier step on an explicit config
  key, never on capability alone (`MaintenanceService.ts:2161-2167`,
  REQ-COMPAT-01.5 at `packages/core/src/types.ts:812`); the step asks one
  `ClassifyRequest` per fact (`MaintenanceService.ts:2518-2522`), validates
  answers as untrusted via `validateClassifierAnswer`
  (`packages/core/src/utils/classifier.ts:20`), compares a resolved floor
  with the abstain sentinel checked BEFORE the confidence comparison
  (`MaintenanceService.ts:2534-2542`), and hands accepted classifications to
  the same `_applyOntologyBackfillBatch` the generative path uses
  (`:2573-2579`, writer `'classifier'`).
- `ClassifyRequest` is "one state evaluated against a map of questions"
  (`types.ts:824-828`) — many questions per call is already the shape.
  A per-candidate-target `binary` question (`types.ts:821`,
  answer `{probability}`, `types.ts:832`; validated at
  `classifier.ts:44-47`) gives each screened edge a single number to floor.
- The generative output schema carries **no confidence**
  (`packages/core/src/prompts.ts:61-63` — `classifications` entries are
  `{id, okf_type, edges}` only), so the generative path cannot be floored;
  it is the fallback, not the gated path.
- Candidate targets for a choice/binary classifier must be presented, not
  invented: the title index (`MaintenanceService.ts:2711-2715`,
  `findTitleIndexByEntityId`) is the resolvable pool, and the step-8
  per-fact shortlist already ranks it per fact
  (`specs/shortlist-recall`, `specs/backfill-shortlist-wiring`; consumed by
  the generative prompt at `MaintenanceService.ts:2330-2335`; size bounded
  by `resolveShortlistK`, default 10, `packages/core/src/utils/engineDefaults.ts:154-171`).
- Edge validation is site-independent and already strict:
  `validateInlineEdges` (`packages/core/src/utils/ontology.ts:337-353`) and
  `OntologyService.resolveEdges`
  (`packages/core/src/services/OntologyService.ts:157-212`), drops surfaced
  as `edge_dropped` diagnostics (`packages/core/src/utils/diagnostics.ts:23`,
  `:78`, `:288`); persistence is additive via `addIgnoreDuplicate`
  (`OntologyService.ts:214-237`).
- `_applyOntologyBackfillBatch` has TWO callers — generative at
  `MaintenanceService.ts:2379` (`'llm'`) and classifier at `:2573-2579`
  (`'classifier'`); `doRunOntologyBackfill` never calls it directly. Any
  floor/mode plumbing must be explicit at both paths; `runOpts` required
  fields are asserted at `:2269-2279`, and `_runGenerativeBackfill` is
  called from the escalation leg (`:2201-2209`) and the first pass
  (`:2231-2238`).
- Other edge-producing sites (ingest `IngestionService.ts:217-218`,
  `:876`, `:953-963`; librarian ops `extract.ts:271` → `apply.ts:108-240`;
  librarian legacy `legacy.ts:78-82`) share the host provider and read no
  `systemOne.*`. Heal is not an edge site (R-EDGE: heal waits PR 6
  replaces-link).

## Proposed change

### 1. One new line in `SystemOneThresholdSite`

`systemOne.ts:12` becomes:

```ts
export type SystemOneThresholdSite = 'typing' | 'edges';
```

Exactly one new member, exactly per the S1-0 merge fence
(`specs/system-one-config/spec.md:67-71`). This is type-level surface so
`minConfidence` stays closed under the site union — and unlike a
switch-first design, the member immediately GAINS its consumer: the
`minConfidence.edges` floor of §3.

### 2. Engagement key `systemOne.edges: 'auto' | 'llm'`

Add to `SystemOneConfig` (`systemOne.ts:14-31`, beside `typing`):

```ts
/**
 * Edge mode for ontology backfill. `'llm'` (default) keeps edge proposal
 * on the generative path exactly as today. `'auto'` engages the classifier
 * edge screen (§4) when the classifier step runs; facts the classifier
 * cannot commit above the floor fall through to the generative step of the
 * same pass (§5). There is no `'off'`: this PR adds no configuration that
 * can silently discard a model-proposed edge.
 */
edges?: 'auto' | 'llm';
```

Resolution: `resolveSystemOneEdges(config)` in `engineDefaults.ts`, returning
`config?.systemOne?.edges ?? 'llm'`; a present non-`'auto'`/non-`'llm'`
value warns once via the existing `warnOnce` helper
(`engineDefaults.ts:89-93`) and is treated as unset — the S1-0 §2
treated-as-unset contract, mirroring `resolveSystemOneTyping`
(`engineDefaults.ts:122-152`). Rationale for reusing typing's exact
vocabulary: capability alone never switches paths (`types.ts:808-815`),
default `'llm'` keeps every host without the key byte-identical (§8), and
one shared mental model covers both sites. No call option — edge mode is a
config-level stance, not per-call tuning. No `'off'`: see §7.

### 3. Floor `minConfidence.edges`

Add `resolveEdgesMinConfidence(config)` in `engineDefaults.ts`:
`systemOne.minConfidence.edges` → default `0.5` (same default constant
discipline as typing, `engineDefaults.ts:174`; validated by the existing
`isConfidenceFloor`, `engineDefaults.ts:112-113`; invalid values warn once
and are treated as unset, mirroring `resolveTypingMinConfidence`,
`engineDefaults.ts:182-200`). There is no legacy `ontology.*` chain for
edges — none exists to preserve. This is the consumer the `'edges'` union
member was reserved for; the old "dead config" footgun (a set
`minConfidence.edges` with no reader) does not exist in this design.

Floor semantics: the floor applies to the classifier's per-edge answer
confidence (the binary `probability`, §4). At or below floor → that FACT's
edges fall through to the generative step of the same pass (§5) — the exact
step-11 pattern ("when the configured model is unavailable or below
threshold, the fact falls through to the generative path"), applied at
per-fact granularity. Validation precedes the floor comparison, mirroring
`:2534-2542` ordering: `validateClassifierAnswer` runs first
(`classifier.ts:20`); an invalid answer is never floored, it falls through
(§6).

### 4. The classifier edge screen (question shape — recommendation)

**Recommendation: per-fact `binary` screening questions over the per-fact
shortlist; no new provider method and no new question kind.**
`ClassifyRequest` already carries a map of questions per state
(`types.ts:824-828`), so the edge screen rides the SAME one-call-per-fact
request the typing question rides today (`MaintenanceService.ts:2518-2522`):

- Questions: for each manifest edge type and each of the fact's ranked
  shortlist candidates, one `binary` question keyed
  `edge:<edge_type>:<targetFactId>` with instructions naming the edge type
  and the candidate. The answer's `probability` is the confidence the §3
  floor compares.
- Candidates: the same ranked per-fact shortlist the step-8 generative
  prompt consumes (`specs/backfill-shortlist-wiring`; k bounded by
  `resolveShortlistK`, `engineDefaults.ts:162-171`), computed in
  `_runClassifierBackfill` BEFORE the classify calls. Note the asymmetry
  with the generative path: the title index is built inside the batch tx
  (`MaintenanceService.ts:2711-2715`); the classifier screen must rank
  outside the tx, from the same repository read. A fact with zero
  candidates gets no edge questions and falls through to generative (§5) —
  a classifier can only pick from what it is shown, and generative can
  still reach same-response and catalog targets
  (`prompts.ts:120-139`).
- Why binary, not one big `choice`: a fact can carry several edges of
  different types; the `choice` shape returns exactly one choice per
  question (`types.ts:820`), so a choice-per-fact cannot express the
  multi-edge case, and a choice over the cross product would blow past
  `CLASSIFIER_MAX_CHOICES` (`MaintenanceService.ts:2173`). Binary per
  (edge type, target) is O(edgeTypes × k) questions in one already-existing
  call, keeps the abstain-sentinel machinery unnecessary (a "no" answer IS
  the decline), and gives a clean single number to floor.
- Accepted answers (probability ≥ floor) are converted, before
  `_applyOntologyBackfillBatch`, into ordinary
  `classifications[].edges` entries `{edge_type, target_title}` built from
  the candidate row (`MaintenanceService.ts:2562-2564` shape, now with
  `edges`), so the ENTIRE downstream pipeline is reused unchanged:
  `validateAndNormalizeFact` (`:2731-2738`), `pendingEdges` staging
  (`:2719`, `:2779-2781`), the two-phase `resolveAndPersistEdges` pass
  (`:2786-2791`), and `edge_dropped` diagnostics — the classifier is
  untrusted input to the same strict validation the generative model faces.
- Public surface: none beyond §1/§2. `ClassifyRequest`,
  `ClassifierQuestion`, and `LLMProvider.classify` (`types.ts:815`) are
  unchanged; hosts' existing classifiers answer binary questions already.

### 5. Fallthrough wiring (explicit at both call sites)

In `_runClassifierBackfill`, an outcome `edge_fallthrough` is produced when
a fact has any edge answer below floor, any invalid edge answer (§6), or no
candidates at all. `edge_fallthrough` facts join the escalation set —
UNconditionally, not gated by `onLowConfidence` (the step-11 fallthrough is
threshold behavior, not a cost posture; `onLowConfidence` stays a typing
routing knob, `MaintenanceService.ts:2248-2258`) — and are handed un-stamped
to the generative step of the same pass, exactly like typing escalations
today (`:2544-2550` collection, `:2201-2209` hand-off). Per-fact
granularity consequence, disclosed: a fact whose edges fall through also has
its typing re-decided generatively (it must stay untyped for the generative
step's `updateOkfType` `okf_type IS NULL` guard to fire; a classifier-typed
fact whose edges fell through would hit the `changes === 0` omission path at
`:2763-2766` and its edges would never be applied). Mixed
classifier-edges-for-some-facts/generative-for-others within one fact is
explicitly out of scope: one writer per fact's edges per pass.

Mode/floor plumbing is explicit, never defaulted: resolved ONCE per pass in
`doRunOntologyBackfill` beside the typing chain (`:2161-2165`), then
- passed into `_runClassifierBackfill` (beside the typing floor resolve at
  `:2487`), and
- added to `runOpts` for `_runGenerativeBackfill` at BOTH call sites — the
  escalation leg (`:2201-2209`) and the first pass (`:2231-2238`) — asserted
  like the existing required fields (`:2269-2279`), because the generative
  step itself needs no gate (it is the fallback and never floored) but the
  escalated set's composition depends on the screen, so the screen results
  must reach it coherently. `_applyOntologyBackfillBatch` keeps its two
  callers (`:2379`, `:2573-2579`) unchanged in signature.

### 6. Fallback accounting and receipts

- Counters need no new fields. Classifier-applied edges flow through
  `_applyOntologyBackfillBatch`, so `applied.edgesAdded` already lands in
  the classifier step's result (`:2584`), and the escalation counter-merge
  already sums `edgesAdded` across both steps
  (`MaintenanceService.ts:2215-2225`, at `:2219`). `failedValidation`
  counts classifier-side invalid edge answers where the fact did NOT fall
  through (there are none — invalid falls through, §5) and generative-side
  validation failures unchanged.
- Receipts: **no new diagnostic code in this PR.** Every model-proposed
  edge under this design reaches either the classifier validation pipeline
  (drops receipted as `edge_dropped`, `diagnostics.ts:78`, `:288`) or the
  generative fallback (same). No configuration introduced here can silently
  discard a proposed edge — there is no `'off'` mode (§2) and below-floor
  is a ROUTING decision whose destination still proposes. S1-0 §6's
  "omissions carry receipts" discipline is preserved vacuously: there is no
  omission. The previous draft's `edge_suggestion_suppressed` receipt is
  dropped as dead surface. The docstring invariants that DO change (§9) are
  the disclosed text updates.
- Ordering pin (carried from review m4): the unknown-or-duplicate-id
  continue at `:2723-2726` precedes the receipt region
  (`:2745-2753`) and both precede the edge staging/persistence — unchanged
  by this spec, but classifier-built classifications always match batch
  ids by construction (`:2562-2564`), so only the generative path can hit
  that continue.

### 7. Suppressed-edge receipts — decided: none

Superseding the previous draft's §4: the owner did not rule on receipts,
and this design picks the smallest surface. A receipt is warranted only
where a drop is config-driven and silent. Here no config can silently
discard a model-proposed edge: `'llm'` mode means the generative model
proposes (as today, nothing suppressed); `'auto'` mode routes below-floor
facts to generative, which proposes. If a future PR adds an `'off'` mode,
THAT PR adds the receipt with it.

### 8. Compatibility lock

With no `systemOne` keys (or with legacy typing resolving `'auto'` or
`'llm'` and no `systemOne.edges`): `resolveSystemOneEdges` returns `'llm'`,
the classifier step proposes no edges exactly as today, the generative path
is untouched, no new receipts fire, and behavior is byte-identical on every
path. Capability alone never switches paths (REQ-COMPAT-01.5,
`types.ts:812`). This spec adds no call options, no prompt changes, no
counter fields, and no scheduler changes. Engaging classifier edges requires
the host to set BOTH `systemOne.typing: 'auto'` (so the classifier step
runs at all, `MaintenanceService.ts:2167`) and `systemOne.edges: 'auto'`.

### 9. Disclosed docstring/spec-text updates

The classifier invariant "No edges are proposed" is no longer unconditional:

- `MaintenanceService.ts:2465-2473` (`_runClassifierBackfill` docstring):
  becomes "No edges are proposed unless `systemOne.edges` is `'auto'`;
  under `'auto'` the classifier screens per-fact edge questions against
  `systemOne.minConfidence.edges` and below-floor facts fall through to the
  generative step."
- `systemOne.ts:15-19` (`typing` docstring, "'auto' uses
  `llmProvider.classify` when present (no edges proposed)"): the
  parenthetical gains "unless `systemOne.edges: 'auto'`".
- `docs/ROADMAP.md` step 10 entry: filled with the landed design and its
  merged PR reference, per the roadmap's convention for Done entries.
- The `systemOne` rows in
  `apps/docs/src/content/docs/reference/configuration.md` and the
  ontologies guide gain `systemOne.edges` and `minConfidence.edges`.

## Explicitly out of scope / rejected alternatives

- Gating ingest fact-edges (`IngestionService.ts:953-963`) or librarian
  edges (`apply.ts:165`) — the S1-0 §10 fence (`spec.md:265-272`) plus the
  roadmap's singular "the edge-suggestion site" that "runs first among the
  site conversions" (`ROADMAP.md:262-266`) scope this PR to the backfill
  site; ingest/librarian are later site conversions. Carried as open
  question 1.
- A boolean kill-switch (the superseded draft). Rejected by owner ruling:
  S1-0 reserved `'edges'` as a threshold site; step 11's wording fixes the
  below-threshold-falls-through pattern; and a switch that discards
  classifier capability adds a suppression receipt surface this design
  does not need.
- A `choice`-shaped edge question or a new optional provider method.
  Rejected: cannot express multiple edges per fact within one
  `ClassifyRequest` cleanly, risks `CLASSIFIER_MAX_CHOICES` blowup
  (`MaintenanceService.ts:2173`), and widens the public provider surface
  for no gain over per-candidate binary questions (§4).
- An `'off'` mode. Rejected in this PR: it is a discard path, which drags
  in suppression receipts and a third resolver branch for a need no owner
  ruling expresses; `'llm'` already means "generative only".
- Any change to edge validation, `resolveEdges`, title-index construction,
  `ontology_updates` handling, or `runBatched`/the step-9 prompt cap —
  all site-independent mechanics stay untouched.
- Heal-path edges (R-EDGE: waits PR 6 replaces-link).
- Per-edge mixed attribution (classifier edges plus generative edges for
  the same fact in one pass) — one writer per fact per pass (§5).
- `ontology_updates.edge_types` proposals (manifest edge-type emergence) —
  a separate channel from per-fact edges; this PR does not touch the
  backfill `ontology_updates` path.

## Open questions for the owner

1. Scope: does the classifier edge screen cover only the backfill site, or
   also ingest/librarian fact-edges? **Recommendation: backfill only** —
   the §10 fence and "runs first among the site conversions" both point
   there; the other sites are later conversions with their own specs.
2. Cost posture: with `edges: 'auto'`, each classify call carries up to
   `manifestEdgeTypes × shortlistK` extra binary questions per fact
   (typed per-fact, `types.ts:824-828`). Accept the uncapped cost and
   measure, or cap edge questions per fact now? **Recommendation: no cap
   in this PR** — the shortlist is already k-bounded
   (`engineDefaults.ts:162-171`), classifier calls are metered separately
   from generative (`MaintenanceService.ts:2518-2522` rides the classify
   meter argument, `:2481`), and a cap would silently hide candidate
   targets, which for a screen is worse than cost. Revisit with data.
3. `edges: 'auto'` when the classifier step never runs — typing resolves
   `'llm'`, the classify method is absent, or the manifest is
   sentinel-reserved/over-cap (`MaintenanceService.ts:2171-2175`):
   `edges: 'auto'` is silently inert and edges stay generative. Confirm,
   or should a standalone classifier edge-screen pass run even when
   typing is generative? **Recommendation: inert** — one step, one pass,
   no second scheduling surface; a standalone screen is a later PR if
   hosts ask for it.
4. Per-fact fallthrough granularity (§5): a fact with any below-floor or
   invalid edge answer has BOTH its edges and its typing re-decided by the
   generative step. Confirm, or prefer per-edge fallthrough (classifier
   keeps typing, generative adds edges — requires new plumbing so a typed
   fact can still receive generative edges, which today's
   `changes === 0` omission path at `:2763-2766` forbids)?
   **Recommendation: per-fact** — it is the step-11 wording, it reuses the
   escalation machinery verbatim, and per-edge would double the surface
   for a marginal recall gain.
5. Default floor for `minConfidence.edges`: **recommendation `0.5`**,
   matching typing's default (`engineDefaults.ts:174`), no legacy chain.
   Owner may prefer a different number or an explicit required key (error
   when `'auto'` is set without a floor) — owner pick.
6. Escalated-typing facts (classifier abstain/low-confidence under
   `onLowConfidence: 'llm'`): their edge answers, though asked in the same
   call, are discarded and their edges come from the generative step.
   **Recommendation: confirm** — those facts fall through wholesale
   already (`:2547-2549`); honoring classifier edges for them would split
   a fact's writer, violating §5's one-writer rule.

## Files touched

- `packages/core/src/config/systemOne.ts` — `'edges'` joins
  `SystemOneThresholdSite` (one line, §1); `edges?: 'auto' | 'llm'` on
  `SystemOneConfig` (§2); `typing` docstring update (§9).
- `packages/core/src/utils/engineDefaults.ts` — `resolveSystemOneEdges`
  and `resolveEdgesMinConfidence` (§2, §3) with their `warnOnce`
  treated-as-unset paths.
- `packages/core/src/services/MaintenanceService.ts` — resolve mode+floor
  once per pass in `doRunOntologyBackfill` (beside `:2165`); plumb
  explicitly into `_runClassifierBackfill` (beside `:2487`) and via
  `runOpts` to BOTH `_runGenerativeBackfill` call sites (`:2201-2209`,
  `:2231-2238`; asserts at `:2269-2279`); edge-question construction and
  outcome handling in `_runClassifierBackfill` (`:2494-2564` region);
  classifier classifications now carry converted `edges` (`:2562-2564`);
  `edge_fallthrough` joins the escalation set (`:2544-2550`); `_runClassifierBackfill`
  docstring update (§9).
- `packages/core/__tests__/` — test plan below.
- `packages/core/src/index.ts` — export the two new resolvers beside the
  S1-0 resolvers.
- Docs, same PR: `systemOne.edges` + `minConfidence.edges` rows in
  `apps/docs/src/content/docs/reference/configuration.md` and the
  ontologies guide (§9); `docs/ROADMAP.md` step 10 entry (§9).

Not touched: `types.ts` (no new diagnostic code, no request-shape change),
`utils/diagnostics.ts` (both exhaustive maps unchanged — §7),
`ontologyReceiptVocabulary.test.ts` (no new code to vocabulary).

## Test plan

Vitest, beside the existing backfill tests. The prior draft's 11 cases are
carried forward and re-pointed at the classifier-first design:

1. Resolvers: `resolveSystemOneEdges` unset → `'llm'`; `'auto'`/`'llm'`
   pass through; invalid value warns once and resolves `'llm'`.
   `resolveEdgesMinConfidence` unset → `0.5`; configured `0` stays `0`
   (`??` discipline, `engineDefaults.ts:179`); non-finite/out-of-range
   warns once and resolves `0.5`.
2. Classifier edge accepted: `typing: 'auto'` + `edges: 'auto'`, classifier
   answers typing + binary edge answers at/above floor; the converted
   `{edge_type, target_title}` entries flow through the SAME validation
   and `resolveAndPersistEdges` pipeline, persist edges with writer
   `'classifier'` on the `node_type_assigned` receipt, and the classifier
   step's `edgesAdded` is nonzero.
3. Below-floor fallthrough: an edge answer below `minConfidence.edges`
   sends the fact UN-stamped to the generative step of the same pass,
   which types and edges it; the merged result reports the summed
   `edgesAdded` (`MaintenanceService.ts:2215-2225`).
4. No classifier (or `typing: 'llm'`): with `edges: 'auto'` but no
   `classify` method, behavior is byte-identical to the pre-PR baseline —
   generative proposes edges exactly as today (open question 3's
   recommended inert behavior, pinned as the contract).
5. Default mode: no `systemOne` keys at all — byte-identical across typing
   `'llm'` and legacy `'auto'`, including the classifier step proposing no
   edges and the step-9 `maxPromptChars` mechanics at the same
   `runBatched` call.
6. Abstain/low-confidence typing under `edges: 'auto'` +
   `onLowConfidence: 'llm'`: the fact falls to generative wholesale; its
   classifier edge answers are discarded; edges come only from the
   generative step (open question 6 pinned).
7. Invalid edge answer (malformed/out-of-range probability): treated as
   fallthrough, never applied, no `edge_dropped` from the classifier leg
   for it; the generative leg's own drops still surface as `edge_dropped`.
8. Zero-shortlist fact under `edges: 'auto'`: no edge questions asked;
   fact falls through to generative (§4).
9. Vocabulary: `ontologyReceiptVocabulary.test.ts` passes UNCHANGED —
   asserting no new diagnostic code and no interpolation surface was added
   (§7). The test asserts the absence explicitly (count of codes
   unchanged) so a later silent addition fails loudly.
10. Compat full-pass: a complete pass with only legacy keys matches the
    pre-PR baseline on persisted edges, `edge_dropped` diagnostics, and
    counters, for both typing modes.
11. Ordering pin: a generative classification whose id matches no batch
    fact still increments `failedValidation` at the `:2723-2726` continue
    before any receipt region executes (m4 pin); and a
    classifier-built classification can never hit that continue (its ids
    are batch ids by construction, `:2562-2564`).
