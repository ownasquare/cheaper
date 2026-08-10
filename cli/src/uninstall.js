'use strict';
// Reverse of install.js. Removes each component cleanly and idempotently, and
// never touches unrelated user data (other plugins/marketplaces/hooks/settings).
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const { c, removePath, readJSONForUpdate, writeJSON, whichSync } = require('./util');
const { AGENT_FILES, pluginRegistered, dewireStandaloneHook, runClaude } = require('./install');
const { uninstallCliLauncher } = require('./clilink');

// --- gateway ---------------------------------------------------------------

// Confirm a PID is actually our uvicorn gateway before signalling it. gateway.pid
// is persistent (survives crashes/reboots), so a stale PID can be reused by an
// unrelated process — we must not SIGTERM that.
//
// gateway.js:237 owns this check now (it wraps identifyPid, which distinguishes
// "verified not ours" from "the check could not run" and answers false for both). This
// file used to carry a second copy of the same logic, and two copies of a
// don't-kill-the-wrong-process gate drift: only one of them got the win32 fix for
// tasklist exiting 0 on "no tasks match". Required LAZILY so `cheaper uninstall` still
// removes files if gateway.js fails to load — deleting a directory must not depend on
// the module that knows how to start a server.
function pidLooksLikeGateway(pid) {
  try { return require('./gateway').pidLooksLikeGateway(pid); }
  catch { return false; }
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

// --- autostart -------------------------------------------------------------

// P1.4 — this must run BEFORE uninstallGateway, and the COMPONENTS order below is what
// guarantees it.
//
// The artifact this prevents: uninstall removes ~/.cheaper/gateway (and --purge removes
// all of ~/.cheaper, including CLI_HOME) while the LaunchAgent / systemd unit / scheduled
// task stays registered. From that moment the supervisor retries a deleted binary at
// every login, forever, and there is no `cheaper` command left on the machine to switch
// it off — the user's only remedy is to find and delete a plist they have never heard of.
// stopGatewayIfRunning() cannot save this either: it sends ONE SIGTERM, and launchd's
// KeepAlive answers a SIGTERM with a respawn.
//
// Order is deregister -> remove the entry file -> stop the process -> remove files.
function uninstallAutostart() {
  const r = require('./autostart').disable([]);
  // disable() answers ok:false when it could not CONFIRM the entry is gone, and prints
  // the manual command. Throwing turns that into the red ✗ + non-zero exit the caller
  // already produces for a failed component — "probably removed" is exactly the claim
  // this file must never make about a self-restarting service.
  if (!r.ok) throw new Error(r.msg);
  return r.msg;
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
  // BEFORE gateway, and that is the entire point — see uninstallAutostart. A supervisor
  // that is still registered when the files it points at are deleted is the worst
  // artifact this uninstaller could leave behind.
  { key: 'autostart', label: 'Autostart', fn: uninstallAutostart },
  { key: 'gateway', label: 'Gateway', fn: uninstallGateway },
  { key: 'cli', label: 'CLI', fn: uninstallCliLauncher },
];

// The two components whose FILES the login entry actually names: autostart.js bakes
// ~/.cheaper/cli/bin/cheaper.js into ProgramArguments[1] and points it at
// ~/.cheaper/gateway. Deleting either while the entry is still registered is what
// produces the crash-looping login item. plugin/skill/agents/hook are not named by any
// supervisor, so a failed deregistration must NOT hold them hostage.
const POINTED_AT_BY_AUTOSTART = ['gateway', 'cli'];

// The command that actually clears the entry on THIS machine. A refusal that says
// "remove it by hand" without saying how just relocates the dead end, and the user has
// by definition never heard of the plist. Falls back to the cheaper-level command if
// autostart.js cannot be loaded, because a message is better than a crash inside an
// error path.
function manualDeregisterCommand() {
  try {
    const A = require('./autostart');
    const r = A.removalCommands(A.makeCtx());
    return `${r.cheaper}   (or by hand: ${r.manual})`;
  } catch { return 'cheaper autostart disable'; }
}

// Is a login entry registered right now? Filesystem-only, so it never shells out during
// an uninstall that may be running unattended.
function autostartPresent() {
  try { return require('./autostart').isRegisteredOnDisk(); } catch { return false; }
}

// Programmatic entry point (used by the desktop app). Returns per-component results.
function uninstall({ components, purge } = {}) {
  const keys = components && components.length ? components : COMPONENTS.map((x) => x.key);
  const results = [];

  // Set to disable()'s own failure text the moment a deregistration row comes back
  // ok:false. --purge already refuses outright in that state (below); the ORDINARY
  // `cheaper uninstall` used to print the red ✗ and then delete ~/.cheaper/gateway and
  // ~/.cheaper/cli/bin/cheaper.js anyway — the exact files the still-registered
  // LaunchAgent names. The user was left with a login entry retrying a deleted binary at
  // every login and no `cheaper` command left to switch it off: the worst artifact this
  // uninstaller can produce, reached from its most common invocation. So the purge
  // refusal applies here too, scoped to the components the entry actually points at.
  let autostartBlocked = null;

  // A SCOPED uninstall can still orphan the supervisor: `cheaper uninstall gateway`
  // names one component, so the autostart entry is not in `keys`, and the loop below
  // would delete ~/.cheaper/gateway out from under a login entry that keeps trying to
  // run it. Deregister it first, on its own row, with its own outcome — rather than
  // silently doing nothing because the user did not think to name it.
  if (!keys.includes('autostart') && (keys.includes('gateway') || keys.includes('cli')) && autostartPresent()) {
    let r;
    // disable() REPORTS a failed removal as ok:false and does NOT throw, so the literal
    // `ok: true` that used to sit here could never be falsified: the row printed a green ✓
    // above the words "autostart -> NOT confirmed removed (launchd still lists it)", and
    // run()'s `results.some(r => !r.ok)` saw nothing, so the command exited 0 on a machine
    // whose supervisor was still live. The catch remains for a disable() that genuinely
    // throws (a broken autostart.js), which is a different failure with the same verdict.
    try { r = require('./autostart').disable([]); }
    catch (e) { r = { ok: false, msg: e.message }; }
    results.push({
      key: 'autostart', ok: r.ok,
      msg: r.msg + '   (deregistered first: it points at the files being removed)',
    });
    if (!r.ok) autostartBlocked = r.msg;
  }

  for (const comp of COMPONENTS.filter((x) => keys.includes(x.key))) {
    if (autostartBlocked && POINTED_AT_BY_AUTOSTART.includes(comp.key)) {
      results.push({
        key: comp.key, ok: false,
        msg: `${comp.key} -> NOT removed: the autostart entry is still registered and could not be `
          + `removed (${autostartBlocked}). Deleting it now would leave a login entry retrying a `
          + `deleted file at every login, with no \`cheaper\` command left to disable it. `
          + `Files left in place are recoverable; that login item is not. Deregister it first: `
          + manualDeregisterCommand(),
      });
      continue;
    }
    let ok = true, msg;
    try { msg = comp.fn(); }
    catch (e) { ok = false; msg = e.message; }
    results.push({ key: comp.key, ok, msg });
    // uninstallAutostart() converts disable()'s ok:false into a throw, so a red autostart
    // row IS the "could not confirm the supervisor is gone" state — and gateway + cli come
    // after autostart in COMPONENTS for exactly this reason.
    if (!ok && comp.key === 'autostart') autostartBlocked = msg;
  }

  if (purge) {
    // --purge deletes ~/.cheaper OUTRIGHT, including CLI_HOME (paths.js:29) — the very
    // script a LaunchAgent's ProgramArguments names. Doing that while an entry is
    // registered produces a login item that crash-loops on a missing file with no
    // `cheaper` binary left to remove it. So: deregister first, and if that cannot be
    // CONFIRMED, refuse the purge outright. Leaving ~/.cheaper in place is recoverable;
    // an unkillable login item is not.
    if (autostartPresent()) {
      let removed = null;
      try { removed = require('./autostart').disable([]); }
      catch (e) { removed = { ok: false, msg: e.message }; }
      if (!removed.ok) {
        results.push({
          key: 'purge', ok: false,
          msg: `refusing to delete ${P.CHEAPER_DIR}: the autostart entry is still registered and could `
            + `not be removed (${removed.msg}). Purging now would leave a login entry pointing at a `
            + `deleted CLI, with nothing left to disable it. Remove it by hand, then re-run --purge.`,
        });
        return results;
      }
      // This `ok: true` is NOT a hardcoded claim: the `if (!removed.ok) return` three lines
      // above already proved disable() succeeded, so reaching here IS the evidence. Leave it
      // as it is — replacing it with `removed.ok` would read as a real check while only ever
      // being able to be true.
      results.push({ key: 'autostart', ok: true, msg: `${removed.msg}   (deregistered before --purge)` });
    }
    removePath(P.CHEAPER_DIR);
    // removePath() is best-effort BY CONTRACT — util.js:25-28 swallows every error — so the
    // literal `ok: true` that used to sit here could never be falsified. A purge blocked by
    // permissions, an open handle, or a locked file still printed "✓ removed ~/.cheaper
    // (incl. metrics.db)" and, because run()'s `results.some(r => !r.ok)` saw nothing, exited
    // 0 — telling a provisioning script the machine was wiped while ~/.cheaper and metrics.db
    // were both still on disk. Verify at the call site rather than changing removePath():
    // its other callers (gateway.pid, gateway.log) depend on the best-effort contract.
    if (fs.existsSync(P.CHEAPER_DIR)) {
      let left = null;
      try { left = fs.readdirSync(P.CHEAPER_DIR); } catch { /* unreadable as well as undeletable */ }
      const survivors = left === null
        ? 'and its contents could not even be listed'
        : left.length
          ? `it still holds: ${left.slice(0, 8).join(', ')}${left.length > 8 ? `, +${left.length - 8} more` : ''}`
          : 'it is now empty, but the directory itself is still there';
      const byHand = process.platform === 'win32'
        ? `rmdir /s /q "${P.CHEAPER_DIR}"`
        : `rm -rf ${P.CHEAPER_DIR}`;
      results.push({
        key: 'purge', ok: false,
        msg: `could NOT remove ${P.CHEAPER_DIR} — ${survivors}. Something is holding it: a `
          + `running gateway with the file open, a permissions problem on the directory, or a `
          + `file you locked. Close anything using it and remove it by hand: ${byHand}`,
      });
    } else {
      results.push({ key: 'purge', ok: true, msg: `removed ${P.CHEAPER_DIR} (incl. metrics.db)` });
    }
  }
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
  // A red ✗ is invisible to a script, which reads only the exit code — and the row most
  // likely to be red now is "refused to purge while a login entry is still registered".
  // Exiting 0 there would tell a provisioning script the machine was cleaned.
  if (results.some((r) => !r.ok)) process.exitCode = 1;
  if (!purge)
    console.log(c.dim('\n  Kept your gateway metrics at ') + P.CHEAPER_DIR + '/metrics.db' +
      c.dim('  (use ') + 'cheaper uninstall --purge' + c.dim(' to remove everything).'));
  console.log(c.dim('   • Restart open Claude sessions for the removal to take effect.\n'));
}

module.exports = { run, uninstall, COMPONENTS };
