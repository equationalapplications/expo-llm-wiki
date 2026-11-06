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
// Exact attribute order as emitted by the Starlight head renderer (verified in
// dist); a reorder of attrs still passes as long as both exact attr substrings
// appear in this same tag string. Matching the FULL tag (not loose substrings
// like `count.js`) is what pins the script to the vendored same-origin asset
// and the correct endpoint.
const TAG = 'src="/expo-llm-wiki/count.js" data-goatcounter="https://stats.equationalapplications.com/count"';
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

export function checkHtml(html) {
  if (!html.includes('data-goatcounter')) return 'MISSING data-goatcounter tag';
  const iCfg = html.indexOf(INLINE_CONFIG);
  if (iCfg === -1) return 'MISSING exact inline config (silent schema strip?)';
  if (!html.includes(TAG)) {
    return 'MISSING exact tag (src must be the VENDORED same-origin /expo-llm-wiki/count.js '
      + 'with endpoint https://stats.equationalapplications.com/count)';
  }
  const iCfgLast = html.lastIndexOf(INLINE_CONFIG);
  const iTag = html.indexOf(TAG);
  if (!(iCfg < iTag && iTag < iCfgLast + INLINE_CONFIG.length + iTag)) {
    // ordering: the FIRST inline config occurrence must precede the tag
    if (!(iCfg < iTag)) return 'ORDER WRONG: inline config after count.js tag';
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
  const tag = (attrs) => `<script ${attrs ?? 'async ' + TAG}></script>`;
  const good = `<head>${INLINE_CONFIG}</head><body>${tag()}</body>`;
  const stripped = `<head></head><body>${tag()}</body>`;
  const misordered = `<head>${tag()}${INLINE_CONFIG}</head>`;
  const missingTag = `<head>${INLINE_CONFIG}</head><body><p>no tag</p></body>`;
  const crossOrigin = `<head>${INLINE_CONFIG}</head><body>${tag('async src="https://stats.equationalapplications.com/count.js" data-goatcounter="https://stats.equationalapplications.com/count"')}</body>`;
  const wrongEndpoint = `<head>${INLINE_CONFIG}</head><body>${tag('async src="/expo-llm-wiki/count.js" data-goatcounter="https://stats.example.com/count"')}</body>`;
  const cases = [
    ['good', good, null],
    ['stripped-config', stripped, 'FAIL'],
    ['misordered', misordered, 'FAIL'],
    ['missing-tag', missingTag, 'FAIL'],
    ['cross-origin-src', crossOrigin, 'FAIL'],
    ['wrong-endpoint', wrongEndpoint, 'FAIL'],
  ];
  for (const [name, fx, want] of cases) {
    const got = checkHtml(fx);
    if (want === null && got !== null) { console.error(`self-test FAIL: ${name} rejected: ${got}`); process.exit(1); }
    if (want === 'FAIL' && got === null) { console.error(`self-test FAIL: ${name} fixture passed`); process.exit(1); }
  }
  console.log('GoatCounter guard self-test: 6/6 fixtures behave as expected');
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  selfTest();
  runChecker(DIST);
}
