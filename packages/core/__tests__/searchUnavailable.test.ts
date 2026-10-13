import { describe, it, expect, vi, afterEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiSearchUnavailableError, isWikiSearchUnavailableError } from '../src/index';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { MiniSearchIndexStrategy } from '../src/services/search/MiniSearchIndexStrategy';
import { UnavailableIndexStrategy } from '../src/services/search/UnavailableIndexStrategy';
import { EntryRepository } from '../src/repositories/EntryRepository';
import { openTestDatabase } from './helpers/sqliteAdapter';

const stub = { llmProvider: { generateText: async () => '{}' } } as const;
afterEach(() => vi.restoreAllMocks());

// `warm` pre-opens the store with a healthy FTS5 so the ledger exists (a never-initialised store has no ledger to assert on).
async function unavailableWiki(warm = false) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const db = openTestDatabase();
  if (warm) await new WikiMemory(db, stub).setup();
  const init = vi.spyOn(Fts5IndexStrategy.prototype, 'init').mockRejectedValue(new Error('locked'));
  const wiki = new WikiMemory(db, stub);
  await wiki.setup();
  return { db, wiki, init, svc: (wiki.__testAccess as any).searchService };
}

describe('WikiSearchUnavailableError', () => {
  it('stable name, cause chain, package export, Proxy-safe guard', () => {
    const cause = new Error('x');
    const e = new WikiSearchUnavailableError(undefined, cause);
    expect(e.name).toBe('WikiSearchUnavailableError');
    expect(e.cause).toBe(cause);
    expect(isWikiSearchUnavailableError(e)).toBe(true);
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } });
    expect(isWikiSearchUnavailableError(hostile)).toBe(false);
  });
});

describe('unavailable keyword search inside WikiMemory', () => {
  it('setup and every sync entry point stay off the full-read path while unavailable (B1 no-op drain)', async () => {
    const fullRead = vi.spyOn(EntryRepository.prototype, 'findMiniSearchRows');
    const { db, wiki, svc } = await unavailableWiki(true);
    expect(svc.isKeywordAvailable()).toBe(false);
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, created_at, updated_at) VALUES ('f1','e','apple','b',1,1)`);
    await wiki.syncSearchIndex('e');
    await svc.sync();
    expect(fullRead).not.toHaveBeenCalled();
    const pending = await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM llm_wiki_fts_pending`);
    expect(pending!.n).toBeGreaterThan(0);
  });

  it('UnavailableIndexStrategy has a present no-op drain; MiniSearch has none', () => {
    expect(typeof new UnavailableIndexStrategy(new Error('x')).drain).toBe('function');
    expect((new MiniSearchIndexStrategy() as unknown as { drain?: unknown }).drain).toBeUndefined();
  });

  it('no-arg syncSearchIndex() retries init and recovers', async () => {
    const { wiki, init, svc } = await unavailableWiki();
    init.mockRestore();
    await wiki.syncSearchIndex();
    expect(svc.isKeywordAvailable()).toBe(true);
  });

  it('a fresh WikiMemory on the same store recovers (next open recovers)', async () => {
    const { db, init } = await unavailableWiki();
    init.mockRestore();
    const again = new WikiMemory(db, stub);
    await again.setup();
    expect((again.__testAccess as any).searchService.isKeywordAvailable()).toBe(true);
  });
});
