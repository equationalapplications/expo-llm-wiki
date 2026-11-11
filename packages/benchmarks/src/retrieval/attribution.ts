/**
 * Retrieval miss attribution (spec targeted-diagnostics §5).
 *
 * Loads a frozen corpus dump plus its corpus-embedding sidecar from
 * packages/integration/fixtures into in-memory SQLite, then ranks every
 * query under three modes:
 *
 *   - keyword:  `hybridWeight: 0` (skips embed entirely)
 *   - default:  `hybridWeight` unset — the shipped default, pure vector
 *               (see core `types.ts` WikiConfig.hybridWeight)
 *   - hybrid:   `hybridWeight: 0.5` blend
 *
 * Each query is classified by whether its gold documents reach the top 10
 * under each mode. Query vectors come from a committed sidecar, so no
 * fastembed and no network at test time.
 */
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { LLMProvider, MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openDb } from '../db';
import { computeNDCG } from '../../../integration/helpers/ndcg';
import { computeMRR } from '../../../integration/helpers/mrr';

export type Dataset = 'scifact' | 'financebench';
export type EmbedFn = (text: string) => Promise<number[]>;

export const MISS_CLASSES = ['hit', 'keyword-miss', 'vector-miss', 'fusion-demotion', 'both-miss', 'unscorable'] as const;
export type MissClass = (typeof MISS_CLASSES)[number];

const HERE = dirname(fileURLToPath(import.meta.url));
export const INTEGRATION_FIXTURES = join(HERE, '..', '..', '..', 'integration', 'fixtures');
export const QUERY_SIDECAR_DIR = join(HERE, '..', '..', 'fixtures', 'retrieval');

const ENTITY: Record<Dataset, string> = { scifact: 'scifact-corpus', financebench: 'financebench-corpus' };
const METRIC: Record<Dataset, 'ndcg@10' | 'mrr@10'> = { scifact: 'ndcg@10', financebench: 'mrr@10' };
const K = 10;
const HYBRID_BLEND = 0.5;

type Ranks = { keyword: number | null; default: number | null; hybrid: number | null };

export interface AttributionReport {
  dataset: Dataset;
  metric: 'ndcg@10' | 'mrr@10';
  queryCount: number;
  keywordOnly: number;
  /** Shipped default: hybridWeight unset = pure vector. */
  defaultMode: number;
  hybrid: number;
  /** Queries the default (vector) misses in the top 10 while keyword-only hits. Not visible in `classes`, which classify on the blend. */
  rescuedByKeyword: number;
  classes: Record<MissClass, number>;
  /** Up to 10 queries the shipped default misses, with the best gold rank per mode (1-based, null = not in top 10). */
  worst: Array<{ queryId: string; query: string; goldRanks: Ranks }>;
}

export function querySidecarPath(dataset: Dataset): string {
  return join(QUERY_SIDECAR_DIR, `${dataset}-query-embeddings.json.gz`);
}

export function loadQuerySidecar(dataset: Dataset): Map<string, number[]> {
  const raw = JSON.parse(gunzipSync(readFileSync(querySidecarPath(dataset))).toString('utf8')) as { texts: Record<string, number[]> };
  return new Map(Object.entries(raw.texts));
}

export function queryEmbedder(map: ReadonlyMap<string, number[]>): EmbedFn {
  return async (text) => {
    const v = map.get(text);
    if (!v) throw new Error(`no query vector recorded; re-run pnpm fixture:retrieval-queries (text: ${JSON.stringify(text.slice(0, 80))})`);
    return v;
  };
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(INTEGRATION_FIXTURES, file), 'utf8')) as T;
}

export function loadQueries(dataset: Dataset): { queries: Record<string, string>; qrels: Record<string, string[]> } {
  return {
    queries: readJson<Record<string, string>>(`${dataset}-queries.json`),
    qrels: readJson<Record<string, string[]>>(`${dataset}-qrels.json`),
  };
}

