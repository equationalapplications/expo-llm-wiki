# Spec — Step 12: Heal screening from System-One

Status: Approved by owner 2026-11-22 (Discord thread `1570840529388965951`,
msg `1574148740716175392`); all eight open questions resolved — see Open
questions (each carries its ruling). Draft 2026-11-22.
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

The applied/withheld split happens IMMEDIATELY AFTER the guard sets
`safeDowngraded`/`safeDeleted` are built
(`MaintenanceService.ts:1910-1911`) and BEFORE `uniqueDeletedFactIds`
is computed at `:1929` — and it must sit there. The seam does NOT
merely filter downstream consumers; it REPLACES the guard outputs
themselves: the applied sets (`appliedDowngraded`/`appliedDeleted`, or
the same names rebound) become THE sets every later reader sees. There
are FIVE readers of the guard outputs downstream of the seam, and a
withheld id must reach NONE of the five:

1. the apply — `softDeleteByIds`/`downgradeByIds` run at
   `MaintenanceService.ts:1948-1949` (pins §1, apply seam `:1947-1949`);
2-4. the derived `uniqueDeletedFactIds` computed at `:1929` and its
   THREE consumers — the search sync (`:2044`),
   `deliverHealRemovals` (`:2049`), and the `allDeleted` union
   (`:2086`);
5. `healSyncIds` (`:2040-2046`), which ALSO spreads `safeDowngraded`
   directly (`:2043`) — so the applied-set replacement must cover the
   downgrade side too, not just the deleted side.

Because the replacement happens before `:1929`, the derived list is
computed from applied deletes only and its three consumers inherit the
screen; screening inside the transaction apply instead would leak
withheld ids into removals delivery, the search sync, and the
changed-id lists. Every reader downstream of the seam reads the
APPLIED sets only.

- In: the MODEL-DIRECTED sets only — `safeDowngraded`/`safeDeleted`
  (post-guard, `MaintenanceService.ts:1910-1911`), per-fact, before
  `downgradeByIds`/`softDeleteByIds` run in the tx (pins §1, apply seam
  `MaintenanceService.ts:1947-1949`); the applied subsets
  (`appliedDowngraded`/`appliedDeleted`) then REPLACE them for all five
  readers above.
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
- Screen plumbing (in the widened parse of open question 1, per its
  ruling (a)):
  1. Confidence validation AND the `Map<string, number>` carrier are
     built AT PARSE TIME: a finite number in [0, 1] is a confidence;
     a non-numeric value, NaN, a negative number, or a value > 1 counts
     as MISSING and is receipted distinctly (see §5: the
     `'applied_unscreened'` reason, not `'applied'`). The validated
     confidence rides a `Map<string, number>` built alongside the parse
     output, BEFORE the mutable-ids guard collapses verdicts into
     `Set<string>`s (`MaintenanceService.ts:1889-1903`, unchanged by
     this PR). The carrier takes ONLY verdicts the guard ADMITTED: the
     per-batch `mutableIds` check (`MaintenanceService.ts:1901-1902`)
     runs on the same ids, and a verdict the guard rejected never
     contributes a confidence — so it can never lower a duplicate id's
     confidence under the lowest-wins rule below.
  2. The floor comparison itself runs AFTER the guard sets
     `safeDowngraded`/`safeDeleted` exist (`:1910-1911`) and BEFORE
     `uniqueDeletedFactIds` is computed at `:1929` (the seam above).
     There is no additional comparison site: parse-time validation and
     the post-guard floor comparison are the only two steps.
  3. Duplicates — if the same id appears in multiple batch results, the
     LOWEST confidence wins (most conservative).
  4. Receipt plumbing: `diagBuffer` is local to `doRunHeal`, created at
     `MaintenanceService.ts:1912` (after the guard), and receipts are
     pushed into it at the `heal_skipped`-pattern push point
     (`:2030-2032`). Because screen outcomes (applied / withheld /
     missing-confidence) are computed earlier — validation and carrier
     at parse time, floor comparison at the seam — each verdict's
     outcome is CARRIED from its computation point to the push point
     (withheld ids in a withheld-set, applied ids implicit in the
     applied sets); nothing is recomputed at push time.
