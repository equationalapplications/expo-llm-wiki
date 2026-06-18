import { describe, it, expect } from 'vitest';
import { buildConceptDocument } from '../src/concept';

describe('buildConceptDocument', () => {
  it('concatenates frontmatter and body with a blank line between', () => {
    const result = buildConceptDocument({ type: 'fact', title: 'T' }, 'Body text');
    expect(result).toBe('---\ntype: fact\ntitle: T\n---\n\nBody text');
  });

  it('supports the minimal case where only type is present', () => {
    const result = buildConceptDocument({ type: 'task' }, '');
    expect(result).toBe('---\ntype: task\n---\n\n');
  });
});
