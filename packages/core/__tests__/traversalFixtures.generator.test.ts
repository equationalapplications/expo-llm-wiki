/**
 * Baseline-driven compatibility fixture generator (REQ-SLICE-02).
 *
 * Runs the REAL TS baseline (EdgeRepository.getNeighborhood +
 * GraphTraversalService.traverseGraph against a real in-memory SQLite DB)
 * over the REQ-SLICE-02 scenario matrix and writes deterministic JSON
 * fixtures consumed by the native Rust engine tests (Tasks 7-10 of
 * docs/superpowers/plans/2026-09-18-native-graphrag-vertical-slice-
 * implementation-plan.md).
 *
 * Categories:
 *  - parity: identical contract — native must reproduce baseline exactly.
 *  - declared_difference: behavior where the native engine deliberately
 *    differs (real-valued depth bound, set-based cycle guard). Fixtures
 *    record baselineObservedNodeIds and explain the native expectation in
 *    notes; expectedNodeIds is null.
 *  - robustness: inputs where native rejects cleanly (unsupported_limit /
 *    chunked binds) while baseline may clamp or fail — expectedNodeIds is
 *    null and notes record the observed baseline behavior.
 *
 * Determinism: fixed ids, small fixed integer timestamps, no randomness,
 * no Date.now() in stored or emitted data. Parity scenarios use distinct
 * updated_at values (capped-tie nondeterminism is isolated in the one
 * scenario that studies it, which asserts prefix + eligible group only).
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { EdgeRepository } from '../src/repositories/EdgeRepository';
import { EntryRepository } from '../src/repositories/EntryRepository';
import { OutboxRepository } from '../src/repositories/OutboxRepository';
import { GraphTraversalService } from '../src/services/GraphTraversalService';
import type { GraphTraversalOptions, GraphNeighborhood, SQLiteAdapter, WikiConfig } from '../src/types';

const PREFIX = 'llm_wiki_';
const FIXTURE_DIR = join(__dirname, '..', '..', '..', 'crates', 'graphrag-core', 'tests', 'fixtures');

type Category = 'parity' | 'declared_difference' | 'robustness';

interface FixtureEnvelope {
  description: string;
  category: Category;
  entityId: string;
  sourceId: string;
  config: WikiConfig;
  options: GraphTraversalOptions;
  expectedNodeIds: string[] | null;
  eligibleTiedIds?: string[];
  baselineObservedNodeIds?: string[];
  /** REQ-SLICE-02 time-derived pin: project {id, isStale, trustTier} per returned node. */
  captureFactProjections?: boolean;
  expectedFactProjections?: Array<{ id: string; isStale: boolean; trustTier: string }>;
  expectedEdges: Array<{ id: string; source_id: string; target_id: string; edge_type: string }> | null;
  notes?: string;
}

