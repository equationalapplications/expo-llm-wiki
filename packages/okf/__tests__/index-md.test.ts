import { describe, it, expect } from 'vitest';
import { buildIndexMd, buildRootIndexMd } from '../src/index-md';

describe('buildIndexMd', () => {
  it('renders multiple sections with entries with and without description', () => {
    const result = buildIndexMd([
      {
        heading: 'Facts',
        entries: [
          { path: 'facts/a.md', title: 'A', description: 'desc A' },
          { path: 'facts/b.md', title: 'B' },
        ],
      },
      { heading: 'Tasks', entries: [] },
    ]);
    expect(result).toBe(
      '## Facts\n\n* [A](facts/a.md) - desc A\n* [B](facts/b.md)\n\n## Tasks\n'
    );
  });

  it('renders an empty string for an empty sections list', () => {
    expect(buildIndexMd([])).toBe('');
  });
});

describe('buildRootIndexMd', () => {
  it('wraps the body in a frontmatter block containing only okf_version', () => {
    const result = buildRootIndexMd('0.1', [
      { heading: 'Entities', entries: [{ path: 'entities/alice/index.md', title: 'alice' }] },
    ]);
    expect(result).toBe(
      '---\nokf_version: "0.1"\n---\n\n## Entities\n\n* [alice](entities/alice/index.md)\n'
    );
  });
});
