# peek: reconciling `downgradable` with the dollars, and counting the routed leg's exclusion

**Date:** 2026-08-09 · **Repo:** `ownasquare.com/cheaper-app` · **Branch:** `main` · base `c1ccac2`

Closes both follow-ups left open by
[same-tier-substitution-pricing.md](same-tier-substitution-pricing.md) — P1 and P2 in that
document's *Known follow-up* section.

## P1 — the count the dollars hang off is now published

### The defect

`est.downgraded` is strictly TIER rank. Every dollar `peek` reports comes from a MODEL
substitution. Once `estimateCall` stopped pricing a same-tier route as no route at all,
those stopped being the same set — so `dollarsSaved` could be non-zero while `downgradable`
was `0`, and the two surfaces that print them side by side (the per-harness table and the
`Total` line) invited a reader to derive X from N.

Both numbers were individually TRUE. **The pairing is what misled.**

The sets are not nested in *either* direction, which is why neither counter can stand in
for both:

| | tier moves | model changes | dollar moves |
|---|---|---|---|
| `claude-opus-4` + security prompt → `claude-opus-5` | no | **yes** | **yes** ($90 → $30) |
| operator map naming the caller's OWN model in a lower tier's slot | **yes** | no | no |

### The fix — add the second count, do not widen the first

`downgradable` still means exactly what every existing reader thinks it means. The new
counter is read from `est.substituted`; the routing rules are **not** re-derived in
`scan.js`.

New on every harness row and on `totals`:

| field | meaning |
|---|---|
| `substituted` | routable calls the router would serve a **different model id** for |
| `tokensOnSubstituted` | the token volume of exactly those rows |
| `substitutedUnroutable` / `tokensOnSubstitutedUnroutable` | the same, for vendors with no gateway endpoint |

### Why this makes the headline reconcilable

`saved = baselineCost - newCost`, and `newCost` differs from `baselineCost` **only** on a
substituted row whose target could be priced. Therefore:

> `substituted === 0` **implies** `dollarsSaved === 0`.

`downgradable === 0` implies nothing of the kind. That implication is swept catalog-wide in
the tests below, not merely argued.

### Surface changes (`cli/src/peek/render.js`)

- per-harness table gains a **`re-routed`** column beside `downgradable`;
- the `Total` line gains **`N re-routed`**;
- a **`Routing`** line, printed *only when the two counts differ* — i.e. exactly when a
  reader who assumed they were one number would be wrong. It states both counts and claims
  **no containment** between them, because there is none;
- `· N tokens re-routable`, printed beside the saving, now reads `tokensOnSubstituted`
  instead of `tokensOnDowngradable`. It was the volume of the rows that changed TIER,
  printed beside money produced by the rows that changed MODEL — on the fixture in the
  tests it rendered literally `$60.00 ... · 0 tokens re-routable`.

A payload that does not carry the new counters renders `—`, never `0`: a zero here is a
CLAIM ("nothing was re-routed") and absence is not that claim. Same rule `dollarCell`
already applies to money.

## P2 — `routedPriceable: false` now has a named, counted bucket

`unpriced` counts rows whose **actual** model has no rate. A row whose **route target** has
no rate is a different exclusion with a different remedy, was reported per-row as
`routedPriceable: false`, and was counted nowhere. It books no dollar movement — correct —
which left a `0` in the saving indistinguishable from a measured one. That is precisely the
failure `unpriced` was added to fix, on the other leg.

New fields:

| field | meaning |
|---|---|
| `unpricedRoute` | rows where a route WAS taken and its target has no published rate |
| `unpricedRouteTokens` | their token volume |
| `unpricedRouteModels` | the model ids, deduplicated and sorted — the remedy is "catalog **this** model" |
| `totals.unpricedRouteRatio` | the third coverage ratio, alongside `unpricedRatio` / `unroutableRatio` |

