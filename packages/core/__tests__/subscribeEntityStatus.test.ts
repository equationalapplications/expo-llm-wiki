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
