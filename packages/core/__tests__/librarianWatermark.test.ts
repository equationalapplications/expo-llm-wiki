import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';

async function mk() {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => JSON.stringify({ facts: [], tasks: [] }) }, config: { autoLibrarianThreshold: 1000 } });
  await wiki.setup();
  const t = wiki.__testAccess as any;
  const ev = (id: string, at: number) => db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES (?, 'u', 'observation', 's', ?)`, [id, at]);
  return { db, wiki, ms: t.maintenanceService, meta: t.metadataRepo, ev };
}

describe('librarian watermark', () => {
  it('legacy pass advances the watermark to the newest event it read', async () => {
    const { wiki, meta, ev } = await mk();
    await ev('evt_a', 10); await ev('evt_b', 20);
    await wiki.runLibrarian('u');
    expect(await meta.getLibrarianWatermark('u')).toEqual({ at: 20, id: 'evt_b' });
  });

  it('never moves backwards', async () => {
    const { db, wiki, meta, ev } = await mk();
    await ev('evt_a', 10);
    await meta.setLibrarianWatermark('u', { at: 99, id: 'evt_z' }, db);
    await wiki.runLibrarian('u');
    expect(await meta.getLibrarianWatermark('u')).toEqual({ at: 99, id: 'evt_z' });
  });

  it('does not advance when the pass throws', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => { throw new Error('boom'); } }, config: { autoLibrarianThreshold: 1000 } });
    await wiki.setup();
    await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_a','u','observation','s',10)`);
    await expect(wiki.runLibrarian('u')).rejects.toThrow('boom');
    expect(await (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u')).toBeNull();
  });

  it('seeds from memory_checkpoint when no watermark exists', async () => {
    const { db, ms, meta, ev } = await mk();
    await ev('evt_a', 10); await ev('evt_b', 20); await ev('evt_c', 30);
    await meta.updateCheckpoint('u', { memory: 2 }, db);
    await ms.seedLibrarianWatermark('u');
    expect(await meta.getLibrarianWatermark('u')).toEqual({ at: 20, id: 'evt_b' });
  });

  it('seeding is a no-op when a watermark exists or the checkpoint is 0', async () => {
    const { db, ms, meta, ev } = await mk();
    await ev('evt_a', 10);
    await ms.seedLibrarianWatermark('u');
    expect(await meta.getLibrarianWatermark('u')).toBeNull();
    await meta.setLibrarianWatermark('u', { at: 5, id: 'evt_0' }, db);
    await meta.updateCheckpoint('u', { memory: 1 }, db);
    await ms.seedLibrarianWatermark('u');
    expect(await meta.getLibrarianWatermark('u')).toEqual({ at: 5, id: 'evt_0' });
  });
});
