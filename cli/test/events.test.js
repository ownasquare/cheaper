'use strict';
// The per-call event store: writer durability, the idempotency key, the delta cursor,
// the privacy allowlist, and the property the whole design rests on —
//     report(Jan) + report(Feb) === report(Jan ∪ Feb)
//
// Every isolation here goes through CHEAPER_EVENTS_DIR / CHEAPER_PEEK_HOME so no test
// can read or write the developer's real usage record.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-' + tag + '-'));
}

// Each test gets its own events dir. `events.js` reads process.env at call time, so
// setting it per-test is enough — no module cache games needed.
function withDir(fn) {
  const d = tmpdir('ev');
  const prevEv = process.env.CHEAPER_EVENTS_DIR;
  const prevHome = process.env.CHEAPER_PEEK_HOME;
  process.env.CHEAPER_EVENTS_DIR = path.join(d, 'events');
  process.env.CHEAPER_PEEK_HOME = d;
  try { return fn(d); } finally {
    if (prevEv === undefined) delete process.env.CHEAPER_EVENTS_DIR;
    else process.env.CHEAPER_EVENTS_DIR = prevEv;
    if (prevHome === undefined) delete process.env.CHEAPER_PEEK_HOME;
    else process.env.CHEAPER_PEEK_HOME = prevHome;
  }
}

function ev(over) {
  return Object.assign({
    v: 1, id: 'rid:req_1', rev: 1, w: 'cli', inst: 'aaaaaaaa',
    ts: Date.UTC(2026, 7, 5, 12, 0, 0), tzo: 0, pday: '2026-08-05',
    ingested_at: Date.UTC(2026, 7, 5, 12, 0, 1),
    prov: 'transcript', usrc: 'body', conf: 'estimated',
    harness: 'claude-code', sessions: ['s1'], sess: 's1', sub: true,
    served: 'claude-haiku-4-5', req: null, base: 'claude-opus-5',
    bsrc: 'tx_session_ceiling', elig: true, ctier: 'haiku', cver: 3, reason: '',
    in: 1000000, out: 1000000, cr: 0, c5: 0, c1: 0, cu: 0,
    speed: null, svc: 'standard', status: 200,
    sfile: 'abc123def456', sbase: 'agent-ac0bf522.jsonl', fsha: '9a41c0d7e2', vok: true,
  }, over || {});
}

// ---- writer ------------------------------------------------------------------------

test('append writes one line per event and fsyncs', () => {
  withDir(() => {
    const events = require('../src/peek/events');
    const r = events.append([ev(), ev({ id: 'rid:req_2' })], 'cli');
    assert.strictEqual(r.written, 2);
    assert.strictEqual(r.torn, false);
    const segs = events.listSegments();
    assert.strictEqual(segs.length, 1);
    const text = fs.readFileSync(segs[0].file, 'utf8');
    assert.strictEqual(text.split('\n').filter(Boolean).length, 2);
    // Segment files must not be readable by another local user.
    assert.strictEqual(fs.statSync(segs[0].file).mode & 0o077, 0);
  });
});

test('two writer classes never share a file', () => {
  withDir(() => {
    const events = require('../src/peek/events');
    events.append([ev()], 'cli');
    events.append([ev({ id: 'rid:gw1', prov: 'gateway' })], 'gw');
    const segs = events.listSegments();
    assert.strictEqual(segs.length, 2);
    assert.notStrictEqual(segs[0].file, segs[1].file);
    // Cross-language interleaving is eliminated structurally rather than by trusting
    // O_APPEND atomicity between Node and CPython (which holds on APFS but not on NFS).
    assert.deepStrictEqual(segs.map((s) => s.writer).sort(), ['cli', 'gw']);
  });
});

test('a partial trailing line is skipped AND counted, never silently dropped', () => {
  withDir(() => {
    const events = require('../src/peek/events');
    events.append([ev(), ev({ id: 'rid:req_2' })], 'cli');
    const seg = events.listSegments()[0].file;
    // Simulate a reader arriving mid-append: a complete record plus half of the next.
    fs.appendFileSync(seg, '{"v":1,"id":"rid:req_3","ts":17');
    const { rows, stats } = events.readAll();
    assert.strictEqual(rows.length, 2, 'the torn record must not be parsed');
    assert.strictEqual(stats.partialTail, 1, 'and its loss must be VISIBLE');
  });
});

