# Maintenance Output Bounding and Dependency Hygiene

**Date:** 2026-08-04
**Status:** Implemented
**Addresses:** #63, #65 (maintenance prompt/response bounding), #64 (MiniSearch crash), 36 open Dependabot alerts

## Problem

Three defects were reported against `@equationalapplications/core-llm-wiki` v4.22 from a downstream
consumer's full-corpus validation run (168 documents, single `business` entity). A dependency audit
surfaced a fourth workstream.

### #63 / #65 — unbounded LLM output in `MaintenanceService`

`doRunHeal` and `doRunOntologyBackfill` each build a prompt whose response size grows with corpus
size, with nothing bounding the response. Past a threshold both fail permanently: every retry
re-sends the same oversized request, so there is no partial progress and no self-recovery.

`doRunHeal` (`packages/core/src/services/MaintenanceService.ts:469`) fetches every fact for an
entity via `findAllByEntityId` and derives two unbounded arrays. On the reported corpus:

| Row class | Count |
|---|---|
| `immutable_document` facts → `documentAnchors` | 2560 |
| `librarian_inferred` facts → `healCandidates` | 31 |

Anchors outnumber the candidates the model actually reasons about by ~80×. The call fails with
`Model response truncated at the 8192-token limit`.

`doRunOntologyBackfill` already bounds its *input* — `ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS = 40_000`,
enforced at `MaintenanceService.ts:613` — but nothing bounds its *output*. Against a 1177-fact
untyped backlog it failed on 3 of 3 retries, in two shapes depending on where truncation landed
relative to the JSON grammar: `SyntaxError: No JSON object/array found in LLM response`, and
`Error: Model response truncated at the 9999-token limit`.

Raising `maxTokens` is not available as a fix. The model under test (`amazon.nova-pro-v1:0`)
enforces a hard 10000-token output ceiling; the consumer was already at 9999. Config tuning can
only postpone this defect, and here it barely postpones it.

Compounding this, core cannot see the ceiling at all. `LlmProvider` is declared as
`generateText: (params: { systemPrompt: string; userPrompt: string }) => Promise<string>`
(`packages/core/src/types.ts:312`). The token budget lives entirely in the host's adapter.

### #64 — process-killing crash in MiniSearch's auto-vacuum

An uncaught `TypeError` in `MiniSearch.performVacuuming` → `TreeIterator.next` → `TreeIterator.dive`
killed the Node process during ingest at `documentConcurrency: 3`. It occurred on the first attempt
of two separate invocations and never on retry.

The race is in this repository, not in `minisearch`. `SearchService.rebuildIndex`
(`packages/core/src/services/SearchService.ts:197-218`) is `async`, and the `await` on
`findMiniSearchRows` sits between reading `previousIds` and the `discard()` loop that consumes them:

```ts
const rows = await this.entryRepo.findMiniSearchRows(entityId);   // ← await
const previousIds = this.miniSearchEntryIdsByEntity.get(entityId);
if (previousIds) {
  for (const id of previousIds) this.miniSearch.discard(id);
}
```

Two concurrent `sync()` calls for the same entity both snapshot the same id set and both discard it.
`discard()` is precisely what accrues MiniSearch's auto-vacuum debt, and `autoVacuum` is on by
default (`SearchService.ts:52`), firing on its own schedule asynchronously with respect to the
caller. A vacuum traversing a tree mid-interleave observes exactly the `undefined` node the stack
trace shows. There is no mutex, and the throw escapes as an unhandled rejection.

### Dependency alerts

36 open Dependabot alerts, all transitive, none against a direct dependency. 17 of them are against
four git-tracked `package-lock.json` files (root, `apps/wiki-demo/`, `packages/core/`,
`packages/react/`) that nothing builds from — `pnpm-lock.yaml` is the live lockfile, and root
`package-lock.json` is ten days staler. Root `package.json` has no `packageManager` field, so
nothing prevents an `npm install` from regenerating them.

## Design

### Workstream A — bounded maintenance calls (#63, #65)

Both issues are one defect in two methods, so they get one fix.

#### A1: `BoundedLlmCall.ts`

A new dependency-free module, `packages/core/src/services/BoundedLlmCall.ts`, exporting one
function:

```ts
runBatched<TItem, TResult>(args: {
  items: TItem[];
  buildPrompt: (batch: TItem[]) => BuiltPrompt | Promise<BuiltPrompt>;
  call: (prompts: BuiltPrompt) => Promise<string>;
  parse: (responseText: string, batch: TItem[]) => TResult;
  maxOutputTokens?: number;
  maxPromptChars: number;
  onSkip?: (item: TItem, err: unknown) => void;
}): Promise<{ results: TResult[]; skipped: TItem[]; batches: number }>
// BuiltPrompt = { systemPrompt: string; userPrompt: string }
```

