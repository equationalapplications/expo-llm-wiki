# Spec: Memory Hardening

**Date:** 2026-04-29  
**Status:** Implemented

---

## Problem

The current implementation makes several optimistic assumptions: LLMs return well-formed JSON inside expected bounds, the heal pass can be trusted to protect `immutable_document` entries, and FTS queries are always well-formed. A 45-round-reviewed production implementation of the same pattern reveals eighteen concrete failure modes and improvements worth addressing.

---

> **Terminology note:** All deletions in this codebase are *soft-deletes* — the row's `deleted_at` is set rather than the row being removed. "Delete" throughout this spec means soft-delete unless explicitly stated otherwise.

---

## Proposed Changes

### 1. Robust LLM JSON Extraction

**Current:** `parseJsonResponse` strips markdown fences then calls `JSON.parse`. Fails if the LLM emits any text before `{` (e.g. "Here is the JSON:" or a leading newline in some models).

**Fix:** Find the first `{` or `[`, then walk the string tracking nesting depth (honouring string literals and escape sequences) to find the true matching close bracket. This correctly handles nested objects — `lastIndexOf` would produce wrong results for any response where a nested `}` appears after the outermost one.

```typescript
function parseJsonResponse<T>(text: string): T {
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');

  let start: number;
  let openChar: string;
  let closeChar: string;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace; openChar = '{'; closeChar = '}';
  } else if (firstBracket !== -1) {
    start = firstBracket; openChar = '['; closeChar = ']';
  } else {
    throw new SyntaxError('No JSON object found in LLM response');
  }

  let depth = 0, inString = false, escape = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) { depth++; continue; }
    if (ch === closeChar) { depth--; if (depth === 0) { end = i; break; } }
  }

  if (end === -1) throw new SyntaxError('No JSON object found in LLM response');
  return JSON.parse(text.slice(start, end + 1)) as T;
}
```

No behavioral change for well-formed responses. Survives preamble text from chatty models.

---

### 2. LLM Output Field Validation

**Current:** LLM-returned strings are inserted directly. A misbehaving LLM (or prompt injection in a document chunk) can exceed column length constraints or send wrong types.

**Fix:** Add a `clip(value, maxLength)` helper and validate every field from LLM output before any DB write.

```typescript
function clip(value: string, max: number): string {
  const s = value.trim();
  return s.length <= max ? s : s.slice(0, max).trimEnd();
}
```

**String fields — clip policy:**

String fields are trimmed and clipped to schema bounds. Length overages are corrected by clipping rather than treated as fatal. Facts exceeding limits are kept after clipping.

- `title` → `clip(title, 80)`
- `body` → `clip(body, 200)`
- `description` (tasks) → `clip(description, 200)`

**Enum fields — coerce to safe default if invalid:**
- `confidence` → `'inferred'` if not `'certain' | 'inferred' | 'tentative'`
- `event_type` → `'observation'` if not one of the four valid values
- `priority` → `0` if not a finite number

**Required field check — drop + warn if missing or non-string:**
- Drop any fact where `title` or `body` is missing, not a string, or empty after trim.
- Do not drop on length alone — clip handles this.

**Tag validation:**
- Filter to strings only.
- Trim and lowercase each tag.
- Drop tags with length 0 or > 40 chars.
- Cap at 6 tags per fact.

Applies to: `runLibrarian`, `runHeal` (newFacts), `ingestDocument`.

---

### 3. `immutable_document` Facts as Read-Only Anchors in Heal LLM Prompt

**Current:** `runHeal` sends all non-deleted facts to the LLM, including `immutable_document` entries. The DB update layer then skips modifying them (correct), but they consume tokens and re-expose raw document body content on every heal pass.

**Fix:** Pass `immutable_document` facts in a dedicated **read-only anchors** section of the heal prompt, separated from mutable candidates. Strip the `body` field from document facts (title only) to reduce token exposure while preserving their identity for contradiction detection. The DB guard against mutating `immutable_document` rows remains unchanged.

