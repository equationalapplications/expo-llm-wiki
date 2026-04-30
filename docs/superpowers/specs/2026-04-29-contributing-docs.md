# Spec: Contributing Documentation

**Date:** 2026-04-29  
**Status:** Implemented

---

## Problem

The repo has no contribution guide. A developer who finds the package on npm and wants to open a PR has no information on: how to set up the project locally, what branch strategy to follow, how to format commits, or what the PR bar is.

---

## New Files

| File | Purpose |
|---|---|
| `CONTRIBUTING.md` | Single root file — all contribution docs inline |

`CONTRIBUTING.md` lives at the repo root so GitHub surfaces it automatically on the "New issue" and "New PR" pages.

---

## `CONTRIBUTING.md`

All sections inline. No sub-pages.

---

## Development Setup

**Prerequisites**
- Node.js 24+ (current LTS)
- An Expo project to test against (the package has no built-in example app)

**Install and build**
```bash
git clone https://github.com/equationalapplications/expo-llm-wiki.git
cd expo-llm-wiki
npm install --legacy-peer-deps
npm run build
```

**Watch mode (rebuild on save)**
```bash
npm run dev
```

**Typecheck**
```bash
npx tsc --noEmit
```

**Linking into a local Expo project for manual testing**
```bash
# from the expo-llm-wiki directory
npm link

# from your Expo project
npm link expo-llm-wiki
```

Note: Metro bundler requires extra config for symlinked packages (`watchFolders` in `metro.config.js`). Document the required snippet.

---

## Branching

### Branch naming

All work happens on a feature branch off `main`. Branch names follow the pattern:

```
<type>/<short-description>
```

Types mirror conventional commit types:

| Type | When to use |
|---|---|
| `feat/` | New capability |
| `fix/` | Bug fix |
| `chore/` | Tooling, deps, config |
| `docs/` | Documentation only |
| `refactor/` | Code change with no behavior change |

Examples:
```
feat/fuzzy-dedup-librarian
fix/stale-checkpoint-reset
chore/add-semantic-release
docs/contributing-guide
```

### Rules

- Branch off `main`. Never off another feature branch.
- One concern per branch. Split unrelated changes.
- Delete the branch after merge.
- Never commit directly to `main`. All changes go through a PR.

---

## Conventional Commits

### Format

```
<type>(<scope>): <short summary>

[optional body]

[optional footer]
```

**Subject line rules:**
- Imperative mood: "add", "fix", "remove" — not "added" or "adds"
- ≤72 characters
- No trailing period
- Lowercase after the colon

**Types:**

| Type | Version bump | Use for |
|---|---|---|
| `feat` | minor | New public API, new behavior |
| `fix` | patch | Bug fix |
| `perf` | patch | Performance improvement |
| `refactor` | none | Internal restructure, no behavior change |
| `docs` | none | Documentation only |
| `test` | none | Tests only |
| `chore` | none | Deps, tooling, config |
| `build` | none | Build system changes |
| `ci` | none | CI/CD workflow changes |

**Scope** is optional but encouraged for larger packages. Use the file or subsystem: `wiki`, `react`, `schema`, `ingest`.

### Examples

```
feat(react): add useWikiIngest hook

fix(schema): reset checkpoint after clearAll forget

perf(read): parallelize fact, task and event queries

docs: add contributing guide

chore: add semantic-release
```

### Breaking changes

Breaking changes trigger a major version bump. Two ways to signal:

**1. Exclamation mark after type:**
```
feat(wiki)!: rename ingestDocument params object

BREAKING CHANGE: `documentChunk` param renamed to `content`.
Update all callers before upgrading.
```

**2. Footer only (body required):**
```
feat(wiki): add chunking to ingestDocument

Automatically chunks oversized documents before LLM extraction.

BREAKING CHANGE: ingestDocument now returns { truncated: boolean }
instead of void. Update callers that assign the return value.
```

Both formats are equivalent. Prefer the `!` form for visibility.

### What not to put in commits

- Do not describe what files changed ("update WikiMemory.ts") — the diff says that
- Do not reference tickets or PR numbers in the subject line — use the footer (`Closes #42`)
- Do not use past tense ("fixed", "added")
- Do not write "WIP" commits on PRs — squash or amend before opening

---

## Pull Requests

### Before opening

- [ ] Branch off latest `main`
- [ ] `npm run build` passes
- [ ] `npx tsc --noEmit` passes with zero errors
- [ ] All commits follow conventional commit format
- [ ] PR title is a valid conventional commit subject line (it becomes the squash commit message)

### PR title

The PR title is used as the squash merge commit message. It must be a valid conventional commit:

```
feat(react): add useWikiForget hook
fix(ingest): reset checkpoint after clearAll
```

### PR body

- Describe **why**, not what — the diff shows what
- Call out any open questions or tradeoffs
- Link to the relevant spec in `docs/specs/` if one exists

### Merge policy

- Squash merge only. One commit per PR on `main`.
- The squash commit message = the PR title. Set it before merging.
- Delete the branch after merge.

### Review bar

- All CI checks must pass before merge
- At least one approval for any change touching public API surface (`src/index.ts`, `src/react/index.ts`, `src/types.ts`)
- Docs-only and chore PRs can self-merge after CI passes

---

## What Does NOT Change

- `docs/specs/` — internal design documents, not part of the public contribution guide
- `src/` — no code changes in this spec
- `package.json` — no changes
