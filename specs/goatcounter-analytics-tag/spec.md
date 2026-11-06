# Spec: GoatCounter analytics tag on the docs site

Status: Implemented rev 8 (Tier-3 Opus ladder APPROVED r4; Tier-4 Fable spec gate CONVERGED; spec + plan approved and rev 8 drift fold flagged by Kurt 2026-11-06, msgs 1568319055209955480 / 1568338441026936853 / 1568375465469673477. Implementation ladder: Haiku low→xhigh + Opus + delta + independent reviewer, all converged)
Date: 2026-11-05 (rev 8: 2026-11-06)
**Intent check:** Checked 2026-11-05 against INTENT.md / docs pages / deploy config: no "no tracking" promise or CSP on the docs site contradicts this tag (the only "privacy-first" mention in docs source, ecosystem.mdx, describes a desktop product, not this site). Analytics disclosure note is out of scope for this PR (own lane if wanted).

## Problem

The docs site (https://equationalapplications.github.io/expo-llm-wiki/) has no
analytics. EA now runs a self-hosted GoatCounter instance at
https://stats.equationalapplications.com (deployed 2026-11-05, GoatCounter
v2.7.0 linux-amd64; see the analytics-infra repo). The docs site is one of the
designated wiring targets.

## Proposed change

**Vendor the tracking script into the docs output** and add TWO entries to
Starlight's `head` config in `apps/docs/astro.config.mjs`, alongside the
existing Bing verification meta — an inline config script, then the vendored
count.js tag, in that order:

    { tag: 'script', content:
        'window.goatcounter = { path: (p) => location.host + p }' },
    { tag: 'script', attrs: { async: true,
        src: `${base}/count.js`,
        'data-goatcounter': 'https://stats.equationalapplications.com/count' } }

The `src` is DERIVED from the site's `base` constant in astro.config.mjs (a
base change can never orphan the tag silently).

The script is NOT loaded from the stats host. `apps/docs/public/count.js` is a
verbatim copy of the script the stats host serves
(https://stats.equationalapplications.com/count.js, fetched 2026-11-06,
sha256 `030ad75a7c80a04107a9b91f79e4b1572da0a583a80a9b67e111b310da11cbe9`).
Rationale: the docs origin (`equationalapplications.github.io`) also hosts
wiki-demo, which persists user LLM API keys to `sessionStorage`
(`apps/wiki-demo/src/lib/sessionConfig.ts`, opt-in `llm-config`, audit 2026-08-24
H-3). A third-party-hosted `<script src>` executes with full same-origin
privilege over that origin; vendoring removes that trust extension to the
stats host and its CDN while keeping identical tracking behavior. The stats
host stays EA-controlled, so script upgrades are EA-driven anyway: re-copy the
new count.js into `public/` (and re-record the sha256) whenever GoatCounter is
upgraded. goatcounter.com documents both vendoring ("Host count.js somewhere
else?") and SRI ("Use SRI with count.js?") as supported setups; SRI was
REJECTED even though the stats host does serve the script with permissive CORS
headers (`access-control-allow-origin: *`, probed 2026-11-06): a hash pin must
be re-pinned on every script version change (the same maintenance as
re-copying on upgrade), and it leaves the docs build's count.js asset
dependent on the stats host and its CDN being up at page-load time. Vendoring
achieves the same substitution-integrity property with the file under EA's own
PR review and no runtime dependency on the stats host for page assets. With
the script vendored, the only cross-origin surface left is the beacon POST to
`/count`, whose response is never executed.

## Root cause (with evidence)

Mechanism notes (verified against live sources 2026-11-05/06):

- Starlight 0.42.6's `HeadConfigSchema` is `{ tag, attrs?, content? }` —
  inline script text MUST use `content` (`children` is silently stripped by
  the zod schema (`z.core.$strip`) and the build still passes). Boolean attrs
  (`async: true`) are accepted by the schema's attrs record.
- The vendored `count.js` saves a function-valued `path` as `pcb` and calls
  `data.p = pcb(data.p)`, so the client sends
  `p=equationalapplications.github.io/expo-llm-wiki/<path>`.
- The path the callback receives comes from `get_path()`, which PREFERS a
  same-host `<link rel="canonical">`: when the canonical hostname matches
  `location.hostname` (it does on every deployed page — Starlight emits
  canonical links per page, verified in the baseline build of this branch,
  dist built 2026-11-06 with config unchanged, incl.
  `404.html` → canonical `/expo-llm-wiki/404/`), the recorded path is the
  canonical pathname and query strings are dropped; all 404 loads therefore
  collapse into the single row `/equationalapplications.github.io/expo-llm-wiki/404`
  (no trailing slash after the server-side normalization below).
  In a locally-served page (hostname mismatch) `get_path()` falls back to
  `location.pathname + location.search`, which is what the pre-merge probe
  below sees.
- Server-side normalization (goatcounter v2.7.0 `hit.go`, `cleanPath()`:
  `h.Path = "/" + strings.Trim(h.Path, "/")`) strips the trailing slash and
  adds a leading one — the docs HOME page therefore stores as
  `/equationalapplications.github.io/expo-llm-wiki` with NO trailing slash.
- No site code in the endpoint URL — on this self-hosted vhost install the
  site is resolved from the Host header of the `/count` request. The
  goatcounter.com SaaS convention places the site code in a SUBDOMAIN
  (`https://CODE.goatcounter.com/count`; probed live 2026-11-06:
  `arp242.goatcounter.com/count` → 400, `www.goatcounter.com/count/xyz` → 404),
  not a `/count/<code>` path.
- Because GoatCounter does not store the domain of a pageview (per
  https://www.goatcounter.com/help/domains, which recommends exactly this
  `path: function(p) { return location.host + p }` pattern for tracking
  several domains into one site), this host-prefix is what makes per-origin
  isolation possible inside the one bucket.

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
  array: the inline `window.goatcounter` config script, then the vendored
  count.js tag)
