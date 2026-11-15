import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { formatContext } from '../src/utils/formatContext';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions, MemoryBundle } from '../src/types';

const E = 'ent1';
const hash = (c: string): string => c.repeat(64).slice(0, 64);
const FACT = JSON.stringify({ facts: [{ title: 'Quokka', body: 'quokka lives on Rottnest', tags: [], confidence: 'certain' }] });

type Kind = 'fts5' | 'minisearch';

async function setup(kind: Kind, generateText: (...a: unknown[]) => Promise<string> = async () => '{}') {
  const db = openTestDatabase();
  const gen = vi.fn(generateText);
  const embed = vi.fn(async () => [0]);
  const options = {
    llmProvider: { generateText: gen, embed },
    config: { indexStrategy: kind },
  } as unknown as WikiOptions;
  const wiki = new WikiMemory(db, options);
  await wiki.setup();
  return { db, wiki, options, gen, embed };
}

const readSources = (wiki: WikiMemory, ent: string | string[], query: string) =>
  wiki.read(ent, 'unrelated', { sources: { query } });

describe.each<Kind>(['fts5', 'minisearch'])('source store public wiring (%s)', (kind) => {
  it('store → read with sources, no manual drain, and no model call', async () => {
    const { wiki, gen, embed } = await setup(kind);
    const r = await wiki.storeSource(E, { sourceRef: 'a.md', sourceHash: hash('a'), text: 'quokka habitat notes' });
    expect(r.stored).toBe(true);
    await wiki.storeSource(E, { sourceRef: 'b.md', sourceHash: hash('b'), text: 'unrelated filler words' });
    expect((await wiki.getStoredSource(E, 'a.md'))?.text).toBe('quokka habitat notes');
    expect(await wiki.listStoredSources(E)).toHaveLength(2);
    const bundle = await readSources(wiki, E, 'quokka');
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources![0]).toMatchObject({ sourceRef: 'a.md', text: 'quokka habitat notes' });
    expect(gen).not.toHaveBeenCalled();
    // The sources group adds no embedding beyond what a plain read already does.
    const before = embed.mock.calls.length;
    await wiki.read(E, 'unrelated');
    const plain = embed.mock.calls.length - before;
    const mid = embed.mock.calls.length;
    await readSources(wiki, E, 'quokka');
    expect(embed.mock.calls.length - mid).toBe(plain);
  });

  it('a changed copy replaces the old passages for readers', async () => {
    const { wiki } = await setup(kind);
    await wiki.storeSource(E, { sourceRef: 'a.md', sourceHash: hash('a'), text: 'quokka habitat notes' });
    await wiki.storeSource(E, { sourceRef: 'a.md', sourceHash: hash('c'), text: 'wombat burrow notes' });
    expect((await readSources(wiki, E, 'quokka')).sources).toEqual([]);
    expect((await readSources(wiki, E, 'wombat')).sources).toHaveLength(1);
  });

  it('facts and passages join under the same sourceRef after ingestDocument; forget removes both', async () => {
    const { wiki } = await setup(kind, async () => FACT);
    await wiki.storeSource(E, { sourceRef: 'doc.md', sourceHash: hash('d'), text: 'quokka field guide' });
    await wiki.ingestDocument(E, { sourceRef: 'doc.md', sourceHash: hash('d'), documentChunk: 'quokka field guide' });
    const b = await readSources(wiki, E, 'quokka');
    expect(b.facts.length).toBeGreaterThan(0);
    expect(b.sources!.map((p) => p.sourceRef)).toEqual(['doc.md']);
    const listed = await wiki.listSourceRefs(E);
    expect(listed.find((l) => l.sourceRef === 'doc.md')?.stored).toMatchObject({ charCount: 18 });

    await wiki.forget(E, { sourceRef: 'doc.md' });
    const after = await readSources(wiki, E, 'quokka');
    expect(after.facts).toEqual([]);
    expect(after.sources).toEqual([]);
    const afterListed = await wiki.listSourceRefs(E);
    expect(afterListed.find((l) => l.sourceRef === 'doc.md')).toBeUndefined();
  });

  it('forget({ clearAll }) leaves no passage queryable', async () => {
    const { wiki } = await setup(kind);
    await wiki.storeSource(E, { sourceRef: 'a.md', sourceHash: hash('a'), text: 'quokka habitat notes' });
    expect((await readSources(wiki, E, 'quokka')).sources).toHaveLength(1);
    await wiki.forget(E, { clearAll: true });
    expect((await readSources(wiki, E, 'quokka')).sources).toEqual([]);
  });

  it('keeps entities isolated for the same sourceRef', async () => {
    const { wiki } = await setup(kind);
    await wiki.storeSource('e1', { sourceRef: 'a.md', sourceHash: hash('a'), text: 'quokka in one' });
    await wiki.storeSource('e2', { sourceRef: 'a.md', sourceHash: hash('b'), text: 'quokka in two' });
    expect((await readSources(wiki, 'e1', 'quokka')).sources!.map((p) => p.text)).toEqual(['quokka in one']);
    expect((await readSources(wiki, 'e2', 'quokka')).sources!.map((p) => p.text)).toEqual(['quokka in two']);
    expect((await wiki.getStoredSource('e1', 'a.md'))?.text).toBe('quokka in one');
  });

  it('reopening the database re-indexes stored passages', async () => {
    const { db, wiki, options } = await setup(kind);
    await wiki.storeSource(E, { sourceRef: 'a.md', sourceHash: hash('a'), text: 'quokka habitat notes' });
    const reopened = new WikiMemory(db, options);
    await reopened.setup();
    expect((await readSources(reopened, E, 'quokka')).sources).toHaveLength(1);
  });
});

describe('formatContext Sources group', () => {
  const base: MemoryBundle = { facts: [], tasks: [], events: [] };
  const withFact: MemoryBundle = {
    ...base,
    facts: [{ id: 'f1', entity_id: E, title: 'T', body: 'B', tags: [], confidence: 'certain' } as never],
  };
  const sources = [{
    entityId: E, sourceRef: 'a.md', sourceHash: hash('a'), seq: 0, startOffset: 0, endOffset: 5, truncated: false, text: 'hello',
  }];

  it('prints Sources after the existing groups when present', () => {
    const out = formatContext({ ...withFact, sources });
    expect(out.indexOf('### Sources')).toBeGreaterThan(out.indexOf('### Known Facts'));
    expect(out).toContain('- [a.md #0] hello');
    expect(formatContext({ ...withFact, sources }, { format: 'plain' })).toContain('SOURCES:\n[a.md #0] hello');
  });

  it('is byte-identical without the group', () => {
    expect(formatContext({ ...withFact, sources: [] })).toBe(formatContext(withFact));
    expect(formatContext({ ...base, sources: [] })).toBe('');
  });
});
