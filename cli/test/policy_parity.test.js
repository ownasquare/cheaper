'use strict';
// Regression tests for the ROUTE-TARGET unification and the routing-policy port.
//
// Two defects live behind these tests:
//
//  1. THREE TABLES ANSWERED ONE QUESTION. "Which model does a downgrade land on" was
//     answered by ROUTE_TARGET (cli/src/peek/pricing.js), by RouterConfig.models
//     (gateway/app/router.py) and by OPENAI_MODELS (gateway/app/app.py), with no gate
//     between them — so `peek` priced the counterfactual leg against models the gateway
//     never serves. ROUTE_TARGET is now the single source of truth and is projected into
//     the generated gateway table under `route_targets`.
//
//  2. `peek` MODELLED ONE OF THE ROUTER'S FIVE RULES. classify.effectiveTier() applied
//     the requested-model ceiling and nothing else — no min_tier floor, no
//     allow_upgrade_above_requested, no DOLLAR ceiling, no passthrough. Every missing
//     rule bends the estimate: see the long note above routeDecision() in classify.js.
//     classify.routeDecision() is now a port of router.decide(), and estimateCall()
//     asks IT what the router would do instead of assuming the downgrade always happens.
//
// The cross-runtime half of this lives in scripts/check-policy-parity.js, which drives
// BOTH runtimes over a shared corpus. These tests cover the JS side's own invariants,
// which is what a Node test file can prove without spawning Python.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  TIERS, rank, contentTier, modelTier, requestedTier, mapFamily, routeDecision,
  LONG_REQUEST_CHARS, COOCCURRENCE_WINDOW,
} = require('../src/peek/classify');
const {
  ROUTE_TARGET, ROUTE_TARGET_BY_TIER, BUCKET, estimateCall, costOfModel,
  ROUTABLE_FAMILIES, isRoutableFamily, detectFamily, sameModel,
} = require('../src/peek/pricing');
const { CATALOG } = require('../src/peek/models');
const {
  routerConfigFrom, tierMapOrNull, boolOrNull, HEALTHZ_ROUTER_KEY, ROUTER_ASSUMED_DEFAULTS,
} = require('../src/freshness');

// The Anthropic targets, used as a stand-in for "a well-ordered family map" in the
// config-driven tests below.
const ANTHROPIC = ROUTE_TARGET_BY_TIER.anthropic;

// ---------------------------------------------------------------------------
// 1. ONE SOURCE OF TRUTH FOR ROUTE TARGETS
// ---------------------------------------------------------------------------

test('ROUTE_TARGET_BY_TIER is a projection of ROUTE_TARGET, not a second copy', () => {
  // A hand-written tier-keyed table would be the fourth copy of the same question and
  // would drift exactly as the first three did. It must be DERIVED.
  assert.deepEqual(Object.keys(ROUTE_TARGET_BY_TIER).sort(),
    Object.keys(ROUTE_TARGET).sort());
  for (const fam of Object.keys(ROUTE_TARGET)) {
    for (const tier of TIERS) {
      assert.equal(ROUTE_TARGET_BY_TIER[fam][tier], ROUTE_TARGET[fam][BUCKET[tier]],
        `${fam}.${tier} must equal ROUTE_TARGET.${fam}.${BUCKET[tier]}`);
    }
  }
});

test('the generated gateway table carries route_targets, byte-equal to the JS table', () => {
  // This is the gate that closes defect 1: the gateway can only stop hardcoding its own
  // tier maps if the generated JSON really carries them. sync-prices.js --check already
  // fails when the file is stale; this asserts the CONTENT is the thing the gateway
  // needs, under the exact key name router.py / app.py are told to read.
  const doc = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../assets/gateway/app/model_prices.json'), 'utf8'));
  assert.ok(doc.route_targets, 'model_prices.json must expose `route_targets`');
  assert.deepEqual(doc.route_targets, ROUTE_TARGET_BY_TIER);
  // Tier names, not bucket names — the gateway speaks haiku/sonnet/opus everywhere.
  for (const fam of Object.keys(doc.route_targets)) {
    assert.deepEqual(Object.keys(doc.route_targets[fam]), TIERS.slice(),
      `${fam} must be keyed by tier name in the order ${TIERS.join('/')}`);
  }
});

test('every route target names a catalogued model, and never one ABOVE its slot', () => {
  // A target MORE capable than the slot it fills spends the user's money to close a gap
  // they did not ask to have closed. That rule is absolute and has no exceptions.
  //
  // A target BELOW its slot is the defect pointed the other way — a request is answered
  // one tier down while being reported at the tier the caller asked for. It is only
  // legitimate when the family publishes nothing of that tier at all. The exact set is
  // pinned here so the test bites in BOTH directions: a NEW below-slot target fails, and
  // so does a listed one that someone silently corrects without updating the ledger in
  // scripts/sync-prices.js, where each entry's blocker is recorded.
  //
  //   deepseek.sonnet  LEGITIMATE — DeepSeek ships exactly two SKUs (flash = haiku,
  //                    pro = opus), so its mid slot has nothing of its own to name.
  //
  // THE LIST IS NOW EXACTLY ONE ENTRY, AND EVERY ENTRY ON IT IS LEGITIMATE. It carried
  // two more until 2026-08-09, both defects and both Mistral:
  //   mistral.sonnet   was 'mistral-small-4'    (tier haiku)  — mistral publishes real
  //                    sonnet-tier models, so the slot was answering a mid request one
  //                    tier down while reporting it as mid.
  //   mistral.opus     was 'mistral-medium-3.5' (tier sonnet) — an auto-escalated hard
  //                    request answered by a MID-capability model while reported as top.
  // Both are FIXED, not re-ledgered: the slots now name 'mistral-medium-3.5' and
  // 'mistral-large-3'. The blocker recorded against them in scripts/sync-prices.js was a
  // `mid <= top` PRICE assertion in peek.test.js, which inferred capability order from
  // price for the one family whose catalog says the two invert; it has been replaced by a
  // direct per-slot tier assertion. Do not re-add either entry here to make a red run
  // green — a below-slot target that is not a genuine published-tier gap is a defect, and
  // this ledger is where that claim gets made explicitly.
  const EXPECTED_BELOW_SLOT = ['deepseek.sonnet'];
  const below = [];
  for (const fam of Object.keys(ROUTE_TARGET_BY_TIER)) {
    for (const tier of TIERS) {
      const id = ROUTE_TARGET_BY_TIER[fam][tier];
      const entry = CATALOG.find((e) => e.id === id);
      assert.ok(entry, `${fam}.${tier} -> '${id}' is not in the catalog`);
      assert.ok(rank(entry.tier) <= rank(tier),
        `${fam}.${tier} -> '${id}' is tier '${entry.tier}', ABOVE the slot it fills`);
      if (rank(entry.tier) < rank(tier)) below.push(`${fam}.${tier}`);
    }
  }
  assert.deepEqual(below.sort(), EXPECTED_BELOW_SLOT);
});

// ---------------------------------------------------------------------------
// 2. THE ROUTER RULES peek USED TO IGNORE
// ---------------------------------------------------------------------------

test('routeDecision: the requested model is a ceiling', () => {
  const d = routeDecision('review this for security holes', 'claude-haiku-4-5',
    { models: ANTHROPIC });
  assert.equal(d.tier, 'haiku');
  assert.equal(d.model, ANTHROPIC.haiku);
  assert.match(d.reason, /capped to requested 'haiku'/);
});

test('routeDecision: min_tier is a FLOOR, and it raises the estimate', () => {
  // ROUTER_MIN_TIER=sonnet on a gateway means haiku is never routed to. peek modelled no
  // floor at all, so it reported haiku-tier savings that gateway could not deliver.
  const low = routeDecision('hi', 'claude-opus-5', { models: ANTHROPIC });
  assert.equal(low.tier, 'haiku');
  const floored = routeDecision('hi', 'claude-opus-5',
    { models: ANTHROPIC, minTier: 'sonnet' });
  assert.equal(floored.tier, 'sonnet');
  assert.match(floored.reason, /raised to min_tier 'sonnet'/);
  // The floor really costs money: the sonnet target is dearer than the haiku one.
  const toks = { inFresh: 1e6, outTok: 1e6 };
  assert.ok(costOfModel(floored.model, toks) > costOfModel(low.model, toks));
});

test('routeDecision: allow_upgrade_above_requested disables BOTH ceilings', () => {
  const capped = routeDecision('audit this for security holes', 'claude-haiku-4-5',
    { models: ANTHROPIC });
  assert.equal(capped.tier, 'haiku');
  const upgraded = routeDecision('audit this for security holes', 'claude-haiku-4-5',
    { models: ANTHROPIC, allowUpgradeAboveRequested: true });
  assert.equal(upgraded.tier, 'opus');
  assert.equal(upgraded.model, ANTHROPIC.opus);
  // ...which is a SPEND increase, which is exactly why the flag defaults to false.
  const toks = { inFresh: 1e6, outTok: 1e6 };
  assert.ok(costOfModel(upgraded.model, toks) > costOfModel(capped.model, toks));
});

test('routeDecision: the DOLLAR ceiling walks down past a costlier target', () => {
  // A gateway with ROUTER_MODEL_SONNET pointed at an expensive model. Tier rank says
  // "sonnet is the cheaper tier"; the money says otherwise, and money wins.
  //
  // TWO moderate signals, not one. Under the scored classifier a lone /refactor/ is one
  // signal and min_moderate_signals is 2, so the old single-signal fixture classified
  // haiku and never reached the ceiling this test exists to exercise.
  const models = { haiku: 'claude-haiku-4-5', sonnet: 'claude-opus-5', opus: 'claude-opus-5' };
  const d = routeDecision('refactor this module and write tests for it',
    'claude-sonnet-5', { models });
  assert.equal(d.tier, 'haiku', d.reason);
  assert.equal(d.model, 'claude-haiku-4-5');
  assert.match(d.reason, /dollar ceiling/);
});

