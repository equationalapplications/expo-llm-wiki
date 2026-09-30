import { describe, it, expect, beforeEach } from 'vitest';
import { WikiMemory } from '../../src/WikiMemory';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../../src/types';

let db: SQLiteAdapter;
let repo: any;

async function insert(id: string, entity: string, extra: Record<string, unknown> = {}) {
  const row = { created_at: 100, updated_at: 100, valid_from: null, valid_to: null, superseded_by: null, deleted_at: null, source_type: 'user_stated', ...extra };
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, created_at, updated_at, valid_from, valid_to, superseded_by, deleted_at, source_type)
     VALUES (?, ?, 't', 'b', ?, ?, ?, ?, ?, ?, ?)`,
    [id, entity, row.created_at, row.updated_at, row.valid_from, row.valid_to, row.superseded_by, row.deleted_at, row.source_type],
  );
}

beforeEach(async () => {
  db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' }, config: { enableOutbox: true } });
  await wiki.setup();
  repo = wiki.__testAccess.entryRepo;
});

describe('setTemporal', () => {
  it('writes only provided keys, null clears, outbox staged', async () => {
    await insert('f1', 'e1', { valid_from: 50 });
    await db.withTransactionAsync(async (tx) => {
      expect(await repo.setTemporal('f1', 'e1', { valid_to: 300 }, tx)).toBe(1);
    });
    let row = await db.getFirstAsync<any>(`SELECT valid_from, valid_to FROM llm_wiki_entries WHERE id='f1'`);
    expect(row).toEqual({ valid_from: 50, valid_to: 300 });
    await db.withTransactionAsync(async (tx) => { await repo.setTemporal('f1', 'e1', { valid_from: null }, tx); });
    row = await db.getFirstAsync<any>(`SELECT valid_from, valid_to FROM llm_wiki_entries WHERE id='f1'`);
    expect(row).toEqual({ valid_from: null, valid_to: 300 });
    const outbox = await db.getAllAsync<any>(`SELECT operation, record_id FROM llm_wiki_outbox WHERE record_id='f1'`);
    expect(outbox.length).toBe(2);
    expect(outbox.every((o) => o.operation === 'UPDATE')).toBe(true);
  });

  it('respects entity ownership and outbox:false', async () => {
    await insert('f1', 'e1');
    await db.withTransactionAsync(async (tx) => {
      expect(await repo.setTemporal('f1', 'other', { valid_to: 1 }, tx)).toBe(0);
      expect(await repo.setTemporal('f1', 'e1', { valid_to: 1 }, tx, { outbox: false })).toBe(1);
    });
    expect((await db.getAllAsync(`SELECT 1 FROM llm_wiki_outbox WHERE record_id='f1'`)).length).toBe(0);
  });
});

describe('findNonLiveIdsByEntityIds', () => {
  it('current mode ignores created_at and catches expired/future rows', async () => {
    await insert('plain', 'e1', { created_at: 9e12 });
    await insert('expired', 'e1', { valid_to: 150 });
    await insert('future', 'e1', { valid_from: 10_000 });
    await insert('open', 'e1', { valid_from: 50 });
    const ids = await repo.findNonLiveIdsByEntityIds(['e1'], 'current', 200);
    expect([...ids].sort()).toEqual(['expired', 'future']);
  });
  it('asOf mode uses COALESCE(valid_from, created_at)', async () => {
    await insert('plain', 'e1', { created_at: 300 });
    const ids = await repo.findNonLiveIdsByEntityIds(['e1'], 'asOf', 200);
    expect([...ids]).toEqual(['plain']);
  });
  it('skips soft-deleted rows', async () => {
    await insert('gone', 'e1', { valid_to: 1, deleted_at: 5 });
    expect((await repo.findNonLiveIdsByEntityIds(['e1'], 'current', 200)).size).toBe(0);
  });
});

describe('findSupersessionChainIds', () => {
  it('walks both directions and excludes the start id', async () => {
    await insert('v1', 'e1', { superseded_by: 'v2' });
    await insert('v2', 'e1', { superseded_by: 'v3' });
    await insert('v3', 'e1');
    await insert('x', 'e2', { superseded_by: 'v2' }); // other entity: ignored
    expect(await repo.findSupersessionChainIds('e1', 'v2', 50)).toEqual({ predecessors: ['v1'], successors: ['v3'] });
  });
  it('stops at maxDepth', async () => {
    await insert('a', 'e1', { superseded_by: 'b' });
    await insert('b', 'e1', { superseded_by: 'c' });
    await insert('c', 'e1');
    expect((await repo.findSupersessionChainIds('e1', 'a', 1)).successors).toEqual(['b']);
  });
});

describe('findTemporalRow / findExpiredIds', () => {
  it('reads the temporal projection without entity filter', async () => {
    await insert('f1', 'e9', { valid_to: 10 });
    expect(await repo.findTemporalRow('f1')).toMatchObject({ id: 'f1', entity_id: 'e9', valid_to: 10 });
    expect(await repo.findTemporalRow('nope')).toBeNull();
  });
  it('findExpiredIds returns non-deleted rows expired at or before cutoff', async () => {
    await insert('old', 'e1', { valid_to: 100 });
    await insert('recent', 'e1', { valid_to: 500 });
    await insert('deleted', 'e1', { valid_to: 50, deleted_at: 60 });
    expect(await repo.findExpiredIds('e1', 200)).toEqual(['old']);
  });
});