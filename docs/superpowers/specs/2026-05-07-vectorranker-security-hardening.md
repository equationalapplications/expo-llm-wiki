# Spec: VectorRanker Security Hardening

**Date:** 2026-05-07  
**Status:** Ready  
**Builds on:** [`2026-05-07-pluggable-vector-retrieval.md`](2026-05-07-pluggable-vector-retrieval.md)  
**Target version:** v3.2.0 (minor — new public option)

---

## Problem

The VectorRanker implementation (shipped in v3.x) addresses functional requirements but leaves four security concerns unresolved, documented as `TODO(security)` comments in the original spec:

1. **Buffer mutation vulnerability (§3):** `queryVec` and `vector` passed to `rankBySimilarity()` and `onEmbeddingPersisted()` without defensive copies. Malicious or buggy adapters can mutate underlying Float32Array buffers, corrupting subsequent JS-cosine fallback paths or vectorCache entries.

2. **Credential leakage via error.cause (§5):** When `vectorRankerFallback` mirrors ranker errors via `error.cause` to host telemetry callbacks, sensitive data (query text, API keys in connection strings, stack traces with environment variables) may leak into logging/monitoring systems.

3. **GDPR deletion ordering (§6):** `onEmbeddingPersisted({vector: null})` on deletion paths (forget, prune, hard-delete) fires asynchronously, AND existing try/catch wrappers (WikiMemory.ts:473, 765, 2503) swallow hook failures via `console.warn`. Combined effect: SQLite delete commits even when ANN cleanup fails silently. External indexes retain deleted vectors indefinitely, violating right-to-deletion guarantees.

4. **Adapter security guidance gap (§7):** No documentation warns adapter authors about SQL injection risks (entityId/factId from untrusted input), credential scrubbing requirements for thrown errors, or entity isolation enforcement when `candidateIds` is undefined.

---

## Goal

Harden VectorRanker integration against buffer mutation, credential leakage, and deletion ordering violations while providing comprehensive security guidance for adapter implementers.

**Non-goals:**
- Breaking API changes or new public surface beyond `WikiOptions.sanitizeRankerErrors`
- Runtime validation layer or type-level security wrappers (deferred to future work)
- Backporting to v2.x (security patch targets v3.x+)

---

## Design

### 1. Defensive Copies (Buffer Mutation Protection)

**Implementation:** WikiMemory.ts creates defensive copies at two centralized chokepoints — one for vectors flowing into the ranker, one for vectors flowing into hooks. Centralizing prevents future call sites from bypassing protection.

#### Chokepoint A: `_notifyEmbeddingPersisted` (WikiMemory.ts:488)

Copy inside the helper itself so all four current call sites (lines 471, 763, 2284, 2501) and any future caller are covered automatically:

```typescript
private async _notifyEmbeddingPersisted(
  entityId: string,
  factId: string,
  vector: Float32Array | null
): Promise<void> {
  if (!this.options.vectorRanker?.onEmbeddingPersisted) return;
  // Defensive copy to prevent hook from mutating cache/fallback vectors.
  // .slice() on Float32Array allocates a new ArrayBuffer (not a view).
  const vectorCopy = vector ? vector.slice() : null;
  await this.options.vectorRanker.onEmbeddingPersisted({
    entityId,
    factId,
    vector: vectorCopy,
  });
}
```

**Audit note:** PR #16 added a 4th call site at WikiMemory.ts:2284 (preserved-blob notify path). Centralizing here covers it without per-site edits.

#### Chokepoint B: `_rankWithVectorRanker` (WikiMemory.ts:1328)

Copy queryVec at the single ranker entry point:

```typescript
const queryVecCopy = queryVec instanceof Float32Array
  ? queryVec.slice()
  : Array.from(queryVec);

const rankerResults = await ranker.rankBySimilarity({
  entityId,
  queryVec: queryVecCopy,
  candidateIds,
  limit,
});
```

#### Chokepoint C: `_rankWithJsCosine` (WikiMemory.ts:1251)

Defensive copy at function entry for symmetry with ranker path (in case a future code path passes the same buffer to both):

```typescript
private async _rankWithJsCosine(args: {
  entityId: string;
  queryVec: Float32Array | number[];
  // ... other args
}): Promise<Array<{ id: string; score: number; ... }>> {
  const { entityId, candidateRows, weight, miniSearchScores, populateCache, limit } = args;
  const queryVec = args.queryVec instanceof Float32Array
    ? args.queryVec.slice()
    : Array.from(args.queryVec);

  // ... existing logic
}
```

**Performance impact:** `.slice()` on Float32Array is O(n) where n = embedding dimension (typically 384–1536). Cost is ~1–5μs per call on modern hardware, negligible compared to SQLite I/O or LLM latency. Hook-side copy adds one allocation per persisted embedding (rare relative to read traffic).

**Testing:** Mutation detection tests in `vectorRanker.test.ts` verify mutating vectors inside ranker/hook callbacks doesn't affect cache contents OR persisted blob bytes (read back from SQLite).

---

### 2. Rethrow Hook Failures on Deletion (GDPR Compliance)

**Problem:** Two compounding issues:

1. `onEmbeddingPersisted({vector: null})` fires without `await` on deletion paths, allowing SQLite delete to commit before ANN cleanup.
2. Existing try/catch wrappers (WikiMemory.ts:473, 765, 2503) swallow hook errors via `console.warn`. Even with `await`, ANN failure is silently absorbed and SQLite still commits.

Combined: SQLite delete completes, ANN retains vector, no error surfaces. GDPR violation goes undetected.

**Solution:** Three coordinated changes.

#### 2A. Await + rethrow on deletion paths

