import { describe, it, expect, vi } from 'vitest';
import {
  canEngageWriteTyping, isManifestRepresentable, buildTypingQuestion, classifyFactsForWrite,
  typingOutcomeReceipt, tallyTypingOutcome, emptyTypingCounters, volunteeredTypeResolves,
} from '../src/services/typing/typeOnWrite';
import { UsageMeter } from '../src/utils/usage';
import type { OntologyManifest, WikiOptions } from '../src/types';

const man = (n: number, extra: string[] = []): OntologyManifest => ({
  node_types: [...Array.from({ length: n }, (_, i) => ({ type: `t${i}`, description: `d${i}` })), ...extra.map((type) => ({ type, description: 'x' }))],
  edge_types: [],
});
const classify = async () => ({ answers: {} });

describe('canEngageWriteTyping (type-on-write §2)', () => {
  const cfg = { systemOne: { typeOnWrite: 'auto' as const } };
  it('engages when all four conditions hold', () => {
    expect(canEngageWriteTyping(cfg, { classify }, 'strict', man(2))).toBe(true);
    expect(canEngageWriteTyping(cfg, { classify }, 'emergent', man(2))).toBe(true);
  });
  it('each condition alone disables it', () => {
    expect(canEngageWriteTyping(undefined, { classify }, 'strict', man(2))).toBe(false);
    expect(canEngageWriteTyping({ systemOne: { typeOnWrite: 'llm' } }, { classify }, 'strict', man(2))).toBe(false);
    expect(canEngageWriteTyping(cfg, {}, 'strict', man(2))).toBe(false);
    expect(canEngageWriteTyping(cfg, { classify }, 'off', man(2))).toBe(false);
    expect(canEngageWriteTyping(cfg, { classify }, 'strict', man(0))).toBe(false);
  });
  it('254 slugs plus the sentinel engages; 255 does not; a reserved slug does not', () => {
    expect(isManifestRepresentable(man(254))).toBe(true);
    expect(isManifestRepresentable(man(255))).toBe(false);
    expect(isManifestRepresentable(man(2, ['None_Of_These']))).toBe(false);
  });
});

describe('buildTypingQuestion', () => {
  it('is a choice over slugs plus the sentinel with manifest descriptions', () => {
    const q = buildTypingQuestion(man(2));
    expect(q.kind).toBe('choice');
    expect((q as any).options).toEqual(['t0', 't1', 'none_of_these']);
    expect(q.instructions).toContain('- t0: d0');
  });
});

