# Spec: GoatCounter analytics tag on the docs site

Status: Draft rev 2 (Kurt's ruling folded 2026-11-05; Tier-3 review pending)
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

Because GoatCounter does not store the domain of a pageview (verified against
https://www.goatcounter.com/help/domains — `a.example.com/x` and
`b.example.com/x` both record as `/x`), one extra inline script entry goes
BEFORE the count.js tag so every hit records with its host prefixed:

    { tag: 'script', attrs: {}, children:
        "window.goatcounter = { path: (p) => location.host + p }" }

Docs traffic is then isolatable in the dashboard by filtering paths with the
`equationalapplications.github.io/` prefix, per Kurt's intent
(ruling message 2026-11-05). Order matters: the inline entry must precede the
count.js entry in the `head` array.

## Files touched

- apps/docs/astro.config.mjs (two entries appended to the starlight `head`
  array: one inline `window.goatcounter` config script, then the count.js tag)

## Test plan

- `pnpm --filter docs build` (or repo's documented docs build command) exits 0
- Grep the built `dist/**/*.html` for `data-goatcounter` — present on every page
- Grep the built `dist/**/*.html` for `location.host` — the inline path-prefix
  script precedes the count.js tag on every page
- No other changes in the diff

## Ruling: single stats bucket accepted (Kurt, 2026-11-05)

This GoatCounter install currently has ONE site (stats.equationalapplications.com),
and it resolves sites by Host header. Kurt ruled the combined bucket is a
perfectly acceptable trade-off to get data flowing today. Correction folded with
the ruling: GoatCounter does NOT store the domain, so a native "filter by domain"
does not exist; the path-prefix mechanism above is what makes per-origin
isolation possible inside the one bucket. Splitting into per-site vhosts later
stays possible and needs no change to this tag, decided at that time.

## Out of scope

- rhyming-game (its own repo + lane; CSP verified clear 2026-11-05)
- company-in-a-box-tutorial (site still under construction in that repo)
- hearthlore (analytics-free by design — privacy page + CSP promise)
