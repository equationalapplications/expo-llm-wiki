# Implementation plan — S1-0 System-One config surface (PR #442), spec approved 2026-11-21

Baseline: specs/system-one-config/spec.md @ 3378b3bb, branch `spec/system-one-config`,
worktree `.hermes/cache/scratch/elw-spec-s1config`. All owner rulings are folded
(margin rule = follow-up; `abstained` counter ships). This PR is FIRST among the four
lane-2 spec PRs (roadmap step 5). Implementation is gated on Kurt's plan approval;
nothing here starts until he says go.

Conventions: T-numbers map to spec sections. Each task ends green on
`pnpm -r typecheck` plus the core unit suite. Commits are conventional and name the
spec section they fulfill. Every claim below was verified against the tree at
authoring time (pins re-checked 2026-11-21).

## Merge position and coordination (binding on this plan)

### C1. First-lander receipt rule (spec §7)

Assumption: PR #441 (ontology-curation) has NOT merged before this PR starts
implementation. Under that assumption this PR emits the backfill typing-path
`node_type_assigned` receipts ({ factId, okfType, writer }, T5) and owns the code
end to end. Pre-flight check before T5 dispatch: `git log origin/main --oneline |
grep -i ontology-curation` — if a merge commit for #441 appears, T5 switches to
reuse: no second emitter, this PR only asserts the existing receipts in its tests,
and the diff must add zero emitter sites. Receipt ownership between this PR and
#441 splits by emitter site (controller adjudication 2026-11-20): this PR owns
`node_type_assigned` on the backfill typing paths and the `classification_abstained`
omission receipts; #441 owns its door receipts (`node_type_dropped`,
`node_type_folded`, `ontology_update_rejected`, `ingest_zero_facts`) and only
consumes `node_type_assigned` in its audit join.

### C2. File-overlap seams with #441

Shared files: `MaintenanceService.ts`, `MaintenanceScheduler.ts`, `types.ts`,
`utils/ontology.ts`, `utils/engineDefaults.ts`, `index.ts`. Region ownership this
plan commits to (each seam is line-level, so both plans can merge cleanly):

| Region | Owner |
|---|---|
| `MaintenanceService.ts:2085` typing-mode chain, `:2252-2253` floor, `:2258-2264` question build, `:2089` cap constant, `:2293-2346` outcome mapping and receipts, `:2166` region omission receipts, escalation control flow, `:2401` emergent-merge slug reserve | S1-0 (this PR) |
| `MaintenanceService.ts` `recheckCheckedBefore` option; door receipts in the apply path; prompt wording (`prompts/ontology.ts`, `prompts.ts`); `LintService`; `validateAndNormalizeFact` widening | #441 |
| `MaintenanceScheduler.ts` + `runPendingMaintenance` typing job, `getPending`, `:115` filter, `State`/`openJobs` | S1-0 (spec §8, R-MAINT-TYPING) — see C3 |
| `utils/ontology.ts` — manifest validation rejects the reserved slug (§5) | S1-0 (this PR) |
| `utils/ontology.ts` — normalized matching in `resolveNodeType`/`resolveEdgeDefinitions` and merge rejections | #441 |
| `utils/engineDefaults.ts` — resolvers and `warnOnce` | S1-0 (this PR); #441 cites the same file only as precedent |
| `types.ts` — `systemOne`, `MaintenanceJob`, `PendingMaintenance`, `OntologyBackfillResult.abstained`, `EntityMaintenanceReport`, `budget_too_small.job`, `classification_abstained`, `node_type_assigned` | S1-0 (this PR) |
| `types.ts` — `WikiLintReport` fields, `RunOntologyBackfillOptions`, #441's diagnostic codes | #441 |

Each type edit adds its own lines in its own hunk; no PR rewrites a sibling's
lines. `MaintenanceJob` and `LockedMaintenanceJob` are union widenings, so both
sides merge textually if #441 lands after this PR.

### C3. Scheduler seam flag (controller item)

Both the approved S1-0 spec (§8) and the #441 spec (§11) cite R-MAINT-TYPING and
describe the `'typing'` job join. The S1-0 spec is the approved, ruled document and
this plan implements its §8 in full (T6). If #441 lands first and its §11 landed
with it, T6 collapses to reuse (tests only, zero scheduler edits), same rule as C1.
The controller should confirm at merge time that exactly ONE of the two PRs carries
the scheduler machinery.

### C4. Reserved-slug location flag (controller item)