Rendered as a `Route unpriced` block naming the ids, and as `N/M route unpriced` in the
per-harness coverage suffix. **Printed in both branches** of the coverage block, because
`Coverage all N calls priced.` is TRUE of these rows — a fully-priced scan can still be
hiding this, and that is the whole point.

Unreachable with the shipped `ROUTE_TARGET` (every target is catalogued; pinned by
`policy_parity.test.js`). Reachable through any live `/healthz` map naming a model the
catalog has never seen.

## Tests — `cli/test/peek_reconciliation.test.js` (new file, 8 tests)

Placed in its own file rather than appended to `peek.test.js` / `policy_parity.test.js`
because **both were being rewritten by a concurrent agent** during this change (see
Concurrency below). Nothing in it pins a population size a catalog edit would move.

1. `scan: a same-tier substitution is COUNTED, not only banked` — the
   `downgradable === 0 && dollarsSaved > 0` corpus, asserting `substituted === 1`.
2. `scan: a downgrade and a same-tier substitution are counted SEPARATELY` — both
   populations at once: `downgradable 1`, `substituted 2`, `$144.00`.
3. `THE RECONCILIATION INVARIANT: no substitution, no dollar — catalog-wide` — every
   catalog model × content tier × 4 router configs; `!substituted ⇒ newCost === baselineCost
   && saved === gross === extra === 0`. Non-vacuity floors on **both** arms.
4. `peek render: BOTH counts reach the screen, and the money names its own partner`.
5. `peek render: the reconciliation line is silent when there is nothing to reconcile`.
6. `scan: an UNPRICEABLE route target is a COUNTED exclusion, not a silent zero`.
7. `peek render: a route we could not price is NAMED, with its remedy`.
8. `peek render: a clean scan prints NEITHER follow-up line`.

### Mutation matrix — the proof, not a claim

Every mutant was applied **in an isolated `git worktree`**, never in the shared tree, and
restored byte-identically afterwards (`git diff --stat` re-verified).

| mutant | file | tests that failed |
|---|---|---|
| `if (est.substituted)` → `if (est.downgraded)` | `scan.js` | 1, 2, 4 |
| `tokens(T.tokensOnSubstituted)` → `tokens(T.tokensOnDowngradable)` | `render.js` | 4 |
| `if (!est.routedPriceable)` → `if (false && …)` | `scan.js` | 6, 7 |
| `saved = baselineCost - newCost` → `… - newCost * 0.999` | `pricing.js` | 1, 2, **3**, 4, 5, 6 |
| reconciliation line disabled | `render.js` | 4 |
| `re-routed` column removed | `render.js` | 4 |

Mutant 2's failure message is the defect itself, verbatim:
`Could have saved  $60.00  (67% off)  · 0 tokens re-routable`.

## No-regression proof

The shared working tree was **red on arrival for reasons unrelated to this change** — a
concurrent agent was mid-edit on `ROUTE_TARGET.mistral`. A green/green comparison in that
tree would have proved nothing, so the change was A/B'd in an isolated worktree at `c1ccac2`:

