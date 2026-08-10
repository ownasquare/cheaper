'use strict';
// autostart.js — an opt-in login entry that runs `cheaper gateway serve`.
//
// Two failure classes dominate this file, and every test below belongs to one of them.
//
// 1. CONSENT. A self-restarting login daemon is the most invasive thing this product can
//    install. It must be unreachable from `cheaper install` and `cheaper install --all`,
//    it must be offered at most once and only to a real terminal, and it must never be
//    re-registered over a switch the user flipped off in System Settings.
//
// 2. THE ORPHAN. The worst artifact this feature can leave behind is a registered
//    supervisor pointing at deleted files: it retries at every login, forever, with no
//    `cheaper` command left to disable it. So uninstall deregisters BEFORE it deletes,
//    --purge refuses while an entry is registered, disable() deletes the entry file only
//    once deregistration is CONFIRMED, and KeepAlive is a dict rather than <true/>. That
//    last one is only half the story: {SuccessfulExit:false} restarts a NON-ZERO exit, so
//    it honours `cheaper gateway stop` only because `gateway serve` exits 0 on a
//    deliberate signal. That cross-file dependency has its own test below, driving the
//    real CLI with a real SIGTERM.
//
// NOTHING HERE TOUCHES THE REAL MACHINE. Every path is an injected temp directory, the
// launchctl/systemctl/schtasks invoker is a stub, the port probe is a stub, and no
// gateway is ever started. A test that can register a login item on the developer's own
// mac is not a test.

const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');

// Sandbox HOME BEFORE paths.js is required — it resolves ~ once, at load.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-autostart-test-'));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX, '.claude');

const A = require('../src/autostart');
const BIN = path.join(__dirname, '..', 'bin', 'cheaper.js');
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// Stand-in interpreters. They only ever have to EXIST — enable() records absolute paths
// and status() re-resolves them; neither one executes them.
const FAKE_BIN = path.join(SANDBOX, 'fake', 'bin');
fs.mkdirSync(FAKE_BIN, { recursive: true });
const FAKE_NODE = path.join(FAKE_BIN, 'node');
const FAKE_PY = path.join(SANDBOX, 'fake', 'py', 'bin', 'python3');
fs.mkdirSync(path.dirname(FAKE_PY), { recursive: true });
fs.writeFileSync(FAKE_NODE, '');
fs.writeFileSync(FAKE_PY, '');

// node:test sets process.exitCode as soon as anything in this FILE fails, so read the
// code a call under test produced against a pinned baseline instead of the runner's.
function withExitCode(fn) {
  const runner = process.exitCode;
  process.exitCode = 0;
  try {
    const value = fn();
    return { value, code: process.exitCode };
  } finally { process.exitCode = runner; }
}
async function withExitCodeAsync(fn) {
  const runner = process.exitCode;
  process.exitCode = 0;
  try {
    const value = await fn();
    return { value, code: process.exitCode };
  } finally { process.exitCode = runner; }
}

// `launchctl print-disabled gui/<uid>` on a machine where nothing has been overridden.
// The header is the part that matters: autostart.js reads a listing carrying neither this
// header nor a single `"label" => value` entry as UNKNOWN rather than as "not disabled",
// so a stub that returned '' would be asserting against a shape launchctl never emits.
const EMPTY_DISABLED_LIST = '\tdisabled services = {\n\t}\n';

// --- the fake supervisor ---------------------------------------------------
//
// One stub for all three platforms. It records every invocation IN ORDER, and — this is
// what makes the uninstall-ordering test possible — it snapshots whether the entry file
// still existed at the moment each command ran.
function fakeSupervisor(state) {
  return (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    state.calls.push(line);
    state.fileAtCall.push({ line, entryExisted: !!(state.entryPath && fs.existsSync(state.entryPath)) });

    if (cmd === 'launchctl') {
      const sub = args[0];
      // The real shape, verified against macOS 26 (Darwin 25.3): a `disabled services = {`
      // header wrapping one `"label" => enabled|disabled` line per OVERRIDDEN label. The
      // stub keeps the header even in the not-disabled case, because autostart.js now
      // treats a listing it cannot recognise as UNKNOWN — a stub that prints a bare line,
      // or nothing at all, would be exercising a shape launchctl never produces.
      if (sub === 'print-disabled')
        return {
          status: 0,
          stdout: state.disabled
            ? `\tdisabled services = {\n\t\t"${A.LABEL}" => disabled\n\t}\n`
            : '\tdisabled services = {\n\t\t"com.example.other" => disabled\n\t}\n',
          stderr: '',
        };
      if (sub === 'print')
        return state.loaded ? { status: 0, stdout: 'state = running\n', stderr: '' }
          : { status: 113, stdout: '', stderr: 'Could not find service\n' };
      if (sub === 'bootstrap' || sub === 'load') { state.loaded = true; return { status: 0, stdout: '', stderr: '' }; }
      if (sub === 'bootout' || sub === 'unload') {
        const was = state.loaded; state.loaded = false;
        return { status: was ? 0 : 3, stdout: '', stderr: was ? '' : 'No such process\n' };
      }
    }

    if (cmd === 'systemctl') {
      const sub = args[1];
      if (sub === 'is-enabled') {
        if (state.enabled) return { status: 0, stdout: 'enabled\n', stderr: '' };
        if (state.disabled) return { status: 1, stdout: 'disabled\n', stderr: '' };
        if (state.entryPath && fs.existsSync(state.entryPath)) return { status: 1, stdout: 'disabled\n', stderr: '' };
        return { status: 1, stdout: '', stderr: 'Failed to get unit file state: No such file or directory\n' };
      }
      if (sub === 'enable') { state.enabled = true; return { status: 0, stdout: '', stderr: '' }; }
      if (sub === 'disable') { state.enabled = false; return { status: 0, stdout: '', stderr: '' }; }
      return { status: 0, stdout: '', stderr: '' };
    }

    if (cmd === 'loginctl') return { status: 0, stdout: `Linger=${state.linger || 'no'}\n`, stderr: '' };

    if (cmd === 'schtasks') {
      const sub = args[0];
      if (sub === '/Query')
        return state.taskExists
          ? { status: 0, stdout: `TaskName: \\${A.TASK_NAME}\nStatus: ${state.disabled ? 'Disabled' : 'Ready'}\n`, stderr: '' }
          : { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.\n' };
      if (sub === '/Create') { state.taskExists = true; return { status: 0, stdout: 'SUCCESS\n', stderr: '' }; }
      if (sub === '/Delete') { state.taskExists = false; return { status: 0, stdout: 'SUCCESS\n', stderr: '' }; }
    }

    return { status: 0, stdout: '', stderr: '' };
  };
}

let fixtureN = 0;
function fixture(o = {}) {
  const home = path.join(SANDBOX, `h${fixtureN++}`);
  fs.mkdirSync(home, { recursive: true });
  const platform = o.platform || 'darwin';

  // The stable CLI copy clilink.js stages, and the Windows launcher it writes.
  const entry = path.join(home, '.cheaper', 'cli', 'bin', 'cheaper.js');
  const winCmd = path.join(home, 'AppData', 'Local', 'cheaper', 'bin', 'cheaper.cmd');
  if (o.stageCli !== false) {
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// stub CLI\n');
    fs.mkdirSync(path.dirname(winCmd), { recursive: true });
    fs.writeFileSync(winCmd, '@echo off\r\n');
  }

  const state = {
    calls: [], fileAtCall: [], loaded: false, enabled: false,
    disabled: !!o.disabled, taskExists: !!o.taskExists, linger: o.linger,
    entryPath: null,
  };
  const lines = [];
  // Built through makeCtx so cheaperDir/cliHome are DERIVED from the injected home
  // exactly as they are in production — and so nothing here can fall back to the real
  // ~/.cheaper. Every entry point re-runs makeCtx over this object, which is idempotent.
  const ctx = A.makeCtx({
    home,
    platform,
    uid: o.uid !== undefined ? o.uid : 501,
    env: Object.assign(
      { USER: 'tester' },
      platform === 'linux' && o.noBus !== true ? { XDG_RUNTIME_DIR: '/run/user/501' } : {},
      platform === 'win32' ? { LOCALAPPDATA: path.join(home, 'AppData', 'Local') } : {},
      o.env || {}),
    nodeExe: o.nodeExe !== undefined ? o.nodeExe : FAKE_NODE,
    resolvePy: () => (o.py === null ? null : (o.py || { cmd: 'python3', args: [] })),
    which: o.which || ((b) => (b === 'python3' ? FAKE_PY : b === 'node' ? FAKE_NODE : null)),
    prepare: o.prepare || (() => true),
    probePort: o.probePort || (() => ({ state: 'free', detail: 'nothing is listening on it' })),
    ownGatewayHoldsPort: o.ownGatewayHoldsPort || (() => false),
    run: fakeSupervisor(state),
    log: (...a) => lines.push(a.join(' ')),
    ask: o.ask || (async () => ''),
    interactive: !!o.interactive,
  });
  state.entryPath = A.agentPath(ctx);
  return {
    home, ctx, state, lines, entry, winCmd,
    out: () => strip(lines.join('\n')),
    plist: () => A.agentPath(ctx),
    read: () => fs.readFileSync(A.agentPath(ctx), 'utf8'),
  };
}

// ==========================================================================
// 1. CONSENT
// ==========================================================================

test('`install --all` cannot reach autostart — it is not in DEFAULT_KEYS, nor in the `all` alias', () => {
  const install = require('../src/install');
  assert.ok(install.COMPONENTS.some((x) => x.key === 'autostart'),
    'autostart must still be an installable component — it is offered in the picker and by name');
  assert.ok(!install.DEFAULT_KEYS.includes('autostart'),
    'a bare `cheaper install` and `cheaper install --all` both expand to DEFAULT_KEYS; putting a '
    + 'self-restarting login daemon in there would register it on every machine that ran the '
    + 'documented install command');

  // The alias table is the other way in. `all` is built from DEFAULT_KEYS, and this pins
  // that it stays that way rather than growing its own literal list.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'install.js'), 'utf8');
  const aliasBlock = src.slice(src.indexOf('const ALIASES'), src.indexOf('function normalizeKeys'));
  assert.ok(/all:\s*DEFAULT_KEYS\.slice\(\)/.test(aliasBlock),
    '`all` must stay derived from DEFAULT_KEYS\n' + aliasBlock);
  assert.ok(!/all:\s*\[[^\]]*autostart/.test(aliasBlock),
    '"all" must never enumerate autostart\n' + aliasBlock);
});

test('`cheaper install --all` end-to-end writes NO plist, NO unit, and no autostart state', () => {
  const home = fs.mkdtempSync(path.join(SANDBOX, 'e2e-'));
  const r = spawnSync(process.execPath, [BIN, 'install', '--all'], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120000,
    env: Object.assign({}, process.env, {
      HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    }),
  });
  const out = strip((r.stdout || '') + (r.stderr || ''));
  assert.strictEqual(r.status, 0, 'the documented install must still work\n' + out);
  assert.ok(fs.existsSync(path.join(home, '.cheaper', 'gateway')), '--all still installs the gateway\n' + out);

  assert.ok(!fs.existsSync(path.join(home, 'Library', 'LaunchAgents')),
    '`install --all` registered a LaunchAgent — that is a login daemon the user never asked for\n' + out);
  assert.ok(!fs.existsSync(path.join(home, '.config', 'systemd', 'user', A.UNIT_NAME)),
    '`install --all` wrote a systemd user unit\n' + out);
  assert.ok(!fs.existsSync(path.join(home, '.cheaper', A.STATE_BASENAME || 'autostart.json')),
    '`install --all` must not even record an autostart decision — it never asked\n' + out);
});

