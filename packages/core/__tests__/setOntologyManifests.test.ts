import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import type { OntologyManifest, SQLiteAdapter } from '../src/types';

const PREFIX = 'llm_wiki_';

const manifestA: OntologyManifest = {
  node_types: [{ type: 'person', description: 'An individual.' }],
  edge_types: [
    { type: 'knows', source_type: 'person', target_type: 'person', description: 'Acquaintance.' },
  ],
};

const manifestB: OntologyManifest = {
  node_types: [{ type: 'team', description: 'A team.' }],
  edge_types: [],
};

async function makeWiki(db: SQLiteAdapter): Promise<WikiMemory> {
  const wiki = new WikiMemory(db, {
    llmProvider: {
      generateText: async () => JSON.stringify({ facts: [] }),
      embed: async () => new Float32Array([0]),
    },
  });
  await wiki.setup();
  return wiki;
}

/** Count manifest rows without going through the engine. */
async function manifestCount(db: SQLiteAdapter): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${PREFIX}entity_manifests`,
  );
  return row?.n ?? 0;
}

/**
 * Wrap an adapter so the Nth write to `entity_manifests` throws, simulating a
 * failure partway through a batch.
 *
 * `withTransactionAsync` is overridden too, and deliberately: the base test
 * adapter passes ITSELF as the `tx` handle, so without this override the
 * callback would receive the unwrapped adapter and the injected failure would
 * never fire inside the transaction.
 */
function failOnNthManifestWrite(db: SQLiteAdapter, n: number): SQLiteAdapter {
  let writes = 0;
  const wrapped: SQLiteAdapter = {
    ...db,
    async runAsync(sql: string, args?: unknown[]) {
      if (sql.includes('entity_manifests')) {
        writes += 1;
        if (writes === n) throw new Error('injected mid-batch failure');
      }
      return db.runAsync(sql, args);
    },
    async withTransactionAsync<T>(fn: (tx: SQLiteAdapter) => Promise<T>): Promise<T> {
      return db.withTransactionAsync(() => fn(wrapped));
    },
  };
  return wrapped;
}

describe('WikiMemory.setOntologyManifests', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, PREFIX);
  });

  it('writes every entry and reports them as written', async () => {
    const wiki = await makeWiki(db);

    const result = await wiki.setOntologyManifests([
      { entityId: 'tier_fact', manifest: manifestA, mode: 'strict' },
      { entityId: 'tier_wisdom', manifest: manifestB, mode: 'strict' },
    ]);

    expect(result).toEqual({ written: ['tier_fact', 'tier_wisdom'], skipped: [] });
    expect(await wiki.getOntologyManifest('tier_fact')).toEqual({
      mode: 'strict',
      manifest: manifestA,
    });
    expect(await wiki.getOntologyManifest('tier_wisdom')).toEqual({
      mode: 'strict',
      manifest: manifestB,
    });
  });

  it('falls back to the resolved mode when an entry omits one', async () => {
    const wiki = await makeWiki(db);

    await wiki.setOntologyManifests([{ entityId: 'tier_fact', manifest: manifestA }]);

    const stored = await wiki.getOntologyManifest('tier_fact');
    // No ontologyConfig is supplied, so resolveMode() yields 'off'.
    expect(stored?.mode).toBe('off');
  });

  it('is atomic: a failure partway through leaves ZERO manifests', async () => {
    // Fail on the SECOND manifest write, so the first has already succeeded
    // inside the transaction. Without a single enclosing transaction this
    // leaves one row behind; with one, it leaves none.
    const failing = failOnNthManifestWrite(db, 2);
    const wiki = await makeWiki(failing);

    await expect(
      wiki.setOntologyManifests([
        { entityId: 'tier_fact', manifest: manifestA, mode: 'strict' },
        { entityId: 'tier_wisdom', manifest: manifestB, mode: 'strict' },
      ]),
    ).rejects.toThrow(/injected mid-batch failure/);

    expect(await manifestCount(db)).toBe(0);
  });

  it('invalidates the ontology cache for every entry after commit', async () => {
    // White-box on purpose. The cache has no public observer: the only public
    // reader, `getOntologyManifest`, queries the repository directly and never
    // consults `OntologyService`'s cache, so a black-box assertion here would
    // pass whether or not invalidation happened. The internal readers that DO
    // use the cache (ingest, prompt assembly) go through
    // `OntologyService.getEffectiveState`. `ontologyService` is `private` and
    // is not exposed on `WikiMemoryTestAccess`, so reach it by cast —
    // TypeScript `private` is compile-time only.
    const wiki = await makeWiki(db);
    const ontologyService = (wiki as unknown as {
      ontologyService: { invalidateCache: (entityId: string) => void };
    }).ontologyService;
    const spy = vi.spyOn(ontologyService, 'invalidateCache');

    await wiki.setOntologyManifests([
      { entityId: 'tier_fact', manifest: manifestA, mode: 'strict' },
      { entityId: 'tier_wisdom', manifest: manifestB, mode: 'strict' },
    ]);

    expect(spy).toHaveBeenCalledWith('tier_fact');
    expect(spy).toHaveBeenCalledWith('tier_wisdom');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  /** Wrap an adapter to count how many transactions were opened. */
  function countingTransactions(inner: SQLiteAdapter): {
    adapter: SQLiteAdapter;
    count: () => number;
  } {
    let opened = 0;
    const adapter: SQLiteAdapter = {
      ...inner,
      async withTransactionAsync<T>(fn: (tx: SQLiteAdapter) => Promise<T>): Promise<T> {
        opened += 1;
        return inner.withTransactionAsync(fn);
      },
    };
    return { adapter, count: () => opened };
  }

  it('returns empty lists for an empty batch without opening a transaction', async () => {
    const counting = countingTransactions(db);
    const wiki = await makeWiki(counting.adapter);
    const before = counting.count();

    const result = await wiki.setOntologyManifests([]);

    expect(result).toEqual({ written: [], skipped: [] });
    expect(counting.count()).toBe(before);
  });

  it('rejects a duplicate entityId before touching the database', async () => {
    const wiki = await makeWiki(db);

    await expect(
      wiki.setOntologyManifests([
        { entityId: 'tier_fact', manifest: manifestA, mode: 'strict' },
        { entityId: 'tier_fact', manifest: manifestB, mode: 'strict' },
      ]),
    ).rejects.toThrow(/duplicate entityid.*tier_fact/i);

    expect(await manifestCount(db)).toBe(0);
  });

  it('rejects an invalid manifest before opening a transaction', async () => {
    const counting = countingTransactions(db);
    const wiki = await makeWiki(counting.adapter);
    const before = counting.count();

    await expect(
      wiki.setOntologyManifests([
        { entityId: 'tier_fact', manifest: manifestA, mode: 'strict' },
        {
          entityId: 'tier_wisdom',
          // edge endpoint references a node type this manifest never declares
          manifest: {
            node_types: [],
            edge_types: [
              { type: 'x', source_type: 'ghost', target_type: 'ghost', description: '' },
            ],
          },
          mode: 'strict',
        },
      ]),
    ).rejects.toThrow(/unknown node type/i);

    expect(counting.count()).toBe(before);
    expect(await manifestCount(db)).toBe(0);
  });
});
