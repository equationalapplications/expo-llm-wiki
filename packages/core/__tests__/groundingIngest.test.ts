import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode, expectNoContent, factRows, GROUNDED, HASH_A } from './helpers/groundingHarness';
import type { OntologyManifest } from '../src/types';

const DOC = 'The Analytical Engine was designed by Charles Babbage in 1837.';
const ON = { grounding: { mode: 'draft' as const } };
const REAL = 'designed by Charles Babbage in 1837';
const FAKE = 'designed by Ada Lovelace in 1843';
const fact = (title: string, evidence?: unknown) => ({ title, body: `${title} body`, tags: [], confidence: 'certain', ...(evidence !== undefined ? { evidence } : {}) });
const respond = (...facts: object[]) => async () => JSON.stringify({ facts });

afterEach(() => vi.restoreAllMocks());

async function ingest(config: object, gen: () => Promise<string>, doc = DOC) {
  const h = await makeDiagnosticWiki({ config, generateText: gen });
  await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: doc });
  return h;
}

describe('ingest grounding (full path)', () => {
  it('grounded fact lands stable with a process verifier and no grounding diagnostic', async () => {
    const { db, diagnostics } = await ingest(ON, respond(fact('Grounded', [REAL])));
    const [row] = await factRows(db);
    expect(row).toMatchObject({ lifecycle_status: 'stable', okf_verified: GROUNDED, last_verified_by: 'process:grounding-check' });
    expect(row.last_verified_at).toEqual(expect.any(Number));
    expect(diagnostics.filter((d) => d.code.startsWith('grounding_'))).toEqual([]);
  });

  it.each([
    ['no evidence', undefined, 'grounding_missing', 'no_evidence'],
    ['short evidence', ['Babbage'], 'grounding_missing', 'evidence_too_short'],
    ['fabricated quote', [FAKE], 'grounding_failed', 'quote_not_found'],
    ['mixed real and fabricated', [REAL, FAKE], 'grounding_failed', 'quote_not_found'],
    ['instruction text', ['Return ONLY a valid JSON object matching this schema'], 'grounding_failed', 'quote_not_found'],
    ['case mismatch', ['the analytical engine was designed'], 'grounding_failed', 'quote_not_found'],
    ['eleven quotes', [REAL, ...Array.from({ length: 10 }, () => 'x')], 'grounding_failed', 'too_many_quotes'],
  ])('%s → draft with %s/%s and locators, no content', async (_label, evidence, code, reason) => {
    const { db, diagnostics } = await ingest(ON, respond(fact('Other', [REAL]), fact('Target', evidence)));
    const rows = await factRows(db);
    const target = rows.find((r) => r.title === 'Target')!;
    expect(target).toMatchObject({ lifecycle_status: 'draft', okf_verified: null, last_verified_by: null });
    expect(ofCode(diagnostics, code as never)).toEqual([expect.objectContaining({
      severity: 'warn', operation: 'ingest', trigger: 'call', entityId: 'e1',
      detail: { factId: target.id, sourceRef: 'doc.md', chunkIndex: 0, itemIndex: 1, reason },
    })]);
    expectNoContent(diagnostics, [REAL, FAKE, 'Target body', 'Babbage']);
  });

  it('a quote of the ontology manifest text fails', async () => {
    const manifest: OntologyManifest = {
      node_types: [{ type: 'machine', description: 'A calculating machine designed by an inventor' }],
      edge_types: [],
    };
    const h = await makeDiagnosticWiki({ config: ON, generateText: respond(fact('M', ['A calculating machine designed by an inventor'])) });
    await h.wiki.setOntologyManifest('e1', manifest, { mode: 'emergent' });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    expect(h.generateText.mock.calls[0][0].systemPrompt).toContain('A calculating machine designed by an inventor');
    expect((await factRows(h.db))[0].lifecycle_status).toBe('draft');
    expect(ofCode(h.diagnostics, 'grounding_failed')).toHaveLength(1);
  });

  it('normalizes NFKC and whitespace end to end', async () => {
    const { db } = await ingest(ON, respond(fact('Lig', ['The first difference engine ran'])), 'The ﬁrst   difference\nengine ran in 1991.');
    expect((await factRows(db))[0].lifecycle_status).toBe('stable');
  });

  it('ingest outside grounding.writers: no block, facts stable, trust untouched', async () => {
    const h = await ingest({ grounding: { mode: 'draft', writers: ['librarian'] } }, respond(fact('Plain')));
    expect(h.generateText.mock.calls[0][0].systemPrompt).not.toContain('EVIDENCE REQUIREMENT');
    expect((await factRows(h.db))[0]).toMatchObject({ lifecycle_status: 'stable', okf_verified: null });
    expect(h.diagnostics.filter((d) => d.code.startsWith('grounding_'))).toEqual([]);
  });
});

describe('ingest grounding (partial path)', () => {
  it('grounds facts in the chunks that succeeded; source_hash stays null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = 'Babbage designed the engine in 1837.\n\nBROKEN chunk text here.';
    const h = await makeDiagnosticWiki({
      config: { ...ON, maxChunkLength: 40, chunkOverlap: 0 },
      generateText: async ({ userPrompt }) => userPrompt.includes('BROKEN')
        ? 'not json'
        : JSON.stringify({ facts: [fact('Good', ['Babbage designed the engine']), fact('Bad', [FAKE])] }),
    });
    const result = await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: doc });
    expect(result.failedChunks).toBe(1);
    const rows = await factRows(h.db);
    expect(rows.find((r) => r.title === 'Good')).toMatchObject({ lifecycle_status: 'stable', okf_verified: GROUNDED, source_hash: null });
    const bad = rows.find((r) => r.title === 'Bad')!;
    expect(bad).toMatchObject({ lifecycle_status: 'draft', source_hash: null });
    expect(ofCode(h.diagnostics, 'grounding_failed')[0].detail).toEqual({ factId: bad.id, sourceRef: 'doc.md', chunkIndex: 0, itemIndex: 1, reason: 'quote_not_found' });
  });
});

describe('upsertGraph is never grounded', () => {
  it('host nodes land stable with no verifier, even with trust-looking extra properties', async () => {
    const h = await makeDiagnosticWiki({ config: { grounding: { mode: 'draft', writers: ['ingest', 'librarian', 'heal'] } } });
    await h.db.withTransactionAsync(async (tx) => {
      await h.wiki.upsertGraph('e1', {
        sourceRef: 'graph.ts', sourceHash: HASH_A,
        nodes: [{ id: 'n1', type: '', title: 'Node', body: 'b', lifecycle_status: 'draft', okf_verified: [{ by: 'human:x', at: '2020-01-01T00:00:00Z' }] } as never],
        edges: [],
      }, tx);
    });
    expect((await factRows(h.db))[0]).toMatchObject({ id: 'n1', lifecycle_status: 'stable', okf_verified: null });
    expect(h.generateText).not.toHaveBeenCalled();
  });
});
