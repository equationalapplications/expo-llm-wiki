# Spec: Ontology Backfill — Typing Facts That Bypassed the Librarian

**Date:** 2026-07-13
**Status:** Proposed
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
  options?: { promptOverride?: string },
): Promise<OntologyBackfillResult>

export interface OntologyBackfillResult {
  scanned: number;     // untyped facts sent to the model this run
  typed: number;       // facts that received an okf_type
  edgesAdded: number;  // edges persisted
  remaining: number;   // untyped facts still in the store after this run
}
```

- Lock discipline identical to siblings: `runOntologyBackfill` acquires a JobManager
  lock (new `OperationType` member `'ontologyBackfill'`), delegates to
  `doRunOntologyBackfill`, releases in `finally`. Concurrent invocation throws
  `WikiBusyError`; transactions serialize on the shared connection per the
  2026-07-09 transaction-serialization spec.
- `remaining` lets hosts implement their own convergence policy (re-trigger later,
  show progress) without the library baking in a loop.

### 2. Selection: `okf_type IS NULL`, oldest first, batch of 25

New repository methods:

```ts
// EntryRepository
findUntypedByEntityId(entityId: string, limit: number, tx?: SQLiteAdapter): Promise<WikiFact[]>
  // WHERE entity_id = ? AND okf_type IS NULL AND deleted_at IS NULL
  // ORDER BY updated_at ASC LIMIT ?
countUntypedByEntityId(entityId: string, tx?: SQLiteAdapter): Promise<number>
updateOkfType(id: string, entityId: string, okfType: string, tx: SQLiteAdapter): Promise<void>
  // UPDATE ... SET okf_type = ? WHERE id = ? AND entity_id = ? AND okf_type IS NULL
```

- Batch size is a named constant `ONTOLOGY_BACKFILL_BATCH_SIZE = 25` — one LLM call
  per run, bounded cost. First-run backlogs (pre-ontology facts) converge across
  repeated triggers rather than bursting.
- Oldest-first (`updated_at ASC`) so long-neglected facts are typed before recent
  ones and the queue drains deterministically.
- `updateOkfType` guards `okf_type IS NULL` in the WHERE clause so a concurrent
  writer can never be overwritten — additive by construction, not by convention.
- Facts whose type the model omits or that fail validation remain `NULL` and will
  be re-selected next run. Acceptable: the model gets fresh manifest context each
  time, and repeated hard failures surface in `scanned − typed` for host telemetry.

### 3. Early exits make the pass free when there is nothing to do

`doRunOntologyBackfill` returns `{scanned: 0, typed: 0, edgesAdded: 0, remaining: 0}`
without an LLM call when:

- ontology mode is `'off'` for the entity (via `getEffectiveState`), or
- `findUntypedByEntityId` returns zero rows.

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
2. Build the title index from `findRecentByEntityId(entityId, 100, tx)` **plus the
   batch facts themselves**, so edges may target other facts in the same batch.
3. Per classification: resolve the fact by `id` against the selected batch (unknown
   ids ignored); `validateAndNormalizeFact` → canonical `okf_type` or null; on
   success `updateOkfType`, update the title index entry with the new type, and
   queue edges.
4. After **all** classifications are applied: `resolveAndPersistEdges` per typed
   fact (existing duplicate-ignoring insert, existing source/target type checks
   against the manifest). Two-phase ordering matters — the target-type check reads
   `okf_type` from the title index, so intra-batch edges only resolve once every
   batch fact has its new type. Same apply-then-link ordering as the librarian's
   `pendingEdges`.

After commit: `searchService.evictCache(entityId)`. No re-embed — title/body
unchanged. No FTS re-sync — `okf_type` is not in the search index.

`countUntypedByEntityId` after the write transaction supplies `remaining`.

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
   fact stays `NULL`, appears in `remaining`.
6. **Batch cap.** 30 untyped facts, model types all it receives → exactly one LLM
   call carrying 25 facts (oldest first), `scanned = 25`, `remaining = 5`.
7. **Intra-batch edges.** Two untyped facts in one batch, edge from one to the
   other via `target_title` — assert edge persists (title index includes batch).
8. **Malformed model output.** Unparseable JSON → throws, lock released, no rows
   changed; unknown fact ids → ignored without error.
9. **Lock discipline.** Concurrent `runOntologyBackfill` throws `WikiBusyError`;
   sequential run after completion succeeds.

Existing suites must pass unchanged — the pass is opt-in and touches no existing
code paths beyond additive repository methods and a new prompt export.

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
