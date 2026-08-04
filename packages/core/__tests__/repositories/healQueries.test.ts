import { describe, it, expect } from 'vitest';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import { setupDatabase } from '../../src/db/schema';
import { EntryRepository } from '../../src/repositories/EntryRepository';
import { OutboxRepository } from '../../src/repositories/OutboxRepository';
import type { SQLiteAdapter } from '../../src/types';

const PREFIX = 'llm_wiki_';

async function seed(db: SQLiteAdapter, opts: {
  id: string; entityId?: string; sourceType?: string; title?: string;
  sourceRef?: string | null; deletedAt?: number | null; updatedAt?: number;
}): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries
       (id, entity_id, title, body, tags, confidence, source_type, source_ref,
        created_at, updated_at, access_count, deleted_at)
     VALUES (?, ?, ?, 'body', '[]', 'certain', ?, ?, ?, ?, 0, ?)`,
    [
      opts.id, opts.entityId ?? 'e1', opts.title ?? `title ${opts.id}`,
      opts.sourceType ?? 'librarian_inferred', opts.sourceRef ?? null,
      opts.updatedAt ?? 1000, opts.updatedAt ?? 1000, opts.deletedAt ?? null,
    ],
  );
}

async function makeRepo(): Promise<{ db: SQLiteAdapter; repo: EntryRepository }> {
  const db = openTestDatabase();
  await setupDatabase(db, PREFIX);
  return { db, repo: new EntryRepository(db, PREFIX, new OutboxRepository(db, PREFIX, false)) };
}

describe('findHealCandidatesByEntityId', () => {
  it('returns only live, non-immutable facts for the entity', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, { id: 'mutable1', sourceType: 'librarian_inferred', updatedAt: 100 });
    await seed(db, { id: 'mutable2', sourceType: 'user_stated', updatedAt: 200 });
    await seed(db, { id: 'anchor1', sourceType: 'immutable_document' });
    await seed(db, { id: 'deleted1', sourceType: 'librarian_inferred', deletedAt: 5 });
    await seed(db, { id: 'other', entityId: 'e2', sourceType: 'librarian_inferred' });

    const rows = await repo.findHealCandidatesByEntityId('e1');
    expect(rows.map(r => r.id)).toEqual(['mutable2', 'mutable1']); // updated_at DESC
  });
});

describe('findAnchorRowsByIds', () => {
  it('keeps only immutable_document rows and drops everything else', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, { id: 'anchor1', sourceType: 'immutable_document', sourceRef: 'doc://1' });
    await seed(db, { id: 'anchor2', sourceType: 'immutable_document', sourceRef: 'doc://2' });
    await seed(db, { id: 'inferred1', sourceType: 'librarian_inferred' });
    await seed(db, { id: 'deletedAnchor', sourceType: 'immutable_document', deletedAt: 5 });
    await seed(db, { id: 'otherEntityAnchor', entityId: 'e2', sourceType: 'immutable_document' });

    const rows = await repo.findAnchorRowsByIds(
      'e1',
      ['anchor1', 'inferred1', 'deletedAnchor', 'otherEntityAnchor', 'anchor2', 'nonexistent'],
    );

    expect(rows.map(r => r.id).sort()).toEqual(['anchor1', 'anchor2']);
    expect(rows.find(r => r.id === 'anchor1')).toMatchObject({ title: 'title anchor1', source_ref: 'doc://1' });
  });

  it('returns an empty array for an empty id list without hitting the database', async () => {
    const { repo } = await makeRepo();
    expect(await repo.findAnchorRowsByIds('e1', [])).toEqual([]);
  });
});