Replace silent try/catch on deletion paths (WikiMemory.ts:763 prune, 2501 forget) with await + rethrow. Deletion fails loudly when ANN cleanup fails.

```typescript
// forget() — line 2501
await this._notifyEmbeddingPersistedOrThrow(entityId, factId, null);
// Above throws → caller sees error, can retry. SQLite delete already committed
// for soft-delete (UPDATE deleted_at), but hook fires AFTER blob clear so retry
// is idempotent. For prune (hard-delete), see 2B for ordering.
```

For `_doPrune()` (line 763), reorder so hook completes BEFORE the SQLite `DELETE FROM entries` (currently hook fires after delete). This makes rethrow meaningful:

```typescript
// _doPrune() — current order: DELETE row, then notify (silent on failure)
// New order: notify (await + rethrow), then DELETE row

for (const row of rowsToDelete) {
  await this._notifyEmbeddingPersistedOrThrow(row.entity_id, row.id, null);
}

// Only deletes rows whose hooks succeeded
await this.db.runAsync(`
  DELETE FROM ${this.prefix}entries
  WHERE id IN (${succeeded.map(() => '?').join(',')})
`, succeeded);
```

**Reembed/migration paths keep silent try/catch** (WikiMemory.ts:471, 2284). Those fire `vector` (not null) and represent best-effort index sync, not GDPR deletion. Distinguish via dedicated helper.

#### 2B. New helper: `_notifyEmbeddingPersistedOrThrow`

```typescript
/**
 * GDPR-critical variant: awaits hook and rethrows failures.
 * Use ONLY on deletion paths where ANN cleanup must succeed before SQLite commit.
 * For best-effort index sync (reembed, migration), use _notifyEmbeddingPersisted.
 */
private async _notifyEmbeddingPersistedOrThrow(
  entityId: string,
  factId: string,
  vector: Float32Array | null,
): Promise<void> {
  if (!this.options.vectorRanker?.onEmbeddingPersisted) return;
  if (this.options.forceDeleteIgnoreRankerHook === true) {
    // Escape hatch: skip hook entirely (used when ANN backend permanently down)
    return;
  }
  const vectorCopy = vector ? vector.slice() : null;
  const timeoutMs = this.options.deletionHookTimeoutMs ?? 30_000;
  const hookPromise = this.options.vectorRanker.onEmbeddingPersisted({
    entityId, factId, vector: vectorCopy,
  });
  await Promise.race([
    Promise.resolve(hookPromise),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`onEmbeddingPersisted timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}
```

#### 2C. Partial-failure contract for batch prune

`_doPrune()` iterates many rows. Document the contract:

- Hooks called sequentially (not parallel) for predictable ordering.
- First hook failure aborts the batch. Rows already notified successfully ARE deleted from SQLite. Failed row + remaining rows stay soft-deleted, retryable on next prune.
- Aggregate error contains `{ deleted: number, failedAt: string, remaining: number }` for caller visibility.

```typescript
const succeeded: Array<{ entity_id: string; id: string }> = [];
let failure: { factId: string; cause: Error } | null = null;

for (const row of rowsToDelete) {
  try {
    await this._notifyEmbeddingPersistedOrThrow(row.entity_id, row.id, null);
    succeeded.push(row);
  } catch (err) {
    failure = { factId: row.id, cause: err as Error };
    break;
  }
}

if (succeeded.length > 0) {
  await this.db.runAsync(/* DELETE WHERE id IN (succeeded) */);
}

if (failure) {
  throw new Error(
    `Prune partially failed: deleted ${succeeded.length}, failed at ${failure.factId}, ` +
    `${rowsToDelete.length - succeeded.length - 1} remaining`,
    { cause: this._sanitizeRankerError(failure.cause) },
  );
}
```

#### 2D. New options

Add to `WikiOptions`:

```typescript
/**
 * Timeout (ms) for onEmbeddingPersisted hook on GDPR deletion paths.
 * Hook must complete within this window or deletion fails. Default 30000.
 * Lower this for interactive deletes; raise for slow remote ANN backends.
 */
deletionHookTimeoutMs?: number;

/**
 * Escape hatch: skip onEmbeddingPersisted on deletion paths entirely.
 * Use ONLY when the ANN backend is permanently decommissioned and you accept
 * orphan vectors in the (unreachable) external index. NOT a GDPR-safe default.
 * Default false.
 */
forceDeleteIgnoreRankerHook?: boolean;
```

**Tradeoffs documented:**

- **Availability cost:** When ANN is down, `forget()` and `runPrune()` throw. Callers must implement retry. This is intentional — silent success would violate GDPR.
- **Escape hatch (`forceDeleteIgnoreRankerHook`):** For permanently-decommissioned backends. Caller accepts that orphan vectors persist in (unreachable) external index. Document in SECURITY.md that this is NOT GDPR-safe for live indexes.
- **Batch partial-failure:** Prune is idempotent per row; partial progress is safe. Caller sees aggregate error with counts.

**Performance impact:** Per-row deletion latency now bounded by `deletionHookTimeoutMs`. Successful hook adds <10ms (sqlite-vec) to 100–500ms (remote ANN). Acceptable — deletes are infrequent vs reads.

**Testing:** See §Testing — covers happy path, hook timeout, hook throw, partial-batch failure, escape hatch.

---

### 3. Error Sanitization (Credential Leakage Prevention)

**Problem:** When `vectorRankerFallback` is not `'throw'` and `propagateRankerFailureToRetrievalFallback` is true, core mirrors ranker error via `error.cause`. Original error may contain:
- API keys in connection strings ("https://api.example.com?key=secret123")
- Stack traces exposing environment variables
- Query text that may be PII

**Solution:** Add `WikiOptions.sanitizeRankerErrors?: boolean` (default `true`). When enabled, sanitize error before attaching as `.cause`.

#### Implementation:

**A. Add to `WikiOptions` in types.ts:**

```typescript
export interface WikiOptions {
  // ... existing fields

