/**
 * Spec forget-erasure §2 (T3): erase() prune core — step 0 (pragma verify),
 * step 1 (per-entity prune, events kept), step 1b (store-wide registry
 * tombstone sweep). The thin `MaintenanceService.erase()` entry returns a
 * report; T6 completes the pipeline (steps 3-8).
 */
import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { LEGACY_AUTO } from './helpers/legacyAutoConfig';
import { openV8Database, insertV8Entry, sourceRefIndexExists } from './helpers/v8Schema';
import { WikiMemory } from '../src/index';
import type { SQLiteAdapter, WikiDiagnostic, WikiOptions } from '../src/types';

const P = 'llm_wiki_';
const H1 = 'd'.repeat(64);
const llm = { generateText: async () => '{}' };

type Call = { entityId: string; factId: string; vector: unknown };

function svc(wiki: WikiMemory): any {
  return (wiki as any).maintenanceService;
}

async function make(opts: { hook?: (c: Call) => void; raw?: SQLiteAdapter; extra?: Partial<WikiOptions> } = {}) {
  const raw = opts.raw ?? openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const hook = opts.hook;
  const wiki = new WikiMemory(raw, {
    llmProvider: llm,
    onDiagnostic: (d: WikiDiagnostic) => { diagnostics.push(d); },
    ...(hook
      ? {
          vectorRanker: {
            rankBySimilarity: async () => [],
            onEmbeddingPersisted: async (c: Call) => { hook(c); },
          },
          config: LEGACY_AUTO,
        }
      : {}),
    ...opts.extra,
  } as WikiOptions);
  await wiki.setup();
  return { raw, wiki, diagnostics };
}