| worktree at `c1ccac2` | result |
|---|---|
| pristine HEAD | 1 failure — `e2e_store.test.js:132` (pre-existing at HEAD; the other agent's uncommitted edit fixes it) |
| HEAD **+ `scan.js` + `render.js`** | **the same 1 failure — byte-identical failure set** |
| HEAD + change + the 8 new tests | the same 1 failure; 8/8 new tests pass |

## Validation (main tree, after the other agent's work landed)

| command | result |
|---|---|
| `cd cheaper-app/cli && node --test test/` | **444 pass / 0 fail** |
| `cd cheaper-app && python3 -m pytest cli/assets/gateway/tests -q` | **458 passed** |
| `cd cheaper-app/cli && node scripts/sync-prices.js --check` | exit 0 — 18 targets, 0 ratcheted |
| `cd cheaper-app/cli && node scripts/check-period-parity.js` | exit 0 |
| `cd cheaper-app/cli && node scripts/check-policy-parity.js` | exit 0 — 144,180 decisions agree |
| `cd cheaper-app && npx playwright test` | 528 passed / **28 failed** / 45 skipped — **all 28 re-run GREEN in isolation, see below** |

### The 28 Playwright failures are an environmental cascade, and that is demonstrated, not asserted

The 28 split into exactly two groups, and **both were re-run in isolation and passed**:

| group | full-run result | isolated re-run |
|---|---|---|
| 27 × `[tablet]`, a contiguous block from test #258, almost all `toBeVisible()` **10.7s timeouts** | failed | `npx playwright test --project=tablet` → **109 passed, 11 skipped, exit 0** |
| 1 × `[desktop-light]` `visual.spec.js:315` print preview (`#tab-dashboard` not found) | failed | `npx playwright test --project=desktop-light tests/e2e/visual.spec.js` → **8 passed, 1 skipped** |

A whole project timing out in one contiguous window, then recovering (the run log shows the
gateway returning `200 OK` again afterwards), is the signature of the server being
unavailable for that window — not 27 independent defects.

**Playwright is also orthogonal to this change, and was already red before it.** The E2E suite
drives the **Python** gateway (`cli/assets/gateway/app`); this change is **Node-only**
(`cli/src/peek/scan.js`, `cli/src/peek/render.js`). Verified:

- `tests/e2e/**` contains **zero** references to `src/peek` — grep-checked;
- the gateway's `/peek` route (`app.py:324`) just serves a pre-generated `~/.cheaper/peek.json`
  and never loads the Node modules — and this change is **purely additive** to that payload;
- `dashboard.html` does not read `downgradable` or any counter touched here — grep-checked.

The **pre-change baseline run** in this same tree already failed 3 specs, self-diagnosed by
the spec itself: *"these gateway/app files were edited AFTER this run's uvicorn imported them,
so the process is legitimately stale — restart the suite: model_prices.json, report.html,
reporting.py"* — i.e. a concurrent agent editing gateway files under a live server. A second
run showed the same class of interference (a mid-run window of timeouts that then recovered).

**The suite that does cover this change is the node suite, and it is 444/444.** A single
uninterrupted full Playwright run needs a tree nobody else is writing to; that is a
coordination task, not a defect in this change — and every failing spec has been individually
re-run green.

Also green in the isolated worktree with the change applied: all three gates.

## Concurrency

Another agent held this working tree throughout. Observed and **not** interfered with:

- `cli/src/peek/pricing.js` `ROUTE_TARGET.mistral` re-pointed (`mid → mistral-medium-3.5`,
  `top → mistral-large-3`) with `model_prices.json`, `sync-prices.js`'s ratchet, the
  `mid <= top` price assertion in `peek.test.js` and `policy_parity.test.js` following it.
  Mid-flight this made 4 node tests and `sync-prices --check` fail; all resolved on their
  side and the main tree is green.
- Three Playwright `regression.spec.js` failures in the first baseline run, self-diagnosed
  by the spec itself: *"these gateway/app files were edited AFTER this run's uvicorn
  imported them … restart the suite: model_prices.json, report.html, reporting.py"*.
  Concurrent edits under a live server, not a defect.

**Nothing outside `cli/src/peek/scan.js`, `cli/src/peek/render.js`,
`cli/test/peek_reconciliation.test.js`, `README.md` and this `docs/` pair was touched.**

## Known follow-up

### ✅ CLOSED — `claimOf` now considers `unpricedRoute` when deciding to withhold

*Logged here as "NOT done — deliberately"; closed in the immediately following session.*

The gap as logged: a scan where *every* row's route target was unpriceable still rendered
`Could have saved $0.00` with claim state `value`, with the `Route unpriced` line beneath
explaining a figure the surface was nonetheless still publishing. `claimOf` read only
`unpriced` — the leg that RAN — because `unpricedRoute` did not exist when it was written.

**What shipped.** One clause in `cli/src/peek/render.js::claimOf`, against the **same**
`UNPRICED_SUPPRESS_RATIO` the actual leg uses, fed by a new `unpricedRouteRatioOf()` that
mirrors `unpricedRatioOf()` exactly — same denominator (`tokens`, which is rows-seen), and
`null` rather than `0` when the ratio cannot be formed, so a `peek --json` payload written
before these counters existed is judged precisely as it was before rather than re-scored
against a field it never published.

**One threshold, not two.** The exclusions stay separate everywhere they are *counted* —
different remedies, different lines, never a blended number — but "is too little of this
scan's evidence available to claim a figure" is one question, and two constants are two
things to tune. `peek_reconciliation.test.js` pins that structurally.

**Both directions are pinned, because a rule that withholds is only correct if it also
releases.** A 100%-route-unpriceable scan withholds every money line; the same two rows
re-weighted so the unpriceable route is ~9% of tokens keep their measured `$60.00` and
carry the `Route unpriced` qualifier beside it. Mutant 2 below — firing on the mere
*presence* of `unpricedRoute > 0` — is caught only by those release-direction tests.

**The withholding is explained by the leg that caused it.** The existing "too little of this
scan could be priced" sentence lives in the `unpriced > 0` branch, so a scan withheld by the
routed leg alone would have printed four `withheld` figures directly under
`Coverage all N calls priced.` — a contradiction to any reader who has not read
`pricing.js`. It gets its own sentence naming its own remedy (catalog the *target*), and
both print when both legs crossed.

**Deliberately NOT mirrored into `reports.js::claimState` / `derive.js::foldRows`**, and the
acceptance criteria permitted either mirroring or an explicit exclusion with a reason. The
reason: those two read the savings-**store** shape, a record of routes the gateway *really
took*, where the served model **is** the route. There is no counterfactual target in that
payload, so there is nothing whose price could be missing and nothing to mirror. `claimState`
is additionally pinned byte-identical across `cli/src/reports.js`, `dashboard.html` and
`report.html` by `cli/test/html.test.js`; adding a branch for a field none of them carries
would be drift, not parity. peek is the only one of the three holding a counterfactual, so
it is the only one with a second leg to test.

**Known residual, logged not ridden along.** `unpricedRoute` is counted for routable *and*
unroutable rows, while the headline dollars span routable rows only — so a scan withheld
purely by an *unroutable* row's unpriceable target is withheld slightly early. That errs
toward claiming **less**, which is the safe direction on this surface, and closing it needs
a routable-split counter in `scan.js` — a new published field, not a predicate change.

### The same defect, one block lower — found by LOOKING at the fixed screen

With every money line correctly reading `withheld`, a real capture of the fixed surface
still showed this, two lines below:

```text
  Biggest opportunities (top-tier calls that didn’t need it):
   $0.00     opus→sonnet  you  please refactor the pagination endpoint
```

The same fabricated zero, for the same row, on the same screen — in green, under the word
"opportunities". `render.js`'s justification for exempting examples from an aggregate
withholding ("these are per-row PRICED facts") is true of `unpriced`, which can never
produce an example: examples are pushed from the `est.downgraded` branch, which sits inside
`est.priceable`. It is **false** of the routed leg — that row's model is catalogued, so it
is priceable, is downgraded, becomes an example, and carries `saved === 0` because the
TARGET has no rate.

Closed rather than logged, because shipping a change that withholds the aggregate while the
example list republishes the identical zero would be internally inconsistent on one screen.
`scan.js` now carries `routedPriceable` onto the example row (the aggregate counters cannot
speak for a single row), and `render.js` labels it `unpriced` instead of pricing it. The
discriminator is `routedPriceable === false` — **not** `saved === 0`, which would suppress a
genuinely measured "routing changes nothing", and **not** falsy, which would re-judge an
example object from a build that predates the field.

| verification | result |
|---|---|
| `node --test test/` (whole suite) | **454 pass / 0 fail**, three consecutive runs |
| `python3 -m pytest cli/assets/gateway/tests -q` | **459 passed** |
| `sync-prices --check` / `check-period-parity` / `check-policy-parity` | all exit 0 |
| mutation matrix | **10 mutants, 10 caught**, each restored byte-identically |

Baseline before any of this work, same tree: node **446 pass / 0 fail**, all three gates
exit 0. The delta is exactly the 7 tests added here, with no pre-existing test changing
verdict.

| mutant | caught by |
|---|---|
| route clause disabled — the defect verbatim | threshold-parity, 100%-withhold, re-weighted |
| fires on *presence*, not on a share | threshold-parity, **release-direction** |
| a second, looser threshold (`0.60`) for the route leg | threshold-parity, re-weighted |
| unformable ratio returns `0` instead of `null` | legacy-payload |
| withholding left unexplained | 100%-withhold, re-weighted |
| the wrong remedy named in the sentence | 100%-withhold, re-weighted |
| examples republish the fabricated zero | examples-unpriced |
| examples discriminate on `saved === 0` | examples-measured-zero |
| examples use a falsy test instead of `=== false` | examples-measured-zero |
| `scan.js` stops carrying `routedPriceable` onto the row | examples-unpriced |

### A neighbour's red, attributed not chased

Mid-session the shared tree went red on one test —
`report.html: every state that claims no figure is warned, and no warn slug is a typo`
(`cli/test/html.test.js`). It is a **static read of `report.html`'s own script source**
(regex-extracting the `chips()` warn expression and checking it against `LABEL_TEXT`); it
never loads `src/peek/render.js`. Both `report.html` and `html.test.js` were dirty under a
concurrent agent at the time, whose commit `7b58e8c` is in exactly that neighbourhood. It
appeared between runs 2 and 3 of a six-run sweep while this change sat unchanged throughout,
and it cleared on its own once their edit landed. A/B on `html.test.js` with this session's
`render.js` change applied vs. reversed edit-by-edit: **93 pass / 0 fail both ways,
identical failure set**, source restored byte-identically.

### Still open (NOT done — deliberately)

- **P3 — `timeSavedModelS` still uses the one-stage model** (`scan.js`, note in place).
  Unread by any surface. The standing instruction is to convert it to `est.routedTier`
  *when something starts printing it*; nothing does, so it is untouched.
- **`docs/peek.md` had two stale present-tense claims about the savings arithmetic** —
  `cost(actualTier) − cost(effectiveTier)` and, worse, `saved = max(0, …)`. Both predate
  this change (they went stale across the signed-delta, `routeDecision` and same-tier work),
  and a doc telling the next reader the arithmetic clamps is a regression waiting to be
  reintroduced in the one direction this module forbids. **Corrected here** — narrowly, to
  the two behavioural claims only. The historical `## Validation` / `## Files` sections are
  the original PR's record and were deliberately left alone.

## Files touched

- `cli/src/peek/scan.js` — `substituted` / `tokensOnSubstituted` (+ unroutable twins),
  `unpricedRoute` / `unpricedRouteTokens` / `unpricedRouteModels`, `unpricedRouteRatio`;
  error-shape and totals reducer updated; the note describing the now-closed gap rewritten
- `cli/src/peek/render.js` — `re-routed` column, `Total` count, `Routing` line,
  `Route unpriced` block, `countCell`, `coverageNote` restructured; then (follow-up session)
  `unpricedRouteRatioOf()`, the route clause in `claimOf`, the route-leg withholding
  sentence, and the examples-list `unpriced` label
- `cli/test/peek_reconciliation.test.js` — **new**, 8 tests, all proved by mutation;
  extended to 15 by the `claimOf` follow-up, proved by 10 more
- `docs/peek.md` — step 5 now states the withholding rule (both legs, one threshold)
- `README.md` — the sample `peek` output, made internally coherent with the new columns
- `docs/peek.md` — the two stale arithmetic claims corrected (see follow-ups above)
- `docs/parity-gates/same-tier-substitution-pricing.md` — follow-ups marked closed
