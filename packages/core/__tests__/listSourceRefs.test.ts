import { describe, it, expect, beforeEach } from 'vitest';
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
  row: { id: string; sourceRef: string; sourceHash: string; updatedAt: number; deletedAt?: number | null },
): Promise<void> {
  const now = row.updatedAt;
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type,
      source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, 'entity-1', 'T', 'B', '[]', 'certain', 'immutable_document',
     row.sourceHash, row.sourceRef, now, now, null, 0, row.deletedAt ?? null],
  );
}

describe('EntryRepository.listSourceRefs', () => {
  it('returns one row per live sourceRef with factCount and lastIngestedAt', async () => {
    const { wiki, db } = await makeWiki();
    await insertEntry(db, { id: 'f1', sourceRef: 'a.md', sourceHash: VALID_HASH_A, updatedAt: 1000 });
    await insertEntry(db, { id: 'f2', sourceRef: 'a.md', sourceHash: VALID_HASH_A, updatedAt: 1100 });
    await insertEntry(db, { id: 'f3', sourceRef: 'b.md', sourceHash: VALID_HASH_A, updatedAt: 1200 });

    const out = await wiki['entryRepo'].listSourceRefs('entity-1');
    expect(out).toEqual([
      { sourceRef: 'a.md', sourceHash: VALID_HASH_A, factCount: 2, lastIngestedAt: 1100 },
      { sourceRef: 'b.md', sourceHash: VALID_HASH_A, factCount: 1, lastIngestedAt: 1200 },
    ]);
  });

  it('returns empty array for an entity with no entries', async () => {
    const { wiki } = await makeWiki();
    expect(await wiki['entryRepo'].listSourceRefs('entity-empty')).toEqual([]);
  });

  it('excludes soft-deleted rows and only counts live facts', async () => {
    const { wiki, db } = await makeWiki();
    await insertEntry(db, { id: 'f1', sourceRef: 'a.md', sourceHash: VALID_HASH_A, updatedAt: 1000, deletedAt: 999 });
    await insertEntry(db, { id: 'f2', sourceRef: 'a.md', sourceHash: VALID_HASH_A, updatedAt: 1100 });

    const out = await wiki['entryRepo'].listSourceRefs('entity-1');
    expect(out).toEqual([
      { sourceRef: 'a.md', sourceHash: VALID_HASH_A, factCount: 1, lastIngestedAt: 1100 },
    ]);
  });

  it('returns the sourceHash from the row with MAX(updated_at), not MAX(source_hash) lex order', async () => {
    const { wiki, db } = await makeWiki();
    // Two live rows for the same ref with different hashes and updated_at values.
    // The row with the most recent updated_at should win regardless of hash lex order.
    const lexicallyLargerButOlder = 'f'.repeat(64); // sorts after VALID_HASH_B
    await insertEntry(db, { id: 'f1', sourceRef: 'a.md', sourceHash: lexicallyLargerButOlder, updatedAt: 1000 });
    await insertEntry(db, { id: 'f2', sourceRef: 'a.md', sourceHash: VALID_HASH_B, updatedAt: 1100 });

    const out = await wiki['entryRepo'].listSourceRefs('entity-1');
    expect(out).toHaveLength(1);
    expect(out[0].sourceHash).toBe(VALID_HASH_B); // newest updated_at, not lexically max
  });

  it('returns sourceRef as null hash when only the live row has source_hash IS NULL', async () => {
    const { wiki, db } = await makeWiki();
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type,
        source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f1', 'entity-1', 'T', 'B', '[]', 'certain', 'immutable_document', null, 'a.md', 1000, 1000, null, 0, null],
    );

    const out = await wiki['entryRepo'].listSourceRefs('entity-1');
    expect(out).toEqual([
      { sourceRef: 'a.md', sourceHash: null, factCount: 1, lastIngestedAt: 1000 },
    ]);
  });

  it('sorts results by sourceRef COLLATE BINARY (not locale)', async () => {
    const { wiki, db } = await makeWiki();
    // 'Z' < 'a' under BINARY; 'a' < 'Z' under localeCompare in some locales.
    await insertEntry(db, { id: 'f1', sourceRef: 'a.md', sourceHash: VALID_HASH_A, updatedAt: 1000 });
    await insertEntry(db, { id: 'f2', sourceRef: 'Z.md', sourceHash: VALID_HASH_A, updatedAt: 1000 });

    const out = await wiki['entryRepo'].listSourceRefs('entity-1');
    expect(out.map(r => r.sourceRef)).toEqual(['Z.md', 'a.md']);
  });
});

describe('WikiMemory.listSourceRefs – cross-method consistency', () => {
  it('sourceHash matches single-doc findLatestSourceHash for every ref (regression guard against MAX(source_hash) anti-pattern)', async () => {
    const { wiki, db } = await makeWiki();
    // Ref "a.md" has two live hashes (the same anomaly the import path produces).
    const lexLarger = 'f'.repeat(64);
    await insertEntry(db, { id: 'f1', sourceRef: 'a.md', sourceHash: lexLarger, updatedAt: 1000 });
    await insertEntry(db, { id: 'f2', sourceRef: 'a.md', sourceHash: VALID_HASH_B, updatedAt: 1100 });
    await insertEntry(db, { id: 'f3', sourceRef: 'b.md', sourceHash: VALID_HASH_A, updatedAt: 1200 });

    const refs = await wiki.listSourceRefs('entity-1');
    expect(refs).toHaveLength(2);

    for (const row of refs) {
      const latestHash = await wiki.__testAccess.entryRepo.findLatestSourceHash('entity-1', row.sourceRef);
      expect(row.sourceHash).toBe(latestHash);
    }
  });
});
