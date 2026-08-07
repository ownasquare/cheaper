'use strict';
// `cheaper peek --tagline` — the one-line, Cheaper.app-branded savings summary that
// every harness appends at the END of a completed chat. Unlike the full `peek`
// report (which is PROSPECTIVE: "what you WOULD save if you adopt Cheaper", read
// from logs of runs that did NOT route), this measures the REALIZED savings of the
// current chat: the chat's ceiling model (the top tier its top-level turns ran on)
// vs. the cheaper tiers Cheaper actually routed sub-tasks to.
//
// Number source, honoring "real when gateway, else estimate":
//   1. If the gateway is running and has session-tagged rows for this chat, use its
//      EXACT realized dollars (what you'd have paid at the requested model vs. what
//      Cheaper spent). No leading "~".
//   2. Otherwise, estimate from the chat transcript (ceiling-vs-actual). Marked "~".
//   3. If nothing cheaper happened, stay honest: no "$0.00 saved" — either a plain
//      "kept on the <tier> tier" brand line, or nothing at all.
//
// Fully local + read-only. The only network touch is an optional GET to the local
// gateway on 127.0.0.1; any failure silently falls back to the transcript estimate.

const http = require('http');
const { TIERS, rank, modelTier } = require('./classify');
const { detectFamily, isPriceable, costOfModel } = require('./pricing');
const { HARNESSES, collectHarness, sessionStem, sessionIdFor } = require('./adapters');
const { tokens: fmtTokens } = require('./render');
const ledger = require('./ledger');

// The smallest saving we'll claim. Set at a full cent so an exact figure is never a
// rounded-UP sub-cent value (e.g. $0.006 shown as an exact "$0.01").
const SHOW_MIN_USD = 0.01;

function money(n) {
  const v = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
  return '$' + v.toLocaleString('en-US', {
    minimumFractionDigits: Math.abs(n) >= 100 ? 0 : 2, maximumFractionDigits: 2,
  });
}

// Resolve a harness key to its adapter. A key we don't recognize returns null (so
// the tagline stays empty) rather than silently falling back to another harness's
// history — misattributing one tool's savings to another would be a lie.
function harnessDef(key) {
  if (!key) return HARNESSES[0]; // default: claude-code
  return HARNESSES.find((d) => d.key === key) || null;
}

// Per-call token breakdown for cache-aware pricing. Claude Code records carry the
// full split (inFresh / cacheCreate5m / cacheCreate1h / cacheRead); other harnesses
// only have a combined inTokens, which we treat as fresh input so pricing is
// unchanged for them.
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

// Billing modifiers that change a call's rate without changing its token counts.
function billingCtx(r) {
  return { speed: r.speed || null, serviceTier: r.serviceTier || null };
}

