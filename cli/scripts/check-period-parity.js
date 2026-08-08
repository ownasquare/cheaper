#!/usr/bin/env node
'use strict';
// Cross-runtime parity gate for CALENDAR PERIODS — the same guarantee sync-prices.js
// gives the price catalog, applied to time.
//
// Why this exists: `cli/src/peek/periods.js` and `gateway/app/periods.py` both answer
// "what are the bounds of this week/month/quarter?", and the CLI and the dashboard each
// use their own copy. A divergence does not look like a bug — both surfaces render a
// confident number, they just cover different instants, and "this week" quietly means
// two different things inside one product. Pricing already drifted this way once and
// shipped wrong dollars.
//
// The fixtures are chosen to break naive implementations:
//   * a DST spring-forward instant (02:00 local does not exist)
//   * a DST fall-back instant (01:30 local happens twice)
//   * a Monday 00:00 exactly (the week boundary itself)
//   * a Sunday 23:59 (the last instant of an ISO week)
//   * Jan 1, Dec 31, and a leap day
//   * a month-end crossing a quarter boundary
//   * half-hour (Asia/Kolkata) and 45-minute (Asia/Kathmandu) zones, which any
//     hour-based offset shortcut gets wrong
//
// THREE gates live here, because each earlier one was green while the next one drifted:
//
//   1. periodBounds / previousPeriodBounds / disjointLadder — the calendar windows.
//      Zone comes from an argument, so one process can cover every zone.
//   2. pdayOf / tzOffsetAt vs pday_of / local_offset_minutes — the ONE TIME FRAME that
//      decides a row's price date. This pair drifted while gate 1 was green:
//      `pday_of(1756700000000, None)` was '2025-09-01' in Python and '2025-08-31' in
//      JS at a -420 machine — across the claude-sonnet-5 promo boundary, the same 50%
//      split the frozen-offset column was written to close, reintroduced one layer
//      down. These two read the MACHINE's zone, so each zone needs its own child
//      process on both runtimes; that is what makes this gate slower and why it is
//      worth it.
//   3. WINDOW PLACEMENT — which window a ROW lands in, and what it is worth there.
//      Gates 1 and 2 agree on the bounds and on the row's day and STILL let this ship:
//      the gateway learned to place a row whose `ts` died in a merge by the calendar day
//      frozen on it, and `cli/src/peek/store.js` went on filtering `Number(r.ts)` alone.
//      `Number(null)` is 0 — finite — so the CLI dropped that row out of its OWN month
//      with no label and no count while the gateway reported its dollars in that same
//      month; with `ts` merely ABSENT the coercion gave NaN instead and the CLI waved the
//      row into EVERY window at once, so breakdown(April) + breakdown(August) was twice
//      their union. Two readers, two answers, one row. Gate 3 feeds REAL `reconcile.fold`
//      output — plus a `pday` outside the window, an absent `pday`, and a `pday` that
//      names no day at all — through BOTH runtimes' window / breakdown / trend and diffs
//      the calls and the dollars.
//
// Usage:  node scripts/check-period-parity.js [--check]
// Exits non-zero on ANY millisecond, or any cent, of disagreement.

const path = require('path');
const { spawnSync } = require('child_process');

const P = require(path.join(__dirname, '..', 'src', 'peek', 'periods.js'));
// Gate 3 builds its ts=null / pday-alive fixture through the REAL merge rather than
// hand-writing the shape, so the gate cannot outlive the state it claims to cover.
const { fold } = require(path.join(__dirname, '..', 'src', 'peek', 'reconcile.js'));
// THE INTERPRETER IS RESOLVED BY THE SHIPPED CODE, not by a second copy living here.
//
// This script had its own `pyExe()` that probed `['python3', 'python']` and returned a
// bare string. `src/gateway.js` had already outgrown that: on a stock python.org Windows
// install with "Add python.exe to PATH" left unchecked — the DEFAULT — `python3` and
// `python` resolve only to the Microsoft Store alias stub, which exits non-zero, and the
// only usable launcher is `py -3`. A candidate is therefore a COMMAND PLUS PREFIX ARGS,
// not a name, which is why the shared `pyExe()` answers `{cmd, args}` or null.
//
// With the duplicate here, every gate below SKIPPED on exactly the machines the gateway
// can run on — and a parity gate that silently does not run is decoration. Two copies of
// "how do I find Python" is the same defect class the parity gates themselves exist to
// catch: one behaviour, two implementations, free to drift.
const { pyExe, PY_CANDIDATES, launcherLabel } =
  require(path.join(__dirname, '..', 'src', 'gateway.js'));
