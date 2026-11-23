import { describe, expect, it, vi } from 'vitest';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import { createWiki } from '../../src/index';
import { callClassify } from '../../src/utils/llmCall';
import { estimateTokens, UsageMeter, WikiBudgetExhausted } from '../../src/utils/usage';
import { withConcurrency } from '../../src/utils/pure';
import { buildTypingQuestion, classifyFactsForWrite } from '../../src/services/typing/typeOnWrite';
import type { ClassifyRequest, ClassifyResponse, OntologyManifest, WikiOptions } from '../../src/types';

// specs/meter-reservation Test plan 3 and 4 (issue #475 probe): budget 250,
// input estimate 60, provider-reported 60 in + 50 out = 110 per call.

const PREFIX = 'llm_wiki_';
const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [],
};
const ctxFor = (meter: UsageMeter) => ({ operation: 'ontologyBackfill' as const, entityId: 'e1', trigger: 'call' as const, meter });
const estimateOf = (r: ClassifyRequest) => estimateTokens(r.state) + estimateTokens(JSON.stringify(r.questions));
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Fake classify: counts calls, holds every admitted call in flight (barrier), reports estimate in + 50 out. */
function fakeProvider() {
  const calls: ClassifyRequest[] = [];
  const classify = vi.fn(async (req: ClassifyRequest): Promise<ClassifyResponse> => {
    calls.push(req);
    await tick();
    return {
      answers: { okf_type: { kind: 'choice', choice: 'person', confidence: 0.9, probabilities: { person: 0.9 } } },
      usage: { inputTokens: estimateOf(req), outputTokens: 50 },
    } as ClassifyResponse;
  });
  return { calls, classify };
}

/** A request whose input estimate is exactly `target` tokens. */
function requestWithEstimate(target: number): ClassifyRequest {
  const questions = { q: { kind: 'binary' as const, instructions: 'y' } };
  const rest = target - estimateTokens(JSON.stringify(questions));
  const req = { state: 'x'.repeat(rest * 4), questions } as ClassifyRequest;
  expect(estimateOf(req)).toBe(target);
  return req;
}

