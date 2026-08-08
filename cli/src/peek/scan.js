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
    dollarsActual: 0, dollarsBaseline: 0, dollarsSaved: 0,
    dollarsGross: 0, dollarsExtra: 0, offsetCalls: 0,
    routedFrom: emptyTierMap(),   // what tier the call actually ran on
    routedTo: emptyTierMap(),     // what tier Cheaper would use
    bySource: { user: 0, subagent: 0 },
    examples: [],
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
                             { at: r.ts ? pdayOf(r.ts, r.tzo) : null });
    out.calls++;
    if (r.estimated) out.estimatedCalls++;
    const rowTokens = (r.inTokens || 0) + (r.outTokens || 0);
    out.tokens += rowTokens;
    if (est.priceable) {
      out.dollarsActual += est.actualCost;
      out.dollarsBaseline += est.baselineCost;
      out.dollarsSaved += est.saved;      // SIGNED — an anti-saving reduces the net
      out.dollarsGross += est.gross;
      out.dollarsExtra += est.extra;
      if (est.saved < 0) out.offsetCalls++;
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
      out.downgradable++;
      out.tokensOnDowngradable += (r.inTokens || 0) + (r.outTokens || 0);
      out.examples.push({
        from: est.actualTier, to: est.effTier, saved: est.saved,
        source: r.source, reason: content.reason, text: snippet(r.text),
      });
    }

    // --- Historical TIME/TOKEN savings, mirroring metrics.py's per-row logic ---
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
  out.timeSavedModelS = Math.round(out.timeSavedModelS * 10) / 10;
  out.timeSavedReasoningPotentialS = Math.round(out.timeSavedReasoningPotentialS * 10) / 10;
  return out;
}

function scan(opts = {}) {
  const o = {
    sinceDays: opts.sinceDays || 0,
    limit: opts.limit || 3,
    only: opts.only || null, // restrict to one harness key
    // Session scoping (used by `peek --tagline`): read only the current chat.
    session: opts.session || null,       // a session id (transcript basename stem)
    current: opts.current || false,      // newest primary transcript = active chat
    transcript: opts.transcript || null, // an explicit transcript file path
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
       bySource: { user: 0, subagent: 0 },
       timeSavedModelS: 0, timeSavedReasoningPotentialS: 0,
       tokensSavedReasoningPotential: 0, reasoningOpps: 0 });
  // "% off" is a ratio of two PROSPECTIVE figures, so the denominator is the today-priced
  // baseline, not `dollarsActual` (which is now the HISTORICAL spend-on-record, priced at
  // each call's own day). The two are equal for undated records, which is what the old
  // `dollarsSaved / dollarsActual` silently relied on; once rows are priced at their own
  // day it became a ratio across two time frames.
  totals.savedPct = totals.dollarsBaseline > 0 ? (totals.dollarsSaved / totals.dollarsBaseline) * 100 : 0;
  // What fraction of the scanned traffic the dollar figures do NOT cover. A caller that
  // prints a dollar amount must print this next to it: 0.87 means the number above
  // describes 13% of the work. Mirrors derive.js::foldRows.unpricedRatio.
  totals.unpricedRatio = totals.tokens > 0 ? totals.unpricedTokens / totals.tokens : 0;
  totals.timeSavedModelS = Math.round(totals.timeSavedModelS * 10) / 10;
  totals.timeSavedReasoningPotentialS = Math.round(totals.timeSavedReasoningPotentialS * 10) / 10;
  // Rough annualization: if we scanned N days, extrapolate to a year.
  totals.annualizedSaved = o.sinceDays ? totals.dollarsSaved * (365 / o.sinceDays) : null;
  return {
    generatedAt: Date.now(),
    opts: o,
    priceNote: 'Illustrative public list $/Mtok; ratios drive the estimate.',
    harnesses,
    totals,
  };
}

module.exports = { scan, scanHarness, snippet };
