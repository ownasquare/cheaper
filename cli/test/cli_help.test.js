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

// ---------------------------------------------------------------------------
// The expected surface is PARSED OUT OF `cheaper --help`, never listed by hand.
// ---------------------------------------------------------------------------
//
// This list used to be a literal array, and that is precisely how the largest addition
// this CLI has ever taken slipped past the gate whose only job is to catch it: the
// `autostart` command plus `gateway serve`, `gateway prepare` and `--port` were added to
// HELP and to bin/cheaper.js's dispatch, the hardcoded array did not mention them, and
// the README-sync test below happily iterated the array and stayed green while README.md
// contained zero occurrences of any of the four.
//
// A gate that has to be updated by the same commit it is supposed to police is not a
// gate. So the parser below mirrors bin/cheaper.js's own `namesOf` (cheaper.js:120-124)
// against the same text: an entry starts at exactly 4 spaces, its head is everything
// before the first run of 2+ spaces, a head containing `|` is an alias list where every
// branch names a command, and otherwise only the first token is the command name. Add a
// command to HELP without documenting it and this file fails, with no edit here.
function parseHelpEntries(help) {
  const lines = help.split('\n');
  const from = lines.findIndex((l) => l.includes('Commands'));
  assert.notStrictEqual(from, -1, 'no Commands block in `cheaper --help`');
  let to = lines.findIndex((l, i) => i > from && l.includes('Quickstart'));
  if (to === -1) to = lines.length;

  const entries = [];
  for (const line of lines.slice(from + 1, to)) {
    if (/^ {4}\S/.test(line)) {
      const head = line.slice(4).split(/ {2,}/)[0].trim();
      const toks = head.split(/[\s|,]+/).filter(Boolean).map((t) => t.toLowerCase());
      entries.push({
        head,
        names: head.includes('|') ? toks : toks.slice(0, 1),
        body: [line],
      });
    } else if (/^ {5,}\S/.test(line) && entries.length) {
      entries[entries.length - 1].body.push(line);
    }
  }
  assert.ok(entries.length > 5, 'the HELP parser found almost nothing — it has drifted from bin/cheaper.js');
  return entries;
}

const ENTRIES = parseHelpEntries(FULL);

// Every command bin/cheaper.js dispatches on that has its own entry in HELP.
const DOCUMENTED = [...new Set(ENTRIES.flatMap((e) => e.names))];

// Two-word heads like `gateway serve` / `autostart enable` are the SUBCOMMAND surface.
// They are the part the old hardcoded list could not see at all: `gateway` was in the
// array, so adding `gateway serve` and `gateway prepare` changed nothing the gate looked
// at. `wantsPort` is derived too — an entry whose own text offers `--port` is an entry
// whose README row has to say so, because for `serve` and `autostart enable` the port is
// baked into a supervisor entry the user will never open.
const SUBCOMMANDS = ENTRIES
  .filter((e) => /^[a-z][a-z-]* [a-z][a-z-]*$/.test(e.head))
  .map((e) => ({ phrase: e.head, wantsPort: e.body.join('\n').includes('--port') }));

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
// Commands section, or the two are free to drift again exactly as they did before.
//
// The expected set comes from parseHelpEntries(), not from a list maintained here. When
// it WAS a list, `autostart`, `gateway serve`, `gateway prepare` and `--port` were all
// added to HELP while README.md contained zero occurrences of any of them, and this test
// passed anyway — it was iterating the stale array, so it was asserting nothing about the
// new surface at all.
//
// PROVED BY MUTATION: adding a command to HELP in bin/cheaper.js without a README row
// (e.g. an entry named `wombat`) fails this test naming `wombat`; deleting any existing
// row (e.g. `dashboard`, `taglines`, `autostart status`) fails it naming that one.
function readmeCommandsSection() {
  const readmePath = path.join(__dirname, '..', '..', 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  const start = readme.indexOf('\n## Commands');
  assert.ok(start !== -1, 'README has no ## Commands section');
  const next = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, next === -1 ? readme.length : next);
}

