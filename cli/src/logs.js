'use strict';
// `cheaper logs --json | --terminal` — the audit register, in the terminal.
//
// The no-flag default still OPENS THE BROWSER. That is muscle memory and changing it
// silently would be a worse regression than the missing feature this adds.
//
// Two sources, in this order:
//   1. the running gateway's /api/v1/logs — the authoritative fold of BOTH the
//      per-call event store and the proxy's own metrics.db;
//   2. the local event store directly, when the gateway is not running (the normal
//      case for a user who has never started the proxy).
// It never computes its own dollars from a third path: the moment two surfaces derive
// the same figure independently, they are free to disagree.

const { c } = require('./util');
const api = require('./api');
const store = require('./peek/store');
const { deriveRow } = require('./peek/derive');
const render = require('./peek/render');

function money(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  const neg = n < 0;
  const a = Math.abs(n);
  return (neg ? '-' : '') + '$' + a.toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: a < 0.01 ? 4 : 2 });
}

// An unpriceable cell renders as an em dash, NEVER as $0.00. Zero is a measured result;
// "no figure is claimed" is not, and rendering the second as the first is the exact
// concealment this register exists to prevent.
function cost(v, why) {
  const m = money(v);
  if (m === null) return c.dim('—') + (why ? '' : '');
  return m;
}

function parseArgs(argv) {
  const o = { json: false, terminal: false, limit: 50, session: null, from: null,
              to: null, basis: null, decision: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--terminal' || a === '--tty') o.terminal = true;
    else if (a === '--limit') o.limit = Math.max(1, Math.min(1000, parseInt(argv[++i], 10) || 50));
    else if (a === '--session') o.session = argv[++i];
    else if (a === '--from') o.from = argv[++i];
    else if (a === '--to') o.to = argv[++i];
    else if (a === '--basis') o.basis = argv[++i];
    else if (a === '--decision') o.decision = argv[++i];
  }
  return o;
}

// Read the local store when the gateway is down. Same shape as /api/v1/logs so the two
// render through one code path.
function localRows(o) {
  const { rows, readStats, foldStats } = store.readRows({});
  const from = o.from ? Date.parse(o.from + 'T00:00:00') : null;
  const to = o.to ? Date.parse(o.to + 'T00:00:00') : null;
  const out = [];
  for (const r of rows) {
    if (o.session && r.sess !== o.session && !(r.sessions || []).includes(o.session)) continue;
    if (Number.isFinite(from) && r.ts < from) continue;
    if (Number.isFinite(to) && r.ts >= to) continue;
    const d = deriveRow(r);
    const basis = r.conf === 'measured' ? 'measured' : 'estimated';
    if (o.basis && basis !== o.basis) continue;
    const decision = r.elig ? 'routed' : 'kept';
    if (o.decision && decision !== o.decision) continue;
    out.push({
      ts: r.ts, pday: r.pday, tzo: r.tzo,
      basis, grain: 'call',
      source: r.harness || '', session: r.sess || '',
      base: r.base || '', served: r.served || '',
      decision,
      in_tokens: r.in || 0, out_tokens: r.out || 0,
      cache_read: r.cr || 0, cache_create_5m: r.c5 || 0, cache_create_1h: r.c1 || 0,
      baseline_usd: d.baseline, actual_usd: d.spent, delta_usd: d.delta,
      unpriced_reason: d.priceable ? '' : d.reason,
      why: r.reason || (r.ctier ? `classified ${r.ctier}` : ''),
      id: r.id, request_id: /^rid:/.test(r.id) ? r.id.slice(4) : '',
    });
  }
  out.sort((a, b) => b.ts - a.ts);
  // `readStats` travels WHOLE — no hand-picked subset. The register's job is to account
  // for every row, so the reader's own refusals (`unreadable`, `corrupt`, `bad`,
  // `partialTail`, `futureSchema`) are part of the answer, not diagnostics beside it.
  // `storeHoles` below renders them; a counter published here and rendered nowhere is
  // invisible to everyone who does not pass --json.
  return { rows: out.slice(0, o.limit), total: out.length,
           source: 'local-store', store: { readStats, foldStats } };
}

