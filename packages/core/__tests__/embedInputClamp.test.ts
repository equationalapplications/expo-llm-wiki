import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { DEFAULT_MAX_EMBED_CHARS, EMBED_CHARS_CEILING } from '../src/utils/embedDefaults';
import type { WikiOptions } from '../src/types';

/** Captures the exact string handed to embed() so length assertions are direct. */
function makeWiki(maxEmbedChars?: number) {
  const db = openTestDatabase();
  const seen: string[] = [];
  const options: WikiOptions = {
    config: maxEmbedChars === undefined ? {} : { maxEmbedChars },
    llmProvider: {
      generateText: async () => '{}',
      embed: async (text: string) => { seen.push(text); return [1, 0, 0]; },
    },
  };
  return { wiki: new WikiMemory(db, options), db, seen };
}

async function insertFact(db: ReturnType<typeof openTestDatabase>, id: string, bodyLength: number) {
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, 'e1', 't', 'x'.repeat(bodyLength), '[]', 'certain', 'user_stated', 1000, 1000],
  );
}

describe('embedFact input clamp', () => {
  it('defaults to 6000 characters', async () => {
    expect(DEFAULT_MAX_EMBED_CHARS).toBe(6000);
    const { wiki, db, seen } = makeWiki();
    await wiki.setup();
    await insertFact(db, 'f1', 20_000);
    await wiki.runReembed();
    const embedded = seen.filter(t => t.includes('x'));
    expect(embedded[0].length).toBe(DEFAULT_MAX_EMBED_CHARS);
  });

  it('passes shorter input through uncut', async () => {
    const { wiki, db, seen } = makeWiki();
    await wiki.setup();
    await insertFact(db, 'f1', 100);
    await wiki.runReembed();
    const embedded = seen.filter(t => t.includes('x'));
    expect(embedded[0].length).toBeLessThan(DEFAULT_MAX_EMBED_CHARS);
  });

  it('honors a configured maxEmbedChars', async () => {
    const { wiki, db, seen } = makeWiki(500);
    await wiki.setup();
    await insertFact(db, 'f1', 20_000);
    await wiki.runReembed();
    const embedded = seen.filter(t => t.includes('x'));
    expect(embedded[0].length).toBe(500);
  });

  it('clamps a configured value above the ceiling to the ceiling', async () => {
    expect(EMBED_CHARS_CEILING).toBe(16_000);
    const { wiki, db, seen } = makeWiki(99_999);
    await wiki.setup();
    await insertFact(db, 'f1', 40_000);
    await wiki.runReembed();
    const embedded = seen.filter(t => t.includes('x'));
    expect(embedded[0].length).toBe(EMBED_CHARS_CEILING);
  });
});
