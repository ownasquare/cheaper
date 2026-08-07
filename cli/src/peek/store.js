'use strict';
// The reader side of the per-call event store: segments → fold → derive → buckets,
// with every "report NOTHING" case applied and LABELLED.
//
// The single rule this file exists to enforce: a period that cannot be reported
// honestly returns a labelled non-number, never `$0.00`. "$0" and "we weren't
// watching" are different claims, and only one of them is a measurement.

const fs = require('fs');
const path = require('path');
const events = require('./events');
const { fold } = require('./reconcile');
const { deriveRow, foldRows } = require('./derive');
const periods = require('./periods');
const { CATALOG_AS_OF } = require('./models');

const STATE_V = 1;

function statePath() { return path.join(events.eventsDir(), 'state.json'); }
function legacyPath() {
  return process.env.CHEAPER_LEGACY_FILE
    || path.join(events.eventsDir(), '..', 'legacy_chats.json');
}

// ---- state.json: coverage[], tombstones[], ingested_files[] ------------------------
//
// Coverage is what makes "not covered" expressible. Without it, a period before the
// store existed reads as $0.00 — indistinguishable from a period where routing simply
// saved nothing. The gateway writes an `observed` heartbeat; `cheaper import` writes a
// `backfilled` interval; everything outside both is `not_covered`.
function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (j && typeof j === 'object') {
      // A state file from a NEWER writer is a visible refusal, never a silent reset —
      // ledger.js's catch-all `{chats:{}}` made a forward-incompatible file read as
      // "you saved nothing", which is the worst way to be wrong about money.
      if (Number(j.v) > STATE_V) return { v: j.v, tooNew: true, coverage: [], tombstones: [], ingested_files: [] };
      return Object.assign({ v: STATE_V, coverage: [], tombstones: [], ingested_files: [] }, j);
    }
  } catch { /* absent or malformed → start fresh */ }
  return { v: STATE_V, coverage: [], tombstones: [], ingested_files: [] };
}

function saveState(st) {
  const p = statePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, p);
    return true;
  } catch { return false; }
}

// Record that we have observation for [fromMs, toMs). Adjacent/overlapping intervals of
// the same kind are merged so the list stays small over years of use.
function addCoverage(kind, fromMs, toMs, harness) {
  const st = loadState();
  if (st.tooNew) return false;
  const iv = { kind, from: Math.floor(fromMs), to: Math.ceil(toMs), harness: harness || null };
  const same = (a, b) => a.kind === b.kind && (a.harness || null) === (b.harness || null);
  const out = [];
  let cur = iv;
  for (const c of st.coverage.slice().sort((a, b) => a.from - b.from)) {
    if (same(c, cur) && c.from <= cur.to && c.to >= cur.from) {
      cur = { kind: cur.kind, harness: cur.harness,
              from: Math.min(c.from, cur.from), to: Math.max(c.to, cur.to) };
    } else { out.push(c); }
  }
  out.push(cur);
  st.coverage = out.sort((a, b) => a.from - b.from);
  return saveState(st);
}

// Coverage IMPLIED by the events themselves.
//
// A recorded call at instant T is direct evidence that we were watching at T — stronger
// evidence than the declared interval, in fact. Relying on `state.coverage` alone would
// report `not_covered` for a window full of real events whenever the state file was
// lost, hand-deleted, or written by a path that predates coverage tracking, and
// "not covered" over live data is just as wrong as "$0.00" over no data.
//
// This never WIDENS a claim: it only asserts coverage for instants an event actually
// occupies, plus a one-day pad on each side of a contiguous run (a day with calls in it
// was a day we were watching).
const IMPLIED_PAD_MS = 86400000;