  /**
   * When true (default), sanitize ranker errors before exposing via error.cause
   * to prevent credential leakage in host telemetry. Disable only when you
   * control the ranker implementation.
   * 
   * Sanitization replaces error message/stack with generic message preserving
   * only error type (constructor name).
   */
  sanitizeRankerErrors?: boolean;
}
```

**B. Sanitizer function (WikiMemory.ts):**

```typescript
/**
 * Strip potentially sensitive data from ranker errors before exposing to host callbacks.
 * Preserves error type for debugging but removes message/stack that may contain credentials.
 * Recursively sanitizes .cause chain to one level (deeper chains collapsed to type only).
 */
private _sanitizeRankerError(err: unknown): Error {
  if (this.options.sanitizeRankerErrors === false) {
    // Host opted out. Coerce non-Error throws to Error for consistent surface.
    return err instanceof Error ? err : new Error(String(err));
  }

  // Robust type extraction — err may be null/undefined/string/number (legal in JS throw).
  const typeName =
    err instanceof Error
      ? (err.constructor?.name ?? 'Error')
      : typeof err;

  // Use ES2022 cause syntax. Recursively sanitize one level of .cause for chain visibility.
  const innerCause =
    err instanceof Error && err.cause !== undefined
      ? new Error(`Caused by: ${(err.cause as Error)?.constructor?.name ?? typeof err.cause}`)
      : undefined;

  const sanitized = new Error(
    `VectorRanker ${typeName} (message scrubbed for security)`,
    innerCause ? { cause: innerCause } : undefined,
  );
  sanitized.name = typeName;
  // Do NOT copy .message, .stack, or other properties that may leak credentials.
  return sanitized;
}
```

**C. Apply at error.cause assignment (WikiMemory.ts:~1074):**

```typescript
if (this.options.propagateRankerFailureToRetrievalFallback) {
  // Use ES2022 cause syntax — no `as any` cast needed.
  const mirrored = new Error('Vector ranker failed, falling back', {
    cause: this._sanitizeRankerError(rankerError),
  });
  pendingRankerFallbackError = mirrored;
}
```

**Testing:** 
- Verify `sanitizeRankerErrors: true` strips message containing "api_key=secret"
- Verify `sanitizeRankerErrors: false` preserves original error
- Verify error.constructor.name preserved for debugging

---

### 4. SECURITY.md (Adapter Security Guidance)

Create new file at project root with three sections.

#### Section 1: Reporting Vulnerabilities

```markdown
# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in expo-llm-wiki, please report it by emailing:

**security@equationalapplications.com**

We will acknowledge your email within 48 hours and provide a detailed response within 5 business days indicating next steps.

Please do not disclose security vulnerabilities publicly until we have had a chance to address them.

### Disclosure Timeline

- **Day 0:** Vulnerability reported via email
- **Day 2:** Acknowledgment sent to reporter
- **Day 5:** Initial assessment and response with timeline
- **Day 30-90:** Fix developed, tested, and released (varies by severity)
- **Day 90+:** Public disclosure coordinated with reporter

We do not currently offer a bug bounty program.
```

#### Section 2: VectorRanker Adapter Security

```markdown
## VectorRanker Adapter Security

If you are implementing a custom `VectorRanker` adapter (for sqlite-vec, external ANN, or other backends), follow these security practices:

### SQL Injection Prevention

**Problem:** `entityId` and `factId` passed to `rankBySimilarity` and `onEmbeddingPersisted` flow from untrusted user input. Never concatenate these values into SQL strings.

**Vulnerable code:**

```typescript
// NEVER DO THIS
const sql = `SELECT * FROM vec_facts WHERE entity_id = '${entityId}'`;
const rows = await db.getAllAsync(sql);
```

**Secure code:**

```typescript
// ALWAYS use parameterized queries
const sql = `SELECT * FROM vec_facts WHERE entity_id = ?`;
const rows = await db.getAllAsync(sql, [entityId]);
```

**Applies to:** Any SQL or NoSQL query construction. Use parameterized queries, prepared statements, or ORM query builders. Never string concatenation or template literals.

**Bind parameter limits:** SQLite caps bind parameters at `SQLITE_MAX_VARIABLE_NUMBER` (999 prior to 3.32, 32766 after). When `candidateIds.length` is large, chunk the IN clause:

```typescript
const CHUNK = 500; // Safe across SQLite versions
const results = [];
for (let i = 0; i < candidateIds.length; i += CHUNK) {
  const chunk = candidateIds.slice(i, i + CHUNK);
  const placeholders = chunk.map(() => '?').join(',');
  const rows = await db.getAllAsync(
    `SELECT id, similarity FROM vec_facts WHERE entity_id = ? AND id IN (${placeholders})`,
    [entityId, ...chunk],
  );
  results.push(...rows);
}
```

### Credential Scrubbing in Errors

**Problem:** Errors thrown from `rankBySimilarity` may be logged by host applications via `onVectorRankerFallback` or `onRetrievalFallback`. Connection strings, API keys, or tokens in error messages will leak into telemetry.

**Vulnerable code:**

```typescript
// Error exposes API key
throw new Error(`ANN request failed: https://api.example.com/search?key=sk_live_abc123`);
```

**Secure code:**

```typescript
// Scrub credentials before throwing
const sanitizedUrl = url.replace(/key=[^&]+/, 'key=REDACTED');
throw new Error(`ANN request failed: ${sanitizedUrl}`);

