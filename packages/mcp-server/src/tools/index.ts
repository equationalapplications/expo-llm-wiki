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

export type { ToolContext, ToolDefinition } from './shared';
