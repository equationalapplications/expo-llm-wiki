import { describe, it, expect, beforeEach } from 'vitest';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../../src/types';
import { setupDatabase } from '../../src/db/schema';
import { MIGRATIONS } from '../../src/db/migrations';
import { OutboxRepository } from '../../src/repositories/OutboxRepository';

const PREFIX = 'llm_wiki_';

async function setupOutboxDatabase(db: SQLiteAdapter): Promise<void> {
  await setupDatabase(db, PREFIX);
  // Run the outbox migration (v4) to create the outbox table.
  const migration = MIGRATIONS.find(m => m.version === 4);
  if (migration) {
    await migration.run(db, PREFIX);
  }
}

describe('OutboxRepository', () => {
  let db: ReturnType<typeof openTestDatabase>;
  let repo: OutboxRepository;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupOutboxDatabase(db);
    repo = new OutboxRepository(db, PREFIX, true);
  });

  it('push() inserts a row with correct columns', async () => {
    await db.withTransactionAsync(async () => {
      await repo.push(
        {
          entityId: 'entity1',
          tableName: 'entries',
          recordId: 'rec1',
          operation: 'INSERT',
          payload: { foo: 'bar' },
        },
        db,
      );
    });

    const rows = await db.getAllAsync<any>(
      `SELECT * FROM ${PREFIX}outbox`,
    );
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.id).toMatch(/^out_[a-z0-9]+$/);
    expect(row.entity_id).toBe('entity1');
    expect(row.table_name).toBe('entries');
    expect(row.record_id).toBe('rec1');
    expect(row.operation).toBe('INSERT');
    expect(JSON.parse(row.payload)).toEqual({ foo: 'bar' });
    expect(typeof row.created_at).toBe('number');
    expect(row.created_at).toBeGreaterThan(0);
  });

  it('fetchPending() returns rows ordered by created_at ASC and respects limit', async () => {
    const base = Date.now();
    // Insert three rows with explicit created_at values (in reverse order of ids).
    await db.execAsync(`
      INSERT INTO ${PREFIX}outbox (id, entity_id, table_name, record_id, operation, payload, created_at)
      VALUES ('out_c', 'e1', 't', 'r3', 'DELETE', '{}', ${base + 300});
      INSERT INTO ${PREFIX}outbox (id, entity_id, table_name, record_id, operation, payload, created_at)
      VALUES ('out_a', 'e1', 't', 'r1', 'INSERT', '{}', ${base + 100});
      INSERT INTO ${PREFIX}outbox (id, entity_id, table_name, record_id, operation, payload, created_at)
      VALUES ('out_b', 'e1', 't', 'r2', 'UPDATE', '{}', ${base + 200});
    `);

    const all = await repo.fetchPending();
    expect(all.map((r: any) => r.id)).toEqual(['out_a', 'out_b', 'out_c']);

    const limited = await repo.fetchPending(2);
    expect(limited.length).toBe(2);
    expect(limited.map((r: any) => r.id)).toEqual(['out_a', 'out_b']);
  });

  it('acknowledge() deletes specified IDs and is a no-op for empty array', async () => {
    // Insert two rows directly.
    await db.execAsync(`
      INSERT INTO ${PREFIX}outbox (id, entity_id, table_name, record_id, operation, payload, created_at)
      VALUES ('out_x', 'e1', 't', 'r1', 'INSERT', '{}', ${Date.now()});
      INSERT INTO ${PREFIX}outbox (id, entity_id, table_name, record_id, operation, payload, created_at)
      VALUES ('out_y', 'e1', 't', 'r2', 'UPDATE', '{}', ${Date.now()});
    `);

    // No-op for empty array.
    await expect(repo.acknowledge([])).resolves.toBeUndefined();

    const countBefore = await db.getAllAsync<any>(`SELECT id FROM ${PREFIX}outbox`);
    expect(countBefore.length).toBe(2);

    // Acknowledge one row.
    await repo.acknowledge(['out_x']);

    const remaining = await db.getAllAsync<any>(`SELECT id FROM ${PREFIX}outbox`);
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe('out_y');

    // Acknowledge the last row.
    await repo.acknowledge(['out_y']);

    const empty = await db.getAllAsync<any>(`SELECT id FROM ${PREFIX}outbox`);
    expect(empty.length).toBe(0);
  });

  it('acknowledge() deletes more than 500 IDs by chunking', async () => {
    const count = 502;
    const ids: string[] = [];
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      const id = `out_bulk_${i}`;
      ids.push(id);
      await db.runAsync(
        `INSERT INTO ${PREFIX}outbox (id, entity_id, table_name, record_id, operation, payload, created_at) VALUES (?, 'e1', 't', 'r', 'INSERT', '{}', ?)`,
        [id, now + i],
      );
    }

    await repo.acknowledge(ids);

    const remaining = await db.getAllAsync<any>(`SELECT id FROM ${PREFIX}outbox`);
    expect(remaining.length).toBe(0);
  });

  it('push() is a no-op when enableOutbox is false', async () => {
    const disabledRepo = new OutboxRepository(db, PREFIX, false);
    await db.withTransactionAsync(async () => {
      await disabledRepo.push(
        {
          entityId: 'entity_disabled',
          tableName: 'entries',
          recordId: 'rec_disabled',
          operation: 'INSERT',
          payload: { should: 'not appear' },
        },
        db,
      );
    });
    const rows = await db.getAllAsync<any>(`SELECT * FROM ${PREFIX}outbox`);
    expect(rows.length).toBe(0);
  });

  it('push() uses the provided tx — rollback prevents row from being persisted', async () => {
    const sentinel = new Error('intentional rollback');

    await expect(
      db.withTransactionAsync(async () => {
        await repo.push(
          {
            entityId: 'entity_tx',
            tableName: 'entries',
            recordId: 'rec_tx',
            operation: 'INSERT',
            payload: { inside: 'tx' },
          },
          db,
        );
        // Verify the row is visible inside the transaction.
        const inTx = await db.getAllAsync<any>(`SELECT id FROM ${PREFIX}outbox`);
        expect(inTx.length).toBe(1);
        // Force a rollback.
        throw sentinel;
      }),
    ).rejects.toThrow('intentional rollback');

    // After rollback, the row must not be present.
    const afterRollback = await db.getAllAsync<any>(`SELECT id FROM ${PREFIX}outbox`);
    expect(afterRollback.length).toBe(0);
  });
});
