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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import {
  attribute,
  INTEGRATION_FIXTURES,
  MISS_CLASSES,
  loadQuerySidecar,
  queryEmbedder,
  type AttributionReport,
  type Dataset,
} from '../src/retrieval/attribution';
import { engineInfo } from '../src/report';

const GUARDS_PATH = join(__dirname, '..', 'fixtures', 'retrieval', 'guards.json');

interface DatasetGuard {
  metric: number;
  classes: Record<string, number>;
  /** Upper bound: default (vector) misses that keyword-only rescues. */
  rescuedByKeyword: number;
  /** sha256 of packages/integration/fixtures/<dataset>-embeddings.json.gz the query sidecar was built against. */
  corpusEmbeddingsSha256: string;
}

interface Guards {
  note: string;
  datasets: Partial<Record<Dataset, DatasetGuard>>;
}

const GUARDS_NOTE =
  'Retrieval guards (spec targeted-diagnostics §5): metric = measured - 0.02; miss-class counts and rescuedByKeyword = measured + 3; corpusEmbeddingsSha256 pins the corpus the query sidecars match. Regenerate with BENCH_UPDATE_BASELINE=1 and say why in the commit.';

function corpusSha(dataset: Dataset): string {
  return createHash('sha256').update(readFileSync(join(INTEGRATION_FIXTURES, `${dataset}-embeddings.json.gz`))).digest('hex');
}

/** Regenerate this dataset's guard before the guard tests read it, so an update run passes in one go. */
function updateGuard(r: AttributionReport): void {
  const current: Guards = existsSync(GUARDS_PATH)
    ? (JSON.parse(readFileSync(GUARDS_PATH, 'utf8')) as Guards)
    : { note: GUARDS_NOTE, datasets: {} };
  current.note = GUARDS_NOTE;
  current.datasets[r.dataset] = {
    metric: Math.round((r.defaultMode - 0.02) * 1e4) / 1e4,
    classes: Object.fromEntries(MISS_CLASSES.filter((c) => c !== 'hit').map((c) => [c, r.classes[c] + 3])),
    rescuedByKeyword: r.rescuedByKeyword + 3,
    corpusEmbeddingsSha256: corpusSha(r.dataset),
  };
  writeFileSync(GUARDS_PATH, JSON.stringify(current, null, 1) + '\n');
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
  if (process.env.BENCH_WRITE_RESULTS === '1' && done.length > 0) {
    const info = await engineInfo();
    const out = join(__dirname, '..', 'results', `retrieval-attribution-${info.gitDescribe}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ kind: 'retrieval-attribution', engine: info, reports: done }, null, 1) + '\n');
  }
});

describe.each(['scifact', 'financebench'] as const)('%s attribution', (dataset) => {
  let report: AttributionReport;

  beforeAll(async () => {
    report = await attribute(dataset);
    reports[dataset] = report;
    if (process.env.BENCH_UPDATE_BASELINE === '1') updateGuard(report);
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

  it('query sidecar was built against the corpus embeddings in packages/integration', () => {
    // A re-embedded corpus with the same dimension would silently invalidate
    // the query sidecar; only the metric guard would notice.
    const g = (JSON.parse(readFileSync(GUARDS_PATH, 'utf8')) as Guards).datasets[dataset]!;
    expect(corpusSha(dataset)).toBe(g.corpusEmbeddingsSha256);
  });

  it('stays within the committed guards', () => {
    expect(existsSync(GUARDS_PATH)).toBe(true);
    const g = (JSON.parse(readFileSync(GUARDS_PATH, 'utf8')) as Guards).datasets[dataset]!;
    expect(report.defaultMode).toBeGreaterThanOrEqual(g.metric);
    // Upper bound, like the miss classes: fewer rescues (vector found more) never fails.
    expect(report.rescuedByKeyword).toBeLessThanOrEqual(g.rescuedByKeyword);
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

describe('query sidecar generator', () => {
  it('fails the build when an embed error would silently fall back to keyword search', async () => {
    const { recordQueryVectors } = await import('../src/retrieval/buildQueryEmbeddings');
    const { queries } = (await import('../src/retrieval/attribution')).loadQueries('financebench');
    const victim = Object.values(queries)[3]!.trim();
    const fake = async (t: string) => {
      if (t === victim) throw new Error('onnx exploded');
      return new Array(384).fill(0).map((_, i) => (i === t.length % 384 ? 1 : 0));
    };
    await expect(recordQueryVectors('financebench', fake)).rejects.toThrow(/1 query embed failure/);
  }, 300_000);
});
