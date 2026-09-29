import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';

async function setup(config: Record<string, unknown> = {}) {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => JSON.stringify({ downgraded: [], deleted: [], newFacts: [] }) }, config });
  await wiki.setup();
  const ins = (id: string, valid_to: number | null, src = 'librarian_inferred') => db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at, valid_to)
     VALUES (?, 'u', ?, 'b', ?, 'inferred', 1, 1, ?)`, [id, id, src, valid_to]);
  return { db, wiki, ins, repo: wiki.__testAccess.entryRepo as any };
}

describe('heal and librarian context see current facts only', () => {
  it('findHealCandidatesByEntityId and count skip expired facts', async () => {
    const { ins, repo } = await setup();
    await ins('live', null);
    await ins('expired', 10);
    expect((await repo.findHealCandidatesByEntityId('u', 50, Date.now())).map((f: any) => f.id)).toEqual(['live']);
    expect(await repo.countHealCandidatesByEntityId('u', Date.now())).toEqual({ eligible: 1, deferred: 0 });
  });
  it('findRecentByEntityId skips expired facts', async () => {
    const { ins, repo } = await setup();
    await ins('live', null);
    await ins('expired', 10);
    expect((await repo.findRecentByEntityId('u', 10)).map((f: any) => f.id)).toEqual(['live']);
  });
});

describe('pruneSupersededAfter', () => {
  it('is off by default', async () => {
    const { db, wiki, ins } = await setup();
    await ins('expired', 1);
    await wiki.runPrune('u');
    expect((await db.getFirstAsync<any>(`SELECT deleted_at FROM llm_wiki_entries WHERE id='expired'`)).deleted_at).toBeNull();
  });
  it('soft-deletes facts whose valid_to is older than N days', async () => {
    const { db, wiki, ins } = await setup({ pruneSupersededAfter: 1 });
    const twoDaysAgo = Date.now() - 2 * 86_400_000;
    await ins('old', twoDaysAgo);
    await ins('fresh', Date.now() - 1_000);
    await wiki.runPrune('u');
    const rows = await db.getAllAsync<any>(`SELECT id, deleted_at FROM llm_wiki_entries ORDER BY id`);
    expect(rows.find((r: any) => r.id === 'old').deleted_at).not.toBeNull();
    expect(rows.find((r: any) => r.id === 'fresh').deleted_at).toBeNull();
  });
  it('rejects an invalid value', async () => {
    const { wiki } = await setup({ pruneSupersededAfter: -1 });
    await expect(wiki.runPrune('u')).rejects.toThrow();
  });
});
