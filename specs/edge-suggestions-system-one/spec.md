# Spec — Step 10: Edge suggestions from System-One

Status: Draft 2026-11-22 — pending owner approval.
Base: origin/main @ `c0aa79e3`. Every pin below re-verified live against the
worktree (line numbers match origin/main). Repo: expo-llm-wiki. Product
rule: hosts bring their own models; core stays unopinionated about providers.

## Problem

The ontology-backfill generative path proposes edges
(`packages/core/src/services/MaintenanceService.ts:2343-2350` parses
`classifications[].edges`; `_applyOntologyBackfillBatch` validates, stages,
and persists them at `:2719`, `:2734`, `:2779-2781`, `:2786-2790`), but a
host cannot turn edge suggestion off, tune it, or receipt its suppression.
Roadmap step 10 says the edge-suggestion site "opts in to the configured
model" (`docs/ROADMAP.md:262-267`), and edge suggestion is additive — a
wrong edge is a wrong fact, not a lost one — so it runs first among the site
conversions. The S1-0 spec reserved exactly one new `'edges'` line in
`SystemOneThresholdSite` for this PR (`specs/system-one-config/spec.md:67-71`)
and fenced `edges (PR 3)` out of S1-0 (`spec.md:265-272`). No
`systemOne.edges`-adjacent key exists today.

## Root cause with evidence

- `SystemOneThresholdSite` is `'typing'` only
  (`packages/core/src/config/systemOne.ts:12`); the docstring already
  promises `'edges'` as a one-line sibling addition.
- The backfill model choice is already a System-One decision:
  `resolveSystemOneTyping` at `MaintenanceService.ts:2165` (chain
  `:2161-2164`). The classifier path proposes NO edges
  (`MaintenanceService.ts:2469`; `systemOne.ts:17`). So the generative
  backfill path is the only site whose *model choice* is a System-One
  surface — the natural home for an `'edges'` gate.
- The generative output schema carries **no confidence**
  (`packages/core/src/prompts.ts:61-63` — `classifications` entries are
  `{id, okf_type, edges}` only), so a numeric confidence floor on generative
  edges is undefined. Today no floor exists on any edge write.
- Edge validation is site-independent and already strict:
  `validateInlineEdges` (`packages/core/src/utils/ontology.ts:337-353`) and
  `OntologyService.resolveEdges`
  (`packages/core/src/services/OntologyService.ts:157-212` —
  `type_not_in_manifest`, `target_not_found`, `target_type_mismatch`,
  `no_source_type`), drops surfaced as `edge_dropped` diagnostics; persistence
  is additive via `addIgnoreDuplicate` (`OntologyService.ts:214-237`).
- Other edge-producing sites (ingest `IngestionService.ts:217-218`,
  `:876`, `:953-963`; librarian ops `extract.ts:271` → `apply.ts:108-240`;
  librarian legacy `legacy.ts:78-82`) share the host provider and read no
  `systemOne.*`. Heal is not an edge site (R-EDGE: heal waits PR 6
  replaces-link).
- Step-9 mechanics at the same call site stand: `runBatched` with
  `maxPromptChars = resolveMaxPromptChars(resolveContextBudget(config),
  'backfill')` and step-8 shortlist sections feed the same prompt
  (`specs/backfill-cap-context-budget/spec.md`). Step 10 touches the
  parse/apply side, not the cap side.

## Proposed change

### 1. One new line in `SystemOneThresholdSite`

`packages/core/src/config/systemOne.ts:12` becomes:

```ts
export type SystemOneThresholdSite = 'typing' | 'edges';
```

Exactly one new member, exactly per the S1-0 merge fence
(`specs/system-one-config/spec.md:67-71`). This is type-level surface so
`minConfidence` stays closed under the site union; the operative gate is §2.

### 2. Boolean opt-out gate `systemOne.edges`

