// packages/integration/scripts/fetch-financebench.ts
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const API = 'https://datasets-server.huggingface.co/rows';
const DATASET = 'PatronusAI/financebench';
const SPLIT = 'train';

interface EvidenceItem {
  evidence_text: string;
  page_number: number;
  evidence_file_name: string;
}

interface FinanceBenchRow {
  financebench_id: string;
  question: string;
  doc_name: string;
  evidence: EvidenceItem[];
  answer: string;
}

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

async function fetchAllRows(): Promise<FinanceBenchRow[]> {
  const results: FinanceBenchRow[] = [];
  let offset = 0;
  const length = 100;
  let total = Infinity;

  while (offset < total) {
    const url =
      `${API}?dataset=${encodeURIComponent(DATASET)}&config=default` +
      `&split=${SPLIT}&offset=${offset}&length=${length}`;

    let res: Response | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      res = await fetch(url);
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

    const data = (await res.json()) as PageResponse<FinanceBenchRow>;
    total = data.num_rows_total;
    if (data.rows.length === 0) throw new Error(`API returned 0 rows at offset ${offset} of ${total}`);
    for (const r of data.rows) results.push(r.row);
    offset += data.rows.length;
    process.stdout.write(`\r  ${offset}/${total}  `);
    await sleep(800);
  }
  process.stdout.write('\n');
  return results;
}

async function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });

  const corpusPath = path.join(FIXTURES, 'financebench-corpus.jsonl');
  const queriesPath = path.join(FIXTURES, 'financebench-queries.json');
  const qrelsPath = path.join(FIXTURES, 'financebench-qrels.json');

  if (fs.existsSync(corpusPath) && fs.existsSync(queriesPath) && fs.existsSync(qrelsPath)) {
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

  fs.writeFileSync(
    corpusPath,
    [...corpusMap.values()].map((d) => JSON.stringify(d)).join('\n') + '\n',
    'utf8'
  );
  console.log(`  corpus: ${corpusMap.size} unique evidence texts`);

  fs.writeFileSync(queriesPath, JSON.stringify(queries, null, 2), 'utf8');
  fs.writeFileSync(qrelsPath, JSON.stringify(qrels, null, 2), 'utf8');
  console.log(`  queries: ${Object.keys(queries).length}`);
  console.log('\nDone. Run embed-financebench.ts next.');
}

main().catch((e) => { console.error(e); process.exit(1); });