The approved S1-0 spec §5 requires manifest validation to reject `'none_of_these'`.
The #441 spec's out-of-scope list rejects reserving the slug inside
`validateManifest` (it runs on every read) and states S1-0 chooses the sentinel at
question build instead. This plan follows the approved S1-0 ruling but implements it
pass-time, not per-read: the rejection lives in the backfill pass's manifest check
and the emergent merge (`MaintenanceService.ts:2401`), with the §5 fallback to the
generative path when a manifest already carries the slug. `validateManifest` itself
stays untouched. The controller should confirm #441's plan adopts the same framing.

### C5. Boundary fence (do not pre-add)

`SystemOneThresholdSite` ships with EXACTLY ONE member, `'typing'`, on its own line
(T1). PR 3 adds `'edges'`, PR 4 adds `'resolve'`, PR 6 adds `'healScreen'` — each as
one new line in their own PRs; PR 5b reuses the `'typing'` key; PR 2b adds
`shortlistK`. No task in this plan may touch a member line for any site other than
`'typing'`, and no task may add any key outside the §10 boundary (`systemOne.typing`,
`systemOne.minConfidence` with the `'typing'` member, `systemOne.onLowConfidence`,
the abstain sentinel, the §6-§7 receipts, the `'typing'` maintenance job).
`librarian.destructiveEdits` is excluded (ruled to D2 / PR 4).

## Task breakdown

### T1 — Config namespace and types (spec §1, §10)
Files: `packages/core/src/config/systemOne.ts` (new), `packages/core/src/types.ts`
(`WikiConfig.systemOne` beside the `ontology` block at `types.ts:100-110`).
- New file ships `SystemOneThresholdSite = 'typing'` (one member, one line, C5
  fence) and `SystemOneConfig` exactly as the spec's §1 block states.
- Wire `systemOne?: SystemOneConfig` into `WikiConfig` with a doc comment naming
  the config-surface boundary (§10).
Acceptance: typecheck green; the new file exports exactly the two symbols; no other
site in the repo reads `config.systemOne` yet.

### T2 — Resolvers and warn-once helper (spec §2, §3)
Files: `packages/core/src/utils/engineDefaults.ts`, `packages/core/src/index.ts`.
- `resolveSystemOneTyping(config)`: call option `classifier` → `systemOne.typing` →
  `ontology.backfillClassifier` → `'llm'`. `??` only, never `||`.
- `resolveTypingMinConfidence(config)`: `systemOne.minConfidence.typing` →
  `ontology.classifyMinConfidence` → `0.5`. `??` only (`0` is a valid floor).
  Validate the resolved value: finite, in [0, 1].
- `warnOnce(message)` helper sharing the `warnedDefaults` set
  (`engineDefaults.ts:61`). Invalid config values warn once and resolve as unset.
  Do NOT call `warnChangedDefaultsOnce` (it replays `changedDefaultWarnings(config)`
  and its only caller is the `WikiMemory` constructor, `WikiMemory.ts:145`).
- Both keys valid and differing: warn once that the keys disagree; `systemOne.typing`
  wins. The differ check runs only after validation. The differ warning is config-
  level, so it lives behind the config resolver, not the call-option path.
- Export both resolvers and the config type from `index.ts` (new public surface —
  the module is internal today).
Acceptance (spec tests 1-6): each precedence level wins in turn; floor `0`
resolves `0`; invalid config warns once and the second pass prints nothing
(per-message set); differ warns once with the newer key winning; one invalid key
yields no differ warning; with typing `'llm'` the floor never reads.

### T3 — MaintenanceService wiring: chain, floor, question, sentinel, reserve (spec §2, §3, §5)
Files: `packages/core/src/services/MaintenanceService.ts`,
`packages/core/src/utils/ontology.ts` (pass-time reserve check only — see C4).
- Replace the inline chain at `MaintenanceService.ts:2085` with
  `resolveSystemOneTyping`, resolved once per pass in `doRunOntologyBackfill`. The
  call option keeps its name and type (`MaintenanceService.ts:1035`,
  `WikiMemory.ts:937`).
- Invalid call option: throw `TypeError` at the top of `doRunOntologyBackfill`,
  beside the `batchSize` check (`:2056-2058`), BEFORE the `mode === 'off'` early
  return and any DB read (`deadlineMs` precedent, `MaintenanceScheduler.ts:104-105`).
- Replace the silent floor fallback at `:2252-2253` with
  `resolveTypingMinConfidence`. Floor applies ONLY in `_runClassifierBackfill`
  (`:2296` read site); with typing `'llm'` it is never read and emits no warning.
