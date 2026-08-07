'use strict';
// Union → dedupe by provider id → merge per FIELD, commutatively.
//
// "Prefer measured over estimated" is INVALID here and is deliberately rejected. The
// gateway's streamed rows historically carried no usage at all, so preferring the
// gateway would have deleted real output cost, inflated the savings ratio, and printed
// the result with `exact: true`. Per-session source election also fails: the unit of
// overlap is a CALL, not a chat, and the gateway had no session id to elect on (76 of
// 76 live rows have session NULL or '').
//
// So: every row is kept, deduped on the PROVIDER's key, and each FIELD takes its value
// from whichever source can actually know it.
//
// merge() is COMMUTATIVE and IDEMPOTENT. Replaying any event set in any order must
// converge on the same row and the same total. That property — not the storage engine —
// is what makes this defensible as a financial record, and it is what makes a crash
// mid-append, a re-import, and a synced-folder conflicted copy all harmless.

const { isStrongKey } = require('./events');

const TOKEN = ['in', 'out', 'cr', 'c5', 'c1', 'cu'];
const GW_ONLY = ['req', 'reason'];
const TX_ONLY = ['harness', 'sub', 'ctier', 'cver'];
const FROZEN = ['base', 'bsrc', 'elig'];
const PLAIN = ['served', 'speed', 'svc', 'status', 'pday', 'tzo', 'prov', 'usrc',
               'sfile', 'sbase', 'fsha', 'vok', 'inst', 'w'];

const SRC = { TX: 1, GW: 2, LEGACY: 4 };

function maskOf(e) {
  if (e.prov === 'gateway') return SRC.GW;
  if (e.prov === 'legacy') return SRC.LEGACY;
  return SRC.TX;
}

// Per-field precedence. Higher wins.
//
//   tokens        TX(body) > GW(body) > TX(estimate) > GW(estimate)
//                 The transcript carries the provider's own usage block including the
//                 5m/1h cache-write split, service_tier and speed; the gateway's
//                 streamed rows did not until this release, and old rows never will.
//   req/reason    gateway only — the transcript physically cannot know what was asked
//                 for BEFORE routing, or why the router chose what it chose.
//   harness/sub/  transcript only — the gateway has no session or prompt visibility.
//   ctier/cver
function rank(e, f) {
  if (TOKEN.includes(f)) {
    if (e.prov === 'transcript') return e.usrc === 'body' ? 4 : 2;
    if (e.prov === 'gateway') return e.usrc === 'body' ? 3 : 1;
    return 0;
  }
  if (GW_ONLY.includes(f)) return e.prov === 'gateway' ? 2 : 1;
  if (TX_ONLY.includes(f)) return e.prov === 'transcript' ? 2 : 1;
  if (f === 'ts') return e.prov === 'transcript' ? 2 : 1;  // closer to the user-visible moment
  return 1;
}

// The owning session for a row that appears under several ids. A divergent sessionId on
// a shared provider id is the NORMAL resume/fork case (157 measured across 120
// transcripts) and must never route into the conflict path: treated as conflicts, the
// fold would either lose 4.4% of dollars or blank every window containing a resumed chat.
function electOwner(sessions, _tsHint) {
  const s = (sessions || []).filter(Boolean).slice().sort();
  return s.length ? s[0] : '';
}

const FIELDS = [].concat(TOKEN, GW_ONLY, TX_ONLY, FROZEN, PLAIN, ['ts']);

function merge(x, y) {
  // A higher rev of the same row from the SAME source is a restatement (the session
  // ceiling rose and the writer re-emitted). It supersedes outright.
  if (x.prov === y.prov && (y.rev || 1) !== (x.rev || 1)) {
    return (y.rev || 1) > (x.rev || 1) ? y : x;
  }
  const out = Object.assign({}, x, { conflicts: [].concat(x.conflicts || []) });
  out.sessions = [...new Set([].concat(x.sessions || [], y.sessions || []))].sort();
  out.sess = electOwner(out.sessions, Math.min(x.ts || 0, y.ts || 0));
  out.rev = Math.max(x.rev || 1, y.rev || 1);

  for (const f of FIELDS) {
    const rx = rank(x, f); const ry = rank(y, f);
    if (rx !== ry) {
      out[f] = rx > ry ? x[f] : y[f];
    } else if (TOKEN.includes(f)) {
      // Same precedence: take the LARGER. The transcript writes one API turn across
      // many lines and usage GROWS with each one (measured: 751 ids grew, ZERO shrank),
      // so max is both correct and immune to lines arriving out of order. First-wins
      // under-counted output by 18.7%.
      out[f] = Math.max(Number(x[f]) || 0, Number(y[f]) || 0);
    } else if (x[f] === y[f]) {
      out[f] = x[f];
    } else if (x[f] === undefined || x[f] === null) {
      out[f] = y[f];
    } else if (y[f] === undefined || y[f] === null) {
      out[f] = x[f];
    } else {
      // A genuine disagreement between two sources that should both know. Null it and
      // NAME it, so the row can be suppressed rather than silently picking a winner.
      out[f] = null;
      if (!out.conflicts.includes(f)) out.conflicts.push(f);
    }
  }
  out.conflicts.sort();
  out.source_mask = (x.source_mask || maskOf(x)) | (y.source_mask || maskOf(y));
  // 'measured' requires a GATEWAY row whose tokens came from a response BODY. A
  // transcript row is a faithful reconstruction, but it is still a reconstruction.
  out.conf = ((out.source_mask & SRC.GW) && out.usrc === 'body') ? 'measured' : 'estimated';
  return out;
}

