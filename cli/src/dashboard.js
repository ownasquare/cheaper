'use strict';
// `cheaper dashboard --json` — the whole Dashboard tab as one machine-readable object.
//
// Composes the three panels the browser view shows, and keeps them SEPARATE rather than
// summing them into a headline. `metrics.summary().dollars.saved` (gateway, measured,
// per CALL) + `savings.compute()` (the event store, per CALL) + `peek.totals` (a
// COUNTERFACTUAL about calls that were never routed) is a triple count by construction,
// in any combination — so this returns three labelled blocks and no total.

const { c } = require('./util');
const api = require('./api');
const savings = require('./savings');

function parseArgs(argv) {
  const o = { json: false, peek: true };
  for (const a of argv || []) {
    if (a === '--json') o.json = true;
    else if (a === '--no-peek') o.peek = false;
  }
  return o;
}

async function collect(o) {
  const [metrics, peek] = await Promise.all([
    api.getJson('/metrics'),
    o.peek ? api.getJson('/peek') : Promise.resolve({ ok: false }),
  ]);
  return {
    generated_at: Date.now(),
    // BASIS 1 — measured by the proxy, per call. Only rows with provider-reported
    // usage and a 2xx status contribute.
    gateway: metrics.ok ? metrics.body : { available: false, error: api.explain(metrics) },
    // BASIS 2 — the per-call event store, bucketed on each call's own local day.
    savings: savings.compute(),
    // BASIS 3 — a COUNTERFACTUAL. `peek` estimates what routing WOULD have saved on
    // calls that were never routed. It is not an event and must never be added to
    // either basis above.
    peek: peek.ok ? peek.body : { available: false },
    note: 'gateway / savings / peek are three different measurement bases. They are '
      + 'never summed: peek is a counterfactual about calls that did not route, and '
      + 'adding it to realized savings would count the same money twice.',
  };
}

async function run(argv = []) {
  const o = parseArgs(argv);
  const data = await collect(o);
  if (o.json) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log('');
  console.log('  ' + c.amber('cheaper dashboard') + c.dim('  — use --json, or open the browser view with `cheaper dashboard`'));
  console.log('');
}

module.exports = { run, collect, parseArgs };
