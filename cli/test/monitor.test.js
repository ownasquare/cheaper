'use strict';
// `cheaper monitor --terminal` prints every exclusion counted in `counts.unpriced`
// (generic over the dict's keys) plus, separately, `counts.billed_top_missing` — the
// priced rows the vs-all-frontier baseline could not cover. Both are EXCLUSIONS and the
// project rule is that every exclusion is counted AND visible, never a silently
// shrinking denominator.

const test = require('node:test');
const assert = require('node:assert');
const monitor = require('../src/monitor');

function captureRender(m) {
  const lines = [];
  const origLog = console.log;
  const origClear = console.clear;
  console.log = (...args) => { lines.push(args.join(' ')); };
  console.clear = () => {};
  try {
    monitor.render(m);
  } finally {
    console.log = origLog;
    console.clear = origClear;
  }
  // Strip ANSI escapes so substring assertions don't have to know about color codes.
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
}

function baseMetrics(overrides) {
  return Object.assign({
    total: 10, downgrade_rate: 50, est_savings_pct: 40,
    by_tier: {}, counts: {}, recent: [],
  }, overrides);
}

test('monitor prints every counts.unpriced reason generically, including undatable', () => {
  const out = captureRender(baseMetrics({
    counts: { unpriced: { estimated_usage: 2, non_2xx: 1, model_not_in_catalog: 0, undatable: 3 } },
  }));
  // model_not_in_catalog is 0 and must be OMITTED (the `.filter((k) => u[k])` guard) —
  // printing a reason with a zero count would misreport "we don't know" as an active
  // exclusion when nothing was actually excluded for that reason.
  assert.ok(out.includes('not priced:'), 'expected a "not priced:" line\n' + out);
  assert.ok(out.includes('2 estimated usage'), out);
  assert.ok(out.includes('1 non 2xx'), out);
  assert.ok(out.includes('3 undatable'), 'the new undatable reason must be counted and visible\n' + out);
  assert.ok(!out.includes('model not in catalog'), 'a zero-count reason must not be printed\n' + out);
});

test('monitor states counts.billed_top_missing — an exclusion from the all-frontier baseline', () => {
  const out = captureRender(baseMetrics({ counts: { billed_top_missing: 7 } }));
  assert.ok(out.includes('7 priced call(s) have no all-frontier'),
    'billed_top_missing must be counted and visible\n' + out);
  assert.ok(out.includes('vs-all-frontier baseline'), out);
});

test('monitor prints neither line when there is nothing to exclude', () => {
  const out = captureRender(baseMetrics({ counts: { unpriced: {}, billed_top_missing: 0 } }));
  assert.ok(!out.includes('not priced:'), out);
  assert.ok(!out.includes('all-frontier'), out);
});
