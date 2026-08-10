'use strict';
// Terminal rendering for `cheaper peek`. Self-contained (no imports outside this
// folder) so the whole peek/ directory can be vendored into the desktop app.
//
// THIS IS THE SURFACE ALMOST EVERYONE READS. `peek --json` has carried the honesty
// fields — `unpriced` / `unpricedTokens` / `unpricedRatio`, and the `dollarsGross` /
// `dollarsExtra` / `offsetCalls` decomposition — since scan.js started counting them,
// and NONE of it reached this file. The one consumer that reads the JSON therefore saw
// a scan that admitted what it had excluded, while everybody reading the terminal saw a
// small, confident, fully-covered number computed over a handful of catalogued rows:
// exactly the failure scan.js's own header describes. Invariant 4 — an exclusion must be
// COUNTED and VISIBLE, and an unpriceable figure must render as a LABELLED NON-NUMBER,
// never $0.00 — is a property of what is PRINTED, not only of what is computed.
//
// The vocabulary is deliberately the one cli/src/reports.js, cli/src/savings.js,
// gateway/app/dashboard.html and gateway/app/report.html already use, so a user moving
// between `peek`, `savings` and `reports` reads ONE word for one meaning:
//   'withheld'    — rows WERE seen and their dollars are deliberately not claimed.
//   'not covered' — Cheaper was not watching this harness / it could not be read.
//   '—'           — nothing of this kind exists here at all.
// reports.js::claimState is the canonical predicate and cannot be imported here: it reads
// the STORE window shape (two bases, `events`, `unpriced_calls`), peek's payload is a
// different single-basis shape, and this folder must stay import-free so it can be
// vendored into the desktop app. `claimOf` below is the same THREE-WAY decision, made in
// the same ORDER (withheld is tested BEFORE absent — that ordering is most of the fix
// recorded in reports.js) against the same 20%-of-tokens rule as
// derive.js::foldRows.dollarsSuppressed. Keep the three in step.
//
// THEY ARE IN STEP ON THE LEG THEY SHARE, AND ONLY THAT LEG. `claimOf` tests one thing the
// other two do not — the ROUTED leg's own exclusion (`unpricedRoute`) — and that is not
// drift: the other two read a record of routes the gateway REALLY TOOK, where the served
// model IS the route, so there is no counterfactual target and nothing whose price could be
// missing. peek is the only one of the three holding a counterfactual, so it is the only
// one with a second leg to test. Same threshold, same order, one extra question that only
// this payload can be asked.

