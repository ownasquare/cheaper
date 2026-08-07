'use strict';
// `cheaper savings` — realized routing savings, bucketed on WHEN THE CALLS HAPPENED.
//
// This used to read the chat-grain ledger and bucket on `at`, the moment the end-of-chat
// tagline last RAN. All six live entries carried an `at` inside one four-hour band, for
// work spanning weeks, so the command reported 100% of lifetime savings under "today"
// and $0.00 for every prior day — and re-running an old chat's tagline MOVED its money
// out of the old period into the new one. "Savings yesterday" was not stable and could
// silently drop to zero.
//
// It now reads the per-call event store and buckets on each call's own `pday`. The
// ladder is DISJOINT — Today · Earlier this week · Earlier this month · … — so the rows
// sum to lifetime instead of nesting six deep, and a reader who adds the column gets
// the right answer instead of counting today six times.
//
// Legacy chat-grain rows are reported SEPARATELY and never mixed in: their timestamps
// are known-wrong and their dollars are frozen, so folding them into a day would make
// the fix look done while history stayed wrong.

const store = require('./peek/store');
const ledger = require('./peek/ledger');
const periods = require('./peek/periods');
const { c } = require('./util');
const render = require('./peek/render');
const { CATALOG_AS_OF } = require('./peek/models');

function money(n) {
  n = Number(n) || 0;
  const neg = n < 0;
  const v0 = Math.abs(n);
  const v = v0 >= 100 ? Math.round(v0) : Math.round(v0 * 100) / 100;
  return (neg ? '-' : '') + '$' + v.toLocaleString('en-US',
    { minimumFractionDigits: v0 >= 100 ? 0 : 2, maximumFractionDigits: 2 });
}

// Bucketed realized savings. Exposed so the dashboard and the reporting API reuse the
// same numbers rather than each deriving their own.
function compute(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const tz = opts.tz || undefined;
  store.ensureLegacyImported();   // idempotent freeze of the pre-store chat ledger
  const { rows, readStats, foldStats } = store.readRows(opts);
  const state = store.loadState();
  const ladder = store.reportLadder(rows, now, tz, { state });
  // Lifetime is the whole partition, computed as ONE window rather than as a sum of the
  // ladder rows — so a bug in the ladder shows up as a disagreement instead of being
  // silently reproduced in the total.
  const lifetime = store.reportWindow(rows, -Infinity, Infinity, { state });
  const legacy = store.legacyTotals();
  return {
    generatedAt: now,
    tz: (ladder[0] && ladder[0].tz) || 'UTC',
    catalog: { as_of: CATALOG_AS_OF },
    ladder,
    lifetime,
    // A THIRD visual state, never added to either basis above.
    legacy: Object.assign({ note: 'pre-store per-chat aggregates: dollars frozen as '
      + 'computed at the time, timestamps imprecise, excluded from period buckets' }, legacy),
    store: { segments: readStats.segments, rows: readStats.rows,
             partialTail: readStats.partialTail, badLines: readStats.bad,
             futureSchema: readStats.futureSchema, fold: foldStats },
  };
}

// One rendered cell. The two bases are printed as two columns and are NEVER summed:
// a per-call measured figure plus a per-chat estimated one is the concealment shape
// this whole workstream exists to remove.
function cell(w) {
  if (!w) return c.dim('—');
  if (w.status === 'not_covered') return c.dim('not covered');
  const m = w.measured; const e = w.estimated;
  const parts = [];
  const one = (acc, label) => {
    if (!acc || !acc.calls) return null;
    // Under suppression the money is withheld and the counts are not. Printing
    // "$0.00" here would claim a measured zero; printing nothing at all would hide
    // that the calls happened.
    if (acc.saved === null || acc.saved === undefined) return c.amber('withheld') + c.dim(' ' + label);
    return (acc.saved < 0 ? c.red : c.green)(money(acc.saved)) + c.dim(' ' + label);
  };
  const a = one(m, 'measured'); if (a) parts.push(a);
  const b = one(e, 'est.'); if (b) parts.push(b);
  if (!parts.length) return c.dim('—');
  return parts.join(c.dim('  ·  '));
}

function run(argv = []) {
  const args = argv || [];
  const b = compute();
  if (args.includes('--json')) { console.log(JSON.stringify(b, null, 2)); return; }

  const tok = render.tokens;
  console.log('');
  console.log('  ' + c.amber('cheaper savings') + c.dim('  — realized routing savings, by when the calls happened'));
  console.log('  ' + c.dim(`timezone ${b.tz} · prices as of ${b.catalog.as_of} · windows are half-open [from, to)`));
  console.log('');
  for (const w of b.ladder) {
    const counts = [];
    if (w.measured && w.measured.calls) counts.push(w.measured.calls + ' measured');
    if (w.estimated && w.estimated.calls) counts.push(w.estimated.calls + ' est.');
    const toks = (w.tokens ? (w.tokens.measured + w.tokens.estimated) : 0);
    console.log('  ' + c.bold(String(w.label).padEnd(22)) + cell(w)
      + c.dim('   ' + tok(toks) + ' tokens · ' + (counts.join(' + ') || '0') + ' calls'));
    for (const n of (w.notes || [])) console.log('    ' + c.dim('↳ ' + n));
  }
  console.log('  ' + c.dim('—'.repeat(60)));
  console.log('  ' + c.bold('Lifetime'.padEnd(22)) + cell(b.lifetime));
  if (b.legacy && b.legacy.chats) {
    console.log('  ' + c.bold('Legacy (pre-store)'.padEnd(22))
      + c.dim(money(b.legacy.usd) + ' across ' + b.legacy.chats + ' chat'
        + (b.legacy.chats === 1 ? '' : 's') + ' · frozen, excluded from periods'));
  }
  console.log('');
  if (b.store.rows === 0) {
    console.log('  ' + c.dim('No per-call events recorded yet. They appear after an end-of-chat'));
    console.log('  ' + c.dim('tagline runs, or import your history:  ') + c.bold('cheaper import --since 2026-07-01 --dry-run'));
  } else {
    console.log('  ' + c.dim(`${b.store.rows} events across ${b.store.segments} segment(s).`));
    if (b.store.partialTail) {
      console.log('  ' + c.dim(`${b.store.partialTail} segment(s) end in a partial line (a chat is still writing) — skipped, not lost.`));
    }
    if (b.store.futureSchema) {
      console.log('  ' + c.amber(`${b.store.futureSchema} event(s) were written by a NEWER Cheaper and are not counted. Upgrade: npm i -g cheaper`));
    }
  }
  console.log('  ' + c.dim('Full audit register + export:  ') + c.bold('cheaper logs --json') + c.dim(' / ') + c.bold('cheaper reports'));
  console.log('');
}

// Back-compat: the old nested "since" shape, still used for a single headline figure.
// Kept because a headline legitimately wants "since Monday", which the disjoint ladder
// deliberately does not express.
function computeSince(now) {
  const { rows } = store.readRows({});
  const out = {};
  for (const k of periods.ORDER) {
    const bnd = periods.periodBounds(k, now);
    out[k] = store.reportWindow(rows, bnd.from, bnd.to, {});
  }
  return out;
}

module.exports = { run, compute, computeSince, money, ledger };
