import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerByEmail } from './authmd';
import { SynapseTreeClient } from './client';
import {
  KEY_PATTERN, configDir, deleteCredentials, maskKey, readConfig, resolveSettings, validateBaseUrl, writeConfig, writeCredentials, type Settings,
} from './credentials';
import { NO_KEY_MESSAGE, SynapseTreeError, UsageError } from './errors';
import { stripTrailingSlashes } from './client';
import { createServer } from './server';
import { NAMESPACE_PATTERN } from './tools/shared';
import type { WhoamiResult } from './tools/whoami';
import { VERSION } from './version';

export type Command =
  | { kind: 'serve' }
  | { kind: 'auth-key'; key: string }
  | { kind: 'auth-email'; email: string; baseUrl?: string }
  | { kind: 'auth-revoke' }
  | { kind: 'status' }
  | { kind: 'config-set'; key: 'namespace' | 'base-url'; value: string }
  | { kind: 'help' }
  | { kind: 'version' };

export const HELP = `synapsetree-mcp ${VERSION} — SynapseTree memory for coding agents (MCP over stdio)

Usage:
  synapsetree-mcp [serve]                      run the MCP server (what your MCP client launches)
  synapsetree-mcp auth --key stree_…           store a dashboard API key
  synapsetree-mcp auth --email you@example.com [--base-url URL]
                                               register through auth.md: you approve by email
  synapsetree-mcp auth --revoke                revoke the stored key and delete it locally
  synapsetree-mcp status                       show account, scope, plan, key source, namespace
  synapsetree-mcp config set namespace repo:<name>
  synapsetree-mcp config set base-url URL
  synapsetree-mcp --version | --help

Environment: SYNAPSETREE_API_KEY, SYNAPSETREE_BASE_URL, SYNAPSETREE_NAMESPACE, SYNAPSETREE_CONFIG_DIR
Docs: https://github.com/equationalapplications/expo-llm-wiki/tree/main/packages/mcp-server#readme
`;

export function parseArgs(argv: string[]): Command {
  const [first, ...rest] = argv;
  if (first === undefined || first === 'serve') {
    if (rest.length > 0) throw new UsageError(`unexpected arguments after serve: ${rest.join(' ')}`);
    return { kind: 'serve' };
  }
  if (first === '--help' || first === '-h' || first === 'help') return { kind: 'help' };
  if (first === '--version' || first === '-v' || first === 'version') return { kind: 'version' };
  if (first === 'status') return { kind: 'status' };
  if (first === 'auth') {
    const flag = rest[0];
    if (flag === '--key') {
      const key = rest[1];
      if (!key || !KEY_PATTERN.test(key)) throw new UsageError('auth --key needs a key of the form stree_ followed by 43 characters (not shown).');
      return { kind: 'auth-key', key };
    }
    if (flag === '--email') {
      const email = rest[1];
      if (!email || !email.includes('@')) throw new UsageError('auth --email needs an email address.');
      const baseIdx = rest.indexOf('--base-url');
      const baseUrl = baseIdx >= 0 ? rest[baseIdx + 1] : undefined;
      if (baseIdx >= 0 && !baseUrl) throw new UsageError('--base-url needs a URL.');
      if (baseUrl) validateBaseUrl(baseUrl);
      return baseUrl ? { kind: 'auth-email', email, baseUrl } : { kind: 'auth-email', email };
    }
    if (flag === '--revoke') return { kind: 'auth-revoke' };
    throw new UsageError('auth needs one of --key, --email, --revoke.');
  }
  if (first === 'config') {
    const [verb, key, value] = rest;
    if (verb !== 'set' || (key !== 'namespace' && key !== 'base-url') || !value) {
      throw new UsageError('usage: config set namespace <name> | config set base-url <url>');
    }
    if (key === 'namespace' && !NAMESPACE_PATTERN.test(value)) throw new UsageError('namespace must match ^[a-z0-9][a-z0-9._:-]{0,127}$ (e.g. repo:myproject).');
    if (key === 'base-url') validateBaseUrl(value);
    return { kind: 'config-set', key, value };
  }
  throw new UsageError(`unknown command: ${first}\n${HELP}`);
}

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  configDir?: string;
}

const userAgent = `synapsetree-mcp/${VERSION}`;

function makeClient(settings: Pick<Settings, 'apiKey' | 'baseUrl'>, io: Io): SynapseTreeClient {
  return new SynapseTreeClient({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, userAgent, fetch: io.fetch });
}

async function printStatus(client: SynapseTreeClient, settings: Settings, io: Io): Promise<void> {
  const res = await client.call<WhoamiResult>('whoami');
  const w = res.data;
  const lines = [
    `key source:      ${settings.keySource ?? 'none'}`,
    `key:             ${settings.apiKey ? maskKey(settings.apiKey) : '(none)'}`,
    `organization:    ${w.organizationId}`,
    `database:        ${w.tenantDatabaseId}`,
    `scope:           ${w.scope}`,
    `plan:            ${w.planCode ?? '(none)'}`,
    `subscription:    ${w.subscriptionStatus}`,
    `base url:        ${settings.baseUrl}`,
    `namespace:       ${settings.namespace ?? '(none set)'}`,
  ];
  if (res.rateLimit) lines.push(`ratelimit:       ${res.rateLimit}`);
  if (res.rateLimitPolicy) lines.push(`ratelimit-policy: ${res.rateLimitPolicy}`);
  io.err(lines.join('\n'));
}

