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

// ===========================================================================
// report.html — the print/PDF template.
//
// report.html is served by BOTH the legacy `/report` endpoint (Metrics.summary() only)
// and `/api/v1/report.html` (the same summary PLUS the redesigned `report` block). A
// static grep proves the markup is present; it cannot prove the renderer puts the right
// thing in the cell. So these tests actually EXECUTE the template's inline script against
// a minimal DOM stub and assert over what it produced — which is the only way to catch
// "an unpriceable cell rendered as $0.00", the defect this template shipped with.
// ===========================================================================

const REPORT = path.join(APP, 'report.html');

function readReport() { return fs.readFileSync(REPORT, 'utf8'); }

// Comments EXPLAIN the honesty rules ("never $0.00", "measured + estimated"), so a grep
// for a forbidden literal has to look at what the file EMITS, not at what it says about
// itself. Same syntax in the CSS block and the script block.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// Only the MARKUP — script and style bodies removed. Both carry `<`-bearing string and
// selector text that a naive tag scan would mistake for elements.
function markupOnly(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

// A DOM small enough to be obvious and large enough to run the template. Every element
// referenced by `id=` in the markup is created up front, so a getElementById the script
// makes is answered exactly as a browser would answer it.
//
// `hidden` is SEEDED FROM THE MARKUP, not hard-coded false. report.html declares its
// sections with a bare `hidden` attribute; a stub that starts every element visible makes
// `assert(els.secLadder.hidden === false)` pass whether or not `show('secLadder', true)`
// ever ran. Deleting that show() call served the ladder inside a hidden section — and the
// print rule `section.sec:not([hidden]){display:block !important}` keeps it hidden on
// paper, so the printed PDF had no period ladder at all — and every test still passed.
function renderReport(payload) {
  const html = readReport();
  const code = scriptBlocks(html).join('\n;\n');
  const els = Object.create(null);
  const mk = (id, hidden) => (els[id] = {
    id, innerHTML: '', textContent: '', hidden: !!hidden,
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
  });
  const markup = markupOnly(html);
  let m;
  const tagRe = /<[a-zA-Z][^>]*>/g;
  while ((m = tagRe.exec(markup)) !== null) {
    const idm = /\bid="([A-Za-z0-9_-]+)"/.exec(m[0]);
    // A bare boolean `hidden`, not `hidden="…"` and not the substring of another word.
    if (idm) mk(idm[1], /\shidden(?=[\s/>])/.test(m[0]));
  }
  // Never null, so a template that starts using querySelector fails on a rendered-output
  // assertion rather than on a TypeError inside the stub.
  const inert = { innerHTML: '', textContent: '', hidden: false,
    setAttribute() {}, removeAttribute() {}, addEventListener() {} };
  const doc = {
    getElementById(id) { return els[id] || null; },
    querySelector(sel) {
      const s = String(sel || '');
      return (s.charAt(0) === '#' ? els[s.slice(1)] : null) || inert;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    documentElement: { setAttribute() {}, removeAttribute() {}, getAttribute() { return null; } },
  };
  // The payload is EMBEDDED, exactly as app.py embeds it — never fetched.
  mk('report-data', false).textContent = JSON.stringify(payload);
  new Function('document', 'window', code)(doc, { print() {}, addEventListener() {} });
  // The raw JSON block is DATA, not rendered output; including it would make every
  // escaping assertion pass or fail on the payload rather than on the renderer.
  const out = Object.keys(els)
    .filter((k) => k !== 'report-data')
    .map((k) => `${els[k].innerHTML || ''}\n${els[k].textContent || ''}`)
    .join('\n');
  return { out, els };
}

// ---------------------------------------------------------------------------
// Readers over RENDERED OUTPUT.
//
// Every honesty rule this template exists to enforce is a claim about a VALUE in a CELL.
// A source-text grep cannot see one: the cross-basis regex was written in dot notation
// while the template's idiom is bracket notation, so a blended "Saved (all bases) $1.15"
// card written exactly in-idiom passed 19/19. These read what the renderer produced.
// ---------------------------------------------------------------------------
const text = (s) => String(s).replace(/<[^>]*>/g, '').trim();

function ladderRow(els, selector) {
  const body = els.ladderBody.innerHTML;
  const re = new RegExp(`<tr ${selector}>([\\s\\S]*?)<\\/tr>`);
  const m = re.exec(body);
  assert.ok(m, `ladder row <tr ${selector}> is missing`);
  return m[1];
}

// Cells in document order. No <td> nests another <td>, so non-greedy is exact.
const cellsOf = (rowHtml) => rowHtml.match(/<td\b[^>]*>[\s\S]*?<\/td>/g) || [];

// The ladder total, as the six basis columns the design says MAY legitimately be added:
// [saved measured, saved estimated, spent measured, spent estimated, ev m, ev e].
function ladderTotals(els) {
  const c = cellsOf(ladderRow(els, 'class="total"'));
  assert.strictEqual(c.length, 9, 'the ladder total row lost or gained a column');
  return {
    savedMeasured: text(c[1]), savedEstimated: text(c[2]),
    spentMeasured: text(c[3]), spentEstimated: text(c[4]),
    eventsMeasured: text(c[5]), eventsEstimated: text(c[6]),
    raw: { savedMeasured: c[1], savedEstimated: c[2],
           spentMeasured: c[3], spentEstimated: c[4] },
  };
}

function kpiMap(els) {
  const out = Object.create(null);
  String(els.kpis.innerHTML).split('<div class="kpi">').slice(1).forEach((card) => {
    const k = /<div class="k">([\s\S]*?)<\/div>/.exec(card);
    const v = /<div class="v ?([^"]*)">([\s\S]*?)<\/div><div class="s">([\s\S]*?)<\/div>/.exec(card);
    if (!k || !v) return;
    out[text(k[1])] = { cls: v[1].trim(), raw: v[2], value: text(v[2]), sub: text(v[3]) };
  });
  return out;
}

// Every dollar figure the page rendered, anywhere, in any element.
//
// The ASCII hyphen-minus ("-"), not U+2212: report.html's money() used to emit the
// Unicode minus sign, which read fine on screen but broke a copy-paste into a
// spreadsheet (Excel/Sheets/Numbers parse "-$0.40" as a number and "−$0.40" as text).
// dashboard.html's money() and cli/src/reports.js already used ASCII; money() here was
// the odd one out and now matches. This matcher follows the fixed convention.
const dollarsIn = (out) => (out.match(/-?\$[\d,]+\.\d{2}/g) || []);

const ACC = (o) => Object.assign(
  { calls: 0, tokens: 0, saved: 0, spent: 0, baseline: 0, gross: 0, extra: 0 }, o);

// The DISJOINT ladder as reporting.report_periods() emits it, exercising every state the
// renderer has to survive: ok, not_covered, dollars_suppressed, a NEGATIVE (costlier)
// delta, and an estimated-only window.
const LADDER = [
  { key: 'today', label: 'Today', bounds_label: '2026-08-07 00:00 → 2026-08-08 00:00 (UTC, UTC+00:00)',
    status: 'ok', grain: 'call', dollars_suppressed: false,
    measured: ACC({ calls: 3, tokens: 900, saved: 1.25, spent: 0.75, baseline: 2.0 }),
    estimated: ACC({}), events: { measured: 3, estimated: 0 },
    tokens: { measured: 900, estimated: 0 },
    unpriced_calls: 0, unpriced: {}, undated: 0, labels: [], notes: [] },
  { key: 'week_earlier', label: 'Earlier this week', bounds_label: '2026-08-03 00:00 → 2026-08-07 00:00 (UTC, UTC+00:00)',
    status: 'not_covered', grain: 'call', measured: null, estimated: null,
    events: {}, unpriced_calls: 0, labels: ['not_covered'],
    notes: ['Cheaper was not watching during this period. That is not the same as saving $0.'] },
  { key: 'month_earlier', label: 'Earlier this month', bounds_label: '2026-08-01 00:00 → 2026-08-03 00:00 (UTC, UTC+00:00)',
    status: 'suppressed', grain: 'call', dollars_suppressed: true,
    measured: ACC({ calls: 1, tokens: 50, saved: null, spent: null, baseline: null, gross: null, extra: null }),
    estimated: ACC({ saved: null, spent: null, baseline: null, gross: null, extra: null }),
    events: { measured: 1, estimated: 0 }, unpriced_calls: 1,
    unpriced: { no_catalog_entry: 1 }, labels: ['dollars_suppressed'],
    notes: ['1 of 1 call(s) in this window (100% of its tokens) are not in the price catalog.'] },
  { key: 'quarter_earlier', label: 'Earlier this quarter', bounds_label: '2026-07-01 00:00 → 2026-08-01 00:00 (UTC, UTC+00:00)',
    status: 'ok', grain: 'call', dollars_suppressed: false,
    // A COSTLIER route. The sign must survive: never max(0, …).
    measured: ACC({ calls: 2, tokens: 400, saved: -0.4, spent: 1.4, baseline: 1.0 }),
    estimated: ACC({}), events: { measured: 2, estimated: 0 },
    unpriced_calls: 0, unpriced: {}, labels: [], notes: [] },
  { key: 'year_earlier', label: 'Earlier this year', bounds_label: '2026-01-01 00:00 → 2026-07-01 00:00 (UTC, UTC+00:00)',
    status: 'ok', grain: 'call', dollars_suppressed: false,
    measured: ACC({}), estimated: ACC({ calls: 2, tokens: 300, saved: 0.3, spent: 0.1, baseline: 0.4 }),
    events: { measured: 0, estimated: 2 }, unpriced_calls: 0, unpriced: {},
    labels: ['partial_coverage'], notes: ['Only part of this period is covered.'] },
  { key: 'before', label: 'Before this year', bounds_label: '— → 2026-01-01 00:00 (UTC, UTC+00:00)',
    status: 'ok', grain: 'call', dollars_suppressed: false,
    measured: ACC({}), estimated: ACC({}), events: { measured: 0, estimated: 0 },
    unpriced_calls: 0, unpriced: {}, labels: [], notes: [] },
];

const REPORT_PAYLOAD = {
  code_sha: 'deadbeefcafe0000',
  dollars: { saved: 1.15, spent: 2.25, savings_pct: 33.8, extra: 0.4 },
  counts: { intercepted: 8, models_changed: 5, models_upcharged: 2 },
  periods: {},
  // The gateway-proxy surfaces are present on BOTH payloads and are UNFILTERED lifetime
  // aggregates. They are populated here so their all-time scope caveat is exercised on
  // the very page whose masthead and provenance talk about a period.
  by_tool: [{ tool: 'claude-code', calls: 8, saved: 0.55, spent: 0.90, downgrade_rate: 62 }],
  by_tier: { haiku: { count: 5, in_tokens: 1000, out_tokens: 200 } },
  downgraded_by_model: { 'claude-haiku-4-5': 5 },
  upcharged_by_model: { 'claude-opus-4-6': 2 },
  catalog: { as_of: '2026-06-01', age_days: 67 },
  report: {
    grain: 'call',
    periods: LADDER,
    breakdown: {
      // A user-influenced string. It reaches the page as a model id and must come back
      // ESCAPED — this is an injection boundary, not tidiness.
      served: [{ key: '<img src=x onerror=alert(1)>', grain: 'call',
                 measured: ACC({ calls: 3, saved: 1.25, spent: 0.75 }),
                 estimated: ACC({}), events: { measured: 3, estimated: 0 },
                 unpriced_calls: 1, unpriced: { no_catalog_entry: 1 } }],
      base: [], tier: [], harness: [], decision: [],
    },
    trend: [{ bucket: '2026-08-07', grain: 'call',
              measured: ACC({ calls: 3, saved: 1.25, spent: 0.75 }),
              estimated: ACC({}), events: { measured: 3, estimated: 0 },
              unpriced_calls: 0 }],
    meta: {
      period: 'custom range',
      period_bounds_label: '2026-08-01 00:00 → 2026-08-07 00:00 (UTC, UTC+00:00)',
      timezone: 'UTC', week_anchor: 'ISO-8601 (weeks begin Monday 00:00 local)',
      generated_at: '2026-08-07T12:00:00Z', generated_at_local: '2026-08-07T12:00:00+00:00',
      generated_by: 'cheaper gateway build deadbeefcafe',
      rows_exported: 6, rows_matching: 6, truncated: false,
      method: 'Each row is priced TWICE, at that row’s OWN date and OWN billing SKU.',
      measurement_basis: 'measured — observed by the Cheaper gateway. estimated — reconstructed from transcripts.',
      period_basis: '`ts` — WHEN THE CALL HAPPENED.',
      classifier: 'contentTier (frozen per row as `ctier`/`cver`)',
      coverage_label: 'observed 2026-08-01T00:00:00Z → 2026-08-07T00:00:00Z',
      price_provenance: { as_of: '2026-06-01', age_days: 67, digest: 'sha256:cafe',
                          note: 'List rates only.' },
      not_an_invoice: 'Figures are list-price METERED VALUE.',
      integrity: { row_digest: 'sha256:abc123', row_digest_method: 'sha256 over canonical JSON',
                   tombstones: 'none in this window', tombstone_detail: [],
                   guard_mode: 'raw', guard_note: 'raw — cells are byte-exact.' },
      filters: { from: null, to: null, tz: 'UTC', basis: null, grain: null,
                 from_inclusive: true, to_exclusive: true },
      reproduce: 'cheaper export --format html --tz UTC --basis all --guard raw',
    },
  },
};

// The LEGACY /report payload: Metrics.summary() and nothing else. No `report` key.
const LEGACY_PAYLOAD = {
  code_sha: 'deadbeefcafe0000',
  dollars: { saved: 1.15, spent: 2.25, savings_pct: 33.8, extra: 0.4 },
  counts: { intercepted: 8, models_changed: 5, models_upcharged: 2 },
  periods: {
    today: { saved: 1.15, spent: 2.25, calls: 8 },
    week: { saved: 1.15, spent: 2.25, calls: 8 },
    month: { saved: 1.15, spent: 2.25, calls: 8 },
    quarter: { saved: 1.15, spent: 2.25, calls: 8 },
    year: { saved: 1.15, spent: 2.25, calls: 8 },
    all: { saved: 1.15, spent: 2.25, calls: 8 },
  },
  by_tool: [{ tool: 'claude-code', calls: 8, saved: 1.15, spent: 2.25, downgrade_rate: 62 }],
  by_tier: { haiku: { count: 5, in_tokens: 1000, out_tokens: 200 } },
  downgraded_by_model: { 'claude-haiku-4-5': 5 },
  upcharged_by_model: { 'claude-opus-4-6': 2 },
  catalog: { as_of: '2026-06-01', age_days: 67 },
  coverage: { first: 1754000000, last: 1754500000 },
  baseline_model: 'claude-sonnet-5',
};

// A ladder shaped like the payload a gateway-only install actually produces: `cheaper
// import` is opt-in, so there are NO transcript rows and store.py::_mk_acc() hands the
// estimated side a ZERO-FILLED accumulator on every window — it never returns None. This
// is the COMMON case, and it is the one that used to print a green "$0.00" hero card and
// an "exactly baseline" $0.00 ladder total under six labelled em dashes.
const SINGLE_BASIS_PAYLOAD = {
  code_sha: 'deadbeefcafe0000',
  by_tool: [], by_tier: {}, downgraded_by_model: {}, upcharged_by_model: {}, periods: {},
  catalog: { as_of: '2026-06-01', age_days: 3 },
  report: {
    grain: 'call',
    periods: [
      { key: 'today', label: 'Today',
        bounds_label: '2026-08-07 00:00 → 2026-08-08 00:00 (UTC, UTC+00:00)',
        status: 'ok', grain: 'call', dollars_suppressed: false,
        measured: ACC({ calls: 3, tokens: 900, saved: 1.25, spent: 0.75, baseline: 2.0 }),
        estimated: ACC({}), events: { measured: 3, estimated: 0 },
        unpriced_calls: 0, unpriced: {}, labels: [], notes: [] },
      // A COVERED BUT QUIET window: reporting.report_window() returns status "ok" with a
      // zeroed accumulator for a covered window that simply had no traffic.
      { key: 'before', label: 'Before this year',
        bounds_label: '— → 2026-01-01 00:00 (UTC, UTC+00:00)',
        status: 'ok', grain: 'call', dollars_suppressed: false,
        measured: ACC({}), estimated: ACC({}), events: { measured: 0, estimated: 0 },
        unpriced_calls: 0, unpriced: {}, labels: [], notes: [] },
    ],
    breakdown: { served: [], base: [], tier: [], harness: [], decision: [] },
    trend: [],
    meta: {
      period: 'week',
      // parse_filters never converts a NAMED period into bounds, so this is the
      // unbounded form — nothing may be asserted about its inclusivity.
      period_bounds_label: '— → — (UTC, UTC+00:00)',
      timezone: 'UTC', rows_exported: 3, rows_matching: 3, truncated: false,
      price_provenance: { as_of: '2026-06-01', age_days: 3 },
      integrity: {}, filters: {},
    },
  },
};

// The mirror image: a transcript-only install, where the MEASURED side is the zero-filled
// one. Both halves of "single basis" are real deployments, and only this half exercises a
// colour ternary on the measured card — the one that fell through to green on null.
const TRANSCRIPT_ONLY_PAYLOAD = (() => {
  const p = JSON.parse(JSON.stringify(SINGLE_BASIS_PAYLOAD));
  p.report.periods.forEach((w) => {
    const acc = w.measured; w.measured = w.estimated; w.estimated = acc;
    const ev = w.events.measured; w.events.measured = w.events.estimated;
    w.events.estimated = ev;
  });
  return p;
})();

// A ladder whose MEASURED total is negative. `Math.max(0, sv)` in the accumulator cannot
// survive this fixture: a floored total renders $0.10 where the truth is -$0.40.
const NEGATIVE_PAYLOAD = {
  code_sha: 'deadbeefcafe0000',
  by_tool: [], by_tier: {}, downgraded_by_model: {}, upcharged_by_model: {}, periods: {},
  catalog: { as_of: '2026-06-01', age_days: 3 },
  report: {
    grain: 'call',
    periods: [
      { key: 'today', label: 'Today',
        bounds_label: '2026-08-07 00:00 → 2026-08-08 00:00 (UTC, UTC+00:00)',
        status: 'ok', grain: 'call', dollars_suppressed: false,
        measured: ACC({ calls: 1, saved: 0.10, spent: 0.50 }),
        estimated: ACC({}), events: { measured: 1, estimated: 0 },
        unpriced_calls: 0, unpriced: {}, labels: [], notes: [] },
      { key: 'quarter_earlier', label: 'Earlier this quarter',
        bounds_label: '2026-07-01 00:00 → 2026-08-01 00:00 (UTC, UTC+00:00)',
        status: 'ok', grain: 'call', dollars_suppressed: false,
        measured: ACC({ calls: 2, saved: -0.50, spent: 1.50 }),
        estimated: ACC({}), events: { measured: 2, estimated: 0 },
        unpriced_calls: 0, unpriced: {}, labels: [], notes: [] },
    ],
    breakdown: { served: [], base: [], tier: [], harness: [], decision: [] },
    trend: [],
    meta: { period: 'custom range', period_bounds_label: '— → — (UTC, UTC+00:00)',
            timezone: 'UTC', rows_exported: 3, rows_matching: 3, truncated: false,
            price_provenance: { as_of: '2026-06-01', age_days: 3 },
            integrity: {}, filters: {} },
  },
};

// A not_covered window in the VERBATIM shape reporting.report_window() emits for one:
// measured and estimated are BOTH null and there is NO `events` key and NO `unpriced_calls`
// key at all. Every fixture above hand-writes `events: {}` / `unpriced_calls: 0`, which is
// kinder than the real payload and hid the defect — a zero-initialised event counter and a
// zero-initialised unpriced counter each printed a confident "0".
const NOT_COVERED = (key, label, bounds) => ({
  key, label, bounds_label: bounds, status: 'not_covered',
  from: 0, to: 1, measured: null, estimated: null,
  coverage: { kind: 'not_covered' }, tombstones: 0, dollars_suppressed: false,
  labels: ['not_covered'],
  notes: ['Cheaper was not watching during this period. That is not the same as saving $0.'],
  catalog: { as_of: '2026-06-01', digest: 'sha256:cafe', age_days: 3 },
});

const BARE_META = {
  period: 'custom range', period_bounds_label: '— → — (UTC, UTC+00:00)',
  timezone: 'UTC', rows_exported: 0, rows_matching: 0, truncated: false,
  price_provenance: { as_of: '2026-06-01', age_days: 3 },
  integrity: {}, filters: {},
};

const withReport = (rep) => ({
  code_sha: 'deadbeefcafe0000',
  by_tool: [], by_tier: {}, downgraded_by_model: {}, upcharged_by_model: {}, periods: {},
  catalog: { as_of: '2026-06-01', age_days: 3 },
  report: Object.assign({ grain: 'call',
    breakdown: { served: [], base: [], tier: [], harness: [], decision: [] },
    trend: [], meta: BARE_META }, rep),
});

// A gateway that was never running over the requested history: SIX windows, every one
// not_covered. Every dollar cell and every dollar total correctly declines to claim a
// figure — and the event columns used to print "0" anyway.
const ALL_NOT_COVERED_PAYLOAD = withReport({
  periods: [
    NOT_COVERED('today', 'Today', '2026-08-07 00:00 → 2026-08-08 00:00 (UTC, UTC+00:00)'),
    NOT_COVERED('week_earlier', 'Earlier this week', '2026-08-03 00:00 → 2026-08-07 00:00 (UTC, UTC+00:00)'),
    NOT_COVERED('month_earlier', 'Earlier this month', '2026-08-01 00:00 → 2026-08-03 00:00 (UTC, UTC+00:00)'),
    NOT_COVERED('quarter_earlier', 'Earlier this quarter', '2026-07-01 00:00 → 2026-08-01 00:00 (UTC, UTC+00:00)'),
    NOT_COVERED('year_earlier', 'Earlier this year', '2026-01-01 00:00 → 2026-07-01 00:00 (UTC, UTC+00:00)'),
    NOT_COVERED('before', 'Before this year', '— → 2026-01-01 00:00 (UTC, UTC+00:00)'),
  ],
});

// The too_new store: status "suppressed", both bases null, no `events` key. Same shape
// hazard as not_covered, reached through a different branch of report_window().
const TOO_NEW_PAYLOAD = withReport({
  periods: [
    { key: 'today', label: 'Today',
      bounds_label: '2026-08-07 00:00 → 2026-08-08 00:00 (UTC, UTC+00:00)',
      status: 'suppressed', from: 0, to: 1, measured: null, estimated: null,
      labels: ['store_newer_than_reader'],
      notes: ['This savings store was written by a newer Cheaper.'],
      coverage: { kind: 'covered' }, tombstones: 0,
      catalog: { as_of: '2026-06-01', digest: 'sha256:cafe', age_days: 3 } },
  ],
});

// ONE real window plus ONE not_covered window. The excluded window's Events cell reads
// "not covered" and contributes NOTHING to the event column — which is precisely what the
// old footer sentence "Every excluded window still contributes its exact event count to
// the measured event column" denied, in the same sentence that counted the exclusion.
const MIXED_EXCLUSION_PAYLOAD = withReport({
  periods: [
    { key: 'today', label: 'Today',
      bounds_label: '2026-08-07 00:00 → 2026-08-08 00:00 (UTC, UTC+00:00)',
      status: 'ok', grain: 'call', dollars_suppressed: false,
      measured: ACC({ calls: 3, tokens: 900, saved: 1.25, spent: 0.75, baseline: 2.0 }),
      estimated: ACC({}), events: { measured: 3, estimated: 0 },
      unpriced_calls: 0, unpriced: {}, labels: [], notes: [] },
    NOT_COVERED('before', 'Before this year', '— → 2026-01-01 00:00 (UTC, UTC+00:00)'),
  ],
});

// A window that IS excluded from the dollars but whose event count is exact and IS in the
// column — the ONLY case the old blanket sentence was true about. Both kinds of exclusion
// in one ladder, so the footer has to tell them apart rather than describe them as one.
const BOTH_EXCLUSION_KINDS_PAYLOAD = withReport({
  periods: [
    { key: 'today', label: 'Today',
      bounds_label: '2026-08-07 00:00 → 2026-08-08 00:00 (UTC, UTC+00:00)',
      status: 'suppressed', grain: 'call', dollars_suppressed: true,
      measured: ACC({ calls: 4, tokens: 50, saved: null, spent: null, baseline: null,
                      gross: null, extra: null }),
      estimated: ACC({ saved: null, spent: null, baseline: null, gross: null, extra: null }),
      events: { measured: 4, estimated: 0 }, unpriced_calls: 4,
      unpriced: { no_catalog_entry: 4 }, labels: ['dollars_suppressed'],
      notes: ['4 of 4 call(s) in this window (100% of its tokens) are not in the price catalog.'] },
    NOT_COVERED('before', 'Before this year', '— → 2026-01-01 00:00 (UTC, UTC+00:00)'),
  ],
});

// A non-window filter. app.py calls filtered_rows(..., apply_window=False), which drops
// ONLY the in_window time check — `_match()` on the next line still applies this one, so
// it narrows the ladder AND the hero figures.
const FILTERED_PAYLOAD = (() => {
  const p = JSON.parse(JSON.stringify(SINGLE_BASIS_PAYLOAD));
  p.report.meta.filters = { from: null, to: null, tz: 'UTC',
                            served: 'claude-haiku-4-5', basis: null };
  return p;
})();

// A payload whose Composition and Trend cover FEWER events than the ladder — exactly what
// a handler that passes f["from"]/f["to"] to report_breakdown / report_trend produces while
// the ladder is built with apply_window=False.
const NARROWED_SECTIONS_PAYLOAD = withReport({
  periods: [
    { key: 'today', label: 'Today',
      bounds_label: '2026-08-07 00:00 → 2026-08-08 00:00 (UTC, UTC+00:00)',
      status: 'ok', grain: 'call', dollars_suppressed: false,
      measured: ACC({ calls: 1, saved: 0.25, spent: 0.25 }),
      estimated: ACC({}), events: { measured: 1, estimated: 0 },
      unpriced_calls: 0, unpriced: {}, labels: [], notes: [] },
    { key: 'quarter_earlier', label: 'Earlier this quarter',
      bounds_label: '2026-07-01 00:00 → 2026-08-01 00:00 (UTC, UTC+00:00)',
      status: 'ok', grain: 'call', dollars_suppressed: false,
      measured: ACC({ calls: 4, saved: 2.00, spent: 1.00 }),
      estimated: ACC({}), events: { measured: 4, estimated: 0 },
      unpriced_calls: 0, unpriced: {}, labels: [], notes: [] },
  ],
  // The window kept only the `today` row: 1 of the ladder's 5 measured events.
  breakdown: {
    served: [{ key: 'claude-haiku-4-5', grain: 'call',
               measured: ACC({ calls: 1, saved: 0.25, spent: 0.25 }),
               estimated: ACC({}), events: { measured: 1, estimated: 0 },
               unpriced_calls: 0, unpriced: {} }],
    base: [], tier: [], harness: [], decision: [],
  },
  trend: [{ bucket: '2026-08-07', grain: 'call',
            measured: ACC({ calls: 1, saved: 0.25, spent: 0.25 }),
            estimated: ACC({}), events: { measured: 1, estimated: 0 },
            unpriced_calls: 0 }],
});

// The same ladder with sections that cover it EXACTLY — what the fixed app.py produces.
// Without this fixture the "must not cry divergence" half of the test is vacuous: the
// other payloads have an empty breakdown, so the comparison returns before it reaches the
// equality boundary and a detector that fires on `got.n <= lad.n` passes unnoticed.
const ALIGNED_SECTIONS_PAYLOAD = (() => {
  const p = JSON.parse(JSON.stringify(NARROWED_SECTIONS_PAYLOAD));
  p.report.breakdown.served = [
    { key: 'claude-haiku-4-5', grain: 'call',
      measured: ACC({ calls: 5, saved: 2.25, spent: 1.25 }),
      estimated: ACC({}), events: { measured: 5, estimated: 0 },
      unpriced_calls: 0, unpriced: {} }];
  p.report.trend = [
    { bucket: '2026-07-28', grain: 'call',
      measured: ACC({ calls: 4, saved: 2.00, spent: 1.00 }),
      estimated: ACC({}), events: { measured: 4, estimated: 0 }, unpriced_calls: 0 },
    { bucket: '2026-08-07', grain: 'call',
      measured: ACC({ calls: 1, saved: 0.25, spent: 0.25 }),
      estimated: ACC({}), events: { measured: 1, estimated: 0 }, unpriced_calls: 0 }];
  return p;
})();

test('report.html: the __REPORT_DATA__ placeholder survives, exactly once, in a JSON block', () => {
  const html = readReport();
  // app.py string-replaces this token. Renaming it, duplicating it, or moving it out of
  // the application/json block serves a page whose data never arrives — and printToPDF
  // would happily capture the empty tables.
  //
  // This is a REGRESSION PIN, not a new-behaviour check: the pre-redesign template already
  // contained this exact script block, so this test passes against it. Of the eleven
  // report.html tests written for the redesign, ten fail against the old file and this one
  // does not.
  assert.strictEqual((html.match(/__REPORT_DATA__/g) || []).length, 1);
  assert.match(html,
    /<script id="report-data" type="application\/json">__REPORT_DATA__<\/script>/);
});

