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
// Usage:  node scripts/check-period-parity.js [--check]
// Exits non-zero on ANY millisecond of disagreement.

const path = require('path');
const { spawnSync } = require('child_process');

const P = require(path.join(__dirname, '..', 'src', 'peek', 'periods.js'));
const PY_DIR = path.join(__dirname, '..', 'assets', 'gateway', 'app');

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

function pySide() {
  for (const exe of ['python3', 'python']) {
    const r = spawnSync(exe, ['-c', PY, JSON.stringify(ZONES), JSON.stringify(INSTANTS)],
      { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.trim().split('\n');
    if (r.status !== null && r.error === undefined && r.stderr) {
      // Python is present but the module blew up — that IS a failure, not a skip.
      console.error(r.stderr.trim());
      process.exit(1);
    }
  }
  return null;
}

function main() {
  const js = jsSide();
  const py = pySide();
  if (py === null) {
    // No Python at all (a JS-only CI lane). Report loudly and pass: silently
    // "succeeding" on a gate that never ran is how a parity check becomes decoration.
    console.log('  period parity: SKIPPED — no python3 on PATH (the gate did not run)');
    return;
  }
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
}

main();
