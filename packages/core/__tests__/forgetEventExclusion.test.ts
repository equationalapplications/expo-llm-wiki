/**
 * specs/forget-event-exclusion — events.forgotten_at: a forgotten event stops
 * being raw material. Test plan numbering follows the spec's §Test plan.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/WikiMemory';
import { EventRepository } from '../src/repositories/EventRepository';
import { formatOkfBundle } from '../src/utils/formatOkfBundle';
import type { SQLiteAdapter, WikiConfig, WikiDiagnostic } from '../src/types';

const P = 'llm_wiki_';
const DAY = 86_400_000;

type GenFn = (p: { systemPrompt: string; userPrompt: string }) => string | Promise<string>;

async function make(opts: { config?: WikiConfig; generateText?: GenFn; db?: SQLiteAdapter } = {}) {
  const db = opts.db ?? openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const generateText = vi.fn(opts.generateText ?? (async () => JSON.stringify({ facts: [], tasks: [] })));
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText },
    config: opts.config,
    onDiagnostic: (d: WikiDiagnostic) => { diagnostics.push(d); },
  } as any);
  await wiki.setup();
  const repo = new EventRepository(db, P);
  /** Insert events at fixed stamps; returns the ids (e.g. evt_1). */
  const seed = async (entityId: string, rows: Array<[string, string, number]>) => {
    for (const [id, summary, at] of rows) {
      await db.runAsync(
        `INSERT INTO ${P}events (id, entity_id, event_type, summary, created_at) VALUES (?, ?, 'observation', ?, ?)`,
        [id, entityId, summary, at],
      );
    }
  };
  const forgottenAt = async (id: string) =>
    (await db.getFirstAsync<{ f: number | null }>(`SELECT forgotten_at AS f FROM ${P}events WHERE id = ?`, [id]))?.f;
  const exists = async (id: string) =>
    ((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}events WHERE id = ?`, [id]))!.n) > 0;
  const wm = async (e: string) => (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark(e);
  const prompts = () => generateText.mock.calls.map((c) => `${c[0].systemPrompt}\n${c[0].userPrompt}`).join('\n----\n');
  return { db, wiki, repo, diagnostics, generateText, seed, forgottenAt, exists, wm, prompts };
}

describe('test 2-3: forget({ eventId }) marks the event row', () => {
  it('marks only the named event; second call reports 0; other entity and pruned ids change nothing', async () => {
    const t = await make();
    await t.seed('u', [['E1', 'one', 10], ['E2', 'two', 20]]);
    await t.seed('v', [['V1', 'other', 30]]);
    const r1 = await t.wiki.forget('u', { eventId: 'E1' });
    expect(r1.deleted).toEqual({ entries: 0, tasks: 0, events: 1 });
    expect(typeof (await t.forgottenAt('E1'))).toBe('number');
    expect(await t.forgottenAt('E2')).toBeNull();
    const first = await t.forgottenAt('E1');
    expect((await t.wiki.forget('u', { eventId: 'E1' })).deleted.events).toBe(0);
    expect(await t.forgottenAt('E1')).toBe(first);
    // rule 3: V1 belongs to another entity
    expect((await t.wiki.forget('u', { eventId: 'V1' })).deleted.events).toBe(0);
    expect(await t.forgottenAt('V1')).toBeNull();
    // pruned / unknown id: nothing to mark, the fact side still runs
    await t.db.runAsync(
      `INSERT INTO ${P}entries (id, entity_id, title, body, source_pointer, created_at, updated_at) VALUES ('f1','u','t','b',?,1,1)`,
      [JSON.stringify({ event_id: 'GONE' })],
    );
    const r = await t.wiki.forget('u', { eventId: 'GONE' });
    expect(r.deleted).toEqual({ entries: 1, tasks: 0, events: 0 });
  });

  it('dry run reports events 1 before and 0 after, and mutates nothing', async () => {
    const t = await make();
    await t.seed('u', [['E1', 'one', 10]]);
    expect((await t.wiki.forget('u', { eventId: 'E1' }, { dryRun: true })).deleted.events).toBe(1);
    expect(await t.forgottenAt('E1')).toBeNull();
    await t.wiki.forget('u', { eventId: 'E1' });
    expect((await t.wiki.forget('u', { eventId: 'E1' }, { dryRun: true })).deleted.events).toBe(0);
  });
});

describe('test 11: in-process lock', () => {
  it('forget({ eventId }) during a pass throws WikiBusyError naming librarian', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const began = new Promise<void>((r) => { started = r; });
    const t = await make({ generateText: async () => { started(); await gate; return JSON.stringify({ facts: [], tasks: [] }); } });
    await t.seed('u', [['E1', 'one', 10]]);
    const pass = t.wiki.runLibrarian('u');
    await began;
    await expect(t.wiki.forget('u', { eventId: 'E1' })).rejects.toMatchObject({ name: 'WikiBusyError' });
    release();
    await pass;
  });
});

describe('tests 4-6: ops exclusion end to end', () => {
  it('test 4: a forgotten event ahead of the watermark is never sent to the model and yields no fact', async () => {
    const t = await make({
      generateText: async () => JSON.stringify({ facts: [{ title: 'Likes tea', body: 'drinks tea daily', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] }),
    });
    await t.seed('u', [['E1', 'SECRETSUMMARY alpha', 10], ['E2', 'live beta', 20]]);
    await t.wiki.forget('u', { eventId: 'E1' });
    await t.wiki.runLibrarian('u');
    expect(t.prompts()).not.toContain('SECRETSUMMARY');
    expect(t.prompts()).toContain('live beta');
    const rows = await t.db.getAllAsync<{ source_pointer: string | null; derived_events: string | null }>(`SELECT source_pointer, derived_events FROM ${P}entries`);
    for (const r of rows) {
      expect(`${r.source_pointer}${r.derived_events}`).not.toContain('E1');
    }
  });

  it('test 5: mixed batch carries E1 and E3 only; the watermark lands on E3', async () => {
    const t = await make();
    await t.seed('u', [['E1', 'live-one', 10], ['E2', 'FORGOTTEN-two', 20], ['E3', 'live-three', 30]]);
    await t.wiki.forget('u', { eventId: 'E2' });
    await t.wiki.runLibrarian('u');
    const p = t.prompts();
    expect(p).toContain('live-one');
    expect(p).toContain('live-three');
    expect(p).not.toContain('FORGOTTEN-two');
    expect(await t.wm('u')).toEqual({ at: 30, id: 'E3' });
  });

  it('test 6: an all-forgotten tail makes no model call, reports no pending events and terminates', async () => {
    const t = await make();
    await t.seed('u', [['E1', 'a', 10], ['E2', 'b', 20]]);
    await t.wiki.forget('u', { eventId: 'E1' });
    await t.wiki.forget('u', { eventId: 'E2' });
    const pending = await t.wiki.getPendingMaintenance(['u']);
    expect(pending.filter((p) => p.pendingEvents > 0)).toEqual([]);
    const r = await t.wiki.runPendingMaintenance();
    expect(t.generateText).not.toHaveBeenCalled();
    expect(r.perEntity.every((e) => e.librarianPasses === 0 || e.factsWritten === 0)).toBe(true);
    expect(r.tokensUsed).toBe(0);
  });
});

describe('test 7: legacy strategy', () => {
  it('getRecent(50) omits the forgotten event; the legacy pass never sends it', async () => {
    const t = await make({ config: { librarian: { strategy: 'legacy' }, maintenance: 'auto', autoLibrarianThreshold: 1000 } as any });
    await t.seed('u', [['E1', 'LEGACYSECRET', 10], ['E2', 'legacy live', 20]]);
    await t.wiki.forget('u', { eventId: 'E1' });
    expect((await t.repo.getRecent('u', 50)).map((e) => e.id)).toEqual(['E2']);
    await t.wiki.runLibrarian('u');
    expect(t.prompts()).not.toContain('LEGACYSECRET');
    expect(t.prompts()).toContain('legacy live');
  });
});

describe('test 8: heal context and read() bundles', () => {
  it('read() single and multi-entity omit the forgotten event', async () => {
    const t = await make();
    await t.seed('u', [['E1', 'READSECRET', 10], ['E2', 'read live', 20]]);
    await t.seed('v', [['V1', 'multi live', 30]]);
    await t.wiki.forget('u', { eventId: 'E1' });
    const single = await t.wiki.read('u', 'q');
    expect(JSON.stringify(single)).not.toContain('READSECRET');
    expect(JSON.stringify(single)).toContain('read live');
    const multi = await t.wiki.read(['u', 'v'], 'q');
    expect(JSON.stringify(multi)).not.toContain('READSECRET');
    expect(JSON.stringify(multi)).toContain('multi live');
  });

  it('the repository getRecent used for the heal prompt skips forgotten rows', async () => {
    const t = await make();
    await t.seed('u', [['E1', 'HEALSECRET', 10], ['E2', 'heal live', 20]]);
    await t.wiki.forget('u', { eventId: 'E1' });
    expect((await t.repo.getRecent('u', 20)).map((e) => e.summary)).toEqual(['heal live']);
  });
});

describe('test 9: counts filter; positional reads do not', () => {
  it('countAfter, sumSummaryCharsAfter, countHeldBack exclude the row; count, getAtOffset, latestCreatedAt include it', async () => {
    const t = await make();
    await t.seed('u', [['E1', 'aaaa', 10], ['E2', 'bb', 20]]);
    await t.wiki.forget('u', { eventId: 'E2' });
    expect(await t.repo.countAfter('u', null)).toBe(1);
    expect(await t.repo.sumSummaryCharsAfter('u', null)).toBe(4);
    expect(await t.repo.countHeldBack('u', 1000, null)).toBe(1);
    expect(await t.repo.count('u')).toBe(2);
    expect((await t.repo.getAtOffset('u', 1))?.id).toBe('E2');
    expect(await t.repo.latestCreatedAt('u')).toBe(20);
  });

  it('event_retention_held.count excludes a forgotten row', async () => {
    const old = Date.now() - 40 * DAY;
    const t = await make({ config: { maintenance: 'deferred' } });
    await t.seed('u', [['evt_1', 'x', old], ['evt_2', 'y', old + 1], ['evt_3', 'z', old + 2]]);
    await (t.wiki.__testAccess as any).metadataRepo.setLibrarianWatermark('u', { at: old, id: 'evt_1' }, t.db);
    await t.wiki.forget('u', { eventId: 'evt_3' });
    await t.wiki.runPrune('u', { retainSoftDeletedFor: null } as any);
    const held = t.diagnostics.filter((d) => d.code === 'event_retention_held');
    expect(held[0]).toMatchObject({ detail: { count: 1 } });
  });
});

describe('test 10: apply-time re-check, gone vs forgotten', () => {
  const CAND = { title: 'User is a senior engineer at Acme', body: 'Staff engineer since 2020', tags: [], confidence: 'certain', source_event: 'e1' };
  async function run(mutate: (db: SQLiteAdapter) => Promise<void>) {
    let t!: Awaited<ReturnType<typeof make>>;
    t = await make({
      generateText: async () => {
        await mutate(t.db);
        return JSON.stringify({ facts: [CAND], tasks: [] });
      },
    });
    await t.seed('u', [['evt_1', 'promoted', 100]]);
    await t.wiki.runLibrarian('u');
    return t;
  }
  it('host SQL marking the event forgotten mid-pass drops the candidate with reason forgotten; the watermark advances', async () => {
    const t = await run((db) => db.runAsync(`UPDATE ${P}events SET forgotten_at = 5 WHERE id = 'evt_1'`).then(() => undefined));
    expect((await t.db.getAllAsync(`SELECT id FROM ${P}entries`)).length).toBe(0);
    const d = t.diagnostics.filter((x) => x.code === 'source_event_gone');
    expect(d).toHaveLength(1);
    expect((d[0] as any).detail).toEqual({ itemIndex: 0, sourceRef: 'evt_1', reason: 'forgotten' });
    expect(await t.wm('u')).toEqual({ at: 100, id: 'evt_1' });
  });
  it('a deleted event carries reason gone', async () => {
    const t = await run((db) => db.runAsync(`DELETE FROM ${P}events WHERE id = 'evt_1'`).then(() => undefined));
    const d = t.diagnostics.filter((x) => x.code === 'source_event_gone');
    expect((d[0] as any).detail).toEqual({ itemIndex: 0, sourceRef: 'evt_1', reason: 'gone' });
  });
});

describe('test 12: prune hard-deletes forgotten events', () => {
  it('older than retainSoftDeletedFor: deleted regardless of watermark and retainEventsFor; younger kept; counted; checkpoints lowered; no model call', async () => {
    const t = await make({ config: { librarian: { strategy: 'ops' }, maintenance: 'deferred' } });
    const now = Date.now();
    await t.seed('u', [['E1', 'a', now - 100], ['E2', 'b', now - 90], ['E3', 'c', now - 80]]);
    await t.db.runAsync(`UPDATE ${P}events SET forgotten_at = ? WHERE id = 'E1'`, [now - 10 * DAY]);
    await t.db.runAsync(`UPDATE ${P}events SET forgotten_at = ? WHERE id = 'E2'`, [now - 1 * DAY]);
    await (t.wiki.__testAccess as any).metadataRepo.updateCheckpoint('u', { memory: 3, heal: 3 }, t.db);
    const r = await t.wiki.runPrune('u', { retainEventsFor: null });
    expect(r.events).toBe(1);
    expect(await t.exists('E1')).toBe(false);
    expect(await t.exists('E2')).toBe(true);
    expect(await t.exists('E3')).toBe(true);
    const cp = await (t.wiki.__testAccess as any).metadataRepo.getCheckpoint('u');
    expect(cp.memory).toBe(2);
    expect(cp.heal).toBe(2);
    expect(t.generateText).not.toHaveBeenCalled();
  });

  it('legacy mode: a log whose every event is forgotten (some pruned, some young) costs no model call', async () => {
    const t = await make({ config: { librarian: { strategy: 'legacy' }, maintenance: 'auto', autoLibrarianThreshold: 2 } as any });
    const now = Date.now();
    await t.seed('u', [['E1', 'a', now - 100], ['E2', 'b', now - 90]]);
    await t.db.runAsync(`UPDATE ${P}events SET forgotten_at = ? WHERE id = 'E1'`, [now - 10 * DAY]);
    await t.db.runAsync(`UPDATE ${P}events SET forgotten_at = ? WHERE id = 'E2'`, [now - 1 * DAY]);
    await (t.wiki.__testAccess as any).metadataRepo.updateCheckpoint('u', { memory: 2, heal: 2 }, t.db);
    const r = await t.wiki.runPrune('u', { retainEventsFor: null });
    expect(r.events).toBe(1);
    const cp = await (t.wiki.__testAccess as any).metadataRepo.getCheckpoint('u');
    expect(cp).toMatchObject({ memory: 1, heal: 1 });
    await t.wiki.runLibrarian('u');
    expect(t.generateText).not.toHaveBeenCalled();
  });

  it('a TEXT-valued forgotten_at survives runPrune and is removed by erase()', async () => {
    const t = await make();
    await t.seed('u', [['E1', 'a', 10]]);
    await t.db.runAsync(`UPDATE ${P}events SET forgotten_at = 'not-a-number' WHERE id = 'E1'`);
    await t.wiki.runPrune('u');
    expect(await t.exists('E1')).toBe(true);
    const report = await t.wiki.erase();
    expect(report.verified).toBe(true);
    expect(await t.exists('E1')).toBe(false);
  });
});

// ---- test 13: erase and the canary ----------------------------------------

const CANARY = 'zxq7f3a9k';
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('test 13: erase takes a forgotten event to gone', () => {
  it('canary: the forgotten event text is absent from the whole file after erase', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forget-event-canary-'));
    dirs.push(dir);
    const path = join(dir, 'w.db');
    const raw = openTestDatabase(path);
    await raw.execAsync('PRAGMA journal_mode=WAL');
    const wiki = new WikiMemory(raw, { llmProvider: { generateText: async () => '{}' } } as any);
    await wiki.setup();
    await wiki.write('e1', { event_type: 'observation', summary: `${CANARY} event text the host asked to forget` });
    const ev = await raw.getFirstAsync<{ id: string }>(`SELECT id FROM ${P}events WHERE entity_id = 'e1'`);
    for (let i = 0; i < 50; i++) await wiki.write('e1', { event_type: 'observation', summary: `innocuous filler event ${i}` });
    await raw.execAsync('PRAGMA wal_checkpoint(TRUNCATE)');
    const has = () => ['', '-wal', '-journal', '-shm'].some((s) => existsSync(path + s) && readFileSync(path + s).includes(CANARY));
    expect(has()).toBe(true);
    expect((await wiki.forget('e1', { eventId: ev!.id })).deleted.events).toBe(1);
    const report = await wiki.erase();
    expect(report.verified).toBe(true);
    expect(await raw.getFirstAsync(`SELECT id FROM ${P}events WHERE id = ?`, [ev!.id])).toBeFalsy();
    expect(has()).toBe(false);
    // unforgotten events are kept by erase
    expect((await raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}events`))!.n).toBe(50);
    await raw.closeAsync();
  }, 60_000);

  it('a store whose only tombstone is one forgotten event is walked and the gate passes', async () => {
    const t = await make();
    await t.seed('only', [['E1', 'x', 10]]);
    await t.wiki.forget('only', { eventId: 'E1' });
    const report = await t.wiki.erase();
    expect(report.verified).toBe(true);
    expect(await t.exists('E1')).toBe(false);
  });

  it('the step-9 gate counts forgotten events: with the prune delete disabled erase fails honestly', async () => {
    const t = await make();
    await t.seed('only', [['E1', 'x', 10]]);
    await t.wiki.forget('only', { eventId: 'E1' });
    const spy = vi.spyOn(EventRepository.prototype, 'deleteForgotten').mockResolvedValue({ changes: 0 });
    try {
      await expect(t.wiki.erase()).rejects.toMatchObject({ code: 'erase_tombstones_remaining' });
    } finally {
      spy.mockRestore();
    }
    expect(t.diagnostics.some((d) => d.code === 'erase_tombstones_remaining')).toBe(true);
  });
});

