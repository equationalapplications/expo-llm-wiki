---
title: How memory works
description: The mental model behind Core LLM Wiki — events, facts, tasks, and the maintenance passes that connect them.
sidebar:
  order: 1
---

Core LLM Wiki stores three kinds of records per **entity** (a namespace such as a user or an agent),
and runs a few LLM passes that move information between them.

```text
              write(event)                       ingestDocument(doc)
                   │                                     │
                   ▼                                     │
            ┌────────────┐   librarian (LLM)             │  ingest (LLM, chunked)
            │   events   │ ─────────────────┐            │
            └────────────┘                  ▼            ▼
                                     ┌────────────────────────┐      embed() (optional)
                                     │ facts  ·  tasks ·edges │ ◀───────────────────────
                                     └────────────────────────┘
                                         ▲          │
                         heal (LLM) ─────┘          │  read(entity, query)
                                                    ▼
                                           MemoryBundle → formatContext() → your prompt
```

## The three record types

| Record | What it is | Created by |
|---|---|---|
| **Event** | Something that happened: `observation`, `decision`, `action`, or `outcome`. Raw, append-only, short-lived. | `write()` |
| **Fact** | A durable piece of knowledge with a title, body, tags, and a `confidence` of `certain`, `inferred`, or `tentative`. | Librarian, ingest, heal, `upsertGraph()`, import, `remember()` |
| **Task** | Something to do, with a priority from 0 to 10. Status is pending, in progress, done, or abandoned. | Librarian |

When the host already knows a fact, `remember()` writes it directly, with no text-generation call. See [Direct fact writes](/expo-llm-wiki/reference/wiki-memory/#remember).

Facts can also have **edges** between them (`reports_to`, `worksFor`, …) when you turn on an
[ontology](/expo-llm-wiki/concepts/knowledge-graph/).

## The maintenance passes

| Pass | What it does | Triggered |
|---|---|---|
| **Librarian** | Reads recent events and turns them into new or updated facts and tasks. | `runPendingMaintenance()` or `runLibrarian()`, or automatically every `autoLibrarianThreshold` events in `'auto'` mode |
| **Ingest** | Splits a document into chunks and extracts facts from each one. | `ingestDocument()` |
| **Heal** | Reviews the store. It resolves contradictions, downgrades stale inferences, and removes obsolete facts. | `runPendingMaintenance()` or `runHeal()`, or automatically every `autoHealThreshold` events in `'auto'` mode |
| **Reembed** | Computes missing or outdated embeddings. | `runReembed()`, or the maintenance scheduler |
| **Prune** | Hard-deletes old soft-deleted rows and old events. | `runPrune()` |
| **Ontology backfill** | Assigns types to facts that came in without one, such as imported facts. | `runOntologyBackfill()` |

By default, librarian and heal run only when you call them, so nothing spends your model allowance
behind your back. Call [`runPendingMaintenance()`](/expo-llm-wiki/guides/maintenance/#deferred-maintenance)
on your own schedule, or set `maintenance: 'auto'` on a long-lived host to run them **in the
background** when `write()` crosses a threshold.

## Where facts come from: `source_type`

Every fact records its origin. This matters because some facts are protected from the model:

| `source_type` | Origin | Can the librarian or heal rewrite it? |
|---|---|---|
| `immutable_document` | `ingestDocument()` | **No.** Only `forget()` or a re-ingest changes it. |
| `librarian_inferred` | Librarian synthesis | Yes |
| `user_stated` | Asserted by the user | Yes |
| `user_confirmed` | Confirmed by the user | Yes |

## Bring your own inference

The engine owns the prompt, the JSON parsing, and the database writes. You give it a function:

```ts
generateText: ({ systemPrompt, userPrompt }) => Promise<string>
```

The function returns the model's raw text. JSON, optionally inside a markdown code fence, is
parsed for you. See [Connect your LLM provider](/expo-llm-wiki/guides/llm-provider/) for the
optional `embed`, `classify`, `maxOutputTokens`, and `generateTextWithUsage` members.

## Database layout

Everything lives in your SQLite file under a prefix (`llm_wiki_` by default, set with
`tablePrefix`). `setup()` creates the tables and runs pending migrations. It's idempotent, so
call it on every startup.

:::note
Deletes are **soft** at first: rows get a `deleted_at` timestamp. `runPrune()` hard-deletes them
after a retention window (7 days by default).
:::
