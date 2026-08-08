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

// ===== THE SHARED CLAIM PREDICATE ==================================================
// ONE copy per render surface — this file, gateway/app/dashboard.html and
// gateway/app/report.html — kept TEXTUALLY IDENTICAL and pinned as such by
// cli/test/html.test.js. cli/src/savings.js imports THIS copy rather than keeping a fourth.
// An HTML page cannot import, so the copies are the price of the rule; the test is what
// stops them drifting again.
//
// Three claims a cell can make, and the project rules forbid collapsing any into another:
//   'not_covered' — Cheaper was not watching. No rows exist because none were recorded.
//   'withheld'    — Cheaper WAS watching, rows exist, and their dollars are deliberately
//                   not claimed (over a fifth of the window's tokens are unpriceable).
//   'absent'      — no rows of that basis in this window at all.
//   'value'       — a real figure, sign and all. A measured zero lives here.
//
// Every surface used to decide between them by testing `acc.calls` — ROWS PRICED. The
// `events` field means ROWS SEEN. A window that is 100% unpriceable therefore has
// acc.calls === 0 on BOTH bases, hit the ABSENT branch, and printed a bare em dash where it
// should have printed "withheld" — the same collapse the dashboard was committing with a
// sentence attached.
//
// So the decision is made from the WINDOW / POINT / GROUP, never from acc.calls, and
// WITHHELD is tested BEFORE ABSENT. That ordering is most of the fix.
//
// Rows-seen is PER BASIS. `unpriced_calls` is a SUBSET counter of `events`, never an
// addend to it, so a KNOWN zero on this basis admits no unpriced row of this basis
// either; the unpriced count only stands in for rows-seen when rows-seen itself could not
// be reported. Both spellings are read — `unpricedCalls` from cli/src/peek/store.js,
// `unpriced_calls` from gateway/app/reporting.py — because both runtimes feed all four
// surfaces.
//
// `priced <= 0` is the third way a figure can fail to be a claim, and it is why reading
// `acc.calls` was seductive: foldRows initialises `saved` to 0, so a basis that priced
// NOTHING still carries a 0. That 0 is vacuous — it is the initial value, not a
// measurement — and rendering it as $0.00 would be the mirror defect of rendering it as
// an em dash. It is a real claim only when at least one row was actually priced. So
// zero-priced becomes WITHHELD when rows were seen and ABSENT when none were, and a
// MEASURED zero (priced rows that netted to nothing) still renders $0.00.
function claimState(o, side, v){
  if (!o) return 'absent';
  if (o.status === 'not_covered') return 'not_covered';
  var acc = o[side];
  var ev = o.events || {};
  var e = ev[side];
  var seen = (e !== undefined && e !== null && isFinite(Number(e)))
    ? Number(e)
    : ((acc && isFinite(Number(acc.calls))) ? Number(acc.calls) : null);
  var raw = (o.unpricedCalls === undefined || o.unpricedCalls === null)
    ? o.unpriced_calls : o.unpricedCalls;
  var up = (raw === undefined || raw === null || !isFinite(Number(raw))) ? 0 : Number(raw);
  var priced = (acc && isFinite(Number(acc.calls))) ? Number(acc.calls) : 0;
  var sawRows = (seen === null) ? (up > 0) : (seen > 0);
  var declined = (o.dollars_suppressed === true || o.status === 'suppressed'
                  || v === null || v === undefined || !isFinite(Number(v))
                  || priced <= 0);
  if (sawRows && declined) return 'withheld';
  if (!sawRows) return 'absent';
  if (!acc) return 'absent';
  return 'value';
}

