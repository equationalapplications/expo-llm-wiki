import { describe, it, expect } from 'vitest';
import { formatContext } from '../src/utils/formatContext';

const fact = { id: 'f1', entity_id: 'u', title: 'Likes tea', body: 'Green, mornings.', tags: ['pref'], confidence: 'certain' as const,
  source_type: 'user_stated' as const, source_hash: null, source_ref: null, created_at: 1, updated_at: 1, last_accessed_at: null, access_count: 0, deleted_at: null };

describe('formatContext compact', () => {
  it('drops confidence, tags, entity ids and scores even when requested', () => {
    const out = formatContext({ facts: [fact], tasks: [], events: [], factScores: { f1: 0.9 } },
      { compact: true, includeConfidence: true, includeTags: true, includeEntityIds: true, includeFactScores: true });
    expect(out).toContain('Likes tea');
    expect(out).toContain('Green, mornings.');
    expect(out).not.toMatch(/certain|pref|0\.9|\bu\b/);
  });
  it('default output is unchanged', () => {
    const out = formatContext({ facts: [fact], tasks: [], events: [] });
    expect(out).toContain('certain');
  });
});