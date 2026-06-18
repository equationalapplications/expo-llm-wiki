import type {
  AgentToolManifest,
  AgentToolSchema,
  BuiltInToolName,
  FunctionToolManifest,
} from './types';

/**
 * @deprecated Use buildAuthorizedToolsArray instead — it returns the full Gemini
 * tools[] array, including built-in tools like google_search. This function only
 * ever returns function-declaration schemas; built-in manifests are ignored.
 */
export function buildAuthorizedSchemaArray(
  availableManifests: AgentToolManifest[],
  userGrantedScopes: string[]
): AgentToolSchema[] {
  return availableManifests
    .filter(
      (manifest) =>
        manifest.scope === 'core' || userGrantedScopes.includes(manifest.scope)
    )
    .filter(
      (manifest): manifest is FunctionToolManifest => manifest.kind !== 'built_in'
    )
    .map((manifest) => manifest.schema);
}

/** One entry of a Gemini `tools[]` array: a function-declarations group, or a built-in tool. */
export type GeminiToolEntry =
  | { functionDeclarations: AgentToolSchema[] }
  | { [K in BuiltInToolName]: Record<string, never> };

/**
 * Filters manifests by granted scope (core-scoped manifests always pass) and
 * returns the full Gemini tools[] array: at most one functionDeclarations
 * group, plus one entry per authorized built-in tool.
 */
export function buildAuthorizedToolsArray(
  availableManifests: AgentToolManifest[],
  userGrantedScopes: string[]
): GeminiToolEntry[] {
  const authorized = availableManifests.filter(
    (manifest) =>
      manifest.scope === 'core' || userGrantedScopes.includes(manifest.scope)
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
      entries.push({ [manifest.builtIn]: {} } as GeminiToolEntry);
    }
  }

  return entries;
}