// ONE copy per render surface — this file, gateway/app/dashboard.html and
// gateway/app/report.html — kept TEXTUALLY IDENTICAL and pinned as such by
// cli/test/html.test.js, exactly like claimState() above.
//
// A withheld window's `notes` array carries ONE generic sentence from the store —
// "N of M call(s) in this window (P% of its tokens) are not in the price catalog" — which
// is TRUE for every withholding reason except one. `cache_state_indeterminate` withholds a
// row whose SERVED model is fully catalogued: switching models invalidates the caller's
// prompt cache, so the served arm can pay a cache CREATE exactly where the un-switched
// baseline would have paid a cache READ (or vice versa), and nothing recorded says which —
// the counterfactual is unknown, not the price. Repeating "not in the price catalog" for
// that row is not imprecise, it is false, and it is the kind of false claim this product
// exists to refuse to make.
//
// `w.unpriced` is the reason -> count breakdown both runtimes publish alongside `notes`
// (gateway/app/reporting.py, cli/src/peek/store.js). Reading it lets the note be reworded
// for the reason that actually applies, rather than trusting a single sentence to describe
// every row it was generated for.
function suppressionNotes(w) {
  var raw = (w && w.notes) || [];
  var by = (w && w.unpriced) || {};
  var indet = Number(by.cache_state_indeterminate) || 0;
  if (!indet) return raw;                       // nothing to reword
  var total = 0;
  for (var k in by) {
    if (Object.prototype.hasOwnProperty.call(by, k)) total += Number(by[k]) || 0;
  }
  var plural = indet === 1 ? '' : 's';
  var indetNote = indet + ' call' + plural + ' in this window switched the served model '
    + 'with no recorded cache read: the model IS in the price catalog, but switching '
    + 'models invalidates the prompt cache, so the counterfactual could have paid a cache '
    + 'READ or a cache CREATE and nothing recorded says which. No dollar figure is claimed '
    + 'for ' + (indet === 1 ? 'it' : 'them') + '.';
  // Wholly cache-state-indeterminate: the catalog sentence is not merely imprecise here,
  // it is FALSE (the model is catalogued), so it is replaced rather than kept alongside.
  if (indet >= total) return [indetNote];
  // Mixed: some rows in the same window really are uncatalogued, so the raw sentence stays
  // true of THAT subset and is kept; the cache-state subset gets its own sentence instead
  // of being folded into a catalog claim it would make false.
  return raw.concat([indetNote]);
}

// Padding is computed on the VISIBLE length so ANSI escapes don't skew the columns.
// Shared by every two-column cell in this file — the ladder, the composition block and
// the trend — so the columns cannot drift apart.
const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

// One two-column cell: measured on the left, estimated on the right, NEVER summed.
function pair(w, field) {
  if (!w) return c.dim('—').padEnd(30);
  if (w.status === 'not_covered') return c.dim('not covered').padEnd(30);
  // NOTE: there is deliberately no blanket `status === 'suppressed'` branch here.
  // Suppression withholds the MONEY only; the call counts are exact and are handled
  // per-accumulator below. Blanking the whole row discarded facts alongside the
  // figures we declined to derive.
  // The WITHHELD decision comes from the shared predicate, which reads the payload's own
  // `dollars_suppressed` flag — published by `reportWindow`, `reportBreakdown` and
  // `reportTrend`, and by all three of their gateway mirrors — BEFORE it considers whether
  // any rows were priced. Testing `!acc.calls` first was the collapse: a window that is
  // 100% unpriceable prices nothing on either basis, so this printed a bare em dash where
  // the same window's own note says the dollars were deliberately not claimed.
  const fmt = (acc, side) => {
    // COUNTS survive dollar suppression and are never routed through the money predicate:
    // the money is withheld, the call counts are exact and are not in doubt. This column
    // is headed "priced calls" and means exactly that.
    //
    // The test is `Number.isFinite`, NOT truthiness. `!acc.calls` treated an EXACT ZERO as
    // an absent count and printed the em dash — the "no claim made" glyph — for a bucket
    // whose own payload reports rows SEEN. On a 100%-unpriceable bucket that rendered
    // `withheld │ withheld  — │ —`: the money column correctly says "we declined to derive
    // this" while the count column beside it says "there is nothing here", about the very
    // rows the decision was made for. Zero PRICED calls is a measured fact and prints `0`;
    // only a count that is genuinely unavailable prints `—`. This now matches nPair()
    // below, which had the predicate right all along — the two had silently drifted.
    if (field === 'calls') {
      return (acc && Number.isFinite(Number(acc.calls))) ? String(Number(acc.calls)) : c.dim('—');
    }
    const v = acc ? (field === 'saved' ? acc.saved : acc.spent) : null;
    const st = claimState(w, side, v);
    // Printing $0.00 here would claim a measured zero; printing nothing would hide that
    // calls happened.
    if (st === 'withheld') return c.amber('withheld');
    if (st === 'value') return (Number(v) < 0 ? c.red : c.green)(money(v));
    return c.dim('—');
  };
  const left = fmt(w.measured, 'measured');
  const right = fmt(w.estimated, 'estimated');
  const cell = left + c.dim(' │ ') + right;
  return cell + ' '.repeat(Math.max(0, 30 - vis(cell)));
}

