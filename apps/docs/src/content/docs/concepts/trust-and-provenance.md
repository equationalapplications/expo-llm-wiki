---
title: Trust & provenance
description: Confidence levels, lifecycle status, drafts, grounding, and trust tiers — how Core LLM Wiki tracks how much to believe a fact.
sidebar:
  order: 5
---

LLM output is fallible. Core LLM Wiki records **how** each fact got into memory and **how much to
trust it**, so your app can decide what to show and what to inject into prompts.

## The signals on every fact

| Field | Values | Meaning |
|---|---|---|
| `confidence` | `certain` · `inferred` · `tentative` | How sure the writer (model or user) was |
| `source_type` | `immutable_document` · `librarian_inferred` · `user_stated` · `user_confirmed` | Where the fact came from ([details](/expo-llm-wiki/concepts/how-it-works/#where-facts-come-from-source_type)) |
| `lifecycle_status` | `draft` · `stable` · `deprecated` | Review state |
| `source_ref` / `source_hash` | document identifier and SHA-256 hash | Which document the fact was extracted from |
| `okf_verified` | list of `{ by, at }` | Who verified it. `human:*` verifiers give the `human-reviewed` trust tier. |
| `valid_from` / `valid_to` | epoch ms | When the fact was true ([temporal facts](/expo-llm-wiki/guides/temporal-facts/)) |

## Drafts

A fact with `lifecycle_status: 'draft'` hasn't been reviewed. Drafts are **visible by default**.
Hide them per call or globally with `excludeDrafts`:

```ts
await wiki.read('user-1', 'deploy process', { excludeDrafts: true });
```

Promote a draft after review with `promoteDraft()`. See
[Review drafts & grounding](/expo-llm-wiki/guides/drafts-and-grounding/).

## Grounding

When `grounding` is on, chosen writers must **quote the source text** they were shown. A
deterministic check (no LLM involved) verifies the quotes:

- All quotes found → the fact is stored `stable` with trust tier `machine-confirmed`.
- Quotes missing or not found → the fact is stored as a **draft** rather than rejected.

:::caution[Grounding is not a prompt-injection defense]
Grounding proves a fact quotes its source. It doesn't prove the source is honest. Injected text
in a document can be quoted like any other text. See
[Security](/expo-llm-wiki/project/security/#prompt-injection-trust-boundary).
:::

## Lint

`lint(entityId)` is a read-only health report. It counts dangling edges, manifest violations,
untyped facts, drafts, and unverified inferences. It never repairs anything.