/** Import the frozen dump and restore corpus vectors, as packages/integration's suites do. Caller closes. */
export async function loadCorpus(dataset: Dataset, embed: EmbedFn): Promise<{ wiki: WikiMemory; ids: Set<string>; close: () => void }> {
  const handle = openDb();
  const db = handle.adapter;
  const dump = JSON.parse(gunzipSync(readFileSync(join(INTEGRATION_FIXTURES, `${dataset}-dump.json.gz`))).toString('utf8')) as MemoryDump;
  const importer = new WikiMemory(db, {
    llmProvider: { generateText: async () => '{}' } as unknown as LLMProvider,
    config: { maxResults: K },
  });
  await importer.setup();
  await importer.importDump(dump);
  const embMap = JSON.parse(
    gunzipSync(readFileSync(join(INTEGRATION_FIXTURES, `${dataset}-embeddings.json.gz`))).toString('utf8'),
  ) as Record<string, number[]>;
  await db.withTransactionAsync(async (tx) => {
    for (const [id, vec] of Object.entries(embMap)) {
      const blob = new Uint8Array(new Float32Array(vec).buffer);
      await tx.runAsync('UPDATE llm_wiki_entries SET embedding_blob = ?, embedding = NULL WHERE id = ?', [blob, id]);
    }
  });
  const dim = Object.values(embMap)[0]?.length;
  if (dim) await db.runAsync("INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('embedding_dimension', ?)", [String(dim)]);
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText: async () => '{}', embed } as unknown as LLMProvider,
    config: { maxResults: K },
  });
  await wiki.setup();
  const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM llm_wiki_entries WHERE entity_id = ?', [ENTITY[dataset]]);
  return { wiki, ids: new Set(rows.map((r) => r.id)), close: () => handle.close() };
}

function bestRank(ranked: string[], gold: Set<string>): number | null {
  const i = ranked.findIndex((id) => gold.has(id));
  return i >= 0 && i < K ? i + 1 : null;
}

export function classify(r: Ranks, scorable: boolean): MissClass {
  if (!scorable) return 'unscorable';
  if (r.hybrid !== null) return 'hit';
  const kw = r.keyword !== null;
  const vec = r.default !== null;
  if (kw && vec) return 'fusion-demotion';
  if (vec) return 'keyword-miss';
  if (kw) return 'vector-miss';
  return 'both-miss';
}

export async function attribute(
  dataset: Dataset,
  opts: { sidecar?: ReadonlyMap<string, number[]> } = {},
): Promise<AttributionReport> {
  const { queries, qrels } = loadQueries(dataset);
  // Core's read() catches embed errors and silently falls back to keyword
  // search, so a sidecar miss would corrupt the "default" numbers. Record
  // misses and fail loudly (same guard as gate/decisionLog.ts).
  const inner = queryEmbedder(opts.sidecar ?? loadQuerySidecar(dataset));
  const misses: string[] = [];
  const embed: EmbedFn = async (text) => {
    try {
      return await inner(text);
    } catch (e) {
      misses.push(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };
  const { wiki, ids, close } = await loadCorpus(dataset, embed);
  const score = METRIC[dataset] === 'ndcg@10' ? computeNDCG : computeMRR;
  const sums = { keyword: 0, default: 0, hybrid: 0 };
  const classes = Object.fromEntries(MISS_CLASSES.map((c) => [c, 0])) as Record<MissClass, number>;
  const worst: AttributionReport['worst'] = [];
  let queryCount = 0;
  let rescuedByKeyword = 0;
  try {
    for (const [queryId, query] of Object.entries(queries)) {
      const gold = new Set(qrels[queryId] ?? []);
      if (gold.size === 0) continue;
      queryCount += 1;
      const scorable = [...gold].some((id) => ids.has(id));
      const ranked = {
        keyword: (await wiki.read(ENTITY[dataset], query, { hybridWeight: 0 })).facts.map((f) => f.id),
        default: (await wiki.read(ENTITY[dataset], query)).facts.map((f) => f.id),
        hybrid: (await wiki.read(ENTITY[dataset], query, { hybridWeight: HYBRID_BLEND })).facts.map((f) => f.id),
      };
      for (const m of ['keyword', 'default', 'hybrid'] as const) sums[m] += score(ranked[m], gold, K);
      const ranks: Ranks = {
        keyword: bestRank(ranked.keyword, gold),
        default: bestRank(ranked.default, gold),
        hybrid: bestRank(ranked.hybrid, gold),
      };
      if (misses.length > 0) {
        throw new Error(`attribute(${dataset}): ${misses.length} query embed failure(s); ${misses[0]}`);
      }
      classes[classify(ranks, scorable)] += 1;
      if (ranks.default === null && ranks.keyword !== null) rescuedByKeyword += 1;
      if (scorable && ranks.default === null && worst.length < 10) worst.push({ queryId, query, goldRanks: ranks });
    }
  } finally {
    close();
  }
  return {
    dataset,
    metric: METRIC[dataset],
    queryCount,
    keywordOnly: sums.keyword / queryCount,
    defaultMode: sums.default / queryCount,
    hybrid: sums.hybrid / queryCount,
    rescuedByKeyword,
    classes,
    worst,
  };
}