test('report.html: money() labels a missing figure instead of coercing it to $0.00', () => {
  const html = readReport();
  const code = stripComments(html);
  // The old template called `num(n, 0)` inside money(), so an unpriceable model, a
  // suppressed window and a window nobody was watching all printed a confident "$0.00".
  assert.ok(!/\$0\.00/.test(code),
    'a literal $0.00 in the template is a measured claim nobody is entitled to make');
  assert.ok(!/num\(n, 0\)/.test(code), 'money() must not coerce a missing value to zero');
  assert.ok(!/money\(v \|\| 0\)/.test(code),
    '`money(v || 0)` would turn "no figure claimed" into a measured $0.00');
  assert.match(html, /function money\(v, why\)\{[\s\S]{0,240}?return noClaim\(why\)/);
  assert.match(html, /function noClaim\(why\)\{[\s\S]{0,200}?nodata[\s\S]{0,120}?&mdash;/);
});

test('report.html: basis and grain are shown explicitly and marked non-hideable', () => {
  const html = readReport();
  // These are what keep a per-call measured figure from being read in the same column as
  // a per-chat estimated one. A "simplify the table" change that drops them re-introduces
  // the concealment bug, so their presence is pinned.
  assert.match(html, /<th[^>]*class="locked"[^>]*>Basis<\/th>/);
  assert.match(html, /<th[^>]*class="locked"[^>]*>Grain<\/th>/);
  for (const h of ['Saved (measured)', 'Saved (estimated)',
                   'Spent (measured)', 'Spent (estimated)',
                   'Events (measured)', 'Events (estimated)']) {
    assert.ok(html.includes(h), `the ladder lost its "${h}" column`);
  }
});

test('report.html: measured and estimated are never added into one expression', () => {
  const js = stripComments(scriptBlocks(readReport()).join('\n'));
  // Both bases must be READ…
  assert.match(js, /\bmeasured\b/);
  assert.match(js, /\bestimated\b/);
  // …and never summed. `num(a.measured,0) + num(a.estimated,0)` is the exact shape that
  // turns two separate claims into one number nobody can substantiate.
  assert.ok(!/\.measured\b[^;\n]{0,120}\+[^;\n]{0,120}\.estimated\b/.test(js),
    'a measured figure was added to an estimated one');
  assert.ok(!/\.estimated\b[^;\n]{0,120}\+[^;\n]{0,120}\.measured\b/.test(js),
    'an estimated figure was added to a measured one');
});

test('report.html: a print stylesheet exists and prints every section', () => {
  const html = readReport();
  assert.match(html, /@media print/);
  assert.match(html, /@page\{/);
  // Browser print-to-PDF is the supported PDF path, so a section that silently vanished
  // from the printed copy would be worse than no print support at all.
  assert.match(html, /section\.sec:not\(\[hidden\]\)\{display:block !important/);
  // Headers must repeat on page 2, and a row must not be cut in half.
  assert.match(html, /thead\{display:table-header-group;\}/);
  assert.match(html, /break-inside:avoid/);
  // A horizontal scroller cannot be scrolled on paper.
  assert.match(html, /\.scroller\{overflow:visible !important/);
});

test('report.html: accessible, self-contained, and free of inline event handlers', () => {
  const html = readReport();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<caption>/);
  assert.match(html, /aria-label=/);
  // An `onclick=` attribute is dead under any CSP without 'unsafe-inline'.
  assert.ok(!/\son(click|load|error|submit|change|input|focus|blur)\s*=/i.test(html),
    'inline event handlers break under a strict CSP');
  // Self-contained: no external asset can be fetched, and no data may be fetched at all —
  // printToPDF captures whatever is rendered at the instant it fires.
  assert.ok(!/<link[^>]+href="https?:/i.test(html));
  assert.ok(!/<script[^>]+src=/i.test(html));
  assert.ok(!/\bfetch\s*\(/.test(html), 'the report must never fetch its data');
  // Light AND dark, with an explicit choice still able to win.
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /:root\[data-theme="light"\]\{/);
  assert.match(html, /:root\[data-theme="dark"\]\{/);
});

test('report.html: renders the DISJOINT ladder when D.report is present', () => {
  const { out, els } = renderReport(REPORT_PAYLOAD);
  // The nested "since" ladder could be added to six times today. The disjoint ladder
  // partitions history, so these six keys are the contract.
  for (const key of ['today', 'week_earlier', 'month_earlier',
                     'quarter_earlier', 'year_earlier', 'before']) {
    assert.ok(out.includes(`data-key="${key}"`), `disjoint ladder row "${key}" is missing`);
  }
  // …and the nested ladder is NOT the thing on screen. Showing both would let a reader
  // compare them and conclude one of them is lying.
  assert.strictEqual(els.secLadder.hidden, false);
  assert.strictEqual(els.secLegacyPeriods.hidden, true);
  assert.strictEqual(els.legacyBanner.hidden, true);
  // The redesigned sections the legacy view cannot offer.
  assert.strictEqual(els.secBreakdown.hidden, false);
  assert.strictEqual(els.secTrend.hidden, false);
  // Every row prints its literal local bounds: "This month" alone is not checkable.
  assert.ok(out.includes('2026-08-07 00:00 → 2026-08-08 00:00 (UTC, UTC+00:00)'));
  // Breakdown and trend sections are populated.
  assert.ok(out.includes('Not priced'));
  assert.ok(out.includes('2026-08-07'));
  // Per-window labels travel with their own row.
  assert.ok(out.includes('dollars suppressed') && out.includes('partial coverage'));

  // "Counted and visible" is a claim about a VALUE and about an ELEMENT, not about a
  // header string or a tooltip.
  //
  // `Not priced` is the th TEXT — asserting it appears passes while every Not-priced CELL
  // reads 0 and unpriced_calls is 1. So read the cell. The breakdown's one `served` group
  // carries unpriced_calls: 1; the Not-priced column is index 7 of its nine columns.
  const served = cellsOf(/<tr>([\s\S]*?)<\/tr>/.exec(
    els.breakdown.innerHTML.split('<tbody>')[1] || '')[1]);
  assert.strictEqual(served.length, 9, 'the breakdown table lost or gained a column');
  assert.strictEqual(text(served[7]), '1',
    'the Not-priced cell must print the exclusion COUNT, not a constant');

  // Likewise the per-row note. The phrase "are not in the price catalog" is ALSO carried
  // by the title tooltip on the withheld cell, so asserting the sentence appears somewhere
  // passes with every tr.rownote deleted — which pools the notes out of existence and
  // leaves a reader unable to tell which of six windows a note describes.
  const rownotes = els.ladderBody.innerHTML.match(
    /<tr class="rownote"><td colspan="\d+">[\s\S]*?<\/td><\/tr>/g) || [];
  assert.ok(rownotes.length >= 1, 'the ladder rendered no tr.rownote element at all');
  assert.ok(rownotes.some((r) => r.includes('are not in the price catalog')),
    'the unpriceable-window note is not carried by any tr.rownote element');
});

test('report.html: an absent, uncovered or withheld cell is a label, never $0.00', () => {
  const { out } = renderReport(REPORT_PAYLOAD);
  assert.ok(!out.includes('$0.00'),
    '"$0.00" is a measured result; "no figure is claimed" is not, and they must not look alike');
  // not_covered is its own claim, distinct from both a number and a blank.
  assert.ok(out.includes('not covered'));
  // Dollars withheld because >20% of the window is unpriceable — counts still exact.
  assert.ok(out.includes('withheld'));
  // An absent basis renders a labelled em dash carrying its own explanation.
  assert.ok(out.includes('&mdash;'));
  assert.match(out, /class="nodata" title="[^"]+"/);
  // The SIGN survives: a costlier route subtracts and is never floored at zero.
  // ASCII hyphen-minus, matching money()'s fixed convention (see dollarsIn() above).
  assert.ok(out.includes('-$0.40'), 'the costlier-route delta lost its sign');
  // Every exclusion is counted and visible.
  assert.match(out, /window\(s\) contributed dollars/);
});

test('report.html: provenance comes from D.report.meta, with the stale-catalog warning', () => {
  const { out } = renderReport(REPORT_PAYLOAD);
  assert.ok(out.includes('sha256:abc123'), 'the integrity row digest is missing');
  assert.ok(out.includes('cheaper export --format html'), 'the reproduce command is missing');
  assert.ok(out.includes('observed 2026-08-01T00:00:00Z'), 'the coverage label is missing');
  assert.ok(out.includes('Figures are list-price METERED VALUE.'));
  assert.match(out, /over 45 days old/);
  // …and it must NOT fall back to the hardcoded "everything here was measured" prose,
  // which is false for every transcript-derived row.
  assert.ok(!out.includes('Every row was observed by the Cheaper gateway'));
});

test('report.html: every payload string is escaped on output', () => {
  const { out } = renderReport(REPORT_PAYLOAD);
  // Model ids, harness names, routing reasons and session ids are user-influenced.
  assert.ok(!/<img /.test(out), 'a payload string reached the DOM unescaped');
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('report.html: the legacy /report payload still renders, and says it is the legacy view', () => {
  const { out, els } = renderReport(LEGACY_PAYLOAD);
  // Degrade gracefully: no crash, no empty page, and it SAYS it is the legacy view.
  assert.ok(out.includes('Legacy view.'), 'the legacy banner is missing');
  assert.ok(out.includes('no basis split'));
  assert.strictEqual(els.legacyBanner.hidden, false);
  // The nested ladder is shown — under its caveat — and the disjoint one is not faked.
  assert.strictEqual(els.secLegacyPeriods.hidden, false);
  assert.strictEqual(els.secLadder.hidden, true);
  assert.strictEqual(els.secBreakdown.hidden, true);
  assert.strictEqual(els.secTrend.hidden, true);
  // The nested-ladder caveat is static markup inside that section.
  assert.match(readReport(), /windows nest[\s\S]{0,120}not disjoint/);
  assert.ok(out.includes('This week') && out.includes('All-time'));
  assert.ok(out.includes('claude-haiku-4-5'), 'the routing-outcomes table is empty');
  // The hardcoded fallback prose must NOT claim everything was measured.
  assert.ok(!/Basis:\s*Measured/i.test(out));
  assert.ok(out.includes('Mixed, and not separated on this view'));

  // A real blended figure IS coloured; the basis caveat, not the palette, is what marks
  // it as blended.
  assert.strictEqual(kpiMap(els)['Saved (blended basis)'].cls, 'green');

  assert.strictEqual(kpiMap(els)['Costlier routes'].cls, 'red',
    '$0.40 of costlier routing is a real loss and must read as one');

  // …but a MISSING one is not. `(Number(dol.saved) < 0) ? 'red' : 'green'` painted an
  // absent figure green, because Number(undefined) < 0 is false. And a MEASURED ZERO is
  // baseline, not a loss: colour is a three-state function of the value, and the middle
  // state is neutral.
  const bare = renderReport(Object.assign({}, LEGACY_PAYLOAD,
    { dollars: { extra: 0 } }));
  const bk = kpiMap(bare.els);
  assert.strictEqual(bk['Saved (blended basis)'].value, '&mdash;');
  assert.strictEqual(bk['Saved (blended basis)'].cls, '',
    'a missing blended figure was painted green behind its own em dash');
  assert.strictEqual(bk['Metered spend'].value, '&mdash;');
  // LEGACY_PAYLOAD carries no `measurement` block — an older gateway — so its basis is
  // UNKNOWN and every real figure is qualified. The zero still RENDERS (a measured zero
  // of costlier routing is a real claim and must not be suppressed into an em dash) and
  // still takes no colour (baseline is not a loss); what it may not do is present itself
  // as measured when nothing says it was. Both halves are asserted here.
  assert.strictEqual(bk['Costlier routes'].value, 'about $0.00');
  assert.strictEqual(bk['Costlier routes'].cls, '',
    'a measured zero of costlier routing was painted as a loss');
  // …and with a gateway that DOES state its basis, the same zero is unqualified. Without
  // this half, "always prefix about" would satisfy every assertion above while making the
  // qualifier meaningless.
  const measured = renderReport(Object.assign({}, LEGACY_PAYLOAD, {
    dollars: { extra: 0 },
    measurement: { dollars_basis: 'measured', measured_calls: 8, unmeasured_calls: 0,
                   priced_calls: 8, zero_token_calls: 0 },
  }));
  assert.strictEqual(kpiMap(measured.els)['Costlier routes'].value, '$0.00');
  assert.ok(!/approx/.test(measured.out), 'a measured figure was qualified as "about"');
});

test('report.html: the printed legacy view never presents unmeasured dollars as measured', () => {
  // A printed report is the artifact people quote from and attach to expense claims, so
  // an unqualified figure here travels further and lasts longer than the same figure on
  // the live page. The legacy `/report` endpoint serves Metrics.summary() verbatim — the
  // very payload whose `usage_source` was NULL on all 94 rows when this shipped.
  const CASES = [
    ['unmeasured', { dollars_basis: 'unmeasured', measured_calls: 0, unmeasured_calls: 94,
                     priced_calls: 4, zero_token_calls: 90 }, /Not measured\./],
    ['mixed', { dollars_basis: 'mixed', measured_calls: 2, unmeasured_calls: 92,
                priced_calls: 4, zero_token_calls: 90 }, /Partly measured\./],
    ['an unrecognised basis', { dollars_basis: 'probably' },
      /Mixed, and not separated on this view/],
  ];
  for (const [why, m, narrative] of CASES) {
    const { out, els } = renderReport(Object.assign({}, LEGACY_PAYLOAD, { measurement: m }));
    const k = kpiMap(els);
    assert.match(k['Saved (blended basis)'].value, /^about \$1\.15$/,
      `${why}: the headline saving reads "${k['Saved (blended basis)'].value}"`);
    assert.match(k['Metered spend'].value, /^about \$2\.25$/,
      `${why}: the spend figure is unqualified beside a qualified saving`);
    // The percentage is derived from the same two accumulators; leaving it bare would
    // launder the identical claim one line down from the qualified figure.
    assert.match(k['Saved (blended basis)'].sub, /^about 33\.8% of the baseline/,
      `${why}: the percentage sub-line reads "${k['Saved (blended basis)'].sub}"`);
    assert.match(text(out).replace(/\s+/g, ' '), narrative,
      `${why}: the provenance block does not state the basis`);
    // The COUNT column is a fact and is not qualified — how a row's usage was obtained
    // says nothing about whether the row exists.
    assert.strictEqual(k['Calls routed cheaper'].value, '5',
      `${why}: an exact row count was qualified as if it were a dollar figure`);
    // The qualifier explains itself where it stands.
    assert.match(out, /<span class="approx" title="[^"]{20,}">about <\/span>/,
      `${why}: the "about" prefix carries no explanation`);
  }

  // A gateway that measured everything prints bare figures, and says so.
  const good = renderReport(Object.assign({}, LEGACY_PAYLOAD, {
    measurement: { dollars_basis: 'measured', measured_calls: 8, unmeasured_calls: 0,
                   priced_calls: 8, zero_token_calls: 0 },
  }));
  assert.strictEqual(kpiMap(good.els)['Saved (blended basis)'].value, '$1.15');
  assert.strictEqual(kpiMap(good.els)['Saved (blended basis)'].sub, '33.8% of the baseline');
  assert.match(text(good.out).replace(/\s+/g, ' '),
    /Measured\. Every priced call behind the figures on this page carried usage the provider itself reported\. 8 of 8 priced calls/,
    'a fully measured gateway is not told so, or its counts were dropped');

  // …and a basis that priced NOTHING refuses to report a money result rather than
  // reporting a zero one.
  const none = renderReport(Object.assign({}, LEGACY_PAYLOAD, {
    dollars: {}, measurement: { dollars_basis: 'none', priced_calls: 0 },
  }));
  assert.match(text(none.out).replace(/\s+/g, ' '),
    /No dollar figure is claimed\..*not the same as saving \$0\./,
    'a report with nothing priceable did not say so');
});

// ===========================================================================
// VALUE assertions.
//
// Everything above this line is a claim about the template's SOURCE or about a substring
// of its output. Neither can catch the two defects that matter most:
//   * a blended KPI written in the template's own bracket-notation idiom, summing
//     k[SIDES[0]].saved and k[SIDES[1]].saved into one "Saved (all bases)" card — the #1
//     forbidden violation — passed the dot-notation source regex 19/19;
//   * `Math.max(0, sv)` in the total accumulator changed the rendered measured total from
//     $0.85 to $1.25 and passed 19/19, because the only sign assertion read a per-ROW
//     cell, which is a different code path from the total.
// So these read the RENDERED CELL.
// ===========================================================================

// Derived from the LADDER fixture, by hand, per basis:
//   measured saved  = 1.25 (today) + (-0.40) (quarter_earlier)            = 0.85
//   measured spent  = 0.75 (today) +   1.40  (quarter_earlier)            = 2.15
//   estimated saved = 0.30 (year_earlier)                                 = 0.30
//   estimated spent = 0.10 (year_earlier)                                 = 0.10
// month_earlier is dollars_suppressed and week_earlier is not_covered, so neither
// contributes dollars; year_earlier's measured side and `before`'s two sides are
// zero-filled accumulators with calls: 0, which contribute NOTHING to either basis.
//   measured events = 3 + 1 + 2 + 0 + 0 = 6      estimated events = 2
const EXPECT = {
  savedMeasured: '$0.85', savedEstimated: '$0.30',
  spentMeasured: '$2.15', spentEstimated: '$0.10',
  eventsMeasured: '6', eventsEstimated: '2',
};

test('report.html: the ladder total equals the per-basis sums, sign and all', () => {
  const { els } = renderReport(REPORT_PAYLOAD);
  const t = ladderTotals(els);
  assert.strictEqual(t.savedMeasured, EXPECT.savedMeasured,
    'the measured saved total is not 1.25 + (-0.40) — a floor or a stray window');
  assert.strictEqual(t.savedEstimated, EXPECT.savedEstimated);
  assert.strictEqual(t.spentMeasured, EXPECT.spentMeasured);
  assert.strictEqual(t.spentEstimated, EXPECT.spentEstimated);
  assert.strictEqual(t.eventsMeasured, EXPECT.eventsMeasured);
  assert.strictEqual(t.eventsEstimated, EXPECT.eventsEstimated);
});

test('report.html: every KPI equals its own basis total, and none is a blend', () => {
  const { els, out } = renderReport(REPORT_PAYLOAD);
  const kpi = kpiMap(els);
  assert.strictEqual(kpi['Saved (measured)'].value, EXPECT.savedMeasured);
  assert.strictEqual(kpi['Saved (estimated)'].value, EXPECT.savedEstimated);
  assert.strictEqual(kpi['Spent (measured)'].value, EXPECT.spentMeasured);
  assert.strictEqual(kpi['Spent (estimated)'].value, EXPECT.spentEstimated);
  // week_earlier is not_covered, so reporting.report_window() ships it with NO `events`
  // key and a null accumulator on BOTH bases: its event count is not knowable. The
  // subtitle states the count it does have AND how many windows could not supply one, so
  // the event denominator is never silently short.
  assert.strictEqual(kpi['Saved (measured)'].sub,
    '6 call event(s) · 1 window(s) could not report a count');
  assert.strictEqual(kpi['Saved (estimated)'].sub,
    '2 call event(s) · 1 window(s) could not report a count');
  // Exclusions are counted and visible on their own cards.
  assert.strictEqual(kpi['Not priced'].value, '1');
  assert.strictEqual(kpi['Windows withheld'].value, '2');

  // No card may state a figure the report refuses to compute. `Saved (all bases)` is the
  // exact card a reviewer inserted; a headline naming both bases is the violation itself.
  Object.keys(kpi).forEach((label) => {
    assert.ok(!/all bases|combined|total \(all/i.test(label),
      `KPI "${label}" claims a cross-basis figure`);
  });

  // THE CROSS-BASIS ARITHMETIC CHECK, on values rather than on source text: no dollar
  // figure ANYWHERE on the page may equal measured + estimated for this fixture.
  const fused = [
    (0.85 + 0.30).toFixed(2),   // saved:  1.15
    (2.15 + 0.10).toFixed(2),   // spent:  2.25
  ].map((n) => `$${n}`);
  const rendered = dollarsIn(out);
  fused.forEach((f) => {
    assert.ok(!rendered.includes(f),
      `${f} is measured + estimated fused into one figure — the #1 forbidden violation`);
  });
  // …and the two per-basis figures that were fused are both still on the page, so the
  // check above cannot pass by rendering nothing at all.
  assert.ok(rendered.includes('$0.85') && rendered.includes('$0.30'));
});

test('report.html: an empty accumulator is never promoted to a measured $0.00', () => {
  // store.py::_mk_acc() ALWAYS returns {calls:0, saved:0.0, spent:0.0, …} for a basis with
  // no rows — it never returns None — and report_window() ships it on every window. A
  // `!acc` guard lets that truthy object set dollars=true, so the estimated ladder total
  // printed "$0.00 · exactly baseline" and the hero card printed a GREEN "$0.00 / 0 call
  // event(s)" beneath cells that had each declined to claim a figure. This is the DEFAULT
  // rendering for a gateway-only install.
  const { els, out } = renderReport(SINGLE_BASIS_PAYLOAD);
  const t = ladderTotals(els);
  assert.strictEqual(t.savedMeasured, '$1.25');
  assert.strictEqual(t.spentMeasured, '$0.75');

  // The estimated column contributed nothing, so its TOTAL is a labelled non-number.
  assert.match(t.raw.savedEstimated, /class="nodata"/,
    'the estimated ladder total claimed a figure from a zero-filled accumulator');
  assert.match(t.raw.spentEstimated, /class="nodata"/);
  assert.strictEqual(t.savedEstimated, '&mdash;');
  assert.strictEqual(t.spentEstimated, '&mdash;');

  const kpi = kpiMap(els);
  assert.strictEqual(kpi['Saved (estimated)'].value, '&mdash;');
  assert.strictEqual(kpi['Spent (estimated)'].value, '&mdash;');
  // …and a labelled non-number is never painted in the success colour.
  assert.strictEqual(kpi['Saved (estimated)'].cls, '',
    'an em dash was rendered inside a green KPI card');
  assert.strictEqual(kpi['Spent (estimated)'].cls, '');
  assert.strictEqual(kpi['Saved (measured)'].cls, 'green');

  assert.ok(!out.includes('$0.00'),
    'a zero-filled accumulator produced an affirmative $0.00 dollar claim');
  assert.ok(!out.includes('Exactly baseline'),
    '"Exactly baseline" is a measured claim; an absent basis has not made it');

  // The MIRROR case — transcript-only. This is the half that exercises the measured
  // card's colour, where `(v !== null && v < 0) ? 'red' : 'green'` painted the honest
  // em dash in the success colour.
  const mirror = renderReport(TRANSCRIPT_ONLY_PAYLOAD);
  const mt = ladderTotals(mirror.els);
  assert.match(mt.raw.savedMeasured, /class="nodata"/,
    'the measured ladder total claimed a figure from a zero-filled accumulator');
  assert.strictEqual(mt.savedEstimated, '$1.25');
  const mk = kpiMap(mirror.els);
  assert.strictEqual(mk['Saved (measured)'].value, '&mdash;');
  assert.strictEqual(mk['Saved (measured)'].cls, '',
    'the measured KPI painted a labelled non-number green');
  assert.strictEqual(mk['Spent (measured)'].cls, '');
  // A reconstructed figure is never dressed in the measured success colour either.
  assert.strictEqual(mk['Saved (estimated)'].cls, '');
  assert.ok(!mirror.out.includes('$0.00'));
});

test('report.html: the exclusion counter is stated PER BASIS, not per window status', () => {
  // A single global counted/excluded pair is derived from `status` alone, so a window that
  // contributed nothing to a basis still counted as a contributor to it: the caption under
  // an all-em-dash measured column read "1 of 1 window(s) contributed dollars; 0 withheld
  // or not covered", and the footer read "No window was excluded from the dollar total".
  const { els } = renderReport(SINGLE_BASIS_PAYLOAD);
  const foot = els.ladderFoot.innerHTML;
  assert.match(foot, /<b>measured:<\/b>\s*1 of 2 window\(s\) contributed dollars; 1 /);
  assert.match(foot, /<b>estimated:<\/b>\s*0 of 2 window\(s\) contributed dollars; 2 /);
  assert.ok(!/No window was excluded from the dollar total/.test(foot),
    'the footer denied an exclusion that the estimated column made on every window');

  // On the six-window fixture: measured contributes today + quarter_earlier; estimated
  // contributes year_earlier alone.
  const big = renderReport(REPORT_PAYLOAD).els.ladderFoot.innerHTML;
  assert.match(big, /<b>measured:<\/b>\s*2 of 6 window\(s\) contributed dollars; 4 /);
  assert.match(big, /<b>estimated:<\/b>\s*1 of 6 window\(s\) contributed dollars; 5 /);
});

test('report.html: a NEGATIVE ladder total is rendered negative, never floored', () => {
  // `Math.max(0, sv)` in the accumulator renders $0.10 here instead of -$0.40, and
  // `if (sv > 0)` as a guard around the accumulation renders $0.10 too.
  const { els } = renderReport(NEGATIVE_PAYLOAD);
  const t = ladderTotals(els);
  // ASCII hyphen-minus ("-"), matching money()'s fixed convention (see dollarsIn() and
  // the comment on money() in report.html itself) — not the Unicode minus (U+2212) it
  // used to emit, which parsed as text rather than a number on a spreadsheet paste.
  assert.strictEqual(t.savedMeasured, '-$0.40',
    'the measured total lost its sign — 0.10 + (-0.50) is -0.40, never 0.10 and never 0');
  assert.match(t.raw.savedMeasured, /class="neg"/);
  assert.strictEqual(t.spentMeasured, '$2.00');

  const kpi = kpiMap(els);
  assert.strictEqual(kpi['Saved (measured)'].value, '-$0.40');
  assert.strictEqual(kpi['Saved (measured)'].cls, 'red',
    'a net loss was not painted as a loss');
});

test('report.html: the masthead never captions whole-history figures with a period', () => {
  // app.py builds the ladder with apply_window=False on purpose. Naming `?period=today`
  // in the masthead put a one-day heading over a whole-history hero card that read 5× the
  // stated day. The requested period belongs in provenance, labelled as a request.
  const { els, out } = renderReport(REPORT_PAYLOAD);
  const scope = els.scope.textContent;
  assert.match(scope, /All recorded history/);
  assert.ok(!/^custom range ·/.test(scope),
    'the masthead is captioning the figures with the requested period again');
  // The OBSERVED extent — META.coverage_label, the only extent on the payload derived from
  // recorded data. NOT the ladder bucket span: periods.disjoint_ladder always ends with a
  // left-unbounded "before" bucket and always begins with "today", whose upper bound is
  // TOMORROW 00:00, so the bucket span states a FUTURE high bound and an em dash low one.
  assert.ok(scope.includes('observed 2026-08-01T00:00:00Z → 2026-08-07T00:00:00Z'),
    'the masthead does not state the observed coverage extent');
  assert.ok(!scope.includes('2026-08-08 00:00 (UTC, UTC+00:00)'),
    'the masthead is stating the ladder BUCKET edge — a future instant — as the data extent');
  // Said again directly above the KPI grid, where it is read as their caption.
  assert.match(els.scopeNote.innerHTML, /all recorded history/i);
  // The requested period survives — in provenance, and labelled as a REQUEST.
  assert.match(els.prov.innerHTML, /Requested period/);
  assert.match(out, /period that was REQUESTED/);
});

test('report.html: no inclusivity is asserted about bounds that do not exist', () => {
  // reporting.parse_filters never converts a NAMED period into bounds, so `?period=week`
  // yields "— → —". Asserting "start is INCLUSIVE, end is EXCLUSIVE" about that is a claim
  // about instants the payload does not contain.
  const unbounded = renderReport(SINGLE_BASIS_PAYLOAD).els.prov.innerHTML;
  assert.ok(!/start is INCLUSIVE/.test(unbounded),
    'the provenance block asserted inclusivity about unbounded bounds');
  assert.match(unbounded, /Unbounded on at least one side/);
  // …and it IS asserted when the bounds are real.
  const bounded = renderReport(REPORT_PAYLOAD).els.prov.innerHTML;
  assert.match(bounded, /start is INCLUSIVE, end is EXCLUSIVE/);
});

test('report.html: the three proxy tables carry an explicit all-time scope caveat', () => {
  // by_tool / by_tier / downgraded_by_model come straight off the UNFILTERED
  // Metrics.summary(). "A different row set" is not the same claim as a different time
  // SCOPE, and two of the three carried no caveat at all.
  const { els } = renderReport(REPORT_PAYLOAD);
  const CAVEAT = /all time, from the gateway proxy’s own aggregate; the period filter above does not apply to this table/;
  for (const id of ['toolNote', 'tierNote', 'outcomesNote']) {
    assert.match(els[id].textContent, CAVEAT, `${id} has no time-scope caveat`);
  }
  for (const id of ['byTool', 'byTier', 'byModel']) {
    const cap = /<caption>([\s\S]*?)<\/caption>/.exec(els[id].innerHTML);
    assert.ok(cap, `${id} rendered no caption`);
    assert.match(cap[1], CAVEAT, `the ${id} caption has no time-scope caveat`);
  }
});

test('report.html: the print token reset out-specifies every theme selector', () => {
  // A media query adds NO specificity, so a bare `:root` (0-1-0) reset loses to
  // `:root[data-theme="dark"]` (0-2-0). An explicit dark host choice would then survive
  // into the printed PDF for every token except html/body, sinking `.prov b`, the masthead
  // rule and the ladder-total separator into near-white on white and dropping every
  // `--mut` surface to ~2.3:1.
  const html = readReport();
  const i = html.indexOf('@media print');
  assert.ok(i > 0, 'the print block is gone');
  let depth = 0, start = html.indexOf('{', i), end = -1;
  for (let j = start; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}' && --depth === 0) { end = j; break; }
  }
  const printBlock = html.slice(start + 1, end);
  assert.match(printBlock,
    /:root\s*,\s*:root\[data-theme="light"\]\s*,\s*:root\[data-theme="dark"\]\s*\{[^}]*--mut:/,
    'the print reset does not name the explicit light and dark theme selectors');
});

test('report.html: a section declared hidden stays hidden unless show() clears it', () => {
  // A guard on the STUB, not on the template: hard-coding hidden:false made every
  // visibility assertion vacuous, and deleting `show('secLadder', true)` — which renders
  // the ladder into a hidden section, invisible on screen AND on paper — passed 19/19.
  const html = readReport();
  for (const id of ['secLadder', 'secLegacyPeriods', 'secBreakdown', 'secTrend',
                    'legacyBanner']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*\\shidden[\\s/>]`),
      `#${id} must be declared hidden in the markup for show() to be meaningful`);
  }
  // The stub honours that declaration before any script runs.
  const { els } = renderReport({});                       // no `report`, no `periods`
  assert.strictEqual(els.secBreakdown.hidden, true);
  assert.strictEqual(els.secTrend.hidden, true);
  assert.strictEqual(els.secLadder.hidden, true);
  // …and a section with no hidden attribute is visible from the start.
  assert.strictEqual(els.secProv.hidden, false);
});

// ===========================================================================
// The EVENT columns. The dollar columns learned the difference between a measured zero
// and an absent measurement; the event columns had not.
// ===========================================================================

test('report.html: an unknowable EVENT count is a labelled non-number, never "0"', () => {
  // Six windows, every one not_covered in the verbatim report_window() shape (no `events`
  // key, no `unpriced_calls` key, both bases null). Every dollar cell and every dollar
  // total correctly declines. The event total cells were zero-initialised counters printed
  // with NO admission gate — unlike totCell(), which gates on tot[side].dollars — so the
  // TOTAL row read "0" and "0" beneath six rows each reading "not covered", and the hero
  // subtitle read "0 call event(s)". A MEASURED zero and an ABSENT measurement are
  // different claims, and this is the headline count of the document.
  const { els, out } = renderReport(ALL_NOT_COVERED_PAYLOAD);
  const t = ladderTotals(els);
  assert.strictEqual(t.eventsMeasured, '&mdash;',
    'the measured event total printed a confident 0 for six unknowable windows');
  assert.strictEqual(t.eventsEstimated, '&mdash;');
  assert.match(t.raw ? cellsOf(ladderRow(els, 'class="total"'))[5] : '', /class="nodata"/,
    'the measured event total is not a labelled non-number');
  assert.match(cellsOf(ladderRow(els, 'class="total"'))[6], /class="nodata"/);

  // The hero subtitle is the same claim in the most prominent place on the page.
  const kpi = kpiMap(els);
  assert.ok(!/\b0 call event\(s\)/.test(kpi['Saved (measured)'].sub),
    'the hero card claimed a measured zero for an absent event count');
  assert.match(kpi['Saved (measured)'].sub, /no call event count was available/);
  assert.match(kpi['Saved (estimated)'].sub, /no call event count was available/);

  // "Not priced" is the same defect through a different door: the KPI loop returned early
  // on not_covered, so the accumulator never ran and the card printed "0" — and
  // report_window() emits no unpriced_calls key on these windows at all.
  assert.strictEqual(kpi['Not priced'].value, '&mdash;',
    'the Not-priced card claimed a measured zero for six windows that reported no count');
  assert.match(kpi['Not priced'].sub, /6 window\(s\) reported no count/);

  // The windows whose count was not knowable are COUNTED and PRINTED, so the event
  // denominator is not silently short.
  assert.match(els.ladderFoot.innerHTML,
    /The measured event total covers 0 of 6 window\(s\)/);
  assert.match(els.ladderFoot.innerHTML,
    /The estimated event total covers 0 of 6 window\(s\)/);

  // Nothing anywhere on the page claims a dollar figure either.
  assert.deepStrictEqual(dollarsIn(out), [],
    'a dollar figure was claimed for a ladder in which nothing was ever observed');

  // The too_new store reaches the same shape through report_window()'s other null branch.
  const tooNew = renderReport(TOO_NEW_PAYLOAD);
  const tn = ladderTotals(tooNew.els);
  assert.strictEqual(tn.eventsMeasured, '&mdash;');
  assert.strictEqual(tn.eventsEstimated, '&mdash;');
  assert.match(kpiMap(tooNew.els)['Saved (measured)'].sub, /no call event count/);
});

test('report.html: a KNOWN event count still totals, with the unknown windows counted', () => {
  // The fix must not blank a total merely because ONE window could not report — that would
  // trade a false zero for a false blank. The known counts are summed exactly, and the
  // windows that could not report are stated beside them.
  const { els } = renderReport(MIXED_EXCLUSION_PAYLOAD);
  const t = ladderTotals(els);
  assert.strictEqual(t.eventsMeasured, '3', 'the known measured event count was lost');
  assert.strictEqual(t.eventsEstimated, '0',
    'a covered window with a zero-filled accumulator reports a REAL measured zero');
  assert.match(els.ladderFoot.innerHTML,
    /The measured event total covers 1 of 2 window\(s\)/);
  assert.strictEqual(kpiMap(els)['Saved (measured)'].sub,
    '3 call event(s) · 1 window(s) could not report a count');
});

test('report.html: the footer splits exclusions BY REASON and denies nothing', () => {
  // The old per-basis footer appended "Every excluded window still contributes its exact
  // event count to the <side> event column." That is true ONLY of a dollars_suppressed
  // exclusion — _withhold_dollars() nulls the dollars and leaves the counts intact — and
  // FALSE of every not_covered or null-basis one, which is the common case. On the mixed
  // fixture the excluded window IS the not_covered one: its Events cell reads "not covered"
  // and contributes nothing, while the sentence told the reader the event column had no
  // exclusions at all.
  const foot = renderReport(MIXED_EXCLUSION_PAYLOAD).els.ladderFoot.innerHTML;
  assert.ok(!/Every excluded window still contributes its exact event count/.test(foot),
    'the footer asserts a blanket property over exclusions it cannot support');
  assert.match(foot,
    /<b>measured:<\/b>\s*1 of 2 window\(s\) contributed dollars; 1 withheld, not covered, or carried no measured rows — of those, 0 still contribute an exact event count to the measured event column and 1 could not report one/);

  // Both kinds of exclusion in one ladder, so the split has to discriminate rather than
  // pick a side: today is dollars_suppressed (dollars withheld, 4 events EXACT and in the
  // column) and before is not_covered (event count unknown, NOT in the column).
  const both = renderReport(BOTH_EXCLUSION_KINDS_PAYLOAD);
  const bf = both.els.ladderFoot.innerHTML;
  assert.match(bf,
    /<b>measured:<\/b>\s*0 of 2 window\(s\) contributed dollars; 2 withheld, not covered, or carried no measured rows — of those, 1 still contribute an exact event count to the measured event column and 1 could not report one/);
  // …and the event total is the suppressed window's exact 4, not 0 and not blank.
  assert.strictEqual(ladderTotals(both.els).eventsMeasured, '4',
    'a dollars_suppressed window’s EXACT event count was dropped with its dollars');
  assert.match(bf, /The measured event total covers 1 of 2 window\(s\)/);

  // On the all-not-covered ladder the old sentence was asserted twice while zero of twelve
  // basis-windows contributed any event count at all.
  const nc = renderReport(ALL_NOT_COVERED_PAYLOAD).els.ladderFoot.innerHTML;
  assert.ok(!/Every excluded window still contributes/.test(nc));
  assert.match(nc, /6 could not report one, so their events are NOT in it/);
});

// ===========================================================================
// SCOPE. What the page says it covers must be what it covers.
// ===========================================================================

test('app.py: /api/v1/report.html builds Composition and Trend WITHOUT the window', () => {
  // The BLOCKER. app.py used to call
  //     reporting.report_breakdown(rows, d, f["from"], f["to"])
  //     reporting.report_trend(rows, "day", f["from"], f["to"])
  // both of which skip rows via in_window, while the ladder and the KPIs were built from
  // filtered_rows(..., apply_window=False). Executed proof at the time: two rows, one on
  // 2026-08-07 and one on 2026-07-28, with ?period=today&from=2026-08-07&to=2026-08-08 —
  // the ladder/KPI row set stayed at 2 while breakdown groups dropped 2→1 and trend
  // buckets dropped 2→1, under a lede stating that only the row export honoured the
  // requested filter. Fixed at the SOURCE so the whole document has one scope.
  const py = fs.readFileSync(path.join(APP, 'app.py'), 'utf8');
  const i = py.indexOf('async def api_report_html');
  assert.ok(i > 0, 'the /api/v1/report.html handler is gone');
  // From `def work():` — past the docstring, which quotes the OLD windowed calls verbatim
  // as the thing that was wrong. A check that reads the prose is a check that fails on its
  // own explanation.
  const j = py.indexOf('def work():', i);
  assert.ok(j > i, 'the handler body is gone');
  const handler = py.slice(j);
  assert.match(handler, /reporting\.report_breakdown\(rows, d\)/,
    'report_breakdown is being passed a window again — Composition would be narrower than the ladder');
  assert.match(handler, /reporting\.report_trend\(rows, "day"\)/,
    'report_trend is being passed a window again — Trend would be narrower than the ladder');
  assert.ok(!/report_breakdown\([^)]*f\["from"\]/.test(handler));
  assert.ok(!/report_trend\([^)]*f\["from"\]/.test(handler));
  // The ladder itself must still be whole-history, or "fixing" the sections by narrowing
  // the ladder would pass the two checks above while making the page worse.
  assert.match(handler, /filtered_rows\(u\["rows"\], f, apply_window=False\)/);
});

test('report.html: a narrower Composition or Trend is STATED, never left to be discovered', () => {
  // Defence in depth for the handler fix above. If a payload ever arrives whose sections
  // cover fewer events than the ladder, the shortfall is counted and printed rather than
  // left as a gap a reader has to find by subtracting two tables — which is what happened
  // when Composition rendered a single group worth $0.25 beneath a ladder total of $2.25,
  // directly under a lede saying only the row export honoured the requested filter.
  const { els, out } = renderReport(NARROWED_SECTIONS_PAYLOAD);
  assert.strictEqual(ladderTotals(els).eventsMeasured, '5');
  for (const id of ['breakdown', 'trend']) {
    assert.match(els[id].innerHTML, /Scope divergence/,
      `${id} is narrower than the ladder and the page does not say so`);
    assert.match(els[id].innerHTML,
      /this section covers 1 of the ladder’s 5 event\(s\); 4 event\(s\) are in the period ladder and NOT here/,
      `${id} does not COUNT the events it dropped`);
  }
  assert.ok(out.includes('Scope divergence'));

  // …and the EQUALITY boundary, which is what the fixed handler actually produces: the
  // sections cover the ladder exactly, so the page must say nothing. Without a fixture
  // whose sections are non-empty AND equal, a detector written `got.n <= lad.n` fires on
  // every well-formed report and no test notices.
  const aligned = renderReport(ALIGNED_SECTIONS_PAYLOAD);
  assert.strictEqual(ladderTotals(aligned.els).eventsMeasured, '5');
  assert.match(aligned.els.breakdown.innerHTML, /claude-haiku-4-5/,
    'the aligned fixture rendered no breakdown group — the check would be vacuous');
  assert.match(aligned.els.trend.innerHTML, /2026-07-28/);
  assert.ok(!/Scope divergence/.test(aligned.out),
    'a section that covers everything the ladder covers must not cry divergence');
});

test('report.html: "all recorded history" is never claimed unqualified under a filter', () => {
  // apply_window=False suppresses ONLY the in_window time check; `_match()` on the next
  // line still applies basis/served/base/harness/decision/session/q/min_abs_usd to the
  // ladder AND the hero figures. scopeText was a hard-coded string with no dependence on
  // m.filters at all, so the masthead printed "so neither it nor the hero figures are
  // narrowed by a requested window", the lede printed "cover all recorded history" and the
  // Requested-period dd printed "are not narrowed by it" — beside a served= chip rendered
  // by the very same provenance block, proving they were.
  const { els } = renderReport(FILTERED_PAYLOAD);
  const scope = els.scope.textContent;
  assert.match(scope, /All recorded history, restricted to served=claude-haiku-4-5/);
  assert.ok(!/All recorded history(?!, restricted to)/.test(scope),
    'the masthead makes the UNQUALIFIED whole-history claim while a filter narrows it');
  assert.match(els.scopeNote.innerHTML, /<b>restricted to served=claude-haiku-4-5<\/b>/);
  assert.match(els.prov.innerHTML, /<b>restricted to served=claude-haiku-4-5<\/b>/);
  assert.ok(!/are not narrowed by it/.test(els.prov.innerHTML),
    'the Requested-period row keeps the categorical "not narrowed by it" clause');
  // The chip that proves it — the same block that used to contradict itself.
  assert.match(els.prov.innerHTML, /served=claude-haiku-4-5<\/span>/);

  // …and the unqualified wording is still used when the filter set really is empty apart
  // from tz, so this cannot pass by hedging unconditionally.
  const plain = renderReport(SINGLE_BASIS_PAYLOAD);
  assert.ok(!/restricted to/.test(plain.els.scope.textContent));
  assert.match(plain.els.prov.innerHTML, /are not narrowed by it/);
});

test('report.html: the masthead never states an em dash as the low side of an extent', () => {
  // ladderExtent() read lo off the LAST ladder row and hi off the FIRST.
  // periods.disjoint_ladder always ends with a left-unbounded "before" bucket and always
  // begins with "today", whose upper bound is TOMORROW 00:00 — so the masthead rendered
  // "All recorded history · — → 2026-08-08 00:00 (UTC, UTC+00:00) — the period ladder…":
  // three em dashes doing two different jobs, and an upper bound up to a full day in the
  // FUTURE, overstating the data reach on a page whose ladder footer already carried the
  // honest observed extent.
  const ARROW = '→', DASH = '—';
  for (const [name, payload] of [
    ['six-window', REPORT_PAYLOAD],
    ['all-not-covered', ALL_NOT_COVERED_PAYLOAD],
    ['single-basis', SINGLE_BASIS_PAYLOAD],
    ['negative', NEGATIVE_PAYLOAD],
  ]) {
    const scope = renderReport(payload).els.scope.textContent;
    const i = scope.indexOf(ARROW);
    if (i < 0) continue;                       // no extent stated at all — also honest
    const lo = scope.slice(0, i).trim();
    assert.ok(!lo.endsWith(DASH),
      `${name}: the masthead states an em dash as the low side of an extent`);
    assert.ok(!scope.includes('2026-08-08 00:00'),
      `${name}: the masthead states a FUTURE ladder bucket edge as the data extent`);
  }
  // A coverage_label that is prose rather than an interval list states no extent at all,
  // rather than being spliced into the sentence as if it were one. reporting.coverage_label
  // returns exactly this paragraph when no writer declared an interval.
  const prose = JSON.parse(JSON.stringify(SINGLE_BASIS_PAYLOAD));
  prose.report.meta.coverage_label =
    'No coverage interval was declared by a writer; coverage is IMPLIED by the events.';
  const ps = renderReport(prose).els.scope.textContent;
  assert.ok(!ps.includes('No coverage interval was declared'),
    'a prose coverage label was rendered as if it were an extent');
  assert.ok(ps.indexOf(ARROW) < 0, 'an extent was stated from a label that has no bounds');

  // …and an interval whose own low side is an em dash — reporting._iso(None) renders one —
  // is NOT an extent either. This is the same "— → instant" shape the ladder buckets
  // produced, arriving through the coverage label instead.
  const halfOpen = JSON.parse(JSON.stringify(SINGLE_BASIS_PAYLOAD));
  halfOpen.report.meta.coverage_label = 'observed — → 2026-08-07T00:00:00Z';
  const hs = renderReport(halfOpen).els.scope.textContent;
  assert.ok(hs.indexOf(ARROW) < 0,
    'an interval with an em dash for a low bound was stated as an extent');
});

test('report.html: a coverage interval with a BLANK bound is not an extent either', () => {
  // The em-dash guard above was guarding the WRONG sentinel. `reporting.coverage_label`
  // is the only producer of `meta.coverage_label`, it renders each bound through
  // `reporting._iso`, and `_iso(None)` returns the EMPTY STRING — never an em dash.
  // (`_offset_iso` is the only em-dash producer and coverage_label does not call it.)
  //
  // The blank-bounded interval is REACHABLE, end to end: cli/src/import.js guarded
  // earliest/latest with `=== null`, so one event with an undefined `ts` set both bounds
  // to `undefined` and every later comparison was permanently false; store.addCoverage
  // then wrote `Math.floor(undefined)` → NaN → JSON null on both sides. Served through
  // the real gateway, the masthead read:
  //     All recorded history (backfilled  → ). The period ladder below partitions …
  // — a stated extent with no bound on EITHER side. The single-sided variant reads
  // "(observed  → 2026-08-07T14:22:00Z)", which is exactly the "non-bound as the low side
  // of a stated extent" defect the em-dash guard was written to close; only the sentinel
  // is a blank, and a blank reads as a rendering glitch rather than as "unbounded".
  const ARROW = '→';
  const withLabel = (label) => {
    const p = JSON.parse(JSON.stringify(SINGLE_BASIS_PAYLOAD));
    p.report.meta.coverage_label = label;
    return renderReport(p).els.scope.textContent;
  };
  for (const [why, label] of [
    ['both bounds blank — the shape `cheaper import` wrote', 'backfilled  → '],
    ['the LOW side blank', 'observed  → 2026-08-07T14:22:00Z'],
    ['the HIGH side blank', 'observed 2026-08-01T00:00:00Z → '],
    // coverage_label joins intervals with " ; ". One bad interval in the list poisons the
    // whole extent — a reader cannot tell which of two intervals the missing bound is in.
    ['one good interval beside a blank-bounded one',
     'observed 2026-08-01T00:00:00Z → 2026-08-07T00:00:00Z ; backfilled  → '],
  ]) {
    assert.ok(withLabel(label).indexOf(ARROW) < 0,
      `the masthead stated an extent from a coverage label with ${why}`);
  }

  // …and a label whose every bound is real IS still stated, so this cannot pass by
  // suppressing the clause unconditionally.
  const one = 'observed 2026-08-01T00:00:00Z → 2026-08-07T00:00:00Z';
  assert.ok(withLabel(one).includes(one),
    'a fully-bounded coverage interval was suppressed — the guard suppresses everything');
  const two = one + ' ; backfilled 2026-01-01T00:00:00Z → 2026-02-01T00:00:00Z';
  assert.ok(withLabel(two).includes(two),
    'a two-interval label with four real bounds was suppressed');
});

test('cheaper import: an undated event can never write a null-bounded coverage interval', () => {
  // A SOURCE pin, and weaker than the rendered-output checks around it: runImport() walks
  // the real filesystem, so the loop below cannot be driven from a unit test without
  // building a harness larger than the thing it tests. The behavioural guarantee is the
  // template test above — this one pins the SOURCE of the bad state so it is fixed in one
  // place rather than only masked in another.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'import.js'), 'utf8');
  assert.match(src, /for \(const e of evs\) \{\s*\n\s*if \(!Number\.isFinite\(e\.ts\)\) continue;/,
    'the coverage-extent loop must skip undated events; `earliest === null` alone lets the '
    + 'first undefined ts poison BOTH bounds into undefined for the rest of the import');
  assert.match(src,
    /if \(Number\.isFinite\(summary\.totals\.earliest\) && Number\.isFinite\(summary\.totals\.latest\)\) \{\s*\n\s*store\.addCoverage\('backfilled'/,
    'addCoverage must not be reached with a non-finite bound');
});

test('report.html: the lede claims reconciliation only when the page can support it', () => {
  // The lede sat directly above the KPI grid and asserted, unconditionally, that
  // "Composition and Trend are built from the same whole-history rows and reconcile with
  // the ladder" — while reconcileNote() further down could print "Scope divergence.
  // Composition does not cover everything the period ladder and the hero figures cover,
  // so the two cannot be reconciled". Both rendered in ONE document on REPORT_PAYLOAD,
  // whose ladder carries 6 measured / 2 estimated events while its sections cover 3 / 0.
  // The false claim was in the more prominent position and the correction was buried.
  const bad = renderReport(REPORT_PAYLOAD);
  const badLede = bad.els.scopeNote.innerHTML;
  assert.ok(!/reconcile with the ladder/.test(badLede),
    'the lede affirms a reconciliation this very page goes on to deny');
  assert.match(badLede, /cannot be reconciled with it/,
    'the lede says nothing about a shortfall the page has already measured');
  // The counted correction is still rendered where the sections are — the lede replaces
  // the false claim, it does not swallow the detail.
  assert.match(bad.els.breakdown.innerHTML, /Scope divergence/);
  assert.match(bad.els.trend.innerHTML, /Scope divergence/);

  // THE VACUITY GUARD. Without this half, a lede that simply deleted the sentence would
  // pass the assertions above. On a payload whose sections cover the ladder exactly, the
  // affirmative sentence must still be made.
  const ok = renderReport(ALIGNED_SECTIONS_PAYLOAD);
  const okLede = ok.els.scopeNote.innerHTML;
  assert.match(okLede,
    /Composition and Trend are built from the same whole-history rows and reconcile with the ladder/,
    'the affirmative reconciliation sentence is gone even where it is TRUE');
  assert.ok(!/cannot be reconciled/.test(okLede),
    'the lede cries divergence on sections that cover the ladder exactly');
  assert.ok(!/Scope divergence/.test(ok.out));
});

// A ladder with dated events and sections that are EMPTY — which is what a re-narrowing
// regression produces at 100%: `sumGroupEvents([])` returned {n:0, known:false} and
// reconcileNote bailed on it, so the one case where the shortfall is TOTAL was the one
// case the page said nothing about.
const EMPTY_SECTIONS_PAYLOAD = withReport({
  periods: [
    { key: 'today', label: 'Today',
      bounds_label: '2026-08-07 00:00 → 2026-08-08 00:00 (UTC, UTC+00:00)',
      status: 'ok', grain: 'call', dollars_suppressed: false,
      measured: ACC({ calls: 3, saved: 0.75, spent: 0.25 }),
      estimated: ACC({}), events: { measured: 3, estimated: 0 },
      unpriced_calls: 0, unpriced: {}, labels: [], notes: [] },
  ],
});

test('report.html: an EMPTY Composition or Trend is a TOTAL shortfall, not a silence', () => {
  const { els } = renderReport(EMPTY_SECTIONS_PAYLOAD);
  assert.strictEqual(ladderTotals(els).eventsMeasured, '3',
    'the fixture is not exercising the case — the ladder must carry dated events');

  for (const id of ['breakdown', 'trend']) {
    assert.match(els[id].innerHTML, /Scope divergence/,
      `${id} covers NONE of the ladder and the page does not say so`);
    assert.match(els[id].innerHTML,
      /measured — this section covers 0 of the ladder’s 3 event\(s\); 3 event\(s\) are in the period ladder and NOT here/,
      `${id} does not COUNT the events it dropped`);
  }
  // Trend's empty-state SENTENCE is a function of that same shortfall.
  //
  // Fixing the ORDER was not enough. The previous round moved reconcileNote above the early
  // return and left the false sentence standing, so the section read: "3 event(s) are in
  // the period ladder and NOT here" immediately followed by "No dated events yet." — an
  // affirmative claim the DOM node directly above it contradicts, in the one case the note
  // exists to describe. The lede's identical claim is REPLACED when it is false; so is this
  // one. It must not appear here at all.
  assert.ok(!/No dated events yet\./.test(els.trend.innerHTML),
    'Trend still claims "No dated events yet." directly beneath a counted shortfall that '
    + 'says the ladder DOES carry dated events this section does not cover');
  // …and what replaces it is scoped and true: the SECTION is empty, not the report.
  assert.match(els.trend.innerHTML, /No dated events in this section/,
    'Trend dropped its empty-state text entirely instead of scoping it');
  assert.ok(els.trend.innerHTML.indexOf('Scope divergence') <
            els.trend.innerHTML.indexOf('No dated events in this section'),
    'the shortfall must be stated ABOVE the empty-state text, not after it');

  // …and the lede agrees with the sections rather than contradicting them.
  assert.ok(!/reconcile with the ladder/.test(els.scopeNote.innerHTML));

  // THE OVER-FIRING GUARD. An empty section beneath a ladder that could not report a
  // count at all is not a divergence — nothing is known to be missing. Treating "empty"
  // as a total shortfall must not turn every never-observed report into a scope warning.
  assert.ok(!/Scope divergence/.test(renderReport(ALL_NOT_COVERED_PAYLOAD).out),
    'an empty section under an unknowable ladder was reported as a divergence');
});

// THE MIRROR OF THE SENTENCE FIX, as its own test so it fails on its own.
//
// Where nothing is KNOWN to be missing, the plain empty-state wording is the TRUE one and
// must survive. Without this half, "never print 'No dated events yet.'" is satisfiable by
// deleting the sentence outright, or by printing the scoped shortfall wording
// unconditionally — and a report that genuinely has no dated events would then explain
// itself with a scope warning it has no basis whatsoever for.
test('report.html: the plain "no dated events" wording survives where it is TRUE', () => {
  const nc = renderReport(ALL_NOT_COVERED_PAYLOAD);
  assert.match(nc.els.trend.innerHTML, /No dated events yet\./,
    'the plain empty-state text was dropped from the case where it is TRUE');
  assert.ok(!/No dated events in this section/.test(nc.els.trend.innerHTML),
    'a section-scoped shortfall was claimed where no shortfall is known to exist');
});

// ===========================================================================
// dashboard.html — the Money dimension card.
//
// Everything above about this page is a source grep, and a source grep could not see the
// defect that shipped: `moneyBaselineValue()` learned the absent/negative/measured-zero
// split in ONE of its three branches, and `renderDims()` captioned every negative with a
// sentence naming the all-frontier baseline whichever baseline was actually selected —
// so a $3.21 overspend against the user's OWN requested model was reported as a $3.21
// overspend against the all-frontier CEILING. Both defects are claims about a VALUE in a
// CARD, so these EXECUTE the page's own functions and read what they produced.
//
// dashboard.html is one IIFE that exports nothing, so the real bytes of the real function
// declarations are lifted out of the real file and evaluated. Renaming or deleting any of
// them fails loudly here rather than silently skipping the check.
// ===========================================================================

const DASHBOARD = path.join(APP, 'dashboard.html');

function fnSource(js, name) {
  const needle = `function ${name}(`;
  const i = js.indexOf(needle);
  assert.ok(i >= 0, `dashboard.html no longer declares function ${name}()`);
  assert.strictEqual(js.lastIndexOf(needle), i,
    `dashboard.html declares function ${name}() more than once — which one is under test?`);
  let depth = 0;
  for (let j = js.indexOf('{', i); j < js.length; j++) {
    if (js[j] === '{') depth++;
    else if (js[j] === '}' && --depth === 0) return js.slice(i, j + 1);
  }
  assert.fail(`function ${name}() in dashboard.html has unbalanced braces`);
}

// The page's MODULE-LEVEL CONSTANTS, lifted from the source exactly the way fnSource()
// lifts its functions. A driver that restated `var SPARK_MIN_POINTS = 3` in its own
// prelude would keep passing after dashboard.html changed its copy — the same drift
// fnSource exists to prevent, one declaration kind over. Every one of these carries a
// rule (the liveness window, the minimum point count for a trend, the set of legal
// `dollars_basis` values), so a stale duplicate here would test a rule the page no
// longer applies.
function varSource(js, name) {
  const needle = `var ${name} = `;
  const i = js.indexOf(needle);
  assert.ok(i >= 0, `dashboard.html no longer declares var ${name}`);
  assert.strictEqual(js.lastIndexOf(needle), i,
    `dashboard.html declares var ${name} more than once — which one is under test?`);
  // The first `;` that ENDS A LINE, allowing the trailing `// …` comment several of these
  // declarations carry. A bare indexOf(';\n') silently walks past
  // `var ACTIVE_WINDOW_S = 120;   // …` and swallows everything up to the next
  // line-terminating semicolon — hundreds of lines of unrelated source, which then
  // executes inside the driver.
  const m = /;[ \t]*(?:\/\/[^\n]*)?\n/.exec(js.slice(i));
  assert.ok(m, `var ${name} in dashboard.html has no statement terminator`);
  return js.slice(i, i + m.index + 1);
}

// Every function renderDims() reaches, transitively. `baselineChoice` and `lastPeek` are
// the page's own mutable module state and are declared by the wrapper.
const DIM_FNS = ['num', 'measuredValue', 'money', 'esc', 'tokenCount', 'seconds',
                 'measurementInfo', 'dollarsAreMeasured', 'basisTitle', 'approxPrefix',
                 'approxFigure',
                 'moneyBaselineValue', 'historicalDimsAvailable',
                 'tokensDimValue', 'timeDimValue', 'renderDims'];

function dimDriver() {
  const js = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const grid = { innerHTML: '' };
  const doc = { getElementById(id) { return id === 'dimGrid' ? grid : null; } };
  const drive = new Function('document',
    'var baselineChoice = "requested_default";\nvar lastPeek = null;\n'
    + varSource(js, 'DOLLAR_BASES') + '\n'
    + DIM_FNS.map((n) => fnSource(js, n)).join('\n\n')
    + '\nreturn function(choice, data, peek){'
    + '  baselineChoice = choice; lastPeek = (peek === undefined ? null : peek);'
    + '  renderDims(data || {});'
    + '};')(doc);
  return (choice, data, peek) => { grid.innerHTML = ''; drive(choice, data, peek); return grid.innerHTML; };
}

// The three .dim-cards, in render order: Money, Tokens, Time.
function dimCards(html) {
  const cards = String(html).split('<div class="dim-card">').slice(1);
  assert.strictEqual(cards.length, 3,
    `renderDims produced ${cards.length} dim-card(s); Money, Tokens and Time are expected`);
  return cards;
}

function readDim(card, what) {
  const h = /<div class="headline([^"]*)">([\s\S]*?)<\/div>/.exec(card);
  assert.ok(h, `the ${what} card rendered no headline`);
  const subs = (card.match(/<div class="sub[^"]*"[^>]*>[\s\S]*?<\/div>/g) || []).map(text);
  const warn = /<div class="sub warn">([\s\S]*?)<\/div>/.exec(card);
  return { cls: h[1].trim(), value: text(h[2]), subs, warn: warn ? text(warn[1]) : null, card };
}

// The Money card is the FIRST .dim-card.
//
// `head` used to narrow every absent-case assertion to `card.split('<div class="spent-sub">')[0]`
// — which excised the ONE element that was still coercing `d.dollars.spent` through
// num(v, 0). The card rendered "no data yet" and "$0.00 spent" in the same box, in red
// bold, on first paint, and this test — the one test meant to enforce this rule on this
// card — was scoped precisely around the contradiction. The narrowing is gone: the
// assertions now cover the WHOLE card, `.spent-sub` included.
function moneyDim(html) { return readDim(dimCards(html)[0], 'Money'); }
function tokensDim(html) { return readDim(dimCards(html)[1], 'Tokens'); }
function timeDim(html) { return readDim(dimCards(html)[2], 'Time'); }

// A gateway payload that DECLARES its dollars measured — every priced call carried
// provider-reported usage, so no "about" qualifier is attached to the figures.
//
// It is stated explicitly because the page treats an ABSENT `measurement` block as
// UNKNOWN, not as measured (see measurementInfo() in dashboard.html): an older gateway is
// exactly as unable to substantiate the claim as a database full of NULL usage_source, so
// degrading the other way would make the un-upgraded gateway the one configuration that
// prints unqualified figures. The three tests below are about the absent / negative /
// measured-zero split, which is orthogonal to the basis; without this every figure would
// arrive prefixed "about" and they would be testing the qualifier instead. The qualifier
// has its own tests further down.
const MEASURED = { measured_calls: 4, unmeasured_calls: 0, dollars_basis: 'measured',
                   priced_calls: 4, zero_token_calls: 0 };

// Each baseline choice: the label the card puts under the headline, the plain-language
// SUBJECT the negative caption must name, and how to put a value on the payload.
const BASELINES = [
  { choice: 'highest_tier', label: 'vs all-frontier', subject: 'the all-frontier baseline',
    value: (v) => [{ measurement: MEASURED, baselines: { highest_tier: v } }, null] },
  { choice: 'requested_default', label: 'vs your model', subject: 'the model you asked for',
    value: (v) => [{ measurement: MEASURED, baselines: { requested_default: v } }, null] },
  // The historical baseline reads `lastPeek`, not the gateway's rows, so the gateway's
  // `measurement` block says nothing about it and is deliberately not applied — see the
  // SCOPE note on qualify() in renderDims().
  { choice: 'historical', label: 'vs your history', subject: 'your own history',
    value: (v) => [{ measurement: MEASURED }, { totals: { dollarsSaved: v } }] },
];

test('dashboard.html: requested_default is still the baseline the page opens on', () => {
  // The absent-state test below matters most for the DEFAULT selection, because that is
  // the pane a user lands on before /metrics has answered. Pin which one that is.
  assert.match(fs.readFileSync(DASHBOARD, 'utf8'),
    /var baselineChoice = 'requested_default';/);
});

test('dashboard.html: an ABSENT money baseline is a labelled non-number, never $0.00', () => {
  // setBaseline(baselineChoice) runs at load with lastData === null, so renderDims({})
  // executes before any /metrics response — on ALL THREE choices. Only highest_tier had
  // been taught the difference; requested_default (the default) and historical still
  // coerced through num(v, 0) and printed a confident $0.00. The historical case is the
  // worse one: `lastPeek` stays null until /peek returns and stays null FOREVER if the
  // chat-history scan never runs, so "vs your history $0.00" is a measured-zero claim for
  // an analysis that was never performed.
  const render = dimDriver();
  for (const b of BASELINES) {
    const d = moneyDim(render(b.choice, {}, null));
    assert.strictEqual(d.value, '&mdash;',
      `${b.choice}: an absent baseline did not render a labelled non-number`);
    assert.match(d.cls, /\bnodata\b/, `${b.choice}: the absent headline carries no nodata class`);
    // THE WHOLE CARD, not just the headline. `.spent-sub` is inside this now.
    assert.ok(!/\$0\.00/.test(d.card),
      `${b.choice}: an absent baseline printed a measured $0.00 somewhere in the Money card`);
    assert.ok(d.subs.includes('no data yet'), `${b.choice}: the absent state is not labelled`);
    assert.ok(d.subs.includes(b.label), `${b.choice}: the card lost its baseline label`);
    // The spend line is its OWN accumulator and its OWN three-state claim: absent on the
    // very first paint, and left on screen INDEFINITELY when the gateway is unreachable,
    // down or 401 — render() is reached only from ws.onmessage and the poll, and both
    // .catch swallow the failure. It must be a labelled non-number, like the headline.
    const spend = /<div class="spent-sub([^"]*)">([\s\S]*?)<\/div>/.exec(d.card);
    assert.ok(spend, `${b.choice}: the Money card lost its spend line entirely`);
    assert.match(spend[1], /\bnodata\b/,
      `${b.choice}: the absent spend line is not marked as a non-number`);
    assert.match(text(spend[2]), /no data yet/,
      `${b.choice}: the absent spend line reads "${text(spend[2])}" — it is not labelled`);
  }
  // A peek that arrived but carries no totals is ABSENT, not zero — and so is a totals
  // object with no dollarsSaved on it.
  for (const peek of [{}, { totals: null }, { totals: {} }]) {
    assert.strictEqual(moneyDim(render('historical', {}, peek)).value, '&mdash;',
      'a peek with no usable total was rendered as a measured zero');
  }
});

test('dashboard.html: a NEGATIVE money baseline names the baseline it was measured against', () => {
  // THE REGRESSION. renderDims() attached one all-frontier-specific caption to every
  // baseline choice, so an overspend measured against the user's own requested model —
  // or against their own history — was captioned as an overspend against the all-frontier
  // CEILING: a materially different and much larger-sounding claim than the one measured.
  // Both negative states are reachable and real: metrics.py sets
  // baselines.requested_default from the SIGNED `dollars["saved"]` accumulator, and
  // cli/src/peek/tagline.js branches on `dollarsSaved <= -SHOW_MIN_USD`.
  const render = dimDriver();
  for (const b of BASELINES) {
    const [data, peek] = b.value(-3.21);
    const d = moneyDim(render(b.choice, data, peek));
    assert.strictEqual(d.value, '-$3.21', `${b.choice}: the negative lost its sign or its value`);
    assert.match(d.cls, /\bmoney-neg\b/, `${b.choice}: the negative is not marked as one`);
    assert.ok(d.subs.includes(b.label), `${b.choice}: the card lost its baseline label`);
    assert.ok(d.warn, `${b.choice}: a negative rendered as a bare unlabelled figure`);
    assert.ok(d.warn.includes('you spent $3.21 MORE than ' + b.subject + ' this period'),
      `${b.choice}: the caption reads "${d.warn}" — it must name ${b.subject}`);
    // …and it must name NO OTHER baseline. This is the whole finding: the sub label and
    // the caption directly beneath it may not name two different comparisons.
    for (const other of BASELINES) {
      if (other.subject === b.subject) continue;
      assert.ok(!d.warn.includes(other.subject),
        `${b.choice}: the caption attributes the overspend to ${other.subject}, but the `
        + `card is measuring against ${b.subject} — the label and the caption disagree`);
    }
  }
});

test('dashboard.html: a MEASURED zero money baseline is still $0.00, on every choice', () => {
  // The mirror of the absent test: a real measured zero is a real claim and must not be
  // suppressed into an em dash. Without this half, "never render $0.00" would be
  // satisfiable by never rendering a figure at all.
  const render = dimDriver();
  for (const b of BASELINES) {
    const [data, peek] = b.value(0);
    const d = moneyDim(render(b.choice, data, peek));
    assert.strictEqual(d.value, '$0.00', `${b.choice}: a measured zero was suppressed`);
    assert.ok(!/\bnodata\b/.test(d.cls), `${b.choice}: a measured zero was labelled "no data"`);
    assert.strictEqual(d.warn, null, `${b.choice}: a measured zero was captioned as an overspend`);
  }
  // …and a positive is untouched.
  const pos = moneyDim(render('highest_tier',
    { measurement: MEASURED, baselines: { highest_tier: 4.5 } }, null));
  assert.strictEqual(pos.value, '$4.50');
  assert.strictEqual(pos.cls, '');
});

// ---------------------------------------------------------------------------
// The rest of the Money card, and the two cards beside it.
//
// The previous round taught the money HEADLINE the absent/measured-zero split and left the
// same coercion standing two lines below it and on both neighbouring cards. The result was
// worse than the uniform defect it replaced: renderDims({}) rendered the em dash and "no
// data yet" AND "$0.00 spent" in one box, and "0" reasoning tokens and "0.0s" saved beside
// it — a card contradicting itself on the pane a user lands on first, and not a transient
// one: render() is reached only from ws.onmessage and the poll, whose .catch swallows every
// failure, so an unreachable/down/401 gateway leaves it there indefinitely.
//
// So both halves are pinned for ALL THREE figures. Absent ⇒ labelled non-number; measured
// zero ⇒ the real $0.00 / 0 / 0.0s. Neither half alone is satisfiable by the other's fix.
// ---------------------------------------------------------------------------

test('dashboard.html: ABSENT tokens and time are labelled non-numbers, never 0 / 0.0s', () => {
  const render = dimDriver();
  // renderDims({}) — the literal first paint, on every baseline choice, plus the
  // historical branch reading a peek whose totals carry no such key.
  const cases = [
    ...BASELINES.map((b) => [b.choice, {}, null, `${b.choice} first paint`]),
    ['historical', {}, { totals: { dollarsSaved: 1 } }, 'historical peek with no token/time totals'],
  ];
  for (const [choice, data, peek, why] of cases) {
    const html = render(choice, data, peek);
    const tk = tokensDim(html);
    assert.strictEqual(tk.value, '&mdash;', `${why}: absent tokens rendered as a figure`);
    assert.match(tk.cls, /\bnodata\b/, `${why}: the absent token headline is not marked`);
    assert.ok(!/>0</.test(tk.card) && !/\b0\b/.test(text(tk.card).replace(/&mdash;/g, '')),
      `${why}: the Tokens card printed a bare 0 for a measurement never made`);
    assert.ok(tk.subs.includes('no data yet'), `${why}: the absent token state is not labelled`);

    const tm = timeDim(html);
    assert.strictEqual(tm.value, '&mdash;', `${why}: absent time rendered as a figure`);
    assert.match(tm.cls, /\bnodata\b/, `${why}: the absent time headline is not marked`);
    assert.ok(!/0\.0s/.test(tm.card) && !/\b0s\b/.test(tm.card),
      `${why}: the Time card printed 0.0s for a measurement never made`);
    assert.ok(tm.subs.includes('no data yet'), `${why}: the absent time state is not labelled`);
    // The reasoning line is a SECOND measurement and carries its own state.
    assert.ok(/potential from reasoning \(no data yet\)/.test(text(tm.card)),
      `${why}: the reasoning-potential line claims a figure it does not have`);
  }
});

test('dashboard.html: MEASURED zero tokens/time/spend still render 0, 0.0s and $0.00', () => {
  // THE OVER-CORRECTION GUARD. Without this half, every assertion above is satisfiable by
  // a renderDims() that simply never prints a figure. A measured zero is a real claim.
  const render = dimDriver();
  const zeroData = {
    measurement: MEASURED,
    dollars: { spent: 0 },
    tokens: { saved_reasoning_potential: 0 },
    time: { saved_model_s: 0, saved_reasoning_potential_s: 0 },
    baselines: { requested_default: 0 },
  };
  const html = render('requested_default', zeroData, null);

  const mo = moneyDim(html);
  assert.match(mo.card, /<div class="spent-sub">\$0\.00 spent<\/div>/,
    'a measured zero spend was suppressed instead of stated');

  const tk = tokensDim(html);
  assert.strictEqual(tk.value, '0potential', 'a measured zero token figure was suppressed');
  assert.ok(!/\bnodata\b/.test(tk.cls), 'a measured zero token figure was labelled "no data"');
  assert.ok(!/no data yet/.test(tk.card), 'a measured zero token figure was labelled "no data"');

  const tm = timeDim(html);
  assert.strictEqual(tm.value, '0.0s', 'a measured zero time figure was suppressed');
  assert.ok(!/\bnodata\b/.test(tm.cls), 'a measured zero time figure was labelled "no data"');
  assert.ok(tm.subs.includes('+ 0.0s potential from reasoning'),
    'a measured zero reasoning potential was suppressed');
  assert.ok(!/no data yet/.test(tm.card), 'a measured zero time figure was labelled "no data"');

  // The historical branch is a DIFFERENT reader over a DIFFERENT payload shape and gets
  // the same treatment: a peek that really measured zero says zero.
  const hist = render('historical', {}, { totals: {
    dollarsSaved: 0, tokensSavedReasoningPotential: 0,
    timeSavedModelS: 0, timeSavedReasoningPotentialS: 0 } });
  assert.strictEqual(tokensDim(hist).value, '0potential',
    'historical: a measured zero token figure was suppressed');
  assert.strictEqual(timeDim(hist).value, '0.0s',
    'historical: a measured zero time figure was suppressed');
});

// ---------------------------------------------------------------------------
// renderCards() — the SAME two accumulators, on the SAME pane, two panels higher.
//
// `dollars.saved` and `dollars.spent` are read by BOTH renderCards() and renderDims(). If
// only one surface learns the absent/measured-zero split the two disagree on screen: the
// dim card saying "— (no data yet)" while the stat card two panels above it says "$0.00".
// ---------------------------------------------------------------------------
const CARD_FNS = ['num', 'measuredValue', 'money', 'pctFrac', 'esc',
                  'measurementInfo', 'dollarsAreMeasured', 'basisTitle', 'approxPrefix',
                  'approxFigure', 'renderCards'];

function cardsDriver() {
  const js = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const grid = { innerHTML: '' };
  const doc = { getElementById(id) { return id === 'statCards' ? grid : null; } };
  const drive = new Function('document',
    varSource(js, 'DOLLAR_BASES') + '\n'
    + CARD_FNS.map((n) => fnSource(js, n)).join('\n\n')
    + '\nreturn function(data){ renderCards(data || {}); };')(doc);
  return (data) => { grid.innerHTML = ''; drive(data); return grid.innerHTML; };
}

// Stat cards in render order: Total routed, Downgrade rate, Saved, Spent, Savings %.
function statCard(html, i) {
  const cards = String(html).split('<div class="card">').slice(1);
  assert.strictEqual(cards.length, 5, 'the stat card row lost or gained a card');
  const card = cards[i];
  const v = /<div class="value([^"]*)">([\s\S]*?)<\/div>/.exec(card);
  assert.ok(v, `stat card ${i} rendered no value`);
  return { cls: v[1].trim(), value: text(v[2]), card };
}

test('dashboard.html: the Saved and Spent stat cards agree with the Money dim card', () => {
  const render = cardsDriver();

  // ABSENT — no `dollars` block at all. Savings % is in scope with Saved and Spent: it is
  // DERIVED from them and lives in the same `dollars` dict, so a payload that leaves those
  // two absent leaves it absent too. "Savings % 0.0%" standing beside "Saved —" on the same
  // row is the same self-contradiction the Money card was pulled up for.
  const absent = render({ total: 0 });
  for (const [i, name] of [[2, 'Saved'], [3, 'Spent'], [4, 'Savings %']]) {
    const c = statCard(absent, i);
    assert.strictEqual(c.value, '&mdash;', `${name}: an absent figure rendered as a number`);
    assert.match(c.cls, /\bnodata\b/, `${name}: the absent value carries no nodata class`);
    assert.ok(!/\$0\.00/.test(c.card) && !/0\.0%/.test(c.card),
      `${name}: an absent figure printed a measured $0.00 / 0.0%`);
    assert.ok(/no data yet/.test(text(c.card)), `${name}: the absent state is not labelled`);
  }

  // MEASURED ZERO — the mirror, so "never $0.00" is not satisfiable by never reporting.
  const zero = render({ total: 0, measurement: MEASURED,
                        dollars: { saved: 0, spent: 0, savings_pct: 0 } });
  for (const [i, name, want] of [[2, 'Saved', '$0.00'], [3, 'Spent', '$0.00'],
                                 [4, 'Savings %', '0.0%']]) {
    const c = statCard(zero, i);
    assert.strictEqual(c.value, want, `${name}: a measured zero was suppressed`);
    assert.ok(!/\bnodata\b/.test(c.cls), `${name}: a measured zero was labelled "no data"`);
    assert.ok(!/no data yet/.test(text(c.card)), `${name}: a measured zero was labelled "no data"`);
  }

  // …and a real pair of figures keeps its colour and its sign.
  const real = render({ total: 9, measurement: MEASURED,
                        dollars: { saved: 1.5, spent: -0.25, savings_pct: 42 } });
  assert.strictEqual(statCard(real, 2).value, '$1.50');
  assert.strictEqual(statCard(real, 2).cls, 'green');
  assert.strictEqual(statCard(real, 3).value, '-$0.25');
  assert.strictEqual(statCard(real, 3).cls, 'red');
  assert.strictEqual(statCard(real, 4).value, '42.0%');
  assert.strictEqual(statCard(real, 4).cls, 'green');
});

// ---------------------------------------------------------------------------
// renderPeek() — the THIRD reader of the very same lastPeek object.
//
// The dim cards were routed through measuredValue(); this panel was not, and it reads the
// SAME object. From one lastPeek the page rendered, simultaneously:
//     PEEK PANEL     : Could have saved $0.00 (0.0% off)   No harness detail available yet.
//     MONEY DIM CARD : Money  —  vs your history  no data yet
// One page, one object, two contradictory claims — and the $0.00 wrapped in a green span,
// so it read as a measured positive result.
//
// It is reachable, not theoretical: app.py returns ~/.cheaper/peek.json VERBATIM and
// UNVALIDATED — only a read/parse exception produces available:false — so a truncated
// write, a scan that produced no totals, and an older peek.json schema all arrive with
// `available` truthy and `totals` partial or absent. renderPeek guards ONLY
// `if (!p || p.available === false)`, so every one of them fell through to
// money(undefined) === "$0.00" and pctFrac(undefined) === 0.
// ---------------------------------------------------------------------------
const PEEK_FNS = ['num', 'measuredValue', 'money', 'pctFrac', 'esc', 'truncate', 'renderPeek'];

function peekDriver() {
  const js = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const panel = { innerHTML: '' };
  const doc = { getElementById(id) { return id === 'peekPanel' ? panel : null; } };
  const drive = new Function('document',
    PEEK_FNS.map((n) => fnSource(js, n)).join('\n\n')
    + '\nreturn function(p){ renderPeek(p); };')(doc);
  return (p) => { panel.innerHTML = ''; drive(p); return panel.innerHTML; };
}

// The headline is the first element the panel emits and contains no nested <div>.
function peekHeadline(html) {
  const m = /<div class="peek-headline">([\s\S]*?)<\/div>/.exec(String(html));
  assert.ok(m, 'the peek panel rendered no headline at all');
  return m[1];
}

// The three payload shapes app.py can hand this function with `available` truthy, plus the
// partial-total case that produced the self-contradicting one-sentence headline.
const PEEK_ABSENT_CASES = [
  ['available with no totals key', { available: true }],
  ['available with totals: null', { available: true, totals: null }],
  ['available with an empty totals object', { available: true, totals: {} }],
  ['a REAL total but no savedPct', { available: true, totals: { dollarsSaved: 5 } }],
];

test('dashboard.html: an ABSENT peek figure is a labelled non-number, never $0.00 / 0.0%', () => {
  const render = peekDriver();
  for (const [why, p] of PEEK_ABSENT_CASES) {
    const html = render(p);
    assert.ok(!/\$0\.00/.test(html),
      `${why}: the peek panel fabricated a measured $0.00`);
    assert.ok(!/0\.0% off/.test(html),
      `${why}: the peek panel fabricated a measured 0.0% off`);
    const head = peekHeadline(html);
    if (p.totals && p.totals.dollarsSaved !== undefined) {
      // The half-measured case. The total is REAL and must survive with its value; the
      // percentage was never measured, so the clause that would qualify it is dropped
      // outright rather than printed as "(0.0% off)" — "Could have saved $5.00 (0.0% off)"
      // is one sentence contradicting itself.
      assert.match(text(head), /Could have saved \$5\.00/, `${why}: the real total was lost`);
      assert.ok(!/% off/.test(head),
        `${why}: a percentage clause was printed for a percentage that was never measured`);
    } else {
      assert.match(head, /<span class="nodata">&mdash;<\/span>/,
        `${why}: the absent total is not a labelled non-number`);
      assert.match(text(head), /no data yet/, `${why}: the absent total is not labelled`);
      assert.ok(!/class="green"/.test(head),
        `${why}: an unmeasured total was styled as a measured positive result`);
    }
  }
});

test('dashboard.html: an ABSENT per-row peek figure never borrows a $0.00 from its neighbour', () => {
  // Both leaks live inside a COMPARISON — the harness rows are read against each other and
  // the opportunities are explicitly RANKED — so a fabricated zero does not merely state a
  // wrong number, it reorders the reader's conclusion about which harness to fix first.
  const render = peekDriver();
  const html = render({
    available: true,
    totals: { dollarsSaved: 1.25, savedPct: 0.5 },
    harnesses: [
      { key: 'codex', label: 'Codex', calls: 3, dollarsSaved: 1.25,
        examples: [{ from: 'a', to: 'b', saved: 1.25, source: 'x' }] },
      { key: 'claude', label: 'Claude Code', calls: 10,
        examples: [{ from: 'c', to: 'd', source: 'y' }] },
    ],
  });
  assert.ok(!/\$0\.00/.test(html),
    'a peek row with no dollarsSaved printed a fabricated $0.00 beside a real figure');

  const rows = html.split('<div class="harness-row">').slice(1);
  assert.strictEqual(rows.length, 2, 'the harness rows did not render');
  assert.match(text(rows[0]), /Codex3 calls\$1\.25|Codex.*\$1\.25/,
    'the measured harness row lost its real figure');
  assert.match(rows[1], /<span class="hsaved"><span class="nodata">&mdash;<\/span>/,
    'the unmeasured harness row is not a labelled non-number');
  assert.match(text(rows[1]), /no data yet/, 'the unmeasured harness row is not labelled');

  const opps = html.split('<div class="opp">').slice(1);
  assert.strictEqual(opps.length, 2, 'the opportunity rows did not render');
  const measured = opps.find((o) => /\$1\.25/.test(o));
  const unmeasured = opps.find((o) => !/\$1\.25/.test(o));
  assert.ok(measured && unmeasured, 'expected one measured and one unmeasured opportunity');
  assert.match(unmeasured, /<span class="saved"><span class="nodata">&mdash;<\/span>/,
    'the unmeasured opportunity is not a labelled non-number');
  assert.match(text(unmeasured), /no data yet/, 'the unmeasured opportunity is not labelled');
});

test('dashboard.html: a MEASURED zero peek still renders $0.00 and 0.0% off', () => {
  // THE OVER-CORRECTION GUARD. Without it every assertion above is satisfiable by a
  // renderPeek() that simply refuses to report — and "you genuinely saved nothing" is a
  // real, useful claim that must survive intact, sign and all.
  const render = peekDriver();
  const html = render({
    available: true,
    totals: { dollarsSaved: 0, savedPct: 0, annualizedSaved: 0 },
    harnesses: [{ key: 'codex', label: 'Codex', calls: 3, dollarsSaved: 0,
                  examples: [{ from: 'a', to: 'b', saved: 0, source: 'x' }] }],
  });
  const head = peekHeadline(html);
  assert.match(text(head), /Could have saved \$0\.00 \(0\.0% off\)/,
    'a measured zero peek was suppressed instead of stated');
  assert.match(head, /<span class="green">\$0\.00<\/span>/,
    'a measured zero lost the styling every other measured total gets');
  assert.match(text(head), /annualized ~\$0\.00/, 'a measured zero annualization was suppressed');
  assert.ok(!/no data yet/.test(text(html)),
    'a measured zero peek was labelled as having no data');
  assert.match(html, /<span class="hsaved">\$0\.00<\/span>/,
    'a measured zero harness row was suppressed');
  assert.match(html, /<span class="saved">\$0\.00<\/span>/,
    'a measured zero opportunity was suppressed');
  // …and a real negative keeps its sign on the headline.
  assert.match(text(peekHeadline(render({ available: true, totals: { dollarsSaved: -2.5 } }))),
    /Could have saved -\$2\.50/, 'a negative historical total lost its sign');
});

// THE INVARIANT THAT ACTUALLY FAILED: renderPeek() and the historical Money dim card read
// the SAME lastPeek object. Two implementations of one rule drifted, and the page said both
// things at once. Neither surface's own tests could see it; only a comparison can.
const SHARED_LASTPEEK_CASES = [
  ['peek with no totals key', { available: true }],
  ['peek with totals: null', { available: true, totals: null }],
  ['peek with an empty totals object', { available: true, totals: {} }],
  ['peek with a real measured total', { available: true, totals: { dollarsSaved: 5 } }],
  ['peek with a measured ZERO total', { available: true, totals: { dollarsSaved: 0 } }],
  ['peek with a measured NEGATIVE total', { available: true, totals: { dollarsSaved: -2.5 } }],
];

test('dashboard.html: renderPeek and the historical Money dim card never disagree', () => {
  const peek = peekDriver();
  const dims = dimDriver();
  for (const [why, p] of SHARED_LASTPEEK_CASES) {
    const head = peekHeadline(peek(p));
    const card = moneyDim(dims('historical', {}, p));
    const peekMissing = /class="nodata"/.test(head);
    const dimMissing = /\bnodata\b/.test(card.cls);
    assert.strictEqual(peekMissing, dimMissing,
      `${why}: the peek panel says ${peekMissing ? 'no data' : 'a figure'} while the Money `
      + `card says ${dimMissing ? 'no data' : 'a figure'} — from the SAME lastPeek object`);
    if (peekMissing) continue;
    const peekAmt = (text(head).match(/-?\$[\d,]+\.\d{2}/) || [])[0];
    assert.strictEqual(peekAmt, card.value,
      `${why}: the peek panel shows ${peekAmt} and the Money card shows ${card.value} — `
      + 'from the SAME lastPeek object');
  }
});

// ---------------------------------------------------------------------------
// The Saved stat card's BASELINE LABEL.
//
// metrics.py computes `saved = base_x - spent_x` where `base_x = cost_of_model(om, ...)`
// and `om` is the model the CALLER ASKED FOR, then publishes
// `baselines.requested_default = dollars["saved"]`. The all-top-tier comparison is a
// SEPARATE accumulator (`billed_top`) published as `baselines.highest_tier`.
//
// The Saved card captioned `dollars.saved` "vs all-top-tier". On a real payload
// (dollars.saved 0.2, requested_default 0.2, highest_tier 0.4) the page therefore rendered
//   STAT CARD  : Saved $0.20  vs all-top-tier
//   MONEY DIM  : Money $0.40  vs all-frontier
// — the same top-tier claim attached to two different figures, always, on every load.
//
// Repointing the card at highest_tier instead would have been the WRONG fix: `savings_pct`
// is derived from dollars.saved / spent, so the Savings % card three along would then
// contradict its own numerator. The label moves; the figure does not.
// ---------------------------------------------------------------------------
const TOP_TIER_WORDING = /top[- ]tier|frontier/i;

test('dashboard.html: no two nodes attach all-top-tier wording to different figures', () => {
  const cards = cardsDriver();
  const dims = dimDriver();
  // The real /metrics shape, with the two baselines DELIBERATELY different — identical
  // values would let the mislabelling pass unnoticed.
  const payload = {
    total: 5,
    // Declared measured so the figures render bare: this test compares a LABEL against
    // the FIGURE beside it, and an "about" prefix on both would only add noise to the
    // comparison. The prefix has its own tests.
    measurement: MEASURED,
    dollars: { saved: 0.2, spent: 0.3, savings_pct: 40 },
    baselines: { requested_default: 0.2, highest_tier: 0.4 },
  };
  const pane = cards(payload)
    + dims('requested_default', payload, null)
    + dims('highest_tier', payload, null);

  let sawTopTier = 0;
  for (const block of pane.split(/<div class="(?:dim-)?card">/).slice(1)) {
    if (!TOP_TIER_WORDING.test(text(block))) continue;
    const v = /<div class="(?:value|headline)[^"]*">([\s\S]*?)<\/div>/.exec(block);
    assert.ok(v, 'a node carrying all-top-tier wording rendered no figure at all');
    assert.strictEqual(text(v[1]), '$0.40',
      `a node captioned with all-top-tier / all-frontier wording is showing ${text(v[1])}, `
      + 'but the all-top-tier baseline on this payload is $0.40 — the label names a '
      + 'baseline the figure was not measured against');
    sawTopTier++;
  }
  // The mirror: the fix may not be "delete every baseline caption". The all-frontier card
  // still has to say what it is comparing against.
  assert.ok(sawTopTier > 0,
    'the all-top-tier wording vanished from the pane entirely — the caption was deleted '
    + 'rather than corrected, and the all-frontier figure is now unlabelled');

  // The Saved card keeps its FIGURE (moving it would strand savings_pct, which is derived
  // from this exact numerator) and gains the caption that matches what the figure IS —
  // the same subject moneyBaselineValue() uses for baselines.requested_default.
  const saved = statCard(cards(payload), 2);
  assert.strictEqual(saved.value, '$0.20',
    'the Saved card was repointed at a different baseline; savings_pct is derived from '
    + 'dollars.saved and would now contradict its own numerator');
  assert.match(text(saved.card), /vs the model you asked for/,
    'the Saved card lost the caption naming what it is measured against');
  assert.ok(!TOP_TIER_WORDING.test(text(saved.card)),
    'the Saved card still claims an all-top-tier comparison it did not make');

  // …and the two dim cards it sits above still read as they did: the same $0.20 under the
  // requested-model label, the different $0.40 under the all-frontier one.
  assert.strictEqual(moneyDim(dims('requested_default', payload, null)).value, saved.value,
    'the Saved card and the requested-model dim card disagree on the same figure');
  assert.strictEqual(moneyDim(dims('highest_tier', payload, null)).value, '$0.40',
    'the all-frontier dim card no longer shows baselines.highest_tier');
  // Savings % is still the percentage derived from the figure beside it.
  assert.strictEqual(statCard(cards(payload), 4).value, '40.0%');
});

// ===========================================================================
// dashboard.html — the REPORTS tab: renderTrend, renderPop, renderComposition.
//
// `cheaper reports` with no flag routes to the BROWSER, at this tab (cli/src/reports.js
// ::run), so these three renderers are the default reporting surface — and every one of
// them shipped a cross-basis figure that the terminal renderer, over the identical
// payload, does not produce:
//
//   renderTrend        one bar per bucket, drawn from `measured.saved + estimated.saved`,
//                      titled "$3.00 over 4 calls", and scaled against a maximum taken
//                      over those SUMMED values — so the bar GEOMETRY carried the sum
//                      too. `(v || 0)` also plotted a WITHHELD figure as a measured zero.
//   renderPop          "n=4" for 3 measured + 1 estimated calls, printed directly above
//                      its own caption reading "measured / estimated — never summed"; and
//                      a WITHHELD window labelled "not covered", which is a different and
//                      false claim.
//   renderComposition  `events` (ROWS SEEN, already inclusive of unpriceable rows) PLUS
//                      `unpriced_calls`, so every exclusion was counted twice.
//
// A source grep cannot see any of these: they are claims about a VALUE, produced by
// arithmetic. So these tests EXECUTE the page's own functions over real
// store.reportTrend() / reportWindow() / reportBreakdown() shapes and read what they
// emitted — and the last test in the section drives the CLI's REAL terminal renderer over
// the SAME payload and compares the two, because "two implementations of one rule
// drifted" is a defect only a comparison can see.
// ===========================================================================

// Everything the three Reports renderers reach, transitively. `claimState` is the SHARED
// claim predicate every one of them now routes its three-way decision through.
const REPORTS_BASE_FNS = ['num', 'esc', 'money', 'claimState', 'suppressionNotes',
                          'basisEvents', 'unpricedOf'];

function reportsDriver(elId, fns, call) {
  const js = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const el = { innerHTML: '' };
  const doc = { getElementById(id) { return id === elId ? el : null; } };
  const drive = new Function('document',
    REPORTS_BASE_FNS.concat(fns).map((n) => fnSource(js, n)).join('\n\n')
    + '\nreturn function(x){ ' + call + ' };')(doc);
  return (x) => { el.innerHTML = ''; drive(x); return el.innerHTML; };
}

const trendDriver = () =>
  reportsDriver('trendWrap', ['trendSaved', 'renderTrend'], 'renderTrend(x);');
const popDriver = () =>
  reportsDriver('popGrid', ['popSaved', 'popN', 'popRow', 'renderPop'], 'renderPop(x);');
const compDriver = () =>
  reportsDriver('composition', ['compSaved', 'renderComposition'], 'renderComposition(x);');

// A fold accumulator, exactly as cli/src/peek/derive.js::foldRows builds one. `calls` is
// rows PRICED; the money fields are null when the window's dollars were suppressed.
const fold = (o) => Object.assign(
  { saved: 0, spent: 0, baseline: 0, tokens: 0, calls: 0, credited: 0, offset: 0,
    gross: 0, extra: 0 }, o);

// THE payload from the blocker report: one bucket carrying BOTH bases with different
// values, one carrying only measured, one WITHHELD, and the trailing undated point.
const TREND_PAYLOAD = [
  { bucket: '2026-08-10', grain: 'call', undatable: false,
    measured: fold({ calls: 3, saved: 2.88 }), estimated: fold({ calls: 1, saved: 0.12 }),
    events: { measured: 3, estimated: 1 }, unpriced_calls: 0 },
  // ABSENT on one basis — no estimated rows landed in this bucket at all.
  { bucket: '2026-08-11', grain: 'call', undatable: false,
    measured: fold({ calls: 2, saved: 1.00 }), estimated: fold({ calls: 0 }),
    events: { measured: 2, estimated: 0 }, unpriced_calls: 0 },
  // WITHHELD on one basis — store.js::withheld() nulls the five money fields and leaves
  // the counts, which are exact.
  { bucket: '2026-08-12', grain: 'call', undatable: false,
    measured: fold({ calls: 3, saved: null, spent: null, baseline: null }),
    estimated: fold({ calls: 1, saved: 0.05 }),
    events: { measured: 3, estimated: 1 }, unpriced_calls: 3 },
  { bucket: 'undated', grain: 'call', undatable: true,
    measured: fold({}), estimated: fold({}),
    events: { measured: 0, estimated: 0 }, unpriced_calls: 2 },
];

// One bucket group -> its two bar slots, in render order.
function trendGroups(html) {
  return String(html).split('<span class="tbg">').slice(1).map((g) => {
    const slots = g.split('<span class="tb ').slice(1)
      .map((s) => '<span class="tb ' + s.slice(0, s.indexOf('</span>') + 7));
    return { raw: g, slots };
  });
}
const barHeight = (slot) => {
  const m = /height:(-?[\d.]+)%/.exec(slot);
  return m ? Number(m[1]) : null;
};
const barTitle = (slot) => {
  const m = /title="([^"]*)"/.exec(slot);
  return m ? m[1] : '';
};

test('dashboard.html: renderTrend never derives ONE figure, ONE count or ONE axis from two bases', () => {
  const html = trendDriver()(TREND_PAYLOAD);

  // THE REGRESSION, on the value rather than on the source text. 2.88 + 0.12 = 3.00 and
  // 3 + 1 = 4; neither may appear anywhere in the markup, tooltips included.
  assert.ok(!/\$3\.00/.test(html),
    'renderTrend printed $3.00 — measured $2.88 added to estimated $0.12');
  assert.ok(!/over 4 calls?/.test(html),
    'renderTrend printed a 4-call population — 3 measured calls added to 1 estimated call');

  const groups = trendGroups(html);
  // The undated point is NOT a bucket on the date axis, so three groups, not four.
  assert.strictEqual(groups.length, 3,
    'renderTrend did not emit exactly one group per DATED bucket');
  groups.forEach((g, i) => assert.strictEqual(g.slots.length, 2,
    `bucket ${i} rendered ${g.slots.length} bar slot(s); one per basis is expected`));

  // Both bases keep their OWN figure and their OWN call count.
  assert.match(barTitle(groups[0].slots[0]), /measured: \$2\.88 over 3 calls/,
    'the measured bar lost its own figure or its own count');
  assert.match(barTitle(groups[0].slots[1]), /estimated: \$0\.12 over 1 call/,
    'the estimated bar lost its own figure or its own count');

  // THE AXIS. A bar scaled against a summed maximum is the same defect in the geometry.
  // Measured max is 2.88, so $1.00 is 35% of ITS OWN basis; against the old summed
  // maximum of 3.00 the same bar was 33%. Estimated max is 0.12, so $0.05 is 42% — a
  // figure that is impossible on any shared axis, since 0.05/2.88 rounds to 2%.
  assert.strictEqual(barHeight(groups[0].slots[0]), 100,
    'the largest measured figure is not full height on its own axis');
  assert.strictEqual(barHeight(groups[0].slots[1]), 100,
    'the largest estimated figure is not full height on its own axis — the estimated bars '
    + 'are still being scaled against a maximum that is not theirs');
  assert.strictEqual(barHeight(groups[1].slots[0]), 35,
    '$1.00 against a measured maximum of $2.88 is 35%; a shared or summed maximum gives 33%');
  assert.strictEqual(barHeight(groups[2].slots[1]), 42,
    '$0.05 against an estimated maximum of $0.12 is 42%; against any cross-basis maximum '
    + 'it collapses to 2%');
});

test('dashboard.html: renderTrend renders ABSENT and WITHHELD as two different non-numbers', () => {
  const html = trendDriver()(TREND_PAYLOAD);
  const groups = trendGroups(html);

  // ABSENT — no estimated rows in 2026-08-11. Never a 0-height bar, which is what a
  // MEASURED zero looks like.
  const absent = groups[1].slots[1];
  assert.match(absent, /class="tb nodata"/, 'an absent basis did not render as a non-number');
  assert.match(absent, /&mdash;/, 'the absent basis is not labelled');
  assert.strictEqual(barHeight(absent), null,
    'an absent basis was plotted as a bar — a measurement that was never made');

  // WITHHELD — 2026-08-12's dollars were suppressed. This is the `(v || 0)` case: the old
  // renderer added a zero for it and titled the bucket "$0.05", the OTHER basis's figure,
  // as though it were the whole bucket.
  const withheld = groups[2].slots[0];
  assert.match(withheld, /class="tb unpriceable"/,
    'a withheld figure did not render as a withheld one');
  assert.match(withheld, />withheld</, 'the withheld figure is not labelled "withheld"');
  assert.strictEqual(barHeight(withheld), null,
    'a withheld figure was plotted — a declined claim drawn as a measured zero');
  assert.ok(!/\$0\.00/.test(withheld), 'a withheld figure printed a measured $0.00');
  // …and the counts, which are exact, survive the suppression.
  assert.match(barTitle(withheld), /3 calls/,
    'suppressing the dollars also discarded the call count, which was never in doubt');

  // The two labels are DIFFERENT. Collapsing either into the other is the defect.
  assert.notStrictEqual(text(absent), text(withheld),
    'absent and withheld rendered the same label — they are different claims');

  // The undated point is LABELLED, never plotted, and never given a date-axis label. It
  // used to render a $0.00 bar under an axis tick reading "ed" (`'undated'.slice(5)`).
  assert.match(html, /<div class="trend-undated">/, 'the undated point vanished entirely');
  assert.match(text(html), /not dated/, 'the undated point is not labelled');
  assert.match(text(html), /2 call\(s\) attributed to no day, unpriced/,
    'the undated point lost its own call count');
  assert.ok(!/>ed</.test(html),
    'the undated point is still being given a slot on the DATE axis');
});

test('dashboard.html: renderTrend still plots a MEASURED zero and keeps a negative negative', () => {
  // THE OVER-CORRECTION GUARD. Every assertion above is otherwise satisfiable by a
  // renderTrend() that plots nothing: a measured zero and a real overspend are both real
  // claims and must survive, sign and all.
  const html = trendDriver()([
    { bucket: '2026-08-10', undatable: false,
      measured: fold({ calls: 2, saved: 0 }), estimated: fold({ calls: 1, saved: -0.40 }),
      events: { measured: 2, estimated: 1 } },
    { bucket: '2026-08-11', undatable: false,
      measured: fold({ calls: 1, saved: 1.20 }), estimated: fold({ calls: 1, saved: 0.20 }),
      events: { measured: 1, estimated: 1 } },
  ]);
  const groups = trendGroups(html);
  assert.match(barTitle(groups[0].slots[0]), /measured: \$0\.00 over 2 calls/,
    'a measured zero was suppressed instead of stated');
  assert.ok(!/class="tb nodata"/.test(groups[0].slots[0]),
    'a measured zero was labelled as an absent measurement');
  assert.match(groups[0].slots[1], /class="tb estimated neg"/,
    'a negative estimated figure lost its negative marking');
  assert.match(barTitle(groups[0].slots[1]), /-\$0\.40/, 'a negative lost its sign');
  assert.strictEqual(barHeight(groups[0].slots[1]), 100,
    'the only estimated magnitude on the series is not full height on its own axis');
});

// ---------------------------------------------------------------------------
// renderPop — the same rules, one panel up.
// ---------------------------------------------------------------------------

// current: both bases, different values. previous: dollars SUPPRESSED — the accumulators
// survive with exact counts and null money, exactly as store.js::withheld() leaves them.
const POP_PAYLOAD = {
  comparisons: {
    month: {
      period: 'month',
      current: { status: 'ok',
                 measured: fold({ calls: 3, saved: 2.88 }),
                 estimated: fold({ calls: 1, saved: 0.12 }),
                 events: { measured: 3, estimated: 1 } },
      previous: { status: 'suppressed', dollars_suppressed: true,
                  measured: fold({ calls: 5, saved: null, spent: null }),
                  estimated: fold({ calls: 2, saved: null, spent: null }),
                  events: { measured: 5, estimated: 2 },
                  notes: ['5 of 7 call(s) in this window are not in the price catalog.'] },
    },
    week: {
      period: 'week',
      // NOT COVERED — Cheaper was not watching. Both accumulators are null.
      current: { status: 'not_covered', measured: null, estimated: null,
                 notes: ['Cheaper was not watching during this period.'] },
      // ABSENT on one basis only.
      previous: { status: 'ok', measured: fold({ calls: 2, saved: 1.50 }),
                  estimated: fold({ calls: 0 }),
                  events: { measured: 2, estimated: 0 } },
    },
  },
};

function popRows(html) {
  return String(html).split('<div class="pop-row">').slice(1)
    .map((r) => r.slice(0, r.indexOf('</div>') + 6));
}

test('dashboard.html: renderPop prints no count its own caption contradicts', () => {
  const html = popDriver()(POP_PAYLOAD);
  const rows = popRows(html);
  assert.strictEqual(rows.length, 4, 'renderPop did not emit two rows per comparison');

  // THE REGRESSION: "n=4" for 3 measured + 1 estimated calls, rendered directly above the
  // card's own "measured / estimated — never summed" caption.
  assert.ok(!/n=4\b/.test(text(html)),
    'renderPop printed n=4 — 3 measured calls added to 1 estimated call');
  assert.ok(!/n=7\b/.test(text(html)),
    'renderPop printed n=7 — 5 measured calls added to 2 estimated calls');
  assert.match(text(rows[0]), /n=3 \| 1/,
    'the two bases no longer carry their own counts');
  assert.match(text(rows[1]), /n=5 \| 2/,
    'the suppressed window lost the counts that were never in doubt');
  // The caption it must agree with is still on the card.
  assert.match(text(html), /measured \/ estimated .* never summed/,
    'the card lost the caption the count has to be consistent with');

  // …and the dollars are still two figures, never their sum.
  assert.ok(!/\$3\.00/.test(html),
    'renderPop printed $3.00 — measured $2.88 added to estimated $0.12');
  assert.match(text(rows[0]), /\$2\.88/, 'the measured figure was lost');
  assert.match(text(rows[0]), /\$0\.12/, 'the estimated figure was lost');
});

test('dashboard.html: renderPop gives not-covered, withheld and absent three DIFFERENT labels', () => {
  const html = popDriver()(POP_PAYLOAD);
  const rows = popRows(html);

  // WITHHELD — the previous month. THE SECOND HALF OF THE REGRESSION: the old reader
  // returned null for `status === 'suppressed'` on both bases and the caller then printed
  // "not covered", asserting Cheaper was not watching a window it WAS watching and simply
  // could not price. The terminal renderer prints "withheld" for this window.
  assert.match(rows[1], /class="unpriceable"[^>]*>withheld</,
    'a withheld window is not labelled "withheld"');
  assert.ok(!/not covered/.test(rows[1]),
    'a window whose DOLLARS were withheld is claiming Cheaper was not watching');
  assert.ok(!/\$0\.00/.test(rows[1]), 'a withheld figure printed a measured $0.00');

  // NOT COVERED — this week. Its own label, and it may not borrow the withheld one.
  assert.match(rows[2], /class="notcovered"[^>]*>not covered</,
    'a not-covered window is not labelled "not covered"');
  assert.ok(!/withheld/.test(rows[2]),
    'a window Cheaper was not watching is claiming its dollars were merely withheld');
  // An absent accumulator is a labelled non-number on BOTH sides, never n=0.
  assert.match(text(rows[2]), /n=&mdash; \| &mdash;|n=— \| —/,
    'a not-covered window fabricated a measured call count');

  // ABSENT FIGURE — last week has measured rows and no priced estimated ones, so no
  // estimated figure was derived. A third label again.
  assert.match(rows[3], /class="muted" title="estimated"><span class="nodata">&mdash;/,
    'a basis with no figure is not a labelled non-number');
  assert.ok(!/withheld/.test(rows[3]) && !/not covered/.test(rows[3]),
    'a basis with no figure borrowed the withheld or the not-covered claim');
  // …and its COUNT is still the real one. `foldRows`/`fold_rows` always return both
  // accumulators, so `calls: 0` on a covered window is a MEASURED zero — the window was
  // watched and no estimated rows occurred in it — while the dollar cell beside it is a
  // labelled non-number because no figure was derived. cli/src/reports.js splits the two
  // the same way for this same window (`pair` -> '—', `nPair` -> '0'), and the two
  // implementations may not diverge on it.
  assert.match(text(rows[3]), /n=2 \| 0$/,
    `the measured-zero count was suppressed: "${text(rows[3])}"`);

  // Three states, three DISTINCT renderings. Any two being equal is the defect.
  const labels = [text(rows[1]), text(rows[2]), text(rows[3])];
  assert.strictEqual(new Set(labels).size, 3,
    'withheld, not-covered and absent did not render three different claims: '
    + JSON.stringify(labels));
});

test('dashboard.html: renderPop labels a MISSING accumulator rather than counting it as 0', () => {
  // The fourth state, and the one `(w.measured && w.measured.calls) || 0` erased: a
  // payload that carries no accumulator at all for a basis. `n=0` there is an affirmative
  // measurement — "we watched and nothing happened" — for a basis nothing was reported
  // about. reportWindow() nulls BOTH accumulators on a not_covered or too_new window, and
  // a gateway one release out of step can omit one.
  const html = popDriver()({ comparisons: { month: {
    current: { status: 'ok', measured: fold({ calls: 2, saved: 1.10 }),
               events: { measured: 2 } },
    previous: { status: 'suppressed', measured: null, estimated: null,
                notes: ['This savings store was written by a newer Cheaper.'] },
  } } });
  const rows = popRows(html);
  assert.match(text(rows[0]), /n=2 \| &mdash;$/,
    `a missing accumulator was counted as a measured zero: "${text(rows[0])}"`);
  assert.ok(!/n=2 \| 0/.test(text(rows[0])),
    'a basis that reported nothing was rendered as a basis that measured zero');
  // A window with both accumulators nulled states nothing on either axis — and says so
  // twice rather than claiming a zero, exactly as cli/src/reports.js::pair/nPair do.
  assert.match(text(rows[1]), /n=&mdash; \| &mdash;$/,
    `a window with no accumulators fabricated a count: "${text(rows[1])}"`);
  assert.ok(!/\$0\.00/.test(rows[1]), 'a window with no accumulators printed $0.00');
});

test('dashboard.html: renderPop still states a MEASURED zero window', () => {
  // THE OVER-CORRECTION GUARD: "you genuinely saved nothing over 4 calls" is a real,
  // useful claim and must not be suppressed into a label.
  const html = popDriver()({ comparisons: { month: {
    current: { status: 'ok', measured: fold({ calls: 4, saved: 0 }),
               estimated: fold({ calls: 2, saved: 0 }),
               events: { measured: 4, estimated: 2 } },
    previous: null,
  } } });
  const rows = popRows(html);
  assert.match(text(rows[0]), /\$0\.00.*\$0\.00/, 'a measured zero window was suppressed');
  assert.ok(!/withheld/.test(rows[0]) && !/not covered/.test(rows[0]),
    'a measured zero was labelled as a claim that was never made');
  assert.match(text(rows[0]), /n=4 \| 2/, 'a measured zero window lost its real counts');
  // …and a comparison side that is genuinely absent stays a labelled non-number.
  assert.match(text(rows[1]), /&mdash;|—/, 'a missing comparison side fabricated a figure');
  assert.ok(!/\$0\.00/.test(rows[1]), 'a missing comparison side printed a measured $0.00');
});

// ---------------------------------------------------------------------------
// renderComposition — the double count the PREVIOUS fix created.
//
// `events` used to mean ROWS PRICED, so adding `unpriced_calls` to it was correct. It now
// means ROWS SEEN and already contains the unpriceable rows, and reporting.py states the
// contract verbatim: "unpriced_calls stays a SUBSET counter of events, not an addend to
// it". The addition survived the change of meaning, so every exclusion was counted twice
// — and the rendered cell contradicted both its OWN tooltip and the ladder's Events cell
// on the same screen.
// ---------------------------------------------------------------------------

// ONE measured llama-4-maverick row that could not be priced. `foldRows` puts it in
// `events` (rows seen) and in `unpriced_calls`, and NOT in the accumulator's `calls`
// (rows priced) — so the group's own true row count is 1.
const COMP_ALL_UNPRICEABLE = [
  { key: 'llama-4-maverick', grain: 'call',
    measured: fold({ calls: 0 }), estimated: fold({ calls: 0 }),
    events: { measured: 1, estimated: 0 }, unpriced_calls: 1,
    unpriced: { model_not_in_catalog: 1 } },
];
// FOUR rows grouped by base, two of them unpriceable. True row count 4; the old
// expression rendered 6.
const COMP_FOUR_ROWS = [
  { key: 'claude-opus-5', grain: 'call',
    measured: fold({ calls: 1, saved: 2.00 }), estimated: fold({ calls: 1, saved: 0.50 }),
    events: { measured: 2, estimated: 2 }, unpriced_calls: 2,
    unpriced: { model_not_in_catalog: 2 } },
];
// A clean group: nothing unpriced at all.
const COMP_CLEAN = [
  { key: 'claude-sonnet-4-6', grain: 'call',
    measured: fold({ calls: 3, saved: 1.25 }), estimated: fold({ calls: 2, saved: 0.40 }),
    events: { measured: 3, estimated: 2 }, unpriced_calls: 0 },
];
// A group whose DOLLARS were withheld — the counts are exact, the money is not claimed.
const COMP_WITHHELD = [
  { key: 'gpt-6-preview', grain: 'call',
    measured: fold({ calls: 2, saved: null, spent: null }), estimated: fold({ calls: 0 }),
    events: { measured: 2, estimated: 0 }, unpriced_calls: 0 },
];

// The count cell of the first (and only) data row.
function compCountCell(html) {
  const rows = String(html).split('<div class="comp-row">').slice(1);
  assert.strictEqual(rows.length, 1, 'renderComposition did not emit exactly one data row');
  const m = /<span class="c"[^>]*>([\s\S]*?)<\/span><\/div>/.exec(rows[0]);
  assert.ok(m, 'the composition row rendered no count cell');
  return { raw: m[1], text: text(m[1]), row: rows[0] };
}

test('dashboard.html: renderComposition counts every exclusion ONCE', () => {
  const render = compDriver();

  // ONE row seen, ONE of them unpriceable. The old expression rendered 2 — the row counted
  // as an event AND again as an exclusion — beside a tooltip reading "1 measured".
  const one = compCountCell(render(COMP_ALL_UNPRICEABLE));
  assert.match(one.text, /^1 \| 0/,
    `a one-row group rendered a count cell of "${one.text}" — its single row was counted `
    + 'both as an event and again as an exclusion');
  assert.ok(!/\b2\b/.test(one.text.replace(/\+\d+ unpriced/, '')),
    'the one-row group is still double-counting its own exclusion');

  // FOUR rows, TWO unpriceable. The old expression rendered 6.
  const four = compCountCell(render(COMP_FOUR_ROWS));
  assert.match(four.text, /^2 \| 2/,
    `a four-row group rendered a count cell of "${four.text}"; 2 measured and 2 estimated `
    + 'rows were seen, and the 2 unpriceable ones are already inside those figures');
  assert.ok(!/\b6\b/.test(four.text), 'the four-row group is still double-counting');

  // …and the two bases are not summed into one scalar either: 2 + 2 = 4 must not appear
  // as the cell's figure, and 3 + 2 = 5 must not appear for the clean group.
  assert.ok(!/^4\b/.test(four.text), 'the two bases were summed into one count');
  const clean = compCountCell(render(COMP_CLEAN));
  assert.match(clean.text, /^3 \| 2$/,
    `a clean group rendered "${clean.text}" instead of its two per-basis counts`);
  assert.ok(!/\b5\b/.test(clean.text),
    'the clean group summed 3 measured and 2 estimated rows into one population of 5');
});

test('dashboard.html: renderComposition keeps every exclusion VISIBLE after the double count is gone', () => {
  // THE OVER-CORRECTION GUARD. Removing the addend must not remove the disclosure: the
  // terminal prints the exclusion as its own prefixed figure (`+N unpriced`), and a
  // silently shrinking denominator is the defect the addend was added to prevent.
  const render = compDriver();
  const one = compCountCell(render(COMP_ALL_UNPRICEABLE));
  assert.match(one.raw, /class="unpriced">\+1 unpriced/,
    'the unpriced count disappeared with the addend — the exclusion is now invisible');
  const four = compCountCell(render(COMP_FOUR_ROWS));
  assert.match(four.raw, /class="unpriced">\+2 unpriced/,
    'the four-row group no longer discloses its two unpriceable rows');
  // The badge is a SEPARATE figure with its own prefix, never folded into the counts.
  assert.match(four.text, /^2 \| 2 \+2 unpriced$/,
    `the exclusion is not rendered as its own prefixed figure: "${four.text}"`);
  // A group with nothing unpriced claims no exclusion.
  const clean = compCountCell(render(COMP_CLEAN));
  assert.ok(!/unpriced/.test(clean.raw),
    'a group with no unpriceable rows is claiming an exclusion that did not happen');
});

test('dashboard.html: renderComposition never prints $0.00 for a group it declined to price', () => {
  const render = compDriver();
  // ALL rows unpriceable: no priced calls on either basis, so neither basis has a figure.
  // `money(num(g.measured.saved, 0))` printed a confident $0.00 here.
  const none = compCountCell(render(COMP_ALL_UNPRICEABLE));
  assert.ok(!/\$0\.00/.test(none.row),
    'a group with no priced rows printed a measured $0.00');
  // …and it is not ABSENT either. THIS ASSERTION USED TO DEMAND THE EM DASH, which is the
  // defect this fixture was built to expose and the test then locked in: one measured row
  // WAS seen (`events.measured: 1`) and was deliberately not priced. "No measured rows in
  // this group" is an affirmative falsehood about a group whose own `+1 unpriced` badge, on
  // the same rendered row, says a row was seen. Cheaper was watching; the dollars are
  // withheld.
  assert.match(none.row, /<span class="m"><span class="unpriceable"[^>]*>withheld</,
    'a group that saw a row and priced none of it must say so, not claim it was empty');
  // The basis that genuinely saw NOTHING (events.estimated: 0) is still ABSENT. If both
  // bases went withheld, the two claims would have been collapsed the other way.
  assert.match(none.row, /<span class="e muted"><span class="nodata">&mdash;/,
    'a basis with no rows at all borrowed the withheld label');

  // WITHHELD is not the same claim as ABSENT, and neither is $0.00.
  const w = compCountCell(render(COMP_WITHHELD));
  assert.match(w.row, /<span class="m"><span class="unpriceable"[^>]*>withheld</,
    'a group whose dollars were withheld is not labelled "withheld"');
  assert.match(w.row, /<span class="e muted"><span class="nodata">&mdash;/,
    'the absent basis of a withheld group borrowed the withheld label');
  assert.ok(!/\$0\.00/.test(w.row), 'a withheld group printed a measured $0.00');
  assert.match(w.text, /^2 \| 0$/,
    'suppressing a group\'s dollars also discarded its exact counts');

  // THE OVER-CORRECTION MIRROR: a real measured figure, including a real zero, survives.
  const real = compCountCell(render([{ key: 'k', measured: fold({ calls: 2, saved: 0 }),
    estimated: fold({ calls: 1, saved: -0.25 }),
    events: { measured: 2, estimated: 1 }, unpriced_calls: 0 }]));
  assert.match(real.row, /<span class="m">\$0\.00<\/span>/,
    'a measured zero group was suppressed instead of stated');
  assert.match(real.row, /<span class="e muted">-\$0\.25<\/span>/,
    'a negative group figure lost its sign');
});

// ---------------------------------------------------------------------------
// THE INVARIANT THAT ACTUALLY FAILED: cli/src/reports.js and dashboard.html implement the
// SAME reporting rules over the SAME payload, and `cheaper reports` reaches both (the
// no-flag default opens the browser tab; `--terminal` renders in the shell). Neither
// surface's own tests could see the drift — only a comparison can.
// ---------------------------------------------------------------------------
const { renderReport: renderTerminalReport } = require('../src/reports');

const { cell: savingsCell } = require('../src/savings');
const ESC = /\x1b\[[0-9;]*m/g;

function captureTerminal(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.log = real; }
  // Strip ANSI so the comparison is about the FIGURES, not about the colouring.
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

test('dashboard.html and cli/src/reports.js tell ONE story about one trend payload', () => {
  const terminal = captureTerminal(() => renderTerminalReport({
    source: 'local-store', tz: 'UTC', catalog: { as_of: '2026-08-01' },
    trend: TREND_PAYLOAD,
  }));
  const dash = trendDriver()(TREND_PAYLOAD);

  // Neither surface may state the cross-basis sum, and both must state the two figures.
  for (const [name, out] of [['terminal', terminal], ['dashboard', text(dash)]]) {
    assert.ok(!/\$3\.00/.test(out), `${name}: printed $3.00 — the two bases summed`);
  }
  for (const want of ['$2.88', '$0.12']) {
    assert.ok(terminal.includes(want), `the terminal lost ${want}`);
    assert.ok(dash.includes(want), `the dashboard lost ${want}`);
  }
  // The WITHHELD bucket carries the same word on both surfaces — this is the one that
  // rendered as a $0.05 measured zero on the dashboard while the terminal said "withheld".
  assert.ok(/withheld/.test(terminal), 'the terminal lost the withheld label');
  assert.ok(/withheld/.test(dash), 'the dashboard lost the withheld label');
  // …and so does the undated point.
  assert.ok(/not dated/.test(terminal), 'the terminal lost the undated point');
  assert.ok(/not dated/.test(text(dash)), 'the dashboard lost the undated point');
  assert.ok(/2 call\(s\)/.test(terminal) && /2 call\(s\)/.test(text(dash)),
    'the two surfaces disagree about how many rows landed on no day');
});

// ===========================================================================
// FOUR RENDERERS, ONE STORY.
//
// The defect this section exists to stop was ONE defect with one fix, and it shipped four
// times because it lives on four surfaces and each round fixed the surface it was handed
// while the mirrors went on telling a different story:
//
//   terminal ladder    cli/src/reports.js::pair          — a bare em dash for WITHHELD
//   dashboard ladder   dashboard.html::basisCell         — "No measured rows in this
//                                                          window" above its own note
//                                                          saying rows were seen
//   dashboard trend    dashboard.html::trendSaved        — "no measured rows in this
//                                                          bucket" on the tab whose ladder
//                                                          printed 2 events and 3 unpriced
//   printable report   report.html::groupCell/basisCell  — "No measured rows in this group.
//                                                          … a measured zero and an absent
//                                                          measurement are different
//                                                          claims" beside an events cell
//                                                          reading 2
//
// Every one of them decided between the three claims from `acc.calls` — ROWS PRICED — and
// `events` means ROWS SEEN, so a window that is 100% unpriceable has calls === 0 and every
// surface took the ABSENT branch.
//
// A per-surface test cannot see this. Only a comparison can, so these drive ALL FOUR real
// renderers over the SAME payloads and diff the STORY they tell.
//
// EVERY WITHHELD FIXTURE HERE USES calls: 0 — the shape the store actually emits for a
// fully-unpriceable window. A fixture with calls non-zero cannot reach the branch, which is
// exactly why the committed ones did not catch it.
// ===========================================================================

// dashboard.html's ladder needs three elements, not one, so it gets its own driver: the
// table body, the footer notes, and the heading note that carries the additivity claim.
function ladderDriver() {
  const js = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const els = {
    ladderBody: { innerHTML: '' }, ladderNotes: { innerHTML: '', textContent: '' },
    ladderHeadNote: { innerHTML: '' },
  };
  const doc = { getElementById(id) { return els[id] || null; } };
  const fns = REPORTS_BASE_FNS.concat(['basisCell', 'fmtLocal', 'renderLadder']);
  const drive = new Function('document',
    fns.map((n) => fnSource(js, n)).join('\n\n')
    + '\nreturn function(rep){ renderLadder(rep); };')(doc);
  return (rep) => {
    els.ladderBody.innerHTML = ''; els.ladderNotes.innerHTML = '';
    els.ladderHeadNote.innerHTML = '';
    drive(rep);
    return { body: els.ladderBody.innerHTML, notes: els.ladderNotes.innerHTML,
             head: els.ladderHeadNote.innerHTML,
             all: els.ladderBody.innerHTML + '\n' + els.ladderNotes.innerHTML
                  + '\n' + els.ladderHeadNote.innerHTML };
  };
}

// ONE window, in each of the three states, exactly as cli/src/peek/store.js and
// gateway/app/reporting.py emit them. These are the payloads the repro was taken over.
//
// WITHHELD: three calls on a model absent from model_prices.json. 100% of the window's
// tokens are unpriceable, so the dollars are declined and BOTH accumulators price nothing —
// `calls: 0` — while `events` records the two measured and one estimated rows that were
// plainly seen.
const WITHHELD_WINDOW = {
  key: 'today', label: 'Aug 12', status: 'suppressed', grain: 'call',
  bounds_label: '2026-08-12 00:00 → 2026-08-13 00:00 (UTC, UTC+00:00)',
  from: Date.UTC(2026, 7, 12), to: Date.UTC(2026, 7, 13),
  dollars_suppressed: true,
  measured: fold({ calls: 0, saved: null, spent: null, baseline: null }),
  estimated: fold({ calls: 0, saved: null, spent: null, baseline: null }),
  events: { measured: 2, estimated: 1 }, unpriced_calls: 3, unpricedCalls: 3,
  unpriced: { served_not_in_catalog: 3 }, labels: ['dollars_suppressed'],
  notes: ["100% of this window's tokens are not in the price catalog, so no dollar figure "
          + 'is claimed.'],
};
// NOT COVERED: Cheaper was not watching. No rows exist because none were recorded.
const NOT_COVERED_WINDOW = NOT_COVERED('week_earlier', 'Earlier this week',
  '2026-08-03 00:00 → 2026-08-07 00:00 (UTC, UTC+00:00)');
// ABSENT: covered, watched, and genuinely empty on the estimated basis — the mirror that
// stops "render everything as withheld" from satisfying the assertions above.
const ABSENT_WINDOW = {
  key: 'quarter_earlier', label: 'Earlier this quarter', status: 'ok', grain: 'call',
  bounds_label: '2026-07-01 00:00 → 2026-08-01 00:00 (UTC, UTC+00:00)',
  from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 7, 1), dollars_suppressed: false,
  measured: fold({ calls: 2, saved: 1.5, spent: 0.5, baseline: 2.0 }),
  estimated: fold({ calls: 0 }),
  events: { measured: 2, estimated: 0 }, unpriced_calls: 0, unpricedCalls: 0,
  unpriced: {}, labels: [], notes: [],
};
// The same three states as TREND points, over the same rows.
const THREE_STATE_TREND = [
  { bucket: '2026-08-12', grain: 'call', undatable: false,
    dollars_suppressed: true,
    measured: fold({ calls: 0, saved: null, spent: null }),
    estimated: fold({ calls: 0, saved: null, spent: null }),
    events: { measured: 2, estimated: 1 }, unpriced_calls: 3, unpricedCalls: 3 },
  { bucket: '2026-07-15', grain: 'call', undatable: false,
    measured: fold({ calls: 2, saved: 1.5 }), estimated: fold({ calls: 0 }),
    events: { measured: 2, estimated: 0 }, unpriced_calls: 0, unpricedCalls: 0 },
];

// The four renderers, over one report. Each returns the plain text a reader sees.
//
// Each surface is scoped to the CELLS that render these windows, not to the whole page.
// report.html also prints a summary card ("Windows withheld … 1 suppressed · 0 not
// covered"), a standing legend, and a footer describing the exclusion categories by name
// ("N withheld, not covered, or carried no measured rows"). All three name every label on
// purpose; a page-wide grep for "not covered" hits them and says nothing about what any
// CELL claimed. The defect is always a claim in a cell, so the readers below are the cells,
// and the footer prose is asserted separately where it is the thing under test.
function fourSurfaces(periods, trend) {
  const terminal = captureTerminal(() => renderTerminalReport({
    source: 'local-store', tz: 'UTC', catalog: { as_of: '2026-08-01' },
    periods, comparisons: null, breakdown: [], trend: trend || [],
  }));
  const dashLadder = ladderDriver()({ periods });
  const dashTrend = trend && trend.length ? trendDriver()(trend) : '';
  const printable = renderReport(withReport({ periods, trend: trend || [] }));
  // Raw, for the same reason: report.html's absent branch is noClaim(), which carries its
  // sentence in a title attribute that text() would delete.
  const pEl = (id) => String((printable.els[id] || {}).innerHTML || '');
  return {
    terminal,
    // The terminal ladder ROWS alone — the lines carrying a window label.
    //
    // Also learned from a control. The caveated heading ends "…Compare on events or tokens,
    // which are never withheld", so `assert.match(terminal, /withheld/)` passed off the
    // HEADING while every ladder row said the opposite: collapsing pair() back left this
    // test green. The same vacuity in three readers, found only because each collapse was
    // reintroduced one at a time and watched.
    terminalRows: terminal.split('\n')
      .filter((l) => periods.some((w) => l.indexOf(w.label) >= 0)).join('\n'),
    // …and its trend rows, which cli/src/reports.js::savedOf renders through a separate
    // path. Without this the terminal's ladder and its trend were not both covered, and
    // collapsing savedOf alone left this test green.
    terminalTrendRows: terminal.split('\n')
      .filter((l) => (trend || []).some((t) => l.indexOf(String(t.bucket)) >= 0)).join('\n'),
    // RAW, and scoped to the table BODY.
    //
    // Both of those were learned from a control. Stripping tags removes the `title`
    // attribute, and the ABSENT branch on both HTML surfaces puts its sentence THERE —
    // "No measured rows in this window" is a title, not body text — so a stripped reader
    // cannot see the falsehood at all. Including the footer notes was worse: the caveat
    // sentence ends "…events or tokens, which are never withheld", so `assert.match(out,
    // /withheld/)` passed off the FOOTER while every cell in the table said the opposite.
    // Reinstating the collapse in basisCell() left this test green until both were fixed.
    dashboardLadder: dashLadder.body,
    dashboardLadderRaw: dashLadder,
    // The trend is read RAW, not stripped: renderTrend puts each bucket's figure and its
    // per-basis call count in the bar's `title`, so text() — which removes tags — removes
    // every claim the trend makes. Stripping here would have made every assertion below
    // pass vacuously.
    dashboardTrend: String(dashTrend || ''),
    printableLadder: pEl('ladderBody'),
    printableLadderFoot: pEl('ladderFoot'),
    printableTrend: pEl('trend'),
    printableRaw: printable,
    // The FIFTH surface: `cheaper savings`, the other terminal renderer. It reads the same
    // windows and carried the same collapse, and the only test over that file drives run()
    // end to end over a real store, which never reaches a withheld window. ANSI stripped,
    // so the comparison is about the words and not the colouring.
    savingsCells: periods.map((w) => savingsCell(w).replace(ESC, '')).join('\n'),
  };
}

test('FOUR RENDERERS, ONE STORY: a 100%-unpriceable window says WITHHELD on every surface',
  () => {
    const s = fourSurfaces([WITHHELD_WINDOW], [THREE_STATE_TREND[0]]);
    const surfaces = [
      ['terminal ladder', s.terminalRows],
      ['terminal trend', s.terminalTrendRows],
      ['dashboard ladder', s.dashboardLadder],
      ['dashboard trend', s.dashboardTrend],
      ['printable ladder', s.printableLadder],
      ['printable trend', s.printableTrend],
      ['cheaper savings', s.savingsCells],
    ];
    for (const [name, out] of surfaces) {
      // 1. THE CLAIM. Rows were seen and their dollars were deliberately not claimed.
      assert.match(out, /withheld/,
        `${name}: a window whose dollars were withheld does not say so:\n${out}`);
      // 2. NOT a measured zero.
      assert.ok(!/\$0\.00/.test(out),
        `${name}: printed a measured $0.00 for a figure it declined to claim:\n${out}`);
      // 3. NOT "we weren't watching". Cheaper WAS watching; that is why there are events.
      assert.ok(!/not covered/.test(out),
        `${name}: claimed Cheaper was not watching a window it was watching:\n${out}`);
      // 4. NOT "there is nothing here". THE DEFECT: every surface reached this branch off
      //    `acc.calls === 0` and printed an affirmative falsehood about rows it counts
      //    two columns away.
      assert.ok(!/[Nn]o measured rows/.test(out) && !/[Nn]o estimated rows/.test(out),
        `${name}: claimed the window holds no rows, beside its own count of them:\n${out}`);
    }
    // 5. …and the counts, which are exact and were never in doubt, survive on the two
    //    surfaces that carry an events column. If suppression ate them, "withheld" would be
    //    indistinguishable from "empty" to a reader.
    //    Read off the CELLS, so a "2" that happens to fall inside a date label cannot
    //    stand in for the event column.
    assert.match(s.dashboardLadderRaw.body, /<td class="num"[^>]*>2<\/td>/,
      'the dashboard ladder discarded the exact measured event count');
    assert.match(s.dashboardLadderRaw.body, /<td class="num"[^>]*>1<\/td>/,
      'the dashboard ladder discarded the exact estimated event count');
    const pCells = (s.printableRaw.els.ladderBody.innerHTML.match(
      /<td class="num"[^>]*>\d+<\/td>/g) || []).map(text);
    assert.deepStrictEqual(pCells.slice(0, 2), ['2', '1'],
      'the printable report discarded the exact per-basis event counts');
    //    …and the dashboard trend keeps them in its tooltip, per basis, never summed.
    assert.match(s.dashboardTrend, /2 calls/,
      'the dashboard trend discarded the exact measured event count');
    assert.ok(!/3 calls/.test(s.dashboardTrend),
      'the dashboard trend added the two bases into one population of three');

    // 6. ONE ROW, ONE CLAIM. The terminal trend renders its FIGURE column and its BAR
    //    column through two different readers — pair() and savedOf() — so it can, and did,
    //    contradict itself inside a single line: collapsing savedOf alone printed
    //    "withheld │ withheld" beside "— │ —", the figures declining to price rows the bars
    //    said did not exist. The bar column may not carry the ABSENT marker on a row whose
    //    figures are withheld.
    assert.ok(!/—/.test(s.terminalTrendRows),
      'the terminal trend drew the ABSENT marker on a row it withheld:\n'
      + s.terminalTrendRows);
  });

// WITHHELD for `cache_state_indeterminate`, not for an ordinary catalog gap: three calls
// that switched the served model with no recorded cache read, so the counterfactual is
// unknown -- see cli/src/peek/derive.js::cacheStateIndeterminate and
// gateway/app/metrics.py::_cache_state_indeterminate for the shared rule both runtimes
// implement. `notes` is deliberately the SAME reason-blind sentence
// gateway/app/reporting.py::_suppression_note (and its cli/src/peek/store.js mirror)
// actually emit today -- the fixture is what the store really sends, not what it should
// send, so this test proves the RENDERER corrects the false claim rather than merely
// proving a hand-written fixture is honest.
const CACHE_INDETERMINATE_WINDOW = {
  key: 'yesterday', label: 'Aug 11', status: 'suppressed', grain: 'call',
  bounds_label: '2026-08-11 00:00 → 2026-08-12 00:00 (UTC, UTC+00:00)',
  from: Date.UTC(2026, 7, 11), to: Date.UTC(2026, 7, 12),
  dollars_suppressed: true,
  measured: fold({ calls: 0, saved: null, spent: null, baseline: null }),
  estimated: fold({ calls: 0, saved: null, spent: null, baseline: null }),
  events: { measured: 2, estimated: 1 }, unpriced_calls: 3, unpricedCalls: 3,
  unpriced: { cache_state_indeterminate: 3 }, labels: ['dollars_suppressed'],
  notes: ['3 of 3 call(s) in this window (100% of its tokens) are not in the price '
          + 'catalog, so no dollar figure is claimed. Call and token counts are exact.'],
};

test('FOUR RENDERERS, ONE STORY: a cache_state_indeterminate window never claims the '
  + 'model is not in the price catalog', () => {
    const s = fourSurfaces([CACHE_INDETERMINATE_WINDOW]);
    const surfaces = [
      ['terminal', s.terminal],
      ['dashboard ladder (raw, incl. titles + row-notes)', s.dashboardLadderRaw.all],
      ['printable ladder', s.printableLadder],
    ];
    for (const [name, out] of surfaces) {
      // 1. THE FALSE CLAIM must be gone. The model IS catalogued; only its counterfactual
      //    cache state is unknown. This is the whole point of the fix.
      assert.ok(!/not in the price catalog/.test(out),
        `${name}: still claims a catalogued model is not in the price catalog:\n${out}`);
      // 2. THE TRUE CLAIM must replace it: the model IS catalogued, and the mechanism
      //    (a model switch invalidating the prompt cache) is named, not just alluded to.
      assert.match(out, /IS in the price catalog/,
        `${name}: does not affirmatively say the model is catalogued:\n${out}`);
      assert.match(out, /invalidates the prompt cache/,
        `${name}: does not name the actual mechanism:\n${out}`);
      // 3. STILL WITHHELD. Invariant 4: an exclusion must be counted AND VISIBLE, so
      //    correcting the reason must not also make the row look like a real claim.
      assert.match(out, /withheld/,
        `${name}: correcting the reason accidentally dropped the withheld label:\n${out}`);
      assert.ok(!/\$0\.00/.test(out),
        `${name}: printed a measured $0.00 for a figure it declined to claim:\n${out}`);
    }
    // 4. The per-cell Logs tooltip voice (dashboard.html::auditCost / whyText) already
    //    reads "no figure claimed: cache state indeterminate" -- the corrected window note
    //    should read as the SAME family of explanation, not a contradicting one.
    assert.match(s.dashboardLadderRaw.all, /cache READ or a cache CREATE/,
      'the corrected note does not explain what is actually unknown (which side of the '
      + 'cache split the counterfactual would have paid)');
  });

test('FOUR RENDERERS, ONE STORY: not-covered and absent keep their own distinct claims',
  () => {
    // THE OVER-CORRECTION GUARD, and the reason the test above cannot be satisfied by
    // rendering everything as withheld. Three claims, three renderings, on every surface.
    const s = fourSurfaces([NOT_COVERED_WINDOW, ABSENT_WINDOW], [THREE_STATE_TREND[1]]);

    for (const [name, out] of [['terminal ladder', s.terminalRows],
                               ['dashboard ladder', s.dashboardLadder],
                               ['printable ladder', s.printableLadder],
                               ['cheaper savings', s.savingsCells]]) {
      // NOT COVERED is its own label on every surface…
      assert.match(out, /not covered/,
        `${name}: a window Cheaper was not watching lost its own claim:\n${out}`);
      // …and neither window here withholds anything, so the word may not appear.
      assert.ok(!/withheld/.test(out),
        `${name}: labelled a covered, priced window as withheld — the mirror defect:\n${out}`);
      // The MEASURED basis still states its real figure. A renderer that satisfied
      // everything above by printing nothing would be concealment of a new kind.
      assert.match(out, /\$1\.50/,
        `${name}: a real priced figure was suppressed:\n${out}`);
      // …and the ABSENT basis claims NOTHING. Never $0.00 — the whole point.
      assert.ok(!/\$0\.00/.test(out),
        `${name}: the estimated basis had no rows and was rendered as a measured zero:\n${out}`);
    }

    // The three TABULAR surfaces have a cell to fill for the absent basis, so they fill it
    // with a labelled non-number. `cheaper savings` is a one-line renderer with no fixed
    // columns and OMITS a basis that saw nothing, which states no claim at all — also
    // correct, and different. Asserting one shape on all four would have forced the compact
    // renderer to invent a column it does not have.
    for (const [name, out] of [['terminal ladder', s.terminalRows],
                               ['dashboard ladder', s.dashboardLadder],
                               ['printable ladder', s.printableLadder]]) {
      assert.match(out, /&mdash;|—/,
        `${name}: the estimated basis of the covered window claimed a figure:\n${out}`);
    }
    assert.ok(!/est\./.test(s.savingsCells),
      `cheaper savings named a basis that saw no rows:\n${s.savingsCells}`);

    // The trend point over the same covered rows agrees: a figure, and an absent sibling.
    assert.match(s.dashboardTrend, /\$1\.50/, 'the dashboard trend lost the real figure');
    assert.ok(!/withheld/.test(s.dashboardTrend),
      'the dashboard trend withheld a figure the ladder claimed');
  });

// ---------------------------------------------------------------------------
// THE COUNT COLUMN — the same defect, one column to the right.
//
// The money column on both period-over-period surfaces was taught to say WITHHELD from
// rows SEEN. The COUNT beside it went on reading `acc.calls` — rows PRICED — so a window
// that is 100% unpriceable rendered:
//
//   terminal   this month   withheld │ withheld        n=0 │ 0
//   dashboard  <span class="unpriceable">withheld</span> … <span class="n">n=0 | 0</span>
//   ladder     …the SAME rows, the SAME tab, through basisEvents(): 3 and 1
//
// Three contradictions in one screen: "withheld" asserts rows exist beside "n=0" asserting
// none do; the two panels disagree about one window; and the withheld window's count cell
// is byte-identical to a genuinely empty window's, so the column cannot tell "4 calls
// happened, none priceable" from "nothing happened".
//
// The payload comes from the REAL store, because the shape is the whole point: a
// fully-unpriceable window prices NOTHING, so `calls` is 0 on both bases while `events`
// records the four rows. Every committed fixture had `calls` non-zero and therefore could
// not reach the branch.
// ---------------------------------------------------------------------------
const peekStore = require('../src/peek/store');

const COUNT_FIXTURE = (() => {
  const row = (id, conf, hour) => ({
    v: 1, id: 'rid:' + id, rev: 1, w: 'cli', inst: 'aaaaaaaa',
    ts: Date.UTC(2026, 7, 12, hour, 0, 0), tzo: 0, pday: '2026-08-12',
    prov: 'transcript', usrc: 'body', conf,
    harness: 'claude-code', sessions: ['s1'], sess: 's1', sub: true,
    served: 'llama-4-maverick', req: null, base: 'claude-opus-5',
    bsrc: 'tx_session_ceiling', elig: true, ctier: 'haiku', cver: 3, reason: '',
    in: 10000, out: 10000, cr: 0, c5: 0, c1: 0, cu: 0,
    speed: null, svc: 'standard', status: 200,
  });
  const rows = [row('u1', 'measured', 12), row('u2', 'measured', 13),
                row('u3', 'measured', 14), row('u4', 'estimated', 15)];
  const state = { v: 1, coverage: [{ from: Date.UTC(2026, 0, 1), to: Date.UTC(2027, 0, 1) }] };
  const from = Date.UTC(2026, 7, 12), to = Date.UTC(2026, 7, 13);
  return {
    // WITHHELD: four rows seen, none priceable.
    current: peekStore.reportWindow(rows, from, to, { state }),
    // EMPTY: the day before — covered, watched, and nothing happened in it.
    previous: peekStore.reportWindow(rows, Date.UTC(2026, 7, 11), from, { state }),
  };
})();

test('THE COUNT COLUMN: a withheld window states rows SEEN on both period-over-period '
   + 'surfaces, and the ladder on the same tab agrees', () => {
  const { current, previous } = COUNT_FIXTURE;
  // THE SHAPE, pinned before anything is rendered over it.
  assert.strictEqual(current.measured.calls, 0, 'the fixture must price nothing');
  assert.strictEqual(current.estimated.calls, 0, 'the fixture must price nothing');
  assert.deepStrictEqual(current.events, { measured: 3, estimated: 1 });
  assert.strictEqual(current.dollars_suppressed, true);
  assert.deepStrictEqual(previous.events, { measured: 0, estimated: 0 });
  assert.strictEqual(previous.status, 'ok');

  const cmp = { comparisons: { month: { period: 'month', current, previous } } };
  const dash = popDriver()(cmp);
  const rows = popRows(dash);
  assert.strictEqual(rows.length, 2, 'renderPop did not emit two rows for one comparison');
  const terminal = captureTerminal(() => renderTerminalReport(Object.assign({
    source: 'local-store', tz: 'UTC', catalog: { as_of: '2026-08-01' },
    periods: [], breakdown: [], trend: [],
  }, cmp)));
  const termCur = terminal.split('\n').find((l) => l.includes('this month'));
  const termPrev = terminal.split('\n').find((l) => l.includes('vs last month'));
  assert.ok(termCur && termPrev, `the terminal must render both rows:\n${terminal}`);

  // 1. ONE ROW, ONE CLAIM — on BOTH surfaces. "withheld" and "n=0" cannot share a row.
  for (const [name, out] of [['dashboard renderPop', text(rows[0])],
                             ['terminal period-over-period', termCur]]) {
    assert.match(out, /withheld/, `${name}: the money column stopped withholding:\n${out}`);
    assert.match(out, /n=3 [│|] 1/,
      `${name}: a withheld window must state the rows it SAW, not the rows it priced:\n${out}`);
    assert.ok(!/n=0 [│|] 0/.test(out),
      `${name}: "withheld" beside "n=0 | 0" is one row making two contradictory claims:\n${out}`);
    assert.ok(!/n=4\b/.test(out),
      `${name}: n=4 is 3 measured events added to 1 estimated one:\n${out}`);
  }

  // 2. THE COLLAPSE. The withheld window and the genuinely empty one may not render the
  //    same count cell — that is the defect the money column had just been rid of.
  const nOf = (s) => (/n=.*$/.exec(s) || [''])[0];
  assert.notStrictEqual(nOf(text(rows[0])), nOf(text(rows[1])),
    'renderPop cannot distinguish "4 calls happened, none priceable" from "nothing '
    + 'happened": ' + nOf(text(rows[0])));
  assert.notStrictEqual(nOf(termCur), nOf(termPrev),
    'the terminal cannot distinguish a withheld window from an empty one: ' + nOf(termCur));

  // 3. THE MIRROR PANEL. renderLadder covers the SAME window on the SAME tab and reads
  //    basisEvents(); the pop card said n=0 | 0 while these cells said 3 and 1.
  const ladder = ladderDriver()({ periods: [Object.assign({ key: 'month', label: 'this month' },
    current)] });
  const cells = (ladder.body.match(/<td class="num"[^>]*>(\d+)<\/td>/g) || []).map(text);
  assert.deepStrictEqual(cells, ['3', '1'],
    `the ladder's own Events cells disagree with the pop card about one window: ${ladder.body}`);

  // 4. THE OVER-CORRECTION MIRROR. A covered window that genuinely saw nothing MEASURED
  //    zero and must still print 0 on both surfaces — labelling it would be the same
  //    defect wearing the opposite costume.
  assert.match(text(rows[1]), /n=0 \| 0$/,
    `renderPop labelled a measured zero: "${text(rows[1])}"`);
  assert.match(termPrev, /n=0 │ 0/, `the terminal labelled a measured zero: ${termPrev}`);
  assert.ok(!/withheld/.test(text(rows[1])) && !/withheld/.test(termPrev),
    'an empty window withholds nothing');
});

test('FOUR RENDERERS, ONE STORY: the ladder heading never asserts an additivity it lacks',
  () => {
    // cli/src/reports.js was taught to caveat its heading when any window withholds.
    // dashboard.html's heading was STATIC markup that always read "these add up to
    // lifetime", and renderLadder never rewrote it — so over one real fixture the visible
    // dollar column summed to 3.000000 beside a Lifetime row reading 3.060000, a difference
    // of 0.06 the heading denied.
    const ladder = ladderDriver();

    // CLEAN: nothing withholds, so the claim is true and is made.
    const clean = fourSurfaces([ABSENT_WINDOW]);
    assert.match(clean.dashboardLadderRaw.head, /these add up to lifetime/,
      'the dashboard dropped a true additivity claim');
    assert.ok(!/the dollar column does not/.test(clean.dashboardLadderRaw.all),
      'the dashboard caveated a column that does add up');
    assert.match(clean.terminal, /these ADD UP to lifetime/,
      'the terminal dropped a true additivity claim');

    // DIRTY: one window withholds, so neither surface may assert it.
    const dirty = fourSurfaces([ABSENT_WINDOW, WITHHELD_WINDOW]);
    assert.ok(!/these add up to lifetime/.test(dirty.dashboardLadderRaw.head),
      `the dashboard heading asserts an additivity the same table contradicts: `
      + dirty.dashboardLadderRaw.head);
    assert.match(dirty.dashboardLadderRaw.head, /the dollar column does not/,
      'the dashboard heading does not say WHICH column fails to add up');
    assert.match(dirty.dashboardLadderRaw.head, /COUNTS add up to lifetime/,
      'the caveat overreached into the counts, which ARE additive and never withheld');
    assert.ok(!/these ADD UP to lifetime/.test(dirty.terminal),
      'the terminal heading asserts an additivity the same screen contradicts');
    assert.match(dirty.terminal, /the dollar column does not/);

    // Both surfaces carry the SAME explanatory sentence, so a reader who sees one and then
    // the other is told the same thing about the same payload.
    for (const [name, out] of [['dashboard', dirty.dashboardLadderRaw.all],
                               ['terminal', dirty.terminal]]) {
      assert.match(out, /window\(s\) (above|below) withhold their dollars/,
        `${name}: the withheld windows are not explained at all:\n${out}`);
      assert.match(out, /still contribute to Lifetime, which is computed independently/,
        `${name}: the explanation does not say WHY the column cannot be made to sum`);
      assert.match(out, /Compare on events or tokens, which are never withheld/,
        `${name}: the explanation leaves the reader with no comparable figure`);
    }

    // report.html words its heading safely already — "these partition history" is a claim
    // about DISJOINTNESS, which survives suppression, not about additivity — and it carries
    // a per-basis contributed/excluded footer. Pinned so a later edit cannot quietly
    // upgrade it into the claim the other two surfaces just had to withdraw.
    const rep = renderReport(withReport({ periods: [ABSENT_WINDOW, WITHHELD_WINDOW] }));
    assert.ok(!/add up to lifetime/i.test(rep.out),
      'report.html acquired an unconditional additivity claim');
    assert.match(rep.els.ladderFoot.innerHTML,
      /<b>measured:<\/b>\s*1 of 2 window\(s\) contributed dollars; 1 /,
      'report.html no longer states per-basis what contributed and what was excluded');

    // …and the empty ladder does not leave a stale caveat on screen.
    assert.match(ladder({ periods: [] }).head, /these add up to lifetime/,
      'an emptied ladder kept the previous payload\'s caveat');
  });

test('THE PREDICATE ITSELF: three copies, one rule, textually identical', () => {
  // dashboard.html, report.html and cli/src/reports.js each carry a copy of claimState()
  // because an HTML page cannot import one. cli/src/savings.js imports the reports.js copy
  // and so cannot drift at all.
  //
  // Copies are how this defect survived four rounds: each agent fixed the copy it was
  // handed. So the copies are diffed here, and any edit to one that is not made to the
  // others fails THIS test rather than shipping and being found on a screen.
  const norm = (s) => s.replace(/\r/g, '').split('\n').map((l) => l.trim()).join('\n');
  const dashJs = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const repJs = scriptBlocks(readReport()).join('\n');
  const cliJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'reports.js'), 'utf8');

  const copies = {
    'dashboard.html': norm(fnSource(dashJs, 'claimState')),
    'report.html': norm(fnSource(repJs, 'claimState')),
    'cli/src/reports.js': norm(fnSource(cliJs, 'claimState')),
  };
  const names = Object.keys(copies);
  for (const n of names.slice(1)) {
    assert.strictEqual(copies[n], copies[names[0]],
      `the claimState() copy in ${n} has drifted from the one in ${names[0]}. `
      + 'Change them together or the surfaces go back to telling different stories.');
  }

  // The rule itself, stated once as a table, driven through the real exported function.
  // If the shape of the decision changes, this is the assertion that has to be argued with.
  const { claimState } = require('../src/reports');
  const cases = [
    ['not covered', { status: 'not_covered', measured: null }, 'measured', null, 'not_covered'],
    ['suppressed flag, rows seen', WITHHELD_WINDOW, 'measured', null, 'withheld'],
    ['suppressed flag, other basis also seen', WITHHELD_WINDOW, 'estimated', null, 'withheld'],
    ['null figure, rows seen, no flag',
      { measured: fold({ calls: 2, saved: null }), events: { measured: 2 } },
      'measured', null, 'withheld'],
    ['zero PRICED rows but rows seen',
      { measured: fold({ calls: 0, saved: 0 }), events: { measured: 1 }, unpriced_calls: 1 },
      'measured', 0, 'withheld'],
    ['no rows at all on this basis', ABSENT_WINDOW, 'estimated', 0, 'absent'],
    ['rows seen and priced', ABSENT_WINDOW, 'measured', 1.5, 'value'],
    ['a MEASURED zero is a real claim',
      { measured: fold({ calls: 3, saved: 0 }), events: { measured: 3 } },
      'measured', 0, 'value'],
    ['a NEGATIVE figure is a real claim',
      { measured: fold({ calls: 3, saved: -0.4 }), events: { measured: 3 } },
      'measured', -0.4, 'value'],
  ];
  for (const [why, o, side, v, want] of cases) {
    assert.strictEqual(claimState(o, side, v), want,
      `claimState disagrees about "${why}"`);
  }
});

test('SUPPRESSION NOTES: three copies, one rule, textually identical', () => {
  // Same drift-prevention shape as "THE PREDICATE ITSELF" above, for the sibling function
  // that decides WHAT a withheld window's note says rather than WHETHER it is withheld.
  const norm = (s) => s.replace(/\r/g, '').split('\n').map((l) => l.trim()).join('\n');
  const dashJs = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const repJs = scriptBlocks(readReport()).join('\n');
  const cliJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'reports.js'), 'utf8');

  const copies = {
    'dashboard.html': norm(fnSource(dashJs, 'suppressionNotes')),
    'report.html': norm(fnSource(repJs, 'suppressionNotes')),
    'cli/src/reports.js': norm(fnSource(cliJs, 'suppressionNotes')),
  };
  const names = Object.keys(copies);
  for (const n of names.slice(1)) {
    assert.strictEqual(copies[n], copies[names[0]],
      `the suppressionNotes() copy in ${n} has drifted from the one in ${names[0]}. `
      + 'Change them together or the surfaces go back to telling different stories.');
  }

  // The rule itself, driven through the real exported function. A window withheld for
  // `cache_state_indeterminate` must NOT repeat the store's generic "not in the price
  // catalog" sentence -- that model IS catalogued; only its counterfactual cache state is
  // unknown, because switching models invalidates the prompt cache and nothing recorded
  // says whether the baseline would have paid a cache READ or a cache CREATE.
  const { suppressionNotes } = require('../src/reports');
  const genericNote = '3 of 3 call(s) in this window (100% of its tokens) are not in the '
    + 'price catalog, so no dollar figure is claimed. Call and token counts are exact. '
    + 'Refresh with `cheaper update`.';

  // No `unpriced` breakdown at all (older payload shape): the note passes through
  // unchanged, exactly as it always has.
  assert.deepStrictEqual(
    suppressionNotes({ notes: [genericNote] }),
    [genericNote],
    'a payload with no `unpriced` breakdown must not have its note rewritten');

  // `unpriced` present but carries no cache_state_indeterminate rows: unchanged.
  assert.deepStrictEqual(
    suppressionNotes({ notes: [genericNote], unpriced: { served_not_in_catalog: 3 } }),
    [genericNote],
    'a window withheld for an ordinary catalog gap must keep the catalog sentence');

  // WHOLLY cache_state_indeterminate: the catalog sentence is not just imprecise, it is
  // FALSE (the model is catalogued), so it is REPLACED, not appended to.
  const wholly = suppressionNotes(
    { notes: [genericNote], unpriced: { cache_state_indeterminate: 3 } });
  assert.strictEqual(wholly.length, 1,
    'a wholly cache-state-indeterminate window must not keep the false catalog sentence '
    + 'alongside the corrected one');
  assert.ok(!/not in the price catalog/.test(wholly[0]),
    `the false catalog claim survived: ${wholly[0]}`);
  assert.match(wholly[0], /IS in the price catalog/,
    'the corrected note must affirmatively say the model IS catalogued');
  assert.match(wholly[0], /invalidates the prompt cache/,
    'the corrected note must name the actual mechanism (cache invalidated by a model switch)');
  assert.match(wholly[0], /cache READ or a cache CREATE/,
    'the corrected note must name the two possibilities nothing recorded distinguishes');

  // MIXED reasons: the catalog sentence is still true of the served_not_in_catalog rows,
  // so it stays; the cache-state-indeterminate rows get their OWN sentence rather than
  // being folded into a catalog claim that would be false of them.
  const mixed = suppressionNotes({
    notes: [genericNote],
    unpriced: { served_not_in_catalog: 2, cache_state_indeterminate: 1 },
  });
  assert.strictEqual(mixed.length, 2,
    'a mixed-reason window must carry both the (still-true) catalog note and the '
    + 'cache-state note, not collapse them into one');
  assert.strictEqual(mixed[0], genericNote,
    'the catalog sentence is still true of the uncatalogued subset and must survive');
  assert.ok(!/not in the price catalog/.test(mixed[1]),
    `the cache-state sentence must not itself repeat the false catalog claim: ${mixed[1]}`);
  assert.match(mixed[1], /^1 call /, 'the cache-state sentence must count only ITS subset');
});

