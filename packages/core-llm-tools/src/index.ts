export type {
  AgentScope,
  AgentToolManifest,
  AgentToolSchema,
  AnyAgentToolManifest,
  FunctionToolManifest,
  BuiltInToolManifest,
  BuiltInToolName,
} from './types';
export { buildAuthorizedToolsArray } from './injector';
export { AUTHORIZED_SCOPES, isAuthorizedScope } from './scopes';
export type { AuthorizedScope } from './scopes';
export type { GeminiToolEntry } from './injector';
export {
  getCurrentTimeManifest,
  escalateToCloudManifest,
  googleSearchManifest,
} from './manifests/core';
export {
  graphTraverseManifest,
  ontologyGetManifest,
  wikiGetOntologyManifest,
  wikiTraverseGraphManifest,
} from './manifests/graph';
export { instructionsGetManifest, wikiGetInstructionsManifest } from './manifests/instructions';
export { LEGACY_TOOL_NAMES, canonicalToolName } from './legacy';
export type { LegacyToolName } from './legacy';
