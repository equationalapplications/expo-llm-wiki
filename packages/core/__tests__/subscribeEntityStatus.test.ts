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
