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
// No `http` here any more: the one probe this file made now goes through
// gateway.probeHealth(), so there is exactly one socket-opening /healthz reader in the CLI.
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

// ---- WHERE THE GATEWAY ACTUALLY IS -----------------------------------------
//
// Every reader in this product used to compute its own `process.env.CHEAPER_PORT || '8787'`,
// so a gateway on any other port was invisible to all of them at once: `cheaper status`
// printed amber STOPPED over a perfectly healthy gateway with the command to "fix" it, and
// the end-of-chat tagline printed "gateway not reachable on :8787 … Start it with: cheaper
// gateway start" against a gateway that was serving the whole time. Neither needs anything
// unusual to happen — `cheaper gateway start --port 9000` records 9000, and
// autostart.pickPort() moves the default to 8788 whenever 8787 is busy and bakes THAT into
// the login entry, which the user's shell never sees.
//
// Sources, in order, the most specific evidence about a REAL process first:
//
//   1. gateway.pid's `port=` line — written by `gateway start` AND by `gateway serve` (the
//      supervised launcher) for the uvicorn each spawned; both record the same shape.
//      Consulted only while that pid is still ALIVE: nothing clears this file on a crash or
//      a reboot, so a stale one records where a gateway USED to listen, and preferring it
//      would aim every reader away from a gateway running on the default right now.
//      A legacy bare-pid file (older builds wrote just the number) carries no port line and
//      simply falls through — those installs must keep working exactly as they did.
//   2. ~/.cheaper/autostart.json's enable record — the port the login entry BAKED IN, which
//      is where a supervised gateway will listen and which the user's shell never exports
//      (autostart.pickPort() moves off 8787 to the next free port when it is busy at enable
//      time, and only the login entry carries that choice). This used to be justified by "a supervised gateway writes no pid file at all", and
//      that justification is now false: gateway.js::serve() writes the same
//      `<pid>\nport=<port>` record `start` does, precisely so `stop`/`status` stop reporting
//      a live supervised gateway as stopped. Step 1 therefore already covers a supervised
//      gateway WHILE its uvicorn is alive — but that is the only window it covers, and the
//      record is not redundant outside it:
//        - between a crash/exit and the supervisor's next respawn the pid file is gone
//          (serve removes it on exit), and 8787 is still the wrong answer;
//        - a pid file that could not be written (unwritable ~/.cheaper) or that predates the
//          port= line leaves step 1 with nothing while the login entry still knows the port;
//        - `cheaper status` run before the first login-triggered start has no live pid at all.
//      In every one of those the record is the only local evidence of the real port, and it
//      still ranks BELOW the pid file because it describes configuration, not a live process.
//   3. CHEAPER_PORT — what the caller named, and what the supervised unit exports to the
//      process it starts.
//   4. 8787.
//
// Every step is wrapped: this runs inside `cheaper status`, `cheaper launch` and the Stop
// hook that closes every chat, and failing to resolve a port must degrade to the default
// rather than take down the command that asked.
function activeGatewayPort(env = process.env) {
  // Required lazily, not at load: gateway.js reaches back into this file
  // (reinstallIfStale -> gatewayCodeHash), and a load-time cycle between the two would hand
  // one of them a half-built module.
  let gateway = null;
  try { gateway = require('./gateway'); } catch { gateway = null; }
  if (gateway) {
    try {
      const rec = gateway.readPidFile();
      if (rec && rec.port && gateway.pidAlive(rec.pid)) return String(rec.port);
    } catch { /* an unreadable pid file is not a reason to fail the caller */ }
  }
  try {
    const autostart = require('./autostart');
    const st = autostart.readState(autostart.makeCtx());
    // `enabled` is what disable() clears; a record left behind by an entry the user removed
    // describes a port nothing is listening on.
    const p = st && st.enabled && st.record && st.record.port;
    if (p) return String(p);
  } catch { /* ditto — the autostart record is evidence, never a dependency */ }
  const fromEnv = env && env.CHEAPER_PORT;
  if (fromEnv !== undefined && String(fromEnv).trim() !== '') return String(fromEnv).trim();
  // Read through gateway.js so the two cannot drift; the literal is only reached if that
  // module could not be loaded at all.
  return (gateway && gateway.DEFAULT_PORT) || '8787';
}