```typescript
const healCandidates = allFacts.filter(f => f.source_type !== 'immutable_document');
const documentAnchors = allFacts
  .filter(f => f.source_type === 'immutable_document')
  .map(({ id, title, source_ref }) => ({ id, title, source_ref })); // body stripped
```

The prompt must clearly label document anchors as immutable context:

> "The following document anchors are provided for contradiction detection only. Do not include them in `downgraded`, `deleted`, or `newFacts`."

This allows heal to downgrade an inferred fact that contradicts a document anchor (e.g. "User lives in Boston" vs a document stating "I moved to NYC") while preventing inadvertent modifications.

**Heal ID validation:** Before issuing any `UPDATE` statements, filter `result.downgraded` and `result.deleted` to IDs present in `healCandidates`. This guards against the LLM hallucinating IDs or attempting to modify document anchors by ID.

```typescript
const mutableIds = new Set(healCandidates.map(f => f.id));
const safeDowngraded = result.downgraded.filter(id => mutableIds.has(id));
const safeDeleted = result.deleted.filter(id => mutableIds.has(id));
```

---

### 4. FTS Token Cap

**Current:** `formatSearchQuery` splits the query into tokens with no upper bound. A long query string creates an unbounded number of FTS terms.

**Fix:** Cap at 6 tokens, matching production behavior.

```typescript
const tokens = query
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, '')
  .split(/\s+/)
  .filter(t => t.length >= 3)
  .slice(0, 6);  // cap
```

---

### 5. Time-Based Stale/Orphan Heuristics in `runHeal`

**Current:** `runHeal` delegates all confidence downgrading and deletion decisions to the LLM. The LLM has no reliable sense of time — it cannot know a fact was last accessed 70 days ago unless told explicitly in the prompt, and even then may not act consistently.

**Fix:** Run a deterministic pre-pass before calling the LLM:

| Condition | Action |
|---|---|
| `access_count = 0` AND `created_at < now - orphanAfterDays` | Soft-delete (orphan — never used) |
| `last_accessed_at < now - staleInferredAfterDays` AND `confidence = 'inferred'` | Downgrade to `'tentative'` |

Both rules skip `source_type = 'immutable_document'` entries (immutable anchors).

The LLM heal pass then operates on the already-cleaned set, handling contradiction detection and semantic cleanup it is actually suited for.

**Decisions:**
- Thresholds are configurable via `WikiConfig` with sensible defaults. Set to `null` to disable:
  ```typescript
  orphanAfterDays?: number | null;        // default: 30; must be a finite number >= 0 or null
  staleInferredAfterDays?: number | null; // default: 60; must be a finite number >= 0 or null
  ```
- Invalid (negative or non-finite) values throw an error to prevent accidental mass deletion.
- Orphan rule uses `created_at`, not `updated_at`. This prevents clock resets from masking facts that have genuinely never been searched.
- Both rules fire on every `runHeal` call. No flag required.

---

### 6. Fuzzy Deduplication in `runLibrarian`

**Current:** `runLibrarian` always inserts new facts. If the LLM extracts a fact that is semantically equivalent to an existing one (e.g. "User likes hiking" vs "User enjoys hiking outdoors"), both are stored. Over time, duplicates accumulate and degrade read quality.

**Fix:** Before inserting a new fact, compute Jaccard similarity between its title tokens and existing fact title tokens. If similarity ≥ threshold **and** both titles meet the minimum token count, **skip insertion** rather than overwriting. Let `runHeal` resolve semantic duplicates via its contradiction/dedup pass.

```typescript
// Jaccard on lowercase word tokens (>= 3 chars)
function titleTokens(title: string): Set<string> { ... }
function jaccardScore(a: Set<string>, b: Set<string>): number { ... }
const FUZZY_THRESHOLD = 0.5;
const MIN_TOKENS_TO_QUALIFY = 3; // both title token sets must have size >= 3
```

**Decisions:**
- Minimum token count: both title token sets must have `size >= 3`. Two-word titles are too short for reliable matching.
- On a match, the new fact is **skipped** (not merged). Body content is not overwritten. This prevents Jaccard from silently merging contradictions (e.g. "User likes hiking" vs "User dislikes hiking" scores ≈0.67).
- Skip insertion only for `librarian_inferred` → `librarian_inferred` matches. Never suppress `user_stated` or `user_confirmed` facts.
- This runs in `runLibrarian` only. `ingestDocument` bypasses it — document facts use `sourceRef`-based idempotency instead.

---

### 7. `forget` Return Counts

**Current:** `forget()` returns `void`. The caller (and React hook) have no way to confirm how many rows were actually deleted.

**Fix:** Return a count object.

```typescript
// Before
async forget(...): Promise<void>

// After
async forget(...): Promise<{ deleted: { entries: number; tasks: number } }>
```

**Decisions:**
- This is an API-breaking change. See the [Migration / Compatibility](#migration--compatibility) section.
- The React `useWikiForget` hook exposes the result via a `lastResult` field. All mutation hooks adopt this pattern for consistency:
  ```typescript
  {
    execute: (...args) => Promise<TResult>;
    lastResult: TResult | null;
    isPending: boolean;
    error: Error | null;
  }
  ```

---

---

### 8. Per-Entity Maintenance Job Guard (Concurrency + Auto-Heal)

**Current:** `write()` fires `runLibrarian` as a fire-and-forget promise (`.catch(console.error)`). If `write()` is called rapidly — common in chat UIs — multiple librarian runs for the same entity overlap. Each sees a stale view of facts and inserts duplicates independently. `heal_checkpoint` exists in the `{prefix}checkpoints` table but is never written or read; `runHeal` is manual-only.

**Fix:** An instance-level `Set<string>` keyed by `${prefix}:${entityId}` tracks in-flight jobs per `WikiMemory` instance. Before starting any maintenance job for an entity, check the set. If already running, skip. Remove in `finally`.

```typescript
private activeMaintenanceJobs = new Set<string>();

// inside write(), before fire-and-forget:
const jobKey = `${this.prefix}:${entityId}`;
if (!this.activeMaintenanceJobs.has(jobKey)) {
  this.activeMaintenanceJobs.add(jobKey);
  this.runLibrarianThenMaybeHeal(entityId)
    .catch(console.error)
    .finally(() => this.activeMaintenanceJobs.delete(jobKey));
}
```

Auto-heal runs **sequentially after librarian completes**, within the same job lock. After librarian finishes, check `eventCount - heal_checkpoint`. If it exceeds `autoHealThreshold`, write the checkpoint and run heal before releasing the lock.

```typescript
// in WikiConfig:
autoHealThreshold?: number;  // default: 100, independent of autoLibrarianThreshold
```

**Decisions:**
- `autoHealThreshold` is an independent knob, not derived from `autoLibrarianThreshold`. Coupling to `5×` would create surprises when a user lowers the librarian threshold for testing.
- Sequential ordering (librarian → heal within the same lock) prevents a window where a new librarian run starts against state that heal is still processing.
- The guard applies to both auto-triggered and manually-called `runLibrarian`/`runHeal` for the same entity. Public methods acquire the same lock; if already in-flight, they return early (skip).
- Using an instance field (not module-level) means multiple `WikiMemory` instances with different prefixes or DBs do not interfere with each other.
- This is a single-process lock (`Set` on the instance). It does not protect against two app processes sharing the same SQLite file, which is an unsupported configuration for Expo SQLite.

---

### 10. Stale Checkpoint Reset

**Current:** After `forget({ clearAll: true })`, the `{prefix}checkpoints` row still holds the old `memory_checkpoint` count. The next `write()` computes `eventCount - checkpoint` as a large negative number — so the librarian never auto-triggers again for that entity. Silent, permanent breakage.

**Fix:** `forget({ clearAll: true })` must also reset both checkpoints to `0`.

```typescript
// in forget(), clearAll branch:
await this.db.runAsync(
  `UPDATE ${this.prefix}checkpoints SET memory_checkpoint = 0, heal_checkpoint = 0 WHERE entity_id = ?`,
  [entityId]
);
```

**Bonus edge case (same source):** If `memory_checkpoint > eventCount` for any other reason (e.g., checkpoint written, then events pruned by `pruneEventsAfter`), clamp to `0` at read time:

```typescript
const effectiveCheckpoint = checkpoint > eventCount ? 0 : checkpoint;
```

---

---

### 11. Document Chunking and Ingestion Results

**Current:** `ingestDocument` returns `void` and passes `documentChunk` directly to the LLM. A caller who passes a 200K document produces a single LLM call that blows the context window. There is no observable signal that splitting occurred.

**Fix (combined from original #11 and #15):** Implement internal chunking and return a result object.

```typescript
// Before
async ingestDocument(entityId, params): Promise<void>

// After
async ingestDocument(entityId, params): Promise<{ truncated: boolean; chunks: number }>
```

**Chunking algorithm:**
1. Attempt to split on sentence boundaries (`.`, `!`, `?` followed by whitespace).
2. If any resulting segment exceeds `maxChunkLength` characters, hard-split at that character limit.
3. Call the LLM once per chunk; insert each chunk's facts independently (no cross-chunk dedup — let `runHeal` consolidate).
4. Set `truncated: true` only if a hard-split was required. Sentence-boundary splits do not set `truncated`.

**Return semantics:**
- `chunks`: number of LLM calls made.
- `truncated: true`: at least one segment exceeded `maxChunkLength` characters and had to be hard-split. This indicates the input lacked adequate whitespace or sentence boundaries and the caller may want to pre-process the document.

**Decisions:**
- `maxChunkLength` lives in `WikiConfig` (default: `6000`, measured in UTF-16 code units / characters) and can be overridden per-call as an optional param on `ingestDocument`. Both.
- UTF-8/UTF-16 fully supported; surrogate pairs (emoji) are never fragmented at chunk boundaries (see `safeSlice` helper).
- Cross-chunk facts are inserted independently. Merging inside ingest reintroduces the fuzzy-dedup risks from #6.
- This is an API-breaking change. See the [Migration / Compatibility](#migration--compatibility) section.

---

### 12. Parallel Reads in `read()`

**Current:** `read()` fetches facts, tasks, and events with three sequential `await` calls.

**Fix:** `Promise.all` across all three queries. No logic change, pure latency reduction.

```typescript
const [facts, tasks, events] = await Promise.all([
  this.db.getAllAsync(/* FTS entries query */),
  this.db.getAllAsync(/* tasks query */),
  this.db.getAllAsync(/* events query */),
]);
```

No behavioral change. Access count update for FTS hits still runs after (unchanged).

---

### 13. `forget` Input Normalization

**Current:** `sourceRef` and `sourceHash` are passed raw from the caller directly into SQL `WHERE` clauses. No validation or sanitization.

**Fix:** Normalize both fields before use:

```typescript
// sourceRef: allowlist [A-Za-z0-9._\- ], trim, cap at 255, treat empty as null
// Matches production server normalization so client and server always agree.
function normalizeSourceRef(value: string): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^A-Za-z0-9._\- ]/g, '').trim().slice(0, 255);
  return cleaned.length > 0 ? cleaned : null;
}

// sourceHash: must be a valid 64-char hex SHA-256; discard otherwise
function normalizeSourceHash(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}
```

If `sourceHash` fails validation, throw an `Error` with a descriptive message. An invalid hash is a programming error (the caller was supposed to compute a SHA-256 hex digest), not a recoverable condition, so failing loudly is preferable to a silent no-op.

**Consistency requirement:** `normalizeSourceRef` must be applied on **both** the write path (`ingestDocument` before INSERT) and the read path (`forget` before WHERE clause). If normalization is only applied in `forget`, stored values and query values will diverge and `forget({ sourceRef })` will silently match zero rows.

---

### 14. Parallel Soft-Deletes in `forget`

**Current:** The `forget` branches (`entryId`, `taskId`, `sourceRef`, `clearAll`) run sequentially.

**Fix:** When multiple targets are provided (e.g. both `entryId` and `taskId`, or `sourceRef` + `sourceHash`), run their delete queries in parallel with `Promise.all`. Each is an independent `UPDATE … WHERE` with no data dependency.

```typescript
await Promise.all([
  entryIds.length > 0 ? this.db.runAsync(/* delete entries */) : Promise.resolve(),
  taskIds.length > 0 ? this.db.runAsync(/* delete tasks */) : Promise.resolve(),
  sourceRef ? this.db.runAsync(/* delete by sourceRef */) : Promise.resolve(),
]);
```

`clearAll` still runs its two deletes in parallel (entries + tasks). These are the same semantics, just faster.

---

---

### 15. *(Merged into #11)*

Document chunking and ingestion result shape are specified together in [#11](#11-document-chunking-and-ingestion-results).

---

### 16. Partial Index on `(entity_id, source_hash)`

**Current:** `setupDatabase` creates a `source_ref` index but no `source_hash` index. `forget({ sourceHash })` is a full table scan.

**Fix:** Add a partial index to `setupDatabase`:

```sql
CREATE INDEX IF NOT EXISTS ${prefix}entries_source_hash_idx
  ON ${prefix}entries(entity_id, source_hash)
  WHERE source_hash IS NOT NULL;
```

Partial index because `source_hash` is null for all non-document facts — indexing only non-null rows keeps it small.

---

### 17. Hash Full Document Before Chunking

**Current:** `ingestDocument` receives a `sourceHash` from the caller. No constraint on when/how the caller computed it.

**Fix:** Document (and enforce via convention) that `sourceHash` must be computed on the **full** document content before any chunking or truncation. If hashed post-chunk, the hash changes when chunk boundaries change, breaking re-ingest deduplication.

This is a caller contract, enforced by convention and API docs. The README example must reflect that `documentChunk` now accepts the full document (chunking is internal):

```typescript
const sourceHash = sha256(fullDocumentContent);
await wiki.ingestDocument(entityId, {
  sourceRef: 'docs/guide.md',
  sourceHash,          // hash of full content, before any chunking
  documentChunk: fullDocumentContent,  // pass the full document; package chunks internally
});
```

---

### 18. *(Merged into #13)*

The `sourceRef` allowlist (`[^A-Za-z0-9._\- ]` → strip) and the `typeof` guard on `normalizeSourceHash` are incorporated directly into [#13](#13-forget-input-normalization).

---

---

## 19. Migration / Compatibility

This spec introduces the following API-breaking changes that require a major or minor version bump depending on package stability:

| Change | Break |
|---|---|
| `forget()` return type `void` → `{ deleted: { entries: number; tasks: number } }` | Yes |
| `ingestDocument()` return type `void` → `{ truncated: boolean; chunks: number }` | Yes |
| All mutation hooks gain `lastResult` field | Additive — non-breaking |
| New `WikiConfig` keys (`autoHealThreshold`, `orphanAfterDays`, `staleInferredAfterDays`, `maxChunkLength`) | Additive — non-breaking |
| `sourceRef` normalization now applied on ingest write path | Potentially breaks callers who relied on exact path characters being stored |

**Existing data:** Rows with unnormalized `source_ref` values remain valid and are normalized in place by the setup-time migration. After migration, `forget({ sourceRef })` and re-ingest calls use normalized values, and caller-provided `sourceRef` inputs are normalized before matching, so callers do not need to pass the original exact legacy string.

**`ingestDocument` chunking contract change:** The `ingestDocument` params shape is unchanged, but the implicit caller contract changes: chunking now happens internally. Callers who pre-chunked and called `ingestDocument` once per chunk should switch to passing the full document and letting the package chunk it. Callers who cannot do this (e.g. streaming) may continue passing pre-chunked content — the internal chunking will be a no-op if the chunk is already under `maxChunkLength`.

---

## Out of Scope

- Vector embeddings / semantic search (different architecture; SQLite FTS5 covers the current use case)
- Synonym table / query expansion (different architecture, SQLite FTS5 already covers the core use case)
- Retry logic on LLM failure (caller's responsibility per BYOI principle)
- Per-fact access tracking changes (schema is already correct)
