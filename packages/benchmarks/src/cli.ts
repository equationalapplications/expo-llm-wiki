/**
 * Benchmarks CLI.
 *
 *   `pnpm --filter @equationalapplications/benchmarks-llm-wiki bench <command>`
 *
 * Subcommands:
 *
 *   sample --seed <n>
 *       Load the LongMemEval_S dataset (cached) and write the stratified
 *       question-id list to `fixtures/longmemeval-sample.json`. The committed
 *       fixture is the canonical sample for PR-0.
 *
 *   longmemeval [--strategy legacy|ops] [--maintenance auto|deferred]
 *               [--read-budget <n>] [--max-questions <n>]
 *               [--dry-run | --yes] [--out <file>]
 *       Run the LongMemEval pipeline against the committed sample. Prints a
 *       one-screen cost estimate (per-question ingest estimate + flat 2000
 *       for answer+judge) and refuses to spend tokens unless `--yes` is set.
 *
 *   supersession [--strategy legacy|ops] [--yes] [--out <file>]
 *       Run the supersession scenarios (Task 8's live runner) under the same
 *       guard: prints the scenario count and a flat per-scenario token
 *       estimate, refuses to spend without `--yes`.
 *
 *   calibrate [--out <file>]
 *       Offline gate-threshold calibration (Task 1 of PR-D2). Walks every
 *       supersession scenario, embeds each candidate against every existing
 *       fact (fastembed — no API cost), labels the candidate's expected class,
 *       and picks the `(novelThreshold, dupThreshold)` pair with the fewest
 *       misclassifications. Writes `results/calibration-<version>.json`.
 *
 *   compare <before.json> <after.json> [--out <file>]
 *       Offline Markdown comparison between two BenchReport JSON files
 *       (Task 2 of PR-D2). Prints the report to stdout (or `--out`) so a
 *       reviewer can read engine / flag / model deltas end-to-end without
 *       rerunning the pipeline.
 *
 * `process.argv` is parsed by hand so the CLI has no dependency footprint.
 * The handler functions return `{ exitCode }` instead of calling `process.exit`
 * so they can be exercised under test without spawning a child process.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';

import { endpointFromEnv, ChatEndpoint } from './provider';
import { engineInfo, BenchReport } from './report';
import { flagsKey, cacheFilePath, EngineFlags } from './longmemeval/ingest';
import { sampleQuestionIds } from './longmemeval/sample';
import { loadDataset, LmeQuestion } from './longmemeval/dataset';
import { runLongMemEval } from './longmemeval/run';
import { runSupersession, Scenario } from './supersession/run';
import { calibrationRows, recommendThresholds, CalibrationRow } from './calibrate';
import { compareReports } from './compare';
import { resolveGateConfig } from '../../core/src/services/librarian/ops/gate';

// --------------------------------------------------------------------------
// Repo-root-relative paths
// --------------------------------------------------------------------------

/**
 * The worktree / repo root, derived from this module's own location
 * (`<root>/packages/benchmarks/src/cli.ts`), so every default path below is
 * correct regardless of the caller's cwd. `pnpm --filter <pkg> bench …`
 * runs package scripts with cwd set to the *package* directory, so joining
 * against `process.cwd()` would double the `packages/benchmarks` prefix and
 * miss the fixtures.
 */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Resolve a `--out` path: absolute paths pass through; relative paths are
 * resolved against {@link REPO_ROOT} so `--out packages/benchmarks/results/x.json`
 * lands in the repo's results directory no matter where the CLI was invoked.
 */
export function resolveOutPath(p: string): string {
  return isAbsolute(p) ? p : join(REPO_ROOT, p);
}

// --------------------------------------------------------------------------
// Argument parsing
// --------------------------------------------------------------------------

export interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(['dry-run', 'yes', 'help']);

/**
 * Hand-rolled `process.argv` parser. The first non-flag token is the
 * command; remaining tokens are `--key value` or `--flag` pairs.
 *
 * Boolean flags (presence-only) are mapped to `true`. Value flags capture
 * the immediately following token — a value is consumed only when it does
 * not start with `--`, so `--strategy ops --dry-run` does not eat `--dry-run`
 * as the strategy value.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { command: '', flags: {} };
  let i = 0;
  // Skip a leading process.argv[0]/[1] only if it looks like a node invocation
  // (caller may pass either the full argv or just the slice after the binary).
  if (argv.length > 0 && (argv[0].endsWith('node') || argv[0].endsWith('tsx') || argv[0].endsWith('cli.ts'))) {
    i += 1;
  }
  for (; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith('--')) {
        out.flags[key] = true;
      } else {
        out.flags[key] = next;
        i += 1;
      }
    } else if (out.command === '') {
      out.command = tok;
    }
    // Bare non-flag tokens after the command are ignored.
  }
  return out;
}

// --------------------------------------------------------------------------
// Cost estimate
// --------------------------------------------------------------------------

/**
 * Per-question ingest token estimate plus a flat 2 000 for answer+judge.
 *
 *   `Σ_questions( ceil(Σ_turns(content.length) / 4) + 2000 )`
 *
 * Ingestion is the dominant cost driver — the haystack sessions contribute
 * most of the tokens. Answer + judge are short prompts capped at 2 000
 * input tokens per question by the GLM 5.3 Flash defaults; the flat 2 000
 * is a deliberate overestimate so the printed estimate is conservative.
 */
export function estimateIngestTokens(questions: LmeQuestion[]): number {
  let total = 0;
  for (const q of questions) {
    let chars = 0;
    for (const session of q.haystack_sessions) {
      for (const turn of session) {
        chars += turn.content.length;
      }
    }
    total += Math.ceil(chars / 4) + 2000;
  }
  return total;
}

// --------------------------------------------------------------------------
// Cached-question probe
// --------------------------------------------------------------------------

function cacheFileFor(cacheDir: string, engineVersion: string, flags: EngineFlags, questionId: string): string {
  return cacheFilePath(cacheDir, engineVersion, flags, questionId);
}

/**
 * Count how many of the supplied `questionIds` already have a complete
 * ingest cache file for the (engineVersion, flags) tuple.
 */
function countCachedQuestions(cacheDir: string, engineVersion: string, flags: EngineFlags, questionIds: string[]): number {
  let n = 0;
  for (const id of questionIds) {
    if (existsSync(cacheFileFor(cacheDir, engineVersion, flags, id))) {
      n += 1;
    }
  }
  return n;
}

// --------------------------------------------------------------------------
// longmemeval subcommand
// --------------------------------------------------------------------------

export interface LongMemEvalDeps {
  argv: string[];
  /** Injected to keep tests off the filesystem / network. */
  env?: Record<string, string | undefined>;
  sampleIds?: string[];
  /**
   * The seed the sample ids were drawn with (read from the committed
   * fixture); recorded in the report's `sample.seed` field. Defaults to 0
   * when the caller does not supply one.
   */
  sampleSeed?: number;
  dataset?: LmeQuestion[];
  cacheDir?: string;
  embed: (t: string) => Promise<number[]>;
  concurrency?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /**
   * Injected runner override; defaults to `runLongMemEval`. Tests pass a
   * `vi.fn` so a successful run can be exercised without spending tokens.
   */
  runImpl?: typeof runLongMemEval;
}

export interface CommandResult {
  exitCode: number;
}

const DEFAULT_RESULTS_DIR = 'packages/benchmarks/results/raw';

function nowStamp(): string {
  // ISO 8601 → `YYYYMMDDTHHMMSS` so it's filesystem-safe.
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
}

function defaultResultsDir(): string {
  return join(REPO_ROOT, DEFAULT_RESULTS_DIR);
}

function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

/**
 * Handle the `longmemeval` subcommand. Returns the exit code instead of
 * calling `process.exit(...)` so tests can drive it without spawning a child.
 *
 * Flow:
 *   1. parse argv
 *   2. resolve flags (`--strategy`, `--maintenance`, `--read-budget`,
 *      `--max-questions`, `--dry-run`, `--yes`, `--out`)
 *   3. (after this point, optional `--dry-run` short-circuits before any
 *      env resolution)
 *   4. resolve endpoints via `endpointFromEnv` (fails fast on no key)
 *   5. load dataset + sample ids; filter by sample ids; cap by `--max-questions`
 *   6. print estimate (engine, flags, models, count, tokens, cached)
 *   7. `--dry-run` → exit 0
 *   8. without `--yes` → print warning, exit 1
 *   9. run, write report, print summary table
 */
