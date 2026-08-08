'use strict';
// Calendar-period bucketing math — the correctness-critical part of `cheaper savings`.
// A fixed `now` is passed in so these are deterministic on any machine/timezone.

const test = require('node:test');
const assert = require('node:assert');
const { bucket, startOfWeek, startOfQuarter, pdayOf, tzOffsetAt } = require('../src/peek/periods');

test('periods nest: today ⊆ week ⊆ month ⊆ quarter ⊆ year ⊆ all', () => {
  const now = new Date(2026, 7, 6, 12, 0, 0); // Thu 2026-08-06 12:00 local
  const items = [
    { at: new Date(2026, 7, 6, 9).getTime(), usd: 10 },   // today  (Thu Aug 6)
    { at: new Date(2026, 7, 4, 9).getTime(), usd: 20 },   // week   (Tue Aug 4)
    { at: new Date(2026, 7, 1, 9).getTime(), usd: 30 },   // month  (Sat Aug 1)
    { at: new Date(2026, 6, 15, 9).getTime(), usd: 40 },  // quarter(Jul 15)
    { at: new Date(2026, 2, 1, 9).getTime(), usd: 50 },   // year   (Mar 1)
    { at: new Date(2025, 11, 1, 9).getTime(), usd: 60 },  // all    (Dec 1 2025)
  ];
  const b = bucket(items, (e) => e.at, (e) => e.usd, () => 0, now);
  assert.deepEqual(
    [b.today.count, b.week.count, b.month.count, b.quarter.count, b.year.count, b.all.count],
    [1, 2, 3, 4, 5, 6]);
  assert.equal(b.today.usd, 10);
  assert.equal(b.week.usd, 30);     // 10 + 20
  assert.equal(b.month.usd, 60);    // + 30
  assert.equal(b.quarter.usd, 100); // + 40
  assert.equal(b.year.usd, 150);    // + 50
  assert.equal(b.all.usd, 210);     // + 60
});

test('week starts Monday (local)', () => {
  assert.equal(startOfWeek(new Date(2026, 7, 9, 12)), new Date(2026, 7, 3).getTime()); // Sun -> prev Mon
  assert.equal(startOfWeek(new Date(2026, 7, 10, 12)), new Date(2026, 7, 10).getTime()); // Mon -> itself
});

test('quarter starts on Jan/Apr/Jul/Oct', () => {
  assert.equal(startOfQuarter(new Date(2026, 7, 6)), new Date(2026, 6, 1).getTime());  // Aug -> Jul 1 (Q3)
  assert.equal(startOfQuarter(new Date(2026, 0, 20)), new Date(2026, 0, 1).getTime()); // Jan -> Jan 1 (Q1)
  assert.equal(startOfQuarter(new Date(2026, 11, 31)), new Date(2026, 9, 1).getTime()); // Dec -> Oct 1 (Q4)
});

test('amounts are signed: a period that nets negative reports negative', () => {
  const now = new Date(2026, 7, 6, 12);
  const items = [
    { at: new Date(2026, 7, 6, 9).getTime(), usd: -5 },
    { at: new Date(2026, 7, 6, 10).getTime(), usd: 2 },
  ];
  const b = bucket(items, (e) => e.at, (e) => e.usd, () => 0, now);
  assert.equal(b.today.usd, -3);
});

test('ISO-string timestamps parse and bucket', () => {
  const now = new Date(2026, 7, 6, 12);
  const items = [{ at: new Date(2026, 7, 6, 9).toISOString(), usd: 7, tokens: 1000 }];
  const b = bucket(items, (e) => e.at, (e) => e.usd, (e) => e.tokens, now);
  assert.equal(b.today.usd, 7);
  assert.equal(b.today.tokens, 1000);
});

// ---- pdayOf: the ONE TIME FRAME ----------------------------------------------------
// Cross-runtime parity against gateway/app/periods.py::pday_of is enforced by
// scripts/check-period-parity.js over a zone × instant × offset matrix. These are the
// in-runtime contracts that matrix depends on.

const PDAY_MS = 1756700000000;      // 2025-09-01T00:13:20Z — 2025-08-31 at UTC-7

test('an EXPLICIT offset is honoured, including the explicit zero', () => {
  assert.equal(pdayOf(PDAY_MS, 0), '2025-09-01');       // 0 is a VALUE, not "absent"
  assert.equal(pdayOf(PDAY_MS, -420), '2025-08-31');
  assert.equal(pdayOf(PDAY_MS, 330), '2025-09-01');     // half-hour zone
  assert.equal(pdayOf(PDAY_MS, 345), '2025-09-01');     // 45-minute zone
  // Fractional offsets truncate, matching Python's int().
  assert.equal(pdayOf(PDAY_MS, -420.9), pdayOf(PDAY_MS, -420));
});

