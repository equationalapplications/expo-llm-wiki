// GoatCounter analytics guard (spec: specs/goatcounter-analytics-tag/spec.md).
//
// 1. Self-test first: the checker must PASS on a good fixture, and FAIL on
//    stripped-config, misordered, missing-tag, cross-origin-src, and
//    wrong-endpoint fixtures — negative cases stay permanent, not manual.
// 2. Vendored count.js (repo copy AND built dist copy) must hash-match the
//    `vendored-sha256:` line recorded in the spec (offline; any edit — incl.
//    line-ending normalization — must update the spec hash in the same PR).
// 3. Built HTML must carry the EXACT inline config BEFORE the EXACT script tag
//    — same-origin src (vendoring must never regress to a remote script: the
//    stats host must not regain script-execution privilege on this origin,
//    which also hosts wiki-demo's sessionStorage API keys) and the right
//    endpoint (Host-header site resolution means a wrong endpoint silently
//    counts into the wrong site). Zero pages found is a FAILURE
//    (fail-closed), not a pass.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SPEC = path.join(REPO_ROOT, 'specs/goatcounter-analytics-tag/spec.md');
const DIST = path.join(REPO_ROOT, 'apps/docs/dist');
const VENDORED = path.join(REPO_ROOT, 'apps/docs/public/count.js');
const TOKEN_FILE = 'googleff7d7181e1455d40.html';
const INLINE_CONFIG = 'window.goatcounter = { path: (p) => location.host + p }';
// Full element forms as emitted by Starlight (verified in dist). Anchoring on
// the complete elements — not loose substrings like `count.js` — is what pins
// the script to the vendored same-origin asset and the correct endpoint, and
// blocks a SECOND tracking tag with a remote src or wrong endpoint, or either
// marker hiding inside an HTML comment. NOTE: if the renderer ever reorders
// the tag's attributes, this fails the build BY DESIGN — update TAG to match
// and re-verify.
const INLINE_ELEMENT = `<script>${INLINE_CONFIG}</script>`;
const TAG_ELEMENT = '<script async src="/expo-llm-wiki/count.js" data-goatcounter="https://stats.equationalapplications.com/count">';
const TAG_MARKER = 'vendored-sha256:';

function recordedHash() {
  const spec = fs.readFileSync(SPEC, 'utf8');
  const m = spec.match(new RegExp(`${TAG_MARKER}\\s*([0-9a-f]{64})`));
  if (!m) throw new Error(`spec has no "${TAG_MARKER} <64-hex>" line`);
  return m[1];
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function checkHtml(html) {
  // Strip HTML comments first: a commented-out config or tag must NOT count
  // as present (text inside <!-- --> still substring-matches otherwise).
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  const tagCount = (html.match(/<script\b[^>]*data-goatcounter/g) || []).length;
  if (tagCount === 0) return 'MISSING data-goatcounter tag';
  if (tagCount > 1) return `SECOND tracking tag present (${tagCount} data-goatcounter scripts)`;
  if (!html.includes(INLINE_ELEMENT)) return 'MISSING exact inline config element (silent schema strip or commented out?)';
  if (!html.includes(TAG_ELEMENT)) {
    return 'MISSING exact vendored tag element (src must be same-origin /expo-llm-wiki/count.js '
      + 'with endpoint https://stats.equationalapplications.com/count)';
  }
  const iCfg = html.indexOf(INLINE_ELEMENT);
  const iTag = html.indexOf(TAG_ELEMENT);
  if (iCfg > iTag) return 'ORDER WRONG: inline config after count.js tag';
  // The stats host must appear ONLY inside the endpoint attribute: any other
  // reference (a remote <script src> from the stats host, even without the
  // tracking attribute) would grant it script-execution privilege over this
  // origin — the exact trust extension vendoring exists to remove.
  const outside = html.replace(TAG_ELEMENT, '');
  if (outside.includes('stats.equationalapplications.com')) {
    return 'UNEXPECTED stats-host reference outside the tracking endpoint attribute';
  }
  return null;
}

function runChecker(distDir) {
  const hash = recordedHash();
  for (const [label, file] of [['repo vendored', VENDORED], ['dist vendored', path.join(distDir, 'count.js')]]) {
    const actual = sha256(file);
    if (actual !== hash) {
      console.error(`GoatCounter guard FAIL: ${label} copy hash ${actual} != spec ${hash}`);
      process.exit(1);
    }
  }
  let checked = 0;
  const fail = (msg) => { console.error(`GoatCounter guard FAIL: ${msg}`); process.exit(1); };
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.html') || e.name === TOKEN_FILE) continue;
      checked++;
      const err = checkHtml(fs.readFileSync(p, 'utf8'));
      if (err) fail(`${p}: ${err}`);
    }
  })(distDir);
  if (checked === 0) fail(`no HTML pages found under ${distDir} (fail-closed)`);
  console.log(`GoatCounter guard: checked=${checked} failures=0, sha256 OK (repo + dist)`);
}

function selfTest() {
  const good = `<head>${INLINE_ELEMENT}</head><body>${TAG_ELEMENT}</script></body>`;
  const stripped = `<head></head><body>${TAG_ELEMENT}</script></body>`;
  const misordered = `<head>${TAG_ELEMENT}</script>${INLINE_ELEMENT}</head>`;
  const missingTag = `<head>${INLINE_ELEMENT}</head><body><p>no tag</p></body>`;
  const crossOrigin = `<head>${INLINE_ELEMENT}</head><body><script async src="https://stats.equationalapplications.com/count.js" data-goatcounter="https://stats.equationalapplications.com/count"></script></body>`;
  const wrongEndpoint = `<head>${INLINE_ELEMENT}</head><body><script async src="/expo-llm-wiki/count.js" data-goatcounter="https://stats.example.com/count"></script></body>`;
  const twoTags = `<head>${INLINE_ELEMENT}${TAG_ELEMENT}</script></head><body><script async src="https://stats.equationalapplications.com/count.js" data-goatcounter="https://stats.equationalapplications.com/count"></script></body>`;
  const commented = `<head><!-- ${INLINE_ELEMENT} --></head><body>${TAG_ELEMENT}</script></body>`;
  const cases = [
    ['good', good, null],
    ['stripped-config', stripped, 'FAIL'],
    ['misordered', misordered, 'FAIL'],
    ['missing-tag', missingTag, 'FAIL'],
    ['cross-origin-src', crossOrigin, 'FAIL'],
    ['wrong-endpoint', wrongEndpoint, 'FAIL'],
    ['two-tags', twoTags, 'FAIL'],
    ['commented-config', commented, 'FAIL'],
    ['remote-script-no-attr', `<head>${INLINE_ELEMENT}${TAG_ELEMENT}></script></head><body><script src="https://stats.equationalapplications.com/other.js"></script></body>`, 'FAIL'],
  ];
  for (const [name, fx, want] of cases) {
    const got = checkHtml(fx);
    if (want === null && got !== null) { console.error(`self-test FAIL: ${name} rejected: ${got}`); process.exit(1); }
    if (want === 'FAIL' && got === null) { console.error(`self-test FAIL: ${name} fixture passed`); process.exit(1); }
  }
  console.log(`GoatCounter guard self-test: ${cases.length}/${cases.length} fixtures behave as expected`);
}

selfTest();
runChecker(DIST);
