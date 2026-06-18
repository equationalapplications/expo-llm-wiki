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
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Names of Gemini built-in tools (executed server-side, no client handler). */
export type BuiltInToolName = 'google_search';

/** A tool backed by a client-implemented function-calling schema. */
export interface FunctionToolManifest {
  name: string;
  scope: AgentScope;
  /** Optional for backward compatibility — manifests without this field are function tools. */
  kind?: 'function';
  schema: AgentToolSchema;
}

/** A Gemini built-in tool (e.g. google_search) — no client handler, no parameters. */
export interface BuiltInToolManifest {
  name: string;
  scope: AgentScope;
  kind: 'built_in';
  builtIn: BuiltInToolName;
}

export type AgentToolManifest = FunctionToolManifest | BuiltInToolManifest;
