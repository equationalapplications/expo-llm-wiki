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

  it('returns the live ref for a given (entity_id, source_hash) — at most one under the v9 UNIQUE index', async () => {
    const { wiki, db } = await makeWiki();
    // The v9 partial UNIQUE index forbids two LIVE rows sharing
    // (entity_id, source_hash). Each row here uses a distinct hash; the
    // function still answers "what ref holds this hash?" — it just returns
    // at most one ref per (entity_id, source_hash) pair.
    const hash1 = '1'.repeat(64);
    const hash2 = '2'.repeat(64);
    const hash3 = '3'.repeat(64);
    await insertEntry(db, { id: 'f1', sourceRef: 'mail/inbox/a.md', sourceHash: hash1, updatedAt: 1000 });
    await insertEntry(db, { id: 'f2', sourceRef: 'mail/inbox/a.md', sourceHash: hash2, updatedAt: 1100 });
    await insertEntry(db, { id: 'f3', sourceRef: 'mail/sent/a.md', sourceHash: hash3, updatedAt: 1200 });

    expect(await wiki.findSourceRefsByHash('entity-1', hash1)).toEqual(['mail/inbox/a.md']);
    expect(await wiki.findSourceRefsByHash('entity-1', hash2)).toEqual(['mail/inbox/a.md']);
    expect(await wiki.findSourceRefsByHash('entity-1', hash3)).toEqual(['mail/sent/a.md']);
  });

  it('returns the single ref sorted COLLATE BINARY (uppercase before lowercase)', async () => {
    const { wiki, db } = await makeWiki();
    // With the v9 UNIQUE index, each hash maps to at most one ref, so the
    // COLLATE BINARY sort is trivial — but the function path through the
    // repo still has to honor it.
    const hash1 = '1'.repeat(64);
    const hash2 = '2'.repeat(64);
    await insertEntry(db, { id: 'f1', sourceRef: 'a.md', sourceHash: hash1, updatedAt: 1000 });
    await insertEntry(db, { id: 'f2', sourceRef: 'Z.md', sourceHash: hash2, updatedAt: 1000 });

    expect(await wiki.findSourceRefsByHash('entity-1', hash1)).toEqual(['a.md']);
    expect(await wiki.findSourceRefsByHash('entity-1', hash2)).toEqual(['Z.md']);
  });

  it('excludes soft-deleted rows when querying by their hash (regression guard)', async () => {
    const { wiki, db } = await makeWiki();
    // The v9 partial UNIQUE index allows a soft-deleted row to share a hash
    // with a live row (deleted_at IS NULL filter). The live row's ref wins.
    // Both rows below use the SAME hash so the partial-index WHERE clause
    // is exercised end-to-end: an unconditional UNIQUE index would have
    // prevented this fixture from existing at all.
    const hashLive = '1'.repeat(64);
    await insertEntry(db, { id: 'f1', sourceRef: 'a.md', sourceHash: hashLive, updatedAt: 1000 });
    await insertEntry(db, { id: 'f2', sourceRef: 'b.md', sourceHash: hashLive, updatedAt: 1000, deletedAt: 999 });

    expect(await wiki.findSourceRefsByHash('entity-1', hashLive)).toEqual(['a.md']);
    // The soft-deleted row is excluded by the query (WHERE deleted_at IS NULL)
    // even though its hash matches the live row's.
    expect((await wiki.findSourceRefsByHash('entity-1', hashLive))).toHaveLength(1);
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
    // Distinct hashes so both rows are valid under the v9 UNIQUE index.
    const hashA = '1'.repeat(64);
    const hashB = '2'.repeat(64);
    await insertEntry(db, { id: 'f1', sourceRef: 'a.md', sourceHash: hashA, updatedAt: 1000 });
    await insertEntry(db, { id: 'f2', sourceRef: null, sourceHash: hashB, updatedAt: 1100 });

    // Querying by hashA returns only the row with source_ref='a.md' (the null-ref
    // row carries hashB and the partial UNIQUE index excludes NULL source_hashes).
    expect(await wiki.findSourceRefsByHash('entity-1', hashA)).toEqual(['a.md']);
  });
});
