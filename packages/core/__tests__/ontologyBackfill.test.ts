import { describe, it, expect, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { MIGRATIONS } from '../src/db/migrations';
import { createWiki, WikiMemory } from '../src/index';
import type { SQLiteAdapter, WikiFact, OntologyManifest } from '../src/types';

const PREFIX = 'llm_wiki_';

async function entryColumns(db: SQLiteAdapter): Promise<string[]> {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${PREFIX}entries)`);
  return cols.map(c => c.name);
}

describe('migration v7 — ontology_checked_at', () => {
  it('fresh install has the column via base schema', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    expect(await entryColumns(db)).toContain('ontology_checked_at');
  });

  it('upgrade from v6 adds the column, and re-running is idempotent', async () => {
    const db = openTestDatabase();
    // Simulate a pre-v7 install: base schema without the new column.
    await db.execAsync(`
      CREATE TABLE ${PREFIX}entries (
        id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL DEFAULT 'inferred',
        source_type TEXT NOT NULL DEFAULT 'librarian_inferred', source_hash TEXT, source_ref TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_accessed_at INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
        embedding TEXT, embedding_blob BLOB, okf_type TEXT
      );
    `);
    const v7 = MIGRATIONS.find(m => m.version === 7)!;
    expect(v7).toBeDefined();
    await v7.run(db, PREFIX);
    expect(await entryColumns(db)).toContain('ontology_checked_at');
    await v7.run(db, PREFIX); // idempotent — no throw
    expect((await entryColumns(db)).filter(c => c === 'ontology_checked_at')).toHaveLength(1);
  });
});

import { EntryRepository } from '../src/repositories/EntryRepository';
import { OutboxRepository } from '../src/repositories/OutboxRepository';

function makeRepo(db: SQLiteAdapter): EntryRepository {
  return new EntryRepository(db, PREFIX, new OutboxRepository(db, PREFIX, false));
}

async function seedEntry(db: SQLiteAdapter, opts: {
  id: string; entityId?: string; title?: string; body?: string; updatedAt?: number;
  okfType?: string | null; checkedAt?: number | null; deletedAt?: number | null;
}): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries
       (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at,
        access_count, deleted_at, okf_type, ontology_checked_at)
     VALUES (?, ?, ?, ?, '[]', 'certain', 'user_stated', ?, ?, 0, ?, ?, ?)`,
    [opts.id, opts.entityId ?? 'e1', opts.title ?? `title ${opts.id}`, opts.body ?? `body ${opts.id}`,
     opts.updatedAt ?? 1000, opts.updatedAt ?? 1000,
     opts.deletedAt ?? null, opts.okfType ?? null, opts.checkedAt ?? null],
  );
}

describe('EntryRepository — backfill methods', () => {
  it('findUntypedByEntityId: untyped, live, past cooldown, oldest first, limited', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    const repo = makeRepo(db);
    await seedEntry(db, { id: 'f_old', updatedAt: 100 });
    await seedEntry(db, { id: 'f_new', updatedAt: 200 });
    await seedEntry(db, { id: 'f_typed', updatedAt: 50, okfType: 'person' });
    await seedEntry(db, { id: 'f_deleted', updatedAt: 60, deletedAt: 999 });
    await seedEntry(db, { id: 'f_cooling', updatedAt: 70, checkedAt: 5000 });
    await seedEntry(db, { id: 'f_recheck_due', updatedAt: 80, checkedAt: 400 });
    await seedEntry(db, { id: 'f_other_entity', entityId: 'e2', updatedAt: 10 });

    const rows = await repo.findUntypedByEntityId('e1', 10, 400);
    expect(rows.map(r => r.id)).toEqual(['f_recheck_due', 'f_old', 'f_new']);

    const limited = await repo.findUntypedByEntityId('e1', 2, 400);
    expect(limited.map(r => r.id)).toEqual(['f_recheck_due', 'f_old']);
  });

  it('countUntypedByEntityId splits eligible vs deferred', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    const repo = makeRepo(db);
    await seedEntry(db, { id: 'a' });
    await seedEntry(db, { id: 'b', checkedAt: 5000 });
    await seedEntry(db, { id: 'c', checkedAt: 100 });
    await seedEntry(db, { id: 'd', okfType: 'person' });
    expect(await repo.countUntypedByEntityId('e1', 400)).toEqual({ eligible: 2, deferred: 1 });
  });

  it('updateOkfType only writes when okf_type IS NULL; returns changes', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    const repo = makeRepo(db);
    await seedEntry(db, { id: 'u1' });
    await seedEntry(db, { id: 'u2', okfType: 'place' });
    await db.withTransactionAsync(async (tx) => {
      expect((await repo.updateOkfType('u1', 'e1', 'person', tx)).changes).toBe(1);
      expect((await repo.updateOkfType('u2', 'e1', 'person', tx)).changes).toBe(0);
      expect((await repo.updateOkfType('u1', 'wrong-entity', 'place', tx)).changes).toBe(0);
    });
    const row = await db.getFirstAsync<{ okf_type: string }>(
      `SELECT okf_type FROM ${PREFIX}entries WHERE id = 'u2'`);
    expect(row!.okf_type).toBe('place');
  });

  it('markOntologyChecked stamps cooldown and never touches updated_at', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    const repo = makeRepo(db);
    await seedEntry(db, { id: 'm1', updatedAt: 111 });
    await seedEntry(db, { id: 'm2', updatedAt: 222 });
    await db.withTransactionAsync(tx => repo.markOntologyChecked(['m1', 'm2'], 'e1', 9999, tx));
    const rows = await db.getAllAsync<{ id: string; updated_at: number; ontology_checked_at: number }>(
      `SELECT id, updated_at, ontology_checked_at FROM ${PREFIX}entries ORDER BY id`);
    expect(rows).toEqual([
      { id: 'm1', updated_at: 111, ontology_checked_at: 9999 },
      { id: 'm2', updated_at: 222, ontology_checked_at: 9999 },
    ]);
  });

  it('findTitleIndexByEntityId returns id/title/okf_type for all live facts', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    const repo = makeRepo(db);
    await seedEntry(db, { id: 't1', title: 'Alpha', okfType: 'person' });
    await seedEntry(db, { id: 't2', title: 'Beta' });
    await seedEntry(db, { id: 't3', title: 'Gone', deletedAt: 5 });
    const rows = await repo.findTitleIndexByEntityId('e1');
    expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 't1', title: 'Alpha', okf_type: 'person' },
      { id: 't2', title: 'Beta', okf_type: null },
    ]);
  });
});
