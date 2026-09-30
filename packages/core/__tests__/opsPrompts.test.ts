import { describe, it, expect } from 'vitest';
import { normalizeFactText, labelEvents, parseValidFrom } from '../src/services/librarian/ops/text';
import { PromptService } from '../src/services/PromptService';
import { resolveGrounding } from '../src/utils/grounding';

const ev = (id: string, summary: string, created_at: number, occurred_at?: number) =>
  ({ id, entity_id: 'u', event_type: 'observation' as const, summary, created_at, ...(occurred_at ? { occurred_at } : {}) });

describe('ops text helpers', () => {
  it('normalizeFactText', () => {
    expect(normalizeFactText('User  LIVES in Seattle!', 'Since 2020.')).toBe('user lives in seattle since 2020');
  });
  it('labelEvents prefers occurred_at', () => {
    expect(labelEvents([ev('a', 's', 10), ev('b', 's', 20, 5)]).map((l) => [l.label, l.at])).toEqual([['e1', 10], ['e2', 5]]);
  });
  it('parseValidFrom', () => {
    expect(parseValidFrom(5)).toBe(5);
    expect(parseValidFrom('2026-03-01')).toBe(Date.parse('2026-03-01'));
    expect(parseValidFrom('nope')).toBeUndefined();
    expect(parseValidFrom(-1)).toBeUndefined();
  });
});

describe('ops prompts', () => {
  it('extract prompt lists labelled events and never existing facts', () => {
    const ps = new PromptService(undefined, null);
    const { systemPrompt, userPrompt, groundingCorpus } = ps.buildOpsExtractPrompt(labelEvents([ev('a', 'Moved to SF', Date.parse('2026-03-01T00:00:00Z'))]));
    expect(systemPrompt).toContain('"source_event"');
    expect(userPrompt).toBe('Events:\ne1 [2026-03-01T00:00:00.000Z] (observation) Moved to SF');
    expect(groundingCorpus).toBeUndefined();
  });
  it('extract prompt carries a grounding corpus when librarian grounding is on', () => {
    const ps = new PromptService(undefined, resolveGrounding({ mode: 'draft', writers: ['librarian'] }));
    const out = ps.buildOpsExtractPrompt(labelEvents([ev('a', 'Moved to SF', 1)]));
    expect(out.groundingCorpus?.length).toBe(1);
    expect(out.systemPrompt).toContain('EVIDENCE REQUIREMENT');
  });
  it('resolve prompt is compact JSON of items', () => {
    const ps = new PromptService(undefined, null);
    const { systemPrompt, userPrompt } = ps.buildOpsResolvePrompt([
      { item: 0, candidate: { title: 'Lives in SF', body: 'b' }, existing: [{ ref: 'n1', title: 'Lives in Seattle', body: 'b' }] },
    ]);
    expect(systemPrompt).toContain('SUPERSEDE');
    expect(JSON.parse(userPrompt.replace(/^Items:\n/, ''))).toEqual({ items: [
      { item: 0, candidate: { title: 'Lives in SF', body: 'b' }, existing: [{ ref: 'n1', title: 'Lives in Seattle', body: 'b' }] },
    ] });
  });
});
