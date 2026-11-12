---
title: Security
description: How Core LLM Wiki protects your data, where the host's responsibilities begin, and how to report a vulnerability.
---

## Reporting a vulnerability

**Don't open a public issue.** Use [GitHub private vulnerability reporting](https://github.com/equationalapplications/expo-llm-wiki/security/advisories/new),
or email **info@equationalapplications.com**. You'll get an acknowledgement within 48 hours and
an assessment within 5 business days. The full policy is in [SECURITY.md](https://github.com/equationalapplications/expo-llm-wiki/blob/main/SECURITY.md).

## What the engine guarantees

- **Parameterized SQL everywhere.** `entityId`, `entryId`, `sourceRef`, `sourceHash`, and
  query text are never concatenated into SQL.
- **Input normalization.** `sourceRef` is restricted to `[A-Za-z0-9._\- ]`, and `sourceHash` must
  be a 64-character hex digest.
- **Vector hygiene.** Non-finite or empty vectors are never stored. A dimension mismatch falls
  back to keyword search until `runReembed()` completes. Vectors are copied defensively before
  they reach adapters.
- **Credential scrubbing.** Ranker errors are sanitized before they appear in `error.cause` or callbacks.
- **Deletes are sent to external indexes, and kept owed until confirmed.** The engine records each
  deleted fact and keeps it owed until your deletion hook succeeds once, across retries and
  restarts. A restart alone doesn't send them: `runPendingMaintenance()`, `runExternalDeletions()`,
  `forget()` and `runPrune()` (for the ids they touch) do, and so does `setup()` when you turn on
  `drainExternalDeletionsOnSetup`. Your hook must tolerate repeats, and the app has to run again to
  finish. See
  [Deleting data](/expo-llm-wiki/guides/deleting-data/#right-to-be-forgotten-gdpr) for what stays with you.
- **Content-free diagnostics.** `onDiagnostic` never carries fact text or model output.

## Your responsibilities as the host

- **Authorization.** Decide which `entityId` a caller may access. The engine scopes queries, but
  it doesn't authenticate anyone.
- **API keys.** Keep provider keys on a server, not in a mobile or browser bundle.
- **Secrets in prompts.** `getInstructions()` and the `instructions_get` tool (formerly `wiki_get_instructions`) return
  `config.prompts` verbatim to anyone with `memory:read`, so never put secrets in them.
- **One writer per file**, across processes.

## Prompt-injection trust boundary

User-controlled text, including event summaries, document chunks, and imported fact bodies, is
interpolated **verbatim** into librarian, heal, and ingest prompts. Templating is simple
substitution. It doesn't detect instruction-like content.

- Mitigating prompt injection is **the host's job**.
- If untrusted input flows into `write()`, `ingestDocument()`, or `importDump()`, treat the
  librarian's and heal's output as untrusted too. Validate it before you act on it downstream.
- [Grounding](/expo-llm-wiki/guides/drafts-and-grounding/#grounding) checks that a fact quotes its
  source. It is **not** an injection defense.
- In emergent mode, the ontology returned by `getInstructions()` may contain types the model
  proposed. Agents should treat it as reference data, not as instructions.

## Writing a VectorRanker adapter?

Read the [adapter rules](/expo-llm-wiki/guides/vector-ranker/#rules-for-adapter-authors) and the
detailed examples in [SECURITY.md](https://github.com/equationalapplications/expo-llm-wiki/blob/main/SECURITY.md#vectorranker-adapter-security).
