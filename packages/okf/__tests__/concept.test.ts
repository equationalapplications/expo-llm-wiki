import { describe, it, expect } from 'vitest';
import { buildConceptDocument, parseConcept } from '../src/concept';

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

describe('parseConcept', () => {
  it('splits frontmatter and body', () => {
    const doc = buildConceptDocument({ type: 'fact', title: 'T' }, 'Body text');
    const { frontmatter, body } = parseConcept(doc);
    expect(frontmatter).toEqual({ type: 'fact', title: 'T' });
    expect(body).toBe('Body text');
  });

  it('supports the minimal case where only type is present and body is empty', () => {
    const doc = buildConceptDocument({ type: 'task' }, '');
    const { frontmatter, body } = parseConcept(doc);
    expect(frontmatter).toEqual({ type: 'task' });
    expect(body).toBe('');
  });

  it('round-trips a multi-line body', () => {
    const doc = buildConceptDocument({ type: 'fact' }, 'line one\nline two\nline three');
    const { body } = parseConcept(doc);
    expect(body).toBe('line one\nline two\nline three');
  });
});