// Ask the live gateway what build it is serving. Resolves the parsed /healthz payload, or
// null when nothing OURS answers on the gateway's port — never throws, and never blocks
// longer than the timeout, because this runs in user-facing commands.
//
// The socket work is gateway.probeHealth()'s. This function used to open its own, against a
// port it computed itself, which is exactly how a gateway on 9000 became invisible to
// `cheaper status`. It also accepted ANY 200: a bare `{ok:true}` from whatever else had
// grabbed the port was reported by report() as a Cheaper gateway "whose running build
// predates version reporting" — a build history invented for a stranger's service.
// Identity, not a 200, decides, using the same isOurGateway() the desktop app and
// gateway.start()'s already-running guard use.
//
// An OLD CHEAPER BUILD fails that identity check too (its /healthz predates the fields) and
// is genuinely ours, so it is told apart from a squatter the same way gateway.start() tells
// them apart: by the pid file. Collapsing the two would either hide a stale gateway that
// needs restarting, or print "restart it" at somebody else's service.
async function runningGateway(timeoutMs = 700) {
  let gateway;
  try { gateway = require('./gateway'); } catch { return null; }
  const health = await gateway.probeHealth(activeGatewayPort(), timeoutMs);
  if (!health) return null;
  if (gateway.isOurGateway(health)) return health;
  try {
    const rec = gateway.readPidFile();
    if (rec && gateway.pidAlive(rec.pid) && gateway.pidLooksLikeGateway(rec.pid)) return health;
  } catch { /* an identity check that could not run is not a pass */ }
  return null;
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

// ---- CLAUDE-OWNED INSTALL SURFACES -----------------------------------------
//
// Everything above compares bytes this tool wrote into directories this tool owns
// (~/.cheaper) or into the plugin cache. But `cheaper install` writes SIX durable
// things into paths CLAUDE owns, and report() re-verified exactly one of them (the
// plugin cache):
//
//   ~/.claude/skills/adaptive-model-router/                      install.js:74-82
//   ~/.claude/agents/router-*.md                                 install.js:84-95
//   settings.json hooks.SessionStart + hooks.UserPromptSubmit    install.js:97-113
//   settings.json extraKnownMarketplaces + enabledPlugins        install.js:179-186
//   plugins/known_marketplaces.json                              install.js:160-166
//   plugins/installed_plugins.json                               install.js:168-176
//
// Those five are removed by things that have nothing to do with Cheaper: a harness
// account switch that re-provisions ~/.claude, `claude plugin uninstall`, a settings.json
// edited by hand or by another installer. When they go, routing silently stops happening
// — every request goes to the vendor at list price — while `cheaper status` kept printing
// "current", because the bytes it was comparing were all still fine in ~/.cheaper.
//
// These checks are REPORT-ONLY, deliberately. Repairing them here would mean writing to
// the user's settings.json from a command they ran to LOOK at something; the remedy is
// printed as a command they choose to run. Repair is a separate decision.

// Three outcomes, never conflated: absent (never installed), present-but-unreadable
// (cannot be judged), and parsed. Folding the middle case into "absent" would print a
// quiet `not installed` for a settings.json that exists and is corrupt — the exact
// "could not check reads as fine" failure this file exists to prevent.
function readJsonFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { state: e.code === 'ENOENT' ? 'absent' : 'unreadable', error: e.message }; }
  if (!raw.trim()) return { state: 'malformed', error: 'file is empty' };
  try { return { state: 'parsed', value: JSON.parse(raw) }; }
  catch (e) { return { state: 'malformed', error: e.message }; }
}

