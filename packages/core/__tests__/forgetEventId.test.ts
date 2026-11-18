/**
 * specs/forget-by-event-id — forget({ eventId }): soft-delete librarian facts
 * whose source_pointer names a given event id, entity-scoped, with the exact
 * removal contract every other forget selector uses. Acceptance tests 1-12 of
 * the spec (as renumbered in Draft v5).
 */
import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory, WikiExternalDeletionError } from '../src/index';

const P = 'llm_wiki_';
const llm = { generateText: async () => '{}' };
type Call = { entityId: string; factId: string; vector: unknown };

async function make(hook?: (c: Call) => Promise<void> | void) {
  const db = openTestDatabase();
  const calls: Call[] = [];
  const wiki = new WikiMemory(db, {
    llmProvider: llm,
    config: { enableOutbox: true },
    ...(hook
      ? {
          vectorRanker: {
            rankBySimilarity: async () => [],
            onEmbeddingPersisted: async (c: Call) => {
              calls.push(c);
              await hook(c);
            },
          },
        }
      : {}),
  } as any);
  await wiki.setup();
  /** Direct entry insert with an optional raw source_pointer column value. */
  const ins = async (entityId: string, id: string, pointer: string | null = null, ref = 'doc') =>
    db.runAsync(
      `INSERT INTO ${P}entries (id, entity_id, title, body, source_ref, source_pointer, created_at, updated_at) VALUES (?, ?, 't', 'b', ?, ?, 1, 1)`,
      [id, entityId, ref, pointer],
    );
  const live = async (id: string) =>
    (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries WHERE id = ? AND deleted_at IS NULL`, [id]))!.n;
  const livePointerMatches = async (entityId: string, eventId: string) =>
    (
      await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${P}entries WHERE entity_id = ? AND deleted_at IS NULL
         AND CASE WHEN json_valid(source_pointer) THEN json_type(source_pointer, '$.event_id') = 'text' AND json_extract(source_pointer, '$.event_id') = ? ELSE 0 END`,
        [entityId, eventId],
      )
    )!.n;
  const outboxDeletes = async (recordId?: string) =>
    (
      await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${P}outbox WHERE operation = 'DELETE' AND table_name = 'entries'${recordId ? ' AND record_id = ?' : ''}`,
        recordId ? [recordId] : [],
      )
    )!.n;
  return { db, wiki, calls, ins, live, livePointerMatches, outboxDeletes };
}

const VALID_POINTER = JSON.stringify({ event_id: 'E1', ref: 'doc-1', quote: 'q', position: { start: 0, length: 2 } });
const OTHER_POINTER = JSON.stringify({ event_id: 'E2', ref: 'doc-2', position: { start: 3, length: 4 } });
// Valid JSON that FAILS read-side validation: position numbers out of range.
const SHAPE_BROKEN_POINTER = JSON.stringify({ event_id: 'E1', position: { start: -1, length: 0 } });

describe('forget({ eventId }) — selection', () => {
  it('removes facts naming the event; other events and pointer-less facts untouched (test 1)', async () => {
    const t = await make();
    await t.ins('e1', 'a', VALID_POINTER);
    await t.ins('e1', 'b', OTHER_POINTER);
    await t.ins('e1', 'c', null);
    const res = await t.wiki.forget('e1', { eventId: 'E1' });
    expect(res.deleted.entries).toBe(1);
    expect(await t.live('a')).toBe(0);
    expect(await t.live('b')).toBe(1);
    expect(await t.live('c')).toBe(1);
  });

  it('entity isolation: another entity\'s fact naming the same event survives (test 2)', async () => {
    const t = await make();
    await t.ins('e1', 'a', VALID_POINTER);
    await t.ins('e2', 'z', VALID_POINTER);
    await t.wiki.forget('e1', { eventId: 'E1' });
    expect(await t.live('a')).toBe(0);
    expect(await t.live('z')).toBe(1);
  });

  it('no dangling pointers: zero live rows name the event after the call (test 3)', async () => {
    const t = await make();
    await t.ins('e1', 'a', VALID_POINTER);
    await t.ins('e1', 'a2', JSON.stringify({ event_id: 'E1' }));
    await t.wiki.forget('e1', { eventId: 'E1' });
    expect(await t.livePointerMatches('e1', 'E1')).toBe(0);
  });

  it('a shape-broken pointer that still names the event IS deleted; malformed JSON neither matches nor errors (tests 6-7)', async () => {
    const t = await make();
    await t.ins('e1', 'shape', SHAPE_BROKEN_POINTER);
    await t.ins('e1', 'corrupt', 'corrupted-text{{');
    await t.ins('e1', 'ok', VALID_POINTER);
    const res = await t.wiki.forget('e1', { eventId: 'E1' });
    expect(res.deleted.entries).toBe(2); // shape + ok; corrupt excluded, no throw
    expect(await t.live('shape')).toBe(0);
    expect(await t.live('ok')).toBe(0);
    expect(await t.live('corrupt')).toBe(1);
  });
});

describe('forget({ eventId }) — frozen surfaces (test 5)', () => {
  it('touches no source_ref_index row and no source_passages row', async () => {
    const t = await make();
    await t.ins('e1', 'a', VALID_POINTER, 'doc-1');
    await t.db.runAsync(
      `INSERT INTO ${P}source_ref_index (id, entity_id, source_hash, source_ref, created_at) VALUES ('r1', 'e1', ?, 'doc-1', 1)`,
      ['h'.padEnd(64, '0')],
    );
    await t.db.runAsync(
      `INSERT INTO ${P}source_documents (id, entity_id, source_ref, source_hash, text, text_hash, char_count, created_at)
       VALUES ('d1', 'e1', 'doc-1', ?, 'text', 'th', 10, 1)`,
      ['h'.padEnd(64, '0')],
    );
    await t.db.runAsync(
      `INSERT INTO ${P}source_passages (id, entity_id, document_id, seq, start_offset, end_offset)
       VALUES ('p1', 'e1', 'd1', 0, 0, 4)`,
    );
    const refsBefore = (await t.db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}source_ref_index`))!.n;
    const passagesBefore = (await t.db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}source_passages`))!.n;
    await t.wiki.forget('e1', { eventId: 'E1' });
    expect((await t.db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}source_ref_index`))!.n).toBe(refsBefore);
    expect((await t.db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}source_passages`))!.n).toBe(passagesBefore);
    // Events row untouched too (D4): the event the pointer names stays.
    expect((await t.db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}events WHERE entity_id = 'e1'`))!.n).toBe(0);
  });
});

