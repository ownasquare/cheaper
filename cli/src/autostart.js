'use strict';
// cli/src/autostart.js — OPT-IN autostart: a per-user login entry that runs
// `cheaper gateway serve` and brings it back if it dies.
//
// ---------------------------------------------------------------------------
// WHY EVERY PATH IN HERE IS GATED ON AN EXPLICIT ACT
// ---------------------------------------------------------------------------
// install.js already refuses to install its ordinary components when it cannot ask
// ("No answer is not consent…", install.js:360-384). Registering a self-restarting
// login daemon is strictly more invasive than copying a skill file: it survives the
// terminal that created it, it starts a network listener at every login, and on macOS
// it lands in System Settings > Login Items where the user will later find it and have
// to work out what put it there. So:
//
//   • `autostart` is in install.js's COMPONENTS but NOT in DEFAULT_KEYS. A bare
//     `cheaper install` and `cheaper install --all` both leave it alone. It is reachable
//     only by naming it (`cheaper install autostart`), by picking it in the interactive
//     menu, or by `cheaper autostart enable`.
//   • The one offer we make is TTY-gated on BOTH streams (the same guard openurl.js:22-24
//     uses), defaults to NO, treats Enter as no, and PERSISTS the answer to
//     ~/.cheaper/autostart.json so it is asked at most once. Re-asking every run is the
//     nag pattern users correctly read as adware.
//   • An update never enables it, and enable() REFUSES to re-register an entry the user
//     switched off externally (macOS Login Items, `systemctl --user disable`, a disabled
//     scheduled task). Silently undoing the user's own off switch is worse than never
//     having offered.
//
// ---------------------------------------------------------------------------
// WHY IT POINTS AT `gateway serve` AND NOT `gateway start`
// ---------------------------------------------------------------------------
// A supervisor supervises the process it launched. `gateway start` detaches, unrefs and
// RETURNS after a second or two, so launchd/systemd sees its job exit immediately and
// restarts it forever while the uvicorns pile up behind it. `gateway serve` is the
// foreground form and lives exactly as long as the service (gateway.js:546-566).
// `gateway prepare` (the pip install + freshness reinstall) is run ONCE here, at enable
// time, and never from the unit — inside a restart loop it becomes a hammer on the
// package index, and a machine that is offline at boot would never come up at all.
//
// ---------------------------------------------------------------------------
// P1.3 — THE NVM HAZARD
// ---------------------------------------------------------------------------
// launchd and systemd --user source NO shell profile. Their PATH is not the PATH of the
// terminal that ran `cheaper autostart enable`. Two things break because of it:
//
//   node   — under nvm/fnm/volta the interpreter lives at
//            .../versions/node/vNN/bin/node, so a baked absolute path is orphaned by the
//            NEXT Node upgrade and the entry crash-loops silently at every login.
//   python — worse: gateway.js's pyExe() (gateway.js:44-52) probes PATH for python3 /
//            python / py with NO absolute fallback. With launchd's PATH it finds nothing
//            and `serve` exits "No usable Python 3 found" on every respawn.
//
// So enable() records the ABSOLUTE resolved node and python, bakes node into
// ProgramArguments/ExecStart and python's DIRECTORY into the entry's own PATH, and
// `autostart status` RE-RESOLVES both and reports drift in words. A crash-looping login
// item that nothing ever tells you about is the failure mode this whole file exists to
// avoid, so "could not determine" is reported as its own state everywhere below and is
// never rendered as "fine".

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('./paths');
const { c, ask, whichSync, readJSON, writeJSON } = require('./util');
const gateway = require('./gateway');

// Label namespace comes from cheaper-desktop/package.json build.appId
// ("com.beladed.cheaper"), so the login item a user finds in System Settings carries the
// same reverse-DNS identity as the app that may have installed it.
const LABEL = 'com.beladed.cheaper.gateway';
const UNIT_NAME = 'cheaper-gateway.service';
const TASK_NAME = 'Cheaper Gateway';

// P3.2 — NOT gateway.log. gateway.js:343-361 opens that file itself and fchmods it 0600
// because it carries the service's request stream; launchd creates StandardOutPath under
// the user's umask (0644 on a stock mac) and would quietly widen it back out. A separate
// file also keeps a supervised gateway's output from interleaving with a hand-started
// `gateway start`, which redirects into gateway.log at the same time.
const LOG_BASENAME = 'autostart.log';
const STATE_BASENAME = 'autostart.json';

// There is no rotation anywhere in this product today, and a login service that restarts
// on failure can fill a disk with the same traceback. This cap is enforced when a
// `cheaper autostart` command runs, NOT continuously — nothing here is resident — and
// enable()/status() both say so rather than implying a rotating logger exists.
const LOG_MAX_BYTES = 2 * 1024 * 1024;

const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32']);

// PATH the entry runs with. The resolved node and python directories come FIRST (see the
// nvm hazard above); the fixed tail is what a login shell would normally have and is what
// makes `brew`-installed tooling reachable from a launchd job.
const FIXED_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

// ---------------------------------------------------------------------------
// context — every external dependency is injectable so the tests can prove this
// file's behaviour WITHOUT writing to the developer's ~/Library/LaunchAgents, running
// launchctl for real, or binding port 8787.
// ---------------------------------------------------------------------------

function makeCtx(o = {}) {
  const home = o.home || P.HOME;
  // Deriving from an injected home (rather than falling back to the module-level P.*)
  // is what keeps a test that passes only `home` from reaching the real ~/.cheaper.
  const cheaperDir = o.cheaperDir || (o.home ? path.join(home, '.cheaper') : P.CHEAPER_DIR);
  return {
    platform: o.platform || process.platform,
    home,
    cheaperDir,
    cliHome: o.cliHome || (o.home || o.cheaperDir ? path.join(cheaperDir, 'cli') : P.CLI_HOME),
    env: o.env || process.env,
    uid: o.uid !== undefined ? o.uid : (process.getuid ? process.getuid() : null),
    run: o.run || spawnSync,
    which: o.which || whichSync,
    nodeExe: o.nodeExe || process.execPath,
    resolvePy: o.resolvePy || (() => gateway.pyExe()),
    // Injectable because the real one runs pip against the network. A test that had to
    // install the gateway's Python deps to check what gets written into a plist would be
    // slow, offline-fragile, and would mutate the developer's machine.
    prepare: o.prepare || (() => gateway.prepare([])),
    probePort: o.probePort || probePortSync,
    ownGatewayHoldsPort: o.ownGatewayHoldsPort || ownGatewayHoldsPort,
    log: o.log || ((...a) => console.log(...a)),
    ask: o.ask || ask,
    // Both streams, exactly like openurl.js:24 — a pipe on either one means there is
    // nobody to answer, and a question nobody can answer is not consent.
    interactive: o.interactive !== undefined
      ? o.interactive
      : !!(process.stdin.isTTY && process.stdout.isTTY),
  };
}