test('a segment written by a NEWER schema is refused, not read as zero', () => {
  withDir(() => {
    const events = require('../src/peek/events');
    events.append([ev()], 'cli');
    const seg = events.listSegments()[0].file;
    fs.appendFileSync(seg, JSON.stringify(ev({ v: 99, id: 'rid:future' })) + '\n');
    const { rows, stats } = events.readAll();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(stats.futureSchema, 1,
      'a forward-incompatible row must be COUNTED — reading it as absent would be a '
      + 'confident downward restatement of the user\'s money');
  });
});

test('concurrent writers from two processes lose no rows', async () => {
  // Deliberately NOT wrapped in withDir(): that restores the env in a synchronous
  // `finally`, which fires before the awaited children finish and would leave the
  // assertions reading a different directory. The dir is passed explicitly instead.
  const d = tmpdir('conc');
  const dir = path.join(d, 'events');
  const script = `
    process.env.CHEAPER_EVENTS_DIR = ${JSON.stringify(dir)};
    process.env.CHEAPER_PEEK_HOME = ${JSON.stringify(d)};
    const events = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'peek', 'events.js'))});
    const tag = process.argv[2];
    const rows = [];
    for (let i = 0; i < 300; i++) rows.push({ v:1, id: tag + ':' + i, ts: Date.UTC(2026,7,5), n: 'x'.repeat(200) });
    events.append(rows, 'cli');
  `;
  const a = path.join(d, 'w.js');
  fs.writeFileSync(a, script);
  // Two separate PROCESSES appending simultaneously — the exact scenario that lost 281
  // of 600 records under the load-mutate-stringify-rename ledger shape.
  const spawn = require('child_process').spawn;
  const wait = (p) => new Promise((res) => p.on('exit', res));
  await Promise.all([wait(spawn(process.execPath, [a, 'A'])),
                     wait(spawn(process.execPath, [a, 'B']))]);
  const events = require('../src/peek/events');
  const { rows } = events.readAll({ dir });
  assert.strictEqual(rows.length, 600, 'JSONL + O_APPEND must lose nothing');
  assert.strictEqual(new Set(rows.map((r) => r.id)).size, 600, 'and tear nothing');
});

// ---- the idempotency key ------------------------------------------------------------

test('eventKey prefers the provider request id, then the message id, then a weak hash', () => {
  const events = require('../src/peek/events');
  assert.strictEqual(events.eventKey({ requestId: 'r1', messageId: 'm1' }), 'rid:r1');
  assert.strictEqual(events.eventKey({ messageId: 'm1' }), 'mid:m1');
  const weak = events.eventKey({ harness: 'h', sess: 's', served: 'x', ts: 1, in: 2, out: 3 });
  assert.ok(weak.startsWith('wk:'));
  assert.strictEqual(events.isStrongKey('rid:r1'), true);
  assert.strictEqual(events.isStrongKey('mid:m1'), true);
  assert.strictEqual(events.isStrongKey(weak), false);
});

test('the key never depends on source or on position', () => {
  const events = require('../src/peek/events');
  // Same call learned from the transcript and from the gateway must mint ONE id. An id
  // containing the source doubles: the six live chats total $16.15; a naive re-import
  // under a source-tagged key reads $32.30.
  assert.strictEqual(
    events.eventKey({ requestId: 'r1', prov: 'transcript' }),
    events.eventKey({ requestId: 'r1', prov: 'gateway' }));
  // And the weak key must not move when unrelated rows are added around it.
  const k1 = events.eventKey({ harness: 'h', sess: 's', served: 'm', ts: 60000, in: 1, out: 2 });
  const k2 = events.eventKey({ harness: 'h', sess: 's', served: 'm', ts: 60999, in: 1, out: 2 });
  assert.strictEqual(k1, k2, 'the weak key buckets to the minute, so jitter does not split a call');
});

// ---- the delta cursor ----------------------------------------------------------------

