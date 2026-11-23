// specs/supersede-future-valid-to D4 / test plan 6-13
import { describe, it, expect, beforeEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

let db: SQLiteAdapter;
let wiki: WikiMemory;
const FUTURE = Date.now() + 30 * 86_400_000;

async function insert(id: string, entity = 'e1', source_type = 'user_stated', created_at = 100) {
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
     VALUES (?, ?, ?, 'body', ?, 'certain', ?, ?)`,
    [id, entity, `title ${id}`, source_type, created_at, created_at],
  );
}
const row = (id: string) => db.getFirstAsync<any>(`SELECT * FROM llm_wiki_entries WHERE id = ?`, [id]);
const outboxCount = async () => (await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM llm_wiki_outbox`))!.n;

beforeEach(async () => {
  db = openTestDatabase();
  wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' }, config: { enableOutbox: true } });
  await wiki.setup();
});

async function supersedeThenForget(prior: 'future' | 'open' | 'past' = 'future') {
  await insert('old');
  if (prior === 'future') await wiki.expire('e1', 'old', { at: FUTURE });
  if (prior === 'past') await wiki.expire('e1', 'old', { at: Date.now() + 50 });
  const { newId } = await wiki.supersede('e1', 'old', { title: 'SF', body: 'b' }, { validFrom: 5_000 });
  await wiki.forget('e1', { entryId: newId });
  return newId;
}

