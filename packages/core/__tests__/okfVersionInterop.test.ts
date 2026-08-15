import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseOkfBundle } from '../src/utils/parseOkfBundle';
import { formatOkfBundle } from '../src/utils/formatOkfBundle';
import type { OkfFile } from '@equationalapplications/core-okf';

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000));
afterEach(() => vi.restoreAllMocks());

describe('OKF cross-version interop', () => {
  it('a profile-1 bundle imports under the v0.2 path with timestamp -> updated_at', () => {
    const files: OkfFile[] = [
      { path: 'index.md', content: `---\nokf_version: 0.1\nprofile: llm-wiki/1\n---\n\n## Entities\n\n* [demo](entities/demo/index.md)\n` },
      { path: 'entities/demo/index.md', content: 'demo\n\n## Facts\n\n* [v1](facts/v1.md)\n' },
      { path: 'entities/demo/facts/v1.md', content: `---
type: fact
title: v1 fact
timestamp: 2026-04-01T00:00:00Z
id: v1
entity_id: demo
created_at: 1700000000000
---

body
` },
    ];
    const dump = parseOkfBundle('demo', files);
    expect(dump.entities.demo.facts[0]?.updated_at).toBe(new Date('2026-04-01T00:00:00Z').getTime());
  });

  it('a profile-2 bundle imports with generated.at -> updated_at', () => {
    const files: OkfFile[] = [
      { path: 'index.md', content: `---\nokf_version: 0.2\nprofile: llm-wiki/2\n---\n\n## Entities\n\n* [demo](entities/demo/index.md)\n` },
      { path: 'entities/demo/index.md', content: 'demo\n\n## Facts\n\n* [v2](facts/v2.md)\n' },
      { path: 'entities/demo/facts/v2.md', content: `---
type: fact
title: v2 fact
status: stable
generated: { by: "process:cron", at: "2026-04-01T00:00:00Z" }
id: v2
entity_id: demo
created_at: 1700000000000
---

body
` },
    ];
    const dump = parseOkfBundle('demo', files);
    expect(dump.entities.demo.facts[0]?.updated_at).toBe(new Date('2026-04-01T00:00:00Z').getTime());
  });

  it('when both timestamp and generated.at are present, generated.at wins', () => {
    const files: OkfFile[] = [
      { path: 'index.md', content: `---\nokf_version: 0.2\nprofile: llm-wiki/2\n---\n\n## Entities\n\n* [demo](entities/demo/index.md)\n` },
      { path: 'entities/demo/index.md', content: 'demo\n\n## Facts\n\n* [v2](facts/v2.md)\n' },
      { path: 'entities/demo/facts/v2.md', content: `---
type: fact
title: both
timestamp: 2020-01-01T00:00:00Z
generated: { by: "process:cron", at: "2026-04-01T00:00:00Z" }
id: v2
entity_id: demo
created_at: 1700000000000
---

body
` },
    ];
    const dump = parseOkfBundle('demo', files);
    expect(dump.entities.demo.facts[0]?.updated_at).toBe(new Date('2026-04-01T00:00:00Z').getTime());
  });

  it('v0.1 task status:done imports as execution status; lifecycle_status defaults to stable', () => {
    const files: OkfFile[] = [
      { path: 'index.md', content: `---\nokf_version: 0.1\nprofile: llm-wiki/1\n---\n\n## Entities\n\n* [demo](entities/demo/index.md)\n` },
      { path: 'entities/demo/index.md', content: 'demo\n\n## Tasks\n\n* [t1](tasks/t1.md)\n' },
      { path: 'entities/demo/tasks/t1.md', content: `---
type: task
title: t1
status: done
id: t1
entity_id: demo
created_at: 1700000000000
---

` },
    ];
    const dump = parseOkfBundle('demo', files);
    expect(dump.entities.demo.tasks[0]?.status).toBe('done');
    expect(dump.entities.demo.tasks[0]?.lifecycle_status).toBe('stable');
  });

  it('v0.2 task status:stable + execution_status:in_progress imports with both intact', () => {
    const files: OkfFile[] = [
      { path: 'index.md', content: `---\nokf_version: 0.2\nprofile: llm-wiki/2\n---\n\n## Entities\n\n* [demo](entities/demo/index.md)\n` },
      { path: 'entities/demo/index.md', content: 'demo\n\n## Tasks\n\n* [t1](tasks/t1.md)\n' },
      { path: 'entities/demo/tasks/t1.md', content: `---
type: task
title: t1
status: stable
execution_status: in_progress
id: t1
entity_id: demo
created_at: 1700000000000
---

` },
    ];
    const dump = parseOkfBundle('demo', files);
    expect(dump.entities.demo.tasks[0]?.lifecycle_status).toBe('stable');
    expect(dump.entities.demo.tasks[0]?.status).toBe('in_progress');
  });

  it('body # Citations list (legacy v0.1) becomes a synthetic okf_sources entry on import', () => {
    const files: OkfFile[] = [
      { path: 'index.md', content: `---\nokf_version: 0.1\nprofile: llm-wiki/1\n---\n\n## Entities\n\n* [demo](entities/demo/index.md)\n` },
      { path: 'entities/demo/index.md', content: 'demo\n\n## Facts\n\n* [v1](facts/v1.md)\n' },
      { path: 'entities/demo/facts/v1.md', content: `---
type: fact
title: v1 with citations
timestamp: 2026-04-01T00:00:00Z
id: v1
entity_id: demo
created_at: 1700000000000
---

Body.

# Citations

- https://legacy.example.com/a
- https://legacy.example.com/b
` },
    ];
    const dump = parseOkfBundle('demo', files);
    const f = dump.entities.demo.facts[0]!;
    expect(f.okf_sources?.[0]?.resource).toBe('https://legacy.example.com/a');
  });
});