- Question build at `:2258-2264` appends `'none_of_these'` after the manifest slugs;
  instructions state the classifier must pick it when no listed type fits. Name the
  cap `CLASSIFIER_MAX_CHOICES` at the `:2089` fallback site; cap stays 255 total
  (254 slugs + sentinel); 255 slugs falls back to the generative path as today.
- Pass-time manifest check + `mergeEmergentUpdates` (`:2401`) reject the reserved
  slug case-insensitively (`trim().toLowerCase()`, `utils/ontology.ts:20`); a
  manifest carrying it falls back to the generative path. `validateManifest`
  untouched (C4).
Acceptance (spec tests 3, 8, 11): TypeError precedes the off-early-return; 254 +
sentinel fits, 255 falls back; both reserve rejections fire case-insensitively and
the fallback runs.

### T4 — Outcome mapping: abstain, routing, escalation, counters (spec §4, §5)
Files: `packages/core/src/services/MaintenanceService.ts`, `packages/core/src/types.ts`
(`OntologyBackfillResult.abstained` at `:128`).
- Catch `'none_of_these'` BEFORE the confidence comparison inside the outcome
  mapping of `_runClassifierBackfill` (`:2296`, before `_applyOntologyBackfillBatch`
  at `:2319`). An abstain is an abstain regardless of its confidence number.
- `onLowConfidence: 'leave'` (default): low-confidence facts stay untyped and
  cooldown-stamped; `classification_low_confidence` still fires (`:2335-2336`).
- `onLowConfidence: 'llm'`: `_runClassifierBackfill` returns escalated facts
  (low-confidence under `'llm'` routing, abstains under §5) un-stamped, excluded
  from the `attempted` set. After the classifier step, `doRunOntologyBackfill` runs
  the existing generative block over ONLY those facts — same pass, same
  `tokenBudget`, same meter. Skip the generative step when the classifier step
  returned `budgetStop` or aborted. Counter merge: each fact counts once in
  `scanned`; `typed`, `failedValidation`, `abstained`, `skipped` sum across steps.
- The option is a cost/quality setting, not a safety mechanism; no-op when typing
  resolves `'llm'` — document the no-op, emit no warning.
- Ship the `abstained` counter (owner-ruled to ship).
Acceptance (spec tests 7, 9): abstain below the floor is an abstain, not low
confidence; escalation runs generative over only the escalated facts in-pass;
`scanned` counts each fact once; classifier `budgetStop` skips the generative step;
`'llm'` typing makes the option a no-op.

### T5 — Receipts (spec §6, §7; C1 first-lander rule)
Files: `packages/core/src/services/MaintenanceService.ts`, `packages/core/src/types.ts`
(`WikiDiagnosticCode` at the `:865-872` region gains `classification_abstained` and
`node_type_assigned`, each with a fixed severity).
- `node_type_assigned { factId, okfType, writer }` fires on BOTH paths, only while
  ontology mode is not `'off'`, riding the diagnostic buffer pattern
  (`:2333-2346`).
- Generative omission — fact in the batch with no classification entry (missing
  from `classifications`, `failedValidation`, or the `changes === 0` count at
  `:2443`) — emits `classification_abstained { factId, writer: 'llm' }` in every
  typing mode. Content-free receipts; this closes the per-fact identity gap at the
  batch loop (`:2166`).
- Classifier abstain under `'leave'`: `classification_abstained
  { factId, writer: 'classifier' }`, fact stays untyped and cooldown-stamped.
  Under `'llm'`: emit only when the generative model omits it (`writer: 'llm'`).
- PRE-FLIGHT (C1): re-check whether #441 merged; if yes, drop the emitter edits and
  keep only the assertions.
Acceptance (spec test 10): receipts fire on both paths; gate on mode-not-`'off'`;
omissions emit with `writer: 'llm'`; receipts are content-free.

### T6 — Typing joins runPendingMaintenance (spec §8; C3 seam)
Files: `packages/core/src/types.ts` (`MaintenanceJob` at `:1729`,
`PendingMaintenance` typing-pending field at `:1734`, `budget_too_small.job` at
`:1767` widens to `'librarian' | 'heal' | 'typing'`, `EntityMaintenanceReport`
typing counter), `packages/core/src/services/MaintenanceScheduler.ts` (job set at
`:112`, `getPending` at `:47-86`, the `:115` filter, `State`/`openJobs` handling,
typing loop), `packages/core/src/services/MaintenanceService.ts` (trigger param).
- Pending typing: entities whose ontology mode is not `'off'` and that hold untyped
  facts past the recheck cutoff.
- Widen the `:115` filter (today it drops typing-only entities) and the
  `State`/`openJobs` handling.
