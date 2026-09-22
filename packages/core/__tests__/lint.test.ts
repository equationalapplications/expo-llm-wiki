import { describe, it, expect } from 'vitest';
import { makeDiagnosticWiki } from './helpers/diagnosticsHarness';
import type { OntologyManifest, SQLiteAdapter } from '../src/types';

const MANIFEST: OntologyManifest = {
  node_types: [
    { type: 'person', description: 'A person' },
    { type: 'employee', description: 'An employed person', parent_type: 'person' },
    { type: 'place', description: 'A place' },
  ],
  edge_types: [{ type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Lives in' }],
};

async function fact(db: SQLiteAdapter, id: string, o: { entity?: string; type?: string | null; status?: string; source?: string; verified?: string | null; deleted?: boolean } = {}) {
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, okf_type, lifecycle_status, okf_verified, deleted_at)
     VALUES (?, ?, ?, 'body', '[]', 'certain', ?, ?, ?, ?, ?, ?, ?)`,
    [id, o.entity ?? 'e1', `title ${id}`, o.source ?? 'immutable_document', now, now, o.type === undefined ? 'person' : o.type,
      o.status ?? 'stable', o.verified ?? null, o.deleted ? now : null],
  );
}
async function edge(db: SQLiteAdapter, id: string, source: string, target: string, type = 'lives_in', entity = 'e1') {
  await db.runAsync(
    `INSERT INTO llm_wiki_edges (id, entity_id, source_id, target_id, edge_type, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, entity, source, target, type, Date.now()],
  );
}
const totalChanges = async (db: SQLiteAdapter) => (await db.getFirstAsync<{ n: number }>('SELECT total_changes() AS n'))!.n;

async function fixture(config = {}) {
  const h = await makeDiagnosticWiki({ config });
  const { db } = h;
  await fact(db, 'p1');
  await fact(db, 'p2');
  await fact(db, 'emp', { type: 'employee' });
  await fact(db, 'pl', { type: 'place' });
  await fact(db, 'u1', { type: null });
  await fact(db, 'gone', { deleted: true });
  await fact(db, 'foreign', { entity: 'e2', type: 'place' });
  await fact(db, 'd1', { status: 'draft' });
  await fact(db, 'inf1', { source: 'librarian_inferred' });
  await fact(db, 'inf2', { source: 'librarian_inferred', verified: '[]' });
  await fact(db, 'inf3', { source: 'librarian_inferred', verified: '[{"by":"human:a","at":"2026-01-01T00:00:00Z"}]' });
  await fact(db, 'inf4', { source: 'librarian_inferred', deleted: true });
  await edge(db, 'e_ok', 'p1', 'pl');
  await edge(db, 'e_parent', 'emp', 'pl');           // employee satisfies person
  await edge(db, 'e_badtype', 'p1', 'p2', 'knows');  // edge type not in manifest
  await edge(db, 'e_badtarget', 'p1', 'p2');         // target type mismatch
  await edge(db, 'e_untyped', 'u1', 'pl');           // untyped source
  await edge(db, 'e_ghost', 'p1', 'ghost');          // missing target
  await edge(db, 'e_gone', 'gone', 'pl');            // soft-deleted source
  await edge(db, 'e_foreign', 'p1', 'foreign');      // target owned by another entity
  await edge(db, 'x_other', 'foreign', 'foreign', 'lives_in', 'e2'); // other entity's edge
  return h;
}

