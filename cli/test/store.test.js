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
// The cache-migration tests price both endpoints of the counterfactual INTERVAL from the
// pricer itself rather than from a hand-copied constant, so a catalog edit that moves the
// write/read spread moves the assertion with it instead of silently invalidating it.
const { costOfModel } = require('../src/peek/pricing');

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

// ---- THE COUNTERFACTUAL'S CACHE STATE ---------------------------------------------
//
// Both arms of the subtraction used to be priced off ONE token split — the SERVED arm's.
// A model switch invalidates the prompt cache, so the served arm pays a cache CREATE for
// a prefix the un-switched baseline model may still have been holding and would merely
// have READ. Charging the baseline a CREATE for those tokens inflates it by the whole
// write/read spread (12.5x on Anthropic), and the claimed saving with it.
//
// Rates in force on 2026-08-20, from model_prices.json:
//     claude-opus-5     in $5   out $25  cacheRead $0.50  cacheWrite $6.25
//     claude-haiku-4-5  in $1   out $5   cacheRead $0.10  cacheWrite $1.25
//
// Measured exposure that produced this rule, over the author's 22,475-row store:
//     3,301 WARM switched rows  -> $156.03 of credit, correctly priced, untouched
//        79 COLD switched rows  -> $14.13 claimed, true value in [-$7.23, +$14.13]
//    14,902 un-switched rows    -> unaffected by construction, and verified unmoved

const CACHE_ROW = { served: 'claude-haiku-4-5', base: 'claude-opus-5',
                    pday: '2026-08-20', in: 0, out: 1000, elig: true };

test('THE CACHE-MIGRATION DEFECT: a COLD start after a model switch has no derivable '
   + 'counterfactual, so the row is withheld and LABELLED, never claimed', () => {
  // 200k written from scratch on the routed model, nothing read: the switched arm was
  // cold. Whether the BASELINE model was also cold (the prefix is new -> it would have
  // paid CREATE too) or warm (the switch is what forced the rewrite -> it would have
  // paid READ) is not recorded anywhere, and the two answers do not merely differ in
  // size — they differ in SIGN.
  const row = ev(Object.assign({}, CACHE_ROW, { cr: 0, c5: 200000 }));

  // First, prove the interval is real and prove its DIRECTION, from the pricer itself.
  const ctx = { at: row.pday, speed: null, serviceTier: row.svc };
  const spent = costOfModel('claude-haiku-4-5',
    { cacheCreate5m: 200000, outTok: 1000 }, ctx);
  const baseIfCold = costOfModel('claude-opus-5',
    { cacheCreate5m: 200000, outTok: 1000 }, ctx);   // what shipped: served arm's split
  const baseIfWarm = costOfModel('claude-opus-5',
    { cacheRead: 200000, outTok: 1000 }, ctx);       // the un-switched cache state
  assert.ok(Math.abs(spent - 0.255) < 1e-9, String(spent));
  assert.ok(Math.abs(baseIfCold - 1.275) < 1e-9, String(baseIfCold));
  assert.ok(Math.abs(baseIfWarm - 0.125) < 1e-9, String(baseIfWarm));
  // DIRECTION, asserted explicitly: pricing the baseline on the served arm's split can
  // only ever move it UP. Every catalog entry prices a write at or above a read, so the
  // shipped figure was biased in exactly one direction — it never understated.
  assert.ok(baseIfCold > baseIfWarm,
    'the served arm\'s split can only inflate the baseline, never deflate it');
  // ...and the interval STRADDLES ZERO. This is not a rounding difference. The shipped
  // code claims +$1.02 saved on a call that may in fact have cost the user $0.13.
  assert.ok(baseIfCold - spent > 0, 'the old figure claims a saving');
  assert.ok(baseIfWarm - spent < 0, 'the honest alternative is an anti-saving');

  // So the row makes NO claim, and says which claim it is declining to make.
  const d = deriveRow(row);
  assert.strictEqual(d.priceable, false);
  assert.strictEqual(d.reason, 'cache_state_indeterminate');
  assert.strictEqual(d.delta, null, 'a withheld claim is null, never 0');
  assert.strictEqual(d.baseline, null, 'the indeterminate figure is not published');
  assert.strictEqual(d.tokens, 201000, 'the TOKENS are not in doubt and are still counted');
});

test('a WARM switched call keeps its credit — an incremental cache write is new content '
   + 'in BOTH arms, so the served split IS the counterfactual split', () => {
  // 200k read + 20k written: the routed model already held the prefix, so the 20k is
  // content appended since the previous turn. The baseline model would have had to
  // create that same new content. No bias, and re-pricing it would be the mirror-image
  // fabrication — an over-correction that quietly deletes real, correctly-earned credit.
  const d = deriveRow(ev(Object.assign({}, CACHE_ROW, { cr: 200000, c5: 20000 })));
  assert.ok(d.priceable, d.reason);
  assert.ok(Math.abs(d.spent - 0.05) < 1e-9, String(d.spent));
  assert.ok(Math.abs(d.baseline - 0.25) < 1e-9, String(d.baseline));
  assert.ok(Math.abs(d.delta - 0.20) < 1e-9, String(d.delta));
});

test('NO-OP GUARD: a session that never switches model is unchanged TO THE CENT, however '
   + 'cache-heavy the calls are', () => {
  // The identical cold 200k write, but the call ran ON the baseline. Nothing was
  // invalidated because nothing was switched, so both arms are the same model on the
  // same split and the delta is zero under EVERY cache assumption. A guard that fired
  // here would manufacture an anti-saving on 14,902 of the author's 18,285 eligible
  // rows — the exact over-correction this test exists to forbid.
  for (const elig of [true, false]) {
    const d = deriveRow(ev(Object.assign({}, CACHE_ROW, {
      served: 'claude-opus-5', base: 'claude-opus-5', cr: 0, c5: 200000, elig })));
    assert.ok(d.priceable, `elig=${elig}: ${d.reason}`);
    assert.strictEqual(d.reason, '');
    assert.ok(Math.abs(d.spent - 1.275) < 1e-9, String(d.spent));
    assert.ok(Math.abs(d.baseline - 1.275) < 1e-9, String(d.baseline));
    assert.strictEqual(d.delta, 0, 'a no-op must stay a no-op');
  }
  // Same for a cold row that never wrote a cache at all, and for one with no baseline.
  const noCache = deriveRow(ev(Object.assign({}, CACHE_ROW, { cr: 0, c5: 0 })));
  assert.ok(noCache.priceable, noCache.reason);
  const noBase = deriveRow(ev(Object.assign({}, CACHE_ROW, { cr: 0, c5: 200000, base: null })));
  assert.strictEqual(noBase.reason, 'no_baseline', 'no baseline is its own labelled case');
});

