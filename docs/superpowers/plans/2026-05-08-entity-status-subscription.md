# Entity Status Subscription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `WikiMemory.subscribeEntityStatus(entityId, callback)` that pushes `EntityStatus` changes synchronously when ingest / librarian / heal jobs start or finish, with no polling.

**Architecture:** Maintain a `Map<entityId, Set<{callback, last}>>` of subscribers on `WikiMemory`. Add a private `_notifyStatusSubscribers(entityId)` helper that recomputes status via the existing `getEntityStatus` and dispatches only on change, with try/catch isolation and snapshot iteration. Wire the helper after every `EntityStatus`-affecting add/delete: auto-librarian in `write()`, auto-heal in `runLibrarianThenMaybeHeal()`, explicit `runLibrarian()` / `runHeal()`, and ingest add/finally in `ingestDocument()`. Reuse `getEntityStatus` as the single source of truth for the boolean computation.

**Tech Stack:** TypeScript, Vitest, pnpm workspace; `packages/core` (`WikiMemory.ts`, `__tests__/jobs.test.ts`).

**Spec:** [docs/superpowers/specs/2026-05-08-entity-status-subscription.md](../specs/2026-05-08-entity-status-subscription.md)

---

## File Structure

- Modify: [packages/core/src/WikiMemory.ts](../../../packages/core/src/WikiMemory.ts)
  - Add `private statusSubscribers` field next to existing `activeIngestJobs` / `activeMaintenanceJobs` (~line 275-276).
  - Add `private _notifyStatusSubscribers(entityId)` near the existing private key helpers (`_librarianKey`, `_healKey` ~line 488-489) or grouped with other private helpers.
  - Add `public subscribeEntityStatus(entityId, callback)` adjacent to `getEntityStatus` (~line 2199).
  - Insert `_notifyStatusSubscribers` calls at each add/delete pair that flips ingest/librarian/heal:
    - auto-librarian in `write()`
    - auto-heal in `runLibrarianThenMaybeHeal()`
    - explicit `runLibrarian()` and `runHeal()`
    - ingest in `ingestDocument()`
- Create: `packages/core/__tests__/subscribeEntityStatus.test.ts`
  - All 12 test cases listed in the spec. Modeled on existing `jobs.test.ts` (`MockSQLiteDatabase`, `slowProvider`, `freshWiki` helpers — copy them into the new file rather than refactoring `jobs.test.ts`, per established repo pattern).
- Modify: [packages/core/README.md](../../../packages/core/README.md)
  - Add a new `## Entity Status` section (no existing section documents `getEntityStatus`) covering both `getEntityStatus` and `subscribeEntityStatus`. Place after `## Vector Cache` (~line 292) and before `## Security` (~line 305).
- Modify: [CHANGELOG.md](../../../CHANGELOG.md)
  - No manual edit. Semantic-release will generate the entry from the conventional `feat(core):` commit. Verify the commit subject in the final task.

No new files outside the test file. No public type changes.

---

## Task 1: Add subscriber storage and public API skeleton (failing test)

**Files:**
- Test: `packages/core/__tests__/subscribeEntityStatus.test.ts`
- Modify: `packages/core/src/WikiMemory.ts`

- [ ] **Step 1: Create the test file with shared helpers and the initial-emission test**

Create `packages/core/__tests__/subscribeEntityStatus.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import type { EntityStatus } from '../src/types';

class MockSQLiteDatabase {
  async execAsync(_sql: string): Promise<void> {}
  async withTransactionAsync<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
  async runAsync(_sql: string, _args: any[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
    return { changes: 0, lastInsertRowId: 0 };
  }
  async getAllAsync<T>(_sql: string, _args: any[] = []): Promise<T[]> { return [] as T[]; }
  async getFirstAsync<T>(_sql: string, _args: any[] = []): Promise<T | null> { return null; }
}

const slowProvider = (delayMs: number) => ({
  generateText: async (_: any) => {
    await new Promise((r) => setTimeout(r, delayMs));
    return JSON.stringify({ facts: [], tasks: [] });
  },
});

async function freshWiki(provider: any) {
  const db = new MockSQLiteDatabase();
  const wiki = new WikiMemory(db, { llmProvider: provider, config: { tablePrefix: 'sub_' } });
  await wiki.setup();
  return wiki;
}

describe('subscribeEntityStatus — initial emission', () => {
  it('invokes callback synchronously exactly once before returning', async () => {
    const wiki = await freshWiki(slowProvider(0));
    const calls: EntityStatus[] = [];
    let returned = false;
    const unsub = wiki.subscribeEntityStatus('e1', (s) => {
      // captured before subscribe returns
      expect(returned).toBe(false);
      calls.push(s);
    });
    returned = true;
    expect(calls).toEqual([{ ingesting: false, librarian: false, heal: false }]);
    unsub();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @equationalapplications/expo-llm-wiki-core test -- subscribeEntityStatus`
