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

// ---- WHICH ROUTER IS ACTUALLY RUNNING --------------------------------------
//
// Freshness above asks "are these the same BYTES?". This asks the second half of the
// same question: "is it the same CONFIGURATION?" Identical bytes running with a
// different environment are a different router, and `peek` prices its whole
// counterfactual against a router.
//
// router.decide() is driven by five operator-settable knobs (app.py::_config_from_env,
// app.py:91-119). peek read NONE of them, so a gateway configured off-default was
// estimated as if it were default — always in the optimistic direction.
//
// THE COST OF NOT ASKING, measured 2026-08-08 against the gateway really running on the
// development machine — same history, same day, the only difference being whether the
// configuration was resolved:
//
//   scan() with shipped defaults   $7,568.85 saved   46.33% off
//   scanLive() with live /healthz  $7,098.77 saved   43.45% off
//
// $470.08 of over-claim, 6.2%, on a gateway nobody had deliberately misconfigured. The
// whole gap is the tier -> id map: peek priced the sonnet leg against `claude-sonnet-5`
// and picked up its promotional rate, while the gateway routes to `claude-sonnet-4-5` at
// list. That gap heals itself when the promo expires on 2026-09-01, which is the worst
// kind of divergence — one that disappears before anyone can reproduce it.
//
// Every knob moves the money. The figures below are a DATED SNAPSHOT, not a constant:
// measured 2026-08-08 over 16,089 priceable rows of this machine's own chat history,
// which grows every time the machine is used. Re-measure before quoting them; what is
// stable is the SHAPE (which knob moves which number, and in which direction), and the
// per-call arithmetic pinned by cli/test/policy_parity.test.js, which is catalog-driven
// and therefore deterministic.
//
//   ROUTER_MODE           heuristic | triage. Under `triage` the content tier is a live
//                         cheap-model verdict (app.py:119), so peek's regex answer is a
//                         STAND-IN for the router's, not the router's. Unmodellable
//                         offline by construction — it needs a model call per row — so
//                         the only honest handling is to LABEL it.
//   ROUTER_MODEL_*        the tier -> id map. peek priced against pricing.ROUTE_TARGET;
//                         an operator who set ROUTER_MODEL_SONNET routes somewhere else,
//                         and the estimate names a model that is never served.
//   ROUTER_MIN_TIER       the floor. min_tier=sonnet changes 6,340 of the 16,089
//                         decisions (39.4%) and takes the claimed gross saving from
//                         $9,270.05 to $7,316.15 — 21.1% of the claim gone. It VOIDS
//                         726 of 9,503 downgrade claims (7.6%); the other 5,614 changed
//                         rows are opus-tier callers whose downgrade merely gets
//                         shallower (opus->sonnet instead of opus->haiku), which loses
//                         dollars without losing the claim. Those are two different
//                         numbers and "39.4% of claims voided" was neither of them.
//   ROUTER_ALLOW_UPGRADE  true disables BOTH ceilings, so the router may route ABOVE the
//                         requested model. Same corpus: peek reports $0.00 of extra spend
//                         where the real router would incur $290.15.
//   ROUTER_LONG_CHARS     the long-request threshold — one signal in the classifier.
//
// /healthz publishes TWO of the five today (`mode`, `models`). The rest are read here IF
// the gateway ever publishes them, and otherwise recorded in `assumed` / the DERIVED
// `missingHealthzKeys`, so a caller can label the figure instead of silently shipping a
// default. Deriving that list from the live payload rather than hardcoding it means this
// file needs no edit when app.py starts answering: the list shrinks by itself, which is
// the opposite of the four-hardcoded-tables failure that produced this whole class of bug.
//
// INVARIANT 7 — a labelled non-number beats a confident wrong one.

// What peek falls back to for a knob the gateway will not tell it. These MUST mirror
// RouterConfig's own defaults (router.py:239-245) and app.py's env defaults, because
// "the gateway is unreachable" and "the gateway is running unconfigured" have to produce
// the same estimate; if they diverge, starting the gateway would silently move the money.
const ROUTER_ASSUMED_DEFAULTS = Object.freeze({
  mode: 'heuristic',                  // app.py:119
  models: null,                       // null => pricing.ROUTE_TARGET_BY_TIER per family
  openaiModels: null,                 // null => same
  minTier: 'haiku',                   // router.py:245
  allowUpgradeAboveRequested: false,  // router.py:241
  longRequestChars: null,             // null => classify.LONG_REQUEST_CHARS
  routableFamilies: null,             // null => pricing.ROUTABLE_FAMILIES
});

// config key -> the /healthz key it would arrive under. The RIGHT-HAND side is the
// contract app.py owes this file: the five marked MISSING are the exact key names the
// gateway must start publishing before peek can stop assuming them, and until it does
// they are what `missingHealthzKeys` reports at runtime. Listing a key here that app.py
// does not serve costs nothing — it simply shows up as missing — and the day app.py does
// serve it, this file needs no edit.
const HEALTHZ_ROUTER_KEY = Object.freeze({
  mode: 'mode',                                   // served today
  models: 'models',                               // served today (the /v1/messages map)
  openaiModels: 'openai_models',                  // MISSING — app.py:152 OPENAI_MODELS
  minTier: 'min_tier',                            // MISSING — CFG.min_tier
  allowUpgradeAboveRequested: 'allow_upgrade',    // MISSING — CFG.allow_upgrade_above_requested
  longRequestChars: 'long_request_chars',         // MISSING — CFG.long_request_chars
  routableFamilies: 'routable_families',          // MISSING — which vendor front ends exist
});

