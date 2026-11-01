import { randomUUID } from 'node:crypto';
import { OPERATIONS, type Operation, type OperationId } from './contract';
import { NO_KEY_MESSAGE, SynapseTreeError, UsageError } from './errors';

export const DEFAULT_BASE_URL = 'https://api.synapsetree.dev';

export interface ClientOptions {
  /** Optional only so `auth --email` can register and poll; every other operation needs it. */
  apiKey?: string;
  baseUrl: string;
  userAgent: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface CallInput {
  path?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  form?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface CallResult<T> {
  status: number;
  data: T;
  requestId?: string;
  rateLimit?: string;
  rateLimitPolicy?: string;
  idempotentReplayed: boolean;
}

const RETRY_STATUSES = new Set([408, 429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const TIMEOUTS: Partial<Record<OperationId, number>> = { ingestDocument: 120_000 };
const UNAUTHENTICATED: ReadonlySet<OperationId> = new Set(['registerAgentIdentity', 'oauthToken']);

function buildUrl(baseUrl: string, op: Operation, input: CallInput): string {
  let path = op.path;
  for (const name of op.pathParameters) {
    const value = input.path?.[name];
    if (value === undefined) throw new UsageError(`missing path parameter ${name} for ${op.operationId}`);
    path = path.replace(`{${name}}`, encodeURIComponent(value));
  }
  const url = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(input.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function retryAfterMs(res: Response, body: unknown): number | undefined {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const fromBody = (body as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
  return typeof fromBody === 'number' ? fromBody * 1000 : undefined;
}

async function readBody(res: Response): Promise<{ text: string; json: unknown; isProblem: boolean; isJson: boolean }> {
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  const isProblem = type.startsWith('application/problem+json');
  const isJson = isProblem || type.startsWith('application/json');
  let json: unknown;
  if (isJson && text.length > 0) {
    try { json = JSON.parse(text); } catch { json = undefined; }
  }
  return { text, json, isProblem, isJson: json !== undefined };
}

function toError(res: Response, parsed: { text: string; json: unknown; isProblem: boolean; isJson: boolean }): SynapseTreeError {
  const requestId = res.headers.get('request-id') ?? undefined;
  const body = (parsed.json ?? {}) as Record<string, unknown>;
  if (parsed.isProblem && typeof body.code === 'string') {
    return new SynapseTreeError({
      status: res.status,
      code: body.code,
      detail: typeof body.detail === 'string' ? body.detail : undefined,
      requestId: typeof body.requestId === 'string' ? body.requestId : requestId,
      retryAfterSeconds: typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : undefined,
    });
  }
  if (parsed.isJson && typeof body.error === 'string') {
    // RFC 6749 §5.2 body from the OAuth endpoints
    return new SynapseTreeError({ status: res.status, code: body.error, detail: typeof body.error_description === 'string' ? body.error_description : undefined, requestId });
  }
  if (res.status === 401 || res.status === 403) {
    return new SynapseTreeError({ status: res.status, code: 'unauthorized', detail: parsed.text.slice(0, 500) || undefined, requestId });
  }
  return new SynapseTreeError({ status: res.status, code: `http_${res.status}`, detail: parsed.text.slice(0, 500) || undefined, requestId });
}

export class SynapseTreeClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(opts: ClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.userAgent = opts.userAgent;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = opts.random ?? Math.random;
  }

  get hasKey(): boolean {
    return this.apiKey !== undefined;
  }

  async call<T = unknown>(opId: OperationId, input: CallInput = {}): Promise<CallResult<T>> {
    const op = OPERATIONS[opId];
    const authenticated = !UNAUTHENTICATED.has(opId);
    if (authenticated && !this.apiKey) throw new UsageError(NO_KEY_MESSAGE);

    const url = buildUrl(this.baseUrl, op, input);
    const headers: Record<string, string> = {
      Accept: 'application/json, application/problem+json',
      'User-Agent': this.userAgent,
    };
    if (authenticated && this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let body: string | undefined;
    if (input.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(input.form)) if (v !== undefined) params.set(k, v);
      body = params.toString();
    } else if (input.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(input.body);
    }
    if (op.acceptsIdempotencyKey) headers['Idempotency-Key'] = randomUUID();
    const timeoutMs = input.timeoutMs ?? TIMEOUTS[opId] ?? DEFAULT_TIMEOUT_MS;

    let lastError: SynapseTreeError | undefined;
    let waitMs: number | undefined;
    // registerAgentIdentity is single-attempt: the POST creates a claim (and
    // triggers an email) as a side effect, and the contract gives it no
    // Idempotency-Key, so a blind retry on a 503 would consume the
    // five-claims-per-email cap with a claim nobody polls.
    const canRetry = opId !== 'registerAgentIdentity';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        if (!canRetry) break;
        await this.sleep(waitMs ?? Math.min(1000 * 2 ** attempt, 8000) + Math.floor(this.random() * 250));
      }
      let res: Response;
      let done: () => void;
      try {
        ({ res, done } = await this.send(url, { method: op.method, headers, body }, timeoutMs));
      } catch (err) {
        lastError = new SynapseTreeError({ status: 0, code: 'network_error', detail: err instanceof Error ? err.message : String(err) });
        waitMs = undefined;
        continue;
      }
      // The abort timer stays armed until the body has been consumed: a
      // server that sends headers and stalls the body must still hit the
      // timeout instead of hanging the tool call forever.
      try {
        const parsed = await readBody(res);
        if (RETRY_STATUSES.has(res.status)) {
          lastError = toError(res, parsed);
          waitMs = retryAfterMs(res, parsed.json);
          continue;
        }
        if (res.ok || (opId === 'oauthToken' && res.status === 400)) {
          return {
            status: res.status,
            data: parsed.json as T,
            requestId: res.headers.get('request-id') ?? undefined,
            rateLimit: res.headers.get('ratelimit') ?? undefined,
            rateLimitPolicy: res.headers.get('ratelimit-policy') ?? undefined,
            idempotentReplayed: res.headers.get('idempotent-replayed') === 'true',
          };
        }
        throw toError(res, parsed);
      } finally {
        done();
      }
    }
    throw lastError ?? new SynapseTreeError({ status: 0, code: 'network_error' });
  }

  private async send(url: string, init: RequestInit, timeoutMs: number): Promise<{ res: Response; done: () => void }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
    const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
    return { res, done: () => clearTimeout(timer) };
  }
}