export async function runLongMemEvalCommand(deps: LongMemEvalDeps): Promise<CommandResult> {
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(line));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(line));
  const { argv } = deps;
  const parsed = parseArgs(argv);
  if (parsed.command !== 'longmemeval' && parsed.command !== '') {
    stderr(`Unknown command: ${parsed.command}\n`);
    return { exitCode: 2 };
  }

  const dryRun = parsed.flags['dry-run'] === true;
  const yes = parsed.flags.yes === true;
  const outArg = typeof parsed.flags.out === 'string' ? parsed.flags.out : undefined;
  const maxQuestionsRaw = typeof parsed.flags['max-questions'] === 'string' ? parsed.flags['max-questions'] : undefined;
  const maxQuestions = maxQuestionsRaw ? Math.max(0, Math.floor(Number(maxQuestionsRaw))) : undefined;
  const strategy = parsed.flags.strategy === 'ops' ? 'ops' : 'legacy';
  const maintenance = parsed.flags.maintenance === 'deferred' ? 'deferred' : 'auto';
  const readBudgetRaw = typeof parsed.flags['read-budget'] === 'string' ? parsed.flags['read-budget'] : undefined;
  const readTokenBudget = readBudgetRaw ? Math.max(0, Math.floor(Number(readBudgetRaw))) : undefined;

  const flags: EngineFlags = {
    strategy,
    maintenance,
    ...(readTokenBudget ? { readTokenBudget } : {}),
  };

  // `--dry-run` short-circuits before any endpoint / dataset / filesystem IO
  // so a missing API key does not fail a dry run.
  if (dryRun) {
    const engine = await engineInfo();
    // Estimate the same question set the live run would process — the sample
    // ids ∩ dataset — not the whole dataset (≈500 questions; the estimate
    // would over-state the spend by more than 6x).
    const datasetById = new Map((deps.dataset ?? []).map((q) => [q.question_id, q]));
    const dryRunQuestions = (deps.sampleIds ?? [])
      .map((id) => datasetById.get(id))
      .filter((q): q is LmeQuestion => q !== undefined);
    const questionCount = dryRunQuestions.length;
    const tokenEstimate = estimateIngestTokens(dryRunQuestions);
    stdout(renderEstimate({
      engine,
      flags,
      answerModel: '(dry-run: not resolved)',
      judgeModel: '(dry-run: not resolved)',
      questionCount,
      cachedCount: 0,
      tokenEstimate,
    }));
    return { exitCode: 0 };
  }

  // After this point any failure mode other than the cost guard is fatal.
  let answerEndpoint: ChatEndpoint;
  let judgeEndpoint: ChatEndpoint;
  try {
    answerEndpoint = endpointFromEnv('BENCH', deps.env);
    judgeEndpoint = endpointFromEnv('BENCH_JUDGE', deps.env);
  } catch (e) {
    stderr(`${(e as Error).message}\n`);
    return { exitCode: 2 };
  }

  if (!deps.dataset || !deps.sampleIds) {
    stderr('Internal error: dataset and sampleIds must be provided by the caller\n');
    return { exitCode: 2 };
  }
  const cacheDir = deps.cacheDir ?? join(process.cwd(), 'packages', 'benchmarks', '.cache');
  const dataset = deps.dataset;
  const sampleIds = deps.sampleIds;
  const byId = new Map(dataset.map((q) => [q.question_id, q]));
  const filtered = sampleIds
    .map((id) => byId.get(id))
    .filter((q): q is LmeQuestion => q !== undefined);
  const questions = maxQuestions !== undefined ? filtered.slice(0, maxQuestions) : filtered;

  const engine = await engineInfo();
  const cachedCount = countCachedQuestions(cacheDir, engine.version, flags, questions.map((q) => q.question_id));
  const tokenEstimate = estimateIngestTokens(questions);

  stdout(renderEstimate({
    engine,
    flags,
    answerModel: answerEndpoint.model,
    judgeModel: judgeEndpoint.model,
    questionCount: questions.length,
    cachedCount,
    tokenEstimate,
  }));

  if (!yes) {
    stdout('Re-run with --yes to spend these tokens.\n');
    return { exitCode: 1 };
  }

  // Spend-approved: run the pipeline.
  const runner = deps.runImpl ?? runLongMemEval;
  const report: BenchReport = await runner({
    questions,
    flags,
    cacheDir,
    engineVersion: engine.version,
    answerEndpoint,
    judgeEndpoint,
    concurrency: deps.concurrency,
    embed: deps.embed,
    ...(deps.sampleSeed !== undefined ? { sampleSeed: deps.sampleSeed } : {}),
  });

  // Write the report. Default path: `results/raw/longmemeval-<version>-<flagsKey>-<timestamp>.json`.
  const reportFile = outArg ? resolveOutPath(outArg) : join(defaultResultsDir(), `longmemeval-${engine.version}-${flagsKey(flags)}-${nowStamp()}.json`);
  ensureDir(reportFile);
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  stdout(`\nWrote report to ${reportFile}\n\n`);
  stdout(renderSummaryTable(report));
  return { exitCode: 0 };
}