// Realized savings for a scoped set of chat records. Baseline = the chat's ceiling
// tier (the top tier its top-level/user turns ran on); every call routed BELOW that
// ceiling is credited the difference at its own family's rates. Unknown/unpriceable
// models are skipped (never invent a saving that can't be priced).
function realizedFromRecords(records) {
  // A model we hold no published price for is skipped outright. Pricing it at a
  // neighbour's rate would put a number on screen that no invoice would ever match.
  const priced = (records || []).filter((r) => isPriceable(r.model) && modelTier(r.model));
  if (!priced.length) return null;
  // Ceiling = the top tier a top-level (user) turn ran on, and the exact MODEL that
  // ran there. The honest counterfactual for a downgraded sub-task is "what it would
  // have cost on the SESSION'S ceiling model" — so the baseline is priced against that
  // model's own published rates, not the sub-task's family (which, cross-provider,
  // would invent savings against a model the session never used) and not a tier
  // average (which would price Opus 5 work at retired Opus 4.1 rates).
  const pool = priced.filter((r) => r.source !== 'subagent');
  const ceilingSrc = pool.length ? pool : priced;
  let ceilingRank = -1, ceilingModel = null, ceilingCtx = null;
  for (const r of ceilingSrc) {
    const rk = rank(modelTier(r.model));
    if (rk > ceilingRank) { ceilingRank = rk; ceilingModel = r.model; ceilingCtx = billingCtx(r); }
  }
  const ceilingTier = TIERS[ceilingRank];

  const tierHist = { haiku: 0, sonnet: 0, opus: 0 };       // every priced call (diagnostics only)
  const savedTierHist = { haiku: 0, sonnet: 0, opus: 0 };  // ONLY the calls Cheaper routed cheaper
  let dollarsSaved = 0, dollarsSpent = 0, tokensSaved = 0, belowCeilingCalls = 0, topRank = ceilingRank;
  let totalSpent = 0, totalTokens = 0; // the whole session's real (cache-aware) bill
  let anyEstimated = false;            // true if any leg's tokens were inferred, not reported
  for (const r of priced) {
    const t = modelTier(r.model);
    tierHist[t] = (tierHist[t] || 0) + 1;
    if (rank(t) > topRank) topRank = rank(t); // a subagent above the user ceiling still ran
    if (r.estimated) anyEstimated = true;
    const bk = tokenBreakdown(r);
    // Exact cost of this call on the model that actually ran it, at its own cache,
    // long-context, speed and service-tier rates.
    const spent = costOfModel(r.model, bk, billingCtx(r)) || 0;
    totalSpent += spent;
    totalTokens += (r.inTokens || 0) + (r.outTokens || 0);
    if (rank(t) < ceilingRank) {
      // A call routed BELOW the session ceiling — i.e. work Cheaper delegated to a
      // cheaper tier. The main loop runs AT the ceiling and is the baseline, never a
      // "routed" call, so it is deliberately excluded from the savings breakdown.
      const baseline = costOfModel(ceilingModel, bk, ceilingCtx);
      const save = baseline == null ? 0 : baseline - spent; // vs the ceiling model
      if (save > 0) {
        dollarsSaved += save; dollarsSpent += spent; tokensSaved += (r.inTokens || 0) + (r.outTokens || 0);
        belowCeilingCalls++; savedTierHist[t]++;
      }
    }
  }
  const wouldHave = dollarsSpent + dollarsSaved; // cost of the routed work at the ceiling model
  const savedPct = wouldHave > 0 ? Math.round((dollarsSaved / wouldHave) * 100) : 0;
  return { ceilingTier, ceilingModel, topTier: TIERS[topRank], dollarsSaved, dollarsSpent,
           wouldHave, savedPct, tokensSaved, totalSpent, totalTokens, belowCeilingCalls,
           tierHist, savedTierHist, calls: priced.length, estimatedTokens: anyEstimated,
           exact: false };
}

// Same shape, from the running gateway's EXACT session-filtered metrics summary.
function fromGateway(summary) {
  if (!summary || !summary.by_tier || !summary.dollars) return null;
  const byTier = summary.by_tier;
  const tierHist = { haiku: 0, sonnet: 0, opus: 0 };
  const present = [];
  for (const t of TIERS) {
    const n = (byTier[t] && byTier[t].count) || 0;
    tierHist[t] = n;
    if (n > 0) present.push(t);
  }
  if (!present.length) return null;
  const topRank = Math.max(...present.map((t) => rank(t)));
  const topTier = TIERS[topRank];
  const dollarsSaved = (summary.dollars && summary.dollars.saved) || 0;
  const belowCeilingCalls = (summary.counts && summary.counts.models_changed) || 0;
  // Per-tier histogram of the DOWNGRADED (money-saving) rows only — what Cheaper
  // actually routed to a cheaper tier, never the calls that ran at the requested
  // ceiling. Prefer the gateway's exact figure; fall back for an older gateway.
  const savedTierHist = { haiku: 0, sonnet: 0, opus: 0 };
  const dbt = summary.downgraded_by_tier;
  if (dbt) {
    for (const t of TIERS) savedTierHist[t] = dbt[t] || 0;
  } else {
    for (const t of present) if (rank(t) < topRank) savedTierHist[t] = (byTier[t] && byTier[t].count) || 0;
    const below = TIERS.reduce((s, t) => s + savedTierHist[t], 0);
    if (below === 0 && belowCeilingCalls > 0) savedTierHist[present[0]] = belowCeilingCalls; // uniform downgrade
  }
  // Tokens attributable to routing. The gateway's dollarsSaved uses a
  // requested-vs-spent baseline, so tokensSaved must NOT be derived from run-tier
  // histograms (that yields "$X and 0 tokens" on a uniformly-downgraded session).
  // Prefer the gateway's exact tokens-on-downgraded-rows figure; if an older gateway
  // didn't report it, count all processed tokens whenever any call was downgraded.
  let tokensSaved = (summary.tokens && summary.tokens.downgraded) || 0;
  if (!tokensSaved && belowCeilingCalls > 0) {
    for (const t of present) { const d = byTier[t] || {}; tokensSaved += (d.in_tokens || 0) + (d.out_tokens || 0); }
  }
  // Whole-session context: the gateway routes every call, so its spend IS the total.
  const dol = summary.dollars || {};
  const totalSpent = dol.spent || 0;
  let totalTokens = 0;
  for (const t of present) { const d = byTier[t] || {}; totalTokens += (d.in_tokens || 0) + (d.out_tokens || 0); }
  const savedPct = dol.savings_pct || 0;
  return { ceilingTier: topTier, topTier, dollarsSaved, dollarsSpent: totalSpent,
           wouldHave: totalSpent + dollarsSaved, savedPct, tokensSaved, totalSpent, totalTokens,
           belowCeilingCalls, tierHist, savedTierHist, calls: summary.total || 0, exact: true };
}

