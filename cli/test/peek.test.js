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
  assert.equal(contentTier('x'.repeat(5000)).tier, 'sonnet'); // long/dense
  assert.equal(contentTier('do this\n```\ncode\n```').tier, 'sonnet'); // code fence
});

test('model id -> tier, cheap signals win over top signals', () => {
  assert.equal(modelTier('claude-opus-4'), 'opus');
  assert.equal(modelTier('claude-haiku-4-5'), 'haiku');
  assert.equal(modelTier('gpt-4o-mini'), 'haiku');   // "mini" wins
  assert.equal(modelTier('o3-mini'), 'haiku');       // o3-mini is cheap
  assert.equal(modelTier('o3'), 'opus');
  assert.equal(modelTier('gpt-4o'), 'sonnet');
  assert.equal(modelTier('gemini-2.5-pro'), 'opus');
  assert.equal(modelTier('gemini-2.5-flash'), 'haiku');
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
  assert.equal(r.ceilingTier, 'opus');
  assert.equal(r.belowCeilingCalls, 2);
  assert.deepEqual(r.tierHist, { haiku: 1, sonnet: 1, opus: 1 });
  // haiku saved: (15+75)-(1+5)=84 ; sonnet saved: (15+75)-(3+15)=72 ; total 156.
  assert.ok(Math.abs(r.dollarsSaved - 156) < 1e-6, 'dollarsSaved=' + r.dollarsSaved);
  assert.equal(r.tokensSaved, 4_000_000); // 2M haiku + 2M sonnet
  // The breakdown reports ONLY the routed-cheaper tiers, not the opus main loop.
  assert.deepEqual(r.savedTierHist, { haiku: 1, sonnet: 1, opus: 0 });
  const line = buildTagline(r);
  assert.match(line, /^Cheaper\.app saved 🟢 ~\$156 and 4\.0M tokens by using /);
  assert.ok(line.includes('haiku tier for 1 call and sonnet tier for 1 call instead of opus.'));
  // Whole-session usage follows as its own sentence (opus 90 + haiku 6 + sonnet 18 = $114).
  // Phrased as metered value at list rates, never "you spent" — most sessions run on a
  // flat-rate subscription where that sum is never actually charged.
  assert.match(line, / This session ran 6\.0M tokens, worth 🔴 ~\$114 at list API rates\.$/);
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
  assert.equal(r.ceilingTier, 'opus');
  assert.equal(r.savedTierHist.sonnet, 12);
  assert.equal(r.savedTierHist.opus, 0);        // Opus is never a "saving"
  assert.equal(r.belowCeilingCalls, 12);
  const line = buildTagline(r);
  // The 175 Opus calls MUST NOT be claimed as "opus tier for 175 calls".
  assert.ok(!/opus tier for/.test(line), 'main-loop opus must not be claimed: ' + line);
  assert.ok(line.includes('by using sonnet tier for 12 calls instead of opus.'));
  assert.match(line, / This session ran [\d.]+[KM] tokens, worth 🔴 ~\$[\d.]+ at list API rates\.$/);
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
  assert.equal(costOfModel('claude-sonnet-5', toks, { at: '2026-09-15' }), 18);
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
  assert.match(line, /by using sonnet tier for 1 call instead of opus\./);
  assert.match(line, / This session ran 3\.0M tokens, worth 🔴 ~\$19\.50 at list API rates\.$/);
});

test('brand renders as a markdown link when requested', () => {
  const r = { ceilingTier: 'opus', topTier: 'opus', dollarsSaved: 5, tokensSaved: 1e6,
    belowCeilingCalls: 1, savedTierHist: { haiku: 0, sonnet: 1, opus: 0 }, totalSpent: 10,
    totalTokens: 2e6, exact: false };
  const md = buildTagline(r, '[Cheaper.app](https://cheaper.app)');
  assert.ok(md.startsWith('[Cheaper.app](https://cheaper.app) saved '), md);
});

