'use strict';
// The per-call event store: append-only JSONL, monthly segments, per writer, per
// install. Zero dependencies, and deliberately NOT a SQL engine.
//
// Why not SQL (measured, not assumed):
//   * a single JSON document — today's ledger shape — lost 281 of 600 records with two
//     concurrent writers, both exiting 0, and becomes permanently unwritable at ~1.62M
//     rows when JSON.stringify hits V8's 536,870,888-char cap;
//   * sql.js has the same last-writer-wins flaw (315/600) and takes no file locks;
//   * node-sqlite3-wasm silently refuses WAL and left a shared DB unopenable;
//   * better-sqlite3 is correct and fast but has NO Node-20 prebuild, so `npm i -g`
//     triggers a node-gyp compile, and under Electron the Node-20 binary throws
//     NODE_MODULE_VERSION 115 … requires 125 — which is exactly how cheaper-desktop
//     spawns this CLI. The bind is lazy, so an import-only smoke test passes and ships
//     a broken DMG.
//   JSONL lost 0 of 600 with a Node and a Python process appending simultaneously,
//   survived 10 rounds of kill -9 across 725,000 records with zero mid-file
//   corruption, and durably appends a 40-call batch in 4.4 ms.
//
// THREE structural choices, each load-bearing:
//   1. Per-writer-class files (cli | gw) remove cross-language interleaving instead of
//      relying on O_APPEND atomicity between Node and CPython, which holds on APFS but
//      is not guaranteed on NFS/SMB.
//   2. Per-install segment names make a synced home folder correct by construction.
//      Two machines appending to one `2026-08.cli.jsonl` through Dropbox get whole-file
//      last-writer-wins (a month silently truncated) or a "(conflicted copy)" a reader
//      globbing an exact name never opens. With an install id they never write the same
//      file — and the reader GLOBS `*.jsonl`, so a conflicted copy folds through dedupe
//      rather than being ignored.
//   3. Segments are named by UTC month; a local-calendar query reads the adjacent
//      segment on each side. Deterministic, and the reader filters on `ts` regardless.
//
// This module NEVER throws. An audit write must not be able to break a chat's closing
// line — the same posture ledger.js already takes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { HOME } = require('./fsutil');

const MAX_WRITE = 1 << 20;          // cap one write(2) at 1 MB
const SCHEMA_V = 1;                 // a segment with a HIGHER v is refused, never zeroed

function eventsDir() {
  return process.env.CHEAPER_EVENTS_DIR || path.join(HOME, '.cheaper', 'events');
}

// The install id when `~/.cheaper/install.json` cannot be written.
//
// It is DERIVED, not random, and that is the whole point. A random id that is never
// persisted is a DIFFERENT id on every run, and the id is part of every segment's NAME
// (structural choice #2 above) — so a machine whose `~/.cheaper` is unwritable does not
// merely lose the synced-home guarantee, it accumulates ONE SEGMENT FILE PER
// INVOCATION. With the Stop hook firing on every assistant turn that is a new file every
// few seconds, a directory that eventually cannot be listed cheaply, and a `readAll` that
// opens all of them. The old comment here — "a non-persisted id still writes a valid,
// dedupable segment" — was true of the ROWS and false of the DIRECTORY, and the directory
// is what breaks first.
//
// The seed is machine-and-account identity, never a path: two machines on one synced home
// still differ (different hostnames), two accounts on one machine still differ, and the
// same machine answers the same id forever. The OUTPUT is a truncated SHA-256, so nothing
// in it can be read back as a hostname, a username or a directory — it satisfies the same
// "no filesystem path in the event store" rule the emitted rows do, because `emit.js`
// stamps this id onto every row as `inst`.
//
// A derived id CAN collide where a random one would not (two cloned VMs with one hostname
// and one username). That degrades to the pre-install-id behaviour — one shared file,
// folded through dedupe — which is a bounded, already-survivable state. One file per
// process invocation is neither.
function derivedInstallId() {
  let host = '';
  let user = '';
  try { host = String(os.hostname() || ''); } catch { /* no hostname resolvable */ }
  try { user = String(os.userInfo().username || ''); } catch { /* no passwd entry */ }
  return crypto.createHash('sha256')
    .update(['cheaper-install-v1', host, user, process.platform, process.arch].join('\0'))
    .digest('hex').slice(0, 8);
}

