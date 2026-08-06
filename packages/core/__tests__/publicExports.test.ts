import { describe, it, expect } from 'vitest';
import {
  chunkText,
  safeSlice,
  DEFAULT_MAX_CHUNK_LENGTH,
  DEFAULT_CHUNK_OVERLAP,
} from '../src/index';
import { chunkText as chunkTextInternal, safeSlice as safeSliceInternal } from '../src/utils/pure';

describe('public exports: chunking', () => {
  it('exports chunkText as the same function reference as utils/pure', () => {
    expect(chunkText).toBe(chunkTextInternal);
  });

  it('exports safeSlice as the same function reference as utils/pure', () => {
    expect(safeSlice).toBe(safeSliceInternal);
  });

  it('chunkText via the public entry point produces identical output to the internal implementation', () => {
    const text = 'a'.repeat(50) + '\n\n' + 'b'.repeat(50);
    expect(chunkText(text, 60, 5)).toEqual(chunkTextInternal(text, 60, 5));
  });

  it('safeSlice via the public entry point produces identical output to the internal implementation', () => {
    expect(safeSlice('hello world', 2, 8)).toBe(safeSliceInternal('hello world', 2, 8));
  });

  it('exports the ingest default chunking constants', () => {
    expect(DEFAULT_MAX_CHUNK_LENGTH).toBe(12000);
    expect(DEFAULT_CHUNK_OVERLAP).toBe(400);
  });
});
