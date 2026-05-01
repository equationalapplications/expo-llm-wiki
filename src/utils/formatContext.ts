import type { MemoryBundle, WikiFact, WikiTask, WikiEvent, FormatContextOptions } from '../types';

const CONFIDENCE_WEIGHT: Record<string, number> = {
  certain: 1.0,
  inferred: 0.6,
  tentative: 0.3,
};

function scoreFactFor(
  fact: WikiFact,
  weights: Required<NonNullable<FormatContextOptions['factWeights']>>
): number {
  const confW = CONFIDENCE_WEIGHT[fact.confidence] ?? 0.3;
  const ageDays = (Date.now() - fact.updated_at) / 86400000;
  const recencyDecay = Math.exp(-ageDays / 30);
  return (
    confW * weights.confidence +
    Math.log(1 + fact.access_count) * weights.accessCount +
    recencyDecay * weights.recency
  );
}

function renderFactMarkdown(
  fact: WikiFact,
  includeConfidence: boolean,
  includeTags: boolean
): string {
  const confPart = includeConfidence ? ` (${fact.confidence})` : '';
  const tagPart =
    includeTags && fact.tags.length > 0 ? ` [${fact.tags.join(', ')}]` : '';
  return `- **${fact.title}**${confPart}${tagPart}\n  ${fact.body}`;
}

function renderFactPlain(
  fact: WikiFact,
  includeConfidence: boolean,
  includeTags: boolean
): string {
  const confPart = includeConfidence ? ` (${fact.confidence})` : '';
  const tagPart =
    includeTags && fact.tags.length > 0 ? ` [${fact.tags.join(', ')}]` : '';
  return `${fact.title}${confPart}${tagPart}: ${fact.body}`;
}

function renderTaskMarkdown(task: WikiTask): string {
  return `- [P${task.priority}] ${task.description} (${task.status})`;
}

function renderTaskPlain(task: WikiTask): string {
  return `[P${task.priority}] ${task.description} (${task.status})`;
}

function renderEventMarkdown(event: WikiEvent): string {
  const ts = new Date(event.created_at).toISOString();
  return `- [${event.event_type} @ ${ts}] ${event.summary}`;
}

function renderEventPlain(event: WikiEvent): string {
  const ts = new Date(event.created_at).toISOString();
  return `[${event.event_type} @ ${ts}] ${event.summary}`;
}

export function formatContext(
  bundle: MemoryBundle,
  options?: FormatContextOptions
): string {
  const opts: Required<FormatContextOptions> = {
    format: options?.format ?? 'markdown',
    maxFacts: options?.maxFacts ?? 10,
    maxTasks: options?.maxTasks ?? 10,
    maxEvents: options?.maxEvents ?? 10,
    includeConfidence: options?.includeConfidence ?? true,
    includeTags: options?.includeTags ?? true,
    factWeights: {
      confidence: options?.factWeights?.confidence ?? 1.0,
      accessCount: options?.factWeights?.accessCount ?? 0.3,
      recency: options?.factWeights?.recency ?? 0.5,
    },
  };

  const weights = opts.factWeights as Required<NonNullable<FormatContextOptions['factWeights']>>;

  const sortedFacts = [...bundle.facts]
    .sort((a, b) => scoreFactFor(b, weights) - scoreFactFor(a, weights))
    .slice(0, opts.maxFacts);

  const sortedTasks = [...bundle.tasks]
    .sort((a, b) => b.priority - a.priority || a.created_at - b.created_at)
    .slice(0, opts.maxTasks);

  const sortedEvents = [...bundle.events]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, opts.maxEvents);

  if (sortedFacts.length === 0 && sortedTasks.length === 0 && sortedEvents.length === 0) {
    return '';
  }

  const isMarkdown = opts.format === 'markdown';
  const lines: string[] = [];

  if (isMarkdown) {
    lines.push('## Memory');

    if (sortedFacts.length > 0) {
      lines.push('### Known Facts');
      for (const fact of sortedFacts) {
        lines.push(renderFactMarkdown(fact, opts.includeConfidence, opts.includeTags));
      }
    }

    if (sortedTasks.length > 0) {
      lines.push('### Open Tasks');
      for (const task of sortedTasks) {
        lines.push(renderTaskMarkdown(task));
      }
    }

    if (sortedEvents.length > 0) {
      lines.push('### Recent Events');
      for (const event of sortedEvents) {
        lines.push(renderEventMarkdown(event));
      }
    }
  } else {
    for (const fact of sortedFacts) {
      lines.push(renderFactPlain(fact, opts.includeConfidence, opts.includeTags));
    }
    for (const task of sortedTasks) {
      lines.push(renderTaskPlain(task));
    }
    for (const event of sortedEvents) {
      lines.push(renderEventPlain(event));
    }
  }

  return lines.join('\n');
}
