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

  it('nested subscribe from another subscriber’s initial still gets synchronous initial before outer returns', async () => {
    const wiki = await freshWiki(slowProvider(0));
    const inner: EntityStatus[] = [];
    let outerReturned = false;
    wiki.subscribeEntityStatus('e1', () => {
      wiki.subscribeEntityStatus('e1', (s) => {
        expect(outerReturned).toBe(false);
        inner.push({ ...s });
      });
    });
    outerReturned = true;
    expect(inner).toEqual([{ ingesting: false, librarian: false, heal: false }]);
  });

  it('does not miss a transition when initial callback starts ingest re-entrantly', async () => {
    const wiki = await freshWiki(slowProvider(30));
    const calls: EntityStatus[] = [];
    let ingestPromise: Promise<any> | null = null;
    let triggered = false;

    const unsub = wiki.subscribeEntityStatus('e1', (s) => {
      calls.push({ ...s });
      if (!triggered) {
        triggered = true;
        ingestPromise = wiki.ingestDocument('e1', {
          sourceRef: 'doc-from-initial',
          sourceHash: 'b'.repeat(64),
          documentChunk: 'hello from initial callback',
        });
      }
    });

    expect(calls[0]).toEqual({ ingesting: false, librarian: false, heal: false });
    expect(calls.some((s) => s.ingesting)).toBe(true);
    await ingestPromise;
    expect(calls.at(-1)).toEqual({ ingesting: false, librarian: false, heal: false });
    unsub();
  });
});

describe('subscribeEntityStatus — ingest transition', () => {
  it('emits ingesting:true on add and ingesting:false on delete, no duplicates', async () => {
    const wiki = await freshWiki(slowProvider(50));
    const calls: EntityStatus[] = [];
    const unsub = wiki.subscribeEntityStatus('e1', (s) => calls.push({ ...s }));
    // initial
    expect(calls).toEqual([{ ingesting: false, librarian: false, heal: false }]);

    const sourceHash = 'a'.repeat(64);
    const p = wiki.ingestDocument('e1', { sourceRef: 'doc1', sourceHash, documentChunk: 'hello world' });
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

    let sawLibrarianTrue = false;
    let resolveLibrarianCycle!: () => void;
    const librarianCycleDone = new Promise<void>((r) => { resolveLibrarianCycle = r; });

    const calls: EntityStatus[] = [];
    const unsub = wiki.subscribeEntityStatus('e1', (s) => {
      calls.push({ ...s });
      if (s.librarian) sawLibrarianTrue = true;
      else if (sawLibrarianTrue) resolveLibrarianCycle();
    });
    expect(calls).toEqual([{ ingesting: false, librarian: false, heal: false }]);

    await wiki.write('e1', { event_type: 'observation', summary: 'something happened' });
    await librarianCycleDone;

    const flips = calls.map(c => c.librarian);
    expect(flips).toContain(true);
    expect(flips.at(-1)).toBe(false);
    unsub();
  });
});

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

    let sawHealTrue = false;
    let resolveHealCycle!: () => void;
    const healCycleDone = new Promise<void>((r) => { resolveHealCycle = r; });

    const calls: EntityStatus[] = [];
    const unsub = wiki.subscribeEntityStatus('e1', (s) => {
      calls.push({ ...s });
      if (s.heal) sawHealTrue = true;
      else if (sawHealTrue) resolveHealCycle();
    });

    await wiki.write('e1', { event_type: 'observation', summary: 'x' });
    await healCycleDone;

    const healFlips = calls.map(c => c.heal);
    expect(healFlips).toContain(true);
    expect(healFlips.at(-1)).toBe(false);
    unsub();
  });
});

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

  it('mutating the status object passed to callback does not corrupt duplicate suppression', async () => {
    const wiki = await freshWiki(slowProvider(0));
    const calls: EntityStatus[] = [];
    const unsub = wiki.subscribeEntityStatus('e1', (s) => {
      calls.push({ ...s });
      s.librarian = true;
    });
    (wiki as any)._notifyStatusSubscribers('e1');
    (wiki as any)._notifyStatusSubscribers('e1');
    expect(calls.length).toBe(1);
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
    let subscribed = false;
    const unsubA = wiki.subscribeEntityStatus('e1', (s) => {
      // Subscribe late only on the first transition when transitioning to librarian:true
      if (s.librarian && !subscribed) {
        subscribed = true;
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