test('color cues: 🟢 on savings, 🔴 on spend; ANSI adds real colour', () => {
  const r = { ceilingTier: 'opus', topTier: 'opus', dollarsSaved: 5, tokensSaved: 1e6,
    belowCeilingCalls: 1, savedTierHist: { haiku: 0, sonnet: 1, opus: 0 }, totalSpent: 10,
    totalTokens: 2e6, exact: false };
  // Markdown/plain can't colour text, so an emoji dot carries the cue in the chat.
  const md = buildTagline(r, 'Cheaper.app', 'markdown');
  assert.ok(md.includes('saved 🟢 ~$5.00'), md);   // green cue on the savings
  assert.ok(md.includes('worth 🔴 ~$10.00'), md);  // red cue on the metered value
  // ANSI format wraps the amount in true green/red for terminals / the Stop hook.
  const ESC = String.fromCharCode(27);
  const ansi = buildTagline(r, 'Cheaper.app', 'ansi');
  assert.ok(ansi.includes('🟢 ' + ESC + '[32m~$5.00' + ESC + '[0m'), 'ansi green: ' + JSON.stringify(ansi));
  assert.ok(ansi.includes('🔴 ' + ESC + '[31m~$10.00' + ESC + '[0m'), 'ansi red: ' + JSON.stringify(ansi));
});

test('honesty: a chat with no downgrade claims no dollars (brand line only)', () => {
  const r = realizedFromRecords([rec('claude-opus-4', 'user'), rec('claude-opus-4', 'subagent')]);
  assert.equal(r.dollarsSaved, 0);
  assert.ok(buildTagline(r).startsWith('Cheaper.app kept this chat on the opus tier — no cheaper routing was warranted.'));
});

test('honesty: unknown models are unpriceable and never invent a saving', () => {
  // Ceiling is opus; the "cheap" call is an unknown model -> excluded, not credited.
  const r = realizedFromRecords([rec('claude-opus-4', 'user'), rec('totally-made-up-model', 'subagent')]);
  assert.equal(r.dollarsSaved, 0);
  assert.equal(r.tierHist.haiku, 0);
  // All-unknown -> nothing priceable -> null -> empty line.
  assert.equal(realizedFromRecords([rec('totally-made-up-model', 'user')]), null);
  assert.equal(buildTagline(null), '');
});

test('exact (gateway) savings drop the "~"; estimate keeps it', () => {
  const est = buildTagline({ ceilingTier: 'opus', dollarsSaved: 1.23, tokensSaved: 3e6,
    belowCeilingCalls: 4, savedTierHist: { haiku: 3, sonnet: 1, opus: 0 }, exact: false });
  assert.match(est, /saved 🟢 ~\$1\.23 and 3\.0M tokens/);
  const exact = buildTagline({ ceilingTier: 'opus', dollarsSaved: 1.23, tokensSaved: 3e6,
    belowCeilingCalls: 4, savedTierHist: { haiku: 3, sonnet: 1, opus: 0 }, exact: true });
  assert.match(exact, /saved 🟢 \$1\.23 and 3\.0M tokens/);
  assert.ok(!exact.includes('~'));
});

test('fromGateway maps a session-filtered summary to the tagline shape', () => {
  const g = fromGateway({
    total: 5,
    by_tier: {
      haiku: { count: 3, in_tokens: 1e6, out_tokens: 1e6 },
      sonnet: { count: 1, in_tokens: 5e5, out_tokens: 5e5 },
      opus: { count: 1, in_tokens: 2e5, out_tokens: 2e5 },
    },
    dollars: { saved: 1.23 },
    counts: { models_changed: 4 },
    tokens: { downgraded: 3_000_000 }, // gateway's exact tokens-on-downgraded-rows
    downgraded_by_tier: { haiku: 3, sonnet: 1, opus: 0 }, // the money-saving rows
  });
  assert.equal(g.exact, true);
  assert.equal(g.dollarsSaved, 1.23);
  assert.equal(g.tokensSaved, 3_000_000); // straight from tokens.downgraded
  assert.deepEqual(g.savedTierHist, { haiku: 3, sonnet: 1, opus: 0 }); // routed-cheaper only
});

