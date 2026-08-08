'use strict';
// The peek engine. Walks each harness's history, classifies every model call the
// SAME way the live gateway would, prices it, and rolls up how many tokens and
// real dollars adaptive routing would have saved — with the never-upgrade ceiling
// already applied by pricing.estimateCall.
//
// WHAT THE DOLLAR FIGURES DO NOT COVER IS PART OF THE REPORT. A call whose model is
// not in the price catalog contributes 0.0 to every dollar accumulator — arithmetically
// harmless, and for that exact reason invisible. It still incremented `calls`, so a
// history made mostly of uncatalogued models produced a small, confident, complete-
// looking number over a handful of rows. `unpriced` / `unpricedTokens` / `unpricedRatio`
// now travel with the money so a consumer can say how much of the work the money
// describes (invariant 4: an exclusion must be labelled and counted, never a bare $0).
//
// A SECOND EXCLUSION, WITH A DIFFERENT REMEDY. `unpriced` means "we hold no published
// rate for this model". It is not the only reason a row's dollars fail to be a saving the
// user can bank. The gateway rewrites `body["model"]` on exactly two endpoints —
// /v1/messages (Anthropic) and /v1/chat/completions (OpenAI) — so a row from any other
// vendor has a perfectly well-priced counterfactual that no configuration of today's
// gateway can realise. MEASURED: 28 of 75 catalog ids (37.3%) and 4 of ROUTE_TARGET's 6
// families are in that position (see pricing.js::ROUTABLE_FAMILIES).
//
// The two exclusions must not be merged: "catalog a price for this model" and "ship a
// Gemini endpoint" are different pieces of work, and one blended number describes
// neither. So the money splits in two:
//
//   dollarsSaved / dollarsGross / dollarsExtra / downgradable / examples
//       REALIZABLE TODAY — the headline. Routable vendors only.
//   the matching *Unroutable fields
//       the same arithmetic over vendors with no gateway endpoint, reported in full under
//       its own name and kept OUT of the headline. It is a real counterfactual about real
//       published rates; it is simply not a saving anyone can bank this week.
//
// NOTHING IS CLAMPED BY THIS SPLIT. Every unroutable row keeps its signed delta and its
// gross/extra decomposition — it is MOVED, not zeroed. The only thing that changes is
// which bucket a consumer must name in order to claim it.
//
// AND WHICH ROUTER? See `opts.router` on scan() below: the estimate is only as good as
// its model of the gateway's CONFIGURATION, and the gateway can be asked.

const { contentTier, TIERS, modelTier, effectiveTier } = require('./classify');
const { estimateCall } = require('./pricing');
const { HARNESSES, collectHarness, isInstalled } = require('./adapters');
// `pday` — the LOCAL calendar day derived from a record's ts — is the single time frame
// the whole product uses (periods.js). It is what a historical call's ACTUAL cost is
// priced at; see the date note on pricing.js::estimateCall.
const { pdayOf } = require('./periods');

// --- Time/token model — MUST mirror gateway/app/metrics.py verbatim (values only,
// no logic drift). Historical chat logs carry no reasoning-effort field, so the
// reasoning-savings potential here is inferred from a reasoning-model signal
// instead of a recorded effort level (see REASONING_RE below).
const LAT_TIER = { haiku: 1.2, sonnet: 3.0, opus: 7.0 };
const LAT_EFFORT = { none: 0.0, low: 1.5, medium: 6.0, high: 18.0 };
const THINK_TOKENS = { none: 0, low: 600, medium: 2500, high: 8000 };
const EFFORT_RANK = { none: 0, low: 1, medium: 2, high: 3 };
// Reasoning-model signal on the model id actually used (no effort field in history).
const REASONING_RE = /(\bo1\b|\bo3\b|\bo4\b|reasoner|thinking|deepseek-r1|\bqwq\b)/i;

// One-line, secret-safe snippet of a user prompt for the "examples" list: collapse
// whitespace, mask token-like blobs, truncate. `text` is already user-authored only.
function snippet(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/\b[A-Za-z0-9_\-]{28,}\b/g, '…'); // mask key/token-ish blobs
  return s.length > 90 ? s.slice(0, 89) + '…' : s;
}

