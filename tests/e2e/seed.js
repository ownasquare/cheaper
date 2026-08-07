'use strict';
// Build a deterministic, fully isolated sandbox for the Playwright suite.
//
// NOTHING here touches the developer's real ~/.cheaper. Every store the gateway reads
// is redirected by env var, and the whole tree is rebuilt from scratch on each run so a
// screenshot comparison can never drift because yesterday's data is still present.
//
// The seed is chosen to exercise the cases that are easy to get WRONG, not just the
// happy path:
//   * events in four different ladder windows, so the disjoint partition is visible
//   * a promo-window claude-sonnet-5 row dated 2026-08-31 23:30 -07:00
//   * an UNPRICEABLE served model — must render an em dash, never $0.00
//   * a non-2xx row — recorded, never priced
//   * a NEGATIVE delta (fable-5 served against an opus-5 baseline)
//   * both measurement bases present, so the two-column treatment has something to show
//   * a legacy chat-grain row, so the third visual state renders

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SANDBOX = path.join(REPO, '.playwright-tmp');

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

function ev(over) {
  const base = {
    v: 1, rev: 1, w: 'cli', inst: 'e2e00001',
    tzo: 0, prov: 'transcript', usrc: 'body', conf: 'estimated',
    harness: 'claude-code', sub: true,
    served: 'claude-haiku-4-5', req: null, base: 'claude-opus-5',
    bsrc: 'tx_session_ceiling', elig: true, ctier: 'haiku', cver: 3, reason: '',
    in: 120000, out: 8000, cr: 450000, c5: 12000, c1: 0, cu: 0,
    speed: null, svc: 'standard', status: 200,
    sfile: 'a71c3f9e0b42', sbase: 'agent-ac0bf522.jsonl', fsha: '9a41c0d7e2', vok: true,
  };
  const e = Object.assign(base, over);
  e.pday = new Date(e.ts + e.tzo * 60000).toISOString().slice(0, 10);
  e.ingested_at = e.ts + 1000;
  if (!e.sessions) e.sessions = [e.sess || 'sess-e2e-1'];
  if (!e.sess) e.sess = e.sessions[0];
  if (!e.id) e.id = 'rid:' + crypto.createHash('sha256')
    .update(String(e.ts) + e.served + e.sess + String(e.in) + String(e.out))
    .digest('hex').slice(0, 24);
  return e;
}

