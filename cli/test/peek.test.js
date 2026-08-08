'use strict';
// Zero-dependency tests for the peek engine (run with: node --test).
// Uses a synthetic fixture home — never touches real harness history.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { contentTier, modelTier, effectiveTier } = require('../src/peek/classify');
const { estimateCall, detectFamily } = require('../src/peek/pricing');
const { realizedFromRecords, buildTagline, fromGateway } = require('../src/peek/tagline');

// Helper: a normalized call record as the adapters emit them.
function rec(model, source, inTok = 1_000_000, outTok = 1_000_000) {
  return { harness: 'claude-code', model, inTokens: inTok, outTokens: outTok, text: '', source };
}

test('classifier mirrors the router tiers', () => {
  assert.equal(contentTier('rename this variable').tier, 'haiku');
  assert.equal(contentTier('please refactor the pagination endpoint').tier, 'sonnet');
  assert.equal(contentTier('audit this code for a security vulnerability').tier, 'opus');
  assert.equal(contentTier('fix the race condition in the mutex').tier, 'opus');
});

// The moderate band requires CORROBORATION: >= minModerateSignals (default 2)
// INDEPENDENT signals, not the first one to match.
//
// This test used to assert the opposite — that 5,000 characters of 'x', or a bare code
// fence, was on its own enough to buy the mid tier. That was first-match-wins, and it was
// measured ANTI-predictive: the old cascade scored AUC 0.531 at telling hard requests from
// easy ones, with the sonnet/haiku ordering INVERTED. It also contradicted the product's
// own rubric, which states "Volume ≠ difficulty" in one document while the classifier
// escalated on length in another.
//
// So the single-signal cases below now assert HAIKU deliberately. A long paste is long; a
// code fence is a code fence. Neither is evidence of difficulty, and charging the mid tier
// for one is the overspend this redesign exists to stop. Both directions are pinned, so a
// regression to first-match-wins fails here and a threshold quietly raised out of reach
// fails on the corroborated cases.
test('the moderate band needs corroboration, not one signal', () => {
  // ONE signal each -> not enough.
  assert.equal(contentTier('x'.repeat(5000)).tier, 'haiku',
    'length alone is volume, not difficulty');
  assert.equal(contentTier('do this\n```\ncode\n```').tier, 'haiku',
    'a code fence alone is not difficulty');

  // TWO independent signals -> the mid tier is earned. A long request that ALSO carries a
  // code fence is corroborated by two unrelated observations, which is the whole rule.
  assert.equal(contentTier('```\n' + 'x'.repeat(5000) + '\n```').tier, 'sonnet',
    'long AND fenced is two independent signals');
  assert.equal(contentTier('first, migrate the endpoint and then debug it').tier, 'sonnet',
    'several mid-tier lexical signals corroborate each other');

  // The threshold is a knob, and driving it must actually change the answer — otherwise a
  // gateway configured off-default and `peek` would silently disagree, which is the exact
  // class of drift check-policy-parity.js now gates.
  assert.equal(contentTier('x'.repeat(5000), { minModerateSignals: 1 }).tier, 'sonnet',
    'at a threshold of 1 the single signal is sufficient again');
});

test('model tier comes from the catalog, not from the model name', () => {
  // The catalog's declared tier wins over any name signal. These are CAPABILITY
  // classes and deliberately do not track price — see the CATALOG note in models.js.
  assert.equal(modelTier('claude-opus-4'), 'opus');
  assert.equal(modelTier('claude-haiku-4-5'), 'haiku');
  assert.equal(modelTier('gpt-4o-mini'), 'haiku');
  assert.equal(modelTier('o3-mini'), 'haiku');
  assert.equal(modelTier('gpt-4o'), 'sonnet');
  assert.equal(modelTier('gemini-2.5-pro'), 'opus');

  // Cases the old name-regex got WRONG, now fixed by the catalog:
  //   o3 matched /\bo3\b/ -> 'opus', but it is a $10-blended mid reasoning model.
  assert.equal(modelTier('o3'), 'sonnet');
  //   gemini-2.5-flash matched /\bflash\b/ -> 'haiku'; Flash is Google's MID tier.
  assert.equal(modelTier('gemini-2.5-flash'), 'sonnet');
  assert.equal(modelTier('gemini-2.5-flash-lite'), 'haiku');
  //   fable/mythos matched nothing and fell through to the old 'sonnet' default,
  //   despite being top-class models priced at DOUBLE Opus 5.
  assert.equal(modelTier('claude-fable-5'), 'opus');
  assert.equal(modelTier('claude-mythos-5'), 'opus');
  //   gpt-5.6-sol fell through to 'sonnet' at $35/Mtok blended.
  assert.equal(modelTier('gpt-5.6-sol'), 'opus');
  assert.equal(modelTier('gpt-5.6-luna'), 'haiku');
});

test('modelTier fails CLOSED for models the catalog does not know', () => {
  // The old default was 'sonnet', which asserted mid capability for anything
  // unrecognized — including every model released after CATALOG_AS_OF. Claiming a
  // capability we cannot evidence is how a router talks itself into a downgrade.
  assert.equal(modelTier('some-model-invented-tomorrow'), null);
  assert.equal(modelTier('a-brand-new-thing'), null);
  assert.equal(modelTier(''), null);
  assert.equal(modelTier(null), null);

  // An UNAMBIGUOUS name signal still classifies an off-catalog model. This is safe
  // precisely because tier no longer touches money: `claude-opus-6` is judged
  // top-capability for routing, while the pricing path independently refuses to
  // price it. Capability guessed, dollars never.
  const { isPriceable, costOfModel } = require('../src/peek/pricing');
  assert.equal(modelTier('claude-opus-6'), 'opus');
  assert.equal(isPriceable('claude-opus-6'), false);
  assert.equal(costOfModel('claude-opus-6', { inFresh: 1e6, outTok: 1e6 }), null);
  assert.equal(modelTier('acme-8b'), 'haiku');
});

test('capability tier and price rank are allowed to disagree', () => {
  const { costOfModel } = require('../src/peek/pricing');
  const toks = { inFresh: 1e6, outTok: 1e6 };
  // Both are 'opus' capability, but Fable costs double Opus 5. Tier must not be
  // used to infer which is cheaper — that is exactly the conflation being removed.
  assert.equal(modelTier('claude-fable-5'), modelTier('claude-opus-5'));
  assert.ok(costOfModel('claude-fable-5', toks) > costOfModel('claude-opus-5', toks));
  // And Mistral's flagship is cheaper than its mid model.
  assert.equal(modelTier('mistral-large-3'), 'opus');
  assert.equal(modelTier('mistral-medium-3.5'), 'sonnet');
  assert.ok(costOfModel('mistral-large-3', toks) < costOfModel('mistral-medium-3.5', toks));
});

test('family detection; unknown models are unpriceable (no phantom savings)', () => {
  assert.equal(detectFamily('claude-opus-4'), 'anthropic');
  assert.equal(detectFamily('gpt-4o'), 'openai');
  assert.equal(detectFamily('o3'), 'openai');
  assert.equal(detectFamily('gemini-2.5-pro'), 'google');
  assert.equal(detectFamily('grok-3'), 'xai');
  assert.equal(detectFamily('some-unknown-model'), null);
  // An unrecognized model must NOT be priced/downgraded — that would invent savings.
  const e = estimateCall('totally-made-up-model', 1e6, 1e6, 'haiku');
  assert.equal(e.saved, 0);
  assert.equal(e.downgraded, false);
});

test('ceiling: never routes above the model actually used', () => {
  // A hard (opus-worthy) prompt already ran on haiku -> no downgrade, no "savings".
  const e = estimateCall('claude-haiku-4-5', 1000, 500, 'opus');
  assert.equal(e.downgraded, false);
  assert.equal(e.saved, 0);
});

test('savings appear only when content tier is cheaper than the used model', () => {
  // A trivial prompt that ran on Opus -> could have run on Haiku.
  const e = estimateCall('claude-opus-4', 1_000_000, 1_000_000, 'haiku');
  assert.equal(e.downgraded, true);
  assert.ok(e.saved > 0);
  // Opus in+out = 15 + 75 = $90 ; Haiku = 1 + 5 = $6 ; saved ~ $84.
  assert.ok(Math.abs(e.saved - 84) < 0.001, 'saved=' + e.saved);
});

test('effectiveTier caps content tier to the used model', () => {
  const r = effectiveTier('audit for security vulnerabilities', 'gpt-4o-mini');
  assert.equal(r.tier, 'haiku'); // opus-worthy content, but capped to the mini used
  assert.equal(r.capped, true);
});

test('end-to-end scan over a synthetic fixture home', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-fix-'));
  const proj = path.join(dir, '.claude', 'projects', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  const lines = [
    // trivial prompt that ran on Opus -> downgradable to Haiku
    { type: 'user', message: { role: 'user', content: 'rename foo to bar' }, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'assistant', isSidechain: false,
      message: { id: 'msg_A', role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'done' }],
                 usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
      timestamp: '2026-01-01T00:00:01Z' },
    // SAME turn split into a second line (same message.id + usage) -> must be deduped, not counted twice
    { type: 'assistant', isSidechain: false,
      message: { id: 'msg_A', role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'more' }],
                 usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
      timestamp: '2026-01-01T00:00:02Z' },
    // security prompt on Opus -> should NOT be downgradable
    { type: 'user', message: { role: 'user', content: 'audit the auth flow for a security vulnerability' }, timestamp: '2026-01-01T00:01:00Z' },
    { type: 'assistant', isSidechain: true,
      message: { id: 'msg_B', role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'ok' }],
                 usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
      timestamp: '2026-01-01T00:01:01Z' },
  ];
  fs.writeFileSync(path.join(proj, 'session.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const saved = process.env.CHEAPER_PEEK_HOME;
  process.env.CHEAPER_PEEK_HOME = dir;
  try {
    delete require.cache[require.resolve('../src/peek/fsutil')];
    delete require.cache[require.resolve('../src/peek/adapters')];
    delete require.cache[require.resolve('../src/peek/scan')];
    const { scan } = require('../src/peek/scan');
    const rep = scan({ only: 'claude-code' });
    const h = rep.harnesses.find((x) => x.key === 'claude-code');
    assert.equal(h.calls, 2);
    assert.equal(h.downgradable, 1);                 // only the trivial one
    assert.equal(h.bySource.subagent, 1);            // the security call was a sidechain
    assert.ok(h.dollarsSaved > 80 && h.dollarsSaved < 90);
    assert.ok(rep.totals.dollarsSaved > 0);
  } finally {
    if (saved === undefined) delete process.env.CHEAPER_PEEK_HOME;
    else process.env.CHEAPER_PEEK_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    delete require.cache[require.resolve('../src/peek/fsutil')];
    delete require.cache[require.resolve('../src/peek/adapters')];
    delete require.cache[require.resolve('../src/peek/scan')];
  }
});

// ---- tagline: realized per-chat savings (baseline = the chat's ceiling tier) ----

test('realized savings: sub-agent calls below the ceiling model are credited', () => {
  // Main loop ran on Opus (the ceiling); Cheaper routed two sub-agents cheaper.
  const r = realizedFromRecords([
    rec('claude-opus-4', 'user'),      // ceiling = opus, no saving on itself
    rec('claude-haiku-4-5', 'subagent'),
    rec('claude-sonnet-4-5', 'subagent'),
  ]);
  assert.equal(r.ceilingModel, 'claude-opus-4');
  assert.equal(r.creditedCalls, 2);
  // haiku saved: (15+75)-(1+5)=84 ; sonnet saved: (15+75)-(3+15)=72 ; total 156.
  assert.ok(Math.abs(r.dollarsSaved - 156) < 1e-6, 'dollarsSaved=' + r.dollarsSaved);
  assert.equal(r.tokensCredited, 4_000_000); // 2M haiku + 2M sonnet
  // The breakdown names the MODELS that saved money, never the un-routed main loop.
  assert.deepEqual(r.savedByModel, { 'claude-haiku-4-5': 1, 'claude-sonnet-4-5': 1 });
  assert.deepEqual(r.extraByModel, {});
  const line = buildTagline(r);
  assert.match(line, /^Cheaper\.app saved 🟢 about \$156 and 4\.0M tokens by running /);
  assert.ok(line.includes('1 call on claude-haiku-4-5 and 1 call on claude-sonnet-4-5 instead of claude-opus-4, at list API rates.'));
  // Whole-session usage follows as its own sentence (opus 90 + haiku 6 + sonnet 18 = $114).
  // Phrased as metered value at list rates, never "you spent" — most sessions run on a
  // flat-rate subscription where that sum is never actually charged.
  assert.match(line, / This session ran 6\.0M tokens, worth 🔴 about \$114 at list API rates\.$/);
  assert.ok(!/you spent/i.test(line), 'must not assert a charge that may never occur: ' + line);
});

