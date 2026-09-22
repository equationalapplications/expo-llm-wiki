import { describe, it, expect } from 'vitest';
import { PromptService } from '../src/services/PromptService';
import { resolveGrounding } from '../src/utils/grounding';
import { HEAL_ANCHOR_BODY_CHARS } from '../src/utils/healConstants';
import type { OntologyPromptContext } from '../src/types';

const MARK = 'EVIDENCE REQUIREMENT';
const all = resolveGrounding({ mode: 'draft', writers: ['ingest', 'librarian', 'heal'] });
const ingestOnly = resolveGrounding({ mode: 'draft' });
const ctx = { ontologyManifest: '{}', ontologyModeInstructions: 'ONTOLOGY MODE TEXT' } as OntologyPromptContext;

const candidates = [{ id: 'c1', title: 'Candidate', body: 'candidate body text that is long enough' }];
const events = [{ id: 'evt_1', event_type: 'observation', summary: 'Operator observed the engine printing tables', created_at: 1 }];
const anchors = [
  { id: 'a1', title: 'Stable anchor', source_ref: 'doc.md', body: 'x'.repeat(HEAL_ANCHOR_BODY_CHARS + 200), lifecycle_status: 'stable' },
  { id: 'a2', title: 'Draft anchor', source_ref: 'doc.md', body: 'draft anchor body sentence here', lifecycle_status: 'draft' },
];

// Corpus parts are normalized (no newlines), so joining on '\n' keeps
// substring assertions per-part: a hit can never span two parts.
const joinedCorpus = (corpus: readonly string[] | undefined) => corpus?.join('\n') ?? '';

function allPrompts(svc: PromptService) {
  return [
    svc.buildIngestPrompt('chunk', undefined, ctx),
    svc.buildIngestPrompt('chunk', 'Custom {{documentChunk}}', null),
    svc.buildLibrarianPrompt(events, [], undefined, ctx),
    svc.buildLibrarianPrompt(events, [], 'Lib {{events}}', null),
    svc.buildHealPrompt(candidates, anchors.map(({ id, title, source_ref }) => ({ id, title, source_ref })), [], events, undefined, 0),
    svc.buildHealPrompt(candidates, [], [], events, 'Heal {{healCandidates}}', 0),
    svc.buildOntologyBackfillPrompt([], undefined, ctx),
  ];
}

describe('grounding prompt block', () => {
  it('off, or on with no writers, is byte-identical to no config', () => {
    const baseline = allPrompts(new PromptService());
    expect(allPrompts(new PromptService(undefined, null))).toEqual(baseline);
    expect(allPrompts(new PromptService(undefined, resolveGrounding({ mode: 'draft', writers: [] })))).toEqual(baseline);
    expect(allPrompts(new PromptService(undefined, resolveGrounding({ mode: 'off', writers: ['ingest', 'librarian', 'heal'] })))).toEqual(baseline);
  });

  it('appends the block last for in-scope writers, after overrides and ontology context', () => {
    const svc = new PromptService({ ingestSystemPrompt: 'Custom ingest.' }, all);
    const ingest = svc.buildIngestPrompt('chunk', undefined, ctx).systemPrompt;
    expect(ingest.startsWith('Custom ingest.\n\nONTOLOGY MODE TEXT\n\n')).toBe(true);
    expect(ingest.indexOf(MARK)).toBeGreaterThan(ingest.indexOf('ONTOLOGY MODE TEXT'));
    expect(svc.buildIngestPrompt('chunk', 'Tpl {{documentChunk}}', null).systemPrompt).toContain(MARK);
    expect(svc.buildLibrarianPrompt(events, [], undefined, null).systemPrompt).toContain(MARK);
    expect(svc.buildLibrarianPrompt(events, [], 'Lib {{events}}', ctx).systemPrompt).toContain(MARK);
    expect(svc.buildOntologyBackfillPrompt([], undefined, ctx).systemPrompt).not.toContain(MARK);
  });

  it('adds no block for writers outside grounding.writers', () => {
    const svc = new PromptService(undefined, ingestOnly);
    expect(svc.groundingFor('ingest')).not.toBeNull();
    expect(svc.groundingFor('librarian')).toBeNull();
    expect(svc.buildLibrarianPrompt(events, [], undefined, null).systemPrompt).not.toContain(MARK);
    expect(svc.buildHealPrompt(candidates, anchors, [], events, undefined, 0).prompts.systemPrompt).not.toContain(MARK);
    expect('groundingCorpus' in svc.buildHealPrompt(candidates, anchors, [], events, undefined, 0)).toBe(false);
  });
});

