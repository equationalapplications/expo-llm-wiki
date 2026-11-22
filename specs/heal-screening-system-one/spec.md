# Spec — Step 12: Heal screening from System-One

Status: Draft 2026-11-22 — pending owner approval
Base: branch `tessera/session1-laneA` @ `206936cc`. Every pin below re-verified
live against this worktree (`.sdd/step12/pins-recon.md` is the pin report;
line numbers match it except where this spec quotes the live file directly).
Repo: expo-llm-wiki. Product rule: hosts bring their own models; core stays
unopinionated about providers.

## Problem

Heal's model-directed destructive actions are ungated and unauditable. In
`doRunHeal` (`packages/core/src/services/MaintenanceService.ts:1710-2100`)
the LLM parse (`MaintenanceService.ts:1861-1870`,
`parseJsonResponse<{ downgraded: string[], deleted: string[], newFacts }>`)
feeds a mutable-ids guard (`:1889-1911` — the model may only act on
candidates it was actually offered) and then applies
`downgradeByIds`/`softDeleteByIds` in the transaction (pins §1, the apply
seam at `MaintenanceService.ts:1947-1949` — `withTransactionAsync` opens
at `:1947`, `downgradeByIds`/`softDeleteByIds` run at `:1948-1949`).
There is NO confidence gate anywhere in this path: heal is purely
generative (`callLlm` at `:1860`; `callClassify` is imported at `:39` but
used only in ontology-backfill/classifier paths), and the heal response
schema carries **no per-id confidence**
(`packages/core/src/prompts.ts:41-48` — `downgraded`/`deleted` are bare
fact-ID string arrays). Separately, `HealResult` returns only COUNTS
(`packages/core/src/types.ts:211-249`; `downgraded: allDowngraded.size`,
`deleted: allDeleted.size` at `MaintenanceService.ts:2085-2093`) — the
union sets `allDowngraded`/`allDeleted` exist at `:2085-2086` but are
collapsed to numbers, so a host cannot audit WHICH facts heal changed.

Roadmap step 12 fixes both halves: the heal screen "opts in to the
configured model", heal "may forget when the host runs it (owner ruling,
2026-11-20)", and the step "ships the per-fact receipts (`heal_deleted`,
`heal_downgraded`) and the changed-id lists that make such moves
auditable, and documents the prune and event-retention clocks a host must
set to audit them" (`docs/ROADMAP.md:280-288`). The S1-0 fence already
reserves the surface: `'healScreen'` joins `SystemOneThresholdSite` as
ONE new line (PR 6 per `specs/system-one-config/spec.md:265-272` and the
fence comment at `packages/core/src/config/systemOne.ts:2-9`), and
`minConfidence` is already
`Partial<Record<SystemOneThresholdSite, number>>` (`systemOne.ts:35`),
so the union member exists to carry a floor. `healScreen` exists nowhere
in TS code today (pins preamble). Neither `heal_deleted` nor
`heal_downgraded` exists in `WikiDiagnosticCode`
(`types.ts:918+`; only `heal_skipped` at `:927`).

## Root cause with evidence

- `SystemOneThresholdSite` is `'typing' | 'edges'` only
  (`systemOne.ts:13`); the fence text already names `'healScreen'` as a
  one-line sibling addition (`systemOne.ts:6-8`).
- The resolver pattern to mirror is complete and shipped:
  `resolveSystemOneEdges` (`packages/core/src/utils/engineDefaults.ts:159-169`,
  `config?.systemOne?.edges ?? 'llm'`, warnOnce-on-invalid via the
  treated-as-unset contract, `??` throughout per the `:120` comment) and
  `resolveEdgesMinConfidence` (`engineDefaults.ts:231-243`; validator
  `isEdgesFloor` [0.5, 1] at `:221-222`; missing/out-of-domain floor under
  `'auto'` → warnOnce naming the key → `undefined`, site resolves
  `'llm'`).
