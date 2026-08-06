'use strict';
// Faithful Node port of the gateway's routing classifier (gateway/app/router.py).
// `peek` reuses the exact same decision logic the live gateway applies, so the
// "what you could have saved" estimate matches what Cheaper would really do:
//   - cheapest tier by default,
//   - auto-escalate hard categories (concurrency, security, proofs, ...) to the top,
//   - NEVER route above the model the caller actually requested (a ceiling).
// Keep the pattern lists in lock-step with router.py.

// Tier ordering: index is the rank (higher = more capable).
const TIERS = ['haiku', 'sonnet', 'opus'];
function rank(tier) { return TIERS.indexOf(tier); }

// --- Category signals (mirror _OPUS_PATTERNS / _SONNET_PATTERNS in router.py) ---
const OPUS_PATTERNS = [
  /\bconcurren(?:t|cy)\b/i, /\bdeadlock\b/i, /\brace condition\b/i, /\bmutex\b/i,
  /\block(?:s|ing|-free)?\b/i, /\bthread(?:s|ing|-safe)?\b/i, /\bsemaphore\b/i,
  /\baba problem\b/i, /\bmemory[- ]order/i, /\batomic(?:s|ity)?\b/i,
  /\bsecurity\b/i, /\bvulnerab/i, /\bexploit\b/i, /\bcrypto(?:graph)?/i, /\bauth(?:entication|orization)\b/i,
  /\bsql injection\b/i, /\bxss\b/i, /\bcsrf\b/i, /\bsanitiz/i,
  /\bproof\b/i, /\bprovably\b/i, /\bprove that\b/i, /\binvariant\b/i, /\bformal(?:ly)? (?:correct|verify)/i,
  /\blegal(?:ly)?\b/i, /\bcontract\b/i, /\bliab(?:le|ility)\b/i, /\bregulat/i,
  /\bmedical\b/i, /\bdiagnos/i, /\bdosage\b/i, /\btax(?:es|ation)?\b/i,
  /\bfinanc(?:e|ial)\b/i, /\birreversible\b/i, /\bproduction outage\b/i,
  /\barchitect(?:ure|ing)?\b/i, /\bdistributed system/i, /\bconsensus\b/i, /\bsharding\b/i,
];
const SONNET_PATTERNS = [
  /\brefactor\b/i, /\bimplement\b/i, /\bpaginat/i, /\bendpoint\b/i, /\bmigrat/i,
  /\bsummar(?:ize|y)\b/i, /\banalyz/i, /\bdebug\b/i, /\bwrite tests?\b/i,
  /\bunit test/i, /\bintegrat(?:e|ion)\b/i, /\balgorithm\b/i, /\boptimi[sz]e\b/i,
];
// Multi-step / dense signals that nudge from haiku up to sonnet.
const MULTISTEP_PATTERNS = [
  /\bstep \d\b/i, /\bfirst,.*then\b/i, /\band then\b/i, /\bafterwards?\b/i,
];
const CODE_FENCE = /```/;
const LONG_REQUEST_CHARS = 4000;

// Tier implied by the request content alone (ignoring the requested model).
function contentTier(text) {
  const t = text || '';
  for (const rgx of OPUS_PATTERNS) {
    if (rgx.test(t)) return { tier: 'opus', reason: 'auto-escalate category: ' + rgx.source };
  }
  for (const rgx of SONNET_PATTERNS) {
    if (rgx.test(t)) return { tier: 'sonnet', reason: 'moderate task signal: ' + rgx.source };
  }
  if (t.length >= LONG_REQUEST_CHARS) return { tier: 'sonnet', reason: `long/dense request (${t.length} chars)` };
  if (CODE_FENCE.test(t)) return { tier: 'sonnet', reason: 'contains code block' };
  for (const rgx of MULTISTEP_PATTERNS) {
    if (rgx.test(t)) return { tier: 'sonnet', reason: 'multi-step request' };
  }
  return { tier: 'haiku', reason: 'simple/short request' };
}

// Map an arbitrary model id back to a coarse capability tier (haiku|sonnet|opus).
// This is what "the model the caller actually used" resolves to, so the ceiling
// can be applied. Cheap signals win over top signals (e.g. "o3-mini" is cheap).
// Word-boundaried so "mini" doesn't fire inside "geMINI", etc.
const CHEAP_SIGNALS = /(\bhaiku|\bmini\b|\bnano\b|\bflash\b|\blite\b|\bsmall\b|\binstant\b|\b8b\b|\b7b\b|\b3b\b|\btiny\b|\bmicro\b|\bembed)/i;
const TOP_SIGNALS = /(\bopus|\bultra\b|[-\s]pro\b|\breasoner\b|\bthinking\b|\bo1\b|\bo3\b|\bo4\b|\b405b\b|\b72b\b|\blarge\b|grok-4|grok-3\b|deepseek-r1|\bqwq\b)/i;

function modelTier(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (!m) return null;
  if (CHEAP_SIGNALS.test(m)) return 'haiku';
  if (TOP_SIGNALS.test(m)) return 'opus';
  return 'sonnet';
}

// The effective tier Cheaper WOULD have used: the cheaper of (content tier, the
// model actually used). Never upgrades above what the caller asked for.
function effectiveTier(text, actualModel) {
  const content = contentTier(text);
  const actual = modelTier(actualModel);
  if (actual == null) return { ...content, capped: false, actualTier: null };
  if (rank(content.tier) > rank(actual)) {
    return { tier: actual, reason: content.reason + `; capped to used model '${actual}'`, capped: true, actualTier: actual };
  }
  return { ...content, capped: false, actualTier: actual };
}

module.exports = { TIERS, rank, contentTier, modelTier, effectiveTier, LONG_REQUEST_CHARS };
