'use strict';
// Real-dollar pricing for the `peek` savings estimate.
//
// Two different questions get asked here, and they are priced differently:
//
//   1. "What did this call actually cost?"  -> priced against the EXACT model that
//      ran, using its own published rates (models.js), including its own cache
//      read/write rates, long-context tier, speed SKU, and service tier. This is
//      what the user sees as session spend, so it must not be approximated.
//
//   2. "What would it have cost on the model Cheaper routed away from?" -> the
//      counterfactual, priced against the ceiling MODEL when we know it, and only
//      falling back to a representative model of that family+tier when we don't.
//
// Cheaper's ceiling rule means a call is only ever re-routed DOWN within the same
// family (Opus->Haiku, GPT-5->mini, Pro->Flash), never to a different vendor and
// never upward. Savings for one call are:
//     ceiling_model_cost(tokens) - actual_model_cost(tokens)
// Same token counts, a cheaper per-token rate — a conservative, apples-to-apples
// estimate.
//
// A model with no catalog entry is UNPRICEABLE and contributes zero, never a guessed
// rate. Inventing a price would invent a saving that did not happen. "Contributes
// zero" is only honest while the exclusion is COUNTED: a zero that is indistinguishable
// from a measured zero is how "we could not price this" becomes "this cost nothing".
// estimateCall therefore reports `priceable: false`, and scan.js counts those rows into
// `unpriced` / `unpricedTokens` rather than letting them vanish into a call count.
//
// DATES. Two different questions are also asked on two different DATES, and they must
// not be mixed inside one subtraction — see the long note on estimateCall:
//   - what a call HISTORICALLY cost  -> priced at that call's own day (`opts.at`)
//   - what adopting Cheaper WOULD save -> both legs priced at TODAY

const { TIERS, rank, modelTier, routeDecision, mapFamily } = require('./classify');
const { resolveModel, ratesFor, normalizeId, CATALOG_AS_OF } = require('./models');

// tier name (haiku|sonnet|opus) -> pricing bucket (cheap|mid|top)
const BUCKET = { haiku: 'cheap', sonnet: 'mid', opus: 'top' };

// The model each family+tier is priced as when the caller knows only a tier (the
// gateway's aggregate path). These are real, current models from the catalog — not
// invented averages — so a bucket price is always some model's actual price.
// The model Cheaper WOULD route each tier to, per family. Used only for the
// PROSPECTIVE counterfactual in estimateCall ("what would this have cost had Cheaper
// been running?") — never to price a call that actually happened, which is always
// priced at its own model id.
//
// Formerly `REPRESENTATIVE`, which read like "a typical model of this tier" and
// invited exactly the wrong use. This is a ROUTING TARGET: it answers a routing
// question, so it must name a model the router would really pick.
//
// Two families had `cheap === mid`, which made a cheap-tier downgrade structurally
// incapable of showing any saving — a silent DEFLATION in the surface that feeds the
// marketing pages. Both now name genuinely distinct, genuinely cheaper models.
const ROUTE_TARGET = {
  anthropic: { cheap: 'claude-haiku-4-5', mid: 'claude-sonnet-5', top: 'claude-opus-5' },
  openai:    { cheap: 'gpt-5-mini',       mid: 'gpt-5.4',         top: 'gpt-5.6-sol' },
  google:    { cheap: 'gemini-2.5-flash-lite', mid: 'gemini-3.5-flash', top: 'gemini-3.1-pro' },
  // was cheap:'grok-4.3' === mid — grok-build-0.1 ($3/M blended) is the real cheap SKU.
  xai:       { cheap: 'grok-build-0.1',   mid: 'grok-4.3',        top: 'grok-4.5' },
  // DeepSeek publishes only two SKUs, so cheap and mid legitimately coincide. Named
  // explicitly here so it reads as a deliberate fact about the vendor's lineup rather
  // than the copy-paste slip it resembles.
  deepseek:  { cheap: 'deepseek-v4-flash', mid: 'deepseek-v4-flash', top: 'deepseek-v4-pro' },
  mistral:   { cheap: 'ministral-3-8b',   mid: 'mistral-small-4', top: 'mistral-medium-3.5' },
};
// Back-compat alias; sync-prices.js and the gateway JSON still read this name.
const REPRESENTATIVE = ROUTE_TARGET;

