import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');

async function main() {
  // 1. Init fastembed
  console.log('Initialising fastembed BGE-small-en-v1.5…');
  const embedder = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15 });

  async function embed(text: string): Promise<number[]> {
    for await (const batch of embedder.embed([text])) {
      return Array.from(batch[0]);
    }
    throw new Error('fastembed returned no vectors');
  }

  // 2. Load corpus
  console.log('Loading corpus…');
  const corpusLines = fs
    .readFileSync(path.join(FIXTURES, 'scifact-corpus.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean);
  const corpus = corpusLines.map(
    (l) => JSON.parse(l) as { _id: string; title: string; text: string }
  );
  console.log(`  ${corpus.length} docs`);

  // 3. Build MemoryDump (no BLOBs yet)
  const now = Date.now();
  const dump: MemoryDump = {
    generatedAt: now,
    entities: {
      'scifact-corpus': {
        facts: corpus.map((doc, i) => ({
          id: doc._id,
          entity_id: 'scifact-corpus',
          title: doc.title ?? '',
          body: doc.text ?? '',
          tags: [] as string[],
          confidence: 'certain' as const,
          source_type: 'user_document' as const,
          source_hash: null,
          source_ref: null,
          created_at: (i + 1) * 1000,
          updated_at: (i + 1) * 1000,
          last_accessed_at: null,
          access_count: 0,
          deleted_at: null,
        })),
        tasks: [],
        events: [],
      },
    },
  };

  // 4. Import into WikiMemory and embed via runReembed
  console.log('Importing into WikiMemory…');
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText: async () => '{}', embed },
  });
  await wiki.setup();
  await wiki.importDump(dump);

  console.log('Embedding all docs (this will take a while)…');
  const result = await wiki.runReembed('scifact-corpus');
  console.log(`  embedded: ${result.embedded}, skipped: ${result.skipped}`);

  // 5. Export with BLOBs, gzip, save
  console.log('Exporting…');
  const exported = await wiki.exportDump(['scifact-corpus']);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(exported), 'utf8'), { level: 6 });
  const outPath = path.join(FIXTURES, 'scifact-dump.json.gz');
  fs.writeFileSync(outPath, gz);
  console.log(`Saved ${outPath} (${(gz.length / 1024 / 1024).toFixed(1)} MB)`);

  // 6. Export embeddings separately (the dump strips embedding vectors for portability,
  //    so we export them in a side-car file so the integration test can restore them
  //    directly without re-running fastembed at test time).
  console.log('Exporting embeddings side-car…');
  const embRows = await db.getAllAsync<{ id: string; embedding: string | null }>(
    `SELECT id, embedding FROM llm_wiki_entries WHERE entity_id = 'scifact-corpus' AND embedding IS NOT NULL`
  );
  const embMap: Record<string, number[]> = {};
  for (const row of embRows) {
    embMap[row.id] = JSON.parse(row.embedding!);
  }
  const embGz = zlib.gzipSync(Buffer.from(JSON.stringify(embMap), 'utf8'), { level: 6 });
  const embPath = path.join(FIXTURES, 'scifact-embeddings.json.gz');
  fs.writeFileSync(embPath, embGz);
  console.log(`Saved ${embPath} (${(embGz.length / 1024 / 1024).toFixed(1)} MB)`);

  await db.closeAsync();
}

main().catch((e) => { console.error(e); process.exit(1); });
