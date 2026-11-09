import { describe, it, expect } from 'vitest';
import { ontologyGetManifest, graphTraverseManifest } from '../src/manifests/graph';

describe('ontologyGetManifest', () => {
  it('has name ontology_get', () => {
    expect(ontologyGetManifest.name).toBe('ontology_get');
  });

  it('scope is memory:read', () => {
    expect(ontologyGetManifest.scope).toBe('memory:read');
  });

  it('schema name matches manifest name', () => {
    expect(ontologyGetManifest.schema.name).toBe(ontologyGetManifest.name);
  });

  it('requires entityId', () => {
    expect(ontologyGetManifest.schema.parameters?.required).toEqual(['entityId']);
  });
});

describe('graphTraverseManifest', () => {
  it('has name graph_traverse', () => {
    expect(graphTraverseManifest.name).toBe('graph_traverse');
  });

  it('scope is memory:read', () => {
    expect(graphTraverseManifest.scope).toBe('memory:read');
  });

  it('schema name matches manifest name', () => {
    expect(graphTraverseManifest.schema.name).toBe(graphTraverseManifest.name);
  });

  it('requires entityId and sourceId', () => {
    expect(graphTraverseManifest.schema.parameters?.required).toEqual(['entityId', 'sourceId']);
  });

  it('declares maxDepth, direction, and edgeTypes as optional parameters', () => {
    const props = graphTraverseManifest.schema.parameters?.properties as Record<string, any>;
    expect(props).toHaveProperty('maxDepth');
    expect(props).toHaveProperty('direction');
    expect(props).toHaveProperty('edgeTypes');
    expect(props.maxDepth).toMatchObject({ type: 'integer', minimum: 1, maximum: 3 });
    expect(props.direction).toMatchObject({ type: 'string', enum: ['inbound', 'outbound', 'both'] });
  });

  it('declares optional boolean excludeDrafts', () => {
    const props = graphTraverseManifest.schema.parameters?.properties as Record<string, any>;
    expect(props.excludeDrafts).toMatchObject({ type: 'boolean' });
    expect(graphTraverseManifest.schema.parameters?.required).not.toContain('excludeDrafts');
  });
});