// A tier -> model-id map is usable only when ALL THREE tiers name a non-empty id. A
// partial map is worse than none: routeDecision would index `models[tier]` and get
// undefined for the missing tier, which prices as unknown and silently becomes a
// passthrough — a configuration error rendering as "Cheaper declined to route".
function tierMapOrNull(v) {
  if (!v || typeof v !== 'object') return null;
  const out = {};
  for (const t of ['haiku', 'sonnet', 'opus']) {
    const id = v[t];
    if (typeof id !== 'string' || !id.trim()) return null;
    out[t] = id.trim();
  }
  return out;
}

// Mirrors app.py:98-99 exactly, including the string forms, so an operator who wrote
// ROUTER_ALLOW_UPGRADE=yes is read the same way on both sides. Anything else is not
// "false" — it is UNKNOWN, and returns null so the key stays in `assumed` rather than
// being silently read as the permissive default.
function boolOrNull(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(s)) return true;
  if (['0', 'false', 'no'].includes(s)) return false;
  return null;
}

// The router configuration implied by a /healthz payload (or by its absence).
//
// Split out from the async wrapper so it is drivable from a test without a socket —
// the network is not the thing under test, the READING is.
//
// `minTier` is passed through UNVALIDATED on purpose. classify.routeDecision() clamps an
// unrecognised tier name to 'haiku' and router.py's decide() now does the same
// (app.py:100-109 records why), so validating here would add a THIRD opinion about what a
// typo'd ROUTER_MIN_TIER means — and the one that matters is the router's.
function routerConfigFrom(health) {
  const h = (health && typeof health === 'object') ? health : null;
  const cfg = Object.assign({}, ROUTER_ASSUMED_DEFAULTS);
  const assumed = [];
  const missingHealthzKeys = [];

  const read = {
    mode: () => (typeof h.mode === 'string' && h.mode.trim() ? h.mode.trim().toLowerCase() : null),
    models: () => tierMapOrNull(h.models),
    openaiModels: () => tierMapOrNull(h.openai_models),
    minTier: () => (typeof h.min_tier === 'string' && h.min_tier.trim() ? h.min_tier.trim() : null),
    allowUpgradeAboveRequested: () => boolOrNull(h.allow_upgrade),
    // Guarded on the TYPE before the coercion: Number(true) is 1 and Number('') is 0,
    // so a bare `Number.isFinite(Number(v))` would read a boolean or an empty string as a
    // threshold. A junk value must stay UNKNOWN and keep the key in `assumed`.
    longRequestChars: () => {
      const v = h.long_request_chars;
      if (typeof v !== 'number' && !(typeof v === 'string' && v.trim())) return null;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    },
    routableFamilies: () => (Array.isArray(h.routable_families)
      && h.routable_families.every((x) => typeof x === 'string' && x.trim())
      ? h.routable_families.map((x) => x.trim().toLowerCase()) : null),
  };

  for (const key of Object.keys(HEALTHZ_ROUTER_KEY)) {
    const v = h ? read[key]() : null;
    if (v === null || v === undefined) {
      assumed.push(key);
      missingHealthzKeys.push(HEALTHZ_ROUTER_KEY[key]);
    } else {
      cfg[key] = v;
    }
  }

  // `triage` replaces the whole content classifier with a live model call. peek cannot
  // reproduce that offline at any cost, so it is not "assumed", it is UNMODELLABLE — a
  // separate and louder claim, kept separate so a caller can word it differently.
  const triageUnmodellable = cfg.mode === 'triage';

  return Object.assign(cfg, {
    source: h ? 'gateway' : 'defaults',
    reachable: !!h,
    assumed,
    missingHealthzKeys,
    triageUnmodellable,
    // True whenever ANY money-moving fact was guessed. A caller printing dollars MUST
    // print a qualifier when this is set — that is the whole point of resolving the
    // config before the money is printed rather than after.
    labelled: assumed.length > 0 || triageUnmodellable,
    note: h
      ? (assumed.length
        ? `live gateway; ${assumed.length} routing knob(s) not reported by /healthz `
          + `(${missingHealthzKeys.join(', ')}) — assuming shipped defaults`
        : 'live gateway; every routing knob reported')
      : 'gateway not reachable — assuming shipped defaults for every routing knob',
  });
}

// Ask the live gateway what router configuration it is serving. Never throws and never
// blocks past the timeout: an unreachable gateway is an ANSWER here ("assuming defaults"),
// not an error, because the commands that call this print money either way.
async function routerConfig(timeoutMs) {
  return routerConfigFrom(await runningGateway(timeoutMs));
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

module.exports = { report, hashDir, gatewayCodeHash, runningGateway, cliOrigin, GATEWAY_CODE,
  routerConfig, routerConfigFrom, tierMapOrNull, boolOrNull,
  ROUTER_ASSUMED_DEFAULTS, HEALTHZ_ROUTER_KEY };
