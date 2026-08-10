# `%Y` is a libc property: the price date that lost its padding on Linux

**Date:** 2026-08-09 · **Repo:** `ownasquare.com/cheaper-app` · **Branch:**
`parity-gates/one-python-launcher`
**Predecessor:** `docs/parity-gates/2026-08-09-sync-prices-argv-and-the-third-ci-step.md`
**Inventory item closed:** backlog #1 of
`beladed.com/docs/handoffs/2026-08-09-claude-sync-prices-argv-third-ci-step.handoff.mdc`

## What changed

| File | Change |
|---|---|
| `cli/assets/gateway/app/periods.py` | `pday_of` renders the date with `.date().isoformat()` instead of `strftime("%Y-%m-%d")`; `local_bounds_label.fmt` formats field-by-field instead of `strftime("%Y-%m-%d %H:%M")` |
| `cli/assets/gateway/tests/test_metrics.py` | **new** `test_a_pday_year_is_always_four_digits_on_every_libc` |

Two lines of behaviour. Everything else in both hunks is comment.

## The defect

`pday` is a **price date** — the key every row is bucketed, sorted and range-compared by.
`periods.js::pdayOf` fixes its shape literally, ending:

```js
return `${String(y).padStart(4, '0')}-${m}-${d}`;
```

`periods.py::pday_of` rendered the same value with `strftime("%Y-%m-%d")`. **`%Y`
zero-padding for years < 1000 is delegated to the platform's C library, not implemented by
Python.** BSD/macOS libc pads to four digits; glibc does not.

Every session in this repo's history validated on macOS, so the drift could not be
observed. It became visible the first time `check-period-parity.js` ran on
`ubuntu-latest`:

```
pday/offset parity FAILED: 138 of 2097 disagree
  [UTC] JS  pday|-62135596800000|"__undefined__"|0001-01-01
  [UTC] PY  pday|-62135596800000|"__undefined__"|1-01-01
```

A year that loses its padding is not a cosmetic string. `1-01-01` is a **mis-keyed
bucket**, and because the store compares days lexicographically (`at < win["from"]` in
`pricing.py::_in_window`), it also sorts and range-compares wrong against every correctly
padded neighbour. It is live on **every Linux host**, which includes the gateway's own
Docker container.

Blast radius is confined to instants in year < 1000, which is why no user has reported it.
That makes it a latent correctness defect, not an active outage — and exactly the class the
parity gates exist to catch before it stops being latent.

### The second, hidden failure

`test_reporting.py:2265` has asserted the correct contract all along:

```python
assert periods.pday_of(periods.CAL_MIN_MS, 0) == "0001-01-01"
```

It had **never been executed on a platform that could break it**. It fails on glibc:

```
FAILED test_reporting.py::test_a_reconstructed_offset_is_refused_outside_the_calendar
E   AssertionError: assert '1-01-01' == '0001-01-01'
```

It never surfaced in Actions because `ci.yml`'s `CLI test suite` step runs `npm test`
(which chains `check-period-parity.js`) **before** the `Gateway pytest suite` step, so the
job aborted on the first red and the second one was never reached. One root cause, two
failing steps, only one of them visible.

## The fix

`date.isoformat()` is implemented in CPython as `%04d-%02d-%02d` and touches no libc, so it
means the same thing on every platform. `local_bounds_label` gets the same treatment via an
explicit f-string (it needs `%H:%M` too, so `isoformat()` is not the right shape there).

`local_bounds_label` was included deliberately rather than left as a known-divergent
sibling: `reporting.py:1484` writes it into the export as `period_bounds_label` **from the
request's own `from`/`to`**, so a caller can reach year < 1000, and the label's stated job
is to make an export reproducible from its own header.

## Proof

`ubuntu-latest` was reproduced locally in Docker (`node:20-bookworm-slim` + `python3` +
`tzdata`; `python:3.11-slim` for pytest) so every claim below is **observed, not reasoned**
— the distinction this repo insists on. Both Dockerfiles are ~4 lines and are reproduced at
the bottom of this document.

