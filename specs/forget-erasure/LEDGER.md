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

Lane spend so far: **$39.1792** (all spec-stage; implementation not started).
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

### Third full canary run — now including K/K2 (T3 M7.7: prior second run predates K/K2)
Recorded 2026-11-16T16:22:46-05:00; all 13 scenarios fresh:
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
K  pragma ON, option OFF: delete +'optimize'+VACUUM+ckpt   db:clean  postings:clean  wal:clean  integ:ok  segpages:7  deleted-term:[]  live-rows:300
K2 pragma ON, option OFF: delete +'rebuild'+VACUUM+ckpt    db:clean  postings:clean  wal:clean  integ:ok  segpages:7  deleted-term:[]  live-rows:300
sqlite 3.53.4 via better-sqlite3 13.0.3 (reported by SELECT sqlite_version(), not hard-coded)
```
| 2026-11-16 | T3 Opus spec r1 (full) | REQUEST CHANGES — 1 BLOCKER (GC-by-absence destroys storeSource data → positive predicate + owner Q-E) + 7 MAJOR (fixture premise, dry-run, wrapped VACUUM, retired tables, no v18 migration, closed gate, 7-step composition) + 7 minors; all REAL, folded spec rev 6 / investigation rev 11 | $2.2466 |
| 2026-11-16 | T3 Opus delta r2 | REQUEST CHANGES — B1 (GC list empty in documented recipe → durable source_gc_pending ledger + same-tx liveness check) + M1 (Release/v18 contradiction) + M2 (wrapper layering, syncEntries placement) + 3 minors; folded spec rev 7 | $0.4068 |
| 2026-11-16 | T3 Opus delta r3 | REQUEST CHANGES — wrapper-location self-contradiction, holds-reporting scope (event holds are diagnostics not throws, verified :436-439), ledger same-tx pin + crash test, 4 minors; folded spec rev 8 | $0.3586 |
| 2026-11-16 | T3 Opus delta r4 | REQUEST CHANGES — 2 MAJOR (stale duplicate files entry; ledger key source in-tx → bulkDeletePruned key return) + 5 minors (step order repinned, broken sentence, wording, INTENT note); folded spec rev 9 | $0.4988 |
| 2026-11-16 | T3 Opus delta r5 | REQUEST CHANGES — 1 MAJOR (GC key matching vs two-unique-index model, verified) + 5 minors (RETURNING pinned, 8-step, status, crash-injection point, packet expanded); folded spec rev 10 | $0.5122 |
| 2026-11-16 | T3 Opus delta r6 | REQUEST CHANGES — 2 MAJOR (no-setup branch would break prune; retainEventsFor null pin) + 3 minors, verified + folded spec rev 11 | $0.4142 |
| 2026-11-16 | T3 Opus delta r7 | REQUEST CHANGES — 2 MAJOR (GC gate tied to wrong condition — ledgerOn is vector-removal; deletedIds type change would break id flows) + 3 minors, verified + folded spec rev 12 | $0.4338 |
| 2026-11-16 | T3 Opus delta r8 | REQUEST CHANGES — 2 MAJOR (event-hold reporting impossible under null pin, verified :406/:435-439; source_ref nullability) + 3 minors; folded spec rev 13 | $0.4607 |
| 2026-11-16 | T3 Opus delta r9 | REQUEST CHANGES — 1 MAJOR (stale event-hold paragraph) + 2 minors; folded spec rev 14 | $0.3119 |
| 2026-11-16 | T3 Opus delta r10 | REQUEST CHANGES — 1 MAJOR (re-stored document destruction via ref-OR-hash match → hash-agreement predicate + new test) + 4 minors (recipe de-pruned, pruneSupersededAfter caveat, entity enumeration/busy-skip, status); folded spec rev 15 | $0.4513 |
| 2026-11-16 | T3 Opus delta r11 | REQUEST CHANGES — 1 MAJOR (GC rule vs NULL-hash test case → exact two-clause rule) + 5 mechanical minors; folded spec rev 16 | $0.4301 |
| 2026-11-16 | T3 Opus delta r12 | APPROVE WITH NITS — **T3 spec ladder CONVERGED at rev 17** (full + 7 deltas); nits folded (syncedIds superset contract, status) | $0.3984 |
| 2026-11-16 | T4 Fable spec gate r1 | REQUEST CHANGES — BLOCKER-1 (INTENT rule-5 contradiction → v1 default = document-as-host-property, GC gated on rule-5 amendment + owner E) + MAJOR-1 (exact-pair predicate) + MAJOR-2 (tasks enumeration) + 8 minors; folded spec rev 18 / investigation rev 12 | $4.7428 |
| 2026-11-16 | T4 Fable delta r2 | REQUEST CHANGES — 3 MAJOR ('compact' lock design hole; 5 unconditional GC references; fact-path tier whole-file contradiction under v1 default) + 5 minors; folded spec rev 19 | $3.0438 |
| 2026-11-16 17:20 | PAUSED: 5-h limit mid-T4-delta-2 (no verdict; stub archived). Reset 20:30 ET; resume cron-armed | $2.6684 (partial, kept on lane total) |
| 2026-11-16 20:42 | T4 Fable delta r3 (relaunch of the 17:20 partial) | REQUEST CHANGES — 3 MAJOR (lock-design self-contradiction → bypass = compact-key check inside prune case + external standalone-runPrune refusal; NULL-match clauses impossible vs NOT NULL source_documents schema — delta-8 nullable was entries table; Release GC-migration wording unconditional) + 5 minors (compact case list, passagesDisabled ledger-gated, 2 cites, fixture sentence, validator receipt); all verified REAL, folded spec rev 20 | $3.1187 |
| 2026-11-16 20:52 | T4 Fable delta r4 (rev 20) | REQUEST CHANGES — 2 MAJOR (wal_checkpoint result row discarded via execAsync → both checkpoints via getFirstAsync + surfaced busy/log mismatch + two-connection test; rev-20 lock wording self-contradiction → named owner mechanism (_runPrune owner arg) + compact acquisition mirrors global_reembed any-active refusal) + 6 minors (cite fix :752, lower-bounded wording, ftsCorruptionClass routing, cutoff param not shared-method change, forget→compact-only variant, WikiBusyOperation release note); all verified REAL, folded spec rev 21 | $2.8532 |
| 2026-11-16 21:06 | T4 Fable delta r5 (rev 21) | REQUEST CHANGES (narrow) — 2 MAJOR (per-arm compact-check enumeration missed global_reembed → replaced with ONE universal pre-check beside :193-195; "safe under default arm note" misread types.ts:1203-1207 breaking-change note → precedent stated + owner question F) + 6 minors (prune-arm reword, compact self-check + test, syncChain-chained drain variant, owner = 4th param, INTENT:137 anchor, :13 cite); all verified REAL, folded spec rev 22 | $3.0345 |
| 2026-11-16 21:19 | T4 Fable delta r6 (rev 22) — FINAL round per cron cap | REQUEST CHANGES — 2 MAJOR (unfenced engine write path: write()/remember() run unlocked → fence boundary stated, step-5 failure = reported retryable, deterministic test; global_reembed interleave premise DISPROVED by key shape :89 vs :154 → explicit statement + reverse test folded as hardening) + 5 minors (documented FTS5 command form, step-4 re-run after step 6, "discards" wording, ForgetParams/ForgetResult release note, non-WAL checkpoint note); all prior folds held; folded spec rev 23 | $3.0665 |
| 2026-11-16 21:20 | **PAUSED — T4 NOT CONVERGED** (delta majors held at 2 ×3 rounds → early hand-off checkpoint to Kurt; next delta is his call) | — | — |
| 2026-11-16 21:57 | T4 Fable delta r7 (rev 23) — owner-ruled confirming round | REQUEST CHANGES — 1 MAJOR (source_ref_index tombstones: forget/re-ingest soft-delete them, only clearAll hard-deletes, runPrune never touches the table → tombstone keeps erased ref/hash in file post-compact; fold = new step 1b hard-delete + census row + owner question G) + 4 minors (enableFTS phantom option → UnavailableIndexStrategy probe; edges census row; activeIngestJobs separate set; 3 cite drifts); all verified REAL, folded spec rev 24 | $3.8404 |
