import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiDraftNotFound } from '../src/types';
import type { SQLiteAdapter } from '../src/types';

async function makeWiki(): Promise<{ wiki: WikiMemory; db: SQLiteAdapter }> {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
  await wiki.setup();
  return { wiki, db };
}

async function seed(db: SQLiteAdapter, id: string, opts: { entity?: string; status?: string; created?: number; deleted?: number | null } = {}) {
  const t = opts.created ?? 1000;
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at, deleted_at, lifecycle_status)
     VALUES (?, ?, ?, 'b', 'inferred', 'librarian_inferred', ?, ?, ?, ?)`,
    [id, opts.entity ?? 'e1', `t-${id}`, t, t, opts.deleted ?? null, opts.status ?? 'draft'],
  );
}

describe('listDrafts', () => {
  it('pages newest-first with an opaque cursor, entity-scoped', async () => {
    const { wiki, db } = await makeWiki();
    for (let i = 1; i <= 5; i++) await seed(db, `d${i}`, { created: i * 10 });
    await seed(db, 'other', { entity: 'e2', created: 999 });
    await seed(db, 'stable', { status: 'stable', created: 998 });

    const p1 = await wiki.listDrafts('e1', { limit: 2 });
    expect(p1.facts.map((f) => f.id)).toEqual(['d5', 'd4']);
    expect(typeof p1.nextCursor).toBe('string');
    const p2 = await wiki.listDrafts('e1', { limit: 2, cursor: p1.nextCursor! });
    expect(p2.facts.map((f) => f.id)).toEqual(['d3', 'd2']);
    const p3 = await wiki.listDrafts('e1', { limit: 2, cursor: p2.nextCursor! });
    expect(p3.facts.map((f) => f.id)).toEqual(['d1']);
    expect(p3.nextCursor).toBeNull();
  });

  it('defaults to 50, clamps to [1, 500], and never exposes embedding_blob', async () => {
    const { wiki, db } = await makeWiki();
    for (let i = 0; i < 60; i++) await seed(db, `d${String(i).padStart(2, '0')}`, { created: i });
    expect((await wiki.listDrafts('e1')).facts).toHaveLength(50);
    expect((await wiki.listDrafts('e1', { limit: 0 })).facts).toHaveLength(1);
    expect((await wiki.listDrafts('e1', { limit: 10_000 })).facts).toHaveLength(60);
    expect((await wiki.listDrafts('e1')).facts[0]).not.toHaveProperty('embedding_blob');
  });

  it('rejects a malformed cursor', async () => {
    const { wiki } = await makeWiki();
    await expect(wiki.listDrafts('e1', { cursor: 'garbage' })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('promoteDraft', () => {
  it('sets stable, records the reviewer, and does not bump updated_at', async () => {
    const { wiki, db } = await makeWiki();
    await seed(db, 'd1', { created: 1234 });
    await wiki.promoteDraft('d1', 'e1', { by: 'human:reviewer-1' });
    const row = await db.getFirstAsync<{ lifecycle_status: string; updated_at: number; okf_verified: string; last_verified_by: string }>(
      `SELECT lifecycle_status, updated_at, okf_verified, last_verified_by FROM llm_wiki_entries WHERE id = 'd1'`,
    );
    expect(row?.lifecycle_status).toBe('stable');
    expect(Number(row?.updated_at)).toBe(1234);
    expect(row?.last_verified_by).toBe('human:reviewer-1');
    const [promoted] = (await wiki.read('e1', '')).facts;
    expect(promoted.trustTier).toBe('human-reviewed');
  });

  it('keeps the promoted fact in its original recency position', async () => {
    const { wiki, db } = await makeWiki();
    await seed(db, 'old', { created: 1 });
    await seed(db, 'new', { status: 'stable', created: 2 });
    await wiki.promoteDraft('old', 'e1', { by: 'human:r' });
    expect((await wiki.read('e1', '')).facts.map((f) => f.id)).toEqual(['new', 'old']);
  });

  it('is visible to excludeDrafts reads immediately, without re-indexing', async () => {
    const { wiki, db } = await makeWiki();
    await seed(db, 'd1');
    expect((await wiki.read('e1', '', { excludeDrafts: true })).facts).toHaveLength(0);
    await wiki.promoteDraft('d1', 'e1', { by: 'human:r' });
    expect((await wiki.read('e1', '', { excludeDrafts: true })).facts.map((f) => f.id)).toEqual(['d1']);
  });

  it('throws WikiDraftNotFound for missing, foreign, deleted and non-draft facts, changing nothing', async () => {
    const { wiki, db } = await makeWiki();
    await seed(db, 'foreign', { entity: 'e2' });
    await seed(db, 'deleted', { deleted: 5 });
    await seed(db, 'stable', { status: 'stable' });
    for (const id of ['missing', 'foreign', 'deleted', 'stable']) {
      await expect(wiki.promoteDraft(id, 'e1', { by: 'human:r' })).rejects.toBeInstanceOf(WikiDraftNotFound);
    }
    const foreign = await db.getFirstAsync<{ lifecycle_status: string; okf_verified: string | null }>(
      `SELECT lifecycle_status, okf_verified FROM llm_wiki_entries WHERE id = 'foreign'`,
    );
    expect(foreign?.lifecycle_status).toBe('draft');
  });

  it('requires a non-empty reviewer', async () => {
    const { wiki, db } = await makeWiki();
    await seed(db, 'd1');
    await expect(wiki.promoteDraft('d1', 'e1', { by: '  ' })).rejects.toBeInstanceOf(TypeError);
    await expect(wiki.promoteDraft('d1', 'e1', {} as { by: string })).rejects.toBeInstanceOf(TypeError);
  });
});
