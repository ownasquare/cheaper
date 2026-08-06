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
const { detectFamily, costOf } = require('./pricing');
const { HARNESSES, collectHarness, sessionStem } = require('./adapters');
const { tokens: fmtTokens } = require('./render');

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

// Realized savings for a scoped set of chat records. Baseline = the chat's ceiling
// tier (the top tier its top-level/user turns ran on); every call routed BELOW that
// ceiling is credited the difference at its own family's rates. Unknown/unpriceable
// models are skipped (never invent a saving that can't be priced).
function realizedFromRecords(records) {
  const priced = (records || []).filter((r) => detectFamily(r.model) && modelTier(r.model));
  if (!priced.length) return null;
  // Ceiling = the top tier a top-level (user) turn ran on, AND the family of that
  // ceiling model. The honest counterfactual for a downgraded sub-task is "what it
  // would have cost on the SESSION'S ceiling model" — so we price the baseline in the
  // ceiling model's own family+tier, not the sub-task's family (which, cross-provider,
  // would invent savings against a model the session never used).
  const pool = priced.filter((r) => r.source !== 'subagent');
  const ceilingSrc = pool.length ? pool : priced;
  let ceilingRank = -1, ceilingFamily = null;
  for (const r of ceilingSrc) {
    const rk = rank(modelTier(r.model));
    if (rk > ceilingRank) { ceilingRank = rk; ceilingFamily = detectFamily(r.model); }
  }
  const ceilingTier = TIERS[ceilingRank];

  const tierHist = { haiku: 0, sonnet: 0, opus: 0 };
  let dollarsSaved = 0, tokensSaved = 0, belowCeilingCalls = 0, topRank = ceilingRank;
  for (const r of priced) {
    const fam = detectFamily(r.model);
    const t = modelTier(r.model);
    tierHist[t] = (tierHist[t] || 0) + 1;
    if (rank(t) > topRank) topRank = rank(t); // a subagent above the user ceiling still ran
    const inTok = r.inTokens || 0, outTok = r.outTokens || 0;
    if (rank(t) < ceilingRank) {
      const save = costOf(ceilingFamily, ceilingTier, inTok, outTok) - costOf(fam, t, inTok, outTok);
      if (save > 0) { dollarsSaved += save; tokensSaved += inTok + outTok; belowCeilingCalls++; }
    }
  }
  return { ceilingTier, topTier: TIERS[topRank], dollarsSaved, tokensSaved, belowCeilingCalls,
           tierHist, calls: priced.length, exact: false };
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
  // Tokens attributable to routing. The gateway's dollarsSaved uses a
  // requested-vs-spent baseline, so tokensSaved must NOT be derived from run-tier
  // histograms (that yields "$X and 0 tokens" on a uniformly-downgraded session).
  // Prefer the gateway's exact tokens-on-downgraded-rows figure; if an older gateway
  // didn't report it, count all processed tokens whenever any call was downgraded.
  let tokensSaved = (summary.tokens && summary.tokens.downgraded) || 0;
  if (!tokensSaved && belowCeilingCalls > 0) {
    for (const t of present) { const d = byTier[t] || {}; tokensSaved += (d.in_tokens || 0) + (d.out_tokens || 0); }
  }
  return { ceilingTier: topTier, topTier, dollarsSaved, tokensSaved, belowCeilingCalls,
           tierHist, calls: summary.total || 0, exact: true };
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
function buildTagline(r) {
  if (!r) return '';
  const tierParts = [];
  for (const t of TIERS) {
    const n = (r.tierHist && r.tierHist[t]) || 0;
    if (n > 0) tierParts.push(`${t} tier for ${n} call${n === 1 ? '' : 's'}`);
  }
  const realSaving = r.dollarsSaved >= SHOW_MIN_USD && r.belowCeilingCalls > 0 &&
    r.tokensSaved > 0 && tierParts.length > 0;
  if (realSaving) {
    const amt = (r.exact ? '' : '~') + money(r.dollarsSaved);
    return `Cheaper.app saved ${amt} and ${fmtTokens(r.tokensSaved)} tokens by using ${tierParts.join(', ')}.`;
  }
  // No cheaper routing this chat: name the ACTUAL top tier that ran (a subagent may
  // have run above the user-turn ceiling), never understate it.
  const keptTier = r.topTier || r.ceilingTier;
  if (tierParts.length && keptTier) {
    return `Cheaper.app kept this chat on the ${keptTier} tier — no cheaper routing was warranted.`;
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
async function run(opts = {}) {
  const o = Array.isArray(opts) ? { current: true } : (opts || {});
  const result = await computeSavings(o);
  const line = buildTagline(result);
  if (o.json) {
    console.log(JSON.stringify({
      line,
      source: result ? (result.exact ? 'gateway' : 'estimate') : 'none',
      result: result || null,
    }, null, 2));
    return;
  }
  if (line) console.log(line);
}

module.exports = { run, computeSavings, realizedFromRecords, fromGateway, buildTagline, money };
