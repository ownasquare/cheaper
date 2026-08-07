'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const P = require('./paths');
const { c } = require('./util');
const { promptThenOpen } = require('./openurl');

const PORT = process.env.CHEAPER_PORT || '8787';

function pyExe() {
  for (const cand of ['python3', 'python']) {
    const r = spawnSync(cand, ['--version'], { stdio: 'ignore' });
    if (r.status === 0) return cand;
  }
  return 'python3';
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
function installGatewayDeps(py) {
  const req = path.join(P.GATEWAY_DIR, 'requirements.txt');
  const base = ['-m', 'pip', 'install', '-r', req, '--quiet'];
  let r = spawnSync(py, base, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (r.status === 0) return;
  r = spawnSync(py, [...base, '--break-system-packages'], { stdio: 'inherit' });
  if (r.status !== 0)
    console.log(c.dim('  (dep install had warnings — continuing; already-installed deps still work)'));
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
  const py = pyExe();
  console.log(c.dim('  Installing gateway deps (first run may take a moment)...'));
  installGatewayDeps(py);

  const out = fs.openSync(P.GATEWAY_LOG, 'a');
  // Bind to loopback by DEFAULT. The gateway serves a complete per-call record of the
  // user's AI usage with no auth; on 0.0.0.0 that was readable by every device on the
  // LAN (a coffee-shop/office network). Expose it deliberately with CHEAPER_HOST, and
  // print a warning when you do.
  const host = process.env.CHEAPER_HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(c.amber(`  ! gateway binding to ${host} — its usage data will be reachable from other hosts on your network`));
  }
  const child = spawn(py, ['-m', 'uvicorn', '--app-dir', path.join(P.GATEWAY_DIR, 'app'),
    'app:app', '--host', host, '--port', PORT],
    { detached: true, stdio: ['ignore', out, out] });
  child.unref();
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
  console.log('  usage: cheaper gateway <start|stop|restart|status>');
}

module.exports = { run, start, stop, restart, status, PORT };
