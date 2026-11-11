/**
 * ops + maintenance 'auto': the first auto pass must extract the events that
 * triggered it (spec specs/ops-auto-first-batch).
 *
 * Before the fix, the trigger moved memory_checkpoint to the event count and
 * the first ops pass then seeded its watermark from that moved counter, past
 * every event it was supposed to read.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { START_OF_LOG_WATERMARK } from '../src/repositories/MetadataRepository';
import { WikiBusyError } from '../src/types';

const ENTITY = 'u';
const embed = async (t: string) => [t.length % 7, (t.charCodeAt(0) || 1) % 5, 1, 0.5];

function scripted() {
  const extractPrompts: string[] = [];
  let failNext = 0;
  const generateText = async ({ systemPrompt, userPrompt }: { systemPrompt: string; userPrompt: string }) => {
    if (failNext > 0) {
      failNext -= 1;
      throw new Error('provider down');
    }
    if (/memory extraction agent/.test(systemPrompt)) {
      extractPrompts.push(userPrompt);
      const facts = [...userPrompt.matchAll(/^(e\d+) \[[^\]]+\] \([^)]+\) (.*)$/gm)].map((m) => ({
        title: m[2]!.slice(0, 60),
        body: m[2]!,
        tags: [],
        confidence: 'certain',
        source_event: m[1],
      }));
      return JSON.stringify({ facts, tasks: [] });
    }
    if (/reconciliation agent/.test(systemPrompt)) {
      const items = (JSON.parse(userPrompt.slice(userPrompt.indexOf('{'))) as { items: Array<{ item: number }> }).items;
      return JSON.stringify({ ops: items.map((i) => ({ item: i.item, op: 'ADD' })) });
    }
    return '{}';
  };
  return { extractPrompts, generateText, failNextCalls: (n: number) => { failNext = n; } };
}

function mk(config: Record<string, unknown>) {
  const db = openTestDatabase();
  const s = scripted();
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText: s.generateText, embed },
    config: { librarian: { strategy: 'ops' }, maintenance: 'auto', ...config },
  });
  return { db, wiki, ...s };
}

const summary = (i: number) => `Event number ${i} says the user likes topic ${i}`;

async function writeN(wiki: WikiMemory, from: number, to: number) {
  for (let i = from; i <= to; i++) {
    await wiki.write(ENTITY, { event_type: 'observation', summary: summary(i), occurred_at: 1_700_000_000_000 + i * 1000 });
    await wiki.drain();
  }
}

const meta = (wiki: WikiMemory) => (wiki.__testAccess as any).metadataRepo;

describe('ops + auto: first auto pass', () => {
  it('extracts the events that crossed the count threshold on a fresh entity', async () => {
    const { db, wiki, extractPrompts } = mk({ autoLibrarianThreshold: 5 });
    await wiki.setup();
    await writeN(wiki, 1, 5);
    expect(extractPrompts).toHaveLength(1);
    for (let i = 1; i <= 5; i++) expect(extractPrompts[0]).toContain(summary(i));
    const last = await db.getFirstAsync<{ id: string; created_at: number }>(
      `SELECT id, created_at FROM llm_wiki_events WHERE entity_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [ENTITY],
    );
    expect(await meta(wiki).getLibrarianWatermark(ENTITY)).toEqual({ at: last!.created_at, id: last!.id });
  });

  it('extracts the events that crossed the token threshold on a fresh entity', async () => {
    const { wiki, extractPrompts } = mk({ autoLibrarianThreshold: 1000, autoLibrarianTokenThreshold: 20 });
    await wiki.setup();
    await writeN(wiki, 1, 2);
    expect(extractPrompts).toHaveLength(1);
    expect(extractPrompts[0]).toContain(summary(1));
    expect(extractPrompts[0]).toContain(summary(2));
  });

  it('does not re-read events legacy already covered', async () => {
    const { db, wiki, extractPrompts } = mk({ autoLibrarianThreshold: 5 });
    await wiki.setup();
    for (let i = 1; i <= 3; i++) {
      await db.runAsync(
        `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES (?, ?, 'observation', ?, ?)`,
        [`evt_legacy_${i}`, ENTITY, summary(i), i],
      );
    }
    await meta(wiki).updateCheckpoint(ENTITY, { memory: 3 }, db);
    await writeN(wiki, 4, 8);
    expect(extractPrompts).toHaveLength(1);
    for (let i = 1; i <= 3; i++) expect(extractPrompts[0]).not.toContain(summary(i));
    for (let i = 4; i <= 8; i++) expect(extractPrompts[0]).toContain(summary(i));
  });

  it('token trigger with legacy history counts only events after the legacy checkpoint', async () => {
    // Anchoring must precede the token sum: with no watermark yet, the sum
    // would include events legacy already read and fire a pass early.
    const { db, wiki, extractPrompts } = mk({ autoLibrarianThreshold: 1000, autoLibrarianTokenThreshold: 30 });
    await wiki.setup();
    for (let i = 1; i <= 3; i++) {
      await db.runAsync(
        `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES (?, ?, 'observation', ?, ?)`,
        [`evt_legacy_${i}`, ENTITY, summary(i), i],
      );
    }
    await meta(wiki).updateCheckpoint(ENTITY, { memory: 3 }, db);
    await writeN(wiki, 4, 4); // ~12 tokens after the legacy checkpoint: below 30
    expect(extractPrompts).toHaveLength(0);
    await writeN(wiki, 5, 7); // now >= 30 tokens after the checkpoint
    expect(extractPrompts).toHaveLength(1);
    for (let i = 1; i <= 3; i++) expect(extractPrompts[0]).not.toContain(summary(i));
    expect(extractPrompts[0]).toContain(summary(4));
  });

  it('a memory_checkpoint above the event count is treated as no history (re-reads, never skips)', async () => {
    // WriteService clamps checkpoint > count to 0 (e.g. a checkpoint an
    // older version's prune left behind), so the anchor is the marker and the
    // first pass re-reads everything; the gate dedups what already exists.
    const { db, wiki, extractPrompts } = mk({ autoLibrarianThreshold: 5 });
    await wiki.setup();
    for (let i = 1; i <= 3; i++) {
      await db.runAsync(
        `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES (?, ?, 'observation', ?, ?)`,
        [`evt_legacy_${i}`, ENTITY, summary(i), i],
      );
    }
    await meta(wiki).updateCheckpoint(ENTITY, { memory: 50 }, db);
    await writeN(wiki, 4, 5);
    expect(extractPrompts).toHaveLength(1);
    for (let i = 1; i <= 5; i++) expect(extractPrompts[0]).toContain(summary(i));
  });

  it('a checkpoint one above the old log (equal to the new count) is drift too, on the token path', async () => {
    // 4 events, checkpoint 5: drift by one. The write makes count 5. Without
    // the >= clamp the anchor lands on offset 4, the new event, and skips it.
    const { db, wiki, extractPrompts } = mk({ autoLibrarianThreshold: 1000, autoLibrarianTokenThreshold: 5 });
    await wiki.setup();
    for (let i = 2; i <= 5; i++) {
      await db.runAsync(
        `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES (?, ?, 'observation', ?, ?)`,
        [`evt_legacy_${i}`, ENTITY, summary(i), i],
      );
    }
    await meta(wiki).updateCheckpoint(ENTITY, { memory: 5 }, db);
    await writeN(wiki, 6, 6);
    expect(extractPrompts.join('\n')).toContain(summary(6));
  });

  it('an explicit runLibrarian with a checkpoint above the event count re-reads, never skips', async () => {
    const { db, wiki, extractPrompts } = mk({ maintenance: 'deferred' });
    await wiki.setup();
    for (let i = 3; i <= 5; i++) {
      await db.runAsync(
        `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES (?, ?, 'observation', ?, ?)`,
        [`evt_legacy_${i}`, ENTITY, summary(i), i],
      );
    }
    await meta(wiki).updateCheckpoint(ENTITY, { memory: 5 }, db);
    await writeN(wiki, 6, 6);
    await wiki.runLibrarian(ENTITY);
    expect(extractPrompts.join('\n')).toContain(summary(6));
  });

  it('a failed first pass leaves the log re-readable from the start', async () => {
    const { db, wiki, extractPrompts, failNextCalls } = mk({ autoLibrarianThreshold: 5 });
    await wiki.setup();
    failNextCalls(1);
    await writeN(wiki, 1, 5);
    expect((await meta(wiki).getCheckpoint(ENTITY, db)).memory ?? 0).toBe(0);
    expect(await meta(wiki).getLibrarianWatermark(ENTITY)).toEqual(START_OF_LOG_WATERMARK);
    await writeN(wiki, 6, 6);
    expect(extractPrompts).toHaveLength(1);
    expect(extractPrompts[0]).toContain(summary(1));
  });
});

describe('ops + auto: token path failure', () => {
  it('a failed first token-triggered pass leaves the log re-readable from the start', async () => {
    const { db, wiki, extractPrompts, failNextCalls } = mk({ autoLibrarianThreshold: 1000, autoLibrarianTokenThreshold: 20 });
    await wiki.setup();
    failNextCalls(1);
    await writeN(wiki, 1, 2);
    expect((await meta(wiki).getCheckpoint(ENTITY, db)).memory ?? 0).toBe(0);
    expect(await meta(wiki).getLibrarianWatermark(ENTITY)).toEqual(START_OF_LOG_WATERMARK);
    await writeN(wiki, 3, 3);
    expect(extractPrompts).toHaveLength(1);
    expect(extractPrompts[0]).toContain(summary(1));
  });
});

describe('configurations the anchor must not touch', () => {
  it('ops + deferred: writes past the threshold set no watermark', async () => {
    const { wiki } = mk({ maintenance: 'deferred', autoLibrarianThreshold: 5, autoLibrarianTokenThreshold: 20 });
    await wiki.setup();
    await writeN(wiki, 1, 6);
    expect(await meta(wiki).getLibrarianWatermark(ENTITY)).toBeNull();
  });

  it('legacy + auto: the token path does not anchor', async () => {
    // Under ops, this below-threshold write would set the start-of-log
    // marker. Legacy passes advance the watermark themselves (spec §10.3),
    // so this write stays below both thresholds to isolate the anchor.
    const legacy = mk({ librarian: { strategy: 'legacy' }, autoLibrarianThreshold: 1000, autoLibrarianTokenThreshold: 10_000 });
    await legacy.wiki.setup();
    await writeN(legacy.wiki, 1, 1);
    expect(await meta(legacy.wiki).getLibrarianWatermark(ENTITY)).toBeNull();
    expect(legacy.extractPrompts).toHaveLength(0);

    const ops = mk({ autoLibrarianThreshold: 1000, autoLibrarianTokenThreshold: 10_000 });
    await ops.wiki.setup();
    await writeN(ops.wiki, 1, 1);
    expect(await meta(ops.wiki).getLibrarianWatermark(ENTITY)).toEqual(START_OF_LOG_WATERMARK);
  });
});

describe('prune keeps memory_checkpoint in step (spec §4)', () => {
  const OLD = 1; // far older than any retention cutoff
  const insert = async (db: ReturnType<typeof openTestDatabase>, i: number, at: number) =>
    db.runAsync(
      `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES (?, ?, 'observation', ?, ?)`,
      [`evt_${String(i).padStart(3, '0')}`, ENTITY, summary(i), at],
    );

  it('legacy prune lowers the checkpoint, so a later switch to ops reads every unread event', async () => {
    const db = openTestDatabase();
    const legacy = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}' },
      config: { librarian: { strategy: 'legacy' }, maintenance: 'auto', autoLibrarianThreshold: 5 },
    });
    await legacy.setup();
    const recent = Date.now() - 60_000;
    for (let i = 1; i <= 5; i++) await insert(db, i, OLD + i);
    for (let i = 6; i <= 20; i++) await insert(db, i, recent + i);
    await meta(legacy).updateCheckpoint(ENTITY, { memory: 20 }, db);

    const pruned = await legacy.runPrune(ENTITY, { retainEventsFor: 30 });
    expect(pruned.events).toBe(5);
    expect((await meta(legacy).getCheckpoint(ENTITY, db)).memory).toBe(15);

    const s = scripted();
    const ops = new WikiMemory(db, {
      llmProvider: { generateText: s.generateText, embed },
      config: { librarian: { strategy: 'ops' }, maintenance: 'auto', autoLibrarianThreshold: 5 },
    });
    await ops.setup();
    await writeN(ops, 21, 25);
    expect(s.extractPrompts).toHaveLength(1);
    for (let i = 6; i <= 20; i++) expect(s.extractPrompts[0]).not.toContain(summary(i));
    for (let i = 21; i <= 25; i++) expect(s.extractPrompts[0]).toContain(summary(i));
  });

  it('guarded prune under ops lowers the checkpoint by the number deleted', async () => {
    const { db, wiki } = mk({ autoLibrarianThreshold: 1000 });
    await wiki.setup();
    for (let i = 1; i <= 10; i++) await insert(db, i, OLD + i);
    await meta(wiki).updateCheckpoint(ENTITY, { memory: 10 }, db);
    await meta(wiki).setLibrarianWatermark(ENTITY, { at: OLD + 6, id: 'evt_006' }, db);
    const pruned = await wiki.runPrune(ENTITY, { retainEventsFor: 30 });
    expect(pruned.events).toBe(6);
    expect((await meta(wiki).getCheckpoint(ENTITY, db)).memory).toBe(4);
  });

  it('a guarded prune that deletes nothing leaves the checkpoint alone', async () => {
    // Deferred, no watermark yet: pruneThrough holds every event back.
    const { db, wiki } = mk({ maintenance: 'deferred' });
    await wiki.setup();
    for (let i = 1; i <= 5; i++) await insert(db, i, OLD + i);
    await meta(wiki).updateCheckpoint(ENTITY, { memory: 3 }, db);
    const pruned = await wiki.runPrune(ENTITY, { retainEventsFor: 30 });
    expect(pruned.events).toBe(0);
    expect((await meta(wiki).getCheckpoint(ENTITY, db)).memory).toBe(3);
  });

  it('a checkpoint below the number deleted floors at 0', async () => {
    const db = openTestDatabase();
    const legacy = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}' },
      config: { librarian: { strategy: 'legacy' }, maintenance: 'auto', autoLibrarianThreshold: 1000 },
    });
    await legacy.setup();
    for (let i = 1; i <= 5; i++) await insert(db, i, OLD + i);
    await meta(legacy).updateCheckpoint(ENTITY, { memory: 2 }, db);
    await legacy.runPrune(ENTITY, { retainEventsFor: 30 });
    expect((await meta(legacy).getCheckpoint(ENTITY, db)).memory).toBe(0);
  });

  it('prune lowers heal_checkpoint by the number deleted too', async () => {
    const db = openTestDatabase();
    const legacy = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}' },
      config: { librarian: { strategy: 'legacy' }, maintenance: 'auto', autoLibrarianThreshold: 1000 },
    });
    await legacy.setup();
    const recent = Date.now() - 60_000;
    for (let i = 1; i <= 5; i++) await insert(db, i, OLD + i);
    for (let i = 6; i <= 10; i++) await insert(db, i, recent + i);
    // heal 9 of 10; deleting 5 must leave it at 4, not above the new count
    // of 5, where it would read as 0 and start a full re-heal.
    await meta(legacy).updateCheckpoint(ENTITY, { memory: 10, heal: 9 }, db);
    await legacy.runPrune(ENTITY, { retainEventsFor: 30 });
    expect(await meta(legacy).getCheckpoint(ENTITY, db)).toEqual({ memory: 5, heal: 4 });
  });

  it('a heal_checkpoint below the number deleted floors at 0', async () => {
    const db = openTestDatabase();
    const legacy = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}' },
      config: { librarian: { strategy: 'legacy' }, maintenance: 'auto', autoLibrarianThreshold: 1000 },
    });
    await legacy.setup();
    for (let i = 1; i <= 5; i++) await insert(db, i, OLD + i);
    await meta(legacy).updateCheckpoint(ENTITY, { heal: 2 }, db);
    await legacy.runPrune(ENTITY, { retainEventsFor: 30 });
    const cp = await meta(legacy).getCheckpoint(ENTITY, db);
    expect(cp.heal).toBe(0);
    expect(cp.memory ?? 0).toBe(0);
  });
});

describe('ops + auto: trigger lock busy', () => {
  it('restores the checkpoint, keeps the anchor, and the next trigger reads from the start', async () => {
    const { db, wiki, extractPrompts } = mk({ autoLibrarianThreshold: 5 });
    await wiki.setup();
    const jm = (wiki.__testAccess as any).jobManager;
    const orig = jm.acquireLock.bind(jm);
    let busy = true;
    jm.acquireLock = (op: string, entityId: string, sourceRef?: string) => {
      if (op === 'librarian' && busy) {
        busy = false;
        throw new WikiBusyError('prune', entityId);
      }
      return orig(op, entityId, sourceRef);
    };
    await writeN(wiki, 1, 5);
    expect((await meta(wiki).getCheckpoint(ENTITY, db)).memory ?? 0).toBe(0);
    expect(await meta(wiki).getLibrarianWatermark(ENTITY)).toEqual(START_OF_LOG_WATERMARK);
    expect(extractPrompts).toHaveLength(0);
    await writeN(wiki, 6, 6);
    expect(extractPrompts).toHaveLength(1);
    for (let i = 1; i <= 6; i++) expect(extractPrompts[0]).toContain(summary(i));
  });
});

describe('created_at strictly increases per entity (spec §5)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('events written in the same millisecond stay after the watermark', async () => {
    // Frozen clock: without §5 every event shares one created_at, and with
    // random ids some later events sort behind the first pass's watermark.
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { db, wiki, extractPrompts } = mk({ maintenance: 'deferred' });
    await wiki.setup();
    await writeN(wiki, 1, 10);
    await wiki.runLibrarian(ENTITY);
    await writeN(wiki, 11, 30);
    await wiki.runLibrarian(ENTITY);
    const all = extractPrompts.join('\n');
    for (let i = 1; i <= 30; i++) expect(all).toContain(summary(i));
    const rows = await db.getAllAsync<{ created_at: number }>(
      `SELECT created_at FROM llm_wiki_events WHERE entity_id = ? ORDER BY created_at`,
      [ENTITY],
    );
    expect(new Set(rows.map((r) => r.created_at)).size).toBe(30);
  });

  it('a clock that steps back still stamps after the newest event', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { db, wiki } = mk({ autoLibrarianThreshold: 1000 });
    await wiki.setup();
    await writeN(wiki, 1, 1);
    now.mockReturnValue(1_799_999_000_000);
    await writeN(wiki, 2, 2);
    const rows = await db.getAllAsync<{ created_at: number }>(
      `SELECT created_at FROM llm_wiki_events WHERE entity_id = ? ORDER BY created_at`,
      [ENTITY],
    );
    expect(rows.map((r) => r.created_at)).toEqual([1_800_000_000_000, 1_800_000_000_001]);
  });

  it('refuses to stamp past Number.MAX_SAFE_INTEGER instead of tying', async () => {
    const { db, wiki } = mk({ autoLibrarianThreshold: 1000 });
    await wiki.setup();
    await db.runAsync(
      `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_max', ?, 'observation', 'imported', ?)`,
      [ENTITY, Number.MAX_SAFE_INTEGER],
    );
    await expect(wiki.write(ENTITY, { event_type: 'observation', summary: 'next' })).rejects.toThrow(RangeError);
    const n = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM llm_wiki_events WHERE entity_id = ?`, [ENTITY]);
    expect(n!.n).toBe(1);
  });
});

describe('start-of-log watermark marker', () => {
  it('reads like no watermark and prunes nothing', async () => {
    const { db, wiki } = mk({ autoLibrarianThreshold: 1000 });
    await wiki.setup();
    // Imported or OKF events can carry created_at <= 0 (pre-1970 dates);
    // the marker must still read exactly like no watermark.
    for (const [i, at] of [[1, -5_000], [2, 0], [3, 10], [4, 20]] as const) {
      await db.runAsync(
        `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES (?, ?, 'observation', ?, ?)`,
        [`evt_${i}`, ENTITY, summary(i), at],
      );
    }
    const ev = (wiki.__testAccess as any).eventRepo ?? (wiki.__testAccess as any).maintenanceService.eventRepo;
    const marker = START_OF_LOG_WATERMARK;
    expect((await ev.getAfter(ENTITY, null)).length).toBe(4);
    expect((await ev.getAfter(ENTITY, marker)).map((e: { id: string }) => e.id)).toEqual(
      (await ev.getAfter(ENTITY, null)).map((e: { id: string }) => e.id),
    );
    expect(await ev.countAfter(ENTITY, marker)).toBe(await ev.countAfter(ENTITY, null));
    expect(await ev.sumSummaryCharsAfter(ENTITY, marker)).toBe(await ev.sumSummaryCharsAfter(ENTITY, null));
    expect((await ev.pruneThrough(ENTITY, Number.MAX_SAFE_INTEGER, marker)).changes).toBe(0);
  });
});
