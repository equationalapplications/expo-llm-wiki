import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode, expectNoContent, HASH_A } from './helpers/diagnosticsHarness';

afterEach(() => vi.restoreAllMocks());

const oneFact = async () => JSON.stringify({ facts: [{ title: 'Embed me', body: 'secret body', tags: [], confidence: 'certain' }] });

describe('embedding diagnostics', () => {
  it('embed() throwing → embedding_failed/embed_threw with the fact id, no provider message', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: oneFact,
      embed: async () => { throw new Error('provider says: secret body'); },
    });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    const failed = ofCode(diagnostics, 'embedding_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ operation: 'ingest', trigger: 'call', entityId: 'e1', detail: { reason: 'embed_threw' } });
    expect(failed[0].detail?.factId).toMatch(/^fact_/);
    expectNoContent(diagnostics, ['secret body', 'provider says']);
  });

  it('invalid vector → invalid_vector', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({ generateText: oneFact, embed: async () => [] });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    expect(ofCode(diagnostics, 'embedding_failed').map((d) => d.detail?.reason)).toEqual(['invalid_vector']);
  });

  it('float32 overflow → float32_overflow', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({ generateText: oneFact, embed: async () => [1e300, 1] });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    expect(ofCode(diagnostics, 'embedding_failed').map((d) => d.detail?.reason)).toEqual(['float32_overflow']);
  });

  it('onEmbeddingPersisted throwing → hook_failed/on_embedding_persisted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: oneFact,
      embed: async () => [0.1, 0.2],
      extra: {
        vectorRanker: {
          rankBySimilarity: async () => [],
          onEmbeddingPersisted: () => { throw new Error('ann down'); },
        } as never,
      },
    });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    expect(ofCode(diagnostics, 'hook_failed')).toEqual([
      expect.objectContaining({ operation: 'ingest', detail: expect.objectContaining({ reason: 'on_embedding_persisted' }) }),
    ]);
  });

  it('importDump reports preserved-blob and soft-deleted hook failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let hookThrows = false;
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: oneFact,
      embed: async () => [0.1, 0.2],
      extra: {
        vectorRanker: {
          rankBySimilarity: async () => [],
          onEmbeddingPersisted: () => { if (hookThrows) throw new Error('ann down'); },
        } as never,
      },
    });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    const bundle = await wiki.__testAccess.importExportService.getFullBundle('e1', { includeBlobs: true });
    const oldId = bundle.facts[0].id;
    expect((bundle.facts[0] as { embedding_blob?: Uint8Array }).embedding_blob).toBeDefined();

    hookThrows = true;
    await wiki.importDump({
      generatedAt: Date.now(),
      entities: { e1: { ...bundle, facts: [{ ...bundle.facts[0], id: 'fact_imported' }] } },
    });

    const hookFailed = ofCode(diagnostics, 'hook_failed');
    expect(hookFailed.map((d) => [d.operation, d.trigger, d.detail?.factId, d.detail?.reason])).toEqual([
      ['importDump', 'call', 'fact_imported', 'on_embedding_persisted'],
      ['importDump', 'call', oldId, 'on_embedding_persisted'],
    ]);
    expectNoContent(diagnostics, ['Embed me', 'secret body', 'ann down']);
  });

  it('runReembed reports operation reembed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = false;
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: oneFact,
      embed: async () => { if (fail) throw new Error('x'); return [0.1, 0.2]; },
    });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    fail = true;
    await wiki.runReembed('e1', { force: true });
    expect(ofCode(diagnostics, 'embedding_failed').map((d) => [d.operation, d.trigger])).toEqual([['reembed', 'call']]);
  });
});
// spec specs/import-followups §1 (#367): the no-vector hook call in importDump is guarded.
describe('importDump: a throwing hook for a fact with no vector', () => {
  const fact = (id: string, entityId: string, extra: Record<string, unknown> = {}) =>
    ({ id, entity_id: entityId, title: `title ${id}`, body: `body ${id}`, tags: [], confidence: 'certain', source_type: 'user_stated', source_hash: null, source_ref: null, created_at: 100, updated_at: 100, last_accessed_at: 100, access_count: 0, deleted_at: null, ...extra }) as never;
  const dump = (entities: Record<string, unknown[]>) => ({
    generatedAt: Date.now(),
    entities: Object.fromEntries(Object.entries(entities).map(([e, facts]) => [e, { facts, tasks: [], events: [], edges: [] }])),
  }) as never;
  const ranker = (hook: (entityId: string, factId: string, v: Float32Array | null) => unknown) =>
    ({ vectorRanker: { rankBySimilarity: async () => [], onEmbeddingPersisted: (e: { entityId: string; factId: string; vector: Float32Array | null }) => hook(e.entityId, e.factId, e.vector) } as never });

  it('reports hook_failed for that fact and imports every entity (fails on main)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      extra: ranker((_e, factId) => { calls.push(factId); if (factId === 'X') throw new Error('ann down'); }),
    });
    await expect(wiki.importDump(dump({ e1: [fact('A', 'e1'), fact('X', 'e1'), fact('B', 'e1')], e2: [fact('C', 'e2')] }))).resolves.toBeUndefined();
    const e1 = await wiki.__testAccess.importExportService.getFullBundle('e1');
    const e2 = await wiki.__testAccess.importExportService.getFullBundle('e2');
    expect(e1.facts.map((f) => f.id).sort()).toEqual(['A', 'B', 'X']);
    expect(e2.facts.map((f) => f.id)).toEqual(['C']);
    expect(calls).toEqual(['A', 'X', 'B', 'C']);
    expect(ofCode(diagnostics, 'hook_failed')).toEqual([
      expect.objectContaining({ operation: 'importDump', trigger: 'call', entityId: 'e1', detail: { factId: 'X', reason: 'on_embedding_persisted' } }),
    ]);
    expectNoContent(diagnostics, ['title X', 'body X', 'ann down']);
  });

  it('a hook that always throws still imports every entity, one hook_failed per fact', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({ extra: ranker(() => { throw new Error('ann down'); }) });
    await wiki.importDump(dump({ e1: [fact('A', 'e1'), fact('B', 'e1')], e2: [fact('C', 'e2')] }));
    expect(ofCode(diagnostics, 'hook_failed').map((d) => [d.entityId, d.detail?.factId])).toEqual([['e1', 'A'], ['e1', 'B'], ['e2', 'C']]);
  });

  it('embed failure plus hook failure for one fact: embedding_failed and hook_failed, import resolves', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      embed: async () => { throw new Error('provider down'); },
      extra: ranker(() => { throw new Error('ann down'); }),
    });
    await expect(wiki.importDump(dump({ e1: [fact('X', 'e1')] }))).resolves.toBeUndefined();
    expect(ofCode(diagnostics, 'embedding_failed').map((d) => [d.detail?.factId, d.detail?.reason])).toEqual([['X', 'embed_threw']]);
    expect(ofCode(diagnostics, 'hook_failed').map((d) => d.detail?.factId)).toEqual(['X']);
  });

  it('a rejected promise behaves like a throw', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({ extra: ranker(async () => { throw new Error('ann down'); }) });
    await expect(wiki.importDump(dump({ e1: [fact('X', 'e1')], e2: [fact('C', 'e2')] }))).resolves.toBeUndefined();
    expect(ofCode(diagnostics, 'hook_failed').map((d) => d.detail?.factId)).toEqual(['X', 'C']);
  });

  it('later steps still run: the preserved-blob hook call and the dimension bookkeeping', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const vectors: Record<string, number[] | null> = {};
    const { wiki, db } = await makeDiagnosticWiki({
      extra: ranker((_e, factId, v) => { vectors[factId] = v ? Array.from(v) : null; if (factId === 'X') throw new Error('ann down'); }),
    });
    const blob = new Uint8Array(new Float32Array([0.5, 0.25]).buffer);
    await wiki.importDump(dump({ e1: [fact('X', 'e1'), fact('P', 'e1', { embedding_blob: blob })] }));
    expect(vectors.P).toEqual([0.5, 0.25]);
    const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM llm_wiki_meta WHERE key = 'embedding_dimension'`);
    expect(row?.value).toBe('2');
  });

  it('a hook that never throws gives no hook_failed', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({ extra: ranker(() => {}) });
    await wiki.importDump(dump({ e1: [fact('A', 'e1')] }));
    expect(ofCode(diagnostics, 'hook_failed')).toEqual([]);
  });
});
