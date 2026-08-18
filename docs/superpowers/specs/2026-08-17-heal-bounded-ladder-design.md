# Heal Output-Bounded Convergence Ladder

Status: Implemented

Closes the non-convergent path in `doRunHeal` whose `runBatched` bisect can only shrink the candidate list. A new `attemptLevel` ladder lets `runBatched` shed shared context when candidate count is already at its minimum, and lets heal bound the one remaining unbounded input — `allTasks` — at L0.

Follows the #67 ("Maintenance Output Bounding") and #96 ("instanceof Error Proxy guard") specs. Fixes the regression reported in #101.

## Problem

`runBatched` (`packages/core/src/services/BoundedLlmCall.ts`) treats "response too large" as a function of the **candidate count** and recovers by halving the batch. For `doRunHeal` the batch is one of four inputs in the prompt; the other three (document anchors, pending tasks, recent events) are **shared context** that is rebuilt identically at every batch size and never trimmed.

The result: bisecting from 10 candidates down to 1 barely shrinks the prompt and therefore barely shrinks the output. For any fact whose shared context dominates the prompt, the recovery path cannot converge. Each failed attempt generates all the way to the output ceiling before erroring, so one non-convergent fact costs up to four max-length generations and consumes a disproportionate share of the maintenance pass's wall-clock budget.

Observed in `core-llm-wiki@5.4.0` against Bedrock, output ceiling 16384 tokens. Twelve `heal skipped` warnings in a 24h window, each at `batch.length === 1` after a 10→5→3→2→1 split sequence. The Lambda 900s budget was exhausted multiple times by a small number of non-convergent facts whose `allTasks` (entity-global, unbounded via `TaskRepository.findAllPending`) and `documentAnchors` (capped at `HEAL_MAX_ANCHORS = 50`) dominated the prompt.

### Direction 4 from #101 is mostly already shipped

The issue suggests skipped facts "are not stamped, so they return as a candidate on the next pass and fail identically." This is not the actual re-failure mechanism in 5.4.0: `MaintenanceService.ts` already calls `entryRepo.markHealChecked([...healCandidates, ...insertedFacts])` at the end of the transaction, so skipped facts are stamped. The real re-failure mechanism is that the pass times out and the transaction never commits, so the recheck cooldown never applies. This spec does not change the stamping behavior — the existing comment on lines 836–849 of `MaintenanceService.ts` is correct and stays.

What #101's direction 4 *did* identify correctly is that the operator has no way to see **which** fact ids were skipped (today's `HealResult.skipped` is a bare count) and no signal when a fact was healed under a degraded view of itself. Both are addressed in this spec.

## Scope

### In scope
- `runBatched` learns a four-level escalation ladder (`0|1|2|3`) gated on `isTruncationError(err) && batch.length === 1 && level < 3`. The helper owns the *contract*; callers own the *policy* per level.
- `PromptService.buildHealPrompt` interprets the level: L0 scales anchors and caps tasks; L1 drops tasks; L2 drops events; L3 truncates candidate bodies and emits `degraded` records.
- `MaintenanceService.doRunHeal` gains a `degraded` array on its result and converts `skipped` to a typed record array, mutually exclusive on `id` with `degraded`.
- The unbounded `allTasks` input is bounded at L0 via a new `HEAL_MAX_TASKS = 50` constant.
- Test coverage for the ladder, the level interpretation, and the reconciliation property on both the data shape and the log stream.

### Out of scope
- **Direction 3 from #101** (deriving `maxPromptChars` from remaining output budget). The decision against this is recorded in the issue thread — coupling input and output sizes is speculative generality for an unproven benefit.
- **Parse-error handling at `batch.length > 1`.** Pre-existing behavior (a parse error splits the batch, which cannot help a JSON desync but doesn't make it worse). Expanding the fix's blast radius to cover it would conflate two distinct bugs (#92's parse desync and this truncation ladder) in one PR. Flagged in [Future work](#future-work).
- **Lambda budget / pass-timeout handling.** The transaction that includes `markHealChecked` still aborts on timeout and skips stamping. The ladder's worst case is 4 calls per fact (L0, L1, L2, L3), all at `batch.length === 1`, which fits comfortably under any reasonable per-fact budget; the *pass* budget is a separate concern.
- **Other `runBatched` callers** (`doRunOntologyBackfill` is the only other). The ladder is dormant for them — they pass `attemptLevel: 0` and behave identically. Adding a ladder to ontology backfill is not warranted by the current evidence.

## Design

### Layer 1 — `BoundedLlmCall.ts` (the generic helper)

The helper owns the *convergence contract* and nothing else. It tracks an `attemptLevel: 0|1|2|3` and advances it on a specific error shape. It does not know what the levels mean.

**`RunBatchedArgs.buildPrompt` signature change.** Gains an optional second parameter:

```ts
buildPrompt: (
  batch: TItem[],
  attemptLevel?: 0 | 1 | 2 | 3,  // defaults to 0 when called by trim()
) => BuiltPrompt | Promise<BuiltPrompt>;
```

`trim()`'s speculative binary search passes no level (defaults to 0). The actual `attempt()` invocation passes the current level explicitly.

**`RunBatchedOutcome.skipped` shape change.**

```ts
// before
skipped: TItem[];

// after
skipped: Array<{ item: TItem; reason: 'non_convergent' }>;
```

The terminal give-up case is the only path into `skipped`. Same length semantics; shape change is type-level.

**The `attempt` / `onFailure` / level advance:**

```ts
const attempt = async (
  batch: TItem[],
  prebuilt?: BuiltPrompt,
  attemptLevel: 0 | 1 | 2 | 3 = 0,
): Promise<void> => {
  if (batch.length === 0) return;
  const prompts = prebuilt ?? (await buildPrompt(batch, attemptLevel));
  batches++;
  let responseText: string;
  try {
    responseText = await call(prompts);
  } catch (err) {
    if (!isTruncationError(err)) throw err;
    await onFailure(batch, err, attemptLevel);
    return;
  }
  let result: TResult;
  try {
    result = parse(responseText, batch);
  } catch (err) {
    // The parse catch reaches onFailure unconditionally; the gate inside
    // onFailure decides whether the error is ladder-escalable.
    await onFailure(batch, err, attemptLevel);
    return;
  }
  results.push(result);
};

const onFailure = async (
  batch: TItem[],
  err: unknown,
  attemptLevel: 0 | 1 | 2 | 3,
  fromCall: boolean,  // true → error came from `call()`; false → from `parse()`. See note below.
): Promise<void> => {
  if (batch.length === 1) {
    if (isTruncationError(err) && attemptLevel < 3) {
      // Bypass trim: its prebuilt prompt is the L0 form, invalid at the new level.
      await attempt(batch, undefined, (attemptLevel + 1) as 0 | 1 | 2 | 3);
    } else {
      skipped.push({ item: batch[0], reason: 'non_convergent' });
      onSkip?.(batch[0], err);
    }
    return;
  }
  // batch.length > 1: non-truncation call errors (network, auth) must propagate
  // rather than silently absorb into a pile of skipped items — that's the #67
  // contract this helper is built around. Parse errors split, the same way
  // they've always split, because the JSON may parse after shedding context.
  if (fromCall && !isTruncationError(err)) throw err;
  // batch.length > 1: split path, unchanged. Sticky-down batchSize adaptation
  // and the inner trim/attempt loop at level 0 are preserved.
  ...
};
```

The top-level loop is unchanged in shape — it calls `attempt(batch, prompts, 0)` after `trim` returns the right prefix and the L0 prompt.

**Why the gate is on `isTruncationError(err) && batch.length === 1 && attemptLevel < 3` and nothing else.** Three failure shapes reach `onFailure` at `batch.length === 1`:

| Cause | `isTruncationError(err)` | Action | Level mutation |
|---|---|---|---|
| Provider truncated L0 response | `true` | escalate to L1 | +1 |
| Provider truncated L1 response | `true` | escalate to L2 | +1 |
| Provider truncated L2 response | `true` | escalate to L3 | +1 |
| Provider truncated L3 response | `true` | skip, `non_convergent` | none |
| Parse error (any level) | `false` | skip, `non_convergent` | none |
| `EXCEEDS_LIMIT_PATTERN` config error | `false` | skip, `non_convergent` | none |
| Network / auth failure | `false` | skip, `non_convergent` | none |

A parse error at `batch.length === 1` does not advance the level. The same prompt — same truncation — would produce the same parse error at L1, L2, and L3: shedding context does not fix a JSON desync (#92's bug shape). Advancing the level would burn three calls before giving up. The gate prevents that.

**Pre-existing behavior preserved at `batch.length > 1`:** a parse error still splits the batch. This is wasteful (splitting cannot help a parse desync) but is unchanged from #67's release and is not in scope for this fix. The split-vs-propagate decision at `batch.length > 1` is what the `fromCall` flag discriminates: parse errors split (the JSON may parse after shedding context), non-truncation call errors (network, auth, EXCEEDS_LIMIT) propagate. See [Future work](#future-work).

**`MAX_BATCH_ATTEMPT_LEVEL` is *not* exported.** The cap is a `runBatched` internal; the closed literal `0|1|2|3` union is the contract. No caller does arithmetic against the cap, so a runtime constant would be a second source of truth that can drift from the type.

### Layer 2 — `PromptService.buildHealPrompt` (the policy owner)

`buildHealPrompt` gains two parameters and returns a structured result:

```ts
buildHealPrompt(
  healCandidates: unknown[],
  documentAnchors: unknown[],
  allTasks: unknown[],
  recentEvents: unknown[],
  runtimeOverride: string | undefined,
  attemptLevel: 0 | 1 | 2 | 3,         // new
  bodyTruncationChars: number = HEAL_MAX_FACT_BODY_CHARS_L3,  // new, default 4000
): { prompts: BuiltPrompt; degraded: DegradedRecord[] };
```

`DegradedRecord = { id: string; originalBodyChars: number; truncatedBodyChars: number }`.

**Ladder semantics:**

| Level | Anchors | Tasks | Events | Candidate bodies |
|---|---|---|---|---|
| 0 | `min(50, batch.length * 4)` | capped at `HEAL_MAX_TASKS = 50` | all (≤20) | full |
| 1 | scaled as L0 | dropped | all (≤20) | full |
| 2 | scaled as L0 | dropped | dropped | full |
| 3 | scaled as L0 | dropped | dropped | truncated to `bodyTruncationChars` |

A new constant `HEAL_ANCHORS_PER_CANDIDATE = 4` makes the implicit 50/25 ratio explicit and replaces the existing `HEAL_MAX_ANCHORS = 50` cap formula. The L0 anchor count is:

```ts
const anchorCount = Math.max(1, Math.min(HEAL_MAX_ANCHORS, batch.length * HEAL_ANCHORS_PER_CANDIDATE));
```

`_selectHealAnchors` is unchanged — its cache is keyed by the query string, level-independent. The level-aware re-cap happens at the prompt-build boundary.

**Why a constant `HEAL_MAX_TASKS` cap rather than proportional scaling.** Tasks are entity-global, not batch-local. "Fewer candidates ⇒ fewer tasks" would be semantically odd (a 1-candidate call wouldn't benefit from fewer tasks any more than a 10-candidate call). A constant ceiling — `HEAL_MAX_TASKS = 50` — bounds the one remaining unbounded input to the heal prompt. At ~200 chars per task, 50 tasks use ~10k chars of the 40k budget, leaving room for anchors, events, and candidate bodies. L1 still drops tasks entirely; the cap just stops L0 from being the *first* point at which tasks are bounded at all. This was the highest-value single line in the change.

**Body truncation at L3** applies to each `healCandidates[i].body` independently. A fact with `body.length <= bodyTruncationChars` passes through unchanged and produces no `DegradedRecord`. A fact with `body.length > bodyTruncationChars` is sliced to the first `bodyTruncationChars` characters with a trailing marker:

```
…[truncated at 4000 chars, original was 12345]
```

The marker's `original was N` clause is what the post-reconciliation log line references — an operator scanning the log sees the truncation magnitude without re-querying the fact.

### Layer 2 — `MaintenanceService.doRunHeal` (the orchestration boundary)

Three new constants:

```ts
export const HEAL_MAX_FACT_BODY_CHARS_L3 = 4_000;
export const HEAL_MAX_TASKS = 50;
export const HEAL_ANCHORS_PER_CANDIDATE = 4;
```

`doRunHeal`'s options bag gains a third field:

```ts
options?: {
  promptOverride?: string;
  batchSize?: number;
  bodyTruncationChars?: number;  // new, defaults to HEAL_MAX_FACT_BODY_CHARS_L3
};
```

The `allTasks` fetch becomes bounded at the repository call:

```ts
// before
const allTasks = await this.taskRepo.findAllPending([entityId]);

// after
const allTasks = await this.taskRepo.findAllPending([entityId], HEAL_MAX_TASKS);
```

`findAllPending` already accepts the `limit` parameter; this is the only call site that wasn't using it. The cap is applied once at fetch time, not per-build, so subsequent builds at L1/L2 (which omit the array) don't re-query the database.

`buildPrompt` becomes:

```ts
buildPrompt: async (batch, attemptLevel = 0) => {
  const documentAnchors = await this._selectHealAnchors(entityId, batch, anchorCache);
  const { prompts, degraded: batchDegraded } =
    await this.promptService.buildHealPrompt(
      batch.map(toPromptShape),
      documentAnchors,
      allTasks,           // unused at L>=1 — buildHealPrompt omits it
      recentEvents,       // unused at L>=2 — buildHealPrompt omits it
      promptOverride,
      attemptLevel,
      bodyTruncationChars,
    );
  degraded.push(...batchDegraded);  // captured from the doRunHeal scope
  return prompts;
},
```

`toPromptShape` stays level-unaware. It strips embedding fields and parses tags; it does not look at `body.length`. The body-truncation decision is `buildHealPrompt`'s alone.

**The reconcile-then-log fix.** `buildPrompt` runs before `call()` and `parse()`, so the `degraded` array is populated when a L3 prompt is *built*, not when the corresponding attempt *succeeds*. A fact whose L3 build produced a `degraded` record can still end up in `outcome.skipped` (the L3 call truncates again, or parses as garbage). The two arrays must be mutually exclusive on `id`, so we reconcile after `runBatched` returns:

```ts
const outcome = await runBatched<WikiFact, HealBatch>({ /* ... */ });

// Reconcile: a degraded record for an id in outcome.skipped is a contradiction
// (degraded = healed, skipped = dropped). Drop the contradiction.
const skippedIds = new Set(outcome.skipped.map(({ item }) => item.id));
const healedDegraded = degraded.filter(d => !skippedIds.has(d.id));

// Log: a property of the log stream, not just the data shape.
for (const d of healedDegraded) {
  console.warn(
    `[WikiMemory] heal healed under degraded context ${entityId}/${d.id}: ` +
    `body truncated from ${d.originalBodyChars} to ${d.truncatedBodyChars} chars`,
  );
}
```

The log line fires *only* for facts that were actually healed at L3. A fact that was attempted at L3 and still failed does not produce a "healed under degraded context" warning — it produces the ordinary skip warning instead. This is the property that locks the fix in tests: a naive implementation that logged inside the `buildPrompt` lambda would emit the warning regardless of whether the L3 attempt succeeded.

`HealResult` is composed with the filtered set:

```ts
return {
  scanned: outcome.skipped.length + sum(batchResult.batch.length for batchResult in outcome.results),
  downgraded: allDowngraded.size,
  deleted: allDeleted.size,
  newFactsCreated: insertedFacts.length,
  skipped: outcome.skipped.map(({ item, reason }) => ({ id: item.id, reason })),
  degraded: healedDegraded,
  remaining: counts.eligible,
  deferred: counts.deferred,
};
```

**`scanned` semantics preserved.** The formula `outcome.skipped.length + Σ batchResult.batch.length` works on both the old `TItem[]` shape and the new `Array<{item, reason}>` shape (both have `.length`). Provider exposure is unchanged in meaning.

### Data flow

```
doRunHeal(e, options)
├── candidates = entryRepo.findHealCandidatesByEntityId(e, HEAL_BATCH_SIZE, recheckCutoff)
├── allTasks   = taskRepo.findAllPending([e], HEAL_MAX_TASKS)        // bounded at fetch
├── recentEvents = eventRepo.getRecent(e, 20)
├── anchorCache = new Map()
├── degraded = []                                                       // closure target
│
├── runBatched({
│     items: candidates,
│     buildPrompt(batch, level=0):
│       anchors = _selectHealAnchors(e, batch, anchorCache)
│       { prompts, degraded: batchDegraded } =
│         buildHealPrompt(batch.map(toPromptShape), anchors, allTasks,
│                         recentEvents, promptOverride, level, bodyTruncationChars)
│       degraded.push(...batchDegraded)         // safe — L0 calls (incl. trim probes) return []
│       return prompts
│     call, parse, maxOutputTokens, maxPromptChars, onSkip
│   })
│
├── skippedIds = new Set(outcome.skipped.map(({ item }) => item.id))
├── healedDegraded = degraded.filter(d => !skippedIds.has(d.id))       // reconcile
│
├── for d in healedDegraded:
│     console.warn(`[WikiMemory] heal healed under degraded context ...`)  // post-reconcile log
│
└── return { scanned, downgraded, deleted, newFactsCreated,
            skipped: outcome.skipped.map(...), degraded: healedDegraded,
            remaining, deferred }
```

`runBatched`'s internal flow at `batch.length === 1`:

```
attempt(batch, prebuilt?, level=0):
  prompts = prebuilt ?? buildPrompt(batch, level)
  try call(prompts)           → on truncation:  onFailure(batch, err, level)
  try parse(response, batch)  → on err:          onFailure(batch, err, level)
  push result

onFailure(batch, err, level):
  if batch.length === 1:
    if isTruncationError(err) && level < 3:
      attempt(batch, undefined, level+1)    // bypass trim; rebuild at new level
    else:
      skipped.push({ item: batch[0], reason: 'non_convergent' })
      onSkip?.(batch[0], err)
    return
  // batch.length > 1: split, unchanged
```

The four call sites of `buildPrompt` in `runBatched`:

1. `trim`'s speculatives — always `level 0`, never truncate bodies, push nothing to `degraded`.
2. `attempt` from the top-level loop — `level 0`, never pushes (an L3 escalation already skip-marked the fact).
3. `attempt` from a recursive level advance — `level 1`, `2`, or `3`. May push on success.
4. `attempt` from the split path — `level 0`. Splits don't escalate.

`degraded` records are only ever produced by case 3's `buildHealPrompt` at `level 3`. The reconciliation step filters out any record that didn't survive to a successful `outcome.results` push.

## Error handling

**`onFailure` gate, restated precisely:**

```ts
isTruncationError(err) && batch.length === 1 && level < 3
                ↓
      attempt(batch, undefined, level + 1)
```

Anything else at `batch.length === 1` skips with `reason: 'non_convergent'` and does not touch `level`. The `formatSkipError(err)` helper (already hardened against hostile Proxy `getPrototypeOf` traps per #96) produces the existing warning log.

**Failure modes that no longer exist:**
- Soft timeout via unbounded recursive escalation. The `level < 3` cap means the worst case is 4 calls (L0, L1, L2, L3) for a single fact, all at `batch.length === 1`. With a 16384-token output ceiling and 4000-char body cap, the L3 call has a bounded response.
- Degraded records spuriously emitted by `trim` probes. `trim` only calls `buildPrompt` at `level 0`; L0 returns `degraded: []`.
- Anchor cache poisoning across levels. `anchorCache` is keyed by query string, level-independent. Same query returns same anchors regardless of level — correct, because anchors are not level-dependent.

**Failure modes that still exist (out of scope):**
- Parse desync at `batch.length > 1` still splits (pre-existing, not introduced by this change).
- L3 truncating a body mid-token could produce a fact the model mis-reasons about. The `degraded` array makes the truncation visible; correcting the resulting heal is a separate concern.
- `initialBatchSize` falls back to `DEFAULT_BATCH_SIZE = 10` when the provider omits `maxOutputTokens`. The L0 anchor scaling and `HEAL_MAX_TASKS` cap mitigate the consequence; the fallback itself is unchanged.

## Testing

All tests live in `packages/core/__tests__/`, mirroring #67's layout. The synthetic `call` is extended with a per-level failure schedule.

### `BoundedLlmCall.test.ts` — append `describe('attempt level ladder', ...)`

| # | Scenario | Expected |
|---|---|---|
| 1 | L0 success | `skipped: []`, `batches: 1`, no escalation |
| 2 | L0 truncates, L1 success | `skipped: []`, `batches: 2`; L1 prompt is a fresh build (asserted via call arg inspection) |
| 3 | L0 truncates, L1 truncates, L2 success | `skipped: []`, `batches: 3` |
| 4 | L0–L2 all truncate, L3 success | `skipped: []`, `batches: 4`; the 4th call is the L3 attempt and bypasses `trim` |
| 5 | L0–L3 all truncate | `skipped: [{item: onlyItem, reason: 'non_convergent'}]`, `batches: 4` |
| 6 | Parse error at L0, `batch.length === 1` | `skipped: [{reason: 'non_convergent'}]`, `batches: 1`, `attemptLevel` stays 0 |
| 7 | `EXCEEDS_LIMIT` error at L0, `batch.length === 1` | `skipped: [{reason: 'non_convergent'}]`, no level advance |
| 8 | Network-shaped error at L0, `batch.length === 1` | `skipped: [{reason: 'non_convergent'}]`, no level advance |
| 9 | Parse error at `batch.length > 1` (regression lock for #67 behavior) | batch splits; final outcome has the fact either in results or in skipped |

The synthetic `call` in these tests records the level at which each call was made, so test 2 can assert that the L1 call received a *different* prompt (the L1 form, not the L0 prebuilt from `trim`).

### `PromptService.test.ts` — new file

| # | Scenario | Expected |
|---|---|---|
| 1 | L0 | `degraded: []`; anchor count = `min(50, batch.length * 4)`; `allTasks` and `recentEvents` present in `userPrompt` |
| 2 | L1 | `degraded: []`; `allTasks` absent; `recentEvents` present; anchor scaling unchanged |
| 3 | L2 | `degraded: []`; `allTasks` absent; `recentEvents` absent |
| 4 | L3 with `body.length > 4000` | `degraded: [{id, originalBodyChars, truncatedBodyChars: 4000}]`; body ends with `…[truncated at 4000 chars, original was N]` marker |
| 5 | L3 with `body.length <= 4000` | `degraded: []`; body passes through unchanged |
| 6 | L3 with `bodyTruncationChars: 500` | bodies truncated to 500 chars; `degraded` records carry `truncatedBodyChars: 500` |
| 7 | L0 with `bodyTruncationChars: 500` (override ignored) | bodies full; `degraded: []` |

### `healBounding.test.ts` — append cases

| # | Scenario | Expected |
|---|---|---|
| 1 | Happy path at L0 | `HealResult.degraded: []`, `HealResult.skipped: []`; warn spy never called with the degraded-context message |
| 2 | Single fact overflows at L0, converges at L3 | `HealResult.degraded: [{id, originalBodyChars, truncatedBodyChars}]`, `HealResult.skipped: []`; warn spy called **exactly once** with the degraded-context message carrying the truncated fact's id; the fact's downgraded/deleted/newFacts were applied by post-processing (L3 heal was not just synthesized but acted on) |
| 3 | Single fact fails at L0–L3 | `HealResult.skipped: [{id, reason: 'non_convergent'}]`, `HealResult.degraded: []`; warn spy never called with the degraded-context message; ordinary skip warning fired |
| 4 | Mixed: 1 heals at L0, 1 heals at L3, 1 skips at L3 | Three buckets mutually exclusive on `id`; `results-ids ∪ skipped-ids === candidate-ids` (exhaustive partition — a double-push would silently corrupt `scanned`) |
| 5 | Reconciliation regression lock | A fact whose L3 `buildHealPrompt` produced a `degraded` record but whose subsequent `call` failed is in `skipped` and **not** in `degraded` |

Test 2 is the regression lock for #101. It fails on the current code (where L3 escalation does not exist) and passes after this spec.

## API surface

| File | Change |
|---|---|
| `packages/core/src/services/BoundedLlmCall.ts` | `buildPrompt` gains `attemptLevel?` parameter. `RunBatchedOutcome.skipped` shape change: `TItem[]` → `Array<{item, reason: 'non_convergent'}>`. `attempt` and `onFailure` gain a level parameter and the gate logic. |
| `packages/core/src/services/PromptService.ts` | `buildHealPrompt` gains `attemptLevel` and `bodyTruncationChars?` parameters. Return type changes from `BuiltPrompt` to `{ prompts: BuiltPrompt; degraded: DegradedRecord[] }`. |
| `packages/core/src/services/MaintenanceService.ts` | Three new exports: `HEAL_MAX_FACT_BODY_CHARS_L3 = 4_000`, `HEAL_MAX_TASKS = 50`, `HEAL_ANCHORS_PER_CANDIDATE = 4`. `doRunHeal` options bag gains `bodyTruncationChars?`. `allTasks` fetch is bounded via `findAllPending(..., HEAL_MAX_TASKS)`. `buildPrompt` closure destructures `degraded` and pushes to a doRunHeal-scoped array. Post-`runBatched` reconciliation. Post-reconcile log line. |
| `packages/core/src/types.ts` | `HealResult.skipped: number` → `Array<{id, reason: 'non_convergent'}>`. `HealResult.degraded: Array<{id, originalBodyChars, truncatedBodyChars}>` (new). |

## Files touched

- `packages/core/src/services/BoundedLlmCall.ts` — modified (ladder primitive)
- `packages/core/src/services/PromptService.ts` — modified (level interpreter, return type)
- `packages/core/src/services/MaintenanceService.ts` — modified (orchestration, constants, options bag, post-reconcile log)
- `packages/core/src/types.ts` — modified (`HealResult` shape)
- `packages/core/src/index.ts` — barrel update if `HEAL_MAX_FACT_BODY_CHARS_L3` / `HEAL_MAX_TASKS` / `HEAL_ANCHORS_PER_CANDIDATE` are exported from the package surface
- `packages/core/__tests__/BoundedLlmCall.test.ts` — extended (ladder block, 9 cases)
- `packages/core/__tests__/PromptService.test.ts` — new file (7 cases)
- `packages/core/__tests__/healBounding.test.ts` — extended (5 cases including #101 regression lock)
- `CHANGELOG.md` — auto-generated by semantic-release; the implementation commit's `BREAKING CHANGE:` footer surfaces the `HealResult.skipped` type change in the changelog (see [Backwards compatibility and versioning](#backwards-compatibility-and-versioning))

## Backwards compatibility and versioning

`HealResult.skipped: number` → `HealResult.skipped: Array<{id, reason: 'non_convergent'}>` is a TypeScript type-level breaking change. External consumers reading this field as a number (tests, monitoring) need a one-line update. The field's name and meaning are unchanged.

`RunBatchedOutcome.skipped: TItem[]` → `Array<{item, reason: 'non_convergent'}>` is internal — only `MaintenanceService` and `doRunOntologyBackfill` read this field, and both are updated in this spec.

`buildPrompt`'s second parameter is optional with default `0`. The ontology backfill caller (the only other `runBatched` consumer) compiles and behaves identically without source changes.

Target release: **6.0.0**. `HealResult.skipped: number → Array<{id, reason: 'non_convergent'}>` is a genuine type-level break for downstream consumers — `aws-cloud-agent`'s own `package.json` pins `^5.4.0` and would silently pull a 5.x with a `tsc` failure on the next update. The implementation PR's commit message must signal the break correctly so semantic-release bumps to a major and downstream tooling (Renovate, changesets, automated upgrade PRs, anyone reading the `BREAKING CHANGE:` footer) sees the type change announced rather than hidden. The implementation commit must use either `feat!:` syntax or a `BREAKING CHANGE:` footer (or both); the spec does not impose a choice between the two. Suppressing the marker to land on a smaller version number would be manipulating the signal, not avoiding a break — the break still ships, just unannounced.

## Verification

1. `pnpm --filter core test BoundedLlmCall` — ladder block (9 cases) passes.
2. `pnpm --filter core test PromptService` — level interpretation (7 cases) passes.
3. `pnpm --filter core test healBounding` — orchestration (5 cases, including #101 regression lock) passes.
4. `pnpm --filter core test` — full suite passes; no regressions in `doRunOntologyBackfill` or any other `runBatched` consumer.
5. `pnpm --filter core typecheck` — TypeScript build succeeds.
6. Manual smoke: run `doRunHeal` against a synthetic fact set including one fact whose body is 10k chars (forces L3 truncation) and one fact whose body is 200 chars (L0 success). Inspect the `HealResult`:
   - The 200-char fact is in `degraded: []` and not in `skipped: []`.
   - The 10k-char fact is in `degraded: [{id, originalBodyChars: 10000, truncatedBodyChars: 4000}]` and not in `skipped: []`.
   - Console output contains exactly one `heal healed under degraded context` warning for the 10k-char fact's id, and no skip warning for it.

## Future work

- **Parse-error handling at `batch.length > 1`.** Today, a parse error at `batch.length > 1` causes the batch to split — which cannot help a JSON desync but doesn't make it worse. A dedicated fix for #92's parse-desync shape would belong in `parse` itself (or as a separate path inside `runBatched` that distinguishes parse failures from truncation). Out of scope here because conflating it with this fix would obscure which bug the change addresses.
- **Per-pass budget awareness.** The 900s Lambda timeout that triggers the re-failure pattern in #101 is orthogonal to this fix. A pass-level budget tracker that aborts early when remaining wall-clock is below a threshold would close that loop. Separate concern.
- **Output-token-derived prompt budget (direction 3 from #101).** Coupling input and output sizes is speculative generality for an unproven benefit. Not pursued.
- **Ladder for ontology backfill.** Ontology backfill's `buildPrompt` signature is unaffected (it passes `level = 0` everywhere). If a future bug shows ontology backfill suffering the same shared-context non-convergence, the same primitive is available without helper changes.

## Risk analysis

**Risk: L3 truncation produces a mis-reasoned heal.** A fact whose body is truncated to 4000 chars is healed by a model that didn't see the full body. The heal may downgrade a fact that should have been deleted, or vice versa. Mitigation: the `degraded` array carries `originalBodyChars` so the operator can identify candidates for re-inspection. The cost of an L3 heal that goes wrong is bounded — it affects one fact per `degraded` record, and the fact is healed (it was already broken in some sense), not deleted silently.

**Risk: a fact that should be deleted is healed at L3 with a partial view.** Same risk class, same mitigation. The alternative isn't "the model reasons over the full fact" — it's "the fact is silently dropped and never healed at all" (today's behavior). Degraded-but-present beats absent.

**Risk: type-break in `HealResult.skipped` breaks external consumers.** Mitigated by the conventional-commits `BREAKING CHANGE:` marker (or `feat!:` syntax) surfacing it in the CHANGELOG and forcing a major version bump to 6.0.0, so consumers cannot pull the change via a routine `^5.x` update. Consumers iterating or counting the new shape will need a one-line update. The honesty of the marker is the entire mitigation; suppressing it would re-introduce the silent-break scenario the spec was written to avoid.

**Risk: `findAllPending([entityId], HEAL_MAX_TASKS)` changes the rows returned for any other call site.** No — `findAllPending` is called with `[entityId]` here and the `limit` parameter is the *second* positional argument. Other call sites pass their own entity lists and limits; the cap is local to this call.

**Risk: `anchorCache` memory grows unbounded across a pass.** Pre-existing — the cache is `doRunHeal`-scoped and cleared when the pass ends. The L0 anchor scaling changes the queries (a 1-candidate prefix has a different query string than a 5-candidate prefix), so the cache may hold slightly more entries than before. Bounded by `HEAL_BATCH_SIZE = 25` per pass.

**Risk: subtle behavior change for callers that rely on `attemptLevel` being undefined.** None — the only existing caller (`doRunOntologyBackfill`) does not interact with `buildPrompt`'s second parameter. The TypeScript optional-parameter default (`= 0`) means existing positional usage is preserved if any test or consumer calls `buildPrompt` directly.
