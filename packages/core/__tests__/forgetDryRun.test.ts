import { describe, it, expect, beforeEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import type { SQLiteAdapter } from '../src/types';

const VALID_HASH_A = 'a'.repeat(64);

async function makeWiki(): Promise<{ wiki: WikiMemory; db: SQLiteAdapter }> {
  const db = openTestDatabase();
  await setupDatabase(db, 'llm_wiki_');
  const wiki = new WikiMemory(db, {
    llmProvider: {
      generateText: async () => '{}',
      embed: async () => new Float32Array([0]),
    },
  });
  await wiki.setup();
  return { wiki, db };
}

async function insertEntry(
  db: SQLiteAdapter,
  row: { id: string; sourceRef: string; sourceHash: string; updatedAt: number; deletedAt?: number | null },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type,
      source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, 'entity-1', 'T', 'B', '[]', 'certain', 'immutable_document',
     row.sourceHash, row.sourceRef, row.updatedAt, row.updatedAt, null, 0, row.deletedAt ?? null],
  );
}

describe('MaintenanceService.forget({ dryRun: true })', () => {
  it('returns the same shape as the real call: standard case has NO metadataReset field', async () => {
    const { wiki, db } = await makeWiki();
    await insertEntry(db, { id: 'f1', sourceRef: 'a.md', sourceHash: VALID_HASH_A, updatedAt: 1000 });
    await insertEntry(db, { id: 'f2', sourceRef: 'a.md', sourceHash: VALID_HASH_A, updatedAt: 1100 });

    const result = await wiki.forget('entity-1', { sourceRef: 'a.md' }, { dryRun: true });
    expect(result).toEqual({ deleted: { entries: 2, tasks: 0 } });
    expect('metadataReset' in result).toBe(false);
  });

  it('does not mutate any rows', async () => {
    const { wiki, db } = await makeWiki();
    await insertEntry(db, { id: 'f1', sourceRef: 'a.md', sourceHash: VALID_HASH_A, updatedAt: 1000 });

    await wiki.forget('entity-1', { sourceRef: 'a.md' }, { dryRun: true });

    const rows = await db.getAllAsync<{ id: string; deleted_at: number | null }>(
      `SELECT id, deleted_at FROM llm_wiki_entries WHERE entity_id = ?`,
      ['entity-1'],
    );
    expect(rows.every(r => r.deleted_at === null)).toBe(true);
  });

  it('does not acquire the forget lock', async () => {
    const { wiki } = await makeWiki();
    const jm = wiki.__testAccess.jobManager;
    expect(jm.isBlocked('forget', 'entity-1')).toBe(false);
    await wiki.forget('entity-1', { sourceRef: 'a.md' }, { dryRun: true });
    expect(jm.isBlocked('forget', 'entity-1')).toBe(false);
  });

  it('returns metadataReset: true when clearAll: true is requested (dry-run)', async () => {
    const { wiki } = await makeWiki();
    const result = await wiki.forget('entity-1', { clearAll: true }, { dryRun: true });
    expect(result).toEqual({ deleted: { entries: 0, tasks: 0 }, metadataReset: true });
  });

  it('returns { deleted: { entries: 0, tasks: 0 } } for unknown refs (no metadataReset)', async () => {
    const { wiki } = await makeWiki();
    const result = await wiki.forget('entity-1', { sourceRef: 'no-such.md' }, { dryRun: true });
    expect(result).toEqual({ deleted: { entries: 0, tasks: 0 } });
    expect('metadataReset' in result).toBe(false);
  });
});
