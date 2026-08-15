'use strict';
// install.js: the installer must never claim to have done something it did not do.
//
// The headline case: `cheaper install` with no component list, no --all and no TTY.
// util.js::ask() is a bare readline.question with no TTY guard, and on a closed or
// piped stdin readline never fires the callback — the promise never settles, the event
// loop drains, and node exits 0. So a CI step, a Dockerfile RUN or a provisioning
// script printed the component menu, installed NOTHING, and reported success. The
// process does not even hang; that is precisely why nobody noticed.
//
// The fix is a TTY guard on the interactive branch (the same guard openurl.js already
// uses), NOT a change to ask(). Making ask() resolve('') on close would map to
// DEFAULT_KEYS and silently perform an UNATTENDED FULL INSTALL — writing settings.json
// and copying agents on a machine whose operator only asked to see the menu. Worse
// than the bug. There is a test below pinning that too.

const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'cheaper.js');

// --- sandbox HOME, BEFORE paths.js is loaded (in-process tests below) ------
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-install-test-'));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX, '.claude');

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Run the REAL cli in a child process. stdio 'ignore'/'pipe' means neither stdin nor
// stdout is a TTY — exactly the shape of a CI step or `cheaper install < /dev/null`.
function runCli(args, homeDir) {
  const home = homeDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-inst-'));
  const r = spawnSync(process.execPath, [BIN, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 90000,
    env: Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    }),
  });
  return { home, status: r.status, out: strip((r.stdout || '') + (r.stderr || '')) };
}

const listHome = (home) => {
  const seen = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      seen.push(path.relative(home, path.join(d, e.name)));
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(home, 0);
  return seen;
};

// --------------------------------------------------------------------------
// 1. THE SILENT NO-OP (P2)
// --------------------------------------------------------------------------

test('non-TTY `cheaper install` with no components exits NON-ZERO and says why', () => {
  const { home, status, out } = runCli(['install']);

  assert.strictEqual(status, 1,
    'exiting 0 having installed nothing is indistinguishable from a real install\n' + out);
  assert.ok(out.includes('No components selected'), out);
  assert.ok(/not a TTY|no terminal/i.test(out),
    'the message must name the actual cause so the reader can fix it\n' + out);
  // …and it must be ACTIONABLE.
  assert.ok(out.includes('cheaper install --all'), out);
  assert.ok(out.includes('cheaper install --harness'), out);
});

test('non-TTY `cheaper install` installs NOTHING — no unattended full install', () => {
  const { home, out } = runCli(['install']);
  const entries = listHome(home);
  assert.deepStrictEqual(entries, [],
    'refusing to ask is not consent to install everything; nothing may be written\n' +
    entries.join('\n') + '\n---\n' + out);
});

test('the documented non-interactive paths still work: --all and explicit components', () => {
  const all = runCli(['install', '--all']);
  assert.strictEqual(all.status, 0, 'the TTY guard must not block --all\n' + all.out);
  for (const p of ['.claude/skills/adaptive-model-router', '.claude/agents/router-triage.md',
    '.claude/settings.json', '.cheaper/gateway']) {
    assert.ok(fs.existsSync(path.join(all.home, p)), `--all must still install ${p}\n` + all.out);
  }

  const one = runCli(['install', 'gateway']);
  assert.strictEqual(one.status, 0, one.out);
  assert.ok(fs.existsSync(path.join(one.home, '.cheaper', 'gateway')), one.out);
  assert.ok(!fs.existsSync(path.join(one.home, '.claude', 'skills')),
    'naming one component must still install only that one\n' + one.out);
});

// --------------------------------------------------------------------------
// 2. EXIT CODES FOR "ASKED FOR SOMETHING, DID NOTHING" (P3)
// --------------------------------------------------------------------------

test('an unknown --harness key exits non-zero', () => {
  const { status, out } = runCli(['install', '--harness', 'cursr']);
  assert.strictEqual(status, 1,
    'a provisioning script that typo\'d the harness key was told it succeeded\n' + out);
  assert.ok(out.includes('No adapter yet for harness "cursr"'), out);
});

