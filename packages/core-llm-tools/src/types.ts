export type AgentScope =
  | 'core'
  | 'location:read'
  | 'calendar:read'
  | 'calendar:write'
  | 'messages:send'
  | 'memory:read'
  | 'memory:write';

export interface AgentToolSchema {
  name: string;
  description: string;
  parameters?: {
    type: 'object' | 'string' | 'number' | 'boolean' | 'array';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface AgentToolManifest {
  name: string;
  scope: AgentScope;
  schema: AgentToolSchema;
}
