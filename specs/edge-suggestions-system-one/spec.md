# Spec — Step 10: Edge suggestions from System-One

Status: Draft 2026-11-22 — pending owner approval; owner ruling 2026-11-22
msg 1574082000854188136 (reply '1' to the presented menu): **classifier-first** —
the small classifier starts proposing/screening edges, gated by a confidence
floor (`minConfidence.edges`, the exact shape S1-0 reserved) applied to the
classifier's confidence in its per-edge ANSWER (directional, §3), with
uncertain-band facts falling back to the generative model and confident
"no" answers terminal — because
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
 * edge screen (§4) when the classifier step runs; answers at or above the
 * floor apply the edge, confident "no" answers are terminal, and facts
 * whose edge answers land in the uncertain band fall through to the
 * generative step of the same pass (§3, §5). There is no `'off'`: this PR
 * adds no configuration that can silently discard a model-proposed edge.
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
discipline as typing, `engineDefaults.ts:174`); valid only in **[0.5, 1]**
— a deliberate divergence from `isConfidenceFloor`'s [0, 1] typing
validator, see the Floor DOMAIN paragraph below; a present value outside
[0.5, 1] warns once and is treated as unset). There is no legacy
`ontology.*` chain for
edges — none exists to preserve. This is the consumer the `'edges'` union
member was reserved for; the old "dead config" footgun (a set
`minConfidence.edges` with no reader) does not exist in this design.

Floor semantics: the floor applies to the classifier's per-edge answer
CONFIDENCE, defined DIRECTIONALLY on the binary answer `{probability}`
(`types.ts:832`; `p` is P(edge)) — mirroring typing's floor on the
classifier's confidence in its answer (`:2538` uses strict `<`, so accept
is `confidence ≥ floor`). The directional form IS the band rule; the
`max(p, 1−p)` framing of earlier drafts is dropped as a separate rule.
Per answer:

- `p > 0.5 && p ≥ floor` → the classifier is confident "yes": accept the
  edge (§4).
- `p < 0.5 && 1−p ≥ floor` → the classifier is confident "no": nothing to
  do — the answer is TERMINAL, not a fallthrough. (A one-sided "at or
  below floor → fallthrough" rule would make every confident "no" a
  fallthrough, making the classifier edge path inert and doubling cost.)
  A realistic fact's many confident "no"s are the COMMON case, not
  fallthrough.