test('a KNOWN --harness key does not trip the new failure exit', () => {
  const { status, out } = runCli(['install', '--harness', 'cursor']);
  assert.strictEqual(status, 0, 'the happy path must stay 0\n' + out);
});

test('component tokens that resolve to nothing exit non-zero', () => {
  const { home, status, out } = runCli(['install', 'skil']);      // typo
  assert.strictEqual(status, 1, out);
  assert.ok(out.includes('Nothing selected'), out);
  assert.deepStrictEqual(listHome(home), [], 'and nothing was installed\n' + out);
});

// --------------------------------------------------------------------------
// 3. THE INTERACTIVE PATH IS UNCHANGED (over-correction guard)
// --------------------------------------------------------------------------

test('with a real TTY the picker still runs and its answer is honoured', async () => {
  // The guard must gate on the TTY, not disable the picker. Force both streams to
  // look interactive and answer the prompt through readline, which util.js::ask()
  // constructs at call time.
  const readline = require('readline');
  const realCreate = readline.createInterface;
  let asked = null;
  readline.createInterface = () => ({
    question: (q, cb) => { asked = q; process.nextTick(() => cb('gateway')); },
    close: () => {},
  });
  const inTTY = process.stdin.isTTY, outTTY = process.stdout.isTTY;
  process.stdin.isTTY = true; process.stdout.isTTY = true;

  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  // node:test sets process.exitCode itself as soon as any test in this FILE fails, so
  // read it against a pinned baseline rather than against the runner's running state.
  const runnerCode = process.exitCode;
  process.exitCode = 0;
  let installCode;
  try {
    await require('../src/install').run([]);
    installCode = process.exitCode;
  } finally {
    console.log = origLog;
    readline.createInterface = realCreate;
    process.stdin.isTTY = inTTY; process.stdout.isTTY = outTTY;
    process.exitCode = runnerCode;
  }
  const out = strip(lines.join('\n'));

  assert.ok(asked !== null, 'a TTY must still be prompted — the guard is not an off switch');
  assert.ok(!out.includes('No components selected'), 'the non-TTY branch must not fire here\n' + out);
  assert.ok(out.includes('Gateway (proxy'), 'the numbered menu is still printed\n' + out);
  assert.ok(fs.existsSync(path.join(SANDBOX, '.cheaper', 'gateway')),
    'the typed answer must actually install\n' + out);
  assert.strictEqual(installCode, 0, 'a successful interactive install stays 0');
});

// --------------------------------------------------------------------------
// 3b. THE ARGUMENT THAT WAS BEING EATEN
// --------------------------------------------------------------------------

test('the FIRST argument survives: `install <component>` is not silently dropped', () => {
  // `rest = argv.filter((a, i) => i !== hIdx && i !== hIdx + 1)` with no --harness
  // present means hIdx === -1, so the second clause reads `i !== 0` and argv[0] was
  // discarded on every invocation. `install --all` lost --all; `install gateway`
  // lost gateway; `install gateway hook` installed only the hook. All three then hit
  // the interactive picker, whose Enter-default happens to equal --all — which is why
  // this survived interactively and only ever bit non-interactive callers.
  const two = runCli(['install', 'gateway', 'hook']);
  assert.strictEqual(two.status, 0, two.out);
  assert.ok(fs.existsSync(path.join(two.home, '.cheaper', 'gateway')),
    'the FIRST named component must be installed too\n' + two.out);
  assert.ok(fs.existsSync(path.join(two.home, '.claude', 'settings.json')),
    'the second named component must still be installed\n' + two.out);
  assert.ok(!fs.existsSync(path.join(two.home, '.claude', 'skills')),
    'and only the named ones\n' + two.out);
});

test('--harness is still stripped from the component tokens', () => {
  // The regression this filter existed to prevent: `install --harness codex` must not
  // read "codex" as a component name.
  const r = runCli(['install', 'gateway', '--harness', 'claude-code']);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(fs.existsSync(path.join(r.home, '.cheaper', 'gateway')), r.out);
  assert.ok(!/ignoring unrecognized: .*claude-code/.test(r.out),
    'the harness VALUE must never be parsed as a component\n' + r.out);
});

