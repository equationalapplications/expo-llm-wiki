import { describe, it, expect, beforeEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import type { SQLiteAdapter } from '../src/types';

async function seedEntry(db: SQLiteAdapter, entityId: string, deleted = false): Promise<void> {
  const id = `f_${entityId}_${Math.random().toString(36).slice(2)}`;
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type,
      source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entityId, 't', 'b', '[]', 'certain', 'immutable_document',
     'a'.repeat(64), 'src', 1000, 1000, null, 0, deleted ? 1500 : null],
  );
}

async function seedTask(db: SQLiteAdapter, entityId: string, deleted = false): Promise<void> {
  await db.runAsync(
    `INSERT INTO llm_wiki_tasks (id, entity_id, description, status, priority, created_at, updated_at, resolved_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`tk_${entityId}_${Math.random()}`, entityId, 'desc', 'pending', 1, 1000, 1000, null, deleted ? 1500 : null],
  );
}

async function seedEvent(db: SQLiteAdapter, entityId: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [`ev_${entityId}_${Math.random()}`, entityId, 'observation', 'sum', 1000],
  );
}

describe('WikiMemory.listEntityIds', () => {
  let wiki: WikiMemory;
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, 'llm_wiki_');
    wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await wiki.setup();
  });

  it('returns [] for an empty database', async () => {
    expect(await wiki.listEntityIds()).toEqual([]);
  });

  it('returns ids sorted ascending COLLATE BINARY', async () => {
    await seedEntry(db, 'bravo');
    await seedEntry(db, 'alpha');
    await seedTask(db, 'charlie');
    await seedEvent(db, 'delta');
    expect(await wiki.listEntityIds()).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
  });

  it('returns the union across entries/tasks/events with no soft-delete filter', async () => {
    await seedEntry(db, 'live-entity');
    await seedEntry(db, 'orphaned-entity', true);
    await seedTask(db, 'task-only-entity');
    const ids = await wiki.listEntityIds();
    expect(ids).toContain('live-entity');
    expect(ids).toContain('orphaned-entity');
    expect(ids).toContain('task-only-entity');
  });

  it('prefix filter scopes the result', async () => {
    await seedEntry(db, 'codebase:owner1/repo');
    await seedEntry(db, 'codebase:owner2/repo');
    await seedEntry(db, 'business');
    const filtered = await wiki.listEntityIds({ prefix: 'codebase:' });
    expect(filtered.sort()).toEqual(['codebase:owner1/repo', 'codebase:owner2/repo']);
  });

  it('empty-string prefix returns all ids', async () => {
    await seedEntry(db, 'a');
    await seedEntry(db, 'b');
    expect(await wiki.listEntityIds({ prefix: '' })).toEqual(['a', 'b']);
  });

  it('prefix matching nothing returns []', async () => {
    await seedEntry(db, 'a');
    expect(await wiki.listEntityIds({ prefix: 'zzz' })).toEqual([]);
  });

  it('does not acquire any lock and does not open a transaction', async () => {
    await seedEntry(db, 'a');
    // Concurrent import-lock acquisition on the same entity must succeed —
    // listEntityIds does not participate in the lock map.
    const result = await Promise.all([
      wiki.listEntityIds(),
      wiki.listEntityIds({ prefix: 'a' }),
      wiki.listEntityIds(),
    ]);
    expect(result[0]).toEqual(['a']);
    expect(result[1]).toEqual(['a']);
    expect(result[2]).toEqual(['a']);
  });
});
