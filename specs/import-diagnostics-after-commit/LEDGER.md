# Import diagnostics after commit — ledger

In flight: 4

- [x] 1. Re-run the audit on current main — evidence: spec amended; only `:458` was inline
- [x] 2. Failing tests written — evidence: tests commit; 4 of 5 failed on main (case 3 passes, case 5 only had the pointer diagnostic to fail on)
- [x] 3. Inline emit becomes a buffered push — evidence: vitest run importDiagnosticsAfterCommit + sourcePointers, 25 passed
- [ ] 4. Full suite and typecheck — evidence:

## Discrepancies

