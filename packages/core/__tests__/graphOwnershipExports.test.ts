import { describe, expect, it } from 'vitest';
import * as publicApi from '../src';
import * as memoryApi from '../src/WikiMemory';

describe('graph ownership public error', () => {
  it('exports one runtime constructor through both entrypoints', () => {
    expect(publicApi).toHaveProperty('WikiGraphNodeOwnershipConflict');
    expect(memoryApi).toHaveProperty('WikiGraphNodeOwnershipConflict');
    const error = new publicApi.WikiGraphNodeOwnershipConflict();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(memoryApi.WikiGraphNodeOwnershipConflict);
    expect(memoryApi.WikiGraphNodeOwnershipConflict)
      .toBe(publicApi.WikiGraphNodeOwnershipConflict);
  });

  it('has only the fixed public rejection information', () => {
    const error = new publicApi.WikiGraphNodeOwnershipConflict();
    expect(error.name).toBe('WikiGraphNodeOwnershipConflict');
    expect(error.code).toBe('WIKI_GRAPH_NODE_OWNERSHIP_CONFLICT');
    expect(error.message)
      .toBe('Graph write rejected because a node ID is unavailable for this entity.');
    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
    expect(error).not.toHaveProperty('cause');
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: 'WIKI_GRAPH_NODE_OWNERSHIP_CONFLICT',
      name: 'WikiGraphNodeOwnershipConflict',
    });
  });
});
