# Supply-chain age gate + security posture for expo-llm-wiki

**Status:** Phase 2 approved by Kurt 2026-09-16 (pin devDeps, now).
Spec under review — PR #152.
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
Thoughts (pinned exact at 7.1.0) and Clanker AI. Two distinct supply-chain
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
| SHA-pinned third-party actions + version comments | all three workflows |
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
- Direct-dependency specifiers: **34 `^`-ranged** entries across root +
  `packages/*` (tsup, typescript, better-sqlite3, fastembed, expo-crypto,
  minisearch, jsdom, etc.). CT exact-pins all direct deps; ELW pins none.

### 2.3 Lockfile maturity scan (scan-first — the PR 127 lesson)

All 1,308 `pkg@version` entries (1,096 unique packages) extracted from
`pnpm-lock.yaml`; publish dates verified in bulk against full registry
packuments on 2026-09-16:

- **Inside a 14-day window: 15** — the `metro@0.84.6` family (13 `metro-*`
  packages + `ob1@0.84.6`), all published 13.9 days ago, i.e. **maturing
  2026-09-17**. Pulled in transitively via expo → `@expo/metro`.
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
minimumReleaseAgeExclude:
  # First-party packages are consumed/published same-day during the
  # semantic-release flow — the gate would deadlock releases without this.
  - '@equationalapplications/*'
```

Notes (verified mechanics, see parent policy):
- The gate is evaluated at EVERY resolution that regenerates the lockfile,
  not only when the tree changes, and is NOT evaluated under
  `--frozen-lockfile` — so CI is unaffected; the gate bites exactly where
  risk concentrates (adds, updates, Dependabot regens, release flow).
- `minimumReleaseAgeExclude: '@equationalapplications/*'` is REQUIRED:
  semantic-release bumps first-party versions and consumes them
  same-day; without the exclusion the release flow deadlocks.
- The `metro@0.84.6` family should need no exclusions (§2.3). If
  verification (§5) runs while any entry is still inside the window, add
  exact `pkg@version` entries under `minimumReleaseAgeExclude` in ONE edit
  (wildcard-with-version syntax is INVALID in pnpm 10) with a maturity
  comment; entries self-neutralize past the window and can be swept in the
  next routine dependency PR — no cron needed for a one-day tail.

**2. `.github/dependabot.yml` (new):**

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 14
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 14
```

- Mirrors CT's cooldown policy; GitHub's default is 3 days. Security
  updates are never delayed by cooldown (GitHub behavior).
- Version-update PRs will regenerate the lockfile and therefore hit the
  age gate — the two controls reinforce each other instead of fighting
  (Dependabot picks versions the gate accepts, or its PR fails visibly).
- `packages/*` sub-manifests are workspace members; Dependabot's root npm
  entry covers the workspace graph via the single lockfile. No
  release-please entry: this repo uses semantic-release, not release-please.

### Phase 2 (APPROVED by Kurt 2026-09-16: pin dev dependencies NOW)

**Exact-pin dev dependencies** (the 34 `^` entries; devDeps execute the
build/publish path — §1 surface 1). Scope confirmed: devDependencies in
root + `packages/*` only; `^` stays on **published runtime dependencies**
(library semver convention; consumer lockfiles govern real resolution, and
forcing exact runtime pins on published packages degrades consumer dedup
without adding protection). Verified acceptance criteria from the CT
implementation carry over: transitive drift is EXPECTED at the one-time
regen (accept, don't block); pins-before-gate task ordering is MANDATORY
(deadlock pitfall — implement the pins edit and the Phase 1 gate in the
same branch, but if verification hits the gate on young versions,
grandfathering exclusions go in ONE edit).

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

## §5 — Verification plan (acceptance criteria for the Phase 1 PR)

1. On the branch, `pnpm install` (lockfile-regen, expected no-op) succeeds
   with the gate active — proves no young-version deadlock at merge time;
   add one-edit exclusions per §3.1 if it fails.
2. `pnpm install --frozen-lockfile` unchanged (CI parity).
3. Age-gate test recipe (isolated, ~30 s, per parent policy): scratch dir,
   pinned `pnpm@10.33.2`, `pnpm add <pkg published < 14d ago>` → expect
   `ERR_PNPM_NO_MATURE_MATCHING_VERSION`; `--frozen-lockfile` install in
   the same dir → expect success.
4. `pnpm -r typecheck && pnpm test` green (no dependency versions changed by
   Phase 1, so this is a formality that proves the workspace is untouched).
5. Dependabot config: syntax sanity via GitHub (config errors surface as a
   repo-level "Dependabot can't parse" notification after merge — check the
   next scheduled run created PRs).

## §6 — Open questions

1. ~~**Phase 2 exact-pinning:**~~ **ANSWERED 2026-09-16:** Kurt approved
   devDeps-only exact-pinning, landing WITH Phase 1 (see §3 Phase 2).
2. **Follow-up picks from §4:** provenance (2), CodeQL (3), push protection
   (4) — any/all can be scheduled as separate PRs after Phase 1 merges.
   *Not blocking — Kurt can pick these any time; implementation proceeds
   for Phases 1+2 regardless.*