async function insEntry(raw: SQLiteAdapter, id: string, entity: string, deletedAt: number | null, sourceRef: string | null = null) {
  await raw.runAsync(
    `INSERT INTO ${P}entries (id, entity_id, title, body, source_ref, created_at, updated_at, deleted_at) VALUES (?, ?, 't', 'b', ?, 1, 1, ?)`,
    [id, entity, sourceRef, deletedAt],
  );
}
const count = async (raw: SQLiteAdapter, t: string) =>
  (await raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}${t}`))!.n;

describe('erase() prune core (spec §2 steps 0/1/1b)', () => {
  it('AC1: an unconfirmed external removal is held, not hard-deleted; erase continues and reports holds', async () => {
    const t = await make({ hook: (c) => { if (c.factId === 'a') throw new Error('nope'); } });
    for (const id of ['a', 'b']) await insEntry(t.raw, id, 'e1', 1);
    await insEntry(t.raw, 'z', 'e2', 1);

    const report = await svc(t.wiki).erase();

    const ids = (await t.raw.getAllAsync<{ id: string }>(`SELECT id FROM ${P}entries ORDER BY id`)).map((r) => r.id);
    expect(ids).toEqual(['a']);
    expect(report.holds).toHaveLength(1);
    expect(report.holds[0]).toMatchObject({ entityId: 'e1', failedAt: 'a', remaining: 1 });
    expect(report.verified).toBe(true);
  });

  it('AC2: events are never deleted and no event_retention_held diagnostic fires', async () => {
    const t = await make();
    await insEntry(t.raw, 'a', 'e1', 1);
    await t.raw.runAsync(
      `INSERT INTO ${P}events (id, entity_id, event_type, summary, created_at) VALUES ('ev', 'e1', 'observation', 's', 1000)`,
    );
    await svc(t.wiki).erase();
    expect(await count(t.raw, 'events')).toBe(1);
    expect(await count(t.raw, 'entries')).toBe(0);
    expect(t.diagnostics.some((d) => d.code === 'event_retention_held')).toBe(false);
  });

  it('AC3: a connection that refuses secure_delete=ON fails the erase as unverified (never a false success)', async () => {
    const real = openTestDatabase();
    const refusing: SQLiteAdapter = {
      ...real,
      getFirstAsync: (async (sql: string, args?: unknown[]) =>
        /^\s*PRAGMA\s+secure_delete\s*$/i.test(sql) ? { secure_delete: 0 } : real.getFirstAsync(sql, args)) as SQLiteAdapter['getFirstAsync'],
    };
    const t = await make({ raw: refusing });
    await insEntry(real, 'a', 'e1', 1);

    let err: any;
    try { await svc(t.wiki).erase(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('erase_secure_delete_off');
    expect(err.report.verified).toBe(false);
    expect(t.diagnostics.some((d) => d.code === 'erase_secure_delete_off')).toBe(true);
    expect(await count(real, 'entries')).toBe(1); // nothing pruned before the step-0 failure
  });

  it('step 0 re-asserts a flipped-OFF pragma, and the report carries pragma state and sqlite_version()', async () => {
    const t = await make();
    await t.raw.execAsync('PRAGMA secure_delete=OFF');
    const report = await svc(t.wiki).erase();
    expect(report.verified).toBe(true);
    expect(report.secureDelete).toBe(1);
    expect(typeof report.sqliteVersion).toBe('string');
    expect(report.sqliteVersion.length).toBeGreaterThan(0);
    expect((await t.raw.getFirstAsync<{ secure_delete: number }>('PRAGMA secure_delete'))!.secure_delete).toBe(1);
  });

  it('AC4: a task-only forget leaves an entity step 1 still enumerates; task rows are hard-deleted', async () => {
    const t = await make();
    await t.raw.runAsync(
      `INSERT INTO ${P}tasks (id, entity_id, description, created_at, updated_at, deleted_at) VALUES ('t1', 'only-tasks', 'zq7canary', 1, 1, 1)`,
    );
    expect(await count(t.raw, 'entries')).toBe(0);
    const report = await svc(t.wiki).erase();
    expect(await count(t.raw, 'tasks')).toBe(0);
    expect(report.entities).toContain('only-tasks');
  });

  it('AC5: forget({ sourceRef }) + erase leaves no source_ref_index row carrying the ref', async () => {
    const t = await make();
    await insEntry(t.raw, 'r1', 'ent', null, 'r.md');
    await t.raw.runAsync(
      `INSERT INTO ${P}source_ref_index (id, entity_id, source_hash, source_ref, created_at, deleted_at) VALUES ('sri1', 'ent', ?, 'r.md', 1, NULL)`,
      [H1],
    );
    await t.wiki.forget('ent', { sourceRef: 'r.md' });
    expect(await count(t.raw, 'source_ref_index')).toBe(1); // tombstoned, still in the file
    await svc(t.wiki).erase();
    expect(await count(t.raw, 'source_ref_index')).toBe(0);
  });

  it('AC5 variant: forget -> standalone runPrune -> erase still sweeps the tombstone (entity unenumerated)', async () => {
    const t = await make();
    await insEntry(t.raw, 'r1', 'ent', null, 'r.md');
    await t.raw.runAsync(
      `INSERT INTO ${P}source_ref_index (id, entity_id, source_hash, source_ref, created_at, deleted_at) VALUES ('sri1', 'ent', ?, 'r.md', 1, NULL)`,
      [H1],
    );
    await t.wiki.forget('ent', { sourceRef: 'r.md' });
    await t.wiki.runPrune('ent', { retainSoftDeletedFor: 0, retainEventsFor: null });
    expect(await count(t.raw, 'entries')).toBe(0);
    expect(await count(t.raw, 'source_ref_index')).toBe(1);

    const report = await svc(t.wiki).erase();
    expect(report.entities).not.toContain('ent');
    expect(await count(t.raw, 'source_ref_index')).toBe(0);
  });

  it('AC6: a hold and a successful delete in one erase — syncedIds is a superset of the deleted ids', async () => {
    const t = await make({ hook: (c) => { if (c.factId === 'a') throw new Error('nope'); } });
    for (const id of ['a', 'b']) await insEntry(t.raw, id, 'e1', 1);

    const report = await svc(t.wiki).erase();
    expect(report.holds).toHaveLength(1);
    expect(report.syncedIds).toContain('b');

    // The output param on runPrune is filled even when it throws PrunePartialFailureError.
    const t2 = await make({ hook: (c) => { if (c.factId === 'a') throw new Error('nope'); } });
    for (const id of ['a', 'b']) await insEntry(t2.raw, id, 'e1', 1);
    const syncedIds: string[] = [];
    await expect(t2.wiki.runPrune('e1', { retainSoftDeletedFor: 0, retainEventsFor: null, syncedIds } as any)).rejects.toThrow(/partially failed/);
    expect(syncedIds).toContain('b');
  });

  it('AC7: a pre-v9 store without source_ref_index skips step 1b with a diagnostic and erase proceeds', async () => {
    const raw = await openV8Database();
    await insertV8Entry(raw, { id: 'x1', entityId: 'ent', sourceRef: 'x.md', sourceHash: H1, updatedAt: 1 });
    await raw.runAsync(`UPDATE ${P}entries SET deleted_at = 1 WHERE id = 'x1'`);
    const diagnostics: WikiDiagnostic[] = [];
    const wiki = new WikiMemory(raw, { llmProvider: llm, onDiagnostic: (d) => { diagnostics.push(d); } });

    const report = await svc(wiki).erase();
    expect(await sourceRefIndexExists(raw)).toBe(false);
    expect(await count(raw, 'entries')).toBe(0);
    expect(report.registrySweep).toEqual({ skipped: true, deleted: 0 });
    expect(diagnostics.some((d) => d.code === 'erase_registry_sweep_skipped')).toBe(true);
  });
});
