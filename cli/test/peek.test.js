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
  assert.match(line, /^Cheaper\.app saved ~\$156 and 4\.0M tokens by using /);
  assert.match(line, /haiku tier for 1 call and sonnet tier for 1 call instead of opus\.$/);
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
  assert.match(line, /by using sonnet tier for 12 calls instead of opus\.$/);
});

test('honesty: a chat with no downgrade claims no dollars (brand line only)', () => {
  const r = realizedFromRecords([rec('claude-opus-4', 'user'), rec('claude-opus-4', 'subagent')]);
  assert.equal(r.dollarsSaved, 0);
  assert.equal(buildTagline(r), 'Cheaper.app kept this chat on the opus tier — no cheaper routing was warranted.');
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
  assert.match(est, /saved ~\$1\.23 and 3\.0M tokens/);
  const exact = buildTagline({ ceilingTier: 'opus', dollarsSaved: 1.23, tokensSaved: 3e6,
    belowCeilingCalls: 4, savedTierHist: { haiku: 3, sonnet: 1, opus: 0 }, exact: true });
  assert.match(exact, /saved \$1\.23 and 3\.0M tokens/);
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
  assert.match(line, /^Cheaper\.app saved \$4\.20 and 3\.0M tokens by using haiku tier for 5 calls\.$/);
});

test('sub-cent savings round away — no "$0.00 saved" claim', () => {
  const r = realizedFromRecords([rec('claude-opus-4', 'user'),
    rec('claude-haiku-4-5', 'subagent', 10, 10)]); // ~$0.0009 saved
  assert.ok(r.dollarsSaved > 0 && r.dollarsSaved < 0.01);
  assert.equal(buildTagline(r), 'Cheaper.app kept this chat on the opus tier — no cheaper routing was warranted.');
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
  // baseline = google opus (1.25 + 10) = 11.25 ; actual = anthropic haiku (1 + 5) = 6 ; saved 5.25.
  assert.ok(Math.abs(r.dollarsSaved - 5.25) < 1e-6, 'dollarsSaved=' + r.dollarsSaved);
  // NOT the fabricated $84 that anthropic-opus-vs-anthropic-haiku would give.
  assert.ok(r.dollarsSaved < 10, 'must not invent Anthropic-Opus-scale savings: ' + r.dollarsSaved);
});

test('brand line names the true top tier when a subagent ran above the user ceiling', () => {
  // User turn on Haiku, but an Opus subagent actually ran — the "kept on" line must say opus.
  const r = realizedFromRecords([rec('claude-haiku-4-5', 'user'), rec('claude-opus-4', 'subagent')]);
  assert.equal(r.topTier, 'opus');
  assert.equal(r.dollarsSaved, 0); // nothing below the (haiku) user ceiling
  assert.equal(buildTagline(r), 'Cheaper.app kept this chat on the opus tier — no cheaper routing was warranted.');
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
