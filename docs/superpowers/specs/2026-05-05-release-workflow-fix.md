# Release Workflow Fix — Design Spec

**Date:** 2026-05-05
**Branch:** feat/integration-test-coverage (or a dedicated fix branch off main)
**Status:** Implemented
**Implemented in:** This PR (lockfile regenerated and root publish removed)

---

## Problem

The `Release` workflow (`.github/workflows/release.yml`) fails on every push to `main` due to two independent bugs.

### Bug 1 — Lockfile mismatch (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`)

`pnpm install --frozen-lockfile` fails in CI with:

```
ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed with the frozen installation.
The current "overrides" configuration doesn't match the value found in the lockfile.
```

Root `package.json` has:
```json
"pnpm": {
  "overrides": {
    "react": "19.2.5",
    "react-dom": "19.2.5",
    "tar": "^7.5.13"
  }
}
```

The `tar` override was added for security hardening but `pnpm-lock.yaml` was never regenerated to record it. Every CI run with `--frozen-lockfile` fails until the lockfile is updated.

### Bug 2 — Workflow publishes the private root package

Workflow line 100:
```bash
publish_if_needed "./package.json" pnpm publish --no-git-checks --access public
```

Root `package.json` has `"private": true`. `pnpm publish` on a private package exits with an error. The root package is explicitly described as a "Private workspace root" — it is not intended for publication.

---

## Goals

1. `pnpm install --frozen-lockfile` passes in CI.
2. The release workflow publishes only the three sub-packages (`core`, `expo`, `react`) and ignores the root workspace.
3. No change to the semantic-release configuration or the sub-package publish logic.

---

## Fix

### Fix 1 — Regenerate lockfile

Run locally (once):

```bash
pnpm install --no-frozen-lockfile
```

Commit the updated `pnpm-lock.yaml`. CI will now pass `--frozen-lockfile` because the lockfile reflects the `tar` override.

### Fix 2 — Remove root package from publish step

Delete the last `publish_if_needed` call in the `Publish all packages` step of `.github/workflows/release.yml`:

```diff
-         publish_if_needed "./package.json" pnpm publish --no-git-checks --access public
```

The three sub-package calls above it are unchanged.

---

## What Is Not Changing

- Semantic-release configuration and bump logic.
- The `publish_if_needed` helper function.
- Sub-package publish calls for `core`, `expo`, `react`.
- The `pnpm.overrides` values in root `package.json` — they are correct; only the lockfile was stale.
- Root `package.json` `"private": true` — this is correct and stays.

---

## Verification

After both fixes are applied and pushed to `main`:

1. CI `pnpm install --frozen-lockfile` passes without the lockfile config mismatch error.
2. The `Publish all packages` step succeeds (or correctly skips already-published versions) without attempting to publish the root package.
3. No new npm package named `expo-llm-wiki` (the root name) is published.
