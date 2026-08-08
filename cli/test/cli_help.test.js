'use strict';
// bin/cheaper.js: `cheaper <command> --help`.
//
// Only a BARE top-level help/-h/--help was ever intercepted. Appending --help to a
// subcommand fell straight through to that subcommand, which at best ignored it and
// at worst acted on it: `cheaper install --help` dropped into the interactive
// component picker and sat there waiting for a keystroke — the most reflexive way to
// ask a CLI what a command does was the one way to make it hang.
//
// The per-command text is SLICED OUT of the same HELP string `cheaper --help` prints,
// never duplicated, so the two can never disagree. These tests pin that property as
// well as the behaviour.

const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'cheaper.js');
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// EVERY invocation runs against a sandbox HOME, and that is a SAFETY requirement, not
// tidiness. The whole point of this file is that `--help` must be answered BEFORE the
// subcommand is dispatched — so the moment the interception regresses, these very
// invocations become real ones. `cheaper uninstall --help` would delete the
// developer's installed components; `cheaper compact --help` would rewrite their event
// store; `cheaper peek --help` would walk every transcript on the machine. A test that
// can destroy the thing it is testing on failure is not a test.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-help-test-'));
const CHILD_ENV = Object.assign({}, process.env, {
  HOME: SANDBOX,
  USERPROFILE: SANDBOX,
  CLAUDE_CONFIG_DIR: path.join(SANDBOX, '.claude'),
});

function run(args) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000, env: CHILD_ENV,
  });
  return { status: r.status, out: strip((r.stdout || '') + (r.stderr || '')) };
}

const FULL = run(['--help']).out;

// Every command bin/cheaper.js dispatches on that has its own entry in HELP.
const DOCUMENTED = ['install', 'uninstall', 'gateway', 'dashboard', 'reports', 'logs',
  'monitor', 'savings', 'export', 'import', 'forget', 'compact', 'peek', 'taglines',
  'status', 'version'];

test('every documented command answers --help, and answers it FAST', () => {
  for (const cmd of DOCUMENTED) {
    const r = run([cmd, '--help']);
    assert.strictEqual(r.status, 0, `\`cheaper ${cmd} --help\` should exit 0\n` + r.out);
    assert.ok(r.out.includes('cheaper ' + cmd), `expected a heading for ${cmd}\n` + r.out);
    // A timeout would show up as status null; assert explicitly so a future
    // re-introduction of the hang is unmistakable rather than merely slow.
    assert.notStrictEqual(r.status, null, `\`cheaper ${cmd} --help\` hung\n` + r.out);
  }
});

test('`cheaper install --help` prints install\'s section — it does NOT open the picker', () => {
  const r = run(['install', '--help']);
  assert.ok(r.out.includes('Install components into your Claude environment'), r.out);
  // The picker's own prompt. Its presence means we dispatched into install.run().
  assert.ok(!r.out.includes('Choose components'),
    '--help must be intercepted BEFORE the subcommand runs\n' + r.out);
  assert.ok(!r.out.includes('Cheaper installer'), r.out);
});

test('-h works too', () => {
  assert.strictEqual(run(['gateway', '-h']).out, run(['gateway', '--help']).out);
});

test('a multi-line entry keeps all of its continuation lines', () => {
  const r = run(['peek', '--help']);
  assert.ok(r.out.includes('--tagline'), 'continuation lines belong to the entry\n' + r.out);
  assert.ok(r.out.includes('--transcript <file>'), r.out);
  assert.ok(!r.out.includes('taglines [options]'),
    'and the NEXT entry must not bleed in\n' + r.out);
});

test('an alias list is shared by reports/logs/monitor; dashboard has its own entry', () => {
  for (const cmd of ['reports', 'logs', 'monitor']) {
    const r = run([cmd, '--help']);
    assert.ok(r.out.includes('Open that tab of the same localhost dashboard'), cmd + '\n' + r.out);
  }
  const d = run(['dashboard', '--help']);
  assert.ok(d.out.includes('Open the live localhost dashboard in your browser'), d.out);
  // dashboard must NOT pull in the alias group's text (it is a separate entry now —
  // it used to be grouped with reports/logs/monitor even though it does not share
  // their behaviour, see the next two tests).
  assert.ok(!d.out.includes('Open that tab of the same localhost dashboard'), d.out);
});