test('breakdown excludes the un-routed main loop — only routed-cheaper tiers are claimed', () => {
  // Mirrors this real session: a big Opus main loop Cheaper did NOT route, a few Opus
  // sub-agent escalations, and the Sonnet sub-agents that actually saved money.
  const recs = [];
  for (let i = 0; i < 168; i++) recs.push(rec('claude-opus-4', 'user', 1000, 1000));      // main loop (ceiling)
  for (let i = 0; i < 7; i++) recs.push(rec('claude-opus-4', 'subagent', 1000, 1000));     // opus escalations
  for (let i = 0; i < 12; i++) recs.push(rec('claude-sonnet-4-5', 'subagent', 20000, 3000)); // the savings
  const r = realizedFromRecords(recs);
  assert.equal(r.ceilingModel, 'claude-opus-4');
  assert.equal(r.savedByModel['claude-sonnet-4-5'], 12);
  assert.equal(r.savedByModel['claude-opus-4'], undefined); // baseline is never a "saving"
  assert.equal(r.creditedCalls, 12);
  const line = buildTagline(r);
  // The 175 Opus calls MUST NOT be claimed as routed savings.
  assert.ok(!/calls on claude-opus-4/.test(line), 'main-loop opus must not be claimed: ' + line);
  assert.ok(line.includes('by running 12 calls on claude-sonnet-4-5 instead of claude-opus-4'));
  assert.match(line, / This session ran [\d.]+[KM] tokens, worth 🔴 about \$[\d.]+ at list API rates\.$/);
});

test('cache-aware pricing: reads 0.1x, 5m writes 1.25x, 1h writes 2x of the real input rate', () => {
  const { costOfDetailed, costOf, costOfModel } = require('../src/peek/pricing');
  // The anthropic/opus bucket prices as Opus 5 ($5/$25) — the current Opus — not as
  // the retired Opus 4 ($15/$75). Pricing today's Opus traffic at Opus 4 rates was a
  // flat 3x overstatement of every Claude Code session's cost.
  assert.ok(Math.abs(costOfDetailed('anthropic', 'opus', { cacheRead: 1e6 }) - 0.5) < 1e-9);
  assert.ok(Math.abs(costOfDetailed('anthropic', 'opus', { cacheCreate5m: 1e6 }) - 6.25) < 1e-9);
  // A 1-hour cache write bills at 2x input, not 1.25x. Claude Code writes 1h entries,
  // so collapsing the TTLs understated real sessions by 37.5% of their write volume.
  assert.ok(Math.abs(costOfModel('claude-opus-5', { cacheCreate1h: 1e6 }) - 10) < 1e-9);
  assert.ok(Math.abs(costOfModel('claude-opus-5', { cacheCreate5m: 1e6 }) - 6.25) < 1e-9);
  // A write of unrecorded TTL prices as the cheaper 5m rate — an unknown must never
  // inflate the bill.
  assert.ok(Math.abs(costOfModel('claude-opus-5', { cacheCreate: 1e6 }) - 6.25) < 1e-9);
  // Fresh input + output prices identically to costOf().
  assert.ok(Math.abs(costOfDetailed('anthropic', 'opus', { inFresh: 1e6, outTok: 1e6 })
    - costOf('anthropic', 'opus', 1e6, 1e6)) < 1e-9);
});

test('per-model pricing beats tier buckets: same tier, different real rates', () => {
  const { costOfModel } = require('../src/peek/pricing');
  const toks = { inFresh: 1e6, outTok: 1e6 };
  // Both are "opus tier" by the classifier, but they are a 3x apart in real dollars.
  // A tier-bucket price cannot represent both; only a per-model rate can.
  assert.ok(Math.abs(costOfModel('claude-opus-5', toks) - 30) < 1e-9);
  assert.ok(Math.abs(costOfModel('claude-opus-4', toks) - 90) < 1e-9);
  // Dated snapshots and Bedrock/Vertex prefixes resolve to the same rates.
  assert.equal(costOfModel('claude-opus-5-20260101', toks), 30);
  assert.equal(costOfModel('anthropic.claude-opus-5', toks), 30);
  assert.equal(costOfModel('us.anthropic.claude-opus-5', toks), 30);
  // Billing modifiers the transcript records: fast mode is a 2x SKU, batch is half.
  assert.equal(costOfModel('claude-opus-5', toks, { speed: 'fast' }), 60);
  assert.equal(costOfModel('claude-opus-5', toks, { serviceTier: 'batch' }), 15);
});

test('long-context tiers apply once the prompt crosses the provider threshold', () => {
  const { costOfModel } = require('../src/peek/pricing');
  // Gemini 2.5 Pro doubles above 200k input: 100k bills at $1.25/Mtok, 300k at $2.50.
  assert.ok(Math.abs(costOfModel('gemini-2.5-pro', { inFresh: 1e5 }) - 0.125) < 1e-9);
  assert.ok(Math.abs(costOfModel('gemini-2.5-pro', { inFresh: 3e5 }) - 0.75) < 1e-9);
  // Grok doubles above 200k too.
  assert.ok(Math.abs(costOfModel('grok-4.5', { inFresh: 1e5 }) - 0.2) < 1e-9);
  assert.ok(Math.abs(costOfModel('grok-4.5', { inFresh: 3e5 }) - 1.2) < 1e-9);
});

test('open-weight models are unpriceable — no single list price exists to quote', () => {
  const { costOfModel, isPriceable, detectFamily } = require('../src/peek/pricing');
  // The same Llama/Qwen weights cost 3-12x more on one host than another, so any
  // single number would be fiction. Vendor is still identified for grouping.
  assert.equal(detectFamily('llama-4-maverick'), 'meta');
  assert.equal(isPriceable('llama-4-maverick'), false);
  assert.equal(costOfModel('llama-4-maverick', { inFresh: 1e6 }), null);
  assert.equal(isPriceable('qwen3-72b'), false);
});

test('model resolution FAILS CLOSED: an unknown id never inherits a sibling rate', () => {
  const { isPriceable, costOfModel } = require('../src/peek/pricing');
  // Regression guard for the fail-open resolver. Longest-prefix matching used to let
  // a NEW model id latch onto an OLDER entry: `claude-opus-4-9` resolved to
  // `claude-opus-4` and priced at the RETIRED $15/$75 — a 3x overstatement, the exact
  // shape of the incident this catalog exists to prevent. It also made the module's
  // "unknown => unpriceable" rule unreachable, and produced no catalog diff, so no
  // review or alarm could ever have caught it.
  const mustBeUnpriceable = [
    'claude-opus-4-9',    // hypothetical newer Opus — must NOT inherit Opus 4's $15/$75
    'claude-opus-4-99',
    'claude-sonnet-5-2',  // must NOT inherit Sonnet 5's promotional window
    'gpt-5.6',            // family id; the real models are -sol/-terra/-luna
    'gpt-5-codex',        // real, separately-priced SKU
    'o3-deep-research',   // real, separately-priced SKU
    'claude-opus-6',
    'grok-5',
  ];
  for (const id of mustBeUnpriceable) {
    assert.equal(isPriceable(id), false, id + ' must be unpriceable, not prefix-matched');
    assert.equal(costOfModel(id, { inFresh: 1e6, outTok: 1e6 }), null, id + ' must price as null');
  }
  // ...while every legitimate spelling of a KNOWN model still resolves.
  const mustResolve = [
    'claude-opus-5', 'claude-opus-5-20260101', 'anthropic.claude-opus-5',
    'us.anthropic.claude-opus-5', 'claude-opus-5@20260101', 'openai/gpt-5.6-sol',
    'CLAUDE-OPUS-5', '  claude-opus-5  ',
  ];
  for (const id of mustResolve) {
    assert.equal(isPriceable(id), true, id + ' must still resolve');
  }
});

test('every catalog price is well-formed (a typo here is a wrong dollar figure)', () => {
  const { CATALOG } = require('../src/peek/models');
  const seen = new Set();
  for (const e of CATALOG) {
    assert.ok(e.id && e.family, 'entry needs id + family: ' + JSON.stringify(e));
    assert.ok(!seen.has(e.id), 'duplicate catalog id: ' + e.id);
    seen.add(e.id);
    for (const k of ['in', 'out']) {
      assert.equal(typeof e[k], 'number', `${e.id}.${k} must be a number`);
      assert.ok(e[k] > 0 && e[k] < 1000, `${e.id}.${k} out of sane range: ${e[k]}`);
    }
    // Output always costs at least as much as input — true of every provider sheet.
    assert.ok(e.out >= e.in, `${e.id}: output cheaper than input?`);
    // A cache read is a discount, never a premium.
    if (e.cacheRead != null) assert.ok(e.cacheRead <= e.in, `${e.id}: cacheRead > in`);
    // A cache write is a premium over fresh input, and 1h costs more than 5m.
    if (e.cacheWrite != null) assert.ok(e.cacheWrite >= e.in, `${e.id}: cacheWrite < in`);
    if (e.cacheWrite1h != null) assert.ok(e.cacheWrite1h >= e.cacheWrite, `${e.id}: 1h < 5m`);
    // A long-context tier is more expensive than the standard tier, never less.
    if (e.longContext) {
      assert.ok(e.longContext.over > 0, `${e.id}: longContext.over`);
      assert.ok(e.longContext.in >= e.in && e.longContext.out >= e.out,
        `${e.id}: long-context tier cheaper than standard`);
    }
  }
});

test('a cheap-tier route target is genuinely cheaper than its mid target', () => {
  const { ROUTE_TARGET, costOfModel } = require('../src/peek/pricing');
  const toks = { inFresh: 1e6, outTok: 1e6 };
  for (const [fam, t] of Object.entries(ROUTE_TARGET)) {
    const cheap = costOfModel(t.cheap, toks);
    const mid = costOfModel(t.mid, toks);
    const top = costOfModel(t.top, toks);
    assert.ok(cheap != null && mid != null && top != null, fam + ' targets must all price');
    // DeepSeek publishes only two SKUs, so cheap === mid there by necessity.
    if (fam === 'deepseek') assert.equal(t.cheap, t.mid);
    else assert.ok(cheap < mid, `${fam}: cheap target (${t.cheap} $${cheap}) must undercut mid (${t.mid} $${mid})`);
    assert.ok(mid <= top, `${fam}: mid target must not exceed top`);
  }
});

test('every representative model resolves to a real catalog entry', () => {
  const { REPRESENTATIVE, isPriceable } = require('../src/peek/pricing');
  for (const [family, buckets] of Object.entries(REPRESENTATIVE)) {
    for (const [bucket, id] of Object.entries(buckets)) {
      assert.ok(isPriceable(id), `${family}.${bucket} -> "${id}" is not in the catalog`);
    }
  }
});

test('the gateway price table is in sync with the JS catalog', () => {
  // The gateway reports dollars WITHOUT a "~" (it is the exact path), so a divergence
  // between the two tables surfaces as an authoritative-looking wrong number. Two
  // hand-maintained copies is how they drifted a model generation apart before.
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/sync-prices.js'), '--check'],
    { stdio: 'pipe' });
});

test('promotional pricing windows apply only inside their date range', () => {
  const { costOfModel } = require('../src/peek/pricing');
  const toks = { inFresh: 1e6, outTok: 1e6 };
  // Sonnet 5 launch pricing is $2/$10 through 2026-08-31, $3/$15 after.
  assert.equal(costOfModel('claude-sonnet-5', toks, { at: '2026-08-06' }), 12);
  assert.equal(costOfModel('claude-sonnet-5', toks, { at: '2026-08-31' }), 12); // last promo day
  assert.equal(costOfModel('claude-sonnet-5', toks, { at: '2026-09-01' }), 18); // standard resumes
  assert.equal(costOfModel('claude-sonnet-5', toks, { at: '2026-09-15' }), 18);
});

test('the pricing date defaults to TODAY, never to the frozen catalog date', () => {
  const { costOfModel } = require('../src/peek/pricing');
  const { todayUTC, CATALOG_AS_OF } = require('../src/peek/models');
  const toks = { inFresh: 1e6, outTok: 1e6 };
  // Defaulting `at` to CATALOG_AS_OF would hold an expired promotional window open
  // forever: Sonnet 5's launch price ends 2026-08-31, and a frozen default would keep
  // quoting $2/$10 instead of $3/$15 indefinitely — a silent ~33% understatement that
  // no catalog refresh could fix, because the bug would be in the date, not the rates.
  assert.match(todayUTC(), /^\d{4}-\d{2}-\d{2}$/);
  const today = todayUTC();
  const expected = today <= '2026-08-31' ? 12 : 18;
  assert.equal(costOfModel('claude-sonnet-5', toks), expected,
    'default pricing date must track today (' + today + '), not CATALOG_AS_OF (' + CATALOG_AS_OF + ')');
  // And the default must agree with passing today explicitly.
  assert.equal(costOfModel('claude-sonnet-5', toks), costOfModel('claude-sonnet-5', toks, { at: today }));
});

