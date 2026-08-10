'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const P = require('./paths');
const { c } = require('./util');
const { promptThenOpen } = require('./openurl');

const DEFAULT_PORT = '8787';

// The port a caller gets when it asks for nothing. Still exported and read from the
// environment at load time for monitor.js:14, its ONLY importer now — launch.js dropped
// its `gateway.PORT` for freshness.activeGatewayPort() (launch.js:20-31). It is NOT what
// start()/serve() bind: those call resolvePort(argv), which can see a per-command --port.
const PORT = process.env.CHEAPER_PORT || DEFAULT_PORT;

// Candidate Python launchers, in resolution order. A candidate is a COMMAND PLUS ITS
// PREFIX ARGS, not a bare name, because the Windows launcher needs `-3` to select a
// Python 3 — `py` alone can land on a Python 2 the user still has installed.
//
// `py -3` is last on purpose: on macOS/Linux `py` does not exist, so the first two
// candidates resolve exactly as they always did and this list changes nothing there.
// On a stock python.org Windows install with "Add python.exe to PATH" left UNCHECKED
// — the default — `python3` and `python` resolve only to the Microsoft Store *alias
// stub*, which exits non-zero, so both probes correctly fail and `py -3` (installed
// into System32 by every python.org installer, PATH or not) is the only thing left.
// Without it the gateway was unstartable on a default Windows Python.
const PY_CANDIDATES = [
  { cmd: 'python3', args: [] },
  { cmd: 'python', args: [] },
  { cmd: 'py', args: ['-3'] },
];

// How a launcher is written in a message ("py -3", "python3").
function launcherLabel(l) {
  return l ? [l.cmd, ...l.args].join(' ') : 'python3';
}

// Resolve a usable Python 3, or NULL when there is none.
//
// It returns null rather than the literal string 'python3' it used to fall back to.
// That fallback looked harmless and was not: `spawn()` is ASYNCHRONOUS, so handing it
// a name that is known not to exist does not fail at the call — it fails later, as an
// 'error' EVENT, which with no listener Node re-throws as an UNCAUGHT EXCEPTION. The
// user got a raw stack trace instead of "install Python". Null forces the caller to
// decide, before spawning anything, and to say so in words.
//
// `probe` is injectable so the candidate-selection logic can be tested without a
// machine that actually lacks Python; it defaults to the real spawnSync.
function pyExe(probe = spawnSync) {
  for (const cand of PY_CANDIDATES) {
    // `--version` must be APPENDED to the launcher's own args: `py -3 --version`,
    // not `py --version` (which reports the launcher's version, not a Python's).
    const r = probe(cand.cmd, [...cand.args, '--version'], { stdio: 'ignore' });
    if (r && r.status === 0) return cand;
  }
  return null;
}

// What to tell someone who has no usable Python. Actionable, per-platform, and it
// names every candidate that was tried so the message is checkable.
function noPythonHelp() {
  const tried = PY_CANDIDATES.map(launcherLabel).join(', ');
  const lines = [
    c.red('  No usable Python 3 found.') + c.dim(`  Tried: ${tried}`),
    c.dim('  The gateway is a Python service; it cannot start without one.'),
  ];
  if (process.platform === 'win32')
    lines.push(c.dim('  Install it from ') + 'https://www.python.org/downloads/' +
      c.dim('  — tick "Add python.exe to PATH", or keep the bundled `py` launcher on PATH.'));
  else if (process.platform === 'darwin')
    lines.push(c.dim('  Install it with:  ') + 'brew install python3' +
      c.dim('   (or from https://www.python.org/downloads/)'));
  else
    lines.push(c.dim('  Install it with:  ') + 'apt install python3' +
      c.dim('  /  ') + 'dnf install python3');
  return lines.join('\n');
}

function ensureInstalled() {
  if (!fs.existsSync(P.GATEWAY_DIR)) {
    console.log(c.red('  Gateway not installed. Run: ') + 'cheaper install gateway');
    process.exit(1);
  }
}

// ---- port resolution --------------------------------------------------------
//
// `--port` beats CHEAPER_PORT beats 8787.
//
// A flag had to exist because a supervisor reads NO shell profile: launchd and systemd
// start the gateway with a near-empty environment, so `export CHEAPER_PORT=9000` in a
// .zshrc is visible to the human typing `cheaper gateway stop` and invisible to the
// autostarted service. The result was two gateways — one on 9000 started by hand, one
// on 8787 started by the supervisor — sharing ONE pid file, so `stop` reported success
// while the other one kept serving. A flag is a value both sides can be told.
//
// An unusable value is a HARD ERROR and never a silent fall back to 8787. Binding a
// port the caller did not ask for is worse than refusing to start: the printed
// ANTHROPIC_BASE_URL then names a port nothing is listening on, and the failure
// resurfaces later, in the caller's client, as a connection error with no mention of
// Cheaper. The source of the bad value is named so the message points at the right
// place to fix (a flag in a plist vs. an export in a profile).
function validatePort(raw, source) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { port: null, source, error: `${source} needs a port number (1-65535).` };
  // Digits only. `parseInt` alone accepts "8787x" and "0x1f3", which would bind a port
  // the user did not write.
  if (!/^\d+$/.test(s)) return { port: null, source, error: `${source} is not a port number: ${JSON.stringify(s)}` };
  const n = Number(s);
  // 0 is rejected deliberately: to bind(2) it means "any free port", which the kernel
  // picks and never tells us — the pid file would then record a port that is a lie and
  // stop/status would act on the wrong gateway, the exact failure the port field exists
  // to prevent.
  if (n < 1 || n > 65535) return { port: null, source, error: `${source} is out of range (1-65535): ${s}` };
  return { port: String(n), source, error: null };
}

// Read `--port 9000` / `--port=9000` out of an argv. Returns undefined when the flag is
// absent (so "flag not given" stays distinguishable from "flag given empty", which is a
// user error worth reporting rather than silently ignoring).
function readPortFlag(argv = []) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') return argv[i + 1] === undefined ? '' : argv[i + 1];
    if (typeof a === 'string' && a.startsWith('--port=')) return a.slice('--port='.length);
  }
  return undefined;
}

function resolvePort(argv = [], env = process.env) {
  const flag = readPortFlag(argv);
  if (flag !== undefined) return validatePort(flag, '--port');
  const fromEnv = env.CHEAPER_PORT;
  if (fromEnv !== undefined && String(fromEnv).trim() !== '') return validatePort(fromEnv, 'CHEAPER_PORT');
  return { port: DEFAULT_PORT, source: 'default', error: null };
}

// ---- the pid file -----------------------------------------------------------
//
// Written as:
//
//     <pid>\nport=<port>\n
//
// The pid is ALONE ON THE FIRST LINE, and that shape is load-bearing rather than
// cosmetic. uninstall.js, launch.js and the desktop app all read this file with a bare
// `parseInt(fs.readFileSync(...), 10)`; parseInt stops at the first non-digit, so a
// leading pid keeps every one of those readers working unchanged. A JSON pid file would
// have made all three parse NaN and report "no running gateway" against a live one.
//
// The port is recorded because the pid file is the only thing stop/status have to go on,
// and "which port" is not derivable from the environment they run in — see resolvePort.
function writePidFile(pid, port) {
  fs.writeFileSync(P.GATEWAY_PID, `${pid}\nport=${port}\n`);
}

