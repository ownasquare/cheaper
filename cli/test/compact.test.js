'use strict';
// `cheaper compact` — the ONE operation in this store that deletes.
//
// Everything else here is append-only or tomb-stoned, so the worst a bug can do is
// mis-report. Compaction unlinks a month of raw segments, so a bug here loses the
// evidence itself. Two properties are on trial:
//
//   * DURABILITY, not merely atomicity. The read-back verification reads through the
//     PAGE CACHE, so without an fsync it proves the sealed bytes are right in MEMORY and
//     then deletes the only other copy of them.
//   * The sealed segment carries the INSTALL ID, like every other segment name — the
//     property that makes a synced home correct by construction (events.js's structural
//     choice #2). Without it two machines sharing a Dropbox/iCloud home compute the
//     identical target path and each seals the other's live segments out from under it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const events = require('../src/peek/events');
const { fold } = require('../src/peek/reconcile');
const { compact, segmentInstall, verifyDigest } = require('../src/forget');

function ev(over) {
  return Object.assign({
    v: 1, id: 'rid:req_1', rev: 1, w: 'cli', inst: 'aaaaaaaa',
    ts: Date.UTC(2026, 0, 5, 12, 0, 0), tzo: 0, pday: '2026-01-05',
    prov: 'transcript', usrc: 'body', conf: 'estimated',
    harness: 'claude-code', sessions: ['s1'], sess: 's1', sub: true,
    served: 'claude-haiku-4-5', req: null, base: 'claude-opus-5',
    bsrc: 'tx_session_ceiling', elig: true, ctier: 'haiku', cver: 3, reason: '',
    in: 1000, out: 1000, cr: 0, c5: 0, c1: 0, cu: 0,
    speed: null, svc: 'standard', status: 200,
  }, over || {});
}

// A month that is FINISHED whatever day the suite is run on. `compact` refuses to touch
// the month still being written, so a hard-coded literal would start failing the moment
// the wall clock reached it.
function finishedYm(back = 2) {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - back, 1))
    .toISOString().slice(0, 7);
}

function writeSegment(dir, name, rows) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path.join(dir, name);
}

// Run `compact` with the events dir pointed at a scratch directory, capturing its output
// so the suite stays readable and the --json result can be asserted on.
function runCompact(dir, argv) {
  const prevDir = process.env.CHEAPER_EVENTS_DIR;
  const prevHook = process.env.CHEAPER_FROM_HOOK;
  process.env.CHEAPER_EVENTS_DIR = dir;
  delete process.env.CHEAPER_FROM_HOOK;      // compact refuses under the Stop hook
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    compact(argv || ['--json']);
  } finally {
    console.log = realLog;
    if (prevDir === undefined) delete process.env.CHEAPER_EVENTS_DIR;
    else process.env.CHEAPER_EVENTS_DIR = prevDir;
    if (prevHook !== undefined) process.env.CHEAPER_FROM_HOOK = prevHook;
  }
  const out = lines.join('\n');
  return { out, json: (argv || ['--json']).includes('--json') ? JSON.parse(out) : null };
}

