import { graphTraverse } from './graph-traverse';
import { memoryIngest } from './memory-ingest';
import { memoryLogEvent } from './memory-log-event';
import { memoryRemember } from './memory-remember';
import { memorySearch } from './memory-search';
import { memorySupersede } from './memory-supersede';
import { namespacesList } from './namespaces-list';
import type { ToolDefinition } from './shared';
import { whoami } from './whoami';

/** The only place tools are enumerated. Order is the spec §8 table. Adding an entry is a spec amendment (R4). */
export const TOOLS: readonly ToolDefinition[] = [
  memorySearch,
  memoryRemember,
  memorySupersede,
  memoryIngest,
  memoryLogEvent,
  graphTraverse,
  namespacesList,
  whoami,
] as unknown as readonly ToolDefinition[];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/**
 * The canonical tool names this server mirrors from SynapseTree's cloud surface
 * (spec §8, ruling R9; naming convention per SynapseTree PR #151). Written out
 * by hand on purpose, NOT derived from `TOOLS`: the parity test asserts set
 * equality between this list and the names the server actually registers, so
 * any rename or new tool must change both. Names that are ratified but not yet
 * wired here (`ontology_get`) stay out until the server wires them.
 */
export const CANONICAL_TOOL_NAMES = [
  'memory_search',
  'memory_remember',
  'memory_supersede',
  'memory_ingest',
  'memory_log_event',
  'graph_traverse',
  'namespaces_list',
  'whoami',
] as const;

export type { ToolContext, ToolDefinition } from './shared';
