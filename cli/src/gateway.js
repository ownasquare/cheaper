'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const P = require('./paths');
const { c } = require('./util');

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

function start(argv) {
  ensureInstalled();
  const py = pyExe();
  console.log(c.dim('  Installing gateway deps (first run may take a moment)...'));
  spawnSync(py, ['-m', 'pip', 'install', '-r',
    path.join(P.GATEWAY_DIR, 'requirements.txt'), '--quiet', '--break-system-packages'],
    { stdio: 'inherit' });

  const out = fs.openSync(P.GATEWAY_LOG, 'a');
  const child = spawn(py, ['-m', 'uvicorn', '--app-dir', path.join(P.GATEWAY_DIR, 'app'),
    'app:app', '--host', '0.0.0.0', '--port', PORT],
    { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.writeFileSync(P.GATEWAY_PID, String(child.pid));
  console.log('  ' + c.green('✓') + ` gateway started (pid ${child.pid}) on port ${PORT}`);
  console.log(c.dim('  Point your client at it:  ') + `export ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
  console.log(c.dim('  Monitor:  ') + `http://localhost:${PORT}/dashboard`);
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

function run(argv) {
  const cmd = argv[0];
  if (cmd === 'start') return start(argv.slice(1));
  if (cmd === 'stop') return stop();
  if (cmd === 'status') return status();
  console.log('  usage: cheaper gateway <start|stop|status>');
}

module.exports = { run, status, PORT };
