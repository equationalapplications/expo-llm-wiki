/**
 * Tests for `packages/benchmarks/src/compare.ts`.
 *
 * The contract from the brief:
 *   - `compareReports(before, after)` returns a Markdown string.
 *   - Header block names both engines/flags/models/judges.
 *   - A **bold warning line** is included when the judge model or the answer
 *     model differs between the two reports.
 *   - An accuracy table by question type shows before / after / Δ in
 *     percentage points.
 *   - A tokens table by call site shows input+output before / after / Δ %.
 *   - Retrieval context tokens (mean, p50, p95).
 *   - Ingest latency p50/p95.
 *   - Answer latency p50.
 *   - Numbers are formatted to one decimal place.
 *
 * The fixtures are hand-written so they exercise the Δ signs and the
 * "judge model differs ⇒ warning line" branch.
 */

import { describe, it, expect } from 'vitest';

import { compareReports } from '../src/compare';
import type { BenchReport } from '../src/report';

/**
 * Build a minimal-but-shape-correct {@link BenchReport} for the fixture.
 * Only the fields the comparator actually reads are populated; the rest are
 * present-but-zero so the type is satisfied.
 */
function buildReport(overrides: {
  engineVersion: string;
  engineSha: string;
  answerModel: string;
  judgeModel: string;
  flags: BenchReport['engine']['flags'];
  overall: number;
  byType: Record<string, { correct: number; total: number; rate: number }>;
  tokens: BenchReport['tokens'];
  retrieval: BenchReport['retrieval'];
  latencyMs: BenchReport['latencyMs'];
}): BenchReport {
  return {
    kind: 'longmemeval',
    createdAt: '2026-09-30T00:00:00.000Z',
    engine: {
      version: overrides.engineVersion,
      gitSha: overrides.engineSha,
      flags: overrides.flags,
    },
    models: {
      answer: overrides.answerModel,
      judge: overrides.judgeModel,
      embed: 'fastembed/BGESmallENV15',
    },
    sample: { seed: 0, count: 4, dataset: 'longmemeval' },
    accuracy: {
      overall: overrides.overall,
      byType: overrides.byType,
    },
    tokens: overrides.tokens,
    retrieval: overrides.retrieval,
    latencyMs: overrides.latencyMs,
    cachedIngests: 0,
    questions: [],
  };
}

/** A zero token bucket for every known call site. */
function zeroTokens(): BenchReport['tokens'] {
  const sites = ['librarian', 'extract', 'resolve', 'heal', 'ingest', 'ontology', 'answer', 'judge', 'other'] as const;
  const out = {} as BenchReport['tokens'];
  for (const s of sites) {
    out[s] = { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCalls: 0 };
  }
  return out;
}

