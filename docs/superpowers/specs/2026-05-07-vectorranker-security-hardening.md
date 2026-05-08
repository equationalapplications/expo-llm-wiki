# Spec: VectorRanker Security Hardening

**Date:** 2026-05-07  
**Status:** Draft  
**Builds on:** [`2026-05-07-pluggable-vector-retrieval.md`](2026-05-07-pluggable-vector-retrieval.md)

---

## Problem

The VectorRanker implementation (shipped in v3.x) addresses functional requirements but leaves four security concerns unresolved, documented as `TODO(security)` comments in the original spec:

1. **Buffer mutation vulnerability (§3):** `queryVec` and `vector` passed to `rankBySimilarity()` and `onEmbeddingPersisted()` without defensive copies. Malicious or buggy adapters can mutate underlying Float32Array buffers, corrupting subsequent JS-cosine fallback paths or vectorCache entries.

2. **Credential leakage via error.cause (§5):** When `vectorRankerFallback` mirrors ranker errors via `error.cause` to host telemetry callbacks, sensitive data (query text, API keys in connection strings, stack traces with environment variables) may leak into logging/monitoring systems.

3. **GDPR deletion ordering (§6):** `onEmbeddingPersisted({vector: null})` on deletion paths (forget, prune, hard-delete) fires asynchronously. External ANN indexes may retain deleted vectors until eventual consistency completes, violating right-to-deletion guarantees.

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

**Implementation:** WikiMemory.ts creates defensive copies before passing vectors to ranker/hooks.

#### Copy sites (3 locations):

**A. `_rankWithVectorRanker` (line ~1343)**

Before `ranker.rankBySimilarity()` call:

```typescript
// Defensive copy to prevent ranker from mutating queryVec buffer
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

**B. `_notifyEmbeddingPersisted` (line ~489)**

Before `onEmbeddingPersisted` hook:

```typescript
private async _notifyEmbeddingPersisted(
  entityId: string, 
  factId: string, 
  vector: Float32Array | null
): Promise<void> {
  // Defensive copy to prevent hook from mutating cache/fallback vectors
  const vectorCopy = vector ? vector.slice() : null;
  await this.options.vectorRanker?.onEmbeddingPersisted?.({ 
    entityId, 
    factId, 
    vector: vectorCopy 
  });
}
```

**C. `_rankWithJsCosine` (line ~1259)**

Add defensive copy at function entry to match ranker path behavior:

```typescript
private async _rankWithJsCosine(args: {
  entityId: string;
  queryVec: Float32Array | number[];
  // ... other args
}): Promise<Array<{ id: string; score: number; ... }>> {
  // Defensive copy for consistency with ranker path
  const { entityId, candidateRows, weight, miniSearchScores, populateCache, limit } = args;
  const queryVec = args.queryVec instanceof Float32Array 
    ? args.queryVec.slice() 
    : Array.from(args.queryVec);
  
  // ... existing logic
}
```

**Performance impact:** `.slice()` on Float32Array is O(n) where n = embedding dimension (typically 384-1536). Cost is ~1-5μs per call on modern hardware, negligible compared to SQLite I/O or LLM latency.

**Testing:** Mutation detection tests in `vectorRanker.test.ts` verify that mutating vectors inside ranker/hook callbacks doesn't affect core behavior.

---

### 2. Await Deletion Hooks (GDPR Compliance)

**Problem:** Current implementation fires `onEmbeddingPersisted({vector: null})` without awaiting, allowing SQLite deletion to commit before ANN cleanup completes. Deleted facts may remain retrievable via external indexes.

**Solution:** Await `_notifyEmbeddingPersisted()` on deletion paths.

#### Affected call sites (3 paths):

**A. `forget()` — soft-delete path**

After clearing `embedding_blob` for forgotten facts:

```typescript
// Clear embeddings for forgotten facts
await this.db.runAsync(`
  UPDATE ${this.prefix}entries 
  SET embedding_blob = NULL, embedding = NULL
  WHERE id = ? AND entity_id = ?
`, [factId, entityId]);

// MUST await to ensure ANN cleanup before forget() resolves
await this._notifyEmbeddingPersisted(entityId, factId, null);
```

**B. `_doPrune()` — hard-delete path**

After `DELETE FROM entries WHERE deleted_at IS NOT NULL`:

```typescript
for (const row of rowsToDelete) {
  // MUST await to ensure ANN cleanup before SQLite row deletion
  await this._notifyEmbeddingPersisted(row.entity_id, row.id, null);
}

