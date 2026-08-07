'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('./paths');
const { c, copyDir, removePath, nowIso, whichSync, ask, readJSON, readJSONForUpdate, writeJSON } = require('./util');
const { installCliLauncher } = require('./clilink');
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

// skill/agents/hook/gateway are the reliable, discovered-location default set.
// plugin is an opt-in managed packaging of skill+agents+hook (mutually exclusive).
const COMPONENTS = [
  { key: 'skill', label: 'Skill (routing procedure + rubric)', fn: installSkill },
  { key: 'agents', label: 'Agents (three tiered subagents: haiku/sonnet/opus)', fn: installAgents },
  { key: 'hook', label: 'Hook (always-on policy injection)', fn: installHook },
  { key: 'gateway', label: 'Gateway (proxy that routes every API call + monitor)', fn: installGateway },
  { key: 'plugin', label: 'Plugin (managed bundle of skill+agents+hook; alt. to the above)', fn: installPlugin },
  { key: 'cli', label: 'CLI (a `cheaper` command on your PATH)', fn: installCliLauncher },
];
const DEFAULT_KEYS = ['skill', 'agents', 'hook', 'gateway'];

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
  return {
    skill: fs.existsSync(path.join(P.SKILLS_DIR, 'adaptive-model-router')),
    agents: AGENT_FILES.every((f) => fs.existsSync(path.join(P.AGENTS_DIR, f))),
    hook: hookWired,
    plugin: pluginRegistered(),
    gateway: fs.existsSync(P.GATEWAY_DIR),
  };
}

// Wire the tagline/routing line into every detected harness OTHER than
// Claude Code, using whatever tagline_install.js already knows how to write
// (its TARGETS list). Harnesses detected but not in TARGETS are reported,
// never guessed at with an invented mechanism. Read from `detected` (already
// computed by the caller) so this and the printed summary never disagree.
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
  const rest = argv.filter((a, i) => i !== hIdx && i !== hIdx + 1);
  const preset = new Set(rest.filter((a) => !a.startsWith('-')));
  const all = rest.includes('--all');

  console.log(c.amber('\n  Cheaper installer') + c.dim('  — adaptive Claude model routing\n'));

  // --harness <key> targeting a NON-Claude tool: wire just that one harness's
  // tagline/routing line (whatever tagline_install.js knows how to write) and
  // stop. Claude's component set (skill/agents/hook/gateway/plugin/cli) has
  // no meaning for another harness, so it's never invoked here.
  if (harnessFlag && !CLAUDE_HARNESS_KEYS.has(harnessFlag)) {
    if (!TAGLINE_HARNESS_KEYS.has(harnessFlag)) {
      console.log(c.red(`  No adapter yet for harness "${harnessFlag}".`) +
        c.dim(' Known: ' + [...TAGLINE_HARNESS_KEYS].join(', ') + ', claude-code\n'));
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
  } else {
    COMPONENTS.forEach((x, i) => console.log(`  ${c.bold(String(i + 1))}. ${x.label}`));
    console.log(c.dim('\n  Choose components (e.g. "1 2 3", names like "hook gateway", "rules"'));
    console.log(c.dim('  = skill+agents+hook, "all" = the default set, or Enter for the default):'));
    const ans = (await ask('  > ')).toLowerCase().trim();
    if (!ans || ans === 'all') chosen = DEFAULT_KEYS.slice();
    else chosen = normalizeKeys(ans.split(/[\s,]+/).filter(Boolean)).keys;
  }
  if (!chosen.length) { console.log(c.red('\n  Nothing selected. Aborting.\n')); return; }

  // The plugin supersedes standalone skill/agents/hook — don't install both.
  if (chosen.includes('plugin') && chosen.some((k) => ['skill', 'agents', 'hook'].includes(k)))
    console.log(c.dim(`  (plugin selected — it bundles skill+agents+hook, so those are installed via the plugin)`));

  console.log('');
  const results = install({ components: chosen });
  for (const r of results)
    console.log('  ' + (r.ok ? c.green('✓') : c.red('✗')) + ' ' + (r.ok ? r.msg : `${r.key}: ${r.msg}`));
  chosen = results.map((r) => r.key); // reflect plugin-supersede filtering for the notes below
  console.log(c.dim('\n  Done. Notes:'));
  if (chosen.includes('gateway'))
    console.log(c.dim('   • Start the gateway:  ') + 'cheaper gateway start' +
      c.dim('   then  ') + 'export ANTHROPIC_BASE_URL=http://localhost:8787');
  if (chosen.includes('plugin'))
    console.log(c.dim('   • Plugin registered + enabled. It loads in newly-started Claude sessions.'));
  else if (chosen.some((k) => ['skill', 'agents', 'hook'].includes(k)))
    console.log(c.dim('   • Prefer the managed plugin instead? Run:  ') + 'cheaper install plugin');
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
      console.log(c.amber('\n  Wiring the Cheaper.app savings line to other detected harnesses:'));
      for (const r of elseResults) {
        if (r.action === 'wired') console.log('  ' + c.green('✓') + ' ' + r.label.padEnd(22) + c.dim('tagline wired'));
        else if (r.action === 'no-adapter') console.log('  ' + c.dim('–') + ' ' + r.label.padEnd(22) + c.dim('detected, no adapter yet'));
        else if (r.action === 'not-detected') console.log('  ' + c.dim('–') + ' ' + r.label.padEnd(22) + c.dim('not detected, skipped'));
        else console.log('  ' + c.red('✗') + ' ' + r.label.padEnd(22) + c.red(r.error || 'failed'));
      }
    }
    console.log(c.dim('\n  Summary: Claude Code -> full component install; other detected harnesses -> tagline/routing'));
    console.log(c.dim('  line only (via `cheaper peek --tagline`). Target one harness with `cheaper install --harness <key>`.\n'));
  }
}

module.exports = {
  run, install, status, COMPONENTS, DEFAULT_KEYS, AGENT_FILES,
  pluginRegistered, dewireStandaloneHook, isCheaperHookEntry, runClaude,
  detectHarnesses, installEverywhereElse,
};
