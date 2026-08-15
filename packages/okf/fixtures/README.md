# OKF profile conformance fixtures

Canonical bundles for [docs/okf-profile.md](../../../docs/okf-profile.md).

- `golden-v1/` — llm-wiki/1: summary prose, `## Related`, event id comments
- `golden-v2/` — llm-wiki/2: `generated`, `verified` (multiple + bare-mapping), `sources` with per-entry `usage_window`, `usage_window` sibling, `status` (lifecycle), `stale_after` (one past-stale fact), footnote body, `Attested Computation` concept as generic fact, task with `status`/`execution_status` rename
- `legacy-profile-0/` — no profile key; exercises tuple-dedup and Related-strip fallbacks

Non-TypeScript implementations should vendor checksummed copies. Do not edit without updating conformance tests and regenerating SHA256SUMS.