test('`cheaper install autostart` reports an UNVERIFIED registration as a failure, not a ✓', () => {
  // The installer prints a green ✓ per component and derives its exit code from the same
  // per-component ok flag. enable() answers ok:false for anything it could not confirm —
  // an entry launchd never acknowledged, a schtasks call that did not take — and the
  // installer must carry that through. A ✓ against a login daemon that is not actually
  // registered is the single most misleading line this product could print.
  const results = withStubbedAutostart({
    enable: () => ({ ok: false, state: 'unverified', msg: 'autostart -> NOT confirmed (launchctl exited 5)' }),
  }, () => require('../src/install').install({ components: ['autostart'] }));

  const row = results.find((r) => r.key === 'autostart');
  assert.ok(row, JSON.stringify(results));
  assert.strictEqual(row.ok, false,
    'an unverified login daemon was reported as installed; install.js prints ✓ and exits 0 on '
    + 'this flag\n' + JSON.stringify(results, null, 2));
  assert.match(row.msg, /NOT confirmed/, row.msg);
});

test('the offer is TTY-gated on BOTH streams, and a non-TTY run asks nothing and writes nothing', async () => {
  const f = fixture({
    interactive: false,
    ask: async () => {
      throw new Error('THE BUG: the offer was put to a non-TTY. readline never fires its '
        + 'callback on a closed or piped stdin, so `cheaper install` in CI either hangs or '
        + 'takes a default nobody typed — and the default here would register a login daemon');
    },
  });
  const r = await A.offerOnce(f.ctx);
  assert.strictEqual(r.asked, false, 'a piped or redirected stdio has nobody to answer');
  assert.match(r.why, /TTY/, r.why);
  assert.ok(!fs.existsSync(A.statePath(f.ctx)),
    'refusing to ask must not persist an answer either — the user has not decided yet');
});

test('a DECLINED offer is never asked again — Enter means no, and no is remembered', async () => {
  let asked = 0;
  const f = fixture({ interactive: true, ask: async () => { asked++; return ''; } });   // bare Enter

  const first = await A.offerOnce(f.ctx);
  assert.strictEqual(asked, 1, 'the first interactive run asks once');
  assert.strictEqual(first.answer, 'no', 'Enter is NO — a login daemon is never the default');
  assert.ok(!fs.existsSync(f.plist()), 'declining must write no plist');
  assert.strictEqual(A.readState(f.ctx).answer, 'no', 'the answer must be persisted');

  const second = await A.offerOnce(f.ctx);
  assert.strictEqual(asked, 1,
    'asking again after a no is the nag pattern users read as adware; the persisted answer '
    + 'is the whole point of writing it');
  assert.strictEqual(second.asked, false);
  assert.match(second.why, /already asked/, second.why);
});

test('an ACCEPTED offer enables, and also stops the question from coming back', async () => {
  let asked = 0;
  const f = fixture({ interactive: true, ask: async () => { asked++; return 'y'; } });
  const { value } = await withExitCodeAsync(() => A.offerOnce(f.ctx));
  assert.strictEqual(value.answer, 'yes');
  assert.ok(fs.existsSync(f.plist()), 'a yes must actually enable it\n' + f.out());
  assert.strictEqual(A.readState(f.ctx).answer, 'yes');
  assert.strictEqual((await A.offerOnce(f.ctx)).asked, false, 'still only ever asked once');
  assert.strictEqual(asked, 1);
});

test('enable REFUSES to re-register an entry the user switched off in Login Items', () => {
  const f = fixture({ disabled: true });
  fs.mkdirSync(path.dirname(f.plist()), { recursive: true });
  fs.writeFileSync(f.plist(), '<!-- previously written -->');
  const before = fs.readFileSync(f.plist(), 'utf8');

  const { value, code } = withExitCode(() => A.enable([], f.ctx));
  assert.strictEqual(fs.readFileSync(f.plist(), 'utf8'), before,
    'the existing entry was REWRITTEN. Silently re-registering over the off switch the user '
    + 'flipped in System Settings is worse than never having offered — it is the behaviour that '
    + 'gets software called malware\n' + f.out());
  assert.ok(!f.state.calls.some((l) => /bootstrap|load -w/.test(l)),
    'and nothing may be handed to launchd either\n' + f.state.calls.join('\n'));
  assert.strictEqual(value.ok, false, f.out());
  assert.strictEqual(code, 1, 'a refusal must not exit 0\n' + f.out());
  assert.match(f.out(), /switched it off/i,
    'the message must name what happened, not just fail\n' + f.out());
});

