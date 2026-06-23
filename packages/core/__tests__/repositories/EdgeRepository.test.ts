import { describe, it, expect, beforeEach } from 'vitest';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import { setupDatabase } from '../../src/db/schema';
import { EdgeRepository } from '../../src/repositories/EdgeRepository';
import type { WikiEdge, SQLiteAdapter } from '../../src/types';

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

  it('addIgnoreDuplicate() is idempotent on the same primary key id', async () => {
    const edge = makeEdge({ id: 'edge_same', source_id: 'a', target_id: 'b', edge_type: 'mentions' });
    await repo.addIgnoreDuplicate(edge);
    await repo.addIgnoreDuplicate(edge);

    const rows = await db.getAllAsync<any>(`SELECT * FROM ${PREFIX}edges WHERE id = 'edge_same'`);
    expect(rows.length).toBe(1);
  });

  it('addIgnoreDuplicate() allows the same source/target/type across different entities', async () => {
    await repo.addIgnoreDuplicate(makeEdge({ id: 'edge_e1', entity_id: 'entity1', source_id: 'a', target_id: 'b', edge_type: 'mentions' }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'edge_e2', entity_id: 'entity2', source_id: 'a', target_id: 'b', edge_type: 'mentions' }));

    const rows = await db.getAllAsync<any>(`SELECT * FROM ${PREFIX}edges`);
    expect(rows.length).toBe(2);
  });

  it('addIgnoreDuplicate() throws when id collides with a different edge tuple', async () => {
    await repo.addIgnoreDuplicate(makeEdge({
      id: 'edge_collision',
      source_id: 'a',
      target_id: 'b',
      edge_type: 'mentions',
    }));

    await expect(
      repo.addIgnoreDuplicate(makeEdge({
        id: 'edge_collision',
        source_id: 'c',
        target_id: 'd',
        edge_type: 'reports_to',
      })),
    ).rejects.toThrow(/Edge id collision/);
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

async function insertEntry(
  db: SQLiteAdapter,
  overrides: Partial<{
    id: string;
    entity_id: string;
    title: string;
    confidence: string;
    source_type: string;
    deleted_at: number | null;
    created_at: number;
    updated_at: number;
  }> = {},
): Promise<string> {
  const e = {
    id: 'fact_' + Math.random().toString(36).slice(2),
    entity_id: 'entity1',
    title: 'Title',
    confidence: 'certain',
    source_type: 'user_stated',
    deleted_at: null as number | null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, 'body', '[]', ?, ?, ?, ?, ?)`,
    [e.id, e.entity_id, e.title, e.confidence, e.source_type, e.created_at, e.updated_at, e.deleted_at],
  );
  return e.id;
}

describe('EdgeRepository.getNeighborhood()', () => {
  let db: SQLiteAdapter;
  let repo: EdgeRepository;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    repo = new EdgeRepository(db, PREFIX);
  });

  const baseOpts = {
    maxDepth: 1,
    direction: 'both' as const,
    edgeTypes: undefined as string[] | undefined,
    minConfidence: 'tentative' as const,
    excludeSourceTypes: [] as string[],
    maxNodes: 20,
  };

  it('traverses one outbound hop', async () => {
    const a = await insertEntry(db, { id: 'a' });
    const b = await insertEntry(db, { id: 'b' });
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e1', source_id: a, target_id: b, edge_type: 'link' }));

    const result = await repo.getNeighborhood('entity1', a, { ...baseOpts, direction: 'outbound', maxDepth: 1 });

    expect(result.nodeIds).toEqual(['a', 'b']);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].source_id).toBe('a');
    expect(result.edges[0].target_id).toBe('b');
  });

  it('respects maxDepth=2 to reach a second hop, but not beyond', async () => {
    await insertEntry(db, { id: 'a' });
    await insertEntry(db, { id: 'b' });
    await insertEntry(db, { id: 'c' });
    await insertEntry(db, { id: 'd' });
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e1', source_id: 'a', target_id: 'b', edge_type: 'link' }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e2', source_id: 'b', target_id: 'c', edge_type: 'link' }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e3', source_id: 'c', target_id: 'd', edge_type: 'link' }));

    const depth1 = await repo.getNeighborhood('entity1', 'a', { ...baseOpts, direction: 'outbound', maxDepth: 1 });
    expect(depth1.nodeIds.sort()).toEqual(['a', 'b']);

    const depth2 = await repo.getNeighborhood('entity1', 'a', { ...baseOpts, direction: 'outbound', maxDepth: 2 });
    expect(depth2.nodeIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('direction "inbound" only follows incoming edges', async () => {
    await insertEntry(db, { id: 'a' });
    await insertEntry(db, { id: 'b' });
    await insertEntry(db, { id: 'c' });
    // b -> a (incoming to a), a -> c (outgoing from a)
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e1', source_id: 'b', target_id: 'a', edge_type: 'link' }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e2', source_id: 'a', target_id: 'c', edge_type: 'link' }));

    const result = await repo.getNeighborhood('entity1', 'a', { ...baseOpts, direction: 'inbound', maxDepth: 1 });
    expect(result.nodeIds.sort()).toEqual(['a', 'b']);
  });

  it('edgeTypes allow-list filters to matching edge_type only', async () => {
    await insertEntry(db, { id: 'a' });
    await insertEntry(db, { id: 'b' });
    await insertEntry(db, { id: 'c' });
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e1', source_id: 'a', target_id: 'b', edge_type: 'reports_to' }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e2', source_id: 'a', target_id: 'c', edge_type: 'mentions' }));

    const result = await repo.getNeighborhood('entity1', 'a', {
      ...baseOpts,
      direction: 'outbound',
      maxDepth: 1,
      edgeTypes: ['reports_to'],
    });
    expect(result.nodeIds.sort()).toEqual(['a', 'b']);
  });

  it('edgeTypes: [] short-circuits to anchor-only, no edges', async () => {
    await insertEntry(db, { id: 'a' });
    await insertEntry(db, { id: 'b' });
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e1', source_id: 'a', target_id: 'b', edge_type: 'link' }));

    const result = await repo.getNeighborhood('entity1', 'a', { ...baseOpts, edgeTypes: [] });
    expect(result).toEqual({ nodeIds: ['a'], edges: [] });
  });

  it('a tentative node dead-ends traversal past it', async () => {
    await insertEntry(db, { id: 'a', confidence: 'certain' });
    await insertEntry(db, { id: 'b', confidence: 'tentative' });
    await insertEntry(db, { id: 'c', confidence: 'certain' });
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e1', source_id: 'a', target_id: 'b', edge_type: 'link' }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e2', source_id: 'b', target_id: 'c', edge_type: 'link' }));

    const result = await repo.getNeighborhood('entity1', 'a', {
      ...baseOpts,
      direction: 'outbound',
      maxDepth: 3,
      minConfidence: 'inferred',
    });
    expect(result.nodeIds).toEqual(['a']);
  });

  it('excludeSourceTypes dead-ends a matching node', async () => {
    await insertEntry(db, { id: 'a', source_type: 'user_stated' });
    await insertEntry(db, { id: 'b', source_type: 'immutable_document' });
    await insertEntry(db, { id: 'c', source_type: 'user_stated' });
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e1', source_id: 'a', target_id: 'b', edge_type: 'link' }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e2', source_id: 'b', target_id: 'c', edge_type: 'link' }));

    const result = await repo.getNeighborhood('entity1', 'a', {
      ...baseOpts,
      direction: 'outbound',
      maxDepth: 3,
      excludeSourceTypes: ['immutable_document'],
    });
    expect(result.nodeIds).toEqual(['a']);
  });

  it('excludeSourceTypes: [] excludes nothing (NOT IN () is always-true)', async () => {
    await insertEntry(db, { id: 'a', source_type: 'user_stated' });
    await insertEntry(db, { id: 'b', source_type: 'user_stated' });
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e1', source_id: 'a', target_id: 'b', edge_type: 'link' }));

    const result = await repo.getNeighborhood('entity1', 'a', { ...baseOpts, direction: 'outbound', maxDepth: 1 });
    expect(result.nodeIds.sort()).toEqual(['a', 'b']);
  });

  it('cycle guard prevents infinite loop on A<->B with direction "both"', async () => {
    await insertEntry(db, { id: 'a' });
    await insertEntry(db, { id: 'b' });
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e1', source_id: 'a', target_id: 'b', edge_type: 'link' }));

    const result = await repo.getNeighborhood('entity1', 'a', { ...baseOpts, direction: 'both', maxDepth: 3 });
    expect(result.nodeIds.sort()).toEqual(['a', 'b']);
  });

  it('caps nodes and orders by depth ASC then updated_at DESC', async () => {
    await insertEntry(db, { id: 'a', updated_at: 1 });
    await insertEntry(db, { id: 'b', updated_at: 400 });
    await insertEntry(db, { id: 'c', updated_at: 300 });
    await insertEntry(db, { id: 'd', updated_at: 200 });
    await insertEntry(db, { id: 'e', updated_at: 100 });
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e1', source_id: 'a', target_id: 'b', edge_type: 'link' }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e2', source_id: 'a', target_id: 'c', edge_type: 'link' }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e3', source_id: 'a', target_id: 'd', edge_type: 'link' }));
    await repo.addIgnoreDuplicate(makeEdge({ id: 'e4', source_id: 'a', target_id: 'e', edge_type: 'link' }));

    const result = await repo.getNeighborhood('entity1', 'a', {
      ...baseOpts,
      direction: 'outbound',
      maxDepth: 1,
      maxNodes: 3,
    });
    expect(result.nodeIds).toEqual(['a', 'b', 'c']);
  });

  it('returns the anchor even when its own confidence/source_type would fail the discovered-node gate', async () => {
    await insertEntry(db, { id: 'a', confidence: 'tentative', source_type: 'immutable_document' });

    const result = await repo.getNeighborhood('entity1', 'a', {
      ...baseOpts,
      minConfidence: 'certain',
      excludeSourceTypes: ['immutable_document'],
    });
    expect(result.nodeIds).toEqual(['a']);
  });

  it('returns empty for a missing sourceId', async () => {
    const result = await repo.getNeighborhood('entity1', 'does-not-exist', baseOpts);
    expect(result).toEqual({ nodeIds: [], edges: [] });
  });

  it('returns empty for a cross-entity sourceId', async () => {
    await insertEntry(db, { id: 'a', entity_id: 'entity2' });
    const result = await repo.getNeighborhood('entity1', 'a', baseOpts);
    expect(result).toEqual({ nodeIds: [], edges: [] });
  });

  it('returns empty for a soft-deleted sourceId', async () => {
    await insertEntry(db, { id: 'a', deleted_at: 999 });
    const result = await repo.getNeighborhood('entity1', 'a', baseOpts);
    expect(result).toEqual({ nodeIds: [], edges: [] });
  });
});