- Outcome rule per verdict, under resolved `'auto'`:
  - `confidence ≥ floor` → apply as today.
  - `confidence < floor` → WITHHOLD: a below-floor delete does not run,
    a below-floor downgrade does not run; the fact is left untouched.
    Withholding is not data loss in the fact-survival sense: the fact
    remains untouched and its content is never destroyed. But a withheld
    verdict IS a COMPLETED model review, so the withheld id receives the
    same `heal_checked` cooldown stamp as applied ids —
    `MaintenanceService.ts:2019-2023` excludes only `call_error` and
    unattempted ids from the stamp — meaning it is NOT re-reviewed for
    `HEAL_RECHECK_MS` = 7 days (`:89`). Withheld ids KEEP the stamp —
    open question 5 ruling (owner, 2026-11-22): skipping the stamp would
    re-evaluate the same fact every run, an unbounded cost. No generative
    fallthrough machinery is needed — there is no alternative engine for
    heal to fall through TO. The withheld move is receipted
    (`detail.reason: 'below_floor'`, §5) so the host sees what heal chose
    not to do.
  - Missing confidence (open question 1 migration) → apply as today,
    warn once (open question 1 wire-compat), AND receipt each such
    verdict with `detail.reason: 'applied_unscreened'` (§5) — the
    outcome must match §5 exactly.
