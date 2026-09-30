/**
 * Seeded stratified sampler for LongMemEval.
 *
 * `STRATA` fixes the spec's per-type target counts (knowledge-update 20,
 * temporal-reasoning 20, multi-session 15, single-session-user 9,
 * single-session-assistant 8, single-session-preference 8 ⇒ 80 total).
 * `sampleQuestionIds` picks that many per stratum, dropping abstention
 * questions (`question_id` ending in `_abs`), and is deterministic for a
 * given seed via a mulberry32 PRNG.
 */

import type { LmeQuestion, LmeQuestionType } from './dataset';

export const STRATA: Record<LmeQuestionType, number> = {
  'knowledge-update': 20,
  'temporal-reasoning': 20,
  'multi-session': 15,
  'single-session-user': 9,
  'single-session-assistant': 8,
  'single-session-preference': 8,
};

/**
 * mulberry32 — a small, fast, seedable 32-bit PRNG returning a uniform
 * `[0, 1)` number. Stable across platforms; fine for non-cryptographic use.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * In-place Fisher–Yates using the supplied PRNG.
 */
function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Pick up to `STRATA[type]` question ids per type, deterministically.
 *
 * 1. Drop abstention ids (`_abs` suffix).
 * 2. For each stratum in `STRATA` key order, sort ids ascending, Fisher–Yates
 *    shuffle with `mulberry32(seed)`, and take the first N (or all of them
 *    if the stratum has fewer than N; a warning is logged in that case).
 * 3. Concatenate the per-stratum slices in `STRATA` key order.
 *
 * The PRNG advances once per stratum, so re-running with the same seed on the
 * same input is bit-identical, while re-running with a different seed yields
 * a different ordering.
 */
export function sampleQuestionIds(questions: LmeQuestion[], seed: number): string[] {
  const rand = mulberry32(seed);
  const byType: Record<LmeQuestionType, string[]> = {
    'knowledge-update': [],
    'temporal-reasoning': [],
    'multi-session': [],
    'single-session-user': [],
    'single-session-assistant': [],
    'single-session-preference': [],
  };

  for (const q of questions) {
    if (q.question_id.endsWith('_abs')) continue;
    byType[q.question_type].push(q.question_id);
  }

  const out: string[] = [];
  for (const type of Object.keys(STRATA) as LmeQuestionType[]) {
    const target = STRATA[type];
    const pool = byType[type].slice().sort();
    const shuffled = shuffle(pool, rand);
    if (shuffled.length < target) {
      // eslint-disable-next-line no-console
      console.warn(`sampleQuestionIds: stratum "${type}" has ${shuffled.length} ids, fewer than the target ${target}; taking all`);
    }
    out.push(...shuffled.slice(0, target));
  }
  return out;
}