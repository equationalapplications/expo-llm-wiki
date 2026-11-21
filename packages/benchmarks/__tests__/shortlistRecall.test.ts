import { describe, expect, it } from 'vitest';

import { parseStatementFixture } from '../src/statementKinds/run';
import {
  DISTRACTOR_SEED,
  VARIANT_SEED,
  VARIANT_SYNONYMS,
  MUTATION_KINDS,
  buildDistractors,
  buildVariantDistractors,
  buildPools,
  groundTruthCheck,
  randomBaseline,
  recallAtK,
  rowText,
  runShortlistRecall,
  typeAccuracyAtK,
  type EmbedFn,
  type ShortlistRecallReport,
  type PoolName,
} from '../src/shortlistRecall';
import { normalizeTitleKey } from '../../core/src/utils/ontology';

const fixturePath = new URL('../fixtures/statement-kinds.json', import.meta.url).pathname;
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { readFileSync } from 'fs';
const entries = parseStatementFixture(readFileSync(fixturePath, 'utf8'));

/** Deterministic stub embedder: hash text → a 16-dim unit-ish vector. */
function stubEmbed(): EmbedFn {
  const cache = new Map<string, number[]>();
  return async (text: string): Promise<number[]> => {
    const hit = cache.get(text);
    if (hit) return hit;
    let h = 2166136261;
    const v = new Array(16).fill(0).map(() => {
      h = Math.imul(h ^ text.charCodeAt((h >>> 24) % text.length || 0), 16777619) >>> 0;
      return ((h >>> 8) % 1000) / 1000 - 0.5;
    });
    cache.set(text, v);
    return v;
  };
}

describe('buildDistractors', () => {
  it('is deterministic across calls (same seed → same rows)', () => {
    expect(buildDistractors(50)).toEqual(buildDistractors(50));
    expect(DISTRACTOR_SEED).toBe('shortlist-recall-2026-11');
  });

  it('generates unique titles under normalizeTitleKey', () => {
    const rows = buildDistractors(200);
    const keys = rows.map((r) => normalizeTitleKey(r.title));
    expect(new Set(keys).size).toBe(200);
  });

  it('produces well-formed rows with typed okf_type', () => {
    const rows = buildDistractors(50);
    expect(rows).toHaveLength(50);
    for (const r of rows) {
      expect(r.title).toMatch(/^Distractor Node \d+ [a-z]+ [a-z]+$/);
      expect(['area', 'software_application', 'organization']).toContain(r.okf_type);
    }
  });

  it('never collides with a seed-title token', () => {
    const seedTokens = new Set(['orbit', 'deploy', 'acme', 'labs']);
    for (const r of buildDistractors(200)) {
      for (const tok of r.title.toLowerCase().split(/\s+/)) {
        expect(seedTokens.has(tok)).toBe(false);
      }
    }
  });
});

describe('buildVariantDistractors', () => {
  const WORD_LIST_B = [
    'protocol', 'ledger', 'compass', 'blueprint', 'chronicle', 'beacon',
    'reservoir', 'anchor', 'citadel', 'horizon', 'boulder', 'prism',
    'anvil', 'monsoon', 'cipher', 'terrace', 'mosaic', 'relay',
  ];
  const seedKeys = new Set(['orbit', 'deploy', 'acme labs']);

  it('is deterministic across calls (same variant seed → same rows)', () => {
    expect(buildVariantDistractors(50)).toEqual(buildVariantDistractors(50));
    expect(VARIANT_SEED).toBe('shortlist-recall-2026-11-variant');
    expect(MUTATION_KINDS).toEqual(['reorder', 'synonym', 'truncate']);
    expect(VARIANT_SYNONYMS).toEqual({
      Orbit: ['Orbital', 'Halo', 'Reverie'],
      Deploy: ['Deployment', 'Release', 'Rollout'],
      Acme: ['Apex', 'Zenith', 'Vertex'],
      Labs: ['Laboratories', 'Workshop', 'Studio'],
    });
  });

  it('returns 50 rows with unique titles under normalizeTitleKey', () => {
    const rows = buildVariantDistractors(50);
    expect(rows).toHaveLength(50);
    const keys = rows.map((r) => normalizeTitleKey(r.title));
    expect(new Set(keys).size).toBe(50);
  });

  it('never collides with a seed title key', () => {
    for (const r of buildVariantDistractors(50)) {
      expect(seedKeys.has(normalizeTitleKey(r.title))).toBe(false);
    }
  });

  it('every title ends with a WORD_LIST_B word and mentions variant in the body', () => {
    for (const r of buildVariantDistractors(50)) {
      const last = r.title.toLowerCase().split(/\s+/).pop()!;
      expect(WORD_LIST_B).toContain(last);
      expect(r.body).toContain('variant');
      expect(['area', 'software_application', 'organization']).toContain(r.okf_type);
    }
  });
});

describe('pools', () => {
  it('seed pool has exactly the 3 fixture targets; others nest it', () => {
    const pools = buildPools();
    expect(pools.seed).toHaveLength(3);
    expect(pools['distractor-50']).toHaveLength(53);
    expect(pools['distractor-200']).toHaveLength(203);
    expect(pools['distractor-variants']).toHaveLength(53);
    expect(pools['distractor-variants'].slice(0, 3)).toEqual(pools.seed);
    const seedKeys = new Set(pools.seed.map((r) => normalizeTitleKey(r.title)));
    for (const pool of ['distractor-50', 'distractor-200', 'distractor-variants'] as const) {
      for (const r of pools[pool].slice(0, 3)) {
        expect(seedKeys.has(normalizeKeyOf(r))).toBe(true);
      }
    }
  });

  it('rowText is title + space + body', () => {
    expect(rowText({ title: 'A', okf_type: 'area', body: 'b words' })).toBe('A b words');
    expect(rowText({ title: 'A', okf_type: 'area' })).toBe('A ');
  });
});