- Disclosed interaction — withheld delete plus paired restate: a
  WITHHELD delete leaves fact X live, and the model's paired restatement
  (a synthesized replacement fact) then matches X at Jaccard >= threshold
  inside the transaction — dedupe reads `findInferredTitlesByEntityId`
  AFTER `softDeleteByIds` runs (`MaintenanceService.ts:1951-1952`; the
  ordering is load-bearing per the `#68` comment at `:1937-1946`) — so
  the restatement is skipped as `fact_deduplicated` and the correction
  is DROPPED while X survives. The outcome is auditable (the
  `'below_floor'` receipt plus the dedupe diagnostic together tell the
  story) but the delete↔restate pairing is IMPLICIT — the response
  contract carries no explicit pairing, so the host must reconstruct it
  from receipts. A restate whose paired delete is withheld is NOT also
  withheld — open question 7 ruling (owner, 2026-11-22): defer; the blast
  radius is tight this cycle, and this is revisited only if telemetry
  shows paired restates of withheld deletes causing drift.
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
`packages/core/src/utils/diagnostics.ts` (SEVERITY and MESSAGE — those
are the only exhaustive maps in the file). Suggested messages:
`heal_deleted: 'Heal soft-deleted a fact (or withheld the delete below the confidence floor).'`
`heal_downgraded: 'Heal downgraded a fact to tentative (or withheld the downgrade below the confidence floor).'`
(These messages and the `detail` shapes below are written for open
question 1's ruling (a), adopted 2026-11-22.)

Emission mirrors the `heal_skipped` per-fact pattern
(`MaintenanceService.ts:2030-2033`): per-fact, through `diagBase` /
`diagBuffer`. Receipts are buffered in `diagBuffer` and flush only at
the `:2033` flush point — which is UNREACHABLE when the transaction
throws: `diagBuffer` is local to `doRunHeal` (created at `:1912`,
after the guard), and a thrown transaction propagates past the flush —
so a rolled-back pass emits NO receipts, and a receipt always
corresponds to a committed move. Shape mirrors
`edgeDropDiagnostic` (`diagnostics.ts:271-289`) — `detail` carries
`reason`, `factId`, and omits unknown locators rather than sending
nulls:

Receipts fire in EVERY mode (open question 8 ruling, owner 2026-11-22):
default `'llm'` hosts emit `heal_deleted`/`heal_downgraded` receipts for
model-directed moves too — honest reporting is a universal mandate, and
default hosts are not blinded. Only the `'below_floor'` and
`'applied_unscreened'` outcomes can arise under resolved `'auto'`
(the floor is what creates them).

- APPLIED model-directed delete → `heal_deleted`,
  `detail: { factId, reason: 'applied' }`.
- APPLIED model-directed downgrade → `heal_downgraded`,
  `detail: { factId, reason: 'applied' }`.
- WITHHELD (below floor, under resolved `'auto'`) → same code as
  the action, `detail: { factId, reason: 'below_floor', confidence }`
  (confidence included when the model declared one). A missing-confidence
  verdict that fires under `'auto'` — whether
  the schema omitted confidence (wire-compat migration) or the model
  declared an invalid confidence (§4 confidence validation) — is
  receipted as a DISTINCT ungated reason: same code,
  `detail: { factId, reason: 'applied_unscreened' }`, with the
  `confidence` field omitted. Auditors must be able to tell an ungated
  move (`'applied_unscreened'`) from a gated one (`'applied'`).

Volume pin: ONE diagnostic per (fact, action) — a pass that deletes 40
facts emits 40 receipts, not one summary; receipts are the audit trail
and must be per-fact to serve it. SQL-pass actions get NO receipts
(open question 3) — their ids land in the §6 changed-id lists instead,
which keeps the diagnostic surface proportional to model-driven risk.

### 6. Changed-id lists on `HealResult`

`HealResult` (`types.ts:211-249`) gains two additive OPTIONAL fields,
populated from the sets that already exist at
`MaintenanceService.ts:2085-2086`:

```ts
/**
 * Every fact id this heal run left at reduced confidence (stale-inferred
 * SQL pass plus model-directed downgrades, deduped) — the ids behind
 * `downgraded`. Optional so existing `HealResult` literals (host mocks)
 * keep compiling; `doRunHeal` always populates it today. NOT disjoint
 * with `deletedIds`: a fact both downgraded and deleted in one pass
 * appears in BOTH lists (union-not-sum semantics,
 * `MaintenanceService.ts:2082-2086`) — hosts must not treat the lists
 * as disjoint.
 */
downgradedIds?: string[];
/**
 * Every fact id this heal run soft-deleted (orphan SQL pass plus
 * model-directed deletes, deduped) — the ids behind `deleted`. Optional
 * so existing `HealResult` literals (host mocks) keep compiling;
 * `doRunHeal` always populates it today. NOT disjoint with
 * `downgradedIds` (see above).
 */
deletedIds?: string[];
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
  allow. Guidance, not a requirement: to keep a `'below_floor'`
  receipt auditable across the full `HEAL_RECHECK_MS` window (7 days,
  `MaintenanceService.ts:89`), a host's `pruneEventsAfter` should be
  at least 7 days — the relationship is disclosed here; retention
  itself remains host policy (`specs/expire/spec.md:151-152`);
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
input — and, when the delete half is WITHHELD, that the interaction
disclosed in §4 holds: fact X stays live, the paired restatement is
deduped away (`fact_deduplicated`) and the correction is dropped, made
auditable by the `'below_floor'` receipt plus the dedupe diagnostic.
No edge code is added or changed here.

### 8. Compatibility lock

With no `systemOne` keys (or `healScreen` resolving `'llm'`):
`resolveSystemOneHealScreen` returns `'llm'`, no floor is read, every
admitted verdict applies exactly as today, and the parse/apply logic is
identical. Prompt parity: per open question 6's ruling (owner,
2026-11-22), the `{id, confidence}` schema prompt goes to ALL hosts —
the prompt schema changes for EVERY host, default `'llm'` hosts
included (same parse/apply logic everywhere; the added schema line's
token cost is unmeasured and disclosed here; covered by test 14's
baseline). Default hosts are parity-of-logic, not parity-of-prompt.
Diagnostics: default `'llm'` hosts DO gain `heal_deleted`/
`heal_downgraded` receipts (info severity) for model-directed moves —
open question 8's ruling makes receipts fire in EVERY mode
(open question 2's audit surface, unconditionally). The `HealResult`
shape gains the additive OPTIONAL §6 fields on every host.

Test-churn budget: because the new fields are optional, existing
`HealResult` literals (in-repo and host mocks) keep compiling
unchanged; the `toEqual` churn on in-repo assertions that compare whole
result objects REMAINS and must be updated in the same PR. No
`BREAKING CHANGE` footer either way — that determination needs a
ruling (per AGENTS.md).

A `minConfidence.healScreen` key present with NO
`healScreen: 'auto'` has no effect — but unlike the edges "dead
config" footgun, the `'auto'` consumer exists in the same PR
(§3), so setting both keys is the one-step engagement. Capability alone
never switches paths (REQ-COMPAT-01.5, `types.ts:812`). Engaging the
screen requires the host to set BOTH `systemOne.healScreen: 'auto'`
AND an explicit `systemOne.minConfidence.healScreen` in [0.5, 1] — a
host that sets only `'auto'` gets a one-time `warnOnce` naming the key
and ungated heal exactly as pre-PR (no behavior loss). Disclosed by
design: under open question 1 ruling (a)'s wire-compat rule, an
engaged `'auto'` host whose model still emits the old bare-string schema
gets behaviour identical to `'llm'` — every verdict lacks
confidence, so each applies as today plus the one-time `warnOnce` —
until the model upgrades; for such hosts the floor is engaged in name
only. There is no
`'off'` mode (edges precedent, `systemOne.ts:30-31`): `'llm'` already
means "ungated generative", and an `'off'` would be a discard path
dragging in suppression receipts this design does not need.

Prompt-override chain: `healSystemPrompt` (`types.ts:45`) resolved as
runtime override → global override → `HEAL_SYSTEM_PROMPT`
(`PromptService.ts:282`, `:424`). A host overriding the heal prompt must
carry the `{id, confidence}` schema itself, or `'auto'` screens nothing
for as long as the override lasts — permanent `'applied_unscreened'`
receipts (§5) plus the one-time `warnOnce`, NOT a transient migration
state. The `warnOnce` text must name `healSystemPrompt`.

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
  makes, and it would add provider cost (a second full generative call
  per pass) for no second opinion (heal
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

## Open questions — ALL RESOLVED (owner rulings 2026-11-22)

All eight questions were resolved by owner rulings on 2026-11-22
(Discord thread `1570840529388965951`, msg `1574148740716175392`); every
ruling matched the recommendation stated below. Each question carries
its ruling; the recommendations are kept for the reasoning.

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
   rule intact. Wire-compat requirement under (a): the widened parse
   MUST normalize to bare string ids in EVERY mode — objects are
   accepted, ids extracted, and confidence carried aside (§4 carrier
   map) — because the mutable-ids guard
   (`MaintenanceService.ts:1901-1902`) tests string membership; an
   un-normalized object response would make every model action silently
   drop, breaking no-silent-discard on the default path. This
   normalization is required under ANY resolution of open question 6.
   Grounds: `prompts.ts:41-48`, `MaintenanceService.ts:1861-1870`,
   `docs/ROADMAP.md:280-288`.
   **Ruling (owner, 2026-11-22):** (a) — extend `HEAL_SYSTEM_PROMPT` so
   `downgraded`/`deleted` entries become `{ id, confidence }` objects,
   parsed backward-compatibly: bare strings parse as missing confidence
   → apply as today plus a one-time `warnOnce` naming the migration.
2. Where receipts land — diagnostics only, `HealResult` fields only, or
   both. **Recommendation: both, different jobs** — the per-fact
   diagnostics (§5) are the streaming audit trail hosts already consume
   via the diagnostic pipeline (the `heal_skipped` precedent,
   `MaintenanceService.ts:2030-2033`), while `downgradedIds`/`deletedIds`
   (§6) are the run-scoped answer to "what did that pass touch",
   consumable off the return value (`useWikiMaintenance.ts:7`).
   Diagnostics alone lose run-scoping; `HealResult` alone loses hosts
   that only listen to diagnostics. Grounds: pins §5 (no `changedIds`
   field exists anywhere yet), edge-suggestions spec §6 (its receipts
   stayed diagnostic-level, but edges had no result object to extend —
   heal does).
   **Ruling (owner, 2026-11-22):** Both — the per-fact diagnostics are
   the streaming audit trail; the `HealResult` `downgradedIds`/
   `deletedIds` are the run-scoped answer.
3. Do the deterministic SQL passes get `heal_deleted`/`heal_downgraded`
   receipts too, or only model-directed actions? **Recommendation:
   model-directed only** — the SQL passes are host-policy arithmetic
   (`orphanAfterDays`, `staleInferredAfterDays`, `types.ts:360-361`)
   whose ids are already fully enumerated in the §6 changed-id lists
   (`allDowngraded`/`allDeleted` unions,
   `MaintenanceService.ts:2085-2086`), so receipting them would add
   diagnostic surface (a second receipt per SQL-passed fact, quantity
   unmeasured) for facts the host's own clock decided; the receipts'
   job is making MODEL moves auditable against the forget-ruling
   (`docs/ROADMAP.md:282-286`). A host wanting SQL-pass visibility has
   the id lists. Grounds: pins §1, §7.
   **Ruling (owner, 2026-11-22):** Model-directed only — SQL passes
   (orphan/stale) get NO receipts; their ids are already in the
   changed-id lists.
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
   **Ruling (owner, 2026-11-22):** Two flat arrays:
   `downgradedIds: string[]` and `deletedIds: string[]`.

5. Should withheld (below-floor) ids skip the `heal_checked` cooldown
   stamp so the next heal pass re-reviews them, or keep the stamp (7-day
   lockout, disclosed)? **Recommendation: keep the stamp** — a withheld
   verdict is a completed model review (unlike `call_error`/unattempted,
   which the code already excludes for exactly this reason,
   `MaintenanceService.ts:2005-2018`); re-LLMing the same below-floor
   fact every run re-opens the per-run cost and queue-starvation
   concerns the stamp exists to bound, and the withhold is already
   visible via its `'below_floor'` receipt. Grounds:
   `MaintenanceService.ts:2019-2023`, `:89`, §4 as amended.
   **Ruling (owner, 2026-11-22):** Keep the 7-day `heal_checked`
   cooldown stamp for withheld ids, disclosed. Skipping the stamp would
   re-evaluate the same fact every run (owner's cost-bound rationale).
6. Should the `{id, confidence}` response schema go to ALL hosts (single
   `HEAL_SYSTEM_PROMPT`, parse normalizes in every mode) or be
   mode-conditional (`'llm'` hosts keep today's prompt text)?
   **Recommendation: all hosts** — one code path, the normalization
   parse is required in every mode regardless (open question 1
   wire-compat requirement), the prompt addition is one schema line
   (its token cost is unmeasured and not claimed here), and a
   mode-conditional template couples PromptService to systemOne config
   it does not currently see (`PromptService.ts:282` resolves with no
   config knowledge). Grounds: `PromptService.ts:282`, `:424`,
   `types.ts:45`.
   **Ruling (owner, 2026-11-22):** ALL hosts — single prompt, the
   normalizing parse runs in every mode; no mode-conditional prompt
   text.
7. Should a restate whose paired delete is withheld (below floor) ALSO
   be withheld, so the drop disclosed in §4 cannot happen?
   **Recommendation: defer.** The response contract carries no explicit
   delete↔restate pairing — `downgraded`/`deleted` are id lists and
   `newFacts` is a separate array (`prompts.ts:44-46`) — so
   pair-withhold would need a new contract field or a title-similarity
   heuristic at the seam. The §4 disclosure plus receipts make the
   outcome auditable today (the `'below_floor'` receipt plus the
   `fact_deduplicated` diagnostic), and the roadmap sentence does not
   demand pairing. Grounds: `MaintenanceService.ts:1951-1952`,
   `:1937-1946`, `prompts.ts:44-46`, §7.
   **Ruling (owner, 2026-11-22):** Defer pair-withhold — tight blast
   radius this cycle; revisit only if telemetry shows paired restates
   of withheld deletes causing drift.
8. Should the `heal_deleted`/`heal_downgraded` receipts (§5) fire in
   EVERY mode (the default `'llm'` included) or only under resolved
   `'auto'`? **Recommendation: every mode.** The roadmap's
   per-fact-receipts deliverable — making heal's moves auditable under
   the forget-ruling — reads as unconditional
   (`docs/ROADMAP.md:280-288`), and gating the audit trail behind the
   `'auto'` opt-in would leave diagnostics-only hosts blind to
   model-directed deletes on default hosts, exactly the gap open
   question 2 says the receipts exist to close (both halves together
   are the audit surface; diagnostics alone lose hosts that only
   consume diagnostics). The codes are SEVERITY `info`
   (`diagnostics.ts`), so the noise cost is bounded. Grounds:
   `docs/ROADMAP.md:280-288`, §5 as amended by earlier folds, OQ2.
   **Ruling (owner, 2026-11-22):** EVERY mode — receipts fire on
   default `'llm'` hosts too; honest reporting is a universal mandate,
   and default hosts are not blinded.

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
  guard/apply seam (`:1889-1911` → seam before `:1929`, apply at
  `:1947-1949`); receipt emission
  through `diagBase`/`diagBuffer` (§5); `downgradedIds`/`deletedIds`
  surfacing at `:2085-2093` (§6); heal response parse widened
  (per open question 1); heal-region docstrings (§9).
  ONLY the heal region (L1710-2100) plus the shared import line
  (pins §9.4).
- `packages/core/src/types.ts` — two `WikiDiagnosticCode` members
  (§5); two additive `HealResult` fields (§6); `types.ts:403-409` doc
  comment (shared with peer lane, pins §9.3).
- `packages/core/src/utils/diagnostics.ts` — SEVERITY + MESSAGE entries
  for both new codes (both exhaustive maps, §5).
- `packages/core/src/prompts.ts` — `HEAL_SYSTEM_PROMPT` response schema
  (open question 1 ruling (a)). `PromptService.ts` itself
  is NOT modified: the `healSystemPrompt` override chain
  (`types.ts:45`) — runtime override → global override →
  `HEAL_SYSTEM_PROMPT` (`PromptService.ts:282`, `:424`) — is used as-is
  (§8; open question 6's ruling puts the schema line in the prompt for
  ALL hosts, no mode-conditional template).
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
   fires, the id is absent from `deletedIds`, and the id is ABSENT from
   the `deliverHealRemovals` payload (`:2049` reads the derived
   `uniqueDeletedFactIds` list, which the seam (§4) excludes withheld
   ids from); same for a below-floor downgrade. The test ALSO asserts
   the arguments passed to `softDeleteByIds`/`downgradeByIds`
   (`MaintenanceService.ts:1948-1949`) exclude withheld ids — the seam
   replaces the guard outputs, so none of the five downstream readers
   (§4) ever sees a withheld id.
4. Deterministic SQL passes never gated: with the screen `'auto'` and a
   floor of `1` (verdicts with confidence strictly below 1.0 withheld —
   the comparison is inclusive `≥`, so a confidence-1.0 verdict applies;
   fixtures use 0.9, never 1.0), the orphan pass and
   stale-inferred pass still run under the host clocks and their ids
   still land in `deletedIds`/`downgradedIds` (§4 OUT-pin; the unions at
   `:2085-2086`).
5. Wire compat: a provider answering the OLD bare-string schema under
   `'auto'` → verdicts apply as today (no silent discard), one-time
   `warnOnce` names the contract migration (open question 1 ruling (a)),
   and EACH old-schema verdict produces an
   `'applied_unscreened'` receipt (§5, per §4's outcome rule); under
   `'llm'` no warning and behaviour
   identical modulo the additive §6 `HealResult` fields.
6. Default mode — receipts fire in every mode (open question 8 ruling):
   no `systemOne` keys at all — parse/apply logic identical to pre-PR
   except the additive §6 `HealResult` fields and the §5 receipts
   (prompt text itself changes for ALL hosts per open question 6's
   ruling, §8): no floor read, and the `heal_deleted`/
   `heal_downgraded` applied-receipts DO fire for model-directed moves
   (info severity, `'applied'` reasons), `deletedIds`/`downgradedIds`
   still populated (they exist under `'llm'` too — surfacing is
   unconditional, §6) and match `deleted`/`downgraded` counts.
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
12. Transaction rollback: a heal pass whose transaction throws (the
    throw is injected BEFORE the `:2033` flush point) emits ZERO
    `heal_deleted`/`heal_downgraded` receipts — the flush at `:2033`
    is unreachable when the transaction throws (`diagBuffer` is local,
    created at `:1912`, and the throw propagates past the flush, §5);
    assert the diagnostics list is empty after a rolled-back pass.
13. Withheld delete plus paired restate (§4 disclosure, open question
    7 scenario): with the screen `'auto'`, a delete verdict below the
    floor on fact X plus a model restatement whose Jaccard similarity
    to X is at/above the dedupe threshold — `softDeleteByIds` does NOT
    include X, dedupe reads `findInferredTitlesByEntityId` after the
    delete pass (`:1951-1952`) so the restatement is skipped as
    `fact_deduplicated` while X SURVIVES, a `'below_floor'`
    `heal_deleted` receipt and the dedupe diagnostic both fire, X is
    absent from `deletedIds` and from the `deliverHealRemovals`
    payload, and no new fact row is inserted.
14. INTENT rule 11: the plan stage publishes a measured before/after
    baseline from the bench harness for the heal lane — including the
    default-path prompt change (open question 6's ruling puts the
    `{id, confidence}` schema prompt to ALL hosts, so a default `'llm'`
    host's prompt changes, §8; token cost must be measured, not
    claimed); this spec itself claims no unmeasured numbers.
