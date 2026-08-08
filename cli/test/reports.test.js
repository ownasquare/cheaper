'use strict';
// What the TERMINAL report is allowed to print.
//
// These tests drive the REAL renderer (`reports.renderReport`) — not a re-implementation
// of its formatting — over fixtures produced by the REAL store, because a second
// implementation of these rules in the test is the exact drift the rules forbid.
//
// The assertion that matters is not "the numbers are right". It is:
//   * NO rendered figure equals measured + estimated, in dollars OR in counts;
//   * both bases appear, separately, wherever either appears;
//   * a WITHHELD figure renders its label, never $0.00 and never a zero-length bar;
//   * an ABSENT figure renders a labelled non-number, never a bare 0;
//   * the sign survives to the screen;
//   * and the trend still actually RENDERS — a fix that satisfies the rules by printing
//     nothing is not a fix.

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/peek/store');
const reports = require('../src/reports');

const ESC_RE = /\x1b\[[0-9;]*m/g;
const strip = (s) => s.replace(ESC_RE, '');

// Drive the real renderer and hand back both the raw (coloured) and stripped output.
function render(rep) {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { reports.renderReport(rep); } finally { console.log = orig; }
  const raw = lines.join('\n');
  return { raw, text: strip(raw), lines: strip(raw).split('\n') };
}

// The block between the `Trend` heading and the next blank line.
function trendBlock(out) {
  const i = out.lines.findIndex((l) => l.trim().startsWith('Trend'));
  assert.ok(i >= 0, 'the Trend block must be rendered at all');
  const rest = out.lines.slice(i + 1);
  const end = rest.findIndex((l) => l.trim() === '');
  return [out.lines[i]].concat(rest.slice(0, end < 0 ? rest.length : end));
}

function ev(over) {
  return Object.assign({
    v: 1, id: 'rid:req_1', rev: 1, w: 'cli', inst: 'aaaaaaaa',
    ts: Date.UTC(2026, 7, 10, 12, 0, 0), tzo: 0, pday: '2026-08-10',
    prov: 'transcript', usrc: 'body', conf: 'estimated',
    harness: 'claude-code', sessions: ['s1'], sess: 's1', sub: true,
    served: 'claude-haiku-4-5', req: null, base: 'claude-opus-5',
    bsrc: 'tx_session_ceiling', elig: true, ctier: 'haiku', cver: 3, reason: '',
    in: 10000, out: 10000, cr: 0, c5: 0, c1: 0, cu: 0,
    speed: null, svc: 'standard', status: 200,
  }, over || {});
}

const YEAR_FROM = Date.UTC(2026, 0, 1);
const YEAR_TO = Date.UTC(2027, 0, 1);
// Coverage spanning the whole fixture year, so no window short-circuits to `not covered`.
const STATE = { v: 1, coverage: [{ from: YEAR_FROM, to: YEAR_TO }] };

function reportFrom(rows, extra) {
  const dayFrom = Date.UTC(2026, 7, 10);
  const dayTo = Date.UTC(2026, 7, 11);
  const win = store.reportWindow(rows, dayFrom, dayTo, { state: STATE });
  return Object.assign({
    source: 'local-store', tz: 'UTC', catalog: { as_of: '2026-08-01' },
    periods: [Object.assign({ key: 'today', label: 'Today' }, win)],
    comparisons: { month: { period: 'month', current: win, previous: win } },
    breakdown: [],
    trend: store.reportTrend(rows, 'day', YEAR_FROM, YEAR_TO),
  }, extra || {});
}

// ---- THE BLOCKER --------------------------------------------------------------------

test('THE CROSS-BASIS TREND SUM: a day carrying both bases never renders their sum', () => {
  // Four calls on 2026-08-10 — two measured, two estimated — haiku-4-5 served against an
  // opus-5 baseline. The ladder reports this day as $X measured AND $X estimated, in two
  // columns. The Trend row used to report 2X for the SAME day, four lines above a footer
  // saying the two bases are never summed.
  const rows = [
    ev({ id: 'rid:m1', conf: 'measured' }),
    ev({ id: 'rid:m2', conf: 'measured' }),
    ev({ id: 'rid:e1', conf: 'estimated' }),
    ev({ id: 'rid:e2', conf: 'estimated' }),
  ];
  const rep = reportFrom(rows);
  const pt = rep.trend.find((t) => t.bucket === '2026-08-10');
  assert.ok(pt, 'the fixture must produce a dated bucket');
  const m = pt.measured.saved;
  const e = pt.estimated.saved;
  assert.ok(m > 0 && e > 0, `both bases must carry a figure: m=${m} e=${e}`);

  const out = render(rep);
  const block = trendBlock(out).join('\n');

  const money = (v) => '$' + Number(v).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // 1. the sum must appear NOWHERE — not in the trend, not anywhere on the screen.
  assert.ok(!out.text.includes(money(m + e)),
    `the cross-basis sum ${money(m + e)} must never be rendered:\n${out.text}`);
  // 2. …and both bases must be present in the trend row itself.
  const row = trendBlock(out).find((l) => l.includes('2026-08-10'));
  assert.ok(row, 'the dated bucket must render a row');
  assert.ok(row.includes(money(m)), `measured ${money(m)} missing from: ${row}`);
  assert.ok(row.includes(money(e)), `estimated ${money(e)} missing from: ${row}`);
  // 3. two figures on the row, separated the way `pair` separates them everywhere else.
  assert.ok(row.includes('│'), `the trend row must use the two-column separator: ${row}`);
  assert.ok(block.includes('measured') && block.includes('estimated'),
    'the trend block must name both bases');
});

test('THE CROSS-BASIS COUNT: n renders as two columns, never measured+estimated', () => {
  const rows = [
    ev({ id: 'rid:m1', conf: 'measured' }),
    ev({ id: 'rid:m2', conf: 'measured' }),
    ev({ id: 'rid:e1', conf: 'estimated' }),
    ev({ id: 'rid:e2', conf: 'estimated' }),
  ];
  const rep = reportFrom(rows);
  const win = rep.periods[0];
  assert.strictEqual(win.measured.calls, 2);
  assert.strictEqual(win.estimated.calls, 2);

  const out = render(rep);
  assert.ok(/n=2 │ 2/.test(out.text),
    `n must be two columns, one per basis:\n${out.text}`);
  assert.ok(!/n=4\b/.test(out.text),
    `"n=4" is 2 measured calls added to 2 estimated ones:\n${out.text}`);
});

// ---- withheld, absent, and zero are three different claims ---------------------------

test('a WITHHELD trend figure renders its label — never $0.00, never a zero-length bar', () => {
  // `saved: null` with a non-zero `calls` is the shape a suppressed window produces:
  // the dollars were declined, the counts are exact. `(v || 0)` folded that null into a
  // zero addend and plotted it as a measured zero.
  const rep = {
    source: 'local-store', tz: 'UTC', catalog: { as_of: '2026-08-01' },
    periods: [], comparisons: null, breakdown: [],
    trend: [
      { bucket: '2026-08-09', grain: 'call', undatable: false,
        measured: { saved: 4.0, calls: 3 }, estimated: { saved: 2.0, calls: 1 },
        unpricedCalls: 0 },
      { bucket: '2026-08-10', grain: 'call', undatable: false,
        measured: { saved: null, calls: 2 }, estimated: { saved: 1.25, calls: 1 },
        unpricedCalls: 0 },
    ],
  };
  const out = render(rep);
  const row = trendBlock(out).find((l) => l.includes('2026-08-10'));
  assert.ok(row, 'the suppressed bucket must still render a row');
  assert.ok(row.includes('withheld'),
    `a withheld figure must render its label: ${row}`);
  assert.ok(!row.includes('$0.00'),
    `a withheld figure must never render as a measured zero: ${row}`);
  // The sibling basis on the SAME row is intact and still shown.
  assert.ok(row.includes('$1.25'), `the other basis must survive: ${row}`);
  // …and the withheld side must not have been summed into anything.
  assert.ok(!out.text.includes('$1.25 │ $1.25'), 'no fabricated symmetry');
});

test('a bucket with calls on ONE basis only renders the other as a labelled non-number', () => {
  const rep = {
    source: 'local-store', tz: 'UTC', catalog: { as_of: '2026-08-01' },
    periods: [], comparisons: null, breakdown: [],
    trend: [
      { bucket: '2026-08-10', grain: 'call', undatable: false,
        measured: { saved: 3.5, calls: 2 }, estimated: { saved: 0, calls: 0 },
        unpricedCalls: 0 },
    ],
  };
  const out = render(rep);
  const row = trendBlock(out).find((l) => l.includes('2026-08-10'));
  assert.ok(row.includes('$3.50'), `the measured basis must show: ${row}`);
  assert.ok(row.includes('—'),
    `an absent basis must render a labelled non-number: ${row}`);
  assert.ok(!row.includes('$0.00'),
    `no calls on a basis is not a measured zero on that basis: ${row}`);
});

test('a bucket whose rows were ALL unpriceable says WITHHELD, not "no rows"', () => {
  // NEW STATE created by splitting the bases: a bucket can now have zero priced calls on
  // BOTH sides. The old single scalar printed `$0.00` with a bar for exactly this case.
  //
  // THIS TEST USED TO ASSERT THE EM DASH — the ABSENT claim — and that is precisely the
  // defect. `calls` counts rows PRICED, `events` counts rows SEEN, so a fully-unpriceable
  // bucket has calls === 0 on both bases while two rows were plainly seen and deliberately
  // not priced. Asserting `—` here pinned the renderer to say "no rows in this bucket"
  // about rows the same payload counts, and it is why four of the last five rounds shipped
  // the contradiction.
  const rows = [
    ev({ id: 'rid:u1', conf: 'measured', served: 'no-such-model-xyz' }),
    ev({ id: 'rid:u2', conf: 'estimated', served: 'no-such-model-xyz' }),
  ];
  const trend = store.reportTrend(rows, 'day', YEAR_FROM, YEAR_TO);
  const pt = trend.find((t) => t.bucket === '2026-08-10');
  assert.ok(pt, 'the rows are datable, so the bucket exists');
  // THE SHAPE THE STORE ACTUALLY EMITS: zero PRICED calls on both bases…
  assert.strictEqual(pt.measured.calls, 0);
  assert.strictEqual(pt.estimated.calls, 0);
  // …while the rows were SEEN, and the point says so. A fixture with `calls` non-zero
  // cannot reach this branch, which is exactly why the previous one never caught it.
  assert.strictEqual(pt.events.measured, 1);
  assert.strictEqual(pt.events.estimated, 1);
  assert.strictEqual(pt.dollars_suppressed, true);

  const out = render({
    source: 'local-store', tz: 'UTC', catalog: { as_of: '2026-08-01' },
    periods: [], comparisons: null, breakdown: [], trend,
  });
  const row = trendBlock(out).find((l) => l.includes('2026-08-10'));
  assert.ok(row, 'the bucket must still be visible — every exclusion is counted');
  assert.ok(!row.includes('$0.00'),
    `an unpriceable bucket must not claim a measured zero: ${row}`);
  assert.ok(row.includes('withheld'),
    `rows were seen and deliberately not priced — that is WITHHELD, not absent: ${row}`);
  assert.ok(!/\bno .* rows\b/.test(row) && !row.includes('—'),
    `the bucket may not claim it holds no rows: ${row}`);
  assert.ok(!row.includes('█'), `and no bar may be plotted for a declined figure: ${row}`);
});

test('an undated point with no usable count is labelled, never "0 call(s)"', () => {
  const base = { bucket: 'undated', grain: 'call', undatable: true,
                 measured: { saved: 0, calls: 0 }, estimated: { saved: 0, calls: 0 } };
  const withCount = render({
    source: 'local-store', tz: 'UTC', catalog: { as_of: '2026-08-01' },
    periods: [], comparisons: null, breakdown: [],
    trend: [Object.assign({}, base, { unpricedCalls: 3 })],
  });
  const a = trendBlock(withCount).find((l) => l.includes('undated'));
  assert.ok(/not dated/.test(a) && /3 call\(s\)/.test(a), a);

  // A point that exists ONLY because at least one row landed on no day cannot honestly
  // print "0 call(s)" — its own existence contradicts that.
  const noCount = render({
    source: 'local-store', tz: 'UTC', catalog: { as_of: '2026-08-01' },
    periods: [], comparisons: null, breakdown: [],
    trend: [Object.assign({}, base)],
  });
  const b = trendBlock(noCount).find((l) => l.includes('undated'));
  assert.ok(/not dated/.test(b), b);
  assert.ok(!/\b0 call\(s\)/.test(b),
    `an absent count must not render as a measured zero: ${b}`);
  assert.ok(/unavailable/.test(b), `it must be labelled instead: ${b}`);
});

// ---- scaling, sign, and the guard against "fix by suppression" -----------------------

test('each basis is scaled against its OWN maximum, never a shared cross-basis axis', () => {
  // measured peaks on day A, estimated peaks on day B. Under a shared axis the smaller
  // basis on each day would be crushed against the other basis' maximum.
  const rep = {
    source: 'local-store', tz: 'UTC', catalog: { as_of: '2026-08-01' },
    periods: [], comparisons: null, breakdown: [],
    trend: [
      { bucket: '2026-08-09', grain: 'call', undatable: false,
        measured: { saved: 100, calls: 5 }, estimated: { saved: 1, calls: 5 },
        unpricedCalls: 0 },
      { bucket: '2026-08-10', grain: 'call', undatable: false,
        measured: { saved: 1, calls: 5 }, estimated: { saved: 100, calls: 5 },
        unpricedCalls: 0 },
    ],
  };
  const out = render(rep);
  const bars = (label) => {
    const row = trendBlock(out).find((l) => l.includes(label));
    const [left, right] = row.split('│').slice(-2);
    return [(left.match(/█/g) || []).length, (right.match(/█/g) || []).length];
  };
  const [m9, e9] = bars('2026-08-09');
  const [m10, e10] = bars('2026-08-10');
  // The basis at ITS OWN maximum fills its bar on both days.
  assert.ok(m9 > 0 && e10 > 0, `full bars expected, got ${m9} and ${e10}`);
  assert.strictEqual(m9, e10, 'each basis full-scale is the same width');
  assert.ok(m10 < m9, 'the small measured day is short against the measured max');
  assert.ok(e9 < e10, 'the small estimated day is short against the estimated max');
});

test('the sign survives to the screen: a negative basis renders negative', () => {
  const rep = {
    source: 'local-store', tz: 'UTC', catalog: { as_of: '2026-08-01' },
    periods: [], comparisons: null, breakdown: [],
    trend: [
      { bucket: '2026-08-10', grain: 'call', undatable: false,
        measured: { saved: -2.5, calls: 2 }, estimated: { saved: 4.0, calls: 2 },
        unpricedCalls: 0 },
    ],
  };
  const out = render(rep);
  const row = trendBlock(out).find((l) => l.includes('2026-08-10'));
  assert.ok(row.includes('-$2.50'), `the negative basis must keep its sign: ${row}`);
  assert.ok(row.includes('$4.00'), `the positive basis must survive: ${row}`);
  // And absolutely not the netted -2.50 + 4.00.
  assert.ok(!row.includes('$1.50'), `no cross-basis netting: ${row}`);
});

test('OVER-CORRECTION GUARD: the trend still renders a row, a figure and a bar per bucket', () => {
  // A renderer that satisfied every rule above by printing NOTHING for the trend would be
  // concealment of a different kind. This pins that the block is actually emitted.
  const rows = [
    ev({ id: 'rid:m1', conf: 'measured' }),
    ev({ id: 'rid:e1', conf: 'estimated' }),
  ];
  const out = render(reportFrom(rows));
  const block = trendBlock(out);
  assert.ok(block.length >= 2, `the Trend block must emit rows:\n${block.join('\n')}`);
  const row = block.find((l) => l.includes('2026-08-10'));
  assert.ok(row, 'the dated bucket must render');
  assert.ok(/\$\d/.test(row), `the bucket must render a dollar figure: ${row}`);
  assert.ok(row.includes('█'), `the bucket must render a bar: ${row}`);
  assert.ok(row.split('│').length >= 2, `two columns, not one: ${row}`);
});

// ---- ONE SCREEN, ONE STORY -----------------------------------------------------------

test('THE SIBLING CONTRADICTION: the ladder and the trend cover the SAME rows and may not '
   + 'disagree about whether a dollar figure is claimed', () => {
  // Two priceable calls (1k/1k each) plus one call on a model absent from the catalog
  // (500k/500k). The ladder's day row and the day-grain trend bucket hold exactly these
  // three rows. reportTrend computed `dollarsSuppressed` and threw it away, so the SAME
  // screen printed, six lines apart:
  //     Today   withheld │ withheld    ↳ …so no dollar figure is claimed.
  //     2026-08-10   $0.02 │ $0.02   █ │ █
  const rows = [
    ev({ id: 'rid:m1', conf: 'measured', in: 1000, out: 1000 }),
    ev({ id: 'rid:m2', conf: 'measured', in: 1000, out: 1000 }),
    ev({ id: 'rid:u1', conf: 'measured', served: 'no-such-model-xyz',
         in: 500000, out: 500000 }),
  ];
  const dayFrom = Date.UTC(2026, 7, 10);
  const dayTo = Date.UTC(2026, 7, 11);
  const win = store.reportWindow(rows, dayFrom, dayTo, { state: STATE });
  const trend = store.reportTrend(rows, 'day', dayFrom, dayTo);
  assert.strictEqual(win.dollars_suppressed, true);
  assert.strictEqual(trend.length, 1);
  // The producer states the decision on the point, so the renderer has a field to key off.
  assert.strictEqual(trend[0].dollars_suppressed, true);

  const out = render({
    source: 'local-store', tz: 'UTC', catalog: { as_of: '2026-08-01' },
    periods: [Object.assign({ key: 'today', label: 'Aug 10' }, win)],
    comparisons: null,
    breakdown: store.reportBreakdown(rows, 'served', dayFrom, dayTo),
    trend,
  });
  const row = trendBlock(out).find((l) => l.includes('2026-08-10'));
  assert.ok(row, 'the bucket must still be visible — every exclusion is counted');
  assert.ok(row.includes('withheld'), `the trend must withhold too: ${row}`);
  // The precise figures the trend used to print beside a ladder row reading "withheld".
  assert.ok(!/\$0\.0\d/.test(row), `no dollar figure may be claimed here: ${row}`);
  assert.ok(!row.includes('█'), `and no bar may be plotted for a declined figure: ${row}`);
  // The ladder still says what it always said, and the note is still there.
  const lad = out.lines.find((l) => l.includes('Aug 10'));
  assert.ok(lad.includes('withheld'), lad);
  assert.match(out.text, /no dollar figure is claimed/);
  // Neither of the two surfaces that cover EXACTLY THIS ROW SET claims a dollar figure.
  //
  // Scoped deliberately to those two. The Composition block groups by served model, so
  // `claude-haiku-4-5` there is a DIFFERENT row set — the two priceable calls alone, 0%
  // unpriceable — and it prices them. That is the per-group decision working as designed
  // (each group is judged on its own rows, and the unpriceable model gets its own
  // withheld row directly beneath), not a contradiction of the window, which declines to
  // price a set that is 99% unpriceable BY TOKEN. The blocker was about the ladder row
  // and the day bucket, which hold the identical rows and must therefore reach the
  // identical decision.
  assert.ok(!/\$\d/.test(lad), `the ladder row may claim nothing: ${lad}`);
  assert.ok(!/\$\d/.test(row), `and neither may the bucket over the same rows: ${row}`);
});

test('the ladder header drops its ADD-UP-to-lifetime claim when a window withholds', () => {
  // `lifetime_window`'s own docstring records that the identity holds ONLY when no row is
  // dollars_suppressed. The header asserted it unconditionally.
  const clean = {
    source: 'local-store', tz: 'UTC', catalog: { as_of: '2026-08-01' },
    periods: [{ key: 'today', label: 'Today', status: 'ok', dollars_suppressed: false,
                measured: { saved: 1, calls: 1 }, estimated: { saved: 0, calls: 0 } }],
    comparisons: null, breakdown: [], trend: [],
  };
  const a = render(clean);
  assert.ok(a.text.includes('these ADD UP to lifetime'), a.text);
  assert.ok(!a.text.includes('the dollar column does not'), a.text);

  const dirty = Object.assign({}, clean, {
    periods: clean.periods.concat([{ key: 'week', label: 'Earlier this week',
      status: 'suppressed', dollars_suppressed: true,
      measured: { saved: null, calls: 2 }, estimated: { saved: null, calls: 0 } }]),
  });
  const b = render(dirty);
  assert.ok(!b.text.includes('these ADD UP to lifetime'),
    `the page may not assert an additivity it does not have:\n${b.text}`);
  assert.ok(b.text.includes('the dollar column does not'), b.text);
  assert.match(b.text, /1 window\(s\) below withhold their dollars/);
  // The COUNTS are still additive and the caveat must not overreach into them.
  assert.match(b.text, /COUNTS add up to lifetime/);
});

test('a real SUPPRESSED window renders "withheld" in the ladder and keeps its exact n', () => {
  // >20% of the window's tokens unpriceable: dollars are declined, counts are not.
  const rows = [
    ev({ id: 'rid:m1', conf: 'measured', in: 1000, out: 1000 }),
    ev({ id: 'rid:m2', conf: 'measured', in: 1000, out: 1000 }),
    ev({ id: 'rid:u1', conf: 'measured', served: 'no-such-model-xyz',
         in: 500000, out: 500000 }),
  ];
  const rep = reportFrom(rows);
  const win = rep.periods[0];
  assert.strictEqual(win.status, 'suppressed', JSON.stringify(win.labels));
  assert.strictEqual(win.measured.saved, null, 'dollars are withheld');
  assert.strictEqual(win.measured.calls, 2, 'counts are exact and survive');

  const out = render(rep);
  assert.ok(out.text.includes('withheld'), out.text);
  assert.ok(!/Today\s+\$0\.00/.test(out.text),
    'a suppressed window must not render a measured zero');
  // THREE measured rows were SEEN in this window; two of them were priced. `n` is the
  // EVENT count — the caption above it says so ("a 400% jump on 3 events reads as noise")
  // — so it states 3, which is also what the dashboard ladder's Events (measured) cell
  // prints for this same window through basisEvents(). This assertion used to read
  // `n=2 │ 0`, the PRICED count, which made the same window read 2 here and 3 there.
  assert.strictEqual(win.events.measured, 3, 'three measured rows were seen');
  assert.strictEqual(win.events.estimated, 0);
  assert.ok(/n=3 │ 0/.test(out.text),
    `the exact per-basis EVENT counts must survive suppression:\n${out.text}`);
});

// ---- THE COUNT COLUMN BESIDE THE MONEY COLUMN ----------------------------------------

test('THE COUNT COLUMN: a WITHHELD window states the rows it SAW, and a genuinely empty '
   + 'window is not rendered identically to it', () => {
  // THE BLOCKER, in the column beside the one that was already fixed.
  //
  // Four calls on a model absent from model_prices.json. The window's dollars are
  // declined, so `pair` prints `withheld │ withheld`. Reading `acc.calls` — ROWS PRICED —
  // for `n` printed `n=0 │ 0` on that same line: the money half asserting that rows exist
  // whose dollars were deliberately not claimed, the count half asserting that no rows
  // exist. It also made this window's count cell IDENTICAL to a window in which nothing
  // happened, which is the exact collapse the money column had just been taught to avoid.
  //
  // A fixture with `calls` non-zero cannot reach this branch. The store emits calls: 0 on
  // BOTH bases for a fully-unpriceable window, which is why every committed fixture missed
  // it — so this one is taken from the REAL producer and its shape is pinned first.
  const rows = [
    ev({ id: 'rid:u1', conf: 'measured', ts: Date.UTC(2026, 7, 12, 12), pday: '2026-08-12',
         served: 'llama-4-maverick' }),
    ev({ id: 'rid:u2', conf: 'measured', ts: Date.UTC(2026, 7, 12, 13), pday: '2026-08-12',
         served: 'llama-4-maverick' }),
    ev({ id: 'rid:u3', conf: 'measured', ts: Date.UTC(2026, 7, 12, 14), pday: '2026-08-12',
         served: 'llama-4-maverick' }),
    ev({ id: 'rid:u4', conf: 'estimated', ts: Date.UTC(2026, 7, 12, 15), pday: '2026-08-12',
         served: 'llama-4-maverick' }),
  ];
  const dayFrom = Date.UTC(2026, 7, 12);
  const dayTo = Date.UTC(2026, 7, 13);
  const current = store.reportWindow(rows, dayFrom, dayTo, { state: STATE });
  // The day BEFORE: covered by the same state, and genuinely empty. Not a second claim —
  // the same rows, a window they do not fall in.
  const previous = store.reportWindow(rows, Date.UTC(2026, 7, 11), dayFrom, { state: STATE });

  // THE SHAPE. Zero PRICED on both bases, three plus one SEEN, dollars declined.
  assert.strictEqual(current.measured.calls, 0);
  assert.strictEqual(current.estimated.calls, 0);
  assert.strictEqual(current.events.measured, 3);
  assert.strictEqual(current.events.estimated, 1);
  assert.strictEqual(current.dollars_suppressed, true);
  // …and the empty window's zeroes are MEASURED zeroes: it was covered and watched.
  assert.strictEqual(previous.status, 'ok');
  assert.strictEqual(previous.events.measured, 0);
  assert.strictEqual(previous.events.estimated, 0);

  const out = render({
    source: 'local-store', tz: 'UTC', catalog: { as_of: '2026-08-01' },
    periods: [], breakdown: [], trend: [],
    comparisons: { month: { period: 'month', current, previous } },
  });
  const cur = out.lines.find((l) => l.includes('this month'));
  const prv = out.lines.find((l) => l.includes('vs last month'));
  assert.ok(cur && prv, `both comparison rows must render:\n${out.text}`);

  // 1. THE CONTRADICTION INSIDE ONE ROW. The money says rows were seen and not priced; the
  //    count may not say there were none.
  assert.ok(cur.includes('withheld'), `the money column must withhold: ${cur}`);
  assert.ok(/n=3 │ 1/.test(cur),
    `a withheld window must state the rows it SAW, not the rows it priced: ${cur}`);
  assert.ok(!/n=0 │ 0/.test(cur),
    `"withheld" and "n=0 | 0" in one row are two contradictory claims: ${cur}`);

  // 2. THE COLLAPSE. A window that saw four calls and a window that saw none may not
  //    render the same count cell.
  const nOf = (l) => (/n=.*$/.exec(l) || [''])[0];
  assert.notStrictEqual(nOf(cur), nOf(prv),
    `the count column cannot distinguish "4 calls happened, none priceable" from `
    + `"nothing happened": ${nOf(cur)}`);

  // 3. THE OVER-CORRECTION MIRROR, in the same test: a covered window that genuinely saw
  //    nothing MEASURED zero, and still says 0. Labelling it would be the mirror defect.
  assert.ok(/n=0 │ 0/.test(prv),
    `a covered window that saw nothing measured zero and must say so: ${prv}`);
  assert.ok(!/withheld/.test(prv), `an empty window withholds nothing: ${prv}`);

  // 4. …and never the cross-basis population of four, which is what a reader would get
  //    from 3 + 1.
  assert.ok(!/n=4\b/.test(out.text),
    `"n=4" is 3 measured events added to 1 estimated one:\n${out.text}`);
});