- Heal has NO classifier and NO confidence to floor today: the response
  schema is id lists only (`prompts.ts:44-45`), the parse normalizes
  non-arrays to `[]` (`MaintenanceService.ts:1865-1866`), and the
  `'edges'` step's classifier machinery (`callClassify`) is not part of
  heal. Unlike edges/typing — where `'auto'` switches to a cheaper
  classifier path with the generative path as fallthrough — heal IS the
  generative path; there is no second engine to screen with. The
  `'healScreen'` opt-in therefore necessarily means: floor the confidence
  the generative model itself declares in its verdicts, which requires a
  response-contract change (open question 1).
- The deterministic SQL passes are NOT model output: orphan-marking and
  stale-inferred downgrade run as SQL before candidate selection
  (`orphanedIds`/`staleDowngradedIds` at `MaintenanceService.ts:1750-1762`
  per pins §1) under the host's own clock knobs
  (`orphanAfterDays`, `staleInferredAfterDays`,
  `packages/core/src/types.ts:360-361`). Their effects are already
  deterministic, host-configured, and rule-driven — gating them on a
  model-declared confidence is a category error; this spec gates ONLY
  the model-directed sets (`safeDowngraded`/`safeDeleted`).
- Receipt precedent: per-fact diagnostics via `diagBase`/`diagBuffer`
  exist in this very function — `heal_skipped` per-fact pushes at
  `MaintenanceService.ts:2030-2032`
  (`detail: { factId: item.id, reason }`, flush `:2033`) and the keyword
  outage emit at `:1772` (pins §4). The per-fact receipt SHAPE to mirror
  is `edgeDropDiagnostic` (`packages/core/src/utils/diagnostics.ts:271-289`:
  detail carries `reason`, `factId`, plus site-specific locators, omitted
  rather than nulled).
- Changed-id machinery exists and is thrown away: `healSyncIds`
  (`MaintenanceService.ts:2040-2046`) already unions
  orphanedIds ∪ staleDowngradedIds ∪ safeDowngraded ∪
  uniqueDeletedFactIds ∪ inserted ids for the search sync
  (`:2047`), and `deliverHealRemovals(entityId, ids, trigger)` delivers
  removed ids at `:2049` (helper at `:1459-1474`). No `changedIds`-style
  field exists anywhere on a result type yet (closest: ImportExportService
  `removedIds`, pins §5 — import path only).
- The host-clock knobs are scattered, not consolidated:
  `pruneEventsAfter` (`types.ts:350`), `pruneRetainSoftDeletedFor`
  (`:351`), `pruneSupersededAfter` (`:352-357`, default null = keep
  history forever), `orphanAfterDays` (`:360`),
  `staleInferredAfterDays` (`:361`). Retention-is-host-policy language
  exists at `specs/expire/spec.md:151-152`; the retention diagnostic
  `event_retention_held` is at `types.ts:942` /
  `diagnostics.ts` MESSAGE map. **No doc consolidates the host clock
  set — the documentation deliverable of this step is genuinely new**
  (pins §7).
- Peer-lane overlap (step-11 `'resolve'`) is real and fenced: both lanes
  append one union member at `systemOne.ts:13`, sibling resolvers in
  `engineDefaults.ts`, exports in `src/index.ts:29-32`, describes in
  `systemOneConfig.test.ts`, and both edit the `types.ts:403-409` doc
  comment; the export-surface lock test at
  `systemOneConfig.test.ts` (`public export surface` describe, pins §8
  L543) must be updated by whichever lane lands second. This lane
  touches `MaintenanceService.ts` ONLY in the heal region
  (L1710-2100) plus the shared import line (pins §9).

## Proposed change

### 1. One new line in `SystemOneThresholdSite`

`systemOne.ts:13` becomes:

```ts
export type SystemOneThresholdSite = 'typing' | 'edges' | 'healScreen';
```

Exactly one new member, exactly per the S1-0 merge fence
(`specs/system-one-config/spec.md:265-272`; fence comment
`systemOne.ts:2-9`). One line, so the peer lane's `'resolve'` member
merges cleanly. No `'off'` mode (see §8 and the edges precedent,
`systemOne.ts:30-31`).

### 2. Engagement key `systemOne.healScreen: 'auto' | 'llm'`

Add to `SystemOneConfig` (beside `edges`, `systemOne.ts:33`):