const PY_DIR = path.join(__dirname, '..', 'assets', 'gateway', 'app');

// Every candidate is NAMED, rather than the old "no python3 on PATH", so the failure line
// is checkable against what was actually attempted — and so a candidate added to the
// shared list appears here without anyone remembering to edit this string.
//
// It no longer carries its own "— the gate did not run" tail: the one caller leads with
// DID NOT RUN, and the sentence used to say it twice.
const NO_PY = `no usable Python 3 (tried: ${PY_CANDIDATES.map(launcherLabel).join(', ')})`;

const ZONES = [
  'UTC',
  'America/Los_Angeles',   // the timezone-frame bug's own zone (UTC-7/-8)
  'America/Chicago',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',          // UTC+05:30 — half-hour offset
  'Asia/Kathmandu',        // UTC+05:45 — 45-minute offset
  'Australia/Sydney',      // southern-hemisphere DST (inverted year)
  'Pacific/Chatham',       // UTC+12:45/+13:45 — the worst case that exists
];

// Instants chosen for boundaries, not for coverage.
const INSTANTS = [
  Date.UTC(2026, 0, 1, 0, 0, 0),      // New Year, UTC midnight
  Date.UTC(2026, 0, 1, 7, 30, 0),     // New Year, after US midnight
  Date.UTC(2026, 2, 8, 10, 30, 0),    // US spring-forward day (2026-03-08)
  Date.UTC(2026, 2, 8, 9, 59, 59),    // one second before 02:00 PST becomes 03:00 PDT
  Date.UTC(2026, 9, 25, 1, 30, 0),    // EU fall-back day
  Date.UTC(2026, 10, 1, 8, 30, 0),    // US fall-back day (2026-11-01)
  Date.UTC(2026, 7, 31, 6, 30, 0),    // the sonnet-5 promo boundary, UTC-7 evening
  Date.UTC(2026, 7, 3, 0, 0, 0),      // a Monday 00:00 UTC exactly
  Date.UTC(2026, 7, 2, 23, 59, 59),   // the Sunday before it
  Date.UTC(2024, 1, 29, 12, 0, 0),    // leap day
  Date.UTC(2026, 5, 30, 23, 59, 59),  // last instant of Q2
  Date.UTC(2026, 6, 1, 0, 0, 1),      // first instant of Q3
  Date.UTC(2026, 11, 31, 23, 59, 59), // last instant of the year
];

function jsSide() {
  const rows = [];
  for (const tz of ZONES) {
    for (const now of INSTANTS) {
      for (const name of ['today', 'week', 'month', 'quarter', 'year']) {
        const b = P.periodBounds(name, now, tz);
        rows.push([tz, now, name, b.from, b.to].join('|'));
      }
      const prev = P.previousPeriodBounds('month', now, tz);
      rows.push([tz, now, 'prev_month', prev.from, prev.to].join('|'));
      for (const r of P.disjointLadder(now, tz)) {
        rows.push([tz, now, 'ladder:' + r.key,
          Number.isFinite(r.from) ? r.from : 'null',
          Number.isFinite(r.to) ? r.to : 'null'].join('|'));
      }
    }
  }
  return rows;
}

const PY = `
import json, sys
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
from periods import period_bounds, previous_period_bounds, disjoint_ladder
zones = json.loads(sys.argv[1]); instants = json.loads(sys.argv[2])
rows = []
def n(v):
    return 'null' if v is None else str(int(v))
for tz in zones:
    for now in instants:
        for name in ('today','week','month','quarter','year'):
            b = period_bounds(name, now, tz)
            rows.append('|'.join([tz, str(now), name, n(b['from']), n(b['to'])]))
        p = previous_period_bounds('month', now, tz)
        rows.append('|'.join([tz, str(now), 'prev_month', n(p['from']), n(p['to'])]))
        for r in disjoint_ladder(now, tz):
            rows.append('|'.join([tz, str(now), 'ladder:' + r['key'], n(r['from']), n(r['to'])]))
print('\\n'.join(rows))
`;

