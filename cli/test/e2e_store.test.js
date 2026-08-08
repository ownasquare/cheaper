'use strict';
// End-to-end: a real transcript on disk -> `cheaper peek --tagline` -> the event store
// -> `cheaper savings`, driven through the actual CLI binary in a subprocess with a
// fully isolated HOME.
//
// This is the test that would have caught the headline defect. The old ledger bucketed
// on the moment the TAGLINE RAN, so:
//   * a chat whose calls happened last week reported its savings under "today", and
//   * running the tagline twice moved money between periods.
// Both are asserted against here directly.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cheaper.js');

// A minimal but REALISTIC Claude Code transcript: a user turn, a main-loop assistant
// turn on the ceiling model, and two sub-agent turns on a cheaper model — the exact
// shape the tagline credits.
function writeFixture(dir, sessionId, whenMs) {
  const projDir = path.join(dir, 'claude', 'projects', '-tmp-fixture');
  const subDir = path.join(projDir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const iso = (ms) => new Date(ms).toISOString();

  const main = [
    { type: 'user', sessionId, timestamp: iso(whenMs),
      message: { role: 'user', content: 'Refactor this module and prove the fix.' } },
    { type: 'assistant', sessionId, timestamp: iso(whenMs + 1000),
      requestId: 'req_main_1',
      message: { id: 'msg_main_1', role: 'assistant', model: 'claude-opus-5',
                 usage: { input_tokens: 1000, output_tokens: 2000,
                          cache_read_input_tokens: 0,
                          cache_creation: { ephemeral_5m_input_tokens: 0,
                                            ephemeral_1h_input_tokens: 0 } },
                 content: [{ type: 'text', text: 'ok' }] } },
  ];
  fs.writeFileSync(path.join(projDir, sessionId + '.jsonl'),
    main.map((o) => JSON.stringify(o)).join('\n') + '\n');

  const sub = [];
  for (let i = 0; i < 2; i++) {
    sub.push({ type: 'user', sessionId, isSidechain: true, timestamp: iso(whenMs + 2000 + i),
      message: { role: 'user', content: 'find the file' } });
    sub.push({ type: 'assistant', sessionId, isSidechain: true,
      timestamp: iso(whenMs + 3000 + i), requestId: 'req_sub_' + i,
      message: { id: 'msg_sub_' + i, role: 'assistant', model: 'claude-haiku-4-5',
                 usage: { input_tokens: 1000000, output_tokens: 1000000,
                          cache_read_input_tokens: 0,
                          cache_creation: { ephemeral_5m_input_tokens: 0,
                                            ephemeral_1h_input_tokens: 0 } },
                 content: [{ type: 'text', text: 'found it' }] } });
  }
  fs.writeFileSync(path.join(subDir, 'agent-' + sessionId + '.jsonl'),
    sub.map((o) => JSON.stringify(o)).join('\n') + '\n');

  return path.join(projDir, sessionId + '.jsonl');
}

function envFor(home) {
  return Object.assign({}, process.env, {
    CHEAPER_PEEK_HOME: home,
    CHEAPER_EVENTS_DIR: path.join(home, '.cheaper', 'events'),
    CHEAPER_LEDGER_FILE: path.join(home, 'lifetime.json'),
    CHEAPER_LEGACY_FILE: path.join(home, '.cheaper', 'legacy_chats.json'),
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    // Nothing listens here, so the gateway probe fails fast and the transcript path is
    // exercised — which is the path every real user without the proxy is on.
    CHEAPER_PORT: '59998',
    CHEAPER_QUIET: '1',
  });
}

function cli(home, args) {
  const r = spawnSync(process.execPath, [CLI].concat(args),
    { env: envFor(home), encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// A moment guaranteed to land in "today"'s ladder row in the machine's OWN local
// timezone, regardless of what real wall-clock instant the suite happens to run at.
// `Date.now() - 3600000` ("an hour ago") is NOT that: it reads as today only if local
// midnight did not fall within the last hour, which is false close to a third of the
// time at TZ=Asia/Kolkata (+05:30) and TZ=Asia/Kathmandu (+05:45) relative to a
// UTC-anchored CI schedule, and is exactly the flake this helper closes. Local NOON of
// the current calendar day is maximally far from either midnight edge, so the fixture's
// timestamp and the CLI subprocess's own "today" bucket boundary -- both derived from
// the SAME real moment via the SAME inherited TZ env var -- agree by construction.
function localNoonToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0).getTime();
}

test('E2E: a transcript becomes per-call events, and the savings land on the day the '
   + 'CALLS happened — not the day the tagline ran', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-e2e-'));
  // Deliberately 9 days ago: outside "today" and outside "this week", so a tagline-time
  // bucket would put it in Today and an event-time bucket cannot.
  const when = Date.now() - 9 * 86400000;
  const sessionId = '5c74ee86-1111-2222-3333-444444444444';
  const transcript = writeFixture(home, sessionId, when);

  const t1 = cli(home, ['peek', '--tagline', '--transcript', transcript, '--format', 'plain', '--json']);
  assert.strictEqual(t1.code, 0, t1.err);
  const j1 = JSON.parse(t1.out);

  // The line itself must be real and honest.
  assert.match(j1.full, /Cheaper\.app saved/, j1.full);
  assert.match(j1.full, /claude-haiku-4-5/);
  assert.match(j1.full, /instead of claude-opus-5/);
  assert.match(j1.full, /about \$/, 'a transcript estimate must carry the "about" hedge');

  // …and the store must have taken the events.
  assert.ok(j1.events, 'the tagline must emit per-call events');
  assert.strictEqual(j1.events.written, 3, 'one row per priced call: 1 main + 2 sub-agent');
  assert.strictEqual(j1.events.reason, 'first');

  // ---- the headline assertion --------------------------------------------------
  const s1 = JSON.parse(cli(home, ['savings', '--json']).out);
  const byKey = Object.fromEntries(s1.ladder.map((w) => [w.key, w]));
  // Today is UNCOVERED (the chat is nine days old), which is reported as a labelled
  // non-number — null with a `not_covered` label — and never as $0.00.
  assert.strictEqual(byKey.today.status, 'not_covered', 'nothing happened today');
  assert.strictEqual(byKey.today.estimated, null);
  assert.ok(byKey.today.labels.includes('not_covered'));
  const older = byKey.month_earlier.estimated || byKey.quarter_earlier.estimated
    || byKey.week_earlier.estimated;
  assert.ok(older && older.calls === 3,
    'all three calls must bucket into the window that actually contains their timestamps');
  assert.ok(older.saved > 0, 'and carry a real, positive saving');

  // The ladder is a PARTITION: its rows sum to lifetime, exactly.
  const sumCalls = s1.ladder.reduce((n, w) => n + ((w.estimated && w.estimated.calls) || 0), 0);
  assert.strictEqual(sumCalls, s1.lifetime.estimated.calls);
  assert.ok(Math.abs(
    s1.ladder.reduce((n, w) => n + ((w.estimated && w.estimated.saved) || 0), 0)
    - s1.lifetime.estimated.saved) < 1e-9);
});

test('E2E: re-running the tagline is IDEMPOTENT — no new events, no moved money', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-e2e2-'));
  const when = Date.now() - 9 * 86400000;
  const sessionId = 'aaaaaaaa-1111-2222-3333-555555555555';
  const transcript = writeFixture(home, sessionId, when);

  cli(home, ['peek', '--tagline', '--transcript', transcript, '--format', 'plain', '--json']);
  const before = JSON.parse(cli(home, ['savings', '--json']).out);

  // Run it four more times, exactly as the Stop hook does on every assistant turn.
  let lastEvents = null;
  for (let i = 0; i < 4; i++) {
    const r = JSON.parse(cli(home, ['peek', '--tagline', '--transcript', transcript,
      '--format', 'plain', '--json']).out);
    lastEvents = r.events;
  }
  assert.strictEqual(lastEvents.written, 0,
    'a 200-turn chat must not append ~8,000 lines to represent 40 events');
  assert.strictEqual(lastEvents.reason, 'no-op');

  const after = JSON.parse(cli(home, ['savings', '--json']).out);
  assert.strictEqual(after.lifetime.estimated.calls, before.lifetime.estimated.calls,
    'replaying the tagline must not mint new calls');
  assert.ok(Math.abs(after.lifetime.estimated.saved - before.lifetime.estimated.saved) < 1e-9,
    'and must not move or duplicate a single cent');
  // The old ledger bucketed on tagline-run time, so this exact sequence moved the
  // chat's entire savings into "today". It must not.
  const today = after.ladder.find((w) => w.key === 'today');
  assert.ok(!today.estimated || !today.estimated.calls,
    're-running an old chat\'s tagline must not move its money into today');
});