function agentPath(ctx) {
  if (ctx.platform === 'darwin') return path.join(ctx.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  if (ctx.platform === 'linux') return path.join(ctx.home, '.config', 'systemd', 'user', UNIT_NAME);
  // win32 registers a Scheduled Task; there is no file on disk to point a user at, which
  // is why every message on that platform names the task instead of a path.
  return null;
}
function logPath(ctx) { return path.join(ctx.cheaperDir, LOG_BASENAME); }
function statePath(ctx) { return path.join(ctx.cheaperDir, STATE_BASENAME); }
function cliEntry(ctx) { return path.join(ctx.cliHome, 'bin', 'cheaper.js'); }

// Windows points at the stable launcher clilink.js:16-22 writes, not at node+script:
// %LOCALAPPDATA%\cheaper\bin\cheaper.cmd already resolves node from PATH at run time and
// falls back to a baked absolute path, so it survives a Node upgrade that would orphan a
// hard-coded interpreter.
function winLauncher(ctx) {
  const base = ctx.env.LOCALAPPDATA || path.join(ctx.home, 'AppData', 'Local');
  return path.join(base, 'cheaper', 'bin', 'cheaper.cmd');
}

// The literal command that removes what enable() wrote. Printed by enable() itself
// because "how do I turn this off" must not require finding the docs — that is the
// difference between a feature and something the user will describe as malware.
function removalCommands(ctx) {
  const manual = ctx.platform === 'darwin'
    ? `launchctl bootout gui/${ctx.uid == null ? '$(id -u)' : ctx.uid}/${LABEL}  &&  rm ${agentPath(ctx)}`
    : ctx.platform === 'linux'
      ? `systemctl --user disable --now ${UNIT_NAME}  &&  rm ${agentPath(ctx)}`
      : `schtasks /Delete /TN "${TASK_NAME}" /F`;
  return { cheaper: 'cheaper autostart disable', manual };
}

// ---------------------------------------------------------------------------
// persisted answer + enable record
// ---------------------------------------------------------------------------

function readState(ctx) {
  const s = readJSON(statePath(ctx), {});
  return s && typeof s === 'object' ? s : {};
}
function writeState(ctx, patch) {
  const next = Object.assign(readState(ctx), patch);
  writeJSON(statePath(ctx), next);
  return next;
}

// ---------------------------------------------------------------------------
// P3.3 — the port is machine-wide, the login entry is per-user
// ---------------------------------------------------------------------------
//
// gateway.js:166 binds 127.0.0.1 and the default port is 8787 for everyone. Two logged-in
// users who both enable autostart produce two agents racing for one port: the loser's
// uvicorn dies on EADDRINUSE, KeepAlive respawns it, and it crash-loops at 30s intervals
// with nothing on screen to explain it. The collision is detectable at enable time, so it
// is detected at enable time.
//
// The probe runs in a CHILD node, not in-process, because enable() is synchronous (it is
// called from install.js's component loop, which is synchronous) and net.createServer is
// not. A subprocess is the portable way to ask "can this port be bound" without an
// `lsof`/`netstat` output format to parse per platform.
const PORT_PROBE_SRC = [
  "const net = require('net');",
  'const port = Number(process.argv[1]);',
  "const s = net.createServer();",
  "s.once('error', (e) => { process.stdout.write(e.code === 'EADDRINUSE' ? 'in-use' : 'error:' + (e.code || 'unknown')); process.exit(0); });",
  "s.listen(port, '127.0.0.1', () => s.close(() => { process.stdout.write('free'); process.exit(0); }));",
].join('\n');

function probePortSync(port, runner = spawnSync) {
  let r;
  try {
    r = runner(process.execPath, ['-e', PORT_PROBE_SRC, String(port)], { encoding: 'utf8', timeout: 5000 });
  } catch (e) {
    return { state: 'unknown', detail: `the port check could not be run (${(e && e.code) || (e && e.message) || 'threw'})` };
  }
  if (!r) return { state: 'unknown', detail: 'the port check returned nothing' };
  if (r.error) return { state: 'unknown', detail: `the port check could not be run (${r.error.code || r.error.message})` };
  const out = String(r.stdout || '').trim();
  if (out === 'free') return { state: 'free', detail: 'nothing is listening on it' };
  if (out === 'in-use') return { state: 'in-use', detail: 'something is already bound to it' };
  return { state: 'unknown', detail: `the port check answered ${JSON.stringify(out.slice(0, 60))}` };
}

// Is the thing holding the port THIS user's own hand-started gateway? That case is not a
// collision at all — the login entry starts at the next login, by which time this process
// is long gone — so it must not be mistaken for another user's daemon and must not push
// us onto a different port than the one the user is already using.
function ownGatewayHoldsPort(port) {
  const rec = gateway.readPidFile();
  if (!rec || String(rec.port) !== String(port)) return false;
  return gateway.pidAlive(rec.pid) && gateway.pidLooksLikeGateway(rec.pid);
}

function classifyPort(ctx, port) {
  const probe = ctx.probePort(port);
  if (probe.state !== 'in-use') return probe;               // 'free' or 'unknown', unchanged
  if (ctx.ownGatewayHoldsPort(port))
    return { state: 'own-gateway', detail: 'this user\'s own running gateway holds it' };
  return { state: 'foreign', detail: probe.detail };
}

// Decide which port the entry should bake in.
//
// An EXPLICIT port (--port, or CHEAPER_PORT) that is occupied by someone else is a
// REFUSAL, never a silent move: the caller named a port for a reason, and writing a
// different number into a plist they will never open is exactly the confident-wrong
// answer this codebase keeps refusing to give. Only the implicit default may be moved,
// and moving it is announced.
function pickPort(ctx, wanted, explicit) {
  const first = classifyPort(ctx, wanted);
  if (first.state === 'free' || first.state === 'own-gateway')
    return { port: wanted, state: first.state, detail: first.detail };
  if (first.state === 'unknown')
    return { port: null, state: 'unknown', detail: first.detail };
  if (explicit)
    return { port: null, state: 'refused', detail: first.detail };
  for (let n = Number(wanted) + 1; n <= Number(wanted) + 9; n++) {
    const cl = classifyPort(ctx, String(n));
    if (cl.state === 'free')
      return { port: String(n), state: 'moved', from: wanted, detail: first.detail };
    if (cl.state === 'unknown')
      return { port: null, state: 'unknown', detail: cl.detail };
  }
  return {
    port: null,
    state: 'refused',
    detail: `${first.detail}, and none of the next 9 ports were free either`,
  };
}

// ---------------------------------------------------------------------------
// the log file
// ---------------------------------------------------------------------------

function ensureLog(ctx) {
  try { fs.mkdirSync(ctx.cheaperDir, { recursive: true }); } catch { /* reported below */ }
  const lp = logPath(ctx);
  let fd;
  try { fd = fs.openSync(lp, 'a', 0o600); }
  catch (e) { return { ok: false, detail: e.code || e.message }; }
  // The mode argument only applies when the file is CREATED, so tighten an existing one
  // that launchd (or an earlier build) left at 0644 — same reasoning as gateway.js:352.
  let ok = true, detail = null;
  try { fs.fchmodSync(fd, 0o600); } catch (e) { ok = false; detail = e.code || e.message; }
  try { fs.closeSync(fd); } catch { /* already closed */ }
  return { ok, detail };
}

function rotateLog(ctx, maxBytes = LOG_MAX_BYTES) {
  const lp = logPath(ctx);
  let st;
  try { st = fs.statSync(lp); } catch { return { state: 'absent' }; }
  if (st.size <= maxBytes) return { state: 'kept', size: st.size };
  try {
    // Exactly one generation is kept. More would need a real rotator; zero would throw
    // away the log that explains the crash loop that filled it.
    fs.rmSync(`${lp}.1`, { force: true });
    fs.renameSync(lp, `${lp}.1`);
    return { state: 'rotated', size: st.size };
  } catch (e) {
    return { state: 'failed', size: st.size, detail: e.code || e.message };
  }
}

// ---------------------------------------------------------------------------
// interpreter resolution (see the nvm hazard at the top of this file)
// ---------------------------------------------------------------------------

function looksVersionPinned(p) {
  // nvm: ~/.nvm/versions/node/v20.11.1/bin/node   fnm: ~/.fnm/node-versions/v20.11.1/...
  // volta: ~/.volta/tools/image/node/20.11.1/bin/node
  return /[\\/](versions?|node-versions|image[\\/]node)[\\/]/.test(p) || /[\\/]v?\d+\.\d+\.\d+[\\/]/.test(p);
}

function resolveInterpreters(ctx) {
  const node = ctx.nodeExe;
  if (!node || !fs.existsSync(node))
    return { ok: false, why: `could not resolve an absolute path to node (got ${JSON.stringify(String(node))})` };

  const py = ctx.resolvePy();
  if (!py)
    return {
      ok: false,
      why: 'no usable Python 3 was found. The gateway is a Python service, and a login '
        + 'entry that cannot find an interpreter crash-loops silently at every login — '
        + 'so it is not written at all. Install Python 3, then run this again.',
    };
  const pyAbs = ctx.which(py.cmd);
  if (!pyAbs)
    return {
      ok: false,
      why: `found \`${gateway.launcherLabel(py)}\` on this shell's PATH but could not resolve it to an `
        + 'absolute path. launchd/systemd start with a different PATH, so an unresolved '
        + 'interpreter name would be unfindable at login.',
    };
  return { ok: true, node, py, pyAbs };
}

function entryPathEnv(nodeExe, pyAbs) {
  const parts = [];
  const push = (d) => { if (d && !parts.includes(d)) parts.push(d); };
  push(path.dirname(nodeExe));
  push(path.dirname(pyAbs));
  for (const d of FIXED_PATH_DIRS) push(d);
  return parts.join(':');
}

// ---------------------------------------------------------------------------
// macOS — the LaunchAgent
// ---------------------------------------------------------------------------

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plistXml(rec) {
  const args = rec.programArguments.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  const env = Object.keys(rec.environment)
    .map((k) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(rec.environment[k])}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`cheaper autostart enable\`. Remove it with \`cheaper autostart disable\`. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <!-- KeepAlive is a DICT with SuccessfulExit=false, NEVER <true/>. With KeepAlive=true
       launchd restarts the job whatever it exits with, so the documented
       \`cheaper gateway stop\` would be answered by a respawn within ThrottleInterval and
       the user would have no in-product way to switch the service off at all.

       SuccessfulExit=false is not by itself an off switch either: it restarts on a
       NON-ZERO exit. It honours a deliberate stop ONLY BECAUSE \`cheaper gateway serve\`
       exits 0 when it ends on SIGTERM/SIGINT/SIGHUP and non-zero when uvicorn exits on
       its own (gateway.js, serve()). Under the shell's 128+N convention a deliberate
       SIGTERM is exit 143, which launchd reads as a crash — it would respawn the gateway
       the user just stopped. That cross-file dependency is pinned by a live-SIGTERM test
       in cli/test/autostart.test.js; do not treat it as an implementation detail of
       another file. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(rec.workingDirectory)}</string>
  <!-- Not gateway.log: that file is opened and fchmod'ed 0600 by the gateway itself,
       while launchd creates these under the user's umask. -->
  <key>StandardOutPath</key>
  <string>${xmlEscape(rec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(rec.logPath)}</string>
  <!-- launchd sources no shell profile. Without this PATH, gateway.js's pyExe() finds no
       python3 and every respawn dies with "No usable Python 3 found". -->
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
</dict>
</plist>
`;
}

// `launchctl print-disabled gui/<uid>` is where the System Settings > Login Items toggle
// lands on Ventura and later. Verified shape on macOS 26 (Darwin 25.3):
//
//     	disabled services = {
//     		"com.adobe.GC.AGM" => disabled
//     		"com.apple.Siri.agent" => enabled
//     	}
//
// Older builds print `=> true` / `=> false` for the same two meanings. Only labels with an
// OVERRIDE are listed at all, so a label absent from a well-formed listing has not been
// switched off by hand.
//
// EVERY UNRECOGNISED SHAPE RESOLVES TO 'unknown', NEVER TO 'enabled'. This parse is the
// only thing standing between enable() and silently re-registering an entry the user
// switched off in System Settings — the one consent rule in this file that cannot be
// proven without a real macOS. So a value word outside the two vocabularies below is
// unknown, and so is a listing that carries neither the `disabled services = {` header nor
// a single `"label" => value` entry: "I did not find the label in output I cannot read" is
// not evidence that the label is enabled. The fail-open direction here is the one that
// gets software called malware.
const DARWIN_DISABLED_WORDS = new Set(['true', 'disabled']);
const DARWIN_ENABLED_WORDS = new Set(['false', 'enabled']);

function darwinDisabled(ctx) {
  if (ctx.uid == null) return { state: 'unknown', detail: 'no uid to address launchd with' };
  const r = ctx.run('launchctl', ['print-disabled', `gui/${ctx.uid}`], { encoding: 'utf8' });
  if (!r) return { state: 'unknown', detail: 'launchctl returned nothing' };
  if (r.error) return { state: 'unknown', detail: `launchctl could not be run (${r.error.code || r.error.message})` };
  if (r.status !== 0) return { state: 'unknown', detail: `launchctl print-disabled exited ${r.status}` };
  const out = String(r.stdout || '');
  const m = new RegExp(`"${LABEL.replace(/\./g, '\\.')}"\\s*=>\\s*(\\S+)`).exec(out);
  if (m) {
    const word = m[1].toLowerCase().replace(/[;,]+$/, '');
    if (DARWIN_DISABLED_WORDS.has(word)) return { state: 'disabled' };
    if (DARWIN_ENABLED_WORDS.has(word)) return { state: 'enabled' };
    return {
      state: 'unknown',
      detail: 'could not determine whether you have disabled this entry: `launchctl print-disabled` '
        + `answered ${JSON.stringify(word.slice(0, 40))} for this label, which is neither of the words `
        + 'this build knows (true/disabled, false/enabled)',
    };
  }
  // A recognisable listing that simply does not name our label: no override, so not
  // disabled by hand. `disabled services = {}` on a machine with no overrides at all has
  // the header and no entries, which is why either shape counts as readable.
  if (/disabled\s+services\s*=\s*\{/i.test(out) || /"[^"]+"\s*=>\s*\S+/.test(out))
    return { state: 'not-listed' };
  return {
    state: 'unknown',
    detail: 'could not determine whether you have disabled this entry: `launchctl print-disabled` '
      + `printed an output shape this build does not recognise (${JSON.stringify(out.trim().slice(0, 60))})`,
  };
}

function registrationDarwin(ctx) {
  const p = agentPath(ctx);
  const onDisk = fs.existsSync(p);
  const dis = darwinDisabled(ctx);
  if (dis.state === 'disabled')
    return { state: 'disabled-by-user', onDisk, path: p, detail: 'launchd lists this label as disabled (System Settings > Login Items, or `launchctl disable`)' };
  // Fail closed on an unreadable disabled-list. Carrying on to the launchctl-print check
  // would answer "registered" or "absent" — both of which mean "not disabled by you" to
  // enable(), which would then re-register over the user's own off switch. 'unknown' is
  // the state enable() refuses on and status() prints in words.
  if (dis.state === 'unknown')
    return {
      state: 'unknown',
      onDisk,
      path: p,
      detail: dis.detail || 'could not determine whether you have disabled this entry',
    };

  let loaded = null, loadDetail = null;
  if (ctx.uid == null) loadDetail = 'no uid to address launchd with';
  else {
    const r = ctx.run('launchctl', ['print', `gui/${ctx.uid}/${LABEL}`], { encoding: 'utf8' });
    if (!r) loadDetail = 'launchctl returned nothing';
    else if (r.error) loadDetail = `launchctl could not be run (${r.error.code || r.error.message})`;
    else loaded = r.status === 0;
  }

  if (loaded === true) return { state: 'registered', onDisk, path: p, detail: 'loaded in launchd' };
  if (loaded === false && onDisk)
    // The plist is there but launchd does not know it yet. That is a real, nameable
    // state — LaunchAgents are loaded at login — and it is neither "running" nor "off".
    return { state: 'registered-not-loaded', onDisk, path: p, detail: 'the plist exists but launchd has not loaded it (it will at your next login)' };
  if (loaded === false) return { state: 'absent', onDisk, path: p, detail: 'no plist and nothing loaded' };
  // loaded === null: the check itself could not run. Never collapse that into either
  // answer — if the plist is on disk we genuinely do not know its state.
  return {
    state: onDisk ? 'unknown' : 'absent',
    onDisk,
    path: p,
    detail: loadDetail || 'the launchd check could not be run',
  };
}

// ---------------------------------------------------------------------------
// Linux — the systemd --user unit
// ---------------------------------------------------------------------------

// `systemctl --user` talks to a per-session bus. Over ssh, in most containers, and from
// cron there is no such bus, and every command fails with "Failed to connect to bus".
// Writing a unit file there produces something that looks installed, is never started,
// and reports nothing — so REFUSE IN WORDS instead of writing a dead unit.
function sessionBus(ctx) {
  const xdg = ctx.env.XDG_RUNTIME_DIR;
  const dbus = ctx.env.DBUS_SESSION_BUS_ADDRESS;
  if (xdg || dbus) return { ok: true };
  return {
    ok: false,
    detail: 'neither XDG_RUNTIME_DIR nor DBUS_SESSION_BUS_ADDRESS is set, so '
      + '`systemctl --user` has no session bus to talk to. That is the normal shape of an '
      + 'ssh session, a container, or a cron job — run this from a real desktop login '
      + 'session, or install a system unit yourself.',
  };
}

// Without lingering the user manager is torn down at logout and the gateway dies with it.
// Reported as on/off/unknown; "could not ask loginctl" is never printed as "it is fine".
function lingerState(ctx) {
  const user = ctx.env.USER || ctx.env.LOGNAME || ctx.env.USERNAME;
  if (!user) return { state: 'unknown', detail: 'no USER/LOGNAME in this environment to ask about' };
  const r = ctx.run('loginctl', ['show-user', user, '--property=Linger'], { encoding: 'utf8' });
  if (!r) return { state: 'unknown', detail: 'loginctl returned nothing', user };
  if (r.error) return { state: 'unknown', detail: `loginctl could not be run (${r.error.code || r.error.message})`, user };
  if (r.status !== 0) return { state: 'unknown', detail: `loginctl exited ${r.status}`, user };
  const m = /Linger=(\w+)/.exec(String(r.stdout || ''));
  if (!m) return { state: 'unknown', detail: 'loginctl did not report Linger', user };
  return { state: /^yes$/i.test(m[1]) ? 'on' : 'off', user };
}

function unitText(rec) {
  return `# Written by \`cheaper autostart enable\`. Remove it with \`cheaper autostart disable\`.
[Unit]
Description=Cheaper gateway (local adaptive-routing proxy + monitor)
Documentation=https://cheaper.app
After=default.target

[Service]
Type=simple
# The foreground form. \`gateway start\` would detach and exit, and systemd would restart
# the launcher forever while the uvicorns it spawned piled up behind it.
ExecStart=${rec.exec}
WorkingDirectory=${rec.workingDirectory}
Environment=PATH=${rec.environment.PATH}
Environment=CHEAPER_PORT=${rec.environment.CHEAPER_PORT}
StandardOutput=append:${rec.logPath}
StandardError=append:${rec.logPath}
# on-failure, not always: Restart=always would answer a deliberate \`systemctl --user stop\`
# with a respawn, leaving the user no off switch. on-failure restarts a NON-ZERO exit only.
#
# What systemd supervises here is the \`cheaper gateway serve\` CLI, and that process does
# not die of the signal — it forwards the signal to uvicorn and then exits normally — so it
# is the EXIT CODE, not systemd's clean-signal list, that decides whether this unit comes
# back. \`stop\` therefore stays stopped only because serve() exits 0 on a deliberate
# SIGTERM/SIGINT/SIGHUP and non-zero when uvicorn exits on its own (gateway.js, serve()).
# Revert that to the shell's 128+N convention and every deliberate stop reads as exit 143,
# i.e. a failure, and systemd restarts it RestartSec later.
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

// `systemctl --user is-enabled` answers with ONE word from a fixed vocabulary
// (systemctl(1): enabled, enabled-runtime, linked, linked-runtime, alias, masked,
// masked-runtime, static, indirect, disabled, generated, transient, bad), and only some of
// those words are an answer to the question this file asks. A word outside these two sets
// — a newer systemd's vocabulary, a localised message, a wrapper's own output — is
// UNKNOWN. It must never fall through to "not disabled", because "not disabled" is what
// lets enable() re-register on top of a `systemctl --user disable` the user ran by hand,
// and this parse cannot be proven from macOS.
const SYSTEMD_ENABLED_WORDS = new Set(['enabled', 'enabled-runtime']);
const SYSTEMD_DISABLED_WORDS = new Set(['disabled', 'masked', 'masked-runtime']);

function registrationLinux(ctx) {
  const p = agentPath(ctx);
  const onDisk = fs.existsSync(p);
  const bus = sessionBus(ctx);
  if (!bus.ok)
    return { state: onDisk ? 'unknown' : 'absent', onDisk, path: p, detail: bus.detail };
  const r = ctx.run('systemctl', ['--user', 'is-enabled', UNIT_NAME], { encoding: 'utf8' });
  if (!r) return { state: onDisk ? 'unknown' : 'absent', onDisk, path: p, detail: 'systemctl returned nothing' };
  if (r.error)
    return { state: onDisk ? 'unknown' : 'absent', onDisk, path: p, detail: `systemctl could not be run (${r.error.code || r.error.message})` };
  const word = (String(r.stdout || '').trim().split(/\s+/)[0] || '').toLowerCase();
  if (SYSTEMD_ENABLED_WORDS.has(word))
    return { state: 'registered', onDisk, path: p, detail: `systemd reports the unit ${word}` };
  if (SYSTEMD_DISABLED_WORDS.has(word)) {
    if (onDisk) return { state: 'disabled-by-user', onDisk, path: p, detail: `systemd reports the unit ${word}` };
    return { state: 'absent', onDisk, path: p, detail: `no unit file, and systemd reports ${word}` };
  }
  // No word at all is the shape of "Failed to get unit file state: No such file or
  // directory" — systemctl puts that on stderr and prints nothing on stdout.
  if (!word) {
    if (!onDisk) return { state: 'absent', onDisk, path: p, detail: 'no unit file' };
    return { state: 'unknown', onDisk, path: p, detail: `the unit file exists but systemctl exited ${r.status} without a state word` };
  }
  return {
    state: 'unknown',
    onDisk,
    path: p,
    detail: 'could not determine whether you have disabled this entry: `systemctl --user is-enabled` '
      + `answered ${JSON.stringify(word.slice(0, 40))}, which is not one of the words this build reads as `
      + 'enabled (enabled, enabled-runtime) or disabled (disabled, masked, masked-runtime)',
  };
}

// ---------------------------------------------------------------------------
// Windows — the Scheduled Task
// ---------------------------------------------------------------------------
//
// schtasks over a Startup-folder shortcut, deliberately: a .cmd in Startup flashes a
// console window at every login, cannot be queried, and cannot be disabled from anywhere
// the user would think to look. /RL LIMITED keeps it non-elevated — a login item that
// asks for admin is one the user should refuse.

// Same fail-closed rule as the two above: a `/FO LIST` block whose Status line is missing
// or carries a word this build does not know (a localised Windows prints its own) is
// UNKNOWN, not "registered". "Registered" is read by enable() as "not switched off", and
// recreating a task the user disabled in Task Scheduler is the same consent failure as
// re-registering over Login Items.
const SCHTASKS_LIVE_STATUSES = new Set(['ready', 'running', 'queued']);

function registrationWindows(ctx) {
  const r = ctx.run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'], { encoding: 'utf8' });
  if (!r) return { state: 'unknown', onDisk: false, path: null, detail: 'schtasks returned nothing' };
  if (r.error) return { state: 'unknown', onDisk: false, path: null, detail: `schtasks could not be run (${r.error.code || r.error.message})` };
  if (r.status !== 0) return { state: 'absent', onDisk: false, path: null, detail: 'no such scheduled task' };
  const out = String(r.stdout || '');
  const m = /^\s*Status:\s*(.+?)\s*$/im.exec(out);
  if (!m)
    return {
      state: 'unknown',
      onDisk: true,
      path: null,
      detail: 'could not determine whether you have disabled this task: `schtasks /Query /FO LIST` '
        + 'printed no Status line this build could read',
    };
  const st = m[1].toLowerCase();
  if (st === 'disabled')
    return { state: 'disabled-by-user', onDisk: true, path: null, detail: 'the scheduled task exists but is Disabled' };
  if (SCHTASKS_LIVE_STATUSES.has(st))
    return { state: 'registered', onDisk: true, path: null, detail: `the scheduled task exists (Status: ${m[1]})` };
  return {
    state: 'unknown',
    onDisk: true,
    path: null,
    detail: 'could not determine whether you have disabled this task: `schtasks /Query` reported '
      + `Status ${JSON.stringify(m[1].slice(0, 40))}, which this build does not recognise`,
  };
}

// Does the SUPERVISOR still hold this job? Deliberately narrower than registration(),
// which folds in whether the entry file is on disk: disable() has to ask "is launchd /
// systemd / Task Scheduler still going to run this" at a moment when the file is
// *deliberately* still there, and registration() would answer "registered-not-loaded" or
// "disabled-by-user" to that same situation.
//
// Answers held: true | false | null, and NULL MEANS THE QUESTION COULD NOT BE ANSWERED —
// never "no". disable() treats null as "not confirmed" and keeps the file.
function supervisorHoldsEntry(ctx) {
  if (ctx.platform === 'darwin') {
    if (ctx.uid == null) return { held: null, detail: 'no uid to address launchd with' };
    const r = ctx.run('launchctl', ['print', `gui/${ctx.uid}/${LABEL}`], { encoding: 'utf8' });
    if (!r) return { held: null, detail: 'launchctl returned nothing' };
    if (r.error) return { held: null, detail: `launchctl could not be run (${r.error.code || r.error.message})` };
    return {
      held: r.status === 0,
      detail: r.status === 0 ? 'launchd still lists the job' : `launchctl print exited ${r.status} (launchd no longer lists the job)`,
    };
  }

  if (ctx.platform === 'linux') {
    const bus = sessionBus(ctx);
    if (!bus.ok) return { held: null, detail: bus.detail };
    const r = ctx.run('systemctl', ['--user', 'is-enabled', UNIT_NAME], { encoding: 'utf8' });
    if (!r) return { held: null, detail: 'systemctl returned nothing' };
    if (r.error) return { held: null, detail: `systemctl could not be run (${r.error.code || r.error.message})` };
    const word = (String(r.stdout || '').trim().split(/\s+/)[0] || '').toLowerCase();
    if (SYSTEMD_ENABLED_WORDS.has(word)) return { held: true, detail: `systemd still reports the unit ${word}` };
    if (SYSTEMD_DISABLED_WORDS.has(word)) return { held: false, detail: `systemd reports the unit ${word}` };
    // No state word AND a non-zero exit is the "no such unit file" shape; a SILENT
    // success is a shape we do not understand and must not read as "gone".
    if (!word && r.status !== 0) return { held: false, detail: `systemctl exited ${r.status} with no state word (no such unit)` };
    return { held: null, detail: `\`systemctl --user is-enabled\` answered ${JSON.stringify(word.slice(0, 40))}` };
  }

  if (ctx.platform === 'win32') {
    const r = ctx.run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'], { encoding: 'utf8' });
    if (!r) return { held: null, detail: 'schtasks returned nothing' };
    if (r.error) return { held: null, detail: `schtasks could not be run (${r.error.code || r.error.message})` };
    return {
      held: r.status === 0,
      detail: r.status === 0 ? 'the scheduled task still exists' : 'no such scheduled task',
    };
  }

  return { held: null, detail: `${ctx.platform} has no autostart mechanism here` };
}