```ts
/**
 * Heal-screen mode. `'llm'` (default) keeps heal exactly as today: every
 * model-directed verdict the mutable-ids guard admits is applied, no
 * confidence is read. `'auto'` floors each model-directed downgrade and
 * delete on the confidence the model declares in its verdict (§4): at or
 * above the `minConfidence.healScreen` floor the verdict applies with a
 * per-fact receipt (§5); below it the verdict is withheld — the fact is
 * left untouched, never silently discarded, and the withheld move is
 * itself receipted (§5). The deterministic SQL passes (orphan-marking,
 * stale-inferred downgrade) are rule-driven host policy and are NEVER
 * gated by this key (§4). There is no `'off'`: this PR adds no
 * configuration that can silently discard a model-directed heal action.
 */
healScreen?: 'auto' | 'llm';
```

Resolution: `resolveSystemOneHealScreen(config)` in
`engineDefaults.ts`, returning `config?.systemOne?.healScreen ?? 'llm'`;
a present non-`'auto'`/non-`'llm'` value warns once via the existing
`warnOnce` helper and is treated as unset — the S1-0 §2
treated-as-unset contract, mirroring `resolveSystemOneEdges`
(`engineDefaults.ts:159-169`) verbatim, `??` not `||`. No call option
(heal-screen mode is a config-level stance, not per-call tuning) and no
legacy chain (none exists to preserve).

### 3. Floor `minConfidence.healScreen`

Add `resolveHealScreenMinConfidence(config)` in `engineDefaults.ts`,
posture A (mirroring the edges owner ruling, edge-suggestions spec §3):
**the key `systemOne.minConfidence.healScreen` is REQUIRED whenever
`healScreen` resolves `'auto'`** — there is NO default floor (the
default `'llm'` mode never reads one); a missing floor under `'auto'`
warns once via the existing `warnOnce` helper, naming the key, and the
site resolves `'llm'` (ungated heal exactly as today). Valid only in
**[0.5, 1]**, reusing the edges validator shape (`isEdgesFloor`,
`engineDefaults.ts:221-222`): below 0.5 a floor would apply verdicts the
model itself rates below coin-flip, which gates nothing meaningfully —
the domain cannot widen to [0, 1]. A present value outside [0.5, 1]
warns once and the site resolves `'llm'`. Resolver shape mirrors
`resolveEdgesMinConfidence` (`engineDefaults.ts:231-243`) exactly,
substituting the `healScreen` key.

Floor semantics differ from edges in ONE respect, disclosed: the edges
floor is directional on a binary answer (the `p > 0.5` /
`1−p ≥ floor` band rule); the heal floor is ONE-SIDED on a per-verdict
confidence — `confidence ≥ floor` applies the verdict, `confidence <
floor` withholds it. There is no "confident no is terminal" band: heal's
input is a list of candidate facts and the model simply omits ids it
finds healthy, so absence-of-verdict already means no action.

### 4. Where the screen sits in `doRunHeal`

The screen sits BETWEEN the mutable-ids guard and the transaction apply:

- In: the MODEL-DIRECTED sets only — `safeDowngraded`/`safeDeleted`
  (post-guard, `MaintenanceService.ts:1910-1911`), per-fact, before
  `downgradeByIds`/`softDeleteByIds` run in the tx (pins §1, apply seam
  `MaintenanceService.ts:1947-1949`).
  Per-fact granularity: one verdict per (id, action); a fact id in both
  sets is applied/withheld independently per action, exactly as the
  guard admits them independently today.
- OUT, stated explicitly: the deterministic SQL passes are NOT gated —
  `orphanedIds` (orphan-marking) and `staleDowngradedIds`
  (stale-inferred downgrade) are rule-driven on host clocks
  (`types.ts:360-361`), contain no model output, and are not
  confidence-bearing. Gating them would let a model-declared number
  veto host policy; this spec does not do that.
- OUT: `newFacts` insertion (additive, validated by `validateFact` at
  `:1918`, drops receipted as `fact_rejected` at `:1924`) — a screen
  that discards synthesized repairs would contradict the no-silent-
  discard rule; `newFacts` confidence is the existing
  `certain|inferred|tentative` enum (`prompts.ts:46`), not a number.