test('retrospective pricing uses the date each call happened', () => {
  // A session recorded DURING a promotional window keeps the promo rate forever; a
  // later session on the same model does not. Pricing both at "today" would silently
  // restate history the moment a window closes.
  const mk = (ts) => ([
    { model: 'claude-opus-5', source: 'user', ts: Date.parse(ts),
      inTokens: 1e6, inFresh: 1e6, outTokens: 0, outTok: 0 },
    { model: 'claude-sonnet-5', source: 'subagent', ts: Date.parse(ts),
      inTokens: 1e6, inFresh: 1e6, outTokens: 1e6, outTok: 1e6 },
  ]);
  const inWindow = realizedFromRecords(mk('2026-08-10T00:00:00Z'));
  const after = realizedFromRecords(mk('2026-09-10T00:00:00Z'));
  // Sonnet 5 in-window: 2 + 10 = $12. After: 3 + 15 = $18. Opus 5 leg is $5 either way.
  assert.ok(Math.abs(inWindow.totalSpent - 17) < 1e-6, 'in-window totalSpent=' + inWindow.totalSpent);
  assert.ok(Math.abs(after.totalSpent - 23) < 1e-6, 'after-window totalSpent=' + after.totalSpent);
});

test('total session spend is cache-aware; routed savings reported separately', () => {
  // Opus main loop that is almost all cache-read (cheap) + one fresh Sonnet sub-agent.
  const recs = [
    { model: 'claude-opus-4', source: 'user', inTokens: 1e6, inFresh: 0, cacheCreate: 0, cacheRead: 1e6, outTokens: 0 },
    { model: 'claude-sonnet-4-5', source: 'subagent', inTokens: 1e6, inFresh: 1e6, cacheCreate: 0, cacheRead: 0, outTokens: 1e6 },
  ];
  const r = realizedFromRecords(recs);
  // Opus main loop: 1M cache-read → 15*0.1 = $1.50. Sonnet fresh: 3 + 15 = $18. Total $19.50.
  assert.ok(Math.abs(r.totalSpent - 19.5) < 1e-6, 'totalSpent=' + r.totalSpent);
  // Sonnet is below the opus ceiling → saved (fresh): 90 (opus) - 18 (sonnet) = $72.
  assert.ok(Math.abs(r.dollarsSaved - 72) < 1e-6, 'dollarsSaved=' + r.dollarsSaved);
  const line = buildTagline(r);
  assert.match(line, /by running 1 call on claude-sonnet-4-5 instead of claude-opus-4/);
  assert.match(line, / This session ran 3\.0M tokens, worth 🔴 about \$19\.50 at list API rates\.$/);
});

test('brand renders as a markdown link when requested', () => {
  const r = { ceilingModel: 'claude-opus-4', topModel: 'claude-opus-4', dollarsSaved: 5,
    tokensCredited: 1e6, creditedCalls: 1, savedByModel: { 'claude-sonnet-4-5': 1 },
    extraByModel: {}, extraCost: 0, totalSpent: 10, totalTokens: 2e6, exact: false };
  const md = buildTagline(r, '[Cheaper.app](https://cheaper.app)');
  assert.ok(md.startsWith('[Cheaper.app](https://cheaper.app) saved '), md);
});

test('color cues: 🟢 on savings, 🔴 on spend; ANSI adds real colour', () => {
  const r = { ceilingModel: 'claude-opus-4', topModel: 'claude-opus-4', dollarsSaved: 5,
    tokensCredited: 1e6, creditedCalls: 1, savedByModel: { 'claude-sonnet-4-5': 1 },
    extraByModel: {}, extraCost: 0, totalSpent: 10, totalTokens: 2e6, exact: false };
  // Markdown/plain can't colour text, so an emoji dot carries the cue in the chat.
  const md = buildTagline(r, 'Cheaper.app', 'markdown');
  assert.ok(md.includes('saved 🟢 about $5.00'), md);   // green cue on the savings
  assert.ok(md.includes('worth 🔴 about $10.00'), md);  // red cue on the metered value
  // ANSI format wraps the amount in true green/red for terminals / the Stop hook.
  const ESC = String.fromCharCode(27);
  const ansi = buildTagline(r, 'Cheaper.app', 'ansi');
  assert.ok(ansi.includes('🟢 ' + ESC + '[32mabout $5.00' + ESC + '[0m'), 'ansi green: ' + JSON.stringify(ansi));
  assert.ok(ansi.includes('🔴 ' + ESC + '[31mabout $10.00' + ESC + '[0m'), 'ansi red: ' + JSON.stringify(ansi));
});

test('honesty: a chat with no downgrade claims no dollars (brand line only)', () => {
  const r = realizedFromRecords([rec('claude-opus-4', 'user'), rec('claude-opus-4', 'subagent')]);
  assert.equal(r.dollarsSaved, 0);
  assert.ok(buildTagline(r).startsWith('Cheaper.app ran this chat on claude-opus-4 — no routing saving to claim.'));
});

test('honesty: unknown models are unpriceable and never invent a saving', () => {
  // Ceiling is opus; the "cheap" call is an unknown model -> excluded, not credited.
  const r = realizedFromRecords([rec('claude-opus-4', 'user'), rec('totally-made-up-model', 'subagent')]);
  assert.equal(r.dollarsSaved, 0);
  assert.deepEqual(r.savedByModel, {});
  // All-unknown -> nothing priceable -> null -> empty line.
  assert.equal(realizedFromRecords([rec('totally-made-up-model', 'user')]), null);
  assert.equal(buildTagline(null), '');
});

test('exact (gateway) savings drop the "about " qualifier; estimate keeps it', () => {
  const mk = (exact) => ({ ceilingModel: 'claude-opus-4', dollarsSaved: 1.23,
    tokensCredited: 3e6, creditedCalls: 4, extraByModel: {}, extraCost: 0,
    savedByModel: { 'claude-haiku-4-5': 3, 'claude-sonnet-4-5': 1 }, exact });
  const est = buildTagline(mk(false));
  assert.match(est, /saved 🟢 about \$1\.23 and 3\.0M tokens/);
  const exact = buildTagline(mk(true));
  assert.match(exact, /saved 🟢 \$1\.23 and 3\.0M tokens/);
  assert.ok(!exact.includes('about $'));
});

test('fromGateway maps a session-filtered summary to the tagline shape', () => {
  const g = fromGateway({
    total: 5,
    baseline_model: 'claude-opus-5',
    by_tier: {
      haiku: { count: 3, in_tokens: 1e6, out_tokens: 1e6 },
      sonnet: { count: 1, in_tokens: 5e5, out_tokens: 5e5 },
      opus: { count: 1, in_tokens: 2e5, out_tokens: 2e5 },
    },
    dollars: { saved: 1.23 },
    counts: { models_changed: 4 },
    tokens: { downgraded: 3_000_000 }, // gateway's exact tokens-on-downgraded-rows
    downgraded_by_model: { 'claude-haiku-4-5': 3, 'claude-sonnet-5': 1 },
  });
  assert.equal(g.exact, true);
  assert.equal(g.dollarsSaved, 1.23);
  assert.equal(g.tokensCredited, 3_000_000); // straight from tokens.downgraded
  assert.deepEqual(g.savedByModel, { 'claude-haiku-4-5': 3, 'claude-sonnet-5': 1 });
  assert.equal(g.ceilingModel, 'claude-opus-5');
});

test('fromGateway degrades to null for a pre-0.3.0 gateway, never a half shape', () => {
  // An older gateway reports tiers but no baseline_model / downgraded_by_model. Rendering
  // that would print "ran this chat on undefined" to precisely the users who installed
  // the gateway. Returning null falls back to the (less precise) transcript estimate.
  const old = { total: 5, by_tier: { haiku: { count: 5, in_tokens: 2e6, out_tokens: 1e6 } },
    dollars: { saved: 4.2 }, counts: { models_changed: 5 },
    downgraded_by_tier: { haiku: 5, sonnet: 0, opus: 0 } };
  assert.equal(fromGateway(old), null);
  assert.equal(buildTagline(fromGateway(old)), '');
});

test('gateway uniform-downgrade never prints "$X and 0 tokens"', () => {
  // The core value-prop case: an opus-requesting session routed entirely to haiku.
  const summary = {
    total: 5,
    baseline_model: 'claude-opus-5',
    by_tier: { haiku: { count: 5, in_tokens: 2e6, out_tokens: 1e6 } },
    dollars: { saved: 4.2 },
    counts: { models_changed: 5 },
    tokens: { downgraded: 3_000_000 },
    downgraded_by_model: { 'claude-haiku-4-5': 5 },
  };
  const g = fromGateway(summary);
  assert.ok(g.tokensCredited > 0, 'tokensCredited must not be 0 when dollars were saved');
  const line = buildTagline(g);
  assert.ok(!line.includes('0 tokens'), 'no "0 tokens" contradiction: ' + line);
  assert.match(line, /^Cheaper\.app saved 🟢 \$4\.20 and 3\.0M tokens by running 5 calls on claude-haiku-4-5 instead of claude-opus-5, at list API rates\.$/);
});

test('sub-cent savings round away — no "$0.00 saved" claim', () => {
  const r = realizedFromRecords([rec('claude-opus-4', 'user'),
    rec('claude-haiku-4-5', 'subagent', 10, 10)]); // ~$0.0009 saved
  assert.ok(r.dollarsSaved > 0 && r.dollarsSaved < 0.01);
  assert.ok(buildTagline(r).startsWith('Cheaper.app ran this chat on claude-opus-4 — no routing saving to claim.'));
});

test('an exact sub-cent saving (0.5c–1c) is suppressed, not rounded up to $0.01', () => {
  const r = { exact: true, dollarsSaved: 0.006, tokensCredited: 20, creditedCalls: 1,
    savedByModel: { 'claude-haiku-4-5': 1 }, extraByModel: {}, extraCost: 0,
    ceilingModel: 'claude-opus-4', topModel: 'claude-opus-4' };
  const line = buildTagline(r);
  assert.ok(!line.includes('$0.01'), 'must not present $0.006 as an exact $0.01: ' + line);
  assert.match(line, /ran this chat on claude-opus-4/);
});

test('cross-family: below-ceiling calls are priced at the ceiling MODEL, not the sub-task family', () => {
  // Ceiling model is gemini-2.5-pro (google/opus tier). A Claude Haiku sub-agent below it
  // must be credited (gemini-pro cost − haiku cost), NOT (Anthropic Opus − Anthropic Haiku).
  const r = realizedFromRecords([
    rec('gemini-2.5-pro', 'user'),        // google, opus tier → the ceiling
    rec('claude-haiku-4-5', 'subagent'),  // anthropic, haiku tier → below ceiling
  ]);
  assert.equal(r.ceilingModel, 'gemini-2.5-pro');
  // The baseline is the ceiling MODEL's own published rates, including its >200k
  // long-context tier: this 1M-token call bills at $2.50/$15, so baseline = 17.50.
  // Actual = anthropic haiku (1 + 5) = 6 ; saved 11.50.
  assert.ok(Math.abs(r.dollarsSaved - 11.5) < 1e-6, 'dollarsSaved=' + r.dollarsSaved);
  // NOT the fabricated $84 that anthropic-opus-vs-anthropic-haiku would give.
  assert.ok(r.dollarsSaved < 20, 'must not invent Anthropic-Opus-scale savings: ' + r.dollarsSaved);
});

test('a sub-agent ABOVE the baseline is a named anti-saving, not a silent zero', () => {
  // User turn on Haiku, but an Opus sub-agent ran. The old code discarded the negative
  // (`if (save > 0)`) and printed a cheerful "no cheaper routing was warranted" over
  // work that cost real extra money. Now the overage is stated.
  const r = realizedFromRecords([rec('claude-haiku-4-5', 'user'), rec('claude-opus-4', 'subagent')]);
  assert.equal(r.ceilingModel, 'claude-haiku-4-5');
  assert.equal(r.topModel, 'claude-opus-4');
  // baseline haiku on the opus call's tokens = 1 + 5 = 6 ; actual opus = 15 + 75 = 90.
  assert.ok(Math.abs(r.dollarsSaved + 84) < 1e-6, 'dollarsSaved=' + r.dollarsSaved);
  assert.equal(r.creditedCalls, 0);
  assert.equal(r.offsetCalls, 1);
  assert.deepEqual(r.extraByModel, { 'claude-opus-4': 1 });
  const line = buildTagline(r);
  assert.match(line, /^Cheaper\.app claims no saving on this chat — routed work cost \$84\.00 more than claude-haiku-4-5 would have\./);
});

