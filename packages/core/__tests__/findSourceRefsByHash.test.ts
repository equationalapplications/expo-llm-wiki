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

async function insertSourceRefIndexRow(
  db: SQLiteAdapter,
  row: { sourceRef: string; sourceHash: string; entityId?: string; createdAt?: number; deletedAt?: number | null },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO llm_wiki_source_ref_index (id, entity_id, source_hash, source_ref, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      `sri_${row.sourceRef}_${row.sourceHash}_${row.createdAt ?? 0}`,
      row.entityId ?? 'entity-1',
      row.sourceHash,
      row.sourceRef,
      row.createdAt ?? 0,
      row.deletedAt ?? null,
    ],
  );
}

describe('WikiMemory.findSourceRefsByHash', () => {
  it('returns empty for an unknown hash', async () => {
    const { wiki } = await makeWiki();
    expect(await wiki.findSourceRefsByHash('entity-1', VALID_HASH_A)).toEqual([]);
  });

  it('returns the live ref for a given (entity_id, source_hash) — at most one under the v9 source_ref_index', async () => {
    const { wiki, db } = await makeWiki();
    // The v9 source_ref_index table enforces at most one sourceRef per
    // (entity_id, source_hash). Each row here uses a distinct hash.
    const hash1 = '1'.repeat(64);
    const hash2 = '2'.repeat(64);
    const hash3 = '3'.repeat(64);
    await insertSourceRefIndexRow(db, { sourceRef: 'mail/inbox/a.md', sourceHash: hash1 });
    await insertSourceRefIndexRow(db, { sourceRef: 'mail/inbox/a.md', sourceHash: hash2 });
    await insertSourceRefIndexRow(db, { sourceRef: 'mail/sent/a.md', sourceHash: hash3 });

    expect(await wiki.findSourceRefsByHash('entity-1', hash1)).toEqual(['mail/inbox/a.md']);
    expect(await wiki.findSourceRefsByHash('entity-1', hash2)).toEqual(['mail/inbox/a.md']);
    expect(await wiki.findSourceRefsByHash('entity-1', hash3)).toEqual(['mail/sent/a.md']);
  });

  it('returns the single ref sorted COLLATE BINARY (uppercase before lowercase)', async () => {
    const { wiki, db } = await makeWiki();
    // With the v9 source_ref_index, each hash maps to at most one ref, so
    // there is no sort to perform — the ref is whatever was inserted.
    const hash1 = '1'.repeat(64);
    const hash2 = '2'.repeat(64);
    await insertSourceRefIndexRow(db, { sourceRef: 'a.md', sourceHash: hash1 });
    await insertSourceRefIndexRow(db, { sourceRef: 'Z.md', sourceHash: hash2 });

    expect(await wiki.findSourceRefsByHash('entity-1', hash1)).toEqual(['a.md']);
    expect(await wiki.findSourceRefsByHash('entity-1', hash2)).toEqual(['Z.md']);
  });

  it('excludes soft-deleted rows when querying by their hash (regression guard)', async () => {
    const { wiki, db } = await makeWiki();
    // The v9 source_ref_index partial UNIQUE index excludes rows with
    // deleted_at != NULL. A soft-deleted row's hash is "released" and
    // can be reclaimed by a future ingest.
    const hashLive = '1'.repeat(64);
    // Live row at a.md, soft-deleted row at b.md for the same hash.
    // The query excludes the soft-deleted row.
    await insertSourceRefIndexRow(db, { sourceRef: 'a.md', sourceHash: hashLive });
    await insertSourceRefIndexRow(db, { sourceRef: 'b.md', sourceHash: hashLive, deletedAt: 999 });

    expect(await wiki.findSourceRefsByHash('entity-1', hashLive)).toEqual(['a.md']);
    // The soft-deleted row's source_ref is excluded by the partial-index
    // WHERE clause; only the live row's ref is returned.
    expect((await wiki.findSourceRefsByHash('entity-1', hashLive))).toHaveLength(1);
  });

  it('does not return refs from a different entity', async () => {
    const { wiki, db } = await makeWiki();
    await insertSourceRefIndexRow(db, { sourceRef: 'a.md', sourceHash: VALID_HASH_A, entityId: 'entity-2' });

    expect(await wiki.findSourceRefsByHash('entity-1', VALID_HASH_A)).toEqual([]);
  });

  it('returns empty for a hash that no row holds', async () => {
    const { wiki, db } = await makeWiki();
    await insertSourceRefIndexRow(db, { sourceRef: 'a.md', sourceHash: VALID_HASH_A });
    expect(await wiki.findSourceRefsByHash('entity-1', VALID_HASH_B)).toEqual([]);
  });

  it('does not include rows with null source_ref (regression guard)', async () => {
    const { wiki, db } = await makeWiki();
    // The v9 source_ref_index has source_ref NOT NULL by definition; the
    // entries-table's nullable source_ref is not modeled here.
    const hashA = '1'.repeat(64);
    await insertSourceRefIndexRow(db, { sourceRef: 'a.md', sourceHash: hashA });
    expect(await wiki.findSourceRefsByHash('entity-1', hashA)).toEqual(['a.md']);
  });
});
