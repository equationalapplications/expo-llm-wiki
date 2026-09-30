import type { WikiEvent } from '../../../types';

export const OPS_NEIGHBOUR_BODY_CHARS = 400;

export function normalizeFactText(title: string, body: string): string {
  return `${title} ${body}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export type LabeledEvent = { label: string; event: WikiEvent; at: number };

export function labelEvents(events: WikiEvent[]): LabeledEvent[] {
  return events.map((event, i) => ({ label: `e${i + 1}`, event, at: event.occurred_at ?? event.created_at }));
}

export function parseValidFrom(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) && t >= 0 ? t : undefined;
  }
  return undefined;
}