// Deliberately duplicated from install.js::pluginRegistered rather than imported.
// freshness.js is required by peek's money path (scan.js:540) and by gateway start;
// importing install.js would drag the whole installer — readline, child_process,
// harness detection — into both, and this file's value is that it has no side effects
// to drag. Three lines of registry read is the cheaper coupling.
function pluginRegistered() {
  const r = readJsonFile(P.INSTALLED_PLUGINS);
  if (r.state !== 'parsed') return false;
  const list = r.value && r.value.plugins && r.value.plugins[P.PLUGIN_ID];
  return Array.isArray(list) && list.length > 0;
}

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit'];

// Matches on the POLICY FILE NAME, not on install.js's exact command string, which is
// `cat "..."` on posix and `type "..."` on win32. install.js::isCheaperHookEntry needs
// the exact form because it DELETES what it matches; this only reports, and a report
// that fires because the user's settings were written on the other platform is a false
// alarm — and a check that cries wolf is worse than no check.
function mentionsPolicy(entry) {
  return !!(entry && Array.isArray(entry.hooks) && entry.hooks.some(
    (h) => h && typeof h.command === 'string' && h.command.includes('router-policy')));
}

// The standalone skill/agents/hook are REMOVED by `cheaper install plugin` on purpose
// (install.js:196-201) — the plugin bundles all three, and duplicate skill/agent names
// double-inject the policy. So their absence is only a finding when the plugin is not
// registered; reporting it unconditionally would put a permanent complaint on every
// plugin user's status screen.
function providedByPlugin() {
  return { state: 'ok', hint: 'provided by the plugin bundle (standalone copy removed by design)' };
}

function skillItem(viaPlugin) {
  const base = { key: 'skill', label: 'Skill (~/.claude/skills)' };
  const src = sourceDir('plugin', 'skills', 'adaptive-model-router');
  const dst = path.join(P.SKILLS_DIR, 'adaptive-model-router');
  const s = hashDir(src), d = hashDir(dst);
  if (!s) return Object.assign(base, { state: 'unverified', dir: dst,
    hint: `no skill source at ${src} — cannot say whether the installed skill is current` });
  if (!d) return Object.assign(base, viaPlugin
    ? providedByPlugin()
    : { state: 'missing', hint: 'cheaper install skill' });
  return Object.assign(base, { state: s === d ? 'ok' : 'stale', source: s, installed: d, dir: dst,
    hint: s === d ? 'up to date' : 'cheaper install --all' });
}

function agentsItem(viaPlugin) {
  const base = { key: 'agents', label: 'Agents (~/.claude/agents)', dir: P.AGENTS_DIR };
  const srcDir = sourceDir('plugin', 'agents');
  // Derived from the source directory, never a hardcoded triple: install.js copies
  // whatever assets/plugin/agents holds, so a fourth agent added there is verified here
  // on the same commit. A hardcoded list keeps reporting "current" for a file it has
  // never heard of — the same class of bug as the four hardcoded tables in peek.
  let names = [];
  try { names = fs.readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort(); }
  catch { /* handled below — an unreadable source is UNVERIFIED, not "fine" */ }
  if (!names.length) return Object.assign(base, { state: 'unverified',
    hint: `no agent sources at ${srcDir} — cannot say whether the installed agents are current` });

  const missing = [], drifted = [], unreadable = [];
  for (const n of names) {
    let a = null, b = null;
    try { a = fs.readFileSync(path.join(srcDir, n)); } catch { unreadable.push(n); continue; }
    try { b = fs.readFileSync(path.join(P.AGENTS_DIR, n)); } catch { missing.push(n); continue; }
    if (!a.equals(b)) drifted.push(n);
  }
  if (unreadable.length) return Object.assign(base, { state: 'unverified',
    hint: `source agent(s) unreadable: ${unreadable.join(', ')} — cannot compare` });
  if (missing.length === names.length) {
    return Object.assign(base, viaPlugin
      ? providedByPlugin()
      : { state: 'missing', hint: 'cheaper install agents' });
  }
  // A PARTIAL set is the dangerous shape and gets its own louder state: the routing
  // skill dispatches to all three tiers by name, so one absent agent is not "mostly
  // installed" — it is a tier that silently fails to escalate at the moment it matters.
  if (missing.length) return Object.assign(base, { state: 'broken',
    hint: `missing agent(s): ${missing.join(', ')} — run: cheaper install agents` });
  if (drifted.length) return Object.assign(base, { state: 'stale',
    hint: `${drifted.join(', ')} differ from source — run: cheaper install --all` });
  return Object.assign(base, { state: 'ok', hint: `${names.length} agent(s) match source` });
}

