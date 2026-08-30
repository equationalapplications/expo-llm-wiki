import { describe, it, expect, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { createWiki } from '../src/index';
import type { OntologyManifest, SQLiteAdapter } from '../src/types';

// `wiki.setup()` runs the migrations, so there is no `setupDatabase` import
// here — this mirrors `makeWiki` in ontologyBackfill.test.ts.
const PREFIX = 'llm_wiki_';

const PARENT_MANIFEST: OntologyManifest = {
  node_types: [
    { type: 'creativework', description: 'Parent content type.' },
    { type: 'design_spec', description: 'A design spec.', parent_type: 'creativework' },
    { type: 'person', description: 'A person.' },
  ],
  edge_types: [
    { type: 'about', source_type: 'creativework', target_type: 'person', description: 'subject' },
  ],
};

async function makeParentWiki(mode: 'strict' | 'emergent' | 'off' = 'strict') {
  const db = openTestDatabase();
  const generateText = vi.fn<any>();
  const wiki = createWiki(db, { llmProvider: { generateText } } as any);
  await wiki.setup();
  await wiki.setOntologyManifest('e1', PARENT_MANIFEST, { mode });
  return { db, wiki, generateText };
}

async function seedEntry(db: SQLiteAdapter, opts: {
  id: string; title?: string; okfType?: string | null;
}): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries
       (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at,
        access_count, deleted_at, okf_type, ontology_checked_at)
     VALUES (?, 'e1', ?, ?, '[]', 'certain', 'user_stated', 1000, 1000, 0, NULL, ?, NULL)`,
    [opts.id, opts.title ?? `title ${opts.id}`, `body ${opts.id}`, opts.okfType ?? null],
  );
}

describe('ontology parent inheritance — end to end', () => {
  it('a parent_type-bearing manifest survives the persist/validate/parse round-trip', async () => {
    const { wiki } = await makeParentWiki('strict');
    const state = await wiki.getOntologyManifest('e1');
    expect(state).not.toBeNull();
    expect(state!.manifest.node_types.find(n => n.type === 'design_spec')?.parent_type)
      .toBe('creativework');
  });

  it('setOntologyManifest rejects a two-level chain at the public API boundary', async () => {
    const db = openTestDatabase();
    const wiki = createWiki(db, { llmProvider: { generateText: async () => '{}' } } as any);
    await wiki.setup();
    await expect(wiki.setOntologyManifest('e1', {
      node_types: [
        { type: 'thing', description: 'root' },
        { type: 'creativework', description: 'mid', parent_type: 'thing' },
        { type: 'design_spec', description: 'leaf', parent_type: 'creativework' },
      ],
      edge_types: [],
    }, { mode: 'strict' })).rejects.toThrow(/Parent chain too deep/);
  });

  it('backfill types a fact with a child type and persists a parent-declared edge', async () => {
    const { db, wiki, generateText } = await makeParentWiki('strict');
    await seedEntry(db, { id: 'fact_spec', title: 'Checkout Redesign', okfType: null });
    await seedEntry(db, { id: 'fact_jane', title: 'Jane Doe', okfType: 'person' });

    generateText.mockResolvedValue(JSON.stringify({
      classifications: [{
        id: 'fact_spec',
        okf_type: 'design_spec',
        edges: [{ edge_type: 'about', target_title: 'Jane Doe' }],
      }],
    }));

    const result = await wiki.runOntologyBackfill('e1');
    expect(result.scanned).toBe(1);

    const typed = await db.getFirstAsync<{ okf_type: string }>(
      `SELECT okf_type FROM ${PREFIX}entries WHERE id = 'fact_spec'`);
    expect(typed!.okf_type).toBe('design_spec');

    const edgeRows = await db.getAllAsync<{ edge_type: string; target_id: string }>(
      `SELECT edge_type, target_id FROM ${PREFIX}edges WHERE source_id = 'fact_spec'`);
    expect(edgeRows).toEqual([{ edge_type: 'about', target_id: 'fact_jane' }]);
  });

  it('a hallucinated emergent parent_type does not abort the run (D6)', async () => {
    const { db, wiki, generateText } = await makeParentWiki('emergent');
    await seedEntry(db, { id: 'fact_x', title: 'Some Fact', okfType: null });

    generateText.mockResolvedValue(JSON.stringify({
      classifications: [{ id: 'fact_x', okf_type: 'design_spec', edges: [] }],
      ontology_updates: {
        node_types: [{ type: 'runbook', description: 'A runbook.', parent_type: 'no_such_type' }],
        edge_types: [],
      },
    }));

    await expect(wiki.runOntologyBackfill('e1')).resolves.toBeDefined();

    const state = await wiki.getOntologyManifest('e1');
    const runbook = state!.manifest.node_types.find(n => n.type === 'runbook');
    // Merged as a top-level type with the bad parent dropped — not rejected,
    // not throwing out of validateManifest inside the transaction.
    if (runbook) expect(runbook.parent_type).toBeUndefined();
  });
});