function registration(ctx) {
  if (ctx.platform === 'darwin') return registrationDarwin(ctx);
  if (ctx.platform === 'linux') return registrationLinux(ctx);
  if (ctx.platform === 'win32') return registrationWindows(ctx);
  return { state: 'unsupported', onDisk: false, path: null, detail: `${ctx.platform} has no autostart mechanism here` };
}

// Cheap, filesystem-only "is there an entry" for `cheaper status`. It reports what is ON
// DISK and nothing more — whether launchd/systemd has it loaded, and whether the user
// switched it off, needs the probes above, so every caller of this prints a pointer to
// `cheaper autostart status` rather than implying this answer is the whole truth.
function isRegisteredOnDisk(overrides = {}) {
  const ctx = makeCtx(overrides);
  const p = agentPath(ctx);
  if (p) return fs.existsSync(p);
  // win32 has no file; the enable record is the only local evidence.
  const st = readState(ctx);
  return !!(st.enabled && st.enabledAt && !st.disabledAt);
}

// ---------------------------------------------------------------------------
// enable
// ---------------------------------------------------------------------------

function refuse(ctx, lines, code = 1) {
  for (const l of lines) ctx.log(l);
  process.exitCode = code;
  return { ok: false, state: 'refused', msg: strip(lines[0]) };
}