// Best-effort GET to the local gateway for exact, session-scoped metrics. Resolves
// to the parsed summary or null. Never throws; short timeout so a stopped gateway
// (the common case) costs us almost nothing before we fall back to the estimate.
function fetchGatewaySession(sessionId, timeoutMs = 600) {
  return new Promise((resolve) => {
    const port = process.env.CHEAPER_PORT || '8787';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = http.get({
        host: '127.0.0.1', port,
        path: '/metrics?session=' + encodeURIComponent(sessionId),
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish(null); }
        let data = '';
        res.on('data', (d) => { data += d; if (data.length > 4e6) req.destroy(); });
        res.on('end', () => { try { finish(JSON.parse(data)); } catch { finish(null); } });
      });
      req.on('error', () => finish(null));
      req.on('timeout', () => { req.destroy(); finish(null); });
    } catch { finish(null); }
  });
}

function collectSessionRecords(opts) {
  const def = harnessDef(opts.only || 'claude-code');
  if (!def) return { def: null, records: [] }; // unknown --harness → nothing, not a wrong harness
  let records = [];
  try { records = (collectHarness(def, opts) || {}).records || []; } catch { records = []; }
  return { def, records };
}

// The branded line — or '' when there is genuinely nothing to say.
function joinAnd(parts) {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// The brand link points at the /love page (star on GitHub, donate, share with a
// buddy) rather than the site root, so every rendered "Cheaper.app" doubles as a
// soft, honest call to support the project.
const SITE = 'https://cheaper.app/love';
// How the "Cheaper.app" brand token renders. `markdown` for chat harnesses that
// render it (the model pastes a real link to cheaper.app); `plain` everywhere else.
function brandFor(format) {
  if (format === 'markdown' || format === 'md') return `[Cheaper.app](${SITE})`;
  if (format === 'ansi') return `]8;;${SITE}\\Cheaper.app]8;;\\`;
  return 'Cheaper.app';
}

// Green/red visual cue on a money figure: an emoji dot (renders in every chat UI,
// since markdown can't colour plain text) plus true ANSI colour when format==='ansi'
// (terminals / the Stop hook). 'save' → green, 'spend' → red.
const ANSI = { green: '[32m', red: '[31m', reset: '[0m' };
function tint(str, kind, format) {
  const dot = kind === 'spend' ? '🔴' : '🟢';
  if (format === 'ansi') {
    const col = kind === 'spend' ? ANSI.red : ANSI.green;
    return `${dot} ${col}${str}${ANSI.reset}`;
  }
  return `${dot} ${str}`;
}

// The local dashboard URL and the "See logs" suffix appended at the very END of the
// line — the charts / historical / per-tool / lifetime view (served by the gateway).
function dashboardUrl(o) {
  return (o && o.logsUrl) || process.env.CHEAPER_DASHBOARD_URL ||
    `http://localhost:${process.env.CHEAPER_PORT || '8787'}/dashboard`;
}
function logsSuffix(format, url) {
  if (!url) return '';
  if (format === 'markdown' || format === 'md') return ` [See logs](${url})`;
  return ` See logs: ${url}`;
}

// The whole-session context sentence, separate from what Cheaper's routing saved.
//
// Deliberately NOT phrased as "you spent $X". Most of these sessions run against a
// flat-rate subscription, where no such sum is ever charged — a Max subscriber seeing
// "you spent $97" against a $200/mo plan is being told something false, and it reads
// as a broken estimator rather than as the metered value of the work. What the number
// honestly measures is the metered value of the tokens at published list rates, which
// is the right basis whether the user is billed per-token or on a subscription.
function spendSentence(r, format) {
  if (!r || !(r.totalSpent >= SHOW_MIN_USD)) return '';
  const amt = (r.exact ? '' : '~') + money(r.totalSpent);
  const toks = fmtTokens(r.totalTokens || 0);
  return ` This session ran ${toks} tokens, worth ${tint(amt, 'spend', format)} at list API rates.`;
}

function buildTagline(r, brand, format) {
  if (!r) return '';
  brand = brand || 'Cheaper.app';
  const spend = spendSentence(r, format);
  // The breakdown reports ONLY the tiers Cheaper routed cheaper work to (the savings
  // drivers) — never the main-loop / ceiling calls, which Cheaper did not route and
  // which would otherwise balloon the count while the savings stay flat.
  const parts = [];
  for (const t of TIERS) {
    const n = (r.savedTierHist && r.savedTierHist[t]) || 0;
    if (n > 0) parts.push(`${t} tier for ${n} call${n === 1 ? '' : 's'}`);
  }
  const realSaving = r.dollarsSaved >= SHOW_MIN_USD && r.belowCeilingCalls > 0 &&
    r.tokensSaved > 0 && parts.length > 0;
  if (realSaving) {
    const amt = (r.exact ? '' : '~') + money(r.dollarsSaved);
    const savedTop = Math.max(...TIERS.filter((t) => (r.savedTierHist[t] || 0) > 0).map(rank));
    const base = (r.ceilingTier && rank(r.ceilingTier) > savedTop) ? ` instead of ${r.ceilingTier}` : '';
    return `${brand} saved ${tint(amt, 'save', format)} and ${fmtTokens(r.tokensSaved)} tokens by using ${joinAnd(parts)}${base}.${spend}`;
  }
  // No cheaper routing this chat: name the ACTUAL top tier that ran (a subagent may
  // have run above the user-turn ceiling), never understate it.
  const keptTier = r.topTier || r.ceilingTier;
  if (keptTier) {
    return `${brand} kept this chat on the ${keptTier} tier — no cheaper routing was warranted.${spend}`;
  }
  return '';
}

async function computeSavings(opts) {
  const sid = opts.session || (opts.transcript ? sessionStem(opts.transcript) : null);
  if (sid) {
    const summary = await fetchGatewaySession(sid);
    const g = summary && fromGateway(summary);
    if (g && g.dollarsSaved >= SHOW_MIN_USD) return g; // exact, real — no "~"
  }
  const { records } = collectSessionRecords(opts);
  return realizedFromRecords(records); // may be null
}

// opts: { session, current, transcript, only, sinceDays, json }
// The all-time running total, appended after the per-chat line so the value Cheaper
// has delivered is visible at the end of EVERY chat — including a no-routing chat,
// where the per-chat line is just the "kept on the <tier> tier" brand line. Shown
// only once the lifetime total is a real amount (>= 1c and some tokens). Marked "~"
// unless every contributing chat's figure came from the exact gateway numbers.
function lifetimeSentence(tot, format) {
  if (!tot || !(tot.usd >= SHOW_MIN_USD) || !(tot.tokens > 0)) return '';
  const amt = (tot.exact ? '' : '~') + money(tot.usd);
  return ` Lifetime savings: ${tint(amt, 'save', format)} and ${fmtTokens(tot.tokens)} tokens.`;
}

async function run(opts = {}) {
  const o = Array.isArray(opts) ? { current: true } : (opts || {});
  const result = await computeSavings(o);
  const line = buildTagline(result, brandFor(o.format), o.format);
  // Record THIS chat's realized saving in the lifetime ledger, keyed by session id so
  // repeated runs for the same chat overwrite (never double-count), then read back the
  // running total. Fully best-effort: a ledger failure must never drop the base line.
  let tot = null;
  try {
    const def = harnessDef(o.only || 'claude-code');
    const key = def ? sessionIdFor(def, o) : null;
    tot = ledger.record(key, (result && result.dollarsSaved) || 0,
      (result && result.tokensSaved) || 0, !!(result && result.exact));
  } catch { tot = null; }
  const lifetime = lifetimeSentence(tot, o.format);
  let out = line ? line + lifetime : lifetime.trimStart();
  // A "See logs" link to the local dashboard at the very end of every rendered line.
  if (out) out += logsSuffix(o.format, dashboardUrl(o));
  if (o.json) {
    console.log(JSON.stringify({
      line,                 // the per-chat line only (unchanged meaning)
      full: out,            // per-chat line + lifetime sentence — what actually prints
      lifetime: tot || null,
      source: result ? (result.exact ? 'gateway' : 'estimate') : 'none',
      result: result || null,
    }, null, 2));
    return;
  }
  if (out) console.log(out);
}

module.exports = { run, computeSavings, realizedFromRecords, fromGateway, buildTagline, money };