// --------------------------------------------------------------------------
// sample subcommand
// --------------------------------------------------------------------------

export interface SampleDeps {
  argv: string[];
  /** Override the cache directory used by `loadDataset`. */
  cacheDir?: string;
  /** Override the dataset URL. */
  url?: string;
  /** Override the output file path. */
  outFile?: string;
  /** Override the fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Override stdout. */
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const DEFAULT_SAMPLE_FILE = 'packages/benchmarks/fixtures/longmemeval-sample.json';

/**
 * Handle the `sample` subcommand. Loads the dataset, runs the stratified
 * sampler with the supplied seed, and writes
 * `fixtures/longmemeval-sample.json` (or the override).
 */
export async function runSampleCommand(deps: SampleDeps): Promise<CommandResult> {
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(line));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(line));
  const parsed = parseArgs(deps.argv);
  const seedRaw = typeof parsed.flags.seed === 'string' ? parsed.flags.seed : undefined;
  if (seedRaw === undefined) {
    stderr('sample: --seed <n> is required\n');
    return { exitCode: 2 };
  }
  const seed = Math.floor(Number(seedRaw));
  if (!Number.isFinite(seed)) {
    stderr(`sample: --seed must be a finite integer (got ${seedRaw})\n`);
    return { exitCode: 2 };
  }

  const dataset = await loadDataset({
    ...(deps.cacheDir ? { cacheDir: deps.cacheDir } : {}),
    ...(deps.url ? { url: deps.url } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const ids = sampleQuestionIds(dataset, seed);
  const url = deps.url ?? process.env.BENCH_LONGMEMEVAL_URL ?? 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json';
  const payload = JSON.stringify({ seed, dataset: url, ids }, null, 2);

  const outFile = deps.outFile ?? join(REPO_ROOT, DEFAULT_SAMPLE_FILE);
  ensureDir(outFile);
  writeFileSync(outFile, payload);
  stdout(`Wrote ${ids.length} ids to ${outFile}\n`);
  return { exitCode: 0 };
}

// --------------------------------------------------------------------------
// supersession subcommand
// --------------------------------------------------------------------------

export interface SupersessionDeps {
  argv: string[];
  /** Injected to keep tests off the filesystem / network. */
  env?: Record<string, string | undefined>;
  /** The scenarios from `fixtures/supersession/scenarios.json`. */
  scenarios?: Scenario[];
  /** Injected embedder (fastembed singleton in live mode). */
  embed?: (text: string) => Promise<number[]>;
  /** Injected fetch so tests never touch the network. */
  fetchImpl?: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/**
 * Conservative flat per-scenario input-token estimate for the printed cost
 * guard. A scenario is a handful of short events feeding the librarian (plus
 * a heal pass for legacy), so a few calls at a few hundred tokens each —
 * 6 000 is a deliberate overestimate so the printed number errs high.
 */
const SUPERSESSION_TOKENS_PER_SCENARIO = 6000;

/**
 * Handle the `supersession` subcommand (Task 8's live runner).
 *
 * Flow mirrors `longmemeval`:
 *   1. parse argv (`--strategy`, `--dry-run`, `--yes`, `--out`)
 *   2. `--dry-run` short-circuits before endpoint resolution
 *   3. resolve the answer endpoint via `endpointFromEnv('BENCH')` (fails fast
 *      on no key)
 *   4. print the estimate (scenario count + flat per-scenario tokens)
 *   5. without `--yes` → print warning, exit 1
 *   6. run `runSupersession`, write the report, print the pass count
 */
export async function runSupersessionCommand(deps: SupersessionDeps): Promise<CommandResult> {
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(line));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(line));
  const parsed = parseArgs(deps.argv);
  if (parsed.command !== 'supersession' && parsed.command !== '') {
    stderr(`Unknown command: ${parsed.command}\n`);
    return { exitCode: 2 };
  }
  const dryRun = parsed.flags['dry-run'] === true;
  const yes = parsed.flags.yes === true;
  const outArg = typeof parsed.flags.out === 'string' ? parsed.flags.out : undefined;
  const strategy = parsed.flags.strategy === 'ops' ? 'ops' : 'legacy';

  if (!deps.scenarios || !deps.embed) {
    stderr('Internal error: scenarios and embed must be provided by the caller\n');
    return { exitCode: 2 };
  }

  const runnable = deps.scenarios.filter((s) => !s.liveSkip);
  const skipped = deps.scenarios.length - runnable.length;
  const tokenEstimate = runnable.length * SUPERSESSION_TOKENS_PER_SCENARIO;

  const printEstimate = (answerModel: string): void => {
    const lines = [
      `flags: strategy=${strategy}`,
      `model: ${answerModel}`,
      `scenarios:  ${runnable.length} to run (${skipped} liveSkip skipped)`,
      `input tokens (estimate): ${tokenEstimate.toLocaleString('en-US')}`,
    ];
    stdout(lines.join('\n') + '\n');
  };

  if (dryRun) {
    printEstimate('(dry-run: not resolved)');
    return { exitCode: 0 };
  }

  // After this point any failure mode other than the cost guard is fatal.
  let endpoint: ChatEndpoint;
  try {
    endpoint = endpointFromEnv('BENCH', deps.env);
  } catch (e) {
    stderr(`${(e as Error).message}\n`);
    return { exitCode: 2 };
  }

  printEstimate(endpoint.model);
  if (!yes) {
    stdout('Re-run with --yes to spend these tokens.\n');
    return { exitCode: 1 };
  }

  // Spend-approved: run the live supersession suite.
  const report = await runSupersession({
    scenarios: deps.scenarios,
    strategy,
    endpoint,
    embed: deps.embed,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  // Default path: `results/raw/supersession-<version>-<strategy>-<timestamp>.json`.
  const engine = await engineInfo();
  const reportFile = outArg ? resolveOutPath(outArg) : join(defaultResultsDir(), `supersession-${engine.version}-${strategy}-${nowStamp()}.json`);
  ensureDir(reportFile);
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  stdout(`\nWrote report to ${reportFile}\n\n`);
  stdout(`Supersession (${strategy}): ${report.passed}/${report.total} passed (${report.skipped} liveSkip skipped)\n`);
  return { exitCode: 0 };
}

// --------------------------------------------------------------------------
// calibrate subcommand
// --------------------------------------------------------------------------

export interface CalibrateDeps {
  argv: string[];
  /** The scenarios from `fixtures/supersession/scenarios.json`. */
  scenarios?: Scenario[];
  /** Injected embedder (fastembed singleton in live mode). */
  embed?: (text: string) => Promise<number[]>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/**
 * Shape of the JSON written to `results/calibration-<engineVersion>.json`.
 * The CLI's job is to print a one-screen summary and persist this object so a
 * later `fix(core): calibrate ops gate defaults (<numbers>)` commit (if the
 * numbers warrant it) can quote the same source-of-truth numbers in its body.
 */
export interface CalibrationResult {
  kind: 'calibration';
  createdAt: string;
  engine: { version: string; gitSha: string };
  scenarioCount: number;
  rowCount: number;
  novelThreshold: number;
  dupThreshold: number;
  misclassifiedAtDefaults: number;
  misclassifiedAtRecommended: number;
  defaultsConfirmed: boolean;
  rows: CalibrationRow[];
}

/**
 * Format one calibration row for stdout.
 */
function renderCalibrationRow(r: CalibrationRow): string {
  const cos = r.bestCosine === null ? '   null' : r.bestCosine.toFixed(2).padStart(5);
  const jac = r.titleJaccard === null ? '   null' : r.titleJaccard.toFixed(2).padStart(5);
  return `  ${r.scenario.padEnd(46)} ${r.candidate.padEnd(40)} ${cos} ${jac}  expected=${r.expected}`;
}

/**
 * Handle the `calibrate` subcommand.
 *
 * Offline pass:
 *   1. parse argv (`--out`)
 *   2. resolve scenarios + embedder
 *   3. walk every scenario and produce calibration rows (no API cost —
 *      fastembed runs locally on ONNX)
 *   4. call `recommendThresholds` to find the best pair
 *   5. print the row table + recommendation + defaults-confirmed flag
 *   6. write `results/calibration-<engineVersion>.json`
 *
 * The result is committed so a follow-up `fix(core)` commit can quote the
 * numbers directly without re-running the embedder.
 */
export async function runCalibrateCommand(deps: CalibrateDeps): Promise<CommandResult> {
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(line));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(line));
  const parsed = parseArgs(deps.argv);
  if (parsed.command !== 'calibrate' && parsed.command !== '') {
    stderr(`Unknown command: ${parsed.command}\n`);
    return { exitCode: 2 };
  }
  const outArg = typeof parsed.flags.out === 'string' ? parsed.flags.out : undefined;

  if (!deps.scenarios || !deps.embed) {
    stderr('Internal error: scenarios and embed must be provided by the caller\n');
    return { exitCode: 2 };
  }

  const engine = await engineInfo();
  stdout(`engine: ${engine.version} (${engine.gitSha})\n`);
  stdout(`scenarios: ${deps.scenarios.length}\n\n`);

  const rows = await calibrationRows(deps.scenarios, deps.embed);
  const rec = recommendThresholds(rows);
  const defaults = resolveGateConfig();
  const defaultsConfirmed = rec.misclassifiedAtDefaults <= rec.misclassifiedAtRecommended;

  stdout('Calibration rows (bestCosine, titleJaccard, expected):\n');
  for (const r of rows) stdout(renderCalibrationRow(r) + '\n');
  stdout('\n');
  stdout(`defaults:      dupThreshold=${defaults.dupThreshold.toFixed(2)}  novelThreshold=${defaults.novelThreshold.toFixed(2)}   misclassified=${rec.misclassifiedAtDefaults}\n`);
  stdout(`recommended:   dupThreshold=${rec.dupThreshold.toFixed(2)}  novelThreshold=${rec.novelThreshold.toFixed(2)}   misclassified=${rec.misclassifiedAtRecommended}\n`);
  stdout(`defaults confirmed: ${defaultsConfirmed ? 'yes' : 'no — change defaults'}\n\n`);

  const result: CalibrationResult = {
    kind: 'calibration',
    createdAt: new Date().toISOString(),
    engine: { version: engine.version, gitSha: engine.gitSha },
    scenarioCount: deps.scenarios.length,
    rowCount: rows.length,
    novelThreshold: rec.novelThreshold,
    dupThreshold: rec.dupThreshold,
    misclassifiedAtDefaults: rec.misclassifiedAtDefaults,
    misclassifiedAtRecommended: rec.misclassifiedAtRecommended,
    defaultsConfirmed,
    rows,
  };

  // Default path: `results/calibration-<engineVersion>.json` (committed so a
  // follow-up `fix(core)` commit can quote the same numbers).
  const resultFile = outArg ? resolveOutPath(outArg) : join(REPO_ROOT, 'packages', 'benchmarks', 'results', `calibration-${engine.version}.json`);
  ensureDir(resultFile);
  writeFileSync(resultFile, JSON.stringify(result, null, 2));
  stdout(`Wrote calibration result to ${resultFile}\n`);
  return { exitCode: 0 };
}

// --------------------------------------------------------------------------
// compare subcommand
// --------------------------------------------------------------------------

export interface CompareDeps {
  argv: string[];
  /** Override the filesystem read so tests can pass reports inline. */
  readFile?: (path: string) => string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/**
 * Parse the two positional paths (`before`, `after`) plus `--out` out of an
 * argv slice. The first token is the `compare` verb and is skipped. The
 * remaining `--flag value` pairs populate `out`; the remaining bare tokens
 * are the positional paths (first two).
 */
function parseCompareArgs(argv: string[]): { before: string; after: string; out?: string } {
  const positional: string[] = [];
  let out: string | undefined;
  // Skip a leading node-style binary token, mirroring `parseArgs`.
  const startIdx = argv.length > 0 && (argv[0].endsWith('node') || argv[0].endsWith('tsx') || argv[0].endsWith('cli.ts')) ? 1 : 0;
  for (let i = startIdx; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === 'compare') {
      // skip the verb
      continue;
    }
    if (tok.startsWith('--')) {
      if (tok === '--out') {
        const v = argv[i + 1];
        if (v && !v.startsWith('--')) {
          out = v;
          i += 1;
        }
      }
      // other flags are ignored
    } else {
      positional.push(tok);
    }
  }
  const [before, after] = positional;
  return { before, after, out };
}

/**
 * Handle the `compare` subcommand (Task 2 of PR-D2). Reads two
 * BenchReport JSON files from disk and prints a Markdown comparison.
 *
 * Flow:
 *   1. parse argv (positional before/after, optional `--out`)
 *   2. validate both paths were provided
 *   3. read + JSON.parse both files
 *   4. invoke `compareReports(...)`
 *   5. print to stdout (or write to `--out`)
 */
export async function runCompareCommand(deps: CompareDeps): Promise<CommandResult> {
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(line));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(line));
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const parsed = parseArgs(deps.argv);
  if (parsed.command !== 'compare' && parsed.command !== '') {
    stderr(`Unknown command: ${parsed.command}\n`);
    return { exitCode: 2 };
  }
  // Re-parse the raw argv so positional args (after the `compare` verb)
  // survive — `parseArgs` above only captured the verb + flags.
  const positional = parseCompareArgs(deps.argv);
  if (!positional.before || !positional.after) {
    stderr('compare: <before.json> <after.json> required\n');
    return { exitCode: 2 };
  }
  const outArg = positional.out;

  let beforeReport: BenchReport;
  let afterReport: BenchReport;
  try {
    beforeReport = JSON.parse(readFile(positional.before)) as BenchReport;
    afterReport = JSON.parse(readFile(positional.after)) as BenchReport;
  } catch (e) {
    stderr(`compare: failed to read or parse reports — ${(e as Error).message}\n`);
    return { exitCode: 2 };
  }

  const md = compareReports(beforeReport, afterReport);
  if (outArg) {
    const outFile = resolveOutPath(outArg);
    ensureDir(outFile);
    writeFileSync(outFile, md);
    stdout(`Wrote comparison to ${outFile}\n`);
  } else {
    stdout(md);
    if (!md.endsWith('\n')) stdout('\n');
  }
  return { exitCode: 0 };
}

