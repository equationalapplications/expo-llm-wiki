import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NO_NAMESPACE_MESSAGE, SynapseTreeError, UsageError, toolErrorText } from '../src/errors';

const err = (code: string, extra: Partial<ConstructorParameters<typeof SynapseTreeError>[0]> = {}) =>
  new SynapseTreeError({ status: 400, code, ...extra });

describe('toolErrorText (spec §9)', () => {
  it('maps unauthorized to the re-auth instruction', () => {
    expect(toolErrorText(err('unauthorized', { status: 401 }))).toContain('synapsetree-mcp auth');
  });
  it('maps insufficient_scope to the dashboard', () => {
    expect(toolErrorText(err('insufficient_scope', { status: 403 }))).toContain('https://synapsetree.dev/dashboard');
  });
  it('maps subscription_inactive', () => {
    expect(toolErrorText(err('subscription_inactive'))).toMatch(/plan is paused/);
  });
  it('maps inference_not_configured to the provider instruction', () => {
    expect(toolErrorText(err('inference_not_configured', { status: 409 }))).toContain('register a provider');
  });
  it('maps upstream_inference_unavailable', () => {
    expect(toolErrorText(err('upstream_inference_unavailable'))).toMatch(/fall back to keywords/);
  });
  it('maps rate_limited with the seconds', () => {
    expect(toolErrorText(err('rate_limited', { status: 429, retryAfterSeconds: 7 }))).toContain('retry after 7 seconds');
    expect(toolErrorText(err('rate_limited', { status: 429 }))).toContain('retry after a few seconds');
  });
  it('maps not_implemented', () => {
    expect(toolErrorText(err('not_implemented', { status: 501 }))).toContain('501');
  });
  it('passes detail through verbatim for the detail codes', () => {
    for (const code of ['quota_exceeded', 'payload_too_large', 'invalid_request', 'not_found', 'conflict', 'invalid_state', 'source_hash_conflict', 'idempotency_key_reused', 'ontology_violation']) {
      expect(toolErrorText(err(code, { detail: 'the detail' }))).toBe(`${code}: the detail`);
    }
  });
  it('maps the transient codes to one retry sentence', () => {
    for (const code of ['namespace_busy', 'fenced', 'unavailable', 'idempotency_in_progress']) {
      expect(toolErrorText(err(code, { status: 503 }))).toMatch(/temporarily unavailable; retry/);
    }
  });
  it('appends the request id when present', () => {
    expect(toolErrorText(err('conflict', { detail: 'd', requestId: 'req-1' }))).toBe('conflict: d (request-id: req-1)');
  });
  it('falls back to code, detail, status and request id for unknown codes', () => {
    const text = toolErrorText(err('something_new', { status: 418, detail: 'teapot', requestId: 'r' }));
    expect(text).toContain('something_new');
    expect(text).toContain('teapot');
    expect(text).toContain('418');
    expect(text).toContain('(request-id: r)');
  });
  it('renders a UsageError message as-is', () => {
    expect(toolErrorText(new UsageError(NO_NAMESPACE_MESSAGE))).toBe(NO_NAMESPACE_MESSAGE);
  });
  it('renders zod issues one per line', () => {
    const result = z.object({ limit: z.number().max(100) }).safeParse({ limit: 101 });
    expect(result.success).toBe(false);
    if (result.success) return;
    const text = toolErrorText(result.error);
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain('limit');
  });
  it('never throws on arbitrary input', () => {
    expect(toolErrorText(undefined)).toBe('Unknown error');
    expect(toolErrorText('boom')).toBe('boom');
    expect(toolErrorText(new Error('plain'))).toBe('plain');
  });
});
