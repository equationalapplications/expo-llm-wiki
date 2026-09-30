/**
 * Offline gate-threshold calibration (Task 1 of PR-D2).
 *
 * The ops librarian gate (see `packages/core/src/services/librarian/ops/gate.ts`)
 * ships with provisional defaults — `dupThreshold = 0.97`, `novelThreshold = 0.55`.
 * Spec §5.3 calls those defaults out as "embedding-model dependent; recalibrated
 * before 7.8.0".
 *
 * This module scans the supersession scenarios offline, embeds every candidate
 * against every existing fact (no API cost — fastembed is local ONNX), labels
 * each `(scenario, candidate)` with the class the gate *should* have produced
 * (`expectedClass`), and asks `recommendThresholds` to find the
 * `(novelThreshold, dupThreshold)` pair that classifies the labelled set with
 * the fewest misclassifications. Ties go to the pair whose thresholds are
 * furthest from the nearest ambiguous row — the brief's tie-break rule,
 * "prefer sending more to the LLM over silently skipping it".
 *
 * Pure module: the public API is `expectedClass`, `calibrationRows`,
 * `recommendThresholds`. The CLI subcommand (`bench calibrate`) wraps them
 * with stdout printing and a JSON result file.
 */

import { cosineSimilarity } from '../../core/src/utils/cosine';
import { FUZZY_THRESHOLD, MIN_TOKENS_TO_QUALIFY } from '../../core/src/services/librarian/constants';
import { titleTokens, jaccardScore } from '../../core/src/utils/pure';
import { resolveGateConfig } from '../../core/src/services/librarian/ops/gate';
import { Scenario } from './supersession/run';

// --------------------------------------------------------------------------
// Expected-class labelling
// --------------------------------------------------------------------------

export type ExpectedClass = 'noop' | 'add' | 'ambiguous';

/**
 * Label one candidate from a supersession scenario.
 *
 * The scenario's `resolve` field tells us how the gate was expected to behave:
 *
 *   - `resolve` is **null**  ⇒ the gate alone decided. The scenario's
 *     `expectCurrentTitles` and `expectSuperseded` arrays describe the
 *     desired post-state without any LLM call:
 *
 *       - Every expected current title is already a substring of some
 *         existing fact's title, AND no existing fact is being superseded
 *         ⇒ the candidate was a restatement / dedup target ⇒ gate: NOOP.
 *       - Otherwise (a new title beyond existing is expected, or some
 *         existing id is being superseded) ⇒ gate: ADD. The actual
 *         supersede is *not* the gate's job in replay mode — the canned
 *         `resolve` skips the LLM and `expectedClass` here mirrors what
 *         the gate alone would have done.
 *
 *   - `resolve` is **present** ⇒ the gate sent the candidate to the LLM;
 *     the resolved ops (SUPERSEDE / UPDATE / ADD / NOOP) belong to the
 *     model, not the gate. `expectedClass` returns `ambiguous` because
 *     that is the gate's only contribution in this branch.
 */
export function expectedClass(s: Scenario, candidateIndex: number): ExpectedClass {
  if (s.resolve !== null) return 'ambiguous';
  // resolve === null: gate decides alone
  const existingAllPreserved = s.expectSuperseded.length === 0;
  // "no new title beyond existing" — every expected current title is a
  // substring of some existing title (case-insensitive). The supersession
  // runner's pass criterion uses the same substring rule, so a row that
  // survives that check is "the existing title is still current" rather
  // than "a brand-new fact is being introduced".
  const existingTitlesLower = s.existing.map((f) => f.title.toLowerCase());
  const noNewTitleBeyondExisting = s.expectCurrentTitles.every((needle) => {
    const n = needle.toLowerCase();
    return existingTitlesLower.some((t) => t.includes(n));
  });
  if (existingAllPreserved && noNewTitleBeyondExisting) return 'noop';
  return 'add';
}

// --------------------------------------------------------------------------
// Calibration rows
// --------------------------------------------------------------------------

export interface CalibrationRow {
  scenario: string;
  /** Candidate display label — the candidate's title, or `c<i>` when empty. */
  candidate: string;
  /** Max cosine similarity of the candidate's embedding against any existing fact's embedding. `null` when the scenario has no existing facts or the embedder was unavailable. */
  bestCosine: number | null;
  /** Max title-Jaccard between the candidate's title and any existing fact's title. `null` only when the scenario has no existing facts. */
  titleJaccard: number | null;
  expected: ExpectedClass;
}

export type EmbedFn = (text: string) => Promise<number[]>;

/**
 * For every scenario, walk each candidate in `extract.facts` and produce one
 * {@link CalibrationRow}. The row's `bestCosine` is the maximum cosine across
 * the candidate's embedding and every existing fact's embedding (titles +
 * bodies, in keeping with how the ops gate embeds a fact). The row's
 * `titleJaccard` is the maximum title-token Jaccard across existing titles.
 *
 * Scenarios with no existing facts produce rows with both fields `null`;
 * the classifier treats `null` cosine as keyword-mode → ambiguous (the gate
 * would route to the resolve step in that case).
 *
 * Errors thrown by `embed` propagate — calibration is a single best-effort
 * pass over the suite and one bad row should not silently hide a misconfigured
 * embedder.
 */
export async function calibrationRows(scenarios: Scenario[], embed: EmbedFn): Promise<CalibrationRow[]> {
  const rows: CalibrationRow[] = [];
  for (const s of scenarios) {
    for (let i = 0; i < s.extract.facts.length; i++) {
      const fact = s.extract.facts[i];
      const candTitle = stringField(fact.title);
      const candBody = stringField(fact.body);
      const label = candTitle || `c${i}`;
      if (s.existing.length === 0) {
        rows.push({ scenario: s.name, candidate: label, bestCosine: null, titleJaccard: null, expected: expectedClass(s, i) });
        continue;
      }
      const candVec = await embed(`${candTitle} ${candBody}`);
      let bestCosine: number | null = null;
      let bestJaccard: number | null = null;
      for (const ex of s.existing) {
        const exVec = await embed(`${ex.title} ${ex.body}`);
        const cos = cosineSimilarity(candVec, exVec);
        if (bestCosine === null || cos > bestCosine) bestCosine = cos;
        const jac = pairJaccard(candTitle, ex.title);
        if (bestJaccard === null || jac > bestJaccard) bestJaccard = jac;
      }
      rows.push({ scenario: s.name, candidate: label, bestCosine, titleJaccard: bestJaccard, expected: expectedClass(s, i) });
    }
  }
  return rows;
}

// --------------------------------------------------------------------------
// Threshold recommendation
// --------------------------------------------------------------------------

export interface RecommendThresholdsResult {
  novelThreshold: number;
  dupThreshold: number;
  /** Misclassifications under the core defaults (dupThreshold=0.97, novelThreshold=0.55). */
  misclassifiedAtDefaults: number;
  /** Misclassifications under the recommended `(novelThreshold, dupThreshold)`. */
  misclassifiedAtRecommended: number;
}

const NOVEL_SWEEP_START = 0.30;
const NOVEL_SWEEP_END = 0.90;
const DUP_SWEEP_END = 1.00;
const SWEEP_STEP = 0.01;

const DEFAULTS = resolveGateConfig();

/**
 * Pairwise Jaccard between two titles using the same `titleTokens` /
 * `jaccardScore` helpers the gate's `titlesMatch` uses, so a row's
 * `titleJaccard` is exactly the value the gate would compare against
 * `FUZZY_THRESHOLD`.
 *
 * If either title tokenises to fewer than `MIN_TOKENS_TO_QUALIFY` tokens
 * (a 3-token floor — the gate's own floor for "the title is informative
 * enough for Jaccard to mean anything"), returns 0 so the gate's
 * `titlesMatch` check would fail. This mirrors `titlesMatch` returning
 * `false` in that case.
 */
export function pairJaccard(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size < MIN_TOKENS_TO_QUALIFY || tb.size < MIN_TOKENS_TO_QUALIFY) return 0;
  return jaccardScore(ta, tb);
}

/**
 * Apply the ops gate's vector-mode rules to a single row.
 *
 * Mirrors `classifyCandidate` in `packages/core/src/services/librarian/ops/gate.ts`
 * (the noop/add/ambiguous decision) using only the two scalars the row carries
 * (`bestCosine` and `titleJaccard`). The gate's "exact title+body match"
 * short-circuit is implicitly covered by the duplicate fixture's high cosine
 * and high Jaccard — a row with score = 1 and Jaccard = 1 collapses to the
 * same decision under these rules.
 *
 *   - `bestCosine === null` ⇒ keyword mode → ambiguous (the gate falls back
 *     to keyword search when no vector is available and routes every
 *     keyword hit to the resolve step).
 *   - `bestCosine >= dupThreshold` AND `titleJaccard >= FUZZY_THRESHOLD` ⇒ noop.
 *   - `bestCosine < novelThreshold` ⇒ add.
 *   - otherwise ⇒ ambiguous.
 *
 * Note that the gate's "same normalised title+body" short-circuit is *not*
 * represented here: a row's `bestCosine` of 1.0 with `titleJaccard` of 1.0
 * already collapses to a noop via the `dupThreshold` arm (provided
 * `dupThreshold <= 1.00`, which the sweep enforces), so the classification
 * is identical in practice.
 */
function classifyRow(row: CalibrationRow, novelThreshold: number, dupThreshold: number): ExpectedClass {
  if (row.bestCosine === null) return 'ambiguous';
  if (
    row.bestCosine >= dupThreshold &&
    row.titleJaccard !== null &&
    row.titleJaccard >= FUZZY_THRESHOLD
  ) {
    return 'noop';
  }
  if (row.bestCosine < novelThreshold) return 'add';
  return 'ambiguous';
}

function countMisclassified(rows: CalibrationRow[], novelThreshold: number, dupThreshold: number): number {
  let n = 0;
  for (const row of rows) {
    if (classifyRow(row, novelThreshold, dupThreshold) !== row.expected) n += 1;
  }
  return n;
}

/**
 * Smallest distance from any row that would be classified as `ambiguous`
 * under `(novelThreshold, dupThreshold)` to the nearer threshold.
 *
 * Returns `Infinity` when no row would land in the ambiguous band — the
 * caller uses this as the "preferred more ambiguous" tie-breaker.
 */
function minAmbiguousMargin(rows: CalibrationRow[], novelThreshold: number, dupThreshold: number): number {
  let best = Infinity;
  for (const row of rows) {
    if (row.bestCosine === null) continue;
    const c = classifyRow(row, novelThreshold, dupThreshold);
    if (c !== 'ambiguous') continue;
    const distAbove = row.bestCosine - novelThreshold;
    const distBelow = dupThreshold - row.bestCosine;
    const m = Math.min(distAbove, distBelow);
    if (m < best) best = m;
  }
  return best;
}

/**
 * Sweep `novelThreshold` over `[0.30, 0.90]` (step 0.01) and `dupThreshold`
 * over `[novelThreshold, 1.00]` (step 0.01). For each pair, classify every row
 * with the same vector-mode rules as `classifyCandidate`. The recommended pair
 * is the one with the fewest misclassifications; ties are broken by the
 * *largest* margin to the nearest ambiguous row, then by the widest band
 * (`dup - novel`), then by the smallest `novelThreshold`, then by the
 * largest `dupThreshold` — all biased toward "send more to the LLM".
 *
 * Sweep cost is 61 × 71 ≈ 4 300 (novel, dup) pairs, each scanning every row,
 * so the wall-clock cost is `O(rows × 4 300)` — a few milliseconds for the
 * 30-scenario fixture.
 */
export function recommendThresholds(rows: CalibrationRow[]): RecommendThresholdsResult {
  const misclassifiedAtDefaults = countMisclassified(rows, DEFAULTS.novelThreshold, DEFAULTS.dupThreshold);

  // Round to nearest 0.01 to absorb floating-point drift across the sweep.
  const round = (x: number) => Math.round(x * 100) / 100;

  let best: { novel: number; dup: number; mis: number; margin: number; band: number } = {
    novel: DEFAULTS.novelThreshold,
    dup: DEFAULTS.dupThreshold,
    mis: rows.length, // worst-case: every row wrong ⇒ forces improvement
    margin: -Infinity,
    band: 0,
  };

  for (let novel = NOVEL_SWEEP_START; novel <= NOVEL_SWEEP_END + 1e-9; novel = round(novel + SWEEP_STEP)) {
    for (let dup = novel; dup <= DUP_SWEEP_END + 1e-9; dup = round(dup + SWEEP_STEP)) {
      const mis = countMisclassified(rows, novel, dup);
      const margin = minAmbiguousMargin(rows, novel, dup);
      const band = dup - novel;
      const isBetter =
        mis < best.mis ||
        (mis === best.mis && margin > best.margin) ||
        (mis === best.mis && margin === best.margin && band > best.band) ||
        (mis === best.mis && margin === best.margin && band === best.band && novel < best.novel) ||
        (mis === best.mis && margin === best.margin && band === best.band && novel === best.novel && dup > best.dup);
      if (isBetter) {
        best = { novel, dup, mis, margin, band };
      }
    }
  }

  return {
    novelThreshold: best.novel,
    dupThreshold: best.dup,
    misclassifiedAtDefaults,
    misclassifiedAtRecommended: best.mis,
  };
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function stringField(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