function hookItem(viaPlugin) {
  const base = { key: 'hook', label: 'Hook (settings.json)' };
  const r = readJsonFile(P.SETTINGS);
  if (r.state === 'absent') {
    return Object.assign(base, viaPlugin
      ? providedByPlugin()
      : { state: 'missing', hint: 'cheaper install hook' });
  }
  if (r.state !== 'parsed') return Object.assign(base, { state: 'unverified',
    hint: `${P.SETTINGS} is present but ${r.state} (${r.error}) — the router-policy hooks `
      + 'cannot be verified, and Claude will not read them either' });

  const hooks = (r.value && r.value.hooks) || {};
  const unwired = HOOK_EVENTS.filter((evt) => !Array.isArray(hooks[evt]) || !hooks[evt].some(mentionsPolicy));
  if (unwired.length === HOOK_EVENTS.length) {
    return Object.assign(base, viaPlugin
      ? providedByPlugin()
      : { state: 'missing', hint: 'cheaper install hook' });
  }
  if (unwired.length) return Object.assign(base, { state: 'broken',
    hint: `settings.json hooks.${unwired.join(' and hooks.')} no longer reference router-policy `
      + '— run: cheaper install hook' });
  // Wired but pointing at nothing. `cat` a missing file injects an EMPTY policy and
  // exits non-zero, which Claude tolerates — so this fails completely silently: every
  // session starts with no routing policy while settings.json still looks correct.
  if (!fs.existsSync(P.HOOK_POLICY)) return Object.assign(base, { state: 'broken',
    hint: `hooks are wired but ${P.HOOK_POLICY} is gone — every session injects an empty `
      + 'policy — run: cheaper install hook' });
  return Object.assign(base, { state: 'ok', hint: HOOK_EVENTS.join(' + ') + ' wired' });
}

function settingsPluginItem(viaPlugin) {
  const base = { key: 'settings-plugin', label: 'Plugin enabled (settings)' };
  const r = readJsonFile(P.SETTINGS);
  if (r.state === 'absent') return Object.assign(base, viaPlugin
    ? { state: 'broken', hint: `the plugin registry lists ${P.PLUGIN_ID} but ${P.SETTINGS} does `
        + 'not exist to enable it — run: cheaper install plugin' }
    : { state: 'missing', hint: 'cheaper install plugin' });
  if (r.state !== 'parsed') return Object.assign(base, { state: 'unverified',
    hint: `${P.SETTINGS} is present but ${r.state} (${r.error}) — cannot verify `
      + 'extraKnownMarketplaces / enabledPlugins' });

  const mk = (r.value.extraKnownMarketplaces || {})[P.MARKETPLACE_NAME];
  const en = (r.value.enabledPlugins || {})[P.PLUGIN_ID];
  // Neither key present at all: either the plugin component was never installed (the
  // default set is skill+agents+hook+gateway, install.js:231) or both were wiped. The
  // registry is what tells those apart, and they need opposite advice.
  if (mk === undefined && en === undefined) {
    return Object.assign(base, viaPlugin
      ? { state: 'broken', hint: `the plugin registry lists ${P.PLUGIN_ID} but settings.json has `
          + 'neither extraKnownMarketplaces nor enabledPlugins — Claude will not load it — '
          + 'run: cheaper install plugin' }
      : { state: 'missing', hint: 'cheaper install plugin' });
  }
  const problems = [];
  if (mk === undefined) problems.push(`extraKnownMarketplaces.${P.MARKETPLACE_NAME} is gone`);
  else if (!mk.source || mk.source.source !== 'directory'
    || typeof mk.source.path !== 'string' || !mk.source.path)
    problems.push(`extraKnownMarketplaces.${P.MARKETPLACE_NAME}.source is not a directory source`);
  if (en === undefined) problems.push(`enabledPlugins["${P.PLUGIN_ID}"] is gone`);
  else if (en !== true) problems.push(`enabledPlugins["${P.PLUGIN_ID}"] is ${JSON.stringify(en)}, not true`);
  if (problems.length) return Object.assign(base, { state: 'broken',
    hint: `${problems.join('; ')} — run: cheaper install plugin` });
  return Object.assign(base, { state: 'ok', hint: 'marketplace mirrored + plugin enabled' });
}

