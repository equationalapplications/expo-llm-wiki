/**
 * Anthropic / OpenAI-compatible chat-completion provider.
 *
 * Two protocols are supported:
 * - `anthropic`: POST /v1/messages with `x-api-key` and `anthropic-version`.
 * - `openai`: POST /chat/completions.
 *
 * Retries 429 / 529 / 5xx responses up to 4 times with 1s/2s/4s/8s backoff.
 * All other failures (including non-retryable 4xx) throw immediately and never
 * include the API key in the error message.
 */

export interface ChatEndpoint {
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface TextParams {
  systemPrompt: string;
  userPrompt: string;
}

export interface TextWithUsage {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ChatProvider {
  generateText(p: TextParams): Promise<string>;
  generateTextWithUsage(p: TextParams): Promise<TextWithUsage>;
}

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

const RETRY_STATUSES = new Set([429, 529, 500, 502, 503, 504]);
const BACKOFFS_MS = [1000, 2000, 4000, 8000];
const MAX_RETRIES = 4;

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function isRetryable(status: number): boolean {
  return RETRY_STATUSES.has(status);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWithRetry(url: string, init: { method: string; headers: Record<string, string>; body: string }, fetchImpl: FetchLike): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetchImpl(url, init);
    if (!isRetryable(response.status)) {
      return response;
    }
    lastResponse = response;
    if (attempt < MAX_RETRIES) {
      await sleep(BACKOFFS_MS[attempt]);
    }
  }
  // Exhausted retries — return the last (retryable) response so the caller can
  // surface the underlying error message.
  return lastResponse!;
}

function truncateBody(body: string): string {
  return body.length > 200 ? body.slice(0, 200) : body;
}

function errMessage(status: number, body: string): string {
  return `HTTP ${status}: ${truncateBody(body)}`;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface OpenAIResponse {
  choices: Array<{ message: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function anthropicProvider(ep: ChatEndpoint, fetchImpl: FetchLike): ChatProvider {
  const url = `${stripTrailingSlash(ep.baseUrl)}/v1/messages`;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': ep.apiKey,
    'authorization': `Bearer ${ep.apiKey}`,
    'anthropic-version': '2023-06-01',
  };

  async function call(params: TextParams): Promise<TextWithUsage> {
    const body = {
      model: ep.model,
      max_tokens: 4096,
      temperature: 0,
      system: params.systemPrompt,
      messages: [{ role: 'user', content: params.userPrompt }],
    };
    const response = await sendWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) }, fetchImpl);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(errMessage(response.status, text));
    }
    const data = (await response.json()) as AnthropicResponse;
    const text = (data.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text!)
      .join('');
    const usage = data.usage
      ? {
          inputTokens: data.usage.input_tokens ?? 0,
          outputTokens: data.usage.output_tokens ?? 0,
        }
      : undefined;
    return { text, usage };
  }

  return {
    generateText: (p) => call(p).then((r) => r.text),
    generateTextWithUsage: (p) => call(p),
  };
}

function openaiProvider(ep: ChatEndpoint, fetchImpl: FetchLike): ChatProvider {
  const url = `${stripTrailingSlash(ep.baseUrl)}/chat/completions`;
  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${ep.apiKey}`,
  };

  async function call(params: TextParams): Promise<TextWithUsage> {
    const body = {
      model: ep.model,
      temperature: 0,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userPrompt },
      ],
    };
    const response = await sendWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) }, fetchImpl);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(errMessage(response.status, text));
    }
    const data = (await response.json()) as OpenAIResponse;
    const text = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage
      ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
        }
      : undefined;
    return { text, usage };
  }

  return {
    generateText: (p) => call(p).then((r) => r.text),
    generateTextWithUsage: (p) => call(p),
  };
}

export function createProvider(ep: ChatEndpoint, fetchImpl: FetchLike = fetch): ChatProvider {
  if (ep.protocol === 'anthropic') return anthropicProvider(ep, fetchImpl);
  return openaiProvider(ep, fetchImpl);
}

// --------------------------------------------------------------------------
// Env resolution
// --------------------------------------------------------------------------

const DEFAULTS = {
  BENCH: {
    protocol: 'anthropic' as const,
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'GLM-5.3-FLASH',
  },
  BENCH_JUDGE: {
    protocol: 'anthropic' as const,
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'GLM-5.3-FLASH',
  },
};

export type EndpointPrefix = 'BENCH' | 'BENCH_JUDGE';

/**
 * Resolve a ChatEndpoint from environment variables.
 *
 * `BENCH_JUDGE_*` vars fall back to the `BENCH_*` values; both fall back to
 * `ZAI_API_KEY` for the credential. Throws if no key resolves.
 */
export function endpointFromEnv(prefix: EndpointPrefix, env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): ChatEndpoint {
  const def = DEFAULTS[prefix];
  const protocol = (env[`${prefix}_PROTOCOL`] ?? def.protocol) as ChatEndpoint['protocol'];
  const baseUrl = env[`${prefix}_BASE_URL`] ?? def.baseUrl;
  const model = env[`${prefix}_MODEL`] ?? (prefix === 'BENCH_JUDGE' ? env.BENCH_MODEL ?? def.model : def.model);
  const apiKey = env[`${prefix}_API_KEY`] ?? (prefix === 'BENCH_JUDGE' ? env.BENCH_API_KEY : undefined) ?? env.ZAI_API_KEY;
  if (!apiKey) {
    throw new Error('Set ZAI_API_KEY or BENCH_API_KEY');
  }
  return { protocol, baseUrl, apiKey, model };
}