test('the QUALITY FLOOR stops the dollar walk-down on a hard request', () => {
  // The trade this product must never make: buying the money invariant with a quality
  // breach. A caller on an unrecognised-but-expensive model asking a concurrency question
  // must not be answered on haiku just because haiku is cheap.
  const models = { haiku: 'claude-haiku-4-5', sonnet: 'claude-opus-4-1', opus: 'claude-opus-4-1' };
  // Not hard: "refactor" is a workload signal, so the walk-down is allowed to reach haiku.
  const soft = routeDecision('refactor this module', 'claude-sonnet-5', { models });
  assert.equal(soft.tier, 'haiku', soft.reason);
  // Hard: same models, same requested model, same money — but a correctness-critical
  // category, so the floor sits at opus and every cheaper tier is vetoed.
  const hard = routeDecision('is this deadlock-free if I take the locks in order?',
    'claude-sonnet-5', { models });
  assert.equal(hard.tier, null, hard.reason);
  assert.match(hard.reason, /quality floor/);
  // ...and the estimate that follows books NO saving from a route that never happens.
  assert.equal(hard.model, 'claude-sonnet-5');
});

test('a hard request on a caller-named cheap model is still served, not blocked', () => {
  // Consent, not a breach: someone who asks for haiku has chosen haiku's quality, so the
  // floor must not turn their own choice into a passthrough.
  //
  // THIS TEST PINS THE OUTCOME, NOT THE `floor = req` LINE. That line is unreachable by
  // effect today (see the note on it in classify.js) — deleting it changes no result,
  // which was verified by mutation rather than assumed. What is asserted here is the
  // behaviour a future change to either runtime's floor logic must preserve.
  const models = { haiku: 'claude-haiku-4-5', sonnet: 'claude-opus-4-1', opus: 'claude-opus-4-1' };
  const d = routeDecision('is this deadlock-free?', 'claude-haiku-4-5', { models });
  assert.equal(d.tier, 'haiku', d.reason);
  assert.match(d.reason, /capped to requested 'haiku'/);
  assert.doesNotMatch(d.reason, /passthrough/);
});

test('routeDecision: when nothing configured is cheaper it PASSES THROUGH', () => {
  // The result peek had no way to express. tier === null means "Cheaper routed nothing",
  // and the caller's own model is returned unchanged — no saving, and no anti-saving
  // either, because no call was moved.
  const models = { haiku: 'claude-opus-5', sonnet: 'claude-opus-5', opus: 'claude-opus-5' };
  const d = routeDecision('hi', 'claude-haiku-4-5', { models });
  assert.equal(d.tier, null, d.reason);
  assert.equal(d.model, 'claude-haiku-4-5');
  assert.match(d.reason, /passthrough/);
});

test('routeDecision: an unpriceable requested model gets NO dollar ceiling', () => {
  // Mirrors router.py's `except: return None`. An unknown model must not be read as
  // "the ceiling passed" — but the TIER ceiling still applies here because modelTier()
  // recognises the name, which is precisely the divergence from router.requested_tier()
  // that scripts/check-policy-parity.js reports.
  assert.equal(modelTier('claude-tiny-9'), 'haiku');
  const d = routeDecision('review this for security holes', 'claude-tiny-9',
    { models: ANTHROPIC });
  assert.equal(d.tier, 'haiku', d.reason);
  assert.match(d.reason, /capped to requested 'haiku'/);
  assert.doesNotMatch(d.reason, /dollar ceiling/);
});

test('routeDecision: triage verdict replaces the heuristic content tier', () => {
  // ROUTER_MODE=triage asks a cheap model instead of the regex cascade. peek cannot
  // produce that verdict offline, but the hook must exist so the two runtimes can be
  // asked the same question when one IS available.
  const heuristic = routeDecision('hi', 'claude-opus-5', { models: ANTHROPIC });
  assert.equal(heuristic.tier, 'haiku');
  const triaged = routeDecision('hi', 'claude-opus-5',
    { models: ANTHROPIC, triageTier: 'opus' });
  assert.equal(triaged.tier, 'opus');
  assert.equal(triaged.reason, 'cheap-model triage verdict');
  // A junk verdict falls back to the heuristic rather than being trusted.
  const junk = routeDecision('hi', 'claude-opus-5',
    { models: ANTHROPIC, triageTier: 'gigantic' });
  assert.equal(junk.tier, 'haiku');
});

test('contentTier honours a configured long-request threshold', () => {
  // RouterConfig.long_request_chars comes from ROUTER_LONG_CHARS. It was hardcoded on
  // the JS side, so a gateway configured with a different threshold and `peek` disagreed
  // about every request between the two lengths.
  //
  // LENGTH IS ONE SIGNAL, NOT A VERDICT. The old fixture was a bare 'z'*2500 and expected
  // sonnet, which was true only under the pre-scoring band where any single moderate
  // match escalated — the band router.py measured as ANTI-predictive (sonnet-routed turns
  // did LESS work than haiku-routed ones). It now needs corroboration like every other
  // moderate signal, so the fixture carries a second one and the threshold is still what
  // moves the answer.
  const text = 'summarize this: ' + 'z'.repeat(2500);
  assert.equal(contentTier(text).tier, 'haiku');
  assert.equal(contentTier(text, { longRequestChars: 2000 }).tier, 'sonnet');
  // Omitted, the default is unchanged, and the boundary is still exactly >=.
  const atLimit = 'summarize this: '.padEnd(LONG_REQUEST_CHARS, 'z');
  assert.equal(atLimit.length, LONG_REQUEST_CHARS);
  assert.equal(contentTier(atLimit).tier, 'sonnet');
  assert.equal(contentTier(atLimit.slice(0, -1)).tier, 'haiku');
  // And length ALONE, at any size, is still only one signal.
  assert.equal(contentTier('z'.repeat(LONG_REQUEST_CHARS * 10)).tier, 'haiku');
});

// ---------------------------------------------------------------------------
// 3. estimateCall ASKS THE ROUTER
// ---------------------------------------------------------------------------

test('estimateCall reports the routed leg, not an assumed one', () => {
  const e = estimateCall('claude-opus-5', 1e6, 1e6, 'haiku');
  assert.equal(e.routedTier, 'haiku');
  assert.equal(e.routedModel, ROUTE_TARGET_BY_TIER.anthropic.haiku);
  assert.equal(e.passthrough, false);
  assert.equal(e.downgraded, true);
  assert.equal(e.newCost, costOfModel(e.routedModel, { inFresh: 1e6, outTok: 1e6 }));
});

test('estimateCall follows the DOLLAR ceiling, so a refused route books nothing', () => {
  // Proof that the router is really consulted rather than the tier being assumed. Today's
  // shipped ROUTE_TARGET is price-ordered inside every family, so the ceiling never trips
  // on it — which is why this test drives the table into the state a corrected
  // mistral.sonnet/mistral.opus WOULD create (see KNOWN_TIER_MISMATCHES in
  // scripts/sync-prices.js) and checks the estimate follows.
  const fam = ROUTE_TARGET_BY_TIER.anthropic;
  const saved = { haiku: fam.haiku, sonnet: fam.sonnet, opus: fam.opus };
  try {
    // Every target now costs MORE than the requested model: the router passes through.
    fam.haiku = 'claude-opus-4-1';
    fam.sonnet = 'claude-opus-4-1';
    const e = estimateCall('claude-sonnet-5', 1e6, 1e6, 'haiku');
    assert.equal(e.passthrough, true, JSON.stringify(e));
    assert.equal(e.routedTier, null);
    assert.equal(e.downgraded, false);
    // No route was taken, so there is no saving AND no anti-saving.
    assert.equal(e.newCost, e.baselineCost);
    assert.equal(e.saved, 0);
    assert.equal(e.gross, 0);
    assert.equal(e.extra, 0);

    // Only the SONNET slot is dear: an opus-tier call with sonnet-tier content cannot
    // land there, so the router walks DOWN to the haiku target instead of passing
    // through, and the estimate is priced against THAT model — not against the tier the
    // content asked for.
    fam.haiku = saved.haiku;
    const w = estimateCall('claude-opus-5', 1e6, 1e6, 'sonnet');
    assert.equal(w.routedTier, 'haiku', JSON.stringify(w));
    assert.equal(w.routedModel, saved.haiku);
    assert.equal(w.effTier, 'sonnet', 'the CONTENT tier is still reported as sonnet');
    assert.equal(w.newCost, costOfModel(saved.haiku, { inFresh: 1e6, outTok: 1e6 }));
  } finally {
    Object.assign(fam, saved);
  }
});

test('a real anti-saving still survives — the ceiling is not a clamp', () => {
  // The gemini-3.5-flash / gemini-2.5-pro case: the sonnet target is cheaper on the
  // router's fixed 1M/1M basket, so it PASSES the dollar ceiling and the route is really
  // taken — and on an input-heavy call it still costs more. Suppressing that in the
  // arithmetic is the one thing this whole file exists to prevent.
  const e = estimateCall('gemini-2.5-pro', 1e5, 1e4, 'sonnet');
  assert.equal(e.passthrough, false);
  assert.equal(e.routedTier, 'sonnet');
  assert.ok(e.saved < 0, 'saved=' + e.saved);
  assert.equal(e.gross, 0);
  assert.ok(e.extra > 0, 'extra=' + e.extra);
});

// ---------------------------------------------------------------------------
// 3b. A SAME-TIER ROUTE IS STILL A MODEL SUBSTITUTION
//
// estimateCall priced the routed leg only when `routedTier !== actualTier`, which assumed
// a same-tier route costs the same as no route. The gateway rewrites `body["model"]` to
// models[tier] whenever it routes — unconditionally, app.py:516 and :835 — so a same-TIER
// route serves a DIFFERENT MODEL at a DIFFERENT PRICE, and peek booked $0.00 for it.
//
// MEASURED 2026-08-08 over the 75-model catalog with the shipped ROUTE_TARGET: 63
// same-tier substitutions priced as exactly $0.00; at 1M/1M all 63 understated by
// $1,851.20 in total, and at an input-heavy 100k/10k basket 60 understated while 3
// OVERSTATED — so it could hide an anti-saving too.
//
// BOTH DIRECTIONS ARE PINNED BELOW, deliberately. A fix verified only on the saving case
// would be indistinguishable from "always claim more", which is the one direction this
// product's arithmetic must never be trusted to drift in on its own.
// ---------------------------------------------------------------------------

