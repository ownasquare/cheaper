'use strict';
// The session-scoped frame every realized-savings figure is computed against.
//
// ONE implementation, used by BOTH the end-of-chat tagline and the event writer. They
// must not drift: the tagline prints a number and the store persists the inputs to that
// same number, and an append-only log never forgets a wrong one.
//
// CEILING RULE (deliberate — change this comment if you change the rule): the baseline
// is the priciest model the session's TOP-LEVEL turns ran on, ranked on a FIXED basket
// at the session's own date. Price, not capability: a name-derived tier ranked
// claude-fable-5 ($60 per 1M in + 1M out) BELOW claude-opus-5 ($30), and 38 such
// inversions exist in the catalog. Capability rank simply is not price rank, and only
// price can answer "did this call cost less than the alternative".

const { isPriceable, costOfModel } = require('./pricing');
const { resolveModel } = require('./models');
const { pdayOf } = require('./periods');
const { cacheStateIndeterminate } = require('./derive');

// The basket used to RANK models against each other when picking the baseline.
//
// Fixed on purpose. Ranking on the session's own aggregate token mix would make the
// baseline depend on the very calls being credited, so adding one cache-heavy sub-agent
// could retroactively change a different sub-agent's credit.
const CEILING_BASKET = { inFresh: 1e6, cacheCreate5m: 0, cacheCreate1h: 0,
                         cacheCreate: 0, cacheRead: 0, outTok: 1e6 };

// Per-call token breakdown for cache-aware pricing. Claude Code records carry the full
// split (inFresh / cacheCreate5m / cacheCreate1h / cacheRead); other harnesses only have
// a combined inTokens, which we treat as fresh input so pricing is unchanged for them.
function tokenBreakdown(r) {
  return {
    inFresh: r.inFresh != null ? r.inFresh : (r.inTokens || 0),
    cacheCreate5m: r.cacheCreate5m || 0,
    cacheCreate1h: r.cacheCreate1h || 0,
    cacheCreate: r.cacheCreate || 0,
    cacheRead: r.cacheRead || 0,
    outTok: r.outTokens || 0,
  };
}

// The TRANSCRIPT-side reading of the rule `derive.js` applies to stored rows: is this
// call's counterfactual PROMPT-CACHE STATE recoverable from the record at all?
//
// ONE implementation, two field vocabularies. A transcript record carries
// `cacheRead` / `cacheCreate5m` / `cacheCreate1h` / `cacheCreate` and a raw `model`; a
// stored row carries `cr` / `c5` / `c1` / `cu` and canonical `served` / `base`. The
// predicate itself lives in derive.js — see the long note there for why a cold-start
// call on a SWITCHED model has no derivable baseline, and why a call that did not switch
// is provably unaffected.
//
// ADOPTED. `cli/src/peek/tagline.js::realizedFromRecords` used to price its counterfactual
// with the SERVED arm's split for every record — one `bk = tokenBreakdown(r)` passed to
// BOTH `costOfModel` calls — and so overstated the end-of-chat line, and the lifetime
// ledger it writes, exactly the way the stored path did before this rule existed. It now
// calls this export per eligible row and SKIPS the row when it returns true. Skips, not
// zeros: a zeroed row claims the saving was nothing, a skipped row claims it is
// unknowable. The row is still counted, and `tagline.js::populationNote` renders that
// count so the exclusion reaches the reader instead of arriving as a shrunken total.
//
// Keep the three readers in step. If this predicate changes, `derive.js` (the rule),
// `gateway/app/metrics.py::_cache_state_indeterminate` (the parity twin) and the tagline's
// adoption above all move together, or the printed line and the append-only log will
// publish different money for the same chat.
function recordCacheStateIndeterminate(r, servedId, baselineId) {
  const t = tokenBreakdown(r);
  return cacheStateIndeterminate(servedId, baselineId, t.cacheRead,
                                 t.cacheCreate5m + t.cacheCreate1h + t.cacheCreate);
}

// Billing modifiers that change a call's rate without changing its token counts.
// `at` is `pday` — the ONE time frame (see periods.js), so priceability, the price
// itself and the calendar bucket all resolve on the same day.
function billingCtx(r) {
  const day = r.ts ? pdayOf(r.ts, r.tzo) : null;
  return { speed: r.speed || null, serviceTier: r.serviceTier || null, at: day || undefined };
}

// The session's date — the latest call in it. Used so a historical session is ranked
// and priced at the rates in force then, rather than moving when a promo window shuts.
function sessionDate(priced) {
  let d = null;
  for (const r of priced) {
    const c = billingCtx(r).at;
    if (c && (!d || c > d)) d = c;
  }
  return d || undefined;
}

// The priciest model among `records`, by catalog dollars on the fixed basket.
// Iterating in canonical-id order makes ties resolve deterministically: the same
// session used to report $24.00 or $84.00 purely from JSONL append order.
function priciest(records, idOf, at) {
  let best = -1; let winner = null;
  const sorted = records.slice().sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
  for (const r of sorted) {
    const c = costOfModel(idOf(r), CEILING_BASKET, { at });
    if (c != null && c > best) { best = c; winner = idOf(r); }
  }
  return winner;
}

// Resolve every session-scoped input ONCE. Returns null when there is no honest claim
// to be made, rather than a zero — "we could not compute this" and "this was zero" are
// different statements and only one of them is a measurement.
function sessionFrame(records) {
  const priced = (records || []).filter((r) => isPriceable(r.model, billingCtx(r)));
  if (!priced.length) return null;
  const idOf = (r) => resolveModel(r.model).id;   // canonical catalog id
  const at = sessionDate(priced);

  const pool = priced.filter((r) => r.source !== 'subagent');
  // No priceable TOP-LEVEL turn means there is no baseline, and therefore no claim.
  // The old `pool.length ? pool : priced` fallback let a sub-agent become its own
  // baseline, so an uncatalogued main loop plus two flavours of Haiku manufactured a
  // saving out of nothing.
  if (!pool.length) return null;
  const ceilingModel = priciest(pool, idOf, at);
  if (!ceilingModel) return null;
  const topModel = priciest(priced, idOf, at);    // a sub-agent may sit above the ceiling

  // ELIGIBLE = work Cheaper plausibly ROUTED, never the user's own model choice.
  // Only claude-code tags sidechains; codex hardcodes source:'user' and the generic
  // harnesses test their SUBAGENT_HINT against a role string that is always
  // 'assistant', so it never fires. Gating on source alone would zero out 7 of 8
  // harnesses — so trust sub-agent attribution when this session carries any, and
  // otherwise fall back to "every call not on the baseline model".
  const routedAware = priced.some((r) => r.source === 'subagent');
  const isEligible = (r) => (routedAware
    ? r.source === 'subagent'
    : idOf(r) !== ceilingModel);

  return { priced, idOf, at, ceilingModel, topModel, routedAware, isEligible,
           bsrc: 'tx_session_ceiling' };
}

module.exports = { CEILING_BASKET, tokenBreakdown, billingCtx, sessionDate, priciest,
                   sessionFrame, recordCacheStateIndeterminate };
