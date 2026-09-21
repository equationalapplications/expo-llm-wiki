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