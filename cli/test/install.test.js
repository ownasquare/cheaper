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

test.after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });
