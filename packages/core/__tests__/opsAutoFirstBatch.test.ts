/**
 * ops + maintenance 'auto': the first auto pass must extract the events that
 * triggered it (spec specs/ops-auto-first-batch).
 *
 * Before the fix, the trigger moved memory_checkpoint to the event count and
 * the first ops pass then seeded its watermark from that moved counter, past
 * every event it was supposed to read.
 */
import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { START_OF_LOG_WATERMARK } from '../src/repositories/MetadataRepository';

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
    // WriteService clamps checkpoint > count to 0 (e.g. after an import
    // replaced the log), so the anchor is the start-of-log marker and the
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
