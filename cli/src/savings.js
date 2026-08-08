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
// The ONE claim predicate, imported rather than re-implemented. Four render surfaces decide
// between "not covered", "withheld" and "absent"; three of them cannot import (two are HTML
// pages), so those carry a textually identical copy that cli/test/html.test.js diffs. This
// one can import, so it does.
const { claimState } = require('./reports');
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
    // The reader's own health, republished verbatim. This list is HAND-PICKED, and that
    // is precisely how `unreadable` and `corrupt` stayed invisible after events.js began
    // counting them: a segment nobody could open was already counted into `segments`, so
    // "3 segments, 412 events" read identically whether the third month was quiet or
    // unopenable. A hole in the evidence is not a smaller number, it is an unknown one,
    // and it has to travel with the figures derived from what WAS read.
    // If events.js grows another refusal counter, add it here AND to the terminal block
    // in run() below — publishing it into --json only moves the silence to the surface
    // almost everyone actually reads.
    store: { segments: readStats.segments, rows: readStats.rows,
             partialTail: readStats.partialTail, badLines: readStats.bad,
             futureSchema: readStats.futureSchema,
             unreadable: readStats.unreadable, corrupt: readStats.corrupt,
             fold: foldStats },
  };
}

// One rendered cell. The two bases are printed as two columns and are NEVER summed:
// a per-call measured figure plus a per-chat estimated one is the concealment shape
// this whole workstream exists to remove.
// The three claims are decided by the SHARED predicate imported from `./reports`, not by a
// fourth local copy of the rule — this function had the same `!acc.calls`-first
// short-circuit every other surface had, so a 100%-unpriceable window (which prices nothing
// on either basis) printed a bare em dash while the note directly beneath it said the
// dollars were deliberately not claimed.
function cell(w) {
  if (!w) return c.dim('—');
  if (w.status === 'not_covered') return c.dim('not covered');
  const parts = [];
  const one = (acc, side, label) => {
    const v = acc ? acc.saved : null;
    const st = claimState(w, side, v);
    // Under suppression the money is withheld and the counts are not. Printing "$0.00"
    // here would claim a measured zero; printing nothing at all would hide that the calls
    // happened.
    if (st === 'withheld') return c.amber('withheld') + c.dim(' ' + label);
    if (st === 'value') return (Number(v) < 0 ? c.red : c.green)(money(v)) + c.dim(' ' + label);
    return null;
  };
  const a = one(w.measured, 'measured', 'measured'); if (a) parts.push(a);
  const b = one(w.estimated, 'estimated', 'est.'); if (b) parts.push(b);
  if (!parts.length) return c.dim('—');
  return parts.join(c.dim('  ·  '));
}

// ROWS SEEN, per basis, never summed.
//
// This read `w.measured.calls` / `w.estimated.calls` — the PRICED accumulators — while
// `reportWindow` hands it `events`, the rows it actually saw. One measured call to a
// model absent from the price catalog therefore rendered "0 calls" one line above this
// window's own note saying "100% of this window's tokens are not in the price catalog,
// so no dollar figure is claimed" — a count of zero for a call the same window states it
// declined to price — and the dashboard, reading `events` off the byte-identical gateway
// payload, rendered 1 for the same window.
//
// An ABSENT `events` (not_covered, store_newer_than_reader) is a labelled non-number, not
// a 0: those windows report nothing, which is not the same as reporting none.
function callCell(w) {
  const ev = w && w.events;
  if (!ev || !Number.isFinite(Number(ev.measured)) || !Number.isFinite(Number(ev.estimated))) {
    return '—';
  }
  const parts = [];
  if (ev.measured) parts.push(ev.measured + ' measured');
  if (ev.estimated) parts.push(ev.estimated + ' est.');
  // A covered window that genuinely saw nothing did measure zero, and says so.
  return parts.length ? parts.join(' · ') : '0';
}

