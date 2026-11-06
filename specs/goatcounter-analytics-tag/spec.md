# Spec: GoatCounter analytics tag on the docs site

Status: Draft rev 5 (Tier-3 round-3 findings applied 2026-11-05; delta confirm pending)
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
  `data.p = pcb(data.p)`, so the client sends
  `p=equationalapplications.github.io/expo-llm-wiki/<path>`.
- Server-side normalization (goatcounter `hit.go:78`, verified in source:
  `h.Path = "/" + strings.Trim(h.Path, "/")`) strips the trailing slash and
  adds a leading one — the docs HOME page therefore stores as
  `/equationalapplications.github.io/expo-llm-wiki` with NO trailing slash.
- No site code in the endpoint URL — on this self-hosted vhost install the
  site is resolved from the Host header of the `/count` request;
  `/count/<code>` is the goatcounter.com SaaS convention and 404s here
  (verified live: `/count/abc` → 404, `/count` → 400).
- Because GoatCounter does not store the domain of a pageview (per
  https://www.goatcounter.com/help/domains), this host-prefix is what makes
  per-origin isolation possible inside the one bucket.

Dashboard filtering for docs traffic: filter paths CONTAINING
`equationalapplications.github.io/expo-llm-wiki` (no trailing slash — a
trailing-slash filter misses the home page per the normalization above).

Isolation caveat: this isolates docs traffic ONLY while scopelab and
wiki-demo stay unwired. Those apps deploy INSIDE the docs output
(`pages-dist/scopelab`, `pages-dist/wiki-demo` → served under
`/expo-llm-wiki/scopelab/...`), so the default callback would record their
hits inside the docs prefix. Any future lane wiring them MUST ensure the
RECORDED path does not CONTAIN the string
`equationalapplications.github.io/expo-llm-wiki` anywhere in it — a prefix
that merely fails to START with that string is not enough, because the
dashboard filter above matches on containment (e.g. `path: (p) => 'scopelab' + p`
records as `/scopelab/expo-llm-wiki/scopelab/...` and complies, while
`'scopelab/' + location.host + p` records as
`/scopelab/equationalapplications.github.io/expo-llm-wiki/...` and would
silently inflate docs numbers). Alternatively the lane can use its own stats
endpoint. Never the default callback verbatim.

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
- Ordering assertion, same exclusion (the token file contains neither string,
  and `html.index` would raise on it): in each generated HTML file, the
  inline script's `location.host` appears BEFORE the `count.js` reference
  (`html.index('location.host') < html.index('count.js')`). This also catches
  a stripped inline script, because `index` raises if `location.host` is
  absent.
- Pre-merge mechanism check (local): on a locally-served built page (loaded
  WITHOUT a query string — the default path includes `location.search`,
  count.js line 98, so a query string would fail the equality), verify
  `window.goatcounter.get_data().p === location.host + location.pathname`.
  Plain-HTTP local serving is fine: the script src is protocol-relative and
  the stats host serves port 80 (verified live 2026-11-05). Do NOT expect a
  `/count` request locally — count.js's filter blocks localhost/private-IP
  hits unless `allow_local` is set (count.js line 117), so `get_data()`
  (client-side, no network) is the right probe before merge.
- Post-deploy check (deployed URL only, where `location.host` is the real
  host): confirm the `/count` request carries
  `p=equationalapplications.github.io%2Fexpo-llm-wiki%2F...`, including a
  load of the docs home page.
- Post-deploy dashboard: confirm a prefixed path shows up, including the home
  page as `/equationalapplications.github.io/expo-llm-wiki`, and that the
  recommended filter matches it.
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
"no tracking" promise or CSP on the docs site contradicts this tag (the only
"privacy-first" mention in docs source, ecosystem.mdx, describes a desktop
product, not this site). Any analytics disclosure note is OUT OF SCOPE for
this PR — it ships in its own lane/PR if Kurt asks for one (open question
raised in the delivery thread; not blocking this PR's file scope).

## Out of scope

- scopelab and wiki-demo (separate apps deployed INSIDE the docs output under
  the Pages host; this tag does not reach them — untracked until their own
  lane wires them, at which point they must use a NON-COLLIDING prefix or
  their own endpoint, see the isolation caveat above)
- rhyming-game (its own repo + lane; CSP verified clear 2026-11-05)
- company-in-a-box-tutorial (site still under construction in that repo)
- hearthlore (analytics-free by design — privacy page + CSP promise)
- analytics-infra README still says "one GoatCounter site entry each" per
  site — updating it to reflect this ruling is a follow-up in that repo's
  own lane, not this PR.