test('a withheld cache-migration row is COUNTED and enters no accumulator', () => {
  const rows = [
    ev({ id: 'rid:warm', served: 'claude-haiku-4-5', base: 'claude-opus-5',
         pday: '2026-08-20', in: 0, out: 1000, cr: 200000, c5: 20000, elig: true }),
    ev({ id: 'rid:cold', served: 'claude-haiku-4-5', base: 'claude-opus-5',
         pday: '2026-08-20', in: 0, out: 1000, cr: 0, c5: 200000, elig: true }),
  ];
  const f = foldRows(rows);
  assert.strictEqual(f.unpriced.cache_state_indeterminate, 1);
  assert.strictEqual(f.unpricedCalls, 1);
  assert.strictEqual(f.events.estimated, 2, 'both rows were SEEN; only one was priced');
  assert.strictEqual(f.estimated.calls, 1);
  // Only the warm row's money is inside the totals — the withheld row adds neither its
  // saving nor its spend, so `spent` still covers exactly the rows counted as priced.
  assert.ok(Math.abs(f.estimated.saved - 0.20) < 1e-9, String(f.estimated.saved));
  assert.ok(Math.abs(f.estimated.spent - 0.05) < 1e-9, String(f.estimated.spent));
  assert.strictEqual(f.unpricedTokens, 201000);
});

test('the cache-state rule is ONE implementation, reachable from both vocabularies', () => {
  // derive.js owns the predicate; counterfactual.js exposes the transcript-record
  // reading of it so cli/src/peek/tagline.js can adopt it without a second copy. Two
  // implementations of one money rule is how the three prior mispricing incidents
  // started, so the shared edge is asserted rather than assumed.
  const derive = require('../src/peek/derive');
  const cf = require('../src/peek/counterfactual');
  assert.strictEqual(typeof derive.cacheStateIndeterminate, 'function');
  assert.strictEqual(typeof cf.recordCacheStateIndeterminate, 'function');
  const cold = { cacheRead: 0, cacheCreate5m: 200000, inTokens: 0, outTokens: 1000 };
  const warm = { cacheRead: 200000, cacheCreate5m: 20000, inTokens: 0, outTokens: 1000 };
  assert.strictEqual(
    cf.recordCacheStateIndeterminate(cold, 'claude-haiku-4-5', 'claude-opus-5'), true);
  assert.strictEqual(
    cf.recordCacheStateIndeterminate(warm, 'claude-haiku-4-5', 'claude-opus-5'), false);
  assert.strictEqual(
    cf.recordCacheStateIndeterminate(cold, 'claude-opus-5', 'claude-opus-5'), false,
    'no switch, no invalidation — the transcript path must agree with the stored path');
});

// ---- WHERE A ROW SITS ON THE TIME AXIS ---------------------------------------------
//
// `ts` and `pday` are separate fields with separate merge outcomes, and `deriveRow` prices
// off `pday`. These three reports used to filter on `Number(r.ts)` alone, which is wrong
// in two opposite directions at once:
//
//   * `Number(null)` is 0 — FINITE — so a row whose `ts` died in a merge fell out of its
//     OWN month with no label and no count, while the gateway reported its dollars in
//     that same month on that same row;
//   * `Number(undefined)` is NaN, so both range guards were false and the row was waved
//     into EVERY window at once: breakdown(April) + breakdown(August) was twice their
//     union, and a 2027 trend emitted a 2026 bucket carrying real dollars.
//
// `cli/scripts/check-period-parity.js` diffs these against gateway/app/reporting.py over
// nine zones; the tests below pin the properties on this side.

const store = require('../src/peek/store');

// Coverage spanning every window asked for below, so `not_covered` is never the variable
// under test: what is on trial is which window a row lands in.
const COVERED = { v: 1, tombstones: [], ingested_files: [],
                  coverage: [{ kind: 'observed', from: 0, to: Date.UTC(2028, 0, 1) }] };
const PART_A = [Date.UTC(2026, 3, 1), Date.UTC(2026, 7, 1)];    // April → July
const PART_B = [Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1)];    // August, the row's month
const PART_U = [PART_A[0], PART_B[1]];                          // and their exact union
const Y2027 = [Date.UTC(2027, 0, 1), Date.UTC(2027, 1, 1)];

const win = (rows, w) => store.reportWindow(rows, w[0], w[1], { state: COVERED });
// Sum the STATED figures only. A withheld group states none, and `s + null` silently
// treats a declined claim as a zero addend — the exact shape these tests exist to forbid,
// and it does not stop being that shape because it is in a test helper. Callers that can
// encounter a withheld group assert the withholding separately.
const sumSaved = (xs, basis) => xs.reduce(
  (s, x) => (x[basis].saved === null || x[basis].saved === undefined
    ? s : s + x[basis].saved), 0);
const bdSaved = (rows, w) => sumSaved(
  store.reportBreakdown(rows, 'served', w[0], w[1]), 'estimated');
const bdCalls = (rows, w) => store.reportBreakdown(rows, 'served', w[0], w[1])
  .reduce((s, g) => s + g.estimated.calls, 0);
const trSaved = (rows, w) => sumSaved(
  store.reportTrend(rows, 'day', w[0], w[1]), 'estimated');

test('the merge path really produces a row whose `ts` died and whose `pday` lived', () => {
  // No hand-edited row: two transcript lines sharing a provider id and a rev, 1500 ms
  // apart inside ONE local day. `merge` ranks `ts` and `pday` SEPARATELY, so the two `ts`
  // values tie on rank, fail strict equality, and `ts` is nulled and NAMED — while the
  // AGREEING `pday` survives untouched. That row has no instant and a good price date.
  const t = Date.UTC(2026, 7, 5, 12, 0, 0);
  const { rows } = fold([ev({ id: 'rid:mc', ts: t }), ev({ id: 'rid:mc', ts: t + 1500 })]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ts, null);
  assert.ok(rows[0].conflicts.includes('ts'));
  assert.strictEqual(rows[0].pday, '2026-08-05', 'the frozen day must SURVIVE the conflict');
  const d = deriveRow(rows[0]);
  assert.ok(d.priceable, 'priced off `pday`, not off `ts`');
  assert.ok(d.delta > 0);
});

