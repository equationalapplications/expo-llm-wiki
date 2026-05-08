# VectorRanker Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden VectorRanker integration against buffer mutation, credential leakage, and silent deletion-hook failures, plus ship adapter-author security guidance.

**Architecture:** Centralize defensive `Float32Array.slice()` copies at three chokepoints in `WikiMemory.ts` (one hook helper, two ranker entry points). Split notify helper into best-effort silent variant (existing) and GDPR-strict awaited+rethrown variant (new) for deletion paths. Add `WikiOptions.sanitizeRankerErrors` (default true) and a private `_sanitizeRankerError` to scrub credentials before exposing via `error.cause`. Introduce `deletionHookTimeoutMs` and `forceDeleteIgnoreRankerHook` options. Document everything in a new `SECURITY.md` at repo root.

**Tech Stack:** TypeScript, Vitest, expo-sqlite (mock adapter in tests). All changes ship in `packages/core`. Spec source: `docs/superpowers/specs/2026-05-07-vectorranker-security-hardening.md`.

---

## File Structure

**Modify:**
- `packages/core/src/types.ts` — extend `WikiOptions` with three new options + tighten JSDoc on `VectorRankerRankArgs.queryVec`, `VectorRanker.onEmbeddingPersisted`.
- `packages/core/src/WikiMemory.ts` — defensive copies, sanitizer, OrThrow helper, `forget()`/`_doPrune()` rewiring.
- `packages/core/__tests__/vectorRanker.test.ts` — add mutation, deletion-ordering, sanitization test suites.
- `README.md` (repo root) — add Security Considerations subsection.
- `packages/core/README.md` — same subsection with adjusted relative link.
- `CHANGELOG.md` — `[3.2.0]` Security + BREAKING (behavioral) entries.

**Create:**
- `SECURITY.md` (repo root) — vulnerability reporting + adapter security + host application security.

**API surface delta:** `WikiOptions.sanitizeRankerErrors`, `WikiOptions.deletionHookTimeoutMs`, `WikiOptions.forceDeleteIgnoreRankerHook` are the only new public fields. No breaking type changes; defensive copies and OrThrow rewiring are behavioral.

**Note on test API usage:** existing `vectorRanker.test.ts` uses `wiki.importDump(makeDump([...]))` to seed facts and `wiki.forget(entityId, { entryId: factId })` to delete (NOT the `wiki.upsert(entityId, { content, source })` shape used in the spec). Adapt all test code in this plan to the existing helpers — `makeDump`, `keywordEmbed`, `openTestDatabase`, `forget(entityId, { entryId })`. Do NOT invent an `upsert(content,...)` API.

---

## Task 1: Add new `WikiOptions` fields and JSDoc updates

**Files:**
- Modify: `packages/core/src/types.ts` (around the `WikiOptions` interface ending and `VectorRankerRankArgs` / `VectorRanker` interfaces near lines 139–195)

- [ ] **Step 1: Locate `VectorRankerRankArgs` and replace the `queryVec` JSDoc**

Find the existing block near `packages/core/src/types.ts:148` and edit `queryVec`:

```typescript
export interface VectorRankerRankArgs {
  entityId: string;
  /**
   * Query embedding. Treat as readonly — core provides a defensive copy,
   * but adapters MUST NOT mutate this array. Mutation can corrupt
   * WikiMemory's internal vector cache and JS-cosine fallback path.
   */
  queryVec: Float32Array | number[];
  candidateIds?: readonly string[];
  limit: number;
}
```

- [ ] **Step 2: Update `VectorRanker.onEmbeddingPersisted` JSDoc**

Replace the existing JSDoc on `onEmbeddingPersisted` near `packages/core/src/types.ts:181` with:

```typescript
  /**
   * Called after a fact's embedding is successfully persisted to embedding_blob (or cleared).
   * Hosts use this to keep sqlite-vec / external indexes consistent with SQLite as source of truth.
   *
   * On deletion paths (forget, prune, hard-delete), core awaits this hook to ensure ANN cleanup
   * completes before SQLite deletion commits (GDPR compliance). Hook failures or timeouts on
   * those paths reject the deletion call.
   *
   * Treat `vector` as readonly — core provides a defensive copy, but adapters MUST NOT mutate.
   *
   * Optional: if omitted, hosts MUST document "index rebuilt separately" and accept stale ANN until rebuild.
   */
  onEmbeddingPersisted?(event: {
    entityId: string;
    factId: string;
    vector: Float32Array | null; // null = embedding removed / unusable
  }): void | Promise<void>;
```

- [ ] **Step 3: Append three new fields to `WikiOptions`**

Insert AT THE END of the `WikiOptions` interface body (just before its closing `}`):

```typescript
  /**
   * When true (default), sanitize ranker errors before exposing via error.cause
   * to prevent credential leakage in host telemetry. Disable only when you
   * control the ranker implementation.
   *
   * Sanitization replaces error message/stack with a generic message preserving
   * only the error type (constructor name).
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
```

- [ ] **Step 4: Verify the package still typechecks**

