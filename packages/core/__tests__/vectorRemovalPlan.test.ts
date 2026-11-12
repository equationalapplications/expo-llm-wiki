import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/WikiMemory';
import { VectorRemovalRepository } from '../src/repositories/VectorRemovalRepository';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';

describe('VectorRemovalRepository id-scoped query plans', () => {
  it('uses the fact_id unique index, not the pending partial index', async () => {
    const raw = openTestDatabase();
    await new WikiMemory(raw, { llmProvider: { generateText: async () => '{}' } } as any).setup();
    const seen: Array<{ sql: string; args: any[] }> = [];
    const spy: SQLiteAdapter = {
      ...raw,
      getAllAsync: (sql: string, args?: any) => { seen.push({ sql, args: args ?? [] }); return (raw as any).getAllAsync(sql, args); },
      getFirstAsync: (sql: string, args?: any) => { seen.push({ sql, args: args ?? [] }); return (raw as any).getFirstAsync(sql, args); },
    } as any;
    const repo = new VectorRemovalRepository(spy, P);
    const ids = ['a', 'b', 'c'];
    await repo.readPage({ entityId: 'e1', ids }, { maxSeq: 10, attempts: -1, seq: 0 }, 100, spy);
    await repo.pendingCountForIds('e1', ids);
    expect(seen.length).toBe(2);
    for (const q of seen) {
      const plan = await (raw as any).getAllAsync(`EXPLAIN QUERY PLAN ${q.sql}`, q.args);
      const text = plan.map((r: any) => r.detail).join('\n');
      expect(text).toMatch(/sqlite_autoindex_llm_wiki_vector_removals/);
      expect(text).not.toMatch(/vector_removals_pending/);
    }
  });
});