test('a row dated only by its frozen day appears in that day\'s window and no other', () => {
  const t = Date.UTC(2026, 7, 5, 12, 0, 0);
  const row = fold([ev({ id: 'rid:mc', ts: t }), ev({ id: 'rid:mc', ts: t + 1500 })]).rows[0];
  const saved = foldRows([row]).estimated.saved;
  assert.ok(saved > 0, 'the fixture must carry real dollars or this proves nothing');

  for (const [w, present] of [[PART_B, true], [PART_A, false], [Y2027, false]]) {
    const n = present ? 1 : 0;
    const money = present ? saved : 0;
    const rep = win([row], w);
    assert.strictEqual(rep.estimated.calls, n, `window ${w}`);
    assert.ok(Math.abs(rep.estimated.saved - money) < 1e-9, `window ${w}`);
    assert.strictEqual(bdCalls([row], w), n, `breakdown ${w}`);
    assert.ok(Math.abs(bdSaved([row], w) - money) < 1e-9, `breakdown ${w}`);
    assert.ok(Math.abs(trSaved([row], w) - money) < 1e-9, `trend ${w}`);
    // Never a silent fabrication and never a silent omission: when it is out, it is out
    // of every channel INCLUDING the trailing `undated` one, which would attribute a
    // DATED row to no day.
    assert.deepStrictEqual(store.reportTrend([row], 'day', w[0], w[1]).map((p) => p.bucket),
      present ? ['2026-08-05'] : []);
    assert.strictEqual(rep.undated, 0, 'a dated row is not an undated one');
    assert.ok(!rep.labels.includes('incomplete'));
  }
});

test('an ABSENT `ts` no longer puts one row\'s dollars in EVERY window at once', () => {
  // Number(undefined) is NaN, so both range guards were false and the row passed every
  // window. report(April) + report(August) claimed $48 for one $24 call.
  const row = ev({ id: 'rid:absent' });
  delete row.ts;
  const saved = foldRows([row]).estimated.saved;
  assert.ok(saved > 0);
  assert.ok(Math.abs(bdSaved([row], PART_A) + bdSaved([row], PART_B)
    - bdSaved([row], PART_U)) < 1e-9, 'report(A) + report(B) === report(A ∪ B)');
  assert.ok(Math.abs(bdSaved([row], PART_U) - saved) < 1e-9, 'and the union is the truth');
  assert.strictEqual(bdSaved([row], PART_A), 0, 'April is not August');
  // …and a 2027 request must not emit a 2026 bucket carrying real dollars.
  assert.deepStrictEqual(
    store.reportTrend([row], 'day', Y2027[0], Y2027[1]).map((p) => p.bucket), []);
});

test('the ladder still PARTITIONS history when a row is dated only by a frozen day', () => {
  const t = Date.UTC(2026, 7, 5, 12, 0, 0);
  const rows = [
    ev({ id: 'rid:a', ts: Date.UTC(2026, 4, 4, 9) }),
    ev({ id: 'rid:b', ts: t - 3600000, conf: 'measured' }),
    fold([ev({ id: 'rid:mc', ts: t }), ev({ id: 'rid:mc', ts: t + 1500 })]).rows[0],
  ];
  const now = Date.UTC(2026, 7, 5, 15);
  const ladder = store.reportLadder(rows, now, 'UTC', { state: COVERED });
  const lifetime = store.reportWindow(rows, null, null, { state: COVERED });
  for (const basis of ['measured', 'estimated']) {
    const sum = ladder.reduce((s, w) => s + w[basis].calls, 0);
    assert.strictEqual(sum, lifetime[basis].calls, `${basis}.calls`);
    const money = ladder.reduce((s, w) => s + w[basis].saved, 0);
    assert.ok(Math.abs(money - lifetime[basis].saved) < 1e-9, `${basis}.saved`);
  }
  assert.strictEqual(lifetime.estimated.calls, 2);
  assert.strictEqual(lifetime.measured.calls, 1);
});

test('`undated` counts rows with no instant AND no usable frozen day — and says so', () => {
  const t = Date.UTC(2026, 7, 5, 12, 0, 0);
  const dated = fold([ev({ id: 'rid:mc', ts: t }),
                      ev({ id: 'rid:mc', ts: t + 1500 })]).rows[0];
  const orphan = ev({ id: 'rid:orphan', ts: null, pday: null, tzo: null });
  const rep = win([dated, orphan], PART_B);
  assert.strictEqual(rep.undated, 1, 'the placed row is NOT an exclusion');
  assert.ok(rep.labels.includes('incomplete'));
  // A note that claims more than the counter counts is the same defect class as a wrong
  // number: the counter no longer covers "no usable timestamp" on its own.
  assert.match(rep.notes.join(' '), /no usable timestamp and no usable frozen day/);
  // The orphan is excluded from the dollars, and named by every surface.
  assert.strictEqual(rep.estimated.calls, 1);
  assert.strictEqual(
    store.reportBreakdown([dated, orphan], 'served', PART_B[0], PART_B[1])
      .reduce((s, g) => s + g.unpricedCalls, 0), 1);
  const pts = store.reportTrend([dated, orphan], 'day', PART_B[0], PART_B[1]);
  assert.strictEqual(pts[pts.length - 1].bucket, 'undated');
  assert.strictEqual(pts[pts.length - 1].undatable, true);
});

test('no breakdown group and no trend point carries a cross-basis scalar count', () => {
  const rows = [ev({ id: 'rid:m', conf: 'measured' }), ev({ id: 'rid:e' })];
  const groups = store.reportBreakdown(rows, 'served', PART_B[0], PART_B[1]);
  const points = store.reportTrend(rows, 'day', PART_B[0], PART_B[1]);
  assert.ok(groups.length && points.length);
  // `calls: rs.length` was measured rows PLUS estimated rows in one cell — the same
  // concealment shape as a combined Saved column, where the separation is far less
  // visually obvious. gateway/tests/test_reporting.py asserts the same thing structurally
  // over the live API response; this is its CLI half.
  const forbidden = ['calls', 'total', 'combined', 'all', 'sum', 'usd', 'dollars'];
  for (const node of groups.concat(points)) {
    const hit = Object.keys(node).filter((k) => forbidden.includes(k));
    assert.deepStrictEqual(hit, [], `${JSON.stringify(Object.keys(node))}`);
    // …and the two bases are each right on their own, so the missing scalar is a removed
    // cross-basis sum and not a removed fact.
    assert.strictEqual(node.measured.calls, 1);
    assert.strictEqual(node.estimated.calls, 1);
  }
});

