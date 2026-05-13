import type { MemoryBundle, WikiFact, WikiTask, WikiEvent, FormatContextOptions } from '../types';

function validateMaxOption(value: number, name: string): void {
  if (!isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name}: must be a non-negative finite number`);
  }
}

const CONFIDENCE_WEIGHT: Record<string, number> = {
  certain: 1.0,
  inferred: 0.6,
  tentative: 0.3,
};

function scoreFactFor(
  fact: WikiFact,
  weights: Required<NonNullable<FormatContextOptions['factWeights']>>,
  now: number
): number {
  const confW = CONFIDENCE_WEIGHT[fact.confidence] ?? 0.3;
  const ageDays = (now - fact.updated_at) / 86400000;
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
  includeTags: boolean,
  includeEntityIds: boolean,
  score: number | undefined,
): string {
  const confPart = includeConfidence ? ` (${fact.confidence})` : '';
  const tagPart = includeTags && fact.tags.length > 0 ? ` [${fact.tags.join(', ')}]` : '';
  const sourcePart = includeEntityIds ? ` {entity_id=${fact.entity_id}}` : '';
  const scorePart = score !== undefined ? ` {score=${score.toFixed(4)}}` : '';
  return `- **${fact.title}**${confPart}${tagPart}${sourcePart}${scorePart}\n  ${fact.body.replace(/\n/g, '\n  ')}`;
}

function renderFactPlain(
  fact: WikiFact,
  includeConfidence: boolean,
  includeTags: boolean,
  includeEntityIds: boolean,
  score: number | undefined,
): string {
  const confPart = includeConfidence ? ` (${fact.confidence})` : '';
  const tagPart = includeTags && fact.tags.length > 0 ? ` [${fact.tags.join(', ')}]` : '';
  const sourcePart = includeEntityIds ? ` {entity_id=${fact.entity_id}}` : '';
  const scorePart = score !== undefined ? ` {score=${score.toFixed(4)}}` : '';
  return `${fact.title}${confPart}${tagPart}${sourcePart}${scorePart}: ${fact.body}`;
}

function renderTaskMarkdown(task: WikiTask): string {
  return `- [P${task.priority}] ${task.description.replace(/\n/g, '\n  ')} (${task.status})`;
}

function renderTaskPlain(task: WikiTask): string {
  return `[P${task.priority}] ${task.description} (${task.status})`;
}

function renderEventMarkdown(event: WikiEvent): string {
  const ts = new Date(event.created_at).toISOString();
  return `- [${event.event_type} @ ${ts}] ${event.summary.replace(/\n/g, '\n  ')}`;
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
    includeEntityIds: options?.includeEntityIds ?? false,
    includeFactScores: options?.includeFactScores ?? false,
    factWeights: {
      confidence: options?.factWeights?.confidence ?? 1.0,
      accessCount: options?.factWeights?.accessCount ?? 0.3,
      recency: options?.factWeights?.recency ?? 0.5,
    },
  };

  validateMaxOption(opts.maxFacts, 'maxFacts');
  validateMaxOption(opts.maxTasks, 'maxTasks');
  validateMaxOption(opts.maxEvents, 'maxEvents');

  const weights = opts.factWeights as Required<NonNullable<FormatContextOptions['factWeights']>>;

  const now = Date.now();
  const sortedFacts = bundle.factScores
    ? [...bundle.facts].slice(0, opts.maxFacts)
    : [...bundle.facts]
        .sort((a, b) => scoreFactFor(b, weights, now) - scoreFactFor(a, weights, now))
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
      lines.push('');
      lines.push('### Known Facts');
      for (const fact of sortedFacts) {
        lines.push(renderFactMarkdown(fact, opts.includeConfidence, opts.includeTags, opts.includeEntityIds, opts.includeFactScores ? bundle.factScores?.[fact.id] : undefined));
      }
    }

    if (sortedTasks.length > 0) {
      lines.push('');
      lines.push('### Open Tasks');
      for (const task of sortedTasks) {
        lines.push(renderTaskMarkdown(task));
      }
    }

    if (sortedEvents.length > 0) {
      lines.push('');
      lines.push('### Recent Events');
      for (const event of sortedEvents) {
        lines.push(renderEventMarkdown(event));
      }
    }
  } else {
    if (sortedFacts.length > 0) {
      lines.push('KNOWN FACTS:');
      for (const fact of sortedFacts) {
        lines.push(renderFactPlain(fact, opts.includeConfidence, opts.includeTags, opts.includeEntityIds, opts.includeFactScores ? bundle.factScores?.[fact.id] : undefined));
      }
    }
    if (sortedTasks.length > 0) {
      lines.push('OPEN TASKS:');
      for (const task of sortedTasks) {
        lines.push(renderTaskPlain(task));
      }
    }
    if (sortedEvents.length > 0) {
      lines.push('RECENT EVENTS:');
      for (const event of sortedEvents) {
        lines.push(renderEventPlain(event));
      }
    }
  }

  return lines.join('\n');
}
