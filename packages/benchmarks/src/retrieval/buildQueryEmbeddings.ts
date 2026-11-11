/**
 * Build `fixtures/retrieval/<dataset>-query-embeddings.json.gz` (spec
 * targeted-diagnostics §5). Runs every query through `read()` with a
 * recording fastembed embedder, so the keys are exactly the strings the
 * retrieval path embeds. Local ONNX; zero tokens. Run by hand, never in CI:
 *
 *   pnpm --filter @equationalapplications/benchmarks-llm-wiki fixture:retrieval-queries
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';
import { getEmbedder } from '../embed';
import { loadCorpus, loadQueries, querySidecarPath, type Dataset } from './attribution';

/**
 * Run every query through `read()` with `embed` and record the vectors under
 * the exact strings the retrieval path sends. Core's `read()` swallows embed
 * errors and falls back to keyword search, so failures are recorded here and
 * the build fails: an incomplete sidecar must never be written.
 */
export async function recordQueryVectors(
  dataset: Dataset,
  embed: (t: string) => Promise<number[]>,
): Promise<Record<string, number[]>> {
  const texts: Record<string, number[]> = {};
  const failures: string[] = [];
  const recording = async (t: string) => {
    if (texts[t]) return texts[t]!;
    try {
      const v = (await embed(t)).map((x) => Math.round(x * 1e6) / 1e6);
      texts[t] = v;
      return v;
    } catch (e) {
      failures.push(`${JSON.stringify(t.slice(0, 60))}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  };
  const { queries } = loadQueries(dataset);
  const { wiki, close } = await loadCorpus(dataset, recording);
  try {
    for (const q of Object.values(queries)) await wiki.read(ENTITY_OF[dataset], q);
  } finally {
    close();
  }
  if (failures.length > 0) {
    throw new Error(`${dataset}: ${failures.length} query embed failure(s); sidecar not written. First: ${failures[0]}`);
  }
  const expected = new Set(Object.values(queries).map((q) => q.trim()).filter((q) => q.length > 0));
  const missing = [...expected].filter((q) => !(q in texts));
  if (missing.length > 0) {
    throw new Error(`${dataset}: ${missing.length} query text(s) never reached embed; sidecar not written. First: ${JSON.stringify(missing[0]!.slice(0, 60))}`);
  }
  return texts;
}

const ENTITY_OF: Record<Dataset, string> = { scifact: 'scifact-corpus', financebench: 'financebench-corpus' };

async function build(dataset: Dataset): Promise<void> {
  const texts = await recordQueryVectors(dataset, await getEmbedder());
  const out = querySidecarPath(dataset);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, gzipSync(JSON.stringify({ model: 'BGESmallENV15', texts })));
  console.log(`${dataset}: wrote ${Object.keys(texts).length} query vectors to ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  (async () => {
    await build('scifact');
    await build('financebench');
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