test('a same-tier route is priced as the SUBSTITUTION it is, not as no route', () => {
  // The largest case in the catalog. `o1-pro` and `gpt-5.6-sol` are both tier opus, so no
  // tier moves and `downgraded` stays false — but the caller is served a different model
  // at a fraction of the price, and that is a saving the gateway really delivers.
  //
  // 715 -> 695 ON 2026-08-09, and the $20 is a correction, not a loss. This basket is
  // 1M INPUT tokens, which is above OpenAI's 272k long-context threshold, so gpt-5.6-sol
  // really bills its long tier here: $10 + $45 = $55, not the $5 + $30 = $35 the catalog
  // used to charge for a request of this size. `o1-pro` publishes no long tier and stays
  // at $150 + $600 = $750, so the honest delta is $750 - $55 = $695. The old $715
  // was the arithmetic of a rate OpenAI does not offer at this prompt size.
  const toks = { inFresh: 1e6, outTok: 1e6 };
  const e = estimateCall('o1-pro', 1e6, 1e6, 'opus');
  assert.equal(e.routedTier, 'opus');
  assert.equal(e.actualTier, 'opus', 'this case exists ONLY when the tiers match');
  assert.equal(e.routedModel, ROUTE_TARGET_BY_TIER.openai.opus);
  assert.equal(e.passthrough, false);
  assert.equal(e.substituted, true, 'a different model id WAS served');
  assert.equal(e.downgraded, false, 'no TIER moved — substitution and downgrade differ');
  // The whole defect, in one line: newCost must be the SERVED model's price.
  assert.equal(e.newCost, costOfModel(e.routedModel, toks));
  assert.notEqual(e.newCost, e.baselineCost);
  assert.ok(Math.abs(e.saved - 695) < 1e-9, 'saved=' + e.saved);
  assert.ok(Math.abs(e.gross - 695) < 1e-9);
  assert.equal(e.extra, 0);

  // Catalog-wide, so the fix is not one model deep. Every same-tier substitution must be
  // priced at its served model, and the shipped map must never route to a model we cannot
  // price (which is what makes the unpriceable guard below unreachable by default).
  let n = 0;
  let moved = 0;
  let total = 0;
  for (const entry of CATALOG) {
    for (const content of TIERS) {
      const est = estimateCall(entry.id, 1e6, 1e6, content);
      if (!est.priceable || est.passthrough || est.routedTier !== est.actualTier) continue;
      if (!est.substituted) continue;
      assert.equal(est.routedPriceable, true,
        `${entry.id} -> '${est.routedModel}' is a shipped target with no price`);
      assert.equal(est.newCost, costOfModel(est.routedModel, toks),
        `${entry.id}/${content}: same-tier route to '${est.routedModel}' priced wrongly`);
      n++;
      if (Math.abs(est.saved) > 1e-12) { moved++; total += Math.abs(est.saved); }
    }
  }
  // TWO numbers, because they are two different facts and conflating them is how "53"
  // would quietly become whatever the catalog happens to hold next.
  //   63  same-tier routes that substitute a model at all
  //   53  of those whose price actually differs — the population that was mispriced
  // The remaining 10 (claude-opus-4-8/-4-7/-4-6/-4-5 -> claude-opus-5, gpt-5.5 ->
  // gpt-5.6-sol, grok-4.20 -> grok-4.3, mistral-nemo -> ministral-3-8b) are real
  // substitutions onto an identically-priced model, so $0.00 is the CORRECT answer for
  // them — and it always was. They are counted here so that a future catalog edit which
  // moves one of them into the mispriced set cannot do it silently.
  //
  // THESE WERE 73 / 63 / $1851.20 UNTIL 2026-08-09, AND THE DROP IS THE POINT.
  // Mistral's sonnet slot then held 'mistral-small-4', a HAIKU-tier model. Every
  // sonnet-tier Mistral model therefore counted as a SAME-TIER substitution onto it —
  // a mid request served by a cheap model, booked here as a same-tier saving. Exactly
  // ten (model, content) pairs left the set when the slot was corrected to name a real
  // sonnet model, and none entered:
  //   * mistral-medium-3.5 /sonnet /opus — the sonnet slot now names this model itself,
  //     so there is no substitution left to price (`substituted` false).
  //   * magistral-medium, mixtral-8x22b, devstral-2, codestral /sonnet — each is cheaper
  //     than the $9.00 sonnet target, so router.py's DOLLAR CEILING now walks them down
  //     and they are honest tier DOWNGRADES (routedTier haiku), not same-tier routes.
  //   * the same four /opus — the classifier calls these hard, so the QUALITY FLOOR stops
  //     the ceiling from walking below the escalated tier and they PASS THROUGH instead.
  // The $47.70 that left (1851.20 - 1803.50) is those ten pairs' old deltas against
  // mistral-small-4's $0.75 basket: (9.00-0.75)*2 + (7.00-0.75)*2 + (8.00-0.75)*2 +
  // (2.40-0.75)*2 + (1.20-0.75)*2 = 16.50 + 12.50 + 14.50 + 3.30 + 0.90. It was never a
  // same-tier saving; it was a tier downgrade wearing a same-tier label.
  //
  // $1803.50 -> $1783.50 LATER ON 2026-08-09, when OpenAI's 272k long-context tiers were
  // added to the catalog. `n` and `moved` did NOT move (63 and 53 both hold): no route
  // changed its tier or its served model, because the ceiling ranks every OpenAI model on
  // this same 1M/1M basket and the new rates preserved the existing order. Only the
  // DOLLARS moved, in exactly seven same-tier pairs, and they reconcile to the cent:
  //   gpt-5.6-sol is the openai opus target, and at 1M input it now costs $55 not $35,
  //   so each of the SIX opus-tier models routed onto it books $20 less apparent saving
  //   (gpt-5.5-pro, gpt-5.2-pro, gpt-5-pro, o1-pro, o1, o3-pro — none of which publishes
  //   a long tier of its own, so their own cost is unchanged);
  //   gpt-5.4-pro is the exception and moves the OTHER way (+$100), because it DOES
  //   publish a long tier, so its own basket rose $210 -> $330 while its target rose only
  //   $35 -> $55.
  //   6 * (-20) + 100 = -20 = 1803.50 - 1783.50.
  // Verified by reconstructing the OLD condition (the six longContext entries stripped
  // back off), which reproduces 715 / 63 / 53 / $1803.50 exactly — the method is sound,
  // so the numbers it yields under the new condition are trustworthy. Do NOT "restore"
  // the $20: it was the arithmetic of a short-context rate applied to a 1M-token prompt.
  assert.equal(n, 63, 'same-tier substitutions in the shipped catalog');
  assert.equal(moved, 53, 'of which this many really move a dollar at 1M/1M');
  assert.ok(Math.abs(total - 1783.50) < 1e-6,
    'the measured total the old line reported as $0.00: $' + total.toFixed(2));
});

test('a same-tier route that COSTS money is reported as a loss, not as $0.00', () => {
  // The mirror image, and the reason this fix is not simply "claim more". Driven through
  // an OPERATOR MAP because that is where it bites in production: the gateway's own
  // shipped OpenAI defaults are the legacy lineup, so a caller on a CURRENT model is
  // served an OLDER one of the same tier — sometimes dearer on their own token mix.
  //
  // gpt-5.6-terra (sonnet) -> gpt-4o (sonnet). Both pass the router's fixed 1M/1M dollar
  // ceiling, so the route is really taken; on this input-heavy 100k/10k call the served
  // model costs $0.35 against the caller's own $0.32. peek reported $0.00 — an anti-saving
  // erased, which is the suppression the signed delta exists to prevent.
  const router = knobOnly({
    openai_models: { haiku: 'gpt-4o-mini', sonnet: 'gpt-4o', opus: 'o3' },
  });
  assert.deepEqual(router.openaiModels, { haiku: 'gpt-4o-mini', sonnet: 'gpt-4o', opus: 'o3' });
  const toks = { inFresh: 1e5, outTok: 1e4 };
  const e = estimateCall('gpt-5.6-terra', 1e5, 1e4, 'sonnet', { router });
  assert.equal(e.routedTier, 'sonnet');
  assert.equal(e.actualTier, 'sonnet', 'same tier — that is the point of this case');
  assert.equal(e.routedModel, 'gpt-4o', 'the OPERATOR map must be the one used');
  assert.equal(e.substituted, true);
  assert.equal(e.downgraded, false);
  assert.equal(e.routable, true, 'openai IS routable, so this reaches the headline');
  assert.ok(Math.abs(e.baselineCost - 0.32) < 1e-9, 'baseline=' + e.baselineCost);
  assert.equal(e.newCost, costOfModel('gpt-4o', toks));
  assert.ok(Math.abs(e.newCost - 0.35) < 1e-9, 'newCost=' + e.newCost);
  // SIGNED and unclamped, exactly as a cross-tier anti-saving already is.
  assert.ok(e.saved < 0, 'saved=' + e.saved);
  assert.ok(Math.abs(e.saved + 0.03) < 1e-9, 'saved=' + e.saved);
  assert.equal(e.gross, 0);
  assert.ok(Math.abs(e.extra - 0.03) < 1e-9, 'extra=' + e.extra);
});

