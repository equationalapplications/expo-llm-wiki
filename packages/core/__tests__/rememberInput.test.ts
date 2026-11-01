import { describe, it, expect } from 'vitest';
import { normalizeRememberInput } from '../src/utils/rememberInput';
import type { RememberInput } from '../src/types';

const NOW = 1_700_000_000_000;

describe('normalizeRememberInput', () => {
  it('applies the defaults from spec §3.1 and builds the fact literal', () => {
    const { fact, validFrom, okfType } = normalizeRememberInput('e1', { title: 'T', body: 'B' }, NOW);
    expect(fact.id.startsWith('fact_')).toBe(true);
    expect(fact).toMatchObject({
      entity_id: 'e1', title: 'T', body: 'B', tags: [], confidence: 'certain', source_type: 'user_stated',
      source_hash: null, source_ref: null, created_at: NOW, updated_at: NOW,
      last_accessed_at: null, access_count: 0, deleted_at: null, okf_type: null,
    });
    expect(validFrom).toBeUndefined();
    expect(okfType).toBeNull();
  });

  it('stores title, body and tags verbatim and truncates valid_from', () => {
    const { fact, validFrom, okfType } = normalizeRememberInput('e1', {
      title: '  Untrimmed ', body: '', tags: ['Git', ' Mixed Case '], confidence: 'tentative',
      source_type: 'user_confirmed', okf_type: 'Person', valid_from: 5000.9,
    }, NOW);
    expect(fact.title).toBe('  Untrimmed ');
    expect(fact.body).toBe('');
    expect(fact.tags).toEqual(['Git', ' Mixed Case ']);
    expect(fact.confidence).toBe('tentative');
    expect(fact.source_type).toBe('user_confirmed');
    expect(validFrom).toBe(5000);
    expect(okfType).toBe('Person');
  });

  it('does not alias the caller’s tags array', () => {
    const tags = ['a'];
    const { fact } = normalizeRememberInput('e1', { title: 'T', body: 'B', tags }, NOW);
    tags.push('b');
    expect(fact.tags).toEqual(['a']);
  });

  it('rejects a sparse tags array (every() skips holes)', () => {
    const sparse = ['ok'] as unknown as string[];
    (sparse as any).length = 2;
    expect(() => normalizeRememberInput('e1', { title: 'T', body: 'B', tags: sparse }, NOW)).toThrow(TypeError);
  });

  it.each<[string, unknown, unknown]>([
    ['empty entityId', '', { title: 'T', body: 'B' }],
    ['entityId > 200 chars', 'x'.repeat(201), { title: 'T', body: 'B' }],
    ['entityId with null byte', 'a\0b', { title: 'T', body: 'B' }],
    ['non-string entityId', 7, { title: 'T', body: 'B' }],
    ['null input', 'e1', null],
    ['array input', 'e1', []],
    ['missing title', 'e1', { body: 'B' }],
    ['whitespace title', 'e1', { title: '   ', body: 'B' }],
    ['non-string title', 'e1', { title: 1, body: 'B' }],
    ['missing body', 'e1', { title: 'T' }],
    ['non-string body', 'e1', { title: 'T', body: null }],
    ['non-array tags', 'e1', { title: 'T', body: 'B', tags: 'git' }],
    ['non-string tag element', 'e1', { title: 'T', body: 'B', tags: ['ok', 2] }],
    ['null confidence', 'e1', { title: 'T', body: 'B', confidence: null }],
    ['null source_type', 'e1', { title: 'T', body: 'B', source_type: null }],
    ['unknown confidence', 'e1', { title: 'T', body: 'B', confidence: 'sure' }],
    ['source_type immutable_document', 'e1', { title: 'T', body: 'B', source_type: 'immutable_document' }],
    ['source_type librarian_inferred', 'e1', { title: 'T', body: 'B', source_type: 'librarian_inferred' }],
    ['garbage source_type', 'e1', { title: 'T', body: 'B', source_type: 'oracle' }],
    ['non-string okf_type', 'e1', { title: 'T', body: 'B', okf_type: 3 }],
    ['blank okf_type', 'e1', { title: 'T', body: 'B', okf_type: '   ' }],
    ['negative valid_from', 'e1', { title: 'T', body: 'B', valid_from: -1 }],
    ['NaN valid_from', 'e1', { title: 'T', body: 'B', valid_from: Number.NaN }],
    ['string valid_from', 'e1', { title: 'T', body: 'B', valid_from: '2026-01-01' }],
  ])('rejects %s with TypeError', (_label, entityId, input) => {
    expect(() => normalizeRememberInput(entityId as string, input as RememberInput, NOW)).toThrow(TypeError);
  });
});
