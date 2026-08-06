'use strict';
// Reverse of install.js. Removes each component cleanly and idempotently, and
// never touches unrelated user data (other plugins/marketplaces/hooks/settings).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('./paths');
const { c, removePath, readJSONForUpdate, writeJSON, whichSync } = require('./util');
const { AGENT_FILES, pluginRegistered, dewireStandaloneHook, runClaude } = require('./install');
const { uninstallCliLauncher } = require('./clilink');

// --- gateway ---------------------------------------------------------------

// Confirm a PID is actually our uvicorn gateway before signalling it. gateway.pid
// is persistent (survives crashes/reboots), so a stale PID can be reused by an
// unrelated process — we must not SIGTERM that.
function pidLooksLikeGateway(pid) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      return r.status === 0 && /python|uvicorn/i.test(r.stdout || '');
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return r.status === 0 && /uvicorn|app:app/i.test(r.stdout || '');
  } catch { return false; }
}

function stopGatewayIfRunning() {
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(P.GATEWAY_PID, 'utf8'), 10); } catch { pid = 0; }
  // pid > 1 rejects 0/NaN and negatives (process.kill(-N) would signal a whole group).
  if (pid > 1) {
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; } // ESRCH => gone
    if (alive && pidLooksLikeGateway(pid)) {
      try { process.kill(pid); } catch { /* raced with exit */ }
    }
  }
  removePath(P.GATEWAY_PID);
  removePath(P.GATEWAY_LOG);
}

// --- plugin de-registration (mirror of install's registerPluginDirect) ------

function deregisterPluginDirect() {
  // Each registry file is edited independently so a malformed one (which we refuse
  // to overwrite) doesn't block de-registering from the files that parse cleanly.
  const errs = [];
  const step = (fn) => { try { fn(); } catch (e) { errs.push(e.message); } };
  step(() => {
    if (fs.existsSync(P.INSTALLED_PLUGINS)) {
      const reg = readJSONForUpdate(P.INSTALLED_PLUGINS, {});
      if (reg.plugins && P.PLUGIN_ID in reg.plugins) { delete reg.plugins[P.PLUGIN_ID]; writeJSON(P.INSTALLED_PLUGINS, reg); }
    }
  });
  step(() => {
    if (fs.existsSync(P.KNOWN_MARKETPLACES)) {
      const known = readJSONForUpdate(P.KNOWN_MARKETPLACES, {});
      if (P.MARKETPLACE_NAME in known) { delete known[P.MARKETPLACE_NAME]; writeJSON(P.KNOWN_MARKETPLACES, known); }
    }
  });
  step(() => {
    if (fs.existsSync(P.SETTINGS)) {
      const s = readJSONForUpdate(P.SETTINGS, {});
      let changed = false;
      if (s.enabledPlugins && P.PLUGIN_ID in s.enabledPlugins) { delete s.enabledPlugins[P.PLUGIN_ID]; changed = true; }
      if (s.extraKnownMarketplaces && P.MARKETPLACE_NAME in s.extraKnownMarketplaces) { delete s.extraKnownMarketplaces[P.MARKETPLACE_NAME]; changed = true; }
      if (changed) writeJSON(P.SETTINGS, s);
    }
  });
  if (errs.length) throw new Error(errs.join('; '));
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
  // Drop our own marketplace source + cache FIRST — this is registry-independent, so
  // a malformed shared registry (which deregisterPluginDirect refuses to rewrite)
  // can't leave these orphaned on disk.
  removePath(P.MARKETPLACE_DIR);
  removePath(path.join(P.PLUGINS_CACHE, P.MARKETPLACE_NAME));
  // Belt-and-suspenders: scrub any registry residue the CLI didn't remove (or when
  // the CLI isn't present). Throws only if a registry file is malformed.
  deregisterPluginDirect();
  return `plugin -> unregistered ${P.PLUGIN_ID} (via ${via})`;
}

const COMPONENTS = [
  { key: 'plugin', label: 'Plugin', fn: uninstallPlugin },
  { key: 'skill', label: 'Skill', fn: uninstallSkill },
  { key: 'agents', label: 'Agents', fn: uninstallAgents },
  { key: 'hook', label: 'Hook', fn: uninstallHook },
  { key: 'gateway', label: 'Gateway', fn: uninstallGateway },
  { key: 'cli', label: 'CLI', fn: uninstallCliLauncher },
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
