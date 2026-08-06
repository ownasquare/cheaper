'use strict';
// Reverse of install.js. Removes each component cleanly and idempotently, and
// never touches unrelated user data (other plugins/marketplaces/hooks/settings).
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const { c, removePath, readJSONForUpdate, writeJSON, whichSync } = require('./util');
const { AGENT_FILES, pluginRegistered, dewireStandaloneHook, runClaude } = require('./install');

// --- gateway ---------------------------------------------------------------

function stopGatewayIfRunning() {
  try {
    const pid = parseInt(fs.readFileSync(P.GATEWAY_PID, 'utf8'), 10);
    if (pid) process.kill(pid);
  } catch { /* not running */ }
  removePath(P.GATEWAY_PID);
  removePath(P.GATEWAY_LOG);
}

// --- plugin de-registration (mirror of install's registerPluginDirect) ------

function deregisterPluginDirect() {
  if (fs.existsSync(P.INSTALLED_PLUGINS)) {
    const reg = readJSONForUpdate(P.INSTALLED_PLUGINS, {});
    if (reg.plugins && P.PLUGIN_ID in reg.plugins) { delete reg.plugins[P.PLUGIN_ID]; writeJSON(P.INSTALLED_PLUGINS, reg); }
  }
  if (fs.existsSync(P.KNOWN_MARKETPLACES)) {
    const known = readJSONForUpdate(P.KNOWN_MARKETPLACES, {});
    if (P.MARKETPLACE_NAME in known) { delete known[P.MARKETPLACE_NAME]; writeJSON(P.KNOWN_MARKETPLACES, known); }
  }
  if (fs.existsSync(P.SETTINGS)) {
    const s = readJSONForUpdate(P.SETTINGS, {});
    let changed = false;
    if (s.enabledPlugins && P.PLUGIN_ID in s.enabledPlugins) { delete s.enabledPlugins[P.PLUGIN_ID]; changed = true; }
    if (s.extraKnownMarketplaces && P.MARKETPLACE_NAME in s.extraKnownMarketplaces) { delete s.extraKnownMarketplaces[P.MARKETPLACE_NAME]; changed = true; }
    if (changed) writeJSON(P.SETTINGS, s);
  }
}

// --- individual component uninstallers -------------------------------------

function uninstallSkill() {
  const dst = path.join(P.SKILLS_DIR, 'adaptive-model-router');
  if (!fs.existsSync(dst)) return 'skill  -> (not present)';
  removePath(dst);
  return `skill  -> removed ${dst}`;
}

function uninstallAgents() {
  const present = AGENT_FILES.filter((f) => fs.existsSync(path.join(P.AGENTS_DIR, f)));
  present.forEach((f) => removePath(path.join(P.AGENTS_DIR, f)));
  return present.length ? `agents -> removed ${present.map((f) => f.replace('.md', '')).join(', ')}` : 'agents -> (not present)';
}

function uninstallHook() {
  const dewired = dewireStandaloneHook();
  const hadPolicy = fs.existsSync(P.HOOK_POLICY);
  if (hadPolicy) removePath(P.HOOK_POLICY);
  if (!dewired && !hadPolicy) return 'hook   -> (not present)';
  return `hook   -> ${dewired ? 'de-wired settings.json' : ''}${dewired && hadPolicy ? ' + ' : ''}${hadPolicy ? 'removed router-policy.md' : ''}`;
}

function uninstallGateway() {
  const existed = fs.existsSync(P.GATEWAY_DIR);
  stopGatewayIfRunning();
  removePath(P.GATEWAY_DIR);
  return existed ? `gateway -> stopped + removed ${P.GATEWAY_DIR}` : 'gateway -> (not present)';
}

function uninstallPlugin() {
  removePath(P.LEGACY_PLUGIN_DIR);
  let via = 'registry';
  const claudeBin = whichSync('claude');
  if (claudeBin && pluginRegistered()) {
    runClaude(claudeBin, ['plugin', 'uninstall', P.PLUGIN_ID]);
    runClaude(claudeBin, ['plugin', 'marketplace', 'remove', P.MARKETPLACE_NAME]);
    if (!pluginRegistered()) via = 'claude CLI';
  }
  // Belt-and-suspenders: scrub any registry residue the CLI didn't remove (or when
  // the CLI isn't present), then drop the local marketplace source + cache.
  deregisterPluginDirect();
  removePath(P.MARKETPLACE_DIR);
  removePath(path.join(P.PLUGINS_CACHE, P.MARKETPLACE_NAME));
  return `plugin -> unregistered ${P.PLUGIN_ID} (via ${via})`;
}

const COMPONENTS = [
  { key: 'plugin', label: 'Plugin', fn: uninstallPlugin },
  { key: 'skill', label: 'Skill', fn: uninstallSkill },
  { key: 'agents', label: 'Agents', fn: uninstallAgents },
  { key: 'hook', label: 'Hook', fn: uninstallHook },
  { key: 'gateway', label: 'Gateway', fn: uninstallGateway },
];

// Programmatic entry point (used by the desktop app). Returns per-component results.
function uninstall({ components, purge } = {}) {
  const keys = components && components.length ? components : COMPONENTS.map((x) => x.key);
  const results = [];
  for (const comp of COMPONENTS.filter((x) => keys.includes(x.key))) {
    try { results.push({ key: comp.key, ok: true, msg: comp.fn() }); }
    catch (e) { results.push({ key: comp.key, ok: false, msg: e.message }); }
  }
  if (purge) { removePath(P.CHEAPER_DIR); results.push({ key: 'purge', ok: true, msg: `removed ${P.CHEAPER_DIR} (incl. metrics.db)` }); }
  return results;
}

async function run(argv) {
  const preset = new Set(argv.filter((a) => !a.startsWith('-')));
  const purge = argv.includes('--purge');
  const components = preset.size ? [...preset] : null;

  console.log(c.amber('\n  Cheaper uninstaller') + c.dim('  — remove adaptive model routing\n'));
  const results = uninstall({ components, purge });
  for (const r of results) {
    console.log('  ' + (r.ok ? c.green('✓') : c.red('✗')) + ' ' + r.msg);
  }
  if (!purge)
    console.log(c.dim('\n  Kept your gateway metrics at ') + P.CHEAPER_DIR + '/metrics.db' +
      c.dim('  (use ') + 'cheaper uninstall --purge' + c.dim(' to remove everything).'));
  console.log(c.dim('   • Restart open Claude sessions for the removal to take effect.\n'));
}

module.exports = { run, uninstall, COMPONENTS };
