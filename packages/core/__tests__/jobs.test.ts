import { describe, it, expect } from 'vitest';
import { WikiBusyError } from '../src/types';
import { WikiMemory } from '../src/WikiMemory';
import { JobManager } from '../src/services/JobManager';

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

const slowProvider = (delayMs: number) => ({
  generateText: async (_: any) => {
    await new Promise((r) => setTimeout(r, delayMs));
    return JSON.stringify({ facts: [], tasks: [] });
  },
});

async function freshWiki(provider: any) {
  const db = new MockSQLiteDatabase();
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

  it('runLibrarian throws WikiBusyError when prune is running for same entity', async () => {
    const wiki = await freshWiki(slowProvider(0));
    (wiki as any).jobManager.activeMaintenanceJobs.add('jobs_:e1:prune');
    const err = await wiki.runLibrarian('e1').catch((e) => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect(err.operation).toBe('prune');
  });

  it('runHeal throws WikiBusyError when prune is running for same entity', async () => {
    const wiki = await freshWiki(slowProvider(0));
    (wiki as any).jobManager.activeMaintenanceJobs.add('jobs_:e1:prune');
    const err = await wiki.runHeal('e1').catch((e) => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect(err.operation).toBe('prune');
  });

  it('ingestDocument throws WikiBusyError when prune is running for same entity', async () => {
    const wiki = await freshWiki(slowProvider(0));
    (wiki as any).jobManager.activeMaintenanceJobs.add('jobs_:e1:prune');
    const sourceHash = 'a'.repeat(64);
    const err = await wiki.ingestDocument('e1', { sourceRef: 'doc1', sourceHash, documentChunk: 'some content here' }).catch((e) => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect(err.operation).toBe('prune');
  });

  it('prune guard does not bleed to different entity', async () => {
    const wiki = await freshWiki(slowProvider(100));
    (wiki as any).jobManager.activeMaintenanceJobs.add('jobs_:e1:prune');
    // e2 should not be affected by e1 prune lock
    const p = wiki.runLibrarian('e2');
    await expect(p).resolves.toBeUndefined();
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

  it('ingestDocument treats entity IDs with colons distinctly', async () => {
    const wiki = await freshWiki(slowProvider(50));
    const sourceHash = 'a'.repeat(64);
    const first = wiki.ingestDocument('a:b', { sourceRef: 'doc1', sourceHash, documentChunk: 'content one' });
    await expect(wiki.ingestDocument('a', { sourceRef: 'doc2', sourceHash, documentChunk: 'content two' })).resolves.toBeTruthy();
    await first;
  });

  it('prune does not treat entity IDs with colon prefixes as the same ingest entity', async () => {
    const wiki = await freshWiki(slowProvider(0));
    const jobManager = (wiki as any).jobManager;
    jobManager._addIngestJob('a:b', 'doc1');
    expect(() => jobManager.acquireLock('prune', 'a')).not.toThrow();
  });
});

describe('getEntityStatus', () => {
  it('returns all-false when idle', async () => {
    const wiki = await freshWiki(slowProvider(0));
    expect(wiki.getEntityStatus('idle')).toEqual({ ingesting: false, librarian: false, heal: false });
  });

  it('reports ingesting during ingest', async () => {
    const wiki = await freshWiki(slowProvider(100));
    const sourceHash = 'a'.repeat(64);
    const ingestP = wiki.ingestDocument('e1', { sourceRef: 'doc1', sourceHash, documentChunk: 'some text content here' });
    // give the async operation a moment to register
    await new Promise(r => setTimeout(r, 10));
    expect(wiki.getEntityStatus('e1').ingesting).toBe(true);
    expect(wiki.getEntityStatus('e1').librarian).toBe(false);
    await ingestP;
    expect(wiki.getEntityStatus('e1').ingesting).toBe(false);
  });

  it('does not bleed across entities', async () => {
    const wiki = await freshWiki(slowProvider(100));
    const p = wiki.runLibrarian('e1');
    await new Promise(r => setTimeout(r, 10));
    // e1 should be busy, e2 should be idle
    expect(wiki.getEntityStatus('e1').librarian).toBe(true);
    expect(wiki.getEntityStatus('e2').librarian).toBe(false);
    await p;
  });
});

describe('ontologyBackfill lock', () => {
  it('self-conflicts per entity and releases cleanly', () => {
    const jm = new JobManager('llm_wiki_');
    jm.acquireLock('ontologyBackfill', 'e1');
    expect(() => jm.acquireLock('ontologyBackfill', 'e1')).toThrow(WikiBusyError);
    jm.acquireLock('ontologyBackfill', 'e2'); // other entity fine
    jm.releaseLock('ontologyBackfill', 'e1');
    expect(() => jm.acquireLock('ontologyBackfill', 'e1')).not.toThrow();
  });

  it('is blocked by prune/reembed/import/forget, and blocks them back', () => {
    for (const op of ['prune', 'reembed', 'import', 'forget'] as const) {
      const jm = new JobManager('llm_wiki_');
      jm.acquireLock(op, 'e1');
      expect(() => jm.acquireLock('ontologyBackfill', 'e1')).toThrow(WikiBusyError);
      jm.releaseLock(op, 'e1');
      jm.acquireLock('ontologyBackfill', 'e1');
      expect(() => jm.acquireLock(op, 'e1')).toThrow(WikiBusyError);
    }
  });
});