describe('heal grounding prompt and corpus', () => {
  const svc = new PromptService(undefined, all);

  it('appends the block in both template branches', () => {
    expect(svc.buildHealPrompt(candidates, anchors, [], events, undefined, 0).prompts.systemPrompt).toContain(MARK);
    const placeholder = svc.buildHealPrompt(candidates, anchors, [], events, 'Heal {{documentAnchors}}', 0);
    expect(placeholder.prompts.systemPrompt).toContain(MARK);
    expect(placeholder.prompts.systemPrompt).toContain('draft anchor body sentence here');
  });

  it('shows clipped anchor bodies and never lifecycle_status', () => {
    const { prompts } = svc.buildHealPrompt(candidates, anchors, [], events, undefined, 0);
    expect(prompts.userPrompt).toContain('"body": "' + 'x'.repeat(HEAL_ANCHOR_BODY_CHARS) + '"');
    expect(prompts.userPrompt).not.toContain('x'.repeat(HEAL_ANCHOR_BODY_CHARS + 1));
    expect(prompts.userPrompt).not.toContain('lifecycle_status');
  });

  it('builds the corpus from event summaries and non-draft anchor bodies only', () => {
    const { groundingCorpus } = svc.buildHealPrompt(candidates, anchors, [], events, undefined, 0);
    expect(joinedCorpus(groundingCorpus)).toContain('Operator observed the engine printing tables');
    expect(joinedCorpus(groundingCorpus)).toContain('x'.repeat(HEAL_ANCHOR_BODY_CHARS));
    expect(joinedCorpus(groundingCorpus)).not.toContain('draft anchor body');
    expect(joinedCorpus(groundingCorpus)).not.toContain('candidate body text');
    expect(joinedCorpus(groundingCorpus)).not.toContain('evt_1');
    expect(joinedCorpus(groundingCorpus)).not.toContain('observation');
  });

  it('drops events from the corpus at L2 and above', () => {
    expect(joinedCorpus(svc.buildHealPrompt(candidates, anchors, [], events, undefined, 1).groundingCorpus)).toContain('Operator observed');
    expect(joinedCorpus(svc.buildHealPrompt(candidates, anchors, [], events, undefined, 2).groundingCorpus)).not.toContain('Operator observed');
  });
});

describe('librarian grounding corpus', () => {
  const svc = new PromptService(undefined, all);
  const facts = [{ id: 'f1', title: 'Old fact', body: 'an earlier inference sentence' }];

  it('is event summaries only, in the default and {{events}} templates', () => {
    for (const tpl of [undefined, 'Lib {{events}} {{currentFacts}}', 'Lib {{ontologyManifest}}']) {
      const { groundingCorpus } = svc.buildLibrarianPrompt(events, facts, tpl, ctx);
      expect(joinedCorpus(groundingCorpus)).toContain('Operator observed the engine printing tables');
      expect(joinedCorpus(groundingCorpus)).not.toContain('earlier inference');
    }
  });

  it('excludes events a {{currentFacts}}-only template never shows', () => {
    const { systemPrompt, userPrompt, groundingCorpus } = svc.buildLibrarianPrompt(events, facts, 'Lib {{currentFacts}}', null);
    expect(`${systemPrompt}${userPrompt}`).not.toContain('Operator observed');
    expect(groundingCorpus).toEqual([]);
  });

  it('is absent when librarian is not a grounding writer', () => {
    expect('groundingCorpus' in new PromptService(undefined, ingestOnly).buildLibrarianPrompt(events, facts)).toBe(false);
  });
});

describe('heal grounding corpus with partial placeholder templates', () => {
  const svc = new PromptService(undefined, all);

  it('includes only the sources the template places', () => {
    const candidatesOnly = svc.buildHealPrompt(candidates, anchors, [], events, 'Heal {{healCandidates}}', 0);
    expect(candidatesOnly.groundingCorpus).toEqual([]);

    const eventsOnly = svc.buildHealPrompt(candidates, anchors, [], events, 'Heal {{recentEvents}}', 0).groundingCorpus;
    expect(joinedCorpus(eventsOnly)).toContain('Operator observed');
    expect(joinedCorpus(eventsOnly)).not.toContain('x'.repeat(20));

    const anchorsOnly = svc.buildHealPrompt(candidates, anchors, [], events, 'Heal {{documentAnchors}}', 0).groundingCorpus;
    expect(joinedCorpus(anchorsOnly)).toContain('x'.repeat(HEAL_ANCHOR_BODY_CHARS));
    expect(joinedCorpus(anchorsOnly)).not.toContain('Operator observed');
  });
});
