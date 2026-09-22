import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode, factRows, GROUNDED, HASH_A, HASH_B } from './helpers/groundingHarness';
import type { SQLiteAdapter } from '../src/types';

// Two paragraphs → two chunks at maxChunkLength 40 (one per paragraph).
const A_TEXT = 'Alpha paragraph has no engine facts.';
const B_TEXT = 'Babbage designed the engine in 1837.';
const DOC = `${A_TEXT}\n\n${B_TEXT}`;
const QUOTE_A = 'Alpha paragraph has no engine';
const QUOTE_B = 'Babbage designed the engine';
const FAKE = 'Lovelace designed the engine in 1843';

const ON = { grounding: { mode: 'draft' as const }, maxChunkLength: 40, chunkOverlap: 0 };
const OFF = { maxChunkLength: 40, chunkOverlap: 0 };

type F = { title: string; body: string; tags: string[]; confidence: string; evidence?: string[]; okf_type?: string; edges?: object[] };
const fact = (title: string, body: string, evidence?: string[], extra: Partial<F> = {}): F =>
  ({ title, body, tags: [], confidence: 'certain', ...(evidence ? { evidence } : {}), ...extra });

/** Stub LLM: routes each chunk by its text. `BROKEN` chunks return unparseable output. */
function perChunk(byChunk: { a?: object; b?: object }) {
  return async ({ userPrompt }: { userPrompt: string }) => {
    if (userPrompt.includes('BROKEN')) return 'not json';
    if (userPrompt.includes(B_TEXT)) return JSON.stringify(byChunk.b ?? { facts: [] });
    if (userPrompt.includes(A_TEXT)) return JSON.stringify(byChunk.a ?? { facts: [] });
    return JSON.stringify({ facts: [] });
  };
}

async function bodyOf(db: SQLiteAdapter, title: string): Promise<string> {
  const row = await db.getFirstAsync<{ body: string }>(
    `SELECT body FROM llm_wiki_entries WHERE entity_id = 'e1' AND title = ? AND deleted_at IS NULL`, [title]);
  return row!.body;
}

const dedup = (chunkIndex: number, itemIndex: number) =>
  ({ sourceRef: 'doc.md', chunkIndex, itemIndex, reason: 'exact_title' });

afterEach(() => vi.restoreAllMocks());

describe('ingest title dedup prefers a grounded duplicate (spec REQ-DEDUP-01)', () => {
  it('scenario 1: ungrounded first, grounded second → the grounded one is stored stable', async () => {
    const h = await makeDiagnosticWiki({ config: ON, generateText: perChunk({
      a: { facts: [fact('X', 'from A')] },
      b: { facts: [fact('X', 'from B', [QUOTE_B])] },
    }) });
    const res = await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    expect(res.chunks).toBe(2);
    const rows = await factRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'X', lifecycle_status: 'stable', okf_verified: GROUNDED });
    expect(await bodyOf(h.db, 'X')).toBe('from B');
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(0, 0)]);
    expect(h.diagnostics.filter((d) => d.code.startsWith('grounding_'))).toEqual([]);
  });

  it('scenario 2: grounded first, ungrounded second → first kept', async () => {
    const h = await makeDiagnosticWiki({ config: ON, generateText: perChunk({
      a: { facts: [fact('X', 'from A', [QUOTE_A])] },
      b: { facts: [fact('X', 'from B')] },
    }) });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    expect((await factRows(h.db))[0]).toMatchObject({ lifecycle_status: 'stable', okf_verified: GROUNDED });
    expect(await bodyOf(h.db, 'X')).toBe('from A');
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(1, 0)]);
    expect(ofCode(h.diagnostics, 'grounding_missing')).toEqual([]);
  });

  it('scenario 3: missing first, failed second (a tie) → first kept as draft', async () => {
    const h = await makeDiagnosticWiki({ config: ON, generateText: perChunk({
      a: { facts: [fact('X', 'from A')] },
      b: { facts: [fact('X', 'from B', [FAKE])] },
    }) });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    const [row] = await factRows(h.db);
    expect(row).toMatchObject({ lifecycle_status: 'draft', okf_verified: null });
    expect(await bodyOf(h.db, 'X')).toBe('from A');
    expect(ofCode(h.diagnostics, 'grounding_missing').map((d) => d.detail)).toEqual([
      { factId: row.id, sourceRef: 'doc.md', chunkIndex: 0, itemIndex: 0, reason: 'no_evidence' },
    ]);
    expect(ofCode(h.diagnostics, 'grounding_failed')).toEqual([]);
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(1, 0)]);
  });

  it('scenario 4: two grounded duplicates → first kept', async () => {
    const h = await makeDiagnosticWiki({ config: ON, generateText: perChunk({
      a: { facts: [fact('X', 'from A', [QUOTE_A])] },
      b: { facts: [fact('X', 'from B', [QUOTE_B])] },
    }) });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    expect(await bodyOf(h.db, 'X')).toBe('from A');
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(1, 0)]);
  });

  it('scenario 5: same-chunk duplicates → the grounded later item wins; the loser keeps its own indexes', async () => {
    const h = await makeDiagnosticWiki({ config: ON, generateText: perChunk({
      b: { facts: [fact('X', 'first'), fact('Y', 'y', [QUOTE_B]), fact('X', 'second', [QUOTE_B])] },
    }) });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: B_TEXT });
    const rows = await factRows(h.db);
    expect(rows.map((r) => r.title)).toEqual(['X', 'Y']);
    expect(rows[0]).toMatchObject({ lifecycle_status: 'stable', okf_verified: GROUNDED });
    expect(await bodyOf(h.db, 'X')).toBe('second');
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(0, 0)]);
  });

  it('scenario 6: emergent — a winner from a later chunk keeps the type its own chunk introduced', async () => {
    const h = await makeDiagnosticWiki({ config: ON, generateText: perChunk({
      a: { facts: [fact('X', 'from A', undefined, { okf_type: 'machine' })] },
      b: {
        ontology_updates: {
          node_types: [{ type: 'machine', description: 'A machine' }],
          edge_types: [{ type: 'designed_by', source_type: 'machine', target_type: 'person', description: 'Designed by' }],
        },
        facts: [
          fact('Babbage', 'person', [QUOTE_B], { okf_type: 'person' }),
          fact('X', 'from B', [QUOTE_B], { okf_type: 'machine', edges: [{ edge_type: 'designed_by', target_title: 'Babbage' }] }),
        ],
      },
    }) });
    await h.wiki.setOntologyManifest('e1', {
      node_types: [{ type: 'person', description: 'A person' }],
      edge_types: [],
    }, { mode: 'emergent' });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });

    const x = await h.db.getFirstAsync<{ id: string; okf_type: string | null; body: string }>(
      `SELECT id, okf_type, body FROM llm_wiki_entries WHERE entity_id = 'e1' AND title = 'X' AND deleted_at IS NULL`);
    expect(x).toMatchObject({ okf_type: 'machine', body: 'from B' });
    const edges = await h.db.getAllAsync<{ edge_type: string }>(
      `SELECT edge_type FROM llm_wiki_edges WHERE entity_id = 'e1' AND source_id = ?`, [x!.id]);
    expect(edges).toEqual([{ edge_type: 'designed_by' }]);
  });

  it('scenario 7: grounding off → the first duplicate wins even when a later one carries evidence', async () => {
    const h = await makeDiagnosticWiki({ config: OFF, generateText: perChunk({
      a: { facts: [fact('X', 'from A')] },
      b: { facts: [fact('X', 'from B', [QUOTE_B])] },
    }) });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    expect((await factRows(h.db))[0]).toMatchObject({ lifecycle_status: 'stable', okf_verified: null });
    expect(await bodyOf(h.db, 'X')).toBe('from A');
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(1, 0)]);
  });
});

