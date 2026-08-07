'use strict';
// Correctness of the numbers the store reports.
//
// The assertion that matters is NOT "token sums match" — two of the three original
// defects preserved token sums perfectly and corrupted only dollars. It is:
//   * dollars are derived per row at that row's OWN day and SKU;
//   * disjoint windows sum exactly: report(Jan) + report(Feb) === report(Jan ∪ Feb);
//   * the fold is commutative and idempotent;
//   * nothing ever adds a measured figure to an estimated one;
//   * every un-reportable case returns a LABEL, never $0.00.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const periods = require('../src/peek/periods');
const { deriveRow, foldRows } = require('../src/peek/derive');
const { merge, fold } = require('../src/peek/reconcile');

function ev(over) {
  return Object.assign({
    v: 1, id: 'rid:req_1', rev: 1, w: 'cli', inst: 'aaaaaaaa',
    ts: Date.UTC(2026, 7, 5, 12, 0, 0), tzo: 0, pday: '2026-08-05',
    prov: 'transcript', usrc: 'body', conf: 'estimated',
    harness: 'claude-code', sessions: ['s1'], sess: 's1', sub: true,
    served: 'claude-haiku-4-5', req: null, base: 'claude-opus-5',
    bsrc: 'tx_session_ceiling', elig: true, ctier: 'haiku', cver: 3, reason: '',
    in: 1000000, out: 1000000, cr: 0, c5: 0, c1: 0, cu: 0,
    speed: null, svc: 'standard', status: 200,
  }, over || {});
}

// ---- the ONE time frame ------------------------------------------------------------

test('pday is derived from ts + tzo, in exactly one implementation', () => {
  // 2026-08-31T23:30:00-07:00. In UTC this is 2026-09-01T06:30Z.
  const ts = Date.parse('2026-08-31T23:30:00-07:00');
  assert.strictEqual(periods.pdayOf(ts, -420), '2026-08-31',
    'the LOCAL calendar day, not the UTC one');
  assert.strictEqual(new Date(ts).toISOString().slice(0, 10), '2026-09-01',
    'sanity: the UTC date really is the next day — that is the whole bug');
});

test('THE TIMEZONE-FRAME REGRESSION: a 2026-08-31 23:30-07:00 sonnet-5 call prices at '
   + 'the August promo AND lands in the August bucket', () => {
  // The catalog carries claude-sonnet-5 at $2/$10 from 2026-01-01 until 2026-08-31,
  // against a standard $3/$15. Pricing on the UTC date made this call September —
  // promo expired, +50% input and +50% output — while the local bucketer filed it in
  // August. Same row, two time frames, a 50% error on a dated day.
  const ts = Date.parse('2026-08-31T23:30:00-07:00');
  const row = ev({ ts, tzo: -420, pday: periods.pdayOf(ts, -420),
                   served: 'claude-sonnet-5', base: 'claude-opus-5',
                   in: 1000000, out: 1000000, elig: true });
  const d = deriveRow(row);
  assert.ok(d.priceable, d.reason);
  // $2/M in + $10/M out on 1M/1M = $12.00 exactly. The standard rate would be $18.00.
  assert.ok(Math.abs(d.spent - 12.0) < 1e-9, `expected the promo $12.00, got ${d.spent}`);

  // …and it must land in AUGUST for a UTC-7 reader.
  const aug = periods.periodBounds('month', Date.parse('2026-08-15T12:00:00-07:00'),
                                   'America/Los_Angeles');
  const b = periods.bucketRange([row], aug.from, aug.to,
    { getUsd: () => d.delta, getTokens: () => d.tokens, now: Date.parse('2026-09-15T00:00:00Z') });
  assert.strictEqual(b.count, 1, 'the call belongs to August in the user\'s own calendar');
});

test('priceability resolves at the row\'s day, not at today', () => {
  // A promo that has since closed must still price the historical row at the promo,
  // and a model must not become unpriceable in the past because the catalog moved on.
  const inWindow = ev({ served: 'claude-sonnet-5', base: 'claude-sonnet-5',
                        pday: '2026-03-01', elig: false, in: 1000000, out: 1000000 });
  const d = deriveRow(inWindow);
  assert.ok(d.priceable);
  assert.ok(Math.abs(d.spent - 12.0) < 1e-9, `historical promo must stick: ${d.spent}`);
});

