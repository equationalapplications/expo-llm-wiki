import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { EntryRepository } from '../src/repositories/EntryRepository';
import { OutboxRepository } from '../src/repositories/OutboxRepository';
import { WikiDraftNotFound } from '../src/types';
import type { SQLiteAdapter } from '../src/types';

const PREFIX = 'llm_wiki_';

async function seed(db: SQLiteAdapter, id: string, opts: { entity?: string; status?: string; created?: number; deleted?: number | null } = {}) {
  const t = opts.created ?? 1000;
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at, deleted_at, lifecycle_status)
     VALUES (?, ?, ?, 'b', 'certain', 'user_stated', ?, ?, ?, ?)`,
    [id, opts.entity ?? 'e1', `t-${id}`, t, t, opts.deleted ?? null, opts.status ?? 'stable'],
  );
}

async function makeRepo() {
  const db = openTestDatabase();
  await setupDatabase(db, PREFIX);
  return { db, repo: new EntryRepository(db, PREFIX, new OutboxRepository(db, PREFIX, false)) };
}

describe('WikiDraftNotFound', () => {
  it('is contextless with a stable code', () => {
    const err = new WikiDraftNotFound();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WikiDraftNotFound);
    expect(err.code).toBe('WIKI_DRAFT_NOT_FOUND');
    expect(err.name).toBe('WikiDraftNotFound');
  });
});

describe('EntryRepository draft queries', () => {
  it('findDraftIdsByEntityIds returns live drafts of the named entities only', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, 'd1', { status: 'draft' });
    await seed(db, 'd2', { status: 'draft', entity: 'e2' });
    await seed(db, 'd3', { status: 'draft', deleted: 5 });
    await seed(db, 's1');
    expect([...(await repo.findDraftIdsByEntityIds(['e1']))]).toEqual(['d1']);
    expect([...(await repo.findDraftIdsByEntityIds(['e1', 'e2']))].sort()).toEqual(['d1', 'd2']);
    expect((await repo.findDraftIdsByEntityIds([])).size).toBe(0);
  });

  it('listDraftsByEntityId orders created_at DESC, id DESC and pages with a keyset', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, 'a', { status: 'draft', created: 10 });
    await seed(db, 'b', { status: 'draft', created: 20 });
    await seed(db, 'c', { status: 'draft', created: 20 });
    await seed(db, 'x', { status: 'draft', created: 30, entity: 'e2' });
    await seed(db, 's', { created: 40 });
    const first = await repo.listDraftsByEntityId('e1', 2, null);
    expect(first.map((f) => f.id)).toEqual(['c', 'b']);
    const second = await repo.listDraftsByEntityId('e1', 2, { createdAt: 20, id: 'b' });
    expect(second.map((f) => f.id)).toEqual(['a']);
  });

  it('isLiveDraft is entity-scoped and ignores deleted and non-draft rows', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, 'd1', { status: 'draft' });
    await seed(db, 'd2', { status: 'draft', deleted: 1 });
    await seed(db, 's1');
    expect(await repo.isLiveDraft('d1', 'e1')).toBe(true);
    expect(await repo.isLiveDraft('d1', 'e2')).toBe(false);
    expect(await repo.isLiveDraft('d2', 'e1')).toBe(false);
    expect(await repo.isLiveDraft('s1', 'e1')).toBe(false);
    expect(await repo.isLiveDraft('missing', 'e1')).toBe(false);
  });

  it('findRecentByEntityIds excludes drafts only when asked', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, 'd1', { status: 'draft', created: 30 });
    await seed(db, 's1', { created: 20 });
    expect((await repo.findRecentByEntityIds(['e1'], 10)).map((f) => f.id)).toEqual(['d1', 's1']);
    expect((await repo.findRecentByEntityIds(['e1'], 10, undefined, { excludeDrafts: true })).map((f) => f.id)).toEqual(['s1']);
  });
});