// ---- `events` means ROWS SEEN, here and in the gateway, under ONE name ---------------
//
// `foldRows` returns TWO counts per basis, answering TWO questions:
//   acc[basis].calls  rows PRICED — the denominator every dollar figure rests on;
//   events[basis]     rows SEEN, INCLUDING the ones whose dollars could not be derived,
//                     because a call and token count is EXACT even when a dollar is not.
//
// This runtime has always meant the second. `gateway/app/reporting.py` published the
// FIRST under the second's name, so `cheaper reports --json` and `cheaper savings --json`
// returned one meaning when the gateway answered and the other when it did not — one
// field name, two meanings, decided by reachability. `scripts/check-period-parity.js`
// now diffs `events` on every window, breakdown group and trend point across both
// runtimes; these tests pin the CLI half of the answer as literal numbers so a silent
// re-definition on either side has to break something here as well as there.

test('an UNPRICEABLE row reports ONE event, never zero — the count is exact even when '
   + 'the dollars are withheld', () => {
  // The blocker's own fixture: one MEASURED call whose served model is absent from the
  // catalog, against a claude-opus-5 baseline, in the fully covered window
  // 2026-08-01 → 2026-09-01. The gateway answered `events: {measured: 0, estimated: 0}`
  // beside `unpricedCalls: 1` and a note asserting one call whose count is EXACT.
  const row = ev({ id: 'rid:unpriceable', served: 'llama-4-maverick',
                   base: 'claude-opus-5', conf: 'measured' });
  const rep = win([row], PART_B);
  assert.deepStrictEqual(rep.events, { measured: 1, estimated: 0 });
  // The dollars — and ONLY the dollars — are withheld.
  assert.strictEqual(rep.dollars_suppressed, true);
  assert.strictEqual(rep.measured.saved, null);
  assert.strictEqual(rep.measured.spent, null);
  assert.strictEqual(rep.measured.calls, 0, 'rows PRICED keeps its own meaning');
  assert.strictEqual(rep.unpricedCalls, 1);
  assert.strictEqual(rep.undated, 0);
  assert.deepStrictEqual(rep.unpriced, { served_not_in_catalog: 1 });
  // …and the two counters differ by exactly the visible exclusion, on every basis.
  assert.strictEqual(rep.events.measured - rep.measured.calls, rep.unpricedCalls);
});

test('the seen counter splits by basis — it never credits a measured row to the '
   + 'estimated column', () => {
  // GUARD THE GUARD: counting rows SEEN must not have been implemented as counting rows.
  const rows = [
    ev({ id: 'rid:m', served: 'llama-4-maverick', conf: 'measured' }),
    ev({ id: 'rid:e1', served: 'llama-4-maverick' }),
    ev({ id: 'rid:e2' }),
  ];
  const rep = win(rows, PART_B);
  assert.deepStrictEqual(rep.events, { measured: 1, estimated: 2 });
  assert.strictEqual(rep.unpricedCalls, 2);
  assert.strictEqual(rep.measured.calls, 0);
  assert.strictEqual(rep.estimated.calls, 1);
});

test('every breakdown group and every trend point carries `events`, per basis, as rows '
   + 'SEEN', () => {
  // The gateway has emitted `events` on these two shapes all along; this side omitted it
  // entirely, which is why the parity gate could not diff the field and why the gateway's
  // copy could drift into meaning ROWS PRICED with no gate noticing.
  const rows = [
    ev({ id: 'rid:priced' }),
    ev({ id: 'rid:unpriced', served: 'llama-4-maverick', conf: 'measured' }),
  ];
  const groups = store.reportBreakdown(rows, 'served', PART_B[0], PART_B[1]);
  const points = store.reportTrend(rows, 'day', PART_B[0], PART_B[1]);
  assert.ok(groups.length === 2 && points.length === 1);
  const sum = (xs, side) => xs.reduce((s, x) => s + x.events[side], 0);
  for (const set of [groups, points]) {
    assert.strictEqual(sum(set, 'measured'), 1);
    assert.strictEqual(sum(set, 'estimated'), 1);
    // Two columns or nothing: never flattened into one scalar.
    for (const node of set) {
      assert.deepStrictEqual(Object.keys(node.events).sort(), ['estimated', 'measured']);
    }
  }
  // The unpriceable group exists BECAUSE a row landed in it, so it may not report that
  // it holds none — while its priced accumulator honestly reports 0.
  const un = groups.find((g) => g.key === 'llama-4-maverick');
  assert.deepStrictEqual(un.events, { measured: 1, estimated: 0 });
  assert.strictEqual(un.measured.calls, 0);
  assert.strictEqual(un.unpricedCalls, 1);
});

test('the trailing `undated` trend point reports the rows it holds, not zero', () => {
  const dated = ev({ id: 'rid:dated' });
  const orphan = ev({ id: 'rid:orphan', ts: null, pday: null, tzo: null });
  const pts = store.reportTrend([dated, orphan], 'day', PART_B[0], PART_B[1]);
  const last = pts[pts.length - 1];
  assert.strictEqual(last.bucket, 'undated');
  assert.strictEqual(last.undatable, true);
  // It carries one row, so it says one. Its DOLLARS are another matter: `deriveRow`
  // refuses to price it, so both accumulators stay at 0 calls and its exclusion is
  // counted. A bucket that exists only because a row is in it may not claim to be empty.
  assert.deepStrictEqual(last.events, { measured: 0, estimated: 1 });
  assert.strictEqual(last.estimated.calls, 0, 'it enters NEITHER accumulator');
  assert.strictEqual(last.unpricedCalls, 1);
});

// ---- the WITHHELD decision reaches the trend and the breakdown, not just the window ---
//
// `foldRows` computes `dollarsSuppressed` for EVERY set of rows it folds. `reportWindow`
// applied it; `reportTrend` and `reportBreakdown` computed it and threw it away, publishing
// raw accumulators with no flag at all. The day-grain trend bucket covers exactly the rows
// the ladder's Today row covers, so one screen carried both claims six lines apart:
//
//   Aug 12 (withheld)  withheld | withheld     ...so no dollar figure is claimed.
//   2026-08-12  $0.02 | $0.02  #  |  #
//
// `gateway/app/reporting.py::report_trend/_point` and `report_breakdown` had the identical
// omission, and `check-period-parity.js` now diffs `dollars_suppressed` on all three shapes.