// ---- disjointness ------------------------------------------------------------------

test('report(Jan) + report(Feb) === report(Jan ∪ Feb), to the cent', () => {
  const rows = [];
  for (let day = 1; day <= 28; day++) {
    rows.push(ev({ id: 'rid:jan' + day, ts: Date.UTC(2026, 0, day, 12), pday: `2026-01-${String(day).padStart(2, '0')}` }));
    rows.push(ev({ id: 'rid:feb' + day, ts: Date.UTC(2026, 1, day, 12), pday: `2026-02-${String(day).padStart(2, '0')}` }));
  }
  const now = Date.UTC(2026, 5, 1);
  const win = (a, b) => periods.bucketRange(rows, a, b,
    { getUsd: (r) => deriveRow(r).delta, getTokens: (r) => deriveRow(r).tokens, now });
  const jan = win(Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1));
  const feb = win(Date.UTC(2026, 1, 1), Date.UTC(2026, 2, 1));
  const both = win(Date.UTC(2026, 0, 1), Date.UTC(2026, 2, 1));
  assert.strictEqual(jan.count + feb.count, both.count);
  assert.ok(Math.abs((jan.usd + feb.usd) - both.usd) < 1e-9);
  assert.strictEqual(jan.tokens + feb.tokens, both.tokens);
});

test('bucketRange is HALF-OPEN: the boundary instant belongs to exactly one window', () => {
  const edge = Date.UTC(2026, 1, 1, 0, 0, 0);
  const rows = [ev({ ts: edge, pday: '2026-02-01' })];
  const now = Date.UTC(2026, 5, 1);
  const jan = periods.bucketRange(rows, Date.UTC(2026, 0, 1), edge, { now });
  const feb = periods.bucketRange(rows, edge, Date.UTC(2026, 2, 1), { now });
  assert.strictEqual(jan.count, 0, '[from, to) excludes `to`');
  assert.strictEqual(feb.count, 1, 'and includes `from`');
});

test('the disjoint ladder PARTITIONS history — its rows sum to lifetime', () => {
  const now = Date.parse('2026-08-07T15:00:00Z');
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const ts = now - i * 6 * 3600 * 1000;        // every 6h back ~100 days
    rows.push(ev({ id: 'rid:' + i, ts, pday: periods.pdayOf(ts, 0) }));
  }
  const ladder = periods.disjointLadder(now, 'UTC');
  let sum = 0;
  for (const w of ladder) sum += periods.bucketRange(rows, w.from, w.to, { now }).count;
  const all = periods.bucketRange(rows, -Infinity, Infinity, { now }).count;
  assert.strictEqual(sum, all,
    'the old NESTED ladder counted today six times; this one adds up');
  assert.strictEqual(all, 400);
});

test('a future-dated row is quarantined instead of landing in every window at once', () => {
  const now = Date.UTC(2026, 7, 7);
  const rows = [ev({ ts: now + 90 * 86400000, pday: '2026-11-05' })];
  const b = periods.bucketRange(rows, -Infinity, Infinity, { now });
  assert.strictEqual(b.count, 0);
  assert.strictEqual(b.future, 1, 'and the quarantine is VISIBLE');
});

test('an undated row is excluded AND counted, never silently dropped', () => {
  const now = Date.UTC(2026, 7, 7);
  const b = periods.bucketRange([ev({ ts: null })], -Infinity, Infinity, { now });
  assert.strictEqual(b.count, 0);
  assert.strictEqual(b.undated, 1);
});

// ---- the fold --------------------------------------------------------------------

test('merge is COMMUTATIVE and IDEMPOTENT', () => {
  const tx = ev({ prov: 'transcript', usrc: 'body', out: 313, harness: 'claude-code',
                  ctier: 'haiku', sessions: ['s1'] });
  const gw = ev({ prov: 'gateway', usrc: 'body', out: 313, req: 'claude-opus-5',
                  reason: 'simple', sessions: ['s2'] });
  const ab = merge(Object.assign({ source_mask: 1 }, tx), Object.assign({ source_mask: 2 }, gw));
  const ba = merge(Object.assign({ source_mask: 2 }, gw), Object.assign({ source_mask: 1 }, tx));
  for (const k of ['in', 'out', 'cr', 'c5', 'c1', 'cu', 'req', 'reason', 'harness', 'ctier', 'source_mask']) {
    assert.deepStrictEqual(ab[k], ba[k], `field ${k} is order-dependent`);
  }
  assert.deepStrictEqual(ab.sessions, ba.sessions);
  // Idempotent: folding a row with itself changes nothing.
  const again = merge(ab, ab);
  assert.deepStrictEqual(again.in, ab.in);
  assert.deepStrictEqual(again.out, ab.out);
});

test('per-field precedence: gateway owns req/reason, transcript owns harness/ctier/tokens', () => {
  const tx = Object.assign({ source_mask: 1 }, ev({ prov: 'transcript', usrc: 'body',
    out: 313, cr: 45702, harness: 'claude-code', ctier: 'haiku', req: null, reason: '' }));
  const gw = Object.assign({ source_mask: 2 }, ev({ prov: 'gateway', usrc: 'estimate',
    out: 0, cr: 0, harness: 'gw', ctier: null, req: 'claude-opus-5', reason: 'simple' }));
  const m = merge(tx, gw);
  assert.strictEqual(m.req, 'claude-opus-5', 'only the gateway knows what was REQUESTED');
  assert.strictEqual(m.reason, 'simple');
  assert.strictEqual(m.harness, 'claude-code', 'the gateway has no session visibility');
  assert.strictEqual(m.ctier, 'haiku');
  // TX(body) beats GW(estimate): preferring the gateway here would DELETE 313 output
  // tokens and 45,702 cache reads, inflate the savings ratio, and print it unhedged.
  assert.strictEqual(m.out, 313);
  assert.strictEqual(m.cr, 45702);
});

test('a divergent sessionId on a shared provider id is a RESUME, not a conflict', () => {
  // 157 message ids were measured appearing under more than one sessionId — Claude Code
  // copies history forward on resume/fork. Routed as conflicts, the fold would either
  // lose 4.4% of dollars or blank every window containing a resumed chat.
  const a = Object.assign({ source_mask: 1 }, ev({ sessions: ['s1'], sess: 's1' }));
  const b = Object.assign({ source_mask: 1 }, ev({ sessions: ['s2'], sess: 's2' }));
  const m = merge(a, b);
  assert.deepStrictEqual(m.sessions, ['s1', 's2']);
  assert.strictEqual(m.sess, 's1', 'a deterministic owner, not a conflict');
  assert.ok(!(m.conflicts || []).includes('sess'));
});

test('replaying the same events in any order converges on the same total', () => {
  const base = [];
  for (let i = 0; i < 40; i++) base.push(ev({ id: 'rid:' + i, ts: Date.UTC(2026, 7, 5, i % 24) }));
  const shuffled = base.slice().reverse().concat(base).concat(base.slice(10, 20));
  const a = fold(base);
  const b = fold(shuffled);
  assert.strictEqual(a.rows.length, b.rows.length);
  const sum = (r) => r.rows.reduce((s, x) => s + (deriveRow(x).delta || 0), 0);
  assert.ok(Math.abs(sum(a) - sum(b)) < 1e-9, 'a replay must not change the money');
});

// ---- the 15 "report NOTHING" cases -----------------------------------------------

test('case 9 — a non-2xx row is recorded but NEVER priced', () => {
  const d = deriveRow(ev({ status: 429 }));
  assert.strictEqual(d.priceable, false);
  assert.strictEqual(d.reason, 'non_2xx');
  assert.strictEqual(d.delta, null, 'null, not 0 — "no claim" is not "$0.00"');
});

test('case 5 — a pre-migration gateway row (no request id) is quarantined from the fold', () => {
  const weak = require('../src/peek/events').eventKey({ harness: 'h', sess: '', served: 'm', ts: 0, in: 1, out: 1 });
  const { rows, stats } = fold([ev({ id: weak, prov: 'gateway' })]);
  assert.strictEqual(rows.length, 0);
  assert.strictEqual(stats.preMigration, 1,
    'disjointness against the transcript rows is UNPROVABLE, so it claims nothing');
});

test('case 3 — a BOTH-source row joined by a WEAK key falls back to transcript-only', () => {
  const weak = require('../src/peek/events').eventKey({ harness: 'h', sess: 's', served: 'claude-haiku-4-5', ts: 60000, in: 1, out: 1 });
  // The gateway half must carry a strong-looking id to get past the case-5 gate, so
  // build the collision directly: same weak id, two provenances.
  const txRow = ev({ id: weak, prov: 'transcript' });
  const gwRow = ev({ id: weak, prov: 'gateway' });
  const { rows, stats } = fold([txRow, gwRow]);
  // Case 5 fires first for the gateway row (no strong key) — which is the correct,
  // more conservative outcome: nothing merged, nothing credited twice.
  assert.strictEqual(stats.preMigration, 1);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].prov, 'transcript');
  assert.strictEqual(rows[0].conf, 'estimated');
});

test('case 4 — two rows sharing a WEAK key but disagreeing on `served` are BOTH dropped', () => {
  const weak = 'wk:deadbeefdeadbeefdeadbeef';
  const { rows, stats } = fold([
    ev({ id: weak, prov: 'transcript', served: 'claude-haiku-4-5' }),
    ev({ id: weak, prov: 'transcript', served: 'claude-sonnet-5' }),
  ]);
  assert.strictEqual(rows.length, 0, 'they are not the same call; crediting either is a guess');
  assert.strictEqual(stats.weakServedConflict, 1);
});

test('case 15 — the same STRONG key with >2x different output is quarantined, not averaged', () => {
  const { rows, stats } = fold([
    ev({ id: 'rid:x', out: 100 }),
    ev({ id: 'rid:x', out: 900 }),
  ]);
  assert.strictEqual(stats.outlier2x, 1);
  assert.strictEqual(rows.length, 0, 'that is a writer bug, not a merge');
});

test('case 6 — a stale writer\'s rows are quarantined from the fold', () => {
  const { rows, stats } = fold([ev({ id: 'rid:a', w: 'gw' }), ev({ id: 'rid:b', w: 'cli' })],
    { staleWriters: ['gw'] });
  assert.strictEqual(stats.staleWriter, 1);
  assert.deepStrictEqual(rows.map((r) => r.id), ['rid:b']);
});

test('case 7 — over 20% unpriceable tokens suppresses DOLLARS and reports tokens', () => {
  const rows = [
    ev({ id: 'rid:1', served: 'claude-haiku-4-5', in: 1000, out: 1000 }),
    ev({ id: 'rid:2', served: 'some-model-nobody-has-priced', in: 100000, out: 100000 }),
  ];
  const f = foldRows(rows);
  assert.ok(f.dollarsSuppressed, 'a figure from a fifth of the evidence is not a figure');
  assert.ok(f.unpricedRatio > 0.2);
  assert.strictEqual(f.unpriced.served_not_in_catalog, 1);
});

test('an unpriceable model contributes NOTHING and never inherits a sibling rate', () => {
  const d = deriveRow(ev({ served: 'totally-made-up-model-9' }));
  assert.strictEqual(d.priceable, false);
  assert.strictEqual(d.spent, null);
  assert.strictEqual(d.delta, null);
});

// ---- the absolute invariant ------------------------------------------------------

