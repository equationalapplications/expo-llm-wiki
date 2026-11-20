# Spec — S1-0: System-One Config Surface

Status: DRAFT (design ruled — handoff ledger D3/D4, consult ADJUDICATION-r3/r3a; Wave 1 of PLAN-v5)

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
  before any work. This matches the `batchSize` precedent
  (`MaintenanceService.ts:2056-2058`).
- An invalid config value warns once and the resolver treats the key as
  unset. Warn through `warnChangedDefaultsOnce` (`engineDefaults.ts:61`), so
  the message prints at most once per process.
- When both `systemOne.typing` and `ontology.backfillClassifier` are set and
  differ, warn once that two keys disagree. The newer key wins:
  `systemOne.typing` overrides `ontology.backfillClassifier`.

### 3. Confidence floor

Add `resolveTypingMinConfidence(config)` to `engineDefaults.ts`. The chain is:

`systemOne.minConfidence.typing` → `ontology.classifyMinConfidence` → `0.5`.

Use `??` and never `||`, because `0` is a valid floor. Validate the resolved
value: finite, in [0, 1]. An invalid config value warns once and resolves to
`0.5`. This replaces the silent fallback at
`MaintenanceService.ts:2252-2253`.

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
  joins the generative batch of the same pass, inside the same `tokenBudget`
  and the same meter. The generative model types it (with the possibility of
  edges) or omits it.

This is a cost and quality setting, not a safety mechanism. It cannot catch
a confidently wrong classifier. Document it that way. It is a no-op when
typing resolves to `'llm'`; document the no-op and emit no warning.

### 5. Classifier abstain option

Add an engine-owned sentinel option. The sentinel string is exactly
`'none_of_these'`.

- The classifier question at `MaintenanceService.ts:2258-2264` appends
  `'none_of_these'` after the manifest slugs. The prompt instructions state
  that the classifier must pick `'none_of_these'` when no listed type fits.
- The option cap at `MaintenanceService.ts:2089` stays `255` total: at most
  254 manifest slugs plus the sentinel. Passes with 255 manifest slugs fall
  back to the generative path, as today (`MaintenanceService.ts:2089-2091`).
- The engine catches the sentinel before acceptance, inside the outcome
  mapping of `_runClassifierBackfill` (before
  `_applyOntologyBackfillBatch` at `MaintenanceService.ts:2319`). An
  abstained fact is never typed by the classifier step.
- Under `'leave'`: the fact stays untyped and is cooldown-stamped, and the
  engine emits a `classification_abstained` receipt with
  `{ factId, writer: 'classifier' }`.
- Under `'llm'`: the fact escalates exactly like a low-confidence fact
  under §4. When the generative model omits it, the engine emits
  `classification_abstained` with `{ factId, writer: 'llm' }`.

### 6. Generative omission receipts

In every typing mode, a fact the generative model scans but leaves untyped
emits `classification_abstained { factId, writer: 'llm' }`. This closes the
silent gap at the batch loop (`MaintenanceService.ts:2166`). The receipt is
content-free: it names the fact and the writer, nothing else.

### 7. node_type_assigned receipts

Each accepted typing emits `node_type_assigned { factId, okfType, writer }`.
The receipt is content-free and fires on both the classifier and the
generative paths, only while ontology mode is not `'off'`. These are
diagnostics in the existing diagnostic buffer pattern
(`MaintenanceService.ts:2333-2346`).

### 8. Typing joins runPendingMaintenance (R-MAINT-TYPING)

Add `'typing'` to `MaintenanceJob` (`types.ts:1729`) and to the default job
set at `MaintenanceScheduler.ts:112`. Pending detection reports typing as
pending for entities whose ontology mode is not `'off'` and that hold
untyped facts past the recheck cutoff. The typing job runs
`runOntologyBackfill` inside the host-passed token budget. There is NO
write-triggered typing: `write()` never starts the typing job on its own.
The release note must state both facts.

### 9. Compatibility lock

With no `systemOne` key set and no call option, every path behaves
byte-identically to today: typing resolves `'llm'` unless
`ontology.backfillClassifier` says otherwise, the floor is `classifyMinConfidence` or `0.5`, low-confidence facts stay
untyped, and no receipt fires. Abstain is engine-owned question design, so
the sentinel rides the classifier path whenever the classifier path runs.
This is the one deliberate within-pass behavior change. Capability alone still never switches
paths (REQ-COMPAT-01.5, `types.ts:765`).

