'use strict';
// scripts/check-period-parity.js — the gate's OWN preconditions, as opposed to the
// JS<->Python answers it diffs.
//
// The three parity gates inside that script are only worth what their ability to RUN is
// worth, and both halves of that had failed at once:
//
//   1. DISCOVERY. The script carried its own `pyExe()` that probed `['python3',
//      'python']` and returned a bare string. On a stock python.org Windows install with
//      "Add python.exe to PATH" left unchecked — the DEFAULT — neither name resolves to a
//      real interpreter (they hit the Microsoft Store alias stub, which exits non-zero);
//      only the `py` launcher, which every python.org installer drops into System32
//      regardless of the PATH checkbox, does. So every gate found "no Python" there.
//
//   2. REPORTING. Finding no Python printed a SKIPPED line on stdout and exited 0. A
//      parity gate that quietly does not run is indistinguishable from one that passed,
//      so a JS<->Python drift in period bounds, pday, or window placement would have
//      shipped on Windows behind a green check.
//
// Fixing only (1) would have left the gate silent the next time discovery broke; fixing
// only (2) would have made Windows CI red for a Python that was in fact installed. These
// tests hold both, plus the structural property that keeps (1) fixed: ONE probe, shared
// with src/gateway.js, not a second copy free to drift back.

const fs = require('fs');
const path = require('path');
const os = require('os');
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-period-parity.js');
const SRC = fs.readFileSync(SCRIPT, 'utf8');

// --------------------------------------------------------------------------
// 1. The launcher list the GATE uses — probed, not just declared
// --------------------------------------------------------------------------

// The list is asserted through the same import the script performs, so this test covers
// what the gate will actually run rather than a lookalike constant. gateway.js owns the
// implementation; if that ownership ever moves, this fails at the require and says so.
const { pyExe, PY_CANDIDATES, launcherLabel } = require('../src/gateway');

test('the gate\'s candidate list contains the Windows launcher `py -3`', () => {
  assert.ok(PY_CANDIDATES.some((x) => x.cmd === 'py' && x.args.join(' ') === '-3'),
    'without `py -3` the gate silently skips on a stock python.org Windows install, '
    + 'which is the only configuration whose drift nothing else watches');
});

test('the gate resolves `py -3` on the stock-Windows shape, -3 BEFORE the probe arg', () => {
  // The stubbed spawnSync stands in for a machine where `python3` and `python` are the
  // Store alias stubs (non-zero) and only the launcher works. Two things are on trial:
  // that such a machine resolves at all, and that the launcher's own args LEAD — `py -3
  // --version` reports a Python's version, `py --version` reports the launcher's.
  const seen = [];
  const stub = (cmd, args) => {
    seen.push([cmd, ...args].join(' '));
    return { status: cmd === 'py' ? 0 : 1 };
  };
  assert.deepStrictEqual(pyExe(stub), { cmd: 'py', args: ['-3'] });
  assert.deepStrictEqual(seen,
    ['python3 --version', 'python --version', 'py -3 --version']);
});

test('nothing usable resolves to NULL, and the gate treats null as fatal', () => {
  assert.strictEqual(pyExe(() => ({ status: 1 })), null);
  // spawnSync on a missing binary answers {status: null, error: ENOENT}; a null status
  // must never read as success.
  assert.strictEqual(pyExe(() => ({ status: null, error: new Error('ENOENT') })), null);
});

// --------------------------------------------------------------------------
// 2. ONE probe — the structural property that keeps discovery fixed
// --------------------------------------------------------------------------

test('the gate imports the probe instead of carrying a second copy', () => {
  assert.match(SRC, /require\(path\.join\(__dirname, '\.\.', 'src', 'gateway\.js'\)\)/,
    'the launcher must come from src/gateway.js');
  assert.doesNotMatch(SRC, /function\s+pyExe\s*\(/,
    'a local pyExe() is how this broke the first time: one behaviour, two '
    + 'implementations, free to disagree about whether Python exists');
});

test('every interpreter spawn threads the launcher\'s prefix args', () => {
  // `py.cmd` alone would run the LAUNCHER's default Python, which need not be the one
  // pyExe() probed. Each spawn of the resolved launcher must spread `py.args` first.
  const spawns = SRC.match(/spawnSync\(\s*py\.cmd[^)]*/g) || [];
  const threaded = SRC.match(/py\.cmd,\s*\[\s*\.\.\.py\.args\s*,/g) || [];
  assert.ok(spawns.length + threaded.length > 0, 'expected at least one launcher spawn');
  for (const m of SRC.match(/py\.cmd\s*,\s*\[[^\]]*/g) || []) {
    assert.match(m, /\[\s*\.\.\.py\.args\s*,/,
      `launcher spawn does not lead with its own args: ${m.slice(0, 80)}`);
  }
});

// --------------------------------------------------------------------------
// 3. No interpreter is a FAILURE, not a pass (the reporting half)
// --------------------------------------------------------------------------

// PATH is emptied rather than mocked: this runs the real script end to end, so it covers
// the exit code a CI lane would actually observe. `process.execPath` is absolute, so the
// JS side is unaffected by the stripped PATH — only the interpreter probe is.
function runWithoutPython() {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-nopy-'));
  try {
    return spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { PATH: empty, PATHEXT: '' }),
    });
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

test('a machine with no Python EXITS NON-ZERO — an unrun gate cannot read as a pass', () => {
  const r = runWithoutPython();
  assert.notStrictEqual(r.status, 0,
    'exit 0 with no interpreter is the defect: CI cannot tell "both runtimes agree" '
    + 'from "I never asked either of them"');
});

test('the failure names what was tried, on stderr, and never says SKIPPED', () => {
  const r = runWithoutPython();
  const all = (r.stdout || '') + (r.stderr || '');
  assert.match(r.stderr || '', /DID NOT RUN/,
    'the message belongs on stderr, where a CI log surfaces it');
  assert.doesNotMatch(all, /SKIPPED/,
    '"SKIPPED" is the wording that made an unrun gate look benign');
  // Checkable against what was actually attempted, so a future candidate added to the
  // list appears in the message without anyone remembering to edit it.
  for (const cand of PY_CANDIDATES) {
    assert.ok(all.includes(launcherLabel(cand)),
      `the message must name every candidate tried; missing ${launcherLabel(cand)}`);
  }
});

test('no "parity OK" line is printed on the no-Python path', () => {
  // The strongest form of the property under test: the gate must not emit a single one
  // of its three success lines when it compared nothing.
  const r = runWithoutPython();
  assert.doesNotMatch((r.stdout || '') + (r.stderr || ''), /parity OK/);
});