test('status reports "registered but disabled by you" and STOPS — no drift nag, no re-enable', () => {
  const f = fixture({ disabled: true });
  fs.mkdirSync(path.dirname(f.plist()), { recursive: true });
  fs.writeFileSync(f.plist(), '<!-- x -->');
  // A record whose node is long gone: if status carried on past the disabled state it
  // would print drift advice pushing the user back towards a thing they turned off.
  A.writeState(f.ctx, { record: { node: '/nonexistent/node', python: '/nonexistent/py', target: '/nonexistent/cheaper.js' } });

  const { value } = withExitCode(() => A.status([], f.ctx));
  assert.strictEqual(value.state, 'disabled-by-user', f.out());
  assert.match(f.out(), /disabled by you/i, f.out());
  assert.ok(!/enable again|run `cheaper autostart enable`/i.test(f.out()),
    'it must not nudge the user back onto a switch they deliberately flipped\n' + f.out());
  assert.ok(!f.state.calls.some((l) => /bootstrap|load -w|enable/.test(l)), f.state.calls.join('\n'));
});

// ==========================================================================
// 2. WHAT ACTUALLY GETS WRITTEN
// ==========================================================================

test('KeepAlive is a DICT with SuccessfulExit=false — never <true/>', () => {
  const f = fixture();
  withExitCode(() => A.enable([], f.ctx));
  const xml = f.read();

  assert.ok(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/.test(xml),
    'KeepAlive must be {SuccessfulExit: false}\n' + xml);
  assert.ok(!/<key>KeepAlive<\/key>\s*<true\/>/.test(xml),
    'with KeepAlive=<true/> launchd restarts the job whatever it exits with, so the documented '
    + '`cheaper gateway stop` is answered by a respawn within ThrottleInterval and the user has no '
    + 'in-product off switch at all\n' + xml);

  // SuccessfulExit=false is NOT itself an off switch: it restarts a NON-ZERO exit. It only
  // leaves a deliberate stop stopped because `gateway serve` exits 0 on a deliberate
  // signal — which is a fact about ANOTHER FILE. The test below drives the real thing with
  // a real SIGTERM; this only pins that the shipped comment keeps naming the dependency,
  // so the claim cannot quietly go back to "SuccessfulExit=false honours a stop", which is
  // false on its own.
  assert.match(xml, /exits 0 when it ends on SIGTERM/,
    'the plist ships this comment to the user\'s machine; it must state the mechanism it '
    + 'actually depends on, not a property SuccessfulExit=false does not have by itself\n' + xml);
});

// The claim above is a cross-file one, so it is tested across the files. Nothing else in
// this suite would notice serve() going back to the shell's 128+N convention, and the only
// symptom on a real machine is a gateway that comes back thirty seconds after the user
// stopped it — a bug report nobody would think to file against autostart.js.
test('`gateway serve` exits 0 on a deliberate SIGTERM — the fact both the plist and the unit rest on', { skip: process.platform === 'win32' ? 'no POSIX signals' : false }, async () => {
  const home = fs.mkdtempSync(path.join(SANDBOX, 'serve-signal-'));
  // gateway.ensureInstalled() only checks that this directory exists, and the stub python
  // below never reads it — no gateway is installed, and nothing binds a port.
  fs.mkdirSync(path.join(home, '.cheaper', 'gateway'), { recursive: true });

  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const started = path.join(home, 'uvicorn-started');
  // Stands in for python3+uvicorn: it answers the `--version` probe pyExe() makes, then
  // marks itself started and sleeps. `exec` matters — it is what makes the forwarded
  // SIGTERM land on a process that dies of it, exactly as uvicorn would.
  fs.writeFileSync(path.join(binDir, 'python3'),
    '#!/bin/sh\n'
    + 'if [ "$1" = "--version" ]; then echo "Python 3.11.0"; exit 0; fi\n'
    + `: > ${JSON.stringify(started)}\n`
    + 'exec sleep 120\n', { mode: 0o755 });

  const child = require('child_process').spawn(process.execPath, [BIN, 'gateway', 'serve', '--port', '8799'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      PATH: binDir + path.delimiter + process.env.PATH,
      CHEAPER_PORT: '8799',
    }),
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(started)) {
      if (Date.now() > deadline) throw new Error('the stub uvicorn never started\n' + strip(out));
      if (child.exitCode !== null) throw new Error(`serve exited before starting anything (${child.exitCode})\n` + strip(out));
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill('SIGTERM');
    const { code, signal } = await exited;

    assert.strictEqual(signal, null,
      'serve must forward the signal and exit on its own; dying of the signal itself orphans '
      + `uvicorn on the port (got signal ${signal})\n` + strip(out));
    assert.strictEqual(code, 0,
      `\`cheaper gateway serve\` exited ${code} after a DELIBERATE SIGTERM, not 0. Both supervisors `
      + 'this file writes decide by exit code: launchd KeepAlive={SuccessfulExit:false} and systemd '
      + 'Restart=on-failure restart a NON-ZERO exit. Under the shell 128+N convention a SIGTERM is '
      + '143, so `cheaper gateway stop` reads as a crash and the gateway the user just stopped is '
      + 'respawned within ThrottleInterval/RestartSec — a supervised gateway with no off switch, '
      + 'which is exactly what the KeepAlive and Restart= comments in autostart.js promise cannot '
      + 'happen. Fix gateway.js serve(), or those comments (and this plist) are lying.\n' + strip(out));
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('the plist runs `gateway serve` (foreground) with an ABSOLUTE node and the staged CLI', () => {
  const f = fixture();
  withExitCode(() => A.enable([], f.ctx));
  const xml = f.read();

  const args = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.ok(args.includes(FAKE_NODE), 'the absolute node resolved at enable time must be baked in\n' + xml);
  assert.ok(args.includes(f.entry), 'it must point at ~/.cheaper/cli — the stable copy, not an npm shim\n' + xml);
  assert.ok(xml.includes('<string>serve</string>'),
    '`gateway start` detaches and returns, so launchd would see its job exit at once and restart '
    + 'it forever while the uvicorns piled up behind it\n' + xml);
  assert.ok(!/<string>start<\/string>/.test(xml), xml);
  assert.ok(!/<string>prepare<\/string>/.test(xml),
    'prepare runs pip; inside a KeepAlive restart loop that hammers the package index and a machine '
    + 'offline at boot never comes up\n' + xml);

  assert.ok(/<key>RunAtLoad<\/key>\s*<true\/>/.test(xml), xml);
  assert.ok(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/.test(xml), xml);
  assert.ok(/<key>ProcessType<\/key>\s*<string>Background<\/string>/.test(xml), xml);
});

test('the log is autostart.log at 0600, NOT the gateway.log the gateway fchmods itself', () => {
  const f = fixture();
  withExitCode(() => A.enable([], f.ctx));
  const xml = f.read();
  const lp = path.join(f.home, '.cheaper', 'autostart.log');

  assert.ok(xml.includes(`<key>StandardOutPath</key>\n  <string>${lp}</string>`), xml);
  assert.ok(xml.includes(`<key>StandardErrorPath</key>\n  <string>${lp}</string>`), xml);
  // Only the VALUES matter — the plist carries a comment naming gateway.log to explain
  // why it is not used, and an assertion that forbade the word would forbid the reason.
  assert.ok(!/<string>[^<]*gateway\.log<\/string>/.test(xml),
    'gateway.js opens gateway.log and fchmods it 0600 because it carries the request stream; '
    + 'launchd creates its own files under the user umask and would quietly widen it back out\n' + xml);

  assert.ok(fs.existsSync(lp), 'the log must exist and be locked down before anything can write to it');
  if (process.platform !== 'win32')
    assert.strictEqual(fs.statSync(lp).mode & 0o777, 0o600,
      'a world-readable service log is the defect gateway.js:352 already fixed once');
});

test('the entry carries a PATH that contains the resolved python — launchd sources no profile', () => {
  const f = fixture();
  withExitCode(() => A.enable([], f.ctx));
  const xml = f.read();
  const m = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(xml);
  assert.ok(m, 'the entry must carry an explicit PATH\n' + xml);
  const dirs = m[1].split(':');

  assert.ok(dirs.includes(path.dirname(FAKE_PY)),
    'gateway.js::pyExe() probes PATH for python3/python/py with NO absolute fallback, so a login '
    + 'entry without python\'s directory on PATH dies with "No usable Python 3 found" at every '
    + 'single respawn\n' + m[1]);
  assert.ok(dirs.includes(path.dirname(FAKE_NODE)), m[1]);
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])
    assert.ok(dirs.includes(d), `${d} missing from the baked PATH: ${m[1]}`);

  assert.ok(/<key>CHEAPER_PORT<\/key>\s*<string>8787<\/string>/.test(xml), xml);
});