It owns batch sizing, the `generateText` call, failure detection, halve-and-retry splitting, and the
skip decision. It knows nothing about facts, heal, or ontology — `MaintenanceService` supplies the
domain callbacks. This keeps the logic testable against a fake `call` with no LLM and no database,
and keeps it out of `MaintenanceService.ts`, which is already 726 lines.

**Batch sizing.**

- `DEFAULT_BATCH_SIZE = 10` when `maxOutputTokens` is absent. This is deliberately below the
  existing `ONTOLOGY_BACKFILL_BATCH_SIZE = 25`, which is a size already observed to fail at a
  9999-token ceiling. The absence of a hint must never size *up*: starting large would make the
  split path do all the work, burning API time and tokens on first attempts guaranteed to fail.
- When `maxOutputTokens` is present, it may size up from the default via a crude per-item output
  estimate. The estimate is documented as crude; its only job is to make the common case one call
  rather than three. It is never trusted as a guarantee — the split path below is always armed.
- `maxPromptChars` is applied to whichever batch size wins, trimming the batch before the call. The
  two bounds are independent and both enforced, so a small number of dense facts is still trimmed.

**Failure detection.** Core sees only a `string` or a thrown `Error`. A batch is considered failed
when `parse` throws, *or* when `call` throws with a message matching a truncation pattern. Both are
handled identically — split and retry — so a misclassified error costs one wasted retry, never
correctness.

**Splitting and skipping.** On failure the batch is halved and each half retried, recursively, down
to a single item. An item that still fails alone is appended to `skipped` and the pass continues.
`skipped` is returned to the caller, and logged with entity id and item id so an operator sees a
legible record instead of a stack trace. A pass never throws because one item is unprocessable.

**Sticky downward adaptation.** `runBatched` carries the last successful batch size forward across
batches within a single invocation and starts subsequent batches there. Without this, a run over a
1177-fact backlog rediscovers the same ceiling on every batch — fail at 10, fail at 5, succeed at 2,
then start the next batch at 10 again. The size ratchets down freely and never climbs back up
mid-run, so the worst case is one wasted split sequence per run rather than one per batch.

#### A2: `LlmProvider.maxOutputTokens`

`LlmProvider` (`packages/core/src/types.ts:312`) gains an optional `maxOutputTokens?: number`.
Optional keeps this non-breaking: existing hosts compile unchanged and rely on the split path. Hosts
that declare it get better first-attempt sizing.

#### A3: `doRunOntologyBackfill`

The hand-rolled accumulation loop at `MaintenanceService.ts:609-616` is replaced by `runBatched`.
`ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS` moves in as the `maxPromptChars` argument and remains enforced.

Results merge across batches: `typed`, `failedValidation`, and `edgesAdded` sum; `ontology_updates`
merge per batch inside the existing transaction, preserving the current `mergeEmergentUpdates`
semantics and the mid-flight `mode === 'off'` abort check.

`OntologyBackfillResult` gains `skipped: number`.

This also relieves #65's secondary symptom. Today one pass classifies at most one batch, so the
consumer's `maxPasses: 50` × `batchSize: 25` caps a run at 1250 facts — which is why the first
maintain run reported `converged: false`. With batching inside a pass, a pass makes materially more
progress and `converged: false` becomes rarer without any host config change.

#### A4: `doRunHeal`

Two changes.

**Candidate fetch.** `findAllByEntityId` at `MaintenanceService.ts:469` is replaced by a
mutable-only repository query, so heal no longer loads 2560 rows in order to filter 31 out of them.
The `immutable_document` filter at line 473 becomes unnecessary.

**Anchor scoping.** `documentAnchors` are selected per batch by relevance rather than exhaustively:
for each batch of candidates, retrieve rows matching the candidates' titles via the existing
`SearchService` keyword path, restrict the hits to `source_type === 'immutable_document'`, and cap
the result at `HEAL_MAX_ANCHORS = 50`. The search index is not anchor-only, so the source-type
restriction is required and must be applied after retrieval. Anchor volume then scales with batch
size instead of corpus size.

`PromptService.buildHealPrompt` is unchanged — it already accepts anchors as a parameter
(`PromptService.ts:91`) and simply receives a shorter array. The existing `mutableIds` guard at
`MaintenanceService.ts:495`, which filters model output down to ids that were actually offered as
candidates, continues to protect anchors from modification.

