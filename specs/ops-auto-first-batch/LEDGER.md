# ops + auto first batch — ledger

In flight: item 6 of the spec test plan (benchmarks baseline) waits for #357 to merge

- [x] 1. Failing tests — evidence: opsAutoFirstBatch.test.ts. Four tests failed before the fix (no extract call happened). The marker test passed before the fix, by design, because it pins how existing queries treat the marker.
- [x] 2. Anchor before the counter moves — evidence: 126eefcb. New tests 5/5; core 2085/2085.
- [x] 3. Docs note — evidence: fc1c5153. Docs build: 52 pages.
- [x] 4. Full verification — evidence: root pnpm test exit 0; pnpm -r typecheck exit 0.

## Rulings

- Ruling: the docs note is a Starlight `:::caution` aside under "Librarian strategies", not a new section.
  - Why: it sits next to the setting it concerns.
  - Cost if wrong: none.
- Ruling: the anchor helper lives on `MaintenanceService` and `WriteService` reaches it through its existing `maintenanceService` dependency. No new constructor parameter.
  - Cost if wrong: none.

## Discrepancies
