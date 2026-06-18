import { describe, it, expect } from 'vitest';
import { buildLogMd } from '../src/log-md';

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