**Accepted tradeoff, stated plainly:** heal's contradiction detection changes character. Today it is
exhaustive but broken; afterward it is relevance-scoped and working. An anchor that contradicts a
candidate while sharing no vocabulary with it will be missed. This is a real reduction in
theoretical coverage, accepted in exchange for a pass that runs at all.

#### A5: Testing

- `runBatched` unit tests against a synthetic `call` that fails above a threshold size: assert
  splitting reaches a working size, that a single unsplittable item lands in `skipped` rather than
  throwing, and that sticky adaptation does not re-climb within a run.
- A `MaintenanceService` heal test asserting the anchor count passed to `buildHealPrompt` stays
  bounded as the simulated corpus grows.
- A backfill test asserting a batch that fails whole succeeds when split, and that per-batch results
  merge correctly into the summed `OntologyBackfillResult`.

Tests live in `packages/core/__tests__/` alongside the existing suite.

### Workstream B — MiniSearch crash (#64)

Three changes to `packages/core/src/services/SearchService.ts`.

**B1: serialize.** A per-instance promise chain:

```ts
private syncChain: Promise<void> = Promise.resolve();
```

`sync()` appends its work to the chain, so `rebuildIndex` bodies cannot interleave regardless of how
many concurrent ingests call in. This addresses the actual cause.

**B2: explicit vacuum.** The constructor (`SearchService.ts:52`) sets `autoVacuum: false`, and
`sync()` calls `vacuum()` explicitly at the end of the rebuild, inside the serialized section where
the tree is quiescent. This removes the asynchronous, caller-invisible vacuum scheduling that turned
the race into a crash.

**B3: guard.** The rebuild body is wrapped so a throw becomes a `console.warn` matching the existing
hook-failure pattern (`MaintenanceService.ts:465`) rather than an unhandled rejection that kills the
process. Degraded keyword search is the correct failure mode: SQLite is the durable store and this
index is a rebuildable cache.

**B4: version bump.** Bump `minisearch` from `^7.0.0` (`packages/core/package.json:63`) after
checking changelogs from 7.2.0 forward. Opportunistic, not the fix — B1 stands on its own.

**Testing:** a test firing N concurrent `sync()` calls for the same entity, asserting the resulting
index contents are correct and that no rejection escapes. This test fails against current code.
`packages/core/__tests__/SearchService.test.ts` already exists to extend.

### Workstream C — dependency hygiene

**C1: remove stale npm lockfiles.** Delete `package-lock.json` at the repository root and in
`apps/wiki-demo/`, `packages/core/`, and `packages/react/`. Add `"packageManager": "pnpm@10.33.2"`
to root `package.json` and add `package-lock.json` to `.gitignore`.

This resolves 17 of 36 alerts, every one of which is a finding about a file nothing builds from.
Verification is a clean `pnpm install && pnpm test` — if anything did consume those files, this is
where it surfaces.

**C2: refresh, then override.** Run `pnpm update` to absorb what floats up naturally, then add
targeted `pnpm.overrides` for advisories that remain, runtime scope first:

| Package | Scope | Severity | Fixed in |
|---|---|---|---|
| `tar` | runtime | critical | 7.5.19 |
| `brace-expansion` | runtime | high | 2.1.3 |
| `fast-uri` | runtime | high | 3.1.4 |
| `undici` | dev | high | 7.29.0 |
| `postcss` | dev | high | 8.5.18 |
| `js-yaml` | dev | high | 4.3.0 |
| `shell-quote` | dev | high | 1.9.0 |

Where a parent package pins a range that an override would violate, leave it and record the reason
rather than forcing it. A forced transitive pin that breaks a parent is worse than a dev-scope
advisory.

**Verification gate:** full `pnpm test` after C1 and again after C2, plus a re-query of the
Dependabot alert API to record actual before/after counts. This spec commits to the process, not to
a target number — no zero-alert promise is made before knowing which overrides hold.

## Sequencing

1. **C1** — isolated, unblocks a clean, unambiguous install.
2. **B** — self-contained, and has a failing test to prove the fix.
3. **A** — largest, and benefits from a trustworthy `pnpm test` baseline established by C1 and B.

## Public API impact

Workstream A is the only workstream touching public types, and only additively:

- `LlmProvider.maxOutputTokens?: number` — new, optional.
- `OntologyBackfillResult.skipped: number` — new field on a returned object.

Both are minor-version changes. No major version bump is required.

## Out of scope

- Any change to the host's `maxTokens` configuration. The premise of #63 and #65 is that token-budget
  tuning cannot fix this defect class.
- Broader refactoring of `MaintenanceService.ts` beyond extracting `BoundedLlmCall`.
- Retrieval-quality work on heal's anchor selection beyond the keyword-relevance approach specified
  in A4.
