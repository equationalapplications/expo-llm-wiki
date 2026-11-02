import type { AgentToolManifest } from './types';

/**
 * Old-to-new map for the three `wiki_*` tool names, renamed to the
 * `<resource>_<verb>` convention (SynapseTree spec R6, §3.5.1, 2026-11-02).
 *
 * Removed, with the `wiki_*` manifests and `canonicalToolName`, at the next
 * major of core-llm-tools (at least one minor release after the one that added
 * it; #324). Deliberately not marked deprecated: hosts are told to use it while they
 * migrate.
 */
export const LEGACY_TOOL_NAMES = Object.freeze({
  wiki_traverse_graph: 'graph_traverse',
  wiki_get_ontology: 'ontology_get',
  wiki_get_instructions: 'instructions_get',
} as const);

/** A deprecated `wiki_*` tool name. */
export type LegacyToolName = keyof typeof LEGACY_TOOL_NAMES;

let warned = false;

/**
 * Returns the canonical name for a legacy `wiki_*` tool name, and any other
 * name unchanged. Route your function-call `switch` through it when you move
 * to the canonical manifests, so calls that still carry an old name (for
 * example from a stored prompt) reach the same handler.
 *
 * Logs one deprecation warning per process, the first time it maps a legacy
 * name.
 *
 * Never send the legacy and canonical manifest for one operation to the same
 * model: the model would choose between them.
 *
 * Removed at the next major of core-llm-tools, with `LEGACY_TOOL_NAMES` and
 * the `wiki_*` manifests (#324). Deliberately not marked deprecated: it is the migration
 * path the docs prescribe.
 */
export function canonicalToolName(name: string): string {
  if (!Object.prototype.hasOwnProperty.call(LEGACY_TOOL_NAMES, name)) return name;
  const canonical = LEGACY_TOOL_NAMES[name as LegacyToolName];
  if (!warned) {
    warned = true;
    const map = Object.entries(LEGACY_TOOL_NAMES)
      .map(([from, to]) => `${from} → ${to}`)
      .join(', ');
    console.warn(
      `[core-llm-tools] Tool name "${name}" is deprecated; use "${canonical}". ` +
        `The wiki_* names (${map}) are removed at the next major. This warning is shown once per process.`,
    );
  }
  return canonical;
}

/**
 * Derives a manifest from its canonical twin by name substitution only, so a
 * legacy manifest's scope, description and parameters cannot drift.
 * @internal
 */
export function renamed(manifest: AgentToolManifest, name: string): AgentToolManifest {
  return { ...manifest, name, schema: { ...manifest.schema, name } };
}
