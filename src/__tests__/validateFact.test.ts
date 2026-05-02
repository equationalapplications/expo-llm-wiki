import { describe, it, expect } from 'vitest';
import { __testables } from '../../packages/core/src/WikiMemory';

const { validateFact } = __testables;

describe('validateFact body budget', () => {
  it('accepts 800-char body', () => {
    const body = 'x'.repeat(800);
    const r = validateFact({ title: 'Test Title', body, tags: [], confidence: 'certain' });
    expect(r).not.toBeNull();
    expect(r?.body.length).toBe(800);
  });

  it('clips body to 800 chars', () => {
    const body = 'x'.repeat(1200);
    const r = validateFact({ title: 'Test Title', body, tags: [], confidence: 'certain' });
    expect(r).not.toBeNull();
    expect(r?.body.length).toBe(800);
  });

  it('rejects null/undefined title', () => {
    expect(validateFact({ title: null, body: 'body', tags: [], confidence: 'certain' })).toBeNull();
    expect(validateFact({ title: undefined, body: 'body', tags: [], confidence: 'certain' })).toBeNull();
  });

  it('accepts tentative/inferred/certain confidence', () => {
    for (const confidence of ['certain', 'tentative', 'inferred']) {
      const r = validateFact({ title: 'T', body: 'b', tags: [], confidence });
      expect(r?.confidence).toBe(confidence);
    }
  });
});
