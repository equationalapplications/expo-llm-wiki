import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../WikiMemory';
import { WikiBusyError } from '../types';

class MockSQLiteDatabase {
  async execAsync(_sql: string): Promise<void> {}

  async withTransactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  async runAsync(_sql: string, _args: any[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
    return { changes: 0, lastInsertRowId: 0 };
  }

  async getAllAsync<T>(_sql: string, _args: any[] = []): Promise<T[]> {
    return [] as T[];
  }

  async getFirstAsync<T>(_sql: string, _args: any[] = []): Promise<T | null> {
    return null;
  }
}

vi.mock('expo-sqlite', () => {
  return {
    openDatabaseAsync: async (_name: string) => new MockSQLiteDatabase(),
  };
});

const SQLite = await import('expo-sqlite');

const slowProvider = (delayMs: number) => ({
  generateText: async (_: any) => {
    await new Promise((r) => setTimeout(r, delayMs));
    return JSON.stringify({ facts: [], tasks: [] });
  },
});

async function freshWiki(provider: any) {
  const db = await SQLite.openDatabaseAsync(':memory:');
  const wiki = new WikiMemory(db, { llmProvider: provider, config: { tablePrefix: 'jobs_' } });
  await wiki.setup();
  return wiki;
}

describe('job mutex', () => {
  it('runLibrarian throws WikiBusyError when already running', async () => {
    const wiki = await freshWiki(slowProvider(100));
    const first = wiki.runLibrarian('e1');
    // second call while first is in flight should throw WikiBusyError
    await expect(wiki.runLibrarian('e1')).rejects.toBeInstanceOf(WikiBusyError);
    await first;
  });

  it('runHeal does not block runLibrarian for same entity after mutex split', async () => {
    const wiki = await freshWiki(slowProvider(100));
    // Start both simultaneously - they should NOT block each other
    const librarian = wiki.runLibrarian('e1');
    const heal = wiki.runHeal('e1');
    // Both should complete without either throwing
    await expect(Promise.all([librarian, heal])).resolves.toBeDefined();
  });

  it('ingestDocument throws WikiBusyError for same (entity, sourceRef)', async () => {
    const wiki = await freshWiki(slowProvider(100));
    const sourceHash = 'a'.repeat(64);
    const params = { sourceRef: 'doc1', sourceHash, documentChunk: 'some content here' };
    const first = wiki.ingestDocument('e1', params);
    await expect(wiki.ingestDocument('e1', params)).rejects.toBeInstanceOf(WikiBusyError);
    await first;
  });

  it('ingestDocument allows different sourceRef for same entity', async () => {
    const wiki = await freshWiki(slowProvider(50));
    const sourceHash = 'a'.repeat(64);
    const first = wiki.ingestDocument('e1', { sourceRef: 'doc1', sourceHash, documentChunk: 'content one' });
    const second = wiki.ingestDocument('e1', { sourceRef: 'doc2', sourceHash, documentChunk: 'content two' });
    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });
});