function withDir(fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-compact-'));
  try { return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

// Record the ORDER of the syscalls that decide durability. `forget.js` and `store.js`
// captured the `fs` module object at require time, so patching its properties is observed
// by the code under test at call time — no injection seam, and the production path is
// byte-identical to the one that ships.
function traceFs(fn) {
  const real = {
    openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync,
    renameSync: fs.renameSync, unlinkSync: fs.unlinkSync,
  };
  const fdPath = new Map();
  const trace = [];
  fs.openSync = function (p, ...rest) {
    const fd = real.openSync(p, ...rest);
    fdPath.set(fd, String(p));              // fds are REUSED, so the map must be kept exact
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

// ---- the sealed segment's NAME -----------------------------------------------------

test('a sealed segment carries the INSTALL ID, exactly as a live segment does', () => {
  withDir((dir) => {
    const ym = finishedYm();
    const inst = events.installId();
    writeSegment(dir, `${ym}.${inst}.cli.jsonl`,
      [ev({ id: 'rid:a' }), ev({ id: 'rid:b' })]);

    const { json } = runCompact(dir);
    assert.deepStrictEqual(json.errors, [], JSON.stringify(json.errors));
    assert.strictEqual(json.sealed.length, 1, JSON.stringify(json));
    // `${ym}.sealed.jsonl.gz` names no install, so two machines on one synced home compute
    // the IDENTICAL target and each seals the other's live segments out from under it.
    assert.strictEqual(json.sealed[0].file, `${ym}.${inst}.sealed.jsonl.gz`);
    assert.ok(fs.existsSync(path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`)));
    assert.ok(!fs.existsSync(path.join(dir, `${ym}.sealed.jsonl.gz`)),
      'the install-less name must not be written at all');
    // The sources are gone and the events survive the round trip.
    assert.ok(!fs.existsSync(path.join(dir, `${ym}.${inst}.cli.jsonl`)));
    const { rows } = events.readAll({ dir });
    assert.deepStrictEqual(rows.map((r) => r.id).sort(), ['rid:a', 'rid:b']);
  });
});

test('another install\'s segments are LEFT ALONE, and the fact is reported', () => {
  withDir((dir) => {
    const ym = finishedYm();
    const inst = events.installId();
    // A second machine on the same synced home. Its id differs from ours by construction.
    const other = inst === '0123abcd' ? '0123abce' : '0123abcd';
    const mine = writeSegment(dir, `${ym}.${inst}.cli.jsonl`, [ev({ id: 'rid:mine' })]);
    const theirs = writeSegment(dir, `${ym}.${other}.cli.jsonl`, [ev({ id: 'rid:theirs' })]);

    const { json } = runCompact(dir);
    assert.deepStrictEqual(json.errors, [], JSON.stringify(json.errors));
    // Their live segment is untouched: that machine's clock, that machine's month, and
    // it may still be appending to it.
    assert.ok(fs.existsSync(theirs), 'another install\'s live segment was deleted');
    assert.ok(!fs.existsSync(mine), 'our own segment was not sealed');
    assert.strictEqual(json.sealed.length, 1);
    assert.strictEqual(json.sealed[0].events, 1, 'their events must not be folded into ours');
    // Never a silent skip: a segment that is never compacted and a segment that was are
    // indistinguishable from the outside unless the tool says which happened.
    assert.ok(json.skipped.some((s) => s.ym === ym && /not written by this install/.test(s.why)),
      JSON.stringify(json.skipped));

    // And nothing was lost — both installs' events are still readable.
    const { rows } = events.readAll({ dir });
    assert.deepStrictEqual(rows.map((r) => r.id).sort(), ['rid:mine', 'rid:theirs']);
  });
});

test('segmentInstall reads the id off the name, and refuses to invent one', () => {
  assert.strictEqual(segmentInstall('2026-07.a1b2c3d4.cli.jsonl'), 'a1b2c3d4');
  assert.strictEqual(segmentInstall('2026-07.a1b2c3d4.sealed.jsonl.gz'), 'a1b2c3d4');
  // A pre-install-id segment, and the OLD sealed name. Neither is attributable, so
  // neither may be treated as ours and silently sealed or deleted.
  assert.strictEqual(segmentInstall('2026-07.cli.jsonl'), null);
  assert.strictEqual(segmentInstall('2026-07.sealed.jsonl.gz'), null);
  assert.strictEqual(segmentInstall('nonsense.jsonl'), null);
});

test('an unattributable segment is skipped with a reason, never sealed or deleted', () => {
  withDir((dir) => {
    const ym = finishedYm();
    // The shape a build that predates per-install names would have written.
    const old = writeSegment(dir, `${ym}.cli.jsonl`, [ev({ id: 'rid:old' })]);
    const { json } = runCompact(dir);
    assert.deepStrictEqual(json.sealed, []);
    assert.ok(fs.existsSync(old), 'an unattributable segment was deleted');
    assert.ok(json.skipped.some((s) => /not written by this install/.test(s.why)),
      JSON.stringify(json.skipped));
  });
});

// ---- durability --------------------------------------------------------------------

test('compact fsyncs the sealed file BEFORE the rename and the DIRECTORY before it '
   + 'unlinks the sources', () => {
  withDir((dir) => {
    const ym = finishedYm();
    const inst = events.installId();
    const src = writeSegment(dir, `${ym}.${inst}.cli.jsonl`,
      [ev({ id: 'rid:a' }), ev({ id: 'rid:b' })]);
    const outPath = path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`);

    let json = null;
    const trace = traceFs(() => { json = runCompact(dir).json; });
    assert.strictEqual(json.sealed.length, 1, JSON.stringify(json));

    const label = (p) => (p === dir ? 'DIR'
      : p === outPath ? 'SEALED'
        : p === outPath + '.tmp' ? 'TMP'
          : p === src ? 'SOURCE' : null);
    const steps = trace.map(([k, p]) => [k, label(p)]).filter(([, l]) => l !== null)
      .map(([k, l]) => k + ' ' + l);

    // `writeFileSync` returns as soon as the bytes are in the page cache, and the
    // read-back verify reads them straight back OUT of that cache — so it proved the
    // bytes were correct in MEMORY and the very next statement unlinked the only other
    // copy of them. And a rename publishes a NAME, which lives in the DIRECTORY: fsyncing
    // the file alone does not make the sealed segment reachable after a crash.
    assert.deepStrictEqual(steps,
      ['fsync TMP', 'rename SEALED', 'fsync DIR', 'unlink SOURCE', 'fsync DIR'],
      steps.join(' | '));
  });
});

test('a mid-month crash between the rename and the unlinks is RESUMABLE, and only after '
   + 'the sealed file is verified against the sources', () => {
  withDir((dir) => {
    const ym = finishedYm();
    const inst = events.installId();
    const rows = [ev({ id: 'rid:a' }), ev({ id: 'rid:b' })];
    const src = writeSegment(dir, `${ym}.${inst}.cli.jsonl`, rows);
    const outPath = path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`);

    // Seal it, then put the sources back: exactly the on-disk state a crash between the
    // rename and the unlinks leaves — the window the added fsync deliberately widens.
    runCompact(dir);
    assert.ok(fs.existsSync(outPath));
    writeSegment(dir, `${ym}.${inst}.cli.jsonl`, rows);

    const dry = runCompact(dir, ['--json', '--dry-run']).json;
    assert.ok(dry.skipped.some((s) => s.dryRun && /would remove them/.test(s.why)),
      JSON.stringify(dry.skipped));
    assert.ok(fs.existsSync(src), 'a dry run deleted a source');

    const json = runCompact(dir).json;
    assert.ok(json.skipped.some((s) => /verified sources removed/.test(s.why)),
      JSON.stringify(json.skipped));
    assert.ok(!fs.existsSync(src), 'the month can never finish compacting');
    const { rows: back } = events.readAll({ dir });
    assert.deepStrictEqual(back.map((r) => r.id).sort(), ['rid:a', 'rid:b']);
  });
});

test('a backfill into an already-sealed month is RE-SEALED, never skipped forever', () => {
  withDir((dir) => {
    const ym = finishedYm();
    const inst = events.installId();
    const outPath = path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`);
    writeSegment(dir, `${ym}.${inst}.cli.jsonl`, [ev({ id: 'rid:a' })]);
    runCompact(dir);

    // A backfill lands NEW events in an already-sealed month. Removing this segment
    // because "the month is sealed" would delete events no sealed file contains — so the
    // old code refused, and refused again on EVERY later run, with a `why` that named no
    // remedy. The month could never be compacted again and the segments accumulated.
    // The seal is now recomputed from the union of the seal and the segments, which is a
    // SUPERSET of both, so the delete stays licensed and the month stays finishable.
    const late = writeSegment(dir, `${ym}.${inst}.cli.jsonl`,
      [ev({ id: 'rid:a' }), ev({ id: 'rid:late' })]);
    const json = runCompact(dir).json;
    assert.deepStrictEqual(json.errors, [], JSON.stringify(json.errors));
    const entry = json.sealed.find((s) => s.ym === ym);
    assert.ok(entry && entry.resealed === true, JSON.stringify(json));
    assert.strictEqual(entry.sealed_before.count, 1, 'the previous seal held one event');
    assert.strictEqual(entry.sealed_after.count, 2, 'the new one must hold both');

    // THE PROPERTY THE OLD ASSERTION WAS PROTECTING — no event may be lost — asserted on
    // the events rather than on the segment file, because the file is now allowed to go
    // away precisely BECAUSE the seal accounts for it.
    assert.ok(!fs.existsSync(late), 'a source proven to be inside the seal was kept');
    const sealedOnly = [];
    events.readSegment(outPath, (o) => sealedOnly.push(o));
    assert.deepStrictEqual(sealedOnly.map((r) => r.id).sort(), ['rid:a', 'rid:late'],
      'the sealed file must contain every event whose source was removed');
    const { rows } = fold(events.readAll({ dir }).rows);
    assert.deepStrictEqual(rows.map((r) => r.id).sort(), ['rid:a', 'rid:late']);

    // And the month is FINISHED, not merely re-sealed once: a further run has nothing to
    // do and does not rewrite the file again.
    const bytes = fs.readFileSync(outPath);
    const again = runCompact(dir).json;
    assert.deepStrictEqual(again.sealed, [], JSON.stringify(again));
    assert.deepStrictEqual(again.errors, [], JSON.stringify(again.errors));
    assert.deepStrictEqual(fs.readFileSync(outPath), bytes, 'the sealed segment churned');
  });
});

test('--dry-run reports the re-seal and touches nothing', () => {
  withDir((dir) => {
    const ym = finishedYm();
    const inst = events.installId();
    const outPath = path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`);
    writeSegment(dir, `${ym}.${inst}.cli.jsonl`, [ev({ id: 'rid:a' })]);
    runCompact(dir);
    const bytes = fs.readFileSync(outPath);
    const late = writeSegment(dir, `${ym}.${inst}.cli.jsonl`,
      [ev({ id: 'rid:a' }), ev({ id: 'rid:late' })]);

    const dry = runCompact(dir, ['--json', '--dry-run']).json;
    const entry = dry.sealed.find((s) => s.ym === ym);
    assert.ok(entry && entry.dryRun && entry.resealed, JSON.stringify(dry));
    assert.strictEqual(entry.events, 2);
    assert.ok(fs.existsSync(late), 'a dry run removed a source');
    assert.deepStrictEqual(fs.readFileSync(outPath), bytes, 'a dry run rewrote the seal');
  });
});

test('a crash partway through the unlink loop — FEWER sources than the seal — resumes', () => {
  withDir((dir) => {
    const ym = finishedYm();
    const inst = events.installId();
    const rowsA = [ev({ id: 'rid:a' })];
    const rowsB = [ev({ id: 'rid:b', w: 'gw', prov: 'gateway' })];
    writeSegment(dir, `${ym}.${inst}.cli.jsonl`, rowsA);
    writeSegment(dir, `${ym}.${inst}.gw.jsonl`, rowsB);
    runCompact(dir);
    const outPath = path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`);
    assert.ok(fs.existsSync(outPath));

    // The unlink loop got through the cli segment and died before the gw one. That leaves
    // FEWER events on disk than the seal holds — which the old `sameDigest(sources, seal)`
    // test read as a disagreement and skipped forever, so the very crash the resume path
    // exists for was the one it could not finish. The union answers the right question:
    // does the seal already account for what is still here?
    const orphan = writeSegment(dir, `${ym}.${inst}.gw.jsonl`, rowsB);
    const json = runCompact(dir).json;
    assert.deepStrictEqual(json.errors, [], JSON.stringify(json.errors));
    assert.deepStrictEqual(json.sealed, [], 'nothing new to seal — this is a resume');
    assert.ok(json.skipped.some((s) => s.ym === ym && /verified sources removed/.test(s.why)),
      JSON.stringify(json.skipped));
    assert.ok(!fs.existsSync(orphan), 'the month can never finish compacting');
    const { rows } = fold(events.readAll({ dir }).rows);
    assert.deepStrictEqual(rows.map((r) => r.id).sort(), ['rid:a', 'rid:b']);
  });
});

test('a sealed segment is an OUTPUT, never folded back in as a source', () => {
  withDir((dir) => {
    const ym = finishedYm();
    const inst = events.installId();
    writeSegment(dir, `${ym}.${inst}.cli.jsonl`, [ev({ id: 'rid:a' })]);
    runCompact(dir);
    const sealedBytes = fs.readFileSync(path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`));

    // Nothing left to do, and in particular nothing to re-seal: re-reading the sealed
    // file as a source would put the same events through the digest a second time.
    const json = runCompact(dir).json;
    assert.deepStrictEqual(json.sealed, []);
    assert.deepStrictEqual(json.errors, []);
    assert.deepStrictEqual(
      fs.readFileSync(path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`)), sealedBytes,
      'the sealed segment was rewritten');
  });
});

// ---- "provably accounted for" ---------------------------------------------------
//
// THE DIGEST GATE IS SYMMETRIC UNDER "WE READ NOTHING". Its three parts — count, the six
// token sums and a sorted-id SHA-256 — all compare equal when both sides are empty, so a
// month whose sources could not be parsed sealed to an empty file, verified clean, and
// was unlinked, reporting success. `readSegment` has carried `unreadable` / `corrupt` /
// `partialTail` / `bad` / `futureSchema` counters the whole time; compaction threw the
// stats object away and kept only the rows. These tests are the caller's half of that
// contract: nothing is deleted unless every byte of every input provably became one of
// the events in the sealed file.

// Put `file` into the state "this process cannot read the bytes", and return an undo.
//
// chmod 000 is the real-world cause (a restore that lost the mode bits, a hostile umask,
// a half-synced file) and is what these tests want. It is NOT enforced for uid 0, so when
// the suite runs as root the same state is produced by swapping the file for a DIRECTORY
// of the same name — read(2) fails with EISDIR for every uid. The same counter is under
// test either way and nothing is skipped; the ONE assertion that differs is noted where it
// is made, because `unlink` on a directory fails on its own and would make "the source
// survived" vacuous. Every such test therefore ALSO asserts on the sealed file, which the
// unfixed code creates (empty) and renames into place before it ever reaches the unlink.
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

test('a source whose bytes cannot be read is never sealed away — and compact says which', () => {
  withDir((dir) => {
    const ym = finishedYm();
    const inst = events.installId();
    const src = writeSegment(dir, `${ym}.${inst}.cli.jsonl`,
      [ev({ id: 'rid:a' }), ev({ id: 'rid:b' })]);
    const outPath = path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`);

    // THE WHOLE CHAIN, and every link of it used to pass: readSegment answers 0 rows ->
    // fold([]) is 0 rows -> the digest over 0 rows -> an EMPTY sealed file -> the
    // read-back verify compares empty to empty and succeeds -> the source is unlinked ->
    // `sealed: [{ events: 0 }]`, exit 0. The only copy of two events, gone, reported as a
    // successful compaction.
    const undo = makeUnreadable(src);
    let json;
    try { json = runCompact(dir).json; } finally { undo(); }

    assert.deepStrictEqual(json.sealed, [], JSON.stringify(json));
    assert.strictEqual(json.errors.length, 1, JSON.stringify(json));
    assert.match(json.errors[0].why, /could not be fully accounted for/);
    assert.deepStrictEqual(json.errors[0].unaccounted.map((u) => u.file),
      [`${ym}.${inst}.cli.jsonl`], 'the error must NAME the file');
    assert.match(json.errors[0].unaccounted[0].why, /bytes could not be read/);
    // Non-vacuous under BOTH constructions above: the unfixed code writes and renames the
    // empty seal before it reaches any unlink, so this fails without the guard even when
    // the unlink itself could not have succeeded.
    assert.ok(!fs.existsSync(outPath), 'an EMPTY sealed segment was published');
    assert.ok(fs.existsSync(src), 'the only copy of those events was deleted');
    // And the events are still there once the file is readable again.
    const { rows } = fold(events.readAll({ dir }).rows);
    assert.deepStrictEqual(rows.map((r) => r.id).sort(), ['rid:a', 'rid:b']);
  });
});

test('a corrupt sealed .gz stops the month: the sources SURVIVE and the message names it', () => {
  withDir((dir) => {
    const ym = finishedYm();
    const inst = events.installId();
    const outPath = path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`);
    writeSegment(dir, `${ym}.${inst}.cli.jsonl`, [ev({ id: 'rid:a' })]);
    runCompact(dir);
    assert.ok(fs.existsSync(outPath));

    // Damage that arrived AFTER sealing — a truncated restore, a torn sync — plus the
    // sources back on disk, the shape a crash between the rename and the unlinks leaves.
    const whole = fs.readFileSync(outPath);
    fs.writeFileSync(outPath, whole.subarray(0, whole.length - 6), { mode: 0o600 });
    const src = writeSegment(dir, `${ym}.${inst}.cli.jsonl`, [ev({ id: 'rid:a' })]);

    const json = runCompact(dir).json;
    assert.deepStrictEqual(json.sealed, [], JSON.stringify(json));
    assert.strictEqual(json.errors.length, 1, JSON.stringify(json));
    // The old code compared a 1-row source digest against a 0-row corrupt-seal digest,
    // found them unequal, and reported `already sealed, and the remaining segments do not
    // fold to the same events` — a diagnosis that blames the segments for a broken seal
    // and offers no remedy. The seal is an INPUT to the delete decision and is now held to
    // the same standard as any other input.
    assert.deepStrictEqual(json.errors[0].unaccounted.map((u) => u.file),
      [`${ym}.${inst}.sealed.jsonl.gz`], 'the error must NAME the corrupt file');
    assert.match(json.errors[0].unaccounted[0].why, /gzip did not inflate/);
    assert.ok(fs.existsSync(src), 'the sources were removed against an unreadable seal');
    assert.ok(json.skipped.every((s) => !/do not fold to the same events/.test(s.why)),
      'the corrupt seal was still reported as a digest disagreement');
  });
});

test('a corrupt seal AND an unreadable source together do NOT unlink the month', () => {
  withDir((dir) => {
    const ym = finishedYm();
    const inst = events.installId();
    const outPath = path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`);
    writeSegment(dir, `${ym}.${inst}.cli.jsonl`, [ev({ id: 'rid:a' })]);
    runCompact(dir);
    const whole = fs.readFileSync(outPath);
    fs.writeFileSync(outPath, whole.subarray(0, whole.length - 6), { mode: 0o600 });
    const src = writeSegment(dir, `${ym}.${inst}.cli.jsonl`, [ev({ id: 'rid:a' })]);

    // THE WORST SHAPE. Both sides read as zero rows, so the two digests were IDENTICAL —
    // `sameDigest(empty, empty)` — and the resume branch unlinked the sources against a
    // sealed file that inflates to nothing at all. Both halves of the month destroyed,
    // reported as `already sealed — verified sources removed`.
    const undo = makeUnreadable(src);
    let json;
    try { json = runCompact(dir).json; } finally { undo(); }

    assert.deepStrictEqual(json.sealed, [], JSON.stringify(json));
    assert.strictEqual(json.errors.length, 1, JSON.stringify(json));
    // BOTH files are named. Telling the user only about the source sends them straight
    // back into the same broken seal on the next run.
    assert.deepStrictEqual(json.errors[0].unaccounted.map((u) => u.file).sort(),
      [`${ym}.${inst}.cli.jsonl`, `${ym}.${inst}.sealed.jsonl.gz`].sort(),
      JSON.stringify(json.errors[0]));
    assert.deepStrictEqual(json.skipped, [], JSON.stringify(json.skipped));
    assert.ok(fs.existsSync(src), 'the only remaining copy of the month was deleted');
  });
});

test('a torn tail, an unparseable line and a NEWER-schema row each stop the seal', () => {
  const cases = [
    ['a torn trailing record', '{"v":1,"id":"rid:torn","ts":17', /torn trailing record/],
    ['an unparseable line', 'not json at all\n', /unparseable line/],
    ['a newer schema', JSON.stringify(ev({ v: 99, id: 'rid:future' })) + '\n',
      /written by a NEWER Cheaper/],
  ];
  for (const [label, extra, wantWhy] of cases) {
    withDir((dir) => {
      const ym = finishedYm();
      const inst = events.installId();
      const src = writeSegment(dir, `${ym}.${inst}.cli.jsonl`, [ev({ id: 'rid:a' })]);
      fs.appendFileSync(src, extra);
      const json = runCompact(dir).json;
      // Each of these is BYTES ON DISK THAT DID NOT BECOME A ROW. Sealing the month would
      // write a file that does not contain them and then delete the file that does. The
      // future-schema case is the sharpest: those rows are perfectly good, and only THIS
      // build cannot read them — an older Cheaper compacting after an upgrade-and-roll-back
      // would silently erase everything the newer one wrote.
      assert.deepStrictEqual(json.sealed, [], `${label}: ${JSON.stringify(json)}`);
      assert.strictEqual(json.errors.length, 1, `${label}: ${JSON.stringify(json)}`);
      assert.deepStrictEqual(json.errors[0].unaccounted.map((u) => u.file),
        [`${ym}.${inst}.cli.jsonl`], label);
      assert.match(json.errors[0].unaccounted[0].why, wantWhy, label);
      assert.ok(fs.existsSync(src), `${label}: the source was deleted`);
      assert.ok(!fs.existsSync(path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`)), label);
    });
  }
});

