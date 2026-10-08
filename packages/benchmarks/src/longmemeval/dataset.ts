/**
 * LongMemEval_S dataset loader.
 *
 * The dataset is a single JSON file from Hugging Face (configurable via
 * `BENCH_LONGMEMEVAL_URL`). We download it at run time into a gitignored cache
 * directory so the working repo never carries the file. `loadDataset` reads the
 * cache when present and falls back to a single `fetch` otherwise.
 */

import { assertHttps, readCached, writeFileAtomic } from '../fsSafe';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export interface LmeTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type LmeQuestionType =
  | 'single-session-user'
  | 'single-session-assistant'
  | 'single-session-preference'
  | 'multi-session'
  | 'temporal-reasoning'
  | 'knowledge-update';

export interface LmeQuestion {
  question_id: string;
  question_type: LmeQuestionType;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_sessions: LmeTurn[][];
}

const DEFAULT_DATASET_URL =
  'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json';

// Derived from this module's own location (`<root>/packages/benchmarks/src/
// longmemeval/dataset.ts`) so the cache is found regardless of the caller's
// cwd — `pnpm --filter <pkg> bench …` runs scripts inside the package
// directory, where a `process.cwd()`-based path would double the prefix.
const DEFAULT_CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache');

export interface LoadDatasetOpts {
  url?: string;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
}

type FetchLike = (input: string, init?: { method?: string }) => Promise<Response>;

const QUESTION_TYPES: ReadonlySet<string> = new Set<LmeQuestionType>([
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'multi-session',
  'temporal-reasoning',
  'knowledge-update',
]);

const isString = (v: unknown): v is string => typeof v === 'string';

function toTurn(v: unknown): LmeTurn | null {
  if (typeof v !== 'object' || v === null) return null;
  const { role, content } = v as Record<string, unknown>;
  if ((role !== 'user' && role !== 'assistant') || !isString(content)) return null;
  return { role, content };
}

/**
 * Validates the parsed dataset and rebuilds each row from known fields only, so
 * network data is never written to the cache verbatim (CodeQL js/http-to-file-access).
 * Some upstream answers are numbers; they are normalised to strings.
 */
export function validateDataset(raw: unknown): LmeQuestion[] {
  if (!Array.isArray(raw)) throw new Error('LongMemEval dataset is not an array');
  return raw.map((v, i) => {
    const fail = (field: string): never => {
      throw new Error(`LongMemEval row ${i}: ${field}`);
    };
    if (typeof v !== 'object' || v === null) fail('not an object');
    const r = v as Record<string, unknown>;
    if (!isString(r.question_id)) fail('question_id');
    if (!isString(r.question_type) || !QUESTION_TYPES.has(r.question_type)) fail('question_type');
    if (!isString(r.question)) fail('question');
    if (!isString(r.answer) && !(typeof r.answer === 'number' && Number.isFinite(r.answer))) fail('answer');
    if (!isString(r.question_date)) fail('question_date');
    if (!Array.isArray(r.haystack_dates) || !r.haystack_dates.every(isString)) fail('haystack_dates');
    if (!Array.isArray(r.haystack_sessions)) fail('haystack_sessions');
    const sessions = (r.haystack_sessions as unknown[]).map((s) => {
      if (!Array.isArray(s)) return fail('haystack_sessions');
      return s.map((t) => toTurn(t) ?? fail('haystack_sessions'));
    });
    return {
      question_id: r.question_id as string,
      question_type: r.question_type as LmeQuestionType,
      question: r.question as string,
      answer: String(r.answer),
      question_date: r.question_date as string,
      haystack_dates: [...(r.haystack_dates as string[])],
      haystack_sessions: sessions,
    };
  });
}

/**
 * Load the LongMemEval_S dataset. Reuses `${cacheDir}/longmemeval_s.json`
 * when present; otherwise fetches once and writes the file to the cache.
 *
 * The caller may inject a `fetchImpl` for tests.
 */
export async function loadDataset(opts: LoadDatasetOpts = {}): Promise<LmeQuestion[]> {
  const url = opts.url ?? process.env.BENCH_LONGMEMEVAL_URL ?? DEFAULT_DATASET_URL;
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const fetchImpl = (opts.fetchImpl ?? fetch) as FetchLike;
  const cacheFile = join(cacheDir, 'longmemeval_s.json');

  const cached = readCached(cacheFile);
  if (cached !== null) return validateDataset(JSON.parse(cached));

  assertHttps(url);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`LongMemEval fetch failed: HTTP ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch (e) {
    throw new Error(`LongMemEval response was not valid JSON: ${(e as Error).message}`);
  }

  const questions = validateDataset(parsed);
  writeFileAtomic(cacheFile, JSON.stringify(questions));
  return questions;
}

/**
 * Parse the LongMemEval session / question date strings.
 *
 * Format: `YYYY/MM/DD (Day) HH:mm` (UTC). The day-of-week token is informational
 * and not cross-checked; an inconsistent weekday simply produces a successful
 * parse with the supplied date/time.
 *
 * Throws `Error` on any input that does not match the expected shape.
 */
export function parseLmeDate(s: string): number {
  if (typeof s !== 'string') {
    throw new Error(`parseLmeDate: expected string, got ${typeof s}`);
  }
  const re = /^(\d{4})\/(\d{2})\/(\d{2})\s*\([A-Za-z]{3}\)\s*(\d{2}):(\d{2})$/;
  const m = re.exec(s);
  if (!m) {
    throw new Error(`parseLmeDate: unparseable date "${s}"`);
  }
  const [, y, mo, d, h, mi] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const min = Number(mi);
  return Date.UTC(year, month - 1, day, hour, min);
}