/**
 * Pure shortlist builder (PR 2a, spec §1): rank candidate rows against a
 * fact and keep the top k. Lexical only — no fastembed, no I/O; embeddings
 * enter only via the injected `score` function.
 */

import { jaccardScore, titleTokens } from './pure';
import { normalizeTitleKey } from './ontology';

export type ShortlistFact = { title: string; body: string };
export type ShortlistRow = { title: string; okf_type: string; body?: string };

/**
 * Default lexical score: Jaccard between the fact token set (tokens of
 * `factTitle` ∪ tokens of `factBody`) and the row token set (tokens of
 * `row.title` ∪ tokens of `row.body`), both through `titleTokens` (which
 * drops tokens shorter than 3 chars). Empty-vs-empty → 0 via
 * `jaccardScore`'s 0/0 arm.
 */
export function shortlistScore(factTitle: string, factBody: string, row: ShortlistRow): number {
  const factTokens = new Set([...titleTokens(factTitle), ...titleTokens(factBody)]);
  const rowTokens = new Set([...titleTokens(row.title), ...titleTokens(row.body ?? '')]);
  return jaccardScore(factTokens, rowTokens);
}

/**
 * Return the top `k` rows for `fact`, highest score first.
 *
 * - Dedupes `rows` by `normalizeTitleKey(row.title)` BEFORE sorting,
 *   keeping the LAST row per key (catalog convention,
 *   `prompts.ts` `buildTitleCatalogBlock`).
 * - Sorts descending by score; ties break by `title` ascending in UTF-16
 *   code-unit order (`<` comparison, same order the catalog uses).
 * - Rows with an empty `title` or an empty `okf_type` are skipped BEFORE
 *   dedupe, exactly like the catalog (`buildTitleCatalogBlock`), so an
 *   invalid row can never replace a valid row under the same key.
 * - `k <= 0` returns `[]`; `k` a non-integer or NaN throws; `k` greater
 *   than the deduped pool size returns the whole deduped pool.
 */
export function buildShortlist(
  fact: ShortlistFact,
  rows: ReadonlyArray<ShortlistRow>,
  k: number,
  score: (fact: ShortlistFact, row: ShortlistRow) => number = (f, r) =>
    shortlistScore(f.title, f.body, r),
): ShortlistRow[] {
  if (typeof k !== 'number' || Number.isNaN(k) || !Number.isInteger(k)) {
    throw new Error(`buildShortlist: k must be a non-negative integer, got ${String(k)}`);
  }
  if (k <= 0) return [];
  const byKey = new Map<string, ShortlistRow>();
  for (const r of rows) {
    if (typeof r.title !== 'string' || r.title.length === 0) continue;
    if (typeof r.okf_type !== 'string' || r.okf_type.length === 0) continue;
    byKey.set(normalizeTitleKey(r.title), r);
  }
  const scored = [...byKey.values()].map((row) => ({ row, score: score(fact, row) }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    // UTF-16 code-unit order via `<` — deterministic across runtimes/locales.
    return a.row.title < b.row.title ? -1 : a.row.title > b.row.title ? 1 : 0;
  });
  return scored.slice(0, k).map((s) => s.row);
}
