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
const { deriveRow, foldRows, isoDayMs } = require('./derive');
const periods = require('./periods');
const { CATALOG_AS_OF } = require('./models');

const STATE_V = 1;

// ---- coercion: the mirror is only faithful if the coercions match -------------------
//
// `gateway/app/reporting.py::_finite` — float(v), then a finiteness test — expressed in
// JS. It is NOT `Number(v)`, and the difference is the whole silent half of a shipped
// cross-runtime divergence:
//
//   `Number(null) === 0`, and 0 IS finite. `store.merge` NULLS a field when two sources
//   tie on rank and disagree on its value, so a row whose `ts` died in a merge read as
//   the epoch rather than as absent. It was therefore neither inside the requested
//   window nor counted as excluded — it simply was not there, with no label anywhere,
//   while the gateway (which uses float(), where float(None) raises) reported its
//   dollars in the same window. `Number('')` is 0 for the same reason, and `Number('0x10')`
//   is 16 where Python's float() raises; both are covered here.
//
// Returns a finite number, or null. Never NaN, never a substituted 0.
function finiteOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;          // Python float(True) is 1.0
  if (typeof v === 'string') {
    // Python's float() accepts only decimal / exponent literals, and rejects the empty
    // and blank strings that Number() answers 0 for.
    const s = v.trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    const f = Number(s);
    return Number.isFinite(f) ? f : null;
  }
  if (typeof v !== 'number') return null;                // list/dict: Python raises
  return Number.isFinite(v) ? v : null;
}

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
function emptyState() {
  return { v: STATE_V, coverage: [], tombstones: [], ingested_files: [] };
}

// THREE dispositions of a state file, kept DISTINCT.
//
// They used to collapse into one `catch` that returned an empty document, and
// "there is no state file", "the state file could not be read" and "the state file is
// from the future" are different claims with opposite consequences:
//
//   ABSENT      benign, and the only benign one. A store that never declared coverage has
//               nothing to lose, and `impliedCoverage()` still speaks for the events
//               themselves — which is why a first run reports normally.
//   UNREADABLE  a permission or I/O error, a truncated document, a non-JSON document, or
//               a JSON value that is not an object (`null` parses, and `typeof null` is
//               'object'; an array parses too). That file may hold TOMBSTONES — the
//               record that a user asked for a chat to be excluded from every total — so
//               reading it as "no tombstones" silently RE-ADMITS data the user deleted.
//               Exactly the object the unlocked read-modify-write below could destroy,
//               arriving through a different door. It is a labelled refusal, never an
//               empty state (invariant 7: a "report nothing" case returns a LABEL).
//   TOO NEW     written by a Cheaper that knows fields this one does not. Already a
//               visible refusal — ledger.js's catch-all `{chats:{}}` made a
//               forward-incompatible file read as "you saved nothing", which is the worst
//               way to be wrong about money — and kept here so all three sit in one place.
//
// `unreadable` carries the REASON (an errno string, or which parse step refused) because
// "state.json is corrupt" and "state.json is not readable by this user" need different
// answers from the person holding the terminal.
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(statePath(), 'utf8');
  } catch (e) {
    const code = (e && e.code) || 'read_failed';
    // ENOENT: no file. ENOTDIR: the events dir itself does not exist yet — the same
    // "nothing has been written here" claim, reached one level up.
    if (code === 'ENOENT' || code === 'ENOTDIR') return emptyState();
    return Object.assign(emptyState(), { unreadable: code });
  }
  let j;
  try { j = JSON.parse(raw); }
  catch { return Object.assign(emptyState(), { unreadable: 'unparseable' }); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    return Object.assign(emptyState(), { unreadable: 'not_an_object' });
  }
  if (Number(j.v) > STATE_V) {
    return { v: j.v, tooNew: true, coverage: [], tombstones: [], ingested_files: [] };
  }
  return Object.assign(emptyState(), j);
}

