# SynapseTree Integration Guide

This guide documents how **SynapseTree**, a SaaS tenant-aware knowledge store, runs `expo-llm-wiki` as its per-tenant memory backend. SynapseTree keeps one SQLite file per tenant in object storage (S3), pulls the file at the start of each request, runs the wiki engine in-process, and pushes the file back when the request ends. Every responsibility below maps to a piece of that lifecycle.

The guide follows the [2026-09-29 competitive-memory design spec](../superpowers/specs/2026-09-29-competitive-memory-design.md) (target release **7.8.0**) and the spec's host-responsibility section (§6.5) — host-fulfilled contracts the engine does not implement.

> **Audience:** SynapseTree backend and platform engineers integrating `expo-llm-wiki` as a tenant-aware knowledge store. Assumes familiarity with the wiki's core API at [`packages/core/README.md`](../../packages/core/README.md).

---

## 1. Recommended configuration

Use this baseline when wiring the wiki into a SynapseTree tenant request. The three `config` flags are tuned for hosted usage; everything else stays at engine defaults unless a tenant-specific override is needed.

```typescript
const wiki = new WikiMemory(db, {
  llmProvider: tenantProvider,               // BYOI: the tenant's key; implement generateTextWithUsage for exact metering
  config: {
    librarian: { strategy: 'ops' },
    maintenance: 'deferred',
    reportLlmUsage: true,                    // llm_usage diagnostics → metering
  },
  onDiagnostic: (d) => meter.record(tenantId, d),
});
```

What each piece buys you:

- **`llmProvider: tenantProvider`** — bring-your-own-inference. Pass the tenant's own LLM credentials wrapped in the `LLMProvider` interface. Implement `generateTextWithUsage` (not just `generateText`) so the engine can bill `tokenBudget` against provider-reported input/output token counts rather than the `chars ÷ 4` estimator. Without `generateTextWithUsage`, every maintenance call's usage figure is `estimated: true`.
- **`config.librarian.strategy: 'ops'`** — opt in to the ops librarian (extract → similarity gate → single batched resolve). Three-step pipeline that drops no-op candidates before the model sees them and supersedes instead of overwriting, so `read({ asOf })` keeps a usable history. **The default remains `'legacy'`** for this release, so SynapseTree must opt in explicitly to get the similarity-gated gate and the one-call resolve step.
- **`config.maintenance: 'deferred'`** — disables the auto-mode background triggers (`autoLibrarianThreshold`, `autoHealThreshold`). Nothing fires in the background; maintenance runs only when the host calls `runPendingMaintenance`. Without this flag, the librarian and heal can fire as detached promises when a host process is frozen or killed mid-request — bad on serverless or request-scoped runtimes.
- **`config.reportLlmUsage: true`** — turns on the `llm_usage` diagnostic stream. The `UsageMeter` records usage regardless of this flag, but the diagnostic only emits when the flag is on. Set it `true` so `onDiagnostic` can route per-tenant usage to metering.
- **`onDiagnostic: (d) => meter.record(tenantId, d)`** — every diagnostic is content-free (IDs, indexes, counts, reason slugs only) and typed, so a single switch on `d.code` covers `llm_usage`, `read_budget`, `event_retention_held`, `grounding_*`, `background_job_failed`, and the rest. Route the `llm_usage` ones to the metering pipeline and everything else to logs.

The op thresholds under `'ops'` (`dupThreshold=0.89`, `novelThreshold=0.30`) were calibrated against the Phase D rerun — pass them through `config.librarian.gate` if your embedding model differs from the calibrated one, or accept the defaults and re-calibrate later. They are provisional.

---

## 2. Request lifecycle

A SynapseTree request is a single in-process window over one tenant's SQLite file. Five steps, in this order:

