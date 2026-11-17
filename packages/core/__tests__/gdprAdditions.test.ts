import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/index';

const P = 'llm_wiki_';
const llm = { generateText: async () => '{}' };

async function make(extra: any = {}) {
  const raw = openTestDatabase();
  const wiki = new WikiMemory(raw, { llmProvider: llm, ...extra } as any);
  await wiki.setup();
  return { raw, wiki };
}
async function ins(raw: any, id: string, deletedAt: number | null) {
  await raw.runAsync(
    `INSERT INTO ${P}entries (id, entity_id, title, body, source_ref, created_at, updated_at, deleted_at) VALUES (?, 'e1', 't', 'b', ?, 1, 1, ?)`,
    [id, `ref-${id}`, deletedAt],
  );
}
const ids = (d: any) => (d.entities.e1?.facts ?? []).map((f: any) => f.id).sort();

describe('GDPR additions (spec §8)', () => {
  it('AC1: exportDump excludes forgotten rows by default; includeForgotten includes them', async () => {
    const { raw, wiki } = await make();
    await ins(raw, 'live', null);
    await ins(raw, 'gone', 5);
    expect(ids(await wiki.exportDump())).toEqual(['live']);
    expect(ids(await wiki.exportDump(undefined, { includeForgotten: true }))).toEqual(['gone', 'live']);
    expect(ids(await wiki.exportDump(['e1'], { includeForgotten: false }))).toEqual(['live']);
  });

  it('AC2: import tombstone for a live ref keeps it tombstoned; local tombstone beats live re-ingest', async () => {
    const { raw, wiki } = await make();
    await ins(raw, 'a', null);
    await ins(raw, 'b', 9);
    const dump = await wiki.exportDump(undefined, { includeForgotten: true });
    const fa = dump.entities.e1.facts.find((f: any) => f.id === 'a')!;
    const fb = dump.entities.e1.facts.find((f: any) => f.id === 'b')!;
    fa.deleted_at = 20; // dump tombstones a live local row
    fb.deleted_at = null; // dump tries to resurrect a locally forgotten row
    fb.updated_at = 100;
    await wiki.importDump(dump, { merge: true });
    const rows = await raw.getAllAsync(`SELECT id, deleted_at FROM ${P}entries ORDER BY id`);
    expect(rows.map((r: any) => [r.id, r.deleted_at !== null])).toEqual([['a', true], ['b', true]]);
  });

  it('AC3: getRetentionPolicy returns shipped defaults and host overrides', async () => {
    const d = await make();
    expect(d.wiki.getRetentionPolicy()).toEqual({ retainSoftDeletedFor: 7, retainEventsFor: 30, pruneSupersededAfter: null });
    const o = await make({ config: { pruneRetainSoftDeletedFor: 1, pruneEventsAfter: 2, pruneSupersededAfter: 3 } });
    expect(o.wiki.getRetentionPolicy()).toEqual({ retainSoftDeletedFor: 1, retainEventsFor: 2, pruneSupersededAfter: 3 });
  });
});
