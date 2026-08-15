import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;
const PREFIX = 'llm_wiki_';

type Recorded = { sql: string; params: unknown[] };

function wrapWithRecorderInto(target: SQLiteAdapter, recorded: Recorded[]): SQLiteAdapter {
  return {
    execAsync: (sql: string) => {
      recorded.push({ sql, params: [] });
      return target.execAsync(sql);
    },
    runAsync: async (sql, params = []) => {
      recorded.push({ sql, params });
      return target.runAsync(sql, params);
    },
    getAllAsync: <T>(sql: string, params?: unknown[]) => target.getAllAsync<T>(sql, params),
    getFirstAsync: <T>(sql: string, params?: unknown[]) => target.getFirstAsync<T>(sql, params),
    // Wrap the tx handle the underlying adapter hands us — the recorder has to
    // mirror the real call graph so a regression that distinguishes the
    // transaction handle from the base connection is caught instead of
    // silently executing outside the transaction.
    withTransactionAsync: <T>(fn: (tx: SQLiteAdapter) => Promise<T>) =>
      target.withTransactionAsync((tx) => fn(wrapWithRecorderInto(tx, recorded))),
    closeAsync: () => target.closeAsync(),
  };
}

function wrapWithRecorder(db: SQLiteAdapter): { db: SQLiteAdapter; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  return { db: wrapWithRecorderInto(db, recorded), recorded };
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
    expect(updates.length).toBeGreaterThan(0);
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
    expect(updates.length).toBeGreaterThan(0);
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
    expect(updates.length).toBeGreaterThan(0);
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
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(updatedAtInSet(u.sql)).toBe(false);
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
