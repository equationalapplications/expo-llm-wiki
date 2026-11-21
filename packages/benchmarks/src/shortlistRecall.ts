/**
 * Pure shortlist-recall benchmark (PR 2a, spec §2). No fastembed import, no
 * I/O, no LLM: the embedder arrives injected; CLI wiring lives in
 * `src/cli.ts` (`runShortlistRecallCommand`). Deterministic distractor
 * pools come from an FNV-1a hash seeded by {@link DISTRACTOR_SEED}.
 */

import {
  SEED_NODES,
  TARGET_TYPES,
  type StatementFixtureEntry,
  type TargetType,
} from './statementKinds/run';
import { cosineSimilarity } from '../../core/src/utils/cosine';
import { shortlistScore, type ShortlistRow } from '../../core/src/utils/shortlist';
import { normalizeTitleKey } from '../../core/src/utils/ontology';
import { titleTokens } from '../../core/src/utils/pure';

// ---------------------------------------------------------------------------
// Seed + distractor pools
// ---------------------------------------------------------------------------

/** Fixed seed for the deterministic distractor generator (recorded in reports). */
export const DISTRACTOR_SEED = 'shortlist-recall-2026-11';

/** k values swept for recall@k (k=1 is the seed-only check). */
export const K_SWEEP = [1, 3, 5, 10, 25] as const;
/** k used for the seed-only pool (seed pool size is 3, so k>3 is meaningless). */
export const SEED_POOL_K = [1, 3] as const;

const WORD_LIST_A = [
  'harbor', 'lantern', 'meadow', 'summit', 'harvest', 'gallery', 'ember',
  'cascade', 'fjord', 'cobalt', 'saffron', 'willow', 'basin', 'granite',
  'orchard', 'thicket', 'quarry', 'velvet', 'cinder', 'prairie',
];
const WORD_LIST_B = [
  'protocol', 'ledger', 'compass', 'blueprint', 'chronicle', 'beacon',
  'reservoir', 'anchor', 'citadel', 'horizon', 'boulder', 'prism',
  'anvil', 'monsoon', 'cipher', 'terrace', 'mosaic', 'relay',
];

/** FNV-1a 32-bit over a UTF-8 string. Deterministic across runtimes. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic distractor rows: `count` synthetic titles of the shape
 * `Distractor Node <i> <wordA> <wordB>`, hashed from
 * `DISTRACTOR_SEED-<i>` (FNV-1a), split into two fixed word lists. Titles
 * are unique under `normalizeTitleKey` by construction (the index differs).
 * Words are ≥ 3 chars and drawn from lists that exclude every seed-title
 * token (`orbit`, `deploy`, `acme`, `labs`), so lexical overlap with the
 * fixture targets comes only from the fact bodies, never the distractors.
 */
export function buildDistractors(count: number): ShortlistRow[] {
  const banned = new Set<string>();
  for (const t of ['Orbit', 'Deploy', 'Acme Labs']) {
    for (const tok of titleTokens(t)) banned.add(tok);
  }
  for (const list of [WORD_LIST_A, WORD_LIST_B]) {
    for (const w of list) {
      if (banned.has(w.toLowerCase())) throw new Error(`distractor word list collides with a seed title token: ${w}`);
    }
  }
  const rows: ShortlistRow[] = [];
  for (let i = 0; i < count; i++) {
    const h = fnv1a(`${DISTRACTOR_SEED}-${i}`);
    const a = WORD_LIST_A[h % WORD_LIST_A.length];
    const b = WORD_LIST_B[(h >>> 16) % WORD_LIST_B.length];
    const okf = TARGET_TYPES[i % TARGET_TYPES.length];
    rows.push({ title: `Distractor Node ${i} ${a} ${b}`, okf_type: okf });
  }
  return rows;
}

/**
 * Seed for the title-variant distractor generator (extends the
 * {@link DISTRACTOR_SEED} scheme). Owner-ruled 2026-11-21: lexical recall
 * saturated at 1.0 on the pure lexical distractor pools, so hard negatives
 * built by mutating the seed titles land in a separate pool.
 */
export const VARIANT_SEED = 'shortlist-recall-2026-11-variant';

/**
 * Per-word synonyms for title-variant mutations, keyed by base-title word.
 * None of the synonyms normalize to a seed title, so a variant can never
 * corrupt ground truth (rankRows dedupes by normalizeTitleKey last-wins).
 */
