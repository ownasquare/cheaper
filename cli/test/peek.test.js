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
