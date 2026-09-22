import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiDuplicateHashError } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import type { SQLiteAdapter, WikiConfig, WikiDiagnostic } from '../src/types';

const VALID_HASH_A = 'a'.repeat(64);

async function makeWiki(opts: {
  generateText?: () => Promise<string>;
  config?: WikiConfig;
  onDiagnostic?: (d: WikiDiagnostic) => void;
} = {}): Promise<{ wiki: WikiMemory; db: SQLiteAdapter }> {
  const db = openTestDatabase();
  await setupDatabase(db, 'llm_wiki_');
  const wiki = new WikiMemory(db, {
    llmProvider: {
      generateText: opts.generateText
        ?? (async () => JSON.stringify({ facts: [{ title: 'T', body: 'B', tags: [], confidence: 'certain' }] })),
      embed: async () => new Float32Array([0]),
    },
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.onDiagnostic ? { onDiagnostic: opts.onDiagnostic } : {}),
  });
  await wiki.setup();
  return { wiki, db };
}

/**
 * Insert a live row directly into the source_ref_index table so the test can
 * fabricate a "pre-existing live ref" without going through ingestDocument.
 * The row matches what a successful ingestDocument would have written for
 * `(entity, sourceHash, sourceRef)`. Bypasses the partial UNIQUE index check
 * by running inside a transaction that is rolled back if the insert fails.
 */
async function insertSourceRefIndexRow(
  db: SQLiteAdapter,
  row: { entityId: string; sourceRef: string; sourceHash: string; createdAt?: number },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO llm_wiki_source_ref_index (id, entity_id, source_hash, source_ref, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [`sri_test_${row.sourceRef}_${row.createdAt ?? 0}`, row.entityId, row.sourceHash, row.sourceRef, row.createdAt ?? 0],
  );
}

/**
 * Bypass the pre-check (the translation path only fires when the pre-check's
 * snapshot was already stale) by injecting the colliding source_ref_index
 * row via a monkeypatched `findActiveByEntityAndHash`.
 *
 * For `'skip'` / `'throw'`, the first call IS the pre-check: we insert the
 * canonical row right then (simulating a writer that landed between the
 * pre-check snapshot and our transaction write), then return null so the
 * pre-check reports no collision and ingestDocument proceeds into the
 * transaction. The second call — the catch-block lookup — falls through to
 * the real repo and observes the row.
 *
 * For default `'ingest'` mode there is no pre-check, so the canonical row
 * must already exist by the time the transaction INSERT fires — we insert
 * it before calling `ingestDocument` (the first mock call is the catch-block
 * lookup and returns the real repo, which finds the row).
 */
