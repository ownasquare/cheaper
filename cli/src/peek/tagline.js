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
//      Cheaper spent). No "about " qualifier.
//   2. Otherwise, estimate from the chat transcript (ceiling-vs-actual). Marked with
//      an "about " qualifier before the amount (never a leading glyph like "~" or
//      "-", which reads as a minus sign next to a "$").
//   3. If nothing cheaper happened, stay honest: no "$0.00 saved" — either a plain
//      "kept on the <tier> tier" brand line, or nothing at all.
//
// Fully local + read-only. The only network touch is an optional GET to the local
// gateway on 127.0.0.1; any failure silently falls back to the transcript estimate.

const http = require('http');
const { isPriceable, costOfModel } = require('./pricing');
const { resolveModel, CATALOG_AS_OF, todayUTC } = require('./models');

// Whole days since the price catalog was transcribed from the providers' own pages.
function catalogAgeDays() {
  const a = Date.parse(CATALOG_AS_OF + 'T00:00:00Z');
  const b = Date.parse(todayUTC() + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 86400000));
}
const { HARNESSES, collectHarness, sessionStem, sessionIdFor } = require('./adapters');
const { tokens: fmtTokens } = require('./render');
const { pdayOf } = require('./periods');
const ledger = require('./ledger');
const events = require('./events');

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
//
// `at` is the date the call actually happened, so a call is priced against the rates
// that were in force THEN — a session inside a promotional window keeps the promo
// rate forever, and one after it does not. Falling back to today (rather than the
// catalog's as-of date) means a window that has expired in the real world is also
// expired here, even on a catalog that has not been refreshed.
function billingCtx(r) {
  // `pday` — the LOCAL calendar day, derived from ts + the offset in force at ts — is
  // the single time frame the whole product uses. This line used to be
  // `new Date(r.ts).toISOString().slice(0,10)`, i.e. the UTC date, while periods.js
  // bucketed on local midnight. With a dated catalog window live (claude-sonnet-5 at
  // $2/$10 through 2026-08-31), every such call after 17:00 local on the 31st on a
  // UTC-7 machine priced as September — +50% in and out — while still being reported
  // inside "This month (August)".
  const day = r.ts ? pdayOf(r.ts, r.tzo) : null;
  return { speed: r.speed || null, serviceTier: r.serviceTier || null, at: day || undefined };
}

// The basket used to RANK models against each other when picking the baseline.
//
// Fixed on purpose. Ranking on the session's own aggregate token mix would make the
// baseline depend on the very calls being credited, so adding one cache-heavy
// sub-agent could retroactively change a different sub-agent's credit.
const CEILING_BASKET = { inFresh: 1e6, cacheCreate5m: 0, cacheCreate1h: 0,
                         cacheCreate: 0, cacheRead: 0, outTok: 1e6 };

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
  let best = -1, winner = null;
  const sorted = records.slice().sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
  for (const r of sorted) {
    const c = costOfModel(idOf(r), CEILING_BASKET, { at });
    if (c != null && c > best) { best = c; winner = idOf(r); }
  }
  return winner;
}

