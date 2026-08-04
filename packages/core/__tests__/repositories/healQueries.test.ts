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
  healCheckedAt?: number | null;
}): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries
       (id, entity_id, title, body, tags, confidence, source_type, source_ref,
        created_at, updated_at, access_count, deleted_at, heal_checked_at)
     VALUES (?, ?, ?, 'body', '[]', 'certain', ?, ?, ?, ?, 0, ?, ?)`,
    [
      opts.id, opts.entityId ?? 'e1', opts.title ?? `title ${opts.id}`,
      opts.sourceType ?? 'librarian_inferred', opts.sourceRef ?? null,
      opts.updatedAt ?? 1000, opts.updatedAt ?? 1000, opts.deletedAt ?? null,
      opts.healCheckedAt ?? null,
    ],
  );
}

async function makeRepo(): Promise<{ db: SQLiteAdapter; repo: EntryRepository }> {
  const db = openTestDatabase();
  await setupDatabase(db, PREFIX);
  return { db, repo: new EntryRepository(db, PREFIX, new OutboxRepository(db, PREFIX, false)) };
}

describe('findHealCandidatesByEntityId', () => {
  it('returns only live, non-immutable facts for the entity, oldest first', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, { id: 'mutable1', sourceType: 'librarian_inferred', updatedAt: 100 });
    await seed(db, { id: 'mutable2', sourceType: 'user_stated', updatedAt: 200 });
    await seed(db, { id: 'anchor1', sourceType: 'immutable_document' });
    await seed(db, { id: 'deleted1', sourceType: 'librarian_inferred', deletedAt: 5 });
    await seed(db, { id: 'other', entityId: 'e2', sourceType: 'librarian_inferred' });

    const rows = await repo.findHealCandidatesByEntityId('e1', 10, 0);
    // updated_at ASC: with a cooldown in place, newest-first would keep
    // re-selecting recently-touched facts and starve older ones.
    expect(rows.map(r => r.id)).toEqual(['mutable1', 'mutable2']);
  });

  it('applies the limit', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, { id: 'm1', updatedAt: 100 });
    await seed(db, { id: 'm2', updatedAt: 200 });
    await seed(db, { id: 'm3', updatedAt: 300 });

    const rows = await repo.findHealCandidatesByEntityId('e1', 2, 0);
    expect(rows.map(r => r.id)).toEqual(['m1', 'm2']);
  });

  it('skips facts stamped inside the recheck cooldown', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, { id: 'never', updatedAt: 100, healCheckedAt: null });
    await seed(db, { id: 'stale', updatedAt: 200, healCheckedAt: 300 });
    await seed(db, { id: 'fresh', updatedAt: 300, healCheckedAt: 900 });

    const rows = await repo.findHealCandidatesByEntityId('e1', 10, 400);
    expect(rows.map(r => r.id)).toEqual(['never', 'stale']);
  });
});

describe('countHealCandidatesByEntityId', () => {
  it('splits eligible vs deferred', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, { id: 'never', healCheckedAt: null });
    await seed(db, { id: 'stale', healCheckedAt: 300 });
    await seed(db, { id: 'fresh', healCheckedAt: 900 });
    await seed(db, { id: 'anchor', sourceType: 'immutable_document' });
    await seed(db, { id: 'gone', deletedAt: 5 });

    expect(await repo.countHealCandidatesByEntityId('e1', 400))
      .toEqual({ eligible: 2, deferred: 1 });
  });
});

describe('markHealChecked', () => {
  it('stamps the cooldown and never touches updated_at', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, { id: 'm1', updatedAt: 1000 });
    await seed(db, { id: 'm2', updatedAt: 1000 });

    await db.withTransactionAsync(tx => repo.markHealChecked(['m1', 'm2'], 'e1', 9999, tx));

    const rows = await db.getAllAsync<{ id: string; heal_checked_at: number | null; updated_at: number }>(
      `SELECT id, heal_checked_at, updated_at FROM ${PREFIX}entries ORDER BY id`);
    expect(rows).toEqual([
      { id: 'm1', heal_checked_at: 9999, updated_at: 1000 },
      { id: 'm2', heal_checked_at: 9999, updated_at: 1000 },
    ]);
  });

  it('skips soft-deleted facts', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, { id: 'live1' });
    await seed(db, { id: 'gone1', deletedAt: 5 });

    await db.withTransactionAsync(tx => repo.markHealChecked(['live1', 'gone1'], 'e1', 9999, tx));

    const rows = await db.getAllAsync<{ id: string; heal_checked_at: number | null }>(
      `SELECT id, heal_checked_at FROM ${PREFIX}entries ORDER BY id`);
    // A deleted row is not a candidate under any future pass, so its cooldown
    // value is irrelevant — the stamped count can be lower than the offered count.
    expect(rows).toEqual([
      { id: 'gone1', heal_checked_at: null },
      { id: 'live1', heal_checked_at: 9999 },
    ]);
  });
});

describe('findInferredTitlesByEntityId', () => {
  it('returns id+title for every live librarian_inferred fact, unbounded', async () => {
    const { db, repo } = await makeRepo();
    await seed(db, { id: 'i1', sourceType: 'librarian_inferred', title: 'Alpha' });
    await seed(db, { id: 'i2', sourceType: 'librarian_inferred', title: 'Beta' });
    await seed(db, { id: 'u1', sourceType: 'user_stated', title: 'Gamma' });
    await seed(db, { id: 'd1', sourceType: 'librarian_inferred', title: 'Delta', deletedAt: 5 });
    await seed(db, { id: 'o1', entityId: 'e2', sourceType: 'librarian_inferred', title: 'Epsilon' });

    const rows = await repo.findInferredTitlesByEntityId('e1');
    expect(rows.map(r => r.id).sort()).toEqual(['i1', 'i2']);
    expect(rows.map(r => r.title).sort()).toEqual(['Alpha', 'Beta']);
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
