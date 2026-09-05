import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;
const PREFIX = 'llm_wiki_';

/** A 3-dim float32 blob, matching the canonical dimension the tests set. */
const BLOB_3D = new Uint8Array(new Float32Array([1, 0, 0]).buffer);

function fact(id: string, entityId: string, blob?: Uint8Array) {
  return {
    id,
    entity_id: entityId,
    title: 'T',
    body: 'B',
    tags: [],
    confidence: 'certain',
    source_type: 'user_stated',
    source_hash: null,
    source_ref: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
    okf_type: 'fact',
    ...(blob ? { embedding_blob: blob } : {}),
  };
}

function dumpFor(entityId: string, blob?: Uint8Array) {
  return {
    generatedAt: 1_700_000_000_000,
    entities: {
      [entityId]: {
        facts: [fact(`f-${entityId}`, entityId, blob)],
        tasks: [],
        events: [],
        edges: [],
        summary: '',
      },
    },
  } as any;
}

async function getMarkerRow(db: SQLiteAdapter, factId: string) {
  return db.getFirstAsync<{
    embedding_failed_at: number | null;
    embedding_failure_kind: string | null;
    embedding_attempts: number;
  }>(
    `SELECT embedding_failed_at, embedding_failure_kind, embedding_attempts
       FROM ${PREFIX}entries WHERE id = ?`,
    [factId],
  );
}

/**
 * Entity A holds a marked, blob-less fact and the DB is primed so that an
 * import of entity B (carrying a 3-dim blob) reaches the promotion call site:
 * canonical dimension 3 == the imported blob's dimension.
 */
async function primed() {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, stubOptions);
  await wiki.setup();

  await wiki.importDump(dumpFor('A'));

  const repo = (wiki as any).entryRepo;
  const metadataRepo = (wiki as any).metadataRepo;
  const jobManager = (wiki as any).jobManager;

  await repo.markEmbeddingFailure('f-A', 'float32_overflow', 1000);
  await metadataRepo.setMeta('embedding_dimension', '3', db);
  await metadataRepo.setMeta('embedding_dimension_mismatch', '3', db);

  return { wiki, db, metadataRepo, jobManager };
}

describe('reembed lock scope — importDump promotion deferral', () => {
  it('promotes normally when no sweep is in flight (baseline)', async () => {
    const { wiki, db, metadataRepo } = await primed();

    await wiki.importDump(dumpFor('B', BLOB_3D));

    expect(await metadataRepo.getMeta('embedding_dimension_mismatch')).toBeNull();
    expect((await getMarkerRow(db, 'f-A'))?.embedding_failure_kind).toBeNull();
  });

  it('defers promotion while a per-entity sweep on another entity is in flight', async () => {
    const { wiki, db, metadataRepo, jobManager } = await primed();

    // Deliberate simulation: holding the raw lock instead of running a real
    // runReembed — the importDump gate reads only the lock table, so an
    // acquired 'reembed' lock is indistinguishable from a live sweep to it.
    jobManager.acquireLock('reembed', 'A');
    try {
      await wiki.importDump(dumpFor('B', BLOB_3D));
    } finally {
      jobManager.releaseLock('reembed', 'A');
    }

    // Promotion intent preserved, and the in-flight sweep's classification
    // for entity A survives untouched.
    expect(await metadataRepo.getMeta('embedding_dimension_mismatch')).toBe('3');
    const row = await getMarkerRow(db, 'f-A');
    expect(row?.embedding_failed_at).toBe(1000);
    expect(row?.embedding_failure_kind).toBe('float32_overflow');
  });

  it('completes the deferred promotion on the next import once the sweep ends', async () => {
    const { wiki, db, metadataRepo, jobManager } = await primed();

    jobManager.acquireLock('reembed', 'A');
    try {
      await wiki.importDump(dumpFor('B', BLOB_3D));
    } finally {
      jobManager.releaseLock('reembed', 'A');
    }
    expect(await metadataRepo.getMeta('embedding_dimension_mismatch')).toBe('3');

    // Sticky key means the very next reconciliation finishes the job.
    await wiki.importDump(dumpFor('B', BLOB_3D));

    expect(await metadataRepo.getMeta('embedding_dimension_mismatch')).toBeNull();
    expect((await getMarkerRow(db, 'f-A'))?.embedding_failure_kind).toBeNull();
  });
});

describe('reembed lock scope — a sweep tail still promotes under its own lock', () => {
  it('promotes at the end of runReembed even though the sweep lock is held', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async () => [1, 0, 0],
      },
    } as any);
    await wiki.setup();

    // f-A is permanently marked; f-A2 is embeddable, so the sweep reaches
    // `embedded > 0` and runs its tail reconciliation.
    await wiki.importDump({
      generatedAt: 1_700_000_000_000,
      entities: {
        A: {
          facts: [fact('f-A', 'A'), fact('f-A2', 'A')],
          tasks: [], events: [], edges: [], summary: '',
        },
      },
    } as any);

    const repo = (wiki as any).entryRepo;
    const metadataRepo = (wiki as any).metadataRepo;
    await repo.markEmbeddingFailure('f-A', 'float32_overflow', 1000);
    await metadataRepo.setMeta('embedding_dimension', '3', db);
    await metadataRepo.setMeta('embedding_dimension_mismatch', '3', db);

    const result = await wiki.runReembed('A');

    expect(result.embedded).toBeGreaterThan(0);
    expect(await metadataRepo.getMeta('embedding_dimension_mismatch')).toBeNull();
    expect((await getMarkerRow(db, 'f-A'))?.embedding_failure_kind).toBeNull();
  });
});