// ---- WHICH OF THOSE ROUTES THE GATEWAY CAN ACTUALLY TAKE -------------------
//
// ROUTE_TARGET declares cheap/mid/top for SIX vendors, and estimateCall priced a
// downgrade for every one of them. The gateway exposes exactly TWO endpoints that rewrite
// `body["model"]` — i.e. that route anything at all:
//
//   POST /v1/messages          app.py:491  -> Anthropic  (UPSTREAM, CFG.models)
//   POST /v1/chat/completions  app.py:812  -> OpenAI     (OPENAI_UPSTREAM, OPENAI_MODELS)
//
// Everything else falls through to the catch-all proxy at app.py:1151, which forwards the
// request verbatim to UPSTREAM. That proxy is NOT "read-only reporting" — it relays real
// traffic, including POSTs — but it never reads or writes `body["model"]`, so no tier is
// chosen, no substitution happens, and no dollar moves. For estimation purposes a vendor
// with no rewriting endpoint is a vendor Cheaper cannot save money on TODAY.
//
// MEASURED 2026-08-08: 28 of the 75 catalog ids (37.3%) sit in a family that HAS a peek
// route target and NO gateway endpoint, and 4 of ROUTE_TARGET's 6 families (google, xai,
// deepseek, mistral) are unroutable in their entirety.
//
// THE FAMILIES ARE NOT DELETED. The counterfactual "what would Gemini Pro work cost on
// Gemini Flash" is a real and interesting number — it is simply not a saving the user can
// bank this week, so scan.js reports it in a SEPARATE bucket and keeps it out of the
// headline. Deleting the targets would answer a good question with silence; leaving them
// in the headline answers a different question than the one the headline asks.
//
// Overridable from the live gateway (`routableFamilies`, /healthz `routable_families`) so
// that adding a third front end does not require editing this constant — see
// freshness.js::routerConfigFrom.
const ROUTABLE_FAMILIES = Object.freeze(['anthropic', 'openai']);

// Is this vendor one the gateway can rewrite a model id for today?
// `families` defaults to the shipped pair; a live gateway may report its own.
function isRoutableFamily(family, families) {
  const list = Array.isArray(families) && families.length ? families : ROUTABLE_FAMILIES;
  return list.includes(String(family || '').toLowerCase());
}