// ===========================================================================
// ui-dash fixes: renderSpark theme color, print scroll-table reset, status
// aria-live, and report.html's money() sign character.
// ===========================================================================

// Drives dashboard.html's themeGreen()/hexToRgba()/renderSpark() together, with a
// stubbed getComputedStyle standing in for whatever --green the cascade actually
// resolved (light, dark, or an explicit override) — so the test can prove the chart
// FOLLOWS the cascade rather than pinning one hard-coded swatch.
// `durationLabel`, `measurementInfo` and `dollarsAreMeasured` are lifted because the chart
// is no longer a pure function of `timeseries.points`: it anchors its axis to a clock
// (seriesNow) and styles its series by the payload's measurement basis. A driver that
// omitted them would throw rather than assert, which is the failure mode varSource/fnSource
// exist to make loud.
const SPARK_FNS = ['num', 'esc', 'money', 'measuredValue', 'pageOrigin', 'durationLabel',
                   'bucketWidthLabel', 'bucketStamp', 'sparkTooFew',
                   'measurementInfo', 'dollarsAreMeasured',
                   'themeColor', 'themeGreen', 'hexToRgba',
                   'seriesNow', 'sparkSegments', 'renderSpark'];

// `clientWidth` is stubbed rather than left undefined: renderSpark() sizes its viewBox to
// the element's MEASURED width so one user unit is one CSS pixel (a stretched <text> is
// unreadable, which is why the old fixed 600-unit box could not simply grow to carry
// axis labels). Pinning it here makes every coordinate in the asserted output
// deterministic instead of depending on what a headless layout happened to report.
function sparkDriver(greenValue, clientWidth) {
  const js = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const wrap = { innerHTML: '', clientWidth: clientWidth === undefined ? 600 : clientWidth };
  const doc = {
    getElementById(id) { return id === 'sparkWrap' ? wrap : null; },
    documentElement: {},
  };
  // --amber is resolved too: an UNMEASURED series is drawn in it, and a stub that returned
  // '' would silently fall back to the hard-coded literal and make the cascade assertion
  // vacuous for exactly the branch that needs it most.
  const AMBER = '#fbbf24';
  const gcs = () => ({ getPropertyValue: (name) => (
    name === '--green' ? greenValue : name === '--amber' ? AMBER : '') });
  const drive = new Function('document', 'getComputedStyle',
    varSource(js, 'SPARK_H') + '\n'
    + varSource(js, 'SPARK_PAD') + '\n'
    + varSource(js, 'SPARK_MIN_POINTS') + '\n'
    + varSource(js, 'DOLLAR_BASES') + '\n'
    + SPARK_FNS.map((n) => fnSource(js, n)).join('\n\n')
    + '\nreturn function(data){ renderSpark(data); };'
  )(doc, gcs);
  return (data) => { wrap.innerHTML = ''; drive(data); return wrap.innerHTML; };
}

