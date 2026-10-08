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

  it('excludes a leading H1 title from summary', () => {
    const content = '# Alice\n\nSummary line.\n\n## Facts\n\n* [A](facts/a.md)\n';
    expect(parseEntityIndexMd(content).summary).toBe('Summary line.');
  });
});

describe('parseEntityIndexMd — linear-time parsing (CodeQL #2 #3 #4 #9)', () => {
  const within = (fn: () => void, ms = 500) => {
    const t0 = performance.now();
    fn();
    expect(performance.now() - t0).toBeLessThan(ms);
  };

  it('round-trips titles and descriptions containing \\, [ and ]', () => {
    const sections = [
      {
        heading: 'Facts',
        entries: [
          { title: 'a\\b [x] \\', path: 'facts/a.md', description: 'd [y] \\' },
          { title: '] [', path: 'facts/b.md' },
        ],
      },
    ];
    const parsed = parseEntityIndexMd(buildEntityIndexMd({ summary: 'S', sections }));
    expect(parsed.summary).toBe('S');
    expect(parsed.sections).toEqual(sections);
  });

  it('escaped-label attack completes in bounded time (#9)', () => {
    within(() => parseEntityIndexMd('## Facts\n* [' + '\\\\'.repeat(50_000)));
  });

  it('section-heading attack completes in bounded time (#2 #3)', () => {
    within(() => parseEntityIndexMd('## a' + ' '.repeat(100_000) + '\rb'));
  });

  it('description-tail input completes in bounded time (#4, regression guard)', () => {
    within(() => parseEntityIndexMd('## Facts\n* [a](p.md) - ' + ' '.repeat(100_000) + '\rb'));
  });

  it('keeps the old description behaviour for a dash with only whitespace after it', () => {
    const parsed = parseEntityIndexMd('## Facts\n* [a](p.md) -   \n');
    expect(parsed.sections[0].entries).toEqual([{ title: 'a', path: 'p.md', description: undefined }]);
  });

  it('tightening: a whitespace-only "##" line is not a section heading', () => {
    expect(parseEntityIndexMd('##   \n* [a](p.md)\n').sections).toEqual([]);
  });

  it('tightening: a label with an unescaped "[" is skipped', () => {
    const parsed = parseEntityIndexMd('## Facts\n* [a[b](p.md)\n* [ok](q.md)\n');
    expect(parsed.sections[0].entries.map((e) => e.title)).toEqual(['ok']);
  });
});
