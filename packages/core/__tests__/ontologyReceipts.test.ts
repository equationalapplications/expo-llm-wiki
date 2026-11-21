import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode, expectNoContent, HASH_A, HASH_B } from './helpers/diagnosticsHarness';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { createWiki } from '../src/index';
import type { OntologyManifest, WikiDiagnostic } from '../src/types';

afterEach(() => vi.restoreAllMocks());

const MANIFEST: OntologyManifest = {
  node_types: [
    { type: 'person', description: 'A person' },
    { type: 'place', description: 'A place' },
  ],
  edge_types: [
    { type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Lives in' },
  ],
};

const details = (diagnostics: WikiDiagnostic[], code: WikiDiagnostic['code']) =>
  ofCode(diagnostics, code).map((d) => ({ severity: d.severity, operation: d.operation, entityId: d.entityId, ...d.detail }));

describe('ontology door receipts — ingest model door (upsertGraphCore, Task 4/5)', () => {
  it('emits node_type_folded for a normalize hit and node_type_dropped for a miss, once per fact', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [
        { title: 'Ada', body: 'Ada body', tags: [], confidence: 'certain', okf_type: 'per-son' },
        { title: 'R2', body: 'robot body', tags: [], confidence: 'certain', okf_type: 'robot' },
        { title: 'NoType', body: 'no type body', tags: [], confidence: 'certain' },
      ] }),
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });

    expect(details(diagnostics, 'node_type_folded')).toEqual([
      { severity: 'info', operation: 'ingest', entityId: 'e1', factId: expect.any(String), nodeType: 'person', from: 'per-son', to: 'person', via: 'normalize', sourceRef: 'doc.md' },
    ]);
    expect(details(diagnostics, 'node_type_dropped')).toEqual([
      { severity: 'warn', operation: 'ingest', entityId: 'e1', factId: expect.any(String), nodeType: 'robot', reason: 'not_in_manifest', sourceRef: 'doc.md' },
    ]);
    // Slugs only — no titles/bodies leaked.
    expectNoContent(diagnostics, ['Ada body', 'robot body', 'no type body']);
  });

  it('suppresses door receipts when the mode is off', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [
        { title: 'R2', body: 'robot body', tags: [], confidence: 'certain', okf_type: 'robot' },
      ] }),
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'off' });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    expect(ofCode(diagnostics, 'node_type_dropped')).toEqual([]);
    expect(ofCode(diagnostics, 'node_type_folded')).toEqual([]);
  });
});

describe('person doors (Task 4)', () => {
  it('upsertGraph node miss emits node_type_dropped with operation upsertGraph; fold emits folded', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({});
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    await wiki.upsertGraph('e1', {
      sourceRef: 'api', sourceHash: HASH_A,
      nodes: [
        { id: 'n1', type: 'robot', title: 'Bot', body: 'b' },
        { id: 'n2', type: 'per-son', title: 'Spot', body: 'b2' },
      ],
      edges: [],
    });
    expect(details(diagnostics, 'node_type_dropped')).toEqual([
      { severity: 'warn', operation: 'upsertGraph', entityId: 'e1', factId: 'n1', nodeType: 'robot', reason: 'not_in_manifest', sourceRef: 'api' },
    ]);
    expect(details(diagnostics, 'node_type_folded')).toEqual([
      { severity: 'info', operation: 'upsertGraph', entityId: 'e1', factId: 'n2', nodeType: 'person', from: 'per-son', to: 'person', via: 'normalize', sourceRef: 'api' },
    ]);
  });

  it('strict upsertGraph throws and emits nothing', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({});
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    await expect(wiki.upsertGraph('e1', {
      sourceRef: 'api', sourceHash: HASH_A,
      nodes: [{ id: 'n1', type: 'robot', title: 'Bot', body: 'b' }],
      edges: [],
    })).rejects.toThrow();
    expect(ofCode(diagnostics, 'node_type_dropped')).toEqual([]);
  });

  it('remember emits door receipts in emergent mode and throws under strict', async () => {
    const emergent = await makeDiagnosticWiki({});
    await emergent.wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    await emergent.wiki.remember('e1', { title: 'P', body: 'person body', tags: [], okf_type: 'per-son' } as never);
    expect(details(emergent.diagnostics, 'node_type_folded')).toHaveLength(1);
    const dropped = await makeDiagnosticWiki({});
    await dropped.wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    await dropped.wiki.remember('e1', { title: 'Q', body: 'b', tags: [], okf_type: 'robot' } as never);
    expect(details(dropped.diagnostics, 'node_type_dropped')).toHaveLength(1);

    const strict = await makeDiagnosticWiki({});
    await strict.wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    await expect(strict.wiki.remember('e1', { title: 'R', body: 'b', tags: [], okf_type: 'robot' } as never)).rejects.toThrow();
    expect(ofCode(strict.diagnostics, 'node_type_dropped')).toEqual([]);
  });
});