- Outcome rule per verdict, under resolved `'auto'`:
  - `confidence ≥ floor` → apply as today.
  - `confidence < floor` → WITHHOLD: a below-floor delete does not run,
    a below-floor downgrade does not run; the fact is left untouched.
    Withholding is not data loss (the fact survives; the next heal pass
    re-reviews it), so no generative fallthrough machinery is needed —
    there is no alternative engine for heal to fall through TO. The
    withheld move is receipted (`detail.reason: 'below_floor'`, §5) so
    the host sees what heal chose not to do.
  - Missing confidence (§2 contract migration) → apply as today AND
    warn once (open question 1 wire-compat; §2 contract migration).
- Mode/floor plumbing is explicit, never defaulted: resolved ONCE at
  `doRunHeal` entry beside `diagBase` (`MaintenanceService.ts:1723`),
  then used at the guard/apply seam. No change to
  `runHealMaintenance`-level signatures, `batchSize` validation
  (`:1721-1726`), the keyword-outage early return (`:1766-1794`,
  its `heal_skipped` emit unchanged), or `HealResult` consumers other
  than the additive §6 fields.

### 5. Receipts — `heal_deleted` and `heal_downgraded`

Two new codes in `WikiDiagnosticCode` (`types.ts:918+`, after
`heal_skipped` at `:927`) with SEVERITY (`info` both — receipts record
compliance, not problems; contrast `heal_skipped: 'warn'`,
`diagnostics.ts:27`) and MESSAGE entries in BOTH exhaustive maps of
`packages/core/src/utils/diagnostics.ts` (the file's other exhaustive
maps change with them). Suggested messages:
`heal_deleted: 'Heal soft-deleted a fact (or withheld the delete below the confidence floor).'`
`heal_downgraded: 'Heal downgraded a fact to tentative (or withheld the downgrade below the confidence floor).'`
(These messages and the `detail` shapes below assume open question 1
resolves (a); adjust if it resolves (b).)

Emission mirrors the `heal_skipped` per-fact pattern
(`MaintenanceService.ts:2030-2033`): per-fact, through `diagBase` /
`diagBuffer`, flushed once at `:2033`'s flush point. Shape mirrors
`edgeDropDiagnostic` (`diagnostics.ts:271-289`) — `detail` carries
`reason`, `factId`, and omits unknown locators rather than sending
nulls:

- APPLIED (under resolved `'auto'` only) model-directed delete →
  `heal_deleted`, `detail: { factId, reason: 'applied' }`.
- APPLIED (under resolved `'auto'` only) model-directed downgrade →
  `heal_downgraded`, `detail: { factId, reason: 'applied' }`.
- WITHHELD (below floor, under resolved `'auto'` only) → same code as
  the action, `detail: { factId, reason: 'below_floor', confidence }`
  (confidence included when the model declared one; this detail shape
  also assumes open question 1 resolves (a) — adjust if it resolves
  (b)). A missing-confidence verdict that fires under `'auto'` is
  receipted like any applied move — same code,
  `detail: { factId, reason: 'applied' }`, with the `confidence` field
  omitted.

Volume pin: ONE diagnostic per (fact, action) — a pass that deletes 40
facts emits 40 receipts, not one summary; receipts are the audit trail
and must be per-fact to serve it. SQL-pass actions get NO receipts
(open question 3) — their ids land in the §6 changed-id lists instead,
which keeps the diagnostic surface proportional to model-driven risk.

### 6. Changed-id lists on `HealResult`

`HealResult` (`types.ts:211-249`) gains two additive fields, populated
from the sets that already exist at `MaintenanceService.ts:2085-2086`:

```ts
/** Every fact id this heal run left at reduced confidence (stale-inferred SQL pass plus model-directed downgrades, deduped) — the ids behind `downgraded`. */
downgradedIds: string[];
/** Every fact id this heal run soft-deleted (orphan SQL pass plus model-directed deletes, deduped) — the ids behind `deleted`. */
deletedIds: string[];
```

