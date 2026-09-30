import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { UsageMeter } from '../src/utils/usage';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { runResolve, validateOp } from '../src/services/librarian/ops/resolve';
import type { GatedCandidate } from '../src/services/librarian/ops/gate';
import type { Candidate } from '../src/services/librarian/ops/extract';

const aliases = new Map([['n1', 'fact_seattle'], ['n2', 'fact_job']]);

describe('validateOp', () => {
  it('maps aliases to real ids', () => {
    expect(validateOp({ op: 'SUPERSEDE', target: 'n1' }, aliases)).toEqual({ op: 'SUPERSEDE', targetId: 'fact_seattle' });
    expect(validateOp({ op: 'NOOP', target: 'n2' }, aliases)).toEqual({ op: 'NOOP', targetId: 'fact_job' });
    expect(validateOp({ op: 'ADD' }, aliases)).toEqual({ op: 'ADD' });
  });
  it('rejects aliases outside THIS candidate map (per-candidate scoping)', () => {
    expect(validateOp({ op: 'NOOP', target: 'n3' }, aliases)).toBeNull();
    expect(validateOp({ op: 'SUPERSEDE', target: 'fact_seattle' }, aliases)).toBeNull();
  });
  it('rejects unknown ops and missing targets', () => {
    expect(validateOp({ op: 'DELETE', target: 'n1' }, aliases)).toBeNull();
    expect(validateOp({ op: 'UPDATE' }, aliases)).toBeNull();
    expect(validateOp(null, aliases)).toBeNull();
  });
  it('UPDATE keeps only non-empty title/body; SUPERSEDE parses valid_from', () => {
    expect(validateOp({ op: 'UPDATE', target: 'n2', title: '', body: 'more detail' }, aliases))
      .toEqual({ op: 'UPDATE', targetId: 'fact_job', body: 'more detail' });
    expect(validateOp({ op: 'SUPERSEDE', target: 'n1', valid_from: '2026-03-01' }, aliases))
      .toEqual({ op: 'SUPERSEDE', targetId: 'fact_seattle', validFrom: Date.parse('2026-03-01') });
  });
});

describe('runResolve', () => {
  const mkCandidate = (index: number, title: string, body = 'b'): Candidate => ({
    index,
    fact: { title, body, tags: [], confidence: 'certain' },
    sourceLabel: null,
    validFrom: 0,
  });

  const mkGated = (candidate: Candidate, neighbourId: string, ref: string): GatedCandidate => ({
    candidate,
    neighbours: [
      { id: neighbourId, ref, title: 'something', body: 'b', source_type: 'user_stated', score: null },
    ],
    decision: { kind: 'ambiguous' },
    vector: null,
  });

  it("resolves item 1's n1 to item 1's neighbour, not item 0's", async () => {
    const db = openTestDatabase();
    const generateText = vi.fn(async () => JSON.stringify({
      ops: [
        { item: 0, op: 'SUPERSEDE', target: 'n1' },
        { item: 1, op: 'SUPERSEDE', target: 'n1' },
      ],
    }));
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText },
      config: { autoLibrarianThreshold: 1000 },
    });
    await wiki.setup();
    const deps = (wiki.__testAccess.maintenanceService as any).librarianDeps();

    const g0 = mkGated(mkCandidate(0, 'User moved to SF'), 'fact_item0', 'n1');
    const g1 = mkGated(mkCandidate(1, 'User changed jobs'), 'fact_item1', 'n1');

    const out = await runResolve(deps, { entityId: 'u', trigger: 'call' }, [g0, g1]);

    expect(out.ops.size).toBe(2);
    expect(out.ops.get(g0)).toEqual({ op: 'SUPERSEDE', targetId: 'fact_item0' });
    expect(out.ops.get(g1)).toEqual({ op: 'SUPERSEDE', targetId: 'fact_item1' });
    expect(out.rejected).toEqual([]);
    expect(out.failed).toEqual([]);
  });

  it('a {} response for a single-item batch lands the candidate in failed', async () => {
    const db = openTestDatabase();
    const generateText = vi.fn(async () => '{}');
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText },
      config: { autoLibrarianThreshold: 1000 },
    });
    await wiki.setup();
    const deps = (wiki.__testAccess.maintenanceService as any).librarianDeps();

    const g = mkGated(mkCandidate(0, 'User moved to SF'), 'fact_item0', 'n1');
    const out = await runResolve(deps, { entityId: 'u', trigger: 'call' }, [g]);

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(out.ops.size).toBe(0);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]).toBe(g);
    expect(out.budgetStop).toBeUndefined();
  });

  it('a tight meter sets budgetStop without calling the LLM', async () => {
    const db = openTestDatabase();
    const generateText = vi.fn(async () => JSON.stringify({ ops: [] }));
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText },
      config: { autoLibrarianThreshold: 1000 },
    });
    await wiki.setup();
    const deps = (wiki.__testAccess.maintenanceService as any).librarianDeps();

    const g = mkGated(mkCandidate(0, 'User moved to SF'), 'fact_item0', 'n1');
    const out = await runResolve(deps, { entityId: 'u', trigger: 'call', meter: new UsageMeter(1) }, [g]);

    expect(generateText).not.toHaveBeenCalled();
    expect(out.budgetStop).toBeDefined();
    expect(typeof out.budgetStop!.requiredEstimate).toBe('number');
    expect(out.ops.size).toBe(0);
  });
});