test('enable prints the exact path it wrote AND the exact command that removes it', () => {
  const f = fixture();
  const { value } = withExitCode(() => A.enable([], f.ctx));
  const out = f.out();
  assert.strictEqual(value.ok, true, out);
  assert.ok(out.includes(f.plist()),
    '"how do I turn this off" must not require finding the docs\n' + out);
  assert.ok(out.includes('cheaper autostart disable'), out);
  assert.ok(/launchctl bootout gui\/501\/com\.beladed\.cheaper\.gateway/.test(out),
    'the by-hand escape hatch matters most when the CLI is gone\n' + out);
});

test('enable refuses when ~/.cheaper/cli is not staged — a unit pointing at nothing crash-loops silently', () => {
  const f = fixture({ stageCli: false });
  const { value, code } = withExitCode(() => A.enable([], f.ctx));
  assert.ok(!fs.existsSync(f.plist()),
    'an entry was registered against a script that does not exist. A supervisor pointed at a '
    + 'missing file does not fail loudly — it retries at ThrottleInterval forever, writing the '
    + 'same ENOENT into a log nobody opens\n' + f.out());
  assert.strictEqual(value.ok, false, f.out());
  assert.strictEqual(code, 1, f.out());
  assert.match(f.out(), /cheaper install cli/, 'the message must say how to fix it\n' + f.out());
  assert.match(f.out(), /AppImage/, 'the AppImage has no install step at all — say so\n' + f.out());
});

test('enable refuses when there is no usable Python, rather than writing an entry that cannot run', () => {
  const f = fixture({ py: null });
  const { value, code } = withExitCode(() => A.enable([], f.ctx));
  assert.strictEqual(value.ok, false);
  assert.strictEqual(code, 1);
  assert.ok(!fs.existsSync(f.plist()), f.out());
  assert.match(f.out(), /Python 3/, f.out());
});

test('`prepare` runs ONCE at enable time and is never part of the entry', () => {
  let prepared = 0;
  const f = fixture({ prepare: () => { prepared++; return true; } });
  withExitCode(() => A.enable([], f.ctx));
  assert.strictEqual(prepared, 1,
    'the dep install must happen here, deliberately, and not from a unit that reruns it on every respawn');
});

test('a `prepare` that did not succeed is reported, not swallowed', () => {
  const f = fixture({ prepare: () => false });
  withExitCode(() => A.enable([], f.ctx));
  assert.match(f.out(), /did not report success/, f.out());
});

// ==========================================================================
// 3. P1.3 — THE NVM HAZARD (drift detection)
// ==========================================================================

test('status reports a MISSING recorded node in words, and does not call that fine', () => {
  const f = fixture();
  withExitCode(() => A.enable([], f.ctx));
  // Simulate the Node upgrade that moves .../versions/node/vNN/bin/node out from under a
  // baked absolute path — the failure is invisible from the outside because the login
  // item simply never comes up.
  const st = A.readState(f.ctx);
  st.record.node = path.join(f.home, 'gone', 'node');
  A.writeState(f.ctx, { record: st.record });

  const { value, code } = withExitCode(() => A.status([], f.ctx));
  assert.strictEqual(code, 1, 'drift must not exit 0 — a script has only the code to read\n' + f.out());
  assert.strictEqual(value.drift, 1, f.out());
  assert.match(f.out(), /the recorded node no longer exists/, f.out());
  assert.match(f.out(), /cheaper autostart enable/, 'and it must say what fixes it\n' + f.out());
});

test('status re-resolves python and the CLI target too, and says which one is gone', () => {
  const f = fixture();
  withExitCode(() => A.enable([], f.ctx));
  fs.rmSync(f.entry, { force: true });
  const { value } = withExitCode(() => A.status([], f.ctx));
  assert.strictEqual(value.drift, 1, f.out());
  assert.match(f.out(), /the recorded CLI no longer exists/, f.out());
});

test('a clean status says so explicitly rather than by staying silent', () => {
  const f = fixture();
  withExitCode(() => A.enable([], f.ctx));
  const { value, code } = withExitCode(() => A.status([], f.ctx));
  assert.strictEqual(value.state, 'registered', f.out());
  assert.strictEqual(code, 0, f.out());
  assert.match(f.out(), /all still exist/, f.out());
});

test('looksVersionPinned recognises the version-managed node paths that get orphaned', () => {
  assert.ok(A.looksVersionPinned('/Users/x/.nvm/versions/node/v20.11.1/bin/node'), 'nvm');
  assert.ok(A.looksVersionPinned('/Users/x/.fnm/node-versions/v22.3.0/installation/bin/node'), 'fnm');
  assert.ok(A.looksVersionPinned('/Users/x/.volta/tools/image/node/20.11.1/bin/node'), 'volta');
  assert.ok(!A.looksVersionPinned('/usr/local/bin/node'), 'a system node is not version-pinned');
});

// ==========================================================================
// 4. "COULD NOT DETERMINE" IS ITS OWN ANSWER
// ==========================================================================

test('status reports UNKNOWN — not registered, not absent — when launchctl cannot be run', () => {
  const f = fixture();
  withExitCode(() => A.enable([], f.ctx));
  // ENOENT from spawnSync: no launchctl on PATH. spawnSync reports that as `error`,
  // never as a non-zero status, and collapsing it into "absent" would tell a user their
  // login item is gone when it may be running.
  f.ctx.run = () => ({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });
  const { value, code } = withExitCode(() => A.status([], f.ctx));
  assert.strictEqual(value.state, 'unknown', f.out());
  assert.strictEqual(code, 1, 'a check that could not run is not a pass\n' + f.out());
  assert.match(f.out(), /ENOENT/, 'and it must name why it could not tell\n' + f.out());
});

test('enable refuses to register on top of an UNKNOWN state', () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.plist()), { recursive: true });
  fs.writeFileSync(f.plist(), '<!-- someone else wrote this -->');
  const real = f.ctx.run;
  f.ctx.run = (cmd, args) => (cmd === 'launchctl' && args[0] === 'print'
    ? { error: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) }
    : real(cmd, args));

  const { value, code } = withExitCode(() => A.enable([], f.ctx));
  assert.strictEqual(value.ok, false, f.out());
  assert.strictEqual(code, 1, f.out());
  assert.match(f.out(), /could not determine/i, f.out());
  assert.strictEqual(fs.readFileSync(f.plist(), 'utf8'), '<!-- someone else wrote this -->',
    'registering blind risks a duplicate entry, or re-enabling one the user switched off');
});