// Fold a flat list of events into one row per identity.
//
// Returns { rows, stats }. `stats` carries every quarantine and suppression reason so
// a caller can LABEL its report rather than quietly report a smaller number.
function fold(events, opts = {}) {
  const byId = new Map();
  const stats = {
    input: 0, folded: 0,
    weakBoth: 0,             // case 3: a BOTH-source row joined by a WEAK key
    weakServedConflict: 0,   // case 4: two weak-key rows disagreeing on `served`
    preMigration: 0,         // case 5: gateway rows with no request id
    staleWriter: 0,          // case 6: quarantined writer
    outlier2x: 0,            // case 15: same STRONG key, `out` differs by >2x
    fieldConflicts: 0,
    quarantined: 0,
  };
  const staleWriters = new Set(opts.staleWriters || []);

  for (const e of events || []) {
    stats.input++;
    if (!e || !e.id) continue;
    // Case 6 — a writer known to be running stale code is QUARANTINED from the fold,
    // not merged. `gatewayIsCurrent()` already detects this; merging its rows would let
    // old logic contribute to a figure that prints with no hedge.
    if (staleWriters.size && staleWriters.has(e.w)) { stats.staleWriter++; stats.quarantined++; continue; }
    // Case 5 — a gateway row from before request-id capture cannot be proven disjoint
    // from the transcript rows covering the same calls. Disjointness is unprovable, so
    // it is dropped from the fold and counted; the window falls back to transcript-only
    // and is labelled `estimated`. This was the ENTIRE 76-row live DB.
    if (e.prov === 'gateway' && !isStrongKey(e.id)) { stats.preMigration++; stats.quarantined++; continue; }

    const prev = byId.get(e.id);
    if (!prev) {
      byId.set(e.id, Object.assign({}, e, {
        source_mask: maskOf(e), conflicts: [].concat(e.conflicts || []),
        sessions: e.sessions && e.sessions.length ? e.sessions.slice() : (e.sess ? [e.sess] : []),
      }));
      continue;
    }
    // Case 15 — the same STRONG key with wildly different output. That is a bug in one
    // of the writers, not a merge: quarantine both halves rather than averaging a lie.
    const a = Number(prev.out) || 0; const b = Number(e.out) || 0;
    if (isStrongKey(e.id) && a > 0 && b > 0 && (Math.max(a, b) > 2 * Math.min(a, b))) {
      stats.outlier2x++; stats.quarantined++;
      prev.quarantined = true;
      continue;
    }
    const m = merge(prev, e);
    // Case 3 — a row that claims BOTH sources but was joined by a WEAK key has not been
    // proven to be the same call. A weak key may SUPPRESS a claim; it may never CREDIT
    // one. Fall back to the transcript row alone, labelled estimated.
    if (!isStrongKey(e.id) && (m.source_mask & SRC.GW) && (m.source_mask & SRC.TX)) {
      stats.weakBoth++;
      const tx = prev.prov === 'transcript' ? prev : e;
      byId.set(e.id, Object.assign({}, tx, { source_mask: maskOf(tx), conf: 'estimated',
        weak_join_suppressed: true }));
      continue;
    }
    // Case 4 — two rows share a WEAK key but disagree on which model was served. They
    // are not the same call; keeping either would credit the wrong one.
    if (!isStrongKey(e.id) && prev.served && e.served && prev.served !== e.served) {
      stats.weakServedConflict++; stats.quarantined += 2;
      byId.delete(e.id);
      continue;
    }
    if (m.conflicts && m.conflicts.length) stats.fieldConflicts++;
    byId.set(e.id, m);
  }

  const rows = [...byId.values()].filter((r) => !r.quarantined);
  stats.folded = rows.length;
  rows.sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id)));
  return { rows, stats };
}

module.exports = { merge, fold, rank, electOwner, maskOf, SRC, TOKEN, GW_ONLY, TX_ONLY };