test('a row the FOLD quarantines is never sealed away — dedupe may collapse, not drop', () => {
  withDir((dir) => {
    const ym = finishedYm();
    const inst = events.installId();
    // reconcile.js case 15: the same STRONG key whose `out` differs by more than 2x is a
    // bug in one of the writers, so BOTH halves are quarantined rather than averaged. They
    // vanish from `fold(...).rows` — and the digest is taken over the FOLDED rows, so the
    // quarantine cancelled out of both sides of the comparison and the verify passed while
    // the only evidence of the conflict was unlinked. Reporting may drop a row it cannot
    // trust; deleting the last copy of it may not.
    const src = writeSegment(dir, `${ym}.${inst}.cli.jsonl`,
      [ev({ id: 'rid:x', out: 1000 }), ev({ id: 'rid:x', out: 9000 }), ev({ id: 'rid:ok' })]);
    assert.strictEqual(fold([ev({ id: 'rid:x', out: 1000 }), ev({ id: 'rid:x', out: 9000 })])
      .rows.length, 0, 'the fixture no longer reaches the quarantine branch');

    const json = runCompact(dir).json;
    assert.deepStrictEqual(json.sealed, [], JSON.stringify(json));
    assert.strictEqual(json.errors.length, 1, JSON.stringify(json));
    assert.match(json.errors[0].why, /did not account for every source event/);
    assert.deepStrictEqual(json.errors[0].dropped_ids, ['rid:x']);
    assert.ok(fs.existsSync(src), 'the evidence of a writer conflict was deleted');
    assert.ok(!fs.existsSync(path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`)));
  });
});

test('the digest still gates the delete: a corrupted sealed file leaves the sources', () => {
  withDir((dir) => {
    // GUARD THE GUARD: none of the durability work above may weaken the verification the
    // unlink has always been conditional on.
    const ym = finishedYm();
    const inst = events.installId();
    const src = writeSegment(dir, `${ym}.${inst}.cli.jsonl`, [ev({ id: 'rid:a' })]);
    const rows = [];
    events.readSegment(src, (o) => rows.push(o));
    const digest = verifyDigest(rows);
    assert.strictEqual(digest.count, 1);

    // Make the round-trip read see a DIFFERENT event set than the digest was taken over.
    const zlib = require('zlib');
    const realGzip = zlib.gzipSync;
    zlib.gzipSync = () => realGzip(Buffer.from(JSON.stringify(ev({ id: 'rid:tampered' })) + '\n'));
    let json;
    try { json = runCompact(dir).json; } finally { zlib.gzipSync = realGzip; }

    assert.deepStrictEqual(json.sealed, []);
    assert.strictEqual(json.errors.length, 1, JSON.stringify(json));
    assert.match(json.errors[0].why, /verification failed/);
    assert.ok(fs.existsSync(src), 'the sources were deleted against a failed verification');
    assert.ok(!fs.existsSync(path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`)));
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [],
      'the rejected tmp was left behind');
  });
});