function impliedCoverage(rows) {
  const ts = (rows || []).map((r) => Number(r.ts)).filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  for (const t of ts) {
    const last = out[out.length - 1];
    if (last && t - last.to <= 2 * IMPLIED_PAD_MS) { last.to = t + IMPLIED_PAD_MS; continue; }
    out.push({ kind: 'observed', from: t - IMPLIED_PAD_MS, to: t + IMPLIED_PAD_MS });
  }
  return out;
}

// How much of [from, to) we actually watched. Returns
//   { kind: 'full' | 'partial' | 'not_covered', from, to, covered:[…] }
// A `partial` window reports ONLY its covered sub-window, with explicit bounds — never
// the nominal total, which would silently present a fraction of the evidence as all of it.
function coverageFor(fromMs, toMs, st, extra) {
  const state = st || loadState();
  const lo = Number.isFinite(fromMs) ? fromMs : -Infinity;
  const hi = Number.isFinite(toMs) ? toMs : Infinity;
  const hits = (state.coverage || []).concat(extra || [])
    .filter((c) => c.to > lo && c.from < hi)
    .map((c) => ({ kind: c.kind, from: Math.max(c.from, lo), to: Math.min(c.to, hi) }))
    .sort((a, b) => a.from - b.from);
  if (!hits.length) return { kind: 'not_covered', from: lo, to: hi, covered: [] };
  // Union the hits and compare against the requested span.
  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.from <= last.to) last.to = Math.max(last.to, h.to);
    else merged.push({ from: h.from, to: h.to });
  }
  const spanned = merged.reduce((s, m) => s + (m.to - m.from), 0);
  const want = (Number.isFinite(hi) && Number.isFinite(lo)) ? (hi - lo) : Infinity;
  const full = Number.isFinite(want) ? spanned >= want - 1000 : false;
  return { kind: full ? 'full' : 'partial', from: lo, to: hi, covered: merged };
}

// ---- tombstones -------------------------------------------------------------------
// `cheaper forget --session <id>` writes one. Totals then visibly DROP with a stated
// reason instead of silently, and any export covering that window prints it or refuses.
function addTombstone(t) {
  const st = loadState();
  if (st.tooNew) return false;
  st.tombstones.push(Object.assign({ at: Date.now() }, t));
  return saveState(st);
}

function tombstonesIn(fromMs, toMs, st) {
  const state = st || loadState();
  const lo = Number.isFinite(fromMs) ? fromMs : -Infinity;
  const hi = Number.isFinite(toMs) ? toMs : Infinity;
  return (state.tombstones || []).filter((t) => {
    const a = Number(t.from ?? t.at); const b = Number(t.to ?? t.at);
    return b >= lo && a < hi;
  });
}

// ---- legacy chat-grain store ------------------------------------------------------
// Pre-store `lifetime.json` chats have no model, no token split, no per-call structure
// and a known-wrong timestamp (all six live entries carry an `at` inside one four-hour
// band, for work spanning weeks). They cannot be reconciled against transcript rows and
// cannot be re-priced, so their dollars are FROZEN and they are EXCLUDED from period
// buckets — putting them in a day would make the fix look done while history stays wrong.
// They count toward lifetime, visibly marked `provisional`.
function loadLegacy() {
  try {
    const j = JSON.parse(fs.readFileSync(legacyPath(), 'utf8'));
    if (j && typeof j === 'object' && j.chats) {
      if (Number(j.v) > 1) return { v: j.v, tooNew: true, chats: {} };
      return j;
    }
  } catch { /* absent */ }
  return { v: 1, chats: {} };
}