describe('merge rejection receipts (Task 6)', () => {
  it('emits one receipt per dropped proposal with a machine reason', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({
        facts: [{ title: 'Ada', body: 'b', tags: [], confidence: 'certain', okf_type: 'person' }],
        ontology_updates: {
          node_types: [{ type: 'person', description: 'dup' }, { type: 'meeting', description: 'new' }],
          edge_types: [{ type: 'likes', source_type: 'ghost', target_type: 'person', description: '' }],
        },
      }),
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    expect(details(diagnostics, 'ontology_update_rejected')).toEqual([
      { severity: 'warn', operation: 'ingest', entityId: 'e1', reason: 'duplicate_node_type' },
      { severity: 'warn', operation: 'ingest', entityId: 'e1', reason: 'unknown_endpoint' },
    ]);
    expectNoContent(diagnostics, ['meeting', 'ghost', 'likes']);
  });

  it('strict mode emits one mode_strict receipt per proposal and merges nothing', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({
        facts: [{ title: 'Ada', body: 'b', tags: [], confidence: 'certain', okf_type: 'person' }],
        ontology_updates: {
          node_types: [{ type: 'meeting', description: 'x' }],
          edge_types: [{ type: 'likes', source_type: 'person', target_type: 'person', description: '' }],
        },
      }),
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    expect(details(diagnostics, 'ontology_update_rejected')).toEqual([
      { severity: 'warn', operation: 'ingest', entityId: 'e1', reason: 'mode_strict' },
      { severity: 'warn', operation: 'ingest', entityId: 'e1', reason: 'mode_strict' },
    ]);
    const manifest = await wiki.getOntologyManifest('e1');
    expect(manifest?.manifest.node_types).toHaveLength(2); // unchanged
  });
});

describe('ingest_zero_facts receipt (Task 7)', () => {
  it('fires when a re-ingest tombstones prior facts and writes zero', async () => {
    const { wiki, diagnostics, generateText } = await makeDiagnosticWiki({});
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    generateText.mockResolvedValueOnce(JSON.stringify({
      facts: [{ title: 'Ada', body: 'b', tags: [], confidence: 'certain', okf_type: 'person' }],
    }));
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    generateText.mockResolvedValueOnce(JSON.stringify({ facts: [] }));
    const result = await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_B, documentChunk: 'content 2' });
    expect(result.ingestedChunks).toBe(1);
    expect(details(diagnostics, 'ingest_zero_facts')).toEqual([
      { severity: 'warn', operation: 'ingest', entityId: 'e1', sourceRef: 'doc.md', chunks: 1 },
    ]);
  });

  it('does not fire on a first ingest with zero facts (nothing tombstoned)', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [] }),
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    expect(ofCode(diagnostics, 'ingest_zero_facts')).toEqual([]);
  });
});

describe('backfill door receipts (Task 13 — this PR carries the dropped/folded doors)', () => {
  it('emits node_type_dropped and node_type_folded with operation ontologyBackfill', async () => {
    const db = openTestDatabase();
    const diagnostics: WikiDiagnostic[] = [];
    const generateText = vi.fn(async () => JSON.stringify({ classifications: [] }));
    const wiki = createWiki(db, { llmProvider: { generateText }, onDiagnostic: (d: WikiDiagnostic) => diagnostics.push(d) } as never);
    await wiki.setup();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    const fa = await wiki.remember('e1', { title: 't1', body: 'b1', tags: [] } as never);
    const fb = await wiki.remember('e1', { title: 't2', body: 'b2', tags: [] } as never);
    const fc = await wiki.remember('e1', { title: 't3', body: 'b3', tags: [] } as never);
    generateText.mockResolvedValueOnce(JSON.stringify({
      classifications: [
        { id: fa.id, okf_type: 'robot' },
        { id: fb.id, okf_type: 'per-son' },
        { id: fc.id, okf_type: 'place' },
      ],
    }));
    const result = await wiki.runOntologyBackfill('e1');
    expect(result.typed).toBe(2);
    expect(result.failedValidation).toBe(1);
    expect(details(diagnostics, 'node_type_dropped')).toEqual([
      { severity: 'warn', operation: 'ontologyBackfill', entityId: 'e1', factId: fa.id, nodeType: 'robot', reason: 'not_in_manifest' },
    ]);
    expect(details(diagnostics, 'node_type_folded')).toEqual([
      { severity: 'info', operation: 'ontologyBackfill', entityId: 'e1', factId: fb.id, nodeType: 'person', from: 'per-son', to: 'person', via: 'normalize' },
    ]);
  });
});

describe('partial ingest typing (Task 8)', () => {
  it('partial rows get manifest types, door receipts, and resolved intra-response edges', async () => {
    const { wiki, db, diagnostics, generateText } = await makeDiagnosticWiki({
      config: { maxChunkLength: 30, chunkOverlap: 0 },
      generateText: async ({ userPrompt }) => userPrompt.includes('BROKEN')
        ? 'definitely not json'
        : JSON.stringify({ facts: [
          { title: 'Ada', body: 'Ada body', tags: [], confidence: 'certain', okf_type: 'per-son',
            edges: [{ edge_type: 'lives_in', target_title: 'Lyons' }] },
          { title: 'Lyons', body: 'Lyons body', tags: [], confidence: 'certain', okf_type: 'PLACE' },
        ] }),
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    const result = await wiki.ingestDocument('e1', {
      sourceRef: 'doc.md', sourceHash: HASH_A,
      documentChunk: 'GOOD chunk here.\n\nBROKEN chunk here.',
    });
    expect(result.failedChunks).toBe(1);
    expect(result.ingestedChunks).toBe(1);
    const rows = await db.getAllAsync<{ okf_type: string | null }>("SELECT okf_type FROM llm_wiki_entries WHERE entity_id='e1' AND deleted_at IS NULL");
    const types = rows.map((r) => r.okf_type).sort();
    expect(types).toEqual(['person', 'place']);
    const edges = await db.getFirstAsync<{ c: number }>("SELECT COUNT(*) AS c FROM llm_wiki_edges WHERE entity_id='e1'");
    expect(edges?.c).toBe(1);
    const folds = details(diagnostics, 'node_type_folded');
    // 'PLACE' hits the manifest exactly (case-insensitive); only 'per-son' folds.
    expect(folds).toHaveLength(1);
    expect((folds[0] as { from: string }).from).toBe('per-son');
    expect(ofCode(diagnostics, 'node_type_dropped')).toEqual([]);
    expectNoContent(diagnostics, ['Ada body', 'Lyons body']);
  });
});
