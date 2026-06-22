import { describe, it, expect } from 'vitest';
import { extractMarkdownLinks } from '../src/markdown-links';

describe('extractMarkdownLinks', () => {
  it('extracts a single inline link', () => {
    expect(extractMarkdownLinks('See [related task](./tasks/abc.md) for details.')).toEqual([
      { text: 'related task', path: './tasks/abc.md' },
    ]);
  });

  it('extracts multiple links from one body', () => {
    const body = '[reports_to](../people/bob.md) and [mentions](./facts/x.md)';
    expect(extractMarkdownLinks(body)).toEqual([
      { text: 'reports_to', path: '../people/bob.md' },
      { text: 'mentions', path: './facts/x.md' },
    ]);
  });

  it('excludes http(s) links', () => {
    expect(extractMarkdownLinks('See [docs](https://example.com/page)')).toEqual([]);
  });

  it('excludes mailto links', () => {
    expect(extractMarkdownLinks('Contact [Alice](mailto:alice@example.com)')).toEqual([]);
  });

  it('returns an empty array when there are no links', () => {
    expect(extractMarkdownLinks('Plain text with no links at all.')).toEqual([]);
  });

  it('handles an empty link text', () => {
    expect(extractMarkdownLinks('[](./facts/x.md)')).toEqual([{ text: '', path: './facts/x.md' }]);
  });

  it('ignores links inside fenced code blocks', () => {
    const body = 'Real [link](./facts/x.md)\n\n```\n[fake](./facts/y.md)\n```';
    expect(extractMarkdownLinks(body)).toEqual([{ text: 'link', path: './facts/x.md' }]);
  });
});
