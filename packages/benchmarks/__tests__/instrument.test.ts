import { describe, expect, it } from 'vitest';
import { UsageRecorder, instrument } from '../src/instrument';

const inner = {
  generateText: async () => 'ok',
  classify: async () => ({ answers: { q: { kind: 'binary', probability: 0.9 } }, usage: { inputTokens: 10, outputTokens: 2 } }),
};

describe('instrument classify wrap', () => {
  it('records classify calls under the classify bucket with non-zero tokens and ms', async () => {
    const recorder = new UsageRecorder();
    const provider = instrument(inner as any, recorder);
    await provider.classify!({ state: 's', questions: {} } as any);
    const b = recorder.totals().classify;
    expect(b.calls).toBe(1);
    expect(b.inputTokens).toBe(10);
    expect(b.outputTokens).toBe(2);
    expect(b.ms).toBeGreaterThanOrEqual(0);
  });
  it('estimates when the inner classify reports no usage', async () => {
    const recorder = new UsageRecorder();
    const provider = instrument({ generateText: async () => 'ok', classify: async () => ({ answers: {} }) } as any, recorder);
    await provider.classify!({ state: 'abcd', questions: {} } as any);
    expect(recorder.totals().classify.estimatedCalls).toBe(1);
    expect(recorder.totals().classify.inputTokens).toBe(2); // ceil(4/4) + ceil(len('{}')/4)
  });
});
