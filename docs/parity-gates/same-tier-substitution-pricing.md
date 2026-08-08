# peek: a same-tier route is a MODEL SUBSTITUTION, and must be priced as one

**Date:** 2026-08-08 · **Repo:** `ownasquare.com/cheaper-app` · **Branch:** `main` (uncommitted working tree, base `ba38126`)

## What changed

`estimateCall()` in [cli/src/peek/pricing.js](../../cli/src/peek/pricing.js) priced the routed
leg only when the routed TIER differed from the caller's tier:

```js
const newCost = (routedTier == null || routedTier === actualTier)
  ? baselineCost
  : costOfModel(decision.model, toks) || 0;
```

That assumed a same-tier route costs the same as no route. It does not. The gateway rewrites
`body["model"] = decision.model` **unconditionally whenever it routes** —
`cli/assets/gateway/app/app.py:516` (`/v1/messages`) and `:835` (`/v1/chat/completions`) — so a
same-tier route still serves a **different model at a different price**.

It is now:

```js
const substituted  = routedTier != null && !sameModel(decision.model, actualModel);
const routedCost   = substituted ? costOfModel(decision.model, toks) : null;
const routedPriceable = !substituted || routedCost != null;
const newCost      = routedCost == null ? baselineCost : routedCost;
```

The test is **"is it a different model"**, not "is it a different tier". The tier is not
special-cased at all.

## Why it mattered more after the live-config work

`estimateCall` now accepts `opts.router` and adopts the gateway's real tier→id map from
`/healthz`, so *same-tier-but-different-model* became the common case rather than a rarity.
With the gateway's shipped OpenAI map `{haiku: gpt-4o-mini, sonnet: gpt-4o, opus: o3}`, a caller
on `gpt-5.6-terra` with sonnet-tier content is served `gpt-4o` — $0.35 against $0.32 on a
100k-in/10k-out call. peek reported **$0.00**.

## Measured impact (2026-08-08, 75-model catalog, shipped `ROUTE_TARGET`)

| | |
|---|---|
| same-tier substitutions | **73** |
| …that actually move a dollar at 1M-in/1M-out | **63** (the mispriced population) |
| …priced identically (correctly $0.00) | 10 |
| total understatement at 1M/1M | **$1,851.20** |
| largest single case | `o1-pro` → `gpt-5.6-sol` **$715.00** |
| next | `gpt-5.5-pro` / `gpt-5.4-pro` → `gpt-5.6-sol` $175.00 each |
| at an input-heavy 100k/10k basket | 60 understate, **3 OVERSTATE** (a real anti-saving hidden as $0.00) |

The fix **raises** peek's headline savings figure. That direction is why it was deliberately
excluded from the change that introduced the note, and why it was verified on its own here.

## Second defect, found and fixed on the same line

`costOfModel(decision.model, toks) || 0` priced an **unpriceable** route target at **zero**,
making `saved` the entire baseline — a 100% saving invented out of a missing rate, which is
exactly what this module's header forbids.

Live and reachable today via any `/healthz` map naming a model the catalog has never seen (an
operator fine-tune, or anything newer than `CATALOG_AS_OF`). Measured: an operator map with
`sonnet -> claude-internal-v9` turned a 1M/1M `claude-opus-5` row into a **$30.00 fabricated
saving**. It now books no movement and reports `routedPriceable: false`, so the zero stays
distinguishable from a measured zero.

Widening the substitution branch multiplies the ways into this, so it was closed here rather
than left for the next change.

## New API on the `estimateCall` row

| field | meaning |
|---|---|
| `substituted` | the router served a **different model id**. Distinct from `downgraded`, which is strictly about TIER rank. |
| `routedPriceable` | `false` only when a route was really taken and its target has no published rate. `newCost === baselineCost` then means *"no figure available"*, not *"measured no change"*. |

`sameModel(a, b)` is exported: catalog-entry equality when both ids resolve (so an alias, a
dated snapshot or a vendor prefix is not read as a substitution of a model with itself), the
normalised id text when neither does, and `false` across the catalog line.

## Tests — all proved by mutation

Added to [cli/test/policy_parity.test.js](../../cli/test/policy_parity.test.js) §3b:

1. **a same-tier route is priced as the SUBSTITUTION it is** — `o1-pro` → `gpt-5.6-sol`, $715.00,
   `downgraded: false` / `substituted: true`; plus a catalog-wide sweep pinning 73 / 63 / $1,851.20.
2. **a same-tier route that COSTS money is reported as a loss** — operator map via `opts.router`,
   `gpt-5.6-terra` → `gpt-4o`, `saved = -$0.03`, `extra = $0.03`, unclamped.
3. **a route that serves the CALLER'S OWN model moves no dollar** — the identity guard, across
   dated / prefixed / cased spellings.
