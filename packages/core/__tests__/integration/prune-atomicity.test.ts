import { describe, it, expect, vi, afterEach } from 'vitest';
import { WikiMemory } from '../../src/WikiMemory';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import type { WikiOptions } from '../../src/types';

const PREFIX = 'llm_wiki_';
const EIGHT_DAYS_AGO = Date.now() - 8 * 86400_000;

const STUB_OPTIONS: WikiOptions = {
  llmProvider: { generateText: async () => '{}' },
};

async function seedSoftDeletedEntry(
  db: ReturnType<typeof openTestDatabase>,
  id: string,
  entityId: string,
) {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entityId, `title-${id}`, 'body', '[]', 'certain', 'user_stated', EIGHT_DAYS_AGO, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO],
  );
}

async function seedSoftDeletedTask(
  db: ReturnType<typeof openTestDatabase>,
  id: string,
  entityId: string,
) {
  await db.runAsync(
    `INSERT INTO ${PREFIX}tasks (id, entity_id, description, status, priority, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entityId, `task-${id}`, 'pending', 0, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO],
  );
}

describe('runPrune() — atomic entry/task deletion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rolls back entry deletions when taskRepo.bulkDeletePruned throws', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, STUB_OPTIONS);
    await wiki.setup();

    await seedSoftDeletedEntry(db, 'e1', 'ent');
    await seedSoftDeletedEntry(db, 'e2', 'ent');
    await seedSoftDeletedTask(db, 't1', 'ent');

    vi.spyOn((wiki as any).taskRepo, 'bulkDeletePruned').mockRejectedValueOnce(
      new Error('task db fail'),
    );

    await expect(
      wiki.runPrune('ent', { retainSoftDeletedFor: 7, retainEventsFor: null }),
    ).rejects.toThrow('task db fail');

    const remaining = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}entries WHERE entity_id = 'ent' AND deleted_at IS NOT NULL`,
    );
    const ids = remaining.map(r => r.id);
    expect(ids).toContain('e1');
    expect(ids).toContain('e2');
  });
});
