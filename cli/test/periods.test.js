'use strict';
// Calendar-period bucketing math — the correctness-critical part of `cheaper savings`.
// A fixed `now` is passed in so these are deterministic on any machine/timezone.

const test = require('node:test');
const assert = require('node:assert');
const { bucket, startOfWeek, startOfQuarter } = require('../src/peek/periods');

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