describe('ingest title dedup, partial path', () => {
  it('scenario 8a: a third chunk fails → the same grounded winner is chosen', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await makeDiagnosticWiki({ config: ON, generateText: perChunk({
      a: { facts: [fact('X', 'from A')] },
      b: { facts: [fact('X', 'from B', [QUOTE_B])] },
    }) });
    const res = await h.wiki.ingestDocument('e1', {
      sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: `${DOC}\n\nBROKEN chunk text here.`,
    });
    expect(res.failedChunks).toBe(1);
    const [row] = await factRows(h.db);
    expect(row).toMatchObject({ title: 'X', lifecycle_status: 'stable', okf_verified: GROUNDED, source_hash: null });
    expect(await bodyOf(h.db, 'X')).toBe('from B');
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(0, 0)]);
  });

  it('scenario 8b: a fact already stored for the sourceRef still beats a new grounded one (out of scope, unchanged)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let phase: 1 | 2 = 1;
    const h = await makeDiagnosticWiki({ config: ON, generateText: async ({ userPrompt }) => {
      if (userPrompt.includes('BROKEN')) return 'not json';
      if (phase === 1) return JSON.stringify({ facts: [fact('X', 'stored draft')] });
      return JSON.stringify({ facts: [fact('X', 'new grounded', [QUOTE_B])] });
    } });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: B_TEXT });
    phase = 2;
    h.diagnostics.length = 0;
    await h.wiki.ingestDocument('e1', {
      sourceRef: 'doc.md', sourceHash: HASH_B, documentChunk: `${B_TEXT}\n\nBROKEN chunk text here.`,
    });
    const rows = await factRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lifecycle_status: 'draft' });
    expect(await bodyOf(h.db, 'X')).toBe('stored draft');
    // #220: the partial-path dedup names a position in the LLM response, the
    // same as the cross-chunk dedup. 'X' came from chunk 0, item 0.
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(0, 0)]);
  });

  it('#220: the partial-path dedup carries locators with grounding OFF too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let phase: 1 | 2 = 1;
    // Chunk 0 yields a rejected item then 'X', so 'X' sits at itemIndex 1 —
    // an itemIndex that differs from its position among the kept facts, which
    // is what pins that the locator comes from the LLM response and not from
    // the enumeration of survivors.
    const h = await makeDiagnosticWiki({ config: OFF, generateText: async ({ userPrompt }) => {
      if (userPrompt.includes('BROKEN')) return 'not json';
      if (phase === 1) return JSON.stringify({ facts: [fact('X', 'stored first')] });
      return JSON.stringify({ facts: [{ nope: 1 }, fact('X', 'new draft')] });
    } });
    await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: B_TEXT });
    phase = 2;
    h.diagnostics.length = 0;
    await h.wiki.ingestDocument('e1', {
      sourceRef: 'doc.md', sourceHash: HASH_B, documentChunk: `${B_TEXT}\n\nBROKEN chunk text here.`,
    });
    // The stored fact still wins (scenario 8b's rule, out of scope for #220).
    expect(await bodyOf(h.db, 'X')).toBe('stored first');
    expect(ofCode(h.diagnostics, 'fact_deduplicated').map((d) => d.detail)).toEqual([dedup(0, 1)]);
    // Grounding is off, so no grounding diagnostics ride along with the locators.
    expect(h.diagnostics.filter((d) => d.code.startsWith('grounding_'))).toEqual([]);
  });
});