// Or use generic error
throw new Error(`ANN request failed (connection error)`);
```

**Applies to:** All thrown errors, especially network errors with URLs, authentication errors with tokens, or database connection errors.

**Note:** Core provides `sanitizeRankerErrors: true` (default) as defense-in-depth, but adapters should scrub credentials at source.

### Entity Isolation

**Problem:** When `candidateIds` is `undefined` (full-entity scan), ranker MUST enforce `entityId` scoping in backing store queries. Failing to filter by `entityId` violates tenant isolation — ranker may return facts from other entities.

**Vulnerable code:**

```typescript
async rankBySimilarity(args) {
  const { queryVec, limit } = args;
  // Missing entityId filter — returns facts across ALL entities
  return db.getAllAsync(`SELECT id, similarity FROM vec_facts LIMIT ?`, [limit]);
}
```

**Secure code:**

```typescript
async rankBySimilarity(args) {
  const { entityId, queryVec, candidateIds, limit } = args;
  
  let sql = `SELECT id, similarity FROM vec_facts WHERE entity_id = ?`;
  const params = [entityId];
  
  if (candidateIds) {
    sql += ` AND id IN (${candidateIds.map(() => '?').join(',')})`;
    params.push(...candidateIds);
  }
  
  sql += ` LIMIT ?`;
  params.push(limit);
  
  return db.getAllAsync(sql, params);
}
```

**Applies to:** All ranker implementations. Always filter by `entityId` unless your backing store is already partitioned per-entity (then document partitioning strategy).

### Mutation Contract

**Problem:** Core passes `queryVec` and `vector` to adapter methods. Mutating these arrays can corrupt WikiMemory's internal vector cache or fallback paths.

**Guidance:** Treat `queryVec` and `vector` as readonly. Do not call `.set()`, assign to indices, or pass to functions that mutate in-place.

**Note:** Core provides defensive copies as of v3.2, but adapters should still treat vectors as immutable for forward compatibility.

### Resource Limits and Retention (DoS Prevention)

**Problem:** Adapter receives `limit` and `candidateIds` from core but core does not cap their size. Unbounded values from a misconfigured host can exhaust memory or CPU. Retaining `vector` references past the callback prevents GC of large embeddings.

**Guidance for adapters:**

- **Cap `limit`:** Reject or clamp values above a backend-appropriate maximum (e.g., 10_000 for in-memory, 1_000 for remote ANN).
- **Cap `candidateIds.length`:** Same — chunk per the SQL injection guidance above and reject pathological inputs.
- **Do NOT retain `vector`:** The `Float32Array` passed to `onEmbeddingPersisted` may be 1.5KB–6KB. If the adapter stores the reference (e.g., in a closure, queue, or memo cache without TTL), GC is blocked. Copy what you need, then drop the reference before returning.
- **Cap embedding dimension:** Validate `vector.length` matches your index dimension. Reject mismatches loudly — silent acceptance corrupts the index.

```typescript
async onEmbeddingPersisted({ entityId, factId, vector }) {
  if (vector && vector.length !== EXPECTED_DIM) {
    throw new Error(`Vector dim mismatch: expected ${EXPECTED_DIM}, got ${vector.length}`);
  }
  // Copy any needed scalars; do NOT retain the typed array reference.
  await this.index.upsert(entityId, factId, vector ? Array.from(vector) : null);
  // vector goes out of scope here — GC eligible
}
```

### Tenant Isolation: Timing and Existence Leaks

**Problem:** `entityId` filtering in queries (above) prevents cross-tenant data return, but two side channels can still leak information:

1. **Timing oracle:** If the adapter's query latency depends on cross-tenant data size (e.g., scanning a shared index), an attacker measuring response times can infer the existence of facts in other tenants.
2. **Error existence leaks:** When `vectorRankerFallback: 'throw'` is configured, ranker errors propagate to the caller. If error messages embed counts ("0 of 50000 candidates matched") or backend-specific identifiers, they reveal cross-tenant index size.

**Guidance:**

- Prefer per-entity partitions / namespaces in the backing store over shared indexes with WHERE filters. Partitioned queries have constant latency relative to other tenants' data.
- Strip counts, internal IDs, and backend metadata from thrown errors. Use generic messages like `"semantic search unavailable"`.
- For high-sensitivity deployments, add small constant-time padding to query latency before returning.
```

#### Section 3: Host Application Security

```markdown
## Host Application Security

If your application uses expo-llm-wiki with VectorRanker:

### Error Sanitization

Enable `sanitizeRankerErrors: true` (default) unless you control the ranker implementation:

```typescript
const wikiMemory = new WikiMemory(db, {
  vectorRanker: myRanker,
  sanitizeRankerErrors: true, // default
});
```

Disable only when you've audited the ranker code and know it doesn't leak credentials in errors.

### Fallback Policy Selection

Choose `vectorRankerFallback` based on your availability vs consistency requirements:

- `'js-cosine'` (default): Best availability, degrades to in-process ranking
- `'keyword'`: Fast fallback, semantic ranking skipped
- `'empty'`: Strict consistency, no facts returned on ranker failure
- `'throw'`: Fail-fast, propagate errors to caller

For GDPR-critical deployments, consider `'empty'` or `'throw'` to avoid returning potentially-stale results.

### Callback Logging

Avoid logging full error objects from `onVectorRankerFallback` / `onRetrievalFallback`:

```typescript
// Vulnerable: logs full error with potential PII
onRetrievalFallback: (error) => {
  logger.error('Retrieval failed', { error });
}

