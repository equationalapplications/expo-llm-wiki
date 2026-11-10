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

async function build(dataset: Dataset): Promise<void> {
  const real = await getEmbedder();
  const texts: Record<string, number[]> = {};
  const recording = async (t: string) => {
    const v = texts[t] ?? (texts[t] = (await real(t)).map((x) => Math.round(x * 1e6) / 1e6));
    return v;
  };
  const { queries } = loadQueries(dataset);
  const { wiki, close } = await loadCorpus(dataset, recording);
  try {
    for (const q of Object.values(queries)) await wiki.read(dataset === 'scifact' ? 'scifact-corpus' : 'financebench-corpus', q);
  } finally {
    close();
  }
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
