import { describe, it, expect, beforeEach } from 'vitest';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import { setupDatabase } from '../../src/db/schema';
import { MetadataRepository } from '../../src/repositories/MetadataRepository';

const PREFIX = 'llm_wiki_';

describe('MetadataRepository', () => {
  let db: ReturnType<typeof openTestDatabase>;
  let repo: MetadataRepository;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    repo = new MetadataRepository(db, PREFIX);
  });

  // ---------------------------------------------------------------------------
  // getCheckpoint
  // ---------------------------------------------------------------------------

  it('getCheckpoint returns empty object when entity has no row', async () => {
    const result = await repo.getCheckpoint('nonexistent', db);
    expect(result).toEqual({});
    expect(result.memory).toBeUndefined();
    expect(result.heal).toBeUndefined();
  });

  it('getCheckpoint returns correct values after updateCheckpoint with both fields', async () => {
    await repo.updateCheckpoint('entity1', { memory: 10, heal: 20 }, db);
    const result = await repo.getCheckpoint('entity1', db);
    expect(result.memory).toBe(10);
    expect(result.heal).toBe(20);
  });

  // ---------------------------------------------------------------------------
  // updateCheckpoint
  // ---------------------------------------------------------------------------

  it('updateCheckpoint with memory only — only memory changes', async () => {
    // seed both fields
    await repo.updateCheckpoint('entity1', { memory: 5, heal: 15 }, db);
    // update only memory
    await repo.updateCheckpoint('entity1', { memory: 99 }, db);
    const result = await repo.getCheckpoint('entity1', db);
    expect(result.memory).toBe(99);
    expect(result.heal).toBe(15);
  });

  it('updateCheckpoint with heal only — only heal changes', async () => {
    // seed both fields
    await repo.updateCheckpoint('entity1', { memory: 5, heal: 15 }, db);
    // update only heal
    await repo.updateCheckpoint('entity1', { heal: 77 }, db);
    const result = await repo.getCheckpoint('entity1', db);
    expect(result.memory).toBe(5);
    expect(result.heal).toBe(77);
  });

  it('updateCheckpoint with both fields — both change', async () => {
    await repo.updateCheckpoint('entity1', { memory: 1, heal: 2 }, db);
    await repo.updateCheckpoint('entity1', { memory: 100, heal: 200 }, db);
    const result = await repo.getCheckpoint('entity1', db);
    expect(result.memory).toBe(100);
    expect(result.heal).toBe(200);
  });

  it('updateCheckpoint empty updates — no-op, no row inserted', async () => {
    await repo.updateCheckpoint('entity1', {}, db);
    // no row should exist
    const rows = await db.getAllAsync(`SELECT * FROM ${PREFIX}checkpoints WHERE entity_id = ?`, [
      'entity1',
    ]);
    expect(rows.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // getMeta
  // ---------------------------------------------------------------------------

  it('getMeta returns null for unknown key', async () => {
    const value = await repo.getMeta('unknown_key');
    expect(value).toBeNull();
  });

  it('getMeta returns value after setMeta', async () => {
    await repo.setMeta('myKey', 'myValue', db);
    const value = await repo.getMeta('myKey');
    expect(value).toBe('myValue');
  });

  // ---------------------------------------------------------------------------
  // setMeta
  // ---------------------------------------------------------------------------

  it('setMeta inserts and overwrites', async () => {
    await repo.setMeta('k', 'first', db);
    await repo.setMeta('k', 'second', db);
    const value = await repo.getMeta('k');
    expect(value).toBe('second');
  });

  it('setMeta works inside a transaction (tx parameter)', async () => {
    await db.withTransactionAsync(async () => {
      await repo.setMeta('txKey', 'txValue', db);
    });
    const value = await repo.getMeta('txKey');
    expect(value).toBe('txValue');
  });

  // ---------------------------------------------------------------------------
  // updateCheckpoint rollback
  // ---------------------------------------------------------------------------

  it('updateCheckpoint rollback — changes not committed on tx rollback', async () => {
    // seed a value first
    await repo.updateCheckpoint('entity1', { memory: 5, heal: 10 }, db);

    try {
      await db.withTransactionAsync(async () => {
        await repo.updateCheckpoint('entity1', { memory: 999 }, db);
        throw new Error('force rollback');
      });
    } catch {
      // expected
    }

    const result = await repo.getCheckpoint('entity1', db);
    expect(result.memory).toBe(5);
    expect(result.heal).toBe(10);
  });
});

describe('MetadataRepository.getDistinctEntityIds', () => {
  let db: ReturnType<typeof openTestDatabase>;
  let repo: MetadataRepository;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    repo = new MetadataRepository(db, PREFIX);
  });

  async function seedEntry(entityId: string, deleted = false): Promise<void> {
    const id = `f_${entityId}_${Math.random().toString(36).slice(2)}`;
    await db.runAsync(
      `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, tags, confidence, source_type,
        source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, entityId, 't', 'b', '[]', 'certain', 'immutable_document',
       'a'.repeat(64), 'src', 1000, 1000, null, 0, deleted ? 1500 : null],
    );
  }
  async function seedTask(entityId: string, deleted = false): Promise<void> {
    await db.runAsync(
      `INSERT INTO ${PREFIX}tasks (id, entity_id, description, status, priority, created_at, updated_at, resolved_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`tk_${entityId}_${Math.random()}`, entityId, 'desc', 'pending', 1, 1000, 1000, null, deleted ? 1500 : null],
    );
  }
  async function seedEvent(entityId: string): Promise<void> {
    await db.runAsync(
      `INSERT INTO ${PREFIX}events (id, entity_id, event_type, summary, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [`ev_${entityId}_${Math.random()}`, entityId, 'observation', 'sum', 1000],
    );
  }

  it('returns [] for empty database', async () => {
    expect(await repo.getDistinctEntityIds()).toEqual([]);
  });

  it('returns ids sorted ascending COLLATE BINARY across entries/tasks/events', async () => {
    await seedEntry('bravo');
    await seedEntry('alpha');
    await seedTask('charlie');
    await seedEvent('delta');
    expect(await repo.getDistinctEntityIds()).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
  });

  it('includes entities whose only rows are soft-deleted (closes the decommissioned-scope leak)', async () => {
    await seedEntry('live', false);
    await seedEntry('orphaned', true);
    await seedTask('orphaned', true);
    const ids = await repo.getDistinctEntityIds();
    expect(ids).toContain('live');
    expect(ids).toContain('orphaned');
  });

  it('returns each id only once even if present in entries/tasks/events', async () => {
    await seedEntry('shared');
    await seedTask('shared');
    await seedEvent('shared');
    expect(await repo.getDistinctEntityIds()).toEqual(['shared']);
  });

  it('sorts ids with COLLATE BINARY ordering (uppercase before lowercase)', async () => {
    await seedEntry('alpha');
    await seedEntry('Bravo');
    await seedTask('charlie');
    const ids = await repo.getDistinctEntityIds();
    // SQLite default BINARY collation: ASCII ordering, uppercase letters (0x41–0x5A)
    // sort before lowercase (0x61–0x7A).
    expect(ids).toEqual(['Bravo', 'alpha', 'charlie']);
  });
});