// Segments the reader could not account for, as printable lines.
//
// events.js::readSegment counts `unreadable` (the bytes could not be obtained) and
// `corrupt` (the bytes were read but the gzip did not inflate) precisely so a truncated
// read cannot pass for a complete one — and `readAll` increments `segments` BEFORE it
// attempts the read, so without these lines a month nobody could open is indistinguishable
// from a month with no calls. This register prints "showing N of M": both N and M are
// derived only from segments that WERE read, so an unaccounted segment makes both of them
// understatements of an unknown size. That has to be said on the same screen.
//
// Empty when the rows came from the gateway: the local store was never read, so there is
// nothing to report about it, and inventing a clean bill of health for a file we did not
// open would be its own false claim.
function storeHoles(data) {
  const st = (data && data.store && data.store.readStats) || null;
  if (!st) return [];
  const out = [];
  if (st.unreadable) {
    out.push(`${st.unreadable} segment(s) could NOT BE READ (permissions or an incomplete `
      + 'copy). Their calls are absent from this register and from the counts below; how '
      + 'many there were is unknown.');
  }
  if (st.corrupt) {
    out.push(`${st.corrupt} sealed segment(s) are CORRUPT (the archive did not inflate). `
      + 'Their calls are absent from this register and from the counts below; how many '
      + 'there were is unknown.');
  }
  if (st.bad) {
    out.push(`${st.bad} line(s) could not be parsed and were skipped.`);
  }
  if (st.futureSchema) {
    out.push(`${st.futureSchema} event(s) were written by a NEWER Cheaper and are not `
      + 'counted. Upgrade: npm i -g cheaper');
  }
  if (st.partialTail) {
    out.push(`${st.partialTail} segment(s) end in a partial line (a chat is still writing) `
      + '— skipped, not lost.');
  }
  return out;
}

async function fetchRows(o) {
  const res = await api.getJson('/api/v1/logs' + api.qs({
    limit: o.limit, session: o.session, from: o.from, to: o.to,
    basis: o.basis, decision: o.decision,
  }));
  if (res.ok && res.body && Array.isArray(res.body.rows)) {
    return Object.assign({ source: 'gateway' }, res.body);
  }
  return Object.assign(localRows(o), { gatewayNote: api.explain(res) });
}