4. **an UNPRICEABLE route target books no saving** — the `|| 0` fabrication.
5. **THE COMPOSITION INVARIANT** — a total sweep over catalog × tiers × 6 router configs:
   `substituted ⇒ newCost is the served model's price (or the row says it has none)`, and
   `!substituted ⇒ newCost is the caller's own price`. Also re-derives `saved`/`gross`/`extra`
   on every row so a suppression cannot hide in the decomposition.

Mutation results against the shipped file:

| mutant | tests that failed |
|---|---|
| `substituted = routedTier !== actualTier` (the old tier test) | #1, #2 |
| `substituted = decision.model !== actualModel` (raw `===`) | #3 |
| `newCost = substituted ? (routedCost \|\| 0) : baselineCost` | #4, #5 |

Each mutant was restored byte-identically and re-verified green.

`cli/test/peek.test.js` — the end-to-end fixture assertion moved from the band
`> 80 && < 90` to an exact **$144.00**. The extra $60.00 is the security row: a `claude-opus-4`
caller served `claude-opus-5` (same opus tier, no downgrade) at $90.00 → $30.00. It was real,
bankable, and reported as $0.00.

## Should `check-policy-parity.js` gain a GATE 3 on the served model id?

**No — and that is a conclusion, not an omission.** Recorded in the gate's own header.

GATE 2 **already** compares the served id (`d.model === pyModel`, not just the tier). It was
green throughout this defect, *correctly*: both runtimes answered `opus, gpt-5.6-sol` — they
agreed. `sync-prices.js` was green too, because both runtimes price `gpt-5.6-sol` identically.
A third parity gate on the served id would have been a third green light.

The gap was **inside peek, between its two halves**: the router named a model and the estimator
priced a different one. No question asked of *both runtimes* can see that, because both halves
are JS. The invariant that catches it is a composition one and lives in the node suite
(test #5 above), where `routeDecision` and `estimateCall` compose directly and no interpreter is
needed. Putting it in the parity script would have widened a script whose entire contract is
"ask both runtimes the same question" into one that no longer states what it checks.

## Known follow-up (NOT done — deliberately)

`downgradable` and the dollars now count **different populations**. `est.downgraded` is strictly
tier rank; the dollars are the served model. So `dollarsSaved` can be non-zero while
`downgradable` is 0, and on the surfaces that print them side by side —
`cli/src/peek/render.js:172` and `:210`, *"N downgradable"* next to *"you'd save $X"* — **X can no
longer be derived from N**. Both numbers are true; a reader is entitled to reconcile them, so
either the wording or the counter has to change.

Not done here because widening `downgradable` to mean "substituted" changes a headline **count**
that every surface and several tests already read, on the back of a change whose remit was the
per-call arithmetic. `est.substituted` is the field to count when it is done. A note recording
this sits at the `est.downgraded` site in `cli/src/peek/scan.js`.

`routedPriceable` is likewise **not** yet wired into scan.js's exclusion counters
(`unpriced` / `unpricedTokens` are about the ACTUAL leg). Unreachable with the shipped
`ROUTE_TARGET`; reachable via a live operator map.

## Validation (all re-run after the change)

| command | result |
|---|---|
| `cd cheaper-app/cli && node --test test/` | **423 pass, 0 fail** |
| `cd cheaper-app && python3 -m pytest cli/assets/gateway/tests -q` | **458 passed** |
| `cd cheaper-app/cli && node scripts/sync-prices.js --check` | exit 0 |
| `cd cheaper-app/cli && node scripts/check-period-parity.js` | exit 0 |
| `cd cheaper-app/cli && node scripts/check-policy-parity.js` | exit 0 — GATE 0/1a/1b/2, 144,180 decisions agree |
| `cd cheaper-app && npx playwright test` | **525 passed, 45 skipped, 0 failed** |

**Concurrency note.** Another agent was editing this working tree throughout the session
(`cli/assets/gateway/app/dashboard.html`, `cli/test/html.test.js`, `cli/assets/gateway/app/metrics.py`,
`router.py`, and a new `cli/test/period_parity_gate.test.js`). Mid-session aggregate runs showed
1–3 transient `html.test.js` failures and a test count drifting 395 → 408 → 418 → 423; those files
were being rewritten *while the runner read them* (`html.test.js` mtime landed one second before a
`date` probe), they have **zero** dependency on `pricing.js` (grep: 0 references), and they passed
80/80 in isolation. The final runs above are all green. The Playwright run also had to wait on the
other agent's run lock — the lock guard refused rather than deleting a live run's `metrics.db`, and
the lock was **not** overridden.

## Files touched

- `cli/src/peek/pricing.js` — the fix, `sameModel()`, `substituted` / `routedPriceable`
- `cli/test/policy_parity.test.js` — §3b, five tests
- `cli/test/peek.test.js` — fixture assertion $84 band → exact $144.00
- `cli/scripts/check-policy-parity.js` — header: why there is no GATE 3
- `cli/src/peek/scan.js` — comment only, recording the `downgradable` reconciliation gap
