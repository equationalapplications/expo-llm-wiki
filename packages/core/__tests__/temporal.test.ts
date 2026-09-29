import { describe, it, expect } from 'vitest';
import { liveAtSql, isLiveAt, assertEpochMs } from '../src/utils/temporal';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/WikiMemory';
import { WikiSupersedeError } from '../src/index';

const base = { created_at: 100, deleted_at: null as number | null };

describe('isLiveAt', () => {
  it('asOf: half-open [COALESCE(valid_from, created_at), valid_to)', () => {
    const f = { ...base, valid_from: 200, valid_to: 300 };
    expect(isLiveAt(f, 'asOf', 199)).toBe(false);
    expect(isLiveAt(f, 'asOf', 200)).toBe(true);
    expect(isLiveAt(f, 'asOf', 299)).toBe(true);
    expect(isLiveAt(f, 'asOf', 300)).toBe(false);
  });
  it('asOf: NULL valid_from falls back to created_at', () => {
    expect(isLiveAt(base, 'asOf', 99)).toBe(false);
    expect(isLiveAt(base, 'asOf', 100)).toBe(true);
  });
  it('current: rows with no temporal columns are always live, regardless of created_at', () => {
    expect(isLiveAt({ created_at: 9e15, deleted_at: null }, 'current', 1)).toBe(true);
  });
  it('current: respects valid_from in the future and valid_to in the past', () => {
    expect(isLiveAt({ ...base, valid_from: 500 }, 'current', 400)).toBe(false);
    expect(isLiveAt({ ...base, valid_to: 400 }, 'current', 400)).toBe(false);
    expect(isLiveAt({ ...base, valid_to: 401 }, 'current', 400)).toBe(true);
  });
  it('deleted rows are never live', () => {
    expect(isLiveAt({ ...base, deleted_at: 1 }, 'current', 1)).toBe(false);
  });
});

describe('liveAtSql', () => {
  it('matches isLiveAt for the same rows in both modes', async () => {
    const db = openTestDatabase();
    await new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } }).setup();
    const rows = [
      { id: 'a', vf: null, vt: null, c: 100 },
      { id: 'b', vf: 200, vt: 300, c: 100 },
      { id: 'c', vf: null, vt: 150, c: 100 },
      { id: 'd', vf: 500, vt: null, c: 100 },
    ];
    for (const r of rows) {
      await db.runAsync(
        `INSERT INTO llm_wiki_entries (id, entity_id, title, body, created_at, updated_at, valid_from, valid_to) VALUES (?, 'e', 't', 'b', ?, ?, ?, ?)`,
        [r.id, r.c, r.c, r.vf, r.vt],
      );
    }
    for (const mode of ['current', 'asOf'] as const) {
      for (const t of [99, 100, 149, 150, 200, 299, 300, 500]) {
        const sqlIds = (await db.getAllAsync<{ id: string }>(
          `SELECT id FROM llm_wiki_entries WHERE deleted_at IS NULL AND ${liveAtSql(mode)} ORDER BY id`, [t, t],
        )).map((r) => r.id);
        const jsIds = rows
          .filter((r) => isLiveAt({ created_at: r.c, deleted_at: null, valid_from: r.vf, valid_to: r.vt }, mode, t))
          .map((r) => r.id);
        expect({ mode, t, ids: sqlIds }).toEqual({ mode, t, ids: jsIds });
      }
    }
  });
});

describe('assertEpochMs', () => {
  it('accepts finite non-negative numbers and truncates', () => {
    expect(assertEpochMs('x', 12.9)).toBe(12);
  });
  it.each([-1, NaN, Infinity, '1', null])('rejects %p', (v) => {
    expect(() => assertEpochMs('x', v)).toThrow(TypeError);
  });
});

describe('WikiSupersedeError', () => {
  it('carries a reason code and is exported', () => {
    const e = new WikiSupersedeError('cycle');
    expect(e).toBeInstanceOf(Error);
    expect(e.reason).toBe('cycle');
    expect(e.code).toBe('WIKI_SUPERSEDE_REJECTED');
    expect(e.name).toBe('WikiSupersedeError');
  });
});