// packages/core/__tests__/fts5QuantumBudget.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { FTS5_REBUILD_WM_KEY, FTS5_RETIRED_TABLES_KEY, FTS5_STATE_KEY } from '../src/services/search/fts5Sql';
import { monotonicNow } from '../src/utils/monotonicNow';
import type { SQLiteAdapter } from '../src/types';

// A controllable clock: tests that step it restore the real one afterwards.
vi.mock('../src/utils/monotonicNow', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/utils/monotonicNow')>();
  return { ...m, monotonicNow: vi.fn(m.monotonicNow) };
});

const P = 'llm_wiki_';
let db: SQLiteAdapter;
let meta: MetadataRepository;
const real = vi.mocked(monotonicNow).getMockImplementation()!;
beforeEach(async () => { db = openTestDatabase(); await setupDatabase(db, P); meta = new MetadataRepository(db, P); });
afterEach(() => { vi.mocked(monotonicNow).mockImplementation(real); vi.restoreAllMocks(); });

async function bulk(n: number, entity: string): Promise<void> {
  await db.withTransactionAsync(async (tx) => {
    for (let i = 0; i < n; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, 'b', '[]', 1, 1)`,
        [`${entity}_${i}`, entity, `cedar ${i}`]);
    }
  });
}
const wm = async () => JSON.parse((await meta.getMeta(FTS5_REBUILD_WM_KEY))!) as { rowid: number; id: string | null };

describe('full quantum budget split (#284 review)', () => {
  it('a ledger backlog larger than the budget cannot starve the rebuild windows', async () => {
    await bulk(1200, 'e1');
    const s = new Fts5IndexStrategy(db, P, meta, 1000);
    await s.init(); // pre-FTS store: rebuilding, snapshot 1200
    await bulk(6000, 'e2'); // 12 ledger chunks
    // Every clock read is 100 ms after the last: the whole budget would fit 9 ledger chunks.
    let t = 0;
    vi.mocked(monotonicNow).mockImplementation(() => (t += 100));
    await s.drain();
    expect((await wm()).rowid).toBeGreaterThan(0);
    expect((await db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${P}fts_pending`))!.n).toBeGreaterThan(0);
  });
});

describe('reclamation after a rebuild restart (#284 review)', () => {
  it('a quantum that restarts the rebuild still reclaims retired tables', async () => {
    await bulk(1200, 'e1');
    const s = new Fts5IndexStrategy(db, P, meta);
    await s.init({ entriesExisted: false });
    await s.drain();
    // A tokenizer mismatch: the reset retires the table and re-arms.
    await db.execAsync(`DROP TABLE ${P}entries_fts;
      CREATE VIRTUAL TABLE ${P}entries_fts USING fts5(id UNINDEXED, entity_id UNINDEXED, title, body, tags, tokenize = 'unicode61');
      INSERT INTO ${P}entries_fts (rowid, id, entity_id, title, body, tags) SELECT rowid, id, entity_id, title, body, '' FROM ${P}entries;`);
    await new Fts5IndexStrategy(db, P, meta).init();
    expect(await meta.getMeta(FTS5_STATE_KEY)).toBe('rebuilding');
    await meta.setMeta(FTS5_REBUILD_WM_KEY, JSON.stringify({ rowid: 3, id: 'renumbered' }), db); // an external change under the watermark
    const run = vi.spyOn(db, 'runAsync');
    await s.drain();
    expect((await wm()).rowid).toBe(0); // restarted
    expect(run.mock.calls.some((c) => String(c[0]).startsWith(`DELETE FROM ${P}entries_fts_retired_1`))).toBe(true);
    expect(JSON.parse((await meta.getMeta(FTS5_RETIRED_TABLES_KEY))!)).toEqual([]);
  });
});