// --------------------------------------------------------------------------
// 4. THE FIX THAT WOULD HAVE BEEN WORSE
// --------------------------------------------------------------------------

test('util.js::ask stays a plain prompt — it must NOT invent an empty answer', () => {
  // Pinning the shape of the fix, not just its effect. If ask() is ever taught to
  // resolve('') when stdin closes, install.js:349 maps '' to DEFAULT_KEYS and every
  // non-interactive `cheaper install` becomes a silent FULL install — settings.json
  // rewritten, agents copied, a plugin registered, on a machine that never consented.
  // Every other ask() caller would inherit the same invented consent.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'util.js'), 'utf8');
  const fn = src.slice(src.indexOf('function ask('), src.indexOf('function ask(') + 400);
  assert.ok(/rl\.question\(question,/.test(fn), 'ask() should still just ask\n' + fn);
  assert.ok(!/on\(['"]close['"]/.test(fn),
    'a close-handler here would turn "no answer" into "the default"\n' + fn);
});

// --------------------------------------------------------------------------
// 5. THE AUTOSTART OFFER MUST NOT FOLLOW A FAILED GATEWAY INSTALL
// --------------------------------------------------------------------------
//
// install.js built its post-install notes from `results.map(r => r.key)`, which contains
// the ok:false rows too. So `chosen.includes('gateway')` stayed true when installGateway()
// threw, and the one-time offer at the very bottom of run() invited the user to register a
// login entry that would run `cheaper gateway serve` against a ~/.cheaper/gateway that was
// never written — a supervised, restarted, permanent crash loop, offered as the last thing
// a failed install says.
//
// The offer is counted rather than executed: offerOnce() is looked up through the module
// object at call time (`require('./autostart').offerOnce()`), so replacing the property on
// the cached module is enough, and no real login entry is ever registered by these tests.
function runInstallCountingOffers(args) {
  const autostart = require('../src/autostart');
  const realOffer = autostart.offerOnce;
  let offered = 0;
  autostart.offerOnce = async () => { offered += 1; };

  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  // node:test sets process.exitCode as soon as any test in this FILE fails, so read it
  // against a pinned baseline rather than against the runner's running state.
  const runnerCode = process.exitCode;
  process.exitCode = 0;
  return (async () => {
    let code;
    try {
      await require('../src/install').run(args);
      code = process.exitCode;
    } finally {
      console.log = origLog;
      autostart.offerOnce = realOffer;
      process.exitCode = runnerCode;
    }
    return { offered, code, out: strip(lines.join('\n')) };
  })();
}

test('a gateway that FAILED to install is never offered as a login entry', async () => {
  const P = require('../src/paths');
  // A real installGateway() failure, not a stub: copyDir() mkdirs GATEWAY_DIR, and mkdir
  // over an existing FILE is ENOTDIR/EEXIST. This is the shape of a ~/.cheaper left broken
  // by a half-finished earlier run.
  fs.rmSync(P.GATEWAY_DIR, { recursive: true, force: true });
  fs.mkdirSync(P.CHEAPER_DIR, { recursive: true });
  fs.writeFileSync(P.GATEWAY_DIR, 'not a directory');

  let r;
  try { r = await runInstallCountingOffers(['gateway']); }
  finally { fs.rmSync(P.GATEWAY_DIR, { recursive: true, force: true }); }

  assert.ok(/✗|gateway:/.test(r.out) || r.code === 1,
    'the precondition failed: installGateway() was supposed to throw here\n' + r.out);
  assert.strictEqual(r.code, 1, 'a failed component must still exit non-zero\n' + r.out);
  assert.strictEqual(r.offered, 0,
    'the autostart offer fired after a FAILED gateway install: the user was invited to ' +
    'register a login entry that runs `cheaper gateway serve` against a directory that ' +
    'does not exist, which launchd would then restart forever\n' + r.out);
});

test('a gateway that installed SUCCESSFULLY is still offered — the gate is not an off switch', async () => {
  const P = require('../src/paths');
  fs.rmSync(P.GATEWAY_DIR, { recursive: true, force: true });

  // `gateway cli`, not `gateway` alone: the offer now also requires the staged CLI at
  // ~/.cheaper/cli, because that is what a login entry is pointed at and enable()
  // refuses without it. Naming both is what a real install does — `cli` is in
  // DEFAULT_KEYS, so `--all` and a bare `install` both stage it.
  const r = await runInstallCountingOffers(['gateway', 'cli']);

  assert.strictEqual(r.code, 0, 'the happy path must stay 0\n' + r.out);
  assert.ok(fs.existsSync(path.join(P.GATEWAY_DIR, 'app')),
    'the precondition failed: the gateway did not install\n' + r.out);
  assert.ok(fs.existsSync(path.join(P.CLI_HOME, 'bin', 'cheaper.js')),
    'the precondition failed: the CLI was not staged\n' + r.out);
  assert.strictEqual(r.offered, 1,
    'gating the offer on success must not delete the offer\n' + r.out);
});

test('a gateway that installed but a MISSING staged CLI is not offered', async () => {
  const P = require('../src/paths');
  fs.rmSync(P.GATEWAY_DIR, { recursive: true, force: true });
  // The exact state a fresh machine was left in by every release up to 0.4.1, where
  // `cli` was not in DEFAULT_KEYS: gateway on disk, ~/.cheaper/cli absent. Answering
  // `y` to the offer printed `✗ nothing to autostart` and burned the one-time answer.
  fs.rmSync(P.CLI_HOME, { recursive: true, force: true });

  const r = await runInstallCountingOffers(['gateway']);

  assert.strictEqual(r.code, 0, 'the happy path must stay 0\n' + r.out);
  assert.ok(fs.existsSync(path.join(P.GATEWAY_DIR, 'app')),
    'the precondition failed: the gateway did not install\n' + r.out);
  assert.strictEqual(r.offered, 0,
    'the autostart offer fired with no staged CLI: the user was asked a once-per-machine ' +
    'question whose only possible outcome is `nothing to autostart`\n' + r.out);
});

// --------------------------------------------------------------------------
// 6. UNINSTALL: A DEREGISTRATION THAT FAILED MUST NOT READ AS DONE
// --------------------------------------------------------------------------
//
// These drive uninstall.js's real code with autostart.js's disable() replaced by a stub,
// restored in a finally. No launchctl/systemctl/schtasks is invoked and no real entry is
// touched; only the sandbox HOME above is written to.
function withStubbedAutostart(stub, fn) {
  const autostart = require('../src/autostart');
  const saved = {};
  for (const k of Object.keys(stub)) saved[k] = autostart[k];
  Object.assign(autostart, stub);
  try { return fn(); } finally { Object.assign(autostart, saved); }
}

const FAILED_DISABLE = {
  isRegisteredOnDisk: () => true,
  disable: () => ({
    ok: false, state: 'registered',
    msg: 'autostart -> NOT confirmed removed (launchd still lists it)',
  }),
};

// Plant the two things the login entry actually points at: ProgramArguments[1] is
// ~/.cheaper/cli/bin/cheaper.js and it serves out of ~/.cheaper/gateway.
function plantSupervisedFiles(P) {
  fs.mkdirSync(P.GATEWAY_DIR, { recursive: true });
  fs.writeFileSync(path.join(P.GATEWAY_DIR, 'marker'), 'x');
  fs.mkdirSync(path.join(P.CLI_HOME, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(P.CLI_HOME, 'bin', 'cheaper.js'), '#!/usr/bin/env node\n');
}

test('the pre-deregistration row reports disable()\'s REAL ok, not a hardcoded true', () => {
  const P = require('../src/paths');
  plantSupervisedFiles(P);

  const results = withStubbedAutostart(FAILED_DISABLE,
    () => require('../src/uninstall').uninstall({ components: ['gateway'] }));

  const row = results.find((r) => r.key === 'autostart');
  assert.ok(row, JSON.stringify(results, null, 2));
  assert.match(row.msg, /NOT confirmed removed/, row.msg);
  assert.strictEqual(row.ok, false,
    'a literal `ok: true` printed a green ✓ against the words "NOT confirmed removed", and ' +
    'run()\'s `results.some(r => !r.ok)` therefore saw nothing and exited 0 while the ' +
    'supervisor was still registered\n' + JSON.stringify(results, null, 2));
  assert.ok(results.some((r) => !r.ok),
    'this is the value run() turns into the non-zero exit code a script can read');
});

test('a plain `cheaper uninstall` ABORTS gateway + cli when the entry will not deregister', () => {
  const P = require('../src/paths');
  plantSupervisedFiles(P);

  const results = withStubbedAutostart(FAILED_DISABLE,
    () => require('../src/uninstall').uninstall({}));

  const by = (k) => results.find((r) => r.key === k);
  assert.ok(by('autostart') && by('autostart').ok === false,
    'the autostart row must be red first\n' + JSON.stringify(results, null, 2));
  for (const k of ['gateway', 'cli']) {
    assert.ok(by(k) && by(k).ok === false,
      `${k} must be refused, not removed\n` + JSON.stringify(results, null, 2));
    assert.match(by(k).msg, /Deregister it first/, by(k).msg);
    assert.match(by(k).msg, /cheaper autostart disable/,
      'the refusal must name the command that clears the entry\n' + by(k).msg);
  }
  assert.ok(fs.existsSync(path.join(P.GATEWAY_DIR, 'marker')),
    '~/.cheaper/gateway was deleted while a LaunchAgent still pointed at it — the entry now ' +
    'retries a deleted binary at every login\n' + JSON.stringify(results, null, 2));
  assert.ok(fs.existsSync(path.join(P.CLI_HOME, 'bin', 'cheaper.js')),
    'ProgramArguments[1] of the still-registered plist was deleted, so there is no `cheaper` ' +
    'command left on the machine to disable it\n' + JSON.stringify(results, null, 2));
  // Unrelated components are NOT held hostage: nothing supervises the hook.
  assert.ok(by('hook') && by('hook').ok, JSON.stringify(results, null, 2));
});

test('once disable() SUCCEEDS the same uninstall removes gateway + cli as before', () => {
  const P = require('../src/paths');
  plantSupervisedFiles(P);

  const results = withStubbedAutostart({
    isRegisteredOnDisk: () => true,
    disable: () => ({ ok: true, state: 'absent', msg: 'autostart -> deregistered' }),
  }, () => require('../src/uninstall').uninstall({}));

  assert.ok(!fs.existsSync(P.GATEWAY_DIR),
    'the abort must be conditional on the failure, not a permanent refusal\n' +
    JSON.stringify(results, null, 2));
  const gw = results.find((r) => r.key === 'gateway');
  assert.ok(gw && gw.ok, JSON.stringify(results, null, 2));
});

// --------------------------------------------------------------------------
// 6b. --purge MUST NOT CLAIM A DIRECTORY IT DID NOT DELETE
// --------------------------------------------------------------------------
//
// util.js::removePath swallows every error by contract (`try { fs.rmSync(…) } catch {}`),
// so uninstall.js's purge row cannot learn anything from calling it. The failure that was
// reproduced: ~/.cheaper survives (permissions, an open handle, a locked file), the row
// still prints "✓ removed ~/.cheaper (incl. metrics.db)", run()'s
// `results.some(r => !r.ok)` sees nothing, and the command exits 0 — a provisioning
// script is told the machine was wiped while metrics.db is still sitting there.
//
// The undeletable directory is produced by making fs.rmSync fail for exactly that ONE
// path. removePath closes over the same `fs` module object this file requires, so this is
// the real code path with a real error — and it needs no chmod, no root check and no
// platform carve-out, unlike a permissions-based setup which is a no-op on Windows and
// bypassed when the suite runs as root.
function withUnremovable(targetPath, fn) {
  const realRm = fs.rmSync;
  fs.rmSync = (p, opts) => {
    if (path.resolve(p) === path.resolve(targetPath)) {
      const e = new Error(`EACCES: permission denied, rmdir '${p}'`);
      e.code = 'EACCES';
      throw e;
    }
    return realRm(p, opts);
  };
  try { return fn(); } finally { fs.rmSync = realRm; }
}

test('--purge reports ok:false and names the survivor when ~/.cheaper is still there', () => {
  const P = require('../src/paths');
  fs.mkdirSync(P.CHEAPER_DIR, { recursive: true });
  fs.writeFileSync(path.join(P.CHEAPER_DIR, 'metrics.db'), 'x');

  const results = withUnremovable(P.CHEAPER_DIR, () => withStubbedAutostart({
    isRegisteredOnDisk: () => false,
  }, () => require('../src/uninstall').uninstall({ components: ['hook'], purge: true })));

  const row = results.find((r) => r.key === 'purge');
  assert.ok(row, JSON.stringify(results, null, 2));
  // Precondition: the directory really did survive the purge.
  assert.ok(fs.existsSync(P.CHEAPER_DIR),
    'the precondition failed: ~/.cheaper was removed, so there is nothing to mis-report');

  assert.strictEqual(row.ok, false,
    'a literal `ok: true` printed "✓ removed ' + P.CHEAPER_DIR + '" for a directory that is ' +
    'still on disk, and run()\'s `results.some(r => !r.ok)` therefore exited 0 on a machine ' +
    'that was never purged\n' + JSON.stringify(results, null, 2));
  assert.ok(!/^removed /.test(row.msg),
    'the message must not open by claiming the removal happened\n' + row.msg);
  assert.match(row.msg, /could NOT remove/, row.msg);
  assert.match(row.msg, /metrics\.db/,
    'the row must name what actually survived, not just that something did\n' + row.msg);
  assert.ok(row.msg.includes(P.CHEAPER_DIR),
    'and the path the reader has to deal with\n' + row.msg);
  assert.match(row.msg, /rm -rf|rmdir \/s/,
    'a failure the user cannot act on is only half reported\n' + row.msg);
  assert.ok(results.some((r) => !r.ok),
    'this is the value run() turns into the non-zero exit code a script can read');

  fs.rmSync(P.CHEAPER_DIR, { recursive: true, force: true });
});

test('--purge still reports ok:true when ~/.cheaper is genuinely gone', () => {
  const P = require('../src/paths');
  fs.mkdirSync(P.CHEAPER_DIR, { recursive: true });
  fs.writeFileSync(path.join(P.CHEAPER_DIR, 'metrics.db'), 'x');

  const results = withStubbedAutostart({ isRegisteredOnDisk: () => false },
    () => require('../src/uninstall').uninstall({ components: ['hook'], purge: true }));

  const row = results.find((r) => r.key === 'purge');
  assert.ok(!fs.existsSync(P.CHEAPER_DIR),
    'the precondition failed: the purge did not delete ~/.cheaper\n' + JSON.stringify(results, null, 2));
  assert.strictEqual(row.ok, true,
    'the verification must not turn a successful purge red — that would train readers to ' +
    'ignore the row\n' + JSON.stringify(results, null, 2));
  assert.match(row.msg, /removed /, row.msg);
});

// --------------------------------------------------------------------------
// 7. ONE COPY OF THE DON'T-SIGNAL-THE-WRONG-PROCESS GATE
// --------------------------------------------------------------------------

test('uninstall.js uses gateway.js\'s pidLooksLikeGateway instead of a second copy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'uninstall.js'), 'utf8');
  assert.ok(!/spawnSync\('ps'|spawnSync\('tasklist'/.test(src),
    'two copies of a gate that decides whether to SIGTERM a pid drift: only one of them ' +
    'got the win32 fix for tasklist exiting 0 on "no tasks match"\n');
  assert.match(src, /require\('\.\/gateway'\)\.pidLooksLikeGateway/,
    'the surviving copy must be the exported one in gateway.js');

  // And it must still answer false for a pid that is not ours, which is what keeps
  // stopGatewayIfRunning from signalling a stale pid's new owner.
  const { pidLooksLikeGateway } = require('../src/gateway');
  assert.strictEqual(pidLooksLikeGateway(1), false, 'pid 1 is init, never our uvicorn');
});

test.after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

// ===========================================================================
// AN INSTALL THAT ENDED BY RECOMMENDING A COMMAND IT HAD NOT INSTALLED.
//
// On a fresh machine, `npx cheaper install` printed nothing but green ticks and then:
//
//     $ cheaper gateway start
//     zsh: command not found: cheaper
//
// The `cli` component — the one that puts a `cheaper` launcher on PATH — was opt-in, so the
// summary named a binary the default run had just declined to provide. The visible half was
// the failed command; the invisible half is that tagline_install.js writes the literal
// `cheaper peek --tagline …` into every harness's instructions file, so a run reporting
// "✓ tagline wired" for five harnesses had wired five instructions that could never execute,
// and nothing would ever have said so.
// ===========================================================================

const { DEFAULT_KEYS: DK, cheaperInvocation } = require('../src/install');

test('the default install provides the `cheaper` command everything else depends on', () => {
  assert.ok(DK.includes('cli'),
    'the `cli` launcher is not in the default set, so a plain `cheaper install` again ends '
    + 'by recommending `cheaper gateway start` and wiring taglines that invoke `cheaper` by '
    + 'name — none of which can run');
  // The line that must NOT come back: a hard-coded invocation in the closing notes.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'install.js'), 'utf8');
  assert.ok(!/\+ 'cheaper gateway start'/.test(src),
    'the notes hard-code `cheaper gateway start` again instead of printing what actually '
    + 'resolves on this machine');
  // …and autostart must still NOT be there. A launcher is a file on PATH; a login daemon is
  // a process that outlives the terminal, and they do not deserve the same gate.
  assert.ok(!DK.includes('autostart'),
    'a bare `cheaper install` would now register a login daemon');
});

test('the closing notes name a command that actually resolves, in all three PATH states', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-path-'));
  const prevHome = process.env.HOME, prevPath = process.env.PATH;
  try {
    // 1. Nothing anywhere: npx is the only thing that works this second, and it says so.
    //
    // PATH keeps the system directories on purpose. whichSync() shells out to `which`, so a
    // PATH stripped to nothing makes `which` ITSELF unfindable and every branch below would
    // then pass because the locator crashed rather than because `cheaper` was absent — a
    // test green for a reason it was not written for.
    process.env.HOME = home;
    const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
    process.env.PATH = SYSTEM_PATH;
    let inv = cheaperInvocation();
    assert.strictEqual(inv.cmd, 'npx cheaper',
      `with no launcher and no PATH entry the notes must use npx, got ${inv.cmd}`);
    assert.match(inv.note, /npx cheaper install cli/,
      'it does not say how to stop needing npx');
    assert.match(inv.note, /taglines/i,
      'it does not warn that the taglines it just wired cannot run either — the silent half '
      + 'of this bug');

    // 2. Launcher on disk but its directory is not on PATH. Reinstalling would change
    //    nothing, so the remedy must be the PATH line, not another install.
    const binDir = path.join(home, '.local', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    // 0o755 deliberately: whichSync only accepts an EXECUTABLE file, which is the same
    // reason a non-executable launcher would not resolve for the user either.
    fs.writeFileSync(path.join(binDir, 'cheaper'), '#!/bin/sh\n');
    fs.chmodSync(path.join(binDir, 'cheaper'), 0o755);
    inv = cheaperInvocation();
    assert.strictEqual(inv.cmd, path.join(binDir, 'cheaper'),
      'with the launcher present but unresolvable, the notes must use its full path so the '
      + 'commands work as printed');
    assert.match(inv.note, /export PATH=/,
      'the remedy for "installed but not on PATH" must be the PATH line');
    assert.ok(!/install cli/.test(inv.note),
      'it tells the user to reinstall a launcher that is already on disk');

    // 3. Resolvable: say nothing. A warning that fires when nothing is wrong is a warning
    //    people learn to skip.
    process.env.PATH = binDir + path.delimiter + SYSTEM_PATH;
    inv = cheaperInvocation();
    assert.strictEqual(inv.cmd, 'cheaper');
    assert.strictEqual(inv.note, null,
      'a working PATH still printed a warning');
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