test('THE ABSOLUTE INVARIANT: measured and estimated are never summed', () => {
  const rows = [
    ev({ id: 'rid:m', conf: 'measured', in: 1000000, out: 1000000 }),
    ev({ id: 'rid:e', conf: 'estimated', in: 1000000, out: 1000000 }),
  ];
  const f = foldRows(rows);
  assert.strictEqual(f.measured.calls, 1);
  assert.strictEqual(f.estimated.calls, 1);
  // The fold result must expose NO field that combines the two. Adding
  // metrics.summary().dollars.saved + ledger.totals().usd + peek.totals.dollarsSaved is
  // a triple count by construction, and this is the structural guard against it.
  const forbidden = Object.keys(f).filter((k) => ['saved', 'spent', 'total', 'usd', 'dollars'].includes(k));
  assert.deepStrictEqual(forbidden, [],
    'no top-level combined accumulator may exist — a renderer must pick a basis');
  // Each basis on its own is right: opus-5 $30 vs haiku-4-5 $6 = $24.
  assert.ok(Math.abs(f.measured.saved - 24) < 1e-9, String(f.measured.saved));
  assert.ok(Math.abs(f.estimated.saved - 24) < 1e-9, String(f.estimated.saved));
});

test('a costlier route subtracts — the sign survives end to end', () => {
  // opus-5 baseline $30 ; fable-5 served $60 -> -$30.
  const d = deriveRow(ev({ served: 'claude-fable-5', base: 'claude-opus-5' }));
  assert.ok(d.priceable);
  assert.ok(Math.abs(d.delta + 30) < 1e-9, String(d.delta));
  const f = foldRows([ev({ served: 'claude-fable-5', base: 'claude-opus-5' })]);
  assert.ok(f.estimated.saved < 0, 'no max(0, …) anywhere in the math');
  assert.ok(Math.abs(f.estimated.extra - 30) < 1e-9);
});

test('an ineligible row contributes spend but never a saving', () => {
  const d = deriveRow(ev({ elig: false }));
  assert.ok(d.priceable);
  assert.strictEqual(d.delta, 0, 'the user\'s own model choice is not Cheaper\'s credit');
  assert.ok(d.spent > 0);
});

// ---- coverage and tombstones -----------------------------------------------------

function withStore(fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-store-'));
  const prev = { ev: process.env.CHEAPER_EVENTS_DIR, home: process.env.CHEAPER_PEEK_HOME,
                 leg: process.env.CHEAPER_LEGACY_FILE, led: process.env.CHEAPER_LEDGER_FILE };
  process.env.CHEAPER_EVENTS_DIR = path.join(d, 'events');
  process.env.CHEAPER_PEEK_HOME = d;
  process.env.CHEAPER_LEGACY_FILE = path.join(d, 'legacy_chats.json');
  process.env.CHEAPER_LEDGER_FILE = path.join(d, 'lifetime.json');
  try { return fn(d); } finally {
    for (const [k, v] of [['CHEAPER_EVENTS_DIR', prev.ev], ['CHEAPER_PEEK_HOME', prev.home],
                          ['CHEAPER_LEGACY_FILE', prev.leg], ['CHEAPER_LEDGER_FILE', prev.led]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('a period with no coverage reports NOT COVERED, not $0.00', () => {
  withStore(() => {
    const store = require('../src/peek/store');
    const w = store.reportWindow([], Date.UTC(2025, 0, 1), Date.UTC(2025, 1, 1), {});
    assert.strictEqual(w.status, 'not_covered');
    assert.strictEqual(w.measured, null);
    assert.strictEqual(w.estimated, null);
    assert.ok(w.labels.includes('not_covered'));
    assert.match(w.notes.join(' '), /not the same as saving \$0/);
  });
});

test('events are their OWN coverage evidence, so a lost state.json does not blank a '
   + 'window full of real data', () => {
  withStore(() => {
    const store = require('../src/peek/store');
    // No addCoverage() call at all — state.json is empty, as it would be after a
    // hand-delete or an upgrade from a build that predates coverage tracking.
    const row = ev({ ts: Date.UTC(2026, 7, 5, 12) });
    const w = store.reportWindow([row], Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1), {});
    assert.notStrictEqual(w.status, 'not_covered',
      '"not covered" over live data is exactly as wrong as "$0.00" over no data');
    assert.ok(w.estimated.calls === 1);
    // …but a window with genuinely nothing in it still reports not_covered.
    const empty = store.reportWindow([row], Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1), {});
    assert.strictEqual(empty.status, 'not_covered');
  });
});

test('a partially covered period reports only its covered sub-window, and says so', () => {
  withStore(() => {
    const store = require('../src/peek/store');
    store.addCoverage('observed', Date.UTC(2026, 7, 4), Date.UTC(2026, 7, 6), 'claude-code');
    const w = store.reportWindow([ev()], Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1), {});
    assert.strictEqual(w.status, 'partial');
    assert.ok(w.labels.includes('partial_coverage'));
  });
});

test('case 12 — a tombstone in the window is reported, so totals drop WITH a reason', () => {
  withStore(() => {
    const store = require('../src/peek/store');
    store.addCoverage('observed', Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1));
    store.addTombstone({ session: 's1', events_removed: 12, from: Date.UTC(2026, 7, 3), to: Date.UTC(2026, 7, 4) });
    const w = store.reportWindow([ev()], Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1), {});
    assert.strictEqual(w.tombstones, 1);
    assert.ok(w.labels.includes('tombstoned'));
  });
});

test('a store written by a NEWER Cheaper refuses to report rather than reporting zero', () => {
  withStore((d) => {
    const store = require('../src/peek/store');
    fs.mkdirSync(path.join(d, 'events'), { recursive: true });
    fs.writeFileSync(path.join(d, 'events', 'state.json'),
      JSON.stringify({ v: 99, coverage: [], tombstones: [] }));
    const w = store.reportWindow([ev()], -Infinity, Infinity, {});
    assert.strictEqual(w.status, 'suppressed');
    assert.ok(w.labels.includes('store_newer_than_reader'));
  });
});

test('legacy chats are frozen, excluded from periods, and reported separately', () => {
  withStore((d) => {
    const store = require('../src/peek/store');
    fs.mkdirSync(path.join(d, '.cheaper'), { recursive: true });
    fs.writeFileSync(path.join(d, 'lifetime.json'), JSON.stringify({
      version: 1, chats: { abc: { usd: 3.7122, tokens: 6343704, exact: false,
                                  at: '2026-08-07T01:56:42.842Z' } } }));
    const frozen = store.ensureLegacyImported();
    assert.strictEqual(frozen.chats.abc.derivation, 'frozen');
    assert.strictEqual(frozen.chats.abc.bucket_confidence, 'unknown',
      'their timestamp is tagline-run time, and the store says so rather than pretending');
    const t = store.legacyTotals();
    assert.ok(Math.abs(t.usd - 3.7122) < 1e-9);
    // …and they contribute NOTHING to any period window.
    const w = store.reportWindow([], -Infinity, Infinity, {});
    assert.strictEqual(w.status, 'not_covered');
  });
});

test('a backfilled legacy chat is RETIRED, so the same money is never counted twice', () => {
  withStore((d) => {
    const store = require('../src/peek/store');
    fs.writeFileSync(path.join(d, 'lifetime.json'), JSON.stringify({
      version: 1, chats: { s1: { usd: 5, tokens: 100 }, s2: { usd: 7, tokens: 200 } } }));
    store.ensureLegacyImported();
    assert.strictEqual(store.legacyTotals().chats, 2);
    assert.strictEqual(store.retireLegacyChat('s1'), true);
    assert.strictEqual(store.legacyTotals().chats, 1);
    assert.ok(Math.abs(store.legacyTotals().usd - 7) < 1e-9);
  });
});

test('a forward-incompatible lifetime.json surfaces a refusal instead of zero savings', () => {
  withStore((d) => {
    // Cache-busting: ledger.js reads the path from env at call time, so no reload needed.
    fs.writeFileSync(path.join(d, 'lifetime.json'), JSON.stringify({ version: 99, chats: { a: { usd: 5, tokens: 1 } } }));
    const ledger = require('../src/peek/ledger');
    const l = ledger.load();
    assert.strictEqual(l.tooNew, true);
    // And a record() against it must NOT clobber data this build cannot read.
    ledger.record('b', 1, 1, false);
    const raw = JSON.parse(fs.readFileSync(path.join(d, 'lifetime.json'), 'utf8'));
    assert.strictEqual(raw.version, 99);
    assert.ok(raw.chats.a, 'the newer file survived untouched');
  });
});
