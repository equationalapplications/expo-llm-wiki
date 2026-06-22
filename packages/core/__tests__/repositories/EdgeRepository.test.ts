import { describe, it, expect, beforeEach } from 'vitest';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import { setupDatabase } from '../../src/db/schema';
import { EdgeRepository } from '../../src/repositories/EdgeRepository';
import type { WikiEdge } from '../../src/types';

const PREFIX = 'llm_wiki_';

function makeEdge(overrides?: Partial<WikiEdge>): WikiEdge {
  return {
    id: 'edge_' + Math.random().toString(36).slice(2),
    entity_id: 'entity1',
    source_id: 'fact_a',
    target_id: 'fact_b',
    edge_type: 'mentions',
    created_at: Date.now(),
    ...overrides,
  };
}

describe('EdgeRepository', () => {
  let db: ReturnType<typeof openTestDatabase>;
  let repo: EdgeRepository;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    repo = new EdgeRepository(db, PREFIX);
  });

  it('addIgnoreDuplicate() inserts an edge with all columns', async () => {
    const edge = makeEdge({ id: 'edge_1', created_at: 1000 });
    await repo.addIgnoreDuplicate(edge);

    const rows = await db.getAllAsync<any>(`SELECT * FROM ${PREFIX}edges WHERE id = 'edge_1'`);
    expect(rows.length).toBe(1);
    expect(rows[0].entity_id).toBe('entity1');
    expect(rows[0].source_id).toBe('fact_a');
    expect(rows[0].target_id).toBe('fact_b');
    expect(rows[0].edge_type).toBe('mentions');
    expect(Number(rows[0].created_at)).toBe(1000);
  });

  it('addIgnoreDuplicate() is idempotent on (source_id, target_id, edge_type)', async () => {
    await repo.addIgnoreDuplicate(makeEdge({ id: 'edge_1', source_id: 'a', target_id: 'b', edge_type: 'mentions' }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'edge_2', source_id: 'a', target_id: 'b', edge_type: 'mentions' }));

    const rows = await db.getAllAsync<any>(`SELECT * FROM ${PREFIX}edges`);
    expect(rows.length).toBe(1);
  });

  it('addIgnoreDuplicate() allows distinct edge_type between the same source/target', async () => {
    await repo.addIgnoreDuplicate(makeEdge({ id: 'edge_1', source_id: 'a', target_id: 'b', edge_type: 'mentions' }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'edge_2', source_id: 'a', target_id: 'b', edge_type: 'reports_to' }));

    const rows = await db.getAllAsync<any>(`SELECT * FROM ${PREFIX}edges`);
    expect(rows.length).toBe(2);
  });

  it('getByEntityId() returns edges scoped to entity, ordered by created_at ASC', async () => {
    await repo.addIgnoreDuplicate(makeEdge({ id: 'edge_a', entity_id: 'entity1', source_id: 'a', target_id: 'b', created_at: 200 }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'edge_b', entity_id: 'entity1', source_id: 'c', target_id: 'd', created_at: 100 }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'edge_c', entity_id: 'entity2', source_id: 'e', target_id: 'f', created_at: 50 }));

    const edges = await repo.getByEntityId('entity1');
    expect(edges.map(e => e.id)).toEqual(['edge_b', 'edge_a']);
  });

  it('bulkDeleteByEntityId() deletes only that entity\'s edges', async () => {
    await repo.addIgnoreDuplicate(makeEdge({ id: 'edge_a', entity_id: 'entity1', source_id: 'a', target_id: 'b' }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'edge_b', entity_id: 'entity2', source_id: 'c', target_id: 'd' }));

    await db.withTransactionAsync(async (tx) => {
      await repo.bulkDeleteByEntityId('entity1', tx);
    });

    expect(await repo.getByEntityId('entity1')).toEqual([]);
    expect((await repo.getByEntityId('entity2')).length).toBe(1);
  });

  it('addIgnoreDuplicate() with tx — rollback means edge is not persisted', async () => {
    const sentinel = new Error('intentional rollback');

    await expect(
      db.withTransactionAsync(async (tx) => {
        await repo.addIgnoreDuplicate(makeEdge({ id: 'edge_tx' }), tx);
        const inTx = await tx.getAllAsync<any>(`SELECT id FROM ${PREFIX}edges WHERE id = 'edge_tx'`);
        expect(inTx.length).toBe(1);
        throw sentinel;
      }),
    ).rejects.toThrow('intentional rollback');

    const afterRollback = await db.getAllAsync<any>(`SELECT id FROM ${PREFIX}edges WHERE id = 'edge_tx'`);
    expect(afterRollback.length).toBe(0);
  });
});