test('scoping: --transcript / --session / --current read exactly one chat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-scope-'));
  const proj = path.join(dir, '.claude', 'projects', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  const mk = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  // sessA: trivial prompt on Opus + a Haiku sub-agent -> downgradable.
  fs.writeFileSync(path.join(proj, 'sessA.jsonl'), mk([
    { type: 'user', message: { role: 'user', content: 'rename foo' }, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'assistant', isSidechain: false, message: { id: 'a1', role: 'assistant', model: 'claude-opus-4',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1e6, output_tokens: 1e6 } }, timestamp: '2026-01-01T00:00:01Z' },
    { type: 'assistant', isSidechain: true, message: { id: 'a2', role: 'assistant', model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1e6, output_tokens: 1e6 } }, timestamp: '2026-01-01T00:00:02Z' },
  ]));
  // sessB: only an Opus main turn -> nothing to downgrade.
  fs.writeFileSync(path.join(proj, 'sessB.jsonl'), mk([
    { type: 'user', message: { role: 'user', content: 'prove the lock is race-free' }, timestamp: '2026-01-02T00:00:00Z' },
    { type: 'assistant', isSidechain: false, message: { id: 'b1', role: 'assistant', model: 'claude-opus-4',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1e6, output_tokens: 1e6 } }, timestamp: '2026-01-02T00:00:01Z' },
  ]));
  // Make sessB the newest so --current resolves to it deterministically.
  const t = Date.now() / 1000;
  fs.utimesSync(path.join(proj, 'sessA.jsonl'), t - 100, t - 100);
  fs.utimesSync(path.join(proj, 'sessB.jsonl'), t, t);

  const saved = process.env.CHEAPER_PEEK_HOME;
  process.env.CHEAPER_PEEK_HOME = dir;
  try {
    delete require.cache[require.resolve('../src/peek/fsutil')];
    delete require.cache[require.resolve('../src/peek/adapters')];
    const { HARNESSES, collectHarness } = require('../src/peek/adapters');
    const def = HARNESSES.find((d) => d.key === 'claude-code');

    // --transcript sessA -> both calls, downgradable.
    const a = collectHarness(def, { transcript: path.join(proj, 'sessA.jsonl') });
    assert.equal(a.records.length, 2);
    assert.ok(realizedFromRecords(a.records).dollarsSaved > 80);

    // --session sessB -> only sessB's one Opus call, no saving.
    const b = collectHarness(def, { session: 'sessB' });
    assert.equal(b.records.length, 1);
    assert.equal(realizedFromRecords(b.records).dollarsSaved, 0);

    // --current -> newest (sessB).
    const cur = collectHarness(def, { current: true });
    assert.equal(cur.records.length, 1);
    assert.equal(cur.records[0].model, 'claude-opus-4');
  } finally {
    if (saved === undefined) delete process.env.CHEAPER_PEEK_HOME;
    else process.env.CHEAPER_PEEK_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    delete require.cache[require.resolve('../src/peek/fsutil')];
    delete require.cache[require.resolve('../src/peek/adapters')];
  }
});

test('scoping rolls in the session\'s own sub-agent transcripts (Claude Code)', () => {
  // A chat's sub-agents live in a sibling <id>/ dir; their savings MUST be credited,
  // else a chat that delegated to cheaper tiers reports $0 (measuring only the main loop).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-sub-'));
  const proj = path.join(dir, '.claude', 'projects', 'demo');
  const subs = path.join(proj, 'ses01', 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  const mk = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  // Main transcript: one Opus turn (the ceiling).
  fs.writeFileSync(path.join(proj, 'ses01.jsonl'), mk([
    { type: 'assistant', isSidechain: false, message: { id: 'm', role: 'assistant', model: 'claude-opus-4',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1e6, output_tokens: 1e6 } }, timestamp: '2026-01-01T00:00:00Z' },
  ]));
  // A SEPARATE sub-agent transcript for the same session: a Haiku worker below the ceiling.
  fs.writeFileSync(path.join(subs, 'agent-1.jsonl'), mk([
    { type: 'assistant', message: { id: 's', role: 'assistant', model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1e6, output_tokens: 1e6 } }, timestamp: '2026-01-01T00:00:05Z' },
  ]));
  const saved = process.env.CHEAPER_PEEK_HOME;
  process.env.CHEAPER_PEEK_HOME = dir;
  try {
    delete require.cache[require.resolve('../src/peek/fsutil')];
    delete require.cache[require.resolve('../src/peek/adapters')];
    const { HARNESSES, collectHarness } = require('../src/peek/adapters');
    const def = HARNESSES.find((d) => d.key === 'claude-code');

    // --transcript of the MAIN file must pull in the sibling sub-agent transcript.
    const t = collectHarness(def, { transcript: path.join(proj, 'ses01.jsonl') });
    assert.equal(t.records.length, 2, 'main + sub-agent');
    const rt = realizedFromRecords(t.records);
    assert.ok(rt.dollarsSaved > 80, 'sub-agent savings credited: ' + rt.dollarsSaved);
    assert.deepEqual(rt.savedByModel, { 'claude-haiku-4-5': 1 });

    // --session and --current give the same whole-session view.
    assert.equal(collectHarness(def, { session: 'ses01' }).records.length, 2);
    assert.equal(collectHarness(def, { current: true }).records.length, 2);
  } finally {
    if (saved === undefined) delete process.env.CHEAPER_PEEK_HOME;
    else process.env.CHEAPER_PEEK_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    delete require.cache[require.resolve('../src/peek/fsutil')];
    delete require.cache[require.resolve('../src/peek/adapters')];
  }
});

test('ledger is signed and always overwrites — not a high-water ratchet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-ratchet-'));
  const saved = process.env.CHEAPER_LEDGER_FILE;
  process.env.CHEAPER_LEDGER_FILE = path.join(dir, 'lifetime.json');
  try {
    delete require.cache[require.resolve('../src/peek/ledger')];
    const led = require('../src/peek/ledger');
    // A chat that cost MORE than its baseline contributes a negative amount.
    led.record('chat-a', 10, 1000, false);
    const afterNeg = led.record('chat-b', -5, 1000, false);
    assert.ok(Math.abs(afterNeg.usd - 5) < 1e-9, 'signed sum expected 5, got ' + afterNeg.usd);
    // A corrected re-run must OVERWRITE, even when the corrected figure is smaller or
    // negative. The old `usd > 0` guard skipped the write and froze the stale value.
    const corrected = led.record('chat-a', 2, 1000, true);
    assert.ok(Math.abs(corrected.usd - (-3)) < 1e-9, 'expected -3 after correction, got ' + corrected.usd);
    // ...and a non-positive lifetime total prints nothing rather than a negative claim.
    assert.equal(buildTagline(null), '');
  } finally {
    if (saved === undefined) delete process.env.CHEAPER_LEDGER_FILE;
    else process.env.CHEAPER_LEDGER_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    delete require.cache[require.resolve('../src/peek/ledger')];
  }
});

// ---- lifetime ledger + tagline wiring --------------------------------------

test('lifetime ledger: idempotent per chat, sums across chats, honest about exactness', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-ledger-'));
  const saved = process.env.CHEAPER_LEDGER_FILE;
  process.env.CHEAPER_LEDGER_FILE = path.join(dir, 'lifetime.json');
  try {
    delete require.cache[require.resolve('../src/peek/ledger')];
    const ledger = require('../src/peek/ledger');
    // First chat (estimate).
    let t = ledger.record('chatA', 10, 1e6, false);
    assert.deepEqual([t.usd, t.tokens, t.chats, t.exact], [10, 1e6, 1, false]);
    // SAME chat re-run with the higher final figure → overwrite, never add.
    t = ledger.record('chatA', 12, 1.2e6, false);
    assert.deepEqual([t.usd, t.chats], [12, 1]);
    // Second chat (exact) → sums; aggregate stays inexact because chatA was an estimate.
    t = ledger.record('chatB', 3, 5e5, true);
    assert.equal(t.chats, 2);
    assert.ok(Math.abs(t.usd - 15) < 1e-9);
    assert.equal(t.tokens, 1.2e6 + 5e5);
    assert.equal(t.exact, false);
    // A no-saving run never creates or erases an entry; a missing key is a pure read.
    assert.equal(ledger.record('chatC', 0, 0, false).chats, 2);
    assert.equal(ledger.record(null, 99, 99, false).chats, 2);
    // Persisted + reloadable across process/module reloads.
    delete require.cache[require.resolve('../src/peek/ledger')];
    assert.equal(require('../src/peek/ledger').totals().chats, 2);
  } finally {
    if (saved === undefined) delete process.env.CHEAPER_LEDGER_FILE;
    else process.env.CHEAPER_LEDGER_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    delete require.cache[require.resolve('../src/peek/ledger')];
  }
});

test('tagline run: brand links to /love, appends lifetime, idempotent per chat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-run-'));
  const proj = path.join(dir, '.claude', 'projects', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  const mk = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  // A chat that downgrades: an Opus main turn + a Haiku sub-agent below the ceiling.
  fs.writeFileSync(path.join(proj, 'sesX.jsonl'), mk([
    { type: 'user', message: { role: 'user', content: 'rename foo' }, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'assistant', isSidechain: false, message: { id: 'x1', role: 'assistant', model: 'claude-opus-4',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1e6, output_tokens: 1e6 } }, timestamp: '2026-01-01T00:00:01Z' },
    { type: 'assistant', isSidechain: true, message: { id: 'x2', role: 'assistant', model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1e6, output_tokens: 1e6 } }, timestamp: '2026-01-01T00:00:02Z' },
  ]));
  const savedHome = process.env.CHEAPER_PEEK_HOME;
  const savedLedger = process.env.CHEAPER_LEDGER_FILE;
  const savedPort = process.env.CHEAPER_PORT;
  process.env.CHEAPER_PEEK_HOME = dir;
  process.env.CHEAPER_LEDGER_FILE = path.join(dir, 'lifetime.json');
  process.env.CHEAPER_PORT = '59421'; // nothing listening → forces the estimate path
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(String(s));
  try {
    for (const m of ['fsutil', 'adapters', 'scan', 'ledger', 'tagline']) {
      delete require.cache[require.resolve('../src/peek/' + m)];
    }
    const tag = require('../src/peek/tagline');
    const opts = { transcript: path.join(proj, 'sesX.jsonl') };
    await tag.run({ ...opts, json: true });                 // 1st run (records chat)
    const j1 = JSON.parse(logs[logs.length - 1]);
    await tag.run({ ...opts, json: true });                 // 2nd run, SAME chat
    const j2 = JSON.parse(logs[logs.length - 1]);
    await tag.run({ ...opts, format: 'markdown' });          // rendered line
    var rendered = logs[logs.length - 1];
    var life1 = j1.lifetime; var life2 = j2.lifetime;
  } finally {
    console.log = orig;
    if (savedHome === undefined) delete process.env.CHEAPER_PEEK_HOME; else process.env.CHEAPER_PEEK_HOME = savedHome;
    if (savedLedger === undefined) delete process.env.CHEAPER_LEDGER_FILE; else process.env.CHEAPER_LEDGER_FILE = savedLedger;
    if (savedPort === undefined) delete process.env.CHEAPER_PORT; else process.env.CHEAPER_PORT = savedPort;
    fs.rmSync(dir, { recursive: true, force: true });
    for (const m of ['fsutil', 'adapters', 'scan', 'ledger', 'tagline']) {
      delete require.cache[require.resolve('../src/peek/' + m)];
    }
  }
  // The haiku sub-agent saved (15+75)-(1+5)=$84 over the opus ceiling, on 2M tokens.
  assert.ok(Math.abs(life1.usd - 84) < 1e-6, 'lifetime usd=' + life1.usd);
  assert.equal(life1.chats, 1);
  // Re-running the SAME chat does NOT double the lifetime total.
  assert.ok(Math.abs(life2.usd - 84) < 1e-6, 'idempotent lifetime=' + life2.usd);
  assert.equal(life2.chats, 1);
  // Brand renders as a markdown link to the /love page, and the lifetime line is appended.
  assert.ok(rendered.startsWith('[Cheaper.app](https://cheaper.app/love)'), 'brand → /love: ' + rendered);
  assert.match(rendered, / Lifetime savings: 🟢 about \$84\.00 and 2\.0M tokens\./);
  // The "See logs" link to the local dashboard is the very last thing on the line.
  assert.ok(rendered.endsWith(' [See logs](http://localhost:59421/dashboard)'), 'See logs suffix: ' + rendered);
});

test('regression: no "$" in the tagline is ever preceded by "~" or "-"', () => {
  // The estimate path (exact: false) is the one that used to prefix "~$", which read
  // as a minus sign next to the dollar amount. Cover both the per-chat line and the
  // lifetime sentence, in both the plain/markdown and ansi renderers.
  const r = { ceilingTier: 'opus', topTier: 'opus', dollarsSaved: 5, tokensSaved: 1e6,
    belowCeilingCalls: 1, savedTierHist: { haiku: 0, sonnet: 1, opus: 0 }, totalSpent: 10,
    totalTokens: 2e6, exact: false };
  for (const format of [undefined, 'markdown', 'ansi']) {
    const line = buildTagline(r, 'Cheaper.app', format);
    assert.ok(!/[~-]\$/.test(line), `format=${format}: ${JSON.stringify(line)}`);
  }
  const est = buildTagline({ ceilingTier: 'opus', dollarsSaved: 1.23, tokensSaved: 3e6,
    belowCeilingCalls: 4, savedTierHist: { haiku: 3, sonnet: 1, opus: 0 }, exact: false });
  assert.ok(!/[~-]\$/.test(est), JSON.stringify(est));
});

test('a stale gateway can never produce an UNHEDGED figure', () => {
  // The worst failure mode in the system: a gateway process that imported an older
  // build keeps serving old logic forever, and its numbers print with no "about "
  // qualifier. Current builds report `catalog` in their summary; a summary without it
  // must be refused rather than trusted.
  const { gatewayIsCurrent } = require('../src/peek/tagline');
  assert.equal(gatewayIsCurrent({ catalog: { priced: true, as_of: '2026-08-06' } }), true);
  assert.equal(gatewayIsCurrent({ by_tier: {}, dollars: {} }), false, 'pre-catalog build');
  assert.equal(gatewayIsCurrent({ catalog: { priced: false } }), false, 'pricing module absent');
  assert.equal(gatewayIsCurrent(null), false);
});

