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

  it('AC4: a dump carrying tombstone then live rows for the same id does not resurrect the tombstone', async () => {
    const { raw, wiki } = await make();
    await ins(raw, 'a', null);
    const dump = await wiki.exportDump(undefined, { includeForgotten: true });
    const live = dump.entities.e1.facts.find((f: any) => f.id === 'a')!;
    // Tombstone row processed first, live row second — same id within ONE dump.
    dump.entities.e1.facts = [{ ...live, deleted_at: 50, updated_at: 100 }, { ...live, updated_at: 200 }];
    await wiki.importDump(dump, { merge: true });
    const row = await raw.getFirstAsync<{ deleted_at: number | null }>(`SELECT deleted_at FROM ${P}entries WHERE id = 'a'`);
    expect(row!.deleted_at).toBe(50);
  });

  it('AC5: a local task tombstone beats a live dump task (forget wins for tasks)', async () => {
    const { raw, wiki } = await make();
    await raw.runAsync(
      `INSERT INTO ${P}tasks (id, entity_id, description, status, priority, created_at, updated_at, deleted_at) VALUES (?, 'e1', 'local task', 'pending', 0, 1, 1, 9)`,
      ['t1'],
    );
    const dump = await wiki.exportDump(undefined, { includeForgotten: true });
    dump.entities.e1.tasks = [{
      id: 't1', entity_id: 'e1', description: 're-ingested task', status: 'pending', priority: 0,
      created_at: 1, updated_at: 200, resolved_at: null, deleted_at: null,
    }];
    await wiki.importDump(dump, { merge: true });
    const row = await raw.getFirstAsync<{ deleted_at: number | null; description: string }>(`SELECT deleted_at, description FROM ${P}tasks WHERE id = 't1'`);
    expect(row!.deleted_at).toBe(9);
    expect(row!.description).toBe('local task');
  });

  it('AC6: a dump task tombstone bypasses the merge recency check', async () => {
    const { raw, wiki } = await make();
    await raw.runAsync(
      `INSERT INTO ${P}tasks (id, entity_id, description, status, priority, created_at, updated_at) VALUES (?, 'e1', 'live local task', 'pending', 0, 1, 500)`,
      ['t1'],
    );
    const dump = await wiki.exportDump(undefined, { includeForgotten: true });
    dump.entities.e1.tasks = [{
      id: 't1', entity_id: 'e1', description: 'live local task', status: 'pending', priority: 0,
      created_at: 1, updated_at: 100, resolved_at: null, deleted_at: 50,
    }];
    await wiki.importDump(dump, { merge: true });
    const row = await raw.getFirstAsync<{ deleted_at: number | null }>(`SELECT deleted_at FROM ${P}tasks WHERE id = 't1'`);
    expect(row!.deleted_at).toBe(50);
  });

  it('AC10: a dump [tombstone, live] pair embeds only the final accepted row — the rejected live text never reaches llmProvider.embed', async () => {
    const embeddedBodies: string[] = [];
    const { raw, wiki } = await make({ llmProvider: { generateText: async () => '{}', embed: async (t: string) => { embeddedBodies.push(t); return [1, 0, 0]; } } });
    await ins(raw, 'seed', null); // non-empty store so exportDump includes e1
    const dump = await wiki.exportDump(undefined, { includeForgotten: true });
    const mk = (over: Record<string, unknown>) => ({
      id: 'f1', entity_id: 'e1', title: 't', body: 'b', tags: [], confidence: 'certain',
      source_type: 'user_stated', source_ref: null, source_hash: null, created_at: 1,
      updated_at: 1, last_accessed_at: 1, access_count: 0, deleted_at: null, ...over,
    });
    // Tombstone accepted first, live row second — the live row is rejected by the
    // tombstone guard, and its text must never be sent to the embed provider.
    dump.entities.e1.facts = [
      mk({ deleted_at: 50, updated_at: 100 }),
      mk({ title: 'rejected live title', body: 'rejected live body', updated_at: 200, deleted_at: null }),
    ];
    const before = embeddedBodies.length;
    await wiki.importDump(dump, { merge: true });
    const row = await raw.getFirstAsync<{ deleted_at: number | null }>(`SELECT deleted_at FROM ${P}entries WHERE id = 'f1'`);
    expect(row!.deleted_at).toBe(50);
    // Pre-fix, the embed loop gated on upsertedFactIds + the CURRENT row's
    // !deleted_at, so the rejected live row was embedded — with the tombstone's
    // clipped text (the rejected row never sets the clip map). Post-fix, f1's
    // final accepted row is a tombstone, so NO embed call happens for it at all.
    expect(embeddedBodies.slice(before)).toEqual([]);
  });

  it('AC7: replace mode still re-imports live task rows the wipe just tombstoned', async () => {
    const { raw, wiki } = await make();
    await raw.runAsync(
      `INSERT INTO ${P}tasks (id, entity_id, description, status, priority, created_at, updated_at) VALUES (?, 'e1', 'pre-wipe task', 'pending', 0, 1, 1)`,
      ['t1'],
    );
    const dump = await wiki.exportDump(undefined, { includeForgotten: true });
    dump.entities.e1.tasks = [{
      id: 't1', entity_id: 'e1', description: 'replacement task', status: 'pending', priority: 0,
      created_at: 1, updated_at: 300, resolved_at: null, deleted_at: null,
    }];
    await wiki.importDump(dump); // no merge: wipe first, then import
    const row = await raw.getFirstAsync<{ deleted_at: number | null; description: string }>(`SELECT deleted_at, description FROM ${P}tasks WHERE id = 't1'`);
    expect(row!.deleted_at).toBeNull();
    expect(row!.description).toBe('replacement task');
  });

  it('AC8: replace mode — a dump tombstone consumed by its own live row cannot resurrect through the wipe exemption', async () => {
    const { raw, wiki } = await make();
    await raw.runAsync(
      `INSERT INTO ${P}tasks (id, entity_id, description, status, priority, created_at, updated_at) VALUES (?, 'e1', 'live task', 'pending', 0, 1, 1)`,
      ['t1'],
    );
    const dump = await wiki.exportDump(undefined, { includeForgotten: true });
    const base = { id: 't1', entity_id: 'e1', description: 'x', status: 'pending', priority: 0, created_at: 1, resolved_at: null };
    dump.entities.e1.tasks = [
      { ...base, updated_at: 100, deleted_at: 50 }, // explicit dump tombstone
      { ...base, description: 're-ingested task', updated_at: 200, deleted_at: null }, // its own live row
    ];
    await wiki.importDump(dump); // replace mode: wipe adds t1 to the exemption set
    const row = await raw.getFirstAsync<{ deleted_at: number | null; description: string }>(`SELECT deleted_at, description FROM ${P}tasks WHERE id = 't1'`);
    expect(row!.deleted_at).toBe(50);
    expect(row!.description).toBe('x');
  });

  it('AC9: replace mode — same exemption hole closed for facts', async () => {
    const { raw, wiki } = await make();
    await ins(raw, 'a', null);
    const dump = await wiki.exportDump(undefined, { includeForgotten: true });
    const live = dump.entities.e1.facts.find((f: any) => f.id === 'a')!;
    dump.entities.e1.facts = [{ ...live, deleted_at: 50, updated_at: 100 }, { ...live, updated_at: 200 }];
    await wiki.importDump(dump); // replace mode: wipe adds 'a' to the exemption set
    const row = await raw.getFirstAsync<{ deleted_at: number | null }>(`SELECT deleted_at FROM ${P}entries WHERE id = 'a'`);
    expect(row!.deleted_at).toBe(50);
  });
});
