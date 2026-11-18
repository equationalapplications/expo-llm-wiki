/** Spec forget-erasure §3 (T7): forget({ entryId, includeChain: true }). */
import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/index';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';

async function make() {
  const raw = openTestDatabase();
  const wiki = new WikiMemory(raw, { llmProvider: { generateText: async () => '{}' } });
  await wiki.setup();
  return { raw, wiki };
}

async function ins(raw: SQLiteAdapter, id: string, supersededBy: string | null = null) {
  await raw.runAsync(
    `INSERT INTO ${P}entries (id, entity_id, title, body, superseded_by, created_at, updated_at) VALUES (?, 'e1', 't', 'b', ?, 1, 1)`,
    [id, supersededBy],
  );
}
const deleted = async (raw: SQLiteAdapter) =>
  (await raw.getAllAsync<{ id: string }>(`SELECT id FROM ${P}entries WHERE deleted_at IS NOT NULL ORDER BY id`)).map((r) => r.id);

describe('forget({ entryId, includeChain })', () => {
  it('AC1: fan-in A→C←B — forgetting A reaches C, not B', async () => {
    const { raw, wiki } = await make();
    await ins(raw, 'C');
    await ins(raw, 'A', 'C');
    await ins(raw, 'B', 'C');
    const r = await wiki.forget('e1', { entryId: 'A', includeChain: true });
    expect(await deleted(raw)).toEqual(['A', 'C']);
    expect(r.deleted.entries).toBe(2);
  });

  it('AC2: dry-run lists exactly the walked ids; entryId alone stays rejected', async () => {
    const { raw, wiki } = await make();
    await ins(raw, 'D');
    await ins(raw, 'C', 'D');
    await ins(raw, 'A', 'C');
    const r = await wiki.forget('e1', { entryId: 'A', includeChain: true }, { dryRun: true });
    expect(r.chainEntryIds).toEqual(['C', 'D']);
    expect(r.truncated).toBeFalsy();
    expect(r.deleted.entries).toBe(3);
    expect(await deleted(raw)).toEqual([]);
    await expect(wiki.forget('e1', { entryId: 'A' }, { dryRun: true })).rejects.toThrow(/entryId/);
    await expect(wiki.forget('e1', { taskId: 't', includeChain: true }, { dryRun: true })).rejects.toThrow();
  });

  it('AC2: truncation is reported with the depth-cap notice', async () => {
    const { raw, wiki } = await make();
    for (let i = 0; i <= 110; i++) await ins(raw, `n${i}`, i < 110 ? `n${i + 1}` : null);
    const r = await wiki.forget('e1', { entryId: 'n0', includeChain: true }, { dryRun: true });
    expect(r.truncated).toBe(true);
    expect(r.chainEntryIds).toHaveLength(100);
    expect(r.notice).toMatch(/100/);
  });

  it('AC3: real run soft-deletes the chain; erase() completes', async () => {
    const { raw, wiki } = await make();
    await ins(raw, 'C');
    await ins(raw, 'A', 'C');
    const r = await wiki.forget('e1', { entryId: 'A', includeChain: true });
    expect(r.chainEntryIds).toEqual(['C']);
    const report = await wiki.erase();
    expect(report.verified).toBe(true);
    const left = await raw.getAllAsync(`SELECT id FROM ${P}entries`);
    expect(left).toHaveLength(0);
  });

  it('includeChain without entryId throws', async () => {
    const { wiki } = await make();
    await expect(wiki.forget('e1', { sourceRef: 'x', includeChain: true })).rejects.toThrow(/includeChain/);
  });
});
