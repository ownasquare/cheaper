'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('./paths');
const { c, copyDir, removePath, nowIso, whichSync, ask, readJSON, readJSONForUpdate, writeJSON } = require('./util');
const { installCliLauncher } = require('./clilink');

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

async function run(argv) {
  const preset = new Set(argv.filter((a) => !a.startsWith('-')));
  const all = argv.includes('--all');

  console.log(c.amber('\n  Cheaper installer') + c.dim('  — adaptive Claude model routing\n'));
  let chosen;
  if (all) {
    chosen = DEFAULT_KEYS.slice();
  } else if (preset.size) {
    chosen = COMPONENTS.filter((x) => preset.has(x.key)).map((x) => x.key);
  } else {
    COMPONENTS.forEach((x, i) => console.log(`  ${c.bold(String(i + 1))}. ${x.label}`));
    console.log(c.dim('\n  Choose components (e.g. "1 2 3", "all" = skill+agents+hook+gateway,'));
    console.log(c.dim('  "5" for the plugin instead, or Enter for the default set):'));
    const ans = (await ask('  > ')).toLowerCase();
    if (!ans || ans === 'all') chosen = DEFAULT_KEYS.slice();
    else {
      const picks = ans.split(/[\s,]+/);
      chosen = COMPONENTS.filter((x, i) =>
        picks.includes(String(i + 1)) || picks.includes(x.key)).map((x) => x.key);
    }
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
}

module.exports = {
  run, install, status, COMPONENTS, DEFAULT_KEYS, AGENT_FILES,
  pluginRegistered, dewireStandaloneHook, isCheaperHookEntry, runClaude,
};
