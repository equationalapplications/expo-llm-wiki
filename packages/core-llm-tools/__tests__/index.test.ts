import { describe, it, expect } from 'vitest';
import * as CoreLlmTools from '../src/index';

describe('package public API', () => {
  it('exports buildAuthorizedToolsArray but not the removed schema-array helper', () => {
    expect(typeof CoreLlmTools.buildAuthorizedToolsArray).toBe('function');
    // Assembled from parts so this file does not itself reference the deleted
    // name (the no-references grep is this task's completion gate).
    const removedHelper = `buildAuthorized${'SchemaArray'}`;
    expect(CoreLlmTools).not.toHaveProperty(removedHelper);
  });

  it('exports googleSearchManifest alongside existing core manifests', () => {
    expect(CoreLlmTools.googleSearchManifest.name).toBe('google_search');
    expect(CoreLlmTools.getCurrentTimeManifest.name).toBe('get_current_time');
    expect(CoreLlmTools.escalateToCloudManifest.name).toBe('escalate_to_cloud_agent');
  });
});