// Said ONCE per process per path. This module never throws — an audit write must not be
// able to break a chat's closing line — but silence here is how the one-file-per-run state
// above went unnoticed, so it is stated on stderr. It is suppressed under the Stop hook:
// `stop-tagline.js` is by far the most frequent invocation and its stderr is the user's
// chat, which is not the place to repeat a machine-configuration problem every turn.
const WARNED_INSTALL = new Set();
function warnUnpersistedInstall(p) {
  if (process.env.CHEAPER_FROM_HOOK === '1') return;
  if (WARNED_INSTALL.has(p)) return;
  WARNED_INSTALL.add(p);
  try {
    process.stderr.write(
      'cheaper: ~/.cheaper/install.json could not be written — falling back to a '
      + 'machine-derived install id.\n'
      + '        Fix that directory\'s permissions to keep this id stable across '
      + 'upgrades and restores.\n');
  } catch { /* a closed stderr must not break an audit write either */ }
}

// Stable per-install id. Two machines on a synced home never share a segment file.
//
// `source` names WHICH of the three answers this is, so a caller that wants to disclose
// the degradation can, without re-deriving it: 'persisted' (read back), 'minted' (fresh
// random, and it reached the disk) or 'derived' (see derivedInstallId above). Deliberately
// NOT memoised across calls: `HOME` is read through `fsutil` at call time so the test
// suite can point a whole run at a scratch home, and a memo would leak one test's id into
// the next.
function installIdInfo() {
  const p = path.join(HOME, '.cheaper', 'install.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && /^[0-9a-f]{8}$/.test(j.install)) return { id: j.install, source: 'persisted' };
  } catch { /* mint below */ }
  const id = crypto.randomBytes(4).toString('hex');
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify({ v: 1, install: id }), { mode: 0o600 });
    return { id, source: 'minted' };
  } catch { warnUnpersistedInstall(p); }
  // NOT the random `id` above: it was never persisted, so returning it would mint a new
  // one — and therefore a new segment FILE — on every single run.
  return { id: derivedInstallId(), source: 'derived' };
}

function installId() { return installIdInfo().id; }

