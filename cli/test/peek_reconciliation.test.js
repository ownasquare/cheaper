'use strict';
// Regression tests for the TWO follow-ups left open by the same-tier-substitution fix
// (docs/parity-gates/same-tier-substitution-pricing.md, "Known follow-up").
//
//  P1. `downgradable` AND THE DOLLARS COUNTED DIFFERENT POPULATIONS, AND ONLY ONE WAS
//      PUBLISHED. `est.downgraded` is strictly TIER rank; every dollar comes from a MODEL
//      substitution. Once estimateCall stopped pricing a same-tier route as no route at
//      all, `dollarsSaved` could be non-zero while `downgradable` was 0 — and the two
//      surfaces that print them side by side (the per-harness table and the Total line)
//      invited a reader to derive X from N. Both numbers were TRUE; the PAIRING misled.
//
//      Fixed by publishing the second count rather than by widening the first:
//      `downgradable` still means exactly what its existing readers think it means, and
//      `substituted` — read from `est.substituted`, never re-derived — is the one the
//      money hangs off.
//
//  P2. `routedPriceable: false` WAS REPORTED PER ROW AND COUNTED NOWHERE. A row whose
//      ROUTE TARGET has no published rate books no dollar movement, which leaves a 0 in
//      the saving that is indistinguishable from a measured one. That is the exact failure
//      `unpriced` was added to fix, on the other leg. It is now counted into
//      `unpricedRoute` / `unpricedRouteTokens` / `unpricedRouteModels` and printed with
//      its remedy, which is specific: catalog THIS model.
//
// These live in their own file rather than being appended to peek.test.js /
// policy_parity.test.js because both of those were being rewritten by a concurrent agent
// while this change was made (see the handoff's concurrency note). Nothing here depends on
// a count that a catalog edit would move — the sweep below asserts an INVARIANT plus a
// non-vacuity floor, not a pinned population size — so it cannot collide with that work.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TIERS } = require('../src/peek/classify');
const { estimateCall, costOfModel } = require('../src/peek/pricing');
const { CATALOG } = require('../src/peek/models');
const { routerConfigFrom } = require('../src/freshness');
const { render, claimOf, unpricedRatioOf, unpricedRouteRatioOf,
        UNPRICED_SUPPRESS_RATIO } = require('../src/peek/render');

