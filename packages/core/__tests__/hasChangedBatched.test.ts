import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import type { SQLiteAdapter } from '../src/types';

const VALID_HASH_A = 'a'.repeat(64);
const VALID_HASH_B = 'b'.repeat(64);

async function makeWiki(): Promise<{ wiki: WikiMemory; db: SQLiteAdapter }> {
  const db = openTestDatabase();
  await setupDatabase(db, 'llm_wiki_');
  const wiki = new WikiMemory(db, {
    llmProvider: {
      generateText: async () => '{}',
      embed: async () => new Float32Array([0]),
    },
  });
  await wiki.setup();
  return { wiki, db };
}

describe('EntryRepository.findLatestSourceHashes — empty input edge case', () => {
  it('returns an empty Map and makes zero SQL calls when sourceRefs is []', async () => {
    const { wiki } = await makeWiki();
    const map = await wiki.__testAccess.entryRepo.findLatestSourceHashes('entity-1', []);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });
});
