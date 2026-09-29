/**
 * Per-question pipeline: ingest → read → answer → judge → record.
 *
 * The pipeline glues together T2's runtime modules, T4's cached ingestion,
 * and T5's answer/judge prompts. Each question is independent so the run
 * is dispatched through a small promise pool of size `concurrency`.
 *
 * `UsageRecorder` is shared across the whole run so call-site totals
 * accumulate correctly even when many questions are in flight at once.
 * The answer and judge providers are each wrapped in `instrument(...)` with
 * a forced call site (`'answer'` / `'judge'`) so their usage lands in the
 * right buckets regardless of system-prompt text.
 *
 * No network IO happens in this module unless the caller passes a real
 * `fetchImpl`; the test harness always passes a fake.
 */

import { WikiMemory, formatContext } from '@equationalapplications/core-llm-wiki';

import { openDb } from '../db';
import { ChatEndpoint, createProvider } from '../provider';
import { UsageRecorder, instrument, CallSite } from '../instrument';
import { ingestQuestion, EngineFlags } from './ingest';
import { buildAnswerPrompt, buildJudgePrompt, parseVerdict } from './judge';
import type { LmeQuestion } from './dataset';
import type { BenchReport, AccuracyByType } from '../report';
import { engineInfo, EMBED_MODEL } from '../report';

const ENTITY = 'lme-user';
/** Default cap on the per-call retrieval candidate set, matching the brief. */
const DEFAULT_MAX_RESULTS = 10;
/** Dataset tag emitted in `sample.dataset`. */
const DATASET_TAG = 'longmemeval';
/** `kind` literal surfaced in the report. */
const REPORT_KIND = 'longmemeval';

type EmbedFn = (text: string) => Promise<number[]>;
type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

export interface RunLongMemEvalOpts {
  questions: LmeQuestion[];
  flags: EngineFlags;
  cacheDir: string;
  engineVersion: string;
  answerEndpoint: ChatEndpoint;
  judgeEndpoint: ChatEndpoint;
  concurrency?: number;
  fetchImpl?: FetchLike;
  embed: EmbedFn;
  /**
   * Optional — T7/T8 hooks will supply a stable sample seed so the report
   * can record the `sample.seed` it was generated from. Default 0 (an
   * arbitrary seed; the call site is responsible for using a real one).
   */
  sampleSeed?: number;
}

/**
 * Linear-interpolated percentile on a sorted-ascending array. `p` is in
 * `[0, 1]`. We use the nearest-rank convention: `Math.ceil(p * n) - 1`,
 * clamped to `[0, n - 1]`. Returns 0 for an empty array.
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

/**
 * Dispatch the `tasks` array through a fixed-size promise pool. The pool
 * preserves input order on the output: `out[i]` corresponds to
 * `tasks[i]`'s result (or rejection). Rejections are surfaced rather than
 * swallowed — a single failing question must abort the whole run.
 */
async function pool<T, R>(tasks: T[], size: number, worker: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(tasks.length);
  let next = 0;
  async function runOne(): Promise<void> {
    const myIndex = next++;
    while (myIndex < tasks.length) {
      out[myIndex] = await worker(tasks[myIndex], myIndex);
      return runOne();
    }
  }
  const workers: Promise<void>[] = [];
  const poolSize = Math.max(1, Math.min(size, tasks.length));
  for (let i = 0; i < poolSize; i++) workers.push(runOne());
  await Promise.all(workers);
  return out;
}

interface QuestionRunResult {
  id: string;
  type: LmeQuestion['question_type'];
  correct: boolean;
  contextTokens: number;
  ingestMs: number;
  answerMs: number;
  cached: boolean;
  judgeOutput: string;
  answer: string;
}