Run: `cd packages/core && npx tsc --noEmit`
Expected: no errors. (No runtime code touches these fields yet, so this is a pure type/JSDoc commit.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): add sanitizeRankerErrors, deletionHookTimeoutMs, forceDeleteIgnoreRankerHook options"
```

---

## Task 2: Add `_sanitizeRankerError` helper

**Files:**
- Modify: `packages/core/src/WikiMemory.ts` (add private method near other ranker helpers, e.g. just above `_rankWithJsCosine` at line ~1251)
- Test: `packages/core/__tests__/vectorRanker.test.ts`

- [ ] **Step 1: Write failing test for default sanitization (scrubs API key)**

Append to `packages/core/__tests__/vectorRanker.test.ts` inside a new `describe('Error sanitization', () => { ... })` block:

```typescript
  describe('Error sanitization', () => {
    it('sanitizes ranker errors by default (sanitizeRankerErrors=true)', async () => {
      const db = openTestDatabase();
      let capturedError: Error | undefined;

      const leakyRanker: VectorRanker = {
        async rankBySimilarity() {
          throw new Error('Connection failed: https://api.example.com?key=sk_live_secret123');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: leakyRanker,
        vectorRankerFallback: 'js-cosine',
        propagateRankerFailureToRetrievalFallback: true,
        onRetrievalFallback: (error) => { capturedError = error; },
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await wiki.read('user-1', 'apple');

      expect(capturedError).toBeDefined();
      const cause = (capturedError as Error & { cause?: Error }).cause;
      expect(cause).toBeDefined();
      expect(cause!.message).not.toContain('sk_live_secret123');
      expect(cause!.message).toContain('VectorRanker');
      expect(cause!.message).toContain('scrubbed');
      expect(cause!.name).toBe('Error');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts -t "sanitizes ranker errors by default"`
Expected: FAIL — captured `cause.message` still contains `sk_live_secret123` because the existing implementation at WikiMemory.ts:1074 does `(mirrored as any).cause = rankerError`.

- [ ] **Step 3: Implement `_sanitizeRankerError`**

Insert just above `private async _rankWithJsCosine(args: { ... })` at WikiMemory.ts:1251:

```typescript
  /**
   * Strip potentially sensitive data from ranker errors before exposing to host callbacks.
   * Preserves error type for debugging but removes message/stack that may contain credentials.
   * Recursively sanitizes one level of .cause; deeper chains collapse to type only.
   */
  private _sanitizeRankerError(err: unknown): Error {
    if (this.options.sanitizeRankerErrors === false) {
      return err instanceof Error ? err : new Error(String(err));
    }

    const typeName =
      err instanceof Error
        ? (err.constructor?.name ?? 'Error')
        : typeof err;

    const innerCause =
      err instanceof Error && err.cause !== undefined
        ? new Error(`Caused by: ${(err.cause as Error)?.constructor?.name ?? typeof err.cause}`)
        : undefined;

    const sanitized = new Error(
      `VectorRanker ${typeName} (message scrubbed for security)`,
      innerCause ? { cause: innerCause } : undefined,
    );
    sanitized.name = typeName;
    return sanitized;
  }
```

- [ ] **Step 4: Apply sanitizer at error.cause assignment**

At WikiMemory.ts:1072–1075 replace:

```typescript
                if (this.options.propagateRankerFailureToRetrievalFallback) {
                  const mirrored = new Error('Vector ranker failed, falling back');
                  (mirrored as any).cause = rankerError;
                  pendingRankerFallbackError = mirrored;
                }
```

with:

```typescript
                if (this.options.propagateRankerFailureToRetrievalFallback) {
                  const mirrored = new Error('Vector ranker failed, falling back', {
                    cause: this._sanitizeRankerError(rankerError),
                  });
                  pendingRankerFallbackError = mirrored;
                }
```

- [ ] **Step 5: Run sanitization test — expect PASS**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts -t "sanitizes ranker errors by default"`
Expected: PASS.

- [ ] **Step 6: Add and run the non-Error throw test**

Append to the same `describe('Error sanitization')` block:

```typescript
    it('sanitizes non-Error throws without crashing (sanitizer robustness)', async () => {
      const db = openTestDatabase();
      let capturedError: Error | undefined;

      const stringThrowingRanker: VectorRanker = {
        async rankBySimilarity() {
          // eslint-disable-next-line no-throw-literal
          throw 'bare string with secret api_key=abc';
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: stringThrowingRanker,
        vectorRankerFallback: 'js-cosine',
        propagateRankerFailureToRetrievalFallback: true,
        onRetrievalFallback: (error) => { capturedError = error; },
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await wiki.read('user-1', 'apple');

      expect(capturedError).toBeDefined();
      const cause = (capturedError as Error & { cause?: Error }).cause!;
      expect(cause.message).not.toContain('api_key=abc');
      expect(cause.message).toContain('VectorRanker string');
    });
```

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts -t "sanitizes non-Error throws"`
Expected: PASS.

- [ ] **Step 7: Add and run the opt-out test**

Append:

```typescript
    it('preserves original error when sanitizeRankerErrors=false', async () => {
      const db = openTestDatabase();
      let capturedError: Error | undefined;

      const leakyRanker: VectorRanker = {
        async rankBySimilarity() {
          throw new Error('Detailed error with api_key=secret123');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: leakyRanker,
        vectorRankerFallback: 'js-cosine',
        sanitizeRankerErrors: false,
        propagateRankerFailureToRetrievalFallback: true,
        onRetrievalFallback: (error) => { capturedError = error; },
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await wiki.read('user-1', 'apple');

      expect(capturedError).toBeDefined();
      const cause = (capturedError as Error & { cause?: Error }).cause!;
      expect(cause.message).toContain('api_key=secret123');
    });
```

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts -t "preserves original error"`
Expected: PASS.

- [ ] **Step 8: Run the whole vectorRanker suite to confirm no regressions**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/WikiMemory.ts packages/core/__tests__/vectorRanker.test.ts
git commit -m "feat(core): sanitize VectorRanker errors before mirroring via error.cause"
```

---

## Task 3: Centralize defensive copy in `_notifyEmbeddingPersisted`

**Files:**
- Modify: `packages/core/src/WikiMemory.ts:488–490` (helper body)
- Test: `packages/core/__tests__/vectorRanker.test.ts`

- [ ] **Step 1: Write failing mutation-protection test**

Append a new `describe('Buffer mutation protection', () => { ... })` block at the end of `vectorRanker.test.ts`:

```typescript
  describe('Buffer mutation protection', () => {
    it('protects vector from mutation by onEmbeddingPersisted hook', async () => {
      const db = openTestDatabase();
      let capturedVector: Float32Array | null = null;

      const maliciousRanker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted(event) {
          if (event.vector) {
            capturedVector = event.vector;
            event.vector[0] = -999; // Attempt corruption
          }
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: maliciousRanker,
        vectorRankerFallback: 'js-cosine',
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      // Read once to trigger embedding persistence + hook.
      await wiki.read('user-1', 'apple');

      // 1. Hook saw a Float32Array and mutated it locally.
      expect(capturedVector).not.toBeNull();
      expect(capturedVector![0]).toBe(-999);

      // 2. Persisted blob in SQLite is NOT corrupted.
      const row = await db.getFirstAsync<{ embedding_blob: Uint8Array | null }>(
        `SELECT embedding_blob FROM entries WHERE id = ?`,
        ['fact-a'],
      );
      expect(row?.embedding_blob).toBeTruthy();
      const persisted = new Float32Array(
        row!.embedding_blob!.buffer,
        row!.embedding_blob!.byteOffset,
        row!.embedding_blob!.byteLength / 4,
      );
      expect(persisted[0]).not.toBe(-999);
      expect(persisted[0]).toBe(1); // keywordEmbed('apple fruit') = [1,0,0]
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts -t "protects vector from mutation by onEmbeddingPersisted"`
Expected: FAIL — `persisted[0]` is `-999` because the same Float32Array buffer was passed to the hook.

- [ ] **Step 3: Add defensive copy inside `_notifyEmbeddingPersisted`**

Replace WikiMemory.ts:488–490:

```typescript
  private async _notifyEmbeddingPersisted(entityId: string, factId: string, vector: Float32Array | null): Promise<void> {
    await this.options.vectorRanker?.onEmbeddingPersisted?.({ entityId, factId, vector });
  }
```

with:

```typescript
  private async _notifyEmbeddingPersisted(
    entityId: string,
    factId: string,
    vector: Float32Array | null,
  ): Promise<void> {
    if (!this.options.vectorRanker?.onEmbeddingPersisted) return;
    // Defensive copy prevents hooks from mutating cache/fallback/persisted-blob vectors.
    // .slice() on Float32Array allocates a fresh ArrayBuffer (not a view).
    const vectorCopy = vector ? vector.slice() : null;
    await this.options.vectorRanker.onEmbeddingPersisted({
      entityId,
      factId,
      vector: vectorCopy,
    });
  }
```

- [ ] **Step 4: Run mutation test — expect PASS**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts -t "protects vector from mutation by onEmbeddingPersisted"`
Expected: PASS.

- [ ] **Step 5: Run full vectorRanker suite**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/WikiMemory.ts packages/core/__tests__/vectorRanker.test.ts
git commit -m "feat(core): defensive copy of embedding vector before onEmbeddingPersisted hook"
```

---

## Task 4: Defensive copy of `queryVec` in ranker entry points

**Files:**
- Modify: `packages/core/src/WikiMemory.ts` — `_rankWithVectorRanker` body near line 1328 and `_rankWithJsCosine` body near line 1251.
- Test: `packages/core/__tests__/vectorRanker.test.ts`

- [ ] **Step 1: Write failing test for queryVec mutation protection**

Append to `describe('Buffer mutation protection', ...)`:

```typescript
    it('protects queryVec from mutation by ranker (subsequent reads still work)', async () => {
      const db = openTestDatabase();
      let mutationAttempted = false;

      const maliciousRanker: VectorRanker = {
        async rankBySimilarity(args) {
          mutationAttempted = true;
          // Attempt to corrupt queryVec
          if (args.queryVec instanceof Float32Array) {
            args.queryVec[0] = 999;
          } else {
            (args.queryVec as number[])[0] = 999;
          }
          throw new Error('Ranker failed after mutation');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: maliciousRanker,
        vectorRankerFallback: 'js-cosine',
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
        { id: 'fact-b', title: 'car vehicle', body: 'fast engine' },
      ]));

      const r1 = await wiki.read('user-1', 'apple');
      expect(mutationAttempted).toBe(true);
      expect(r1.facts[0].id).toBe('fact-a');

      // Second read uses a fresh embedding; if the FIRST queryVec leaked into a
      // shared cache, subsequent ranking would be corrupt.
      const r2 = await wiki.read('user-1', 'apple');
      expect(r2.facts[0].id).toBe('fact-a');
    });
```

- [ ] **Step 2: Run test to verify it currently passes (regression baseline) or fails**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts -t "protects queryVec from mutation by ranker"`
Expected: PASS or FAIL is acceptable here — the test mainly guards the contract going forward. If it passes, we still add copies for symmetry and to lock in the contract. (Note in commit message which one happened.)

- [ ] **Step 3: Add defensive copy at `_rankWithVectorRanker` entry**

In `_rankWithVectorRanker` (WikiMemory.ts:1328), find the `await ranker.rankBySimilarity({ ... })` call and wrap `queryVec` immediately above it:

```typescript
    const queryVecCopy = args.queryVec instanceof Float32Array
      ? args.queryVec.slice()
      : Array.from(args.queryVec);

    const rankerResults = await ranker.rankBySimilarity({
      entityId,
      queryVec: queryVecCopy,
      candidateIds,
      limit,
    });
```

(Keep the rest of the method unchanged — `entityId`, `candidateIds`, `limit` are read from the destructured `args` already.)

- [ ] **Step 4: Add defensive copy at `_rankWithJsCosine` entry**

In `_rankWithJsCosine` (WikiMemory.ts:1251), at the top of the method body — after destructuring args and before any cosine math:

```typescript
    const queryVec = args.queryVec instanceof Float32Array
      ? args.queryVec.slice()
      : Array.from(args.queryVec);
```

Then update the rest of the method body to reference the local `queryVec` instead of `args.queryVec`. (Search-and-replace `args.queryVec` → `queryVec` within this method only.)

- [ ] **Step 5: Run mutation tests + the full vectorRanker suite**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts`
Expected: all tests pass, including both mutation-protection tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/WikiMemory.ts packages/core/__tests__/vectorRanker.test.ts
git commit -m "feat(core): defensive copy of queryVec at ranker and JS-cosine entry points"
```

---

## Task 5: Add `_notifyEmbeddingPersistedOrThrow` helper

**Files:**
- Modify: `packages/core/src/WikiMemory.ts` (insert immediately after `_notifyEmbeddingPersisted` at line ~498)

- [ ] **Step 1: Write failing test asserting helper exists and times out**

Append to `vectorRanker.test.ts` inside a new `describe('Deletion hook ordering', () => { ... })` block:

```typescript
  describe('Deletion hook ordering', () => {
    it('aborts deletion when hook exceeds deletionHookTimeoutMs', async () => {
      const db = openTestDatabase();
      const slowRanker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted(event) {
          if (event.vector === null) {
            await new Promise((r) => setTimeout(r, 5000));
          }
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: slowRanker,
        deletionHookTimeoutMs: 100,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await expect(wiki.forget('user-1', { entryId: 'fact-a' })).rejects.toThrow(/timed out/);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts -t "aborts deletion when hook exceeds"`
Expected: FAIL — current `forget()` swallows hook errors and never times out.

(Implementation of the timeout is split: the helper lands here in Task 5, but it isn't wired into `forget()` until Task 6. Leave the test failing until then; mark this step complete and move on.)

- [ ] **Step 3: Implement helper**

Insert directly after `_notifyEmbeddingPersisted` (right after the closing brace of that method around WikiMemory.ts:498):

```typescript
  /**
   * GDPR-critical variant: awaits the hook with a timeout and rethrows failures.
   * Use ONLY on deletion paths where ANN cleanup must succeed before SQLite commit.
   * For best-effort index sync (reembed, migration), use _notifyEmbeddingPersisted.
   */
  private async _notifyEmbeddingPersistedOrThrow(
    entityId: string,
    factId: string,
    vector: Float32Array | null,
  ): Promise<void> {
    if (!this.options.vectorRanker?.onEmbeddingPersisted) return;
    if (this.options.forceDeleteIgnoreRankerHook === true) return;

    const vectorCopy = vector ? vector.slice() : null;
    const timeoutMs = this.options.deletionHookTimeoutMs ?? 30_000;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`onEmbeddingPersisted timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      await Promise.race([
        Promise.resolve(
          this.options.vectorRanker.onEmbeddingPersisted({
            entityId,
            factId,
            vector: vectorCopy,
          }),
        ),
        timeoutPromise,
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
```

- [ ] **Step 4: Verify the package typechecks**

Run: `cd packages/core && npx tsc --noEmit`
Expected: no errors. (Helper is currently unused — that is fine; Task 6 wires it in.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/WikiMemory.ts
git commit -m "feat(core): add _notifyEmbeddingPersistedOrThrow helper with timeout"
```

---

## Task 6: Wire `forget()` to use OrThrow helper

**Files:**
- Modify: `packages/core/src/WikiMemory.ts:2499–2505` (the `try { await this._notifyEmbeddingPersisted(...); } catch { console.warn(...); }` block inside `forget()`)
- Test: `packages/core/__tests__/vectorRanker.test.ts`

- [ ] **Step 1: Add failing test — forget() rethrows on hook failure**

Append to `describe('Deletion hook ordering')`:

```typescript
    it('rethrows onEmbeddingPersisted failure on forget()', async () => {
      const db = openTestDatabase();
      const failingRanker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted(event) {
          if (event.vector === null) throw new Error('ANN cleanup failed');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: failingRanker,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await expect(wiki.forget('user-1', { entryId: 'fact-a' })).rejects.toThrow();
    });

    it('skips hook entirely when forceDeleteIgnoreRankerHook=true', async () => {
      const db = openTestDatabase();
      let hookCalled = false;
      const ranker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted() {
          hookCalled = true;
          throw new Error('would have failed');
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: ranker,
        forceDeleteIgnoreRankerHook: true,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await expect(wiki.forget('user-1', { entryId: 'fact-a' })).resolves.toBeDefined();
      expect(hookCalled).toBe(false);
    });

    it('awaits onEmbeddingPersisted before forget() resolves', async () => {
      const db = openTestDatabase();
      let hookCalledAt = 0;
      let hookCompleted = false;

      const delayedRanker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted() {
          hookCalledAt = Date.now();
          await new Promise((r) => setTimeout(r, 100));
          hookCompleted = true;
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: delayedRanker,
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      ]));

      await wiki.forget('user-1', { entryId: 'fact-a' });
      const forgetResolvedAt = Date.now();
      expect(hookCompleted).toBe(true);
      expect(forgetResolvedAt - hookCalledAt).toBeGreaterThanOrEqual(95);
    });
```

- [ ] **Step 2: Run new tests to verify failures**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts -t "Deletion hook ordering"`
Expected: at least the "rethrows" and "aborts deletion when hook exceeds" tests fail; "skips hook entirely" may pass or fail depending on existing swallow behavior.

- [ ] **Step 3: Replace silent try/catch in `forget()`**

At WikiMemory.ts:2499–2505 the current shape is roughly:

```typescript
        try {
          await this._notifyEmbeddingPersisted(entityId, factId, null);
        } catch (hookErr) {
          console.warn(`[WikiMemory] onEmbeddingPersisted hook failed during forget for ${factId}:`, hookErr);
        }
```

Replace with:

```typescript
        try {
          await this._notifyEmbeddingPersistedOrThrow(entityId, factId, null);
        } catch (hookErr) {
          throw new Error(
            `forget(${entityId}/${factId}) failed: ANN cleanup hook rejected`,
            { cause: this._sanitizeRankerError(hookErr) },
          );
        }
```

- [ ] **Step 4: Run all four deletion-ordering tests — expect PASS**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts -t "Deletion hook ordering"`
Expected: all four tests pass.

- [ ] **Step 5: Run full vectorRanker suite**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/WikiMemory.ts packages/core/__tests__/vectorRanker.test.ts
git commit -m "feat(core)!: forget() rethrows onEmbeddingPersisted hook failures (GDPR)"
```

---

## Task 7: Reorder `_doPrune()` and implement partial-failure contract

**Files:**
- Modify: `packages/core/src/WikiMemory.ts` around the `_doPrune` body that currently calls `_notifyEmbeddingPersisted` at line 763.
- Test: `packages/core/__tests__/vectorRanker.test.ts`

Before editing, read the surrounding 60 lines of `_doPrune()` (from ~line 720 to ~line 800) to understand the current loop and DELETE statement shape. The plan below shows the *target* shape — adjust column names (`entity_id`, `id`) and table alias (`this.prefix + 'entries'`) to match the existing query.

- [ ] **Step 1: Add failing test — prune awaits hook for each row**

Append to `describe('Deletion hook ordering')`:

```typescript
    it('awaits onEmbeddingPersisted during prune hard-delete', async () => {
      const db = openTestDatabase();
      let hookCallCount = 0;

      const trackingRanker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted(event) {
          if (event.vector === null) {
            hookCallCount++;
            await new Promise((r) => setTimeout(r, 20));
          }
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: trackingRanker,
        config: { pruneRetainSoftDeletedFor: 0 },
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
        { id: 'fact-b', title: 'apple seed', body: 'small and brown' },
      ]));

      await wiki.forget('user-1', { entryId: 'fact-a' });
      await wiki.forget('user-1', { entryId: 'fact-b' });

      const before = hookCallCount;
      await wiki.runPrune('user-1');
      expect(hookCallCount).toBeGreaterThan(before);
    });
```

- [ ] **Step 2: Add failing test — partial prune failure commits successful rows**

```typescript
    it('commits partial prune progress and reports aggregate failure', async () => {
      const db = openTestDatabase();
      let callIndex = 0;

      const flakyRanker: VectorRanker = {
        async rankBySimilarity() { return []; },
        async onEmbeddingPersisted(event) {
          if (event.vector === null) {
            callIndex++;
            if (callIndex === 3) throw new Error('ANN flake on row 3');
          }
        },
      };

      const wiki = new WikiMemory(db, {
        llmProvider: { generateText: async () => '{}', embed: async (t) => keywordEmbed(t) },
        vectorRanker: flakyRanker,
        config: { pruneRetainSoftDeletedFor: 0 },
      });
      await wiki.setup();
      await wiki.importDump(makeDump([
        { id: 'fact-0', title: 'apple a', body: 'x' },
        { id: 'fact-1', title: 'apple b', body: 'x' },
        { id: 'fact-2', title: 'apple c', body: 'x' },
        { id: 'fact-3', title: 'apple d', body: 'x' },
        { id: 'fact-4', title: 'apple e', body: 'x' },
      ]));

      // Soft-delete via forget(); the test's flakyRanker only fails when callIndex===3,
      // and forget() is index 1,2 (not 3) so soft-deletes succeed for all 5 rows.
      // Reset callIndex AFTER setup so the prune phase observes index 1..N.
      for (let i = 0; i < 5; i++) {
        await wiki.forget('user-1', { entryId: `fact-${i}` }).catch(() => {});
      }
      callIndex = 0;

      await expect(wiki.runPrune('user-1')).rejects.toThrow(/partially failed|partial/i);

      // Some rows remain (the failing one + ones after it).
      const remaining = await db.getAllAsync<{ id: string }>(
        `SELECT id FROM entries WHERE deleted_at IS NOT NULL`,
      );
      expect(remaining.length).toBeGreaterThan(0);
    });
```

- [ ] **Step 3: Run new prune tests to verify failures**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts -t "during prune hard-delete|partial prune"`
Expected: both fail (current `_doPrune` deletes first then notifies silently).

- [ ] **Step 4: Rewrite the hook-and-delete portion of `_doPrune()`**

Inside `_doPrune()`, find the loop that currently soft-or-hard deletes rows and the swallowing notify call at WikiMemory.ts:763. Replace the order so the hook runs BEFORE the SQL DELETE, accumulates successes, then deletes only successful rows, then throws on failure. Target shape:

```typescript
    const succeeded: Array<{ entity_id: string; id: string }> = [];
    let failure: { factId: string; cause: unknown } | null = null;

    for (const row of rowsToDelete) {
      try {
        await this._notifyEmbeddingPersistedOrThrow(row.entity_id, row.id, null);
        succeeded.push({ entity_id: row.entity_id, id: row.id });
      } catch (err) {
        failure = { factId: row.id, cause: err };
        break;
      }
    }

    if (succeeded.length > 0) {
      const placeholders = succeeded.map(() => '?').join(',');
      await this.db.runAsync(
        `DELETE FROM ${this.prefix}entries WHERE id IN (${placeholders})`,
        succeeded.map((r) => r.id),
      );
    }

    if (failure) {
      const remaining = rowsToDelete.length - succeeded.length - 1;
      throw new Error(
        `Prune partially failed: deleted ${succeeded.length}, failed at ${failure.factId}, ${remaining} remaining`,
        { cause: this._sanitizeRankerError(failure.cause) },
      );
    }
```

(If the existing `_doPrune` queries different columns or drives the DELETE through a helper, preserve those — only change the *ordering* and the *failure-handling* shape.)

- [ ] **Step 5: Run prune tests — expect PASS**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts -t "during prune hard-delete|partial prune"`
Expected: both pass.

- [ ] **Step 6: Run full vectorRanker suite**

Run: `cd packages/core && npx vitest run __tests__/vectorRanker.test.ts`
Expected: all tests pass.

- [ ] **Step 7: Run the full core test suite to catch regressions in other prune tests**

Run: `cd packages/core && npx vitest run`
Expected: all tests pass. If any pre-existing prune test relies on silent hook failure, surface the failure and decide whether to update the test (the new behavior is intentional and BREAKING per CHANGELOG).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/WikiMemory.ts packages/core/__tests__/vectorRanker.test.ts
git commit -m "feat(core)!: _doPrune awaits hook before DELETE; partial-failure contract"
```

---

## Task 8: Create `SECURITY.md` at repo root

**Files:**
- Create: `SECURITY.md` (repo root, NOT inside a package)

- [ ] **Step 1: Write the file**

Create `SECURITY.md` with the following content (this is the full file — keep all three sections together):

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

## VectorRanker Adapter Security

If you are implementing a custom `VectorRanker` adapter (for sqlite-vec, external ANN, or other backends), follow these security practices:

### SQL Injection Prevention

**Problem:** `entityId` and `factId` passed to `rankBySimilarity` and `onEmbeddingPersisted` flow from untrusted user input. Never concatenate these values into SQL strings.

**Vulnerable code:**

\`\`\`typescript
// NEVER DO THIS
const sql = `SELECT * FROM vec_facts WHERE entity_id = '${entityId}'`;
const rows = await db.getAllAsync(sql);
\`\`\`

**Secure code:**

\`\`\`typescript
// ALWAYS use parameterized queries
const sql = `SELECT * FROM vec_facts WHERE entity_id = ?`;
const rows = await db.getAllAsync(sql, [entityId]);
\`\`\`

**Applies to:** Any SQL or NoSQL query construction. Use parameterized queries, prepared statements, or ORM query builders. Never string concatenation or template literals.

**Bind parameter limits:** SQLite caps bind parameters at `SQLITE_MAX_VARIABLE_NUMBER` (999 prior to 3.32, 32766 after). When `candidateIds.length` is large, chunk the IN clause:

\`\`\`typescript
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
\`\`\`

### Credential Scrubbing in Errors

**Problem:** Errors thrown from `rankBySimilarity` may be logged by host applications via `onVectorRankerFallback` or `onRetrievalFallback`. Connection strings, API keys, or tokens in error messages will leak into telemetry.

**Vulnerable code:**

\`\`\`typescript
throw new Error(`ANN request failed: https://api.example.com/search?key=sk_live_abc123`);
\`\`\`

**Secure code:**

\`\`\`typescript
const sanitizedUrl = url.replace(/key=[^&]+/, 'key=REDACTED');
throw new Error(`ANN request failed: ${sanitizedUrl}`);
// Or use a generic error
throw new Error(`ANN request failed (connection error)`);
\`\`\`

**Applies to:** All thrown errors, especially network errors with URLs, authentication errors with tokens, or database connection errors.

**Note:** Core provides `sanitizeRankerErrors: true` (default) as defense-in-depth, but adapters should scrub credentials at the source.

### Entity Isolation

**Problem:** When `candidateIds` is `undefined` (full-entity scan), the ranker MUST enforce `entityId` scoping in backing-store queries. Failing to filter by `entityId` violates tenant isolation — the ranker may return facts from other entities.

**Vulnerable code:**

\`\`\`typescript
async rankBySimilarity(args) {
  const { queryVec, limit } = args;
  // Missing entityId filter — returns facts across ALL entities
  return db.getAllAsync(`SELECT id, similarity FROM vec_facts LIMIT ?`, [limit]);
}
\`\`\`

**Secure code:**

\`\`\`typescript
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
\`\`\`

**Applies to:** All ranker implementations. Always filter by `entityId` unless your backing store is partitioned per-entity (then document the partitioning strategy).

### Mutation Contract

**Problem:** Core passes `queryVec` and `vector` to adapter methods. Mutating these arrays can corrupt WikiMemory's internal vector cache or fallback paths.

**Guidance:** Treat `queryVec` and `vector` as readonly. Do not call `.set()`, assign to indices, or pass them to functions that mutate in-place.

**Note:** Core provides defensive copies as of v3.2, but adapters should still treat vectors as immutable for forward compatibility.

### Resource Limits and Retention (DoS Prevention)

**Problem:** Adapter receives `limit` and `candidateIds` from core but core does not cap their size. Unbounded values from a misconfigured host can exhaust memory or CPU. Retaining `vector` references past the callback prevents GC of large embeddings.

**Guidance for adapters:**

- **Cap `limit`:** Reject or clamp values above a backend-appropriate maximum (e.g., 10_000 for in-memory, 1_000 for remote ANN).
- **Cap `candidateIds.length`:** Same — chunk per the SQL injection guidance above and reject pathological inputs.
- **Do NOT retain `vector`:** The `Float32Array` passed to `onEmbeddingPersisted` may be 1.5 KB–6 KB. If the adapter stores the reference (e.g., in a closure, queue, or memo cache without TTL), GC is blocked. Copy what you need, then drop the reference before returning.
- **Cap embedding dimension:** Validate `vector.length` matches your index dimension. Reject mismatches loudly — silent acceptance corrupts the index.

\`\`\`typescript
async onEmbeddingPersisted({ entityId, factId, vector }) {
  if (vector && vector.length !== EXPECTED_DIM) {
    throw new Error(`Vector dim mismatch: expected ${EXPECTED_DIM}, got ${vector.length}`);
  }
  await this.index.upsert(entityId, factId, vector ? Array.from(vector) : null);
  // vector goes out of scope here — GC eligible
}
\`\`\`

### Tenant Isolation: Timing and Existence Leaks

**Problem:** `entityId` filtering in queries (above) prevents cross-tenant data return, but two side channels can still leak information:

1. **Timing oracle:** If the adapter's query latency depends on cross-tenant data size (e.g., scanning a shared index), an attacker measuring response times can infer the existence of facts in other tenants.
2. **Error existence leaks:** When `vectorRankerFallback: 'throw'` is configured, ranker errors propagate to the caller. If error messages embed counts ("0 of 50000 candidates matched") or backend-specific identifiers, they reveal cross-tenant index size.

**Guidance:**

- Prefer per-entity partitions / namespaces in the backing store over shared indexes with WHERE filters. Partitioned queries have constant latency relative to other tenants' data.
- Strip counts, internal IDs, and backend metadata from thrown errors. Use generic messages like `"semantic search unavailable"`.
- For high-sensitivity deployments, add small constant-time padding to query latency before returning.

## Host Application Security

If your application uses expo-llm-wiki with VectorRanker:

### Error Sanitization

Enable `sanitizeRankerErrors: true` (default) unless you control the ranker implementation:

\`\`\`typescript
const wikiMemory = new WikiMemory(db, {
  vectorRanker: myRanker,
  sanitizeRankerErrors: true, // default
});
\`\`\`

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

\`\`\`typescript
// Vulnerable: logs full error with potential PII
onRetrievalFallback: (error) => {
  logger.error('Retrieval failed', { error });
}

// Secure: log only type and generic message
onRetrievalFallback: (error) => {
  logger.error('Retrieval failed', {
    errorType: error.constructor.name,
    message: 'Vector search degraded to keyword',
  });
}
\`\`\`

Query text passed to `read()` may be PII. Don't log it unless you have user consent.

### Deletion Policy and Hook Failures

`forget()` and `runPrune()` reject when `onEmbeddingPersisted` throws or exceeds `deletionHookTimeoutMs` (default 30s). This is intentional — silent failure would leave deleted vectors retrievable in external ANN indexes, violating GDPR right-to-erasure.

**Required handling:**

\`\`\`typescript
try {
  await wikiMemory.forget(entityId, { entryId });
} catch (err) {
  // ANN cleanup failed. Options:
  // 1. Retry with backoff (transient ANN outage)
  // 2. Queue for background reconciliation
  // 3. Surface to user as "deletion pending"
  // DO NOT mark deletion complete in your UI.
  enqueueDeletionRetry(entityId, entryId);
  throw err;
}
\`\`\`

**Tuning `deletionHookTimeoutMs`:**

- Interactive UX: 5000 ms (fast feedback, may need user retry)
- Background jobs: 60000 ms (tolerate transient ANN slowdowns)
- High-volume prune: 10000 ms per row (matches batch SLAs)

**`forceDeleteIgnoreRankerHook`:** Use ONLY when the ANN backend is permanently decommissioned and the orphaned vectors will never be queried again. Setting this on a live index breaks GDPR compliance silently — DO NOT use as a workaround for flaky backends.
```

(Note: backticks inside the file are escaped above with `\`` only to keep the plan readable. When writing the actual `SECURITY.md`, use real backticks — drop the backslashes.)

- [ ] **Step 2: Verify file renders sanely**

Run: `head -40 SECURITY.md`
Expected: clean Markdown, top-level `# Security Policy` heading, sections appear in the order Reporting → Adapter → Host.

- [ ] **Step 3: Commit**

```bash
git add SECURITY.md
git commit -m "docs: add SECURITY.md with VectorRanker adapter and host guidance"
```

---

## Task 9: Add Security Considerations subsection to both READMEs

**Files:**
- Modify: `README.md` (repo root)
- Modify: `packages/core/README.md`

- [ ] **Step 1: Locate the "Pluggable Vector Retrieval" section in repo-root README**

Run: `grep -n "Pluggable Vector Retrieval" README.md`
Expected: a single line number near 258. Note that line number for the next step.

- [ ] **Step 2: Insert subsection in repo-root README**

After the end of the Pluggable Vector Retrieval section (find the next `##` or `###` heading after the noted line and insert just before it), add:

```markdown
### Security Considerations

When implementing custom `VectorRanker` adapters, follow secure coding practices to prevent SQL injection, credential leakage, and tenant isolation violations. See [SECURITY.md](./SECURITY.md) for detailed guidance.

Core provides `sanitizeRankerErrors: true` (default) to strip sensitive data from ranker errors before passing to host callbacks. Disable only when you control the ranker implementation.
```

- [ ] **Step 3: Repeat in packages/core/README.md with adjusted relative link**

Run: `grep -n "Pluggable Vector Retrieval" packages/core/README.md`
Expected: a line number identifying the section. Insert the same subsection AFTER it, but change the link target so it points to the repo-root SECURITY.md from the package:

```markdown
### Security Considerations

When implementing custom `VectorRanker` adapters, follow secure coding practices to prevent SQL injection, credential leakage, and tenant isolation violations. See [SECURITY.md](../../SECURITY.md) for detailed guidance.

Core provides `sanitizeRankerErrors: true` (default) to strip sensitive data from ranker errors before passing to host callbacks. Disable only when you control the ranker implementation.
```

- [ ] **Step 4: Verify the relative link resolves**

Run: `ls packages/core/../../SECURITY.md`
Expected: `SECURITY.md` listed (the path resolves to the repo root file from Task 8).

- [ ] **Step 5: Commit**

```bash
git add README.md packages/core/README.md
git commit -m "docs: add Security Considerations subsection to repo and core READMEs"
```

---

## Task 10: Add CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Find or insert the `## [3.2.0]` section**

Run: `grep -n "\[3.2.0\]" CHANGELOG.md`
- If the section already exists, append the entries below to it.
- If not, add a new top-of-file section under whatever the project's heading convention is (mimic the most recent existing version section verbatim for date format and heading style).

- [ ] **Step 2: Add Security and BREAKING entries**

Insert under `## [3.2.0]`:

```markdown
### Security

* **core:** centralize defensive copies for VectorRanker `queryVec` and `vector` to prevent buffer mutation by adapters/hooks
* **core:** await + rethrow `onEmbeddingPersisted` failures on deletion paths (`forget`, `_doPrune`) for GDPR compliance — silent hook failures no longer mask ANN cleanup errors
* **core:** add `sanitizeRankerErrors` option (default `true`) to scrub credentials from ranker errors before exposing via `error.cause`
* **core:** add `deletionHookTimeoutMs` option (default `30000`) to bound deletion latency when ANN backend stalls
* **core:** add `forceDeleteIgnoreRankerHook` escape hatch (default `false`) for permanently-decommissioned ANN backends
* **docs:** add `SECURITY.md` with VectorRanker adapter security guidance (SQL injection, credential scrubbing, entity isolation, DoS prevention, timing leaks)

### BREAKING (behavioral, not API)

* `forget()` and `runPrune()` now reject when `onEmbeddingPersisted` throws or exceeds `deletionHookTimeoutMs`. Previously these errors were swallowed via `console.warn`. Hosts using `VectorRanker.onEmbeddingPersisted` MUST handle deletion errors or set `forceDeleteIgnoreRankerHook: true` (NOT GDPR-safe). See migration notes in `docs/superpowers/specs/2026-05-07-vectorranker-security-hardening.md`.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entries for v3.2.0 security hardening"
```

---

## Task 11: Final regression sweep + acceptance check

- [ ] **Step 1: Run full core test suite**

Run: `cd packages/core && npx vitest run`
Expected: every test passes.

- [ ] **Step 2: Typecheck the entire workspace**

Run: `cd packages/core && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Walk the spec acceptance criteria**

Open `docs/superpowers/specs/2026-05-07-vectorranker-security-hardening.md` and verify each box in the **Acceptance Criteria** section is satisfied. For any unchecked box, open a follow-up task in the plan and resolve before declaring done.

- [ ] **Step 4: Optional micro-benchmark (acceptance bullet "defensive copies add <10μs")**

Add a quick `console.time` around 1000 read() invocations in a throwaway script (or a `it.skip`-annotated benchmark in the test file) and confirm the per-call delta vs. main is sub-millisecond. If the dev environment doesn't support easy benchmarking, document the spot-check in the PR description instead and skip this step.

- [ ] **Step 5: No commit needed**

This is a verification-only task; nothing to add. Proceed to PR creation when satisfied.

---

## Notes for the Implementing Engineer

- **Vitest selection:** all `npx vitest run -t "<pattern>"` commands run from `packages/core`. `-t` matches the `it(...)` description (substring).
- **`(mirrored as any).cause`:** the existing code at WikiMemory.ts:1074 and 1148 uses `as any` casts for `.cause`. Task 2 removes the cast at line 1074 by switching to ES2022 `new Error(msg, { cause })`. Line 1148 is a *different* error path (Phase 2 failure attaching the ranker error after Phase 2 throws); leave it alone unless the suite asks otherwise — modifying it is out of scope for this plan.
- **`importDump` body shape:** test fixture facts use `title` + `body`. `keywordEmbed` keys off the concatenated text — keep `apple` in titles when you need vector matches.
- **Branch:** work happens on `feat/vectorranker-security-hardening` (already checked out at plan time).
- **Spec line numbers vs. current code:** spec was authored against today's `WikiMemory.ts`; verified line numbers 471, 488, 763, 1251, 1328, 2284, 2501 still match. If a future rebase shifts them, search for the function names instead.
