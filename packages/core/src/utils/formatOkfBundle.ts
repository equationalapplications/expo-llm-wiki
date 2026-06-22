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
import { sanitizeConceptId, sanitizeForFilename } from './sanitizeForFilename';

function factFrontmatter(f: WikiFact): OkfFrontmatter {
  return {
    type: f.okf_type || 'fact',
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
    type: t.okf_type ?? 'task',
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

function buildEventLogEntries(
  events: WikiEvent[],
  factIdToFilename: Map<string, string>,
): OkfLogEntry[] {
  return events.map(e => {
    const factFilename = e.related_entry_id ? factIdToFilename.get(e.related_entry_id) : undefined;
    const summary = e.summary
      .replace(/\\/g, '\\\\')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\r?\n/g, ' ');

    const text = factFilename
      ? `(${e.event_type}) [${summary}](./facts/${factFilename}.md)`
      : `(${e.event_type}) ${summary}`;
    return { date: formatLogDate(e.created_at), text };
  });
}

export function formatOkfBundle(dump: MemoryDump): { files: OkfFile[] } {
  const files: OkfFile[] = [];
  const rootEntries: OkfIndexEntry[] = [];

  for (const [entityId, bundle] of Object.entries(dump.entities)) {
    const dir = sanitizeForFilename(entityId);
    const factIdToFilename = new Map(
      bundle.facts.map(f => [f.id, sanitizeConceptId(f.id)] as const),
    );

    const factEntries: OkfIndexEntry[] = bundle.facts.map(f => ({
      path: `facts/${factIdToFilename.get(f.id)!}.md`,
      title: f.title,
    }));
    for (const f of bundle.facts) {
      files.push({
        path: `entities/${dir}/facts/${factIdToFilename.get(f.id)!}.md`,
        content: buildConceptDocument(factFrontmatter(f), f.body),
      });
    }

    const taskEntries: OkfIndexEntry[] = bundle.tasks.map(t => ({
      path: `tasks/${sanitizeConceptId(t.id)}.md`,
      title: t.description,
    }));
    for (const t of bundle.tasks) {
      files.push({
        path: `entities/${dir}/tasks/${sanitizeConceptId(t.id)}.md`,
        content: buildConceptDocument(taskFrontmatter(t), ''),
      });
    }

    files.push({
      path: `entities/${dir}/log.md`,
      content: buildLogMd(buildEventLogEntries(bundle.events, factIdToFilename)),
    });

    const entityIndexSections: OkfIndexSection[] = [
      { heading: 'Facts', entries: factEntries },
      { heading: 'Tasks', entries: taskEntries },
    ];
    files.push({
      path: `entities/${dir}/index.md`,
      content: `${buildIndexMd(entityIndexSections)}[Event log](./log.md)\n`,
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
