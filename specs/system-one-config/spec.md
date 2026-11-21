# Spec — S1-0: System-One Config Surface

Status: Implemented 2026-11-21 (PR #442, landed commit `0958a525`; acceptance tests in `packages/core/__tests__/ontologyBackfill.test.ts`, `pendingMaintenanceOntology.test.ts`, `classifierBackfill.test.ts`) — owner ruling 2026-11-21; open questions cleared (handoff ledger D3/D4, consult ADJUDICATION-r3/r3a; wave 1 of PLAN-v5); landed scheduler job name `ontologyBackfill` (landed shape wins; job-name prose amended 2026-11-21 in PR #448 per its T3 review M1 — see the amendment note below).

**Amendment, 2026-11-21 (PR #448, T3 review M1):** the maintenance job landed as
`'ontologyBackfill'` (`types.ts:1795`), not this prose's spec-era `'typing'`;
job-name occurrences below are amended to the landed name. The
`SystemOneThresholdSite` value `'typing'` (`systemOne.ts:12`) is the landed
threshold-site name and is deliberately unchanged.

## Problem

Hosts tune System-One typing through scattered keys. The typing mode and the
confidence floor live under `ontology.*`, read inline in
`MaintenanceService.ts`, not in the engine-default home. Forced-choice typing
has no abstain: a classifier facing a fact that fits no manifest type must
still pick one. A wrong-but-valid type passes every check and the fact stays
in the backfill pool forever. Low-confidence facts always stay untyped; the
host cannot route them to the cheaper or the stronger path. Typing never runs
inside `runPendingMaintenance`, so hosts schedule it by hand.

## Root cause with evidence

- The typing mode resolves inline at `MaintenanceService.ts:2085`
  (`options?.classifier ?? config?.ontology?.backfillClassifier ?? 'llm'`).
  Engine defaults belong in `engineDefaults.ts:8-17`, which already holds
  `DEFAULT_LIBRARIAN_STRATEGY` and `DEFAULT_MAINTENANCE_MODE`. The module is
  internal today: `index.ts` re-exports nothing from it, so exporting the
  new resolvers is new public surface.
- The floor resolves inline at `MaintenanceService.ts:2252-2253`. An invalid
  value silently becomes `0.5`. No warning fires.
- The classifier question is forced choice: `MaintenanceService.ts:2258-2264`
  builds `options` from the manifest slugs only. `validateClassifierAnswer`
  (`utils/classifier.ts:20`) rejects any answer outside the list, so an
  honest "none of these" is impossible.
- Low-confidence outcomes only emit `classification_low_confidence`
  (`MaintenanceService.ts:2335-2336`) and stay untyped. There is no
  escalation route.
- Generative-path omissions carry no receipt: the batch loop at
  `MaintenanceService.ts:2166` counts only typed and failed facts. A model
  that skips a fact fails silently.
- The slug cap is `255` at `MaintenanceService.ts:2089` (Jev's `choice`
  limit; `ClassifyRequest` has no limits field).
- `batchSize` validates by throwing: `MaintenanceService.ts:2056-2058`
  (backfill) and `:1667-1668` (heal). This is the precedent for invalid call
  options.
- The scheduler job set at `MaintenanceScheduler.ts:112` and
  `MaintenanceJob` (`types.ts:1729`) list librarian, heal, reembed,
  externalDeletions. No typing job exists.

## Proposed change

### 1. New config namespace

Create `packages/core/src/config/systemOne.ts`. It ships this type:

```ts
export type SystemOneThresholdSite = 'typing';

export interface SystemOneConfig {
  typing?: 'auto' | 'llm';
  minConfidence?: Partial<Record<SystemOneThresholdSite, number>>;
  onLowConfidence?: 'leave' | 'llm';
}
```

`SystemOneThresholdSite` carries exactly one member, on its own line. PR 3
adds `'edges'`, PR 4 adds `'resolve'`, PR 6 adds `'healScreen'` — each as one
new line, so merges keep both sides. `typeOnWrite` (PR 5b) reuses the
`'typing'` threshold key. Wire `systemOne?: SystemOneConfig` into
`WikiConfig` in `types.ts`.

### 2. Typing-mode resolution chain

Add `resolveSystemOneTyping(config)` to `engineDefaults.ts`. The chain is:

call option `classifier` → `systemOne.typing` → `ontology.backfillClassifier`
→ `'llm'`.

Resolve once per pass in `doRunOntologyBackfill`; replace the inline chain at
`MaintenanceService.ts:2085`. Use `??` and never `||`, because falsy values
are meaningful in this surface. The call option keeps its existing name and
type (`MaintenanceService.ts:1035`, `WikiMemory.ts:937`).

Failure rules:

- An invalid call option (not `'auto'` or `'llm'`) throws a `TypeError`
  before any work. Validation sits at the top of `doRunOntologyBackfill`,
  beside the `batchSize` check (`MaintenanceService.ts:2056-2058`), so it
  precedes the `mode === 'off'` early return and the DB reads. This matches
  the `deadlineMs` precedent (`MaintenanceScheduler.ts:104-105`).
- An invalid config value warns once and the resolver treats the key as
  unset, so the chain continues at the next level. Warn through a new
  `warnOnce(message)` helper in `engineDefaults.ts` that shares the
  `warnedDefaults` set with `warnChangedDefaultsOnce`
  (`engineDefaults.ts:61`). Do not call `warnChangedDefaultsOnce` itself: it
  logs every message from `changedDefaultWarnings(config)` and its only
  caller is the `WikiMemory` constructor (`WikiMemory.ts:145`).
- When both `systemOne.typing` and `ontology.backfillClassifier` are set,
  valid, and differ, warn once that two keys disagree. The newer key wins:
  `systemOne.typing` overrides `ontology.backfillClassifier`. The differ
  check runs only after validation: an invalid key is unset and does not
  participate.

### 3. Confidence floor

Add `resolveTypingMinConfidence(config)` to `engineDefaults.ts`. The chain is:

`systemOne.minConfidence.typing` → `ontology.classifyMinConfidence` → `0.5`.

Use `??` and never `||`, because `0` is a valid floor. Validate the resolved
value: finite, in [0, 1]. An invalid config value warns once (through the
same `warnOnce` helper) and is treated as unset, so the chain continues —
`ontology.classifyMinConfidence` or `0.5` still applies. This replaces the
silent fallback at `MaintenanceService.ts:2252-2253`.

Scope rule: the floor applies ONLY to classifier typing. The confidence
number comes from the host's `classify` function; the engine only compares
it. Generative typing produces no confidence — omitting a type is how the
model shows doubt. When typing resolves to `'llm'` for a pass, the floor is
never read, and the code emits no warning, because the call option can
switch modes per call. `_runClassifierBackfill` is the only read site
(`MaintenanceService.ts:2296`).

### 4. Low-confidence routing

Add `systemOne.onLowConfidence?: 'leave' | 'llm'`, default `'leave'`
(today's behavior).

- `'leave'`: a low-confidence fact stays untyped and is cooldown-stamped.
  `classification_low_confidence` still fires (`MaintenanceService.ts:2335`).
- `'llm'`: the classifier step does NOT cooldown-stamp the fact. The fact
  escalates to the generative step of the same pass, inside the same
  `tokenBudget` and the same meter. The generative model types it (with the
  possibility of edges) or omits it. This is a cost and quality setting, not
  a safety mechanism. It cannot catch a confidently wrong classifier.
  Document it that way. It is a no-op when typing resolves to `'llm'`;
  document the no-op and emit no warning. An invalid `systemOne.onLowConfidence`
  value (anything but `'leave'` or `'llm'`) warns once per process, names the
  key, and is treated as unset: the default `'leave'` applies (same
  treated-as-unset contract as the `§2` keys).

Escalation control flow (both low-confidence facts under `'llm'` routing and
abstains under §5): `_runClassifierBackfill` returns the escalated facts
un-stamped, excluded from the `attempted` set it would otherwise stamp in
full via `_applyOntologyBackfillBatch` (`MaintenanceService.ts:2466`). After
the classifier step returns, `doRunOntologyBackfill` runs the existing
generative block over only those facts — same pass, same `tokenBudget`,
same meter. Skip the generative step when the classifier step returned
`budgetStop` or aborted. Counter merge: each fact counts once in `scanned`;
`typed`, `failedValidation`, `abstained`, and `skipped` sum across the two
steps.

### 5. Classifier abstain option

Add an engine-owned sentinel option. The sentinel string is exactly
`'none_of_these'`.

- The classifier question at `MaintenanceService.ts:2258-2264` appends
  `'none_of_these'` after the manifest slugs. The prompt instructions state
  that the classifier must pick `'none_of_these'` when no listed type fits.
- The option cap at `MaintenanceService.ts:2089` stays `255` total: at most
  254 manifest slugs plus the sentinel. Passes with 255 manifest slugs fall
  back to the generative path: appending the sentinel pushes the option
  count to 256, over the 255 cap. This moves the fallback boundary by one
  relative to the pre-PR baseline, which ran the classifier with up to 255
  slugs (`slugs.length <= 255`) — a deliberate compatibility delta recorded
  in §9 (delta 4), not "as today".
  Name the cap as a constant (`CLASSIFIER_MAX_CHOICES`) at the fallback
  site; the literal has no constant or comment today.
- The engine catches the sentinel BEFORE the confidence comparison, inside
  the outcome mapping of `_runClassifierBackfill` (at
  `MaintenanceService.ts:2296`, before `_applyOntologyBackfillBatch` at
  `:2319`). A `'none_of_these'` answer is an abstain regardless of its
  confidence number; an abstained fact is never typed by the classifier
  step.
- `'none_of_these'` is a reserved slug, compared case-insensitively (slug
  matching is `trim().toLowerCase()`; see `utils/ontology.ts:20`). Manifest
  validation rejects a node type with that slug, and the emergent merge
  (`mergeEmergentUpdates`, `MaintenanceService.ts:2401`) rejects it too. If
  a manifest somehow carries it, the pass falls back to the generative
  path. Add a test for both the rejection and the fallback.
- Under `'leave'`: the fact stays untyped and is cooldown-stamped, and the
  engine emits a `classification_abstained` receipt with
  `{ factId, writer: 'classifier' }`.
- Under `'llm'`: the fact escalates exactly like a low-confidence fact
  under §4. When the generative model omits it, the engine emits
  `classification_abstained` with `{ factId, writer: 'llm' }`.

### 6. Generative omission receipts

In every typing mode, an omission — a fact in the generative batch with no
classification entry (left out of `classifications`, invalid per
`failedValidation`, or counted at the `changes === 0` site,
`MaintenanceService.ts:2443`) — emits
`classification_abstained { factId, writer: 'llm' }`. This closes the
per-fact identity gap at the batch loop (`MaintenanceService.ts:2166`); the
aggregate omission count is already derivable from
`OntologyBackfillResult` (`types.ts:126-127`). The receipt is
content-free: it names the fact and the writer, nothing else.

### 7. node_type_assigned receipts

Each accepted typing emits `node_type_assigned { factId, okfType, writer }`.
The receipt is content-free and fires on both the classifier and the
generative paths, only while ontology mode is not `'off'`. Both new receipt
codes ride the existing diagnostic buffer pattern
(`MaintenanceService.ts:2333-2346`).

### 8. Typing joins runPendingMaintenance (R-MAINT-TYPING)

Add `'ontologyBackfill'` (spec-era name `'typing'`) to `MaintenanceJob` (`types.ts:1795`) and to the default job
set at `MaintenanceScheduler.ts:112`. The full integration:

- `PendingMaintenance` (`types.ts:1734`) gains a typing-pending field;
  pending detection in `getPending` (`MaintenanceScheduler.ts:47-86`) sets
  it for entities whose ontology mode is not `'off'` and that hold untyped
  facts past the recheck cutoff.
- Widen the pending filter at `MaintenanceScheduler.ts:115` (today it drops
  entities whose only pending work is typing) and the `State`/`openJobs`
  handling in the loop.
- `MaintenanceStopReason.job` widens too: `budget_too_small.job` is
  `'librarian' | 'heal'` today (`types.ts:1767`).
- Adding `'ontologyBackfill'` to `MaintenanceJob` makes it a `LockedMaintenanceJob`
  (`types.ts:1732`) automatically. The typing job acquires the existing
  `'ontologyBackfill'` lock (`MaintenanceService.ts:1037`); `busy[]`
  reports `'ontologyBackfill'` while that lock is held.
- `EntityMaintenanceReport` gains a typing counter.
- The typing job calls `doRunOntologyBackfill` (not the public
  `runOntologyBackfill`) inside the host-passed token budget, with the
  scheduler's shared meter, and needs a trigger other than the hard-coded
  `'call'` at `MaintenanceService.ts:2333`.
- Loop exit: clear the typing-pending flag when `remaining === 0`, on
  `budgetStop`, or when a pass types nothing. There is NO write-triggered
  typing: `write()` never starts the typing job on its own.
- The release note must state both the join and the no-write-trigger facts.

### 9. Compatibility lock

With no `systemOne` key set and no call option, every path still uses
today's resolution chain and defaults: typing resolves `'llm'` unless
`ontology.backfillClassifier` says otherwise, the floor is
`classifyMinConfidence` or `0.5`, and low-confidence facts stay untyped.
Four deliberate changes remain even with no new keys; §9 lists all of
them:

1. The classifier question appends the `'none_of_these'` sentinel whenever
   the classifier path runs (§5). This is the one within-pass behavior
   change.
2. The new receipts fire: `node_type_assigned` on both paths (§7) and
   `classification_abstained` for classifier abstains and generative
   omissions (§5-§6).
3. `'ontologyBackfill'` joins the default `runPendingMaintenance` job set (§8), so a
   host that calls it with no `jobs` now spends `generateText` tokens on
   typing.
4. The classifier fallback boundary moves by one at the option cap (§5): a
   pass over 255 manifest slugs — the sentinel appended, 256 options over
   `CLASSIFIER_MAX_CHOICES` (255) — falls back to the generative path,
   where the pre-PR baseline ran the classifier with 255 slugs. This is the
   only change to a legacy-`'auto'` path with no new keys.

Capability alone still never switches paths (REQ-COMPAT-01.5,
`types.ts:765`).

### 10. Config-surface boundary

S1-0 owns exactly: `systemOne.typing`, `systemOne.minConfidence` (with the
`'typing'` member), `systemOne.onLowConfidence`, the abstain sentinel, the
receipts in §6-§7, and the `'ontologyBackfill'` maintenance job. Later PRs own:
`edges` (PR 3), `resolve` (PR 4), `healScreen` (PR 6), `typeOnWrite` (PR 5b),
`shortlistK` (PR 2b). This spec does not define them.
`librarian.destructiveEdits` is ruled to D2 / PR 4 — exclude it here.

## Files touched

- `packages/core/src/config/systemOne.ts` — new file; `SystemOneConfig`,
  `SystemOneThresholdSite`.
- `packages/core/src/utils/engineDefaults.ts` — `resolveSystemOneTyping`,
  `resolveTypingMinConfidence`, the `warnOnce(message)` helper, both-set-
  differ and invalid-config warnings.
- `packages/core/src/types.ts` — `WikiConfig.systemOne` (the :100-110 region
  around `backfillClassifier` at :106 and `classifyMinConfidence` at :108);
  `MaintenanceJob` at :1729; `OntologyBackfillResult` at :128 gains an
  `abstained` counter (open question 2); `WikiDiagnosticCode` (:865-872 region) gains
  `classification_abstained` and `node_type_assigned`, each with a fixed
  severity; `PendingMaintenance` at :1734 gains a typing-pending field;
  `EntityMaintenanceReport` gains a typing counter; `budget_too_small.job`
  at :1767 widens to include `'ontologyBackfill'`.
- `packages/core/src/services/MaintenanceService.ts` — resolver call sites
  (:2085, :2252-2253), question build (:2258-2264), outcome mapping and
  receipts (:2293-2346), generative omission receipts (:2166 region),
  escalation control flow (classifier step returns escalated facts
  un-stamped; generative block runs over them), `CLASSIFIER_MAX_CHOICES`
  constant, manifest validation and emergent merge reserve
  `'none_of_these'`.
- `packages/core/src/services/MaintenanceScheduler.ts` — job set (:112),
  `getPending` (:47-86) and the :115 filter, `State`/`openJobs` handling,
  typing loop with exit rules.
- `packages/core/src/utils/ontology.ts` — manifest validation rejects the
  reserved slug.
- `packages/core/src/index.ts` — export the new config type and resolvers.
- Docs, same PR: `apps/docs/src/content/docs/reference/configuration.md:91-92`
  (key table rows for the new keys), `apps/docs/src/content/docs/guides/ontologies.md:183-201`
  (classifier section: abstain, onLowConfidence, new key names) and the
  old-key mentions at `:206` and `apps/docs/src/content/docs/guides/llm-provider.mdx:151-153`,
  `apps/docs/src/content/docs/reference/wiki-memory.md` — amend the
  `runPendingMaintenance` row at `:118` (its `jobs` list gains `'ontologyBackfill'`),
  not a new row; the `runOntologyBackfill` signature row at `:116` stays.
- R-MAINT-TYPING release note — carried in the `feat(core)` commit body and the
  docs (semantic-release owns `CHANGELOG.md`; plan errata, T3 review 2026-11-21).

## Test plan

Unit tests (vitest, beside the existing backfill tests):

1. Resolver chain: each precedence level wins in turn; a call option
   overrides both config keys; nothing set resolves `'llm'`.
2. `??` semantics: floor `0` resolves to `0`, not `0.5`.
3. Invalid call option throws a `TypeError` before any I/O, including
   before the `mode === 'off'` early return.
4. Invalid config value warns once, resolves as unset, and the second
   pass prints nothing (warn-once is per message, not per construction).
5. Both keys set, valid, and differ: warns once; `systemOne.typing` wins.
   One key invalid: no differ warning; the valid chain applies.
6. Floor applies only in `_runClassifierBackfill`; with typing `'llm'`, a
   set floor never reads and no warning fires.
7. Abstain: classifier returns `'none_of_these'`; under `'leave'` the fact
   stays untyped, is stamped, and emits `classification_abstained { writer:
   'classifier' }`; under `'llm'` it escalates and an omission emits
   `{ writer: 'llm' }`. A `'none_of_these'` answer below the floor still
   counts as an abstain, not low confidence.
8. Cap: 254 slugs plus the sentinel fits; 255 slugs falls back to the
   generative path.
9. Escalation: in an `'auto'` pass with `onLowConfidence: 'llm'`, the
   classifier step returns escalated facts un-stamped, the generative
   block runs over only those facts in the same pass under the same
   `tokenBudget` and meter, `scanned` counts each fact once, and a
   classifier-step `budgetStop` skips the generative step. With typing
   `'llm'` the option is a no-op.
10. Receipts: `node_type_assigned` fires on both paths, only when mode is
    not `'off'`; generative omission emits `classification_abstained`.
11. Reserved slug: manifest validation and the emergent merge reject
    `'none_of_these'` (case-insensitive); a manifest that carries it falls
    back to the generative path.
12. Scheduler: typing pending reported only for mode-not-`'off'` entities
    with untyped facts past the cutoff; the job runs only when selected,
    acquires the `'ontologyBackfill'` lock, reports `'ontologyBackfill'` in `busy[]`
    and in the stop reason, respects `deadlineMs` and `tokenBudget`, and
    `write()` never triggers it. Loop exits when the pass types nothing.
13. Compatibility: with no new keys, behavior matches the pre-PR baseline
    for resolution, defaults, and cooldowns; the deltas are the sentinel in
    the classifier question, the new receipts, `'ontologyBackfill'` in the default
    job set, and the 255-slug fallback boundary move (§9 deltas 1-4) —
    assert all four.

## Out of scope / rejected alternatives

- `||` in the resolvers. Rejected: `0` is a valid floor and `||` would eat
  it (ruled in D3).
- A host-declared abstain alias (the host renames the sentinel). Rejected in
  the D1 ruling: machine curation only.
- Moving the 255 cap to a host-declared provider limit. Rejected for this
  PR; `ClassifyRequest` has no limits field. Recorded as a follow-up.
- Write-triggered `'auto'` typing on `write()`. Rejected by R-MAINT-TYPING.
- `systemOne.preset`. Rejected in PLAN-v4: a preset bundle would switch
  paths on during upgrades, which violates REQ-COMPAT-01.5's spirit.
- `librarian.destructiveEdits`. Ruled to D2 / PR 4; not here.
- Margin rule on the abstain decision (abstain unless the top choice leads
  the runner-up by a margin). Ruled optional (Fable PB-1). Listed as an open
  question below.

## Open questions for the owner

1. Does the optional margin rule (abstain when the top-two confidence gap is
   below a margin) ship in S1-0 or land as a follow-up?
2. Should `OntologyBackfillResult` gain an `abstained` counter alongside
   `typed` and `failedValidation`, or does the receipt stream alone carry
   the count? (The Files-touched section assumes yes; the counter-merge
   rule in §4 depends on it.)

**Ruled by owner, 2026-11-21:** (1) The optional margin rule is a
follow-up — it needs real-world calibration data to set the margin, and
S1-0 stays minimal. (2) The `abstained` counter ships — the Files-touched
assumption stands and §4's counter-merge rule depends on it.
