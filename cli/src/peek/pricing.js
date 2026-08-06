'use strict';
// Real-dollar pricing for the `peek` savings estimate.
//
// Every model id a harness actually used is mapped to a provider FAMILY and a
// coarse TIER (cheap|mid|top). Cheaper's ceiling rule means a call is only ever
// re-routed DOWN within the same family (Opus->Haiku, GPT-4o->mini, Pro->Flash),
// never to a different vendor and never upward. Savings for one call are:
//     actual_tier_cost(in,out) - effective_tier_cost(in,out)
// where effective_tier = min(actual_tier, content_tier). Same token counts, a
// cheaper per-token rate — a conservative, apples-to-apples estimate.
//
// Prices are public list $/Mtok (input, output), late-2025 ballpark. They are
// deliberately overridable and only the RATIOS drive the headline percentage.

const { TIERS, rank, modelTier } = require('./classify');

// family -> tier -> { model, in, out }  ($ per 1M tokens)
const FAMILIES = {
  anthropic: {
    label: 'Anthropic',
    cheap: { model: 'claude-haiku-4-5', in: 1.0, out: 5.0 },
    mid:   { model: 'claude-sonnet-4-5', in: 3.0, out: 15.0 },
    top:   { model: 'claude-opus-4', in: 15.0, out: 75.0 },
  },
  openai: {
    label: 'OpenAI',
    cheap: { model: 'gpt-4o-mini', in: 0.15, out: 0.60 },
    mid:   { model: 'gpt-4o', in: 2.5, out: 10.0 },
    top:   { model: 'o3', in: 15.0, out: 60.0 },
  },
  google: {
    label: 'Google',
    cheap: { model: 'gemini-1.5-flash-8b', in: 0.075, out: 0.30 },
    mid:   { model: 'gemini-2.5-flash', in: 0.30, out: 2.50 },
    top:   { model: 'gemini-2.5-pro', in: 1.25, out: 10.0 },
  },
  xai: {
    label: 'xAI',
    cheap: { model: 'grok-3-mini', in: 0.30, out: 0.50 },
    mid:   { model: 'grok-3', in: 3.0, out: 15.0 },
    top:   { model: 'grok-4', in: 5.0, out: 25.0 },
  },
  deepseek: {
    label: 'DeepSeek',
    cheap: { model: 'deepseek-chat', in: 0.27, out: 1.10 },
    mid:   { model: 'deepseek-chat', in: 0.27, out: 1.10 },
    top:   { model: 'deepseek-reasoner', in: 0.55, out: 2.19 },
  },
  qwen: {
    label: 'Qwen',
    cheap: { model: 'qwen2.5-7b', in: 0.10, out: 0.20 },
    mid:   { model: 'qwen2.5-32b', in: 0.30, out: 0.60 },
    top:   { model: 'qwen2.5-72b', in: 0.70, out: 1.40 },
  },
  meta: {
    label: 'Meta',
    cheap: { model: 'llama-3.1-8b', in: 0.05, out: 0.10 },
    mid:   { model: 'llama-3.3-70b', in: 0.30, out: 0.40 },
    top:   { model: 'llama-3.1-405b', in: 2.70, out: 2.70 },
  },
  mistral: {
    label: 'Mistral',
    cheap: { model: 'mistral-small', in: 0.20, out: 0.60 },
    mid:   { model: 'mistral-medium', in: 0.40, out: 2.00 },
    top:   { model: 'mistral-large', in: 2.00, out: 6.00 },
  },
  other: {
    label: 'Other',
    cheap: { model: 'small', in: 0.20, out: 0.60 },
    mid:   { model: 'mid', in: 1.00, out: 3.00 },
    top:   { model: 'top', in: 5.00, out: 15.00 },
  },
};

// tier name (haiku|sonnet|opus) -> pricing bucket (cheap|mid|top)
const BUCKET = { haiku: 'cheap', sonnet: 'mid', opus: 'top' };

// Returns null for models we don't actually recognize. That is deliberate: an
// unknown model must be UNPRICEABLE (saved=0), never priced against arbitrary
// 'other' rates and reported as a saving that didn't happen.
function detectFamily(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (!m) return null;
  if (/(claude|haiku|sonnet|opus|anthropic)/.test(m)) return 'anthropic';
  if (/(gpt|davinci|babbage|chatgpt|\bo1\b|-o1|\bo3\b|-o3|\bo4\b|-o4|openai)/.test(m)) return 'openai';
  if (/(gemini|palm|bison|gemma)/.test(m)) return 'google';
  if (/grok/.test(m)) return 'xai';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/qwen|qwq/.test(m)) return 'qwen';
  if (/(llama|meta-llama)/.test(m)) return 'meta';
  if (/(mistral|mixtral|codestral|ministral)/.test(m)) return 'mistral';
  return null; // unrecognized -> unpriceable
}

function rate(family, tierName) {
  const fam = FAMILIES[family] || FAMILIES.other;
  return fam[BUCKET[tierName]] || fam.mid;
}

function costOf(family, tierName, inTok, outTok) {
  const r = rate(family, tierName);
  return (inTok / 1e6) * r.in + (outTok / 1e6) * r.out;
}

// Prompt-cache multipliers on the INPUT rate (Anthropic ratios; a good default
// elsewhere). Cache reads bill at ~10% of input, 5-minute cache writes at ~125%.
// Harnesses that don't report a cache split just pass it all as fresh input.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

// Cache-aware cost of one call given its token breakdown. `toks` may carry
// { inFresh, cacheCreate, cacheRead, outTok }; any missing piece is treated as 0,
// and a record with only { inTokens, outTokens } prices identically to costOf().
function costOfDetailed(family, tierName, toks) {
  const r = rate(family, tierName);
  const inFresh = toks.inFresh || 0;
  const cc = toks.cacheCreate || 0;
  const cr = toks.cacheRead || 0;
  const out = toks.outTok || 0;
  return (inFresh / 1e6) * r.in
       + (cc / 1e6) * r.in * CACHE_WRITE_MULT
       + (cr / 1e6) * r.in * CACHE_READ_MULT
       + (out / 1e6) * r.out;
}

// Core per-call estimate. contentTierName is the tier the classifier picked from
// the prompt text. Returns nulls when the model is unknown (can't price safely).
function estimateCall(actualModel, inTok, outTok, contentTierName) {
  const family = detectFamily(actualModel);
  const actualTier = modelTier(actualModel); // haiku|sonnet|opus, or null
  if (!family || !actualTier) {
    return { family: family || 'other', actualTier: null, effTier: null,
             actualCost: 0, newCost: 0, saved: 0, downgraded: false };
  }
  const effRank = Math.min(rank(actualTier), rank(contentTierName));
  const effTier = TIERS[effRank];
  const actualCost = costOf(family, actualTier, inTok, outTok);
  const newCost = costOf(family, effTier, inTok, outTok);
  const saved = Math.max(0, actualCost - newCost);
  return { family, actualTier, effTier, actualCost, newCost, saved, downgraded: effRank < rank(actualTier) };
}

module.exports = { FAMILIES, BUCKET, detectFamily, rate, costOf, costOfDetailed, estimateCall };