function emptyTierMap() { const o = {}; for (const t of TIERS) o[t] = 0; return o; }

function scanHarness(def, opts) {
  const { records, filesScanned, note } = collectHarness(def, opts);
  let installed = false;
  try { installed = isInstalled(def); } catch { installed = false; }
  const out = {
    key: def.key, label: def.label, status: def.status, installed,
    filesScanned: filesScanned || 0, note: note || '',
    calls: 0, downgradable: 0, estimatedCalls: 0,
    // Calls DELIBERATELY excluded from every dollar figure because the catalog holds no
    // published rate for the model. Counted so the exclusion is VISIBLE (invariant 4):
    // adding 0.0 corrupts no total, but a report whose denominator has silently shrunk
    // to two catalogued calls out of two hundred reads exactly like a confident small
    // number. `unpriced === calls` means the dollars below describe NOTHING.
    unpriced: 0, unpricedTokens: 0,
    tokens: 0, tokensOnDowngradable: 0,
    // dollarsActual: HISTORICAL — each call at the rates in force on its own day.
    // dollarsBaseline: the same calls at TODAY's rates; the left leg of the prospective
    // counterfactual and the only frame-consistent denominator for savedPct.
    // dollarsSaved: SIGNED net (gross - extra), decomposed alongside it so a net that
    // has been reduced by an anti-saving can still be explained.
    //
    // dollarsActual / dollarsBaseline span EVERY priceable row, routable or not, because
    // they are facts about what was and would be SPENT — the user really did pay for
    // their Gemini calls, and a bill that omitted them would be wrong. Only the SAVING is
    // restricted to what the gateway can actually route.
    dollarsActual: 0, dollarsBaseline: 0, dollarsSaved: 0,
    dollarsGross: 0, dollarsExtra: 0, offsetCalls: 0,
    // The today-priced baseline of the ROUTABLE rows alone — the frame-consistent
    // denominator for "how much of the bill Cheaper can address did it address". Distinct
    // from dollarsBaseline, which is the whole bill and is what savedPct divides by so
    // that "% off" stays a claim about the user's ACTUAL bill rather than about the
    // fraction of it we happen to be able to route.
    dollarsBaselineRoutable: 0,
    // --- "would require a <vendor> endpoint" ---------------------------------
    // A priceable row whose vendor the gateway has no rewriting endpoint for. Counted,
    // never discarded: the counterfactual is real, it is just not bankable today, and an
    // exclusion that leaves no trace is the exact failure `unpriced` was added to fix.
    unroutableCalls: 0, unroutableTokens: 0,
    downgradableUnroutable: 0, tokensOnDowngradableUnroutable: 0,
    dollarsBaselineUnroutable: 0, dollarsSavedUnroutable: 0,
    dollarsGrossUnroutable: 0, dollarsExtraUnroutable: 0, offsetCallsUnroutable: 0,
    // vendor -> { calls, gross, extra } so the report can name the endpoint that would
    // unlock each figure ("$X would require a google endpoint") instead of quoting one
    // anonymous lump.
    unroutableByFamily: {},
    routedFrom: emptyTierMap(),   // what tier the call actually ran on
    routedTo: emptyTierMap(),     // what tier Cheaper would use
    bySource: { user: 0, subagent: 0 },
    // REALIZABLE examples only. Each example carries a `saved` dollar amount and is
    // rendered as a savings claim, so an unroutable one would put an unbankable number
    // straight back into the headline surface through the side door.
    examples: [],
    examplesUnroutable: [],
    timeSavedModelS: 0,
    timeSavedReasoningPotentialS: 0,
    tokensSavedReasoningPotential: 0,
    reasoningOpps: 0,
  };
  for (const r of records) {
    const content = contentTier(r.text);
    // The row's OWN day, so `actualCost` answers "what did this call cost" rather than
    // "what would those tokens cost today". Undatable rows pass null and fall back to
    // today inside estimateCall.
    const est = estimateCall(r.model, r.inTokens, r.outTokens, content.tier,
                             { at: r.ts ? pdayOf(r.ts, r.tzo) : null, router: opts.router });
    out.calls++;
    if (r.estimated) out.estimatedCalls++;
    const rowTokens = (r.inTokens || 0) + (r.outTokens || 0);
    out.tokens += rowTokens;
    if (est.priceable) {
      // SPEND is spend, whatever the vendor: both legs of the bill span every priceable
      // row. Only the SAVING is split by whether the gateway could have acted.
      out.dollarsActual += est.actualCost;
      out.dollarsBaseline += est.baselineCost;
      if (est.routable) {
        out.dollarsBaselineRoutable += est.baselineCost;
        out.dollarsSaved += est.saved;      // SIGNED — an anti-saving reduces the net
        out.dollarsGross += est.gross;
        out.dollarsExtra += est.extra;
        if (est.saved < 0) out.offsetCalls++;
      } else {
        // MOVED, NOT ZEROED. Same signed delta, same gross/extra split, different bucket.
        out.unroutableCalls++;
        out.unroutableTokens += rowTokens;
        out.dollarsBaselineUnroutable += est.baselineCost;
        out.dollarsSavedUnroutable += est.saved;
        out.dollarsGrossUnroutable += est.gross;
        out.dollarsExtraUnroutable += est.extra;
        if (est.saved < 0) out.offsetCallsUnroutable++;
        const f = out.unroutableByFamily[est.family]
          || (out.unroutableByFamily[est.family] = { calls: 0, gross: 0, extra: 0 });
        f.calls++; f.gross += est.gross; f.extra += est.extra;
      }
    } else {
      // Was: `out.dollarsActual += 0; out.dollarsSaved += 0;` — arithmetically a no-op,
      // and that was the problem. The call still incremented out.calls, so an unpriceable
      // model left no trace anywhere and a scan over mostly-uncatalogued models rendered
      // as a small, confident, fully-covered figure.
      out.unpriced++;
      out.unpricedTokens += rowTokens;
    }
    out.bySource[r.source === 'subagent' ? 'subagent' : 'user']++;
    if (est.actualTier) out.routedFrom[est.actualTier]++;
    if (est.effTier) out.routedTo[est.effTier]++;
    if (est.downgraded) {
      // "Downgradable" is a claim that Cheaper WOULD move this call. For a vendor with no
      // rewriting endpoint it would not, so the claim belongs in the other bucket — and
      // so does its example, which carries a dollar figure and is rendered as a saving.
      const bucket = est.routable ? 'examples' : 'examplesUnroutable';
      if (est.routable) {
        out.downgradable++;
        out.tokensOnDowngradable += rowTokens;
      } else {
        out.downgradableUnroutable++;
        out.tokensOnDowngradableUnroutable += rowTokens;
      }
      out[bucket].push({
        from: est.actualTier, to: est.effTier, saved: est.saved,
        family: est.family, routable: est.routable,
        source: r.source, reason: content.reason, text: snippet(r.text),
      });
    }

    // --- Historical TIME/TOKEN savings, mirroring metrics.py's per-row logic ---
    //
    // STILL THE ONE-STAGE MODEL, AND KNOWINGLY SO. `effectiveTier()` is
    // min(rank(actualTier), rank(contentTier)) — the requested-model ceiling and nothing
    // else. The DOLLAR figures above no longer work that way: they ask routeDecision()
    // with the live configuration, so they honour min_tier, allow_upgrade, the dollar
    // ceiling, passthrough, and the operator's own tier -> id map. These two blocks
    // therefore describe DIFFERENT ROUTERS, and the time figure is the optimistic one:
    // it books latency saved on downgrades the gateway would refuse, and on vendors it
    // has no endpoint for.
    //
    // Not converted here because the fix is `est.routedTier`, which changes a number no
    // surface currently reads (nothing in render.js, tagline.js or the test suite touches
    // timeSavedModelS), and changing an unread figure inside a change about the money
    // buys risk with no reader. Convert it when something starts printing it — and
    // convert it to `est.routedTier`, not to a second copy of the routing rules.
    const usedTier = modelTier(r.model);        // tier the caller actually used ("requested")
    const effTier = effectiveTier(r.text, r.model).tier; // tier Cheaper would route to ("chosen")
    // Both tiers must be known: modelTier() now returns null for a model we hold no
    // catalog entry for, and an unguarded LAT_TIER[null] would poison the running
    // total with NaN rather than simply skipping the row.
    if (usedTier && effTier && LAT_TIER[usedTier] != null && LAT_TIER[effTier] != null) {
      out.timeSavedModelS += Math.max(0, LAT_TIER[usedTier] - LAT_TIER[effTier]);
    }
    if (effTier === 'haiku' && REASONING_RE.test(String(r.model || ''))) {
      out.reasoningOpps += 1;
      out.tokensSavedReasoningPotential += THINK_TOKENS.high;
      out.timeSavedReasoningPotentialS += (LAT_EFFORT.high - LAT_EFFORT.low);
    }
  }
  out.examples.sort((a, b) => b.saved - a.saved);
  out.examples = out.examples.slice(0, opts.limit || 3);
  out.examplesUnroutable.sort((a, b) => b.saved - a.saved);
  out.examplesUnroutable = out.examplesUnroutable.slice(0, opts.limit || 3);
  out.timeSavedModelS = Math.round(out.timeSavedModelS * 10) / 10;
  out.timeSavedReasoningPotentialS = Math.round(out.timeSavedReasoningPotentialS * 10) / 10;
  return out;
}

