import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { toolErrorText } from './errors';
import { TOOLS } from './tools';
import type { ToolContext } from './tools/shared';
import { VERSION } from './version';

export const SERVER_NAME = 'synapsetree';

/** Registers exactly the eight tools (spec §8). No resources, prompts, or sampling. */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema.shape as z.ZodRawShape },
      async (args: unknown) => {
        try {
          const input = tool.inputSchema.parse(args ?? {});
          const result = await tool.handler(input, ctx);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text' as const, text: toolErrorText(err) }] };
        }
      },
    );
  }
  return server;
}
