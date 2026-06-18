import { describe, it, expect } from 'vitest';
import { buildAuthorizedSchemaArray, buildAuthorizedToolsArray } from '../src/injector';
import type { AgentToolManifest, BuiltInToolManifest } from '../src/types';

const coreTool: AgentToolManifest = {
  name: 'get_current_time',
  scope: 'core',
  schema: { name: 'get_current_time', description: 'Get time' },
};

const calendarReadTool: AgentToolManifest = {
  name: 'read_calendar',
  scope: 'calendar:read',
  schema: { name: 'read_calendar', description: 'Read calendar events' },
};

const messagesSendTool: AgentToolManifest = {
  name: 'send_message',
  scope: 'messages:send',
  schema: { name: 'send_message', description: 'Send a message' },
};

const explicitUndefinedKindTool: AgentToolManifest = {
  name: 'explicit_undefined_kind',
  scope: 'core',
  kind: undefined,
  schema: { name: 'explicit_undefined_kind', description: 'explicit undefined kind' },
};

const googleSearchTool: BuiltInToolManifest = {
  name: 'google_search',
  scope: 'core',
  kind: 'built_in',
  builtIn: 'google_search',
};

describe('buildAuthorizedSchemaArray', () => {
  it('always includes core-scoped tools regardless of granted scopes', () => {
    const result = buildAuthorizedSchemaArray([coreTool, calendarReadTool], []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(coreTool.schema);
  });

  it('includes non-core tool when its scope is granted', () => {
    const result = buildAuthorizedSchemaArray(
      [coreTool, calendarReadTool],
      ['calendar:read']
    );
    expect(result).toHaveLength(2);
    expect(result).toContainEqual(calendarReadTool.schema);
  });

  it('excludes non-core tool when its scope is not granted', () => {
    const result = buildAuthorizedSchemaArray(
      [coreTool, calendarReadTool, messagesSendTool],
      ['calendar:read']
    );
    expect(result).toHaveLength(2);
    expect(result).not.toContainEqual(messagesSendTool.schema);
  });

  it('returns raw schema objects, not manifest wrappers', () => {
    const result = buildAuthorizedSchemaArray([coreTool], []);
    expect(result[0]).not.toHaveProperty('scope');
    expect(result[0]).toHaveProperty('name');
    expect(result[0]).toHaveProperty('description');
  });

  it('returns empty array when manifests list is empty', () => {
    const result = buildAuthorizedSchemaArray([], ['calendar:read']);
    expect(result).toHaveLength(0);
  });

  it('includes multiple granted scopes', () => {
    const result = buildAuthorizedSchemaArray(
      [coreTool, calendarReadTool, messagesSendTool],
      ['calendar:read', 'messages:send']
    );
    expect(result).toHaveLength(3);
  });

  it('ignores built-in manifests (deprecated — use buildAuthorizedToolsArray)', () => {
    const result = buildAuthorizedSchemaArray([coreTool, googleSearchTool], []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(coreTool.schema);
  });
});

describe('buildAuthorizedToolsArray', () => {
  it('returns a functionDeclarations entry plus one entry per authorized built-in tool', () => {
    const result = buildAuthorizedToolsArray([coreTool, googleSearchTool], []);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ functionDeclarations: [coreTool.schema] });
    expect(result).toContainEqual({ google_search: {} });
  });

  it('omits the functionDeclarations entry when no function manifests are authorized', () => {
    const result = buildAuthorizedToolsArray([googleSearchTool], []);
    expect(result).toHaveLength(1);
    expect(result).toContainEqual({ google_search: {} });
  });

  it('omits built-in entries when none are authorized', () => {
    const result = buildAuthorizedToolsArray([coreTool], []);
    expect(result).toHaveLength(1);
    expect(result).toContainEqual({ functionDeclarations: [coreTool.schema] });
  });

  it('always includes core-scoped built-in tools regardless of granted scopes', () => {
    const result = buildAuthorizedToolsArray([googleSearchTool], []);
    expect(result).toContainEqual({ google_search: {} });
  });

  it('excludes a non-core built-in tool scope mismatch and a non-core function tool together', () => {
    const result = buildAuthorizedToolsArray(
      [calendarReadTool, googleSearchTool],
      []
    );
    expect(result).toHaveLength(1);
    expect(result).toContainEqual({ google_search: {} });
  });

  it('treats an explicit kind: undefined manifest as a function manifest', () => {
    const result = buildAuthorizedToolsArray([explicitUndefinedKindTool], []);
    expect(result).toContainEqual({
      functionDeclarations: [explicitUndefinedKindTool.schema],
    });
  });

  it('returns an empty array when manifests list is empty', () => {
    const result = buildAuthorizedToolsArray([], ['calendar:read']);
    expect(result).toHaveLength(0);
  });
});
