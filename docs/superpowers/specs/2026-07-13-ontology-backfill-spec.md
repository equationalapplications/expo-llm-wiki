# Spec: Ontology Backfill — Typing Facts That Bypassed the Librarian

**Date:** 2026-07-13
**Status:** Implemented
**Packages:** `core-llm-wiki` (primary), `expo-llm-wiki` (re-export + docs)

---

## Problem

Facts that enter the store without passing through the librarian never receive
`okf_type` or edges, and nothing ever revisits them. Two populations:

1. **Synced-down remote facts.** Host apps with a server-side agent (e.g. Clanker's
   cloud-agent `wiki_write`) insert finished facts into the remote store with no
   ontology fields. `importDump` → `doImportEntity` is a pure transactional upsert —
   no librarian pass — so these facts land locally untyped and unlinked, permanently.
2. **Pre-ontology facts.** Every fact created before the ontology feature shipped
   has `okf_type = NULL`.

Consequence: the knowledge graph is systematically sparser than the fact store.
`wiki_traverse_graph` cannot reach any of these facts, and the asymmetry grows with
server-agent usage — the exact memories a cloud escalation deemed worth recording
are the ones excluded from graph retrieval.

The extraction pipeline itself is complete and proven
(`MaintenanceService.doRunLibrarian`: `buildPromptContext` →
`validateAndNormalizeFact` → `resolveAndPersistEdges` → `mergeEmergentUpdates`);
it simply only runs on the live `write()` path. This spec adds a maintenance pass
that runs the same typing machinery over already-persisted untyped facts.

Naming note: **"backfill", not "orphan adoption"** — `orphanAfterDays` /
`markOrphaned` in the heal pass already mean "aged, unaccessed facts", an unrelated
concept.

---

## Solution

New maintenance operation `runOntologyBackfill(entityId)` in core: select a bounded
batch of live untyped facts, make one librarian-style LLM call proposing
`okf_type` + edges per fact (and `ontology_updates` in emergent mode), validate
through the existing ontology machinery, and update the facts **in place**. Strictly
additive: never creates, deletes, or rewrites facts; never overwrites an existing
`okf_type`. Host apps decide when to spend the call — the library provides the
operation, not a scheduler, matching `runLibrarian` / `runHeal` / `runPrune`.

---

## Design Decisions

### 1. Public API mirrors the existing maintenance surface

```ts
// WikiMemory (delegates to MaintenanceService)
async runOntologyBackfill(
  entityId: string,
  options?: { promptOverride?: string; batchSize?: number },
): Promise<OntologyBackfillResult>

export interface OntologyBackfillResult {
  scanned: number;          // untyped facts sent to the model this run
  typed: number;            // facts that received an okf_type
  failedValidation: number; // returned by the model but rejected (unknown id,
                            // non-manifest type, etc.); omissions are derivable
                            // as scanned − typed − failedValidation
  edgesAdded: number;       // edges persisted
  remaining: number;        // untyped facts still ELIGIBLE after this run —
                            // safe host convergence signal: loop while > 0
  deferred: number;         // untyped facts in the recheck cooldown (Decision 3b)
}
```

- Lock discipline identical to siblings: `runOntologyBackfill` acquires a JobManager
  lock (new `OperationType` member `'ontologyBackfill'`), delegates to
  `doRunOntologyBackfill`, releases in `finally`. Concurrent invocation throws
  `WikiBusyError`; transactions serialize on the shared connection per the
  2026-07-09 transaction-serialization spec.
- `remaining` lets hosts implement their own convergence policy (re-trigger later,
  show progress) without the library baking in a loop.

### 2. Selection: `okf_type IS NULL`, oldest first, bounded batch

New repository methods:

```ts
// EntryRepository
findUntypedByEntityId(entityId: string, limit: number, recheckCutoff: number, tx?: SQLiteAdapter): Promise<WikiFact[]>
  // WHERE entity_id = ? AND okf_type IS NULL AND deleted_at IS NULL
  //   AND (ontology_checked_at IS NULL OR ontology_checked_at <= ?)
  // ORDER BY updated_at ASC LIMIT ?
countUntypedByEntityId(entityId: string, recheckCutoff: number, tx?: SQLiteAdapter): Promise<{ eligible: number; deferred: number }>
updateOkfType(id: string, entityId: string, okfType: string, tx: SQLiteAdapter): Promise<{ changes: number }>
  // UPDATE ... SET okf_type = ? WHERE id = ? AND entity_id = ? AND okf_type IS NULL
  // changes === 0 → the fact was typed concurrently between select and update
  // (the okf_type IS NULL guard left it untouched); the caller skips it
markOntologyChecked(ids: string[], entityId: string, now: number, tx: SQLiteAdapter): Promise<void>
  // UPDATE ... SET ontology_checked_at = ? WHERE id IN (…) AND entity_id = ? AND deleted_at IS NULL
  // NEVER touches updated_at — see Decision 3b
```

