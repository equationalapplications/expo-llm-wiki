import type { OntologyMode, WriteOntologyPromptContext } from '../types';

const FACT_ONTOLOGY_FIELDS = `
Each fact may optionally include:
- "okf_type": string — must be one of the node_types in the manifest
- "edges": [{ "edge_type": string, "target_title": string }] — target_title must match another fact's title in this response or existing memory
- An edge_type may appear in the manifest multiple times with different source_type/target_type; use the row whose types match your fact and target.
Each node is a fact. To link two things with an edge, each must exist as its own fact, titled by the same name you use in \`target_title\`.`;

const EMERGENT_EXTRA = `
You may also return "ontology_updates" to propose new types:
"ontology_updates": {
  "node_types": [{ "type": "slug", "description": "...", "parent_type": "optional existing slug" }],
  "edge_types": [{ "type": "slug", "source_type": "...", "target_type": "...", "description": "..." }]
}
Only propose types not already in the manifest. Do not redefine existing types.`;

export function buildOntologyPromptAppendix(
  mode: OntologyMode,
  manifestJson: string,
): { ontologyManifest: string; ontologyModeInstructions: string } {
  const strictRules = mode === 'strict'
    ? 'STRICT MODE: Use ONLY types defined in the manifest. If a fact does not fit a node_type, choose the closest type the fact is an example of; omit only when none applies even broadly.'
    : 'EMERGENT MODE: Prefer manifest types. You may propose new types via ontology_updates when necessary.';

  const fallback = 'If okf_type or an edge is invalid, omit them rather than inventing unlisted types.';

  const ontologyModeInstructions = [
    '## Ontology constraints',
    strictRules,
    fallback,
    FACT_ONTOLOGY_FIELDS,
    mode === 'emergent' ? EMERGENT_EXTRA : '',
    'Manifest:',
    manifestJson,
  ].filter(Boolean).join('\n');

  return { ontologyManifest: manifestJson, ontologyModeInstructions };
}

// ---------------------------------------------------------------------------
// Write-path appendix (specs/type-on-write §5). Its text equals the backfill
// appendix above for the same inputs in this step, but it is produced from its
// OWN constants so a later edit to either site cannot reach the other. The
// byte-identity and split tests are the guard.
// ---------------------------------------------------------------------------

const WRITE_FACT_ONTOLOGY_FIELDS = `
Each fact may optionally include:
- "okf_type": string — must be one of the node_types in the manifest
- "edges": [{ "edge_type": string, "target_title": string }] — target_title must match another fact's title in this response or existing memory
- An edge_type may appear in the manifest multiple times with different source_type/target_type; use the row whose types match your fact and target.
Each node is a fact. To link two things with an edge, each must exist as its own fact, titled by the same name you use in \`target_title\`.`;

const WRITE_EMERGENT_EXTRA = `
You may also return "ontology_updates" to propose new types:
"ontology_updates": {
  "node_types": [{ "type": "slug", "description": "...", "parent_type": "optional existing slug" }],
  "edge_types": [{ "type": "slug", "source_type": "...", "target_type": "...", "description": "..." }]
}
Only propose types not already in the manifest. Do not redefine existing types.`;

export function buildWriteOntologyAppendix(
  mode: OntologyMode,
  manifestJson: string,
): WriteOntologyPromptContext {
  const strictRules = mode === 'strict'
    ? 'STRICT MODE: Use ONLY types defined in the manifest. If a fact does not fit a node_type, choose the closest type the fact is an example of; omit only when none applies even broadly.'
    : 'EMERGENT MODE: Prefer manifest types. You may propose new types via ontology_updates when necessary.';

  const fallback = 'If okf_type or an edge is invalid, omit them rather than inventing unlisted types.';

  const ontologyModeInstructions = [
    '## Ontology constraints',
    strictRules,
    fallback,
    WRITE_FACT_ONTOLOGY_FIELDS,
    mode === 'emergent' ? WRITE_EMERGENT_EXTRA : '',
    'Manifest:',
    manifestJson,
  ].filter(Boolean).join('\n');

  return { site: 'write', ontologyManifest: manifestJson, ontologyModeInstructions };
}
