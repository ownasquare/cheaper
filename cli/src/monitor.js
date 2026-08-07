'use strict';
// `cheaper monitor` — the live routing view.
//
//   (no flags)            open the browser Monitor tab   [unchanged default]
//   --terminal / --tty    the in-terminal TUI, refreshing every 3s
//   --json                print the raw /metrics payload, ONCE, and exit
//   --json --watch        stream a JSON line every 3s
//
// `--json` matters because the TUI's setInterval + console.clear loop is unusable from
// a script: there was no way to get these numbers into a pipeline at all.

const { c } = require('./util');
const api = require('./api');
const { PORT } = require('./gateway');

// Authenticated — the gateway gates /metrics on the same-machine token so another user
// on this box cannot read the owner's usage record over loopback.
async function fetchMetrics() {
  const res = await api.getJson('/metrics');
  if (!res.ok) throw new Error(api.explain(res));
  return res.body;
}

function render(m) {
  const t = m.by_tier || {};
  const n = (k) => (t[k] && t[k].count) || 0;
  console.clear();
  console.log(c.amber('\n  Cheaper monitor') + c.dim(`   (gateway :${PORT}, refresh 3s, Ctrl-C to exit)\n`));
  console.log(`  Total routed     ${c.bold(String(m.total))}`);
  console.log(`  Downgrade rate   ${c.amber(m.downgrade_rate + '%')}`);
  console.log(`  Est. savings     ${c.amber(m.est_savings_pct + '%')}  ${c.dim('vs all-top-tier')}`);
  console.log(`  Haiku/Sonnet/Opus  ${c.green(n('haiku'))} / ${n('sonnet')} / ${c.red(n('opus'))}\n`);
  // Rows excluded from every dollar figure, and WHY. A shrinking denominator that
  // nobody prints is how "we weren't watching" becomes indistinguishable from "$0.00".
  const u = (m.counts && m.counts.unpriced) || {};
  const un = Object.keys(u).filter((k) => u[k]);
  if (un.length) {
    console.log('  ' + c.dim('not priced: ' + un.map((k) => `${u[k]} ${k.replace(/_/g, ' ')}`).join(', ')));
  }
  if (m.counts && m.counts.truncated) {
    console.log('  ' + c.amber(`  aggregates cover the newest ${m.counts.examined} rows of ${m.total}`));
  }
  console.log(c.dim('\n  recent:'));
  for (const r of (m.recent || []).slice(0, 10)) {
    const ts = new Date(r.ts * 1000).toLocaleTimeString();
    console.log(`   ${c.dim(ts)}  ${String(r.tier || '').padEnd(6)}  ${c.dim((r.reason || '').slice(0, 60))}`);
  }
}

function parseArgs(argv) {
  const o = { json: false, watch: false, terminal: false, once: false };
  for (const a of argv || []) {
    if (a === '--json') o.json = true;
    else if (a === '--watch') o.watch = true;
    else if (a === '--terminal' || a === '--tty') o.terminal = true;
    else if (a === '--once') o.once = true;
  }
  return o;
}

async function run(argv = []) {
  const o = parseArgs(argv);

  if (o.json) {
    try {
      const m = await fetchMetrics();
      console.log(JSON.stringify(m, null, 2));
    } catch (e) {
      // Machine-readable failure too: a script must be able to tell "gateway down" from
      // "zero savings" without parsing prose.
      console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }, null, 2));
      process.exitCode = 1;
      return;
    }
    if (!o.watch) return;
    setInterval(async () => {
      try { console.log(JSON.stringify(await fetchMetrics())); } catch { /* transient */ }
    }, 3000);
    return;
  }

  // First probe. If the gateway isn't up, don't spin a failing 3s loop — print one
  // clear, actionable hint and exit.
  let first = null;
  try { first = await fetchMetrics(); } catch (e) {
    console.log(c.red('\n  The gateway isn’t answering on port ' + PORT + '.'));
    console.log('  ' + c.dim(String(e && e.message || e)));
    console.log(c.dim('  Start it + open the live dashboard:  ') + c.bold('cheaper dashboard'));
    console.log(c.dim('  Gateway only (terminal monitor):     ') + 'cheaper gateway start'
      + c.dim(', then ') + 'cheaper monitor --terminal\n');
    process.exitCode = 1;
    return;
  }
  render(first);
  if (o.once) return;
  setInterval(async () => {
    try { render(await fetchMetrics()); } catch { /* transient — keep the last frame */ }
  }, 3000);
}

module.exports = { run, fetchMetrics, parseArgs };