// THE SAME TABLE, KEYED BY TIER NAME (haiku|sonnet|opus) INSTEAD OF BY PRICE BUCKET.
//
// ROUTE_TARGET above answers "which model does a downgrade land on". The GATEWAY asks
// that same question twice more, from two hardcoded tables of its own:
//   * RouterConfig.models          (gateway/app/router.py) for /v1/messages
//   * OPENAI_MODELS                (gateway/app/app.py)    for /v1/chat/completions
// Three tables, one question, no gate between them — so peek priced the counterfactual
// leg against models the gateway never serves. MEASURED on 2026-08-08, over every
// catalog model that has a tier below it (1M in / 1M out, priced at today):
//
//   37 of the family/tier downgrade pairs diverge in DOLLARS. 11 OVERSTATE the saving
//   and 26 UNDERSTATE it:
//     claude-opus-5 / -4-8 / -4-7 / -4-6 / -4-5  peek $18.00 vs gateway $12.00  (+50.0%)
//     claude-fable-5 / -mythos-5 / -mythos       peek $48.00 vs gateway $42.00  (+14.3%)
//     claude-opus-4-1 / -4 / claude-3-opus       peek $78.00 vs gateway $72.00  (+8.3%)
//     every OpenAI pair                          peek understates by 0.2%–22.2%
//
//   The Anthropic overstatement is NOT "a newer model costs less": both sonnet targets
//   list at $3/$15. It is the claude-sonnet-5 PROMOTIONAL WINDOW (models.js:86-89,
//   $2/$10 until 2026-08-31). peek routes to claude-sonnet-5 and gets the promo rate;
//   the gateway routes to claude-sonnet-4-5 and pays list. Same tier, same day, 50% more
//   saving claimed than delivered — and it expires silently on 2026-09-01, which is the
//   worst kind of divergence: one that heals itself before anyone can reproduce it.
//
//   The OpenAI understatement is the mirror image: peek targets the current lineup
//   (gpt-5-mini / gpt-5.4 / gpt-5.6-sol) while the gateway still defaults to the legacy
//   one (gpt-4o-mini / gpt-4o / o3). Worse than a dollar gap, the gateway's OpenAI TOP
//   tier is `o3`, which this catalog classifies as tier `sonnet` — so the OpenAI front
//   end answers auto-escalated security/concurrency requests on a MID-capability model
//   while reporting them as top tier.
//
// ONE SOURCE OF TRUTH. ROUTE_TARGET is it. sync-prices.js projects this tier-keyed view
// into cli/assets/gateway/app/model_prices.json under the top-level key `route_targets`,
// so the gateway can read its tier defaults from the generated table instead of keeping
// a third and fourth hand-maintained copy. Tier-keyed rather than bucket-keyed because
// the gateway speaks tiers (haiku/sonnet/opus) everywhere — RouterConfig.models,
// OPENAI_MODELS, Decision.tier — and translating bucket names at the boundary is one
// more place for the two to drift.
const ROUTE_TARGET_BY_TIER = {};
for (const famName of Object.keys(ROUTE_TARGET)) {
  const buckets = ROUTE_TARGET[famName];
  ROUTE_TARGET_BY_TIER[famName] = {
    haiku: buckets[BUCKET.haiku],
    sonnet: buckets[BUCKET.sonnet],
    opus: buckets[BUCKET.opus],
  };
}

// Vendor identification. This answers "whose model is this?" and is used for grouping
// and for the same-family ceiling rule — it does NOT imply we can price the model.
// Open-weight families (Meta/Llama, Qwen) are recognized as vendors but have no list
// price: the same weights cost 3-12x more on one host than another, so they resolve
// to a family here and to null in the catalog, and therefore price as unknown.
function detectFamily(modelId) {
  const m = normalizeId(modelId);
  if (!m) return null;
  if (/(claude|haiku|sonnet|opus|fable|mythos|anthropic)/.test(m)) return 'anthropic';
  if (/(gpt|davinci|babbage|chatgpt|\bo1\b|-o1|\bo3\b|-o3|\bo4\b|-o4|openai)/.test(m)) return 'openai';
  if (/(gemini|palm|bison|gemma)/.test(m)) return 'google';
  if (/grok/.test(m)) return 'xai';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/qwen|qwq/.test(m)) return 'qwen';
  if (/(llama|meta-llama)/.test(m)) return 'meta';
  if (/(mistral|mixtral|codestral|ministral|magistral|devstral)/.test(m)) return 'mistral';
  return null; // unrecognized -> unpriceable
}

// Are these two ids the SAME MODEL — i.e. would pricing them separately be pricing one
// model twice? This is what decides whether the router really substituted anything, and
// it cannot be `===`: one side is a route-target id (from ROUTE_TARGET, or from an
// operator's /healthz map) and the other is whatever the provider wrote into a transcript
// — the same model spelled with a vendor prefix, a dated snapshot, or a catalogued alias.
// Reading `us.anthropic.claude-opus-5-20260101` and `claude-opus-5` as two models would
// book a dollar difference between a model and itself.
//
// Catalog entry first, because that is the equivalence PRICE is computed from and it
// covers aliases the id text cannot. Both-unresolvable falls back to the normalised id,
// which is all an uncatalogued operator target leaves to compare. One resolvable and one
// not is never the same model: a catalogued id and an uncatalogued one price differently
// by construction.
function sameModel(a, b) {
  const ea = resolveModel(a);
  const eb = resolveModel(b);
  if (ea && eb) return ea.id === eb.id;
  if (ea || eb) return false;
  return normalizeId(a) === normalizeId(b);
}