// `opts.router` — a routing configuration resolved from the LIVE gateway by
// freshness.js::routerConfig(). Omitted, every knob falls back to the shipped default,
// which is what peek did unconditionally before; the difference is that the report now
// SAYS SO (`report.router.source === 'defaults'`, `report.router.assumed`), so a surface
// printing dollars can qualify them instead of presenting a guess as a measurement.
//
// scan() stays SYNCHRONOUS on purpose — it is called from the desktop app, from the
// tagline path and from tests, and making it async would ripple through all of them. The
// one call that needs a socket lives in scanLive() below.
function scan(opts = {}) {
  const o = {
    sinceDays: opts.sinceDays || 0,
    limit: opts.limit || 3,
    only: opts.only || null, // restrict to one harness key
    // Session scoping (used by `peek --tagline`): read only the current chat.
    session: opts.session || null,       // a session id (transcript basename stem)
    current: opts.current || false,      // newest primary transcript = active chat
    transcript: opts.transcript || null, // an explicit transcript file path
    router: opts.router || null,         // live gateway config; null => shipped defaults
  };
  const harnesses = [];
  for (const def of HARNESSES) {
    if (o.only && def.key !== o.only) continue;
    let h;
    try { h = scanHarness(def, o); }
    catch (e) {
      let installed = false;
      try { installed = isInstalled(def); } catch { installed = false; }
      h = { key: def.key, label: def.label, status: def.status, installed, error: String(e && e.message || e),
            calls: 0, downgradable: 0, dollarsActual: 0, dollarsBaseline: 0, dollarsSaved: 0,
            dollarsGross: 0, dollarsExtra: 0, offsetCalls: 0,
            dollarsBaselineRoutable: 0,
            unroutableCalls: 0, unroutableTokens: 0,
            downgradableUnroutable: 0, tokensOnDowngradableUnroutable: 0,
            dollarsBaselineUnroutable: 0, dollarsSavedUnroutable: 0,
            dollarsGrossUnroutable: 0, dollarsExtraUnroutable: 0, offsetCallsUnroutable: 0,
            unroutableByFamily: {}, examplesUnroutable: [],
            unpriced: 0, unpricedTokens: 0, tokens: 0,
            filesScanned: 0, examples: [], bySource: { user: 0, subagent: 0 },
            routedFrom: emptyTierMap(), routedTo: emptyTierMap(),
            timeSavedModelS: 0, timeSavedReasoningPotentialS: 0,
            tokensSavedReasoningPotential: 0, reasoningOpps: 0 };
    }
    harnesses.push(h);
  }
  const totals = harnesses.reduce((a, h) => {
    a.calls += h.calls; a.downgradable += h.downgradable; a.estimatedCalls += (h.estimatedCalls || 0);
    a.unpriced += (h.unpriced || 0); a.unpricedTokens += (h.unpricedTokens || 0);
    a.tokens += h.tokens; a.tokensOnDowngradable += (h.tokensOnDowngradable || 0);
    a.dollarsActual += h.dollarsActual; a.dollarsSaved += h.dollarsSaved;
    a.dollarsBaseline += (h.dollarsBaseline || 0);
    a.dollarsGross += (h.dollarsGross || 0); a.dollarsExtra += (h.dollarsExtra || 0);
    a.offsetCalls += (h.offsetCalls || 0);
    a.dollarsBaselineRoutable += (h.dollarsBaselineRoutable || 0);
    a.unroutableCalls += (h.unroutableCalls || 0);
    a.unroutableTokens += (h.unroutableTokens || 0);
    a.downgradableUnroutable += (h.downgradableUnroutable || 0);
    a.tokensOnDowngradableUnroutable += (h.tokensOnDowngradableUnroutable || 0);
    a.dollarsBaselineUnroutable += (h.dollarsBaselineUnroutable || 0);
    a.dollarsSavedUnroutable += (h.dollarsSavedUnroutable || 0);
    a.dollarsGrossUnroutable += (h.dollarsGrossUnroutable || 0);
    a.dollarsExtraUnroutable += (h.dollarsExtraUnroutable || 0);
    a.offsetCallsUnroutable += (h.offsetCallsUnroutable || 0);
    for (const fam of Object.keys(h.unroutableByFamily || {})) {
      const s = h.unroutableByFamily[fam];
      const t = a.unroutableByFamily[fam]
        || (a.unroutableByFamily[fam] = { calls: 0, gross: 0, extra: 0 });
      t.calls += s.calls; t.gross += s.gross; t.extra += s.extra;
    }
    a.bySource.user += h.bySource.user; a.bySource.subagent += h.bySource.subagent;
    a.timeSavedModelS += (h.timeSavedModelS || 0);
    a.timeSavedReasoningPotentialS += (h.timeSavedReasoningPotentialS || 0);
    a.tokensSavedReasoningPotential += (h.tokensSavedReasoningPotential || 0);
    a.reasoningOpps += (h.reasoningOpps || 0);
    return a;
  }, { calls: 0, downgradable: 0, estimatedCalls: 0, unpriced: 0, unpricedTokens: 0,
       tokens: 0, tokensOnDowngradable: 0,
       dollarsActual: 0, dollarsBaseline: 0, dollarsSaved: 0,
       dollarsGross: 0, dollarsExtra: 0, offsetCalls: 0,
       dollarsBaselineRoutable: 0,
       unroutableCalls: 0, unroutableTokens: 0,
       downgradableUnroutable: 0, tokensOnDowngradableUnroutable: 0,
       dollarsBaselineUnroutable: 0, dollarsSavedUnroutable: 0,
       dollarsGrossUnroutable: 0, dollarsExtraUnroutable: 0, offsetCallsUnroutable: 0,
       unroutableByFamily: {},
       bySource: { user: 0, subagent: 0 },
       timeSavedModelS: 0, timeSavedReasoningPotentialS: 0,
       tokensSavedReasoningPotential: 0, reasoningOpps: 0 });
  // "% off" is a ratio of two PROSPECTIVE figures, so the denominator is the today-priced
  // baseline, not `dollarsActual` (which is now the HISTORICAL spend-on-record, priced at
  // each call's own day). The two are equal for undated records, which is what the old
  // `dollarsSaved / dollarsActual` silently relied on; once rows are priced at their own
  // day it became a ratio across two time frames.
  //
  // The DENOMINATOR STAYS THE WHOLE BILL. `dollarsSaved` is now realizable-only while
  // `dollarsBaseline` still spans every priceable row, and that asymmetry is deliberate:
  // "% off" is a claim about the user's ACTUAL bill, and dividing by the routable subset
  // instead would inflate it exactly in proportion to how much of their traffic Cheaper
  // cannot touch. A user whose spend is 90% Gemini should see a small percentage, because
  // that is the truth. `savedPctOfRoutable` below answers the other, engineering-facing
  // question ("of the traffic we CAN route, how much did we take off") and is kept under
  // its own name so the two can never be confused for one another.
  totals.savedPct = totals.dollarsBaseline > 0 ? (totals.dollarsSaved / totals.dollarsBaseline) * 100 : 0;
  totals.savedPctOfRoutable = totals.dollarsBaselineRoutable > 0
    ? (totals.dollarsSaved / totals.dollarsBaselineRoutable) * 100 : 0;
  // What fraction of the scanned traffic the dollar figures do NOT cover. A caller that
  // prints a dollar amount must print this next to it: 0.87 means the number above
  // describes 13% of the work. Mirrors derive.js::foldRows.unpricedRatio.
  totals.unpricedRatio = totals.tokens > 0 ? totals.unpricedTokens / totals.tokens : 0;
  // The SECOND coverage ratio, and it answers a different question from unpricedRatio:
  // not "how much could we not price" but "how much of what we priced is a saving nobody
  // can bank yet". A consumer printing the headline owes the reader this number whenever
  // it is non-zero, and the remedy it implies is an ENDPOINT, not a price.
  totals.unroutableRatio = totals.tokens > 0 ? totals.unroutableTokens / totals.tokens : 0;
  totals.timeSavedModelS = Math.round(totals.timeSavedModelS * 10) / 10;
  totals.timeSavedReasoningPotentialS = Math.round(totals.timeSavedReasoningPotentialS * 10) / 10;
  // Rough annualization: if we scanned N days, extrapolate to a year.
  totals.annualizedSaved = o.sinceDays ? totals.dollarsSaved * (365 / o.sinceDays) : null;
  return {
    generatedAt: Date.now(),
    opts: o,
    priceNote: 'Illustrative public list $/Mtok; ratios drive the estimate.',
    // WHICH ROUTER THESE DOLLARS DESCRIBE. Always present, never omitted: a report that
    // silently leaves this out is indistinguishable from one that verified the config,
    // which is the whole failure mode. `source: 'defaults'` with a populated `assumed`
    // list is the honest form of "we could not ask, so we guessed" — and `labelled: true`
    // is the flag a rendering surface must obey.
    router: routerLabel(o.router),
    harnesses,
    totals,
  };
}

