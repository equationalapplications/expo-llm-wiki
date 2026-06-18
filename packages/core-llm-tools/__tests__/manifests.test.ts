import { describe, it, expect } from 'vitest';
import { getCurrentTimeManifest, escalateToCloudManifest, googleSearchManifest } from '../src/manifests/core';

describe('getCurrentTimeManifest', () => {
  it('has name get_current_time', () => {
    expect(getCurrentTimeManifest.name).toBe('get_current_time');
  });

  it('scope is core', () => {
    expect(getCurrentTimeManifest.scope).toBe('core');
  });

  it('schema name matches manifest name', () => {
    expect(getCurrentTimeManifest.schema.name).toBe(getCurrentTimeManifest.name);
  });

  it('schema has a description', () => {
    expect(getCurrentTimeManifest.schema.description.length).toBeGreaterThan(0);
  });

  it('schema parameters is empty object properties', () => {
    expect(getCurrentTimeManifest.schema.parameters?.properties).toEqual({});
  });
});

describe('escalateToCloudManifest', () => {
  it('has name escalate_to_cloud_agent', () => {
    expect(escalateToCloudManifest.name).toBe('escalate_to_cloud_agent');
  });

  it('scope is core', () => {
    expect(escalateToCloudManifest.scope).toBe('core');
  });

  it('schema name matches manifest name', () => {
    expect(escalateToCloudManifest.schema.name).toBe(escalateToCloudManifest.name);
  });

  it('schema has a description', () => {
    expect(escalateToCloudManifest.schema.description.length).toBeGreaterThan(0);
  });
});

describe('googleSearchManifest', () => {
  it('has name google_search', () => {
    expect(googleSearchManifest.name).toBe('google_search');
  });

  it('scope is core', () => {
    expect(googleSearchManifest.scope).toBe('core');
  });

  it('kind is built_in', () => {
    expect(googleSearchManifest.kind).toBe('built_in');
  });

  it('builtIn is google_search', () => {
    expect(googleSearchManifest.builtIn).toBe('google_search');
  });
});
