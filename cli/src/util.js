'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const c = {
  amber: (s) => `\x1b[38;5;208m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function removePath(p) {
  // Recursively remove a file or directory; no-op if it doesn't exist.
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}

function nowIso() {
  return new Date().toISOString();
}

// Resolve an executable on PATH (cross-platform). Returns the path or null.
// Uses spawnSync on the platform's locator so it works without a shell.
function whichSync(bin) {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(locator, [bin], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) return r.stdout.split(/\r?\n/)[0].trim() || null;
  } catch { /* ignore */ }
  return null;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}

// Lenient read for read-ONLY checks: any problem (missing, unreadable, malformed)
// yields the fallback. NEVER call this immediately before overwriting the file —
// a malformed file would be silently replaced, destroying its contents. Use
// readJSONForUpdate on any read-modify-write path.
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

// Strict read for read-modify-WRITE paths. A missing or empty file returns the
// fallback, but a present-but-unparseable file THROWS rather than being silently
// clobbered — that clobber would wipe unrelated keys in settings.json or drop the
// user's other plugins/marketplaces from the shared registry.
function readJSONForUpdate(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  if (raw.trim() === '') return fallback;
  try { return JSON.parse(raw); }
  catch (e) {
    throw new Error(
      `${file} exists but is not valid JSON (${e.message}). Refusing to overwrite it ` +
      `and lose your settings — back it up, fix the JSON, then re-run.`);
  }
}

// Atomic write (temp file + rename) with a one-time .bak of the prior contents,
// so an interrupted write can't truncate the target and the previous version stays
// recoverable.
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = JSON.stringify(obj, null, 2) + '\n';
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch { /* best effort */ }
  fs.renameSync(tmp, file); // atomic replace on POSIX; MoveFileEx-replace on win32
}

module.exports = { c, copyDir, removePath, nowIso, whichSync, ask, readJSON, readJSONForUpdate, writeJSON };