// Two priceable calls plus one call on a model absent from the catalog, whose tokens
// dominate — the same fixture the gateway's mirror of this test uses.
const SUPPRESSED_ROWS = [
  ev({ id: 'rid:p1', conf: 'measured', in: 1000, out: 1000 }),
  ev({ id: 'rid:p2', conf: 'measured', in: 1000, out: 1000 }),
  ev({ id: 'rid:u1', conf: 'measured', served: 'no-such-model-xyz',
       in: 500000, out: 500000 }),
];

test('a trend BUCKET withholds the dollars its own window withholds, and says it did',
  () => {
    const w = win(SUPPRESSED_ROWS, PART_B);
    assert.strictEqual(w.status, 'suppressed');
    assert.strictEqual(w.dollars_suppressed, true);
    assert.strictEqual(w.measured.saved, null);

    const pts = store.reportTrend(SUPPRESSED_ROWS, 'day', PART_B[0], PART_B[1]);
    assert.strictEqual(pts.length, 1, 'the rows share one day');
    const p = pts[0];
    // THE BLOCKER: this point used to carry measured.saved = 0.024 and no
    // `dollars_suppressed` key at all, on the SAME rows the window declines to price.
    assert.strictEqual(p.dollars_suppressed, true, 'the flag must be PUBLISHED');
    assert.strictEqual(p.measured.saved, null);
    assert.strictEqual(p.estimated.saved, null);
    for (const f of ['spent', 'baseline', 'gross', 'extra']) {
      assert.strictEqual(p.measured[f], null, `measured.${f}`);
    }
    // Only the DOLLARS are withheld. The counts are exact and are not in doubt.
    assert.strictEqual(p.measured.calls, 2);
    assert.deepStrictEqual(p.events, { measured: 3, estimated: 0 });
    assert.strictEqual(p.unpricedCalls, 1);
    // …and the two surfaces agree field for field on what they withheld.
    assert.strictEqual(p.dollars_suppressed, w.dollars_suppressed);
    assert.strictEqual(p.measured.saved, w.measured.saved);
    assert.deepStrictEqual(p.events, w.events);
  });

test('a breakdown GROUP withholds the dollars its own rows cannot support', () => {
  const groups = store.reportBreakdown(SUPPRESSED_ROWS, 'served', PART_B[0], PART_B[1]);
  const un = groups.find((g) => g.key === 'no-such-model-xyz');
  const ok = groups.find((g) => g.key === 'claude-haiku-4-5');
  assert.ok(un && ok, JSON.stringify(groups.map((g) => g.key)));

  // The group holding only the unpriceable call claims NOTHING — not $0.00.
  assert.strictEqual(un.dollars_suppressed, true);
  assert.strictEqual(un.measured.saved, null);
  assert.strictEqual(un.unpricedCalls, 1);
  assert.deepStrictEqual(un.events, { measured: 1, estimated: 0 });

  // GUARD THE GUARD: the withholding is per GROUP, decided by that group's own rows.
  // Suppressing every group whenever any row anywhere is unpriceable would erase a
  // perfectly good figure, which is concealment in the opposite direction.
  assert.strictEqual(ok.dollars_suppressed, false);
  assert.ok(ok.measured.saved > 0, `the priced group keeps its figure: ${ok.measured.saved}`);
  assert.strictEqual(ok.unpricedCalls, 0);
});

test('OVER-CORRECTION GUARD: the withholding threshold is TOKENS over a fifth, not '
   + '"any unpriced call at all"', () => {
  // Withholding on `unpricedCalls > 0` looks safer and is not: it erases a perfectly good
  // figure derived from evidence that IS complete enough, which is concealment in the
  // opposite direction, and it silently redefines Case 7 in one runtime.
  //
  // One unpriceable call at 1k/1k against two priced calls at 100k/100k: 1% of the
  // group's tokens. The figure stands, the exclusion is still COUNTED and VISIBLE.
  const rows = [
    ev({ id: 'rid:big1', conf: 'measured', in: 100000, out: 100000 }),
    ev({ id: 'rid:big2', conf: 'measured', in: 100000, out: 100000 }),
    ev({ id: 'rid:tiny', conf: 'measured', served: 'no-such-model-xyz',
         in: 1000, out: 1000 }),
  ];
  const w = win(rows, PART_B);
  assert.strictEqual(w.dollars_suppressed, false, 'well under a fifth by TOKEN');
  assert.ok(w.measured.saved > 0);

  const pts = store.reportTrend(rows, 'day', PART_B[0], PART_B[1]);
  assert.strictEqual(pts.length, 1);
  assert.strictEqual(pts[0].dollars_suppressed, false);
  assert.ok(pts[0].measured.saved > 0, 'the bucket keeps its figure');
  assert.strictEqual(pts[0].unpricedCalls, 1, 'and still counts the exclusion');

  const groups = store.reportBreakdown(rows, 'harness', PART_B[0], PART_B[1]);
  assert.strictEqual(groups.length, 1, 'one harness, so all three rows share a group');
  assert.strictEqual(groups[0].dollars_suppressed, false);
  assert.ok(groups[0].measured.saved > 0, 'the group keeps its figure');
  assert.strictEqual(groups[0].unpricedCalls, 1, 'and still counts the exclusion');
  assert.deepStrictEqual(groups[0].events, { measured: 3, estimated: 0 });
});

test('a WITHHELD group is never ordered as if it were a measured zero', () => {
  // `(b.measured.saved || b.estimated.saved) - (a…)` becomes `null - null` → NaN once a
  // group can withhold, and a NaN comparator is an unstable sort: the arbitrary order it
  // produces is a rendering decision made by a coercion nobody stated.
  const groups = store.reportBreakdown(SUPPRESSED_ROWS, 'served', PART_B[0], PART_B[1]);
  assert.deepStrictEqual(groups.map((g) => g.key),
    ['claude-haiku-4-5', 'no-such-model-xyz'],
    'the group that states a figure ranks above the one that declines');
});

