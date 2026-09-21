import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, HASH_A } from './helpers/diagnosticsHarness';

afterEach(() => vi.restoreAllMocks());

const DOC = 'ALPHA chunk text here.\n\nBROKEN chunk text here.';

async function runScenario(withHook: boolean): Promise<string[]> {
  const lines: string[] = [];
  const record = (...args: unknown[]) => { lines.push(args.map((a) => (a instanceof Error ? `Error:${a.message}` : String(a))).join(' ')); };
  vi.spyOn(console, 'warn').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  const { wiki } = await makeDiagnosticWiki({
    withHook,
    config: { maxChunkLength: 30, chunkOverlap: 0 },
    embed: async () => { throw new Error('embed down'); },
    generateText: async ({ userPrompt }) => userPrompt.includes('BROKEN')
      ? 'not json'
      : JSON.stringify({ facts: [{ title: 'T', body: 'B', tags: [], confidence: 'certain' }, { title: 5, body: 'x' }] }),
  });
  await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
  vi.restoreAllMocks();
  // Fact ids are random; normalize them so the two runs are comparable.
  return lines.map((l) => l.replace(/fact_[A-Za-z0-9_-]+/g, 'fact_X'));
}

describe('REQ-COMPAT-01.4', () => {
  it('console output is identical with and without onDiagnostic', async () => {
    const withoutHook = await runScenario(false);
    const withHook = await runScenario(true);
    expect(withoutHook.length).toBeGreaterThan(0);
    expect(withHook).toEqual(withoutHook);
  });
});
