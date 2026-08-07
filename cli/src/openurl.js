'use strict';
// Open a URL in the default browser, and an optional interactive "Press [ENTER] to
// open …" prompt. The prompt is TTY-only: when stdin/stdout aren't interactive (the
// desktop app, CI, a piped script), it resolves immediately without waiting, so a
// non-interactive caller is never blocked.

const { spawn } = require('child_process');
const { c } = require('./util');

function open(url) {
  try {
    if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

// Print "Press [ENTER] to open <label>…" and open the URL when the user hits a key.
// Resolves true if we opened, false if skipped (non-TTY). Releases stdin so the
// process can exit afterward.
function promptThenOpen(url, label) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return resolve(false);
    process.stdout.write(
      '  ' + c.bold('Press [ENTER]') +
      c.dim(' to open ' + (label || 'the dashboard') + ' in your browser') +
      c.dim('   (Ctrl-C to skip)  '));
    const done = () => {
      process.stdin.removeListener('data', done);
      process.stdin.pause();
      process.stdout.write('\n');
      open(url);
      resolve(true);
    };
    try { process.stdin.resume(); process.stdin.once('data', done); }
    catch { resolve(false); }
  });
}

module.exports = { open, promptThenOpen };
