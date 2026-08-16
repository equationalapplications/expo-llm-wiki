import { describe, it, expect } from 'vitest';
import { WikiMemory, WikiIngestEmptyError } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { scriptedLLM } from '../helpers/llm';

// Deterministic 64-char hex per index. `padStart` keeps each output distinct
// (e.g. `1` and `11`) so a future test that reuses one WikiMemory instance
// with two colliding indices cannot hit the duplicate-hash path for an
// unrelated reason.
const sourceHashFor = (n: number) => String(n).padStart(4, '0').repeat(16);

const good = (title: string) =>
  JSON.stringify({ facts: [{ title, body: `${title} body`, tags: [], confidence: 'certain' }] });

// Issue #92's reparable repro: the model emitted one literal `"` inside a
// fact body without escaping it. Both parser tiers handle this:
//  - Tier-1 (strict scanner) tries to count strings naively; the bare
//    quote mis-tracks `inString` and produces a broken slice, so JSON.parse
//    fails.
//  - Tier-2 (container-aware walker, pure.ts) classifies the bare quote
//    as content via its peek-ahead rule and escapes it. The resulting
//    candidate is `{"facts":[{"title":"B0","body":"she said \"hi\"","tags":[],"confidence":"certain"}]}`,
//    which JSON.parse accepts.
//
// We deliberately craft the bare-quote response by hand so the test
// exercises an actual bare-quote case, not a structurally-truncated one
// (those defeat both tiers and are covered by `truncatedPayload` and the
// partial-commit suites below).
const bareQuoteResponse =
  '{"facts":[{"title":"B0","body":"she said "hi"' +
  ' verbatim","tags":[],"confidence":"certain"}]}';

// Structurally-incomplete payload (unclosed array bracket) — defeats both
// parser tiers. The tier-1 scanner can't find a balanced span; the tier-2
// walker never gets the stack empty so it produces no candidate. Used by
// the partial-commit suites below to drive `parseFailures[].source=parse`
// and `tier=strict` assertions. The previous `"a"b"` title fixture is
// also repairable by the walker (bare quotes inside value strings are
// now escaped) and the plan's `"she said "hi" verbatim` body is now the
// repairable bare-quote response above.
const truncatedPayload = '{"facts":[';