- EVERYTHING ELSE falls through to the generative step of the same pass
  (§5) — including EXACTLY `p = 0.5`, which is neither a confident "yes"
  (`>` is strict) nor a confident "no" — the exact step-11 pattern ("when
  the configured model is unavailable or below threshold, the fact falls
  through to the generative path"), applied at per-fact granularity.

Floor DOMAIN: the edges floor is valid only in **[0.5, 1]**. This
deliberately diverges from the typing validator `isConfidenceFloor`
(`engineDefaults.ts:112-113`, which accepts [0, 1]): below 0.5 the bands
INVERT — "accept" would stop meaning "more likely yes than no", and a
"confident no" zone could not exist. `resolveEdgesMinConfidence`
therefore validates `[0.5, 1]`: a present value outside that range
(including `0`) warns once via the existing `warnOnce` helper
(`engineDefaults.ts:89`) and is TREATED AS UNSET — the S1-0 §2
treated-as-unset contract, not a throw — and the default `0.5` applies
(default constant discipline as typing, `engineDefaults.ts:174`;
resolver shape mirrors `resolveTypingMinConfidence`,
`engineDefaults.ts:182`, minus the legacy chain). There is no legacy
`ontology.*` chain for edges — none exists to preserve. This is the
consumer the `'edges'` union member was reserved for; the old "dead
config" footgun (a set `minConfidence.edges` with no reader) does not
exist in this design.

Default-reachability disclosure, stated plainly: with the default floor
`0.5`, the fallthrough band is reachable only via answers at EXACTLY
`p = 0.5` or invalid answers. The common uncertain case under a
well-calibrated binary classifier is an answer NEAR 0 or 1, which the
directional rule classifies confidently; the band exists for genuinely
torn answers. Hosts who want a wider fallthrough band raise the floor.

Validation precedes the floor comparison, mirroring `:2534-2542` ordering:
`validateClassifierAnswer` runs first (`classifier.ts:20`); an invalid
answer is never floored, it falls through (§6).

### 4. The classifier edge screen (question shape — recommendation)

**Recommendation: per-fact `binary` screening questions over the per-fact
shortlist; no new provider method and no new question kind.**
`ClassifyRequest` already carries a map of questions per state
(`types.ts:824-828`), so the edge screen rides the SAME one-call-per-fact
request the typing question rides today (`MaintenanceService.ts:2518-2522`):

- Questions: for each manifest edge type and each of the fact's ranked
  shortlist candidates, one `binary` question keyed
  `edge:<edge_type>:<targetFactId>` with instructions naming the edge type
  and the candidate. The answer's `probability` is the `p` the §3 floor
  compares. Only (edge-definition, candidate) pairs whose `target_type` the
  candidate SATISFIES are asked: the candidate row's `okf_type` is known
  pre-call (`findShortlistRowsByEntityId` returns `okf_type`,
  `EntryRepository.ts:1892-1895`) and `resolveEdges` drops
  source/target type mismatches (`OntologyService.ts:176-199`), so asking
  an impossible pair would guarantee a wasted answer. Keys are NEVER
  parsed: edge types are host-authored and may contain `:`, so the
  implementation carries a key→(edge-definition, candidate-row) map
  alongside the question map. The worst-case cost question (OQ2) counts
  RELEVANT pairs, not the raw `edgeTypes × k` cross product.
- Candidates: the same ranked per-fact shortlist the step-8 generative
  prompt consumes (`specs/backfill-shortlist-wiring`; k bounded by
  `resolveShortlistK`, `engineDefaults.ts:162-171`), computed in
  `_runClassifierBackfill` BEFORE the classify calls. The pool read is the
  same plain repo method the generative prompt-build uses outside any tx
  (`this.entryRepo.findShortlistRowsByEntityId(entityId)`,
  `MaintenanceService.ts:2302`; the `:2293-2301` timing comment already
  establishes "as of prompt-build time, not write time" as the existing
  discipline). Disclosed asymmetries: the title index the generative APPLY
  path resolves against is built inside the batch tx
  (`MaintenanceService.ts:2711-2715`) and updated intra-tx (`:2778`), so
  the classifier's candidate pool is narrower — it excludes facts typed
  earlier in the same pass (rows are not re-read). The rows are read ONCE
  per pass — BUT only when edges resolve `'auto'`: the shortlist rows read
  (`:2302`) and the scorer built from them
  (`createShortlistScorer`, `:2314`) are HOISTED from
  `_runGenerativeBackfill` to `doRunOntologyBackfill` pass entry, beside
  the mode/floor/`shortlistK` resolution, and the shared scorer + rows are
  passed to BOTH steps ONLY WHEN `resolveSystemOneEdges` resolves
  `'auto'`. When edges resolve `'llm'` (the default), the generative step
  KEEPS its existing in-step read and scorer construction exactly as
  today: the escalation-leg prompt built at `:2201-2209` lists the same
  candidate facts the classifier just typed (facts typed earlier in the
  pass are accepted targets but not listed, per the `:2293-2301` comment),
  and hoisting the pool read would NOT drop those rows from that prompt
  (it is a pool read, not a per-fact list) — but a hoisted-by-default
  read is still a behavior-adjacent change, so it is gated to keep every
  host that never set the key on a byte-identical path (§8, test 10).
  Feasible when engaged because the `:2293-2301` timing comment
  already establishes "read once per pass, outside a transaction" as the
  existing discipline. Zero candidates is the
  bootstrap norm: `findShortlistRowsByEntityId` returns only
  `okf_type IS NOT NULL` rows (`EntryRepository.ts:1892-1895`), so on a
  fresh or mostly-untyped store every fact has zero candidates and routing
  them ALL to generative would make `'auto'` mean "generative for
  everything" at bootstrap with double cost. Instead: a fact with zero
  candidates gets NO edge questions, KEEPS its classifier typing, and
  produces NO edges from the classifier — it is not a fallthrough (§5).
  Disclosed: same-response and catalog targets are lost for these facts.
  Generative edge recall for zero-candidate facts, if ever wanted, is an
  explicit receipted choice in a later PR — not the default here.
- Why binary, not one big `choice`: a fact can carry several edges of
  different types; the `choice` shape returns exactly one choice per
  question (`types.ts:820`), so a choice-per-fact cannot express the
  multi-edge case, and a choice over the cross product would blow past
  `CLASSIFIER_MAX_CHOICES` (`MaintenanceService.ts:2173`). Binary per
  (edge type, target) is O(edgeTypes × k) questions in one already-existing
  call, keeps the abstain-sentinel machinery unnecessary (a "no" answer IS
  the decline), and gives a clean single number to floor.
- Accepted answers (`p ≥ floor`) are converted, before
  `_applyOntologyBackfillBatch`, into ordinary
  `classifications[].edges` entries `{edge_type, target_title}` built from
  the candidate row (`MaintenanceService.ts:2562-2564` shape, now with
  `edges`), so the ENTIRE downstream pipeline is reused unchanged:
  `validateAndNormalizeFact` (`:2731-2738`), `pendingEdges` staging
  (`:2719`, `:2779-2781`), the two-phase `resolveAndPersistEdges` pass
  (`:2786-2791`), and `edge_dropped` diagnostics — the classifier is
  untrusted input to the same strict validation the generative model faces.
- Known limitation, resolved pre-call, disclosed and pinned: the classifier
  screens by `targetFactId`, but edges persist via `target_title`, resolved
  by `normalizeTitleKey` in a map where later rows overwrite earlier
  (`MaintenanceService.ts:2711-2715`, intra-tx update `:2778`) — so a
  title collision could otherwise resolve to a DIFFERENT fact than the one
  screened. Pinned guard (PRE-CALL screen, not post-resolution): the
  classifier pass builds its candidate pool from
  `findShortlistRowsByEntityId` and a title-normalization check —
  `normalizeTitleKey` applied the same way the generative title index
  built at `:2711-2715` is shaped (`normalizeTitleKey(row.title)` →
  `{id, okf_type}` map) — and SKIPS any candidate whose normalized title
  maps to a DIFFERENT id than the candidate row's id; such pairs never
  become questions (test case 17 pins this). Timing gap, disclosed: the
  pool is as of pass-entry, the same discipline as the `:2293-2301`
  comment — a title collision created later in the same pass (intra-tx
  update at `:2778`) can still retarget — accepted limitation, stated.
  `resolveEdges`, `resolveAndPersistEdges`, `EdgeDropReason`, and the
  edge diagnostics are UNTOUCHED by this guard — it is a candidate
  screen, not a pipeline change. This skip COMPOSES with M2's pre-call
  `target_type` filter: both are pre-call candidate screens (§4 first
  bullet; §5 M2).
- Public surface: none beyond §1/§2. `ClassifyRequest`,
  `ClassifierQuestion`, and `LLMProvider.classify` (`types.ts:815`) are
  unchanged; hosts' existing classifiers answer binary questions already.

### 5. Fallthrough wiring (explicit at both call sites)

In `_runClassifierBackfill`, an outcome `edge_fallthrough` is produced
ONLY for a fact whose typing outcome is ACCEPTED and which has an edge
answer in the UNCERTAIN band (§3: anything that is not a confident "yes"
`p > 0.5 && p ≥ floor` nor a confident "no" `p < 0.5 && 1−p ≥ floor` —
including exactly `p = 0.5`), or an invalid edge answer (§6). Edge
outcomes are evaluated ONLY when the fact's typing outcome is ACCEPTED:
under ANY other typing outcome (abstain, low_confidence, invalid, threw,
unattempted), the edge answers are DISCARDED wholesale — no floor logic,
no fallthrough — and the fact follows the EXISTING `onLowConfidence`
routing UNCHANGED (`:2544-2550`). Under the default
`onLowConfidence: 'leave'`, "leave" means the fact is stamped and left,
edges included: `edges: 'auto'` NEVER escalates a fact whose typing the
host told core to leave. Confident-"no" answers are terminal, accepted
answers apply, and a fact with zero candidates is not a fallthrough
(§4). Before ANY floor/fallthrough
logic runs, answers whose source_type does not match the fact's CHOSEN
typing are DISCARDED (M2: `resolveEdges` drops source/target mismatches,
`OntologyService.ts:176-199`; a pair that cannot exist is not
"uncertain"). `edge_fallthrough` facts join the escalation set —
UNconditionally, not gated by `onLowConfidence`. The UNCONDITIONAL
trigger therefore applies ONLY when typing was accepted and an edge
answer is uncertain or invalid; the `:2185` gate split below stands.
This requires TWO named
gate changes, both pinned because the current machinery would strand
fallthrough facts:

- The escalation collection at `:2544-2550` is itself gated by the
  `onLowConfidence === 'llm'` resolve (`:2544`) and keys only on
  `abstain`/`low_confidence` kinds (`:2547-2549`). `edge_fallthrough` must
  join `escalated` regardless of that resolve.
- The generative leg in `doRunOntologyBackfill` is gated at
  `MaintenanceService.ts:2185` on
  `classifierRun.escalated.length > 0 && this.resolveSystemOneOnLowConfidence() === 'llm'`.
  Under the DEFAULT `onLowConfidence: 'leave'` that condition is false, so
  if a fallthrough fact were merely added to `escalated`, it would be
  excluded from `attempted` (un-stamped) but NEVER handed to generative —
  re-asked and re-fallen-through every pass, never progressing. The
  `:2185` condition SPLITS: typing escalations keep the
  `onLowConfidence === 'llm'` requirement; any `edge_fallthrough` fact
  triggers the generative leg unconditionally (test case 12 pins the
  default-`'leave'` path). The split must keep the ontology-off live-mode
  re-check (`:2195-2199`) INSIDE the triggered branch: ANY
  fallthrough-triggered leg re-checks live mode before calling generative
  (test case 13 pins this).

The Outcome union (`:2503-2510`) gains the compound state (a fact can be
typing-accepted AND `edge_fallthrough`), and the collection/filter pair
(`:2547-2551`) is extended so such a fact joins `escalated` EXACTLY ONCE —
no double-add when a fact is both a typing escalation and an edge
fallthrough (test case 14 pins the overlap).

`edge_fallthrough` facts are handed un-stamped to the generative step of
the same pass, exactly like typing escalations
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
  counts generative-side validation failures unchanged; classifier-side
  invalid edge answers add **0** to `failedValidation` — `invalidCount`
  counts typing outcomes only (`:2565`) — because an invalid edge answer
  falls through (§5) and surfaces as a diagnostic (below).
- Diagnostics: the EXISTING `classification_low_confidence` and
  `classification_invalid` emissions are EXTENDED to cover edge-screen
  fallthrough (uncertain-band answers) and invalid edge answers, with a
  `detail` field distinguishing the edge site (e.g.
  `site: 'edge_screen'`). Volume pin: the edge-site emissions fire ONCE
  PER FACT with a `detail` carrying counts (e.g. the fact's
  uncertain/invalid/asked edge-answer counts), NEVER per answer — a fact
  with many uncertain edges emits one diagnostic, not a flood. No new
  diagnostic code (§7 keeps its zero-new-codes property).
- Receipts: **no new diagnostic code in this PR.** Every model-proposed
  edge under this design reaches either the classifier validation pipeline
  (drops receipted as `edge_dropped`, `diagnostics.ts:78`, `:288`) or the
  generative fallback (same). No configuration introduced here can silently
  discard a proposed edge — there is no `'off'` mode (§2) and an
  uncertain-band answer is a ROUTING decision whose destination still
  proposes (§3). S1-0 §6's
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
proposes (as today, nothing suppressed); `'auto'` mode routes
uncertain-band facts to generative, which proposes; confident-"no"
answers (`p < 0.5 && 1−p ≥ floor`) are terminal decisions, not drops
(§3). The
extended `classification_low_confidence` / `classification_invalid`
emissions (§6) reuse EXISTING codes — still zero new codes. If a future
PR adds an `'off'` mode, THAT PR adds the receipt with it.

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
  `systemOne.minConfidence.edges` — confident "yes" answers
  (`p > 0.5 && p ≥ floor`) apply, confident "no" answers
  (`p < 0.5 && 1−p ≥ floor`) are terminal, and everything else (including
  exactly `p = 0.5`) plus invalid edge answers fall through to the
  generative step; edge outcomes are evaluated only for typing-ACCEPTED
  facts (§5)."
- `systemOne.ts:15-19` (`typing` docstring, "'auto' uses
  `llmProvider.classify` when present (no edges proposed)"): the
  parenthetical gains "unless `systemOne.edges: 'auto'`".
- `docs/ROADMAP.md` step 10 entry: one line in the established Done
  convention, exactly like steps 7-9 (`ROADMAP.md:232,244,255`):
  `Done — merged <date>, PR #…, spec [edge-suggestions-system-one](../specs/edge-suggestions-system-one/spec.md)` —
  the roadmap carries order, not status (`AGENTS.md`); the design
  narrative lives in the spec, not the roadmap line.
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
- Any change to edge validation, `resolveEdges`, `resolveAndPersistEdges`,
  `EdgeDropReason`, edge diagnostics, title-index construction,
  `ontology_updates` handling, or `runBatched`/the step-9 prompt cap —
  all site-independent mechanics stay untouched (the §4 title-collision
  screen is a PRE-CALL candidate screen in the classifier pass; the
  resolveEdges pipeline itself is unchanged).
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
2. Cost posture: with `edges: 'auto'`, only TARGET-side filtering happens
   pre-call — the pre-call screen keeps (edge-definition, candidate) pairs
   whose `target_type` the candidate's `okf_type` satisfies (§4; only
   these are asked, since `resolveEdges` would drop any others,
   `OntologyService.ts:176-199`) — while the SOURCE type of the fact is
   unknown until typing is accepted IN THE SAME request, so source-side
   filtering cannot happen pre-call. The paid worst case is therefore
   edge-definitions-whose-target_type-the-candidate-satisfies ACROSS ALL
   SOURCE TYPES per candidate, in ONE request per fact; this is bounded
   above by `manifestEdgeTypes × shortlistK` but usually smaller
   (typed per-fact, `types.ts:824-828`). Nothing in core caps the questions
   map (`CLASSIFIER_MAX_CHOICES` at `MaintenanceService.ts:61` bounds
   only choice OPTIONS, `:2173`), so any request-size limit is the host
   classifier's contract (`types.ts:815`). Accept the uncapped cost and
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
4. Per-fact fallthrough granularity (§5): a fact with any uncertain-band or
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
   Domain is [0.5, 1] (deliberately diverging from `isConfidenceFloor`'s
   [0, 1], §3 — below 0.5 the directional bands invert); values outside
   [0.5, 1] warn once and are treated as unset. Under the default `0.5`
   the fallthrough band is reachable only at exactly `p = 0.5` or via
   invalid answers (§3 disclosure). Owner may prefer a higher floor or an
   explicit required key (error when `'auto'` is set without a floor) —
   owner pick.
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
  `:2231-2238`; asserts at `:2269-2279`); `shortlistK` joins the EXPLICIT
  `_runClassifierBackfill` arguments (`:2475-2483`) — no re-resolve, so
  the once-per-pass discipline (`:2300-2301`) and the single throw-site
  stand; the pass-level shortlist scorer + rows are HOISTED to
  `doRunOntologyBackfill` entry (beside the mode/floor resolution) and
  SHARED by both steps ONLY WHEN `resolveSystemOneEdges` resolves
  `'auto'` — under the default `'llm'` the generative step keeps its
  in-step read so prompts stay byte-identical for hosts that never set
  the key (§4, test 10); edge-question construction and
  outcome handling in `_runClassifierBackfill` (`:2494-2564` region);
  classifier classifications now carry converted `edges` (`:2562-2564`);
  PRE-CALL title-collision candidate screen in the classifier pass —
  candidates whose normalized title maps to a different id are SKIPPED
  before any question is built (§4, test 17); `edge_fallthrough` joins
  the escalation set and the
  Outcome union gains
  the compound state with exactly-once collection (`:2503-2510`,
  `:2544-2551`); the generative-leg gate at `:2185` SPLITS — typing
  escalations stay `onLowConfidence`-gated, `edge_fallthrough` triggers
  the leg unconditionally (§5); `_runClassifierBackfill`
  docstring update (§9).
