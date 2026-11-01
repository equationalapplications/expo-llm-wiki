# `@equationalapplications/mcp-server` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and wire `packages/mcp-server`, a stdio MCP server that exposes eight SynapseTree memory operations as tools, with dashboard-key and auth.md credential flows, verified entirely with mocked HTTP.

**Architecture:** A vendored OpenAPI subset (`contract/`) drives a hand-written HTTP client; eight one-file tools call that client; `server.ts` registers exactly those tools on the MCP SDK; `cli.ts` is the bin with five subcommands. Credentials live in a 0600 file under the OS config dir, overridable by env vars. No network in tests: every test injects `fetch`.

**Tech Stack:** TypeScript 5.9, tsup 9 (CJS+ESM, bin shebang), vitest 5, `@modelcontextprotocol/sdk` 1.32.1 (stdio + in-memory transports), `zod` 4.6.7, Node ≥20 built-ins only (`fetch`, `crypto`, `fs/promises`).

**Spec:** `docs/superpowers/specs/2026-11-01-mcp-server-design.md` — read it first; every task cites the sections it implements. The spec wins over this plan; if they disagree, follow the spec and note the disagreement in the PR description.

## Global Constraints

- Package name exactly `@equationalapplications/mcp-server`; directory `packages/mcp-server` (spec R1, R2).
- Dependencies pinned exactly: `@modelcontextprotocol/sdk` `1.32.1`, `zod` `4.6.7`. Dev pins copied from `packages/core-llm-tools/package.json` at the time of the work (spec §4). Never add another runtime dependency.
- The package.json carries **no `"version"` field at all** (CONTRIBUTING.md forbids version edits in PRs; the release `prepareCmd` stamps `${nextRelease.version}` into it on the first release — it writes the field whether or not it exists). Do not copy `version` from the sibling template.
- Node `>=20`; no polyfills (spec §4).
- Exactly eight tools, in this order: `memory_search`, `memory_remember`, `memory_supersede`, `memory_ingest`, `memory_log_event`, `graph_traverse`, `namespaces_list`, `whoami` (spec §8). No ninth (R4). The seven withheld operations are never called (R5).
- `contract/synapsetree-openapi.subset.json` is never hand-edited (spec §10.1).
- stdout is the MCP channel: no command writes to stdout except `serve` via the transport and `--version`/`--help` (spec §5.8). Human output goes to stderr.
- The API key, the claim token, and request bodies never appear in stdout, stderr, logs, or error messages. `status` shows `stree_…` + last four characters only (spec §5.4).
- Commits: conventional, scope `mcp-server`, e.g. `feat(mcp-server): add contract table`. Branch: `feat/mcp-server` (already exists). Never commit to `main`.
- Commands run from the repo root unless a step says otherwise. Package-scoped commands use `pnpm --filter @equationalapplications/mcp-server <script>`.
- Tests: `__tests__/**/*.test.ts`, vitest, `environment: 'node'`. Every HTTP interaction uses an injected `fetch`; every filesystem test uses `fs.mkdtemp`. No test touches the network or the real config directory.
- When stuck: do not change the spec, do not widen scope, do not skip a test. Record the blocker in the PR description under "Deviations" and continue with the next task.

---

### Task 1: Package skeleton, build, and first test

**Files:**
- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/tsconfig.json`
- Create: `packages/mcp-server/tsup.config.ts`
- Create: `packages/mcp-server/vitest.config.ts`
- Create: `packages/mcp-server/LICENSE` (copy of repo `LICENSE`)
- Create: `packages/mcp-server/src/version.ts`
- Create: `packages/mcp-server/src/index.ts`
- Create: `packages/mcp-server/src/cli.ts` (placeholder, replaced in Task 9)
- Test: `packages/mcp-server/__tests__/version.test.ts`
- Already present (do not edit): `packages/mcp-server/contract/synapsetree-openapi.subset.json`

**Interfaces:**
- Produces: `VERSION: string` from `src/version.ts`; the build layout `dist/index.{js,mjs,d.ts}`, `dist/cli.{js,mjs}` with a shebang on the CLI files.

- [ ] **Step 1: Read the sibling template and record its pins**

Run from the repo root:
```bash
cat packages/core-llm-tools/package.json
node -p "require('./package.json').devDependencies['@types/node']"
```
Note the `version`, `tsup`, `typescript`, `vitest` values and the root `@types/node` pin; use them verbatim below where `<…>` appears.

- [ ] **Step 2: Create `packages/mcp-server/package.json`**

```json
{
  "name": "@equationalapplications/mcp-server",
  "description": "MCP server that gives coding agents (Claude Code, Cursor, Windsurf, Claude Desktop) a SynapseTree memory: search, remember, supersede, ingest, log events, and traverse the knowledge graph.",
  "main": "dist/index.js",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "require": "./dist/index.js",
      "import": "./dist/index.mjs"
    }
  },
  "bin": {
    "synapsetree-mcp": "./dist/cli.js",
    "mcp-server": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "files": [
    "dist",
    "contract",
    "LICENSE",
    "README.md"
  ],
  "license": "MIT",
  "keywords": [
    "mcp",
    "model-context-protocol",
    "synapsetree",
    "memory",
    "claude-code",
    "cursor",
    "windsurf",
    "llm-wiki"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/equationalapplications/expo-llm-wiki.git",
    "directory": "packages/mcp-server"
  },
  "bugs": {
    "url": "https://github.com/equationalapplications/expo-llm-wiki/issues"
  },
  "homepage": "https://github.com/equationalapplications/expo-llm-wiki/tree/main/packages/mcp-server#readme",
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.32.1",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@types/node": "<root pin>",
    "tsup": "<pin>",
    "typescript": "<pin>",
    "vitest": "<pin>"
  }
}
```

- [ ] **Step 3: Create `packages/mcp-server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": ".",
    "skipLibCheck": true
  },
  "include": ["src", "contract/*.json"],
  "exclude": ["node_modules", "dist", "__tests__"]
}
```
`rootDir` is `.` (not `src`) because `src/contract.ts` imports `../contract/*.json`; `tsc --noEmit` only typechecks, so the layout of `outDir` does not matter.

- [ ] **Step 4: Create `packages/mcp-server/tsup.config.ts`**

```ts
import { readFileSync } from 'node:fs';
import { defineConfig, type Options } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

const shared: Options = {
  format: ['cjs', 'esm'],
  sourcemap: true,
  treeshake: true,
  shims: true,
  define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
};

export default defineConfig([
  { ...shared, entry: ['src/index.ts'], dts: true, clean: true },
  { ...shared, entry: ['src/cli.ts'], dts: false, clean: false, banner: { js: '#!/usr/bin/env node' } },
]);
```

- [ ] **Step 5: Create `packages/mcp-server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 6: Copy the license and write the version module**

```bash
cp LICENSE packages/mcp-server/LICENSE
```

`packages/mcp-server/src/version.ts`:
```ts
declare const __PKG_VERSION__: string | undefined;

/** Injected by tsup `define` at build time; `0.0.0-dev` under vitest and tsc. */
export const VERSION: string = typeof __PKG_VERSION__ === 'string' ? __PKG_VERSION__ : '0.0.0-dev';
```

`packages/mcp-server/src/index.ts`:
```ts
export { VERSION } from './version';
```

`packages/mcp-server/src/cli.ts` (placeholder until Task 9):
```ts
import { VERSION } from './version';

if (process.argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
} else {
  process.stderr.write('synapsetree-mcp: not implemented yet\n');
  process.exitCode = 2;
}
```

- [ ] **Step 7: Write the failing test**

`packages/mcp-server/__tests__/version.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version';

describe('VERSION', () => {
  it('is a semver string or the dev sentinel', () => {
    expect(VERSION).toMatch(/^(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|0\.0\.0-dev)$/);
  });
});
```

- [ ] **Step 8: Install, then run the test to see it pass (it fails first only if install is wrong)**

```bash
pnpm install
pnpm --filter @equationalapplications/mcp-server test
```
Expected: `pnpm install` updates `pnpm-lock.yaml` (adds the SDK and zod); the test passes (1 test). If `pnpm install` refuses a version for being younger than 14 days, stop: the pins in the spec were checked on 2026-11-01 and are older than that; record the error in the PR.

- [ ] **Step 9: Build and typecheck; verify the shebang**

```bash
pnpm --filter @equationalapplications/mcp-server build
pnpm --filter @equationalapplications/mcp-server typecheck
head -c 21 packages/mcp-server/dist/cli.js; echo
node packages/mcp-server/dist/cli.js --version
```
Expected: `dist/index.js`, `dist/index.mjs`, `dist/index.d.ts`, `dist/cli.js`, `dist/cli.mjs` exist; `head` prints `#!/usr/bin/env node`; `--version` prints the package version (not `0.0.0-dev`).

- [ ] **Step 10: Commit**

```bash
git add packages/mcp-server pnpm-lock.yaml
git commit -m "feat(mcp-server): package skeleton, build, and version module"
```

---

### Task 2: Contract table and the D3 guards

**Files:**
- Create: `packages/mcp-server/src/contract.ts`
- Test: `packages/mcp-server/__tests__/contract.test.ts`
- Implements: spec §5.1, §10.

**Interfaces:**
- Produces:
  ```ts
  export type OperationId = 'queryMemory' | 'rememberFact' | 'supersedeFact' | 'ingestDocument' | 'createEvent' | 'traverseGraph' | 'listNamespaces' | 'whoami' | 'registerAgentIdentity' | 'oauthToken' | 'oauthRevoke';
  export const OPERATION_IDS: readonly OperationId[];
  export const WITHHELD_OPERATION_IDS: readonly string[];
  export interface Operation { operationId: OperationId; method: 'GET' | 'POST'; path: string; scope: 'read' | 'read_write' | null; requestProperties: string[]; requiredProperties: string[]; queryParameters: string[]; pathParameters: string[]; acceptsIdempotencyKey: boolean; }
  export const OPERATIONS: Readonly<Record<OperationId, Operation>>;
  export const CONTRACT_INFO: { version: string; operations: string[] };
  ```

- [ ] **Step 1: Write the failing tests**

`packages/mcp-server/__tests__/contract.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTRACT_INFO, OPERATIONS, OPERATION_IDS, WITHHELD_OPERATION_IDS } from '../src/contract';

const rawContract = readFileSync(new URL('../contract/synapsetree-openapi.subset.json', import.meta.url), 'utf8');

describe('vendored contract (spec §10.2 guard 3: D3 absence)', () => {
  it('lists exactly the eleven operations the server uses', () => {
    expect([...CONTRACT_INFO.operations].sort()).toEqual([...OPERATION_IDS].sort());
    expect(OPERATION_IDS).toHaveLength(11);
  });

  it('contains none of the memory:admin operations withheld from agents', () => {
    for (const id of WITHHELD_OPERATION_IDS) {
      expect(rawContract).not.toContain(`"operationId": "${id}"`);
    }
    expect(WITHHELD_OPERATION_IDS).toEqual([
      'exportMemory', 'importMemory', 'forgetFact', 'forgetSource',
      'deleteNamespace', 'createMaintenanceRun', 'putOntology',
    ]);
  });

  it('is marked generated, not hand-edited', () => {
    expect(rawContract).toContain('"x-generated-by"');
  });
});

describe('OPERATIONS table (spec §5.1)', () => {
  it('derives rememberFact', () => {
    const op = OPERATIONS.rememberFact;
    expect(op.method).toBe('POST');
    expect(op.path).toBe('/v1/memory/facts');
    expect(op.scope).toBe('read_write');
    expect(op.acceptsIdempotencyKey).toBe(true);
    expect(op.pathParameters).toEqual([]);
    expect(op.requestProperties).toEqual(expect.arrayContaining(['namespace', 'title', 'body', 'tags', 'confidence', 'sourceType', 'okfType', 'validFrom']));
    expect(op.requiredProperties).toEqual(expect.arrayContaining(['namespace', 'title', 'body']));
  });

  it('derives supersedeFact with its path parameter', () => {
    const op = OPERATIONS.supersedeFact;
    expect(op.path).toBe('/v1/memory/facts/{factId}/supersede');
    expect(op.pathParameters).toEqual(['factId']);
    expect(op.requestProperties).toEqual(expect.arrayContaining(['namespace', 'validFrom', 'replacement']));
    expect(op.requiredProperties).toEqual(expect.arrayContaining(['namespace', 'replacement']));
  });

  it('derives ingestDocument across its oneOf branches (union of properties, intersection of required)', () => {
    const op = OPERATIONS.ingestDocument;
    expect(op.requestProperties).toEqual(expect.arrayContaining(['mode', 'namespace', 'sourceRef', 'sourceHash', 'content', 'onDuplicateHash', 'chunks', 'planFingerprint']));
    expect(op.requiredProperties).toEqual(expect.arrayContaining(['mode', 'namespace', 'sourceRef', 'sourceHash']));
    expect(op.requiredProperties).not.toContain('content');
  });

  it('derives listNamespaces as a GET with query parameters and no idempotency key', () => {
    const op = OPERATIONS.listNamespaces;
    expect(op.method).toBe('GET');
    expect(op.queryParameters.sort()).toEqual(['after', 'limit', 'prefix']);
    expect(op.acceptsIdempotencyKey).toBe(false);
    expect(op.requestProperties).toEqual([]);
  });

  it('marks the auth.md endpoints as unscoped', () => {
    expect(OPERATIONS.registerAgentIdentity.scope).toBeNull();
    expect(OPERATIONS.oauthToken.scope).toBeNull();
    expect(OPERATIONS.oauthRevoke.scope).toBeNull();
    expect(OPERATIONS.oauthToken.requiredProperties.sort()).toEqual(['assertion', 'grant_type']);
    expect(OPERATIONS.oauthRevoke.requiredProperties).toEqual(['token']);
  });

  it('reads scopes for every read tool operation', () => {
    for (const id of ['queryMemory', 'traverseGraph', 'listNamespaces', 'whoami'] as const) {
      expect(OPERATIONS[id].scope).toBe('read');
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @equationalapplications/mcp-server test
```
Expected: FAIL — `Cannot find module '../src/contract'`.

- [ ] **Step 3: Write `packages/mcp-server/src/contract.ts`**

