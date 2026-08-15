import { describe, it, expect } from 'vitest';
import { extractFootnotes, serializeFootnotes } from '../src/footnotes';

describe('extractFootnotes', () => {
  it('extracts a single footnote at the body tail', () => {
    const body = 'Some prose[^a].\n\n[^a]: definition text';
    expect(extractFootnotes(body)).toEqual([{ id: 'a', body: 'definition text' }]);
  });
  it('extracts multiple footnotes preserving order', () => {
    const body = 'Prose[^a] and [^b].\n\n[^a]: first\n[^b]: second line\n  continues';
    expect(extractFootnotes(body)).toEqual([
      { id: 'a', body: 'first' },
      { id: 'b', body: 'second line\ncontinues' },
    ]);
  });
  it('returns empty when no footnote definitions are present', () => {
    expect(extractFootnotes('No footnotes here.')).toEqual([]);
  });
  it('does not extract [^id] markers without matching definitions', () => {
    expect(extractFootnotes('Body with [^missing] marker.')).toEqual([]);
  });
  it('skips malformed lines', () => {
    const body = '[^a]: valid\n[^bad no colon]\n[^b]: ok';
    expect(extractFootnotes(body)).toEqual([
      { id: 'a', body: 'valid' },
      { id: 'b', body: 'ok' },
    ]);
  });
});

describe('serializeFootnotes', () => {
  it('joins footnote definitions with newlines (no-op today; round-trip preserved)', () => {
    expect(serializeFootnotes([{ id: 'a', body: 'x' }])).toBe('[^a]: x');
    expect(serializeFootnotes([{ id: 'a', body: 'x' }, { id: 'b', body: 'y' }])).toBe('[^a]: x\n[^b]: y');
  });
  it('returns empty string for empty / undefined', () => {
    expect(serializeFootnotes([])).toBe('');
  });
});