// Returns { pid, port } — with `port: null` when the file predates the port line.
// null port means UNKNOWN, not 8787: reporting the current default for a gateway that
// may well have been started with a different one is exactly the confident-wrong answer
// this file is here to avoid.
function readPidFile() {
  let raw;
  try { raw = fs.readFileSync(P.GATEWAY_PID, 'utf8'); } catch { return null; }
  const lines = String(raw).split(/\r?\n/);
  const head = (lines[0] || '').trim();
  // Backward compatibility with the bare-pid file older builds wrote (digits, nothing
  // else). It is a valid pid record with an unknown port, not a corrupt file.
  const pid = /^\d+$/.test(head) ? Number(head) : NaN;
  let port = null;
  for (const line of lines.slice(1)) {
    const m = /^port=(\d+)$/.exec(line.trim());
    if (m) { port = m[1]; break; }
  }
  return { pid, port, raw };
}

// Does a pid exist? EPERM means it exists and belongs to someone else — that is ALIVE,
// not gone; treating it as gone would clear a pid file for a running process.
function pidAlive(pid) {
  if (!(pid > 1)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

// What is pid N, really?
//
// gateway.pid is persistent — nothing clears it on a crash, a SIGKILL or a reboot — and
// pids are reused. After a reboot the number in that file routinely belongs to something
// else entirely, so `cheaper gateway stop` would SIGTERM an unrelated process of the
// user's. Identity, not liveness, is what earns a signal.
//
// The three answers are kept apart on purpose:
//   'gateway'  verified ours          -> safe to signal
//   'other'    verified NOT ours      -> must not signal; the pid file is stale
//   'gone'     the process is not listed
//   'unknown'  the check itself could not run -> must not signal, and must not be
//              reported as either of the above. A check that cannot run is not a pass.
//
// `probe` is injectable so all four branches are testable without arranging a real
// process of each kind on the machine running the tests.
function identifyPid(pid, probe = spawnSync) {
  if (!(pid > 1)) return { state: 'other', detail: `${pid} is not a signalable pid` };
  let r;
  try {
    r = process.platform === 'win32'
      ? probe('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
      : probe('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  } catch (e) {
    return { state: 'unknown', detail: `the process check could not be run (${(e && e.code) || (e && e.message) || 'threw'})` };
  }
  if (!r) return { state: 'unknown', detail: 'the process check returned nothing' };
  // A spawn error is the tool itself failing (no `ps` on PATH, EACCES). That is
  // "could not determine", and must never collapse into "not ours".
  if (r.error) return { state: 'unknown', detail: `the process check could not be run (${r.error.code || r.error.message})` };
  const outText = String(r.stdout || '');
  if (r.status !== 0) {
    // ps/tasklist exit non-zero for "no such process" — the pid is simply gone.
    return { state: 'gone', detail: 'no such process' };
  }
  // On win32 tasklist exits 0 even with nothing to report ("INFO: No tasks are running
  // which match the specified criteria"), so the pid must appear in the output too.
  if (process.platform === 'win32' && !new RegExp(`"${pid}"|\\b${pid}\\b`).test(outText))
    return { state: 'gone', detail: 'no such process' };
  const ours = process.platform === 'win32'
    ? /python|uvicorn/i.test(outText)
    : /uvicorn|app:app/i.test(outText);
  if (ours) return { state: 'gateway', detail: 'runs uvicorn app:app' };
  return { state: 'other', detail: `runs ${JSON.stringify(outText.trim().slice(0, 80))}` };
}

// Boolean form. uninstall.js no longer duplicates it — uninstall.js:25 delegates here,
// inside a try/catch so file removal never depends on this module loading. It answers
// false for BOTH "not ours" and "could not tell", the right bias for a signal gate and
// the wrong one for a status line — anything reporting to a human uses identifyPid().
function pidLooksLikeGateway(pid, probe = spawnSync) {
  return identifyPid(pid, probe).state === 'gateway';
}

// ---- gateway identity over HTTP ---------------------------------------------

// The identity contract /healthz publishes (cli/assets/gateway/app/app.py:297-313),
// checked field by field. Ported from the desktop app's isOurGateway()
// (cheaper-desktop/main.js:201-209), which has needed it since the day a port squat was
// mistaken for a running gateway.
//
// "Something answered 200 on /healthz" is NOT "the Cheaper gateway answered". Any
// process that got to the port first — another dev server, a tunnel, a previous
// unrelated app — can answer, and an old gateway build that predates these fields is
// also not the build being started. Both must fail this check, because the caller's
// next move (skip the spawn, call it started) is only correct for a real, current one.
//
// Accepts a parsed object or a raw JSON body so launch.js and freshness.js can adopt it
// without changing how they read the socket.
function isOurGateway(health) {
  let j = health;
  if (typeof j === 'string') { try { j = JSON.parse(j); } catch { return false; } }
  return !!j && typeof j === 'object'
    && j.ok === true
    && typeof j.mode === 'string'
    && typeof j.auth_required === 'boolean'
    && typeof j.token_private === 'boolean'
    && typeof j.code_sha === 'string' && j.code_sha.length > 0;
}

// One-shot GET /healthz on an EXPLICIT port — the primitive every other health check in
// the CLI now goes through, including freshness.js::runningGateway(), which calls
// gateway.probeHealth(activeGatewayPort(), …) instead of opening its own socket against a
// port it computed from process.env. The port is a PARAMETER, and
// never read from the environment here, because --port exists precisely to break the
// assumption that this process's environment names the running gateway's port.
//
// Resolves the parsed payload, or null on any failure. Never throws and never outlives
// the timeout: this runs on the critical path of a user-facing command.
function probeHealth(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish(null); }
        let data = '';
        res.on('data', (d) => { data += d; if (data.length > 1e6) req.destroy(); });
        res.on('end', () => { try { finish(JSON.parse(data)); } catch { finish(null); } });
      });
      req.on('error', () => finish(null));
      req.on('timeout', () => { req.destroy(); finish(null); });
    } catch { finish(null); }
  });
}

