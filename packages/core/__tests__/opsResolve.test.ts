import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { UsageMeter } from '../src/utils/usage';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { runResolve, validateOp, screenResolveCandidates } from '../src/services/librarian/ops/resolve';
import { WikiBudgetExhausted } from '../src/utils/usage';
import type { ClassifyRequest, ClassifyResponse } from '../src/types';
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
    sourceEventId: null,
    sourcePartIndex: null,
    pointerUnresolved: null,
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

  it('carries overflow-skipped candidate indexes on the outcome without emitting diagnostics directly', async () => {
    const db = openTestDatabase();
    const diags: any[] = [];
    const generateText = vi.fn(async () => {
      throw new Error("This model's maximum context length is 8192 tokens. However, you requested 10020 tokens.");
    });
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText },
      onDiagnostic: (d: any) => diags.push(d),
      config: { autoLibrarianThreshold: 1000 },
    });
    await wiki.setup();
    const deps = (wiki.__testAccess.maintenanceService as any).librarianDeps();

    const g = mkGated(mkCandidate(7, 'User moved to SF'), 'fact_item0', 'n1');
    const out = await runResolve(deps, { entityId: 'u', trigger: 'call' }, [g]);

    // The outcome reports the skipped candidate indexes; the pass-level
    // DiagnosticBuffer in ops/index.ts owns emission (so a budget stop can
    // discard them instead of re-emitting across passes).
    expect(out.overflowSkipped).toEqual([7]);
    expect(diags).toEqual([]);
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

const mkCand = (index: number, title: string, body = 'b'): Candidate => ({
  index,
  fact: { title, body, tags: [], confidence: 'certain' },
  sourceLabel: null,
  sourceEventId: null,
  sourcePartIndex: null,
  pointerUnresolved: null,
  validFrom: 0,
});

const mkGate = (candidate: Candidate, neighbourId: string, ref = 'n1', nTitle = 'something', nBody = 'b'): GatedCandidate => ({
  candidate,
  neighbours: [{ id: neighbourId, ref, title: nTitle, body: nBody, source_type: 'user_stated', score: null }],
  decision: { kind: 'ambiguous' },
  vector: null,
});

const yes = (p = 0.95): ClassifyResponse => ({ answers: { n1: { kind: 'binary', probability: p } } });

