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
} = require('../src/peek/pricing');
const { CATALOG } = require('../src/peek/models');

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
  //   mistral.sonnet   DEFECT — mistral publishes real sonnet-tier models.
  //   mistral.opus     DEFECT — mistral-large-3 is tier opus AND cheaper than the
  //                    sonnet-tier model currently in the slot.
  const EXPECTED_BELOW_SLOT = ['deepseek.sonnet', 'mistral.opus', 'mistral.sonnet'];
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