// Realized savings for a scoped set of chat records, in DOLLARS. No tier is involved.
//
// CEILING RULE (deliberate — change this comment if you change the rule): the baseline
// is the priciest model the session's TOP-LEVEL turns ran on, ranked on CEILING_BASKET
// at the session's own date. Price, not capability: a name-derived tier ranked
// claude-fable-5 ($60 per 1M in + 1M out) BELOW claude-opus-5 ($30), and 38 such
// inversions exist in the catalog. Capability rank simply is not price rank, and only
// price can answer "did this call cost less than the alternative".
//
// Unknown/unpriceable models are skipped — never invent a saving that can't be priced.
function realizedFromRecords(records) {
  // Priceability is the ONLY gate. The old `&& modelTier(r.model)` conjunct was dead
  // code when modelTier defaulted to 'sonnet'; now that it fails closed it would have
  // silently dropped every model newer than CATALOG_AS_OF.
  // Priceability is resolved at the CALL'S OWN DAY, matching costOfModel. Resolving it
  // at today meant a promo window closing (or a catalog going stale) could blank a
  // historical figure that had already been read and acted on.
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
  const eligible = routedAware ? priced.filter((r) => r.source === 'subagent')
                               : priced.filter((r) => idOf(r) !== ceilingModel);

  const savedByModel = {}, extraByModel = {};
  let net = 0, gross = 0, extraCost = 0, wouldHave = 0;
  let tokensCredited = 0, creditedCalls = 0, offsetCalls = 0;
  let totalSpent = 0, totalTokens = 0, anyEstimated = false;

  for (const r of priced) {
    if (r.estimated) anyEstimated = true;
    totalSpent += costOfModel(r.model, tokenBreakdown(r), billingCtx(r)) || 0;
    totalTokens += (r.inTokens || 0) + (r.outTokens || 0);
  }

  for (const r of eligible) {
    const id = idOf(r);
    if (id === ceilingModel) continue;             // ran AT the baseline
    const bk = tokenBreakdown(r), ctx = billingCtx(r);
    const spent = costOfModel(r.model, bk, ctx) || 0;
    // SAME call, SAME date, SAME SKU — the only variable is the model, because the
    // model is the only thing Cheaper controls. The old code priced the baseline with
    // the CEILING RECORD's context, so a single fast-mode main-loop turn valued every
    // sub-agent's counterfactual at the 2x fast SKU.
    const baseline = costOfModel(ceilingModel, bk, ctx);
    if (baseline == null) continue;
    const d = baseline - spent;
    net += d;
    wouldHave += baseline;
    // Counted over the SAME call set as `net`. Accumulating tokens only on the
    // positive branch made the two halves of the printed sentence disagree.
    tokensCredited += (r.inTokens || 0) + (r.outTokens || 0);
    if (d > 0) { gross += d; creditedCalls++; savedByModel[id] = (savedByModel[id] || 0) + 1; }
    else if (d < 0) { extraCost += -d; offsetCalls++; extraByModel[id] = (extraByModel[id] || 0) + 1; }
  }

  return { ceilingModel, topModel, dollarsSaved: net, gross, extraCost, wouldHave,
           savedPct: wouldHave > 0 ? Math.round((net / wouldHave) * 100) : 0,
           tokensCredited, creditedCalls, offsetCalls, savedByModel, extraByModel,
           totalSpent, totalTokens, calls: priced.length,
           estimatedTokens: anyEstimated, exact: false };
}

// Same shape, from the running gateway's EXACT session-filtered metrics summary.
//
// Degrades to null rather than emitting a half-populated shape. `buildTagline` is
// shared between this path and the transcript path, so a gateway older than the
// model-named vocabulary would otherwise render "ran this chat on undefined" — and it
// would do so for exactly the users who bothered to install the gateway. Returning
// null falls back to the transcript estimate, which is merely less precise.
function fromGateway(summary) {
  if (!summary || !summary.dollars) return null;
  if (!summary.baseline_model || !summary.downgraded_by_model) return null;
  const dol = summary.dollars || {};
  const byTier = summary.by_tier || {};
  let totalTokens = 0;
  for (const t of Object.keys(byTier)) {
    totalTokens += (byTier[t].in_tokens || 0) + (byTier[t].out_tokens || 0);
  }
  return {
    ceilingModel: summary.baseline_model,
    topModel: summary.top_model || summary.baseline_model,
    dollarsSaved: dol.saved || 0,
    gross: dol.gross || 0,
    extraCost: dol.extra || 0,
    wouldHave: dol.billed_top || 0,
    savedPct: dol.savings_pct || 0,
    tokensCredited: (summary.tokens && summary.tokens.downgraded) || 0,
    creditedCalls: (summary.counts && summary.counts.models_changed) || 0,
    offsetCalls: (summary.counts && summary.counts.models_upcharged) || 0,
    savedByModel: summary.downgraded_by_model || {},
    extraByModel: summary.upcharged_by_model || {},
    totalSpent: dol.spent || 0,
    totalTokens,
    calls: summary.total || 0,
    exact: true,
  };
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
        // The gateway gates /metrics on the same-machine token. Sending it as a HEADER
        // keeps the secret out of the gateway's access log. A 401 lands in the
        // statusCode branch below and falls back to the transcript estimate — the
        // tagline degrades, it never breaks the chat's closing line.
        headers: require('../token').tokenHeaders(),
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
  const amt = (r.exact ? '' : 'about ') + money(r.totalSpent);
  const toks = fmtTokens(r.totalTokens || 0);
  return ` This session ran ${toks} tokens, worth ${tint(amt, 'spend', format)} at list API rates.`;
}

// "3 calls on claude-haiku-4-5", busiest model first, ties by id so the rendered
// sentence is stable across runs.
function modelParts(hist) {
  return Object.entries(hist || {})
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([m, n]) => `${n} call${n === 1 ? '' : 's'} on ${m}`);
}