describe('screenResolveCandidates (resolution-system-one §4, §5)', () => {
  it("mode 'llm' → nothing settled, rest equals input, zero classifier calls", async () => {
    const ask = vi.fn(async (_r: ClassifyRequest) => yes());
    const input = [mkGate(mkCand(0, 'a'), 'f0')];
    const r = await screenResolveCandidates(input, 'llm', 0.8, ask);
    expect(r.settled.size).toBe(0);
    expect(r.rest).toEqual(input);
    expect(r.warnReason).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  it("mode 'auto' with no floor → warnReason 'no-floor', zero calls", async () => {
    const ask = vi.fn(async (_r: ClassifyRequest) => yes());
    const input = [mkGate(mkCand(0, 'a'), 'f0')];
    const r = await screenResolveCandidates(input, 'auto', undefined, ask);
    expect(r.settled.size).toBe(0);
    expect(r.warnReason).toBe('no-floor');
    expect(r.rest).toEqual(input);
    expect(ask).not.toHaveBeenCalled();
  });

  it("classify absent → warnReason 'no-classifier', whole input falls through", async () => {
    const input = [mkGate(mkCand(0, 'a'), 'f0')];
    const r = await screenResolveCandidates(input, 'auto', 0.8, undefined);
    expect(r.settled.size).toBe(0);
    expect(r.warnReason).toBe('no-classifier');
    expect(r.rest).toEqual(input);
  });

  it('YES at or above the floor settles a NOOP on neighbours[0].id (>= comparison)', async () => {
    const g0 = mkGate(mkCand(0, 'a'), 'f0');
    const g1 = mkGate(mkCand(1, 'b'), 'f1');
    const above = await screenResolveCandidates([g0], 'auto', 0.8, async () => yes(0.9));
    expect(above.settled.get(g0)).toEqual({ op: 'NOOP', targetId: 'f0' });
    expect(above.rest).toEqual([]);
    const exact = await screenResolveCandidates([g1], 'auto', 0.8, async () => yes(0.8));
    expect(exact.settled.get(g1)).toEqual({ op: 'NOOP', targetId: 'f1' });
  });

  it('NO and uncertain-band answers stay in rest', async () => {
    const g0 = mkGate(mkCand(0, 'a'), 'f0');
    const g1 = mkGate(mkCand(1, 'b'), 'f1');
    const probs = [0.02, 0.79];
    let i = 0;
    const r = await screenResolveCandidates([g0, g1], 'auto', 0.8, async () => yes(probs[i++]));
    expect(r.settled.size).toBe(0);
    expect(r.rest).toEqual([g0, g1]);
    expect(r.warnReason).toBeUndefined();
  });

  it('malformed answers stay in rest without throwing', async () => {
    const hostile = {
      get answers(): never {
        throw new Error('boom');
      },
    } as unknown as ClassifyResponse;
    const responses: unknown[] = [
      { answers: {} },
      { answers: { n1: { kind: 'choice', choice: 'x', confidence: 0.9, probabilities: { x: 0.9 } } } },
      { answers: { n1: { kind: 'binary', probability: NaN } } },
      { answers: { n1: { kind: 'binary', probability: 1.5 } } },
      hostile,
    ];
    for (const resp of responses) {
      const g = mkGate(mkCand(0, 'a'), 'f0');
      const r = await screenResolveCandidates([g], 'auto', 0.8, async () => resp as ClassifyResponse);
      expect(r.settled.size).toBe(0);
      expect(r.rest).toEqual([g]);
      expect(r.warnReason).toBeUndefined();
    }
  });

  it('asks one request per candidate: one binary question keyed to neighbours[0].ref, neighbour text in instructions', async () => {
    const calls: ClassifyRequest[] = [];
    const g0 = mkGate(mkCand(0, 'Alice lives in Paris', 'cand body 0'), 'f0', 'n1', 'N-title-0', 'N-body-0');
    g0.neighbours.push({ id: 'f0b', ref: 'n2', title: 'second', body: 'second body', source_type: 'user_stated', score: null });
    const g1 = mkGate(mkCand(1, 'Bob', 'cand body 1'), 'f1', 'n1', 'N-title-1', 'N-body-1');
    await screenResolveCandidates([g0, g1], 'auto', 0.8, async (req) => {
      calls.push(req);
      return yes(0.1);
    });
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0].questions)).toEqual(['n1']);
    expect(calls[0].state).toContain('Alice lives in Paris');
    expect(calls[0].state).toContain('cand body 0');
    const q = calls[0].questions.n1;
    expect(q.kind).toBe('binary');
    const ins = (q as { instructions: string }).instructions;
    expect(ins).toContain('add NO information beyond');
    expect(ins).toContain('pure duplicate: same claims, no new content');
    expect(ins).toContain('N-title-0');
    expect(ins).toContain('N-body-0');
    expect(ins).not.toContain('second');
    expect((calls[1].questions.n1 as { instructions: string }).instructions).toContain('N-title-1');
    expect(calls[1].state).not.toContain('Alice');
  });

  it("per-candidate scoping: A's YES never settles B, B's NOOP never targets A's neighbour", async () => {
    const gA = mkGate(mkCand(0, 'A'), 'fA');
    const gB = mkGate(mkCand(1, 'B'), 'fB');
    const r = await screenResolveCandidates([gA, gB], 'auto', 0.8, async (req) => (req.state.startsWith('A') ? yes(0.99) : yes(0.4)));
    expect(r.settled.get(gA)).toEqual({ op: 'NOOP', targetId: 'fA' });
    expect(r.settled.has(gB)).toBe(false);
    expect(r.rest).toEqual([gB]);
    const r2 = await screenResolveCandidates([gA, gB], 'auto', 0.8, async (req) => (req.state.startsWith('B') ? yes(0.99) : yes(0.4)));
    expect(r2.settled.get(gB)).toEqual({ op: 'NOOP', targetId: 'fB' });
    expect(r2.settled.has(gA)).toBe(false);
  });

  it('an update-shaped pair does not settle (duplicate-only question)', async () => {
    const g = mkGate(mkCand(0, 'Alice lives in Berlin', 'Alice lives in Berlin'), 'f0', 'n1', 'Alice lives in Paris', 'Alice lives in Paris');
    // Fake models the duplicate-only question: YES only when the claims match.
    const r = await screenResolveCandidates([g], 'auto', 0.8, async (req) => {
      const ins = (req.questions.n1 as { instructions: string }).instructions;
      expect(ins).toContain('no new content');
      const claimsMatch = req.state.includes('Berlin') === ins.includes('Berlin');
      return yes(claimsMatch ? 0.99 : 0.03);
    });
    expect(r.settled.size).toBe(0);
    expect(r.rest).toEqual([g]);
  });

  it("all-or-nothing: a throw on the second candidate → settled empty, whole input in rest, 'no-classifier'", async () => {
    const gs = [mkGate(mkCand(0, 'a'), 'f0'), mkGate(mkCand(1, 'b'), 'f1')];
    let n = 0;
    const r = await screenResolveCandidates(gs, 'auto', 0.8, async () => {
      if (++n === 2) throw new Error('classifier down');
      return yes(0.99);
    });
    expect(r.settled.size).toBe(0);
    expect(r.rest).toEqual(gs);
    expect(r.warnReason).toBe('no-classifier');
    expect(r.budgetStop).toBeUndefined();
  });

  it('a WikiBudgetExhausted throw surfaces as budgetStop, not fallthrough', async () => {
    const gs = [mkGate(mkCand(0, 'a'), 'f0')];
    const r = await screenResolveCandidates(gs, 'auto', 0.8, async () => {
      throw new WikiBudgetExhausted(42, 1);
    });
    expect(r.budgetStop).toEqual({ requiredEstimate: 42 });
    expect(r.warnReason).toBeUndefined();
    expect(r.settled.size).toBe(0);
  });

  it('a candidate with no neighbours is skipped safely (never asked)', async () => {
    const ask = vi.fn(async (_r: ClassifyRequest) => yes(0.99));
    const g: GatedCandidate = { candidate: mkCand(0, 'a'), neighbours: [], decision: { kind: 'ambiguous' }, vector: null };
    const r = await screenResolveCandidates([g], 'auto', 0.8, ask);
    expect(ask).not.toHaveBeenCalled();
    expect(r.settled.size).toBe(0);
    expect(r.rest).toEqual([g]);
  });
});