test('reportWindow `events` is ADDITIVE over a partition, with unpriceable rows on both '
   + 'sides', () => {
  // Before the fix this identity held vacuously for unpriceable rows: they contributed 0
  // to every window. Each half now carries a real one.
  const t = Date.UTC(2026, 7, 5, 12, 0, 0);
  const rows = [
    ev({ id: 'rid:a1', ts: Date.UTC(2026, 4, 4, 9), pday: '2026-05-04' }),
    ev({ id: 'rid:a2', ts: Date.UTC(2026, 4, 5, 9), pday: '2026-05-05',
         served: 'llama-4-maverick', conf: 'measured' }),
    ev({ id: 'rid:b1', ts: Date.UTC(2026, 7, 3, 9), pday: '2026-08-03', conf: 'measured' }),
    ev({ id: 'rid:b2', ts: Date.UTC(2026, 7, 4, 9), pday: '2026-08-04',
         served: 'llama-4-maverick' }),
    // `ts` died in a real merge, `pday` lived — dated by its frozen day, into half B.
    fold([ev({ id: 'rid:mc', ts: t }), ev({ id: 'rid:mc', ts: t + 1500 })]).rows[0],
    ev({ id: 'rid:orphan', ts: null, pday: null, tzo: null }),
  ];
  const [a, b, u] = [PART_A, PART_B, PART_U].map((w) => win(rows, w));
  for (const basis of ['measured', 'estimated']) {
    assert.strictEqual(a.events[basis] + b.events[basis], u.events[basis], basis);
  }
  // Non-vacuous, and byte-for-byte the numbers gateway/tests/test_reporting.py pins for
  // the identical fixture.
  assert.deepStrictEqual(a.events, { measured: 1, estimated: 1 });
  assert.deepStrictEqual(b.events, { measured: 1, estimated: 2 });
  assert.deepStrictEqual(u.events, { measured: 2, estimated: 3 });
  assert.strictEqual(a.unpricedCalls, 1);
  assert.strictEqual(b.unpricedCalls, 1);
  // The row placeable NOWHERE is in NO window's `events` and is named in `undated` by
  // every one of them — the identity is not bought by hiding it.
  assert.deepStrictEqual([a, b, u].map((w) => w.undated), [1, 1, 1]);

  // …and the ladder still sums to an INDEPENDENTLY computed lifetime on this field.
  const ladder = store.reportLadder(rows, Date.UTC(2026, 7, 6, 15), 'UTC', { state: COVERED });
  const lifetime = store.reportWindow(rows, null, null, { state: COVERED });
  for (const basis of ['measured', 'estimated']) {
    assert.strictEqual(ladder.reduce((s, w) => s + w.events[basis], 0),
      lifetime.events[basis], `${basis}.events`);
  }
  assert.deepStrictEqual(lifetime.events, { measured: 2, estimated: 3 });
});

test('a `pday` that names NO DAY is refused by the pricer, and counted in exactly one '
   + 'place on every surface', () => {
  // `read_segment` validates only that a line is a JSON dict at or below SCHEMA_V, so a
  // hand-edited, corrupted or third-party-written segment reaches the pricer. `deriveRow`
  // used to test only that `pday` was TRUTHY, so "2026-13-45" was PRICED while the window
  // rule could place it on no day at all: its dollars showed up in the lifetime fold and
  // in no window, no group, no bucket and no exclusion counter.
  for (const bad of ['2026-13-45', '2026-02-30', 20260410, '0000-01-01', ' 2026-08-05']) {
    const d = deriveRow(ev({ pday: bad }));
    assert.strictEqual(d.priceable, false, `pday ${JSON.stringify(bad)} must not price`);
    assert.strictEqual(d.reason, 'undated');
    assert.strictEqual(d.delta, null, 'null, not 0 — "no claim" is not "$0.00"');
  }
  // …and a real day still prices, so the refusal above is a narrowed domain and not a
  // broken function.
  assert.ok(deriveRow(ev({ pday: '0001-01-01' })).priceable, 'year 1 is a real ISO day');
  assert.ok(deriveRow(ev({ pday: '2026-08-05' })).priceable);

  const good = ev({ id: 'rid:good' });
  const bad = ev({ id: 'rid:bad', ts: null, pday: '2026-13-45' });
  const rows = [good, bad];
  const saved = foldRows([good]).estimated.saved;
  assert.ok(saved > 0);

  // The two readings of the SAME rows agree — they did not: foldRows priced the malformed
  // row and the window rule excluded it from everywhere, so the two differed by its
  // dollars with nothing naming the gap.
  assert.ok(Math.abs(foldRows(rows).estimated.saved - saved) < 1e-9);
  assert.ok(Math.abs(win(rows, PART_B).estimated.saved - saved) < 1e-9);
  assert.ok(Math.abs(store.reportWindow(rows, null, null, { state: COVERED })
    .estimated.saved - saved) < 1e-9, 'lifetime agrees with the fold');

  // It contributes no dollars anywhere, and it is COUNTED once on each surface.
  assert.strictEqual(win(rows, PART_B).undated, 1);
  assert.strictEqual(
    store.reportBreakdown(rows, 'served', PART_B[0], PART_B[1])
      .reduce((s, g) => s + g.unpricedCalls, 0), 1);
  const pts = store.reportTrend(rows, 'day', PART_B[0], PART_B[1]);
  assert.deepStrictEqual(pts.map((p) => p.bucket), ['2026-08-05', 'undated']);
  assert.strictEqual(pts[1].unpricedCalls, 1);
  assert.strictEqual(pts[1].estimated.calls, 0, 'it enters NEITHER accumulator');
});

test('a `ts` nulled by a merge never asserts coverage around the EPOCH', () => {
  // impliedCoverage mapped `Number(r.ts)`, and Number(null) is 0, so a row whose instant
  // died in a merge claimed "we were watching" for a day either side of 1970-01-01.
  const row = ev({ id: 'rid:mc', ts: null });
  assert.deepStrictEqual(store.impliedCoverage([row]), []);
  assert.strictEqual(store.impliedCoverage([ev({ ts: 0 })]).length, 1,
    'an EXPLICIT epoch timestamp is a real instant and still counts');
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

// ---- state.json is a READ-MODIFY-WRITE, and it is the one file that holds DELETIONS ----
//
// `coverage[]`, `tombstones[]` and `ingested_files[]` all live in one JSON document that
// every mutator rewrites WHOLE. Unserialised, two mutators interleave and the second one
// to write puts back a document that never saw the first one's object:
//
//   A: loadState()      → { coverage: [c1], tombstones: [] }
//   B: loadState()      → { coverage: [c1], tombstones: [] }
//   B: addTombstone(t)  → saveState({ coverage: [c1],     tombstones: [t] })
//   A: addCoverage(c2)  → saveState({ coverage: [c1, c2], tombstones: []  })   ← t is GONE
//
// The lost object is a TOMBSTONE — the record that a user asked for a chat to be excluded
// from every total — so losing it silently RE-ADMITS data the user deleted and the totals
// simply go back up. (The race window is narrower than it first looks: tagline.js returns
// before its coverage write when the session delta is empty, so the Stop hook does not
// write coverage on every assistant turn. A narrow window is still a window.)

const { spawn } = require('child_process');

const STORE_MODULE = path.join(__dirname, '..', 'src', 'peek', 'store.js');

// Two REAL processes, because that is the only way this store is ever concurrent: the
// Stop hook, `cheaper forget`, `cheaper import` and the gateway are separate programs.
// An in-process fake would serialise itself on the event loop and prove nothing.
const MUTATOR_WORKER = `
'use strict';
const store = require(process.argv[2]);
const role = process.argv[3];
const n = Number(process.argv[4]);
let ok = 0;
for (let i = 0; i < n; i++) {
  const r = role === 'tombstone'
    ? store.addTombstone({ session: role + '-' + i, events_removed: 1, from: i, to: i + 1 })
    // A DISTINCT harness per interval, so addCoverage's adjacency merge cannot fold two
    // of them together and make a lost write look like a successful merge.
    : store.addCoverage('observed', 1e9 + i * 1e4, 1e9 + i * 1e4 + 5e3, 'h' + i);
  if (r) ok++;
}
process.stdout.write(String(ok));
`;

function runWorker(script, evDir, role, n) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, STORE_MODULE, role, String(n)], {
      env: Object.assign({}, process.env, { CHEAPER_EVENTS_DIR: evDir }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { err += b; });
    p.on('close', (code) => resolve({ code, ok: Number(out), err }));
  });
}

