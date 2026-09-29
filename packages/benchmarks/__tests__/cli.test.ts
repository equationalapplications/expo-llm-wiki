/**
 * CLI surface tests for `packages/benchmarks/src/cli.ts`.
 *
 * The CLI spawns nothing — these tests verify the pure pieces the handler
 * relies on, plus the spend-guard exit codes:
 *
 *   - `parseArgs(argv)` is a pure parser; no I/O, no dependency.
 *   - `estimateIngestTokens(questions)` is the per-run cost summary formula.
 *   - `runLongMemEvalCommand({ ... })` returns `{ exitCode: 1 }` when
 *     `--yes` is omitted, and `{ exitCode: 0 }` when `--dry-run` is
 *     supplied (in either case, before any provider resolution).
 *
 * The dataset loader, sample ids, endpoints, embedder, and stdout are all
 * injected so CI never touches a network or filesystem.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseArgs,
  estimateIngestTokens,
  runLongMemEvalCommand,
} from '../src/cli';
import type { LmeQuestion, LmeQuestionType } from '../src/longmemeval/dataset';
import type { ChatEndpoint } from '../src/provider';

function makeQ(type: LmeQuestionType, id: string, sessionChars: number): LmeQuestion {
  // Build a session whose content is exactly `sessionChars` characters long.
  // Each turn contributes its `content.length`; the total is the session length.
  const content = 'a'.repeat(sessionChars);
  return {
    question_id: id,
    question_type: type,
    question: 'q',
    answer: 'a',
    question_date: '2023/05/20 (Sat) 02:21',
    haystack_dates: ['2023/05/18 (Thu) 10:00'],
    haystack_sessions: [[{ role: 'user', content }, { role: 'assistant', content }]],
  };
}

describe('parseArgs', () => {
  it('parses a verb with no flags', () => {
    expect(parseArgs(['sample'])).toEqual({ command: 'sample', flags: {} });
  });

  it('parses `--key value` pairs into a flags record', () => {
    const r = parseArgs([
      'longmemeval',
      '--strategy', 'legacy',
      '--maintenance', 'auto',
      '--read-budget', '800',
      '--max-questions', '5',
      '--out', '/tmp/report.json',
    ]);
    expect(r.command).toBe('longmemeval');
    expect(r.flags.strategy).toBe('legacy');
    expect(r.flags.maintenance).toBe('auto');
    expect(r.flags['read-budget']).toBe('800');
    expect(r.flags['max-questions']).toBe('5');
    expect(r.flags.out).toBe('/tmp/report.json');
  });

  it('parses boolean flags (presence only)', () => {
    const r = parseArgs(['longmemeval', '--dry-run', '--yes']);
    expect(r.flags['dry-run']).toBe(true);
    expect(r.flags.yes).toBe(true);
    expect(r.command).toBe('longmemeval');
  });

  it('mixes value and boolean flags without consuming the next flag as a value', () => {
    const r = parseArgs(['longmemeval', '--strategy', 'ops', '--dry-run', '--yes']);
    expect(r.flags.strategy).toBe('ops');
    expect(r.flags['dry-run']).toBe(true);
    expect(r.flags.yes).toBe(true);
  });

  it('returns an empty command string when called with no arguments', () => {
    expect(parseArgs([])).toEqual({ command: '', flags: {} });
  });
});

describe('estimateIngestTokens', () => {
  it('is the sum of ceil(turn chars / 4) plus 2000 per question (answer+judge)', () => {
    const q = makeQ('single-session-user', 'q1', 100);
    // session has 2 turns × 100 chars = 200 chars => ceil(200 / 4) = 50
    // + 2000 flat
    expect(estimateIngestTokens([q])).toBe(50 + 2000);
  });

  it('rounds up when the char count is not a multiple of 4', () => {
    // 5 chars over 2 turns = 10 chars total => ceil(10/4) = 3
    const q = makeQ('single-session-user', 'q1', 5);
    expect(estimateIngestTokens([q])).toBe(3 + 2000);
  });

  it('scales linearly across multiple questions', () => {
    const q = makeQ('knowledge-update', 'q', 16);
    // 32 chars => 8 ingest tokens per question; 2000 per question.
    expect(estimateIngestTokens([q, q, q])).toBe((8 + 2000) * 3);
  });

  it('returns 0 for an empty question list', () => {
    expect(estimateIngestTokens([])).toBe(0);
  });
});

describe('runLongMemEvalCommand (spend guard)', () => {
  const endpoint: ChatEndpoint = {
    protocol: 'anthropic',
    baseUrl: 'https://x.test',
    apiKey: 'k',
    model: 'm',
  };

  it('returns exit code 1 without --yes (and never invokes the runner)', async () => {
    const stdout = vi.fn();
    const runImpl = vi.fn(async () => {
      throw new Error('runner should not be called when --yes is missing');
    });
    const q = makeQ('single-session-user', 'q1', 10);

    const r = await runLongMemEvalCommand({
      argv: ['longmemeval', '--strategy', 'legacy', '--maintenance', 'auto'],
      // Inject a fake key so the test isolates the `--yes` guard from the
      // no-key guard; CI environments without ZAI_API_KEY set would otherwise
      // short-circuit out of endpointFromEnv before reaching the cost guard.
      env: { ZAI_API_KEY: 'fake-key-for-spend-guard-test' },
      sampleIds: [q.question_id],
      dataset: [q],
      cacheDir: '/tmp/no-such-cache',
      embed: async () => [0.1],
      stdout,
      runImpl: runImpl as any,
    });

    expect(r.exitCode).toBe(1);
    expect(runImpl).not.toHaveBeenCalled();
    // The standard warning line must be printed so the user knows how to retry.
    const combined = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(combined).toContain('Re-run with --yes to spend these tokens.');
  });

  it('returns exit code 0 with --dry-run (before any provider resolution)', async () => {
    const stdout = vi.fn();
    const runImpl = vi.fn(async () => {
      throw new Error('runner should not be called when --dry-run is set');
    });
    const q = makeQ('single-session-user', 'q1', 100);

    const r = await runLongMemEvalCommand({
      // No env, no answerEndpoint — the --dry-run path must short-circuit
      // before any provider resolution so an unset key is non-fatal here.
      argv: ['longmemeval', '--dry-run'],
      env: {}, // intentionally empty: must not throw on dry-run
      sampleIds: [q.question_id],
      dataset: [q],
      cacheDir: '/tmp/no-such-cache',
      embed: async () => [0.1],
      stdout,
      runImpl: runImpl as any,
    });

    expect(r.exitCode).toBe(0);
    expect(runImpl).not.toHaveBeenCalled();
    // The estimate line should be in the output so the operator can sanity-check.
    const combined = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(combined).toMatch(/input tokens/i);
  });

  it('fails fast with a missing API key when --yes is supplied', async () => {
    const q = makeQ('single-session-user', 'q1', 10);
    const r = await runLongMemEvalCommand({
      argv: ['longmemeval', '--yes'],
      env: {}, // no key set
      sampleIds: [q.question_id],
      dataset: [q],
      cacheDir: '/tmp/no-such-cache',
      embed: async () => [0.1],
      stdout: () => {},
      stderr: () => {}, // mute the "Set ZAI_API_KEY ..." warning
      runImpl: vi.fn(async () => {
        throw new Error('runner should not be called when env resolution fails');
      }) as any,
    });

    expect(r.exitCode).not.toBe(0);
    expect(r.exitCode).not.toBe(1); // distinct from the "no --yes" guard
  });
});