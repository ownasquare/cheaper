'use strict';
// Is what's RUNNING the same as what's BUILT?
//
// Cheaper's code exists at three layers, and each can silently lag the one behind it:
//
//   source     cli/assets/**            what the repo says the code is
//   installed  ~/.cheaper, ~/.claude    what `cheaper install` copied out
//   running    the live gateway process what Python actually holds in memory
//
// Both failure modes have already bitten:
//   * installed < source  — you edited the repo and forgot `cheaper install --all`.
//   * running < installed — the files were correct, but the gateway process had
//     imported the OLD modules 12 minutes earlier and kept serving them. `install`
//     cannot fix this, because the bytes on disk were already right. The only signal
//     was a missing key in a JSON payload nobody was looking at.
//
// So freshness is computed from CONTENT HASHES rather than mtimes: a copy preserves
// nothing reliable about time, and `mtime newer` is not the same claim as `bytes equal`.
// Every check answers "are these bytes identical", which is the question that matters.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const P = require('./paths');

// Files that are generated, cached, or otherwise not part of "the code".
//
// `.in_use` matters specifically: Claude Code writes a lockfile per live session into
// the plugin cache directory, so a naive content hash reports the cache as permanently
// drifted from source. A check that always fires is worse than no check — people learn
// to ignore it, and then miss the one time it was real. Everything here is runtime
// state, never shipped content. `.claude-plugin/` is real content and must NOT be added.
const IGNORE_DIR = /(^|[/\\])(\.venv|venv|__pycache__|\.pytest_cache|node_modules|\.git|\.in_use)([/\\]|$)/;
const IGNORE_FILE = /\.(pyc|pyo|log|db)$/i;

function walk(dir, base, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs);
    if (IGNORE_DIR.test(rel)) continue;
    if (e.isDirectory()) walk(abs, base, out);
    else if (e.isFile() && !IGNORE_FILE.test(e.name)) out.push(rel);
  }
  return out;
}

