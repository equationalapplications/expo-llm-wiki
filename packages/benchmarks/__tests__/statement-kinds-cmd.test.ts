import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';

import { runStatementKindsCommand } from '../src/cli';
import { loadStatementFixture, STATEMENT_KINDS, SEED_NODES } from '../src/statementKinds/run';

const FIXTURE = join(__dirname, '..', 'fixtures', 'statement-kinds.json');
const entries = loadStatementFixture(FIXTURE);

describe('statement-kinds fixture', () => {
  it('has at least 6 statements per kind and only allowed kinds', () => {
    for (const k of STATEMENT_KINDS) {
      expect(entries.filter((e) => e.expected_kind === k).length).toBeGreaterThanOrEqual(6);
    }
    expect(entries.every((e) => (STATEMENT_KINDS as readonly string[]).includes(e.expected_kind))).toBe(true);
  });

  it('every entry has text and a target that resolves to a seed node', () => {
    const seeds = new Set(SEED_NODES.map((s) => `${s.type}:${s.title}`));
    for (const e of entries) {
      expect(e.text.length).toBeGreaterThan(0);
      expect(seeds.has(`${e.expected_target.type}:${e.expected_target.title}`)).toBe(true);
    }
  });

  it('seeds one node of each target type', () => {
    expect(SEED_NODES.map((s) => s.type).sort()).toEqual(['area', 'organization', 'software_application']);
  });
});

describe('runStatementKindsCommand guard', () => {
  const ENV = { ZAI_API_KEY: 'fake-key', BENCH_BASE_URL: 'https://cli-statement-kinds.test', BENCH_MODEL: 'm' };

  it('--dry-run prints the estimate, exits 0, resolves no key, never fetches', async () => {
    const stdout = vi.fn();
    const fetchImpl = vi.fn();
    const r = await runStatementKindsCommand({
      argv: ['statement-kinds', '--dry-run'],
      env: {},
      entries,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      stdout,
    });
    expect(r.exitCode).toBe(0);
    const out = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toMatch(/input tokens/i);
    expect(out).toContain(`statements: ${entries.length}`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses without --yes and never fetches', async () => {
    const stdout = vi.fn();
    const fetchImpl = vi.fn();
    const r = await runStatementKindsCommand({
      argv: ['statement-kinds'],
      env: { ...ENV },
      entries,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      stdout,
    });
    expect(r.exitCode).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stdout.mock.calls.map((c) => String(c[0])).join('')).toContain('Re-run with --yes to spend these tokens.');
  });
});
