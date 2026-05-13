// packages/integration/__tests__/financebench.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { computeMRR, computeHitRate } from '../helpers/mrr';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const RESULTS_DIR = path.join(__dirname, '..', 'benchmark-results');
const TABLE_PREFIX = 'financebench_test_';
const ENTITY_ID = 'financebench-corpus';

let wiki: WikiMemory;
let queries: Record<string, string>;
let qrels: Record<string, string[]>;

beforeAll(async () => {
  const dumpGz = fs.readFileSync(path.join(FIXTURES, 'financebench-dump.json.gz'));
  const dump = JSON.parse(zlib.gunzipSync(dumpGz).toString('utf8')) as MemoryDump;

  queries = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'financebench-queries.json'), 'utf8')
  ) as Record<string, string>;

  qrels = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'financebench-qrels.json'), 'utf8')
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
    llmProvider: { generateText: async () => '{}' },
    config: { maxResults: 10, tablePrefix: TABLE_PREFIX },
  });
  await wiki.setup();
  await wiki.importDump(dump);

  // Restore pre-computed embeddings from sidecar (avoids re-running ONNX at test time)
  const embGz = fs.readFileSync(path.join(FIXTURES, 'financebench-embeddings.json.gz'));
  const embMap = JSON.parse(zlib.gunzipSync(embGz).toString('utf8')) as Record<string, number[]>;

  await db.withTransactionAsync(async () => {
    for (const [id, vec] of Object.entries(embMap)) {
      const float32Vector = new Float32Array(vec);
      const blob = new Uint8Array(float32Vector.buffer);
      await db.runAsync(
        `UPDATE ${TABLE_PREFIX}entries SET embedding_blob = ?, embedding = NULL WHERE id = ?`,
        [blob, id]
      );
    }
  });

  const firstVec = Object.values(embMap)[0];
  if (firstVec) {
    await db.runAsync(
      `INSERT OR REPLACE INTO ${TABLE_PREFIX}meta (key, value) VALUES ('embedding_dimension', ?)`,
      [String(firstVec.length)]
    );
  }

  wiki = new WikiMemory(db, {
    llmProvider: { generateText: async () => '{}', embed },
    config: { maxResults: 10, tablePrefix: TABLE_PREFIX },
  });
  await wiki.setup();
}, 300_000);

describe('FinanceBench retrieval benchmark', () => {
  it(
    'MRR@10 ≥ 0.30 across all 150 FinanceBench questions',
    async () => {
      const mrrScores: number[] = [];
      const hitAt5: number[] = [];
      const hitAt10: number[] = [];

      // Fail loudly if fixtures drift (wrong count or missing qrels)
      expect(Object.keys(queries).length).toBe(150);
      expect(Object.keys(qrels).length).toBe(150);
      const noRelevant = Object.keys(queries).filter((id) => (qrels[id] ?? []).length === 0);
      expect(noRelevant, `Queries missing qrels: [${noRelevant.join(', ')}]`).toHaveLength(0);

      for (const [queryId, queryText] of Object.entries(queries)) {
        const relevant = new Set(qrels[queryId] ?? []);
        if (relevant.size === 0) continue;

        const { facts } = await wiki.read(ENTITY_ID, queryText);
        const rankedIds = facts.map((f) => f.id);

        mrrScores.push(computeMRR(rankedIds, relevant, 10));
        hitAt5.push(computeHitRate(rankedIds, relevant, 5));
        hitAt10.push(computeHitRate(rankedIds, relevant, 10));
      }

      expect(mrrScores).toHaveLength(Object.keys(queries).length);

      const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const meanMRR = mean(mrrScores);
      const meanHit5 = mean(hitAt5);
      const meanHit10 = mean(hitAt10);

      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const report = {
        dataset: 'FinanceBench',
        model: 'BGESmallENV15',
        retriever: 'expo-llm-wiki hybrid',
        date: new Date().toISOString(),
        metrics: {
          'mrr@10': parseFloat(meanMRR.toFixed(4)),
          'hit_rate@5': parseFloat(meanHit5.toFixed(4)),
          'hit_rate@10': parseFloat(meanHit10.toFixed(4)),
          queryCount: mrrScores.length,
        },
      };
      const fname = `financebench-${Date.now()}.json`;
      fs.writeFileSync(path.join(RESULTS_DIR, fname), JSON.stringify(report, null, 2));

      console.log(`\n  MRR@10:       ${meanMRR.toFixed(4)}`);
      console.log(`  Hit Rate@5:   ${meanHit5.toFixed(4)}`);
      console.log(`  Hit Rate@10:  ${meanHit10.toFixed(4)}`);
      console.log(`  Report: benchmark-results/${fname}`);

      expect(meanMRR).toBeGreaterThanOrEqual(0.30);
    },
    300_000
  );
});
