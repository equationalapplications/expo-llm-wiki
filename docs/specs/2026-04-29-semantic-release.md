# Spec: Semantic Release

**Date:** 2026-04-29  
**Status:** Draft

---

## Problem

`package.json` currently has `"version": "1.0.0"` hardcoded. Publishing to npm requires a manual `npm version` bump and `npm publish`, with no changelog, no GitHub release, and no enforcement that version bumps match the conventional commit history.

---

## Solution

Add `semantic-release` driven by the existing conventional commit history. On every push to `main`, a GitHub Actions workflow builds the package, runs semantic-release, and publishes to npm automatically if the commits since the last release warrant a version bump.

---

## Version Bump Rules

semantic-release maps conventional commit types to SemVer increments:

| Commit type | Version bump |
|---|---|
| `fix`, `perf` | patch (`1.0.0` → `1.0.1`) |
| `feat` | minor (`1.0.0` → `1.1.0`) |
| `feat!`, `fix!`, or `BREAKING CHANGE:` footer | major (`1.0.0` → `2.0.0`) |
| `chore`, `docs`, `style`, `test`, `build`, `ci` | no release |

---

## Plugins

| Plugin | Role |
|---|---|
| `@semantic-release/commit-analyzer` | Reads commits since last tag, determines bump type |
| `@semantic-release/release-notes-generator` | Generates human-readable changelog from commits |
| `@semantic-release/changelog` | Writes/updates `CHANGELOG.md` in the repo |
| `@semantic-release/npm` | Bumps `package.json` version and runs `npm publish` |
| `@semantic-release/github` | Creates a GitHub release with the generated notes |
| `@semantic-release/git` | Commits the updated `CHANGELOG.md` and `package.json` back to `main` |

---

## New Files

| File | Purpose |
|---|---|
| `.releaserc.json` | semantic-release config (plugins, branch) |
| `.github/workflows/release.yml` | GitHub Actions workflow |

---

## `.releaserc.json`

```json
{
  "branches": ["main"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/changelog", {
      "changelogFile": "CHANGELOG.md"
    }],
    ["@semantic-release/npm", {
      "npmPublish": true
    }],
    "@semantic-release/github",
    ["@semantic-release/git", {
      "assets": ["CHANGELOG.md", "package.json"],
      "message": "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
    }]
  ]
}
```

The `[skip ci]` trailer on the release commit prevents the release workflow from re-triggering itself.

---

## GitHub Actions Workflow

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write      # create GitHub release, push release commit
  issues: write        # comment on issues resolved by release
  pull-requests: write # comment on PRs resolved by release
  id-token: write      # npm provenance

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # full history required for commit analysis
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org

      - run: npm ci

      - run: npm run build

      - run: npx semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`fetch-depth: 0` is required — semantic-release reads the full git history to find the previous release tag.

`persist-credentials: false` combined with `GITHUB_TOKEN` lets semantic-release push the release commit using the token directly, avoiding permission conflicts.

---

## package.json Changes

### Add `files` field

Control exactly what is published to npm. Without it, `src/`, `docs/`, and `.github/` would be included.

```json
"files": [
  "dist",
  "LICENSE",
  "README.md"
]
```

### Add devDependencies

```json
"@semantic-release/changelog": "^6.0.0",
"@semantic-release/git": "^10.0.0",
"semantic-release": "^24.0.0"
```

The other five plugins (`commit-analyzer`, `release-notes-generator`, `npm`, `github`) are bundled with `semantic-release` and don't need separate installation.

### Remove hardcoded version

semantic-release writes the version on each release. The value in `package.json` at rest doesn't matter, but `"version": "0.0.0-development"` is a conventional placeholder that signals the field is managed automatically.

---

## Required GitHub Secret

Add `NPM_TOKEN` to the repository's Actions secrets:

1. Generate at npmjs.com → Access Tokens → Granular Access Token (publish to `expo-llm-wiki` only).
2. Add to GitHub: Settings → Secrets and variables → Actions → `NPM_TOKEN`.

`GITHUB_TOKEN` is provided automatically by GitHub Actions — no setup needed.

---

## Initial Release

The first `npx semantic-release` run on `main` will:
1. Find no previous release tag.
2. Analyze all commits since the repo was created.
3. The `feat:` initial commit qualifies as a minor bump — releasing `1.0.0` (semantic-release treats the absence of a prior tag as starting from `0.0.0`).

To avoid a surprise `1.0.0` release on the first run if the repo is not yet ready to publish, tag the current commit manually before merging:

```bash
git tag v1.0.0
git push origin v1.0.0
```

This anchors the history and the next release will be computed from commits after that tag.

---

## What Does NOT Change

- `tsup` build config — unchanged
- Conventional commit format already in use — no changes needed
- Branch strategy — `main` is the single release branch
