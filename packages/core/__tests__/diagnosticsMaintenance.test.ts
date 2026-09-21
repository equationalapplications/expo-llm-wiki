import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode, expectNoContent } from './helpers/diagnosticsHarness';
import type { OntologyManifest } from '../src/types';

const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [{ type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Person lives in place' }],
};

afterEach(() => vi.restoreAllMocks());

describe('librarian diagnostics', () => {
  it('reports rejected facts, rejected tasks, fuzzy dedupe and dropped edges with trigger call', async () => {
    let calls = 0;
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => {
        calls++;
        if (calls === 1) {
          return JSON.stringify({
            facts: [{ title: 'Ada Lovelace wrote programs', body: 'first', tags: [], confidence: 'inferred' }],
            tasks: [],
          });
        }
        return JSON.stringify({
          facts: [
            { title: 7, body: 'bad' },
            { title: 'Ada Lovelace wrote programs', body: 'second insert', tags: [], confidence: 'inferred' },
            { title: 'Grace', body: 'g', tags: [], confidence: 'inferred', okf_type: 'person',
              edges: [{ edge_type: 'lives_in', target_title: 'Nowhere Land' }] },
          ],
          tasks: [{ description: '   ' }],
        });
      },
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    await wiki.write('e1', { event_type: 'observation', summary: 'event one' });
    await wiki.runLibrarian('e1');
    diagnostics.length = 0;
    await wiki.runLibrarian('e1');

    const base = { operation: 'librarian', trigger: 'call', entityId: 'e1' };
    expect(ofCode(diagnostics, 'fact_rejected')).toEqual([expect.objectContaining({ ...base, detail: { itemIndex: 0, reason: 'invalid_shape' } })]);
    expect(ofCode(diagnostics, 'task_rejected')).toEqual([expect.objectContaining({ ...base, detail: { itemIndex: 0, reason: 'missing_description' } })]);
    expect(ofCode(diagnostics, 'fact_deduplicated')).toEqual([expect.objectContaining({ ...base, detail: { itemIndex: 1, reason: 'fuzzy_title' } })]);
    const drops = ofCode(diagnostics, 'edge_dropped');
    expect(drops).toHaveLength(1);
    expect(drops[0].detail).toMatchObject({ reason: 'target_not_found', edgeType: 'lives_in', sourceNodeType: 'person' });
    expect(drops[0].detail?.factId).toMatch(/^fact_/);
    expectNoContent(diagnostics, ['Nowhere Land', 'second insert', 'Ada Lovelace']);
  });
});

describe('heal diagnostics', () => {
  it('reports heal_skipped for a candidate whose call errors, after commit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recent = Date.now();
    const { wiki, db, diagnostics } = await makeDiagnosticWiki({
      generateText: async ({ userPrompt }) => {
        if (userPrompt.includes('Heal Candidates')) throw new Error('provider down');
        return JSON.stringify({ facts: [], tasks: [] });
      },
    });
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
       VALUES ('h1', 'e1', 'Candidate', 'candidate body', '[]', 'inferred', 'librarian_inferred', ?, ?)`,
      [recent, recent],
    );
    await wiki.runHeal('e1');
    const skipped = ofCode(diagnostics, 'heal_skipped');
    expect(skipped).toEqual([
      expect.objectContaining({ operation: 'heal', trigger: 'call', entityId: 'e1', detail: { factId: 'h1', reason: 'call_error' } }),
    ]);
    expectNoContent(diagnostics, ['candidate body', 'provider down']);
  });

  it('numbers itemIndex within each heal batch response, not across batches', async () => {
    const recent = Date.now();
    const fact = (title: string) => ({ title, body: 'healed body', tags: [], confidence: 'inferred' });
    const { wiki, db, diagnostics } = await makeDiagnosticWiki({
      generateText: async ({ userPrompt }) => {
        if (userPrompt.includes('"h1"')) {
          return JSON.stringify({ downgraded: [], deleted: [], newFacts: [{ title: 7, body: 'bad one' }, fact('Alpha river')] });
        }
        return JSON.stringify({
          downgraded: [], deleted: [],
          newFacts: [fact('Beta mountain'), fact('Gamma forest'), { title: 8, body: 'bad two' }],
        });
      },
    });
    // Bodies sized so a 2-candidate prompt exceeds HEAL_MAX_PROMPT_CHARS and
    // runBatched sends one candidate per call (see healBounding.test.ts).
    const longBody = 'x'.repeat(21_000);
    for (const id of ['h1', 'h2']) {
      await db.runAsync(
        `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
         VALUES (?, 'e1', ?, ?, '[]', 'inferred', 'librarian_inferred', ?, ?)`,
        [id, `Candidate ${id}`, longBody, recent, recent],
      );
    }
    await wiki.runHeal('e1', { batchSize: 2 });
    const rejected = ofCode(diagnostics, 'fact_rejected');
    expect(rejected.map((d) => d.detail?.itemIndex).sort()).toEqual([0, 2]);
    for (const d of rejected) expect(d).toMatchObject({ operation: 'heal', trigger: 'call', detail: { reason: 'invalid_shape' } });
    expectNoContent(diagnostics, ['bad one', 'bad two', 'healed body', 'Alpha river']);
  });
});

describe('ontology backfill diagnostics', () => {
  it('reports edges dropped while applying classifications', async () => {
    const { wiki, db, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({
        classifications: [{ id: 'b1', okf_type: 'person', edges: [{ edge_type: 'lives_in', target_title: 'Unknown City' }] }],
      }),
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at)
       VALUES ('b1', 'e1', 'Ada', 'b', 'certain', 'user_stated', 1, 1)`,
    );
    await wiki.runOntologyBackfill('e1');
    expect(ofCode(diagnostics, 'edge_dropped')).toEqual([
      expect.objectContaining({
        operation: 'ontologyBackfill', trigger: 'call',
        detail: { reason: 'target_not_found', factId: 'b1', edgeType: 'lives_in', sourceNodeType: 'person' },
      }),
    ]);
  });
});