test('freshness: content hashes detect drift and ignore runtime state', () => {
  const fs2 = require('fs');
  const { hashDir } = require('../src/freshness');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  for (const d of [a, b]) fs2.mkdirSync(path.join(d, 'app'), { recursive: true });
  for (const d of [a, b]) fs2.writeFileSync(path.join(d, 'app', 'x.py'), 'print(1)\n');
  try {
    assert.equal(hashDir(a), hashDir(b), 'identical trees must hash identically');

    // Runtime state Claude Code writes into the plugin cache must NOT count as drift —
    // a check that always fires is one nobody reads.
    fs2.mkdirSync(path.join(b, '.in_use'), { recursive: true });
    fs2.writeFileSync(path.join(b, '.in_use', '12345'), 'pid');
    fs2.mkdirSync(path.join(b, '__pycache__'), { recursive: true });
    fs2.writeFileSync(path.join(b, '__pycache__', 'x.pyc'), 'bytecode');
    assert.equal(hashDir(a), hashDir(b), 'runtime state must be ignored');

    // A real content change MUST be detected.
    fs2.writeFileSync(path.join(b, 'app', 'x.py'), 'print(2)\n');
    assert.notEqual(hashDir(a), hashDir(b), 'a real edit must change the digest');

    // A missing directory is distinguishable from a differing one.
    assert.equal(hashDir(path.join(dir, 'nope')), null);
  } finally {
    fs2.rmSync(dir, { recursive: true, force: true });
  }
});

