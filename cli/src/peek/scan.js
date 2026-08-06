'use strict';
// The peek engine. Walks each harness's history, classifies every model call the
// SAME way the live gateway would, prices it, and rolls up how many tokens and
// real dollars adaptive routing would have saved — with the never-upgrade ceiling
// already applied by pricing.estimateCall.

const { contentTier, TIERS } = require('./classify');
const { estimateCall, FAMILIES, BUCKET } = require('./pricing');
const { HARNESSES, collectHarness, isInstalled } = require('./adapters');

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
    tokens: 0, tokensOnDowngradable: 0,
    dollarsActual: 0, dollarsSaved: 0,
    routedFrom: emptyTierMap(),   // what tier the call actually ran on
    routedTo: emptyTierMap(),     // what tier Cheaper would use
    bySource: { user: 0, subagent: 0 },
    examples: [],
  };
  for (const r of records) {
    const content = contentTier(r.text);
    const est = estimateCall(r.model, r.inTokens, r.outTokens, content.tier);
    out.calls++;
    if (r.estimated) out.estimatedCalls++;
    out.tokens += (r.inTokens || 0) + (r.outTokens || 0);
    out.dollarsActual += est.actualCost;
    out.dollarsSaved += est.saved;
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
  }
  out.examples.sort((a, b) => b.saved - a.saved);
  out.examples = out.examples.slice(0, opts.limit || 3);
  return out;
}

function scan(opts = {}) {
  const o = {
    sinceDays: opts.sinceDays || 0,
    limit: opts.limit || 3,
    only: opts.only || null, // restrict to one harness key
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
            calls: 0, downgradable: 0, dollarsActual: 0, dollarsSaved: 0, tokens: 0,
            filesScanned: 0, examples: [], bySource: { user: 0, subagent: 0 },
            routedFrom: emptyTierMap(), routedTo: emptyTierMap() };
    }
    harnesses.push(h);
  }
  const totals = harnesses.reduce((a, h) => {
    a.calls += h.calls; a.downgradable += h.downgradable; a.estimatedCalls += (h.estimatedCalls || 0);
    a.tokens += h.tokens; a.tokensOnDowngradable += (h.tokensOnDowngradable || 0);
    a.dollarsActual += h.dollarsActual; a.dollarsSaved += h.dollarsSaved;
    a.bySource.user += h.bySource.user; a.bySource.subagent += h.bySource.subagent;
    return a;
  }, { calls: 0, downgradable: 0, estimatedCalls: 0, tokens: 0, tokensOnDowngradable: 0,
       dollarsActual: 0, dollarsSaved: 0, bySource: { user: 0, subagent: 0 } });
  totals.savedPct = totals.dollarsActual > 0 ? (totals.dollarsSaved / totals.dollarsActual) * 100 : 0;
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
