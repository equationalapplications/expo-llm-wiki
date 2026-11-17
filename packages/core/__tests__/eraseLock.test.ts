/**
 * Spec forget-erasure §2 (T2): the 'erase' lock and its universal fencing
 * pre-check. erase() itself lands in T3/T6; these tests pin the lock semantics
 * this task ships, driving the JobManager directly and through WikiMemory's
 * services with the erase lock held.
 */
import { describe, it, expect, vi } from 'vitest';
import { JobManager } from '../src/services/JobManager';
import { WikiBusyError } from '../src/types';
import { WikiMemory } from '../src/WikiMemory';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { openTestDatabase } from './helpers/sqliteAdapter';

function busy(fn: () => void): { op: string; entityId: string } | null {
  try {
    fn();
  } catch (err) {
    if (err instanceof WikiBusyError) return { op: err.operation, entityId: err.entityId };
    throw err;
  }
  return null;
}

const ERASE_BUSY = { op: 'erase', entityId: '*' };

describe('JobManager — erase lock (spec §2)', () => {
  it('AC4: a second concurrent erase is refused with WikiBusyError(erase, *)', () => {
    const jm = new JobManager('t');
    jm.acquireLock('erase', '*');
    expect(busy(() => jm.acquireLock('erase', '*'))).toEqual(ERASE_BUSY);
    jm.releaseLock('erase', '*');
    expect(busy(() => jm.acquireLock('erase', '*'))).toBeNull();
  });

  it('AC2: every other operation is refused during erase', () => {
    const jm = new JobManager('t');
    jm.acquireLock('erase', '*');
    for (const op of ['store', 'librarian', 'heal', 'ontologyBackfill', 'reembed', 'import', 'forget', 'prune'] as const) {
      expect(busy(() => jm.acquireLock(op, 'e1')), op).toEqual(ERASE_BUSY);
      expect(jm.isBlocked(op, 'e1'), op).toBe(true);
    }
    expect(busy(() => jm.acquireLock('ingest', 'e1', 'ref'))).toEqual(ERASE_BUSY);
    expect(jm.isBlocked('ingest', 'e1')).toBe(true);
  });

  it('AC5: global_reembed and global_import are refused during erase', () => {
    const jm = new JobManager('t');
    jm.acquireLock('erase', '*');
    expect(busy(() => jm.acquireLock('global_reembed', '*'))).toEqual(ERASE_BUSY);
    expect(busy(() => jm.acquireLock('global_import', '*'))).toEqual(ERASE_BUSY);
    expect(jm.isBlocked('global_reembed', '*')).toBe(true);
    expect(jm.isBlocked('global_import', '*')).toBe(true);
  });

  it("the erase-owned prune is exempt from the universal pre-check (owner 'erase')", () => {
    const jm = new JobManager('t');
    jm.acquireLock('erase', '*');
    expect(busy(() => jm.acquireLock('prune', 'e1', undefined, 'erase'))).toBeNull();
    expect(busy(() => jm.acquireLock('prune', 'e1', undefined, 'erase'))?.op).toBe('prune');
    jm.releaseLock('prune', 'e1');
  });

  it('AC6: erase is refused at start while a librarian is active', () => {
    const jm = new JobManager('t');
    jm.acquireLock('librarian', 'e1');
    expect(busy(() => jm.acquireLock('erase', '*'))).toEqual({ op: 'librarian', entityId: '*' });
  });

  it('AC7: erase is refused while a global re-embed is active', () => {
    const jm = new JobManager('t');
    jm.acquireLock('global_reembed', '*');
    expect(busy(() => jm.acquireLock('erase', '*'))).toEqual({ op: 'reembed', entityId: '*' });
  });

  it('erase is refused while an ingest is active (separate ingest set)', () => {
    const jm = new JobManager('t');
    jm.acquireLock('ingest', 'e1', 'ref');
    expect(busy(() => jm.acquireLock('erase', '*'))).toEqual({ op: 'ingest', entityId: '*' });
  });

  it('release clears the fence', () => {
    const jm = new JobManager('t');
    jm.acquireLock('erase', '*');
    jm.releaseLock('erase', '*');
    expect(busy(() => jm.acquireLock('store', 'e1'))).toBeNull();
  });
});

describe('WikiMemory — fencing while the erase lock is held (spec §2)', () => {
  async function mk() {
    const db = openTestDatabase();
    const embed = async (t: string) => [t.length % 7, 1, 1, 0.5];
    const generateText = vi.fn(async () => JSON.stringify({ facts: [], tasks: [] }));
    const wiki = new WikiMemory(db, { llmProvider: { generateText, embed } });
    await wiki.setup();
    const jm = (wiki as unknown as { jobManager: JobManager }).jobManager;
    return { db, wiki, jm };
  }

  it('AC2: storeSource during erase → WikiBusyError(erase, *)', async () => {
    const { wiki, jm } = await mk();
    jm.acquireLock('erase', '*');
    await expect(wiki.storeSource('e1', { sourceRef: 'a.md', sourceHash: 'a'.repeat(64), text: 'x' }))
      .rejects.toMatchObject({ operation: 'erase', entityId: '*' });
  });

  it('AC3: standalone runPrune during erase → WikiBusyError(erase, *)', async () => {
    const { wiki, jm } = await mk();
    jm.acquireLock('erase', '*');
    await expect(wiki.runPrune('e1')).rejects.toMatchObject({ operation: 'erase', entityId: '*' });
  });

  it('AC8: write() during erase neither advances nor rolls back the memory checkpoint', async () => {
    const { db, wiki, jm } = await mk();
    const ck = async () =>
      (await db.getFirstAsync<{ memory_checkpoint: number | null }>(`SELECT memory_checkpoint FROM llm_wiki_checkpoints WHERE entity_id = ?`, ['e1']))?.memory_checkpoint ?? null;
    await wiki.write('e1', { event_type: 'observation', summary: 'before' });
    const before = await ck();
    jm.acquireLock('erase', '*');
    for (let i = 0; i < 12; i++) await wiki.write('e1', { event_type: 'observation', summary: `during ${i}` });
    expect(await ck()).toBe(before);
  });

  it('shared entity walk is unchanged for host callers', async () => {
    const { wiki, db } = await mk();
    await wiki.write('a', { event_type: 'observation', summary: 'x' });
    await wiki.write('b', { event_type: 'observation', summary: 'y' });
    const repo = new MetadataRepository(db, 'llm_wiki_');
    expect(await repo.getDistinctEntityIds()).toEqual(['a', 'b']);
  });
});