test('an entry on disk that launchd has NOT loaded is its own state, not a green tick', () => {
  const f = fixture();
  // bootstrap "succeeds" but launchd still does not know the job — the shape of a
  // bootstrap that was accepted into a session that is not the one serving this login.
  f.ctx.run = (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'print-disabled') return { status: 0, stdout: EMPTY_DISABLED_LIST, stderr: '' };
    if (cmd === 'launchctl' && args[0] === 'print') return { status: 113, stdout: '', stderr: 'Could not find service\n' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const { value, code } = withExitCode(() => A.enable([], f.ctx));
  assert.strictEqual(value.ok, false, 'not verified is not ok\n' + f.out());
  assert.strictEqual(code, 1, f.out());
  assert.match(f.out(), /could not load it now|not loaded/i, f.out());
  assert.ok(fs.existsSync(f.plist()), 'the file is still written — LaunchAgents load at the next login');
});

// The `launchctl print-disabled` and `systemctl --user is-enabled` parses are the ONLY
// thing that can trigger the disabled-by-user refusal, and neither can be proven from this
// machine for the other OS. So the rule they are held to is not "parse the shapes we know"
// but "anything else is UNKNOWN": a shape that resolves to enabled/not-disabled is a
// silent re-registration over the switch the user flipped in System Settings.

test('an UNRECOGNISED `launchctl print-disabled` shape is unknown — never "not disabled"', () => {
  const shapes = {
    'a value word from neither vocabulary':
      `\tdisabled services = {\n\t\t"${A.LABEL}" => overridden\n\t}\n`,
    'output that is not the listing at all':
      'Login Items for user 501: com.beladed.cheaper.gateway is off\n',
  };

  for (const [what, stdout] of Object.entries(shapes)) {
    const f = fixture();
    withExitCode(() => A.enable([], f.ctx));            // a real entry exists first
    const written = f.read();
    const real = f.ctx.run;
    f.ctx.run = (cmd, args) => (cmd === 'launchctl' && args[0] === 'print-disabled'
      ? { status: 0, stdout, stderr: '' }
      : real(cmd, args));

    const st = withExitCode(() => A.status([], f.ctx));
    assert.strictEqual(st.value.state, 'unknown',
      `${what}: resolved to ${JSON.stringify(st.value.state)}. launchd was still asked whether the `
      + 'job is loaded, and a loaded job reads as "registered" — which enable() takes as "the user '
      + 'has not switched this off" and re-registers over their own off switch\n' + f.out());
    assert.strictEqual(st.code, 1, `${what}: a check that could not run is not a pass\n` + f.out());
    assert.match(f.out(), /could not determine whether you have disabled this entry/,
      `${what}: status must say it could not tell, not print something that reads as fine\n` + f.out());

    const en = withExitCode(() => A.enable([], f.ctx));
    assert.strictEqual(en.value.ok, false, `${what}: enable must refuse on unknown\n` + f.out());
    assert.strictEqual(f.read(), written, `${what}: and it must not rewrite the entry\n` + f.out());
  }
});

test('the `launchctl print-disabled` vocabularies both builds emit are still read exactly', () => {
  // Verified against macOS 26 (Darwin 25.3), which prints `=> disabled` / `=> enabled`;
  // older builds print `=> true` / `=> false`. Both mean the same two things, and an
  // entry the user did NOT override is simply absent from the listing.
  const reg = (stdout) => {
    const f = fixture();
    fs.mkdirSync(path.dirname(f.plist()), { recursive: true });
    fs.writeFileSync(f.plist(), '<!-- x -->');
    const real = f.ctx.run;
    f.ctx.run = (cmd, args) => (cmd === 'launchctl' && args[0] === 'print-disabled'
      ? { status: 0, stdout, stderr: '' }
      : real(cmd, args));
    return A.registration(f.ctx).state;
  };
  const listing = (body) => `\tdisabled services = {\n${body}\t}\n`;

  for (const word of ['disabled', 'true'])
    assert.strictEqual(reg(listing(`\t\t"${A.LABEL}" => ${word}\n`)), 'disabled-by-user', word);
  for (const word of ['enabled', 'false'])
    assert.notStrictEqual(reg(listing(`\t\t"${A.LABEL}" => ${word}\n`)), 'disabled-by-user', word);
  assert.notStrictEqual(reg(listing('\t\t"com.example.other" => disabled\n')), 'unknown',
    'a well-formed listing that does not name our label means no override — reading that as '
    + '"unknown" would refuse every enable on a normal mac');
  assert.notStrictEqual(reg(listing('')), 'unknown',
    'a machine with no overrides at all prints the header and no entries');
});

test('an UNRECOGNISED `systemctl --user is-enabled` word is unknown — never "not disabled"', () => {
  const f = fixture({ platform: 'linux' });
  withExitCode(() => A.enable([], f.ctx));
  const unitPath = path.join(f.home, '.config', 'systemd', 'user', A.UNIT_NAME);
  const written = fs.readFileSync(unitPath, 'utf8');

  const real = f.ctx.run;
  // A localised systemd, or a newer word than this build knows. The old parse fell through
  // to "the unit file exists; systemd reports X" — a positive state that enable() treats
  // as re-registrable.
  f.ctx.run = (cmd, args) => (cmd === 'systemctl' && args[1] === 'is-enabled'
    ? { status: 0, stdout: 'aktiviert\n', stderr: '' }
    : real(cmd, args));

  const st = withExitCode(() => A.status([], f.ctx));
  assert.strictEqual(st.value.state, 'unknown', st.value.state + '\n' + f.out());
  assert.strictEqual(st.code, 1, f.out());
  assert.match(f.out(), /could not determine whether you have disabled this entry/, f.out());

  const en = withExitCode(() => A.enable([], f.ctx));
  assert.strictEqual(en.value.ok, false, f.out());
  assert.strictEqual(fs.readFileSync(unitPath, 'utf8'), written,
    'the unit was rewritten on top of a state we could not read\n' + f.out());
});

test('the systemd state words are an ALLOWLIST, not a prefix match', () => {
  const reg = (stdout, status = 0) => {
    const f = fixture({ platform: 'linux' });
    fs.mkdirSync(path.dirname(A.agentPath(f.ctx)), { recursive: true });
    fs.writeFileSync(A.agentPath(f.ctx), '# x\n');
    const real = f.ctx.run;
    f.ctx.run = (cmd, args) => (cmd === 'systemctl' && args[1] === 'is-enabled'
      ? { status, stdout, stderr: '' }
      : real(cmd, args));
    return A.registration(f.ctx).state;
  };

  assert.strictEqual(reg('enabled\n'), 'registered');
  assert.strictEqual(reg('enabled-runtime\n'), 'registered',
    'a `systemctl --user enable --runtime` unit IS enabled; dropping it would refuse a real one');
  for (const w of ['disabled', 'masked', 'masked-runtime'])
    assert.strictEqual(reg(`${w}\n`, 1), 'disabled-by-user', w);
  // These are real systemctl words, and none of them answers the question this file asks.
  for (const w of ['static', 'indirect', 'generated', 'transient', 'linked', 'alias', 'bad'])
    assert.strictEqual(reg(`${w}\n`, 1), 'unknown',
      `"${w}" is not an answer to "has the user switched this off", and treating it as one lets `
      + 'enable() write over their decision');
});

// ==========================================================================
// 5. P3.3 — the port is machine-wide, the entry is per-user
// ==========================================================================

test('an EXPLICIT --port that is taken by something else is REFUSED, never silently moved', () => {
  // ONLY 9000 is busy — every neighbouring port is free. That matters: if the fixture made
  // all ports busy, the refusal would happen because nothing was free and this test would
  // pass even with the explicit-port guard deleted.
  const f = fixture({ probePort: (p) => ({ state: String(p) === '9000' ? 'in-use' : 'free', detail: 'bound' }) });
  const { value, code } = withExitCode(() => A.enable(['--port', '9000'], f.ctx));
  assert.strictEqual(value.port, undefined,
    'the caller NAMED a port. Writing a different number into a plist they will never open is '
    + 'the confident-wrong answer this codebase keeps refusing to give — their client is still '
    + 'pointed at 9000\n' + f.out());
  assert.strictEqual(value.ok, false, f.out());
  assert.strictEqual(code, 1, f.out());
  assert.ok(!fs.existsSync(f.plist()), 'nothing may be written\n' + f.out());
  assert.match(f.out(), /9000 is already taken/, f.out());
  assert.match(f.out(), /--port 9001/, 'and it must offer a way forward\n' + f.out());
});

test('the DEFAULT port, when taken by another user, is moved — and the move is announced', () => {
  const busy = new Set(['8787']);
  const f = fixture({ probePort: (p) => ({ state: busy.has(String(p)) ? 'in-use' : 'free', detail: 'x' }) });
  const { value } = withExitCode(() => A.enable([], f.ctx));
  assert.strictEqual(value.ok, true, f.out());
  assert.strictEqual(value.port, '8788',
    '127.0.0.1:8787 is machine-wide but the login entry is per-user: a second logged-in user '
    + 'means the loser crash-loops on EADDRINUSE every 30s with nothing on screen to explain it');
  assert.match(f.out(), /was taken/, 'a silently different port is a gateway the user cannot find\n' + f.out());
  assert.ok(f.read().includes('<string>8788</string>'), f.read());
});

test('this user\'s OWN running gateway on the port is not a collision', () => {
  const f = fixture({
    probePort: () => ({ state: 'in-use', detail: 'bound' }),
    ownGatewayHoldsPort: (p) => String(p) === '8787',
  });
  const { value } = withExitCode(() => A.enable([], f.ctx));
  assert.strictEqual(value.ok, true, f.out());
  assert.strictEqual(value.port, '8787',
    'the login entry starts at the NEXT login, by which time this process is gone — moving to '
    + 'another port here would strand the user on a URL they are not using');
});

test('a port check that CANNOT RUN refuses the enable rather than guessing', () => {
  const f = fixture({ probePort: () => ({ state: 'unknown', detail: 'the port check could not be run (ENOENT)' }) });
  const { value, code } = withExitCode(() => A.enable([], f.ctx));
  assert.strictEqual(value.ok, false,
    '"could not tell whether the port is free" was treated as "it is free". An entry that '
    + 'cannot bind crash-loops every 30s at every login with nothing on screen to explain it — '
    + 'a check that could not run is not a pass\n' + f.out());
  assert.strictEqual(code, 1, f.out());
  assert.ok(!fs.existsSync(f.plist()), 'and nothing may be written\n' + f.out());
  assert.match(f.out(), /could not determine whether port 8787 is free/, f.out());
});

test('an unusable --port is a hard error, borrowed straight from gateway.resolvePort', () => {
  const f = fixture();
  const { value, code } = withExitCode(() => A.enable(['--port', 'lots'], f.ctx));
  assert.strictEqual(value.ok, false, f.out());
  assert.strictEqual(code, 1);
  assert.ok(!fs.existsSync(f.plist()), f.out());
  assert.match(f.out(), /--port is not a port number/, f.out());
});

test('the real port probe answers free / in-use / unknown, and never confuses them', () => {
  // The one place a real socket is used, and it is an EPHEMERAL port on loopback chosen
  // by the kernel — never 8787, and never a gateway.
  const net = require('net');
  const srv = net.createServer(() => {});
  return new Promise((resolve, reject) => {
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      try {
        assert.deepStrictEqual(A.probePortSync(p).state, 'in-use', 'a live listener must read as in-use');
        // A probe that cannot be run is UNKNOWN, never "free" — treating it as free is
        // how a crash-looping entry gets written.
        const cannotRun = A.probePortSync(p, () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }));
        assert.strictEqual(cannotRun.state, 'unknown', JSON.stringify(cannotRun));
        assert.match(cannotRun.detail, /could not be run/);
        srv.close(() => {
          try {
            assert.strictEqual(A.probePortSync(p).state, 'free', 'and a released port must read as free');
            resolve();
          } catch (e) { reject(e); }
        });
      } catch (e) { srv.close(); reject(e); }
    });
  });
});

