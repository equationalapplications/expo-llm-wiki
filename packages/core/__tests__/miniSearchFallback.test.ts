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

function makeWikiNoEmbed(onFallback?: (e: Error) => void) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    llmProvider: { generateText: async () => '{}' },
    onRetrievalFallback: onFallback,
  };
  return { wiki: new WikiMemory(db, options), db };
}

function makeWikiThrowingEmbed(onFallback?: (e: Error) => void) {
  const embedError = new Error('network error');
  const db = openTestDatabase();
  const options: WikiOptions = {
    llmProvider: {
      generateText: async () => '{}',
      embed: async () => { throw embedError; },
    },
    onRetrievalFallback: onFallback,
  };
  return { wiki: new WikiMemory(db, options), db, embedError };
}

describe('read() — MiniSearch fallback (no embed)', () => {
  it('returns relevant facts via MiniSearch when embed absent', async () => {
    const { wiki } = makeWikiNoEmbed();
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-banana', title: 'banana fruit', body: 'yellow tropical' },
      { id: 'fact-car', title: 'car vehicle', body: 'fast engine wheels' },
    ]));

    const result = await wiki.read('user-1', 'banana');
    const ids = result.facts.map(f => f.id);
    expect(ids).toContain('fact-banana');
  });

  it('does NOT call onRetrievalFallback when embed is simply absent', async () => {
    const errors: Error[] = [];
    const { wiki } = makeWikiNoEmbed((e) => errors.push(e));
    await wiki.setup();
    await wiki.importDump(makeDump([{ id: 'f1', title: 'something', body: 'body' }]));

    await wiki.read('user-1', 'something');
    expect(errors).toHaveLength(0);
  });
});

describe('read() — MiniSearch fallback (embed throws)', () => {
  it('calls onRetrievalFallback with the error when embed throws', async () => {
    const errors: Error[] = [];
    const { wiki, embedError } = makeWikiThrowingEmbed((e) => errors.push(e));
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-banana', title: 'banana fruit', body: 'yellow tropical' },
    ]));

    await wiki.read('user-1', 'banana');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(embedError);
  });

  it('still returns results from MiniSearch when embed throws', async () => {
    const { wiki } = makeWikiThrowingEmbed();
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'fact-banana', title: 'banana fruit', body: 'yellow tropical' },
    ]));

    // Should not throw — returns MiniSearch results
    const result = await wiki.read('user-1', 'banana');
    expect(Array.isArray(result.facts)).toBe(true);
  });
});

describe('MiniSearch index sync', () => {
  it('after forget(), forgotten fact absent from MiniSearch results', async () => {
    const { wiki } = makeWikiNoEmbed();
    await wiki.setup();
    await wiki.importDump(makeDump([
      { id: 'f-keep', title: 'apple fruit', body: 'healthy' },
      { id: 'f-forget', title: 'banana tropical', body: 'yellow' },
    ]));

    await wiki.forget('user-1', { entryId: 'f-forget' });

    const result = await wiki.read('user-1', 'banana');
    expect(result.facts.map(f => f.id)).not.toContain('f-forget');
  });
});
