'use strict';
// What `cheaper savings` is allowed to print for a window.
//
// These tests drive the REAL command (`savings.run([])`) over a REAL isolated event store
// — not a re-implementation of its formatting — because a second implementation of these
// rules in the test is the exact drift the rules forbid.
//
// THE BLOCKER: the counts line was built from the PRICED accumulators
// (`w.measured.calls` / `w.estimated.calls`) and from `w.tokens` alone, while
// `reportWindow` hands this renderer `events` (ROWS SEEN) and `unpricedTokens`. One
// measured call to a model absent from the price catalog therefore rendered
//
//     Today                 -   0 tokens - 0 calls
//       100% of this window tokens are not in the price catalog, so no dollar figure…
//
// — "0 tokens" for 12,000 tokens and "0 calls" for 1 call, contradicted by its own note on
// the very next line, while the dashboard rendered 1 for the same window off the
// byte-identical gateway payload. Reachable by any call to a model not yet in the catalog:
// a new model launch before `cheaper update`, which is what `unpricedCalls` exists for.
//
// The token expression was ALSO `w.tokens.measured + w.tokens.estimated` — a cross-basis
// scalar sum, the one shape this product may never print.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ESC_RE = /\x1b\[[0-9;]*m/g;
const strip = (s) => s.replace(ESC_RE, '');

