---
title: Serverless & multi-tenant hosting
description: Run Core LLM Wiki per request with one SQLite file per tenant in object storage — the configuration and lifecycle that keep it consistent.
sidebar:
  order: 17
---

A common hosted pattern is **one SQLite file per tenant**, kept in object storage (S3, GCS, R2).
Each request pulls the file, runs the engine in-process, and pushes the file back. This is how
the [hosted service](https://synapsetree.dev) runs; if you'd rather not run it yourself, use that.

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

## Writer lease patterns

The lease only has to guarantee two processes cannot hold it at once — but that guarantee holds **only if the lease outlives the request**: set the TTL above the worst-case hold time (including maintenance), or have the holder renew it. A request that outlasts the TTL lets a second writer in, which is exactly the failure this section exists to prevent. On push, check you still hold the lease (a fencing token or holder comparison) before writing. Three workable shapes:

- **DynamoDB conditional write.** `PutItem` with `ConditionExpression: attribute_not_exists(key) OR expires_at < :now`; hold for the request duration; release on push or let it expire on crash.
- **Redis `SET NX EX`.** `SET lease:<fileKey> <holder> NX EX <ttl>`; delete on push only if still yours (compare the holder value); renew before the TTL lapses on long requests.
- **S3 conditional writes.** Take the lease with `PutObject` and `If-None-Match: *` (fails if a lease object already exists); renew or release with `If-Match: <etag>`. Store an `expires_at` in the object body — S3 does not expire it for you, so the *next* writer checks it and treats an expired lease as free.

## Budget sizing

`tokenBudget` on `runPendingMaintenance` covers text-generation tokens only; embedding calls are not counted. With `generateTextWithUsage` implemented, figures are provider-reported; otherwise the engine estimates at `chars ÷ 4` and sets `estimated: true`. Plan at the model's worst case: a single librarian pass holds every event since the watermark plus the manifest block, and a single heal pass holds the candidates and document anchors. If `stoppedReason.reason === 'budget_too_small'`, **one** event or one heal batch exceeds the whole budget — raise that run's budget, or split the work over multiple invocations.

## Choosing `entity_id` partitioning

`entity_id` is a free namespace; the engine accepts any string and enforces nothing. For one file per tenant, three partitions each with a clear trade-off:

| Partition | Isolation | Cost |
|---|---|---|
| `<tenantId>:<userId>` — one entity per end-user | Strong: `read()` scoped per user, `traverseGraph` never crosses users, per-user `forget()`/`exportDump()` and token accounting | Entity count grows with users |
| `<tenantId>:<workspaceId>` — one entity per workspace | Workspace-scoped reads are natural; per-workspace accounting and `forget()` | Users inside a workspace share memory |
| `<tenantId>` — one constant entity per file | None inside the tenant | Simplest; per-user `forget()` degenerates to "delete the file" |

Whatever the choice, the writer (your auth layer) picks the `entity_id` per request — see the hard rule above. Deletion and retention interplay: `forget({ clearAll: true, includeEvents: true })` hard-deletes every event of the entity immediately, read or not, and resets the librarian position — see [Deleting data](/expo-llm-wiki/guides/deleting-data/) and [Maintenance](/expo-llm-wiki/guides/maintenance/).

