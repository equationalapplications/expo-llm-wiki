import { describe, it, expect, vi } from 'vitest';
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
    const entryRepo = wiki.__testAccess.entryRepo;
    const latestHashesSpy = vi.spyOn(entryRepo, 'findLatestSourceHashes');
    const findByHashSpy = vi.spyOn(entryRepo, 'findSourceRefsByHash');

    const result = await wiki.hasChanged('entity-1', []);
    expect(result).toEqual([]);

    // Strict guard: empty input must short-circuit before any repo call.
    expect(latestHashesSpy).not.toHaveBeenCalled();
    expect(findByHashSpy).not.toHaveBeenCalled();
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
      ['f1', 'entity-1', 'T', 'B', '[]', 'certain', 'immutable_document', VALID_HASH_A, 'mail-inbox-a.md', 1000, 1000, null, 0, null],
    );
    const out = await wiki.hasChanged('entity-1', [{ sourceRef: 'mail-sent-a.md', sourceHash: VALID_HASH_A }]);
    expect(out).toEqual([{ sourceRef: 'mail-sent-a.md', changed: true, duplicateOf: 'mail-inbox-a.md' }]);
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

  it('mixed entries: unchanged / changed / duplicate-of-stored (pre-check)', async () => {
    const { wiki, db } = await makeWiki();
    // Under the v9 UNIQUE index, the DB can hold at most one live row per
    // (entity_id, source_hash). Stored "duplicates" are no longer reachable,
    // so the duplicateOf signal in hasChanged is now a pre-check against
    // whatever ref is already stored for a given hash.
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type,
        source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f1', 'entity-1', 'T', 'B', '[]', 'certain', 'immutable_document', VALID_HASH_A, 'same.md', 1000, 1000, null, 0, null],
    );

    const out = await wiki.hasChanged('entity-1', [
      { sourceRef: 'same.md', sourceHash: VALID_HASH_A },        // unchanged
      { sourceRef: 'changed.md', sourceHash: VALID_HASH_B },     // changed, no collision
      { sourceRef: 'incoming.md', sourceHash: VALID_HASH_A },    // changed + duplicate of same.md
    ]);
    expect(out).toEqual([
      { sourceRef: 'same.md', changed: false },
      { sourceRef: 'changed.md', changed: true },
      { sourceRef: 'incoming.md', changed: true, duplicateOf: 'same.md' },
    ]);
  });
});