// True when we hold published rates for this exact model. Callers use this to skip a
// record entirely rather than price it at some neighbour's rate.
//
// `opts.at` MUST be the row's own day, exactly like costOfModel. They used to run in
// different time frames — priceability resolved at TODAY while the price resolved at
// the row's date — so a provider shipping a new model, or a user not refreshing the
// catalog for six weeks, could flip an already-read historical period from "$16.15
// saved" to blank with no code change and no data change. Same question, same date.
function isPriceable(modelId, opts) {
  return resolveModel(modelId, opts) != null;
}

// The catalog entry a family+tier bucket prices as, or null if that family has no
// published-price representative (open-weight families).
function representativeFor(family, tierName) {
  const fam = REPRESENTATIVE[family];
  if (!fam) return null;
  return fam[BUCKET[tierName] || 'mid'] || fam.mid;
}

// Per-token rates for a call. `ref` is a model id; when it names an unknown model but
// a family+tier is supplied, fall back to that bucket's representative model.
function rate(ref, tierName) {
  let entry = resolveModel(ref);
  if (!entry) {
    const rep = representativeFor(ref, tierName) || representativeFor(detectFamily(ref), tierName);
    if (rep) entry = resolveModel(rep);
  }
  return entry ? ratesFor(entry, {}) : null;
}

// ---- token breakdown -------------------------------------------------------
// A call's tokens, split the way providers actually bill them. Anything missing is
// zero; a record carrying only { inTokens, outTokens } prices as all-fresh input.
//   inFresh       uncached input
//   cacheCreate5m 5-minute-TTL cache writes  (Anthropic: 1.25x input)
//   cacheCreate1h 1-hour-TTL cache writes    (Anthropic: 2x input)
//   cacheCreate   writes of unknown TTL — treated as 5m, the cheaper of the two, so
//                 an unknown never inflates the bill
//   cacheRead     prompt-cache hits
//   outTok        output, INCLUDING reasoning/thinking tokens (every provider bills
//                 reasoning at the output rate and already counts it in output_tokens)
function normalizeTokens(toks) {
  const t = toks || {};
  return {
    inFresh: t.inFresh || 0,
    cacheCreate5m: t.cacheCreate5m || 0,
    cacheCreate1h: t.cacheCreate1h || 0,
    cacheCreate: t.cacheCreate || 0,
    cacheRead: t.cacheRead || 0,
    outTok: t.outTok || 0,
  };
}

// Total input tokens for a call — what a long-context tier is judged on.
function inputTotal(t) {
  return t.inFresh + t.cacheCreate5m + t.cacheCreate1h + t.cacheCreate + t.cacheRead;
}

function applyRates(r, t) {
  if (!r) return 0;
  return (t.inFresh / 1e6) * r.in
       + (t.cacheCreate5m / 1e6) * r.cacheWrite
       + (t.cacheCreate / 1e6) * r.cacheWrite
       + (t.cacheCreate1h / 1e6) * r.cacheWrite1h
       + (t.cacheRead / 1e6) * r.cacheRead
       + (t.outTok / 1e6) * r.out;
}

// ---- the two pricing entry points -----------------------------------------

// EXACT cost of one call on a specific model. Returns null when the model has no
// published price, so callers can skip it instead of pricing it wrongly.
//   ctx: { speed, serviceTier, at }
function costOfModel(modelId, toks, ctx) {
  const entry = resolveModel(modelId, ctx);
  if (!entry) return null;
  const t = normalizeTokens(toks);
  const r = ratesFor(entry, Object.assign({ inputTokens: inputTotal(t) }, ctx || {}));
  return applyRates(r, t);
}