- Batch size defaults to `ONTOLOGY_BACKFILL_BATCH_SIZE = 25`, overridable per call
  via `options.batchSize` for hosts whose LLM provider has tighter context limits.
  One LLM call per run, bounded cost. First-run backlogs (pre-ontology facts)
  converge across repeated triggers rather than bursting.
- **Payload guard:** after selecting up to `batchSize` facts, add facts to the
  batch only while the full serialized prompt (`systemPrompt` + `userPrompt`,
  including the manifest, ids, tags, JSON syntax, and any override) stays within
  `ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS = 40_000`. Facts can be large (ingestion
  chunks run up to `maxChunkLength` ≈ 12k chars), and 25 dense facts could
  otherwise blow past a provider's context window or degrade instruction
  following. At least one fact is always sent (a single oversized fact is not
  silently starved; the model sees it alone, even over the cap).
- Oldest-first (`updated_at ASC`) so long-neglected facts are typed before recent
  ones and the queue drains deterministically. A useful side effect: facts created
  around the same time — the likely edge partners — cluster into the same batch.
- `updateOkfType` guards `okf_type IS NULL` in the WHERE clause so a concurrent
  writer can never be overwritten — additive by construction, not by convention.

### 3b. Recheck cooldown: skipped facts must not clog the queue

Without bookkeeping, a fact the model consistently declines to type (malformed
synced fact, or genuinely outside a strict manifest) sits at the head of the
oldest-first queue forever, re-consuming tokens every run and eventually stalling
the whole pipeline once `batchSize` such facts accumulate.

**Mechanism:** new nullable `ontology_checked_at INTEGER` column on entries
(migration follows the existing `ALTER TABLE ADD COLUMN` pattern with a
column-existence guard, outside any explicit transaction — same as the `okf_type`
migration). Every fact **scanned** in a run — typed or not — gets
`ontology_checked_at = now` inside the write transaction. Selection skips facts
checked within `ONTOLOGY_BACKFILL_RECHECK_MS = 7 days`.

- Skipped facts re-enter the queue after the cooldown. In emergent mode this doubles
  as the retry path for manifest growth: a fact unclassifiable today may fit after
  new types emerge.
- `remaining` counts only **eligible** untyped facts, so a host loop
  (`while remaining > 0`) terminates even when unclassifiable facts exist;
  `deferred` reports the cooled-down remainder for telemetry.

**Rejected alternatives:**

- *Bump `updated_at` on skip* — actively dangerous, not merely impure:
  `ImportExportService.doImportEntity` merge resolution is last-write-wins on
  `updated_at` (`if (merge && safeUpdatedAt <= existing.updated_at) continue`).
  A backfill bump would make an unchanged local fact beat a genuinely newer
  remote edit during sync.
- *Sentinel `okf_type` (e.g. `unclassified`)* — `okf_type` flows into OKF export
  and into `resolveAndPersistEdges`' manifest type checks; a non-manifest slug
  breaks the "okf_type is a manifest slug" invariant everywhere it is read.

### 3. Early exits make the pass free when there is nothing to do

`doRunOntologyBackfill` returns a zeroed result (`deferred` still reported) without
an LLM call when:

- ontology mode is `'off'` for the entity (via `getEffectiveState`), or
- `findUntypedByEntityId` returns zero eligible rows.

This is what makes an unconditional post-sync trigger in host apps viable: the
common case (no server-agent writes since last sync) costs one SELECT.

### 4. Prompt: dedicated template, same contract as the librarian

New `ONTOLOGY_BACKFILL_SYSTEM_PROMPT` in `prompts.ts` plus
`PromptService.buildOntologyBackfillPrompt(facts, runtimeOverride?, ontologyContext?)`
following the existing hydrate/append pattern (`{{facts}}` placeholder support,
ontology context appended via `buildOntologyPromptAppendix` exactly like
`buildLibrarianPrompt`).

