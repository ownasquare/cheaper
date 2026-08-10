'use strict';
// gateway.js: interpreter discovery, spawn-failure handling, log permissions, the
// identity gates on start/stop/status, the foreground `serve` launcher, --port
// resolution and subcommand exit codes.
//
// Every test here covers a way `cheaper gateway <cmd>` could DO THE WRONG THING WITHOUT
// SAYING SO — by crashing with a raw stack trace, by leaving a poisoned pid file, by
// writing a secret into a world-readable log, by SIGTERMing a stranger's process after a
// reboot recycled a pid, by calling a corpse "started", or by reporting success for a
// typo'd subcommand.
//
// The module is required AFTER the environment is redirected, because paths.js reads
// os.homedir() at load time and gateway.js captures the child_process functions in the
// same way. node:test runs each file in its own process, so these module-level side
// effects are contained to this file.

const os = require('os');
const fs = require('fs');
const net = require('net');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

// --- sandbox HOME, BEFORE paths.js is loaded -------------------------------
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-gw-test-'));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;                 // os.homedir() on win32
delete process.env.CLAUDE_CONFIG_DIR;              // must not leak the real one in
// Never 8787. If an injected probe is ever forgotten, the fallback must not reach a
// gateway the developer running this suite has open on the real port — that would make
// the already-running guard's outcome depend on the machine.
process.env.CHEAPER_PORT = '18787';

const CHEAPER = path.join(SANDBOX, '.cheaper');
const GATEWAY_DIR = path.join(CHEAPER, 'gateway');
const GATEWAY_LOG = path.join(CHEAPER, 'gateway.log');
const GATEWAY_PID = path.join(CHEAPER, 'gateway.pid');

// Pre-copy the real gateway assets so start()'s freshness self-heal sees matching
// hashes and does not kick off a reinstall mid-test.
const { copyDir } = require('../src/util');
fs.mkdirSync(CHEAPER, { recursive: true });
copyDir(path.join(__dirname, '..', 'assets', 'gateway'), GATEWAY_DIR);

// --- intercept child_process BEFORE gateway.js destructures it -------------
const cp = require('child_process');
let spawnSyncStub = null;                          // (cmd, args, opts) => {status}
let spawnStub = null;                              // (cmd, args, opts) => fake child
const realSpawnSync = cp.spawnSync;
const realSpawn = cp.spawn;
cp.spawnSync = (...a) => (spawnSyncStub ? spawnSyncStub(...a) : realSpawnSync(...a));
cp.spawn = (...a) => (spawnStub ? spawnStub(...a) : realSpawn(...a));

const gateway = require('../src/gateway');

// --- helpers ---------------------------------------------------------------
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// A /healthz payload that passes the identity contract in app.py:297-313.
const OURS = Object.freeze({
  ok: true, mode: 'heuristic', upstream: 'https://api.anthropic.com', models: {},
  code_sha: 'deadbeefdeadbeef', auth_required: true, token_private: true,
});

// Scripted /healthz probe. The FIRST answer is what the already-running guard sees; the
// rest are what waitUntilServing sees. Injected everywhere so no test opens a socket.
function probeSeq(...answers) {
  let i = 0;
  return async () => {
    const v = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return v === undefined ? null : v;
  };
}

// The common case: nothing is listening, then our gateway comes up immediately.
//
// `probePortBound` is injected alongside `probeHealth` because start() now asks the
// SOCKET as well as the endpoint — a squatter that 404s answers no /healthz at all — and
// a real loopback connect would make the outcome depend on what the developer running
// this suite happens to have bound.
const startsCleanly = (extra) => Object.assign(
  { open: false, probeHealth: probeSeq(null, OURS), probePortBound: async () => false }, extra);

// The same for serve(), which now runs start()'s port guards before it spawns or records
// anything. Without injection every serve test would open a real loopback socket and its
// outcome would depend on what the developer running the suite happens to have bound —
// and on CI, on whatever else the parallel test files are listening on.
const servesCleanly = (extra) => Object.assign(
  { probeHealth: async () => null, probePortBound: async () => false }, extra);

// Let serve() reach the point where uvicorn is spawned and it is parked on the child's
// exit. It awaits two guard probes first, so "one setImmediate" is no longer a statement
// about the code — a few turns is, and costs nothing.
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// For the one call that CANNOT inject probes — gateway.run(), which takes no options — and
// therefore waits on two real loopback round trips before it spawns. Fails by name instead
// of hanging the file on a pending promise.
async function until(pred, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// NOTE: `value` is awaited BEFORE `out` is joined. An object literal evaluates its
// properties in source order, so `{ out: join(lines), value: await fn() }` reads the
// buffer while it is still empty — a silently-always-empty assertion target.
async function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  let value;
  try { value = await fn(); }
  finally { console.log = orig; }
  return { out: strip(lines.join('\n')), value };
}

// A fake detached child. `pid: undefined` is what Node really produces when the
// executable cannot be run — see the ENOENT tests below.
function fakeChild(pid) {
  const ch = new EventEmitter();
  ch.pid = pid;
  ch.unref = () => {};
  ch.kill = () => {};
  return ch;
}

// A fake child that ends by itself, for the tests where the ASSERTION is that serve()
// never spawns at all. serve() parks on the child's exit event, so a spawn stub that
// waits to be told when to exit turns a regression into a hung test file — "promise still
// pending", no message, and every later test in the file taken down with it. Ending on the
// next turn lets the refusal tests report the defect they are named for.
function exitsBySelf(ch, code = 0) {
  setImmediate(() => ch.emit('exit', code, null));
  return ch;
}

