import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiInvalidReadOptions } from '../src/types';
import type { WikiOptions } from '../src/types';

function makeWiki(embedFn?: (text: string) => Promise<number[]>) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    config: { maxResults: 5 },
    llmProvider: { generateText: async () => '{}', embed: embedFn },
  };
  return { wiki: new WikiMemory(db, options), db };
}

async function insertFact(
  db: ReturnType<typeof openTestDatabase>,
  id: string,
  entityId: string,
  updatedAt: number,
  vector: number[],
) {
  const blob = new Uint8Array(new Float32Array(vector).buffer);
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding_blob)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entityId, `title-${id}`, `body-${id} shared`, '[]', 'certain', 'user_stated', updatedAt, updatedAt, blob],
  );
}

/**
 * `big` gets vectors closely aligned to the query, `small` gets weaker ones, so
 * without a floor the top-K is entirely `big` — the starvation the feature fixes.
 */
async function seedStarvedCorpus(wiki: WikiMemory, db: ReturnType<typeof openTestDatabase>) {
  await db.runAsync(`INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', '3')`);
  for (let i = 0; i < 8; i++) await insertFact(db, `big${i}`, 'big', 2000 + i, [1, 0, 0]);
  for (let i = 0; i < 4; i++) await insertFact(db, `small${i}`, 'small', 1000 + i, [0.2, 0.9, 0]);
  // These rows bypass the write API, so the MiniSearch index built during setup()
  // does not know about them. The keyword-fallback path searches that index, not
  // SQLite, and would return nothing without an explicit rebuild.
  await wiki.__testAccess.searchService.sync();
}

describe('tierFloors in read()', () => {
  it('starves the smaller entity without a floor (baseline)', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await seedStarvedCorpus(wiki, db);

    const result = await wiki.read(['big', 'small'], 'shared', { maxResults: 5 });
    expect(result.facts.filter(f => f.entity_id === 'small')).toHaveLength(0);
  });

  it('honors a floor on the ranker path', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await seedStarvedCorpus(wiki, db);

    const result = await wiki.read(['big', 'small'], 'shared', {
      maxResults: 5,
      tierFloors: { small: 2 },
    });
    expect(result.facts).toHaveLength(5);
    expect(result.facts.filter(f => f.entity_id === 'small')).toHaveLength(2);
  });

  it('honors a floor on the keyword-fallback path when embed throws', async () => {
    const { wiki, db } = makeWiki(async () => { throw new Error('embed unavailable'); });
    await wiki.setup();
    await seedStarvedCorpus(wiki, db);

    const result = await wiki.read(['big', 'small'], 'shared', {
      maxResults: 5,
      tierFloors: { small: 2 },
    });
    expect(result.facts.filter(f => f.entity_id === 'small').length).toBeGreaterThanOrEqual(2);
  });

  it('exposes sanitized floors in metadata', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await seedStarvedCorpus(wiki, db);

    const result = await wiki.read(['big', 'small'], 'shared', {
      maxResults: 5,
      tierFloors: { small: 2 },
    });
    expect(result.metadata?.tierFloors).toEqual({ small: 2 });
  });

  it('ignores floors on the empty-query recency path', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await seedStarvedCorpus(wiki, db);

    const result = await wiki.read(['big', 'small'], '', { maxResults: 5, tierFloors: { small: 2 } });
    expect(result.facts).toHaveLength(5);
    // Pure recency: `big` rows have the newest updated_at, so they take every slot.
    expect(result.facts.filter(f => f.entity_id === 'small')).toHaveLength(0);
  });

  it('ignores floors for a single-string entityId', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await seedStarvedCorpus(wiki, db);

    const result = await wiki.read('big', 'shared', { maxResults: 5, tierFloors: { small: 2 } });
    expect(result.facts.every(f => f.entity_id === 'big')).toBe(true);
  });

  it('throws when floors exceed maxResults', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await seedStarvedCorpus(wiki, db);

    await expect(
      wiki.read(['big', 'small'], 'shared', { maxResults: 3, tierFloors: { big: 2, small: 2 } }),
    ).rejects.toThrow(WikiInvalidReadOptions);
  });

  it('throws on a floor keyed to an unrequested entity', async () => {
    const { wiki, db } = makeWiki(async () => [1, 0, 0]);
    await wiki.setup();
    await seedStarvedCorpus(wiki, db);

    await expect(
      wiki.read(['big', 'small'], 'shared', { maxResults: 5, tierFloors: { typo: 1 } }),
    ).rejects.toThrow(WikiInvalidReadOptions);
  });
});
