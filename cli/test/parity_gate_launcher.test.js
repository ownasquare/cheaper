'use strict';
// ONE Python launcher, shared by EVERY gate in scripts/ — the cross-script invariant.
//
// `test/period_parity_gate.test.js` holds this property for check-period-parity.js alone.
// That was not enough, and the gap was live: `sync-prices.js` — the FIRST command in
// `npm test` — still called `execFileSync('python3', …)` with a literal interpreter name
// long after the other two gates had been migrated to the shared `pyExe()`. On a stock
// python.org Windows install with "Add python.exe to PATH" left unchecked (the DEFAULT),
// `python3` resolves only to the Microsoft Store alias stub, so that call threw ENOENT on a
// machine with a perfectly good Python 3 — and because it runs first, it blocked the whole
// suite before any other gate got a chance to run.
//
// One behaviour, three implementations, free to drift, is the exact defect class the parity
// gates exist to catch. These tests apply the invariant to every file in scripts/ at once,
// so the next script added to that directory is covered without anyone remembering to add
// it here.
//
// Three layers, weakest to strongest:
//   1. SOURCE — no file names an interpreter in a spawn; every file that runs one imports
//      the shared launcher and threads its prefix args.
//   2. INVOCATION — a typo'd flag exits non-zero instead of looking like a passing gate.
//   3. BEHAVIOUR — the gates actually run, end to end, on a machine where `python3` and
//      `python` exist but fail and only `py -3` works. That shape used to be reasoned about
//      from launcher semantics and never executed; here it is executed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..');
const SCRIPT_DIR = path.join(CLI, 'scripts');

// DERIVED, never hand-listed. A hardcoded file list silently stops covering the directory
// the moment someone adds a script — the same failure mode as a hand-maintained price
// table: it looks maintained right up until it isn't.
const SCRIPTS = fs.readdirSync(SCRIPT_DIR).filter((f) => f.endsWith('.js')).sort();
const SRC = new Map(SCRIPTS.map((f) => [f, fs.readFileSync(path.join(SCRIPT_DIR, f), 'utf8')]));

// Comment-only lines removed, for the one test that greps for a FORBIDDEN CALL. Those
// comments are where this codebase records the historical failure a line of code exists to
// prevent — sync-prices.js names the very `execFileSync('python3', …)` call it replaced —
// and a guard that goes red at the description of a fixed bug teaches people to delete the
// description. Comments in scripts/ are `//` per line throughout; the `*` arm covers a
// block comment if one ever appears. Code with a TRAILING comment is still searched.
function codeOnly(src) {
  return src.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
}