Task given to the model: for each input fact `{id, title, body, tags}`, return

```json
{
  "classifications": [
    { "id": "fact_…", "okf_type": "slug", "edges": [ { "edge_type": "…", "target_title": "…" } ] }
  ],
  "ontology_updates": { "node_types": [...], "edge_types": [...] }
}
```

- The strict/emergent split rides on the existing `ontologyModeInstructions`
  appendix: strict mode instructs manifest-types-only (no `ontology_updates`);
  emergent mode permits proposals. No new mode logic.
- The model may omit a fact it cannot classify — omission is the "no suitable type"
  signal, mirroring the librarian's leniency.
- `promptOverride` and a `PromptOverrides.ontologyBackfillSystemPrompt` global
  override are supported, consistent with every other prompt in the package.

### 5. Persistence: one transaction, existing validators, no new semantics

Inside `db.withTransactionAsync`:

1. `getEffectiveState(entityId, tx)`; in emergent mode with `ontology_updates`
   present → `mergeEmergentUpdates` first (manifest grows before validation, same
   order as the librarian).
2. Build the title index from **all live typed facts for the entity** via a new
   lightweight `EntryRepository.findTitleIndexByEntityId(entityId, tx)` selecting
   only `id, title, okf_type` (not `SELECT *`), filtered to
   `okf_type IS NOT NULL`. The librarian's
   `findRecentByEntityId(…, 100)` window is wrong here: it returns the 100 most
   *recently updated* facts, while the backfill batch is the *oldest* — an old
   fact's edge targets are its contemporaries, which a recent-100 window would
   miss and silently drop. Three columns across even thousands of local rows is
   cheap in SQLite. (Full breadth helps only *already-typed* targets — an untyped
   out-of-batch target still fails the target-type check, so untyped rows are
   excluded from the SQL index outright; batch facts typed during the run are
   re-added to the in-memory index. Deferred edges to untyped targets belong to
   the edge-backfill in Out of Scope. Oldest-first batching mitigates by
   clustering contemporaries into the same batch.)
3. Per classification: resolve the fact by `id` against the selected batch (unknown
   ids counted in `failedValidation`); `validateAndNormalizeFact` → canonical
   `okf_type` (on success `updateOkfType`, update the title index entry with the
   new type, queue edges) or null (counted in `failedValidation`).
4. After **all** classifications are applied: `resolveAndPersistEdges` per typed
   fact (existing duplicate-ignoring insert, existing source/target type checks
   against the manifest). Two-phase ordering matters — the target-type check reads
   `okf_type` from the title index, so intra-batch edges only resolve once every
   batch fact has its new type. Same apply-then-link ordering as the librarian's
   `pendingEdges`.
5. `markOntologyChecked(scannedIds, entityId, now, tx)` — every scanned fact gets
   its cooldown stamp, typed or not (Decision 3b). Never touches `updated_at`.

After commit: `searchService.evictCache(entityId)`. No re-embed — title/body
unchanged. No FTS re-sync — `okf_type` is not in the search index.

`countUntypedByEntityId` after the write transaction supplies
`remaining` (eligible) and `deferred` (in cooldown).

### 6. Failure semantics

- LLM call failure or unparseable JSON → throw (after lock release via `finally`).
  Hosts treat it like a failed librarian run: non-fatal, report, retry on next
  trigger. No partial writes — nothing persists outside the transaction.
- Per-item validation failures never abort the run; they are reflected in counts.

---

## Host adoption (Clanker — documented here, implemented in the Clanker repo)

After each entity sync completes (both sync paths: `characterSyncService`
`runRemoteSync` items and `useCharacterWiki.sync`), call:

```ts
try {
  await wiki.runOntologyBackfill(entityId)
} catch (err) {
  reportWikiOpForCharacter(err, `wiki:${entityId}:ontology:backfill`, entityId, 'Ontology backfill failed')
}
```

- Runs after `importDump` has landed remote facts, so cloud-agent writes are typed
  within one sync cycle (≤25/run; `remaining > 0` simply waits for the next sync).
- `WikiBusyError` is expected under concurrency and safe to swallow silently — the
  next sync retries.
- Cost profile: one `wikiLlm` call only when untyped facts exist; otherwise one
  SELECT (Decision 3).

---

## Test Plan

