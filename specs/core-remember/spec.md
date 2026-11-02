# `WikiMemory.remember()` — store one mutable fact directly, without an LLM step

**Status:** Implemented (2026-11-01, PR #308)
**Date:** 2026-11-01
**Branch:** `feat/core-remember`
**Source baseline:** `5ecd716` (v7.13.1 + PR #306)
**Intent check:** Rule 1 (bring your own inference) — `remember()` makes no `generateText` call; its only model call is the optional `embed`, through the host's `LLMProvider`, exactly as `supersede()` does today. Rule 5 (documents are immutable) — `remember()` can only create `user_stated` / `user_confirmed` facts, never `immutable_document`. Rule 6 (honest reporting) — nothing is clipped or coerced silently: bad input throws, embedding failures surface through the existing `embedding_failed` diagnostic with a new `operation: 'remember'`. Rule 7 (no invisible spend) — `remember()` never starts the librarian or heal, in `'auto'` or `'deferred'` mode, and never touches the event count or checkpoints. Rule 10 — this spec carries the Status line; it flips in the PR that ships the code.

**Delivery:** one PR (`feat/core-remember`), draft until implemented, per `specs/README.md`. Additive and non-breaking: the release is a 7.x minor (`feat(core):` commits → semantic-release minor, expected 7.14.0 unless another minor lands first). Nobody edits `CHANGELOG.md` or any `"version"` field.

**Downstream consumer:** SynapseTree's `POST /v1/memory/facts` (`rememberFact`, `openapi/openapi.yaml` L697-769), marked `x-synapsetree-engine: upstream:remember` and answering `501` until this ships (SynapseTree contract design 2026-09-30, Q4 L663-666 and ruling L726-728). SynapseTree #137 tracks the five unwired operations. Sequencing ruled by the owner: (1) this PR merges and releases; (2) SynapseTree bumps the engine and wires `rememberFact` plus four other ops; (3) expo-llm-wiki PR #305 (MCP server, whose `memory_remember` tool calls `rememberFact`) merges after.

---

## 1. Problem

The engine has no way to store a single mutable fact on request. Today the only paths that create a `user_stated` / `user_confirmed` fact are (survey on SynapseTree branch `spec/wire-memory-operations`, `evidence/data-plane-survey.md` L137-143, re-verified here):

- `supersede(entityId, oldId, { title, body, … })` — creates the fact, but requires an existing fact to retire (`packages/core/src/services/TemporalService.ts` L50-99);
- the librarian, from events, which costs an LLM call and only runs when a threshold is crossed or the host calls `runPendingMaintenance()`;
- `importDump()`, which is replace-semantics bulk import, not a single write.

`write()` is not a fact write: it records an event (`packages/core/src/services/WriteService.ts` L39-89) and, in `'auto'` mode, may start a background librarian/heal job (L96-163). A host that wants "store this fact now, no model" has nothing to call.

SynapseTree's contract already promises that call (`RememberRequest` → `201 Fact`), and the MCP server's `memory_remember` tool is built on it (expo-llm-wiki PR #305 spec, `specs/mcp-server/spec.md` on main (L431, L442 in the pre-move copy)). Both are blocked on this method.

## 2. Root cause (with evidence)

Not a bug: a missing entry point. The competitive-memory spec (`docs/superpowers/specs/2026-09-29-competitive-memory-design.md` §4.3) added `supersede()`/`history()` for the replace case and left the create case to the librarian. SynapseTree's contract design asked the question explicitly ("Should v1 expose only events … or should core add `remember(entityId, fact)`?", Q4) and ruled "request `remember()` upstream" (Q4/Q10).

What the hosted consumer needs, from the survey and the contract, and what today's nearest APIs do:

| Need | Today | Evidence |
|---|---|---|
| Create one mutable fact, no model | Only via `supersede()` with an existing target | `TemporalService.ts` L50-99 |
| Get the stored fact back (contract returns `Fact`) | `supersede()` returns `{ newId }` only; `write()` returns `void` | `TemporalService.ts` L98, `WriteService.ts` L39; survey L155, L166 |
| No background LLM work (hosted LLM slot is inert; D11) | `write()` in `'auto'` mode starts librarian/heal; `supersede()` does not | `WriteService.ts` L96-163; SynapseTree contract design D11 L412-422; survey L272-273 |
| Nothing clipped silently (contract limits ≠ engine clip) | `write()` clips `summary` at 4000 vs the contract's 8000 | `WriteService.ts` L50; survey L167 |
| Own transaction, safe to call from a request handler | `supersede()` opens its own `withTransactionAsync` | `TemporalService.ts` L84-92; survey L211 |

## 3. Proposed change

### 3.1 Public API (additive)

```ts
// packages/core/src/types.ts (new, exported via `export * from './types'`)
export interface RememberInput {
  title: string;                                   // required; non-empty after trim
  body: string;                                    // required; any string, '' allowed
  tags?: string[];                                 // default []
  confidence?: WikiFact['confidence'];             // default 'certain'
  source_type?: 'user_stated' | 'user_confirmed';  // default 'user_stated'
  okf_type?: string | null;                        // default null; resolved against the entity's ontology (§3.4)
  valid_from?: number;                             // epoch ms; default absent (= since created_at)
}

// packages/core/src/WikiMemory.ts
/**
 * Store one mutable fact directly, with no LLM step. One transaction; the
 * returned fact is the stored row read back (`id`, timestamps, defaults and
 * the read-time `isStale` / `trustTier` included). To replace an existing
 * fact use `supersede()` so history is kept. Never starts librarian or heal.
 * Cannot be called inside a host transaction (serialized adapter mutex).
 */
async remember(entityId: string, input: RememberInput): Promise<WikiFact>
```

Field names follow the engine's snake_case fact model (`WikiFact`, `types.ts` L469-549) and `SupersedeReplacement` (`types.ts` L1368-1377), not the contract's camelCase; SynapseTree maps at its edge as it does for every other call (`src/data-plane/query-memory.ts` `toContractFact` L148-184).

### 3.2 Validation (throws `TypeError`, nothing written)

| Field | Rule | Why this rule |
|---|---|---|
| `entityId` | non-empty string, ≤ 200 chars, no `\0` | Same rule `write()` enforces (`WriteService.ts` L39-43). `supersede()` enforces none; `remember()` adopts the stricter one. The check moves to a shared `assertEntityId()` helper that `write()` also calls (message unchanged). |
| `input` | non-null object, not an array | As `write()` (L44-46). |
| `title` | `string`, `trim() !== ''`; stored verbatim (not trimmed) | Same as `supersede()`'s object form (`TemporalService.ts` L59-61). |
| `body` | `string`; `''` allowed; stored verbatim | Same as `supersede()` (L59). The contract's `RememberRequest.body` has `minLength: 1` (`openapi.yaml` L3113); SynapseTree enforces that at its edge, like every other request-shape rule. The engine stays consistent with `supersede()` and `upsertGraph` (`body ?? ''`). |
| `tags` | absent, or an array whose every element is a `string`; stored verbatim (no trim, no lowercasing, no cap) | `supersede()` silently coerces a non-array to `[]` (L65); `remember()` throws instead (rule 6). Verbatim storage matches `supersede()`; `validateTags()` (`utils/pure.ts` L822-829: lowercase, ≤ 40 chars, max 6) is the librarian's rule for LLM output, not the host's. |
| `confidence` | absent, or one of `'certain' \| 'inferred' \| 'tentative'` | `supersede()` applies `?? 'certain'` without checking the value (L66); `remember()` rejects an unknown value. |
| `source_type` | absent, or `'user_stated' \| 'user_confirmed'` | Matches the contract's `RememberRequest.sourceType` enum (`openapi.yaml` L3119-3122). Narrower than `SupersedeReplacement`, which also allows `'librarian_inferred'` — see open question Q2. `'immutable_document'` is never accepted (rule 5). |
| `okf_type` | absent, `null`, or a `string` | Resolution rule in §3.4. |
| `valid_from` | absent, or a finite number ≥ 0 (`assertEpochMs`, `utils/temporal.ts` L32-37); truncated to an integer | Same as `supersede()`'s `replacement.valid_from` (L78-80). |

**No length caps and no clipping.** The engine imposes no title/body/tag length limits in `remember()`, matching `supersede()` and `upsertGraph`. The contract's limits (`title ≤ 1000`, `body ≤ 100000`, `tags ≤ 100 × ≤ 100`; `openapi.yaml` L3112-3117) are SynapseTree's edge rules. This is deliberate: `write()`'s hidden 4000-char clip is the mismatch the survey flagged (L167, L277); `remember()` must not create a second one. If the owner wants engine-side hard caps, see Q1.

### 3.3 Storage and transaction

One `db.withTransactionAsync` (as `supersede()`, `TemporalService.ts` L84-92):

1. Build the `WikiFact` literal exactly as `supersede()`'s object form does (L62-74): `id = generateId('fact_')` (`utils/ids.ts` L24), `source_hash: null`, `source_ref: null`, `created_at = updated_at = now`, `last_accessed_at: null`, `access_count: 0`, `deleted_at: null`, plus `okf_type` from §3.4. OKF v0.2 metadata is not supplied, so `EntryRepository.upsert` binds its INSERT defaults (`lifecycle_status: 'stable'`, `generated_by: null`, empty `okf_sources` / `okf_verified`; `EntryRepository.ts` L325-332).
2. `entryRepo.upsert(fact, tx)` (L242-375). A fresh random id never collides in practice; the same holds for `supersede()`.
3. If `valid_from` was given: `entryRepo.setTemporal(id, entityId, { valid_from }, tx)` (L979-998). `upsert` does not write temporal columns, so this second statement is required, as in `supersede()` (L86-88).
4. Read the row back inside the transaction: `entryRepo.findByIds([id], [entityId], tx)` (L166-192). This goes through `mapRowToFact` (L55), which hydrates `isStale` and `trustTier` (L99-100) and omits `embedding_blob`. The read-back is the return value, so the host gets stored fields and defaults without a second round trip. A missing row here means the adapter dropped the write; throw an `Error` (same stance as `upsert`'s own guard, L342-353).

After commit, in this order (mirrors `supersede()`, L94-101):

5. `searchService.syncEntries(entityId, [id])` — the fact is keyword-searchable before `remember()` resolves.
6. `embeddingService.embedFact({ id, entity_id, title, body, tags }, { operation: 'remember', trigger: 'call' })` — see §3.5.
7. `searchService.evictCache(entityId)`.
8. Return the fact read in step 4. It does not reflect step 6; `WikiFact` has no embedding field on read paths anyway.

If step 1–4 throw, the transaction rolls back and nothing is written (`supersede()` test "leaves no partial writes on rejection", `__tests__/supersede.test.ts` L81-86, is the model).

**Host-transaction caveat.** Like `write()` and `supersede()`, `remember()` opens its own transaction and must not be called inside `withTransactionAsync` or a host `writeAndReindex`-style wrapper (survey L211; the serialized adapter mutex would deadlock). Documented in the JSDoc and README.

**Outbox.** With `enableOutbox` (`types.ts` L336), `upsert` pushes one `entries` INSERT row (L372-378) and `setTemporal` pushes one UPDATE row when `valid_from` is set (L993-997). No new outbox shapes.

### 3.4 `okf_type` resolution

Reuse the rule `upsertGraph` applies to a host-supplied node `type` (`IngestionService.ts` L604-623 → `OntologyService.validateAndNormalizeFact`, `OntologyService.ts` L103-128), inside the same transaction, before the upsert:

- `okf_type` absent or `null` → stored `null`. No manifest read.
- Otherwise read the entity's effective ontology state with `ontologyService.getEffectiveState(entityId, tx)` (L51) and resolve the slug case-insensitively against `manifest.node_types` (`utils/ontology.ts` `resolveNodeType` L17-22):
  - found → the manifest's canonical slug is stored;
  - not found and mode is `'strict'` → throw `WikiStrictOntologyViolation(entityId, 'node', okf_type)` (`types.ts` L1089-1099); nothing is written;
  - not found and mode is `'emergent'` or `'off'` → stored `null`, exactly as `upsertGraph` does today. `runOntologyBackfill` can type it later.

This is the engine's existing rule for direct writes, chosen over `importDump`'s verbatim storage (`ImportExportService.ts` L301) because `remember()` is a live write against a possibly strict manifest, not a bundle restore. The non-strict "unknown type → null" branch is silent today for `upsertGraph` nodes too; whether `remember()` should instead keep the string, or report the drop, is open question Q3.

### 3.5 Embedding

`embedFact` is the existing compute-then-store path (`EmbeddingService.ts` L249-258 → L122-184, L193-215):

- no `llmProvider.embed` → `no_provider`, nothing marked, no diagnostic (L138); the fact is keyword-only. If an `embed` function appears later, `getPendingMaintenance().reembedPending` (`MaintenanceScheduler.ts` L60) counts it and `runPendingMaintenance` / `runReembed` embeds it;
- `embed` present → one call; failure is marked on the row and reported as `embedding_failed` with `operation: 'remember'`, `trigger: 'call'`; `remember()` still resolves with the stored fact.

`WikiDiagnosticOperation` (`types.ts` L834-835) gains the member `'remember'`. Additive, like `'supersede'` and `'prune'` before it.

**Client-supplied vectors are out of scope here.** The contract's `RememberRequest.embedding` (`openapi.yaml` L3124) is handled on the SynapseTree side the way it already is for `upsertGraph` nodes — the engine's wire format has no embedding field there either, and SynapseTree writes the vector itself after the engine write (`src/data-plane/upsert-graph.ts` L17-18, L173 → `embedding-fingerprint.ts` `writeClientVector` L198-208). The SynapseTree contract design's refinement 2 (L764-766) lists `remember` among the vector inputs to request upstream; that request is deferred — see Q4.

### 3.6 Maintenance side effects: none

- No event row is written. `remember()` never touches `llm_wiki_events`, the librarian watermark, the memory/heal checkpoints or `JobManager`. (Contrast `write()`, `WriteService.ts` L85-163.)
- Behaviour is identical under `config.maintenance: 'auto'` and `'deferred'` (`types.ts` L384). `drain()` after `remember()` resolves immediately (nothing in flight).
- `getPendingMaintenance()` is unchanged by a `remember()` except `reembedPending`, which can become `true` when an `embed` function exists and step 6 failed (§3.5).
- The new fact is a mutable fact like any other: a later heal pass may review it (`findHealCandidatesByEntityId` excludes only `immutable_document`, `EntryRepository.ts` L646-663), `supersede()` may retire it, `forget({ entryId })` deletes it, and `history(entityId, id)` returns `[fact]` until it is superseded. These are existing behaviours, stated here so the host is not surprised.

### 3.7 Idempotency: SynapseTree's concern, not the engine's

`remember()` is **not** idempotent: two identical calls store two facts with different ids. The engine has no idempotency-key concept anywhere, and the contract's `Idempotency-Key` header (`openapi.yaml` L1993-2003) is ruled to live in SynapseTree's tenant-side `st_idempotency` table (contract design Q12 L733; survey §7 L253-267 documents the shipped `idempotencyReplay`). Because `remember()` opens its own transaction, SynapseTree's replay record is written after the engine write, as it already is for `importMemory` (survey L267). No engine change.

### 3.8 Errors

| Condition | Thrown | Written? |
|---|---|---|
| Any §3.2 rule | `TypeError` | no |
| Unknown `okf_type` under `'strict'` | `WikiStrictOntologyViolation` (`code: 'WIKI_STRICT_ONTOLOGY_VIOLATION'`) | no |
| Adapter/transaction failure | the adapter's error, e.g. `WikiTransactionError` | no (rolled back) |
| Read-back finds no row | `Error` (adapter dropped the write) | n/a |
| `embed` fails | nothing thrown; `embedding_failed` diagnostic, row marked | yes (fact stored) |

No new error class. SynapseTree maps `TypeError` → `400`/`422` and `WikiStrictOntologyViolation` → its existing ontology problem code; that mapping is SynapseTree's follow-up, not this spec's.

### 3.9 Where the code lives

- `packages/core/src/services/RememberService.ts` (new): `remember()`; constructed with `db`, `entryRepo`, `ontologyService`, `searchService`, `embeddingService`. `TemporalService` keeps "supersession and history" as its single purpose; it is not modified.
- `packages/core/src/utils/entityId.ts` (new): `assertEntityId(entityId)` — the `write()` rule, moved; `WriteService.write` calls it (behaviour and message unchanged).
- `packages/core/src/utils/rememberInput.ts` (new, pure): `normalizeRememberInput(entityId, input, now): { fact: WikiFact; validFrom?: number; okfType: string | null }` — all §3.2 checks and the fact literal, with no I/O, so the rules are unit-testable without a database.
- `packages/core/src/WikiMemory.ts`: construct the service (next to L159), expose `remember()` next to `supersede()`/`history()` (L862-874), add `rememberService` to `WikiMemoryTestAccess` (L68-80, L240-270).
- `packages/core/src/types.ts`: `RememberInput`; `'remember'` in `WikiDiagnosticOperation`.

## 4. Files touched

| File | Change |
|---|---|
| `packages/core/src/types.ts` | add `RememberInput`; add `'remember'` to `WikiDiagnosticOperation` |
| `packages/core/src/utils/entityId.ts` | new: `assertEntityId` |
| `packages/core/src/utils/rememberInput.ts` | new: `normalizeRememberInput` |
| `packages/core/src/services/RememberService.ts` | new: `RememberService.remember` |
| `packages/core/src/services/WriteService.ts` | `write()` calls `assertEntityId` (no behaviour change) |
| `packages/core/src/WikiMemory.ts` | wire `RememberService`; public `remember()`; test access |
| `packages/core/__tests__/rememberInput.test.ts` | new: pure validation tests |
| `packages/core/__tests__/remember.test.ts` | new: integration tests (§5) |
| `packages/core/README.md` | new section "Direct fact writes (`remember`)" before "Temporal facts" (L70); one bullet under "Deferred maintenance" (L117-144) saying `remember()` never schedules work; "Diagnostics" (L703-725) mentions `operation: 'remember'` |
| `docs/synapsetree-integration.md` | add `wiki.remember(entityId, input)` → `memory_remember` row to the §6 table (L159-168), schema shipped: **No** |
| `specs/core-remember/spec.md` | Status → Implemented in the final cleanup commit (which also deletes `plan.md` and `LEDGER.md`) |

Not touched: `CHANGELOG.md`, any `package.json` version, `packages/core-llm-tools` (no tool schema for `remember`; the host-defined wrapper pattern of `docs/synapsetree-integration.md` §6 applies), `TemporalService.ts`, PR #305's worktree.

## 5. Test plan

Runner: vitest, from the repo root. One file: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/remember.test.ts`; core suite: `pnpm --filter @equationalapplications/core-llm-wiki test`; types: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`. Fixtures follow `__tests__/supersede.test.ts` (`openTestDatabase`, `new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } })`, raw SQL inspection of `llm_wiki_entries`).

`rememberInput.test.ts` (pure, no DB):
1. Defaults: `{ title, body }` → `tags: []`, `confidence: 'certain'`, `source_type: 'user_stated'`, `okf_type: null`, `source_ref`/`source_hash` `null`, `access_count: 0`, `created_at === updated_at === now`, id starts with `fact_`.
2. Every §3.2 rejection, one `it.each` row per rule (bad entityId ×4, non-object input, empty/whitespace/non-string title, non-string body, non-array tags, non-string tag element, bad confidence, `source_type` `'immutable_document'` / `'librarian_inferred'` / garbage, `valid_from` negative / NaN / string, non-string non-null `okf_type`) → `TypeError`.
3. Verbatim storage: untrimmed title and mixed-case tags are preserved; `valid_from` is truncated.

`remember.test.ts` (integration):
4. Stores and returns the row: returned fact matches `SELECT` of the row and equals `findByIds([id], [entityId])`; `lifecycle_status: 'stable'`, `trustTier: 'unverified'`, `isStale: false`, no `valid_from` key when not given.
5. `valid_from` round-trip: stored column equals the input; returned fact carries it; `read(entityId, q, { asOf: valid_from - 1 })` excludes the fact and `read(entityId, q)` includes it.
6. `source_type: 'user_confirmed'` and explicit `confidence`/`tags` are stored as given.
7. No partial writes: a rejected call leaves `COUNT(*)` of `llm_wiki_entries` unchanged (TypeError case and strict-ontology case).
8. No events, no background work: with `config.autoLibrarianThreshold: 1`, `autoHealThreshold: 1` and a `generateText` spy, three `remember()` calls then `drain()` → spy never called, `llm_wiki_events` empty, `getPendingMaintenance([entityId])` is `[]`. Repeat under `maintenance: 'deferred'`.
9. Keyword-searchable immediately: `read(entityId, '<unique token from the body>')` returns the fact right after `remember()` resolves, with no `embed` configured.
10. Embedding: with `embed` present, called once with text containing title and body and `embedding_blob` is set; with `embed` throwing, `onDiagnostic` receives `{ code: 'embedding_failed', operation: 'remember', trigger: 'call', entityId, detail: { factId, reason: 'embed_threw' } }` and `remember()` still resolves; without `embed`, `embedding_failed_at` stays `NULL`.
11. `okf_type`: seeded manifest with node type `Person`; `'person'` → stored `'Person'` under `'emergent'`; unknown type under `'strict'` → `WikiStrictOntologyViolation`, no row; unknown type under `'off'`/`'emergent'` → `null`; absent → `null` and `getEffectiveState` not consulted (spy on `metadataRepo.getManifest`).
12. Plays with the temporal API: `supersede(entityId, rememberedId, { … })` succeeds; `history(entityId, rememberedId)` is `[remembered, replacement]`; `forget(entityId, { entryId })` deletes it.
13. Outbox: with `enableOutbox: true`, one `entries` INSERT event whose payload `id` matches, plus one UPDATE event when `valid_from` is given.
14. `write()` regression: existing `__tests__/write.test.ts` and `deferredWrite.test.ts` still pass after the `assertEntityId` extraction (no new test; the suite is the check).

Acceptance: all of the above green; core suite has no new failures; `typecheck` exit 0; `pnpm run build` succeeds; the published `dist/index.d.ts` exports `RememberInput` and `WikiMemory.remember`.

## 6. Open questions for the owner

Each has a default the plan implements; a different ruling changes the spec before the affected task runs.

- **Q1 — engine-side hard caps.** Default: none (consistent with `supersede()`/`upsertGraph`; the contract's `title ≤ 1000` / `body ≤ 100000` / `tags ≤ 100 × ≤ 100` are SynapseTree's edge rules). Alternative: the engine throws `TypeError` above those limits so every host gets them. Recommendation: none; a cap the engine enforces for one host becomes a silent contract for all of them.
- **Q2 — `source_type: 'librarian_inferred'` via `remember()`.** Default: rejected (the contract's enum is `user_stated | user_confirmed`). `SupersedeReplacement` allows it, so a host replaying its own extraction could want it. Recommendation: keep rejected until a host needs it.
- **Q3 — unknown `okf_type` outside strict mode.** Default: stored as `null` (the `upsertGraph` rule). Alternatives: keep the string verbatim (the `importDump` rule; the contract calls `okfType` "open"), or null plus a new content-free diagnostic (rule 6). The silent-null branch already exists for `upsertGraph`, so this is not a new silence, but it is the first time an agent-supplied type hits it (MCP `memory_remember` passes `okfType` straight through).
- **Q4 — client-supplied vector input.** Default: not in this PR; SynapseTree writes client vectors itself as it does for `upsertGraph` nodes. The contract design's refinement 2 names `remember` among the vector inputs to request upstream; if the owner wants `remember({ embedding })` in the engine now, it needs its own dimension/fingerprint rules and is a separate spec section.
- **Q5 — `body: ''`.** Default: allowed (engine-consistent). The contract rejects it at the edge. Say if the engine should too.

## 7. Evidence

Re-verified on `5ecd716` (expo-llm-wiki) and SynapseTree `main` @ `a0ae9c7` plus branch `origin/spec/wire-memory-operations` on 2026-11-01; every `file:line` above was read, not inferred. Key pointers:

- `packages/core/src/WikiMemory.ts` L646-648 (`write`), L651-653 (`drain`), L862-874 (`supersede`, `history`), L159 (`TemporalService` wiring), L68-80 and L240-270 (`WikiMemoryTestAccess`).
- `packages/core/src/services/TemporalService.ts` L13-19, L50-99.
- `packages/core/src/services/WriteService.ts` L39-50 (validation and 4000-char clip), L85-163 (deferred branch, auto librarian/heal).
- `packages/core/src/repositories/EntryRepository.ts` L55 and L99-100 (`mapRowToFact` hydration), L166-192 (`findByIds`), L242-380 (`upsert`, defaults at L325-332, guard at L342-353, outbox at L372-378), L646-663 (heal candidates), L979-998 (`setTemporal`).
- `packages/core/src/services/EmbeddingService.ts` L20-23, L122-184, L193-215, L249-258; `MaintenanceScheduler.ts` L42-62.
- `packages/core/src/services/OntologyService.ts` L51, L103-128; `IngestionService.ts` L604-623; `utils/ontology.ts` L17-22.
- `packages/core/src/types.ts` L336, L384, L469-549, L812-835, L1089-1099, L1355-1377.
- `packages/core/src/utils/ids.ts` L24, `utils/pure.ts` L816-829, `utils/temporal.ts` L32-37.
- `packages/core/README.md` L70-93, L117-144, L703-725; `docs/synapsetree-integration.md` L155-170.
- SynapseTree `openapi/openapi.yaml` L697-769 (`rememberFact`), L1993-2003 (`IdempotencyKey`), L2381-2384 (`Namespace`), L2522-2572 (`FactBase`), L2615-2644 (`UserStatedFact`, `MutableFactFields`), L3106-3124 (`RememberRequest`).
- SynapseTree `docs/superpowers/specs/2026-09-30-openapi-contract-design.md` L412-422 (D11), L663-666 (Q4), L726-728 (Q4/Q10 ruling), L733 (Q12), L734-746 (Q13), L756-766 (refinement 2), L775 (refinement 5).
- SynapseTree `specs/2026-11-01-wire-memory-operations/evidence/data-plane-survey.md` (branch `spec/wire-memory-operations`) L8, L137-172, L211, L253-267, L271-280.
- SynapseTree `src/data-plane/query-memory.ts` L148-184 (`toContractFact`), `src/data-plane/pool-main.ts` L227 (`wikiOptions`), `src/data-plane/upsert-graph.ts` L17-18, L173, `src/data-plane/embedding-fingerprint.ts` L198-208.
- expo-llm-wiki PR #305 worktree, `specs/mcp-server/spec.md` on main (L431, L442 in the pre-move copy) (read only).