export const VARIANT_SYNONYMS: Record<string, string[]> = {
  Orbit: ['Orbital', 'Halo', 'Reverie'],
  Deploy: ['Deployment', 'Release', 'Rollout'],
  Acme: ['Apex', 'Zenith', 'Vertex'],
  Labs: ['Laboratories', 'Workshop', 'Studio'],
};

/** Mutation kinds applied to seed titles when building variant distractors. */
export const MUTATION_KINDS = ['reorder', 'synonym', 'truncate'] as const;

export type PoolName = 'seed' | 'distractor-50' | 'distractor-200' | 'distractor-variants';

/**
 * The three seed rows every pool nests (ground-truth targets). Derived from
 * `SEED_NODES` (`statementKinds/run.ts`) — the fixture-authoritative source —
 * with `type` mapped to the row shape's `okf_type`, so the two lists cannot
 * drift (T3 #448-r2 nit 1). `buildVariantDistractors` derives its seed-key
 * guard from these titles, so a seed-title rename moves the guard with it
 * (T3 review #447 m4). Frozen: callers get copies, so no in-place mutation
 * can corrupt later calls or the guard (T3 delta review #447 m2).
 */
export const SEED_ROWS: readonly ShortlistRow[] = Object.freeze(
  SEED_NODES.map(({ title, type, body }) => Object.freeze({ title, okf_type: type, body })),
);

/** The four evaluation pools, each self-contained (seed rows always present). */
export function buildPools(): Record<PoolName, ShortlistRow[]> {
  const seed = SEED_ROWS.map((r) => ({ ...r }));
  const d50 = buildDistractors(50);
  const d200 = buildDistractors(200);
  return {
    seed,
    'distractor-50': [...seed, ...d50],
    'distractor-200': [...seed, ...d200],
    'distractor-variants': [...seed, ...buildVariantDistractors(50)],
  };
}

export const POOL_NAMES: readonly PoolName[] = ['seed', 'distractor-50', 'distractor-200', 'distractor-variants'];

// ---------------------------------------------------------------------------
// Title-variant distractors (owner-ruled saturation trigger, 2026-11-21)
// ---------------------------------------------------------------------------

const VARIANT_BASES = ['Orbit', 'Deploy', 'Acme Labs'] as const;

const VARIANT_BODIES: Record<(typeof VARIANT_BASES)[number], (extra: string) => string> = {
  Orbit: (extra) => `The ${extra} variant memo: a mobile application the organization builds and ships.`,
  Deploy: (extra) => `The ${extra} variant memo: releasing builds to production for the application.`,
  'Acme Labs': (extra) => `The ${extra} variant memo: the software organization behind the application.`,
};

/** Apply one mutation kind to a base title using hash-derived choices. */
function mutateTitle(base: string, kind: (typeof MUTATION_KINDS)[number], h: number): string {
  let words = base.split(' ');
  if (kind === 'reorder') {
    if (words.length > 1) return words.reverse().join(' ');
    kind = 'synonym'; // single word cannot reorder
  }
  if (kind === 'synonym') {
    const replaceable = words.map((w, i) => (VARIANT_SYNONYMS[w] ? i : -1)).filter((i) => i >= 0);
    if (replaceable.length > 0) {
      const wordIdx = replaceable[(h >>> 20) % replaceable.length];
      const syns = VARIANT_SYNONYMS[words[wordIdx]];
      words[wordIdx] = syns[(h >>> 24) % syns.length];
      return words.join(' ');
    }
    kind = 'truncate'; // nothing replaceable
  }
  // 'truncate': drop the last word; single-word titles drop the final char.
  words = base.split(' ');
  if (words.length > 1) return words.slice(0, -1).join(' ');
  return words[0].slice(0, -1);
}

/**
 * Deterministic title-variant distractors: hard negatives built by
 * reordering, synonym-swapping or truncating a seed title (FNV-1a hashed
 * from {@link VARIANT_SEED}-`i`), suffixed with a {@link WORD_LIST_B} word
 * for uniqueness headroom. The skip-and-advance loop silently skips any
 * duplicate key (one is never emitted), and the seed keys are pre-seeded into
 * the seen-set, so a variant title colliding with a seed title is skipped too
 * — never emitted — which is what protects ground truth, since rankRows
 * dedupes by normalizeTitleKey last-wins and such a row would corrupt it.
 * The candidate keyspace is finite (unique titles across bases × kinds ×
 * WORD_LIST_B), so `count` above the keyspace size can never terminate:
 * the iteration cap throws instead of hanging (pre-PR review finding,
 * 2026-11-21; keyspace is 288 with the current lists).
 */