```ts
import contractJson from '../contract/synapsetree-openapi.subset.json';

export type OperationId =
  | 'queryMemory'
  | 'rememberFact'
  | 'supersedeFact'
  | 'ingestDocument'
  | 'createEvent'
  | 'traverseGraph'
  | 'listNamespaces'
  | 'whoami'
  | 'registerAgentIdentity'
  | 'oauthToken'
  | 'oauthRevoke';

export const OPERATION_IDS: readonly OperationId[] = [
  'queryMemory',
  'rememberFact',
  'supersedeFact',
  'ingestDocument',
  'createEvent',
  'traverseGraph',
  'listNamespaces',
  'whoami',
  'registerAgentIdentity',
  'oauthToken',
  'oauthRevoke',
];

/** memory:admin operations withheld from agents (SynapseTree ruling D3). Never called, never vendored. */
export const WITHHELD_OPERATION_IDS: readonly string[] = [
  'exportMemory',
  'importMemory',
  'forgetFact',
  'forgetSource',
  'deleteNamespace',
  'createMaintenanceRun',
  'putOntology',
];

export interface Operation {
  operationId: OperationId;
  method: 'GET' | 'POST';
  path: string;
  scope: 'read' | 'read_write' | null;
  /** Top-level request-body property names (union across oneOf/anyOf/allOf branches). */
  requestProperties: string[];
  /** Properties required in every branch. */
  requiredProperties: string[];
  queryParameters: string[];
  pathParameters: string[];
  acceptsIdempotencyKey: boolean;
}

// The subset is a plain OpenAPI 3 document; only the parts below are read.
type Json = Record<string, unknown>;
interface OpenApiDoc {
  info: Json & { version?: string; 'x-operations'?: string[] };
  paths: Record<string, Record<string, unknown>>;
  components: Record<string, Record<string, unknown>>;
}

const doc = contractJson as unknown as OpenApiDoc;

function resolve(node: unknown): Json | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const ref = (node as Json).$ref;
  if (typeof ref === 'string') {
    const [, , kind, name] = ref.split('/');
    return resolve(doc.components[kind]?.[name]);
  }
  return node as Json;
}

function shape(schema: unknown): { props: Set<string>; required: Set<string> } {
  const props = new Set<string>();
  const required = new Set<string>();
  const s = resolve(schema);
  if (!s) return { props, required };
  const branches = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (branches && branches.length > 0) {
    const shapes = branches.map(shape);
    for (const sh of shapes) for (const p of sh.props) props.add(p);
    for (const p of shapes[0].required) if (shapes.every((sh) => sh.required.has(p))) required.add(p);
  }
  for (const part of (s.allOf as unknown[] | undefined) ?? []) {
    const sh = shape(part);
    for (const p of sh.props) props.add(p);
    for (const p of sh.required) required.add(p);
  }
  for (const p of Object.keys((s.properties as Json | undefined) ?? {})) props.add(p);
  for (const p of (s.required as string[] | undefined) ?? []) required.add(p);
  return { props, required };
}

function parameters(pathItem: Record<string, unknown>, op: Json): Json[] {
  const raw = [...((pathItem.parameters as unknown[]) ?? []), ...((op.parameters as unknown[]) ?? [])];
  return raw.map((p) => resolve(p)).filter((p): p is Json => p !== undefined);
}

function build(): Record<OperationId, Operation> {
  const table = {} as Record<OperationId, Operation>;
  for (const [path, pathItem] of Object.entries(doc.paths)) {
    for (const method of ['get', 'post'] as const) {
      const op = pathItem[method] as Json | undefined;
      if (!op) continue;
      const id = op.operationId as OperationId;
      if (!OPERATION_IDS.includes(id)) continue;
      const params = parameters(pathItem, op);
      const body = resolve(op.requestBody);
      const content = (body?.content as Record<string, Json> | undefined) ?? {};
      const media = Object.values(content)[0];
      const { props, required } = shape(media?.schema);
      table[id] = {
        operationId: id,
        method: method.toUpperCase() as 'GET' | 'POST',
        path,
        scope: (op['x-synapsetree-scope'] as 'read' | 'read_write' | undefined) ?? null,
        requestProperties: [...props],
        requiredProperties: [...required],
        queryParameters: params.filter((p) => p.in === 'query').map((p) => String(p.name)),
        pathParameters: params.filter((p) => p.in === 'path').map((p) => String(p.name)),
        acceptsIdempotencyKey: params.some((p) => p.in === 'header' && p.name === 'Idempotency-Key'),
      };
    }
  }
  const missing = OPERATION_IDS.filter((id) => !(id in table));
  if (missing.length > 0) throw new Error(`contract subset is missing operations: ${missing.join(', ')}`);
  return table;
}

export const OPERATIONS: Readonly<Record<OperationId, Operation>> = build();

export const CONTRACT_INFO = {
  version: String(doc.info.version ?? ''),
  operations: [...(doc.info['x-operations'] ?? [])],
};
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @equationalapplications/mcp-server test
pnpm --filter @equationalapplications/mcp-server typecheck
```
Expected: all contract tests PASS; typecheck clean. If `requiredProperties` for `supersedeFact` lacks `replacement`, inspect the JSON: the body schema may be a `$ref`; `resolve` handles one level per call and `shape` recurses, so check the `$ref` split (`#/components/schemas/Name` → index 2 = `schemas`, 3 = `Name`).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/contract.ts packages/mcp-server/__tests__/contract.test.ts
git commit -m "feat(mcp-server): contract table from the vendored OpenAPI subset with D3 guards"
```

---

### Task 3: Error types and the tool-error text mapping

**Files:**
- Create: `packages/mcp-server/src/errors.ts`
- Test: `packages/mcp-server/__tests__/errors.test.ts`
- Implements: spec §5.3, §9.

**Interfaces:**
- Produces:
  ```ts
  export class SynapseTreeError extends Error { readonly status: number; readonly code: string; readonly detail?: string; readonly requestId?: string; readonly retryAfterSeconds?: number; constructor(init: { status: number; code: string; detail?: string; requestId?: string; retryAfterSeconds?: number }) }
  export class UsageError extends Error { constructor(message: string) }
  export const NO_NAMESPACE_MESSAGE: string;
  export const NO_KEY_MESSAGE: string;
  export function toolErrorText(err: unknown): string;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/mcp-server/__tests__/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NO_NAMESPACE_MESSAGE, SynapseTreeError, UsageError, toolErrorText } from '../src/errors';

const err = (code: string, extra: Partial<ConstructorParameters<typeof SynapseTreeError>[0]> = {}) =>
  new SynapseTreeError({ status: 400, code, ...extra });