test('README\'s Commands section documents every command in HELP', () => {
  const section = readmeCommandsSection();
  for (const cmd of DOCUMENTED) {
    assert.ok(section.includes('`' + cmd),
      `README's Commands section is missing `+ '`' + cmd + '`'
      + ' — sync it with HELP in bin/cheaper.js');
  }
});

// The half the hardcoded array structurally could not check. `gateway` being documented
// says nothing about `gateway serve`, and `serve` is the entry a supervisor is pointed at:
// undocumented, the only way to find it is to read bin/cheaper.js.
test('README\'s Commands section documents every SUBCOMMAND in HELP, with its --port', () => {
  const section = readmeCommandsSection();
  assert.ok(SUBCOMMANDS.length >= 8,
    'expected the gateway/autostart subcommand surface to be parsed out of HELP; got '
    + JSON.stringify(SUBCOMMANDS.map((s) => s.phrase)));
  for (const { phrase, wantsPort } of SUBCOMMANDS) {
    const rows = section.split('\n').filter((l) => l.includes('`' + phrase));
    assert.ok(rows.length,
      `README's Commands section never mentions \`${phrase}\` — sync it with HELP in bin/cheaper.js`);
    // A --port that HELP offers but the README never shows is how a user ends up with a
    // login entry baked to the wrong port and no idea the flag existed.
    if (wantsPort)
      assert.ok(rows.some((l) => l.includes('--port')),
        `HELP offers \`--port\` on \`${phrase}\` but no README row for it mentions --port:\n`
        + rows.join('\n'));
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

// This used to assert start|stop|status and nothing more, which had stopped being true:
// `gateway serve` and `gateway prepare` were added right below them and the assertion
// still passed, because listing three of five entries proves nothing about the other two.
// The expected phrases are parsed out of HELP, so a sixth gateway entry is covered the
// day it is added.
//
// The negative half matters more than it looks: the `autostart` entries sit IMMEDIATELY
// after the gateway ones in HELP, so an off-by-one in commandHelp()'s capture logic would
// drag a login-daemon registration command into the output of `gateway --help`.
test('`gateway --help` collects every gateway entry HELP has, and nothing else', () => {
  const expected = ENTRIES.filter((e) => e.names[0] === 'gateway').map((e) => e.head);
  // The literal is deliberate HERE and only here: parseHelpEntries() is a copy of
  // commandHelp()'s rules, so comparing one against the other alone would be tautological
  // — a shared parsing bug would hide from both. One independent statement of the truth
  // makes a silent change to the gateway surface impossible.
  assert.deepStrictEqual(expected,
    ['gateway start', 'gateway stop', 'gateway restart', 'gateway status', 'gateway serve',
     'gateway prepare'],
    'the gateway surface in HELP changed — update the README rows and this expectation together');
  const r = run(['gateway', '--help']);
  for (const s of expected) assert.ok(r.out.includes(s), `\`gateway --help\` dropped "${s}"\n` + r.out);
  assert.ok(!r.out.includes('Install components'), 'no neighbouring entry may leak in\n' + r.out);
  assert.ok(!r.out.includes('autostart enable'),
    'the autostart entries follow gateway\'s in HELP and must NOT be collected here\n' + r.out);
});

// `autostart` is a TOP-LEVEL command, not a `gateway` subcommand (bin/cheaper.js:162-167),
// so its three entries must collect on their own and must not pull the gateway ones in
// with them — they are adjacent in HELP and share the word "gateway" in their prose.
test('`autostart --help` collects its own three entries and none of gateway\'s', () => {
  const expected = ENTRIES.filter((e) => e.names[0] === 'autostart').map((e) => e.head);
  assert.deepStrictEqual(expected, ['autostart enable', 'autostart disable', 'autostart status']);
  const r = run(['autostart', '--help']);
  assert.strictEqual(r.status, 0, r.out);
  for (const s of expected) assert.ok(r.out.includes(s), `\`autostart --help\` dropped "${s}"\n` + r.out);
  assert.ok(!r.out.includes('Start the routing gateway'),
    'the gateway entries precede autostart\'s in HELP and must not leak in\n' + r.out);
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
