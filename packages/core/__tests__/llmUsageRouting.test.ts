import { describe, it, expect } from 'vitest';
import { makeDiagnosticWiki, ofCode } from './helpers/diagnosticsHarness';

describe('every LLM text call is metered through callLlm', () => {
  it('ingest emits llm_usage when enabled', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [{ title: 'Fact one title here', body: 'b', tags: [], confidence: 'certain' }] }),
      config: { reportLlmUsage: true },
    });
    await wiki.ingestDocument('e1', { sourceRef: 'doc-1', sourceHash: 'a'.repeat(64), documentChunk: 'Some document content that is long enough.' });
    expect(ofCode(diagnostics, 'llm_usage').map((d) => d.operation)).toContain('ingest');
  });

  it('librarian and heal emit llm_usage when enabled', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async ({ systemPrompt }) => systemPrompt.includes('grooming')
        ? JSON.stringify({ downgraded: [], deleted: [], newFacts: [] })
        : JSON.stringify({ facts: [{ title: 'User likes tea a lot', body: 'b', tags: [], confidence: 'certain' }], tasks: [] }),
      config: { reportLlmUsage: true },
    });
    await wiki.write('e1', { event_type: 'observation', summary: 'User said they like tea' });
    await wiki.runLibrarian('e1');
    await wiki.runHeal('e1');
    const ops = ofCode(diagnostics, 'llm_usage').map((d) => d.operation);
    expect(ops).toContain('librarian');
    expect(ops).toContain('heal');
  });

  it('nothing is emitted by default', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [], tasks: [] }),
    });
    await wiki.write('e1', { event_type: 'observation', summary: 's' });
    await wiki.runLibrarian('e1');
    expect(ofCode(diagnostics, 'llm_usage')).toEqual([]);
  });
});