# `auth --email` repeats the remedy error on every poll (#326)

**Status rev 1 (2026-11-02; superseded by rev 2):** Draft — not started.
**Status rev 2 (2026-11-02, PR #330; current):** IMPLEMENTED. All five §10 questions were answered by the owner on 2026-11-02, each keeping the default: (1) de-dup key = error code alone; (2) 30 s ceiling; (3) no heartbeat; (4) adopt a remedy body's `interval`; (5) waiting line unchanged. An independent Fable review agreed with all five, as had the earlier Opus review. So no code or test changed from the §3 defaults. Added during implementation: the deadline-clamp fix in §8a.
**Date:** 2026-11-02
**Branch:** `docs/spec-auth-email-remedy-poll`
**Source baseline:** `40ff88b6` (main after PR #322); rebased 2026-11-02 onto `c6ce6e6e` (7.17.0). `authmd.ts` and its test file are byte-identical between the two, so every code anchor below still holds. `specs/mcp-server/spec.md` changed elsewhere (#323, #328), but the two bullets §6 amends are verbatim unchanged (§7 step 3 remedy bullet ~L452-456, §12.1 L623).
**Issue:** #326
**Package spec of record:** `specs/mcp-server/spec.md` (§7 the auth.md flow, §12.1 unit tests). This spec amends two of its bullets (§6 below) and contradicts nothing else in it.
**Intent check:** INTENT rule 1's scope note (the `mcp-server` door holds the user's key and calls the SynapseTree API; it embeds no engine and calls no model) is untouched: the change is to how often one stderr line is printed and how often one unauthenticated poll is sent. Rule 6 ("Honest reporting", nothing dropped silently) is kept: every distinct account wall is still reported the moment it is first seen, and reported again whenever it recurs; what stops is the *repeat* of an unchanged report. Rule 10 (status lines tell the truth) is met by amending `specs/mcp-server/spec.md` §7/§12.1 in the same PR as the code. Rule 7 (no invisible spend) is not engaged: no model call, no token budget. No INTENT amendment is needed, and no charter promise is touched.

**Delivery:** one PR, draft until implemented, per `specs/README.md`. Commit type `fix(mcp-server):`, so semantic-release cuts a patch on the lockstep version (§7). No `BREAKING CHANGE` footer; no body line may begin with those words. Nobody edits `CHANGELOG.md` or any `"version"` field.

---

## 1. Problem

During the G4 live run on 2026-11-02 (production, the packed #323 tarball), the account was on the Hobby plan with no free database slot. `synapsetree-mcp auth --email` registered, the human approved, and the token endpoint then answered `database_quota_exceeded` on every poll. The CLI printed the remedy pair (the error line, then `Waiting; approve again once it is fixed.`) on every poll: 46 times in about four minutes. 46 polls at the 5 s default is ~230 s, which matches the reported wall-clock, so the loop was running at the registration interval the whole time. The server behaved as the contract says; the noise is entirely client-side.

## 2. Root cause (verified against source)

`registerByEmail` (`packages/mcp-server/src/authmd.ts` L39-125) handles the three account-wall codes in the `default` arm of the poll switch (L116-121):

```ts
default:
  if (REMEDY_CODES.has(body.error)) {
    opts.info(`${body.error}: ${body.error_description ?? 'the account owner must clear this in the dashboard'}${body.error_uri ? ` — ${body.error_uri}` : ''}`);
    opts.info('Waiting; approve again once it is fixed.');
    continue;
  }
```

Three facts make the repeat unavoidable today:

1. **No memory of what was printed.** The loop carries `ambiguousPoll` (L56) and `intervalSeconds` (L59) across iterations and nothing else. Each remedy answer is handled as if it were the first.
2. **No pacing change.** The arm `continue`s without touching `intervalSeconds`, so the next sleep (L71) is the same `min(max(intervalSeconds, 1), 60, remaining)` as before. The server-sent `interval` member, which the contract allows on any `OauthErrorBody` (`packages/mcp-server/contract/synapsetree-openapi.subset.json`, schema `OauthErrorBody`: `interval` is an optional integer ≥ 1 on the one error schema the token endpoint uses), is read only on `authorization_pending` (L104) and `slow_down` (L107); a remedy body's `interval` is ignored, so we cannot tell from the run whether the server sent one.
3. **The wall persists by design.** The contract describes the three codes as "account walls a human must clear, after which the agent resumes polling (the claim grant survives until its TTL)". Until the human acts in the dashboard and approves again, every poll gets the same answer. `packages/mcp-server/src/commands.ts` L147 wires `opts.info` straight to `io.err`, i.e. one stderr line per call (`cli.ts` L14), so each poll costs the user two lines.

Everything else about the loop is sound and stays: the 1 s floor on any interval (L59, L104, L107), the 60 s per-sleep cap and the never-past-the-deadline bound (L71), the deadline check that throws `invalid_grant` once `remaining <= 0` (L65-66), the transient-error arm (L76-88: 5xx, status 0, 408 and 429 keep polling; 429 adds 5 s; the others mark `ambiguousPoll`), and `ambiguousPoll`'s effect on the `invalid_grant` message (L109-115). Note that `oauthToken` is single-attempt inside the client (`client.ts` L161-166), so each 429 answer reaches this loop as one `SynapseTreeError` and adds 5 s once.

## 3. Proposed change

All of it is inside `registerByEmail`. No new exports, options, or types; `AuthmdOptions`, `RegisterResult` and `ClaimError` are unchanged.

### 3.1 Print each remedy once per occurrence

Add one loop-scoped variable, `lastRemedy: string | null = null`, holding the `error` code of the most recently printed remedy.

- **Key.** The de-duplication key is `body.error` alone. `error_description` and `error_uri` are rendered into the line but do not take part in the comparison: the code names the wall the human must clear, the dashboard shows the specifics, and a server that varies its description text (a counter, a timestamp) must not be able to reopen the noise. (Open question 1.)
- **Print** both lines, in today's order and with today's exact text, when `body.error !== lastRemedy`; then set `lastRemedy = body.error`. Otherwise print nothing.
- **Reset** `lastRemedy = null` on an `authorization_pending` answer and on a `slow_down` answer. Both mean the claim is pending and no wall is in force (RFC 8628 §3.5: `slow_down` is `authorization_pending` with a pacing hint). A wall that then comes back is printed again.
- **Do not reset** on the transient-error arm (5xx, status 0, 408, 429). A network blip inside a wall says nothing about the wall; printing again after it would be the bug in a new coat.
- A change of code while a wall persists (for example `database_quota_exceeded` then `key_limit_reached` once the slot is freed) prints the new pair once, because the key differs.

So the rendered behaviour is: one pair per *occurrence* of a wall, where an occurrence ends when the server reports the claim pending again. The `Waiting; approve again once it is fixed.` line is part of the pair and follows the same rule; its text does not change (open question 5).

### 3.2 Back off while a wall persists

Add one loop-scoped variable, `remedyBackoffSeconds = 0`, and change the sleep at L71 to use `intervalSeconds + remedyBackoffSeconds` in place of `intervalSeconds`. The existing clamp (`max(…, 1)`, `min(…, 60, remaining)`) wraps the sum unchanged. *Note (2026-11-02, see §8a):* as shipped, the clamp's units changed. It now runs in milliseconds, `min(max(sum, 1) × 1000, 60 000, remaining)`, so the deadline term binds. That is a deliberate change to the deadline path, not "unchanged".

- **Schedule.** On every remedy answer (printed or not, same code or not): `remedyBackoffSeconds = Math.min(remedyBackoffSeconds + 5, 25)`. At the 5 s default this gives sleeps of 5, 10, 15, 20, 25, 30, 30, … seconds: +5 s per answer, the same step `slow_down` and a 429 use (L83, L107), reaching its ceiling after five answers.
- **Ceiling.** The backoff itself adds at most 25 s, so a default-interval wall settles at **30 s** between polls. That is a deliberate half of the existing 60 s cap. The 60 s cap (L71) is a safety bound against hostile or buggy intervals, not a target, and it stays exactly where it is: a server interval of 60 plus any backoff still sleeps 60. The deadline bound is likewise untouched: the sum is still clamped to `remaining`, and the loop still throws `invalid_grant` at `remaining <= 0` (§4).
- **Why 30 s and not 60 s.** The human's path out of a wall is: fix it in the dashboard, then approve the emailed link again (that is what the Waiting line tells them). The CLI only learns of the approval at its next poll, so the backed-off interval is also the worst-case delay between the click and `Approved. Key stored.` At 30 s the delay is uniform in [0, 30] s (mean 15 s); at 60 s it is up to a minute at a terminal the person is watching. The pointless-poll side of the trade is small either way: over a wall that lasts the whole 16-minute window the loop sends ~192 polls today, ~35 with a 30 s ceiling, ~22 with a 60 s ceiling, against an endpoint the contract says has no per-IP rate limit in v1. Going from 192 to 35 captures nearly all of the saving; the last 13 polls are not worth a doubled wait after approval. (Open question 2.)
- **Server-sent `interval` on a remedy answer.** If the body carries a numeric `interval`, adopt it exactly as `authorization_pending` does (`intervalSeconds = Math.max(1, body.interval)`), then apply the backoff step on top. RFC 8628 §3.5 makes the server's interval a minimum, so polling slower than it is always permitted; the backoff never makes the CLI faster than the server asked. Today the member is ignored on this arm; honouring it is a one-line alignment with L104 and is in scope because the issue asks how the two interact. (Open question 4.)
- **`slow_down` and `authorization_pending`** set `intervalSeconds` as today (L104, L107) and reset `remedyBackoffSeconds = 0`, at the same moment they reset `lastRemedy`. The wall is over; the loop returns to server-governed pacing so a fresh approval is noticed at the normal interval.
- **429** keeps its current `intervalSeconds += 5` (L83) and does not touch the backoff; the two add, and the 60 s cap bounds the sum. **5xx, status 0 and 408** change neither variable, as today.
- **Reset summary.** Both new variables reset together on `authorization_pending` and `slow_down`; neither resets on a transient error; both are dropped when the loop exits (200, `invalid_grant`, unknown error, deadline).

### 3.3 No heartbeat

No "still waiting" line is added. Reasons: the ordinary pending state is already silent for up to 16 minutes and nobody has asked for a heartbeat there; the opening line sets the expectation ("usually within a minute; it expires in 15 minutes"); the Waiting line says the CLI continues; the deadline message ends the wait with a clear instruction. A periodic line is the noise this issue removes, at a lower rate. (Open question 3 records the alternative.)

## 4. Behaviour that does not change

| Path | Today | After |
|---|---|---|
| Deadline | `deadline = now + 16 min` (L42); sleep clamped to `remaining` (L71); throw `ClaimError('invalid_grant', EXPIRED_MESSAGE)` at `remaining <= 0` (L66) | Identical in intent. *Corrected 2026-11-02 (§8a):* before #326 the `remaining` clamp never bound, so this row described the intended behaviour, not the actual one. It now binds, so the last sleep ends exactly at the deadline and the next iteration throws. Backoff never extends the window. |
| Success | First 200 returns `{ apiKey, accountId }` (L90-96); malformed 200 → `invalid_response` | Identical, including after a wall. |
| `ambiguousPoll` / `invalid_grant` | 5xx, status 0, 408 set the flag; 429 adds 5 s; `invalid_grant` picks the message by the flag (L82-84, L109-115) | Identical. The transient arm touches neither new variable. |
| `authorization_pending`, `slow_down` | Interval handling (L103-108) | Identical, plus the §3.1/§3.2 resets. |
| Unknown `error` | throw `ClaimError(body.error, …)` (L122) | Identical. |
| Non-remedy, non-400 errors | Thrown by the client (`client.ts` L213) and re-thrown (L87) | Identical. |
| `registerAgentIdentity` shape check, token-endpoint pinning, 1 s floor, 60 s cap | L45-52, L59, L71 | Identical, with one exception (§8a, 2026-11-02): the single last sleep before the deadline can be shorter than 1 s, because the now-binding deadline clamp wins over the floor. That is one final poll, not repeated polling. |
| Output text | The two opening lines; the remedy line format; the Waiting line | Identical text; only the repeat count changes. The claim token and the key still appear in no line. |

## 5. Files touched

| File | Change |
|---|---|
| `packages/mcp-server/src/authmd.ts` | §3.1, §3.2: two loop variables, the remedy arm, the sleep expression, the two reset points |
| `packages/mcp-server/__tests__/authmd.test.ts` | §8 tests; the existing remedy test gains a sleep assertion |
| `specs/mcp-server/spec.md` | §6 amendments to §7 step 3 and §12.1 (same PR) |
| `specs/auth-email-remedy-poll/spec.md` | this file; Status flips in the cleanup commit |

Not touched: `commands.ts` (the `info: io.err` wiring is right), `client.ts`, the README (it describes the happy path only), the docs site (no page names the remedy codes), the vendored contract, `specs/mcp-server/plan.md` (a transient kept past merge by the §3 ruling; its L2463 quotes the old arm as history).

## 6. Amendments to `specs/mcp-server/spec.md`

Made in the implementation PR, as appended text rather than rewrites, with a dated note:

- **§7 step 3, the remedy bullet** (currently: "print `error_description` and `error_uri` if present …, then keep polling; the claim stays valid until it expires and the human can clear the problem and approve"). Append: printed once per occurrence, keyed on the `error` code, reprinted when the code changes or after an `authorization_pending`/`slow_down` answer; a body `interval` is adopted like `authorization_pending`; each remedy answer adds 5 s to the sleep up to +25 s (30 s at the default), reset by `authorization_pending`/`slow_down`; the 60 s cap and the deadline are unchanged. Cite this spec.
- **§12.1 `authmd` bullet** ("each remedy code keeps polling"). Append: a persisting remedy prints once and its sleeps never decrease while the server's stated interval holds (a remedy body that lowers `interval` may lower the sleep; the backoff component itself never shrinks until `authorization_pending` or `slow_down` resets it); the code change, clear-and-recur, transient-error, server-interval and deadline cases of §8 below.
- §2 rulings table: no new ruling is needed; R7 (the registration response carries `poll.interval`, replaceable by pending/slow-down) is honoured and extended, not reopened.

## 7. Release

The code change is `fix(mcp-server): …`, a patch on the lockstep version that semantic-release computes from `main` (INTENT "How changes are made" 4; `specs/mcp-server/spec.md` §3 "Versioning is lockstep and automatic"). PR #323 (merged `0d071811`) wired the package into `.releaserc.json` and `release.yml`, so this fix ships in the next patch of the lockstep version. No `BREAKING CHANGE` footer: nothing public changes shape, and no line of the commit body may start with those two words (a body line that does parses as a footer and forces a major). Merge commit, never squash.

## 8. Test plan (tests first; each new test fails on baseline where stated)

All tests use the existing `scenario()` harness in `authmd.test.ts` (L11-30): scripted responses, `waits` (ms per `sleep`), `lines` (every `info` call), a fake clock advanced by the sleeps, default 16-minute deadline. `REG` has `poll.interval: 5`. Let `Q = { status: 400, body: { error: 'database_quota_exceeded', error_description: 'no free slot', error_uri: 'https://synapsetree.dev/dashboard' } }`, `K` the same with `error: 'key_limit_reached'`, `P = { status: 400, body: { error: 'authorization_pending' } }`, `WAIT = 'Waiting; approve again once it is fixed.'`. "Remedy lines" means `lines.filter(l => l.startsWith('database_quota_exceeded'))` or the `key_limit_reached` equivalent; the two opening lines (L61-62) are always present and are excluded from the counts below.

1. **Persisting wall: one pair, additive backoff, 30 s ceiling.** `[REG, Q, Q, {…Q, body: {…Q.body, error_description: 'still no free slot'}}, Q, Q, Q, MINT]`. Resolves with `apiKey`. `waits` equals `[5000, 10000, 15000, 20000, 25000, 30000, 30000]`. Remedy lines: exactly 1; `WAIT`: exactly 1; `lines.slice(2)` equals `[<remedy line containing 'no free slot' and the uri>, WAIT]`. The varied fourth answer also pins the §10 question 1 key: it differs from the first body only in `error_description`, so an implementation keyed on the full rendered line would reprint here and fail. *Fails on baseline* (6 pairs; flat 5000s).
2. **Code change reprints once.** `[REG, Q, Q, K, K, MINT]`. `waits` = `[5000, 10000, 15000, 20000, 25000]`. `lines.slice(2)` = `[<quota line>, WAIT, <key_limit line>, WAIT]`. *Fails on baseline.*
3. **Clear then recur reprints and resets.** `[REG, Q, Q, P, Q, MINT]`. `waits` = `[5000, 10000, 15000, 5000, 10000]` (the `P` answer resets the backoff; the fourth sleep is the registration interval again). Quota lines: 2; `WAIT`: 2. *Fails on baseline* (3 pairs; flat).
4. **`slow_down` counts as a clear.** `[REG, Q, {400 slow_down, no interval}, Q, MINT]`. `waits` = `[5000, 10000, 10000, 15000]` (slow_down sets the interval to 10 and zeroes the backoff; the next remedy adds 5). Quota lines: 2. *Fails on baseline.*
5. **Transient error inside a wall: no reprint, no reset.** `[REG, Q, {503, {code:'unavailable'}}, Q, MINT]`. `waits` = `[5000, 10000, 10000, 15000]`. Quota lines: 1. *Fails on baseline* (2 pairs). (The 503 reaches the loop as one thrown `SynapseTreeError`: `oauthToken` is single-attempt in the client.)
6. **429 inside a wall adds to the backoff.** `[REG, Q, {429, {error:'rate_limited'}}, Q, MINT]`. `waits` = `[5000, 10000, 15000, 20000]` (429 → interval 10; remedy → backoff 10). Quota lines: 1. *Fails on baseline.*
7. **Server interval on a remedy body is a floor.** `[REG, {…Q, body: {…Q.body, interval: 20}}, Q, MINT]`. `waits` = `[5000, 25000, 30000]`. *Fails on baseline* (`[5000, 5000, 5000]`).
8. **60 s cap still binds.** `[REG with poll.interval 60, Q, Q, MINT]`. `waits` = `[60000, 60000, 60000]`. Quota lines: 1. *Sleep assertion passes on baseline; the line count fails.*
9. **Deadline still ends a wall, and sleeps never decrease.** `[REG, Q × 40]`. Rejects with `code: 'invalid_grant'` and `/expired/`. `s.calls.length` = 36 (one registration + 35 polls: sleeps 5+10+15+20+25+30 = 105 s, then 28 × 30 s to 945 s, then one 15 s sleep to the deadline, then the throw). `Math.max(...waits)` = 30000; `waits.at(-1)` = 15000; every `waits[i] >= waits[i-1]` except that final clamped sleep. Quota lines: 1. *Fails on baseline* (line count; call count).
10. **Existing remedy test** (L136-147: each of the three codes once, then `MINT`) stays as is and additionally asserts `waits` = `[5000, 10000]`. The description and uri assertions already there prove the rendered line is unchanged.
11. **Existing tests** L40-134 and L149-173 pass unmodified (pending/slow_down intervals, 408 and zero-interval clamp, exact-deadline throw, 1e9 cap, endpoint pinning, ambiguous-poll message, 429, invalid_grant, unknown error, registration quota, deadline, no secrets in lines).
12. `pnpm --filter @equationalapplications/mcp-server test`, `typecheck` and `build` green; root `pnpm test` green.

### 8a. Found during implementation (2026-11-02)

Test 9 exposed a bug that predates this change, in the sleep expression §3.2 modifies: `Math.min(…, 60, remaining)` compared `remaining` (milliseconds) with seconds, so the deadline clamp in §4's table never bound, and the last sleep could run up to 60 s past the deadline. That breaks the "never past the deadline" promise in `authmd.ts`'s own comment and in `specs/mcp-server/spec.md` §7 step 4. Fixed in the same commit: `remaining / 1000`. A new test on the plain pending path (7 s interval, which does not divide 960 s) pins it. Both tests fail on the old line. §4's "Deadline" row is now true, where before it was only claimed.

Review of PR #330 (2026-11-02) refined this. The first form, `min(…, 60, remaining / 1000) × 1000`, round-tripped milliseconds through seconds, which is inexact for many values: 1003 gives 1002.9999999999999. The clamp now runs in integer milliseconds, and a test with a deadline 3 ms past a whole second pins it. One more behaviour the reviews noted, accepted by design and pinned by test 4: after a long wall, a bare `slow_down` resets the backoff and sets the interval to base + 5 s, so the next sleep can be shorter than the last backed-off one (30 s → 10 s at the default). The backoff is client policy. The server's interval, which `slow_down` raises, governs the pending state.

## 9. Out of scope

- Any change to the SynapseTree server (whether it sends `interval` or `error_uri` with a wall, whether a cleared wall returns the claim to pending or mints on the next poll). The loop handles both orders.
- A `--quiet` flag, a progress spinner, or structured (JSON) progress output.
- The stale comment at `authmd.test.ts` L122-123 ("three 429s exhaust the client's internal retries"; the client has been single-attempt on `oauthToken` since `ca3390d4`). The test's assertion is still right. The implementer may fix the comment in passing; it is not a task.
- Backoff for the plain `authorization_pending` state. The server governs that interval (R7) and the user is waiting on an email, not on the dashboard.

## 10. Open questions for Kurt (answered 2026-11-02: all five defaults kept, see Status rev 2)

1. **De-duplication key.** Default: the `error` code alone (§3.1). Alternative: the full rendered line (code + description + uri), which would reprint if the server changes its wording. Recommendation: the code; the dashboard carries the detail, and the key must not be reopenable by a variable description.
2. **Backoff ceiling.** Default: +5 s per remedy answer up to +25 s, i.e. 30 s at the default interval (§3.2). Alternative: climb to the existing 60 s cap, as the issue sketches. Recommendation: 30 s; it keeps the post-approval wait under half a minute and still removes ~80 % of the polls.
3. **Heartbeat.** Default: none (§3.3). Alternative: one line, `Still waiting; approve again once it is fixed.`, at most once per five minutes while a wall persists, which would add at most three lines over the window. Recommendation: none; the pending state has never had one.
4. **Server `interval` on a remedy body.** Default: adopt it as the base interval, like `authorization_pending` (§3.2). Alternative: keep ignoring it, as today. Recommendation: adopt it; RFC 8628 makes it a floor and the server owns pacing.
5. **Waiting-line wording.** Default: unchanged. Alternative: `Waiting (checking less often, up to every 30 s); approve again once it is fixed.`, which tells the user why approval may take up to half a minute to register. Recommendation: unchanged for this fix; revisit if the 30 s delay draws a report.

## 11. Self-review

- Checked against `INTENT.md` (rules 1, 6, 7, 10; "How changes are made" 1, 3, 4): see the Intent check line. No rule Status changes.
- Checked against `specs/mcp-server/spec.md`: §7 step 3 and §12.1 are the only bullets affected (§6); R7 is honoured; §0 gates, §3 wiring, §5.5 ("injectable `sleep`, so a test runs the whole flow in milliseconds") are relied on, not changed.
- Every source claim carries a file and line against baseline `40ff88b6`.
- Every decision in §3 is pinned by at least one §8 case with exact `waits` and line counts.
- 2026-11-02: an independent adversarial pass re-derived every §8 wait sequence and the §3.2 poll counts (the 60 s-ceiling alternative is 22 polls, not 21) and found two gaps, fixed in this revision: test 1 now varies `error_description` so the §10 question 1 key is pinned (an implementation keyed on the rendered line passed all prior cases), and the §12.1 amendment's monotonicity claim is qualified for a server that varies `interval`.