// Deterministic hash of a directory's contents: sorted relpath + content digest.
// Returns null when the directory is absent, which callers must distinguish from
// "present but different" — a missing install and a stale install need different advice.
function hashDir(dir, opts) {
  if (!dir || !fs.existsSync(dir)) return null;
  const only = opts && opts.only;
  const files = walk(dir, dir, []).filter((f) => !only || only.test(f));
  if (!files.length) return null;
  const h = crypto.createHash('sha256');
  for (const rel of files.sort()) {
    h.update(rel.split(path.sep).join('/'));
    h.update('\0');
    try { h.update(fs.readFileSync(path.join(dir, rel))); } catch { h.update('UNREADABLE'); }
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

// The gateway hashes the same set, so its self-reported digest is comparable to this.
// Tests and .env.example are deliberately excluded: changing a test does not make a
// running process stale.
//
// `.html` is included, and that omission was a real hole: the dashboard and the
// printable report are served from disk by the gateway, so editing either changed
// what users see while every freshness check reported "current" and `gateway restart`
// skipped its auto-reinstall. Both templates sat stale in ~/.cheaper/gateway.
//
// MUST stay in lock-step with _code_sha() in app.py — same extensions, same order.
// Widening one side alone makes the comparison always-differ, which is a permanent
// false alarm rather than a fix.
const GATEWAY_CODE = /^app[/\\][^/\\]+\.(py|json|html)$/;

function gatewayCodeHash(root) {
  return hashDir(root, { only: GATEWAY_CODE });
}

// Ask the live gateway what build it is serving. Resolves to null on any failure
// (not running, old build with no code_sha, wrong port) — never throws, and never
// blocks longer than the timeout, because this runs in user-facing commands.
function runningGateway(timeoutMs = 700) {
  return new Promise((resolve) => {
    const port = process.env.CHEAPER_PORT || '8787';
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

// Where the CLI's own assets live (the source of truth for an install).
function sourceDir(...rest) { return path.join(P.ASSETS, ...rest); }

// Is the `cheaper` on PATH this working tree, or a different copy shadowing it?
// A registry install silently shadowing a dev checkout means every `install --all`
// deploys someone else's build while the repo sits unused.
function cliOrigin() {
  const repoCli = path.resolve(__dirname, '..');           // .../cheaper-app/cli
  let resolved = null;
  try { resolved = fs.realpathSync(repoCli); } catch { resolved = repoCli; }
  let version = null;
  try { version = require(path.join(repoCli, 'package.json')).version; } catch { /* ignore */ }
  // __dirname is inside whichever copy is actually executing, so this is self-reporting.
  return { dir: resolved, version, linked: fs.existsSync(path.join(repoCli, 'assets')) };
}

// ---- the report ------------------------------------------------------------
// Each component reports one of:
//   'ok'         installed bytes == source bytes (and, for the gateway, running too)
//   'stale'      installed differs from source            -> cheaper install --all
//   'restart'    installed == source but the process differs -> cheaper gateway restart
//   'missing'    never installed                          -> cheaper install --all
//   'unknown'    could not determine (old build, not running)
async function report() {
  const items = [];

  // --- gateway: the only component with a RUNNING layer ---
  const gwSrc = sourceDir('gateway');
  const srcHash = gatewayCodeHash(gwSrc);
  const instHash = gatewayCodeHash(P.GATEWAY_DIR);
  const health = await runningGateway();
  const runHash = health && health.code_sha ? String(health.code_sha) : null;

  // The two failures are INDEPENDENT and frequently co-occur: you edit the repo
  // (installed goes stale) while a process from before the edit is still up (running
  // goes stale too). Reporting only the first would send you round the loop twice —
  // install, re-check, discover the restart, restart. So both are computed and the
  // remedy names every step needed to actually reach a current state.
  const installStale = !!instHash && instHash !== srcHash;
  // A reachable gateway that reports no build predates code_sha, so it is by
  // definition older than this one. Absence of evidence IS evidence here.
  const runStale = !!health && (!runHash || runHash !== instHash || installStale);

  let gwState, gwHint;
  if (!instHash) {
    gwState = 'missing'; gwHint = 'cheaper install gateway';
  } else if (installStale || runStale) {
    const steps = [];
    if (installStale) steps.push('cheaper install --all');
    if (runStale) steps.push('cheaper gateway restart');
    gwState = installStale ? 'stale' : 'restart';
    gwHint = steps.join(' && ')
      + (health && !runHash ? '  (running build predates version reporting)' : '');
  } else if (!health) {
    gwState = 'ok'; gwHint = 'not running';
  } else {
    gwState = 'ok'; gwHint = 'running current build';
  }
  items.push({
    key: 'gateway', label: 'Gateway', state: gwState, hint: gwHint,
    source: srcHash, installed: instHash, running: runHash,
    up: !!health,
  });

  // --- file-only components ---
  const pluginSrc = sourceDir('plugin');
  const pluginDst = path.join(P.MARKETPLACE_DIR, 'plugins', P.PLUGIN_NAME);
  // Claude Code caches the plugin at <cache>/<marketplace>/<plugin>/<version>, so the
  // directory to compare depends on the version the marketplace copy declares. Getting
  // this path wrong yields a permanent false "not installed" — worse than no check,
  // because a warning that is always on is a warning nobody reads.
  let cacheDst = null, cacheVersion = null;
  try {
    cacheVersion = require(path.join(pluginDst, '.claude-plugin', 'plugin.json')).version;
  } catch { /* marketplace copy absent or malformed */ }
  if (cacheVersion) cacheDst = path.join(P.PLUGINS_CACHE, P.MARKETPLACE_NAME, P.PLUGIN_NAME, cacheVersion);

  for (const [key, label, src, dst] of [
    ['plugin', 'Plugin (marketplace)', pluginSrc, pluginDst],
    ['plugin-cache', 'Plugin (Claude Code cache)', pluginSrc, cacheDst],
  ]) {
    const s = hashDir(src), d = dst ? hashDir(dst) : null;
    items.push({
      key, label, source: s, installed: d, dir: dst,
      state: !d ? 'missing' : (s === d ? 'ok' : 'stale'),
      hint: !d ? 'cheaper install plugin' : (s === d ? 'up to date' : 'cheaper install --all'),
    });
  }

  // --- desktop app: a FOURTH layer, and the one that stays wrong the longest ---
  //
  // The Electron app ships its own copy of this CLI as extraResources, frozen at build
  // time. A stale CLI here is worse than anywhere else: a bad number in a signed,
  // notarised artifact is out there until the next release, whereas everything above
  // can be corrected the same day. It was found vendoring 0.1.0 against a declared
  // ^0.2.5, which would have shipped the retired $15/$75 Opus rate to every download.
  //
  // Reported only when a sibling checkout exists; absence is not a problem to flag.
  const desktopRoot = path.resolve(__dirname, '..', '..', '..', 'cheaper-desktop');
  const vendored = path.join(desktopRoot, 'node_modules', 'cheaper');
  if (fs.existsSync(desktopRoot) && fs.existsSync(vendored)) {
    const selfRoot = path.resolve(__dirname, '..');   // this CLI
    let vVer = null, sVer = null;
    try { vVer = require(path.join(vendored, 'package.json')).version; } catch { /* ignore */ }
    try { sVer = require(path.join(selfRoot, 'package.json')).version; } catch { /* ignore */ }
    // Compare the code that decides what a user sees, not the whole tree (which would
    // drown in node_modules and build output).
    const srcSelf = hashDir(path.join(selfRoot, 'src'));
    const srcVend = hashDir(path.join(vendored, 'src'));
    const matches = !!srcSelf && srcSelf === srcVend && vVer === sVer;
    items.push({
      key: 'desktop', label: 'Desktop app (bundled CLI)',
      source: sVer, installed: vVer,
      state: matches ? 'ok' : 'stale',
      hint: matches
        ? `bundles ${vVer}`
        : `bundles ${vVer || '?'} but this build is ${sVer} — run: npm install (in cheaper-desktop)`,
    });
  }

  return { items, cli: cliOrigin(), pluginVersion: cacheVersion };
}

module.exports = { report, hashDir, gatewayCodeHash, runningGateway, cliOrigin, GATEWAY_CODE };