// Poll /healthz until OUR gateway answers or we give up. Resolves true/false; never
// throws, and never waits longer than `budgetMs`.
//
// The identity check is applied here too, and not only in the already-running guard: on
// a machine where an unrelated service holds the port, a bare `ok` from that service
// would otherwise be read as "our new gateway is serving" and printed as a ✓.
async function waitUntilServing(port, budgetMs = 8000, probe = probeHealth) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const h = await probe(port, 500);
    if (isOurGateway(h)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Is ANYTHING listening on this port?
//
// probeHealth() cannot answer that. It resolves null for a 404, a 500, an empty body and
// any unparseable payload, so a plain dev server that got to the port first is
// indistinguishable, to it, from a free port. start() then spawned uvicorn onto a bound
// port, uvicorn died on EADDRINUSE seconds later inside gateway.log, and the CLI had
// already moved on. A TCP connect answers the question the /healthz probe cannot.
//
// Three answers, kept apart for the same reason identifyPid keeps its four apart:
//   true   connected — something holds the port
//   false  ECONNREFUSED — nothing is listening
//   null   the check itself could not run; that is NOT "free"
//
// Connect rather than bind: a probe that briefly listens on the port would itself be the
// squatter for the duration, and racing our own spawn is not a check.
function probePortBound(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    let done = false;
    let sock = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { if (sock) sock.destroy(); } catch { /* already torn down */ }
      resolve(v);
    };
    try {
      sock = net.createConnection({ host: '127.0.0.1', port: Number(port) });
    } catch { return finish(null); }
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    // A connect that hangs is not evidence of either answer — a firewall can swallow the
    // SYN on a port nothing is bound to, and a loaded listener can accept late.
    sock.on('timeout', () => finish(null));
    sock.on('error', (e) => finish(e && e.code === 'ECONNREFUSED' ? false : null));
  });
}