test('a route that serves the CALLER\'S OWN model moves no dollar', () => {
  // The only case that may still book nothing, and the guard that replaced the tier test.
  // It is an id comparison, not `===`: a route target and a transcript's model id spell
  // the same model differently, so a dated Bedrock-prefixed snapshot of the operator's own
  // sonnet target must read as "no substitution" rather than as a route to a third model.
  const router = knobOnly({
    models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-4-5', opus: 'claude-opus-5' },
  });
  for (const id of ['claude-sonnet-4-5', 'us.anthropic.claude-sonnet-4-5-20260101',
    'anthropic/claude-sonnet-4-5', 'CLAUDE-SONNET-4-5']) {
    const e = estimateCall(id, 1e6, 1e6, 'sonnet', { router });
    assert.equal(e.routedTier, 'sonnet', `${id}: ${JSON.stringify(e)}`);
    assert.equal(e.substituted, false, `${id} was read as a substitution of itself`);
    assert.equal(e.newCost, e.baselineCost, id);
    assert.equal(e.saved, 0, id);
    assert.equal(e.routedPriceable, true, id);
  }
  // sameModel is the shared predicate, and it must fail CLOSED across the catalog line:
  // a catalogued id and an uncatalogued one are never the same model.
  assert.equal(sameModel('claude-opus-5', 'us.anthropic.claude-opus-5-20260101'), true);
  assert.equal(sameModel('claude-opus-5', 'claude-opus-4'), false);
  assert.equal(sameModel('claude-internal-v9', 'claude-internal-v9'), true);
  assert.equal(sameModel('claude-opus-5', 'claude-internal-v9'), false);
});

test('an UNPRICEABLE route target books no saving — it must not price as $0', () => {
  // A separate defect on the same line, found while fixing the first and closed with it
  // because widening the branch multiplies the ways in. `costOfModel(...) || 0` priced a
  // target with no catalog entry at ZERO, which makes `saved` the ENTIRE baseline: a 100%
  // saving invented out of a missing rate, the exact move this module's header forbids.
  //
  // Reachable through any live /healthz map naming a model the catalog has never seen —
  // an operator's own fine-tune, or simply a model newer than CATALOG_AS_OF.
  const router = knobOnly({
    models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-internal-v9', opus: 'claude-opus-5' },
  });
  assert.equal(router.models.sonnet, 'claude-internal-v9', 'the map must really be adopted');
  const e = estimateCall('claude-opus-5', 1e6, 1e6, 'sonnet', { router });
  assert.equal(e.routedModel, 'claude-internal-v9');
  assert.equal(e.substituted, true, 'a route WAS taken — this is not a passthrough');
  // Before the fix this was newCost=0 and saved=30 — the whole 1M/1M baseline, fabricated.
  assert.equal(e.newCost, e.baselineCost);
  assert.equal(e.saved, 0);
  assert.equal(e.gross, 0);
  assert.equal(e.extra, 0);
  // ...and the zero is DISTINGUISHABLE from a measured zero, which is the whole reason
  // `priceable` exists on the actual leg. A silent zero here would be "we could not price
  // this" wearing the clothes of "this changed nothing".
  assert.equal(e.routedPriceable, false);
  assert.equal(e.priceable, true, 'the ACTUAL leg is still perfectly priceable');
  // The shipped configuration can never reach it: every ROUTE_TARGET is catalogued.
  assert.equal(estimateCall('claude-opus-5', 1e6, 1e6, 'sonnet').routedPriceable, true);
});

