'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('./paths');
const { c, copyDir, removePath, nowIso, whichSync, ask, readJSON, readJSONForUpdate, writeJSON } = require('./util');
const { installCliLauncher, launcherPath, launcherDir } = require('./clilink');
const { detectHarnesses } = require('./harnesses');
const taglineInstall = require('./tagline_install');

// Keys that mean "Claude Code" when passed to --harness (peek/adapters.js's
// canonical key is 'claude-code'; accept the shorter alias too).
const CLAUDE_HARNESS_KEYS = new Set(['claude-code', 'claude']);
// Harnesses tagline_install.js actually knows how to wire (its TARGETS list).
// Any OTHER detected harness gets logged as "detected, no adapter yet" rather
// than silently skipped or handled by an invented mechanism.
const TAGLINE_HARNESS_KEYS = new Set(taglineInstall.TARGETS.map((t) => t.key));

const AGENT_FILES = [
  'router-triage.md',
  'router-solver-sonnet.md',
  'router-solver-opus.md',
];

// --- helpers ---------------------------------------------------------------

function pluginRegistered() {
  const reg = readJSON(P.INSTALLED_PLUGINS, {}); // lenient: a check, never a write
  const list = reg.plugins && reg.plugins[P.PLUGIN_ID];
  return Array.isArray(list) && list.length > 0;
}

// The exact settings.json command our hook injects (platform-specific). Used as a
// precise identity so we only ever touch entries THIS installer created — never a
// user's own hook that happens to mention "router-policy".
function cheaperHookCmd() {
  return process.platform === 'win32' ? `type "${P.HOOK_POLICY}"` : `cat "${P.HOOK_POLICY}"`;
}
function isCheaperHookEntry(e) {
  return !!(e && Array.isArray(e.hooks) && e.hooks.some((h) => h && h.command === cheaperHookCmd()));
}