New suite `packages/core/__tests__/ontologyBackfill.test.ts`:

1. **Types untyped facts.** Seed manifest (strict) + untyped facts; fake
   `llmProvider` returns valid classifications. Assert `okf_type` persisted, edges
   created, counts correct.
2. **No-LLM early exits.** (a) mode `off`, (b) zero untyped facts — assert
   `llmProvider.generateText` never called and zeroed result returned.
3. **Additive guarantees.** Fact typed concurrently between select and update
   (simulate via pre-typed row in the model response): `updateOkfType`'s
   `okf_type IS NULL` guard leaves it untouched. Existing facts never deleted or
   rewritten; fact count invariant across the run.
4. **Emergent merge order.** Model proposes `ontology_updates` introducing a new
   node type used by a classification in the same response — assert merge happens
   first and the classification validates against the grown manifest.
5. **Strict mode rejects unknown types.** Classification with a non-manifest type →
   fact stays `NULL`, counted in `failedValidation`, cooldown-stamped (moves to
   `deferred`, not `remaining`).
6. **Batch cap.** 30 untyped facts, model types all it receives → exactly one LLM
   call carrying 25 facts (oldest first), `scanned = 25`, `remaining = 5`.
7. **Payload guard.** Facts with large bodies exceeding
   `ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS` → batch truncated below `batchSize`; a
   single oversized fact is still sent alone.
8. **Intra-batch edges.** Two untyped facts in one batch, edge from one to the
   other via `target_title` — assert edge persists (title index includes batch).
9. **Full title index breadth.** Old untyped fact proposes an edge to an old,
   *already-typed* fact outside the recent-100 window (seed >100 newer facts) —
   assert edge persists. Guards the recency-trap fix in Decision 5.
10. **Recheck cooldown.** Run where the model omits a fact → immediate second run
    selects nothing (`scanned = 0`, `deferred = 1`, no LLM call); after advancing
    past `ONTOLOGY_BACKFILL_RECHECK_MS`, the fact is selected again. Host
    convergence loop (`while remaining > 0`) terminates with unclassifiable facts
    present.
11. **Cooldown stamp never touches `updated_at`.** After a skip,
    `updated_at` is byte-identical — guards the import-merge last-write-wins
    hazard (Decision 3b).
12. **Malformed model output.** Unparseable JSON → throws, lock released, no rows
    changed (including no cooldown stamps); unknown fact ids → counted in
    `failedValidation` without error.
13. **Lock discipline.** Concurrent `runOntologyBackfill` throws `WikiBusyError`;
    sequential run after completion succeeds.

Existing suites must pass unchanged — the pass is opt-in and touches no existing
code paths beyond additive repository methods, one additive schema migration
(`ontology_checked_at`, nullable, no backfill of the column itself), and a new
prompt export. Migration tests follow the existing migrations suite pattern
(fresh DB + upgrade-from-previous-version both get the column).

---

## Release

- `feat(core): ontology backfill pass for untyped facts` → semantic-release minor on
  `core-llm-wiki`; `expo-llm-wiki` picks up via dependency bump. README gains a
  short "Ontology backfill" subsection under the existing ontology docs (when to
  call it, cost model, `remaining` convergence contract).
- Clanker adoption ships separately in the Clanker repo after the package release
  (dep bump + post-sync trigger + `reportError` tag), per the usual
  package-first rollout order.

---

## Out of Scope (v1)

- **Edge backfill for already-typed facts.** "Zero edges" is not a defect signal
  (many facts legitimately relate to nothing), so the work queue never converges
  without new bookkeeping (e.g. `edges_checked_at`). Revisit if traversal proves
  sparse for reasons attributable to failed edge resolution.
- **Multi-call backlog loops.** Hosts can loop on `remaining > 0` themselves; the
  library stays single-call-per-run. Revisit if convergence over normal sync
  cadence is too slow in practice.
- **React hooks.** No component consumer exists; triggers live in host service
  code. Add a hook when interactive UI (e.g. a "rebuild memory graph" button)
  needs one.
- **Server-side extraction in host agents** (Option B from the Clanker
  investigation) — superseded by this library-level pass.

## Errata (2026-11-19 — PR #425, issue #381)

- **§4 signature amended:** `buildOntologyBackfillPrompt` now takes a fourth
  parameter, `titleCatalog?: string`. When present (and the template carries
  no `{{facts}}`/ontology placeholders), a TITLE CATALOG block is spliced
  between the base prompt and the ontology appendix.
