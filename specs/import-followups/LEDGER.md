# Import follow-ups — ledger

In flight: 1. #367 hook guard in importDump

- [ ] 1. #367 guard the no-vector hook call (spec §1) — evidence:
- [ ] 2. #366 default valid_from newest, capped at now (spec §2) — evidence:
- [ ] 3. core-okf SHA-256 + UTF-8 encoder (spec §3.3, §3.4) — evidence:
- [ ] 4. deriveEventId (spec §3.2–§3.4) — evidence:
- [ ] 5. parseOkfBundle derived ids + plain unescape (spec §3.1, §3.6) — evidence:
- [ ] 6. Re-import tests against a real store (spec §3 T21–T26) — evidence:
- [ ] 7. Profile and docs (spec §3.7, §4) — evidence:
- [ ] 8. Whole-branch verification and cleanup — evidence:

## Discrepancies

- 2026-11-11 — ledger created; disk matches (spec only, no code changes on the branch).
