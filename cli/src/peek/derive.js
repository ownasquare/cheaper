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
  // The counterfactual arm's PROMPT-CACHE STATE is not recoverable from the record.
  // See cacheStateIndeterminate below — this is a withholding, not a zero.
  CACHE_INDETERMINATE: 'cache_state_indeterminate',
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

// Every cache WRITE on the row, whatever its TTL. `cu` is an unknown-TTL write; all
// three bill at a write rate, and it is the write/read distinction — not the TTL — that
// the counterfactual turns on.
function cacheCreated(r) {
  return (r.c5 || 0) + (r.c1 || 0) + (r.cu || 0);
}

// ---- the counterfactual arm's PROMPT-CACHE STATE ------------------------------------
//
// A prompt cache is keyed on (model, exact prefix), so CHANGING MODEL INVALIDATES IT.
// The served model starts cold and pays a cache CREATE for a prefix the un-switched
// baseline model would still have held and merely READ.
//
// Both arms below are priced off ONE token split — the SERVED arm's — so the baseline
// leg is charged CREATE for those tokens too. Every entry in the catalog prices a write
// at or above a read (75/75 verified; Anthropic writes at 1.25x input against 0.1x to
// read, a 12.5x spread — a 200k-token prefix is $0.10 to read and $1.25 to rewrite on
// claude-opus-5). The substitution can therefore only ever move the baseline UP, and the
// claimed saving with it. The error is ONE-DIRECTIONAL: it never understates.
//
// It is NOT always present, and re-pricing every switched row would be the mirror-image
// fabrication. Two shapes have to be told apart:
//
//   * SERVED ARM WARM (cr > 0). Its prefix was already resident, so the CREATE on this
//     call is NEW content appended since the previous turn — content the baseline model
//     would have had to create too. Both arms pay CREATE, the served split IS the
//     counterfactual split, and the existing pricing is exactly right. In a 22,481-row
//     snapshot of the author's store (2026-08-07), 3,301 of the 3,380 switched
//     cache-bearing rows were this shape, carrying $156.03 of correctly-priced credit.
//     They are left alone.
//
//   * SERVED ARM COLD (cr == 0) WITH A CREATE. The prefix was written from scratch, and
//     two different histories produce that byte-identical row:
//       (a) the prefix is new to this session, so the baseline model was cold as well and
//           would also have paid CREATE          -> the current figure is right;
//       (b) the prefix was resident on the baseline model and the SWITCH is what forced
//           the rewrite                          -> the current figure is overstated by
//                                                   the whole (write - read) spread.
//     Nothing in the event schema separates them. There is no prefix hash, no cache
//     lineage, no per-block provenance — providers report ONE scalar create count per
//     call — so (b) cannot be corrected and (a) cannot be detected.
//
// The honest counterfactual for a cold-start switched row is therefore an INTERVAL, and
// in that same snapshot ALL 79 such rows had an interval that STRADDLES ZERO: $14.13 was
// published as a confident saving on rows whose SIGN the evidence cannot settle (the
// true value lies in [-$7.23, +$14.13]). Re-measured on the live store the same day, the
// rule withdrew $14.92 across 83 rows — 3.50% of a $426.15 headline — while leaving
// 0.0855% of tokens unpriced, well under the 20% blanket-suppression threshold.
//
// INVARIANT 4. The row makes no claim and says so. Publishing the cold end keeps a number
// known to be biased upward; publishing the warm end asserts a cache history that is
// exactly as unevidenced, biased downward. A LABELLED WITHHOLDING is the only one of the
// three that is true, and `foldRows` already counts it, so the exclusion is visible
// instead of arriving as a shrunken total.
//
// A SESSION THAT NEVER SWITCHES IS UNTOUCHED TO THE CENT. `served === base` means both
// arms are the same model on the same split, so baseline === spent and delta === 0 under
// every cache assumption; requiring a switch means such a row can never enter this
// branch. 14,902 of the author's 18,285 eligible rows are in that state and none moved.
//
// Ids are compared exactly as `gateway/app/metrics.py` compares them for `changed`. Two
// ALIASES of one model would read as a switch here and withhold a row whose delta is
// zero anyway — conservative, bounded, and not observed on any real or fixture row.
//
// MUST stay behaviourally identical to `gateway/app/metrics.py::_cache_state_indeterminate`.
// `gateway/app/store.py::derive_row` is the third reader of this same log and does NOT
// yet carry the rule; see the note on the regression test in `cli/test/store.test.js`.
function cacheStateIndeterminate(served, base, cacheRead, cacheCreate) {
  if (!served || !base) return false;                 // no counterfactual to bias
  if (String(served) === String(base)) return false;  // NO SWITCH -> nothing invalidated
  if (!(cacheCreate > 0)) return false;               // nothing was written
  return !(cacheRead > 0);                            // ...and the served arm was COLD
}