- `packages/core/__tests__/` — test plan below.
- `packages/core/src/index.ts` — export the two new resolvers beside the
  S1-0 resolvers.
- Spec-directory prerequisites: `plan.md` and `LEDGER.md` must exist in
  `specs/edge-suggestions-system-one/` before implementation starts (the
  spec-draft stage is fine without them; a Files-touched/implementation
  note, not a code change).
- Shipped unbenchmarked (INTENT.md rule 11, cf. `MaintenanceService.ts:2301`):
  this PR carries NO accuracy or cost benchmark; disclosed — under
  `edges: 'auto'` the cost profile can EXCEED `'llm'` (a classify call
  with edge questions plus the generative step for uncertain-band facts).
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
   `resolveEdgesMinConfidence` unset → `0.5`; configured `0` or any value
   outside [0.5, 1] warns once, is TREATED AS UNSET, and resolves `0.5`
   (the edges floor deliberately does NOT reuse `isConfidenceFloor`'s
   [0, 1] domain — §3); values in [0.5, 1] pass through.
2. Classifier edge accepted: `typing: 'auto'` + `edges: 'auto'`,
   classifier answers typing + binary edge answers with a confident "yes"
   (`p > 0.5 && p ≥ floor`); the converted
   `{edge_type, target_title}` entries flow through the SAME validation
   and `resolveAndPersistEdges` pipeline, persist edges with writer
   `'classifier'` on the `node_type_assigned` receipt, and the classifier
   step's `edgesAdded` is nonzero.