test('CONCURRENT MUTATORS: a coverage write can never erase a tombstone', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-lock-'));
  const evDir = path.join(d, 'events');
  fs.mkdirSync(evDir, { recursive: true });
  const script = path.join(d, 'mutator.js');
  fs.writeFileSync(script, MUTATOR_WORKER);

  const N = 40;
  const [tomb, cov] = await Promise.all([
    runWorker(script, evDir, 'tombstone', N),
    runWorker(script, evDir, 'coverage', N),
  ]);
  assert.strictEqual(tomb.code, 0, tomb.err);
  assert.strictEqual(cov.code, 0, cov.err);
  // Every mutation that REPORTED success must be on disk — a `true` that did not persist
  // is the same lie one level up.
  assert.strictEqual(tomb.ok, N, 'a tombstone write reported failure');
  assert.strictEqual(cov.ok, N, 'a coverage write reported failure');

  const raw = JSON.parse(fs.readFileSync(path.join(evDir, 'state.json'), 'utf8'));
  assert.strictEqual(raw.tombstones.length, N,
    `${N - raw.tombstones.length} tombstone(s) were erased by the interleaved coverage `
    + 'writer — every one of them re-admits a chat the user deleted');
  assert.strictEqual(raw.coverage.length, N, 'and no coverage interval was lost either');
  // The lock is released, not leaked: the next mutation must not have to break it.
  assert.ok(!fs.existsSync(path.join(evDir, 'state.json.lock')),
    'the lock file outlived its holders');
  fs.rmSync(d, { recursive: true, force: true });
});

test('a lock left behind by a dead process is broken, not waited on forever', () => {
  withStore(() => {
    const store = require('../src/peek/store');
    fs.mkdirSync(path.dirname(store.stateLockPath()), { recursive: true });
    // A pid above every pid this OS can mint: process.kill(pid, 0) answers ESRCH, so the
    // holder is provably gone. Without a liveness test a crashed `cheaper forget` would
    // wedge every later write behind a file nobody holds.
    fs.writeFileSync(store.stateLockPath(),
      JSON.stringify({ pid: 4194304, at: Date.now() }));
    const t0 = Date.now();
    assert.strictEqual(store.addTombstone({ session: 'after-crash' }), true);
    assert.ok(Date.now() - t0 < 5000, 'it waited out the staleness window instead of '
      + 'testing the holder for liveness');
    assert.strictEqual(store.loadState().tombstones.length, 1);
  });
});

// ---- an UNREADABLE state.json is a THIRD case, not the absent one --------------------

test('a CORRUPT state.json refuses to report — it never reads as "no tombstones"', () => {
  withStore((d) => {
    const store = require('../src/peek/store');
    const evDir = path.join(d, 'events');
    fs.mkdirSync(evDir, { recursive: true });
    store.addCoverage('observed', Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1));
    store.addTombstone({ session: 's1', events_removed: 12,
                         from: Date.UTC(2026, 7, 3), to: Date.UTC(2026, 7, 4) });
    const good = fs.readFileSync(store.statePath(), 'utf8');
    assert.ok(JSON.parse(good).tombstones.length === 1, 'fixture sanity');

    // The shape a torn or interrupted write leaves behind. `JSON.parse` throws on it, and
    // the old catch-all turned that into an EMPTY state — so the report went out with the
    // deleted session's events silently counted back in, and nothing on the page said so.
    fs.writeFileSync(store.statePath(), good.slice(0, Math.floor(good.length / 2)));

    const st = store.loadState();
    assert.strictEqual(st.unreadable, 'unparseable');
    assert.notStrictEqual(st.unreadable, undefined);
    assert.ok(!st.tooNew, 'it is corrupt, not from the future — the two are different');
    const w = store.reportWindow([ev()], Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1), {});
    assert.strictEqual(w.status, 'suppressed');
    assert.deepStrictEqual(w.labels, ['state_unreadable']);
    assert.strictEqual(w.measured, null);
    assert.strictEqual(w.estimated, null);
    assert.match(w.notes.join(' '), /tombstones/);

    // …and a mutator may not overwrite it. The file may still be recoverable by hand, and
    // writing an "empty" document over it makes the deletion loss permanent — the same
    // posture ledger.js takes for a forward-incompatible lifetime.json.
    assert.strictEqual(store.addCoverage('observed', 0, 1), false);
    assert.strictEqual(store.addTombstone({ session: 's2' }), false);
    assert.strictEqual(store.mutateState((s) => { s.tombstones.push({}); }), false);
    assert.strictEqual(fs.readFileSync(store.statePath(), 'utf8'),
      good.slice(0, Math.floor(good.length / 2)), 'the damaged file was overwritten');
  });
});