// A scan over a synthetic Claude Code history, driving the REAL scan.js — never a
// re-implementation of its accumulators, which is the thing under test. Same shape as
// policy_parity.test.js::scanFixture.
function scanFixture(turns, scanOpts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-recon-'));
  const proj = path.join(dir, '.claude', 'projects', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  const lines = [];
  let n = 0;
  for (const [prompt, model, inTok, outTok] of turns) {
    n++;
    lines.push({ type: 'user', message: { role: 'user', content: prompt },
                 timestamp: '2026-01-01T12:00:00Z' });
    lines.push({ type: 'assistant', isSidechain: false,
                 message: { id: 'a' + n, role: 'assistant', model,
                            content: [{ type: 'text', text: 'ok' }],
                            usage: { input_tokens: inTok, output_tokens: outTok } },
                 timestamp: '2026-01-01T12:00:0' + (n % 10) + 'Z' });
  }
  fs.writeFileSync(path.join(proj, 'sesX.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const savedHome = process.env.CHEAPER_PEEK_HOME;
  process.env.CHEAPER_PEEK_HOME = dir;
  try {
    for (const m of ['fsutil', 'adapters', 'scan']) delete require.cache[require.resolve('../src/peek/' + m)];
    const { scan } = require('../src/peek/scan');
    const rep = scan(Object.assign({ only: 'claude-code' }, scanOpts || {}));
    return { rep, h: rep.harnesses.find((x) => x.key === 'claude-code') };
  } finally {
    if (savedHome === undefined) delete process.env.CHEAPER_PEEK_HOME;
    else process.env.CHEAPER_PEEK_HOME = savedHome;
    fs.rmSync(dir, { recursive: true, force: true });
    for (const m of ['fsutil', 'adapters', 'scan']) delete require.cache[require.resolve('../src/peek/' + m)];
  }
}

// A resolved router config that varies only the knobs named, leaving everything else at
// the shipped default — same helper, same reason, as policy_parity.test.js::knobOnly.
function knobOnly(extra) {
  return routerConfigFrom(Object.assign({ ok: true, mode: 'heuristic' }, extra || {}));
}

// ANSI is presentation; the CLAIM is the text underneath.
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const lineWith = (out, label) =>
  plain(out).split('\n').find((l) => l.includes(label)) || '';

// The two prompts used throughout. Their content tiers are what make the fixtures the
// shapes they are, so they are named once rather than repeated as literals.
const SECURITY = 'audit the auth flow for a security vulnerability';  // -> opus
const REFACTOR = 'please refactor the pagination endpoint';           // -> sonnet
const TRIVIAL  = 'rename foo to bar';                                 // -> haiku

// ---------------------------------------------------------------------------
// P1 — the count the dollars hang off
// ---------------------------------------------------------------------------

test('scan: a same-tier substitution is COUNTED, not only banked', () => {
  // THE SHAPE THE OLD SURFACE COULD NOT EXPLAIN: `downgradable === 0` beside a real,
  // bankable, non-zero saving. A `claude-opus-4` caller asking a security question is
  // served `claude-opus-5` — same opus tier, so no downgrade — at $90.00 -> $30.00 on a
  // 1M/1M call. Before this change the screen said "0 downgradable ... you'd save $60.00"
  // and offered the reader nothing to reconcile the two with.
  const { rep, h } = scanFixture([[SECURITY, 'claude-opus-4', 1e6, 1e6]]);
  assert.equal(h.calls, 1);
  assert.equal(h.unpriced, 0, 'the row prices perfectly — nothing is excluded here');
  assert.equal(h.downgradable, 0, 'no TIER moved: opus -> opus');
  assert.equal(h.tokensOnDowngradable, 0);
  // The new counter, and the tokens that go with it.
  assert.equal(h.substituted, 1, 'a DIFFERENT MODEL was served, and that is what pays');
  assert.equal(h.tokensOnSubstituted, 2e6);
  // ...and it is the count the money reconciles against.
  assert.ok(Math.abs(h.dollarsSaved - 60) < 1e-9, 'dollarsSaved=' + h.dollarsSaved);
  assert.ok(Math.abs(h.dollarsGross - 60) < 1e-9);
  assert.equal(h.dollarsExtra, 0);
  // Totals carry both, so a consumer reading only `rep.totals` is not handed the half of
  // the pair that cannot explain the dollars.
  assert.equal(rep.totals.downgradable, 0);
  assert.equal(rep.totals.substituted, 1);
  assert.equal(rep.totals.tokensOnSubstituted, 2e6);
});

test('scan: a downgrade and a same-tier substitution are counted SEPARATELY', () => {
  // Both populations present at once — the fixture the follow-up asked for. The trivial
  // row moves a TIER (opus -> haiku, $90.00 -> $6.00) and the security row moves only a
  // MODEL (opus-4 -> opus-5, $90.00 -> $30.00). One count cannot describe both.
  const { rep, h } = scanFixture([
    [TRIVIAL, 'claude-opus-4', 1e6, 1e6],
    [SECURITY, 'claude-opus-4', 1e6, 1e6],
  ]);
  assert.equal(h.calls, 2);
  assert.equal(h.downgradable, 1, 'only the trivial row changes tier');
  assert.equal(h.substituted, 2, 'BOTH rows are served a different model');
  assert.equal(h.tokensOnDowngradable, 2e6);
  assert.equal(h.tokensOnSubstituted, 4e6, 'the volume the money describes, not the tier');
  // $84.00 from the downgrade + $60.00 from the substitution. The second was reported as
  // $0.00 before the pricing fix and was unattributable to any published count until now.
  assert.ok(Math.abs(h.dollarsSaved - 144) < 1e-9, 'dollarsSaved=' + h.dollarsSaved);
  assert.equal(rep.totals.downgradable, 1);
  assert.equal(rep.totals.substituted, 2);
});

test('THE RECONCILIATION INVARIANT: no substitution, no dollar — catalog-wide', () => {
  // This is what makes `substituted` the honest partner of the money and `downgradable`
  // not: `saved` is `baselineCost - newCost`, and `newCost` differs from `baselineCost`
  // ONLY on a substituted row whose target we could price. So the count going to zero
  // FORCES the dollars to zero. `downgradable` carries no such implication in either
  // direction, which is precisely why it could sit at 0 beside $60.00.
  //
  // Swept rather than argued, over every catalog model × content tier × four router
  // configurations, including two that re-point the map. No population size is pinned
  // here — a catalog edit may legitimately move it — only the implication, plus a floor
  // that stops the whole sweep from passing because it matched nothing.
  const configs = [
    ['shipped defaults', null],
    ['legacy openai map', knobOnly({
      openai_models: { haiku: 'gpt-4o-mini', sonnet: 'gpt-4o', opus: 'o3' } })],
    ['operator anthropic map', knobOnly({
      models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-4-5', opus: 'claude-opus-5' } })],
    ['min_tier=sonnet', knobOnly({ min_tier: 'sonnet' })],
  ];
  let substituted = 0;
  let quiet = 0;
  for (const [label, router] of configs) {
    for (const entry of CATALOG) {
      for (const content of TIERS) {
        const e = estimateCall(entry.id, 1e6, 1e6, content, router ? { router } : undefined);
        if (!e.priceable) continue;
        if (e.substituted) {
          substituted++;
          continue;
        }
        quiet++;
        const where = `${label}: ${entry.id}/${content}`;
        // The implication, stated three ways because a suppression can hide in any one of
        // them: the cost, the signed delta, and the decomposition the surface prints.
        assert.equal(e.newCost, e.baselineCost, where + ' moved a cost without substituting');
        assert.equal(e.saved, 0, where + ' booked a saving without substituting');
        assert.equal(e.gross, 0, where);
        assert.equal(e.extra, 0, where);
      }
    }
  }
  // Non-vacuity, both ways: a sweep that matched no substitutions would prove nothing, and
  // one that matched no quiet rows would not have exercised the implication at all.
  assert.ok(substituted > 50, 'the sweep must actually contain substitutions: ' + substituted);
  assert.ok(quiet > 50, 'the sweep must actually contain non-substitutions: ' + quiet);
});

test('peek render: BOTH counts reach the screen, and the money names its own partner', () => {
  // Driving the real renderer over a real scan report — not a hand-built fixture, which
  // could state a pairing the scanner never produces.
  const { rep } = scanFixture([[SECURITY, 'claude-opus-4', 1e6, 1e6]]);
  const out = plain(render(rep));

  // The Total line carries the tier count AND the model count, so the reader can see
  // which one the dollars belong to instead of inferring from the only one on offer.
  const total = lineWith(out, 'Total');
  assert.match(total, /0 downgradable/, total);
  assert.match(total, /1 re-routed/, total);

  // The reconciliation line, printed because the two disagree — which is exactly when a
  // reader who assumed they were one number would be wrong. It claims no containment
  // between the sets, because there is none in either direction.
  const routing = lineWith(out, 'Routing');
  assert.match(routing, /1 call\(s\) re-routed to a different MODEL/, routing);
  assert.match(routing, /0 to a cheaper TIER/, routing);
  assert.ok(!/of which/.test(routing), 'must not claim one set contains the other: ' + routing);

  // THE VOLUME BESIDE THE MONEY IS THE MONEY'S OWN VOLUME. This read
  // `tokensOnDowngradable`, which is 0 for this scan — so the line said
  // "$60.00 ... · 0 tokens re-routable", a figure and its own volume contradicting each
  // other on one line.
  const saved = lineWith(out, 'Could have saved');
  assert.match(saved, /\$60\.00/, saved);
  assert.match(saved, /2\.0M tokens re-routable/, saved);
  assert.ok(!/0 tokens re-routable/.test(saved),
    'the tier volume must not be printed beside the substitution money: ' + saved);

  // The per-harness table publishes the same pair, under a named column.
  assert.match(out, /re-routed/, out);
  assert.match(out, /1 \(100%\)/, out);
});

test('peek render: the reconciliation line is silent when there is nothing to reconcile', () => {
  // A pure downgrade — one tier move, one substitution, both counts equal to 1. The extra
  // line exists to resolve a contradiction; printing it when none exists is noise, and
  // noise on a money surface is how real qualifiers stop being read.
  const { rep } = scanFixture([[TRIVIAL, 'claude-opus-4', 1e6, 1e6]]);
  const out = plain(render(rep));
  assert.equal(rep.totals.downgradable, 1);
  assert.equal(rep.totals.substituted, 1);
  assert.ok(!/^\s*Routing\s/m.test(out), 'no reconciliation was needed: ' + out);
  assert.match(lineWith(out, 'Could have saved'), /\$84\.00/, out);
});

// ---------------------------------------------------------------------------
// P2 — the routed leg's own exclusion
// ---------------------------------------------------------------------------

test('scan: an UNPRICEABLE route target is a COUNTED exclusion, not a silent zero', () => {
  // The row prices perfectly on the leg that RAN, so `unpriced` never sees it. What has no
  // published rate is the model the gateway would route it TO, so pricing.js refuses to
  // invent one and books no movement — correct, and previously invisible: the 0 it leaves
  // behind was added to a total full of measured zeros with nothing to tell them apart.
  //
  // Reachable exactly as documented: a live /healthz map naming a model this catalog has
  // never seen. The shipped ROUTE_TARGET cannot produce it.
  const router = knobOnly({
    models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-internal-v9', opus: 'claude-opus-5' },
  });
  const { rep, h } = scanFixture([[REFACTOR, 'claude-opus-5', 1e6, 1e6]], { router });
  assert.equal(h.calls, 1);
  // A DIFFERENT EXCLUSION FROM `unpriced`, and it must not be folded into it: the remedies
  // are on different legs. The actual model is catalogued, so `unpriced` is correctly 0 —
  // and that is exactly why this bucket had to exist rather than reusing that one.
  assert.equal(h.unpriced, 0, 'the model that RAN is catalogued');
  assert.equal(h.unpricedTokens, 0);
  // The new bucket: counted, tokenised, and NAMED, because the remedy is specific.
  assert.equal(h.unpricedRoute, 1);
  assert.equal(h.unpricedRouteTokens, 2e6);
  assert.deepEqual(h.unpricedRouteModels, ['claude-internal-v9']);
  // A route really was taken — this is not a passthrough, and the substitution count says
  // so. It is the PRICE of the target that is missing, not the route.
  assert.equal(h.substituted, 1);
  // ...and no dollar moved. Before the pricing fix this row fabricated the entire
  // baseline as a saving; it must stay at zero, and the zero must stay explained.
  assert.equal(h.dollarsSaved, 0);
  assert.equal(h.dollarsGross, 0);
  assert.equal(h.dollarsExtra, 0);
  // Totals fold the bucket and publish its coverage ratio next to the money it qualifies.
  assert.equal(rep.totals.unpricedRoute, 1);
  assert.equal(rep.totals.unpricedRouteTokens, 2e6);
  assert.deepEqual(rep.totals.unpricedRouteModels, ['claude-internal-v9']);
  assert.equal(rep.totals.unpricedRouteRatio, 1, 'every token seen hit this exclusion');
  assert.equal(rep.totals.unpricedRatio, 0, 'and none of it was the OTHER exclusion');
});

test('peek render: a route we could not price is NAMED, with its remedy', () => {
  const router = knobOnly({
    models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-internal-v9', opus: 'claude-opus-5' },
  });
  const { rep } = scanFixture([[REFACTOR, 'claude-opus-5', 1e6, 1e6]], { router });
  const out = plain(render(rep));

  // Counted, in calls and in tokens, on the surface people actually read.
  const line = lineWith(out, 'Route unpriced');
  assert.match(line, /1 of 1 calls/, line);
  assert.match(line, /2\.0M tokens/, line);
  assert.match(line, /no published rate/, line);
  // The remedy is specific, so the id is printed. "Catalog this model" is actionable;
  // "some route could not be priced" is not.
  assert.match(out, /claude-internal-v9/, out);
  // The zero is explained as a MISSING figure rather than left to read as a measured one.
  assert.match(out, /not a measured \$0\.00/, out);

  // AND IT IS NOT COVERED BY THE COVERAGE LINE. "all 1 calls priced" is TRUE of the leg
  // that ran, which is exactly why this exclusion had to be printed in its own right —
  // a fully-priced scan can still be hiding it.
  assert.match(out, /Coverage +all 1 calls priced\./, out);
  // The per-harness row carries it too, so a multi-harness scan can attribute it.
  assert.match(out, /1\/1 route unpriced/, out);
});

// ---------------------------------------------------------------------------
// P3 — the routed leg reaches the CLAIM, not only the coverage lines
//
// Counting the exclusion (P2 above) made it legible. It did not make the surface stop
// PUBLISHING the figure the exclusion invalidates: a scan whose every route target was
// unpriceable still rendered `Could have saved $0.00` as a claim, with the explanation
// printed underneath it. render.js's own header states invariant 4 — an unpriceable figure
// must render as a LABELLED NON-NUMBER, never $0.00 — and a route-unpriceable row satisfied
// the LETTER of that rule (`unpriced === 0`) while breaking its spirit, because `claimOf`
// predates `unpricedRoute` and could only see the leg that RAN.
//
// The fix is one extra clause against the SAME constant, in the same predicate. These tests
// pin BOTH directions, because a rule that withholds is only correct if it also releases:
// the withholding case, and the "there are real measured dollars here — print them" case.
// ---------------------------------------------------------------------------

// The two labels whose money is decided by `claimOf`. `Spent on record` and `At today's
// rates` are governed by it too, but these are the two the claim is actually ABOUT.
const MONEY_LABELS = ['Spent on record', 'At today’s rates', 'Could have saved',
                      'You’d still pay'];

// The operator map that makes the sonnet slot unpriceable — a live /healthz naming a model
// this catalog has never seen, which is the only way to reach any of this. The haiku and
// opus slots stay catalogued so a fixture can mix priced and unpriced ROUTES at will.
const UNPRICEABLE_SONNET_SLOT = {
  models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-internal-v9', opus: 'claude-opus-5' },
};

test('claimOf: ONE threshold governs both legs — not two constants that can drift', () => {
  // The two ratios answer the same question about different legs and are held to the same
  // number. Two constants would be two things to tune, and the second one to be tuned is
  // the one that stops matching. Pinned structurally so a future edit that introduces a
  // separate route threshold has to delete this test on purpose.
  assert.equal(UNPRICED_SUPPRESS_RATIO, 0.20);
  const at = (unpricedTokens, unpricedRouteTokens) => ({
    calls: 10, unpriced: unpricedTokens ? 1 : 0, tokens: 100,
    unpricedTokens, unpricedRouteTokens,
  });
  // Same denominator, so the two are directly comparable...
  assert.equal(unpricedRatioOf(at(21, 0)), 0.21);
  assert.equal(unpricedRouteRatioOf(at(0, 21)), 0.21);
  // ...and the same verdict either side of the same line.
  assert.equal(claimOf(at(0, 21)), 'withheld', 'route leg, just over');
  assert.equal(claimOf(at(0, 20)), 'value', 'route leg, exactly at — strictly greater');
  assert.equal(claimOf(at(21, 0)), 'withheld', 'actual leg, just over');
  assert.equal(claimOf(at(20, 0)), 'value', 'actual leg, exactly at');
});

test('claimOf: a payload without the route counters is judged EXACTLY as before', () => {
  // `peek --json` is consumed outside this repo and the field is new. An absent counter is
  // a payload that cannot say whether its routes were priceable, and a 0 would say they
  // were — so the ratio is null and the clause does not fire. A report written by an older
  // build must not start reading "withheld" because a newer renderer re-scored it against
  // a field it never published.
  const legacy = { calls: 10, tokens: 100, unpriced: 0, unpricedTokens: 0 };
  assert.equal(unpricedRouteRatioOf(legacy), null, 'no counters => no ratio, never 0');
  assert.equal(claimOf(legacy), 'value');
  // And a zero-token payload cannot form either ratio — no division, no accidental verdict.
  assert.equal(unpricedRouteRatioOf({ calls: 3, tokens: 0, unpricedRouteTokens: 0 }), null);
});

test('claimOf: a 100%-route-unpriceable scan WITHHOLDS — no $0.00 anywhere it is money', () => {
  // The defect this closes, driven end to end through the real scanner and the real
  // renderer. Every row prices; every row's ROUTE target does not. `dollarsSaved` is
  // therefore exactly 0 — and that 0 is a missing figure, sitting in a total whose other
  // zeros would have been measured.
  const { rep } = scanFixture([[REFACTOR, 'claude-opus-5', 1e6, 1e6]],
    { router: knobOnly(UNPRICEABLE_SONNET_SLOT) });

  // The precondition: the OTHER leg is spotless, which is exactly why `claimOf` could not
  // see this. If this assertion ever fails the test is proving something else.
  assert.equal(rep.totals.unpriced, 0, 'the model that RAN is catalogued');
  assert.equal(rep.totals.unpricedRatio, 0);
  assert.equal(rep.totals.unpricedRouteRatio, 1, 'and every token seen hit the OTHER leg');
  assert.equal(rep.totals.dollarsSaved, 0, 'the vacuous zero under test');

  assert.equal(claimOf(rep.totals), 'withheld');
  const out = plain(render(rep));

  // No money line prints a figure. Asserted per LINE, not over the whole screen: the
  // explanatory sentence legitimately contains the characters "$0.00" while explaining
  // that no such figure was measured, and a naive whole-output regex would confuse the
  // explanation with the claim it exists to prevent.
  for (const label of MONEY_LABELS) {
    const line = lineWith(out, label);
    assert.match(line, /withheld/, label + ': ' + line);
    assert.ok(!/\$\d/.test(line), 'a missing figure was printed as money: ' + line);
  }
  // The per-harness row too — the table cell is decided by the same predicate.
  assert.ok(!/\$0\.00 \//.test(out), 'the harness row still published the pair: ' + out);

  // AND THE WITHHOLDING IS EXPLAINED, BY THE LEG THAT CAUSED IT. Without this the screen
  // reads "all 1 calls priced" directly above four withheld figures, which is a
  // contradiction to anyone who has not read pricing.js.
  assert.match(out, /Dollars withheld: too much of this scan’s routing could not be priced/, out);
  // The other leg's sentence must NOT appear: it names the wrong remedy. "Too little of
  // this scan could be priced" is false here — all of it priced.
  assert.ok(!/too little of this scan could be priced/.test(out),
    'the wrong remedy was named: ' + out);
  // Coverage of the leg that ran is still reported affirmatively, because it is still true.
  assert.match(out, /Coverage +all 1 calls priced\./, out);
  // ...and the count, the tokens and the model id all still travel with it (P2 intact).
  assert.match(lineWith(out, 'Route unpriced'), /1 of 1 calls/, out);
  assert.match(out, /claude-internal-v9/, out);
});

test('claimOf: real measured dollars are RELEASED, not swept up by the new clause', () => {
  // THE DIRECTION THAT MATTERS MOST. A rule that withholds is only honest if it also
  // releases: a small route-unpriceable tail beside a large measured saving must print the
  // saving and carry the qualifier, exactly as a small `unpriced` tail already does.
  //
  // The security row (opus content on `claude-opus-4`) is served `claude-opus-5` — priced,
  // $90.00 -> $30.00 on 1M/1M. The refactor row (sonnet content on `claude-opus-5`) is
  // served the uncatalogued sonnet slot and books nothing. Sized so the unpriceable route
  // is ~9% of the tokens seen: real, counted, printed, and below the line.
  const { rep } = scanFixture([
    [SECURITY, 'claude-opus-4', 1e6, 1e6],
    [REFACTOR, 'claude-opus-5', 1e5, 1e5],
  ], { router: knobOnly(UNPRICEABLE_SONNET_SLOT) });

  assert.equal(rep.totals.unpricedRoute, 1, 'the tail is real and counted');
  assert.ok(rep.totals.unpricedRouteRatio > 0, 'and non-zero');
  assert.ok(rep.totals.unpricedRouteRatio < UNPRICED_SUPPRESS_RATIO,
    'but below the line: ' + rep.totals.unpricedRouteRatio);
  assert.ok(Math.abs(rep.totals.dollarsSaved - 60) < 1e-9,
    'measured dollars: ' + rep.totals.dollarsSaved);

  assert.equal(claimOf(rep.totals), 'value', 'a measured $60.00 must not be suppressed');
  const out = plain(render(rep));
  assert.match(lineWith(out, 'Could have saved'), /\$60\.00/, out);
  // The qualifier still rides along — released is not the same as unqualified.
  assert.match(lineWith(out, 'Route unpriced'), /1 of 2 calls/, out);
  assert.ok(!/Dollars withheld/.test(out), 'nothing was withheld here: ' + out);
});

test('claimOf: the same two rows, re-weighted past the line, WITHHOLD', () => {
  // The pair above, with the unpriceable-route row weighted to half the tokens instead of
  // a twentieth. Nothing about the scan changes except how much of the evidence is missing
  // — which is the only thing the rule is allowed to be sensitive to. A rule that fired on
  // the mere PRESENCE of `unpricedRoute > 0` would have withheld the previous test's real
  // $60.00; this pair is what tells the two rules apart.
  const { rep } = scanFixture([
    [SECURITY, 'claude-opus-4', 1e6, 1e6],
    [REFACTOR, 'claude-opus-5', 1e6, 1e6],
  ], { router: knobOnly(UNPRICEABLE_SONNET_SLOT) });

  assert.equal(rep.totals.unpricedRoute, 1);
  assert.ok(rep.totals.unpricedRouteRatio > UNPRICED_SUPPRESS_RATIO,
    'over the line: ' + rep.totals.unpricedRouteRatio);
  // There ARE measured dollars in this scan — and they describe half the evidence, which is
  // the same standard `unpriced` has always been held to. Withholding here is the rule
  // being consistent, not the rule being blunt.
  assert.ok(Math.abs(rep.totals.dollarsSaved - 60) < 1e-9);
  assert.equal(claimOf(rep.totals), 'withheld');

  const out = plain(render(rep));
  assert.match(lineWith(out, 'Could have saved'), /withheld/, out);
  assert.ok(!/\$60\.00/.test(lineWith(out, 'Could have saved')), out);
  assert.match(out, /Dollars withheld: too much of this scan’s routing/, out);
});

test('examples: a row whose ROUTE could not be priced is not a "$0.00 opportunity"', () => {
  // FOUND BY LOOKING AT THE RENDERED SCREEN AFTER THE WITHHOLDING LANDED, NOT BY A TEST.
  // With every money line correctly reading `withheld`, the examples block two lines below
  // still printed `$0.00  opus→sonnet` in green, under the heading "Biggest opportunities"
  // — the same fabricated zero, for the same row, on the same screen.
  //
  // The old justification ("these are per-row PRICED facts") was true of `unpriced`, which
  // can never produce an example, and false of the routed leg, which can: this row's MODEL
  // is catalogued, so it is priceable and downgraded and becomes an example, and its
  // `saved` is 0 because the TARGET has no rate.
  const { rep } = scanFixture([[REFACTOR, 'claude-opus-5', 1e6, 1e6]],
    { router: knobOnly(UNPRICEABLE_SONNET_SLOT) });

  // The row really is an example — it downgrades opus -> sonnet — and it really does carry
  // a zero. If either stops being true this test is no longer exercising the defect.
  const h = rep.harnesses.find((x) => x.key === 'claude-code');
  assert.equal(h.examples.length, 1, 'the fixture must still produce an example');
  assert.equal(h.examples[0].saved, 0);
  assert.equal(h.examples[0].routedPriceable, false,
    'scan.js must carry the routed-leg verdict onto the row');

  const out = plain(render(rep));
  const line = plain(out).split('\n').find((l) => /opus→sonnet/.test(l)) || '';
  assert.ok(line, 'the example row must still be printed, not dropped: ' + out);
  assert.match(line, /unpriced/, 'the missing figure must be labelled: ' + line);
  assert.ok(!/\$0\.00/.test(line),
    'a missing figure was filed as a measured opportunity: ' + line);
});

test('examples: a MEASURED zero is still printed as $0.00, and an older row is untouched', () => {
  // The other direction, and the reason the discriminator is `routedPriceable === false`
  // rather than `saved === 0`. A priced target that happens to cost exactly what the
  // caller's model costs is a real, measured "routing changes nothing" — it must keep its
  // figure. And an example object from a build that predates the field must render exactly
  // as it always did, which strict `=== false` (not falsy) is what guarantees.
  const rep = {
    opts: { sinceDays: 0 },
    harnesses: [{ key: 'k', label: 'Claude Code', status: 'supported', calls: 2,
                  downgradable: 2, substituted: 2, tokens: 100, unpriced: 0,
                  unpricedTokens: 0, unpricedRoute: 0, unpricedRouteTokens: 0,
                  dollarsActual: 1, dollarsBaseline: 1, dollarsSaved: 0,
                  dollarsGross: 0, dollarsExtra: 0, offsetCalls: 0,
                  bySource: { user: 2, subagent: 0 },
                  examples: [
                    // measured: priced target, genuinely no change
                    { from: 'opus', to: 'sonnet', saved: 0, source: 'user',
                      routedPriceable: true, text: 'measured no-op' },
                    // legacy: the field does not exist at all
                    { from: 'opus', to: 'haiku', saved: 0, source: 'user',
                      text: 'legacy row' },
                  ] }],
    totals: { calls: 2, downgradable: 2, substituted: 2, tokens: 100, unpriced: 0,
              unpricedTokens: 0, unpricedRatio: 0, unpricedRoute: 0,
              unpricedRouteTokens: 0, unpricedRouteRatio: 0,
              dollarsActual: 1, dollarsBaseline: 1, dollarsSaved: 0, savedPct: 0,
              dollarsGross: 0, dollarsExtra: 0, offsetCalls: 0,
              tokensOnSubstituted: 100, annualizedSaved: null,
              bySource: { user: 2, subagent: 0 } },
  };
  const out = plain(render(rep));
  const measured = out.split('\n').find((l) => /measured no-op/.test(l)) || '';
  const legacy = out.split('\n').find((l) => /legacy row/.test(l)) || '';
  assert.match(measured, /\$0\.00/, 'a measured zero is a real figure: ' + measured);
  assert.ok(!/unpriced/.test(measured), measured);
  assert.match(legacy, /\$0\.00/, 'an older payload must not be re-judged: ' + legacy);
});

test('peek render: a clean scan prints NEITHER follow-up line', () => {
  // The counters must be silent when they have nothing to say. A qualifier that always
  // appears is a qualifier nobody reads.
  const { rep } = scanFixture([[TRIVIAL, 'claude-opus-4', 1e6, 1e6]]);
  const out = plain(render(rep));
  assert.equal(rep.totals.unpricedRoute, 0);
  assert.ok(!/Route unpriced/.test(out), out);
  assert.ok(!/route unpriced/.test(out), out);
});