// Wait for a port to become bindable again after the process holding it was signalled.
//
// kill(2) returns immediately; the socket does not close with it. uvicorn runs a graceful
// shutdown first, and restart() used to sleep a flat 400ms and start regardless. That is
// how `cheaper gateway restart` came to destroy a gateway and print a green tick: the old
// uvicorn was still answering /healthz, so start()'s already-running guard reported
// "already running — nothing to do" and spawned nothing, leaving no gateway, no pid file
// and exit 0.
//
// Resolves { free, detail } — plus `unverified` when the port check could not run, which
// is reported to the caller rather than quietly rendered as "free".
async function waitUntilPortFree(port, budgetMs = 5000, probes = {}) {
  const probeH = probes.probeHealth || probeHealth;
  const probeB = probes.probePortBound || probePortBound;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const health = await probeH(port, 300);
    const bound = await probeB(port, 300);
    if (health === null && bound === false) return { free: true, detail: 'nothing is listening on it' };
    if (health === null && bound === null)
      // No positive evidence either way. Blocking a restart on a probe that cannot run
      // would strand a machine where a loopback connect is filtered, so proceed — and
      // hand the caller the words to say that nothing confirmed it.
      return { free: true, unverified: 'the port check could not be run', detail: 'unverified' };
    const detail = bound === true
      ? 'something is still listening on it'
      : 'the old gateway is still answering /healthz';
    if (Date.now() >= deadline) return { free: false, detail };
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ---- autostart (supervisor) awareness ----------------------------------------
//
// A gateway a supervisor started is still a gateway. `stop` and `status` reported one as
// absent — "No running gateway found.", "gateway: stopped" — against a live, serving,
// launchd-managed process, which is the same looks-dead-while-alive lie this file exists
// to kill, pointed the other way.
//
// autostart.js is required LAZILY and defensively: it does `require('./gateway')` at its
// own top level, so a top-level require here would be a cycle that hands autostart.js a
// half-built module object, and a build that ships gateway.js without autostart.js must
// keep working rather than throw MODULE_NOT_FOUND out of `cheaper gateway stop`.
//
// `inject` is for tests — passing null means "no autostart module", which is exactly the
// absent-file case. Only filesystem/state reads are used (isRegisteredOnDisk,
// removalCommands): registration() shells out to launchctl/systemctl/schtasks, and a
// status line is not worth running a supervisor's CLI.
function supervisionState(inject) {
  let mod = inject;
  if (mod === undefined) {
    try { mod = require('./autostart'); } catch { return null; }
  }
  if (!mod || typeof mod.isRegisteredOnDisk !== 'function') return null;
  let registered = false;
  try { registered = !!mod.isRegisteredOnDisk(); } catch { return null; }
  if (!registered) return null;
  let disable = 'cheaper autostart disable';
  try {
    const cmds = mod.removalCommands(typeof mod.makeCtx === 'function' ? mod.makeCtx() : {});
    if (cmds && cmds.cheaper) disable = cmds.cheaper;
  } catch { /* the literal default above is the same string removalCommands returns */ }
  return { registered: true, label: mod.LABEL || null, disable };
}

// ---- dependency preparation --------------------------------------------------

// Install the gateway's Python deps portably. Try a plain install first — that works
// for virtualenvs and non-managed Pythons on ANY pip version. Only if it fails (e.g. a
// Homebrew/PEP-668 "externally-managed-environment") retry with --break-system-packages,
// which older pip (<23.0.1) doesn't recognize. Never fatal: deps may already be present.
//
// `py` is the resolved LAUNCHER ({cmd, args}), not a bare name — its prefix args have
// to lead every invocation or `py` runs whatever Python the launcher defaults to,
// which may not be the one `pyExe()` probed.
function installGatewayDeps(py) {
  const req = path.join(P.GATEWAY_DIR, 'requirements.txt');
  const base = [...py.args, '-m', 'pip', 'install', '-r', req, '--quiet'];
  let r = spawnSync(py.cmd, base, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (r.status === 0) return;
  r = spawnSync(py.cmd, [...base, '--break-system-packages'], { stdio: 'inherit' });
  if (r.status !== 0)
    console.log(c.dim('  (dep install had warnings — continuing; already-installed deps still work)'));
}

// Starting a gateway from stale installed files is the fastest way to ship wrong
// numbers: the process then serves old logic on the one path whose figures print with
// no hedge. Self-heal rather than warn — there is no case where a developer wants to
// launch a build older than the one they just wrote.
function reinstallIfStale() {
  try {
    const { gatewayCodeHash } = require('./freshness');
    const srcGw = path.join(P.ASSETS, 'gateway');
    if (gatewayCodeHash(srcGw) !== gatewayCodeHash(P.GATEWAY_DIR)) {
      console.log(c.amber('  ! installed gateway differs from this build — reinstalling first'));
      require('./install').install({ components: ['gateway'] });
      return true;
    }
  } catch { /* never block a start on the freshness check itself */ }
  return false;
}

// Open the gateway log for append at 0600.
//
// stdout AND stderr of the uvicorn process land in this file, so it is a security
// surface, not just a convenience. `fs.openSync(p, 'a')` created it 0666 & ~umask =
// 0644 — readable by every other account on the machine — which is the wrong default
// for a file that carries a service's request stream. The mode argument only applies
// when the file is CREATED, so an fchmod follows to tighten a log left behind at 0644
// by an earlier version. A failure to tighten is REPORTED, never swallowed: silently
// continuing with a world-readable log is exactly the outcome this is here to prevent.
function openGatewayLog() {
  const fd = fs.openSync(P.GATEWAY_LOG, 'a', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
  } catch (e) {
    console.log(c.amber(`  ! could not restrict ${P.GATEWAY_LOG} to 0600 (${e.code || e.message})`) +
      c.dim(' — other accounts on this machine may be able to read it'));
  }
  return fd;
}

// Bind to loopback by DEFAULT. The gateway serves a complete per-call record of the
// user's AI usage with no auth; on 0.0.0.0 that was readable by every device on the
// LAN (a coffee-shop/office network). Expose it deliberately with CHEAPER_HOST, and
// print a warning when you do.
function resolveHost() {
  const host = process.env.CHEAPER_HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(c.amber(`  ! gateway binding to ${host} — its usage data will be reachable from other hosts on your network`));
  }
  return host;
}

// The uvicorn argv, identical for `start` and `serve` so the two can never drift into
// serving different applications.
//
// --no-access-log is a SECURITY flag here, not a tidiness one. uvicorn's access
// formatter logs the request line through `get_path_with_query_string()`, which
// appends the raw query string verbatim — and the dashboard is reached as
// `GET /dashboard?token=<secret>`, because that first navigation is a browser
// address-bar load with nowhere to put a header. The token therefore landed, in
// clear, in a log file, once per open. Moving the page's later fetches onto the
// cookie/header does NOT close this: the entry hop is the leak.
function uvicornArgs(py, host, port) {
  return [...py.args, '-m', 'uvicorn', '--no-access-log',
    '--app-dir', path.join(P.GATEWAY_DIR, 'app'),
    'app:app', '--host', host, '--port', String(port)];
}

// ---- start ------------------------------------------------------------------

// opts.open — when true AND the terminal is interactive, offer a "Press [ENTER] to
// open the dashboard" prompt after starting. Off by default so internal callers
// (launch, the desktop) that open the browser themselves aren't double-prompted.
// opts.probeHealth — injectable /healthz probe (tests; keeps the suite off the network).
// opts.probePortBound — injectable TCP bound-check (same reason).
// opts.serveWaitMs — how long to wait for the new process to answer /healthz before
// reporting that it could not be confirmed. A parameter rather than a constant because
// the honest budget differs per caller (the desktop gives it 2s, `cheaper launch` 15s)
// and because the give-up path has to be reachable in a test without an 8-second sleep.
// opts.force — the caller wants a FRESH process, not an idempotent start. Only restart()
// passes it. Without this flag `restart` was a gateway-destroying no-op: stop() killed
// the process and deleted the pid file, the old uvicorn had not yet released the port, and
// the already-running guard below saw its /healthz, printed "already running — nothing to
// do (use `cheaper gateway restart`)" from inside restart, spawned nothing and returned
// true. End state: no gateway, no pid file, exit 0, green tick.
async function start(argv = [], opts = {}) {
  ensureInstalled();
  const probe = opts.probeHealth || probeHealth;
  const serveWaitMs = opts.serveWaitMs || 8000;

  const { port, error: portError } = resolvePort(argv);
  if (portError) {
    console.log(c.red('  ✗ ') + portError);
    process.exitCode = 1;
    return false;
  }

  // ALREADY-RUNNING GUARD.
  //
  // Without it, a second `cheaper gateway start` spawned a uvicorn that could not bind
  // the port and died within a second. spawn() still SUCCEEDED, so the now-dead pid was
  // written over the live one, and waitUntilServing then got a perfectly healthy
  // /healthz — from the FIRST gateway — and printed "✓ gateway started (pid N)" for a
  // corpse. The real gateway was from that moment unstoppable: its pid was no longer
  // recorded anywhere.
  //
  // Identity, not a 200, decides. `isOurGateway` is the same shape check the desktop
  // app uses; anything else that answers /healthz with a parseable body is a squat, and
  // spawning into it would reproduce the corpse-pid bug with an extra step. A squatter
  // that does NOT answer /healthz at all is caught by the bound-port check further down —
  // this probe alone cannot see one.
  const existing = await probe(port, 900);
  if (isOurGateway(existing)) {
    if (!opts.force) {
      console.log('  ' + c.green('✓') + ` gateway already running on port ${port}` +
        c.dim(' — nothing to do (use `cheaper gateway restart` to reload it)'));
      return true;
    }
    // FORCED START. restart() only gets here when the process it just signalled is still
    // serving after its whole wait budget, so "already running" is not the good news it is
    // on the idempotent path — it means the stop did not take. Spawning would produce the
    // corpse pid; reporting success would be the green tick this defect is named after.
    console.log(c.red(`  ✗ port ${port} is still held by a Cheaper gateway that did not exit`) +
      c.dim('  — refusing to spawn a second uvicorn onto it. Check: ') + 'cheaper gateway status');
    process.exitCode = 1;
    return false;
  }
  if (existing) {
    // Something IS listening and answering /healthz, but not with this build's identity.
    // The pid file tells the two apart: a live process that looks like our uvicorn means
    // an older Cheaper gateway whose /healthz predates the identity fields; anything else
    // is an unrelated squatter. Both must block the spawn — uvicorn cannot bind an
    // occupied port — but they need different advice.
    const rec = readPidFile();
    const mine = rec && pidAlive(rec.pid) && pidLooksLikeGateway(rec.pid);
    console.log(c.red(`  ✗ port ${port} is already in use by a service answering /healthz, `) +
      (mine
        ? c.red('and it looks like an older Cheaper gateway.') + c.dim('  Stop it first:  ') + 'cheaper gateway restart'
        : c.red('but it is NOT the Cheaper gateway.') +
          c.dim('  Free the port, or pick another:  ') + `cheaper gateway start --port ${Number(port) + 1}`));
    process.exitCode = 1;
    return false;
  }

  // BOUND-BUT-SILENT GUARD.
  //
  // The two branches above only ever fire against a squatter polite enough to serve
  // parseable JSON on /healthz. probeHealth() answers null for a 404, a 500, an empty
  // body and anything unparseable — so a plain dev server, a tunnel, or a uvicorn from a
  // half-dead earlier start fell straight through to spawn(). uvicorn then died on
  // EADDRINUSE a second or two later, inside gateway.log, after `cheaper gateway start`
  // had already printed its last line. Ask the socket instead of the endpoint.
  const boundProbe = opts.probePortBound || probePortBound;
  const bound = await boundProbe(port, 500);
  if (bound === true) {
    const rec = readPidFile();
    const mine = rec && rec.pid > 1 && pidAlive(rec.pid) && pidLooksLikeGateway(rec.pid);
    console.log(c.red(`  ✗ port ${port} is in use by something that does not answer /healthz `) +
      (mine
        ? c.red('— the recorded gateway pid is alive, so it is probably a Cheaper gateway that is not serving.') +
          c.dim('  Restart it:  ') + 'cheaper gateway restart'
        : c.red('— uvicorn cannot bind it.') +
          c.dim('  Free the port, or pick another:  ') + `cheaper gateway start --port ${Number(port) + 1}`));
    process.exitCode = 1;
    return false;
  }
  if (bound === null) {
    // "Could not determine" is not "free", and it is not a reason to refuse either:
    // making the gateway unstartable on a machine where a loopback connect is filtered
    // is a worse outcome than an EADDRINUSE the log will name. Say which one this is.
    console.log(c.amber(`  ! could not check whether port ${port} is already in use`) +
      c.dim(` — starting anyway; if uvicorn cannot bind, the reason is in ${P.GATEWAY_LOG}`));
  }

  reinstallIfStale();

  // Resolve the interpreter BEFORE anything else runs. `pyExe()` answers null when no
  // candidate works, and that must end the command in words rather than be handed to
  // spawn() to blow up asynchronously later.
  const py = pyExe();
  if (!py) {
    console.log(noPythonHelp());
    process.exitCode = 1;
    return false;
  }
  console.log(c.dim('  Installing gateway deps (first run may take a moment)...'));
  installGatewayDeps(py);

  const out = openGatewayLog();
  const host = resolveHost();
  const child = spawn(py.cmd, uvicornArgs(py, host, port), { detached: true, stdio: ['ignore', out, out] });

  // spawn() is ASYNCHRONOUS: an interpreter that cannot be executed is not reported by
  // a return value, it arrives as an 'error' EVENT on a later tick — and an 'error'
  // event with NO LISTENER is re-thrown by EventEmitter as an uncaught exception. That
  // is not caught by main()'s .catch either (it is a thrown event, not a rejected
  // promise), so `cheaper gateway start` ended in a raw Node stack trace. Worse, in
  // that case `child.pid` is `undefined`, and the PID file below used to be written
  // regardless — persisting the literal string "undefined", which then made every
  // later `gateway stop`/`status` parse NaN and report "no running gateway" on a
  // machine that might genuinely have one. Handle the event, and check the pid first.
  let reported = false;
  const reportSpawnFailure = (e) => {
    if (reported) return;                 // exactly one message, whichever path sees it first
    reported = true;
    try { fs.closeSync(out); } catch { /* already closed */ }
    console.log(c.red('  ✗ could not start the gateway: ') +
      `failed to execute ${c.bold(launcherLabel(py))}` + (e && e.code ? c.dim(` (${e.code})`) : ''));
    console.log(noPythonHelp());
    process.exitCode = 1;
  };
  child.on('error', reportSpawnFailure);
  child.unref();

  if (!child.pid) {
    // Synchronous evidence of the same failure. Yield briefly so the 'error' event can
    // land and contribute its errno to the one message we print.
    await new Promise((r) => setTimeout(r, 100));
    reportSpawnFailure(null);
    return false;
  }

  // Snapshot the pid file BEFORE overwriting it, so a start that turns out to have
  // failed can put back whatever was there. Clobbering it with a pid that never served
  // is how the previously-running gateway became unstoppable.
  let priorPidFile = null;
  try { priorPidFile = fs.readFileSync(P.GATEWAY_PID); } catch { priorPidFile = null; }
  writePidFile(child.pid, port);
  const dashUrl = `http://localhost:${port}/dashboard`;

  // "Started" should mean "serving". uvicorn takes a moment to bind, and returning
  // before then makes an immediately-following `cheaper status` report "not running"
  // on a gateway that is in fact fine — a false alarm that teaches people to distrust
  // the freshness check. Wait for a real 200 from OUR gateway, and report honestly if
  // it never comes.
  const served = await waitUntilServing(port, serveWaitMs, probe);
  if (!served) {
    // Two different failures, and they must not print the same sentence.
    if (!pidAlive(child.pid)) {
      // VERIFIED DEAD. The pid file is rolled back to whatever it held before, because
      // a dead pid recorded here is worse than no record: it makes `stop` a no-op and
      // hides a gateway that may still be running from an earlier start.
      if (priorPidFile) fs.writeFileSync(P.GATEWAY_PID, priorPidFile);
      else fs.rmSync(P.GATEWAY_PID, { force: true });
      console.log('  ' + c.red('✗') + ` the gateway exited immediately (pid ${child.pid} is gone)` +
        c.dim('  — see ') + P.GATEWAY_LOG);
      process.exitCode = 1;
      return false;
    }
    // COULD NOT CONFIRM. The process is ours and still alive, so its pid file stays —
    // `stop` must be able to reach it. But an unconfirmed start is not a success, and
    // exiting 0 here would tell a script the gateway is serving when nothing verified
    // that it is.
    console.log('  ' + c.amber('!') + ` gateway process is up (pid ${child.pid}) on port ${port}, ` +
      `but it did not answer /healthz within ${Math.round(serveWaitMs / 1000)}s` +
      c.dim('  — could not confirm it is serving; check: cheaper gateway status'));
    process.exitCode = 1;
    return false;
  }

  console.log('  ' + c.green('✓') + ` gateway started (pid ${child.pid}) on port ${port}`);
  console.log(c.dim('  Point your client at it:  ') + `export ANTHROPIC_BASE_URL=http://localhost:${port}`);
  console.log(c.dim('  Monitor:  ') + dashUrl + c.dim('   (open it with `cheaper dashboard` — it carries the local token)'));
  // Only the browser gets the tokened URL; the printed one above stays shareable.
  if (opts.open) await promptThenOpen(require('./token').withToken(dashUrl), 'the dashboard');
  // start() now answers true/false so a caller can branch. Every early return above is
  // `false` + a non-zero exit code; nothing currently reads it (launch.js does its own
  // health check), but a function that can fail silently should at least be able to
  // SAY it failed.
  return true;
}

// ---- serve (foreground) ------------------------------------------------------

// The signals that MEAN "shut down", as opposed to the ones that mean "you were killed".
// One list, used twice on purpose: it is what serve() forwards to uvicorn, AND what serve()
// accepts as a deliberate stop when uvicorn was signalled directly. The two must not drift
// — a signal forwarded as a stop but graded as a crash is a gateway a supervisor restarts
// after the user asked for it to go away.
const GRACEFUL_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

// `cheaper gateway serve` — run uvicorn IN THE FOREGROUND, as a child of this process,
// and exit with its status.
//
// This is the prerequisite for autostart, not a convenience. A supervisor (launchd
// KeepAlive, systemd Restart=, a Windows service wrapper) supervises the process it
// launched. `start` detaches, unrefs and RETURNS after a second or two, so a supervisor
// pointed at it sees its job exit almost immediately and "restarts" it — forever —
// while the uvicorns it spawned pile up behind it, each failing to bind. A supervised
// launcher must live exactly as long as the service it fronts.
//
// It deliberately does NO dependency work and NO code-hash reinstall: both belong to
// `cheaper gateway prepare`, which runs once. pip needs the network and can take
// minutes; inside a restart loop that becomes a hammer on the index, and a machine that
// is offline at boot would never come up at all. A reinstall under a supervisor is
// worse still — it rewrites the files being served, on every respawn.
//
// It DOES write the pid file — the same `<pid>\nport=<port>` record `start` writes, for
// the same uvicorn process. It used to write none, on the theory that the supervisor owns
// the lifecycle, and the cost of that theory was `cheaper gateway stop` printing "No
// running gateway found." and `cheaper gateway status` printing "gateway: stopped" against
// a live, serving, supervised gateway. Looks-dead-while-alive is the exact failure this
// file exists to prevent, and the pid file is the only handle stop/status have.
//
// Writing that record is why it must run `start`'s port guards FIRST, and why nothing
// below writes the pid file until they pass. This function once wrote it unconditionally,
// under a comment claiming there was no writer race because "`start` refuses to spawn onto
// a bound port" — true of `start`, and never true of `serve`, which checked nothing. The
// cost was the DEFAULT autostart flow: the login entry runs `gateway serve`, it loses the
// bind to a hand-started gateway, and on the way in it OVERWRITES that gateway's pid
// record — then deletes the file on the way out, the `rec.pid === child.pid` guard below
// passing precisely because this function had just written the record itself. From then on
// `status` said "gateway: stopped" and `stop` said "No running gateway found." at a live,
// serving process, and the supervisor re-ran the whole sequence on every restart of the
// non-zero exit. Looks-dead-while-alive, the exact failure this file exists to kill.
//
// A `stop` against a supervised gateway is honest rather than absent — and the exit-code
// contract that makes it STICK is enforced here rather than inherited from uvicorn: see
// the exit handler. stop() signals the recorded pid, which is uvicorn's and not this
// launcher's, so a deliberate stop never reaches this process at all.
async function serve(argv = [], opts = {}) {
  ensureInstalled();

  const { port, error: portError } = resolvePort(argv);
  if (portError) {
    console.log(c.red('  ✗ ') + portError);
    process.exitCode = 1;
    return false;
  }

  // opts.probeHealth / opts.probePortBound are injectable for the same reason start()
  // takes them: every guard below has to be reachable in a test without binding a port.
  const probe = opts.probeHealth || probeHealth;
  const boundProbe = opts.probePortBound || probePortBound;

  // ALREADY-SERVING GUARD — start()'s, applied here for the first time. A Cheaper gateway
  // holds the port, so there is nothing for this launcher to run, and nothing about that
  // gateway's pid record this invocation is entitled to touch.
  //
  // Exit 0 deliberately, and it is the one refusal here that is not a failure: launchd's
  // KeepAlive={SuccessfulExit:false} and systemd's Restart=on-failure both stay stopped on
  // 0, and "restart me" is the wrong answer to "the service is already up" — a respawn
  // cannot bind the port either, it only re-runs this refusal every ThrottleInterval.
  const existing = await probe(port, 900);
  if (isOurGateway(existing)) {
    console.log('  ' + c.green('✓') + ` a Cheaper gateway is already serving on port ${port}` +
      c.dim(' — not starting a second one, and leaving its pid record untouched'));
    return true;
  }
  if (existing) {
    // Answers /healthz, but without this build's identity: an older Cheaper gateway, or an
    // unrelated service that got to the port first. uvicorn cannot bind either of them, and
    // the pid record belongs to whoever wrote it.
    console.log(c.red(`  ✗ port ${port} is answered by a service that is not this build's gateway`) +
      c.dim('  — refusing to serve onto it, and leaving the pid file alone.  Check:  ') +
      'cheaper gateway status');
    process.exitCode = 1;
    return false;
  }

  // BOUND-BUT-SILENT GUARD. probeHealth() answers null for a 404, a 500, an empty body and
  // anything unparseable, so the two branches above cannot see a squatter that serves no
  // /healthz at all — which is exactly what a uvicorn losing the race looks like. Ask the
  // socket, not the endpoint.
  const bound = await boundProbe(port, 500);
  if (bound === true) {
    console.log(c.red(`  ✗ port ${port} is in use by something that does not answer /healthz `) +
      c.dim('— uvicorn cannot bind it, so this launcher would die on EADDRINUSE having already ' +
        'claimed the pid file.  Free the port, or pick another:  ') +
      `cheaper gateway serve --port ${Number(port) + 1}`);
    process.exitCode = 1;
    return false;
  }
  if (bound === null) {
    // "Could not determine" is not "free" — and not a refusal either, or a machine where a
    // loopback connect is filtered could never autostart the gateway at all. Say which.
    console.log(c.amber(`  ! could not check whether port ${port} is already in use`) +
      c.dim(' — serving anyway; if uvicorn cannot bind, it says so on this process\'s stderr'));
  }

  // NEVER OVERWRITE A LIVE GATEWAY'S RECORD. The port is free, so a recorded gateway that
  // is still alive is serving some OTHER port — and one pid file cannot describe two
  // gateways (see resolvePort's two-gateways-one-pid-file note). Recording this one would
  // leave that one running with its pid written down nowhere, which is precisely how a
  // gateway becomes unstoppable. Only a VERIFIED gateway blocks: a stale record for a
  // recycled pid must not make the service unstartable, so `pidLooksLikeGateway`'s
  // false-for-"could not tell" bias is the right one here.
  const prior = readPidFile();
  if (prior && prior.pid > 1 && pidAlive(prior.pid) && pidLooksLikeGateway(prior.pid)) {
    console.log(c.red(`  ✗ ${P.GATEWAY_PID} already names a live Cheaper gateway (pid ${prior.pid}` +
      (prior.port ? `, port ${prior.port})` : ', port unknown)')) +
      c.dim(' — refusing to serve, because recording this one would leave that one unstoppable.' +
        '  Stop it first:  ') + 'cheaper gateway stop');
    process.exitCode = 1;
    return false;
  }

  const py = pyExe();
  if (!py) {
    console.log(noPythonHelp());
    process.exitCode = 1;
    return false;
  }

  const host = resolveHost();
  // stdio is INHERITED, not redirected into ~/.cheaper/gateway.log: under a supervisor
  // the parent's stdout/stderr are already captured (launchd StandardOutPath, journald),
  // and writing to the same log file from a supervised process AND a detached `start`
  // would interleave two services' output in one file.
  const child = spawn(py.cmd, uvicornArgs(py, host, port), { stdio: 'inherit' });

  // The uvicorn pid, not this launcher's: identifyPid() verifies a candidate by asking ps
  // whether it runs `uvicorn app:app`, and this launcher is a node process that would fail
  // that check and be cleared as a stale record. It is also the same pid `start` records,
  // so stop/status need no idea which of the two started the gateway.
  //
  // The consequence, which the exit handler below has to carry: `cheaper gateway stop`
  // signals THIS NUMBER, so a deliberate stop lands on the child and never on the launcher.
  if (child.pid) writePidFile(child.pid, port);

  // Forward the supervisor's stop signal instead of dying and orphaning uvicorn. If
  // this process exits on SIGTERM while the child lives on, the child keeps holding the
  // port and the supervisor's very next restart cannot bind — a stop that produces an
  // unkillable service.
  //
  // Receiving one is also recorded, because the exit status this launcher reports is what
  // decides whether the supervisor brings the gateway back. See the exit handler.
  let deliberateSignal = null;
  const forwarders = GRACEFUL_SIGNALS.map((sig) => {
    const fn = () => {
      deliberateSignal = sig;
      try { child.kill(sig); } catch { /* already gone */ }
    };
    try { process.on(sig, fn); } catch { return null; }   // win32 has no SIGHUP
    return { sig, fn };
  }).filter(Boolean);

  const status = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    // An 'error' event with no listener is re-thrown as an uncaught exception; the same
    // trap `start` documents applies here, and here it would take down a supervised
    // service with a stack trace instead of an exit code the supervisor can act on.
    child.on('error', (e) => {
      console.log(c.red('  ✗ could not start the gateway: ') +
        `failed to execute ${c.bold(launcherLabel(py))}` + (e && e.code ? c.dim(` (${e.code})`) : ''));
      console.log(noPythonHelp());
      finish(1);
    });
    child.on('exit', (code, signal) => {
      // THE EXIT-CODE CONTRACT. A supervisor reads only this number to decide whether the
      // service should come back:
      //
      //   a shutdown signal reached THIS launcher, or reached UVICORN -> 0
      //   anything else                                              -> non-zero
      //
      // launchd's KeepAlive={SuccessfulExit:false} and systemd's Restart=on-failure both
      // restart on non-zero and stay stopped on 0. The old code reported the shell's
      // 128+N (143 for SIGTERM) for a signal, which those supervisors read as a crash —
      // so a supervised gateway could NOT be stopped: `cheaper autostart` wrote a plist
      // whose comment promised a deliberate stop would be honoured, `cheaper gateway stop`
      // sent the signal, and the service came straight back within ThrottleInterval.
      //
      // The signal is still forwarded to uvicorn (above); only the status this process
      // reports changes. A stop that we were asked for is a success even if uvicorn's own
      // shutdown ends untidily, so the deliberate flag wins over the child's status.
      if (deliberateSignal) return finish(0);
      // A SHUTDOWN SIGNAL THE CHILD RECEIVED DIRECTLY IS ALSO DELIBERATE — and this branch
      // is the ordinary `cheaper gateway stop` path, not an edge case. stop() signals the
      // pid in the pid file, and that is the UVICORN pid (written above, because it is the
      // one identifyPid can verify against `ps`), so the signal never reaches this launcher
      // and `deliberateSignal` stays null. Without this branch the launcher reported the
      // shell's 128+15 = 143 for the most routine stop there is — exactly the status
      // launchd's KeepAlive={SuccessfulExit:false} and systemd's Restart=on-failure read as
      // a crash, so the gateway a user had just stopped came straight back.
      //
      // It was masked only because real uvicorn traps SIGTERM and exits 0, i.e. `signal`
      // was null and `code` was 0. That is uvicorn's property, not this launcher's
      // contract; an inherited guarantee is not an enforced one, and it dies the day
      // uvicorn is killed before its handler runs, or is swapped for something else.
      if (signal && GRACEFUL_SIGNALS.includes(signal)) return finish(0);
      // Not asked for by anyone. A uvicorn killed by a signal that does not mean "shut
      // down" (an OOM kill, an operator's `kill -9`) is a crash, and it must read as one or
      // Restart=on-failure never brings it back. The shell's 128+N carries which signal.
      if (signal) return finish(128 + (os.constants.signals[signal] || 0));
      finish(code == null ? 1 : code);
    });
  });

  for (const f of forwarders) process.removeListener(f.sig, f.fn);
  // Clear the record this invocation wrote, and ONLY that one: a pid file naming some
  // other process belongs to whoever wrote it, and deleting it would hide a running
  // gateway from `stop` — the failure this whole file keeps circling.
  if (child.pid) {
    const rec = readPidFile();
    if (rec && rec.pid === child.pid) fs.rmSync(P.GATEWAY_PID, { force: true });
  }
  process.exitCode = status;
  return status === 0;
}