function pySide(py) {
  const r = spawnSync(py.cmd, [...py.args, '-c', PY,
    JSON.stringify(ZONES), JSON.stringify(INSTANTS)], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout.trim().split('\n');
  // The launcher already answered `--version` successfully, so it EXISTS: anything that
  // fails now is the module blowing up, and that IS a failure, not a skip. There is no
  // next candidate to fall through to — falling through was how a broken `periods.py`
  // could be reported as "no Python".
  console.error(`  period parity FAILED (${launcherLabel(py)}):`);
  console.error(((r.stderr || '') + String(r.error || '')).trim());
  process.exit(1);
}

// ---------------------------------------------------------------------------
// gate 2: the ONE TIME FRAME — pdayOf / tzOffsetAt vs pday_of / local_offset_minutes
// ---------------------------------------------------------------------------

// `tzo` values, chosen for the states that are NOT interchangeable:
//   __undefined__  the argument was not passed at all
//   null           the offset was recorded as ABSENT — store.merge nulls it when two
//                  sources disagree about a row's frame. `Number(null)` is 0 and
//                  `int(tzo or 0)` is 0, so both runtimes used to read this as UTC.
//   '' / 'abc'     unusable values that must reconstruct, not silently become 0
//   0              an EXPLICIT UTC offset — a legitimate value that must NOT be
//                  confused with absence
//   330 / 345      half-hour and 45-minute zones, which an hour-based shift breaks
//   90.7           fractional: Math.trunc must match Python's int()
const PDAY_TZOS = ['__undefined__', null, '', 'abc', 0, -420, -720, 330, 345, 780, 90.7];

// The bounds fixtures (which already include a spring-forward and BOTH a EU and a US
// fall-back instant), plus instants no calendar can render. metrics.db stores SECONDS
// while periods.js and the event store use MILLISECONDS, so a unit slip is a live
// failure mode: 1.7e15 ms is year 55840. Both runtimes must answer null there — Python
// cannot represent it, and JS must not invent a confident year-55840 date instead.
const PDAY_INSTANTS = INSTANTS.concat([
  1.7e15,     // seconds/ms unit slip -> year 55840
  2.6e14,     // year 10209, just past Python's datetime range
  -1e18,      // beyond the JS Date range entirely
  // THE CALENDAR EDGES THEMSELVES. These are not decoration: with `tzo` absent (null /
  // '' / 'abc' — the RECONSTRUCTION path) the two runtimes used to disagree on exactly
  // these instants, and the disagreement was a pday answer, not an offset answer.
  // Python's local_offset_minutes substituted 0 when it could not compute an offset
  // while JS shifted by the machine's real one, so on a machine WEST of UTC:
  //   -62135596800000  JS null           vs  PY '0001-01-01'
  //   -62135596799999  JS null           vs  PY '0001-01-01'
  //    253402300800000 JS '9999-12-31'   vs  PY null
  // Both runtimes now answer null at all three, for every machine zone. The fixtures
  // are here so the gate FAILS if either side goes back to inventing an answer.
  -62135596800000,      // 0001-01-01T00:00:00Z — the first representable instant
  -62135596799999,      // one ms later
  253402300799999,      // the LAST representable instant
  253402300800000,      // 10000-01-01T00:00:00Z — the first unrepresentable one
]);

// `tzOffsetAt` / `local_offset_minutes` are diffed over the REPRESENTABLE instants only,
// and that trim IS a real hole, stated rather than hidden: outside this range the two
// genuinely differ. Python answers null (the offset is not determinable — it no longer
// fabricates 0), JS answers the machine's standard offset (or NaN past the JS Date
// range). That difference is OBSERVABLE — the earlier claim here that it was not was
// simply false, and a comment asserting a property the code does not have is the same
// class of defect as a page substantiating a claim it contradicts.
//
// What makes the trim acceptable is not that the difference is invisible; it is that the
// only consumer, `pday_of`/`pdayOf`, no longer lets it through. Both refuse to
// reconstruct an offset for an instant outside the calendar, so both return null there
// — and the calendar-edge instants added to PDAY_INSTANTS above are exactly the cases
// that used to leak, diffed on every one of the 11 `tzo` states below.
const TZOFF_INSTANTS = INSTANTS;

const PDAY_JS = `
const P = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'peek', 'periods.js'))});
const tzos = JSON.parse(process.argv[1]);
const instants = JSON.parse(process.argv[2]);
const tzoffInstants = JSON.parse(process.argv[3]);
const rows = [];
const s = (v) => (v === null || v === undefined ? 'null' : String(v));
for (const ms of tzoffInstants) rows.push(['tzoff', ms, s(P.tzOffsetAt(ms))].join('|'));
for (const ms of instants) {
  for (const t of tzos) {
    const arg = t === '__undefined__' ? undefined : t;
    rows.push(['pday', ms, JSON.stringify(t), s(P.pdayOf(ms, arg))].join('|'));
  }
}
console.log(rows.join('\\n'));
`;

const PDAY_PY = `
import json, sys
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
from periods import pday_of, local_offset_minutes
tzos = json.loads(sys.argv[1]); instants = json.loads(sys.argv[2])
tzoff_instants = json.loads(sys.argv[3])
rows = []
def s(v):
    return 'null' if v is None else str(v)
for ms in tzoff_instants:
    rows.append('|'.join(['tzoff', json.dumps(ms), s(local_offset_minutes(ms))]))
for ms in instants:
    for t in tzos:
        v = pday_of(ms) if t == '__undefined__' else pday_of(ms, t)
        rows.append('|'.join(['pday', json.dumps(ms), json.dumps(t), s(v)]))
print('\\n'.join(rows))
`;

function runIn(zone, exe, args) {
  // TZ is set on the CHILD's environment only. Both runtimes read the machine zone at
  // process start, so a zone matrix cannot be exercised in-process.
  const r = spawnSync(exe, args, {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { TZ: zone }),
  });
  if (r.status !== 0) return { err: (r.stderr || '').trim(), out: null };
  return { err: null, out: r.stdout.trim().split('\n') };
}

