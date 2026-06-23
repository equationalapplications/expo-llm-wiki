import type { AgentToolManifest } from '../types';

export const wikiGetOntologyManifest: AgentToolManifest = {
  name: 'wiki_get_ontology',
  scope: 'memory:read',
  schema: {
    name: 'wiki_get_ontology',
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

export const wikiTraverseGraphManifest: AgentToolManifest = {
  name: 'wiki_traverse_graph',
  scope: 'memory:read',
  schema: {
    name: 'wiki_traverse_graph',
    description:
      'Traverse the knowledge graph starting from a specific fact ID to discover connected concepts and relationships. Returns a formatted neighborhood subgraph.',
    parameters: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'The namespace/entity ID to traverse.' },
        sourceId: { type: 'string', description: 'The exact ID of the starting fact node (obtained from a previous wiki_read call).' },
        maxDepth: { type: 'integer', description: 'How many relationship hops to traverse. Maximum allowed is 3.' },
        direction: { type: 'string', enum: ['inbound', 'outbound', 'both'], description: "The direction of relationships to follow. Default 'both'." },
        edgeTypes: { type: 'array', items: { type: 'string' }, description: 'Optional filter. If provided, traversal only follows these edge types (e.g. ["reports_to", "depends_on"]).' },
      },
      required: ['entityId', 'sourceId'],
    },
  },
};
