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

  it('no exported manifest still points the model at a removed wiki_* tool name (#324)', () => {
    const strings = (v: unknown): string[] =>
      typeof v === 'string' ? [v]
        : Array.isArray(v) ? v.flatMap(strings)
        : v && typeof v === 'object' ? Object.values(v).flatMap(strings)
        : [];
    const manifests = Object.entries(CoreLlmTools).filter(
      ([, v]) => v !== null && typeof v === 'object' && 'name' in v && 'schema' in v,
    );
    expect(manifests.length).toBeGreaterThan(0);
    for (const [exportName, manifest] of manifests) {
      for (const text of strings(manifest)) {
        // `llm_wiki_*` (the MCP server's names) is fine; a bare `wiki_*` is not.
        expect(text, `${exportName}: ${text}`).not.toMatch(/(^|[^A-Za-z0-9_])wiki_[a-z]/);
      }
    }
  });
});