// Secure: log only type and generic message
onRetrievalFallback: (error) => {
  logger.error('Retrieval failed', { 
    errorType: error.constructor.name,
    message: 'Vector search degraded to keyword'
  });
}
```

Query text passed to `read()` may be PII. Don't log it unless you have user consent.

### Deletion Policy and Hook Failures

`forget()` and `runPrune()` reject when `onEmbeddingPersisted` throws or exceeds `deletionHookTimeoutMs` (default 30s). This is intentional — silent failure would leave deleted vectors retrievable in external ANN indexes, violating GDPR right-to-erasure.

**Required handling:**

```typescript
try {
  await wikiMemory.forget(entityId, factId);
} catch (err) {
  // ANN cleanup failed. Options:
  // 1. Retry with backoff (transient ANN outage)
  // 2. Queue for background reconciliation
  // 3. Surface to user as "deletion pending"
  // DO NOT mark deletion complete in your UI.
  enqueueDeletionRetry(entityId, factId);
  throw err;
}
```

**Tuning `deletionHookTimeoutMs`:**

- Interactive UX: 5000ms (fast feedback, may need user retry)
- Background jobs: 60000ms (tolerate transient ANN slowdowns)
- High-volume prune: 10000ms per row (matches batch SLAs)

**`forceDeleteIgnoreRankerHook`:** Use ONLY when the ANN backend is permanently decommissioned and the orphaned vectors will never be queried again. Setting this on a live index breaks GDPR compliance silently — DO NOT use as a workaround for flaky backends.
```

---

## Documentation Updates

### README.md

Add subsection after "Pluggable Vector Retrieval" (after line ~258) in BOTH the repo-root README and `packages/core/README.md` (link path differs):

**Repo root README.md:**

```markdown
### Security Considerations

When implementing custom `VectorRanker` adapters, follow secure coding practices to prevent SQL injection, credential leakage, and tenant isolation violations. See [SECURITY.md](./SECURITY.md) for detailed guidance.

Core provides `sanitizeRankerErrors: true` (default) to strip sensitive data from ranker errors before passing to host callbacks. Disable only when you control the ranker implementation.
```

**`packages/core/README.md`:**

Same content but link path `[SECURITY.md](../../SECURITY.md)` (verify by `ls ../../SECURITY.md` from `packages/core/`).

### types.ts JSDoc Updates

**VectorRankerRankArgs.queryVec:**

```typescript
export interface VectorRankerRankArgs {
  entityId: string;
  /**
   * Query embedding. Treat as readonly — core provides defensive copy,
   * but adapters MUST NOT mutate this array.
   */
  queryVec: Float32Array | number[];
  candidateIds?: readonly string[];
  limit: number;
}
```

**VectorRanker.onEmbeddingPersisted:**

```typescript
export interface VectorRanker {
  rankBySimilarity(args: VectorRankerRankArgs): Promise<VectorRankerSemanticResult[]>;

  /**
   * Called after a fact's embedding is successfully persisted to embedding_blob (or cleared).
   * Hosts use this to keep sqlite-vec / external indexes consistent with SQLite as source of truth.
   * 
   * On deletion paths (forget, prune, hard-delete), core awaits this hook to ensure ANN cleanup
   * completes before SQLite deletion commits (GDPR compliance).
   * 
   * Treat `vector` as readonly — core provides defensive copy, but adapters MUST NOT mutate.
   * 
   * Optional: if omitted, hosts MUST document "index rebuilt separately" and accept stale ANN until rebuild.
   */
  onEmbeddingPersisted?(event: {
    entityId: string;
    factId: string;
    vector: Float32Array | null; // null = embedding removed / unusable
  }): void | Promise<void>;
}
```

**WikiOptions.sanitizeRankerErrors / deletionHookTimeoutMs / forceDeleteIgnoreRankerHook:**

```typescript
export interface WikiOptions {
  // ... existing fields

  /**
   * When true (default), sanitize ranker errors before exposing via error.cause
   * to prevent credential leakage in host telemetry. Disable only when you
   * control the ranker implementation.
   *
   * Sanitization replaces error message/stack with generic message preserving
   * only error type (constructor name).
   */
  sanitizeRankerErrors?: boolean;

  /**
   * Timeout (ms) for onEmbeddingPersisted hook on GDPR deletion paths
   * (forget, _doPrune). Hook must complete within this window or the
   * deletion operation rejects. Default 30000.
   * Lower for interactive deletes; raise for slow remote ANN backends.
   */
  deletionHookTimeoutMs?: number;

  /**
   * Escape hatch: skip onEmbeddingPersisted on deletion paths entirely.
   * Use ONLY when the ANN backend is permanently decommissioned. Vectors
   * orphaned in the (unreachable) external index are accepted as a tradeoff.
   * NOT GDPR-safe for live indexes. Default false.
   */
  forceDeleteIgnoreRankerHook?: boolean;
}
```

### CHANGELOG.md

Add **minor** entry (new public options surface) under `## [3.2.0]`:

```markdown
### Security

* **core:** centralize defensive copies for VectorRanker `queryVec` and `vector` to prevent buffer mutation by adapters/hooks
* **core:** await + rethrow `onEmbeddingPersisted` failures on deletion paths (`forget`, `_doPrune`) for GDPR compliance — silent hook failures no longer mask ANN cleanup errors
* **core:** add `sanitizeRankerErrors` option (default `true`) to scrub credentials from ranker errors before exposing via `error.cause`
* **core:** add `deletionHookTimeoutMs` option (default `30000`) to bound deletion latency when ANN backend stalls
* **core:** add `forceDeleteIgnoreRankerHook` escape hatch (default `false`) for permanently-decommissioned ANN backends
* **docs:** add `SECURITY.md` with VectorRanker adapter security guidance (SQL injection, credential scrubbing, entity isolation, DoS prevention, timing leaks)

### BREAKING (behavioral, not API)

* `forget()` and `runPrune()` now reject when `onEmbeddingPersisted` throws or exceeds `deletionHookTimeoutMs`. Previously these errors were swallowed via `console.warn`. Hosts using `VectorRanker.onEmbeddingPersisted` MUST handle deletion errors or set `forceDeleteIgnoreRankerHook: true` (NOT GDPR-safe). See migration notes.
```