// fsync a DIRECTORY.
//
// `renameSync` publishes a NAME, and a name lives in the directory — fsyncing the FILE
// does not make its name durable. Without this, a crash just after a rename can leave the
// new name absent while its data blocks sit on disk unreachable, on any filesystem that
// does not order metadata behind data. `compact()` depends on it hardest: it unlinks the
// only other copy of a month's events immediately after its rename.
//
// Best effort BY DESIGN, and that is not a swallowed defect. Opening a directory for
// reading is EPERM/EISDIR on Windows and EINVAL on some network filesystems, where no
// portable equivalent exists; the caller's DATA is already fsynced by that point, so what
// is lost there is the ordering guarantee alone. The honest shape is a boolean the caller
// can act on, not an exception that would abort a write that did land.
function fsyncDir(dir) {
  let fd = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); return true; }
  catch { return false; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

// Write the whole document, DURABLY.
//
// `fs.writeFileSync` returns as soon as the bytes are in the page cache, so the old
// tmp-then-rename gave atomicity (a reader sees the old or the new document, never a
// half-written one) but NOT durability: a crash could leave the rename applied and the
// tmp's contents never flushed, i.e. a state.json of zeros or of nothing — which
// `loadState` now refuses out loud rather than reading as "no tombstones".
//
// `writeSync` does not loop internally, so a short write is retried; if it makes no
// progress the tmp is discarded and `false` is returned. A TRUNCATED state document must
// never be renamed into place — it would take the tombstones with it.
function saveState(st) {
  const p = statePath();
  const dir = path.dirname(p);
  const tmp = `${p}.${process.pid}.tmp`;
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = Buffer.from(JSON.stringify(st), 'utf8');
    fd = fs.openSync(tmp, 'w', 0o600);
    let off = 0;
    while (off < body.length) {
      const n = fs.writeSync(fd, body, off, body.length - off);
      if (n <= 0) throw new Error('short write');
      off += n;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, p);
    fsyncDir(dir);
    return true;
  } catch {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return false;
  }
}

// ---- serialising the read-modify-write ---------------------------------------------
//
// `state.json` is the ONE file in this store that is rewritten WHOLE. Everything else is
// an APPEND — that is events.js's structural choice #1, and appends need no lock, which
// is why 600 concurrent records lost 0 rows there. This document cannot be an append:
// `coverage[]` is merged, `tombstones[]` is pushed and `ingested_files[]` is concatenated,
// so a writer must read the current document, mutate it, and put the whole thing back.
// (An op-log would remove the lock, but `gateway/app/store.py::load_state` reads this
// exact JSON document and cannot be changed in lockstep from here.)
//
// Unserialised, that read-modify-write LOSES the interleaved writer's object outright:
//
//   A: loadState()      → { coverage: [c1], tombstones: [] }
//   B: loadState()      → { coverage: [c1], tombstones: [] }
//   B: addTombstone(t)  → saveState({ coverage: [c1],     tombstones: [t] })
//   A: addCoverage(c2)  → saveState({ coverage: [c1, c2], tombstones: []  })   ← t is GONE
//
// and the object most likely to be lost is the one that matters most. A TOMBSTONE is the
// record that a user asked for a chat to be excluded from every total; losing it silently
// RE-ADMITS data the user deleted, with the totals simply going back up. The window is
// narrower than it first looks — `tagline.js` returns before its coverage write when the
// session delta is empty, so the Stop hook does NOT write coverage on every assistant
// turn — but the size of a window does not change what falls through it.
//
// The lock is an O_EXCL create, the same primitive `compact()` already uses for the one
// other operation that can destroy data.
const LOCK_STALE_MS = 30000;      // no mutation here is more than a few ms of work
const LOCK_WAIT_MS = 2000;        // default patience; addTombstone asks for much more
const LOCK_POLL_MS = 12;

function stateLockPath() { return statePath() + '.lock'; }

// Is `pid` a process that exists? `process.kill(pid, 0)` sends no signal; ESRCH means
// gone, EPERM means alive and owned by someone else. On a SYNCED home the pid can belong
// to a different machine entirely, which is why liveness is only ONE of the two staleness
// tests — the mtime age below is the backstop that always terminates.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

// Block the calling thread without a dependency and without a busy spin.
function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* SharedArrayBuffer unavailable — the deadline loop still terminates */ }
}

// Returns the held fd, or null if the lock could not be taken.
//
// NEVER throws, and ALWAYS terminates: a failed lock is a `false` out of the mutator, not
// an exception thrown into a Stop hook that is closing a chat, and not a spin that hangs
// one. Bounded twice over — by the deadline and by an attempt cap — because every path
// that gives up and retries (a lock that vanished mid-inspection, a stale lock broken and
// immediately retaken) is a path that could otherwise loop forever.
const LOCK_MAX_ATTEMPTS = 4000;

function acquireStateLock(waitMs) {
  const p = stateLockPath();
  const deadline = Date.now() + (Number.isFinite(waitMs) ? waitMs : LOCK_WAIT_MS);
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(p, 'wx', 0o600);       // O_EXCL — exactly one winner
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); }
      catch { /* the fd is the lock; its contents only help break a stale one */ }
      return fd;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null;   // EACCES/EROFS: no lock, no write
    }
    // Held. Break it only when its holder provably cannot still be working: a dead pid,
    // or a lock older than any mutation here takes. Re-stat AFTER reading, and unlink only
    // if the mtime is unchanged, so a lock that turned over underneath us (the previous
    // holder finished and a fresh one took it) is never removed on stale evidence.
    let held = null;
    let before = null;
    let vanished = false;
    try { before = fs.statSync(p).mtimeMs; } catch { vanished = true; }
    if (!vanished) {
      try { held = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { held = null; }
      const owner = held && Number(held.pid);
      const stale = (Date.now() - before) > LOCK_STALE_MS
        || (Number.isInteger(owner) && !pidAlive(owner));
      if (stale) {
        try { if (fs.statSync(p).mtimeMs === before) fs.unlinkSync(p); }
        catch { /* someone else broke it first — retry either way */ }
        continue;                                   // retry at once; the attempt cap bounds it
      }
    } else {
      continue;                                     // released while we looked — take it
    }
    if (Date.now() >= deadline) return null;
    sleepMs(LOCK_POLL_MS);
  }
  return null;
}

// Release only OUR OWN lock. A stale-breaker can only have taken it from us after
// LOCK_STALE_MS — far longer than any mutation here takes — but if it did, unlinking
// blind would free a lock somebody else is actively holding and hand the very
// interleaving this module exists to prevent to the next two writers.
function releaseStateLock(fd) {
  try { if (fd !== null) fs.closeSync(fd); } catch { /* ignore */ }
  try {
    const held = JSON.parse(fs.readFileSync(stateLockPath(), 'utf8'));
    if (held && Number(held.pid) !== process.pid) return;   // not ours any more
  } catch { /* gone, or the pid write failed at acquire time: it is ours, remove it */ }
  try { fs.unlinkSync(stateLockPath()); } catch { /* ignore */ }
}

// Read → mutate → write, with nothing else touching the document in between.
//
// Refuses on a state this build must not overwrite: `tooNew` (a newer Cheaper's fields
// would be dropped) and `unreadable` (the file may hold tombstones we cannot see, and
// writing an "empty" document over it would make that loss permanent). Both are the same
// posture ledger.js already takes for a forward-incompatible lifetime.json.
//
// Returns true only when the new document is on disk and fsynced.
function mutateState(fn, opts = {}) {
  const fd = acquireStateLock(opts.waitMs);
  if (fd === null) return false;
  try {
    const st = loadState();
    if (st.tooNew || st.unreadable) return false;
    if (fn(st) === false) return false;
    return saveState(st);
  } catch { return false; }
  finally { releaseStateLock(fd); }
}

// Record that we have observation for [fromMs, toMs). Adjacent/overlapping intervals of
// the same kind are merged so the list stays small over years of use.
function addCoverage(kind, fromMs, toMs, harness) {
  // Under the lock: the read, the merge and the write are one step, so a tombstone
  // written between this function's own read and its own write can no longer be erased
  // by it. See mutateState() for the interleaving this closes.
  return mutateState((st) => {
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
  });
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
  // `finiteOf`, not `Number` — mirrors gateway/app/store.py::implied_coverage, which
  // filters on `_finite`. `Number(null)` is 0, so a row whose `ts` died in a merge used
  // to assert one day of coverage either side of the EPOCH.
  const ts = (rows || []).map((r) => finiteOf(r && r.ts))
    .filter((t) => t !== null).sort((a, b) => a - b);
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
//
// Returns TRUE only when the tombstone is on disk and fsynced. A caller may not print
// "excluded from every total" on a false — a deletion the user was told happened and
// which did not is the same lie as a total that quietly shrinks, pointing the other way.
// It waits far longer than the other mutators for the lock: `cheaper forget` is an
// explicit, interactive command, and losing the write is the one outcome it may not have.
const TOMBSTONE_LOCK_WAIT_MS = 10000;

function addTombstone(t) {
  return mutateState((st) => {
    st.tombstones.push(Object.assign({ at: Date.now() }, t));
  }, { waitMs: TOMBSTONE_LOCK_WAIT_MS });
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

// ---- WHERE A ROW SITS ON THE TIME AXIS — one rule, three dispositions ---------------
//
// MUST stay behaviourally identical to `gateway/app/reporting.py::_pday_start_ms /
// _placement / _window_disposition`. `cli/scripts/check-period-parity.js` executes BOTH
// runtimes over the same rows and the same windows and diffs the calls and the dollars.
//
// `ts` and `pday` are TWO INDEPENDENT FIELDS and `reconcile.merge` can null either one
// without the other: it ranks them separately, so two sources that tie on `ts` and
// disagree null `ts` and NAME it in `conflicts` while an AGREEING `pday` survives
// untouched. `derive.deriveRow` prices off `pday`, not off `ts`. So "this row has no
// usable instant" and "this row cannot be dated" are DIFFERENT CLAIMS, and a row that is
// the first without being the second is fully PRICEABLE.
//
// These three functions used to be three separate `Number(r.ts)` guards, one per report,
// and every one of them was wrong in a different direction:
//
//   * `ts: null` (the merge-conflict shape) coerced to 0, which is finite, so the row
//     fell OUT of its own month with no label and no count — reportWindow said 0 calls
//     for the window in which the gateway said $0.06 on the same row, and the ladder
//     stopped summing to lifetime;
//   * `ts` ABSENT coerced to NaN, so BOTH range guards were false and the row was waved
//     into EVERY window at once: breakdown(April) and breakdown(August) each claimed the
//     same $0.06 and their sum was twice their union, and a January-2027 trend emitted a
//     bucket labelled 2026-08-06. A silent omission traded for a silent fabrication.
//
// The exemption below covers ONLY rows undatable in BOTH senses — no finite `ts` AND no
// `pday` naming a representable calendar day — because those are exactly the rows
// `deriveRow` refuses to price (REASONS.NO_TS). They contribute ZERO dollars wherever
// they are counted, which is what makes exempting them safe; a row carrying a frozen day
// is dated and is tested BY THAT DAY, at the row's own offset.
const DISP_IN = 'in';
const DISP_OUT = 'out';
const DISP_UNDATABLE = 'undatable';

// The instant the local calendar day `pday` BEGAN, in the ROW'S OWN frame.
//
// `periods.pdayOf` renders `ts + tzo` as YYYY-MM-DD, so that day begins at
// `utcMidnight(pday) - tzo`. Returns null — never a substituted instant — when `pday`
// names no representable day, or when no offset can be established at all.
//
// Which strings name a day is decided by `derive.isoDayMs`, NOT re-implemented here:
// `deriveRow` asks the same function before it prices the row, and a placement rule that
// accepted a day the pricer refuses (or refused one it accepts) is exactly how a
// priceable row ends up in no window at all.
//
// THE OFFSET IS THE ROW'S OWN, never the reader's host frame: a report rendered in
// Asia/Tokyo must not restate which day a UTC-7 machine's call happened on. An ABSENT
// `tzo` is RECONSTRUCTED through `periods.tzOffsetAt` — the same helper and the same
// documented fallback `periods.pdayOf` uses for this case — and never read as 0, which is
// the substitution the frozen `tzo` column exists to prevent. The reconstruction is
// resolved at the day's own MIDDAY so that a DST changeover (02:00–03:00 local in every
// zone that has one) cannot decide the answer.
function pdayStartMs(pday, tzo) {
  const midnight = isoDayMs(pday);
  if (midnight === null) return null;
  // Same three-state read of `tzo` as periods.js::pdayOf: absent reconstructs, an
  // explicit 0 is honoured as the real value it is, a fraction truncates like Python's
  // int().
  const missing = tzo === null || tzo === undefined
    || (typeof tzo === 'string' && tzo.trim() === '');
  const n = missing ? NaN : Number(tzo);
  let off;
  if (Number.isFinite(n)) {
    off = Math.trunc(n);
  } else {
    const at = midnight + 43200000;
    off = periods.tzOffsetAt(at);
    if (!Number.isFinite(off)) return null;
    // Python's `local_offset_minutes` resolves through `astimezone()`, which fails when
    // the LOCAL wall time leaves the representable calendar — a year-9999 day read on a
    // far-eastern machine, a year-1 day on a far-western one. JS would happily report the
    // machine offset there and place the row, so the same refusal is written out here.
    // Without it the two runtimes disagree at those edges, which the parity gate proves.
    const local = at + off * 60000;
    if (!(local >= periods.CAL_MIN_MS && local < periods.CAL_MAX_MS)) return null;
  }
  return midnight - off * 60000;
}

// `{ kind, at }` — the ONE instant this row is tested against a window.
//
//   'ts'           a finite `ts`: the instant itself;
//   'pday'         no finite `ts`, but a frozen `pday` naming a real day whose start
//                  instant can be established: the instant that day BEGAN in the row's
//                  own frame. A SINGLE INSTANT, not the day's interval — testing the
//                  day's [start, end) for INTERSECTION puts a row whose day straddles a
//                  boundary in BOTH neighbours (report(A) + report(B) > report(A ∪ B)),
//                  and requiring CONTAINMENT puts it in NEITHER while their union keeps
//                  it. Only a POINT partitions, so a point is what is tested;
//   'unplaceable'  no finite `ts`, a `pday` that DOES name a representable day, and no
//                  offset with which to say when that day began. `deriveRow` still
//                  prices such a row, so it may NOT take the exemption — it answers
//                  `out` for every window instead;
//   'none'         no finite `ts` and no `pday` naming a representable day. `deriveRow`
//                  refuses it with REASONS.NO_TS, so it carries no dollars wherever it
//                  is counted — which is the entire justification for exempting it.
function placement(r) {
  const ts = finiteOf(r && r.ts);
  if (ts !== null) return { kind: 'ts', at: ts };
  const pday = r && r.pday;
  // Asked of the SAME function `deriveRow` asks.
  if (isoDayMs(pday) === null) return { kind: 'none', at: null };
  const at = pdayStartMs(pday, r && r.tzo);
  return at === null ? { kind: 'unplaceable', at: null } : { kind: 'pday', at };
}

// 'in' / 'out' / 'undatable' for one row against one half-open [from, to).
//
// ONE classification, used by reportWindow, reportBreakdown and reportTrend alike, so the
// three cannot disagree about which rows a window holds. What each DOES with 'undatable'
// differs — and every one of those dispositions is counted and visible, never a silent
// drop: reportWindow excludes it and counts it in `undated`; reportBreakdown joins it to
// its own REAL group on the (non-temporal) dimension, where foldRows counts it as an
// unpriced call; reportTrend puts it in the trailing, labelled `undated` point.
function windowDisposition(r, from, to) {
  const p = placement(r);
  if (p.kind === 'none') return DISP_UNDATABLE;
  if (p.at === null) return DISP_OUT;                     // 'unplaceable'
  if (Number.isFinite(from) && p.at < from) return DISP_OUT;
  if (Number.isFinite(to) && p.at >= to) return DISP_OUT;
  return DISP_IN;
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

  // The same refusal for a state file that EXISTS and could not be read. It holds the
  // `cheaper forget` tombstones, so reporting past it would publish totals that may
  // include events the user asked to have excluded — the deletion silently undone. An
  // ABSENT state file is NOT this case and reports normally: `impliedCoverage` speaks for
  // the events themselves, and a store that never declared coverage has no tombstones to
  // miss.
  if (st.unreadable) {
    return { status: 'suppressed', from, to, measured: null, estimated: null,
             labels: ['state_unreadable'],
             notes: [`The savings store's state.json could not be read (${st.unreadable}), `
                     + 'so its coverage intervals and its `cheaper forget` tombstones are '
                     + 'unknown. Refusing to report totals that might include events a '
                     + 'tombstone excludes. Move that file aside to start a fresh one — '
                     + 'the events themselves are untouched.'] };
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
  //
  // NOT a `ts` test. A row whose `ts` was nulled by a merge conflict but whose `pday`
  // survived is PRICEABLE and is placed by its own frozen day, exactly as
  // reportBreakdown and reportTrend place it — and exactly as the gateway places it.
  // Otherwise this function reports 0 calls for a window in which its own siblings, and
  // the gateway's `/api/v1/reports/*`, report a dollar figure on the same row.
  const inWindow = rows.filter((r) => windowDisposition(r, from, to) === DISP_IN);

  const folded = foldRows(inWindow);

  // Case 8 — an undated row is excluded from every bucket AND counted. periods.js used
  // to `continue` silently, so a report could lose rows and still look complete.
  //
  // "No usable timestamp" is NOT the test, and using it as one made this counter claim an
  // exclusion that no longer happens: a row with a surviving `pday` is placed in its own
  // window above. What is counted here is a row with NO INSTANT TO TEST AT ALL — no
  // finite `ts` and no usable frozen day — which is excluded from this window, from every
  // other window, and from lifetime. `deriveRow` refuses to price exactly those rows, so
  // nothing is withheld from the dollars by counting them here.
  const undated = rows.filter((r) => placement(r).at === null).length;
  if (undated > 0) {
    labels.push('incomplete');
    notes.push(`${undated} event(s) have no usable timestamp and no usable frozen day, `
      + 'and are excluded.');
  }

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
    // Every dimension here is NON-TEMPORAL, so a row that cannot be placed on the time
    // axis still has a real `served`, `base`, `tier` and `harness`: it joins its own group
    // and `foldRows` counts it there as an unpriced call, rather than being deleted from
    // every group of every dimension by a range it cannot be tested against. A row that
    // CAN be placed — by its instant, or by the day frozen on it — is tested normally.
    if (windowDisposition(r, from, to) === DISP_OUT) continue;
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [k, rs] of groups) {
    const f = foldRows(rs);
    // Case 7, applied HERE TOO. `foldRows` computes `dollarsSuppressed` for every set of
    // rows it folds, and this function used to compute it and throw it away: a group
    // whose tokens were more than a fifth unpriceable published its raw accumulators as
    // if they described the whole group, with no flag for a renderer to key off. The
    // ladder row covering the same rows said "no dollar figure is claimed" while this
    // group printed one, six lines apart on one screen. Withheld here exactly as
    // `reportWindow` withholds — the DOLLARS only; `events`, `calls`, `tokens` and
    // `unpricedCalls` are exact and survive.
    // NO scalar `calls` here. `rs.length` is measured rows PLUS estimated rows in one
    // cell — the same cross-basis sum a combined Saved column would be, in a place where
    // the separation is far less visually obvious, and the exact field the gateway's
    // structural test asserts must never be emitted. The per-basis `calls` inside each
    // accumulator, plus `unpricedCalls`, say the same thing without ever adding the two.
    //
    // `events` is the per-basis ROWS SEEN count — the same field, spelt the same way and
    // meaning the same thing, that `reporting.py::report_breakdown` emits. It was omitted
    // here entirely, which is why `check-period-parity.js` could not diff it and why the
    // gateway's copy could drift into meaning ROWS PRICED without any gate noticing.
    // Two columns or nothing: it is never flattened into one scalar.
    out.push({ key: k, grain: 'call',
      measured: withheld(f.measured, f.dollarsSuppressed),
      estimated: withheld(f.estimated, f.dollarsSuppressed),
      dollars_suppressed: !!f.dollarsSuppressed,
      events: f.events,
      unpricedCalls: f.unpricedCalls, unpriced: f.unpriced });
  }
  // Sort by the ESTIMATED saving when that is the only basis present, otherwise by
  // measured — never by their sum.
  //
  // A WITHHELD group has no magnitude to be ordered by, and `(null || null)` fed to a
  // subtraction yields NaN — an unstable comparator, which is how a "harmless" ordering
  // expression turns a declined figure into arbitrary output. Such groups sort LAST, as
  // a group with no claim, and are never coerced to a 0 that would rank them among the
  // measured zeroes.
  out.sort((a, b) => {
    const x = groupSortValue(a);
    const y = groupSortValue(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  });
  return out;
}

// Mirrors gateway/app/reporting.py::_group_sort_value — the same falsy-fallback the old
// `b.measured.saved || b.estimated.saved` had, made null-aware.
function groupSortValue(g) {
  const m = g.measured ? g.measured.saved : null;
  const e = g.estimated ? g.estimated.saved : null;
  const v = m || e;
  return (v === null || v === undefined || !Number.isFinite(Number(v))) ? null : Number(v);
}

// A dated series for the trend chart, bucketed on `pday` — the row's own local calendar
// day, never on ingest time. `ingested_at` exists for audit and never assigns a row to a
// period.
//
// A row this function CANNOT date is skipped and COUNTED, never bucketed at a fabricated
// day: it surfaces as ONE trailing, labelled `undated` entry, so its calls are still
// visible and are simply attributed to no day. The entry is emitted ONLY when such rows
// exist, so a clean series is byte-identical to before.
//
// `from`/`to` filter every row that can be PLACED on the time axis — by its own `ts`, or,
// when that was nulled by a merge conflict, by the calendar day frozen on the row at the
// row's own offset. A row carrying a usable `pday` is DATED: it is tested against the
// window by that day and bucketed at that day, so a 2027 request can no longer emit a
// bucket labelled 2026-08-06 carrying real dollars that every other window claims too.
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
  const undated = [];
  for (const r of rows) {
    const disp = windowDisposition(r, from, to);
    if (disp === DISP_OUT) continue;
    const k = disp === DISP_UNDATABLE ? null : keyOf(r);
    if (!k) { undated.push(r); continue; }
    groups.get(k) ? groups.get(k).push(r) : groups.set(k, [r]);
  }
  // NO scalar `calls` on a point either — see reportBreakdown. Two columns or nothing.
  // `events` is the per-basis ROWS SEEN count, matching `reporting.py::report_trend`
  // field-for-field so the placement parity gate can diff it.
  //
  // Case 7 applies to a BUCKET exactly as it applies to a window. `foldRows` already
  // decided whether this bucket's dollars can be claimed; publishing the raw
  // accumulators threw that decision away, and the day-grain bucket covers exactly the
  // rows the ladder's Today row covers — so one screen carried "withheld … so no dollar
  // figure is claimed" and "$0.02 │ $0.02" for the SAME calls. The flag travels with the
  // point so a renderer has a field to key off instead of guessing.
  const point = (bucket, group, undatable) => {
    const f = foldRows(group);
    return { bucket, grain: 'call', undatable: !!undatable,
             measured: withheld(f.measured, f.dollarsSuppressed),
             estimated: withheld(f.estimated, f.dollarsSuppressed),
             dollars_suppressed: !!f.dollarsSuppressed,
             events: f.events,
             unpricedCalls: f.unpricedCalls };
  };
  const out = [...groups.keys()].sort().map((k) => point(k, groups.get(k), false));
  // LAST, and flagged. It carries no date because none could be derived; a renderer must
  // label it rather than plot it, and a reader must not add it to a dated total. Dropping
  // it silently would shrink the denominator with no trace — the same concealment as
  // printing $0.00 for an unpriceable model.
  if (undated.length) out.push(point('undated', undated, true));
  return out;
}

module.exports = {
  STATE_V, statePath, legacyPath, loadState, saveState,
  // `saveState` writes the WHOLE document. Every caller that first READS it must go
  // through `mutateState` instead, or it reintroduces the lost-tombstone interleaving.
  stateLockPath, mutateState, fsyncDir,
  addCoverage, coverageFor, impliedCoverage, addTombstone, tombstonesIn,
  loadLegacy, legacyTotals, ensureLegacyImported, retireLegacyChat,
  readRows, reportWindow, reportLadder, reportComparison, reportBreakdown, reportTrend,
  deriveRow,
  // Exported for the cross-runtime placement gate (cli/scripts/check-period-parity.js)
  // and for tests that pin the disposition directly.
  finiteOf, pdayStartMs, placement, windowDisposition,
};
