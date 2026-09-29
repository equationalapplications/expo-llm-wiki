/**
 * LongMemEval_S dataset loader.
 *
 * The dataset is a single JSON file from Hugging Face (configurable via
 * `BENCH_LONGMEMEVAL_URL`). We download it at run time into a gitignored cache
 * directory so the working repo never carries the file. `loadDataset` reads the
 * cache when present and falls back to a single `fetch` otherwise.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
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

  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf8')) as LmeQuestion[];
  }

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`LongMemEval fetch failed: HTTP ${response.status}`);
  }
  const text = await response.text();
  let parsed: LmeQuestion[];
  try {
    parsed = JSON.parse(text) as LmeQuestion[];
  } catch (e) {
    throw new Error(`LongMemEval response was not valid JSON: ${(e as Error).message}`);
  }

  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, text);
  return parsed;
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