3. Uncertain-band fallthrough: an edge answer that is neither a confident
   "yes" (`p > 0.5 && p ≥ floor`) nor a confident "no"
   (`p < 0.5 && 1−p ≥ floor`) — e.g. `p = 0.5` under the default floor —
   sends the fact UN-stamped to the generative step of the
   same pass, which types and edges it; the merged result reports the
   summed `edgesAdded` (`MaintenanceService.ts:2215-2225`).
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
8. Zero candidates (M1): a fact on a fresh/mostly-untyped store
   (`findShortlistRowsByEntityId` returns only `okf_type IS NOT NULL` rows,
   `EntryRepository.ts:1892-1895`) under `edges: 'auto'`: classifier
   typing applied, NO edge questions asked, no edges persisted, and the
   fact does NOT fall through to generative (§4).
9. Vocabulary: `ontologyReceiptVocabulary.test.ts` needs NO extension —
   this PR adds no new diagnostic code (§7: the extended edge-site
   emissions reuse the existing `classification_low_confidence` /
   `classification_invalid` codes), and the file is not touched. (The
   file asserts fixed severities/messages per code, not a count of
   codes — `:29` has no count assertion — so no unchanged-count claim is
   made.)
10. Compat full-pass: a complete pass with only legacy keys matches the
    pre-PR baseline on persisted edges, `edge_dropped` diagnostics, and
    counters, for both typing modes; AND, when no `systemOne.edges` key
    is set, the escalation-leg prompt's candidate list is byte-identical
    to pre-PR (the `:2201-2209` prompt unchanged — the hoist is gated to
    `'auto'`, §4/MAJOR pin).