describe('test 14: export and import', () => {
  it('a dump omits the forgotten event unless includeForgotten; the backup carries the marker', async () => {
    const t = await make();
    await t.seed('u', [['E1', 'one', 10], ['E2', 'two', 20]]);
    await t.wiki.forget('u', { eventId: 'E1' });
    const plain = await t.wiki.exportDump(['u']);
    expect(JSON.stringify(plain)).not.toContain('"one"');
    const full = await t.wiki.exportDump(['u'], { includeForgotten: true });
    const ev = JSON.stringify(full);
    expect(ev).toContain('forgotten_at');
    // fresh store: marked row inserted, librarian never reads it
    const t2 = await make();
    await t2.wiki.importDump(full);
    expect(typeof (await t2.forgottenAt('E1'))).toBe('number');
    await t2.wiki.runLibrarian('u');
    expect(t2.prompts()).not.toContain('one');
  });

  it('tombstone-wins: a forgotten dump event marks a live local row; a live dump event never clears a marker', async () => {
    const src = await make();
    await src.seed('u', [['E1', 'one', 10]]);
    await src.wiki.forget('u', { eventId: 'E1' });
    const forgottenDump = await src.wiki.exportDump(['u'], { includeForgotten: true });

    const live = await make();
    await live.seed('u', [['E1', 'one', 10]]);
    await live.wiki.importDump(forgottenDump, { merge: true });
    expect(typeof (await live.forgottenAt('E1'))).toBe('number');

    const liveDump = await (async () => {
      const s = await make();
      await s.seed('u', [['E1', 'one', 10]]);
      return s.wiki.exportDump(['u']);
    })();
    const local = await make();
    await local.seed('u', [['E1', 'one', 10]]);
    await local.wiki.forget('u', { eventId: 'E1' });
    const marker = await local.forgottenAt('E1');
    await local.wiki.importDump(liveDump, { merge: true });
    expect(await local.forgottenAt('E1')).toBe(marker);
  });
});