// A REAL, harmless process to stand in for a running gateway. The identity checks and
// the pid-file logic are only meaningful against a pid the OS agrees exists, and stop()
// really signals — so it must be our own child and nothing else.
const strays = [];
function dummyProcess() {
  const ch = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  strays.push(ch);
  return ch;
}
function waitExit(ch, ms = 4000) {
  return new Promise((resolve) => {
    if (ch.exitCode !== null || ch.signalCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    ch.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

// `ps` answers, as spawnSync really shapes them.
const psSays = (cmdline) => () => ({ status: 0, stdout: cmdline, stderr: '' });
const psCannotRun = () => ({ status: null, stdout: '', error: Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' }) });

// A `ps` answer that identifies the pid as our uvicorn — the state stop() is allowed to
// signal, and the one every restart test needs.
const PS_UVICORN = '/usr/bin/python3 -m uvicorn --no-access-log app:app --port 18787\n';

// A stand-in for cli/src/autostart.js. Injected rather than real wherever the assertion
// is about gateway.js's WORDS, so those assertions cannot be broken by an edit to
// autostart.js — and so nothing in this file reads or writes the developer's own
// ~/Library/LaunchAgents or runs launchctl. One test below deliberately uses the real
// module instead, to prove the lazy require is actually wired up.
const fakeAutostart = (registered) => ({
  isRegisteredOnDisk: () => registered,
  removalCommands: () => ({ cheaper: 'cheaper autostart disable', manual: 'launchctl bootout ...' }),
  makeCtx: () => ({}),
  LABEL: 'com.beladed.cheaper.gateway',
});

test.beforeEach(() => {
  spawnSyncStub = null;
  spawnStub = null;
  process.exitCode = 0;
  for (const f of [GATEWAY_PID, GATEWAY_LOG]) fs.rmSync(f, { force: true });
});

// The suite must not leave a non-zero code behind: node:test would report the whole
// FILE as failed on a process that exits 1.
test.afterEach(() => { process.exitCode = 0; });

// --------------------------------------------------------------------------
// 1. Candidate selection (P1 — Windows Python discovery)
// --------------------------------------------------------------------------

test('pyExe probes `py -3`, and passes -3 BEFORE --version', () => {
  const seen = [];
  const only = (cmd, args) => {
    seen.push([cmd, ...args].join(' '));
    return { status: cmd === 'py' ? 0 : 1 };      // the stock-Windows shape
  };
  const l = gateway.pyExe(only);
  assert.deepStrictEqual(l, { cmd: 'py', args: ['-3'] },
    'a machine where only the py launcher works must resolve to `py -3`');
  assert.deepStrictEqual(seen, ['python3 --version', 'python --version', 'py -3 --version'],
    'the launcher\'s own args must lead: `py -3 --version`, not `py --version`');
});

test('pyExe returns NULL when nothing works — never a literal name spawn() will choke on', () => {
  const l = gateway.pyExe(() => ({ status: 1 }));
  assert.strictEqual(l, null,
    'falling back to the string "python3" defers the failure to an async spawn error');
});

test('pyExe keeps the existing order: python3 wins where it exists', () => {
  assert.deepStrictEqual(gateway.pyExe(() => ({ status: 0 })), { cmd: 'python3', args: [] });
  assert.deepStrictEqual(
    gateway.pyExe((cmd) => ({ status: cmd === 'python' ? 0 : 1 })), { cmd: 'python', args: [] });
});

test('pyExe survives a probe that reports an error object instead of a status', () => {
  // spawnSync on a missing binary answers {status: null, error: ENOENT}. `r.status === 0`
  // must be the only accept condition, or a null status could read as success.
  assert.strictEqual(
    gateway.pyExe(() => ({ status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) })),
    null);
});

test('the candidate list itself contains the Windows launcher', () => {
  assert.ok(gateway.PY_CANDIDATES.some((x) => x.cmd === 'py' && x.args.join(' ') === '-3'),
    'PY_CANDIDATES must include `py -3` — it is the ONLY interpreter on a stock ' +
    'python.org Windows install with "Add to PATH" unchecked');
});

// --------------------------------------------------------------------------
// 2. A machine with no Python fails CLEANLY (P1)
// --------------------------------------------------------------------------

test('start() with no usable Python: actionable message, exit 1, nothing spawned', async () => {
  spawnSyncStub = () => ({ status: 1 });
  let spawned = false;
  spawnStub = () => { spawned = true; return fakeChild(1234); };

  const { out } = await capture(() => gateway.start([], startsCleanly()));

  assert.strictEqual(spawned, false, 'must not spawn an interpreter it knows is absent');
  assert.strictEqual(process.exitCode, 1, 'a gateway that did not start must not report success');
  assert.ok(out.includes('No usable Python 3 found'), out);
  assert.ok(/Tried: python3, python, py -3/.test(out),
    'the message must name every candidate so the user can check it\n' + out);
  assert.ok(!fs.existsSync(GATEWAY_PID), 'no pid file may be written for a gateway that never started');
});

// --------------------------------------------------------------------------
// 3. An ENOENT from spawn() is HANDLED, not thrown (P1 — the verifier's correction)
// --------------------------------------------------------------------------

test('a spawn ENOENT is reported, not re-thrown, and never poisons the pid file', async () => {
  spawnSyncStub = () => ({ status: 0 });           // the probe passed…
  spawnStub = () => {                              // …but exec fails, as Node really does:
    const ch = fakeChild(undefined);               // pid is undefined
    setImmediate(() => ch.emit('error',            // and 'error' arrives on a later tick
      Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' })));
    return ch;
  };

  const { out } = await capture(() => gateway.start([], startsCleanly()));

  assert.strictEqual(process.exitCode, 1);
  assert.ok(out.includes('could not start the gateway'), out);
  assert.ok(out.includes('ENOENT'), 'the errno belongs in the message\n' + out);
  // THE REGRESSION. `String(undefined)` is "undefined": the old code wrote that into
  // gateway.pid before the error event fired, and every later `gateway stop`/`status`
  // then parsed NaN and reported "no running gateway" on a machine that might genuinely
  // have one.
  const pid = fs.existsSync(GATEWAY_PID) ? fs.readFileSync(GATEWAY_PID, 'utf8') : null;
  assert.notStrictEqual(pid, 'undefined', 'the literal string "undefined" must never reach gateway.pid');
  assert.strictEqual(pid, null, 'no pid file at all is the right outcome here');
});

test('an error arriving AFTER a successful spawn is still handled (no unhandled event)', async () => {
  spawnSyncStub = () => ({ status: 0 });
  let child;
  spawnStub = () => { child = fakeChild(4242); return child; };

  await capture(() => gateway.start([], startsCleanly()));
  // A late failure (the process is killed, or exec fails after fork) must not take the
  // CLI down with an uncaught exception. An EventEmitter with no 'error' listener
  // re-throws; assert a listener is attached and that emitting does not throw.
  assert.ok(child.listenerCount('error') > 0, 'spawn() needs an error listener, always');
  assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('late'), { code: 'EPERM' })));
  process.exitCode = 0;
});

// --------------------------------------------------------------------------
// 4. The token must not reach the access log, and the log must not be readable (P2)
// --------------------------------------------------------------------------

test('uvicorn is spawned with --no-access-log, and the launcher args lead', async () => {
  spawnSyncStub = () => ({ status: 0 });
  let seen = null;
  spawnStub = (cmd, args, opts) => { seen = { cmd, args, opts }; return fakeChild(777); };

  await capture(() => gateway.start([], startsCleanly()));

  assert.ok(seen, 'expected a spawn');
  // The dashboard is first reached as `GET /dashboard?token=<secret>` — a browser
  // address-bar navigation with nowhere to put a header — and uvicorn's access
  // formatter logs the path WITH its query string.
  assert.ok(seen.args.includes('--no-access-log'),
    'without this flag the dashboard token is written, in clear, to gateway.log\n' +
    JSON.stringify(seen.args));
  assert.ok(seen.args.indexOf('--no-access-log') > seen.args.indexOf('uvicorn'),
    'the flag is uvicorn\'s, so it must follow the module name\n' + JSON.stringify(seen.args));
  assert.deepStrictEqual(seen.args.slice(0, 3), ['-m', 'uvicorn', '--no-access-log']);
});

test('the launcher prefix args are threaded through the uvicorn spawn', async () => {
  spawnSyncStub = (cmd) => ({ status: cmd === 'py' ? 0 : 1 });   // Windows shape
  let seen = null;
  spawnStub = (cmd, args) => { seen = { cmd, args }; return fakeChild(778); };

  await capture(() => gateway.start([], startsCleanly()));

  assert.strictEqual(seen.cmd, 'py');
  assert.deepStrictEqual(seen.args.slice(0, 4), ['-3', '-m', 'uvicorn', '--no-access-log'],
    'dropping `-3` lets the py launcher pick a Python 2 that cannot run the gateway');
});

test('gateway.log is created 0600, and an existing 0644 log is tightened', async () => {
  if (process.platform === 'win32') return;        // POSIX mode bits only

  // (a) fresh file
  spawnSyncStub = () => ({ status: 0 });
  spawnStub = () => fakeChild(779);
  await capture(() => gateway.start([], startsCleanly()));
  assert.strictEqual(fs.statSync(GATEWAY_LOG).mode & 0o777, 0o600,
    'stdout+stderr of the gateway land here; 0644 exposes them to every other account');

  // (b) a log left behind world-readable by an older version. The mode argument to
  //     open(2) applies only on CREATE, so this is the case an fchmod is needed for.
  fs.chmodSync(GATEWAY_LOG, 0o644);
  await capture(() => gateway.start([], startsCleanly()));
  assert.strictEqual(fs.statSync(GATEWAY_LOG).mode & 0o777, 0o600,
    'an already-existing 0644 log must be narrowed, not left as found');
});

// --------------------------------------------------------------------------
// 5. Subcommand exit codes (P3)
// --------------------------------------------------------------------------

test('an unknown gateway subcommand exits non-zero', async () => {
  const { out } = await capture(() => gateway.run(['statsu']));
  assert.strictEqual(process.exitCode, 1,
    'printing usage and exiting 0 tells a script the typo succeeded');
  assert.ok(out.includes('Unknown gateway subcommand: statsu'), out);
  assert.ok(out.includes('usage: cheaper gateway'), out);
});

test('a MISSING gateway subcommand also exits non-zero', async () => {
  const { out } = await capture(() => gateway.run([]));
  assert.strictEqual(process.exitCode, 1);
  assert.ok(out.includes('Missing gateway subcommand'), out);
});

test('the valid subcommands still exit 0', async () => {
  await capture(() => gateway.run(['status']));
  assert.strictEqual(process.exitCode, 0, 'status must not be caught by the new failure branch');
  await capture(() => gateway.run(['stop']));
  assert.strictEqual(process.exitCode, 0);
});

test('`serve` and `prepare` are dispatched, not treated as typos', async () => {
  // The dispatch is the whole point of P1.1: an autostart unit runs `cheaper gateway
  // serve`, and a subcommand table that does not know the name answers exit 1 — which a
  // supervisor reads as a crash and retries forever.
  spawnSyncStub = () => ({ status: 0 });
  let child = null;
  spawnStub = () => { child = fakeChild(9101); return child; };

  const p = capture(() => gateway.run(['serve']));
  // run() takes no options, so this is the one path through serve()'s REAL port guards.
  // They are two loopback round trips against 18787 — the port this sandbox picked so that
  // a forgotten injection can never reach a gateway the developer has on 8787 — and not a
  // microtask, so wait for the spawn rather than for a fixed tick.
  await until(() => child, 'run([\'serve\']) to spawn uvicorn (is something listening on 18787?)');
  child.emit('exit', 0, null);
  const { out } = await p;
  assert.ok(!out.includes('Unknown gateway subcommand'), out);
  assert.strictEqual(process.exitCode, 0);

  spawnStub = null;
  const prep = await capture(() => gateway.run(['prepare']));
  assert.ok(!prep.out.includes('Unknown gateway subcommand'), prep.out);
  assert.ok(prep.out.includes('gateway prepared'), prep.out);
});

// --------------------------------------------------------------------------
// 6. P0.3 — stop()/status() must PROVE the pid is ours before signalling it
// --------------------------------------------------------------------------
//
// gateway.pid survives a crash, a SIGKILL and a reboot; pids are reused. Without an
// identity check `cheaper gateway stop` sends SIGTERM to whatever now owns that number.

test('stop() does NOT signal a live pid that is verifiably not the gateway', async () => {
  const victim = dummyProcess();
  gateway.writePidFile(victim.pid, '18787');
  spawnSyncStub = psSays('/Applications/SomeoneElse.app/Contents/MacOS/SomeoneElse\n');

  const { out } = await capture(() => gateway.stop());

  assert.ok(!(await waitExit(victim, 400)),
    'THE BUG: a reused pid means `gateway stop` SIGTERMs an unrelated process of the user\'s');
  assert.ok(out.includes('is not the Cheaper gateway'), out);
  assert.ok(!fs.existsSync(GATEWAY_PID),
    'the pid file is provably stale, so it must be cleared — otherwise the next stop aims at the same victim');
  victim.kill('SIGKILL');
});

test('stop() DOES signal a pid that is verified as the gateway', async () => {
  // The counterweight to the test above: an identity gate that never opens is just a
  // broken `stop`, and the failure mode (a gateway you cannot stop) is the one P0.4
  // is about.
  const gw = dummyProcess();
  gateway.writePidFile(gw.pid, '18787');
  spawnSyncStub = psSays('/usr/bin/python3 -m uvicorn --no-access-log app:app --port 18787\n');

  const { out } = await capture(() => gateway.stop());

  assert.ok(await waitExit(gw), 'a verified gateway must actually be stopped');
  assert.ok(out.includes('gateway stopped'), out);
  assert.ok(out.includes('port 18787'), 'the pid file records the port, so stop can name it\n' + out);
  assert.ok(!fs.existsSync(GATEWAY_PID));
});

test('stop() with an identity check that CANNOT RUN neither signals nor clears', async () => {
  // "could not determine" is its own answer. Signalling would risk a stranger's process;
  // deleting the pid file would throw away the only record of a gateway that may be
  // running. Both are worse than saying so and exiting non-zero.
  const victim = dummyProcess();
  gateway.writePidFile(victim.pid, '18787');
  spawnSyncStub = psCannotRun;

  const { out } = await capture(() => gateway.stop());

  assert.ok(!(await waitExit(victim, 400)), 'an unverifiable pid must not be signalled');
  assert.ok(fs.existsSync(GATEWAY_PID), 'an unverifiable pid file must be KEPT, not discarded');
  assert.ok(out.includes('could not verify'), out);
  assert.strictEqual(process.exitCode, 1, 'a stop that stopped nothing must not exit 0');
  victim.kill('SIGKILL');
});

test('stop() refuses a pid <= 1 — process.kill(0) signals our own process group', async () => {
  fs.writeFileSync(GATEWAY_PID, '0\nport=18787\n');
  let probed = false;
  spawnSyncStub = () => { probed = true; return { status: 0, stdout: 'init' }; };

  const { out } = await capture(() => gateway.stop());

  assert.strictEqual(probed, false, 'a pid of 0 must be rejected before anything is inspected or signalled');
  assert.ok(out.includes('does not contain a usable pid'), out);
  assert.ok(!fs.existsSync(GATEWAY_PID));
});

test('status() reports UNKNOWN — not running, not stopped — when the check cannot run', async () => {
  const p = dummyProcess();
  gateway.writePidFile(p.pid, '18787');
  spawnSyncStub = psCannotRun;

  const { out } = await capture(() => gateway.status());

  assert.ok(out.includes('gateway: unknown'), 'a check that could not run must never render as "fine"\n' + out);
  assert.ok(!/gateway: running/.test(out), out);
  p.kill('SIGKILL');
});

test('status() calls a live-but-foreign pid STOPPED, and says why', async () => {
  const p = dummyProcess();
  gateway.writePidFile(p.pid, '18787');
  spawnSyncStub = psSays('/usr/sbin/cupsd -l\n');

  const { out } = await capture(() => gateway.status());

  assert.ok(out.includes('gateway: stopped'), out);
  assert.ok(out.includes('stale pid file'), 'liveness alone is not evidence the gateway is up\n' + out);
  p.kill('SIGKILL');
});

test('identifyPid keeps "not ours" and "could not tell" apart, and pidLooksLikeGateway fails closed', () => {
  const pid = process.pid;   // any pid > 1; the probe is injected, nothing is signalled
  assert.strictEqual(gateway.identifyPid(pid, psSays('python3 -m uvicorn app:app')).state, 'gateway');
  assert.strictEqual(gateway.identifyPid(pid, psSays('/bin/zsh')).state, 'other');
  assert.strictEqual(gateway.identifyPid(pid, psCannotRun).state, 'unknown');
  assert.strictEqual(gateway.identifyPid(pid, () => ({ status: 1, stdout: '' })).state, 'gone');
  assert.strictEqual(gateway.identifyPid(pid, () => { throw new Error('boom'); }).state, 'unknown');
  assert.strictEqual(gateway.identifyPid(1, psSays('launchd')).state, 'other',
    'pid 1 is init; signalling it is never what the user meant');
  // The boolean wrapper is the signal gate uninstall.js will import: it must answer
  // false for BOTH "not ours" and "could not tell".
  assert.strictEqual(gateway.pidLooksLikeGateway(pid, psSays('python3 -m uvicorn app:app')), true);
  assert.strictEqual(gateway.pidLooksLikeGateway(pid, psSays('/bin/zsh')), false);
  assert.strictEqual(gateway.pidLooksLikeGateway(pid, psCannotRun), false,
    'an unverifiable pid must not be treated as signalable');
});

// --------------------------------------------------------------------------
// 7. P0.4 — start() must not spawn onto a port that is already answering
// --------------------------------------------------------------------------

test('start() on an already-running gateway spawns NOTHING and leaves the pid file alone', async () => {
  // THE BUG: the second uvicorn cannot bind, dies in under a second, and start() wrote
  // its now-dead pid over the live one — then read a healthy /healthz from the FIRST
  // gateway and printed "✓ gateway started". The real gateway became unstoppable.
  fs.writeFileSync(GATEWAY_PID, '4242\nport=18787\n');
  spawnSyncStub = () => ({ status: 0 });
  let spawned = false;
  spawnStub = () => { spawned = true; return fakeChild(5555); };

  const { out, value } = await capture(() =>
    gateway.start([], { open: false, probeHealth: probeSeq(OURS) }));

  assert.strictEqual(spawned, false, 'a second uvicorn on a bound port is a corpse waiting to be mislabelled');
  assert.strictEqual(value, true, 'already-running is a success, not a failure');
  assert.strictEqual(process.exitCode, 0);
  assert.ok(out.includes('already running'), out);
  assert.strictEqual(fs.readFileSync(GATEWAY_PID, 'utf8'), '4242\nport=18787\n',
    'the live gateway\'s pid record must survive a redundant start');
});

test('start() refuses the port when something answers /healthz that is NOT our gateway', async () => {
  // A 200 on /healthz is not an identity. Any process that got to the port first can
  // answer one, and spawning into it reproduces the corpse-pid bug with an extra step.
  spawnSyncStub = () => ({ status: 0 });
  let spawned = false;
  spawnStub = () => { spawned = true; return fakeChild(5556); };

  const { out, value } = await capture(() =>
    gateway.start([], { open: false, probeHealth: probeSeq({ ok: true, service: 'someone-else' }) }));

  assert.strictEqual(spawned, false, out);
  assert.strictEqual(value, false);
  assert.strictEqual(process.exitCode, 1, 'a start that did not start must not exit 0');
  assert.ok(out.includes('NOT the Cheaper gateway'), out);
  assert.ok(!fs.existsSync(GATEWAY_PID), 'no pid file for a gateway that was never spawned');
});

test('isOurGateway demands every field of the /healthz identity contract', () => {
  assert.strictEqual(gateway.isOurGateway(OURS), true);
  assert.strictEqual(gateway.isOurGateway(JSON.stringify(OURS)), true, 'a raw body must work too');
  assert.strictEqual(gateway.isOurGateway(null), false);
  assert.strictEqual(gateway.isOurGateway('not json'), false);
  assert.strictEqual(gateway.isOurGateway({ ok: true }), false, 'a bare {ok:true} is a port squat');
  for (const [field, bad] of [
    ['ok', 'true'], ['mode', 7], ['auth_required', 'yes'], ['token_private', 1], ['code_sha', ''],
  ]) {
    const j = Object.assign({}, OURS, { [field]: bad });
    assert.strictEqual(gateway.isOurGateway(j), false,
      `${field}=${JSON.stringify(bad)} must fail the identity check — an old build that ` +
      'does not publish it is not the build being started');
  }
});

test('waitUntilServing will not accept a foreign /healthz as "our gateway is serving"', async () => {
  const t0 = Date.now();
  assert.strictEqual(await gateway.waitUntilServing('18787', 300, async () => ({ ok: true })), false,
    'without the identity check, a squatter\'s 200 is printed as a green tick for our process');
  assert.ok(Date.now() - t0 >= 250, 'it must actually spend its budget, not answer instantly');
  assert.strictEqual(await gateway.waitUntilServing('18787', 2000, async () => OURS), true);
});

test('a start whose child dies before serving ROLLS BACK the pid file', async () => {
  // The pid file is the only handle anything has on a running gateway. Overwriting it
  // with the pid of a process that never served is what made the previous gateway
  // unstoppable, so a verified-dead child must put back what was there.
  const corpse = dummyProcess();
  const deadPid = corpse.pid;
  corpse.kill('SIGKILL');
  await waitExit(corpse);

  fs.writeFileSync(GATEWAY_PID, '4242\nport=18787\n');   // the gateway that is really running
  spawnSyncStub = () => ({ status: 0 });
  spawnStub = () => fakeChild(deadPid);

  const { out, value } = await capture(() => gateway.start([], {
    open: false, serveWaitMs: 200, probeHealth: probeSeq(null, null), probePortBound: async () => false,
  }));

  assert.strictEqual(value, false);
  assert.strictEqual(process.exitCode, 1);
  assert.ok(out.includes('exited immediately'), out);
  assert.strictEqual(fs.readFileSync(GATEWAY_PID, 'utf8'), '4242\nport=18787\n',
    'the pid file must be restored to what it held before the failed start');
});

test('a start whose child is ALIVE but silent keeps the pid file and still refuses to claim success', async () => {
  // The other half of the same fork. The process is genuinely ours and genuinely alive,
  // so its pid must stay recorded (`stop` has to be able to reach it) — but nothing
  // verified that it is serving, and an unconfirmed start must not exit 0.
  const alive = dummyProcess();
  spawnSyncStub = () => ({ status: 0 });
  spawnStub = () => fakeChild(alive.pid);

  const { out, value } = await capture(() => gateway.start([], {
    open: false, serveWaitMs: 200, probeHealth: probeSeq(null, null), probePortBound: async () => false,
  }));

  assert.strictEqual(value, false);
  assert.strictEqual(process.exitCode, 1, '"could not confirm" must not read as success to a script');
  assert.ok(out.includes('could not confirm it is serving'), out);
  assert.ok(!out.includes('✓'), 'no green tick for something nothing verified\n' + out);
  assert.strictEqual(gateway.readPidFile().pid, alive.pid,
    'a live child of ours must stay recorded, or `cheaper gateway stop` can never reach it');
  alive.kill('SIGKILL');
});

// --------------------------------------------------------------------------
// 8. P1.1 — `serve` is a FOREGROUND launcher a supervisor can own
// --------------------------------------------------------------------------

test('serve() runs uvicorn in the foreground: not detached, not unref\'d, stdio inherited', async () => {
  // A supervisor supervises the process it launched. `start` detaches and returns after
  // a second or two, so launchd/systemd see the job exit and respawn it forever.
  spawnSyncStub = () => ({ status: 0 });
  let seen = null, child = null, unreffed = false;
  spawnStub = (cmd, args, opts) => {
    seen = { cmd, args, opts };
    child = fakeChild(3131);
    child.unref = () => { unreffed = true; };
    return child;
  };

  const p = capture(() => gateway.serve([], servesCleanly()));
  await tick();
  child.emit('exit', 0, null);
  await p;

  assert.ok(seen, 'expected a spawn');
  assert.notStrictEqual(seen.opts.detached, true, 'a detached child outlives the supervised launcher');
  assert.strictEqual(seen.opts.stdio, 'inherit',
    'the supervisor captures stdout/stderr; a second writer into gateway.log interleaves two services');
  assert.strictEqual(unreffed, false, 'unref() lets the launcher exit while uvicorn runs — the respawn loop');
  assert.deepStrictEqual(seen.args.slice(0, 3), ['-m', 'uvicorn', '--no-access-log'],
    'serve must run the SAME application start does, --no-access-log included');
});

test('serve() records the pid + port while it serves, and clears the record when uvicorn exits', async () => {
  // THE BUG: serve() deliberately wrote no pid file, so `cheaper gateway stop` printed
  // "No running gateway found." and `cheaper gateway status` printed "gateway: stopped"
  // against a live, serving, supervisor-managed gateway. Looks-dead-while-alive is the
  // failure this whole file exists to prevent, pointed the other way.
  spawnSyncStub = () => ({ status: 0 });
  let child = null;
  spawnStub = () => { child = fakeChild(3141); return child; };

  const p = capture(() => gateway.serve(['--port', '19001'], servesCleanly()));
  await tick();

  const rec = gateway.readPidFile();
  assert.ok(rec, 'a supervised gateway with no pid file is invisible to stop and status');
  assert.strictEqual(rec.pid, 3141,
    'the recorded pid must be the UVICORN child: identifyPid asks ps for `uvicorn app:app`, and ' +
    'this launcher is a node process that would be cleared as a stale record');
  assert.strictEqual(rec.port, '19001', 'stop/status can only name the port the pid file records');

  child.emit('exit', 0, null);
  await p;
  assert.ok(!fs.existsSync(GATEWAY_PID),
    'a stopped supervised gateway must not leave a record behind for the next status to report on');
});

test('serve() REFUSES the port a live gateway already holds — it must not claim that gateway\'s pid record', async () => {
  // THIS TEST'S OLD ASSERTION WAS THE DEFECT. It read
  //     assert.strictEqual(gateway.readPidFile().pid, 3142)   // "serve claims the file
  //                                                           //  while it holds the port"
  // and so the suite defended the clobber instead of catching it. Changing an existing
  // assertion is normally forbidden here; this is the case where it is required, because
  // the assertion asserted a bug.
  //
  // WHAT IT MISSED: serve() writes the pid file, and it had none of start()'s guards — no
  // already-running check, no bound-port check. This is the DEFAULT autostart flow: the
  // login entry runs `gateway serve`, loses the bind to a hand-started gateway, overwrites
  // that gateway's record on the way in, and deletes the file on the way out — the
  // `rec.pid === child.pid` deletion guard passing precisely because serve had just
  // written the record itself. Reviewer's reproduction:
  //     BEFORE serve — pid file: "33481\nport=8787\n"      serve exit code: 1
  //     AFTER  serve — pid file exists: false
  //     `gateway status` -> "gateway: stopped";  `gateway stop` -> "No running gateway found."
  //     the real gateway (pid 33481) is still alive: true
  // A supervisor restarts the non-zero exit, so that ran on every retry, forever.
  const live = dummyProcess();
  gateway.writePidFile(live.pid, '18787');
  spawnSyncStub = psSays(PS_UVICORN);            // ps: the recorded pid IS our uvicorn
  let spawned = false;
  // The child exits on its own. A serve() that (wrongly) spawns then parks on the exit
  // event would otherwise leave this promise pending forever, and the regression would be
  // reported as a hung file rather than as the clobber it is — verified by re-running this
  // test against a serve() with the guards removed.
  spawnStub = () => { spawned = true; return exitsBySelf(fakeChild(3142)); };

  const { out, value } = await capture(() => gateway.serve(['--port', '18787'], {
    probeHealth: async () => OURS,               // the hand-started gateway answers /healthz
    probePortBound: async () => true,            // …and holds the socket
  }));

  // The pid record is asserted FIRST, before the spawn: it is the damage, and a regression
  // should say so in the words the reviewer used rather than in a message about spawning.
  const rec = gateway.readPidFile();
  assert.ok(rec, 'the live gateway\'s pid record must still exist — deleting it is what makes it unstoppable ' +
    '(`gateway status` -> "stopped", `gateway stop` -> "No running gateway found.", process still serving)');
  assert.strictEqual(rec.pid, live.pid,
    'overwriting a live gateway\'s record hides it from `stop` and `status` while it keeps serving');
  assert.strictEqual(rec.port, '18787', 'the recorded port must survive too, or `status` cannot name it');
  assert.strictEqual(spawned, false,
    'a second uvicorn on a bound port dies on EADDRINUSE seconds later, after this launcher has ' +
    'already taken the pid file');
  assert.ok(out.includes('already serving'), out);
  assert.strictEqual(value, true);
  assert.strictEqual(process.exitCode, 0,
    'KeepAlive={SuccessfulExit:false} / Restart=on-failure restart a non-zero exit — and a respawn ' +
    'cannot bind the port either, it just re-runs this refusal every ThrottleInterval');
  live.kill('SIGKILL');
});

test('serve() refuses a port that is BOUND but silent on /healthz', async () => {
  // The already-serving guard alone cannot see this one: probeHealth() answers null for a
  // 404, a 500, an empty body and anything unparseable, so a plain dev server — or a
  // uvicorn from an earlier serve that is up but not answering yet — is indistinguishable
  // to it from a free port. This launcher would take the pid file, die on EADDRINUSE a
  // second later, and clear the record on the way out. Ask the socket, not the endpoint.
  //
  // Nothing is recorded here on purpose, so the failure this test reports is the bound-port
  // guard itself and not the pid-record guard standing in for it.
  spawnSyncStub = () => ({ status: 0 });
  let spawned = false;
  spawnStub = () => { spawned = true; return exitsBySelf(fakeChild(3144)); };

  const { out, value } = await capture(() => gateway.serve(['--port', '18787'], {
    probeHealth: async () => null,               // a 404 from the squatter: probeHealth says null
    probePortBound: async () => true,            // …but the socket accepts
  }));

  assert.strictEqual(spawned, false,
    'uvicorn spawned onto a bound port dies on EADDRINUSE seconds later — under a supervisor, once ' +
    'per restart, each time having first claimed the pid file');
  assert.ok(!fs.existsSync(GATEWAY_PID),
    'no pid record may be written for a gateway that could never bind — that record is what ' +
    'overwrites, and then deletes, the record of whatever actually holds the port');
  assert.strictEqual(value, false);
  assert.strictEqual(process.exitCode, 1, 'a serve that never bound must not report success');
  assert.ok(out.includes('does not answer /healthz'), out);
});

test('serve() refuses when the pid file already names a live, verified gateway — one record cannot describe two', async () => {
  // The other half of the guard, and the one the port check cannot cover: the requested
  // port is free, so nothing about binding stops this serve — but the pid file already
  // names a live, ps-verified gateway on ANOTHER port. Recording this one would leave that
  // one serving with its pid written down nowhere, which is exactly how `cheaper gateway
  // stop` loses a gateway (see resolvePort's two-gateways-one-pid-file note).
  const live = dummyProcess();
  gateway.writePidFile(live.pid, '18787');
  spawnSyncStub = psSays(PS_UVICORN);
  let spawned = false;
  spawnStub = () => { spawned = true; return exitsBySelf(fakeChild(3143)); };   // see above

  const { out, value } = await capture(() => gateway.serve(['--port', '19003'], servesCleanly()));

  const rec = gateway.readPidFile();
  assert.ok(rec, 'the live gateway\'s record must survive — a serve that takes it and then clears it on ' +
    'exit leaves a running gateway that `stop` cannot reach and `status` calls stopped');
  assert.strictEqual(rec.pid, live.pid, 'the live gateway must stay recorded');
  assert.strictEqual(spawned, false, 'nothing may be spawned whose pid there is no room to record');
  assert.strictEqual(value, false);
  assert.strictEqual(process.exitCode, 1, 'a serve that did not serve must not report success');
  assert.ok(out.includes('already names a live Cheaper gateway'), out);
  live.kill('SIGKILL');
});

test('serve() clears only the record it wrote itself', async () => {
  // The record belongs to whoever wrote it. Deleting another process's pid file on the
  // way out would hide a running gateway from `stop` — the same defect, one step removed.
  //
  // The prior record here names a live process that `ps` does NOT identify as a gateway,
  // so the refuse-to-clobber guard above correctly stands aside: a stale record left by a
  // recycled pid must not make the gateway unstartable.
  const other = dummyProcess();
  gateway.writePidFile(other.pid, '18787');
  spawnSyncStub = () => ({ status: 0 });         // ps: an empty command line — not our uvicorn
  let child = null;
  spawnStub = () => { child = fakeChild(3142); return child; };

  const p = capture(() => gateway.serve(['--port', '19002'], servesCleanly()));
  await tick();
  // serve claims a record that names no verified gateway…
  assert.strictEqual(gateway.readPidFile().pid, 3142,
    'a record that cannot be verified as a live gateway must not block a serve that can bind');
  // …then a DIFFERENT writer takes it over before serve exits.
  gateway.writePidFile(other.pid, '18787');
  child.emit('exit', 0, null);
  await p;

  assert.strictEqual(gateway.readPidFile().pid, other.pid,
    'serve must only clear a record that still names its own child');
  other.kill('SIGKILL');
});

test('serve() installs no deps and rewrites no files — that work belongs to `prepare`', async () => {
  // pip inside a supervisor restart loop needs the network on every respawn, takes
  // minutes, and never comes up at all on a machine that boots offline. A reinstall is
  // worse: it rewrites the files being served, per respawn.
  const calls = [];
  spawnSyncStub = (cmd, args) => { calls.push([cmd, ...(args || [])].join(' ')); return { status: 0 }; };
  let child = null;
  spawnStub = () => { child = fakeChild(3132); return child; };

  // Force the freshness check to see drift, so a reinstall would definitely happen if
  // serve() still did one.
  const drift = path.join(GATEWAY_DIR, 'app', 'zz_drift_marker.py');
  fs.writeFileSync(drift, '# not in the source tree\n');
  try {
    const p = capture(() => gateway.serve([], servesCleanly()));
    await tick();
    child.emit('exit', 0, null);
    const { out } = await p;

    assert.ok(!calls.some((x) => /\bpip\b/.test(x)),
      'serve must not run pip:\n' + calls.join('\n'));
    assert.ok(!out.includes('reinstalling first'),
      'serve must not rewrite the installed gateway under a supervisor\n' + out);
    assert.ok(fs.existsSync(drift), 'nothing in serve() may touch the installed files');
  } finally {
    fs.rmSync(drift, { force: true });
  }
});

test('prepare() is where the dependency install lives', async () => {
  // The counterweight: moving pip out of the boot path is only correct if something
  // still runs it.
  const calls = [];
  spawnSyncStub = (cmd, args) => { calls.push([cmd, ...(args || [])].join(' ')); return { status: 0 }; };

  const { out, value } = await capture(() => gateway.prepare([]));

  assert.strictEqual(value, true);
  assert.ok(calls.some((x) => /-m pip install -r .*requirements\.txt/.test(x)),
    'prepare must install the gateway deps:\n' + calls.join('\n'));
  assert.ok(out.includes('gateway prepared'), out);
});

// --- the exit-code contract ------------------------------------------------
//
//   a DELIBERATE signal (SIGTERM/SIGINT/SIGHUP) reaching this launcher  -> exit 0
//   anything else                                                       -> non-zero
//
// It is the only thing a supervisor reads. launchd's KeepAlive={SuccessfulExit:false}
// (autostart.js:367-383) and systemd's Restart=on-failure (autostart.js:557-567 — the
// unit comment; autostart.js:499-501 was a miscitation, it is registrationDarwin's
// unknown-state return) restart on non-zero and stay stopped on 0 — and both of those
// blocks carry a comment promising that a deliberate `cheaper gateway stop` is honoured.
// Reporting the shell's 128+N (143 for SIGTERM) made that promise false: the supervisor
// read a crash and brought the gateway straight back, so a supervised gateway could not be
// stopped at all.
//
// TWO paths must reach exit 0, because a deliberate stop can arrive at either process: the
// supervisor signals the LAUNCHER, and `cheaper gateway stop` signals the pid in the pid
// file, which is UVICORN's.

test('serve() forwards SIGTERM to uvicorn and exits 0 — a deliberate stop is not a crash', async () => {
  // If the launcher dies on SIGTERM while uvicorn lives on, the child keeps the port and
  // the supervisor's next restart can never bind — a stop that produces an unkillable
  // service. So the signal is still forwarded; only the reported status changes.
  spawnSyncStub = () => ({ status: 0 });
  const signals = [];
  let child = null, exited = false;
  spawnStub = () => {
    child = fakeChild(3133);
    child.on('exit', () => { exited = true; });
    child.kill = (sig) => { signals.push(sig); child.emit('exit', null, sig); };
    return child;
  };

  const p = capture(() => gateway.serve([], servesCleanly()));
  await tick();
  process.emit('SIGTERM');                       // as launchd/systemd would
  await new Promise((r) => setImmediate(r));
  const forwarded = signals.slice();
  // A launcher that swallows the signal leaves uvicorn running forever. Release it by
  // hand so THIS test reports the missing forward by name, instead of hanging and taking
  // the rest of the file down with an unrelated "promise still pending".
  if (!exited) child.emit('exit', null, 'SIGTERM');
  await p;

  assert.deepStrictEqual(forwarded, ['SIGTERM'], 'the stop signal must reach uvicorn, not stop at the launcher');
  assert.strictEqual(process.exitCode, 0,
    'a supervisor that reads 143 restarts the gateway it was just asked to stop — so ' +
    '`cheaper gateway stop` on a supervised gateway would do nothing permanent');
  assert.notStrictEqual(process.exitCode, 128 + os.constants.signals.SIGTERM,
    'the old 128+N status is exactly what launchd KeepAlive={SuccessfulExit:false} reads as a crash');
  assert.strictEqual(process.listenerCount('SIGTERM'), 0,
    'the forwarder must be removed when serve returns, or every serve() leaks a listener');
});

test('serve() forwards SIGINT and SIGHUP on the same contract', async () => {
  for (const sig of process.platform === 'win32' ? ['SIGINT'] : ['SIGINT', 'SIGHUP']) {
    spawnSyncStub = () => ({ status: 0 });
    const signals = [];
    let child = null, exited = false;
    spawnStub = () => {
      child = fakeChild(3134);
      child.on('exit', () => { exited = true; });
      child.kill = (s) => { signals.push(s); child.emit('exit', null, s); };
      return child;
    };
    const p = capture(() => gateway.serve([], servesCleanly()));
    await tick();
    process.emit(sig);
    await new Promise((r) => setImmediate(r));
    if (!exited) child.emit('exit', null, sig);
    await p;
    assert.deepStrictEqual(signals, [sig], `${sig} must reach uvicorn`);
    assert.strictEqual(process.exitCode, 0, `${sig} is a deliberate stop too — Ctrl-C is not a crash`);
    process.exitCode = 0;
  }
});

test('serve() reports uvicorn\'s own non-zero code when it exits UNASKED', async () => {
  // The other half of the contract, and the reason it cannot simply always exit 0: a
  // uvicorn that dies on its own (EADDRINUSE, a bad app import, an unhandled exception)
  // must read as a failure, or Restart=on-failure never restarts a crash and the gateway
  // stays down silently until the next login.
  spawnSyncStub = () => ({ status: 0 });
  let child = null;
  spawnStub = () => { child = fakeChild(3135); return child; };

  const p = capture(() => gateway.serve([], servesCleanly()));
  await tick();
  child.emit('exit', 3, null);
  const { value } = await p;

  assert.strictEqual(process.exitCode, 3, 'an unasked-for exit must keep uvicorn\'s status, not be flattened to 0');
  assert.strictEqual(value, false);
});

test('serve() reports 128+N when uvicorn is killed by a signal NOBODY asked this launcher for', async () => {
  // An OOM kill or an operator's `kill -9` on the child is a crash from the supervisor's
  // point of view: this process was never told to stop, so it must not claim a clean exit.
  spawnSyncStub = () => ({ status: 0 });
  let child = null;
  spawnStub = () => { child = fakeChild(3136); return child; };

  const p = capture(() => gateway.serve([], servesCleanly()));
  await tick();
  child.emit('exit', null, 'SIGKILL');
  await p;

  assert.strictEqual(process.exitCode, 128 + os.constants.signals.SIGKILL,
    'exiting 0 here would tell launchd a SIGKILLed gateway ended cleanly, and it would stay dead');
  assert.notStrictEqual(process.exitCode, 0);
});

test('serve() exits 0 when UVICORN takes the shutdown signal — that is what `cheaper gateway stop` does', async () => {
  // THE BUG, and it is on the ordinary path: stop() signals `rec.pid`, and serve() records
  // the UVICORN child (it has to — identifyPid verifies a pid by asking `ps` for
  // `uvicorn app:app`, and this launcher is a node process that would be cleared as a stale
  // record). So `cheaper gateway stop` never signals the launcher, `deliberateSignal` stays
  // null, and the launcher exited 128+15 = 143. Reviewer's reproduction:
  //     pid file: "33428\nport=8799\n"   launcher pid: 33426
  //     launcher exit code: 143   signal: null
  // 143 is exactly what launchd KeepAlive={SuccessfulExit:false} and systemd
  // Restart=on-failure read as a crash — so the gateway comes back seconds after a user
  // deliberately stopped it.
  //
  // It was masked in production only because real uvicorn traps SIGTERM and exits 0 (code 0,
  // signal null). That is a property INHERITED from uvicorn, not a contract this launcher
  // enforces, and gateway.js stated it as fact. This test pins the contract: a shutdown
  // signal killing the child is a deliberate stop no matter which process it was sent to.
  spawnSyncStub = () => ({ status: 0 });
  let child = null;
  spawnStub = () => { child = fakeChild(3137); return child; };

  const p = capture(() => gateway.serve([], servesCleanly()));
  await tick();
  // No process.emit here on purpose: `cheaper gateway stop` signals the recorded pid, which
  // is this child's. The launcher is never told anything.
  child.emit('exit', null, 'SIGTERM');
  const { value } = await p;

  assert.strictEqual(process.exitCode, 0,
    'a supervisor that reads 143 restarts the gateway `cheaper gateway stop` just stopped, and ' +
    'the user has no off switch at all');
  assert.notStrictEqual(process.exitCode, 128 + os.constants.signals.SIGTERM,
    'the shell\'s 128+N is the crash status, and this was not a crash');
  assert.strictEqual(value, true);
});

test('serve() exits 0 for a SIGINT/SIGHUP that reaches uvicorn directly, and still 128+N for a kill', async () => {
  // The counterweight to the test above: "any signal means deliberate" would be the easy
  // fix and the wrong one — it would grade an OOM kill as a clean stop and leave a crashed
  // gateway down until the next login. Only the shutdown signals count.
  for (const [sig, expected] of [['SIGINT', 0], ['SIGHUP', 0], ['SIGKILL', 128 + os.constants.signals.SIGKILL],
    ['SIGABRT', 128 + os.constants.signals.SIGABRT]]) {
    spawnSyncStub = () => ({ status: 0 });
    let child = null;
    spawnStub = () => { child = fakeChild(3138); return child; };
    const p = capture(() => gateway.serve([], servesCleanly()));
    await tick();
    child.emit('exit', null, sig);
    await p;
    assert.strictEqual(process.exitCode, expected,
      `uvicorn killed by ${sig} must exit ${expected}` +
      (expected === 0 ? ' — it is a shutdown request, not a crash'
        : ' — a crash the supervisor has to restart, not a stop it should honour'));
    process.exitCode = 0;
  }
});

// --------------------------------------------------------------------------
// 9. P3.1 — a real --port flag, and a pid file that records the port
// --------------------------------------------------------------------------

test('resolvePort precedence: --port beats CHEAPER_PORT beats 8787', () => {
  // launchd and systemd read no shell profile, so `export CHEAPER_PORT=9000` in a .zshrc
  // is visible to the human and invisible to the service — two gateways, one pid file.
  assert.deepStrictEqual(gateway.resolvePort([], {}), { port: '8787', source: 'default', error: null });
  assert.deepStrictEqual(gateway.resolvePort([], { CHEAPER_PORT: '9000' }),
    { port: '9000', source: 'CHEAPER_PORT', error: null });
  assert.deepStrictEqual(gateway.resolvePort(['--port', '9100'], { CHEAPER_PORT: '9000' }),
    { port: '9100', source: '--port', error: null });
  assert.deepStrictEqual(gateway.resolvePort(['--port=9101'], { CHEAPER_PORT: '9000' }),
    { port: '9101', source: '--port', error: null });
  // An empty CHEAPER_PORT is not a port; it must fall through, not fail.
  assert.strictEqual(gateway.resolvePort([], { CHEAPER_PORT: '  ' }).port, '8787');
});

test('an unusable port is a HARD ERROR, never a silent fall back to 8787', () => {
  for (const bad of ['0', '65536', '-1', 'abc', '8787x', '', '0x1f3']) {
    const r = gateway.resolvePort(['--port', bad], {});
    assert.strictEqual(r.port, null, `--port ${JSON.stringify(bad)} must not resolve to a port`);
    assert.ok(r.error && r.error.includes('--port'),
      'the message must name WHERE the bad value came from (a plist flag and a shell export ' +
      'are fixed in different places)');
  }
  assert.ok(gateway.resolvePort([], { CHEAPER_PORT: 'nope' }).error.includes('CHEAPER_PORT'));
});

test('start() with a bad --port spawns nothing and exits 1', async () => {
  // Binding 8787 when the caller asked for something else is worse than not starting:
  // the printed ANTHROPIC_BASE_URL then names a port nothing is listening on.
  spawnSyncStub = () => ({ status: 0 });
  let spawned = false;
  spawnStub = () => { spawned = true; return fakeChild(6001); };

  const { out, value } = await capture(() => gateway.start(['--port', 'eight-seven'], startsCleanly()));

  assert.strictEqual(spawned, false, out);
  assert.strictEqual(value, false);
  assert.strictEqual(process.exitCode, 1);
  assert.ok(out.includes('--port is not a port number'), out);
});

test('--port reaches uvicorn AND the pid file, for both start and serve', async () => {
  spawnSyncStub = () => ({ status: 0 });
  let seen = null;
  spawnStub = (cmd, args) => { seen = { cmd, args }; return fakeChild(6002); };

  const { out } = await capture(() => gateway.start(['--port', '9321'], startsCleanly()));

  assert.strictEqual(seen.args[seen.args.indexOf('--port') + 1], '9321',
    'the flag must reach uvicorn, or the gateway binds a port nobody asked for\n' + JSON.stringify(seen.args));
  assert.strictEqual(gateway.readPidFile().pid, 6002);
  assert.strictEqual(gateway.readPidFile().port, '9321',
    'stop/status have only the pid file to go on — an unrecorded port is a gateway they cannot describe');
  assert.ok(out.includes('http://localhost:9321'),
    'the printed base URL must name the port that was actually bound\n' + out);

  seen = null;
  let child = null;
  spawnStub = (cmd, args) => { seen = { cmd, args }; child = fakeChild(6003); return child; };
  const p = capture(() => gateway.serve(['--port=9322'], servesCleanly()));
  await tick();
  child.emit('exit', 0, null);
  await p;
  assert.strictEqual(seen.args[seen.args.indexOf('--port') + 1], '9322',
    'serve is what a supervisor runs; without the flag it silently binds 8787');
});

test('the pid file keeps a bare `parseInt` working — uninstall.js and launch.js read it that way', () => {
  gateway.writePidFile(31337, '9321');
  const raw = fs.readFileSync(GATEWAY_PID, 'utf8');
  assert.strictEqual(parseInt(raw, 10), 31337,
    'uninstall.js:30, launch.js:23 and the desktop app all do parseInt(readFileSync(...)); a JSON ' +
    'pid file would make all three parse NaN and report "no running gateway" against a live one');
  assert.deepStrictEqual({ pid: 31337, port: '9321' },
    { pid: gateway.readPidFile().pid, port: gateway.readPidFile().port });
});

test('a legacy bare-pid file still parses, with the port reported as UNKNOWN', async () => {
  const p = dummyProcess();
  fs.writeFileSync(GATEWAY_PID, String(p.pid));      // exactly what older builds wrote
  const rec = gateway.readPidFile();
  assert.strictEqual(rec.pid, p.pid, 'an old pid file is a valid record, not a corrupt one');
  assert.strictEqual(rec.port, null,
    'the port is UNKNOWN, and must not be filled in with the current default — that process ' +
    'may well have been started on another one');

  spawnSyncStub = psSays('python3 -m uvicorn app:app\n');
  const { out } = await capture(() => gateway.status());
  assert.ok(out.includes('running'), out);
  assert.ok(out.includes('port unknown'),
    'printing today\'s default port for a gateway that never recorded one is a confident guess\n' + out);
  p.kill('SIGKILL');
});

// --------------------------------------------------------------------------
// 10. The port-squat guard must see a squatter that does NOT answer /healthz
// --------------------------------------------------------------------------

test('probePortBound tells a listening loopback port from a closed one', async () => {
  // The primitive the whole guard rests on. A loopback server on an EPHEMERAL port (not
  // 8787, not 18787) is the only way to prove it, and it never leaves this process.
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const bound = srv.address().port;
  try {
    assert.strictEqual(await gateway.probePortBound(bound, 800), true,
      'a port with a listener on it must read as bound — uvicorn cannot have it');
  } finally {
    await new Promise((r) => srv.close(r));
  }
  assert.strictEqual(await gateway.probePortBound(bound, 800), false,
    'ECONNREFUSED is the free answer; anything else would make the gateway unstartable');
});

test('start() refuses a port that is BOUND but silent on /healthz', async () => {
  // THE BUG: probeHealth() resolves null for a 404, a 500, an empty body and anything
  // unparseable, so `if (existing)` only ever caught a squatter polite enough to serve
  // JSON. A plain dev server on the port fell straight through to spawn(), and uvicorn
  // died on EADDRINUSE a second later inside gateway.log — after the CLI had finished.
  spawnSyncStub = () => ({ status: 0 });
  let spawned = false;
  spawnStub = () => { spawned = true; return fakeChild(8001); };

  const { out, value } = await capture(() => gateway.start([], {
    open: false,
    probeHealth: probeSeq(null),            // a 404 from the squatter: probeHealth says null
    probePortBound: async () => true,       // …but the socket accepts
  }));

  assert.strictEqual(spawned, false, 'spawning onto a bound port produces a corpse the log explains and the CLI does not');
  assert.strictEqual(value, false);
  assert.strictEqual(process.exitCode, 1, 'a start that cannot bind must not exit 0');
  assert.ok(out.includes('does not answer /healthz'), out);
  assert.ok(!fs.existsSync(GATEWAY_PID), 'no pid file for a gateway that was never spawned');
});

test('a port check that CANNOT RUN is said out loud, and never rendered as "free"', async () => {
  spawnSyncStub = () => ({ status: 0 });
  let spawned = false;
  spawnStub = () => { spawned = true; return fakeChild(8002); };

  const { out, value } = await capture(() => gateway.start([], {
    open: false, probeHealth: probeSeq(null, OURS), probePortBound: async () => null,
  }));

  assert.ok(out.includes('could not check whether port'),
    'an unverifiable check must be reported, not silently treated as a pass\n' + out);
  // …and must not become a refusal either: a machine where a loopback connect is filtered
  // would otherwise have no way to start the gateway at all.
  assert.strictEqual(spawned, true, 'a failed probe must not make the gateway unstartable');
  assert.strictEqual(value, true);
  assert.strictEqual(process.exitCode, 0);
});

// --------------------------------------------------------------------------
// 11. restart() — the command freshness and the stale-build warning tell people to run
// --------------------------------------------------------------------------
//
// It had no test at all, and it destroyed the gateway: stop() signalled the process and
// deleted the pid file, a flat 400ms sleep was not enough for the SIGTERM'd uvicorn to
// release the socket, and start()'s already-running guard then saw the dying gateway's
// /healthz and printed
//     ✓ gateway already running on port N — nothing to do (use `cheaper gateway restart`)
// from inside restart — spawning nothing and returning true. No gateway, no pid file,
// exit 0, green tick.

test('restart() waits out the dying gateway and really starts a new one', async () => {
  const old = dummyProcess();
  gateway.writePidFile(old.pid, '18787');
  spawnSyncStub = psSays(PS_UVICORN);              // ps: the recorded pid is our uvicorn
  let spawned = 0, newUp = false;
  spawnStub = () => { spawned += 1; newUp = true; return fakeChild(7101); };

  // The old gateway answers /healthz and holds the port for exactly as long as it is
  // alive — a real process, really signalled by stop(), so the timing is not invented.
  const oldAlive = () => gateway.pidAlive(old.pid);
  const probeHealth = async () => (newUp || oldAlive() ? OURS : null);
  const probePortBound = async () => (newUp || oldAlive());

  const { out, value } = await capture(() => gateway.restart([], {
    probeHealth, probePortBound, portFreeWaitMs: 4000, serveWaitMs: 2000,
  }));

  assert.strictEqual(spawned, 1, 'restart that spawns nothing is a gateway destroyed and a ✓ printed');
  assert.strictEqual(value, true);
  assert.strictEqual(process.exitCode, 0);
  assert.ok(out.includes('gateway stopped'), out);
  assert.ok(out.includes('gateway started'), out);
  assert.ok(!out.includes('already running'),
    'restart advising "use `cheaper gateway restart`" is the defect itself\n' + out);
  assert.ok(!out.includes('nothing to do'), out);
  const rec = gateway.readPidFile();
  assert.ok(rec && rec.pid === 7101 && rec.port === '18787',
    'restart must never end with the pid file deleted and nothing running\n' + JSON.stringify(rec));
});

test('restart() keeps polling while the port frees SLOWLY — it does not assume 400ms', async () => {
  gateway.writePidFile(4242, '18787');             // a pid that is gone: stop clears it
  spawnSyncStub = psSays(PS_UVICORN);
  let spawned = 0, newUp = false;
  spawnStub = () => { spawned += 1; newUp = true; return fakeChild(7102); };

  // The socket stays accepted for four polls after the stop — roughly 600ms, comfortably
  // past the flat 400ms sleep the old restart() used.
  let checks = 0;
  const probeHealth = async () => (newUp ? OURS : null);
  const probePortBound = async () => { if (newUp) return true; checks += 1; return checks <= 4; };

  const t0 = Date.now();
  const { out, value } = await capture(() => gateway.restart([], {
    probeHealth, probePortBound, portFreeWaitMs: 4000, serveWaitMs: 2000,
  }));

  assert.strictEqual(value, true, out);
  assert.strictEqual(spawned, 1, out);
  assert.ok(checks >= 5, `restart must poll until the port is free, not sleep a fixed amount (checks=${checks})`);
  assert.ok(Date.now() - t0 >= 400, 'it must actually have waited');
  assert.strictEqual(process.exitCode, 0);
});

test('restart() refuses, loudly and non-zero, when the port NEVER frees', async () => {
  // Something else holds the port and answers nothing. Spawning into that produces the
  // corpse pid; printing a ✓ is the defect. Refusing in words is the only honest answer.
  spawnSyncStub = () => ({ status: 0 });
  let spawned = 0;
  spawnStub = () => { spawned += 1; return fakeChild(7103); };

  const { out, value } = await capture(() => gateway.restart([], {
    probeHealth: async () => null,
    probePortBound: async () => true,
    portFreeWaitMs: 300,
  }));

  assert.strictEqual(spawned, 0, 'a uvicorn spawned onto a bound port dies on EADDRINUSE and would be called started');
  assert.strictEqual(value, false);
  assert.strictEqual(process.exitCode, 1, 'a restart that restarted nothing must not exit 0');
  assert.ok(out.includes('still in use'), out);
  assert.ok(out.includes('not restarting'), out);
  assert.ok(out.includes('300ms'),
    'a sub-second budget rounded to seconds reads "still in use 0s after the stop", which ' +
    'sounds like a bug in the message rather than a report about the port\n' + out);
  assert.ok(!out.includes('0s after'), out);
  assert.ok(!out.includes('✓ gateway started'), 'no green tick for a gateway that was never spawned\n' + out);
});

test('restart() never reports success for a gateway that is still answering', async () => {
  // THE REPRODUCTION, at the exact race that makes `force` load-bearing. The port check
  // cannot run (a filtered loopback connect) and the old gateway's /healthz misses one
  // probe, so waitUntilPortFree has no positive evidence the port is still held and lets
  // the start proceed — and the gateway answers again a moment later, from start()'s own
  // guard. Without `force` that guard printed
  //     ✓ gateway already running on port N — nothing to do (use `cheaper gateway restart`)
  // and returned TRUE: restart exited 0 with a green tick, having spawned nothing, after
  // stop() had already signalled the process and deleted the pid file.
  const old = dummyProcess();
  gateway.writePidFile(old.pid, '18787');
  spawnSyncStub = psSays(PS_UVICORN);
  let spawned = 0;
  spawnStub = () => { spawned += 1; return fakeChild(7106); };

  const { out, value } = await capture(() => gateway.restart([], {
    probeHealth: probeSeq(null, OURS),      // one missed probe, then it answers again
    probePortBound: async () => null,       // …and the port check cannot say otherwise
    portFreeWaitMs: 3000,
  }));

  assert.ok(out.includes('could not confirm port'),
    'the wait must say it never confirmed the port was free, not imply that it did\n' + out);

  assert.strictEqual(value, false, 'a restart that spawned nothing must not answer true');
  assert.strictEqual(process.exitCode, 1, 'exit 0 here is the green tick over a destroyed gateway');
  assert.strictEqual(spawned, 0);
  assert.ok(!out.includes('nothing to do'),
    'restart must never advise "use `cheaper gateway restart`" from inside restart\n' + out);
  assert.ok(out.includes('still held by a Cheaper gateway'), out);
  old.kill('SIGKILL');
});

test('restart() with a bad --port stops NOTHING — a typo must not cost a running gateway', async () => {
  const live = dummyProcess();
  gateway.writePidFile(live.pid, '18787');
  spawnSyncStub = psSays(PS_UVICORN);
  let spawned = 0;
  spawnStub = () => { spawned += 1; return fakeChild(7104); };

  const { out, value } = await capture(() => gateway.restart(['--port', 'eight-seven'], {
    probeHealth: async () => null, probePortBound: async () => false, portFreeWaitMs: 100,
  }));

  assert.strictEqual(value, false);
  assert.strictEqual(process.exitCode, 1);
  assert.ok(out.includes('--port is not a port number'), out);
  assert.strictEqual(spawned, 0);
  assert.ok(!(await waitExit(live, 300)), 'the port is resolved BEFORE anything is signalled');
  assert.ok(fs.existsSync(GATEWAY_PID), 'and before the pid file is touched');
  live.kill('SIGKILL');
});

test('start() without force is still idempotent — restart must not have broken that', async () => {
  // The counterweight to `force`: an already-running gateway is a SUCCESS for a plain
  // `cheaper gateway start`, and turning that into a refusal would break every caller
  // that starts the gateway on demand (launch.js, the desktop app).
  fs.writeFileSync(GATEWAY_PID, '4242\nport=18787\n');
  spawnSyncStub = () => ({ status: 0 });
  let spawned = false;
  spawnStub = () => { spawned = true; return fakeChild(7105); };

  const { out, value } = await capture(() =>
    gateway.start([], { open: false, probeHealth: probeSeq(OURS), probePortBound: async () => true }));

  assert.strictEqual(value, true);
  assert.strictEqual(spawned, false);
  assert.ok(out.includes('already running'), out);

  // …and WITH force, the same state is a refusal, because restart only gets there when
  // the process it just signalled outlived its whole wait budget.
  const forced = await capture(() =>
    gateway.start([], { open: false, force: true, probeHealth: probeSeq(OURS), probePortBound: async () => true }));
  assert.strictEqual(forced.value, false);
  assert.strictEqual(process.exitCode, 1);
  assert.ok(forced.out.includes('still held by a Cheaper gateway'), forced.out);
  assert.ok(!forced.out.includes('nothing to do'),
    'advising `cheaper gateway restart` from inside restart is the defect\n' + forced.out);
});

// --------------------------------------------------------------------------
// 12. A supervised gateway must not look DEAD to the commands that report on it
// --------------------------------------------------------------------------

test('stop() on a registered login item says it will come back, and names the off switch', async () => {
  const gw = dummyProcess();
  gateway.writePidFile(gw.pid, '18787');
  spawnSyncStub = psSays(PS_UVICORN);

  const { out } = await capture(() => gateway.stop({ autostart: fakeAutostart(true) }));

  assert.ok(await waitExit(gw), 'it must still actually stop the gateway');
  assert.ok(out.includes('gateway stopped'), out);
  assert.ok(out.includes('come back at your next login'),
    'a service that restarts itself at login without saying so is what people call malware\n' + out);
  assert.ok(out.includes('cheaper autostart disable'),
    'naming the off switch is the difference between a feature and a trap\n' + out);
});

test('stop() with nothing recorded still mentions a registered login item', async () => {
  const { out } = await capture(() => gateway.stop({ autostart: fakeAutostart(true) }));
  assert.ok(out.includes('No running gateway found'), out);
  assert.ok(out.includes('autostart is registered'),
    '"No running gateway found." on a machine that starts one at every login is a half-truth\n' + out);
  assert.ok(out.includes('cheaper autostart disable'), out);
});

test('status() reports the registration alongside the process, running or stopped', async () => {
  const stopped = await capture(() => gateway.status({ autostart: fakeAutostart(true) }));
  assert.ok(stopped.out.includes('gateway: stopped'), stopped.out);
  assert.ok(stopped.out.includes('autostart: registered'),
    'a stopped gateway on a machine with a login item is not the whole truth\n' + stopped.out);

  const gw = dummyProcess();
  gateway.writePidFile(gw.pid, '18787');
  spawnSyncStub = psSays(PS_UVICORN);
  const running = await capture(() => gateway.status({ autostart: fakeAutostart(true) }));
  assert.ok(running.out.includes('gateway: running'), running.out);
  assert.ok(running.out.includes('autostart: registered'), running.out);
  gw.kill('SIGKILL');
});

test('no registration, or no autostart.js at all, adds nothing to either command', async () => {
  // The supervision lookup is decoration on top of an answer that must stay correct
  // without it — including on a build that ships gateway.js and no autostart.js, where
  // the lazy require throws MODULE_NOT_FOUND.
  const off = await capture(() => gateway.status({ autostart: fakeAutostart(false) }));
  assert.ok(!off.out.includes('autostart:'), off.out);
  const absent = await capture(() => gateway.status({ autostart: null }));
  assert.ok(!absent.out.includes('autostart:'), absent.out);
  assert.ok(absent.out.includes('gateway: stopped'), absent.out);

  assert.strictEqual(gateway.supervisionState(null), null, 'no module is not a registration');
  assert.strictEqual(gateway.supervisionState({}), null, 'a module without isRegisteredOnDisk is not one either');
  assert.strictEqual(gateway.supervisionState({ isRegisteredOnDisk: () => { throw new Error('boom'); } }), null,
    'a lookup that throws must not take `cheaper gateway status` down with it');
});

test('the lazy require is really wired to autostart.js, not just to the injected fake', async () => {
  // Injected fakes prove the WORDS; this proves the WIRING. It writes the agent file only
  // inside the sandbox HOME this file set before paths.js loaded — never the developer's
  // own ~/Library/LaunchAgents — and runs no launchctl/systemctl/schtasks: gateway.js
  // deliberately uses the filesystem-only isRegisteredOnDisk() for exactly that reason.
  const autostart = require('../src/autostart');
  const ctx = autostart.makeCtx();
  const agent = autostart.agentPath(ctx);
  const marker = agent || path.join(CHEAPER, 'autostart.json');   // win32 has no file: it keeps state
  assert.ok(marker.startsWith(SANDBOX), `refusing to write outside the sandbox: ${marker}`);

  const before = await capture(() => gateway.status());
  assert.ok(!before.out.includes('autostart:'), before.out);

  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, agent
    ? '<!-- written by this test -->\n'
    : JSON.stringify({ enabled: true, enabledAt: new Date().toISOString() }));
  try {
    const after = await capture(() => gateway.status());
    assert.ok(after.out.includes('autostart: registered'),
      'gateway.js must consult the real autostart registration, not only an injected stub\n' + after.out);
    assert.ok(after.out.includes(autostart.LABEL), after.out);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test.after(() => {
  for (const ch of strays) { try { ch.kill('SIGKILL'); } catch { /* already gone */ } }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});
