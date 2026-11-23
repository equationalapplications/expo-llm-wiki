# Meter reservation: reserve budget before each metered call

**Status:** Implemented (2026-11-23, PR #479)
**Date:** 2026-11-23
**Intent check:** Rule 7 ("Every model call in a maintenance run draws from
one token budget the host can set"): this spec makes that sentence true when
the host also raises `chunkConcurrency`. Today parallel calls all pass the
same pre-flight and the budget is overrun by whole calls (Problem). Rule 6
(honest reporting): `tokensUsed`, `estimated`, `remaining`, `stoppedReason`
and `llm_usage` keep reporting what really happened; no new diagnostic code,
no new field. The one reporting wrinkle this spec introduces (a conservative
early stop at concurrency above 1) is disclosed and put to Kurt (Open
question 2). Rule 1 (no new host surface: the meter is internal, §7). Rule 10
(this spec; the type-on-write §3 note and the guide sentence step 13 added
are corrected in the PR that ships the fix). Rule 11 (no accuracy or cost
claim: the spec bounds overshoot by construction and says plainly that the
budget stays a pre-flight on the input estimate, not a hard ceiling on
provider output; the 2.2x figure below is an issue probe, not a benchmark).
Rules 2 and 3 are untouched (no schema change; the meter is per run, with no
cross-entity state). No rule is contradicted, so INTENT.md needs no
amendment.

Base: `origin/main` @ `9d25b15c` (includes step 13, PR #471). Every
`file:line` pin below was read live against that commit in the worktree
`expo-llm-wiki-i475`. All paths are under `packages/core/src/` unless noted.
Issue: [#475](https://github.com/equationalapplications/expo-llm-wiki/issues/475).
Semver: `fix(core)`, patch (§9).

## Problem

The `UsageMeter` is consulted before a model call (`fits`) and charged after
it returns (`record`). Nothing is held in between. With `chunkConcurrency: N`
the engine launches N classify calls at once; every one of them passes
`fits` against the same `remaining`, because no call has recorded yet. The
budget a host sets as a ceiling is exceeded by up to N-1 whole calls
(`remaining` clamps at 0 afterwards, so the overrun shows only in
`tokensUsed`).

The issue's probe (budget 250, 110 tokens per call): concurrency 1 spent 220
(2 calls); concurrency 4 spent 550 (5 calls), 2.2x the budget. A standalone
model of the same arithmetic (input estimate 60, provider-reported usage 60 in
plus 50 out, 12 facts, calls settle after one tick; scratch, not committed)
reproduces both numbers exactly: the old meter at concurrency 1 gives 2 calls
and 220; at concurrency 4 it gives 5 calls and 550. The same model is used
below to size the fix.

The overspend is not hidden (it appears in `tokensUsed`), but a host that
treats `tokenBudget` as an allowance (a metered API key, a phone user's
battery and data plan) is charged more than it declared. That is the failure
rule 7 exists to prevent, and it is reachable by one config line.

## Root cause (with evidence)

### The class

`UsageMeter` (`utils/usage.ts:18-42`) has three members that matter:

- `remaining` (`:30-32`): `max(0, budget - used)`, `Infinity` when unbounded.
- `fits(estimate)` (`:34-36`): `estimate <= remaining`.
- `record(r)` (`:38-41`): `used += input + output`; sets `estimated`.

`WikiBudgetExhausted(requiredEstimate, remaining)` (`:49-60`) is the internal
control-flow error; its header comment says it "never reaches a host".

### Every fits / record call site

There are exactly two `record` sites and three `fits` sites in the repo (grep
over `packages/*/src`, tests excluded). No other workspace package imports the
meter.

| Site | `fits` | `record` | Note |
|---|---|---|---|
| `callLlm` (generative) | `utils/llmCall.ts:36-38` | `:58` | the one generative choke point |
| `callClassify` | `utils/llmCall.ts:86-88` | `:101` | the one classify choke point |
| `selectBatch` reserve estimate | `services/librarian/ops/extract.ts:82` (`meter.fits(2 x prompt estimate)`, `RESOLVE_RESERVE_FACTOR` at `:17`) | none | ops librarian planning check, before any call of the pass |

Callers of `callLlm` (all pass `ctx.meter` unless noted):

| Caller | Line | Concurrency today |
|---|---|---|
| legacy librarian extract | `services/librarian/legacy.ts:74-78` | sequential (one call per pass) |
| ops extract `extractOnce` | `ops/extract.ts:272` | sequential; overflow halving is `await a; await b` (`:213-218`) |
| ops extract overflow probe | `ops/extract.ts:207` | sequential, once per pass |
| ops resolve generative | `ops/resolve.ts:193` via `runBatched` (`:179`) | sequential |
| heal | `services/MaintenanceService.ts:1878` via `runBatched` (`:1849`) | sequential |
| ontology backfill generative | `MaintenanceService.ts:2496` via `runBatched` (`:2493`) | sequential |
| ingest | `services/IngestionService.ts:217` | **concurrent** (`withConcurrency`, `:201`; limit from `chunkConcurrency`, `:137-138`) but passes **no meter**: unmetered |

`runBatched` (`services/BoundedLlmCall.ts:238`) runs one `await`ed `attempt`
at a time; its halve-and-retry loop is `while (...) { await trim; await attempt }`
(`:363`). It owns no meter and only catches `WikiBudgetExhausted` (`:395`) to
make a `budgetStop`. It is **not** a concurrency source.

Callers of `callClassify`:

| Caller | Line | Concurrency today |
|---|---|---|
| write-time typing, `classifyFactsForWrite` | `services/typing/typeOnWrite.ts:127-136` (`withConcurrency`; limit `:124-125`); reached from ops `ops/index.ts:108-125` and legacy `legacy.ts:119-126` | **concurrent** |
| classifier ontology backfill, `_runClassifierBackfill` | `MaintenanceService.ts:2740-2747` (`withConcurrency`; limit `:2653-2654`); entered from `:2307` | **concurrent** |
| ops resolve screen (`systemOne.resolve: 'auto'`) | `ops/resolve.ts:155-158`, driven by `screenResolveCandidates` (`:48-96`) | sequential (`for` plus `await`) |

Meter ownership (who can share one meter across in-flight calls):

- The scheduler builds one meter per `run()` (`MaintenanceScheduler.ts:117`),
  walks entities and jobs one unit at a time (`:160-163`; units `await`ed at
  `:173`, `:207`, `:278`), and reads it once at the end (`tokensUsed:
  meter.used` `:315`, `remaining` `:317`). No two units overlap, so
  cross-entity sharing is not a concurrency source.
- Public `runOntologyBackfill` builds its own meter (`MaintenanceService.ts:1064`).
- Manual `runLibrarian`/`runHeal` and the `'auto'` write trigger
  (`WriteService.ts:217-219`) pass no meter: unmetered, nothing to reserve.
- Concurrent `runPendingMaintenance` calls each build their own meter; their
  budgets are independent, as the host declared them.

### Which can overspend today, and under which config

Only the two classify fan-outs can have more than one call in flight on one
shared meter. Both need all of:

1. `chunkConcurrency` above 1 (default 1, `types.ts:395`);
2. a bounded meter: `runPendingMaintenance({ tokenBudget })` or
   `runOntologyBackfill(id, { tokenBudget })` (`types.ts:1871`,
   `MaintenanceService.ts:1064`);
3. a provider with `classify` and the site engaged: write-time typing needs
   `systemOne.typeOnWrite: 'auto'` (type-on-write spec §2); the backfill
   needs the typing chain to resolve `'auto'` (`MaintenanceService.ts:2290`,
   engaged at `:2301`).

The issue's remark that "generative calls should be checked for the same
pattern" is answered by the first two tables: no generative call runs in
parallel on a meter, and ingest is parallel but unmetered. The generative
path has the same check-then-charge shape, so it is latent: a future parallel
metered generative caller would overspend identically. The fix covers it at
the same choke point at no extra cost (§3).

### Pre-existing and out of scope: single-call overshoot

Even at concurrency 1 the budget is not a hard ceiling. The pre-flight tests
the input estimate; the meter is later charged real input plus output
(`llmCall.ts:36` against `:55-58`). A call that fits on its estimate can end
past the budget by its own output. The 2026-07-13 backfill spec already says
so ("Overshoot honesty",
`docs/superpowers/specs/2026-07-13-ontology-backfill-spec.md:438-441`). This
spec does not change that (Open question 4). It removes the **multiplication**
of that overshoot by the number of in-flight calls.

### Why the issue's literal fix is not enough

The issue proposes: reserve the **input estimate** before awaiting, settle to
actual after. Modeled on the probe (same standalone model):

| Scheme | concurrency 1 | concurrency 4 |
|---|---|---|
| today (check, then charge) | 2 calls / 220 | 5 calls / 550 |
| reserve input estimate only (hold 60) | 2 calls / 220 | 4 calls / 440 |
| admit on 60, hold 120 (2x) | 2 calls / 220 | 2 calls / 220 |

Holding only the input estimate lets all four calls in (4 x 60 = 240 <= 250)
and cuts the overrun from 550 to 440, still 1.76x the budget, because the
output (50 of every 110 tokens) is not held. For a concurrent run to spend
what a sequential run does, the **hold** must include an output allowance.
The proposal below keeps *admission* (what the call is tested against) apart
from *hold* (what later calls see), so the default path's decisions are
untouched.

## Proposed change

### 1. Reservation API on `UsageMeter` (internal)

```ts
export interface UsageReservation { readonly _brand: 'UsageReservation' } // opaque

class UsageMeter {
  readonly budget: number | undefined;
  used = 0;
  estimated = false;
  /** Tokens held by in-flight reservations (read-only to callers). */
  get reserved(): number;
  /** budget - used - reserved, clamped at 0; Infinity when unbounded. */
  get remaining(): number;
  fits(estimate: number): boolean;                              // estimate <= remaining
  record(r: UsageRecord): void;                                 // unchanged: direct charge
  reserve(estimate: number, hold?: number): UsageReservation;   // throws WikiBudgetExhausted
  settle(handle: UsageReservation, actual: UsageRecord): void;  // free the hold, then record(actual)
  release(handle: UsageReservation): void;                      // free the hold, charge nothing
}
```

- **Admission** is `fits(estimate)`: `estimate <= remaining`, where `remaining`
  now subtracts `reserved`. A failing `reserve` throws
  `new WikiBudgetExhausted(estimate, this.remaining)`: same class, same two
  fields, same message as the inline throws at `llmCall.ts:37` and `:87`. The
  throw moves into the meter; the call sites lose their `if (!fits) throw`.
- **Hold**: on admission the meter adds `max(estimate, hold ?? estimate)` to
  `reserved`. The hold is what later callers see; the estimate is what the
  caller itself was tested against. Keeping them apart preserves today's
  admission decision (§5, §6; Test plan 7): if admission used the larger
  hold, a call with `estimate <= budget < hold` would be newly refused and
  could be misreported `budget_too_small`.
- **Settle**: `settle(handle, actual)` removes the hold and charges the
  provider's real usage, or the existing estimate fallback: exactly the
  `record` the call site does today (`llmCall.ts:55-58`, `:96-101`).
- **Release on throw**: `release(handle)` removes the hold and charges
  nothing. That is today's behavior when the provider throws (no `record` is
  reached). A provider that spent tokens before throwing stays unmetered, as
  today (Open question 5).
- **Handles are single-use.** A second `settle`/`release` on a closed handle
  is a no-op: never a double charge, never a negative `reserved`.
- **Unbounded meter** (`budget === undefined`): `reserve` always succeeds;
  `remaining` stays `Infinity`.
- **No meter** (`ctx.meter` undefined): call sites do not reserve; nothing
  changes.
- `record()` and `fits()` stay, so `selectBatch` and tests behave as today
  whenever no reservation is outstanding.

### 2. What `remaining` and `fits` mean now

`remaining` = `max(0, budget - used - reserved)`: what a *new* call may still
claim. `fits(e)` = `e <= remaining`. With no reservation outstanding both are
byte-identical to today's. `used` and `estimated` move only on
`record`/`settle`, so `tokensUsed` and `estimated` report spent tokens only,
never held ones.

The scheduler reads `meter.remaining` once, after every unit has settled
(`MaintenanceScheduler.ts:315-317`); `reserved` is 0 by then, so the host
sees `budget - used` as before. A leaked reservation would make that figure
lie, so (a) every reserve is paired with settle/release in one `try`/`catch`
shape inside the two wrappers (§3) and (b) Test plan 5 asserts the pairing.

### 3. Call sites

The two `record` sites become reserve/settle/release, in the two wrappers that
already are the choke points. No other call site changes.

- `callClassify` (`llmCall.ts:79-113`):
  `const r = ctx.meter?.reserve(inputEstimate, inputEstimate * CLASSIFY_HOLD_FACTOR)`
  replaces `:86-88`; the `classify`-missing `TypeError` (`:91-93`), the
  provider call and the response handling run inside a `try`; `settle(r,
  record)` replaces `:101`; any throw `release`s and rethrows. Order of
  effects is unchanged: reserve (was: fits), provider call, record,
  `llm_usage`, return. `CLASSIFY_HOLD_FACTOR = 2` (Open question 1), with a
  doc comment giving the reason: a `choice` answer echoes a probability per
  option (`ClassifierAnswer`, `types.ts:861-864`), so the output is of the
  order of the question's own size, which the input estimate includes.
  Named constant, same precedent as `RESOLVE_RESERVE_FACTOR = 2`
  (`ops/extract.ts:17`).
- `callLlm` (`llmCall.ts:30-70`): same shape, hold = input estimate (no output
  allowance: no metered generative caller is concurrent, so the hold has no
  reader today; Open question 3). The `TypeError` for a malformed
  `generateTextWithUsage` result (`:46-48`) is thrown inside the `try`, so it
  releases. This stops the generative path being a latent copy of the bug: a
  future parallel caller gets at least input-estimate protection.
- `selectBatch` (`ops/extract.ts:82`) stays a bare `meter.fits(need)`: a
  whole-pass planning check that runs before any call of the pass is in
  flight. A hold there would be released before the real calls start.
- `typeOnWrite.ts:127-148`, `MaintenanceService.ts:2740-2790`,
  `ops/resolve.ts:155-158`: **unchanged code**. They already catch
  `WikiBudgetExhausted` from `callClassify` and set their `stopped` flag; the
  difference is that the exception now also fires when other in-flight calls'
  holds consume the remaining budget (§4).

### 4. Behavior under concurrency above 1

With the 2x hold, the probe (budget 250, estimate 60, actual 110, concurrency
4, 12 facts) runs: worker 1 reserves (hold 120), worker 2 reserves (hold 240),
worker 3's `fits(60)` sees `remaining = 10` and throws; the step stops asking.
Workers 1 and 2 settle at 110 each: `tokensUsed = 220`, two calls, the other
ten facts `unattempted`. That is what concurrency 1 does with the same budget.

Reporting keeps its shape: write-time typing returns `unattempted` counts and
the scheduler stops the run as `budget_exhausted`
(`MaintenanceScheduler.ts:196`); the classifier backfill returns
`budgetStop: { requiredEstimate }` (`MaintenanceService.ts:2763`, `:2920`).
Facts not asked stay untyped and eligible next run. A host loop
`while (remaining > 0 && !budgetStop)` still terminates.

One new wrinkle, disclosed (Open question 2): a worker can be refused because
*other calls' holds* eat the headroom, and those calls may settle below their
hold. The step then reports exhaustion while, after settling, a little budget
remains (`remaining` in the result tells the truth). Concurrency above 1 is
opt-in; the stop never overspends; the unattempted work is retried on the next
run.

When **actual exceeds the reservation** (a provider that reports more than the
hold): `settle` charges the actual. `used` may exceed `budget`; `remaining`
clamps at 0; the next `reserve` throws; `tokensUsed` reports the real figure.
This is what `record` does today. The hold is an admission guard, not a cap on
what the provider may spend.

### 5. The default path (`chunkConcurrency` 1) is byte-for-byte unchanged

The argument, not only a claim:

1. At concurrency 1 at most one reservation is open on a meter, and the only
   code that reads `remaining`/`fits` while it is open is the call holding it.
   The next call's `reserve` runs after the previous `settle`, which is
   `await`ed to completion inside `callLlm`/`callClassify`, so `reserved` is 0
   at every admission check.
2. With `reserved = 0`, `remaining = max(0, budget - used)`: today's formula.
   Admission tests `estimate` (not the hold): today's test. The thrown
   `WikiBudgetExhausted` carries the same `(estimate, remaining)`.
3. `settle(h, actual)` = free hold, then `record(actual)`: `used` and
   `estimated` move by the same amounts, at the same point relative to the
   `llm_usage` emission (`settle` precedes it, as `record` does at `:58`/`:101`).
4. The provider throws or returns a malformed result: today nothing is
   recorded; now `release` charges nothing.
5. So `tokensUsed`, `estimated`, `remaining`, `stoppedReason`
   (`budget_exhausted` / `budget_too_small` / `deadline` / `complete`),
   per-entity reports, `budgetStop.requiredEstimate`, and the diagnostics
   sequence (including `llm_usage` details) are unchanged. Test plan 4 pins
   this with an in-test copy of the old meter and the existing suites run
   unmodified.

No code path at concurrency 1 reads `reserved`.

### 6. `WikiBudgetExhausted` and the stop classification

- `WikiBudgetExhausted`: same class, fields, message, `instanceof` behavior.
  All `catch` sites (`BoundedLlmCall.ts:395`, `ops/resolve.ts:82`,
  `ops/index.ts:62`, `legacy.ts:80`, `typeOnWrite.ts:138`,
  `MaintenanceService.ts:2762`) are untouched. The one nudge: its `remaining`
  field is now the *unreserved* remaining (equal to the old figure whenever
  nothing else is in flight). It is internal and read only by the message.
- `budget_too_small` against `budget_exhausted`
  (`MaintenanceScheduler.ts:137-143`) compares `requiredEstimate` with the
  **whole** budget. `requiredEstimate` is still the call's own input
  estimate, never the hold. A refusal caused by other calls' holds
  (estimate within budget) therefore classifies as `budget_exhausted`, and a
  call larger than the whole budget still classifies as `budget_too_small`.
  This is the reason admission tests the estimate and not the hold.
- Not touched: the output-ceiling limit (Open question 4), `deadlineMs`
  semantics, the `llm_usage` shape, the scheduler's meter lifetime.

### 7. Public API impact: none

`UsageMeter`, `WikiBudgetExhausted` and `LlmCallContext` are **not** exported:
`src/index.ts` exports only `validUsage` from `utils/llmCall` (`:17`) and
nothing from `utils/usage`; `package.json` exposes only `.` and `./testing`;
no other workspace package imports them; `types.ts` and `testing.ts` do not
reference them. `LibrarianPassContext.meter`
(`services/librarian/types.ts:81`) sits in a module no public entry
re-exports. The host-visible meter surface is `tokenBudget` in and
`tokensUsed` / `estimated` / `remaining` / `stoppedReason` out, all unchanged
in type and (at concurrency 1) in value. The implementation PR confirms with a
pack-diff of the published `.d.ts` (expected: empty).

### 8. Docs

- `apps/docs/src/content/docs/guides/maintenance.md:161`: replace the
  step-13 sentence ("checked before each call and charged after, so with
  `chunkConcurrency` above 1 up to N-1 in-flight calls can overshoot it ...
  tracked in #475") with: calls in flight are held against the budget before
  they start, so parallel calls cannot all claim the same headroom; the check
  is still on the *input estimate*, so a call's own output can run past the
  budget (as it always could); at `chunkConcurrency` above 1 a run may stop
  slightly early while in-flight calls hold the headroom. No cost claim.
- `apps/docs/src/content/docs/reference/configuration.md:65`: **verified, no
  overshoot sentence exists there.** Step 13's edit only widened the
  `chunkConcurrency` scope ("and parallel classify calls for the ontology
  backfill and write-time typing"), which stays accurate. No change needed;
  the implementation PR re-greps `overshoot|N-1|#475` across `apps/`, `docs/`
  and `specs/` to confirm none remain.
- `specs/type-on-write/spec.md` §3, the sentences at `:256-260` ("The meter is
  checked before each call and charged after ... follow-up issue #475"):
  delete the overshoot sentence and replace it with one line pointing to
  `specs/meter-reservation` ("classify calls reserve before they start"). The
  Status line stays Implemented.
- `docs/superpowers/specs/2026-07-13-ontology-backfill-spec.md:438-441`
  ("Overshoot honesty") and `:596-600` (a real meter "cannot produce" a
  mid-concurrency stop): add a dated pointer to this spec. Both statements
  stop being true at concurrency above 1. Legacy spec, so its Status line
  rule applies (`AGENTS.md`, "Spec status honesty").
- Code docs: the `UsageMeter` class comment and the `tokenBudget` doc on
  `RunPendingMaintenanceOptions` (`types.ts:1869-1871`, now "generateText
  tokens ...") say it covers classify and describe the hold.
- `docs/ROADMAP.md`: no step carries this fix; a done mark is not needed
  (`AGENTS.md`: the roadmap carries order, not status).

### 9. Semver

`fix(core): reserve budget before each metered call so parallel calls cannot
overspend (#475)`. Patch. No public type or export changes; at the default
concurrency behavior is identical; at concurrency above 1 with a bounded
budget the engine now spends less, honoring the host's declared budget, which
is a bug fix nobody can rely on being undone. No `BREAKING CHANGE` footer (it
would publish a major, `AGENTS.md`); no `CHANGELOG.md` or `"version"` edit.

## Files touched

Implementation (not in this PR):

- `utils/usage.ts`: `reserved`, `remaining`, `reserve`, `settle`, `release`,
  `UsageReservation`; class comment.
- `utils/llmCall.ts`: `callLlm`, `callClassify` (reserve / settle / release;
  `CLASSIFY_HOLD_FACTOR`).
- `types.ts`: `tokenBudget` doc comment at `:1871`.
- Docs listed in §8.
- Tests (below). No change to `typeOnWrite.ts`, `MaintenanceService.ts`,
  `MaintenanceScheduler.ts`, the librarian strategies, or `BoundedLlmCall.ts`.

This PR (spec draft): `specs/meter-reservation/spec.md` only. No `plan.md` or
`LEDGER.md` until the spec gate closes (`specs/README.md`).

## Test plan

Targeted vitest only; each item names the file it extends.

1. **Meter unit** (`__tests__/usage.test.ts`): reserve then `remaining` and
   `reserved`; `fits` sees reservations; settle charges actual and frees the
   hold; release charges nothing; double settle/release is a no-op; admission
   uses `estimate` while the hold is `max(estimate, hold)`; unbounded meter;
   `WikiBudgetExhausted` carries `(estimate, unreserved remaining)`.
2. **Wrappers** (`__tests__/llmCall.test.ts`, `__tests__/utils/callClassify.test.ts`):
   provider throws, `generateTextWithUsage` returns a malformed value,
   `classify` is missing: each leaves `reserved === 0` and `used` unchanged.
   `llm_usage` detail unchanged for reported and estimated usage.
3. **Concurrency test that fails today** (new
   `__tests__/services/meter-reservation.test.ts`): a fake `classify` that
   reports `{ inputTokens: 60, outputTokens: 50 }`, a request sized so the
   input estimate is 60, a barrier so every admitted call is in flight before
   any settles, `UsageMeter(250)`, `withConcurrency(..., 4)` over 12 facts.
   Asserted at the `callClassify` level, then through `classifyFactsForWrite`
   and `runOntologyBackfill({ classifier: 'auto', tokenBudget: 250 })` with
   `chunkConcurrency: 4`: provider call count 2, `tokensUsed` 220, remaining
   facts `unattempted` / `budgetStop` set. Today the same test sees 5 calls
   and 550 (the probe). A second case varies per-fact input sizes (the
   existing `services/backfill-budget.test.ts:36` shape) so holds differ.
4. **Default-path equivalence** (same file): a test-local copy of the old
   meter and old wrappers against the new ones, over a table of (budget,
   estimate, reported usage, throws) at concurrency 1: identical `used`,
   `estimated`, exception arguments, diagnostics. Plus the existing suites
   run **unmodified**: `usage`, `llmCall`, `utils/callClassify`,
   `librarianBudget`, `healBudget`, `runPendingMaintenance`, `typeOnWriteOps`,
   `typeOnWriteModule`, `opsResolveSystemOne`, `classifierEdgeScreen`,
   `pendingMaintenanceOntology`, `services/classifier-budget-stop`,
   `services/backfill-budget`. A `runPendingMaintenance` result at default
   config (`tokensUsed`, `estimated`, `remaining`, `stoppedReason`,
   `perEntity`, diagnostics) is recorded on `main` before the change and
   compared after.
5. **No leak**: `vi.spyOn(UsageMeter.prototype, ...)` counts, across scheduler
   runs, backfill, typing and heal tests, show `reserve` calls equal
   `settle` plus `release` calls.
6. **API surface**: build the package and diff the published `.d.ts` against
   `main` (pack-diff); expected empty. `index.ts` export list unchanged.
7. **Stop classification**: a `tokenBudget` below the input estimate yields
   `budget_too_small` at concurrency 1 and 4. `estimate <= budget < hold`
   admits a solo call (not `budget_too_small`). Concurrency 4 with the
   estimate within the whole budget stops as `budget_exhausted`, never
   `budget_too_small`.
8. **Actual above hold**: the provider reports 300 against a 120 hold;
   `tokensUsed` reports 300; the next call is refused; `remaining` is 0, not
   negative.

## Rejected alternatives

- **Reserve the input estimate only** (the issue's literal proposal): leaves
  440 against a 250 budget on the probe (table above). Kept as the `callLlm`
  hold, where no concurrent reader exists.
- **Admit on the hold** (refuse unless `2 x estimate` fits): changes the
  default path's admission and can reclassify `budget_too_small`.
- **Serialize metered calls** (force concurrency 1 when a budget is set):
  silently overrides the host's declared `chunkConcurrency`.
- **A meter lock/queue** that makes callers wait: more machinery and new
  ordering semantics for a bug a synchronous reserve fixes. Wait-and-retry is
  Open question 2's alternative, not the base design.
- **Put the check in `withConcurrency`**: the pool is generic and also serves
  unmetered ingest; the meter is the right owner.

## Open questions for Kurt

Owner-approved 2026-11-23; all open-question defaults accepted. Each question below is answered by its stated default.

1. **Hold size for `classify`.** Options: (a) input estimate only, per the
   issue (probe still spends 440 of 250); (b) input estimate x 2 (probe spends
   220, the sequential figure); (c) adaptive, learned from settled calls (the
   first N calls all launch blind). *Default: (b), as a named constant
   `CLASSIFY_HOLD_FACTOR = 2`, with a comment giving the reason and no
   accuracy claim.*
2. **Refusal caused by other calls' holds.** At concurrency above 1 a worker
   may be refused while in-flight holds exceed what those calls then settle,
   ending the step with budget left. Options: (a) conservative stop, report
   `budget_exhausted`; (b) the worker waits for an in-flight call to settle
   and retries, stopping only when nothing is in flight. *Default: (a); (b) is
   a small follow-up if hosts report early stops.*
3. **`callLlm` hold.** (a) input estimate only (no concurrent metered
   generative caller exists); (b) also an output allowance now (for example
   from the `maxOutputTokens` hint) so a future parallel caller is already
   covered. *Default: (a).*
4. **The budget is a pre-flight, not a ceiling.** A call that fits on its
   input estimate can still end past the budget by its own output, even
   sequentially (`llmCall.ts:36` against `:55-58`). Make `tokenBudget` a hard
   ceiling (needs a per-call output cap the provider contract does not have)
   or keep documenting it as an admission budget. *Default: keep, and say so
   in the guide.*
5. **Unmetered spend.** (a) A provider call that throws after spending tokens
   records nothing (today's behavior, kept); (b) ingest's parallel calls pass
   no meter at all; (c) manual `runLibrarian`/`runHeal` and the `'auto'` write
   trigger are unmetered. Separate issues, or in scope? *Default: out of
   scope; file issues only if Kurt wants them tracked.*
6. **Handle ergonomics.** `meter.settle(handle, r)` / `meter.release(handle)`
   (as written, matching the issue) against methods on the handle; and no-op
   against throw on a second settle. *Default: meter methods; no-op, so a
   `finally` cannot corrupt accounting.*
7. **Docs wording.** The new maintenance-guide sentence (§8) discloses the
   early-stop wrinkle and the input-estimate caveat. *Default: disclose both;
   never state that overspend is impossible.*
