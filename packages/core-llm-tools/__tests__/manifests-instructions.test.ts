import { describe, it, expect } from 'vitest';
import { wikiGetInstructionsManifest } from '../src/manifests/instructions';
import * as CoreLlmTools from '../src/index';

describe('wikiGetInstructionsManifest', () => {
  it('is a memory:read function tool named wiki_get_instructions that requires entityId', () => {
    expect(wikiGetInstructionsManifest.name).toBe('wiki_get_instructions');
    expect(wikiGetInstructionsManifest.scope).toBe('memory:read');
    expect(wikiGetInstructionsManifest.schema.name).toBe(wikiGetInstructionsManifest.name);
    expect(wikiGetInstructionsManifest.schema.parameters?.required).toEqual(['entityId']);
    expect((wikiGetInstructionsManifest.schema.parameters?.properties as Record<string, { type: string }>).entityId.type).toBe('string');
  });

  it('is exported from the package entry point', () => {
    expect(CoreLlmTools.wikiGetInstructionsManifest).toBe(wikiGetInstructionsManifest);
  });
});