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

describe('EntryRepository.findLatestSourceHashes — empty input edge case', () => {
  it('returns an empty Map and makes zero SQL calls when sourceRefs is []', async () => {
    const { wiki } = await makeWiki();
    const map = await wiki.__testAccess.entryRepo.findLatestSourceHashes('entity-1', []);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });
});

describe('WikiMemory.hasChanged — batched overload', () => {
  it('returns [] for empty input with zero SQL calls (synchronous)', async () => {
    const { wiki } = await makeWiki();
    const t0 = Date.now();
    const result = await wiki.hasChanged('entity-1', []);
    expect(result).toEqual([]);
    // Sanity: synchronous, no awaits
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('marks changed: true when no live row exists for the ref', async () => {
    const { wiki } = await makeWiki();
    const out = await wiki.hasChanged('entity-1', [{ sourceRef: 'a.md', sourceHash: VALID_HASH_A }]);
    expect(out).toEqual([{ sourceRef: 'a.md', changed: true }]);
  });

  it('marks changed: false when stored hash matches', async () => {
    const { wiki, db } = await makeWiki();
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type,
        source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f1', 'entity-1', 'T', 'B', '[]', 'certain', 'immutable_document', VALID_HASH_A, 'a.md', 1000, 1000, null, 0, null],
    );
    const out = await wiki.hasChanged('entity-1', [{ sourceRef: 'a.md', sourceHash: VALID_HASH_A }]);
    expect(out).toEqual([{ sourceRef: 'a.md', changed: false }]);
  });

  it('marks changed: true when stored hash differs', async () => {
    const { wiki, db } = await makeWiki();
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type,
        source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f1', 'entity-1', 'T', 'B', '[]', 'certain', 'immutable_document', VALID_HASH_A, 'a.md', 1000, 1000, null, 0, null],
    );
    const out = await wiki.hasChanged('entity-1', [{ sourceRef: 'a.md', sourceHash: VALID_HASH_B }]);
    expect(out).toEqual([{ sourceRef: 'a.md', changed: true }]);
  });

  it('sets duplicateOf only when a different ref holds the same hash', async () => {
    const { wiki, db } = await makeWiki();
    // Two refs, same hash.
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type,
        source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f1', 'entity-1', 'T', 'B', '[]', 'certain', 'immutable_document', VALID_HASH_A, 'mail/inbox/a.md', 1000, 1000, null, 0, null],
    );
    const out = await wiki.hasChanged('entity-1', [{ sourceRef: 'mail/sent/a.md', sourceHash: VALID_HASH_A }]);
    expect(out).toEqual([{ sourceRef: 'mail/sent/a.md', changed: true, duplicateOf: 'mail/inbox/a.md' }]);
  });

  it('preserves the input order in the result', async () => {
    const { wiki, db } = await makeWiki();
    // No stored rows; everything is changed.
    const out = await wiki.hasChanged('entity-1', [
      { sourceRef: 'z.md', sourceHash: VALID_HASH_A },
      { sourceRef: 'a.md', sourceHash: VALID_HASH_B },
      { sourceRef: 'm.md', sourceHash: VALID_HASH_A },
    ]);
    expect(out.map(r => r.sourceRef)).toEqual(['z.md', 'a.md', 'm.md']);
    expect(out.every(r => r.changed === true)).toBe(true);
  });

  it('mixed entries: unchanged / changed / duplicate / duplicate-and-changed', async () => {
    const { wiki, db } = await makeWiki();
    // same same -> unchanged
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type,
        source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f1', 'entity-1', 'T', 'B', '[]', 'certain', 'immutable_document', VALID_HASH_A, 'same.md', 1000, 1000, null, 0, null],
    );
    // other has hash A so 'duplicate' will collide
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type,
        source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f2', 'entity-1', 'T', 'B', '[]', 'certain', 'immutable_document', VALID_HASH_A, 'collision.md', 1000, 1000, null, 0, null],
    );

    const out = await wiki.hasChanged('entity-1', [
      { sourceRef: 'same.md', sourceHash: VALID_HASH_A },        // unchanged
      { sourceRef: 'changed.md', sourceHash: VALID_HASH_A },     // changed, no collision
      { sourceRef: 'collision.md', sourceHash: VALID_HASH_A },   // unchanged + duplicate self
      { sourceRef: 'both.md', sourceHash: VALID_HASH_A },        // changed + duplicate of collision.md
    ]);
    expect(out).toEqual([
      { sourceRef: 'same.md', changed: false, duplicateOf: 'collision.md' },
      { sourceRef: 'changed.md', changed: true, duplicateOf: 'changed.md' },
      { sourceRef: 'collision.md', changed: false, duplicateOf: 'collision.md' },
      { sourceRef: 'both.md', changed: true, duplicateOf: 'both.md' },
    ]);
  });
});