describe('lint', () => {
  it('reports every count, entity-scoped, with sorted samples', async () => {
    const { wiki } = await fixture();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    expect(await wiki.lint('e1')).toEqual({
      danglingEdges: 3,
      manifestViolations: 3,
      untypedFacts: 1,
      drafts: 1,
      unverifiedInferred: 2,
      sample: {
        danglingEdgeIds: ['e_foreign', 'e_ghost', 'e_gone'],
        manifestViolationEdgeIds: ['e_badtarget', 'e_badtype', 'e_untyped'],
      },
    });
  });

  it('reports no manifest violations with ontology off or an empty manifest', async () => {
    const { wiki } = await fixture();
    expect((await wiki.lint('e1')).manifestViolations).toBe(0);
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'off' });
    expect((await wiki.lint('e1')).manifestViolations).toBe(0);
  });

  it('pages through more edges than one page and caps samples at 20', async () => {
    const { wiki, db } = await fixture();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    for (let i = 0; i < 1100; i++) await edge(db, `v${String(i).padStart(4, '0')}`, 'p1', 'p2', `bad_${i}`);
    for (let i = 0; i < 30; i++) await edge(db, `g${String(i).padStart(2, '0')}`, 'p1', `ghost${i}`);
    const report = await wiki.lint('e1');
    expect(report.manifestViolations).toBe(1103);
    expect(report.danglingEdges).toBe(33);
    expect(report.sample.manifestViolationEdgeIds).toHaveLength(20);
    expect(report.sample.manifestViolationEdgeIds[0]).toBe('e_badtarget');
    expect(report.sample.danglingEdgeIds).toEqual([...report.sample.danglingEdgeIds].sort());
    expect(report.sample.danglingEdgeIds).toHaveLength(20);
  });

  it('is read-only, including for a seed manifest', async () => {
    const { wiki, db } = await fixture({ ontology: { seedManifests: { e1: { manifest: MANIFEST, mode: 'strict' } } } });
    const before = await totalChanges(db);
    const report = await wiki.lint('e1');
    expect(report.manifestViolations).toBe(3);
    expect(await totalChanges(db)).toBe(before);
    // Pre-authorized ruling: the real table is `${prefix}entity_manifests` (schema.ts:113)
    // and the real manifest column is `manifest_json` (MetadataRepository.ts:145). A seed
    // manifest is cached only, never persisted.
    expect(await db.getFirstAsync(`SELECT 1 AS x FROM llm_wiki_entity_manifests WHERE entity_id = 'e1' AND manifest_json IS NOT NULL`)).toBeFalsy();
  });

  it('lets a child type satisfy the target side and matches edge types case-insensitively', async () => {
    const { wiki, db } = await makeDiagnosticWiki();
    await fact(db, 'p1');
    await fact(db, 'emp', { type: 'employee' });
    await edge(db, 'k1', 'p1', 'emp', 'knows');
    await edge(db, 'k2', 'p1', 'emp', 'KNOWS');
    const knows = { type: 'knows', source_type: 'person', target_type: 'person', description: 'Knows' };
    await wiki.setOntologyManifest('e1', { ...MANIFEST, edge_types: [...MANIFEST.edge_types, knows] }, { mode: 'strict' });
    expect((await wiki.lint('e1')).manifestViolations).toBe(0);
  });

  it('counts every live edge as a violation when the manifest has node types but no edge types', async () => {
    const { wiki } = await fixture();
    await wiki.setOntologyManifest('e1', { node_types: MANIFEST.node_types, edge_types: [] }, { mode: 'strict' });
    const report = await wiki.lint('e1');
    // Live, non-dangling edges only: e_ok, e_parent, e_badtype, e_badtarget, e_untyped.
    expect(report.manifestViolations).toBe(5);
    expect(report.danglingEdges).toBe(3);
  });

  it('counts okf_verified that is invalid JSON or not an array as unverified', async () => {
    const { wiki, db } = await fixture();
    await fact(db, 'inf5', { source: 'librarian_inferred', verified: 'not json' });
    await fact(db, 'inf6', { source: 'librarian_inferred', verified: '{"by":"human:a"}' });
    expect((await wiki.lint('e1')).unverifiedInferred).toBe(4);
  });

  it('rejects a non-string or empty entityId', async () => {
    const { wiki } = await makeDiagnosticWiki();
    const lint = wiki.lint as (e: unknown) => Promise<unknown>;
    await expect(lint.call(wiki, {})).rejects.toThrow(/^Invalid entityId/);
    await expect(lint.call(wiki, 123)).rejects.toThrow(/^Invalid entityId/);
    await expect(lint.call(wiki, '')).rejects.toThrow(/^Invalid entityId/);
  });

  it('returns zeros for an empty entity', async () => {
    const { wiki } = await makeDiagnosticWiki();
    expect(await wiki.lint('empty')).toEqual({
      danglingEdges: 0, manifestViolations: 0, untypedFacts: 0, drafts: 0, unverifiedInferred: 0,
      sample: { danglingEdgeIds: [], manifestViolationEdgeIds: [] },
    });
  });
});
