/**
 * BenchReport shape and helpers.
 *
 * The benchmark pipeline records per-call-site usage (via
 * {@link UsageRecorder}) and per-question verdicts into a single
 * `BenchReport` JSON. The shape here is the contract the CLI writers (T9)
 * and the supersession suite (T7/T8) depend on.
 *
 * `engineInfo()` reads core's package.json to recover the engine version
 * (7.7.7 today) and shells out to `git rev-parse --short HEAD` for the
 * commit the run was made from. The version is read at call time so the
 * reported value always matches the dependency the run was made against,
 * not the build's `engines` field.
 */

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import type { UsageTotals } from './instrument';
import type { EngineFlags } from './longmemeval/ingest';
import type { CallSite } from './instrument';

/**
 * The core package.json lives at `<repo>/packages/core/package.json`. The
 * benchmarks package lives at `<repo>/packages/benchmarks/`, so two `..`s
 * reach the repo root from `__dirname`.
 */
const CORE_PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'package.json');

/**
 * The single embedder this package ships with. The value surfaces in
 * {@link BenchReport.models.embed} so a downstream consumer can tell which
 * vector model produced the candidate scores in the report.
 */
export const EMBED_MODEL = 'fastembed/BGESmallENV15';

/**
 * Read engine version (from core's package.json) and short git SHA (from
 * `git rev-parse --short HEAD`). Async per the published contract even
 * though the body is otherwise I/O-light — keeps the call site consistent
 * with the rest of the pipeline.
 */
export async function engineInfo(cwd: string = process.cwd()): Promise<{ version: string; gitSha: string }> {
  const pkg = JSON.parse(readFileSync(CORE_PACKAGE_JSON, 'utf8')) as { version?: string };
  const version = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  let gitSha: string;
  try {
    gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    gitSha = 'unknown';
  }
  return { version, gitSha };
}

/**
 * Per-type accuracy breakdown. `rate` is the fraction correct in `[0, 1]`
 * (zero when `total === 0`); downstream UIs use it directly without
 * recomputing the division.
 */
export interface AccuracyByType {
  correct: number;
  total: number;
  rate: number;
}

/**
 * The full run report. This is the JSON the CLI writes under
 * `packages/benchmarks/results/<run-name>.json`.
 *
 * Shape is the contract from the brief verbatim; the field order matches
 * the published spec for grep-friendly diffs.
 */
export interface BenchReport {
  kind: 'longmemeval';
  createdAt: string;
  engine: { version: string; gitSha: string; flags: EngineFlags };
  models: { answer: string; judge: string; embed: typeof EMBED_MODEL };
  sample: { seed: number; count: number; dataset: string };
  accuracy: {
    overall: number;
    byType: Record<string, AccuracyByType>;
  };
  tokens: Record<CallSite, { calls: number; inputTokens: number; outputTokens: number; estimatedCalls: number }>;
  retrieval: { meanContextTokens: number; p50: number; p95: number };
  latencyMs: { ingestP50: number; ingestP95: number; answerP50: number; answerP95: number };
  cachedIngests: number;
  questions: Array<{ id: string; type: string; correct: boolean; contextTokens: number }>;
}

export type { UsageTotals };