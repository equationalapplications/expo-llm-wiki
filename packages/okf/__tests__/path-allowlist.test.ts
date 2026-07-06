import { describe, it, expect } from 'vitest';
import { isAllowedOkfPath } from '../src/path-allowlist';

describe('isAllowedOkfPath', () => {
  it('allows layout paths from profile §1', () => {
    expect(isAllowedOkfPath('index.md')).toBe(true);
    expect(isAllowedOkfPath('entities/alice/index.md')).toBe(true);
    expect(isAllowedOkfPath('entities/alice/log.md')).toBe(true);
    expect(isAllowedOkfPath('entities/alice/facts/fact_a.md')).toBe(true);
    expect(isAllowedOkfPath('entities/alice/tasks/task_b.md')).toBe(true);
  });

  it('rejects bundle-root README.md and stray paths', () => {
    expect(isAllowedOkfPath('README.md')).toBe(false);
    expect(isAllowedOkfPath('notes/random.md')).toBe(false);
    expect(isAllowedOkfPath('entities/alice/readme.md')).toBe(false);
  });

  it('normalizes leading ./', () => {
    expect(isAllowedOkfPath('./entities/alice/facts/a.md')).toBe(true);
  });

  it('rejects path traversal segments', () => {
    expect(isAllowedOkfPath('entities/../index.md')).toBe(false);
    expect(isAllowedOkfPath('entities/../log.md')).toBe(false);
  });
});
