'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const P = require('./paths');
const { c } = require('./util');
const { promptThenOpen } = require('./openurl');

const PORT = process.env.CHEAPER_PORT || '8787';

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

// opts.open — when true AND the terminal is interactive, offer a "Press [ENTER] to
// open the dashboard" prompt after starting. Off by default so internal callers
// (launch, the desktop) that open the browser themselves aren't double-prompted.
// Poll /healthz until the gateway answers or we give up. Resolves true/false; never
// throws, and never waits longer than `budgetMs`.
async function waitUntilServing(budgetMs = 8000) {
  const { runningGateway } = require('./freshness');
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const h = await runningGateway(500);
    if (h && h.ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function start(argv, opts = {}) {
  ensureInstalled();
  // Starting a gateway from stale installed files is the fastest way to ship wrong
  // numbers: the process then serves old logic on the one path whose figures print
  // with no hedge. Self-heal rather than warn — there is no case where a developer
  // wants to launch a build older than the one they just wrote.
  try {
    const { gatewayCodeHash } = require('./freshness');
    const srcGw = path.join(P.ASSETS, 'gateway');
    if (gatewayCodeHash(srcGw) !== gatewayCodeHash(P.GATEWAY_DIR)) {
      console.log(c.amber('  ! installed gateway differs from this build — reinstalling first'));
      require('./install').install({ components: ['gateway'] });
    }
  } catch { /* never block a start on the freshness check itself */ }
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
  // Bind to loopback by DEFAULT. The gateway serves a complete per-call record of the
  // user's AI usage with no auth; on 0.0.0.0 that was readable by every device on the
  // LAN (a coffee-shop/office network). Expose it deliberately with CHEAPER_HOST, and
  // print a warning when you do.
  const host = process.env.CHEAPER_HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(c.amber(`  ! gateway binding to ${host} — its usage data will be reachable from other hosts on your network`));
  }
  // --no-access-log is a SECURITY flag here, not a tidiness one. uvicorn's access
  // formatter logs the request line through `get_path_with_query_string()`, which
  // appends the raw query string verbatim — and the dashboard is reached as
  // `GET /dashboard?token=<secret>`, because that first navigation is a browser
  // address-bar load with nowhere to put a header. The token therefore landed, in
  // clear, in a log file, once per open. Moving the page's later fetches onto the
  // cookie/header does NOT close this: the entry hop is the leak. So the access log
  // is off, and openGatewayLog() also narrows the file to 0600 for whatever else
  // uvicorn or the app writes there.
  const child = spawn(py.cmd, [...py.args, '-m', 'uvicorn', '--no-access-log',
    '--app-dir', path.join(P.GATEWAY_DIR, 'app'),
    'app:app', '--host', host, '--port', PORT],
    { detached: true, stdio: ['ignore', out, out] });

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

  fs.writeFileSync(P.GATEWAY_PID, String(child.pid));
  const dashUrl = `http://localhost:${PORT}/dashboard`;

  // "Started" should mean "serving". uvicorn takes a moment to bind, and returning
  // before then makes an immediately-following `cheaper status` report "not running"
  // on a gateway that is in fact fine — a false alarm that teaches people to distrust
  // the freshness check. Wait for a real 200, and report honestly if it never comes.
  const served = await waitUntilServing(8000);
  console.log('  ' + c.green('✓') + ` gateway started (pid ${child.pid}) on port ${PORT}`
    + (served ? '' : c.amber(' — not answering yet; check: cheaper gateway status')));
  console.log(c.dim('  Point your client at it:  ') + `export ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
  console.log(c.dim('  Monitor:  ') + dashUrl + c.dim('   (open it with `cheaper dashboard` — it carries the local token)'));
  // Only the browser gets the tokened URL; the printed one above stays shareable.
  if (opts.open) await promptThenOpen(require('./token').withToken(dashUrl), 'the dashboard');
  // start() now answers true/false so a caller can branch. Every early return above is
  // `false` + a non-zero exit code; nothing currently reads it (launch.js does its own
  // health check), but a function that can fail silently should at least be able to
  // SAY it failed.
  return true;
}

function stop() {
  try {
    const pid = parseInt(fs.readFileSync(P.GATEWAY_PID, 'utf8'), 10);
    process.kill(pid);
    fs.unlinkSync(P.GATEWAY_PID);
    console.log('  ' + c.green('✓') + ` gateway stopped (pid ${pid})`);
  } catch {
    console.log(c.dim('  No running gateway found.'));
  }
}

function status() {
  let running = false;
  try {
    const pid = parseInt(fs.readFileSync(P.GATEWAY_PID, 'utf8'), 10);
    process.kill(pid, 0);
    running = true;
    console.log('  gateway: ' + c.green('running') + c.dim(` (pid ${pid}, port ${PORT})`));
  } catch { /* not running */ }
  if (!running) console.log('  gateway: ' + c.dim('stopped'));
}

// Stop-then-start. Exists because "restart" is the remedy for the single most common
// staleness case — correct files, stale process — and telling someone to run two
// commands to fix it invites them to run only the first.
async function restart(argv) {
  stop();
  // Give the port a moment to free before rebinding.
  await new Promise((r) => setTimeout(r, 400));
  return start(argv, { open: false });
}

function run(argv) {
  const cmd = argv[0];
  if (cmd === 'start') return start(argv.slice(1), { open: true }); // interactive CLI → offer [ENTER] to open
  if (cmd === 'stop') return stop();
  if (cmd === 'restart') return restart(argv.slice(1));
  if (cmd === 'status') return status();
  // An unrecognized (or missing) subcommand is a FAILURE, and a shell/CI has only the
  // exit code to go on. Printing usage and exiting 0 told every script that
  // `cheaper gateway statsu` had succeeded. Matches bin/cheaper.js's unknown-command
  // branch, which already sets a non-zero code.
  console.log(c.red(cmd ? `  Unknown gateway subcommand: ${cmd}` : '  Missing gateway subcommand.'));
  console.log('  usage: cheaper gateway <start|stop|restart|status>');
  process.exitCode = 1;
}

module.exports = { run, start, stop, restart, status, PORT, pyExe, PY_CANDIDATES, launcherLabel };