- **§5 amended:** the title index is now read a **second** time per pass,
  outside the transaction (`findTitleIndexByEntityId(entityId)`), to build
  that catalog — resolution still reads it inside each batch's tx, so a node
  deleted/retyped between the two reads makes a listed title unresolvable
  (verifiable as of prompt-build time). The block is deduped last-wins on
  `normalizeTitleKey`, capped at 200 entries and 8000 characters, sorted in
  UTF-16 code-unit order, with truncation disclosed in-prompt.
- **Data scope (owner-ruled):** typed node titles now leave the device to
  the provider on each backfill call. Kurt ruled this acceptable 2026-11-19
  as a temporary scope; the accepted ctx-window architecture (Proposal A,
  records/investigations/2026-11-19-consult-ctx-windows-s1) narrows the
  catalog to per-fact shortlist scope in a follow-up PR, superseding this.
  Diagnosis and measured evidence live in `specs/statement-kinds/spec.md`
  (Errata) — that spec's test-plan covers the generative path.

## Errata (2026-11-19 UTC — PR1 metering lane; Proposal A step 2)

**Errata status: implemented by [PR #428](https://github.com/equationalapplications/expo-llm-wiki/pull/428) — unshipped until merge.** The
amendments below are unshipped until that PR merges. PR #428 carries both
this errata and the implementation (one-PR lifecycle). The spec's
`Implemented` status covers only the original spec and the PR #425 errata.

The accepted Proposal A migration lives in the EA Curated Thoughts vault —
a records store outside this repo, so the path below does not resolve from
the tree: `records/investigations/2026-11-19-consult-ctx-windows-s1/verdict-pass2-system-one.md`,
§Migration step 2. That ruling requires a `fix:` PR first. This errata
governs that PR. Four amendments follow. All file:line evidence below was
re-verified against the tree at `ae52abbd` on 2026-11-19 (UTC).

### E1. Classifier calls are metered

**Problem (verified).** `_runClassifierBackfill` calls `provider.classify`
directly (`packages/core/src/services/MaintenanceService.ts:2250`). This path
sits outside `callLlm` (`packages/core/src/utils/llmCall.ts`), the only
metered path. It records no usage and emits no `llm_usage` diagnostic.
`ClassifyResponse` (`packages/core/src/types.ts:784-786`) has no field to
carry usage. Provider-reported usage exists — Curated Thoughts' Jev fixture
returns it (`curated-thoughts/src-tauri/src/inference/classifier.rs:750`).
Rule 7 (INTENT): nothing spends the allowance invisibly.

**Amendment.**

- `ClassifyResponse` gains `usage?: { inputTokens: number; outputTokens: number }`.
- `utils/llmCall.ts` gains one shared wrapper, `callClassify(options, ctx,
  request): Promise<ClassifyResponse>`. It must wrap the `provider.classify`
  call (not run after it): pre-flight the input estimate against the meter
  the way `callLlm` does; make the call; record provider-reported usage when
  present and well-formed (export `validUsage` — module-private in
  `llmCall.ts` today — and reuse it; `callClassify` lives in the same
  module, and E4's benchmark wrapper imports it from the package entry if
  it needs it); estimate otherwise (input = chars/4 over state
  plus instructions; output = chars/4 over the serialized answers); emit the
  `llm_usage` diagnostic when `reportLlmUsage === true`, with the caller's
  `WikiDiagnosticOperation` (the backfill site passes `'ontologyBackfill'`).
  Every future `classify` call site must go through this wrapper.
- **Meter plumbing (verified absent today):** `runOntologyBackfill` and
  `doRunOntologyBackfill` take no meter, the generative backfill calls
  `callLlm` with no meter (`MaintenanceService.ts:2113`), and the
  maintenance scheduler never runs backfill (its job set is `librarian`,
  `heal`, `reembed`, `externalDeletions`). So the public
  `runOntologyBackfill` options gain `tokenBudget?: number`; the pass
  builds `new UsageMeter(tokenBudget)` — the scheduler's per-run pattern
  (`MaintenanceScheduler.ts:109`) — and threads it to both the classifier
  wrapper and the generative `callLlm` call. No host-reachable budget
  today means the budget-stop branch below is otherwise dead code.
- **Budget-stop semantics (verified swallow today):** the per-fact
  `try/catch` turns any throw into `classification_invalid` /
  `classify_threw` (`MaintenanceService.ts:2248-2253`). A
  `WikiBudgetExhausted` must NOT take that path. The stop must: halt new
  classify launches and WAIT for every in-flight call to settle before the
  write transaction runs; persist the settled outcomes — successes stamp
  as today; a settled `WikiBudgetExhausted` joins the un-attempted set;
  any other settled throw keeps today's `classify_threw` path — and leave
  unlaunched facts unstamped, with no cooldown stamp and no
  `classification_invalid` diagnostic. This matches the `runBatched`
  contract, which keeps earlier results and surfaces un-attempted items
  unskipped (`BoundedLlmCall.ts:323-330`). The halt is a shared stop flag
  each task checks before calling `callClassify` — `withConcurrency`
  itself takes plain task functions and has no cancel path, so it stays
  unchanged. An un-attempted fact (unlaunched, or stopped by a settled
  budget error) is excluded from `scanned` — the field counts facts sent
  to the model — and stays in `remaining`, keeping the
  `scanned − typed − failedValidation` arithmetic intact. The pass reports
  the stop as
  `budgetStop?: { requiredEstimate: number }` — a new field on
  `OntologyBackfillResult` (`types.ts:129`), copying heal's field and
  loop-guard doc comment (`types.ts:242`): a host loop runs while
  `remaining > 0 && !budgetStop`, else a fixed budget never converges.
  The generative path reports the same way: lift `runBatched`'s
  `budgetStop` into `OntologyBackfillResult.budgetStop`, and never
  cooldown-stamp `unattempted` facts.
- **Overshoot honesty:** the pre-flight checks the input estimate only
  (`llmCall.ts:29-31`); the meter records real input plus output
  (`usage.ts:39`). Overshoot is therefore bounded only by in-flight
  concurrency (`chunkConcurrency`), not by any estimate.
- **Early probe (metered):** on the FIRST context-overflow error, `extract.ts`
  runs one minimal-prompt probe before the halving/segmentation retry tree,
  memoized once per pass and metered like every other model call (INTENT
  rule 7: one token budget). A succeeding probe lets the retry tree proceed;
  an overflowing probe throws immediately, so a fixed-prompt overflow costs
  two calls, not several hundred (resolves issue
  [#429](https://github.com/equationalapplications/expo-llm-wiki/issues/429);
  replaces the former all-skipped unmetered probe and its accepted deferral —
  Sonnet T1.5 xhigh delta review, cycle 2, 2026-11-19). Meter exhaustion on
  the probe surfaces as a `budgetStop` upstream, never a cooldown stamp.
- **`skipped` count:** the classifier return's `skipped` count deliberately
  mixes stamped `overflow_skip` facts (retried next pass) with unstamped
  `threw` facts (not retried this lane), per the `types.ts` doc comment.

### E2. Input-overflow errors are classified deterministically

**Problem (verified).** `TRUNCATION_PATTERNS` and `EXCEEDS_LIMIT_PATTERN`
(`packages/core/src/services/BoundedLlmCall.ts:37-51`) do not match common
provider input-overflow phrasings ("prompt is too long", "maximum context
length exceeded"). `runBatched` then treats such an error as a transient
`call_error` at batch size 1 — no cooldown stamp, so the same oversized batch
retries every pass — and throws it at batch size > 1, which kills the whole
pass.

**Amendment.**

- `BoundedLlmCall.ts` gains `isContextOverflowError(err)` with a documented
  pattern set. The overflow check must run before the truncation check and
  the config check.
- A corpus test must lock the patterns against real provider messages
  (OpenAI/vLLM, Anthropic, llama.cpp, Gemini, Bedrock wording). The corpus
  must lock two deliberate rulings:
  - OpenAI's blended message — "maximum context length is N tokens.
    However, you requested M tokens (A in the messages, B in the
    completion)" — classifies as overflow: the overflow check runs first,
    and shedding input context is the safe remedy.
  - vLLM's dual-match message — "`max_tokens` … is too large … maximum
    context length is N" — matches both a truncation pattern and the
    overflow set, and its cause is really a config error. It classifies as
    overflow anyway: the overflow check runs first, so the outcome is a
    split or a cooldown skip, not propagation. Recorded as deliberate. The
    regex enforces the dual-match: the bare `max_tokens is too large`
    message (no context clause) is ruled NOT overflow and surfaces as a
    config error.
  - Anthropic's "input length and `max_tokens` exceed context limit"
    message is a second deliberate dual-match ruling, same style as the
    vLLM one: it matches both a truncation pattern and the overflow set,
    and classifies as overflow because the overflow check runs first.
- `runBatched` must treat overflow at batch size > 1 as a split trigger.
  This needs three `onFailure` edits, all spelled out here:
  - The escalation gate at `BoundedLlmCall.ts:254` becomes
    `fromCall && (isContextOverflowError(err) ? supportsEscalation : isTruncationError(err)) && attemptLevel < 3`
    — both existing guards stay. Dual-match messages skip after one call for
    opted-out callers (overflow wins over truncation at the gate).
  - The give-up reason at `BoundedLlmCall.ts:271` must classify overflow as
    `non_convergent` at every ladder level — today's expression
    (`!isTruncationError && !isConfigError` → `call_error`) would stamp no
    cooldown and retry the identical overflow every pass.
  - The re-throw at `BoundedLlmCall.ts:281` must exempt overflow, or the
    split path never runs.
- **Escalation is gated (verified dead today for two of three callers):**
  only heal's `buildPrompt` sheds context per ladder level
  (`MaintenanceService.ts:1773`); ontology backfill and ops resolve pass
  `buildPrompt` functions that ignore `attemptLevel`, so escalating them
  re-sends a byte-identical prompt and overflows again. `RunBatchedArgs`
  gains `supportsEscalation?: boolean`. Overflow at batch size 1 escalates
  the ladder only when the caller opts in (heal does); otherwise it skips
  immediately as `non_convergent` with the cooldown stamp and a new
  diagnostic code, `context_overflow_skipped` — a new member of the
  `WikiDiagnosticCode` union (`packages/core/src/types.ts:866`; the
  `skipped[].reason` value stays `'non_convergent'` — the skip-reason
  unions at `types.ts:212` and `BoundedLlmCall.ts:151` are a different
  type and gain nothing). Existing
  truncation escalation is unchanged (compat lock).
- Behavior change, accepted with Proposal A: an overflow skip now takes the
  cooldown stamp. Today's `call_error` skip does not.

### E3. Ops-extract overflow cannot stall the librarian

**Problem (verified).** An overflow inside `runExtract` throws and keeps the
watermark (`packages/core/src/services/librarian/ops/index.ts:46-53`). Every
later pass re-sends the same oversized batch. The librarian never advances.

**Amendment (consult §4).**

- New overflow-driven retry logic must wrap the extract call. The existing
  halving loop at `ops/extract.ts:60-66` is a pre-flight estimator — it runs
  only when a meter budget is set and never catches errors — so the retry
  must be new code around `runExtract` (or in `ops/index.ts:46-53`) and
  must halve the batch on an overflow-shaped error independent of
  `meter.budget`.
- **Watermark follows the batch actually extracted.** The pass advances the
  watermark from the extracted outcome's batch (`ex.batch`), not from
  `sel.batch` (`ops/index.ts:101` today) — events in a dropped half are
  otherwise skipped silently, which breaks conservation.
- **Segmented events are all-or-nothing.** A lone oversized event splits
  into labeled segments (`e1#1`, `e1#2`, …) extracted in separate calls —
  one call holding all segments would overflow again. Either every segment
  extracts, or the event is skipped with `context_overflow_skipped` and the
  watermark advances — deterministic overflow is not a budget stop; the hold
  result remains reserved for `WikiBudgetExhausted`. A segment-label → event-id map must
  back the `byLabel` lookup that resolves `source_event` (`extract.ts:80`,
  `:107-110`), and the grounding corpus must map each segment to its
  corpus part.
- **Resolve overflow needs no new work:** E2 already covers it — resolve is
  an opted-out `runBatched` caller, so an overflow splits at batch size
  > 1 and skips as `non_convergent` with the cooldown stamp at size 1. No
  stall, no new code.
- Conservation: every event must end up extracted, budget-stopped, or
  skipped with a diagnostic. None may disappear. When the pass cannot
  extract ANY event — the fixed prompt part (ontology context, guidance)
  alone overflows the window — the pass throws visibly and holds the
  watermark: a config-shaped failure must surface, not silently drain the log.

### E4. Benchmarks can see classifier calls

**Problem (verified).** The `CallSite` union
(`packages/benchmarks/src/instrument.ts:9`) has no `classify` entry, and the
recorder would stay at zero even with one: `instrument()` only wraps
`generateText` and `generateTextWithUsage` and buckets them by system-prompt
regex (`instrument.ts:4-7`, `:56-61`, `:81-119`) — `provider.classify` has
no system prompt and never reaches a bucket. System One cost and latency
would read as zero, which looks like a measurement. Rule 11 (INTENT) bars
claims until measurement exists.

**Amendment.**

- Add `'classify'` to the `CallSite` union and to the recorder's site list,
  plus every exhaustive consumer (verified: `report.ts:95`,
  `longmemeval/run.ts:188-189`; `compare.ts` iterates keys and needs no
  edit; `promptVolume.ts` uses a `Partial` record and needs no edit).
- `instrument()` must wrap `classify` when the provider has one: time the
  call, record it under `'classify'`, use `response.usage` when valid, and
  fall back to the same estimate rule as E1. A test must prove the
  `'classify'` bucket is non-zero with a classifier present.
- The benchmark provider gains an optional classifier endpoint, configured
  by `BENCH_CLASSIFIER_URL`, `BENCH_CLASSIFIER_MODEL` and
  `BENCH_CLASSIFIER_KEY` (its own key; when unset, no Authorization
  header is sent). The scripted
  provider used by tests (`scriptedProvider.ts`, which keys on the system
  prompt today) must gain a `classify` stub so the non-zero-bucket test
  needs no real endpoint.
- Add a `BENCH_CONTEXT_TOKENS` passthrough so a runner can simulate a small
  window.

### Test plan (delta)

- Metering: provider-reported usage wins; the fallback estimate applies when
  usage is absent; the meter debits; the diagnostic emits under
  `reportLlmUsage` with operation `'ontologyBackfill'`; a pass with no
  `tokenBudget` still emits estimates and records usage without a cap.
- Budget stop: `WikiBudgetExhausted` at the classify site halts new
  launches and waits for in-flight calls to settle. Two tests: (a) a stub
  throws `WikiBudgetExhausted` on call 2 (injected, NOT meter-driven —
  with concurrency 4 every task pre-flights the same meter state before
  any records, so a real meter cannot produce this shape) with
  concurrency 4 — calls 1, 3, and 4 all settle and persist; (b) a real
  meter with a pinned budget (concretely: the full request estimate —
  state plus instructions — of the smallest fact's call) and differing
  input sizes per fact, where later
  pre-flights fail `fits()` and land unattempted. Both: completed
  outcomes persist (stamped), unlaunched facts
  unstamped, `budgetStop` set on `OntologyBackfillResult` — no
  `classification_invalid` diagnostic, no cooldown on unattempted facts,
  unattempted facts excluded from `scanned` and still counted in
  `remaining`. A host loop `while (remaining > 0 && !budgetStop)`
  terminates. The generative path
  gets the same coverage: `runBatched`'s `budgetStop` and `unattempted`
  lift into `OntologyBackfillResult` with no cooldown stamps.
- Overflow corpus: each corpus message classifies as overflow, and as
  neither truncation nor config error; the blended OpenAI message and the
  vLLM dual-match message classify as overflow.
- `runBatched`: overflow at batch size > 1 splits (the `:281` re-throw
  exempts overflow); overflow at batch size 1 escalates only for an opt-in
  caller and lands `non_convergent` with the cooldown stamp at every level
  including L3 give-up (`:271` covers overflow); opted-out callers skip
  immediately with the `context_overflow_skipped` diagnostic; no infinite
  retry; truncation behavior unchanged.
- Ops extract: an overflowing batch halves without a meter budget; the
  watermark advances to the batch actually extracted; a lone oversized
  event segments all-or-nothing and the label map resolves `source_event`;
  conservation holds.
- Benchmarks: the `'classify'` bucket records non-zero calls, tokens, and
  ms with a classifier present.
- When no overflow occurs, existing prompt snapshots stay byte-identical
  (REQ-COMPAT lock).

### Out of scope

- Ingest chunk re-splitting (Proposal A PR7, `context.budget`).
- `contextWindowTokens`, `classifyLimits`, and the `systemOne.*` config
  surface (Proposal A PR2 and later).
- Curated Thoughts Rust changes (`classifier.rs`) — CT owns them.
