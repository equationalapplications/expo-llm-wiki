import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MetadataRepository } from '../src/repositories/MetadataRepository';
import type { EdgeRepository } from '../src/repositories/EdgeRepository';
import type { OntologyManifest } from '../src/types';

// specs/type-on-write Test plan 2 and 5: the write / backfill template split.
const mutate = vi.hoisted(() => ({ write: false, backfill: false }));
vi.mock('../src/prompts/ontology', async () => {
  const actual = await vi.importActual<typeof import('../src/prompts/ontology')>('../src/prompts/ontology');
  return {
    ...actual,
    buildWriteOntologyAppendix: (...a: Parameters<typeof actual.buildWriteOntologyAppendix>) =>
      mutate.write ? { ...actual.buildWriteOntologyAppendix(...a), ontologyModeInstructions: 'CHANGED-WRITE' } : actual.buildWriteOntologyAppendix(...a),
    buildOntologyPromptAppendix: (...a: Parameters<typeof actual.buildOntologyPromptAppendix>) =>
      mutate.backfill ? { ...actual.buildOntologyPromptAppendix(...a), ontologyModeInstructions: 'CHANGED-BACKFILL' } : actual.buildOntologyPromptAppendix(...a),
  };
});

import { OntologyService } from '../src/services/OntologyService';
import { PromptService } from '../src/services/PromptService';
import { buildOntologyPromptAppendix, buildWriteOntologyAppendix } from '../src/prompts/ontology';
import { labelEvents } from '../src/services/librarian/ops/text';

const manifest: OntologyManifest = { node_types: [{ type: 'person', description: 'An individual.' }], edge_types: [] };
function svc(mode: 'strict' | 'emergent' | 'off' = 'strict') {
  const metadataRepo = { getManifest: vi.fn().mockResolvedValue({ mode, manifest }) } as unknown as MetadataRepository;
  return new OntologyService(metadataRepo, {} as unknown as EdgeRepository, { mode });
}

describe('write / backfill template split (type-on-write §5)', () => {
  beforeEach(() => { mutate.write = false; mutate.backfill = false; });

  it('the write appendix text equals the backfill appendix text for the same inputs (this step)', async () => {
    const real = await vi.importActual<typeof import('../src/prompts/ontology')>('../src/prompts/ontology');
    for (const mode of ['strict', 'emergent'] as const) {
      const w = real.buildWriteOntologyAppendix(mode, '{"m":1}');
      const b = real.buildOntologyPromptAppendix(mode, '{"m":1}');
      expect(w.ontologyModeInstructions).toBe(b.ontologyModeInstructions);
      expect(w.ontologyManifest).toBe(b.ontologyManifest);
      expect(w.site).toBe('write');
      expect('site' in b).toBe(false);
    }
  });

  it('changing the write appendix does not change the backfill prompt', async () => {
    const o = svc();
    const before = new PromptService().buildOntologyBackfillPrompt([{ t: 1 }], undefined, await o.buildPromptContext('u'));
    mutate.write = true;
    const writeCtx = await o.buildWritePromptContext('u', { engaged: false });
    expect(writeCtx?.ontologyModeInstructions).toBe('CHANGED-WRITE');
    const after = new PromptService().buildOntologyBackfillPrompt([{ t: 1 }], undefined, await svc().buildPromptContext('u'));
    expect(after).toEqual(before);
    expect(after.systemPrompt).not.toContain('CHANGED-WRITE');
  });

  it('changing the backfill appendix does not change write prompts', async () => {
    const ev = labelEvents([{ id: 'a', entity_id: 'u', event_type: 'observation' as const, summary: 's', created_at: 1 }]);
    const ps = new PromptService();
    const before = ps.buildOpsExtractPrompt(ev, await svc().buildWritePromptContext('u', { engaged: false }));
    mutate.backfill = true;
    const o = svc();
    expect((await o.buildPromptContext('u'))?.ontologyModeInstructions).toBe('CHANGED-BACKFILL');
    const after = ps.buildOpsExtractPrompt(ev, await o.buildWritePromptContext('u', { engaged: false }));
    expect(after).toEqual(before);
    expect(after.systemPrompt).not.toContain('CHANGED-BACKFILL');
  });

  it('buildWritePromptContext returns null when engaged or when the mode is off', async () => {
    expect(await svc().buildWritePromptContext('u', { engaged: true })).toBeNull();
    expect(await svc('off').buildWritePromptContext('u', { engaged: false })).toBeNull();
    expect(await svc().buildWritePromptContext('u', { engaged: false })).not.toBeNull();
  });

  it('a null write context yields the mode-off prompt byte for byte, with guidance and grounding, and strips placeholders', async () => {
    const ps = new PromptService(undefined, null);
    const ev = labelEvents([{ id: 'a', entity_id: 'u', event_type: 'observation' as const, summary: 's', created_at: 1 }]);
    const engaged = await svc().buildWritePromptContext('u', { engaged: true });
    expect(ps.buildOpsExtractPrompt(ev, engaged, 'G')).toEqual(ps.buildOpsExtractPrompt(ev, null, 'G'));
    expect(ps.buildLibrarianPrompt([], [], undefined, engaged, 'G')).toEqual(ps.buildLibrarianPrompt([], [], undefined, null, 'G'));
    const ov = 'X {{ontologyManifest}} Y {{ontologyModeInstructions}} {{events}}';
    const stripped = ps.buildLibrarianPrompt([1], [], ov, engaged).systemPrompt;
    expect(stripped).not.toMatch(/ontology(Manifest|ModeInstructions)/);
    expect(stripped).not.toContain('Ontology constraints');
  });

  it('the brand never becomes a template variable', () => {
    const ps = new PromptService();
    const ctx = buildWriteOntologyAppendix('strict', '{}');
    const out = ps.buildLibrarianPrompt([], [], 'A {{site}} {{ontologyManifest}} {{events}}', ctx).systemPrompt;
    expect(out).toContain('{{site}}');
  });

  it('getInstructions-style templates: write context null leaves backfill intact when passed explicitly', () => {
    const ps = new PromptService();
    const bf = buildOntologyPromptAppendix('strict', '{"m":1}');
    const t = ps.buildInstructionTemplates(null, 'ops', undefined, bf);
    expect(t.ontologyBackfill).toContain('Ontology constraints');
    expect(t.librarian).not.toContain('Ontology constraints');
    // Omitted backfill context derives from the write context (pre-split behavior).
    const w = buildWriteOntologyAppendix('strict', '{"m":1}');
    const t2 = ps.buildInstructionTemplates(w, 'ops');
    expect(t2.ontologyBackfill).toContain('Ontology constraints');
    expect(t2.librarian).toContain('Ontology constraints');
  });

  it('type level: a write context is rejected by backfill; a plain OntologyPromptContext is accepted by every public write builder', () => {
    const ps = new PromptService();
    const w = buildWriteOntologyAppendix('strict', '{}');
    const b = buildOntologyPromptAppendix('strict', '{}');
    // @ts-expect-error a write context is rejected by the backfill builder
    ps.buildOntologyBackfillPrompt([], undefined, w);
    ps.buildIngestPrompt('c', undefined, b);
    ps.buildLibrarianPrompt([], [], undefined, b);
    ps.buildOpsExtractPrompt([], b);
    ps.buildInstructionTemplates(b, 'ops');
    expect(true).toBe(true);
  });
});
