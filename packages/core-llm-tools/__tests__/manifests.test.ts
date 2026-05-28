import { describe, it, expect } from 'vitest';
import { getCurrentTimeManifest, escalateToCloudManifest } from '../src/manifests/core';

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
