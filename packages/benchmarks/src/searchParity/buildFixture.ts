// packages/benchmarks/src/searchParity/buildFixture.ts
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM adaptation: this package is `"type": "module"`, so derive __dirname
// from import.meta.url (same pattern as src/cli.ts and src/embed.ts).
const __dirname = dirname(fileURLToPath(import.meta.url));

const ROOT = resolve(__dirname, '../../../..');
const SPECS = join(ROOT, 'docs/superpowers/specs');
const OUT = resolve(__dirname, '../../fixtures/searchParity.json');
const STOP = new Set(['that', 'this', 'with', 'from', 'when', 'have', 'into', 'than', 'then', 'they', 'them',
  'will', 'must', 'each', 'only', 'does', 'were', 'what', 'which', 'there', 'their', 'about', 'would', 'should']);

// mulberry32: tiny seeded PRNG so the fixture is reproducible.
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const docs: { id: string; title: string; body: string; tags: string[] }[] = [];
for (const file of readdirSync(SPECS).filter((f) => f.endsWith('.md')).sort()) {
  const text = readFileSync(join(SPECS, file), 'utf8').replace(/```[\s\S]*?```/g, ' ');
  const parts = text.split(/^#{2,3} /m).slice(1);
  parts.forEach((part, i) => {
    const [heading, ...rest] = part.split('\n');
    const body = rest.join(' ').replace(/[|`*_>#-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (body.length < 120) return;
    docs.push({ id: `${file.replace(/\.md$/, '')}#${i}`, title: heading.trim(), body: body.slice(0, 4000), tags: [] });
  });
}

const rand = rng(257);
const queries: string[] = [];
const words = (s: string) => (s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w));
while (queries.length < 250) {
  const d = docs[Math.floor(rand() * docs.length)];
  const pool = [...words(d.title), ...words(d.body)];
  if (pool.length < 3) continue;
  const n = 1 + Math.floor(rand() * 3);
  const q = Array.from({ length: n }, () => pool[Math.floor(rand() * pool.length)]).join(' ');
  if (!queries.includes(q)) queries.push(q);
}

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), source: 'docs/superpowers/specs/*.md', docs, queries }, null, 1) + '\n');
console.log(`wrote ${docs.length} docs, ${queries.length} queries to ${OUT}`);
