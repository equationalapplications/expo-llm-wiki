/**
 * Row guards for the fixture fetch scripts. Fetched rows are rebuilt from known
 * fields only before they are written (CodeQL js/http-to-file-access).
 */

type Rec = Record<string, unknown>;

function record(v: unknown, guard: string): Rec {
  if (typeof v !== 'object' || v === null) throw new Error(`${guard}: not an object`);
  return v as Rec;
}

function str(r: Rec, key: string, guard: string): string {
  const v = r[key];
  if (typeof v !== 'string') throw new Error(`${guard}: ${key}`);
  return v;
}

/** Upstream ids are strings in the committed fixtures; numbers are accepted and stringified. */
function id(r: Rec, key: string, guard: string): string {
  const v = r[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  throw new Error(`${guard}: ${key}`);
}

export function toCorpusDoc(v: unknown): { _id: string; title: string; text: string } {
  const r = record(v, 'toCorpusDoc');
  return { _id: id(r, '_id', 'toCorpusDoc'), title: str(r, 'title', 'toCorpusDoc'), text: str(r, 'text', 'toCorpusDoc') };
}

export function toQrelRow(v: unknown): { queryId: string; corpusId: string; score: number } {
  const r = record(v, 'toQrelRow');
  const score = r.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) throw new Error('toQrelRow: score');
  return { queryId: id(r, 'query-id', 'toQrelRow'), corpusId: id(r, 'corpus-id', 'toQrelRow'), score };
}

export function toQueryRow(v: unknown): { _id: string; text: string } {
  const r = record(v, 'toQueryRow');
  return { _id: id(r, '_id', 'toQueryRow'), text: str(r, 'text', 'toQueryRow') };
}

export function toFinanceBenchRow(v: unknown): {
  financebench_id: string;
  question: string;
  doc_name: string;
  evidence: { evidence_text: string }[];
} {
  const g = 'toFinanceBenchRow';
  const r = record(v, g);
  if (!Array.isArray(r.evidence)) throw new Error(`${g}: evidence`);
  const evidence = r.evidence.map((e) => {
    const er = record(e, g);
    if (typeof er.evidence_text !== 'string') throw new Error(`${g}: evidence`);
    return { evidence_text: er.evidence_text };
  });
  return {
    financebench_id: str(r, 'financebench_id', g),
    question: str(r, 'question', g),
    doc_name: str(r, 'doc_name', g),
    evidence,
  };
}