### 10. Config-surface boundary

S1-0 owns exactly: `systemOne.typing`, `systemOne.minConfidence` (with the
`'typing'` member), `systemOne.onLowConfidence`, the abstain sentinel, the
receipts in §6-§7, and the `'typing'` maintenance job. Later PRs own:
`edges` (PR 3), `resolve` (PR 4), `healScreen` (PR 6), `typeOnWrite` (PR 5b),
`shortlistK` (PR 2b). This spec does not define them.
`librarian.destructiveEdits` is ruled to D2 / PR 4 — exclude it here.

## Files touched

- `packages/core/src/config/systemOne.ts` — new file; `SystemOneConfig`,
  `SystemOneThresholdSite`.
- `packages/core/src/utils/engineDefaults.ts` — `resolveSystemOneTyping`,
  `resolveTypingMinConfidence`, both-set-differ and invalid-config warnings.
- `packages/core/src/types.ts` — `WikiConfig.systemOne` (the :100-110 region
  around `backfillClassifier` at :106 and `classifyMinConfidence` at :108);
  `MaintenanceJob` at :1729; `OntologyBackfillResult` at :128 if the result
  gains an abstained counter.
- `packages/core/src/services/MaintenanceService.ts` — resolver call sites
  (:2085, :2252-2253), question build (:2258-2264), outcome mapping and
  receipts (:2293-2346), generative omission receipts (:2166 region),
  escalation into the generative batch.
- `packages/core/src/services/MaintenanceScheduler.ts` — job set and pending
  detection (:112, :115, :121-123).
- `packages/core/src/index.ts` — export the new config type and resolvers.
- Docs, same PR: `apps/docs/src/content/docs/reference/configuration.md:91-92`
  (key table rows for the new keys), `apps/docs/src/content/docs/guides/ontologies.md:183-201`
  (classifier section: abstain, onLowConfidence, new key names),
  `apps/docs/src/content/docs/reference/wiki-memory.md:116`
  (`runOntologyBackfill` signature row unchanged; typing job row added).
- CHANGELOG entry plus the R-MAINT-TYPING release note.

## Test plan

Unit tests (vitest, beside the existing backfill tests):

1. Resolver chain: each precedence level wins in turn; a call option
   overrides both config keys; nothing set resolves `'llm'`.
2. `??` semantics: floor `0` resolves to `0`, not `0.5`.
3. Invalid call option throws a `TypeError` before any I/O.
4. Invalid config value warns once, resolves as unset, and the second
   construction prints nothing.
5. Both keys set and differ: warns once; `systemOne.typing` wins.
6. Floor applies only in `_runClassifierBackfill`; with typing `'llm'`, a
   set floor never reads and no warning fires.
7. Abstain: classifier returns `'none_of_these'`; under `'leave'` the fact
   stays untyped, is stamped, and emits `classification_abstained { writer:
   'classifier' }`; under `'llm'` it escalates and an omission emits
   `{ writer: 'llm' }`.
8. Cap: 254 slugs plus the sentinel fits; 255 slugs falls back to the
   generative path.
9. `onLowConfidence: 'llm'`: a low-confidence fact joins the generative
   batch in the same pass under the same `tokenBudget` and meter; with
   typing `'llm'` the option is a no-op.
10. Receipts: `node_type_assigned` fires on both paths, only when mode is
    not `'off'`; generative omission emits `classification_abstained`.
11. Scheduler: typing job runs only for mode-not-`'off'` entities; the job
    respects `deadlineMs` and `tokenBudget`; `write()` never triggers it.
12. Compatibility: with no new keys, behavior matches the pre-PR baseline
    except the sentinel in the classifier question; assert both.

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
2. Under `onLowConfidence: 'llm'`, do escalated facts join the FIRST
   generative batch of the same pass, or trail after the scheduled batches?
   Trailing keeps batch composition deterministic.
3. Should `OntologyBackfillResult` gain an `abstained` counter alongside
   `typed` and `failedValidation`, or does the receipt stream alone carry
   the count?