describe('test 15: OKF log', () => {
  it('omits a forgotten event; a live log is unchanged by the filter', async () => {
    const t = await make();
    await t.seed('u', [['E1', 'OKFSECRET one', 10], ['E2', 'okf live two', 20]]);
    const live = await t.wiki.exportDump(['u']);
    const baseline = JSON.stringify(formatOkfBundle(live as any));
    expect(baseline).toContain('OKFSECRET');
    const full = await t.wiki.exportDump(['u'], { includeForgotten: true });
    await t.wiki.forget('u', { eventId: 'E1' });
    const forgottenDump = await t.wiki.exportDump(['u'], { includeForgotten: true });
    const out = JSON.stringify(formatOkfBundle(forgottenDump as any));
    expect(out).not.toContain('OKFSECRET');
    expect(out).toContain('okf live two');
    expect(full).toBeTruthy();
  });
});

describe('test 16: includeEvents wipe', () => {
  it('deletes forgotten and live rows and its dry run counts both', async () => {
    const t = await make();
    await t.seed('u', [['E1', 'one', 10], ['E2', 'two', 20]]);
    await t.wiki.forget('u', { eventId: 'E1' });
    const dry = await t.wiki.forget('u', { clearAll: true, includeEvents: true }, { dryRun: true });
    expect(dry.deleted.events).toBe(2);
    const r = await t.wiki.forget('u', { clearAll: true, includeEvents: true });
    expect(r.deleted.events).toBe(2);
    expect(await t.repo.count('u')).toBe(0);
  });
});