`downgraded: allDowngraded.size` /
`deleted: allDeleted.size` (`:2091-2092`) become
`downgradedIds: Array.from(allDowngraded)` /
`deletedIds: Array.from(allDeleted)` (counts kept for compat). Both
lists are already computed for `healSyncIds` (`:2040-2046`) — this is
surfacing, not new machinery. Inserted `newFacts` ids are NOT added
(open question 4 covers the shape; `newFactsCreated` counts and the
facts are queryable). Wire compatibility is trivial (additive fields;
`packages/react/src/useWikiMaintenance.ts:7` consumes `HealResult`
wholesale).

### 7. Documentation — the host clock set (new doc deliverable)

The spec's doc section (implemented in
`apps/docs/src/content/docs/reference/configuration.md` + the heal/
maintenance guide, same PR) consolidates, for the first time, the clock
knobs a host must set for heal moves to be auditable — no doc does this
today (pins §7):

- `orphanAfterDays` (`types.ts:360`) — feeds the
  orphan-marking SQL pass (`MaintenanceService.ts:1750-1762`). Unset
  resolves to **30 days** (`MaintenanceService.ts:1735-1736`); `null`
  disables the pass. Unset does NOT mean disabled.
- `staleInferredAfterDays` (`types.ts:361`) — feeds the
  stale-inferred downgrade pass. Unset resolves to **60 days**
  (`MaintenanceService.ts:1736`); `null` disables the pass. Unset does
  NOT mean disabled.
- `pruneEventsAfter` (`types.ts:350`) / `pruneRetainSoftDeletedFor`
  (`types.ts:351`) — the event and soft-delete retention clocks: a
  receipt diagnostic (`heal_deleted`/`heal_downgraded` are diagnostics)
  and a soft-deleted row are both retained only as long as these knobs
  allow. Retention is host policy (`specs/expire/spec.md:151-152`);
  `event_retention_held` (`types.ts:942`) is the visibility hook when
  retention holds a write.
- `pruneSupersededAfter` (`types.ts:352-357`, default null = keep
  history forever) — the superseded-history clock.

Owner-ruling text to document verbatim in intent: **heal may forget
when the host runs it** (2026-11-20) — a host-driven heal pass may
destroy the evidence of its own moves; the receipts and changed-id
lists of §5/§6 exist precisely so the move is auditable IF (and only
if) the host's clocks keep the receipts and the soft-deleted rows.
Suggested doc line: "Auditability of heal is bounded by your retention
clocks: set `pruneEventsAfter` and `pruneRetainSoftDeletedFor` long
enough to cover your audit window, or heal's moves (and their receipts)
forget themselves."

Replaces-link dependency, WITHOUT edge work (R-EDGE fence): heal's
delete-plus-restate shape (`MaintenanceService.ts:1931-1946` — the
full-breadth Jaccard dedupe where a synthesized fact replaces a
soft-deleted one; "a delete-plus-restate (heal's normal output shape)")
is where a replaces link will eventually attach. That link is PR 6's
edge work, NOT this step's: this spec only guarantees that the delete
half of a restate now carries a `heal_deleted` receipt and lands in
`deletedIds`, so the future replaces-link construction has an auditable
input. No edge code is added or changed here.

### 8. Compatibility lock

With no `systemOne` keys (or `healScreen` resolving `'llm'`):
`resolveSystemOneHealScreen` returns `'llm'`, no floor is read, every
admitted verdict applies exactly as today, no receipts fire (zero new
diagnostics on default hosts), and behavior is byte-identical. The
`minConfidence.healScreen` key present with NO `healScreen: 'auto'` is
dead surface by construction only under `'llm'` — but unlike the edges
"dead config" footgun, the `'auto'` consumer exists in the same PR
(§3), so setting both keys is the one-step engagement. Capability alone
never switches paths (REQ-COMPAT-01.5, `types.ts:812`). Engaging the
screen requires the host to set BOTH `systemOne.healScreen: 'auto'`
AND an explicit `systemOne.minConfidence.healScreen` in [0.5, 1] — a
host that sets only `'auto'` gets a one-time `warnOnce` naming the key
and ungated heal exactly as pre-PR (no behavior loss). Disclosed by
design: under open question 1 recommendation (a)'s wire-compat rule, an
engaged `'auto'` host whose model still emits the old bare-string schema
gets behavior byte-identical to `'llm'` — every verdict lacks
confidence, so each applies as today plus the one-time `warnOnce` —
until the model upgrades; for such hosts the floor is engaged in name
only. There is no
`'off'` mode (edges precedent, `systemOne.ts:30-31`): `'llm'` already
means "ungated generative", and an `'off'` would be a discard path
dragging in suppression receipts this design does not need.