- apps/docs/public/count.js (NEW — vendored copy of the stats-host script,
  sha256 recorded in Proposed change)
- .github/workflows/test.yml (one assertion step after the existing
  `pnpm --filter docs build` step, guarding the inline script against silent
  schema-strip regression — see Test plan)
- apps/docs/scripts/check-goatcounter.mjs (NEW — the guard checker, extracted
  so its negative cases run as permanent self-test fixtures; test.yml calls it)

All four are docs-infrastructure only. Commit-type constraint discovered in
implementation review: this repo's semantic-release has no scope filter, so
`feat:`/`fix:` anywhere would cut an unintended npm release — every commit in
this lane uses non-releasable types (chore/docs/ci).

## Test plan

- `pnpm --filter docs build` exits 0 (workspace deps are built first, same as
  CI's deploy workflow does).
- Vendored script parity + provenance: `apps/docs/public/count.js` is
  byte-identical to the script the stats host served (sha256
  `030ad75a7c80a04107a9b91f79e4b1572da0a583a80a9b67e111b310da11cbe9`), and
  that hash matches upstream `arp242/goatcounter` v2.7.0 `public/count.js`
  byte-for-byte (diff-empty, tag-cloned 2026-11-06) — the copy is NOT
  trusting what the de-trusted host served on fetch day. CI enforces it
  offline: the test.yml step runs the guard checker against the recorded hash on
  the COMMITTED file (pinned via the tagged line
  vendored-sha256: 030ad75a7c80a04107a9b91f79e4b1572da0a583a80a9b67e111b310da11cbe9
  — the ONLY line CI reads; other hash mentions in this file are prose and not
  machine-consumed), so any edit
  (including line-ending normalization) forces the hash to be updated in the
  same PR. The checker verifies BOTH the repo copy and the built `dist/count.js`.
- Grep built `dist/**/*.html` for `data-goatcounter` — present on every
  generated page EXCEPT the copied Search Console token file
  `dist/googleff7d7181e1455d40.html` (kept intentionally for verification;
  excluded from the assertion). The same assertion ships as a CI step in
  test.yml right after the docs build: a silent schema-strip regression would
  otherwise be UNDETECTABLE after the fact (hits keep landing in the shared
  bucket under paths that no longer carry the docs prefix, so the loss is
  unrecoverable by re-attribution) — the one-off acceptance option was
  rejected for exactly that reason.
- Ordering + integrity assertion, same exclusion (the token file contains
  neither string): in each generated HTML file, the EXACT inline config text
  appears BEFORE the EXACT tag
  `src="/expo-llm-wiki/count.js" data-goatcounter="https://stats.equationalapplications.com/count"`.
  Anchoring on the full tag (not loose substrings) is what also enforces the
  two properties the design depends on: the script stays VENDORED same-origin
  (a regression to the remote stats-host src fails the build) and the endpoint
  stays the right site (Host-header resolution makes a wrong endpoint silently
  count into the wrong site). These assertions live in
  `apps/docs/scripts/check-goatcounter.mjs` (called by the test.yml step),
  which first runs eight self-test fixtures — good, stripped-config,
  misordered, missing-tag, cross-origin-src, wrong-endpoint, two-tags,
  commented-config — so the negative cases are
  permanent, and fails CLOSED if zero pages are found. The checker also
  asserts the stats host appears in each page ONLY inside the endpoint
  attribute — any OTHER stats-host reference (e.g. a remote `<script src>`
  without the tracking attribute, which would hand the stats host
  script-execution privilege over this origin) fails the build. This also catches
  a stripped inline script (exact-text probe, not any `location.host` hit).
- Pre-merge mechanism check (local): serve the built site UNDER ITS BASE
  (`astro preview` from apps/docs — a plain static server on `dist/` returns
  404 for the absolute `/expo-llm-wiki/count.js` src and the probe would
  false-fail with `get_data` undefined), on a page loaded WITHOUT a query
  string (the fallback path includes `location.search`,
  so a query string would fail the equality), and verify
  `window.goatcounter.get_data().p === location.host + location.pathname`.
  Locally the script is served same-origin from `public/` (no stats-host
  dependency for the probe). Do NOT expect a `/count` request locally —
  count.js's filter blocks localhost/private-IP hits unless `allow_local` is
  set, so `get_data()` (client-side, no network) is the right probe before
  merge. Expected value shape differs by environment (see Root cause): local
  pages report `location.pathname + location.search` through the callback;
  deployed pages report the canonical pathname (query strings dropped).
- Post-deploy check (deployed URL only, where the canonical hostname matches):
  confirm the `/count` request carries
  `p=equationalapplications.github.io%2Fexpo-llm-wiki%2F...`, including a
  load of the docs home page.
- Post-deploy dashboard: confirm a prefixed path shows up, including the home
  page as `/equationalapplications.github.io/expo-llm-wiki`, and that the
  recommended filter matches it.
- No changes to non-spec files beyond the four files under Files touched.

## Post-merge checks (NOT part of the implementation ledger)

The two post-deploy checks above (the `/count` beacon check and the dashboard
check) run AFTER merge, in production, and cannot run earlier: they exercise
the deployed Pages host. specs/README.md's lifecycle flips the spec to
Implemented and deletes plan/LEDGER BEFORE the merge, so these checks have no
ledger slot by design. Owner: Tessera (executor), verification window: first
24 h after the deploy workflow completes; run from a blocker-free browser
profile (an ad blocker or privacy extension dropping the beacon would
false-fail a healthy deploy); any failure (no `/count` beacon, unprefixed
path, filter mismatch) → REVERT the PR first, then diagnose — a mis-shipped
tag pollutes the shared bucket immediately and unrecoverably.

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
  own lane, not this PR. The same follow-up should record the count.js
  upgrade rule (when analytics-infra upgrades GoatCounter, re-copy
  `public/count.js` from the new tag into the docs repo's
  `apps/docs/public/` and update the recorded sha256) where the person
  running the upgrade will actually see it — it lives only in this spec
  otherwise.