async function ingestWithRaceInjected(
  wiki: WikiMemory,
  db: SQLiteAdapter,
  args: { sourceRef: string; sourceHash: string; canonicalRef: string; onDuplicateHash?: 'ingest' | 'skip' | 'throw'; documentChunk?: string },
) {
  const sourceRefIndexRepo = (wiki as any).sourceRefIndexRepo;
  const original = sourceRefIndexRepo.findActiveByEntityAndHash.bind(sourceRefIndexRepo);
  const mode = args.onDuplicateHash ?? 'ingest';
  let firstCallDone = false;

  if (mode === 'ingest') {
    // Default mode has no pre-check; the row must exist before the
    // transaction INSERT for the UNIQUE constraint to fire.
    await insertSourceRefIndexRow(db, { entityId: 'entity-1', sourceRef: args.canonicalRef, sourceHash: args.sourceHash });
  }

  sourceRefIndexRepo.findActiveByEntityAndHash = async (entityId: string, hash: string, tx?: SQLiteAdapter) => {
    if (!firstCallDone) {
      firstCallDone = true;
      if (mode === 'skip' || mode === 'throw') {
        // First call IS the pre-check. Inject the collision now (simulating
        // a writer that landed between the pre-check snapshot and our
        // transaction write), then report no collision so ingestDocument
        // continues into the transaction (which trips the UNIQUE index and
        // exercises the catch-and-translate path).
        await insertSourceRefIndexRow(db, { entityId, sourceRef: args.canonicalRef, sourceHash: hash });
        return null;
      }
      // Default 'ingest' mode: the first call is the catch-block lookup.
      // The canonical row was inserted before ingestDocument ran, so the
      // real repo finds it.
      return original(entityId, hash, tx);
    }
    // Subsequent calls (catch-block lookup for skip/throw) use the real
    // repo so the translation sees the true collision.
    return original(entityId, hash, tx);
  };

  try {
    return await wiki.ingestDocument(
      'entity-1',
      { sourceRef: args.sourceRef, sourceHash: args.sourceHash, documentChunk: args.documentChunk ?? 'hello world' },
      { onDuplicateHash: args.onDuplicateHash },
    );
  } finally {
    sourceRefIndexRepo.findActiveByEntityAndHash = original;
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
    expect(result).toEqual({ truncated: false, chunks: 0, ingestedChunks: 0, failedChunks: 0, duplicateOf: 'canonical.md' });
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

describe('IngestionService — N=10 concurrent race-cloaking (v9 source_ref_index + hash lock + translation)', () => {
  it('exactly one live source_ref_index row survives per iteration; every loser gets the expected per-mode result; no deadlock', async () => {
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

      // Exactly one sourceRef in source_ref_index for this hash.
      const refs = await wiki.findSourceRefsByHash('entity-1', hash);
      expect(refs).toEqual([winnerRef]);
    }
  }, 60_000);
});

describe('IngestionService — diagnostics on a lost duplicate-hash race (#221)', () => {
  // One chunk yielding, in order: an invalid item (fact_rejected at itemIndex 0),
  // 'T' (kept, and ungrounded under draft mode -> grounding_missing carrying the
  // factId minted inside the transaction), and a second 'T' (fact_deduplicated
  // at itemIndex 2). The write then loses the race and rolls back.
  const RACE_LLM = async () => JSON.stringify({
    facts: [
      { nope: 1 },
      { title: 'T', body: 'B', tags: [], confidence: 'certain' },
      { title: 'T', body: 'B2', tags: [], confidence: 'certain' },
    ],
  });

  async function raceWithDiagnostics(mode: 'ingest' | 'skip' | 'throw') {
    const diagnostics: WikiDiagnostic[] = [];
    const { wiki, db } = await makeWiki({
      generateText: RACE_LLM,
      config: { grounding: { mode: 'draft' } },
      onDiagnostic: (d) => { diagnostics.push(d); },
    });
    const run = ingestWithRaceInjected(wiki, db, {
      sourceRef: 'racer.md',
      sourceHash: VALID_HASH_A,
      canonicalRef: 'canonical.md',
      onDuplicateHash: mode,
      documentChunk: 'hello world',
    });
    const outcome = await run.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    return { diagnostics, outcome };
  }

  it("mode 'skip': the host receives the LLM-pass diagnostics for the work it paid for", async () => {
    const { diagnostics, outcome } = await raceWithDiagnostics('skip');
    expect(outcome.ok).toBe(true);
    expect(diagnostics.map((d) => d.code).sort()).toEqual(['fact_deduplicated', 'fact_rejected']);
  });

  it('a racing skip emits no diagnostic naming a fact that was never committed', async () => {
    const { diagnostics } = await raceWithDiagnostics('skip');
    // The grounding_missing for 'T' was buffered inside the transaction and
    // carries a factId that rolled back; it must not reach the host.
    expect(diagnostics.filter((d) => d.code.startsWith('grounding_'))).toEqual([]);
    expect(diagnostics.filter((d) => d.detail?.factId !== undefined)).toEqual([]);
  });

  it('the surviving diagnostics keep their locators into the LLM response', async () => {
    const { diagnostics } = await raceWithDiagnostics('skip');
    const detail = (code: string) => diagnostics.find((d) => d.code === code)?.detail;
    expect(detail('fact_rejected')).toMatchObject({ sourceRef: 'racer.md', chunkIndex: 0, itemIndex: 0 });
    expect(detail('fact_deduplicated')).toMatchObject({ sourceRef: 'racer.md', chunkIndex: 0, itemIndex: 2, reason: 'exact_title' });
  });

  it.each(['throw', 'ingest'] as const)(
    "mode '%s': the same subset is flushed before WikiDuplicateHashError is raised",
    async (mode) => {
      const { diagnostics, outcome } = await raceWithDiagnostics(mode);
      expect(outcome.ok).toBe(false);
      expect((outcome as { error: unknown }).error).toBeInstanceOf(WikiDuplicateHashError);
      // What the host learns about the LLM response does not depend on which
      // duplicate-hash mode it chose — including the locators, not just the
      // set of codes.
      expect(diagnostics.map((d) => d.code).sort()).toEqual(['fact_deduplicated', 'fact_rejected']);
      const detail = (code: string) => diagnostics.find((d) => d.code === code)?.detail;
      expect(detail('fact_rejected')).toMatchObject({ sourceRef: 'racer.md', chunkIndex: 0, itemIndex: 0 });
      expect(detail('fact_deduplicated')).toMatchObject({ sourceRef: 'racer.md', chunkIndex: 0, itemIndex: 2, reason: 'exact_title' });
      expect(diagnostics.filter((d) => d.detail?.factId !== undefined)).toEqual([]);
    },
  );

  it('a UNIQUE violation with no live canonical ref still reports the LLM pass, then re-throws the original error', async () => {
    // The racing writer's own row was rolled back or soft-deleted before we
    // looked, so we cannot name a canonical ref. The race still happened —
    // source_ref_index is the only UNIQUE that can raise in this transaction —
    // so the LLM-pass diagnostics are still true and must reach the host even
    // though the host gets the raw error rather than WikiDuplicateHashError.
    const diagnostics: WikiDiagnostic[] = [];
    const { wiki, db } = await makeWiki({
      generateText: RACE_LLM,
      config: { grounding: { mode: 'draft' } },
      onDiagnostic: (d) => { diagnostics.push(d); },
    });
    const repo = (wiki as any).sourceRefIndexRepo;
    const original = repo.findActiveByEntityAndHash.bind(repo);
    let call = 0;
    repo.findActiveByEntityAndHash = async (entityId: string, hash: string, tx?: SQLiteAdapter) => {
      call++;
      // 1st call is the pre-check: inject the collision so our write trips the
      // UNIQUE index. 2nd is the catch-block lookup: report the winner gone.
      if (call === 1) {
        await insertSourceRefIndexRow(db, { entityId, sourceRef: 'canonical.md', sourceHash: hash });
        return null;
      }
      if (call === 2) return null;
      return original(entityId, hash, tx);
    };
    try {
      await expect(
        wiki.ingestDocument(
          'entity-1',
          { sourceRef: 'racer.md', sourceHash: VALID_HASH_A, documentChunk: 'hello world' },
          { onDuplicateHash: 'skip' },
        ),
      ).rejects.not.toBeInstanceOf(WikiDuplicateHashError);
    } finally {
      repo.findActiveByEntityAndHash = original;
    }
    expect(diagnostics.map((d) => d.code).sort()).toEqual(['fact_deduplicated', 'fact_rejected']);
    expect(diagnostics.filter((d) => d.detail?.factId !== undefined)).toEqual([]);
  });

  it('a non-racing ingest still flushes the full buffer, grounding diagnostics included', async () => {
    const diagnostics: WikiDiagnostic[] = [];
    const { wiki } = await makeWiki({
      generateText: RACE_LLM,
      config: { grounding: { mode: 'draft' } },
      onDiagnostic: (d) => { diagnostics.push(d); },
    });
    await wiki.ingestDocument('entity-1', { sourceRef: 'solo.md', sourceHash: VALID_HASH_A, documentChunk: 'hello world' });
    expect(diagnostics.map((d) => d.code).sort()).toEqual(['fact_deduplicated', 'fact_rejected', 'grounding_missing']);
    expect(diagnostics.find((d) => d.code === 'grounding_missing')?.detail?.factId).toEqual(expect.any(String));
  });
});
