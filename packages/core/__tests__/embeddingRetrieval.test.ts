import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions, MemoryDump } from '../src/types';

function makeDump(facts: Array<{ id: string; title: string; body: string }>): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      'user-1': {
        facts: facts.map((f, i) => ({
          id: f.id,
          entity_id: 'user-1',
          title: f.title,
          body: f.body,
          tags: [],
          confidence: 'certain' as const,
          source_type: 'user_stated' as const,
          source_hash: null,
          source_ref: null,
          created_at: (i + 1) * 1000,
          updated_at: (i + 1) * 1000,
          last_accessed_at: null,
          access_count: 0,
          deleted_at: null,
        })),
        tasks: [],
        events: [],
      },
    },
  };
}

function makeWiki(embedFn?: (text: string) => Promise<number[]>, onFallback?: (e: Error) => void) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    llmProvider: {
      generateText: async () => '{}',
      embed: embedFn,
    },
    onRetrievalFallback: onFallback,
  };
  return { wiki: new WikiMemory(db, options), db };
}

// Deterministic embed: maps keyword in text to a unit vector in 3D space.
function keywordEmbed(text: string): number[] {
  if (text.includes('apple')) return [1, 0, 0];
  if (text.includes('car')) return [0, 1, 0];
  return [0, 0, 1];
}

describe('read() — cosine similarity path', () => {
  it('ranks facts by cosine similarity to query embedding', async () => {
    const { wiki } = makeWiki(async (t) => keywordEmbed(t));
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-a', title: 'apple fruit', body: 'red and green' },
      { id: 'fact-b', title: 'car vehicle', body: 'fast engine' },
    ]));

    const result = await wiki.read('user-1', 'apple');
    expect(result.facts[0].id).toBe('fact-a');

    const result2 = await wiki.read('user-1', 'car');
    expect(result2.facts[0].id).toBe('fact-b');
  });

  it('fact with higher similarity ranks above newer fact', async () => {
    const { wiki } = makeWiki(async (t) => keywordEmbed(t));
    await wiki.setup();
    // fact-b has higher updated_at (2000 > 1000) but wrong topic for 'apple'
    await wiki.importDump(makeDump([
      { id: 'fact-a', title: 'apple fruit', body: 'healthy snack' },
      { id: 'fact-b', title: 'car vehicle', body: 'fast engine' },
    ]));

    const result = await wiki.read('user-1', 'apple');
    expect(result.facts[0].id).toBe('fact-a');
  });

  it('empty query returns most-recent facts regardless of embed', async () => {
    const { wiki } = makeWiki(async (t) => keywordEmbed(t));
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-old', title: 'apple fruit', body: 'body' },
      { id: 'fact-new', title: 'car vehicle', body: 'body' },
    ]));

    const result = await wiki.read('user-1', '');
    expect(result.facts[0].id).toBe('fact-new');
  });

  it('no embed provided + empty query returns recency order (no crash)', async () => {
    const { wiki } = makeWiki(undefined);
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-1', title: 'alpha', body: 'body' },
      { id: 'fact-2', title: 'beta', body: 'body' },
    ]));

    const result = await wiki.read('user-1', '');
    expect(result.facts).toHaveLength(2);
  });

  it('increments access_count for facts returned from non-empty query', async () => {
    const { wiki, db } = makeWiki(async (t) => keywordEmbed(t));
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-a', title: 'apple fruit', body: 'healthy' },
    ]));

    await wiki.read('user-1', 'apple');

    const row = await db.getFirstAsync<{ access_count: number }>(
      `SELECT access_count FROM llm_wiki_entries WHERE id = 'fact-a'`
    );
    expect(row?.access_count).toBe(1);
  });

  it('does NOT increment access_count for empty query', async () => {
    const { wiki, db } = makeWiki(async (t) => keywordEmbed(t));
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-a', title: 'apple fruit', body: 'healthy' },
    ]));

    await wiki.read('user-1', '');

    const row = await db.getFirstAsync<{ access_count: number }>(
      `SELECT access_count FROM llm_wiki_entries WHERE id = 'fact-a'`
    );
    expect(row?.access_count).toBe(0);
  });

  it('falls back to MiniSearch and calls onRetrievalFallback when query embedding dimension mismatches stored dimension', async () => {
    const fallbackErrors: Error[] = [];
    const { wiki: wiki3d, db } = makeWiki(async (t) => keywordEmbed(t));
    await wiki3d.setup();
    await wiki3d.importDump(makeDump([
      { id: 'fact-a', title: 'apple fruit', body: 'healthy' },
      { id: 'fact-b', title: 'car vehicle', body: 'fast' },
    ]));
    // Store embedding_dimension = 3 in meta
    await wiki3d.runReembed('user-1');

    // Create a second WikiMemory on the same DB with a 2D embed (simulates model switch)
    const wiki2d = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => '{}',
        embed: async (t: string) => t.includes('apple') ? [1, 0] : [0, 1],
      },
      onRetrievalFallback: (e) => fallbackErrors.push(e),
    });
    // setup() populates the MiniSearch index so the fallback has data
    await wiki2d.setup();

    const result = await wiki2d.read('user-1', 'apple');
    expect(fallbackErrors).toHaveLength(1);
    expect(fallbackErrors[0].message).toMatch(/dimension mismatch/i);
    // MiniSearch fallback should still return results
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts[0].id).toBe('fact-a');
  });

  it('facts without embeddings score 0 and appear after embedded facts', async () => {
    const { wiki, db } = makeWiki(async (t) => keywordEmbed(t));
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-a', title: 'apple fruit', body: 'healthy' },
    ]));
    // Insert a fact directly without embedding (simulates pre-migration row)
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['fact-nonembed', 'user-1', 'something else', 'no vector', '[]', 'certain', 'user_stated', 999, 999]
    );

    const result = await wiki.read('user-1', 'apple');
    expect(result.facts[0].id).toBe('fact-a');
  });
});

