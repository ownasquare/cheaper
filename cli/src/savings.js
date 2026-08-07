'use strict';
// `cheaper savings` — realized routing savings bucketed by calendar period:
//   Today · This week · This month · This quarter · This year · All-time (lifetime).
// Reads the local lifetime ledger (each chat's realized $ + tokens, timestamped by
// when its end-of-chat tagline last ran). Read-only, zero-dependency.
//
// This is the "what we actually saved, over time" view — distinct from `cheaper peek`,
// which estimates what you WOULD save on logs that were never routed.

const ledger = require('./peek/ledger');
const { bucket, ORDER } = require('./peek/periods');
const { c } = require('./util');
const render = require('./peek/render');

const LABELS = {
  today: 'Today', week: 'This week', month: 'This month',
  quarter: 'This quarter', year: 'This year', all: 'All-time (lifetime)',
};

function money(n) {
  n = Number(n) || 0;
  const neg = n < 0;
  const v0 = Math.abs(n);
  const v = v0 >= 100 ? Math.round(v0) : Math.round(v0 * 100) / 100;
  return (neg ? '-' : '') + '$' + v.toLocaleString('en-US',
    { minimumFractionDigits: v0 >= 100 ? 0 : 2, maximumFractionDigits: 2 });
}

// Bucketed realized savings from the ledger. Exposed so the dashboard/other callers
// can reuse the same numbers.
function compute() {
  const data = ledger.load();
  const chats = Object.keys(data.chats || {}).map((k) => data.chats[k]);
  return bucket(chats, (e) => e.at, (e) => e.usd, (e) => e.tokens);
}

function run(argv = []) {
  const b = compute();
  if ((argv || []).includes('--json')) { console.log(JSON.stringify(b, null, 2)); return; }
  const tok = render.tokens;
  console.log('');
  console.log('  ' + c.amber('cheaper savings') + c.dim('  — realized routing savings by period'));
  console.log('');
  for (const k of ORDER) {
    const r = b[k];
    const amt = r.usd < 0 ? c.red(money(r.usd)) : c.green(money(r.usd));
    console.log('  ' + c.bold(LABELS[k].padEnd(20)) + amt +
      c.dim('   ' + tok(r.tokens) + ' tokens · ' + r.count + ' chat' + (r.count === 1 ? '' : 's')));
  }
  console.log('');
  console.log('  ' + c.dim('Realized from routing (delegated sub-agents + the gateway proxy).'));
  console.log('  ' + c.dim('What you could still save from existing logs:  ') + c.bold('cheaper peek'));
  console.log('');
}

module.exports = { run, compute };