// Messages are returned to install.js for its ✓/✗ line, and that line is plain text.
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').trim();

function enable(argv = [], overrides = {}) {
  const ctx = makeCtx(overrides);
  const L = ctx.log;

  if (!SUPPORTED_PLATFORMS.has(ctx.platform))
    return refuse(ctx, [c.red(`  ✗ autostart is not supported on ${ctx.platform}.`)]);

  // 1. THE TARGET MUST EXIST. A supervisor pointed at a missing script does not fail
  //    loudly — it crash-loops at ThrottleInterval forever, writing the same ENOENT into
  //    a log nobody opens. ~/.cheaper/cli is staged by the `cli` component
  //    (clilink.js:29-33); the AppImage distribution has no install step at all, so this
  //    is a real and reachable state, not a defensive check.
  const target = ctx.platform === 'win32' ? winLauncher(ctx) : cliEntry(ctx);
  if (!fs.existsSync(target))
    return refuse(ctx, [
      c.red('  ✗ nothing to autostart: ') + target + c.dim(' does not exist.'),
      c.dim('    Autostart runs the stable copy of this CLI, not whatever is on your PATH '),
      c.dim('    today. Install it first:  ') + 'cheaper install cli',
      c.dim('    (The Linux AppImage has no install step, so this copy is never staged for it.)'),
    ]);

  // 2. PORT. resolvePort is gateway.js's, so the flag means exactly the same thing here
  //    as it does to the process being supervised.
  const flagged = gateway.readPortFlag(argv) !== undefined;
  const resolved = gateway.resolvePort(argv, ctx.env);
  if (resolved.error) return refuse(ctx, [c.red('  ✗ ') + resolved.error]);
  const explicit = flagged || resolved.source === 'CHEAPER_PORT';

  // 3. NOT OVER THE TOP OF THE USER'S OWN OFF SWITCH.
  const before = registration(ctx);
  if (before.state === 'disabled-by-user')
    return refuse(ctx, [
      c.amber('  ! autostart is already registered, and YOU switched it off.') +
        c.dim(`  (${before.detail})`),
      c.dim('    Re-registering it would silently undo that, so this stops here.'),
      ctx.platform === 'darwin'
        ? c.dim('    Turn it back on in System Settings > Login Items, or:  ') + `launchctl enable gui/${ctx.uid}/${LABEL}`
        : ctx.platform === 'linux'
          ? c.dim('    Turn it back on with:  ') + `systemctl --user enable --now ${UNIT_NAME}`
          : c.dim('    Turn it back on with:  ') + `schtasks /Change /TN "${TASK_NAME}" /ENABLE`,
      c.dim('    Or remove it entirely first:  ') + 'cheaper autostart disable',
    ]);
  if (before.state === 'unknown')
    return refuse(ctx, [
      c.amber('  ! could not determine whether an autostart entry is already registered ') +
        c.dim(`(${before.detail})`),
      c.dim('    Registering on top of an unknown state risks a duplicate entry, or '),
      c.dim('    re-enabling one you switched off. Nothing was written.'),
    ]);

  // 4. LINUX: no session bus means `systemctl --user` cannot work at all.
  if (ctx.platform === 'linux') {
    const bus = sessionBus(ctx);
    if (!bus.ok)
      return refuse(ctx, [
        c.red('  ✗ cannot register a user service here: ') + bus.detail,
        c.dim('    A unit file written now would look installed and never start.'),
      ]);
  }

  // 5. INTERPRETERS, absolute (see the nvm hazard at the top).
  const interp = resolveInterpreters(ctx);
  if (!interp.ok) return refuse(ctx, [c.red('  ✗ ') + interp.why]);

  // 6. PORT COLLISION.
  const chosen = pickPort(ctx, resolved.port, explicit);
  if (chosen.state === 'unknown')
    return refuse(ctx, [
      c.amber(`  ! could not determine whether port ${resolved.port} is free `) + c.dim(`(${chosen.detail})`),
      c.dim('    A login entry that cannot bind its port crash-loops silently, so this'),
      c.dim('    refuses rather than guess. Fix the check, or name a port:  ') +
        `cheaper autostart enable --port ${Number(resolved.port) + 1}`,
    ]);
  if (chosen.state === 'refused')
    return refuse(ctx, [
      c.red(`  ✗ port ${resolved.port} is already taken by something that is not this user's gateway `) +
        c.dim(`(${chosen.detail}).`),
      c.dim('    127.0.0.1:' + resolved.port + ' is machine-wide but this login entry is per-user, so a'),
      c.dim('    second user (or an unrelated service) holding it means every respawn'),
      c.dim('    fails to bind. Pick a free port:  ') +
        `cheaper autostart enable --port ${Number(resolved.port) + 1}`,
    ]);
  const port = chosen.port;

  // 7. PREPARE ONCE, HERE — never from the unit. pip needs the network and can take
  //    minutes; inside a restart loop it hammers the index, and a machine that is offline
  //    at boot would never come up.
  L(c.dim('  Preparing the gateway once (deps + files) so the login entry never has to...'));
  let prepared = false;
  try { prepared = ctx.prepare() === true; } catch { prepared = false; }
  if (!prepared)
    L(c.amber('  ! `cheaper gateway prepare` did not report success') +
      c.dim(' — continuing, but run it by hand and check `cheaper gateway serve` before relying on this'));

  // 8. LOG: created 0600 and capped, before anything can write to it.
  const rot = rotateLog(ctx);
  const logged = ensureLog(ctx);
  if (!logged.ok)
    L(c.amber(`  ! could not restrict ${logPath(ctx)} to 0600 (${logged.detail})`) +
      c.dim(' — other accounts on this machine may be able to read it'));

  const win = ctx.platform === 'win32';
  const rec = {
    label: LABEL,
    port,
    node: interp.node,
    python: interp.pyAbs,
    pythonLauncher: gateway.launcherLabel(interp.py),
    target,
    workingDirectory: ctx.cheaperDir,
    logPath: logPath(ctx),
    // No PATH on win32: a scheduled task carries no environment block, and the .cmd
    // launcher clilink.js writes already resolves node itself. Baking a colon-separated
    // POSIX PATH into a record nothing reads would be a lie in the state file.
    environment: win
      ? { CHEAPER_PORT: String(port) }
      : { PATH: entryPathEnv(interp.node, interp.pyAbs), CHEAPER_PORT: String(port) },
    programArguments: [interp.node, target, 'gateway', 'serve', '--port', String(port)],
    exec: win
      ? `"${target}" gateway serve --port ${port}`
      : `${interp.node} ${target} gateway serve --port ${port}`,
  };

  // 9. WRITE, then REGISTER, then VERIFY. Each step reports its own outcome; "wrote the
  //    file" is never printed as "the service is registered".
  let wrotePath = null;
  try {
    fs.mkdirSync(ctx.cheaperDir, { recursive: true });
    if (ctx.platform === 'darwin') {
      wrotePath = agentPath(ctx);
      fs.mkdirSync(path.dirname(wrotePath), { recursive: true });
      fs.writeFileSync(wrotePath, plistXml(rec));
    } else if (ctx.platform === 'linux') {
      wrotePath = agentPath(ctx);
      fs.mkdirSync(path.dirname(wrotePath), { recursive: true });
      fs.writeFileSync(wrotePath, unitText(rec));
    }
  } catch (e) {
    return refuse(ctx, [c.red(`  ✗ could not write ${wrotePath} (${e.code || e.message})`)]);
  }

  const reg = registerWithSupervisor(ctx, rec, wrotePath);

  writeState(ctx, {
    offered: true,
    answer: 'yes',
    enabled: true,
    enabledAt: new Date().toISOString(),
    disabledAt: null,
    record: rec,
    registration: { state: reg.state, detail: reg.detail },
  });

  // 10. SAY EXACTLY WHAT WAS WRITTEN AND EXACTLY HOW TO REMOVE IT.
  const rm = removalCommands(ctx);
  const where = wrotePath || `scheduled task ${JSON.stringify(TASK_NAME)}`;
  if (reg.state === 'registered') {
    L('  ' + c.green('✓') + ' autostart enabled — the gateway will start at login on port ' + c.bold(String(port)));
  } else if (reg.state === 'written-not-loaded') {
    L('  ' + c.amber('!') + ` wrote the entry, but could not load it now (${reg.detail})`);
    L(c.dim('    It should take effect at your next login. Verify with:  ') + 'cheaper autostart status');
    process.exitCode = 1;
  } else {
    L('  ' + c.amber('!') + ` wrote the entry, but could NOT confirm it is registered (${reg.detail})`);
    L(c.dim('    Treat this as unverified, not as working. Check:  ') + 'cheaper autostart status');
    process.exitCode = 1;
  }
  L(c.dim('    wrote:   ') + where);
  L(c.dim('    runs:    ') + rec.exec);
  L(c.dim('    log:     ') + rec.logPath + c.dim(`  (0600; capped at ${Math.round(LOG_MAX_BYTES / 1048576)}MB when a \`cheaper autostart\` command runs — nothing rotates it in between)`));
  if (rot.state === 'rotated') L(c.dim(`    rotated: the previous log (${rot.size} bytes) is now ${rec.logPath}.1`));
  if (rot.state === 'failed') L(c.amber(`    ! could not rotate the oversized log (${rot.detail})`));
  L(c.dim('    remove:  ') + rm.cheaper + c.dim('   (by hand: ') + rm.manual + c.dim(')'));

  if (chosen.state === 'moved')
    L(c.amber(`    ! port ${chosen.from} was taken (${chosen.detail}), so the entry was written for ${port} instead.`) +
      c.dim(`  Point your clients at http://localhost:${port}`));
  if (chosen.state === 'own-gateway')
    L(c.dim(`    (port ${port} is currently held by your own running gateway — that is fine; the login entry starts a fresh one at next login.)`));
  if (looksVersionPinned(rec.node))
    L(c.amber('    ! the node path baked in above looks version-managed (nvm/fnm/volta).') +
      c.dim(' Your next Node upgrade will orphan it — `cheaper autostart status` detects that; re-run enable to fix it.'));
  if (ctx.platform === 'linux') {
    const linger = lingerState(ctx);
    if (linger.state === 'off')
      L(c.amber('    ! lingering is OFF for this user, so the unit is killed at logout.') +
        c.dim('  Enable it with:  ') + `loginctl enable-linger ${linger.user}`);
    else if (linger.state === 'unknown')
      L(c.amber(`    ! could not determine whether lingering is enabled (${linger.detail}).`) +
        c.dim('  Without it the unit dies at logout:  ') + 'loginctl enable-linger $USER');
  }

  return {
    ok: reg.state === 'registered',
    state: reg.state,
    port,
    path: wrotePath,
    msg: `autostart -> ${where} (port ${port}; remove with: ${rm.cheaper})` +
      (reg.state === 'registered' ? '' : ` [UNVERIFIED: ${reg.detail}]`),
  };
}

