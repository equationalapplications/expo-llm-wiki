/**
 * Spec import-followups §6: forget({ clearAll: true, includeEvents: true }) wipes
 * an entity's events, read or not; clearAll also removes edges and source-ref rows.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WikiDiagnostic } from '../src/types';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';

const embed = async (t: string) => [t.length % 7, (t.charCodeAt(0) || 1) % 5, 1, 0.5];

async function mk(extra: Record<string, unknown> = {}) {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const generateText = vi.fn(async ({ systemPrompt, userPrompt }: { systemPrompt: string; userPrompt: string }) => {
    if (/memory extraction agent/.test(systemPrompt)) {
      const facts = [...userPrompt.matchAll(/^(e\d+) \[[^\]]+\] \([^)]+\) (.*)$/gm)].map((m) => ({
        title: m[2]!.slice(0, 60), body: m[2]!, tags: [], confidence: 'certain', source_event: m[1],
      }));
      return JSON.stringify({ facts, tasks: [] });
    }
    if (/reconciliation agent/.test(systemPrompt)) {
      const items = (JSON.parse(userPrompt.slice(userPrompt.indexOf('{'))) as { items: Array<{ item: number }> }).items;
      return JSON.stringify({ ops: items.map((i) => ({ item: i.item, op: 'ADD' })) });
    }
    return JSON.stringify({ facts: [], tasks: [] });
  });
  // 8.0.0 defaults: ops + deferred (no config).
  const wiki = new WikiMemory(db, { llmProvider: { generateText, embed }, onDiagnostic: (d) => diagnostics.push(d), ...extra });
  await wiki.setup();
  const count = async (table: string, entityId: string, where = '') =>
    (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM llm_wiki_${table} WHERE entity_id = ?${where}`, [entityId]))!.n;
  const write = async (entityId: string, n: number) => {
    for (let i = 0; i < n; i++) await wiki.write(entityId, { event_type: 'observation', summary: `${entityId} note number ${i}` });
  };
  const edge = (entityId: string, id: string) =>
    db.runAsync(`INSERT INTO llm_wiki_edges (id, entity_id, source_id, target_id, edge_type, created_at) VALUES (?, ?, 'a', 'b', ?, 1)`, [id, entityId, id]);
  const ref = (entityId: string, id: string) =>
    db.runAsync(`INSERT INTO llm_wiki_source_ref_index (id, entity_id, source_hash, source_ref, created_at, deleted_at) VALUES (?, ?, ?, ?, 1, NULL)`, [id, entityId, id.padEnd(64, '0'), `doc-${id}.md`]);
  const checkpoint = (entityId: string) => db.getFirstAsync<Record<string, unknown>>(`SELECT * FROM llm_wiki_checkpoints WHERE entity_id = ?`, [entityId]);
  return { db, wiki, diagnostics, generateText, count, write, edge, ref, checkpoint };
}

const WIPE = { clearAll: true, includeEvents: true } as const;
const PRUNE = { retainSoftDeletedFor: 0, retainEventsFor: 0, vacuum: true } as const;

afterEach(() => vi.restoreAllMocks());

describe('forget({ clearAll: true, includeEvents: true })', () => {
  it('deletes unread events, and maintenance afterwards brings nothing back (fails on main)', async () => {
    const { wiki, diagnostics, generateText, count, write } = await mk();
    await write('e1', 5);
    const res = await wiki.forget('e1', WIPE);
    expect(res).toEqual({ deleted: { entries: 0, tasks: 0, events: 5 }, metadataReset: true });
    await wiki.runPrune('e1', PRUNE);
    expect(await count('events', 'e1')).toBe(0);
    expect(diagnostics.filter((d) => d.code === 'event_retention_held')).toEqual([]);
    generateText.mockClear();
    await wiki.runPendingMaintenance();
    expect(generateText).not.toHaveBeenCalled();
    expect(await count('entries', 'e1', ' AND deleted_at IS NULL')).toBe(0);
  });

  it('without includeEvents, clearAll keeps events and the librarian position', async () => {
    const { wiki, count, write, checkpoint } = await mk();
    await write('e1', 3);
    await wiki.runLibrarian('e1');
    const before = await checkpoint('e1');
    const res = await wiki.forget('e1', { clearAll: true });
    expect(res).toEqual({ deleted: { entries: expect.any(Number), tasks: 0 }, metadataReset: true });
    expect('events' in res.deleted).toBe(false);
    expect(await count('events', 'e1')).toBe(3);
    const after = await checkpoint('e1');
    expect([after?.librarian_watermark_at, after?.librarian_watermark_id]).toEqual([before?.librarian_watermark_at, before?.librarian_watermark_id]);
  });

  it('clearAll deletes the entity\'s edges and retires its live source-ref rows, and leaves other entities alone', async () => {
    const { wiki, count, edge, ref } = await mk();
    await edge('e1', 'x1'); await edge('e1', 'x2'); await edge('e2', 'y1');
    await ref('e1', 'r1'); await ref('e2', 'r2');
    await wiki.forget('e1', { clearAll: true });
    expect(await count('edges', 'e1')).toBe(0);
    expect(await count('edges', 'e2')).toBe(1);
    expect(await count('source_ref_index', 'e1', ' AND deleted_at IS NULL')).toBe(0);
    expect(await count('source_ref_index', 'e2', ' AND deleted_at IS NULL')).toBe(1);
  });

  it('removes the checkpoint row, so an event written afterwards is read even under an earlier clock', async () => {
    const { wiki, generateText, write, checkpoint } = await mk();
    await write('e1', 3);
    await wiki.runLibrarian('e1');
    expect((await checkpoint('e1'))?.librarian_watermark_at).not.toBeNull();
    await wiki.forget('e1', WIPE);
    expect(await checkpoint('e1')).toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await wiki.write('e1', { event_type: 'observation', summary: 'After the wipe' });
    generateText.mockClear();
    await wiki.runLibrarian('e1');
    expect(generateText.mock.calls.map((c) => c[0].userPrompt).join('\n')).toContain('After the wipe');
  });

  it('leaves another entity\'s events and checkpoint alone', async () => {
    const { wiki, count, write, checkpoint } = await mk();
    await write('e1', 2); await write('e2', 2);
    await wiki.runLibrarian('e2');
    const before = await checkpoint('e2');
    await wiki.forget('e1', WIPE);
    expect(await count('events', 'e2')).toBe(2);
    expect(await checkpoint('e2')).toEqual(before);
  });

  it.each([
    [{ includeEvents: true }],
    [{ includeEvents: true, entryId: 'f1' }],
    [{ includeEvents: true, sourceRef: 'doc.md' }],
  ])('includeEvents without clearAll throws and writes nothing: %j', async (params) => {
    const { wiki, count, write } = await mk();
    await write('e1', 2);
    await expect(wiki.forget('e1', params as never)).rejects.toThrow(/includeEvents/);
    expect(await count('events', 'e1')).toBe(2);
  });

  it('dryRun reports the event count and deletes nothing', async () => {
    const { wiki, count, write } = await mk();
    await write('e1', 4);
    expect(await wiki.forget('e1', WIPE, { dryRun: true })).toEqual({ deleted: { entries: 0, tasks: 0, events: 4 }, metadataReset: true });
    expect(await count('events', 'e1')).toBe(4);
  });

  it('a held librarian lock gives WikiBusyError and deletes nothing', async () => {
    const { wiki, count, write } = await mk();
    await write('e1', 2);
    (wiki.__testAccess as any).jobManager.acquireLock('librarian', 'e1');
    await expect(wiki.forget('e1', WIPE)).rejects.toMatchObject({ name: 'WikiBusyError' });
    expect(await count('events', 'e1')).toBe(2);
  });

  it('a rejecting deletion hook throws after commit; the retry succeeds and reports events: 0', async () => {
    let fail = true;
    const { wiki, count, write } = await mk({
      vectorRanker: { rankBySimilarity: async () => [], onEmbeddingPersisted: async () => { if (fail) throw new Error('index down'); } },
    });
    await write('e1', 3);
    await wiki.runLibrarian('e1');
    expect(await count('entries', 'e1', ' AND deleted_at IS NULL')).toBeGreaterThan(0);
    await expect(wiki.forget('e1', WIPE)).rejects.toThrow(/ANN cleanup hook rejected/);
    expect(await count('events', 'e1')).toBe(0);
    fail = false;
    const retry = await wiki.forget('e1', WIPE);
    expect(retry.deleted.events).toBe(0);
  });

  it('emits no diagnostics', async () => {
    const { wiki, diagnostics, write } = await mk();
    await write('e1', 2);
    diagnostics.length = 0;
    await wiki.forget('e1', WIPE);
    expect(diagnostics).toEqual([]);
  });
});