/** Runs one command. Returns the exit code; never throws. */
export async function run(cmd: Command, io: Io): Promise<number> {
  const dir = io.configDir ?? configDir(io.env);
  try {
    switch (cmd.kind) {
      case 'help':
        io.out(HELP);
        return 0;
      case 'version':
        io.out(`${VERSION}\n`);
        return 0;
      case 'config-set': {
        const config = await readConfig(dir);
        if (cmd.key === 'namespace') config.namespace = cmd.value;
        else config.baseUrl = stripTrailingSlashes(cmd.value);
        await writeConfig(dir, config);
        io.err(`${cmd.key} set.`);
        return 0;
      }
      case 'auth-key': {
        const settings = await resolveSettings(io.env, dir);
        const client = makeClient({ apiKey: cmd.key, baseUrl: settings.baseUrl }, io);
        await client.call('whoami');
        await writeCredentials(dir, { apiKey: cmd.key, accountId: null, source: 'dashboard', obtainedAt: new Date().toISOString() });
        io.err('Key stored.');
        if (io.env.SYNAPSETREE_API_KEY) io.err('Note: SYNAPSETREE_API_KEY is exported and overrides the stored key until you unset it.');
        await printStatus(client, { ...settings, apiKey: cmd.key, keySource: 'file', accountId: null }, io);
        return 0;
      }
      case 'auth-email': {
        const settings = await resolveSettings(io.env, dir);
        const baseUrl = (cmd.baseUrl ? stripTrailingSlashes(cmd.baseUrl) : undefined) ?? settings.baseUrl;
        const anonymous = makeClient({ apiKey: undefined, baseUrl }, io);
        const result = await registerByEmail(anonymous, cmd.email, { info: io.err });
        await writeCredentials(dir, { apiKey: result.apiKey, accountId: result.accountId, source: 'authmd', obtainedAt: new Date().toISOString() });
        if (cmd.baseUrl) await writeConfig(dir, { ...(await readConfig(dir)), baseUrl });
        io.err('Approved. Key stored.');
        if (io.env.SYNAPSETREE_API_KEY) io.err('Note: SYNAPSETREE_API_KEY is exported and overrides the stored key until you unset it.');
        const client = makeClient({ apiKey: result.apiKey, baseUrl }, io);
        await printStatus(client, { ...settings, apiKey: result.apiKey, keySource: 'file', accountId: result.accountId, baseUrl }, io);
        return 0;
      }
      case 'auth-revoke': {
        const settings = await resolveSettings(io.env, dir);
        if (!settings.apiKey) { io.err(NO_KEY_MESSAGE); return 3; }
        const client = makeClient(settings, io);
        try {
          await client.call('oauthRevoke', { form: { token: settings.apiKey, token_type_hint: 'access_token' } });
          io.err('Key revoked.');
        } catch (err) {
          if (err instanceof SynapseTreeError && err.status === 401) {
            io.err('The key was already dead on the server.');
          } else if (err instanceof SynapseTreeError && err.status === 403) {
            // The server answered and refused the revocation (e.g. admin-only
            // or owner mismatch): the local copy is kept so nothing is lost.
            io.err(`The server refused the revocation (${err.code}); the local key was kept. Remove it in the dashboard if it should die.`);
            return 1;
          } else {
            io.err(`SynapseTree was unreachable or the request failed; the local key was kept. (${err instanceof Error ? err.message : String(err)})`);
            return 1;
          }
        }
        if (settings.keySource === 'env') {
          io.err('The key came from SYNAPSETREE_API_KEY; unset that variable.');
        } else {
          await deleteCredentials(dir);
          io.err('Local copy deleted.');
        }
        return 0;
      }
      case 'status': {
        const settings = await resolveSettings(io.env, dir);
        if (!settings.apiKey) { io.err(NO_KEY_MESSAGE); return 3; }
        await printStatus(makeClient(settings, io), settings, io);
        return 0;
      }
      case 'serve': {
        const settings = await resolveSettings(io.env, dir);
        if (!settings.apiKey) { io.err(NO_KEY_MESSAGE); return 3; }
        const server = createServer({ client: makeClient(settings, io), defaultNamespace: settings.namespace });
        const transport = new StdioServerTransport();
        await server.connect(transport);
        // The SDK chains its own onclose handler during connect(); wrap it
        // instead of replacing it so the SDK's cleanup still runs.
        const previousOnClose = transport.onclose;
        await new Promise<void>((resolve) => {
          transport.onclose = () => {
            previousOnClose?.();
            resolve();
          };
        });
        return 0;
      }
    }
  } catch (err) {
    if (err instanceof UsageError) { io.err(err.message); return 2; }
    if (err instanceof SynapseTreeError) { io.err(`${err.code}${err.detail ? `: ${err.detail}` : ''}${err.requestId ? ` (request-id: ${err.requestId})` : ''}`); return 1; }
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
