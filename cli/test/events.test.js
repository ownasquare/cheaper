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

// A normalized adapter record, for the tests that must go through the REAL writer
// (`counterfactual.sessionFrame` → `emit.eventsFromRecords` → `events.deltaFor`) rather
// than through hand-built rows. The eligibility RULE is a property of the session frame,
// so a synthetic row cannot exercise the rule flip at all.
const REC_TS = Date.UTC(2026, 7, 5, 12, 0, 0);
function rec(over) {
  return Object.assign({
    harness: 'claude-code', sessionId: 's-rule', ts: REC_TS, tzo: 0,
    model: 'claude-opus-5', source: 'user', sub: false,
    inFresh: 100000, outTokens: 20000, cacheRead: 0,
    cacheCreate5m: 0, cacheCreate1h: 0, cacheCreate: 0, estimated: true,
    requestId: null, messageId: null,
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

test('a batch straddling a UTC month boundary is filed by EACH ROW\'S OWN month', () => {
  withDir(() => {
    const events = require('../src/peek/events');
    // One chat, one append, two months. `emit.js` sorts a session ASCENDING by ts, so
    // the OLDEST row leads the batch — deriving one segment path from `rows[0]` filed
    // the September calls into the August file.
    const aug = Date.UTC(2026, 7, 31, 23, 50, 0);
    const sep = Date.UTC(2026, 8, 1, 0, 10, 0);
    const r = events.append([ev({ id: 'rid:aug', ts: aug, pday: '2026-08-31' }),
                             ev({ id: 'rid:sep', ts: sep, pday: '2026-09-01' })], 'cli');
    assert.strictEqual(r.written, 2);
    assert.strictEqual(r.torn, false);

    const segs = events.listSegments();
    assert.deepStrictEqual(segs.map((s) => s.ym).sort(), ['2026-08', '2026-09'],
      'a month boundary inside one batch must open one fd per month');
    const byYm = new Map(segs.map((s) => [s.ym, s.file]));
    const augRows = []; events.readSegment(byYm.get('2026-08'), (o) => augRows.push(o));
    const sepRows = []; events.readSegment(byYm.get('2026-09'), (o) => sepRows.push(o));
    assert.deepStrictEqual(augRows.map((o) => o.id), ['rid:aug']);
    assert.deepStrictEqual(sepRows.map((o) => o.id), ['rid:sep']);

    // THE MONEY-VISIBLE CONSEQUENCE, not just tidy filing: `readAll` skips an
    // out-of-range segment BY ITS FILENAME MONTH, so a September window never opened the
    // August file and the September calls inside it left the total with no label.
    const { rows } = events.readAll({ sinceMs: Date.UTC(2026, 8, 15) });
    assert.deepStrictEqual(rows.map((o) => o.id), ['rid:sep'],
      'the September row must survive a September window');
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

// Put `file` into the state "this process cannot read the bytes", and return an undo.
//
// chmod 000 is the real-world cause (a restore that lost the mode bits, a hostile umask,
// a half-synced file) and is what this test wants to assert on. It is NOT enforced for
// uid 0, so when the suite runs as root the same state is produced by swapping the file
// for a DIRECTORY of the same name — read(2) fails with EISDIR for every uid. Same
// counter under test either way; nothing is skipped and no assertion is softened.
function makeUnreadable(file) {
  const body = fs.readFileSync(file);
  fs.chmodSync(file, 0o000);
  try {
    fs.readFileSync(file);
  } catch {
    return () => fs.chmodSync(file, 0o600);
  }
  fs.chmodSync(file, 0o600);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  return () => { fs.rmdirSync(file); fs.writeFileSync(file, body, { mode: 0o600 }); };
}

test('a segment whose bytes cannot be read is COUNTED, not reported as an empty month', () => {
  withDir(() => {
    const events = require('../src/peek/events');
    events.append([ev(), ev({ id: 'rid:req_2' })], 'cli');
    const seg = events.listSegments()[0].file;
    const undo = makeUnreadable(seg);
    try {
      const { rows, stats } = events.readAll();
      assert.strictEqual(rows.length, 0);
      // `segments` is incremented before the read is attempted, so without a counter of
      // its own an unopenable segment reads as "1 segment, 0 rows" — byte-identical to a
      // genuinely quiet month. A truncated read must never pass for a complete one.
      assert.strictEqual(stats.segments, 1);
      assert.strictEqual(stats.unreadable, 1, 'the failure to read must be VISIBLE');
      assert.strictEqual(stats.corrupt, 0, 'nothing here was corrupt — only unreadable');
    } finally { undo(); }
    // Non-vacuous: the same segment, readable again, really does carry two rows.
    assert.strictEqual(events.readAll().rows.length, 2);
  });
});

test('a truncated sealed segment is COUNTED as corrupt, not as a sealed empty month', () => {
  withDir(() => {
    const events = require('../src/peek/events');
    const zlib = require('zlib');
    const dir = process.env.CHEAPER_EVENTS_DIR;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const whole = zlib.gzipSync(Buffer.from(JSON.stringify(ev()) + '\n', 'utf8'));
    // `cheaper compact` verifies a sealed segment before unlinking its sources, so this
    // is damage that arrived AFTER sealing — a truncated restore, a torn sync.
    fs.writeFileSync(path.join(dir, '2026-08.sealed.jsonl.gz'),
      whole.subarray(0, whole.length - 6), { mode: 0o600 });
    const { rows, stats } = events.readAll();
    assert.strictEqual(rows.length, 0);
    assert.strictEqual(stats.segments, 1);
    assert.strictEqual(stats.corrupt, 1, 'a gzip that does not inflate must be NAMED');
    assert.strictEqual(stats.unreadable, 0, 'its bytes were readable; its contents were not');
  });
});

// ---- which writer a segment NAME attributes itself to ---------------------------------

test('segmentWriter reads the writer off the name, and refuses to invent one', () => {
  const events = require('../src/peek/events');
  assert.strictEqual(events.segmentWriter('2026-08.a1b2c3d4.cli.jsonl'), 'cli');
  assert.strictEqual(events.segmentWriter('2026-08.a1b2c3d4.gw.jsonl'), 'gw');
  assert.strictEqual(events.segmentWriter('2026-08.cli.jsonl'), 'cli');   // pre-install-id
  assert.strictEqual(events.segmentWriter('2026-08.gw.jsonl'), 'gw');
  // A sealed month is the MERGE of that month's cli AND gw segments. It cannot be
  // attributed to either, and the old `/\.gw\.jsonl(\.gz)?$/i ? 'gw' : 'cli'` answered
  // 'cli' for it — an else branch producing a confident wrong attribution.
  assert.strictEqual(events.segmentWriter('2026-08.a1b2c3d4.sealed.jsonl.gz'), null);
  assert.strictEqual(events.segmentWriter('2026-08.sealed.jsonl.gz'), null);
  assert.strictEqual(events.segmentWriter('nonsense.jsonl'), null);
  // A sync client inserts its marker before the LAST extension, which the anchored
  // `\.gw\.jsonl$` test also missed — and the glob in listSegments deliberately READS
  // these files, so they were read and then mis-attributed.
  assert.strictEqual(events.segmentWriter('2026-08.a1b2c3d4.gw (conflicted copy).jsonl'), 'gw');
  assert.strictEqual(events.segmentWriter('2026-08.a1b2c3d4.cli (1).jsonl'), 'cli');
});

test('a gw row inside a SEALED month is never read back as writer cli', () => {
  withDir(() => {
    const events = require('../src/peek/events');
    const zlib = require('zlib');
    const dir = process.env.CHEAPER_EVENTS_DIR;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A gateway-origin row that carries no `w` of its own, sealed into a month by
    // `cheaper compact`. `readAll` falls back to the SEGMENT's writer for exactly this
    // row, so the segment's answer is the row's answer.
    const row = ev({ id: 'rid:gwrow', prov: 'gateway' });
    delete row.w;
    fs.writeFileSync(path.join(dir, '2026-08.a1b2c3d4.sealed.jsonl.gz'),
      zlib.gzipSync(Buffer.from(JSON.stringify(row) + '\n', 'utf8')), { mode: 0o600 });

    const segs = events.listSegments();
    assert.strictEqual(segs.length, 1);
    assert.strictEqual(segs[0].writer, null,
      'a sealed segment holds BOTH writers; naming one of them is a guess');
    const { rows } = events.readAll();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]._w, null,
      'an unknown writer must be a labelled non-answer, never a confident "cli"');
  });
});

test('a row that carries its OWN writer still wins over the segment name', () => {
  withDir(() => {
    const events = require('../src/peek/events');
    const zlib = require('zlib');
    const dir = process.env.CHEAPER_EVENTS_DIR;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, '2026-08.a1b2c3d4.sealed.jsonl.gz'),
      zlib.gzipSync(Buffer.from(JSON.stringify(ev({ id: 'rid:1', w: 'gw' })) + '\n'
        + JSON.stringify(ev({ id: 'rid:2', w: 'cli' })) + '\n', 'utf8')), { mode: 0o600 });
    const { rows } = events.readAll();
    assert.deepStrictEqual(rows.map((r) => [r.id, r._w]).sort(),
      [['rid:1', 'gw'], ['rid:2', 'cli']],
      'the null segment writer must not erase a writer the row states itself');
  });
});

// ---- the install id, when it cannot be persisted --------------------------------------

// `fsutil.HOME` is a module-level const read at REQUIRE time, so a home swap has to happen
// before the module loads — which means a child process, not an env tweak in-band.
const EVENTS_JS = path.join(__dirname, '..', 'src', 'peek', 'events.js');
const ID_PROBE = `
  const e = require(${JSON.stringify(EVENTS_JS)});
  const path = require('path');
  const a = e.installIdInfo();
  const b = e.installIdInfo();
  console.log(JSON.stringify({ a, b, seg: path.basename(e.segmentPath('cli', Date.UTC(2026, 7, 5))) }));
`;

function probeInstallId(home, extraEnv) {
  const r = require('child_process').spawnSync(process.execPath, ['-e', ID_PROBE], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CHEAPER_PEEK_HOME: home }, extraEnv || {}),
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return { json: JSON.parse(r.stdout), stderr: r.stderr };
}

test('an install id that cannot be persisted is STABLE, not a fresh one per run', () => {
  const home = tmpdir('instid');
  // `~/.cheaper/install.json` exists as a DIRECTORY: read(2) fails EISDIR and write(2)
  // fails EISDIR, for every uid including root — the same construction the unreadable
  // segment test uses, and for the same reason.
  fs.mkdirSync(path.join(home, '.cheaper', 'install.json'), { recursive: true });

  const one = probeInstallId(home);
  const two = probeInstallId(home);
  assert.strictEqual(one.json.a.source, 'derived', JSON.stringify(one.json));
  assert.match(one.json.a.id, /^[0-9a-f]{8}$/);
  assert.strictEqual(one.json.a.id, one.json.b.id, 'unstable inside a single process');

  // THE ACTUAL HARM. The id is part of every segment's NAME, so a fresh random id per run
  // did not merely lose the synced-home guarantee — it wrote ONE SEGMENT FILE PER
  // INVOCATION, and the Stop hook fires on every assistant turn. The old comment claimed a
  // non-persisted id "still writes a valid, dedupable segment", which was true of the rows
  // and false of the directory.
  assert.strictEqual(one.json.a.id, two.json.a.id,
    'a machine that cannot persist its install id must not mint a new one every run');
  assert.strictEqual(one.json.seg, two.json.seg,
    'one segment FILE per invocation is the failure this id exists to prevent');
  assert.match(one.stderr, /install\.json could not be written/,
    'the degradation must be stated, not silent');
  // …but never from the Stop hook, whose stderr is the user's chat and which runs on
  // every single turn.
  assert.doesNotMatch(probeInstallId(home, { CHEAPER_FROM_HOOK: '1' }).stderr,
    /install\.json could not be written/);
});

test('a writable home still mints and then reuses a RANDOM id — the fallback is narrow', () => {
  const home = tmpdir('instid-ok');
  const one = probeInstallId(home);
  assert.strictEqual(one.json.a.source, 'minted', JSON.stringify(one.json));
  assert.strictEqual(one.json.b.source, 'persisted', 'the mint must reach the disk');
  assert.strictEqual(one.stderr, '', 'a healthy home must warn about nothing');
  const two = probeInstallId(home);
  assert.strictEqual(two.json.a.source, 'persisted');
  assert.strictEqual(two.json.a.id, one.json.a.id);
  // Non-vacuous: a random id really is random, so the derived fallback above was not
  // simply the same value every home would have produced anyway.
  const other = probeInstallId(tmpdir('instid-ok2'));
  assert.notStrictEqual(other.json.a.id, one.json.a.id);
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

test('a session that acquires its FIRST sub-agent restates the WHOLE session', () => {
  withDir(() => {
    const events = require('../src/peek/events');
    const { eventsFromRecords } = require('../src/peek/emit');
    const { fold } = require('../src/peek/reconcile');
    const meta = { harness: 'claude-code', sessionId: 's-rule', prov: 'transcript',
                   writer: 'cli' };

    // Turn 1 — no sub-agent anywhere, so `sessionFrame.routedAware` is false and
    // eligible means "not on the ceiling model": the haiku turn is credited.
    const turn1 = [
      rec({ requestId: 'req_1' }),
      rec({ requestId: 'req_2', ts: REC_TS + 60000, model: 'claude-haiku-4-5' }),
    ];
    const a = eventsFromRecords(turn1, meta);
    assert.deepStrictEqual(a.map((e) => e.elig), [false, true]);
    assert.ok(a.every((e) => e.erule === 'off_ceiling'));
    const d1 = events.deltaFor('claude-code', 's-rule', a);
    assert.strictEqual(d1.emit.length, 2);
    assert.strictEqual(events.append(d1.emit, 'cli').written, 2);
    events.writeCursor('claude-code', 's-rule', d1.cursor);

    // Turn 2 — the first sub-agent appears. `sessionFrame` SWAPS the rule for the whole
    // session: eligible now means "was a sub-agent", so req_2 is no longer credited.
    // Neither `base` (a sub-agent never enters the ceiling pool) nor the HEAD row's
    // `elig` moves, which is exactly why fingerprinting the verdict alone missed this.
    const turn2 = turn1.concat([
      rec({ requestId: 'req_3', ts: REC_TS + 120000, model: 'claude-haiku-4-5',
            source: 'subagent', sub: true }),
    ]);
    const b = eventsFromRecords(turn2, meta);
    assert.strictEqual(b[0].base, a[0].base, 'the ceiling did NOT move');
    assert.strictEqual(b[0].elig, a[0].elig, 'and the head row\'s verdict did NOT move');
    assert.deepStrictEqual(b.map((e) => e.elig), [false, false, true]);

    const d2 = events.deltaFor('claude-code', 's-rule', b);
    assert.strictEqual(d2.reason, 'restated',
      'a rule flip is a restatement, not a tail append');
    assert.strictEqual(d2.emit.length, 3, 'the WHOLE session, not just the new row');
    assert.ok(d2.emit.every((e) => e.rev === 2));
    assert.strictEqual(events.append(d2.emit, 'cli').written, 3);
    events.writeCursor('claude-code', 's-rule', d2.cursor);

    // What is actually ON DISK must now speak with ONE rule. Without the restatement
    // req_2 survives at its highest rev still carrying `elig: true` from the OLD rule,
    // sitting next to req_3's `elig: true` from the NEW one — two incompatible
    // eligibility rules frozen into one session, and a call credited twice over.
    const { rows } = fold(events.readAll().rows);
    assert.strictEqual(rows.length, 3);
    const rules = [...new Set(rows.map((r) => r.erule))];
    assert.deepStrictEqual(rules, ['routed'], 'a fold must see exactly one rule');
    assert.deepStrictEqual(rows.filter((r) => r.elig).map((r) => r.id), ['rid:req_3'],
      'only the sub-agent is eligible under the rule the session ended on');

    // And a third Stop with nothing new still writes NOTHING.
    assert.strictEqual(events.deltaFor('claude-code', 's-rule', b).reason, 'no-op');
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
