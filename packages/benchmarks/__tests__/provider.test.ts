import { describe, it, expect, vi } from 'vitest';
import { createProvider, endpointFromEnv } from '../src/provider';
import { instrument, UsageRecorder, classifyCallSite } from '../src/instrument';

const anth = { protocol: 'anthropic' as const, baseUrl: 'https://api.z.ai/api/anthropic/', apiKey: 'k', model: 'm' };
const oai = { protocol: 'openai' as const, baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'm' };
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status });

describe('createProvider (anthropic, default)', () => {
  it('posts a Messages request and reads text blocks and usage', async () => {
    const fetchImpl = vi.fn(async () => json({ content: [{ type: 'text', text: 'hi' }, { type: 'text', text: ' there' }], usage: { input_tokens: 7, output_tokens: 2 } }));
    const p = createProvider(anth, fetchImpl as any);
    expect(await p.generateTextWithUsage({ systemPrompt: 's', userPrompt: 'u' })).toEqual({ text: 'hi there', usage: { inputTokens: 7, outputTokens: 2 } });
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe('https://api.z.ai/api/anthropic/v1/messages');
    expect(init.headers['x-api-key']).toBe('k');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(init.body)).toMatchObject({ model: 'm', temperature: 0, system: 's', messages: [{ role: 'user', content: 'u' }] });
  });
  it('retries 429 then succeeds', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('slow down', { status: 429 })).mockResolvedValueOnce(json({ content: [{ type: 'text', text: 'ok' }] }));
    const r = createProvider(anth, fetchImpl as any).generateText({ systemPrompt: 's', userPrompt: 'u' });
    await vi.runAllTimersAsync();
    expect(await r).toBe('ok');
    vi.useRealTimers();
  });
  it('throws on 401 without retry and never leaks the key', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad key', { status: 401 }));
    const err = await createProvider(anth, fetchImpl as any).generateText({ systemPrompt: 's', userPrompt: 'u' }).catch((e) => e);
    expect(String(err.message)).toContain('HTTP 401');
    expect(String(err.message)).not.toContain('k"');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes an abort signal on every request so a hung connection cannot stall forever', async () => {
    const signals: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      signals.push(init?.signal);
      return json({ content: [{ type: 'text', text: 'ok' }] });
    });
    await createProvider(anth, fetchImpl as any).generateText({ systemPrompt: 's', userPrompt: 'u' });
    expect(signals.length).toBe(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('retries a hung request (network error) then succeeds', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('This operation was aborted'))
      .mockResolvedValueOnce(json({ content: [{ type: 'text', text: 'ok' }] }));
    const r = createProvider(anth, fetchImpl as any).generateText({ systemPrompt: 's', userPrompt: 'u' });
    await vi.runAllTimersAsync();
    expect(await r).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('throws a wrapped, key-free error when every attempt hangs', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => {
      throw new Error('This operation was aborted');
    });
    const r = createProvider(anth, fetchImpl as any).generateText({ systemPrompt: 's', userPrompt: 'u' });
    const err = await vi.runAllTimersAsync().then(() => r.catch((e) => e));
    expect(String(err.message)).toContain('request failed after 5 attempts');
    expect(String(err.message)).not.toContain('k"');
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });
});

describe('createProvider (openai)', () => {
  it('posts chat completions and reads usage', async () => {
    const fetchImpl = vi.fn(async () => json({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } }));
    expect(await createProvider(oai, fetchImpl as any).generateTextWithUsage({ systemPrompt: 's', userPrompt: 'u' }))
      .toEqual({ text: 'hi', usage: { inputTokens: 7, outputTokens: 2 } });
    expect((fetchImpl.mock.calls[0] as any)[0]).toBe('https://x.test/v1/chat/completions');
  });
});

describe('endpointFromEnv', () => {
  it('defaults to Z.AI anthropic with ZAI_API_KEY; judge falls back to BENCH_*', () => {
    const env = { ZAI_API_KEY: 'z' };
    expect(endpointFromEnv('BENCH', env)).toEqual({ protocol: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'z', model: 'GLM-5.3-FLASH' });
    expect(endpointFromEnv('BENCH_JUDGE', { ...env, BENCH_MODEL: 'a', BENCH_JUDGE_MODEL: 'j' }).model).toBe('j');
    expect(endpointFromEnv('BENCH_JUDGE', { ...env, BENCH_MODEL: 'a' }).model).toBe('a');
  });
  it('throws without any key', () => {
    expect(() => endpointFromEnv('BENCH', {})).toThrow('ZAI_API_KEY');
  });
});

describe('instrument', () => {
  it('classifies and records provider usage, estimating when absent', async () => {
    const rec = new UsageRecorder();
    const inner = { generateText: async () => 'abcd', generateTextWithUsage: async () => ({ text: 'x', usage: { inputTokens: 5, outputTokens: 1 } }) };
    const p = instrument(inner, rec);
    await p.generateTextWithUsage({ systemPrompt: 'You are a memory grooming agent.', userPrompt: 'u' });
    const onlyText = instrument({ generateText: async () => 'abcd' }, rec, 'answer');
    await onlyText.generateText({ systemPrompt: 'a'.repeat(8), userPrompt: '' });
    const t = rec.totals();
    expect(t.heal).toMatchObject({ calls: 1, inputTokens: 5, outputTokens: 1, estimatedCalls: 0 });
    expect(t.answer).toMatchObject({ calls: 1, inputTokens: 2, outputTokens: 1, estimatedCalls: 1 });
  });
  it('classifyCallSite', () => {
    expect(classifyCallSite('You are a knowledge extraction agent.')).toBe('librarian');
    expect(classifyCallSite('You are a memory extraction agent.')).toBe('extract');
    expect(classifyCallSite('You are a memory reconciliation agent.')).toBe('resolve');
    expect(classifyCallSite('Something else')).toBe('other');
  });
});