// `dashboard` was documented as if it shared `--terminal` support with reports/logs/
// monitor. It never did: dashboard.js's parseArgs recognised only --json, so
// `dashboard --terminal` silently opened the browser instead of doing what the other
// three do. HELP must not claim a capability the command does not have.
test('HELP does not claim --terminal support for dashboard, but does for its siblings', () => {
  const d = run(['dashboard', '--help']).out;
  assert.ok(d.includes('No --terminal view yet'), d);
  assert.ok(!/--terminal\s+render the same view/.test(d),
    'dashboard\'s entry must not promise a terminal renderer it does not have\n' + d);
  for (const cmd of ['reports', 'logs', 'monitor']) {
    const r = run([cmd, '--help']).out;
    assert.ok(/--terminal\s+render the same view in the terminal/.test(r), cmd + '\n' + r);
  }
});

// Regression for the SILENT no-op: before this fix, dispatch never routed
// `dashboard --terminal`/`--tty` to dashboard.js at all, so it fell through to the
// same branch as a bare `cheaper dashboard` — starting the gateway (filesystem
// writes under ~/.cheaper, up to a 15s health-check wait) and opening a real browser,
// with no indication the flag did anything different from omitting it.
//
// PROVED BY MUTATION: reverting bin/cheaper.js's `dashboard` case to
// `if (rest.includes('--json'))` (dropping the --terminal/--tty arms) makes this test
// fail — it starts routing through launch.js again, which writes into SANDBOX and
// answers something other than the honest "no --terminal view yet" text below.
test('`cheaper dashboard --terminal` answers honestly instead of silently opening the browser', () => {
  const r = run(['dashboard', '--terminal']);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(r.out.includes('no --terminal view yet'), r.out);
  assert.ok(r.out.toLowerCase().includes('--json'), r.out);
  assert.deepStrictEqual(fs.readdirSync(SANDBOX), [],
    'dashboard --terminal must not fall through to launch.js starting the gateway');
});

test('`cheaper dashboard --tty` behaves the same as --terminal', () => {
  assert.strictEqual(run(['dashboard', '--tty']).out, run(['dashboard', '--terminal']).out);
});

// Regression for "README documents only a fraction of the implemented commands" —
// every command HELP declares must have its own backtick-quoted entry in the README's
// Commands table, or the two are free to drift again exactly as they did before.
//
// PROVED BY MUTATION: deleting any one row from the README table (e.g. the `dashboard`
// or `taglines` row) makes this test fail with that command's name.
test('README\'s Commands table documents every command in HELP', () => {
  const readmePath = path.join(__dirname, '..', '..', 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  const start = readme.indexOf('\n## Commands');
  assert.ok(start !== -1, 'README has no ## Commands section');
  const next = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, next === -1 ? readme.length : next);
  const CANONICAL = DOCUMENTED.concat(['help']);
  for (const cmd of CANONICAL) {
    assert.ok(section.includes('`' + cmd),
      `README's Commands table is missing `+ '`' + cmd + '`'
      + ' — sync it with HELP in bin/cheaper.js');
  }
});

// Regression for "peek reads 7 harnesses and taglines writes into 7, and the README
// implied it was THE SAME 7" — it is not: peek can read Claude Code's history but
// taglines does not write Claude Code's line (the plugin does that instead), and
// taglines writes Cursor's line even though peek cannot read Cursor's history yet.
// If either source list ever changes shape, this catches the README claim going stale
// right alongside it, instead of only the day someone happens to reread the prose.
//
// PROVED BY MUTATION: adding or removing an entry in either ADAPTERS (adapters.js) or
// TAGLINE_TARGETS (tagline_install.js) — or moving 'cursor'/'claude-code' across the
// two lists — flips one of the assertions below.
test('peek\'s 7 readable harnesses and taglines\' 7 writable harnesses differ by exactly Claude Code / Cursor', () => {
  const adaptersSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'peek', 'adapters.js'), 'utf8');
  const taglineSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'tagline_install.js'), 'utf8');

  // Every ADAPTERS entry lives on one line: `{ key: 'x', ..., status: 'y', ... }`.
  const adapterLines = adaptersSrc.split('\n')
    .filter((l) => /key:\s*'[^']+'/.test(l) && /status:\s*'[^']+'/.test(l));
  const keyOf = (l) => l.match(/key:\s*'([^']+)'/)[1];
  const peekKeys = adapterLines.map(keyOf);
  const peekReadable = adapterLines.filter((l) => !/status:\s*'sqlite'/.test(l)).map(keyOf);

  // TAGLINE_TARGETS entries are similarly one per line: `{ key: 'x', label: ..., ... }`.
  // (Later in the file `key: t.key` appears unquoted — the quoted-value regex below
  // only matches the table's own entries, not those references.)
  const taglineKeys = (taglineSrc.match(/key:\s*'[^']+'/g) || [])
    .map((s) => s.match(/'([^']+)'/)[1]);

  assert.strictEqual(peekKeys.length, 8,
    `peek's ADAPTERS list changed size — README says "detects 8 harnesses": ${peekKeys.join(',')}`);
  assert.strictEqual(peekReadable.length, 7,
    `peek's readable-harness count changed — README says "reads chat history for 7": ${peekReadable.join(',')}`);
  assert.strictEqual(taglineKeys.length, 7,
    `taglines' harness count changed — README/HELP both say 7: ${taglineKeys.join(',')}`);

  const peekOnly = peekReadable.filter((k) => !taglineKeys.includes(k));
  const taglineOnly = taglineKeys.filter((k) => !peekReadable.includes(k));
  assert.deepStrictEqual(peekOnly, ['claude-code'],
    'README claims Claude Code is peek-readable but not taglines-writable (the plugin '
    + 'handles its end-of-chat line instead)\n' + peekReadable.join(',') + ' vs ' + taglineKeys.join(','));
  assert.deepStrictEqual(taglineOnly, ['cursor'],
    'README claims Cursor is taglines-writable but not peek-readable (peek has no '
    + 'SQLite reader yet)\n' + peekReadable.join(',') + ' vs ' + taglineKeys.join(','));
});

