# Verifying every catalog price, and the OpenAI long-context tier that was missing

**Date:** 2026-08-09
**Repo:** `/Users/fortunevieyra/Documents/Github/ownasquare.com/cheaper-app`
**Branch:** `parity-gates/one-python-launcher`
**State at write time:** UNCOMMITTED, in a tree that also holds two other agents' in-flight
workstreams (see "Concurrent writers").
**Predecessor:** `docs/parity-gates/2026-08-09-mistral-route-target-tier-correction.md`
and `beladed.com/docs/handoffs/2026-08-09-claude-mistral-route-target-tier-correction.handoff.mdc`

---

## Why this ran

The predecessor corrected `ROUTE_TARGET.mistral` so its mid and top slots name models of
their own capability tier. It closed with an explicit, self-declared risk (its INVENTORY
Item 2, P1):

> The corrected **top** slot now depends on that inversion being real. If the two rows'
> prices are transposed, the opus slot names the wrong model and the Mistral
> counterfactual is wrong in the unroutable bucket.

That is a pricing question, and pricing is what this product sells. So every row in the
catalog was re-read against its vendor's own page, not just the two that were flagged.

## What was verified

All six sources named in `models.js` were re-read on **2026-08-09**:

| Family | Rows | Result |
|---|---|---|
| Mistral | 14 | all 14 match to the cent |
| OpenAI | 27 | all 27 base rates match; **6 were missing a published long-context tier** |
| Google | 8 | all 8 match, including both 200k long-context tiers |
| xAI | 4 | all 4 match, including all four 200k long-context tiers |
| DeepSeek | 2 | both match |
| Anthropic | 20 | 16 match; 4 retired rows no longer carried by the vendor |

**71 of 75 rows were confirmable against a live sheet, and every one of them already
matched.** No base rate, cache rate, or capability tier was wrong. The catalog was in
better shape than the predecessor's own risk note assumed.

### Item 2 is resolved: the Mistral inversion is real

`mistral-large-3` = **$0.5 / $1.5** (tier opus) and `mistral-medium-3.5` = **$1.5 / $7.5**
(tier sonnet), confirmed on `mistral.ai/pricing/api` and independently by a price
aggregator. Mistral's flagship genuinely costs less than its mid model — $2.00 against
$9.00 on a 1M/1M basket. `ROUTE_TARGET.mistral.top` therefore rests on a verified fact,
and the `capability tier and price rank are allowed to disagree` test is pinning something
true rather than something transcribed. **No change was needed.**

### Anthropic's modifiers all reconciled

Cache multipliers 0.1x read / 1.25x 5m write / 2x 1h write; the Opus 5 and Opus 4.8 fast
mode SKU at $10/$50; the 50% batch discount; and Sonnet 5's introductory window at $2/$10
through 2026-08-31 with cache rates 0.20 / 2.50 / 4.00 — every one matches what
`models.js` already encodes.

The 4 unconfirmable rows are `claude-3-opus`, `claude-3-7-sonnet`, `claude-3-5-sonnet` and
`claude-3-haiku`. They are retired and no longer appear on the pricing page. They are
**kept deliberately**: peek prices a historical call at the rates in force the day it
happened, so deleting them would make an old transcript *unpriceable* rather than
correctly priced, and a retired model gets no new traffic to go stale against.

## The defect: OpenAI's 272k long-context tier was absent

OpenAI publishes a second price tier above **272,000 input tokens** for six models. The
catalog carried none of them, so every request over that size was priced at the short
rate — **input understated 2x, output understated 1.5x**.

| model | short in/out | long in/out (>272k) | long cache read |
|---|---|---|---|
| `gpt-5.6-sol` | 5 / 30 | **10 / 45** | 1.00 |
| `gpt-5.6-terra` | 2 / 12 | **4 / 18** | 0.40 |
| `gpt-5.6-luna` | 0.2 / 1.2 | **0.4 / 1.8** | 0.04 |
| `gpt-5.5` | 5 / 30 | **10 / 45** | 1.00 |
| `gpt-5.4` | 2.5 / 15 | **5 / 22.5** | 0.50 |
| `gpt-5.4-pro` | 30 / 180 | **60 / 270** | none published |

This is not a counterfactual-only error. It moved `actualCost` — the figure peek reports
as **money already spent** — so it was a wrong number in front of the user, which is the
exact failure `models.js`'s header exists to prevent.

Three details worth keeping:

1. **The higher rate applies to the WHOLE request** once the threshold is crossed, not to
   the excess tokens. That is already what `ratesFor()` does for Google and xAI ("this
   replaces the rates rather than blending"), so no new machinery was needed.
2. **No `cacheWrite` is restated on the long rows.** `ratesFor()` rescales it inside the
   model's own sheet (`lc.in * cacheWrite/in`), and that derivation reproduces OpenAI's
   published long cache-write rates **exactly** — $12.50 / $5.00 / $0.50 for sol / terra /
   luna. Writing them out again would be a second copy that can drift.
3. **`gpt-5.5-pro` is deliberately excluded.** Third-party trackers claim it takes the same
   2x/1.5x uplift; OpenAI's own page shows it as `<272K` only. The catalog does not encode
   a rate the vendor has not published, so it has no long tier and prices at list for any
   size. A test pins that absence, with the reason.

`CATALOG_AS_OF` moves `2026-08-06` → `2026-08-09`, which is what re-reading all six
sources earns.

## What moved, and why none of it is a regression

**No route changed its tier or its served model.** Measured across the whole catalog
before touching source, by injecting the proposed tiers at runtime: every one of the 225
(model, content) decisions kept the same `routedTier` and `routedModel`. The ceiling ranks
every model on the same fixed 1M/1M basket, so the new rates preserved the existing order.
Only dollars moved.

Two pinned numbers moved, both in `policy_parity.test.js`:

- **`o1-pro` -> `gpt-5.6-sol` saving: $715 -> $695.** The basket is 1M input, which is
  above 272k, so `gpt-5.6-sol` really bills $10 + $45 = $55 here, not $35. `o1-pro`
  publishes no long tier and stays at $750. $750 - $55 = **$695**. The old $715 was the
  arithmetic of a rate OpenAI does not offer at this prompt size.
- **Same-tier substitution census: $1851.20 -> $1803.50 (predecessor) -> $1783.50.**
  `n` (63) and `moved` (53) did **not** change.

The $20.00 reconciles pair by pair, with no residue:

```
gpt-5.6-sol is the openai opus target: $35 -> $55 at 1M/1M (+$20)

  six opus-tier models routed onto it, none with a long tier of its own:
    gpt-5.5-pro/opus   175.00 -> 155.00    -20.00
    gpt-5.2-pro/opus   154.00 -> 134.00    -20.00
    gpt-5-pro/opus     100.00 ->  80.00    -20.00
    o1-pro/opus        715.00 -> 695.00    -20.00
    o1/opus             40.00 ->  20.00    -20.00
    o3-pro/opus         65.00 ->  45.00    -20.00
  one that DOES publish a long tier, so its own basket rose further than its target's:
    gpt-5.4-pro/opus   175.00 -> 275.00   +100.00   ($210 -> $330 vs target $35 -> $55)

  6*(-20) + 100 = -20   =   1803.50 - 1783.50
```

## Proof

**The moved numbers were verified against the OLD condition, not read off the new code.**
Per §6.4 discipline, the six `longContext` entries were stripped back off the live catalog
and the census re-run: it reproduced **715 / 63 / 53 / $1803.50 exactly**. The method is
therefore sound, and the values it yields under the new condition are trustworthy.
Independently, hand-arithmetic from the published sheet gives $750 − $55 = $695.

**Mutation (a gate that cannot fail is not a gate).** Four mutations, each restored
byte-for-byte afterwards:

| mutation | independent failures |
|---|---|
| delete the `gpt-5.6-sol` long tier (the pre-fix state) | **4** |
| transpose `gpt-5.4` long in/out (5/22.5 -> 22.5/5) | **3** |
| invent the unpublished `gpt-5.5-pro` long tier | **3** |
| drift the threshold 272000 -> 200000 | **3** |

Restored: 0 failures, file byte-identical.

**Suite.** `npm test` green — all four gates (`sync-prices --check`,
`check-period-parity`, `check-policy-parity` at 144,180 decisions with `exclusions: none`,
`--help`) plus `node --test` **446/446**; `pytest` **459/459**.

Baseline before any edit, same tree: **444/444** node, **458/458** pytest, four gates
green, `route targets: 18 entries resolve; 0 known tier mismatch(es) ratcheted`.

**Cross-runtime parity is the load-bearing one here.** The parity probe prices every
catalog id at 1M in / 1M out — *above* the 272k threshold — so it exercises the new tiers
directly, and it reports `82 ids agree`. `GATE 1b — CEILING INPUT: 89 ids agree across all
5 route maps` and `GATE 2 — ROUTING DECISION: 144180 decisions agree` both hold, which is
what proves the Python port applies the long tier identically. `pricing.py::rates_for`
needed no change: it already reads `longContext` generically and scales `cacheWrite` from
`base_in` the same way JS does.

## New tests

- `OpenAI long-context tiers match the published 272k sheet` — pins all six per-model,
  and asserts every *other* OpenAI row has no long tier. Pinned by value rather than by
  shape because every one of these is exactly 2x/1.5x, so a generic "long >= short"
  invariant would pass on a transposed or halved figure.
- `a call over 272k input is billed at the long tier, and one under it is not` — 100k/10k
  stays at $0.80; 300k/10k is $3.45; exactly 272,000 is still short and 272,001 is long;
  cache reads count toward the threshold; a long cache write derives to the published
  $12.50; and a model with no long tier is unaffected at any size.

## Known gaps, deliberately not closed here

- **`gpt-5.5-pro`'s long tier is disputed** — vendor page says none, third-party trackers
  say 60/270. Encoding an unpublished rate is the one thing this catalog must not do.
  Re-check on the next sweep.
- **xAI's threshold is `>=200k` on the vendor page but `> 200000` in `ratesFor`.** A
  one-token boundary difference, pre-existing, affecting a request of exactly 200,000
  tokens. Not changed here because tightening it is an unverified precision claim that
  would also churn pinned numbers; logged instead.
- **OpenAI Flex and priority service tiers.** `ratesFor` applies a generic `priority` 1.8x
  to every family. OpenAI publishes Flex and Fast tiers whose real multipliers were not
  confirmed. Only reachable when input data carries an explicit `serviceTier`.
- **Anthropic's `inference_geo: "us"` 1.1x multiplier** and the 10% regional-endpoint
  premium are not modelled. No current input carries the flag.
- **Google's per-hour context-cache storage** remains deliberately omitted — it is not
  attributable to a single call, as `models.js` already documents.

## Concurrent writers — read before interpreting any count

A second agent was writing to this tree throughout. `cli/assets/gateway/app/periods.py`,
`cli/assets/gateway/tests/test_metrics.py` and
`docs/parity-gates/2026-08-09-periods-py-year-padding-on-glibc.md` all appeared during the
session and belong to that workstream; pytest moved 458 -> 459 for that reason, not
because of this change. This change touched exactly four files:

```
cli/src/peek/models.js
cli/test/peek.test.js
cli/test/policy_parity.test.js
cli/assets/gateway/app/model_prices.json   (regenerated)
```

Do **not** `git add -A` here.
