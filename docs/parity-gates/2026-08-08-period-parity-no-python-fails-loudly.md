# Period parity gate: a missing interpreter is a FAILURE, not a skip

**Date:** 2026-08-08
**Repo:** `ownasquare.com/cheaper-app`
**Surface:** `cli/scripts/check-period-parity.js`, `cli/test/period_parity_gate.test.js`

## What changed

`scripts/check-period-parity.js` no longer exits 0 when it cannot find a Python 3.
It prints `period parity: DID NOT RUN — no usable Python 3 (tried: python3, python, py -3)`
on **stderr** and exits **1**.

Previously it printed three `SKIPPED` lines on **stdout** and exited **0**.

## Why

A parity gate that quietly does not run is indistinguishable from one that passed. This
script is the only thing watching for JS↔Python drift in period bounds, `pday`, and window
placement; reporting "I could not check" in the same shape, on the same stream, with the
same exit code as "I checked and both runtimes agree" is the one failure mode it cannot
afford.

The exposure was concrete. Until commit `069ea54` the script carried its **own** `pyExe()`
that probed only `python3` and `python`. On a stock python.org Windows install with
"Add python.exe to PATH" left unchecked — the default — neither resolves to a real
interpreter (both hit the Microsoft Store alias stub, which exits non-zero) and only the
`py` launcher does. So on Windows all three gates skipped, silently, behind a green check.

The **discovery** half was already fixed at `069ea54`: the script now imports
`{ pyExe, PY_CANDIDATES, launcherLabel }` from `src/gateway.js` (candidates are
`{cmd, args}` pairs including `{cmd:'py', args:['-3']}`), and every interpreter spawn
spreads `...py.args` before its own arguments. This change fixes the **reporting** half,
which was the part that let the first failure hide.

`scripts/check-policy-parity.js` had already made this call for the routing gate
(`policy parity: DID NOT RUN`, `return 1`). The two gates now behave identically.

## Affected files

| File | Change |
|---|---|
| `cli/scripts/check-period-parity.js` | `main()` resolves the interpreter **first**, before building ~1400 JS fixture rows; `exe === null` → stderr + `process.exit(1)`. Dead `py === null` skip branches removed from `pdayParity()` and `placementParity()`. `NO_PY` no longer carries a duplicated `— the gate did not run` tail. |
| `cli/test/period_parity_gate.test.js` | **New.** 8 tests over the gate's own preconditions. |

`cli/src/gateway.js` was **not modified** (another agent's completed work; read-only
reference). Confirmed: `git diff --quiet cli/src/gateway.js` passes.

## Test coverage added

`cli/test/period_parity_gate.test.js`:

1. `PY_CANDIDATES` contains `py -3`.
2. A stubbed `spawnSync` shaped like stock Windows resolves to `{cmd:'py', args:['-3']}`,
   and probes in order `python3 --version`, `python --version`, `py -3 --version` — the
   launcher's own args **lead**.
3. Nothing usable → `null`; a `{status: null, error: ENOENT}` probe never reads as success.
4. The script imports the shared probe and carries **no** local `function pyExe(`.
5. Every `py.cmd` spawn site spreads `...py.args` first.
6. Running the real script with `PATH` emptied exits **non-zero**.
7. The message is on stderr, says `DID NOT RUN`, never says `SKIPPED`, and names every
   candidate in `PY_CANDIDATES`.
8. No `parity OK` line is printed when nothing was compared.

## Validation / proof (local, macOS, 2026-08-08)

```
$ node scripts/check-period-parity.js
  period parity OK — 1404 bounds identical across 9 zones × 13 instants (JS ↔ Python)
  pday/offset parity OK — 2097 answers identical across 9 zones × 20 instants × 11 offsets (JS ↔ Python)
  window-placement parity OK — 11615 figures identical across 9 zones × 10 windows (JS ↔ Python)
EXIT: 0
```

Regression proof — the pre-change script (`git show HEAD:cli/scripts/check-period-parity.js`)
run with `PATH` emptied:

```
  period parity: SKIPPED — no usable Python 3 (tried: python3, python, py -3) — the gate did not run
  pday/offset parity: SKIPPED — …
  placement parity: SKIPPED — …
OLD EXIT CODE: 0
```

Same conditions, after the change:

```
  period parity: DID NOT RUN — no usable Python 3 (tried: python3, python, py -3)
NEW EXIT CODE: 1
```

Full suite: `npm test` → **403 tests, 403 pass, 0 fail**, all three `parity OK` lines
present, policy gate `144180 decisions agree`.

## Known follow-up (not fixed here — out of scope)

- **P2 — `cli/scripts/sync-prices.js:212`** hardcodes `execFileSync('python3', …)` instead
  of the shared launcher. On stock Windows it throws ENOENT, is caught, and reports
  `PARITY CHECK COULD NOT RUN` + exit 1 — it fails *loudly* (correct) but on a machine that
  has a perfectly good Python under `py -3` (wrong). It runs first in `npm test`, so it
  blocks the whole suite on Windows. Spawned as a follow-up task.
- **P3 — `check-period-parity.js` ignores its own argv.** `--check` is passed by
  `package.json` but never parsed; a typo'd flag is silently accepted. The sibling
  `check-policy-parity.js:456-465` explicitly rejects unknown args with exit 2, with the
  comment "a typo'd flag in a CI line must not look like a passing gate." The period gate
  still runs and still diffs, so the blast radius is smaller than the policy gate's.

## Deploy status

Not deployed. Repo-local change to CI gates and tests only; no runtime/product surface
touched. Uncommitted in the working tree at time of writing.
