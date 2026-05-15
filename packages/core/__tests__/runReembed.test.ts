import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiBusyError } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions } from '../src/types';

function makeWiki(embedFn?: (text: string) => Promise<number[]>) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    llmProvider: {
      generateText: async () => '{}',
      embed: embedFn,
    },
  };
  return { wiki: new WikiMemory(db, options), db };
}

async function insertFact(db: ReturnType<typeof openTestDatabase>, id: string, entityId: string, deleted = false) {
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at${deleted ? ', deleted_at' : ''}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${deleted ? ', ?' : ''})`,
    [id, entityId, `title-${id}`, 'body', '[]', 'certain', 'user_stated', 1000, 1000, ...(deleted ? [1001] : [])]
  );
}

describe('runReembed()', () => {
  it('returns { embedded: 0, skipped: 0 } when embed absent', async () => {
    const { wiki, db } = makeWiki(undefined);
    await wiki.setup();
    await insertFact(db, 'f1', 'user-1');

    const result = await wiki.runReembed();
    expect(result).toEqual({ embedded: 0, skipped: 0, failed: 0 });
  });

  it('backfills embeddings for all non-deleted facts', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFact(db, 'f1', 'user-1');
    await insertFact(db, 'f2', 'user-2');

    const result = await wiki.runReembed();
    expect(result.embedded).toBe(2);
    expect(result.skipped).toBe(0);

    const row = await db.getFirstAsync<{ embedding_blob: Uint8Array | null }>(
      `SELECT embedding_blob FROM llm_wiki_entries WHERE id = 'f1'`
    );
    expect(row?.embedding_blob).not.toBeNull();
  });

  it('scopes to entityId when provided', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFact(db, 'f-user1', 'user-1');
    await insertFact(db, 'f-user2', 'user-2');

    const result = await wiki.runReembed('user-1');
    expect(result.embedded).toBe(1);

    const row2 = await db.getFirstAsync<{ embedding: string | null }>(
      `SELECT embedding FROM llm_wiki_entries WHERE id = 'f-user2'`
    );
    expect(row2?.embedding).toBeNull();
  });

  it('skips soft-deleted facts', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFact(db, 'f-deleted', 'user-1', true);

    const result = await wiki.runReembed();
    expect(result.embedded).toBe(0);
  });

  it('updates embedding_dimension and clears mismatch flag after successful re-embed', async () => {
    // Seed a DB that already has embedding_dimension = 3 and a mismatch key for dim 2
    const { wiki, db } = makeWiki(async () => [1, 0]);   // 2D embed
    await wiki.setup();
    await insertFact(db, 'f1', 'user-1');
    // Simulate a previous 3D dimension stored in meta
    await db.runAsync(
      `INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`
    );
    // Simulate the mismatch flag being set (as storeEmbeddingDimension would have done)
    await db.runAsync(
      `INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension_mismatch', '2')`
    );

    await wiki.runReembed();

    const dim = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM llm_wiki_meta WHERE key = 'embedding_dimension'`
    );
    expect(dim?.value).toBe('2');

    const mismatch = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM llm_wiki_meta WHERE key = 'embedding_dimension_mismatch'`
    );
    expect(mismatch).toBeNull();
  });

  it('throws WikiBusyError on concurrent runReembed()', async () => {
    let resolveEmbed!: () => void;
    const embedPromise = new Promise<void>(r => { resolveEmbed = r; });
    const { wiki, db } = makeWiki(async () => { await embedPromise; return [1, 0, 0]; });
    await wiki.setup();
    await insertFact(db, 'f1', 'user-1');

    const first = wiki.runReembed();
    // Give first call time to acquire lock and reach the embed await
    await new Promise(r => setTimeout(r, 0));
    await expect(wiki.runReembed()).rejects.toThrow(WikiBusyError);
    resolveEmbed();
    await first;
  });

  it('throws WikiBusyError(forget) when forget is active for entity', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFact(db, 'f1', 'user-1');

    (wiki as any).activeMaintenanceJobs.add('llm_wiki_:user-1:forget');

    const err = await wiki.runReembed('user-1').catch(e => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect(err.operation).toBe('forget');
    expect(err.entityId).toBe('user-1');
  });

  it('throws WikiBusyError(forget) on global runReembed() when forget is active', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFact(db, 'f1', 'user-1');

    (wiki as any).activeMaintenanceJobs.add('llm_wiki_:user-1:forget');

    const err = await wiki.runReembed().catch(e => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect(err.operation).toBe('forget');
  });
});