test('a MISSING offset reconstructs from the machine — it is never read as UTC', () => {
  // `Number(null)` is 0, so `Number.isFinite(Number(tzo))` used to route a NULLED offset
  // to UTC while an UNDEFINED one reconstructed — two answers for one state. store.merge
  // nulls `tzo` whenever two sources disagree about a row's frame, so this was reachable,
  // and across the claude-sonnet-5 promo boundary it is a 50% dollar split.
  const expected = pdayOf(PDAY_MS, tzOffsetAt(PDAY_MS));
  for (const absent of [undefined, null, '', '   ', 'abc', NaN]) {
    assert.equal(pdayOf(PDAY_MS, absent), expected,
      `tzo=${JSON.stringify(absent)} must reconstruct, not fall back to UTC`);
  }
});

test('an instant no calendar can render returns null, never a confident wrong date', () => {
  // metrics.db stores SECONDS; the event store and this module use MILLISECONDS. A unit
  // slip lands in year 55840, which Python's datetime cannot represent at all — so both
  // runtimes must answer null and the row becomes a COUNTED exclusion, not an outage
  // and not a year-55840 bucket.
  assert.equal(pdayOf(1.7e15, 0), null);
  assert.equal(pdayOf(2.6e14, 0), null);      // year 10209, just past datetime's range
  assert.equal(pdayOf(-1e18, 0), null);       // beyond the JS Date range entirely
  assert.equal(pdayOf(NaN, 0), null);
  assert.equal(pdayOf('not-a-date', 0), null);
  // ...and it still answers for everything inside the range.
  assert.equal(pdayOf(PDAY_MS, -420), '2025-08-31');
});

// The representable calendar: [0001-01-01T00:00:00Z, 10000-01-01T00:00:00Z).
const CAL_MIN_MS = -62135596800000;
const CAL_MAX_MS = 253402300800000;

test('a RECONSTRUCTED offset is refused outside the calendar — both runtimes answer null',
  () => {
    // The reconstructed offset is the one input the two runtimes cannot be assumed to
    // agree on at the calendar edges: Python could not determine a machine offset for an
    // instant its datetime cannot represent and substituted 0, while JS shifted by the
    // machine's real offset. The parity gate found 12 real divergences there, ALL of them
    // pday answers:
    //   ms = CAL_MIN_MS and CAL_MIN_MS+1   JS null          vs  PY '0001-01-01'
    //   ms = CAL_MAX_MS                    JS '9999-12-31'  vs  PY null
    // Whether a date EXISTS must not depend on which runtime asked, nor on which side of
    // UTC this machine sits — so both now refuse to reconstruct outside the calendar.
    //
    // MACHINE-ZONE INDEPENDENT, which is why this test can assert a literal null: the
    // refusal is decided by the raw instant, before any offset is read.
    for (const absent of [undefined, null, '', 'abc']) {
      assert.equal(pdayOf(CAL_MAX_MS, absent), null,
        `tzo=${JSON.stringify(absent)} at year 10000 must not be pulled back into 9999`);
      assert.equal(pdayOf(CAL_MIN_MS - 1, absent), null);
    }
    // The EXPLICIT path is UNTOUCHED, and the guard must therefore sit INSIDE the
    // reconstruction branch: a recorded offset is a fact about the row, not a reading of
    // this machine, and both runtimes shift by it identically. Hoisting the guard above
    // the `tzo` branch — the obvious over-correction — turns the third assertion here
    // into null and reintroduces the divergence the other way round.
    assert.equal(pdayOf(CAL_MAX_MS - 1, -480), '9999-12-31');
    assert.equal(pdayOf(CAL_MIN_MS, 0), '0001-01-01');
    // Raw instant OUTSIDE the calendar, offset EXPLICIT: still an answer, because the
    // offset carries it back inside. Both runtimes have always agreed here.
    assert.equal(pdayOf(CAL_MAX_MS, -480), '9999-12-31');
    // And the last representable instant still reconstructs — the guard bounds the
    // refusal, it does not swallow the range.
    assert.equal(pdayOf(CAL_MAX_MS - 1, undefined),
      pdayOf(CAL_MAX_MS - 1, tzOffsetAt(CAL_MAX_MS - 1)));
  });