describe('test 17: public surface and live mapping', () => {
  it('a live event never carries forgotten_at; a forgotten one does when included', async () => {
    const t = await make();
    await t.seed('u', [['E1', 'one', 10], ['E2', 'two', 20]]);
    await t.wiki.forget('u', { eventId: 'E2' });
    const live = await t.repo.getByEntityId('u');
    expect(live.map((e) => e.id)).toEqual(['E1']);
    expect('forgotten_at' in live[0]).toBe(false);
    const all = await t.repo.getByEntityId('u', undefined, { includeDeleted: true });
    expect(all.find((e) => e.id === 'E2')!.forgotten_at).toEqual(expect.any(Number));
  });
});


describe('exact checkpoint decrement in prune (riskiest part)', () => {
  async function setup(forgottenIds: string[], cp: { memory: number; heal: number }, wmStrategy = 'legacy') {
    const t = await make({ config: { librarian: { strategy: wmStrategy }, maintenance: 'auto', autoLibrarianThreshold: 1000 } as any });
    const now = Date.now();
    await t.seed('u', [['E1', 'a', now - 500], ['E2', 'b', now - 400], ['E3', 'c', now - 300], ['E4', 'd', now - 200]]);
    for (const id of forgottenIds) await t.db.runAsync(`UPDATE ${P}events SET forgotten_at = ? WHERE id = ?`, [now - 10 * DAY, id]);
    const md = (t.wiki.__testAccess as any).metadataRepo;
    await md.updateCheckpoint('u', cp, t.db);
    return { t, md };
  }
  it('forgotten row in the tail, checkpoint in the prefix: no decrement', async () => {
    const { t, md } = await setup(['E4'], { memory: 2, heal: 2 });
    expect((await t.wiki.runPrune('u', { retainEventsFor: null })).events).toBe(1);
    expect(await md.getCheckpoint('u')).toMatchObject({ memory: 2, heal: 2 });
    expect(t.generateText).not.toHaveBeenCalled();
  });
  it('rows straddling the checkpoint: only the prefix ones count, each checkpoint on its own', async () => {
    const { t, md } = await setup(['E1', 'E3'], { memory: 2, heal: 4 });
    await t.wiki.runPrune('u', { retainEventsFor: null });
    expect(await md.getCheckpoint('u')).toMatchObject({ memory: 1, heal: 2 });
  });
  it('clamps at 0', async () => {
    const { t, md } = await setup(['E1', 'E2', 'E3'], { memory: 3, heal: 1 });
    await t.wiki.runPrune('u', { retainEventsFor: null });
    expect(await md.getCheckpoint('u')).toMatchObject({ memory: 0, heal: 0 });
    expect(t.generateText).not.toHaveBeenCalled();
  });
});

