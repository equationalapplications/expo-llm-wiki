import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { computeNDCG } from '../helpers/ndcg';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const RESULTS_DIR = path.join(__dirname, '..', 'benchmark-results');

let wiki: WikiMemory;
let queries: Record<string, string>;
let qrels: Record<string, string[]>;

beforeAll(async () => {
  const dumpGz = fs.readFileSync(path.join(FIXTURES, 'scifact-dump.json.gz'));
  const dumpJson = zlib.gunzipSync(dumpGz).toString('utf8');
  const dump = JSON.parse(dumpJson) as MemoryDump;

  queries = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'scifact-queries.json'), 'utf8')
  ) as Record<string, string>;

  qrels = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'scifact-qrels.json'), 'utf8')
  ) as Record<string, string[]>;

  const embedder = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15 });

  async function embed(text: string): Promise<number[]> {
    for await (const batch of embedder.embed([text])) {
      return Array.from(batch[0]);
    }
    throw new Error('fastembed returned no vectors');
  }

  const db = openTestDatabase();
  wiki = new WikiMemory(db, {
    llmProvider: { generateText: async () => '{}', embed },
    config: { maxResults: 10 },
  });
  await wiki.setup();
  await wiki.importDump(dump);
}, 120_000);

describe('SciFact BEIR benchmark', () => {
  it(
    'mean NDCG@10 ≥ 0.30 across all 300 SciFact test queries',
    async () => {
      const scores: number[] = [];

      for (const [queryId, queryText] of Object.entries(queries)) {
        const relevant = new Set(qrels[queryId] ?? []);
        if (relevant.size === 0) continue;

        const { facts } = await wiki.read('scifact-corpus', queryText);
        const rankedIds = facts.map((f) => f.id);
        scores.push(computeNDCG(rankedIds, relevant, 10));
      }

      const meanNDCG = scores.reduce((a, b) => a + b, 0) / scores.length;

      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const report = {
        dataset: 'SciFact',
        model: 'BGESmallENV15',
        retriever: 'expo-llm-wiki hybrid',
        date: new Date().toISOString(),
        metrics: { 'ndcg@10': parseFloat(meanNDCG.toFixed(4)), queryCount: scores.length },
        baselines: { BM25: 0.665, DPR: 0.318 },
      };
      const fname = `scifact-${Date.now()}.json`;
      fs.writeFileSync(path.join(RESULTS_DIR, fname), JSON.stringify(report, null, 2));
      console.log(`\n  NDCG@10: ${meanNDCG.toFixed(4)}  (BM25=0.665, DPR=0.318)`);
      console.log(`  Report: benchmark-results/${fname}`);

      expect(meanNDCG).toBeGreaterThanOrEqual(0.30);
    },
    120_000
  );
});