// `py` is always a resolved {cmd, args} launcher. main() exits non-zero when there is no
// interpreter, so there is no longer a "skipped" branch here to mistake for a pass.
function pdayParity(py) {
  const tzosJson = JSON.stringify(PDAY_TZOS);
  const instJson = JSON.stringify(PDAY_INSTANTS);
  const tzoffJson = JSON.stringify(TZOFF_INSTANTS);
  let compared = 0;
  const diffs = [];
  for (const tz of ZONES) {
    const j = runIn(tz, process.execPath, ['-e', PDAY_JS, tzosJson, instJson, tzoffJson]);
    const p = runIn(tz, py.cmd, [...py.args, '-c', PDAY_PY, tzosJson, instJson, tzoffJson]);
    if (j.err) { console.error(`  pday parity FAILED (JS, ${tz}):\n${j.err}`); process.exit(1); }
    if (p.err) { console.error(`  pday parity FAILED (PY, ${tz}):\n${p.err}`); process.exit(1); }
    if (j.out.length !== p.out.length) {
      console.error(`  pday parity FAILED: ${tz} produced ${j.out.length} JS rows, `
        + `${p.out.length} Python rows`);
      process.exit(1);
    }
    for (let i = 0; i < j.out.length; i++) {
      compared += 1;
      if (j.out[i] !== p.out[i]) diffs.push({ tz, js: j.out[i], py: p.out[i] });
    }
  }
  if (diffs.length) {
    console.error(`  pday/offset parity FAILED: ${diffs.length} of ${compared} disagree`);
    for (const d of diffs.slice(0, 12)) {
      console.error(`    [${d.tz}] JS  ${d.js}\n    [${d.tz}] PY  ${d.py}`);
    }
    if (diffs.length > 12) console.error(`    … and ${diffs.length - 12} more`);
    process.exit(1);
  }
  console.log(`  pday/offset parity OK — ${compared} answers identical across `
    + `${ZONES.length} zones × ${PDAY_INSTANTS.length} instants × ${PDAY_TZOS.length} `
    + 'offsets (JS ↔ Python)');
}

// ---------------------------------------------------------------------------
// gate 3: WINDOW PLACEMENT — store.js::reportWindow/Breakdown/Trend
//                        vs reporting.py::report_window/breakdown/trend
// ---------------------------------------------------------------------------

const STORE_JS = path.join(__dirname, '..', 'src', 'peek', 'store.js');
const RECONCILE_JS = path.join(__dirname, '..', 'src', 'peek', 'reconcile.js');

// Coverage spanning every window the gate asks for, declared explicitly so that
// `not_covered` is never the variable under test: what is on trial is which window a row
// lands in and what it is worth there, not whether the period was watched.
const PLACEMENT_STATE = {
  v: 1,
  coverage: [{ kind: 'observed', from: 0, to: Date.UTC(2028, 0, 1) }],
  tombstones: [], ingested_files: [],
};

