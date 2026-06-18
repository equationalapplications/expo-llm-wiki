import type { MemoryDump, WikiFact, WikiTask, WikiEvent } from '../types';
import {
  buildConceptDocument,
  buildIndexMd,
  buildRootIndexMd,
  buildLogMd,
  type OkfFile,
  type OkfFrontmatter,
  type OkfIndexEntry,
  type OkfIndexSection,
  type OkfLogEntry,
} from '@equationalapplications/core-okf';
import { sanitizeForFilename } from './sanitizeForFilename';

function factFrontmatter(f: WikiFact): OkfFrontmatter {
  return {
    type: 'fact',
    title: f.title,
    tags: f.tags,
    timestamp: new Date(f.updated_at).toISOString(),
    resource: f.source_ref ?? undefined,
    id: f.id,
    entity_id: f.entity_id,
    confidence: f.confidence,
    source_type: f.source_type,
    source_hash: f.source_hash,
    created_at: f.created_at,
    access_count: f.access_count,
    last_accessed_at: f.last_accessed_at,
    deleted_at: f.deleted_at,
  };
}

function taskFrontmatter(t: WikiTask): OkfFrontmatter {
  return {
    type: 'task',
    title: t.description,
    timestamp: new Date(t.updated_at).toISOString(),
    id: t.id,
    entity_id: t.entity_id,
    status: t.status,
    priority: t.priority,
    created_at: t.created_at,
    resolved_at: t.resolved_at,
    deleted_at: t.deleted_at,
  };
}

function formatLogDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function buildEventLogEntries(events: WikiEvent[], factIds: Set<string>): OkfLogEntry[] {
  return events.map(e => {
    const text = e.related_entry_id && factIds.has(e.related_entry_id)
      ? `(${e.event_type}) [${e.summary}](./facts/${e.related_entry_id}.md)`
      : `(${e.event_type}) ${e.summary}`;
    return { date: formatLogDate(e.created_at), text };
  });
}

export function formatOkfBundle(dump: MemoryDump): { files: OkfFile[] } {
  const files: OkfFile[] = [];
  const rootEntries: OkfIndexEntry[] = [];

  for (const [entityId, bundle] of Object.entries(dump.entities)) {
    const dir = sanitizeForFilename(entityId);
    const factIds = new Set(bundle.facts.map(f => f.id));

    const factEntries: OkfIndexEntry[] = bundle.facts.map(f => ({
      path: `facts/${f.id}.md`,
      title: f.title,
    }));
    for (const f of bundle.facts) {
      files.push({
        path: `entities/${dir}/facts/${f.id}.md`,
        content: buildConceptDocument(factFrontmatter(f), f.body),
      });
    }

    const taskEntries: OkfIndexEntry[] = bundle.tasks.map(t => ({
      path: `tasks/${t.id}.md`,
      title: t.description,
    }));
    for (const t of bundle.tasks) {
      files.push({
        path: `entities/${dir}/tasks/${t.id}.md`,
        content: buildConceptDocument(taskFrontmatter(t), ''),
      });
    }

    files.push({
      path: `entities/${dir}/log.md`,
      content: buildLogMd(buildEventLogEntries(bundle.events, factIds)),
    });

    const entityIndexSections: OkfIndexSection[] = [
      { heading: 'Facts', entries: factEntries },
      { heading: 'Tasks', entries: taskEntries },
    ];
    files.push({
      path: `entities/${dir}/index.md`,
      content: `${buildIndexMd(entityIndexSections)}\n[Event log](./log.md)\n`,
    });

    rootEntries.push({ path: `entities/${dir}/index.md`, title: entityId });
  }

  files.push({
    path: 'index.md',
    content: buildRootIndexMd(
      '0.1',
      rootEntries.length > 0 ? [{ heading: 'Entities', entries: rootEntries }] : [],
    ),
  });

  return { files };
}