describe('WikiMemory.hasChanged — multi-live-hash regression (ROW_NUMBER vs MAX(source_hash))', () => {
  it('batched result agrees with single-doc hasChanged when importDump seeded multiple live hashes for the same ref', async () => {
    const { wiki } = await makeWiki();

    // Two live rows for the SAME ref at different updated_at values, with
    // different hashes. The row with the most-recent updated_at is the one
    // that should win. MAX(source_hash) would return 'f'.repeat(64) here
    // because it sorts lexically after 'b'.repeat(64); the test fails the
    // moment the SQL is "cleaned up" to MAX(source_hash).
    const newerHash = 'b'.repeat(64);    // 'b' < 'f' lexically
    const olderHash = 'f'.repeat(64);
    const dump = {
      generatedAt: 1,
      entities: {
        'entity-1': {
          facts: [
            {
              id: 'fact-newer',
              entity_id: 'entity-1',
              title: 'T',
              body: 'B',
              tags: [],
              confidence: 'certain',
              source_type: 'immutable_document',
              source_hash: newerHash,
              source_ref: 'doc.md',
              created_at: 1000,
              updated_at: 1100,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
              okf_type: null,
            },
            {
              id: 'fact-older',
              entity_id: 'entity-1',
              title: 'T',
              body: 'B',
              tags: [],
              confidence: 'certain',
              source_type: 'immutable_document',
              source_hash: olderHash,
              source_ref: 'doc.md',
              created_at: 500,
              updated_at: 600,
              last_accessed_at: null,
              access_count: 0,
              deleted_at: null,
              okf_type: null,
            },
          ],
          tasks: [],
          events: [],
          edges: [],
        },
      },
    };
    await wiki.importDump(dump as any);

    // Sanity: both rows are live.
    const liveRows = await wiki.__testAccess.entryRepo.findAllByEntityId('entity-1');
    expect(liveRows).toHaveLength(2);

    // Single-doc: should report newerHash (the more recent updated_at).
    const singleChanged = await wiki.hasChanged('entity-1', 'doc.md', newerHash);
    expect(singleChanged).toBe(false); // matching newerHash → unchanged

    // Batched: must agree with the single-doc result.
    const batched = await wiki.hasChanged('entity-1', [{ sourceRef: 'doc.md', sourceHash: newerHash }]);
    expect(batched).toEqual([{ sourceRef: 'doc.md', changed: false }]);

    // Cross-check: feeding the older hash to single-doc must report changed
    // (because the latest row holds newerHash, not olderHash).
    expect(await wiki.hasChanged('entity-1', 'doc.md', olderHash)).toBe(true);

    // ...and the batched path must agree.
    const batchedOlder = await wiki.hasChanged('entity-1', [{ sourceRef: 'doc.md', sourceHash: olderHash }]);
    expect(batchedOlder).toEqual([{ sourceRef: 'doc.md', changed: true }]);
  });

  it('listSourceRefs surfaces the row with MAX(updated_at) hash, not MAX(source_hash) — same anomaly, different surface', async () => {
    const { wiki } = await makeWiki();
    const newerHash = 'b'.repeat(64);
    const olderHash = 'f'.repeat(64);
    const dump = {
      generatedAt: 1,
      entities: {
        'entity-1': {
          facts: [
            {
              id: 'fact-newer',
              entity_id: 'entity-1',
              title: 'T', body: 'B', tags: [], confidence: 'certain',
              source_type: 'immutable_document', source_hash: newerHash, source_ref: 'doc.md',
              created_at: 1000, updated_at: 1100, last_accessed_at: null, access_count: 0, deleted_at: null,
              okf_type: null,
            },
            {
              id: 'fact-older',
              entity_id: 'entity-1',
              title: 'T', body: 'B', tags: [], confidence: 'certain',
              source_type: 'immutable_document', source_hash: olderHash, source_ref: 'doc.md',
              created_at: 500, updated_at: 600, last_accessed_at: null, access_count: 0, deleted_at: null,
              okf_type: null,
            },
          ],
          tasks: [],
          events: [],
          edges: [],
        },
      },
    };
    await wiki.importDump(dump as any);

    const refs = await wiki.listSourceRefs('entity-1');
    expect(refs).toHaveLength(1);
    expect(refs[0].sourceRef).toBe('doc.md');
    expect(refs[0].sourceHash).toBe(newerHash); // most-recent updated_at, NOT lex max
    expect(refs[0].factCount).toBe(2);
  });
});

describe('WikiMemory.hasChanged — concurrency bounds', () => {
  it('batched hasChanged acquires no lock and writes no rows', async () => {
    const { wiki, db } = await makeWiki();
    // Sanity: nothing is in flight for entity-1.
    const jm = wiki.__testAccess.jobManager;
    expect(jm.isBlocked('forget', 'entity-1')).toBe(false);
    expect(jm.isBlocked('ingest', 'entity-1')).toBe(false);

    const entriesBefore = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM llm_wiki_entries WHERE entity_id = ?`,
      ['entity-1'],
    );

    await wiki.hasChanged('entity-1', [{ sourceRef: 'a.md', sourceHash: VALID_HASH_A }]);

    // No lock should be held after the call either.
    expect(jm.isBlocked('forget', 'entity-1')).toBe(false);
    expect(jm.isBlocked('ingest', 'entity-1')).toBe(false);

    // No new rows should have been inserted.
    const entriesAfter = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM llm_wiki_entries WHERE entity_id = ?`,
      ['entity-1'],
    );
    expect(entriesAfter).toHaveLength(entriesBefore.length);
  });

  it('single-doc hasChanged acquires no lock and writes no rows', async () => {
    const { wiki, db } = await makeWiki();
    const jm = wiki.__testAccess.jobManager;
    const entriesBefore = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM llm_wiki_entries WHERE entity_id = ?`,
      ['entity-1'],
    );

    await wiki.hasChanged('entity-1', 'a.md', VALID_HASH_A);

    expect(jm.isBlocked('forget', 'entity-1')).toBe(false);
    expect(jm.isBlocked('ingest', 'entity-1')).toBe(false);
    const entriesAfter = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM llm_wiki_entries WHERE entity_id = ?`,
      ['entity-1'],
    );
    expect(entriesAfter).toHaveLength(entriesBefore.length);
  });
});