// ---- prepare -----------------------------------------------------------------

// `cheaper gateway prepare` — everything `serve` must not do at boot: refresh the
// installed files if this build is newer, then install the Python deps. Split out of
// `start` so an autostart unit can run it once, deliberately, rather than on every
// respawn (see serve() for why that matters).
function prepare(argv = []) {
  ensureInstalled();
  const reinstalled = reinstallIfStale();
  const py = pyExe();
  if (!py) {
    console.log(noPythonHelp());
    process.exitCode = 1;
    return false;
  }
  console.log(c.dim('  Installing gateway deps (first run may take a moment)...'));
  installGatewayDeps(py);
  console.log('  ' + c.green('✓') + ' gateway prepared' +
    c.dim(reinstalled ? ' (files reinstalled from this build, deps installed)' : ' (deps installed)'));
  console.log(c.dim('  Run it in the foreground:  ') + 'cheaper gateway serve');
  return true;
}

// ---- stop / status -----------------------------------------------------------

// opts.autostart — injectable autostart module (tests; keeps the suite away from
// ~/Library/LaunchAgents and from running launchctl). See supervisionState().
function stop(opts = {}) {
  const sup = supervisionState(opts.autostart);
  const rec = readPidFile();
  if (!rec) {
    console.log(c.dim('  No running gateway found.'));
    // Silence here was the bug's other half: on a machine with a login item registered,
    // "No running gateway found." reads as "there is no gateway", when what it actually
    // means is "nothing recorded a pid" — and one will be started at the next login
    // whatever this command does.
    if (sup) console.log(c.amber('  ! autostart is registered') +
      c.dim(`${sup.label ? ` (${sup.label})` : ''} — nothing was stopped, and a gateway will be started at your next login.  Turn that off with:  `) + sup.disable);
    return;
  }
  // pid > 1 rejects 0, NaN and negatives. This is not pedantry: process.kill(0) signals
  // THIS PROCESS'S OWN GROUP and process.kill(-N) signals the whole group N, so a
  // corrupt pid file could have made `cheaper gateway stop` kill the user's shell.
  if (!(rec.pid > 1)) {
    console.log(c.amber('  ! gateway.pid does not contain a usable pid') +
      c.dim(' — removing it; nothing was signalled'));
    fs.rmSync(P.GATEWAY_PID, { force: true });
    return;
  }
  if (!pidAlive(rec.pid)) {
    fs.rmSync(P.GATEWAY_PID, { force: true });
    console.log(c.dim(`  No running gateway found.  (cleared a stale pid file for pid ${rec.pid})`));
    return;
  }
  const id = identifyPid(rec.pid);
  if (id.state === 'gateway') {
    try { process.kill(rec.pid); } catch { /* raced with its own exit */ }
    fs.rmSync(P.GATEWAY_PID, { force: true });
    console.log('  ' + c.green('✓') + ` gateway stopped (pid ${rec.pid}` +
      (rec.port ? `, port ${rec.port})` : ')'));
    // A supervised gateway that is stopped stays stopped only until the next login. Not
    // saying so turns the next login into "I stopped it and it came back on its own",
    // which is what people call malware.
    if (sup) console.log(c.amber('  ! it is registered to start at login') +
      c.dim(`${sup.label ? ` (${sup.label})` : ''} — it will come back at your next login.  Turn that off with:  `) + sup.disable);
    return;
  }
  if (id.state === 'unknown') {
    // The identity check could not run. Signalling anyway is how an unrelated process
    // gets SIGTERMed after a reboot recycles the pid; deleting the pid file anyway would
    // discard the only record of a gateway that may well be running. Do neither, and say
    // so — with a non-zero exit code, because nothing was stopped.
    console.log(c.amber(`  ! could not verify that pid ${rec.pid} is the gateway `) +
      c.dim(`(${id.detail}) — refusing to signal it, and keeping ${P.GATEWAY_PID}`));
    process.exitCode = 1;
    return;
  }
  // VERIFIED NOT OURS ('other' / 'gone'): the pid file is stale and the number now
  // belongs to something else. Clearing it is the fix — leaving it would aim the next
  // `stop` at the same innocent process.
  console.log(c.amber(`  ! pid ${rec.pid} is not the Cheaper gateway `) +
    c.dim(`(${id.detail}) — not signalling it; removing the stale pid file`));
  fs.rmSync(P.GATEWAY_PID, { force: true });
}

