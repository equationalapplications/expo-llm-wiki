import { describe, it, expect } from 'vitest';
import * as CoreLlmTools from '../src/index';

describe('package public API', () => {
  it('exports buildAuthorizedSchemaArray and buildAuthorizedToolsArray', () => {
    expect(typeof CoreLlmTools.buildAuthorizedSchemaArray).toBe('function');
    expect(typeof CoreLlmTools.buildAuthorizedToolsArray).toBe('function');
  });

  it('exports googleSearchManifest alongside existing core manifests', () => {
    expect(CoreLlmTools.googleSearchManifest.name).toBe('google_search');
    expect(CoreLlmTools.getCurrentTimeManifest.name).toBe('get_current_time');
    expect(CoreLlmTools.escalateToCloudManifest.name).toBe('escalate_to_cloud_agent');
  });
});
