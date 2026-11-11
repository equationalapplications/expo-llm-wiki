/**
 * Retrieval miss attribution (spec targeted-diagnostics §5).
 *
 * SciFact and FinanceBench, read from packages/integration/fixtures, with
 * committed query-embedding sidecars, so the suite needs no fastembed and no
 * network. For each query, the gold rank under keyword-only (hybridWeight 0),
 * the shipped default (hybridWeight unset = pure vector) and a 0.5 hybrid
 * blend, classified into miss classes.
 *
 * Regenerate guards after a deliberate retrieval change:
 *   BENCH_UPDATE_BASELINE=1 pnpm --filter @equationalapplications/benchmarks-llm-wiki test __tests__/retrievalAttribution.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  attribute,
  MISS_CLASSES,
  loadQuerySidecar,
  queryEmbedder,
  type AttributionReport,
  type Dataset,
} from '../src/retrieval/attribution';
import { engineInfo } from '../src/report';

const GUARDS_PATH = join(__dirname, '..', 'fixtures', 'retrieval', 'guards.json');

interface Guards {
  note: string;
  datasets: Record<Dataset, { metric: number; classes: Record<string, number> }>;
}

beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network blocked in diagnostics suite');
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const reports: Partial<Record<Dataset, AttributionReport>> = {};

afterAll(async () => {
  const done = Object.values(reports);
  if (process.env.BENCH_UPDATE_BASELINE === '1' && done.length === 2) {
    const guards: Guards = {
      note: 'Retrieval guards (spec targeted-diagnostics §5): metric = measured - 0.02, miss-class counts = measured + 3. Regenerate with BENCH_UPDATE_BASELINE=1 and say why in the commit.',
      datasets: Object.fromEntries(
        done.map((r) => [
          r.dataset,
          {
            metric: Math.round((r.defaultMode - 0.02) * 1e4) / 1e4,
            classes: Object.fromEntries(MISS_CLASSES.filter((c) => c !== 'hit').map((c) => [c, r.classes[c] + 3])),
          },
        ]),
      ) as Guards['datasets'],
    };
    writeFileSync(GUARDS_PATH, JSON.stringify(guards, null, 1) + '\n');
  }
  if (process.env.BENCH_WRITE_RESULTS === '1' && done.length > 0) {
    const info = await engineInfo();
    const out = join(__dirname, '..', 'results', `retrieval-attribution-${info.gitDescribe}.json`);
    writeFileSync(out, JSON.stringify({ kind: 'retrieval-attribution', engine: info, reports: done }, null, 1) + '\n');
  }
});

describe.each(['scifact', 'financebench'] as const)('%s attribution', (dataset) => {
  let report: AttributionReport;

  beforeAll(async () => {
    report = await attribute(dataset);
    reports[dataset] = report;
    console.log(
      `${dataset} ${report.metric}: keyword=${report.keywordOnly.toFixed(4)} default(vector)=${report.defaultMode.toFixed(4)} hybrid0.5=${report.hybrid.toFixed(4)} rescuedByKeyword=${report.rescuedByKeyword}`,
    );
    console.table(report.classes);
    console.table(report.worst);
  }, 300_000);

  it('classes sum to the query count', () => {
    const sum = Object.values(report.classes).reduce((a, b) => a + b, 0);
    expect(sum).toBe(report.queryCount);
  });

  it('counts keyword rescues of default (vector) misses separately from miss classes', () => {
    // Measured independently by the PR #357 review probe: queries the default
    // misses in the top 10 while keyword-only hits. The miss classes cannot
    // show these, because classify() reports any blend hit as 'hit'.
    expect(report.rescuedByKeyword).toBe(dataset === 'scifact' ? 18 : 1);
  });

  it('stays within the committed guards', () => {
    expect(existsSync(GUARDS_PATH)).toBe(true);
    const g = (JSON.parse(readFileSync(GUARDS_PATH, 'utf8')) as Guards).datasets[dataset];
    expect(report.defaultMode).toBeGreaterThanOrEqual(g.metric);
    // Miss classes only: more hits is an improvement, never a failure.
    for (const c of MISS_CLASSES) if (c !== 'hit') expect(report.classes[c], c).toBeLessThanOrEqual(g.classes[c]!);
  });
});

describe('attribute with an incomplete query sidecar', () => {
  it('throws the re-run message instead of silently falling back to keyword search', async () => {
    const full = loadQuerySidecar('financebench');
    const dropped = [...full.keys()][0]!;
    const partial = new Map([...full].filter(([k]) => k !== dropped));
    await expect(attribute('financebench', { sidecar: partial })).rejects.toThrow(/re-run pnpm fixture:retrieval-queries/);
  }, 300_000);
});

describe('queryEmbedder', () => {
  it('never computes an embedding: a text outside the sidecar throws', async () => {
    await expect(queryEmbedder(new Map())('a query nobody recorded')).rejects.toThrow(/fixture:retrieval-queries/);
  });
});
