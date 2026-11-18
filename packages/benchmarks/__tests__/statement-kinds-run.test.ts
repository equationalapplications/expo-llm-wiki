import { describe, it, expect, vi } from 'vitest';

import { runStatementKinds, StatementFixtureEntry } from '../src/statementKinds/run';

const ok = (text: string) =>
  new Response(JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const entries: StatementFixtureEntry[] = ['alpha one', 'beta two'].map((text) => ({
  text,
  expected_kind: 'rule',
  expected_target: { title: 'Orbit', type: 'software_application' },
}));

describe('runStatementKinds misalignment guard', () => {
  it('an unclassified first statement is not carried into the next prompt', async () => {
    let calls = 0;
    const prompts: string[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: { body?: string }) => {
      calls += 1;
      const body = JSON.parse(init?.body ?? '{}');
      prompts.push(JSON.stringify(body.messages));
      // First classification call fails hard (non-retryable 4xx).
      if (calls === 1) return new Response('bad', { status: 400 });
      // Classify whichever ids appear in the prompt as 'rule'.
      const ids = [...JSON.stringify(body.messages).matchAll(/fact_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f-]{27}/g)].map((m) => m[0]);
      return ok(JSON.stringify({ classifications: [...new Set(ids)].map((id) => ({ id, okf_type: 'rule', edges: [] })) }));
    });
    const report = await runStatementKinds({
      entries,
      endpoint: { protocol: 'anthropic', baseUrl: 'https://x.test', apiKey: 'k', model: 'm' },
      engine: { version: 't', gitSha: 't', gitDescribe: 't' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(report.results[0].actual_kind).toBeNull();
    // Second row's classification prompt must not contain the failed statement.
    expect(prompts[prompts.length - 1]).not.toContain('alpha one');
    expect(report.results[1].error).toBeUndefined();
    expect(report.results[1].actual_kind).toBe('rule');
    expect(report.results[1].misaligned).toBeUndefined();
  });
});

describe('#381 harness: promptOverride ride-through (variant retired)', () => {
  it('a custom promptOverride rides through next to the production title catalog and appendix', async () => {
    const systems: string[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}');
      systems.push(typeof body.system === 'string' ? body.system : JSON.stringify(body.system));
      const ids = [...JSON.stringify(body.messages).matchAll(/fact_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f-]{27}/g)].map((m) => m[0]);
      return ok(JSON.stringify({ classifications: [...new Set(ids)].map((id) => ({ id, okf_type: 'rule', edges: [] })) }));
    });
    const report = await runStatementKinds({
      entries,
      endpoint: { protocol: 'anthropic', baseUrl: 'https://x.test', apiKey: 'k', model: 'm' },
      engine: { version: 't', gitSha: 't', gitDescribe: 't' },
      promptOverride: 'CUSTOM-CLASSIFIER-OVERRIDE',
      variant: 'custom-override',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(systems.length).toBeGreaterThan(0);
    for (const s of systems) {
      expect(s).toContain('CUSTOM-CLASSIFIER-OVERRIDE');
      // Core appends the production catalog + ontology appendix regardless of
      // the override (M4: the title-catalog variant was retired because of this).
      expect(s).toContain('TITLE CATALOG');
      expect(s).toContain('Ontology constraints');
    }
    expect(report.variant).toBe('custom-override');
  });
});