// Run the `claude` CLI portably. npm installs it as `claude.cmd` on Windows, which
// modern Node cannot spawn without a shell — so on win32 go through the shell with
// quoted args; elsewhere exec the resolved binary directly.
function runClaude(claudeBin, args) {
  const opts = { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' };
  if (process.platform === 'win32') {
    const q = args.map((a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a));
    return spawnSync(`claude ${q.join(' ')}`, { ...opts, shell: true });
  }
  return spawnSync(claudeBin, args, opts);
}

// Strip our own SessionStart/UserPromptSubmit policy hook from settings.json.
// Returns true if anything was removed.
function dewireStandaloneHook() {
  const settings = readJSONForUpdate(P.SETTINGS, {});
  if (!settings.hooks) return false;
  let changed = false;
  for (const evt of ['SessionStart', 'UserPromptSubmit']) {
    const before = settings.hooks[evt];
    if (!Array.isArray(before)) continue;
    const after = before.filter((e) => !isCheaperHookEntry(e));
    if (after.length !== before.length) { settings.hooks[evt] = after; changed = true; }
    if (settings.hooks[evt] && settings.hooks[evt].length === 0) delete settings.hooks[evt];
  }
  if (changed) writeJSON(P.SETTINGS, settings);
  return changed;
}

// --- individual component installers ---------------------------------------

function installSkill() {
  const src = path.join(P.ASSETS, 'plugin', 'skills', 'adaptive-model-router');
  const dst = path.join(P.SKILLS_DIR, 'adaptive-model-router');
  copyDir(src, dst);
  let msg = `skill  -> ${dst}`;
  if (pluginRegistered())
    msg += c.dim('  (note: the plugin already provides this skill; standalone copy may duplicate it)');
  return msg;
}

function installAgents() {
  // The three tiered subagents are the actual model-override mechanism. They
  // must live in a discovered location (~/.claude/agents), not only inside the
  // plugin bundle — otherwise the routing skill has no agents to dispatch to.
  const src = path.join(P.ASSETS, 'plugin', 'agents');
  fs.mkdirSync(P.AGENTS_DIR, { recursive: true });
  for (const f of AGENT_FILES) fs.copyFileSync(path.join(src, f), path.join(P.AGENTS_DIR, f));
  let msg = `agents -> ${P.AGENTS_DIR} (${AGENT_FILES.map((f) => f.replace('.md', '')).join(', ')})`;
  if (pluginRegistered())
    msg += c.dim('  (note: the plugin already provides these agents; standalone copies may duplicate them)');
  return msg;
}

function installHook() {
  // Copy the policy the hook injects, then wire SessionStart + UserPromptSubmit
  // command hooks into settings.json that cat it every turn.
  fs.mkdirSync(P.CHEAPER_DIR, { recursive: true });
  const policySrc = path.join(P.ASSETS, 'plugin', 'hooks', 'context', 'router-policy.md');
  fs.copyFileSync(policySrc, P.HOOK_POLICY);

  const settings = readJSONForUpdate(P.SETTINGS, {});
  settings.hooks = settings.hooks || {};
  const entry = { matcher: '', hooks: [{ type: 'command', command: cheaperHookCmd(), timeout: 10 }] };
  for (const evt of ['SessionStart', 'UserPromptSubmit']) {
    settings.hooks[evt] = (settings.hooks[evt] || []).filter((e) => !isCheaperHookEntry(e));
    settings.hooks[evt].push(entry);
  }
  writeJSON(P.SETTINGS, settings);
  return `hook   -> ${P.SETTINGS} (SessionStart + UserPromptSubmit)`;
}

function installGateway() {
  const src = path.join(P.ASSETS, 'gateway');
  copyDir(src, P.GATEWAY_DIR);
  return `gateway -> ${P.GATEWAY_DIR} (run: cheaper gateway start)`;
}

// Build the local marketplace source directory Claude will register.
function buildMarketplace() {
  removePath(P.MARKETPLACE_DIR);
  const pluginDst = path.join(P.MARKETPLACE_DIR, 'plugins', P.PLUGIN_NAME);
  fs.mkdirSync(path.join(P.MARKETPLACE_DIR, '.claude-plugin'), { recursive: true });
  copyDir(path.join(P.ASSETS, 'plugin'), pluginDst);

  // Keep this to the keys `claude plugin validate` accepts: root { name, owner,
  // plugins }, and per-plugin { name, description, author, category, source }.
  // ($schema / root description / renames / displayName are rejected by the
  // validator, even though the runtime tolerates them.)
  const manifest = {
    name: P.MARKETPLACE_NAME,
    owner: { name: 'Beladed' },
    plugins: [
      {
        name: P.PLUGIN_NAME,
        description:
          'Adaptive Claude model routing: triage each request with the cheapest ' +
          'model first and escalate only when warranted, plus three tiered subagents.',
        author: { name: 'Beladed' },
        category: 'workflow',
        source: `./plugins/${P.PLUGIN_NAME}`,
      },
    ],
  };
  writeJSON(path.join(P.MARKETPLACE_DIR, '.claude-plugin', 'marketplace.json'), manifest);

  const pj = readJSON(path.join(pluginDst, '.claude-plugin', 'plugin.json'), {});
  return { pluginDst, version: pj.version || '0.0.0' };
}

// Fallback: replicate exactly what `claude plugin install` writes (registry v2).
function registerPluginDirect(version) {
  const cacheDst = path.join(P.PLUGINS_CACHE, P.MARKETPLACE_NAME, P.PLUGIN_NAME, version);
  removePath(cacheDst);
  copyDir(path.join(P.MARKETPLACE_DIR, 'plugins', P.PLUGIN_NAME), cacheDst);

  // known_marketplaces.json — merge; refuse to clobber a malformed registry
  const known = readJSONForUpdate(P.KNOWN_MARKETPLACES, {});
  known[P.MARKETPLACE_NAME] = {
    source: { source: 'directory', path: P.MARKETPLACE_DIR },
    installLocation: P.MARKETPLACE_DIR,
    lastUpdated: nowIso(),
  };
  writeJSON(P.KNOWN_MARKETPLACES, known);

  // installed_plugins.json (version 2) — merge; preserve the user's other plugins
  const reg = readJSONForUpdate(P.INSTALLED_PLUGINS, {});
  reg.version = 2;
  reg.plugins = reg.plugins || {};
  const ts = nowIso();
  reg.plugins[P.PLUGIN_ID] = [
    { scope: 'user', installPath: cacheDst, version, installedAt: ts, lastUpdated: ts },
  ];
  writeJSON(P.INSTALLED_PLUGINS, reg);

  // settings.json — extraKnownMarketplaces mirror + enable the plugin
  const settings = readJSONForUpdate(P.SETTINGS, {});
  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
  settings.extraKnownMarketplaces[P.MARKETPLACE_NAME] = {
    source: { source: 'directory', path: P.MARKETPLACE_DIR },
  };
  settings.enabledPlugins = settings.enabledPlugins || {};
  settings.enabledPlugins[P.PLUGIN_ID] = true;
  writeJSON(P.SETTINGS, settings);
}

function installPlugin() {
  // 1. Remove the legacy bare dir an older installer left (Claude never loaded it).
  removePath(P.LEGACY_PLUGIN_DIR);

  // 2. De-dupe: the plugin bundles the same skill + agents + hook, so drop the
  //    standalone copies to avoid duplicate skill/agent names and double policy
  //    injection. These are this tool's own artifacts, so removal is safe.
  const cleaned = [];
  const soloSkill = path.join(P.SKILLS_DIR, 'adaptive-model-router');
  if (fs.existsSync(soloSkill)) { removePath(soloSkill); cleaned.push('standalone skill'); }
  const soloAgents = AGENT_FILES.map((f) => path.join(P.AGENTS_DIR, f)).filter(fs.existsSync);
  if (soloAgents.length) { soloAgents.forEach(removePath); cleaned.push('standalone agents'); }
  if (dewireStandaloneHook()) cleaned.push('standalone settings.json hook');

  // 3. Build the local marketplace and register it with Claude.
  const { version } = buildMarketplace();
  let via = 'registry';
  const claudeBin = whichSync('claude');
  if (claudeBin) {
    runClaude(claudeBin, ['plugin', 'marketplace', 'add', P.MARKETPLACE_DIR]);
    runClaude(claudeBin, ['plugin', 'install', P.PLUGIN_ID]);
    if (pluginRegistered()) via = 'claude CLI';
  }
  // Verify; fall back to direct registry writes if the CLI wasn't there or didn't take.
  if (!pluginRegistered()) { registerPluginDirect(version); via = 'registry'; }
  if (!pluginRegistered()) throw new Error('plugin registration could not be verified');

  let msg = `plugin -> registered ${c.bold(P.PLUGIN_ID)} (v${version}, via ${via}); marketplace source at ${P.MARKETPLACE_DIR}`;
  if (cleaned.length) msg += c.dim(`\n           cleaned up: ${cleaned.join(', ')} (superseded by the plugin)`);
  return msg;
}

// Register the login entry that starts the gateway at every login. Reaching this
// function at all requires the user to have NAMED autostart (`cheaper install autostart`
// or picking it in the menu) — see the DEFAULT_KEYS comment below.
function installAutostart() {
  const r = require('./autostart').enable([]);
  // enable() prints its own detail block (what was written, how to remove it) and answers
  // ok:false for anything it could not VERIFY. Throwing here is what turns that into the
  // red ✗ and the non-zero exit code the loop below already produces for a failed
  // component — an unverified login daemon must never be reported with a green tick.
  if (!r.ok) throw new Error(r.msg);
  return r.msg;
}

// WHAT WILL ACTUALLY RUN ON THIS MACHINE, RIGHT NOW.
//
// The closing notes print next-step commands, and they used to hard-code `cheaper …`. On a
// fresh machine that produced an install ending in advice that could not be followed —
// `zsh: command not found: cheaper` on the very first line the user typed.
//
// `cli` is now in the default set, so the launcher usually exists by the time this prints.
// That is NOT the same as it being runnable: it lands in ~/.local/bin, which macOS does not
// put on PATH by default, and even when the shell profile does have it, THIS process's PATH
// was captured before the file existed. So the state is checked rather than assumed, and the
// three cases get three different remedies instead of one misleading command:
//
//   on PATH           `cheaper …` is correct. Print it unchanged, say nothing.
//   launcher on disk  The file exists; its directory is not on PATH. Naming the directory is
//                     the fix — reinstalling would change nothing and is the obvious wrong
//                     guess for a user staring at "command not found".
//   neither           `npx cheaper …` is the only thing that works this second, so that is
//                     what gets printed, plus how to stop needing npx.
//
// This is also why the note prints FIRST: every tagline this run wrote into a harness file
// is a `cheaper peek --tagline` invocation (tagline_install.js:61), so a broken PATH does not
// merely block the commands below, it silently disables everything the run just reported as
// wired.
function cheaperInvocation() {
  if (whichSync('cheaper')) return { cmd: 'cheaper', note: null };
  let lp = null;
  try { lp = launcherPath(); } catch (e) { lp = null; }
  if (lp && fs.existsSync(lp)) {
    return {
      cmd: lp,
      note: 'The `cheaper` launcher is installed at ' + lp + ', but ' + launcherDir() +
        ' is not on your PATH, so the bare name will not resolve. Add it to your shell '
        + 'profile:  export PATH="' + launcherDir() + ':$PATH"   — until you do, the '
        + 'commands below use the full path, and the savings taglines just wired into your '
        + 'other harnesses will not run.',
    };
  }
  return {
    cmd: 'npx cheaper',
    note: 'No `cheaper` command is on your PATH, so the commands below use `npx cheaper`, '
      + 'which always works. For a permanent one:  npx cheaper install cli   — note that '
      + 'the savings taglines wired into your other harnesses invoke `cheaper` by name and '
      + 'will not run until it resolves.',
  };
}

// skill/agents/hook/gateway/cli are the reliable, discovered-location default set.
// plugin is an opt-in managed packaging of skill+agents+hook (mutually exclusive).
const COMPONENTS = [
  { key: 'skill', label: 'Skill (routing procedure + rubric)', fn: installSkill },
  { key: 'agents', label: 'Agents (three tiered subagents: haiku/sonnet/opus)', fn: installAgents },
  { key: 'hook', label: 'Hook (always-on policy injection)', fn: installHook },
  { key: 'gateway', label: 'Gateway (proxy that routes every API call + monitor)', fn: installGateway },
  { key: 'plugin', label: 'Plugin (managed bundle of skill+agents+hook; alt. to the above)', fn: installPlugin },
  { key: 'cli', label: 'CLI (a `cheaper` command on your PATH)', fn: installCliLauncher },
  // LAST on purpose: when several components are named in one run, the gateway and the
  // CLI copy it supervises must already be on disk before a login entry is pointed at
  // them (autostart.js refuses outright if ~/.cheaper/cli is missing).
  { key: 'autostart', label: 'Autostart (opt-in login entry that keeps the gateway running)', fn: installAutostart },
];
// NOTE: 'autostart' is deliberately absent, and `all` below is built from this list, so
// NEITHER a bare `cheaper install` NOR `cheaper install --all` can ever register a login
// daemon. install.js already refuses to install ordinary components when it cannot ask
// (see the non-TTY branch in run()); a self-restarting service that survives the terminal
// which created it, starts a listener at every login, and shows up in the user's own
// System Settings needs a stronger gate than "the default happened to include it".
// It is reachable by naming it — `cheaper install autostart`, the interactive picker, or
// `cheaper autostart enable` — and by nothing else.
// `cli` IS IN THE DEFAULT SET, and has to be: everything else this installer produces
// names a `cheaper` command.
//
// It used to be opt-in, and the result on a fresh machine installed with
// `npx cheaper install` was an install that reported nothing but green ticks and then did
// not work. The very first command it told the user to run failed:
//
//     $ cheaper gateway start
//     zsh: command not found: cheaper
//
// That is the visible half. The invisible half is worse: tagline_install.js writes the
// literal string `cheaper peek --tagline …` into every harness's global-instructions file
// (tagline_install.js:61), so a run that printed "✓ tagline wired" for Codex, Grok, Copilot,
// PI.dev and Cursor had in fact wired five instructions that could never execute. Nothing
// would have reported that; the taglines would simply never appear.
//
// This is the same defect class harnesses.js:18 already warns about one level up — a user
// reading "✓ wired" and believing something is in place that is not. The fix there was to
// stop overclaiming; the fix here is to stop shipping the gap, because unlike routing, the
// launcher is ours to install and costs one file.
//
// `autostart` remains deliberately absent — see the note above. A launcher is a file on
// PATH; a login daemon is a process that survives the terminal that created it, and those
// two do not deserve the same gate.
const DEFAULT_KEYS = ['skill', 'agents', 'hook', 'gateway', 'cli'];

// Accept plurals + synonyms so `install hooks`, `install agent`, `install rules`
// don't silently abort with "Nothing selected". A token may expand to several
// canonical component keys ("rules"/"policy" = the behavioural set skill+agents+hook).
const ALIASES = {
  skill: ['skill'], skills: ['skill'],
  agent: ['agents'], agents: ['agents'],
  hook: ['hook'], hooks: ['hook'],
  gateway: ['gateway'], proxy: ['gateway'],
  plugin: ['plugin'], bundle: ['plugin'],
  cli: ['cli'],
  // Aliases for autostart exist so `install login-item` / `install daemon` resolve
  // instead of falling through to "Nothing selected" — but NONE of them is reachable
  // from `all`, which is DEFAULT_KEYS and does not contain autostart.
  autostart: ['autostart'], login: ['autostart'], daemon: ['autostart'],
  rules: ['skill', 'agents', 'hook'], rule: ['skill', 'agents', 'hook'],
  policy: ['skill', 'agents', 'hook'], router: ['skill', 'agents', 'hook'],
  all: DEFAULT_KEYS.slice(),
};
// Map free-text tokens (and "1 2 3" indices) to canonical component keys. Returns the
// deduped valid keys plus any tokens we couldn't resolve (so we can warn, not abort).
function normalizeKeys(tokens) {
  const out = [], unknown = [];
  for (const raw of tokens) {
    const t = String(raw).toLowerCase();
    const asIndex = COMPONENTS[parseInt(t, 10) - 1];
    if (ALIASES[t]) out.push(...ALIASES[t]);
    else if (COMPONENTS.some((x) => x.key === t)) out.push(t);
    else if (/^\d+$/.test(t) && asIndex) out.push(asIndex.key);
    else unknown.push(raw);
  }
  return { keys: [...new Set(out)], unknown };
}

// Programmatic entry point (used by the CLI's run() and by the desktop app).
// Applies the plugin-supersedes-standalone rule and returns per-component results.
function install({ components } = {}) {
  let chosen = components && components.length ? components.slice() : DEFAULT_KEYS.slice();
  if (chosen.includes('plugin')) chosen = chosen.filter((k) => !['skill', 'agents', 'hook'].includes(k));
  const results = [];
  for (const comp of COMPONENTS.filter((x) => chosen.includes(x.key))) {
    try { results.push({ key: comp.key, ok: true, msg: comp.fn() }); }
    catch (e) { results.push({ key: comp.key, ok: false, msg: e.message }); }
  }
  return results;
}

// Component-install state (shared by `cheaper status` and the desktop app).
function status() {
  let hookWired = false;
  try { hookWired = JSON.stringify(readJSON(P.SETTINGS, {}).hooks || {}).includes('router-policy'); } catch { /* ignore */ }
  // `autostartOnDisk` is FILESYSTEM EVIDENCE ONLY: a plist/unit exists (on Windows, an
  // enable record does). It deliberately does not shell out to launchctl/systemctl/
  // schtasks, because `cheaper status` runs on every invocation and those probes are the
  // slow part — but that means it cannot see a user who switched the entry off in Login
  // Items. Every caller must therefore print it as "an entry exists", never as "it is
  // running", and point at `cheaper autostart status` for the real answer.
  let autostartOnDisk = false;
  try { autostartOnDisk = require('./autostart').isRegisteredOnDisk(); } catch { autostartOnDisk = false; }
  return {
    skill: fs.existsSync(path.join(P.SKILLS_DIR, 'adaptive-model-router')),
    agents: AGENT_FILES.every((f) => fs.existsSync(path.join(P.AGENTS_DIR, f))),
    hook: hookWired,
    plugin: pluginRegistered(),
    gateway: fs.existsSync(P.GATEWAY_DIR),
    autostartOnDisk,
  };
}

// Wire the TAGLINE into every detected harness OTHER than Claude Code, using whatever
// tagline_install.js already knows how to write (its TARGETS list). Harnesses detected
// but not in TARGETS are reported, never guessed at with an invented mechanism. Read from
// `detected` (already computed by the caller) so this and the printed summary never
// disagree.
//
// It is a TAGLINE and nothing else. This used to be described as the "tagline/routing"
// line, which read as though wiring it made the harness route through Cheaper — it does
// not, and cannot: the line is a one-shot `cheaper peek --tagline` that REPORTS what
// adaptive routing would have saved. Routing happens only when a tool's API calls go
// through the gateway. Saying "tagline/routing" here is the same class of defect as a
// green tick for an unverified start, so the slash is gone from every message below.
function installEverywhereElse(detected) {
  const others = detected.filter((h) => !CLAUDE_HARNESS_KEYS.has(h.key));
  const summary = [];
  for (const h of others) {
    if (!h.installed) { summary.push({ key: h.key, label: h.label, action: 'not-detected' }); continue; }
    if (!TAGLINE_HARNESS_KEYS.has(h.key)) { summary.push({ key: h.key, label: h.label, action: 'no-adapter' }); continue; }
    try {
      const results = taglineInstall.run(['--harness', h.key]);
      const wired = Array.isArray(results) && results.some((r) => r.action === 'wrote' && !r.error);
      summary.push({ key: h.key, label: h.label, action: wired ? 'wired' : 'failed', results });
    } catch (e) {
      summary.push({ key: h.key, label: h.label, action: 'failed', error: e.message });
    }
  }
  return summary;
}

async function run(argv) {
  const hIdx = argv.indexOf('--harness');
  const harnessFlag = hIdx !== -1 ? String(argv[hIdx + 1] || '').toLowerCase() : null;
  // Strip --harness <value> before parsing the rest as component tokens/flags,
  // so e.g. `install --harness codex` doesn't treat "codex" as a component.
  //
  // The `hIdx === -1` case MUST short-circuit. `filter((a, i) => i !== hIdx && i !==
  // hIdx + 1)` with hIdx === -1 evaluates its second clause as `i !== 0` and therefore
  // dropped the FIRST ARGUMENT of every invocation that did not use --harness:
  // `cheaper install --all` lost `--all`, `cheaper install gateway` lost `gateway`,
  // and `cheaper install gateway hook` installed only the hook. Each of those then
  // fell through to the interactive picker — where pressing Enter selects exactly
  // DEFAULT_KEYS, which is what `--all` meant, so an interactive user could never see
  // it. Non-interactively there was no such cover: the picker had no TTY to read, and
  // the command exited 0 having installed nothing. This line is why that silent no-op
  // was reachable from the documented commands and not just from a bare `install`.
  const rest = hIdx === -1 ? argv.slice() : argv.filter((a, i) => i !== hIdx && i !== hIdx + 1);
  const preset = new Set(rest.filter((a) => !a.startsWith('-')));
  const all = rest.includes('--all');

  console.log(c.amber('\n  Cheaper installer') + c.dim('  — adaptive Claude model routing\n'));

  // --harness <key> targeting a NON-Claude tool: wire just that one harness's
  // tagline (whatever tagline_install.js knows how to write) and stop. It wires a
  // savings LINE, not routing — see installEverywhereElse. Claude's component set
  // (skill/agents/hook/gateway/plugin/cli/autostart) has no meaning for another
  // harness, so it's never invoked here.
  if (harnessFlag && !CLAUDE_HARNESS_KEYS.has(harnessFlag)) {
    if (!TAGLINE_HARNESS_KEYS.has(harnessFlag)) {
      console.log(c.red(`  No adapter yet for harness "${harnessFlag}".`) +
        c.dim(' Known: ' + [...TAGLINE_HARNESS_KEYS].join(', ') + ', claude-code\n'));
      // A typo'd harness key installed NOTHING, and exiting 0 reported that as
      // success — so a provisioning script that ran `cheaper install --harness cursr`
      // marched on believing the harness was wired. The message was always there; the
      // exit code is what a script can actually read.
      process.exitCode = 1;
      return;
    }
    const results = taglineInstall.run(['--harness', harnessFlag]);
    console.log(c.dim('\n  Done.\n'));
    return results;
  }

  let chosen;
  if (all) {
    chosen = DEFAULT_KEYS.slice();
  } else if (preset.size) {
    const { keys, unknown } = normalizeKeys([...preset]);
    if (unknown.length) console.log(c.dim('  (ignoring unrecognized: ' + unknown.join(', ') +
      ' — valid: ' + COMPONENTS.map((x) => x.key).join(', ') + ', rules, all)\n'));
    chosen = keys;
  } else if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // NO COMPONENTS, NO --all, AND NO TERMINAL. The interactive picker below cannot
    // run here, and calling ask() anyway was the whole defect: readline's question()
    // never fires its callback on a closed/piped stdin, the promise never settles, the
    // event loop drains, and node exits 0 — so `cheaper install < /dev/null` (a CI
    // step, a Dockerfile RUN, a provisioning script) printed the menu, installed
    // NOTHING, and reported success. Silent, and indistinguishable from a real install.
    //
    // This branch deliberately does NOT fall through to DEFAULT_KEYS. "No answer" is
    // not consent: turning an unattended no-op into an unattended FULL install would
    // write to ~/.claude/settings.json, register a plugin and copy agents on a machine
    // whose operator only asked to see the menu — a worse failure than the one being
    // fixed. Same reason util.js::ask() is left alone rather than taught to resolve('')
    // on close: every one of its callers would inherit that silent default.
    // Guard mirrors openurl.js::promptThenOpen, which already refuses to prompt
    // without a TTY on both streams.
    console.log(c.red('  ✗ No components selected, and there is no terminal to ask on.'));
    console.log(c.dim('    stdin/stdout are not a TTY (piped, redirected, or CI), so the'));
    console.log(c.dim('    interactive picker cannot run — and nothing is installed unattended.'));
    console.log(c.dim('\n    Say what you want explicitly:'));
    console.log('      cheaper install --all' + c.dim('                 # ' + DEFAULT_KEYS.join(' ')));
    console.log('      cheaper install gateway hook' + c.dim('          # ' + COMPONENTS.map((x) => x.key).join(', ') + ', rules, all'));
    console.log('      cheaper install --harness <key>' + c.dim('       # wire one other harness only\n'));
    process.exitCode = 1;
    return;
  } else {
    COMPONENTS.forEach((x, i) => console.log(`  ${c.bold(String(i + 1))}. ${x.label}`));
    console.log(c.dim('\n  Choose components (e.g. "1 2 3", names like "hook gateway", "rules"'));
    console.log(c.dim('  = skill+agents+hook, "all" = the default set, or Enter for the default):'));
    const ans = (await ask('  > ')).toLowerCase().trim();
    if (!ans || ans === 'all') chosen = DEFAULT_KEYS.slice();
    else chosen = normalizeKeys(ans.split(/[\s,]+/).filter(Boolean)).keys;
  }
  // Asked for something, resolved to nothing — a failure, not a success. Exiting 0
  // here made `cheaper install skil` (typo) look identical to a completed install.
  if (!chosen.length) {
    console.log(c.red('\n  Nothing selected. Aborting.\n'));
    process.exitCode = 1;
    return;
  }

  // The plugin supersedes standalone skill/agents/hook — don't install both.
  if (chosen.includes('plugin') && chosen.some((k) => ['skill', 'agents', 'hook'].includes(k)))
    console.log(c.dim(`  (plugin selected — it bundles skill+agents+hook, so those are installed via the plugin)`));

  console.log('');
  const results = install({ components: chosen });
  for (const r of results)
    console.log('  ' + (r.ok ? c.green('✓') : c.red('✗')) + ' ' + (r.ok ? r.msg : `${r.key}: ${r.msg}`));
  // A component that threw is printed with a red ✗ — but a script sees only the exit
  // code, and 0 said "all installed". Same class as the two exits above: the command
  // did not do what was asked, so it must not report success.
  if (results.some((r) => !r.ok)) process.exitCode = 1;
  chosen = results.map((r) => r.key); // reflect plugin-supersede filtering for the notes below
  // The rows that actually SUCCEEDED. `chosen` above is every row, ok:false included, so
  // `chosen.includes('gateway')` was true even when installGateway() threw — and the
  // autostart offer at the bottom of this function then asked the user to register a login
  // entry for a gateway that is not on disk. Offering to supervise a component that failed
  // to install is the same class of claim as a green tick on an unverified start.
  const installed = new Set(results.filter((r) => r.ok).map((r) => r.key));
  const CH = cheaperInvocation();
  console.log(c.dim('\n  Done. Notes:'));
  // The PATH state is the first thing printed, because every command below it — and every
  // tagline this run just wrote into a harness file — is a `cheaper …` invocation. A user
  // who cannot run one cannot use anything else in this summary.
  if (CH.note) console.log('   ' + c.amber('!') + ' ' + CH.note);
  if (chosen.includes('gateway'))
    console.log(c.dim('   • Start the gateway:  ') + CH.cmd + ' gateway start' +
      c.dim('   then  ') + 'export ANTHROPIC_BASE_URL=http://localhost:8787');
  if (chosen.includes('plugin'))
    console.log(c.dim('   • Plugin registered + enabled. It loads in newly-started Claude sessions.'));
  else if (chosen.some((k) => ['skill', 'agents', 'hook'].includes(k)))
    console.log(c.dim('   • Prefer the managed plugin instead? Run:  ') + CH.cmd + ' install plugin');
  console.log(c.dim('   • Existing Claude sessions must be restarted to pick up the skill/agents/hook.\n'));

  // No --harness given: this is a plain `cheaper install` (or --all, or the
  // interactive picker above) — Claude just got its component set as before,
  // and now every OTHER detected AI-coding harness on this machine also gets
  // wired, not just Claude. Skipped entirely when --harness scoped the run
  // to Claude specifically (handled above) or to one other harness (returned
  // above before reaching this point).
  if (!harnessFlag) {
    const detected = detectHarnesses();
    const foundCount = detected.filter((h) => h.installed).length;
    console.log(c.amber(`  Detected ${foundCount} harness(es) on this machine:`));
    for (const h of detected)
      console.log('  ' + (h.installed ? c.green('✓') : c.dim('–')) + ' ' + h.label.padEnd(22) +
        c.dim(h.installed ? '' : 'not detected'));

    const elseResults = installEverywhereElse(detected);
    if (elseResults.length) {
      console.log(c.amber('\n  Wiring the Cheaper.app savings TAGLINE to other detected harnesses:'));
      for (const r of elseResults) {
        if (r.action === 'wired') console.log('  ' + c.green('✓') + ' ' + r.label.padEnd(22) + c.dim('tagline wired'));
        else if (r.action === 'no-adapter') console.log('  ' + c.dim('–') + ' ' + r.label.padEnd(22) + c.dim('detected, no adapter yet'));
        else if (r.action === 'not-detected') console.log('  ' + c.dim('–') + ' ' + r.label.padEnd(22) + c.dim('not detected, skipped'));
        else console.log('  ' + c.red('✗') + ' ' + r.label.padEnd(22) + c.red(r.error || 'failed'));
      }
    }
    // Say plainly what was NOT done. The old wording ("tagline/routing line only") let a
    // reader finish this install believing their other harnesses now route through
    // Cheaper. They do not: a tagline reports savings after the fact and moves no call.
    // The one command that actually configures routing is printed, so the gap is closed
    // in the same breath as it is admitted.
    console.log(c.dim('\n  Summary: Claude Code -> full component install; other detected harnesses -> the'));
    console.log(c.dim('  Cheaper.app savings TAGLINE only (via `cheaper peek --tagline`).'));
    console.log('  ' + c.amber('No ROUTING was configured for them') +
      c.dim(' — a tagline reports what routing would have saved; it does not route a single call.'));
    console.log(c.dim('  Routing is the gateway. Start it, then point the tool at it:'));
    console.log('    ' + CH.cmd + ' gateway start' + c.dim('   then   ') +
      'export ANTHROPIC_BASE_URL=http://localhost:' + require('./gateway').DEFAULT_PORT);
    console.log(c.dim('  Target one harness with `') + CH.cmd + c.dim(' install --harness <key>`.'));
    // Repeated here, at the very end of the longest block of output, because the taglines
    // reported "✓ wired" a few lines up and every one of them invokes `cheaper` by name. A
    // PATH warning printed only at the top scrolls away behind the harness table.
    if (CH.note) console.log('  ' + c.amber('! ') + c.dim(CH.note));
    console.log('');
  }

  // THE ONE-TIME AUTOSTART OFFER, last of all.
  //
  // It is a no-op unless BOTH stdin and stdout are TTYs (the openurl.js:22-24 guard), it
  // defaults to no, Enter is no, and the answer is persisted to ~/.cheaper/autostart.json
  // so this is asked at most once per machine. It is also skipped entirely unless a
  // gateway was actually installed — offering to autostart a service the user did not
  // install is noise, and noise is how a prompt becomes a nag.
  //
  // `installed`, not `chosen`: a gateway row that THREW must not reach this offer.
  //
  // The staged CLI is required too, and for the same reason one level down:
  // autostart.js::enable points the login entry at ~/.cheaper/cli/bin/cheaper.js — the
  // stable copy, never whatever is on PATH today — and refuses outright when that file
  // is absent. Offering to register a login entry that cannot be registered spends the
  // ONE question this machine ever gets (the answer is persisted to
  // ~/.cheaper/autostart.json) on an outcome already known to fail, and answering `y`
  // returned
  //
  //     ✗ nothing to autostart: ~/.cheaper/cli/bin/cheaper.js does not exist
  //
  // as the last thing an otherwise-green install printed. Same overclaim the gateway
  // check exists to prevent: a prompt must not presuppose something not on disk.
  //
  // Test the FILE, not `installed.has('cli')`. The staged copy is durable, so a machine
  // that installed it on an earlier run can legitimately be offered autostart by a later
  // `cheaper install gateway` that names no CLI at all — and gating on this run's rows
  // would silently withhold the offer there. This mirrors enable()'s own precondition
  // exactly, which is the only way the two can't disagree.
  const cliStaged = fs.existsSync(path.join(P.CLI_HOME, 'bin', 'cheaper.js'));
  if (installed.has('gateway') && cliStaged) {
    try { await require('./autostart').offerOnce(); }
    catch (e) { console.log(c.dim(`  (skipped the autostart question: ${e.message})`)); }
  }
}

module.exports = {
  run, install, status, COMPONENTS, DEFAULT_KEYS, AGENT_FILES,
  pluginRegistered, dewireStandaloneHook, isCheaperHookEntry, runClaude,
  detectHarnesses, installEverywhereElse, cheaperInvocation,
};
