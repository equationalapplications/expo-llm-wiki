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

describe('splitRelatedSection — linear-time parsing (CodeQL #10)', () => {
  const within = (fn: () => void, ms = 500) => {
    const t0 = performance.now();
    fn();
    expect(performance.now() - t0).toBeLessThan(ms);
  };

  it('round-trips edge types containing \\, [ and ]', () => {
    const links = [
      { edge_type: 'a\\b [x] \\', path: 'x.md' },
      { edge_type: ']', path: 'y.md' },
    ];
    const { relatedLinks } = splitRelatedSection(appendRelatedSection('Body\n', links));
    expect(relatedLinks).toEqual([
      { text: 'a\\b [x] \\', path: 'x.md' },
      { text: ']', path: 'y.md' },
    ]);
  });

  it('escaped-label attack completes in bounded time', () => {
    within(() => splitRelatedSection('Body\n\n## Related\n\n- [' + '\\\\'.repeat(50_000) + '\n'));
  });

  it('run of "[" completes in bounded time', () => {
    within(() => splitRelatedSection('Body\n\n## Related\n\n- ' + '['.repeat(100_000) + '\n'));
  });

  it('tightening: an unescaped "[" splits the label at the inner bracket', () => {
    const { relatedLinks } = splitRelatedSection('Body\n\n## Related\n\n- [a[b](x.md)\n');
    expect(relatedLinks).toEqual([{ text: 'b', path: 'x.md' }]);
  });
});
