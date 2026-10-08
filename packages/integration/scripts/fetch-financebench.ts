// packages/integration/scripts/fetch-financebench.ts
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import { assertHttps, readCached, writeFileAtomic } from './fsSafe';
import { toFinanceBenchRow } from './datasetGuards';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const API = 'https://datasets-server.huggingface.co/rows';
const DATASET = 'PatronusAI/financebench';
const SPLIT = 'train';

interface PageResponse<T> {
  rows: { row: T }[];
  num_rows_total: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stableId(docName: string, evidenceText: string): string {
  return crypto
    .createHash('sha256')
    .update(docName + '||' + evidenceText)
    .digest('hex')
    .slice(0, 16);
}

async function fetchAllRows(): Promise<ReturnType<typeof toFinanceBenchRow>[]> {
  const results: ReturnType<typeof toFinanceBenchRow>[] = [];
  let offset = 0;
  const length = 100;
  let total = Infinity;

  while (offset < total) {
    const url =
      `${API}?dataset=${encodeURIComponent(DATASET)}&config=default` +
      `&split=${SPLIT}&offset=${offset}&length=${length}`;
    assertHttps(url);

    let res: Response | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      // redirect: 'error' — a redirect to http:// would bypass the assertHttps check.
      res = await fetch(url, { redirect: 'error' });
      if (res.status === 429) {
        const wait = Math.min(5000 * Math.pow(2, attempt), 120000);
        process.stdout.write(`\r  rate-limited, waiting ${(wait / 1000).toFixed(0)}s…   `);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
      break;
    }
    if (!res || !res.ok) throw new Error(`Failed after retries: ${url}`);

    const data = (await res.json()) as PageResponse<unknown>;
    total = data.num_rows_total;
    if (data.rows.length === 0) throw new Error(`API returned 0 rows at offset ${offset} of ${total}`);
    for (const r of data.rows) results.push(toFinanceBenchRow(r.row));
    offset += data.rows.length;
    process.stdout.write(`\r  ${offset}/${total}  `);
    await sleep(800);
  }
  process.stdout.write('\n');
  return results;
}

async function main() {
  const corpusPath = path.join(FIXTURES, 'financebench-corpus.jsonl');
  const queriesPath = path.join(FIXTURES, 'financebench-queries.json');
  const qrelsPath = path.join(FIXTURES, 'financebench-qrels.json');

  if ([corpusPath, queriesPath, qrelsPath].every((p) => readCached(p) !== null)) {
    console.log('Fixtures already present — delete them to re-fetch.');
    return;
  }

  console.log(`Fetching ${DATASET}/${SPLIT}…`);
  const rows = await fetchAllRows();
  console.log(`  ${rows.length} questions`);

  // Deduplicate evidence texts → corpus
  const corpusMap = new Map<string, { id: string; doc_name: string; text: string }>();
  const queries: Record<string, string> = {};
  const qrels: Record<string, string[]> = {};

  for (const row of rows) {
    queries[row.financebench_id] = row.question;
    const relevantIds: string[] = [];

    for (const ev of row.evidence) {
      const id = stableId(row.doc_name, ev.evidence_text);
      if (!corpusMap.has(id)) {
        corpusMap.set(id, { id, doc_name: row.doc_name, text: ev.evidence_text });
      }
      relevantIds.push(id);
    }
    qrels[row.financebench_id] = [...new Set(relevantIds)];
  }

  writeFileAtomic(
    corpusPath,
    [...corpusMap.values()].map((d) => JSON.stringify(d)).join('\n') + '\n'
  );
  console.log(`  corpus: ${corpusMap.size} unique evidence texts`);

  writeFileAtomic(queriesPath, JSON.stringify(queries, null, 2));
  writeFileAtomic(qrelsPath, JSON.stringify(qrels, null, 2));
  console.log(`  queries: ${Object.keys(queries).length}`);
  console.log('\nDone. Run embed-financebench.ts next.');
}

main().catch((e) => { console.error(e); process.exit(1); });
