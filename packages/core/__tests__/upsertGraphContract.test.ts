import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiSourceRefHashCollision, WikiStrictOntologyViolation } from '../src/index';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import type { SQLiteAdapter } from '../src/types';

const VALID_HASH = 'a'.repeat(64);

describe('WikiMemory.upsertGraph — public API surface', () => {
  let db: SQLiteAdapter;
  let wiki: WikiMemory;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, 'llm_wiki_');
    wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await wiki.setup();
  });

  it('exists as a method on WikiMemory', () => {
    expect(typeof wiki.upsertGraph).toBe('function');
  });

  it('accepts (entityId, params, adapter) and returns the documented shape', async () => {
    const result = await db.withTransactionAsync(async (tx) =>
      wiki.upsertGraph(
        'entity-1',
        {
          sourceRef: 'src/foo.ts',
          sourceHash: VALID_HASH,
          nodes: [{ id: 'f1', type: '', title: 'sym1' }],
          edges: [],
        },
        tx,
      ),
    );
    expect(result).toEqual({ nodesWritten: 1, edgesWritten: 0, superseded: 0 });
  });
});

describe('upsertGraph contract — C1: participates in caller tx', () => {
  let wiki: WikiMemory;
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, 'llm_wiki_');
    wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await wiki.setup();
  });

  it('rollback after throw inside caller tx leaves graph empty', async () => {
    await expect(
      db.withTransactionAsync(async (tx) => {
        await wiki.upsertGraph(
          'entity-1',
          { sourceRef: 'foo.ts', sourceHash: VALID_HASH, nodes: [{ id: 'f1', type: '', title: 'sym1' }], edges: [] },
          tx,
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const entries = await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_entries WHERE entity_id = ?`, ['entity-1']);
    const edges = await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_edges WHERE entity_id = ?`, ['entity-1']);
    const sri = await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_source_ref_index WHERE entity_id = ?`, ['entity-1']);
    expect(entries).toHaveLength(0);
    expect(edges).toHaveLength(0);
    expect(sri).toHaveLength(0);
  });

  it('does not call withTransactionAsync internally', async () => {
    let beginCount = 0;
    let commitCount = 0;
    // Wrap the adapter to log transaction boundaries.
    const calls: string[] = [];
    const wrapped: SQLiteAdapter = {
      ...db,
      withTransactionAsync: async <T,>(fn: (tx: SQLiteAdapter) => Promise<T>): Promise<T> => {
        calls.push('BEGIN');
        beginCount++;
        try {
          const result = await fn(db); // tx === db, same as the test helper
          calls.push('COMMIT');
          commitCount++;
          return result;
        } catch (e) {
          calls.push('ROLLBACK');
          throw e;
        }
      },
    };
    // Spy on the outer db's withTransactionAsync too — must NOT be called by upsertGraph itself.
    const outerSpy = vi.spyOn(db, 'withTransactionAsync');

    await wrapped.withTransactionAsync(async (tx) => {
      await wiki.upsertGraph(
        'entity-1',
        { sourceRef: 'foo.ts', sourceHash: VALID_HASH, nodes: [{ id: 'f1', type: '', title: 'sym1' }], edges: [] },
        tx,
      );
    });

    // The caller's tx wraps exactly one BEGIN + one COMMIT. upsertGraph itself
    // opens no nested transaction.
    expect(beginCount).toBe(1);
    expect(commitCount).toBe(1);
    // The wrapped adapter's withTransactionAsync (the OUTER one) was used once
    // by the test; upsertGraph must NOT have called withTransactionAsync on
    // the original `db` handle.
    expect(outerSpy).not.toHaveBeenCalled();
  });

  it('does not acquire any lock — parallel upsertGraph + import lock succeeds', async () => {
    // Acquire an import lock for the entity, then call upsertGraph — must succeed.
    const jobManager = (wiki as any).jobManager;
    jobManager.activeMaintenanceJobs.add(`llm_wiki_:entity-1:import`);

    await expect(
      db.withTransactionAsync(async (tx) =>
        wiki.upsertGraph(
          'entity-1',
          { sourceRef: 'foo.ts', sourceHash: VALID_HASH, nodes: [{ id: 'f1', type: '', title: 'sym1' }], edges: [] },
          tx,
        ),
      ),
    ).resolves.toBeDefined();

    // Confirm write happened.
    const entries = await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_entries WHERE entity_id = ?`, ['entity-1']);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});

describe('upsertGraph contract — C2: no-op on unchanged scope', () => {
  let wiki: WikiMemory;
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, 'llm_wiki_');
    wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await wiki.setup();
  });

  it('re-call with same (sourceRef, sourceHash) returns zeros and writes nothing', async () => {
    const params = {
      sourceRef: 'foo.ts',
      sourceHash: VALID_HASH,
      nodes: [
        { id: 'f1', type: '', title: 'sym1' },
        { id: 'f2', type: '', title: 'sym2' },
        { id: 'f3', type: '', title: 'sym3' },
      ],
      edges: [
        { type: '', sourceId: 'f1', targetId: 'f2' },
        { type: '', sourceId: 'f1', targetId: 'f3' },
      ],
    };

    const first = await db.withTransactionAsync(async (tx) => wiki.upsertGraph('entity-1', params, tx));
    expect(first.nodesWritten).toBe(3);
    expect(first.edgesWritten).toBe(2);

    const entriesBefore = (await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_entries WHERE entity_id = ?`, ['entity-1'])).length;
    const edgesBefore = (await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_edges WHERE entity_id = ?`, ['entity-1'])).length;

    const second = await db.withTransactionAsync(async (tx) => wiki.upsertGraph('entity-1', params, tx));
    expect(second).toEqual({ nodesWritten: 0, edgesWritten: 0, superseded: 0 });

    const entriesAfter = (await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_entries WHERE entity_id = ?`, ['entity-1'])).length;
    const edgesAfter = (await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_edges WHERE entity_id = ?`, ['entity-1'])).length;
    expect(entriesAfter).toBe(entriesBefore);
    expect(edgesAfter).toBe(edgesBefore);
  });

  it('same sourceHash with different sourceRef throws WikiSourceRefHashCollision', async () => {
    await db.withTransactionAsync(async (tx) =>
      wiki.upsertGraph('entity-1', { sourceRef: 'a.ts', sourceHash: VALID_HASH, nodes: [{ id: 'f1', type: '', title: 't' }], edges: [] }, tx),
    );
    await expect(
      db.withTransactionAsync(async (tx) =>
        wiki.upsertGraph('entity-1', { sourceRef: 'b.ts', sourceHash: VALID_HASH, nodes: [{ id: 'f2', type: '', title: 't' }], edges: [] }, tx),
      ),
    ).rejects.toBeInstanceOf(WikiSourceRefHashCollision);
  });

  it('two distinct sourceRefs with genuinely identical content both throw on the second write (byte-identical-files regression)', async () => {
    // First write succeeds.
    await db.withTransactionAsync(async (tx) =>
      wiki.upsertGraph('entity-1', { sourceRef: 'fileA.ts', sourceHash: VALID_HASH, nodes: [{ id: 'fa', type: '', title: 't' }], edges: [] }, tx),
    );
    // Second write with same hash but a different sourceRef — must throw.
    await expect(
      db.withTransactionAsync(async (tx) =>
        wiki.upsertGraph('entity-1', { sourceRef: 'fileB.ts', sourceHash: VALID_HASH, nodes: [{ id: 'fb', type: '', title: 't' }], edges: [] }, tx),
      ),
    ).rejects.toBeInstanceOf(WikiSourceRefHashCollision);
  });

  it('same sourceRef with different sourceHash supersedes prior facts + edges and returns superseded count', async () => {
    const sourceRef = 'foo.ts';
    const firstHash = 'a'.repeat(64);
    const secondHash = 'b'.repeat(64);

    // First write: 2 facts, 1 edge between them.
    const first = await db.withTransactionAsync(async (tx) =>
      wiki.upsertGraph(
        'entity-1',
        {
          sourceRef,
          sourceHash: firstHash,
          nodes: [
            { id: 'f1', type: '', title: 'sym1' },
            { id: 'f2', type: '', title: 'sym2' },
          ],
          edges: [{ type: '', sourceId: 'f1', targetId: 'f2' }],
        },
        tx,
      ),
    );
    expect(first).toEqual({ nodesWritten: 2, edgesWritten: 1, superseded: 0 });

    // Second write: same sourceRef, different sourceHash. Prior facts
    // for this sourceRef are soft-deleted; the prior edge sourced from a
    // retired fact is hard-deleted; the new facts/edges are persisted.
    const second = await db.withTransactionAsync(async (tx) =>
      wiki.upsertGraph(
        'entity-1',
        {
          sourceRef,
          sourceHash: secondHash,
          nodes: [
            { id: 'g1', type: '', title: 'sym1' },
            { id: 'g2', type: '', title: 'sym2' },
            { id: 'g3', type: '', title: 'sym3' },
          ],
          edges: [
            { type: '', sourceId: 'g1', targetId: 'g2' },
            { type: '', sourceId: 'g1', targetId: 'g3' },
          ],
        },
        tx,
      ),
    );
    expect(second.nodesWritten).toBe(3);
    expect(second.edgesWritten).toBe(2);
    // superseded = retired facts (2: f1, f2) + retired edges (1: f1→f2)
    expect(second.superseded).toBe(3);

    // Prior facts are soft-deleted (deleted_at set).
    const facts = await db.getAllAsync<{ id: string; deleted_at: number | null }>(
      `SELECT id, deleted_at FROM llm_wiki_entries WHERE entity_id = ? ORDER BY id`,
      ['entity-1'],
    );
    const live = facts.filter(f => f.deleted_at === null).map(f => f.id);
    const retired = facts.filter(f => f.deleted_at !== null).map(f => f.id);
    expect(live.sort()).toEqual(['g1', 'g2', 'g3']);
    expect(retired.sort()).toEqual(['f1', 'f2']);

    // The original source edge is gone; the replacement edges remain.
    const edges = await db.getAllAsync<{ source_id: string; target_id: string }>(
      `SELECT source_id, target_id FROM llm_wiki_edges WHERE entity_id = ? ORDER BY source_id, target_id`,
      ['entity-1'],
    );
    const edgePairs = edges.map(e => `${e.source_id}->${e.target_id}`).sort();
    expect(edgePairs).toEqual(['g1->g2', 'g1->g3']);
    expect(edgePairs).not.toContain('f1->f2');
  });
});

