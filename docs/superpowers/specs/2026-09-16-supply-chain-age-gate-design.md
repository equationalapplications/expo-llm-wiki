# Supply-chain age gate + security posture for expo-llm-wiki

**Status:** APPROVED — all decisions recorded 2026-09-16 (Phase 2 pin
devDeps now; all §4 follow-ups; deploy.yml frozen 1a; security bypass
accepted 2a). Zero open questions. Ready to merge + implement.
**Status revision (2026-09-16, post-approval, CodeRabbit review):** removed
the `@equationalapplications/*` age-gate exclusion (§3.1); replaced the
§5 age-gate recipe with an empirically verified deterministic one; aligned
§5 with the combined Phase 1+2 PR. No approved decision changed.
**Status revision (2026-09-16, plan-writing verification):** dependabot
`directory` + `directories` in one entry is schema-invalid → `directories`
only (§3.2); §5.1 no longer commits a from-scratch lockfile regen (it would
bump every transitive to its newest mature version — added churn and
exposure) — the committed lockfile is the minimal pin update, the full
regen is scratch-only proof; pins-before-gate ordering now carries its
empirical reason (§3 Phase 2).
**Requested by:** Kurt VanDusen, 2026-09-16 (Discord): "create a PR for
expo-llm-wiki to create a similar age gate as Curated Thoughts has, for
security purposes. And if there are other security features from Curated
Thoughts or other places that we can apply, suggest them."
**Parent policy:** `curated-thoughts/docs/superpowers/specs/2026-08-27-supply-chain-version-policy.md`
(external guidance: pin versions AND only accept deps older than 2 weeks).

---

## Plain-language summary

We are changing the **expo-llm-wiki GitHub repo only** — no local-filesystem
behavior, no published-package API changes. Phase 1 adds pnpm's 14-day
release-age gate (the same control Curated Thoughts has) plus a Dependabot
config with a matching cooldown. Phase 2 exact-pins dev dependencies —
**APPROVED by Kurt 2026-09-16 ("1" = pin them now, devDeps-only)**; both
phases land in the single implementation PR that follows this spec. The
published runtime API of `@equationalapplications/*` packages is untouched
in both phases.

---

## §1 — Context and threat model

expo-llm-wiki is a **published library monorepo** consumed by Curated
Thoughts (pinned exact at 7.1.1) and Clanker AI. Two distinct supply-chain
surfaces exist:

1. **This repo's build/publish pipeline.** Dev dependencies here execute
   during build, test, and semantic-release publish. A poisoned dev dep
   (cf. eslint-config-prettier CVE-2025-54313, axios 2026-03-31 — dev-dep
   postinstall vectors included) could backdoor the **published artifacts**
   that consumers then ingest. CT's consumer-side age gate does NOT protect
   this surface: a library's lockfile never ships to consumers.
2. **Consumer resolution.** `^`-ranged runtime dependencies in the published
   packages resolve in the *consumer's* lockfile. Protection for that
   surface belongs to the consumer (CT already has the gate + Dependabot
   cooldown; out of scope here).

This spec hardens surface 1 and standardizes change hygiene (Dependabot).

## §2 — Verified baseline (2026-09-16, repo @ `9b7b...` main, pnpm 10.33.2)

### 2.1 Already present — do NOT re-add (repo-state pitfall check)

| Control | Where |
|---|---|
| Frozen-lockfile CI installs | `test.yml` (`pnpm install --frozen-lockfile`) |
| pnpm audit gates (prod high+ w/ GHSA allowlist; full high+ failing only on fixable) | `test.yml`, two steps |
| SHA-pinned third-party actions + version comments | `test.yml` only — deploy.yml (actions/cache@v4 :37, peaceiris/actions-gh-pages@v4 :80) and release.yml (actions/cache@v4 :138,:525) have tag-pinned actions; fixing those is a §4-adjacent hardening candidate |
| `persist-credentials: false` on checkout | `test.yml` |
| Least-privilege `permissions:` blocks | all workflows |
| Postinstall-script allowlist (`allowBuilds`) | `pnpm-workspace.yaml` |
| Override single-source-of-truth in `pnpm-workspace.yaml` (17 advisory overrides; comment forbids `pnpm.overrides` in package.json) | `pnpm-workspace.yaml` |
| `packageManager: pnpm@10.33.2` pinned | root `package.json` |
| Dependabot **alerts**: 0 open (100 total all-states) | repo security tab |

### 2.2 Missing

- **`minimumReleaseAge`** — not set anywhere (pnpm 10.x has no default;
  pnpm 11 would default to 1440 min / 1 day, which this repo never opted
  into since it pins 10.33.2).
- **`.github/dependabot.yml`** — absent. No version-update PRs and no
  cooldown mechanism exist.