---

## Testing

Add to `packages/core/__tests__/vectorRanker.test.ts`:

### Mutation Detection Tests

**Test 1: queryVec mutation in rankBySimilarity doesn't affect fallback**

```typescript
it('should protect queryVec from mutation by ranker', async () => {
  const maliciousRanker: VectorRanker = {
    async rankBySimilarity(args) {
      // Attempt to corrupt queryVec
      if (args.queryVec instanceof Float32Array) {
        args.queryVec[0] = 999;
      } else {
        args.queryVec[0] = 999;
      }
      throw new Error('Ranker failed after mutation');
    }
  };

  const wikiMemory = new WikiMemory(db, {
    llmProvider: mockLLMProvider,
    vectorRanker: maliciousRanker,
    vectorRankerFallback: 'js-cosine',
  });

  await wikiMemory.setup();
  await wikiMemory.upsert('entity1', { content: 'test fact', source: 'test' });

  // First call: ranker mutates and throws, falls back to JS cosine
  const result1 = await wikiMemory.read('entity1', 'test query');
  expect(result1.facts.length).toBeGreaterThan(0);

  // Second call: verify queryVec is clean (not corrupted by previous mutation)
  const result2 = await wikiMemory.read('entity1', 'test query');
  expect(result2.facts.length).toBeGreaterThan(0);
  expect(result2.facts[0].id).toBe(result1.facts[0].id); // Same ranking
});
```

**Test 2: vector mutation in onEmbeddingPersisted doesn't corrupt cache OR persisted blob**

```typescript
it('should protect vector from mutation by onEmbeddingPersisted hook', async () => {
  let capturedVector: Float32Array | null = null;

  const maliciousRanker: VectorRanker = {
    async rankBySimilarity(args) {
      return []; // No results, force backfill
    },
    async onEmbeddingPersisted(event) {
      if (event.vector) {
        capturedVector = event.vector;
        event.vector[0] = -999; // Attempt corruption
      }
    }
  };

  const wikiMemory = new WikiMemory(db, {
    llmProvider: mockLLMProvider,
    vectorRanker: maliciousRanker,
    vectorRankerFallback: 'js-cosine',
  });

  await wikiMemory.setup();
  const fact = await wikiMemory.upsert('entity1', { content: 'test fact', source: 'test' });

  // 1. Hook received a copy (mutation visible on the copy itself).
  expect(capturedVector).not.toBeNull();
  expect(capturedVector![0]).toBe(-999);

  // 2. Persisted blob in SQLite is NOT corrupted (defensive copy worked).
  const row = await db.getFirstAsync<{ embedding_blob: ArrayBuffer }>(
    `SELECT embedding_blob FROM entries WHERE id = ?`,
    [fact.id],
  );
  const persisted = new Float32Array(row!.embedding_blob);
  expect(persisted[0]).not.toBe(-999);

  // 3. In-memory vectorCache (if hot) is NOT corrupted.
  //    Re-read uses cached vector; if corrupt, cosine scores become nonsense.
  const result = await wikiMemory.read('entity1', 'test query');
  expect(result.facts.length).toBeGreaterThan(0);
  expect(Number.isFinite(result.facts[0].score)).toBe(true);
});
```

### Deletion Ordering Tests

**Test 3: onEmbeddingPersisted awaited on forget()**

```typescript
it('should await onEmbeddingPersisted before forget() resolves', async () => {
  let hookCompleted = false;
  let hookCalledAt = 0;
  let forgetResolvedAt = 0;

  const delayedRanker: VectorRanker = {
    async rankBySimilarity() { return []; },
    async onEmbeddingPersisted(event) {
      hookCalledAt = Date.now();
      await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
      hookCompleted = true;
    }
  };

  const wikiMemory = new WikiMemory(db, {
    llmProvider: mockLLMProvider,
    vectorRanker: delayedRanker,
  });

  await wikiMemory.setup();
  const fact = await wikiMemory.upsert('entity1', { content: 'to forget', source: 'test' });

  await wikiMemory.forget('entity1', fact.id);
  forgetResolvedAt = Date.now();

  expect(hookCompleted).toBe(true);
  expect(forgetResolvedAt - hookCalledAt).toBeGreaterThanOrEqual(100);
});
```

**Test 4: onEmbeddingPersisted awaited on prune hard-delete**

```typescript
it('should await onEmbeddingPersisted during prune hard-delete', async () => {
  let hookCallCount = 0;

  const trackingRanker: VectorRanker = {
    async rankBySimilarity() { return []; },
    async onEmbeddingPersisted(event) {
      if (event.vector === null) {
        hookCallCount++;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  };

  const wikiMemory = new WikiMemory(db, {
    llmProvider: mockLLMProvider,
    vectorRanker: trackingRanker,
    config: { pruneRetainSoftDeletedFor: 0 }, // Immediate hard-delete
  });

  await wikiMemory.setup();
  const fact1 = await wikiMemory.upsert('entity1', { content: 'fact 1', source: 'test' });
  const fact2 = await wikiMemory.upsert('entity1', { content: 'fact 2', source: 'test' });

  await wikiMemory.forget('entity1', fact1.id);
  await wikiMemory.forget('entity1', fact2.id);

  const beforePrune = hookCallCount;
  await wikiMemory.runPrune('entity1');

  // Hook should have been called for hard-deleted facts
  expect(hookCallCount).toBeGreaterThan(beforePrune);
});
```

**Test 4b: forget() rethrows when deletion hook fails**

```typescript
it('should rethrow onEmbeddingPersisted failure on forget()', async () => {
  const failingRanker: VectorRanker = {
    async rankBySimilarity() { return []; },
    async onEmbeddingPersisted(event) {
      if (event.vector === null) throw new Error('ANN cleanup failed');
    }
  };

  const wikiMemory = new WikiMemory(db, {
    llmProvider: mockLLMProvider,
    vectorRanker: failingRanker,
  });

  await wikiMemory.setup();
  const fact = await wikiMemory.upsert('entity1', { content: 'x', source: 't' });

  await expect(wikiMemory.forget('entity1', fact.id)).rejects.toThrow(/ANN cleanup failed|scrubbed/);
});
```

**Test 4c: deletionHookTimeoutMs aborts slow hook**

```typescript
it('should abort deletion when hook exceeds deletionHookTimeoutMs', async () => {
  const slowRanker: VectorRanker = {
    async rankBySimilarity() { return []; },
    async onEmbeddingPersisted(event) {
      if (event.vector === null) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  };

  const wikiMemory = new WikiMemory(db, {
    llmProvider: mockLLMProvider,
    vectorRanker: slowRanker,
    deletionHookTimeoutMs: 100,
  });

  await wikiMemory.setup();
  const fact = await wikiMemory.upsert('entity1', { content: 'x', source: 't' });

  await expect(wikiMemory.forget('entity1', fact.id)).rejects.toThrow(/timed out/);
});
```

**Test 4d: forceDeleteIgnoreRankerHook bypasses hook entirely**

```typescript
it('should skip hook entirely when forceDeleteIgnoreRankerHook is true', async () => {
  let hookCalled = false;
  const ranker: VectorRanker = {
    async rankBySimilarity() { return []; },
    async onEmbeddingPersisted() {
      hookCalled = true;
      throw new Error('would have failed');
    }
  };

  const wikiMemory = new WikiMemory(db, {
    llmProvider: mockLLMProvider,
    vectorRanker: ranker,
    forceDeleteIgnoreRankerHook: true,
  });

  await wikiMemory.setup();
  const fact = await wikiMemory.upsert('entity1', { content: 'x', source: 't' });

  await expect(wikiMemory.forget('entity1', fact.id)).resolves.not.toThrow();
  expect(hookCalled).toBe(false);
});
```

**Test 4e: prune partial-failure deletes successful rows, surfaces aggregate error**

```typescript
it('should commit partial prune progress and report failure', async () => {
  let callIndex = 0;
  const flakyRanker: VectorRanker = {
    async rankBySimilarity() { return []; },
    async onEmbeddingPersisted(event) {
      if (event.vector === null) {
        callIndex++;
        if (callIndex === 3) throw new Error('ANN flake on row 3');
      }
    }
  };

  const wikiMemory = new WikiMemory(db, {
    llmProvider: mockLLMProvider,
    vectorRanker: flakyRanker,
    config: { pruneRetainSoftDeletedFor: 0 },
  });

  await wikiMemory.setup();
  const facts = [];
  for (let i = 0; i < 5; i++) {
    facts.push(await wikiMemory.upsert('entity1', { content: `f${i}`, source: 't' }));
  }
  for (const f of facts) await wikiMemory.forget('entity1', f.id).catch(() => {});

  // Reset flake counter for prune phase
  callIndex = 0;
  await expect(wikiMemory.runPrune('entity1')).rejects.toThrow(/partially failed/i);

  // First 2 rows hard-deleted, remaining 3 (incl. failed row) still soft-deleted.
  const remaining = await db.getAllAsync(`SELECT id FROM entries WHERE deleted_at IS NOT NULL`);
  expect(remaining.length).toBeGreaterThan(0);
});
```

### Error Sanitization Tests

**Test 5: sanitizeRankerErrors: true (default) scrubs credentials**

```typescript
it('should sanitize ranker errors by default', async () => {
  let capturedError: Error | undefined;

  const leakyRanker: VectorRanker = {
    async rankBySimilarity() {
      throw new Error('Connection failed: https://api.example.com?key=sk_live_secret123');
    }
  };

  const wikiMemory = new WikiMemory(db, {
    llmProvider: mockLLMProvider,
    vectorRanker: leakyRanker,
    vectorRankerFallback: 'js-cosine',
    propagateRankerFailureToRetrievalFallback: true,
    onRetrievalFallback: (error) => {
      capturedError = error;
    }
  });

  await wikiMemory.setup();
  await wikiMemory.upsert('entity1', { content: 'test', source: 'test' });
  await wikiMemory.read('entity1', 'test query');

  expect(capturedError).toBeDefined();
  expect((capturedError as any).cause).toBeDefined();
  const cause = (capturedError as any).cause as Error;

  // Should NOT contain the secret key.
  expect(cause.message).not.toContain('sk_live_secret123');
  expect(cause.message).toContain('VectorRanker Error');
  // Type preserved for triage.
  expect(cause.name).toBe('Error');
});
```

**Test 5b: sanitizer survives non-Error throws**

