// GoatCounter analytics guard (spec: specs/goatcounter-analytics-tag/spec.md).
//
// 1. Self-test first: the checker must PASS on a good fixture, and FAIL on a
//    stripped-config fixture and on a misordered fixture — this keeps the
//    negative cases permanent instead of manual-only.
// 2. Vendored count.js (repo copy AND built dist copy) must hash-match the
//    `vendored-sha256:` line recorded in the spec (offline; any edit — incl.
//    line-ending normalization — must update the spec hash in the same PR).
// 3. Built HTML must carry the EXACT inline config before the count.js tag on
//    every generated page except the Search Console token file. Substring
//    anchors are exact on purpose: a loose `location.host` probe would
//    false-pass if the inline script were stripped while some other page
//    script mentioned location.host. Zero pages found is a FAILURE
//    (fail-closed), not a pass.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const REPO_ROOT = path.resolve(new URL(import.meta.url).pathname, '..', '..', '..', '..');
const SPEC = path.join(REPO_ROOT, 'specs/goatcounter-analytics-tag/spec.md');
const DIST = path.join(REPO_ROOT, 'apps/docs/dist');
const VENDORED = path.join(REPO_ROOT, 'apps/docs/public/count.js');
const TOKEN_FILE = 'googleff7d7181e1455d40.html';
const INLINE_CONFIG = 'window.goatcounter = { path: (p) => location.host + p }';
const TAG_MARKER = 'vendored-sha256:';

function recordedHash() {
  const spec = fs.readFileSync(SPEC, 'utf8');
  const m = spec.match(new RegExp(`${TAG_MARKER}\\s*([0-9a-f]{64})`));
  if (!m) throw new Error(`spec has no "${TAG_MARKER} <64-hex>" line`);
  return m[1];
}

export function checkHtml(html) {
  if (!html.includes('data-goatcounter')) return 'MISSING data-goatcounter tag';
  const iCfg = html.indexOf(INLINE_CONFIG);
  if (iCfg === -1) return 'MISSING exact inline config (silent schema strip?)';
  const iTag = html.indexOf('count.js');
  if (iTag === -1) return 'MISSING count.js tag';
  if (!(iCfg < iTag)) return 'ORDER WRONG: inline config after count.js tag';
  return null;
}

function runChecker(distDir) {
  const hash = recordedHash();
  for (const [label, file] of [['repo vendored', VENDORED], ['dist vendored', path.join(distDir, 'count.js')]]) {
    const actual = execSync(`sha256sum "${file}"`).toString().split(' ')[0];
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
  const good = `<head>${INLINE_CONFIG}</head><body><script data-goatcounter="https://x/count" src="/b/count.js"></script>`;
  const stripped = `<head></head><body><script data-goatcounter="https://x/count" src="/b/count.js"></script>`;
  const misordered = `<head><script data-goatcounter="https://x/count" src="/b/count.js"></script>${INLINE_CONFIG}</head>`;
  if (checkHtml(good) !== null) { console.error('self-test FAIL: good fixture rejected'); process.exit(1); }
  for (const [name, fx] of [['stripped', stripped], ['misordered', misordered]]) {
    if (checkHtml(fx) === null) { console.error(`self-test FAIL: ${name} fixture passed`); process.exit(1); }
  }
  console.log('GoatCounter guard self-test: 3/3 fixtures behave as expected');
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  selfTest();
  runChecker(DIST);
}