/** Deterministic entry seeder (mirrors EdgeRepository.test.ts insertEntry). */
async function seedEntry(
  db: SQLiteAdapter,
  o: Partial<{
    id: string; entity_id: string; title: string; confidence: string;
    source_type: string; deleted_at: number | null; created_at: number; updated_at: number;
  }> = {},
): Promise<string> {
  const e = {
    id: 'x', entity_id: 'entity1', title: `t_${o.id ?? 'x'}`, confidence: 'certain',
    source_type: 'user_stated', deleted_at: null as number | null,
    created_at: 1, updated_at: 1, ...o,
  };
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, 'body', '[]', ?, ?, ?, ?, ?)`,
    [e.id, e.entity_id, e.title, e.confidence, e.source_type, e.created_at, e.updated_at, e.deleted_at],
  );
  return e.id;
}

/** Deterministic edge seeder. */
async function seedEdge(
  db: SQLiteAdapter,
  id: string, entityId: string, sourceId: string, targetId: string,
  edgeType = 'mentions', createdAt = 1,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${PREFIX}edges (id, entity_id, source_id, target_id, edge_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, entityId, sourceId, targetId, edgeType, createdAt],
  );
}

/** Build a real baseline service over a fresh seeded DB. */
async function makeService(
  seed: (db: SQLiteAdapter) => Promise<void>,
  config: WikiConfig = {},
): Promise<GraphTraversalService> {
  const db = openTestDatabase();
  await setupDatabase(db, PREFIX);
  await seed(db);
  const edgeRepo = new EdgeRepository(db, PREFIX);
  const entryRepo = new EntryRepository(db, PREFIX, new OutboxRepository(db, PREFIX, true));
  return new GraphTraversalService(edgeRepo, entryRepo, config);
}

/** Run a scenario against the real baseline and emit its fixture. */
async function capture(
  name: string,
  fx: Omit<FixtureEnvelope, 'expectedEdges' | 'expectedNodeIds'> & { expectedNodeIds?: string[] | null },
  seed: (db: SQLiteAdapter) => Promise<void>,
  edgesExpected: boolean,
): Promise<FixtureEnvelope> {
  const svc = await makeService(seed, fx.config);
  let neighborhood: GraphNeighborhood;
  try {
    neighborhood = await svc.traverseGraph(fx.entityId, fx.options);
  } catch (err) {
    // Robustness scenarios may make the baseline throw (e.g. variable limit).
    const baselineNote = `baseline threw: ${(err as Error).message}`;
    const fixture: FixtureEnvelope = { ...fx, expectedNodeIds: fx.expectedNodeIds ?? null, expectedEdges: null, notes: `${fx.notes ?? ''} | ${baselineNote}` };
    writeFixture(name, fixture);
    return fixture;
  }
  const expectedEdges = edgesExpected
    ? neighborhood.edges.map((e) => ({ id: e.id, source_id: e.source_id, target_id: e.target_id, edge_type: e.edge_type }))
    : null;
  const fixture: FixtureEnvelope = {
    ...fx,
    expectedNodeIds: fx.expectedNodeIds ?? neighborhood.nodes.map((n) => n.id),
    expectedEdges,
  };
  if (fx.expectedNodeIds === null && neighborhood.nodes.length > 0) {
    fixture.baselineObservedNodeIds = neighborhood.nodes.map((n) => n.id);
  }
  if (fx.captureFactProjections) {
    fixture.expectedFactProjections = neighborhood.nodes.map((n) => ({
      id: n.id, isStale: n.isStale === true, trustTier: n.trustTier ?? 'unverified',
    }));
  }
  writeFixture(name, fixture);
  return fixture;
}

function writeFixture(name: string, fixture: FixtureEnvelope): void {
  const dir = join(FIXTURE_DIR, fixture.category);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2) + '\n');
}

describe('compatibility fixture generator (REQ-SLICE-02)', () => {
  it('generates the full parity / declared-difference / robustness matrix', async () => {
    const counts: Record<Category, number> = { parity: 0, declared_difference: 0, robustness: 0 };

    // --- parity -----------------------------------------------------------
    await capture('one_hop_outbound', {
      description: 'single outbound hop a->b', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1, direction: 'outbound' },

    }, async (db) => {
      await seedEntry(db, { id: 'a' }); await seedEntry(db, { id: 'b' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
    }, true); counts.parity++;

    await capture('two_hop_chain', {
      description: 'two-hop chain a->b->c', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 2, direction: 'outbound' },

    }, async (db) => {
      await seedEntry(db, { id: 'a' }); await seedEntry(db, { id: 'b' }); await seedEntry(db, { id: 'c' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b'); await seedEdge(db, 'e2', 'entity1', 'b', 'c');
    }, true); counts.parity++;

    await capture('depth3_chain', {
      description: 'three-hop chain a->b->c->d at maxDepth 3', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 3, direction: 'outbound' },

    }, async (db) => {
      for (const id of ['a', 'b', 'c', 'd']) await seedEntry(db, { id });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
      await seedEdge(db, 'e2', 'entity1', 'b', 'c');
      await seedEdge(db, 'e3', 'entity1', 'c', 'd');
    }, true); counts.parity++;

    await capture('direction_inbound', {
      description: 'inbound only: b->a and a->c, expect [a,b]', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1, direction: 'inbound' },

    }, async (db) => {
      for (const id of ['a', 'b', 'c']) await seedEntry(db, { id });
      await seedEdge(db, 'e1', 'entity1', 'b', 'a');
      await seedEdge(db, 'e2', 'entity1', 'a', 'c');
    }, true); counts.parity++;

    await capture('direction_both', {
      description: 'direction both: a->b, expect [a,b]', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1, direction: 'both' },

    }, async (db) => {
      await seedEntry(db, { id: 'a' }); await seedEntry(db, { id: 'b' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
    }, true); counts.parity++;

    await capture('edge_types_allow_list', {
      description: 'edgeTypes allow-list filters non-matching types', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1, direction: 'both', edgeTypes: ['reports_to'] },

    }, async (db) => {
      for (const id of ['a', 'b', 'c']) await seedEntry(db, { id });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b', 'reports_to');
      await seedEdge(db, 'e2', 'entity1', 'a', 'c', 'mentions');
    }, true); counts.parity++;

    await capture('edge_types_empty_short_circuit', {
      description: 'edgeTypes [] short-circuits to anchor-only', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1, direction: 'both', edgeTypes: [] },
      expectedNodeIds: ['a'],
    }, async (db) => {
      await seedEntry(db, { id: 'a' }); await seedEntry(db, { id: 'b' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
    }, true); counts.parity++;

    await capture('tentative_dead_end', {
      description: 'tentative node dead-ends traversal past it', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: { minTraversalConfidence: 'inferred' },
      options: { sourceId: 'a', maxDepth: 3, minTraversalConfidence: 'inferred' },
      expectedNodeIds: ['a'],
    }, async (db) => {
      await seedEntry(db, { id: 'a' });
      await seedEntry(db, { id: 'b', confidence: 'tentative' });
      await seedEntry(db, { id: 'c' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
      await seedEdge(db, 'e2', 'entity1', 'b', 'c');
    }, true); counts.parity++;

    await capture('exclude_source_types_dead_end', {
      description: 'excluded source_type dead-ends traversal', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 3, excludeSourceTypes: ['immutable_document'] },
      expectedNodeIds: ['a'],
    }, async (db) => {
      await seedEntry(db, { id: 'a' });
      await seedEntry(db, { id: 'b', source_type: 'immutable_document' });
      await seedEntry(db, { id: 'c' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
      await seedEdge(db, 'e2', 'entity1', 'b', 'c');
    }, true); counts.parity++;

    await capture('cycle_guard_both_directions', {
      description: 'A<->B cycle with direction both terminates', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 3, direction: 'both' },

    }, async (db) => {
      await seedEntry(db, { id: 'a' }); await seedEntry(db, { id: 'b' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
    }, true); counts.parity++;

    await capture('node_cap_ordering', {
      description: 'cap 3: anchor + best-two children by updated_at DESC within depth', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1, maxTraversalNodes: 3 },
      expectedNodeIds: ['a', 'b', 'c'],
    }, async (db) => {
      await seedEntry(db, { id: 'a', updated_at: 1 });
      await seedEntry(db, { id: 'b', updated_at: 400 });
      await seedEntry(db, { id: 'c', updated_at: 300 });
      await seedEntry(db, { id: 'd', updated_at: 200 });
      await seedEntry(db, { id: 'e', updated_at: 100 });
      for (const t of ['b', 'c', 'd', 'e']) await seedEdge(db, `e_${t}`, 'entity1', 'a', t);
    }, true); counts.parity++;

    await capture('anchor_exempt_from_gates', {
      description: 'anchor returned despite failing confidence+source_type gates', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1, minTraversalConfidence: 'certain', excludeSourceTypes: ['immutable_document'] },
      expectedNodeIds: ['a'],
    }, async (db) => {
      await seedEntry(db, { id: 'a', confidence: 'tentative', source_type: 'immutable_document' });
    }, true); counts.parity++;

    await capture('missing_source_empty', {
      description: 'missing sourceId returns empty', category: 'parity',
      entityId: 'entity1', sourceId: 'ghost', config: {},
      options: { sourceId: 'ghost', maxDepth: 1 },
      expectedNodeIds: [],
    }, async (db) => {
      await seedEntry(db, { id: 'a' });
    }, true); counts.parity++;

    await capture('foreign_entity_source_empty', {
      description: 'cross-entity sourceId returns empty', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1 },
      expectedNodeIds: [],
    }, async (db) => {
      await seedEntry(db, { id: 'a', entity_id: 'entity2' });
    }, true); counts.parity++;

    await capture('soft_deleted_source_empty', {
      description: 'soft-deleted sourceId returns empty', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1 },
      expectedNodeIds: [],
    }, async (db) => {
      await seedEntry(db, { id: 'a', deleted_at: 999 });
    }, true); counts.parity++;

    await capture('induced_edges_outside_discovery_filter', {
      description: 'induced edges include both-endpoint pairs regardless of discovery filter', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1, edgeTypes: ['mentions'] },

    }, async (db) => {
      await seedEntry(db, { id: 'a' }); await seedEntry(db, { id: 'b' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b', 'mentions');
      await seedEdge(db, 'e2', 'entity1', 'a', 'b', 'reports_to');
    }, true); counts.parity++;

    await capture('out_of_enum_source_type', {
      description: 'persisted out-of-enum source_type is opaque text (exclusion by exact equality only)', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 3, excludeSourceTypes: ['immutable_document'] },

    }, async (db) => {
      await seedEntry(db, { id: 'a' });
      await seedEntry(db, { id: 'b', source_type: 'some_future_kind' });
      await seedEntry(db, { id: 'c' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
      await seedEdge(db, 'e2', 'entity1', 'b', 'c');
    }, true); counts.parity++;

    await capture('cap_within_i64_accepts', {
      description: 'maxTraversalNodes 9.2e18 accepted and floored by both engines', category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1, maxTraversalNodes: 9.2e18 },

    }, async (db) => {
      await seedEntry(db, { id: 'a' }); await seedEntry(db, { id: 'b' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
    }, true); counts.parity++;

    await capture('capped_tie_group', {
      description: 'cap 2 with tied children: anchor prefix guaranteed; tied group membership validated, exact tie order not',
      category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1, maxTraversalNodes: 2 },
      expectedNodeIds: ['a'],
      eligibleTiedIds: ['b', 'c'],
      notes: 'Tie at the cap boundary: expectedNodeIds pins only the guaranteed anchor prefix; native must return exactly one member of eligibleTiedIds as the second node. Per REQ-SLICE-02 the engines need not choose the same tied subset.',
    }, async (db) => {
      await seedEntry(db, { id: 'a', updated_at: 1 });
      await seedEntry(db, { id: 'b', updated_at: 100 });
      await seedEntry(db, { id: 'c', updated_at: 100 });
      await seedEdge(db, 'e_b', 'entity1', 'a', 'b');
      await seedEdge(db, 'e_c', 'entity1', 'a', 'c');
    }, true); counts.parity++;

    await capture('cap_2to53_band', {
      description: 'maxTraversalNodes 9007199254740993 (2^53+1): f64 decode rounds to 2^53 in both engines',
      category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1, maxTraversalNodes: 9007199254740993 },
      expectedNodeIds: null,
      notes: 'Pins the f64-then-floor decode: JS Number(9007199254740993) === 9007199254740992; native serde f64 must round identically, then floor and accept (within i64 range). Native test asserts acceptance and the floor value, not the traversal output.',
    }, async (db) => {
      await seedEntry(db, { id: 'a' }); await seedEntry(db, { id: 'b' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
    }, true); counts.parity++;

    await capture('explicit_empty_exclude_source_types', {
      description: 'excludeSourceTypes [] excludes nothing (baseline NOT IN () is always-true)',
      category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1, excludeSourceTypes: [] },
      expectedNodeIds: ['a', 'b'],
      notes: 'REQ-SLICE-02 explicit-empty case: [] must be a no-op, distinct from listing types. Native may omit the predicate instead of binding an empty NOT IN.',
    }, async (db) => {
      await seedEntry(db, { id: 'a' }); await seedEntry(db, { id: 'b', source_type: 'immutable_document' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
    }, true); counts.parity++;

    await capture('time_derived_fact_fields', {
      description: 'hydration surfaces isStale/trustTier derived at read time',
      category: 'parity',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1 },
      expectedNodeIds: ['a', 'b'],
      captureFactProjections: true,
      notes: 'REQ-SLICE-02 time-derived fields: fixture pins the derived projection only ({id, isStale, trustTier}); full fact DTO parity is Task 9. stale_after 2020-01-01 epoch ms keeps isStale true for any current clock; okf_verified human: reviewer pins trustTier human-reviewed.',
    }, async (db) => {
      await seedEntry(db, { id: 'a' });
      await db.runAsync(
        `UPDATE llm_wiki_entries SET stale_after = ?, okf_verified = ? WHERE id = 'a'`,
        [1577836800000, JSON.stringify([{ by: 'human:reviewer-1', at: '2026-01-01T00:00:00.000Z' }])],
      );
      await seedEntry(db, { id: 'b' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
    }, true); counts.parity++;

    // --- declared differences --------------------------------------------
    await capture('fractional_depth_1_5', {
      description: 'fractional maxDepth 1.5: native unrounded bound reaches depth 2; baseline CTE expansion stops earlier',
      category: 'declared_difference',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1.5 },

      notes: 'Native (BFS, real-valued bound d=1.5): frontiers expand while k-1 < d, so depth-2 nodes are reached. Baseline CTE: w.depth < 1.5 admits expansion from depth 1, so depth-2 can also be reached — record baselineObservedNodeIds; native must reach a SUPERSET that includes depth-2 nodes. See plan declared-difference DD-2.',
    }, async (db) => {
      for (const id of ['a', 'b', 'c', 'd']) await seedEntry(db, { id });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
      await seedEdge(db, 'e2', 'entity1', 'b', 'c');
    }, true); counts.declared_difference++;

    await capture('comma_ids_cycle', {
      description: 'ids containing commas with a cycle: baseline visited-string delimiter vs native set guard',
      category: 'declared_difference',
      entityId: 'entity1', sourceId: 'a,b', config: {},
      options: { sourceId: 'a,b', maxDepth: 3, direction: 'both' },

      notes: 'Baseline guard instr(visited, \',id,\') may over-suppress when ids contain commas (delimiters collide). Native uses a collision-free visited set. expectedNativeNodeIds: [a,b] both returned, traversal terminates. Record baselineObservedNodeIds.',
    }, async (db) => {
      await seedEntry(db, { id: 'a,b' }); await seedEntry(db, { id: 'b,a' });
      await seedEdge(db, 'e1', 'entity1', 'a,b', 'b,a');
    }, true); counts.declared_difference++;

    // --- robustness -------------------------------------------------------
    await capture('cap_1e20', {
      description: 'maxTraversalNodes 1e20: native rejects unsupported_limit; baseline may accept or throw',
      category: 'robustness',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1, maxTraversalNodes: 1e20 },

      notes: 'Native: UnsupportedLimit (1e20 floor far exceeds i64::MAX). Baseline behavior recorded in notes/baselineObservedNodeIds.',
    }, async (db) => {
      await seedEntry(db, { id: 'a' }); await seedEntry(db, { id: 'b' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
    }, true); counts.robustness++;

    await capture('cap_9_3e18', {
      description: 'maxTraversalNodes 9.3e18: native rejects unsupported_limit (floor exceeds i64::MAX)',
      category: 'robustness',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: { sourceId: 'a', maxDepth: 1, maxTraversalNodes: 9.3e18 },

      notes: 'Native: UnsupportedLimit. 9.3e18 floors above i64::MAX (9.223372036854775807e18).',
    }, async (db) => {
      await seedEntry(db, { id: 'a' }); await seedEntry(db, { id: 'b' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b');
    }, true); counts.robustness++;

    await capture('oversized_edge_types', {
      description: 'edgeTypes with 150 entries: native chunks binds; baseline may hit variable limit',
      category: 'robustness',
      entityId: 'entity1', sourceId: 'a', config: {},
      options: {
        sourceId: 'a', maxDepth: 1,
        edgeTypes: Array.from({ length: 150 }, (_, i) => `type_${i}`),
      },

      notes: 'Native: chunked IN-lists preserve union semantics. Baseline binds 150 variables in one query — record observed behavior.',
    }, async (db) => {
      await seedEntry(db, { id: 'a' }); await seedEntry(db, { id: 'b' });
      await seedEdge(db, 'e1', 'entity1', 'a', 'b', 'type_0');
    }, true); counts.robustness++;

    // --- invariants over what was written ---------------------------------
    expect(counts.parity).toBe(22);
    expect(counts.declared_difference).toBe(2);
    expect(counts.robustness).toBe(3);

    let total = 0;
    for (const cat of ['parity', 'declared_difference', 'robustness'] as const) {
      const dir = join(FIXTURE_DIR, cat);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as FixtureEnvelope;
        expect(['parity', 'declared_difference', 'robustness']).toContain(raw.category);
        expect(typeof raw.description).toBe('string');
        expect(typeof raw.entityId).toBe('string');
        expect(typeof raw.sourceId).toBe('string');
        expect(raw.options).toBeTruthy();
        if (raw.expectedNodeIds !== null) expect(Array.isArray(raw.expectedNodeIds)).toBe(true);
        total++;
      }
    }
    expect(total).toBe(27);
  });
});