describe('classifyFactsForWrite outcomes (§3, §7)', () => {
  const facts = [{ title: 'a', body: 'b', tags: [] }];
  const run = async (answer: unknown, over: Partial<WikiOptions> = {}, meter?: UsageMeter, floor = 0.6) => {
    const options = { llmProvider: { generateText: async () => '', classify: vi.fn(async () => answer as any) }, ...over } as WikiOptions;
    return classifyFactsForWrite(options, { entityId: 'u', trigger: 'call', operation: 'librarian', meter }, facts, man(2), floor);
  };
  const choice = (c: string, confidence: number) => ({ answers: { okf_type: { kind: 'choice', choice: c, confidence, probabilities: { [c]: confidence } } } });

  it('accepts exactly at the floor, declines just below it', async () => {
    expect(await run(choice('t0', 0.6))).toEqual([{ kind: 'accepted', okfType: 't0', confidence: 0.6 }]);
    expect(await run(choice('t0', 0.6 - 1e-9))).toEqual([{ kind: 'low_confidence' }]);
  });
  it('the sentinel at confidence 1.0 is an abstain', async () => {
    expect(await run(choice('none_of_these', 1))).toEqual([{ kind: 'abstain' }]);
  });
  it('invalid answers carry their rejection', async () => {
    expect(await run(choice('zzz', 0.9))).toEqual([{ kind: 'invalid', reason: 'choice_not_offered' }]);
    expect(await run({ answers: { okf_type: { kind: 'binary', probability: 0.9 } } })).toEqual([{ kind: 'invalid', reason: 'kind_mismatch' }]);
    expect(await run({ answers: {} })).toEqual([{ kind: 'invalid', reason: 'missing_answer' }]);
    expect((await run(null))[0].kind).toBe('invalid');
  });
  it('thrown and overflow', async () => {
    const mk = (err: Error) => ({ llmProvider: { generateText: async () => '', classify: async () => { throw err; } } } as unknown as WikiOptions);
    const call = (o: WikiOptions) => classifyFactsForWrite(o, { entityId: 'u', trigger: 'call', operation: 'librarian' }, facts, man(2), 0.5);
    expect(await call(mk(new Error('boom')))).toEqual([{ kind: 'threw' }]);
    expect(await call(mk(new Error('maximum context length exceeded')))).toEqual([{ kind: 'overflow_skip' }]);
  });
  it('budget exhaustion marks the rest unattempted and stops asking', async () => {
    const classifyFn = vi.fn(async () => choice('t0', 0.9) as any);
    const options = { llmProvider: { generateText: async () => '', classify: classifyFn } } as unknown as WikiOptions;
    const meter = new UsageMeter(1); // too small for any call
    const many = Array.from({ length: 3 }, (_, i) => ({ title: `f${i}`, body: 'b', tags: [] }));
    const out = await classifyFactsForWrite(options, { entityId: 'u', trigger: 'call', operation: 'librarian', meter }, many, man(2), 0.5);
    expect(out.map((o) => o.kind)).toEqual(['unattempted', 'unattempted', 'unattempted']);
    expect(classifyFn).not.toHaveBeenCalled();
  });
  it('records usage into the meter and emits llm_usage (estimated) when the provider reports none', async () => {
    const meter = new UsageMeter(100000);
    const diags: any[] = [];
    await run(choice('t0', 0.9), { config: { reportLlmUsage: true }, onDiagnostic: (d: any) => diags.push(d) } as any, meter);
    expect(meter.used).toBeGreaterThan(0);
    const u = diags.filter((d) => d.code === 'llm_usage');
    expect(u).toHaveLength(1);
    expect(u[0].detail.estimated).toBe(true);
    expect(u[0].operation).toBe('librarian');
  });
});

describe('receipt mapping and counters', () => {
  const base = { entityId: 'u', operation: 'librarian' as const, trigger: 'call' as const };
  it('maps each non-accepted outcome to its existing code', () => {
    expect(typingOutcomeReceipt(base, 'f', { kind: 'abstain' })).toMatchObject({ code: 'classification_abstained', detail: { factId: 'f', writer: 'classifier' } });
    expect(typingOutcomeReceipt(base, 'f', { kind: 'low_confidence' })).toMatchObject({ code: 'classification_low_confidence', detail: { factId: 'f', reason: 'below_threshold' } });
    expect(typingOutcomeReceipt(base, 'f', { kind: 'invalid', reason: 'malformed' })).toMatchObject({ code: 'classification_invalid', detail: { factId: 'f', reason: 'malformed' } });
    expect(typingOutcomeReceipt(base, 'f', { kind: 'threw' })).toMatchObject({ code: 'classification_invalid', detail: { factId: 'f', reason: 'classify_threw' } });
    expect(typingOutcomeReceipt(base, 'f', { kind: 'overflow_skip' })).toMatchObject({ code: 'context_overflow_skipped', detail: { factId: 'f' } });
    expect(typingOutcomeReceipt(base, 'f', { kind: 'unattempted' })).toBeNull();
    expect(typingOutcomeReceipt(base, 'f', { kind: 'accepted', okfType: 't', confidence: 1 })).toBeNull();
  });
  it('tallies', () => {
    const c = emptyTypingCounters();
    for (const o of [{ kind: 'abstain' }, { kind: 'low_confidence' }, { kind: 'threw' }, { kind: 'overflow_skip' }, { kind: 'unattempted' }, { kind: 'accepted', okfType: 't', confidence: 1 }] as const) tallyTypingOutcome(c, o as any);
    expect(c).toEqual({ asked: 5, typed: 0, abstained: 1, lowConfidence: 1, invalid: 1, skipped: 1, unattempted: 1 });
  });
  it('volunteeredTypeResolves honors folded spellings', () => {
    expect(volunteeredTypeResolves('T0', man(2))).toBe(true);
    expect(volunteeredTypeResolves('nope', man(2))).toBe(false);
    expect(volunteeredTypeResolves(undefined, man(2))).toBe(false);
  });
});
