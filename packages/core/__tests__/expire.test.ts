// packages/core/__tests__/expire.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiSupersedeError } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

let db: SQLiteAdapter;
let wiki: WikiMemory;

async function insert(id: string, entity = 'e1', source_type = 'user_stated', created_at = 100) {
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
     VALUES (?, ?, ?, 'body', ?, 'certain', ?, ?)`,
    [id, entity, `title ${id}`, source_type, created_at, created_at],
  );
}
const temporal = (id: string) =>
  db.getFirstAsync<any>(`SELECT valid_from, valid_to, superseded_by, superseded_at FROM llm_wiki_entries WHERE id = ?`, [id]);

beforeEach(async () => {
  db = openTestDatabase();
  wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
  await wiki.setup();
});

describe('expire()', () => {
  it('WikiSupersedeError carries the verb in its message (default unchanged)', () => {
    expect(new WikiSupersedeError('invalid_interval').message).toBe('supersede() rejected: invalid_interval');
    expect(new WikiSupersedeError('already_expired', 'expire()').message).toBe('expire() rejected: already_expired');
  });
});
