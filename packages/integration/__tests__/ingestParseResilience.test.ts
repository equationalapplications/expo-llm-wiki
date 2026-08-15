import { describe, it, expect } from 'vitest';
import { WikiMemory, WikiIngestEmptyError } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { scriptedLLM } from '../helpers/llm';

const sourceHashFor = (n: number) => String(n % 10).repeat(64).slice(0, 64);

const good = (title: string) =>
  JSON.stringify({ facts: [{ title, body: `${title} body`, tags: [], confidence: 'certain' }] });

// Issue #92 repro shape — bare-quote-title that BYPASSES tier-1 (the brace-
// matching scanner finds a balanced span) AND defeats tier-2 (the container-
// aware walker). The plan's originally-suggested `"she said "hi" verbatim"`
// body is now repaired by tier-2, so we use a structurally-broken title
// (`"a"b"`) that leaves an unescaped quote inside a key position. Both
// parser tiers reject this; see core/__tests__/ingest.test.ts `makeBadJson`
// for the same input used by the partial-commit suites.
const bareQuoteResponse =
  '{"facts":[{"title":"a"b","body":"c","tags":[],"confidence":"certain"}]}';

describe('ingest parse resilience — integration (issue #92)', () => {
  it('subset: 4 ok + 1 bare-quote → ingestedChunks=4, parseFailures[0].source=parse, tier recorded', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([good('F0'), good('F1'), bareQuoteResponse, good('F3'), good('F4')]),
    });
    await wiki.setup();

    const result = await wiki.ingestDocument('e_int_repro', {
      sourceRef: 'doc-issue-92',
      sourceHash: sourceHashFor(1),
      documentChunk:
        'Sentence one here long enough.\n\n' +
        'Sentence two here long enough.\n\n' +
        'Sentence three here long enough.\n\n' +
        'Sentence four here long enough.\n\n' +
        'Sentence five here long enough.',
      maxChunkLength: 40,
      chunkOverlap: 0,
    });

    expect(result.chunks).toBe(5);
    expect(result.ingestedChunks).toBe(4);
    expect(result.failedChunks).toBe(1);
    expect(result.parseFailures).toBeDefined();
    expect(result.parseFailures!.length).toBe(1);
    expect(result.parseFailures![0].source).toBe('parse');
    expect(['strict', 'repair', 'all']).toContain(result.parseFailures![0].tier);

    // The four sibling facts reach storage.
    const bundle = await wiki.getMemoryBundle('e_int_repro');
    const titles = bundle.facts.map((f) => f.title).sort();
    expect(titles).toEqual(['F0', 'F1', 'F3', 'F4']);
  });

  it('subset: all 5 malformed → WikiIngestEmptyError thrown with full parseFailures', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([
        bareQuoteResponse, bareQuoteResponse, bareQuoteResponse, bareQuoteResponse, bareQuoteResponse,
      ]),
    });
    await wiki.setup();

    await expect(
      wiki.ingestDocument('e_int_all_fail', {
        sourceRef: 'doc-all-malformed',
        sourceHash: sourceHashFor(2),
        documentChunk:
          'Sentence one here long enough.\n\n' +
          'Sentence two here long enough.\n\n' +
          'Sentence three here long enough.\n\n' +
          'Sentence four here long enough.\n\n' +
          'Sentence five here long enough.',
        maxChunkLength: 40,
        chunkOverlap: 0,
      }),
    ).rejects.toMatchObject({
      name: 'WikiIngestEmptyError',
      sourceRef: 'doc-all-malformed',
    });

    const bundle = await wiki.getMemoryBundle('e_int_all_fail');
    expect(bundle.facts.length).toBe(0);
  });

  it('subset: partial → retry-full yields single clean final state (no duplicates)', async () => {
    const db = openTestDatabase();
    const sourceRef = 'doc-retry-clean';
    const wiki = new WikiMemory(db, { llmProvider: scriptedLLM([]) });
    await wiki.setup();

    // First ingest: partial (one bad response on chunk 2).
    (wiki as any).options.llmProvider = scriptedLLM([
      good('G0'), good('G1'), bareQuoteResponse, good('G3'), good('G4'),
    ]);
    await wiki.ingestDocument('e_int_retry', {
      sourceRef,
      sourceHash: sourceHashFor(3),
      documentChunk:
        'Sentence one here long enough.\n\n' +
        'Sentence two here long enough.\n\n' +
        'Sentence three here long enough.\n\n' +
        'Sentence four here long enough.\n\n' +
        'Sentence five here long enough.',
      maxChunkLength: 40,
      chunkOverlap: 0,
    });
    const bundlePartial = await wiki.getMemoryBundle('e_int_retry');
    expect(bundlePartial.facts.map((f) => f.title).sort()).toEqual(['G0', 'G1', 'G3', 'G4']);

    // Second ingest: full success on the same sourceRef with a new sourceHash
    // (simulating a corrected chunking run).
    (wiki as any).options.llmProvider = scriptedLLM([
      good('Final0'), good('Final1'), good('Final2'), good('Final3'), good('Final4'),
    ]);
    await wiki.ingestDocument('e_int_retry', {
      sourceRef,
      sourceHash: sourceHashFor(4),
      documentChunk:
        'Sentence one here long enough.\n\n' +
        'Sentence two here long enough.\n\n' +
        'Sentence three here long enough.\n\n' +
        'Sentence four here long enough.\n\n' +
        'Sentence five here long enough.',
      maxChunkLength: 40,
      chunkOverlap: 0,
    });

    const bundleFinal = await wiki.getMemoryBundle('e_int_retry');
    // Final set is just the five Final* facts; prior partial attempt's G0/G1/G3/G4 are superseded.
    expect(bundleFinal.facts.map((f) => f.title).sort()).toEqual([
      'Final0', 'Final1', 'Final2', 'Final3', 'Final4',
    ]);
  });
});
