# The gate that could not fail: sync-prices argv, and the third named CI step

**Date:** 2026-08-09
**Repo:** `ownasquare.com/cheaper-app`
**Surface:** `cli/scripts/sync-prices.js`, `cli/test/parity_gate_launcher.test.js`,
`.github/workflows/ci.yml`
**Continues:** `docs/parity-gates/2026-08-09-one-python-launcher-for-every-gate.md`
(inventory items 1 and 4 of that entry's handoff)

## What changed

1. **`sync-prices.js` parses its argv.** `const check = process.argv.includes('--check')`
   is replaced by a loop that accepts `--check`, and exits **2** with a usage line on
   anything else — before any `fs.writeFileSync`. Write mode (no arguments) and `--check`
   behave exactly as they did.
2. **The unknown-flag test loop is derived, not hand-listed.**
   `cli/test/parity_gate_launcher.test.js` iterated `['check-period-parity.js',
   'check-policy-parity.js']`; it now iterates `RUNS_PYTHON`, which is itself derived from
   `readdirSync('scripts')`. The test also asserts the generated price table is unchanged —
   content **and** mtime — by the unknown-flag invocation.
3. **`ci.yml` gets a named step for the routing-policy gate.** All three parity gates now
   have one, which is what the workflow's own comment at that point already claimed.

## Why

### `includes('--check')` is not an argument parser

It asks whether one exact string is present and treats every other spelling as absent —
and **absent is the write mode**. So `--chek`, `--dry-run` or `-c` did not "do nothing":
`sync-prices.js` took the write branch, regenerated
`cli/assets/gateway/app/model_prices.json` from the JS catalog, printed `wrote …`, and
exited **0**.

A CI step written to *verify* the table would therefore have *made* it in sync and reported
success. That is a gate structurally incapable of failing — and worse than a missing gate,
because a genuine catalog drift would be silently absorbed into a tracked file that the
other gates and the shipped npm package both read. This is the same shape as the
silently-skipping period gate two entries back, arrived at from the opposite direction:
there the gate did not run, here it runs and cannot fail.

The blast radius is strictly larger than the period-gate flag fixed in the previous entry,
because this is the only gate of the three that **mutates** anything, and what it mutates
decides published prices. Pricing in this repo has already shipped wrong dollars once.

Why it existed: `--check` was added as a one-line `includes()` test when the script had a
single job and one caller. The two later gates each grew a real parser
(`check-policy-parity.js:478-488`, and `check-period-parity.js`'s `main(argv)` added in the
previous entry); this one never did, and because its default branch writes, the missing
parser converted a typo from "ignored" into "mutates state and reports success".

Exit **2** matches both siblings and is deliberately distinct from the **1** that a real
staleness or parity failure uses, so a CI log can tell "the gate ran and found drift" from
"the gate was invoked wrong".

### The test list was hand-written, and it omitted the gate that writes

The loop named two of three gates. The omitted one was the only one that could mutate a
tracked file — which is the hand-maintained-list failure mode this repo keeps re-learning
(`sync-prices.js` states it for its own mirror list, and the test file states it for
`SCRIPTS`). It now derives from `RUNS_PYTHON`, so a fourth gate added to `scripts/` is
covered without anyone remembering.

The test asserts three separate things, because they are three separate claims:

- exit status is 2 (not 0, not 1);
- no line resembling a result (`parity OK`, `wrote …`) is emitted;
- `model_prices.json` is byte-identical **and** its mtime is unchanged — "exited 2" and
  "wrote nothing" are different properties, and only the second is the one that matters for
  a file the published package reads. The mtime assertion catches the case where the gate
  takes its write path but the content happens to already agree, which is exactly the state
  a healthy tree is always in and would otherwise hide the defect.

### The policy gate had no named CI step

`ci.yml`'s comment said the parity gates are re-run by name "so a future edit to that
script cannot silently drop one of them" — while `check-policy-parity.js` had only the
`npm test` run. It is last in `cli/package.json`'s chain and the largest corpus of the
three (144180 routing decisions across 89 models), so it is precisely the one such an edit
would drop unnoticed. Nothing was misreporting; the belt-and-braces layer simply was not
there for one of three. Cost is the ~7 s of duplicated work the other two steps already pay
for the same reason.

## Proof

Both directions, with captured exit codes:

| Check | Result |
|---|---|
| `node scripts/sync-prices.js --check` | `82 ids agree`, `price tables are in sync`, exit **0** |
| `node scripts/sync-prices.js` (write mode) | `82 ids agree`, `done`, exit **0** |
| `node scripts/sync-prices.js --chek` | `sync-prices: unknown argument '--chek' (usage: [--check])`, exit **2** |
| `node scripts/sync-prices.js --dry-run` | same shape, exit **2** |
| `git diff --quiet cli/assets/gateway/app/model_prices.json` after all four | clean |
| `cd cli && npm test` | **434 pass / 0 fail / 0 skipped**, exit 0 (baseline 433) |
| `python3 -m pytest cli/assets/gateway/tests -q` | **458 passed** (unchanged) |
| gate figures | 82 ids · 1404 bounds · 2097 answers · 11615 figures · 144180 decisions — all identical to baseline |
| all three workflow YAMLs | parse via `yaml.safe_load`; no `continue-on-error`, no `\|\| true` |

**Mutation evidence.** The new test file was run against `HEAD`'s `sync-prices.js`
(`git show HEAD:cli/scripts/sync-prices.js`), and the new case went `not ok 8 -
sync-prices.js rejects an unknown flag with exit 2, and writes nothing`. The file was then
restored and verified identical by `shasum -a 256`. The other three `not ok` lines in that
run (2, 4, 9) are the previous entry's launcher migration, failing at `HEAD` for the reason
that entry records.

Note what the mutation run also shows: at `HEAD`, the unknown-flag invocation did **not**
change `model_prices.json`, because the table already agreed with the catalog. The exit
code is what caught it. A content-only assertion would have passed against the defect — the
reason the mtime assertion is there too.

## Deliberately not done

- **`sync-prices.js` refusing to write on a non-TTY.** Considered and rejected for this
  change: it is a behavioural change to the write contract with its own proof obligations,
  and smuggling it into an argv fix would widen the diff past what was verified.
- **`cli/package.json`'s `sync:prices` script.** It passes no flag, which *is* the write
  mode and is correct. It was not "fixed" by adding `--check`.
- **A test that parses `ci.yml` and asserts every `scripts/*parity*.js` has a named step.**
  It would close the class the third step's absence belonged to, but at P4 it is more
  machinery than the risk warrants. Stated so the omission is a decision, not an oversight.
- **Getting `check-period-parity.js` onto Windows.** See below — it is unchanged here, and
  the reason is sequencing, not difficulty alone.

## Still open

`check-period-parity.js` remains excluded from `.github/workflows/ci-windows.yml`, and that
lane has still **never executed**. Its exclusion comment is still accurate.

Solving the exclusion means replacing the `TZ`-per-child zone injection in `runIn()` with a
mechanism CPython honours on Windows (`tzutil /s` plus `pip install tzdata`, sequential and
restored on failure), and deciding what to do about `Pacific/Chatham`, which has no clean
Windows zone equivalent. Every sentence of that is **reasoned from launcher and CRT
semantics; none of it has been executed.** The correct next step is one push to convert the
Windows lane's first run into evidence — including the currently unknown answer to "which
of `python3` / `python` / `py -3` does `actions/setup-python@v5` actually put on PATH on
that image" — and only then to design against what the runner really does. Writing a
`tzutil` path blind, into the gate that produces the 2097 and 11615 figures, would be a
change nothing in this repo can currently verify.