// The router block echoed into every report. Normalises the two ways a caller can arrive
// — with a resolved config from freshness.js::routerConfig(), or with nothing at all —
// into ONE shape, so a consumer never has to branch on whether the field exists.
//
// An absent config is not "no information": it is the specific claim "every routing knob
// was assumed", and it is written out in full rather than left as a null for a reader to
// interpret. Invariant 7 — a labelled non-number beats a confident wrong one.
function routerLabel(router) {
  if (router && typeof router === 'object') {
    return Object.assign({}, router, {
      // Defensive: a caller may hand us a bare {minTier:'sonnet'} in a test. Anything that
      // did not come from routerConfigFrom() has no provenance, so it is recorded as
      // assumed-by-default rather than promoted to "the gateway said so".
      source: router.source || 'defaults',
      reachable: !!router.reachable,
      assumed: Array.isArray(router.assumed) ? router.assumed : [],
      labelled: router.labelled !== undefined ? !!router.labelled : true,
    });
  }
  return {
    source: 'defaults', reachable: false,
    mode: 'heuristic', models: null, openaiModels: null,
    minTier: 'haiku', allowUpgradeAboveRequested: false, longRequestChars: null,
    routableFamilies: null,
    assumed: ['mode', 'models', 'openaiModels', 'minTier',
              'allowUpgradeAboveRequested', 'longRequestChars', 'routableFamilies'],
    missingHealthzKeys: [],
    triageUnmodellable: false,
    labelled: true,
    note: 'no gateway configuration was resolved — assuming shipped defaults for every '
      + 'routing knob',
  };
}

// scan(), with the live gateway configuration resolved FIRST.
//
// This is the entry point a command that prints money should call. `scan()` cannot do the
// resolution itself without becoming async and rippling through the desktop app, the
// tagline path and every test, so the socket call lives here and the pure function stays
// pure.
//
// It never rejects and never blocks past freshness.js's own timeout: an unreachable
// gateway resolves to the shipped defaults WITH `assumed` populated, which is a result,
// not an error. Requiring freshness lazily keeps peek/'s no-outside-imports property for
// every path that does not ask for a live config.
async function scanLive(opts = {}) {
  let router = null;
  try {
    router = await require('../freshness').routerConfig();
  } catch (_e) {
    // A resolution failure must not lose the report — it must lose the CLAIM of
    // knowing the config, which routerLabel(null) states explicitly.
    router = null;
  }
  return scan(Object.assign({}, opts, { router }));
}

module.exports = { scan, scanLive, scanHarness, snippet, routerLabel };