// The UTC month a row belongs to. Split out of `segmentPath` so `append` can bucket a
// batch by EACH ROW'S OWN month without paying an `installId()` file read per row.
function segmentMonth(ts) {
  const d = new Date(ts || Date.now());
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

function segmentPath(writer, ts) {
  return path.join(eventsDir(), `${segmentMonth(ts)}.${installId()}.${writer}.jsonl`);
}

// The idempotency key. A function of the call's IDENTITY only — never of its measured
// values, never of its source, never of a positional index.
//
// Position is disqualified twice over: fsutil sorts files newest-first, so touching one
// sub-agent transcript shifts every index; and files over 32 MB are read tail-only, so
// a long chat's leading calls vanish and everything after them shifts. Source is
// disqualified because the same chat imported as `ledger` and again as `transcript`
// would mint two rows and double — the six live chats total $16.15; a naive re-import
// reads $32.30.
//
//   K1  rid:  provider request id   STRONG — may merge and may CREDIT
//   K2  mid:  assistant message id  STRONG
//   K3  wk:   weak content hash     WEAK — may only SUPPRESS a claim, never credit
function eventKey(e) {
  if (e.requestId) return 'rid:' + e.requestId;
  if (e.messageId) return 'mid:' + e.messageId;
  const h = crypto.createHash('sha256').update([
    e.harness || '', e.sess || '', e.served || '',
    Math.floor((e.ts || 0) / 60000), e.in || 0, e.out || 0,
  ].join('\0')).digest('hex').slice(0, 24);
  return 'wk:' + h;
}

function isStrongKey(id) { return /^(rid|mid):/.test(String(id || '')); }

// Append one already-grouped set of rows to ONE segment file.
// Returns { written, torn, error }; every caller goes through `append` below.
function appendSegment(p, rows) {
  let fd = null; let torn = false; let written = 0;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(p), 0o700); } catch { /* umask may have widened it */ }
    fd = fs.openSync(p, 'a', 0o600);             // O_APPEND
    let buf = '';
    const flush = () => {
      if (!buf) return;
      const b = Buffer.from(buf, 'utf8');
      buf = '';
      let off = 0;
      while (off < b.length) {
        // writeSync does NOT loop internally. A short write would tear a record, so
        // retry the remainder; if it makes no progress, RECORD that rather than
        // pretending the line landed.
        const n = fs.writeSync(fd, b, off, b.length - off);
        if (n <= 0) { torn = true; return; }
        off += n;
      }
    };
    for (const r of rows) {
      const line = JSON.stringify(r) + '\n';     // JSON.stringify escapes \n and \r
      if (Buffer.byteLength(buf) + Buffer.byteLength(line) > MAX_WRITE) flush();
      buf += line;
      written++;
    }
    flush();
    fs.fsyncSync(fd);
  } catch (e) {
    return { written: 0, torn, error: String((e && e.message) || e) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return { written, torn };
}

// Append rows to this writer's segments, ONE FD PER UTC MONTH. Returns
// { written, torn, error }.
//
// The month is taken from EACH ROW'S OWN `ts`, never from `rows[0]`. Deriving one
// segment path for the whole batch was a silent, money-visible data loss:
//
//   * `emit.js` sorts a session ASCENDING by ts, so `rows[0]` is the OLDEST row. A chat
//     that crosses a UTC month boundary — 23:50 on the 31st, 00:10 on the 1st — filed
//     BOTH months into the earlier month's file. That is not merely untidy filing:
//     `readAll` skips an out-of-range segment BY ITS FILENAME MONTH, so a report
//     starting mid-September never opened the August segment and the September calls
//     inside it vanished from the total with no label and no count.
//   * `forget.js::compact` also decides what is "sealed" by the filename month, so the
//     misfiled rows were sealed into a FINISHED month while the month they actually
//     belong to was still being written.
//
// The trigger is narrow — the ordinary `delta` branch of `deltaFor` appends a tail that
// is already inside one month — but the `restated` / `prefix-mismatch` branches re-emit
// the WHOLE session, and a session is exactly the thing that spans midnight.
function append(rows, writer) {
  if (!rows || !rows.length) return { written: 0, torn: false };
  const w = writer || 'cli';
  const dir = eventsDir();
  const inst = installId();                      // one file read for the whole batch
  // Insertion-ordered, so a single-month batch takes exactly the path it always did.
  const byMonth = new Map();
  for (const r of rows) {
    const ym = segmentMonth(r && r.ts);
    let g = byMonth.get(ym);
    if (!g) { g = []; byMonth.set(ym, g); }
    g.push(r);
  }
  let written = 0; let torn = false; let error = null;
  for (const [ym, group] of byMonth) {
    const res = appendSegment(path.join(dir, `${ym}.${inst}.${w}.jsonl`), group);
    written += res.written;
    if (res.torn) torn = true;
    if (res.error && !error) error = res.error;
  }
  // A failure ANYWHERE in the batch reports `written: 0`, exactly as the single-segment
  // writer always has. `tagline.js` advances the Stop-hook cursor only on `written > 0`,
  // so reporting the rows that DID land would step the cursor past the month that did
  // not and lose it forever. Re-emitting the whole batch next turn is harmless — the
  // ids are idempotent and `reconcile.fold` collapses the duplicates. The rows that did
  // land are NAMED in `landed` rather than swallowed.
  if (error) return { written: 0, torn, error, landed: written };
  return { written, torn };
}

// ---- reading ----------------------------------------------------------------------

// Which WRITER CLASS a segment name attributes itself to, or NULL when the name
// attributes none.
//
// The old test was `/\.gw\.jsonl(\.gz)?$/i ? 'gw' : 'cli'` — an `else` branch that
// answered 'cli' for every name that was not literally a gw segment. Two names fall in
// that gap and both are real:
//
//   * `<ym>.<inst>.sealed.jsonl.gz`, written by `cheaper compact`, is the MERGE of that
//     month's cli AND gw segments. It cannot be attributed to either. `readAll` stamps
//     `_w = row.w || segment.writer`, so every gw-origin row inside a sealed month that
//     did not carry a `w` of its own read back as writer 'cli' — a confident wrong
//     attribution produced by an else branch, which is exactly the class of answer the
//     rest of this store refuses to give.
//   * a sync client's conflicted copy inserts its marker before the LAST extension
//     (`2026-08.a1b2c3d4.gw (conflicted copy).jsonl`), which the anchored `\.gw\.jsonl$`
//     test also missed — so the file was read (the glob below is deliberately loose) and
//     then mis-attributed.
//
// So the writer is read as the LAST dot-separated token of the name with the
// `.jsonl[.gz]` tail removed, and anything that is not `cli` or `gw` — `sealed`, or a
// name that names no writer at all — answers null. A labelled non-answer, never a guess.
const SEG_TAIL = /\.jsonl(\.gz)?$/i;

function segmentWriter(name) {
  const stem = String(name || '').replace(SEG_TAIL, '');
  const parts = stem.split('.');
  // Strip a sync client's " (conflicted copy)" / " (1)" marker off the token.
  const tok = String(parts[parts.length - 1] || '')
    .replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
  if (tok === 'gw') return 'gw';
  if (tok === 'cli') return 'cli';
  return null;
}

// Every segment on disk, newest month first. Globs `*.jsonl` deliberately so a sync
// client's "(conflicted copy)" file is READ and folded through dedupe rather than
// silently skipped by an exact-name lookup.
function listSegments(dir) {
  const d = dir || eventsDir();
  let names = [];
  try { names = fs.readdirSync(d); } catch { return []; }
  const out = [];
  for (const n of names) {
    // `.jsonl` = a live segment; `.jsonl.gz` = a month sealed by `cheaper compact`.
    // Both are read: retention keeps raw events forever, gzipped, because an audit log
    // that discards its evidence to save a few megabytes is not an audit log.
    const gz = /\.jsonl\.gz$/i.test(n);
    if (!gz && !/\.jsonl$/i.test(n)) continue;
    const m = /^(\d{4}-\d{2})\./.exec(n);
    let size = 0; let mtime = 0;
    try { const st = fs.statSync(path.join(d, n)); size = st.size; mtime = st.mtimeMs; }
    catch { continue; }
    out.push({ file: path.join(d, n), name: n, ym: m ? m[1] : null, size, mtime, gz,
      writer: segmentWriter(n) });
  }
  out.sort((a, b) => String(b.ym || '').localeCompare(String(a.ym || '')) || b.mtime - a.mtime);
  return out;
}

// Read one segment. Tolerates a PARTIAL TRAILING LINE at all times — a segment can be
// appended to while it is being read — and COUNTS it rather than swallowing it. This is
// an explicit tested path, not an incidental try/catch: a silently dropped tail is
// indistinguishable from "there was no activity".
//
// A segment whose BYTES cannot be obtained is LABELLED, never returned as an empty one.
// The old single `catch { return stats; }` covered both `readFileSync` and
// `gunzipSync` and answered "0 rows" — while `readAll` still counted the segment — so
// "1 segment read, 0 rows" meant either "a genuinely quiet month" or "a segment this
// process could not open", with nothing on the surface able to tell them apart. That is
// the same class of silence as a dropped tail, so it gets the same treatment: two named
// counters, `unreadable` (the file could not be read at all — a restore that lost the
// mode bits, a hostile umask, a half-synced file) and `corrupt` (the bytes were read but
// the gzip did not inflate). Neither is a new dollar figure; both are the label that
// stops a truncated read from passing for a complete one.
function readSegment(file, onRow) {
  const stats = { rows: 0, bad: 0, partialTail: 0, futureSchema: 0, bytes: 0,
                  unreadable: 0, corrupt: 0 };
  let raw;
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch { stats.unreadable = 1; return stats; }
  if (/\.gz$/i.test(file)) {
    // A sealed segment is written whole and verified before the sources are unlinked,
    // so it is never torn — but a truncated gzip must still not throw here, and must not
    // be indistinguishable from a sealed month that happened to hold nothing.
    try { raw = require('zlib').gunzipSync(bytes).toString('utf8'); }
    catch { stats.corrupt = 1; return stats; }
  } else {
    raw = bytes.toString('utf8');
  }
  stats.bytes = Buffer.byteLength(raw);
  const parts = raw.split('\n');
  const tail = parts.pop();                      // '' when the file ends in \n
  if (tail && tail.length) stats.partialTail = 1; // a genuinely partial last record
  for (const line of parts) {
    const s = line.trim();
    if (!s) continue;
    if (s[0] !== '{') { stats.bad++; continue; }
    let o;
    try { o = JSON.parse(s); } catch { stats.bad++; continue; }
    // A schema version higher than this reader understands is a VISIBLE REFUSAL, never
    // a zero. ledger.js's `catch → {chats:{}}` meant a forward-incompatible file read
    // as "you saved nothing", which is the worst possible way to be wrong here.
    if (Number(o.v) > SCHEMA_V) { stats.futureSchema++; continue; }
    stats.rows++;
    try { onRow(o); } catch { /* one bad row must not end the scan */ }
  }
  return stats;
}

// Read every segment, newest month first, stopping early once `opts.sinceMs` is
// provably out of range for the remaining (older) months.
function readAll(opts = {}) {
  const dir = opts.dir || eventsDir();
  const segs = listSegments(dir);
  const rows = [];
  const stats = { segments: 0, rows: 0, bad: 0, partialTail: 0, futureSchema: 0, bytes: 0,
                  unreadable: 0, corrupt: 0 };
  for (const seg of segs) {
    if (opts.sinceMs && seg.ym) {
      // A UTC-month segment can hold local-calendar events one day either side, so
      // never skip the ADJACENT month — compare against the month after the segment.
      const end = Date.UTC(+seg.ym.slice(0, 4), +seg.ym.slice(5, 7), 2);
      if (end < opts.sinceMs) continue;
    }
    stats.segments++;
    const s = readSegment(seg.file, (o) => {
      o._seg = seg.name;
      // `|| null` rather than `|| 'cli'`: a sealed segment attributes no writer (see
      // segmentWriter), so a row that carried no `w` of its own has an UNKNOWN writer.
      // Naming it 'cli' was a guess, and a gw-origin row is exactly the one that loses.
      o._w = o.w || seg.writer || null;
      rows.push(o);
    });
    stats.rows += s.rows; stats.bad += s.bad;
    stats.partialTail += s.partialTail; stats.futureSchema += s.futureSchema;
    stats.bytes += s.bytes;
    // Propagated, not absorbed: `stats.segments` was already incremented above, so
    // without these a segment nobody could read reported as a segment with no rows.
    stats.unreadable += s.unreadable; stats.corrupt += s.corrupt;
  }
  return { rows, stats };
}

// ---- the Stop-hook delta cursor ---------------------------------------------------
// Claude Code fires Stop on EVERY assistant turn and the tagline re-scans the whole
// session each time, so a 200-turn chat with 40 calls would append ~8,000 lines to
// represent 40 events. The cursor makes each append exact and bounded.

function cursorPath(harness, session) {
  const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
  return path.join(eventsDir(), '.hw', `${safe(harness)}.${safe(session)}.json`);
}

function readCursor(harness, session) {
  try {
    const j = JSON.parse(fs.readFileSync(cursorPath(harness, session), 'utf8'));
    if (j && typeof j === 'object' && Number.isFinite(j.n)) return j;
  } catch { /* no cursor yet */ }
  return null;
}

function writeCursor(harness, session, cur) {
  const p = cursorPath(harness, session);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cur), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, p);                       // atomic on POSIX and NTFS
    return true;
  } catch { return false; }
}