11. Ordering pin: a generative classification whose id matches no batch
    fact still increments `failedValidation` at the `:2723-2726` continue
    before any receipt region executes (m4 pin); and a
    classifier-built classification can never hit that continue (its ids
    are batch ids by construction, `:2562-2564`).
12. Fallthrough under the DEFAULT `onLowConfidence: 'leave'`: an
    `edge_fallthrough` fact still reaches the generative step (the split
    `:2185` gate pinned — §5's MAJOR failure mode: without the split the
    fact is un-stamped but never progresses), is NOT cooldown-stamped
    (`markOntologyChecked` covers `attempted` only, `:2797`), and has its
    typing re-decided generatively.
13. Ontology-off abort mid-classifier with `edges: 'auto'`: the aborted
    zeroed return (`:2616-2623`) has no persisted edges, `edgesAdded 0`,
    and `escalated` empty — diagnostics ARE still flushed on abort by
    design (`:2609-2612`), so the assertion does NOT claim an empty
    diagnostic buffer; host loop terminates. AND the live-mode re-check
    (`:2195-2199`) stays INSIDE the triggered branch: a
    fallthrough-triggered generative leg with live mode `'off'` re-checks
    and defers without calling generative (m2 pin).
14. Overlap: a fact that is BOTH a typing escalation (`onLowConfidence:
    'llm'`) and an `edge_fallthrough` appears in `escalated` exactly once
    and gets ONE generative decision (§5 compound-state dedupe).
