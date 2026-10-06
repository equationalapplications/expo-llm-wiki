import type { LibrarianGateConfig, WikiFact } from '../../../types';
import type { WikiDiagnosticInput } from '../../../utils/diagnostics';
import { cosineSimilarity } from '../../../utils/cosine';
import { parseEmbedding } from '../../../utils/embedding';
import { titleTokens, jaccardScore } from '../../../utils/pure';
import { FUZZY_THRESHOLD, MIN_TOKENS_TO_QUALIFY } from '../constants';
import type { LibrarianDeps, LibrarianPassContext } from '../types';
import type { Candidate } from './extract';
import { normalizeFactText } from './text';

export interface Neighbour {
  id: string;
  ref: string;
  title: string;
  body: string;
  source_type: WikiFact['source_type'];
  score: number | null;
}

export type GateDecision =
  | { kind: 'noop'; target: string }
  | { kind: 'add' }
  | { kind: 'ambiguous' };

export interface GatedCandidate {
  candidate: Candidate;
  neighbours: Neighbour[];
  decision: GateDecision;
  vector: Float32Array | null;
}

const clamp01 = (v: unknown, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d;

export function resolveGateConfig(cfg?: LibrarianGateConfig): Required<LibrarianGateConfig> {
  const kRaw = cfg?.k;
  const k = typeof kRaw === 'number' && Number.isFinite(kRaw) ? Math.min(20, Math.max(1, Math.trunc(kRaw))) : 5;
  // Calibrated against the 30 supersession scenarios (commit
  // feat(benchmarks): offline gate threshold calibration): defaults of
  // 0.97 / 0.55 misclassified 4 rows out of 36 (mostly the exact-rewrite
  // duplicates at cosine 0.90–0.92 that the gate was sending to the LLM);
  // the calibrated pair 0.89 / 0.30 misclassifies 0. See
  // `packages/benchmarks/results/calibration-<version>.json`.
  const dupThreshold = clamp01(cfg?.dupThreshold, 0.89);
  const novelThreshold = clamp01(cfg?.novelThreshold, 0.30);
  if (novelThreshold > dupThreshold) throw new TypeError('librarian.gate: novelThreshold must be <= dupThreshold');
  return { k, dupThreshold, novelThreshold };
}

function titlesMatch(a: string, b: string): boolean {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size < MIN_TOKENS_TO_QUALIFY || tb.size < MIN_TOKENS_TO_QUALIFY) return false;
  return jaccardScore(ta, tb) >= FUZZY_THRESHOLD;
}

/**
 * Pure. `score` is cosine in vector mode, null in keyword mode.
 *
 * Rules, in order:
 * 1. Any neighbour with normalised text equal to the candidate's → NOOP on the first such neighbour.
 * 2. No neighbours → ADD.
 * 3. Vector mode: best = neighbours[0]. If best.score >= dupThreshold AND title Jaccard qualifies → NOOP.
 *    Else if best.score < novelThreshold → ADD. Else → AMBIGUOUS.
 * 4. Keyword mode with any neighbours → AMBIGUOUS (scores not comparable to thresholds).
 */
export function classifyCandidate(
  candidate: { title: string; body: string },
  neighbours: Neighbour[],
  cfg: Required<LibrarianGateConfig>,
  mode: 'vector' | 'keyword',
): GateDecision {
  const key = normalizeFactText(candidate.title, candidate.body);
  const same = neighbours.find((n) => normalizeFactText(n.title, n.body) === key);
  if (same) return { kind: 'noop', target: same.id };
  if (neighbours.length === 0) return { kind: 'add' };
  if (mode === 'keyword') return { kind: 'ambiguous' };
  const best = neighbours[0];
  const score = best.score ?? 0;
  if (score >= cfg.dupThreshold && titlesMatch(candidate.title, best.title)) return { kind: 'noop', target: best.id };
  if (score < cfg.novelThreshold) return { kind: 'add' };
  return { kind: 'ambiguous' };
}

export async function gateCandidates(
  deps: LibrarianDeps,
  ctx: LibrarianPassContext,
  candidates: Candidate[],
  cfg: Required<LibrarianGateConfig>,
): Promise<{ gated: GatedCandidate[]; inBatchDuplicates: Candidate[]; gateDiagnostic: WikiDiagnosticInput }> {
  const { entityId, trigger } = ctx;

  // 1. Drop in-batch duplicates (same normalised text as an earlier candidate).
  const seen = new Set<string>();
  const unique: Candidate[] = [];
  const inBatchDuplicates: Candidate[] = [];
  for (const c of candidates) {
    const key = normalizeFactText(c.fact.title, c.fact.body);
    if (seen.has(key)) inBatchDuplicates.push(c);
    else { seen.add(key); unique.push(c); }
  }

  // 2. Load the set of non-live ids so we can exclude superseded/draft rows from neighbours.
  const nonLive = await deps.entryRepo.findNonLiveIdsByEntityIds([entityId], 'current', Date.now());

  // 3. Pre-load stored vectors when an embed provider is available.
  const canEmbed = typeof deps.options.llmProvider.embed === 'function';
  const stored: Array<{ id: string; vec: Float32Array }> = [];
  if (canEmbed && unique.length > 0) {
    for (const row of await deps.entryRepo.findWithEmbeddingsByEntityIds([entityId])) {
      if (nonLive.has(row.id)) continue;
      const vec = parseEmbedding(row.embedding_blob, row.embedding);
      if (vec) stored.push({ id: row.id, vec });
    }
  }

  // 4. For each unique candidate, decide vector or keyword mode and rank.
  const gated: GatedCandidate[] = [];
  for (const c of unique) {
    let ranked: Array<{ id: string; score: number | null }> | null = null;
    let vector: Float32Array | null = null;
    let mode: 'vector' | 'keyword' = 'keyword';

    if (canEmbed) {
      const r = await deps.embeddingService.embedTextForFact(
        { id: 'candidate', entity_id: entityId, title: c.fact.title, body: c.fact.body, tags: c.fact.tags },
        undefined,
        { markFailures: false },
      );
      if (r.ok) {
        vector = r.vector;
        if (stored.length > 0 && stored.every((s) => s.vec.length === r.vector.length)) {
          ranked = stored
            .map((s) => ({ id: s.id, score: cosineSimilarity(r.vector, s.vec) }))
            .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
            .slice(0, cfg.k);
          mode = 'vector';
        }
      }
    }
    if (!ranked) {
      ranked = (await deps.searchService
        .searchKeyword(`${c.fact.title} ${c.fact.body}`, [entityId], cfg.k + nonLive.size))
        .filter((h) => !nonLive.has(h.id))
        .slice(0, cfg.k)
        .map((h) => ({ id: h.id, score: null }));
    }

    // 5. Hydrate neighbours preserving rank order; assign refs n1..nk.
    const facts = ranked.length > 0 ? await deps.entryRepo.findByIds(ranked.map((r) => r.id), [entityId]) : [];
    const byId = new Map(facts.map((f) => [f.id, f]));
    const neighbours: Neighbour[] = ranked
      .filter((r) => byId.has(r.id))
      .map((r, i) => {
        const f = byId.get(r.id)!;
        return { id: f.id, ref: `n${i + 1}`, title: f.title, body: f.body, source_type: f.source_type, score: r.score };
      });

    gated.push({ candidate: c, neighbours, decision: classifyCandidate(c.fact, neighbours, cfg, mode), vector });
  }

  // 6. Emit one librarian_gate diagnostic input per pass (returned, not emitted, so the caller can buffer).
  const count = (k: GateDecision['kind']) => gated.filter((g) => g.decision.kind === k).length;
  const gateDiagnostic: WikiDiagnosticInput = {
    code: 'librarian_gate', operation: 'librarian', trigger, entityId,
    detail: { gateNoop: count('noop'), gateAdd: count('add'), gateAmbiguous: count('ambiguous') },
  };
  return { gated, inBatchDuplicates, gateDiagnostic };
}
