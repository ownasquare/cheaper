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

test('an alias list is shared by all four of its commands', () => {
  for (const cmd of ['dashboard', 'reports', 'logs', 'monitor']) {
    const r = run([cmd, '--help']);
    assert.ok(r.out.includes('Open the live localhost dashboard'), cmd + '\n' + r.out);
  }
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
