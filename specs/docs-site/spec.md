# docs-site

**Status:** Implemented (retroactive spec — see PR #311 and the ownership log in its description).

## Summary

Add a Starlight (Astro) developer-guide site at `apps/docs`, published to
https://equationalapplications.github.io/expo-llm-wiki/ via the existing
`deploy.yml` Pages workflow. The site turns the package READMEs into a
navigable guide (51 pages: start-here, concepts, guides, recipes, packages,
reference, project) and replaces the old Pages root redirect stub.

## Requirements

- R1: Site builds with `pnpm --filter docs build`; internal links/anchors resolve under the `/expo-llm-wiki` Pages base.
- R2: ScopeLab (`/scopelab/`) and WikiDemo (`/wiki-demo/`) URLs keep working; docs take the Pages root.
- R3: Docs are NOT gated into the root `pnpm -r build` used by the release workflow (a docs typo must never block an npm release); PR CI (`test.yml`) builds the docs explicitly.
- R4: Reference content matches `packages/*/src` (signatures, defaults, error fields, tool names).
- R5: New dependency versions satisfy the 14-day `minimumReleaseAge` gate; audit (`--prod`) stays green.
- R6: SynapseTree MCP is labelled in-development/not-released until actually published.

## Non-goals

- Slimming READMEs to overviews that link to the site (follow-up).
- Mermaid rendering, `starlight-links-validator` CI check (follow-ups).

## Ledger

- Implementation: Claude Code (branch `claude/wizardly-fermat-fyxl1c`).
- Review ladder: SoR clean → Haiku 5.5 low/medium/high/xhigh + sonnet-high (anchor-link fix) → Opus medium REQUEST CHANGES → build-scoping fix + this spec.
