# Warn 7.x hosts about the 8.0.0 default changes

**Status:** Draft
**Date:** 2026-11-09
**Branch:** `feat/upgrade-warning-7-18`
**Source baseline:** `a4968b7f` (main after PR #341)
**Intent check:** INTENT rule 7 forbids flipping the ops-librarian or deferred-maintenance defaults before an explicit 8.0.0 ruling. This spec flips nothing: 7.x keeps `'legacy'` and `'auto'`. The warning serves the same rule's "no invisible spend" reasoning, in the other direction: a host should not lose maintenance on upgrade without being told. No INTENT amendment is needed.

**Delivery:** one PR, draft until implemented, per `specs/README.md`. Commit type `feat(core):`, so semantic-release cuts 7.18.0. Nobody edits `CHANGELOG.md` or any `"version"` field.

---

## 1. Problem

The owner ruled on 2026-11-09 that 8.0.0 changes two defaults (draft PR #342):

| Option | 7.x default | 8.0.0 default |
|---|---|---|
| `librarian.strategy` | `'legacy'` | `'ops'` |
| `maintenance` | `'auto'` | `'deferred'` |

A host that sets neither option changes behavior silently when it upgrades. Under `'deferred'`, `write()` never evaluates the auto-run thresholds, so nothing runs until the host calls maintenance itself. Two of this organization's own hosts were found in that position (clanker `wikiService.ts`, since pinned by clanker #905, and curated-thoughts `makeWikiOptions`).

Issue #324 also requires at least one minor release between the release that added the canonical tool names (7.17.0) and the removal in 8.0.0. Only patches have followed 7.17.0. Advance notice of the upgrade is what that waiting period is for, so this feature is what ships in the minor.

## 2. Change

At `WikiMemory` construction, after `tablePrefix` validation:

1. Treat `config.librarian.strategy` and `config.maintenance` as unset when they are `undefined`. A `librarian` object with only `gate` still leaves the strategy unset.
2. If either is unset, log one `console.warn` that:
   - names the unset option or options and each one's 8.0.0 default;
   - when `maintenance` is unset, says that under `'deferred'` the auto-run thresholds stop applying and nothing runs until the host calls `runPendingMaintenance()`;
   - says how to keep today's behavior by setting the unset options explicitly (`librarian: { strategy: 'legacy' }`, `maintenance: 'auto'`).
3. Log each distinct message at most once per process, so repeated constructions (one wiki per entity, per request, or per test) do not repeat it.
4. A host that sets both options gets no warning.

Nothing else changes: resolved defaults, `write()`, the librarian, and maintenance behave as before.

`console.warn` writes to stderr on Node, so a stdio MCP host's stdout stays clean.

## 3. Files touched

- `packages/core/src/utils/upgradeNotice.ts` (new): message construction and the once-per-process guard.
- `packages/core/src/WikiMemory.ts`: one import, one constructor call.
- `packages/core/__tests__/upgradeNotice.test.ts` (new).
- `apps/docs/src/content/docs/reference/configuration.md`: short note under Maintenance.

The new file is deliberately not `utils/engineDefaults.ts`, which #342 adds, so #342 rebases without an add/add conflict. #342 deletes this file and its call when it ships, because the sentence "8.0.0 changes" stops being true.

## 4. Test plan

- Message contents for unset, each partially-set case, and both-set (no message).
- `librarian: { gate: ... }` without a strategy counts as unset.
- Constructing `WikiMemory` with nothing set warns once, and a second construction does not warn again.
- A different message (a different unset combination) still warns in the same process.
- Defaults stay frozen: nothing about the 7.x resolved strategy or maintenance mode changes (existing suites).

Verification: build, typecheck, `pnpm test`.