// Half-open [from, to) windows. `null` is unbounded on BOTH sides — JS reads it through
// Number.isFinite, Python through `is not None`, and the two agree by construction.
const PLACEMENT_WINDOWS = [
  [Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1)],     // 0  August — the row's OWN month
  [Date.UTC(2026, 3, 1), Date.UTC(2026, 4, 1)],     // 1  April  — provably not its month
  [Date.UTC(2026, 3, 1), Date.UTC(2026, 8, 1)],     // 2  their union, for additivity
  [Date.UTC(2027, 0, 1), Date.UTC(2027, 1, 1)],     // 3  a year that excludes it entirely
  [null, null],                                     // 4  lifetime
  [Date.UTC(2026, 7, 7, 0), Date.UTC(2026, 7, 7, 7)],   // 5  the UTC reading of a day…
  [Date.UTC(2026, 7, 7, 7), Date.UTC(2026, 7, 7, 8)],   // 6  …vs the -420 reading of it
  [Date.UTC(2026, 7, 6, 18), Date.UTC(2026, 7, 6, 19)], // 7  …vs the +330 reading of it
  [Date.UTC(2026, 7, 6), Date.UTC(2026, 7, 7)],     // 8  a single UTC day
  [Date.UTC(2026, 7, 7), Date.UTC(2026, 7, 8)],     // 9  the next one
];

// The fixture rows. Built with `reconcile.fold` where the shape has to be PROVEN
// reachable rather than asserted — the ts=null / pday-alive row is the whole reason this
// gate exists, so it is produced by the real merge and not hand-written.
function placementRows() {
  const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);
  const base = (over) => Object.assign({
    v: 1, id: 'rid:req_p0', rev: 1, w: 'cli', inst: 'parityinst',
    ts: NOW, tzo: 0, pday: '2026-08-06', ingested_at: NOW,
    prov: 'transcript', usrc: 'body', conf: 'estimated',
    harness: 'claude-code', sessions: ['s1'], sess: 's1', sub: false,
    served: 'claude-sonnet-5', req: null, base: 'claude-opus-5',
    bsrc: 'tx_session_ceiling', elig: true, ctier: 'sonnet', cver: 3, reason: '',
    in: 10000, out: 2000, cr: 0, c5: 0, c1: 0, cu: 0,
    speed: null, svc: 'standard', status: 200,
    sfile: null, sbase: null, fsha: null, vok: true,
  }, over || {});

  // THE row: two transcript lines sharing a provider id and a rev, 1500 ms apart inside
  // one local day. `merge` ranks `ts` and `pday` SEPARATELY, so the two `ts` values tie on
  // rank, fail strict equality, and `ts` is nulled and NAMED in `conflicts` — while the
  // AGREEING `pday` survives untouched. No instant, a perfectly good price date.
  const merged = fold([base({ id: 'rid:req_merge' }),
                       base({ id: 'rid:req_merge', ts: NOW + 1500 })]).rows[0];
  if (merged.ts !== null || merged.pday !== '2026-08-06') {
    console.error('  placement parity FAILED: the fixture merge no longer produces a '
      + `ts=null / pday-alive row (ts=${merged.ts}, pday=${merged.pday})`);
    process.exit(1);
  }

  const tsNull = (over) => base(Object.assign({ ts: null }, over));
  const rows = [
    base({ id: 'rid:req_dated' }),                                  // control, estimated
    base({ id: 'rid:req_meas', conf: 'measured' }),                 // control, measured
    merged,                                                          // ts died in a merge
    tsNull({ id: 'rid:req_pday_aug' }),                              // ts null, day alive
    tsNull({ id: 'rid:req_pday_apr', pday: '2026-04-15' }),          // day OUTSIDE August
    tsNull({ id: 'rid:req_nopday', pday: null }),                    // undatable in BOTH
    tsNull({ id: 'rid:req_badpday', pday: '2026-13-45' }),           // names no day
    tsNull({ id: 'rid:req_numpday', pday: 20260410 }),               // numeric, 8 chars
    tsNull({ id: 'rid:req_west', pday: '2026-08-07', tzo: -420 }),   // day begins 07:00Z
    tsNull({ id: 'rid:req_east', pday: '2026-08-07', tzo: 330 }),    // …18:30Z the day before
    tsNull({ id: 'rid:req_recon', pday: '2026-08-07', tzo: null }),  // RECONSTRUCTED offset
    tsNull({ id: 'rid:req_edge_hi', pday: '9999-12-31', tzo: null }), // calendar edges, where
    tsNull({ id: 'rid:req_edge_lo', pday: '0001-01-01', tzo: null }), // the offset may not exist
    tsNull({ id: 'rid:req_empty_ts', ts: '' }),                      // Number('') === 0
    base({ id: 'rid:req_nopday_dated', pday: null }),                // placeable, unpriceable
  ];
  // `ts` ABSENT is a different state from `ts: null` and JSON can carry both — one as a
  // missing key, one as an explicit null. It coerced to NaN, not 0, which is how the same
  // row reached EVERY window instead of none.
  const absent = Object.assign({}, base({ id: 'rid:req_ts_absent' }));
  delete absent.ts;
  rows.push(absent);
  return rows;
}

