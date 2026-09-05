import type { AgentScope } from './types';

/**
 * Scopes that are ALWAYS authorized, with no user grant required.
 *
 * Single source of truth: tool *injection* (buildAuthorizedToolsArray) and tool
 * *execution* (scopelab's function-caller) must agree on this list. Never write
 * the 'core' literal in scope-check code.
 *
 * `satisfies readonly AgentScope[]` makes drift from the AgentScope union a
 * compile error.
 */
// Object.freeze, not just `as const`: the latter is compile-time only, so a JS
// consumer (or TS via `any`) could push() at runtime and silently widen
// always-on authorization for every downstream check in the process.
export const AUTHORIZED_SCOPES = Object.freeze(['core'] as const) satisfies readonly AgentScope[];

export type AuthorizedScope = (typeof AUTHORIZED_SCOPES)[number];

/**
 * Fail-closed guard: true only for always-on scopes.
 *
 * The `as readonly string[]` cast is required — TypeScript's `.includes()` on a
 * `readonly ['core']` tuple demands a `'core'` argument, but callers pass the
 * wider `AgentScope` / `string`.
 */
export function isAuthorizedScope(scope: string): scope is AuthorizedScope {
  return (AUTHORIZED_SCOPES as readonly string[]).includes(scope);
}
