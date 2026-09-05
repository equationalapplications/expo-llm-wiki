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

  it('a permanently-failed row does not block dimension promotion, and is revived by it', async () => {
    // Provider returns 3-d vectors; a stored dimension of 4 forces a mismatch.
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await insertFact(db, 'f-ok', 'user-1');
    await insertFact(db, 'f-dead', 'user-1');
    await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '4')`);
    // f-dead is terminally marked: float32_overflow is permanent by classification.
    await db.runAsync(
      `UPDATE llm_wiki_entries
          SET embedding_failed_at = 1, embedding_failure_kind = 'float32_overflow', embedding_attempts = 1
        WHERE id = 'f-dead'`,
    );

    // Sweep 1: f-ok embeds (setting the mismatch key), f-dead is classified permanent.
    const first = await wiki.runReembed();
    expect(first.permanentlyFailed).toBe(1);
    expect(first.embedded).toBe(1);

    // Promotion happened despite the marked row, and cleared its marker.
    const markerRow = await db.getFirstAsync<{ embedding_failed_at: number | null }>(
      `SELECT embedding_failed_at FROM llm_wiki_entries WHERE id = 'f-dead'`,
    );
    expect(markerRow?.embedding_failed_at).toBeNull();

    // Sweep 2: the revived row is attempted and embeds.
    const second = await wiki.runReembed();
    expect(second.permanentlyFailed).toBe(0);
    const blobRow = await db.getFirstAsync<{ embedding_blob: Uint8Array | null }>(
      `SELECT embedding_blob FROM llm_wiki_entries WHERE id = 'f-dead'`,
    );
    expect(blobRow?.embedding_blob).not.toBeNull();
  });

  it('a non-callable embed short-circuits the sweep without marking anything', async () => {
    const { wiki, db } = makeWiki(undefined);
    (wiki as any).options.llmProvider.embed = {} as any;
    await wiki.setup();
    await insertFact(db, 'f1', 'user-1');

    const result = await wiki.runReembed();

    expect(result).toEqual({ embedded: 0, skipped: 0, failed: 0, deferred: 0, permanentlyFailed: 0 });
    const row = await db.getFirstAsync<{ embedding_failed_at: number | null; embedding_attempts: number }>(
      `SELECT embedding_failed_at, embedding_attempts FROM llm_wiki_entries WHERE id = 'f1'`,
    );
    expect(row?.embedding_failed_at).toBeNull();
    expect(row?.embedding_attempts).toBe(0);
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

  it('decides backoff eligibility against sweep-start time, not per-row time', async () => {
    // Pins the sweep-wide clock snapshot in runReembed: eligibility is decided
    // against the sweep-start Date.now(), so a backoff window that elapses
    // mid-sweep does NOT become eligible until the next sweep. Under a
    // regression to per-row Date.now() inside the loop, the marked fact below
    // would be re-attempted in the first sweep and this test fails.
    //
    // findAllForReembed has no ORDER BY; a SQLite full scan returns rowid
    // (insertion) order, so f-first is swept before f-marked — the clock
    // advance in its embed is what makes the two semantics differ.
    const t0 = 1_700_000_000_000;
    let advanced = false;
    const embed = vi.fn(async () => {
      // Advance the fake clock past f-marked's 60s base window mid-sweep,
      // on the first embed call only.
      if (!advanced) { advanced = true; vi.advanceTimersByTime(60_000); }
      return [1, 0, 0];
    });
    const { wiki, db } = makeWiki(embed as unknown as (text: string) => Promise<number[]>);
    await wiki.setup();
    await insertFact(db, 'f-first', entityId);
    await insertFact(db, 'f-marked', entityId);
    const entryRepo = wiki.__testAccess.entryRepo;
    // Marked 30s before the sweep: inside the 60s window at sweep start.
    await entryRepo.markEmbeddingFailure('f-marked', 'provider_error', t0 - 30_000);

    try {
      vi.useFakeTimers();
      vi.setSystemTime(t0);

      const res = await wiki.runReembed(entityId);
      expect(embed).toHaveBeenCalledTimes(1);   // only f-first
      expect(res.embedded).toBe(1);
      expect(res.deferred).toBe(1);             // snapshot: still deferred
      expect(res.failed).toBe(0);

      // The deferral is snapshot-based, not permanent: an immediate second
      // sweep — clock unchanged since the first — now sees the elapsed window
      // and retries the marked fact. skipExisting so f-first is skipped.
      const res2 = await wiki.runReembed(entityId, { skipExisting: true });
      expect(embed).toHaveBeenCalledTimes(2);
      expect(res2.embedded).toBe(1);
      expect(res2.deferred).toBe(0);
      expect(res2.skipped).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
