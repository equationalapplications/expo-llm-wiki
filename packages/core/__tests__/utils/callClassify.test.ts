import { describe, expect, it } from 'vitest';
import { callClassify } from '../../src/utils/llmCall';
import { UsageMeter, WikiBudgetExhausted } from '../../src/utils/usage';
import type { WikiOptions } from '../../src/types';

function optsWith(provider: any, reportLlmUsage = false): WikiOptions {
  return { llmProvider: provider, config: { reportLlmUsage } } as unknown as WikiOptions;
}
const request = { state: 'x'.repeat(400), questions: { q: { kind: 'binary' as const, instructions: 'y'.repeat(100) } } };

describe('callClassify', () => {
  it('prefers provider-reported usage and records it on the meter', async () => {
    const provider = { classify: async () => ({ answers: { q: { kind: 'binary', probability: 0.9 } }, usage: { inputTokens: 111, outputTokens: 22 } }) };
    const meter = new UsageMeter(undefined);
    const res = await callClassify(optsWith(provider), { operation: 'ontologyBackfill', entityId: 'e1', trigger: 'call', meter }, request);
    expect(res.usage).toEqual({ inputTokens: 111, outputTokens: 22 });
    // UsageMeter exposes only the combined total (`used`) and an `estimated` flag.
    expect(meter.used).toBe(111 + 22);
    expect(meter.estimated).toBe(false);
  });

  it('falls back to chars/4 estimates when usage is absent', async () => {
    const answers = { q: { kind: 'binary', probability: 0.5 } };
    const provider = { classify: async () => ({ answers }) };
    const meter = new UsageMeter(undefined);
    await callClassify(optsWith(provider), { operation: 'ontologyBackfill', entityId: 'e1', trigger: 'call', meter }, request);
    const inputEstimate = Math.ceil(request.state.length / 4) + Math.ceil(JSON.stringify(request.questions).length / 4);
    const outputEstimate = Math.ceil(JSON.stringify(answers).length / 4);
    expect(meter.used).toBe(inputEstimate + outputEstimate);
    expect(meter.estimated).toBe(true);
  });

  it('ignores malformed usage and estimates instead', async () => {
    const provider = { classify: async () => ({ answers: {}, usage: { inputTokens: -5 } }) };
    const meter = new UsageMeter(undefined);
    await callClassify(optsWith(provider), { operation: 'ontologyBackfill', entityId: 'e1', trigger: 'call', meter }, request);
    expect(meter.estimated).toBe(true); // estimated, not the bogus -5
    expect(meter.used).toBeGreaterThan(0);
  });

  it('pre-flight throws WikiBudgetExhausted when the meter cannot fit', async () => {
    const provider = { classify: async () => ({ answers: {} }) };
    const meter = new UsageMeter(1); // 1-token budget; the estimate cannot fit
    await expect(callClassify(optsWith(provider), { operation: 'ontologyBackfill', entityId: 'e1', trigger: 'call', meter }, request))
      .rejects.toBeInstanceOf(WikiBudgetExhausted);
  });
});
