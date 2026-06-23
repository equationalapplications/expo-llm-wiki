import type { OntologyMode } from '../types';

const FACT_ONTOLOGY_FIELDS = `
Each fact may optionally include:
- "okf_type": string — must be one of the node_types in the manifest
- "edges": [{ "edge_type": string, "target_title": string }] — target_title must match another fact's title in this response or existing memory`;

const EMERGENT_EXTRA = `
You may also return "ontology_updates" to propose new types:
"ontology_updates": {
  "node_types": [{ "type": "slug", "description": "..." }],
  "edge_types": [{ "type": "slug", "source_type": "...", "target_type": "...", "description": "..." }]
}
Only propose types not already in the manifest. Do not redefine existing types.`;

export function buildOntologyPromptAppendix(
  mode: OntologyMode,
  manifestJson: string,
): { ontologyManifest: string; ontologyModeInstructions: string } {
  const strictRules = mode === 'strict'
    ? 'STRICT MODE: Use ONLY types defined in the manifest. If a fact does not fit any node_type, omit okf_type and edges entirely.'
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
