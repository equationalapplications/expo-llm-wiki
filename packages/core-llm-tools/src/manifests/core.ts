import type { AgentToolManifest, BuiltInToolManifest } from '../types';

export const getCurrentTimeManifest: AgentToolManifest = {
  name: 'get_current_time',
  scope: 'core',
  schema: {
    name: 'get_current_time',
    description:
      'Get the exact current date and time. Always call this tool first if resolving relative temporal words like "today" or "tomorrow".',
    parameters: { type: 'object', properties: {} },
  },
};

export const escalateToCloudManifest: AgentToolManifest = {
  name: 'escalate_to_cloud_agent',
  scope: 'core',
  schema: {
    name: 'escalate_to_cloud_agent',
    description:
      'Use this tool when the user asks to schedule a reminder, perform deep memory searches, or execute a complex workflow that requires cloud resources.',
    parameters: { type: 'object', properties: {} },
  },
};

export const googleSearchManifest: BuiltInToolManifest = {
  name: 'google_search',
  scope: 'core',
  kind: 'built_in',
  builtIn: 'google_search',
};