1. **Pull `.sqlite` from S3.** Block on the object fetch before constructing the engine. Use ETag/conditional fetch if you want to skip re-pulling a file that has not changed; the engine does not need that signal — `setup()` is cheap on an already-current schema.
2. **`new WikiMemory(...)` + `await wiki.setup()`.** Migrations are additive and idempotent; calling `setup()` on an already-current schema is a no-op. The recommended configuration block from §1 goes here.
3. **Handle the request.** This is the work that produces an answer:
   - **`wiki.write(entityId, { ..., occurred_at })`** — record the user event. Pass `occurred_at` (Unix ms) from the *client's* timestamp, not server now, so a delayed write still represents the moment the event happened. Migration 13 added the nullable `occurred_at` column.
   - **`wiki.read(entityId, query, { tokenBudget })`** — retrieve memory for the answer. `tokenBudget` packs facts only — tasks and events in the bundle are unaffected. The top fact is always included (truncated if it alone exceeds the budget). The result emits a `read_budget` diagnostic with `{ candidates, packed, tokensUsed }` if you want to monitor packing efficiency.
   - For temporal queries: `wiki.history(entityId, factId)` returns the supersession chain; `wiki.read(entityId, query, { asOf })` answers "what was true at T". `traverseGraph(entityId, { ..., asOf })` walks only edges whose facts are both live at that instant.
4. **Optionally `await wiki.runPendingMaintenance({ tokenBudget, deadlineMs })`.** Size both to the invocation's remaining time. **Nothing is still running after this resolves** — the `MaintenanceScheduler` is in-process and synchronous; the call's returned `stoppedReason` tells you why it stopped (`complete | deadline | budget_exhausted | budget_too_small`). When this resolves it is safe to push the file.
5. **Push `.sqlite` back to S3.** The push is consistent because the engine has no detached work, no in-flight transactions, and no scheduler promises.

If you skip step 4, the maintenance backlog carries over to the next request — events pile up until `runPendingMaintenance` is called for that tenant. Under `'deferred'`, `runPrune` will refuse to delete events the librarian has not processed, and emits `event_retention_held` when retention is held back by an unprocessed backlog; surface this diagnostic so SynapseTree ops can re-budget.

### `getPendingMaintenance(entityIds?)`

Before step 4 (or in a separate queue worker), inspect the backlog without calling a model:

```typescript
const pending = await wiki.getPendingMaintenance();
// [{ entityId, pendingEvents, healPending?, unembedPending? }, ...]
// sorted by pendingEvents desc, then entityId asc; entities with no work omitted
```

`pendingEvents` is the librarian's pending batch; `healPending` is the heal backlog; `unembedPending` is unembedded facts waiting on `runReembed`. Use this in a per-tenant queue worker to decide whether to call `runPendingMaintenance` for that file at all — if the backlog is empty, skip the round trip to the model entirely.

---

## 3. Where maintenance runs

Two viable placements for `runPendingMaintenance`. Both rely on the property that **nothing runs after the call resolves**, so the file push that follows is consistent.

### Inline at the end of a request (recommended for shipped readers)

The simplest placement:

```
handle request
  → write / read / traverseGraph
  → await runPendingMaintenance({ tokenBudget, deadlineMs })  // sized to leftover time
push .sqlite
```

Pros: no separate worker to operate, no cross-request state. Cons: maintenance competes with the next request for the tenant's tokens; if a request exits early (timeout, cancellation), the budget you sized for it is wasted.

### Separate queue worker per tenant file

For high-throughput tenants, run a dedicated worker that owns the S3 pull/push and calls `runPendingMaintenance` on a schedule:

```
worker loop:
  pull .sqlite
  open WikiMemory
  pending = getPendingMaintenance()
  if (pending.length === 0) { push .sqlite; return }
  await runPendingMaintenance({ tokenBudget, deadlineMs })
  push .sqlite
```

Pros: maintenance does not compete with live request traffic for the token budget. Cons: you own the worker; two workers must not pull the same file (see §4). If the worker is pre-empted mid-batch, the librarian's progress marker only advances after a batch commits, so re-running from scratch resumes where the watermark is — no events lost, no facts duplicated.

### Budget sizing