Add `edges?: boolean` to `SystemOneConfig` (`systemOne.ts`, beside
`onLowConfidence`), default `true` — today's behavior. Rationale: the
generative schema carries no confidence (`prompts.ts:61`), so a numeric
`minConfidence.edges` floor has nothing to compare against; the roadmap's
"opts in to the configured model" reads as the *site* joining the
System-One config surface, not as a confidence gate. A boolean keeps the
host knob honest: off means the generative site proposes no edges. (The
numeric-threshold reading is preserved as open question 2 for the owner.)

Resolution: `resolveSystemOneEdges(config)` in
`packages/core/src/utils/engineDefaults.ts`, returning
`config?.systemOne?.edges ?? true`. No call option — edge gating is a
config-level stance, not a per-call tuning. An invalid (non-boolean) value
warns once and is treated as unset (the S1-0 §2 treated-as-unset contract,
via the existing `warnOnce` helper), so the default `true` applies.

### 3. The gate wires into the generative backfill apply path only

In `_applyOntologyBackfillBatch`, resolve the gate once per pass in
`doRunOntologyBackfill` (beside the typing-chain resolution at
`MaintenanceService.ts:2165`) and plumb it EXPLICITLY —
`_applyOntologyBackfillBatch` has two callers, the generative one at
`:2379` (`writer 'llm'`) and
the classifier one at `:2573-2579` (`writer 'classifier'`), so a defaulted
parameter would silently gate or ungate the wrong path. The gate rides
`runOpts` (whose required fields are asserted at `:2269-2279`): add the
field at BOTH `_runGenerativeBackfill` call sites — the first pass
(`:2231-2238`) and the escalation leg (`:2201-2209`) — or a gated-off
escalated fact would still write edges. No `doRunOntologyBackfill` direct
call exists. (The classifier caller passes no edge gate under the current
boolean design; its role may change with open question B1/2's ruling.)
When gated off, the classification's
`edges` field is treated as absent at the `validateAndNormalizeFact` call
(`MaintenanceService.ts:2734` — pass `edges: undefined` instead of the
cast), so `pendingEdges` never gains entries (`:2719`, `:2779-2781`),
`resolveAndPersistEdges` is never reached for that fact (`:2786-2790`), and
no `edge_dropped` diagnostics fire for suppressed edges (nothing was
validated). Everything downstream — typing, receipts, counters — is
untouched. The classifier path (`MaintenanceService.ts:2469`, no edges) is
unaffected by construction.

### 4. Suppression receipts

When the gate is off and a classification carried a proposed-edges payload —
`Array.isArray(classification.edges) && classification.edges.length > 0`
(the field is typed `unknown` at the parse site, `:2344`) — emit one
`edge_suggestion_suppressed` diagnostic per fact — content-free:
`{ factId }` only — riding the existing diagnostic buffer pattern
(`MaintenanceService.ts:2746-2755` door-receipt precedent). A non-array
`edges` value is invalid input, not a suppressed suggestion: it takes no
receipt and flows to the existing `edge_dropped` validation path unchanged.
The receipt fires on the model's suggestion, independently of the fact's
subsequent typing outcome: a gated-off fact whose `okf_type` fails
validation (the `!normalized.okf_type` continue at `:2754-2757`) or that is
omitted as concurrently typed (`:2763-2766`) still receipts the suppression
— the receipt region executes before both continue paths. The earlier
unknown-or-duplicate-id continue (`:2723-2726`) comes BEFORE the receipt
region and gets no receipt: a classification whose fact cannot be matched
dropped nothing that existed. When the gate is on, or the model supplied no
edges payload, no receipt fires. New code `edge_suggestion_suppressed`
added to `WikiDiagnosticCode` with fixed severity `'info'` (a config-driven
omission notice, not a failure) and the fixed message template
`'A model-suggested edge was suppressed by the systemOne.edges gate.'`
(S1-0 §7 pattern). Both
`SEVERITY` and `MESSAGE` in `packages/core/src/utils/diagnostics.ts` are
exhaustive `Record<WikiDiagnosticCode, …>` maps (`diagnostics.ts:18`,
`:73`), so the new code requires an entry in **both** (fixed message
template, no interpolation — REQ-DIAG-03).

### 5. Compatibility lock

With no `systemOne` key set: the resolver returns `true`, edges are proposed
exactly as today, no new receipts fire, and behavior is byte-identical on
every path including legacy `'auto'` typing. Capability alone never
switches paths (REQ-COMPAT-01.5, `types.ts:812`). This spec adds no call
options, no prompt changes, no counter changes, and no scheduler changes.

## Explicitly out of scope / rejected alternatives

- Gating ingest fact-edges (`IngestionService.ts:953-963`) or librarian
  edges (`apply.ts:165`) — the S1-0 §10 fence (`spec.md:265-272`) plus the
  roadmap's singular "the edge-suggestion site" that "runs first among the
  site conversions" (`ROADMAP.md:262-264`) scope this PR to the backfill
  generative site; ingest/librarian are later site conversions. Carried as
  open question 1, not implemented here.
- A numeric `minConfidence.edges` floor — generative output has no
  confidence (`prompts.ts:61`); a floor would compare nothing. The
  `'edges'` union member keeps the door open if a later PR adds confidence
  to generative output.
- Any change to edge validation, `resolveEdges`, title-index construction,
  `ontology_updates` handling, or `runBatched`/the step-9 prompt cap — all
  site-independent mechanics stay untouched.
- Heal-path edges (R-EDGE: waits PR 6 replaces-link).
- A prompt change telling the model not to propose edges when gated off.
  Rejected: the parse-side drop is sufficient, keeps the prompt cache-stable
  across config flips, and the suppression receipt makes the drop visible.

## Open questions for the owner

1. Scope: does `'edges'` gate only the backfill generative site, or also
   ingest/librarian fact-edges? **Recommendation: backfill only** — the §10
   fence and "runs first among the site conversions" both point there; the
   other sites are later conversions with their own specs.
2. Gate shape: boolean opt-out vs numeric threshold, given the generative
   schema carries no confidence (`prompts.ts:61`). **Recommendation:
   boolean** (`systemOne.edges`); the `'edges'` union member (§1) preserves
   the threshold option for a future confidence-bearing schema.
3. Default when unset: edges proposed (today's behavior) or suppressed
   until opted in? **Recommendation: proposed** — the compat discipline
   (REQ-COMPAT-01.5) holds that adding config capability never flips paths;
   a default-off flip would silently change behavior for every host with no
   `systemOne` config. Confirm the roadmap's "opts in" wording does not
   intend a breaking default. (REQ-COMPAT-01.5: `types.ts:812`.)
4. Escalation interaction: under `onLowConfidence: 'llm'` (S1-0 §4), escalated
   facts reach the same generative step. Do they propose edges under the
   same gate? **Recommendation: yes** — the gate is pass-level, applied in
   `_applyOntologyBackfillBatch`, which both first-pass and escalated facts
   flow through; a separate escalation rule would double the surface for
   one config key.
5. Receipts when gated off: silently drop, or emit
   `edge_suggestion_suppressed { factId }`? **Recommendation: receipt** —
   S1-0 §6 established that omissions carry receipts; a silent drop would
   repeat the gap S1-0 closed.
6. Does the gate cover `ontology_updates.edge_types` proposals (manifest
   edge-type emergence) or only per-fact `edges`? **Recommendation:
   per-fact edges only** — emergent type merge and strict-mode rejection are
   separate channels (`IngestionService.ts:879-897`) and this PR does not
   touch the backfill `ontology_updates` path.
7. Is R-EDGE (edge copy at supersede + re-ingest, owned by PR 4; heal waits
   PR 6) orthogonal to this gate? **Recommendation: state orthogonal** —
   R-EDGE fixes copy semantics for existing edges; this gate controls
   whether *new model-proposed* edges enter at all. No interaction.
8. Legacy `'auto'` typing with no new keys: edges stay on and unchanged
   (§5). **Recommendation: confirm** — this is the REQ-COMPAT-01.5
   assertion; the test plan pins it.
9. Dead config footgun: adding `'edges'` to the site union makes
   `systemOne.minConfidence.edges` valid TypeScript with **no consumer**
   (`minConfidence` is read only for `'typing'` — `systemOne.ts:21-22`;
   `engineDefaults.ts:186-196` resolves only the typing floor). A host
   setting `{edges: 0.9}` gets silently dead config. **Recommendation:**
   warn once, naming the key, that `minConfidence.edges` has no consumer
   at this site yet (same warn-once discipline as §2's invalid-value
   path); alternatively accept the dead key and document it. Owner pick.

## Files touched

- `packages/core/src/config/systemOne.ts` — `'edges'` joins
  `SystemOneThresholdSite` (one line, §1); `edges?: boolean` on
  `SystemOneConfig` (§2).
- `packages/core/src/utils/engineDefaults.ts` — `resolveSystemOneEdges`
  (§2) plus the invalid-value `warnOnce` path.
- `packages/core/src/services/MaintenanceService.ts` — resolve once per
  pass in `doRunOntologyBackfill` (beside `:2165`); gate wiring in
  `_applyOntologyBackfillBatch` (`:2734` region, `:2719`/`:2779-2781`
  become no-ops when gated); `edge_suggestion_suppressed` receipt
  (`:2746-2755` region).
- `packages/core/src/types.ts` — `WikiDiagnosticCode` gains
  `edge_suggestion_suppressed` with a fixed severity (§4).
- `packages/core/src/utils/diagnostics.ts` — `SEVERITY` and `MESSAGE`
  entries for `edge_suggestion_suppressed` (both maps are exhaustive
  `Record<WikiDiagnosticCode, …>` — `diagnostics.ts:18`, `:73`; §4).
- `packages/core/__tests__/` — test plan below.
- `packages/core/src/index.ts` — export the new resolver beside the S1-0
  resolvers.
- Docs, same PR: the `systemOne` rows in
  `apps/docs/src/content/docs/reference/configuration.md` and the
  ontologies guide gain the `systemOne.edges` key.

## Test plan

Vitest, beside the existing backfill tests:

1. Resolver: unset/undefined → `true`; explicit `false` → `false`; explicit
   `true` → `true`; non-boolean warns once and resolves `true`.
2. Gated off: a classification carrying valid edges produces no
   `pendingEdges`, no persisted edges, no `edge_dropped` diagnostics, and one
   `edge_suggestion_suppressed { factId }` receipt; typing and
   `node_type_assigned` receipts unchanged.
3. Gated off, no edges supplied: no suppression receipt (receipt fires only
   when the model proposed edges).
4. Gated on / unset: byte-identical to the pre-PR baseline — same persisted
   edges, same `edge_dropped` diagnostics, no new receipts.
5. Escalation: under `onLowConfidence: 'llm'` with the gate off, escalated
   facts typed by the generative step propose no edges and receipt the
   suppression (open question 4's recommended behavior, pinned as the
   contract).
6. Classifier path: with typing `'auto'` and the gate off, the classifier
   step is unaffected and proposes no edges (unchanged `:2469` invariant).
7. Compat: with no `systemOne` key, a full pass matches the pre-PR baseline
   across typing modes `'llm'` and `'auto'`, including edge counts and the
   step-9 `maxPromptChars` mechanics at the same `runBatched` call.
8. Gated off, invalid-type fact: a classification whose `okf_type` fails
   manifest validation still emits `edge_suggestion_suppressed` (§4
   ordering pin — the receipt precedes the `failedValidation` continue),
   and the pass's `failedValidation` count is unchanged by the gate.
9. Gated off, escalation counter: under `onLowConfidence: 'llm'` with the
   gate off, the merged pass result reports `edgesAdded: 0` (the counter
   merge sums classifier + generative at `MaintenanceService.ts:2215-2225`;
   the generative leg must contribute zero).
10. Vocabulary: `ontologyReceiptVocabulary.test.ts` extends both its code
   list and its severity assertions with `edge_suggestion_suppressed`
   (fixed message template present — REQ-DIAG-03).
11. Gated off, unmatched classification: a classification whose `id` matches
    no batch fact (the `:2723-2726` continue) emits NO suppression receipt —
    the receipt region is never reached for it (§4 ordering pin).
