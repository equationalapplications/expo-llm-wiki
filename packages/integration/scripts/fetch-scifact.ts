// packages/integration/scripts/fetch-scifact.ts
import * as path from 'path';
import { fileURLToPath } from 'url';
import { assertHttps, readCached, writeFileAtomic } from './fsSafe';
import { toCorpusDoc, toQrelRow, toQueryRow } from './datasetGuards';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const API = 'https://datasets-server.huggingface.co/rows';

interface Row<T> { row: T }
interface PageResponse<T> { rows: Row<T>[]; num_rows_total: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchAllRows(
  dataset: string,
  config: string,
  split: string
): Promise<unknown[]> {
  const results: unknown[] = [];
  let offset = 0;
  const length = 100;
  let total = Infinity;
  while (offset < total) {
    const url = `${API}?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=${offset}&length=${length}`;
    assertHttps(url);
    let res: Response | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      // redirect: 'error' — a redirect to http:// would bypass the assertHttps check.
      res = await fetch(url, { redirect: 'error' });
      if (res.status === 429) {
        const wait = Math.min(5000 * Math.pow(2, attempt), 120000);
        process.stdout.write(`\r  rate-limited, waiting ${(wait/1000).toFixed(0)}s…   `);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
      break;
    }
    if (!res || !res.ok) throw new Error(`Failed after retries: ${url}`);
    const data = (await res.json()) as PageResponse<unknown>;
    total = data.num_rows_total;
    for (const r of data.rows) results.push(r.row);
    offset += data.rows.length;
    process.stdout.write(`\r  ${offset}/${total}  `);
    await sleep(800); // be polite
  }
  process.stdout.write('\n');
  return results;
}

async function main() {
  // corpus — from mteb/scifact corpus split
  const corpusPath = path.join(FIXTURES, 'scifact-corpus.jsonl');
  if (readCached(corpusPath) !== null) {
    console.log('Skipping corpus (already fetched)');
  } else {
    console.log('Fetching corpus…');
    const corpusDocs = (await fetchAllRows('mteb/scifact', 'corpus', 'corpus')).map(toCorpusDoc);
    const corpusJsonl = corpusDocs.map((d) => JSON.stringify(d)).join('\n') + '\n';
    writeFileAtomic(corpusPath, corpusJsonl);
    console.log(`  ${corpusDocs.length} docs`);
  }

  // qrels — from mteb/scifact default/test split
  const qrelsPath = path.join(FIXTURES, 'scifact-qrels.json');
  let qrels: Record<string, string[]>;
  const cachedQrels = readCached(qrelsPath);
  if (cachedQrels !== null) {
    console.log('Skipping qrels (already fetched)');
    qrels = JSON.parse(cachedQrels) as Record<string, string[]>;
  } else {
    console.log('Fetching qrels…');
    const qrelRows = (await fetchAllRows('mteb/scifact', 'default', 'test')).map(toQrelRow);
    qrels = {};
    for (const row of qrelRows) {
      if (row.score > 0) {
        (qrels[row.queryId] ??= []).push(row.corpusId);
      }
    }
    writeFileAtomic(qrelsPath, JSON.stringify(qrels, null, 2));
    console.log(`  ${Object.keys(qrels).length} queries with relevant docs`);
  }

  // queries — only those present in qrels (test set)
  const queriesPath = path.join(FIXTURES, 'scifact-queries.json');
  if (readCached(queriesPath) !== null) {
    console.log('Skipping queries (already fetched)');
  } else {
    console.log('Fetching queries…');
    const allQueryRows = (await fetchAllRows('mteb/scifact', 'queries', 'queries')).map(toQueryRow);
    const testQueryIds = new Set(Object.keys(qrels));
    const queries: Record<string, string> = {};
    for (const row of allQueryRows) {
      if (testQueryIds.has(row._id)) queries[row._id] = row.text;
    }
    writeFileAtomic(queriesPath, JSON.stringify(queries, null, 2));
    console.log(`  ${Object.keys(queries).length} test queries`);
  }

  console.log('\nDone. Run embed-scifact.ts next.');
}

main().catch((e) => { console.error(e); process.exit(1); });
