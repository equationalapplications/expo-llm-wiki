# Import follow-ups — ledger

In flight: 8. whole-branch verification; Fable (high) docs audit for 8.0.0+ releases requested by the owner 2026-11-11

- [x] 1. #367 guard the no-vector hook call (spec §1) — evidence: c131fb40; diagnosticsEmbedding 12/12, 5 failed without the fix
- [x] 2. #366 default valid_from newest, capped at now (spec §2) — evidence: a573a228 (fix) + 48e3d3bf (docs); ops suites 67/67, 4 failed on main
- [x] 3. core-okf SHA-256 + UTF-8 encoder (spec §3.3, §3.4) — evidence: 31d99e84; sha256.test FIPS + node:crypto boundary lengths pass
- [x] 4. deriveEventId (spec §3.2–§3.4) — evidence: 31d99e84; event-id.test six spec vectors pass; okf 191/191, typecheck clean
- [x] 5. parseOkfBundle derived ids + plain unescape (spec §3.1, §3.6) — evidence: f02cb02f; parseOkfBundle 42/42 (12 failed on main), conformance 9/9; core 2214/2215, the one failure is idThreading timing (passes alone, also with changes stashed)
- [x] 6. Re-import tests against a real store (spec §3 T21–T26) — evidence: 7a5deb51; okfReimport 6/6, 4 failed with generateId restored
- [x] 7. Profile and docs (spec §3.7, §4) — evidence: docs commit after 7a5deb51; docs site build passes (52 pages)
- [ ] 8. Whole-branch verification and cleanup — evidence:

## Discrepancies

- 2026-11-11 — ledger created; disk matches (spec only, no code changes on the branch).