const c = {
  amber: (s) => `\x1b[38;5;208m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

// Over a fifth of a window's tokens unpriceable => the dollars are withheld, not
// approximated. Mirrors cli/src/peek/derive.js::foldRows (`> 0.20`) and the note
// gateway/app/reporting.py attaches to a suppressed window. A figure derived from four
// fifths of the evidence and presented as if it were all of it is the shape every prior
// incident in this product had.
const UNPRICED_SUPPRESS_RATIO = 0.20;

// SIGNED money. `dollarsSaved` is an unclamped signed net (pricing.js::estimateCall
// returns a signed delta and scan.js sums it), so a negative total is reachable — the
// gemini-2.5-pro anti-saving in cli/test/peek.test.js reaches it — and it must read as a
// negative. `'$' + (-5).toLocaleString()` produced "$-5.00", with the minus buried INSIDE
// the amount; the sign now leads, exactly as reports.js::money and savings.js::money
// already print it. Returns null (not "$NaN") for a figure that is not a number, so every
// caller has to decide what a missing figure LOOKS like rather than printing garbage.
function money(n) {
  const x = Number(n);
  if (n === null || n === undefined || !Number.isFinite(x)) return null;
  const a = Math.abs(x);
  const v = a >= 100 ? Math.round(a) : Math.round(a * 100) / 100;
  return (x < 0 ? '-' : '') + '$' + v.toLocaleString('en-US', {
    minimumFractionDigits: a >= 100 ? 0 : 2, maximumFractionDigits: 2 });
}
function tokens(n) {
  const v = Number(n);
  // A token count that is not a number is a missing fact, and "NaN" / "0" both state
  // something. The em dash states nothing, which is the truth.
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(v);
}
// A percentage that never rounds a real exclusion away to "0%" or a real gap up to
// "100%". "0% not priced" beside a non-zero unpriced count is a self-contradicting line.
function pctOf(ratio) {
  const p = Number(ratio) * 100;
  if (!Number.isFinite(p)) return '—';
  if (p > 0 && p < 1) return '<1%';
  if (p > 99 && p < 100) return '>99%';
  return Math.round(p) + '%';
}
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
// A count and its share of the row's calls, as one cell.
//
// The em dash — never "0", never "undefined" — for a counter the payload does not carry.
// A 0 here is a CLAIM ("nothing was re-routed"), and a report from a build that did not
// compute the counter is not making that claim; printing its absence as a zero is the
// same substitution `dollarCell` refuses for money.
function countCell(n, calls) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const c2 = Number(calls);
  return `${v} (${pctOf(Number.isFinite(c2) && c2 > 0 ? v / c2 : NaN)})`;
}
// Padding computed on the VISIBLE length, so an ANSI colour code — zero-width on screen,
// not to String#padEnd — cannot skew the columns. Same helper, same reason, as
// cli/src/reports.js::vis.
const vis = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
const padVis = (s, n) => String(s) + ' '.repeat(Math.max(0, n - vis(s)));
function statusTag(st) {
  if (st === 'supported') return c.green('●');
  if (st === 'experimental') return c.amber('◐');
  return c.dim('○');
}

// What fraction of the tokens SEEN could not be priced. `totals` publishes this itself;
// per-harness rows do not, so it is DERIVED here from the two counters scan.js does
// publish rather than stored anywhere (invariant 2 — dollars, and the ratios that qualify
// them, are derived, never persisted). `out.tokens` in scan.js accumulates on EVERY row,
// priceable or not, so this denominator is rows-seen and matches totals.unpricedRatio.
// Returns null — never 0 — when the ratio cannot be formed at all: 0 would assert full
// coverage, which is the exact claim we are unable to make.
function unpricedRatioOf(x) {
  if (!x) return null;
  if (Number.isFinite(Number(x.unpricedRatio))) return Number(x.unpricedRatio);
  const tot = Number(x.tokens);
  const un = Number(x.unpricedTokens);
  if (!Number.isFinite(tot) || !Number.isFinite(un) || tot <= 0) return null;
  return un / tot;
}

// THE SAME QUESTION, ASKED ABOUT THE OTHER LEG: what fraction of the tokens SEEN had a
// route whose TARGET could not be priced. `totals` publishes `unpricedRouteRatio` itself
// (scan.js); per-harness rows do not, so it is derived here from the two counters they do
// carry — over the SAME denominator as `unpricedRatioOf`, because `out.tokens` accumulates
// on every row seen. One denominator is what makes the two ratios comparable and lets them
// be held to ONE threshold instead of two that would drift apart.
//
// Returns null — never 0 — when the ratio cannot be formed, and that is the load-bearing
// case rather than a formality: a 0 would assert that every route WAS priceable, and a
// payload that predates these counters cannot make that claim. Returning null means an
// older `peek --json` is judged exactly as it was before, instead of being silently
// re-scored against a field it never published.
function unpricedRouteRatioOf(x) {
  if (!x) return null;
  if (Number.isFinite(Number(x.unpricedRouteRatio))) return Number(x.unpricedRouteRatio);
  const tot = Number(x.tokens);
  const un = Number(x.unpricedRouteTokens);
  if (!Number.isFinite(tot) || !Number.isFinite(un) || tot <= 0) return null;
  return un / tot;
}

// The THREE-WAY claim decision for one harness row or for the totals, in the order
// reports.js::claimState fixed: not-covered, then WITHHELD, then absent, then value.
//
// Testing "did anything price?" first is the collapse this ordering exists to prevent: a
// scan that is 100% unpriceable prices nothing, so an absent-first predicate prints the
// bare em dash — the "there is nothing here" glyph — for a scan whose own unpriced count
// proves rows were seen and were deliberately excluded. Those are different claims and
// the product forbids collapsing one into the other.
function claimOf(x) {
  if (!x) return 'absent';
  // A harness that errored or was never readable is NOT COVERED: Cheaper was not
  // watching, so there is nothing to withhold.
  if (x.error) return 'not_covered';
  const seen = Number(x.calls);
  if (!Number.isFinite(seen) || seen <= 0) return 'absent';
  const unpriced = Number.isFinite(Number(x.unpriced)) ? Number(x.unpriced) : 0;
  // Rows were seen but NONE of them priced: every dollar accumulator still holds its
  // initial 0. That 0 is vacuous — the initial value, not a measurement — and printing it
  // as $0.00 is how "we could not price this" becomes "this cost nothing".
  if (seen - unpriced <= 0) return 'withheld';
  const r = unpricedRatioOf(x);
  if (r !== null && r > UNPRICED_SUPPRESS_RATIO) return 'withheld';
  // THE SAME RULE, THE SAME THRESHOLD, ON THE ROUTED LEG.
  //
  // Everything above reads `unpriced` — a fact about the model that RAN. A row whose model
  // is catalogued satisfies every test above and can STILL have contributed a missing
  // figure rather than a measured one, because the model the gateway would route it TO has
  // no published rate: pricing.js refuses to invent one, books no movement, and says so in
  // `routedPriceable`. `saved` for that row is exactly 0, and it has just been summed into
  // a total full of measured zeros.
  //
  // A scan in which EVERY row is in that position therefore priced perfectly, reported
  // "Coverage all N calls priced.", and printed `Could have saved $0.00` — a figure nobody
  // could derive, rendered as one that was. That is invariant 4's own words ("an
  // unpriceable figure must render as a LABELLED NON-NUMBER, never $0.00") failing on the
  // leg the invariant was not written about. `unpricedRoute` did not exist when this
  // predicate was written; it does now, so the predicate can see it.
  //
  // ONE THRESHOLD, NOT A SECOND ONE. The exclusions stay separate everywhere they are
  // COUNTED — different remedies, different lines on screen, never a blended number — but
  // the question "is too little of this scan's evidence available to claim a figure" is one
  // question, and answering it with two constants is how the two answers drift.
  //
  // DIRECTION. This only ever LOWERS a published claim: every scan it newly withholds
  // previously printed a number. It cannot raise one, so it needs no adversarial upward
  // verification — but it must not withhold a scan whose dollars ARE measured, which is why
  // the test is a share of tokens seen and not the mere presence of `unpricedRoute > 0`. A
  // scan with real savings and a small route-unpriceable tail keeps its figure and carries
  // the `Route unpriced` line beside it, exactly as a small `unpriced` tail does.
  //
  // WHAT IS DELIBERATELY NOT CHANGED, and why it is not drift:
  //   - `reports.js::claimState` and `derive.js::foldRows` read the savings-STORE shape,
  //     which is a record of routes the gateway REALLY TOOK. There is no counterfactual
  //     target there — the served model IS the route — so a target that could not be priced
  //     has no representation in that payload and nothing to mirror. (claimState is also
  //     pinned byte-identical across three surfaces by cli/test/html.test.js; adding a
  //     branch for a field none of them carries would be drift, not parity.)
  //   - `unpricedRoute` is counted for routable AND unroutable rows, while the headline
  //     dollars span routable rows only, so a scan withheld purely by an unroutable row's
  //     unpriceable target is withheld slightly early. That errs toward claiming LESS,
  //     which is the safe direction here, and closing it needs a routable-split counter in
  //     scan.js — a new published field, not a predicate change. Logged, not ridden along.
  const rr = unpricedRouteRatioOf(x);
  if (rr !== null && rr > UNPRICED_SUPPRESS_RATIO) return 'withheld';
  return 'value';
}

// One dollar cell, obeying the claim. NEVER prints $0.00 for a figure nobody could
// derive, and never prints an em dash for a figure that was deliberately declined.
function dollarCell(state, v, color) {
  if (state === 'not_covered') return c.dim('not covered');
  if (state === 'withheld') return c.amber('withheld');
  if (state !== 'value') return c.dim('—');
  const m = money(v);
  if (m === null) return c.dim('—');
  return color ? color(m) : m;
}

function render(report) {
  const L = [];
  const T = report.totals;
  L.push('');
  L.push('  ' + c.amber('cheaper peek') + c.dim('  — what adaptive routing would have saved'));
  const since = report.opts.sinceDays ? `last ${report.opts.sinceDays}d` : 'all history';
  L.push('  ' + c.dim(`scanned ${since} across your harness chat logs`));
  L.push('');

  // Per-harness table. The money column is TWO today-frame figures (see the frame note
  // below), followed by the coverage this row's money actually has.
  // TWO COUNTS, NOT ONE. `downgradable` is a TIER move; the money beside it comes from a
  // MODEL substitution, and neither set contains the other (scan.js states the two ways
  // they come apart). Printing only the tier count next to the dollars invited a reader to
  // derive X from N — both numbers true, the pairing misleading. Both are printed now.
  L.push('  ' + c.dim(pad('harness', 16) + pad('calls', 8) + pad('downgradable', 14) +
    pad('re-routed', 12) +
    pad('tokens', 9) + pad('you’d save / you’d pay', 24) + 'coverage'));
  for (const h of report.harnesses) {
    if (h.error) {
      L.push('  ' + statusTag(h.status) + ' ' + pad(h.label, 14) + c.red('error: ' + h.error));
      continue;
    }
    if (!h.calls) {
      const why = h.note || (h.status === 'sqlite' ? 'DB-backed (not yet readable)' : 'no history found');
      // NOT COVERED, spelled the way every other surface spells it: Cheaper was not
      // watching here, so no figure is missing — there was never one to make.
      L.push('  ' + statusTag(h.status) + ' ' + pad(h.label, 14) + c.dim('not covered — ' + why));
      continue;
    }
    const st = claimOf(h);
    // `Math.round(1/202*100)` is 0, so one genuine opportunity out of 202 calls rendered
    // as "1 (0%)" — a count and a percentage of the same fact contradicting each other on
    // one line. pctOf() floors a real non-zero at "<1%".
    const dg = countCell(h.downgradable, h.calls);
    // The partner of the money column: `dollarsSaved` is Σ(baselineCost - newCost), and
    // newCost differs from baselineCost ONLY on a substituted row we could price — so
    // this count going to 0 forces the dollars to 0, and `downgradable` going to 0 does
    // not. This is the cell a reader reconciles the dollars against.
    const sub = countCell(h.substituted, h.calls);
    // ---- FRAME (defect #2, was `Math.max(0, h.dollarsActual - h.dollarsSaved)`) --------
    // `dollarsSaved` is a TODAY-frame figure: scan.js sums estimateCall's `saved`, and
    // BOTH of that subtraction's legs (`baselineCost`, `newCost`) price at TODAY —
    // pricing.js states this explicitly, it is why `baselineCost` exists separately from
    // `actualCost`. `dollarsActual` is the HISTORICAL spend-on-record, each row priced at
    // its OWN pday. `dollarsActual - dollarsSaved` therefore subtracted a today-frame
    // figure from a historical one and labelled the result "spent" — the exact frame
    // substitution `estimateCall`'s `at` parameter exists to prevent. On a session
    // recorded inside Sonnet 5's $2/$10 promotional window and read after it closed the
    // two frames are 33% apart, and every cent of that gap is calendar, not routing.
    //
    // The today-frame partner of `dollarsSaved` is `dollarsBaseline` — the same calls at
    // today's rates — so what the label actually means, "what this work would still cost
    // you once Cheaper had routed it", is `dollarsBaseline - dollarsSaved`, which is
    // identically Σ newCost. Both legs, one frame, and the difference is now routing only.
    //
    // AND NO CLAMP. Σ newCost is a sum of non-negative model costs, so the correct
    // expression cannot go negative on its own; `Math.max(0, …)` could therefore only ever
    // have fired on the cross-frame mismatch it was concealing. A negative here is a
    // defect report, and rendering a defect report as a confident $0.00 is the failure
    // shape this repo has already shipped three times. If it ever goes negative it now
    // prints as the signed number it is, loudly, instead of being clamped away.
    const wouldPay = Number(h.dollarsBaseline) - Number(h.dollarsSaved);
    const savedCell = dollarCell(st, h.dollarsSaved,
      Number(h.dollarsSaved) < 0 ? c.red : c.green);
    const moneyCell = st === 'value'
      ? savedCell + c.dim(' / ') + dollarCell(st, wouldPay, c.red)
      : savedCell;
    L.push(('  ' + statusTag(h.status) + ' ' + pad(h.label, 14) +
      pad(h.calls, 8) + pad(dg, 14) + pad(sub, 12) + pad(tokens(h.tokens), 9) +
      padVis(moneyCell, 24) + coverageNote(h)).replace(/\s+$/, ''));
  }
  L.push('');

  // Headline
  const tst = claimOf(T);
  // Omitted rather than zeroed when the payload does not carry the counter — see
  // countCell. A "0 re-routed" printed beside a non-zero saving would be a contradiction
  // manufactured by the renderer out of a field it simply was not given.
  const subHead = Number.isFinite(Number(T.substituted))
    ? `${c.amber(T.substituted + ' re-routed')} · ` : '';
  L.push('  ' + c.bold('Total') + '   ' +
    `${T.calls} calls · ${c.amber(T.downgradable + ' downgradable')} · ` + subHead +
    `${c.dim('from you ' + T.bySource.user + ' / sub-agents ' + T.bySource.subagent)}`);
  // Same frame split as the per-harness row, and for the same reason. `Spent on record`
  // is the HISTORICAL frame and stands alone; the three lines under it are all TODAY-frame
  // and are the only ones that may be subtracted from one another.
  const totalWouldPay = Number(T.dollarsBaseline) - Number(T.dollarsSaved);
  L.push('  ' + c.dim('Spent on record   ') + dollarCell(tst, T.dollarsActual) +
    c.dim('   (historical — each call at the rates in force on its own day)'));
  L.push('  ' + c.dim('At today’s rates  ') + dollarCell(tst, T.dollarsBaseline) +
    c.dim('   (the same calls, repriced — the baseline the saving is measured against)'));
  // A negative net is not a saving and must not be labelled as one. The product already
  // has words for this: the tagline says routed work "cost $X more than <model> would
  // have". Same claim, same direction, same colour.
  const loss = Number(T.dollarsSaved) < 0;
  const pctTxt = (tst === 'value' && Number.isFinite(Number(T.savedPct)))
    ? c.dim(`  (${Math.abs(Math.round(T.savedPct))}% ${loss ? 'MORE' : 'off'})`) : '';
  // THE TOKENS BEHIND THE MONEY, NOT THE TOKENS BEHIND THE TIER MOVES. This read
  // `tokensOnDowngradable`, which is the volume of the rows that changed TIER — a
  // different population from the rows that moved a dollar, and so a volume that did not
  // describe the figure it was printed beside. `tokensOnSubstituted` is the matching one:
  // the same rows whose `saved` was summed into the amount on this line. A payload that
  // does not carry it renders '—' (tokens()), which is the truth, rather than silently
  // falling back to the tier figure and reinstating the mismatch.
  L.push('  ' + (loss ? c.bold('Would cost MORE   ') : c.bold('Could have saved  ')) +
    dollarCell(tst, T.dollarsSaved, loss ? c.red : c.green) + pctTxt +
    c.dim(`  · ${tokens(T.tokensOnSubstituted)} tokens re-routable`));
  L.push('  ' + c.dim('You’d still pay   ') + dollarCell(tst, totalWouldPay, c.red) +
    c.dim('   (today’s rates, after routing)'));
  // The gross/extra decomposition. A net that has been REDUCED by an anti-saving reads
  // identically to a smaller gross unless the offset is named, so it is named.
  if (Number(T.offsetCalls) > 0) {
    const g = dollarCell(tst, T.dollarsGross, c.green);
    const e = dollarCell(tst, T.dollarsExtra, c.red);
    L.push('  ' + c.dim('Offsets           ') +
      c.amber(`${T.offsetCalls} call(s) routed to a COSTLIER model`) +
      c.dim('  · gross ') + g + c.dim(' less extra ') + e);
  }
  // THE RECONCILIATION LINE. Printed only when the two counts differ, which is exactly
  // when a reader who assumed they were one number would be wrong.
  //
  // It states two counts side by side and claims NO containment between them, because
  // there is none in either direction: a same-tier substitution moves a dollar without a
  // downgrade, and an operator map naming the caller's own model in a lower tier's slot is
  // a downgrade that moves none. "N of which" would be a claim this data does not support.
  if (Number.isFinite(Number(T.substituted))
      && Number(T.substituted) !== Number(T.downgradable)) {
    L.push('  ' + c.dim('Routing           ') +
      c.amber(`${T.substituted} call(s) re-routed to a different MODEL`) +
      c.dim(` · ${T.downgradable} to a cheaper TIER`) +
      c.dim('  — the dollars above follow the model, not the tier'));
  }
  // COVERAGE. The exclusion is stated in calls AND in tokens, next to the money it does
  // not describe. `unpriced === calls` means every dollar figure above describes NOTHING,
  // which is why `claimOf` withholds them rather than printing the zeros they hold.
  if (T.calls > 0) {
    if (Number(T.unpriced) > 0) {
      const ratio = unpricedRatioOf(T);
      L.push('  ' + c.dim('Not priced        ') +
        c.amber(`${T.unpriced} of ${T.calls} calls`) +
        c.dim(` · ${tokens(T.unpricedTokens)} of ${tokens(T.tokens)} tokens`) +
        (ratio === null ? '' : c.amber(` (${pctOf(ratio)} of tokens)`)) +
        c.dim(' — no published rate, excluded from every dollar above'));
      if (tst === 'withheld') {
        L.push('  ' + c.dim('                  ') +
          c.amber('Dollars withheld: too little of this scan could be priced to claim a figure.'));
      }
    } else {
      // Stated affirmatively so "fully covered" is distinguishable from "this build does
      // not report coverage" — silence cannot carry that difference.
      L.push('  ' + c.dim(`Coverage          all ${T.calls} calls priced.`));
    }
    // THE EXCLUSION ON THE OTHER LEG, AND IT IS NOT COVERED BY THE LINE ABOVE.
    //
    // These rows priced perfectly — `unpriced` does not see them, and "all N calls priced"
    // is true of them. What has no rate is the model Cheaper would have routed them TO, so
    // pricing.js books no movement and the row contributes a 0 to the saving that is
    // indistinguishable, in the total, from a measured one. Printed in BOTH branches above
    // for that reason: a fully-priced scan can still be hiding this.
    //
    // The remedy is specific and so the ids are named. It is unreachable with the shipped
    // ROUTE_TARGET (policy_parity.test.js pins that every target is catalogued) and
    // reachable through a live /healthz map naming a model this catalog has never seen.
    if (Number(T.unpricedRoute) > 0) {
      // Recomputed from the same helper `claimOf` used, rather than inferred from
      // `tst === 'withheld'`: both legs can withhold, and a sentence naming the wrong
      // remedy is worse than no sentence at all.
      const routeWithheld = (() => {
        const rr = unpricedRouteRatioOf(T);
        return rr !== null && rr > UNPRICED_SUPPRESS_RATIO;
      })();
      const ids = Array.isArray(T.unpricedRouteModels) ? T.unpricedRouteModels : [];
      const shown = ids.slice(0, 3).join(', ');
      const more = ids.length > 3 ? ` +${ids.length - 3} more` : '';
      L.push('  ' + c.dim('Route unpriced    ') +
        c.amber(`${T.unpricedRoute} of ${T.calls} calls`) +
        c.dim(` · ${tokens(T.unpricedRouteTokens)} tokens`) +
        c.dim(' — a route WAS taken, but its target has no published rate'));
      L.push('  ' + c.dim('                  ') +
        c.dim('those rows book no saving — a missing figure, not a measured $0.00.') +
        (shown ? c.dim('  Catalog: ') + c.amber(shown + more) : ''));
      // AND WHEN THAT IS WHY THE MONEY IS GONE, SAY SO HERE.
      //
      // The withholding sentence above lives in the `unpriced > 0` branch, so a scan
      // withheld by the ROUTED leg alone would print `withheld` on four money lines with
      // "Coverage all N calls priced." as the only nearby explanation — which reads as a
      // contradiction, and is exactly the "labelled non-number with no label" this file
      // refuses elsewhere. Its own sentence, because its remedy is its own too: catalog the
      // target, not the model that ran. Both print when both legs crossed; they are two
      // facts with two fixes, and merging them would describe neither.
      if (tst === 'withheld' && routeWithheld) {
        L.push('  ' + c.dim('                  ') +
          c.amber('Dollars withheld: too much of this scan’s routing could not be priced to claim a figure.'));
      }
    }
  }
  if (T.annualizedSaved != null) {
    L.push('  ' + c.dim('Annualized        ') +
      (dollarCell(tst, T.annualizedSaved, loss ? c.red : c.green)) +
      (tst === 'value' ? c.green('/yr') : '') +
      c.dim(`  (extrapolated from ${report.opts.sinceDays}d)`));
  }
  L.push('');

  // Examples
  const ex = [];
  for (const h of report.harnesses) for (const e of h.examples || []) ex.push({ ...e, harness: h.label });
  ex.sort((a, b) => b.saved - a.saved);
  if (ex.length) {
    L.push('  ' + c.dim('Biggest opportunities (top-tier calls that didn’t need it):'));
    for (const e of ex.slice(0, 6)) {
      const tag = e.source === 'subagent' ? c.cyan('sub-agent') : c.dim('you');
      // These are per-row PRICED facts and survive an aggregate withholding — the
      // withholding is a statement about coverage, not about these rows. A signed row is
      // still signed: an example that would cost MORE is red, never a green "saving".
      //
      // "PRICED" HAS TWO LEGS HERE TOO, AND THE SENTENCE ABOVE ONLY EVER MEANT ONE. An
      // unpriceable row never becomes an example at all (examples are pushed from the
      // `est.downgraded` branch, which sits inside `est.priceable`), so for `unpriced` the
      // claim holds by construction. It does NOT hold for the routed leg: a row whose
      // MODEL is catalogued and whose TARGET is not is priceable, is downgraded, and does
      // become an example — carrying `saved === 0`, which this line rendered as a green
      // `$0.00` and filed under "Biggest opportunities". That is the aggregate defect this
      // file just stopped committing, published one block further down for the same row.
      //
      // Named, not dropped: an exclusion that disappears is indistinguishable from a row
      // that never existed, and the sort (descending `saved`) already keeps a 0 clear of
      // the real opportunities. `=== false` and not falsy, so an example object from a
      // build that predates the field is judged exactly as it was.
      const m = money(e.saved);
      const cell = e.routedPriceable === false
        ? c.amber('unpriced')
        : (m === null ? c.dim('—') : (e.saved < 0 ? c.red : c.green)(m));
      L.push('   ' + padVis(cell, 9) + ' ' +
        c.dim(pad(`${e.from}→${e.to}`, 13)) + tag + '  ' + c.dim(e.text));
    }
    L.push('');
  }

  if (T.estimatedCalls) {
    L.push('  ' + c.dim(`${T.estimatedCalls} call(s) had no logged token counts — estimated from prompt length.`));
  }
  L.push('  ' + c.dim('Assumes the model each call used was the intended ceiling; harness-auto-selected'));
  L.push('  ' + c.dim('models (titles, summaries) can nudge this. Install to measure the real thing:'));
  L.push('  ' + '  npx cheaper install --all  ' + c.dim('&&') + '  cheaper gateway start');
  L.push('');
  return L.join('\n');
}

// The per-harness coverage suffix: how much of THIS row's traffic the money beside it
// does not describe. Printed on every row that excluded anything — a row that silently
// dropped 198 of 200 calls used to be indistinguishable from one that priced all two.
function coverageNote(h) {
  const parts = [];
  const un = Number(h.unpriced);
  if (Number.isFinite(un) && un > 0) {
    const ratio = unpricedRatioOf(h);
    parts.push(c.amber(`${un}/${h.calls} not priced`) +
      c.dim(` · ${tokens(h.unpricedTokens)} tok`) +
      (ratio === null ? '' : c.dim(` (${pctOf(ratio)})`)));
  }
  // The routed-leg exclusion travels on the row too, and INDEPENDENTLY of the one above:
  // a row can be fully priced (nothing to report on the left) and still have contributed
  // a missing figure rather than a measured zero to the money beside it.
  const ur = Number(h.unpricedRoute);
  if (Number.isFinite(ur) && ur > 0) {
    parts.push(c.amber(`${ur}/${h.calls} route unpriced`));
  }
  return parts.join(c.dim(' · '));
}

module.exports = { render, money, tokens, claimOf, unpricedRatioOf,
                   unpricedRouteRatioOf, pctOf, UNPRICED_SUPPRESS_RATIO };
