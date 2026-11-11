/**
 * Gate decision log (spec targeted-diagnostics §4).
 *
 * Runs core's real `gateCandidates` with production thresholds on every
 * supersession scenario, using recorded BGE-small vectors from a committed
 * sidecar. Zero tokens, no network, no fastembed at test time.
 *
 * Regenerate the sidecar after changing scenarios or embed text:
 *   pnpm --filter @equationalapplications/benchmarks-llm-wiki fixture:gate-embeddings
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { calibrationRows, expectedClass, recommendThresholds } from '../src/calibrate';
import { decisionLog, loadSidecar, sidecarEmbed, SIDECAR_PATH, type DecisionRow } from '../src/gate/decisionLog';
import type { Scenario } from '../src/supersession/run';

const scenarios = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'supersession', 'scenarios.json'), 'utf8'),
) as Scenario[];

/**
 * Rows the gate misroutes today at production thresholds, keyed
 * `${scenario}::${candidateIndex}`. A fix that corrects one must remove it;
 * a new misroute fails the suite.
 */
const KNOWN_MISROUTES: ReadonlySet<string> = new Set<string>([
  // Labelled gate-ADD; the gate sends them to the resolver (cosine 0.80 / 0.67
  // to an unrelated neighbour). Safe direction: one extra LLM item, no data loss.
  // Same 2 rows as results/calibration-7.7.7.json.
  'mixed-1-three-candidates-noop-add-supersede::1',
  'mixed-1-three-candidates-noop-add-supersede::2',
]);

beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network blocked in diagnostics suite');
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('gate decision log', () => {
  let rows: DecisionRow[] = [];

  beforeAll(async () => {
    const embed = sidecarEmbed(loadSidecar(SIDECAR_PATH));
    rows = [];
    for (const s of scenarios) rows.push(...(await decisionLog(s, embed)));
    const table = [...rows]
      .sort((a, b) => Math.abs(a.margin ?? 9) - Math.abs(b.margin ?? 9))
      .map((r) => ({
        key: r.key,
        decision: r.decision,
        expected: expectedClass(scenarios.find((s) => s.name === r.scenario)!, r.candidateIndex),
        bestCosine: r.bestCosine?.toFixed(3) ?? '-',
        margin: r.margin?.toFixed(3) ?? '-',
      }));
    console.table(table);
  }, 120_000);

  it('logs one row per candidate', () => {
    const expected = scenarios.reduce((a, s) => a + s.extract.facts.length, 0);
    expect(rows).toHaveLength(expected);
  });

  it('every scenario gates as labelled at production thresholds, except known misroutes', () => {
    const misroutes = rows
      .filter((r) => r.decision !== expectedClass(scenarios.find((s) => s.name === r.scenario)!, r.candidateIndex))
      .map((r) => r.key)
      .filter((k) => !KNOWN_MISROUTES.has(k));
    expect(misroutes).toEqual([]);
  });

  it('known misroutes still misroute (remove fixed rows from the list)', () => {
    for (const key of KNOWN_MISROUTES) {
      const r = rows.find((x) => x.key === key);
      expect(r, key).toBeDefined();
      const s = scenarios.find((x) => x.name === r!.scenario)!;
      expect(r!.decision, key).not.toBe(expectedClass(s, r!.candidateIndex));
    }
  });
});

describe('calibrate on the sidecar', () => {
  it('covers every string calibrationRows embeds and reproduces 2 misclassified at defaults', async () => {
    const rows = await calibrationRows(scenarios, sidecarEmbed(loadSidecar(SIDECAR_PATH)));
    expect(recommendThresholds(rows).misclassifiedAtDefaults).toBe(2);
  });
});

describe('decisionLog with an incomplete sidecar', () => {
  it('throws the re-run message instead of silently falling back to keyword mode', async () => {
    const full = loadSidecar(SIDECAR_PATH);
    const s = scenarios.find((x) => x.name === 'relocation-1-seattle-to-sf')!;
    // Drop the vectors of the scenario's existing facts (core swallows embed
    // errors in runReembed / embedTextForFact, so only decisionLog can notice).
    const partial = new Map([...full].filter(([text]) => !s.existing.some((f) => text.includes(f.title))));
    expect(partial.size).toBeLessThan(full.size);
    await expect(decisionLog(s, sidecarEmbed(partial))).rejects.toThrow(/re-run pnpm fixture:gate-embeddings/);
  });
});

describe('sidecarEmbed', () => {
  it('fails loudly on a text with no recorded vector', async () => {
    await expect(sidecarEmbed(new Map())('x')).rejects.toThrow(/re-run pnpm fixture:gate-embeddings/);
  });
});