describe('ingest parse resilience — integration (issue #92)', () => {
  it('subset: 4 ok + 1 truncated payload → ingestedChunks=4, parseFailures[0].source=parse, tier recorded', async () => {
    // The "bad" canned response here is a structurally-truncated payload
    // (`{"facts":[`) — it defeats both parser tiers and produces a
    // `parseFailures` entry. The reparable bare-quote case is exercised
    // separately by the next test.
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([good('F0'), good('F1'), truncatedPayload, good('F3'), good('F4')]),
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

  it('subset: 4 ok + 1 reparable bare-quote → all 5 facts reach storage, parseFailures empty', async () => {
    // The bare-quote canned response contains a literal `"` inside the
    // body of one fact, exactly the failure mode issue #92 documents. With
    // the tier-2 walker, the parser escapes the bare quote and JSON.parse
    // accepts the candidate; the chunk commits and its fact reaches
    // storage verbatim (no `parseFailures` entry). The other four chunks
    // extract one fact each with `body: "<title> body"`; this one's body
    // must contain the literal `"hi"` substring to prove the repair kept
    // the prose intact.
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([good('F0'), good('F1'), bareQuoteResponse, good('F3'), good('F4')]),
    });
    await wiki.setup();

    const result = await wiki.ingestDocument('e_int_barequote', {
      sourceRef: 'doc-barequote',
      sourceHash: sourceHashFor(2),
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
    expect(result.ingestedChunks).toBe(5);
    expect(result.failedChunks).toBe(0);
    // Repaired by tier 2 — no failure surfaces to the host.
    expect(result.parseFailures).toBeUndefined();

    const bundle = await wiki.getMemoryBundle('e_int_barequote');
    const titles = bundle.facts.map((f) => f.title).sort();
    expect(titles).toEqual(['B0', 'F0', 'F1', 'F3', 'F4']);

    // The repaired fact preserved the literal `"hi"` substring — proves
    // the walker escaped the bare quotes without dropping prose.
    const repaired = bundle.facts.find((f) => f.title === 'B0');
    expect(repaired).toBeDefined();
    expect(repaired!.body).toContain('"hi"');
    expect(repaired!.body).toContain('she said');
    expect(repaired!.body).toContain('verbatim');
  });

  it('subset: all 5 malformed → WikiIngestEmptyError thrown with full parseFailures', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([
        truncatedPayload, truncatedPayload, truncatedPayload, truncatedPayload, truncatedPayload,
      ]),
    });
    await wiki.setup();

    await expect(
      wiki.ingestDocument('e_int_all_fail', {
        sourceRef: 'doc-all-malformed',
        sourceHash: sourceHashFor(3),
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
      good('G0'), good('G1'), truncatedPayload, good('G3'), good('G4'),
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
    const bundlePartial = await wiki.getMemoryBundle('e_int_retry');
    expect(bundlePartial.facts.map((f) => f.title).sort()).toEqual(['G0', 'G1', 'G3', 'G4']);

    // Second ingest: full success on the same sourceRef with a new sourceHash
    // (simulating a corrected chunking run).
    (wiki as any).options.llmProvider = scriptedLLM([
      good('Final0'), good('Final1'), good('Final2'), good('Final3'), good('Final4'),
    ]);
    await wiki.ingestDocument('e_int_retry', {
      sourceRef,
      sourceHash: sourceHashFor(5),
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

  it('subset: same-hash retry after partial commit succeeds in picking up the failed chunks', async () => {
    // Regression: appendPartialFacts stores source_hash as NULL on partial
    // rows. The previous implementation stamped the incoming hash, which
    // made hasChanged return false on a same-hash retry and prevented the
    // failed chunks from ever being re-attempted. With the NULL fix,
    // hasChanged stays true after a partial commit, so a retry of the same
    // content re-runs every chunk and the previously-failed chunk now
    // commits (along with the siblings that were already live).
    const db = openTestDatabase();
    const sourceRef = 'doc-same-hash-retry';
    const wiki = new WikiMemory(db, { llmProvider: scriptedLLM([]) });
    await wiki.setup();
    const sourceHash = sourceHashFor(6);

    // First ingest: partial (chunk 2 fails).
    (wiki as any).options.llmProvider = scriptedLLM([
      good('S0'), good('S1'), truncatedPayload, good('S3'), good('S4'),
    ]);
    const first = await wiki.ingestDocument('e_int_samehash', {
      sourceRef,
      sourceHash,
      documentChunk:
        'Sentence one here long enough.\n\n' +
        'Sentence two here long enough.\n\n' +
        'Sentence three here long enough.\n\n' +
        'Sentence four here long enough.\n\n' +
        'Sentence five here long enough.',
      maxChunkLength: 40,
      chunkOverlap: 0,
    });
    expect(first.ingestedChunks).toBe(4);
    expect(first.failedChunks).toBe(1);

    // After a partial commit, hasChanged must still return true so the host
    // knows the document is not yet "done" and the retry will run.
    await expect(wiki.hasChanged('e_int_samehash', sourceRef, sourceHash)).resolves.toBe(true);

    // Second ingest: same sourceRef + same sourceHash, all chunks now succeed.
    // The failed chunk's fact is committed; the prior live facts are deduped
    // against the partial commit's surviving rows so we end up with one row
    // per title (verified by the assertion that the bundle has exactly five
    // distinct titles).
    (wiki as any).options.llmProvider = scriptedLLM([
      good('S0'), good('S1'), good('S2'), good('S3'), good('S4'),
    ]);
    const second = await wiki.ingestDocument('e_int_samehash', {
      sourceRef,
      sourceHash,
      documentChunk:
        'Sentence one here long enough.\n\n' +
        'Sentence two here long enough.\n\n' +
        'Sentence three here long enough.\n\n' +
        'Sentence four here long enough.\n\n' +
        'Sentence five here long enough.',
      maxChunkLength: 40,
      chunkOverlap: 0,
    });
    expect(second.ingestedChunks).toBe(5);
    expect(second.failedChunks).toBe(0);

    const bundle = await wiki.getMemoryBundle('e_int_samehash');
    const titles = bundle.facts.map((f) => f.title).sort();
    expect(titles).toEqual(['S0', 'S1', 'S2', 'S3', 'S4']);
  });
});
