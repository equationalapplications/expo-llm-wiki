import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/WikiMemory';
import { withSerializedTransactions } from '../src/db/serializedAdapter';
import { VectorRemovalRepository } from '../src/repositories/VectorRemovalRepository';
import { VectorRemovalService } from '../src/services/VectorRemovalService';
import { EmbeddingService } from '../src/services/EmbeddingService';
import { EntryRepository } from '../src/repositories/EntryRepository';
import { OutboxRepository } from '../src/repositories/OutboxRepository';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
const llm = { generateText: async () => '{}' };

type Call = { entityId: string; factId: string; vector: unknown };

async function make(hook?: (c: Call) => Promise<void> | void, extra: any = {}) {
  const raw = openTestDatabase();
  await new WikiMemory(raw, { llmProvider: llm } as any).setup();
  const db = withSerializedTransactions(raw);
  const calls: Call[] = [];
  const diags: any[] = [];
  const options: any = {
    llmProvider: llm,
    onDiagnostic: (d: any) => diags.push(d),
    ...(hook
      ? {
          vectorRanker: {
            onEmbeddingPersisted: async (c: Call) => {
              calls.push(c);
              await hook(c);
            },
          },
        }
      : {}),
    ...extra,
  };
  const meta = new MetadataRepository(db, P);
  const entryRepo = new EntryRepository(db, P, new OutboxRepository(db, P, false));
  const emb = new EmbeddingService(db, options, entryRepo, meta);
  const repo = new VectorRemovalRepository(db, P);
  const svc = new VectorRemovalService(db, options, repo, emb, meta);
  return { raw, db, calls, diags, svc, repo, meta };
}

async function del(db: SQLiteAdapter, id: string, entity = 'e1') {
  await db.runAsync(
    `INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at) VALUES (?, ?, 't', 'b', 1, 1)`,
    [id, entity],
  );
  await db.runAsync(`UPDATE ${P}entries SET deleted_at = 1 WHERE id = ?`, [id]);
}
const ledger = (db: SQLiteAdapter) =>
  db.getAllAsync<any>(`SELECT * FROM ${P}vector_removals ORDER BY seq`);