// Bucket cost: what a family+tier costs, priced as that bucket's representative
// model. Used only where a concrete model id is unavailable.
function costOfDetailed(family, tierName, toks, ctx) {
  const rep = representativeFor(family, tierName);
  if (!rep) return 0;
  const t = normalizeTokens(toks);
  const entry = resolveModel(rep, ctx);
  const r = ratesFor(entry, Object.assign({ inputTokens: inputTotal(t) }, ctx || {}));
  return applyRates(r, t);
}

// Plain fresh-input + output cost, no cache split.
function costOf(family, tierName, inTok, outTok) {
  return costOfDetailed(family, tierName, { inFresh: inTok, outTok });
}

// The tier -> model-id map a row's counterfactual is priced against.
//
// The live map is used ONLY for the family it actually serves. /healthz `models` is
// CFG.models, the /v1/messages (Anthropic) map; a future `openai_models` would be the
// /v1/chat/completions one. Applying an Anthropic map to a Gemini row would price that
// row's counterfactual as Claude — the cross-vendor substitution this whole file exists
// to refuse — so a live map is accepted only when mapFamily() says it serves this row's
// own family, and otherwise the shipped ROUTE_TARGET for that family is used.
function routeTargetsFor(family, router) {
  const shipped = ROUTE_TARGET_BY_TIER[family] || null;
  if (!router) return shipped;
  for (const live of [router.models, router.openaiModels]) {
    if (live && mapFamily(live) === family) return live;
  }
  return shipped;
}

