import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, HASH_A, HASH_B } from './helpers/diagnosticsHarness';

const HASH_C = 'c'.repeat(64);
afterEach(() => vi.restoreAllMocks());

const ok = async () => JSON.stringify({ facts: [{ title: 'Fact', body: 'body', tags: [], confidence: 'certain' }] });
const halfBroken = async ({ userPrompt }: { userPrompt: string }) =>
  userPrompt.includes('BROKEN') ? 'not json' : JSON.stringify({ facts: [{ title: 'Half', body: 'half body', tags: [], confidence: 'certain' }] });
const TWO_CHUNKS = 'First chunk of the doc.\n\nBROKEN chunk text here.';

async function setup() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let gen: (p: { userPrompt: string }) => Promise<string> = ok;
  const h = await makeDiagnosticWiki({ config: { maxChunkLength: 30, chunkOverlap: 0 }, generateText: (p) => gen(p) });
  await h.wiki.ingestDocument('e1', { sourceRef: 'full.md', sourceHash: HASH_A, documentChunk: 'full' });
  gen = halfBroken;
  await h.wiki.ingestDocument('e1', { sourceRef: 'partial.md', sourceHash: HASH_A, documentChunk: TWO_CHUNKS });
  // mixed.md: a full ingest, then a partial re-ingest whose null-hash rows are newest.
  gen = ok;
  await h.wiki.ingestDocument('e1', { sourceRef: 'mixed.md', sourceHash: HASH_B, documentChunk: 'mixed' });
  gen = halfBroken;
  await h.wiki.ingestDocument('e1', { sourceRef: 'mixed.md', sourceHash: HASH_C, documentChunk: TWO_CHUNKS });
  // Both ingests can land in the same millisecond, and the latest-row tie-break
  // is by random id; push the partial rows later so "latest is hash-less" is deterministic.
  await h.db.runAsync(
    `UPDATE llm_wiki_entries SET updated_at = updated_at + 1000 WHERE entity_id = 'e1' AND source_ref = 'mixed.md' AND source_hash IS NULL`,
  );
  gen = ok;
  await h.wiki.ingestDocument('e2', { sourceRef: 'other.md', sourceHash: HASH_A, documentChunk: 'other' });
  return h;
}

describe('pendingSources', () => {
  it('classifies new, current, changed and partial, preserving input order and duplicates', async () => {
    const { wiki } = await setup();
    const input = [
      { sourceRef: 'full.md', sourceHash: HASH_B },
      { sourceRef: 'nope.md', sourceHash: HASH_A },
      { sourceRef: 'full.md', sourceHash: HASH_A },
      { sourceRef: 'partial.md', sourceHash: HASH_A },
      { sourceRef: 'other.md', sourceHash: HASH_A }, // exists only under e2
      { sourceRef: 'full.md', sourceHash: HASH_A },
    ];
    expect(await wiki.pendingSources('e1', input)).toEqual([
      { sourceRef: 'full.md', status: 'changed' },
      { sourceRef: 'nope.md', status: 'new' },
      { sourceRef: 'full.md', status: 'current' },
      { sourceRef: 'partial.md', status: 'partial' },
      { sourceRef: 'other.md', status: 'new' },
      { sourceRef: 'full.md', status: 'current' },
    ]);
  });

  it('status is current exactly when hasChanged is false, including mixed hashed/partial refs', async () => {
    const { wiki } = await setup();
    const input = ['full.md', 'partial.md', 'mixed.md', 'nope.md'].flatMap((sourceRef) =>
      [HASH_A, HASH_B, HASH_C].map((sourceHash) => ({ sourceRef, sourceHash })));
    const pending = await wiki.pendingSources('e1', input);
    const changed = await wiki.hasChanged('e1', input);
    expect(pending.map((p) => p.status === 'current')).toEqual(changed.map((c) => !c.changed));
    expect(pending.filter((p) => p.sourceRef === 'mixed.md').map((p) => p.status)).toEqual(['changed', 'changed', 'changed']);
  });

  it('echoes the raw ref, uppercases hashes the same way as hasChanged, and validates', async () => {
    const { wiki } = await setup();
    expect(await wiki.pendingSources('e1', [{ sourceRef: 'full!.md', sourceHash: HASH_A.toUpperCase() }]))
      .toEqual([{ sourceRef: 'full!.md', status: 'current' }]);
    await expect(wiki.pendingSources('e1', [{ sourceRef: '!!!', sourceHash: HASH_A }])).rejects.toThrow(/Invalid sourceRef/);
    await expect(wiki.pendingSources('e1', [{ sourceRef: 'a.md', sourceHash: 'xyz' }])).rejects.toThrow(/Invalid sourceHash/);
  });

  it('rejects malformed input shapes with a TypeError before any SQL', async () => {
    const { wiki, db } = await setup();
    const spy = vi.spyOn(db, 'getAllAsync');
    const call = (entityId: unknown, sources: unknown) =>
      (wiki.pendingSources as (e: unknown, s: unknown) => Promise<unknown>).call(wiki, entityId, sources);
    for (const sources of [null, 'abc', {}]) {
      await expect(call('e1', sources)).rejects.toThrow(/^Invalid sources: must be an array/);
    }
    await expect(call('e1', [null])).rejects.toThrow(/^Invalid sources\[0\]/);
    // A hole in a sparse array is an invalid entry, not a silent hole in the output.
    // eslint-disable-next-line no-sparse-arrays
    await expect(call('e1', [{ sourceRef: 'a.md', sourceHash: HASH_A }, , ])).rejects.toThrow(/^Invalid sources\[1\]/);
    // A bigint ref is named by type; JSON.stringify would throw on it.
    await expect(call('e1', [{ sourceRef: BigInt(5), sourceHash: HASH_A }])).rejects.toThrow('Invalid sourceRef: <bigint>');
    await expect(call({}, [])).rejects.toThrow(TypeError);
    await expect(call('', [])).rejects.toThrow(/^Invalid entityId/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns [] for empty input without querying', async () => {
    const { wiki, db } = await setup();
    const spy = vi.spyOn(db, 'getAllAsync');
    expect(await wiki.pendingSources('e1', [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('chunks large inputs under the SQLite variable limit', async () => {
    const { wiki } = await setup();
    const many = Array.from({ length: 1200 }, (_, i) => ({ sourceRef: `doc-${i}.md`, sourceHash: HASH_A }));
    many[700] = { sourceRef: 'full.md', sourceHash: HASH_A };
    const result = await wiki.pendingSources('e1', many);
    expect(result).toHaveLength(1200);
    expect(result[700]).toEqual({ sourceRef: 'full.md', status: 'current' });
    expect(result.filter((r) => r.status === 'new')).toHaveLength(1199);
  });
});