const PLACEMENT_JS = `
const store = require(${JSON.stringify(STORE_JS)});
const rows = JSON.parse(process.argv[1]);
const wins = JSON.parse(process.argv[2]);
const state = JSON.parse(process.argv[3]);
const out = [];
const i = (v) => (v === null || v === undefined ? 'null' : String(Math.round(Number(v))));
const m = (v) => {
  if (v === null || v === undefined) return 'null';
  let s = Number(v).toFixed(10);
  if (/^-0\\.0+$/.test(s)) s = s.slice(1);
  return s;
};
const COUNTS = ['calls', 'tokens', 'credited', 'offset'];
const MONEY = ['saved', 'spent', 'baseline', 'gross', 'extra'];
const SIDES = ['measured', 'estimated'];
function acc(prefix, a) {
  if (!a) { out.push(prefix + '|null'); return; }
  for (const f of COUNTS) out.push(prefix + '.' + f + '|' + i(a[f]));
  for (const f of MONEY) out.push(prefix + '.' + f + '|' + m(a[f]));
}
// ROWS SEEN per basis. An ABSENT events object emits null on both sides rather than a
// zero, so "this surface stated no count" can never be diffed as "this surface stated
// zero" -- the same distinction the dollar columns make.
function evs(prefix, e) {
  for (const s of SIDES) {
    out.push(prefix + '.events.' + s + '|' + (e ? i(e[s]) : 'null'));
  }
}
for (let w = 0; w < wins.length; w++) {
  const from = wins[w][0];
  const to = wins[w][1];
  const rep = store.reportWindow(rows, from, to, { state });
  out.push('w' + w + '|status|' + String(rep.status));
  out.push('w' + w + '|undated|' + i(rep.undated));
  out.push('w' + w + '|unpriced_calls|' + i(rep.unpricedCalls));
  out.push('w' + w + '|suppressed|' + (rep.dollars_suppressed ? '1' : '0'));
  acc('w' + w + '|measured', rep.measured);
  acc('w' + w + '|estimated', rep.estimated);
  evs('w' + w, rep.events);
  for (const dim of ['served', 'base']) {
    const gs = store.reportBreakdown(rows, dim, from, to);
    for (const g of gs) {
      const p = 'b' + w + '|' + dim + '|' + g.key;
      out.push(p + '|unpriced_calls|' + i(g.unpricedCalls));
      out.push(p + '|suppressed|' + (g.dollars_suppressed ? '1' : '0'));
      acc(p + '|measured', g.measured);
      acc(p + '|estimated', g.estimated);
      evs(p, g.events);
    }
  }
  const ps = store.reportTrend(rows, 'day', from, to);
  out.push('t' + w + '|order|' + ps.map((p) => p.bucket).join(','));
  for (const p of ps) {
    const q = 't' + w + '|' + p.bucket;
    out.push(q + '|undatable|' + (p.undatable ? '1' : '0'));
    out.push(q + '|unpriced_calls|' + i(p.unpricedCalls));
    out.push(q + '|suppressed|' + (p.dollars_suppressed ? '1' : '0'));
    acc(q + '|measured', p.measured);
    acc(q + '|estimated', p.estimated);
    evs(q, p.events);
  }
}
console.log(out.sort().join('\\n'));
`;

