'use strict';
// Turn a session's normalized call records into per-call EVENT rows, with the
// counterfactual FROZEN at write time.
//
// Why freeze rather than derive at read time: `realizedFromRecords` derives every
// call's saving from three SESSION-scoped values — the ceiling model, the session date,
// and the routedAware verdict that flips the eligibility rule for every record. Store
// only `ts` and you have fixed WHEN a call happened while leaving WHAT IT WAS WORTH
// unstable: a chat spans midnight, the 23:50 ceiling is Sonnet, the 00:10 turn runs on
// Opus, and every prior-day event's saving retroactively increases.
//
// It also kills the query-window-dependent baseline. Any design that prices a row
// against a ceiling derived from the QUERY SCOPE makes
//     savings(today) + savings(rest of month) != savings(month)
// Measured on one real session: the same 25 credited calls come to +$0.79 against
// claude-opus-5 and -$32.69 against claude-sonnet-5 — a 42x swing and a sign flip from
// nothing but which model happened to be the priciest top-level turn inside the window.
//
// NO DOLLAR FIGURE IS EVER STORED. Only tokens, plus the frozen inputs. Dollars are
// derived per row at the row's own pday and SKU (see derive.js), so a catalog
// correction restates history the way a corrected exchange rate should.
//
// PRIVACY IS AN ENFORCEABLE ALLOWLIST, not a caution: no field may contain a filesystem
// path or prompt-derived text. `test/events.test.js` generates a log from fixtures and
// greps it for a home directory, the literal "/Users", and any value beginning with "/".

const { contentTier } = require('./classify');
const { tokenBreakdown, billingCtx, sessionFrame } = require('./counterfactual');
const { pdayOf, tzOffsetAt } = require('./periods');
const { resolveModel } = require('./models');
const { eventKey, SCHEMA_V, installId } = require('./events');

// The classifier's version. It appears in Reports provenance next to catalog.as_of.
//
// Storing `ctier` bakes the classifier's judgement into history, which is a real
// tradeoff, stated plainly: a classifier change no longer restates the past the way a
// catalog correction does. The alternative is worse — the schema stores no prompt text
// (correctly), so WITHOUT a frozen verdict every transcript row re-derives to $0 saved,
// which is all of a typical user's real usage.
const CLASSIFIER_VERSION = 3;

// Fields that must never appear in a stored event, checked as a shape not a vibe.
const FORBIDDEN_KEYS = ['text', 'prompt', 'path', 'file', 'cwd', 'dir', 'snippet'];

// Build the event rows for ONE session's records.
//
//   records — normalized adapter records for the whole session (main + sub-agents)
//   meta    — { harness, sessionId, prov, writer }
//
// Returns [] (never null) when there is no honest claim to make.
function eventsFromRecords(records, meta = {}) {
  const frame = sessionFrame(records);
  if (!frame) return [];
  const { priced, idOf, ceilingModel, isEligible, bsrc } = frame;
  const inst = installId();
  const harness = meta.harness || (records[0] && records[0].harness) || 'unknown';
  const out = [];

  // Stable order: by event time, then by the row's own id. An append-only log whose
  // order depends on filesystem iteration produces a different cursor prefix on every
  // run, which would make the Stop-hook delta re-emit the whole session every turn.
  const ordered = priced.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)
    || String(a.messageId || '').localeCompare(String(b.messageId || '')));

  for (const r of ordered) {
    const ts = Number(r.ts) || 0;
    if (!ts) continue;                       // undated rows are counted by the reader,
                                             // never written with an invented time
    const tzo = Number.isFinite(Number(r.tzo)) ? Number(r.tzo) : tzOffsetAt(ts);
    const bk = tokenBreakdown(r);
    const sess = r.sessionId || meta.sessionId || '';
    const id = eventKey({
      requestId: r.requestId, messageId: r.messageId,
      harness, sess, served: idOf(r), ts, in: bk.inFresh, out: bk.outTok,
    });
    const ev = {
      v: SCHEMA_V,
      id,
      rev: 1,
      w: meta.writer || 'cli',
      inst,

      // ---- time: ONE reference frame, stamped at write ----
      ts,
      tzo,
      pday: pdayOf(ts, tzo),
      ingested_at: Date.now(),               // when we LEARNED it. Never bucketed on.

      // ---- provenance ----
      prov: meta.prov || 'transcript',
      usrc: r.estimated ? 'estimate' : 'body',
      conf: r.estimated ? 'estimated' : 'estimated',  // transcript rows are NEVER
                                                      // 'measured'; only a gateway body
                                                      // observation earns that word

      // ---- identity ----
      harness,
      sessions: sess ? [sess] : [],
      sess,
      sub: !!(r.sub || r.source === 'subagent'),

      // ---- the models, and the FROZEN counterfactual ----
      served: idOf(r),
      req: null,                              // requested model — GATEWAY ONLY
      base: ceilingModel,                     // FROZEN. Never derived at read time.
      bsrc,
      elig: !!isEligible(r),
      ctier: contentTier(r.text).tier,        // frozen classifier verdict
      cver: CLASSIFIER_VERSION,
      reason: '',

      // ---- tokens. NO DOLLAR FIGURE IS EVER STORED. ----
      in: bk.inFresh, out: bk.outTok, cr: bk.cacheRead,
      c5: bk.cacheCreate5m, c1: bk.cacheCreate1h, cu: bk.cacheCreate,
      speed: r.speed || null,
      svc: r.serviceTier || 'standard',
      // A transcript only ever records calls that RETURNED, so 200 is a statement of
      // fact about what the file contains, not an assumption about the network.
      status: 200,

      // ---- verifiability, WITHOUT a filesystem path ----
      sfile: r.sfile || null,
      sbase: r.sbase || null,
      fsha: r.fsha || null,
      vok: true,
    };
    out.push(ev);
  }
  return out;
}

// Belt-and-braces guard the writer runs before anything reaches disk. A path or a
// prompt fragment in an append-only audit log cannot be taken back.
function assertPrivacySafe(events, home) {
  const h = home || process.env.HOME || '';
  for (const e of events || []) {
    for (const k of Object.keys(e)) {
      if (FORBIDDEN_KEYS.includes(k)) {
        return `event carries a forbidden field: ${k}`;
      }
      const v = e[k];
      if (typeof v !== 'string') continue;
      // `sbase` is a bare uuid basename and is allowed; anything that looks like a
      // path, or contains the home directory, is not.
      if (k === 'sbase') continue;
      if (v.startsWith('/') || v.startsWith('~') || /^[A-Za-z]:\\/.test(v)) {
        return `event field ${k} looks like a filesystem path`;
      }
      if (h && h.length > 3 && v.includes(h)) {
        return `event field ${k} contains the home directory`;
      }
    }
  }
  return null;
}

module.exports = { eventsFromRecords, assertPrivacySafe, CLASSIFIER_VERSION,
                   FORBIDDEN_KEYS };