`tokenBudget` covers text-generation tokens only; embedding calls are not counted. When `generateTextWithUsage` is implemented, figures are provider-reported; otherwise the engine estimates at `chars ÷ 4` and sets `result.estimated: true`. Plan your budget at the model's worst-case prompt: a single librarian pass holds every event since the watermark plus the manifest block, and a single heal pass holds the candidates and document anchors. **If `stoppedReason.reason === 'budget_too_small'`, one event or one heal batch exceeds your whole budget** — raise that tenant's budget for the next run, or split the work over multiple invocations.

The `tokensUsed` field on `RunPendingMaintenanceResult` is your actual spend; `remaining` is `null` when no `tokenBudget` was supplied.

---

## 4. Single writer

`WikiMemory`'s `JobManager` lock is in-process only. Inside one process, concurrent calls serialize cleanly. Across processes, two writers to the same SQLite file race the same way two writers to any file would: last write wins, lost updates, possibly a corrupt page.

**Sticky routing — one writer per tenant file at a time — is SynapseTree's responsibility.** Two implementation paths:

- **In-process queue.** A single Node.js worker holds one SQLite connection per tenant file; all requests for that tenant are routed to the same worker. The worker's request handler is the only writer; the worker itself owns the S3 pull/push cycle.
- **Cross-process lease.** Acquire a short-lived distributed lock (DynamoDB conditional write, Redis `SET NX EX`, or S3 object lease) on the tenant's file key before pulling. Hold the lease for the duration of the request. Release on push, or let it expire on crash. Two concurrent pullers cannot both hold the lease.

The engine does not detect a duplicate writer; it will silently corrupt under one. `runPrune` will not catch it either. The diagnostic stream is your only safety net for cross-process effects (`background_job_failed` may surface under the wrong tenant ID if routing is wrong), so route carefully.

---

## 5. `entity_id` scheme (review finding M4)

SynapseTree's dashboard schema review surfaced finding **M4**: the wiki's `entity_id` field is a free namespace, and SynapseTree's tenant isolation story depends on how it is partitioned per tenant file. Three options, each with a clear trade-off:

### Option A — one entity per end-user within a tenant file

`entity_id = '<tenantId>:<userId>'`. Each user's memory is isolated inside one tenant file. `read()` is always scoped to one user; `traverseGraph` never crosses users.

- **Pros.** Strong isolation; per-user `forget()` and `exportDump()`; per-user token-cost accounting (`tokensUsed` per call is attributable to a user). The audit story is clean.
- **Cons.** Cross-user queries are awkward — schema v2's social-graph use case (e.g. "what did Alice and Bob work on together?") needs a multi-entity `read()` or a separate join entity. The entity count grows with the user count.

### Option B — one entity per workspace/project

`entity_id = '<tenantId>:<workspaceId>'`. Each workspace is a memory namespace; users within a workspace share it.

- **Pros.** Workspace-scoped reads are natural. The entity count tracks the workspace count, which is bounded. Per-workspace accounting and `forget()` are clean.
- **Cons.** Per-user isolation is gone; user A can see user B's facts through `read()`. Either accept that (typical for "shared team memory" SaaS) or layer an extra row-level filter outside the engine.

### Option C — one constant entity per tenant file

`entity_id = '<tenantId>'`. The file is the namespace; one entity per file.

- **Pros.** Simplest routing. The file → entity mapping is 1:1.
- **Cons.** No isolation inside a tenant. If a single file holds multiple users or workspaces, they share the full memory. Per-user `forget()` becomes "delete the file" or a manual filter.

### Recommendation

Record the decision in SynapseTree's **schema v2** design. **Option A** is the strongest fit if SynapseTree's tenants are end-user accounts (each tenant is a consumer; each user is the memory owner). **Option B** is the strongest fit if tenants are teams or workspaces and shared memory is the product. **Option C** is the right answer only if SynapseTree is purely per-tenant with no internal partitioning.

The wiki does not enforce any of these — it accepts any string. Whatever the choice, the writer in §4 is responsible for picking the right `entity_id` for each request.