function status(opts = {}) {
  const sup = supervisionState(opts.autostart);
  // Printed after EVERY branch, including the stopped ones: "gateway: stopped" on a
  // machine with a login item registered is a half-truth, because something will start
  // one without the user typing anything. It is a separate line from the gateway's own
  // state because it is a separate fact — a registration is not a running process.
  const note = () => {
    if (!sup) return;
    console.log('  autostart: ' + c.amber('registered') +
      c.dim(`${sup.label ? ` (${sup.label})` : ''} — a supervisor starts this gateway at login;  details:  cheaper autostart status`));
  };
  const rec = readPidFile();
  if (!rec || !(rec.pid > 1)) { console.log('  gateway: ' + c.dim('stopped')); return note(); }
  if (!pidAlive(rec.pid)) {
    console.log('  gateway: ' + c.dim('stopped') + c.dim(`  (stale pid file: pid ${rec.pid} is gone)`));
    return note();
  }
  const id = identifyPid(rec.pid);
  // A pid file written by an older build records no port. Printing the CURRENT default
  // for it would be a confident guess about a process that may well be on another port,
  // so it is reported as unknown instead.
  const where = rec.port ? `pid ${rec.pid}, port ${rec.port}` : `pid ${rec.pid}, port unknown (pid file predates port recording)`;
  if (id.state === 'gateway') {
    console.log('  gateway: ' + c.green('running') + c.dim(` (${where})`));
  } else if (id.state === 'unknown') {
    // Never render "could not check" as either running or stopped.
    console.log('  gateway: ' + c.amber('unknown') +
      c.dim(`  (pid ${rec.pid} is alive, but ${id.detail})`));
  } else {
    console.log('  gateway: ' + c.dim('stopped') +
      c.dim(`  (stale pid file: pid ${rec.pid} is alive but ${id.detail})`));
  }
  return note();
}