// ==========================================================================
// 6. LINUX
// ==========================================================================

test('linux REFUSES IN WORDS with no session bus, instead of writing a dead unit', () => {
  const f = fixture({ platform: 'linux', noBus: true, env: { USER: 'tester' } });
  const { value, code } = withExitCode(() => A.enable([], f.ctx));
  assert.ok(!fs.existsSync(path.join(f.home, '.config', 'systemd', 'user', A.UNIT_NAME)),
    'a unit file was written with no session bus to start it. `systemctl --user` cannot work '
    + 'over ssh, in most containers, or from cron — the unit looks installed, never starts, and '
    + 'reports nothing. Refuse in words instead of writing a dead unit\n' + f.out());
  assert.strictEqual(value.ok, false, f.out());
  assert.strictEqual(code, 1);
  assert.match(f.out(), /XDG_RUNTIME_DIR/, f.out());
  assert.match(f.out(), /DBUS_SESSION_BUS_ADDRESS/, f.out());
  assert.match(f.out(), /ssh session, a container, or a cron job/, f.out());
});

test('the linux unit is Restart=on-failure / RestartSec=30 / WantedBy=default.target, running `serve`', () => {
  const f = fixture({ platform: 'linux' });
  const { value } = withExitCode(() => A.enable([], f.ctx));
  assert.strictEqual(value.ok, true, f.out());
  const unit = fs.readFileSync(path.join(f.home, '.config', 'systemd', 'user', A.UNIT_NAME), 'utf8');

  assert.match(unit, /^Restart=on-failure$/m,
    'Restart=always would answer a deliberate `systemctl --user stop` with a respawn, leaving no off switch\n' + unit);
  // Same cross-file dependency as the plist's KeepAlive dict: on-failure restarts a
  // NON-ZERO exit, and what systemd supervises is the `gateway serve` CLI, which forwards
  // the signal and then exits with a code of its own. The live-SIGTERM test above is the
  // pin; this keeps the shipped unit from going back to claiming on-failure is enough.
  assert.match(unit, /exits 0 on a deliberate/,
    'the unit ships this comment to the user\'s machine; it must name the exit-code contract '
    + 'it depends on rather than implying Restart=on-failure provides the off switch by itself\n' + unit);
  assert.match(unit, /^RestartSec=30$/m, unit);
  assert.match(unit, /^WantedBy=default\.target$/m, unit);
  assert.match(unit, /^ExecStart=.*gateway serve --port 8787$/m, unit);
  assert.ok(unit.includes(`Environment=PATH=`) && unit.includes(path.dirname(FAKE_PY)),
    'systemd --user sources no profile either\n' + unit);
  assert.ok(f.state.calls.includes(`systemctl --user enable --now ${A.UNIT_NAME}`), f.state.calls.join('\n'));
});

test('linux PRINTS the lingering caveat rather than papering over it', () => {
  const f = fixture({ platform: 'linux', linger: 'no' });
  withExitCode(() => A.enable([], f.ctx));
  assert.match(f.out(), /loginctl enable-linger tester/,
    'without lingering the user manager is torn down at logout and the gateway dies with it\n' + f.out());
});

test('a lingering check that could not run is reported as unknown, not as "fine"', () => {
  const f = fixture({ platform: 'linux' });
  const real = f.ctx.run;
  f.ctx.run = (cmd, args) => (cmd === 'loginctl'
    ? { error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }
    : real(cmd, args));
  withExitCode(() => A.enable([], f.ctx));
  assert.match(f.out(), /could not determine whether lingering/, f.out());
  assert.match(f.out(), /enable-linger/, f.out());
});