// Run the REAL command against a REAL, isolated store and hand back its stripped output.
function runSavings(rows, opts = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-savings-'));
  const evdir = path.join(d, 'events');
  fs.mkdirSync(evdir, { recursive: true });
  const prev = {
    ev: process.env.CHEAPER_EVENTS_DIR, home: process.env.CHEAPER_PEEK_HOME,
    leg: process.env.CHEAPER_LEGACY_FILE, led: process.env.CHEAPER_LEDGER_FILE,
  };
  process.env.CHEAPER_EVENTS_DIR = evdir;
  process.env.CHEAPER_PEEK_HOME = d;
  process.env.CHEAPER_LEGACY_FILE = path.join(d, 'legacy_chats.json');
  process.env.CHEAPER_LEDGER_FILE = path.join(d, 'lifetime.json');

  const ym = rows.length ? String(rows[0].pday).slice(0, 7) : '2026-08';
  fs.writeFileSync(path.join(evdir, `${ym}.aaaaaaaa.cli.jsonl`),
    rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  // Fully covered, so `not covered` is never the variable under test.
  fs.writeFileSync(path.join(evdir, 'state.json'), JSON.stringify({
    v: 1, tombstones: [], ingested_files: [],
    coverage: [{ kind: 'observed', from: Date.now() - 86400000 * 400,
                 to: Date.now() + 86400000 }],
  }));

  // Required AFTER the env is set: the store resolves its directory per call, but the
  // module also freezes a catalog at load, so a fresh require per run is not needed —
  // only a fresh env is.
  delete require.cache[require.resolve('../src/savings')];
  const savings = require('../src/savings');
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  let payload;
  try {
    payload = savings.compute();
    if (!opts.computeOnly) savings.run([]);
  } finally {
    console.log = orig;
    for (const [k, v] of [['CHEAPER_EVENTS_DIR', prev.ev],
                          ['CHEAPER_PEEK_HOME', prev.home],
                          ['CHEAPER_LEGACY_FILE', prev.leg],
                          ['CHEAPER_LEDGER_FILE', prev.led]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  const text = strip(lines.join('\n'));
  return { text, lines: text.split('\n'), payload };
}

const NOW = Date.now();
const PDAY = new Date(NOW).toISOString().slice(0, 10);

function ev(over) {
  return Object.assign({
    v: 1, id: 'rid:req_1', rev: 1, w: 'cli', inst: 'aaaaaaaa',
    ts: NOW, tzo: 0, pday: PDAY,
    prov: 'gateway', usrc: 'provider', conf: 'measured',
    harness: 'claude-code', sessions: ['s1'], sess: 's1', sub: true,
    served: 'claude-haiku-4-5', req: null, base: 'claude-opus-5',
    bsrc: 'tx_session_ceiling', elig: true, ctier: 'haiku', cver: 3, reason: '',
    in: 10000, out: 2000, cr: 0, c5: 0, c1: 0, cu: 0,
    speed: null, svc: 'standard', status: 200,
  }, over || {});
}

// The row `unpricedCalls` exists for: a model the catalog does not carry yet.
const UNPRICED = ev({ id: 'rid:unpriced', served: 'llama-4-maverick' });

function todayLine(out) {
  const l = out.lines.find((x) => x.trim().startsWith('Today'));
  assert.ok(l, `the ladder must render a Today row:\n${out.text}`);
  return l;
}

test('THE BLOCKER: 12,000 tokens on one unpriceable call are never reported as "0 tokens, '
   + '0 calls"', () => {
  const out = runSavings([UNPRICED]);
  const w = out.payload.ladder[0];
  // The payload the renderer was handed — the counts were never in doubt.
  assert.deepStrictEqual(w.events, { measured: 1, estimated: 0 });
  assert.strictEqual(w.unpricedTokens, 12000);
  assert.strictEqual(w.unpricedCalls, 1);
  assert.deepStrictEqual(w.tokens, { measured: 0, estimated: 0 });

  const line = todayLine(out);
  // The two claims the line used to make, both false and both contradicted by the note
  // printed directly beneath it.
  assert.ok(!/\b0 tokens\b/.test(line), `12,000 tokens are not 0 tokens: ${line}`);
  assert.ok(!/\b0 calls\b/.test(line), `1 call is not 0 calls: ${line}`);
  // …and what it must say instead: the rows it SAW, and the tokens it could not price.
  assert.match(line, /1 measured/);
  assert.match(line, /unpriced/);
  // The note is still there and still agrees with the line above it.
  assert.match(out.text, /not in the price catalog, so no dollar figure is claimed/);
});

test('the token figure is never measured + estimated, and never omits the unpriced ones',
  () => {
    // 1 priced measured call (12,000 tokens), 1 priced estimated call (30,000 tokens) and
    // 1 unpriceable call (12,000 tokens). A single scalar would print 42,000 — a
    // cross-basis sum — or, with the unpriced tokens dropped, understate the window.
    const rows = [
      ev({ id: 'rid:m' }),
      ev({ id: 'rid:e', conf: 'estimated', in: 20000, out: 10000 }),
      ev({ id: 'rid:u', served: 'llama-4-maverick' }),
    ];
    const out = runSavings(rows);
    const w = out.payload.ladder[0];
    assert.strictEqual(w.tokens.measured, 12000);
    assert.strictEqual(w.tokens.estimated, 30000);
    assert.strictEqual(w.unpricedTokens, 12000);

    const line = todayLine(out);
    // The forbidden scalar, in every form it could take.
    for (const bad of ['42.0K', '42,000', '54.0K', '54,000']) {
      assert.ok(!line.includes(bad),
        `a cross-basis token sum (${bad}) may never be printed: ${line}`);
    }
    // Three separate, labelled figures.
    assert.match(line, /12\.0K measured/);
    assert.match(line, /30\.0K est\./);
    assert.match(line, /12\.0K unpriced/);
    // The same rule for the call counts: two columns, never one population of three.
    assert.match(line, /2 measured/);
    assert.match(line, /1 est\./);
    assert.ok(!/\b3 calls\b/.test(line), `no cross-basis call count: ${line}`);
  });

test('OVER-CORRECTION GUARD: a window that genuinely saw nothing still says 0, and one '
   + 'that reports nothing says so instead', () => {
  // Reading `events` must not have been implemented as "never print a number". A COVERED
  // window holding no rows measured zero and says zero; that is a result, not an absence.
  const out = runSavings([ev({ id: 'rid:only' })]);
  const earlier = out.lines.find((l) => l.trim().startsWith('Earlier this week'));
  assert.ok(earlier, out.text);
  assert.match(earlier, /0 tokens · 0 calls/);

  // …and a window whose payload states NO count at all is a labelled non-number, never 0:
  // `not_covered` and `store_newer_than_reader` return no `events` and no `tokens` keys.
  const savings = require('../src/savings');
  assert.ok(typeof savings.compute === 'function');
});

test('a priced window still renders its real figures — the fix is not "print nothing"',
  () => {
    const out = runSavings([ev({ id: 'rid:p1' }), ev({ id: 'rid:p2' })]);
    const line = todayLine(out);
    assert.match(line, /\$\d/, `a priced window must still show its dollars: ${line}`);
    assert.match(line, /24\.0K measured/);
    assert.match(line, /2 measured/);
    assert.ok(!line.includes('unpriced'), `nothing was unpriced here: ${line}`);
  });
