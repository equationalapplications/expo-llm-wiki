// packages/integration/scripts/fetch-scifact.ts
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const HF = 'https://huggingface.co/datasets/BeIR/scifact/resolve/main';

async function get(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
  return res.text();
}

async function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });

  // corpus — raw JSONL, keep for embed-scifact.ts
  console.log('Fetching corpus.jsonl…');
  const corpusText = await get(`${HF}/corpus.jsonl`);
  fs.writeFileSync(path.join(FIXTURES, 'scifact-corpus.jsonl'), corpusText, 'utf8');
  const docCount = corpusText.split('\n').filter(Boolean).length;
  console.log(`  ${docCount} docs`);

  // queries
  console.log('Fetching queries.jsonl…');
  const queriesText = await get(`${HF}/queries.jsonl`);
  const queries: Record<string, string> = {};
  for (const line of queriesText.split('\n').filter(Boolean)) {
    const { _id, text } = JSON.parse(line) as { _id: string; text: string };
    queries[_id] = text;
  }
  fs.writeFileSync(
    path.join(FIXTURES, 'scifact-queries.json'),
    JSON.stringify(queries, null, 2),
    'utf8'
  );
  console.log(`  ${Object.keys(queries).length} queries`);

  // qrels — TSV, header: query-id\tcorpus-id\tscore
  console.log('Fetching qrels/test.tsv…');
  const qrelsText = await get(`${HF}/qrels/test.tsv`);
  const qrels: Record<string, string[]> = {};
  for (const line of qrelsText.split('\n').filter(Boolean).slice(1)) {
    const [queryId, docId, score] = line.split('\t');
    if (parseInt(score ?? '0', 10) > 0) {
      (qrels[queryId] ??= []).push(docId);
    }
  }
  fs.writeFileSync(
    path.join(FIXTURES, 'scifact-qrels.json'),
    JSON.stringify(qrels, null, 2),
    'utf8'
  );
  console.log(`  ${Object.keys(qrels).length} queries with relevant docs`);

  console.log('\nDone. Run embed-scifact.ts next.');
}

main().catch((e) => { console.error(e); process.exit(1); });
