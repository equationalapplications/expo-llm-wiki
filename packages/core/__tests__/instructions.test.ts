import { describe, it, expect } from 'vitest';
import { makeDiagnosticWiki } from './helpers/diagnosticsHarness';
import { PromptService } from '../src/services/PromptService';
import { HEAL_SYSTEM_PROMPT, INGEST_SYSTEM_PROMPT } from '../src/prompts';
import type { OntologyManifest } from '../src/types';

const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }],
  edge_types: [],
};

describe('getInstructions', () => {
  it('returns defaults with no ontology block when ontology is off', async () => {
    const { wiki } = await makeDiagnosticWiki();
    const out = await wiki.getInstructions('e1');
    expect(Object.keys(out).sort()).toEqual(['heal', 'ingest', 'librarian', 'ontologyBackfill']);
    expect(out.ingest).toBe(INGEST_SYSTEM_PROMPT);
    expect(out.heal).toBe(HEAL_SYSTEM_PROMPT);
  });

  it('matches the system prompt each writer actually sends, ontology block included', async () => {
    const { wiki, generateText } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [], tasks: [] }),
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: 'a'.repeat(64), documentChunk: 'SECRET CHUNK TEXT' }).catch(() => {});
    await wiki.write('e1', { event_type: 'observation', summary: 'SECRET EVENT TEXT' });
    await wiki.runLibrarian('e1');
    const sent = generateText.mock.calls.map(([p]) => p.systemPrompt);
    const out = await wiki.getInstructions('e1');
    expect(out.ingest).toContain('## Ontology constraints');
    expect(sent).toContain(out.ingest);
    expect(sent).toContain(out.librarian);
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('applies overrides verbatim and leaves data placeholders unhydrated', async () => {
    const { wiki } = await makeDiagnosticWiki({
      config: { prompts: {
        ingestSystemPrompt: 'Ingest {{documentChunk}} under {{ontologyModeInstructions}}',
        healSystemPrompt: 'Heal {{healCandidates}} with {{recentEvents}}',
      } },
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    const out = await wiki.getInstructions('e1');
    expect(out.ingest.startsWith('Ingest {{documentChunk}} under ## Ontology constraints')).toBe(true);
    expect(out.heal).toBe('Heal {{healCandidates}} with {{recentEvents}}');
  });

  it('PromptService equivalence: instruction templates equal the runtime system prompts for default templates', () => {
    const svc = new PromptService();
    const ctx = { ontologyManifest: '{}', ontologyModeInstructions: 'ONTOLOGY' };
    const t = svc.buildInstructionTemplates(ctx);
    expect(t.ingest).toBe(svc.buildIngestPrompt('chunk', undefined, ctx).systemPrompt);
    expect(t.librarian).toBe(svc.buildLibrarianPrompt([], [], undefined, ctx).systemPrompt);
    expect(t.heal).toBe(svc.buildHealPrompt([{ id: 'c' }], [], [], [], undefined, 0).prompts.systemPrompt);
    expect(t.ontologyBackfill).toBe(svc.buildOntologyBackfillPrompt([], undefined, ctx).systemPrompt);
  });
});