const PLACEMENT_PY = `
import json, sys
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
import reporting
rows = json.loads(sys.argv[1]); wins = json.loads(sys.argv[2])
state = json.loads(sys.argv[3])
out = []
def i(v):
    return 'null' if v is None else str(int(round(float(v))))
def m(v):
    if v is None:
        return 'null'
    s = '%.10f' % float(v)
    if s.startswith('-0.') and set(s[3:]) == {'0'}:
        s = s[1:]
    return s
COUNTS = ('calls', 'tokens', 'credited', 'offset')
MONEY = ('saved', 'spent', 'baseline', 'gross', 'extra')
SIDES = ('measured', 'estimated')
def acc(prefix, a):
    if not a:
        out.append(prefix + '|null')
        return
    for f in COUNTS:
        out.append(prefix + '.' + f + '|' + i(a.get(f)))
    for f in MONEY:
        out.append(prefix + '.' + f + '|' + m(a.get(f)))
def evs(prefix, e):
    for s in SIDES:
        out.append(prefix + '.events.' + s + '|' + (i(e[s]) if e else 'null'))
for w, (frm, to) in enumerate(wins):
    rep = reporting.report_window(rows, frm, to, state, 'UTC')
    out.append('w%d|status|%s' % (w, rep.get('status')))
    out.append('w%d|undated|%s' % (w, i(rep.get('undated'))))
    out.append('w%d|unpriced_calls|%s' % (w, i(rep.get('unpriced_calls'))))
    out.append('w%d|suppressed|%s' % (w, '1' if rep.get('dollars_suppressed') else '0'))
    acc('w%d|measured' % w, rep.get('measured'))
    acc('w%d|estimated' % w, rep.get('estimated'))
    evs('w%d' % w, rep.get('events'))
    for dim in ('served', 'base'):
        for g in reporting.report_breakdown(rows, dim, frm, to):
            p = 'b%d|%s|%s' % (w, dim, g['key'])
            out.append(p + '|unpriced_calls|' + i(g['unpriced_calls']))
            out.append(p + '|suppressed|' + ('1' if g.get('dollars_suppressed') else '0'))
            acc(p + '|measured', g['measured'])
            acc(p + '|estimated', g['estimated'])
            evs(p, g.get('events'))
    ps = reporting.report_trend(rows, 'day', frm, to)
    out.append('t%d|order|%s' % (w, ','.join(str(p['bucket']) for p in ps)))
    for p in ps:
        q = 't%d|%s' % (w, p['bucket'])
        out.append(q + '|undatable|' + ('1' if p['undatable'] else '0'))
        out.append(q + '|unpriced_calls|' + i(p['unpriced_calls']))
        out.append(q + '|suppressed|' + ('1' if p.get('dollars_suppressed') else '0'))
        acc(q + '|measured', p['measured'])
        acc(q + '|estimated', p['estimated'])
        evs(q, p.get('events'))
print('\\n'.join(sorted(out)))
`;

// `events` IS COMPARED, on every window, every breakdown group and every trend point.
//
// It used to be excluded, with a stated reason: "the CLI reports every row it SAW in a
// window while the gateway reports the rows it PRICED — both are defensible, but they
// are different questions". That reason was the DEFECT, not a justification for skipping
// it. One field name meaning two things in two runtimes, published under the same key to
// the same consumers (`cheaper reports --json` and `cheaper savings --json` return the
// GATEWAY shape when the gateway answers and the LOCAL shape when it does not), is
// exactly what a cross-runtime gate exists to catch — and the gateway's reading rendered
// a self-contradiction on the dashboard: `events.measured = 0` under the header
// "Events (measured)", with a tooltip saying "1 of these could not be priced" and a note
// beneath saying "1 of 1 call(s) in this window ... Call and token counts are exact".
// Both sides now report ROWS SEEN, and the exclusion is gone rather than re-argued.
//
// `dollars_suppressed` IS COMPARED on the same three shapes, for the same reason. Both
// runtimes computed it inside `foldRows`/`fold_rows` for every breakdown group and every
// trend point and then discarded it, publishing raw accumulators next to a ladder row
// that said "no dollar figure is claimed" over the SAME rows. The flag is now emitted by
// both and diffed here, so the withholding decision cannot be applied on one side only —
// which is exactly how the two blockers this gate exists for were introduced.
//
// WHAT THIS GATE DELIBERATELY DOES NOT COMPARE, stated rather than hidden:
//
//   * `labels` / `notes` — the gateway additionally discloses `dated_by_frozen_day`; the
//     CLI does not carry that provenance counter.
//   * the ORDER of breakdown groups (lines are sorted before diffing). The order of trend
//     points IS compared, as one `order` line per window, because the trailing `undated`
//     point must stay last.
//   * `tier` / `decision` breakdown dimensions, whose group KEYS are derived differently
//     on the two sides today.
//
// `py` is always a resolved {cmd, args} launcher, for the reason given above pdayParity.
function placementParity(py) {
  const rowsJson = JSON.stringify(placementRows());
  const winsJson = JSON.stringify(PLACEMENT_WINDOWS);
  const stateJson = JSON.stringify(PLACEMENT_STATE);
  const args = [rowsJson, winsJson, stateJson];
  let compared = 0;
  const diffs = [];
  for (const tz of ZONES) {
    const j = runIn(tz, process.execPath, ['-e', PLACEMENT_JS].concat(args));
    const p = runIn(tz, py.cmd, [...py.args, '-c', PLACEMENT_PY].concat(args));
    if (j.err) { console.error(`  placement parity FAILED (JS, ${tz}):\n${j.err}`); process.exit(1); }
    if (p.err) { console.error(`  placement parity FAILED (PY, ${tz}):\n${p.err}`); process.exit(1); }
    if (j.out.length !== p.out.length) {
      // A row count mismatch IS a divergence: a breakdown group or a trend bucket exists
      // on one side and not on the other.
      const only = (a, b) => a.filter((x) => !b.includes(x)).slice(0, 6);
      console.error(`  placement parity FAILED: ${tz} produced ${j.out.length} JS lines, `
        + `${p.out.length} Python lines`);
      for (const x of only(j.out, p.out)) console.error(`    [${tz}] JS only  ${x}`);
      for (const x of only(p.out, j.out)) console.error(`    [${tz}] PY only  ${x}`);
      process.exit(1);
    }
    for (let k = 0; k < j.out.length; k++) {
      compared += 1;
      if (j.out[k] !== p.out[k]) diffs.push({ tz, js: j.out[k], py: p.out[k] });
    }
  }
  if (diffs.length) {
    console.error(`  placement parity FAILED: ${diffs.length} of ${compared} disagree`);
    for (const d of diffs.slice(0, 12)) {
      console.error(`    [${d.tz}] JS  ${d.js}\n    [${d.tz}] PY  ${d.py}`);
    }
    if (diffs.length > 12) console.error(`    … and ${diffs.length - 12} more`);
    process.exit(1);
  }
  console.log(`  window-placement parity OK — ${compared} figures identical across `
    + `${ZONES.length} zones × ${PLACEMENT_WINDOWS.length} windows (JS ↔ Python)`);
}

