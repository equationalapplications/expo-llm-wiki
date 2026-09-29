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
import { UsageRecorder, instrument } from '../instrument';
import { ingestQuestion, EngineFlags } from './ingest';
import { buildAnswerPrompt, buildJudgePrompt, parseVerdict } from './judge';
import type { LmeQuestion } from './dataset';
import type {
  BenchReport,
  QuestionRecord,
  AccuracyReport,
  RetrievalReport,
  LatencyReport,
} from '../report';
import { engineInfo, ModelInfo, AccuracyByType } from '../report';

const ENTITY = 'lme-user';
/** Default cap on the per-call retrieval candidate set, matching the brief. */
const DEFAULT_MAX_RESULTS = 10;

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
  questionId: string;
  questionType: LmeQuestion['question_type'];
  correct: boolean;
  contextTokens: number;
  latencyMs: number;
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
  const started = Date.now();
  const ingestResult = await ingestQuestion(q, {
    flags: ctx.flags,
    provider: { generateText: (p) => ctx.ingestProvider.generateText(p) },
    embed: ctx.embed,
    cacheDir: ctx.cacheDir,
    engineVersion: ctx.engineVersion,
  });

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

    const answerPrompt = buildAnswerPrompt(q, context);
    const answerText = await ctx.answerProvider.generateText(answerPrompt);

    const judgePrompt = buildJudgePrompt(q, answerText);
    const judgeOutput = await ctx.judgeProvider.generateText(judgePrompt);
    const correct = parseVerdict(judgeOutput);

    return {
      questionId: q.question_id,
      questionType: q.question_type,
      correct,
      contextTokens,
      latencyMs: Date.now() - started,
      cached: ingestResult.cached,
      judgeOutput,
      answer: answerText,
    };
  } finally {
    handle.close();
  }
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

  // ----- accuracy -----
  const byType: Record<LmeQuestion['question_type'], AccuracyByType> = {
    'single-session-user': { correct: 0, total: 0 },
    'single-session-assistant': { correct: 0, total: 0 },
    'single-session-preference': { correct: 0, total: 0 },
    'multi-session': { correct: 0, total: 0 },
    'temporal-reasoning': { correct: 0, total: 0 },
    'knowledge-update': { correct: 0, total: 0 },
  };
  let totalCorrect = 0;
  for (const r of records) {
    byType[r.questionType].total += 1;
    if (r.correct) {
      byType[r.questionType].correct += 1;
      totalCorrect += 1;
    }
  }
  const accuracy: AccuracyReport = {
    overall: records.length === 0 ? 0 : totalCorrect / records.length,
    byType,
  };

  // ----- retrieval -----
  const contextTokens = records.map((r) => r.contextTokens);
  const totalContextTokens = contextTokens.reduce((a, b) => a + b, 0);
  const retrieval: RetrievalReport = {
    avgContextTokens: records.length === 0 ? 0 : totalContextTokens / records.length,
    maxContextTokens: contextTokens.length === 0 ? 0 : Math.max(...contextTokens),
    totalContextTokens,
  };

  // ----- latency -----
  const latenciesAsc = records.map((r) => r.latencyMs).slice().sort((a, b) => a - b);
  const latency: LatencyReport = {
    p50: percentile(latenciesAsc, 0.5),
    p90: percentile(latenciesAsc, 0.9),
    p99: percentile(latenciesAsc, 0.99),
    total: latenciesAsc.reduce((a, b) => a + b, 0),
  };

  // ----- sample + questions -----
  const questionRecords: QuestionRecord[] = records.map((r) => ({
    questionId: r.questionId,
    questionType: r.questionType,
    correct: r.correct,
    contextTokens: r.contextTokens,
    latencyMs: r.latencyMs,
    cached: r.cached,
    judgeOutput: r.judgeOutput,
    answer: r.answer,
  }));

  const models: ModelInfo = {
    answer: opts.answerEndpoint.model,
    judge: opts.judgeEndpoint.model,
  };

  const cachedIngests = records.reduce((n, r) => (r.cached ? n + 1 : n), 0);

  return {
    engine: engineInfo(),
    models,
    sample: {
      seed: opts.sampleSeed ?? 0,
      questionIds: records.map((r) => r.questionId),
    },
    flags: opts.flags,
    accuracy,
    tokens: recorder.totals(),
    retrieval,
    latencyMs: latency,
    cachedIngests,
    questions: questionRecords,
  };
}