test('streamed turns keep MAX usage, and dedupe spans files', () => {
  // A single API turn is written to the transcript many times as it streams, and the
  // repeats are NOT identical — usage grows with each line. Keeping the first
  // occurrence under-counted output tokens by 18.9% across 120 real transcripts
  // (774 ids grew, 0 shrank). And 157 ids appeared in more than one file, because
  // Claude Code copies history forward on resume/fork, so a per-file dedupe set
  // counted those turns twice.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-dedupe-'));
  const proj = path.join(dir, '.claude', 'projects', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  const turn = (id, out, text) => ({
    type: 'assistant', isSidechain: false,
    message: { id, role: 'assistant', model: 'claude-opus-5',
               content: [{ type: 'text', text }],
               usage: { input_tokens: 1000, output_tokens: out } },
    timestamp: '2026-01-01T00:00:0' + (out % 10) + 'Z',
  });
  // One turn streamed across three growing lines...
  fs.writeFileSync(path.join(proj, 'a.jsonl'),
    [turn('msg_S', 10, 'a'), turn('msg_S', 500, 'ab'), turn('msg_S', 4000, 'abc')]
      .map((l) => JSON.stringify(l)).join('\n') + '\n');
  // ...and the SAME turn copied forward into a resumed session's file.
  fs.writeFileSync(path.join(proj, 'b.jsonl'),
    [turn('msg_S', 4000, 'abc'), turn('msg_T', 77, 'z')]
      .map((l) => JSON.stringify(l)).join('\n') + '\n');

  const saved = process.env.CHEAPER_PEEK_HOME;
  process.env.CHEAPER_PEEK_HOME = dir;
  try {
    for (const m of ['../src/peek/fsutil', '../src/peek/adapters'])
      delete require.cache[require.resolve(m)];
    const { HARNESSES, collectHarness } = require('../src/peek/adapters');
    const def = HARNESSES.find((h) => h.key === 'claude-code');
    const recs = collectHarness(def, {}).records;

    const s = recs.filter((r) => r.outTokens === 4000);
    assert.equal(s.length, 1, 'the streamed turn must appear exactly once');
    assert.equal(recs.length, 2, 'two distinct turns total, not five lines');
    // Max-wins, not first-wins: 10 would be an 18.9%-style under-count.
    assert.equal(recs.reduce((a, r) => a + r.outTokens, 0), 4077);
  } finally {
    if (saved === undefined) delete process.env.CHEAPER_PEEK_HOME;
    else process.env.CHEAPER_PEEK_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    for (const m of ['../src/peek/fsutil', '../src/peek/adapters'])
      delete require.cache[require.resolve(m)];
  }
});

// ---- the source of truth is elected on AVAILABILITY, never on the sign of its answer --

// A throwaway localhost gateway that answers /metrics with one canned summary.
function fakeGateway(summary) {
  const httpMod = require('http');
  return new Promise((resolve) => {
    const srv = httpMod.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(summary));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// A fixture chat whose TRANSCRIPT estimate is a confident +$84 on 2.0M tokens: an Opus
// main turn plus a Haiku sub-agent below it. Every case below asserts what the tagline
// does when the GATEWAY — the only measurement of what was actually ROUTED — disagrees
// with that estimate. `summary: null` means "no gateway running".
async function taglineWithGateway(summary) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-elect-'));
  const proj = path.join(dir, '.claude', 'projects', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  const mk = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(path.join(proj, 'sesG.jsonl'), mk([
    { type: 'user', message: { role: 'user', content: 'rename foo' }, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'assistant', isSidechain: false, message: { id: 'g1', role: 'assistant', model: 'claude-opus-4',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1e6, output_tokens: 1e6 } }, timestamp: '2026-01-01T00:00:01Z' },
    { type: 'assistant', isSidechain: true, message: { id: 'g2', role: 'assistant', model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1e6, output_tokens: 1e6 } }, timestamp: '2026-01-01T00:00:02Z' },
  ]));
  const srv = summary ? await fakeGateway(summary) : null;
  const env = ['CHEAPER_PEEK_HOME', 'CHEAPER_LEDGER_FILE', 'CHEAPER_PORT', 'CHEAPER_TOKEN_FILE'];
  const prev = {}; for (const k of env) prev[k] = process.env[k];
  process.env.CHEAPER_PEEK_HOME = dir;
  process.env.CHEAPER_LEDGER_FILE = path.join(dir, 'lifetime.json');
  // Nothing is listening on 59421, so a null summary exercises the gateway-absent path.
  process.env.CHEAPER_PORT = srv ? String(srv.address().port) : '59421';
  // Never read (and therefore never transmit) the real ~/.cheaper/dash.token.
  process.env.CHEAPER_TOKEN_FILE = path.join(dir, 'no-such.token');
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(String(s));
  try {
    for (const m of ['fsutil', 'adapters', 'scan', 'ledger', 'tagline']) {
      delete require.cache[require.resolve('../src/peek/' + m)];
    }
    const tag = require('../src/peek/tagline');
    await tag.run({ transcript: path.join(proj, 'sesG.jsonl'), json: true });
    return JSON.parse(logs[logs.length - 1]);
  } finally {
    console.log = orig;
    if (srv) await new Promise((r) => srv.close(r));
    for (const k of env) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
    for (const m of ['fsutil', 'adapters', 'scan', 'ledger', 'tagline']) {
      delete require.cache[require.resolve('../src/peek/' + m)];
    }
  }
}

// A current-build gateway summary for the fixture chat above. Overrides merge in.
function gwSummary(over) {
  return Object.assign({
    catalog: { priced: true, as_of: '2026-08-06', age_days: 1 },
    total: 6,
    baseline_model: 'claude-opus-5',
    top_model: 'claude-opus-5',
    by_tier: { opus: { count: 4, in_tokens: 1e6, out_tokens: 5e5 },
               haiku: { count: 2, in_tokens: 4e5, out_tokens: 1e5 } },
    dollars: { saved: 0, spent: 5, gross: 0, extra: 0, billed_top: 5, savings_pct: 0 },
    counts: { models_changed: 0, models_upcharged: 0,
              examined: 6, priced: 6, unpriced_total: 0, truncated: false },
    tokens: { downgraded: 0 },
    downgraded_by_model: {},
    upcharged_by_model: {},
  }, over || {});
}

test('a MEASURED anti-saving is reported as one — the transcript estimate must not overwrite it', async () => {
  // The gateway watched this chat and measured a NET LOSS: some rows were routed cheaper
  // ($1.00 of gross saving on 600k tokens) and one was routed to a costlier model
  // (-$3.00), for a signed net of -$2.00. The old `dollarsSaved >= SHOW_MIN_USD` guard
  // rejected that answer for being negative and fell through to realizedFromRecords(),
  // a different source with a different baseline, which reports +$84 for this fixture —
  // so the sign of the answer chose the measurement, and buildTagline's anti-saving
  // branch was unreachable from the gateway path.
  const j = await taglineWithGateway(gwSummary({
    dollars: { saved: -2, spent: 5, gross: 1, extra: 3, billed_top: 3, savings_pct: -66.7 },
    counts: { models_changed: 2, models_upcharged: 1,
              examined: 6, priced: 6, unpriced_total: 0, truncated: false },
    tokens: { downgraded: 600000 },
    downgraded_by_model: { 'claude-haiku-4-5': 2 },
    upcharged_by_model: { 'claude-fable-5': 1 },
  }));
  assert.equal(j.source, 'gateway', 'the gateway answered, so it is the source: ' + j.source);
  assert.equal(j.result.dollarsSaved, -2);
  assert.match(j.line, /^Cheaper\.app claims no saving on this chat — routed work cost \$2\.00 more than claude-opus-5 would have\./,
    'the loss must be stated and named: ' + j.line);
  assert.ok(!/saved/.test(j.line.split('—')[0]), 'no saving may be claimed: ' + j.line);
  assert.equal(j.result.exact, true, 'an exact figure is never hedged with "about "');
  // Asserted on `line`, not `full`: `full` carries the See-logs URL and its ephemeral
  // port number, whose digits can contain "84" by coincidence (they did).
  assert.ok(!/84/.test(j.line), 'the transcript estimate must not leak in: ' + j.line);
  // (iv) the LEDGER gets the signed gateway figure, not the estimate's +$84.
  assert.ok(Math.abs(j.lifetime.usd + 2) < 1e-9, 'lifetime must be -2, got ' + j.lifetime.usd);
  assert.equal(j.lifetime.exact, true);
});

test('a MEASURED $0.00 with rows present claims nothing — no estimate is manufactured', async () => {
  // The commoner form of the same bug: the gateway watched the chat and NOTHING was
  // routed, so the measured saving is exactly $0.00. That is a measurement, not a
  // missing answer — but it failed the `>= SHOW_MIN_USD` guard identically, and the
  // transcript estimator then manufactured an $84 claim about routing the only
  // instrument watching says did not happen.
  const j = await taglineWithGateway(gwSummary({}));
  assert.equal(j.source, 'gateway', 'source=' + j.source);
  assert.equal(j.result.dollarsSaved, 0);
  assert.match(j.line, /^Cheaper\.app ran this chat on claude-opus-5 — no routing saving to claim\./, j.line);
  assert.ok(!/saved/.test(j.line), 'a measured zero must not print a saving: ' + j.line);
  assert.equal(j.result.exact, true, 'this is a measurement, not an estimate');
  // See the note above: `full` ends in a URL whose port digits are not ours to assert on.
  assert.ok(!/84/.test(j.line), 'the transcript estimate must not leak in: ' + j.line);
  // Nothing was saved, so nothing is added to the lifetime total either.
  assert.equal(j.lifetime.usd, 0);
});

test('no gateway → the transcript estimate is still used, and still hedged', async () => {
  // Election is on AVAILABILITY: absent/stale/unusable gateway → fall back. The estimate
  // keeps its "about " qualifier because it is not a measurement.
  const j = await taglineWithGateway(null);
  assert.equal(j.source, 'estimate', 'source=' + j.source);
  assert.ok(Math.abs(j.result.dollarsSaved - 84) < 1e-6, 'dollarsSaved=' + j.result.dollarsSaved);
  assert.match(j.line, /^Cheaper\.app saved 🟢 about \$84\.00 and 2\.0M tokens by running 1 call on claude-haiku-4-5 instead of claude-opus-4/, j.line);
  assert.ok(Math.abs(j.lifetime.usd - 84) < 1e-6, 'lifetime=' + j.lifetime.usd);
});

test('a gateway with NO usable rows for the session still falls back (not an empty zero)', async () => {
  // The safety property the unconditional return depends on: a session-filtered summary
  // whose rows are all unpriceable leaves baseline_model None, fromGateway returns null,
  // and the transcript estimate answers instead. Returning the gateway "because it
  // replied" must never print a $0 assembled from no rows at all.
  const j = await taglineWithGateway(gwSummary({ baseline_model: null, top_model: null }));
  assert.equal(j.source, 'estimate', 'unusable gateway shape must fall back: ' + j.source);
  assert.ok(Math.abs(j.result.dollarsSaved - 84) < 1e-6);
});

// ---- spendSentence states WHICH rows each of its two halves covers -------------------

test('gateway spend sentence labels its coverage: all-rows tokens vs priced-subset dollars', () => {
  // metrics.py builds by_tier with an unbounded `GROUP BY tier` over every row in the
  // session, while dollars.spent covers only counts.priced of them. Pairing the two in
  // one sentence describes two different populations as if they were one (invariant 1),
  // and a reader dividing them gets a per-token rate that is true of neither.
  const g = fromGateway({
    total: 50, baseline_model: 'claude-opus-5', top_model: 'claude-opus-5',
    by_tier: { opus: { count: 50, in_tokens: 3e6, out_tokens: 1e6 } },
    dollars: { saved: 0, spent: 12.5 },
    counts: { models_changed: 0, examined: 50, priced: 45, unpriced_total: 5, truncated: false },
    tokens: { downgraded: 0 },
    downgraded_by_model: {},
  });
  const line = buildTagline(g);
  assert.match(line, /This session ran 4\.0M tokens, worth 🔴 \$12\.50 at list API rates\./, line);
  assert.match(line, / Coverage: the token count covers all 50 calls, the dollar figure only the 45 that could be priced\.$/, line);

  // Fully-priced session → nothing to disclaim, so no note at all.
  const clean = fromGateway({
    total: 50, baseline_model: 'claude-opus-5', top_model: 'claude-opus-5',
    by_tier: { opus: { count: 50, in_tokens: 3e6, out_tokens: 1e6 } },
    dollars: { saved: 0, spent: 12.5 },
    counts: { models_changed: 0, examined: 50, priced: 50, unpriced_total: 0, truncated: false },
    tokens: { downgraded: 0 }, downgraded_by_model: {},
  });
  assert.ok(!/Coverage:/.test(buildTagline(clean)), buildTagline(clean));

  // A truncated ledger is a SAMPLE, and says so.
  const cut = fromGateway({
    total: 9000, baseline_model: 'claude-opus-5', top_model: 'claude-opus-5',
    by_tier: { opus: { count: 5000, in_tokens: 3e6, out_tokens: 1e6 } },
    dollars: { saved: 0, spent: 12.5 },
    counts: { models_changed: 0, examined: 5000, priced: 5000, unpriced_total: 0, truncated: true },
    tokens: { downgraded: 0 }, downgraded_by_model: {},
  });
  assert.match(buildTagline(cut), / Coverage: this is the newest 5000 of 9000 calls\.$/, buildTagline(cut));
});

test('transcript spend sentence admits the calls it could not price', () => {
  // Here BOTH halves are the priceable subset, so they agree with each other — and both
  // under-state the session, because the unpriceable record was filtered out before
  // either was accumulated. "This session ran 2.0M tokens" is false of a session that
  // ran 4.0M; the coverage note is what makes it true.
  const r = realizedFromRecords([rec('claude-opus-4', 'user'), rec('llama-4-maverick', 'user')]);
  const line = buildTagline(r);
  assert.match(line, / Coverage: both figures cover only the 1 of 2 calls that could be priced\.$/, line);
  // ...and a session where everything priced says nothing extra.
  assert.ok(!/Coverage:/.test(buildTagline(realizedFromRecords([
    rec('claude-opus-4', 'user'), rec('claude-haiku-4-5', 'subagent')]))));
});

// ---- the counterfactual arm's PROMPT-CACHE STATE, on the tagline --------------------
//
// A prompt cache is keyed on (model, exact prefix), so CHANGING MODEL INVALIDATES IT. The
// served arm starts cold and pays a cache CREATE for a prefix the un-switched baseline
// would still have held and merely READ. `realizedFromRecords` priced BOTH legs off one
// `bk = tokenBreakdown(r)`, charging the baseline that CREATE too — and every catalog
// entry writes at or above its read rate, so the substitution could only move the baseline
// UP and the claimed saving with it.
//
// `derive.js` and `gateway/app/metrics.py` already WITHHOLD those rows. Until this
// adoption the end-of-chat line — the most-read number in the product — and the lifetime
// ledger it writes published a different, larger figure for the same chat than the
// append-only store did.

test('tagline: a COLD switched call is WITHHELD from the saving, counted, and disclosed', () => {
  const r = realizedFromRecords([
    // The ceiling: an Opus main-loop turn. 1M fresh in + 1M out = $90.
    { model: 'claude-opus-4', source: 'user', inTokens: 1e6, inFresh: 1e6, outTokens: 1e6 },
    // A sub-agent with NO cache traffic at all. Untouched by this rule, and the control
    // that proves the withholding is targeted rather than blanket: (15+75) - (1+5) = $84.
    { model: 'claude-haiku-4-5', source: 'subagent', inTokens: 1e6, inFresh: 1e6, outTokens: 1e6 },
    // COLD + SWITCHED: cacheRead 0 alongside a 1M five-minute WRITE. That write may be an
    // artefact of the switch itself, or a prefix genuinely new to the session — nothing on
    // the record separates the two, so the honest counterfactual is an interval, and here
    // it straddles zero.
    { model: 'claude-sonnet-4-5', source: 'subagent', inTokens: 1e6, inFresh: 0,
      cacheCreate5m: 1e6, cacheRead: 0, outTokens: 1e6 },
  ]);
  // THE DEFECT: the sonnet leg priced its baseline as an Opus CREATE (1M x $15 x 1.25 =
  // $18.75, plus $75 out = $93.75) against $18.75 actually spent, booking $75.00 on top of
  // the honest $84.00 and publishing $159.00.
  assert.ok(Math.abs(r.dollarsSaved - 84) < 1e-6,
    'expected $84.00; $159.00 is the cold-switch defect. dollarsSaved=' + r.dollarsSaved);
  assert.equal(r.creditedCalls, 1);
  assert.equal(r.tokensCredited, 2e6);                    // the haiku call only
  assert.deepEqual(r.savedByModel, { 'claude-haiku-4-5': 1 });
  // SKIPPED, not zeroed. A zeroed row is a claim that the saving was nothing; a skipped
  // row is a claim that it is unknowable. So the row appears in NO accumulator — not in
  // the offset half either, and `wouldHave` (the counterfactual total) never saw its
  // indeterminate leg.
  assert.equal(r.offsetCalls, 0);
  assert.deepEqual(r.extraByModel, {});
  assert.ok(Math.abs(r.wouldHave - 90) < 1e-6, 'wouldHave=' + r.wouldHave);
  // ...but it IS counted, so the line can state what it left out (invariants 4 and 7).
  assert.equal(r.population.withheld, 1);
  assert.equal(r.population.withheldTokens, 2e6);
  // The SPENT leg is a fact about a call that really happened and is not in doubt — only
  // the counterfactual was declined — so it still counts: $90 + $6 + $18.75.
  assert.ok(Math.abs(r.totalSpent - 114.75) < 1e-6, 'totalSpent=' + r.totalSpent);
  // ...and it is NOT folded into `unpriced`, which would tell the reader the spend figure
  // excludes a row it actually includes.
  assert.equal(r.population.unpriced, 0);

  const line = buildTagline(r);
  assert.match(line, /^Cheaper\.app saved 🟢 about \$84\.00 and 2\.0M tokens /, line);
  assert.ok(line.includes('by running 1 call on claude-haiku-4-5 instead of claude-opus-4'), line);
  // money() rounds to whole dollars at/above $100, so $114.75 renders as $115.
  assert.match(line, / This session ran 6\.0M tokens, worth 🔴 about \$115 at list API rates\./, line);
  // THE WITHHOLDING REACHES THE READER. A headline quietly reduced by rows the reader
  // cannot see is the same concealment as one quietly inflated by them.
  assert.match(line, / Coverage: 1 switched call claims no saving — a cold prompt cache leaves the un-switched baseline indeterminate\.$/, line);
});

test('tagline: a WARM switched call KEEPS its credit — the rule is not a blanket', () => {
  // Over-correcting is the failure mode that makes the product useless, so the negative
  // case is asserted explicitly. cacheRead > 0 means the served arm's prefix was ALREADY
  // resident, so this call's CREATE is content appended since the previous turn — content
  // the baseline model would have had to write as well. The served split IS the
  // counterfactual split here, and the existing pricing is exactly right.
  const r = realizedFromRecords([
    { model: 'claude-opus-4', source: 'user', inTokens: 1e6, inFresh: 1e6, outTokens: 1e6 },
    { model: 'claude-sonnet-4-5', source: 'subagent', inTokens: 2e6, inFresh: 0,
      cacheRead: 1e6, cacheCreate5m: 1e6, outTokens: 1e6 },
  ]);
  // sonnet spent: 1M read x $0.30 + 1M write x $3.75 + 1M out x $15 = $19.05.
  // opus-4 baseline on the SAME split: $1.50 + $18.75 + $75 = $95.25 → $76.20 credited.
  assert.ok(Math.abs(r.dollarsSaved - 76.2) < 1e-6, 'dollarsSaved=' + r.dollarsSaved);
  assert.equal(r.creditedCalls, 1);
  assert.equal(r.tokensCredited, 3e6);
  assert.deepEqual(r.savedByModel, { 'claude-sonnet-4-5': 1 });
  assert.equal(r.population.withheld, 0);
  const line = buildTagline(r);
  assert.ok(line.includes('by running 1 call on claude-sonnet-4-5 instead of claude-opus-4'), line);
  assert.ok(!/claims no saving/.test(line), 'a warm switch must keep its credit: ' + line);
  assert.ok(!/Coverage:/.test(line), line);
});

test('tagline: a chat with NO model switch is unchanged TO THE CENT by the cache rule', () => {
  // The no-op guard. Every row here is cache-bearing and one of them is COLD — the exact
  // shape a blanket "any cold cache write is indeterminate" rule would swallow — but
  // nothing SWITCHED model, so both arms are the same model on the same split, the delta
  // is zero under every cache assumption, and nothing may be withheld or disclosed.
  const recs = [
    { model: 'claude-opus-4', source: 'user', inTokens: 3e6, inFresh: 1e6,
      cacheRead: 1e6, cacheCreate5m: 1e6, outTokens: 1e6 },
    { model: 'claude-opus-4', source: 'subagent', inTokens: 1e6, inFresh: 0,
      cacheRead: 0, cacheCreate5m: 1e6, outTokens: 1e6 },
  ];
  const r = realizedFromRecords(recs);
  assert.equal(r.ceilingModel, 'claude-opus-4');
  assert.equal(r.population.withheld, 0);
  assert.equal(r.population.withheldTokens, 0);
  assert.equal(r.creditedCalls, 0);
  assert.equal(r.dollarsSaved, 0);
  // $15 fresh + $1.50 read + $18.75 write + $75 out = $110.25; then $18.75 + $75 = $93.75.
  assert.ok(Math.abs(r.totalSpent - 204) < 1e-6, 'totalSpent=' + r.totalSpent);
  // ...and the rendered line is byte-for-byte the line this session printed before the
  // rule existed: no coverage clause, no moved figure.
  assert.equal(buildTagline(r),
    'Cheaper.app ran this chat on claude-opus-4 — no routing saving to claim.'
    + ' This session ran 6.0M tokens, worth 🔴 about $204 at list API rates.');

  // The guard itself, read through the TRANSCRIPT's field vocabulary. In the control flow
  // above such a row is already `continue`d as "ran AT the baseline", so assert the
  // predicate directly rather than letting that hide a widened rule.
  const { recordCacheStateIndeterminate } = require('../src/peek/counterfactual');
  assert.equal(recordCacheStateIndeterminate(recs[1], 'claude-opus-4', 'claude-opus-4'), false);
  // ...and the SAME row does trip it once the model differs, which proves the fixture
  // really is the cold shape and that the switch guard is what did the work above.
  assert.equal(recordCacheStateIndeterminate(recs[1], 'claude-haiku-4-5', 'claude-opus-4'), true);
});

test('tagline run: the lifetime ledger receives the WITHHELD-adjusted figure', async () => {
  // End-to-end through the real transcript adapter, because the ledger is written from
  // `result.dollarsSaved` / `result.tokensCredited` inside run(). If the withholding stops
  // at the printed line, the all-time total keeps compounding the overstatement forever —
  // and an append-only ledger never forgets a wrong number.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-withheld-'));
  const proj = path.join(dir, '.claude', 'projects', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  const mk = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(path.join(proj, 'sesW.jsonl'), mk([
    { type: 'user', message: { role: 'user', content: 'rename foo' }, timestamp: '2026-01-01T00:00:00Z' },
    // Ceiling: Opus main turn, $90.
    { type: 'assistant', isSidechain: false, message: { id: 'w1', role: 'assistant', model: 'claude-opus-4',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1e6, output_tokens: 1e6 } }, timestamp: '2026-01-01T00:00:01Z' },
    // A clean Haiku sub-agent: (15+75) - (1+5) = $84 credited.
    { type: 'assistant', isSidechain: true, message: { id: 'w2', role: 'assistant', model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1e6, output_tokens: 1e6 } }, timestamp: '2026-01-01T00:00:02Z' },
    // A COLD Haiku sub-agent: the whole 1M input arrived as a 5-minute cache WRITE with no
    // read. Priced the old way its baseline was an Opus CREATE ($18.75 + $75 = $93.75)
    // against $6.25 spent — another $87.50, which is what used to reach the ledger.
    { type: 'assistant', isSidechain: true, message: { id: 'w3', role: 'assistant', model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 0, output_tokens: 1e6, cache_creation_input_tokens: 1e6,
               cache_read_input_tokens: 0,
               cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 0 } } },
      timestamp: '2026-01-01T00:00:03Z' },
  ]));
  const savedHome = process.env.CHEAPER_PEEK_HOME;
  const savedLedger = process.env.CHEAPER_LEDGER_FILE;
  const savedEvents = process.env.CHEAPER_EVENTS_DIR;
  const savedPort = process.env.CHEAPER_PORT;
  process.env.CHEAPER_PEEK_HOME = dir;
  process.env.CHEAPER_LEDGER_FILE = path.join(dir, 'lifetime.json');
  // Read at call time, so the audit append lands in the fixture no matter what the module
  // cache resolved HOME to when events.js was first loaded by another test.
  process.env.CHEAPER_EVENTS_DIR = path.join(dir, 'events');
  process.env.CHEAPER_PORT = '59422';           // nothing listening → forces the estimate path
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(String(s));
  try {
    for (const m of ['fsutil', 'adapters', 'scan', 'ledger', 'tagline']) {
      delete require.cache[require.resolve('../src/peek/' + m)];
    }
    const tag = require('../src/peek/tagline');
    const opts = { transcript: path.join(proj, 'sesW.jsonl') };
    await tag.run({ ...opts, json: true });
    var j = JSON.parse(logs[logs.length - 1]);
    await tag.run({ ...opts, format: 'markdown' });
    var rendered = logs[logs.length - 1];
  } finally {
    console.log = orig;
    if (savedHome === undefined) delete process.env.CHEAPER_PEEK_HOME; else process.env.CHEAPER_PEEK_HOME = savedHome;
    if (savedLedger === undefined) delete process.env.CHEAPER_LEDGER_FILE; else process.env.CHEAPER_LEDGER_FILE = savedLedger;
    if (savedEvents === undefined) delete process.env.CHEAPER_EVENTS_DIR; else process.env.CHEAPER_EVENTS_DIR = savedEvents;
    if (savedPort === undefined) delete process.env.CHEAPER_PORT; else process.env.CHEAPER_PORT = savedPort;
    fs.rmSync(dir, { recursive: true, force: true });
    for (const m of ['fsutil', 'adapters', 'scan', 'ledger', 'tagline']) {
      delete require.cache[require.resolve('../src/peek/' + m)];
    }
  }
  // The cold sub-agent is withheld, so the ledger takes $84.00 — NOT the $171.50 the
  // one-breakdown-into-both-legs pricing used to hand it.
  assert.ok(Math.abs(j.lifetime.usd - 84) < 1e-6,
    'expected $84.00 in the ledger; $171.50 is the un-withheld figure. usd=' + j.lifetime.usd);
  // Tokens travel with the dollars — the withheld call's 2M must not be credited either.
  assert.equal(j.lifetime.tokens, 2e6);
  assert.equal(j.lifetime.chats, 1);
  assert.ok(Math.abs(j.result.dollarsSaved - 84) < 1e-6, 'dollarsSaved=' + j.result.dollarsSaved);
  assert.equal(j.result.population.withheld, 1);
  // ...and the printed line says what it withheld, in the same sentence as the coverage.
  assert.match(rendered, / Lifetime savings: 🟢 about \$84\.00 and 2\.0M tokens\./, rendered);
  assert.match(rendered, / Coverage: 1 switched call claims no saving — a cold prompt cache leaves the un-switched baseline indeterminate\./, rendered);
});