const MAX_VARIANT_ITERATIONS = 50_000;

export function buildVariantDistractors(count = 50): ShortlistRow[] {
  const seedKeys = new Set(SEED_ROWS.map((r) => normalizeTitleKey(r.title)));
  const seen = new Set<string>(seedKeys);
  const rows: ShortlistRow[] = [];
  let i = 0;
  while (rows.length < count) {
    if (i >= MAX_VARIANT_ITERATIONS) {
      throw new Error(
        `buildVariantDistractors: candidate keyspace exhausted after ${i} iterations (requested ${count} unique rows)`,
      );
    }
    const h = fnv1a(`${VARIANT_SEED}-${i}`);
    const base = VARIANT_BASES[h % 3];
    const kind = MUTATION_KINDS[(h >>> 8) % 3];
    const extra = WORD_LIST_B[(h >>> 16) % WORD_LIST_B.length];
    const title = `${mutateTitle(base, kind, h)} ${extra}`;
    const key = normalizeTitleKey(title);
    const typeIndex = i; // pre-increment index, matching buildDistractors (T3 review #447 m7)
    i++;
    if (seen.has(key)) continue; // skip-and-advance
    seen.add(key);
    rows.push({
      title,
      okf_type: TARGET_TYPES[typeIndex % TARGET_TYPES.length],
      body: VARIANT_BODIES[base](extra.toLowerCase()),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Guard + metrics
// ---------------------------------------------------------------------------

/**
 * Throw unless every fixture entry's `expected_target` resolves to a stored
 * seed node by title (exact match) with a type among {@link TARGET_TYPES}.
 * Per spec §3: "every recall hit must be earned, not injected."
 */
export function groundTruthCheck(
  pools: Record<PoolName, ShortlistRow[]>,
  entries: ReadonlyArray<StatementFixtureEntry>,
): void {
  const seed = pools['seed'];
  for (const e of entries) {
    const hit = seed.find((r) => normalizeTitleKey(r.title) === normalizeTitleKey(e.expected_target.title));
    if (!hit) {
      throw new Error(`ground-truth guard: fixture target "${e.expected_target.title}" is not a seed node`);
    }
    if (hit.okf_type !== e.expected_target.type) {
      throw new Error(`ground-truth guard: fixture target "${e.expected_target.title}" type mismatch: ${hit.okf_type} != ${e.expected_target.type}`);
    }
    if (!(TARGET_TYPES as readonly string[]).includes(e.expected_target.type)) {
      throw new Error(`ground-truth guard: fixture target type "${e.expected_target.type}" is not a known node type`);
    }
  }
}

/**
 * recall@k for one ranked list: 1 if any of the top `k` rows' normalized
 * titles is in `hitKeys`, else 0. This is the spec's lenient definition:
 * the hit is on the title alone (a title match with a wrong type is still
 * a recall hit — type accuracy is measured separately by
 * `typeAccuracyAtK` on the top-ranked hit).
 */
export function recallAtK(ranked: ShortlistRow[], hitKeys: Set<string>, k: number): number {
  return ranked.slice(0, k).some((r) => hitKeys.has(normalizeTitleKey(r.title))) ? 1 : 0;
}

/** Deterministic random baseline: recall@k of a random draw of k from n. */
export function randomBaseline(k: number, n: number): number {
  return Math.min(k, n) / n;
}

/**
 * Type accuracy at k for one entry: among the top-k rows, take the FIRST
 * row matching the expected title; 1 if its okf_type equals the expected
 * type, 0 otherwise (including when no top-k row matches at all).
 */
export function typeAccuracyAtK(
  ranked: ShortlistRow[],
  expectedTitle: string,
  expectedType: TargetType,
  k: number,
): number {
  const key = normalizeTitleKey(expectedTitle);
  const hit = ranked.slice(0, k).find((r) => normalizeTitleKey(r.title) === key);
  return hit ? (hit.okf_type === expectedType ? 1 : 0) : 0;
}

// ---------------------------------------------------------------------------
// Scoring + report
// ---------------------------------------------------------------------------

export type EmbedFn = (text: string) => Promise<number[]>;

/** Row text embedded for the vector scorer: title + body. */
export function rowText(row: ShortlistRow): string {
  return `${row.title} ${row.body ?? ''}`;
}

export interface PerEntryRecord {
  entryIndex: number;
  pool: PoolName;
  expectedTitle: string;
  expectedType: TargetType;
  /** okf_type of the first top-k row matching the expected title, per scorer. */
  actualTypes: { lexical: string | null; embedding: string | null };
  /** recall@k per scorer per swept k (seed pool uses SEED_POOL_K). */
  hitByK: {
    lexical: Record<number, number>;
    embedding: Record<number, number>;
  };
}

export interface ShortlistRecallReport {
  fixtureEntries: number;
  pools: Record<PoolName, { size: number }>;
  lexical: Record<PoolName, Record<number, number>>;
  embedding: Record<PoolName, Record<number, number>>;
  randomBaseline: Record<PoolName, Record<number, number>>;
  typeAccuracyAtK5: {
    lexical: Record<PoolName, number>;
    embedding: Record<PoolName, number>;
  };
  determinism: {
    distractorSeed: string;
    hash: 'fnv1a-32';
    wordLists: { a: string[]; b: string[] };
    variantSeed: string;
    mutationKinds: string[];
    variantSynonyms: Record<string, string[]>;
    embedModel: string;
    engineVersion: string;
    fastembedVersion: string;
  };
  perEntry: PerEntryRecord[];
}

function ksFor(pool: PoolName): readonly number[] {
  return pool === 'seed' ? SEED_POOL_K : K_SWEEP;
}

/**
 * Run the recall benchmark across all pools and entries. `embed` is
 * injected (tests pass a stub; the CLI resolves the real fastembed
 * embedder). Purely in-memory: no model download, no network, no LLM.
 */
export async function runShortlistRecall(deps: {
  entries: ReadonlyArray<StatementFixtureEntry>;
  embed: EmbedFn;
  meta: { embedModel: string; engineVersion: string; fastembedVersion: string };
}): Promise<ShortlistRecallReport> {
  const pools = buildPools();
  // Guard BEFORE any embedding work so a malformed fixture fails fast.
  groundTruthCheck(pools, deps.entries);

  // Memoised embeddings: one vector per unique row text, one per fact.
  const vecCache = new Map<string, number[]>();
  const embedMemo = async (text: string): Promise<number[]> => {
    const hit = vecCache.get(text);
    if (hit) return hit;
    const v = await deps.embed(text);
    vecCache.set(text, v);
    return v;
  };
  for (const pool of POOL_NAMES) {
    for (const row of pools[pool]) await embedMemo(rowText(row));
  }
  const factVecs: number[][] = [];
  for (const e of deps.entries) factVecs.push(await embedMemo(e.text));

  const scoring = {
    lexical: (fact: { title: string; body: string }) => (row: ShortlistRow) =>
      shortlistScore(fact.title, fact.body, row),
    embedding: (factVec: number[]) => (row: ShortlistRow) => {
      // Score computed synchronously from memoised vectors.
      return cosineSimilarity(factVec, vecCache.get(rowText(row))!);
    },
  };

  const perEntry: PerEntryRecord[] = [];
  const agg = Object.fromEntries(
    POOL_NAMES.map((pool) => [pool, {}]),
  ) as Record<PoolName, Record<number, { lexHits: number; embHits: number; typeLex: number; typeEmb: number }>>;

  for (const pool of POOL_NAMES) {
    const rows = pools[pool];
    for (const k of ksFor(pool)) agg[pool][k] = { lexHits: 0, embHits: 0, typeLex: 0, typeEmb: 0 };
    deps.entries.forEach((entry, entryIndex) => {
      const fact = { title: '', body: entry.text };
      const factVec = factVecs[entryIndex];
      const rankedLex = rankRows(rows, scoring.lexical(fact));
      const rankedEmb = rankRows(rows, scoring.embedding(factVec));
      const hitKeys = new Set([normalizeTitleKey(entry.expected_target.title)]);
      const ks = ksFor(pool);
      const record: PerEntryRecord = {
        entryIndex,
        pool,
        expectedTitle: entry.expected_target.title,
        expectedType: entry.expected_target.type,
        actualTypes: { lexical: null, embedding: null },
        hitByK: { lexical: {}, embedding: {} },
      };
      for (const k of ks) {
        const lex = recallAtK(rankedLex, hitKeys, k);
        const emb = recallAtK(rankedEmb, hitKeys, k);
        record.hitByK.lexical[k] = lex;
        record.hitByK.embedding[k] = emb;
        agg[pool][k].lexHits += lex;
        agg[pool][k].embHits += emb;
      }
      const typeLex = typeAccuracyAtK(rankedLex, entry.expected_target.title, entry.expected_target.type, 5);
      const typeEmb = typeAccuracyAtK(rankedEmb, entry.expected_target.title, entry.expected_target.type, 5);
      agg[pool][5] ??= { lexHits: 0, embHits: 0, typeLex: 0, typeEmb: 0 };
      agg[pool][5].typeLex += typeLex;
      agg[pool][5].typeEmb += typeEmb;
      const hitLex = rankedLex.slice(0, 5).find((r) => normalizeTitleKey(r.title) === hitKeys.values().next().value!);
      const hitEmb = rankedEmb.slice(0, 5).find((r) => normalizeTitleKey(r.title) === hitKeys.values().next().value!);
      record.actualTypes.lexical = hitLex ? hitLex.okf_type : null;
      record.actualTypes.embedding = hitEmb ? hitEmb.okf_type : null;
      perEntry.push(record);
    });
  }

  const n = deps.entries.length;
  const recallOf = (pool: PoolName, scorer: 'lexHits' | 'embHits') => {
    const out: Record<number, number> = {};
    for (const k of ksFor(pool)) out[k] = round4(agg[pool][k][scorer] / n);
    return out;
  };
  const typeOf = (scorer: 'typeLex' | 'typeEmb') => {
    const out = {} as Record<PoolName, number>;
    for (const pool of POOL_NAMES) out[pool] = round4(agg[pool][5][scorer] / n);
    return out;
  };

  return {
    fixtureEntries: n,
    pools: Object.fromEntries(POOL_NAMES.map((pool) => [pool, { size: pools[pool].length }])) as ShortlistRecallReport['pools'],
    lexical: Object.fromEntries(POOL_NAMES.map((pool) => [pool, recallOf(pool, 'lexHits')])) as ShortlistRecallReport['lexical'],
    embedding: Object.fromEntries(POOL_NAMES.map((pool) => [pool, recallOf(pool, 'embHits')])) as ShortlistRecallReport['embedding'],
    randomBaseline: Object.fromEntries(POOL_NAMES.map((pool) => [pool, baselineFor(pool, pools)])) as ShortlistRecallReport['randomBaseline'],
    typeAccuracyAtK5: { lexical: typeOf('typeLex'), embedding: typeOf('typeEmb') },
    determinism: {
      distractorSeed: DISTRACTOR_SEED,
      hash: 'fnv1a-32',
      wordLists: { a: [...WORD_LIST_A], b: [...WORD_LIST_B] },
      variantSeed: VARIANT_SEED,
      mutationKinds: [...MUTATION_KINDS],
      variantSynonyms: Object.fromEntries(Object.entries(VARIANT_SYNONYMS).map(([k, v]) => [k, [...v]])),
      embedModel: deps.meta.embedModel,
      engineVersion: deps.meta.engineVersion,
      fastembedVersion: deps.meta.fastembedVersion,
    },
    perEntry,
  };
}

/** Sort rows by score desc, ties by UTF-16-ascending title. */
function rankRows(rows: ShortlistRow[], score: (row: ShortlistRow) => number): ShortlistRow[] {
  const byKey = new Map<string, ShortlistRow>();
  for (const r of rows) byKey.set(normalizeTitleKey(r.title), r); // dedupe last-wins
  return [...byKey.values()]
    .map((row) => ({ row, score: score(row) }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.row.title < b.row.title ? -1 : a.row.title > b.row.title ? 1 : 0;
    })
    .map((s) => s.row);
}

function baselineFor(pool: PoolName, pools: Record<PoolName, ShortlistRow[]>): Record<number, number> {
  const n = pools[pool].length;
  const out: Record<number, number> = {};
  for (const k of ksFor(pool)) out[k] = round4(randomBaseline(k, n));
  return out;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