/**
 * Run the full pipeline (ingest → read → answer → judge) for one question.
 *
 * The cached DB file is opened in WAL mode (via {@link openDb}); ingest-side
 * reconciliation has already quiesced, so this is a read-only opening. The
 * `llmProvider` passed to `WikiMemory` is a no-op stub for `generateText` —
 * the harness never asks the engine to call out to an LLM during a read —
 * plus the supplied `embed` so semantic ranking is exercised when present.
 *
 * `ingestMs` wraps `ingestQuestion(...)` and `answerMs` wraps the combined
 * answer + judge LLM calls; the report's `latencyMs.ingest*` and
 * `latencyMs.answer*` percentiles are computed from these two arrays.
 */
async function runOneQuestion(
  q: LmeQuestion,
  ctx: {
    flags: EngineFlags;
    cacheDir: string;
    engineVersion: string;
    embed: EmbedFn;
    answerProvider: ReturnType<typeof instrument>;
    judgeProvider: ReturnType<typeof instrument>;
    ingestProvider: ReturnType<typeof instrument>;
  },
): Promise<QuestionRunResult> {
  const ingestStarted = Date.now();
  const ingestResult = await ingestQuestion(q, {
    flags: ctx.flags,
    provider: { generateText: (p) => ctx.ingestProvider.generateText(p) },
    embed: ctx.embed,
    cacheDir: ctx.cacheDir,
    engineVersion: ctx.engineVersion,
  });
  const ingestMs = Date.now() - ingestStarted;

  const handle = openDb(ingestResult.dbFile);
  try {
    const wiki = new WikiMemory(handle.adapter, {
      llmProvider: {
        generateText: async () => '{}',
        embed: ctx.embed,
      },
    });
    await wiki.setup();

    const readOpts: { maxResults: number } & Record<string, unknown> = {
      maxResults: DEFAULT_MAX_RESULTS,
      ...(ctx.flags.readTokenBudget ? { tokenBudget: ctx.flags.readTokenBudget } : {}),
    };

    const bundle = await wiki.read(ENTITY, q.question, readOpts as any);
    const context = formatContext(bundle, { maxEvents: 0, maxTasks: 0 });
    const contextTokens = Math.ceil(context.length / 4);

    const answerStarted = Date.now();
    const answerPrompt = buildAnswerPrompt(q, context);
    const answerText = await ctx.answerProvider.generateText(answerPrompt);

    const judgePrompt = buildJudgePrompt(q, answerText);
    const judgeOutput = await ctx.judgeProvider.generateText(judgePrompt);
    const correct = parseVerdict(judgeOutput);
    const answerMs = Date.now() - answerStarted;

    return {
      id: q.question_id,
      type: q.question_type,
      correct,
      contextTokens,
      ingestMs,
      answerMs,
      cached: ingestResult.cached,
      judgeOutput,
      answer: answerText,
    };
  } finally {
    handle.close();
  }
}

/**
 * Project the UsageRecorder's totals into the spec's per-site shape (the
 * recorder also tracks `ms`, which the spec does not expose in
 * `BenchReport.tokens`).
 */
function tokensWithoutMs(totals: { [k in CallSite]: { calls: number; inputTokens: number; outputTokens: number; estimatedCalls: number; ms: number } }): Record<CallSite, { calls: number; inputTokens: number; outputTokens: number; estimatedCalls: number }> {
  const out = {} as Record<CallSite, { calls: number; inputTokens: number; outputTokens: number; estimatedCalls: number }>;
  for (const site of Object.keys(totals) as CallSite[]) {
    const r = totals[site];
    out[site] = {
      calls: r.calls,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      estimatedCalls: r.estimatedCalls,
    };
  }
  return out;
}

/**
 * Run the full LongMemEval slice: ingest + answer + judge every question
 * and return a {@link BenchReport} ready to write to disk.
 *
 * The answer and judge providers share a single {@link UsageRecorder} so
 * the call-site totals are aggregated across the whole run. A separate
 * instrumented provider is used for ingest so its calls don't pollute the
 * answer/judge buckets.
 */
