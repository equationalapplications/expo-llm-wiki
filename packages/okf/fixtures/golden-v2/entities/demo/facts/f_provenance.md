---
type: fact
title: Provenance fact
status: stable
generated: { by: "reference_agent/gemini-2.5-pro", at: "2026-01-01T00:00:00Z" }
verified: [ { by: "process:cron-nightly", at: "2026-02-01T00:00:00Z" }, { by: "human:ahormati", at: "2026-03-01T00:00:00Z" } ]
sources: [ { id: a, resource: "https://example.com/a" }, { id: b, resource: "https://example.com/b", usage_window: { from: 2025-01-01, to: 2025-12-31 } } ]
usage_window: { from: 2026-01-01, to: 2026-12-31 }
id: f_provenance
entity_id: demo
confidence: certain
source_type: user_stated
created_at: 1736899200000
---

Body with a footnote[^a] and inline ref[^b].

[^a]: footnote a definition
[^b]: footnote b definition

## Related

- [renames](../tasks/t_rename.md)
