import { describe, it, expect } from 'vitest';
import { instructionsGetManifest } from '../src/manifests/instructions';
import * as CoreLlmTools from '../src/index';

describe('instructionsGetManifest', () => {
  it('is a memory:read function tool named instructions_get that requires entityId', () => {
    expect(instructionsGetManifest.name).toBe('instructions_get');
    expect(instructionsGetManifest.scope).toBe('memory:read');
    expect(instructionsGetManifest.schema.name).toBe(instructionsGetManifest.name);
    expect(instructionsGetManifest.schema.parameters?.required).toEqual(['entityId']);
    expect((instructionsGetManifest.schema.parameters?.properties as Record<string, { type: string }>).entityId.type).toBe('string');
  });

  it('is exported from the package entry point', () => {
    expect(CoreLlmTools.instructionsGetManifest).toBe(instructionsGetManifest);
  });

  it('the removed wiki_* exports are gone from the package entry point (#324)', () => {
    for (const removed of [
      'wikiTraverseGraphManifest',
      'wikiGetOntologyManifest',
      'wikiGetInstructionsManifest',
      'LEGACY_TOOL_NAMES',
      'canonicalToolName',
    ]) {
      expect(CoreLlmTools).not.toHaveProperty(removed);
    }
  });
});