describe('upsertGraph contract — C3: dangling edge targets legal', () => {
  let wiki: WikiMemory;
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, 'llm_wiki_');
    wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await wiki.setup();
  });

  it('edge whose targetId names a missing node is stored verbatim', async () => {
    await db.withTransactionAsync(async (tx) =>
      wiki.upsertGraph(
        'entity-1',
        {
          sourceRef: 'auth.ts',
          sourceHash: VALID_HASH,
          nodes: [{ id: 'sym_in_auth', type: '', title: 'sym1' }],
          edges: [{ type: '', sourceId: 'sym_in_auth', targetId: 'sym_in_crypto_never_parsed' }],
        },
        tx,
      ),
    );

    const edges = await db.getAllAsync<{ target_id: string }>(
      `SELECT target_id FROM llm_wiki_edges WHERE entity_id = ?`,
      ['entity-1'],
    );
    expect(edges.map(e => e.target_id)).toEqual(['sym_in_crypto_never_parsed']);
  });

  it('traverseGraph from a dangling-edge source returns empty path through the dangling edge', async () => {
    await db.withTransactionAsync(async (tx) =>
      wiki.upsertGraph(
        'entity-1',
        {
          sourceRef: 'auth.ts',
          sourceHash: VALID_HASH,
          nodes: [{ id: 'sym_in_auth', type: '', title: 'sym1' }],
          edges: [{ type: '', sourceId: 'sym_in_auth', targetId: 'sym_in_crypto_never_parsed' }],
        },
        tx,
      ),
    );

    const neighborhood = await wiki.traverseGraph('entity-1', { sourceId: 'sym_in_auth', maxDepth: 2 });
    // The dangling edge is recorded but the traversal can't follow it to a real node.
    expect(neighborhood.nodes.map(n => n.id)).toEqual(['sym_in_auth']);
    expect(neighborhood.edges).toEqual([]);
  });
});

