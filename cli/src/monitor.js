'use strict';
const http = require('http');
const { c } = require('./util');
const { PORT } = require('./gateway');

function fetchMetrics() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/metrics`, (res) => {
      let d = '';
      res.on('data', (x) => (d += x));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
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
  console.log(c.dim('  recent:'));
  for (const r of (m.recent || []).slice(0, 10)) {
    const ts = new Date(r.ts * 1000).toLocaleTimeString();
    console.log(`   ${c.dim(ts)}  ${r.tier.padEnd(6)}  ${c.dim((r.reason || '').slice(0, 60))}`);
  }
}

async function run() {
  const tick = async () => {
    try { render(await fetchMetrics()); }
    catch {
      console.clear();
      console.log(c.red('\n  Cannot reach the gateway on port ' + PORT + '.'));
      console.log(c.dim('  Start it with:  ') + 'cheaper gateway start\n');
    }
  };
  await tick();
  setInterval(tick, 3000);
}

module.exports = { run, fetchMetrics };
