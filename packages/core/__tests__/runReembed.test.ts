import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiBusyError } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { MAX_EMBED_ATTEMPTS } from '../src/services/MaintenanceService';
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
    expect(result).toEqual({ embedded: 0, skipped: 0, failed: 0, deferred: 0, permanentlyFailed: 0 });
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

    (wiki as any).jobManager.activeMaintenanceJobs.add('llm_wiki_:user-1:forget');

    const err = await wiki.runReembed('user-1').catch(e => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect(err.operation).toBe('forget');
    expect(err.entityId).toBe('user-1');
  });

  it('throws WikiBusyError(forget) on global runReembed() when forget is active', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFact(db, 'f1', 'user-1');

    (wiki as any).jobManager.activeMaintenanceJobs.add('llm_wiki_:user-1:forget');

    const err = await wiki.runReembed().catch(e => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect(err.operation).toBe('forget');
  });
});

describe('runReembed() retry orchestration', () => {
  const entityId = 'user-1';
  const factId = 'f1';

  async function makeWikiWithFailedFact(embedImpl?: (text: string) => Promise<number[]>) {
    const embedSpy = vi.fn(embedImpl ?? (async () => [1, 0, 0]));
    const { wiki, db } = makeWiki(embedSpy as unknown as (text: string) => Promise<number[]>);
    await wiki.setup();
    await insertFact(db, factId, entityId);
    const entryRepo = wiki.__testAccess.entryRepo;
    return { wiki, db, embedSpy, entryRepo };
  }

  it('does not re-attempt a fact inside its backoff window', async () => {
    const { wiki, entryRepo, embedSpy } = await makeWikiWithFailedFact();
    await entryRepo.markEmbeddingFailure(factId, 'provider_error', Date.now());
    const res = await wiki.runReembed(entityId);
    expect(embedSpy).not.toHaveBeenCalled();
    expect(res.deferred).toBe(1);
    expect(res.failed).toBe(0);   // D1: deferred is NOT failed
  });

  it('re-attempts a fact whose backoff has elapsed', async () => {
    const { wiki, entryRepo, embedSpy } = await makeWikiWithFailedFact();
    await entryRepo.markEmbeddingFailure(factId, 'provider_error', Date.now() - 10 * 60 * 1000);
    const res = await wiki.runReembed(entityId);
    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(res.embedded).toBe(1);
  });

  it('never re-attempts a float32_overflow fact', async () => {
    const { wiki, entryRepo, embedSpy } = await makeWikiWithFailedFact();
    await entryRepo.markEmbeddingFailure(factId, 'float32_overflow', 1);
    const res = await wiki.runReembed(entityId);
    expect(embedSpy).not.toHaveBeenCalled();
    expect(res.permanentlyFailed).toBe(1);
  });

  it('never re-attempts a fact at the attempt ceiling', async () => {
    const { wiki, entryRepo, embedSpy } = await makeWikiWithFailedFact();
    for (let i = 0; i < MAX_EMBED_ATTEMPTS; i++) {
      await entryRepo.markEmbeddingFailure(factId, 'provider_error', 1);
    }
    const res = await wiki.runReembed(entityId);
    expect(embedSpy).not.toHaveBeenCalled();
    expect(res.permanentlyFailed).toBe(1);
  });

  it('force:true overrides permanent exclusion', async () => {
    const { wiki, entryRepo, embedSpy } = await makeWikiWithFailedFact();
    await entryRepo.markEmbeddingFailure(factId, 'float32_overflow', 1);
    const res = await wiki.runReembed(entityId, { force: true });
    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(res.embedded).toBe(1);
  });

  it('a successful re-embed clears the marker so the next sweep skips it', async () => {
    const { wiki, db, entryRepo } = await makeWikiWithFailedFact();
    await entryRepo.markEmbeddingFailure(factId, 'provider_error', Date.now() - 10 * 60 * 1000);
    await wiki.runReembed(entityId);
    const row = await db.getFirstAsync<{ embedding_failed_at: number | null; embedding_attempts: number }>(
      `SELECT embedding_failed_at, embedding_attempts FROM llm_wiki_entries WHERE id = ?`, [factId]);
    expect(row?.embedding_failed_at).toBeNull();
    expect(row?.embedding_attempts).toBe(0);
  });

  it('a repeated failure converges: failed then deferred, never spinning', async () => {
    // embed always throws
    const { wiki } = await makeWikiWithFailedFact(async () => { throw new Error('provider down'); });
    const first = await wiki.runReembed(entityId);
    expect(first.failed).toBe(1);
    const second = await wiki.runReembed(entityId);
    expect(second.failed).toBe(0);
    expect(second.deferred).toBe(1);
  });
});
