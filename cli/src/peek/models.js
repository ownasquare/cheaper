'use strict';
// Authoritative per-model price catalog.
//
// Every number here is public list price in USD per 1M tokens, transcribed from the
// provider's own pricing page on the date in CATALOG_AS_OF. Nothing in this file is
// interpolated, averaged, or inferred from a sibling model: if a provider does not
// publish a rate, the field is absent and the model prices as unknown rather than
// guessing. That is the whole point of the file — `peek` reports real dollars, so a
// wrong rate here is a wrong number in front of the user.
//
// Sources (re-verify all of them when bumping CATALOG_AS_OF):
//   Anthropic  https://platform.claude.com/docs/en/about-claude/models/overview
//   OpenAI     https://developers.openai.com/api/docs/pricing
//   Google     https://ai.google.dev/gemini-api/docs/pricing
//   xAI        https://docs.x.ai/docs/models
//   DeepSeek   https://api-docs.deepseek.com/quick_start/pricing
//   Mistral    https://mistral.ai/pricing/api
//
// Shape of an entry:
//   in, out            $/Mtok for fresh input and output. Required.
//   cacheRead          $/Mtok for a prompt-cache hit. Absent => provider has no
//                      cache-read discount for this model; fresh `in` is used.
//   cacheWrite         $/Mtok to WRITE the cache. Absent => the provider does not
//                      charge separately for cache writes (OpenAI pre-5.6, Google,
//                      xAI, DeepSeek): writes bill at `in`.
//   cacheWrite1h       $/Mtok for a 1-hour-TTL cache write, where the provider sells
//                      one (Anthropic only). Claude Code writes 1h entries, so this
//                      is the rate that actually applies to most Claude Code sessions.
//   longContext        { over, in, out, cacheRead } — a second price tier that kicks
//                      in once the request's input exceeds `over` tokens.
//   window             { from, until, in, out, ... } — a promotional/intro price that
//                      applies only inside a date range (Sonnet 5's launch pricing).
//   speed              { fast: {in, out} } — premium-latency pricing.
//
// Open-weight families (Llama, Qwen, and self-hosted Mistral) are deliberately absent.
// They have no single list price — the same weights cost 3-12x more on one host than
// another — so pricing them against any one host would invent a number. They resolve
// to null (unpriceable) unless the user configures a host; see resolveModel().

const CATALOG_AS_OF = '2026-08-06';

// Anthropic bills prompt-cache traffic as a multiple of the model's input rate:
// reads at 0.1x, 5-minute writes at 1.25x, 1-hour writes at 2x. Expressed as
// multipliers rather than per-model dollars because they hold across the family.
const ANTHROPIC_CACHE = { read: 0.1, write5m: 1.25, write1h: 2.0 };

function anthropic(id, tier, inRate, outRate, extra) {
  return Object.assign({
    id, family: 'anthropic', tier, in: inRate, out: outRate,
    cacheRead: inRate * ANTHROPIC_CACHE.read,
    cacheWrite: inRate * ANTHROPIC_CACHE.write5m,
    cacheWrite1h: inRate * ANTHROPIC_CACHE.write1h,
  }, extra || {});
}

