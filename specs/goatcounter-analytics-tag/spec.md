# Spec: GoatCounter analytics tag on the docs site

Status: Draft rev 3 (Tier-3 Opus review round 1 applied 2026-11-05; delta confirm pending)
Date: 2026-11-05

## Problem

The docs site (https://equationalapplications.github.io/expo-llm-wiki/) has no
analytics. EA now runs a self-hosted GoatCounter instance at
https://stats.equationalapplications.com (deployed 2026-11-05; see the
analytics-infra repo). The docs site is one of the designated wiring targets.

## Proposed change

Add TWO entries to Starlight's `head` config in `apps/docs/astro.config.mjs`,
alongside the existing Bing verification meta — an inline config script, then
the count.js tag, in that order:

    { tag: 'script', content:
        'window.goatcounter = { path: (p) => location.host + p }' },
    { tag: 'script', attrs: { async: true,
        src: '//stats.equationalapplications.com/count.js',
        'data-goatcounter': 'https://stats.equationalapplications.com/count' } }

Mechanism notes (verified against live sources 2026-11-05):

- Starlight 0.42.6's `HeadConfigSchema` is `{ tag, attrs?, content? }` —
  inline script text MUST use `content` (`children` is silently stripped by
  the zod schema and the build still passes).
- The live `count.js` saves a function-valued `path` as `pcb` and calls
  `data.p = pcb(data.p)`, so every hit records as
  `equationalapplications.github.io/expo-llm-wiki/<path>`.
- No site code in the endpoint URL — on this self-hosted vhost install the
  site is resolved from the Host header of the `/count` request;
  `/count/<code>` is the goatcounter.com SaaS convention and 404s here
  (verified live: `/count/abc` → 404, `/count` → 400).
- Because GoatCounter does not store the domain of a pageview (per
  https://www.goatcounter.com/help/domains), this host-prefix is what makes
  per-origin isolation possible inside the one bucket.

Dashboard filtering for docs traffic: filter paths with the prefix
`equationalapplications.github.io/expo-llm-wiki/` (full prefix — the bare
github.io host prefix would also match scopelab/wiki-demo traffic if those
were ever wired, see Out of scope).

## Files touched

- apps/docs/astro.config.mjs (two entries appended to the starlight `head`
  array: the inline `window.goatcounter` config script, then the count.js tag)

## Test plan

- `pnpm --filter docs build` exits 0 (workspace deps are built first, same as
  CI's deploy workflow does).
- Grep built `dist/**/*.html` for `data-goatcounter` — present on every
  generated page EXCEPT the copied Search Console token file
  `dist/googleff7d7181e1455d40.html` (kept intentionally for verification;
  excluded from the assertion).
- Ordering assertion: in each generated HTML file, the inline script's
  `location.host` appears BEFORE the `count.js` reference
  (`html.index('location.host') < html.index('count.js')`) — a presence-only
  grep cannot catch a reversed order.
- Runtime check: load a built page in a browser and confirm the `/count`
  request carries `p=equationalapplications.github.io%2Fexpo-llm-wiki%2F...`.
- Post-deploy: confirm a prefixed path shows up in the GoatCounter dashboard.
- No changes to non-spec files beyond `astro.config.mjs`.

## Ruling: single stats bucket accepted (Kurt, 2026-11-05)

This GoatCounter install currently has ONE site (stats.equationalapplications.com),
and it resolves sites by Host header. Kurt ruled the combined bucket is a
perfectly acceptable trade-off to get data flowing today; the host-prefix
mechanism above is what makes per-origin isolation work inside that one
bucket.

If a per-site split is ever decided, it is NOT tag-neutral: a per-origin
vhost comes with a new stats hostname, so `data-goatcounter` (and likely
`src`) must change, the `path` prefix callback is removed at that point, and
history recorded until then stays in the shared bucket.

## INTENT check (recorded per AGENTS.md)

Checked 2026-11-05 against INTENT.md / docs pages / deploy config: no
"no tracking" promise or CSP on the docs site contradicts this tag. The docs
pages currently disclose no analytics; whether to add a short disclosure
note is an open question for Kurt (GoatCounter sets no cookies).

## Out of scope

- scopelab and wiki-demo (separate apps deployed under the same Pages host at
  `scopelab/` and `wiki-demo/`; this tag does not reach them — untracked
  until their own lane wires them, at which point they must use a
  distinguishing prefix or their own endpoint)
- rhyming-game (its own repo + lane; CSP verified clear 2026-11-05)
- company-in-a-box-tutorial (site still under construction in that repo)
- hearthlore (analytics-free by design — privacy page + CSP promise)
- analytics-infra README still says "one GoatCounter site entry each" per
  site — updating it to reflect this ruling is a follow-up in that repo's
  own lane, not this PR.