// --------------------------------------------------------------------------
// Helpers — printed estimate + summary table
// --------------------------------------------------------------------------

interface EstimateArgs {
  engine: { version: string; gitSha: string };
  flags: EngineFlags;
  answerModel: string;
  judgeModel: string;
  questionCount: number;
  cachedCount: number;
  tokenEstimate: number;
}

function renderEstimate(args: EstimateArgs): string {
  const lines = [
    `engine: ${args.engine.version} (${args.engine.gitSha})`,
    `flags: strategy=${args.flags.strategy} maintenance=${args.flags.maintenance}` +
      (args.flags.readTokenBudget ? ` read-budget=${args.flags.readTokenBudget}` : ''),
    `answer model: ${args.answerModel}`,
    `judge model:  ${args.judgeModel}`,
    `questions:    ${args.questionCount} (cached ingests: ${args.cachedCount})`,
    `input tokens (estimate): ${args.tokenEstimate.toLocaleString('en-US')}`,
  ];
  return lines.join('\n') + '\n';
}

function renderSummaryTable(report: BenchReport): string {
  const lines: string[] = [];
  lines.push('Per-type accuracy:');
  const types = Object.keys(report.accuracy.byType);
  for (const t of types) {
    const b = report.accuracy.byType[t];
    lines.push(`  ${t.padEnd(28)} ${b.correct}/${b.total}  (${(b.rate * 100).toFixed(1)}%)`);
  }
  lines.push('');
  lines.push(`Overall accuracy:           ${(report.accuracy.overall * 100).toFixed(1)}%`);
  lines.push(`Cached ingests:             ${report.cachedIngests} / ${report.questions.length}`);
  lines.push(`Answer calls / tokens:      ${report.tokens.answer.calls} / ${report.tokens.answer.inputTokens + report.tokens.answer.outputTokens}`);
  lines.push(`Judge calls / tokens:       ${report.tokens.judge.calls} / ${report.tokens.judge.inputTokens + report.tokens.judge.outputTokens}`);
  lines.push(`Latency (ms): ingest p50=${report.latencyMs.ingestP50} p95=${report.latencyMs.ingestP95}; answer p50=${report.latencyMs.answerP50} p95=${report.latencyMs.answerP95}`);
  return lines.join('\n') + '\n';
}