function knownMarketplacesItem(viaPlugin) {
  const base = { key: 'known-marketplaces', label: 'Marketplace registry', dir: P.KNOWN_MARKETPLACES };
  const r = readJsonFile(P.KNOWN_MARKETPLACES);
  const absent = (why) => Object.assign(base, viaPlugin
    ? { state: 'broken', hint: `${why} — run: cheaper install plugin` }
    : { state: 'missing', hint: 'cheaper install plugin' });
  if (r.state === 'absent') return absent(`${P.KNOWN_MARKETPLACES} does not exist`);
  if (r.state !== 'parsed') return Object.assign(base, { state: 'unverified',
    hint: `${P.KNOWN_MARKETPLACES} is present but ${r.state} (${r.error}) — cannot verify the `
      + `${P.MARKETPLACE_NAME} entry` });

  const entry = r.value[P.MARKETPLACE_NAME];
  if (entry === undefined) return absent(`known_marketplaces.json has no ${P.MARKETPLACE_NAME} entry`);
  const problems = [];
  if (!entry.source || entry.source.source !== 'directory' || typeof entry.source.path !== 'string')
    problems.push(`${P.MARKETPLACE_NAME}.source is not a directory source`);
  if (typeof entry.installLocation !== 'string' || !entry.installLocation)
    problems.push(`${P.MARKETPLACE_NAME}.installLocation is missing`);
  // A registry entry pointing at a directory that no longer exists is the shape a
  // half-uninstall leaves behind: Claude believes the marketplace is known, finds
  // nothing to load, and says nothing.
  else if (!fs.existsSync(entry.installLocation))
    problems.push(`installLocation ${entry.installLocation} no longer exists`);
  if (problems.length) return Object.assign(base, { state: 'broken',
    hint: `${problems.join('; ')} — run: cheaper install plugin` });
  return Object.assign(base, { state: 'ok', hint: `${P.MARKETPLACE_NAME} registered` });
}

function installedPluginsItem() {
  const base = { key: 'installed-plugins', label: 'Plugin registry entry', dir: P.INSTALLED_PLUGINS };
  const r = readJsonFile(P.INSTALLED_PLUGINS);
  if (r.state === 'absent') return Object.assign(base, { state: 'missing', hint: 'cheaper install plugin' });
  if (r.state !== 'parsed') return Object.assign(base, { state: 'unverified',
    hint: `${P.INSTALLED_PLUGINS} is present but ${r.state} (${r.error}) — cannot verify the `
      + `${P.PLUGIN_ID} entry` });

  const list = (r.value.plugins || {})[P.PLUGIN_ID];
  // Our entry simply not being there means the plugin component was never installed
  // (or was cleanly uninstalled). That is 'missing', not 'broken' — the file belongs to
  // Claude and legitimately holds other people's plugins.
  if (list === undefined) return Object.assign(base, { state: 'missing', hint: 'cheaper install plugin' });
  const problems = [];
  if (r.value.version !== 2) problems.push(`registry version is ${JSON.stringify(r.value.version)}, not 2`);
  if (!Array.isArray(list) || !list.length) problems.push(`plugins["${P.PLUGIN_ID}"] is empty`);
  else {
    const e = list[0] || {};
    if (typeof e.installPath !== 'string' || !e.installPath) problems.push('installPath is missing');
    else if (!fs.existsSync(e.installPath)) problems.push(`installPath ${e.installPath} no longer exists`);
    if (typeof e.version !== 'string' || !e.version) problems.push('version is missing');
  }
  if (problems.length) return Object.assign(base, { state: 'broken',
    hint: `${problems.join('; ')} — run: cheaper install plugin` });
  return Object.assign(base, { state: 'ok', hint: `${P.PLUGIN_ID} registered` });
}

