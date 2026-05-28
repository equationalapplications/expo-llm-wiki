import type { AgentToolManifest, AgentToolSchema } from './types';

export function buildAuthorizedSchemaArray(
  availableManifests: AgentToolManifest[],
  userGrantedScopes: string[]
): AgentToolSchema[] {
  return availableManifests
    .filter(
      (manifest) =>
        manifest.scope === 'core' || userGrantedScopes.includes(manifest.scope)
    )
    .map((manifest) => manifest.schema);
}
