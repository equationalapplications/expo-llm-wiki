// packages/integration/scripts/embed-financebench.ts
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { WikiMemory, parseEmbedding } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const ENTITY_ID = 'financebench-corpus';

function stripBlobs(dump: MemoryDump): MemoryDump {
  return {
    generatedAt: dump.generatedAt,
    entities: Object.fromEntries(
      Object.entries(dump.entities).map(([eid, bundle]) => [
        eid,
        {
          ...bundle,
          facts: bundle.facts.map(({ embedding_blob: _b, ...rest }) => rest),
        },
      ])
    ),
  };
}

async function main() {
  console.log('Initialising fastembed BGE-small-en-v1.5…');
  const embedder = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15 });

  async function embed(text: string): Promise<number[]> {
    for await (const batch of embedder.embed([text])) {
      return Array.from(batch[0]);
    }
    throw new Error('fastembed returned no vectors');
  }

  console.log('Loading corpus…');
  const lines = fs
    .readFileSync(path.join(FIXTURES, 'financebench-corpus.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean);
  const corpus = lines.map((l) => JSON.parse(l) as { id: string; doc_name: string; text: string });
  console.log(`  ${corpus.length} evidence texts`);

  const now = Date.now();
  const dump: MemoryDump = {
    generatedAt: now,
    entities: {
      [ENTITY_ID]: {
        facts: corpus.map((doc, i) => ({
          id: doc.id,
          entity_id: ENTITY_ID,
          title: doc.doc_name,
          body: doc.text,
          tags: [] as string[],
          confidence: 'certain' as const,
          source_type: 'immutable_document' as const,
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

  console.log('Importing into WikiMemory…');
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText: async () => '{}', embed },
  });
  await wiki.setup();
  await wiki.importDump(dump);

  console.log('Embedding all docs…');
  const result = await wiki.runReembed(ENTITY_ID);
  console.log(`  embedded: ${result.embedded}, skipped: ${result.skipped}`);

  console.log('Exporting dump…');
  const exported = await wiki.exportDump([ENTITY_ID]);
  const stripped = stripBlobs(exported);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(stripped), 'utf8'), { level: 6 });
  const dumpPath = path.join(FIXTURES, 'financebench-dump.json.gz');
  fs.writeFileSync(dumpPath, gz);
  console.log(`Saved ${dumpPath} (${(gz.length / 1024 / 1024).toFixed(1)} MB)`);

  console.log('Exporting embeddings sidecar…');
  const embRows = await db.getAllAsync<{
    id: string;
    embedding_blob: Uint8Array | null;
    embedding: string | null;
  }>(
    `SELECT id, embedding_blob, embedding FROM llm_wiki_entries
      WHERE entity_id = '${ENTITY_ID}'
        AND (embedding_blob IS NOT NULL OR embedding IS NOT NULL)`
  );

  const embMap: Record<string, number[]> = {};
  for (const row of embRows) {
    const vec = parseEmbedding(row.embedding_blob, row.embedding);
    if (!vec) {
      const blobLen = row.embedding_blob?.byteLength ?? 0;
      const blobHint =
        row.embedding_blob && blobLen % 4 !== 0
          ? `embedding_blob length ${blobLen} is not a multiple of 4`
          : row.embedding_blob
            ? 'embedding_blob could not be parsed as finite float32 values'
            : 'legacy embedding TEXT is missing or invalid JSON';
      throw new Error(`Invalid embedding for entry ${row.id}: ${blobHint}`);
    }
    embMap[row.id] = Array.from(vec);
  }
  if (embRows.length === 0) throw new Error('No embeddings found; sidecar would be empty.');

  const embGz = zlib.gzipSync(Buffer.from(JSON.stringify(embMap), 'utf8'), { level: 6 });
  const embPath = path.join(FIXTURES, 'financebench-embeddings.json.gz');
  fs.writeFileSync(embPath, embGz);
  console.log(`Saved ${embPath} (${(embGz.length / 1024 / 1024).toFixed(1)} MB)`);

  await db.closeAsync();
}

main().catch((e) => { console.error(e); process.exit(1); });
