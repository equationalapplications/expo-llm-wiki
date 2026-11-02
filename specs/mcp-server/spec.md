# `@equationalapplications/mcp-server` — SynapseTree memory for coding agents

**Date:** 2026-11-01 (rev 1); rev 2 2026-11-02
**Status rev 1 (2026-11-01, PR #305; superseded by rev 2 below):** IMPLEMENTED (package code) — design approved in session by Kurt
VanDusen 2026-11-01; the package is built on this branch (ten TDD tasks per
`plan.md` in this folder, tests mocked-only; the live chain is gated by
§12.3 before public launch). **§3's three repo edits are DEFERRED by owner
ruling (Kurt VanDusen, 2026-11-01): the release wiring lands in a follow-up
PR after the §0 gates close, so this PR cannot publish anything. The
version-less `package.json` is safe in the interim — `release.yml` stages
`packages/*/package.json` but only `publish_if_needed` entries publish, and
`mcp-server` is not one until the follow-up adds it. `plan.md` and
`LEDGER.md` are deliberately kept past merge (not cleaned up per the
folder lifecycle) because the deferred §3 wiring PR resumes from them.**
**Status rev 2 (2026-11-02, PR #323; current):** IMPLEMENTED — §3's three repo edits (#323).
G1 and G2 are closed (§0). G3 is closed: `7.15.2` was published by hand on
2026-11-02 and the npm trusted-publisher entry (GitHub Actions, `release.yml`)
exists (§2 R10). G4's pre-publish runs passed 2026-11-02 (test stage, and the email-and-revoke sequence on production), and its post-publish tarball comparison and registry smoke passed the same day on `7.16.0`, so G4 is closed (§0). The first release-pipeline
version, `7.16.0`, shipped from `release.yml` after #323 merged (PR #327). `plan.md` and
`LEDGER.md` are deleted in #323 (they remain in git history at PR #305):
the wiring PR they were kept for is this one, so the folder lifecycle
(`specs/README.md`) applies again.
**Package:** `packages/mcp-server`, published as `@equationalapplications/mcp-server`.
**Authority:** This spec is the implementer's single source. It is derived
from SynapseTree's private design spec (`2026-10-31-mcp-server-design.md`
in that repo) and from the public `https://synapsetree.dev/auth.md`. Where
this spec and a SynapseTree ruling disagree, the ruling wins and this spec
is wrong until amended. The implementer has no access to the SynapseTree
repo and needs none: every fact required is here or in the vendored
contract (§10).
**Verification model:** mocked-only. The implementer never holds a
SynapseTree key. The one live check is a documented manual step (§12.3).

## 0. Gates (G1-G3 and G4's pre-publish runs blocked publish; G4's post-publish runs followed it; all CLOSED)

| Gate | What | Who |
|---|---|---|
| G1 | SynapseTree production wires `rememberFact`, `supersedeFact`, `createEvent`, `traverseGraph`, `listNamespaces` (they answered `501 not_implemented` at rev 1). **CLOSED 2026-11-02:** SynapseTree PR #145. | SynapseTree |
| G2 | SynapseTree fixes `POST /oauth2/revoke` answering 401 for a valid key. **CLOSED 2026-11-01:** SynapseTree #136, fixed by PR #141; the live check is the `auth --revoke` step of G4. | SynapseTree |
| G3 | npm trusted-publisher entry for `@equationalapplications/mcp-server` (the release workflow publishes by OIDC, no token), or a manual first publish | Kurt |
| G4 | The live gate (§12.3), split by the 2026-11-02 round-4 ruling (Tier-4, owner-approved): the email-and-revoke sequence runs on **production** from the packed tarball before publish; the install-and-call smoke runs on the test stage from the tarball before publish and from the registry after. **Before publish, PASSED 2026-11-02** from the #323 branch at `592a855a`, tarball `equationalapplications-mcp-server-7.16.0.tgz` (produced by stamping `"version": "7.16.0"` into a local copy of `packages/mcp-server/package.json`, building, `npm pack`, then restoring the file; the committed manifest has no `version`, which `.releaserc.json` `prepareCmd` writes at release) sha256 `04e2b0f820ac294445d4ea82870ea75639d4cf1b5a1c61b1288fafa82a2aa48b`. *Test stage:* CLI live chain 128/128; MCP stdio lists the eight tools; from the tarball `whoami`, `memory_remember` and `memory_search` (hit) all ok; `auth --revoke` then the revoked key answers 403 after the 30 s authorizer cache. Test keys came from the ops `issueApiKey` operation (throwaway users, deleted after). *Production, email half:* a run for the owner's main address (returning-user path) reached approval (code matched, 600132) but the token poll answered `database_quota_exceeded` (Hobby plan, no free database slot), so no key issued; the CLI repeated that message on every poll (follow-up). Rerun as first registration for `info+g4@equationalapplications.com`: code 952059 matched; approval to key 8 min 22 s (17:04:24 to 17:12:46 UTC, including owner response time); expected vs actual: key works pre-revoke `whoami` 200 / 200 with scope `memory:full` (and the MCP `whoami` tool parses it); revoke 200 / 200 (`Stored key revoked.`); second revoke 200 / 200 (RFC 7009); post-revoke after the 30 s TTL 401 revoked-variant / **403 `{"message":"Forbidden"}`**, the contract's API Gateway response for an unknown or revoked key (§0 G2 live check passes); negative-control key not run (no second production key held). Issues: SynapseTree #152 (test-stage claim links go to production), #153 (test-stage claim page; review 2026-12-01). **After publish, PASSED 2026-11-02; G4 CLOSED.** `release.yml` published `7.16.0` with provenance at about 17:47 UTC (merge `b34a69d8`, PR #327). *Tarball comparison:* registry tarball sha256 `67fbed09133b1aa1564890d61a29717e2fb7f31ba2a5233543d88310fb0200db` against a fresh rebuild at `592a855a` by the method above (stamp the version first, then build: `VERSION` is baked at build time, so a build before the stamp ships `0.0.0-dev` in `cli.js`). Every `dist` file is byte-identical; `package.json` differs only in key order (`prepareCmd` inserts `version` before `scripts`), and equals the rebuild structurally. The whole-tarball hash differs from the pre-publish `04e2b0f8…` because the two packs are separate builds; the content comparison is the test. *Registry smoke, test stage:* `npm install` of `7.16.0` from the registry, MCP stdio: server reports `7.16.0`, lists exactly the eight tools; `whoami` matches the issued key, org and database; `memory_remember` writes; `memory_search` hits. Test keys came from the ops `issueApiKey` operation (throwaway ids; after the run the key was revoked, the user deleted and the database deletion requested; the database stays `pending_deletion` until SynapseTree's scheduled GC, a SynapseTree runbook drift, not a package defect). | Kurt |

The build is not blocked by any gate. Only the release is, and only by the gates the ordering below puts before publish.

**Gate ordering (round-4 ruling, 2026-11-02).** Bug gates (G1, G2) close before publish. G4 is the live gate. Its email registration and revoke sequence runs from the packed tarball against production before publish, because the test stage cannot approve a claim (SynapseTree #152) and because production is the environment users run it in. Its install-and-call smoke runs on the test stage from the tarball before publish and from the registry after. G4 closes when both runs are recorded in the gates table. A G4 failure after publish is remedied by a patch release, never an unpublish.

## 1. Purpose

SynapseTree (`https://synapsetree.dev`) is a hosted memory service built on
this repo's engine. Its website's first call to action is
`npm install -g @equationalapplications/mcp-server`, and that package does
not exist. This package is the coding-agent door: a small Node program that
an MCP client (Claude Code, Cursor, Windsurf, Claude Desktop, any
MCP-capable harness) launches on the developer's own machine over stdio.
It exposes eight SynapseTree memory operations as MCP tools and forwards
each call to `https://api.synapsetree.dev` with the developer's API key.

It holds no state but that key, a base URL, and a default namespace. It
never runs in Equational Applications' cloud, and it never sees the
developer's conversation with their model — only tool calls.

## 2. Rulings of record

These are owner rulings. They are not design choices and are not reopened
by this spec.

| # | Ruling | Date |
|---|---|---|
| R1 | Package name is exactly `@equationalapplications/mcp-server`, live on npm before any SynapseTree public launch. | 2026-10-26 |
| R2 | Source lives here, `packages/mcp-server`, MIT like the rest of the repo. | 2026-10-31 |
| R3 | v1 supports both ways to get a key: paste a dashboard key, or run the auth.md registration flow from the terminal. | 2026-10-31 |
| R4 | v1 exposes a curated set of eight tools, not the whole contract. Adding any tool is a spec amendment that names its scope. | 2026-10-31 |
| R5 | No anonymous credentials. Export and destructive operations are never agent-callable through this server, whatever the stored key could do ("D3"). | standing |
| R6 | The vendored contract is a pruned OpenAPI subset of exactly the operations this server calls, committed in this repo and regenerated from SynapseTree. | 2026-11-01 |
| R7 | The registration response carries the poll interval as `poll.interval` (seconds); a pending or slow-down answer may replace it. | 2026-11-01 |
| R8 | The implementer verifies with mocks only; the live check is manual, before release. | 2026-11-01 |
| R9 | Tool names stay as shipped in §8 (`memory_*`, `graph_traverse`, `namespaces_list`, `whoami`); they are not renamed to `wiki_*`. `docs/synapsetree-integration.md` §6 lists these names with the core call each reaches; `__tests__/tool-name-parity.test.ts` locks them. This answers SynapseTree's `2026-11-01-wire-memory-operations` §8 naming cleanup. | 2026-11-02 |
| R10 | G3 is met by a one-off manual publish of `7.15.2` (the then-current lockstep version) from a local build of the #323 head, then the npm trusted-publisher entry (GitHub Actions, `release.yml`, no environment). Order matters, because tsup bakes `__PKG_VERSION__` at build time: stamp `7.15.2` into `packages/mcp-server/package.json`, then build, confirm `node dist/cli.js --version` prints `7.15.2`, publish, then `git checkout packages/mcp-server/package.json`. That version carries no provenance; every later version comes from `release.yml` by OIDC. Publishing the *next* version by hand is forbidden: `publish_if_needed` would skip it. | 2026-11-02 |

## 3. Repo integration

The workspace picks up `packages/mcp-server` automatically
(`pnpm-workspace.yaml` globs `packages/*`). Three edits outside the package —
deferred from PR #305 by owner ruling and landed in the release-wiring
PR #323 (2026-11-02):

1. `.releaserc.json` — add `'mcp-server'` to the directory array in the
   `prepareCmd` that stamps `${nextRelease.version}` into each package.
2. `.github/workflows/release.yml` — add, last in the ordered publish
   list (it has no workspace dependencies, so a failed publish cannot block
   a sibling):
   `publish_if_needed "./packages/mcp-server/package.json" pnpm --filter "./packages/mcp-server" publish --no-git-checks --access public`
3. `README.md` — a badge line for the package and its row in the
   Packages and Ecosystem tables. (Every package README's ecosystem table
   already gained the row in PR #305.)

No change to root `tsconfig.json` or root `vitest.config.ts` (neither is
used by CI; both already omit some packages). `pnpm install` must be run
once so `pnpm-lock.yaml` includes the new dependencies; CI installs with
`--frozen-lockfile`.

Versioning is lockstep and automatic. The PR merges as a merge commit,
never squash (AGENTS.md, INTENT.md "Merge commits, never squash"; the
a release is driven by the conventional commits *inside* the PR, not
the merge-commit subject, so #323 carries a `feat(mcp-server): …` commit),
the next release stamps the package with the
same version as every other package, and that is the first
pipeline-published version. No manual version edits, ever
(CONTRIBUTING.md), with the single transient exception of the R10
bootstrap publish, which never commits the stamped version.

## 4. Package shape

```
packages/mcp-server/
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
  LICENSE                 # copy of the repo LICENSE
  README.md               # §13
  contract/
    synapsetree-openapi.subset.json   # §10, generated, committed
  src/
    index.ts              # library entry: createServer, SynapseTreeClient, types
    cli.ts                # bin entry: argument parsing and the five commands
    version.ts            # export const VERSION = __PKG_VERSION__ (injected by tsup `define`)
    server.ts             # createServer(): registers exactly the eight tools
    client.ts             # HTTP client built from the contract table
    contract.ts           # loads the subset; the operation table
    errors.ts             # SynapseTreeError; problem+json → tool-error text
    credentials.ts        # config dir, credentials.json, config.json
    authmd.ts             # the registration state machine
    tools/
      memory-search.ts
      memory-remember.ts
      memory-supersede.ts
      memory-ingest.ts
      memory-log-event.ts
      graph-traverse.ts
      namespaces-list.ts
      whoami.ts
      index.ts            # the ordered list of eight
  __tests__/
    …                     # §12
```

**package.json** (fields beyond the sibling template in
`packages/core-llm-tools/package.json`, which is copied otherwise):

- `"bin": { "synapsetree-mcp": "./dist/cli.js" }` — one command only.
  AMENDED 2026-11-01 (owner ruling D2, recorded in the PR #305 decision
  log): the original draft also aliased `mcp-server`, but that generic name
  risks npm install conflicts with any other publisher's tool of the same
  name, and removing a bin after first publish is breaking. The SynapseTree
  website's hero copy must reference `synapsetree-mcp`.
- `"files": ["dist", "contract", "LICENSE", "README.md"]` — the contract
  ships for transparency; the build also bundles it (§5.1), so the runtime
  never reads the filesystem to find it.
- `"dependencies": { "@modelcontextprotocol/sdk": "1.32.1", "zod": "4.6.7" }`.
  Exact pins, like the repo. Both versions are older than the workspace's
  14-day minimum release age (`pnpm-workspace.yaml`). The SDK declares
  `zod ^3.25 || ^4.0` and ships CommonJS and ESM.
- `"devDependencies": { "tsup": "9.0.0", "typescript": "5.9.3", "vitest": "5.0.4" }`
  — the same pins as the siblings at the time of writing; match whatever
  `packages/core-llm-tools` has when the work starts.
- `"engines": { "node": ">=20" }`. Node 20 has global `fetch`, `crypto.randomUUID`,
  and `crypto.subtle`; no polyfills.
- `"description"`, `"keywords"` (`mcp`, `model-context-protocol`,
  `synapsetree`, `memory`, `claude-code`, `cursor`), `"repository.directory"`,
  `"homepage"`, `"publishConfig"` as the template.

**tsup.config.ts:** `defineConfig([...])` with two config objects sharing
`format: ['cjs', 'esm']`, `sourcemap: true`, `treeshake: true`, and
`define: { __PKG_VERSION__: JSON.stringify(pkg.version) }` (the version
read from `./package.json` at build time; `src/version.ts` exports it, so
no runtime `require` of package.json is needed). The first object builds
`src/index.ts` with `dts: true` and `clean: true`. The second builds
`src/cli.ts` with `dts: false`, `clean: false`, and
`banner: { js: '#!/usr/bin/env node' }`, so only the CLI gets the shebang.
`dist/cli.js` must start with the shebang; npm sets the executable bit
from `bin` on install.

**tsconfig.json:** the sibling template, with `"lib": ["ES2022"]` and
`"types": ["node"]` added (the package uses `node:fs/promises`,
`node:path`, `node:os`, `node:crypto`, `node:child_process` in tests).
`@types/node` is already hoisted at the root; if `typecheck` cannot see
it, add the root's exact `@types/node` pin to devDependencies.

**vitest.config.ts:** the sibling template (`__tests__/**/*.test.ts`,
`environment: 'node'`).

## 5. Modules and their contracts

Each module has one purpose and a narrow interface. Tests target the
interface, not the internals.

### 5.1 `contract.ts`

Imports `contract/synapsetree-openapi.subset.json` as a JSON module
(`resolveJsonModule`; tsup bundles it into `dist/`, so no runtime path
resolution is needed, which matters for a globally installed bin) and
exposes:

```ts
export interface Operation {
  operationId: string;      // e.g. "rememberFact"
  method: "GET" | "POST";
  path: string;             // e.g. "/v1/memory/facts/{factId}/supersede"
  scope: "read" | "read_write" | null;   // x-synapsetree-scope; null for /agent and /oauth2
  requestProperties: string[];           // top-level JSON body property names (union of oneOf branches)
  requiredProperties: string[];
  queryParameters: string[];
  pathParameters: string[];
  acceptsIdempotencyKey: boolean;
}
export const OPERATIONS: Readonly<Record<OperationId, Operation>>;
export type OperationId = "queryMemory" | "rememberFact" | "supersedeFact" | "ingestDocument"
  | "createEvent" | "traverseGraph" | "listNamespaces" | "whoami"
  | "registerAgentIdentity" | "oauthToken" | "oauthRevoke";
```

The table is derived from the JSON, not typed by hand, so a regenerated
contract changes behavior and the guard tests (§10.2) catch disagreement.

### 5.2 `client.ts`

```ts
export interface ClientOptions { apiKey?: string; baseUrl: string; userAgent: string; fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; }
// apiKey is optional only so `auth --email` can call registerAgentIdentity and oauthToken;
// every other operation throws a usage error (not an HTTP call) when apiKey is absent.
export class SynapseTreeClient {
  constructor(opts: ClientOptions);
  call<T>(op: OperationId, input: { path?: Record<string,string>; query?: Record<string,string|number|undefined>; body?: unknown; timeoutMs?: number }): Promise<{ data: T; requestId?: string; rateLimit?: string; rateLimitPolicy?: string; idempotentReplayed?: boolean }>;
}
```

Rules (all testable with an injected `fetch`):

- URL = `baseUrl` + path with `{param}` substituted (URL-encoded) + query
  string (undefined values omitted). `baseUrl` default
  `https://api.synapsetree.dev`, override by `SYNAPSETREE_BASE_URL`,
  trailing slash stripped.
- Headers on every call: `Authorization: Bearer <key>`,
  `Accept: application/json, application/problem+json`,
  `User-Agent: synapsetree-mcp/<package version>`. On calls with a JSON
  body: `Content-Type: application/json`. On `oauthToken` and
  `oauthRevoke`: `Content-Type: application/x-www-form-urlencoded` and the
  body is form-encoded. `registerAgentIdentity`, `oauthToken` send no
  `Authorization` header; `oauthRevoke` sends the key being revoked as
  bearer and as the `token` form field.
- On every operation whose contract entry `acceptsIdempotencyKey`, the
  client generates one `Idempotency-Key` (`crypto.randomUUID()`, which
  matches `^[A-Za-z0-9_-]{1,255}$`) per `call()` and reuses it on every
  retry of that call.
- Retry on: network error, 408, 429, 502, 503, 504. At most 2 retries
  (3 attempts). Wait = `Retry-After` seconds when present (integer
  seconds or HTTP-date) capped at 30 s, else `min(1000 * 2^attempt,
  8000)` plus up to 250 ms jitter. Never retry any other 4xx. Never
  retry a 5xx other than 502/503/504 (a 500 `internal` is not retried).
- Single-attempt exceptions: `registerAgentIdentity` (mints a claim and
  sends an email; no idempotency key) and `oauthToken` (each poll can
  mint the one-time key and free the claim; no idempotency key). An
  ambiguous failure on these — a network error, a stalled body, or a
  502/503/504 after the server may have committed — is surfaced, never
  blindly replayed. In the auth.md poll loop a surviving 429 is treated
  like `slow_down` (+5 s), and an `invalid_grant` after an ambiguous
  poll reports that a key may have been issued but not received.
- Timeout per request: 30 s; `ingestDocument` 120 s. Implemented with
  `AbortController`; a timeout counts as a network error for retry.
- Response handling: 2xx with JSON body → `data`; 2xx with no body
  (`oauthRevoke`) → `data` is `undefined`. Capture `Request-Id`,
  `RateLimit`, `RateLimit-Policy`, `Idempotent-Replayed`.
- Errors → `SynapseTreeError` (§5.3). problem+json (`Content-Type`
  starting `application/problem+json`) → `code`, `detail`, `status`,
  `requestId`, `retryAfterSeconds`. The API Gateway's non-problem
  `401 {"message":"Unauthorized"}` → `code: "unauthorized"`. A 403 whose
  body is not problem+json (the gateway: key unknown or revoked, or the
  database not routable) → `code: "unauthorized"` as well. Anything else
  unparseable → `code: "http_<status>"`, `detail` = first 500 chars of the
  body.
- The OAuth endpoints answer errors as RFC 6749 §5.2 JSON (`error`,
  `error_description`, optional `interval`, `error_uri`), never
  problem+json. For `oauthToken` the client returns the parsed body on 400
  as a value (`status: 400`, `data` = the body) instead of throwing,
  because the poll loop needs `authorization_pending` as a value, not an
  exception (§7). For `oauthRevoke` a 400 is thrown as a `SynapseTreeError`
  whose `code` is the body's `error`.

### 5.3 `errors.ts`

```ts
export class SynapseTreeError extends Error {
  status: number; code: string; detail?: string; requestId?: string; retryAfterSeconds?: number;
}
export function toolErrorText(err: unknown): string;   // §9 mapping; never throws
```

### 5.4 `credentials.ts`

Config directory, in order: `$SYNAPSETREE_CONFIG_DIR` if set; else
`$XDG_CONFIG_HOME/synapsetree` if `XDG_CONFIG_HOME` is set; else by
platform: macOS `~/Library/Application Support/synapsetree`, Windows
`%APPDATA%\synapsetree`, Linux and other `~/.config/synapsetree`. The
override exists so tests never touch the real directory.

Two files:

- `credentials.json`: `{ "apiKey": "stree_…", "accountId": "…" | null, "source": "dashboard" | "authmd", "obtainedAt": "<ISO 8601>" }`.
- `config.json`: `{ "namespace"?: string, "baseUrl"?: string }`.

Both written atomically: write `<name>.<random>.tmp` in the same
directory, `chmod 0600`, then `rename` over the target. The directory is
created with mode `0700`. On Windows the modes are best-effort and the
README says so. Reads tolerate a missing file (→ `null`), and a malformed
file is an error naming the path, never a silent reset.

Precedence, resolved once at process start:

| Value | 1st | 2nd | 3rd |
|---|---|---|---|
| API key | `SYNAPSETREE_API_KEY` | `credentials.json` | error: "No API key. Run `synapsetree-mcp auth --key …` or `auth --email …`." |
| Base URL | `SYNAPSETREE_BASE_URL` | `config.json.baseUrl` | `https://api.synapsetree.dev` |
| Namespace | `SYNAPSETREE_NAMESPACE` | `config.json.namespace` | none (tools that need one error, §8) |

The key is never printed after the moment it is stored. `status` shows
`stree_…` plus the last four characters only. Logs (stderr) never contain
the key, the claim token, or request bodies.

### 5.5 `authmd.ts`

The registration state machine (§7), written against the client with
injectable `sleep`, so a test runs the whole flow in milliseconds.

### 5.6 `tools/*.ts`

Each tool module exports one object:

```ts
export interface ToolDefinition<I> {
  name: string;                      // e.g. "memory_search"
  description: string;               // the text the model reads; §8 wording is verbatim
  inputSchema: z.ZodObject<…>;       // zod v4; `namespace` optional on every tool but whoami
  operation: OperationId;            // the contract operation it calls (one each)
  handler: (input: I, ctx: ToolContext) => Promise<unknown>;   // returns the JSON the tool result carries
}
export interface ToolContext { client: SynapseTreeClient; defaultNamespace?: string; }
```

`tools/index.ts` exports `TOOLS: readonly ToolDefinition[]` in the order
of the §8 table. That array is the only place tools are enumerated.

### 5.7 `server.ts`

```ts
export function createServer(ctx: ToolContext): McpServer;   // registers TOOLS, nothing else
```

Uses `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` and
`registerTool(name, { description, inputSchema }, handler)`. A handler
returns `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`
on success and `{ isError: true, content: [{ type: "text", text: toolErrorText(err) }] }`
on any throw. Handlers never let an exception escape to the SDK. The
server name is `synapsetree`, the version is the package version. No
resources, no prompts, no sampling in v1.

### 5.8 `cli.ts`

Hand-rolled argument parsing (five subcommands, no parser dependency).
`serve` connects `createServer` to `StdioServerTransport` from
`@modelcontextprotocol/sdk/server/stdio.js`. Nothing is ever written to
stdout except by the transport; all human-facing output goes to stderr,
because stdout is the MCP channel.

## 6. Commands

```
synapsetree-mcp                        # = serve
synapsetree-mcp serve                  # MCP over stdio; what the client launches
synapsetree-mcp auth --key stree_…     # store a dashboard key (the key is on argv: shell history + ps see it; prefer exporting SYNAPSETREE_API_KEY when that matters)
synapsetree-mcp auth --email you@example.com
synapsetree-mcp auth --revoke          # RFC 7009 revoke the stored key (and an exported env key), then delete it locally
synapsetree-mcp status                 # whoami + key source + base URL + namespace + rate-limit headers
synapsetree-mcp config set namespace repo:myproject
synapsetree-mcp config set base-url https://…   # for the test stage; rarely used
synapsetree-mcp --version | --help
```

Exit codes: 0 success; 1 a SynapseTree error (message on stderr); 2
usage error; 3 no credentials (including `serve` started with no key: it
prints the §5.4 message and exits 3 rather than serving tools that can
only fail). `serve` exits 0 when the transport closes.

**`auth --key`.** Validates `^stree_[A-Za-z0-9_-]{43}$` (usage error
otherwise, without echoing the value). Calls `whoami`; on success stores
the key with `source: "dashboard"` and prints the `status` summary. On
failure stores nothing and prints the error.

**`auth --email`.** §7. `--base-url` is accepted for the test stage.

**`auth --revoke`.** Revokes every credential it can see, stored key
first: `oauthRevoke` with the stored key, then — if `SYNAPSETREE_API_KEY`
is also exported — `oauthRevoke` with that key (resolveSettings prefers
the env key, so the stored one would otherwise survive the command). On
2xx for the stored key, delete `credentials.json` and say so. On a
network error or 5xx for either key, keep that credential and say the
server was unreachable; on 401 the key is already dead (nothing to
revoke — delete the file); on 403 the server refused, so the local copy
is kept and the user is told to remove it in the dashboard. The command
exits 0 when everything present was revoked or already dead, 3 when no
credential exists, 1 otherwise.

**`status`.** `whoami`, then print: key source (`env` / `file`), masked
key, `organizationId`, `tenantDatabaseId`, `scope`, `planCode`,
`subscriptionStatus`, base URL, default namespace or "(none set)", and
the `RateLimit` / `RateLimit-Policy` header values if present.

## 7. The auth.md flow (`auth --email`)

Exactly as published at `https://synapsetree.dev/auth.md`. Endpoints:
register `POST /agent/identity`, poll `POST /oauth2/token`, revoke
`POST /oauth2/revoke`, all on the API host.

1. `POST /agent/identity`, JSON `{"email": "<the human's email>"}`. No
   `assertion` is sent (the server logs and ignores them; the emailed
   link is the only identity proof). Response:
   `{"claim_token": "stclaim_…", "user_code": "NNNNNN", "poll": {"token_endpoint": "<uri>", "grant": "urn:synapsetree:claim", "interval": 5}}`.
   `403 quota_exceeded` means five claims are already outstanding for
   that email: say so and stop.
2. Print to stderr, and nothing else until the flow ends:
   "Check <email> for a SynapseTree approval link (usually within a
   minute; it expires in 15 minutes). Approve only if the page shows this
   code: NNNNNN".
3. Wait `poll.interval` seconds, then `POST` to the configured base
   URL's `/oauth2/token` as form data
   `grant_type=<poll.grant>&assertion=<claim_token>`. (The registration
   response's `poll.token_endpoint` is validated to equal
   `<base-url>/oauth2/token`; on any other value the flow fails closed
   with `invalid_response` rather than sending the claim token to a
   server-chosen host.) On each answer:
   - 200 `{"access_token": "stree_…", "token_type": "Bearer", "account_id": "…", "scope": "memory:full"}`:
     this is the only copy of the key. Store it (`source: "authmd"`,
     `accountId`) before printing anything. Then run `status` and print it.
   - 400 `authorization_pending`: wait `interval` from the body if
     present, else the current interval, and poll again.
   - 400 `slow_down`: the body's `interval` is the new interval (the
     server adds 5 s); if absent, add 5 s to the current one. Poll again.
   - 500 `server_error` or a network error: keep the current interval and
     poll again, up to the deadline.
   - 400 `invalid_grant`: stop. "The claim expired (15 minutes) or was
     already used. Run `auth --email` again."
   - 400 `key_limit_reached`, `database_name_taken`,
     `database_quota_exceeded`: print `error_description` and `error_uri`
     if present (the dashboard page where the human fixes it), then keep
     polling; the claim stays valid until it expires and the human can
     clear the problem and approve.
     *Amended 2026-11-02 (#326, `specs/auth-email-remedy-poll/spec.md`):*
     the pair is printed once per occurrence, keyed on the `error` code,
     and reprinted when the code changes or after an
     `authorization_pending`/`slow_down` answer. A body `interval` is
     adopted like `authorization_pending`. Each remedy answer adds 5 s to
     the sleep, up to +25 s (30 s at the default), reset by
     `authorization_pending`/`slow_down`. The 60 s cap and the deadline
     are unchanged.
   - anything else: stop with the body's `error` and `error_description`.
4. Deadline: 16 minutes after registration. Past it, stop with the
   `invalid_grant` message.
   *Amended 2026-11-02 (#326):* no sleep runs past the deadline; the last
   one is clamped to the time that remains. Until #326 the clamp compared
   milliseconds with seconds and never bound, so the last sleep could
   overshoot by up to 60 s.

The claim token lives in memory only: never in a file, never in a log
line, never in an error message. Ctrl-C ends the flow cleanly with a
message that the pending claim will expire on its own.

## 8. Tools

Every tool but `whoami` takes an optional `namespace`
(`^[a-z0-9][a-z0-9._:-]{0,127}$`). If omitted, the configured default is
used. If there is no default, the tool returns an error: "No namespace
configured. Run `synapsetree-mcp config set namespace repo:<name>`, or
pass `namespace`." The server never invents a namespace. The README
suggests `repo:<directory name>`.

| Tool | Operation | Scope | Input (beyond `namespace`) | Returns |
|---|---|---|---|---|
| `memory_search` | `queryMemory` | read | `query` (string, ≤4096; empty returns the most recent facts), `limit` (1–100, default 10), `excludeDrafts` (default false), `asOf` (RFC 3339) | the response verbatim: `facts`, `scores`, `tasks`, `events`, `diagnostics` |
| `memory_remember` | `rememberFact` | read_write | `title` (1–1000), `body` (1–100000), `tags` (≤100 × ≤100 chars), `confidence` (`certain`/`inferred`/`tentative`), `okfType` (string), `validFrom` | the stored fact |
| `memory_supersede` | `supersedeFact` | read_write | `factId`, `title`, `body`, `tags`, `confidence`, `validFrom` | `{ superseded, replacement }` |
| `memory_ingest` | `ingestDocument` | read_write | `sourceRef` (string, encoded by the tool), `content` (1–524288), `onDuplicateHash` (`skip`/`ingest`/`error`, default skip) | `{ chunks, ingestedChunks, failedChunks, truncated, duplicateOf, parseFailures, embeddingFailures }` |
| `memory_log_event` | `createEvent` | read_write | `eventType` (`observation`/`decision`/`action`/`outcome`), `summary` (trimmed, then 1–4000 UTF-16 units — SynapseTree ruling Q1, 2026-11-01, narrowed from 1–8000; contract refresh 2026-11-02), `relatedFactId`, `occurredAt` | the event |
| `graph_traverse` | `traverseGraph` | read | `sourceId`, `maxDepth` (1–3, default 1), `direction` (`inbound`/`outbound`/`both`), `edgeTypes` (string[]), `maxNodes` (1–200, default 20), `excludeDrafts` | `{ nodes, edges }` |
| `namespaces_list` | `listNamespaces` | read | `prefix` (≤128) | `{ namespaces: string[] }` — the tool follows `nextCursor` with `limit=100` until `hasMore` is false or 500 names are collected, then stops and sets `truncated: true` |
| `whoami` | `whoami` | read | — | `{ apiKeyId, organizationId, tenantDatabaseId, scope, planCode, subscriptionStatus }` |

Request bodies the tools send (these are what the contract guard checks):

- `memory_search` → `{ namespaces: [namespace], query, limit, excludeDrafts, asOf }` (undefined omitted). Never `queryEmbedding`, `hybridWeight`, `weights`, `floors`, `tokenBudget`.
- `memory_remember` → `{ namespace, title, body, tags, confidence, sourceType: "user_stated", okfType, validFrom }`. `sourceType` is always `user_stated`: the agent speaks for the human who approved it; `user_confirmed` is not something an agent can claim. Never `embedding`.
- `memory_supersede` → path `factId`; body `{ namespace, validFrom, replacement: { kind: "new", title, body, tags, confidence, sourceType: "user_stated" } }`. The `kind: "existing"` branch is not exposed.
- `memory_ingest` → `{ mode: "server_extraction", namespace, sourceRef, sourceHash, content, onDuplicateHash }`. `sourceHash` = lowercase hex SHA-256 of the UTF-8 bytes of `content`, computed by the tool. `sourceRef` is the input with every `/` replaced by `__`, then validated against `^[A-Za-z0-9._\- ]{1,255}$` (error if it still does not match, naming the offending characters). Never `chunking`, never `client_extraction`.
- `memory_log_event` → `{ namespace, eventType, summary, relatedFactId, occurredAt }`.
- `graph_traverse` → `{ namespace, sourceId, maxDepth, direction, edgeTypes, maxNodes, excludeDrafts }`.
- `namespaces_list` → query `prefix`, `limit`, `after`.

Descriptions the model reads. These sentences go into the tool
descriptions verbatim:

- `memory_search`: "Search the user's SynapseTree memory. Semantic search
  needs an embeddings provider registered by the account owner in the
  dashboard; without one this is keyword search and
  `diagnostics.keyword_only` says so. That is normal, not an error."
- `memory_remember`: "Store one fact the user decided or you observed.
  Works with no provider registered. Use `memory_ingest` for a whole
  document."
- `memory_supersede`: "Replace a fact with a corrected one and keep the
  old one in history. Never deletes."
- `memory_ingest`: "Store a whole document; SynapseTree extracts the
  facts. Requires the account owner to have registered an extraction
  provider in the dashboard (bring-your-own-key). Otherwise the server
  answers `inference_not_configured`; tell the user to register a provider
  at https://synapsetree.dev/dashboard."
- `memory_log_event`: "Record that something happened: an observation,
  decision, action, or outcome, optionally tied to a fact."
- `graph_traverse`: "Walk the knowledge graph from a fact or node id, up
  to three hops."
- `namespaces_list`: "List the namespaces in the user's database,
  optionally by prefix."
- `whoami`: "Show which SynapseTree account, database, scope, and plan
  this server is using."

**Not exposed, by ruling D3 (R5):** `exportMemory`, `importMemory`,
`forgetFact`, `forgetSource`, `deleteNamespace`, `createMaintenanceRun`,
`putOntology`. They are absent from the vendored contract and the guard
test asserts that (§10.2). Deferred until demand, not by ruling:
`upsertGraph`, `getOntology`, drafts, sources, extraction plans,
`lintNamespace`, `getFactHistory`.

## 9. Error surfaces

Tool errors are MCP tool results with `isError: true` and one paragraph
the model can act on. `toolErrorText` maps:

| Condition | Text |
|---|---|
| `unauthorized` (gateway 401, gateway 403, or app 401) | "SynapseTree rejected the stored API key (revoked, unknown, or its database is not reachable). Ask the user to run `synapsetree-mcp auth`." |
| `insufficient_scope` | "This key cannot do that. The account owner does it in the dashboard at https://synapsetree.dev/dashboard." |
| `subscription_inactive` | "The organization's SynapseTree plan is paused. Reads and export still work in the dashboard." |
| `inference_not_configured` | the `memory_ingest` description sentence |
| `upstream_inference_unavailable` | "The account owner's inference provider is failing; searches fall back to keywords. Retry ingest later." |
| `rate_limited` | "Rate limited by SynapseTree; retry after N seconds." (N from `retryAfterSeconds` or `Retry-After`, else "a few") |
| `not_implemented` | "SynapseTree has not enabled this operation yet (501). Tell the user; nothing to fix locally." |
| `quota_exceeded`, `payload_too_large`, `invalid_request`, `not_found`, `conflict`, `invalid_state`, `source_hash_conflict`, `idempotency_key_reused`, `ontology_violation` | `code` + ": " + `detail` verbatim |
| `namespace_busy`, `fenced`, `unavailable`, `idempotency_in_progress` | "SynapseTree is temporarily unavailable; retry in a few seconds." |
| no namespace | the §8 sentence |
| zod validation failure | the SDK validates `inputSchema` before the handler runs and answers an invalid-params protocol error listing the issues; the handler's own `parse` is a fallback that produces the issue list, one per line |
| anything else | `code` + ": " + `detail`, status, and `requestId` |

Every text ends with "(request-id: …)" when the response carried one.

## 10. The vendored contract

### 10.1 The file

`contract/synapsetree-openapi.subset.json` is generated in the SynapseTree
repo by `scripts/mcp-contract-subset.py` from its `openapi/openapi.yaml`
and committed here. It holds exactly the eleven operations of §5.1
(`info.x-operations` lists them) and the components they reference
transitively — at generation time 63 schemas, 15 responses, 6 headers, 4
parameters. It is never hand-edited; `info.x-generated-by` says so.
Regeneration is a SynapseTree-side task; a PR here that updates the file
is a `chore(mcp-server): refresh contract` and must pass the guards.

### 10.2 Guards (unit tests, always on)

1. **Request fidelity.** For every tool, with a recording `fetch`, call
   the handler with a full input and assert: the method and path match
   the operation; every top-level body property and query parameter the
   client sent is in the operation's `requestProperties` /
   `queryParameters`; every `requiredProperties` entry is present;
   `Idempotency-Key` is present exactly when `acceptsIdempotencyKey`.
2. **Exactly eight.** `TOOLS.map(t => t.name)` equals the §8 list in
   order, and `tools/list` over an in-memory transport returns the same
   eight names and nothing else.
3. **D3 absence.** The subset's full text contains none of the seven
   withheld operationIds, and `info.x-operations` equals the eleven
   expected ids. A regenerated contract that widened would fail here
   before any client code could use it.

## 11. Data flow

```
 developer's machine                                  Equational Applications
 ┌─────────────────────────┐   stdio    ┌──────────────────┐   HTTPS   ┌────────────────────────┐
 │ MCP client (Claude Code)│◄──────────►│ synapsetree-mcp  │──────────►│ api.synapsetree.dev    │
 │                         │ tools/call │  serve           │ Bearer    │  gateway (presence)    │
 └─────────────────────────┘            │  ├─ tools (8)    │ stree_…   │  authorizer → tenant db│
                                        │  ├─ client.ts    │           │  pool (engine)         │
                                        │  └─ credentials  │           └────────────────────────┘
                                        │     (0600 file)  │
                                        └──────────────────┘
 one-time:  synapsetree-mcp auth --email ──► POST /agent/identity ──► email ──► human approves
                                      ◄── poll /oauth2/token ◄── one stree_ key, stored
```

The MCP client never sees the key. Concurrency: several clients may run
the server at once; the credentials file is read at startup only and
written atomically, so `auth` and `serve` cannot corrupt it. A key
revoked mid-session surfaces as the `unauthorized` tool error on the next
call; the server keeps running and the client decides.

## 12. Testing

Runner: vitest, `pnpm --filter @equationalapplications/mcp-server test`;
CI runs `pnpm run build` before `pnpm test`, so tests may use `dist/`.

### 12.1 Unit (mocked `fetch`, no network, no real config dir)

- `client`: URL building with path and query params; headers; form
  encoding for the OAuth operations; `Idempotency-Key` present only where
  the contract allows and identical across retries of one call; retry on
  408/429/502/503/504 and network error with `Retry-After` honored (both
  forms); no retry on 400, 401, 403, 404, 409, 413, 422, 500; max 3
  attempts; timeout via `AbortController`; problem+json → typed error;
  gateway 401 and non-problem 403 → `unauthorized`; `RateLimit*`,
  `Request-Id`, `Idempotent-Replayed` captured.
- `errors`: every row of §9 produces its text; request id appended.
- `credentials`: directory resolution per platform and env override;
  atomic write (temp then rename, mode 0600 on POSIX); precedence table;
  malformed file → error naming the path; missing → null; key never in
  `status` output beyond the last four characters.
- `authmd`: scripted response sequences for each §7 branch:
  pending→pending→200; `slow_down` raises the interval; `invalid_grant`
  stops; each remedy code keeps polling (*amended 2026-11-02, #326:* a
  persisting remedy prints once and its sleeps never decrease while the
  server's stated interval holds; a remedy body that lowers `interval`
  may lower the sleep, but the backoff itself never shrinks until
  `authorization_pending` or `slow_down` resets it; plus the code-change,
  clear-and-recur, transient-error, server-interval and deadline cases
  of `specs/auth-email-remedy-poll/spec.md` §8, and a sleep that never
  passes the deadline); `server_error` and a network
  error keep polling; deadline stops; the key is stored before any
  output; the claim token appears in no log or error string.
- `tools`: every tool's happy path (input → request body/query →
  response → result), the `sourceHash` and `sourceRef` rules for
  `memory_ingest`, `namespaces_list` paging and the 500 cap, zod rejection
  of out-of-range inputs, the no-namespace error, and one mapped problem
  code per tool.
- `contract` guards: §10.2.
- `server`: over `InMemoryTransport.createLinkedPair()` with the SDK
  `Client`: `tools/list` returns the eight; `tools/call` on `whoami`
  returns the JSON text; a handler throw becomes `isError: true` with the
  mapped text, not a protocol error.
- `cli`: argument parsing (each command, `--help`, `--version`, bad
  input → exit 2); `auth --key` rejects a malformed key without echoing
  it; stdout stays empty for every command but `serve`.
- `stdio`: spawn `node dist/cli.js serve` with `SYNAPSETREE_API_KEY=stree_<43 x>`
  and a fake base URL, connect an SDK `Client` over
  `StdioClientTransport`, assert `tools/list`. Proves the shebang, the
  CommonJS bin, and the transport wiring.

### 12.2 Integration (skipped unless both env vars are set)

`__tests__/live.integration.test.ts` runs only when `SYNAPSETREE_API_KEY`
and `SYNAPSETREE_BASE_URL` are set, otherwise `describe.skip`. Chain:
`whoami` → `memory_remember` (a unique title) → `memory_search` finds it →
`memory_supersede` → `memory_search` returns the replacement →
`memory_log_event` → `namespaces_list` contains the namespace. Namespace
`repo:mcp-server-live-<run id>`.

### 12.3 Manual, before release (gate G4)

Kurt runs, against the test stage, with a dashboard key:
`synapsetree-mcp auth --key …`, `status`, then the §12.2 chain via
`SYNAPSETREE_API_KEY=… SYNAPSETREE_BASE_URL=… pnpm --filter … test`, then
`npx @modelcontextprotocol/inspector synapsetree-mcp` and a `memory_search`
from the inspector. Then `auth --email` once against the test stage, approving
the email, and `auth --revoke`. The README's release checklist lists these
steps. (At rev 1, before G1 closed, the chain stopped at
`memory_remember` with 501; since 2026-11-02 the whole chain must pass.)

## 13. README

`packages/mcp-server/README.md`, in the repo's package README form
(title, one line, badges, link bar, sections, ecosystem table, footer):

1. **What it is** — three sentences from §1.
2. **Install** — `npm install -g @equationalapplications/mcp-server`;
   Node 20+. One command, `synapsetree-mcp` (§4, ruling D2).
3. **Get a key** — two paths (R3): the dashboard
   (`https://synapsetree.dev/dashboard` → API keys → issue → `auth --key`)
   and `auth --email` with what to expect (the code, the email, the
   15-minute window).
4. **Set a namespace** — `config set namespace repo:<name>`; why it is
   required.
5. **Connect your client** —
   `claude mcp add synapsetree -- synapsetree-mcp`; JSON for
   `.cursor/mcp.json`, Windsurf's `mcp_config.json`, and Claude Desktop's
   `claude_desktop_config.json`, all `{ "command": "synapsetree-mcp" }`.
6. **Tools** — the §8 table, one line each, plus the provider notes.
7. **Environment variables** — `SYNAPSETREE_API_KEY`, `SYNAPSETREE_BASE_URL`,
   `SYNAPSETREE_NAMESPACE`, `SYNAPSETREE_CONFIG_DIR`, and where the files live
   per platform, including the Windows mode caveat.
8. **What it never does** — R5 in plain words: no export, no delete, no
   maintenance; the dashboard does those. No key ever printed. Nothing
   runs in the cloud.
9. **Verify** — `synapsetree-mcp status` and the inspector command.
10. **Release checklist** (maintainers) — §12.3.
11. **Monorepo Ecosystem** table and footer, as the siblings.

## 14. Out of scope (v1)

- `install <harness>` helpers that edit client config files; hooks,
  skills, or session-start memory injection. After the server exists.
- Client-side extraction (`client_extraction`), extraction plans, drafts,
  sources, ontology, graph upsert, fact history, lint (deferred, §8).
- A `--scope` flag or per-tool permissions: one scope exists.
- Any ninth tool (R4).
- HTTP or SSE transports: stdio only.
- Telemetry of any kind.

## 15. Open questions (defaulted; the build does not wait)

1. `memory_search.excludeDrafts` default. Default: `false`, the contract's
   default; the model can pass `true`.
2. Whether `status` should also print the `RateLimit-Policy` window in
   words. Default: print the raw header values.
3. SynapseTree-side follow-up, not this repo: a smoke test there that
   installs the published package and runs `whoami`, `memory_remember`,
   `memory_search` against the test stage on every SynapseTree release.
   Until it exists, §12.3 is the drift check.

## 16. Self-review record

- No placeholder sections remain; every command, file, header, retry
  rule, and error text is stated once.
- The tool table, the request-body list, and the guard tests name the
  same eleven operations as `contract.ts` and the generator script.
- Scope is one package and three one-line repo edits: one implementation
  plan.
- Ambiguities resolved explicitly: Windows file modes (best-effort),
  `namespaces_list` cap (500, `truncated` flag), retry set (listed
  statuses only), `auth --revoke` on an already-dead key (delete locally),
  `sourceType` (always `user_stated`), `replacement.kind` (always `new`).