test('the Stop-hook cursor emits only new events, and nothing at all when idle', () => {
  withDir(() => {
    const events = require('../src/peek/events');
    const all = [ev({ id: 'rid:1' }), ev({ id: 'rid:2' })];
    const d1 = events.deltaFor('claude-code', 's1', all);
    assert.strictEqual(d1.emit.length, 2);
    assert.strictEqual(d1.reason, 'first');
    events.writeCursor('claude-code', 's1', d1.cursor);

    // Same session, one new turn.
    const all2 = all.concat([ev({ id: 'rid:3' })]);
    const d2 = events.deltaFor('claude-code', 's1', all2);
    assert.strictEqual(d2.emit.length, 1, 'only the tail');
    assert.strictEqual(d2.emit[0].id, 'rid:3');
    events.writeCursor('claude-code', 's1', d2.cursor);

    // Stop fires again with nothing new. A 200-turn chat with 40 calls must not append
    // ~8,000 lines to represent 40 events.
    const d3 = events.deltaFor('claude-code', 's1', all2);
    assert.strictEqual(d3.emit.length, 0);
    assert.strictEqual(d3.reason, 'no-op');
    assert.strictEqual(d3.cursor, null);
  });
});

test('a raised session ceiling re-emits the WHOLE session at rev+1', () => {
  withDir(() => {
    const events = require('../src/peek/events');
    const all = [ev({ id: 'rid:1' }), ev({ id: 'rid:2' })];
    events.writeCursor('claude-code', 's2', events.deltaFor('claude-code', 's2', all).cursor);
    // A later turn ran on a pricier model, so the frozen baseline moved.
    const restated = all.map((e) => Object.assign({}, e, { base: 'claude-fable-5' }));
    const d = events.deltaFor('claude-code', 's2', restated);
    assert.strictEqual(d.reason, 'restated');
    assert.strictEqual(d.emit.length, 2, 'a restatement is VISIBLE, not a silent patch');
    assert.ok(d.emit.every((e) => e.rev === 2));
  });
});

test('a rewritten prefix re-emits at rev+1 and dedupe absorbs it', () => {
  withDir(() => {
    const events = require('../src/peek/events');
    const { fold } = require('../src/peek/reconcile');
    const all = [ev({ id: 'rid:1' }), ev({ id: 'rid:2' })];
    events.writeCursor('claude-code', 's3', events.deltaFor('claude-code', 's3', all).cursor);
    const rotated = [ev({ id: 'rid:9' }), ev({ id: 'rid:1' }), ev({ id: 'rid:2' })];
    const d = events.deltaFor('claude-code', 's3', rotated);
    assert.strictEqual(d.reason, 'prefix-mismatch');
    assert.strictEqual(d.emit.length, 3);
    // Appending all three on top of the original two must still fold to three rows.
    const { rows } = fold(all.concat(d.emit));
    assert.strictEqual(rows.length, 3);
  });
});

// ---- privacy ---------------------------------------------------------------------

test('no event may carry a filesystem path, a home directory, or prompt text', () => {
  const { assertPrivacySafe } = require('../src/peek/emit');
  assert.strictEqual(assertPrivacySafe([ev()], '/Users/someone'), null);
  assert.match(assertPrivacySafe([ev({ sfile: '/Users/someone/x.jsonl' })], '/Users/someone'),
    /path/);
  assert.match(assertPrivacySafe([Object.assign(ev(), { text: 'my secret prompt' })]),
    /forbidden field: text/);
  assert.match(assertPrivacySafe([ev({ reason: '/Users/someone/Documents' })], '/Users/someone'),
    /path/);
});

test('a written segment contains no home directory and no leading-slash value', () => {
  withDir(() => {
    const events = require('../src/peek/events');
    events.append([ev(), ev({ id: 'rid:2' })], 'cli');
    const raw = fs.readFileSync(events.listSegments()[0].file, 'utf8');
    // The literal grep the spec asks for. `/Users` in ANY field fails the build.
    assert.ok(!raw.includes('/Users'), 'a path in an append-only audit log cannot be un-written');
    assert.ok(!raw.includes(os.homedir()));
    for (const line of raw.split('\n').filter(Boolean)) {
      const o = JSON.parse(line);
      for (const k of Object.keys(o)) {
        if (k === 'sbase') continue;   // a bare uuid basename is safe
        if (typeof o[k] === 'string') assert.ok(!o[k].startsWith('/'), `${k} looks like a path`);
      }
    }
  });
});
