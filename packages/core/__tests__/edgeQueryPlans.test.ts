import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { EdgeRepository } from '../src/repositories/EdgeRepository';
import { LintRepository } from '../src/repositories/LintRepository';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;
const PREFIX = 'llm_wiki_';

type Call = { sql: string; args: unknown[] };

/** Wraps an adapter and records every statement that touches the edges table. */
function recording(db: SQLiteAdapter): { adapter: SQLiteAdapter; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (sql: string, args: unknown[] = []) => {
    if (sql.includes(`${PREFIX}edges`)) calls.push({ sql, args });
  };
  const adapter: SQLiteAdapter = {
    ...db,
    execAsync: async (sql) => { rec(sql); return db.execAsync(sql); },
    runAsync: async (sql, args = []) => { rec(sql, args); return db.runAsync(sql, args); },
    getAllAsync: async (sql, args = []) => { rec(sql, args); return db.getAllAsync(sql, args); },
    getFirstAsync: async (sql, args = []) => { rec(sql, args); return db.getFirstAsync(sql, args); },
    withTransactionAsync: (fn) => db.withTransactionAsync(fn),
  };
  return { adapter, calls };
}

async function plan(db: SQLiteAdapter, call: Call): Promise<string[]> {
  const rows = await db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${call.sql}`, call.args);
  return rows.map((r) => r.detail);
}

/** A full scan of edges: `SCAN e`, `SCAN llm_wiki_edges`, or a full index scan of either. */
const FULL_EDGE_SCAN = new RegExp(`\\bSCAN (TABLE )?(e|${PREFIX}edges)\\b`);

async function setup() {
  const db = openTestDatabase();
  await new WikiMemory(db, stubOptions).setup();
  const { adapter, calls } = recording(db);
  return { db, calls, edges: new EdgeRepository(adapter, PREFIX), lint: new LintRepository(adapter, PREFIX), adapter };
}

describe('edges query plans (spec REQ-EDGEIDX-01)', () => {
  it('pageLiveEdges range-scans edges_entity_id_idx with no temp B-tree sort', async () => {
    const { db, calls, lint } = await setup();
    await lint.pageLiveEdges('e1', '', 500);
    expect(calls).toHaveLength(1);
    const detail = await plan(db, calls[0]);
    expect(detail.some((d) => d.includes(`USING INDEX ${PREFIX}edges_entity_id_idx`) || d.includes(`USING COVERING INDEX ${PREFIX}edges_entity_id_idx`))).toBe(true);
    expect(detail.some((d) => d.includes('TEMP B-TREE'))).toBe(false);
  });

  it.each([
    ['countDanglingEdges', (r: { lint: LintRepository }) => r.lint.countDanglingEdges('e1')],
    ['sampleDanglingEdgeIds', (r: { lint: LintRepository }) => r.lint.sampleDanglingEdgeIds('e1', 20)],
    ['getByEntityId', (r: { edges: EdgeRepository }) => r.edges.getByEntityId('e1')],
  ] as const)('%s uses an index on edges, not a full scan', async (_name, invoke) => {
    const r = await setup();
    await invoke(r as never);
    expect(r.calls).toHaveLength(1);
    const detail = await plan(r.db, r.calls[0]);
    expect(detail.filter((d) => FULL_EDGE_SCAN.test(d))).toEqual([]);
  });

  it.each([
    ['bulkDeleteByEntityId', (edges: EdgeRepository, tx: SQLiteAdapter) => edges.bulkDeleteByEntityId('e1', tx)],
    ['softDeleteBySourceFactIds', (edges: EdgeRepository, tx: SQLiteAdapter) => edges.softDeleteBySourceFactIds('e1', ['f1', 'f2'], tx)],
  ] as const)('%s uses an index on edges, not a full scan', async (_name, invoke) => {
    const r = await setup();
    await invoke(r.edges, r.adapter);
    expect(r.calls).toHaveLength(1);
    const detail = await plan(r.db, r.calls[0]);
    expect(detail.filter((d) => FULL_EDGE_SCAN.test(d))).toEqual([]);
  });
});