Expected: FAIL — `wiki.subscribeEntityStatus is not a function`.

- [ ] **Step 3: Add subscriber storage field**

In `packages/core/src/WikiMemory.ts`, next to:

```typescript
  private activeMaintenanceJobs = new Set<string>();
  private activeIngestJobs = new Set<string>();
```

Add:

```typescript
  private statusSubscribers = new Map<
    string,
    Set<{ callback: (s: EntityStatus) => void; last: EntityStatus }>
  >();
```

Ensure `EntityStatus` is in the existing `import` from `./types` at the top of the file (it is already imported alongside `WikiBusyError` etc; verify and add if missing).

- [ ] **Step 4: Add `subscribeEntityStatus` public method adjacent to `getEntityStatus`**

Find the existing method:

```typescript
  getEntityStatus(entityId: string): EntityStatus {
    const ingestPrefix = `${this.prefix}:${entityId}:`;
    let ingesting = false;
    for (const k of this.activeIngestJobs) {
      if (k.startsWith(ingestPrefix)) { ingesting = true; break; }
    }
    return {
      ingesting,
      librarian: this.activeMaintenanceJobs.has(this._librarianKey(entityId)),
      heal: this.activeMaintenanceJobs.has(this._healKey(entityId)),
    };
  }
```

Immediately after it, add:

