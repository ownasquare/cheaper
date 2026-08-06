'use strict';
// `cheaper peek` — scan local harness chat histories and estimate the tokens and
// real dollars adaptive routing would have saved, WITHOUT sending anything
// anywhere. Fully local, read-only, zero-dependency. Also the shared core the
// desktop app calls (via scan()) to render the same numbers in a window.

const { scan } = require('./scan');
const { render } = require('./render');

function parseArgs(argv) {
  const o = { json: false, sinceDays: 0, limit: 3, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--days' || a === '-d') o.sinceDays = parseInt(argv[++i], 10) || 0;
    else if (a === '--harness' || a === '-H') o.only = (argv[++i] || '').toLowerCase();
    else if (a === '--limit' || a === '-l') o.limit = parseInt(argv[++i], 10) || 3;
    else if (a.startsWith('--days=')) o.sinceDays = parseInt(a.slice(7), 10) || 0;
    else if (a.startsWith('--harness=')) o.only = a.slice(10).toLowerCase();
    else if (a.startsWith('--limit=')) o.limit = parseInt(a.slice(8), 10) || 3;
  }
  return o;
}

function run(argv = []) {
  const o = parseArgs(argv);
  const report = scan({ sinceDays: o.sinceDays, limit: o.limit, only: o.only });
  if (o.json) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(render(report));
}

module.exports = { run, scan, render, parseArgs };
