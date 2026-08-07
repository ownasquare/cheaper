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
const path = require('path');
const crypto = require('crypto');
const { HOME } = require('./fsutil');

const MAX_WRITE = 1 << 20;          // cap one write(2) at 1 MB
const SCHEMA_V = 1;                 // a segment with a HIGHER v is refused, never zeroed

function eventsDir() {
  return process.env.CHEAPER_EVENTS_DIR || path.join(HOME, '.cheaper', 'events');
}

// Stable per-install id. Two machines on a synced home never share a segment file.
function installId() {
  const p = path.join(HOME, '.cheaper', 'install.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && /^[0-9a-f]{8}$/.test(j.install)) return j.install;
  } catch { /* mint below */ }
  const id = crypto.randomBytes(4).toString('hex');
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify({ v: 1, install: id }), { mode: 0o600 });
  } catch { /* a non-persisted id still writes a valid, dedupable segment */ }
  return id;
}

function segmentPath(writer, ts) {
  const d = new Date(ts || Date.now());
  const ym = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  return path.join(eventsDir(), `${ym}.${installId()}.${writer}.jsonl`);
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

// Append rows to this writer's current-month segment. Returns { written, torn, error }.
function append(rows, writer) {
  if (!rows || !rows.length) return { written: 0, torn: false };
  let fd = null; let torn = false; let written = 0;
  try {
    const p = segmentPath(writer || 'cli', rows[0].ts);
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

// ---- reading ----------------------------------------------------------------------

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
      writer: /\.gw\.jsonl(\.gz)?$/i.test(n) ? 'gw' : 'cli' });
  }
  out.sort((a, b) => String(b.ym || '').localeCompare(String(a.ym || '')) || b.mtime - a.mtime);
  return out;
}

// Read one segment. Tolerates a PARTIAL TRAILING LINE at all times — a segment can be
// appended to while it is being read — and COUNTS it rather than swallowing it. This is
// an explicit tested path, not an incidental try/catch: a silently dropped tail is
// indistinguishable from "there was no activity".
function readSegment(file, onRow) {
  const stats = { rows: 0, bad: 0, partialTail: 0, futureSchema: 0, bytes: 0 };
  let raw;
  try {
    if (/\.gz$/i.test(file)) {
      // A sealed segment is written whole and verified before the sources are unlinked,
      // so it is never torn — but a truncated gzip must still not throw here.
      raw = require('zlib').gunzipSync(fs.readFileSync(file)).toString('utf8');
    } else {
      raw = fs.readFileSync(file, 'utf8');
    }
    stats.bytes = Buffer.byteLength(raw);
  } catch { return stats; }
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
  const stats = { segments: 0, rows: 0, bad: 0, partialTail: 0, futureSchema: 0, bytes: 0 };
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
      o._w = o.w || seg.writer;
      rows.push(o);
    });
    stats.rows += s.rows; stats.bad += s.bad;
    stats.partialTail += s.partialTail; stats.futureSchema += s.futureSchema;
    stats.bytes += s.bytes;
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
//   * base/elig unchanged and the first `n` still end at `last_id` → emit only the tail;
//   * base or elig CHANGED (a later turn raised the session ceiling) → re-emit the WHOLE
//     session at rev+1. That is a visible restatement, which is the honest answer;
//   * the prefix does not match (history rewritten, transcript rotated) → rev+1. Dedupe
//     absorbs it;
//   * nothing new → write NOTHING AT ALL.
function deltaFor(harness, session, events) {
  const cur = readCursor(harness, session);
  const all = events || [];
  const head = all[0] || {};
  const base = head.base || null;
  const elig = !!head.elig;
  const mkCursor = (rev) => ({
    v: 1, n: all.length, last_id: all.length ? all[all.length - 1].id : null,
    base, elig, rev, at: Date.now(),
  });
  if (!cur) return { emit: all, cursor: mkCursor(1), reason: 'first' };
  const restated = cur.base !== base || !!cur.elig !== elig;
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
  append, eventKey, isStrongKey, eventsDir, segmentPath, installId,
  listSegments, readSegment, readAll,
  cursorPath, readCursor, writeCursor, deltaFor,
};
