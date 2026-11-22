# Spec — Step 11: Resolution from System-One

Status: **Approved by owner** — rulings 2026-11-22, Discord msg
`1574134804725760061` ("As recommended across the board… Consider this your
formal ruling. Lock the spec, generate the Tier-3 plan, and proceed to the
implementer wave."). All 8 open questions resolved as recommended (see
"Open questions" — each carries its ruling). Draft history: 2026-11-22
(Tessera session-2 lane, Discord thread
`1574117274791706748`). Review ladder: flash fidelity rung (glm-5.3-flash,
free) folded — 8 findings; Opus spec-review rung (opus-review --doc,
effort medium, $0.50 of $1.00 cap) REQUEST CHANGES folded — blocker B1
(silent classifier NOOP → receipts via existing `fact_deduplicated` +
`reason: 'classifier'` through ops/index.ts's DiagnosticBuffer), majors
M1 (question reworded duplicate-only; update-shaped-pair test; Q8 added),
M2 (§4/Q3/Q4 mode-ranking note), M3 (prologue all-or-nothing), minors
m1–m5. Lane assigned by the step-10 sibling session
(thread `1570840529388965951`): spec prep only until its PR merged — #459
merged 18:17:50Z, release v9.12.0 verified live 18:24:48Z, main tip
`206936cc`. Owner rulings RECEIVED 2026-11-22 (see "Open questions — ALL
RESOLVED"); plan and implementer dispatch authorized by the same ruling.
Base: origin/main @ `206936cc` (post #459 + #460 release-PR merge). Every pin
below re-verified live against the lane worktree
`~/code/github/worktrees/expo-llm-wiki-tessera-laneB`. Repo: expo-llm-wiki.
Product rule: hosts bring their own models; core stays unopinionated about
providers.

## Problem

The librarian ops pass resolves ambiguous fact candidates — "is this a
duplicate, an update, a supersession, or new?" — exclusively on the
generative path: `runResolve`
(`packages/core/src/services/librarian/ops/resolve.ts:70`) batches every
gate-ambiguous candidate into one `callLlm` invocation
(`resolve.ts:94`, `operation: 'librarian'`). The gate
(`classifyCandidate`, `packages/core/src/services/librarian/ops/gate.ts:67-83`)
already settles the extreme scores locally, but everything in the uncertain
band — and, in keyword mode, EVERY candidate with neighbours
(`gate.ts:77`) — pays a generative call. The host's non-generative
classifier (`LLMProvider.classify`, reached as `options.llmProvider.classify`,
`packages/core/src/types.ts:770-816`) is never consulted at this site — and
no host knob engages, tunes, or floors a classifier resolution here. Roadmap step 11 says the entity-resolution site "opts
in to the configured model" and that "when the configured model is
unavailable or below threshold, the fact falls through to the generative
path, and the pass warns once" (`docs/ROADMAP.md:272-278`). The S1-0 spec
reserved exactly one new `'resolve'` line in `SystemOneThresholdSite` for
this PR (`specs/system-one-config/spec.md:67-71` — "PR 4 adds `'resolve'`")
and fenced it out of S1-0 (`spec.md:265-272`) — as a *threshold site*, the
same shape step 10 (`specs/edge-suggestions-system-one`) just implemented
for edges.

## Root cause with evidence

- `SystemOneThresholdSite` is `'typing' | 'edges'`
  (`packages/core/src/config/systemOne.ts:13`); its docstring already
  promises `'resolve'`/`'healScreen'` as one-line sibling additions
  (`systemOne.ts:5-8`). `minConfidence` is typed
  `Partial<Record<SystemOneThresholdSite, number>>` (`systemOne.ts:34-35`),
  so the union member immediately carries a floor with no type churn.
- The entity-resolution site is `runResolve` — ONE caller:
  `ops/index.ts:68` passes `gated.filter(g => g.decision.kind ===
  'ambiguous')` into it with the context budget
  (`resolveContextBudget(deps.options.config)`). The legacy librarian
  strategy has no resolve pass (`legacy.ts` has no `runResolve`/ambiguous
  handling — its apply path only resolves edges), so scope is exactly this
  site. The backfill path's *node-type* resolution
  (`resolveNodeTypeMatch`, `OntologyService.ts:125`) is a different
  operation and is NOT this site; neither is
  `OntologyService.resolveAndPersistEdges` (edge resolution, called from
  `apply.ts:239`).
- Gate routing that produces `ambiguous` (all pins `gate.ts`):
  normalized-text equal → NOOP (`:74-75`); no neighbours → ADD (`:76`);
  keyword mode with any neighbours → ambiguous (`:77`); vector mode: best
  `>=` dupThreshold with title match → NOOP, best `<` novelThreshold → ADD,
  else ambiguous (`:78-82`). Thresholds calibrated 0.89/0.30
  (`gate.ts:38-46`).
- The generative resolve validates ops per candidate against that
  candidate's OWN alias map (`validateOp`, `resolve.ts:39-55`) and an
  unparseable single-item batch lands in `failed` (`resolve.ts:139`; the
  docstring promising it is `resolve.ts:66-68`);
  apply turns rejected ops into ADD with `librarian_op_rejected`
  (`apply.ts:187`, second emission at `:231`; `:181` is the
  `resolve_failed` diagnostic path). Any classifier
  shortcut must respect the same per-candidate scoping.
- The classifier machinery is reachable from this site with NO new
  plumbing: `LibrarianDeps.options` is `WikiOptions`
  (`packages/core/src/services/librarian/types.ts:50`),
  `WikiOptions.llmProvider` is the `LLMProvider` whose optional `classify`
  member is the non-generative classifier that "core never calls … unless
  the host opts in" (REQ-COMPAT-01.5, `types.ts:809-815`), and
  `deps.options.config` already reaches the ops layer
  (`ops/index.ts:30`, `:68`). `ClassifyRequest` is one state evaluated
  against a map of questions (`types.ts:824-828`); a `binary` question
  answers `{probability}` (`types.ts:832`, validated untrusted at
  `packages/core/src/utils/classifier.ts:44-47`) — one number to floor,
  exactly the shape step 10 floored.
- The resolver vocabulary is in place from S1-0 + step 10:
  `resolveSystemOneEdges` (`packages/core/src/utils/engineDefaults.ts:159`)
  and `resolveEdgesMinConfidence` (`engineDefaults.ts:231`) are the
  per-site precedents; `warnOnce` (`engineDefaults.ts:89-93`) implements
  the S1-0 §2 treated-as-unset contract; step 10's posture A (owner ruling
  2026-11-22, msg `1574101104528986284`) made the explicit floor a
  REQUIREMENT for `'auto'` because a 0.5 binary confidence is a coin toss.
  Resolution has strictly higher stakes on one side: a wrong NOOP *drops a
  live fact* (data loss), where a wrong edge was merely a wrong fact.
- Step-11 semantic frame (roadmap, `docs/ROADMAP.md:195-199`): step 11 may
  rewrite a fact in place and the receipts and counters make the moves
  auditable. The ops path already emits per-candidate diagnostics
  (`fact_deduplicated`, `apply.ts:157-166` `source_pointer_unresolved`,
  `apply.ts:181` `resolve_failed`).

## Proposed change

### 1. One new line in `SystemOneThresholdSite`

`systemOne.ts:13` becomes:

```ts
export type SystemOneThresholdSite = 'typing' | 'edges' | 'resolve';
```

Exactly one new member, exactly per the S1-0 merge fence
(`specs/system-one-config/spec.md:67-71`). `minConfidence` stays closed
under the site union and immediately gains its consumer: the
`minConfidence.resolve` floor of §3.

### 2. Engagement key `systemOne.resolve: 'auto' | 'llm'`

Add to `SystemOneConfig` (`systemOne.ts:15-44`, beside `typing`/`edges`):

```ts
/**
 * Entity-resolution mode for the librarian ops pass. `'llm'` (default)
 * keeps ambiguous-candidate reconciliation on the generative path exactly
 * as today. `'auto'` engages the classifier resolution screen (§4) when
 * the host provides a classifier AND an explicit `minConfidence.resolve`
 * floor is set (§3 — missing floor under `'auto'` warns once and the site
 * resolves `'llm'`); confident answers apply (§4), uncertain-band
 * candidates fall through to the generative resolve of the same pass
 * (§5), and an unavailable classifier warns once per process and falls
 * through whole (§5). There is no `'off'`: this PR adds no configuration
 * that can silently discard a candidate from resolution.
 */
resolve?: 'auto' | 'llm';
```

Resolution: `resolveSystemOneResolve(config)` in `engineDefaults.ts`,
returning `config?.systemOne?.resolve ?? 'llm'`; a present
non-`'auto'`/non-`'llm'` value warns once via the existing `warnOnce`
helper and is treated as unset — the S1-0 §2 treated-as-unset contract,
mirroring `resolveSystemOneTyping`/`resolveSystemOneEdges`. Posture A is
CONFIRMED owner policy (ruling msg `1574134804725760061`, Q2: "Yes,
Posture A"; inheriting the step-10 ruling msg `1574101104528986284`):
resolving `'auto'` alone does NOT engage the
screen — the site additionally requires the explicit `minConfidence.resolve`
floor; missing/out-of-domain floor → warnOnce naming the key, site resolves
`'llm'`. No call option
— resolution mode is a config-level stance, not per-call tuning. No
`'off'`.

### 3. Floor `minConfidence.resolve`

Add `resolveResolveMinConfidence(config)` in `engineDefaults.ts` (naming
follows the step-10 `resolveEdgesMinConfidence` precedent): returns
`undefined` unless the site resolves `'auto'` with a floor present and
valid — domain **[0.5, 1]** CONFIRMED (ruling msg `1574134804725760061`,
Q7; the step-10 `isEdgesFloor` precedent, `engineDefaults.ts:221-222`;
"S1-0 typing chain (`resolveTypingMinConfidence`,
`engineDefaults.ts:193-219`) accepts finite [0, 1]" recorded here only as
the rejected alternative). "Use `??`, never `||`" applies. An invalid
value (NaN, out of [0.5, 1]) warns once and is treated
as unset — the S1-0 treated-as-unset contract. The
floor applies to the classifier's per-answer
probability at the resolve site only; the generative path produces no
confidence and is never floored.

### 4. The classifier resolution screen (question shape — ruled)

SHAPE CONFIRMED (ruling msg `1574134804725760061`, Q1/Q3/Q4/Q8 — "as
recommended"): for
each gate-ambiguous candidate, ONE `ClassifyRequest` with one `binary`
question per screened neighbour (**best neighbour only**, `neighbours[0]`
— Q3; keeps token spend linearly bounded) — state =
candidate title+body, question =
"does this candidate add NO information beyond neighbour nX (a pure
duplicate: same claims, no new content)?" — strict duplicate-only wording
per the Opus review (M1): a generic "is this the same fact?" would let an
update-shaped pair ("Alice lives in Berlin" vs "Alice lives in Paris")
answer YES and get dropped as a NOOP, discarding the new value. The
duplicate-only phrasing, the floor, and the receipts of §6 are the
mitigations; a red-first test MUST assert an update-shaped pair does not
settle as NOOP. The question is `binary` (vendor-neutral per
`types.ts:819-822`), presented against the candidate's own alias map
neighbours so per-candidate scoping (`validateOp`, `resolve.ts:39-55`)
is preserved by construction.

- Confident YES (`probability >= floor`) on a neighbour → terminal
  **NOOP** on that neighbour's id. Precedent boundary, stated honestly:
  the gate's local NOOP rule (`gate.ts:80`) fires only on cosine ≥ 0.89
  AND a title-Jaccard match — near-identical text. The classifier screen
  reaches into the 0.30–0.89 uncertain band and (Q4 CONFIRMED: the screen
  engages in keyword mode too — the highest-volume generative population)
  exactly where update/supersede shapes live, which is why the question
  is duplicate-only; Q8 ruled (a): a confident YES IS terminal wherever
  the screen runs, guarded by the explicit floor, the duplicate-only
  wording, and the §6 receipts.
  A settled NOOP is dropped with a receipt (§6) — the gate's local drops
  (`apply.ts:176`) carry none, and neither does a resolved NOOP
  (`apply.ts:190`).
- Confident NO and uncertain band → fall through to the generative resolve
  (§5). Q1 ruled **(b) fall through** — a terminal ADD was REJECTED: "a
  false negative (confident NO on an actual duplicate) leads to silent
  data duplication; letting the generative path double-check limits our
  downside risk" (ruling msg `1574134804725760061`).
- Misroute accounting, stated plainly: a wrong NOOP drops a live fact
  (data loss — this is why the floor is explicit and required); a wrong
  ADD creates an additive duplicate the next pass can reconcile; the
  generative path remains the fallback for everything the classifier does
  not settle.
- Classifier unavailable (`classify` absent) or throwing mid-pass: the
  prologue is ALL-OR-NOTHING — any absent classifier or throw means
  `settled` is empty (no partial results are kept), the pass warns ONCE
  (Q5 CONFIRMED: once per PROCESS via the `warnOnce` shared set — stricter
  than the roadmap's per-pass wording, owner's choice "keeps the logs
  honest without turning into unreadable spam"), and ALL candidates fall
  through to the generative
  batch; roadmap wording
  (`docs/ROADMAP.md:274-276`) requires exactly this fallthrough.

### 5. Fallthrough wiring (explicit at the one call site)

`runResolve` (`resolve.ts:70`) gains a screening prologue, pure and
unit-testable in the step-10 style: given the ambiguous candidates, the
resolved mode/floor, and the classifier, return `{ settled: Map<candidate,
ResolvedOp>, rest: GatedCandidate[], warnReason?: 'no-classifier' |
'no-floor' }`. Only `rest` enters the existing `runBatched` generative
call; `settled` entries flow back through `runResolve`'s existing return
shape (they ARE `ResolvedOp`s) so `apply.ts` is unchanged — but the
classifier-settled NOOP receipts are emitted by `ops/index.ts` through
the pass-level DiagnosticBuffer it already owns (§6), so the call site
gains a small emission loop. An empty `rest` skips the
LLM call entirely (the `ambiguous.length === 0` precedent, `resolve.ts:77`).
The `budget`/overflow machinery of the generative leg is untouched —
screened candidates can no longer contribute overflow skips, which is a
strict reduction in skipped work.

### 6. Accounting and receipts

Zero NEW diagnostic codes (step-10 D4 precedent), but receipts are NOT
silent: a classifier-settled NOOP emits the EXISTING `fact_deduplicated`
code with `detail.reason: 'classifier'` — the direct precedent is
`ops/index.ts:61-64`, which already emits `fact_deduplicated` with
`reason: 'in_batch'` for in-batch duplicates. This resolves the Opus
review's blocker: the gate's local NOOP (`apply.ts:176`) and a resolved
NOOP (`apply.ts:190`) carry no diagnostic today, so a dropped candidate
would otherwise be unauditable — the data-loss outcome the roadmap's
"receipts and counters make these moves auditable" line
(`docs/ROADMAP.md:197-199`) exists to prevent. Emission goes through the
pass-level DiagnosticBuffer in `ops/index.ts` (the same buffer
`runResolve`'s overflow skips are buffered into, `resolve.ts:100-103`).
`LibrarianResult` (`librarian/types.ts:109-116`) gains nothing —
step 10 added NO pass-result counters, so a counter
addition here would be new public surface and is RULED OUT (Q6b, ruling
msg `1574134804725760061`: "No to a and b — the existing
fact_deduplicated receipt with the reason: 'classifier' flag provides the
exact audit trail needed without bloating the public LibrarianResult
surface"). No
`writer` change —
`apply.ts` applies `ResolvedOp`s identically regardless of who resolved
them (unlike backfill, ops apply has no `'classifier'` writer stamp today;
Q6a ruled: don't add one).

### 7. Compatibility lock

With no `systemOne.resolve` key set and no classifier provided: the screen
prologue returns immediately (no classifier read, no floor read, no
warning) and `runResolve` behaves byte-identically to today — same prompt,
same batching, same outputs. `'llm'` is today exactly. `classify` present
but the key unset changes nothing (REQ-COMPAT-01.5, `types.ts:811-813`).
The generative prompt builder (`buildOpsResolvePrompt`) is untouched.

### 8. Disclosed docstring/spec-text updates

- `systemOne.ts` docstrings: `'resolve'` joins the promised-sites list it
  already names (`systemOne.ts:5-8`); `SystemOneConfig.resolve` docstring
  as in §2. The `SystemOneThresholdSite` one-line docstring
  (`systemOne.ts:12`) updates its member count.
- `engineDefaults.ts` resolver comments mirror the step-10 wording with
  site-specific rationale (data-loss asymmetry).
- Roadmap step 11 row gets its Done mark in this PR's cleanup commit
  (controller adjudication D1, 2026-11-22 — roadmap rule beats the
  earlier draft wording; step-10 precedent: the Done line rode PR #459's
  cleanup commit).

## Explicitly out of scope / rejected alternatives

- **Heal screening** — step 12 / S1-0 PR 6 (`'healScreen'`). Ruled
  separately; heal may forget (owner ruling 2026-11-20).
- **Type-on-write / ingest typing** — steps 13/14.
- **The backfill node-type resolution site**
  (the typing chain at `MaintenanceService.ts:2171`; node-type matching
  itself is `resolveNodeTypeMatch` in `OntologyService.ts:125`) —
  that is typing (S1-0 PR 1 territory), not entity resolution. Named here
  only to fence the word "resolution".
- **Legacy strategy** — no resolve site exists there
  (`legacy.ts` grep-verified); extending the gate/resolve split to legacy
  is not a roadmap step.
- **A `'choice'` question over the four ops** (ADD/UPDATE/SUPERSEDE/NOOP
  as classifier options) — rejected: a small binary
  model answering "same fact?" is the question it can actually answer;
  op selection between UPDATE/SUPERSEDE needs generative context (valid_from
  semantics).
- **Screening inside `gateCandidates`** — rejected: the gate is pure/local
  and runs for every candidate; the classifier screen belongs to the
  resolve site where the ambiguous set is already known and the ops
  receipts are scoped.

## Open questions — ALL RESOLVED (owner rulings 2026-11-22, msg `1574134804725760061`)

Kurt: "As recommended across the board… Consider this your formal ruling.
Lock the spec, generate the Tier-3 plan, and proceed to the implementer
wave."

1. Confident-NO handling → **(b) fall through to generative.** "A false
   negative (confident NO on an actual duplicate) leads to silent data
   duplication; letting the generative path double-check limits our
   downside risk."
2. Posture → **Yes, Posture A** — explicit `minConfidence.resolve` floor
   required under `'auto'`. "Matches the strict boundary precedent set in
   Step-10 and prevents silent, unconfigured graph alterations."
3. Neighbour coverage → **Best neighbour only** (`neighbours[0]`).
   "Keeps the token spend linearly bounded while still capturing the vast
   majority of deduplication hits."
4. Keyword mode → **Engage.** "Essential. Since keyword mode is the
   highest-volume generative path, skipping the screen here would leave
   too much money on the table."
5. Warning scope → **Once per process.** "Keeps the logs honest without
   turning into unreadable spam."
6. Receipts depth → **(a) No writer stamp; (b) no `LibrarianResult`
   counters.** "The existing fact_deduplicated receipt with the
   reason: 'classifier' flag provides the exact audit trail needed
   without bloating the public LibrarianResult surface."
7. Floor domain → **[0.5, 1].** "A sub-0.5 confidence on a binary
   deduplication check is a literal coin toss. Wrong-NOOPs destroy data;
   the floor must protect against this."
8. YES terminality → **(a) Terminal NOOP wherever the screen runs.** "With
   the explicit floor, the duplicate-only wording, and the receipts in
   place, a confident YES is rigorous enough to act on terminally."

## Files touched

- `packages/core/src/config/systemOne.ts` — `'resolve'` site member (one
  line), `SystemOneConfig.resolve` key + docstring.
- `packages/core/src/utils/engineDefaults.ts` —
  `resolveSystemOneResolve`, `resolveResolveMinConfidence` (both beside
  their step-10 siblings; `warnOnce` reused).
- `packages/core/src/services/librarian/ops/resolve.ts` — screening
  prologue + fallthrough; generative leg otherwise untouched.
- `packages/core/src/services/librarian/ops/index.ts` — emission loop for
  classifier-settled NOOP receipts through the pass-level DiagnosticBuffer
  (§6).
- `packages/core/src/index.ts` — export the two new resolvers (new public
  surface, same as step 10's exports at `index.ts:29-31`).
- Tests: `packages/core/__tests__/opsResolve.test.ts` (screen prologue,
  fallthrough, empty-batch skip, warn-once contracts, compatibility
  byte-identity), `packages/core/__tests__/systemOneConfig.test.ts` +
  `engineDefaults.test.ts` (key/floor resolution contracts), and an
  ops-pass-level test beside `opsLibrarian.test.ts` (screen → apply flow,
  receipts markers).

## Test plan

1. Compatibility (§7): no key + no classifier → screen prologue is a no-op;
   `buildOpsResolvePrompt` receives identical input; existing
   `opsResolve.test.ts` suite passes untouched.
2. Key resolution (§2): unset → `'llm'`; `'auto'`/`'llm'` valid; invalid
   value warns once and treated as unset; `classify` present without the
   key changes nothing.
3. Floor (§3): `minConfidence.resolve` read only under `'auto'`; missing
   under `'auto'` → warnOnce + `'llm'` (posture A, CONFIRMED); invalid
   (NaN, out of [0.5, 1]) treated as unset with the chain continuing;
   endpoints `0.5` and `1` valid (`??` not `||`).
4. Screen (§4): confident YES ≥ floor → NOOP on the aliased neighbour;
   NO/certainty-band answers fall through to generative (CONFIRMED);
   abstain-shaped answers
   (malformed/missing probability) are rejected untrusted and fall through;
   per-candidate scoping holds (a YES for candidate A's n1 never settles
   candidate B); an update-shaped pair (same entity, new content) does NOT
   settle as NOOP under the duplicate-only question (red-first, per the
   Opus M1 fix).
5. Fallthrough (§5): mixed settle/fallthrough batches send only `rest` to
   the LLM; empty `rest` makes zero LLM calls; classifier unavailable or
   throwing mid-pass → `settled` is empty (all-or-nothing, per the Opus M3
   fix), one warning, whole-batch fallthrough, pass still applies.
6. Receipts (§6): a classifier-settled NOOP emits EXACTLY ONE existing
   `fact_deduplicated` diagnostic with `detail.reason: 'classifier'`
   (via `ops/index.ts`'s pass-level DiagnosticBuffer); zero NEW diagnostic
   codes and zero `LibrarianResult` surface change asserted (both RULED
   OUT); ops apply applies settled `ResolvedOp`s
   identically.
7. Red-first TDD throughout; full core suite green (baseline at
   `206936cc` — re-measure at lane open; step 10 landed at 255 files /
   3014 tests) and `pnpm --filter @equationalapplications/core-llm-wiki
   typecheck` clean.
