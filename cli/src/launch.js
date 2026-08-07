'use strict';
// `cheaper launch` / `cheaper init` — ensure the gateway is up, refresh the local
// peek report so the dashboard's /peek panel has fresh data, open the dashboard in
// the default browser, and (unless --once) keep the process alive to keep
// refreshing peek every 2 minutes while the user watches the live monitor.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const P = require('./paths');
const { c } = require('./util');
const gateway = require('./gateway');
const { withToken } = require('./token');
const { PORT } = gateway;

const HEALTH_TIMEOUT_MS = 15000;
const HEALTH_POLL_MS = 500;
const PEEK_REFRESH_MS = 120000;

function isGatewayRunning() {
  try {
    const pid = parseInt(fs.readFileSync(P.GATEWAY_PID, 'utf8'), 10);
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${PORT}/healthz`, (res) => {
      let d = '';
      res.on('data', (x) => (d += x));
      res.on('end', () => {
        try { resolve(JSON.parse(d).ok === true); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

async function waitForHealthy(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await healthCheck()) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

// Ensure the gateway is running and healthy. Returns true if we can proceed.
async function ensureGatewayUp() {
  if (!isGatewayRunning()) {
    console.log(c.dim('  Gateway not running — starting it...'));
    await gateway.start([], { open: false }); // launch opens the browser itself, so no [ENTER] prompt here
  }
  const healthy = await waitForHealthy(HEALTH_TIMEOUT_MS);
  if (!healthy) {
    console.log(c.red(`  Gateway did not become healthy on port ${PORT} within ${HEALTH_TIMEOUT_MS / 1000}s.`));
    console.log(c.dim('  Check the log:  ') + P.GATEWAY_LOG);
    console.log(c.dim('  Or try:  ') + 'cheaper gateway start');
    return false;
  }
  return true;
}

// Refresh ~/.cheaper/peek.json so the dashboard's /peek panel stays current.
// A peek failure must never crash the monitor.
function refreshPeek() {
  try {
    const { scan } = require('./peek');
    const report = scan({});
    fs.mkdirSync(P.CHEAPER_DIR, { recursive: true });
    fs.writeFileSync(path.join(P.CHEAPER_DIR, 'peek.json'), JSON.stringify(report));
  } catch (e) {
    console.log(c.dim('  (peek refresh failed — continuing) ') + c.dim(String(e && e.message || e)));
  }
}

function openDashboard(url) {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* best effort — never fatal */ }
}

function parseArgs(argv) {
  const o = { open: true, once: false };
  for (const a of argv) {
    if (a === '--no-open') o.open = false;
    else if (a === '--once') o.once = true;
  }
  return o;
}

async function run(argv = [], opts = {}) {
  const o = parseArgs(argv);

  const ok = await ensureGatewayUp();
  if (!ok) { process.exitCode = 1; return; }

  // Deep-link to a specific dashboard tab (dashboard/reports/logs/monitor) so
  // `cheaper logs`, `cheaper reports`, etc. open the RIGHT view, not the generic page.
  //
  // The token is read AFTER ensureGatewayUp(): on a clean machine the gateway mints it
  // during start-up, so reading it earlier would hand the browser a token-less URL and
  // 401 the very first dashboard a new user ever opens.
  const tab = (opts && opts.tab) || '';
  const dashUrl = withToken(`http://localhost:${PORT}/dashboard` + (tab ? '#' + tab : ''));

  refreshPeek();
  if (o.open) openDashboard(dashUrl);

  console.log('');
  // Print the URL WITHOUT the secret. It is copied into chats, screenshots and issue
  // reports; the browser already has the tokened copy it needs.
  console.log('  ' + c.green(`http://localhost:${PORT}/dashboard` + (tab ? '#' + tab : '')));
  console.log('  ' + c.bold('live monitor running') + c.dim(' — Ctrl-C to stop (the gateway keeps running)'));
  console.log('');

  if (o.once) return;

  const timer = setInterval(refreshPeek, PEEK_REFRESH_MS);
  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log(c.dim('\n  stopped (gateway keeps running).'));
    process.exit(0);
  });

  // Keep the process alive for the refresh timer.
  await new Promise(() => {});
}

// `ensureGatewayUp` is exported because `cheaper export` streams from the gateway and
// must use the SAME lifecycle every other consumer does — one health-gated process, not
// a second way of starting one.
module.exports = { run, ensureGatewayUp, isGatewayRunning, refreshPeek };
