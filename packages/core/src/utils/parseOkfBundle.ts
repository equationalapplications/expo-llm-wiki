import type { MemoryDump, WikiFact, WikiTask, WikiEvent, WikiEdge } from '../types';
import type { OkfFile, OkfFrontmatter, OkfFrontmatterValue } from '@equationalapplications/core-okf';
import { parseConcept, parseLogMd, extractMarkdownLinks } from '@equationalapplications/core-okf';
import { generateId } from './ids';

export interface OkfImportOptions {
  typeMapping?: Record<string, 'fact' | 'task' | 'ignore'>;
  defaultSchema?: 'fact' | 'task' | 'ignore';
}

type Route = 'fact' | 'task' | 'ignore';

const CONFIDENCE_VALUES = new Set(['certain', 'inferred', 'tentative']);
const SOURCE_TYPES = new Set([
  'user_stated',
  'librarian_inferred',
  'user_confirmed',
  'immutable_document',
]);
const TASK_STATUSES = new Set(['pending', 'in_progress', 'done', 'abandoned']);
const EVENT_TYPES = new Set(['observation', 'decision', 'action', 'outcome']);

function basenameMd(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

function isConceptFile(filePath: string): boolean {
  if (!filePath.endsWith('.md')) return false;
  if (filePath.endsWith('/index.md') || filePath === 'index.md') return false;
  if (filePath.endsWith('/log.md') || filePath === 'log.md') return false;
  return true;
}

function isStructuralPath(filePath: string): boolean {
  return (
    filePath.endsWith('/index.md') ||
    filePath === 'index.md' ||
    filePath.endsWith('/log.md') ||
    filePath === 'log.md'
  );
}

function posixDirname(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? '' : filePath.slice(0, idx);
}

function resolveRelativePath(fromFile: string, linkPath: string): string {
  const baseDir = posixDirname(fromFile);
  const segments = [...(baseDir ? baseDir.split('/') : []), ...linkPath.split('/')];
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(seg);
  }
  return resolved.join('/');
}

