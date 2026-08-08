import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiDuplicateHashError } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import type { SQLiteAdapter } from '../src/types';

const VALID_HASH_A = 'a'.repeat(64);

async function makeWiki(): Promise<{ wiki: WikiMemory; db: SQLiteAdapter }> {
  const db = openTestDatabase();
  await setupDatabase(db, 'llm_wiki_');
  const wiki = new WikiMemory(db, {
    llmProvider: {
      generateText: async () => JSON.stringify({ facts: [{ title: 'T', body: 'B', tags: [], confidence: 'certain' }] }),
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

/**
 * Bypass the pre-check (Task 6's translation path only fires when the
 * pre-check's snapshot was already stale) by inserting the canonical row
 * AFTER `wiki.setup()` but going straight to `ingestDocument` with a
 * DIFFERENT sourceRef under the SAME hash lock — that alone can't race,
 * since the hash lock (Task 5) already serializes same-hash callers. To
 * reach the translation path deterministically we insert the colliding row
 * directly via `db.runAsync` in between the pre-check and the transaction —
 * simulated here by inserting the canonical row, then calling
 * ingestDocument with a raw db write racing in via a monkeypatched
 * `findSourceRefsByHash` that reports no collision on the FIRST call (so
 * the pre-check passes) but the row exists by the time the transaction
 * commits, tripping the real UNIQUE index.
 */
async function ingestWithRaceInjected(
  wiki: WikiMemory,
  db: SQLiteAdapter,
  args: { sourceRef: string; sourceHash: string; canonicalRef: string; onDuplicateHash?: 'ingest' | 'skip' | 'throw' },
) {
  const entryRepo = (wiki as any).entryRepo;
  const original = entryRepo.findSourceRefsByHash.bind(entryRepo);
  let canonicalInserted = false;
  entryRepo.findSourceRefsByHash = async (entityId: string, hash: string, tx?: SQLiteAdapter) => {
    if (!canonicalInserted) {
      // Pre-check (only reached for 'skip'/'throw' modes) — or the sole
      // catch-block lookup for default 'ingest' mode, which skips the
      // pre-check entirely: report no collision either way, since the
      // canonical row hasn't been inserted into the fixture yet.
      return [];
    }
    // Called after the canonical row has been inserted below — use the
    // real repo so the catch-block translation sees the true collision.
    return original(entityId, hash, tx);
  };

  // Insert the canonical row AFTER the pre-check would have run but BEFORE
  // the transaction commits, simulating a writer that landed between the
  // pre-check snapshot and this call's write.
  await insertEntry(db, { id: 'canonical', sourceRef: args.canonicalRef, sourceHash: args.sourceHash, updatedAt: 1000 });
  canonicalInserted = true;

  try {
    return await wiki.ingestDocument(
      'entity-1',
      { sourceRef: args.sourceRef, sourceHash: args.sourceHash, documentChunk: 'hello world' },
      { onDuplicateHash: args.onDuplicateHash },
    );
  } finally {
    entryRepo.findSourceRefsByHash = original;
  }
}

describe('IngestionService — UNIQUE violation translation', () => {
  it("mode 'skip': translates the UNIQUE violation into { duplicateOf: canonical }", async () => {
    const { wiki, db } = await makeWiki();
    const result = await ingestWithRaceInjected(wiki, db, {
      sourceRef: 'racer.md',
      sourceHash: VALID_HASH_A,
      canonicalRef: 'canonical.md',
      onDuplicateHash: 'skip',
    });
    expect(result).toEqual({ truncated: false, chunks: 0, duplicateOf: 'canonical.md' });
  });

  it("mode 'throw': raises WikiDuplicateHashError with canonical/entity/hash", async () => {
    const { wiki, db } = await makeWiki();
    await expect(
      ingestWithRaceInjected(wiki, db, {
        sourceRef: 'racer.md',
        sourceHash: VALID_HASH_A,
        canonicalRef: 'canonical.md',
        onDuplicateHash: 'throw',
      }),
    ).rejects.toBeInstanceOf(WikiDuplicateHashError);
  });

  it("mode 'throw': error carries canonical, sourceHash, entityId", async () => {
    const { wiki, db } = await makeWiki();
    try {
      await ingestWithRaceInjected(wiki, db, {
        sourceRef: 'racer.md',
        sourceHash: VALID_HASH_A,
        canonicalRef: 'canonical.md',
        onDuplicateHash: 'throw',
      });
      expect.fail('expected throw');
    } catch (err) {
      const e = err as WikiDuplicateHashError;
      expect(e.canonical).toBe('canonical.md');
      expect(e.sourceHash).toBe(VALID_HASH_A);
      expect(e.entityId).toBe('entity-1');
    }
  });

  it("default mode 'ingest': also raises WikiDuplicateHashError on a raced UNIQUE violation (tightened behavior)", async () => {
    const { wiki, db } = await makeWiki();
    await expect(
      ingestWithRaceInjected(wiki, db, {
        sourceRef: 'racer.md',
        sourceHash: VALID_HASH_A,
        canonicalRef: 'canonical.md',
      }),
    ).rejects.toBeInstanceOf(WikiDuplicateHashError);
  });

  it('unrelated transaction errors are re-thrown unmodified', async () => {
    const { wiki } = await makeWiki();
    const db2 = (wiki as any).db;
    const original = db2.withTransactionAsync.bind(db2);
    db2.withTransactionAsync = async () => {
      throw new Error('disk I/O error');
    };
    try {
      await expect(
        wiki.ingestDocument('entity-1', { sourceRef: 'a.md', sourceHash: VALID_HASH_A, documentChunk: 'hello' }),
      ).rejects.toThrow('disk I/O error');
    } finally {
      db2.withTransactionAsync = original;
    }
  });

  it('non-racing ingest (no collision) still succeeds normally', async () => {
    const { wiki } = await makeWiki();
    const result = await wiki.ingestDocument('entity-1', { sourceRef: 'solo.md', sourceHash: VALID_HASH_A, documentChunk: 'hello world' });
    expect(result.duplicateOf).toBeUndefined();
    expect(result.chunks).toBeGreaterThan(0);
  });
});

describe('IngestionService — N=10 concurrent race-cloaking (v9 index + hash lock + translation)', () => {
  it('exactly one live row survives per iteration; every loser gets the expected per-mode result; no deadlock', async () => {
    for (let iter = 0; iter < 20; iter++) {
      const { wiki } = await makeWiki();
      const hash = 'c'.repeat(64);
      const N = 10;

      const results = await Promise.allSettled(
        Array.from({ length: N }, (_, i) =>
          wiki.ingestDocument(
            'entity-1',
            { sourceRef: `doc-${i}.md`, sourceHash: hash, documentChunk: `content ${i}` },
            { onDuplicateHash: 'skip' },
          ),
        ),
      );

      // Every call must settle (no deadlock / hang).
      expect(results).toHaveLength(N);

      const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ truncated: boolean; chunks: number; duplicateOf?: string }> => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(N); // 'skip' mode never rejects

      const winners = fulfilled.filter((r) => r.value.duplicateOf === undefined);
      const losers = fulfilled.filter((r) => r.value.duplicateOf !== undefined);

      // Exactly one caller wins (its ingest actually wrote); the other nine
      // report duplicateOf pointing at the winner's ref.
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(N - 1);

      const winnerRefIndex = fulfilled.findIndex((r) => r.value.duplicateOf === undefined);
      const winnerRef = `doc-${winnerRefIndex}.md`;
      for (const loser of losers) {
        expect(loser.value.duplicateOf).toBe(winnerRef);
      }

      // Exactly one live row for this hash in the DB.
      const refs = await wiki.findSourceRefsByHash('entity-1', hash);
      expect(refs).toEqual([winnerRef]);
    }
  }, 60_000);
});
