import { ZodError } from 'zod';

export interface SynapseTreeErrorInit {
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  retryAfterSeconds?: number;
}

/** A SynapseTree API error (problem+json, an OAuth error body, or a gateway rejection). */
export class SynapseTreeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;

  constructor(init: SynapseTreeErrorInit) {
    super(init.detail ? `${init.code}: ${init.detail}` : init.code);
    this.name = 'SynapseTreeError';
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** A local mistake: missing configuration or bad input. Never an HTTP failure. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const NO_NAMESPACE_MESSAGE =
  'No namespace configured. Run `synapsetree-mcp config set namespace repo:<name>`, or pass `namespace`.';

export const NO_KEY_MESSAGE =
  'No API key. Run `synapsetree-mcp auth --key stree_…` or `synapsetree-mcp auth --email you@example.com`.';

export const INGEST_PROVIDER_MESSAGE =
  'Requires the account owner to have registered an extraction provider in the dashboard (bring-your-own-key). ' +
  'Otherwise the server answers `inference_not_configured`; tell the user to register a provider at https://synapsetree.dev/dashboard.';

const DETAIL_CODES = new Set([
  'quota_exceeded',
  'payload_too_large',
  'invalid_request',
  'not_found',
  'conflict',
  'invalid_state',
  'source_hash_conflict',
  'idempotency_key_reused',
  'ontology_violation',
]);

const TRANSIENT_CODES = new Set(['namespace_busy', 'fenced', 'unavailable', 'idempotency_in_progress']);

function describe(err: SynapseTreeError): string {
  switch (err.code) {
    case 'unauthorized':
      return 'SynapseTree rejected the stored API key (revoked, unknown, or its database is not reachable). Ask the user to run `synapsetree-mcp auth`.';
    case 'insufficient_scope':
      return 'This key cannot do that. The account owner does it in the dashboard at https://synapsetree.dev/dashboard.';
    case 'subscription_inactive':
      return "The organization's SynapseTree plan is paused. Reads and export still work in the dashboard.";
    case 'inference_not_configured':
      return INGEST_PROVIDER_MESSAGE;
    case 'upstream_inference_unavailable':
      return "The account owner's inference provider is failing; searches fall back to keywords. Retry ingest later.";
    case 'rate_limited':
      return `Rate limited by SynapseTree; retry after ${err.retryAfterSeconds !== undefined ? `${err.retryAfterSeconds} seconds` : 'a few seconds'}.`;
    case 'not_implemented':
      return 'SynapseTree has not enabled this operation yet (501). Tell the user; nothing to fix locally.';
    default:
      if (DETAIL_CODES.has(err.code)) return `${err.code}: ${err.detail ?? ''}`.trimEnd();
      if (TRANSIENT_CODES.has(err.code)) return 'SynapseTree is temporarily unavailable; retry in a few seconds.';
      return `${err.code}${err.detail ? `: ${err.detail}` : ''} (HTTP ${err.status})`;
  }
}

/** One paragraph a model can act on. Never throws. */
export function toolErrorText(err: unknown): string {
  if (err instanceof SynapseTreeError) {
    const text = describe(err);
    return err.requestId ? `${text} (request-id: ${err.requestId})` : text;
  }
  if (err instanceof ZodError) {
    return err.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('\n');
  }
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}