describe('never-migrated pre-v19 store (#316 recovery)', () => {
  it('forget({ eventId }) still soft-deletes facts, writes no marker and reports events 0; dry run too', async () => {
    const t = await make();
    await t.db.runAsync(
      `INSERT INTO ${P}entries (id, entity_id, title, body, source_pointer, created_at, updated_at) VALUES ('f1','u','t','b',?,1,1)`,
      [JSON.stringify({ event_id: 'E1' })],
    );
    await t.seed('u', [['E1', 'x', 10]]);
    await t.db.execAsync(`DROP INDEX IF EXISTS ${P}events_forgotten_idx`);
    await t.db.execAsync(`ALTER TABLE ${P}events DROP COLUMN forgotten_at`);
    await t.db.runAsync(`UPDATE ${P}meta SET value = '18' WHERE key = 'schema_version'`);
    expect((await t.wiki.forget('u', { eventId: 'E1' }, { dryRun: true })).deleted).toEqual({ entries: 1, tasks: 0, events: 0 });
    const r = await t.wiki.forget('u', { eventId: 'E1' });
    expect(r.deleted).toEqual({ entries: 1, tasks: 0, events: 0 });
    expect((await t.db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries WHERE deleted_at IS NOT NULL`))!.n).toBe(1);
  });
});