// --------------------------------------------------------------------------
// CLI entry point
// --------------------------------------------------------------------------

function readCommittedSample(fixturesDir: string): { seed: number; ids: string[] } {
  const file = join(fixturesDir, 'longmemeval-sample.json');
  if (!existsSync(file)) {
    throw new Error(`sample fixture not found at ${file}; run \`bench sample --seed <n>\` first`);
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { seed?: unknown; ids?: unknown };
  if (!Array.isArray(parsed.ids) || !parsed.ids.every((x) => typeof x === 'string')) {
    throw new Error(`sample fixture at ${file} is malformed`);
  }
  const seed = typeof parsed.seed === 'number' ? parsed.seed : 0;
  return { seed, ids: parsed.ids as string[] };
}

/**
 * CLI entry point. The exit code is communicated via `process.exitCode`
 * (not `process.exit`): the fastembed/onnxruntime session must be torn
 * down by a natural event-loop drain — calling `process.exit` while the
 * ORT session is alive aborts the process with
 * `mutex lock failed: Invalid argument` *after* the work is done, which
 * pnpm/CI would read as a failed run.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const command = parsed.command;
  if (command === '' || parsed.flags.help === true) {
    process.stdout.write(renderHelp());
    return;
  }
  if (command === 'sample') {
    const r = await runSampleCommand({ argv });
    process.exitCode = r.exitCode;
    return;
  }
  if (command === 'longmemeval') {
    const fixturesDir = join(REPO_ROOT, 'packages', 'benchmarks', 'fixtures');
    const { seed, ids: sampleIds } = readCommittedSample(fixturesDir);
    const { getEmbedder } = await import('./embed');
    const embed = await getEmbedder();
    const dataset = await loadDataset();
    const cacheDir = join(REPO_ROOT, 'packages', 'benchmarks', '.cache');
    const concurrencyRaw = process.env.BENCH_CONCURRENCY;
    const concurrency = concurrencyRaw ? Math.max(1, Math.floor(Number(concurrencyRaw))) : undefined;
    const r = await runLongMemEvalCommand({
      argv,
      sampleIds,
      sampleSeed: seed,
      dataset,
      cacheDir,
      embed,
      ...(concurrency ? { concurrency } : {}),
    });
    process.exitCode = r.exitCode;
    return;
  }
  if (command === 'supersession') {
    const scenariosFile = join(REPO_ROOT, 'packages', 'benchmarks', 'fixtures', 'supersession', 'scenarios.json');
    const scenarios = JSON.parse(readFileSync(scenariosFile, 'utf8')) as Scenario[];
    const { getEmbedder } = await import('./embed');
    const embed = await getEmbedder();
    const r = await runSupersessionCommand({ argv, scenarios, embed });
    process.exitCode = r.exitCode;
    return;
  }
  if (command === 'calibrate') {
    const scenariosFile = join(REPO_ROOT, 'packages', 'benchmarks', 'fixtures', 'supersession', 'scenarios.json');
    const scenarios = JSON.parse(readFileSync(scenariosFile, 'utf8')) as Scenario[];
    const { getEmbedder } = await import('./embed');
    const embed = await getEmbedder();
    const r = await runCalibrateCommand({ argv, scenarios, embed });
    process.exitCode = r.exitCode;
    return;
  }
  if (command === 'compare') {
    const r = await runCompareCommand({ argv });
    process.exitCode = r.exitCode;
    return;
  }
  process.stderr.write(`Unknown command: ${command}\n${renderHelp()}`);
  process.exitCode = 2;
}

function renderHelp(): string {
  return [
    'Usage: bench <command> [flags]',
    '',
    'Commands:',
    '  sample --seed <n>              Write fixtures/longmemeval-sample.json',
    '  longmemeval [flags]            Run the LongMemEval pipeline',
    '  supersession [flags]           Run the supersession suite (Task 8)',
    '  calibrate [--out <file>]        Offline gate-threshold calibration (Task 1 of PR-D2)',
    '  compare <before.json> <after.json> [--out <file>]',
    '                                  Offline Markdown comparison (Task 2 of PR-D2)',
    '',
    'Common flags:',
    '  --strategy <legacy|ops>        Librarian strategy (default legacy)',
    '  --maintenance <auto|deferred>  Maintenance mode (default auto)',
    '  --read-budget <n>              Read-side token budget',
    '  --max-questions <n>            Cap the question list',
    '  --dry-run                      Print the estimate and exit 0',
    '  --yes                          Confirm token spend',
    '  --out <file>                   Report output path',
    '',
  ].join('\n');
}

// Run `main` only when this file is the entry point. The exported symbols
// stay available for tests.
const invokedDirectly = (() => {
  try {
    const here = fileURLToPath(import.meta.url);
    const entry = process.argv[1] ? resolve(process.argv[1]) : '';
    return here === entry;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // Set exitCode rather than letting the rejection go unhandled: an
  // unhandled-rejection exit with the ONNX session live aborts natively
  // (see the docblock on main()).
  main().catch((e: unknown) => {
    process.stderr.write(`bench: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  });
}

// Helper for the entry-point detection above.
function resolve(p: string): string {
  // Resolve absolute paths; leave relative ones as-is. We avoid `path.resolve`
  // here so this file's helpers stay minimal.
  if (p.startsWith('/')) return p;
  return join(process.cwd(), p);
}