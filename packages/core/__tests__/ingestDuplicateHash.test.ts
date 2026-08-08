import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiDuplicateHashError } from '../src/types';
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
      generateText: async () => JSON.stringify({ facts: [] }),
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

async function insertSourceRefIndexRow(
  db: SQLiteAdapter,
  row: { sourceRef: string; sourceHash: string; createdAt?: number },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO llm_wiki_source_ref_index (id, entity_id, source_hash, source_ref, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [`sri_${row.sourceRef}_${row.sourceHash}_${row.createdAt ?? 0}`, 'entity-1', row.sourceHash, row.sourceRef, row.createdAt ?? 0],
  );
}

describe('IngestionService.ingestDocument duplicate-hash guard', () => {
  it("onDuplicateHash='skip' returns immediately with duplicateOf when another ref holds the hash", async () => {
    const { wiki, db } = await makeWiki();
    await insertSourceRefIndexRow(db, { sourceRef: 'mail-inbox-a.md', sourceHash: VALID_HASH_A });
    const result = await wiki.ingestDocument(
      'entity-1',
      { sourceRef: 'mail-sent-a.md', sourceHash: VALID_HASH_A, documentChunk: 'hello' },
      { onDuplicateHash: 'skip' },
    );
    expect(result).toEqual({ truncated: false, chunks: 0, duplicateOf: 'mail-inbox-a.md' });
  });

  it("onDuplicateHash='skip' makes zero LLM calls / zero DB writes / zero outbox events", async () => {
    const { wiki, db } = await makeWiki();
    await insertSourceRefIndexRow(db, { sourceRef: 'mail-inbox-a.md', sourceHash: VALID_HASH_A });

    const spy = vi.spyOn(wiki.__testAccess.ingestionService['options']['llmProvider'], 'generateText');
    const entriesBefore = await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_entries WHERE entity_id = ?`, ['entity-1']);
    const outboxBefore = await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_outbox`);

    const result = await wiki.ingestDocument(
      'entity-1',
      { sourceRef: 'mail-sent-a.md', sourceHash: VALID_HASH_A, documentChunk: 'hello' },
      { onDuplicateHash: 'skip' },
    );

    expect(result).toEqual({ truncated: false, chunks: 0, duplicateOf: 'mail-inbox-a.md' });
    expect(spy).not.toHaveBeenCalled();
    const entriesAfter = await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_entries WHERE entity_id = ?`, ['entity-1']);
    expect(entriesAfter).toHaveLength(entriesBefore.length);
    const outboxAfter = await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_outbox`);
    expect(outboxAfter).toHaveLength(outboxBefore.length);
  });

  it("onDuplicateHash='skip' returns the early-return shape (no setImmediate/Promise.resolve wrapping)", async () => {
    const { wiki, db } = await makeWiki();
    await insertSourceRefIndexRow(db, { sourceRef: 'mail-inbox-a.md', sourceHash: VALID_HASH_A });

    const result = await wiki.ingestDocument(
      'entity-1',
      { sourceRef: 'mail-sent-a.md', sourceHash: VALID_HASH_A, documentChunk: 'hello' },
      { onDuplicateHash: 'skip' },
    );
    expect(result).toEqual({ truncated: false, chunks: 0, duplicateOf: 'mail-inbox-a.md' });
  });

  it("onDuplicateHash='throw' throws WikiDuplicateHashError", async () => {
    const { wiki, db } = await makeWiki();
    await insertSourceRefIndexRow(db, { sourceRef: 'mail-inbox-a.md', sourceHash: VALID_HASH_A });

    await expect(
      wiki.ingestDocument(
        'entity-1',
        { sourceRef: 'mail-sent-a.md', sourceHash: VALID_HASH_A, documentChunk: 'hello' },
        { onDuplicateHash: 'throw' },
      ),
    ).rejects.toBeInstanceOf(WikiDuplicateHashError);
  });

  it('WikiDuplicateHashError carries canonical, sourceHash, entityId', async () => {
    const { wiki, db } = await makeWiki();
    await insertSourceRefIndexRow(db, { sourceRef: 'mail-inbox-a.md', sourceHash: VALID_HASH_A });
    try {
      await wiki.ingestDocument(
        'entity-1',
        { sourceRef: 'mail-sent-a.md', sourceHash: VALID_HASH_A, documentChunk: 'hello' },
        { onDuplicateHash: 'throw' },
      );
      expect.fail('expected throw');
    } catch (err) {
      const e = err as WikiDuplicateHashError;
      expect(e.canonical).toBe('mail-inbox-a.md');
      expect(e.sourceHash).toBe(VALID_HASH_A);
      expect(e.entityId).toBe('entity-1');
      expect(e).toBeInstanceOf(Error);
    }
  });

  it("onDuplicateHash='ingest' (default) throws WikiDuplicateHashError when another ref holds the hash (tightened behavior)", async () => {
    const { wiki, db } = await makeWiki();
    await insertSourceRefIndexRow(db, { sourceRef: 'mail-inbox-a.md', sourceHash: VALID_HASH_A });

    // Pre-v9 'ingest' mode silently wrote even when a sibling sourceRef
    // already held the hash — the documented behavior in the source-ref-
    // lifecycle spec §2. Post-v9 the v9 source_ref_index UNIQUE catches
    // the race and the catch-and-translate throws WikiDuplicateHashError
    // instead, which is the documented tightening.
    await expect(
      wiki.ingestDocument(
        'entity-1',
        { sourceRef: 'mail-sent-a.md', sourceHash: VALID_HASH_A, documentChunk: 'hello' },
        { onDuplicateHash: 'ingest' },
      ),
    ).rejects.toBeInstanceOf(WikiDuplicateHashError);
  });

  it('Same-sourceRef collision does NOT fire the guard', async () => {
    const { wiki, db } = await makeWiki();
    await insertSourceRefIndexRow(db, { sourceRef: 'a.md', sourceHash: VALID_HASH_A });

    const result = await wiki.ingestDocument(
      'entity-1',
      { sourceRef: 'a.md', sourceHash: VALID_HASH_A, documentChunk: 'hello' },
      { onDuplicateHash: 'skip' },
    );
    expect(result.duplicateOf).toBeUndefined();
    expect(result.chunks).toBeGreaterThan(0);
  });

  it('Soft-deleted row does NOT fire the guard', async () => {
    const { wiki, db } = await makeWiki();
    // No live source_ref_index row exists for this hash; the guard finds no
    // collision and proceeds with the normal ingest.
    await insertEntry(db, { id: 'f1', sourceRef: 'mail-inbox-a.md', sourceHash: VALID_HASH_A, updatedAt: 1000, deletedAt: 999 });

    const result = await wiki.ingestDocument(
      'entity-1',
      { sourceRef: 'mail-sent-a.md', sourceHash: VALID_HASH_A, documentChunk: 'hello' },
      { onDuplicateHash: 'skip' },
    );
    expect(result.duplicateOf).toBeUndefined();
  });
});
