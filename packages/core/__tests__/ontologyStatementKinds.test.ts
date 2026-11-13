import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiStrictOntologyViolation } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { OntologyManifest } from '../src/types';

// Inline mirror of the schema-software-org statement-kinds shape. Core never
// imports the schema package. `handoff` is deliberately absent: it was dropped
// in 9.0.0, so a strict write of it must be rejected as out-of-manifest.
const MANIFEST: OntologyManifest = {
  node_types: [
    { type: 'organization', description: 'An organization.' },
    { type: 'software_application', description: 'Software the organization ships.' },
    { type: 'area', description: 'A named part of a software_application.' },
    { type: 'statement', description: 'Abstract parent of the statement kinds.' },
    { type: 'rule', parent_type: 'statement', description: 'A situation and what to do.' },
    { type: 'decision', parent_type: 'statement', description: 'What was chosen and why.' },
  ],
  edge_types: [
    { type: 'about', source_type: 'statement', target_type: 'area', description: 'Attaches a statement to an area.' },
    { type: 'about', source_type: 'statement', target_type: 'software_application', description: 'Attaches a statement to an app.' },
    { type: 'about', source_type: 'statement', target_type: 'organization', description: 'Attaches a statement to the org.' },
  ],
};

describe('statement kinds — strict-mode write path (spec test plan item 5)', () => {
  async function seeded() {
    const wiki = new WikiMemory(openTestDatabase(), { llmProvider: { generateText: async () => '{}' } });
    await wiki.setup();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    return wiki;
  }

  it('rejects the removed handoff type under strict', async () => {
    const wiki = await seeded();
    await expect(wiki.remember('e1', { title: 'T', body: 'B', okf_type: 'handoff' }))
      .rejects.toBeInstanceOf(WikiStrictOntologyViolation);
  });

  it('accepts the abstract statement type under strict (documented prompt-only residual)', async () => {
    const wiki = await seeded();
    const fact = await wiki.remember('e1', { title: 'T', body: 'B', okf_type: 'statement' });
    expect(fact.okf_type).toBe('statement');
  });

  it('accepts a concrete kind under strict', async () => {
    const wiki = await seeded();
    expect((await wiki.remember('e1', { title: 'T', body: 'B', okf_type: 'rule' })).okf_type).toBe('rule');
  });
});
