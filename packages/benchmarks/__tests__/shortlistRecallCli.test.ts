import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import { runShortlistRecallCommand, REPO_ROOT } from '../src/cli';
import { parseStatementFixture } from '../src/statementKinds/run';
import type { StatementFixtureEntry } from '../src/statementKinds/run';

const fixturePath = new URL('../fixtures/statement-kinds.json', import.meta.url).pathname;
const entries: StatementFixtureEntry[] = parseStatementFixture(readFileSync(fixturePath, 'utf8'));

/** Trivial stub embedder — proves no real model is touched. */
const stubEmbed = async (_text: string): Promise<number[]> => [1, 0, 0];
const stubFactory = async () => stubEmbed;

function tmpOut(): string {
  return join(mkdtempSync(join(tmpdir(), 'slr-')), 'report.json');
}

describe('runShortlistRecallCommand', () => {
  it('--dry-run prints the zero-token estimate and exits 0 without calling the embedder', async () => {
    const lines: string[] = [];
    const embedFactory = vi.fn(stubFactory);
    const r = await runShortlistRecallCommand({
      argv: ['shortlist-recall', '--dry-run'],
      entries,
      embedFactory,
      stdout: (l) => lines.push(l),
    });
    expect(r.exitCode).toBe(0);
    expect(lines.join('\n')).toContain('llm tokens (estimate): 0');
    expect(lines.join('\n')).toContain(`entries: ${entries.length}`);
    // Dry-run short-circuits before the factory and before the guard's embed work.
    expect(embedFactory).not.toHaveBeenCalled();
  });

  it('without --yes prints the estimate and exits 1, having spent nothing', async () => {
    const lines: string[] = [];
    const embedFactory = vi.fn(stubFactory);
    const r = await runShortlistRecallCommand({
      argv: ['shortlist-recall'],
      entries,
      embedFactory,
      stdout: (l) => lines.push(l),
    });
    expect(r.exitCode).toBe(1);
    expect(lines.join('\n')).toContain('--yes');
    expect(embedFactory).not.toHaveBeenCalled();
  });

  it('an unknown command exits 2', async () => {
    const errs: string[] = [];
    const r = await runShortlistRecallCommand({
      argv: ['bogus'],
      entries,
      embedFactory: stubFactory,
      stderr: (l) => errs.push(l),
    });
    expect(r.exitCode).toBe(2);
    expect(errs.join('\n')).toContain('Unknown command: bogus');
  });

  it('with --yes runs the benchmark and writes the report to --out', async () => {
    const out = tmpOut();
    const lines: string[] = [];
    const embedFactory = vi.fn(stubFactory);
    const r = await runShortlistRecallCommand({
      argv: ['shortlist-recall', '--yes', '--out', out],
      entries,
      embedFactory,
      engineVersion: '9.9.9-test',
      stdout: (l) => lines.push(l),
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    expect(report.fixtureEntries).toBe(entries.length);
    expect(report.determinism.embedModel).toBe('fastembed/BGESmallENV15');
    expect(report.determinism.engineVersion).toBe('9.9.9-test');
    expect(report.determinism.fastembedVersion).toBe('3.0.0');
    expect(lines.join('\n')).toContain(out);
    expect(lines.join('\n')).toContain('shortlist recall@k');
    expect(embedFactory).toHaveBeenCalledTimes(1); // factory called exactly once, after the gate
  });

  it('a relative --out resolves against the repo root', async () => {
    const rel = join('packages', 'benchmarks', '.cache', `slr-test-${Date.now()}.json`);
    const lines: string[] = [];
    const r = await runShortlistRecallCommand({
      argv: ['shortlist-recall', '--yes', '--out', rel],
      entries,
      embedFactory: stubFactory,
      engineVersion: '9.9.9-test',
      stdout: (l) => lines.push(l),
    });
    expect(r.exitCode).toBe(0);
    expect(lines.join('\n')).toContain(rel);
    const abs = join(REPO_ROOT, rel);
    expect(existsSync(abs)).toBe(true);
    rmSync(abs);
  });

  it('the embedder factory is never touched when the fixture guard fails', async () => {
    const bad = [{ ...entries[0], expected_target: { title: 'Nope', type: 'area' as const } }];
    const embedFactory = vi.fn(stubFactory);
    const errs: string[] = [];
    const r = await runShortlistRecallCommand({
      argv: ['shortlist-recall', '--yes', '--out', tmpOut()],
      entries: bad,
      embedFactory,
      engineVersion: '9.9.9-test',
      stderr: (l) => errs.push(l),
    });
    expect(r.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('ground-truth guard');
    expect(embedFactory).not.toHaveBeenCalled();
  });
});
