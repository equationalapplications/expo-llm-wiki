# Contributing

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

Metro requires extra config for symlinked packages. Add to `metro.config.js`:

```js
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../expo-llm-wiki')];
module.exports = config;
```

---

## Branching

Branch off `main` using the pattern `<type>/<short-description>`:

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

**Rules:**
- Branch off `main`. Never off another feature branch.
- One concern per branch. Split unrelated changes.
- Delete the branch after merge.
- Never commit directly to `main`. All changes go through a PR.

---

## Conventional Commits

```
<type>(<scope>): <short summary>

[optional body]

[optional footer]
```

**Subject line:** imperative mood, ≤72 chars, no trailing period, lowercase after the colon.

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

Scope is optional. Use the subsystem: `wiki`, `react`, `schema`, `ingest`.

**Examples:**
```
feat(react): add useWikiIngest hook
fix(schema): reset checkpoint after clearAll forget
perf(read): parallelize fact, task and event queries
docs: add contributing guide
chore: add semantic-release
```

**Breaking changes** trigger a major version bump. Use `!` after the type:

```
feat(wiki)!: rename ingestDocument params object

BREAKING CHANGE: `documentChunk` param renamed to `content`.
Update all callers before upgrading.
```

**Don't:**
- Describe what files changed — the diff shows that
- Put ticket/PR numbers in the subject — use the footer (`Closes #42`)
- Use past tense ("fixed", "added")
- Push WIP commits — squash or amend before opening a PR

---

## Releases

Version bumps and `CHANGELOG.md` are managed by [semantic-release](https://github.com/semantic-release/semantic-release) on merge to `main` (see `.releaserc.json` and `.github/workflows/release.yml`).

**Do not edit in PRs:**
- `CHANGELOG.md`
- `"version"` in root or workspace `package.json` files (`packages/*/package.json`)

Use conventional commits instead. semantic-release analyzes squash-merge commits on `main`, bumps versions, writes release notes, publishes to npm, and commits the updated files back with `[skip ci]`.

For breaking changes, include a `BREAKING CHANGE:` footer in the commit message — release notes are generated from that automatically.

---

## Pull Requests

**Before opening:**
- [ ] Branch off latest `main`
- [ ] `npm run build` passes
- [ ] `npx tsc --noEmit` passes with zero errors
- [ ] Commits follow conventional commit format
- [ ] PR title is a valid conventional commit subject line
- [ ] No manual edits to `CHANGELOG.md` or `package.json` versions (semantic-release handles these on merge)

The PR title becomes the squash merge commit message on `main`:
```
feat(react): add useWikiForget hook
fix(ingest): reset checkpoint after clearAll
```

**PR body:** describe why, not what. Link to the relevant spec in `docs/specs/` if one exists.

**Merge policy:**
- Squash merge only. One commit per PR on `main`.
- Delete the branch after merge.

**Review bar:**
- All CI checks must pass
- At least one approval for changes touching public API (`src/index.ts`, `src/react/index.ts`, `src/types.ts`)
- Docs-only and chore PRs can self-merge after CI passes

---

By contributing you agree your work will be released under the [MIT License](LICENSE).