// One-time, idempotent freeze of the old chat-grain ledger into legacy_chats.json.
//
// `lifetime.json` keeps being WRITTEN for one deprecation window (see ledger.js), not
// just read: a user who hits a bug and runs `npm i -g cheaper@0.2.5` reads it via the
// old savings.js, and if the new CLI stopped writing it their lifetime total would drop
// by a month with no error at all.
//
// A legacy chat is DELETED the moment its session is backfilled per-call from its
// transcript — that deletion is the reconciliation check, and it is what stops the same
// money being counted once as a frozen chat and again as a set of calls.
function ensureLegacyImported() {
  const p = legacyPath();
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* first run */ }
  if (existing && existing.chats) return existing;
  let ledgerData = null;
  try { ledgerData = require('./ledger').load(); } catch { ledgerData = null; }
  const chats = {};
  for (const k of Object.keys((ledgerData && ledgerData.chats) || {})) {
    const e = ledgerData.chats[k];
    if (!e || !Number.isFinite(e.usd)) continue;
    chats[k] = {
      usd: e.usd, tokens: e.tokens || 0, exact: !!e.exact,
      at: e.at || null, startedAt: e.startedAt || null, endedAt: e.endedAt || null,
      // Frozen: never re-derived, and explicitly excluded from catalog restatement.
      // A chat-grain row has lost the five-way token split, the per-call long-context
      // threshold and the per-call SKU — 10 calls of 30k-in/2k-out price at $0.72
      // per-call and $1.44 aggregated, a 100% overstatement.
      derivation: 'frozen',
      // Their `at` is tagline-run time, not work time. Say so rather than pretending.
      bucket_confidence: e.endedAt ? 'span_known' : 'unknown',
    };
  }
  const out = { v: 1, imported_at: Date.now(), chats };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch { /* best effort — a failed freeze must not break `cheaper savings` */ }
  return out;
}

// Drop a legacy chat once its session has been backfilled per-call. Without this the
// same money is counted once as a frozen chat and again as a set of events.
function retireLegacyChat(sessionId) {
  const p = legacyPath();
  const j = loadLegacy();
  if (j.tooNew || !j.chats || !(sessionId in j.chats)) return false;
  delete j.chats[sessionId];
  try {
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(j), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, p);
    return true;
  } catch { return false; }
}

function legacyTotals() {
  const j = loadLegacy();
  let usd = 0; let tokens = 0; let chats = 0;
  for (const k of Object.keys(j.chats || {})) {
    const e = j.chats[k];
    if (e && Number.isFinite(e.usd)) { usd += e.usd; tokens += e.tokens || 0; chats++; }
  }
  return { usd, tokens, chats, derivation: 'frozen', tooNew: !!j.tooNew };
}

// ---- the read path ----------------------------------------------------------------

// Every folded row currently on disk, plus the fold/read statistics.
function readRows(opts = {}) {
  const { rows: raw, stats: readStats } = events.readAll(opts);
  const { rows, stats: foldStats } = fold(raw, opts);
  return { rows, readStats, foldStats };
}

// Report one half-open window [from, to). Returns a SHAPE, not a number:
//
//   { status: 'ok' | 'not_covered' | 'partial' | 'suppressed',
//     measured: {...}, estimated: {...},   // NEVER summed together
//     labels: [...], notes: [...] }
//
// `labels` is the machine-readable list a renderer keys off; `notes` is the human
// sentence it prints next to (or instead of) a figure.
// Null ONLY the money fields when a window's dollars are suppressed. `calls`, `tokens`,
// `credited` and `offset` survive, because they are exact.
const MONEY_FIELDS = ['saved', 'spent', 'baseline', 'gross', 'extra'];
function withheld(acc, suppressed) {
  if (!suppressed || !acc) return acc;
  const out = Object.assign({}, acc);
  for (const f of MONEY_FIELDS) out[f] = null;
  return out;
}