describe('toolErrorText (spec §9)', () => {
  it('maps unauthorized to the re-auth instruction', () => {
    expect(toolErrorText(err('unauthorized', { status: 401 }))).toContain('synapsetree-mcp auth');
  });
  it('maps insufficient_scope to the dashboard', () => {
    expect(toolErrorText(err('insufficient_scope', { status: 403 }))).toContain('https://synapsetree.dev/dashboard');
  });
  it('maps subscription_inactive', () => {
    expect(toolErrorText(err('subscription_inactive'))).toMatch(/plan is paused/);
  });
  it('maps inference_not_configured to the provider instruction', () => {
    expect(toolErrorText(err('inference_not_configured', { status: 409 }))).toContain('register a provider');
  });
  it('maps upstream_inference_unavailable', () => {
    expect(toolErrorText(err('upstream_inference_unavailable'))).toMatch(/fall back to keywords/);
  });
  it('maps rate_limited with the seconds', () => {
    expect(toolErrorText(err('rate_limited', { status: 429, retryAfterSeconds: 7 }))).toContain('retry after 7 seconds');
    expect(toolErrorText(err('rate_limited', { status: 429 }))).toContain('retry after a few seconds');
  });
  it('maps not_implemented', () => {
    expect(toolErrorText(err('not_implemented', { status: 501 }))).toContain('501');
  });
  it('passes detail through verbatim for the detail codes', () => {
    for (const code of ['quota_exceeded', 'payload_too_large', 'invalid_request', 'not_found', 'conflict', 'invalid_state', 'source_hash_conflict', 'idempotency_key_reused', 'ontology_violation']) {
      expect(toolErrorText(err(code, { detail: 'the detail' }))).toBe(`${code}: the detail`);
    }
  });
  it('maps the transient codes to one retry sentence', () => {
    for (const code of ['namespace_busy', 'fenced', 'unavailable', 'idempotency_in_progress']) {
      expect(toolErrorText(err(code, { status: 503 }))).toMatch(/temporarily unavailable; retry/);
    }
  });
  it('appends the request id when present', () => {
    expect(toolErrorText(err('conflict', { detail: 'd', requestId: 'req-1' }))).toBe('conflict: d (request-id: req-1)');
  });
  it('falls back to code, detail, status and request id for unknown codes', () => {
    const text = toolErrorText(err('something_new', { status: 418, detail: 'teapot', requestId: 'r' }));
    expect(text).toContain('something_new');
    expect(text).toContain('teapot');
    expect(text).toContain('418');
    expect(text).toContain('(request-id: r)');
  });
  it('renders a UsageError message as-is', () => {
    expect(toolErrorText(new UsageError(NO_NAMESPACE_MESSAGE))).toBe(NO_NAMESPACE_MESSAGE);
  });
  it('renders zod issues one per line', () => {
    const result = z.object({ limit: z.number().max(100) }).safeParse({ limit: 101 });
    expect(result.success).toBe(false);
    if (result.success) return;
    const text = toolErrorText(result.error);
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain('limit');
  });
  it('never throws on arbitrary input', () => {
    expect(toolErrorText(undefined)).toBe('Unknown error');
    expect(toolErrorText('boom')).toBe('boom');
    expect(toolErrorText(new Error('plain'))).toBe('plain');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @equationalapplications/mcp-server test -- errors
```
Expected: FAIL — `Cannot find module '../src/errors'`.

- [ ] **Step 3: Write `packages/mcp-server/src/errors.ts`**

```ts
import { ZodError } from 'zod';

export interface SynapseTreeErrorInit {
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  retryAfterSeconds?: number;
}

/** A SynapseTree API error (problem+json, an OAuth error body, or a gateway rejection). */
export class SynapseTreeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;

  constructor(init: SynapseTreeErrorInit) {
    super(init.detail ? `${init.code}: ${init.detail}` : init.code);
    this.name = 'SynapseTreeError';
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** A local mistake: missing configuration or bad input. Never an HTTP failure. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const NO_NAMESPACE_MESSAGE =
  'No namespace configured. Run `synapsetree-mcp config set namespace repo:<name>`, or pass `namespace`.';

export const NO_KEY_MESSAGE =
  'No API key. Run `synapsetree-mcp auth --key stree_…` or `synapsetree-mcp auth --email you@example.com`.';

export const INGEST_PROVIDER_MESSAGE =
  'Requires the account owner to have registered an extraction provider in the dashboard (bring-your-own-key). ' +
  'Otherwise the server answers `inference_not_configured`; tell the user to register a provider at https://synapsetree.dev/dashboard.';

const DETAIL_CODES = new Set([
  'quota_exceeded',
  'payload_too_large',
  'invalid_request',
  'not_found',
  'conflict',
  'invalid_state',
  'source_hash_conflict',
  'idempotency_key_reused',
  'ontology_violation',
]);

const TRANSIENT_CODES = new Set(['namespace_busy', 'fenced', 'unavailable', 'idempotency_in_progress']);

function describe(err: SynapseTreeError): string {
  switch (err.code) {
    case 'unauthorized':
      return 'SynapseTree rejected the stored API key (revoked, unknown, or its database is not reachable). Ask the user to run `synapsetree-mcp auth`.';
    case 'insufficient_scope':
      return 'This key cannot do that. The account owner does it in the dashboard at https://synapsetree.dev/dashboard.';
    case 'subscription_inactive':
      return "The organization's SynapseTree plan is paused. Reads and export still work in the dashboard.";
    case 'inference_not_configured':
      return INGEST_PROVIDER_MESSAGE;
    case 'upstream_inference_unavailable':
      return "The account owner's inference provider is failing; searches fall back to keywords. Retry ingest later.";
    case 'rate_limited':
      return `Rate limited by SynapseTree; retry after ${err.retryAfterSeconds !== undefined ? `${err.retryAfterSeconds} seconds` : 'a few seconds'}.`;
    case 'not_implemented':
      return 'SynapseTree has not enabled this operation yet (501). Tell the user; nothing to fix locally.';
    default:
      if (DETAIL_CODES.has(err.code)) return `${err.code}: ${err.detail ?? ''}`.trimEnd();
      if (TRANSIENT_CODES.has(err.code)) return 'SynapseTree is temporarily unavailable; retry in a few seconds.';
      return `${err.code}${err.detail ? `: ${err.detail}` : ''} (HTTP ${err.status})`;
  }
}

/** One paragraph a model can act on. Never throws. */
export function toolErrorText(err: unknown): string {
  if (err instanceof SynapseTreeError) {
    const text = describe(err);
    return err.requestId ? `${text} (request-id: ${err.requestId})` : text;
  }
  if (err instanceof ZodError) {
    return err.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('\n');
  }
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @equationalapplications/mcp-server test -- errors
```
Expected: PASS (all `errors.test.ts` cases).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/errors.ts packages/mcp-server/__tests__/errors.test.ts
git commit -m "feat(mcp-server): error types and the tool-error text mapping"
```

---

### Task 4: The HTTP client

**Files:**
- Create: `packages/mcp-server/src/client.ts`
- Test: `packages/mcp-server/__tests__/client.test.ts`
- Implements: spec §5.2.

**Interfaces:**
- Consumes: `OPERATIONS`, `OperationId` (Task 2); `SynapseTreeError`, `UsageError`, `NO_KEY_MESSAGE` (Task 3).
- Produces:
  ```ts
  export const DEFAULT_BASE_URL = 'https://api.synapsetree.dev';
  export interface ClientOptions { apiKey?: string; baseUrl: string; userAgent: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; random?: () => number; }
  export interface CallInput { path?: Record<string, string>; query?: Record<string, string | number | boolean | undefined>; body?: Record<string, unknown>; form?: Record<string, string | undefined>; timeoutMs?: number; }
  export interface CallResult<T> { status: number; data: T; requestId?: string; rateLimit?: string; rateLimitPolicy?: string; idempotentReplayed: boolean; }
  export class SynapseTreeClient { constructor(opts: ClientOptions); readonly baseUrl: string; readonly hasKey: boolean; call<T = unknown>(op: OperationId, input?: CallInput): Promise<CallResult<T>>; }
  ```

- [ ] **Step 1: Write the failing tests**

`packages/mcp-server/__tests__/client.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { SynapseTreeClient } from '../src/client';
import { SynapseTreeError, UsageError } from '../src/errors';

interface Recorded { url: string; method: string; headers: Record<string, string>; body: string | null }

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
function problem(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, detail: `detail for ${code}`, requestId: 'req-42', ...extra }), {
    status,
    headers: { 'content-type': 'application/problem+json', 'request-id': 'req-42' },
  });
}

function makeClient(responses: Array<Response | Error>, opts: { apiKey?: string | null } = {}) {
  const calls: Recorded[] = [];
  const waits: number[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body: (init?.body as string | null) ?? null });
    const next = responses.shift();
    if (!next) throw new Error('no scripted response left');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  const client = new SynapseTreeClient({
    apiKey: opts.apiKey === null ? undefined : (opts.apiKey ?? 'stree_' + 'k'.repeat(43)),
    baseUrl: 'https://api.test.example/',
    userAgent: 'synapsetree-mcp/test',
    fetch: fetchImpl,
    sleep: async (ms) => { waits.push(ms); },
    random: () => 0,
  });
  return { client, calls, waits };
}

describe('SynapseTreeClient (spec §5.2)', () => {
  it('builds URLs with path and query parameters and strips the trailing slash', async () => {
    const { client, calls } = makeClient([json(200, { ok: true })]);
    await client.call('listNamespaces', { query: { prefix: 'repo:', limit: 100, after: undefined } });
    expect(calls[0].url).toBe('https://api.test.example/v1/namespaces?prefix=repo%3A&limit=100');
    expect(calls[0].method).toBe('GET');
  });

  it('substitutes and encodes path parameters', async () => {
    const { client, calls } = makeClient([json(200, {})]);
    await client.call('supersedeFact', { path: { factId: 'fact/1' }, body: { namespace: 'n', replacement: { kind: 'new' } } });
    expect(calls[0].url).toBe('https://api.test.example/v1/memory/facts/fact%2F1/supersede');
  });

  it('sends the bearer, accept, user-agent and JSON content-type headers', async () => {
    const { client, calls } = makeClient([json(201, {})]);
    await client.call('rememberFact', { body: { namespace: 'n', title: 't', body: 'b' } });
    const h = calls[0].headers;
    expect(h.authorization).toBe('Bearer stree_' + 'k'.repeat(43));
    expect(h.accept).toBe('application/json, application/problem+json');
    expect(h['user-agent']).toBe('synapsetree-mcp/test');
    expect(h['content-type']).toBe('application/json');
    expect(calls[0].body).toBe(JSON.stringify({ namespace: 'n', title: 't', body: 'b' }));
  });

  it('sends an Idempotency-Key only where the contract allows one, and reuses it across retries', async () => {
    const { client, calls } = makeClient([problem(503, 'unavailable'), json(201, {})]);
    await client.call('rememberFact', { body: { namespace: 'n', title: 't', body: 'b' } });
    expect(calls).toHaveLength(2);
    expect(calls[0].headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{1,255}$/);
    expect(calls[1].headers['idempotency-key']).toBe(calls[0].headers['idempotency-key']);

    const read = makeClient([json(200, {})]);
    await read.client.call('queryMemory', { body: { namespaces: ['n'], query: '' } });
    expect(read.calls[0].headers['idempotency-key']).toBeUndefined();
  });

  it('form-encodes the OAuth operations and sends no bearer on the unauthenticated ones', async () => {
    const { client, calls } = makeClient([json(200, { claim_token: 'x' }), json(400, { error: 'authorization_pending', interval: 5 }), json(200, undefined)], { apiKey: null });
    await client.call('registerAgentIdentity', { body: { email: 'a@b.c' } });
    expect(calls[0].headers.authorization).toBeUndefined();
    await client.call('oauthToken', { form: { grant_type: 'urn:synapsetree:claim', assertion: 'stclaim_abc' } });
    expect(calls[1].headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[1].body).toBe('grant_type=urn%3Asynapsetree%3Aclaim&assertion=stclaim_abc');
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  it('returns oauthToken 400 bodies as values instead of throwing', async () => {
    const { client } = makeClient([json(400, { error: 'authorization_pending', error_description: 'wait', interval: 7 })], { apiKey: null });
    const res = await client.call<{ error: string; interval: number }>('oauthToken', { form: { grant_type: 'g', assertion: 'a' } });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe('authorization_pending');
    expect(res.data.interval).toBe(7);
  });

  it('sends the key as bearer and as the token field on revoke', async () => {
    const { client, calls } = makeClient([new Response(null, { status: 200 })]);
    const key = 'stree_' + 'k'.repeat(43);
    const res = await client.call('oauthRevoke', { form: { token: key, token_type_hint: 'access_token' } });
    expect(calls[0].headers.authorization).toBe(`Bearer ${key}`);
    expect(calls[0].body).toContain(`token=${key}`);
    expect(res.data).toBeUndefined();
  });

  it('throws a UsageError (no HTTP call) when an authenticated operation has no key', async () => {
    const { client, calls } = makeClient([], { apiKey: null });
    await expect(client.call('whoami')).rejects.toBeInstanceOf(UsageError);
    expect(calls).toHaveLength(0);
  });

  it('retries 408/429/502/503/504 and network errors at most twice, honoring Retry-After', async () => {
    const { client, calls, waits } = makeClient([
      problem(429, 'rate_limited', { retryAfterSeconds: 2 }),
      new TypeError('fetch failed'),
      json(200, { ok: true }),
    ]);
    // the 429 above carries no Retry-After header; add one on a second scenario below
    await client.call('whoami');
    expect(calls).toHaveLength(3);
    expect(waits[0]).toBe(2000); // from the problem body's retryAfterSeconds
    expect(waits[1]).toBe(4000); // 1000 * 2^2, random() = 0

    const withHeader = makeClient([new Response('', { status: 503, headers: { 'retry-after': '3' } }), json(200, {})]);
    await withHeader.client.call('whoami');
    expect(withHeader.waits).toEqual([3000]);
  });

  it('gives up after three attempts with the last error', async () => {
    const { client, calls } = makeClient([problem(503, 'unavailable'), problem(503, 'unavailable'), problem(503, 'unavailable')]);
    await expect(client.call('whoami')).rejects.toMatchObject({ code: 'unavailable', status: 503 });
    expect(calls).toHaveLength(3);
  });

  it('never retries other 4xx or a 500', async () => {
    for (const status of [400, 401, 403, 404, 409, 413, 422, 500]) {
      const { client, calls } = makeClient([problem(status, 'whatever')]);
      await expect(client.call('whoami')).rejects.toBeInstanceOf(SynapseTreeError);
      expect(calls).toHaveLength(1);
    }
  });

  it('maps problem+json to a typed error with request id and retryAfterSeconds', async () => {
    const { client } = makeClient([problem(409, 'inference_not_configured', { retryAfterSeconds: 9 })]);
    const err = await client.call('whoami').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SynapseTreeError);
    expect(err).toMatchObject({ status: 409, code: 'inference_not_configured', detail: 'detail for inference_not_configured', requestId: 'req-42', retryAfterSeconds: 9 });
  });

  it('maps the gateway 401 and a non-problem 403 to unauthorized', async () => {
    const a = makeClient([new Response('{"message":"Unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } })]);
    await expect(a.client.call('whoami')).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    const b = makeClient([new Response('{"message":"Forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } })]);
    await expect(b.client.call('whoami')).rejects.toMatchObject({ code: 'unauthorized', status: 403 });
  });

  it('maps an unparseable error to http_<status> with the body as detail', async () => {
    const { client } = makeClient([new Response('<html>bad gateway</html>', { status: 500, headers: { 'content-type': 'text/html' } })]);
    await expect(client.call('whoami')).rejects.toMatchObject({ code: 'http_500', detail: '<html>bad gateway</html>' });
  });

  it('captures Request-Id, RateLimit, RateLimit-Policy and Idempotent-Replayed', async () => {
    const { client } = makeClient([json(201, { id: 'fact_1' }, { 'request-id': 'r-1', ratelimit: '"default";r=58', 'ratelimit-policy': '"default";q=60;w=60', 'idempotent-replayed': 'true' })]);
    const res = await client.call('rememberFact', { body: { namespace: 'n', title: 't', body: 'b' } });
    expect(res).toMatchObject({ status: 201, data: { id: 'fact_1' }, requestId: 'r-1', rateLimit: '"default";r=58', rateLimitPolicy: '"default";q=60;w=60', idempotentReplayed: true });
  });

  it('aborts a request that exceeds the timeout and counts it as a network error', async () => {
    let aborted = false;
    const hanging = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal?.reason ?? new Error('aborted')); });
      })) as typeof fetch;
    const client = new SynapseTreeClient({ apiKey: 'stree_' + 'k'.repeat(43), baseUrl: 'https://x', userAgent: 'ua', fetch: hanging, sleep: async () => {}, random: () => 0 });
    await expect(client.call('whoami', { timeoutMs: 5 })).rejects.toMatchObject({ code: 'network_error' });
    expect(aborted).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @equationalapplications/mcp-server test -- client
```
Expected: FAIL — `Cannot find module '../src/client'`.

- [ ] **Step 3: Write `packages/mcp-server/src/client.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { OPERATIONS, type Operation, type OperationId } from './contract';
import { NO_KEY_MESSAGE, SynapseTreeError, UsageError } from './errors';

export const DEFAULT_BASE_URL = 'https://api.synapsetree.dev';

export interface ClientOptions {
  /** Optional only so `auth --email` can register and poll; every other operation needs it. */
  apiKey?: string;
  baseUrl: string;
  userAgent: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface CallInput {
  path?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  form?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface CallResult<T> {
  status: number;
  data: T;
  requestId?: string;
  rateLimit?: string;
  rateLimitPolicy?: string;
  idempotentReplayed: boolean;
}

const RETRY_STATUSES = new Set([408, 429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const TIMEOUTS: Partial<Record<OperationId, number>> = { ingestDocument: 120_000 };
const UNAUTHENTICATED: ReadonlySet<OperationId> = new Set(['registerAgentIdentity', 'oauthToken']);

function buildUrl(baseUrl: string, op: Operation, input: CallInput): string {
  let path = op.path;
  for (const name of op.pathParameters) {
    const value = input.path?.[name];
    if (value === undefined) throw new UsageError(`missing path parameter ${name} for ${op.operationId}`);
    path = path.replace(`{${name}}`, encodeURIComponent(value));
  }
  const url = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(input.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function retryAfterMs(res: Response, body: unknown): number | undefined {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const fromBody = (body as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
  return typeof fromBody === 'number' ? fromBody * 1000 : undefined;
}

async function readBody(res: Response): Promise<{ text: string; json: unknown; isProblem: boolean; isJson: boolean }> {
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  const isProblem = type.startsWith('application/problem+json');
  const isJson = isProblem || type.startsWith('application/json');
  let json: unknown;
  if (isJson && text.length > 0) {
    try { json = JSON.parse(text); } catch { json = undefined; }
  }
  return { text, json, isProblem, isJson: json !== undefined };
}

function toError(res: Response, parsed: { text: string; json: unknown; isProblem: boolean; isJson: boolean }): SynapseTreeError {
  const requestId = res.headers.get('request-id') ?? undefined;
  const body = (parsed.json ?? {}) as Record<string, unknown>;
  if (parsed.isProblem && typeof body.code === 'string') {
    return new SynapseTreeError({
      status: res.status,
      code: body.code,
      detail: typeof body.detail === 'string' ? body.detail : undefined,
      requestId: typeof body.requestId === 'string' ? body.requestId : requestId,
      retryAfterSeconds: typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : undefined,
    });
  }
  if (parsed.isJson && typeof body.error === 'string') {
    // RFC 6749 §5.2 body from the OAuth endpoints
    return new SynapseTreeError({ status: res.status, code: body.error, detail: typeof body.error_description === 'string' ? body.error_description : undefined, requestId });
  }
  if (res.status === 401 || res.status === 403) {
    return new SynapseTreeError({ status: res.status, code: 'unauthorized', detail: parsed.text.slice(0, 500) || undefined, requestId });
  }
  return new SynapseTreeError({ status: res.status, code: `http_${res.status}`, detail: parsed.text.slice(0, 500) || undefined, requestId });
}

export class SynapseTreeClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(opts: ClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.userAgent = opts.userAgent;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = opts.random ?? Math.random;
  }

  get hasKey(): boolean {
    return this.apiKey !== undefined;
  }

  async call<T = unknown>(opId: OperationId, input: CallInput = {}): Promise<CallResult<T>> {
    const op = OPERATIONS[opId];
    const authenticated = !UNAUTHENTICATED.has(opId);
    if (authenticated && !this.apiKey) throw new UsageError(NO_KEY_MESSAGE);

    const url = buildUrl(this.baseUrl, op, input);
    const headers: Record<string, string> = {
      Accept: 'application/json, application/problem+json',
      'User-Agent': this.userAgent,
    };
    if (authenticated && this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let body: string | undefined;
    if (input.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(input.form)) if (v !== undefined) params.set(k, v);
      body = params.toString();
    } else if (input.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(input.body);
    }
    if (op.acceptsIdempotencyKey) headers['Idempotency-Key'] = randomUUID();
    const timeoutMs = input.timeoutMs ?? TIMEOUTS[opId] ?? DEFAULT_TIMEOUT_MS;

    let lastError: SynapseTreeError | undefined;
    let waitMs: number | undefined;
    // registerAgentIdentity is single-attempt: the POST creates a claim (and
    // triggers an email) as a side effect, and the contract gives it no
    // Idempotency-Key, so a blind retry on a 503 would consume the
    // five-claims-per-email cap with a claim nobody polls.
    const canRetry = opId !== 'registerAgentIdentity';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        if (!canRetry) break;
        await this.sleep(waitMs ?? Math.min(1000 * 2 ** attempt, 8000) + Math.floor(this.random() * 250));
      }
      let res: Response;
      try {
        res = await this.send(url, { method: op.method, headers, body }, timeoutMs);
      } catch (err) {
        lastError = new SynapseTreeError({ status: 0, code: 'network_error', detail: err instanceof Error ? err.message : String(err) });
        waitMs = undefined;
        continue;
      }
      const parsed = await readBody(res);
      if (RETRY_STATUSES.has(res.status)) {
        lastError = toError(res, parsed);
        waitMs = retryAfterMs(res, parsed.json);
        continue;
      }
      if (res.ok || (opId === 'oauthToken' && res.status === 400)) {
        return {
          status: res.status,
          data: parsed.json as T,
          requestId: res.headers.get('request-id') ?? undefined,
          rateLimit: res.headers.get('ratelimit') ?? undefined,
          rateLimitPolicy: res.headers.get('ratelimit-policy') ?? undefined,
          idempotentReplayed: res.headers.get('idempotent-replayed') === 'true',
        };
      }
      throw toError(res, parsed);
    }
    throw lastError ?? new SynapseTreeError({ status: 0, code: 'network_error' });
  }

  private async send(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @equationalapplications/mcp-server test -- client
pnpm --filter @equationalapplications/mcp-server typecheck
```
Expected: PASS. If the retry test's second wait is not 4000, check that `waitMs` is reset to `undefined` after a network error (the scripted 429 has no header, so the first wait comes from `retryAfterSeconds` in the body).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/client.ts packages/mcp-server/__tests__/client.test.ts
git commit -m "feat(mcp-server): contract-driven HTTP client with retries, idempotency keys and typed errors"
```

---

### Task 5: Credentials and configuration files

**Files:**
- Create: `packages/mcp-server/src/credentials.ts`
- Test: `packages/mcp-server/__tests__/credentials.test.ts`
- Implements: spec §5.4.

**Interfaces:**
- Consumes: `UsageError`, `NO_KEY_MESSAGE` (Task 3); `DEFAULT_BASE_URL` (Task 4).
- Produces:
  ```ts
  export interface Credentials { apiKey: string; accountId: string | null; source: 'dashboard' | 'authmd'; obtainedAt: string }
  export interface Config { namespace?: string; baseUrl?: string }
  export interface DirEnv { SYNAPSETREE_CONFIG_DIR?: string; XDG_CONFIG_HOME?: string; APPDATA?: string }
  export function configDir(env?: DirEnv, platform?: NodeJS.Platform, home?: string): string;
  export function readCredentials(dir: string): Promise<Credentials | null>;
  export function writeCredentials(dir: string, creds: Credentials): Promise<void>;
  export function deleteCredentials(dir: string): Promise<boolean>;
  export function readConfig(dir: string): Promise<Config>;
  export function writeConfig(dir: string, config: Config): Promise<void>;
  export interface Settings { apiKey?: string; keySource: 'env' | 'file' | null; accountId: string | null; baseUrl: string; namespace?: string; dir: string }
  export function resolveSettings(env?: NodeJS.ProcessEnv, dir?: string): Promise<Settings>;
  export function maskKey(key: string): string;
  export const KEY_PATTERN: RegExp;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/mcp-server/__tests__/credentials.test.ts`:
```ts
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KEY_PATTERN, configDir, deleteCredentials, maskKey, readConfig, readCredentials, resolveSettings, writeConfig, writeCredentials,
} from '../src/credentials';
import { UsageError } from '../src/errors';

const KEY = 'stree_' + 'a'.repeat(39) + 'wxyz';
let dir: string;
beforeEach(async () => { dir = join(await mkdtemp(join(tmpdir(), 'stmcp-')), 'synapsetree'); });
afterEach(() => { /* temp dirs are left to the OS */ });

describe('configDir (spec §5.4)', () => {
  it('prefers SYNAPSETREE_CONFIG_DIR, then XDG_CONFIG_HOME, then the platform default', () => {
    expect(configDir({ SYNAPSETREE_CONFIG_DIR: '/x' }, 'darwin', '/home/u')).toBe('/x');
    expect(configDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/u')).toBe(join('/xdg', 'synapsetree'));
    expect(configDir({}, 'darwin', '/Users/u')).toBe(join('/Users/u', 'Library', 'Application Support', 'synapsetree'));
    expect(configDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u')).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'synapsetree'));
    expect(configDir({}, 'linux', '/home/u')).toBe(join('/home/u', '.config', 'synapsetree'));
  });
});

describe('credentials file', () => {
  it('round-trips and leaves no temp file behind', async () => {
    const creds = { apiKey: KEY, accountId: 'acc_1', source: 'dashboard' as const, obtainedAt: '2026-11-01T00:00:00Z' };
    await writeCredentials(dir, creds);
    expect(await readCredentials(dir)).toEqual(creds);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('writes the file 0600 and the directory 0700 on POSIX', async () => {
    if (process.platform === 'win32') return;
    await writeCredentials(dir, { apiKey: KEY, accountId: null, source: 'authmd', obtainedAt: 'now' });
    expect((await stat(join(dir, 'credentials.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('returns null when missing and deletes idempotently', async () => {
    expect(await readCredentials(dir)).toBeNull();
    expect(await deleteCredentials(dir)).toBe(false);
    await writeCredentials(dir, { apiKey: KEY, accountId: null, source: 'authmd', obtainedAt: 'now' });
    expect(await deleteCredentials(dir)).toBe(true);
    expect(await readCredentials(dir)).toBeNull();
  });

  it('refuses a malformed file with an error naming the path', async () => {
    await writeConfig(dir, {}); // creates the dir
    await writeFile(join(dir, 'credentials.json'), '{not json');
    await expect(readCredentials(dir)).rejects.toThrow(join(dir, 'credentials.json'));
    await expect(readCredentials(dir)).rejects.toBeInstanceOf(UsageError);
  });
});

describe('config file', () => {
  it('round-trips and defaults to an empty object', async () => {
    expect(await readConfig(dir)).toEqual({});
    await writeConfig(dir, { namespace: 'repo:x' });
    await writeConfig(dir, { ...(await readConfig(dir)), baseUrl: 'https://t' });
    expect(await readConfig(dir)).toEqual({ namespace: 'repo:x', baseUrl: 'https://t' });
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toEqual({ namespace: 'repo:x', baseUrl: 'https://t' });
  });
});

describe('resolveSettings precedence', () => {
  it('env beats file beats default', async () => {
    await writeCredentials(dir, { apiKey: KEY, accountId: 'acc', source: 'dashboard', obtainedAt: 'now' });
    await writeConfig(dir, { namespace: 'repo:file', baseUrl: 'https://file' });
    const fromFile = await resolveSettings({}, dir);
    expect(fromFile).toMatchObject({ apiKey: KEY, keySource: 'file', accountId: 'acc', baseUrl: 'https://file', namespace: 'repo:file' });
    const envKey = 'stree_' + 'b'.repeat(43);
    const fromEnv = await resolveSettings({ SYNAPSETREE_API_KEY: envKey, SYNAPSETREE_BASE_URL: 'https://env/', SYNAPSETREE_NAMESPACE: 'repo:env' }, dir);
    expect(fromEnv).toMatchObject({ apiKey: envKey, keySource: 'env', accountId: null, baseUrl: 'https://env', namespace: 'repo:env' });
  });

  it('falls back to the production base URL and no key', async () => {
    const s = await resolveSettings({}, dir);
    expect(s).toMatchObject({ apiKey: undefined, keySource: null, baseUrl: 'https://api.synapsetree.dev', namespace: undefined });
  });
});

describe('maskKey and KEY_PATTERN', () => {
  it('shows only the prefix and the last four characters', () => {
    expect(maskKey(KEY)).toBe('stree_…wxyz');
    expect(maskKey(KEY)).not.toContain('aaaa');
  });
  it('matches the documented key shape', () => {
    expect(KEY_PATTERN.test(KEY)).toBe(true);
    expect(KEY_PATTERN.test('stree_short')).toBe(false);
    expect(KEY_PATTERN.test('sk_' + 'a'.repeat(43))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @equationalapplications/mcp-server test -- credentials
```
Expected: FAIL — `Cannot find module '../src/credentials'`.

- [ ] **Step 3: Write `packages/mcp-server/src/credentials.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BASE_URL } from './client';
import { UsageError } from './errors';

export interface Credentials {
  apiKey: string;
  accountId: string | null;
  source: 'dashboard' | 'authmd';
  obtainedAt: string;
}

export interface Config {
  namespace?: string;
  baseUrl?: string;
}

export interface DirEnv {
  SYNAPSETREE_CONFIG_DIR?: string;
  XDG_CONFIG_HOME?: string;
  APPDATA?: string;
}

export const KEY_PATTERN = /^stree_[A-Za-z0-9_-]{43}$/;
const CREDENTIALS_FILE = 'credentials.json';
const CONFIG_FILE = 'config.json';

export function configDir(env: DirEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (env.SYNAPSETREE_CONFIG_DIR) return env.SYNAPSETREE_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'synapsetree');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'synapsetree');
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'synapsetree');
  return join(home, '.config', 'synapsetree');
}

async function readJson<T>(path: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UsageError(`${path} is not valid JSON. Fix it or delete it.`);
  }
}

/** Atomic: temp file in the same directory, mode 0600, then rename over the target. Modes are best-effort on Windows. */
async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const target = join(dir, name);
  const tmp = join(dir, `${name}.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function readCredentials(dir: string): Promise<Credentials | null> {
  const value = await readJson<Credentials>(join(dir, CREDENTIALS_FILE));
  if (value && typeof value.apiKey !== 'string') throw new UsageError(`${join(dir, CREDENTIALS_FILE)} has no apiKey. Fix it or delete it.`);
  return value;
}

export function writeCredentials(dir: string, creds: Credentials): Promise<void> {
  return writeJson(dir, CREDENTIALS_FILE, creds);
}

export async function deleteCredentials(dir: string): Promise<boolean> {
  try {
    await unlink(join(dir, CREDENTIALS_FILE));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function readConfig(dir: string): Promise<Config> {
  return (await readJson<Config>(join(dir, CONFIG_FILE))) ?? {};
}

export function writeConfig(dir: string, config: Config): Promise<void> {
  return writeJson(dir, CONFIG_FILE, config);
}

export interface Settings {
  apiKey?: string;
  keySource: 'env' | 'file' | null;
  accountId: string | null;
  baseUrl: string;
  namespace?: string;
  dir: string;
}

export async function resolveSettings(env: NodeJS.ProcessEnv = process.env, dir: string = configDir(env)): Promise<Settings> {
  const creds = await readCredentials(dir);
  const config = await readConfig(dir);
  const envKey = env.SYNAPSETREE_API_KEY;
  const apiKey = envKey || creds?.apiKey;
  return {
    apiKey,
    keySource: envKey ? 'env' : creds ? 'file' : null,
    accountId: envKey ? null : (creds?.accountId ?? null),
    baseUrl: (env.SYNAPSETREE_BASE_URL || config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    namespace: env.SYNAPSETREE_NAMESPACE || config.namespace,
    dir,
  };
}

export function maskKey(key: string): string {
  return `stree_…${key.slice(-4)}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @equationalapplications/mcp-server test -- credentials
pnpm --filter @equationalapplications/mcp-server typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/credentials.ts packages/mcp-server/__tests__/credentials.test.ts
git commit -m "feat(mcp-server): credentials and config files with atomic 0600 writes and env precedence"
```

---

### Task 6: The eight tools and the request-fidelity guard

**Files:**
- Create: `packages/mcp-server/src/tools/shared.ts`
- Create: `packages/mcp-server/src/tools/memory-search.ts`, `memory-remember.ts`, `memory-supersede.ts`, `memory-ingest.ts`, `memory-log-event.ts`, `graph-traverse.ts`, `namespaces-list.ts`, `whoami.ts`, `index.ts`
- Test: `packages/mcp-server/__tests__/tools.test.ts`
- Test: `packages/mcp-server/__tests__/contract-guard.test.ts`
- Implements: spec §8, §10.2 guards 1 and 2 (first half).

**Interfaces:**
- Consumes: `SynapseTreeClient`, `CallResult` (Task 4); `OPERATIONS`, `OperationId` (Task 2); `UsageError`, `NO_NAMESPACE_MESSAGE`, `INGEST_PROVIDER_MESSAGE` (Task 3).
- Produces:
  ```ts
  // tools/shared.ts
  export interface ToolContext { client: SynapseTreeClient; defaultNamespace?: string }
  export interface ToolDefinition<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> { name: string; description: string; operation: OperationId; inputSchema: S; handler: (input: z.output<S>, ctx: ToolContext) => Promise<unknown> }
  export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(def: ToolDefinition<S>): ToolDefinition<S>;
  export const NAMESPACE_PATTERN: RegExp; export const namespaceField: z.ZodOptional<z.ZodString>;
  export function resolveNamespace(given: string | undefined, ctx: ToolContext): string;
  export function compact<T extends Record<string, unknown>>(obj: T): Partial<T>;
  // tools/index.ts
  export const TOOLS: readonly ToolDefinition[]; export const TOOL_NAMES: readonly string[];
  ```

- [ ] **Step 1: Write the failing tests**

`packages/mcp-server/__tests__/tools.test.ts`:
```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SynapseTreeClient } from '../src/client';
import { NO_NAMESPACE_MESSAGE, SynapseTreeError, UsageError } from '../src/errors';
import { TOOLS, TOOL_NAMES } from '../src/tools';
import type { ToolContext, ToolDefinition } from '../src/tools/shared';

interface Recorded { url: string; method: string; headers: Record<string, string>; body: unknown }

function harness(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>, defaultNamespace?: string) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': next.status >= 400 ? 'application/problem+json' : 'application/json', ...(next.headers ?? {}) },
    });
  }) as typeof fetch;
  const ctx: ToolContext = {
    client: new SynapseTreeClient({ apiKey: 'stree_' + 'k'.repeat(43), baseUrl: 'https://api.test', userAgent: 'ua', fetch: fetchImpl, sleep: async () => {}, random: () => 0 }),
    defaultNamespace,
  };
  return { ctx, calls };
}

const byName = (name: string): ToolDefinition => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};
const run = (name: string, input: Record<string, unknown>, ctx: ToolContext) => {
  const tool = byName(name);
  return tool.handler(tool.inputSchema.parse(input), ctx);
};

describe('tool list (spec §8, §10.2 guard 2)', () => {
  it('is exactly the eight names in order', () => {
    expect(TOOL_NAMES).toEqual(['memory_search', 'memory_remember', 'memory_supersede', 'memory_ingest', 'memory_log_event', 'graph_traverse', 'namespaces_list', 'whoami']);
    expect(TOOLS).toHaveLength(8);
  });
  it('every tool but whoami accepts an optional namespace', () => {
    for (const tool of TOOLS) {
      const hasNamespace = 'namespace' in tool.inputSchema.shape;
      expect(hasNamespace).toBe(tool.name !== 'whoami');
    }
  });
});

describe('namespace rule', () => {
  it('uses the default namespace when none is given', async () => {
    const { ctx, calls } = harness([{ status: 200, body: { facts: [] } }], 'repo:dflt');
    await run('memory_search', { query: 'x' }, ctx);
    expect(calls[0].body).toMatchObject({ namespaces: ['repo:dflt'] });
  });
  it('errors with the documented message when no namespace is configured', async () => {
    const { ctx, calls } = harness([]);
    await expect(run('memory_search', { query: 'x' }, ctx)).rejects.toThrow(NO_NAMESPACE_MESSAGE);
    expect(calls).toHaveLength(0);
  });
  it('rejects a malformed namespace at the schema', () => {
    expect(() => byName('memory_search').inputSchema.parse({ query: 'x', namespace: 'Bad Namespace' })).toThrow();
  });
});

describe('memory_search', () => {
  it('sends only the allowed body fields and returns the response verbatim', async () => {
    const payload = { facts: [{ id: 'fact_1' }], scores: { fact_1: 0.9 }, tasks: [], events: [], diagnostics: { keyword_only: true } };
    const { ctx, calls } = harness([{ status: 200, body: payload }]);
    const result = await run('memory_search', { namespace: 'repo:x', query: 'hello', limit: 5, excludeDrafts: true, asOf: '2026-01-01T00:00:00Z' }, ctx);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/v1/memory/query' });
    expect(calls[0].body).toEqual({ namespaces: ['repo:x'], query: 'hello', limit: 5, excludeDrafts: true, asOf: '2026-01-01T00:00:00Z' });
    expect(result).toEqual(payload);
  });
  it('defaults limit to 10 and rejects 101', () => {
    const schema = byName('memory_search').inputSchema;
    expect(schema.parse({ query: 'q' })).toMatchObject({ limit: 10 });
    expect(() => schema.parse({ query: 'q', limit: 101 })).toThrow();
  });
});

describe('memory_remember', () => {
  it('always sends sourceType user_stated and never an embedding', async () => {
    const { ctx, calls } = harness([{ status: 201, body: { id: 'fact_9' } }]);
    const result = await run('memory_remember', { namespace: 'repo:x', title: 'T', body: 'B', tags: ['a'], confidence: 'certain' }, ctx);
    expect(calls[0].body).toEqual({ namespace: 'repo:x', title: 'T', body: 'B', tags: ['a'], confidence: 'certain', sourceType: 'user_stated' });
    expect(calls[0].headers['idempotency-key']).toBeDefined();
    expect(result).toEqual({ id: 'fact_9' });
  });
  it('maps a 402 subscription_inactive to the typed error', async () => {
    const { ctx } = harness([{ status: 402, body: { code: 'subscription_inactive', detail: 'paused' } }]);
    await expect(run('memory_remember', { namespace: 'repo:x', title: 'T', body: 'B' }, ctx)).rejects.toMatchObject({ code: 'subscription_inactive' });
  });
});

describe('memory_supersede', () => {
  it('sends the factId in the path and a kind:new replacement', async () => {
    const { ctx, calls } = harness([{ status: 200, body: { superseded: {}, replacement: {} } }]);
    await run('memory_supersede', { namespace: 'repo:x', factId: 'fact_1', title: 'T2', body: 'B2', confidence: 'inferred', validFrom: '2026-02-01T00:00:00Z' }, ctx);
    expect(calls[0].url).toBe('https://api.test/v1/memory/facts/fact_1/supersede');
    expect(calls[0].body).toEqual({ namespace: 'repo:x', validFrom: '2026-02-01T00:00:00Z', replacement: { kind: 'new', title: 'T2', body: 'B2', confidence: 'inferred', sourceType: 'user_stated' } });
  });
});

describe('memory_ingest', () => {
  it('computes sourceHash, encodes sourceRef, and sends server_extraction', async () => {
    const { ctx, calls } = harness([{ status: 200, body: { chunks: 1, ingestedChunks: 1, failedChunks: 0, truncated: false, duplicateOf: null, parseFailures: [] } }]);
    const content = 'hello world';
    await run('memory_ingest', { namespace: 'repo:x', sourceRef: 'docs/guide.md', content }, ctx);
    expect(calls[0].body).toEqual({
      mode: 'server_extraction', namespace: 'repo:x', sourceRef: 'docs__guide.md',
      sourceHash: createHash('sha256').update(content, 'utf8').digest('hex'), content, onDuplicateHash: 'skip',
    });
  });
  it('rejects a sourceRef that still has illegal characters after encoding', async () => {
    const { ctx, calls } = harness([]);
    await expect(run('memory_ingest', { namespace: 'repo:x', sourceRef: 'bad:ref?', content: 'x' }, ctx)).rejects.toBeInstanceOf(UsageError);
    expect(calls).toHaveLength(0);
  });
  it('surfaces inference_not_configured', async () => {
    const { ctx } = harness([{ status: 409, body: { code: 'inference_not_configured', detail: 'no provider' } }]);
    await expect(run('memory_ingest', { namespace: 'repo:x', sourceRef: 'a', content: 'x' }, ctx)).rejects.toMatchObject({ code: 'inference_not_configured' });
  });
});

describe('memory_log_event', () => {
  it('sends the event body', async () => {
    const { ctx, calls } = harness([{ status: 201, body: { id: 'evt_1' } }]);
    await run('memory_log_event', { namespace: 'repo:x', eventType: 'decision', summary: 'chose zod', relatedFactId: 'fact_1' }, ctx);
    expect(calls[0].body).toEqual({ namespace: 'repo:x', eventType: 'decision', summary: 'chose zod', relatedFactId: 'fact_1' });
  });
  it('rejects an unknown eventType', () => {
    expect(() => byName('memory_log_event').inputSchema.parse({ eventType: 'guess', summary: 's' })).toThrow();
  });
});

describe('graph_traverse', () => {
  it('sends the traversal body with defaults', async () => {
    const { ctx, calls } = harness([{ status: 200, body: { nodes: [], edges: [] } }]);
    await run('graph_traverse', { namespace: 'repo:x', sourceId: 'fact_1', edgeTypes: ['dependsOn'] }, ctx);
    expect(calls[0].body).toEqual({ namespace: 'repo:x', sourceId: 'fact_1', maxDepth: 1, maxNodes: 20, edgeTypes: ['dependsOn'] });
  });
  it('rejects maxDepth 4', () => {
    expect(() => byName('graph_traverse').inputSchema.parse({ sourceId: 'a', maxDepth: 4 })).toThrow();
  });
});

describe('namespaces_list', () => {
  it('follows nextCursor and stops at 500 with truncated', async () => {
    const page = (start: number, hasMore: boolean) => ({
      status: 200,
      body: { data: Array.from({ length: 100 }, (_, i) => ({ namespace: `ns${start + i}` })), hasMore, nextCursor: hasMore ? `c${start + 100}` : null },
    });
    const { ctx, calls } = harness([page(0, true), page(100, true), page(200, true), page(300, true), page(400, true), page(500, true)]);
    const result = (await run('namespaces_list', { prefix: 'ns' }, ctx)) as { namespaces: string[]; truncated: boolean };
    expect(result.namespaces).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(calls).toHaveLength(5);
    expect(calls[0].url).toBe('https://api.test/v1/namespaces?prefix=ns&limit=100');
    expect(calls[1].url).toContain('after=c100');
  });
  it('returns a short list untruncated', async () => {
    const { ctx } = harness([{ status: 200, body: { data: [{ namespace: 'a' }], hasMore: false, nextCursor: null } }]);
    expect(await run('namespaces_list', {}, ctx)).toEqual({ namespaces: ['a'], truncated: false });
  });
});

describe('whoami', () => {
  it('returns the account summary', async () => {
    const body = { apiKeyId: 'k', organizationId: 'o', tenantDatabaseId: 'd', scope: 'read_write', planCode: 'pro', subscriptionStatus: 'active' };
    const { ctx, calls } = harness([{ status: 200, body }]);
    expect(await run('whoami', {}, ctx)).toEqual(body);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.test/v1/whoami' });
  });
  it('surfaces a revoked key as unauthorized', async () => {
    const { ctx } = harness([{ status: 401, body: { message: 'Unauthorized' }, headers: { 'content-type': 'application/json' } }]);
    await expect(run('whoami', {}, ctx)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(new SynapseTreeError({ status: 401, code: 'unauthorized' }).code).toBe('unauthorized');
  });
});
```

`packages/mcp-server/__tests__/contract-guard.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { SynapseTreeClient } from '../src/client';
import { OPERATIONS } from '../src/contract';
import { TOOLS } from '../src/tools';
import type { ToolContext } from '../src/tools/shared';

/** A full input for every tool: every optional field present, so every property the tool can send is exercised. */
const FULL_INPUTS: Record<string, Record<string, unknown>> = {
  memory_search: { namespace: 'repo:x', query: 'q', limit: 5, excludeDrafts: true, asOf: '2026-01-01T00:00:00Z' },
  memory_remember: { namespace: 'repo:x', title: 't', body: 'b', tags: ['a'], confidence: 'certain', okfType: 'project', validFrom: '2026-01-01T00:00:00Z' },
  memory_supersede: { namespace: 'repo:x', factId: 'fact_1', title: 't', body: 'b', tags: ['a'], confidence: 'inferred', validFrom: '2026-01-01T00:00:00Z' },
  memory_ingest: { namespace: 'repo:x', sourceRef: 'docs/a.md', content: 'hello', onDuplicateHash: 'ingest' },
  memory_log_event: { namespace: 'repo:x', eventType: 'decision', summary: 's', relatedFactId: 'fact_1', occurredAt: '2026-01-01T00:00:00Z' },
  graph_traverse: { namespace: 'repo:x', sourceId: 'fact_1', maxDepth: 2, direction: 'both', edgeTypes: ['dependsOn'], maxNodes: 50, excludeDrafts: false },
  namespaces_list: { prefix: 'repo:' },
  whoami: {},
};

const CANNED: Record<string, unknown> = {
  listNamespaces: { data: [{ namespace: 'repo:x' }], hasMore: false, nextCursor: null },
};

describe('request fidelity against the vendored contract (spec §10.2 guard 1)', () => {
  for (const tool of TOOLS) {
    it(`${tool.name} sends only what ${tool.operation} declares`, async () => {
      const op = OPERATIONS[tool.operation];
      const recorded: { url: URL; method: string; headers: Headers; body: Record<string, unknown> | undefined }[] = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        recorded.push({ url: new URL(String(input)), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify(CANNED[tool.operation] ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
      const ctx: ToolContext = { client: new SynapseTreeClient({ apiKey: 'stree_' + 'k'.repeat(43), baseUrl: 'https://api.test', userAgent: 'ua', fetch: fetchImpl }) };
      await tool.handler(tool.inputSchema.parse(FULL_INPUTS[tool.name]), ctx);

      expect(recorded.length).toBeGreaterThan(0);
      const first = recorded[0];
      expect(first.method).toBe(op.method);
      const pathPattern = new RegExp('^' + op.path.replace(/\{[^}]+\}/g, '[^/]+') + '$');
      expect(first.url.pathname).toMatch(pathPattern);
      for (const key of first.url.searchParams.keys()) expect(op.queryParameters).toContain(key);
      if (first.body) {
        for (const key of Object.keys(first.body)) expect(op.requestProperties).toContain(key);
        for (const required of op.requiredProperties) expect(first.body).toHaveProperty(required);
      } else {
        expect(op.requiredProperties).toEqual([]);
      }
      expect(first.headers.has('idempotency-key')).toBe(op.acceptsIdempotencyKey);
    });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @equationalapplications/mcp-server test -- tools
```
Expected: FAIL — `Cannot find module '../src/tools'`.

- [ ] **Step 3: Write `packages/mcp-server/src/tools/shared.ts`**

```ts
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
```

- [ ] **Step 4: Write the eight tool modules**

`packages/mcp-server/src/tools/memory-search.ts`:
```ts
import { z } from 'zod';
import { compact, dateTimeField, defineTool, namespaceField, resolveNamespace } from './shared';

export const memorySearch = defineTool({
  name: 'memory_search',
  description:
    "Search the user's SynapseTree memory. Semantic search needs an embeddings provider registered by the account owner in the dashboard; " +
    'without one this is keyword search and `diagnostics.keyword_only` says so. That is normal, not an error. ' +
    'Returns facts with scores, pending tasks, recent events, and diagnostics. Not paginated: raise `limit` (max 100) for more.',
  operation: 'queryMemory',
  inputSchema: z.object({
    namespace: namespaceField,
    query: z.string().max(4096).describe('Search text. Empty returns the most recent facts.'),
    limit: z.number().int().min(1).max(100).default(10),
    excludeDrafts: z.boolean().optional(),
    asOf: dateTimeField.optional().describe('RFC 3339 timestamp; search memory as it was at that moment.'),
  }),
  async handler(input, ctx) {
    const namespace = resolveNamespace(input.namespace, ctx);
    const res = await ctx.client.call('queryMemory', {
      body: compact({ namespaces: [namespace], query: input.query, limit: input.limit, excludeDrafts: input.excludeDrafts, asOf: input.asOf }),
    });
    return res.data;
  },
});
```

`packages/mcp-server/src/tools/memory-remember.ts`:
```ts
import { z } from 'zod';
import { compact, confidenceField, dateTimeField, defineTool, namespaceField, resolveNamespace } from './shared';

export const memoryRemember = defineTool({
  name: 'memory_remember',
  description:
    'Store one fact the user decided or you observed. Works with no provider registered. Use `memory_ingest` for a whole document.',
  operation: 'rememberFact',
  inputSchema: z.object({
    namespace: namespaceField,
    title: z.string().min(1).max(1000),
    body: z.string().min(1).max(100000),
    tags: z.array(z.string().min(1).max(100)).max(100).optional(),
    confidence: confidenceField.optional(),
    okfType: z.string().min(1).max(128).optional().describe('Ontology node type, e.g. project, person, design_spec, procedure.'),
    validFrom: dateTimeField.optional().describe('When the fact became true. Defaults to now.'),
  }),
  async handler(input, ctx) {
    const namespace = resolveNamespace(input.namespace, ctx);
    const res = await ctx.client.call('rememberFact', {
      body: compact({
        namespace,
        title: input.title,
        body: input.body,
        tags: input.tags,
        confidence: input.confidence,
        sourceType: 'user_stated',
        okfType: input.okfType,
        validFrom: input.validFrom,
      }),
    });
    return res.data;
  },
});
```

`packages/mcp-server/src/tools/memory-supersede.ts`:
```ts
import { z } from 'zod';
import { compact, confidenceField, dateTimeField, defineTool, namespaceField, resolveNamespace } from './shared';

export const memorySupersede = defineTool({
  name: 'memory_supersede',
  description: 'Replace a fact with a corrected one and keep the old one in history. Never deletes.',
  operation: 'supersedeFact',
  inputSchema: z.object({
    namespace: namespaceField,
    factId: z.string().min(1).max(255).describe('The fact to replace.'),
    title: z.string().min(1).max(1000),
    body: z.string().min(1).max(100000),
    tags: z.array(z.string().min(1).max(100)).max(100).optional(),
    confidence: confidenceField.optional(),
    validFrom: dateTimeField.optional().describe('When the replacement became true. Defaults to now.'),
  }),
  async handler(input, ctx) {
    const namespace = resolveNamespace(input.namespace, ctx);
    const res = await ctx.client.call('supersedeFact', {
      path: { factId: input.factId },
      body: compact({
        namespace,
        validFrom: input.validFrom,
        replacement: compact({ kind: 'new', title: input.title, body: input.body, tags: input.tags, confidence: input.confidence, sourceType: 'user_stated' }),
      }),
    });
    return res.data;
  },
});
```

`packages/mcp-server/src/tools/memory-ingest.ts`:
```ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { INGEST_PROVIDER_MESSAGE, UsageError } from '../errors';
import { compact, defineTool, namespaceField, resolveNamespace } from './shared';

const SOURCE_REF_PATTERN = /^[A-Za-z0-9._\- ]{1,255}$/;

/** `/` becomes `__` (the SDK's rule); anything else illegal is an error naming the characters. */
export function encodeSourceRef(raw: string): string {
  const encoded = raw.replace(/\//g, '__');
  if (!SOURCE_REF_PATTERN.test(encoded)) {
    const bad = [...new Set(encoded.replace(/[A-Za-z0-9._\- ]/g, ''))].join(' ');
    throw new UsageError(`sourceRef may only contain letters, digits, ".", "_", "-", and spaces (1–255 chars); "/" is encoded as "__". Illegal: ${bad || 'length'}`);
  }
  return encoded;
}

export const memoryIngest = defineTool({
  name: 'memory_ingest',
  description: `Store a whole document; SynapseTree extracts the facts. ${INGEST_PROVIDER_MESSAGE}`,
  operation: 'ingestDocument',
  inputSchema: z.object({
    namespace: namespaceField,
    sourceRef: z.string().min(1).max(255).describe('Identifies the document, e.g. a repo-relative path. "/" is encoded as "__".'),
    content: z.string().min(1).max(524288),
    onDuplicateHash: z.enum(['skip', 'ingest', 'error']).default('skip').describe('What to do when another sourceRef already holds identical content.'),
  }),
  async handler(input, ctx) {
    const namespace = resolveNamespace(input.namespace, ctx);
    const sourceRef = encodeSourceRef(input.sourceRef);
    const sourceHash = createHash('sha256').update(input.content, 'utf8').digest('hex');
    const res = await ctx.client.call('ingestDocument', {
      body: compact({ mode: 'server_extraction', namespace, sourceRef, sourceHash, content: input.content, onDuplicateHash: input.onDuplicateHash }),
    });
    return res.data;
  },
});
```

`packages/mcp-server/src/tools/memory-log-event.ts`:
```ts
import { z } from 'zod';
import { compact, dateTimeField, defineTool, namespaceField, resolveNamespace } from './shared';

export const memoryLogEvent = defineTool({
  name: 'memory_log_event',
  description: 'Record that something happened: an observation, decision, action, or outcome, optionally tied to a fact.',
  operation: 'createEvent',
  inputSchema: z.object({
    namespace: namespaceField,
    eventType: z.enum(['observation', 'decision', 'action', 'outcome']),
    summary: z.string().min(1).max(8000),
    relatedFactId: z.string().min(1).max(255).optional(),
    occurredAt: dateTimeField.optional().describe('When it happened. Defaults to now.'),
  }),
  async handler(input, ctx) {
    const namespace = resolveNamespace(input.namespace, ctx);
    const res = await ctx.client.call('createEvent', {
      body: compact({ namespace, eventType: input.eventType, summary: input.summary, relatedFactId: input.relatedFactId, occurredAt: input.occurredAt }),
    });
    return res.data;
  },
});
```

`packages/mcp-server/src/tools/graph-traverse.ts`:
```ts
import { z } from 'zod';
import { compact, defineTool, namespaceField, resolveNamespace } from './shared';

export const graphTraverse = defineTool({
  name: 'graph_traverse',
  description: 'Walk the knowledge graph from a fact or node id, up to three hops. Returns the anchor first, then neighbours by depth, and the edges between them.',
  operation: 'traverseGraph',
  inputSchema: z.object({
    namespace: namespaceField,
    sourceId: z.string().min(1).max(255).describe('The fact or graph node id to start from.'),
    maxDepth: z.number().int().min(1).max(3).default(1),
    direction: z.enum(['inbound', 'outbound', 'both']).optional(),
    edgeTypes: z.array(z.string().min(1).max(128)).max(100).optional().describe('Allowed edge types, e.g. dependsOn, documents, supersedes. Omit for all.'),
    maxNodes: z.number().int().min(1).max(200).default(20),
    excludeDrafts: z.boolean().optional(),
  }),
  async handler(input, ctx) {
    const namespace = resolveNamespace(input.namespace, ctx);
    const res = await ctx.client.call('traverseGraph', {
      body: compact({
        namespace,
        sourceId: input.sourceId,
        maxDepth: input.maxDepth,
        direction: input.direction,
        edgeTypes: input.edgeTypes,
        maxNodes: input.maxNodes,
        excludeDrafts: input.excludeDrafts,
      }),
    });
    return res.data;
  },
});
```

`packages/mcp-server/src/tools/namespaces-list.ts`:
```ts
import { z } from 'zod';
import { defineTool } from './shared';

const PAGE = 100;
const CAP = 500;

interface Page { data: { namespace: string }[]; hasMore: boolean; nextCursor: string | null }

export const namespacesList = defineTool({
  name: 'namespaces_list',
  description: "List the namespaces in the user's database, optionally by prefix. Stops after 500 names and sets `truncated`.",
  operation: 'listNamespaces',
  inputSchema: z.object({
    prefix: z.string().max(128).optional(),
  }),
  async handler(input, ctx) {
    const namespaces: string[] = [];
    let after: string | undefined;
    let truncated = false;
    for (;;) {
      const res = await ctx.client.call<Page>('listNamespaces', { query: { prefix: input.prefix, limit: PAGE, after } });
      for (const row of res.data.data) namespaces.push(row.namespace);
      if (!res.data.hasMore || !res.data.nextCursor) break;
      if (namespaces.length >= CAP) { truncated = true; break; }
      after = res.data.nextCursor;
    }
    return { namespaces: namespaces.slice(0, CAP), truncated };
  },
});
```

`packages/mcp-server/src/tools/whoami.ts`:
```ts
import { z } from 'zod';
import { defineTool } from './shared';

export interface WhoamiResult {
  apiKeyId: string;
  organizationId: string;
  tenantDatabaseId: string;
  scope: 'read' | 'read_write';
  planCode: string | null;
  subscriptionStatus: string;
}

export const whoami = defineTool({
  name: 'whoami',
  description: 'Show which SynapseTree account, database, scope, and plan this server is using.',
  operation: 'whoami',
  inputSchema: z.object({}),
  async handler(_input, ctx) {
    const res = await ctx.client.call<WhoamiResult>('whoami');
    return res.data;
  },
});
```

`packages/mcp-server/src/tools/index.ts`:
```ts
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
```
The `as unknown as` cast erases each tool's specific zod type so the array has one element type; the handlers are still exercised with parsed input of their own schema by `server.ts` (Task 7).

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @equationalapplications/mcp-server test -- tools
pnpm --filter @equationalapplications/mcp-server test -- contract-guard
pnpm --filter @equationalapplications/mcp-server typecheck
```
Expected: PASS. Common failures and fixes: zod v4 exposes `z.iso.datetime` (not `z.string().datetime()`); if `whoami`'s `z.object({})` makes `'namespace' in shape` fail, that is the intended `false`. If the guard says `graph_traverse` sends `direction` but the input had none, check `compact` drops undefined.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/src/tools packages/mcp-server/__tests__/tools.test.ts packages/mcp-server/__tests__/contract-guard.test.ts
git commit -m "feat(mcp-server): the eight memory tools with the request-fidelity contract guard"
```

---

### Task 7: The MCP server over an in-memory transport

**Files:**
- Create: `packages/mcp-server/src/server.ts`
- Modify: `packages/mcp-server/src/index.ts`
- Test: `packages/mcp-server/__tests__/server.test.ts`
- Implements: spec §5.7, §10.2 guard 2 (second half), §12.1 "server".

**Interfaces:**
- Consumes: `TOOLS` (Task 6); `toolErrorText` (Task 3); `VERSION` (Task 1); `ToolContext`.
- Produces: `export function createServer(ctx: ToolContext): McpServer` (from `@modelcontextprotocol/sdk/server/mcp.js`).

- [ ] **Step 1: Write the failing tests**

`packages/mcp-server/__tests__/server.test.ts`:
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { SynapseTreeClient } from '../src/client';
import { createServer } from '../src/server';

const WHOAMI = { apiKeyId: 'k', organizationId: 'o', tenantDatabaseId: 'd', scope: 'read_write', planCode: null, subscriptionStatus: 'active' };

async function connected(responses: Array<{ status: number; body: unknown; problem?: boolean }>, defaultNamespace?: string) {
  const fetchImpl = (async () => {
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': next.problem ? 'application/problem+json' : 'application/json' } });
  }) as typeof fetch;
  const server = createServer({
    client: new SynapseTreeClient({ apiKey: 'stree_' + 'k'.repeat(43), baseUrl: 'https://api.test', userAgent: 'ua', fetch: fetchImpl, sleep: async () => {}, random: () => 0 }),
    defaultNamespace,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describe('createServer (spec §5.7)', () => {
  it('lists exactly the eight tools, in order, with descriptions and schemas', async () => {
    const { client, server } = await connected([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['memory_search', 'memory_remember', 'memory_supersede', 'memory_ingest', 'memory_log_event', 'graph_traverse', 'namespaces_list', 'whoami']);
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
    }
    expect(tools.find((t) => t.name === 'memory_search')?.inputSchema.properties).toHaveProperty('namespace');
    await server.close();
  });

  it('answers a tool call with pretty JSON text', async () => {
    const { client, server } = await connected([{ status: 200, body: WHOAMI }]);
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe('text');
    expect(JSON.parse(content[0].text)).toEqual(WHOAMI);
    await server.close();
  });

  it('turns a SynapseTree error into isError with the mapped text, not a protocol error', async () => {
    const { client, server } = await connected([{ status: 401, body: { message: 'Unauthorized' } }]);
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('synapsetree-mcp auth');
    await server.close();
  });

  it('turns a missing namespace into isError with the documented message', async () => {
    const { client, server } = await connected([]);
    const result = await client.callTool({ name: 'memory_search', arguments: { query: 'x' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('config set namespace');
    await server.close();
  });

  it('rejects invalid arguments before the handler runs', async () => {
    const { client, server } = await connected([]);
    const outcome = await client.callTool({ name: 'graph_traverse', arguments: { sourceId: 'a', maxDepth: 9 } }).then(
      (r) => ({ kind: 'result' as const, isError: r.isError === true }),
      () => ({ kind: 'thrown' as const, isError: true }),
    );
    expect(outcome.isError).toBe(true);
    await server.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @equationalapplications/mcp-server test -- server
```
Expected: FAIL — `Cannot find module '../src/server'`.

- [ ] **Step 3: Write `packages/mcp-server/src/server.ts`**

```ts
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
```

Update `packages/mcp-server/src/index.ts`:
```ts
export { SynapseTreeClient, DEFAULT_BASE_URL } from './client';
export type { CallInput, CallResult, ClientOptions } from './client';
export { OPERATIONS, OPERATION_IDS, WITHHELD_OPERATION_IDS, CONTRACT_INFO } from './contract';
export type { Operation, OperationId } from './contract';
export { SynapseTreeError, UsageError, toolErrorText } from './errors';
export { createServer, SERVER_NAME } from './server';
export { TOOLS, TOOL_NAMES } from './tools';
export type { ToolContext, ToolDefinition } from './tools';
export { VERSION } from './version';
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @equationalapplications/mcp-server test -- server
pnpm --filter @equationalapplications/mcp-server typecheck
pnpm --filter @equationalapplications/mcp-server build
```
Expected: PASS; build succeeds (the SDK is a dependency, so tsup leaves it external). If `registerTool`'s callback type complains about `args: unknown`, type it as `Record<string, unknown>`; the SDK passes the validated object.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/server.ts packages/mcp-server/src/index.ts packages/mcp-server/__tests__/server.test.ts
git commit -m "feat(mcp-server): MCP server registering the eight tools with mapped tool errors"
```

---

### Task 8: The auth.md registration state machine

**Files:**
- Create: `packages/mcp-server/src/authmd.ts`
- Test: `packages/mcp-server/__tests__/authmd.test.ts`
- Implements: spec §7.

**Interfaces:**
- Consumes: `SynapseTreeClient` (Task 4); `SynapseTreeError` (Task 3).
- Produces:
  ```ts
  export interface AuthmdOptions { sleep?: (ms: number) => Promise<void>; now?: () => number; deadlineMs?: number; info: (line: string) => void }
  export interface RegisterResult { apiKey: string; accountId: string | null }
  export class ClaimError extends Error { readonly code: string }
  export function registerByEmail(client: SynapseTreeClient, email: string, opts: AuthmdOptions): Promise<RegisterResult>;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/mcp-server/__tests__/authmd.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ClaimError, registerByEmail } from '../src/authmd';
import { SynapseTreeClient } from '../src/client';

const KEY = 'stree_' + 'z'.repeat(43);
const REG = { claim_token: 'stclaim_' + 'c'.repeat(43), user_code: '123456', poll: { token_endpoint: 'https://api.test/oauth2/token', grant: 'urn:synapsetree:claim', interval: 5 } };
const MINT = { access_token: KEY, token_type: 'Bearer', account_id: 'acc_7', scope: 'memory:full' };

type Scripted = { status: number; body: unknown; problem?: boolean } | Error;

function scenario(responses: Scripted[]) {
  const calls: { url: string; body: string | null }[] = [];
  const waits: number[] = [];
  const lines: string[] = [];
  let clock = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: (init?.body as string | null) ?? null });
    const next = responses.shift();
    if (!next) throw new Error('no scripted response left');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': next.problem ? 'application/problem+json' : 'application/json' } });
  }) as typeof fetch;
  const client = new SynapseTreeClient({ baseUrl: 'https://api.test', userAgent: 'ua', fetch: fetchImpl, sleep: async () => {}, random: () => 0 });
  const run = () => registerByEmail(client, 'dev@example.com', {
    info: (l) => lines.push(l),
    sleep: async (ms) => { waits.push(ms); clock += ms; },
    now: () => clock,
  });
  return { run, calls, waits, lines };
}

describe('registerByEmail (spec §7)', () => {
  it('registers, shows the code, waits poll.interval, then stores the key from the first 200', async () => {
    const s = scenario([{ status: 200, body: REG }, { status: 400, body: { error: 'authorization_pending', interval: 5 } }, { status: 200, body: MINT }]);
    const result = await s.run();
    expect(result).toEqual({ apiKey: KEY, accountId: 'acc_7' });
    expect(s.calls[0].url).toBe('https://api.test/agent/identity');
    expect(s.calls[0].body).toBe(JSON.stringify({ email: 'dev@example.com' }));
    expect(s.calls[1].url).toBe('https://api.test/oauth2/token');
    expect(s.calls[1].body).toBe(`grant_type=urn%3Asynapsetree%3Aclaim&assertion=${REG.claim_token}`);
    expect(s.waits).toEqual([5000, 5000]);
    expect(s.lines.join('\n')).toContain('123456');
    expect(s.lines.join('\n')).toContain('dev@example.com');
  });

  it('honors a larger interval on pending and adds 5 s on slow_down without one', async () => {
    const s = scenario([
      { status: 200, body: REG },
      { status: 400, body: { error: 'authorization_pending', interval: 8 } },
      { status: 400, body: { error: 'slow_down' } },
      { status: 400, body: { error: 'slow_down', interval: 20 } },
      { status: 200, body: MINT },
    ]);
    await s.run();
    expect(s.waits).toEqual([5000, 8000, 13000, 20000]);
  });

  it('keeps polling through server_error and network errors', async () => {
    const s = scenario([{ status: 200, body: REG }, { status: 500, body: { error: 'server_error' } }, new TypeError('fetch failed'), { status: 200, body: MINT }]);
    await expect(s.run()).resolves.toMatchObject({ apiKey: KEY });
  });

  it('stops on invalid_grant with the restart message', async () => {
    const s = scenario([{ status: 200, body: REG }, { status: 400, body: { error: 'invalid_grant' } }]);
    await expect(s.run()).rejects.toBeInstanceOf(ClaimError);
    await expect(scenario([{ status: 200, body: REG }, { status: 400, body: { error: 'invalid_grant' } }]).run()).rejects.toThrow(/expired|already used/);
  });

  it('prints the remedy and keeps polling on the account-wall codes', async () => {
    for (const code of ['key_limit_reached', 'database_name_taken', 'database_quota_exceeded']) {
      const s = scenario([
        { status: 200, body: REG },
        { status: 400, body: { error: code, error_description: 'fix it', error_uri: 'https://synapsetree.dev/dashboard' } },
        { status: 200, body: MINT },
      ]);
      await expect(s.run()).resolves.toMatchObject({ apiKey: KEY });
      expect(s.lines.join('\n')).toContain('fix it');
      expect(s.lines.join('\n')).toContain('https://synapsetree.dev/dashboard');
    }
  });

  it('stops with the server message on an unknown error', async () => {
    const s = scenario([{ status: 200, body: REG }, { status: 400, body: { error: 'unsupported_grant_type', error_description: 'nope' } }]);
    await expect(s.run()).rejects.toThrow(/unsupported_grant_type.*nope/);
  });

  it('stops when the registration quota is exceeded', async () => {
    const s = scenario([{ status: 403, body: { code: 'quota_exceeded', detail: 'five outstanding' }, problem: true }]);
    await expect(s.run()).rejects.toThrow(/five outstanding/);
  });

  it('gives up at the deadline', async () => {
    const pending = { status: 400, body: { error: 'authorization_pending', interval: 300 } };
    const s = scenario([{ status: 200, body: REG }, pending, pending, pending, pending, pending]);
    await expect(s.run()).rejects.toThrow(/expired/);
    expect(s.calls.length).toBeLessThanOrEqual(5);
  });

  it('never prints the claim token or the key', async () => {
    const s = scenario([{ status: 200, body: REG }, { status: 200, body: MINT }]);
    await s.run();
    const text = s.lines.join('\n');
    expect(text).not.toContain(REG.claim_token);
    expect(text).not.toContain(KEY);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @equationalapplications/mcp-server test -- authmd
```
Expected: FAIL — `Cannot find module '../src/authmd'`.

- [ ] **Step 3: Write `packages/mcp-server/src/authmd.ts`**

```ts
import type { SynapseTreeClient } from './client';
import { SynapseTreeError } from './errors';

export interface AuthmdOptions {
  /** Human-facing progress lines (the CLI sends them to stderr). Never contains secrets. */
  info: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Default 16 minutes: the claim itself expires after 15. */
  deadlineMs?: number;
}

export interface RegisterResult {
  apiKey: string;
  accountId: string | null;
}

export class ClaimError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ClaimError';
    this.code = code;
  }
}

interface Registration {
  claim_token: string;
  user_code: string;
  poll: { token_endpoint: string; grant: string; interval?: number };
}

interface TokenOk { access_token: string; token_type: string; account_id?: string; scope?: string }
interface TokenErr { error: string; error_description?: string; error_uri?: string; interval?: number }

const EXPIRED_MESSAGE = 'The claim expired (15 minutes) or was already used. Run `synapsetree-mcp auth --email` again.';
const REMEDY_CODES = new Set(['key_limit_reached', 'database_name_taken', 'database_quota_exceeded']);

export async function registerByEmail(client: SynapseTreeClient, email: string, opts: AuthmdOptions): Promise<RegisterResult> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.deadlineMs ?? 16 * 60 * 1000);

  const reg = (await client.call<Registration>('registerAgentIdentity', { body: { email } })).data;
  let intervalSeconds = reg.poll.interval ?? 5;

  opts.info(`Check ${email} for a SynapseTree approval link (usually within a minute; it expires in 15 minutes).`);
  opts.info(`Approve only if the page shows this code: ${reg.user_code}`);

  for (;;) {
    await sleep(intervalSeconds * 1000);
    if (now() > deadline) throw new ClaimError('invalid_grant', EXPIRED_MESSAGE);

    let res;
    try {
      res = await client.call<TokenOk | TokenErr>('oauthToken', { form: { grant_type: reg.poll.grant, assertion: reg.claim_token } });
    } catch (err) {
      // server_error (500) and network errors: keep polling at the current interval.
      if (err instanceof SynapseTreeError && (err.status >= 500 || err.status === 0)) continue;
      throw err;
    }

    if (res.status === 200) {
      const ok = res.data as TokenOk;
      return { apiKey: ok.access_token, accountId: ok.account_id ?? null };
    }

    const body = res.data as TokenErr;
    switch (body.error) {
      case 'authorization_pending':
        if (typeof body.interval === 'number') intervalSeconds = body.interval;
        continue;
      case 'slow_down':
        intervalSeconds = typeof body.interval === 'number' ? body.interval : intervalSeconds + 5;
        continue;
      case 'invalid_grant':
        throw new ClaimError('invalid_grant', EXPIRED_MESSAGE);
      default:
        if (REMEDY_CODES.has(body.error)) {
          opts.info(`${body.error}: ${body.error_description ?? 'the account owner must clear this in the dashboard'}${body.error_uri ? ` — ${body.error_uri}` : ''}`);
          opts.info('Waiting; approve again once it is fixed.');
          continue;
        }
        throw new ClaimError(body.error, `${body.error}${body.error_description ? `: ${body.error_description}` : ''}`);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @equationalapplications/mcp-server test -- authmd
pnpm --filter @equationalapplications/mcp-server typecheck
```
Expected: PASS. If the `server_error` case fails: the client retries 5xx only for 502/503/504, so a 500 reaches `authmd` as a thrown `SynapseTreeError` with status 500, which the `catch` treats as "keep polling". A `TypeError` from fetch becomes `network_error` with status 0 after the client's own three attempts.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/authmd.ts packages/mcp-server/__tests__/authmd.test.ts
git commit -m "feat(mcp-server): auth.md registration state machine"
```

---

### Task 9: The CLI and the stdio smoke test

**Files:**
- Replace: `packages/mcp-server/src/cli.ts`
- Create: `packages/mcp-server/src/commands.ts`
- Test: `packages/mcp-server/__tests__/commands.test.ts`
- Test: `packages/mcp-server/__tests__/stdio.test.ts`
- Implements: spec §5.8, §6, §12.1 "cli" and "stdio".

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  // commands.ts
  export type Command = { kind: 'serve' } | { kind: 'auth-key'; key: string } | { kind: 'auth-email'; email: string; baseUrl?: string } | { kind: 'auth-revoke' } | { kind: 'status' } | { kind: 'config-set'; key: 'namespace' | 'base-url'; value: string } | { kind: 'help' } | { kind: 'version' };
  export function parseArgs(argv: string[]): Command;           // throws UsageError
  export interface Io { out: (s: string) => void; err: (s: string) => void; env: NodeJS.ProcessEnv; fetch?: typeof fetch; configDir?: string }
  export function run(cmd: Command, io: Io): Promise<number>;    // exit code; never throws
  export const HELP: string;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/mcp-server/__tests__/commands.test.ts`:
```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, run } from '../src/commands';
import { readConfig, readCredentials, writeCredentials } from '../src/credentials';
import { UsageError } from '../src/errors';

const KEY = 'stree_' + 'q'.repeat(39) + 'tail';
const WHOAMI = { apiKeyId: 'k', organizationId: 'org_1', tenantDatabaseId: 'db_1', scope: 'read_write', planCode: 'pro', subscriptionStatus: 'active' };

let dir: string;
beforeEach(async () => { dir = join(await mkdtemp(join(tmpdir(), 'stmcp-cli-')), 'cfg'); });

function io(responses: Array<{ status: number; body?: unknown; problem?: boolean }>, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: { 'content-type': next.problem ? 'application/problem+json' : 'application/json' } });
  }) as typeof fetch;
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env, fetch: fetchImpl, configDir: dir }, out, err, calls };
}

describe('parseArgs (spec §6)', () => {
  it('parses every command', () => {
    expect(parseArgs([])).toEqual({ kind: 'serve' });
    expect(parseArgs(['serve'])).toEqual({ kind: 'serve' });
    expect(parseArgs(['auth', '--key', KEY])).toEqual({ kind: 'auth-key', key: KEY });
    expect(parseArgs(['auth', '--email', 'a@b.c'])).toEqual({ kind: 'auth-email', email: 'a@b.c' });
    expect(parseArgs(['auth', '--email', 'a@b.c', '--base-url', 'https://t'])).toEqual({ kind: 'auth-email', email: 'a@b.c', baseUrl: 'https://t' });
    expect(parseArgs(['auth', '--revoke'])).toEqual({ kind: 'auth-revoke' });
    expect(parseArgs(['status'])).toEqual({ kind: 'status' });
    expect(parseArgs(['config', 'set', 'namespace', 'repo:x'])).toEqual({ kind: 'config-set', key: 'namespace', value: 'repo:x' });
    expect(parseArgs(['config', 'set', 'base-url', 'https://t'])).toEqual({ kind: 'config-set', key: 'base-url', value: 'https://t' });
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
  });
  it('rejects bad input without echoing a key-shaped value', () => {
    expect(() => parseArgs(['bogus'])).toThrow(UsageError);
    expect(() => parseArgs(['auth'])).toThrow(UsageError);
    expect(() => parseArgs(['config', 'set', 'colour', 'x'])).toThrow(UsageError);
    expect(() => parseArgs(['auth', '--key', 'stree_short'])).toThrow(UsageError);
    try { parseArgs(['auth', '--key', 'stree_short']); } catch (e) { expect((e as Error).message).not.toContain('stree_short'); }
    expect(() => parseArgs(['config', 'set', 'namespace', 'Bad NS'])).toThrow(UsageError);
  });
});

describe('run', () => {
  it('auth --key verifies with whoami, stores the key, and prints status without the key', async () => {
    const h = io([{ status: 200, body: WHOAMI }, { status: 200, body: WHOAMI }]);
    expect(await run({ kind: 'auth-key', key: KEY }, h.io)).toBe(0);
    expect(await readCredentials(dir)).toMatchObject({ apiKey: KEY, source: 'dashboard' });
    const text = h.err.join('\n');
    expect(text).toContain('org_1');
    expect(text).toContain('stree_…tail');
    expect(text).not.toContain(KEY);
    expect(h.out).toEqual([]);
  });

  it('auth --key stores nothing when whoami fails', async () => {
    const h = io([{ status: 401, body: { message: 'Unauthorized' } }]);
    expect(await run({ kind: 'auth-key', key: KEY }, h.io)).toBe(1);
    expect(await readCredentials(dir)).toBeNull();
  });

  it('status reports the env key source and exits 3 with no key', async () => {
    const h = io([{ status: 200, body: WHOAMI }], { SYNAPSETREE_API_KEY: KEY, SYNAPSETREE_NAMESPACE: 'repo:z' });
    expect(await run({ kind: 'status' }, h.io)).toBe(0);
    expect(h.err.join('\n')).toMatch(/key source:\s+env/);
    expect(h.err.join('\n')).toContain('repo:z');
    const none = io([]);
    expect(await run({ kind: 'status' }, none.io)).toBe(3);
    expect(none.err.join('\n')).toContain('synapsetree-mcp auth');
  });

  it('config set writes the file', async () => {
    const h = io([]);
    expect(await run({ kind: 'config-set', key: 'namespace', value: 'repo:x' }, h.io)).toBe(0);
    expect(await run({ kind: 'config-set', key: 'base-url', value: 'https://t/' }, h.io)).toBe(0);
    expect(await readConfig(dir)).toEqual({ namespace: 'repo:x', baseUrl: 'https://t' });
  });

  it('auth --revoke deletes the file on 200, keeps it when unreachable, deletes it on 401', async () => {
    await writeCredentials(dir, { apiKey: KEY, accountId: null, source: 'dashboard', obtainedAt: 'now' });
    const ok = io([{ status: 200 }]);
    expect(await run({ kind: 'auth-revoke' }, ok.io)).toBe(0);
    expect(await readCredentials(dir)).toBeNull();

    await writeCredentials(dir, { apiKey: KEY, accountId: null, source: 'dashboard', obtainedAt: 'now' });
    const down = io([{ status: 503 }, { status: 503 }, { status: 503 }]);
    expect(await run({ kind: 'auth-revoke' }, down.io)).toBe(1);
    expect(await readCredentials(dir)).not.toBeNull();
    expect(down.err.join('\n')).toMatch(/unreachable|kept/i);

    const dead = io([{ status: 401, body: { message: 'Unauthorized' } }]);
    expect(await run({ kind: 'auth-revoke' }, dead.io)).toBe(0);
    expect(await readCredentials(dir)).toBeNull();
  });

  it('auth --revoke with an env key tells the user to unset it', async () => {
    const h = io([{ status: 200 }], { SYNAPSETREE_API_KEY: KEY });
    expect(await run({ kind: 'auth-revoke' }, h.io)).toBe(0);
    expect(h.err.join('\n')).toContain('SYNAPSETREE_API_KEY');
  });

  it('auth --email stores the key before printing status', async () => {
    const REG = { claim_token: 'stclaim_' + 'c'.repeat(43), user_code: '654321', poll: { token_endpoint: 'https://api.test/oauth2/token', grant: 'urn:synapsetree:claim', interval: 0 } };
    const h = io([{ status: 200, body: REG }, { status: 200, body: { access_token: KEY, token_type: 'Bearer', account_id: 'acc', scope: 'memory:full' } }, { status: 200, body: WHOAMI }]);
    expect(await run({ kind: 'auth-email', email: 'a@b.c' }, h.io)).toBe(0);
    expect(await readCredentials(dir)).toMatchObject({ apiKey: KEY, source: 'authmd', accountId: 'acc' });
    expect(h.err.join('\n')).toContain('654321');
    expect(h.err.join('\n')).not.toContain(KEY);
  });

  it('help and version go to stdout; serve with no key exits 3', async () => {
    const h = io([]);
    expect(await run({ kind: 'help' }, h.io)).toBe(0);
    expect(h.out.join('')).toContain('synapsetree-mcp');
    expect(await run({ kind: 'version' }, h.io)).toBe(0);
    const s = io([]);
    expect(await run({ kind: 'serve' }, s.io)).toBe(3);
  });
});
```

`packages/mcp-server/__tests__/stdio.test.ts`:
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;

describe('dist/cli.js over stdio (spec §12.1 "stdio")', () => {
  it('serves tools/list from the built bin', async () => {
    if (!existsSync(CLI)) throw new Error(`build first: pnpm --filter @equationalapplications/mcp-server build (missing ${CLI})`);
    const dir = await mkdtemp(join(tmpdir(), 'stmcp-stdio-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'serve'],
      env: { ...process.env, SYNAPSETREE_API_KEY: 'stree_' + 'x'.repeat(43), SYNAPSETREE_BASE_URL: 'http://127.0.0.1:9', SYNAPSETREE_CONFIG_DIR: dir },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['memory_search', 'memory_remember', 'memory_supersede', 'memory_ingest', 'memory_log_event', 'graph_traverse', 'namespaces_list', 'whoami']);
    } finally {
      await client.close();
    }
  }, 20_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @equationalapplications/mcp-server test -- commands
```
Expected: FAIL — `Cannot find module '../src/commands'`.

- [ ] **Step 3: Write `packages/mcp-server/src/commands.ts`**

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerByEmail } from './authmd';
import { SynapseTreeClient } from './client';
import {
  KEY_PATTERN, configDir, deleteCredentials, maskKey, readConfig, resolveSettings, writeConfig, writeCredentials, type Settings,
} from './credentials';
import { NO_KEY_MESSAGE, SynapseTreeError, UsageError } from './errors';
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
    if (key === 'base-url' && !/^https?:\/\//.test(value)) throw new UsageError('base-url must start with http:// or https://');
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
        else config.baseUrl = cmd.value.replace(/\/+$/, '');
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
        await printStatus(client, { ...settings, apiKey: cmd.key, keySource: 'file', accountId: null }, io);
        return 0;
      }
      case 'auth-email': {
        const settings = await resolveSettings(io.env, dir);
        const baseUrl = cmd.baseUrl?.replace(/\/+$/, '') ?? settings.baseUrl;
        const anonymous = makeClient({ apiKey: undefined, baseUrl }, io);
        const result = await registerByEmail(anonymous, cmd.email, { info: io.err });
        await writeCredentials(dir, { apiKey: result.apiKey, accountId: result.accountId, source: 'authmd', obtainedAt: new Date().toISOString() });
        if (cmd.baseUrl) await writeConfig(dir, { ...(await readConfig(dir)), baseUrl });
        io.err('Approved. Key stored.');
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
          if (err instanceof SynapseTreeError && (err.status === 401 || err.status === 403)) {
            io.err('The key was already dead on the server.');
          } else {
            io.err(`SynapseTree was unreachable; the local key was kept. (${err instanceof Error ? err.message : String(err)})`);
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
        await new Promise<void>((resolve) => { transport.onclose = () => resolve(); });
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
```

- [ ] **Step 4: Replace `packages/mcp-server/src/cli.ts`**

```ts
import { parseArgs, run } from './commands';
import { UsageError } from './errors';

async function main(): Promise<number> {
  let cmd;
  try {
    cmd = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof UsageError ? err.message : String(err)}\n`);
    return 2;
  }
  return run(cmd, {
    out: (s) => { process.stdout.write(s); },
    err: (s) => { process.stderr.write(s.endsWith('\n') ? s : `${s}\n`); },
    env: process.env,
  });
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 1; },
);
```

- [ ] **Step 5: Run the command tests, then build and run the stdio test**

```bash
pnpm --filter @equationalapplications/mcp-server test -- commands
pnpm --filter @equationalapplications/mcp-server build
pnpm --filter @equationalapplications/mcp-server test -- stdio
pnpm --filter @equationalapplications/mcp-server typecheck
```
Expected: all PASS. If `serve` in the command test hangs, confirm the no-key branch returns 3 before the transport is created. If the stdio test times out, run `node packages/mcp-server/dist/cli.js serve` by hand with the same env and type `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}` followed by Enter; a JSON response proves the transport; otherwise read stderr.

- [ ] **Step 6: Run the whole package suite**

```bash
pnpm --filter @equationalapplications/mcp-server test
```
Expected: every file passes; `live.integration` is not present yet (Task 10).

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server/src/cli.ts packages/mcp-server/src/commands.ts packages/mcp-server/__tests__/commands.test.ts packages/mcp-server/__tests__/stdio.test.ts
git commit -m "feat(mcp-server): CLI with serve, auth, status and config commands; stdio smoke test"
```

---

### Task 10: Gated live test, README, repo wiring, and final verification

**Files:**
- Create: `packages/mcp-server/__tests__/live.integration.test.ts`
- Create: `packages/mcp-server/README.md`
- Modify: `.releaserc.json` (the `prepareCmd` directory array)
- Modify: `.github/workflows/release.yml` (the ordered publish list, after the `okf` line)
- Modify: `README.md` (badge line, ecosystem table row, "eight packages" → "nine")
- Modify: every `packages/*/README.md` Monorepo Ecosystem table (add one row)
- Implements: spec §3, §12.2, §13.

- [ ] **Step 1: Write the gated live test**

`packages/mcp-server/__tests__/live.integration.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SynapseTreeClient } from '../src/client';
import { TOOLS } from '../src/tools';
import type { ToolContext, ToolDefinition } from '../src/tools/shared';

const apiKey = process.env.SYNAPSETREE_API_KEY;
const baseUrl = process.env.SYNAPSETREE_BASE_URL;
const enabled = Boolean(apiKey && baseUrl);

const tool = (name: string): ToolDefinition => {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(name);
  return t;
};

describe.skipIf(!enabled)('live chain against the SynapseTree test stage (spec §12.2; set SYNAPSETREE_API_KEY and SYNAPSETREE_BASE_URL)', () => {
  const namespace = `repo:mcp-server-live-${randomUUID().slice(0, 8)}`;
  const ctx: ToolContext = { client: new SynapseTreeClient({ apiKey, baseUrl: baseUrl ?? '', userAgent: 'synapsetree-mcp/live-test' }), defaultNamespace: namespace };
  const call = (name: string, input: Record<string, unknown>) => tool(name).handler(tool(name).inputSchema.parse(input), ctx);
  const title = `live ${randomUUID()}`;
  let factId = '';

  it('whoami', async () => {
    expect(await call('whoami', {})).toMatchObject({ scope: expect.stringMatching(/read/) });
  });
  it('memory_remember → memory_search finds it', async () => {
    const fact = (await call('memory_remember', { title, body: 'first body', confidence: 'certain' })) as { id: string };
    factId = fact.id;
    const found = (await call('memory_search', { query: title, limit: 5 })) as { facts: { id: string }[] };
    expect(found.facts.map((f) => f.id)).toContain(factId);
  });
  it('memory_supersede → memory_search returns the replacement', async () => {
    const res = (await call('memory_supersede', { factId, title, body: 'second body', confidence: 'certain' })) as { replacement: { id: string } };
    const found = (await call('memory_search', { query: title, limit: 5 })) as { facts: { id: string; body: string }[] };
    expect(found.facts.find((f) => f.id === res.replacement.id)?.body).toBe('second body');
  });
  it('memory_log_event and namespaces_list', async () => {
    await call('memory_log_event', { eventType: 'outcome', summary: 'live chain ran', relatedFactId: factId });
    const list = (await call('namespaces_list', { prefix: 'repo:mcp-server-live-' })) as { namespaces: string[] };
    expect(list.namespaces).toContain(namespace);
  });
}, 60_000);
```

Run `pnpm --filter @equationalapplications/mcp-server test` and confirm the file reports as skipped.

- [ ] **Step 2: Write `packages/mcp-server/README.md`**

Follow spec §13 exactly. Use `packages/prisma-outbox/README.md` for the badge line, link bar, ecosystem table, and footer formatting (copy its ecosystem table and add the new row). Content:

````markdown
# @equationalapplications/mcp-server

SynapseTree memory for coding agents: an MCP server that lets Claude Code, Cursor, Windsurf, Claude Desktop, or any MCP client search, remember, supersede, ingest, log events, and walk the knowledge graph in your [SynapseTree](https://synapsetree.dev) database.

[badges as in prisma-outbox/README.md, with this package's npm name]

[link bar as in prisma-outbox/README.md]

## What it is

A small Node program your MCP client launches on your own machine over stdio. It exposes eight SynapseTree memory operations as tools and forwards each call to `https://api.synapsetree.dev` with your API key. It stores nothing but that key, a base URL, and a default namespace. It never runs in anyone's cloud, and it never sees your conversation with the model — only tool calls.

## Install

```bash
npm install -g @equationalapplications/mcp-server
```

Node 20 or newer. Two commands are installed: `synapsetree-mcp` (canonical) and `mcp-server` (alias). This README uses the canonical name.

## Get a key

**From the dashboard.** Sign in at https://synapsetree.dev/dashboard, open *API keys*, issue a key next to your database, then:

```bash
synapsetree-mcp auth --key stree_…
```

**By email, from the terminal** (the [auth.md](https://synapsetree.dev/auth.md) flow):

```bash
synapsetree-mcp auth --email you@example.com
```

A six-digit code is printed. SynapseTree emails you an approval link within about a minute; the page shows the same code. Approve only if the codes match. The link expires after 15 minutes. The first poll after approval receives the only copy of the key and stores it.

The key is stored in `credentials.json` under your config directory with mode `0600` and is never printed again; `status` shows the last four characters.

## Set a namespace

Every memory tool needs a namespace. Set a default once per machine, or pass `namespace` on each call:

```bash
synapsetree-mcp config set namespace repo:myproject
```

Convention: `repo:<directory name>`. The server never invents a namespace.

## Connect your client

Claude Code:

```bash
claude mcp add synapsetree -- synapsetree-mcp
```

Cursor (`.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`), Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "synapsetree": { "command": "synapsetree-mcp" } } }
```

## Tools

| Tool | What it does |
|---|---|
| `memory_search` | Hybrid search over facts; also returns pending tasks and recent events. Keyword-only until the account owner registers an embeddings provider (`diagnostics.keyword_only`). |
| `memory_remember` | Store one fact (title, body, tags, confidence, type). Works with no provider. |
| `memory_supersede` | Replace a fact with a corrected one; history is kept. Never deletes. |
| `memory_ingest` | Store a whole document and let SynapseTree extract facts. Needs an extraction provider registered in the dashboard (BYOK). |
| `memory_log_event` | Record an observation, decision, action, or outcome. |
| `graph_traverse` | Walk the knowledge graph from a fact or node, up to three hops. |
| `namespaces_list` | List namespaces, optionally by prefix. |
| `whoami` | Account, database, scope, plan, subscription status. |

## Environment variables

| Variable | Effect |
|---|---|
| `SYNAPSETREE_API_KEY` | Use this key instead of the stored one. |
| `SYNAPSETREE_BASE_URL` | API base URL (default `https://api.synapsetree.dev`). |
| `SYNAPSETREE_NAMESPACE` | Default namespace, overriding `config.json`. |
| `SYNAPSETREE_CONFIG_DIR` | Where `credentials.json` and `config.json` live. |

Default config directory: macOS `~/Library/Application Support/synapsetree`, Linux `$XDG_CONFIG_HOME/synapsetree` or `~/.config/synapsetree`, Windows `%APPDATA%\synapsetree`. On Windows the `0600`/`0700` file modes are best-effort.

## What it never does

- Export, delete, or run maintenance on your memory. Those are owner actions in the dashboard, and this server does not expose them even if your key could.
- Print your key, or the claim token used during email registration.
- Run anywhere but your machine. Memories go only to SynapseTree; SynapseTree calls an inference provider only if the account owner registered one.

## Verify

```bash
synapsetree-mcp status
npx @modelcontextprotocol/inspector synapsetree-mcp
```

## Release checklist (maintainers)

Before publishing a version, against the SynapseTree **test** stage with a dashboard key:

1. `synapsetree-mcp auth --key …` then `synapsetree-mcp status`.
2. `SYNAPSETREE_API_KEY=… SYNAPSETREE_BASE_URL=… pnpm --filter @equationalapplications/mcp-server test` — runs the live chain (`whoami` → remember → search → supersede → search → log event → list). Until SynapseTree wires the write operations in production, the chain stops at `memory_remember` with `not_implemented`; that is expected until that gate closes.
3. `npx @modelcontextprotocol/inspector synapsetree-mcp` and run one `memory_search`.
4. `synapsetree-mcp auth --email …` once, approve the email, then `synapsetree-mcp auth --revoke`.

The vendored contract in `contract/` is generated in the SynapseTree repository and must not be hand-edited; the unit tests fail if it drifts from what the tools send or if it ever contains an owner-only operation.

## Monorepo Ecosystem

[the table from prisma-outbox/README.md, plus this row:]
| **@equationalapplications/mcp-server** | MCP server exposing SynapseTree memory tools to coding agents | Node |

[footer as in prisma-outbox/README.md]
````

- [ ] **Step 3: Wire the release and the READMEs**

`.releaserc.json`: in the `prepareCmd` array `['core','react','expo','prisma-outbox','core-llm-tools','okf','schema-org','schema-software-org']` append `'mcp-server'`.

`.github/workflows/release.yml`: after the line `publish_if_needed "./packages/okf/package.json" …` add:
```
          publish_if_needed "./packages/mcp-server/package.json" pnpm --filter "./packages/mcp-server" publish --no-git-checks --access public
```
(same indentation as the line above it).

Root `README.md`: add a badge line for `@equationalapplications/mcp-server` after the last existing badge line (same markup, this package's name); in the Monorepo Ecosystem section change "eight packages" to "nine packages" and add the table row `| @equationalapplications/mcp-server | MCP server exposing SynapseTree memory tools to coding agents | Node |` matching the table's columns.

Every other `packages/*/README.md` with a Monorepo Ecosystem table: add the same row in the same style the table uses (bold name).

Verify:
```bash
grep -n "mcp-server" .releaserc.json .github/workflows/release.yml README.md packages/*/README.md | wc -l
```
Expected: at least 11 lines (releaserc, workflow, root README ×2, eight package READMEs plus this package's own).

- [ ] **Step 4: Full repo verification, as CI runs it**

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm --filter @equationalapplications/mcp-server test
```
Expected: all succeed. (`pnpm test` at the root also runs the integration package, which needs its own fixtures; run it if the environment has them, otherwise rely on CI.) Then:
```bash
node packages/mcp-server/dist/cli.js --help | head -3
npm pack --dry-run --workspace packages/mcp-server 2>/dev/null || (cd packages/mcp-server && npm pack --dry-run)
```
Expected: help prints; the pack listing contains `dist/cli.js`, `dist/index.js`, `dist/index.mjs`, `dist/index.d.ts`, `contract/synapsetree-openapi.subset.json`, `LICENSE`, `README.md`, `package.json`, and nothing from `src/` or `__tests__/`.

- [ ] **Step 5: Commit and push**

```bash
git add packages/mcp-server .releaserc.json .github/workflows/release.yml README.md packages/*/README.md
git commit -m "feat(mcp-server): README, gated live test, and release wiring"
git push -u origin feat/mcp-server
```

- [ ] **Step 6: Update the draft PR description**

The draft PR already exists for `feat/mcp-server`. Edit its body to add, under a `## Implementation` heading: the list of commits, the test counts from `pnpm --filter @equationalapplications/mcp-server test`, a `## Deviations` section (empty, or each deviation from the spec with the reason), and a `## Before merge` checklist copied from the spec's §0 gates. Leave the PR as a draft.

---

## Self-review record

- **Spec coverage.** §3 → Task 10 step 3. §4 → Task 1. §5.1 → Task 2. §5.2 → Task 4. §5.3 → Task 3. §5.4 → Task 5. §5.5 → Task 8. §5.6 → Task 6. §5.7 → Task 7. §5.8 and §6 → Task 9. §7 → Task 8. §8 → Task 6. §9 → Task 3. §10 → Tasks 2 and 6. §12.1 → Tasks 2–9. §12.2 → Task 10 step 1. §12.3 and §13 → Task 10 step 2. §14, §15 need no task.
- **Placeholders.** The only `<…>` markers are the pins the implementer copies from existing files in Task 1 step 1; every other step has its full content.
- **Type consistency.** `ToolContext`/`ToolDefinition` are defined once in `tools/shared.ts` and re-exported from `tools/index.ts`; `SynapseTreeClient.call` returns `CallResult<T>` everywhere; `WhoamiResult` is defined in `tools/whoami.ts` and imported by `commands.ts`; `KEY_PATTERN` and `NAMESPACE_PATTERN` are each defined once and imported where used; `registerByEmail`'s `info` option is the only output channel of the auth flow and `commands.ts` passes `io.err`.
