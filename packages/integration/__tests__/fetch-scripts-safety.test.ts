import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileAtomic, readCached, assertHttps } from '../scripts/fsSafe';
import { toCorpusDoc, toQrelRow, toQueryRow, toFinanceBenchRow } from '../scripts/datasetGuards';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('fixture fsSafe', () => {
  it('writes atomically with mode 0600, reads back, enforces https', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixture-fssafe-'));
    dirs.push(dir);
    const file = join(dir, 'out.json');
    expect(readCached(file)).toBeNull();
    writeFileAtomic(file, 'x');
    expect(readCached(file)).toBe('x');
    // Windows does not implement POSIX permission bits; check the exact mode only elsewhere.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['out.json']);
    expect(() => assertHttps('http://datasets-server.huggingface.co/rows')).toThrow(/Refusing non-HTTPS URL/);
  });
});

describe('datasetGuards', () => {
  it('toCorpusDoc keeps known fields only and stringifies numeric ids', () => {
    expect(toCorpusDoc({ _id: 4983, title: 't', text: 'x', extra: 1 })).toEqual({ _id: '4983', title: 't', text: 'x' });
    expect(() => toCorpusDoc({ _id: '1', title: 't' })).toThrow('toCorpusDoc: text');
  });

  it('toQrelRow maps the dashed keys and requires a numeric score', () => {
    expect(toQrelRow({ 'query-id': 1, 'corpus-id': '31715818', score: 1 })).toEqual({
      queryId: '1', corpusId: '31715818', score: 1,
    });
    expect(() => toQrelRow({ 'query-id': '1', 'corpus-id': '2', score: '1' })).toThrow('toQrelRow: score');
  });

  it('toQueryRow validates id and text', () => {
    expect(toQueryRow({ _id: '0', text: 'q' })).toEqual({ _id: '0', text: 'q' });
    expect(() => toQueryRow({ _id: {}, text: 'q' })).toThrow('toQueryRow: _id');
  });

  it('toFinanceBenchRow keeps only the fields the script uses', () => {
    const row = toFinanceBenchRow({
      financebench_id: 'financebench_id_03029', question: 'q', doc_name: '3M_2018_10K', answer: 'a',
      evidence: [{ evidence_text: 'e', page_number: 4, evidence_file_name: 'f' }],
    });
    expect(row).toEqual({
      financebench_id: 'financebench_id_03029', question: 'q', doc_name: '3M_2018_10K',
      evidence: [{ evidence_text: 'e' }],
    });
    expect(() => toFinanceBenchRow({ financebench_id: 'x', question: 'q', doc_name: 'd', evidence: [{}] })).toThrow(
      'toFinanceBenchRow: evidence',
    );
  });
});