test('THE COMPOSITION INVARIANT: estimateCall prices the model routeDecision returned', () => {
  // WHY THIS IS A NODE TEST AND NOT A "GATE 3" IN check-policy-parity.js.
  //
  // The obvious reading of this defect is "the parity gate compares tiers, so a
  // same-tier substitution slipped past it". That is not what happened. GATE 2 already
  // compares the (tier, MODEL) pair — check-policy-parity.js:638 — and it was green
  // throughout, correctly, because the two runtimes never disagreed: both said
  // "opus, gpt-5.6-sol". sync-prices.js's cross-runtime probe was green too, because both
  // runtimes price gpt-5.6-sol identically. A third gate comparing the served id would
  // have been a third green light on a defect none of them can see.
  //
  // The gap is BETWEEN peek's own two halves: the router named a model, and the estimator
  // then priced a different one (the caller's). Nothing checked that the dollars follow
  // the decision, because that is not a cross-runtime question at all — both halves are
  // JS. So the gate belongs here, where routeDecision and estimateCall can be composed
  // directly, and it is stated as a total invariant over every routed row rather than as
  // the one case that happened to be wrong:
  //
  //     substituted  =>  newCost is the SERVED model's price (or the row says it has none)
  //    !substituted  =>  newCost is the caller's own price, and no dollar moves
  //
  // Adding it to the parity script instead would have put a JS-internal invariant behind
  // a Python interpreter, and would have widened a script whose whole contract is "ask
  // both runtimes the same question" into something that no longer says what it checks.
  const toks = { inFresh: 1e6, outTok: 1e6 };
  const ROUTERS = [
    ['shipped defaults', undefined],
    ['live anthropic map (/healthz today)', liveRouter()],
    ['legacy openai map', knobOnly({
      openai_models: { haiku: 'gpt-4o-mini', sonnet: 'gpt-4o', opus: 'o3' } })],
    ['min_tier=sonnet', knobOnly({ min_tier: 'sonnet' })],
    ['allow_upgrade', knobOnly({ allow_upgrade: 'yes' })],
    // An operator slot naming a model the catalog has never seen — their own fine-tune,
    // or simply something newer than CATALOG_AS_OF. Included so the invariant below is
    // TOTAL: without it the unpriceable-target branch is never entered and the sweep
    // would silently certify only the half of the contract it happened to reach.
    ['operator map with an uncatalogued target', knobOnly({
      models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-internal-v9', opus: 'claude-opus-5' } })],
  ];
  let routed = 0;
  let flat = 0;
  let unpriceableTarget = 0;
  for (const [label, router] of ROUTERS) {
    for (const entry of CATALOG) {
      for (const content of TIERS) {
        const e = estimateCall(entry.id, 1e6, 1e6, content,
          router ? { router } : undefined);
        if (!e.priceable) continue;
        const where = `[${label}] ${entry.id}/${content} -> `
          + `${e.routedTier}/${e.routedModel}`;
        // A passthrough substitutes nothing, by definition.
        if (e.passthrough) assert.equal(e.substituted, false, where);
        if (e.substituted) {
          routed++;
          const served = costOfModel(e.routedModel, toks);
          if (served == null) {
            // The ONLY case that may book nothing while a route was taken — and it has
            // to admit it, or it is indistinguishable from a measured zero.
            unpriceableTarget++;
            assert.equal(e.routedPriceable, false, where);
            assert.equal(e.newCost, e.baselineCost, where);
          } else {
            assert.equal(e.routedPriceable, true, where);
            assert.equal(e.newCost, served,
              where + ': the dollars must follow the decision');
          }
        } else {
          flat++;
          assert.equal(e.routedPriceable, true, where);
          assert.equal(e.newCost, e.baselineCost, where);
          assert.equal(e.saved, 0, where);
        }
        // The signed split is derived, never re-derived: it must agree with `saved` in
        // both directions, on every row, or a suppression could hide in the decomposition
        // rather than in the subtraction.
        assert.equal(e.saved, e.baselineCost - e.newCost, where);
        assert.equal(e.gross, Math.max(0, e.saved), where);
        assert.equal(e.extra, Math.max(0, -e.saved), where);
      }
    }
  }
  // Every branch must be non-trivially populated, or the sweep certifies only the paths it
  // happened to reach — which is the failure mode this whole test exists to answer.
  assert.ok(routed > 200, 'routed rows swept: ' + routed);
  assert.ok(flat > 50, 'non-substituting rows swept: ' + flat);
  assert.ok(unpriceableTarget > 0,
    'the unpriceable-target branch was never entered: ' + unpriceableTarget);
});

test('estimateCall never routes across vendors', () => {
  for (const entry of CATALOG) {
    for (const content of TIERS) {
      const e = estimateCall(entry.id, 1e6, 1e6, content);
      if (!e.priceable || e.passthrough) continue;
      const target = CATALOG.find((x) => x.id === e.routedModel);
      assert.ok(target, `${entry.id}: routed to uncatalogued '${e.routedModel}'`);
      assert.equal(target.family, entry.family,
        `${entry.id} (${entry.family}) routed to ${target.id} (${target.family})`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. THE SCORED CLASSIFIER
//
// classify.js held the FIRST-MATCH-WINS cascade for a full generation after router.py
// deleted it, so `peek` estimated against a router nobody was running — and it did so in
// the expensive direction, because the removed design escalated on a single bare domain
// word. These pin the three branches of the replacement.
// ---------------------------------------------------------------------------

test('a bare high-incidental domain word no longer escalates on its own', () => {
  // Measured incidental rates on real traffic: proof 96.0%, thread 89.4%, diagnos 86.8%,
  // security 80.2%. Under first-match-wins any ONE of them returned opus immediately.
  for (const [word, sentence] of [
    ['proof', 'can you read the proof of delivery email and file it'],
    ['thread', 'summarise this email thread for me'],
    ['diagnos', 'the mechanic sent a diagnostic printout, retype it'],
    ['security', 'reword the security deposit clause to be friendlier'],
    ['lock', 'my locker combination is 1234'],
    ['contract', 'the contract is on the table'],
  ]) {
    const c = contentTier(sentence);
    assert.equal(c.hard, false, `/${word}/ still escalates alone: ${c.reason}`);
    assert.notEqual(c.tier, 'opus', `/${word}/ still reaches opus alone: ${c.reason}`);
  }
});

test('corroboration escalates: two independent domains, or a nearby risk cue', () => {
  const two = contentTier('the contract says the diagnosis must be logged'); // legal+medical
  assert.equal(two.hard, true, two.reason);
  assert.match(two.reason, /independent risk domains/);
  const cue = contentTier('review the authentication flow and make sure it is safe');
  assert.equal(cue.hard, true, cue.reason);
  assert.match(cue.reason, /risk cue/);
  // Two words from the SAME domain are one signal, not two — corroboration has to be
  // independent to mean anything.
  const same = contentTier('the thread holds a lock');
  assert.equal(same.hard, false, same.reason);
});

test('the moderate band needs two signals, and STRONG terms still need only one', () => {
  assert.equal(contentTier('summarize').tier, 'haiku');
  assert.equal(contentTier('summarize and then debug it').tier, 'sonnet');
  assert.equal(contentTier('```\nfenced only\n```').tier, 'haiku');
  // One unambiguous technical term is still enough on its own: nobody writes "SQL
  // injection" or "ABA problem" in passing.
  for (const t of ['is this deadlock-free?', 'check for SQL injection', 'prove that it halts']) {
    const c = contentTier(t);
    assert.equal(c.tier, 'opus', `${t} -> ${c.reason}`);
    assert.equal(c.hard, true);
  }
});

test('word boundaries are UNICODE, matching Python — not ASCII', () => {
  // Python's \b is Unicode-aware and JavaScript's is ASCII-only, so /\block\b/ finds
  // "lock" inside "élock" in Node and not in Python. That is the "auth must not fire on
  // author" false positive returning for every accented language, and it moves a request
  // from the cheap tier to the top tier. `é` and `ç` are word characters on BOTH sides now.
  const cfg = { minHardDomains: 1 };   // one weak domain is enough, to isolate the boundary
  assert.equal(contentTier('élock the door', cfg).hard, false, 'é must not be a boundary');
  assert.equal(contentTier('reçuthread', cfg).hard, false, 'ç must not be a boundary');
  assert.equal(contentTier('ロックcontract', cfg).hard, false, 'CJK must not be a boundary');
  // ...while a real boundary still fires, so the fix is not a blanket suppression.
  assert.equal(contentTier('é lock the door', cfg).hard, true);
  assert.equal(contentTier('naïve deadlock in the café').hard, true);
});

test('the co-occurrence window counts CODE POINTS, matching Python', () => {
  // Python slices by code point, JavaScript by UTF-16 code unit, so one emoji costs one
  // unit of window budget on one side and two on the other.
  const win = 8;
  const cfg = { cooccurrenceWindow: win };
  assert.equal(contentTier('contract 🔒 audit', cfg).hard, true,
    'the lock glyph must cost ONE character of window, not two');
  // The boundary itself: a cue whose last character lands exactly on the edge
  // corroborates, and one character further out does not. An off-by-one in either
  // runtime's flank arithmetic flips exactly one of these.
  const onEdge = 'contract' + ' '.repeat(COOCCURRENCE_WINDOW - 5) + 'audit';
  const overEdge = 'contract' + ' '.repeat(COOCCURRENCE_WINDOW - 4) + 'audit';
  assert.equal(contentTier(onEdge).hard, true, 'cue ending ON the window edge must count');
  assert.equal(contentTier(overEdge).hard, false, 'cue one char OVER the edge must not');
});

// ---------------------------------------------------------------------------
// 5. THE CEILING INPUT AND THE VENDOR GUARD
// ---------------------------------------------------------------------------

test('requestedTier: catalog first, then the operator map, then fail closed', () => {
  assert.equal(requestedTier('gpt-4o', ANTHROPIC), 'sonnet');
  assert.equal(requestedTier('claude-fable-5', ANTHROPIC), 'opus');
  assert.equal(requestedTier('claude-tiny-9', ANTHROPIC), 'haiku');   // name signal
  assert.equal(requestedTier('totally-made-up', ANTHROPIC), null);    // fail CLOSED
  assert.equal(requestedTier('', ANTHROPIC), null);
  // An id an operator has DECLARED to be their sonnet tier outranks the catalog's
  // silence about it.
  const custom = { haiku: 'claude-haiku-4-5', sonnet: 'acme-internal-v3', opus: 'claude-opus-5' };
  assert.equal(requestedTier('acme-internal-v3', custom), 'sonnet');
  assert.equal(requestedTier('ACME-INTERNAL-V3', custom), 'sonnet');  // case-insensitive
});

test('the vendor guard: a request naming vendor X is never answered by vendor Y', () => {
  // The gateway used to rewrite body["model"] and forward to api.anthropic.com, so a
  // client sending `grok-4.3` was served claude-haiku-4-5 — and the call SUCCEEDED,
  // where an untouched passthrough would have been rejected upstream. pricing.js already
  // refused to model that ("never to a different vendor"); routeDecision now refuses it
  // too, so the estimate and the gateway describe the same product.
  for (const [asked, fam] of [['grok-4.3', 'xai'], ['gpt-5.6-terra', 'openai'],
    ['gemini-2.5-pro', 'google'], ['mistral-medium-3.5', 'mistral']]) {
    const d = routeDecision('rename this variable', asked, { models: ANTHROPIC });
    assert.equal(d.tier, null, `${asked}: ${d.reason}`);
    assert.equal(d.model, asked, 'the caller keeps their own model id');
    assert.match(d.reason, /cross-vendor/);
    assert.ok(d.reason.includes(`'${fam}'`) && d.reason.includes("'anthropic'"), d.reason);
  }
  // The mirror image, which was worse: 'opus' as a SUBSTRING used to map claude-opus-5
  // onto the OpenAI top tier and serve it from api.openai.com.
  const oai = ROUTE_TARGET_BY_TIER.openai;
  const back = routeDecision('rename this variable', 'claude-opus-5', { models: oai });
  assert.equal(back.tier, null, back.reason);
  assert.match(back.reason, /cross-vendor/);
  // Not disabled by allow_upgrade: opting into spending more is not opting into a
  // substitution the caller cannot see.
  const up = routeDecision('is this deadlock-free?', 'grok-4.3',
    { models: ANTHROPIC, allowUpgradeAboveRequested: true });
  assert.equal(up.tier, null, up.reason);
});

test('the vendor guard is NARROW — it fires only when both families are known', () => {
  // A guard that refused whenever it was UNSURE would turn every new model id into a
  // passthrough and quietly stop the product working.
  assert.equal(routeDecision('rename this', 'claude-opus-5', { models: ANTHROPIC }).tier,
    'haiku');
  assert.equal(routeDecision('rename this', 'totally-made-up', { models: ANTHROPIC }).tier,
    'haiku');
  assert.equal(routeDecision('rename this', '', { models: ANTHROPIC }).tier, 'haiku');
  // A deliberately MIXED operator map carries no single-vendor claim to protect.
  const mixed = { haiku: 'claude-haiku-4-5', sonnet: 'gpt-5.4', opus: 'claude-opus-5' };
  assert.equal(mapFamily(mixed), null);
  assert.equal(routeDecision('rename this', 'grok-4.3', { models: mixed }).tier, 'haiku');
  // ...and neither does a map naming a target no family pattern recognises.
  const unknown = { haiku: 'totally-made-up', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5' };
  assert.equal(mapFamily(unknown), null);
  assert.equal(mapFamily(ANTHROPIC), 'anthropic');
});

test('an unknown minTier CLAMPS rather than crashing', () => {
  // ROUTER_MIN_TIER is read straight from the environment with no validation, and
  // router.py's _rank() used to raise ValueError on a name it did not know — one typo,
  // a 500 on every request, while peek clamped and estimated a working router.
  const d = routeDecision('rename this', 'claude-opus-5',
    { models: ANTHROPIC, minTier: 'sonett' });
  assert.equal(d.tier, 'haiku', d.reason);
  assert.equal(routeDecision('rename this', 'claude-opus-5',
    { models: ANTHROPIC, minTier: 'sonnet' }).tier, 'sonnet');
});

// ---------------------------------------------------------------------------
// 6. THE GATE ITSELF
// ---------------------------------------------------------------------------

const GATE = path.join(__dirname, '../scripts/check-policy-parity.js');

test('the policy parity gate is wired into the test script', () => {
  // A gate nobody runs is a comment. sync-prices and check-period-parity are both in the
  // chain; this one has to be too, or the classifier goes back to being the one ungated
  // cross-runtime port.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /check-policy-parity\.js/);
  assert.ok(fs.existsSync(GATE));
});

test('the gate EXITS 0 when the runtimes agree, and rejects an unknown flag', () => {
  // The measurement that prompted this test read the exit status of a `tail` at the end
  // of a pipe and reported exit=0 for a gate that was really exiting 1. A gate wired into
  // `npm test` whose status nobody checks is not a gate, so the status is asserted here,
  // unpiped.
  const ok = spawnSync(process.execPath, [GATE, '--check'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /routing policy is in sync/);
  assert.match(ok.stdout, /exclusions:/, 'exclusions must be reported on every run');
  // A typo'd flag must not look like a pass.
  const bad = spawnSync(process.execPath, [GATE, '--chekc'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown argument/);
});

// Run the gate against a MUTATED copy of router.py, from a scratch directory whose
// `assets/gateway/app` holds the mutant plus symlinks to the real pricing module and
// catalog. Nothing in the repo is touched and the JS side is the genuine one, so a
// non-zero result means the gate really compared the two runtimes and really disagreed.
//
// `src` is symlinked (Node resolves it through to the real modules); the SCRIPT is a
// COPY, because Node resolves __dirname through a symlinked main module and would jump
// straight back to the repo, defeating the whole construction.
function runGateAgainstMutant(find, replace) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-parity-mutant-'));
  try {
    const appDir = path.join(root, 'assets', 'gateway', 'app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    const realApp = path.join(__dirname, '..', 'assets', 'gateway', 'app');
    for (const f of fs.readdirSync(realApp)) {
      if (f === 'router.py' || !/\.(py|json)$/.test(f)) continue;
      fs.symlinkSync(path.join(realApp, f), path.join(appDir, f));
    }
    const src = fs.readFileSync(path.join(realApp, 'router.py'), 'utf8');
    assert.ok(src.includes(find), `the mutation target moved — update this test: ${find}`);
    fs.writeFileSync(path.join(appDir, 'router.py'), src.replace(find, replace));
    fs.symlinkSync(path.join(__dirname, '..', 'src'), path.join(root, 'src'));
    const copy = path.join(root, 'scripts', 'check-policy-parity.js');
    fs.copyFileSync(GATE, copy);
    return spawnSync(process.execPath, [copy], { encoding: 'utf8' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('GATE 2 bites on a behavioural divergence — proved by mutation', () => {
  // Asserting only the passing status would leave the gate's whole point unproved: a
  // script that returns 0 unconditionally passes that test too. So the CODE UNDER TEST is
  // mutated and the gate is re-run against it.
  //
  // Retiring one STRONG pattern on the Python side only is the shape of drift this gate
  // exists for — it is exactly what happened to the whole first-match-wins cascade.
  const r = runGateAgainstMutant('r"\\bdeadlock\\b"', 'r"\\bdeadlokk\\b"');
  assert.notEqual(r.status, 0, 'the gate PASSED against a mutated router:\n' + r.stdout);
  assert.match(r.stderr, /GATE 2 — ROUTING DECISION: \d+ of \d+ decisions disagree/);
  assert.match(r.stderr, /policy parity failure/);
});

// ---------------------------------------------------------------------------
// 7. THE ROUTER peek PRICES IS THE ROUTER YOU ARE RUNNING
//
// Defect 2 above gave `peek` a faithful PORT of router.decide(). It did not give it the
// router's CONFIGURATION: estimateCall called routeDecision() with the shipped defaults
// for every knob, so a gateway running ROUTER_MIN_TIER / ROUTER_ALLOW_UPGRADE /
// ROUTER_MODEL_* / ROUTER_MODE off-default was estimated as if it were default — always
// optimistically.
//
// A DATED SNAPSHOT, measured 2026-08-08 over 16,089 priceable rows of one machine's own
// chat history. That corpus grows with use, so these are provenance for the finding, not
// constants — the assertions below use catalog-driven per-call arithmetic, which is
// deterministic and does not drift:
//
//   ROUTER_MIN_TIER=sonnet    changes 6,340 of the 16,089 decisions (39.4%) and takes the
//                             claimed gross saving from $9,270.05 to $7,316.15 — 21.1% of
//                             the claim gone. It VOIDS 726 of 9,503 downgrade claims
//                             (7.6%): only the SONNET-tier callers lose the claim
//                             outright, while the 8,777 opus-tier callers keep a
//                             shallower, cheaper one. "39.4% of claims voided" conflated
//                             those two numbers and matched neither — 39.4% is the share
//                             of DECISIONS THAT CHANGE, and a changed decision is usually
//                             a smaller claim rather than no claim.
//   ROUTER_ALLOW_UPGRADE=true peek reports $0.00 of extra spend on the same corpus where
//                             the real router would incur $290.15, because the requested
//                             ceiling made an upgrade structurally unrepresentable.
//
// And defect 3: peek priced downgrades for vendors the gateway has no endpoint for.
// ---------------------------------------------------------------------------

// The /healthz payload today's gateway really answers with (app.py:297-313), used as the
// "gateway is up but tells us only half" fixture.
const HEALTHZ_TODAY = Object.freeze({
  ok: true, mode: 'heuristic', upstream: 'https://api.anthropic.com',
  models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-4-5', opus: 'claude-opus-4-1' },
  code_sha: 'deadbeefdeadbeef', auth_required: true, token_private: true,
});

// A resolved config, as freshness.routerConfig() would return it. Built through
// routerConfigFrom so a test can never assert against a shape the reader does not
// actually produce.
function liveRouter(extra) {
  return routerConfigFrom(Object.assign({}, HEALTHZ_TODAY, extra || {}));
}

// A config that varies ONE knob and leaves the tier -> id map unresolved, so the shipped
// ROUTE_TARGET is used on both sides of a comparison. Without this, changing a knob and
// changing the route map at the same time would produce a difference that proves nothing
// about the knob — which is exactly the mistake the first draft of these tests made.
function knobOnly(extra) {
  return routerConfigFrom(Object.assign({ ok: true, mode: 'heuristic' }, extra || {}));
}

test('an unreachable gateway is LABELLED as assuming defaults, not silently assumed', () => {
  // Invariant 7 — a labelled non-number beats a confident wrong one. The failure this
  // prevents is not a wrong figure, it is an UNMARKED one: peek printing a default-router
  // estimate that reads exactly like a measurement of the router you are running.
  const r = routerConfigFrom(null);
  assert.equal(r.source, 'defaults');
  assert.equal(r.reachable, false);
  assert.equal(r.labelled, true, 'an all-assumed config MUST be labelled');
  // Every knob is assumed, and each one names the /healthz key that would settle it.
  assert.deepEqual(r.assumed.slice().sort(), Object.keys(HEALTHZ_ROUTER_KEY).sort());
  assert.deepEqual(r.missingHealthzKeys.slice().sort(),
    Object.values(HEALTHZ_ROUTER_KEY).slice().sort());
  // ...and the values it falls back to are the SHIPPED defaults, so "gateway down" and
  // "gateway up, unconfigured" produce the same estimate. If they diverged, merely
  // starting the gateway would move the money.
  for (const k of Object.keys(ROUTER_ASSUMED_DEFAULTS)) {
    assert.deepEqual(r[k], ROUTER_ASSUMED_DEFAULTS[k], `${k} must fall back to the shipped default`);
  }
});

test('the /healthz contract gap is DERIVED from app.py, so it closes by itself', () => {
  // The list of keys the gateway still owes peek must not be a hand-maintained constant —
  // that is the four-hardcoded-tables failure this whole file exists to catch. It is
  // derived from the payload, so when app.py starts publishing `min_tier` the assumed
  // list shrinks with no edit here.
  //
  // This test reads app.py's ACTUAL /healthz body and asserts the two sides line up:
  // every routing key the gateway publishes is READ, and every one it does not is
  // REPORTED MISSING. It therefore keeps passing when app.py grows a key, and starts
  // failing if freshness.js quietly stops reading one that is being served.
  const src = fs.readFileSync(
    path.join(__dirname, '../assets/gateway/app/app.py'), 'utf8');
  const start = src.indexOf('async def healthz');
  assert.ok(start > 0, 'app.py no longer defines healthz — update this test');
  const body = src.slice(start, src.indexOf('\n@app.', start));
  const served = new Set((body.match(/"([a-z_]+)":/g) || []).map((s) => s.slice(1, -2)));
  assert.ok(served.has('mode') && served.has('models'),
    'healthz must still publish mode/models: ' + [...served].join(','));

  // Plausible values for every key peek would like, so the reader is exercised on the
  // ones app.py serves and only those.
  const sample = {
    mode: 'triage',
    models: { haiku: 'a-haiku', sonnet: 'a-sonnet', opus: 'an-opus' },
    openai_models: { haiku: 'o-haiku', sonnet: 'o-sonnet', opus: 'o-opus' },
    min_tier: 'sonnet',
    allow_upgrade: true,
    long_request_chars: 1234,
    routable_families: ['anthropic'],
  };
  const payload = { ok: true };
  for (const k of Object.keys(sample)) if (served.has(k)) payload[k] = sample[k];
  const r = routerConfigFrom(payload);
  const expectMissing = Object.values(HEALTHZ_ROUTER_KEY).filter((k) => !served.has(k));
  assert.deepEqual(r.missingHealthzKeys.slice().sort(), expectMissing.slice().sort());
  assert.equal(r.source, 'gateway');
  assert.equal(r.reachable, true);
  // As long as ANY routing knob is unanswered the figure still has to be labelled.
  assert.equal(r.labelled, expectMissing.length > 0 || r.triageUnmodellable);
  // The keys it DOES serve are really read, not merely tolerated.
  for (const [cfgKey, healthKey] of Object.entries(HEALTHZ_ROUTER_KEY)) {
    if (served.has(healthKey)) assert.ok(!r.assumed.includes(cfgKey), `${cfgKey} was served but assumed`);
  }
});

test('a config the gateway DOES answer is read — this side is already done', () => {
  // Forward compatibility is the point: app.py adding the four missing keys must require
  // no change here. Drive the reader with the payload app.py would then serve.
  const r = routerConfigFrom(Object.assign({}, HEALTHZ_TODAY, {
    min_tier: 'sonnet', allow_upgrade: 'true', long_request_chars: 900,
    openai_models: { haiku: 'gpt-4o-mini', sonnet: 'gpt-4o', opus: 'o3' },
    routable_families: ['anthropic', 'openai'],
  }));
  assert.equal(r.minTier, 'sonnet');
  assert.equal(r.allowUpgradeAboveRequested, true);
  assert.equal(r.longRequestChars, 900);
  assert.deepEqual(r.openaiModels, { haiku: 'gpt-4o-mini', sonnet: 'gpt-4o', opus: 'o3' });
  assert.deepEqual(r.routableFamilies, ['anthropic', 'openai']);
  assert.deepEqual(r.assumed, [], 'nothing is assumed once everything is answered');
  assert.equal(r.labelled, false, 'a fully-answered heuristic config needs no qualifier');
});

test('a HALF-ANSWERED knob is assumed, never read as the permissive default', () => {
  // A partial tier map is worse than no map: routeDecision would index models[tier],
  // get undefined for the missing tier, price it as unknown and PASS THROUGH — a
  // configuration error rendering as "Cheaper declined to route".
  assert.equal(tierMapOrNull({ haiku: 'a', sonnet: 'b' }), null);
  assert.equal(tierMapOrNull({ haiku: 'a', sonnet: 'b', opus: '' }), null);
  assert.deepEqual(tierMapOrNull({ haiku: ' a ', sonnet: 'b', opus: 'c' }),
    { haiku: 'a', sonnet: 'b', opus: 'c' });
  // ROUTER_ALLOW_UPGRADE's string forms mirror app.py:98-99 exactly...
  for (const v of ['1', 'true', 'TRUE', 'yes', true]) assert.equal(boolOrNull(v), true, String(v));
  for (const v of ['0', 'false', 'no', false]) assert.equal(boolOrNull(v), false, String(v));
  // ...and anything else is UNKNOWN, not false. Reading junk as the default would be a
  // silent assumption wearing the clothes of a measurement.
  for (const v of ['maybe', '', 2, null, undefined]) assert.equal(boolOrNull(v), null, String(v));
  const r = routerConfigFrom(Object.assign({}, HEALTHZ_TODAY, {
    models: { haiku: 'x', sonnet: 'y' }, allow_upgrade: 'maybe',
  }));
  assert.ok(r.assumed.includes('models'), 'a partial map must not be adopted');
  assert.ok(r.assumed.includes('allowUpgradeAboveRequested'));
  assert.equal(r.models, null);
  assert.equal(r.allowUpgradeAboveRequested, false);
});

test('ROUTER_MODE=triage is UNMODELLABLE offline, and says so', () => {
  // peek keeps its heuristic verdict because there is nothing else it can do — the
  // router's verdict comes from a live model call. The only honest handling is a label.
  const heur = liveRouter({ mode: 'heuristic' });
  assert.equal(heur.triageUnmodellable, false);
  const tri = liveRouter({ mode: 'triage' });
  assert.equal(tri.mode, 'triage');
  assert.equal(tri.triageUnmodellable, true);
  assert.equal(tri.labelled, true);
});

test('estimateCall honours min_tier — the claim SHRINKS or is VOIDED, per caller tier', () => {
  // The distinction the headline number got wrong. min_tier=sonnet does two DIFFERENT
  // things depending on who is calling, and only one of them is a voided claim:
  //
  //   opus-tier caller   the downgrade still happens, one tier shallower. $24.00 -> $18.00
  //                      on a 1M/1M call: 25% of THAT row's saving gone, claim intact.
  //   sonnet-tier caller there is nothing below the floor to route to. $6.00 -> $0.00,
  //                      downgraded goes false: the claim is VOIDED.
  //
  // On the dated corpus snapshot above that is 726 of 9,503 claims voided (7.6%) and
  // 21.1% of the gross dollars lost — two numbers, neither of them the 39.4% of decisions
  // that merely CHANGE. The two per-call figures asserted below are catalog arithmetic and
  // do not move with the corpus.
  const floor = knobOnly({ min_tier: 'sonnet' });
  assert.equal(floor.minTier, 'sonnet');
  assert.equal(floor.models, null, 'the route map must stay shipped-default here');

  const opusDefault = estimateCall('claude-opus-5', 1e6, 1e6, 'haiku');
  const opusFloored = estimateCall('claude-opus-5', 1e6, 1e6, 'haiku', { router: floor });
  assert.equal(opusDefault.routedTier, 'haiku');
  assert.equal(opusFloored.routedTier, 'sonnet', 'the floor must be applied');
  assert.equal(opusFloored.downgraded, true, 'an opus caller still gets a downgrade');
  assert.ok(opusFloored.saved < opusDefault.saved,
    `floored ${opusFloored.saved} must be below default ${opusDefault.saved}`);
  assert.ok(Math.abs(opusDefault.saved - 24) < 1e-9, 'saved=' + opusDefault.saved);
  assert.ok(Math.abs(opusFloored.saved - 18) < 1e-9, 'saved=' + opusFloored.saved);

  const sonDefault = estimateCall('claude-sonnet-5', 1e6, 1e6, 'haiku');
  const sonFloored = estimateCall('claude-sonnet-5', 1e6, 1e6, 'haiku', { router: floor });
  assert.equal(sonDefault.downgraded, true);
  assert.ok(Math.abs(sonDefault.saved - 6) < 1e-9, 'saved=' + sonDefault.saved);
  assert.equal(sonFloored.downgraded, false, 'the sonnet caller LOSES the claim entirely');
  assert.equal(sonFloored.routedTier, 'sonnet');
  assert.equal(sonFloored.saved, 0);
});

test('estimateCall honours allow_upgrade — the spend peek could not express', () => {
  // With the ceiling on, an opus-classified request from a haiku caller is capped and
  // books exactly $0.00. With ROUTER_ALLOW_UPGRADE=true the gateway really routes UP,
  // and the user really pays. Corpus-wide: $0.00 reported vs $290.15 incurred.
  const up = knobOnly({ allow_upgrade: 'yes' });
  assert.equal(up.allowUpgradeAboveRequested, true);
  assert.equal(up.models, null, 'the route map must stay shipped-default here');
  const capped = estimateCall('claude-haiku-4-5', 1e6, 1e6, 'opus');
  assert.equal(capped.routedTier, 'haiku');
  assert.equal(capped.saved, 0);
  assert.equal(capped.extra, 0);
  const upgraded = estimateCall('claude-haiku-4-5', 1e6, 1e6, 'opus', { router: up });
  assert.equal(upgraded.routedTier, 'opus');
  assert.equal(upgraded.routedModel, ROUTE_TARGET_BY_TIER.anthropic.opus);
  assert.ok(upgraded.saved < 0, 'an upgrade is a SPEND: saved=' + upgraded.saved);
  assert.ok(Math.abs(upgraded.extra - 24) < 1e-9, 'extra=' + upgraded.extra);
});

test('a live tier map is used for the family it serves, and NEVER for another', () => {
  // This closes the divergence pricing.js's own header measures. peek prices the sonnet
  // leg against `claude-sonnet-5` and picks up its PROMOTIONAL rate ($2/$10 until
  // 2026-08-31); the gateway's shipped default routes to `claude-sonnet-4-5` at list
  // ($3/$15). Same tier, same day, and the estimate claims 50% more saving than the
  // gateway delivers — a gap that heals itself on 2026-09-01, which is the worst kind.
  const live = liveRouter();                     // the real /healthz default map
  assert.equal(live.models.sonnet, 'claude-sonnet-4-5');
  const toks = { inFresh: 1e6, outTok: 1e6 };

  const shipped = estimateCall('claude-opus-5', 1e6, 1e6, 'sonnet');
  const actual = estimateCall('claude-opus-5', 1e6, 1e6, 'sonnet', { router: live });
  assert.equal(shipped.routedModel, ROUTE_TARGET_BY_TIER.anthropic.sonnet);
  assert.equal(actual.routedModel, 'claude-sonnet-4-5',
    'the live map must be used: ' + actual.routedModel);
  assert.equal(actual.newCost, costOfModel('claude-sonnet-4-5', toks));
  assert.ok(Math.abs(shipped.saved - 18) < 1e-9, 'shipped=' + shipped.saved);
  assert.ok(Math.abs(actual.saved - 12) < 1e-9, 'actual=' + actual.saved);
  // The +50.0% the header names, now measured through the estimate rather than asserted
  // in prose.
  assert.ok(Math.abs((shipped.saved / actual.saved) - 1.5) < 1e-9);

  // The same config, a Google row: the shipped Google targets are used, never the
  // Anthropic map. Letting /healthz `models` price a Gemini counterfactual would be the
  // cross-vendor substitution pricing.js exists to refuse, arriving through the config
  // door instead of the routing door.
  const goog = estimateCall('gemini-2.5-pro', 1e6, 1e6, 'sonnet', { router: live });
  assert.equal(detectFamily(goog.routedModel), 'google',
    'a google row must never be priced against an anthropic map: ' + goog.routedModel);
  assert.equal(goog.routedModel, ROUTE_TARGET_BY_TIER.google.sonnet);

  // A DELIBERATELY MIXED map carries no single-vendor claim and is therefore adopted by
  // nobody — every family falls back to its own shipped targets.
  const mixed = liveRouter({
    models: { haiku: 'claude-haiku-4-5', sonnet: 'gpt-5.4', opus: 'claude-opus-5' },
  });
  const m = estimateCall('claude-opus-5', 1e6, 1e6, 'sonnet', { router: mixed });
  assert.equal(m.routedModel, ROUTE_TARGET_BY_TIER.anthropic.sonnet);
});

// ---------------------------------------------------------------------------
// 7b. REALIZABLE TODAY vs "would require a <vendor> endpoint"
// ---------------------------------------------------------------------------

test('ROUTABLE_FAMILIES matches the endpoints that actually rewrite body["model"]', () => {
  // The gateway routes on exactly two paths. Everything else reaches the catch-all proxy
  // (app.py:1151), which relays the request — POSTs included, so it is NOT "read-only
  // reporting" — but never reads or writes body["model"], so nothing is routed.
  const src = fs.readFileSync(
    path.join(__dirname, '../assets/gateway/app/app.py'), 'utf8');
  assert.match(src, /@app\.post\("\/v1\/messages"\)/);
  assert.match(src, /@app\.post\("\/v1\/chat\/completions"\)/);
  assert.match(src, /@app\.api_route\("\/\{path:path\}"/, 'the catch-all proxy must still exist');
  const proxy = src.slice(src.indexOf('async def passthrough'));
  assert.doesNotMatch(proxy, /body\[.model.\]/,
    'the catch-all must not rewrite the model — that is why its vendors are unroutable');
  assert.deepEqual(ROUTABLE_FAMILIES.slice().sort(), ['anthropic', 'openai']);

  // MEASURED 2026-08-08 and pinned here: 4 of ROUTE_TARGET's 6 families, and 28 of the
  // catalog's 75 ids (37.3%), are priced for a downgrade the gateway cannot perform.
  const unroutableFamilies = Object.keys(ROUTE_TARGET).filter((f) => !isRoutableFamily(f));
  assert.deepEqual(unroutableFamilies.sort(), ['deepseek', 'google', 'mistral', 'xai']);
  const unroutableIds = CATALOG.filter((e) => {
    const f = detectFamily(e.id);
    return ROUTE_TARGET[f] && !isRoutableFamily(f);
  });
  assert.equal(CATALOG.length, 75);
  assert.equal(unroutableIds.length, 28);
  // A live gateway may report its own endpoint list; peek must follow it rather than the
  // constant, or shipping a third front end would require a CLI release.
  assert.equal(isRoutableFamily('google'), false);
  assert.equal(isRoutableFamily('google', ['anthropic', 'openai', 'google']), true);
});

test('estimateCall marks routability, and it does NOT touch the arithmetic', () => {
  // The counterfactual for an unroutable vendor is real arithmetic over real published
  // rates and stays exactly as it was. `routable` is a LABEL on the row, not a clamp:
  // deleting the flag must change no dollar.
  for (const [id, fam, routable] of [
    ['claude-opus-5', 'anthropic', true], ['gpt-5-pro', 'openai', true],
    ['gemini-2.5-pro', 'google', false], ['grok-4.5', 'xai', false],
    ['deepseek-v4-pro', 'deepseek', false], ['mistral-medium-3.5', 'mistral', false],
  ]) {
    const e = estimateCall(id, 1e6, 1e6, 'haiku');
    assert.equal(e.family, fam, id);
    assert.equal(e.routable, routable, `${id} routability`);
    if (e.downgraded) {
      assert.equal(e.newCost, costOfModel(e.routedModel, { inFresh: 1e6, outTok: 1e6 }),
        `${id}: an unroutable row must still be priced, not zeroed`);
    }
  }
  // An UNPRICEABLE row still reports routability: "we have no rate for this model" and
  // "the gateway cannot route this vendor" are different exclusions with different
  // remedies (catalog a price / ship an endpoint) and must not collapse into one.
  const open = estimateCall('llama-4-maverick', 1e6, 1e6, 'haiku');
  assert.equal(open.priceable, false);
  assert.equal(open.family, 'meta');
  assert.equal(open.routable, false);
});

// A one-harness scan over a hand-written Claude Code transcript. Mirrors the fixture shape
// cli/test/peek.test.js uses, so the two files exercise the SAME reader.
function scanFixture(turns, scanOpts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-routable-'));
  const proj = path.join(dir, '.claude', 'projects', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  const lines = [];
  let n = 0;
  for (const [prompt, model, inTok, outTok] of turns) {
    n++;
    lines.push({ type: 'user', message: { role: 'user', content: prompt },
                 timestamp: '2026-08-10T12:00:00Z' });
    lines.push({ type: 'assistant', isSidechain: false,
                 message: { id: 'a' + n, role: 'assistant', model,
                            content: [{ type: 'text', text: 'ok' }],
                            usage: { input_tokens: inTok, output_tokens: outTok } },
                 timestamp: '2026-08-10T12:00:0' + (n % 10) + 'Z' });
  }
  fs.writeFileSync(path.join(proj, 'sesR.jsonl'),
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

test('scan: an unroutable vendor is kept OUT of the headline and reported IN FULL', () => {
  // The gemini-2.5-pro row is the one anti-saving today's catalog can produce, and Google
  // is a vendor the gateway has no endpoint for. Before this split it supplied the
  // headline `dollarsSaved` with a loss no configuration of the gateway could inflict.
  //
  // MOVED, NOT ZEROED — the assertions below check BOTH halves, because a fix that simply
  // dropped the row would be a suppression wearing a split's clothes.
  const { rep, h } = scanFixture([
    ['please refactor the pagination endpoint', 'gemini-2.5-pro', 1e5, 1e4],
  ]);
  assert.equal(h.calls, 1);
  assert.equal(h.unpriced, 0, 'the row is perfectly priceable — it is UNROUTABLE');
  // Headline: nothing claimed, in either direction.
  assert.equal(h.downgradable, 0);
  assert.equal(h.dollarsSaved, 0);
  assert.equal(h.dollarsGross, 0);
  assert.equal(h.dollarsExtra, 0);
  assert.equal(h.offsetCalls, 0);
  assert.equal(h.dollarsBaselineRoutable, 0);
  assert.deepEqual(h.examples, []);
  // The other bucket carries the whole thing, signed and decomposed exactly as before.
  assert.equal(h.unroutableCalls, 1);
  assert.equal(h.unroutableTokens, 1.1e5);
  assert.equal(h.downgradableUnroutable, 1);
  assert.ok(Math.abs(h.dollarsSavedUnroutable + 0.015) < 1e-9, 'saved=' + h.dollarsSavedUnroutable);
  assert.equal(h.dollarsGrossUnroutable, 0);
  assert.ok(Math.abs(h.dollarsExtraUnroutable - 0.015) < 1e-9, 'extra=' + h.dollarsExtraUnroutable);
  assert.equal(h.offsetCallsUnroutable, 1);
  assert.equal(h.examplesUnroutable.length, 1);
  assert.equal(h.examplesUnroutable[0].family, 'google');
  assert.equal(h.examplesUnroutable[0].routable, false);
  // Named by vendor, so the report can say WHICH endpoint would unlock it.
  assert.deepEqual(Object.keys(h.unroutableByFamily), ['google']);
  assert.equal(h.unroutableByFamily.google.calls, 1);
  // SPEND is spend: the user really paid for this call, so both bill legs still count it.
  assert.ok(Math.abs(h.dollarsActual - 0.225) < 1e-9, 'dollarsActual=' + h.dollarsActual);
  assert.ok(Math.abs(h.dollarsBaseline - 0.225) < 1e-9, 'dollarsBaseline=' + h.dollarsBaseline);
  // Totals fold both buckets, and the coverage ratio names the remedy.
  assert.equal(rep.totals.dollarsSaved, 0);
  assert.ok(Math.abs(rep.totals.dollarsSavedUnroutable + 0.015) < 1e-9);
  assert.equal(rep.totals.unroutableRatio, 1, 'every token seen was unroutable');
  assert.equal(rep.totals.unpricedRatio, 0, 'and none of it was unpriceable — different fault');
  assert.equal(rep.totals.savedPct, 0);
});

test('scan: a ROUTABLE anti-saving still reaches the headline, unclamped', () => {
  // The split must not become a back door for the clamp this product forbids. With the
  // gateway's own OpenAI map (an opus-tier `o3-pro` sitting in the sonnet slot — the exact
  // shape app.py:152 ships, where `o3` fills the opus slot at tier sonnet), a gpt-5-pro
  // caller with sonnet-tier content is really routed, really pays MORE, and the headline
  // has to say so.
  const router = routerConfigFrom(Object.assign({}, HEALTHZ_TODAY, {
    openai_models: { haiku: 'gpt-4o-mini', sonnet: 'o3-pro', opus: 'gpt-5.6-sol' },
  }));
  const { h } = scanFixture([
    ['please refactor the pagination endpoint', 'gpt-5-pro', 1e5, 1e4],
  ], { router });
  assert.equal(h.calls, 1);
  assert.equal(h.unroutableCalls, 0, 'openai IS routable');
  assert.equal(h.downgradable, 1);
  assert.ok(h.dollarsSaved < 0, 'the loss must survive into the headline: ' + h.dollarsSaved);
  assert.ok(Math.abs(h.dollarsSaved + 0.1) < 1e-9, 'dollarsSaved=' + h.dollarsSaved);
  assert.equal(h.dollarsGross, 0);
  assert.ok(Math.abs(h.dollarsExtra - 0.1) < 1e-9, 'dollarsExtra=' + h.dollarsExtra);
  assert.equal(h.offsetCalls, 1);
  // ...and it is the LIVE map that produced it. The shipped ROUTE_TARGET routes this row
  // to gpt-5.4 and books a $0.40 SAVING — a sign flip, which is the whole reason the
  // configuration has to be resolved before the money is printed.
  const shipped = scanFixture([
    ['please refactor the pagination endpoint', 'gpt-5-pro', 1e5, 1e4],
  ]);
  assert.ok(shipped.h.dollarsSaved > 0,
    'default-config estimate must disagree, or this test proves nothing: '
      + shipped.h.dollarsSaved);
});

test('every scan report says WHICH router its dollars describe', () => {
  // A report that omits the router block is indistinguishable from one that verified the
  // configuration. `router` is therefore always present, and `labelled` is the flag a
  // rendering surface must obey before it prints a dollar sign.
  const { rep } = scanFixture([['hello there', 'claude-opus-5', 1000, 100]]);
  assert.ok(rep.router, 'report.router must always be present');
  assert.equal(rep.router.source, 'defaults');
  assert.equal(rep.router.reachable, false);
  assert.equal(rep.router.labelled, true);
  assert.ok(rep.router.assumed.includes('minTier'));
  assert.ok(/assum/i.test(rep.router.note), rep.router.note);
  // A resolved config is carried through verbatim, with its own provenance.
  const live = scanFixture([['hello there', 'claude-opus-5', 1000, 100]],
    { router: routerConfigFrom(HEALTHZ_TODAY) });
  assert.equal(live.rep.router.source, 'gateway');
  assert.equal(live.rep.router.reachable, true);
  assert.equal(live.rep.router.labelled, true, 'still labelled — /healthz owes four keys');
  assert.deepEqual(live.rep.router.models, HEALTHZ_TODAY.models);
});

test('scanLive exists and degrades to a LABELLED default when nothing answers', () => {
  // The entry point a command that prints money should call. There is no gateway on the
  // test port, so this exercises exactly the path that matters: resolution fails, the
  // report still renders, and it admits it guessed.
  const savedPort = process.env.CHEAPER_PORT;
  const savedHome = process.env.CHEAPER_PEEK_HOME;
  // An empty home, so this measures the RESOLUTION path rather than however much history
  // the machine running the suite happens to have.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-scanlive-'));
  process.env.CHEAPER_PORT = '1';   // nothing listens here
  process.env.CHEAPER_PEEK_HOME = dir;
  for (const m of ['fsutil', 'adapters', 'scan']) delete require.cache[require.resolve('../src/peek/' + m)];
  const { scanLive } = require('../src/peek/scan');
  assert.equal(typeof scanLive, 'function');
  return scanLive({ only: 'claude-code' }).then((rep) => {
    assert.equal(rep.router.source, 'defaults');
    assert.equal(rep.router.labelled, true);
    assert.ok(rep.totals, 'the report must still be produced');
    assert.equal(rep.totals.calls, 0);
  }).finally(() => {
    if (savedPort === undefined) delete process.env.CHEAPER_PORT;
    else process.env.CHEAPER_PORT = savedPort;
    if (savedHome === undefined) delete process.env.CHEAPER_PEEK_HOME;
    else process.env.CHEAPER_PEEK_HOME = savedHome;
    fs.rmSync(dir, { recursive: true, force: true });
    for (const m of ['fsutil', 'adapters', 'scan']) delete require.cache[require.resolve('../src/peek/' + m)];
  });
});

test('GATE 0 bites on a DEFAULT that drifts — proved by mutation', () => {
  // This mutation is why GATE 0 exists. `min_moderate_signals` is driven explicitly by
  // every config the gate runs, so changing its DEFAULT left all 144,180 decisions in
  // agreement and the gate passed — while a gateway with no ROUTER_* variables set would
  // have been running a different classifier from the one `peek` was estimating.
  const r = runGateAgainstMutant('min_moderate_signals: int = 2',
    'min_moderate_signals: int = 1');
  assert.notEqual(r.status, 0, 'the gate PASSED against a mutated default:\n' + r.stdout);
  assert.match(r.stderr, /GATE 0 — DEFAULTS/);
  assert.match(r.stderr, /min_moderate_signals/);
});
