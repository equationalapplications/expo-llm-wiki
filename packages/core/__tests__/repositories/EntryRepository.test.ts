import { describe, it, expect, beforeEach } from 'vitest';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import { setupDatabase } from '../../src/db/schema';
import { MIGRATIONS } from '../../src/db/migrations';
import { EntryRepository } from '../../src/repositories/EntryRepository';
import { OutboxRepository } from '../../src/repositories/OutboxRepository';
import type { SQLiteAdapter, WikiFact } from '../../src/types';

async function setupWithOutbox(db: SQLiteAdapter, prefix: string): Promise<void> {
  await setupDatabase(db, prefix);
  const migration = MIGRATIONS.find(m => m.version === 4);
  if (migration) {
    await migration.run(db, prefix);
  }
}

function makeFact(overrides?: Partial<WikiFact>): WikiFact {
  return {
    id: 'fact_' + Math.random().toString(36).slice(2),
    entity_id: 'entity1',
    title: 'Test Fact',
    body: 'Body here',
    tags: ['tag1'],
    confidence: 'certain',
    source_type: 'user_stated',
    source_hash: null,
    source_ref: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    last_accessed_at: null,
    deleted_at: null,
    access_count: 0,
    ...overrides,
  };
}

describe('EntryRepository', () => {
  let db: ReturnType<typeof openTestDatabase>;
  let repo: EntryRepository;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, 'llm_wiki_');
    repo = new EntryRepository(db, 'llm_wiki_');
  });

  it('mapRowToFact handles missing/null tags', async () => {
    await db.execAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, access_count)
      VALUES ('f1', 'e1', 'T', 'B', 'not-json', 'certain', 'user_stated', 1, 1, 0)`);
    const facts = await repo.findByIds(['f1']);
    expect(facts.length).toBe(1);
    expect(Array.isArray(facts[0].tags)).toBe(true);
  });

  it('findByIds chunks at 501st ID', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 501; i++) {
      const f = makeFact({ id: `f${i}`, title: `Fact ${i}` });
      await repo.upsert(f);
      ids.push(f.id);
    }
    const facts = await repo.findByIds(ids);
    expect(facts.length).toBe(501);
  });

  it('upsert overwrites existing record (LWW)', async () => {
    const fact = makeFact({ title: 'V1' });
    await repo.upsert(fact);
    fact.title = 'V2';
    await repo.upsert(fact);
    const facts = await repo.findByIds([fact.id]);
    expect(facts[0].title).toBe('V2');
  });

  it('upsert sets updated_at to now (timestamp authority in repo)', async () => {
    const before = Date.now();
    const fact = makeFact();
    const result = await repo.upsert(fact);
    expect(result.changes).toBe(1);
    const rows = await db.getAllAsync(`SELECT updated_at FROM llm_wiki_entries WHERE id = ?`, [fact.id]);
    expect(Number(rows[0].updated_at)).toBeGreaterThanOrEqual(before);
  });

  it('softDelete sets deleted_at and updated_at', async () => {
    const fact = makeFact();
    await repo.upsert(fact);
    const result = await repo.softDelete(fact.id, fact.entity_id);
    expect(result.changes).toBe(1);
    const rows = await db.getAllAsync(`SELECT deleted_at, updated_at FROM llm_wiki_entries WHERE id = ?`, [fact.id]);
    expect(Number(rows[0].deleted_at)).toBeGreaterThan(0);
    expect(Number(rows[0].updated_at)).toBeGreaterThan(0);
  });

  it('getPrunableMetadata returns only old soft-deleted rows', async () => {
    const oldFact = makeFact({ id: 'old1' });
    await repo.upsert(oldFact);
    await repo.softDelete(oldFact.id, oldFact.entity_id);
    // Manually set old deleted_at
    await db.execAsync(`UPDATE llm_wiki_entries SET deleted_at = ${Date.now() - 10 * 86400000} WHERE id = 'old1'`);
    const recentFact = makeFact({ id: 'recent1' });
    await repo.upsert(recentFact);
    await repo.softDelete(recentFact.id, recentFact.entity_id);
    const cutoff = Date.now() - 5 * 86400000;
    const rows = await repo.getPrunableMetadata('entity1', cutoff);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('old1');
  });
});

describe('EntryRepository with OutboxRepository', () => {
  let db: ReturnType<typeof openTestDatabase>;
  let repo: EntryRepository;
  let outbox: OutboxRepository;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupWithOutbox(db, 'llm_wiki_');
    outbox = new OutboxRepository(db, 'llm_wiki_');
    repo = new EntryRepository(db, 'llm_wiki_', outbox);
  });

  it('upsert() with tx stages outbox entry with operation=UPDATE', async () => {
    const fact = makeFact();
    await db.withTransactionAsync(async () => {
      await repo.upsert(fact, db);
    });
    const pending = await outbox.fetchPending();
    expect(pending.length).toBe(1);
    expect(pending[0].operation).toBe('UPDATE');
    expect(pending[0].record_id).toBe(fact.id);
    expect(pending[0].table_name).toBe('entries');
    expect(pending[0].entity_id).toBe(fact.entity_id);
  });

  it('upsert() with deleted_at stages outbox entry with operation=DELETE', async () => {
    const fact = makeFact({ deleted_at: Date.now() });
    await db.withTransactionAsync(async () => {
      await repo.upsert(fact, db);
    });
    const pending = await outbox.fetchPending();
    expect(pending.length).toBe(1);
    expect(pending[0].operation).toBe('DELETE');
  });

  it('softDelete() with tx stages outbox entry with operation=DELETE', async () => {
    const fact = makeFact();
    await repo.upsert(fact);
    await db.withTransactionAsync(async () => {
      await repo.softDelete(fact.id, fact.entity_id, db);
    });
    const pending = await outbox.fetchPending();
    expect(pending.length).toBe(1);
    expect(pending[0].operation).toBe('DELETE');
    expect(pending[0].record_id).toBe(fact.id);
  });

  it('upsert() without tx does not stage outbox entry', async () => {
    const fact = makeFact();
    await repo.upsert(fact);
    const pending = await outbox.fetchPending();
    expect(pending.length).toBe(0);
  });

  it('upsert without outbox still works (no crash)', async () => {
    const repoNoOutbox = new EntryRepository(db, 'llm_wiki_');
    const fact = makeFact();
    const result = await repoNoOutbox.upsert(fact);
    expect(result.changes).toBe(1);
    const pending = await outbox.fetchPending();
    expect(pending.length).toBe(0);
  });

  it('rollback of tx removes both entry and outbox row', async () => {
    const fact = makeFact();
    await expect(
      db.withTransactionAsync(async () => {
        await repo.upsert(fact, db);
        throw new Error('simulated rollback');
      }),
    ).rejects.toThrow('simulated rollback');

    const entries = await db.getAllAsync('SELECT * FROM llm_wiki_entries WHERE id = ?', [fact.id]);
    expect(entries.length).toBe(0);
    const pending = await outbox.fetchPending();
    expect(pending.length).toBe(0);
  });
});
