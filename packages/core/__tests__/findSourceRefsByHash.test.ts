import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import type { SQLiteAdapter } from '../src/types';

const VALID_HASH_A = 'a'.repeat(64);
const VALID_HASH_B = 'b'.repeat(64);

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
  row: { id: string; sourceRef: string | null; sourceHash: string | null; updatedAt: number; deletedAt?: number | null },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type,
      source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, 'entity-1', 'T', 'B', '[]', 'certain', 'immutable_document',
     row.sourceHash, row.sourceRef, row.updatedAt, row.updatedAt, null, 0, row.deletedAt ?? null],
  );
}

describe('WikiMemory.findSourceRefsByHash', () => {
  it('returns empty for an unknown hash', async () => {
    const { wiki } = await makeWiki();
    expect(await wiki.findSourceRefsByHash('entity-1', VALID_HASH_A)).toEqual([]);
  });

  it('returns one ref per live source_ref holding the hash', async () => {
    const { wiki, db } = await makeWiki();
    await insertEntry(db, { id: 'f1', sourceRef: 'mail/inbox/a.md', sourceHash: VALID_HASH_A, updatedAt: 1000 });
    await insertEntry(db, { id: 'f2', sourceRef: 'mail/inbox/a.md', sourceHash: VALID_HASH_A, updatedAt: 1100 });
    await insertEntry(db, { id: 'f3', sourceRef: 'mail/sent/a.md', sourceHash: VALID_HASH_A, updatedAt: 1200 });

    expect(await wiki.findSourceRefsByHash('entity-1', VALID_HASH_A)).toEqual([
      'mail/inbox/a.md',
      'mail/sent/a.md',
    ]);
  });

  it('sorts results COLLATE BINARY (uppercase before lowercase)', async () => {
    const { wiki, db } = await makeWiki();
    await insertEntry(db, { id: 'f1', sourceRef: 'a.md', sourceHash: VALID_HASH_A, updatedAt: 1000 });
    await insertEntry(db, { id: 'f2', sourceRef: 'Z.md', sourceHash: VALID_HASH_A, updatedAt: 1000 });

    expect(await wiki.findSourceRefsByHash('entity-1', VALID_HASH_A)).toEqual(['Z.md', 'a.md']);
  });

  it('excludes soft-deleted rows with the same hash (regression guard)', async () => {
    const { wiki, db } = await makeWiki();
    await insertEntry(db, { id: 'f1', sourceRef: 'a.md', sourceHash: VALID_HASH_A, updatedAt: 1000 });
    await insertEntry(db, { id: 'f2', sourceRef: 'b.md', sourceHash: VALID_HASH_A, updatedAt: 1000, deletedAt: 999 });

    expect(await wiki.findSourceRefsByHash('entity-1', VALID_HASH_A)).toEqual(['a.md']);
  });

  it('does not return refs from a different entity', async () => {
    const { wiki, db } = await makeWiki();
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type,
        source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f1', 'entity-2', 'T', 'B', '[]', 'certain', 'immutable_document', VALID_HASH_A, 'a.md', 1000, 1000, null, 0, null],
    );

    expect(await wiki.findSourceRefsByHash('entity-1', VALID_HASH_A)).toEqual([]);
  });

  it('returns empty for a hash that no row holds', async () => {
    const { wiki, db } = await makeWiki();
    await insertEntry(db, { id: 'f1', sourceRef: 'a.md', sourceHash: VALID_HASH_A, updatedAt: 1000 });
    expect(await wiki.findSourceRefsByHash('entity-1', VALID_HASH_B)).toEqual([]);
  });

  it('excludes legacy rows with null source_ref (regression guard)', async () => {
    const { wiki, db } = await makeWiki();
    await insertEntry(db, { id: 'f1', sourceRef: 'a.md', sourceHash: VALID_HASH_A, updatedAt: 1000 });
    await insertEntry(db, { id: 'f2', sourceRef: null, sourceHash: VALID_HASH_A, updatedAt: 1100 });

    expect(await wiki.findSourceRefsByHash('entity-1', VALID_HASH_A)).toEqual(['a.md']);
  });
});