// A real /metrics timeseries. Every point carries its own `t` — an epoch-second bucket
// START, exactly as metrics.py::summary() emits it — because the chart now labels its own
// time axis from those instants. A fixture with `saved` and no `t` describes a payload
// this gateway does not produce, and it is the shape the chart is now required to REFUSE
// to plot (an axis it cannot date is an axis it must not draw).
const HOUR = 3600;
const T0 = 1754_500_000 - (1754_500_000 % HOUR);   // an arbitrary but exact hour boundary
// `timeseries.now` is supplied on every geometry fixture and pinned to the LAST bucket, so
// the axis ends exactly where the data does and these tests keep asserting the pre-existing
// no-gap geometry. Omitting it would make the chart anchor to the wall clock and every
// coordinate in this file would drift with the calendar — the gap behaviour gets its own
// fixtures below, where the distance from the last sample to `now` is the thing under test.
// `measurement.dollars_basis` is 'measured' for the same reason: the series is drawn in
// --green only when the payload says the dollars behind it were provider-reported, and a
// fixture that omitted the block would be styled 'unknown' and fail the colour assertions
// for a reason that has nothing to do with the cascade. `MEASURED` is the same
// provider-reported measurement block the money-baseline tests above already use.
const TS3 = { measurement: MEASURED, timeseries: { bucket_seconds: HOUR, now: T0 + 2 * HOUR, points: [
  { t: T0, saved: 1, spent: 0.5, calls: 3 },
  { t: T0 + HOUR, saved: 2, spent: 0.5, calls: 5 },
  { t: T0 + 2 * HOUR, saved: 1.5, spent: 0.5, calls: 2 },
] } };
// The same stamp renderSpark() is required to print for an hour bucket, computed with the
// platform's own formatter so the assertion is about WHICH INSTANT was labelled rather
// than about the runner's timezone.
const stampOf = (t) => new Date(t * 1000).toLocaleString('en-US',
  { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const svgTexts = (html) => (html.match(/<text\b[^>]*>([\s\S]*?)<\/text>/g) || [])
  .map((s) => text(s));

test('dashboard.html: renderSpark reads --green from the cascade instead of hard-coding the dark swatch', () => {
  const html = fs.readFileSync(DASHBOARD, 'utf8');
  // Regression pin: the old renderSpark() literally wrote the dark-theme literals into
  // the SVG markup, bypassing the --green custom property (and therefore every theme
  // selector) entirely. Neither literal may appear anywhere in the served file again.
  assert.ok(!/fill="rgba\(52,211,153,0\.15\)"/.test(html),
    'the spark area fill is hard-coded to the dark-theme green instead of reading --green');
  assert.ok(!/stroke="#34d399"/.test(html),
    'the spark line stroke is hard-coded to the dark-theme green instead of reading --green');

  // :root[data-theme="light"] --green.
  const svgLight = sparkDriver('#047857')(TS3);
  assert.match(svgLight, /stroke="#047857"/,
    'the line did not pick up the light-theme --green from the cascade');
  assert.match(svgLight, /fill="rgba\(4,120,87,0\.15\)"/,
    'the fill was not derived from the light-theme --green (04,78,57 in hex)');
  assert.ok(!/#34d399/.test(svgLight),
    'the dark-theme swatch leaked into a light-theme render — the fill and line would wash out together, not compensate for each other');

  // :root[data-theme="dark"] --green — same chart, different cascade value.
  const svgDark = sparkDriver('#34d399')(TS3);
  assert.match(svgDark, /stroke="#34d399"/);
  assert.match(svgDark, /fill="rgba\(52,211,153,0\.15\)"/);

  // The axis furniture must NOT be painted with the series colour — it is drawn from CSS
  // classes so it follows --muted/--line, and a gridline in the series green would read
  // as a second series.
  assert.match(svgDark, /class="grid"/, 'the chart lost its value gridline');
  assert.match(svgDark, /class="zero"/, 'the chart lost its zero baseline');
});

// ---------------------------------------------------------------------------
// ITEM (a): "SAVINGS OVER TIME" WAS A TRIANGLE WITH NO MEANING.
//
// The old chart was a bare <path> in a 600x90 box: no axis, no tick, no label, no
// baseline. On three points spanning two days it drew a mountain, and nothing on screen
// said what period it covered or what any height was worth. A shape with no scale is not
// a chart — it is decoration that looks like evidence, and a reader who acts on the slope
// is acting on nothing.
// ---------------------------------------------------------------------------

test('dashboard.html: the spark chart carries a dated time axis, a zero baseline, a max '
   + 'value and its bucket width', () => {
    const html = sparkDriver('#34d399')(TS3);
    const labels = svgTexts(html);

    // THE TIME AXIS. Both ends, stamped from the buckets' OWN instants and in the
    // reader's own timezone — not the epoch numbers, and not an unlabelled span.
    assert.ok(labels.includes(stampOf(T0)),
      `the first bucket is not labelled with its own date; axis text was ${JSON.stringify(labels)}`);
    assert.ok(labels.includes(stampOf(T0 + 2 * HOUR)),
      `the last bucket is not labelled with its own date; axis text was ${JSON.stringify(labels)}`);
    assert.notStrictEqual(stampOf(T0), stampOf(T0 + 2 * HOUR),
      'the fixture must span more than one label-resolution step, or this proves nothing');

    // THE VALUE AXIS. A max label and a zero baseline label, so a height converts to
    // money without guessing.
    assert.ok(labels.includes('$2.00'),
      `the peak value is not labelled; axis text was ${JSON.stringify(labels)}`);
    assert.ok(labels.includes('$0.00'),
      `the zero baseline is not labelled; axis text was ${JSON.stringify(labels)}`);

    // THE BUCKET WIDTH. The same three points are a quiet afternoon at one-minute
    // buckets and a quiet quarter at one-day buckets; without this the chart cannot be
    // read at all.
    assert.match(text(html), /Each point spans 1 hour/,
      'the chart does not state how wide one point is');
    assert.match(text(html), /3 points/, 'the chart does not state how many points it drew');
    assert.match(text(html), /local time/i,
      'the chart does not say the stamps are local, so a reader cannot place them');

    // …and the width is stated in the unit the payload actually used, not a hard-coded
    // "hour". A day-bucketed trend labelled "1 hour" is a wrong axis, not a rounding.
    const daily = sparkDriver('#34d399')({ measurement: MEASURED, timeseries: {
      bucket_seconds: 86400, now: T0 + 2 * 86400, points: [
        { t: T0, saved: 1, calls: 1 }, { t: T0 + 86400, saved: 2, calls: 1 },
        { t: T0 + 2 * 86400, saved: 3, calls: 1 }] } });
    assert.match(text(daily), /Each point spans 1 day/,
      'the caption hard-codes an interval instead of reading bucket_seconds');
  });

test('dashboard.html: two points is not a trend — the chart says so instead of drawing a '
   + 'shape', () => {
    const render = sparkDriver('#34d399');
    for (const n of [0, 1, 2]) {
      const pts = [];
      for (let i = 0; i < n; i++) pts.push({ t: T0 + i * HOUR, saved: 1 + i, calls: 2 });
      const html = render({ timeseries: { bucket_seconds: HOUR, points: pts } });
      assert.ok(!/<svg/.test(html),
        `${n} point(s) still drew a chart — a line through ${n} point(s) shows a direction `
        + 'that one interval cannot contain');
      if (n === 0) {
        // A blank panel under a heading that says "Savings over time" reads as "you saved
        // nothing over time". It must say what would put a series there.
        assert.match(text(html), /No routed traffic has been recorded yet/,
          'the empty chart does not say why it is empty');
        assert.match(html, /ANTHROPIC_BASE_URL/,
          'the empty chart does not say how to record a series');
      } else {
        assert.match(text(html), /not enough to draw a trend/,
          `${n} point(s): the panel does not say why it declined to draw`);
        assert.match(text(html), /two points is a line, not a direction/,
          `${n} point(s): the panel does not say what the threshold means`);
        // The buckets it DOES have are stated as figures. Refusing to draw is not a
        // licence to withhold the data.
        assert.match(text(html), new RegExp(stampOf(T0).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          `${n} point(s): the buckets it has were hidden rather than printed`);
        assert.match(text(html), /\$1\.00 saved/,
          `${n} point(s): the recorded figure was dropped`);
      }
    }
    // …and the threshold is exactly the one the page declares, not a number this test
    // decided on its own.
    assert.match(fs.readFileSync(DASHBOARD, 'utf8'), /var SPARK_MIN_POINTS = 3;/,
      'the minimum-points rule moved; this test is asserting a threshold the page no longer uses');
  });

test('dashboard.html: a NEGATIVE bucket is drawn below the zero line, never clamped to it', () => {
  // The old chart pinned `min = 0`, so a bucket where Cheaper spent MORE than the
  // baseline — a real, signed result the rest of this page goes to some length to
  // preserve — was drawn ON the baseline, indistinguishable from a bucket that saved
  // exactly nothing.
  const html = sparkDriver('#34d399')({ measurement: MEASURED, timeseries: {
    bucket_seconds: HOUR, now: T0 + 2 * HOUR, points: [
      { t: T0, saved: 2, calls: 1 },
      { t: T0 + HOUR, saved: -1, calls: 1 },
      { t: T0 + 2 * HOUR, saved: 1, calls: 1 }] } });
  const labels = svgTexts(html);
  assert.ok(labels.includes('-$1.00'),
    `the negative floor is not labelled on the value axis; got ${JSON.stringify(labels)}`);
  assert.match(text(html), /floor -\$1\.00/,
    'the caption does not state the negative floor');

  // Geometry: the zero baseline sits ABOVE the lowest plotted point, which is only true
  // if the negative was given room below it.
  const zeroY = Number(/<line class="zero"[^>]*\by1="([\d.]+)"/.exec(html)[1]);
  const ys = (html.match(/<circle class="dot"[^>]*\bcy="([\d.]+)"/g) || [])
    .map((s) => Number(/cy="([\d.]+)"/.exec(s)[1]));
  assert.strictEqual(ys.length, 3, 'the chart lost its per-bucket markers');
  // SVG y grows downward, so "below the baseline" is a LARGER y.
  assert.ok(Math.max.apply(null, ys) > zeroY,
    `no plotted point falls below the zero baseline (zero at y=${zeroY}, points at ${ys}) — `
    + 'the negative bucket was clamped');
});

test('dashboard.html: a bucket with no derivable figure is dropped and counted, never '
   + 'plotted at zero', () => {
    // The old code ran every point through num(p.saved, 0), which drew an ABSENT figure
    // ON the baseline — a measured $0.00 the payload never claimed, at full confidence
    // and with no label anywhere.
    const html = sparkDriver('#34d399')({ measurement: MEASURED, timeseries: {
      bucket_seconds: HOUR, now: T0 + 3 * HOUR, points: [
        { t: T0, saved: 1, calls: 1 },
        { t: T0 + HOUR, saved: null, calls: 1 },
        { t: T0 + 2 * HOUR, saved: 2, calls: 1 },
        { t: T0 + 3 * HOUR, saved: 3, calls: 1 }] } });
    const ys = (html.match(/<circle class="dot"/g) || []).length;
    assert.strictEqual(ys, 3, 'the unpriceable bucket was plotted as if it were a figure');
    assert.match(text(html), /1 bucket carried no derivable figure and is not plotted/,
      'the dropped bucket was dropped SILENTLY — a shrinking denominator nobody announces');
  });

// ---------------------------------------------------------------------------
// THE X AXIS WAS NOT A TIME AXIS.
//
// x was the ARRAY INDEX: `x0 + (i * (x1 - x0)) / (pts.length - 1)`. Because metrics.py
// emits a bucket only when a row lands in it, the array is dense while time is sparse —
// so a 13-hour hole rendered exactly as wide as a 1-hour step, and the two date labels
// underneath described a span the geometry did not honour. Worse: the series ended at the
// last row that happened to exist, so the panel rendered byte-identical on the day traffic
// stopped and every day after it. A dead gateway was pixel-indistinguishable from a busy
// one, forever.
// ---------------------------------------------------------------------------

const dotXs = (html) => (html.match(/<circle class="dot"[^>]*\bcx="([\d.]+)"/g) || [])
  .map((s) => Number(/cx="([\d.]+)"/.exec(s)[1]));

test('dashboard.html: the spark x axis is TIME, not array index — an unequal gap is drawn '
   + 'unequally', () => {
    // Three samples: one hour apart, then FOUR hours apart. Under the old index axis both
    // steps were identical widths; under a time axis the second must be 4x the first.
    const html = sparkDriver('#34d399')({ measurement: MEASURED, timeseries: {
      bucket_seconds: HOUR, now: T0 + 5 * HOUR, points: [
        { t: T0, saved: 1, calls: 1 },
        { t: T0 + HOUR, saved: 2, calls: 1 },
        { t: T0 + 5 * HOUR, saved: 3, calls: 1 }] } });
    const xs = dotXs(html);
    assert.strictEqual(xs.length, 3, 'the chart lost its per-bucket markers');
    const d1 = xs[1] - xs[0], d2 = xs[2] - xs[1];
    assert.ok(d1 > 0 && d2 > 0, `markers are not left-to-right in time: ${xs}`);
    assert.ok(Math.abs(d2 / d1 - 4) < 0.05,
      `a 4-hour gap was drawn ${(d2 / d1).toFixed(2)}x a 1-hour gap, not 4x — x is still an `
      + `ordinal index rather than an instant (markers at ${xs})`);
  });

test('dashboard.html: the spark axis is anchored to NOW, so silence is visible instead of '
   + 'invisible', () => {
    // The exact live shape that prompted this: samples stop, the gateway keeps running,
    // and five hours pass with nothing recorded.
    const stale = { measurement: MEASURED, timeseries: {
      bucket_seconds: HOUR, now: T0 + 7 * HOUR, points: [
        { t: T0, saved: 1, calls: 1 },
        { t: T0 + HOUR, saved: 2, calls: 1 },
        { t: T0 + 2 * HOUR, saved: 3, calls: 1 }] } };
    const html = sparkDriver('#34d399')(stale);

    // The unobserved stretch is DRAWN, and drawn as absence.
    assert.match(html, /class="nodata-band"/,
      'five hours of silence left no mark on the chart — the panel is byte-identical to a live one');
    assert.match(html, /class="nodata-rule"/,
      'nothing marks WHERE observation stopped, so the reader must infer it from where the ink runs out');
    assert.match(text(html), /no traffic for 5h/,
      'the gap is drawn but not named, so its size has to be estimated off the axis');

    // …and it is absence, NOT a value. Not one marker, and no stroke, inside the band.
    const gapX = Number(/<line class="nodata-rule"[^>]*\bx1="([\d.]+)"/.exec(html)[1]);
    const xs = dotXs(html);
    assert.strictEqual(xs.length, 3, 'the band invented markers for buckets that recorded nothing');
    assert.ok(Math.max.apply(null, xs) <= gapX + 0.5,
      `a marker (${xs}) sits inside the no-traffic band (starts at ${gapX}) — an unrecorded `
      + 'bucket is being plotted as if it carried a figure');

    // The caption must distinguish the two claims IN WORDS. "$0 saved" and "no calls
    // happened" are different statements and only one of them is a measurement.
    assert.match(text(html), /recorded no calls at all/,
      'the caption does not say the gap is unrecorded rather than zero');
    assert.match(text(html), /not the same as buckets that saved nothing/,
      'the caption does not distinguish an unrecorded bucket from a bucket that saved nothing');

    // The RIGHT-HAND axis label is now, not the last row that happens to exist.
    const labels = svgTexts(html);
    assert.ok(labels.includes(stampOf(T0 + 7 * HOUR)),
      `the axis does not run to the present; axis text was ${JSON.stringify(labels)}`);

    // Control: the same series with the clock at the last sample draws no band at all.
    const live = sparkDriver('#34d399')({ measurement: MEASURED, timeseries: {
      bucket_seconds: HOUR, now: T0 + 2 * HOUR, points: stale.timeseries.points } });
    assert.ok(!/class="nodata-band"/.test(live),
      'a series that runs up to the present still drew a no-traffic band');
  });

test('dashboard.html: the spark line BREAKS across buckets that were never recorded', () => {
  // Two runs of observation with a four-hour hole between them. One continuous stroke
  // across that hole asserts a trend through hours in which nothing was observed.
  const html = sparkDriver('#34d399')({ measurement: MEASURED, timeseries: {
    bucket_seconds: HOUR, now: T0 + 6 * HOUR, points: [
      { t: T0, saved: 1, calls: 1 },
      { t: T0 + HOUR, saved: 2, calls: 1 },
      { t: T0 + 5 * HOUR, saved: 3, calls: 1 },
      { t: T0 + 6 * HOUR, saved: 4, calls: 1 }] } });
  const strokes = (html.match(/<path class="series[^"]*"/g) || []).length;
  assert.strictEqual(strokes, 2,
    `the series was drawn as ${strokes} path(s); a hole in the middle of the data must cut `
    + 'the stroke, or the chart interpolates a trend through unobserved time');
  assert.match(text(html), /line breaks in 1 place/,
    'the break is drawn but never explained, so it reads as a rendering glitch');

  // A CONTIGUOUS series is still exactly one stroke — the break must be caused by the
  // hole, not by segmenting every point.
  const solid = sparkDriver('#34d399')(TS3);
  assert.strictEqual((solid.match(/<path class="series[^"]*"/g) || []).length, 1,
    'a gapless series was chopped into segments anyway');
});

// ---------------------------------------------------------------------------
// THE CHART DREW UNMEASURED DOLLARS AT FULL CONFIDENCE.
//
// renderSpark read only p.saved and p.t. It never consulted measurement.dollars_basis, so
// on the owner's own store — 94 rows, every one with usage_source NULL, dollars_basis
// "unmeasured", headline.saved null — it plotted $80.52, labelled the value axis with it
// and put it in the aria-label, directly beneath a banner explaining that the figure must
// not be quoted as measured. The page contradicted itself in two adjacent elements.
// ---------------------------------------------------------------------------

test('dashboard.html: an UNMEASURED series is visibly not a measurement', () => {
  const unmeasured = { measurement: { dollars_basis: 'unmeasured', priced_calls: 94,
                                      measured_calls: 0, unmeasured_calls: 94 },
                       timeseries: TS3.timeseries };
  const html = sparkDriver('#34d399')(unmeasured);

  assert.match(html, /class="series unmeasured"/,
    'the line carries no basis class, so a stylesheet cannot distinguish it from a measurement');
  assert.match(html, /stroke="#fbbf24"/,
    'an unmeasured series is drawn in the measured swatch — the chart asserts a confidence the payload denies');
  assert.ok(!/stroke="#34d399"/.test(html),
    'the measured green survived on a series the payload says was never measured');
  assert.match(text(html), /reconstructed/,
    'nothing in the caption says the figures were reconstructed rather than measured');
  assert.match(html, /aria-label="[^"]*not provider-measured/,
    'the accessible name still presents reconstructed dollars as measured');

  // A gateway that publishes NO measurement block cannot be presented as measured either:
  // "we do not know" is not "yes". This is the state every pre-upgrade gateway is in.
  const silent = sparkDriver('#34d399')({ timeseries: TS3.timeseries });
  assert.match(silent, /class="series unmeasured"/,
    'a gateway that reports no basis at all had its dollars promoted to measured');

  // Control: the measured payload keeps the plain class and the green.
  const html2 = sparkDriver('#34d399')(TS3);
  assert.match(html2, /class="series"/, 'a measured series lost its plain styling');
  assert.match(html2, /aria-label="[^"]*are provider-measured/,
    'a measured series does not say so in its accessible name');
});

test('dashboard.html: a clock running behind the newest row cannot push a sample off its '
   + 'own chart', () => {
    // seriesNow() prefers the GATEWAY's clock, but a payload without one falls back to the
    // browser's, and a skewed browser clock must never produce a right edge EARLIER than a
    // row that demonstrably exists — that would render a measured point outside the plot.
    const html = sparkDriver('#34d399')({ measurement: MEASURED, timeseries: {
      bucket_seconds: HOUR, now: T0 - 10 * HOUR, points: TS3.timeseries.points } });
    const xs = dotXs(html);
    const x1 = 600 - 14;      // W - SPARK_PAD.r, with sparkDriver's pinned clientWidth
    assert.strictEqual(xs.length, 3, 'the chart lost its markers under a backwards clock');
    assert.ok(Math.max.apply(null, xs) <= x1 + 0.5,
      `a marker at ${Math.max.apply(null, xs)} overhangs the plot area (ends at ${x1})`);
    assert.ok(!/class="nodata-band"/.test(html),
      'a backwards clock invented a no-traffic band out of negative elapsed time');
  });

test('dashboard.html: renderSpark prefers the GATEWAY clock over the browser clock', () => {
  const js = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const src = fnSource(js, 'seriesNow');
  // The order matters: every `ts` in `points` was stamped by the gateway's clock, so the
  // axis end has to come from that same clock or the gap is measured between two different
  // ones. Date.now() is the last resort, not the first.
  assert.ok(src.indexOf('series.now') < src.indexOf('Date.now'),
    'seriesNow() reaches for the browser clock before the gateway\'s own published one');
  assert.match(src, /newest_ts/,
    'seriesNow() has no fallback for a gateway that predates timeseries.now, so those '
    + 'gateways silently fall through to a browser clock that may be skewed against them');
});

test('dashboard.html: toggling the theme re-renders the spark chart, not only first paint', () => {
  const js = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const applyThemeSrc = fnSource(js, 'applyTheme');
  assert.match(applyThemeSrc, /renderSpark\(lastData\)/,
    'applyTheme() must re-render the spark chart on every toggle, or it strands the OLD theme\'s swatch after the CSS custom property has already moved on');

  // Drive applyTheme() for real, with renderSpark() replaced by a call-recorder — proving
  // the re-render actually fires (and doesn't fire before there is data to draw).
  let attr = null;
  const calls = [];
  const btn = { innerHTML: '', setAttribute() {} };
  const doc = {
    documentElement: {
      setAttribute(name, v) { if (name === 'data-theme') attr = v; },
      removeAttribute(name) { if (name === 'data-theme') attr = null; },
      getAttribute(name) { return name === 'data-theme' ? attr : null; },
    },
    getElementById(id) { return id === 'themeToggle' ? btn : null; },
  };
  const api = new Function('document', 'sparkCalls',
    fnSource(js, 'effectiveTheme') + '\n\n'
    + fnSource(js, 'paintThemeButton') + '\n\n'
    + applyThemeSrc + '\n\n'
    + 'var lastData = null;\n'
    // Stands in for the real renderSpark() (proven correct by the test above) so this
    // test is only about WHETHER and WHEN applyTheme() re-renders, not about color math.
    + 'function renderSpark(d){ sparkCalls.push(d); }\n'
    + '\nreturn { applyTheme: applyTheme, setLastData: function(d){ lastData = d; } };'
  )(doc, calls);

  // Before any metrics have loaded, lastData is null: initTheme() calls applyTheme() on
  // page load, and that must not crash trying to re-render a chart with nothing to draw.
  api.applyTheme('dark');
  assert.strictEqual(calls.length, 0,
    'a theme toggle before the first data push rendered a chart with no data, or crashed');

  api.setLastData({ timeseries: { points: [{ saved: 1 }, { saved: 2 }] } });
  api.applyTheme('light');
  assert.strictEqual(calls.length, 1,
    'toggling the theme after data has loaded must re-render the spark chart exactly once');
  assert.deepStrictEqual(calls[0], { timeseries: { points: [{ saved: 1 }, { saved: 2 }] } },
    'the re-render used stale or wrong data');
});

// ---------------------------------------------------------------------------
// ITEM (b): UNMEASURED DOLLARS WERE BEING PUBLISHED AS MEASURED.
//
// `usage_source` records HOW a row's token counts were obtained. 'body' means the
// PROVIDER reported them; anything else means they were inferred from the request, which
// is a guess about what was billed. On the database that produced this defect every one
// of 94 rows had usage_source NULL — the gateway's measured path had never fired once —
// and the page printed "SAVED $80.52 / SAVINGS 86.4%" in the same type it would have used
// for a figure read off an invoice.
//
// The contract is additive: metrics.summary() publishes a `measurement` block, and
// `dollars_basis` is "measured" ONLY when every priced row carried provider-reported
// usage. An ABSENT block is UNKNOWN, never measured — degrading the other way would make
// an un-upgraded gateway the one configuration that prints unqualified figures.
// ---------------------------------------------------------------------------

// Every basis that is NOT 'measured', including the two ways the block can fail to say
// anything useful. All five must render identically as far as the FIGURE is concerned:
// the reader's takeaway ("I cannot quote this") is the same in every one of them.
//
// The counts mirror the store this workstream was commissioned against: 94 rows, four of
// which produced output and carry the entire figure, and NONE of which carried
// provider-reported usage. Note zero_token_calls (the contract's name: in + out == 0) is
// 0 there and zero_output_calls is 90 — those probes each carry 2-13 INPUT tokens, so
// they are priced and round to $0.00 rather than being tokenless. The two counts are not
// interchangeable and the renderer must not treat them as if they were.
const UNMEASURED_CASES = [
  ['unmeasured', { measured_calls: 0, unmeasured_calls: 94, dollars_basis: 'unmeasured',
                   priced_calls: 4, zero_token_calls: 0,
                   examined_calls: 94, zero_output_calls: 90, output_bearing_calls: 4 }],
  ['mixed', { measured_calls: 2, unmeasured_calls: 92, dollars_basis: 'mixed',
              priced_calls: 4, zero_token_calls: 0,
              examined_calls: 94, zero_output_calls: 90, output_bearing_calls: 4 }],
  ['none', { measured_calls: 0, unmeasured_calls: 94, dollars_basis: 'none',
             priced_calls: 0, zero_token_calls: 94 }],
  // A gateway that publishes ONLY the five contract names — no `examined_calls`, no
  // `zero_output_calls`, no `headline`. Everything beyond the contract is optional and
  // the statement must still be correct, just shorter.
  ['the contract names and nothing else',
    { measured_calls: 0, unmeasured_calls: 94, dollars_basis: 'unmeasured',
      priced_calls: 4, zero_token_calls: 0 }],
  // An older gateway that predates the contract. This is the DEFAULT state of every
  // installed copy the day this ships, so it is the case that must not degrade to a
  // confident number.
  ['an ABSENT measurement block', null],
  // A block whose basis this build does not recognise — a newer gateway, or a typo.
  // Unrecognised is not a licence to assume the flattering reading.
  ['an unrecognised dollars_basis', { dollars_basis: 'probably', priced_calls: 4 }],
  // A block that is present but is not an object at all.
  ['a non-object measurement block', 'measured'],
];

const withBasis = (base, m) => (m === null ? base : Object.assign({ measurement: m }, base));

test('dashboard.html: a money headline whose dollars are not measured is qualified, on '
   + 'every card that shows one', () => {
    const cards = cardsDriver();
    const dims = dimDriver();
    const figures = { total: 9, dollars: { saved: 80.52, spent: 12.7, savings_pct: 86.4 },
                      baselines: { requested_default: 80.52, highest_tier: 90 } };

    for (const [why, m] of UNMEASURED_CASES) {
      const payload = withBasis(figures, m);
      // The three stat cards that carry a dollar or a percentage derived from these rows.
      for (const [i, name] of [[2, 'Saved'], [3, 'Spent'], [4, 'Savings %']]) {
        const c = statCard(cards(payload), i);
        assert.match(c.value, /^about /,
          `${why}: the ${name} card reads "${c.value}" — an unmeasured figure presented as `
          + 'a measured result');
        // The figure itself SURVIVES. Suppressing it would hide real spend; the fix is a
        // qualifier, not a redaction.
        assert.ok(!/nodata/.test(c.cls),
          `${why}: the ${name} card suppressed a figure it should have qualified`);
      }
      // …and the Money dim card, on both gateway-sourced baselines.
      for (const choice of ['requested_default', 'highest_tier']) {
        const d = moneyDim(dims(choice, payload, null));
        assert.match(d.value, /^about /,
          `${why}/${choice}: the Money headline reads "${d.value}"`);
        assert.match(d.card, /class="spent-sub"><span class="approx"/,
          `${why}/${choice}: the spend line is unqualified beside a qualified headline`);
      }
      // The qualifier explains itself where it stands, so it survives being screenshotted
      // away from the banner.
      assert.match(cards(payload), /<span class="approx" title="[^"]{20,}">about <\/span>/,
        `${why}: the "about" prefix carries no explanation`);
    }
  });

test('dashboard.html: a MEASURED basis leaves every figure unqualified', () => {
  // THE OVER-CORRECTION GUARD. Without it, "always qualify" would pass every assertion
  // above while making the qualifier meaningless — a page that says "about" over a
  // genuinely measured figure is understating a claim it can substantiate, and a reader
  // who sees it everywhere stops reading it anywhere.
  const cards = cardsDriver();
  const dims = dimDriver();
  const payload = { total: 9, measurement: MEASURED,
                    dollars: { saved: 80.52, spent: 12.7, savings_pct: 86.4 },
                    baselines: { requested_default: 80.52, highest_tier: 90 } };
  const html = cards(payload);
  assert.ok(!/approx/.test(html), 'a measured figure was qualified as "about"');
  assert.strictEqual(statCard(html, 2).value, '$80.52');
  assert.strictEqual(statCard(html, 3).value, '$12.70');
  assert.strictEqual(statCard(html, 4).value, '86.4%');
  const d = moneyDim(dims('requested_default', payload, null));
  assert.strictEqual(d.value, '$80.52');
  assert.ok(!/approx/.test(d.card), 'a measured spend line was qualified as "about"');
});

test('dashboard.html: the downgrade rate states the population it was computed over', () => {
  // 67.0% over 94 rows, 90 of which produced no completion at all, reads as "two thirds
  // of my work was routed cheaper" and is not that. metrics.py publishes the same rate
  // over calls that actually produced output BESIDE the existing key — it may not
  // redefine it, because the cross-runtime parity gates compare that one — so this card
  // states both and names each population.
  const render = cardsDriver();
  const html = render({ total: 94, downgrade_rate: 67.0, measurement: Object.assign(
    {}, UNMEASURED_CASES[0][1],
    { downgrade_rate_output_bearing: 25.0, output_bearing_calls: 4 }) });
  const card = statCard(html, 1);
  assert.strictEqual(card.value, '67.0%', 'the existing rate was redefined rather than framed');
  assert.match(text(card.card), /of every intercepted call/,
    'the headline rate does not name its own population');
  assert.match(text(card.card), /25\.0% over the 4 call\(s\) that produced output/,
    'the output-bearing rate is not stated beside it');

  // NULL, never 0.0, when nothing produced output: no population, no rate. "0.0% of
  // completed work was downgraded" is a claim about a population that does not exist.
  const none = render({ total: 94, downgrade_rate: 67.0, measurement: {
    dollars_basis: 'unmeasured', priced_calls: 0,
    downgrade_rate_output_bearing: null, output_bearing_calls: 0 } });
  const nc = statCard(none, 1);
  assert.ok(!/0\.0% over/.test(text(nc.card)),
    'a rate was fabricated for a population with no members');
  assert.match(text(nc.card), /no call produced output/,
    'the empty population is not labelled');

  // A gateway that publishes neither says nothing extra, rather than inventing a frame.
  const bare = render({ total: 94, downgrade_rate: 67.0 });
  assert.ok(!/produced output/.test(text(statCard(bare, 1).card)),
    'a population was described for a gateway that reported none');
});

test('dashboard.html: an ABSENT figure is never qualified — "about —" claims nothing', () => {
  // The qualifier attaches to a FIGURE. With no figure there is nothing for it to
  // qualify, and prefixing the em dash would turn a clean "no claim made" into a
  // half-claim.
  const cards = cardsDriver();
  const dims = dimDriver();
  const payload = withBasis({ total: 0 }, UNMEASURED_CASES[0][1]);
  for (const i of [2, 3, 4]) {
    const c = statCard(cards(payload), i);
    assert.strictEqual(c.value, '&mdash;', `card ${i}: an absent figure was given a value`);
    assert.ok(!/approx/.test(c.card), `card ${i}: an em dash was prefixed "about"`);
  }
  const d = moneyDim(dims('requested_default', payload, null));
  assert.strictEqual(d.value, '&mdash;');
  assert.ok(!/approx/.test(d.card), 'an absent Money headline was prefixed "about"');
});

// The page-level basis statement. ALWAYS rendered: a banner that appears only when
// something is wrong teaches a reader that its absence means nothing, and "this gateway
// reports no basis at all" is exactly the state that has to be visible.
const BASIS_FNS = ['num', 'esc', 'measuredValue', 'measurementInfo', 'renderBasisLine'];

function basisDriver() {
  const js = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const box = { innerHTML: '', className: '' };
  const doc = { getElementById(id) { return id === 'basisLine' ? box : null; } };
  const drive = new Function('document',
    varSource(js, 'DOLLAR_BASES') + '\n'
    + BASIS_FNS.map((n) => fnSource(js, n)).join('\n\n')
    + '\nreturn function(d){ renderBasisLine(d || {}); };')(doc);
  // A SNAPSHOT, not the live stub. Returning `box` itself hands every caller the same
  // mutable object, so `const a = render(x); const b = render(y);` leaves `a` and `b`
  // pointing at y's output — and an assertion written about the first payload silently
  // runs against the second.
  return (d) => {
    box.innerHTML = ''; box.className = '';
    drive(d);
    return { innerHTML: box.innerHTML, className: box.className };
  };
}

test('dashboard.html: the basis line states the basis on every payload, including none', () => {
  const render = basisDriver();

  const measured = render({ measurement: MEASURED });
  assert.match(text(measured.innerHTML), /^Measured\./,
    'a fully measured gateway is not told so');
  assert.match(measured.className, /\bok\b/, 'the measured state is styled as a warning');

  for (const [why, m] of UNMEASURED_CASES) {
    const el = render(withBasis({}, m));
    assert.ok(text(el.innerHTML).trim().length > 40,
      `${why}: the basis line rendered nothing — its whole point is that it is never blank`);
    assert.match(el.className, /\bwarn\b/, `${why}: an unmeasured basis is styled as fine`);
    assert.ok(!/^Measured\./.test(text(el.innerHTML)),
      `${why}: an unmeasured basis was announced as measured`);
  }

  // The counts are read three-state: an absent count is NOT a count of zero, and
  // "0 of 0 priced calls" would be a fabricated statement about a gateway that reported
  // neither number.
  const bare = render({ measurement: { dollars_basis: 'unmeasured' } });
  assert.ok(!/\b0 of 0\b/.test(text(bare.innerHTML)),
    'the basis line invented a count for a gateway that published none');

  // ITEM (b), second half: the Logs tab's wall of $0.00 is EXPLAINED rather than left to
  // look like a broken pricing path that someone then "fixes" by inventing a number.
  const zeros = render({ measurement: UNMEASURED_CASES[0][1] });
  assert.match(text(zeros.innerHTML), /90 of 94 recorded calls returned no output tokens/,
    'the zero-output rows are not explained anywhere, or lost their denominator');
  assert.match(text(zeros.innerHTML), /which is the correct figure for them/,
    'the zero-output explanation does not say the $0.00 is correct');
  // …and it is not asserted when the gateway did not report it.
  assert.ok(!/returned no output tokens/.test(text(bare.innerHTML)),
    'a zero-output claim was made for a gateway that published no such count');

  // THE TWO COUNTS ARE NOT INTERCHANGEABLE. `zero_token_calls` (the contract name) means
  // in + out == 0; `zero_output_calls` means a call that had input, WAS priced, and
  // rounds to $0.00. On the store this was commissioned against the first is 0 and the
  // second is 90, so a renderer that read the contract name would have printed nothing at
  // the exact moment the explanation was needed — and a renderer that printed the
  // contract count with the output wording would have described 90 priced calls as
  // tokenless.
  const tokenless = render({ measurement: { dollars_basis: 'unmeasured', priced_calls: 4,
                                            examined_calls: 94, zero_token_calls: 7 } });
  assert.match(text(tokenless.innerHTML), /7 of 94 recorded calls carried no tokens at all/,
    'the contract-name count is not stated when it is the only one published');
  assert.ok(!/returned no output tokens/.test(text(tokenless.innerHTML)),
    'a tokenless count was described as "returned no output tokens", which is a different '
    + 'and larger population');

  // THE GATEWAY'S OWN ACKNOWLEDGEMENT, verbatim. metrics.py calls it "the acknowledgement
  // a renderer MUST carry when it prints an unsubstantiated figure" and parametrises it
  // by exact counts; restating it here in different words is how the two halves of one
  // fix end up describing the same population two ways.
  const ACK = 'This figure is arithmetic over 4 priced call(s), none of which carried '
    + 'provider-reported usage.';
  const acked = render({ measurement: Object.assign({}, UNMEASURED_CASES[0][1],
    { headline: { saved: null, unsubstantiated_saved: 80.52,
                  withheld_reason: 'unmeasured_usage', acknowledgement: ACK } }) });
  assert.ok(text(acked.innerHTML).includes(ACK),
    'the gateway published an acknowledgement and the page did not print it');
  // …and it is ESCAPED. It is payload data, and the only string on this line that did not
  // originate in dashboard.html.
  const hostile = render({ measurement: { dollars_basis: 'unmeasured', priced_calls: 1,
    headline: { acknowledgement: '<img src=x onerror=alert(1)>' } } });
  assert.ok(!/<img/.test(hostile.innerHTML),
    'the acknowledgement was injected as markup instead of escaped');
});

// ---------------------------------------------------------------------------
// ITEM (d): "live" WAS A CLAIM ABOUT THE SOCKET, NOT ABOUT THE DATA.
//
// /ws re-pushes the whole summary every five seconds whether or not a call was routed, so
// a connection carrying nothing is frame-for-frame identical to one carrying live
// traffic. The green dot said "live" over a database whose newest row was 29 hours old.
// ---------------------------------------------------------------------------
const STATUS_FNS = ['num', 'measuredValue', 'durationLabel', 'freshnessInfo',
                    'statusState', 'paintStatus', 'setStatus'];

function statusDriver() {
  const js = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const classes = new Set();
  const dot = { classList: {
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
  } };
  // textContent is counted, not just stored: the wrapper is role="status"
  // aria-live="polite", so ASSIGNING it is what announces the change — and re-assigning
  // an identical string re-announces it, which the 15-second repaint would otherwise do
  // four times a minute to a screen-reader user.
  let announced = 0;
  let current = '';
  const label = {};
  Object.defineProperty(label, 'textContent', {
    get() { return current; },
    set(v) { current = v; announced++; },
  });
  const doc = { getElementById(id) {
    if (id === 'statusDot') return dot;
    if (id === 'statusText') return label;
    return null;
  } };
  const api = new Function('document',
    varSource(js, 'LIVE_WINDOW_S') + '\n'
    + varSource(js, 'wsTransport') + '\n'
    + 'var lastData = null;\n'
    + STATUS_FNS.map((n) => fnSource(js, n)).join('\n\n')
    + '\nreturn { setStatus: setStatus, repaint: paintStatus,'
    + '  push: function(d){ lastData = d; paintStatus(); } };')(doc);
  return {
    setStatus: api.setStatus,
    push: api.push,
    repaint: api.repaint,
    read: () => ({ classes: Array.from(classes).sort(), text: current, announced }),
  };
}

test('dashboard.html: the connection indicator tells live, connected-idle and '
   + 'disconnected apart', () => {
    const s = statusDriver();
    const now = Date.now() / 1000;

    // 1. DISCONNECTED — unchanged behaviour, and neither "on" nor "idle".
    s.setStatus(false, false);
    assert.strictEqual(s.read().text, 'connecting…');
    assert.deepStrictEqual(s.read().classes, []);
    s.setStatus(false, true);
    assert.strictEqual(s.read().text, 'reconnecting…');
    assert.deepStrictEqual(s.read().classes, []);

    // 2. LIVE — connected AND a row arrived inside the window. The only state entitled to
    //    the word.
    s.setStatus(true, false);
    s.push({ freshness: { newest_ts: now - 5, age_seconds: 5, live: true } });
    assert.strictEqual(s.read().text, 'live');
    assert.deepStrictEqual(s.read().classes, ['on']);

    // 3. CONNECTED, NOT RECEIVING — the state that used to be painted green. It must not
    //    say "live", it must say for HOW LONG, and it must not read as an outage either.
    // 104400s = 29 hours. durationLabel() rolls to days past 24h — deliberately the SAME
    // rounding the session list's "1d ago" uses, so the indicator and the row beneath it
    // cannot describe one instant two different ways.
    s.push({ freshness: { newest_ts: now - 104400, age_seconds: 104400, live: false } });
    const idle = s.read();
    assert.strictEqual(idle.text, 'connected — no traffic for 1d',
      `a 29-hour-old newest row reported "${idle.text}"`);
    assert.deepStrictEqual(idle.classes, ['idle']);
    assert.ok(!/\blive\b/.test(idle.text),
      'a connection that has delivered nothing for 29 hours still called itself live');
    // …and the duration is a real reading of the gap, not a fixed "a while": a two-hour
    // lull and a day-long one are different facts about whether anything is pointed here.
    s.push({ freshness: { newest_ts: now - 7200, age_seconds: 7200, live: false } });
    assert.strictEqual(s.read().text, 'connected — no traffic for 2h');

    // A socket that stays open cannot keep a stale "live" alive: the age is recomputed
    // against the local clock, so the gateway's own `live: true` is overruled once the
    // instant it points at falls outside the window. This is the wedged-socket case — no
    // close event ever fires, and the old indicator would have stayed green forever.
    s.push({ freshness: { newest_ts: now - 3600, age_seconds: 5, live: true } });
    assert.strictEqual(s.read().text, 'connected — no traffic for 1h',
      'a stale newest_ts was overridden by the payload’s own optimistic live flag');

    // 4. A gateway that has recorded nothing at all is not the same as one that has gone
    //    quiet, and saying "no traffic for 0s" would be nonsense.
    s.push({ freshness: { newest_ts: null, age_seconds: null, live: false } });
    assert.strictEqual(s.read().text, 'connected — nothing recorded yet');

    // …and the window `live` is judged against comes from the PAYLOAD when the gateway
    // publishes it, so this page cannot hold a second, drifting copy of that number.
    // A gateway with a 10-minute window keeps a 5-minute-old row live; the local
    // 120-second fallback would have called the same row stale.
    s.push({ freshness: { newest_ts: now - 300, age_seconds: 300, live: true,
                          window_seconds: 600 } });
    assert.strictEqual(s.read().text, 'live',
      'the page overruled the gateway’s own liveness window with its local fallback');
    s.push({ freshness: { newest_ts: now - 300, age_seconds: 300, live: true,
                          window_seconds: 60 } });
    assert.strictEqual(s.read().text, 'connected — no traffic for 5m',
      'a row outside the gateway’s OWN published window was still called live');

    // 5. A gateway that publishes no freshness block at all. "Connected" is the whole of
    //    what is known about it, and inferring "live" from a completed handshake is
    //    precisely the inference that produced this defect.
    s.push({});
    assert.strictEqual(s.read().text, 'connected — traffic unknown');
    assert.deepStrictEqual(s.read().classes, ['idle']);

    // …and the transport still wins: a dropped socket is a dropped socket whatever the
    // last payload said.
    s.setStatus(false, true);
    assert.strictEqual(s.read().text, 'reconnecting…');
  });

test('dashboard.html: the status live region announces a change and only a change', () => {
  const s = statusDriver();
  s.setStatus(true, false);
  s.push({ freshness: { newest_ts: Date.now() / 1000 - 5, live: true } });
  assert.strictEqual(s.read().text, 'live');
  const before = s.read().announced;
  // The 15-second repaint runs whether or not anything moved. Re-assigning the same
  // string re-announces it to a screen reader.
  s.repaint(); s.repaint(); s.repaint();
  assert.strictEqual(s.read().announced, before,
    'an unchanged status was re-announced — a screen-reader user hears it four times a minute');
  s.push({ freshness: { newest_ts: Date.now() / 1000 - 7200, live: false } });
  assert.strictEqual(s.read().announced, before + 1,
    'a real state change was NOT announced — the aria-live region is mutating nothing');
});

// ---------------------------------------------------------------------------
// ITEM (c): THE MONITOR CLAIMED TO WATCH THINGS IT CANNOT SEE.
//
// "Active sessions" showed "(no session id) / testclient / 1d ago" while two Claude
// Desktop threads were open on screen. Claude Desktop talks straight to
// api.anthropic.com; it never reaches this process, so its chats are not MISSING from
// this list, they are structurally outside it and no amount of waiting will change that.
//
// The defect is presentational and so is the fix. Inventing rows for chats the gateway
// cannot observe would be the same fabrication as inventing dollars for tokens nobody
// reported — a panel that says "we cannot see that" is the honest one.
// ---------------------------------------------------------------------------
const MONITOR_FNS = ['num', 'esc', 'money', 'truncate', 'pageOrigin', 'durationLabel',
                     'agoLabel', 'classifySurface', 'renderMonitor'];

function monitorDriver() {
  const js = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const sessions = { innerHTML: '' };
  const surfaces = { innerHTML: '' };
  const doc = { getElementById(id) {
    if (id === 'sessions') return sessions;
    if (id === 'surfaces') return surfaces;
    return null;
  } };
  const drive = new Function('document',
    varSource(js, 'SURFACES') + '\n'
    + varSource(js, 'ACTIVE_WINDOW_S') + '\n'
    + MONITOR_FNS.map((n) => fnSource(js, n)).join('\n\n')
    + '\nreturn function(rows){ renderMonitor(rows || []); };')(doc);
  return (rows) => { sessions.innerHTML = ''; drive(rows); return sessions.innerHTML; };
}

test('dashboard.html: the Monitor states the boundary of what it can observe', () => {
  const html = fs.readFileSync(DASHBOARD, 'utf8');
  // In the STATIC markup, not in an empty-state branch: the limit is true whether or not
  // the list has rows, and the non-empty case is when a reader is most likely to mistake
  // it for "every chat I have open".
  const panel = /<h2>Active sessions[\s\S]*?<div id="sessions">/.exec(html);
  assert.ok(panel, 'the Active sessions panel lost its heading or its list');
  const scope = panel[0];
  // Flattened: this copy is wrapped for readability in the source, so a phrase can span a
  // newline and several columns of indentation.
  const prose = text(scope).replace(/\s+/g, ' ');
  assert.match(scope, /class="scope-note"/,
    'the Active sessions panel makes no statement about what it can see');
  assert.match(prose, /routed through this gateway/i,
    'the panel does not say the list is limited to gateway-routed chats');
  assert.match(prose, /Claude Desktop/,
    'the panel does not name the client whose absence prompted this — a reader with two '
    + 'threads open needs to be told those threads are not eligible, not left to infer it');
  assert.match(prose, /api\.anthropic\.com/,
    'the panel does not name the endpoint a direct client uses');
  assert.match(scope, /ANTHROPIC_BASE_URL/,
    'the panel does not say how to make a client visible');
});

test('dashboard.html: an empty session list says why it is empty and what to do', () => {
  const render = monitorDriver();
  const html = render([]);
  // NOT "no sessions yet". The overwhelmingly likely reason is that every client on the
  // machine is still talking to the provider directly — a configuration, not a wait.
  assert.match(text(html), /No chat has been routed through this gateway/,
    'the empty state still reads as "nothing has happened yet"');
  assert.match(html, /export ANTHROPIC_BASE_URL=/,
    'the empty state does not carry the line that makes a client visible');
  assert.match(text(html), /cannot be listed here/,
    'the empty state does not say a direct client will NEVER appear, so a reader waits');
  assert.ok(!/no sessions yet/i.test(text(html)),
    'the ambiguous "no sessions yet" wording survived');
});

test('dashboard.html: a row with no session id says what that MEANS', () => {
  const render = monitorDriver();
  const now = Date.now() / 1000;
  const html = render([
    { session: '', source: 'testclient', ts: now - 90000, savings: 0, actual_cost: 0 },
    { session: '', source: 'testclient', ts: now - 90100, savings: 0, actual_cost: 0 },
  ]);
  // "(no session id)" stated the symptom and left the reader to guess the cause; the
  // guess is usually "the dashboard is broken". It is a fact about the CLIENT: it sent no
  // session header, which is also why every call from it folds into this one row.
  assert.ok(!/\(no session id\)/.test(text(html)),
    'the bare "(no session id)" placeholder survived');
  assert.match(text(html), /no session id/,
    'the row no longer says the session id is absent at all');
  assert.match(text(html), /client sent no session header/,
    'the row does not say WHY it has no session id');
  assert.match(html, /title="This client sent no session header[^"]*grouped into one row/,
    'the row does not explain that its call count spans every chat from that client');

  // NOTHING CURRENTLY ROUTING is its own fact. Without it a reader compares "2 threads on
  // screen" against "1 row, 1d ago" and concludes the panel is broken, when what it is
  // reporting is that no traffic has reached the gateway since then.
  assert.match(text(html), /Nothing is routing through the gateway right now/,
    'a list whose newest row is a day old does not say that nothing is live');
  assert.match(text(html), /1d ago/, 'the staleness note does not say how stale');

  // …and a genuinely live row does NOT get that banner, or the note would be noise.
  const live = render([{ session: 'sess-a', source: 'claude-code', ts: now - 5,
                         savings: 1, actual_cost: 0.5 }]);
  assert.ok(!/Nothing is routing/.test(text(live)),
    'a session seen five seconds ago was reported as "nothing is routing"');
  assert.match(live, /class="live-dot on"/, 'an active session lost its live marker');
});

test('dashboard.html: print resets the mobile scroll-table rules (table-wrap, min-width, scroll-fade, scrollhint)', () => {
  const html = fs.readFileSync(DASHBOARD, 'utf8');
  const m = /@media print\{([\s\S]*?)\n  \}/.exec(html);
  assert.ok(m, 'no @media print block found');
  const block = m[1];
  // Chrome's own printable width at default settings (~739px for Letter, ~717px for A4)
  // is under the 760px breakpoint that turns #logsTable and .ladder into fixed-width
  // horizontal scrollers with a right-edge fade and a swipe hint. Without a reset here,
  // that mobile layout — and a hint pointing at a gesture paper cannot perform — would
  // silently carry into the printed PDF. report.html resets the equivalent rules
  // (.scroller, table.ladder/table.wide min-width) for the same reason.
  assert.match(block, /\.table-wrap\{overflow-x:visible !important;\}/,
    'the table-wrap scroller is not reset to visible for print');
  assert.match(block, /table#logsTable,table\.ladder\{min-width:0 !important;\}/,
    'the register and ladder tables keep their mobile min-width in print');
  assert.match(block, /\.table-wrap::after\{content:none !important;\}/,
    'the right-edge scroll-fade still renders on a page that cannot be scrolled');
  assert.match(block, /\.scrollhint\{display:none !important;\}/,
    'the "swipe to see more" hint survives onto paper, where swiping does nothing');
});

test('dashboard.html: the status indicator has an aria-live region so connection state changes are announced', () => {
  const html = fs.readFileSync(DASHBOARD, 'utf8');
  // setStatus() mutates #statusText as the WebSocket connects/drops/reconnects; without
  // a live region that transition was never announced to a screen-reader user. "polite"
  // (not "assertive", unlike the auth wall) because startPolling() takes over the moment
  // the socket drops — the dashboard keeps updating on the fallback path, so a disconnect
  // here is a transport footnote, not "every figure on this page has stopped updating".
  assert.match(html, /<span class="status" role="status" aria-live="polite">/,
    'the topnav status indicator has no aria-live region');
  assert.match(html, /<span class="dot" id="statusDot"><\/span><span id="statusText">/,
    'the aria-live wrapper no longer contains #statusDot / #statusText — setStatus() would be mutating dead markup');
});

test('report.html: money() renders a negative with ASCII hyphen-minus, not U+2212', () => {
  const js = scriptBlocks(readReport()).join('\n');
  const moneySrc = fnSource(js, 'money');
  // U+2212 reads fine on screen but is not a digit or minus sign to Excel, Sheets or
  // Numbers: a reader who copy-pastes a negative figure out of the printed report gets a
  // cell that silently lands as TEXT instead of a number, with no error to flag the
  // paste. dashboard.html's money() and cli/src/reports.js both already use the ASCII
  // hyphen-minus ("-"); this pins report.html to the same, now-consistent, convention.
  //
  // stripComments() first: money()'s own docstring quotes the OLD U+2212 output as an
  // example of the bug it now fixes, so a raw substring check on the source (comments
  // included) would fail on the documentation, not the code.
  assert.ok(!stripComments(moneySrc).includes('−'),
    'money() still emits U+2212 (Unicode minus) instead of ASCII hyphen-minus');
  assert.match(stripComments(moneySrc), /neg \? '-' : ''/,
    'money() must build the sign from the ASCII hyphen-minus literal');

  // Execute the extracted function directly, so this is a check on what money() actually
  // RETURNS, not only on what its source looks like.
  const money = new Function(
    "function noClaim(why){ return '<span class=\"nodata\">&mdash;</span>'; }\n"
    + moneySrc + '\nreturn money;'
  )();
  const rendered = money(-12.5);
  assert.strictEqual(rendered, '-$12.50');
  assert.ok(!rendered.includes('−'), 'the rendered figure still contains U+2212');
});

test('report.html: every label a producer can emit has tooltip text, on both runtimes', () => {
  // chips() renders `LABEL_TEXT[l] || l`, so a slug with no entry still DRAWS — it just
  // silently degrades its tooltip to the raw slug ("dated by frozen day"), which states
  // the name of the caveat and none of its content. That is the one failure mode a chip
  // must not have: the chip exists precisely to explain why a figure is qualified.
  //
  // The two producers are read directly rather than restated as a literal list, because a
  // hand-copied list is the same drift this file exists to catch — the tenth slug would be
  // added to reporting.py and to nobody's copy of the vocabulary. Both runtimes are scanned
  // because the label vocabulary is shared: report.html is served from the Python side, but
  // `cheaper savings` renders peek/store.js's windows through the same names, and a slug
  // that appears on one side today is routinely mirrored to the other.
  const py = fs.readFileSync(path.join(APP, 'reporting.py'), 'utf8');
  const storeJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'peek', 'store.js'), 'utf8');

  const slugs = new Set();
  // `labels.append("x")` / `labels.push('x')`
  for (const m of py.matchAll(/labels\.append\(\s*["']([a-z_]+)["']\s*\)/g)) slugs.add(m[1]);
  for (const m of storeJs.matchAll(/labels\.push\(\s*["']([a-z_]+)["']\s*\)/g)) slugs.add(m[1]);
  // the early-return literals: `"labels": ["x"]` / `labels: ['x']`
  for (const src of [py, storeJs]) {
    for (const m of src.matchAll(/["']?labels["']?\s*:\s*\[([^\]]*)\]/g)) {
      for (const q of m[1].matchAll(/["']([a-z_]+)["']/g)) slugs.add(q[1]);
    }
  }

  // Guard the SCANNER, not just the map. If a refactor renames `labels.append`, the
  // regexes above quietly match nothing and this test passes over an empty set — a green
  // check proving only that it stopped looking.
  assert.ok(slugs.size >= 9,
    `the label scanner found only ${slugs.size} slug(s) (${[...slugs].join(', ')}); it has `
    + 'lost track of the producers rather than proven them covered');
  for (const known of ['not_covered', 'dollars_suppressed', 'state_unreadable',
                       'dated_by_frozen_day', 'store_newer_than_reader']) {
    assert.ok(slugs.has(known), `the scanner no longer sees the "${known}" producer`);
  }

  const mapSrc = /var LABEL_TEXT = \{([\s\S]*?)\n  \};/.exec(scriptBlocks(readReport()).join('\n'));
  assert.ok(mapSrc, 'report.html no longer declares a LABEL_TEXT map');
  const covered = new Set([...mapSrc[1].matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]));

  const missing = [...slugs].filter((s) => !covered.has(s)).sort();
  assert.deepStrictEqual(missing, [],
    `these labels can be emitted but have no LABEL_TEXT entry in report.html, so their `
    + `chip's tooltip falls back to the raw slug: ${missing.join(', ')}`);
});

test('report.html: every state that claims no figure is warned, and no warn slug is a typo', () => {
  // chips() paints `warn` on the states where NO FIGURE CAN BE CLAIMED, as distinct from the
  // states that merely QUALIFY one (partial_coverage, tombstoned, incomplete,
  // dated_by_frozen_day, provisional). Both directions of that list fail silently:
  //
  //   1. A no-figure state left OUT renders the page's strongest disclaimer as an aside.
  //      `state_unreadable` did exactly that — it declines to publish totals at all, and
  //      said so in the same weight as "these figures are provisional".
  //
  //   2. A slug MISSPELLED inside the list (`l === 'stat_unreadable'`) is a comparison that
  //      can never be true. Nothing throws, no chip is ever warned, and the tooltip gate
  //      above still passes, because the map lookup and the CSS class are independent reads.
  //      A test that restated the list as a literal would share the typo and prove nothing.
  //
  // So the expression is read back out of the source and checked against LABEL_TEXT, which
  // the gate above has already pinned to the producers. Comments are stripped first, so a
  // slug that only appears in prose above the expression cannot be counted as live code.
  const script = stripComments(scriptBlocks(readReport()).join('\n'));

  const warnSrc = /var warn = \(([\s\S]*?)\)\s*\?\s*' warn'\s*:\s*'';/.exec(script);
  assert.ok(warnSrc, 'report.html no longer declares the chips() warn expression');
  const warned = new Set([...warnSrc[1].matchAll(/l === '([a-z_]+)'/g)].map((m) => m[1]));

  // Guard the scanner itself, as the gate above does — but as a PURE VACUITY GUARD, with a
  // floor of one rather than of four. A floor set to the number of slugs this test also
  // asserts membership for would be doing two jobs at once, and the wrong one would win:
  // deleting `state_unreadable` from the expression drops the count to three, so the floor
  // fires FIRST and reports "the scanner has lost track of the expression" for a source that
  // the scanner in fact read perfectly. That misdirects the next maintainer to the regex
  // instead of to the deleted slug. Watched happening, then decoupled — the floor now only
  // catches an extraction that yielded nothing at all, and the named checks below carry the
  // semantics with messages that say what is actually wrong.
  assert.ok(warned.size >= 1,
    'the warn scanner extracted no slug at all from the chips() warn expression; its shape '
    + 'has changed and every assertion below would pass by vacuity');

  const mapSrc = /var LABEL_TEXT = \{([\s\S]*?)\n  \};/.exec(script);
  assert.ok(mapSrc, 'report.html no longer declares a LABEL_TEXT map');
  const covered = new Set([...mapSrc[1].matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]));

  const unknown = [...warned].filter((s) => !covered.has(s)).sort();
  assert.deepStrictEqual(unknown, [],
    `chips() warns on slug(s) that LABEL_TEXT does not define, so no producer emits them and `
    + `the comparison can never fire: ${unknown.join(', ')}`);

  for (const noFigure of ['not_covered', 'dollars_suppressed', 'store_newer_than_reader',
                          'state_unreadable']) {
    assert.ok(warned.has(noFigure),
      `"${noFigure}" tells the reader that no figure can be claimed for this window, but `
      + 'chips() renders it unemphasised, in the same weight as a mere qualification');
  }
});

// ===========================================================================
// THE PANES THAT FETCHED ONCE AND NEVER AGAIN.
//
// render() repaints every Dashboard pane on every /ws frame, and refreshMonitor() keeps the
// Monitor current. Reports and Logs were on NEITHER path: each fetched on the first switch to
// its tab and then never again for the life of the page. A dashboard left open on Reports
// showed whatever was true when it was opened, indefinitely, and nothing on screen said so.
//
// The fix reuses the push as an INVALIDATION SIGNAL rather than adding a second data channel,
// so these tests are about WHEN a refetch is issued — the panes themselves are stubbed.
// ===========================================================================

function invalidationDriver(opts) {
  opts = opts || {};
  const js = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const calls = { reports: [], logs: [] };
  const state = {
    tab: opts.tab || 'dashboard',
    loaded: opts.reportsLoaded !== false,
    cursors: opts.cursors || [],
    // The REAL loaders both begin `if (…loading) return;` and signal that refusal to nobody.
    // A driver whose stubs always accept cannot see a dropped invalidation, which is exactly
    // how the first version of this code shipped a signal it consumed without acting on.
    reportsLoading: !!opts.reportsLoading,
    logsLoading: !!opts.logsLoading,
    now: 1_000_000,
  };
  const api = new Function('calls', 'state',
    // Time is injected so the throttle can be tested without sleeping.
    'var Date = { now: function(){ return state.now; } };\n'
    + 'function currentTab(){ return state.tab; }\n'
    + 'var reportsState = { get loaded(){ return state.loaded; },\n'
    + '                     get loading(){ return state.reportsLoading; } };\n'
    + 'var logsCursorStack = state.cursors;\n'
    // refreshLogs reads a plain `logsLoading` binding, so it is synced from the mutable test
    // state on each push rather than being an accessor (a getter cannot be installed over a
    // `var` in this scope).
    + 'var logsLoading = false;\n'
    + 'function loadReports(force){ if (state.reportsLoading) return; calls.reports.push(force); }\n'
    + 'function loadLogs(cursor){ if (state.logsLoading) return; calls.logs.push(cursor); }\n'
    + fnSource(js, 'measuredValue') + '\n'
    + varSource(js, 'lastSeenNewest') + '\n'
    + varSource(js, 'reportsStale') + '\n'
    + varSource(js, 'logsStale') + '\n'
    + varSource(js, 'reportsLastFetch') + '\n'
    + varSource(js, 'logsLastFetch') + '\n'
    + varSource(js, 'REFETCH_THROTTLE_MS') + '\n'
    + fnSource(js, 'payloadNewest') + '\n'
    + fnSource(js, 'noteFreshness') + '\n'
    + fnSource(js, 'refreshReports') + '\n'
    + fnSource(js, 'refreshLogs') + '\n'
    + 'return { push: function(d){ logsLoading = state.logsLoading; noteFreshness(d); },\n'
    + '         stale: function(){ return reportsStale; },\n'
    + '         logsStale: function(){ return logsStale; },\n'
    + '         seen: function(){ return lastSeenNewest; } };'
  )(calls, state);
  return { api, calls, state };
}

// A /metrics payload carrying only the field the invalidation reads.
const fresh = (ts) => ({ freshness: { newest_ts: ts } });

test('dashboard.html: the FIRST push is a baseline, not an invalidation', () => {
  // Every pane has just loaded against this very payload. Treating the first frame as "new"
  // would fire a duplicate refetch of all three reports endpoints on page load.
  const d = invalidationDriver({ tab: 'reports' });
  d.api.push(fresh(1000));
  assert.deepEqual(d.calls.reports, [], 'the first frame triggered a refetch');
  assert.strictEqual(d.api.seen(), 1000, 'the first frame did not establish the baseline');
  assert.strictEqual(d.api.stale(), false);
});

test('dashboard.html: a new row refetches Reports when the tab is VISIBLE, and only marks it '
   + 'when hidden', () => {
    // Visible: refetch now, and it must FORCE — loadReports returns early on
    // `loaded && !force`, so a non-forced call would be a no-op and the pane would never move.
    const vis = invalidationDriver({ tab: 'reports' });
    vis.api.push(fresh(1000));
    vis.api.push(fresh(2000));
    assert.deepEqual(vis.calls.reports, [true],
      `visible Reports did not refetch exactly once with force=true (got ${JSON.stringify(vis.calls.reports)})`);
    assert.strictEqual(vis.api.stale(), false, 'the flag was not cleared by the refetch');

    // Hidden: record the fact, spend no requests. Reports is three heavy endpoints and
    // nobody is looking at it.
    const hid = invalidationDriver({ tab: 'dashboard' });
    hid.api.push(fresh(1000));
    hid.api.push(fresh(2000));
    assert.deepEqual(hid.calls.reports, [],
      'a hidden Reports tab issued requests nobody asked for');
    assert.strictEqual(hid.api.stale(), true,
      'a hidden Reports tab did not even RECORD that it is now out of date, so the tab '
      + 'switch has no way to know it must force past the `loaded` guard');
  });

test('dashboard.html: Reports refetch is throttled, so a burst of rows is not a burst of '
   + 'requests', () => {
    const d = invalidationDriver({ tab: 'reports' });
    d.api.push(fresh(1000));
    d.api.push(fresh(2000));                       // fetch #1
    d.state.now += 1000;
    d.api.push(fresh(3000));                       // inside the window — must not fetch
    assert.deepEqual(d.calls.reports, [true],
      'the throttle did not hold: three heavy endpoints re-ran for a row that arrived one second later');
    assert.strictEqual(d.api.stale(), true, 'a throttled arrival silently lost its staleness');

    // THE RETRY IS THE POINT. /ws re-pushes the SAME summary every five seconds, so an
    // edge-triggered design would never revisit that throttled row: `newest > lastSeenNewest`
    // is false forever after, and if traffic then stops, the pane stays stale for the life of
    // the page — the exact defect this code exists to remove. The refreshers are therefore
    // level-triggered, and an UNCHANGED payload must complete the deferred refetch.
    d.state.now += 20000;
    d.api.push(fresh(3000));                       // no new row, just a later frame
    assert.deepEqual(d.calls.reports, [true, true],
      'a throttled arrival was never retried — with no further rows, the Reports pane would '
      + 'show pre-arrival figures forever, which is what this whole change is about');
    assert.strictEqual(d.api.stale(), false, 'the retry did not clear the flag');
  });

test('dashboard.html: an invalidation that lands during an in-flight load is kept, not '
   + 'swallowed', () => {
    // Both real loaders open with `if (…loading) return;` and tell the caller nothing. The
    // first version of this code cleared the flag and armed the throttle BEFORE calling them,
    // so a row arriving during a load in flight was consumed without ever being acted on —
    // and since the next frames carry the same newest_ts, the pane never recovered.
    const r = invalidationDriver({ tab: 'reports', reportsLoading: true });
    r.api.push(fresh(1000));
    r.api.push(fresh(2000));
    assert.deepEqual(r.calls.reports, [], 'the stub accepted a load it should have refused');
    assert.strictEqual(r.api.stale(), true,
      'the invalidation was consumed by a load already in flight — that response predates the '
      + 'new row, so the flag must SURVIVE for the next frame to retry');
    // The load finishes; the very next frame — same payload, no new row — must pick it up.
    r.state.reportsLoading = false;
    r.state.now += 20000;
    r.api.push(fresh(2000));
    assert.deepEqual(r.calls.reports, [true], 'the kept invalidation was never acted on');

    // Logs has the identical shape against its own `logsLoading` guard.
    const l = invalidationDriver({ tab: 'logs', logsLoading: true });
    l.api.push(fresh(1000));
    l.api.push(fresh(2000));
    assert.deepEqual(l.calls.logs, []);
    assert.strictEqual(l.api.logsStale(), true, 'Logs dropped an invalidation mid-flight');
    l.state.logsLoading = false;
    l.state.now += 20000;
    l.api.push(fresh(2000));
    assert.deepEqual(l.calls.logs, [null], 'Logs never retried the kept invalidation');
  });

test('dashboard.html: a reader paged back into history KEEPS the pending invalidation', () => {
  // Declining to move them is right; forgetting that page 1 has new rows is not. Returning to
  // page 1 must not show a view frozen at whenever they paged away.
  const d = invalidationDriver({ tab: 'logs', cursors: ['cur-abc'] });
  d.api.push(fresh(1000));
  d.api.push(fresh(2000));
  assert.deepEqual(d.calls.logs, [], 'rows were replaced under a paged-back reader');
  assert.strictEqual(d.api.logsStale(), true,
    'the pending invalidation was dropped, so returning to page 1 would not refresh');
  d.state.cursors.length = 0;          // they page back to the newest page
  d.state.now += 20000;
  d.api.push(fresh(2000));
  assert.deepEqual(d.calls.logs, [null], 'page 1 did not pick up the rows that arrived while paged away');
});

test('dashboard.html: Logs auto-refreshes on page 1 and NEVER under a reader who has paged '
   + 'back', () => {
    const p1 = invalidationDriver({ tab: 'logs', cursors: [] });
    p1.api.push(fresh(1000));
    p1.api.push(fresh(2000));
    assert.deepEqual(p1.calls.logs, [null],
      `page 1 did not refresh from the newest page (got ${JSON.stringify(p1.calls.logs)})`);

    // Paged back into history. Swapping rows out from under that reader is worse than
    // showing them a page a few seconds old: their position is theirs, and nothing
    // announced it was about to move.
    const paged = invalidationDriver({ tab: 'logs', cursors: ['cur-abc'] });
    paged.api.push(fresh(1000));
    paged.api.push(fresh(2000));
    assert.deepEqual(paged.calls.logs, [],
      'rows were replaced under a reader who had paged into history');
  });

test('dashboard.html: invalidation fires only on a row that is genuinely NEWER', () => {
  const d = invalidationDriver({ tab: 'reports' });
  d.api.push(fresh(2000));
  d.api.push(fresh(2000));   // the same row, re-pushed every 5s by /ws
  d.api.push(fresh(1500));   // older — a clock stepping backwards is not new data
  assert.deepEqual(d.calls.reports, [],
    'an unchanged newest_ts re-triggered a refetch — /ws re-sends the whole summary every '
    + 'five seconds whether or not a row arrived, so this would refetch forever');
  assert.strictEqual(d.api.seen(), 2000, 'a backwards clock rewrote the baseline');
});

test('dashboard.html: a gateway that publishes no freshness block invalidates nothing', () => {
  // "We cannot tell" is not "there is something new" — the same three-state rule
  // measuredValue() exists to enforce, applied to the invalidation signal.
  const d = invalidationDriver({ tab: 'reports' });
  d.api.push({});
  d.api.push({ freshness: {} });
  d.api.push({ freshness: { newest_ts: null } });
  assert.deepEqual(d.calls.reports, [], 'an absent newest_ts was read as a new row');
  assert.strictEqual(d.api.seen(), null, 'an absent newest_ts became a baseline');
});

test('dashboard.html: Reports never refetches before its FIRST load', () => {
  // showTab owns the first load. Racing it here would run the same three requests twice on
  // the switch that opens the tab.
  const d = invalidationDriver({ tab: 'reports', reportsLoaded: false });
  d.api.push(fresh(1000));
  d.api.push(fresh(2000));
  assert.deepEqual(d.calls.reports, [], 'the invalidation raced showTab for the first load');
});

test('dashboard.html: render() invalidates, and showTab() forces past the loaded guard', () => {
  const js = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  // The push handler must actually call it, or every assertion above is about dead code.
  assert.match(fnSource(js, 'render'), /noteFreshness\(data\)/,
    'render() does not call noteFreshness(), so no /ws frame can ever invalidate a pane');
  // And the tab switch must consume the flag. `loaded` cannot distinguish "already fetched"
  // from "still current", so a non-forced load on a stale pane is a silent no-op.
  const showTab = fnSource(js, 'showTab');
  // Reports must DELEGATE, not hand-roll the decision. showTab clearing the flag itself is
  // what consumed invalidations that loadReports then declined; refreshReports is the one
  // place that clears it, and only once a load is certain to start.
  assert.match(showTab, /refreshReports\(/,
    'showTab() does not delegate to refreshReports(), so a row that arrived while Reports was '
    + 'hidden never reaches the pane');
  assert.ok(!/reportsStale\s*=\s*false/.test(showTab),
    'showTab() clears reportsStale itself — that consumes the signal even when loadReports '
    + 'declines on its own `loading` guard, which is the bug this delegation removes');
  assert.match(showTab, /reportsState\.loaded/,
    'showTab() no longer owns the FIRST load, so opening the tab shows an empty pane');
  // Logs consumes its flag only when the load it issues is actually page 1.
  assert.match(showTab, /logsCursorStack\.length === 0/,
    'showTab() consumes logsStale regardless of which page it lands on — a historical page '
    + 'says nothing about page 1');
});

// ===========================================================================
// counts.unpriced WAS COMPUTED AND SHOWN TO NOBODY.
//
// metrics.py has published five named reasons a row contributed nothing to any dollar
// figure — plus `unpriced_total`, `priced` and `examined` — since the pricing rewrite, and
// no surface rendered any of it. A reader whose saving looked implausibly small had no way
// to discover that (say) 40% of their calls named a model with no rate in the catalog.
// Each reason has a DIFFERENT remedy, which is why the total alone would not do.
// ===========================================================================

const UNPRICED_FNS = ['num', 'esc', 'measuredValue', 'themeColor', 'renderUnpriced'];

function unpricedDriver(cssVars) {
  const js = scriptBlocks(fs.readFileSync(DASHBOARD, 'utf8')).join('\n');
  const wrap = { innerHTML: '' };
  const doc = { getElementById(id) { return id === 'unpricedWrap' ? wrap : null; },
                documentElement: {} };
  const gcs = () => ({ getPropertyValue: (n) => (cssVars || {})[n] || '' });
  const drive = new Function('document', 'getComputedStyle',
    varSource(js, 'UNPRICED_REASONS') + '\n'
    + UNPRICED_FNS.map((n) => fnSource(js, n)).join('\n\n')
    + '\nreturn function(d){ renderUnpriced(d); };'
  )(doc, gcs);
  return (d) => { wrap.innerHTML = ''; drive(d); return wrap.innerHTML; };
}

const counts = (o) => ({ counts: Object.assign({ examined: 0, priced: 0, unpriced: {} }, o) });

test('dashboard.html: every unpriced reason is named, counted and given its remedy', () => {
  const html = unpricedDriver()(counts({
    examined: 100, priced: 60,
    unpriced: { estimated_usage: 20, non_2xx: 10, model_not_in_catalog: 7,
                undatable: 2, cache_state_indeterminate: 1 },
  }));
  const t = text(html);
  // Each reason appears with its own count — a lone total cannot be acted on, because the
  // five remedies are different.
  assert.match(t, /Token counts were estimated/, 'estimated_usage is not named');
  assert.match(t, /did not succeed/, 'non_2xx is not named');
  assert.match(t, /No published rate for that model/, 'model_not_in_catalog is not named');
  assert.match(t, /No derivable calendar day/, 'undatable is not named');
  assert.match(t, /Cache state unrecoverable/, 'cache_state_indeterminate is not named');
  // …and the one that is usually the reader's to fix says so.
  assert.match(t, /add the rate/,
    'the catalog gap does not tell the reader it is the actionable one');
  // The excluded total is stated as EXCLUDED, never as a zero contribution.
  assert.match(t, /40 of 100 examined calls contributed nothing/,
    `the excluded total is not stated; got: ${t.slice(0, 400)}`);
  assert.match(t, /excluded, not counted as zero/,
    'the panel does not distinguish an excluded row from a row that saved nothing');
  // One bar segment per non-zero reason, plus the priced segment.
  assert.strictEqual((html.match(/<i style="width:/g) || []).length, 6,
    'the bar does not carry one segment per population');
});

test('dashboard.html: a reason with no rows is omitted rather than drawn at zero', () => {
  const html = unpricedDriver()(counts({
    examined: 10, priced: 8, unpriced: { estimated_usage: 2, non_2xx: 0 },
  }));
  assert.ok(!/did not succeed/.test(text(html)),
    'a zero-count reason was listed, padding the legend with rows that describe nothing');
  assert.strictEqual((html.match(/<i style="width:/g) || []).length, 2,
    'a zero-width segment was emitted');
});

test('dashboard.html: a fully-priced window says so positively', () => {
  // "Nothing was excluded" is a real, reassuring result and must not render as an empty
  // panel that reads like a broken one.
  const t = text(unpricedDriver()(counts({ examined: 42, priced: 42, unpriced: {} })));
  assert.match(t, /Every one of the 42 examined calls could be priced/,
    `a clean window did not say so; got: ${t.slice(0, 300)}`);
});

test('dashboard.html: the unpriced panel reconciles, and SAYS SO when it cannot', () => {
  // metrics.py's own comment invites the reader to check priced + unpriced == examined.
  // Printing the check is what makes the panel falsifiable instead of decorative.
  const bad = text(unpricedDriver()(counts({
    examined: 100, priced: 60, unpriced: { estimated_usage: 5 },
  })));
  assert.match(bad, /do not reconcile/,
    'counts that cannot add up were rendered as though they did');
  assert.match(bad, /report it/, 'the mismatch does not tell the reader what to do');

  const good = text(unpricedDriver()(counts({
    examined: 10, priced: 7, unpriced: { non_2xx: 3 },
  })));
  assert.ok(!/do not reconcile/.test(good), 'a reconciling panel claimed it did not');
});

test('dashboard.html: an older gateway that reports no coverage is not read as full coverage', () => {
  // "This gateway does not report it" and "nothing was excluded" are different statements.
  const silent = text(unpricedDriver()({ counts: { intercepted: 5 } }));
  assert.match(silent, /does not report which calls could be priced/,
    'a gateway publishing no unpriced block was silently treated as fully priced');
  assert.match(silent, /cheaper gateway restart/, 'it does not say how to fix it');

  const empty = text(unpricedDriver()(counts({ examined: 0, priced: 0, unpriced: {} })));
  assert.match(empty, /No calls have been examined yet/,
    'an empty store rendered as a coverage claim rather than as "nothing yet"');
});

test('dashboard.html: a TRUNCATED summary says its proportions describe a sample', () => {
  const t = text(unpricedDriver()(counts({
    examined: 5000, priced: 4000, unpriced: { estimated_usage: 1000 }, truncated: true,
  })));
  assert.match(t, /This is a SAMPLE/,
    'a capped summary presented its proportions as though they covered the whole ledger');
});

test('dashboard.html: the unpriced swatches follow the cascade, not hard-coded hex', () => {
  // Same rule the sparkline learned: a presentation attribute cannot carry var(), so the
  // colour is resolved in JS — and it must be resolved FROM THE THEME.
  const html = unpricedDriver({ '--green': '#047857', '--amber': '#b45309' })(counts({
    examined: 10, priced: 8, unpriced: { estimated_usage: 2 },
  }));
  assert.match(html, /#047857/, 'the priced segment ignored the light-theme --green');
  assert.match(html, /#b45309/, 'the estimated segment ignored the light-theme --amber');
});

// ===========================================================================
// A STATIC REPORT THAT RE-DATED ITSELF EVERY TIME IT WAS OPENED.
//
// report.html embeds its data and never fetches — deliberately, so a print-to-PDF captures
// one consistent instant instead of a mid-fetch race. But its masthead stamped `new Date()`,
// the READER's clock. Save the file, reopen it next month, and it claims to have been
// generated next month while every figure beneath it is from the day it was made. Print it
// and the PDF carries that false date forever — and printing is what this page is for.
// ===========================================================================

test('report.html: the masthead dates the DATA, not the moment the file was opened', () => {
  const src = fs.readFileSync(REPORT, 'utf8');
  // The regression pin. `new Date()` may still appear as the last-resort branch, but it may
  // never be what the word "Generated" is built from.
  assert.ok(!/'Generated ' \+ esc\(gen\.toLocaleString\(\)\)/.test(src),
    'the masthead still stamps the reader\'s clock as the generation time');

  // Source of truth #1: the export payload's own instant, already trusted by Method &
  // provenance further down the same file.
  assert.match(src, /META\.generated_at_local \|\| META\.generated_at/,
    'the masthead ignores the export payload\'s own generation instant');
  // Source of truth #2: the gateway clock metrics.py stamps when it builds the summary —
  // what the plain /report route embeds, where META does not exist at all.
  assert.match(src, /D\.timeseries && typeof D\.timeseries\.now === 'number'/,
    'the masthead has no source for the /report route, where REP and therefore META are null');
  // …and when there is neither, it must RELABEL rather than dress the reader's clock up as
  // a generation time.
  assert.match(src, /genLabel = 'Opened'/,
    'with no recorded instant the page still calls the reader\'s clock "Generated"');
});

test('report.html: the gateway publishes an instant the report can date itself from', () => {
  // The masthead's fallback is only honest if the field actually exists on the /report
  // payload. metrics.py stamps it from the same clock every `ts` in the series carries.
  const metrics = fs.readFileSync(path.join(APP, 'metrics.py'), 'utf8');
  assert.match(metrics, /"now": round\(time\.time\(\), 3\)/,
    'metrics.py no longer publishes timeseries.now, so report.html\'s masthead and the '
    + 'sparkline\'s time axis both lose the only server-side instant they have');
});
