import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    // Pre-attach the rejection handler so the unhandled-rejection monitor
    // never observes r settling before its handler is in place (vitest 5
    // would otherwise fail the run with a PromiseRejectionHandledWarning).
    const r = createProvider(anth, fetchImpl as any).generateText({ systemPrompt: 's', userPrompt: 'u' }).catch((e) => e);
    const err = await vi.runAllTimersAsync().then(() => r);
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

describe('classifier endpoint and context tokens (BENCH_CLASSIFIER_*, BENCH_CONTEXT_TOKENS)', () => {
  beforeEach(() => {
    // '' is falsy at the URL/KEY truthiness checks and falsy-checked CONTEXT parse,
    // so those behave as unset; MODEL is read with ?? (nullish), so it must be
    // DELETED, not blanked — vi.stubEnv(name, undefined) removes the variable.
    vi.stubEnv('BENCH_CLASSIFIER_URL', '');
    vi.stubEnv('BENCH_CLASSIFIER_KEY', '');
    vi.stubEnv('BENCH_CONTEXT_TOKENS', '');
    vi.stubEnv('BENCH_CLASSIFIER_MODEL', undefined as unknown as string);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  const req: any = { state: 's', questions: [{ id: 'q1' }] };
  const mkClassify = (body: object, env: Record<string, string> = {}) => {
    vi.stubEnv('BENCH_CLASSIFIER_URL', 'https://cls.test/classify');
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const fetchImpl = vi.fn(async () => json(body));
    return { fetchImpl, p: createProvider(anth, fetchImpl as any) };
  };

  it('posts the ClassifyRequest with model folded in, to BENCH_CLASSIFIER_URL', async () => {
    const { fetchImpl, p } = mkClassify({ answers: { q1: 'a' } });
    expect(p.classify).toBeDefined();
    expect(await p.classify!(req)).toEqual({ answers: { q1: 'a' }, usage: undefined });
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe('https://cls.test/classify');
    expect(JSON.parse(init.body)).toEqual({ ...req, model: 'm' });
    expect(init.headers.authorization).toBeUndefined();
  });
  it('BENCH_CLASSIFIER_MODEL overrides the model; BENCH_CLASSIFIER_KEY adds a bearer header', async () => {
    const { fetchImpl, p } = mkClassify({ answers: {} }, { BENCH_CLASSIFIER_MODEL: 'cm', BENCH_CLASSIFIER_KEY: 'sek' });
    await p.classify!(req);
    const [, init] = fetchImpl.mock.calls[0] as any;
    expect(JSON.parse(init.body).model).toBe('cm');
    expect(init.headers.authorization).toBe('Bearer sek');
  });
  it('is absent when BENCH_CLASSIFIER_URL is unset', () => {
    expect(createProvider(anth, vi.fn() as any).classify).toBeUndefined();
  });
  it.each([
    ['{}', {}],
    ['non-object answers', { answers: 'x' }],
    ['array answers', { answers: [] }],
    ['chat-completions shape', { choices: [{ message: { content: 'hi' } }] }],
  ])('rejects a contract-violating response: %s', async (_n, body) => {
    const { p } = mkClassify(body);
    await expect(p.classify!(req)).rejects.toThrow(/missing `answers` object/);
  });
  it.each([
    ['prompt/completion_tokens', { prompt_tokens: 3, completion_tokens: 4 }, { inputTokens: 3, outputTokens: 4 }],
    ['explicit input/outputTokens', { inputTokens: 5, outputTokens: 6 }, { inputTokens: 5, outputTokens: 6 }],
    ['partial (input only)', { inputTokens: 5 }, undefined],
    ['partial (completion only)', { completion_tokens: 5 }, undefined],
    ['negative values', { inputTokens: -1, outputTokens: 2 }, undefined],
  ])('usage normalization: %s', async (_n, usage, expected) => {
    const { p } = mkClassify({ answers: {}, usage });
    expect((await p.classify!(req)).usage).toEqual(expected);
  });

  it('BENCH_CONTEXT_TOKENS: valid value is passed through', () => {
    vi.stubEnv('BENCH_CONTEXT_TOKENS', '8192');
    expect(createProvider(anth, vi.fn() as any).contextTokens).toBe(8192);
  });
  it('BENCH_CONTEXT_TOKENS: unset is undefined', () => {
    expect(createProvider(anth, vi.fn() as any).contextTokens).toBeUndefined();
  });
  it.each(['abc', '0', '-5'])('BENCH_CONTEXT_TOKENS=%s is ignored without throwing', (v) => {
    vi.stubEnv('BENCH_CONTEXT_TOKENS', v);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createProvider(anth, vi.fn() as any).contextTokens).toBeUndefined();
  });
});
