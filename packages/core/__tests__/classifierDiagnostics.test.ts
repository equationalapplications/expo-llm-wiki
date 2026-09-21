import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { createWiki } from '../src/index';
import type { ClassifyResponse, OntologyManifest, WikiDiagnostic } from '../src/types';

const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [],
};

async function run(classify: (state: string) => Promise<ClassifyResponse>) {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const wiki = createWiki(db, {
    llmProvider: { generateText: async () => '{}', classify: async (r) => classify(r.state) },
    config: { ontology: { backfillClassifier: 'auto' } },
    onDiagnostic: (d) => { diagnostics.push(d); },
  });
  await wiki.setup();
  await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at)
     VALUES ('f1', 'e1', 'Secret Title', 'secret body', 'certain', 'user_stated', 1, 1)`,
  );
  await wiki.runOntologyBackfill('e1');
  return diagnostics;
}

describe('classification diagnostics', () => {
  it('low confidence → classification_low_confidence (info)', async () => {
    const d = await run(async () => ({ answers: { okf_type: { kind: 'choice', choice: 'person', confidence: 0.1, probabilities: {} } } }));
    expect(d).toEqual([expect.objectContaining({
      code: 'classification_low_confidence', severity: 'info', operation: 'ontologyBackfill', trigger: 'call', entityId: 'e1',
      detail: { factId: 'f1', reason: 'below_threshold' },
    })]);
  });

  it('invalid answer → classification_invalid with the rejection reason', async () => {
    const d = await run(async () => ({ answers: { okf_type: { kind: 'choice', choice: 'planet', confidence: 0.9, probabilities: {} } } }));
    expect(d).toEqual([expect.objectContaining({ code: 'classification_invalid', severity: 'warn', detail: { factId: 'f1', reason: 'choice_not_offered' } })]);
  });

  it('thrown classify → classification_invalid/classify_threw without the provider message', async () => {
    const d = await run(async () => { throw new Error('provider leaked secret body'); });
    expect(d).toEqual([expect.objectContaining({ code: 'classification_invalid', detail: { factId: 'f1', reason: 'classify_threw' } })]);
    expect(JSON.stringify(d)).not.toContain('secret');
  });

  it('accepted answers emit nothing', async () => {
    const d = await run(async () => ({ answers: { okf_type: { kind: 'choice', choice: 'person', confidence: 0.9, probabilities: {} } } }));
    expect(d).toEqual([]);
  });
});