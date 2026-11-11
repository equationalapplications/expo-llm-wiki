# Import follow-ups — ledger

In flight: 8. review of the rev 2/3 code, then final cleanup

- [x] 1. #367 guard the no-vector hook call (spec §1) — evidence: c131fb40; diagnosticsEmbedding 12/12, 5 failed without the fix
- [x] 2. #366 default valid_from newest, capped at now (spec §2) — evidence: a573a228 (fix) + 48e3d3bf (docs); ops suites 67/67, 4 failed on main
- [x] 3. core-okf SHA-256 + UTF-8 encoder (spec §3.3, §3.4) — evidence: 31d99e84; sha256.test FIPS + node:crypto boundary lengths pass
- [x] 4. deriveEventId (spec §3.2–§3.4) — evidence: 31d99e84; event-id.test six spec vectors pass; okf 191/191, typecheck clean
- [x] 5. parseOkfBundle derived ids + plain unescape (spec §3.1, §3.6) — evidence: f02cb02f; parseOkfBundle 42/42 (12 failed on main), conformance 9/9; core 2214/2215, the one failure is idThreading timing (passes alone, also with changes stashed)
- [x] 6. Re-import tests against a real store (spec §3 T21–T26) — evidence: 7a5deb51; okfReimport 6/6, 4 failed with generateId restored
- [x] 7. Profile and docs (spec §3.7, §4) — evidence: docs commit after 7a5deb51; docs site build passes (52 pages)
- [x] 9. Docs: 8.0.0+ release gaps and full docs review (owner request 2026-11-11, Fable high) — evidence: 047441d9; findings verified against source; docs build passes
- [x] 10. Rev 2: skip taken derived ids; profile precedence sentence (spec §3.2, §3.7, rulings §5.5-5.6) — evidence: a02ce5d2 spec, 649a87c3 code (parse/conformance/reimport 62 pass; 2 new fail without fix), 3d246200 profile
- [x] 11. Rev 3: entity wipe (spec §6, rulings §5.8-5.10) — evidence: aba5aece spec, c6a7e900 core (forgetWipe 12/12, 8 fail without), 2eeaaafe react (76/76), 4923ed6b docs; full build + typecheck + pnpm test green, docs build passes
- [ ] 8. Whole-branch verification and cleanup — evidence:

## Discrepancies

- 2026-11-11 — ledger created; disk matches (spec only, no code changes on the branch).
