import type {
  OkfVerified,
  OkfVerifiedEntry,
  OkfSource,
  OkfSourceUsageWindow,
} from './types';

export type TrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed';

export function deriveTrustTier(verified: OkfVerified | undefined): TrustTier {
  if (!verified || verified.length === 0) return 'unverified';
  for (const v of verified) {
    if (typeof v?.by === 'string' && v.by.startsWith('human:')) return 'human-reviewed';
  }
  return 'machine-confirmed';
}

function parseStaleAfter(staleAfter: string | number | null): number | null {
  if (staleAfter == null) return null;
  if (typeof staleAfter === 'number') return Number.isFinite(staleAfter) ? staleAfter : null;
  // YYYY-MM-DD — compare at day granularity: stale_after is the first day that IS stale.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(staleAfter);
  if (!match) return null;
  const ts = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ts) ? ts : null;
}

export function isStaleAfter(staleAfter: string | number | null, now: number): boolean {
  const cutoff = parseStaleAfter(staleAfter);
  if (cutoff == null) return false;
  return now >= cutoff;
}

export function parseVerifiedFlexible(value: unknown): OkfVerified {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.filter(
      (v): v is OkfVerifiedEntry =>
        !!v && typeof v === 'object' && typeof (v as any).by === 'string' && typeof (v as any).at === 'string',
    );
  }
  if (typeof value === 'object' && typeof (value as any).by === 'string' && typeof (value as any).at === 'string') {
    return [value as OkfVerifiedEntry];
  }
  return [];
}

export function formatVerifiedJson(entries: OkfVerified): string {
  const sorted = [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return JSON.stringify(sorted);
}

export function formatSourcesJson(sources: OkfSource[], sharedWindow?: OkfSourceUsageWindow | null): string {
  const folded = sources.map((s) =>
    s.usage_window ? s : sharedWindow ? { ...s, usage_window: sharedWindow } : s,
  );
  return JSON.stringify(folded);
}

export function latestVerified(
  entries: OkfVerified | undefined,
  _now: number,
): { by: string; at: number } | null {
  if (!entries || entries.length === 0) return null;
  let best: OkfVerifiedEntry | null = null;
  let bestAt = -Infinity;
  for (const e of entries) {
    const ts = Date.parse(e.at);
    if (Number.isFinite(ts) && ts > bestAt) {
      best = e;
      bestAt = ts;
    }
  }
  if (!best) return null;
  return { by: best.by, at: bestAt };
}

const URL_LINE = /^\s*-\s+(https?:\/\/\S+)\s*$/;

export function parseCitationsList(body: string): string[] {
  // Find a '# Citations' (case-insensitive) heading; collect URL list lines until the next heading or EOF.
  const lines = body.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^\s*#{1,2}\s*citations\s*$/i.test(l));
  if (startIdx === -1) return [];
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#{1,2}\s+/.test(line)) break; // next heading
    const m = URL_LINE.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}