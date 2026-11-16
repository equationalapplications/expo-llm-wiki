# LEDGER — forget-erasure (#401)

Branch `specs/forget-erasure` · baseline main `27f8e5e9` (v9.2.0) · worktree `/mnt/kv-work/build/worktrees/expo-llm-wiki/forget-erasure` (primary checkout held by PR #402's lane — untouched).
SDD progress ledger (live): `.superpowers/sdd/forget-erasure/progress.md` (gitignored).

| Date | Step | Artifact | Spend |
|---|---|---|---|
| 2026-11-16 | step-0 investigation rev 1-2 + Opus r1 (REQUEST CHANGES, 1B/5M/6m all REAL, folded) | `investigation.md`, reviews/investigation-opus-r1.json | $0.4444 |
| 2026-11-16 | Fable r1 (REQUEST CHANGES: B1 version-gate-passes-nothing, compact-time untested) | reviews/investigation-fable-r1.json | $2.7237 |
| 2026-11-16 | B′/F/G experiments + rev 3 | investigation rev 3 | — |
| 2026-11-16 | Fable r2 delta (REQUEST CHANGES: confounded harness) | reviews/investigation-fable-r2.json | $2.0252 |
| 2026-11-16 | unconfounded harness rewrite + re-run + rev 4 (F/G clean w/ option asserted off; H isolates pragma) | investigation rev 4, canary-repro.cjs | — |
| 2026-11-16 | Fable r3 delta | BLOCKED: Claude API 5-h limit, resets 15:30 ET; retry scheduled | $0.0000 |
| 2026-11-16 | spec rev 1 draft + PR opened (draft) | `spec.md`, this LEDGER | — |

Lane spend so far: **$9.7279** (all step-0; implementation not started).
Baseline gates (worktree): build OK; typecheck OK; unit — core 2565/2566 (idThreading wall-clock flake, 13/13 isolated), mcp-server 135/135, react 76/76, expo 12/12, benchmarks 154/154.
| 2026-11-16 14:06 | PAUSED: Claude API 5-h limit (resets 15:30 ET) at Fable r3 delta. Handoff: vault `records/handoffs/2026-11-16-handoff-expo-llm-wiki-401-forget-erasure.md` | — | — |
| 2026-11-16 | Fable r3 delta (resumed after rail reset) | REQUEST CHANGES — BLOCKER (harness canary not tokenizer-stable; postings surface unmeasured) + 3 MAJOR + 3 MINOR, all REAL; folded rev 5 + harness rework; re-measured: F/G/F2/G2 clean both surfaces, B′ NOT clean, pragma load-bearing | $2.5158 |

### Second independent canary run (Fable r4 MAJOR — recorded before spec cites §2)
Fresh full re-run of `node specs/forget-erasure/canary-repro.cjs` by the controller,
independent of the rev-5 run; output reproduced identically. Recorded 2026-11-16T16:02:06-05:00:
```
A  insert + checkpoint (baseline, unicode61)               db:CANARY PRESENT  postings:CANARY PRESENT  wal:clean  integ:ok  segpages:11  deleted-term:["TARGET"]  live-rows:300
B  plain DELETE + checkpoint (option off)                  db:CANARY PRESENT  postings:CANARY PRESENT  wal:clean  integ:ok  segpages:12  deleted-term:[]  live-rows:300
B' plain DELETE + VACUUM (pragma off, option off)          db:CANARY PRESENT  postings:CANARY PRESENT  wal:clean  integ:ok  segpages:12  deleted-term:[]  live-rows:300
C1 FTS5 option only: delete + checkpoint                   db:CANARY PRESENT  postings:clean  wal:clean  integ:ok  segpages:11  deleted-term:[]  live-rows:300
C2 FTS5 option only + VACUUM                               db:clean  postings:clean  wal:clean  integ:ok  segpages:11  deleted-term:[]  live-rows:300
D  pragma ON + option ON: delete + checkpoint              db:clean  postings:clean  wal:clean  integ:ok  segpages:11  deleted-term:[]  live-rows:300
E  pragma ON + option ON: delete + VACUUM (D's config)     db:clean  postings:clean  wal:clean  integ:ok  segpages:11  deleted-term:[]  live-rows:300
F  pragma ON, option OFF: delete + 'optimize' (u61)        db:clean  postings:clean  wal:clean  integ:ok  segpages:7  deleted-term:[]  live-rows:300
G  pragma ON, option OFF: delete + 'rebuild' (u61)         db:clean  postings:clean  wal:clean  integ:ok  segpages:7  deleted-term:[]  live-rows:300
H  pragma OFF, option OFF: delete + 'rebuild' (u61)        db:CANARY PRESENT  postings:clean  wal:clean  integ:ok  segpages:7  deleted-term:[]  live-rows:300
F2 pragma ON, option OFF: delete + 'optimize' (porter)     db:clean  postings:clean  wal:clean  integ:ok  segpages:7  deleted-term:[]  live-rows:300
G2 pragma ON, option OFF: delete + 'rebuild' (porter)      db:clean  postings:clean  wal:clean  integ:ok  segpages:7  deleted-term:[]  live-rows:300
H2 pragma OFF, option OFF: delete + 'rebuild' (porter)     db:CANARY PRESENT  postings:clean  wal:clean  integ:ok  segpages:7  deleted-term:[]  live-rows:300
sqlite 3.53.4 via better-sqlite3 13.0.3 (reported by SELECT sqlite_version(), not hard-coded)
```
| 2026-11-16 | Fable r4 delta | APPROVE WITH NITS — 2nd independent canary run recorded above; 3 anchor/scope nits folded (rev 6). Investigation converged | $1.8097 |
| 2026-11-16 | haiku verify delta (down-ladder fold check) | REQUEST CHANGES — 3 MAJOR + 3 MINOR all REAL, folded rev 7/spec rev 3; K/K2 composed-sequence scenarios measured CLEAN; ATTACH probed [V] | $0.0359 |
| 2026-11-16 | haiku verify2 delta | REQUEST CHANGES — 2 MAJOR (§6 GC step missing; §7 test two-tier pin + §8 Q5/owner D) + 2 MINOR + 1 NIT, folded rev 8/spec rev 4 | $0.0693 |
| 2026-11-16 | haiku verify3 delta | REQUEST CHANGES — §7 fixture pinned non-vacuous (+ two-fact GC survival, hookless full-wipe); §6 dead clause removed; retired-only merge confirmed [V]; folded rev 9/spec rev 5 | $0.0763 |
| 2026-11-16 | haiku verify4 delta | APPROVE WITH NITS — investigation CONVERGED at rev 10; 3 citation nits folded (controller-verified against source) | $0.0276 |
