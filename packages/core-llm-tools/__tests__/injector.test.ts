import { describe, it, expect } from 'vitest';
import { buildAuthorizedSchemaArray } from '../src/injector';
import type { AgentToolManifest } from '../src/types';

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
});
