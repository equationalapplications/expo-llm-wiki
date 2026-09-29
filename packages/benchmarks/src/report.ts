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
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import type { UsageTotals } from './instrument';
import type { EngineFlags } from './longmemeval/ingest';
import type { LmeQuestionType } from './longmemeval/dataset';

export interface EngineInfo {
  version: string;
  gitSha: string;
}

/**
 * The core package.json lives at `<repo>/packages/core/package.json`. The
 * benchmarks package lives at `<repo>/packages/benchmarks/`, so two `..`s
 * reach the repo root from `__dirname`.
 */
const CORE_PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'package.json');

/**
 * Read engine version (from core's package.json) and short git SHA (from
 * `git rev-parse --short HEAD`). Synchronous so it can be called before any
 * async work in the harness without changing the function signature.
 */
export function engineInfo(cwd: string = process.cwd()): EngineInfo {
  const pkg = JSON.parse(readFileSync(CORE_PACKAGE_JSON, 'utf8')) as { version?: string };
  const version = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  let gitSha: string;
  try {
    gitSha = execSync('git rev-parse --short HEAD', { cwd, encoding: 'utf8' }).trim();
  } catch {
    gitSha = 'unknown';
  }
  return { version, gitSha };
}

export interface ModelInfo {
  answer: string;
  judge: string;
}

export interface SampleInfo {
  seed: number;
  questionIds: string[];
}

export interface AccuracyByType {
  correct: number;
  total: number;
}

export interface AccuracyReport {
  overall: number;
  byType: Record<LmeQuestionType, AccuracyByType>;
}

export interface RetrievalReport {
  /** Mean retrieval-payload tokens across the run. */
  avgContextTokens: number;
  /** Max retrieval-payload tokens across the run. */
  maxContextTokens: number;
  /** Sum of retrieval-payload tokens across the run. */
  totalContextTokens: number;
}

export interface LatencyReport {
  p50: number;
  p90: number;
  p99: number;
  /** Total wall-clock spent in the pipeline, in milliseconds. */
  total: number;
}

export interface QuestionRecord {
  questionId: string;
  questionType: LmeQuestionType;
  correct: boolean;
  contextTokens: number;
  latencyMs: number;
  /** True when this question's ingest came from the cache rather than a fresh replay. */
  cached: boolean;
  judgeOutput: string;
  answer: string;
}

/**
 * The full run report. This is the JSON the CLI writes under
 * `packages/benchmarks/results/<run-name>.json`.
 */
export interface BenchReport {
  engine: EngineInfo;
  models: ModelInfo;
  sample: SampleInfo;
  flags: EngineFlags;
  accuracy: AccuracyReport;
  tokens: UsageTotals;
  retrieval: RetrievalReport;
  latencyMs: LatencyReport;
  cachedIngests: number;
  questions: QuestionRecord[];
}

export type { UsageTotals };