test('`gateway --help` collects all three gateway entries, and nothing else', () => {
  const r = run(['gateway', '--help']);
  for (const s of ['gateway start', 'gateway stop', 'gateway status']) assert.ok(r.out.includes(s), r.out);
  assert.ok(!r.out.includes('Install components'), 'no neighbouring entry may leak in\n' + r.out);
});

test('`status --help` does not also drag in the `gateway status` entry', () => {
  // Only the FIRST token of a non-aliased entry names a command; `gateway status`
  // declares `gateway`, not `status`.
  const r = run(['status', '--help']);
  assert.ok(r.out.includes("Show what's installed and running"), r.out);
  assert.ok(!r.out.includes('Is the gateway running?'), r.out);
});

test('an unknown command with --help falls back to the FULL help, never to nothing', () => {
  const r = run(['bananas', '--help']);
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('Quickstart'), r.out);
});

test('the per-command text is a literal SLICE of the full help — it cannot drift', () => {
  for (const cmd of DOCUMENTED) {
    const body = run([cmd, '--help']).out
      .split('\n')
      .filter((l) => /^ {4,}\S/.test(l));
    assert.ok(body.length, cmd + ' produced no body');
    for (const line of body)
      assert.ok(FULL.includes(line),
        `\`cheaper ${cmd} --help\` invented a line that \`cheaper --help\` does not have:\n` + line);
  }
});

// --- over-correction guards ------------------------------------------------

test('the interception is narrow: a bare command still runs', () => {
  assert.strictEqual(run(['version']).out.trim(), run(['--version']).out.trim());
  assert.ok(run(['version']).out.includes('cheaper '));
});

test('a subcommand flag that merely CONTAINS help is not intercepted', () => {
  // `--helpful` is not `--help`; only exact matches may short-circuit dispatch.
  const r = run(['gateway', '--helpful']);
  assert.ok(r.out.includes('Unknown gateway subcommand') || r.out.includes('usage: cheaper gateway'),
    'this must still reach gateway.run()\n' + r.out);
});

test('an unknown top-level command (no --help) still exits non-zero', () => {
  const r = run(['bananas']);
  assert.strictEqual(r.status, 1, r.out);
  assert.ok(r.out.includes('Unknown command: bananas'), r.out);
});

// --- P3: gateway subcommand exit codes, end to end -------------------------

test('`cheaper gateway <bad>` exits non-zero end-to-end', () => {
  const r = run(['gateway', 'statsu']);
  assert.strictEqual(r.status, 1,
    'printing usage and exiting 0 told every caller the typo worked\n' + r.out);
  assert.ok(r.out.includes('usage: cheaper gateway'), r.out);
});

test('`cheaper gateway` with no subcommand exits non-zero', () => {
  const r = run(['gateway']);
  assert.strictEqual(r.status, 1, r.out);
});

test('`cheaper gateway status` still exits 0', () => {
  assert.strictEqual(run(['gateway', 'status']).status, 0);
});

test('asking for help never touches the filesystem', () => {
  // The positive form of the sandbox rationale above: a help request is a read of a
  // string constant and must have no side effects at all.
  for (const cmd of DOCUMENTED) run([cmd, '--help']);
  assert.deepStrictEqual(fs.readdirSync(SANDBOX), [],
    'a --help invocation created files in HOME — it reached the subcommand');
});

test.after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });
