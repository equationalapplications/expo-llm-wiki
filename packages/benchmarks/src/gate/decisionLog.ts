/**
 * Gate decision log (spec targeted-diagnostics §4).
 *
 * Drives core's real `gateCandidates` with production thresholds against a
 * supersession scenario and returns, per candidate, the decision, the
 * neighbours with their scores, and the margin to the nearest threshold.
 * Embeddings come from a committed sidecar of recorded BGE-small vectors.
 */
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { LLMProvider } from '@equationalapplications/core-llm-wiki';
import { gateCandidates, resolveGateConfig } from '../../../core/src/services/librarian/ops/gate';
import type { Candidate } from '../../../core/src/services/librarian/ops/extract';
import { validateFact } from '../../../core/src/utils/pure';
import { openDb } from '../db';
import { insertExistingFacts, SUPERSESSION_ENTITY, type Scenario } from '../supersession/run';

export type EmbedFn = (text: string) => Promise<number[]>;

export const SIDECAR_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'gate', 'embeddings.json.gz');

export interface SidecarFile {
  model: string;
  texts: Record<string, number[]>;
}

export interface DecisionRow {
  /** `${scenario}::${candidateIndex}` */
  key: string;
  scenario: string;
  candidateIndex: number;
  candidate: string;
  decision: 'noop' | 'add' | 'ambiguous';
  /** True when the candidate was dropped as an in-batch duplicate (logged as noop). */
  inBatchDuplicate: boolean;
  bestCosine: number | null;
  neighbours: Array<{ title: string; score: number | null }>;
  /** Signed distance from bestCosine to the nearer threshold (positive = inside the ambiguous band). */
  margin: number | null;
}

export function loadSidecar(path: string): Map<string, number[]> {
  const file = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as SidecarFile;
  return new Map(Object.entries(file.texts));
}

export function sidecarEmbed(map: ReadonlyMap<string, number[]>): EmbedFn {
  return async (text: string) => {
    const v = map.get(text);
    if (!v) throw new Error(`no sidecar vector for text; re-run pnpm fixture:gate-embeddings (text: ${JSON.stringify(text.slice(0, 80))})`);
    return v;
  };
}

/** Calibrate's own embed strings (`calibrationRows`), kept in the sidecar so the CLI can read it too. */
export function calibrateTexts(s: Scenario): string[] {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return [
    ...s.extract.facts.map((f) => `${str(f.title)} ${str(f.body)}`),
    ...s.existing.map((f) => `${f.title} ${f.body}`),
  ];
}

export async function decisionLog(scenario: Scenario, inner: EmbedFn): Promise<DecisionRow[]> {
  // Core swallows embed errors (EmbeddingService.embedTextForFact returns
  // { ok: false }; the gate then falls back to keyword mode), so a sidecar
  // miss would silently change decisions. Record misses here and fail loudly.
  const misses: unknown[] = [];
  const embed: EmbedFn = async (text) => {
    try {
      return await inner(text);
    } catch (e) {
      misses.push(e);
      throw e;
    }
  };
  const assertNoMisses = () => {
    if (misses.length > 0) {
      const first = misses[0] instanceof Error ? misses[0].message : String(misses[0]);
      throw new Error(`decisionLog(${scenario.name}): ${misses.length} embed failure(s); ${first}`);
    }
  };
  const handle = openDb();
  try {
    const llmProvider = {
      generateText: async () => {
        throw new Error('decisionLog: the gate must not call the LLM');
      },
      embed,
    } as unknown as LLMProvider;
    const wiki = new WikiMemory(handle.adapter, {
      llmProvider,
      config: { librarian: { strategy: 'ops' }, maintenance: 'deferred' },
    });
    await wiki.setup();
    await insertExistingFacts(handle.adapter, scenario.existing);
    await wiki.runReembed(SUPERSESSION_ENTITY);
    assertNoMisses();

    const candidates: Candidate[] = [];
    scenario.extract.facts.forEach((raw, index) => {
      const fact = validateFact(raw);
      if (fact) candidates.push({ index, fact, sourceLabel: null, validFrom: 0 });
    });

    const deps = (wiki.__testAccess.maintenanceService as unknown as { librarianDeps(): Parameters<typeof gateCandidates>[0] }).librarianDeps();
    const cfg = resolveGateConfig();
    const { gated, inBatchDuplicates } = await gateCandidates(deps, { entityId: SUPERSESSION_ENTITY, trigger: 'call' }, candidates, cfg);
    assertNoMisses();

    const margin = (best: number | null): number | null =>
      best === null ? null : Math.min(best - cfg.novelThreshold, cfg.dupThreshold - best);

    const rows: DecisionRow[] = [];
    for (const g of gated) {
      const best = g.neighbours[0]?.score ?? null;
      rows.push({
        key: `${scenario.name}::${g.candidate.index}`,
        scenario: scenario.name,
        candidateIndex: g.candidate.index,
        candidate: g.candidate.fact.title,
        decision: g.decision.kind,
        inBatchDuplicate: false,
        bestCosine: best,
        neighbours: g.neighbours.map((n) => ({ title: n.title, score: n.score })),
        margin: margin(best),
      });
    }
    for (const c of inBatchDuplicates) {
      rows.push({
        key: `${scenario.name}::${c.index}`,
        scenario: scenario.name,
        candidateIndex: c.index,
        candidate: c.fact.title,
        decision: 'noop',
        inBatchDuplicate: true,
        bestCosine: null,
        neighbours: [],
        margin: null,
      });
    }
    return rows.sort((a, b) => a.candidateIndex - b.candidateIndex);
  } finally {
    handle.close();
  }
}
