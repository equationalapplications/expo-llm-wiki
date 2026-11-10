import type {
  AgentToolManifest,
  AgentToolSchema,
  AnyAgentToolManifest,
  BuiltInToolName,
  FunctionToolManifest,
} from './types';
import { isAuthorizedScope } from './scopes';

/**
 * The `tools[]` key Gemini reads for each built-in tool. Manifest names stay
 * snake_case; the wire key is camelCase because `@google/genai` reads only
 * `googleSearch` and silently drops `google_search`. The REST API accepts
 * both spellings (proto3 JSON), so camelCase works on every path.
 */
export const GEMINI_BUILT_IN_TOOL_KEYS = {
  google_search: 'googleSearch',
} as const satisfies Record<BuiltInToolName, string>;

/** A Gemini `tools[]` key for a built-in tool, e.g. `googleSearch`. */
export type GeminiBuiltInToolKey = (typeof GEMINI_BUILT_IN_TOOL_KEYS)[BuiltInToolName];

/**
 * One entry of a Gemini `tools[]` array: a function-declarations group, or a
 * built-in tool. Entries this module builds always carry the camelCase wire
 * key; the snake_case manifest spelling stays accepted so consumers of the
 * pre-rename shape keep compiling.
 */
export type GeminiToolEntry =
  | { functionDeclarations: AgentToolSchema[] }
  | { [K in keyof typeof GEMINI_BUILT_IN_TOOL_KEYS]: Record<string, never> }
  | { [K in GeminiBuiltInToolKey]: Record<string, never> };

/**
 * Filters manifests by granted scope (core-scoped manifests always pass) and
 * returns the full Gemini tools[] array: at most one functionDeclarations
 * group, plus one entry per authorized built-in tool.
 */
export function buildAuthorizedToolsArray(
  availableManifests: AnyAgentToolManifest[],
  userGrantedScopes: string[]
): GeminiToolEntry[] {
  const authorized = availableManifests.filter(
    (manifest) =>
      isAuthorizedScope(manifest.scope) || userGrantedScopes.includes(manifest.scope)
  );

  const entries: GeminiToolEntry[] = [];

  const fnSchemas = authorized
    .filter(
      (manifest): manifest is FunctionToolManifest => manifest.kind !== 'built_in'
    )
    .map((manifest) => manifest.schema);
  if (fnSchemas.length > 0) entries.push({ functionDeclarations: fnSchemas });

  for (const manifest of authorized) {
    if (manifest.kind === 'built_in') {
      entries.push({ [GEMINI_BUILT_IN_TOOL_KEYS[manifest.builtIn]]: {} } as GeminiToolEntry);
    }
  }

  return entries;
}
