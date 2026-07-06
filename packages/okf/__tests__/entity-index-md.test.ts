import { describe, it, expect } from 'vitest';
import { buildEntityIndexMd, parseEntityIndexMd } from '../src/entity-index-md';

describe('entity index md', () => {
  it('builds index with summary, sections, and event log link', () => {
    const result = buildEntityIndexMd({
      summary: 'Alice is a coffee enthusiast.',
      sections: [
        { heading: 'Facts', entries: [{ path: 'facts/a.md', title: 'A' }] },
        { heading: 'Tasks', entries: [] },
      ],
    });
    expect(result).toBe(
      'Alice is a coffee enthusiast.\n\n## Facts\n\n* [A](facts/a.md)\n\n## Tasks\n\n[Event log](./log.md)\n',
    );
  });

  it('builds index without summary when omitted', () => {
    const result = buildEntityIndexMd({ sections: [{ heading: 'Facts', entries: [] }] });
    expect(result).toBe('## Facts\n\n[Event log](./log.md)\n');
  });

  it('parses summary up to first ## heading', () => {
    const content = buildEntityIndexMd({
      summary: 'Summary line.',
      sections: [{ heading: 'Facts', entries: [{ path: 'facts/a.md', title: 'A' }] }],
    });
    expect(parseEntityIndexMd(content)).toEqual({
      summary: 'Summary line.',
      sections: [{ heading: 'Facts', entries: [{ path: 'facts/a.md', title: 'A' }] }],
    });
  });

  it('excludes [Event log] link from summary when no ## sections exist', () => {
    const content = 'Only summary.\n\n[Event log](./log.md)\n';
    expect(parseEntityIndexMd(content).summary).toBe('Only summary.');
  });
});