---

## 6. MCP surface

SynapseTree's MCP tool surface maps to core calls. The current `core-llm-tools` package exports Gemini tool schemas for a subset; for the rest, SynapseTree wraps its own MCP handlers until the schemas land.

| Core call | Purpose | Tool name (planned/available) | `core-llm-tools` schema shipped? |
|-----------|---------|--------------------------------|-----------------------------------|
| `wiki.read(entityId, query, { tokenBudget })` | Retrieve facts/tasks/events for the answer | `wiki_read` | **Yes** |
| `wiki.write(entityId, { event_type, summary, occurred_at })` | Log an episodic event | `wiki_write` | **Yes** |
| `wiki.traverseGraph(entityId, { sourceId, maxDepth, direction, edgeTypes, asOf })` | Walk GraphRAG edges from an anchor fact | `wiki_traverse_graph` | **Yes** |
| `wiki.supersede(entityId, factId, replacement, { validFrom })` | Replace a fact while keeping history | `wiki_supersede` | **Yes** |
| `wiki.history(entityId, factId)` | Return the supersession chain for a fact | `wiki_history` | **No** (spec §7.4 open item) |
| `wiki.read(entityId, query, { asOf })` | Temporal point-in-time read | folded into `wiki_read` opts | **No** (spec §7.4 open item) |

> **Open item (spec §7.4).** `core-llm-tools` schemas for `history` and `asOf` are **not shipped yet** — the schemas for `read`, `write`, `traverseGraph`, and `supersede` are exported, but the temporal surface lands in a follow-up. SynapseTree should wrap its own MCP handlers for `wiki_history` and the `asOf` form of `wiki_read` until the schema lands, then drop the wrapper.

For now, expose `read`/`write`/`traverseGraph`/`supersede` via `core-llm-tools` schemas, and ship `history`/`asOf` as host-defined tools with input validation that mirrors the core options (the JSON shapes are stable; only the tool schema is missing).

---

## 7. Costs

Token-cost data lives in [`docs/benchmarks.md`](./benchmarks.md). That doc measures the 7.8.0 release against the legacy baseline:

- **Tokens per answer** — packed reads under a `tokenBudget`. The packing is greedy (top fact always included, then by score ÷ estimated tokens) so most well-tuned queries stay under the budget with one fact truncation at most. See the `read_budget` diagnostic (`{ candidates, packed, tokensUsed }`) for per-call visibility.
- **Tokens per ingested token** — measured under the ops librarian with `maintenance: 'deferred'`. The ops gate (`dupThreshold=0.89`, `novelThreshold=0.30`) drops no-op and novel candidates before the model sees them, so the per-event token cost is much smaller than the legacy path. Numbers in `docs/benchmarks.md` are published as measured, including any category where ops underperforms legacy.

The `tokensUsed` field on `RunPendingMaintenanceResult` is your per-request maintenance spend. Multiply by your model's price per 1k tokens (input vs output split if `generateTextWithUsage` is implemented) for the per-tenant cost line. The `llm_usage` diagnostic stream from `onDiagnostic` gives per-call visibility into the same figure.

---

## Cross-references

- [2026-09-29 competitive-memory design spec](../superpowers/specs/2026-09-29-competitive-memory-design.md) — §6.5 host responsibilities, §7.3 docs, §7.4 open item
- [`docs/benchmarks.md`](./benchmarks.md) — 7.8.0 rerun results
- [`packages/core/README.md`](../../packages/core/README.md#deferred-maintenance) — deferred maintenance API, `runPendingMaintenance`, `getPendingMaintenance`
- [`packages/core/README.md`](../../packages/core/README.md#temporal-facts) — temporal API (`supersede`, `history`, `asOf`)
- [`packages/core/README.md`](../../packages/core/README.md#librarian-strategies) — `'ops'` vs `'legacy'` strategies
- Root [`README.md`](../../README.md) — engine overview, retrieval pipeline