function reportWindow(rows, from, to, opts = {}) {
  const st = opts.state || loadState();
  // The events in hand are their own coverage evidence — see impliedCoverage().
  const implied = opts.implied || impliedCoverage(rows);
  const cov = coverageFor(from, to, st, implied);
  const tombs = tombstonesIn(from, to, st);
  const labels = [];
  const notes = [];

  if (st.tooNew) {
    return { status: 'suppressed', from, to, measured: null, estimated: null,
             labels: ['store_newer_than_reader'],
             notes: ['This savings store was written by a newer Cheaper. '
                     + 'Upgrade with `npm i -g cheaper` — refusing to guess at its contents.'] };
  }

  if (cov.kind === 'not_covered') {
    return { status: 'not_covered', from, to, measured: null, estimated: null,
             coverage: cov, labels: ['not_covered'],
             notes: ['Cheaper was not watching during this period. '
                     + 'That is not the same as saving $0.'] };
  }
  if (cov.kind === 'partial') {
    labels.push('partial_coverage');
    notes.push('Only part of this period is covered; the figures below describe the '
      + 'covered sub-window only.');
  }

  // Half-open [from, to) — disjoint by construction, so month = sum of its weeks.
  const inWindow = rows.filter((r) => {
    const ts = Number(r.ts);
    if (!Number.isFinite(ts)) return false;
    if (Number.isFinite(from) && ts < from) return false;
    if (Number.isFinite(to) && ts >= to) return false;
    return true;
  });

  const folded = foldRows(inWindow);

  // Case 8 — an undated row is excluded from every bucket AND counted. periods.js used
  // to `continue` silently, so a report could lose rows and still look complete.
  const undated = rows.filter((r) => !Number.isFinite(Number(r.ts))).length;
  if (undated > 0) { labels.push('incomplete'); notes.push(`${undated} event(s) have no usable timestamp and are excluded.`); }

  // Case 7 — more than a fifth of the window's tokens unpriceable: report TOKENS, and
  // suppress dollars. Sticky and explanatory, never a silent blank.
  if (folded.dollarsSuppressed) {
    labels.push('dollars_suppressed');
    notes.push(`${Math.round(folded.unpricedRatio * 100)}% of this window's tokens are `
      + 'not in the price catalog, so no dollar figure is claimed. '
      + 'Refresh with `cheaper update`.');
  }

  // Case 12 — a tombstone inside the window. Totals drop WITH a stated reason.
  if (tombs.length) {
    labels.push('tombstoned');
    notes.push(`${tombs.length} session(s) were deleted with \`cheaper forget\`; `
      + 'their events are excluded from these totals.');
  }

  // Case 11 — an open session in the window. Never final while a chat is still running.
  if (opts.openSessions && opts.openSessions.length) {
    labels.push('provisional');
    notes.push('A session in this window is still open; these figures are provisional.');
  }

  return {
    status: folded.dollarsSuppressed ? 'suppressed' : (cov.kind === 'partial' ? 'partial' : 'ok'),
    from, to, coverage: cov, tombstones: tombs.length,
    // The two bases are returned SEPARATELY and are never summed. A renderer that wants
    // one number must choose a basis and say which one it chose.
    //
    // Under suppression only the DOLLARS are withheld. The call and token counts are
    // exact and are not in doubt, so nulling the whole accumulator would understate
    // what happened on top of declining to price it — and it would contradict the
    // window's own note, which says how many calls could not be priced. This mirrors
    // gateway/app/reporting.py::report_window exactly; the two must not disagree, or
    // `cheaper savings` and the dashboard tell different stories about one window.
    measured: withheld(folded.measured, folded.dollarsSuppressed),
    estimated: withheld(folded.estimated, folded.dollarsSuppressed),
    dollars_suppressed: !!folded.dollarsSuppressed,
    events: folded.events,
    tokens: { measured: folded.measured.tokens, estimated: folded.estimated.tokens },
    unpriced: folded.unpriced,
    unpricedCalls: folded.unpricedCalls,
    unpricedTokens: folded.unpricedTokens,
    undated,
    labels, notes,
    catalog: { as_of: CATALOG_AS_OF },
  };
}