15. Mostly-confident-"no" fact (B1): several edge answers that are
    confident "no"s (`p < 0.5 && 1−p ≥ floor`) plus one confident "yes"
    (`p > 0.5 && p ≥ floor`) — the "yes"
    edge is applied and the fact does NOT fall through to generative (the
    common case per §3; confident "no"s are terminal).
16. Source/target type mismatch (M2): a (definition, candidate) pair whose
    `target_type` the candidate's `okf_type` does not satisfy is never
    ASKED (§4 pre-call filter), and a returned answer whose source_type
    does not match the fact's chosen typing is discarded BEFORE any
    floor/fallthrough logic — it produces neither an applied edge nor a
    fallthrough.
17. Title-collision pre-call skip (M3): a candidate whose normalized
    title (`normalizeTitleKey`, mirroring the `:2711-2715` index shape)
    maps to a DIFFERENT id than the candidate row's id is SKIPPED at
    candidate-pool build time — the pair never becomes a question, and no
    `edge_dropped` is emitted for it (the pre-call screen composes with
    test 16's target_type filter; §4).
18. Floor boundaries, directional (m1): an edge answer with `p = 0.5`
    under the default floor falls through (neither band applies — accept
    requires strict `p > 0.5`); a configured floor of `0.3` is REJECTED
    (warn once, treated as unset, default `0.5` applies — [0.5, 1]
    domain, §3); an answer at `p = 0.4` under floor `0.6` is a TERMINAL
    confident-"no" (`1−0.4 = 0.6 ≥ 0.6`), not a fallthrough.
19. Edge answers vs typing outcome (MAJOR 4): under
    `onLowConfidence: 'leave'` (default), a fact with
    low_confidence typing and an uncertain-band edge answer is STAMPED
    and left, edges included — NO generative leg, NO edges persisted; the
    same discard holds when the typing outcome is abstain or invalid
    (§5: edge outcomes are evaluated only for typing-ACCEPTED facts).