// Core per-call estimate for the PROSPECTIVE report ("what you would save if you
// adopted Cheaper"). contentTierName is the tier the classifier picked from the
// prompt text. Prices the actual leg against the real model and the counterfactual
// against the same family's cheaper tier.
//
// TWO QUESTIONS, TWO DATES — and each subtraction stays inside ONE of them:
//
//   `opts.at` is the row's OWN local calendar day (pday). It prices `actualCost`:
//   the HISTORICAL fact of what that call really cost, at the rates in force the day
//   it happened. This is the figure `peek` reports as "Spent on record", and it must
//   not move when a promotional window opens or shuts — a session recorded inside
//   Sonnet 5's $2/$10 launch window kept that rate, and restating it at today's
//   $3/$15 would rewrite a number the user has already read and acted on. Callers
//   that omit `at` get today, exactly as before.
//
//   `saved` is the PROSPECTIVE counterfactual — "adopt Cheaper and this shape of work
//   costs you less" — so BOTH of its legs price at TODAY (models.js:242-258: forward-
//   looking work prices at today; only retrospective work prices at the call's date).
//   `baselineCost` is therefore the requested model at TODAY, deliberately separate
//   from `actualCost`: subtracting a today-priced counterfactual from a day-priced
//   historical cost would be the exact frame substitution the `at` parameter exists to
//   prevent. With no `at` the two are identical, which is why this split is invisible
//   to every caller that does not date its rows.
//
// SIGNED, NOT CLAMPED. `saved` used to be `Math.max(0, actualCost - newCost)`. The
// clamp is REACHABLE — not by the "a cheap model named opus" route (modelTier consults
// the catalog first, so a name regex only ever classifies an UNCATALOGUED model, which
// is unpriceable and returns early), but through the rate SHAPE. A tier's route target
// is not cheaper than every model of the tier above it on every token mix: the sonnet
// target `gemini-3.5-flash` bills input at $1.50/Mtok while the opus-tier
// `gemini-2.5-pro` bills it at $1.25, so an input-heavy call (100k in / 10k out) costs
// $0.225 on the pro and $0.240 on the "cheaper" flash. Clamping that to 0 is a
// suppression performed in the ARITHMETIC, which is the one place it must never happen
// — it makes a route that would have cost the user more read as a neutral $0.00 and
// removes it from every total. The signed delta is returned and split into `gross` /
// `extra` here (the shape derive.js::foldRows uses) so the caller can report the
// anti-saving instead of losing it.
//
// THE ROUTER IT PRICES IS THE ROUTER YOU ARE RUNNING — when we can find out.
//
// `opts.router` is a resolved configuration from freshness.js::routerConfig(), which
// reads the live /healthz. Omitted, every knob falls back to the shipped default — which
// is exactly what this function did unconditionally before, so an omitted config is not a
// behaviour change, it is the old behaviour with a name. What changed is that the caller
// can now KNOW it is assuming: `router.assumed` lists every guessed knob and
// `router.labelled` says whether a qualifier is owed next to the dollars.
function estimateCall(actualModel, inTok, outTok, contentTierName, opts) {
  // null/'' from a row with no derivable calendar day falls back to today, matching
  // resolveModel's own default — an undatable row is not a reason to invent a date.
  const at = (opts && opts.at) || undefined;
  const router = (opts && opts.router) || null;
  const family = detectFamily(actualModel);
  const actualTier = modelTier(actualModel); // haiku|sonnet|opus, or null
  const priceable = isPriceable(actualModel, { at });
  if (!family || !actualTier || !priceable) {
    return { family: family || 'other', actualTier: null, effTier: null,
             routedTier: null, routedModel: null, passthrough: true,
             // An unpriceable row is not "unroutable" — those are different exclusions
             // with different remedies (catalog a price vs. ship an endpoint), and
             // scan.js counts them in different buckets. `routable` here answers only
             // "could the gateway rewrite this vendor's model id", which is knowable from
             // the family alone and stays knowable when the price is not.
             routable: isRoutableFamily(family, router && router.routableFamilies),
             actualCost: 0, baselineCost: 0, newCost: 0,
             saved: 0, gross: 0, extra: 0,
             // Shape parity with the priced return below, so a consumer never has to
             // test for the presence of a field before reading it. No route is modelled
             // for a row we cannot price, so nothing was substituted and no routed-leg
             // figure is missing.
             substituted: false, routedPriceable: true,
             downgraded: false, priceable: false };
  }
  const effRank = Math.min(rank(actualTier), rank(contentTierName));
  const effTier = TIERS[effRank];
  const toks = { inFresh: inTok, outTok };
  // HISTORICAL leg — the row's own day.
  const actualCost = costOfModel(actualModel, toks, { at }) || 0;
  // PROSPECTIVE legs — both at TODAY.
  const baselineCost = costOfModel(actualModel, toks) || 0;

  // THE ROUTE IS ASKED FOR, NOT ASSUMED.
  //
  // This used to be `costOfDetailed(family, effTier)` — "the cheaper tier's target, in
  // this family" — which silently asserted that the gateway always takes the downgrade.
  // It does not. router.py applies a DOLLAR ceiling after the tier is chosen
  // (router.py:203-228): if the target model's unit cost exceeds the requested model's,
  // it walks DOWN the tiers, and if nothing configured is cheaper it PASSES THROUGH and
  // routes nothing at all. peek modelled none of that, so it could book a downgrade the
  // gateway refuses, and quote the resulting anti-saving as a real cost the user would
  // have paid for a route that would never have been taken.
  //
  // classify.routeDecision() is the port of that function, so this asks the ROUTER what
  // it would do rather than re-deriving it here — one router, two callers.
  // `triageTier: contentTierName` feeds the already-computed content verdict in through
  // the same hook app.py uses for a live triage pass, so the tier logic is not run twice
  // and cannot disagree with itself.
  //
  // NOTHING HERE IS A CLAMP. The signed delta and the gross/extra split below are
  // untouched, and the anti-saving they exist to expose is still reported wherever the
  // router really would take the route: the ceiling compares models on a FIXED
  // 1M-in/1M-out basket (router.py's _RANK_BASKET), so a target that is cheaper on that
  // basket still passes the ceiling and can still cost more on a particular call's own
  // token mix — the gemini-3.5-flash / gemini-2.5-pro input-heavy case in the note above
  // survives exactly as before. What changes is only the case where the router would not
  // have moved the call at all.
  //
  // A family with no route targets at all (an open-weight vendor recognised by
  // detectFamily but absent from ROUTE_TARGET) is a PASSTHROUGH, never a fallback to
  // some other vendor's map: routeDecision() defaults `models` to the Anthropic targets,
  // which would silently price a Llama call's counterfactual as Claude.
  //
  // THE FOUR REMAINING STAGES ARE NOW DRIVEN, NOT DEFAULTED. routeDecision() has always
  // accepted minTier / allowUpgradeAboveRequested / longRequestChars; peek passed none of
  // them, so a gateway running ROUTER_MIN_TIER=sonnet or ROUTER_ALLOW_UPGRADE=true was
  // estimated as if it were shipped-default. They come from the live /healthz when the
  // gateway is up and from the shipped defaults when it is not — and in the second case
  // `router.assumed` records that, so the number can be labelled.
  const targets = routeTargetsFor(family, router);
  // Only knobs with a REAL value are put on the cfg object. routeDecision merges with
  // Object.assign, and `{minTier: undefined}` overwrites the default with undefined
  // rather than falling through to it — harmless today because every consumer happens to
  // be null-tolerant, and exactly the kind of accident that stops being harmless the next
  // time someone adds a knob. So the absent case is expressed by absence.
  const routeCfg = { models: targets, triageTier: contentTierName };
  if (router) {
    if (router.minTier != null) routeCfg.minTier = router.minTier;
    if (router.allowUpgradeAboveRequested != null) {
      routeCfg.allowUpgradeAboveRequested = router.allowUpgradeAboveRequested;
    }
    if (Number.isFinite(Number(router.longRequestChars))) {
      routeCfg.longRequestChars = Number(router.longRequestChars);
    }
  }
  const decision = targets
    ? routeDecision(null, actualModel, routeCfg)
    : { tier: null, model: actualModel, reason: 'no route targets for family ' + family };
  const routedTier = decision.tier;            // null => PASSTHROUGH
  // The routed leg is priced as the model the gateway would really SERVE, in the SAME
  // family — never cross-vendor.
  //
  // THE TEST IS "IS IT A DIFFERENT MODEL", NOT "IS IT A DIFFERENT TIER". This line used
  // to read `routedTier == null || routedTier === actualTier`, which assumed a same-tier
  // route costs the same as no route. It does not. The gateway rewrites `body["model"]`
  // to `models[tier]` whenever it routes — unconditionally, at app.py:516 for
  // /v1/messages and app.py:835 for /v1/chat/completions — so a same-TIER route is still
  // a MODEL SUBSTITUTION at a different price, and the old line booked $0.00 for it.
  //
  // MEASURED 2026-08-08 over the 75-model catalog with the shipped ROUTE_TARGET map: 63
  // same-tier substitutions priced as exactly $0.00. At a 1M-in/1M-out basket all 63
  // UNDERSTATED the saving, by $1,851.20 in total (o1-pro -> gpt-5.6-sol alone is
  // $715.00; gpt-5.5-pro and gpt-5.4-pro -> gpt-5.6-sol are $175.00 each). At an
  // input-heavy 100k-in/10k-out basket 60 understated and 3 OVERSTATED — so it could
  // also HIDE a real anti-saving, a route that costs the user more reading as a neutral
  // $0.00, which is the suppression the signed-delta note above exists to forbid.
  //
  // It became load-bearing when `opts.router` arrived: peek now adopts the gateway's real
  // tier -> id map from /healthz, so same-tier-but-different-model is the COMMON case
  // rather than a rarity. With the gateway's shipped OpenAI map
  // {haiku: gpt-4o-mini, sonnet: gpt-4o, opus: o3}, a caller on `gpt-5.6-terra` with
  // sonnet-tier content is served `gpt-4o` — $0.35 against $0.32 on a 100k/10k call, an
  // anti-saving this line reported as $0.00.
  //
  // The guard is now the only case where no dollar can move: the router served the
  // caller's OWN model. `sameModel` and not `===` because `decision.model` comes from a
  // route map (an operator's, via /healthz) and `actualModel` from a transcript, so the
  // two spell the same model differently — a dated snapshot, a vendor prefix, an alias.
  const substituted = routedTier != null && !sameModel(decision.model, actualModel);

  // AN UNPRICEABLE TARGET IS NOT A FREE ONE. This used to be
  // `costOfModel(decision.model, toks) || 0`, and `|| 0` is the exact move this file's
  // header forbids: a model with no catalog entry priced at ZERO, which makes `saved`
  // the WHOLE baseline — a 100% saving invented out of a missing rate. Not hypothetical
  // and not new; it is reachable today through any live map whose slot names a model the
  // catalog has never seen. MEASURED: an operator map with sonnet -> 'claude-internal-v9'
  // turns a 1M/1M `claude-opus-5` row into a $30.00 saving, all of it fabricated.
  // Widening the branch above multiplies the ways in, so it is closed here rather than
  // left for the next change to trip over.
  //
  // The honest answer when we cannot price the counterfactual is that NO dollar figure is
  // available for it — so the row books no movement and says so in `routedPriceable`,
  // rather than booking a saving nobody can check. (With the shipped ROUTE_TARGET this is
  // unreachable: every target is catalogued, and policy_parity.test.js pins that.)
  const routedCost = substituted ? costOfModel(decision.model, toks) : null;
  const routedPriceable = !substituted || routedCost != null;
  const newCost = routedCost == null ? baselineCost : routedCost;
  const saved = baselineCost - newCost;   // SIGNED: a costlier route is negative
  return { family, actualTier, effTier, routedTier, routedModel: decision.model,
           passthrough: routedTier == null,
           // Can the gateway rewrite this vendor's model id at all? The dollars above are
           // computed either way — the counterfactual is real arithmetic about real
           // published rates — but only a routable row's dollars are a saving the user can
           // bank today, so scan.js keeps the two apart and the headline takes only the
           // first. This is NOT a clamp and NOT a suppression: nothing is zeroed, the
           // signed delta and the gross/extra split are untouched, and the unroutable
           // rows are reported in full under their own names.
           routable: isRoutableFamily(family, router && router.routableFamilies),
           actualCost, baselineCost, newCost, saved,
           gross: Math.max(0, saved), extra: Math.max(0, -saved),
           // Did the router serve a DIFFERENT model id than the caller named? Distinct
           // from `downgraded`, which is strictly about TIER rank: a same-tier
           // substitution moves real dollars (63 of them in today's catalog) while
           // downgrading nothing, so a surface that counts downgrades and a surface that
           // sums dollars are now answering two different questions and must not be
           // wired to one flag.
           substituted,
           // False ONLY when a route really was taken and its target has no published
           // rate — so `newCost === baselineCost` here means "no figure available",
           // NOT "measured no change". The two zeros must stay distinguishable; that is
           // the same rule `priceable` exists for on the actual leg.
           routedPriceable,
           downgraded: routedTier != null && rank(routedTier) < rank(actualTier),
           priceable: true };
}

module.exports = {
  BUCKET, ROUTE_TARGET, ROUTE_TARGET_BY_TIER, REPRESENTATIVE, CATALOG_AS_OF,
  ROUTABLE_FAMILIES, isRoutableFamily, routeTargetsFor,
  detectFamily, isPriceable, representativeFor, rate, sameModel,
  costOf, costOfDetailed, costOfModel, normalizeTokens, estimateCall,
};
