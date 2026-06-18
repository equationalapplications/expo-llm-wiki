import { describe, it, expect } from 'vitest';
import { sanitizeConceptId, sanitizeForFilename } from '../src/utils/sanitizeForFilename';

describe('sanitizeForFilename', () => {
  it('guards dot-only inputs', () => {
    expect(sanitizeForFilename('.')).toMatch(/^entity-[0-9a-f]{16}$/);
    expect(sanitizeForFilename('..')).toMatch(/^entity-[0-9a-f]{16}$/);
  });

  it('rewrites leading-dot names', () => {
    expect(sanitizeForFilename('.git')).toMatch(/^git-[0-9a-f]{16}$/);
  });

  it('returns an already-safe value unchanged', () => {
    expect(sanitizeForFilename('alice')).toBe('alice');
  });

  it('replaces unsafe characters and appends a hash suffix when the value changes', () => {
    const result = sanitizeForFilename('alice/bob');
    expect(result).toMatch(/^alice_bob-[0-9a-f]{16}$/);
  });

  it('falls back to "entity" plus a hash suffix for an empty value', () => {
    const result = sanitizeForFilename('');
    expect(result).toMatch(/^entity-[0-9a-f]{16}$/);
  });

  it('truncates values longer than 200 chars and appends a hash suffix', () => {
    const longValue = 'a'.repeat(250);
    const result = sanitizeForFilename(longValue);
    const match = result.match(/^(a+)-([0-9a-f]{16})$/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(200);
  });

  it('produces the same output for the same input (deterministic)', () => {
    expect(sanitizeForFilename('a/b/c')).toBe(sanitizeForFilename('a/b/c'));
  });

  it('remaps Windows reserved device names with a hash suffix', () => {
    expect(sanitizeForFilename('con')).toMatch(/^con-[0-9a-f]{16}$/);
    expect(sanitizeForFilename('con.txt')).toMatch(/^con\.txt-[0-9a-f]{16}$/);
    expect(sanitizeForFilename('PRN')).toMatch(/^PRN-[0-9a-f]{16}$/);
    expect(sanitizeForFilename('com1')).toMatch(/^com1-[0-9a-f]{16}$/);
    expect(sanitizeForFilename('LPT9')).toMatch(/^LPT9-[0-9a-f]{16}$/);
  });

  it('strips trailing dots and spaces and appends a hash suffix', () => {
    expect(sanitizeForFilename('alice.')).toMatch(/^alice-[0-9a-f]{16}$/);
    expect(sanitizeForFilename('bob ')).toMatch(/^bob-[0-9a-f]{16}$/);
  });
});

describe('sanitizeConceptId', () => {
  it('remaps OKF-reserved concept names with a hash suffix', () => {
    expect(sanitizeConceptId('index')).toMatch(/^index-[0-9a-f]{16}$/);
    expect(sanitizeConceptId('log')).toMatch(/^log-[0-9a-f]{16}$/);
  });

  it('returns an already-safe value unchanged', () => {
    expect(sanitizeConceptId('fact_aaa')).toBe('fact_aaa');
  });

  it('sanitizes path separators like sanitizeForFilename', () => {
    expect(sanitizeConceptId('../escape')).toMatch(/^escape-[0-9a-f]{16}$/);
  });
});
