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

// ---- Test plan 4: default-path equivalence against an in-test copy of the old meter ----

/** Verbatim copy of the pre-#475 UsageMeter and the old wrapper's check-then-charge sequence. */
class OldMeter {
  used = 0;
  estimated = false;
  constructor(readonly budget?: number) {}
  get remaining() { return this.budget === undefined ? Infinity : Math.max(0, this.budget - this.used); }
  fits(e: number) { return e <= this.remaining; }
  record(r: { inputTokens: number; outputTokens: number; estimated: boolean }) {
    this.used += r.inputTokens + r.outputTokens;
    if (r.estimated) this.estimated = true;
  }
}

describe('meter reservation: concurrency-1 equivalence with the old meter', () => {
  type Step = { estimate: number; usage?: { i: number; o: number; estimated: boolean }; throws?: boolean };
  const u = (i: number, o: number, estimated = false) => ({ i, o, estimated });
  const table: Array<{ name: string; budget: number | undefined; steps: Step[] }> = [
    { name: 'unbounded', budget: undefined, steps: [{ estimate: 1e6, usage: u(5, 5) }] },
    { name: 'exact fit then refuse', budget: 100, steps: [{ estimate: 60, usage: u(60, 40) }, { estimate: 1, usage: u(1, 1) }] },
    { name: 'probe 250 / 60 / 110', budget: 250, steps: Array.from({ length: 4 }, () => ({ estimate: 60, usage: u(60, 50) })) },
    { name: 'estimated usage flag', budget: 500, steps: [{ estimate: 10, usage: u(10, 3, true) }, { estimate: 10, usage: u(10, 3) }] },
    { name: 'provider throws charge nothing', budget: 100, steps: [{ estimate: 60, throws: true }, { estimate: 60, usage: u(60, 10) }] },
    { name: 'actual above budget', budget: 100, steps: [{ estimate: 50, usage: u(50, 300) }, { estimate: 1, usage: u(1, 1) }] },
    { name: 'estimate above whole budget', budget: 50, steps: [{ estimate: 51, usage: u(51, 1) }] },
    { name: 'zero budget', budget: 0, steps: [{ estimate: 0, usage: u(0, 0) }, { estimate: 1, usage: u(1, 0) }] },
  ];

  for (const row of table) {
    it(row.name, () => {
      const oldM = new OldMeter(row.budget);
      const newM = new UsageMeter(row.budget);
      for (const step of row.steps) {
        // old: check, charge
        let oldErr: WikiBudgetExhausted | undefined;
        if (!oldM.fits(step.estimate)) oldErr = new WikiBudgetExhausted(step.estimate, oldM.remaining);
        else if (!step.throws) oldM.record({ inputTokens: step.usage!.i, outputTokens: step.usage!.o, estimated: step.usage!.estimated });
        // new: reserve, settle/release (hold = 2x estimate, as callClassify)
        let newErr: WikiBudgetExhausted | undefined;
        try {
          const h = newM.reserve(step.estimate, step.estimate * 2);
          if (step.throws) newM.release(h);
          else newM.settle(h, { inputTokens: step.usage!.i, outputTokens: step.usage!.o, estimated: step.usage!.estimated });
        } catch (e) {
          newErr = e as WikiBudgetExhausted;
        }
        expect(newErr?.requiredEstimate).toBe(oldErr?.requiredEstimate);
        expect(newErr?.remaining).toBe(oldErr?.remaining);
        expect(newErr?.message).toBe(oldErr?.message);
        expect(newM.used).toBe(oldM.used);
        expect(newM.estimated).toBe(oldM.estimated);
        expect(newM.remaining).toBe(oldM.remaining);
        expect(newM.reserved).toBe(0);
      }
    });
  }
});

