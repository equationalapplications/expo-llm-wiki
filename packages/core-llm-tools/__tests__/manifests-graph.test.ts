import { describe, it, expect } from 'vitest';
import { wikiGetOntologyManifest, wikiTraverseGraphManifest } from '../src/manifests/graph';

describe('wikiGetOntologyManifest', () => {
  it('has name wiki_get_ontology', () => {
    expect(wikiGetOntologyManifest.name).toBe('wiki_get_ontology');
  });

  it('scope is memory:read', () => {
    expect(wikiGetOntologyManifest.scope).toBe('memory:read');
  });

  it('schema name matches manifest name', () => {
    expect(wikiGetOntologyManifest.schema.name).toBe(wikiGetOntologyManifest.name);
  });

  it('requires entityId', () => {
    expect(wikiGetOntologyManifest.schema.parameters?.required).toEqual(['entityId']);
  });
});

describe('wikiTraverseGraphManifest', () => {
  it('has name wiki_traverse_graph', () => {
    expect(wikiTraverseGraphManifest.name).toBe('wiki_traverse_graph');
  });

  it('scope is memory:read', () => {
    expect(wikiTraverseGraphManifest.scope).toBe('memory:read');
  });

  it('schema name matches manifest name', () => {
    expect(wikiTraverseGraphManifest.schema.name).toBe(wikiTraverseGraphManifest.name);
  });

  it('requires entityId and sourceId', () => {
    expect(wikiTraverseGraphManifest.schema.parameters?.required).toEqual(['entityId', 'sourceId']);
  });

  it('declares maxDepth, direction, and edgeTypes as optional parameters', () => {
    const props = wikiTraverseGraphManifest.schema.parameters?.properties as Record<string, any>;
    expect(props).toHaveProperty('maxDepth');
    expect(props).toHaveProperty('direction');
    expect(props).toHaveProperty('edgeTypes');
    expect(props.maxDepth).toMatchObject({ type: 'integer', minimum: 1, maximum: 3 });
    expect(props.direction).toMatchObject({ type: 'string', enum: ['inbound', 'outbound', 'both'] });
  });
});
