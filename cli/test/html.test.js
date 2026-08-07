'use strict';
// Static checks on the served HTML.
//
// A syntax error in dashboard.html is invisible to every server-side test: the gateway
// returns 200, the page renders its skeleton, and every panel stays empty — which looks
// exactly like "you have no savings". These checks make that class of failure loud.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const APP = path.join(__dirname, '..', 'assets', 'gateway', 'app');
const PAGES = ['dashboard.html', 'report.html'];

function scriptBlocks(html) {
  // Skip <script type="application/json"> — that is embedded DATA, not code.
  const re = /<script(?![^>]*\btype\s*=\s*["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) if (m[1].trim()) out.push(m[1]);
  return out;
}

for (const page of PAGES) {
  test(`${page}: every inline script parses`, () => {
    const file = path.join(APP, page);
    if (!fs.existsSync(file)) return;               // report.html is optional in some builds
    const blocks = scriptBlocks(fs.readFileSync(file, 'utf8'));
    assert.ok(blocks.length > 0, `${page} has no inline script — did the extractor break?`);
    blocks.forEach((code, i) => {
      const tmp = path.join(os.tmpdir(), `cheaper-${page}-${process.pid}-${i}.js`);
      fs.writeFileSync(tmp, code);
      const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
      fs.unlinkSync(tmp);
      assert.strictEqual(r.status, 0, `${page} script block ${i} failed to parse:\n${r.stderr}`);
    });
  });
}

test('dashboard.html: exactly ONE tab <nav>, or both handlers fire on hashchange', () => {
  const html = fs.readFileSync(path.join(APP, 'dashboard.html'), 'utf8');
  const navs = html.match(/class="tabs"/g) || [];
  assert.strictEqual(navs.length, 1,
    'a second tabs nav would double-handle every hashchange');
});

test('dashboard.html: basis and grain columns exist and are marked non-hideable', () => {
  const html = fs.readFileSync(path.join(APP, 'dashboard.html'), 'utf8');
  // These two columns are what keep a per-call measured figure from being read in the
  // same column as a per-chat estimated one. A "simplify the table" change that drops
  // them re-introduces the concealment bug, so their presence is pinned by a test.
  assert.match(html, /<th class="locked"[^>]*>Basis<\/th>/);
  assert.match(html, /<th class="locked"[^>]*>Grain<\/th>/);
});

test('dashboard.html: the register never renders $0.00 for an unpriceable cell', () => {
  const html = fs.readFileSync(path.join(APP, 'dashboard.html'), 'utf8');
  // auditCost/auditDelta must return an em dash for null, never money(0).
  assert.match(html, /function auditCost\(v, why\)\{[\s\S]{0,400}?nodata[\s\S]{0,200}?&mdash;/);
  assert.ok(!/money\(v \|\| 0\)/.test(html),
    '`money(v || 0)` would turn "no figure claimed" into a measured $0.00');
});

test('dashboard.html: the token never appears in a data-* attribute or inline literal', () => {
  const html = fs.readFileSync(path.join(APP, 'dashboard.html'), 'utf8');
  // The secret arrives in the URL and is moved to sessionStorage; nothing in the SERVED
  // bytes may contain it, or a cached copy on disk would leak it.
  assert.ok(!/[0-9a-f]{64}/.test(html), 'a 64-hex literal in the markup looks like a token');
});

test('dashboard.html: a print stylesheet exists and prints every pane', () => {
  const html = fs.readFileSync(path.join(APP, 'dashboard.html'), 'utf8');
  assert.match(html, /@media print/);
  // Browser print-to-PDF is the supported PDF path (no PDF library, no headless
  // browser), so a printed report that silently omitted three of four tabs would be
  // worse than no print support at all.
  assert.match(html, /\.tabpane\{display:block !important/);
});

test('dashboard.html: light mode follows the OS until the user chooses', () => {
  const html = fs.readFileSync(path.join(APP, 'dashboard.html'), 'utf8');
  assert.match(html, /@media \(prefers-color-scheme: light\)/);
  // …and an explicit choice must still win over the OS.
  assert.match(html, /:root\[data-theme="dark"\]\{/);
  assert.match(html, /:root\[data-theme="light"\]\{/);
});