function buildTagline(r, brand, format) {
  if (!r) return '';
  brand = brand || 'Cheaper.app';
  const spend = spendSentence(r, format);
  // Named MODELS, never tiers. "haiku tier instead of opus" was never checkable by the
  // reader and, after the catalog gained fable/mythos, was not even ordered by cost.
  const names = Object.keys(r.savedByModel || {});
  const shown = modelParts(r.savedByModel).slice(0, 3);
  if (names.length > 3) {
    const rest = names.length - 3;
    shown.push(`${rest} other model${rest === 1 ? '' : 's'}`);
  }

  const realSaving = r.dollarsSaved >= SHOW_MIN_USD && r.creditedCalls > 0 &&
    r.tokensCredited > 0 && shown.length > 0 && r.ceilingModel;
  if (realSaving) {
    const amt = (r.exact ? '' : 'about ') + money(r.dollarsSaved);
    const off = modelParts(r.extraByModel);
    // The anti-saving is NAMED, not silently netted away. A headline that has been
    // reduced by an offset the reader cannot see is a breakdown that does not
    // reconcile with the figure it claims to explain.
    const offset = off.length
      ? ` — after ${money(r.extraCost)} more on ${joinAnd(off)}`
      : '';
    return `${brand} saved ${tint(amt, 'save', format)} and ${fmtTokens(r.tokensCredited)} tokens ` +
      `by running ${joinAnd(shown)} instead of ${r.ceilingModel}${offset}, at list API rates.${spend}`;
  }

  // Routing cost MORE than the baseline would have. Say so plainly rather than
  // printing a cheerful "no saving warranted" line over a real negative.
  if (r.dollarsSaved <= -SHOW_MIN_USD && r.ceilingModel &&
      Object.keys(r.extraByModel || {}).length) {
    return `${brand} claims no saving on this chat — routed work cost ` +
      `${money(-r.dollarsSaved)} more than ${r.ceilingModel} would have.${spend}`;
  }

  // Nothing was routed cheaper: name the priciest model that actually ran.
  const kept = r.topModel || r.ceilingModel;
  if (kept) return `${brand} ran this chat on ${kept} — no routing saving to claim.${spend}`;
  return spend ? spend.trimStart() : '';   // never interpolate undefined
}

// A gateway summary is only trustworthy as an EXACT figure if the gateway is running
// the current pricing code. A process that imported an older build keeps serving its
// old logic indefinitely, and its numbers print with no "about " qualifier — so a
// stale gateway is the single worst source in the system: confidently wrong.
//
// The tell is cheap and needs no extra request: current builds report `catalog` in
// their summary. If it is missing, the gateway predates catalog-aware pricing and its
// dollar figures were computed by the code that over-reported by 50% on downgrades.
function gatewayIsCurrent(summary) {
  return !!(summary && summary.catalog && summary.catalog.priced);
}

// Append THIS session's per-call events, as a bounded DELTA.
//
// Claude Code fires Stop on every assistant turn and this path re-scans the whole
// session each time, so appending the session would write ~8,000 lines to represent 40
// events on a 200-turn chat — and compaction's dedupe input would grow quadratically in
// chat length. The cursor makes each append exact: only what is new, nothing at all
// when nothing is new, and a full rev+1 restatement when the session ceiling moves.
//
// Entirely best-effort. An audit write must never be able to break a chat's closing line.
function emitEvents(records, opts) {
  try {
    const { eventsFromRecords, assertPrivacySafe } = require('./emit');
    const def = harnessDef(opts.only || 'claude-code');
    const harness = def ? def.key : 'claude-code';
    const sessionId = def ? sessionIdFor(def, opts) : null;
    if (!sessionId) return null;
    const all = eventsFromRecords(records, { harness, sessionId, prov: 'transcript', writer: 'cli' });
    if (!all.length) return null;
    const bad = assertPrivacySafe(all);
    if (bad) {
      // Refuse the write rather than persist a path or a prompt into an append-only log
      // that cannot be un-written. Loud on stderr, silent in the hook.
      if (!process.env.CHEAPER_QUIET) console.error('cheaper: refusing to write events — ' + bad);
      return null;
    }
    const d = events.deltaFor(harness, sessionId, all);
    if (!d.emit.length) return { written: 0, reason: d.reason };
    const res = events.append(d.emit, 'cli');
    // The cursor advances ONLY after a durable append. Advancing first would silently
    // skip events whenever a write failed — the one failure mode an append-only audit
    // log must not have.
    if (res.written > 0 && d.cursor) events.writeCursor(harness, sessionId, d.cursor);
    // First write for a session also claims coverage for its span, so a period before
    // the store existed reports `not_covered` rather than $0.00.
    try {
      const store = require('./store');
      const lo = Math.min(...all.map((e) => e.ts));
      const hi = Math.max(...all.map((e) => e.ts));
      if (Number.isFinite(lo) && Number.isFinite(hi)) store.addCoverage('observed', lo, hi + 1, harness);
    } catch { /* coverage is a label, never a blocker */ }
    return Object.assign({ reason: d.reason }, res);
  } catch { return null; }
}

