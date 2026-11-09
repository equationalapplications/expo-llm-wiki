import type { AgentToolManifest } from '../types';

/** `ontology_get`: the entity's ontology manifest. Hosts dispatch it to `WikiMemory.getOntologyManifest`. */
export const ontologyGetManifest: AgentToolManifest = {
  name: 'ontology_get',
  scope: 'memory:read',
  schema: {
    name: 'ontology_get',
    description:
      "Retrieve the current ontology manifest (allowed node types and edge types) for the user's memory. Use this to understand the structure of the knowledge graph and what relationships exist.",
    parameters: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'The namespace/entity ID to inspect.' },
      },
      required: ['entityId'],
    },
  },
};

/** `graph_traverse`: a fact's graph neighborhood. Hosts dispatch it to `WikiMemory.traverseGraph`. */
export const graphTraverseManifest: AgentToolManifest = {
  name: 'graph_traverse',
  scope: 'memory:read',
  schema: {
    name: 'graph_traverse',
    description:
      'Traverse the knowledge graph starting from a specific fact ID to discover connected concepts and relationships. Returns a formatted neighborhood subgraph.',
    parameters: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'The namespace/entity ID to traverse.' },
        sourceId: { type: 'string', description: 'The exact ID of the starting fact node (obtained from a previous wiki_read call).' },
        maxDepth: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          description: 'How many relationship hops to traverse. Maximum allowed is 3.',
        },
        direction: { type: 'string', enum: ['inbound', 'outbound', 'both'], description: "The direction of relationships to follow. Default 'both'." },
        edgeTypes: { type: 'array', items: { type: 'string' }, description: 'Optional filter. If provided, traversal only follows these edge types (e.g. ["reports_to", "depends_on"]).' },
        excludeDrafts: {
          type: 'boolean',
          description: 'When true, unreviewed draft facts are not discovered or traversed through. The starting fact is always returned. Default false.',
        },
      },
      required: ['entityId', 'sourceId'],
    },
  },
};