export async function runLongMemEval(opts: RunLongMemEvalOpts): Promise<BenchReport> {
  const concurrency = opts.concurrency ?? 4;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);

  const recorder = new UsageRecorder();
  const answerInner = createProvider(opts.answerEndpoint, fetchImpl);
  const judgeInner = createProvider(opts.judgeEndpoint, fetchImpl);
  const ingestInner = createProvider(opts.answerEndpoint, fetchImpl);

  const answerProvider = instrument(answerInner, recorder, 'answer');
  const judgeProvider = instrument(judgeInner, recorder, 'judge');
  const ingestProvider = instrument(ingestInner, recorder, 'other');

  const ctx = {
    flags: opts.flags,
    cacheDir: opts.cacheDir,
    engineVersion: opts.engineVersion,
    embed: opts.embed,
    answerProvider,
    judgeProvider,
    ingestProvider,
  };

  const records = await pool(opts.questions, concurrency, (q) => runOneQuestion(q, ctx));
  const engine = await engineInfo();

  // ----- accuracy -----
  // Initialise every known LmeQuestionType so the report is dense even
  // when a particular stratum is empty in the sample.
  const byType: Record<string, AccuracyByType> = {
    'single-session-user': { correct: 0, total: 0, rate: 0 },
    'single-session-assistant': { correct: 0, total: 0, rate: 0 },
    'single-session-preference': { correct: 0, total: 0, rate: 0 },
    'multi-session': { correct: 0, total: 0, rate: 0 },
    'temporal-reasoning': { correct: 0, total: 0, rate: 0 },
    'knowledge-update': { correct: 0, total: 0, rate: 0 },
  };
  let totalCorrect = 0;
  for (const r of records) {
    const bucket = byType[r.type] ?? { correct: 0, total: 0, rate: 0 };
    bucket.total += 1;
    if (r.correct) {
      bucket.correct += 1;
      totalCorrect += 1;
    }
    bucket.rate = bucket.total === 0 ? 0 : bucket.correct / bucket.total;
    byType[r.type] = bucket;
  }
  const accuracy = {
    overall: records.length === 0 ? 0 : totalCorrect / records.length,
    byType,
  };

  // ----- retrieval -----
  const contextTokens = records.map((r) => r.contextTokens);
  const contextTokensAsc = contextTokens.slice().sort((a, b) => a - b);
  const totalContextTokens = contextTokens.reduce((a, b) => a + b, 0);
  const retrieval = {
    meanContextTokens: records.length === 0 ? 0 : totalContextTokens / records.length,
    p50: percentile(contextTokensAsc, 0.5),
    p95: percentile(contextTokensAsc, 0.95),
  };

  // ----- latency (ingest vs answer split) -----
  const ingestAsc = records.map((r) => r.ingestMs).slice().sort((a, b) => a - b);
  const answerAsc = records.map((r) => r.answerMs).slice().sort((a, b) => a - b);
  const latencyMs = {
    ingestP50: percentile(ingestAsc, 0.5),
    ingestP95: percentile(ingestAsc, 0.95),
    answerP50: percentile(answerAsc, 0.5),
    answerP95: percentile(answerAsc, 0.95),
  };

  // ----- questions -----
  const questions = records.map((r) => ({
    id: r.id,
    type: r.type,
    correct: r.correct,
    contextTokens: r.contextTokens,
  }));

  const cachedIngests = records.reduce((n, r) => (r.cached ? n + 1 : n), 0);

  return {
    kind: REPORT_KIND,
    createdAt: new Date().toISOString(),
    engine: {
      version: engine.version,
      gitSha: engine.gitSha,
      flags: opts.flags,
    },
    models: {
      answer: opts.answerEndpoint.model,
      judge: opts.judgeEndpoint.model,
      embed: EMBED_MODEL,
    },
    sample: {
      seed: opts.sampleSeed ?? 0,
      count: opts.questions.length,
      dataset: DATASET_TAG,
    },
    accuracy,
    tokens: tokensWithoutMs(recorder.totals()),
    retrieval,
    latencyMs,
    cachedIngests,
    questions,
  };
}