// The same two columns for a CALL COUNT.
//
// `measured.calls + estimated.calls` is a cross-basis sum in a column where the
// separation is far less visually obvious than it is in the dollar column: "n=4" for a
// day carrying 2 measured and 2 estimated calls names a single population of four that
// does not exist, and it is the number a reader uses to decide whether the dollar figure
// beside it is signal or noise.
//
// An accumulator that is ABSENT renders as a labelled non-number, never n=0. A window
// Cheaper was not watching and a window in which zero calls happened are different
// claims, and `(w.measured ? … : 0)` printed the second for the first.
//
// The number is ROWS SEEN (`events`), not rows PRICED (`acc.calls`) — the caption three
// lines up calls it an EVENT count ("a 400% jump on 3 events reads as noise"), and the
// two are not the same population. Reading `acc.calls` here was the surviving half of the
// collapse that was fixed in the money column beside it: a window that is 100%
// unpriceable prices nothing on EITHER basis, so `pair` correctly printed
// `withheld │ withheld` while this printed `n=0 │ 0` on the same line — one half of the
// row asserting that rows exist whose dollars were deliberately not claimed, the other
// half asserting that no rows exist at all. It also rendered a WITHHELD window and a
// genuinely EMPTY one identically, so the count column could not tell "4 calls happened,
// none priceable" from "nothing happened".
//
// The fallback chain is the one `basisCell(…, 'calls')` and cli/src/savings.js::callCell
// already use, and is textually the one dashboard.html::basisEvents applies: `events`
// first, then the priced accumulator (a floor on rows seen, for payloads predating the
// `events` block), then a labelled non-number — NEVER a fabricated 0. A covered window
// that genuinely saw nothing reports `events` 0 and still prints `0`, which is a
// measurement.
//
// This is deliberately NOT the same reading as the Composition block's `pair(cell,
// 'calls')`, whose column is headed "priced calls m │ e" and means exactly that.
function nPair(w) {
  if (!w) return c.dim('n=') + c.dim('—') + c.dim(' │ ') + c.dim('—');
  const one = (side) => {
    const ev = w.events || {};
    const e = ev[side];
    if (e !== undefined && e !== null && Number.isFinite(Number(e))) return String(Number(e));
    const acc = w[side];
    return (acc && Number.isFinite(Number(acc.calls))) ? String(Number(acc.calls)) : c.dim('—');
  };
  return c.dim('n=') + one('measured') + c.dim(' │ ') + one('estimated');
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
  //
  // The additivity claim is CONDITIONAL and the header used to state it unconditionally.
  // `lifetime_window`'s own docstring records the condition: the ladder sums to lifetime
  // only when NO row is `dollars_suppressed`. Suppression is a per-window decision (>20%
  // of THAT window's tokens unpriceable), so a window can withhold its dollars while
  // lifetime — computed independently over all the rows — still prices them. With even
  // one suppressed row on screen the dollar column does NOT add up, and asserting that it
  // does is an affirmative claim the same screen contradicts.
  const suppressedWins = (r.periods || []).filter(
    (w) => w && (w.dollars_suppressed === true || w.status === 'suppressed'));
  console.log('  ' + c.bold('Savings by period') + c.dim(suppressedWins.length
    ? '   (disjoint windows — the COUNTS add up to lifetime; the dollar column does not)'
    : '   (disjoint windows — these ADD UP to lifetime)'));
  if (suppressedWins.length) {
    console.log('  ' + c.dim(`↳ ${suppressedWins.length} window(s) below withhold their `
      + 'dollars. Their priced rows still contribute to Lifetime, which is computed '
      + 'independently, so the withheld rows cannot be added back and the column does '
      + 'not sum. Compare on events or tokens, which are never withheld.'));
  }
  console.log('  ' + c.dim('period'.padEnd(22) + 'measured │ estimated'.padEnd(30) + 'window (local)'));
  console.log('  ' + c.dim('─'.repeat(90)));
  for (const w of (r.periods || [])) {
    console.log('  ' + c.bold(String(w.label).padEnd(22)) + pair(w, 'saved') + c.dim(bounds(w)));
    for (const n of suppressionNotes(w)) console.log('    ' + c.dim('↳ ' + n));
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
      console.log('  ' + c.bold(('this ' + k).padEnd(22)) + pair(cmp.current, 'saved')
        + nPair(cmp.current));
      console.log('  ' + c.dim(('vs last ' + k).padEnd(22)) + pair(cmp.previous, 'saved')
        + nPair(cmp.previous));
    }
    console.log('');
  }

  // --- 3. composition -------------------------------------------------------------
  const bd = r.breakdown || [];
  if (bd.length) {
    console.log('  ' + c.bold('Composition') + c.dim('   (by served model)'));
    console.log('  ' + c.dim('key'.padEnd(34) + 'saved  m │ e'.padEnd(30)
      + 'priced calls  m │ e'));
    for (const g of bd.slice(0, 12)) {
      // Two columns, not one scalar. A single `calls` cell here was measured calls PLUS
      // estimated calls — a cross-basis count — and it also read `undefined` whenever the
      // report came from the gateway, whose groups have never carried that field.
      // `dollars_suppressed` travels with the group from BOTH runtimes and has to be
      // carried into the synthetic cell, or `pair` renders a figure the group itself
      // declines to claim.
      //
      // `events` and the unpriced counters travel with it too. The synthetic cell used to
      // carry only the two accumulators, so the shared predicate saw ROWS PRICED and
      // nothing else: a group that is 100% unpriceable prices nothing on either basis, and
      // the saved column printed a bare em dash — the ABSENT claim — for a group whose own
      // `+3 unpriced` note on the same line proves rows were seen. Dropping a field on the
      // way into the renderer reintroduces the defect the predicate exists to prevent.
      const cell = { status: g.dollars_suppressed === true ? 'suppressed' : 'ok',
                     dollars_suppressed: g.dollars_suppressed === true,
                     measured: g.measured, estimated: g.estimated,
                     events: g.events,
                     unpricedCalls: g.unpricedCalls, unpriced_calls: g.unpriced_calls };
      // `unpricedCalls` (local store) / `unpriced_calls` (gateway) — rows that entered
      // NEITHER accumulator. Shown so the exclusion is visible rather than a silently
      // shrinking denominator.
      const un = Number(g.unpricedCalls ?? g.unpriced_calls) || 0;
      console.log('  ' + String(g.key).slice(0, 33).padEnd(34)
        + pair(cell, 'saved') + pair(cell, 'calls')
        + (un ? c.dim(`+${un} unpriced`) : ''));
    }
    console.log('');
  }

  // --- 4. dated trend -------------------------------------------------------------
  const tr = r.trend || [];
  if (tr.length) {
    console.log('  ' + c.bold('Trend') + c.dim('   (bucketed on each call\'s OWN local day)'));
    console.log('  ' + c.dim('bucket'.padEnd(12) + 'measured │ estimated'.padEnd(30)
      + 'bars: measured │ estimated — each scaled to its OWN basis'));
    // ONE scalar per bucket used to be `measured.saved + estimated.saved`, plotted as one
    // bar and printed as one dollar figure — a cross-basis sum, four lines above the
    // footer that says the two bases carry separate totals and are never summed. The two
    // bases now render exactly as they do everywhere else in this file: two columns via
    // `pair`, plus one bar each, EACH SCALED AGAINST ITS OWN MAXIMUM. A shared axis would
    // assert a comparable magnitude across the two bases, and there is none.
    //
    // Three distinct states, three distinct renderings, never folded together:
    //   a number   -> a bar and a figure
    //   ABSENT     -> no call on that basis in this bucket: `—`, never a 0-length bar
    //   WITHHELD   -> `saved` is null because that window's dollars were suppressed:
    //                 the amber label, never a 0-length bar and never $0.00. Collapsing
    //                 a withheld figure to 0 with `(v || 0)` is the same concealment in
    //                 a different costume — it plots a declined claim as a measured zero.
    //
    // WITHHELD is decided by the POINT's own `dollars_suppressed` flag as well as by a
    // null figure. The flag is the producer's stated decision; the null is only its side
    // effect, and a producer that computed the decision and forgot to apply it handed
    // this renderer a real number to plot beside a ladder row reading "withheld".
    //
    // `!acc.calls` was tested BEFORE `dollars_suppressed`, so a bucket that is 100%
    // unpriceable — calls 0 on both bases, the shape reportTrend really emits — returned
    // ABSENT and drew an em dash beside a ladder row reading "withheld". The shared
    // predicate tests WITHHELD first and reads the POINT, not just the accumulator.
    const savedOf = (t, basis) => {
      const acc = t ? t[basis] : null;
      const v = acc ? acc.saved : null;
      const st = claimState(t, basis, v);
      if (st === 'withheld') return null;                          // WITHHELD, by decision
      if (st === 'value') return Number(v);                        // signed; sign preserved
      return undefined;                                            // ABSENT / not covered
    };
    // The max for each basis is taken over that basis alone, and only over the values
    // that ARE numbers — an absent or withheld figure contributes no magnitude rather
    // than a zero one.
    const maxOf = (basis) => Math.max(1, ...tr
      .filter((t) => !t.undatable)
      .map((t) => savedOf(t, basis))
      .filter((v) => typeof v === 'number')
      .map(Math.abs));
    const maxes = { measured: maxOf('measured'), estimated: maxOf('estimated') };
    const BAR = 18;
    const barOf = (v, max) => {
      if (v === undefined) return c.dim('—');
      if (v === null) return c.amber('withheld');
      const w = Math.round((Math.abs(v) / max) * BAR);
      // A genuine MEASURED zero draws no block — but it is still printed as $0.00 by
      // `pair` beside it, which is the claim actually being made.
      return (v < 0 ? c.red : c.green)('█'.repeat(Math.max(v === 0 ? 0 : 1, w)));
    };
    for (const t of tr) {
      // The trailing `undated` point carries rows that could be placed on NO day — no
      // usable instant and no usable frozen day. `deriveRow` refuses to price exactly
      // those, so their saved is 0 because nothing was claimed, not because zero was
      // measured. Printing `$0.00` under a date axis would state a measured result for a
      // figure that was explicitly withheld, so it is labelled instead and never plotted.
      if (t.undatable) {
        // `unpricedCalls` (local store) / `unpriced_calls` (gateway). A point that exists
        // ONLY because at least one row landed on no day cannot honestly print "0
        // call(s)" — that is an affirmative claim its own existence contradicts — so an
        // absent or unusable count is labelled rather than defaulted to 0.
        const raw = t.unpricedCalls ?? t.unpriced_calls;
        const n = Number.isFinite(Number(raw)) ? Number(raw) : null;
        console.log('  ' + c.dim(String(t.bucket).padEnd(12)) + c.amber('not dated')
          + (n === null
            ? c.dim(' · ') + c.amber('call count unavailable')
            : c.dim(` · ${n} call(s)`))
          + c.dim(' attributed to no day, unpriced'));
        continue;
      }
      const bm = barOf(savedOf(t, 'measured'), maxes.measured);
      const be = barOf(savedOf(t, 'estimated'), maxes.estimated);
      // Same visible-length padding as `pair`, so colour never skews the two bar columns.
      const bars = bm + ' '.repeat(Math.max(1, BAR + 1 - vis(bm))) + c.dim('│ ') + be;
      console.log('  ' + c.dim(String(t.bucket).padEnd(12)) + pair(t, 'saved') + bars);
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

// `renderReport` is exported so cli/test/reports.test.js can drive the REAL terminal
// renderer over a fixture, rather than re-implementing its formatting in the test — a
// second implementation of these rules is exactly the drift this file exists to prevent.
// `claimState` is exported so cli/src/savings.js consumes THIS copy instead of keeping a
// fourth one, and so cli/test/html.test.js can drive it directly and diff it against the
// two HTML copies it cannot import. `suppressionNotes` is exported for the same reason —
// html.test.js diffs it against its dashboard.html and report.html copies exactly as it
// does claimState.
module.exports = { run, parseArgs, localReport, renderReport, claimState, suppressionNotes };
