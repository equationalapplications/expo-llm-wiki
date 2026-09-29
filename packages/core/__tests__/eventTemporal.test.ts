import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { LibrarianWatermark } from '../src/repositories/MetadataRepository';

function makeWiki() {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
  return { wiki, db };
}

async function wikiWith() {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
  await wiki.setup();
  return { db, eventRepo: (wiki as any).eventRepo, metadataRepo: (wiki as any).metadataRepo };
}

describe('write({ occurred_at })', () => {
  it('persists a positive occurred_at and round-trips it on read', async () => {
    const { wiki } = makeWiki();
    await wiki.setup();
    await wiki.write('e1', { event_type: 'observation', summary: 's', occurred_at: 1700 });
    const rows = await (wiki as any).eventRepo.getRecent('e1');
    expect(rows).toHaveLength(1);
    expect(rows[0].occurred_at).toBe(1700);
    expect(rows[0].created_at).toBeGreaterThan(0);
  });

  it('omits occurred_at on the returned event when it was not provided', async () => {
    const { wiki } = makeWiki();
    await wiki.setup();
    await wiki.write('e1', { event_type: 'observation', summary: 'no ts' });
    const rows = await (wiki as any).eventRepo.getRecent('e1');
    expect(rows[0]).not.toHaveProperty('occurred_at');
  });

  it('omits occurred_at on the returned event when it is explicitly null', async () => {
    const { wiki } = makeWiki();
    await wiki.setup();
    await wiki.write('e1', { event_type: 'observation', summary: 'null ts', occurred_at: null });
    const rows = await (wiki as any).eventRepo.getRecent('e1');
    expect(rows[0]).not.toHaveProperty('occurred_at');
  });

  it('rejects a non-finite or negative occurred_at', async () => {
    const { wiki } = makeWiki();
    await wiki.setup();
    await expect(
      wiki.write('e1', { event_type: 'observation', summary: 'bad', occurred_at: -1 }),
    ).rejects.toThrow(TypeError);
    await expect(
      wiki.write('e1', { event_type: 'observation', summary: 'bad', occurred_at: Number.NaN }),
    ).rejects.toThrow(TypeError);
  });

  it('omits occurred_at on getRecentForEntities and getByEntityId reads', async () => {
    const { wiki } = makeWiki();
    await wiki.setup();
    await wiki.write('e1', { event_type: 'observation', summary: 'a' });
    await wiki.write('e2', { event_type: 'observation', summary: 'b' });
    const a = await (wiki as any).eventRepo.getRecentForEntities(['e1', 'e2']);
    expect(a.every((r: any) => !('occurred_at' in r))).toBe(true);
    const b = await (wiki as any).eventRepo.getByEntityId('e1');
    expect(b.every((r: any) => !('occurred_at' in r))).toBe(true);
  });
});

describe('librarian watermark storage', () => {
  it('round-trips and getAfter/countAfter/sumSummaryCharsAfter honour (created_at, id) order', async () => {
    const { db, eventRepo, metadataRepo } = await wikiWith();
    for (const [id, at, s] of [['evt_a', 10, 'aa'], ['evt_b', 20, 'bbbb'], ['evt_c', 20, 'cccccc'], ['evt_d', 30, 'd']] as const) {
      await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES (?, 'e1', 'observation', ?, ?)`, [id, s, at]);
    }
    expect(await metadataRepo.getLibrarianWatermark('e1')).toBeNull();
    expect((await eventRepo.getAfter('e1', null, 10)).map((e: any) => e.id)).toEqual(['evt_a', 'evt_b', 'evt_c', 'evt_d']);

    await metadataRepo.setLibrarianWatermark('e1', { at: 20, id: 'evt_b' }, db);
    const wm = await metadataRepo.getLibrarianWatermark('e1');
    expect(wm).toEqual({ at: 20, id: 'evt_b' });
    expect((await eventRepo.getAfter('e1', wm, 10)).map((e: any) => e.id)).toEqual(['evt_c', 'evt_d']);
    expect(await eventRepo.countAfter('e1', wm)).toBe(2);
    expect(await eventRepo.sumSummaryCharsAfter('e1', wm)).toBe(7);
    expect((await eventRepo.getAfter('e1', wm, 1)).map((e: any) => e.id)).toEqual(['evt_c']);
  });

  it('returns null when no watermark has been set', async () => {
    const { wiki } = makeWiki();
    await wiki.setup();
    const db = wiki.__testAccess.writeService['db'];
    const wm = await (wiki as any).metadataRepo.getLibrarianWatermark('e1', db);
    expect(wm).toBeNull();
  });

  it('round-trips a watermark via get/set', async () => {
    const { wiki } = makeWiki();
    await wiki.setup();
    const db = wiki.__testAccess.writeService['db'];
    const wm: LibrarianWatermark = { at: 1700, id: 'evt_abc' };
    await (wiki as any).metadataRepo.setLibrarianWatermark('e1', wm, db);
    const read = await (wiki as any).metadataRepo.getLibrarianWatermark('e1', db);
    expect(read).toEqual(wm);
  });

  it('does not clobber memory_checkpoint or heal_checkpoint when setting watermark', async () => {
    const { wiki } = makeWiki();
    await wiki.setup();
    const db = wiki.__testAccess.writeService['db'];
    await (wiki as any).metadataRepo.updateCheckpoint('e1', { memory: 5, heal: 3 }, db);
    await (wiki as any).metadataRepo.setLibrarianWatermark('e1', { at: 2000, id: 'evt_x' }, db);
    const cp = await (wiki as any).metadataRepo.getCheckpoint('e1', db);
    expect(cp.memory).toBe(5);
    expect(cp.heal).toBe(3);
  });

  it('overwrites a previous watermark on subsequent set', async () => {
    const { wiki } = makeWiki();
    await wiki.setup();
    const db = wiki.__testAccess.writeService['db'];
    await (wiki as any).metadataRepo.setLibrarianWatermark('e1', { at: 1, id: 'a' }, db);
    await (wiki as any).metadataRepo.setLibrarianWatermark('e1', { at: 2, id: 'b' }, db);
    const wm = await (wiki as any).metadataRepo.getLibrarianWatermark('e1', db);
    expect(wm).toEqual({ at: 2, id: 'b' });
  });
});
