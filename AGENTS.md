# expo-llm-wiki — agent notes

## Spec alignment

Every spec must be checked against `INTENT.md` before implementation work
begins. If a spec contradicts `INTENT.md` *on intent*, the spec is wrong
until `INTENT.md` is amended: INTENT wins on *intent* (what we are trying
to do), specs win on *detail* (exactly how). `INTENT.md` itself defers to
the SynapseTree founding charter; never re-rule a charter promise here.

## Operational landmines (read before touching the tree)

- **pnpm only.** `pnpm@10.33.2` via Corepack. Never run `npm install` or
  commit a `package-lock.json`; the workspace will not resolve and the
  stray lockfile gets scanned as if it were real.
- **Lockfile discipline.** Regenerate with `pnpm install --lockfile-only`
  and commit the minimal diff. The 14-day `minimumReleaseAge` gate in
  `pnpm-workspace.yaml` is binding. Never set it to 0, never add
  `pnpm.overrides` to `package.json` (pnpm 10 silently ignores the YAML
  set when both exist). Early admission of a young version needs Kurt's
  written waiver recorded in `pnpm-workspace.yaml` with date and reason.
- **Audit allowlists expire on purpose.** The two audit steps in
  `.github/workflows/test.yml` carry date-bounded GHSA allowlists. A red
  step on an expiry date is the forcing function, not a bug to silence.
- **Grouped bumps.** Build-time tooling majors may ride one grouped PR
  after a pack-diff of the published `.d.ts`; runtime or peer majors get
  their own PR.
- **Merge commits, never squash.** Every PR into `main`, release PRs
  included — `release.yml` merges them with `--merge` by design.
- **Never edit `CHANGELOG.md` or any `"version"` field.** semantic-release
  owns them. Never write a `BREAKING CHANGE` footer without a ruling; it
  publishes 8.0.0.
- **Spec status honesty.** Every spec in `docs/superpowers/specs/` has a
  Status line. Update it in the same PR that changes the behavior. Three
  specs shipped with stale "not started" headers until 2026-10-29; do not
  add a fourth.
- **`.brain/` is not ours.** It is scratch written by the Curated Thoughts
  indexer when CT indexes this repo. It is gitignored; never commit it,
  never write into a repo you are indexing from CT.
- **Rust crate is a second supply-chain surface.** `crates/graphrag-core`
  pins toolchain 1.96.0 in `rust-toolchain.toml`; CI pins the toolchain
  action by SHA. `Cargo.lock` is committed. Do not bump either casually.
- **Integration and benchmark tests.** Root `pnpm test` runs every package
  except `integration`, then runs `integration` separately without its
  two embedding-model suites. Those suites (`scifact`, `financebench`) run
  only via `pnpm benchmark` and download models through fastembed.
- **Benchmarks spend real tokens and never touch a live store.** The CLI
  in `packages/benchmarks` refuses to run without `--yes` and opens only
  in-memory or cache-directory SQLite files. Keep it that way.
- **Defaults are frozen pending 8.0.0.** `librarian.strategy` stays
  `'legacy'` and `maintenance` stays `'auto'` by default until Kurt rules.
