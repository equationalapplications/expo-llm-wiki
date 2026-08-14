import { describe, it, expect, beforeEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import type { SQLiteAdapter } from '../src/types';

const VALID_HASH = 'a'.repeat(64);

describe('WikiMemory.upsertGraph — public API surface', () => {
  let db: SQLiteAdapter;
  let wiki: WikiMemory;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, 'llm_wiki_');
    wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await wiki.setup();
  });

  it('exists as a method on WikiMemory', () => {
    expect(typeof wiki.upsertGraph).toBe('function');
  });

  it('accepts (entityId, params, adapter) and returns the documented shape', async () => {
    const result = await db.withTransactionAsync(async (tx) =>
      wiki.upsertGraph(
        'entity-1',
        {
          sourceRef: 'src/foo.ts',
          sourceHash: VALID_HASH,
          nodes: [{ id: 'f1', type: '', title: 'sym1' }],
          edges: [],
        },
        tx,
      ),
    );
    expect(result).toEqual({ nodesWritten: 1, edgesWritten: 0, superseded: 0 });
  });
});