describe('meter reservation: default-config runPendingMaintenance pin', () => {
  // Inline snapshots were recorded on the pre-change meter (commit 794315f4's src) and must not change.
  const BUDGET_MID = 500;
  async function run(tokenBudget?: number) {
    const db = openTestDatabase();
    const diags: any[] = [];
    const generateText = vi.fn(async () => JSON.stringify({ facts: [], tasks: [] }));
    const wiki = createWiki(db, {
      llmProvider: { generateText },
      config: { maintenance: 'deferred', librarian: { strategy: 'ops' }, reportLlmUsage: true },
      onDiagnostic: (d: any) => diags.push(d),
    } as any);
    await wiki.setup();
    for (const id of ['a', 'b', 'c']) await wiki.write(id, { event_type: 'observation', summary: `hello ${id} `.repeat(20) });
    const r = await wiki.runPendingMaintenance({ tokenBudget });
    return {
      tokensUsed: r.tokensUsed, estimated: r.estimated, remaining: r.remaining, stoppedReason: r.stoppedReason,
      perEntity: r.perEntity,
      diag: diags.map((d) => [d.code, d.operation, d.entityId, d.detail]),
    };
  }

  it('unbounded', async () => {
    expect(await run()).toMatchInlineSnapshot(`
      {
        "diag": [
          [
            "llm_usage",
            "librarian",
            "a",
            {
              "estimated": true,
              "inputTokens": 222,
              "outputTokens": 6,
            },
          ],
          [
            "librarian_gate",
            "librarian",
            "a",
            {
              "gateAdd": 0,
              "gateAmbiguous": 0,
              "gateNoop": 0,
            },
          ],
          [
            "llm_usage",
            "librarian",
            "b",
            {
              "estimated": true,
              "inputTokens": 222,
              "outputTokens": 6,
            },
          ],
          [
            "librarian_gate",
            "librarian",
            "b",
            {
              "gateAdd": 0,
              "gateAmbiguous": 0,
              "gateNoop": 0,
            },
          ],
          [
            "llm_usage",
            "librarian",
            "c",
            {
              "estimated": true,
              "inputTokens": 222,
              "outputTokens": 6,
            },
          ],
          [
            "librarian_gate",
            "librarian",
            "c",
            {
              "gateAdd": 0,
              "gateAmbiguous": 0,
              "gateNoop": 0,
            },
          ],
        ],
        "estimated": true,
        "perEntity": [
          {
            "entityId": "a",
            "factsWritten": 0,
            "healPasses": 0,
            "librarianPasses": 1,
            "ontologyBackfillPasses": 0,
            "reembedded": false,
            "typed": 0,
          },
          {
            "entityId": "b",
            "factsWritten": 0,
            "healPasses": 0,
            "librarianPasses": 1,
            "ontologyBackfillPasses": 0,
            "reembedded": false,
            "typed": 0,
          },
          {
            "entityId": "c",
            "factsWritten": 0,
            "healPasses": 0,
            "librarianPasses": 1,
            "ontologyBackfillPasses": 0,
            "reembedded": false,
            "typed": 0,
          },
        ],
        "remaining": null,
        "stoppedReason": {
          "reason": "complete",
        },
        "tokensUsed": 684,
      }
    `);
  });
  it('bounded, exhausted mid-run', async () => {
    expect(await run(BUDGET_MID)).toMatchInlineSnapshot(`
      {
        "diag": [
          [
            "llm_usage",
            "librarian",
            "a",
            {
              "estimated": true,
              "inputTokens": 222,
              "outputTokens": 6,
            },
          ],
          [
            "librarian_gate",
            "librarian",
            "a",
            {
              "gateAdd": 0,
              "gateAmbiguous": 0,
              "gateNoop": 0,
            },
          ],
        ],
        "estimated": true,
        "perEntity": [
          {
            "entityId": "a",
            "factsWritten": 0,
            "healPasses": 0,
            "librarianPasses": 1,
            "ontologyBackfillPasses": 0,
            "reembedded": false,
            "typed": 0,
          },
          {
            "entityId": "b",
            "factsWritten": 0,
            "healPasses": 0,
            "librarianPasses": 0,
            "ontologyBackfillPasses": 0,
            "reembedded": false,
            "typed": 0,
          },
          {
            "entityId": "c",
            "factsWritten": 0,
            "healPasses": 0,
            "librarianPasses": 0,
            "ontologyBackfillPasses": 0,
            "reembedded": false,
            "typed": 0,
          },
        ],
        "remaining": 272,
        "stoppedReason": {
          "reason": "budget_exhausted",
        },
        "tokensUsed": 228,
      }
    `);
  });
  it('bounded, too small', async () => {
    expect(await run(5)).toMatchInlineSnapshot(`
      {
        "diag": [],
        "estimated": false,
        "perEntity": [
          {
            "entityId": "a",
            "factsWritten": 0,
            "healPasses": 0,
            "librarianPasses": 0,
            "ontologyBackfillPasses": 0,
            "reembedded": false,
            "typed": 0,
          },
          {
            "entityId": "b",
            "factsWritten": 0,
            "healPasses": 0,
            "librarianPasses": 0,
            "ontologyBackfillPasses": 0,
            "reembedded": false,
            "typed": 0,
          },
          {
            "entityId": "c",
            "factsWritten": 0,
            "healPasses": 0,
            "librarianPasses": 0,
            "ontologyBackfillPasses": 0,
            "reembedded": false,
            "typed": 0,
          },
        ],
        "remaining": 5,
        "stoppedReason": {
          "entityId": "a",
          "job": "librarian",
          "reason": "budget_too_small",
          "requiredEstimate": 444,
        },
        "tokensUsed": 0,
      }
    `);
  });
});

// ---- Test plan 7: stop classification at concurrency 4 ----

