# Design: `google_search` Built-In Tool Support in `core-llm-tools`

**Status:** Implemented
**Package:** `@equationalapplications/core-llm-tools`
**Date:** 2026-06-18

## Problem

`core-llm-tools` models tools as `AgentToolManifest { name, scope, schema }`, where `schema`
is a Gemini function-declaration (`name`, `description`, `parameters`) that the *consumer*
implements and executes. Gemini's `google_search` tool (Search grounding,
https://ai.google.dev/gemini-api/docs/google-search) is a different kind of tool: it is
declared in the `tools[]` array as `{ google_search: {} }`, has no parameters, and is executed
server-side by Google — there is no client-side handler to write. The current manifest shape
and `buildAuthorizedSchemaArray` injector have no way to represent or emit this.

## Goals

- Let `google_search` be declared as a manifest and flow through the existing
  scope-authorization model (`buildAuthorizedSchemaArray`'s capability filtering), without
  inventing a parallel system.
- No breaking change to the current `AgentToolManifest` / `AgentToolSchema` /
  `buildAuthorizedSchemaArray` contract — existing consumers (e.g. Clanker's `generateReply`)
  must keep compiling and behaving identically.
- Design the manifest shape so future built-in tools (e.g. `code_execution`) can be added later
  without another breaking change.

## Non-Goals

- Parsing or typing Gemini's response-side `groundingMetadata` (`webSearchQueries`,
  `groundingChunks`, `groundingSupports`, `searchEntryPoint`). That is response handling, lives
  in the calling backend (Clanker's `generateReply`), and has no dependency on this package's
  request-side tool declarations.
- Backend wiring in Clanker. Out of scope for this repo/package.

## Design

### 1. Manifest types (`packages/core-llm-tools/src/types.ts`)

Split `AgentToolManifest` into a discriminated union. The function-declaration variant's `kind`
field is **optional** so every existing manifest literal (no `kind` field) still type-checks
unchanged:

```ts
export type BuiltInToolName = 'google_search';

export interface FunctionToolManifest {
  name: string;
  scope: AgentScope;
  kind?: 'function';
  schema: AgentToolSchema;
}

export interface BuiltInToolManifest {
  name: string;
  scope: AgentScope;
  kind: 'built_in';
  builtIn: BuiltInToolName;
}

export type AgentToolManifest = FunctionToolManifest | BuiltInToolManifest;
```

`AgentToolSchema` is unchanged.

### 2. New manifest (`packages/core-llm-tools/src/manifests/core.ts`)

```ts
export const googleSearchManifest: BuiltInToolManifest = {
  name: 'google_search',
  scope: 'core',
  kind: 'built_in',
  builtIn: 'google_search',
};
```

Scope is `'core'`: grounding/search isn't a sensitive personal-data capability like
`calendar:read` or `messages:send`, and the draft guidance calls for a Core-tier manifest. It is
always injected, matching `get_current_time` / `escalate_to_cloud_agent`.

### 3. Injector (`packages/core-llm-tools/src/injector.ts`)

`buildAuthorizedSchemaArray` is kept **exactly as-is** (still function-declarations only) but
gets a `@deprecated` JSDoc pointing at the new function — non-breaking, IDE-visible migration
hint.

New function returns the full Gemini `tools[]` array, mixing one `functionDeclarations` group
with one entry per authorized built-in tool:

```ts
export type GeminiToolEntry =
  | { functionDeclarations: AgentToolSchema[] }
  | { [K in BuiltInToolName]: Record<string, never> };

export function buildAuthorizedToolsArray(
  availableManifests: AgentToolManifest[],
  userGrantedScopes: string[]
): GeminiToolEntry[] {
  const authorized = availableManifests.filter(
    (m) => m.scope === 'core' || userGrantedScopes.includes(m.scope)
  );

  const entries: GeminiToolEntry[] = [];

  const fnSchemas = authorized
    .filter((m): m is FunctionToolManifest => m.kind !== 'built_in')
    .map((m) => m.schema);
  if (fnSchemas.length > 0) entries.push({ functionDeclarations: fnSchemas });

  for (const m of authorized) {
    if (m.kind === 'built_in') {
      entries.push({ [m.builtIn]: {} } as GeminiToolEntry);
    }
  }

  return entries;
}
```

The `functionDeclarations` group is omitted entirely when no function manifests are authorized,
keeping the payload minimal.

### 4. Exports (`packages/core-llm-tools/src/index.ts`)

Add: `FunctionToolManifest`, `BuiltInToolManifest`, `BuiltInToolName`, `GeminiToolEntry`,
`buildAuthorizedToolsArray`, `googleSearchManifest`.

### 5. Tests (`packages/core-llm-tools/__tests__/`)

- Old function-only manifest literal (no `kind` field) still authorizes/filters correctly
  through both `buildAuthorizedSchemaArray` and `buildAuthorizedToolsArray`.
- `buildAuthorizedToolsArray` with a mix of function + built-in manifests produces a two-entry
  array (`functionDeclarations` + `google_search`).
- Zero authorized function manifests → `functionDeclarations` entry omitted.
- Zero authorized built-in manifests → no built-in entries in output.
- `googleSearchManifest` (scope `'core'`) is included regardless of `userGrantedScopes`.
- A manifest passed with `kind: undefined` explicitly (rather than omitted) still routes to the
  function-declarations branch (filter predicate is `m.kind !== 'built_in'`, not a truthiness
  check) — confirms the fallback narrowing is robust either way the field is absent.

### 6. Documentation (`packages/core-llm-tools/README.md`)

Add a "Built-In Tools (Grounding)" section under Quick Start showing `googleSearchManifest` +
`buildAuthorizedToolsArray` wired into a `generateContent` call, with a one-line note that
parsing `groundingMetadata` for citations is the caller's responsibility.

### 7. Versioning

Semver-minor (no breaking changes): `4.11.0` → `4.12.0` for `core-llm-tools`.

## Implementation Notes

- **Dynamic key assertion:** `entries.push({ [m.builtIn]: {} } as GeminiToolEntry)` needs the
  `as` cast because TS can't statically map a runtime string (`m.builtIn`) to a computed key in
  a mapped union type. This is safe only because `m.builtIn` is typed as `BuiltInToolName`
  (currently the single literal `'google_search'`) — never widen that field to `string` without
  re-deriving the cast's safety.
- **Future built-in parameters:** today every built-in tool's payload is `{}`. If Google ships a
  built-in tool that takes config (e.g. a hypothetical `{ code_execution: { timeout: 5000 } }`),
  extend `BuiltInToolManifest` with an optional `config?: Record<string, unknown>` and have the
  injector spread it in (`{ [m.builtIn]: m.config ?? {} }`). Not needed now — YAGNI until a
  second built-in tool with parameters actually exists.

## Testing Strategy

Unit tests only (`vitest run` in `packages/core-llm-tools`) — this package is pure, dependency-free
schema/filtering logic with no I/O, consistent with its existing test suite.

## Open Questions

None — all resolved during brainstorming (manifest shape, injector API, scope assignment).
