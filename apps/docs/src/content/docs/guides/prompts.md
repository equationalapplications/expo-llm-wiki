---
title: Customize prompts
description: Override the system prompts for ingest, librarian, heal, and backfill — globally or per call — without breaking the JSON contract.
sidebar:
  order: 10
---

The built-in prompts work well out of the box. Override them when you need domain-specific
extraction ("only extract API requirements") or a different tone.

:::danger[Overrides replace the whole prompt]
Your override replaces the **entire** default system prompt, including the JSON schema the
parser depends on. Always tell the model to return raw JSON in the required shape.
:::

## Required JSON shapes

| Operation | Shape |
|---|---|
| Ingest | `{ "facts": [{ "title", "body", "tags": [], "confidence": "certain\|inferred\|tentative" }] }` |
| Librarian | `{ "facts": [...], "tasks": [{ "description", "priority": 0–10 }] }` |
| Heal | `{ "downgraded": ["factId"], "deleted": ["factId"], "newFacts": [...] }` |

## Global overrides (apply to auto-runs)

Use these if the librarian and heal run from `'auto'` maintenance or `runPendingMaintenance()`:

```ts
createWiki(db, {
  llmProvider,
  config: {
    prompts: {
      librarianSystemPrompt: `You are an expert curator. Synthesize these thoughts:
{{events}}

Current facts:
{{currentFacts}}

Return ONLY valid JSON: { "facts": [{ "title": "string", "body": "string", "tags": ["string"], "confidence": "certain|inferred|tentative" }], "tasks": [{ "description": "string", "priority": 0 }] }. No markdown.`,
    },
  },
});
```

## Per-call overrides (one call only)

```ts
await wiki.ingestDocument('user-123', {
  sourceRef: 'spec.md', sourceHash, documentChunk: content,
  promptOverride: `Extract only strict technical requirements: {{documentChunk}}

Return ONLY valid JSON: { "facts": [{ "title": "string", "body": "string", "tags": ["string"], "confidence": "certain|inferred|tentative" }] }. No markdown.`,
});

await wiki.runLibrarian('user-123', { promptOverride: '…' });
await wiki.runHeal('user-123', { promptOverride: '…' });
```

A `promptOverride` is **never** forwarded to auto-runs started by `write()`. Use `config.prompts`
for those.

## Template variables

| Prompt | Variables |
|---|---|
| `ingestSystemPrompt` | `{{documentChunk}}` |
| `librarianSystemPrompt` | `{{events}}`, `{{currentFacts}}` |
| `healSystemPrompt` | `{{healCandidates}}`, `{{documentAnchors}}`, `{{allTasks}}`, `{{recentEvents}}` |
| `ontologyBackfillSystemPrompt` | `{{facts}}` and the ontology placeholders |

If your template uses `{{variables}}`, the data is filled into the **system** prompt and a short
fixed user prompt is sent. If it has none, the data is sent as the **user** prompt. That keeps
plain-string overrides working.

## What gets appended automatically

- **The ontology block**, when ontology mode is `strict` or `emergent`, for ingest, librarian,
  and backfill.
- **The evidence instruction**, when [grounding](/expo-llm-wiki/guides/drafts-and-grounding/) is
  on, for each writer in `grounding.writers`. Your override doesn't need to ask for evidence.

## See the final prompt: `getInstructions`

```ts
const { ingest, librarian, heal, ontologyBackfill } = await wiki.getInstructions('user-123');
```

This returns each writer's effective system prompt, with overrides, the ontology block, and the
evidence block applied. Data placeholders stay unfilled. It's useful for debugging, and for
letting agents see the output contract (via the `instructions_get` tool, formerly `wiki_get_instructions`).

:::caution
Overrides are returned verbatim to anyone with `memory:read`. **Never put secrets in
`config.prompts`.**
:::