// Stop-then-start. Exists because "restart" is the remedy for the single most common
// staleness case — correct files, stale process — and telling someone to run two commands
// to fix it invites them to run only the first. It is also what the RESTART NEEDED state
// of `cheaper doctor` and the stale-build warning both tell people to run, which is why
// its failure mode was so expensive.
//
// It used to be: stop(); sleep 400ms; start(). Every part of that was wrong together.
// 400ms is not long enough for a SIGTERM'd uvicorn to run its shutdown and release the
// socket, so the old gateway was usually still answering /healthz when start() probed —
// and start()'s already-running guard treats that as "nothing to do", prints a green tick
// advising `cheaper gateway restart` (from inside restart), and spawns nothing. The pid
// file had already been deleted by stop() and the process had already been signalled, so
// the command ended with no gateway, no pid file, exit 0 and a ✓.
//
// So: wait for the port to be genuinely free, on a budget, and refuse in words if it never
// is. `restart` may end with the gateway running or with a non-zero exit code explaining
// why it is not — never with a success line and nothing behind it.
//
// opts.portFreeWaitMs / opts.probeHealth / opts.probePortBound are injectable so the
// slow-to-free and never-frees paths are reachable in a test without a real uvicorn.
async function restart(argv = [], opts = {}) {
  const probe = opts.probeHealth || probeHealth;
  const boundProbe = opts.probePortBound || probePortBound;

  // Resolved BEFORE stopping anything: a bad `--port` must not cost the user a running
  // gateway, and there is no port to wait on if we cannot say which one it is.
  const { port, error: portError } = resolvePort(argv);
  if (portError) {
    console.log(c.red('  ✗ ') + portError);
    process.exitCode = 1;
    return false;
  }

  stop({ autostart: opts.autostart });

  const budget = opts.portFreeWaitMs === undefined ? 5000 : opts.portFreeWaitMs;
  const freed = await waitUntilPortFree(port, budget, { probeHealth: probe, probePortBound: boundProbe });
  if (!freed.free) {
    // Sub-second budgets exist (tests, and a caller in a hurry), and `Math.round(x/1000)`
    // renders those as "still in use 0s after the stop" — a sentence that reads as a bug
    // report about the message rather than about the port.
    const waited = budget < 1000 ? `${budget}ms` : `${Math.round(budget / 1000)}s`;
    console.log(c.red(`  ✗ port ${port} was still in use ${waited} after the stop `) +
      c.dim(`(${freed.detail}) — not restarting.  A uvicorn spawned onto a bound port dies on ` +
        'EADDRINUSE seconds later, and this command would have called it started.'));
    console.log(c.dim('  See what holds it, then start it yourself:  ') +
      `cheaper gateway status  /  cheaper gateway start --port ${port}`);
    process.exitCode = 1;
    return false;
  }
  if (freed.unverified) {
    console.log(c.amber(`  ! could not confirm port ${port} is free (${freed.unverified})`) +
      c.dim(' — starting anyway'));
  }

  // force: the already-running guard must not turn this into a no-op again.
  return start(argv, {
    open: false,
    force: true,
    probeHealth: probe,
    probePortBound: boundProbe,
    serveWaitMs: opts.serveWaitMs,
  });
}

