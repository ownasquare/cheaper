'use strict';
// Read-time derivation: one stored event -> its dollars.
//
// A PURE function of the row. Every session-scoped input was frozen at write time
// (base / bsrc / elig / ctier / pday), so this cannot depend on the query window — which
// is the property that makes
//     report(Jan) + report(Feb) === report(Jan ∪ Feb)
// true to the cent, and stops "savings today" from changing when you also ask for the
// month.
//
// FAIL CLOSED. Every branch that cannot produce an honest figure returns a labelled
// UNPRICEABLE, never 0. `$0.00` is a measured result; "no claim made" is not, and
// rendering the second as the first is the exact concealment this product exists to end.

const { isPriceable, costOfModel } = require('./pricing');

const REASONS = {
  NON_2XX: 'non_2xx',
  NO_TS: 'undated',
  SERVED_UNPRICEABLE: 'served_not_in_catalog',
  BASE_UNPRICEABLE: 'baseline_not_in_catalog',
  NO_BASE: 'no_baseline',
  COST_NULL: 'cost_unavailable',
};

function tokensOf(r) {
  return {
    inFresh: r.in || 0,
    cacheCreate5m: r.c5 || 0,
    cacheCreate1h: r.c1 || 0,
    cacheCreate: r.cu || 0,
    cacheRead: r.cr || 0,
    outTok: r.out || 0,
  };
}

function totalTokens(r) {
  return (r.in || 0) + (r.out || 0) + (r.cr || 0) + (r.c5 || 0) + (r.c1 || 0) + (r.cu || 0);
}

// { priceable, reason, spent, baseline, delta, tokens }
//
// `delta` is SIGNED: a routed call that cost MORE subtracts. No max(0, …) anywhere —
// the same `> 0` guard concealed the honest number in three separate prior incidents,
// and the fix each time was to preserve the sign in the math and suppress at RENDER.
function deriveRow(r) {
  const tokens = totalTokens(r);
  const out = { priceable: false, reason: '', spent: null, baseline: null,
                delta: null, tokens, pday: r && r.pday };

  if (!r || !r.pday) { out.reason = REASONS.NO_TS; return out; }
  const status = Number(r.status);
  // Retries and errors are recorded but never priced. Claude Code retries 429s and
  // overloaded_error automatically and each retry gets a DISTINCT provider request id,
  // so the idempotency key cannot collapse them: a six-retry storm on one turn would
  // book six times the saving for one delivered answer.
  if (Number.isFinite(status) && status !== 0 && !(status >= 200 && status < 300)) {
    out.reason = REASONS.NON_2XX; return out;
  }

  // Priceability is resolved at the ROW'S OWN DAY, exactly like the price. Resolving it
  // at "today" put the two in different time frames, so a provider shipping a new model
  // — or a user not refreshing the catalog — could flip an already-read period from
  // "$16.15 saved" to blank with no code change and no data change.
  const ctx = { at: r.pday, speed: r.speed || null, serviceTier: r.svc || null };
  if (!isPriceable(r.served, ctx)) { out.reason = REASONS.SERVED_UNPRICEABLE; return out; }

  const bk = tokensOf(r);
  const spent = costOfModel(r.served, bk, ctx);
  if (spent == null) { out.reason = REASONS.COST_NULL; return out; }
  out.spent = spent;

  if (!r.base) { out.reason = REASONS.NO_BASE; out.priceable = true; out.delta = 0; return out; }
  if (!isPriceable(r.base, ctx)) { out.reason = REASONS.BASE_UNPRICEABLE; return out; }
  // SAME call, SAME date, SAME SKU — the only variable is the model, because the model
  // is the only thing Cheaper controls, and therefore the only thing it may claim
  // credit for.
  const baseline = costOfModel(r.base, bk, ctx);
  if (baseline == null) { out.reason = REASONS.COST_NULL; return out; }

  out.priceable = true;
  out.baseline = baseline;
  out.delta = r.elig ? (baseline - spent) : 0;
  return out;
}

// Aggregate a set of rows, keeping the two BASES strictly apart.
//
// THE ABSOLUTE INVARIANT: never add a figure from two sources.
// `metrics.summary().dollars.saved` + `ledger.totals().usd` + `peek.totals.dollarsSaved`
// is a triple count by construction, in any combination. So `measured` and `estimated`
// accumulate SEPARATELY here and are never summed into one number by this module. A
// renderer that wants one figure must pick a basis and say which.
//
// The same rule covers GRAIN: a chat count and a call count are never added, even
// within one basis. Legacy chat-grain rows do not enter this function at all.
function foldRows(rows) {
  const mk = () => ({ saved: 0, spent: 0, baseline: 0, tokens: 0, calls: 0,
                      credited: 0, offset: 0, gross: 0, extra: 0 });
  const acc = { measured: mk(), estimated: mk() };
  const seen = { measured: 0, estimated: 0 };
  const unpriced = {};
  let unpricedTokens = 0;
  let totalTokensSeen = 0;

  for (const r of rows || []) {
    const d = deriveRow(r);
    const basis = r.conf === 'measured' ? 'measured' : 'estimated';
    seen[basis] += 1;
    totalTokensSeen += d.tokens;
    if (!d.priceable) {
      unpriced[d.reason] = (unpriced[d.reason] || 0) + 1;
      unpricedTokens += d.tokens;
      continue;
    }
    const a = acc[basis];
    a.calls += 1;
    a.tokens += d.tokens;
    a.spent += d.spent || 0;
    a.baseline += d.baseline || 0;
    const delta = d.delta || 0;
    a.saved += delta;
    if (delta > 0) { a.gross += delta; a.credited += 1; }
    else if (delta < 0) { a.extra += -delta; a.offset += 1; }
  }
  return {
    measured: acc.measured,
    estimated: acc.estimated,
    // Every row seen, split by basis, INCLUDING the ones whose dollars could not be
    // derived. The accumulators above only count priceable rows, so reporting their
    // `calls` as "events" makes a window read "0 events" directly above a note saying
    // "1 of 1 call in this window is not in the price catalog". The money is withheld;
    // the count is not in doubt.
    events: { measured: seen.measured, estimated: seen.estimated },
    unpriced,
    unpricedCalls: Object.values(unpriced).reduce((s, n) => s + n, 0),
    unpricedTokens,
    // Report-nothing case #7: when more than a fifth of a window's tokens cannot be
    // priced, dollars are suppressed and only tokens are reported. A figure derived
    // from four fifths of the evidence, presented as if it were all of it, is the
    // shape every prior incident had.
    unpricedRatio: totalTokensSeen ? unpricedTokens / totalTokensSeen : 0,
    dollarsSuppressed: totalTokensSeen > 0 && (unpricedTokens / totalTokensSeen) > 0.20,
  };
}

module.exports = { deriveRow, foldRows, tokensOf, totalTokens, REASONS };
