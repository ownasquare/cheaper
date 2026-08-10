# One Python launcher for every gate, and a Windows lane to prove it

**Date:** 2026-08-09
**Repo:** `ownasquare.com/cheaper-app`
**Surface:** `cli/scripts/sync-prices.js`, `cli/scripts/check-period-parity.js`,
`cli/test/parity_gate_launcher.test.js`, `cli/test/e2e_store.test.js`,
`.github/workflows/ci-windows.yml`, `.gitattributes`
**Continues:** `docs/parity-gates/2026-08-08-period-parity-no-python-fails-loudly.md`
(backlog items 1–3 of that entry's handoff)

## What changed

1. **`sync-prices.js` resolves Python through the shared launcher.** It called
   `execFileSync('python3', ['-c', script], …)` — a literal interpreter name, the third
   answer in this repo to "how do I find Python". It now imports
   `{ pyExe, PY_CANDIDATES, launcherLabel }` from `src/gateway.js` and spawns
   `execFileSync(py.cmd, [...py.args, '-c', script], …)`. A missing interpreter is reported
   as `PARITY CHECK DID NOT RUN — no usable Python 3 (tried: python3, python, py -3)` and
   exits 1; a launcher that resolves but whose payload then fails is reported separately, as
   `PARITY CHECK COULD NOT RUN (<launcher>): …`, so "the dependency is missing" and
   "pricing.py raised" are no longer the same message.
2. **`check-period-parity.js` parses its own argv.** `main(process.argv.slice(2))` accepts
   `--check` and rejects anything else with a usage line and **exit 2**, mirroring
   `check-policy-parity.js:478-488`. Exit 2 is distinct from the 1 a real disagreement uses.
3. **A cross-script regression guard** — `cli/test/parity_gate_launcher.test.js`, 11 tests.
4. **A Windows CI lane** — `.github/workflows/ci-windows.yml`, deliberately a **separate,
   non-release-gating workflow**.
5. **`.gitattributes`** pins `eol=lf`, without which the Windows lane's first step is a
   false red (see below).
6. **`cli/test/e2e_store.test.js` — an unrelated, pre-existing date-boundary failure fixed.**
   Not part of the planned work; found by running the suite. See "Pre-existing failure".

## Why

`sync-prices.js` is the **first** command in `cli/package.json`'s `test` script. On a stock
python.org Windows install with "Add python.exe to PATH" left unchecked — the default —
`python3` resolves only to the Microsoft Store alias stub, so that call threw `ENOENT` on a
machine with a perfectly usable Python 3 and took the entire suite with it before any other
gate ran. The other two gates had already been migrated to the shared launcher; this one was
left behind. One behaviour, three implementations, free to drift, is the exact defect class
the parity gates exist to catch — reproduced inside the gates' own plumbing.

The argv change is smaller in blast radius and was fixed for symmetry: `check-policy-parity.js`
already refused an unknown flag on the grounds that "a typo'd flag in a CI line must not look
like a passing gate," and the period gate accepted anything.

## Affected files

| File | Change |
|---|---|
| `cli/scripts/sync-prices.js` | Shared-launcher import + `NO_PY`; `pyAnswers(py, ids, at)` takes the resolved launcher and spreads `...py.args`; the launcher is resolved **before** the probe set is built, and a null launcher is its own reported failure rather than a caught `ENOENT`. The table-writing and route-target sections are untouched, so `--check`-less write behaviour is unchanged. **Also** (see "Closed after this document was first written") a real argv parse replaces `process.argv.includes('--check')`, ahead of the write loop. |
| `cli/scripts/check-period-parity.js` | `main(argv)` + `main(process.argv.slice(2))`; unknown flag → usage on stderr → exit 2. No change to any fixture matrix or to the three gates. |
| `cli/test/parity_gate_launcher.test.js` | **New**, 10 tests. Applies the launcher invariant to **every** file in `scripts/`, from a **derived** file list, so a script added later is covered without anyone editing this file. |
| `cli/test/e2e_store.test.js` | Row selection in the first E2E case no longer guesses a ladder key by name. **Pre-existing bug, fixed** — see below. |
| `.github/workflows/ci-windows.yml` | **New.** `windows-latest`; `sync-prices --check`, `check-policy-parity --check`, the launcher-contract tests, and the `--help` smoke. |
| `.gitattributes` | **New.** `* text=auto eol=lf` + `*.png binary`. |
| `.github/workflows/ci.yml` | Named step for the **routing-policy** parity gate (the one gate that had none), plus the block comment above `npm test` corrected from "the two parity gates" to "ALL THREE". See "Closed after this document was first written". |

`cli/src/gateway.js` was **not modified** — another agent's completed work, read-only.
`git diff --quiet cli/src/gateway.js` passes.

## What `parity_gate_launcher.test.js` holds

Three layers, weakest to strongest:

- **Source** — no file in `scripts/` spawns a literal interpreter name; every file that runs
  a `-c` payload imports `src/gateway.js`, calls `pyExe()`, defines no local `pyExe()`, and
  spreads `...py.args` before the payload. The forbidden-call grep runs against
  **comment-stripped** source, because this codebase records the fixed bug's exact call in a
  comment and a guard that reddens at the description teaches people to delete the
  description. A companion test feeds the guard the real `sync-prices.js:212` line and
  requires a hit, so the pattern cannot go silently vacuous.
- **Invocation** — a typo'd flag exits 2 on both parity gates and prints no `parity OK`.
- **Behaviour** — the gates are executed end to end on a `PATH` containing **only** stand-ins:
  `python3` and `python` exist but exit non-zero (the Store-alias-stub shape) and the sole
  usable Python is reached through a `py` shim that **requires** `-3` as its first argument.
  Each stub logs its invocation, and the test asserts the fall-through order
  (`python3 --version` → `python --version` → `py -3 -c`). This is the first time the `py -3`
  path has been *executed* rather than reasoned about.

**Stated limits.** The stubs are POSIX shell scripts, so the two behavioural tests skip on
`win32` (reported as skipped, not hidden) and prove **candidate fall-through and arg
threading**, not Windows process-spawn semantics. `check-policy-parity.js` is excluded from
the shim runs on cost grounds (~7 s, 144180-decision corpus); its launcher use is the same
`runPy(py, …)` shape the source-level tests already hold for it. Both omissions are written
into the test file.

## Why the Windows lane is a separate workflow

`publish-cli.yml:28` does `uses: ./.github/workflows/ci.yml`, so **every** job in `ci.yml`
becomes a required gate for `npm publish`. Windows is an unproven platform here — this lane's
first run is the first evidence anyone has ever had — and a first-run failure on an unproven
platform must be information, not a release freeze on a package whose Linux and macOS
behaviour is fully tested. There is deliberately **no** `continue-on-error` and no `|| true`:
red means red, exactly as `ci.yml`'s policy comment demands. It simply does not hold the
release train. **Intended end state: move it into `ci.yml` as a job once it has been green.**

### Why `.gitattributes` was required first

`sync-prices.js --check` compares the regenerated price table against the committed
`cli/assets/gateway/app/model_prices.json` **byte for byte**. Git for Windows ships with
autocrlf on, so a Windows checkout would hand that file back with CRLF, and the gate would
report `STALE:` — a checkout artifact wearing the costume of a real price drift, on the one
gate whose job is to be believed about price drift. No tracked file in this repo contains a
CR today (`git grep -Il $'\r'` is empty) and macOS/Linux already check out LF, so this pins
existing behaviour rather than changing it: `git status` stays clean and
`git ls-files --eol` reports `i/lf w/lf`.

### Why `check-period-parity.js` is NOT on the Windows lane

Two independent, verified reasons — **neither of which is a JS↔Python drift**:

1. Gates 2 and 3 inject each timezone with `TZ` on the child's environment
   (`check-period-parity.js`, `runIn()`). Node/V8 honours IANA zone names on Windows;
   CPython's `datetime.astimezone()` (`periods.py::local_offset_minutes`) reads the **OS**
   zone, and the Windows CRT cannot parse `America/Los_Angeles`. The two sides would be
   compared in **different zones** and report a disagreement that is an artifact of the
   fixture harness.
2. `periods.py` imports `zoneinfo.ZoneInfo`, and Windows ships no system tz database, so it
   additionally needs `pip install tzdata`.

Gate 1 (`period_bounds`) passes its zones explicitly and **is** portable, but the script has
no way to run gate 1 alone — and adding a flag that runs *less* of a gate is how a CI line
comes to look green while checking less. Putting this gate on Windows means installing
`tzdata` and setting the OS zone per case (`tzutil /s`) instead of using `TZ`. That is real
work, not a config tweak, and it is filed as backlog rather than guessed at.

## Pre-existing failure found and fixed (not part of the planned work)

`cli/test/e2e_store.test.js`'s first case began failing at the 2026-08-08 → 2026-08-09 date
boundary — **mid-session**, having passed 20 minutes earlier on the same tree.

Root cause is in the **test**, not the store. It located the ladder row holding a nine-day-old
chat by guessing a key:

```js
const older = byKey.month_earlier.estimated || byKey.quarter_earlier.estimated
  || byKey.week_earlier.estimated;
```

An empty window that **is** covered reports `status: 'partial'` with `{calls: 0, saved: 0}`,
and `{calls: 0}` is truthy — so on 2026-08-09 the chain stopped at the empty `month_earlier`
(Aug 1 → Aug 3) and never reached the `quarter_earlier` row holding all three calls. The
store's answer was correct throughout; verified by dumping the ladder:

```
today            status=not_covered estimated=null
week_earlier     status=not_covered estimated=null
month_earlier    status=partial     estimated={"calls":0,"saved":0}   <-- chain stopped here
quarter_earlier  status=partial     estimated={"calls":3,"saved":48}  <-- the money
```

The row is now found by what it **contains**, and the replacement is strictly stronger than
what it replaced: exactly one ladder row may hold calls, it must hold 3, its saving must be
positive, its own `from`/`to` must contain the event timestamp, and its key must not be
`today` (the bucket-on-tagline-time defect the test exists for). All five properties are
independent of the date.

**Attribution proof:** the failure reproduces at `HEAD` with every change from this session
removed — `git stash push` on the two modified scripts plus moving the new test file and
`.gitattributes` aside → `not ok 1`, same assertion. `html.test.js`'s ladder fixtures are
hardcoded rather than `Date.now()`-derived, so this was the only instance of the pattern.

## Validation / proof

All run on macOS (darwin 25.3.0), Node v20.19.4, Python 3.11.

| Check | Result |
|---|---|
| `npm test` (in `cli/`) | **434 pass, 0 fail, 0 skipped**, exit 0 (baseline before this work: 423/423; 433 before the two "closed after" items below added their gate to the derived argv loop) |
| `python3 -m pytest cli/assets/gateway/tests -q` | **458 passed** |
| `node scripts/sync-prices.js --check` | `cross-runtime parity: 82 ids agree`, `price tables are in sync`, exit 0 |
| `node scripts/check-period-parity.js` and `--check` | all three `parity OK` lines, exit 0 |
| `node scripts/check-policy-parity.js --check` | `144180 decisions agree`, exit 0 |
| `sync-prices.js` with `PATH` emptied | `PARITY CHECK DID NOT RUN — no usable Python 3 (tried: python3, python, py -3)`, exit **1** |
| `check-period-parity.js --chek` | usage line, exit **2**, no `parity OK` printed |
| `sync-prices.js --check` and `check-period-parity.js --check` with a `py -3`-only `PATH` | exit 0, real comparison reported, stub log shows `python3 --version` → `python --version` → `py -3 -c` |
| `.gitattributes` added | `git status` unchanged; `git ls-files --eol` → `i/lf w/lf` |
| YAML of all three workflows | parses (`yaml.safe_load`) |

**Mutation-checked, not asserted.** The new tests were run against `HEAD`'s versions of both
scripts (extracted with `git show HEAD:`, restored afterwards and checksum-verified):

```
not ok 2 - no script spawns a LITERAL interpreter name
not ok 4 - every Python-driving gate imports the shared launcher from src/gateway.js
not ok 6 - check-period-parity.js rejects an unknown flag with exit 2
not ok 8 - sync-prices.js runs when ONLY `py -3` works
```

Tests 5, 9 and 10 pass against `HEAD` as expected — the period gate's launcher half had
already landed at `069ea54`, so only the source-level and behavioural tests aimed at
`sync-prices.js` and the argv test could fail there.

**Not proven anywhere:** any Windows behaviour. `.github/workflows/ci-windows.yml` has never
executed — its first run on GitHub is the first evidence. Every Windows statement in this
document is reasoned from launcher and CRT semantics, and is labelled as such.

## Deploy status

Nothing deployed. This work touches CI gates, tests and workflow configuration only — no
runtime, product or published surface. `cli/package.json`'s `0.3.0 → 0.4.0` version bump was
**already uncommitted in the tree on arrival** and is **not** this session's work.

## Git state

Branch `main`, 3 commits ahead of `origin/main`, base `c1ccac2` ("Stop publishing unmeasured
dollars as a measured saving; make "live" mean data"). All of the above is **uncommitted** at
the time of writing, by design — see the handoff's next steps.

## Known follow-up

1. **P2 — get `check-period-parity.js` onto Windows** (`tzdata` + `tzutil /s` per zone
   instead of `TZ`).
2. **P2 — watch `ci-windows.yml`'s first run**, then move it into `ci.yml` as a job.

### Closed after this document was first written

Items **1** (`sync-prices.js` argv validation) and **4** (the routing-policy gate's missing
named CI step) of the original follow-up list have since landed in this same uncommitted
working tree.

They are **not** restated here. The full record — rationale, the exit-2 contract, the derived
test loop, the content-**and**-mtime assertion, and the captured mutation evidence — is
`docs/parity-gates/2026-08-09-sync-prices-argv-and-the-third-ci-step.md`. Two documents
narrating one change is the same one-behaviour-two-copies drift these gates exist to catch;
this entry keeps the pointer, that entry keeps the detail.

After both landed, all three gates parse argv and exit 2 on an unknown flag, and all three
have a named step in `ci.yml`.
