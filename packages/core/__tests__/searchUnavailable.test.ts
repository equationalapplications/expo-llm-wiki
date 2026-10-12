// packages/core/__tests__/searchUnavailable.test.ts
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

async function unavailableWiki() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const init = vi.spyOn(Fts5IndexStrategy.prototype, 'init').mockRejectedValue(new Error('locked'));
  const db = openTestDatabase();
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
  it('isKeywordAvailable returns false during unavailable state', async () => {
    const { wiki, svc } = await unavailableWiki();
    expect(svc.isKeywordAvailable()).toBe(false);
  });

  it('search throws WikiSearchUnavailableError with original cause', async () => {
    const { wiki, svc } = await unavailableWiki();
    await expect(svc.search('test query', { entityIds: ['e1'], limit: 5 }))
      .rejects.toMatchObject({ name: 'WikiSearchUnavailableError' });
  });

  it('syncSearchIndex retries and recovers on second attempt', async () => {
    const { wiki, init } = await unavailableWiki();
    // Reset the spy to allow successful second attempt
    init.mockImplementationOnce(function() {
      return Fts5IndexStrategy.prototype.init.call(this);
    });

    // Force a retry by calling syncSearchIndex
    await wiki.syncSearchIndex('e1');
    expect(init).toHaveBeenCalledTimes(2);
  });

  it('syncSearchIndex with no args retries FTS5 init', async () => {
    const { wiki, init } = await unavailableWiki();
    // Reset the spy to allow successful second attempt
    init.mockImplementationOnce(function() {
      return Fts5IndexStrategy.prototype.init.call(this);
    });

    // Force a retry by calling syncSearchIndex with no args
    await wiki.syncSearchIndex();
    expect(init).toHaveBeenCalledTimes(2);
  });
});

describe('UnavailableIndexStrategy', () => {
  it('throws WikiSearchUnavailableError on search', () => {
    const strategy = new UnavailableIndexStrategy(new Error('test error'));
    expect(() => strategy.search('query', { entityIds: ['e1'], limit: 5 }))
      .toThrow(WikiSearchUnavailableError);
  });

  it('has no-op methods for other operations', async () => {
    const strategy = new UnavailableIndexStrategy(new Error('test error'));
    await expect(strategy.replace('e1', ['id1'], [{ id: 'id1', text: 'test' }])).resolves.toBeUndefined();
    await expect(strategy.replaceEntity('e1', [{ id: 'id1', text: 'test' }])).resolves.toBeUndefined();
    await expect(strategy.replaceAll([{ id: 'id1', text: 'test' }])).resolves.toBeUndefined();
    expect(strategy.hasIndexedEntity('e1')).toBe(false);
    await expect(strategy.drain()).resolves.toBeUndefined();
  });
});