const normalizeKeyOf = (r: { title: string }): string => normalizeTitleKey(r.title);

describe('groundTruthCheck', () => {
  it('passes on the committed fixture', () => {
    expect(() => groundTruthCheck(buildPools(), entries)).not.toThrow();
  });

  it('throws when a fixture target is not a seed node', () => {
    const bad = [{ ...entries[0], expected_target: { title: 'Nonexistent', type: 'area' as const } }];
    expect(() => groundTruthCheck(buildPools(), bad)).toThrow(/not a seed node/);
  });

  it('throws on a type mismatch between fixture and seed', () => {
    const pools = buildPools();
    pools.seed = pools.seed.map((r) => (r.title === 'Deploy' ? { ...r, okf_type: 'software_application' } : r));
    expect(() => groundTruthCheck(pools, entries)).toThrow(/type mismatch/);
  });
});

describe('recallAtK / randomBaseline / typeAccuracyAtK', () => {
  const a = { title: 'Alpha', okf_type: 'area' };
  const b = { title: 'Beta', okf_type: 'organization' };
  const c = { title: 'Gamma', okf_type: 'area' };
  const hits = new Set([normalizeTitleKey('Beta')]);

  it('recallAtK: 1 when the hit lands inside top-k, 0 outside', () => {
    expect(recallAtK([a, b, c], hits, 2)).toBe(1);
    expect(recallAtK([a, c, b], hits, 2)).toBe(0);
    expect(recallAtK([a, c, b], hits, 3)).toBe(1);
    expect(recallAtK([a, c], hits, 2)).toBe(0);
  });

  it('randomBaseline is k/n, floored at 1', () => {
    expect(randomBaseline(1, 100)).toBe(0.01);
    expect(randomBaseline(10, 100)).toBe(0.1);
    expect(randomBaseline(200, 100)).toBe(1);
  });

  it('typeAccuracyAtK: first matching row decides', () => {
    expect(typeAccuracyAtK([a, b], 'Beta', 'organization', 2)).toBe(1);
    expect(typeAccuracyAtK([{ title: 'Beta', okf_type: 'area' }], 'Beta', 'organization', 1)).toBe(0);
    expect(typeAccuracyAtK([a], 'Beta', 'organization', 1)).toBe(0);
  });
});

describe('runShortlistRecall (stub embed, no model download)', () => {
  let report: ShortlistRecallReport;

  it('produces a complete report offline', async () => {
    report = await runShortlistRecall({
      entries,
      embed: stubEmbed(),
      meta: { embedModel: 'stub/test', engineVersion: '9.5.3', fastembedVersion: '3.0.0' },
    });
    expect(report.fixtureEntries).toBe(entries.length);
    expect(report.pools).toEqual({
      seed: { size: 3 },
      'distractor-50': { size: 53 },
      'distractor-200': { size: 203 },
      'distractor-variants': { size: 53 },
    });
    expect(Object.keys(report.lexical)).toEqual(['seed', 'distractor-50', 'distractor-200', 'distractor-variants']);
    // k sweep present, rounded to 4 decimals, all in [0,1]
    for (const scorer of [report.lexical, report.embedding]) {
      for (const pool of ['distractor-50', 'distractor-200'] as PoolName[]) {
        for (const k of [1, 3, 5, 10, 25]) {
          expect(scorer[pool][k]).toBeGreaterThanOrEqual(0);
          expect(scorer[pool][k]).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(report.randomBaseline['distractor-50'][10]).toBeCloseTo(10 / 53, 4);
    expect(report.randomBaseline['distractor-variants'][10]).toBeCloseTo(10 / 53, 4);
    // determinism fields recorded
    expect(report.determinism.distractorSeed).toBe('shortlist-recall-2026-11');
    expect(report.determinism.hash).toBe('fnv1a-32');
    expect(report.determinism.embedModel).toBe('stub/test');
    expect(report.determinism.engineVersion).toBe('9.5.3');
    expect(report.determinism.fastembedVersion).toBe('3.0.0');
    expect(report.determinism.variantSeed).toBe('shortlist-recall-2026-11-variant');
    expect(report.determinism.mutationKinds).toEqual(['reorder', 'synonym', 'truncate']);
    expect(report.determinism.variantSynonyms).toEqual(VARIANT_SYNONYMS);
    expect(report.determinism.variantSynonyms).not.toBe(VARIANT_SYNONYMS);
    // per-entry records for every entry x pool
    expect(report.perEntry).toHaveLength(entries.length * 4);
  });

  it('is deterministic: same inputs → byte-identical report', async () => {
    const again = await runShortlistRecall({
      entries,
      embed: stubEmbed(),
      meta: { embedModel: 'stub/test', engineVersion: '9.5.3', fastembedVersion: '3.0.0' },
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
  });

  it('seed-pool recall is 1 at its swept ks when the target exists', async () => {
    // With a permissive stub (every fact embeds near its target's text) the
    // seed pool of 3 must recall the target at k=3 for both scorers.
    const permissive: EmbedFn = async (text) => text.split('').slice(0, 16).map((c) => c.charCodeAt(0) / 128 - 0.5);
    const r = await runShortlistRecall({
      entries,
      embed: permissive,
      meta: { embedModel: 'stub/test', engineVersion: '9.5.3', fastembedVersion: '3.0.0' },
    });
    expect(r.lexical.seed[3]).toBe(1);
    expect(r.embedding.seed[3]).toBe(1);
  });
});
