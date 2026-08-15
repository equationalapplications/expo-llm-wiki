import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseOkfBundle } from '../src/utils/parseOkfBundle';
import type { OkfFile } from '@equationalapplications/core-okf';

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000));
afterEach(() => vi.restoreAllMocks());

const V2_ROOT = `---\nokf_version: 0.2\nprofile: llm-wiki/2\n---\n\n## Entities\n\n* [demo](entities/demo/index.md)\n`;
const V2_ENTITY_INDEX = 'Demo summary v2.\n\n## Facts\n\n* [V2 fact](facts/f_v2.md)\n\n## Tasks\n\n* [V2 task](tasks/t_v2.md)\n\n[Event log](./log.md)\n';
const V2_FACT = `---
type: fact
title: V2 fact
status: stable
generated: { by: "reference_agent/gemini-2.5-pro", at: "2026-01-01T00:00:00Z" }
verified: [ { by: "human:ahormati", at: "2026-02-01T00:00:00Z" } ]
sources: [ { id: a, resource: "https://example.com/a" } ]
usage_window: { from: 2026-01-01, to: 2026-12-31 }
stale_after: 2026-06-01
id: f_v2
entity_id: demo
confidence: certain
source_type: user_stated
created_at: 1700000000000
---

Body.

## Related

- [links](./t_v2.md)
`;
const V2_TASK = `---
type: task
title: V2 task
status: stable
execution_status: in_progress
id: t_v2
entity_id: demo
created_at: 1700000000000
---

`;
const V2_LOG = `## 2026-01-01\n\n- (action) did a thing <!-- id: evt_v2_1 -->\n`;

const V2_FILES: OkfFile[] = [
  { path: 'index.md', content: V2_ROOT },
  { path: 'entities/demo/index.md', content: V2_ENTITY_INDEX },
  { path: 'entities/demo/facts/f_v2.md', content: V2_FACT },
  { path: 'entities/demo/tasks/t_v2.md', content: V2_TASK },
  { path: 'entities/demo/log.md', content: V2_LOG },
];

describe('parseOkfBundle v0.2 path', () => {
  it('reads generated + verified + status + stale_after + sources + usage_window into the new WikiFact fields', () => {
    const dump = parseOkfBundle('demo', V2_FILES);
    const f = dump.entities.demo.facts.find((x) => x.id === 'f_v2')!;
    expect(f.lifecycle_status).toBe('stable');
    expect(f.generated_by).toBe('reference_agent/gemini-2.5-pro');
    expect(f.updated_at).toBe(new Date('2026-01-01T00:00:00Z').getTime());
    expect(f.okf_sources?.[0]?.resource).toBe('https://example.com/a');
    expect(f.okf_verified?.[0]?.by).toBe('human:ahormati');
    expect(f.okf_usage_window?.to).toBe('2026-12-31');
    expect(f.stale_after).toBe(new Date('2026-06-01T00:00:00Z').getTime());
    expect(f.last_verified_by).toBe('human:ahormati');
  });

  it('maps v0.2 task wire status -> lifecycle_status and execution_status -> status', () => {
    const dump = parseOkfBundle('demo', V2_FILES);
    const t = dump.entities.demo.tasks.find((x) => x.id === 't_v2')!;
    expect(t.lifecycle_status).toBe('stable');
    expect(t.status).toBe('in_progress');
  });

  it('reads task stale_after symmetrically with facts (spec §2.5)', () => {
    const files: OkfFile[] = [
      ...V2_FILES,
      {
        path: 'entities/demo/tasks/t_stale.md',
        content: `---
type: task
title: Stale task
status: stable
execution_status: pending
stale_after: 2026-06-01
id: t_stale
entity_id: demo
created_at: 1700000000000
---

`,
      },
    ];
    const dump = parseOkfBundle('demo', files);
    const t = dump.entities.demo.tasks.find((x) => x.id === 't_stale')!;
    expect(t.stale_after).toBe(new Date('2026-06-01T00:00:00Z').getTime());
  });

  it('handles verified as bare mapping (one-element list)', () => {
    const files: OkfFile[] = [
      ...V2_FILES,
      {
        path: 'entities/demo/facts/f_bare.md',
        content: `---
type: fact
title: Bare verified
verified: { by: "process:cron", at: "2026-03-01T00:00:00Z" }
id: f_bare
entity_id: demo
created_at: 1700000000000
---

body
`,
      },
    ];
    const dump = parseOkfBundle('demo', files);
    const f = dump.entities.demo.facts.find((x) => x.id === 'f_bare')!;
    expect(f.okf_verified).toEqual([{ by: 'process:cron', at: '2026-03-01T00:00:00Z' }]);
  });

  it('v0.1 fallback: timestamp maps to updated_at and body # Citations becomes a synthetic source', () => {
    const files: OkfFile[] = [
      { path: 'index.md', content: `---\nokf_version: 0.1\nprofile: llm-wiki/1\n---\n\n## Entities\n\n* [demo](entities/demo/index.md)\n` },
      { path: 'entities/demo/index.md', content: 'demo summary\n\n## Facts\n\n* [v1 fact](facts/f_v1.md)\n' },
      { path: 'entities/demo/facts/f_v1.md', content: `---
type: fact
title: v1 fact
timestamp: 2026-04-01T00:00:00Z
id: f_v1
entity_id: demo
created_at: 1700000000000
---

Body.

# Citations

- https://legacy.example.com/x

## Related

- [x](./y.md)
` },
    ];
    const dump = parseOkfBundle('demo', files);
    const f = dump.entities.demo.facts.find((x) => x.id === 'f_v1')!;
    expect(f.updated_at).toBe(new Date('2026-04-01T00:00:00Z').getTime());
    // # Citations fallback: synthetic source with no id, no credibility signals.
    expect(f.okf_sources?.[0]?.resource).toBe('https://legacy.example.com/x');
    expect(f.okf_sources?.[0]?.id).toBeUndefined();
  });

  it('v0.1 task with status: done imports as execution status (no rename)', () => {
    const files: OkfFile[] = [
      { path: 'index.md', content: `---\nokf_version: 0.1\nprofile: llm-wiki/1\n---\n\n## Entities\n\n* [demo](entities/demo/index.md)\n` },
      { path: 'entities/demo/index.md', content: 'demo\n\n## Tasks\n\n* [v1 task](tasks/t_v1.md)\n' },
      { path: 'entities/demo/tasks/t_v1.md', content: `---
type: task
title: v1 task
status: done
id: t_v1
entity_id: demo
created_at: 1700000000000
---

` },
    ];
    const dump = parseOkfBundle('demo', files);
    const t = dump.entities.demo.tasks.find((x) => x.id === 't_v1')!;
    expect(t.status).toBe('done');
    expect(t.lifecycle_status).toBe('stable'); // default per spec §2.3 reader contract
  });
});