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

| Operation | Strategy | Shape |
|---|---|---|
| Ingest | both | `{ "facts": [{ "title", "body", "tags": [], "confidence": "certain\|inferred\|tentative" }] }` |
| Librarian extract | both | `{ "facts": [...], "tasks": [{ "description", "priority": 0–10 }] }` — under `'ops'` (the default) every fact also needs `"source_event"` (the event label, e.g. `"e1"`) and may carry `"valid_from"` (ISO-8601) |
| Librarian resolve | `'ops'` only | `{ "ops": [{ "item": 0, "op": "ADD\|UPDATE\|SUPERSEDE\|NOOP", "target": "n1", "title": "UPDATE only", "body": "UPDATE only" }] }` |
| Heal | both | `{ "downgraded": ["factId"], "deleted": ["factId"], "newFacts": [...] }` |

## Global overrides (apply to auto-runs)

Use these if the librarian and heal run from `'auto'` maintenance or `runPendingMaintenance()`.

Under the default `librarian.strategy: 'ops'`, the librarian does **not** read
`librarianSystemPrompt` — `WikiMemory` warns at construction when it's set. That override
applies only when you pin `librarian: { strategy: 'legacy' }`. `healSystemPrompt` applies
under both strategies:

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

## Host guidance

Guidance steers the librarian without replacing any prompt, so the JSON contract stays intact.
Set a default, and optionally resolve it per entity:

```ts
createWiki(db, {
  llmProvider,
  config: {
    prompts: { guidance: 'Only keep durable project decisions. Skip small talk.' },
    librarian: {
      strategy: 'ops',
      guidanceForEntity: (entityId) => (entityId.startsWith('support-') ? 'Focus on customer issues.' : undefined),
    },
  },
});
```

- **Resolution order:** `prompts.guidance` is the default; a non-empty `librarian.guidanceForEntity(entityId)` result overrides it for that entity. Emptiness is judged on the trimmed value.
- **Cap:** 2,000 UTF-16 code units (`GUIDANCE_MAX_CHARS`). Over-cap guidance is refused with `guidance_too_long`. There is no fallback to the default.
- **No template variables:** neither `prompts.guidance` nor `guidanceForEntity` may contain `{{…}}`.
- **Where it lands:** guidance composes after every override and reaches ingest, the librarian (both strategies), ops extract, and `getInstructions`.
- **Where it never lands:** heal and ontology backfill.

:::caution
`getInstructions` returns guidance verbatim, so it is echoed back to anyone with `memory:read`.
**Never put secrets in guidance.**
:::

:::note[Deprecation]
`prompts.librarianSystemPrompt` is deprecated and will be removed in 9.0.0. Migrate to `prompts.guidance`.
:::

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
for those. Under `'ops'`, `runLibrarian`'s `promptOverride` is ignored too — it is a
legacy-strategy knob.

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
evidence block applied. Data placeholders stay unfilled. Under `'ops'`, the `librarian` entry is
the ops extract system prompt the engine actually sends. It's useful for debugging, and for
letting agents see the output contract (via the `instructions_get` tool, formerly `wiki_get_instructions`).

:::caution
Overrides are returned verbatim to anyone with `memory:read`. **Never put secrets in
`config.prompts`.**
:::