- Direct-dependency specifiers: **44 `^`-ranged** entries across root +
  `packages/*` (counting rule: `dependencies` + `devDependencies` whose
  spec starts with `^`/`~`, excluding `peerDependencies` — verified
  programmatically per-manifest; 43 of them are devDeps, the lone ranged
  runtime dep is `minisearch` in core). A further 22 ranged entries exist
  under `apps/*`. CT exact-pins all direct deps; ELW pins none of these.
- A `pnpm 11` default figure was mentioned here previously and is
  UNVERIFIED (review Finding 10) — irrelevant while `packageManager`
  pins 10.33.2; do not rely on any default existing.

### 2.3 Lockfile maturity scan (scan-first — the PR 127 lesson)

All 1,308 `pkg@version` entries (1,096 unique packages) extracted from
`pnpm-lock.yaml`; publish dates verified in bulk against full registry
packuments on 2026-09-16:

- **Inside a 14-day window: 15** — the `metro@0.84.6` family (14 `metro*`
  packages — `metro` itself + 13 scoped `metro-*` deps — plus `ob1@0.84.6`),
  all published ~2026-09-02 ~16:07 UTC, i.e. the 14-day boundary falls
  **2026-09-16 ~16:07 UTC (same day as this scan)**. Pulled in transitively
  via expo → `@expo/metro`.
- Everything else: 14 days or older. Zero packages with unknown publish data.

Implication: the gate as configured below will NOT require grandfathering
exclusions at any realistic merge date; the metro family matures one day
after this spec is written.

## §3 — Proposed changes

### Phase 1 (this PR, after spec approval)

**1. Age gate in `pnpm-workspace.yaml`:**

```yaml
# Supply-chain gate: reject versions published < 14 days ago at any
# lockfile-regen resolution (mirrors curated-thoughts; external guidance:
# "only accept dependencies older than 2 weeks").
minimumReleaseAge: 20160          # minutes; 14 days
```

