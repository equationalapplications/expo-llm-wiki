import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatOkfBundle } from '../src/utils/formatOkfBundle';
import { parseOkfBundle } from '../src/utils/parseOkfBundle';
import type { MemoryDump, WikiFact, WikiTask } from '../src/types';

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000));
afterEach(() => vi.restoreAllMocks());

const factV2: WikiFact = {
  id: 'f1', entity_id: 'demo', title: 'Provenance fact', body: 'Body with [^a] footnote.\n\n[^a]: definition',
  tags: [], confidence: 'certain', source_type: 'user_stated',
  source_hash: null, source_ref: null,
  created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
  last_accessed_at: null, access_count: 0, deleted_at: null, okf_type: 'fact',
  lifecycle_status: 'stable',
  stale_after: new Date('2026-01-01T00:00:00Z').getTime(),
  generated_by: 'reference_agent/gemini-2.5-pro',
  okf_sources: [{ resource: 'https://example.com/a', id: 'a' }],
  okf_verified: [{ by: 'human:ahormati', at: '2026-01-01T00:00:00Z' }],
  okf_usage_window: { from: '2026-01-01', to: '2026-12-31' },
  last_verified_at: new Date('2026-01-01T00:00:00Z').getTime(),
  last_verified_by: 'human:ahormati',
};

const taskV2: WikiTask = {
  id: 't1', entity_id: 'demo', description: 'Submit OKR', status: 'in_progress', priority: 1,
  created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
  resolved_at: null, deleted_at: null, okf_type: 'task',
  lifecycle_status: 'stable',
  generated_by: 'reference_agent/gemini-2.5-pro',
  okf_sources: [], okf_verified: [], okf_usage_window: null,
  last_verified_at: null, last_verified_by: null,
};

const dump: MemoryDump = {
  generatedAt: 1_700_000_000_000,
  entities: { demo: { facts: [factV2], tasks: [taskV2], events: [], edges: [], summary: 'Demo summary.' } },
};

describe('formatOkfBundle v0.2 (default)', () => {
  it('writes okf_version 0.2 and profile llm-wiki/2', () => {
    const { files } = formatOkfBundle(dump);
    const root = files.find((f) => f.path === 'index.md')!;
    expect(root.content).toContain('okf_version: 0.2');
    expect(root.content).toContain('profile: llm-wiki/2');
  });

  it('emits generated, verified, status, stale_after, sources, usage_window on facts', () => {
    const { files } = formatOkfBundle(dump);
    const fact = files.find((f) => f.path.endsWith('facts/f1.md'))!;
    expect(fact.content).toContain('generated: { by: "reference_agent/gemini-2.5-pro"');
    expect(fact.content).toContain('status: stable');
    expect(fact.content).toContain('stale_after: 2026-01-01');
    expect(fact.content).toContain('sources:');
    expect(fact.content).toContain('usage_window: { from: 2026-01-01, to: 2026-12-31 }');
    // Verified bare-mapping OR list shape — emit list.
    expect(fact.content).toContain('verified:');
  });

  it('emits status (lifecycle) AND execution_status on tasks', () => {
    const { files } = formatOkfBundle(dump);
    const task = files.find((f) => f.path.endsWith('tasks/t1.md'))!;
    expect(task.content).toContain('status: stable');
    expect(task.content).toContain('execution_status: in_progress');
  });

  it('preserves footnote body verbatim (no synthesis)', () => {
    const { files } = formatOkfBundle(dump);
    const fact = files.find((f) => f.path.endsWith('facts/f1.md'))!;
    expect(fact.content).toContain('[^a]: definition');
  });

  it('round-trips back to identical WikiFact/WikiTask fields', () => {
    const { files } = formatOkfBundle(dump);
    const reimported = parseOkfBundle('demo', files);
    const f = reimported.entities.demo.facts.find((x) => x.id === 'f1')!;
    expect(f.lifecycle_status).toBe('stable');
    expect(f.generated_by).toBe('reference_agent/gemini-2.5-pro');
    expect(f.okf_sources?.[0]?.resource).toBe('https://example.com/a');
    expect(f.okf_verified?.[0]?.by).toBe('human:ahormati');
    expect(f.okf_usage_window?.from).toBe('2026-01-01');
    const t = reimported.entities.demo.tasks.find((x) => x.id === 't1')!;
    expect(t.lifecycle_status).toBe('stable');
    expect(t.status).toBe('in_progress'); // execution_status round-trip
  });
});

describe('formatOkfBundle v0.1 (explicit override)', () => {
  it('writes okf_version 0.1 and profile llm-wiki/1 when options.profile=llm-wiki/1', () => {
    const { files } = formatOkfBundle(dump, { profile: 'llm-wiki/1' });
    const root = files.find((f) => f.path === 'index.md')!;
    expect(root.content).toContain('okf_version: 0.1');
    expect(root.content).toContain('profile: llm-wiki/1');
    const fact = files.find((f) => f.path.endsWith('facts/f1.md'))!;
    expect(fact.content).not.toContain('generated:');
    expect(fact.content).not.toContain('verified:');
    expect(fact.content).not.toContain('sources:');
    expect(fact.content).toContain('timestamp:');
  });
});