// `now` is pinned by the caller so the ladder windows are reproducible run to run.
function buildEvents(now) {
  const DAY = 86400000;
  const rows = [];

  // --- Today: a normal routed sub-agent call, plus one kept main-loop turn. --------
  rows.push(ev({ ts: now - 3 * 3600000, sess: 'sess-today-1' }));
  rows.push(ev({ ts: now - 2 * 3600000, sess: 'sess-today-1',
                 served: 'claude-opus-5', elig: false, ctier: 'opus', sub: false,
                 in: 40000, out: 3000, cr: 900000, c5: 30000 }));
  // A MEASURED row — the gateway observed it from a response body. Rendered in its own
  // column, never added to the estimated ones.
  rows.push(ev({ ts: now - 90 * 60000, sess: 'sess-today-1', prov: 'gateway',
                 conf: 'measured', req: 'claude-opus-5', reason: 'simple lookup',
                 served: 'claude-haiku-4-5', in: 900, out: 1200, cr: 210000, c5: 0 }));

  // --- Earlier this week ------------------------------------------------------------
  for (let i = 1; i <= 3; i++) {
    rows.push(ev({ ts: now - i * DAY - 5 * 3600000, sess: 'sess-week-' + i,
                   in: 60000 + i * 1000, out: 4000 + i * 100, cr: 300000 }));
  }
  // A NEGATIVE delta: routed work that cost MORE than the baseline. The sign must
  // survive to the screen; a max(0, …) anywhere would hide it.
  rows.push(ev({ ts: now - 2 * DAY - 3600000, sess: 'sess-week-neg',
                 served: 'claude-fable-5', base: 'claude-opus-5', ctier: 'opus',
                 in: 200000, out: 40000, cr: 0, c5: 0 }));

  // --- Earlier this month -----------------------------------------------------------
  for (let i = 8; i <= 12; i++) {
    rows.push(ev({ ts: now - i * DAY, sess: 'sess-month-' + i,
                   served: 'claude-sonnet-5', ctier: 'sonnet',
                   in: 30000, out: 9000, cr: 800000, c5: 20000 }));
  }

  // --- Edge cases -------------------------------------------------------------------
  // UNPRICEABLE served model: the cell must be an em dash with a tooltip, NEVER $0.00.
  rows.push(ev({ ts: now - 4 * DAY, sess: 'sess-unpriced',
                 served: 'some-unreleased-model-x9', ctier: 'sonnet' }));
  // Non-2xx: recorded, never priced. Claude Code retries automatically and each retry
  // gets a distinct provider id, so the key cannot collapse them.
  rows.push(ev({ ts: now - 5 * DAY, sess: 'sess-429', status: 429 }));
  // ---- the timezone-frame regression, as live data --------------------------------
  //
  // The catalog carries claude-sonnet-5 at a promotional $2/$10 from 2026-01-01 through
  // 2026-08-31, against a standard $3/$15. The defect was that pricing resolved on the
  // UTC date while the calendar bucketed on LOCAL midnight, so a call could be priced
  // in one month and reported in another — a live ±50% error on 1M-in/1M-out.
  //
  // BOTH boundaries are seeded, because they fail in OPPOSITE directions and a fixture
  // that only covers one proves half the fix:
  //
  //   window START — local 2025-12-31 23:30 -07:00 is UTC 2026-01-01 06:30.
  //     LOCAL day (2025-12-31) is OUTSIDE the promo -> correct price is $18.00.
  //     A UTC-based implementation reads 2026-01-01, inside it, and charges $12.00.
  //     This one is in the PAST, so it always runs.
  //
  //   window END — local 2026-08-31 23:30 -07:00 is UTC 2026-09-01 06:30.
  //     LOCAL day is INSIDE the promo -> correct price is $12.00; UTC reads September
  //     and charges $18.00. Seeded only once that instant has passed, since a
  //     future-dated row is (correctly) quarantined by the skew guard.
  const promoStartTs = Date.parse('2025-12-31T23:30:00-07:00');
  rows.push(ev({ ts: promoStartTs, tzo: -420, sess: 'sess-promo-before',
                 served: 'claude-sonnet-5', base: 'claude-opus-5', ctier: 'sonnet',
                 in: 1000000, out: 1000000, cr: 0, c5: 0 }));
  const promoEndTs = Date.parse('2026-08-31T23:30:00-07:00');
  if (Number.isFinite(promoEndTs) && promoEndTs < now) {
    rows.push(ev({ ts: promoEndTs, tzo: -420, sess: 'sess-promo',
                   served: 'claude-sonnet-5', base: 'claude-opus-5', ctier: 'sonnet',
                   in: 1000000, out: 1000000, cr: 0, c5: 0 }));
  }
  // Last year, so "Before this year" is not an empty row.
  rows.push(ev({ ts: now - 400 * DAY, sess: 'sess-old', in: 20000, out: 2000, cr: 100000 }));

  return rows;
}

function seed(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  rmrf(SANDBOX);
  const home = path.join(SANDBOX, 'home');
  const eventsDir = path.join(home, '.cheaper', 'events');
  fs.mkdirSync(eventsDir, { recursive: true, mode: 0o700 });

  // --- the per-call event store ---------------------------------------------------
  const rows = buildEvents(now);
  const byMonth = new Map();
  for (const r of rows) {
    const d = new Date(r.ts);
    const ym = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    const w = r.prov === 'gateway' ? 'gw' : 'cli';
    const key = `${ym}.e2e00001.${w}.jsonl`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(r);
  }
  for (const [name, rs] of byMonth) {
    fs.writeFileSync(path.join(eventsDir, name),
      rs.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  }

  // Coverage, WITH A DELIBERATE GAP.
  //
  // Two intervals, not one: an old backfilled island around the 400-day-old event, and
  // the recent observed run. Everything between them — most of this calendar year — is
  // genuinely NOT COVERED, which is the state the product must be able to express and
  // must never render as "$0.00 saved". A single from-earliest-to-latest interval would
  // declare the whole year watched and make that path untestable.
  const ts = rows.map((r) => r.ts).sort((a, b) => a - b);
  const oldest = ts[0];
  const newest = ts[ts.length - 1];
  // 20 days back: far enough to cover every recent fixture row, close enough that the
  // "Earlier this year" ladder window (Jan 1 → Jul 1) falls entirely OUTSIDE it and
  // reports `not_covered` — the state the suite has to be able to observe.
  const recentStart = now - 20 * 86400000;
  fs.writeFileSync(path.join(eventsDir, 'state.json'), JSON.stringify({
    v: 1,
    coverage: [
      { kind: 'backfilled', from: oldest - 3600000, to: oldest + 3600000, harness: 'claude-code' },
      { kind: 'observed', from: recentStart, to: newest + 86400000, harness: 'claude-code' },
    ],
    tombstones: [],
    ingested_files: [],
  }), { mode: 0o600 });

  // --- the legacy chat-grain store: a THIRD visual state, never summed with the two
  //     bases above. Dollars frozen, timestamp known-imprecise, no period bucket.
  fs.writeFileSync(path.join(home, '.cheaper', 'legacy_chats.json'), JSON.stringify({
    v: 1, imported_at: now,
    chats: {
      '3d0afc92-legacy-a': { usd: 3.7122, tokens: 6343704, exact: false,
                             at: new Date(now - 30 * 86400000).toISOString(),
                             derivation: 'frozen', bucket_confidence: 'unknown' },
      '8c60b680-legacy-b': { usd: 1.2044, tokens: 2110900, exact: false,
                             at: new Date(now - 31 * 86400000).toISOString(),
                             derivation: 'frozen', bucket_confidence: 'unknown' },
    },
  }), { mode: 0o600 });

  // --- the proxy's own metrics.db, so Dashboard/Monitor have live rows -------------
  const db = path.join(home, '.cheaper', 'metrics.db');
  const py = `
import os, sys, time
sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'cli', 'assets', 'gateway', 'app'))})
os.environ['CHEAPER_DB'] = ${JSON.stringify(db)}
from metrics import Metrics
m = Metrics(db_path=${JSON.stringify(db)})
now = ${Math.floor(now / 1000)}
rows = [
  ('haiku','claude-haiku-4-5','claude-opus-5','opus','simple lookup','claude-code',900,1200,200,'body','req_e2e_1',210000,0,0),
  ('haiku','claude-haiku-4-5','claude-opus-5','opus','simple lookup','claude-code',1100,900,200,'body','req_e2e_2',180000,0,0),
  ('sonnet','claude-sonnet-5','claude-opus-5','opus','moderate refactor','claude-code',30000,9000,200,'body','req_e2e_3',800000,20000,0),
  ('opus','claude-opus-5','claude-opus-5','opus','correctness-critical','claude-code',40000,3000,200,'body','req_e2e_4',900000,30000,0),
  ('haiku','claude-haiku-4-5','claude-opus-5','opus','retry storm','claude-code',0,0,429,'body','req_e2e_5',0,0,0),
  ('sonnet','claude-sonnet-5','claude-opus-5','opus','streamed, usage unknown','cursor (openai)',None,None,200,'estimate','req_e2e_6',0,0,0),
]
for i,(tier,model,om,rt,reason,src,it,ot,st,us,rid,cr,c5,c1) in enumerate(rows):
    m.record(tier=tier, model=model, original_model=om, requested_tier=rt, reason=reason,
             source=src, in_tokens=it, out_tokens=ot, status=st, usage_source=us,
             request_id=rid, cache_read=cr, cache_create_5m=c5, cache_create_1h=c1,
             session='sess-today-1', requested_effort='none', ts=now - (len(rows)-i)*300)
print('seeded', m.summary()['total'])
`;
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error('metrics.db seed failed:\n' + (r.stderr || r.stdout));
  }

  // The gateway mints dash.token itself on import; pre-create it so the Playwright
  // fixture can read a stable value without racing start-up.
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(home, '.cheaper', 'dash.token'), token, { mode: 0o600 });

  return { sandbox: SANDBOX, home, eventsDir, db, token, now, events: rows.length };
}

module.exports = { seed, SANDBOX, buildEvents };

if (require.main === module) {
  const out = seed();
  console.log(JSON.stringify(out, null, 2));
}
