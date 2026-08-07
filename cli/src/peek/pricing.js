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
// rate. Inventing a price would invent a saving that did not happen.

const { TIERS, rank, modelTier } = require('./classify');
const { resolveModel, ratesFor, normalizeId, CATALOG_AS_OF } = require('./models');

// tier name (haiku|sonnet|opus) -> pricing bucket (cheap|mid|top)
const BUCKET = { haiku: 'cheap', sonnet: 'mid', opus: 'top' };

// The model each family+tier is priced as when the caller knows only a tier (the
// gateway's aggregate path). These are real, current models from the catalog — not
// invented averages — so a bucket price is always some model's actual price.
const REPRESENTATIVE = {
  anthropic: { cheap: 'claude-haiku-4-5', mid: 'claude-sonnet-5', top: 'claude-opus-5' },
  openai:    { cheap: 'gpt-5-mini',       mid: 'gpt-5.4',         top: 'gpt-5.6-sol' },
  google:    { cheap: 'gemini-2.5-flash-lite', mid: 'gemini-3.5-flash', top: 'gemini-3.1-pro' },
  xai:       { cheap: 'grok-4.3',         mid: 'grok-4.3',        top: 'grok-4.5' },
  deepseek:  { cheap: 'deepseek-v4-flash', mid: 'deepseek-v4-flash', top: 'deepseek-v4-pro' },
  mistral:   { cheap: 'ministral-3-8b',   mid: 'mistral-small-4', top: 'mistral-medium-3.5' },
};

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

// True when we hold published rates for this exact model. Callers use this to skip a
// record entirely rather than price it at some neighbour's rate.
function isPriceable(modelId) {
  return resolveModel(modelId) != null;
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

// Core per-call estimate for the PROSPECTIVE report ("what you would save if you
// adopted Cheaper"). contentTierName is the tier the classifier picked from the
// prompt text. Prices the actual leg against the real model and the counterfactual
// against the same family's cheaper tier.
function estimateCall(actualModel, inTok, outTok, contentTierName) {
  const family = detectFamily(actualModel);
  const actualTier = modelTier(actualModel); // haiku|sonnet|opus, or null
  const priceable = isPriceable(actualModel);
  if (!family || !actualTier || !priceable) {
    return { family: family || 'other', actualTier: null, effTier: null,
             actualCost: 0, newCost: 0, saved: 0, downgraded: false, priceable: false };
  }
  const effRank = Math.min(rank(actualTier), rank(contentTierName));
  const effTier = TIERS[effRank];
  const toks = { inFresh: inTok, outTok };
  const actualCost = costOfModel(actualModel, toks) || 0;
  // The cheaper leg is a different model, so it is priced as that tier's
  // representative in the SAME family — never cross-vendor.
  const newCost = effRank === rank(actualTier)
    ? actualCost
    : costOfDetailed(family, effTier, toks);
  const saved = Math.max(0, actualCost - newCost);
  return { family, actualTier, effTier, actualCost, newCost, saved,
           downgraded: effRank < rank(actualTier), priceable: true };
}

module.exports = {
  BUCKET, REPRESENTATIVE, CATALOG_AS_OF,
  detectFamily, isPriceable, representativeFor, rate,
  costOf, costOfDetailed, costOfModel, normalizeTokens, estimateCall,
};
