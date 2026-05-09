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
/** Explicit prefix so raw SQL in this test tracks WikiMemory.tablePrefix / default renames. */
const TABLE_PREFIX = 'scifact_test_';

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

  // embed() is used only for the 300 test queries — corpus embeddings are restored
  // directly from the pre-built sidecar fixture (see scripts/embed-scifact.ts).
  async function embed(text: string): Promise<number[]> {
    for await (const batch of embedder.embed([text])) {
      return Array.from(batch[0]);
    }
    throw new Error('fastembed returned no vectors');
  }

  const db = openTestDatabase();
  wiki = new WikiMemory(db, {
    // No embed during import — corpus embeddings are restored from the sidecar below.
    llmProvider: { generateText: async () => '{}' },
    config: { maxResults: 10, tablePrefix: TABLE_PREFIX },
  });
  await wiki.setup();
  // Import facts (text only; importDump skips embedFact when embed is not provided).
  // Legacy source_type strings in the frozen dump are normalized by importDump().
  await wiki.importDump(dump);

  // Restore pre-computed embeddings from the sidecar fixture in one transaction
  // into embedding_blob (same representation as runReembed), with embedding cleared.
  // This avoids running 5k ONNX inferences at test time (the dump strips blobs
  // for portability; embed-scifact.ts exports vectors in the sidecar).
  const embGz = fs.readFileSync(path.join(FIXTURES, 'scifact-embeddings.json.gz'));
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
  // Store embedding dimension so read() knows to use cosine scoring.
  const firstVec = Object.values(embMap)[0];
  if (firstVec) {
    await db.runAsync(
      `INSERT OR REPLACE INTO ${TABLE_PREFIX}meta (key, value) VALUES ('embedding_dimension', ?)`,
      [String(firstVec.length)]
    );
  }

  // Recreate WikiMemory against the same database with query embedding enabled,
  // avoiding mutation of private/internal fields.
  wiki = new WikiMemory(db, {
    llmProvider: { generateText: async () => '{}', embed },
    config: { maxResults: 10, tablePrefix: TABLE_PREFIX },
  });
  await wiki.setup();
}, 300_000);

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
    300_000
  );
});