describe('meter reservation: stop classification', () => {
  it('requiredEstimate is the call own estimate, never the hold; remaining is unreserved', async () => {
    const options = { llmProvider: { generateText: async () => '', classify: vi.fn() }, config: {} } as unknown as WikiOptions;
    const meter = new UsageMeter(250);
    meter.reserve(60, 240); // in-flight call holding 2x
    const err = await callClassify(options, ctxFor(meter), requestWithEstimate(60)).catch((e) => e);
    expect(err).toBeInstanceOf(WikiBudgetExhausted);
    expect(err.requiredEstimate).toBe(60);
    expect(err.requiredEstimate).not.toBe(120);
    expect(err.remaining).toBe(10);
    expect(err.requiredEstimate).toBeLessThanOrEqual(250); // within the whole budget: budget_exhausted, not too_small
  });

  it('runPendingMaintenance at chunkConcurrency 4 with a bounded budget: exhausted by in-flight holds is budget_exhausted, never budget_too_small', { timeout: 120000 }, async () => {
    const classify = async (r: ClassifyRequest): Promise<ClassifyResponse> => {
      await tick();
      return {
        answers: { okf_type: { kind: 'choice', choice: 'person', confidence: 0.9, probabilities: { person: 0.9 } } },
        usage: { inputTokens: estimateOf(r), outputTokens: 50 },
      } as ClassifyResponse;
    };
    const facts = Array.from({ length: 12 }, (_, i) => ({ title: `Fact ${String(i).padStart(2, '0')}`, body: 'b', tags: [], confidence: 'certain', source_event: 'e1' }));
    const run = async (budget?: number) => {
      const db = openTestDatabase();
      const wiki = createWiki(db, {
        llmProvider: { generateText: async () => JSON.stringify({ facts, tasks: [] }), classify },
        config: { autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' }, systemOne: { typeOnWrite: 'auto' }, chunkConcurrency: 4 },
      } as any);
      await wiki.setup();
      await wiki.setOntologyManifest('u', MANIFEST, { mode: 'strict' });
      await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at, occurred_at) VALUES ('evt_1','u','observation','x',100,90)`);
      return wiki.runPendingMaintenance({ jobs: ['librarian'], tokenBudget: budget });
    };
    const full = await run();
    expect(full.stoppedReason.reason).toBe('complete');
    let exhausted = 0;
    for (const budget of [full.tokensUsed - 1, full.tokensUsed - 150, full.tokensUsed - 400, full.tokensUsed - 800]) {
      const r = await run(budget);
      expect(r.stoppedReason.reason).toBe('budget_exhausted');
      expect(r.tokensUsed).toBeLessThanOrEqual(budget + 0); // holds stop concurrent calls from overshooting this budget
      exhausted++;
    }
    expect(exhausted).toBe(4);
    const tiny = await run(1);
    expect(tiny.stoppedReason.reason).toBe('budget_too_small');
  });
});

// ---- Test plan 8: settle / release through the provider path ----

describe('meter reservation: provider paths', () => {
  it('a classify provider that throws after the reservation releases the hold and charges nothing', async () => {
    const meter = new UsageMeter(250);
    const classify = vi.fn(async () => {
      expect(meter.reserved).toBe(120); // hold is live while the provider runs
      throw new Error('boom');
    });
    const options = { llmProvider: { generateText: async () => '', classify }, config: {} } as unknown as WikiOptions;
    await expect(callClassify(options, ctxFor(meter), requestWithEstimate(60))).rejects.toThrow('boom');
    expect(meter.reserved).toBe(0);
    expect(meter.used).toBe(0);
    expect(meter.remaining).toBe(250);
  });

  it('a provider reporting actual above the hold: actual is charged, remaining clamps at 0, the next call is refused', async () => {
    const meter = new UsageMeter(250);
    const classify = vi.fn(async () => ({ answers: {}, usage: { inputTokens: 100, outputTokens: 200 } }) as unknown as ClassifyResponse);
    const options = { llmProvider: { generateText: async () => '', classify }, config: {} } as unknown as WikiOptions;
    await callClassify(options, ctxFor(meter), requestWithEstimate(60)); // hold 120, actual 300
    expect(meter.used).toBe(300);
    expect(meter.reserved).toBe(0);
    expect(meter.remaining).toBe(0);
    await expect(callClassify(options, ctxFor(meter), requestWithEstimate(60))).rejects.toBeInstanceOf(WikiBudgetExhausted);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('through classifyFactsForWrite a throwing provider charges nothing and leaves no hold', async () => {
    const classify = vi.fn(async () => { throw new Error('boom'); });
    const options = { llmProvider: { generateText: async () => '', classify }, config: { chunkConcurrency: 4 } } as unknown as WikiOptions;
    const meter = new UsageMeter(1_000_000);
    const facts = Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, title: 'fact', body: 'body' }));
    const out = await classifyFactsForWrite(options, { entityId: 'e1', trigger: 'call', operation: 'librarian', meter }, facts as any, MANIFEST, 0.5);
    expect(out.every((o) => o.kind === 'threw')).toBe(true);
    expect([meter.reserved, meter.used]).toEqual([0, 0]);
  });
});