test('E2E: `cheaper logs --terminal` renders the register, and `--json` is machine-clean', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-e2e3-'));
  const sessionId = 'bbbbbbbb-1111-2222-3333-666666666666';
  const transcript = writeFixture(home, sessionId, Date.now() - 3600000);
  cli(home, ['peek', '--tagline', '--transcript', transcript, '--format', 'plain', '--json']);

  const j = JSON.parse(cli(home, ['logs', '--json']).out);
  assert.strictEqual(j.rows.length, 3);
  for (const r of j.rows) {
    // basis + grain are NON-HIDEABLE and present on every row and in every export.
    assert.ok(['measured', 'estimated'].includes(r.basis));
    assert.strictEqual(r.grain, 'call');
    assert.ok(r.base && r.served);
    // No dollar figure may be 0 as a stand-in for "unpriceable".
    if (r.unpriced_reason) assert.strictEqual(r.delta_usd, null);
  }
  const txt = cli(home, ['logs', '--terminal']).out;
  assert.match(txt, /Baseline → Served/);
  assert.match(txt, /claude-opus-5 → claude-haiku-4-5/);

  // `cheaper reports --json` must expose the two bases separately and never a combined
  // top-level total.
  const rep = JSON.parse(cli(home, ['reports', '--json']).out);
  assert.ok(Array.isArray(rep.periods) && rep.periods.length === 6);
  for (const w of rep.periods) {
    assert.ok(!('saved' in w), 'no combined accumulator may appear on a period row');
  }
});