// Ordered longest-prefix-first within each family; resolveModel() picks the most
// specific match so `claude-opus-4-8` never falls through to a `claude-opus` rule.
// `tier` is a CAPABILITY class (haiku|sonnet|opus), declared here so it is reviewed
// alongside the price rather than guessed from the model's name at runtime.
//
// It is NEVER a price proxy. Savings compare catalog dollars directly (see tagline.js),
// because capability rank and price rank genuinely disagree: `claude-fable-5` is a top
// model at $60/Mtok blended while `claude-opus-5` is a top model at $30, and Mistral's
// flagship costs less than its mid model. The old name-regex tier conflated the two and
// silently mis-classified 22 of 75 entries by falling through to 'sonnet'.
const CATALOG = [
  // ---- Anthropic ------------------------------------------------------------
  // Fable/Mythos are top-class models priced ABOVE Opus 5 ($60 vs $30 blended). Tier
  // says "as capable as Opus"; it deliberately says nothing about which is cheaper.
  anthropic('claude-fable-5', 'opus', 10, 50),
  anthropic('claude-mythos-5', 'opus', 10, 50),
  // Canonical id is `claude-mythos`: normalizeId() strips a `-preview` suffix, so an
  // entry literally named `claude-mythos-preview` could never be matched.
  anthropic('claude-mythos', 'opus', 10, 50, { aliases: ['claude-mythos-preview'] }),
  // Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 are all $5/$25 — a 3x drop from the Opus 4.1
  // era. Fast mode is a genuinely different SKU on Opus 5 and 4.8.
  anthropic('claude-opus-5', 'opus', 5, 25, { speed: { fast: { in: 10, out: 50 } } }),
  anthropic('claude-opus-4-8', 'opus', 5, 25, { speed: { fast: { in: 10, out: 50 } } }),
  anthropic('claude-opus-4-7', 'opus', 5, 25),
  anthropic('claude-opus-4-6', 'opus', 5, 25),
  anthropic('claude-opus-4-5', 'opus', 5, 25),
  anthropic('claude-opus-4-1', 'opus', 15, 75),
  anthropic('claude-opus-4', 'opus', 15, 75),
  anthropic('claude-3-opus', 'opus', 15, 75),
  // Sonnet 5 launched with promotional pricing; the standard rate is $3/$15.
  anthropic('claude-sonnet-5', 'sonnet', 3, 15, {
    window: { from: '2026-01-01', until: '2026-08-31', in: 2, out: 10,
              cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
  }),
  anthropic('claude-sonnet-4-6', 'sonnet', 3, 15),
  anthropic('claude-sonnet-4-5', 'sonnet', 3, 15),
  anthropic('claude-sonnet-4', 'sonnet', 3, 15),
  anthropic('claude-3-7-sonnet', 'sonnet', 3, 15),
  anthropic('claude-3-5-sonnet', 'sonnet', 3, 15),
  anthropic('claude-haiku-4-5', 'haiku', 1, 5),
  anthropic('claude-3-5-haiku', 'haiku', 0.8, 4),
  anthropic('claude-3-haiku', 'haiku', 0.25, 1.25),

  // ---- OpenAI ---------------------------------------------------------------
  // Cached input is an explicit published rate per model (not a uniform multiplier).
  // Only the 5.6 family charges for cache WRITES; everything older writes free.
  { id: 'gpt-5.6-sol', family: 'openai', tier: 'opus', in: 5, out: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  { id: 'gpt-5.6-terra', family: 'openai', tier: 'sonnet', in: 2, out: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  { id: 'gpt-5.6-luna', family: 'openai', tier: 'haiku', in: 0.2, out: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  { id: 'gpt-5.5-pro', family: 'openai', tier: 'opus', in: 30, out: 180 },
  { id: 'gpt-5.5', family: 'openai', tier: 'opus', in: 5, out: 30, cacheRead: 0.5 },
  { id: 'gpt-5.4-mini', family: 'openai', tier: 'haiku', in: 0.75, out: 4.5, cacheRead: 0.075 },
  { id: 'gpt-5.4-nano', family: 'openai', tier: 'haiku', in: 0.2, out: 1.25, cacheRead: 0.02 },
  { id: 'gpt-5.4-pro', family: 'openai', tier: 'opus', in: 30, out: 180 },
  { id: 'gpt-5.4', family: 'openai', tier: 'sonnet', in: 2.5, out: 15, cacheRead: 0.25 },
  { id: 'gpt-5.2-pro', family: 'openai', tier: 'opus', in: 21, out: 168 },
  { id: 'gpt-5.2', family: 'openai', tier: 'sonnet', in: 1.75, out: 14, cacheRead: 0.175 },
  { id: 'gpt-5.1', family: 'openai', tier: 'sonnet', in: 1.25, out: 10, cacheRead: 0.125 },
  { id: 'gpt-5-mini', family: 'openai', tier: 'haiku', in: 0.25, out: 2, cacheRead: 0.025 },
  { id: 'gpt-5-nano', family: 'openai', tier: 'haiku', in: 0.05, out: 0.4, cacheRead: 0.005 },
  { id: 'gpt-5-pro', family: 'openai', tier: 'opus', in: 15, out: 120 },
  { id: 'gpt-5', family: 'openai', tier: 'sonnet', in: 1.25, out: 10, cacheRead: 0.125 },
  { id: 'gpt-4.1-mini', family: 'openai', tier: 'haiku', in: 0.4, out: 1.6, cacheRead: 0.1 },
  { id: 'gpt-4.1-nano', family: 'openai', tier: 'haiku', in: 0.1, out: 0.4, cacheRead: 0.025 },
  { id: 'gpt-4.1', family: 'openai', tier: 'sonnet', in: 2, out: 8, cacheRead: 0.5 },
  { id: 'gpt-4o-mini', family: 'openai', tier: 'haiku', in: 0.15, out: 0.6, cacheRead: 0.075 },
  { id: 'gpt-4o', family: 'openai', tier: 'sonnet', in: 2.5, out: 10, cacheRead: 1.25 },
  { id: 'o1-pro', family: 'openai', tier: 'opus', in: 150, out: 600 },
  { id: 'o1', family: 'openai', tier: 'opus', in: 15, out: 60, cacheRead: 7.5 },
  { id: 'o3-pro', family: 'openai', tier: 'opus', in: 20, out: 80 },
  { id: 'o3-mini', family: 'openai', tier: 'haiku', in: 1.1, out: 4.4, cacheRead: 0.55 },
  { id: 'o3', family: 'openai', tier: 'sonnet', in: 2, out: 8, cacheRead: 0.5 },
  { id: 'o4-mini', family: 'openai', tier: 'haiku', in: 1.1, out: 4.4, cacheRead: 0.275 },

  // ---- Google ---------------------------------------------------------------
  // Gemini Pro tiers price by prompt size; cached-content storage is billed per
  // hour and is NOT attributable to a single call, so it is deliberately omitted.
  { id: 'gemini-3.6-flash', family: 'google', tier: 'sonnet', in: 1.5, out: 7.5, cacheRead: 0.15 },
  { id: 'gemini-3.5-flash-lite', family: 'google', tier: 'haiku', in: 0.3, out: 2.5, cacheRead: 0.03 },
  { id: 'gemini-3.5-flash', family: 'google', tier: 'sonnet', in: 1.5, out: 9, cacheRead: 0.15 },
  { id: 'gemini-3.1-flash-lite', family: 'google', tier: 'haiku', in: 0.25, out: 1.5, cacheRead: 0.025 },
  { id: 'gemini-3.1-pro', family: 'google', tier: 'opus', in: 2, out: 12, cacheRead: 0.2,
    longContext: { over: 200000, in: 4, out: 18, cacheRead: 0.4 } },
  { id: 'gemini-2.5-pro', family: 'google', tier: 'opus', in: 1.25, out: 10, cacheRead: 0.125,
    longContext: { over: 200000, in: 2.5, out: 15, cacheRead: 0.25 } },
  { id: 'gemini-2.5-flash-lite', family: 'google', tier: 'haiku', in: 0.1, out: 0.4, cacheRead: 0.01 },
  { id: 'gemini-2.5-flash', family: 'google', tier: 'sonnet', in: 0.3, out: 2.5, cacheRead: 0.03 },

  // ---- xAI ------------------------------------------------------------------
  // Every current Grok model doubles its rate above a 200k-token prompt.
  { id: 'grok-4.5', family: 'xai', tier: 'opus', in: 2, out: 6, cacheRead: 0.3,
    longContext: { over: 200000, in: 4, out: 12, cacheRead: 0.6 } },
  { id: 'grok-4.3', family: 'xai', tier: 'sonnet', in: 1.25, out: 2.5, cacheRead: 0.2,
    longContext: { over: 200000, in: 2.5, out: 5, cacheRead: 0.4 } },
  { id: 'grok-4.20', family: 'xai', tier: 'sonnet', in: 1.25, out: 2.5, cacheRead: 0.2,
    longContext: { over: 200000, in: 2.5, out: 5, cacheRead: 0.4 } },
  { id: 'grok-build-0.1', family: 'xai', tier: 'haiku', in: 1, out: 2, cacheRead: 0.2,
    longContext: { over: 200000, in: 2, out: 4, cacheRead: 0.4 } },

  // ---- DeepSeek -------------------------------------------------------------
  { id: 'deepseek-v4-flash', family: 'deepseek', tier: 'haiku', in: 0.14, out: 0.28, cacheRead: 0.0028 },
  { id: 'deepseek-v4-pro', family: 'deepseek', tier: 'opus', in: 0.435, out: 0.87, cacheRead: 0.003625 },

  // ---- Mistral (hosted la Plateforme rates) ---------------------------------
  { id: 'mistral-medium-3.5', family: 'mistral', tier: 'sonnet', in: 1.5, out: 7.5 },
  { id: 'mistral-small-4', family: 'mistral', tier: 'haiku', in: 0.15, out: 0.6 },
  { id: 'mistral-large-3', family: 'mistral', tier: 'opus', in: 0.5, out: 1.5 },
  { id: 'magistral-medium', family: 'mistral', tier: 'sonnet', in: 2, out: 5 },
  { id: 'magistral-small', family: 'mistral', tier: 'haiku', in: 0.5, out: 1.5 },
  { id: 'devstral-small-2', family: 'mistral', tier: 'haiku', in: 0.1, out: 0.3 },
  { id: 'devstral-2', family: 'mistral', tier: 'sonnet', in: 0.4, out: 2 },
  { id: 'codestral', family: 'mistral', tier: 'sonnet', in: 0.3, out: 0.9 },
  { id: 'ministral-3-14b', family: 'mistral', tier: 'haiku', in: 0.2, out: 0.2 },
  { id: 'ministral-3-8b', family: 'mistral', tier: 'haiku', in: 0.15, out: 0.15 },
  { id: 'ministral-3-3b', family: 'mistral', tier: 'haiku', in: 0.1, out: 0.1 },
  { id: 'mistral-nemo', family: 'mistral', tier: 'haiku', in: 0.15, out: 0.15 },
  { id: 'mixtral-8x22b', family: 'mistral', tier: 'sonnet', in: 2, out: 6 },
  { id: 'mixtral-8x7b', family: 'mistral', tier: 'haiku', in: 0.7, out: 0.7 },
];

// Normalize a model id for matching: lowercase, strip a provider/deployment prefix
// (`anthropic.claude-opus-5`, `us.anthropic.claude-...`, `openai/gpt-5`), drop a
// trailing dated snapshot (`-20251001`) or Vertex `@`-version, and unify `.` vs `-`
// so `claude-opus-4-8`, `claude-opus-4.8`, and `claude-opus-4-8-20260101` all match.
function normalizeId(modelId) {
  let m = String(modelId || '').toLowerCase().trim();
  if (!m) return '';
  m = m.replace(/^[a-z0-9_-]+\//, '');            // openrouter/vendor prefix
  m = m.replace(/^(?:[a-z]{2}\.)?anthropic\./, ''); // bedrock / cross-region
  m = m.replace(/@\d{8}$/, '');                     // vertex @20251101
  m = m.replace(/-\d{8}$/, '');                     // dated snapshot
  m = m.replace(/-(?:latest|preview|exp)$/, '');
  return m;
}

// Canonical form for comparison. Providers are inconsistent about `.` vs `-`
// (`gpt-5.6-sol` vs `claude-opus-4-8`), so both collapse to `-`.
function canonical(id) {
  return normalizeId(id).replace(/\./g, '-');
}

// Matching is EXACT (after normalization), never by prefix.
//
// This is load-bearing, so it is worth stating why. An earlier version resolved by
// longest-prefix match, which meant an id the catalog had never seen silently
// inherited a sibling's rate: `claude-opus-4-9` matched `claude-opus-4` and priced a
// hypothetical new Opus at the RETIRED $15/$75 — a 3x overstatement, and the exact
// shape of the incident this catalog was built to prevent. `claude-sonnet-5-2` would
// likewise inherit a promotional window it was never granted.
//
// Prefix matching also makes the module's core honesty rule unreachable: almost
// nothing is ever "unrecognized" if every new id can latch onto an old one, so
// "unknown => unpriceable" never fires. Worse, a prefix hit produces no catalog
// change, so no diff, review, or alarm can ever see it.
//
// Exact matching fails CLOSED: an unrecognized id is unpriceable and contributes $0.
// That is visible and self-correcting. A silently-wrong rate is neither.
//
// Legitimate spelling variants are handled two ways, both explicit:
//   - normalizeId() strips provider prefixes and dated snapshots, so
//     `us.anthropic.claude-opus-5-20260101` canonicalizes to `claude-opus-5`.
//   - an entry may declare `aliases: [...]` for alternate ids it genuinely covers.
// Anything else must be added to the catalog deliberately.
function entryMatches(candidateCanonical, entry) {
  if (canonical(entry.id) === candidateCanonical) return true;
  for (const a of entry.aliases || []) {
    if (canonical(a) === candidateCanonical) return true;
  }
  return false;
}

// Today, UTC, as YYYY-MM-DD. Used as the pricing date when a caller does not supply
// one — see the note on resolveModel() for why this must NOT default to CATALOG_AS_OF.
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// A promotional window is half-open on the right in the sense that `until` is the last
// day the promo price applies; the day after, standard rates resume.
function inWindow(win, at) {
  if (!win || !at) return false;
  if (win.from && at < win.from) return false;
  if (win.until && at > win.until) return false;
  return true;
}

// Resolve a model id to its catalog entry, or null when we cannot price it honestly.
//
// `opts.at` (YYYY-MM-DD) is the date to price AT, and it matters:
//
//   - Retrospective work (peek, the tagline) must price each call on the date that
//     call actually happened, so a session from inside a promotional window keeps the
//     promotional rate forever and a later one does not.
//   - Prospective work prices at today.
//
// It deliberately does NOT default to CATALOG_AS_OF. A frozen default means a window
// that has expired in the real world stays open forever in the code: Claude Sonnet 5's
// launch pricing ends 2026-08-31, and with a CATALOG_AS_OF default every surface would
// keep quoting $2/$10 instead of $3/$15 indefinitely — a silent ~33% understatement
// that no catalog update would fix, because the bug is in the date, not the rates.
// Defaulting to today means known future transitions happen on schedule even if the
// catalog itself is not refreshed. (Rates that change WITHOUT a scheduled window still
// need a catalog refresh; that is what the staleness signal is for.)
function resolveModel(modelId, opts) {
  const cand = canonical(modelId);
  if (!cand) return null;
  let best = null;
  for (const entry of CATALOG) {
    if (entryMatches(cand, entry)) { best = entry; break; }
  }
  if (!best) return null;
  const at = (opts && opts.at) || todayUTC();
  // A live promotional window overrides the standard rates for the fields it names.
  if (inWindow(best.window, at)) {
    const { from, until, ...promo } = best.window;
    return Object.assign({}, best, promo, { promotional: true });
  }
  return best;
}

// Effective per-token rates for one call, after applying the rules that depend on the
// call itself rather than the model: long-context tiers (priced on input size),
// fast/premium speed SKUs, and batch/priority service tiers.
//   ctx: { inputTokens, speed, serviceTier }
function ratesFor(entry, ctx) {
  if (!entry) return null;
  const c = ctx || {};
  let r = { in: entry.in, out: entry.out, cacheRead: entry.cacheRead,
            cacheWrite: entry.cacheWrite, cacheWrite1h: entry.cacheWrite1h };

  // Long-context tier: providers price the WHOLE request at the higher rate once the
  // prompt crosses the threshold, so this replaces the rates rather than blending.
  const lc = entry.longContext;
  if (lc && (c.inputTokens || 0) > lc.over) {
    r.in = lc.in; r.out = lc.out;
    if (lc.cacheRead != null) r.cacheRead = lc.cacheRead;
    if (r.cacheWrite != null) r.cacheWrite = lc.in * (entry.cacheWrite / entry.in);
    if (r.cacheWrite1h != null) r.cacheWrite1h = lc.in * (entry.cacheWrite1h / entry.in);
  }

  // Premium-latency SKU (Anthropic fast mode) is a different published price.
  if (c.speed === 'fast' && entry.speed && entry.speed.fast) {
    const f = entry.speed.fast;
    const scale = f.in / r.in;
    r = { in: f.in, out: f.out,
          cacheRead: r.cacheRead != null ? r.cacheRead * scale : undefined,
          cacheWrite: r.cacheWrite != null ? r.cacheWrite * scale : undefined,
          cacheWrite1h: r.cacheWrite1h != null ? r.cacheWrite1h * scale : undefined };
  }

  // Batch is half price everywhere it exists; priority carries a premium. Anything
  // else (including the usual "standard") is the list rate.
  const tierMult = c.serviceTier === 'batch' ? 0.5
    : c.serviceTier === 'priority' ? 1.8 : 1;
  if (tierMult !== 1) {
    for (const k of ['in', 'out', 'cacheRead', 'cacheWrite', 'cacheWrite1h']) {
      if (r[k] != null) r[k] *= tierMult;
    }
  }

  // Fall back only WITHIN a model's own published sheet: a provider that sells no
  // cache discount bills cache traffic at its input rate. Never borrow another
  // model's number.
  if (r.cacheRead == null) r.cacheRead = r.in;
  if (r.cacheWrite == null) r.cacheWrite = r.in;
  if (r.cacheWrite1h == null) r.cacheWrite1h = r.cacheWrite;
  return r;
}

module.exports = { CATALOG, CATALOG_AS_OF, ANTHROPIC_CACHE, resolveModel, ratesFor, normalizeId, todayUTC };