function registerWithSupervisor(ctx, rec, wrotePath) {
  const ran = (cmd, args) => {
    const r = ctx.run(cmd, args, { encoding: 'utf8' });
    if (!r) return { ok: false, hard: false, detail: `${cmd} returned nothing` };
    if (r.error) return { ok: false, hard: false, detail: `${cmd} could not be run (${r.error.code || r.error.message})` };
    return {
      ok: r.status === 0,
      hard: true,
      detail: `${cmd} exited ${r.status}${(r.stderr || '').trim() ? `: ${String(r.stderr).trim().split('\n')[0]}` : ''}`,
    };
  };

  if (ctx.platform === 'darwin') {
    if (ctx.uid == null) return { state: 'unknown', detail: 'no uid to address launchd with' };
    // bootstrap is the modern form; `load -w` is kept as a fallback because bootstrap
    // does not exist before 10.11 and refuses in some session types where load still
    // works. A fallback that is never tried is not a fallback.
    let r = ran('launchctl', ['bootstrap', `gui/${ctx.uid}`, wrotePath]);
    if (!r.ok) r = ran('launchctl', ['load', '-w', wrotePath]);
    const after = registration(ctx);
    if (after.state === 'registered') return { state: 'registered', detail: after.detail };
    if (after.state === 'registered-not-loaded') return { state: 'written-not-loaded', detail: r.detail || after.detail };
    return { state: 'unverified', detail: r.detail || after.detail };
  }

  if (ctx.platform === 'linux') {
    ran('systemctl', ['--user', 'daemon-reload']);
    const r = ran('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
    const after = registration(ctx);
    if (after.state === 'registered') return { state: 'registered', detail: after.detail };
    if (after.state === 'registered-not-loaded') return { state: 'written-not-loaded', detail: r.detail || after.detail };
    return { state: 'unverified', detail: r.detail || after.detail };
  }

  // win32 — the whole registration IS the schtasks call; there is no file.
  const tr = `"${winLauncher(ctx)}" gateway serve --port ${rec.port}`;
  const r = ran('schtasks', ['/Create', '/TN', TASK_NAME, '/TR', tr, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F']);
  const after = registration(ctx);
  if (after.state === 'registered') return { state: 'registered', detail: after.detail };
  return { state: 'unverified', detail: r.detail || after.detail };
}

// ---------------------------------------------------------------------------
// disable
// ---------------------------------------------------------------------------
//
// P1.4 — ORDER IS THE WHOLE POINT. Deregister the supervisor FIRST, then remove the
// file. The reverse (which is what a naive uninstall does) leaves launchd/systemd holding
// a job definition that points at a deleted binary, retrying it at every login, with no
// `cheaper` command left on the machine to switch it off.
function disable(argv = [], overrides = {}) {
  const ctx = makeCtx(overrides);
  const L = ctx.log;
  const p = agentPath(ctx);
  const before = registration(ctx);

  if (before.state === 'unsupported')
    return { ok: true, state: 'absent', msg: `autostart -> (not supported on ${ctx.platform})` };

  const steps = [];
  const ran = (cmd, args) => {
    const r = ctx.run(cmd, args, { encoding: 'utf8' });
    if (!r) return { ok: false, detail: `${cmd} returned nothing` };
    if (r.error) return { ok: false, detail: `${cmd} could not be run (${r.error.code || r.error.message})` };
    return { ok: r.status === 0, detail: `${cmd} exited ${r.status}` };
  };

  if (ctx.platform === 'darwin' && ctx.uid != null) {
    let r = ran('launchctl', ['bootout', `gui/${ctx.uid}/${LABEL}`]);
    if (!r.ok && p && fs.existsSync(p)) r = ran('launchctl', ['unload', '-w', p]);
    steps.push({ what: 'deregister', ...r });
  } else if (ctx.platform === 'linux') {
    steps.push({ what: 'deregister', ...ran('systemctl', ['--user', 'disable', '--now', UNIT_NAME]) });
  } else if (ctx.platform === 'win32') {
    steps.push({ what: 'deregister', ...ran('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']) });
  } else {
    steps.push({ what: 'deregister', ok: false, detail: 'no uid to address launchd with' });
  }

  const dereg = steps[0] || { ok: false, detail: 'nothing ran' };

  // REMOVING THE FILE IS CONDITIONAL ON A CONFIRMED DEREGISTRATION — the second half of
  // P1.4, and the half that is easy to lose. Deregistering first is worthless if the file
  // is deleted whatever the deregistration answered: a `launchctl bootout` that failed for
  // a real reason (EPERM, a job in a session we cannot address, no uid at all) leaves
  // launchd holding a job definition whose ProgramArguments name a plist that no longer
  // exists. It retries at every login, `cheaper autostart status` can no longer even see
  // it, and the manual `rm` in the message below has nothing left to remove.
  //
  // Confirmed means EITHER the deregister command succeeded, OR the supervisor
  // demonstrably no longer holds the job — which is also how "it was not loaded in the
  // first place" (bootout exits 3, "No such process") stays a success. held === null, the
  // could-not-tell answer, is NOT confirmation.
  const holds = supervisorHoldsEntry(ctx);
  const deregConfirmed = dereg.ok || holds.held === false;

  let removed = false, removeErr = null;
  if (deregConfirmed && p) {
    try {
      if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed = true; }
    } catch (e) { removeErr = e.code || e.message; }
  }
  if (ctx.platform === 'linux') ran('systemctl', ['--user', 'daemon-reload']);

  if (!deregConfirmed) {
    const why = `${dereg.detail}; ${holds.detail}`;
    L(c.amber('  ! could NOT deregister the autostart entry ') + c.dim(`(${why})`));
    if (p) {
      L(c.dim('    ') + p + c.dim(' was KEPT on purpose: deleting it now would leave the'));
      L(c.dim('    supervisor holding a job that points at a file which no longer exists, retried'));
      L(c.dim('    at every login, with nothing left on disk for this command to find.'));
    } else {
      // win32 keeps no file, so there is nothing to preserve — only something still
      // registered that this command failed to remove.
      L(c.dim('    The entry may still be registered and will run at your next login.'));
    }
    L(c.dim('    Remove it by hand with:  ') + removalCommands(ctx).manual);
    process.exitCode = 1;
    // The entry is still live, so the state file must not claim it was disabled — `cheaper
    // status` and --purge both read that flag.
    return {
      ok: false,
      state: registration(ctx).state,
      msg: `autostart -> NOT deregistered (${why})` +
        (p ? `; ${p} was KEPT` : '') +
        `; run by hand: ${removalCommands(ctx).manual}`,
    };
  }

  // Only record the disable when there was something to disable, or when a state file
  // already exists. `cheaper uninstall` runs this component unconditionally, and a
  // writeState() here would CREATE ~/.cheaper (and a file inside it) as a side effect of
  // removing ~/.cheaper — an uninstaller that leaves new files behind.
  if (before.state !== 'absent' || removed || fs.existsSync(statePath(ctx)))
    writeState(ctx, { enabled: false, disabledAt: new Date().toISOString() });

  const after = registration(ctx);

  // Past here the deregistration IS confirmed (the branch above returned otherwise), so
  // this is the narrower question: is anything still left? A supervisor that keeps
  // reporting the job in THIS session even after a successful bootout is not something to
  // print a green tick over.
  if (after.state === 'absent') {
    const msg = before.state === 'absent' && !removed
      ? 'autostart -> (not present)'
      : `autostart -> deregistered${removed ? ` + removed ${p}` : ''}`;
    // Nothing to say when there was nothing to remove: `cheaper uninstall` runs this on
    // every machine, and the caller already prints the returned msg.
    if (before.state !== 'absent' || removed)
      L('  ' + c.green('✓') + ' autostart disabled' + (removed ? c.dim(`  (removed ${p})`) : ''));
    return { ok: true, state: 'absent', msg };
  }

  L(c.amber('  ! could not confirm the autostart entry is gone ') + c.dim(`(${after.detail})`));
  L(c.dim('    deregister step: ') + dereg.detail);
  if (removeErr) L(c.dim('    file removal:    ') + `failed (${removeErr})`);
  else if (removed) L(c.dim('    file removal:    ') + `removed ${p}`);
  L(c.dim('    remove it by hand with:  ') + removalCommands(ctx).manual);
  process.exitCode = 1;
  return {
    ok: false,
    state: after.state,
    msg: `autostart -> NOT confirmed removed (${after.detail}); run by hand: ${removalCommands(ctx).manual}`,
  };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

// Re-resolve what was baked in at enable time. This is the whole answer to the nvm
// hazard: a login entry that stopped working because Node moved looks identical, from the
// outside, to one that works — except that this check says so.
function driftReport(ctx, rec) {
  const out = [];
  if (!rec) return [{ what: 'record', state: 'unknown', detail: 'no enable record was found, so nothing can be re-resolved' }];

  if (!rec.node) out.push({ what: 'node', state: 'unknown', detail: 'no node path was recorded' });
  else if (!fs.existsSync(rec.node))
    out.push({ what: 'node', state: 'missing', detail: `the recorded node no longer exists: ${rec.node} — run \`cheaper autostart enable\` again` });
  else {
    const now = ctx.which('node');
    if (now && path.resolve(now) !== path.resolve(rec.node))
      out.push({ what: 'node', state: 'moved', detail: `the entry runs ${rec.node}; your PATH now resolves node to ${now} (the baked one still exists, so it still works)` });
    else out.push({ what: 'node', state: 'ok', detail: rec.node });
  }

  if (!rec.python) out.push({ what: 'python', state: 'unknown', detail: 'no python path was recorded' });
  else if (!fs.existsSync(rec.python))
    out.push({ what: 'python', state: 'missing', detail: `the recorded python no longer exists: ${rec.python} — run \`cheaper autostart enable\` again` });
  else out.push({ what: 'python', state: 'ok', detail: rec.python });

  if (!rec.target) out.push({ what: 'cheaper', state: 'unknown', detail: 'no CLI target was recorded' });
  else if (!fs.existsSync(rec.target))
    out.push({ what: 'cheaper', state: 'missing', detail: `the recorded CLI no longer exists: ${rec.target} — the entry crash-loops until you run \`cheaper install cli\` and \`cheaper autostart enable\` again` });
  else out.push({ what: 'cheaper', state: 'ok', detail: rec.target });

  return out;
}

function status(argv = [], overrides = {}) {
  const ctx = makeCtx(overrides);
  const L = ctx.log;
  const st = readState(ctx);
  const reg = registration(ctx);

  if (reg.state === 'unsupported') {
    L('  autostart: ' + c.dim(`not supported on ${ctx.platform}`));
    return { state: reg.state };
  }

  // The user's own off switch. Report it and STOP — no drift chatter, no "run enable
  // again" nudge. Nudging someone back towards a thing they deliberately switched off in
  // System Settings is exactly the behaviour that gets software called adware.
  if (reg.state === 'disabled-by-user') {
    L('  autostart: ' + c.amber('registered but disabled by you') + c.dim(`  (${reg.detail})`));
    if (reg.path) L(c.dim('    entry:  ') + reg.path);
    L(c.dim('    Leaving it exactly as you set it. To remove it entirely:  ') + 'cheaper autostart disable');
    return { state: reg.state, path: reg.path };
  }

  if (reg.state === 'absent') {
    L('  autostart: ' + c.dim('not enabled') + c.dim('  (opt in with `cheaper autostart enable`)'));
    if (st.offered && st.answer === 'no')
      L(c.dim('    You were asked once and said no; you will not be asked again.'));
    return { state: reg.state };
  }

  if (reg.state === 'unknown') {
    // A check that could not run is not a pass, and must not render as either answer.
    L('  autostart: ' + c.amber('unknown') + c.dim(`  (${reg.detail})`));
    if (reg.path) L(c.dim('    entry on disk: ') + reg.path);
    process.exitCode = 1;
    return { state: reg.state, path: reg.path };
  }

  if (reg.state === 'registered') L('  autostart: ' + c.green('registered') + c.dim(`  (${reg.detail})`));
  else L('  autostart: ' + c.amber('registered, not loaded') + c.dim(`  (${reg.detail})`));

  const rec = st.record || null;
  if (reg.path) L(c.dim('    entry:   ') + reg.path);
  if (rec && rec.exec) L(c.dim('    runs:    ') + rec.exec);
  if (rec && rec.port) L(c.dim('    port:    ') + rec.port);
  L(c.dim('    log:     ') + logPath(ctx));

  const rot = rotateLog(ctx);
  if (rot.state === 'rotated') L(c.dim(`    rotated: the log exceeded ${LOG_MAX_BYTES} bytes and was moved to ${logPath(ctx)}.1`));
  if (rot.state === 'failed') L(c.amber(`    ! could not rotate the oversized log (${rot.detail})`));

  let bad = 0;
  for (const d of driftReport(ctx, rec)) {
    if (d.state === 'ok') continue;
    bad++;
    const paint = d.state === 'missing' ? c.red : c.amber;
    L('    ' + paint(`! ${d.what}: `) + d.detail);
  }
  if (bad === 0) L(c.dim('    checked: the node, python and CLI paths baked in at enable time all still exist.'));
  else process.exitCode = 1;

  L(c.dim('    remove:  ') + removalCommands(ctx).cheaper);
  return { state: reg.state, path: reg.path, drift: bad };
}

// ---------------------------------------------------------------------------
// the one-time offer
// ---------------------------------------------------------------------------

// Asked at most once, ever, and only with a real terminal on BOTH streams. The answer is
// persisted either way — "no" is a decision, and re-litigating it at every install is the
// behaviour this product is supposed to be the opposite of.
async function offerOnce(overrides = {}) {
  const ctx = makeCtx(overrides);
  if (!SUPPORTED_PLATFORMS.has(ctx.platform)) return { asked: false, why: 'unsupported platform' };
  if (!ctx.interactive) return { asked: false, why: 'not a TTY on both stdin and stdout' };
  const st = readState(ctx);
  if (st.offered) return { asked: false, why: 'already asked once' };
  const reg = registration(ctx);
  if (reg.state !== 'absent') return { asked: false, why: `already ${reg.state}` };

  ctx.log('');
  ctx.log(c.amber('  Start the gateway automatically at login?'));
  ctx.log(c.dim('    This registers a per-user login entry that runs `cheaper gateway serve`'));
  ctx.log(c.dim('    and restarts it if it crashes. It is entirely optional, it is never'));
  ctx.log(c.dim('    enabled by `cheaper install`, and `cheaper autostart disable` removes it.'));
  const ans = String(await ctx.ask('  ' + c.dim('[y/N]') + ' > ')).trim().toLowerCase();
  const yes = ans === 'y' || ans === 'yes';

  // Persist BEFORE acting, so a crash inside enable() cannot cause the question to be
  // asked a second time.
  writeState(ctx, { offered: true, offeredAt: new Date().toISOString(), answer: yes ? 'yes' : 'no' });
  if (!yes) {
    ctx.log(c.dim('  Not enabled. You will not be asked again — `cheaper autostart enable` if you change your mind.'));
    return { asked: true, answer: 'no' };
  }
  const r = enable([], overrides);
  return { asked: true, answer: 'yes', result: r };
}

// ---------------------------------------------------------------------------

function run(argv = []) {
  const cmd = argv[0];
  if (cmd === 'enable') return enable(argv.slice(1));
  if (cmd === 'disable') return disable(argv.slice(1));
  if (cmd === 'status') return status(argv.slice(1));
  // Matches gateway.run(): an unrecognized subcommand is a FAILURE, and a script has only
  // the exit code to read.
  console.log(c.red(cmd ? `  Unknown autostart subcommand: ${cmd}` : '  Missing autostart subcommand.'));
  console.log('  usage: cheaper autostart <enable|disable|status> [--port N]');
  console.log(c.dim('         enable  = register a login entry that runs `cheaper gateway serve`'));
  console.log(c.dim('         disable = deregister it AND delete the file it wrote'));
  console.log(c.dim('         status  = registered? disabled by you? do the baked-in paths still exist?'));
  process.exitCode = 1;
  return { ok: false, state: 'usage' };
}

module.exports = {
  run, enable, disable, status, offerOnce,
  registration, supervisorHoldsEntry, isRegisteredOnDisk, readState, writeState,
  agentPath, logPath, statePath, removalCommands,
  plistXml, unitText, pickPort, classifyPort, probePortSync, rotateLog,
  driftReport, sessionBus, lingerState, entryPathEnv, looksVersionPinned,
  makeCtx, LABEL, UNIT_NAME, TASK_NAME, LOG_BASENAME, STATE_BASENAME, LOG_MAX_BYTES,
  SUPPORTED_PLATFORMS,
};
