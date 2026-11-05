# Spec: GoatCounter analytics tag on the docs site

Status: Draft (awaiting Kurt's spec approval)
Date: 2026-11-05

## Problem

The docs site (https://equationalapplications.github.io/expo-llm-wiki/) has no
analytics. EA now runs a self-hosted GoatCounter instance at
https://stats.equationalapplications.com (deployed 2026-11-05; see the
analytics-infra repo). The docs site is one of the designated wiring targets.

## Proposed change

Add the GoatCounter tracking script to Starlight's `head` config in
`apps/docs/astro.config.mjs`, alongside the existing Bing verification meta:

    { tag: 'script', attrs: { async: true,
        src: '//stats.equationalapplications.com/count.js',
        'data-goatcounter': 'https://stats.equationalapplications.com/count' } }

No site code in the URL — on this self-hosted vhost install the site is
resolved from the Host header; `/count/<code>` is the goatcounter.com SaaS
convention and 404s on this install.

## Files touched

- apps/docs/astro.config.mjs (one entry appended to the starlight `head` array)

## Test plan

- `pnpm --filter docs build` (or repo's documented docs build command) exits 0
- Grep the built `dist/**/*.html` for `data-goatcounter` — present on every page
- No other changes in the diff

## Known limitation (needs Kurt's awareness)

This GoatCounter install currently has ONE site (stats.equationalapplications.com),
and it resolves sites by Host header. Every wired origin therefore counts into the
single stats site until additional per-site vhosts are created on the VM. Wiring
the tag now means combined numbers; splitting later needs no tag change (only a
per-origin vhost + separate stats hostname per site, decided at that time).

## Out of scope

- rhyming-game (its own repo + lane; CSP verified clear 2026-11-05)
- company-in-a-box-tutorial (site still under construction in that repo)
- hearthlore (analytics-free by design — privacy page + CSP promise)