async function computeSavings(opts, preRecords) {
  const sid = opts.session || (opts.transcript ? sessionStem(opts.transcript) : null);
  if (sid) {
    const summary = await fetchGatewaySession(sid);
    if (summary && !gatewayIsCurrent(summary)) {
      // Prefer the transcript estimate — which is at least computed by THIS build and
      // is honestly marked "about" — over an unhedged number from unknown-age code.
      if (!process.env.CHEAPER_QUIET) {
        console.error('cheaper: gateway is running an older build; using the local '
          + 'estimate instead. Fix with: cheaper gateway restart');
      }
    } else {
      const g = summary && fromGateway(summary);
      if (g && g.dollarsSaved >= SHOW_MIN_USD) return g; // exact, real — no "about " qualifier
    }
  }
  const records = preRecords || collectSessionRecords(opts).records;
  return realizedFromRecords(records); // may be null
}

// opts: { session, current, transcript, only, sinceDays, json }
// The all-time running total, appended after the per-chat line so the value Cheaper
// has delivered is visible at the end of EVERY chat — including a no-routing chat,
// where the per-chat line is just the "kept on the <tier> tier" brand line. Shown
// only once the lifetime total is a real amount (>= 1c and some tokens). Marked with
// an "about " qualifier unless every contributing chat's figure came from the exact
// gateway numbers.
// Suppressed when the running total is not a positive amount. Chats can now contribute
// a NEGATIVE figure (routed work that cost more than the baseline), so the total can
// legitimately sit at or below zero — and "Lifetime savings: -$3.10" is not a sentence
// worth printing. Saying nothing is honest; floor-at-zero would overstate.
function lifetimeSentence(tot, format) {
  if (!tot || !(tot.usd >= SHOW_MIN_USD) || !(tot.tokens > 0)) return '';
  const amt = (tot.exact ? '' : 'about ') + money(tot.usd);
  return ` Lifetime savings: ${tint(amt, 'save', format)} and ${fmtTokens(tot.tokens)} tokens.`;
}

async function run(opts = {}) {
  const o = Array.isArray(opts) ? { current: true } : (opts || {});
  // Collect ONCE and reuse. The transcript walk is the expensive part of the Stop hook
  // (the storage append is 4.4 ms; the scan is not), so scanning twice — once to price
  // and once to emit — would double the hook's cost against a 15 s SIGTERM budget.
  const { records } = collectSessionRecords(o);
  const result = await computeSavings(o, records);
  const emitted = emitEvents(records, o);
  const line = buildTagline(result, brandFor(o.format), o.format);
  // Record THIS chat's realized saving in the lifetime ledger, keyed by session id so
  // repeated runs for the same chat overwrite (never double-count), then read back the
  // running total. Fully best-effort: a ledger failure must never drop the base line.
  let tot = null;
  try {
    const def = harnessDef(o.only || 'claude-code');
    const key = def ? sessionIdFor(def, o) : null;
    // The chat's REAL timespan, so a legacy row buckets on when the work happened
    // rather than on when this line printed.
    let firstTs = Infinity; let lastTs = -Infinity;
    for (const r of records || []) {
      const t = Number(r.ts);
      if (!Number.isFinite(t) || !t) continue;
      if (t < firstTs) firstTs = t;
      if (t > lastTs) lastTs = t;
    }
    const span = Number.isFinite(firstTs) && Number.isFinite(lastTs) && lastTs >= firstTs
      ? { firstTs, lastTs } : null;
    tot = ledger.record(key, (result && result.dollarsSaved) || 0,
      (result && result.tokensCredited) || 0, !!(result && result.exact), span);
  } catch { tot = null; }
  const lifetime = lifetimeSentence(tot, o.format);
  let out = line ? line + lifetime : lifetime.trimStart();
  // A "See logs" link to the local dashboard at the very end of every rendered line.
  if (out) out += logsSuffix(o.format, dashboardUrl(o));
  if (o.json) {
    console.log(JSON.stringify({
      // Provenance ships WITH the numbers. A rate stale by months is otherwise
      // byte-indistinguishable from one verified this morning, which is precisely
      // how a retired Opus price survived long enough to overstate by 2.74x.
      catalog: { as_of: CATALOG_AS_OF, age_days: catalogAgeDays() },
      line,                 // the per-chat line only (unchanged meaning)
      full: out,            // per-chat line + lifetime sentence — what actually prints
      lifetime: tot || null,
      source: result ? (result.exact ? 'gateway' : 'estimate') : 'none',
      // What the per-call store actually wrote this run. `written: 0` with
      // `reason: 'no-op'` is the healthy steady state on a long chat, not a failure.
      events: emitted || null,
      result: result || null,
    }, null, 2));
    return;
  }
  if (out) console.log(out);
}

module.exports = { run, computeSavings, realizedFromRecords, fromGateway, buildTagline, money,
                   gatewayIsCurrent };
