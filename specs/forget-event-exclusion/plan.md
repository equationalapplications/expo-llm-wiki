# Forget-event exclusion — plan

Spec: `specs/forget-event-exclusion/spec.md`

1. Schema v19, Rust pin 19 + fixtures, `mapEvent`; tests 1, 17.
2. `EventRepository` content-read filters, `findLiveIds`, counts; tests 7, 8, 9.
3. `markForgotten`, `countForgettable`, forget branch and dry run; tests 2, 3, 11.
4. Ops/legacy exclusion end to end; tests 4, 5, 6.
5. Re-check `reason`; test 10.
6. Prune `deleteForgotten` and checkpoint decrement; erase walk, gate, canary; tests 12, 13, 16.
7. Export/import/OKF; tests 14, 15.
8. Docs, as-landed notes, INTENT amendment.
