# The warn list, and a scanner floor that did two jobs

**Date:** 2026-08-09 · **Commits:** `7b58e8c`, `78f24c0` · **Surface:** `cli/assets/gateway/app/report.html`, `cli/test/html.test.js`

## What changed

Two commits against the printable report's status chips.

`7b58e8c` — the `LABEL_TEXT` tooltip map was missing two of the nine slugs its
producers can emit. `chips()` renders `LABEL_TEXT[l] || l`, so a missing slug does not
fail anything: it silently degrades its own tooltip to the raw slug, so
`state_unreadable` explained itself with the words "state unreadable". Added
`dated_by_frozen_day` (wording from `reporting.py:866-875`) and `state_unreadable`
(from `reporting.py:809-828`), plus a gate that scans BOTH producers — `reporting.py`
and `cli/src/peek/store.js` — and diffs what they can emit against the map.

`78f24c0` — `state_unreadable` joined `chips()`'s `warn` list, and a second gate now
holds that list.

## Why the warn list mattered

`warn` marks the states where **no figure can be claimed**, as opposed to the states
that merely **qualify** one (`partial_coverage`, `tombstoned`, `incomplete`,
`dated_by_frozen_day`, `provisional`). `state_unreadable` is emitted when the store's
`state.json` cannot be read, so coverage intervals and `cheaper forget` tombstones are
both unknown, and `reporting.py` declines to publish totals rather than risk silently
re-including a session the user deleted. That is the same refusal
`store_newer_than_reader` makes one line below it in the same function — and it was
rendering unemphasised. The strongest disclaimer on the page, styled as an aside.

## The measured cost, versus the asserted one

The preceding session deferred this on the stated grounds that it would churn 25 visual
snapshot baselines regenerated the day before. That cost was asserted, not measured, and
it was wrong. `state_unreadable` appears in **no** Playwright fixture:

- `tests/e2e/seed.js:505` writes a well-formed `state.json`, so the state is unreachable;
- no e2e spec references chips at all;
- the slug occurs only in `cli/test/store.test.js`, `cli/test/html.test.js` and
  `gateway/tests/test_reporting.py` — all unit tests.

Then measured a second way: the full Playwright config was run before and after the
change and produced the same 4 failures with the same dimensions.

## The floor that did two jobs

The new gate asserts a scanner floor, the same defence its sibling uses. It was first
written with a floor of **four** — the same number of slugs the test also asserts
membership for. The negative control caught it: deleting `state_unreadable` dropped the
count to three, so the floor fired **first** and reported

    the warn scanner found only 3 slug(s) …; it has lost track of the expression

for a source the scanner had read perfectly. The floor was blaming the regex for a
deleted slug, and would have sent the next maintainer to the wrong file.

A floor coupled to the assertion it guards will always misdiagnose the case it was
written for. It is now a pure vacuity guard with a floor of **one**: its only job is to
catch an extraction that yielded nothing, and the named membership checks carry the
semantics with messages that say what is actually wrong.

This is the general lesson worth keeping: **the guard on a source-scanning test must be
independent of the thing that test asserts**, or the guard wins the race and lies.

## Controls, both executed and watched

- **Negative** — deleting `state_unreadable` from the expression fails with
  `"state_unreadable" tells the reader that no figure can be claimed for this window,
  but chips() renders it unemphasised` (after the floor was decoupled; before that, see
  above).
- **Over-correction** — respelling all four comparisons with double quotes, still valid
  JS and invisible to the extraction regex, fails with `the warn scanner extracted no
  slug at all … every assertion below would pass by vacuity`, not with a vacuous pass.

## Validation

| Suite | Result |
|---|---|
| `npm --prefix ./cli test` | **454 pass / 0 fail**, exit 0, four parity gates green |
| `pytest ./gateway/tests` | **459 passed** |
| `cheaper-desktop` | **34 passed** |
| Playwright, full config | **552 passed / 45 skipped / 4 failed** |

## The 4 Playwright failures are PRE-EXISTING

`[mobile]` `visual.spec.js` layouts for `#dashboard`, `#reports`, `#logs`, `#monitor`,
each exactly **19px shorter** than its baseline (2294→2275, 3086→3067, 2098→2079,
1819→1800). A uniform 19px across all four tabs is shared dashboard chrome losing one
line at 390px width, not per-tab data.

Proven not to be this work rather than argued:

- with `report.html` reverted to `fb3d73e`, the same four fail identically;
- the run before this change and the run after produce the same four, same dimensions;
- `print-reports.png`, the only snapshot that actually renders `report.html`, passes in
  both;
- `dashboard.html` is unmodified, and the concurrent `periods.py` change (`64e1d29`) is
  provably identical for every year ≥ 1000, which is every date these fixtures use.

Baselines were regenerated 2026-08-08 and the calendar has since rolled; a date-fragile
shared chrome element is the leading hypothesis. **Not diagnosed, and left open.**

## Deliberately not done

- **The baselines were NOT regenerated.** Doing so while a concurrent session held
  uncommitted edits to `peek/*`, `model_prices.json` and `sync-prices.js` would bake
  that in-flight work into committed PNGs, and would convert an undiagnosed 19px drift
  into an accepted one. Regenerating is the wrong response to a red you have not
  explained.
- `dashboard.html` and `cli/src/reports.js` carry no parallel tooltip map — they key off
  `w.status` / `o.status` — and were correctly left alone.