```typescript
  /**
   * Subscribe to {@link EntityStatus} changes for a single entity. The callback
   * is invoked synchronously once with the current status before this method
   * returns, then again on every transition where any of `ingesting`,
   * `librarian`, or `heal` flips. No polling, no duplicate snapshots.
   *
   * Returns an idempotent unsubscribe function.
   *
   * See also {@link getEntityStatus} for a synchronous point-in-time read.
   */
  subscribeEntityStatus(
    entityId: string,
    callback: (status: EntityStatus) => void
  ): () => void {
    const initial = this.getEntityStatus(entityId);
    try { callback(initial); } catch (err) { console.error(err); }

    let set = this.statusSubscribers.get(entityId);
    if (!set) {
      set = new Set();
      this.statusSubscribers.set(entityId, set);
    }
    const entry = { callback, last: initial };
    set.add(entry);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const s = this.statusSubscribers.get(entityId);
      if (!s) return;
      s.delete(entry);
      if (s.size === 0) this.statusSubscribers.delete(entityId);
    };
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @equationalapplications/expo-llm-wiki-core test -- subscribeEntityStatus`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/WikiMemory.ts packages/core/__tests__/subscribeEntityStatus.test.ts
git commit -m "feat(core): add subscribeEntityStatus initial emission scaffold"
```

---

## Task 2: Notifier helper + ingest transition wiring

**Files:**
- Modify: `packages/core/src/WikiMemory.ts`
- Test: `packages/core/__tests__/subscribeEntityStatus.test.ts`

- [ ] **Step 1: Write the failing transition test**

Append to `subscribeEntityStatus.test.ts`:

```typescript
describe('subscribeEntityStatus — ingest transition', () => {
  it('emits ingesting:true on add and ingesting:false on delete, no duplicates', async () => {
    const wiki = await freshWiki(slowProvider(50));
    const calls: EntityStatus[] = [];
    const unsub = wiki.subscribeEntityStatus('e1', (s) => calls.push({ ...s }));
    // initial
    expect(calls).toEqual([{ ingesting: false, librarian: false, heal: false }]);

    const sourceHash = 'a'.repeat(64);
    const p = wiki.ingestDocument('e1', { sourceRef: 'doc1', sourceHash, documentChunk: 'hello world' });
    // give ingest a tick to register
    await new Promise(r => setTimeout(r, 10));
    expect(calls.at(-1)).toEqual({ ingesting: true, librarian: false, heal: false });

    await p;
    expect(calls.at(-1)).toEqual({ ingesting: false, librarian: false, heal: false });
    expect(calls.length).toBe(3); // initial + true + false
    unsub();
  });

  it('does not notify subscribers for a different entity', async () => {
    const wiki = await freshWiki(slowProvider(50));
    const calls: EntityStatus[] = [];
    const unsub = wiki.subscribeEntityStatus('other', (s) => calls.push({ ...s }));

    const sourceHash = 'a'.repeat(64);
    await wiki.ingestDocument('e1', { sourceRef: 'doc1', sourceHash, documentChunk: 'hello' });
    expect(calls.length).toBe(1); // only initial
    unsub();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @equationalapplications/expo-llm-wiki-core test -- subscribeEntityStatus`
Expected: FAIL — second test in the new describe sees only the initial call (no transition emission yet).

- [ ] **Step 3: Add the `_notifyStatusSubscribers` helper**

In `WikiMemory.ts`, group it with other private helpers. Place it just below `_isIngestActiveFor` (currently around line 770):

```typescript
  private _notifyStatusSubscribers(entityId: string): void {
    const set = this.statusSubscribers.get(entityId);
    if (!set || set.size === 0) return;
    const next = this.getEntityStatus(entityId);
    // Snapshot for safe iteration if a callback unsubscribes or subscribes.
    for (const entry of Array.from(set)) {
      if (
        entry.last.ingesting === next.ingesting &&
        entry.last.librarian === next.librarian &&
        entry.last.heal === next.heal
      ) continue;
      entry.last = next;
      try {
        entry.callback(next);
      } catch (err) {
        console.error(err);
      }
    }
  }
```

- [ ] **Step 4: Wire ingest add/delete sites**

In `ingestDocument()`, find:

```typescript
    this.activeIngestJobs.add(jobKey);

    try {
```

Change to:

```typescript
    this.activeIngestJobs.add(jobKey);
    this._notifyStatusSubscribers(entityId);

    try {
```

And find the matching `finally` block at the end of `ingestDocument()`:

```typescript
    } finally {
      this.activeIngestJobs.delete(jobKey);
    }
  }
}
```

Change to:

```typescript
    } finally {
      this.activeIngestJobs.delete(jobKey);
      this._notifyStatusSubscribers(entityId);
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @equationalapplications/expo-llm-wiki-core test -- subscribeEntityStatus`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/WikiMemory.ts packages/core/__tests__/subscribeEntityStatus.test.ts
git commit -m "feat(core): notify entity-status subscribers on ingest transitions"
```

---

## Task 3: Wire auto-librarian transition

**Files:**
- Modify: `packages/core/src/WikiMemory.ts`
- Test: `packages/core/__tests__/subscribeEntityStatus.test.ts`

- [ ] **Step 1: Write the failing librarian transition test**

Append to `subscribeEntityStatus.test.ts`:

```typescript
describe('subscribeEntityStatus — librarian transition', () => {
  it('emits librarian:true then librarian:false when the auto-librarian dispatch runs', async () => {
    const wiki = await freshWiki(slowProvider(30));
    // Drive the auto-dispatch path inside write() by simulating threshold exceeded.
    // The simplest deterministic path: force the activeMaintenanceJobs add/delete
    // pair via the same private helpers the production code uses.
    const calls: EntityStatus[] = [];
    const unsub = wiki.subscribeEntityStatus('e1', (s) => calls.push({ ...s }));

    // Simulate the auto-librarian dispatch the way write() does.
    const key = (wiki as any)._librarianKey('e1');
    (wiki as any).activeMaintenanceJobs.add(key);
    (wiki as any)._notifyStatusSubscribers('e1');
    expect(calls.at(-1)).toEqual({ ingesting: false, librarian: true, heal: false });

    (wiki as any).activeMaintenanceJobs.delete(key);
    (wiki as any)._notifyStatusSubscribers('e1');
    expect(calls.at(-1)).toEqual({ ingesting: false, librarian: false, heal: false });
    expect(calls.length).toBe(3);
    unsub();
  });
});
```

(Direct-helper test is acceptable here because the threshold-driven path requires real DB rows; the spec's acceptance is that the notifier is invoked at the documented add/delete sites — Task 5 covers a higher-level integration check.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @equationalapplications/expo-llm-wiki-core test -- subscribeEntityStatus`
Expected: FAIL — `_notifyStatusSubscribers` is not yet wired into the auto-librarian path; this test currently passes only because we call the helper directly. Re-read the test: it should pass already since we call the helper directly. **Replace** the test above with the real one that drives the production dispatch site:

```typescript
describe('subscribeEntityStatus — auto-librarian dispatch', () => {
  it('notifies on add and delete around the auto-librarian dispatch in write()', async () => {
    // Configure a low threshold so a single write() crosses it.
    const db = new MockSQLiteDatabase();
    // Stub event-count query to return the threshold value.
    (db as any).getFirstAsync = async (sql: string) => {
      if (sql.includes('COUNT(*)')) return { count: 1 };
      return null;
    };
    const wiki = new WikiMemory(db as any, {
      llmProvider: slowProvider(30),
      config: { tablePrefix: 'sub_', autoLibrarianThreshold: 1, autoHealThreshold: 1_000_000 },
    });
    await wiki.setup();

    const calls: EntityStatus[] = [];
    const unsub = wiki.subscribeEntityStatus('e1', (s) => calls.push({ ...s }));
    expect(calls).toEqual([{ ingesting: false, librarian: false, heal: false }]);

    await wiki.write('e1', { eventType: 'observation', summary: 'something happened' } as any);
    // librarian dispatched; wait for it to finish
    await new Promise(r => setTimeout(r, 80));

    const flips = calls.map(c => c.librarian);
    expect(flips).toContain(true);
    expect(flips.at(-1)).toBe(false);
    unsub();
  });
});
```

Run: `pnpm --filter @equationalapplications/expo-llm-wiki-core test -- subscribeEntityStatus`
Expected: FAIL — `librarian:true` never observed because the auto-librarian add/delete sites do not notify yet.

- [ ] **Step 3: Wire the auto-librarian add/delete in `write()`**

Find:

```typescript
        this.activeMaintenanceJobs.add(jobKey);
        this.runLibrarianThenMaybeHeal(entityId, count)
          .catch(console.error)
          .finally(() => this.activeMaintenanceJobs.delete(jobKey));
```

Change to:

```typescript
        this.activeMaintenanceJobs.add(jobKey);
        this._notifyStatusSubscribers(entityId);
        this.runLibrarianThenMaybeHeal(entityId, count)
          .catch(console.error)
          .finally(() => {
            this.activeMaintenanceJobs.delete(jobKey);
            this._notifyStatusSubscribers(entityId);
          });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @equationalapplications/expo-llm-wiki-core test -- subscribeEntityStatus`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/WikiMemory.ts packages/core/__tests__/subscribeEntityStatus.test.ts
git commit -m "feat(core): notify entity-status subscribers on auto-librarian transitions"
```

---

## Task 4: Wire auto-heal transition

**Files:**
- Modify: `packages/core/src/WikiMemory.ts`
- Test: `packages/core/__tests__/subscribeEntityStatus.test.ts`

- [ ] **Step 1: Write the failing heal transition test**

Append to `subscribeEntityStatus.test.ts`:

```typescript
describe('subscribeEntityStatus — auto-heal dispatch', () => {
  it('notifies on add and delete around the auto-heal dispatch', async () => {
    const db = new MockSQLiteDatabase();
    (db as any).getFirstAsync = async (sql: string) => {
      if (sql.includes('COUNT(*)')) return { count: 1 };
      // checkpoint reads return null so deltas always exceed thresholds
      return null;
    };
    const wiki = new WikiMemory(db as any, {
      llmProvider: slowProvider(30),
      config: { tablePrefix: 'sub_', autoLibrarianThreshold: 1, autoHealThreshold: 1 },
    });
    await wiki.setup();

    const calls: EntityStatus[] = [];
    const unsub = wiki.subscribeEntityStatus('e1', (s) => calls.push({ ...s }));

    await wiki.write('e1', { eventType: 'observation', summary: 'x' } as any);
    await new Promise(r => setTimeout(r, 150));

    const healFlips = calls.map(c => c.heal);
    expect(healFlips).toContain(true);
    expect(healFlips.at(-1)).toBe(false);
    unsub();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @equationalapplications/expo-llm-wiki-core test -- subscribeEntityStatus`
Expected: FAIL — `heal:true` never observed.

- [ ] **Step 3: Wire the auto-heal add/delete in `runLibrarianThenMaybeHeal()`**

Find:

```typescript
      const healKey = this._healKey(entityId);
      if (!this.activeMaintenanceJobs.has(healKey)) {
        this.activeMaintenanceJobs.add(healKey);
        try {
          await this._doRunHeal(entityId);
          await this.db.runAsync(`
            INSERT INTO ${this.prefix}checkpoints (entity_id, heal_checkpoint) 
            VALUES (?, ?) 
            ON CONFLICT(entity_id) DO UPDATE SET heal_checkpoint = ?
          `, [entityId, currentEventCount, currentEventCount]);
        } finally {
          this.activeMaintenanceJobs.delete(healKey);
        }
      }
```

Change to:

```typescript
      const healKey = this._healKey(entityId);
      if (!this.activeMaintenanceJobs.has(healKey)) {
        this.activeMaintenanceJobs.add(healKey);
        this._notifyStatusSubscribers(entityId);
        try {
          await this._doRunHeal(entityId);
          await this.db.runAsync(`
            INSERT INTO ${this.prefix}checkpoints (entity_id, heal_checkpoint) 
            VALUES (?, ?) 
            ON CONFLICT(entity_id) DO UPDATE SET heal_checkpoint = ?
          `, [entityId, currentEventCount, currentEventCount]);
        } finally {
          this.activeMaintenanceJobs.delete(healKey);
          this._notifyStatusSubscribers(entityId);
        }
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @equationalapplications/expo-llm-wiki-core test -- subscribeEntityStatus`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/WikiMemory.ts packages/core/__tests__/subscribeEntityStatus.test.ts
git commit -m "feat(core): notify entity-status subscribers on auto-heal transitions"
```

---

## Task 5: No-op write, out-of-scope jobs, and unsubscribe behavior

**Files:**
- Test: `packages/core/__tests__/subscribeEntityStatus.test.ts`

- [ ] **Step 1: Add the suppression and unsubscribe tests**

Append:

```typescript
describe('subscribeEntityStatus — suppression and unsubscribe', () => {
  it('does not invoke callback when booleans are unchanged from last emission', async () => {
    const wiki = await freshWiki(slowProvider(0));
    const calls: EntityStatus[] = [];
    const unsub = wiki.subscribeEntityStatus('e1', (s) => calls.push({ ...s }));
    // Fire the notifier with no actual mutation
    (wiki as any)._notifyStatusSubscribers('e1');
    (wiki as any)._notifyStatusSubscribers('e1');
    expect(calls.length).toBe(1); // only initial
    unsub();
  });

  it('does not notify when only out-of-scope maintenance jobs flip', async () => {
    const wiki = await freshWiki(slowProvider(0));
    const calls: EntityStatus[] = [];
    const unsub = wiki.subscribeEntityStatus('e1', (s) => calls.push({ ...s }));

    const pruneKey = (wiki as any)._pruneKey('e1');
    const reembedKey = (wiki as any)._reembedKey('e1');
    const importKey = (wiki as any)._importKey('e1');
    const forgetKey = (wiki as any)._forgetKey('e1');
    for (const k of [pruneKey, reembedKey, importKey, forgetKey]) {
      (wiki as any).activeMaintenanceJobs.add(k);
      (wiki as any)._notifyStatusSubscribers('e1'); // even if production code mistakenly called it
      (wiki as any).activeMaintenanceJobs.delete(k);
      (wiki as any)._notifyStatusSubscribers('e1');
    }
    expect(calls.length).toBe(1); // only initial
    unsub();
  });

  it('unsubscribe stops further callbacks; second call is a no-op', async () => {
    const wiki = await freshWiki(slowProvider(0));
    const calls: EntityStatus[] = [];
    const unsub = wiki.subscribeEntityStatus('e1', (s) => calls.push({ ...s }));
    unsub();
    expect(() => unsub()).not.toThrow();

    const key = (wiki as any)._librarianKey('e1');
    (wiki as any).activeMaintenanceJobs.add(key);
    (wiki as any)._notifyStatusSubscribers('e1');
    (wiki as any).activeMaintenanceJobs.delete(key);
    (wiki as any)._notifyStatusSubscribers('e1');
    expect(calls.length).toBe(1); // only the initial emission
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @equationalapplications/expo-llm-wiki-core test -- subscribeEntityStatus`
Expected: PASS (8 tests). All should pass without any production change because the notifier already short-circuits on equal status and unsubscribe removes the entry.

- [ ] **Step 3: Commit**

```bash
git add packages/core/__tests__/subscribeEntityStatus.test.ts
git commit -m "test(core): cover no-op, out-of-scope, and unsubscribe semantics"
```

---

## Task 6: Multiple subscribers, isolation, throwing callbacks, re-entrancy

**Files:**
- Test: `packages/core/__tests__/subscribeEntityStatus.test.ts`

- [ ] **Step 1: Add the remaining spec tests**

Append:

```typescript
describe('subscribeEntityStatus — multi-subscriber and re-entrancy', () => {
  it('multiple subscribers on the same entity each receive initial + transitions; unsubscribing one leaves the other', async () => {
    const wiki = await freshWiki(slowProvider(0));
    const callsA: EntityStatus[] = [];
    const callsB: EntityStatus[] = [];
    const unsubA = wiki.subscribeEntityStatus('e1', (s) => callsA.push({ ...s }));
    const unsubB = wiki.subscribeEntityStatus('e1', (s) => callsB.push({ ...s }));
    expect(callsA.length).toBe(1);
    expect(callsB.length).toBe(1);

    const key = (wiki as any)._librarianKey('e1');
    (wiki as any).activeMaintenanceJobs.add(key);
    (wiki as any)._notifyStatusSubscribers('e1');
    expect(callsA.at(-1)?.librarian).toBe(true);
    expect(callsB.at(-1)?.librarian).toBe(true);

    unsubA();
    (wiki as any).activeMaintenanceJobs.delete(key);
    (wiki as any)._notifyStatusSubscribers('e1');
    expect(callsA.length).toBe(2); // unchanged after unsub
    expect(callsB.at(-1)?.librarian).toBe(false);
    unsubB();
  });

  it('cross-entity isolation: jobs on entity "a" never notify subscribers for entity "b"', async () => {
    const wiki = await freshWiki(slowProvider(0));
    const calls: EntityStatus[] = [];
    const unsub = wiki.subscribeEntityStatus('b', (s) => calls.push({ ...s }));
    const key = (wiki as any)._librarianKey('a');
    (wiki as any).activeMaintenanceJobs.add(key);
    (wiki as any)._notifyStatusSubscribers('a');
    (wiki as any).activeMaintenanceJobs.delete(key);
    (wiki as any)._notifyStatusSubscribers('a');
    expect(calls.length).toBe(1); // only initial for 'b'
    unsub();
  });

  it('throwing callback does not break delivery to other subscribers and routes to console.error', async () => {
    const wiki = await freshWiki(slowProvider(0));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const otherCalls: EntityStatus[] = [];

    const unsubBad = wiki.subscribeEntityStatus('e1', () => { throw new Error('boom'); });
    const unsubGood = wiki.subscribeEntityStatus('e1', (s) => otherCalls.push({ ...s }));

    const key = (wiki as any)._librarianKey('e1');
    (wiki as any).activeMaintenanceJobs.add(key);
    (wiki as any)._notifyStatusSubscribers('e1');

    expect(otherCalls.at(-1)?.librarian).toBe(true);
    expect(errSpy).toHaveBeenCalled();
    unsubBad();
    unsubGood();
    errSpy.mockRestore();
  });

  it('unsubscribe during emission prevents the unsubscribed listener from being called for that transition', async () => {
    const wiki = await freshWiki(slowProvider(0));
    const callsB: EntityStatus[] = [];
    let unsubB!: () => void;
    const unsubA = wiki.subscribeEntityStatus('e1', () => {
      // Listener A unsubscribes B during transition emission
      if (unsubB) unsubB();
    });
    unsubB = wiki.subscribeEntityStatus('e1', (s) => callsB.push({ ...s }));
    expect(callsB.length).toBe(1); // initial only

    const key = (wiki as any)._librarianKey('e1');
    (wiki as any).activeMaintenanceJobs.add(key);
    (wiki as any)._notifyStatusSubscribers('e1');

    // B was unsubscribed before the iterator reached it (snapshot still includes B,
    // but the implementation must skip removed entries — verify via no transition delivery).
    // Spec rule 7: B MUST NOT receive the transition.
    expect(callsB.length).toBe(1);
    unsubA();
  });

  it('subscribe during emission gets initial sync and is not invoked again for the same transition', async () => {
    const wiki = await freshWiki(slowProvider(0));
    const callsLate: EntityStatus[] = [];
    let unsubLate: () => void = () => {};
    const unsubA = wiki.subscribeEntityStatus('e1', () => {
      if (callsLate.length === 0) {
        unsubLate = wiki.subscribeEntityStatus('e1', (s) => callsLate.push({ ...s }));
      }
    });

    const key = (wiki as any)._librarianKey('e1');
    (wiki as any).activeMaintenanceJobs.add(key);
    (wiki as any)._notifyStatusSubscribers('e1');

    // Late subscriber received its synchronous initial emission and nothing else.
    expect(callsLate.length).toBe(1);
    expect(callsLate[0].librarian).toBe(true); // current status at subscribe time

    unsubA();
    unsubLate();
  });
});
```

- [ ] **Step 2: Run tests; expect re-entrancy tests to need implementation tweaks**

Run: `pnpm --filter @equationalapplications/expo-llm-wiki-core test -- subscribeEntityStatus`
Expected: The "unsubscribe during emission" test fails because `Array.from(set)` snapshot still iterates B after A removes it.

- [ ] **Step 3: Make the notifier skip removed entries during snapshot iteration**

In `_notifyStatusSubscribers`, change the loop to re-check membership before invoking:

```typescript
    for (const entry of Array.from(set)) {
      if (!set.has(entry)) continue; // unsubscribed during this emission
      if (
        entry.last.ingesting === next.ingesting &&
        entry.last.librarian === next.librarian &&
        entry.last.heal === next.heal
      ) continue;
      entry.last = next;
      try {
        entry.callback(next);
      } catch (err) {
        console.error(err);
      }
    }
```

- [ ] **Step 4: Re-run tests**

Run: `pnpm --filter @equationalapplications/expo-llm-wiki-core test -- subscribeEntityStatus`
Expected: PASS (13 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/WikiMemory.ts packages/core/__tests__/subscribeEntityStatus.test.ts
git commit -m "feat(core): isolate listener errors and re-entrant subscribe/unsubscribe"
```

---

## Task 7: Documentation

**Files:**
- Modify: `packages/core/README.md`

- [ ] **Step 1: Add an `## Entity Status` section**

In `packages/core/README.md`, after the `## Vector Cache` section (~line 292) and before `## Security` (~line 305), insert:

```markdown
## Entity Status

`WikiMemory` exposes the in-flight job state for a single entity through two complementary APIs.

### `getEntityStatus(entityId)`

Synchronous point-in-time snapshot:

```typescript
const status = wiki.getEntityStatus('user-42');
// { ingesting: boolean, librarian: boolean, heal: boolean }
```

Use this when you only need the current value (e.g. inside a request handler).

### `subscribeEntityStatus(entityId, callback)`

Push-based change notification — the callback fires synchronously once with the current status, then again on every transition where any of the three booleans flips. There is no polling and no duplicate snapshots.

```typescript
const unsubscribe = wiki.subscribeEntityStatus('user-42', (status) => {
  console.log(status); // { ingesting, librarian, heal }
});

// Later:
unsubscribe(); // idempotent — safe to call more than once
```

Notes:

- The first invocation happens **before** `subscribeEntityStatus` returns. Treat it as the initial render value.
- Each emission may be a fresh object literal. Do not rely on referential equality between callbacks; equality of the three booleans is the contract.
- A throwing callback is caught (logged via `console.error`) and does not block other subscribers or the underlying job.
- Subscriptions are scoped to a single `entityId`. There is no wildcard or "all entities" form.
```

- [ ] **Step 2: Verify the README still renders cleanly**

Run: `pnpm --filter @equationalapplications/expo-llm-wiki-core build`
Expected: Build succeeds (README is included via tsup config; no markdown linter is configured, so visual inspection is sufficient).

- [ ] **Step 3: Commit**

```bash
git add packages/core/README.md
git commit -m "docs(core): document subscribeEntityStatus alongside getEntityStatus"
```

---

## Task 8: Full test suite + acceptance review

**Files:** none modified.

- [ ] **Step 1: Run the entire core test suite**

Run: `pnpm test`
Expected: All packages green, including the new 13 tests.

- [ ] **Step 2: Self-check against spec acceptance**

Confirm by inspection of `packages/core/src/WikiMemory.ts`:

- `subscribeEntityStatus` is exported on the public class.
- `_notifyStatusSubscribers` is invoked at every `EntityStatus` transition site: `ingestDocument` add + finally, `write()` auto-librarian add + `.finally`, `runLibrarianThenMaybeHeal` auto-heal add + `finally`, `runLibrarian` add + `.finally`, `runHeal` add + `.finally`. Grep to verify:

  Run: `grep -n '_notifyStatusSubscribers' packages/core/src/WikiMemory.ts`
  Expected: one helper definition plus **10** call sites (adjust if implementation adds/removes transition sites).

- `_notifyStatusSubscribers` calls `this.getEntityStatus(entityId)` rather than reimplementing the boolean logic.
- No notifier call exists alongside `prune`, `reembed`, `import`, `forget`, or any global key add/delete.
- `EntityStatus` shape in `packages/core/src/types.ts` is unchanged.

- [ ] **Step 3: Verify the changelog entry will be generated**

Run: `git log --oneline origin/main..HEAD`
Expected: Each commit uses `feat(core):`, `test(core):`, or `docs(core):` per Conventional Commits. Semantic-release will then add an `### Added` entry referencing `subscribeEntityStatus` for the next minor release of the core package — no manual `CHANGELOG.md` edit is needed (this matches the existing repo workflow visible in `CHANGELOG.md`).

- [ ] **Step 4: Push and open the PR referencing issue #8**

```bash
git push -u origin HEAD
gh pr create --fill --body 'Closes #8. Implements docs/superpowers/specs/2026-05-08-entity-status-subscription.md.'
```

---

## Self-Review Notes

- **Spec coverage:** API shape (Task 1), initial emission (Task 1), ingest transition (Task 2), librarian transition (Task 3), heal transition (Task 4), no-op suppression + out-of-scope jobs + unsubscribe idempotency (Task 5), multi-subscriber + cross-entity + throwing callback + unsubscribe-during-emission + subscribe-during-emission (Task 6), README + JSDoc + changelog (Task 7 / Task 8 step 3). All 12 spec test cases mapped.
- **No placeholders:** every code block is the literal text to insert.
- **Type consistency:** `EntityStatus` is the existing `types.ts` interface; `subscribeEntityStatus` signature matches the spec exactly; `_notifyStatusSubscribers(entityId: string): void` used uniformly across tasks.
- **Out-of-scope guard:** Task 8 step 2 explicitly grep-verifies the notifier is not wired into prune/reembed/import/forget paths.