describe('compareReports', () => {
  // Two reports that differ in judge model + accuracy + tokens + latency so
  // every section of the Markdown exercises a real change.  The numbers
  // are chosen so Δ signs are unambiguous (after > before ⇒ positive Δ).
  const before = buildReport({
    engineVersion: '7.7.7',
    engineSha: 'abc1234',
    answerModel: 'glm-4.6',
    judgeModel: 'glm-4.6',
    flags: { strategy: 'legacy', maintenance: 'auto' },
    overall: 0.50,
    byType: {
      'single-session-user': { correct: 2, total: 4, rate: 0.5 },
      'knowledge-update': { correct: 1, total: 2, rate: 0.5 },
    },
    tokens: {
      ...zeroTokens(),
      answer: { calls: 4, inputTokens: 1000, outputTokens: 200, estimatedCalls: 0 },
      judge: { calls: 4, inputTokens: 800, outputTokens: 80, estimatedCalls: 0 },
    },
    retrieval: { meanContextTokens: 100, p50: 90, p95: 200 },
    latencyMs: { ingestP50: 200, ingestP95: 400, answerP50: 800, answerP95: 1200 },
  });

  const after = buildReport({
    engineVersion: '7.8.0',
    engineSha: 'def5678',
    answerModel: 'glm-4.6', // unchanged
    judgeModel: 'glm-4.6-judge', // CHANGED — must trigger warning line
    flags: { strategy: 'ops', maintenance: 'deferred' },
    overall: 0.75,
    byType: {
      'single-session-user': { correct: 3, total: 4, rate: 0.75 },
      'knowledge-update': { correct: 2, total: 2, rate: 1.0 },
    },
    tokens: {
      ...zeroTokens(),
      answer: { calls: 4, inputTokens: 800, outputTokens: 160, estimatedCalls: 0 },
      judge: { calls: 4, inputTokens: 700, outputTokens: 70, estimatedCalls: 0 },
      librarian: { calls: 12, inputTokens: 2400, outputTokens: 600, estimatedCalls: 0 },
    },
    retrieval: { meanContextTokens: 80, p50: 70, p95: 180 },
    latencyMs: { ingestP50: 250, ingestP95: 450, answerP50: 700, answerP95: 1100 },
  });

  it('returns a non-empty Markdown string', () => {
    const md = compareReports(before, after);
    expect(typeof md).toBe('string');
    expect(md.length).toBeGreaterThan(0);
  });

  it('includes a header block naming both engines, flags, and models', () => {
    const md = compareReports(before, after);
    // engines
    expect(md).toContain('7.7.7');
    expect(md).toContain('7.8.0');
    expect(md).toContain('abc1234');
    expect(md).toContain('def5678');
    // flags (both strategy & maintenance)
    expect(md).toContain('legacy');
    expect(md).toContain('auto');
    expect(md).toContain('ops');
    expect(md).toContain('deferred');
    // answer / judge model names
    expect(md).toContain('glm-4.6');
    expect(md).toContain('glm-4.6-judge');
  });

  it('emits a bold warning line when the judge model differs', () => {
    const md = compareReports(before, after);
    // Bold markdown: ** ... **
    expect(md).toMatch(/\*\*[^*]*\bjudge\b[^*]*\*\*/i);
  });

  it('emits a bold warning line when the answer model differs', () => {
    const sameJudges: BenchReport = {
      ...before,
      models: { ...before.models, answer: 'different-answer-model' },
    };
    const md = compareReports(before, sameJudges);
    expect(md).toMatch(/\*\*[^*]*\banswer\b[^*]*\*\*/i);
  });

  it('omits the bold warning line when answer and judge models match', () => {
    const sameModel: BenchReport = {
      ...before,
      engine: { version: '7.8.0', gitSha: 'def5678', flags: { strategy: 'ops', maintenance: 'deferred' } },
      models: { ...before.models, answer: 'glm-4.6', judge: 'glm-4.6' },
    };
    const md = compareReports(before, sameModel);
    // No ** ... judge ... ** / ** ... answer ... ** sentence should appear.
    expect(md).not.toMatch(/\*\*[^*]*\b(judge|answer)\s+model[^*]*\*\*/i);
  });

  it('renders an accuracy table by question type with before, after, and Δ in percentage points', () => {
    const md = compareReports(before, after);
    expect(md).toMatch(/Accuracy/i);
    // Each type from the fixtures must appear.
    expect(md).toContain('single-session-user');
    expect(md).toContain('knowledge-update');
    // Δ in percentage points: 75.0% - 50.0% = +25.0 pp for single-session-user,
    // 100.0% - 50.0% = +50.0 pp for knowledge-update.  Sign + format to 1 dp.
    expect(md).toMatch(/\+25\.0\s*pp/);
    expect(md).toMatch(/\+50\.0\s*pp/);
    // Overall accuracy line: 50.0 → 75.0 ⇒ +25.0 pp.
    expect(md).toMatch(/overall/i);
  });

  it('renders a tokens table by call site with input+output and Δ %', () => {
    const md = compareReports(before, after);
    expect(md).toMatch(/Tokens/i);
    // `answer` call site has 1200 → 960 total tokens ⇒ -20.0%
    expect(md).toContain('answer');
    expect(md).toMatch(/-20\.0\s*%/);
    // `librarian` went from 0 → 3000 (was unused in "before").  The
    // comparator should still render a Δ % for the row rather than
    // dividing by zero.
    expect(md).toContain('librarian');
  });

  it('renders retrieval context tokens (mean, p50, p95)', () => {
    const md = compareReports(before, after);
    expect(md).toMatch(/Retrieval/i);
    expect(md).toMatch(/mean/i);
    expect(md).toContain('p50');
    expect(md).toContain('p95');
  });

  it('renders ingest latency p50 and p95', () => {
    const md = compareReports(before, after);
    expect(md).toMatch(/Ingest latency/i);
    // Numbers appear once formatted to 1 dp.
    expect(md).toMatch(/250\.0/);
    expect(md).toMatch(/450\.0/);
  });

  it('renders answer latency p50', () => {
    const md = compareReports(before, after);
    expect(md).toMatch(/Answer latency/i);
    expect(md).toMatch(/700\.0/);
    expect(md).toMatch(/800\.0/);
  });

  it('formats every number to one decimal place', () => {
    const md = compareReports(before, after);
    // A regex that matches a number with at least 2 decimal places — there
    // must be none.  (1 dp = `X.Y` only.)
    const twoDp = /\d+\.\d{2,}/;
    expect(twoDp.test(md)).toBe(false);
    // Conversely, every rate / token / latency number is "X.Y" with exactly
    // one digit after the point.
    const oneDp = /\d+\.\d\b/;
    expect(oneDp.test(md)).toBe(true);
  });

  it('renders a Δ sign for negative accuracy deltas', () => {
    const worseAfter: BenchReport = {
      ...before,
      accuracy: {
        overall: 0.25,
        byType: {
          'single-session-user': { correct: 1, total: 4, rate: 0.25 },
          'knowledge-update': { correct: 0, total: 2, rate: 0.0 },
        },
      },
    };
    const md = compareReports(before, worseAfter);
    expect(md).toMatch(/-25\.0\s*pp/);
  });
});