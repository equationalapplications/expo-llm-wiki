import { describe, it, expect } from 'vitest';
import { PromptService } from '../../src/services/PromptService';
import {
  INGEST_SYSTEM_PROMPT,
  LIBRARIAN_SYSTEM_PROMPT,
  HEAL_SYSTEM_PROMPT,
  ONTOLOGY_BACKFILL_SYSTEM_PROMPT,
} from '../../src/prompts';
import { buildOntologyPromptAppendix } from '../../src/prompts/ontology';
import { buildTitleCatalogBlock } from '../../src/prompts';

describe('PromptService', () => {
  describe('buildIngestPrompt', () => {
    it('falls back to base INGEST_SYSTEM_PROMPT when no overrides', () => {
      const svc = new PromptService();
      const { systemPrompt, userPrompt } = svc.buildIngestPrompt('hello doc');
      expect(systemPrompt).toBe(INGEST_SYSTEM_PROMPT);
      expect(userPrompt).toBe('Document Chunk:\nhello doc');
    });

    it('uses global override over base', () => {
      const svc = new PromptService({ ingestSystemPrompt: 'global ingest' });
      const { systemPrompt } = svc.buildIngestPrompt('chunk');
      expect(systemPrompt).toBe('global ingest');
    });

    it('uses runtime override over global', () => {
      const svc = new PromptService({ ingestSystemPrompt: 'global ingest' });
      const { systemPrompt } = svc.buildIngestPrompt('chunk', 'runtime ingest');
      expect(systemPrompt).toBe('runtime ingest');
    });

    it('hydrates {{documentChunk}} into systemPrompt when present', () => {
      const svc = new PromptService();
      const template = 'Process this: {{documentChunk}}';
      const { systemPrompt, userPrompt } = svc.buildIngestPrompt('my content', template);
      expect(systemPrompt).toBe('Process this: my content');
      expect(userPrompt).toBe('Please extract the facts.');
    });

    it('leaves un-hydrated {{unknown}} tags intact', () => {
      const svc = new PromptService();
      const template = 'Data: {{documentChunk}} Extra: {{unknown}}';
      const { systemPrompt } = svc.buildIngestPrompt('val', template);
      expect(systemPrompt).toBe('Data: val Extra: {{unknown}}');
    });

    it('appends ontology instructions when context provided', () => {
      const svc = new PromptService();
      const ctx = {
        ontologyManifest: '{"node_types":[]}',
        ontologyModeInstructions: '## Ontology constraints\nSTRICT',
      };
      const { systemPrompt } = svc.buildIngestPrompt('chunk', undefined, ctx);
      expect(systemPrompt).toContain(INGEST_SYSTEM_PROMPT);
      expect(systemPrompt).toContain('## Ontology constraints');
    });

    it('leaves base prompt byte-identical when context is null', () => {
      const svc = new PromptService();
      const { systemPrompt } = svc.buildIngestPrompt('chunk', undefined, null);
      expect(systemPrompt).toBe(INGEST_SYSTEM_PROMPT);
    });

    it('hydrates {{ontologyModeInstructions}} without duplicate append', () => {
      const svc = new PromptService();
      const ctx = {
        ontologyManifest: '{"node_types":[]}',
        ontologyModeInstructions: '## Ontology constraints\nSTRICT',
      };
      const template = 'Custom: {{ontologyModeInstructions}}';
      const { systemPrompt } = svc.buildIngestPrompt('chunk', template, ctx);
      expect(systemPrompt).toBe('Custom: ## Ontology constraints\nSTRICT');
      expect(systemPrompt.match(/## Ontology constraints/g)?.length).toBe(1);
    });

    it('strips ontology placeholders when context is absent', () => {
      const svc = new PromptService();
      const template = 'Custom: {{ontologyModeInstructions}} {{ontologyManifest}}';
      const { systemPrompt } = svc.buildIngestPrompt('chunk', template, null);
      expect(systemPrompt).toBe('Custom:  ');
      expect(systemPrompt).not.toMatch(/\{\{/);
    });

    it('strips nested ontology placeholders completely when context is absent', () => {
      const svc = new PromptService();
      const template = '{{{{ontologyManifest}}ontologyManifest}}';
      const { systemPrompt } = svc.buildIngestPrompt('chunk', template, null);
      expect(systemPrompt).toBe('');
    });

    it('never strips placeholder-like text from hydrated variable values', () => {
      const svc = new PromptService();
      const template = 'Doc: {{documentChunk}} {{ontologyModeInstructions}}';
      const { systemPrompt } = svc.buildIngestPrompt('quote {{ontologyManifest}} here', template, null);
      expect(systemPrompt).toBe('Doc: quote {{ontologyManifest}} here ');
    });
  });

  describe('buildLibrarianPrompt', () => {
    it('falls back to base LIBRARIAN_SYSTEM_PROMPT', () => {
      const svc = new PromptService();
      const { systemPrompt, userPrompt } = svc.buildLibrarianPrompt([{ id: 'e1' }], [{ id: 'f1' }]);
      expect(systemPrompt).toBe(LIBRARIAN_SYSTEM_PROMPT);
      expect(userPrompt).toContain('Events:');
      expect(userPrompt).toContain('Current Facts:');
    });

    it('ignores the removed librarianSystemPrompt config key', () => {
      // @ts-expect-error librarianSystemPrompt was removed in 9.0.0
      const svc = new PromptService({ librarianSystemPrompt: 'global lib' });
      const { systemPrompt } = svc.buildLibrarianPrompt([], []);
      expect(systemPrompt).toBe(LIBRARIAN_SYSTEM_PROMPT);
    });

    it('uses runtime override', () => {
      const svc = new PromptService();
      const { systemPrompt } = svc.buildLibrarianPrompt([], [], 'runtime lib');
      expect(systemPrompt).toBe('runtime lib');
    });

    it('hydrates {{events}} and {{currentFacts}} into systemPrompt', () => {
      const svc = new PromptService();
      const events = [{ id: 'e1', summary: 'did thing' }];
      const facts = [{ id: 'f1', title: 'fact one' }];
      const template = 'Events: {{events}} Facts: {{currentFacts}}';
      const { systemPrompt, userPrompt } = svc.buildLibrarianPrompt(events, facts, template);
      expect(systemPrompt).toContain('"did thing"');
      expect(systemPrompt).toContain('"fact one"');
      expect(userPrompt).toBe('Please synthesize the context.');
    });

    it('leaves un-hydrated {{unknown}} tags intact', () => {
      const svc = new PromptService();
      const template = 'Events: {{events}} Extra: {{unknown}}';
      const { systemPrompt } = svc.buildLibrarianPrompt([{ id: 'e1' }], [], template);
      expect(systemPrompt).toContain('{{unknown}}');
    });
  });

  describe('buildHealPrompt', () => {
    it('falls back to base HEAL_SYSTEM_PROMPT', () => {
      const svc = new PromptService();
      const { prompts } = svc.buildHealPrompt([], [], [], [], undefined, 0);
      expect(prompts.systemPrompt).toBe(HEAL_SYSTEM_PROMPT);
      expect(prompts.userPrompt).toContain('Heal Candidates:');
    });

    it('uses global healSystemPrompt override', () => {
      const svc = new PromptService({ healSystemPrompt: 'global heal' });
      const { prompts } = svc.buildHealPrompt([], [], [], [], undefined, 0);
      expect(prompts.systemPrompt).toBe('global heal');
    });

    it('uses runtime override over global', () => {
      const svc = new PromptService({ healSystemPrompt: 'global heal' });
      const { prompts } = svc.buildHealPrompt([], [], [], [], 'runtime heal', 0);
      expect(prompts.systemPrompt).toBe('runtime heal');
    });

    it('hydrates {{healCandidates}} into systemPrompt', () => {
      const svc = new PromptService();
      const candidates = [{ id: 'f1', title: 'stale fact' }];
      const template = 'Candidates: {{healCandidates}}';
      const { prompts } = svc.buildHealPrompt(candidates, [], [], [], template, 0);
      expect(prompts.systemPrompt).toContain('"stale fact"');
      expect(prompts.userPrompt).toBe('Please heal the memory graph.');
    });

    it('leaves un-hydrated {{unknown}} tags intact', () => {
      const svc = new PromptService();
      const template = 'Candidates: {{healCandidates}} Extra: {{unknown}}';
      const { prompts } = svc.buildHealPrompt([{ id: 'f1' }], [], [], [], template, 0);
      expect(prompts.systemPrompt).toContain('{{unknown}}');
    });

    it('hydrates {{recentEvents}} even without primary heal variables', () => {
      const svc = new PromptService();
      const events = [{ id: 'ev1', summary: 'recent thing' }];
      const template = 'Recent: {{recentEvents}}';
      const { prompts } = svc.buildHealPrompt([], [], [], events, template, 0);
      expect(prompts.systemPrompt).toContain('"recent thing"');
      expect(prompts.userPrompt).toBe('Please heal the memory graph.');
    });
  });

  describe('buildOntologyBackfillPrompt', () => {
    const facts = [{ id: 'fact_1', title: 'T', body: 'B', tags: [] }];

    it('uses default prompt with facts in userPrompt and ontology context appended', () => {
      const svc = new PromptService();
      const ctx = buildOntologyPromptAppendix('strict', '{"node_types":[],"edge_types":[]}');
      const { systemPrompt, userPrompt } = svc.buildOntologyBackfillPrompt(facts, undefined, ctx);
      expect(systemPrompt).toContain(ONTOLOGY_BACKFILL_SYSTEM_PROMPT);
      expect(systemPrompt).toContain(ctx.ontologyModeInstructions);
      expect(userPrompt).toContain('fact_1');
    });

    it('runtime override wins over global override', () => {
      const svc = new PromptService({ ontologyBackfillSystemPrompt: 'GLOBAL' });
      expect(svc.buildOntologyBackfillPrompt(facts, 'RUNTIME').systemPrompt).toContain('RUNTIME');
      expect(svc.buildOntologyBackfillPrompt(facts).systemPrompt).toContain('GLOBAL');
    });

    it('hydrates {{facts}} placeholder into systemPrompt', () => {
      const svc = new PromptService();
      const { systemPrompt, userPrompt } = svc.buildOntologyBackfillPrompt(facts, 'Classify: {{facts}}');
      expect(systemPrompt).toContain('fact_1');
      expect(userPrompt).toBe('Please classify the facts.');
    });
  });

  describe('buildOntologyBackfillPrompt title catalog (#381)', () => {
    const facts = [{ id: 'fact_1', title: 'T', body: 'B', tags: [] }];

    it('splices the catalog between the base prompt and the ontology appendix', () => {
      const svc = new PromptService();
      const ctx = buildOntologyPromptAppendix('strict', '{"node_types":[],"edge_types":[]}');
      const { systemPrompt, userPrompt } = svc.buildOntologyBackfillPrompt(facts, undefined, ctx, 'TITLE CATALOG: x');
      const base = systemPrompt.indexOf(ONTOLOGY_BACKFILL_SYSTEM_PROMPT);
      const cat = systemPrompt.indexOf('TITLE CATALOG: x');
      const appendix = systemPrompt.indexOf(ctx.ontologyModeInstructions);
      expect(cat).toBeGreaterThan(base);
      expect(appendix).toBeGreaterThan(cat);
      expect(userPrompt).toContain('fact_1');
    });

    it('omits the catalog when none is supplied (baseline prompt unchanged)', () => {
      const svc = new PromptService();
      const ctx = buildOntologyPromptAppendix('strict', '{"node_types":[],"edge_types":[]}');
      const { systemPrompt } = svc.buildOntologyBackfillPrompt(facts, undefined, ctx);
      expect(systemPrompt).not.toContain('TITLE CATALOG');
    });

    it('placeholder templates keep skipping the catalog (documented M5 limitation, locked by test)', () => {
      const svc = new PromptService();
      const ctx = buildOntologyPromptAppendix('strict', '{"node_types":[],"edge_types":[]}');
      const { systemPrompt, userPrompt } = svc.buildOntologyBackfillPrompt(facts, 'Classify: {{facts}}', ctx, 'TITLE CATALOG: x');
      expect(systemPrompt).not.toContain('TITLE CATALOG: x');
      expect(systemPrompt).toContain('fact_1');
      expect(userPrompt).toBe('Please classify the facts.');
    });
  });

  describe('buildTitleCatalogBlock (#381)', () => {
    it('formats typed rows verbatim, skips untyped rows, sorts by code point', () => {
      const block = buildTitleCatalogBlock([
        { title: 'Orbit', okf_type: 'software_application' },
        { title: 'Draft', okf_type: null },
        { title: 'Acme Labs', okf_type: 'organization' },
      ]);
      expect(block).toContain('TITLE CATALOG: existing typed nodes in this memory include:');
      expect(block).toContain('- "Orbit" (software_application)');
      expect(block).toContain('- "Acme Labs" (organization)');
      expect(block).not.toContain('Draft');
      expect(block.indexOf('"Acme Labs"')).toBeLessThan(block.indexOf('"Orbit"'));
      // Non-exclusive wording (review M1): same-batch targets stay valid, so
      // the block must not claim catalog membership is the only validity.
      expect(block).not.toContain('valid only if');
      expect(block).toContain('classified in this same response');
    });

    it('dedupes last-wins on the normalized key, matching edge resolution', () => {
      const block = buildTitleCatalogBlock([
        { title: 'Orbit', okf_type: 'software_application' },
        { title: 'orbit ', okf_type: 'software_application' },
        { title: 'Deploy', okf_type: 'area' },
      ]);
      // Last row per key wins (Map.set semantics, like the resolution index).
      expect(block).toContain('- "orbit " (software_application)');
      expect(block).not.toContain('- "Orbit" (software_application)');
      expect(block).toContain('- "Deploy" (area)');
    });

    it('last-wins dedupe keeps the resolvable node type when same-key rows differ in type', () => {
      const block = buildTitleCatalogBlock([
        { title: 'Orbit', okf_type: 'software_application' },
        { title: 'orbit', okf_type: 'area' },
      ]);
      // Resolution targets the area node, so the catalog must show area.
      expect(block.match(/"orbit"/g)?.length).toBe(1);
      expect(block).toContain('- "orbit" (area)');
      expect(block).not.toContain('(software_application)');
    });

    it('caps the catalog by characters as well as entries (payload budget, sonnet N3)', () => {
      const rows = Array.from({ length: 200 }, (_, i) => ({
        title: `T${String(i).padStart(3, '0')}-${'x'.repeat(200)}`,
        okf_type: 'area' as const,
      }));
      const block = buildTitleCatalogBlock(rows);
      // 200 entries x ~230 chars would be ~46k chars; the block is bounded.
      expect(block.length).toBeLessThan(9000);
      expect(block).toContain('This list is truncated');
    });

    it('escapes titles through JSON.stringify', () => {
      const block = buildTitleCatalogBlock([{ title: 'Weird "quoted" title', okf_type: 'area' }]);
      expect(block).toContain('- "Weird \\"quoted\\" title" (area)');
    });

    it('caps the catalog at 200 entries and discloses the truncation', () => {
      const rows = Array.from({ length: 250 }, (_, i) => ({ title: `n${String(i).padStart(3, '0')}`, okf_type: 'area' as const }));
      const block = buildTitleCatalogBlock(rows);
      expect(block).toContain('"n199"');
      expect(block).not.toContain('"n200"');
      expect(block).toContain('This list is truncated');
    });

    it('returns an empty catalog note that still allows same-batch targets', () => {
      const block = buildTitleCatalogBlock([{ title: 'Draft', okf_type: null }]);
      expect(block).toContain('TITLE CATALOG: this memory contains no typed nodes yet');
      expect(block).toContain('omit "edges" rather than invent a target_title');
      expect(block).toContain('classified in this same response');
    });
  });

  describe('system prompts: JSON-escape discipline (issue #92)', () => {
    it('INGEST_SYSTEM_PROMPT mentions re-escaping source quotes and embedded newlines', () => {
      expect(INGEST_SYSTEM_PROMPT).toContain('re-escape');
      // The new sentence names both escape sequences explicitly per spec §6.
      expect(INGEST_SYSTEM_PROMPT).toMatch(/\\"/);
      expect(INGEST_SYSTEM_PROMPT).toMatch(/\\n/);
    });

    it('ONTOLOGY_BACKFILL_SYSTEM_PROMPT instructs the model to preserve existing JSON escapes when echoing titles', () => {
      expect(ONTOLOGY_BACKFILL_SYSTEM_PROMPT).toContain('preserve every JSON escape');
    });

    it('LIBRARIAN_SYSTEM_PROMPT and HEAL_SYSTEM_PROMPT are unchanged', () => {
      // Sanity guard — these prompts do not process verbatim source prose, so
      // they MUST NOT have been touched by this change. We assert on a stable
      // substring of each.
      expect(LIBRARIAN_SYSTEM_PROMPT).toContain('knowledge extraction agent');
      expect(HEAL_SYSTEM_PROMPT).toContain('memory grooming agent');
    });
  });
});

describe('ontology prompt — parent_type advertisement', () => {
  it('emergent ontology_updates schema advertises the optional parent_type field', () => {
    const { ontologyModeInstructions } = buildOntologyPromptAppendix(
      'emergent', '{"node_types":[],"edge_types":[]}',
    );
    expect(ontologyModeInstructions).toContain('"parent_type"');
  });

  it('strict mode instructions do not propose types (unchanged)', () => {
    const { ontologyModeInstructions } = buildOntologyPromptAppendix(
      'strict', '{"node_types":[],"edge_types":[]}',
    );
    expect(ontologyModeInstructions).not.toContain('ontology_updates');
  });
});
