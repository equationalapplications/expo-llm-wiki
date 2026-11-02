---
title: Knowledge base from a folder of markdown
description: Sync a directory of documents into memory, re-ingesting only what changed and cleaning up deleted files.
sidebar:
  order: 2
---

**Goal:** keep an entity in sync with a folder of `.md` files, for example your team handbook.
Run it on a cron or in CI.

```ts title="sync-docs.ts"
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { wiki } from './memory'; // see the Node.js quickstart

const ENTITY = 'kb:handbook';
const ROOT = './handbook';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
// sourceRef keeps only [A-Za-z0-9._- ]; turn path separators into underscores.
const toRef = (path: string) => relative(ROOT, path).replaceAll('/', '_');

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.md')) yield p;
  }
}

const docs: { sourceRef: string; sourceHash: string; content: string }[] = [];
for await (const path of walk(ROOT)) {
  const content = await readFile(path, 'utf8');
  docs.push({ sourceRef: toRef(path), sourceHash: sha256(content), content });
}

// 1. Work out what changed: one query, no LLM calls.
const statuses = await wiki.pendingSources(ENTITY, docs);

// 2. Ingest new, changed, and partial documents.
for (const [i, { status }] of statuses.entries()) {
  if (status === 'current') continue;
  const d = docs[i];
  const r = await wiki.ingestDocument(ENTITY, { sourceRef: d.sourceRef, sourceHash: d.sourceHash, documentChunk: d.content });
  console.log(`${status.padEnd(8)} ${d.sourceRef}: ${r.ingestedChunks}/${r.chunks} chunks`);
}

// 3. Forget documents that were deleted from disk.
const onDisk = new Set(docs.map((d) => d.sourceRef));
for (const { sourceRef } of await wiki.listSourceRefs(ENTITY)) {
  if (!onDisk.has(sourceRef)) {
    await wiki.forget(ENTITY, { sourceRef });
    console.log(`removed  ${sourceRef}`);
  }
}
```

## Query it

```ts
const memory = await wiki.read('kb:handbook', 'how do I request time off?', { hybridWeight: 0.7 });
```

## Tips

- Use `onDuplicateHash: 'skip'` if the same file can show up under two paths.
- Set `chunkConcurrency: 4` to speed up large first ingests, as far as your provider's rate limits allow.
- Turn on [grounding](/expo-llm-wiki/guides/drafts-and-grounding/#grounding) with
  `excludeDrafts: true` so only facts that quote the handbook are used.