// ==========================================================================
// 7. WINDOWS
// ==========================================================================

test('windows registers a Scheduled Task (ONLOGON, non-elevated) and writes no file at all', () => {
  const f = fixture({ platform: 'win32' });
  const { value } = withExitCode(() => A.enable([], f.ctx));
  assert.strictEqual(value.ok, true, f.out());

  const create = f.state.calls.find((l) => l.startsWith('schtasks /Create'));
  assert.ok(create, 'schtasks is preferred over a Startup-folder shortcut: no console flash, '
    + 'queryable, and switchable off from Task Scheduler\n' + f.state.calls.join('\n'));
  assert.ok(create.includes('/SC ONLOGON'), create);
  assert.ok(create.includes('/RL LIMITED'), 'a login item that demands admin is one the user should refuse\n' + create);
  assert.ok(create.includes('/F'), create);
  assert.ok(create.includes(f.winCmd), 'it must point at the stable cheaper.cmd clilink.js writes\n' + create);
  assert.ok(create.includes('gateway serve'), create);

  assert.ok(!fs.existsSync(path.join(f.home, 'Library')), 'no plist on windows');
  assert.ok(!fs.existsSync(path.join(f.home, '.config')), 'no systemd unit on windows');
});

test('windows reports a task the user disabled in Task Scheduler, and refuses to recreate it', () => {
  const f = fixture({ platform: 'win32', taskExists: true, disabled: true });
  const { value } = withExitCode(() => A.status([], f.ctx));
  assert.strictEqual(value.state, 'disabled-by-user', f.out());

  const g = fixture({ platform: 'win32', taskExists: true, disabled: true });
  const r = withExitCode(() => A.enable([], g.ctx));
  assert.strictEqual(r.value.ok, false, g.out());
  assert.ok(!g.state.calls.some((l) => l.startsWith('schtasks /Create')), g.state.calls.join('\n'));
});

test('a schtasks Status this build cannot read is unknown — a localised Windows must not read as live', () => {
  // Same fail-closed rule as launchctl/systemctl, and the same consent stake: "registered"
  // is what enable() reads as "the user has not switched this off". `Status: Deaktiviert`
  // is a German Windows saying Disabled — the exact case where guessing "it is fine"
  // recreates a task the user turned off in Task Scheduler.
  for (const status of ['Deaktiviert', '']) {
    const f = fixture({ platform: 'win32', taskExists: true });
    const real = f.ctx.run;
    f.ctx.run = (cmd, args) => (cmd === 'schtasks' && args[0] === '/Query'
      ? { status: 0, stdout: `TaskName: \\${A.TASK_NAME}\n${status ? `Status: ${status}\n` : ''}`, stderr: '' }
      : real(cmd, args));

    const st = withExitCode(() => A.status([], f.ctx));
    assert.strictEqual(st.value.state, 'unknown',
      `Status ${JSON.stringify(status)} resolved to ${JSON.stringify(st.value.state)}\n` + f.out());
    assert.strictEqual(st.code, 1, f.out());
    assert.match(f.out(), /could not determine whether you have disabled this task/, f.out());

    const en = withExitCode(() => A.enable([], f.ctx));
    assert.strictEqual(en.value.ok, false, 'enable must refuse on unknown\n' + f.out());
    assert.ok(!f.state.calls.some((l) => l.startsWith('schtasks /Create')),
      'and nothing may be recreated over a state we could not read\n' + f.state.calls.join('\n'));
  }
});

// ==========================================================================
// 8. P1.4 — UNINSTALL SYMMETRY
// ==========================================================================

test('disable DEREGISTERS BEFORE it deletes the file it wrote', () => {
  const f = fixture();
  withExitCode(() => A.enable([], f.ctx));
  assert.ok(fs.existsSync(f.plist()));
  f.state.calls.length = 0; f.state.fileAtCall.length = 0;

  const { value } = withExitCode(() => A.disable([], f.ctx));
  assert.strictEqual(value.ok, true, f.out());

  const bootout = f.state.fileAtCall.find((c) => c.line.startsWith('launchctl bootout'));
  assert.ok(bootout, 'deregistration must actually be attempted\n' + f.state.calls.join('\n'));
  assert.strictEqual(bootout.entryExisted, true,
    'the plist must still be on disk when launchd is told to drop the job. Delete-then-deregister '
    + 'leaves launchd holding a job definition that points at a deleted file, retried at every '
    + 'login, with no `cheaper` command left to switch it off');
  assert.ok(!fs.existsSync(f.plist()), 'and then the file is removed\n' + f.out());
});

test('a FAILED deregistration KEEPS the entry file — deleting it strands the job in launchd', () => {
  const f = fixture();
  withExitCode(() => A.enable([], f.ctx));
  assert.ok(fs.existsSync(f.plist()));
  const written = f.read();

  // bootout refused for a real reason (EPERM is the common one: a job bootstrapped into a
  // different session, or an MDM-managed label), and launchd still lists the job.
  f.ctx.run = (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'print-disabled') return { status: 0, stdout: EMPTY_DISABLED_LIST, stderr: '' };
    if (cmd === 'launchctl' && args[0] === 'print') return { status: 0, stdout: 'state = running\n', stderr: '' };
    if (cmd === 'launchctl' && (args[0] === 'bootout' || args[0] === 'unload'))
      return { status: 5, stdout: '', stderr: 'Operation not permitted\n' };
    return { status: 0, stdout: '', stderr: '' };
  };

  const { value, code } = withExitCode(() => A.disable([], f.ctx));

  // Existence FIRST, and with the whole explanation on it: reading a deleted file throws a
  // bare ENOENT, and an ENOENT does not tell the next person what broke.
  assert.ok(fs.existsSync(f.plist()),
    'the plist was deleted after a deregistration that FAILED. launchd is still holding a job '
    + 'whose ProgramArguments name a file that no longer exists: it retries at every login, '
    + '`cheaper autostart status` can no longer see it, and the `rm` in the manual command has '
    + 'nothing left to remove. Deregister-then-delete is only half the fix — the delete has to be '
    + 'conditional on the deregister\n' + f.out());
  assert.strictEqual(fs.readFileSync(f.plist(), 'utf8'), written,
    'the kept plist must be the one that was written, untouched\n' + f.out());
  assert.strictEqual(value.ok, false, '"the file is gone" is not "the job is gone"\n' + f.out());
  assert.strictEqual(code, 1, f.out());
  assert.match(f.out(), /could NOT deregister/i, f.out());
  assert.match(f.out(), /KEPT on purpose/, 'keeping the file is deliberate; say so\n' + f.out());
  assert.match(f.out(), /launchctl bootout gui\/501\/com\.beladed\.cheaper\.gateway/,
    'and the exact manual command must be printed — it is the only way out left\n' + f.out());
  assert.match(value.msg, /NOT deregistered/, value.msg);
  assert.notStrictEqual(A.readState(f.ctx).enabled, false,
    'the entry is still live, so the state file must not record it as disabled — `cheaper status` '
    + 'and `uninstall --purge` both read that flag');
});

test('a deregistration that failed only because NOTHING WAS LOADED still removes the file', () => {
  const f = fixture();
  withExitCode(() => A.enable([], f.ctx));

  // `launchctl bootout` on a job launchd does not have exits 3 ("No such process"). That
  // is not a failure to deregister, it is nothing to deregister — and the file must still
  // go, or `disable` would leave a plist behind that loads at the next login.
  f.ctx.run = (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'print-disabled') return { status: 0, stdout: EMPTY_DISABLED_LIST, stderr: '' };
    if (cmd === 'launchctl' && args[0] === 'print') return { status: 113, stdout: '', stderr: 'Could not find service\n' };
    if (cmd === 'launchctl' && (args[0] === 'bootout' || args[0] === 'unload'))
      return { status: 3, stdout: '', stderr: 'No such process\n' };
    return { status: 0, stdout: '', stderr: '' };
  };

  const { value, code } = withExitCode(() => A.disable([], f.ctx));
  assert.ok(!fs.existsSync(f.plist()),
    'a plist left on disk loads at the next login, so "there was no job to boot out" must not '
    + 'block the removal\n' + f.out());
  assert.strictEqual(value.ok, true, f.out());
  assert.strictEqual(code, 0, f.out());
  assert.strictEqual(A.readState(f.ctx).enabled, false, 'and the disable is recorded');
});