test('the three dispositions of state.json are told APART: absent, unreadable, too new', () => {
  withStore((d) => {
    const store = require('../src/peek/store');
    const evDir = path.join(d, 'events');
    fs.mkdirSync(evDir, { recursive: true });

    // ABSENT is the only benign one: nothing was ever declared, so nothing is missing,
    // and impliedCoverage still speaks for the events themselves.
    const absent = store.loadState();
    assert.strictEqual(absent.unreadable, undefined);
    assert.strictEqual(absent.tooNew, undefined);
    assert.notStrictEqual(
      store.reportWindow([ev()], Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1), {}).status,
      'suppressed', 'an absent state file must not suppress a window full of real events');

    // A JSON document that parses but is not a state document. `typeof null` is 'object'
    // and an array is an object too, so both used to sail through the old `j && typeof j
    // === 'object'` guard or fall into the same silent fresh start.
    for (const [body, why] of [['null', 'not_an_object'], ['[]', 'not_an_object'],
                               ['{', 'unparseable'], ['', 'unparseable']]) {
      fs.writeFileSync(store.statePath(), body);
      assert.strictEqual(store.loadState().unreadable, why,
        `state.json containing ${JSON.stringify(body)}`);
    }

    // TOO NEW keeps its own distinct label — a refusal for a different reason, needing a
    // different answer from the person at the terminal (`npm i -g cheaper`, not a repair).
    fs.writeFileSync(store.statePath(), JSON.stringify({ v: 99, coverage: [], tombstones: [] }));
    assert.strictEqual(store.loadState().tooNew, true);
    assert.strictEqual(store.loadState().unreadable, undefined);
    assert.deepStrictEqual(
      store.reportWindow([ev()], -Infinity, Infinity, {}).labels, ['store_newer_than_reader']);
  });
});

// ---- durability: the bytes, and then the NAME ---------------------------------------

// Record the ORDER of the syscalls that decide durability. `store.js` captured the `fs`
// module object at require time, so patching its properties is observed by the code under
// test at call time — no injection seam, and nothing about the production path changes.
function traceFs(fn) {
  const real = {
    openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync,
    renameSync: fs.renameSync, unlinkSync: fs.unlinkSync,
  };
  const fdPath = new Map();
  const trace = [];
  fs.openSync = function (p, ...rest) {
    const fd = real.openSync(p, ...rest);
    fdPath.set(fd, String(p));            // fds are REUSED, so the map must be kept exact
    return fd;
  };
  fs.closeSync = function (fd) { fdPath.delete(fd); return real.closeSync(fd); };
  fs.fsyncSync = function (fd) {
    trace.push(['fsync', fdPath.get(fd) || String(fd)]);
    return real.fsyncSync(fd);
  };
  fs.renameSync = function (a, b) { trace.push(['rename', String(b)]); return real.renameSync(a, b); };
  fs.unlinkSync = function (p) { trace.push(['unlink', String(p)]); return real.unlinkSync(p); };
  try { fn(trace); } finally { Object.assign(fs, real); }
  return trace;
}

test('saveState fsyncs the tmp BEFORE the rename and the directory AFTER it', () => {
  withStore((d) => {
    const store = require('../src/peek/store');
    const evDir = path.join(d, 'events');
    fs.mkdirSync(evDir, { recursive: true });
    const target = store.statePath();

    const trace = traceFs(() => {
      assert.strictEqual(store.saveState({ v: 1, coverage: [], tombstones: [],
                                           ingested_files: [] }), true);
    });
    // Only the state write is on trial; the lock file's own open/unlink is noise here.
    const steps = trace.filter(([, p]) => p === target || p.startsWith(target + '.')
      || p === evDir);
    const kinds = steps.map(([k, p]) => k + ' ' + (p === evDir ? 'DIR'
      : (p === target ? 'FINAL' : 'TMP')));
    // `writeFileSync` returns once the bytes are in the PAGE CACHE. Renaming on top of
    // that is ATOMIC (a reader sees the old document or the new one) but not DURABLE: a
    // crash can leave the rename applied and the contents never flushed, i.e. a state.json
    // of zeros — which loadState now refuses out loud rather than reading as "no
    // tombstones". And the rename publishes a NAME, which lives in the DIRECTORY, so
    // fsyncing the file alone does not make the name durable either.
    assert.deepStrictEqual(kinds, ['fsync TMP', 'rename FINAL', 'fsync DIR'], kinds.join(' | '));
    assert.deepStrictEqual(fs.readdirSync(evDir).filter((n) => n.endsWith('.tmp')), [],
      'a tmp file was left behind');
  });
});

test('a state write that cannot land returns false and leaves the old document intact', () => {
  withStore((d) => {
    const store = require('../src/peek/store');
    const evDir = path.join(d, 'events');
    fs.mkdirSync(evDir, { recursive: true });
    assert.strictEqual(store.addTombstone({ session: 'keep-me' }), true);
    const before = fs.readFileSync(store.statePath(), 'utf8');

    // A directory where the tmp file has to go: openSync(tmp, 'w') fails with EISDIR, so
    // the write never reaches the rename. The claim must come back FALSE — `cheaper
    // forget` prints "excluded from every total" off this boolean.
    fs.mkdirSync(`${store.statePath()}.${process.pid}.tmp`, { recursive: true });
    try {
      assert.strictEqual(store.addTombstone({ session: 'lost' }), false);
      assert.strictEqual(fs.readFileSync(store.statePath(), 'utf8'), before,
        'a failed write must not truncate or replace the document it could not update');
    } finally {
      fs.rmSync(`${store.statePath()}.${process.pid}.tmp`, { recursive: true, force: true });
    }
    assert.strictEqual(store.loadState().tombstones.length, 1);
  });
});

test('`cheaper forget` never claims a deletion it did not persist', () => {
  withStore((d) => {
    const evDir = path.join(d, 'events');
    fs.mkdirSync(evDir, { recursive: true });
    // A state.json from a newer Cheaper: addTombstone refuses it, and the command used to
    // print "N event(s) excluded from every total" anyway. Telling a user their chat is
    // gone when it is not is the same lie as a total that quietly shrinks, pointing the
    // other way — and it is worse, because they stop looking.
    fs.writeFileSync(path.join(evDir, 'state.json'),
      JSON.stringify({ v: 99, coverage: [], tombstones: [] }));
    const events = require('../src/peek/events');
    events.append([ev({ id: 'rid:forgetme', sess: 'gone', sessions: ['gone'] })], 'cli');

    const { forget } = require('../src/forget');
    const lines = [];
    const realLog = console.log;
    const realCode = process.exitCode;
    console.log = (...a) => lines.push(a.join(' '));
    try { forget(['--session', 'gone']); } finally { console.log = realLog; }
    const out = lines.join('\n');
    assert.ok(!/excluded from every total/.test(out),
      'it announced a deletion that never reached the disk:\n' + out);
    assert.match(out, /NOT written/);
    assert.strictEqual(process.exitCode, 1);
    process.exitCode = realCode;
    // …and the newer file is untouched.
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(evDir, 'state.json'), 'utf8')).v, 99);
  });
});
