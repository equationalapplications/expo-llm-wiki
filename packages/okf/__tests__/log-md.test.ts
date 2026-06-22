import { describe, it, expect } from 'vitest';
import { buildLogMd, parseLogMd } from '../src/log-md';

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
