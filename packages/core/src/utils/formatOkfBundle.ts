import type { MemoryDump, WikiEdge, WikiFact, WikiTask, WikiEvent } from '../types';
import {
  appendEventIdComment,
  appendRelatedSection,
  buildConceptDocument,
  buildEntityIndexMd,
  buildRootIndexMd,
  buildLogMd,
  type OkfFile,
  type OkfFrontmatter,
  type OkfIndexEntry,
  type OkfIndexSection,
  type OkfLogEntry,
} from '@equationalapplications/core-okf';
import { sanitizeConceptId, sanitizeForFilename } from './sanitizeForFilename';

const LLM_WIKI_PROFILE = 'llm-wiki/1';

function factFrontmatter(f: WikiFact): OkfFrontmatter {
  return {
    type: f.okf_type ?? 'fact',
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

function conceptRelativePath(sourceFilePath: string, targetFilePath: string): string {
  const sourceDir = sourceFilePath.slice(0, sourceFilePath.lastIndexOf('/'));
  const targetDir = targetFilePath.slice(0, targetFilePath.lastIndexOf('/'));
  const targetName = targetFilePath.slice(targetFilePath.lastIndexOf('/') + 1);
  if (sourceDir === targetDir) return `./${targetName}`;
  if (sourceDir.endsWith('/facts') && targetDir.endsWith('/tasks')) return `../tasks/${targetName}`;
  if (sourceDir.endsWith('/tasks') && targetDir.endsWith('/facts')) return `../facts/${targetName}`;
  return targetFilePath.replace(/^entities\/[^/]+\//, '');
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
    return { date: formatLogDate(e.created_at), text: appendEventIdComment(text, e.id) };
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

    const idToConceptPath = new Map<string, string>();
    for (const f of bundle.facts) {
      idToConceptPath.set(f.id, `entities/${dir}/facts/${factIdToFilename.get(f.id)!}.md`);
    }
    for (const t of bundle.tasks) {
      idToConceptPath.set(t.id, `entities/${dir}/tasks/${sanitizeConceptId(t.id)}.md`);
    }

    const edgesBySource = new Map<string, WikiEdge[]>();
    for (const edge of bundle.edges ?? []) {
      const group = edgesBySource.get(edge.source_id) ?? [];
      group.push(edge);
      edgesBySource.set(edge.source_id, group);
    }

    function relatedLinksFor(sourcePath: string, sourceId: string) {
      return (edgesBySource.get(sourceId) ?? [])
        .map(edge => {
          const targetPath = idToConceptPath.get(edge.target_id);
          if (!targetPath) return null;
          return { edge_type: edge.edge_type, path: conceptRelativePath(sourcePath, targetPath) };
        })
        .filter((link): link is { edge_type: string; path: string } => link != null);
    }

    const factEntries: OkfIndexEntry[] = bundle.facts.map(f => ({
      path: `facts/${factIdToFilename.get(f.id)!}.md`,
      title: f.title,
    }));
    for (const f of bundle.facts) {
      const factPath = `entities/${dir}/facts/${factIdToFilename.get(f.id)!}.md`;
      const factBody = appendRelatedSection(f.body, relatedLinksFor(factPath, f.id));
      files.push({
        path: factPath,
        content: buildConceptDocument(factFrontmatter(f), factBody),
      });
    }

    const taskEntries: OkfIndexEntry[] = bundle.tasks.map(t => ({
      path: `tasks/${sanitizeConceptId(t.id)}.md`,
      title: t.description,
    }));
    for (const t of bundle.tasks) {
      const taskPath = `entities/${dir}/tasks/${sanitizeConceptId(t.id)}.md`;
      const taskBody = appendRelatedSection('', relatedLinksFor(taskPath, t.id));
      files.push({
        path: taskPath,
        content: buildConceptDocument(taskFrontmatter(t), taskBody),
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
      content: buildEntityIndexMd({
        summary: bundle.summary,
        sections: entityIndexSections,
      }),
    });

    rootEntries.push({ path: `entities/${dir}/index.md`, title: entityId });
  }

  files.push({
    path: 'index.md',
    content: buildRootIndexMd(
      '0.1',
      rootEntries.length > 0 ? [{ heading: 'Entities', entries: rootEntries }] : [],
      { profile: LLM_WIKI_PROFILE },
    ),
  });

  return { files };
}