test('a disable that cannot CONFIRM removal says so and exits non-zero', () => {
  const f = fixture();
  withExitCode(() => A.enable([], f.ctx));
  // launchctl keeps insisting the job is loaded — the file is gone but the session is not.
  f.ctx.run = (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'print-disabled') return { status: 0, stdout: EMPTY_DISABLED_LIST, stderr: '' };
    if (cmd === 'launchctl' && args[0] === 'print') return { status: 0, stdout: 'state = running\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const { value, code } = withExitCode(() => A.disable([], f.ctx));
  assert.strictEqual(value.ok, false, f.out());
  assert.strictEqual(code, 1, '"probably removed" is not a claim this may make\n' + f.out());
  assert.match(f.out(), /could not confirm/i, f.out());
  assert.match(f.out(), /launchctl bootout/, 'and it must hand over the manual command\n' + f.out());
});

test('uninstall.js lists autostart BEFORE gateway — order is the whole fix', () => {
  const un = require('../src/uninstall');
  const keys = un.COMPONENTS.map((x) => x.key);
  assert.ok(keys.includes('autostart'),
    'without an autostart entry, `cheaper uninstall` deletes ~/.cheaper/gateway while the '
    + 'LaunchAgent stays loaded, retrying a deleted binary at every login');
  assert.ok(keys.indexOf('autostart') < keys.indexOf('gateway'),
    'the supervisor must be deregistered before its files are deleted; stopGatewayIfRunning sends '
    + 'ONE SIGTERM and KeepAlive answers a SIGTERM with a respawn\n' + keys.join(' -> '));
});

// The next three tests drive uninstall.js's real code with autostart.js's disable()
// swapped for a spy. They restore the module afterwards, in a finally, so nothing leaks
// into the tests above or below.
function withStubbedAutostart(stub, fn) {
  const saved = {};
  for (const k of Object.keys(stub)) saved[k] = A[k];
  Object.assign(A, stub);
  try { return fn(); } finally { Object.assign(A, saved); }
}

test('a SCOPED `uninstall gateway` still deregisters the entry first — the user need not know to ask', () => {
  const P = require('../src/paths');
  fs.mkdirSync(P.GATEWAY_DIR, { recursive: true });
  const seen = [];
  withStubbedAutostart({
    isRegisteredOnDisk: () => true,
    disable: () => { seen.push({ gatewayStillThere: fs.existsSync(P.GATEWAY_DIR) }); return { ok: true, msg: 'autostart -> deregistered' }; },
  }, () => {
    const results = require('../src/uninstall').uninstall({ components: ['gateway'] });
    assert.ok(results.some((r) => r.key === 'autostart' && r.ok),
      'naming only the gateway must not leave the supervisor pointing at what was just deleted\n' +
      JSON.stringify(results, null, 2));
  });
  assert.strictEqual(seen.length, 1, 'disable must be called exactly once');
  assert.strictEqual(seen[0].gatewayStillThere, true,
    'and it must run BEFORE the gateway directory is removed');
  assert.ok(!fs.existsSync(P.GATEWAY_DIR), 'the gateway is still removed afterwards');
});

test('--purge REFUSES while an autostart entry it cannot remove is still registered', () => {
  const P = require('../src/paths');
  fs.mkdirSync(P.CHEAPER_DIR, { recursive: true });
  const marker = path.join(P.CHEAPER_DIR, 'metrics.db');
  fs.writeFileSync(marker, 'x');

  const results = withStubbedAutostart({
    isRegisteredOnDisk: () => true,
    disable: () => ({ ok: false, msg: 'autostart -> NOT confirmed removed (launchd still lists it)' }),
  }, () => require('../src/uninstall').uninstall({ components: ['gateway'], purge: true }));

  const purge = results.find((r) => r.key === 'purge');
  assert.ok(purge && purge.ok === false,
    'purging deletes ~/.cheaper including CLI_HOME — the very script the LaunchAgent names\n' +
    JSON.stringify(results, null, 2));
  assert.match(purge.msg, /refusing to delete/, purge.msg);
  assert.ok(fs.existsSync(marker),
    'an un-purged ~/.cheaper is recoverable; a login item pointing at a deleted CLI with no '
    + '`cheaper` binary left to disable it is not');
});

test('--purge proceeds once the entry IS deregistered, and deregisters it first', () => {
  const P = require('../src/paths');
  fs.mkdirSync(P.CHEAPER_DIR, { recursive: true });
  fs.writeFileSync(path.join(P.CHEAPER_DIR, 'metrics.db'), 'x');
  let cheaperDirAtDisable = null;

  const results = withStubbedAutostart({
    isRegisteredOnDisk: () => true,
    disable: () => {
      cheaperDirAtDisable = fs.existsSync(P.CHEAPER_DIR);
      return { ok: true, msg: 'autostart -> deregistered' };
    },
  }, () => require('../src/uninstall').uninstall({ components: [], purge: true }));

  assert.strictEqual(cheaperDirAtDisable, true, 'deregister happens while the files still exist');
  const purge = results.find((r) => r.key === 'purge');
  assert.ok(purge && purge.ok, JSON.stringify(results, null, 2));
  assert.ok(!fs.existsSync(P.CHEAPER_DIR), 'and the purge still happens');
});

// ==========================================================================
// 9. DISPATCH
// ==========================================================================

test('`cheaper autostart <bad>` and a bare `cheaper autostart` both exit non-zero', () => {
  const env = Object.assign({}, process.env, {
    HOME: SANDBOX, USERPROFILE: SANDBOX, CLAUDE_CONFIG_DIR: path.join(SANDBOX, '.claude'),
  });
  for (const args of [['autostart'], ['autostart', 'enablee']]) {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000, env,
    });
    const out = strip((r.stdout || '') + (r.stderr || ''));
    assert.strictEqual(r.status, 1, `\`cheaper ${args.join(' ')}\` must not report success\n` + out);
    assert.ok(out.includes('usage: cheaper autostart'), out);
  }
});

test('`cheaper autostart status` is dispatched — not treated as an unknown command', () => {
  const home = fs.mkdtempSync(path.join(SANDBOX, 'disp-'));
  const r = spawnSync(process.execPath, [BIN, 'autostart', 'status'], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000,
    env: Object.assign({}, process.env, {
      HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    }),
  });
  const out = strip((r.stdout || '') + (r.stderr || ''));
  assert.ok(!out.includes('Unknown command'), out);
  assert.match(out, /autostart:/, out);
  assert.ok(!fs.existsSync(path.join(home, 'Library', 'LaunchAgents')),
    'a status query must never register anything\n' + out);
});

test('`cheaper autostart --help` prints its three entries and registers nothing', () => {
  const home = fs.mkdtempSync(path.join(SANDBOX, 'help-'));
  const r = spawnSync(process.execPath, [BIN, 'autostart', '--help'], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000,
    env: Object.assign({}, process.env, {
      HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    }),
  });
  const out = strip((r.stdout || '') + (r.stderr || ''));
  assert.strictEqual(r.status, 0, out);
  for (const s of ['autostart enable', 'autostart disable', 'autostart status'])
    assert.ok(out.includes(s), s + ' missing from help\n' + out);
  assert.match(out, /Never enabled by "cheaper install" or --all/,
    'the help must state the consent rule, not just the mechanism\n' + out);
  assert.deepStrictEqual(fs.readdirSync(home), [], 'help must have no side effects\n' + out);
});

test.after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });
