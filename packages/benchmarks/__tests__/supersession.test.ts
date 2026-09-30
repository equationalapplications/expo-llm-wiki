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

// Deliberately distinct from any production URL (`https://api.z.ai/...` and
// `https://x.test`). If the runner ever regresses and hard-codes its
// endpoint, this assertion would silently keep passing — the regression
// would only surface in production. Use a third URL here so the test
// doubles as a guard: a future fix that re-introduces a hard-coded URL
// would either hit the wrong server (caught by `createProvider` returning
// the real `fetch` to a non-routable host) or break the test's baseUrl
// equality assertion below.
const FAKE_ENDPOINT: ChatEndpoint = {
  protocol: 'anthropic',
  baseUrl: 'https://test.local',
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
    expect(report.skipped).toBe(1);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].name).toBe('__should_run__');
  });

  it('runs a two-run scenario (secondRunFrom) and routes every LLM call through the injected endpoint', async () => {
    // Pick the relocation-3 scenario — it has secondRunFrom=1, so the runner
    // must write the first event, run the librarian (and heal), then write
    // the second event and run them again.
    const twoRun = scenarios.find((s) => s.name === 'relocation-3-moved-back-AB-A');
    expect(twoRun).toBeDefined();
    expect(twoRun?.secondRunFrom).toBe(1);

    const seenUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seenUrls.push(url);
      return ANTHROPIC_OK('{}', 0, 0);
    });

    const report = await runSupersession({
      scenarios: [twoRun!],
      strategy: 'legacy',
      endpoint: FAKE_ENDPOINT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      embed: async (_t: string) => [0.1, 0.2, 0.3],
    });

    expect(report.total).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.results).toHaveLength(1);
    const row = report.results[0];
    expect(row.name).toBe('relocation-3-moved-back-AB-A');
    expect(row.pass).toBe(false);
    expect(row.error).toBeUndefined();

    // Every fetchImpl hit must target the injected endpoint's host. If the
    // runner ever re-introduces a hard-coded base URL, `seenUrls` would
    // contain `https://api.z.ai/...` (or `https://x.test/...`) instead of
    // `https://test.local/...`. This is the regression guard for the
    // Critical finding in the round-1 review.
    expect(seenUrls.length).toBeGreaterThan(0);
    for (const url of seenUrls) {
      expect(url.startsWith('https://test.local/')).toBe(true);
    }
  });

  it('records an error row when a scenario throws, without aborting the suite', async () => {
    const good: Scenario = {
      name: '__good__',
      existing: [{ id: 'a', title: 'User lives in Seattle', body: 'b', source_type: 'user_stated' }],
      events: [{ summary: 'moved to SF' }],
      extract: { facts: [], tasks: [] },
      resolve: null,
      expectCurrentTitles: [],
      expectSuperseded: [],
    };
    const bad: Scenario = {
      name: '__bad__',
      // `existing` contains a duplicate id (same id twice) — `runReembed`
      // plus the raw-INSERT throws because the PRIMARY KEY collides.
      existing: [
        { id: 'dup', title: 'first', body: 'b', source_type: 'user_stated' },
        { id: 'dup', title: 'second', body: 'b', source_type: 'user_stated' },
      ],
      events: [],
      extract: { facts: [], tasks: [] },
      resolve: null,
      expectCurrentTitles: [],
      expectSuperseded: [],
    };

    const fetchImpl = vi.fn(async () => ANTHROPIC_OK('{}', 0, 0));
    const report = await runSupersession({
      scenarios: [bad, good],
      strategy: 'legacy',
      endpoint: FAKE_ENDPOINT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      embed: async (_t: string) => [0.1, 0.2, 0.3],
    });

    expect(report.total).toBe(2);
    expect(report.results).toHaveLength(2);

    const badRow = report.results.find((r) => r.name === '__bad__');
    expect(badRow?.pass).toBe(false);
    expect(typeof badRow?.error).toBe('string');
    expect(badRow?.error && badRow.error.length).toBeGreaterThan(0);

    // The good scenario must still run — a single bad row never aborts.
    const goodRow = report.results.find((r) => r.name === '__good__');
    expect(goodRow).toBeDefined();
  });
});