Notes (verified mechanics — including empirically by the GLM 5.3 spec
review, see PR #152 review; see parent policy):
- The gate is evaluated at EVERY resolution that regenerates the lockfile,
  not only when the tree changes, and is NOT evaluated under
  `--frozen-lockfile` (nor on a plain install over an up-to-date lockfile —
  resolution is skipped entirely). CI is therefore unaffected; the gate
  bites exactly where risk concentrates (adds, updates, Dependabot
  regens).
- **No first-party exclusion** (deliberate divergence from CT; removed
  post-approval per CodeRabbit review). In ELW's topology a
  `'@equationalapplications/*'` exclusion is inert — all 17 first-party
  lockfile entries are `link:` (`workspace:*`, never registry-resolved),
  both release-phase installs are frozen, and the semantic-release commit
  does not touch the lockfile (review Finding 9). Keeping it "for the
  future" is backwards: if a first-party dep ever becomes
  registry-resolved, a stolen npm publish token is the most plausible
  attack on it, and a blanket exclusion would let exactly that version
  skip the gate. If such a dep is ever added and a same-day release
  deadlocks, add an exact `pkg@version` exclusion for that release only.
- The `metro@0.84.6` family should need no exclusions (§2.3). If
  verification (§5) runs while any entry is still inside the window, add
  exact `pkg@version` entries under `minimumReleaseAgeExclude` in ONE edit
  (wildcard-with-version syntax hard-fails with
  `ERR_PNPM_INVALID_MINIMUM_RELEASE_AGE_EXCLUDE` — good: a bad entry
  cannot slip through) with a maturity comment; entries self-neutralize
  past the window and can be swept in the next routine dependency PR.

**2. `.github/dependabot.yml` (new):**

```yaml
version: 2
updates:
  # NOTE: the npm ecosystem handles pnpm-lock.yaml too. A root-only entry keys
  # updates off the ROOT manifest only — the packages/* and apps/* sub-manifests
  # are listed explicitly so their specifiers get update PRs (the single
  # workspace lockfile is what the PRs regenerate). `directory` and
  # `directories` are mutually exclusive in one entry (schema oneOf).
  - package-ecosystem: npm
    directories: ["/", "/packages/*", "/apps/*"]
    schedule:
      interval: weekly
    cooldown:
      # Aligns Dependabot version updates with the pnpm age gate (policy
      # alignment, not enforcement — Dependabot does not consult
      # minimumReleaseAge). KNOWN BYPASS LANE (review Finding 4): security
      # updates are exempt from cooldown AND their lockfile regen is never
      # gate-evaluated in CI (frozen installs skip resolution). Accepted here
      # as the desired fast path for security fixes; a lockfile-maturity audit
      # step in CI is the compensating control if Kurt wants it (open question 3).
      default-days: 14
    groups:
      minor-and-patch:
        update-types:
          - minor
          - patch
    open-pull-requests-limit: 10
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 14
    groups:
      minor-and-patch:
        update-types:
          - minor
          - patch
```

- Mirrors CT's cooldown policy (14 days); GitHub's default is 3 days.
  Security updates are never delayed by cooldown (GitHub behavior).
- **Directory coverage** (review Finding 3 — corrected): the earlier draft
  claimed a root-only entry covers the workspace graph; that is NOT how
  Dependabot keys npm updates — it keys off the manifests it is pointed
  at. The config above explicitly targets `/packages/*` and `/apps/*`.
  Demo-app coverage (`apps/wiki-demo`, `apps/scopelab`) is included
  deliberately; exclude them in a follow-up if the PR volume is unwanted.
- **Grouping + PR limit** ported from CT's config to prevent a first-run
  PR storm (CT's release-toolchain group exists because of real breakage,
  CT PR #155; ELW's equivalent — if its semantic-release toolchain shows
  the same coupled-transitive pattern — gets its own `ignore`/group in the
  implementation PR, informed by the first Dependabot run).
- Version-update PRs regenerate the lockfile through the age gate;
  cooldown (14 d) makes them approximately gate-compatible. This is
  policy alignment, not enforcement (see bypass-lane note above).
- No release-please entry: this repo uses semantic-release, not
  release-please.

**3. deploy.yml frozen install (review Finding 5; IN SCOPE per Kurt's
1a, 2026-09-16):** `.github/workflows/deploy.yml:46` runs a plain
(non-frozen) `pnpm install` on every push to main. Change it to
`pnpm install --frozen-lockfile` so deploy builds exactly the lockfile PR
CI tested, matching every other install in the repo. Today's semantic-
release commit only bumps versions and never touches the lockfile, so
frozen passes on normal merges; if the lockfile ever arrives out of sync,
deploy now fails loudly at step 1 instead of silently re-resolving.
Validated on the first post-merge push to main.

### Phase 2 (APPROVED by Kurt 2026-09-16: pin dev dependencies NOW)

**Exact-pin dev dependencies** (review Finding 6 corrected count: **43**
`^`-ranged devDeps of the 44 total ranged entries in root + `packages/*`
— verified programmatically; the lone ranged runtime dep, `minisearch` in
core, stays `^`. The 22 ranged entries under `apps/*` are out of Phase 2
scope per the devDeps-only approval). devDeps execute the build/publish
path — §1 surface 1. Scope confirmed: devDependencies in root +
`packages/*` only; `^` stays on **published runtime dependencies**
(library semver convention; consumer lockfiles govern real resolution, and
forcing exact runtime pins on published packages degrades consumer dedup
without adding protection). Verified acceptance criteria from the CT
implementation carry over: transitive drift is EXPECTED at the one-time
regen (accept, don't block); pins-before-gate task ordering is MANDATORY
(deadlock pitfall — implement the pins edit and the Phase 1 gate in the
same branch, but if verification hits the gate on young versions,
grandfathering exclusions go in ONE edit).

Pin values = the version the lockfile already resolves for each importer
(so `^25.0.8` → `25.0.9`, `^4.23.5` → `4.23.11`), which makes the pin a
specifier-only lockfile change. Verified 2026-09-16 in a scratch worktree
of main: without the gate, the pin update changes only importer
specifiers plus pnpm pruning ~300 lines of already-orphaned entries
(stale `@rollup/rollup-*@4.62.4` etc.). WITH the gate already active, the
same non-frozen lockfile write silently re-resolved already-locked young
entries (it downgraded the in-window `metro@0.84.6` family) — the gate
re-evaluates locked versions whenever the lockfile is rewritten. Hence:
write the pinned lockfile first, add the gate second; with the gate then
added, `pnpm install --lockfile-only` leaves the lockfile byte-identical.

## §4 — Suggested additional security features (Kurt's ask #2)

Inventory-based: §2.1 lists what ELW already has (it is in better shape
than expected — two audit gates, SHA-pinned actions, allowBuilds). What CT
or elsewhere has that ELW lacks, in priority order:

| # | Feature | Status here | Suggestion |
|---|---|---|---|
| 1 | Age gate + Dependabot cooldown | Missing | Phase 1 (this spec) |
| 2 | npm provenance on publish | Not verified; publish runs via semantic-release in Actions | Enable `npm publish --provenance` (OIDC attestation that artifacts built from this repo at this SHA). Cheap, high-value for a published library. Small `release.yml` change; propose as its own follow-up PR. |
| 3 | CodeQL JS/TS analysis | Absent (CT has it) | Add a weekly + PR-triggered CodeQL workflow. Low noise for a TS repo; catches injection/flow classes pnpm audit can't. |
| 4 | Secret-scanning push protection | Unverified from here (org/repo setting) | Kurt (or an admin) flips it on in repo settings; one click, blocks commits containing detected secrets. |
| 5 | Review-bot gauntlet (CodeRabbit + frontier-model review at spec and PR stages) | `.github/review-guidelines.md` exists; no bot enforcement | Process-level, already our house flow — nothing to change in-repo. |

Items 2–4 are deliberately OUT of this spec's scope (one concern per PR);
listed here so Kurt can pick follow-ups.

## §5 — Verification plan (acceptance criteria for the Phase 1+2 PR)

0. **Pins applied (Phase 2):** a script over root + `packages/*`
   manifests reports zero `devDependencies` specifiers starting with
   `^`/`~` (runtime `dependencies` — i.e. `minisearch` — and
   `peerDependencies` excluded), and the lockfile importer `specifier`
   fields match the new exact pins (`pnpm install --frozen-lockfile`
   passing is the enforcement of that match).
1. On the branch, **with the pins applied**, **force a full re-resolution** (review Finding 2 — a
   plain `pnpm install` over an up-to-date lockfile skips resolution and
   proves nothing about the gate): in a scratch clone,
   `rm pnpm-lock.yaml && pnpm install` with the gate active — all ~1,308
   entries resolve through the gate. If it deadlocks on young versions,
   add one-edit exclusions per §3.1. The scratch regen is **proof only —
   do not commit it** (it would move every transitive to its newest mature
   version). The committed lockfile is the minimal pin update (§3 Phase
   2), and in the branch itself `pnpm install --lockfile-only` with the
   gate active must leave it byte-identical
   (`git diff --exit-code pnpm-lock.yaml`).
2. `pnpm install --frozen-lockfile` passes (CI parity).
3. Age-gate test recipe (isolated, ~30 s, pinned `pnpm@10.33.2`; verified
   empirically 2026-09-16). Use a **dynamically chosen, exact** young
   version — `npm view typescript dist-tags.next` (daily nightly, always
   < 14 d old). Never a range or dist-tag: `pnpm add typescript@next` under
   the gate silently falls back to the newest *mature* version instead of
   failing. Never a hardcoded version: it ages out.
   1. Scratch dir with a minimal `package.json` and **no** gate. `pnpm add
      typescript@<exact nightly>` → lockfile now contains a young version.
   2. Add `minimumReleaseAge: 20160` to the scratch `pnpm-workspace.yaml`.
   3. `rm -rf node_modules && pnpm install --frozen-lockfile` → expect
      **success** (gate not evaluated under frozen; this is the accepted
      bypass boundary, §6 Q4).
   4. `rm pnpm-lock.yaml && pnpm install` → expect
      `ERR_PNPM_NO_MATURE_MATCHING_VERSION`.
   The naive recipe (gate on, `pnpm add` young → fail, then frozen install)
   is vacuous: the failed add writes neither lockfile nor manifest entry,
   so the frozen step passes with "Already up to date" and proves nothing.
4. `pnpm -r typecheck && pnpm test` green (Phase 2 changed devDep
   specifiers and possibly transitive versions, so this is a real check,
   not a formality).
5. Dependabot config: syntax sanity via GitHub (config errors surface as a
   repo-level "Dependabot can't parse" notification after merge — check the
   next scheduled run created PRs).

## §6 — Open questions

1. ~~**Phase 2 exact-pinning:**~~ **ANSWERED 2026-09-16:** Kurt approved
   devDeps-only exact-pinning, landing WITH Phase 1 (see §3 Phase 2).
2. ~~**Follow-up picks from §4:**~~ **ANSWERED 2026-09-16: Kurt approved
   ALL THREE** — (2) npm publish provenance, (3) CodeQL workflow, (4)
   secret-scanning push protection — to be scheduled as follow-up PRs
   after Phases 1+2 merge. Not blocking this spec or the implementation PR.
3. ~~**deploy.yml install parity:**~~ **ANSWERED 2026-09-16: Kurt chose
   1a — fold `--frozen-lockfile` parity into the implementation PR** (see
   §3 item 3). Rationale: deploy should build exactly what PR CI tested;
   the non-frozen "self-heal" is the same property that lets unvetted
   versions into the build.
4. ~~**Security-update bypass lane:**~~ **ANSWERED 2026-09-16: Kurt chose
   2a — accept the bypass as-is** (CT parity; speed is the point of
   security fixes; Dependabot security PRs still pass the full review
   gauntlet). No CI maturity-audit step. The bypass is documented in §3
   item 2 so future maintainers know the gate's real boundary.

**Review provenance:** GLM 5.3 frontier review (session
`20260916_101355_51b1e7`, full report archived at PR #152 review comment)
— verdict APPROVE-WITH-CHANGES; Findings 2, 3, 5, 6, 9, 10 addressed in
this revision; Findings 7–8 (action SHA-parity, tag-pinned) folded into
§2 table + §4 queue; all repo-state corrections verified independently
against the checkout before acceptance.