// ---- peek scan: unpriceable calls are COUNTED, and history prices at its own date ----

test('estimateCall returns a SIGNED delta — a costlier "downgrade" is not clamped to zero', () => {
  const { estimateCall: ec } = require('../src/peek/pricing');
  // A tier's route target is not cheaper than every model of the tier above it on every
  // token mix. The sonnet target gemini-3.5-flash bills input at $1.50/Mtok; the
  // opus-tier gemini-2.5-pro bills it at $1.25. On an input-heavy call the "downgrade"
  // costs MORE: 100k in + 10k out is $0.225 on the pro and $0.240 on the flash.
  // `Math.max(0, ...)` reported that as a flat $0.00 — a suppression performed in the
  // arithmetic, which erases the loss from every total that follows.
  const e = ec('gemini-2.5-pro', 1e5, 1e4, 'sonnet');
  assert.equal(e.priceable, true);
  assert.equal(e.downgraded, true);
  assert.equal(e.effTier, 'sonnet');
  assert.ok(Math.abs(e.actualCost - 0.225) < 1e-9, 'actualCost=' + e.actualCost);
  assert.ok(Math.abs(e.newCost - 0.24) < 1e-9, 'newCost=' + e.newCost);
  assert.ok(e.saved < 0, 'the delta must keep its sign, got ' + e.saved);
  assert.ok(Math.abs(e.saved + 0.015) < 1e-9, 'saved=' + e.saved);
  // ...and it is separated the way derive.js::foldRows separates it, so a net that has
  // been reduced by an offset can still be explained.
  assert.equal(e.gross, 0);
  assert.ok(Math.abs(e.extra - 0.015) < 1e-9, 'extra=' + e.extra);
  // A genuine saving still reports positively, with extra at zero.
  const good = ec('claude-opus-4', 1e6, 1e6, 'haiku');
  assert.ok(Math.abs(good.saved - 84) < 1e-9);
  assert.ok(Math.abs(good.gross - 84) < 1e-9);
  assert.equal(good.extra, 0);
});

test('estimateCall prices HISTORY at the call\'s own day and the counterfactual at TODAY', () => {
  const { estimateCall: ec, costOfModel } = require('../src/peek/pricing');
  const toks = { inFresh: 1e6, outTok: 1e6 };
  // Sonnet 5 launch pricing is $2/$10 through 2026-08-31, $3/$15 after. The SAME call
  // must cost what it cost on the day it ran — the figure `peek` prints as "Spent on
  // record" is a historical fact and may not move when a promo window shuts.
  // (contentTier 'opus' caps to the model's own tier, so no downgrade muddies this.)
  const inWin = ec('claude-sonnet-5', 1e6, 1e6, 'opus', { at: '2026-08-10' });
  const after = ec('claude-sonnet-5', 1e6, 1e6, 'opus', { at: '2026-09-10' });
  assert.ok(Math.abs(inWin.actualCost - 12) < 1e-9, 'in-window actualCost=' + inWin.actualCost);
  assert.ok(Math.abs(after.actualCost - 18) < 1e-9, 'after-window actualCost=' + after.actualCost);
  assert.notEqual(inWin.actualCost, after.actualCost,
    'both legs resolving at todayUTC() is exactly the defect');
  // The PROSPECTIVE leg is a different question and legitimately prices at today
  // (models.js:242-258), so it does NOT move with the row's date.
  const todayCost = costOfModel('claude-sonnet-5', toks);
  assert.equal(inWin.baselineCost, todayCost);
  assert.equal(after.baselineCost, todayCost);
  // No date supplied → the two collapse, exactly as before this split existed.
  const undated = ec('claude-sonnet-5', 1e6, 1e6, 'opus');
  assert.equal(undated.actualCost, undated.baselineCost);
});

