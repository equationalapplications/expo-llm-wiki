import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;
const PREFIX = 'llm_wiki_';

async function makeWikiWithFact(factId: string): Promise<{ wiki: WikiMemory; db: SQLiteAdapter; repo: any }> {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, stubOptions);
  await wiki.setup();
  await wiki.importDump({
    generatedAt: 1_700_000_000_000,
    entities: {
      e1: {
        facts: [{
          id: factId,
          entity_id: 'e1',
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
        }],
        tasks: [],
        events: [],
        edges: [],
        summary: '',
      },
    },
  });
  return { wiki, db, repo: (wiki as any).entryRepo };
}

async function getMarkerRow(db: SQLiteAdapter, factId: string) {
  return db.getFirstAsync<{
    embedding_failed_at: number | null;
    embedding_failure_kind: string | null;
    embedding_attempts: number;
    updated_at: number;
  }>(
    `SELECT embedding_failed_at, embedding_failure_kind, embedding_attempts, updated_at FROM ${PREFIX}entries WHERE id = ?`,
    [factId],
  );
}

describe('EntryRepository embedding failure markers', () => {
  it('markEmbeddingFailure records kind, timestamp, and increments attempts', async () => {
    const { repo, db } = await makeWikiWithFact('f1');
    await repo.markEmbeddingFailure('f1', 'provider_error', 1000);
    let row = await getMarkerRow(db, 'f1');
    expect(row?.embedding_failure_kind).toBe('provider_error');
    expect(row?.embedding_failed_at).toBe(1000);
    expect(row?.embedding_attempts).toBe(1);

    await repo.markEmbeddingFailure('f1', 'provider_error', 2000);
    row = await getMarkerRow(db, 'f1');
    expect(row?.embedding_failed_at).toBe(2000);
    expect(row?.embedding_attempts).toBe(2);
  });

  it('updateEmbeddingBlob clears any outstanding failure marker', async () => {
    const { repo, db } = await makeWikiWithFact('f3');
    await repo.markEmbeddingFailure('f3', 'provider_error', 1000);
    await repo.updateEmbeddingBlob('f3', new Uint8Array([1, 2, 3, 4]));
    const row = await getMarkerRow(db, 'f3');
    expect(row?.embedding_failed_at).toBeNull();
    expect(row?.embedding_failure_kind).toBeNull();
    expect(row?.embedding_attempts).toBe(0);
  });

  it('markEmbeddingFailure does not touch updated_at', async () => {
    const { repo, db } = await makeWikiWithFact('f4');
    const before = await getMarkerRow(db, 'f4');
    await repo.markEmbeddingFailure('f4', 'invalid_vector', 5000);
    const after = await getMarkerRow(db, 'f4');
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it('updateEmbeddingBlob does not touch updated_at either (DAO discipline)', async () => {
    const { repo, db } = await makeWikiWithFact('f5');
    await repo.markEmbeddingFailure('f5', 'provider_error', 1000);
    const before = await getMarkerRow(db, 'f5');
    await repo.updateEmbeddingBlob('f5', new Uint8Array([9, 8, 7, 6]));
    const after = await getMarkerRow(db, 'f5');
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it('clearEmbeddingFailureMarkers resets all three columns on marked rows', async () => {
    const { repo, db } = await makeWikiWithFact('f1');
    await repo.markEmbeddingFailure('f1', 'float32_overflow', 1000);

    const changed = await repo.clearEmbeddingFailureMarkers();

    expect(changed).toBe(1);
    const row = await getMarkerRow(db, 'f1');
    expect(row?.embedding_failed_at).toBeNull();
    expect(row?.embedding_failure_kind).toBeNull();
    expect(row?.embedding_attempts).toBe(0);
  });

  it('clearEmbeddingFailureMarkers leaves unmarked rows untouched and reports 0', async () => {
    const { repo, db } = await makeWikiWithFact('f1');
    const before = await getMarkerRow(db, 'f1');

    const changed = await repo.clearEmbeddingFailureMarkers();

    expect(changed).toBe(0);
    const after = await getMarkerRow(db, 'f1');
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it('clearEmbeddingFailureMarkers does not touch updated_at on a marked row', async () => {
    const { repo, db } = await makeWikiWithFact('f1');
    const before = await getMarkerRow(db, 'f1');
    await repo.markEmbeddingFailure('f1', 'provider_error', 1000);

    await repo.clearEmbeddingFailureMarkers();

    const after = await getMarkerRow(db, 'f1');
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it('upsert with a valid blob clears stale markers', async () => {
    const { repo, db } = await makeWikiWithFact('f1');
    await repo.markEmbeddingFailure('f1', 'provider_error', 1000);

    const fact = {
      id: 'f1', entity_id: 'e1', title: 'T2', body: 'B2', tags: [],
      confidence: 'certain', source_type: 'user_stated',
      source_hash: null, source_ref: null,
      created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
      last_accessed_at: null, access_count: 0, deleted_at: null, okf_type: 'fact',
      embedding_blob: new Uint8Array(new Float32Array([1, 0, 0]).buffer),
    } as any;
    await db.withTransactionAsync(async (tx) => { await repo.upsert(fact, tx); });

    const row = await getMarkerRow(db, 'f1');
    expect(row?.embedding_failed_at).toBeNull();
    expect(row?.embedding_failure_kind).toBeNull();
    expect(row?.embedding_attempts).toBe(0);
  });

  it('upsert WITHOUT a blob leaves existing markers intact', async () => {
    const { repo, db } = await makeWikiWithFact('f1');
    await repo.markEmbeddingFailure('f1', 'provider_error', 1000);

    const fact = {
      id: 'f1', entity_id: 'e1', title: 'T3', body: 'B3', tags: [],
      confidence: 'certain', source_type: 'user_stated',
      source_hash: null, source_ref: null,
      created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
      last_accessed_at: null, access_count: 0, deleted_at: null, okf_type: 'fact',
      embedding_blob: null,
    } as any;
    await db.withTransactionAsync(async (tx) => { await repo.upsert(fact, tx); });

    const row = await getMarkerRow(db, 'f1');
    expect(row?.embedding_failed_at).toBe(1000);
    expect(row?.embedding_failure_kind).toBe('provider_error');
    expect(row?.embedding_attempts).toBe(1);
  });

  it('importDump carrying a valid blob clears a stale marker (upsertForImport)', async () => {
    const { wiki, repo, db } = await makeWikiWithFact('f1');
    await repo.markEmbeddingFailure('f1', 'float32_overflow', 1000);

    await wiki.importDump({
      generatedAt: 1_700_000_001_000,
      entities: {
        e1: {
          facts: [{
            id: 'f1', entity_id: 'e1', title: 'T', body: 'B', tags: [],
            confidence: 'certain', source_type: 'user_stated',
            source_hash: null, source_ref: null,
            created_at: 1_700_000_000_000, updated_at: 1_700_000_001_000,
            last_accessed_at: null, access_count: 0, deleted_at: null, okf_type: 'fact',
            embedding_blob: new Uint8Array(new Float32Array([1, 0, 0]).buffer),
          }],
          tasks: [], events: [], edges: [], summary: '',
        },
      },
    } as any);

    const row = await getMarkerRow(db, 'f1');
    expect(row?.embedding_failed_at).toBeNull();
    expect(row?.embedding_attempts).toBe(0);
  });
});
