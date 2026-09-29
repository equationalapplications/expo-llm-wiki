import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { runSupersession } from '../src/supersession/run';
import type { Scenario } from '../src/supersession/run';
import type { ChatEndpoint } from '../src/provider';

const FIXTURE_PATH = join(
  __dirname,
  '..',
  'fixtures',
  'supersession',
  'scenarios.json',
);

/**
 * The shared supersession scenario fixture. PR-0 writes it; PR-B's replay
 * suite consumes the same JSON (`packages/core/__tests__/supersessionReplay.test.ts`).
 */
const scenarios = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Scenario[];

const ANTHROPIC_OK = (text: string, inputTokens = 0, outputTokens = 0) =>
  new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const FAKE_ENDPOINT: ChatEndpoint = {
  protocol: 'anthropic',
  baseUrl: 'https://x.test',
  apiKey: 'k',
  model: 'm',
};

describe('supersession scenarios fixture', () => {
  it('contains exactly 30 scenarios', () => {
    expect(scenarios).toHaveLength(30);
  });

  it('has unique scenario names', () => {
    const names = scenarios.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every expectSuperseded id is present in the scenario\'s existing facts', () => {
    for (const s of scenarios) {
      const ids = new Set(s.existing.map((f) => f.id));
      for (const id of s.expectSuperseded) {
        expect(ids.has(id), `scenario "${s.name}" expects id "${id}" to be superseded but it is not in existing`).toBe(true);
      }
    }
  });

  it('every resolve.ops[].target matches /^n\\d+$/', () => {
    for (const s of scenarios) {
      if (!s.resolve) continue;
      for (const op of s.resolve.ops) {
        const target = (op as { target?: unknown }).target;
        if (typeof target !== 'string') continue;
        expect(target, `scenario "${s.name}" has a non-/^n\\d+$/ target: ${JSON.stringify(op)}`).toMatch(/^n\d+$/);
      }
    }
  });
});

describe('runSupersession (legacy)', () => {
  it('runs on two scenarios with a fake fetch and returns the spec-shaped report', async () => {
    // Pick two small scenarios: relocation 1 (Seattle→SF) and job 6 (engineer→manager).
    // The fake fetch returns "{}" for every call so the engine short-circuits
    // gracefully; the test only checks the report's shape, not fact-correctness.
    const subset = scenarios.slice(0, 2);

    const fetchImpl = vi.fn(async () => ANTHROPIC_OK('{}', 0, 0));

    const report = await runSupersession({
      scenarios: subset,
      strategy: 'legacy',
      endpoint: FAKE_ENDPOINT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      embed: async (_t: string) => [0.1, 0.2, 0.3],
    });

    // ---- top-level shape ----
    expect(report.kind).toBe('supersession');
    expect(report.strategy).toBe('legacy');
    expect(typeof report.engine.version).toBe('string');
    expect(typeof report.engine.gitSha).toBe('string');
    expect(typeof report.passed).toBe('number');
    expect(typeof report.total).toBe('number');
    expect(report.total).toBe(subset.length);
    expect(Array.isArray(report.results)).toBe(true);
    expect(report.results).toHaveLength(subset.length);

    // ---- per-scenario result ----
    const first = report.results[0];
    expect(first.name).toBe(subset[0].name);
    expect(typeof first.pass).toBe('boolean');
    expect(Array.isArray(first.currentTitles)).toBe(true);

    // The supersession runner must skip liveSkip scenarios (none here), so
    // each scenario in the subset ran and produced a result row.
    expect(report.passed).toBeGreaterThanOrEqual(0);
    expect(report.passed).toBeLessThanOrEqual(report.total);

    // The fake fetch was exercised — the librarian passes events to the LLM
    // (legacy uses the "knowledge extraction agent" prompt).
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('skips scenarios flagged liveSkip', async () => {
    // Force-rewrite a fake scenario to ensure liveSkip is respected. We
    // patch the subset here rather than mutating the fixture: the goal is
    // to verify the runner honours liveSkip, not to assert that the
    // fixture contains a liveSkip scenario at any particular index.
    const skip: Scenario = {
      name: '__should_skip__',
      existing: [
        { id: 'a', title: 'User lives in Seattle', body: 'b', source_type: 'user_stated' },
      ],
      events: [{ summary: 'moved to SF' }],
      extract: { facts: [], tasks: [] },
      resolve: null,
      expectCurrentTitles: ['User lives in Seattle'],
      expectSuperseded: [],
      liveSkip: true,
    };
    const kept: Scenario = {
      name: '__should_run__',
      existing: [
        { id: 'a', title: 'User likes tea', body: 'b', source_type: 'user_stated' },
      ],
      events: [{ summary: 'switched to coffee' }],
      extract: { facts: [], tasks: [] },
      resolve: null,
      expectCurrentTitles: [],
      expectSuperseded: [],
    };

    const fetchImpl = vi.fn(async () => ANTHROPIC_OK('{}', 0, 0));
    const report = await runSupersession({
      scenarios: [skip, kept],
      strategy: 'legacy',
      endpoint: FAKE_ENDPOINT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      embed: async (_t: string) => [0.1, 0.2, 0.3],
    });

    expect(report.total).toBe(1);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].name).toBe('__should_run__');
  });
});