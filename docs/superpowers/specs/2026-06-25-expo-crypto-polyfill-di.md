# Crypto Polyfill DI — Dependency Injection for Hermes/RN Random Source

**Date:** 2026-06-25  
**Status:** Implemented  
**Branch:** `fix/expo-crypto-polyfill`  
**Packages:** `@equationalapplications/core-llm-wiki`, `@equationalapplications/expo-llm-wiki`

## Problem

React Native / Hermes runtime lacks the Web `crypto` global API (`crypto.randomUUID`, `crypto.getRandomValues`). Library code in `core-llm-wiki` calls `generateId()` which depends on these APIs to produce cryptographically secure record IDs.

**Impact:**
- Dev client: wiki writes fail silently (swallowed in fire-and-forget `.catch`)
- Production: same silent failure — memory records never persist
- Error: `"generateId: no cryptographically secure random source available"`

`expo-crypto` provides a native, secure implementation, but the library had no way to inject it.

## Solution

**Dependency Injection pattern:** `core-llm-wiki` accepts an optional injectable random source; `expo-llm-wiki` wires it at module load.

### Changes

#### `packages/core/src/utils/ids.ts`

- Added `configureRandomSource(fn)` function — registers a fallback `getRandomValues` implementation
- Modified `generateId()` resolution order:
  1. `crypto.randomUUID()` (web / Node 19+)
  2. `crypto.getRandomValues()` (web / Node / polyfilled global)
  3. **NEW:** Injected source via `configureRandomSource()` (expo-crypto on RN)
  4. Throw if none available

- No behavioral change on web or Node — injected source is checked last, global `crypto` wins when available

#### `packages/core/src/index.ts`

- Export `configureRandomSource` for platforms to inject their implementation

#### `packages/expo/src/factory.ts` + `packages/expo/src/index.ts`

- Import `getRandomValues` from `expo-crypto` at module top
- Call `configureRandomSource(getRandomValues)` as side effect — runs once on first import, before any `generateId()` call
- Comment explains why (platform initialization, runs before consumers)

#### `packages/expo/package.json`

- Added `expo-crypto: >=12` as **peer dependency** (consumers must install)
- Added `expo-crypto: ^56.0.4` as **dev dependency** (for type checking / testing)

## Why This Design

**Injection over global mutation:** Avoids conflicts with tests or other polyfills. `configureRandomSource()` is explicit and testable.

**Side-effect import:** Module load (not function call) ensures crypto is wired before any `generateId()` runs. Safe under bundlers.

**Peer + dev dep:** Peer dep signals the runtime requirement; dev dep allows the package to build/test independently.

**Last in resolution order:** Web/Node users see no change. RN gets fallback when needed.

## Testing

- Core: 662 tests pass (includes `generateId` usage across services)
- Type checking: expo package typechecks cleanly after build
- Dev client: wiki writes no longer throw; memory persists

## Migration

**For consumers:**
- After release (v4.17.1): No changes needed — `expo-llm-wiki` handles it automatically
- Interim (v4.17.0): Apps using `expo-llm-wiki` on RN must polyfill `globalThis.crypto.getRandomValues` themselves (or upgrade)

**For `@equationalapplications/clanker`:**
- Kept `src/polyfills/crypto.ts` for v4.17.0 compatibility
- Can be removed once v4.17.1 ships

## Alternatives Considered

1. **Side-effect global polyfill in core** — pollutes global namespace, breaks imports in test environments
2. **Constructor injection (thread through every class)** — verbose, invasive to existing APIs
3. **Factory method taking random source** — doesn't work; `generateId()` is a leaf utility, used everywhere

Selected approach (DI via `configureRandomSource()`) balances clarity, invasiveness, and testability.
