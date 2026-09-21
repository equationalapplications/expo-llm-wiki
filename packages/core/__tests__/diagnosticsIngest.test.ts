import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode, expectNoContent, HASH_A, HASH_B } from './helpers/diagnosticsHarness';
import type { OntologyManifest } from '../src/types';

const MANIFEST: OntologyManifest = {
  node_types: [
    { type: 'person', description: 'A person' },
    { type: 'place', description: 'A place' },
  ],
  edge_types: [
    { type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Person lives in place' },
  ],
};

const DOC = 'ALPHA chunk text here.\n\nBROKEN chunk text here.';

afterEach(() => vi.restoreAllMocks());

describe('ingest diagnostics', () => {
  it('aggregates chunk failures per reason, with trigger call and no content', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      config: { maxChunkLength: 30, chunkOverlap: 0 },
      generateText: async ({ userPrompt }) => userPrompt.includes('BROKEN')
        ? 'definitely not json'
        : JSON.stringify({ facts: [{ title: 'Alpha title', body: 'Alpha body', tags: [], confidence: 'certain' }] }),
    });
    const result = await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    expect(result.chunks).toBe(2);
    expect(result.failedChunks).toBe(1);
    expect(ofCode(diagnostics, 'ingest_chunk_failed')).toEqual([
      expect.objectContaining({
        severity: 'warn', operation: 'ingest', trigger: 'call', entityId: 'e1',
        detail: { sourceRef: 'doc.md', reason: 'parse', count: 1, chunkIndexes: [1] },
      }),
    ]);
    expectNoContent(diagnostics, ['Alpha title', 'Alpha body', 'BROKEN', 'definitely not json']);
  });

  it('discards buffered diagnostics when every chunk fails (the throw is the signal)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({ generateText: async () => 'nope' });
    await expect(wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'x y z' })).rejects.toThrow();
    expect(diagnostics).toEqual([]);
  });

  it('reports rejected facts with chunk and item locators', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [
        { title: 'Good', body: 'Good body', tags: [], confidence: 'certain' },
        { title: 5, body: 'bad shape' },
        { title: '   ', body: 'no title' },
      ] }),
    });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    expect(ofCode(diagnostics, 'fact_rejected').map((d) => d.detail)).toEqual([
      { sourceRef: 'doc.md', chunkIndex: 0, itemIndex: 1, reason: 'invalid_shape' },
      { sourceRef: 'doc.md', chunkIndex: 0, itemIndex: 2, reason: 'missing_title' },
    ]);
    expectNoContent(diagnostics, ['bad shape', 'no title', 'Good body']);
  });

  it('reports cross-chunk exact-title duplicates as info', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      config: { maxChunkLength: 30, chunkOverlap: 0 },
      generateText: async () => JSON.stringify({ facts: [{ title: 'Same', body: 'b', tags: [], confidence: 'certain' }] }),
    });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    expect(ofCode(diagnostics, 'fact_deduplicated')).toEqual([
      expect.objectContaining({ severity: 'info', detail: { sourceRef: 'doc.md', chunkIndex: 1, itemIndex: 0, reason: 'exact_title' } }),
    ]);
  });

  it('reports dropped edges with fact id, edge type and manifest slugs, after commit', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [
        { title: 'Ada', body: 'Ada body', tags: [], confidence: 'certain', okf_type: 'person',
          edges: [{ edge_type: 'lives_in', target_title: 'Atlantis' }, { edge_type: 'unknown_edge', target_title: 'Mars' }] },
      ] }),
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    const drops = ofCode(diagnostics, 'edge_dropped');
    expect(drops.map((d) => d.detail?.reason).sort()).toEqual(['target_not_found', 'type_not_in_manifest']);
    for (const d of drops) {
      expect(d.detail?.factId).toMatch(/^fact_/);
      expect(d.detail?.sourceRef).toBe('doc.md');
      expect(d.detail?.sourceNodeType).toBe('person');
      expect(d.trigger).toBe('call');
    }
    expectNoContent(diagnostics, ['Atlantis', 'Mars', 'Ada body']);
  });

  it('emits nothing on a clean ingest', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [{ title: 'Clean', body: 'clean body', tags: [], confidence: 'certain' }] }),
    });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_B, documentChunk: 'content' });
    expect(diagnostics).toEqual([]);
  });
});

describe('upsertGraph diagnostics', () => {
  it('reports manifest_violation edge drops when upsertGraph resolves (host-owned tx)', async () => {
    const { wiki, db, diagnostics } = await makeDiagnosticWiki();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    await db.withTransactionAsync(async (tx) => {
      await wiki.upsertGraph('e1', {
        sourceRef: 'graph.json', sourceHash: HASH_A,
        nodes: [{ id: 'n1', type: 'person', title: 'Ada' }, { id: 'n2', type: 'place', title: 'London' }],
        edges: [{ type: 'unknown_edge', sourceId: 'n1', targetId: 'n2' }],
      }, tx);
    });
    expect(ofCode(diagnostics, 'edge_dropped')).toEqual([
      expect.objectContaining({
        operation: 'upsertGraph', trigger: 'call', entityId: 'e1',
        detail: { reason: 'manifest_violation', factId: 'n1', edgeType: 'unknown_edge', sourceNodeType: 'person', sourceRef: 'graph.json' },
      }),
    ]);
  });
});