// Which of `events` still need appending, given the cursor.
//
//   * base/elig/erule unchanged and the first `n` still end at `last_id` → emit only the
//     tail;
//   * base, elig or the eligibility RULE CHANGED (a later turn raised the session
//     ceiling, or the session acquired its first sub-agent) → re-emit the WHOLE session
//     at rev+1. That is a visible restatement, which is the honest answer;
//   * the prefix does not match (history rewritten, transcript rotated) → rev+1. Dedupe
//     absorbs it;
//   * nothing new → write NOTHING AT ALL.
//
// THE FINGERPRINT MUST CARRY THE RULE, NOT ONLY ITS VERDICT. `base` and `elig` are read
// from `head` — the FIRST event — and `counterfactual.sessionFrame` swaps the
// eligibility rule for the WHOLE session the moment it sees its first sub-agent
// (`routedAware`): before, eligible means "not on the ceiling model"; after, it means
// "was a sub-agent". A sub-agent does not enter the ceiling `pool`, so `base` does not
// move, and the head row is typically a top-level turn ON the ceiling model, so its
// `elig` is false under BOTH rules. The fingerprint therefore did not change, no
// restatement was emitted, and the middle rows — a top-level turn on a cheaper model,
// `elig: true` under the old rule and `elig: false` under the new one — stayed on disk
// at the highest rev of their id (reconcile.js:72-73 keeps the highest rev, and the tail
// append never re-emits them). One session, two eligibility rules, one of them stale.
// `emit.js` stamps the rule itself as `erule`, and it is compared here.
function deltaFor(harness, session, events) {
  const cur = readCursor(harness, session);
  const all = events || [];
  const head = all[0] || {};
  const base = head.base || null;
  const elig = !!head.elig;
  // Null-normalised on BOTH sides so a cursor written before `erule` existed compares
  // as a CHANGE against a row that now carries one — a one-off restatement per live
  // session on upgrade, which is the fail-safe direction: those are exactly the sessions
  // that may be holding rows frozen under a rule the writer has since swapped.
  const erule = head.erule || null;
  const mkCursor = (rev) => ({
    v: 1, n: all.length, last_id: all.length ? all[all.length - 1].id : null,
    base, elig, erule, rev, at: Date.now(),
  });
  if (!cur) return { emit: all, cursor: mkCursor(1), reason: 'first' };
  const restated = cur.base !== base || !!cur.elig !== elig || (cur.erule || null) !== erule;
  const prefixOk = cur.n <= all.length &&
    (cur.n === 0 || (all[cur.n - 1] && all[cur.n - 1].id === cur.last_id));
  const rev = Number(cur.rev) || 1;
  if (restated || !prefixOk) {
    const bumped = all.map((e) => Object.assign({}, e, { rev: rev + 1 }));
    return { emit: bumped, cursor: mkCursor(rev + 1),
      reason: restated ? 'restated' : 'prefix-mismatch' };
  }
  const tail = all.slice(cur.n);
  if (!tail.length) return { emit: [], cursor: null, reason: 'no-op' };
  return { emit: tail.map((e) => Object.assign({}, e, { rev })), cursor: mkCursor(rev),
    reason: 'delta' };
}

module.exports = {
  SCHEMA_V, MAX_WRITE,
  append, eventKey, isStrongKey, eventsDir, segmentPath,
  installId, installIdInfo, derivedInstallId,
  listSegments, segmentWriter, readSegment, readAll,
  cursorPath, readCursor, writeCursor, deltaFor,
};
