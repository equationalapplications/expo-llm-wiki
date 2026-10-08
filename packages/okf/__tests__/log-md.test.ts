import { describe, it, expect } from 'vitest';
import { appendEventIdComment, buildLogMd, parseEventIdComment, parseLogMd } from '../src/log-md';

describe('buildLogMd', () => {
  it('groups entries by date, sorts groups descending, preserves entry order within a group', () => {
    const result = buildLogMd([
      { date: '2026-01-01', text: 'A' },
      { date: '2026-01-02', text: 'B' },
      { date: '2026-01-01', text: 'C' },
    ]);
    expect(result).toBe('## 2026-01-02\n\n- B\n\n## 2026-01-01\n\n- A\n- C\n');
  });

  it('renders an ISO YYYY-MM-DD heading for a single entry', () => {
    const result = buildLogMd([{ date: '2026-06-18', text: 'X' }]);
    expect(result).toBe('## 2026-06-18\n\n- X\n');
  });

  it('renders an empty string for an empty entries list', () => {
    expect(buildLogMd([])).toBe('');
  });
});

describe('parseLogMd', () => {
  it('extracts date headings and bullet entries', () => {
    const content = '## 2026-01-02\n\n- B\n\n## 2026-01-01\n\n- A\n- C\n';
    expect(parseLogMd(content)).toEqual([
      { date: '2026-01-02', text: 'B' },
      { date: '2026-01-01', text: 'A' },
      { date: '2026-01-01', text: 'C' },
    ]);
  });

  it('round-trips through buildLogMd for a single entry', () => {
    const built = buildLogMd([{ date: '2026-06-18', text: 'X' }]);
    expect(parseLogMd(built)).toEqual([{ date: '2026-06-18', text: 'X' }]);
  });

  it('round-trips through buildLogMd for multiple dates and entries', () => {
    const entries = [
      { date: '2026-01-01', text: 'A' },
      { date: '2026-01-02', text: 'B' },
      { date: '2026-01-01', text: 'C' },
    ];
    const built = buildLogMd(entries);
    expect(parseLogMd(built)).toEqual([
      { date: '2026-01-02', text: 'B' },
      { date: '2026-01-01', text: 'A' },
      { date: '2026-01-01', text: 'C' },
    ]);
  });

  it('returns an empty array for empty content', () => {
    expect(parseLogMd('')).toEqual([]);
  });

  it('ignores bullet lines that appear before any date heading', () => {
    const content = '- orphan bullet\n\n## 2026-01-01\n\n- A\n';
    expect(parseLogMd(content)).toEqual([{ date: '2026-01-01', text: 'A' }]);
  });

  it('ignores lines that are neither a heading nor a bullet', () => {
    const content = '## 2026-01-01\n\nSome prose line.\n- A\n';
    expect(parseLogMd(content)).toEqual([{ date: '2026-01-01', text: 'A' }]);
  });
});

describe('event id comments', () => {
  it('appends a trailing id comment', () => {
    expect(appendEventIdComment('(observation) Noted', 'evt_abc')).toBe(
      '(observation) Noted <!-- id: evt_abc -->',
    );
  });

  it('parses id comment with tolerant whitespace', () => {
    expect(parseEventIdComment('(observation) Noted  <!-- id: evt_abc -->')).toEqual({
      text: '(observation) Noted',
      eventId: 'evt_abc',
    });
  });

  it('returns original text when comment is missing', () => {
    expect(parseEventIdComment('(observation) Legacy line')).toEqual({
      text: '(observation) Legacy line',
      eventId: undefined,
    });
  });

  it('round-trips through buildLogMd / parseLogMd', () => {
    const text = appendEventIdComment('(decision) Chose A', 'evt_xyz');
    const built = buildLogMd([{ date: '2026-07-05', text }]);
    const parsed = parseLogMd(built);
    expect(parsed[0].text).toBe(text);
  });
});

describe('log-md — linear-time parsing (CodeQL #5 #6)', () => {
  const within = (fn: () => void, ms = 500) => {
    const t0 = performance.now();
    fn();
    expect(performance.now() - t0).toBeLessThan(ms);
  };

  it('round-trips entries with id comments and bracket characters', () => {
    const entries = [
      { date: '2026-01-02', text: '(observation) [a \\[x\\]](./facts/f.md) <!-- id: evt_1 -->' },
      { date: '2026-01-02', text: 'plain  spaced   text' },
    ];
    expect(parseLogMd(buildLogMd(entries))).toEqual(entries);
  });

  it('takes the last comment when two are present', () => {
    expect(parseEventIdComment('x <!-- id: a <!-- id: b -->')).toEqual({
      text: 'x <!-- id: a',
      eventId: 'b',
    });
  });

  it('accepts a comment with no inner spacing', () => {
    expect(parseEventIdComment('x <!--id:abc-->')).toEqual({ text: 'x', eventId: 'abc' });
  });

  it('strips but drops an id with illegal characters', () => {
    expect(parseEventIdComment('x <!-- id: a/b -->')).toEqual({ text: 'x' });
  });

  it('returns the original text when the id is empty', () => {
    expect(parseEventIdComment('x <!-- id: -->')).toEqual({ text: 'x <!-- id: -->' });
  });

  it('repeated comment-opener attack completes in bounded time (#5)', () => {
    within(() => parseEventIdComment('<!--id:'.repeat(20_000)));
  });

  it('whitespace attack completes in bounded time (#5)', () => {
    within(() => parseEventIdComment(' '.repeat(100_000) + 'x'));
  });

  it('bullet input completes in bounded time (#6, regression guard)', () => {
    within(() => parseLogMd('## 2026-01-01\n\n- ' + '  '.repeat(50_000) + '\rb\n'));
  });

  it('keeps a whitespace-only bullet as an empty entry', () => {
    expect(parseLogMd('## 2026-01-01\n\n-   \n')).toEqual([{ date: '2026-01-01', text: '' }]);
  });
});