// The disjoint ladder: Today · Earlier this week · … · Before this year.
// These PARTITION history, so they sum to lifetime — the property the old nested
// "since" ladder lacked, which is why six rows could be added to six times today.
function reportLadder(rows, nowMs, tz, opts = {}) {
  const st = opts.state || loadState();
  // Compute the implied envelope ONCE for the whole ladder rather than per window —
  // six passes over every event would make `cheaper savings` O(6n) for no gain.
  const implied = opts.implied || impliedCoverage(rows);
  const o = Object.assign({}, opts, { state: st, implied });
  return periods.disjointLadder(nowMs, tz).map((w) => Object.assign(
    { key: w.key, label: w.label, tz: w.tz },
    reportWindow(rows, w.from, w.to, o)));
}

// Period-over-period, with an explicit `n` on BOTH sides so a 400% jump on 3 events
// reads as the noise it is.
function reportComparison(rows, name, nowMs, tz, opts = {}) {
  const st = opts.state || loadState();
  const cur = periods.periodBounds(name, nowMs, tz);
  const prev = periods.previousPeriodBounds(name, nowMs, tz);
  const o = Object.assign({}, opts, { state: st });
  return {
    period: name,
    current: Object.assign({ bounds: cur }, reportWindow(rows, cur.from, cur.to, o)),
    previous: Object.assign({ bounds: prev }, reportWindow(rows, prev.from, prev.to, o)),
  };
}

// Grouped aggregates for the composition block. `dim` picks the key; dollars stay split
// by basis all the way through, because a per-call measured figure and a per-chat
// estimated one in the same column is the same concealment shape in a place where the
// separation is less visually obvious.
function reportBreakdown(rows, dim, from, to) {
  const key = {
    served: (r) => r.served || '(unknown)',
    base: (r) => r.base || '(none)',
    tier: (r) => r.ctier || '(unclassified)',
    harness: (r) => r.harness || '(unknown)',
    decision: (r) => (r.elig ? 'routed' : 'kept'),
  }[dim] || ((r) => r.served || '(unknown)');

  const groups = new Map();
  for (const r of rows) {
    const ts = Number(r.ts);
    if (Number.isFinite(from) && ts < from) continue;
    if (Number.isFinite(to) && ts >= to) continue;
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [k, rs] of groups) {
    const f = foldRows(rs);
    out.push({ key: k, calls: rs.length,
      measured: f.measured, estimated: f.estimated,
      unpricedCalls: f.unpricedCalls });
  }
  // Sort by the ESTIMATED saving when that is the only basis present, otherwise by
  // measured — never by their sum.
  out.sort((a, b) => (b.measured.saved || b.estimated.saved) - (a.measured.saved || a.estimated.saved));
  return out;
}

// A dated series for the trend chart, bucketed on `pday` — the row's own local calendar
// day, never on ingest time.
function reportTrend(rows, bucketBy, from, to) {
  const keyOf = (r) => {
    const d = r.pday || periods.pdayOf(r.ts, r.tzo);
    if (!d) return null;
    if (bucketBy === 'month') return d.slice(0, 7);
    if (bucketBy === 'week') {
      const b = periods.periodBounds('week', Date.parse(d + 'T12:00:00Z'), 'UTC');
      return periods.pdayOf(b.from, 0);
    }
    return d;
  };
  const groups = new Map();
  for (const r of rows) {
    const ts = Number(r.ts);
    if (Number.isFinite(from) && ts < from) continue;
    if (Number.isFinite(to) && ts >= to) continue;
    const k = keyOf(r);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.keys()].sort().map((k) => {
    const f = foldRows(groups.get(k));
    return { bucket: k, calls: groups.get(k).length,
             measured: f.measured, estimated: f.estimated };
  });
}

module.exports = {
  STATE_V, statePath, legacyPath, loadState, saveState,
  addCoverage, coverageFor, impliedCoverage, addTombstone, tombstonesIn,
  loadLegacy, legacyTotals, ensureLegacyImported, retireLegacyChat,
  readRows, reportWindow, reportLadder, reportComparison, reportBreakdown, reportTrend,
  deriveRow,
};