// The six Claude-owned surfaces, in install order. `viaPlugin` is read ONCE and shared
// so every row judges absence against the same registry answer — computing it per-row
// invites two rows disagreeing about whether the plugin is installed.
function claudeSurfaces() {
  const viaPlugin = pluginRegistered();
  return [
    skillItem(viaPlugin),
    agentsItem(viaPlugin),
    hookItem(viaPlugin),
    settingsPluginItem(viaPlugin),
    knownMarketplacesItem(viaPlugin),
    installedPluginsItem(),
  ];
}

// ---- the report ------------------------------------------------------------
// Each component reports one of:
//   'ok'         installed bytes == source bytes (and, for the gateway, running too)
//   'stale'      installed differs from source            -> cheaper install --all
//   'restart'    installed == source but the process differs -> cheaper gateway restart
//   'stopped'    installed and current, but the process is not up -> cheaper gateway start
//   'broken'     present but structurally wrong (a wiped key, a dangling path)
//   'missing'    never installed                          -> cheaper install --all
//   'unverified' present but unreadable/unparseable — the check COULD NOT RUN
//   'unknown'    could not determine (old build, not running)
//
// 'unverified' and 'ok' must never collapse into each other. A corrupt settings.json
// cannot be judged, and rendering that as green is how a check that cannot run becomes
// indistinguishable from a check that passed.
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
    // Installed, current, and NOT RUNNING. This rendered as green `current` with the
    // words "not running" dimmed beside it, because the state answered "are the bytes
    // right?" while the person reading the row was asking "is it working?". Green is
    // the one colour a reader skips: someone scanning a status screen for anything
    // that is not green stops at the first amber line, and a stopped gateway has none
    // — so every request went straight to the vendor at full price for as long as
    // nobody read the dim text. `up` (below) was already computed from the same
    // /healthz probe; nothing ever rendered it.
    //
    // Kept DISTINCT from 'missing': "installed but stopped" is one `gateway start`
    // away from working, "never installed" needs an install first. Collapsing them
    // would print the wrong command in the one place a user is looking for a command.
    //
    // `!health` means OUR gateway did not answer — not that the port was silent.
    // runningGateway() applies gateway.isOurGateway(), so an unrelated service squatting
    // on the port lands here rather than being reported as a Cheaper gateway. That is the
    // honest row: our gateway is not running. `gateway start` then names the squatter
    // itself (gateway.js's already-running guard), which is where that diagnosis belongs.
    gwState = 'stopped'; gwHint = 'installed and current, but NOT RUNNING — run: cheaper gateway start';
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

  // --- the five Claude-owned surfaces install writes and nothing re-checked ---
  items.push(...claudeSurfaces());

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
  // The ONE port resolver. launch.js and peek/tagline.js import it rather than keeping
  // their own `CHEAPER_PORT || 8787`, so a notice, a link, a health check and a status row
  // can never name different ports for the same gateway.
  activeGatewayPort,
  routerConfig, routerConfigFrom, tierMapOrNull, boolOrNull,
  ROUTER_ASSUMED_DEFAULTS, HEALTHZ_ROUTER_KEY,
  // Exported so the Claude-owned surface checks are drivable one at a time from a
  // test without standing up a whole install — the same reason routerConfigFrom is
  // split out from routerConfig.
  claudeSurfaces, readJsonFile, pluginRegistered, HOOK_EVENTS };