test('E2E: `cheaper import --dry-run` previews without writing, then the real run is '
   + 'idempotent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-e2e4-'));
  const sessionId = 'cccccccc-1111-2222-3333-777777777777';
  writeFixture(home, sessionId, Date.now() - 20 * 86400000);
  const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);

  const dry = JSON.parse(cli(home, ['import', '--since', since, '--dry-run', '--json']).out);
  assert.ok(dry.totals.events > 0, 'the preview must find the transcript');
  assert.strictEqual(dry.totals.written, 0, 'a dry run writes NOTHING');
  const empty = JSON.parse(cli(home, ['savings', '--json']).out);
  assert.strictEqual(empty.store.rows, 0);

  const real = JSON.parse(cli(home, ['import', '--since', since, '--json']).out);
  assert.strictEqual(real.totals.written, dry.totals.events);
  const after = JSON.parse(cli(home, ['savings', '--json']).out);
  assert.ok(after.store.rows > 0);

  // Re-running must be a no-op: the per-file ledger records {sfile,size,mtime}.
  const again = JSON.parse(cli(home, ['import', '--since', since, '--json']).out);
  assert.strictEqual(again.totals.filesNew, 0, 'every file is already recorded as ingested');
  assert.strictEqual(again.totals.written, 0);
  const after2 = JSON.parse(cli(home, ['savings', '--json']).out);
  assert.strictEqual(after2.lifetime.estimated.calls, after.lifetime.estimated.calls,
    'a re-import must not double a single call');
});

test('E2E: `cheaper forget` drops a session WITH a stated reason', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-e2e5-'));
  const sessionId = 'dddddddd-1111-2222-3333-888888888888';
  // Pinned to local noon today (not `Date.now() - 3600000`) so the fixture lands in
  // "today"'s ladder row -- and the assertion below agrees with it -- in every
  // timezone. See `localNoonToday()`.
  const transcript = writeFixture(home, sessionId, localNoonToday());
  cli(home, ['peek', '--tagline', '--transcript', transcript, '--format', 'plain', '--json']);

  const t = JSON.parse(cli(home, ['forget', '--session', sessionId, '--json']).out);
  assert.strictEqual(t.kind, 'tombstone');
  assert.strictEqual(t.events_removed, 3);

  const s = JSON.parse(cli(home, ['savings', '--json']).out);
  const today = s.ladder.find((w) => w.key === 'today');
  assert.ok(today.labels.includes('tombstoned'),
    'the drop must be STATED, not silent');
  assert.match(today.notes.join(' '), /cheaper forget/);
});