```typescript
it('should sanitize non-Error throws without crashing', async () => {
  let capturedError: Error | undefined;

  const stringThrowingRanker: VectorRanker = {
    async rankBySimilarity() {
      // eslint-disable-next-line no-throw-literal
      throw 'bare string with secret api_key=abc';
    }
  };

  const wikiMemory = new WikiMemory(db, {
    llmProvider: mockLLMProvider,
    vectorRanker: stringThrowingRanker,
    vectorRankerFallback: 'js-cosine',
    propagateRankerFailureToRetrievalFallback: true,
    onRetrievalFallback: (error) => { capturedError = error; },
  });

  await wikiMemory.setup();
  await wikiMemory.upsert('entity1', { content: 'test', source: 'test' });
  await wikiMemory.read('entity1', 'test query');

  expect(capturedError).toBeDefined();
  const cause = (capturedError as any).cause as Error;
  expect(cause.message).not.toContain('api_key=abc');
  expect(cause.message).toContain('VectorRanker string');
});
```

**Test 6: sanitizeRankerErrors: false preserves original error**

```typescript
it('should preserve original error when sanitizeRankerErrors: false', async () => {
  let capturedError: Error | undefined;

  const leakyRanker: VectorRanker = {
    async rankBySimilarity() {
      throw new Error('Detailed error with api_key=secret123');
    }
  };

  const wikiMemory = new WikiMemory(db, {
    llmProvider: mockLLMProvider,
    vectorRanker: leakyRanker,
    vectorRankerFallback: 'js-cosine',
    sanitizeRankerErrors: false, // Disable sanitization
    propagateRankerFailureToRetrievalFallback: true,
    onRetrievalFallback: (error) => {
      capturedError = error;
    }
  });

  await wikiMemory.setup();
  await wikiMemory.upsert('entity1', { content: 'test', source: 'test' });
  await wikiMemory.read('entity1', 'test query');

  expect(capturedError).toBeDefined();
  const causeMessage = (capturedError as any).cause.message;
  
  // Should preserve original message
  expect(causeMessage).toContain('api_key=secret123');
});
```

---

## Acceptance Criteria

- [ ] Defensive copies centralized at 2 chokepoints (`_notifyEmbeddingPersisted` for hook-bound vectors, `_rankWithVectorRanker` + `_rankWithJsCosine` for queryVec)
- [ ] All 4 existing `_notifyEmbeddingPersisted` call sites (lines 471, 763, 2284, 2501) covered without per-site edits
- [ ] Mutation detection tests pass — including persisted-blob assertion, not just hook-receipt
- [ ] New helper `_notifyEmbeddingPersistedOrThrow` used on deletion paths (`forget`, `_doPrune`); silent variant retained for reembed/migration paths (lines 471, 2284)
- [ ] `forget()` and `runPrune()` reject on hook failure (Test 4b)
- [ ] `deletionHookTimeoutMs` enforced (Test 4c, default 30000)
- [ ] `forceDeleteIgnoreRankerHook` escape hatch works (Test 4d)
- [ ] Prune partial-failure: successful rows committed, aggregate error thrown with counts (Test 4e)
- [ ] `WikiOptions.sanitizeRankerErrors` added with default `true`
- [ ] Sanitizer handles non-Error throws (Test 5b) and one level of `.cause` chain
- [ ] Sanitizer uses ES2022 `new Error(msg, { cause })` syntax — no `as any` casts
- [ ] SECURITY.md created at project ROOT with all sections (reporting, adapter security incl. SQL chunking + DoS + retention + tenant timing, host security incl. new options)
- [ ] README.md security subsection added in BOTH repo-root README and `packages/core/README.md` with correct relative paths
- [ ] types.ts JSDoc updated for `queryVec`, `vector`, `onEmbeddingPersisted`, `sanitizeRankerErrors`, `deletionHookTimeoutMs`, `forceDeleteIgnoreRankerHook`
- [ ] CHANGELOG.md `[3.2.0]` entry includes Security section AND BREAKING (behavioral) callout
- [ ] All existing VectorRanker tests still pass (no regressions)
- [ ] Performance benchmarks confirm defensive copies add <10μs overhead per `read()` call

---

## Migration Notes

**For existing VectorRanker adapter authors:**

- No type-level API changes — defensive copies transparent to adapters.
- Review SECURITY.md guidance: SQL chunking (>500 ids), credential scrubbing, vector retention, tenant timing.
- If your `onEmbeddingPersisted` can fail on the network (remote ANN), it now gates `forget()` / `runPrune()`. Implement retries, backoff, or circuit breakers inside the hook OR document required host-side retry policy.
- If your adapter mutates `queryVec` or `vector` in-place (unlikely), stop doing so — forward compatibility.

**For host applications:**

- `sanitizeRankerErrors: true` is now default — opt out only if you control ranker code.
- **BREAKING (behavioral):** `forget()` and `runPrune()` now throw when `onEmbeddingPersisted` fails or times out. Wrap in try/catch and implement retry, OR set `forceDeleteIgnoreRankerHook: true` if your ANN backend is decommissioned (NOT GDPR-safe for live indexes).
- Tune `deletionHookTimeoutMs` based on your ANN latency profile (default 30s — generous for remote ANN, may need lowering to 5s for interactive UX).
- `runPrune()` may now throw a partial-failure aggregate error. Inspect `.cause` for the underlying ranker error type; remaining soft-deleted rows will retry on next prune.
- No action required for hosts that don't use `VectorRanker.onEmbeddingPersisted`.

---

## References

- Original spec: [`2026-05-07-pluggable-vector-retrieval.md`](2026-05-07-pluggable-vector-retrieval.md)
- OWASP Top 10: https://owasp.org/www-project-top-ten/
- GDPR Right to Erasure: https://gdpr-info.eu/art-17-gdpr/