### 9. Disclosed docstring/spec-text updates

- `systemOne.ts` fence comment (`:2-9`): "Later PRs add" list already
  names `'healScreen'` — updated to past tense when it lands; the
  "Exactly two members today" line at `:12` becomes three.
- `types.ts:403-409` (`systemOne?` doc comment, shared with the peer
  lane — coordinate, pins §9.3).
- `MaintenanceService.ts` heal-region docstrings: `doRunHeal`'s header
  gains the screen/floor/receipt contract (§4, §5).
- `docs/ROADMAP.md` step 12 entry: one Done line in the established
  convention (steps 7-9 pattern, `ROADMAP.md:232,244,255`), pointing at
  this spec.
- `apps/docs` configuration reference + maintenance guide: the §7 clock
  consolidation and the two new `systemOne` keys.

## Explicitly out of scope / rejected alternatives

- Gating the deterministic SQL passes (orphan/stale-inferred). Rejected:
  rule-driven host policy, no model output involved (§4); gating them
  would let a model-declared number veto host-configured clocks.
- A classifier path for heal (mirroring edges' `callClassify`). Rejected:
  heal reviews full fact dumps against recent events — a one-shot
  per-fact classify call cannot express the relational judgment heal
  makes, and it would double provider cost for no second opinion (heal
  IS the generative path; there is nothing to fall through to).
- An `'off'` mode. Rejected for the same reasons as edges: discard path,
  suppression receipts, third resolver branch, no ruling asks for it.
- Replaces-link construction for heal's restate shape. R-EDGE: PR 6's
  edge work; this spec only receipt-inputs it (§7). No
  `resolveEdges`/`EdgeDropReason`/edge-diagnostic changes.
- Gating `newFacts` insertion. Rejected: additive and already validated
  (`fact_rejected` receipts exist, `:1924`); the no-silent-discard rule
  forbids it (§4).
- Receipting SQL-pass actions as diagnostics (recommendation: no — see
  open question 3).
- A schema change to `newFacts` confidence (already an enum,
  `prompts.ts:46`; not a number to floor).
- Any change to `batchSize` validation, the escalation ladder, grounding,
  degraded/skipped reconciliation (`:2057-2062`), `deliverHealRemovals`
  semantics, or the scheduler.

## Open questions

1. What does `'healScreen: 'auto'` floor ON — the heal response carries
   no confidence today (`prompts.ts:44-45` are bare fact-ID string
   arrays; the parse at `MaintenanceService.ts:1862-1867` normalizes
   them as strings), so `'auto'` cannot gate anything without a
   response-contract change. Options: (a) extend `HEAL_SYSTEM_PROMPT`
   so `downgraded`/`deleted` entries become objects
   `{ id, confidence }` (confidence a number in [0, 1]); (b) keep the
   id-list schema and have step 12 ship ONLY the receipts and changed-id
   lists, deferring the gate until the contract lands. **Recommendation:
   (a)** — the roadmap sentence "The heal screen opts in to the
   configured model" only means something if a threshold exists to opt
   into; the contract change is prompt-text plus a widened parse type
   (objects accepted, bare-string ids still parsed for wire compat with
   `confidence: undefined` → treated as missing → apply as today plus a
   one-time `warnOnce` naming the migration, §4), so old-model hosts
   never regress; and a bare-string fallback keeps the no-silent-discard
   rule intact. Grounds: `prompts.ts:41-48`,
   `MaintenanceService.ts:1861-1870`, `docs/ROADMAP.md:280-288`.
2. Where receipts land — diagnostics only, `HealResult` fields only, or
   both. **Recommendation: both, different jobs** — the per-fact
   diagnostics (§5) are the streaming audit trail hosts already consume
   via the diagnostic pipeline (the `heal_skipped` precedent,
   `MaintenanceService.ts:2030-2033`), while `downgradedIds`/`deletedIds`
   (§6) are the run-scaped answer to "what did that pass touch",
   consumable off the return value (`useWikiMaintenance.ts:7`).
   Diagnostics alone lose run-scoping; `HealResult` alone loses hosts
   that only listen to diagnostics. Grounds: pins §5 (no `changedIds`
   field exists anywhere yet), edge-suggestions spec §6 (its receipts
   stayed diagnostic-level, but edges had no result object to extend —
   heal does).
3. Do the deterministic SQL passes get `heal_deleted`/`heal_downgraded`
   receipts too, or only model-directed actions? **Recommendation:
   model-directed only** — the SQL passes are host-policy arithmetic
   (`orphanAfterDays`, `staleInferredAfterDays`, `types.ts:360-361`)
   whose ids are already fully enumerated in the §6 changed-id lists
   (`allDowngraded`/`allDeleted` unions,
   `MaintenanceService.ts:2085-2086`), so receipting them would double
   the surface for facts the host's own clock decided; the receipts'
   job is making MODEL moves auditable against the forget-ruling
   (`docs/ROADMAP.md:282-286`). A host wanting SQL-pass visibility has
   the id lists. Grounds: pins §1, §7.
4. Exact changed-id list shape — one flat array, grouped
   deleted/downgraded arrays, or a richer per-id record (id + source
   pass + applied/below-floor)? **Recommendation: two flat string
   arrays** — `downgradedIds: string[]` and `deletedIds: string[]`
   (§6), exactly the existing `allDowngraded`/`allDeleted` unions
   surfaced — because the union sets already dedupe SQL-pass vs
   model-directed overlap (the comment at `MaintenanceService.ts:2082-2084`
   explains why union, not sum), a per-id record would force every
   consumer to learn pass attribution for a distinction the diagnostics
   already carry (`detail.reason`), and ImportExportService's `removedIds`
   precedent (pins §5) is a flat array. Grounds: `MaintenanceService.ts:2085-2086`,
   `types.ts:211-249`, pins §5.

## Files touched

- `packages/core/src/config/systemOne.ts` — `'healScreen'` joins
  `SystemOneThresholdSite` (ONE line, §1); `healScreen?: 'auto' | 'llm'`
  on `SystemOneConfig` (§2); fence-comment tense (§9). Lane fence: peer
  lane adds `'resolve'` at the same L13 — one-line members so sibling
  PRs merge cleanly.
- `packages/core/src/utils/engineDefaults.ts` —
  `resolveSystemOneHealScreen` and `resolveHealScreenMinConfidence`
  (§2, §3) with their `warnOnce` treated-as-unset paths; `??` not `||`
  throughout (engineDefaults L120 comment contract).
- `packages/core/src/services/MaintenanceService.ts` — resolve mode+floor
  once at `doRunHeal` entry (beside `:1723`); per-fact screen at the
  guard/apply seam (`:1889-1911` → apply at `:1947-1949`); receipt emission
  through `diagBase`/`diagBuffer` (§5); `downgradedIds`/`deletedIds`
  surfacing at `:2085-2093` (§6); heal response parse widened
  (§2 contract, per open question 1); heal-region docstrings (§9).
  ONLY the heal region (L1710-2100) plus the shared import line
  (pins §9.4).
- `packages/core/src/types.ts` — two `WikiDiagnosticCode` members
  (§5); two additive `HealResult` fields (§6); `types.ts:403-409` doc
  comment (shared with peer lane, pins §9.3).
- `packages/core/src/utils/diagnostics.ts` — SEVERITY + MESSAGE entries
  for both new codes (both exhaustive maps, §5).
- `packages/core/src/prompts.ts` — `HEAL_SYSTEM_PROMPT` response schema
  (open question 1 recommendation (a) only).
- `packages/core/src/index.ts` — export the two new resolvers beside the
  S1-0/edges resolvers (L29-32; both lanes touch, pins §9.5).
- `packages/core/__tests__/` — test plan below; the
  `systemOneConfig.test.ts` export-surface lock test is updated by
  whichever lane lands SECOND (pins §9.6).
- Docs, same PR: `apps/docs/src/content/docs/reference/configuration.md`
  + maintenance guide (§7 clock consolidation, §9 keys);
  `docs/ROADMAP.md` step 12 Done line (§9).

Not touched: edge machinery (`OntologyService`, `resolveEdges`,
`EdgeDropReason`, edge diagnostics), `EntryRepository`
(`downgradeByIds`/`softDeleteByIds` signatures unchanged),
`ImportExportService`, scheduler code.

## Test plan

Vitest, mirroring the step-10 test structure: new describes appended to
`packages/core/__tests__/systemOneConfig.test.ts` for the resolvers
(`healScreen config surface (heal-screening-system-one §1, §2)`,
`resolveSystemOneHealScreen (§2)`, `resolveHealScreenMinConfidence (§3)`,
and the `public export surface` lock test — updated by whichever lane
lands second, pins §8), plus a new
`packages/core/__tests__/healScreen.test.ts` beside
`healBounding.test.ts`/`healBudget.test.ts`:

1. Resolvers: `resolveSystemOneHealScreen` unset → `'llm'`;
   `'auto'`/`'llm'` pass through; invalid value warns once and resolves
   `'llm'`. `resolveHealScreenMinConfidence` (posture A): `'auto'` with
   NO floor → warns ONCE naming `systemOne.minConfidence.healScreen`,
   site resolves `'llm'`, NO default floor; configured `0`, `0.3`, or
   any value outside [0.5, 1] → warns once, site resolves `'llm'`;
   explicit `0.5` (inclusive domain lower bound) is valid and passes
   through; `'llm'` mode never reads a floor.
2. Applied verdict with receipts: `healScreen: 'auto'` + explicit floor;
   model answers `{ id, confidence }` verdicts at/above the floor →
   `softDeleteByIds`/`downgradeByIds` run as today, ONE
   `heal_deleted`/`heal_downgraded` diagnostic per fact with
   `detail.reason: 'applied'`, and `HealResult.deletedIds`/
   `downgradedIds` carry the ids.
3. Below-floor withhold: a delete verdict below the floor does NOT run
   `softDeleteByIds` — the fact is untouched, a `heal_deleted`
   diagnostic with `detail.reason: 'below_floor'` and `detail.confidence`
   fires, and the id is absent from `deletedIds`; same for a
   below-floor downgrade.
4. Deterministic SQL passes never gated: with the screen `'auto'` and a
   floor of `1` (every model verdict withheld), the orphan pass and
   stale-inferred pass still run under the host clocks and their ids
   still land in `deletedIds`/`downgradedIds` (§4 OUT-pin; the unions at
   `:2085-2086`).
5. Wire compat: a provider answering the OLD bare-string schema under
   `'auto'` → verdicts apply as today (no silent discard), one-time
   `warnOnce` names the contract migration (open question 1
   recommendation) — conditional on open question 1 resolving (a),
   evaporates under (b); under `'llm'` no warning and byte-identical.
6. Default mode: no `systemOne` keys at all — byte-identical to pre-PR:
   no floor read, no new diagnostics, `deletedIds`/`downgradedIds` still
   populated (they exist under `'llm'` too — surfacing is unconditional,
   §6) and match `deleted`/`downgraded` counts.
7. Floor boundaries: verdict confidence exactly equal to the floor
   APPLIES (`≥` is inclusive, §3); `0.999` vs floor `1` withholds.
8. Per-fact volume pin: a pass with N model-directed moves emits exactly
   N receipt diagnostics (plus the existing `heal_skipped` ones
   unchanged) — never a summary (§5).
9. Both-sets fact: an id the model both downgrades and deletes (admitted
   independently by the per-batch guard, `:1900-1902`) produces
   independent verdicts, both screened, both receipted (§4 per-fact
   granularity).
10. Vocabulary: `ontologyReceiptVocabulary.test.ts` (or its
    diagnostics-map equivalent) extended with the two new codes' fixed
    severities/messages (§5) — unlike step 10, this PR DOES add codes,
    so the vocabulary assertions must grow.
11. Retention-clock doc test (light): the doc build/configuration
    reference contains the §7 clock set (or a snapshot test of the doc
    section), pinning that the consolidation ships with the code.