- `'typing'` becomes a `LockedMaintenanceJob` automatically; the job acquires the
  existing `'ontologyBackfill'` lock (`MaintenanceService.ts:1037`); `busy[]`
  reports `'typing'` while held.
- The typing job calls `doRunOntologyBackfill` inside the host-passed token budget
  with the scheduler's shared meter, and passes a trigger other than the hard-coded
  `'call'` at `MaintenanceService.ts:2333`.
- Loop exit: clear the typing-pending flag when `remaining === 0`, on `budgetStop`,
  or when a pass types nothing. NO write-triggered typing: `write()` never starts
  the job.
Acceptance (spec test 12): pending reported only for mode-not-`'off'` entities with
untyped facts past the cutoff; job runs only when selected; lock and `busy[]`
behavior; `deadlineMs` and `tokenBudget` respected; `write()` never triggers it;
loop exits when a pass types nothing.

### T7 — Docs, CHANGELOG, release note (spec Files-touched, §8 release note)
Files: `apps/docs/src/content/docs/reference/configuration.md:91-92` (key table
rows), `apps/docs/src/content/docs/guides/ontologies.md:183-201` plus the old-key
mentions at `:206` and `apps/docs/src/content/docs/guides/llm-provider.mdx:151-153`,
`apps/docs/src/content/docs/reference/wiki-memory.md:118` (amend the
`runPendingMaintenance` row — its `jobs` list gains `'typing'`; NOT a new row; the
`runOntologyBackfill` row at `:116` stays), CHANGELOG entry.
- Release note states BOTH facts: `'typing'` joins the default
  `runPendingMaintenance` job set, and `write()` never triggers typing.
- `onLowConfidence: 'llm'` is documented as a cost/quality setting, not a safety
  mechanism — it cannot catch a confidently wrong classifier. The `'llm'`-mode no-op
  is documented.
- Document the three §9 compatibility deltas (sentinel in the question, new
  receipts, `'typing'` in the default job set).
Acceptance: docs build green; the §9 three deltas appear verbatim in the release
note; the `wiki-memory.md` amendment touches the existing row only.

### T8 — Compatibility lock verification (spec §9)
No new production code; test-only.
Acceptance (spec test 13): with no new keys, resolution, defaults, and cooldowns
match the pre-PR baseline; the ONLY deltas are the sentinel in the classifier
question, the new receipts, and `'typing'` in the default job set — assert all
three. Capability alone never switches paths (REQ-COMPAT-01.5, `types.ts:765`).

## Commit sequence

1. `feat(core): System-One config namespace and threshold site (spec §1)` — T1
2. `feat(core): System-One typing and floor resolvers with warn-once (spec §2-§3)` — T2
3. `feat(core): wire System-One chain, floor, abstain sentinel into backfill (spec §2-§3, §5)` — T3
4. `feat(core): low-confidence routing, abstain outcome, escalation counters (spec §4-§5)` — T4
5. `feat(core): node_type_assigned and classification_abstained receipts (spec §6-§7)` — T5
6. `feat(core): typing joins runPendingMaintenance (spec §8, R-MAINT-TYPING)` — T6
7. `docs: System-One config keys, abstain routing, typing job release note (spec §7-§9)` — T7
8. `test(core): S1-0 compatibility lock (spec §9)` — T8

Each commit's tests run green before the next commits. Ledger boxes tick only after
verification, per house rule.

## Risks

- **Draft-PR base drift**: lane-2 siblings merge ahead of this PR. Mitigation: the
  lifecycle merge sync (`git merge origin/main`) at implementation start; seams C2
  are line-level so textual conflicts stay local.
- **`#441` merges mid-implementation**: T5 and T6 pre-flights (C1, C3) collapse the
  affected tasks to reuse; the ledger records the check.
- **Escalation counter drift**: the counter-merge rule depends on the `abstained`
  counter shipping (owner-ruled). T4 lands it in the same commit as the merge rule,
  so the pair cannot split.
- **`warnOnce` sharing the `warnedDefaults` set**: a malformed message could
  suppress a defaults-changed warning. Mitigation: `warnOnce` messages carry a
  distinct `[system-one]` prefix; test 4 asserts per-message independence.

## Out of scope (restated from spec)

Margin rule (follow-up, owner-ruled); host-declared abstain alias (rejected, D1);
host-declared provider cap (follow-up); write-triggered `'auto'` typing (rejected,
R-MAINT-TYPING); `systemOne.preset` (rejected, PLAN-v4); `librarian.destructiveEdits`
(D2 / PR 4); every threshold site beyond `'typing'` (C5 fence).
