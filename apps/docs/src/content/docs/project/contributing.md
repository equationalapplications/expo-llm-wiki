---
title: Contributing
description: Set up the monorepo, run tests, and work on the docs site.
---

The full guide, covering branch naming, commit conventions, and release rules, is in
[CONTRIBUTING.md](https://github.com/equationalapplications/expo-llm-wiki/blob/main/CONTRIBUTING.md). Here's the short version.

## Set up

```bash
git clone https://github.com/equationalapplications/expo-llm-wiki.git
cd expo-llm-wiki
corepack enable   # picks up the pinned pnpm version
pnpm install      # pnpm only. npm won't resolve the workspace.
pnpm build
pnpm test
```

## Repository layout

```text
packages/
  core/                  @equationalapplications/core-llm-wiki
  expo/                  @equationalapplications/expo-llm-wiki
  react/                 @equationalapplications/react-llm-wiki
  core-llm-tools/        @equationalapplications/core-llm-tools
  okf/                   @equationalapplications/core-okf
  schema-org/            @equationalapplications/schema-org-llm-wiki
  schema-software-org/   @equationalapplications/schema-software-org
  prisma-outbox/         @equationalapplications/prisma-outbox
  mcp-server/            @equationalapplications/mcp-server
  integration/           integration tests (not published)
  benchmarks/            benchmarks (not published)
apps/
  docs/                  this site (Starlight)
  wiki-demo/             WikiDemo playground
  scopelab/              ScopeLab
specs/                   design specs, plans, ledgers
```

## Working on these docs

```bash
pnpm --filter docs dev     # http://localhost:4321/expo-llm-wiki/
pnpm --filter docs build
```

- Pages are Markdown or MDX files in `apps/docs/src/content/docs/`. The sidebar follows the
  folders, and `sidebar.order` in frontmatter sets the order.
- Every page has an **Edit page** link at the bottom.
- When a change to a package alters its behavior, update the matching guide in the same PR.
- Release notes come from the [Changelog](https://github.com/equationalapplications/expo-llm-wiki/blob/main/CHANGELOG.md), which semantic-release
  generates. Don't edit it by hand.
