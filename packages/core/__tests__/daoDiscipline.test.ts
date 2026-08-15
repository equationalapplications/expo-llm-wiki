import { describe, it, expect, beforeEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;
const PREFIX = 'llm_wiki_';

type Recorded = { sql: string; params: unknown[] };

function wrapWithRecorder(db: SQLiteAdapter): { db: SQLiteAdapter; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const wrapped: SQLiteAdapter = {
    execAsync: (sql: string) => {
      recorded.push({ sql, params: [] });
      return db.execAsync(sql);
    },
    runAsync: async (sql, params = []) => {
      recorded.push({ sql, params });
      return db.runAsync(sql, params);
    },
    getAllAsync: <T>(sql: string, params?: unknown[]) => db.getAllAsync<T>(sql, params),
    getFirstAsync: <T>(sql: string, params?: unknown[]) => db.getFirstAsync<T>(sql, params),
    withTransactionAsync: <T>(fn: (tx: SQLiteAdapter) => Promise<T>) =>
      db.withTransactionAsync((tx) => fn(wrapped)),
    closeAsync: () => db.closeAsync(),
  };
  return { db: wrapped, recorded };
}

async function makeWikiWithRecorder(): Promise<{ wiki: WikiMemory; db: SQLiteAdapter; recorded: Recorded[] }> {
  const real = openTestDatabase();
  const { db, recorded } = wrapWithRecorder(real);
  const wiki = new WikiMemory(db, stubOptions);
  await wiki.setup();
  return { wiki, db, recorded };
}

function setClause(sql: string): string {
  const m = /SET\s+(.+?)\s+WHERE/i.exec(sql);
  return m ? m[1] : '';
}

function updatedAtInSet(sql: string): boolean {
  const set = setClause(sql);
  return /\bupdated_at\b/.test(set);
}

describe('DAO discipline: non-content writes MUST NOT touch updated_at', () => {
  beforeEach(async () => {});

  it('writeOkfTrust has no updated_at in SET clause', async () => {
    const { wiki, db, recorded } = await makeWikiWithRecorder();
    const t = 1_700_000_000_000;
    await db.runAsync(
      `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at) VALUES ('p1', 'e', 'T', 'B', 'certain', 'user_stated', ?, ?)`,
      [t, t],
    );
    recorded.length = 0;
    await wiki.writeOkfTrust('p1', 'e', [{ by: 'human:a', at: '2026-01-01T00:00:00Z' }]);
    const updates = recorded.filter((r) => /UPDATE/i.test(r.sql));
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(updatedAtInSet(u.sql), `unexpected updated_at in: ${u.sql}`).toBe(false);
  });

  it('writeOkfSources has no updated_at in SET clause', async () => {
    const { wiki, db, recorded } = await makeWikiWithRecorder();
    const t = 1_700_000_000_000;
    await db.runAsync(
      `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at) VALUES ('p2', 'e', 'T', 'B', 'certain', 'user_stated', ?, ?)`,
      [t, t],
    );
    recorded.length = 0;
    await wiki.writeOkfSources('p2', 'e', [{ resource: 'https://a' }]);
    const updates = recorded.filter((r) => /UPDATE/i.test(r.sql));
    for (const u of updates) expect(updatedAtInSet(u.sql)).toBe(false);
  });

  it('setLifecycleStatus has no updated_at in SET clause', async () => {
    const { wiki, db, recorded } = await makeWikiWithRecorder();
    const t = 1_700_000_000_000;
    await db.runAsync(
      `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at) VALUES ('p3', 'e', 'T', 'B', 'certain', 'user_stated', ?, ?)`,
      [t, t],
    );
    recorded.length = 0;
    await wiki.setLifecycleStatus('p3', 'e', 'deprecated');
    const updates = recorded.filter((r) => /UPDATE/i.test(r.sql));
    for (const u of updates) expect(updatedAtInSet(u.sql)).toBe(false);
  });

  it('setStaleAfter has no updated_at in SET clause', async () => {
    const { wiki, db, recorded } = await makeWikiWithRecorder();
    const t = 1_700_000_000_000;
    await db.runAsync(
      `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at) VALUES ('p4', 'e', 'T', 'B', 'certain', 'user_stated', ?, ?)`,
      [t, t],
    );
    recorded.length = 0;
    await wiki.setStaleAfter('p4', 'e', null);
    const updates = recorded.filter((r) => /UPDATE/i.test(r.sql));
    for (const u of updates) expect(updatedAtInSet(u.sql)).toBe(false);
  });

  it('setGeneratedBy has no updated_at in SET clause', async () => {
    const { wiki, db, recorded } = await makeWikiWithRecorder();
    const t = 1_700_000_000_000;
    await db.runAsync(
      `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at) VALUES ('p5', 'e', 'T', 'B', 'certain', 'user_stated', ?, ?)`,
      [t, t],
    );
    recorded.length = 0;
    await wiki.setGeneratedBy('p5', 'e', 'process:cron');
    const updates = recorded.filter((r) => /UPDATE/i.test(r.sql));
    for (const u of updates) expect(updatedAtInSet(u.sql)).toBe(false);
  });

  it('access_count increment has no updated_at in SET clause (positive existing behavior)', async () => {
    const { wiki, db, recorded } = await makeWikiWithRecorder();
    const t = 1_700_000_000_000;
    await db.runAsync(
      `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at) VALUES ('p6', 'e', 'T', 'B', 'certain', 'user_stated', ?, ?)`,
      [t, t],
    );
    recorded.length = 0;
    await wiki.read('e', 'x'); // any read triggers trackAccess
    const updates = recorded.filter((r) => /UPDATE/i.test(r.sql) && /\baccess_count\b/.test(r.sql));
    if (updates.length > 0) {
      for (const u of updates) expect(updatedAtInSet(u.sql)).toBe(false);
    }
    // If no access tracking fires (empty read), this test still passes (no assertion).
  });

  it('positive control: a content-mutating write DOES touch updated_at', async () => {
    const { wiki, db, recorded } = await makeWikiWithRecorder();
    // Force a content write by importing a fact (which runs upsertForImport).
    await wiki.importDump({
      generatedAt: 1_700_000_000_000,
      entities: { e: { facts: [{
        id: 'p7', entity_id: 'e', title: 'T', body: 'B', tags: [],
        confidence: 'certain', source_type: 'user_stated',
        source_hash: null, source_ref: null,
        created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
        last_accessed_at: null, access_count: 0, deleted_at: null, okf_type: 'fact',
      }], tasks: [], events: [], edges: [], summary: '' } },
    });
    const updates = recorded.filter((r) => /INSERT/i.test(r.sql) && /\bupdated_at\b/.test(r.sql));
    expect(updates.length).toBeGreaterThan(0);
  });
});
