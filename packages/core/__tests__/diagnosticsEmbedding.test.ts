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