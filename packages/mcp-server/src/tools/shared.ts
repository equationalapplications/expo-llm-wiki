import { z } from 'zod';
import type { SynapseTreeClient } from '../client';
import type { OperationId } from '../contract';
import { NO_NAMESPACE_MESSAGE, UsageError } from '../errors';

export interface ToolContext {
  client: SynapseTreeClient;
  defaultNamespace?: string;
}

export interface ToolDefinition<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  /** The text the model reads. Spec §8 wording is verbatim. */
  description: string;
  operation: OperationId;
  inputSchema: S;
  handler: (input: z.output<S>, ctx: ToolContext) => Promise<unknown>;
}

export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export const namespaceField = z
  .string()
  .regex(NAMESPACE_PATTERN, 'namespace must match ^[a-z0-9][a-z0-9._:-]{0,127}$')
  .optional()
  .describe('Namespace to use. Defaults to the configured namespace (synapsetree-mcp config set namespace repo:<name>).');

export const dateTimeField = z.iso.datetime({ offset: true });

export const confidenceField = z.enum(['certain', 'inferred', 'tentative']);

export function resolveNamespace(given: string | undefined, ctx: ToolContext): string {
  const namespace = given ?? ctx.defaultNamespace;
  if (!namespace) throw new UsageError(NO_NAMESPACE_MESSAGE);
  return namespace;
}

/** Drops undefined values so the request body carries only what the caller set. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