// The gates that drive a Python child. Detected by the interpreter's own `-c` payload flag
// rather than by name, so the classification comes from what a file DOES.
const RUNS_PYTHON = SCRIPTS.filter((f) => /(['"`])-c\1/.test(SRC.get(f)));

// --------------------------------------------------------------------------
// 1. Source-level: one launcher, no second name for it
// --------------------------------------------------------------------------

test('scripts/ contains at least one Python-driving gate (the list is derived, not empty)', () => {
  // Guards the two tests below against passing vacuously if the detection above ever stops
  // matching — a test that silently covers nothing is the same shape as a gate that
  // silently does not run.
  assert.ok(RUNS_PYTHON.length >= 3,
    `expected the three parity gates; found ${RUNS_PYTHON.length}: ${RUNS_PYTHON.join(', ')}`);
});

test('no script spawns a LITERAL interpreter name', () => {
  // `execFileSync('python3', …)` is how sync-prices.js hard-failed on stock Windows. The
  // pattern covers every spawn helper and every plausible spelling, including the bare
  // Windows launcher (`py` with no `-3`, which can land on a Python 2 the user still has).
  const LITERAL = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*['"`](?:python[0-9.]*|py)\b/;
  for (const f of SCRIPTS) {
    const m = codeOnly(SRC.get(f)).match(LITERAL);
    // `assert.ok`, not `strictEqual(m, null)`: a match object carries the ENTIRE file in
    // its `input` property, and node:test prints it as the diff.
    assert.ok(!m,
      `${f} spawns a hardcoded interpreter (${m && m[0]}) instead of the launcher `
      + 'resolved by src/gateway.js — that name does not exist on a default Windows '
      + 'Python, where only `py -3` does');
  }
});

test('the forbidden-call guard would actually catch the call it forbids', () => {
  // A grep-shaped guard is worth exactly what its pattern is worth, and this one now runs
  // against comment-stripped source — two chances to be silently vacuous. So: feed it the
  // real regression and require a hit.
  const LITERAL = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*['"`](?:python[0-9.]*|py)\b/;
  const reintroduced = codeOnly([
    '// execFileSync(\'python3\', …) named in a comment must NOT trip it',
    'const raw = execFileSync(\'python3\', [\'-c\', script], { encoding: \'utf8\' });',
  ].join('\n'));
  assert.match(reintroduced, LITERAL, 'the guard must catch sync-prices.js:212 as it was');
  assert.doesNotMatch(codeOnly('// execFileSync(\'python3\', …) in prose'), LITERAL,
    'and must not fire on the comment that documents the fix');
  // The other spellings the pattern claims to cover.
  for (const bad of ["spawnSync('python', args)", 'spawn("py", args)',
    "execFile(`python3.11`, args)"]) {
    assert.match(bad, LITERAL, `pattern misses ${bad}`);
  }
  // And the correct form must NOT be flagged.
  assert.doesNotMatch("spawnSync(py.cmd, [...py.args, '-c', script])", LITERAL);
});

test('every Python-driving gate imports the shared launcher from src/gateway.js', () => {
  for (const f of RUNS_PYTHON) {
    const src = SRC.get(f);
    // Both spellings in use in this directory: the path.join form and the plain relative
    // require. What matters is that the module is src/gateway, not that it is spelled one
    // particular way.
    assert.match(src, /require\((?:path\.join\(__dirname, '\.\.', 'src', 'gateway\.js'\)|'\.\.\/src\/gateway(?:\.js)?')\)/,
      `${f} must get its interpreter from src/gateway.js`);
    assert.match(src, /\bpyExe\b/, `${f} must resolve its interpreter with pyExe()`);
    assert.doesNotMatch(src, /function\s+pyExe\s*\(/,
      `${f} carries its own pyExe() — one behaviour, two implementations, free to `
      + 'disagree about whether Python exists');
  }
});

test('every launcher spawn threads the launcher\'s prefix args FIRST', () => {
  // `py.cmd` alone runs the LAUNCHER's default Python, which need not be the one pyExe()
  // probed. Every spawn of a resolved launcher must spread its args before the payload:
  // `py -3 -c <script>`, never `py -c <script>`.
  let checked = 0;
  for (const f of SCRIPTS) {
    for (const m of SRC.get(f).match(/py\.cmd\s*,\s*\[[^\]]*/g) || []) {
      checked += 1;
      assert.match(m, /\[\s*\.\.\.py\.args\s*,/,
        `${f}: launcher spawn does not lead with its own args: ${m.slice(0, 90)}`);
    }
  }
  assert.ok(checked >= RUNS_PYTHON.length,
    `expected a launcher spawn in each of the ${RUNS_PYTHON.length} Python-driving gates, `
    + `found ${checked}`);
});

// --------------------------------------------------------------------------
// 2. Invocation: a typo'd flag is not a passing gate
// --------------------------------------------------------------------------

// Exit 2 is deliberately distinct from the 1 a real parity disagreement uses, so a CI log
// can tell "the gate ran and found drift" from "the gate was invoked wrong".
//
// DERIVED from RUNS_PYTHON, not hand-listed. It used to name two of the three gates, and
// the omitted one was `sync-prices.js` — the only gate that WRITES. Its argument handling
// was `process.argv.includes('--check')`, so a mistyped flag took the write branch: it
// regenerated the tracked price table, reported `wrote …` and exited 0, which is a CI step
// that verifies nothing and cannot fail. Deriving the list means the next script added to
// scripts/ is covered here without anyone remembering to add it.
//
// THE GENERATED ARTIFACT IS CHECKED FOR MUTATION on every gate, not only on the one that
// can write today: "exited 2" and "wrote nothing" are two different claims, and only the
// second one is the property that matters for a table the shipped npm package reads.
const GENERATED = path.join(CLI, 'assets', 'gateway', 'app', 'model_prices.json');

for (const gate of RUNS_PYTHON) {
  test(`${gate} rejects an unknown flag with exit 2, and writes nothing`, () => {
    const before = fs.readFileSync(GENERATED);
    const beforeMtime = fs.statSync(GENERATED).mtimeMs;
    const r = spawnSync(process.execPath, [path.join(SCRIPT_DIR, gate), '--chek'],
      { encoding: 'utf8', cwd: CLI });
    assert.strictEqual(r.status, 2,
      'a typo\'d flag in a CI line must not look like a passing gate');
    assert.match(r.stderr || '', /unknown argument '--chek'/);
    // It must bail BEFORE doing any comparing, so the wrong invocation cannot also emit a
    // line that reads like a result — and before any write, so it cannot report success by
    // MAKING the thing it was asked to check.
    assert.doesNotMatch((r.stdout || '') + (r.stderr || ''), /parity OK/);
    assert.doesNotMatch((r.stdout || '') + (r.stderr || ''), /^wrote /m);
    assert.deepStrictEqual(fs.readFileSync(GENERATED), before,
      `${gate} mutated ${path.relative(CLI, GENERATED)} on an unknown-flag invocation`);
    assert.strictEqual(fs.statSync(GENERATED).mtimeMs, beforeMtime,
      `${gate} rewrote ${path.relative(CLI, GENERATED)} byte-identically — the content is `
      + 'unchanged, but the gate still took its write path on a typo');
  });
}

// --------------------------------------------------------------------------
// 3. Behaviour: the stock-Windows shape, actually executed
// --------------------------------------------------------------------------

// A PATH containing ONLY stand-ins reproduces the configuration this whole launcher exists
// for: `python3` and `python` are present but fail (the Microsoft Store alias stub exits
// non-zero), and the only usable Python is reached through `py -3`.
//
// WHAT THIS PROVES: candidate fall-through, and that `-3` leads the payload args, end to
// end, through the real gate scripts. WHAT IT DOES NOT PROVE: Windows process-spawn
// semantics (.exe resolution, PATHEXT, cmd quoting) — the stubs are POSIX shell scripts.
// That half is only ever evidence on a Windows runner, and there is no Windows lane yet;
// see docs/parity-gates/. Stated rather than implied, because "reasoned from semantics"
// and "observed" are not the same claim.
const POSIX = process.platform !== 'win32';

function realPython() {
  // Resolved through the normal PATH, BEFORE it is replaced — and as an absolute path, so
  // the stub can reach it from inside a PATH that contains nothing else.
  const { pyExe } = require('../src/gateway');
  const cand = pyExe();
  if (!cand) return null;
  const r = spawnSync(cand.cmd, [...cand.args, '-c', 'import sys;sys.stdout.write(sys.executable)'],
    { encoding: 'utf8' });
  return r.status === 0 && r.stdout ? r.stdout.trim() : null;
}

// Builds the shim directory and returns { dir, log, cleanup }.
function launcherOnlyPath(realPy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-pyonly-'));
  const log = path.join(dir, 'invocations.log');
  const write = (name, body) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  };
  // Only the first two args are logged: the third is a multi-kilobyte `-c` payload, and a
  // log is only useful if it can be read.
  const stub = (name) => `#!/bin/sh\nprintf '%s\\n' "${name} $1 $2" >> ${JSON.stringify(log)}\nexit 1\n`;
  write('python3', stub('python3'));
  write('python', stub('python'));
  write('py', [
    '#!/bin/sh',
    // Stand-in for the python.org launcher. It REQUIRES `-3`: `py` alone selects the
    // launcher's default Python, which can be a Python 2 the user still has installed, so
    // a gate that forgot to thread the prefix args must fail here rather than pass.
    `printf '%s\\n' "py $1 $2" >> ${JSON.stringify(log)}`,
    'if [ "$1" != "-3" ]; then',
    '  echo "py stub: first argument must be -3, got \'$1\'" >&2',
    '  exit 3',
    'fi',
    'shift',
    `exec ${JSON.stringify(realPy)} "$@"`,
    '',
  ].join('\n'));
  return { dir, log, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function runWithLauncherOnly(script, args, realPy) {
  const shim = launcherOnlyPath(realPy);
  try {
    // node is invoked by ABSOLUTE path (process.execPath) and the gates spawn their JS side
    // the same way, so replacing PATH affects only the interpreter probe. An empty-PATH
    // repro that reports "node: command not found" (127) has tested nothing.
    const r = spawnSync(process.execPath, [path.join(SCRIPT_DIR, script), ...args], {
      encoding: 'utf8',
      cwd: CLI,
      env: Object.assign({}, process.env, { PATH: shim.dir, PATHEXT: '' }),
    });
    return { r, log: fs.existsSync(shim.log) ? fs.readFileSync(shim.log, 'utf8') : '' };
  } finally {
    shim.cleanup();
  }
}

// The two fast gates. check-policy-parity.js is deliberately NOT here: it drives a 144180-
// decision corpus and takes ~7s, and its launcher use is the same `runPy(py, …)` shape the
// source-level tests above already hold for it. The omission is stated so this file cannot
// be mistaken for full coverage of all three.
const LAUNCHER_ONLY_GATES = [
  { script: 'sync-prices.js', args: ['--check'], expect: /cross-runtime parity: \d+ ids agree/ },
  { script: 'check-period-parity.js', args: ['--check'], expect: /period parity OK/ },
];

for (const g of LAUNCHER_ONLY_GATES) {
  test(`${g.script} runs when ONLY \`py -3\` works`, { skip: POSIX ? false : 'POSIX shell stubs' }, () => {
    const realPy = realPython();
    // No usable Python at all means this test cannot say anything — and must not pretend
    // it did. It fails rather than skipping: the whole suite already requires a Python 3
    // (all three gates exit non-zero without one), so "no interpreter here" is a broken
    // environment, not a supported configuration.
    assert.ok(realPy, 'no usable Python 3 on this machine — the parity gates cannot run '
      + 'either, so fix the environment rather than reading this as a pass');

    const { r, log } = runWithLauncherOnly(g.script, g.args, realPy);
    assert.strictEqual(r.status, 0,
      `exit ${r.status} on a machine whose only Python is \`py -3\`\n`
      + `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n--- launcher log ---\n${log}`);
    assert.match(r.stdout || '', g.expect, 'the gate must report a real comparison');

    // The fall-through actually happened, in order, and the payload went through the
    // launcher WITH `-3` leading. Without these the test would also pass on a machine
    // where `python3` simply worked.
    assert.match(log, /^python3 --version/m, 'candidate 1 must be probed first');
    assert.match(log, /^python --version/m, 'candidate 2 must be probed next');
    assert.match(log, /^py -3 -c$/m,
      'the payload must run as `py -3 -c …` — `py -c …` would run the launcher\'s default '
      + 'Python, which need not be the one pyExe() probed');
  });
}

test('a launcher that is handed no `-3` is a FAILURE, not a silent wrong Python', {
  skip: POSIX ? false : 'POSIX shell stubs',
}, () => {
  // Proves the stub above has teeth: if a gate ever stops threading `py.args`, the tests
  // just above go red rather than quietly passing against whatever `py` alone selects.
  const realPy = realPython();
  assert.ok(realPy, 'no usable Python 3 on this machine');
  const shim = launcherOnlyPath(realPy);
  try {
    const r = spawnSync(path.join(shim.dir, 'py'), ['-c', 'print(1)'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 3);
    assert.match(r.stderr || '', /first argument must be -3/);
  } finally {
    shim.cleanup();
  }
});
