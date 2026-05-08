import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { MemoryDump, WikiFact } from '@equationalapplications/core-llm-wiki';

/** Drop embedding_blob from facts without building markdown (formatMemoryDump is heavy for large corpora). */
function stripEmbeddingBlobsFromDump(dump: MemoryDump): MemoryDump {
  return {
    generatedAt: dump.generatedAt,
    entities: Object.fromEntries(
      Object.entries(dump.entities).map(([entityId, bundle]) => [
        entityId,
        {
          ...bundle,
          facts: bundle.facts.map((f) => {
            const { embedding_blob: _blob, ...rest } = f as WikiFact & { embedding_blob?: unknown };
            return rest as WikiFact;
          }),
        },
      ])
    ),
  };
}
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

  // 3. Build MemoryDump (no embeddings yet)
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

  // 5. Export dump JSON (text-only): strip embedding_blob so the gzip stays small;
  //    vectors are written only to the sidecar in step 6.
  console.log('Exporting…');
  const exported = await wiki.exportDump(['scifact-corpus']);
  const stripped = stripEmbeddingBlobsFromDump(exported);
  const compact = JSON.stringify(stripped);
  const gz = zlib.gzipSync(Buffer.from(compact, 'utf8'), { level: 6 });
  const outPath = path.join(FIXTURES, 'scifact-dump.json.gz');
  fs.writeFileSync(outPath, gz);
  console.log(`Saved ${outPath} (${(gz.length / 1024 / 1024).toFixed(1)} MB)`);

  // 6. Export embeddings sidecar. runReembed() stores vectors in embedding_blob and
  //    clears the legacy embedding TEXT column; we read embedding_blob (and fall back
  //    to embedding TEXT for older rows) so integration tests can restore vectors without
  //    re-running fastembed at test time.
  console.log('Exporting embeddings side-car…');
  const embRows = await db.getAllAsync<{
    id: string;
    embedding_blob: Uint8Array | null;
    embedding: string | null;
  }>(
    `SELECT id, embedding_blob, embedding FROM llm_wiki_entries
      WHERE entity_id = 'scifact-corpus'
        AND (embedding_blob IS NOT NULL OR embedding IS NOT NULL)`
  );
  const embMap: Record<string, number[]> = {};
  for (const row of embRows) {
    if (row.embedding_blob) {
      const buf = row.embedding_blob;
      // Ensure 4-byte alignment when slicing into a Float32Array view.
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      embMap[row.id] = Array.from(new Float32Array(ab));
    } else if (row.embedding) {
      embMap[row.id] = JSON.parse(row.embedding);
    }
  }
  if (embRows.length === 0) {
    throw new Error('No embeddings found for scifact-corpus; sidecar would be empty.');
  }
  const embGz = zlib.gzipSync(Buffer.from(JSON.stringify(embMap), 'utf8'), { level: 6 });
  const embPath = path.join(FIXTURES, 'scifact-embeddings.json.gz');
  fs.writeFileSync(embPath, embGz);
  console.log(`Saved ${embPath} (${(embGz.length / 1024 / 1024).toFixed(1)} MB)`);

  await db.closeAsync();
}

main().catch((e) => { console.error(e); process.exit(1); });