function addPathAliases(map: Map<string, string>, filePath: string, resolvedId: string): void {
  map.set(filePath, resolvedId);
  const withoutDot = filePath.replace(/^\.\//, '');
  if (withoutDot !== filePath) map.set(withoutDot, resolvedId);
  const entityRelative = filePath.replace(/^entities\/[^/]+\//, '');
  if (entityRelative !== filePath) {
    map.set(entityRelative, resolvedId);
    map.set(`./${entityRelative}`, resolvedId);
  }
}

function lookupResolvedId(map: Map<string, string>, path: string): string | undefined {
  const normalized = path.replace(/^\.\//, '');
  return map.get(path) ?? map.get(normalized) ?? map.get(`./${normalized}`);
}

function resolveRoute(filePath: string, frontmatterType: string, options?: OkfImportOptions): Route {
  if (options?.typeMapping && frontmatterType in options.typeMapping) {
    return options.typeMapping[frontmatterType]!;
  }
  if (filePath.includes('/facts/')) return 'fact';
  if (filePath.includes('/tasks/')) return 'task';
  return options?.defaultSchema ?? 'fact';
}

function parseFrontmatterTimestamp(value: OkfFrontmatterValue | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function unescapeLogSummary(summary: string): string {
  return summary.replace(/\\\]/g, ']').replace(/\\\[/g, '[').replace(/\\\\/g, '\\');
}

const LOG_LINE_PATTERN = /^\(([^)]+)\)\s*(?:\[((?:\\.|[^\]])*)\]\(([^)]+)\)|(.+))$/;

function parseLogEntryText(text: string): {
  event_type: WikiEvent['event_type'];
  summary: string;
  linkPath?: string;
} | null {
  const match = LOG_LINE_PATTERN.exec(text.trim());
  if (!match) return null;
  const [, rawType, linkedSummary, linkPath, plainSummary] = match;
  const event_type = EVENT_TYPES.has(rawType) ? (rawType as WikiEvent['event_type']) : 'observation';
  if (linkPath) {
    return { event_type, summary: unescapeLogSummary(linkedSummary), linkPath };
  }
  return { event_type, summary: (plainSummary ?? '').trim() };
}

function frontmatterToFact(
  entityId: string,
  frontmatter: OkfFrontmatter,
  body: string,
  now: number,
): WikiFact {
  const id = typeof frontmatter.id === 'string' && frontmatter.id ? frontmatter.id : generateId();
  const created_at = parseFrontmatterTimestamp(frontmatter.created_at, now);
  const updated_at = parseFrontmatterTimestamp(
    frontmatter.timestamp,
    parseFrontmatterTimestamp(frontmatter.updated_at, now),
  );

  return {
    id,
    entity_id: entityId,
    title: typeof frontmatter.title === 'string' ? frontmatter.title : '',
    body,
    tags: Array.isArray(frontmatter.tags)
      ? frontmatter.tags.filter((t): t is string => typeof t === 'string')
      : [],
    confidence: CONFIDENCE_VALUES.has(String(frontmatter.confidence))
      ? (frontmatter.confidence as WikiFact['confidence'])
      : 'tentative',
    source_type: SOURCE_TYPES.has(String(frontmatter.source_type))
      ? (frontmatter.source_type as WikiFact['source_type'])
      : 'user_stated',
    source_hash: typeof frontmatter.source_hash === 'string' ? frontmatter.source_hash : null,
    source_ref: typeof frontmatter.resource === 'string' ? frontmatter.resource : null,
    created_at,
    updated_at,
    last_accessed_at:
      frontmatter.last_accessed_at != null
        ? parseFrontmatterTimestamp(frontmatter.last_accessed_at, now)
        : null,
    access_count: typeof frontmatter.access_count === 'number' ? frontmatter.access_count : 0,
    deleted_at:
      frontmatter.deleted_at != null ? parseFrontmatterTimestamp(frontmatter.deleted_at, 0) : null,
    okf_type: frontmatter.type,
  };
}

function frontmatterToTask(entityId: string, frontmatter: OkfFrontmatter, now: number): WikiTask {
  const id = typeof frontmatter.id === 'string' && frontmatter.id ? frontmatter.id : generateId();
  const created_at = parseFrontmatterTimestamp(frontmatter.created_at, now);
  const updated_at = parseFrontmatterTimestamp(
    frontmatter.timestamp,
    parseFrontmatterTimestamp(frontmatter.updated_at, now),
  );

  return {
    id,
    entity_id: entityId,
    description: typeof frontmatter.title === 'string' ? frontmatter.title : '',
    status: TASK_STATUSES.has(String(frontmatter.status))
      ? (frontmatter.status as WikiTask['status'])
      : 'pending',
    priority: typeof frontmatter.priority === 'number' ? frontmatter.priority : 0,
    created_at,
    updated_at,
    resolved_at:
      frontmatter.resolved_at != null
        ? parseFrontmatterTimestamp(frontmatter.resolved_at, now)
        : null,
    deleted_at:
      frontmatter.deleted_at != null ? parseFrontmatterTimestamp(frontmatter.deleted_at, 0) : null,
    okf_type: frontmatter.type,
  };
}

function findLogMdPath(files: OkfFile[]): string | undefined {
  return files.find(f => f.path.endsWith('/log.md') || f.path === 'log.md')?.path;
}

export function parseOkfBundle(
  entityId: string,
  files: OkfFile[],
  options?: OkfImportOptions,
): MemoryDump {
  const now = Date.now();
  const pathToResolvedId = new Map<string, string>();

  for (const file of files) {
    if (!isConceptFile(file.path)) continue;
    const { frontmatter } = parseConcept(file.content);
    const resolvedId =
      typeof frontmatter.id === 'string' && frontmatter.id ? frontmatter.id : basenameMd(file.path);
    addPathAliases(pathToResolvedId, file.path, resolvedId);
  }

  const facts: WikiFact[] = [];
  const tasks: WikiTask[] = [];
  const edges: WikiEdge[] = [];
  let logContent: string | null = null;
  const logMdPath = findLogMdPath(files);

  for (const file of files) {
    if (file.path.endsWith('/log.md') || file.path === 'log.md') {
      logContent = file.content;
      continue;
    }
    if (!isConceptFile(file.path)) continue;

    const { frontmatter, body } = parseConcept(file.content);
    const route = resolveRoute(file.path, frontmatter.type ?? '', options);
    if (route === 'ignore') continue;

    const resolvedId =
      typeof frontmatter.id === 'string' && frontmatter.id ? frontmatter.id : basenameMd(file.path);

    if (route === 'fact') {
      facts.push(frontmatterToFact(entityId, frontmatter, body, now));
    } else {
      tasks.push(frontmatterToTask(entityId, frontmatter, now));
    }

    for (const link of extractMarkdownLinks(body)) {
      const targetPath = resolveRelativePath(file.path, link.path);
      if (isStructuralPath(targetPath)) continue;
      const targetId = lookupResolvedId(pathToResolvedId, targetPath);
      if (!targetId) continue;
      edges.push({
        id: generateId(),
        entity_id: entityId,
        source_id: resolvedId,
        target_id: targetId,
        edge_type: link.text,
        created_at: now,
      });
    }
  }

  const events: WikiEvent[] = [];
  if (logContent != null) {
    const logPath = logMdPath ?? `entities/${entityId}/log.md`;
    for (const entry of parseLogMd(logContent)) {
      const parsed = parseLogEntryText(entry.text);
      if (!parsed) continue;
      let related_entry_id: string | null = null;
      if (parsed.linkPath) {
        const targetPath = resolveRelativePath(logPath, parsed.linkPath);
        if (!isStructuralPath(targetPath)) {
          related_entry_id = lookupResolvedId(pathToResolvedId, targetPath) ?? null;
        }
      }
      events.push({
        id: generateId('evt_'),
        entity_id: entityId,
        event_type: parsed.event_type,
        summary: parsed.summary,
        related_entry_id,
        created_at: new Date(`${entry.date}T00:00:00.000Z`).getTime(),
      });
    }
  }

  return {
    generatedAt: now,
    entities: {
      [entityId]: { facts, tasks, events, edges },
    },
  };
}
