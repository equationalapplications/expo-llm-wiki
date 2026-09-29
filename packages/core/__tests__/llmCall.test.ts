import { describe, it, expect, vi } from 'vitest';
import { callLlm } from '../src/utils/llmCall';
import { UsageMeter, WikiBudgetExhausted } from '../src/utils/usage';
import type { WikiDiagnostic, WikiOptions } from '../src/types';

const prompts = { systemPrompt: 'a'.repeat(40), userPrompt: 'b'.repeat(40) }; // 20 est. tokens
const ctx = { operation: 'librarian' as const, entityId: 'e1', trigger: 'call' as const };

describe('callLlm', () => {
  it('uses generateText with this-binding and estimates usage', async () => {
    const provider = {
      tag: 'p',
      async generateText(this: any) { expect(this.tag).toBe('p'); return 'x'.repeat(8); },
    };
    const meter = new UsageMeter(100);
    expect(await callLlm({ llmProvider: provider } as WikiOptions, { ...ctx, meter }, prompts)).toBe('xxxxxxxx');
    expect(meter.used).toBe(22);
    expect(meter.estimated).toBe(true);
  });

  it('prefers generateTextWithUsage and records reported usage', async () => {
    const generateText = vi.fn();
    const provider = {
      tag: 'p',
      generateText,
      async generateTextWithUsage(this: any) { expect(this.tag).toBe('p'); return { text: 'ok', usage: { inputTokens: 7, outputTokens: 3 } }; },
    };
    const meter = new UsageMeter();
    expect(await callLlm({ llmProvider: provider } as unknown as WikiOptions, { ...ctx, meter }, prompts)).toBe('ok');
    expect(generateText).not.toHaveBeenCalled();
    expect(meter.used).toBe(10);
    expect(meter.estimated).toBe(false);
  });

  it('falls back to estimates when reported usage is malformed', async () => {
    const provider = { generateText: vi.fn(), async generateTextWithUsage() { return { text: 'ok', usage: { inputTokens: -1, outputTokens: 2 } }; } };
    const meter = new UsageMeter();
    await callLlm({ llmProvider: provider } as unknown as WikiOptions, { ...ctx, meter }, prompts);
    expect(meter.estimated).toBe(true);
  });

  it('throws TypeError when generateTextWithUsage returns no string text', async () => {
    const provider = { generateText: vi.fn(), async generateTextWithUsage() { return { text: 5 } as any; } };
    await expect(callLlm({ llmProvider: provider } as unknown as WikiOptions, ctx, prompts)).rejects.toThrow(TypeError);
  });

  it('throws WikiBudgetExhausted before calling the provider when the prompt does not fit', async () => {
    const generateText = vi.fn(async () => 'x');
    const meter = new UsageMeter(19);
    await expect(callLlm({ llmProvider: { generateText } } as WikiOptions, { ...ctx, meter }, prompts)).rejects.toBeInstanceOf(WikiBudgetExhausted);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('emits llm_usage only when config.reportLlmUsage is true', async () => {
    const diags: WikiDiagnostic[] = [];
    const base = { llmProvider: { generateText: async () => 'x' }, onDiagnostic: (d: WikiDiagnostic) => diags.push(d) };
    await callLlm(base as WikiOptions, ctx, prompts);
    expect(diags).toEqual([]);
    await callLlm({ ...base, config: { reportLlmUsage: true } } as WikiOptions, ctx, prompts);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      code: 'llm_usage', severity: 'info', operation: 'librarian', entityId: 'e1',
      detail: { inputTokens: 20, outputTokens: 1, estimated: true },
    });
  });
});