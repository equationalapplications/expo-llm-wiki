import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/index';
import { EntryRepository } from '../src/repositories/EntryRepository';
import { OutboxRepository } from '../src/repositories/OutboxRepository';

// Regression tests for the /code-review high fixes on PR #372.

const P = 'llm_wiki_';
const llm = { generateText: async () => '{}' };
const ins = (raw: any, id: string) =>
  raw.runAsync(
    `INSERT INTO ${P}entries (id, entity_id, title, body, source_ref, created_at, updated_at) VALUES (?, 'e1', 't', 'b', 'doc', 1, 1)`,
    [id],
  );

describe('PR #372 review fixes', () => {
  it('softDeleteByIds outboxes only rows it changed', async () => {
    const raw = openTestDatabase();
    await new WikiMemory(raw, { llmProvider: llm } as any).setup();
    await ins(raw, 'live');
    await ins(raw, 'gone');
    await raw.runAsync(`UPDATE ${P}entries SET deleted_at = 5 WHERE id = 'gone'`);
    const repo = new EntryRepository(raw, P, new OutboxRepository(raw, P, true));
    await raw.withTransactionAsync((tx: any) => repo.softDeleteByIds(['live', 'gone'], 'e1', tx));
    const rows = (await raw.getAllAsync(`SELECT record_id FROM ${P}outbox`)) as any[];
    expect(rows.map((r) => r.record_id)).toEqual(['live']);
    const gone: any = await raw.getFirstAsync(`SELECT deleted_at FROM ${P}entries WHERE id = 'gone'`);
    expect(gone.deleted_at).toBe(5);
  });

  it('prune of expired facts reports a rejecting hook', async () => {
    const raw = openTestDatabase();
    const diags: any[] = [];
    const wiki = new WikiMemory(raw, {
      llmProvider: llm,
      onDiagnostic: (d: any) => diags.push(d),
      config: { pruneSupersededAfter: 0 },
      vectorRanker: { rankBySimilarity: async () => [], onEmbeddingPersisted: async () => { throw new Error('nope'); } },
    } as any);
    await wiki.setup();
    await ins(raw, 'x');
    await raw.runAsync(`UPDATE ${P}entries SET valid_to = 1 WHERE id = 'x'`);
    await wiki.runPrune('e1', { retainSoftDeletedFor: null, retainEventsFor: null } as any).catch(() => {});
    expect(diags.some((d) => d.code === 'hook_failed' && d.operation === 'prune' && d.detail?.factId === 'x')).toBe(true);
  });

  it('runPendingMaintenance rejects a bad deadlineMs before waiting on the setup drain', async () => {
    const raw = openTestDatabase();
    const wiki = new WikiMemory(raw, { llmProvider: llm } as any);
    await wiki.setup();
    let release!: () => void;
    (wiki as any).setupRemovalDrain = new Promise<void>((r) => { release = r; });
    const started = Date.now();
    await expect(wiki.runPendingMaintenance({ deadlineMs: Number.NaN })).rejects.toThrow(TypeError);
    await expect(wiki.runPendingMaintenance({ deadlineMs: -1 })).rejects.toThrow(TypeError);
    expect(Date.now() - started).toBeLessThan(500);
    release();
  });
});