describe('upsertGraph contract — C4: strict-mode throws', () => {
  let wiki: WikiMemory;
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, 'llm_wiki_');
    wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}' },
      config: {
        ontology: {
          seedManifests: {
            'entity-1': {
              manifest: {
                node_types: [{ type: 'Function', description: '' }],
                edge_types: [],
              },
            },
          },
        },
      },
    });
    await wiki.setup();
    // Switch the persisted mode to 'strict' for the entity under test.
    const persisted = await wiki.getOntologyManifest('entity-1');
    if (persisted) {
      await wiki.setOntologyManifest('entity-1', persisted.manifest, { mode: 'strict' });
    }
  });

  it('out-of-manifest node type under strict mode throws WikiStrictOntologyViolation', async () => {
    await expect(
      db.withTransactionAsync(async (tx) =>
        wiki.upsertGraph(
          'entity-1',
          {
            sourceRef: 'src/foo.ts',
            sourceHash: VALID_HASH,
            nodes: [{ id: 'f1', type: 'NotInManifest', title: 't' }],
            edges: [],
          },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(WikiStrictOntologyViolation);
  });

  it('out-of-manifest edge type under strict mode throws WikiStrictOntologyViolation', async () => {
    await expect(
      db.withTransactionAsync(async (tx) =>
        wiki.upsertGraph(
          'entity-1',
          {
            sourceRef: 'src/foo.ts',
            sourceHash: VALID_HASH,
            nodes: [{ id: 'f1', type: 'Function', title: 't' }],
            edges: [{ type: 'unmapped_edge_type', sourceId: 'f1', targetId: 'f2' }],
          },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(WikiStrictOntologyViolation);
  });

  it('all-or-nothing — first invalid node throws, NONE written', async () => {
    await expect(
      db.withTransactionAsync(async (tx) =>
        wiki.upsertGraph(
          'entity-1',
          {
            sourceRef: 'src/foo.ts',
            sourceHash: VALID_HASH,
            nodes: [
              { id: 'f1', type: 'Function', title: 'good1' },
              { id: 'f2', type: 'NotInManifest', title: 'bad' },
              { id: 'f3', type: 'Function', title: 'good3' },
            ],
            edges: [],
          },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(WikiStrictOntologyViolation);

    const entries = await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_entries WHERE entity_id = ?`, ['entity-1']);
    const edges = await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_edges WHERE entity_id = ?`, ['entity-1']);
    const sri = await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_source_ref_index WHERE entity_id = ?`, ['entity-1']);
    expect(entries).toHaveLength(0);
    expect(edges).toHaveLength(0);
    expect(sri).toHaveLength(0);
  });

  it('out-of-manifest type under non-strict mode silently drops (matches ingestDocument parity)', async () => {
    // Switch mode to 'off' (non-strict).
    const persisted = await wiki.getOntologyManifest('entity-1');
    if (persisted) {
      await wiki.setOntologyManifest('entity-1', persisted.manifest, { mode: 'off' });
    }

    const result = await db.withTransactionAsync(async (tx) =>
      wiki.upsertGraph(
        'entity-1',
        {
          sourceRef: 'src/foo.ts',
          sourceHash: VALID_HASH,
          nodes: [
            { id: 'f1', type: 'Function', title: 'good' },
            { id: 'f2', type: 'NotInManifest', title: 'dropped' },
          ],
          edges: [{ type: 'unknown_edge', sourceId: 'f1', targetId: 'f2' }],
        },
        tx,
      ),
    );

    // 2 nodes written (okf_type for the unknown one is null), 0 edges (unknown_edge filtered).
    expect(result.nodesWritten).toBe(2);
    expect(result.edgesWritten).toBe(0);

    const facts = await db.getAllAsync<{ id: string; okf_type: string | null }>(
      `SELECT id, okf_type FROM llm_wiki_entries WHERE entity_id = ? ORDER BY id`,
      ['entity-1'],
    );
    const dropped = facts.find(f => f.id === 'f2');
    expect(dropped?.okf_type).toBeNull();
  });
});