await this.db.runAsync(`
  DELETE FROM ${this.prefix}entries 
  WHERE deleted_at IS NOT NULL AND deleted_at < ?
`, [pruneThreshold]);
```

**C. Any other `embedding_blob = NULL` updates**

Audit WikiMemory.ts for all `UPDATE ... SET embedding_blob = NULL` and `DELETE FROM entries` queries. Add awaited hook calls where embeddings are cleared for deletion (not reembed/migration).

**Performance impact:** Adds latency to delete operations proportional to ANN cleanup time. For sqlite-vec (in-process), adds <10ms. For remote ANN, may add 100-500ms. This is acceptable for GDPR compliance — deletes are infrequent compared to reads.

**Testing:** Verify `forget()` and `_doPrune()` don't resolve until mock `onEmbeddingPersisted` completes (use 100ms delay in mock).

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
 */
private _sanitizeRankerError(err: Error): Error {
  if (this.options.sanitizeRankerErrors === false) {
    return err; // Host opted out of sanitization
  }
  
  // Create minimal error with only type information
  const sanitized = new Error(
    `VectorRanker ${err.constructor.name || 'Error'} (message scrubbed for security)`
  );
  sanitized.name = err.constructor.name || 'Error';
  // Do NOT copy .message, .stack, or other properties that may leak credentials
  return sanitized;
}
```

**C. Apply at error.cause assignment (line ~1074):**

```typescript
if (this.options.propagateRankerFailureToRetrievalFallback) {
  const mirrored = new Error('Vector ranker failed, falling back');
  (mirrored as any).cause = this._sanitizeRankerError(rankerError);
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

**Note:** Core provides defensive copies as of v3.x, but adapters should still treat vectors as immutable for forward compatibility.
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
```

---

## Documentation Updates

### README.md

Add subsection after "Pluggable Vector Retrieval" (after line ~258):

```markdown
### Security Considerations

When implementing custom `VectorRanker` adapters, follow secure coding practices to prevent SQL injection, credential leakage, and tenant isolation violations. See [SECURITY.md](../../SECURITY.md) for detailed guidance.

Core provides `sanitizeRankerErrors: true` (default) to strip sensitive data from ranker errors before passing to host callbacks. Disable only when you control the ranker implementation.
```

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

**WikiOptions.sanitizeRankerErrors:**

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

### CHANGELOG.md

Add patch entry under "Unreleased" or next version:

```markdown
### Security

* **core:** add defensive copies for VectorRanker queryVec/vector to prevent buffer mutation
* **core:** await onEmbeddingPersisted on deletion paths for GDPR compliance
* **core:** add sanitizeRankerErrors option (default true) to prevent credential leakage via error.cause
* **docs:** add SECURITY.md with VectorRanker adapter security guidance (SQL injection, credential scrubbing, entity isolation)
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

**Test 2: vector mutation in onEmbeddingPersisted doesn't corrupt cache**

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
  await wikiMemory.upsert('entity1', { content: 'test fact', source: 'test' });

  // Verify hook received a copy (mutation didn't affect cache)
  expect(capturedVector).not.toBeNull();
  expect(capturedVector![0]).toBe(-999); // Hook's mutation applied to copy

  // Read should use uncorrupted vector from cache
  const result = await wikiMemory.read('entity1', 'test query');
  expect(result.facts.length).toBeGreaterThan(0);
  // Cosine similarity with corrupted vector would produce nonsense scores
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
  const causeMessage = (capturedError as any).cause.message;
  
  // Should NOT contain the secret key
  expect(causeMessage).not.toContain('sk_live_secret123');
  expect(causeMessage).toContain('VectorRanker Error');
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

- [ ] Defensive copies implemented at all 3 sites (rankBySimilarity, onEmbeddingPersisted, _rankWithJsCosine)
- [ ] Mutation detection tests pass (queryVec and vector corruption prevented)
- [ ] Deletion hooks awaited in forget(), _doPrune(), and any other deletion paths
- [ ] Deletion ordering tests pass (hooks complete before forget/prune resolve)
- [ ] `WikiOptions.sanitizeRankerErrors` added with default `true`
- [ ] Error sanitization tests pass (credentials scrubbed when enabled, preserved when disabled)
- [ ] SECURITY.md created at project root with all 3 sections (reporting, adapter security, host security)
- [ ] README.md security subsection added with SECURITY.md link
- [ ] types.ts JSDoc updated for queryVec, vector, onEmbeddingPersisted, sanitizeRankerErrors
- [ ] CHANGELOG.md security section added
- [ ] All existing VectorRanker tests still pass (no regressions)
- [ ] Performance benchmarks confirm defensive copies add <10μs overhead per read()

---

## Migration Notes

**For existing VectorRanker adapter authors:**

- No API changes required — defensive copies transparent to adapters
- Review SECURITY.md guidance and audit your implementation
- Ensure thrown errors don't leak credentials (core sanitization is defense-in-depth, not primary mitigation)
- If your adapter modifies `queryVec` or `vector` in-place (unlikely), stop doing so

**For host applications:**

- `sanitizeRankerErrors: true` is now default — opt out only if you control ranker code
- Deletion operations (forget, prune) may take slightly longer due to awaited hooks
- No action required for most deployments

---

## References

- Original spec: [`2026-05-07-pluggable-vector-retrieval.md`](2026-05-07-pluggable-vector-retrieval.md)
- OWASP Top 10: https://owasp.org/www-project-top-ten/
- GDPR Right to Erasure: https://gdpr-info.eu/art-17-gdpr/
