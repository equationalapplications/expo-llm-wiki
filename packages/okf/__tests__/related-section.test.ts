import { describe, it, expect } from 'vitest';
import { appendRelatedSection, splitRelatedSection } from '../src/related-section';

describe('related section', () => {
  it('appends ## Related with markdown links', () => {
    const body = 'Fact body.\n';
    const result = appendRelatedSection(body, [
      { edge_type: 'mentions', path: './fact_b.md' },
      { edge_type: 'blocks', path: '../tasks/task_c.md' },
    ]);
    expect(result).toBe(
      'Fact body.\n\n## Related\n\n- [mentions](./fact_b.md)\n- [blocks](../tasks/task_c.md)\n',
    );
  });

  it('returns body unchanged when links array is empty', () => {
    expect(appendRelatedSection('Body only\n', [])).toBe('Body only\n');
  });

  it('splits trailing ## Related from body', () => {
    const raw = 'Body.\n\n## Related\n\n- [mentions](./target.md)\n';
    expect(splitRelatedSection(raw)).toEqual({
      body: 'Body.\n',
      relatedLinks: [{ text: 'mentions', path: './target.md' }],
    });
  });

  it('returns empty relatedLinks when section absent', () => {
    expect(splitRelatedSection('Body only\n')).toEqual({ body: 'Body only\n', relatedLinks: [] });
  });

  it('does not split ## Related mid-body (only trailing section)', () => {
    const raw = '## Related\n\nInline mention.\n\nTail.\n';
    expect(splitRelatedSection(raw).relatedLinks).toEqual([]);
  });
});