function main() {
  // Resolved BEFORE any fixture work. With no interpreter there is nothing to diff, and
  // the failure should land immediately rather than after 1400 JS rows nobody compares.
  //
  // ONE resolution for all three gates. Three copies of the probe meant three chances to
  // disagree about whether Python is present, and the pday/placement copies used
  // `-c pass` while this one used the real payload.
  const exe = pyExe();
  if (exe === null) {
    // NOT a skip, and deliberately not worded as one. A parity gate that quietly does not
    // run is indistinguishable from one that passed — and noticing drift is this gate's
    // entire job, so "I could not check" must never be reported in the same shape, on the
    // same stream, with the same exit code as "I checked and both runtimes agree".
    //
    // This was not hypothetical. The probe used to be a second copy living in this file
    // that tried only `python3` and `python`. On a stock python.org Windows install with
    // "Add python.exe to PATH" left unchecked — the DEFAULT — neither of those resolves to
    // a real interpreter and only `py -3` does, so all three gates below skipped, silently
    // and with exit 0, on exactly the platform whose JS<->Python drift nobody else was
    // watching. The shared `pyExe()` fixed the DISCOVERY; exiting non-zero fixes the
    // REPORTING, which was the half that let the first failure hide.
    //
    // `check-policy-parity.js` already made this call for the routing gate; a missing
    // interpreter now fails both, identically, rather than one loudly and one in silence.
    console.error(`  period parity: DID NOT RUN — ${NO_PY}`);
    process.exit(1);
  }
  const js = jsSide();
  const py = pySide(exe);
  if (js.length !== py.length) {
    console.error(`  period parity FAILED: JS produced ${js.length} rows, Python ${py.length}`);
    process.exit(1);
  }
  const diffs = [];
  for (let i = 0; i < js.length; i++) {
    // JS reports ±Infinity where Python reports None; normalise before comparing.
    const a = js[i].replace(/\|-?Infinity/g, '|null');
    if (a !== py[i]) diffs.push({ js: a, py: py[i] });
  }
  if (diffs.length) {
    console.error(`  period parity FAILED: ${diffs.length} of ${js.length} bounds disagree`);
    for (const d of diffs.slice(0, 12)) {
      console.error(`    JS  ${d.js}\n    PY  ${d.py}`);
    }
    if (diffs.length > 12) console.error(`    … and ${diffs.length - 12} more`);
    process.exit(1);
  }
  console.log(`  period parity OK — ${js.length} bounds identical across `
    + `${ZONES.length} zones × ${INSTANTS.length} instants (JS ↔ Python)`);
  pdayParity(exe);
  placementParity(exe);
}

main();
