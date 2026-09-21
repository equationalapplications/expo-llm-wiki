import type { AgentToolManifest } from '../types';

/**
 * Schema only. Hosts dispatch it to `WikiMemory.getInstructions(entityId)`.
 * The result includes `WikiConfig.prompts` overrides verbatim, so any client
 * granted `memory:read` can read them.
 */
export const wikiGetInstructionsManifest: AgentToolManifest = {
  name: 'wiki_get_instructions',
  scope: 'memory:read',
  schema: {
    name: 'wiki_get_instructions',
    description:
      "Retrieve the rules the memory engine follows when it writes: the effective system instructions for ingest, librarian, heal and ontology backfill, with the user's configured overrides and ontology constraints applied. Read these before proposing facts so your output follows the same rules. Returns instruction templates only, never stored memory content.",
    parameters: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'The namespace/entity ID whose instructions to fetch.' },
      },
      required: ['entityId'],
    },
  },
};