describe('VectorRemovalService.drain', () => {
  it('a rejecting id does not stop the drain', async () => {
    const t = await make((c) => {
      if (c.factId === 'b') throw new Error('nope');
    });
    for (const id of ['a', 'b', 'c']) await del(t.db, id);
    const r = await t.svc.drain({ entityId: 'e1' });
    expect(t.calls.map((c) => c.factId)).toEqual(['a', 'b', 'c']);
    expect(r.confirmed).toBe(2);
    expect(r.pending).toBe(1);
    expect(r.failedIds).toEqual(['b']);
    expect(t.calls[0].vector).toBeNull();
    const rows = await ledger(t.db);
    expect(rows.find((x) => x.fact_id === 'b').attempts).toBe(1);
  });

  it('a hang stops the drain after one call and moves the row back', async () => {
    const t = await make(() => new Promise<void>(() => {}), { deletionHookTimeoutMs: 50 });
    for (const id of ['1', '2', '3', '4', '5']) await del(t.db, id);
    const r = await t.svc.drain({ all: true });
    expect(t.calls).toHaveLength(1);
    expect(r.timedOut).toBe(true);
    expect(r.pending).toBe(5);
    await t.svc.drain({ all: true });
    expect(t.calls[1].factId).toBe('2');
  });

  it('without a hook the ledger is unchanged and pending is reported', async () => {
    const t = await make();
    await del(t.db, 'a');
    const before = await ledger(t.db);
    const r = await t.svc.drain({ all: true });
    expect(r.pending).toBe(1);
    expect(r.confirmed).toBe(0);
    expect(await ledger(t.db)).toEqual(before);
    const d = t.diags.filter((x) => x.code === 'external_deletion_pending');
    expect(d).toHaveLength(1);
    expect(d[0].entityId).toBe('e1');
    expect(d[0].operation).toBe('externalDeletion');
  });

  it('force discards pending rows and reports the count', async () => {
    const t = await make((() => {}) as any, { forceDeleteIgnoreRankerHook: true });
    await del(t.db, 'a');
    await del(t.db, 'b');
    await t.db.withTransactionAsync((tx) => t.svc.markExternalIndexInUse(tx));
    expect(await t.svc.externalIndexInUse()).toBe(true);
    const r = await t.svc.drain({ all: true });
    expect(t.calls).toHaveLength(0);
    expect(r.pending).toBe(0);
    expect(await ledger(t.db)).toHaveLength(0);
    expect(await t.svc.externalIndexInUse()).toBe(false);
    const d = t.diags.find((x) => x.code === 'external_deletion_discarded');
    expect(d.detail.count).toBe(2);
  });

  it('an invalid deletionHookTimeoutMs throws before any call and leaves attempts unchanged', async () => {
    const t = await make(() => {}, { deletionHookTimeoutMs: -1 });
    await del(t.db, 'a');
    await expect(t.svc.drain({ all: true })).rejects.toThrow(/Invalid deletionHookTimeoutMs/);
    expect(t.calls).toHaveLength(0);
    expect((await ledger(t.db))[0].attempts).toBe(0);
  });

  it("entity A's drain never sends entity B's ids", async () => {
    const t = await make();
    const t2 = await make(() => {});
    await del(t2.db, 'a1', 'A');
    await del(t2.db, 'b1', 'B');
    await t2.svc.drain({ entityId: 'A' });
    expect(t2.calls.map((c) => c.factId)).toEqual(['a1']);
    expect(t2.calls.every((c) => c.entityId === 'A')).toBe(true);
    await t2.svc.drain({ entityId: 'A', ids: ['b1'] });
    expect(t2.calls).toHaveLength(1);
    void t;
  });

  it('a re-delete during an in-flight confirmation stays pending', async () => {
    const t = await make();
    let db: SQLiteAdapter;
    const t2 = await make(async () => {
      await db.runAsync(`UPDATE ${P}entries SET deleted_at = NULL WHERE id = 'a'`);
      await db.runAsync(`UPDATE ${P}entries SET deleted_at = 2 WHERE id = 'a'`);
    });
    db = t2.db;
    await del(t2.db, 'a');
    await t2.svc.drain({ all: true });
    const rows = await ledger(t2.db);
    expect(rows).toHaveLength(1);
    expect(rows[0].confirmed_at).toBeNull();
    void t;
  });

  it('a host-held transaction makes the drain stop with no calls', async () => {
    const t = await make(() => {});
    await del(t.db, 'a');
    await t.raw.execAsync('BEGIN');
    try {
      const r = await t.svc.drain({ all: true });
      expect(t.calls).toHaveLength(0);
      expect(r.pending).toBe(1);
      expect(r.confirmed).toBe(0);
    } finally {
      await t.raw.execAsync('ROLLBACK');
    }
    expect((await ledger(t.db))[0].attempts).toBe(0);
  });

  it('every drain ends: 300 rows with every third rejected, at most 300 calls', async () => {
    let n = 0;
    const t = await make(() => {
      if (n++ % 3 === 2) throw new Error('x');
    });
    for (let i = 0; i < 300; i++) await del(t.db, `f${i}`);
    const r = await t.svc.drain({ all: true });
    expect(t.calls.length).toBeLessThanOrEqual(300);
    expect(r.confirmed).toBe(200);
    expect(r.failedIds.length).toBe(100);
  });

  it('the same id in two concurrent drains is called once', async () => {
    let release!: () => void;
    const gateP = new Promise<void>((res) => (release = res));
    const t = await make(() => gateP);
    await del(t.db, 'a');
    const p1 = t.svc.drain({ all: true });
    const p2 = t.svc.drain({ entityId: 'e1' });
    await new Promise((r) => setTimeout(r, 30));
    release();
    await Promise.all([p1, p2]);
    expect(t.calls).toHaveLength(1);
    expect((await ledger(t.db))[0].confirmed_at).not.toBeNull();
  });

  it('resolved for a gone fact deletes the ledger row', async () => {
    const t = await make(async (c) => {
      await t.db.runAsync(`DELETE FROM ${P}entries WHERE id = ?`, [c.factId]);
    });
    await del(t.db, 'a');
    // hard delete before the page read: simulate a gone fact
    await t.db.runAsync(`DELETE FROM ${P}entries WHERE id = 'a'`);
    const r = await t.svc.drain({ all: true });
    expect(t.calls).toHaveLength(1);
    expect(await ledger(t.db)).toHaveLength(0);
    expect(r.pending).toBe(0);
  });
});