function run(argv) {
  const cmd = argv[0];
  if (cmd === 'start') return start(argv.slice(1), { open: true }); // interactive CLI → offer [ENTER] to open
  if (cmd === 'stop') return stop();
  if (cmd === 'restart') return restart(argv.slice(1));
  if (cmd === 'status') return status();
  if (cmd === 'serve') return serve(argv.slice(1));
  if (cmd === 'prepare') return prepare(argv.slice(1));
  // An unrecognized (or missing) subcommand is a FAILURE, and a shell/CI has only the
  // exit code to go on. Printing usage and exiting 0 told every script that
  // `cheaper gateway statsu` had succeeded. Matches bin/cheaper.js's unknown-command
  // branch, which already sets a non-zero code.
  console.log(c.red(cmd ? `  Unknown gateway subcommand: ${cmd}` : '  Missing gateway subcommand.'));
  console.log('  usage: cheaper gateway <start|stop|restart|status|serve|prepare> [--port N]');
  console.log(c.dim('         serve   = run in the foreground (for launchd/systemd); does NOT install deps'));
  console.log(c.dim('         prepare = install deps + refresh files, once, before serve'));
  process.exitCode = 1;
}

module.exports = {
  run, start, stop, restart, status, serve, prepare,
  PORT, DEFAULT_PORT, resolvePort, readPortFlag,
  pyExe, PY_CANDIDATES, launcherLabel,
  isOurGateway, probeHealth, waitUntilServing, probePortBound, waitUntilPortFree,
  supervisionState,
  identifyPid, pidLooksLikeGateway, pidAlive,
  readPidFile, writePidFile,
};
