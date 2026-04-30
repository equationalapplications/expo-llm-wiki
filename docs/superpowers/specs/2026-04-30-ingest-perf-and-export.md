# Spec: Ingest Performance, Job Coordination, and Memory Export

**Date:** 2026-04-30
**Status:** Implemented
**Approach:** A (performance-first) + targeted job-tracking fixes + export

---

## Problem

Current `ingestDocument()` has three real costs and one correctness gap:

1. **Slow chunking regex.** The splitter at `WikiMemory.ts:600` uses `/[.!?]\s+(?![\s\S]*[.!?]\s+)/`. The `[\s\S]*` lookahead rescans the remaining string at every position, giving O(n²) behavior on large chunks.
2. **Sequential LLM loop.** The `for (const chunk of chunks)` loop at `WikiMemory.ts:616` calls the provider one chunk at a time. Each chunk is independent — wall-clock cost scales linearly with chunk count.
3. **No chunk overlap.** Facts straddling a boundary are silently lost.
4. **Conservative `maxChunkLength` default (6000).** Most providers can handle far more, so the system makes more LLM calls than necessary.

Separately, job coordination has two bugs:

5. **Mutex collision.** `runLibrarian` and `runHeal` both use `${prefix}:${entityId}` as their job key, so a manual heal call is silently dropped while a librarian pass is running, and vice versa.
6. **No ingest guard.** `ingestDocument` has no `activeIngestJobs` check. Two concurrent calls for the same `(entityId, sourceRef)` race on the same row delete + insert.

Maintenance ops (`runLibrarian`, `runHeal`) also `return` silently when busy with no signal to the caller.

Finally, there is no way to export memory for backup, debugging, or a developer dashboard.

---

## Goals

- 3–5× wall-clock speedup on multi-chunk ingest.
- No silent data loss across chunk boundaries.
- Concurrent ingest for the same entity is safe.
- Maintenance ops do not block each other; busy callers get a typed signal.
- A platform-agnostic export API the app can serialize to ZIP / share / re-import.

## Non-Goals

- Reactive/subscribable entity status (event emitter, push notifications to React). A synchronous snapshot getter is in scope; reactive subscriptions are deferred.
- xState or any state-machine framework in `WikiMemory`.
- Bundling a ZIP library or filesystem code in this package.

---

## Design

### Phase 1 — Chunking (correctness + perf)

Replace the regex-with-lookahead splitter with a deterministic walker that prefers paragraph breaks first, sentence breaks second, hard cut last.

New private helper in `WikiMemory.ts`:

```typescript
function chunkText(
  text: string,
  maxChunkLength: number,
  overlap: number
): { chunks: string[]; truncated: boolean }
```

Algorithm (no regex lookaheads):

1. Trim input. Empty → `{ chunks: [], truncated: false }`.
2. Walk the text. At each step, examine `slice(cursor, cursor + maxChunkLength + 1)`:
   - If the remaining text fits in `maxChunkLength`, push it and stop.
   - Else find the best split point in the search window, in priority order:
     1. Last `\n\n` (paragraph break) at index ≥ `maxChunkLength / 2`.
     2. Last sentence terminator (`.`, `!`, `?` followed by whitespace) at index ≥ `maxChunkLength / 2`. Implementation: scan the window with a single left-to-right pass tracking the most recent terminator index — no lookahead.
     3. Last whitespace at index ≥ `maxChunkLength / 2`.
     4. Hard cut at `maxChunkLength` (set `truncated = true`).
   - Push `safeSlice(text, cursor, splitPoint)`.
   - Advance: `cursor = max(splitPoint - overlap, cursor + 1)`. The `+1` guard prevents infinite loops on pathological inputs.
3. The "≥ half" floor avoids producing tiny chunks when a break appears very early in the window.

Overlap is computed in characters and applied as the prefix of the next chunk. `overlap = 0` reproduces the current non-overlapping behavior.

### Phase 2 — Parallelize LLM calls

Replace the `for (const chunk of chunks)` loop with `Promise.all(chunks.map(...))`. Each chunk's prompt + parse + `validateFact` filter is independent and produces its own `ExtractedFact[]`. Results are concatenated in chunk order before the single transactional DB write (preserving deterministic ordering of inserted facts).

Errors from any chunk reject the whole call, matching today's fail-fast behavior. No partial writes (the DB transaction only runs after all chunks resolve).

### Phase 2b — Cross-chunk fact dedup

After all chunk results are collected and before the DB write, deduplicate by normalized title.

Normalization: `title.trim().toLowerCase().replace(/\s+/g, ' ')`.

Algorithm: walk `allValidFacts` in chunk order, keep the first occurrence of each normalized title, drop subsequent ones. First-wins keeps it deterministic; the librarian pass already handles richer conflict resolution against the existing DB.

This only dedups within a single `ingestDocument` call. It does not compare against existing DB rows.

### Phase 3 — Defaults and config

- `WikiConfig.maxChunkLength` default: **6000 → 12000**.
- `WikiConfig.chunkOverlap` (new): default **400**, minimum 0, must be `< maxChunkLength`.
- `ingestDocument` accepts per-call `maxChunkLength` and `chunkOverlap` overrides, validated the same way as today.
- `INGEST_SYSTEM_PROMPT` body budget: **200 → 800 chars**. `validateFact` (or equivalent) updated to enforce the new limit. Title budget unchanged at 80.
- `HEAL_SYSTEM_PROMPT` body budget: **200 → 800 chars** to stay consistent with ingest output.

### Phase 4 — Ingest job guard

Add `private activeIngestJobs = new Set<string>()` to `WikiMemory`.

Job key: `` `${this.prefix}:${entityId}:${sourceRef}` ``.

`ingestDocument`:

- If key already in set → throw `WikiBusyError` (new, see "Errors" below).
- Otherwise add key, run, remove in `finally`.

Rationale: keying on `(entityId, sourceRef)` lets the app ingest two different documents for the same entity in parallel (a real use case) while preventing the duplicate-source race.

### Phase 5 — Maintenance mutex split

Change job keys in `_doRunLibrarian`, `_doRunHeal`, `runLibrarian`, `runHeal`, and the auto-trigger in `write()`:

- Librarian: `` `${this.prefix}:${entityId}:librarian` ``
- Heal: `` `${this.prefix}:${entityId}:heal` ``

`runLibrarianThenMaybeHeal` continues to take both keys in sequence (it owns both phases).

The public `runLibrarian()` / `runHeal()` methods change their busy behavior:

- Today: `if (busy) return;` (silent).
- New: `if (busy) throw new WikiBusyError(operation, entityId);`

The auto-trigger inside `write()` keeps the silent-skip behavior (it is fire-and-forget by design and must never throw into the write path).

### Phase 5b — Synchronous entity status snapshot

New public method:

```typescript
getEntityStatus(entityId: string): {
  ingesting: boolean;   // any active ingest job for this entity (any sourceRef)
  librarian: boolean;   // librarian job in flight
  heal: boolean;        // heal job in flight
}
```

Implementation: scan `activeIngestJobs` and `activeMaintenanceJobs` Sets for keys matching the entity's prefix. Synchronous, no I/O, safe to call from React render.

Reactive subscriptions (event emitter, hook-based push updates) are out of scope. Apps that want live updates can poll this getter — a ~10-line custom hook in user code, no library support needed.

### Phase 6 — Memory export (and import)

#### Types (`src/types.ts`)

```typescript
export interface MemoryDump {
  generatedAt: number;
  entities: Record<string, MemoryBundle>;
}

export interface FormattedMemoryDump {
  manifest: string; // JSON.stringify(MemoryDump, null, 2)
  files: Array<{ name: string; content: string }>; // one .md per entity
}
```

#### `WikiMemory.exportDump(entityIds?: string[]): Promise<MemoryDump>`

- If `entityIds` omitted: query distinct `entity_id` values across non-deleted entries, tasks, and events.
- For each entity: reuse the existing `getMemoryBundle(entityId)` (or its underlying queries) so tag JSON parsing and deletion filters stay consistent.
- Returns a `MemoryDump` with `generatedAt = Date.now()`.

#### `formatMemoryDump(dump: MemoryDump): FormattedMemoryDump`

Pure function exported from `src/index.ts`. No DB, no I/O, no platform deps.

- `manifest`: `JSON.stringify(dump, null, 2)`.
- `files`: one entry per entity, named `${entityId}.md`, content matches the format in the brainstorm doc (Facts with title/tags/confidence/source/body, Tasks as checkboxes, Recent Events).

#### `WikiMemory.importDump(dump: MemoryDump, opts?: { merge?: boolean }): Promise<void>`

- `merge: false` (default): for each entity, call `forget(entityId, { clearAll: true })`, then insert all facts/tasks raw.
- `merge: true`: insert only facts/tasks whose `id` does not already exist for that entity.
- Events are always inserted as new (append-only).
- Direct DB writes — no LLM calls. All fields preserved (`confidence`, `source_type`, `source_hash`, `source_ref`, timestamps).
- Wrapped in a single `db.withTransactionAsync` per entity.

#### React hook `src/react/useWikiExport.ts`

```typescript
function useWikiExport(): {
  exportDump: (entityIds?: string[]) => Promise<MemoryDump>;
  isExporting: boolean;
  error: Error | null;
}
```

Uses the existing `useWikiContext()`. Caller handles ZIP / sharing / file system.

Exported from `src/react/index.ts`.

---

### Errors

New error class in `src/types.ts` (or a new `src/errors.ts` if preferred):

```typescript
export class WikiBusyError extends Error {
  readonly operation: 'ingest' | 'librarian' | 'heal';
  readonly entityId: string;
  constructor(operation, entityId) {
    super(`${operation} already running for entity ${entityId}`);
    this.name = 'WikiBusyError';
    this.operation = operation;
    this.entityId = entityId;
  }
}
```

Exported from `src/index.ts`. Callers can `instanceof`-check it.

---

## API Surface Changes

Additive only. No breaking changes to existing public methods except the busy semantics of `runLibrarian()` / `runHeal()` (silent return → `WikiBusyError`). Document this in the changelog under BREAKING for the maintenance methods.

| Symbol | Kind | Status |
|---|---|---|
| `WikiConfig.chunkOverlap` | new field | additive |
| `WikiConfig.maxChunkLength` default | 6000 → 12000 | behavior change |
| `WikiMemory.exportDump` | new method | additive |
| `WikiMemory.importDump` | new method | additive |
| `formatMemoryDump` | new export | additive |
| `MemoryDump`, `FormattedMemoryDump` | new types | additive |
| `WikiBusyError` | new export | additive |
| `useWikiExport` | new hook | additive |
| `WikiMemory.getEntityStatus` | new method | additive |
| `INGEST_SYSTEM_PROMPT` body budget 200 → 800 | prompt change | behavior change |
| `HEAL_SYSTEM_PROMPT` body budget 200 → 800 | prompt change | behavior change |
| `runLibrarian()` / `runHeal()` busy → throw | semantics change | breaking |

---

## Files Touched

- `src/WikiMemory.ts` — chunker rewrite, parallel ingest, dedup, ingest guard, mutex split, `getEntityStatus`, export/import methods.
- `src/prompts.ts` — raise body budget in `INGEST_SYSTEM_PROMPT` and `HEAL_SYSTEM_PROMPT`.
- `src/types.ts` — `MemoryDump`, `FormattedMemoryDump`, `WikiBusyError`, `WikiConfig.chunkOverlap`, `EntityStatus`.
- `src/utils/formatMemoryDump.ts` — new pure helper.
- `src/index.ts` — export new types, helper, error class.
- `src/react/useWikiExport.ts` — new hook.
- `src/react/index.ts` — export new hook.

No new runtime dependencies.

---

## Testing

Unit (no LLM):

- `chunkText`: empty, single-paragraph short, multi-paragraph, paragraph longer than `maxChunkLength` (falls back to sentence), no breaks at all (hard cut, `truncated: true`), overlap correctness (next chunk's prefix matches previous chunk's suffix), no infinite loop on pathological input (single huge token), perf sanity check on a 200 KB input completing in well under one second.
- `formatMemoryDump`: empty dump, multiple entities, special chars in title/body escaped correctly in Markdown.
- `importDump`: `merge: false` clears then inserts; `merge: true` skips existing ids; events always appended.
- `WikiBusyError`: `runLibrarian` while one is in flight throws; second `ingestDocument` for same `(entityId, sourceRef)` throws; different `sourceRef` does not.
- `getEntityStatus`: returns all-false when idle; reports `ingesting: true` mid-ingest, `librarian: true` mid-librarian, `heal: true` mid-heal; unaffected by other entities' jobs.

Integration (mock `LLMProvider`):

- `ingestDocument` with N chunks issues N parallel calls (assert via mock call timing or a counter).
- All facts from all chunks land in DB in chunk order.
- Cross-chunk dedup: two chunks emitting facts with same normalized title result in one row.
- One chunk failing rejects the whole call with no partial writes.
- Body budget: `validateFact` accepts a 800-char body, rejects 801.
- `runHeal` and `runLibrarian` for the same entity can run concurrently after the mutex split.

---

## Rollout

Single release. Phases above are the implementation order, not separate releases. Document the breaking change to `runLibrarian` / `runHeal` busy semantics and the `maxChunkLength` default bump in the changelog.

---

## Out of Scope (Deferred)

- Reactive entity status (event emitter / push updates to React). Synchronous `getEntityStatus()` ships in this release; subscriptions can come later if real demand emerges.
- ZIP packaging or `expo-sharing` integration (caller's responsibility).