// The token figure, per basis, plus the tokens whose dollars could not be derived.
//
// This was `w.tokens.measured + w.tokens.estimated` — a cross-basis scalar sum, the exact
// shape the dollar column is forbidden from taking, in a column where the separation is
// far less visible. It also read the PRICED token counters only, so 12,000 tokens on one
// unpriceable call rendered as "0 tokens". `unpricedTokens` is its own labelled figure
// and is never folded into either basis: `foldRows` does not attribute it to one, and
// inventing an attribution to make the line shorter is the concealment shape this file
// exists to remove. The three figures are printed side by side with `·`, never `+`.
function tokenCell(w, tok) {
  const t = w && w.tokens;
  const un = w ? Number(w.unpricedTokens) : NaN;
  const haveT = !!t && Number.isFinite(Number(t.measured)) && Number.isFinite(Number(t.estimated));
  const haveU = Number.isFinite(un);
  if (!haveT && !haveU) return '—';
  const parts = [];
  if (haveT && t.measured) parts.push(tok(t.measured) + ' measured');
  if (haveT && t.estimated) parts.push(tok(t.estimated) + ' est.');
  if (haveU && un) parts.push(tok(un) + ' unpriced');
  return parts.length ? parts.join(' · ') : '0';
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
    console.log('  ' + c.bold(String(w.label).padEnd(22)) + cell(w)
      + c.dim('   ' + tokenCell(w, tok) + ' tokens · ' + callCell(w) + ' calls'));
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
  // HOLES IN THE EVIDENCE, printed on BOTH branches and BEFORE the empty state.
  //
  // `unreadable` (the bytes could not be obtained — a restore that lost the mode bits, a
  // hostile umask, a half-synced file) and `corrupt` (the bytes were read but the gzip
  // did not inflate) are counted by events.js::readSegment and were reaching neither this
  // screen nor `--json`. `stats.segments` is incremented BEFORE the read is attempted, so
  // a month nobody could open was reported as a month with no rows: "3 segments, 412
  // events" said the same thing whether the third segment was quiet or unopenable.
  //
  // They are printed before the empty state because "No per-call events recorded yet" is
  // an AFFIRMATIVE claim about your history, and an unreadable segment is exactly the
  // evidence that could refute it. Rows are never inferred from a segment we could not
  // read — the count stays what it is; what changes is that the gap is now stated.
  const holes = [];
  if (b.store.unreadable) {
    holes.push(`${b.store.unreadable} segment(s) could NOT BE READ (permissions or an `
      + 'incomplete copy). Their events are missing from every figure above, and how '
      + 'many there were is unknown.');
  }
  if (b.store.corrupt) {
    holes.push(`${b.store.corrupt} sealed segment(s) are CORRUPT (the archive did not `
      + 'inflate). Their events are missing from every figure above, and how many there '
      + 'were is unknown.');
  }
  if (b.store.badLines) {
    holes.push(`${b.store.badLines} line(s) could not be parsed and were skipped.`);
  }
  for (const h of holes) console.log('  ' + c.amber(h));
  if (b.store.rows === 0) {
    if (holes.length) {
      // Not "you have no history" — "we read nothing usable, and part of the store is a
      // hole". Collapsing the two is how a broken store reads as an empty one.
      console.log('  ' + c.dim(`No readable per-call events across ${b.store.segments} segment(s).`));
    } else {
      console.log('  ' + c.dim('No per-call events recorded yet. They appear after an end-of-chat'));
      console.log('  ' + c.dim('tagline runs, or import your history:  ') + c.bold('cheaper import --since 2026-07-01 --dry-run'));
    }
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

// `cell` is exported for the SAME reason reports.js exports `renderReport`: so
// cli/test/html.test.js can drive the REAL renderer over a fixture instead of
// re-implementing its rules, and can diff what it says against the other four surfaces.
// It carried the identical `!acc.calls`-first collapse and nothing could see it, because
// the only test over this file drives `run()` end to end and never reaches a window whose
// dollars are withheld.
module.exports = { run, compute, computeSince, money, ledger, cell };