describe('reopen()', () => {
  it('restores the scheduled end, clears the supersession, returns it, and reads include the fact again', async () => {
    await supersedeThenForget('future');
    expect((await row('old')).prior_valid_to).toBe(FUTURE);
    const res = await wiki.reopen('e1', 'old');
    expect(res).toEqual({ valid_to: FUTURE });
    expect(await row('old')).toMatchObject({ valid_to: FUTURE, superseded_by: null, superseded_at: null, prior_valid_to: null });
    const read = await wiki.read('e1', 'title old');
    expect(read.facts.map((f) => f.id)).toContain('old');
    expect((await wiki.history('e1', 'old')).map((f) => f.id)).toEqual(['old']);
  });

  it('restores valid_to = null for a fact superseded while open-ended', async () => {
    await supersedeThenForget('open');
    expect(await wiki.reopen('e1', 'old')).toEqual({ valid_to: null });
    expect(await row('old')).toMatchObject({ valid_to: null, superseded_by: null, prior_valid_to: null });
  });

  it('a restored end that has passed leaves the fact expired (asOf before it still returns it)', async () => {
    await insert('old');
    // schedule an end, supersede, then let the end pass by rewriting it into the past
    await wiki.expire('e1', 'old', { at: FUTURE });
    const { newId } = await wiki.supersede('e1', 'old', { title: 'SF', body: 'b' }, { validFrom: 5_000 });
    await db.runAsync(`UPDATE llm_wiki_entries SET prior_valid_to = 1000 WHERE id = 'old'`);
    await wiki.forget('e1', { entryId: newId });
    expect(await wiki.reopen('e1', 'old')).toEqual({ valid_to: 1000 });
    expect((await wiki.read('e1', 'title old')).facts.map((f) => f.id)).not.toContain('old');
    expect((await wiki.read('e1', 'title old', { asOf: 500 })).facts.map((f) => f.id)).toContain('old');
  });

  it('outbox: one UPDATE payload with the four restored keys', async () => {
    await supersedeThenForget('future');
    await db.runAsync(`DELETE FROM llm_wiki_outbox`);
    await wiki.reopen('e1', 'old');
    const rows = await db.getAllAsync<any>(`SELECT operation, payload FROM llm_wiki_outbox`);
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe('UPDATE');
    expect(JSON.parse(rows[0].payload)).toEqual({
      id: 'old', entity_id: 'e1', valid_to: FUTURE, superseded_by: null, superseded_at: null, prior_valid_to: null,
    });
  });

  it('a pre-v18 supersession (no recorded prior) restores null', async () => {
    const newId = await supersedeThenForget('future');
    await db.runAsync(`UPDATE llm_wiki_entries SET prior_valid_to = NULL WHERE id = 'old'`);
    expect(newId).toBeTruthy();
    expect(await wiki.reopen('e1', 'old')).toEqual({ valid_to: null });
  });

  it('a hard-deleted (gone) successor passes the guard', async () => {
    const newId = await supersedeThenForget('future');
    await db.runAsync(`DELETE FROM llm_wiki_entries WHERE id = ?`, [newId]);
    expect(await wiki.reopen('e1', 'old')).toEqual({ valid_to: FUTURE });
  });

  it('can be superseded again, recording the then-current end', async () => {
    await supersedeThenForget('future');
    await wiki.reopen('e1', 'old');
    const { newId } = await wiki.supersede('e1', 'old', { title: 'LA', body: 'b' }, { validFrom: 9_000 });
    expect(await row('old')).toMatchObject({ valid_to: 9_000, superseded_by: newId, prior_valid_to: FUTURE });
  });

  it('prune: a reopened row whose restored end passed is pruned like any expired row', async () => {
    const newId = await supersedeThenForget('future');
    await db.runAsync(`UPDATE llm_wiki_entries SET prior_valid_to = 1000 WHERE id = 'old'`);
    await wiki.reopen('e1', 'old');
    expect(newId).toBeTruthy();
    const ids = await (wiki as any).temporalService.entryRepo.findExpiredIds('e1', Date.now() + 1);
    expect(ids).toContain('old');
  });

  it('a crafted invalid prior (<= start, non-integer) restores null', async () => {
    await supersedeThenForget('future');
    await db.runAsync(`UPDATE llm_wiki_entries SET prior_valid_to = 50 WHERE id = 'old'`);
    expect(await wiki.reopen('e1', 'old')).toEqual({ valid_to: null });
  });

  it('a REAL (non-integer) or TEXT prior restores null', async () => {
    await supersedeThenForget('future');
    await db.runAsync(`UPDATE llm_wiki_entries SET prior_valid_to = ? WHERE id = 'old'`, [1.5e12 + 0.5]);
    expect(await wiki.reopen('e1', 'old')).toEqual({ valid_to: null });
  });

  it('a TEXT prior restores null', async () => {
    await insert('t1');
    const { newId } = await wiki.supersede('e1', 't1', { title: 'n', body: 'b' }, { validFrom: 5_000 });
    await wiki.forget('e1', { entryId: newId });
    await db.runAsync(`UPDATE llm_wiki_entries SET prior_valid_to = 'soon' WHERE id = 't1'`);
    expect(await wiki.reopen('e1', 't1')).toEqual({ valid_to: null });
  });

  it('chain A->B->C: B blocked while C live; forget C reopens B with its prior; forget B reopens A with F', async () => {
    await insert('A');
    await insert('B2');
    const F = FUTURE;
    await wiki.expire('e1', 'A', { at: F });
    await wiki.supersede('e1', 'A', 'B2', { validFrom: 5_000 });
    const B = FUTURE + 1000;
    await wiki.expire('e1', 'B2', { at: B }).catch(() => undefined);
    await db.runAsync(`UPDATE llm_wiki_entries SET valid_to = ? WHERE id = 'B2'`, [B]);
    const { newId: C } = await wiki.supersede('e1', 'B2', { title: 'C', body: 'b' }, { validFrom: 6_000 });
    await expect(wiki.reopen('e1', 'B2')).rejects.toMatchObject({ reason: 'successor_live' });
    await wiki.forget('e1', { entryId: C });
    expect(await wiki.reopen('e1', 'B2')).toEqual({ valid_to: B });
    // A's successor B2 is live again, so A is blocked until B2 is forgotten
    await expect(wiki.reopen('e1', 'A')).rejects.toMatchObject({ reason: 'successor_live' });
    await wiki.forget('e1', { entryId: 'B2' });
    expect(await wiki.reopen('e1', 'A')).toEqual({ valid_to: F });
  });

  describe('guards leave the row byte-identical and push no outbox row', () => {
    async function expectReject(entity: string, id: string, reason: string, snapshotIds: string[] = [id]) {
      const before = await Promise.all(snapshotIds.map(row));
      const n = await outboxCount();
      await expect(wiki.reopen(entity, id)).rejects.toMatchObject({ name: 'WikiSupersedeError', reason });
      expect(await Promise.all(snapshotIds.map(row))).toEqual(before);
      expect(await outboxCount()).toBe(n);
    }

    it('not_found: missing', async () => { await expectReject('e1', 'nope', 'not_found'); });

    it('not_found: soft-deleted', async () => {
      const newId = await supersedeThenForget('future');
      expect(newId).toBeTruthy();
      await wiki.forget('e1', { entryId: 'old' });
      await expectReject('e1', 'old', 'not_found');
    });

    it('cross_entity', async () => {
      await supersedeThenForget('future');
      await expectReject('other', 'old', 'cross_entity');
    });

    it('not_superseded: never superseded', async () => {
      await insert('plain');
      await expectReject('e1', 'plain', 'not_superseded');
    });

    it('not_superseded: expire()-ended', async () => {
      await insert('arch');
      await wiki.expire('e1', 'arch', { at: Date.now() + 10 });
      await expectReject('e1', 'arch', 'not_superseded');
    });

    it('successor_live', async () => {
      await insert('old');
      const { newId } = await wiki.supersede('e1', 'old', { title: 'SF', body: 'b' }, { validFrom: 5_000 });
      await expectReject('e1', 'old', 'successor_live', ['old', newId]);
    });

    it('successor_live across entities: a live successor owned by another entity rejects, leaks nothing', async () => {
      await supersedeThenForget('future');
      const succ = (await row('old')).superseded_by as string;
      // craft: successor row now belongs to another entity and is live
      await db.runAsync(`UPDATE llm_wiki_entries SET entity_id = 'e2', deleted_at = NULL WHERE id = ?`, [succ]);
      const err = await wiki.reopen('e1', 'old').catch((e) => e);
      expect(err.reason).toBe('successor_live');
      expect(JSON.stringify([err.message, err.reason, err.name])).not.toMatch(/e2|title|body|SF/);
      expect((await row('old')).superseded_by).toBe(succ);
    });

    it('a soft-deleted successor owned by another entity passes and reveals nothing', async () => {
      await supersedeThenForget('future');
      const succ = (await row('old')).superseded_by as string;
      await db.runAsync(`UPDATE llm_wiki_entries SET entity_id = 'e2' WHERE id = ?`, [succ]);
      const res = await wiki.reopen('e1', 'old');
      expect(res).toEqual({ valid_to: FUTURE });
      expect(JSON.stringify(res)).not.toMatch(/e2/);
      // the other entity's forgotten row is untouched
      expect((await row(succ)).entity_id).toBe('e2');
      expect((await row(succ)).deleted_at).not.toBeNull();
    });

    it('immutable_target (crafted by raw SQL)', async () => {
      await insert('doc', 'e1', 'immutable_document');
      await db.runAsync(`UPDATE llm_wiki_entries SET superseded_by = 'ghost', superseded_at = 1, valid_to = 2 WHERE id = 'doc'`);
      await expectReject('e1', 'doc', 'immutable_target');
    });

    it('error message names the verb reopen()', async () => {
      await insert('plain');
      await expect(wiki.reopen('e1', 'plain')).rejects.toThrow(/reopen\(\)/);
    });
  });
});
