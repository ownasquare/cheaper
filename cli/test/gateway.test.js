'use strict';
// gateway.js: interpreter discovery, spawn-failure handling, log permissions and
// subcommand exit codes.
//
// Every test here covers a way `cheaper gateway start` could fail WITHOUT SAYING SO —
// by crashing with a raw stack trace, by leaving a poisoned pid file, by writing a
// secret into a world-readable log, or by reporting success for a typo'd subcommand.
//
// The module is required AFTER the environment is redirected, because paths.js reads
// os.homedir() at load time and gateway.js captures PORT and the child_process
// functions in the same way. node:test runs each file in its own process, so these
// module-level side effects are contained to this file.

const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

// --- sandbox HOME, BEFORE paths.js is loaded -------------------------------
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-gw-test-'));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;                 // os.homedir() on win32
delete process.env.CLAUDE_CONFIG_DIR;              // must not leak the real one in

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

// waitUntilServing() polls the real loopback for up to 8s. Override the health probe
// so a start() that gets as far as spawning returns immediately. gateway.js
// re-destructures runningGateway from the module on every call, so this takes effect.
const freshness = require('../src/freshness');
freshness.runningGateway = async () => ({ ok: true, code_sha: 'test' });

// --- helpers ---------------------------------------------------------------
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

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
  return ch;
}

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

  const { out } = await capture(() => gateway.start([], { open: false }));

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

  const { out } = await capture(() => gateway.start([], { open: false }));

  assert.strictEqual(process.exitCode, 1);
  assert.ok(out.includes('could not start the gateway'), out);
  assert.ok(out.includes('ENOENT'), 'the errno belongs in the message\n' + out);
  // THE REGRESSION. `String(undefined)` is "undefined": the old code wrote that into
  // gateway.pid before the error event fired, and every later `gateway stop`/`status`
  // then parsed NaN and reported "no running gateway".
  const pid = fs.existsSync(GATEWAY_PID) ? fs.readFileSync(GATEWAY_PID, 'utf8') : null;
  assert.notStrictEqual(pid, 'undefined', 'the literal string "undefined" must never reach gateway.pid');
  assert.strictEqual(pid, null, 'no pid file at all is the right outcome here');
});

test('an error arriving AFTER a successful spawn is still handled (no unhandled event)', async () => {
  spawnSyncStub = () => ({ status: 0 });
  let child;
  spawnStub = () => { child = fakeChild(4242); return child; };

  await capture(() => gateway.start([], { open: false }));
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

  await capture(() => gateway.start([], { open: false }));

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

  await capture(() => gateway.start([], { open: false }));

  assert.strictEqual(seen.cmd, 'py');
  assert.deepStrictEqual(seen.args.slice(0, 4), ['-3', '-m', 'uvicorn', '--no-access-log'],
    'dropping `-3` lets the py launcher pick a Python 2 that cannot run the gateway');
});

test('gateway.log is created 0600, and an existing 0644 log is tightened', async (t) => {
  if (process.platform === 'win32') return;        // POSIX mode bits only

  // (a) fresh file
  spawnSyncStub = () => ({ status: 0 });
  spawnStub = () => fakeChild(779);
  await capture(() => gateway.start([], { open: false }));
  assert.strictEqual(fs.statSync(GATEWAY_LOG).mode & 0o777, 0o600,
    'stdout+stderr of the gateway land here; 0644 exposes them to every other account');

  // (b) a log left behind world-readable by an older version. The mode argument to
  //     open(2) applies only on CREATE, so this is the case an fchmod is needed for.
  fs.chmodSync(GATEWAY_LOG, 0o644);
  await capture(() => gateway.start([], { open: false }));
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

test.after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });
