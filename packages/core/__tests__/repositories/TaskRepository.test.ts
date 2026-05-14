import { describe, it, expect, beforeEach } from 'vitest';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import { setupDatabase } from '../../src/db/schema';
import { MIGRATIONS } from '../../src/db/migrations';
import { OutboxRepository } from '../../src/repositories/OutboxRepository';
import { TaskRepository } from '../../src/repositories/TaskRepository';
import type { SQLiteAdapter, WikiTask } from '../../src/types';

const PREFIX = 'llm_wiki_';

async function setupTaskDatabase(db: SQLiteAdapter): Promise<void> {
  await setupDatabase(db, PREFIX);
  // Run the outbox migration (v4) to create the outbox table.
  const migration = MIGRATIONS.find(m => m.version === 4);
  if (migration) {
    await migration.run(db, PREFIX);
  }
}

function makeTask(overrides?: Partial<WikiTask>): WikiTask {
  return {
    id: 'task_' + Math.random().toString(36).slice(2),
    entity_id: 'entity1',
    description: 'Test task',
    status: 'pending',
    priority: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
    resolved_at: null,
    deleted_at: null,
    ...overrides,
  };
}

describe('TaskRepository', () => {
  let db: ReturnType<typeof openTestDatabase>;
  let outbox: OutboxRepository;
  let repo: TaskRepository;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupTaskDatabase(db);
    outbox = new OutboxRepository(db, PREFIX);
    repo = new TaskRepository(db, PREFIX, outbox);
  });

  describe('findById', () => {
    it('returns a task when it exists and is not deleted', async () => {
      const task = makeTask();
      await db.withTransactionAsync(async () => {
        await repo.upsert(task, db);
      });
      const found = await repo.findById(task.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(task.id);
      expect(found!.description).toBe(task.description);
    });

    it('returns null for unknown id', async () => {
      const found = await repo.findById('nonexistent_id');
      expect(found).toBeNull();
    });

    it('returns null for soft-deleted task', async () => {
      const task = makeTask();
      await db.withTransactionAsync(async () => {
        await repo.upsert(task, db);
      });
      await db.withTransactionAsync(async () => {
        await repo.softDelete(task.id, task.entity_id, db);
      });
      const found = await repo.findById(task.id);
      expect(found).toBeNull();
    });
  });

  describe('findAllPending', () => {
    it('returns empty array when entityIds is empty', async () => {
      const result = await repo.findAllPending([]);
      expect(result).toEqual([]);
    });

    it('returns only pending and in_progress tasks', async () => {
      const pending = makeTask({ id: 'task_pending', status: 'pending' });
      const inProgress = makeTask({ id: 'task_in_progress', status: 'in_progress' });
      const done = makeTask({ id: 'task_done', status: 'done' });
      const abandoned = makeTask({ id: 'task_abandoned', status: 'abandoned' });

      for (const task of [pending, inProgress, done, abandoned]) {
        await db.withTransactionAsync(async () => {
          await repo.upsert(task, db);
        });
      }

      const result = await repo.findAllPending(['entity1']);
      const ids = result.map(t => t.id);
      expect(ids).toContain('task_pending');
      expect(ids).toContain('task_in_progress');
      expect(ids).not.toContain('task_done');
      expect(ids).not.toContain('task_abandoned');
    });

    it('excludes soft-deleted tasks', async () => {
      const task = makeTask({ id: 'task_to_delete', status: 'pending' });
      await db.withTransactionAsync(async () => {
        await repo.upsert(task, db);
      });
      await db.withTransactionAsync(async () => {
        await repo.softDelete(task.id, task.entity_id, db);
      });
      const result = await repo.findAllPending(['entity1']);
      expect(result.map(t => t.id)).not.toContain('task_to_delete');
    });

    it('orders by priority DESC then created_at ASC', async () => {
      const base = Date.now();
      const low = makeTask({ id: 'task_low', priority: 1, created_at: base });
      const high = makeTask({ id: 'task_high', priority: 10, created_at: base + 1000 });
      const mid = makeTask({ id: 'task_mid', priority: 5, created_at: base + 500 });

      for (const task of [low, high, mid]) {
        await db.withTransactionAsync(async () => {
          await repo.upsert(task, db);
        });
      }

      const result = await repo.findAllPending(['entity1']);
      const ids = result.map(t => t.id);
      expect(ids[0]).toBe('task_high');
      expect(ids[1]).toBe('task_mid');
      expect(ids[2]).toBe('task_low');
    });

    it('filters by entityIds', async () => {
      const task1 = makeTask({ id: 'task_e1', entity_id: 'entity1' });
      const task2 = makeTask({ id: 'task_e2', entity_id: 'entity2' });
      await db.withTransactionAsync(async () => {
        await repo.upsert(task1, db);
      });
      await db.withTransactionAsync(async () => {
        await repo.upsert(task2, db);
      });

      const result = await repo.findAllPending(['entity1']);
      expect(result.map(t => t.id)).toContain('task_e1');
      expect(result.map(t => t.id)).not.toContain('task_e2');
    });
  });

  describe('upsert', () => {
    it('inserts a new task and stages an outbox entry in the same tx', async () => {
      const task = makeTask({ id: 'task_new' });
      await db.withTransactionAsync(async () => {
        await repo.upsert(task, db);
      });

      const found = await repo.findById(task.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(task.id);

      const outboxRows = await db.getAllAsync<any>(`SELECT * FROM ${PREFIX}outbox`);
      expect(outboxRows.length).toBe(1);
      expect(outboxRows[0].record_id).toBe(task.id);
      expect(outboxRows[0].table_name).toBe('tasks');
      expect(outboxRows[0].operation).toBe('UPDATE');
    });

    it('updates existing task using ON CONFLICT without changing created_at', async () => {
      const task = makeTask({ id: 'task_conflict', description: 'Original' });
      await db.withTransactionAsync(async () => {
        await repo.upsert(task, db);
      });

      // Verify original created_at
      const original = await db.getFirstAsync<any>(
        `SELECT rowid, created_at FROM ${PREFIX}tasks WHERE id = ?`, [task.id]
      );
      const originalRowId = original!.rowid;
      const originalCreatedAt = Number(original!.created_at);

      // Update description
      const updated = { ...task, description: 'Updated' };
      await db.withTransactionAsync(async () => {
        await repo.upsert(updated, db);
      });

      const after = await db.getFirstAsync<any>(
        `SELECT rowid, created_at, description FROM ${PREFIX}tasks WHERE id = ?`, [task.id]
      );
      // ON CONFLICT DO UPDATE preserves rowid (unlike INSERT OR REPLACE)
      expect(after!.rowid).toBe(originalRowId);
      // created_at should be unchanged (not in the UPDATE SET clause)
      expect(Number(after!.created_at)).toBe(originalCreatedAt);
      expect(after!.description).toBe('Updated');
    });

    it('stages DELETE outbox operation when task has deleted_at set', async () => {
      const task = makeTask({ id: 'task_soft', deleted_at: Date.now() });
      await db.withTransactionAsync(async () => {
        await repo.upsert(task, db);
      });

      const outboxRows = await db.getAllAsync<any>(`SELECT * FROM ${PREFIX}outbox`);
      expect(outboxRows.length).toBe(1);
      expect(outboxRows[0].operation).toBe('DELETE');
    });
  });

  describe('softDelete', () => {
    it('sets deleted_at and updated_at on the task', async () => {
      const task = makeTask({ id: 'task_sd' });
      await db.withTransactionAsync(async () => {
        await repo.upsert(task, db);
      });

      // Clear outbox for cleaner assertion
      await db.runAsync(`DELETE FROM ${PREFIX}outbox`, []);

      const before = Date.now();
      await db.withTransactionAsync(async () => {
        await repo.softDelete(task.id, task.entity_id, db);
      });

      const row = await db.getFirstAsync<any>(
        `SELECT deleted_at, updated_at FROM ${PREFIX}tasks WHERE id = ?`, [task.id]
      );
      expect(Number(row!.deleted_at)).toBeGreaterThanOrEqual(before);
      expect(Number(row!.updated_at)).toBeGreaterThanOrEqual(before);
    });

    it('stages a DELETE outbox entry', async () => {
      const task = makeTask({ id: 'task_sd_outbox' });
      await db.withTransactionAsync(async () => {
        await repo.upsert(task, db);
      });

      await db.runAsync(`DELETE FROM ${PREFIX}outbox`, []);

      await db.withTransactionAsync(async () => {
        await repo.softDelete(task.id, task.entity_id, db);
      });

      const outboxRows = await db.getAllAsync<any>(`SELECT * FROM ${PREFIX}outbox`);
      expect(outboxRows.length).toBe(1);
      expect(outboxRows[0].operation).toBe('DELETE');
      expect(outboxRows[0].record_id).toBe(task.id);
      expect(outboxRows[0].entity_id).toBe(task.entity_id);
    });
  });

  describe('transaction isolation', () => {
    it('upsert + rollback leaves no row in tasks or outbox', async () => {
      const task = makeTask({ id: 'task_rollback' });
      const sentinel = new Error('intentional rollback');

      await expect(
        db.withTransactionAsync(async () => {
          await repo.upsert(task, db);
          // Verify visible inside tx
          const inTxTask = await db.getFirstAsync<any>(
            `SELECT id FROM ${PREFIX}tasks WHERE id = ?`, [task.id]
          );
          expect(inTxTask).not.toBeNull();
          const inTxOutbox = await db.getAllAsync<any>(`SELECT id FROM ${PREFIX}outbox`);
          expect(inTxOutbox.length).toBe(1);
          throw sentinel;
        }),
      ).rejects.toThrow('intentional rollback');

      // After rollback: nothing persisted
      const taskRow = await db.getFirstAsync<any>(
        `SELECT id FROM ${PREFIX}tasks WHERE id = ?`, [task.id]
      );
      expect(taskRow).toBeNull();

      const outboxRows = await db.getAllAsync<any>(`SELECT id FROM ${PREFIX}outbox`);
      expect(outboxRows.length).toBe(0);
    });
  });
});