test('peek scan: unpriceable calls are counted, and dated rows price at their own day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-unpriced-'));
  const proj = path.join(dir, '.claude', 'projects', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  const turn = (id, model, ts, inTok, outTok) => ({
    type: 'assistant', isSidechain: false,
    message: { id, role: 'assistant', model, content: [{ type: 'text', text: 'ok' }],
               usage: { input_tokens: inTok, output_tokens: outTok } },
    timestamp: ts,
  });
  fs.writeFileSync(path.join(proj, 'sesU.jsonl'), [
    // Same model, same tokens, two different days — one inside Sonnet 5's promotional
    // window ($2/$10 → $12) and one after it ($3/$15 → $18). Priced at their own days
    // the pair is $30. Priced at TODAY (the old behaviour) it is 2×$12=$24 or 2×$18=$36,
    // depending on the day the suite happens to run — never $30.
    turn('u1', 'claude-sonnet-5', '2026-08-10T12:00:00Z', 1e6, 1e6),
    turn('u2', 'claude-sonnet-5', '2026-09-10T12:00:00Z', 1e6, 1e6),
    // Open-weight: a real vendor, no single published list price, so it is UNPRICEABLE.
    // It contributes 0.0 to every dollar figure — which is only honest while the
    // exclusion is counted, else 200 uncatalogued calls and 2 catalogued ones render as
    // one small, confident, complete-looking number.
    turn('u3', 'llama-4-maverick', '2026-08-10T12:00:00Z', 5e5, 5e5),
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  const saved = process.env.CHEAPER_PEEK_HOME;
  process.env.CHEAPER_PEEK_HOME = dir;
  try {
    for (const m of ['fsutil', 'adapters', 'scan']) delete require.cache[require.resolve('../src/peek/' + m)];
    const { scan } = require('../src/peek/scan');
    const rep = scan({ only: 'claude-code' });
    const h = rep.harnesses.find((x) => x.key === 'claude-code');
    assert.equal(h.calls, 3);
    // The exclusion is visible, in calls AND in tokens.
    assert.equal(h.unpriced, 1, 'the open-weight call must be counted as unpriced');
    assert.equal(h.unpricedTokens, 1e6);
    assert.equal(rep.totals.unpriced, 1);
    assert.equal(rep.totals.unpricedTokens, 1e6);
    assert.ok(Math.abs(rep.totals.unpricedRatio - 0.2) < 1e-9, 'ratio=' + rep.totals.unpricedRatio);
    // ...and the historical spend is priced per row at that row's own calendar day.
    assert.ok(Math.abs(h.dollarsActual - 30) < 1e-6, 'dollarsActual=' + h.dollarsActual);
  } finally {
    if (saved === undefined) delete process.env.CHEAPER_PEEK_HOME;
    else process.env.CHEAPER_PEEK_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    for (const m of ['fsutil', 'adapters', 'scan']) delete require.cache[require.resolve('../src/peek/' + m)];
  }
});

test('peek scan: an anti-saving survives into the totals instead of being clamped away', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-anti-'));
  const proj = path.join(dir, '.claude', 'projects', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  // A "refactor the pagination endpoint" prompt classifies sonnet, so the opus-tier
  // gemini-2.5-pro turn below it is judged downgradable to the sonnet route target —
  // which, on this input-heavy mix, is the MORE expensive model.
  fs.writeFileSync(path.join(proj, 'sesN.jsonl'), [
    { type: 'user', message: { role: 'user', content: 'please refactor the pagination endpoint' },
      timestamp: '2026-08-10T12:00:00Z' },
    { type: 'assistant', isSidechain: false,
      message: { id: 'n1', role: 'assistant', model: 'gemini-2.5-pro',
                 content: [{ type: 'text', text: 'ok' }],
                 usage: { input_tokens: 1e5, output_tokens: 1e4 } },
      timestamp: '2026-08-10T12:00:01Z' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const saved = process.env.CHEAPER_PEEK_HOME;
  process.env.CHEAPER_PEEK_HOME = dir;
  try {
    for (const m of ['fsutil', 'adapters', 'scan']) delete require.cache[require.resolve('../src/peek/' + m)];
    const { scan } = require('../src/peek/scan');
    const rep = scan({ only: 'claude-code' });
    const h = rep.harnesses.find((x) => x.key === 'claude-code');
    assert.equal(h.downgradable, 1);
    // The clamp reported this as a flat 0 and the loss left the report entirely.
    assert.ok(h.dollarsSaved < 0, 'net must stay negative, got ' + h.dollarsSaved);
    assert.ok(Math.abs(h.dollarsSaved + 0.015) < 1e-9, 'dollarsSaved=' + h.dollarsSaved);
    assert.equal(h.dollarsGross, 0);
    assert.ok(Math.abs(h.dollarsExtra - 0.015) < 1e-9, 'dollarsExtra=' + h.dollarsExtra);
    assert.equal(h.offsetCalls, 1);
    assert.ok(rep.totals.dollarsSaved < 0, 'totals=' + rep.totals.dollarsSaved);
    assert.ok(rep.totals.savedPct < 0, 'savedPct must carry the sign: ' + rep.totals.savedPct);
  } finally {
    if (saved === undefined) delete process.env.CHEAPER_PEEK_HOME;
    else process.env.CHEAPER_PEEK_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    for (const m of ['fsutil', 'adapters', 'scan']) delete require.cache[require.resolve('../src/peek/' + m)];
  }
});

// ---- peek RENDER: the honesty fields have to reach the surface people read -----------
//
// scan.js counts `unpriced` / `unpricedTokens` / `unpricedRatio` and decomposes the net
// into `dollarsGross` / `dollarsExtra` / `offsetCalls`, and every one of them stopped at
// `peek --json`. The terminal output — the surface almost everyone actually reads —
// printed a small, confident, fully-covered number over whatever happened to be in the
// catalog. These tests drive the REAL renderer, never a re-implementation of it.

// ANSI is presentation; the CLAIM is the text underneath, so assertions read the text.
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
// The line a label introduces, from the rendered block.
const lineWith = (out, label) =>
  plain(out).split('\n').find((l) => l.includes(label)) || '';

// A scan report in exactly the shape scan.js::scan emits. Totals are SUMMED from the
// harnesses rather than passed in, so a fixture cannot state a total its own rows
// contradict — the very defect class these tests cover.
function peekReport(harnesses, opts) {
  const base = {
    key: 'h', label: 'claude-code', status: 'supported', installed: true,
    filesScanned: 1, note: '', calls: 0, downgradable: 0, estimatedCalls: 0,
    unpriced: 0, unpricedTokens: 0, tokens: 0, tokensOnDowngradable: 0,
    dollarsActual: 0, dollarsBaseline: 0, dollarsSaved: 0,
    dollarsGross: 0, dollarsExtra: 0, offsetCalls: 0,
    bySource: { user: 0, subagent: 0 }, examples: [],
  };
  const hs = harnesses.map((h) => Object.assign({}, base, h));
  const T = { bySource: { user: 0, subagent: 0 } };
  for (const k of ['calls', 'downgradable', 'estimatedCalls', 'unpriced', 'unpricedTokens',
                   'tokens', 'tokensOnDowngradable', 'dollarsActual', 'dollarsBaseline',
                   'dollarsSaved', 'dollarsGross', 'dollarsExtra', 'offsetCalls']) {
    T[k] = hs.reduce((a, h) => a + (Number(h[k]) || 0), 0);
  }
  for (const h of hs) {
    T.bySource.user += h.bySource.user; T.bySource.subagent += h.bySource.subagent;
  }
  T.savedPct = T.dollarsBaseline > 0 ? (T.dollarsSaved / T.dollarsBaseline) * 100 : 0;
  T.unpricedRatio = T.tokens > 0 ? T.unpricedTokens / T.tokens : 0;
  T.annualizedSaved = null;
  return { generatedAt: Date.now(), opts: Object.assign({ sinceDays: 0 }, opts || {}),
           harnesses: hs, totals: T };
}

test('peek render: excluded rows are COUNTED and VISIBLE, per harness and on totals', () => {
  const { render: rdr } = require('../src/peek/render');
  // 200 uncatalogued calls and 2 catalogued ones. The dollar figures describe 2 rows;
  // without the coverage line they describe 202 to anyone reading the screen.
  const out = plain(rdr(peekReport([{
    calls: 202, downgradable: 1, tokens: 4.1e6, tokensOnDowngradable: 1e5,
    unpriced: 200, unpricedTokens: 4e6,
    dollarsActual: 0.5, dollarsBaseline: 0.6, dollarsSaved: 0.2, dollarsGross: 0.2,
    bySource: { user: 202, subagent: 0 },
  }])));
  // Per-harness: the exclusion travels on the row whose money it qualifies.
  assert.match(out, /200\/202 not priced/, out);
  assert.match(out, /4\.0M tok/, out);
  // Totals: calls, tokens and the ratio, all three.
  const nl = lineWith(out, 'Not priced');
  assert.match(nl, /200 of 202 calls/, nl);
  assert.match(nl, /4\.0M of 4\.1M tokens/, nl);
  assert.match(nl, /98% of tokens/, nl);
  assert.match(nl, /excluded from every dollar above/, nl);
  // One genuine opportunity in 202 calls must not render as "0%" beside the count.
  assert.match(out, /1 \(<1%\)/, out);

  // A fully-priced scan says so affirmatively — silence cannot distinguish "all covered"
  // from "this build does not report coverage".
  const clean = plain(rdr(peekReport([{
    calls: 10, downgradable: 4, tokens: 5e6, tokensOnDowngradable: 2e6,
    dollarsActual: 30, dollarsBaseline: 36, dollarsSaved: 24, dollarsGross: 24,
    bySource: { user: 10, subagent: 0 },
  }])));
  assert.match(clean, /Coverage +all 10 calls priced\./, clean);
  assert.ok(!/Not priced/.test(clean), clean);
});

test('peek render: a scan that priced NOTHING withholds its dollars — never $0.00', () => {
  const { render: rdr } = require('../src/peek/render');
  // Every dollar accumulator still holds its initial 0. That 0 is the initial value, not
  // a measurement, and printing it as $0.00 is how "we could not price this" becomes
  // "this cost nothing" (invariant 4, invariant 7).
  const out = plain(rdr(peekReport([{
    calls: 200, downgradable: 0, tokens: 4e6, unpriced: 200, unpricedTokens: 4e6,
    bySource: { user: 200, subagent: 0 },
  }])));
  assert.ok(!/\$0\.00/.test(out), 'a vacuous zero must never be printed as money: ' + out);
  for (const label of ['Spent on record', 'At today’s rates', 'Could have saved',
                       'You’d still pay']) {
    assert.match(lineWith(out, label), /withheld/, label + ': ' + lineWith(out, label));
  }
  // WITHHELD is decided BEFORE ABSENT: the bare em dash would claim there is nothing
  // here, about rows the same screen counts.
  assert.match(out, /200\/200 not priced/, out);
  assert.match(out, /Dollars withheld/, out);

  // A harness that was never readable is NOT COVERED — a different claim again, and it
  // must not be dressed up as a withheld figure.
  const none = plain(rdr(peekReport([{ label: 'codex', status: 'sqlite', calls: 0 }])));
  assert.match(none, /not covered — /, none);
  // And with no calls anywhere, every money line is a labelled non-number, not a zero.
  assert.ok(!/\$0\.00/.test(none), none);
  assert.match(lineWith(none, 'Could have saved'), /—/, none);
});

test('peek render: "you’d still pay" stays in ONE frame and is never clamped', () => {
  const { render: rdr } = require('../src/peek/render');
  // dollarsActual is HISTORICAL (each row at its own pday); dollarsSaved is TODAY-frame
  // (both of estimateCall's legs price at today). `dollarsActual - dollarsSaved` mixes
  // them. Here a session recorded inside Sonnet 5's $2/$10 promo window ($12) is read
  // after it closed ($18 at today's rates), and routing saves $6 of the today figure:
  //   correct  = dollarsBaseline - dollarsSaved = 18 - 6 = $12.00
  //   the bug  = dollarsActual   - dollarsSaved = 12 - 6 = $6.00
  const out = plain(rdr(peekReport([{
    calls: 2, downgradable: 1, tokens: 4e6, tokensOnDowngradable: 2e6,
    dollarsActual: 12, dollarsBaseline: 18, dollarsSaved: 6, dollarsGross: 6,
    bySource: { user: 2, subagent: 0 },
  }])));
  const pay = lineWith(out, 'You’d still pay');
  assert.match(pay, /\$12\.00/, 'today-frame partner expected: ' + pay);
  assert.ok(!/\$6\.00/.test(pay), 'the cross-frame subtraction must be gone: ' + pay);
  // Both frames are still reported, each labelled, so the reader can see they differ.
  assert.match(lineWith(out, 'Spent on record'), /\$12\.00/);
  assert.match(lineWith(out, 'At today’s rates'), /\$18\.00/);
  // The per-harness row carries the same corrected figure.
  assert.match(out, /\$6\.00 \/ \$12\.00/, out);

  // THE CLAMP. When the historical leg is small and the today-frame saving is large,
  // `Math.max(0, actual - saved)` went negative and was flattened to a confident $0.00 —
  // "this work will cost you nothing" — for work that will really cost $5.00.
  const c2 = plain(rdr(peekReport([{
    calls: 2, downgradable: 1, tokens: 2e6, tokensOnDowngradable: 1e6,
    dollarsActual: 1, dollarsBaseline: 10, dollarsSaved: 5, dollarsGross: 5,
    bySource: { user: 2, subagent: 0 },
  }])));
  const pay2 = lineWith(c2, 'You’d still pay');
  assert.match(pay2, /\$5\.00/, 'the clamped figure was really $5.00: ' + pay2);
  assert.ok(!/\$0\.00/.test(pay2), 'max(0, …) must not conceal it: ' + pay2);
});

test('peek render: an anti-saving is named, decomposed, and never printed as a saving', () => {
  const { render: rdr } = require('../src/peek/render');
  // The gemini-2.5-pro shape from the scan test above: one downgradable row whose route
  // target is the MORE expensive model on this token mix.
  const out = plain(rdr(peekReport([{
    calls: 1, downgradable: 1, tokens: 1.1e5, tokensOnDowngradable: 1.1e5,
    dollarsActual: 0.225, dollarsBaseline: 0.225, dollarsSaved: -0.015,
    dollarsGross: 0, dollarsExtra: 0.015, offsetCalls: 1,
    bySource: { user: 1, subagent: 0 },
    examples: [{ from: 'opus', to: 'sonnet', saved: -0.015, source: 'user', text: 'refactor' }],
  }])));
  // A negative net is not a saving and is not labelled as one.
  assert.ok(!/Could have saved/.test(out), 'a loss must not be headed "saved": ' + out);
  assert.match(lineWith(out, 'Would cost MORE'), /-\$0\.02/, out);
  // The sign leads the amount; "$-0.02" buries the minus inside the figure.
  assert.ok(!/\$-/.test(out), 'sign must precede the $: ' + out);
  // The decomposition is what lets a reduced net be explained rather than guessed at.
  const off = lineWith(out, 'Offsets');
  assert.match(off, /1 call\(s\) routed to a COSTLIER model/, off);
  assert.match(off, /gross \$0\.00 less extra \$0\.02/, off);
  // ...and the example row keeps its sign too.
  assert.match(out, /-\$0\.02 +opus→sonnet/, out);
});

// ---- the reader's own refusals must reach `savings` and `logs` -----------------------

// A synthetic event store whose segments the reader CANNOT account for.
//   - a directory named like a live segment  -> readFileSync throws EISDIR -> `unreadable`
//   - a .jsonl.gz holding non-gzip bytes     -> gunzipSync throws          -> `corrupt`
// Both are deterministic and need no permission games (a suite running as root can read
// a chmod-000 file, which would make that variant silently pass).
function brokenEventStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-holes-'));
  fs.mkdirSync(path.join(dir, '2026-07.cli.jsonl'), { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-06.cli.jsonl.gz'), 'this is not gzip');
  return dir;
}

test('cheaper savings: an unaccounted segment is published AND printed, not absorbed', () => {
  const dir = brokenEventStore();
  const prev = { d: process.env.CHEAPER_EVENTS_DIR, l: process.env.CHEAPER_LEGACY_FILE };
  process.env.CHEAPER_EVENTS_DIR = dir;
  process.env.CHEAPER_LEGACY_FILE = path.join(dir, 'no-such-legacy.json');
  const out = [];
  const orig = console.log;
  console.log = (s) => out.push(plain(String(s)));
  try {
    const savings = require('../src/savings');
    const b = savings.compute();
    // `readAll` increments `segments` BEFORE attempting the read, so without these two
    // counters "2 segments, 0 events" is indistinguishable from two quiet months.
    assert.equal(b.store.segments, 2, JSON.stringify(b.store));
    assert.equal(b.store.rows, 0);
    assert.equal(b.store.unreadable, 1, 'unreadable must be published: ' + JSON.stringify(b.store));
    assert.equal(b.store.corrupt, 1, 'corrupt must be published: ' + JSON.stringify(b.store));
    savings.run([]);
  } finally {
    console.log = orig;
    for (const [k, v] of [['CHEAPER_EVENTS_DIR', prev.d], ['CHEAPER_LEGACY_FILE', prev.l]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const txt = out.join('\n');
  assert.match(txt, /1 segment\(s\) could NOT BE READ/, txt);
  assert.match(txt, /1 sealed segment\(s\) are CORRUPT/, txt);
  // "No per-call events recorded yet" is an affirmative claim about the user's history,
  // and an unaccounted segment is precisely the evidence that would refute it.
  assert.ok(!/No per-call events recorded yet/.test(txt),
    'a broken store must not read as an empty one: ' + txt);
  assert.match(txt, /No readable per-call events across 2 segment\(s\)/, txt);
});

test('cheaper logs: an unaccounted segment is printed, and caps the "showing N of M"', () => {
  const dir = brokenEventStore();
  const prev = { d: process.env.CHEAPER_EVENTS_DIR, l: process.env.CHEAPER_LEGACY_FILE };
  process.env.CHEAPER_EVENTS_DIR = dir;
  process.env.CHEAPER_LEGACY_FILE = path.join(dir, 'no-such-legacy.json');
  const out = [];
  const orig = console.log;
  console.log = (s) => out.push(plain(String(s)));
  try {
    const logsMod = require('../src/logs');
    const data = logsMod.localRows({ limit: 50 });
    // The whole readStats travels — the register's job is to account for every row, so
    // the reader's own refusals are part of the answer.
    assert.equal(data.store.readStats.unreadable, 1, JSON.stringify(data.store.readStats));
    assert.equal(data.store.readStats.corrupt, 1, JSON.stringify(data.store.readStats));
    assert.deepEqual(logsMod.storeHoles({}), [],
      'gateway rows report nothing about a store we never read');
    logsMod.renderTable(data);
  } finally {
    console.log = orig;
    for (const [k, v] of [['CHEAPER_EVENTS_DIR', prev.d], ['CHEAPER_LEGACY_FILE', prev.l]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const txt = out.join('\n');
  assert.match(txt, /1 segment\(s\) could NOT BE READ/, txt);
  assert.match(txt, /1 sealed segment\(s\) are CORRUPT/, txt);
  assert.ok(!/^ *No events in this range\.$/m.test(txt),
    'an unaccounted segment must not render as a clean empty range: ' + txt);
  assert.match(txt, /No READABLE events in this range/, txt);
});
