import type { SynapseTreeClient } from './client';
import { SynapseTreeError } from './errors';

export interface AuthmdOptions {
  /** Human-facing progress lines (the CLI sends them to stderr). Never contains secrets. */
  info: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Default 16 minutes: the claim itself expires after 15. */
  deadlineMs?: number;
}

export interface RegisterResult {
  apiKey: string;
  accountId: string | null;
}

export class ClaimError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ClaimError';
    this.code = code;
  }
}

interface Registration {
  claim_token: string;
  user_code: string;
  poll: { token_endpoint: string; grant: string; interval?: number };
}

interface TokenOk { access_token: string; token_type: string; account_id?: string; scope?: string }
interface TokenErr { error: string; error_description?: string; error_uri?: string; interval?: number }

const EXPIRED_MESSAGE = 'The claim expired (15 minutes) or was already used. Run `synapsetree-mcp auth --email` again.';
const REMEDY_CODES = new Set(['key_limit_reached', 'database_name_taken', 'database_quota_exceeded']);

export async function registerByEmail(client: SynapseTreeClient, email: string, opts: AuthmdOptions): Promise<RegisterResult> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.deadlineMs ?? 16 * 60 * 1000);

  const reg = (await client.call<Registration>('registerAgentIdentity', { body: { email } })).data;
  if (!reg || typeof reg !== 'object' || !reg.poll || typeof reg.user_code !== 'string' || typeof reg.claim_token !== 'string' || typeof reg.poll.grant !== 'string') {
    throw new ClaimError('invalid_response', 'The registration endpoint returned a malformed response.');
  }
  // Fail closed on a server-chosen token endpoint: posting the claim token
  // anywhere other than the configured base URL would be a phishing vector.
  if (reg.poll.token_endpoint !== `${client.baseUrl}/oauth2/token`) {
    throw new ClaimError('invalid_response', `The server returned an unexpected token endpoint (${reg.poll.token_endpoint}); expected ${client.baseUrl}/oauth2/token.`);
  }
  // A poll that failed ambiguously (network error or 5xx after the server may
  // have committed the 200) can leave a minted key undelivered; if the claim
  // then comes back invalid_grant, say so instead of claiming it expired.
  let ambiguousPoll = false;
  // Clamp to >= 1 s: a server sending interval 0 (or negative) must not
  // turn the poll loop into a hammer on /oauth2/token.
  let intervalSeconds = Math.max(1, reg.poll.interval ?? 5);

  opts.info(`Check ${email} for a SynapseTree approval link (usually within a minute; it expires in 15 minutes).`);
  opts.info(`Approve only if the page shows this code: ${reg.user_code}`);

  for (;;) {
    if (now() > deadline) throw new ClaimError('invalid_grant', EXPIRED_MESSAGE);
    // Bound the wait: a hostile or buggy `interval` (or 1e9) must neither
    // park the CLI past the deadline nor hammer the endpoint (min 1 s,
    // max 60 s, never past the deadline).
    const remaining = deadline - now();
    await sleep(Math.min(Math.max(intervalSeconds, 1), 60, Math.max(remaining, 0)) * 1000);

    let res;
    try {
      res = await client.call<TokenOk | TokenErr>('oauthToken', { form: { grant_type: reg.poll.grant, assertion: reg.claim_token } });
    } catch (err) {
      // server_error (500), 408, network errors, and a surviving 429 are
      // transient: keep polling at the current interval. A 429 asks us to
      // slow down, so add 5 s like the slow_down case below. A 408 is
      // ambiguous the same way a 5xx is: the server may have committed the
      // 200 before the request timed out.
      if (err instanceof SynapseTreeError && (err.status >= 500 || err.status === 0 || err.status === 408 || err.status === 429)) {
        if (err.status === 429) intervalSeconds += 5;
        else ambiguousPoll = true;
        continue;
      }
      throw err;
    }

    if (res.status === 200) {
      const ok = res.data as TokenOk;
      if (!ok || typeof ok !== 'object' || typeof ok.access_token !== 'string') {
        throw new ClaimError('invalid_response', 'The token endpoint returned a malformed success response.');
      }
      return { apiKey: ok.access_token, accountId: ok.account_id ?? null };
    }

    const body = res.data as TokenErr;
    if (!body || typeof body !== 'object' || typeof body.error !== 'string') {
      throw new ClaimError('invalid_response', 'The token endpoint returned a malformed error response.');
    }
    switch (body.error) {
      case 'authorization_pending':
        if (typeof body.interval === 'number') intervalSeconds = Math.max(1, body.interval);
        continue;
      case 'slow_down':
        intervalSeconds = typeof body.interval === 'number' ? Math.max(1, body.interval) : intervalSeconds + 5;
        continue;
      case 'invalid_grant':
        throw new ClaimError(
          'invalid_grant',
          ambiguousPoll
            ? 'A key may have been issued but was not received (a poll failed ambiguously before the claim was freed). Check the SynapseTree dashboard for an unexpected agent key, revoke it, then run `synapsetree-mcp auth --email` again.'
            : EXPIRED_MESSAGE,
        );
      default:
        if (REMEDY_CODES.has(body.error)) {
          opts.info(`${body.error}: ${body.error_description ?? 'the account owner must clear this in the dashboard'}${body.error_uri ? ` — ${body.error_uri}` : ''}`);
          opts.info('Waiting; approve again once it is fixed.');
          continue;
        }
        throw new ClaimError(body.error, `${body.error}${body.error_description ? `: ${body.error_description}` : ''}`);
    }
  }
}