describe('forget({ eventId }) — removal contract (tests 4, 10, 11)', () => {
  it('one outbox DELETE per changed row inside the call; none on the idempotent second call (test 11)', async () => {
    const t = await make();
    await t.ins('e1', 'a', VALID_POINTER);
    await t.ins('e1', 'b', VALID_POINTER);
    const before = await t.outboxDeletes();
    await t.wiki.forget('e1', { eventId: 'E1' });
    expect((await t.outboxDeletes()) - before).toBe(2);
    expect(await t.outboxDeletes('a')).toBe(1);
    expect(await t.outboxDeletes('b')).toBe(1);
    const res2 = await t.wiki.forget('e1', { eventId: 'E1' });
    expect(res2.deleted.entries).toBe(0); // tombstone idempotence (test 10)
    expect((await t.outboxDeletes()) - before).toBe(2); // no new outbox rows
  });

  it('unconfirmed vector removal raises WikiExternalDeletionError through the shared contract (test 4)', async () => {
    const t = await make((c) => {
      if (c.factId === 'a') throw new Error('nope');
    });
    await t.ins('e1', 'a', VALID_POINTER);
    await t.ins('e1', 'b', VALID_POINTER);
    let err: any;
    try {
      await t.wiki.forget('e1', { eventId: 'E1' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WikiExternalDeletionError);
    expect(err.unconfirmedIds).toEqual(['a']);
    expect(t.calls.map((c: Call) => c.factId).sort()).toEqual(['a', 'b']);
  });
});

describe('forget({ eventId }) — validation and exclusivity (test 9)', () => {
  it.each([
    [{ eventId: '' }, 'Invalid eventId'],
    [{ eventId: 42 as unknown as string }, 'Invalid eventId'],
    [{ eventId: 'E1', entryId: 'a' }, 'mutually exclusive'],
    [{ eventId: 'E1', sourceRef: 'doc' }, 'mutually exclusive'],
    [{ eventId: 'E1', sourceHash: 'h' }, 'mutually exclusive'],
    [{ eventId: 'E1', taskId: 't' }, 'mutually exclusive'],
    [{ eventId: 'E1', clearAll: true }, 'mutually exclusive'],
    [{ eventId: 'E1', includeChain: true }, 'composes only with entryId'],
  ])('rejects %j', async (params, fragment) => {
    const t = await make();
    await expect(t.wiki.forget('e1', params as any)).rejects.toThrow(fragment);
  });

  it('dry-run rejection message names eventId', async () => {
    const t = await make();
    await expect(t.wiki.forget('e1', { entryId: 'a' }, { dryRun: true })).rejects.toThrow(/eventId/);
  });
});

describe('forget({ eventId }) — dry run (test 12)', () => {
  it('reports the live count without mutating', async () => {
    const t = await make();
    await t.ins('e1', 'a', VALID_POINTER);
    await t.ins('e1', 'b', VALID_POINTER);
    await t.ins('e1', 'gone', JSON.stringify({ event_id: 'E1' }));
    await t.db.runAsync(`UPDATE ${P}entries SET deleted_at = 5 WHERE id = 'gone'`);
    const res = await t.wiki.forget('e1', { eventId: 'E1' }, { dryRun: true });
    expect(res).toEqual({ deleted: { entries: 2, tasks: 0 } });
    expect(await t.live('a')).toBe(1);
    expect(await t.live('b')).toBe(1);
    // The real call then reports tombstone idempotence for the pre-tombstoned row.
    const real = await t.wiki.forget('e1', { eventId: 'E1' });
    expect(real.deleted.entries).toBe(2);
  });
});

describe('forget({ eventId }) — JSON1 canary (test 8)', () => {
  it('the test adapters expose JSON1', async () => {
    const t = await make();
    const row = await t.db.getFirstAsync<{ ok: number }>(`SELECT json_valid('[]') AS ok`);
    expect(row?.ok).toBe(1);
    const ex = await t.db.getFirstAsync<{ v: string | null }>(`SELECT json_extract('{"a":"b"}', '$.a') AS v`);
    expect(ex?.v).toBe('b');
  });
});
