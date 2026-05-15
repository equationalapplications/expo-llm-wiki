import { describe, it, expect, beforeEach } from 'vitest';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import { setupDatabase } from '../../src/db/schema';
import { EventRepository } from '../../src/repositories/EventRepository';
import type { WikiEvent } from '../../src/types';

const PREFIX = 'llm_wiki_';

function makeEvent(overrides?: Partial<WikiEvent>): WikiEvent {
  return {
    id: 'evt_' + Math.random().toString(36).slice(2),
    entity_id: 'entity1',
    event_type: 'observation',
    summary: 'Something happened',
    related_entry_id: null,
    created_at: Date.now(),
    ...overrides,
  };
}

describe('EventRepository', () => {
  let db: ReturnType<typeof openTestDatabase>;
  let repo: EventRepository;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    repo = new EventRepository(db, PREFIX);
  });

  it('add() inserts event with all columns', async () => {
    const event = makeEvent({
      id: 'evt_1',
      entity_id: 'entity_a',
      event_type: 'decision',
      summary: 'Decided to proceed',
      related_entry_id: 'fact_42',
      created_at: 1000,
    });

    await repo.add(event);

    const rows = await db.getAllAsync<any>(`SELECT * FROM ${PREFIX}events WHERE id = 'evt_1'`);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.id).toBe('evt_1');
    expect(row.entity_id).toBe('entity_a');
    expect(row.event_type).toBe('decision');
    expect(row.summary).toBe('Decided to proceed');
    expect(row.related_entry_id).toBe('fact_42');
    expect(Number(row.created_at)).toBe(1000);
  });

  it('getRecent() returns events in DESC order scoped to entityId', async () => {
    const base = 1_000_000;
    await repo.add(makeEvent({ id: 'evt_a', entity_id: 'entity1', created_at: base + 100 }));
    await repo.add(makeEvent({ id: 'evt_b', entity_id: 'entity1', created_at: base + 200 }));
    await repo.add(makeEvent({ id: 'evt_c', entity_id: 'entity1', created_at: base + 300 }));
    // Different entity — must not appear.
    await repo.add(makeEvent({ id: 'evt_other', entity_id: 'entity2', created_at: base + 400 }));

    const events = await repo.getRecent('entity1');
    expect(events.map(e => e.id)).toEqual(['evt_c', 'evt_b', 'evt_a']);
    // Confirm the other entity's event is absent.
    expect(events.every(e => e.entity_id === 'entity1')).toBe(true);
  });

  it('getRecent() respects the limit parameter', async () => {
    const base = 2_000_000;
    for (let i = 0; i < 5; i++) {
      await repo.add(makeEvent({ id: `evt_lim_${i}`, entity_id: 'entity1', created_at: base + i }));
    }

    const events = await repo.getRecent('entity1', 3);
    expect(events.length).toBe(3);
  });

  it('getRecent() defaults to limit 50', async () => {
    const base = 3_000_000;
    for (let i = 0; i < 60; i++) {
      await repo.add(makeEvent({ id: `evt_def_${i}`, entity_id: 'entity1', created_at: base + i }));
    }

    const events = await repo.getRecent('entity1');
    expect(events.length).toBe(50);
  });

  it('getRecentForEntities() returns events across multiple entities in DESC order', async () => {
    const base = 6_000_000;
    await repo.add(makeEvent({ id: 'evt_e1_a', entity_id: 'entity1', created_at: base + 10 }));
    await repo.add(makeEvent({ id: 'evt_e2_a', entity_id: 'entity2', created_at: base + 20 }));
    await repo.add(makeEvent({ id: 'evt_e1_b', entity_id: 'entity1', created_at: base + 30 }));
    await repo.add(makeEvent({ id: 'evt_e2_b', entity_id: 'entity2', created_at: base + 40 }));

    const events = await repo.getRecentForEntities(['entity2', 'entity1'], 3);
    expect(events.map(e => e.id)).toEqual(['evt_e2_b', 'evt_e1_b', 'evt_e2_a']);
    expect(events.every(e => ['entity1', 'entity2'].includes(e.entity_id))).toBe(true);
  });

  it('getRecentForEntities() returns an empty array when no entity IDs are provided', async () => {
    const events = await repo.getRecentForEntities([], 5);
    expect(events).toEqual([]);
  });

  it('prune() deletes events at or before cutoff and returns changes count', async () => {
    const base = 4_000_000;
    await repo.add(makeEvent({ id: 'evt_old1', entity_id: 'entity1', created_at: base + 1 }));
    await repo.add(makeEvent({ id: 'evt_old2', entity_id: 'entity1', created_at: base + 2 }));
    await repo.add(makeEvent({ id: 'evt_edge', entity_id: 'entity1', created_at: base + 3 }));
    await repo.add(makeEvent({ id: 'evt_new',  entity_id: 'entity1', created_at: base + 4 }));

    // Cutoff is inclusive: events at base+1, base+2, base+3 should be deleted.
    const result = await repo.prune('entity1', base + 3);
    expect(result.changes).toBe(3);

    const remaining = await repo.getRecent('entity1');
    expect(remaining.map(e => e.id)).toEqual(['evt_new']);
  });

  it('prune() is scoped to entityId — does not delete other entities rows', async () => {
    const base = 5_000_000;
    await repo.add(makeEvent({ id: 'evt_e1', entity_id: 'entity1', created_at: base + 1 }));
    await repo.add(makeEvent({ id: 'evt_e2', entity_id: 'entity2', created_at: base + 1 }));

    const result = await repo.prune('entity1', base + 100);
    expect(result.changes).toBe(1);

    const e2Events = await repo.getRecent('entity2');
    expect(e2Events.length).toBe(1);
    expect(e2Events[0].id).toBe('evt_e2');
  });

  it('count() returns the correct number of events for an entity', async () => {
    expect(await repo.count('entity1')).toBe(0);

    await repo.add(makeEvent({ id: 'evt_cnt1', entity_id: 'entity1' }));
    await repo.add(makeEvent({ id: 'evt_cnt2', entity_id: 'entity1' }));
    await repo.add(makeEvent({ id: 'evt_cnt3', entity_id: 'entity2' }));

    expect(await repo.count('entity1')).toBe(2);
    expect(await repo.count('entity2')).toBe(1);
  });

  it('add() with tx — rollback means event is not persisted', async () => {
    const sentinel = new Error('intentional rollback');

    await expect(
      db.withTransactionAsync(async () => {
        await repo.add(makeEvent({ id: 'evt_tx', entity_id: 'entity1' }), db);
        // Confirm visible inside the transaction.
        const inTx = await db.getAllAsync<any>(`SELECT id FROM ${PREFIX}events WHERE id = 'evt_tx'`);
        expect(inTx.length).toBe(1);
        throw sentinel;
      }),
    ).rejects.toThrow('intentional rollback');

    const afterRollback = await db.getAllAsync<any>(`SELECT id FROM ${PREFIX}events WHERE id = 'evt_tx'`);
    expect(afterRollback.length).toBe(0);
  });
});
