---
title: Serverless & multi-tenant hosting
description: Run Core LLM Wiki per request with one SQLite file per tenant in object storage — the configuration and lifecycle that keep it consistent.
sidebar:
  order: 17
---

A common hosted pattern is **one SQLite file per tenant**, kept in object storage (S3, GCS, R2).
Each request pulls the file, runs the engine in-process, and pushes the file back. This is how
[SynapseTree](https://synapsetree.dev), the hosted Core LLM Wiki service, runs. If you'd rather not run
this yourself, SynapseTree provides it as a service.

## Recommended config

```ts
const wiki = new WikiMemory(db, {
  llmProvider: tenantProvider,       // tenant's own key; implement generateTextWithUsage for exact metering
  config: {
    librarian: { strategy: 'ops' },  // similarity-gated, supersedes instead of overwriting
    maintenance: 'deferred',         // no background maintenance; setup may start a no-model removal drain
    reportLlmUsage: true,            // emit llm_usage diagnostics
  },
  onDiagnostic: (d) => meter.record(tenantId, d),
});
```

## Request lifecycle

1. **Pull** the tenant's `.sqlite` file. Use a conditional fetch (ETag) to skip unchanged files.
2. **Open.** `new WikiMemory(…)` and `await wiki.setup()`. This is cheap when the schema is current. `setup()` starts no background work by default. Leave `drainExternalDeletionsOnSetup` off on a serverless host and let the `'externalDeletions'` job in `runPendingMaintenance` deliver owed removals: that job honours `deadlineMs`.
3. **Handle the request:**
   - `write(entityId, { …, occurred_at: clientTimestamp })`
   - `read(entityId, query, { tokenBudget })`
4. **Optionally run maintenance** within the time you have left:
   ```ts
   const r = await wiki.runPendingMaintenance({ tokenBudget: 20_000, deadlineMs: remainingMs - 1500 });
   ```
   When this resolves the database has no open work, so the file is consistent to push. One exception to "nothing is running": a call to your removal hook that hit `deletionHookTimeoutMs` may still be running in your hook. The engine has stopped waiting for it, and its delete stays owed and is retried on a later run. If you turned on `drainExternalDeletionsOnSetup` and `deadlineMs` cut short the wait for that drain, call `await wiki.drain()` before you push.
5. **Push** the file back. It's consistent, because there's no detached work and no open transaction.

`runPendingMaintenance()` waits for that drain, up to its `deadlineMs`. If you skip step 4, call `await wiki.drain()` before you push. Neither waits for a hook call that already timed out; its delete stays owed.

Skipping step 4 is fine. The backlog carries over to the next request or to a queue worker that
calls `getPendingMaintenance()`.

## Long migrations inside a lease

On a large store, one-time upgrade work can take minutes. If you open the store inside a
time-limited writer lease, refuse that work there and run it out of band:

```ts
import { WikiMigrationRequiredError } from '@equationalapplications/core-llm-wiki';

try {
  await wiki.setup({ migrations: 'refuse' });
} catch (err) {
  if (!(err instanceof WikiMigrationRequiredError)) throw err;
  // err.pendingWork describes it. Release the lease, run `await wiki.setup()` out of lease
  // (resumable), then re-acquire and open with 'refuse' again.
}
```

`'auto'` refuses a schema migration but allows the cheaper `source_ref` normalization step.

## Hard rules

- **Single writer per file.** In-process locks don't protect you across processes, so use a lease.
- **Never persist mid-maintenance** in `'auto'` mode. Use `'deferred'` (the default), or call `drain()` first.
- **Entity IDs come from your auth layer**, never from request input you haven't checked.

The full SynapseTree write-up, covering costs, the MCP surface, and the `entity_id` scheme, is in
[`docs/synapsetree-integration.md`](https://github.com/equationalapplications/expo-llm-wiki/blob/main/docs/synapsetree-integration.md).
