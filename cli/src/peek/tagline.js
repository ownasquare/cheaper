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
// Whether a call's COUNTERFACTUAL arm has a recoverable prompt-cache state. The rule
// itself lives in derive.js (see the long note there); counterfactual.js adapts it from
// the stored row's field vocabulary (cr/c5/c1/cu, canonical served/base) to the
// transcript record's (cacheRead/cacheCreate5m/cacheCreate1h/cacheCreate, raw model), so
// ONE implementation decides for both the append-only store and the line printed at the
// end of the chat. Adopting it here is what stops those two from publishing different
// money for the same chat. No require cycle: neither derive.js nor counterfactual.js
// imports this module.
const { recordCacheStateIndeterminate } = require('./counterfactual');

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
  //
  // THE FALLBACK IS A COST DIFFERENCE, NOT AN ATTRIBUTION. "every call not on the baseline
  // model" says nothing about WHO picked those models. Codex records are hardcoded
  // source:'user' (adapters.js::collectCodex), so the fallback fires on every Codex session
  // there has ever been, and buildTagline then rendered past-tense credit — "saved … by
  // running X instead of Y" — for a chat in which Cheaper routed nothing at all. The
  // eligible set is still the right set of rows to price; `routedAware` travels out with the
  // result so the RENDERER can state the difference without claiming the cause.
  const routedAware = priced.some((r) => r.source === 'subagent');
  const eligible = routedAware ? priced.filter((r) => r.source === 'subagent')
                               : priced.filter((r) => idOf(r) !== ceilingModel);

  const savedByModel = {}, extraByModel = {};
  let net = 0, gross = 0, extraCost = 0, wouldHave = 0;
  let tokensCredited = 0, creditedCalls = 0, offsetCalls = 0;
  let totalSpent = 0, totalTokens = 0, anyEstimated = false;
  // Eligible rows whose counterfactual was WITHHELD, not measured. Counted so the
  // rendered line can state the exclusion instead of quietly shipping a smaller total
  // (invariants 4 and 7: a "report nothing" case returns a labelled non-number, and the
  // label has to reach the reader).
  let withheldCalls = 0, withheldTokens = 0;

  for (const r of priced) {
    if (r.estimated) anyEstimated = true;
    totalSpent += costOfModel(r.model, tokenBreakdown(r), billingCtx(r)) || 0;
    totalTokens += (r.inTokens || 0) + (r.outTokens || 0);
  }

  for (const r of eligible) {
    const id = idOf(r);
    if (id === ceilingModel) continue;             // ran AT the baseline
    // A COLD-START call on a SWITCHED model has no recoverable counterfactual cache
    // state, and therefore no honest baseline. A prompt cache is keyed on (model, exact
    // prefix), so switching model invalidates it: the served arm paid a cache CREATE for
    // a prefix the un-switched baseline may well have merely READ, and the single `bk`
    // below prices BOTH legs off the served split — charging the baseline CREATE too.
    // Every catalog entry writes at or above its read rate, so that substitution can only
    // move the baseline UP and the claimed saving with it. Nothing in the record separates
    // "the prefix was new to the session" (figure correct) from "the switch forced the
    // rewrite" (figure overstated by the whole write-read spread), so the honest
    // counterfactual is an interval that straddles zero — see derive.js.
    //
    // WITHHELD, never zeroed. Booking it as 0 asserts the saving was nothing; skipping it
    // says the saving is unknowable, and those are different sentences. The row makes no
    // claim, contributes to NO dollar or token accumulator, and is counted below so
    // populationNote can say what was left out.
    //
    // A row that did not switch cannot reach this branch (served === base returns false),
    // so a chat with no model switch is unchanged to the cent. A WARM switched row
    // (cacheRead > 0) also returns false and KEEPS its credit: its CREATE is content
    // appended since the previous turn, which the baseline model would have had to write
    // as well, so the served split IS the counterfactual split there. Over-correcting
    // those is the mirror-image fabrication.
    if (recordCacheStateIndeterminate(r, id, ceilingModel)) {
      withheldCalls++;
      withheldTokens += (r.inTokens || 0) + (r.outTokens || 0);
      continue;
    }
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

  // Both halves of spendSentence are accumulated over `priced` above, so they agree with
  // each other — but the records dropped by the isPriceable filter are real calls the
  // session made, and a sentence that says "this session ran N tokens" while N excludes
  // them is understating the session. Publish the coverage so it can be stated.
  const examined = (records || []).length;
  return { ceilingModel, topModel, dollarsSaved: net, gross, extraCost, wouldHave,
           // Established, not assumed: true ONLY when this chat carried rows tagged as
           // sub-agent work, which is the sole transcript evidence that a model choice was
           // delegated rather than made by the harness itself.
           routingAttributed: routedAware,
           savedPct: wouldHave > 0 ? Math.round((net / wouldHave) * 100) : 0,
           tokensCredited, creditedCalls, offsetCalls, savedByModel, extraByModel,
           totalSpent, totalTokens, calls: priced.length,
           // `withheld` is deliberately NOT folded into `unpriced`. These rows ARE
           // priceable and their SPENT leg is a fact that still counts toward totalSpent —
           // it is only their counterfactual that was declined. Merging the two counts
           // would tell the reader their spend figure excludes rows it actually includes.
           population: { tokensFrom: 'priced', examined, priced: priced.length,
                         unpriced: examined - priced.length, total: examined,
                         truncated: false,
                         withheld: withheldCalls, withheldTokens },
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
  // WHICH ROWS EACH FIGURE COVERS. `by_tier` is an unbounded GROUP BY over every row in
  // the session; `dollars.spent` covers only counts.priced of them. Carrying the counts
  // here is what lets spendSentence label a sentence whose two halves are populations of
  // different sizes instead of silently juxtaposing them (see populationNote).
  const cts = summary.counts || {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const population = {
    tokensFrom: 'all',            // by_tier counts every row, priced or not
    examined: num(cts.examined),
    priced: num(cts.priced),
    unpriced: num(cts.unpriced_total),
    total: num(summary.total),
    truncated: !!cts.truncated,
    // The SAME withholding the transcript path applies, read from the per-reason
    // breakdown metrics.py already publishes (`counts.unpriced.cache_state_indeterminate`).
    // Here these rows sit INSIDE counts.unpriced_total — the gateway declines their spent
    // leg too — so the note names the reason without re-counting them as a second
    // exclusion. A gateway too old to publish the key yields null and prints nothing,
    // exactly as before.
    withheld: num((cts.unpriced || {}).cache_state_indeterminate),
  };
  return {
    population,
    // The gateway is the routing decision. Its `downgraded_by_model` counts rows where the
    // model SERVED differed from the model REQUESTED — a substitution only the gateway can
    // have performed — so credit here is measured, not inferred from a model mix.
    routingAttributed: true,
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

// HOW THE GATEWAY PROBE ENDED — five facts that must never collapse into one.
//
// This used to resolve a bare `null` for every non-answer, so "nothing is listening on
// that port", "it answered but rejected our token", "it was too slow" and "we never asked"
// were byte-identical to the caller. That single conflation is what let an UNREACHABLE
// gateway print a savings line AND a dashboard link with no warning at all, while a merely
// STALE one — the strictly less broken case — got an explicit warning.
//
// NOT_PROBED is the one that matters most: it is not evidence the gateway is down, so it
// must never produce the "not reachable" notice, and it is not evidence the gateway is up,
// so it must not produce the "See logs" link either. TIMEOUT is the same shape of unknown:
// a gateway busy for longer than the budget is alive, and telling that user to run
// `cheaper gateway start` would be advice for a problem they do not have.
const PROBE = {
  NOT_PROBED: 'not-probed',   // no session id — the request was never made at all
  ANSWERED: 'answered',       // HTTP 200 with a parseable JSON summary
  REJECTED: 'rejected',       // a listener answered with a non-200 (401 = wrong/absent token)
  MALFORMED: 'malformed',     // a listener answered 200 with a body we could not parse
  TIMEOUT: 'timeout',         // no answer inside the budget — alive-but-slow is indistinguishable
  UNREACHABLE: 'unreachable', // socket error (ECONNREFUSED) — nothing is serving that port
  // A LIVENESS check answered, and NO metrics request was ever made. Deliberately its own
  // outcome rather than reuse of ANSWERED: every other consumer reads ANSWERED as "a summary
  // came back", and there is no summary here. It proves exactly one thing — something is
  // serving HTTP on the port — which is the whole of the claim the "See logs" link makes.
  LIVE: 'live',
};

// Something spoke HTTP on the port. Deliberately WEAKER than ANSWERED: a 401, or a body we
// could not parse, still proves a live listener, and that is the entire claim the "See logs"
// link makes — that the page resolves, not that /metrics was readable. Requiring ANSWERED
// here would hide the dashboard from exactly the users whose gateway is up but whose token
// file is stale, which is the population most in need of it.
function gatewayIsListening(outcome) {
  return outcome === PROBE.ANSWERED || outcome === PROBE.REJECTED
      || outcome === PROBE.MALFORMED || outcome === PROBE.LIVE;
}

// One reader for the port, so a notice, a link and a request can never name different ones.
//
// It resolves through freshness.activeGatewayPort() — pid file, then the autostart record,
// then CHEAPER_PORT, then 8787 — rather than reading the environment here. THIS line is the
// one place a false alarm is guaranteed to be read: it prints at the end of every chat.
// Hardcoding the default made gatewayFallbackNotice tell a user whose gateway is healthy on
// 8788 (where autostart.pickPort() moves it whenever 8787 is busy, without their shell ever
// hearing about it) that no gateway was reachable and that they should start one — on every
// single chat, forever. Required lazily so the Stop hook pays for it only when a tagline is
// actually being built.
function gatewayPort() { return require('../freshness').activeGatewayPort(); }

// Best-effort GET to the local gateway for exact, session-scoped metrics. Resolves to
// `{ summary, outcome, status, timeoutMs }` — never throws, never rejects. `summary` is the
// parsed body or null exactly as before; `outcome` is the PROBE fact the caller needs to
// tell "measured" from "unmeasured" from "unknown". Short timeout so a stopped gateway (the
// common case) costs us almost nothing before we fall back to the estimate.
function fetchGatewaySession(sessionId, timeoutMs = 600) {
  return new Promise((resolve) => {
    const port = gatewayPort();
    let done = false;
    const finish = (summary, outcome, status) => {
      if (!done) { done = true; resolve({ summary, outcome, status: status || null, timeoutMs }); }
    };
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
        if (res.statusCode !== 200) { res.resume(); return finish(null, PROBE.REJECTED, res.statusCode); }
        let data = '';
        res.on('data', (d) => { data += d; if (data.length > 4e6) req.destroy(); });
        res.on('end', () => {
          // A 200 we cannot parse is NOT the same as no gateway: something is serving the
          // port. Reporting it as UNREACHABLE would print "start it with: cheaper gateway
          // start" at a process that is already running.
          try { finish(JSON.parse(data), PROBE.ANSWERED, 200); }
          catch { finish(null, PROBE.MALFORMED, 200); }
        });
      });
      req.on('error', () => finish(null, PROBE.UNREACHABLE));
      req.on('timeout', () => { req.destroy(); finish(null, PROBE.TIMEOUT); });
    } catch { finish(null, PROBE.UNREACHABLE); }
  });
}

// LIVENESS ONLY, and ONLY for the path on which no metrics request is made at all.
//
// dashboardUrl() reuses the session probe on purpose (see its comment): issuing a second GET
// there would double the tagline's only network cost on a Stop hook running against a 15 s
// budget. That reasoning holds whenever a session probe EXISTS. It does not cover the case
// where there is none: with neither --session nor --transcript, `sid` is null, computeSavings
// issues nothing, the outcome stays NOT_PROBED, and the link is suppressed against a gateway
// that is demonstrably up — a hand-run `cheaper peek --tagline` hid a dashboard answering on
// the same port in the same second. The INVOCATION STYLE was deciding whether a working link
// printed, which is not a fact about the gateway.
//
// So this fires only on that path, where it replaces zero requests with one rather than
// doubling anything. It asks /healthz — unauthenticated, cheaper than /metrics, and it can
// never 401 — and never reads the body. Any HTTP answer counts, non-200 included: that is the
// same deliberately-weak rule gatewayIsListening() already applies to REJECTED, because the
// link claims the page resolves, not that /metrics was readable.
function probeGatewayLiveness(timeoutMs = 600) {
  return new Promise((resolve) => {
    const port = gatewayPort();
    let done = false;
    const finish = (outcome, status) => {
      if (!done) { done = true; resolve({ outcome, status: status || null, timeoutMs }); }
    };
    try {
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs },
        (res) => { res.resume(); finish(PROBE.LIVE, res.statusCode); });
      req.on('error', () => finish(PROBE.UNREACHABLE));
      req.on('timeout', () => { req.destroy(); finish(PROBE.TIMEOUT); });
    } catch { finish(PROBE.UNREACHABLE); }
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
//
// PRINTED ONLY WHEN SOMETHING IS ACTUALLY LISTENING. This used to return the localhost URL
// unconditionally, and logsSuffix appended it guarded only by `if (!url)` — i.e. guarded by
// nothing, since the string was a constant that could not be falsy. Nothing anywhere checked
// the gateway was up. That is the user's bug report verbatim: the product printed a link,
// they clicked it, and the browser said ERR_CONNECTION_REFUSED.
//
// The gate REUSES the probe computeSavings already performed. Issuing a second GET here
// would double the tagline's only network cost, on a Stop hook that runs on every assistant
// turn against a 15 s SIGTERM budget — and would still be racing the same gateway.
//
// An operator-declared URL (opts.logsUrl / CHEAPER_DASHBOARD_URL) is exempt: it may name a
// host this probe never touched, so gating it on 127.0.0.1:CHEAPER_PORT would suppress a
// link that works. That URL is the operator's assertion; the localhost default is OUR
// assumption, and only our assumption needs evidence.
function dashboardUrl(o, probe) {
  const declared = (o && o.logsUrl) || process.env.CHEAPER_DASHBOARD_URL;
  if (declared) return declared;
  // NOT_PROBED and TIMEOUT land here too: "we could not determine" prints no link, because
  // a link is a claim that the page resolves and we have no evidence that it does.
  if (!gatewayIsListening(probe && probe.outcome)) return '';
  return `http://localhost:${gatewayPort()}/dashboard`;
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
//
// COVERAGE TRAVELS WITH THE SENTENCE. The two halves of this sentence do not always
// describe the same rows, and pairing them without saying so is invariant 1 (never
// combine figures from two populations — a reader reconciles "N tokens" against "$X" and
// gets a per-token rate that is true of neither).
//   - GATEWAY path: `totalTokens` is summed from summary.by_tier, which metrics.py builds
//     with an unbounded `GROUP BY tier` over EVERY row in the session, while
//     `totalSpent` is dollars.spent, which covers only rows whose BOTH legs priced
//     (2xx, datable, catalogued). So the token half can legitimately be larger.
//   - TRANSCRIPT path: both halves are computed over the priceable subset, so they agree
//     with each other — but they then UNDER-state a session that contained uncatalogued
//     models, because those records were filtered out before either was accumulated.
// Either way the honest fix is to state which rows the figures cover; `r.population`
// carries the counts the summary already publishes (counts.examined / counts.priced /
// counts.unpriced_total / counts.truncated) and populationNote renders them.
//
// COVERAGE ALSO COVERS WHAT WAS DECLINED, not only what could not be read. A cold-start
// call on a switched model is fully priceable and is still excluded from the saving,
// because switching model invalidates the prompt cache and leaves the un-switched arm's
// cache state unrecoverable (derive.js::cacheStateIndeterminate). Shipping a headline
// quietly reduced by those rows would be the same concealment in the other direction: the
// reader sees a smaller number and no reason for it. `p.withheld` is that count, and it is
// a claims statement, not a coverage population — it deliberately says nothing about
// whether those rows sit inside `priced`, because the two paths differ on that (the
// transcript path still counts their SPENT leg; the gateway's summary does not).
function populationNote(r) {
  const p = r && r.population;
  if (!p) return '';
  const ex = Number(p.examined);
  const un = Number(p.unpriced);
  const bits = [];
  if (Number.isFinite(ex) && ex > 0 && Number.isFinite(un) && un > 0) {
    const priced = ex - un;
    bits.push(p.tokensFrom === 'all'
      ? `the token count covers all ${ex} calls, the dollar figure only the ${priced} that could be priced`
      : `both figures cover only the ${priced} of ${ex} calls that could be priced`);
  }
  const wh = Number(p.withheld);
  if (Number.isFinite(wh) && wh > 0) {
    bits.push(`${wh} switched call${wh === 1 ? '' : 's'} claim${wh === 1 ? 's' : ''} no saving`
      + ' — a cold prompt cache leaves the un-switched baseline indeterminate');
  }
  const total = Number(p.total);
  if (p.truncated && Number.isFinite(ex) && Number.isFinite(total) && total > ex) {
    bits.push(`this is the newest ${ex} of ${total} calls`);
  }
  return bits.length ? ` Coverage: ${joinAnd(bits)}.` : '';
}

function spendSentence(r, format) {
  if (!r || !(r.totalSpent >= SHOW_MIN_USD)) return '';
  const amt = (r.exact ? '' : 'about ') + money(r.totalSpent);
  const toks = fmtTokens(r.totalTokens || 0);
  return ` This session ran ${toks} tokens, worth ${tint(amt, 'spend', format)} at list API rates.`
    + populationNote(r);
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

  // DID ANYTHING ESTABLISH THAT *CHEAPER* CHOSE THESE MODELS? The dollar figure is a
  // difference between two model prices and is true either way; "Cheaper.app saved" is a
  // claim about causation, and only a producer that checked can support it.
  //
  // FAILS CLOSED. Absent field means the producer did not establish attribution, and an
  // unestablished cause must not render as an established one — the same rule the rest of
  // this file applies to unpriceable rows and withheld counterfactuals. Both producers in
  // this module set the field explicitly (realizedFromRecords from `routedAware`, fromGateway
  // from the fact that a substitution is what it measures), so `undefined` can only reach
  // here from a shape nobody vouched for.
  const attributed = r.routingAttributed === true;

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
    if (attributed) {
      return `${brand} saved ${tint(amt, 'save', format)} and ${fmtTokens(r.tokensCredited)} tokens ` +
        `by running ${joinAnd(shown)} instead of ${r.ceilingModel}${offset}, at list API rates.${spend}`;
    }
    // SAME NUMBER, NO CREDIT. Dropping the figure would be its own dishonesty — the cost
    // difference is real and the reader is entitled to it. What changes is the verb: the
    // sentence describes the session's model mix in the past tense and states, in the line
    // itself, that nothing here ties that mix to Cheaper. "saved … by running" is removed
    // entirely rather than hedged, because a hedge next to a brand name still reads as a
    // claim.
    return `${brand}: this chat ran ${joinAnd(shown)} against a ceiling of ${r.ceilingModel} — ` +
      `${tint(amt, 'save', format)} and ${fmtTokens(r.tokensCredited)} tokens under what ` +
      `${r.ceilingModel} would have cost for that work${offset}, at list API rates. ` +
      `No call in this chat is tagged as routed work, so Cheaper claims no credit for it.${spend}`;
  }

  // Routing cost MORE than the baseline would have. Say so plainly rather than
  // printing a cheerful "no saving warranted" line over a real negative.
  if (r.dollarsSaved <= -SHOW_MIN_USD && r.ceilingModel &&
      Object.keys(r.extraByModel || {}).length) {
    // The mirror image of the credit problem: unattributed, "routed work cost $X more" blames
    // Cheaper for a model the harness picked. Wrong in the user's favour is still wrong, and
    // the same evidence is missing, so the same noun phrase has to go.
    const blamed = attributed ? 'routed work' : 'the models this chat used';
    return `${brand} claims no saving on this chat — ${blamed} cost ` +
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

// The stderr notice that must accompany a fallback to the transcript estimate.
//
// SYMMETRY IS THE WHOLE POINT. A gateway on an OLDER BUILD already warned here; an
// UNREACHABLE one said nothing at all — so the one case where routing definitively did NOT
// happen was also the only case with no warning, and the user read "Cheaper.app saved $12"
// off a dead gateway and reasonably concluded routing was working. Same channel, same
// CHEAPER_QUIET gate, same "here is the fix" shape as the stale-build warning.
//
// Three sentences for three different facts, because one "not reachable" would misdiagnose
// two of them: a refused socket is proof nothing is serving the port, a timeout is not
// (alive-and-slow looks identical from here), and a non-200 is a live gateway we were not
// allowed to read — telling that user to run `gateway start` sends them after a process that
// is already running. ANSWERED, LIVE and NOT_PROBED return '': the first two have nothing to
// report, and the last never asked and must not imply it did. LIVE in particular is a gateway
// we confirmed is UP without requesting metrics — there is no fallback to explain.
function gatewayFallbackNotice(probe) {
  const at = ':' + gatewayPort();
  const tail = ' — this figure is a local estimate, not measured routing.';
  switch (probe && probe.outcome) {
    case PROBE.UNREACHABLE:
      return `cheaper: gateway not reachable on ${at}${tail} Start it with: cheaper gateway start`;
    case PROBE.TIMEOUT:
      return `cheaper: gateway on ${at} did not answer within ${probe.timeoutMs} ms${tail}`;
    case PROBE.REJECTED:
      return `cheaper: gateway on ${at} answered HTTP ${probe.status}, so its measurements `
        + `could not be read${tail} Fix with: cheaper gateway restart`;
    case PROBE.MALFORMED:
      return `cheaper: gateway on ${at} answered with a body this build could not parse${tail}`
        + ' Fix with: cheaper gateway restart';
    default:
      return '';
  }
}

// `probeOut`, when supplied, receives HOW the gateway probe ended. An out-parameter rather
// than a wrapped return value because computeSavings' return shape is this module's public
// contract (buildTagline, the ledger and --json all read it), and rather than a second GET
// from run() because that is precisely the duplicated request the "See logs" gate must not
// cost.
async function computeSavings(opts, preRecords, probeOut) {
  const sid = opts.session || (opts.transcript ? sessionStem(opts.transcript) : null);
  // Seeded BEFORE any early return, so a caller can never read an absent or stale probe as
  // "answered". No session id means the request was never made — neither evidence the
  // gateway is up nor evidence it is down.
  const probe = { outcome: PROBE.NOT_PROBED, status: null, timeoutMs: null, port: gatewayPort() };
  if (probeOut) Object.assign(probeOut, probe);
  if (!sid && probeOut) {
    // No session id, so no metrics request will be made and the "See logs" gate has nothing
    // to reuse. Establish liveness on its own — but as an UPGRADE ONLY. A failed liveness
    // check leaves the outcome at NOT_PROBED rather than becoming UNREACHABLE/TIMEOUT,
    // because gatewayFallbackNotice() exists to explain why the MEASUREMENT fell back to the
    // estimate, and on this path no measurement was ever attempted. Reporting "gateway not
    // reachable — this figure is a local estimate, not measured routing" here would answer a
    // question nobody asked, and P0.1 pinned that silence deliberately. Guarded on probeOut
    // so a caller that does not want the probe still pays nothing.
    const live = await probeGatewayLiveness();
    if (gatewayIsListening(live.outcome)) {
      probe.outcome = live.outcome;
      probe.status = live.status;
      probe.timeoutMs = live.timeoutMs;
      Object.assign(probeOut, probe);
    }
  }
  if (sid) {
    const probed = await fetchGatewaySession(sid);
    probe.outcome = probed.outcome;
    probe.status = probed.status;
    probe.timeoutMs = probed.timeoutMs;
    if (probeOut) Object.assign(probeOut, probe);
    const summary = probed.summary;
    if (summary && !gatewayIsCurrent(summary)) {
      // Prefer the transcript estimate — which is at least computed by THIS build and
      // is honestly marked "about" — over an unhedged number from unknown-age code.
      if (!process.env.CHEAPER_QUIET) {
        console.error('cheaper: gateway is running an older build; using the local '
          + 'estimate instead. Fix with: cheaper gateway restart');
      }
    } else {
      const g = summary && fromGateway(summary);
      // ELECT THE SOURCE ON AVAILABILITY, NEVER ON THE VALUE IT RETURNED.
      //
      // This used to be `if (g && g.dollarsSaved >= SHOW_MIN_USD) return g`, which made
      // the choice of measurement a MAX-SELECTION over two sources with two different
      // baselines (the gateway compares each call to the model that call requested; the
      // transcript compares it to the session's priciest top-level model). Any gateway
      // answer that was not a comfortably positive saving fell through to the transcript
      // estimate, which normally returns a positive number, so:
      //   - a measured NEGATIVE (routing genuinely cost more) printed as a saving, and
      //     buildTagline's anti-saving branch was unreachable from the gateway path;
      //   - a measured $0.00 with rows present — the commoner case: the gateway watched
      //     the chat and NOTHING was routed — was replaced by a transcript-estimated
      //     claim about routing that demonstrably did not happen;
      //   - run() then wrote that substituted figure into the lifetime ledger, so the
      //     loss never reached the all-time total either.
      // Returning unconditionally cannot print an empty-gateway zero: fromGateway()
      // already requires `dollars` AND `baseline_model` (see its guard), and
      // baseline_model is only ever set from a PRICED row, so a session-filtered summary
      // with no rows — or with no priceable rows — yields null and falls through here.
      if (g) return g; // exact, real, and SIGNED — no "about " qualifier
    }
    // Reached only when the gateway did NOT supply the number below. Silent for ANSWERED
    // (the stale-build branch above has already spoken, or the summary simply had no
    // priceable row for this chat — a live gateway that watched the chat and found nothing
    // to price is not a routing failure to warn about).
    const notice = gatewayFallbackNotice(probe);
    if (notice && !process.env.CHEAPER_QUIET) console.error(notice);
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
  // ONE probe, two consumers: computeSavings elects the number from it, and the "See logs"
  // link is gated on it. A second GET here would double the tagline's network cost for a
  // fact the first request already established.
  const probe = {};
  const result = await computeSavings(o, records, probe);
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
  // A "See logs" link to the local dashboard at the end of every rendered line — but only
  // when the probe found something listening. An unreachable gateway now prints no link
  // rather than one that resolves to ERR_CONNECTION_REFUSED.
  if (out) out += logsSuffix(o.format, dashboardUrl(o, probe));
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
      // WHY the source is what it is, machine-readably. `source: 'estimate'` alone cannot
      // distinguish "the gateway measured nothing worth reporting" from "the gateway is
      // dead", and that ambiguity is what let a dead gateway read as a working one.
      gateway: { probe: probe.outcome, port: probe.port, status: probe.status,
                 listening: gatewayIsListening(probe.outcome) },
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
                   gatewayIsCurrent,
                   // Exported so the probe's five outcomes can be asserted on directly. A
                   // notice that fires for the wrong outcome sends a user after the wrong
                   // fix, and that is not visible from the rendered line at all.
                   PROBE, gatewayIsListening, gatewayFallbackNotice, dashboardUrl,
                   probeGatewayLiveness };