| Check | Platform | Before | After |
|---|---|---|---|
| `node scripts/check-period-parity.js --check` | **glibc 2.41** | `pday/offset parity FAILED: 138 of 2097 disagree` | **OK — 1404 / 2097 / 11615, exit 0** |
| `node scripts/check-period-parity.js --check` | macOS | OK — 1404 / 2097 / 11615 | OK — 1404 / 2097 / 11615, exit 0 |
| `pytest cli/assets/gateway/tests -q` | **glibc 2.41** | 436 passed, **1 failed**, 21 skipped | **438 passed, 0 failed, 21 skipped** |
| `pytest cli/assets/gateway/tests -q` | macOS | 458 passed | **459 passed** (exactly +1, the new test) |
| new test alone | glibc, pre-fix code | `AssertionError: tzo=0 rendered an unpadded year: '1-01-01'` | passes |

The three gate figures — **1404 bounds, 2097 pday answers, 11615 placement figures** — are
byte-identical to the macOS baseline recorded by the predecessor session. The fix changes
which *strings* year < 1000 produces on glibc; it changes no count anywhere.

Mechanism isolated from the function under test, same probe on both platforms:

| year | macOS `strftime("%Y-%m-%d")` | glibc `strftime("%Y-%m-%d")` | `date.isoformat()` (both) |
|---|---|---|---|
| 1 | `0001-01-02` | **`1-01-02`** | `0001-01-02` |
| 99 | `0099-01-02` | **`99-01-02`** | `0099-01-02` |
| 999 | `0999-01-02` | **`999-01-02`** | `0999-01-02` |
| 1000 | `1000-01-02` | `1000-01-02` | `1000-01-02` |
| 2026 | `2026-01-02` | `2026-01-02` | `2026-01-02` |

After the fix the `pday_of` rows are identical across the two platforms **while the raw
`strftime` control still diverges** — which is what establishes that the container really is
glibc and that the fix, not the environment, is what changed.

## What the new test can and cannot do

`test_a_pday_year_is_always_four_digits_on_every_libc` is a **glibc detector**, and its
docstring says so. On BSD libc a reverted `strftime("%Y-%m-%d")` produces the same padded
strings and the test still passes — it cannot fail on a Mac, because the bug does not exist
on a Mac. The Linux lane of `ci.yml` is where it earns its place. Claiming otherwise would
be the same class of defect as a comment asserting a property the code does not have.

It was mutation-checked the way this repo requires: run against `git show HEAD:` 's
`periods.py` on glibc, it fails with the exact unpadded value.

## Deliberately not done

- **`pricing.py:267` (`today_utc`) and `reporting.py:1537`** also use `%Y`, and were left
  alone. Both format `datetime.now(...)`, whose year is always four digits, so there is no
  defect to fix — changing them would be churn in files outside this change's scope. Noted
  here so the next reader knows they were examined rather than missed.
- **The fixtures were not touched.** `PDAY_INSTANTS`' calendar-edge entries are on the Do
  Not Touch list and are precisely what caught this. The gate was made green by fixing the
  code it was accusing.
- **Nothing was loosened.** No `continue-on-error`, no `|| true`, no `-k`, no `--deselect`.
- **The Windows policy-parity failure (377 disagreements) is untouched** — a different
  defect, still open, still undiagnosed.

## Reproducing the Linux runs

```dockerfile
# gate: node + python + tzdata
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 tzdata ca-certificates
WORKDIR /repo/cli
```

```dockerfile
# pytest: the gateway's own requirements
FROM python:3.11-slim
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
WORKDIR /work
```

Mount the repo read-only (`-v <repo>:/repo:ro`) so a container can never write into a tree a
concurrent agent is editing. For pytest, copy to a writable path first (`cp -r /src /work/repo`)
because `__pycache__` needs to be writable.
