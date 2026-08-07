'use strict';
// `cheaper reports --json | --terminal` — the Reports view, in the terminal.
//
// Four blocks, matching the dashboard exactly so the two can never tell different
// stories: the DISJOINT period ladder with its literal local bounds printed, a
// period-over-period comparison with an explicit `n` on both sides, composition by
// served/baseline/tier/harness, and a dated trend.
//
// Saved, Spent AND Events each get the two-column measured/estimated treatment or are
// omitted. Adding a per-call measured figure to a per-chat estimated one — "82 events"
// from 76 gateway CALLS plus 6 ledger CHATS that themselves contain thousands of calls —
// is the same concealment shape in a column where the separation is less obvious.

const { c } = require('./util');
const api = require('./api');
const store = require('./peek/store');
const periods = require('./peek/periods');
const render = require('./peek/render');
const { CATALOG_AS_OF } = require('./peek/models');

function money(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return null;
  const v = Number(n);
  const neg = v < 0;
  const a = Math.abs(v);
  return (neg ? '-' : '') + '$' + a.toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseArgs(argv) {
  const o = { json: false, terminal: false, tz: null, dim: 'served', bucket: 'day' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--terminal' || a === '--tty') o.terminal = true;
    else if (a === '--tz') o.tz = argv[++i];
    else if (a === '--dim') o.dim = argv[++i];
    else if (a === '--bucket') o.bucket = argv[++i];
  }
  return o;
}

function localReport(o) {
  const now = Date.now();
  store.ensureLegacyImported();
  const { rows, readStats, foldStats } = store.readRows({});
  const state = store.loadState();
  const tz = o.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const monthCmp = store.reportComparison(rows, 'month', now, tz, { state });
  const weekCmp = store.reportComparison(rows, 'week', now, tz, { state });
  const yearB = periods.periodBounds('year', now, tz);
  return {
    source: 'local-store',
    generated_at: now, tz,
    catalog: { as_of: CATALOG_AS_OF },
    periods: store.reportLadder(rows, now, tz, { state }),
    lifetime: store.reportWindow(rows, -Infinity, Infinity, { state }),
    comparisons: { month: monthCmp, week: weekCmp },
    breakdown: store.reportBreakdown(rows, o.dim, yearB.from, yearB.to),
    trend: store.reportTrend(rows, o.bucket, yearB.from, yearB.to),
    legacy: store.legacyTotals(),
    store: { segments: readStats.segments, rows: readStats.rows,
             partialTail: readStats.partialTail, fold: foldStats },
  };
}

async function fetchReport(o) {
  const res = await api.getJson('/api/v1/reports/periods' + api.qs({ tz: o.tz }));
  if (!res.ok) return Object.assign(localReport(o), { gatewayNote: api.explain(res) });
  const [bd, tr] = await Promise.all([
    api.getJson('/api/v1/reports/breakdown' + api.qs({ dim: o.dim, tz: o.tz })),
    api.getJson('/api/v1/reports/trend' + api.qs({ bucket: o.bucket, tz: o.tz })),
  ]);
  return Object.assign({ source: 'gateway' }, res.body, {
    breakdown: bd.ok ? (bd.body.rows || bd.body) : [],
    trend: tr.ok ? (tr.body.rows || tr.body) : [],
  });
}

// One two-column cell: measured on the left, estimated on the right, NEVER summed.
function pair(w, field) {
  if (!w) return c.dim('—').padEnd(30);
  if (w.status === 'not_covered') return c.dim('not covered').padEnd(30);
  // NOTE: there is deliberately no blanket `status === 'suppressed'` branch here.
  // Suppression withholds the MONEY only; the call counts are exact and are handled
  // per-accumulator below. Blanking the whole row discarded facts alongside the
  // figures we declined to derive.
  const m = w.measured;
  const e = w.estimated;
  const fmt = (acc) => {
    if (!acc || !acc.calls) return c.dim('—');
    if (field === 'calls') return String(acc.calls);
    const v = field === 'saved' ? acc.saved : acc.spent;
    // Under suppression the money is withheld and the counts are not. Printing $0.00
    // here would claim a measured zero; printing nothing would hide that calls happened.
    if (v === null || v === undefined) return c.amber('withheld');
    return (v < 0 ? c.red : c.green)(money(v));
  };
  const left = fmt(m);
  const right = fmt(e);
  // Padding is computed on the VISIBLE length so ANSI escapes don't skew the columns.
  const vis = (s) => s.replace(/\[[0-9;]*m/g, '').length;
  const cell = left + c.dim(' │ ') + right;
  return cell + ' '.repeat(Math.max(0, 30 - vis(cell)));
}

function bounds(w) {
  const f = Number.isFinite(w.from) ? new Date(w.from) : null;
  const t = Number.isFinite(w.to) ? new Date(w.to) : null;
  const d = (x) => (x ? x.toISOString().replace('T', ' ').slice(0, 16) : '—');
  return `${d(f)} → ${d(t)}`;
}

function renderReport(r) {
  console.log('');
  console.log('  ' + c.amber('cheaper reports') + c.dim('  — realized savings, by when the calls happened'));
  console.log('  ' + c.dim(`source: ${r.source}${r.gatewayNote ? ' (' + r.gatewayNote + ')' : ''}`
    + ` · timezone ${r.tz} · prices as of ${(r.catalog || {}).as_of}`));
  console.log('');

  // --- 1. the DISJOINT period ladder, with its literal local bounds printed ---------
  console.log('  ' + c.bold('Savings by period') + c.dim('   (disjoint windows — these ADD UP to lifetime)'));
  console.log('  ' + c.dim('period'.padEnd(22) + 'measured │ estimated'.padEnd(30) + 'window (local)'));
  console.log('  ' + c.dim('─'.repeat(90)));
  for (const w of (r.periods || [])) {
    console.log('  ' + c.bold(String(w.label).padEnd(22)) + pair(w, 'saved') + c.dim(bounds(w)));
    for (const n of (w.notes || [])) console.log('    ' + c.dim('↳ ' + n));
  }
  if (r.lifetime) {
    console.log('  ' + c.dim('─'.repeat(90)));
    console.log('  ' + c.bold('Lifetime'.padEnd(22)) + pair(r.lifetime, 'saved'));
  }
  if (r.legacy && r.legacy.chats) {
    console.log('  ' + c.bold('Legacy (pre-store)'.padEnd(22))
      + c.dim(money(r.legacy.usd) + ` · ${r.legacy.chats} chat-grain rows, dollars frozen,`)
      + c.dim(' excluded from every period above'));
  }
  console.log('');

  // --- 2. period over period, with an explicit n on BOTH sides ---------------------
  if (r.comparisons) {
    console.log('  ' + c.bold('Period over period') + c.dim('   (n is shown so a 400% jump on 3 events reads as noise)'));
    for (const k of Object.keys(r.comparisons)) {
      const cmp = r.comparisons[k];
      const nOf = (w) => ((w.measured ? w.measured.calls : 0) + (w.estimated ? w.estimated.calls : 0));
      console.log('  ' + c.bold(('this ' + k).padEnd(22)) + pair(cmp.current, 'saved')
        + c.dim(`n=${nOf(cmp.current)}`));
      console.log('  ' + c.dim(('vs last ' + k).padEnd(22)) + pair(cmp.previous, 'saved')
        + c.dim(`n=${nOf(cmp.previous)}`));
    }
    console.log('');
  }

  // --- 3. composition -------------------------------------------------------------
  const bd = r.breakdown || [];
  if (bd.length) {
    console.log('  ' + c.bold('Composition') + c.dim('   (by served model)'));
    console.log('  ' + c.dim('key'.padEnd(34) + 'measured │ estimated'.padEnd(30) + 'calls'));
    for (const g of bd.slice(0, 12)) {
      console.log('  ' + String(g.key).slice(0, 33).padEnd(34)
        + pair({ status: 'ok', measured: g.measured, estimated: g.estimated }, 'saved')
        + c.dim(String(g.calls)));
    }
    console.log('');
  }

  // --- 4. dated trend -------------------------------------------------------------
  const tr = r.trend || [];
  if (tr.length) {
    console.log('  ' + c.bold('Trend') + c.dim('   (bucketed on each call\'s OWN local day)'));
    const vals = tr.map((t) => (t.measured.saved || 0) + (t.estimated.saved || 0));
    const max = Math.max(1, ...vals.map(Math.abs));
    for (let i = 0; i < tr.length; i++) {
      const t = tr[i];
      const v = vals[i];
      const w = Math.round((Math.abs(v) / max) * 40);
      const bar = (v < 0 ? c.red : c.green)('█'.repeat(Math.max(v === 0 ? 0 : 1, w)));
      console.log('  ' + c.dim(String(t.bucket).padEnd(12)) + bar + ' ' + c.dim(money(v) || '—'));
    }
    console.log('');
  }

  console.log('  ' + c.dim('measured = observed by the Cheaper gateway from provider-reported usage.'));
  console.log('  ' + c.dim('estimated = reconstructed from local harness transcripts.'));
  console.log('  ' + c.dim('The two bases carry SEPARATE totals and are never summed. If you need one'));
  console.log('  ' + c.dim('number, state which basis it came from.'));
  console.log('');
}

async function run(argv = []) {
  const o = parseArgs(argv);
  // Unchanged default: open the browser at the Reports tab.
  if (!o.json && !o.terminal) return require('./launch').run(argv, { tab: 'reports' });
  const r = await fetchReport(o);
  if (o.json) { console.log(JSON.stringify(r, null, 2)); return; }
  renderReport(r);
}

module.exports = { run, parseArgs, localReport };