test('gateway uniform-downgrade never prints "$X and 0 tokens"', () => {
  // The core value-prop case: an opus-requesting session routed entirely to haiku.
  const summary = {
    total: 5,
    by_tier: { haiku: { count: 5, in_tokens: 2e6, out_tokens: 1e6 } },
    dollars: { saved: 4.2 },
    counts: { models_changed: 5 },
    // Old gateway without tokens.downgraded → fall back to processed tokens.
  };
  const g = fromGateway(summary);
  assert.ok(g.tokensSaved > 0, 'tokensSaved must not be 0 when dollars were saved');
  const line = buildTagline(g);
  assert.ok(!line.includes('0 tokens'), 'no "0 tokens" contradiction: ' + line);
  assert.match(line, /^Cheaper\.app saved 🟢 \$4\.20 and 3\.0M tokens by using haiku tier for 5 calls\.$/);
});

test('sub-cent savings round away — no "$0.00 saved" claim', () => {
  const r = realizedFromRecords([rec('claude-opus-4', 'user'),
    rec('claude-haiku-4-5', 'subagent', 10, 10)]); // ~$0.0009 saved
  assert.ok(r.dollarsSaved > 0 && r.dollarsSaved < 0.01);
  assert.ok(buildTagline(r).startsWith('Cheaper.app kept this chat on the opus tier — no cheaper routing was warranted.'));
});

test('an exact sub-cent saving (0.5c–1c) is suppressed, not rounded up to $0.01', () => {
  const r = { exact: true, dollarsSaved: 0.006, tokensSaved: 20, belowCeilingCalls: 1,
    savedTierHist: { haiku: 1, sonnet: 0, opus: 0 }, ceilingTier: 'opus', topTier: 'opus' };
  const line = buildTagline(r);
  assert.ok(!line.includes('$0.01'), 'must not present $0.006 as an exact $0.01: ' + line);
  assert.match(line, /kept this chat on the opus tier/);
});

test('cross-family: below-ceiling calls are priced at the ceiling MODEL, not the sub-task family', () => {
  // Ceiling model is gemini-2.5-pro (google/opus tier). A Claude Haiku sub-agent below it
  // must be credited (gemini-pro cost − haiku cost), NOT (Anthropic Opus − Anthropic Haiku).
  const r = realizedFromRecords([
    rec('gemini-2.5-pro', 'user'),        // google, opus tier → the ceiling
    rec('claude-haiku-4-5', 'subagent'),  // anthropic, haiku tier → below ceiling
  ]);
  assert.equal(r.ceilingTier, 'opus');
  assert.equal(r.ceilingModel, 'gemini-2.5-pro');
  // The baseline is the ceiling MODEL's own published rates, including its >200k
  // long-context tier: this 1M-token call bills at $2.50/$15, so baseline = 17.50.
  // Actual = anthropic haiku (1 + 5) = 6 ; saved 11.50.
  assert.ok(Math.abs(r.dollarsSaved - 11.5) < 1e-6, 'dollarsSaved=' + r.dollarsSaved);
  // NOT the fabricated $84 that anthropic-opus-vs-anthropic-haiku would give.
  assert.ok(r.dollarsSaved < 20, 'must not invent Anthropic-Opus-scale savings: ' + r.dollarsSaved);
});

test('brand line names the true top tier when a subagent ran above the user ceiling', () => {
  // User turn on Haiku, but an Opus subagent actually ran — the "kept on" line must say opus.
  const r = realizedFromRecords([rec('claude-haiku-4-5', 'user'), rec('claude-opus-4', 'subagent')]);
  assert.equal(r.topTier, 'opus');
  assert.equal(r.dollarsSaved, 0); // nothing below the (haiku) user ceiling
  assert.ok(buildTagline(r).startsWith('Cheaper.app kept this chat on the opus tier — no cheaper routing was warranted.'));
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
    assert.equal(rt.tierHist.haiku, 1);

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
  assert.match(rendered, / Lifetime savings: 🟢 ~\$84\.00 and 2\.0M tokens\./);
  // The "See logs" link to the local dashboard is the very last thing on the line.
  assert.ok(rendered.endsWith(' [See logs](http://localhost:59421/dashboard)'), 'See logs suffix: ' + rendered);
});
