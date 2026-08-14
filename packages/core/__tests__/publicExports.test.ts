import { describe, it, expect } from 'vitest';
import {
  chunkText,
  safeSlice,
  DEFAULT_MAX_CHUNK_LENGTH,
  DEFAULT_CHUNK_OVERLAP,
  WikiStrictOntologyViolation,
  WikiSourceRefHashCollision,
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

describe('public exports: new error classes', () => {
  it('WikiStrictOntologyViolation is exported and constructs with the documented fields', () => {
    const e = new WikiStrictOntologyViolation('entity-x', 'node', 'unmapped_type');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(WikiStrictOntologyViolation);
    expect(e.entityId).toBe('entity-x');
    expect(e.kind).toBe('node');
    expect(e.type).toBe('unmapped_type');
    expect(e.code).toBe('WIKI_STRICT_ONTOLOGY_VIOLATION');
    expect(e.name).toBe('WikiStrictOntologyViolation');
    expect(e.message).toContain('unmapped_type');
    expect(e.message).toContain('entity-x');
  });

  it('WikiStrictOntologyViolation kind="edge" constructs symmetrically', () => {
    const e = new WikiStrictOntologyViolation('e1', 'edge', 'calls');
    expect(e.kind).toBe('edge');
    expect(e.type).toBe('calls');
  });

  it('WikiSourceRefHashCollision is exported and constructs with the documented fields', () => {
    const e = new WikiSourceRefHashCollision({
      entityId: 'entity-x',
      sourceHash: 'a'.repeat(64),
      existingSourceRef: 'fileA.ts',
      attemptedSourceRef: 'fileB.ts',
    });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(WikiSourceRefHashCollision);
    expect(e.entityId).toBe('entity-x');
    expect(e.sourceHash).toBe('a'.repeat(64));
    expect(e.existingSourceRef).toBe('fileA.ts');
    expect(e.attemptedSourceRef).toBe('fileB.ts');
    expect(e.code).toBe('WIKI_SOURCE_REF_HASH_COLLISION');
    expect(e.name).toBe('WikiSourceRefHashCollision');
    expect(e.message).toContain('fileA.ts');
    expect(e.message).toContain('fileB.ts');
  });
});