describe('runResolve with the screen (resolution-system-one §5, §7)', () => {
  const mkDeps = async (config: Record<string, unknown>, opts: { classify?: any; generateText?: any } = {}) => {
    const generateText = opts.generateText ?? vi.fn(async () => JSON.stringify({ ops: [] }));
    const wiki = new WikiMemory(openTestDatabase(), {
      llmProvider: { generateText, ...(opts.classify ? { classify: opts.classify } : {}) },
      config: { autoLibrarianThreshold: 1000, ...config },
    } as any);
    await wiki.setup();
    const deps = (wiki.__testAccess.maintenanceService as any).librarianDeps();
    return { deps, generateText: generateText as ReturnType<typeof vi.fn> };
  };
  const ctx = { entityId: 'u', trigger: 'call' } as const;
  const auto = { systemOne: { resolve: 'auto', minConfidence: { resolve: 0.8 } } };

  it('compatibility: no key / llm / classify-without-key are byte-identical to a no-classifier run', async () => {
    const run = async (config: Record<string, unknown>, classify?: any) => {
      const { deps, generateText } = await mkDeps(config, { classify });
      const spy = vi.spyOn(deps.promptService, 'buildOpsResolvePrompt');
      const gs = [mkGate(mkCand(0, 'x'), 'f0'), mkGate(mkCand(1, 'y'), 'f1')];
      const out = await runResolve(deps, ctx, gs);
      return {
        promptArgs: JSON.stringify(spy.mock.calls),
        llm: JSON.stringify(generateText.mock.calls),
        ops: out.ops.size,
        settled: out.classifierSettled,
      };
    };
    const baseline = await run({});
    const classify = vi.fn(async () => yes());
    const noKey = await run({}, classify);
    const llm = await run({ systemOne: { resolve: 'llm', minConfidence: { resolve: 0.8 } } }, classify);
    expect(noKey).toEqual(baseline);
    expect(llm).toEqual(baseline);
    expect(classify).not.toHaveBeenCalled();
    expect(baseline.settled).toEqual([]);
  });

  it('mixed batch: the LLM receives only rest; settled candidates appear as NOOPs; rest keeps generative ops', async () => {
    const classify = vi.fn(async (req: ClassifyRequest) => (req.state.startsWith('dup') ? yes(0.99) : yes(0.1)));
    const generateText = vi.fn(async () => JSON.stringify({ ops: [{ item: 0, op: 'SUPERSEDE', target: 'n1' }] }));
    const { deps } = await mkDeps(auto, { classify, generateText });
    const spy = vi.spyOn(deps.promptService, 'buildOpsResolvePrompt');
    const gDup = mkGate(mkCand(3, 'dup fact'), 'fDup');
    const gNew = mkGate(mkCand(4, 'new fact'), 'fNew');
    const out = await runResolve(deps, ctx, [gDup, gNew]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toHaveLength(1);
    expect(spy.mock.calls[0][0][0].candidate.title).toBe('new fact');
    expect(out.ops.get(gDup)).toEqual({ op: 'NOOP', targetId: 'fDup' });
    expect(out.ops.get(gNew)).toEqual({ op: 'SUPERSEDE', targetId: 'fNew' });
    expect(out.classifierSettled).toEqual([3]);
    expect(out.overflowSkipped).toEqual([]);
  });

  it('an all-settled batch makes zero LLM calls', async () => {
    const classify = vi.fn(async () => yes(0.99));
    const { deps, generateText } = await mkDeps(auto, { classify });
    const g = mkGate(mkCand(0, 'dup'), 'f0');
    const out = await runResolve(deps, ctx, [g]);
    expect(generateText).not.toHaveBeenCalled();
    expect(out.ops.get(g)).toEqual({ op: 'NOOP', targetId: 'f0' });
    expect(out.classifierSettled).toEqual([0]);
  });

  it('classifier absent or throwing: one warning per process, whole batch goes to the LLM', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mod = await import('../src/services/librarian/ops/resolve');
      const gs = () => [mkGate(mkCand(0, 'x'), 'f0'), mkGate(mkCand(1, 'y'), 'f1')];
      const gen = () => vi.fn(async () => JSON.stringify({ ops: [{ item: 0, op: 'ADD' }, { item: 1, op: 'ADD' }] }));
      const a = await mkDeps(auto, { generateText: gen() });
      const outA = await mod.runResolve(a.deps, ctx, gs());
      const b = await mkDeps(auto, { classify: vi.fn(async () => { throw new Error('down'); }), generateText: gen() });
      const outB = await mod.runResolve(b.deps, ctx, gs());
      expect(a.generateText).toHaveBeenCalledTimes(1);
      expect(b.generateText).toHaveBeenCalledTimes(1);
      expect(outA.ops.size).toBe(2);
      expect(outB.ops.size).toBe(2);
      expect(outA.classifierSettled).toEqual([]);
      expect(outB.classifierSettled).toEqual([]);
      const classifyWarns = warn.mock.calls.filter((c) => String(c[0]).includes('systemOne.resolve') && String(c[0]).includes('classif'));
      expect(classifyWarns).toHaveLength(1);
    } finally {
      warn.mockRestore();
      vi.resetModules();
    }
  });

  it('a tight meter during the screen surfaces as budgetStop with no LLM call', async () => {
    const classify = vi.fn(async () => yes(0.99));
    const { deps, generateText } = await mkDeps(auto, { classify });
    const out = await runResolve(deps, { ...ctx, meter: new UsageMeter(1) }, [mkGate(mkCand(0, 'x'), 'f0')]);
    expect(out.budgetStop).toBeDefined();
    expect(classify).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });
});
