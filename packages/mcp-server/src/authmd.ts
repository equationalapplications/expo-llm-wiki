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
  let intervalSeconds = reg.poll.interval ?? 5;

  opts.info(`Check ${email} for a SynapseTree approval link (usually within a minute; it expires in 15 minutes).`);
  opts.info(`Approve only if the page shows this code: ${reg.user_code}`);

  for (;;) {
    await sleep(intervalSeconds * 1000);
    if (now() > deadline) throw new ClaimError('invalid_grant', EXPIRED_MESSAGE);

    let res;
    try {
      res = await client.call<TokenOk | TokenErr>('oauthToken', { form: { grant_type: reg.poll.grant, assertion: reg.claim_token } });
    } catch (err) {
      // server_error (500) and network errors: keep polling at the current interval.
      if (err instanceof SynapseTreeError && (err.status >= 500 || err.status === 0)) continue;
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
        if (typeof body.interval === 'number') intervalSeconds = body.interval;
        continue;
      case 'slow_down':
        intervalSeconds = typeof body.interval === 'number' ? body.interval : intervalSeconds + 5;
        continue;
      case 'invalid_grant':
        throw new ClaimError('invalid_grant', EXPIRED_MESSAGE);
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