function renderTable(data) {
  const rows = data.rows || [];
  console.log('');
  console.log('  ' + c.amber('cheaper logs') + c.dim('  — every routed call, priced at its own day and SKU'));
  console.log('  ' + c.dim(`source: ${data.source}` + (data.gatewayNote ? ` (${data.gatewayNote})` : '')));
  console.log('');
  // Printed BEFORE the table and before the empty state: "No events in this range" is an
  // affirmative claim, and a segment the reader could not open is the evidence that would
  // refute it. See storeHoles().
  const holes = storeHoles(data);
  for (const h of holes) console.log('  ' + c.amber(h));
  if (holes.length) console.log('');
  if (!rows.length) {
    // The empty state matters: a measured-only table renders blank on a machine that
    // has never proxied anything, and a blank table reads as "you saved nothing".
    console.log('  ' + (holes.length
      ? c.dim('No READABLE events in this range — see the unaccounted segment(s) above.')
      : c.dim('No events in this range.')));
    console.log('  ' + c.dim('  measured rows need the gateway in the request path:'));
    console.log('     ' + c.bold('export ANTHROPIC_BASE_URL=http://localhost:8787'));
    console.log('  ' + c.dim('  estimated rows appear after an end-of-chat tagline runs, or run:'));
    console.log('     ' + c.bold('cheaper import --since 2026-07-01 --dry-run'));
    console.log('');
    return;
  }
  const H = ['When', 'Basis', 'Grain', 'Source', 'Baseline → Served', 'Decision',
             'Tokens', 'Baseline $', 'Actual $', 'Δ $'];
  //           When Basis Grain Source Pair Decision Tokens Base$ Act$ Δ$
  // Each width is >= the widest value that column can hold, +1 for the gap. `Decision`
  // must fit "downgrade" (9) and `Grain` must fit "call" (4) — at exactly the content
  // width the columns collided and rendered "GrainSource" and "downgrade0/0".
  const W = [18, 10, 6, 14, 36, 11, 18, 12, 12, 12];
  // Padding is computed on the VISIBLE length: an ANSI colour code is zero-width on
  // screen but not to String#padEnd, which is what skewed every coloured column.
  const vis = (s) => String(s).replace(/\[[0-9;]*m/g, '').length;
  const pad = (s, w) => String(s) + ' '.repeat(Math.max(1, w - vis(s)));
  console.log('  ' + c.dim(H.map((h, i) => h.padEnd(W[i])).join('')));
  console.log('  ' + c.dim('─'.repeat(W.reduce((a, b) => a + b, 0))));
  for (const r of rows) {
    const when = new Date(r.ts).toISOString().replace('T', ' ').slice(0, 16);
    const d = r.delta_usd;
    const deltaCell = (d === null || d === undefined)
      ? c.dim('—')
      : (d < 0 ? c.red(money(d)) : c.green(money(d)));
    const pair = `${r.base || '?'} → ${r.served || '?'}`;
    // The API names these `in`/`out`; the legacy /logs names them `in_tokens`/
    // `out_tokens`. Reading only one printed "0/0" on every row.
    const nIn = Number(r.in !== undefined && r.in !== null ? r.in : r.in_tokens) || 0;
    const nOut = Number(r.out !== undefined && r.out !== null ? r.out : r.out_tokens) || 0;
    const toks = `${nIn.toLocaleString('en-US')}/${nOut.toLocaleString('en-US')}`;
    console.log('  '
      + pad(when, W[0])
      // basis + grain are NON-HIDEABLE. A later "simplify the table" change that drops
      // them would silently re-mix measured and estimated figures in one column.
      + pad(r.basis === 'measured' ? c.green('measured') : c.dim('estimated'), W[1])
      + pad(r.grain || 'call', W[2])
      + pad(String(r.source || '').slice(0, W[3] - 1), W[3])
      + pad(pair.slice(0, W[4] - 1), W[4])
      + pad(r.decision || '', W[5])
      + pad(toks, W[6])
      + pad(cost(r.baseline_usd), W[7])
      + pad(cost(r.actual_usd), W[8])
      + deltaCell);
    if (r.unpriced_reason) {
      console.log('    ' + c.dim(`↳ no figure claimed: ${r.unpriced_reason.replace(/_/g, ' ')}`));
    }
  }
  console.log('');
  const shown = rows.length;
  // The API reports `count` (already "20000+" when capped); the legacy /logs reports
  // `total`. Reading only `total` printed "showing 6 of 0".
  const total = data.count !== undefined ? data.count : data.total;
  const totalTxt = typeof total === 'string' ? total
    : (total === undefined || total === null ? '?' : total.toLocaleString('en-US'));
  // Both `shown` and `total` are counted over the segments that WERE read, so an
  // unaccounted segment makes each of them a floor rather than a count. Saying "of 412"
  // beside a segment nobody could open asserts a completeness the reader does not have.
  console.log('  ' + c.dim(`showing ${shown} of ${totalTxt}`)
    + (holes.length ? c.amber('  (of the segments that could be read — see above)') : ''));
  console.log('  ' + c.dim('Full audit export:  ') + c.bold('cheaper export --format csv --out audit.csv'));
  console.log('');
}

async function run(argv = [], opts = {}) {
  const o = parseArgs(argv);
  // Unchanged default: open the browser at the Logs tab.
  if (!o.json && !o.terminal) return require('./launch').run(argv, { tab: 'logs' });
  const data = await fetchRows(o);
  if (o.json) { console.log(JSON.stringify(data, null, 2)); return; }
  renderTable(data);
}

// `storeHoles` and `renderTable` are exported for the SAME reason reports.js exports
// `renderReport`: so cli/test/peek.test.js can drive the REAL renderer over a fixture
// instead of re-implementing its rules. A second implementation of "what counts as an
// unaccounted segment" is exactly the drift these counters exist to prevent.
module.exports = { run, parseArgs, localRows, renderTable, storeHoles };
