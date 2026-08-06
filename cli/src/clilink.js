'use strict';
// Installs a `cheaper` launcher on the user's PATH, backed by a stable, self-contained
// copy of this CLI at ~/.cheaper/cli. Used by the `cli` install component so the
// desktop app (or a manual install) can provide the command line without npm.
const fs = require('fs');
const path = require('path');
const os = require('os');
const P = require('./paths');
const { copyDir, removePath, whichSync } = require('./util');

// The directory of THIS cli package (contains bin/, src/, assets/).
const CLI_SOURCE = path.join(__dirname, '..');

function launcherDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'cheaper', 'bin');
  }
  return path.join(os.homedir(), '.local', 'bin');
}
function launcherPath() {
  return path.join(launcherDir(), process.platform === 'win32' ? 'cheaper.cmd' : 'cheaper');
}

function installCliLauncher() {
  // Stage a stable copy so the launcher survives the app being moved/removed.
  // (Skip when we're already running from that copy, or we'd delete our own source.)
  // This doesn't need Node.
  if (path.resolve(CLI_SOURCE) !== path.resolve(P.CLI_HOME)) {
    removePath(P.CLI_HOME);
    copyDir(CLI_SOURCE, P.CLI_HOME);
  }
  const entry = path.join(P.CLI_HOME, 'bin', 'cheaper.js');

  const dir = launcherDir();
  fs.mkdirSync(dir, { recursive: true });
  const lp = launcherPath();

  // Resolve Node at RUN TIME from the caller's PATH — so the launcher keeps working
  // across nvm/fnm/volta version switches, and even when the installer ran from a GUI
  // with a minimal PATH (the terminal that runs `cheaper` has the real PATH). Fall
  // back to whatever Node we can see now, else the bare name.
  const fallback = whichSync('node') || 'node';
  if (process.platform === 'win32') {
    fs.writeFileSync(lp,
      '@echo off\r\n' +
      'where node >nul 2>nul\r\n' +
      `if %errorlevel%==0 ( node "${entry}" %* ) else ( "${fallback}" "${entry}" %* )\r\n`);
  } else {
    fs.writeFileSync(lp,
      '#!/bin/sh\n' +
      'NODE="$(command -v node 2>/dev/null || true)"\n' +
      `[ -n "$NODE" ] || NODE="${fallback}"\n` +
      `exec "$NODE" "${entry}" "$@"\n`);
    fs.chmodSync(lp, 0o755);
  }
  // Always surface the PATH hint: when the desktop app drives the install it injects
  // ~/.local/bin into its own process PATH, so a process-PATH check would falsely
  // report "already on PATH" even though the user's login shell doesn't have it.
  const nodeNote = whichSync('node') ? '' : '   [Node not found now — the launcher resolves it from your PATH at run time]';
  return `cli    -> ${lp}   (ensure ${dir} is on your PATH)${nodeNote}`;
}

function uninstallCliLauncher() {
  const lp = launcherPath();
  const had = fs.existsSync(lp) || fs.existsSync(P.CLI_HOME);
  removePath(lp);
  removePath(P.CLI_HOME);
  return had ? `cli    -> removed launcher + ${P.CLI_HOME}` : 'cli    -> (not present)';
}

module.exports = { installCliLauncher, uninstallCliLauncher, launcherPath, launcherDir, CLI_SOURCE };