// ---- the representable calendar day, as ONE rule -----------------------------------
//
// `pday` is the row's frozen local calendar day. It is what this function prices at, and
// it is also what the reporting layer places an instant-less row on the time axis by
// (`store.js::placement`, `reporting.py::_placement`). Those two readings have to agree
// about which strings name a day, or a row is priced by one and undatable to the other.
//
// They did not. This function only tested that `pday` was TRUTHY, so a hand-edited,
// corrupted or third-party-written segment carrying `pday: "2026-13-45"` — or a numeric
// 20260410 that stringifies to eight characters — was PRICED, while the placement rule
// could put it on no day at all. Its dollars then appeared in the lifetime fold and in no
// window, no group, no bucket and no exclusion counter: a priceable row vanishing with
// nothing counted. Refusing to date it here collapses that state into the ordinary
// `undated` one, where every surface counts it and shows it.
//
// MUST stay behaviourally identical to `gateway/app/store.py::iso_day_ms`;
// `cli/scripts/check-period-parity.js` executes both over the malformed fixtures.
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// UTC midnight of the calendar day `pday` names, in epoch-ms — or null if it names none.
function isoDayMs(pday) {
  const s = typeof pday === 'string' ? pday : (pday ? String(pday) : '');
  if (!ISO_DAY_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  // Python's datetime covers exactly years 1..9999, and the 4-digit regex above caps the
  // top. Year 0000 is refused on both sides.
  if (y < 1) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC maps a TWO-DIGIT year onto 1900+y, so '0001-01-01' would silently become
  // 1901 — a day Python accepts and this runtime would then have refused, which is the
  // drift this function exists to close. The parity gate caught exactly that.
  if (y <= 99) dt.setUTCFullYear(y);
  const ms = dt.getTime();
  if (!Number.isFinite(ms)) return null;
  // Date.UTC also ROLLS OVER — Date.UTC(2026, 12, 45) is a perfectly good instant in
  // 2027. Only a day that renders back to itself names a day; anything else is refused,
  // exactly as Python's datetime() raises for it.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== mo
      || dt.getUTCDate() !== d) return null;
  return ms;
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

  // NOT `!r.pday`. A truthy `pday` that names no representable calendar day is refused
  // here rather than priced — see isoDayMs above.
  if (!r || isoDayMs(r.pday) === null) { out.reason = REASONS.NO_TS; return out; }
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
  // A cold-start call on a SWITCHED model has no recoverable counterfactual cache state,
  // so it has no honest baseline — see cacheStateIndeterminate above. Withheld here,
  // beside the other "one leg of the subtraction cannot be formed" cases, so the row
  // contributes to no accumulator and `spent` still covers exactly the priceable rows.
  if (cacheStateIndeterminate(r.served, r.base, r.cr || 0, cacheCreated(r))) {
    out.reason = REASONS.CACHE_INDETERMINATE; return out;
  }
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

module.exports = { deriveRow, foldRows, tokensOf, totalTokens, isoDayMs,
                   cacheCreated, cacheStateIndeterminate, REASONS };