describe('meter reservation: the issue #475 probe', () => {
  const probeClassify = async (req: ClassifyRequest) => {
    await tick();
    return { answers: {}, usage: { inputTokens: 60, outputTokens: 50 } } as unknown as ClassifyResponse;
  };

  async function runProbe(concurrency: number) {
    const classify = vi.fn(probeClassify);
    const options = { llmProvider: { generateText: async () => '', classify }, config: {} } as unknown as WikiOptions;
    const meter = new UsageMeter(250);
    const req = requestWithEstimate(60);
    let stopped = false;
    await withConcurrency(
      Array.from({ length: 12 }, () => async () => {
        if (stopped) return;
        try {
          await callClassify(options, ctxFor(meter), req);
        } catch (err) {
          if (err instanceof WikiBudgetExhausted) stopped = true;
          else throw err;
        }
      }),
      concurrency,
    );
    return { calls: classify.mock.calls.length, meter };
  }

  it('concurrency 4 spends what concurrency 1 does (2 calls, 220), not 5 calls / 550', async () => {
    const { calls, meter } = await runProbe(4);
    expect(calls).toBe(2);
    expect(meter.used).toBe(220);
  });

  it('every reserve is paired with a settle or release (no leak), and refusals do not count as reserves', async () => {
    const reserve = vi.spyOn(UsageMeter.prototype, 'reserve');
    const settle = vi.spyOn(UsageMeter.prototype, 'settle');
    const release = vi.spyOn(UsageMeter.prototype, 'release');
    try {
      const { meter } = await runProbe(4);
      const admitted = reserve.mock.results.filter((r) => r.type === 'return').length;
      expect(admitted).toBe(settle.mock.calls.length + release.mock.calls.length);
      expect(meter.reserved).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('a budget below the input estimate is refused at both concurrencies; estimate <= budget < hold admits a solo call', async () => {
    const options = { llmProvider: { generateText: async () => '', classify: vi.fn(probeClassify) }, config: {} } as unknown as WikiOptions;
    for (const _c of [1, 4]) {
      const err = await callClassify(options, ctxFor(new UsageMeter(59)), requestWithEstimate(60)).catch((e) => e);
      expect(err).toBeInstanceOf(WikiBudgetExhausted);
      expect(err.requiredEstimate).toBe(60);
    }
    await expect(callClassify(options, ctxFor(new UsageMeter(100)), requestWithEstimate(60))).resolves.toBeDefined();
  });

  it('default path pin: concurrency 1 spends 2 calls / 220 and refuses the third with (60, 30)', async () => {
    const { calls, meter } = await runProbe(1);
    expect(calls).toBe(2);
    expect(meter.used).toBe(220);
    expect(meter.estimated).toBe(false);
    expect(meter.remaining).toBe(30);
    const options = { llmProvider: { generateText: async () => '', classify: vi.fn() }, config: {} } as unknown as WikiOptions;
    const err = await callClassify(options, ctxFor(meter), requestWithEstimate(60)).catch((e) => e);
    expect(err).toBeInstanceOf(WikiBudgetExhausted);
    expect(err.requiredEstimate).toBe(60);
    expect(err.remaining).toBe(30);
  });
});

describe('meter reservation: through classifyFactsForWrite', () => {
  async function run(concurrency: number) {
    const { calls, classify } = fakeProvider();
    const options = { llmProvider: { generateText: async () => '', classify }, config: { chunkConcurrency: concurrency } } as unknown as WikiOptions;
    const facts = Array.from({ length: 12 }, (_, i) => ({ id: `f${String(i).padStart(2, '0')}`, title: 'fact', body: 'body' }));
    // Learn this question's input estimate e, then budget so two calls fit sequentially and a third does not.
    const probe = fakeProvider();
    await classifyFactsForWrite(
      { llmProvider: { generateText: async () => '', classify: probe.classify }, config: {} } as unknown as WikiOptions,
      { entityId: 'e1', trigger: 'call', operation: 'librarian' }, facts.slice(0, 1) as any, MANIFEST, 0.5,
    );
    const e = estimateOf(probe.calls[0]);
    expect(buildTypingQuestion(MANIFEST)).toBeTruthy();
    const meter = new UsageMeter(3 * e + 99);
    const outcomes = await classifyFactsForWrite(options, { entityId: 'e1', trigger: 'call', operation: 'librarian', meter }, facts as any, MANIFEST, 0.5);
    return { calls: calls.length, meter, outcomes, e };
  }

  it('concurrency 4 asks 2 facts and spends 2 x (e + 50), like concurrency 1', async () => {
    const seq = await run(1);
    expect(seq.calls).toBe(2);
    const par = await run(4);
    expect(par.calls).toBe(2);
    expect(par.meter.used).toBe(seq.meter.used);
    expect(par.outcomes.filter((o) => o.kind === 'unattempted')).toHaveLength(10);
  });
});

describe('meter reservation: through runOntologyBackfill', () => {
  async function makeWiki(concurrency: number) {
    const db = openTestDatabase();
    const { calls, classify } = fakeProvider();
    const wiki = createWiki(db, { llmProvider: { generateText: vi.fn(async () => '{}'), classify }, config: { chunkConcurrency: concurrency } });
    await wiki.setup();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    for (let i = 0; i < 12; i++) {
      const id = `f${String(i).padStart(2, '0')}`;
      await db.runAsync(
        `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, access_count)
         VALUES (?, 'e1', ?, ?, '[]', 'certain', 'user_stated', ?, ?, 0)`,
        [id, id, `${id} body`, 100 + i, 100 + i],
      );
    }
    return { wiki, calls };
  }

  async function run(concurrency: number) {
    const probe = await makeWiki(1); // unbounded run on a twin store: learn the per-call input estimate e
    await probe.wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    const e = estimateOf(probe.calls[0]);
    const { wiki, calls } = await makeWiki(concurrency);
    const result = await wiki.runOntologyBackfill('e1', { classifier: 'auto', tokenBudget: 3 * e + 99 });
    return { calls: calls.length, result };
  }

  it('concurrency 4 matches concurrency 1: 2 calls, budgetStop set, rest remaining', async () => {
    const seq = await run(1);
    expect(seq.calls).toBe(2);
    expect(seq.result.budgetStop).toBeDefined();
    const par = await run(4);
    expect(par.calls).toBe(2);
    expect(par.result.budgetStop).toBeDefined();
    expect(par.result.scanned).toBe(seq.result.scanned);
    expect(par.result.remaining).toBe(seq.result.remaining);
  });
});
