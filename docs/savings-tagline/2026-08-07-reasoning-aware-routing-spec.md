---
description: >-
  Reasoning-aware routing: joint (model, reasoning-effort) selection with a
  context-sufficiency gate. Produced 2026-08-07 by a 3-design / 3-judge /
  1-synthesis workflow, with every load-bearing price claim recomputed against
  model_prices.json through the repo's own pricing.cost_of_model.
alwaysApply: false
---

I have verified every load-bearing fact against the repo. Writing the spec.

---

# Reasoning‑Aware Routing — Final Implementation Spec

**Repo:** `/Users/fortunevieyra/Documents/Github/ownasquare.com/cheaper-app`
**Base design:** `evidence-first`, with the graft list applied and one structural defect repaired.
**Default:** **OFF.** `CHEAPER_EFFORT_MODE=observe`. No release ever flips it.

---

## 0. What was verified before writing this

Every number below was computed against `cli/assets/gateway/app/model_prices.json` (`as_of 2026-08-06`, 75 entries) through the repo's own `pricing.cost_of_model`. Nothing here is quoted from the design documents.

| Claim | Verdict |
|---|---|
| All 20 Anthropic catalog entries have `out/in = 5.0`, `cacheRead/in = 0.1`, `cacheWrite/in = 1.25`, `cacheWrite1h/in = 2.0` | **CONFIRMED — 0 exceptions**, promo window included |
| ⇒ `cost(m,e) = in_rate(m) · f(basket, T)` ⇒ model rank is invariant across rungs ⇒ **0 equal‑rung flips within Anthropic** | **CONFIRMED, structurally.** Verified ratio 1 : 3 : 5 holds exactly at every rung (`0.00900/0.02700/0.04500` at off; `0.09092/0.27276/0.45460` at high) |
| `out/in ≤ 2.0` for 10 of 75 entries; five at exactly 1.0; range 1.0 → 8.333 | **CONFIRMED** |
| The catalog carries **no reasoning metadata of any kind** — keys are exactly `aliases, cacheRead, cacheWrite, cacheWrite1h, family, id, in, longContext, out, speed, tier, window` | **CONFIRMED** |
| `_RANK_BASKET` (1M in / 1M out) is effort‑blind | **CONFIRMED and worse than stated**: +16384 thinking tokens moves it **1.365 %** ($6.000000 → $6.081920). Below any sane tolerance. |
| `reporting.decision_of` returns `"kept"` whenever `canonical(served) == canonical(base)` | **CONFIRMED**, `reporting.py:479-480`. `metrics._decision_type` (`metrics.py:165`) has the same tier‑only defect. |
| `requested_effort` is already a column, written on every row | **CONFIRMED** — `metrics.py:255` (migration), `:385` (insert list), `:395` (`normalize_effort(requested_effort)`) |
| `cli/src/peek/classify.js` mirrors `router.py`'s cascade with **no parity gate** | **CONFIRMED.** `cli/scripts/` contains only `sync-prices.js` and `check-period-parity.js`; `parityProbes()` compares only `{family, priceable, cost}` |
| `chat_completions` rewrites `body["model"]` and forwards the rest untouched | **CONFIRMED**, `app.py:743-744`. A Codex request naming `o3` with `reasoning_effort:"high"` classified as sonnet is forwarded to `gpt-4o` with `reasoning_effort` still attached. Structurally evident; **not exercised against the live API** — treat as probable, not proven. |

### Two claims from the judged designs that are FALSE as quoted

1. **"haiku@medium is cheaper than sonnet@none"** — basket‑dependent and it inverts. With catalog rungs (`medium=4096`):

| basket | haiku@medium | sonnet@off | cheaper? |
|---|---|---|---|
| chat (800 in, 0 cache, 400 vis) | $0.02328 | $0.00840 | **no** |
| cc (2 000 in, 45 000 cache, 500 vis) | $0.02948 | $0.02700 | **no** |
| agent (8 000 in, 200 000 cache, 2 000 vis) | $0.05848 | $0.11400 | yes |

2. **"haiku@high costs more than opus@none"** — true on chat and cc, **false on agent** ($0.11992 vs $0.19000). The closed form, for a proportional family: the crossing occurs iff `T' > (ρ−1)·F/α + (ρ−1)·V` where `ρ = in_rate(m)/in_rate(m')`, `F = in_fresh + 0.1·cache_read`, `α = 5`, `V` = visible output. For haiku‑vs‑opus (ρ=5, α=5): `T' > 0.8·F + 4V`. cc: 7 200 (crossed). agent: 30 400 (not crossed).

**Consequence, and it governs the whole work order: neither "effort first" nor "model first" is a static truth, but on a stock Anthropic install the joint problem is *exactly separable* — pick the model by dollars, then the lowest rung the floor permits. The 16‑cell grid buys zero rank flips. It is not in v1.**

---

## 1. The one repair that makes the winning design shippable

### 1.1 The defect

`evidence-first`'s ceiling is *interval dominance*: price the plan at `T_max` (the rung's cap), price the caller at `T_min = 0`, require `hi_plan ≤ lo_req`.

Under that rule, **every partial effort reduction fails.** Caller `haiku@high`, plan `haiku@medium`, cc basket: `hi_plan = $0.02948` vs `lo_req = $0.00900`. Dominance fails. `high→low` fails ($0.01412 vs $0.00900). Only `→off` ties. The rule is logically sound and it **collapses the action space to `{reduce-to-off, model downgrade}`** — it forbids the feature it exists to authorise. The design never notices.

### 1.2 The repair: denominate the ceiling in AUTHORIZED spend, not realized spend

**Provider contract:** on Anthropic, thinking tokens are inside `output_tokens`, and the API requires `max_tokens > budget_tokens` precisely because `max_tokens` bounds output **inclusive of thinking**. On OpenAI, `max_completion_tokens` likewise includes reasoning tokens on reasoning models.

**Theorem (Authorization Ceiling).** For a request carrying an explicit output cap `M`, the maximum billable cost is

```
A(m) = in_terms(m, IN_split, at=pday) + rate_out(m, at=pday) · M
```

and **`A` is independent of the reasoning rung.** Therefore:

* **A rung change in either direction, with `M` unchanged, cannot increase authorized spend.** Verified: `A(haiku, M=32000)` on the cc input split = `$0.16650` regardless of rung; sonnet `$0.49950`; opus `$0.83250`.
* **Raising `M` is the only way to raise authorization.** ⇒ **Cheaper never modifies `max_tokens`. Ever.** This is `quality-first`'s rule, now with a proof instead of a preference, and it deletes `cost-first`'s `max(mt, B+1024)` rewrite outright.
* A model change satisfies `A(m') ≤ A(m)` iff a pure rate comparison holds — computable exactly, estimator‑free, at the row's own `pday`.

**Theorem (Truncation Lemma).** Let `T` be thinking tokens realized under cap `B`, `T'` under cap `B' < B`. The provider enforces `T' ≤ B'`. Then:

* If `T ≥ B'` — the caller's realization already exceeded the new cap — then `T' ≤ B' ≤ T` and **realized cost strictly falls or ties. Provable, no estimator.**
* If `T < B'` — the caller never reached the new cap either — sampling noise governs the sign, and the excess is bounded above by `rate_out · B'`.

**This is the cap‑vs‑spend insight in provable form: a rung reduction can only cost more in exactly the regime where it was already saving nothing, and the excess is bounded.** Worst case for `high→medium` on haiku is `$0.02048`; the saving when the budget *is* consumed is `$0.06144`. The bound is recorded per row and rendered; it is never netted against the saving.

### 1.3 The resulting rule set (the whole ceiling, in three lines)

| action | test | flag |
|---|---|---|
| rung **reduction**, same model, `M` unchanged | Authorization Ceiling (trivially satisfied) + Truncation Lemma bound recorded | none |
| **model change** | `A(served) ≤ A(requested)` **and** `cap_cost(served, rung_served) ≤ cap_cost(requested, rung_requested)` — cap‑to‑cap, symmetric, estimator‑free | none |
| rung **raise** | both of the above **and** `CHEAPER_EFFORT_ALLOW_RAISE=1` **and** `ROUTER_ALLOW_UPGRADE=1` | two |
| raising `max_tokens` | **prohibited unconditionally** | — |

**Position on `allow_upgrade_above_requested`.** The flag governs *authorized* spend — that is what `router.py:203-211` means when it says "The invariant was always about money", and it is what the caller actually stated (`max_tokens` and `budget_tokens` are caps, not spends). Raising a rung does not increase authorization, but it can multiply realized spend (`cc`: haiku off→high is 10.1×). So it is gated by its own flag, and the reason is stated honestly in the code: *the authorization ceiling is necessary but not sufficient for a raise.* Cheaper does not get to pretend a 10× realized increase is fine because a cap did not move.

**The cap‑to‑cap test is what makes the product thesis expressible.** On the agent basket, `haiku@high` ($0.11992) dominates `opus@off` ($0.19000) and `sonnet@low` ($0.12936) cap‑to‑cap. That is "better answer, lower bill", provable, no estimator — and it is still behind the raise flag because it is a raise.

---

## 2. Decisions where the judges disagreed

| question | ruling | why |
|---|---|---|
| Ceiling: interval dominance vs. estimator | **Neither. Authorization ceiling + Truncation Lemma.** | Interval dominance is sound but nullifies the feature (§1.1). An estimator under the money invariant is the one thing this codebase's own comments forbid. |
| `T_hat` in the decision path | **Never.** Estimation lives only in the reporting basis, and it may refuse. | `cost-first`'s `A` prior and `quality-first`'s confounded delta both sit under the ceiling. Judge 3 called each fatal, correctly. |
| Joint (model × effort) grid | **Not in v1.** Separable on the default install; gated behind a per‑install flip check. | 0 equal‑rung flips within Anthropic, proven structurally. |
| Insufficiency → cheapest model, or hold the model? | **Hold the model, clamp the rung.** | "I don't have enough information" is precisely the judgement cheap models are worst at. `quality-first` is right and the other two are wrong. |
| `_THINK_TOKENS` promoted into decisions/dollars | **Deleted from both.** Its own comment calls it a "coarse, tunable ballpark", and `low=600`/`medium=2500` are **below Anthropic's minimum budget** — they are not even emittable on the wire. |
| Where floors live | **Data file, single decider (Python).** `peek` reads the frozen plan. | One floor, one digest, one runtime. Porting it creates a second security‑critical list that CI compares for equality rather than correctness. |
| `budget_tokens` continuous or enum | **Catalog‑declared rungs.** Internally tokens, externally a rung. | Continuous never warms an observation cell and is unrepresentable on OpenAI. |

---

## 3. Code

### 3.1 `cli/assets/gateway/app/effort.py` — rungs, caps, wire shapes

```python
"""Reasoning rungs, provider wire shapes, and the cap arithmetic.

NOTHING in this module estimates. Every number it returns is either a
provider-enforced cap read from the catalog, or a dollar figure computed from
published rates at an explicit date. The estimator lives in effort_model.py and
is never imported from here.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import pricing

# Ordered rungs. The ORDER is the only ranking this module publishes; it is a
# LABEL order, never a cost order. Cost order is computed per model per date.
RUNGS = ("off", "low", "medium", "high", "max")


def rung_index(r: str) -> int:
    try:
        return RUNGS.index(r)
    except ValueError:
        return -1


@dataclass(frozen=True)
class Reasoning:
    """The catalog's reasoning block for one model. `shape` is the wire.

    shape == 'none'  -> the model HAS NO reasoning knob. T_cap == 0 is a FACT.
    block absent     -> we do not know. Fail closed: never modify, never price a
                        rung change. These two states must never be conflated;
                        collapsing them reintroduces the fail-open pricing that
                        pricing._entry_matches was rewritten to eliminate.
    """
    shape: str                      # anthropic_budget | openai_enum | none
    min_budget: Optional[int]
    max_budget: Optional[int]
    rungs: dict                     # rung -> int budget | str enum | None


def reasoning_of(model_id: str, at: Optional[str] = None) -> Optional[Reasoning]:
    entry = pricing.resolve_model(model_id, at)
    if entry is None:
        return None
    blk = entry.get("reasoning")
    if not isinstance(blk, dict):
        return None                 # UNKNOWN -> fail closed at every call site
    return Reasoning(shape=blk.get("shape") or "none",
                     min_budget=blk.get("min_budget"),
                     max_budget=blk.get("max_budget"),
                     rungs=dict(blk.get("rungs") or {}))


def cap_tokens(model_id: str, rung: str, at: Optional[str] = None) -> Optional[int]:
    """Provider-enforced UPPER BOUND on thinking tokens at this rung. Never an
    expectation, never a median. None means 'unknown' and blocks every action."""
    rz = reasoning_of(model_id, at)
    if rz is None:
        return None
    if rz.shape == "none":
        return 0                    # a FACT, not a guess
    v = rz.rungs.get(rung)
    if v is None:
        return None
    if rz.shape == "anthropic_budget":
        return int(v)
    # openai_enum: the provider publishes no numeric cap. The cap is
    # max_completion_tokens, which we never move, so the AUTHORIZED cost is
    # already bounded by the visible cap. Return 0 for the CAP arithmetic and
    # let the authorization ceiling carry the invariant.
    return 0


def authorized_cost(model_id: str, split: dict, out_cap: int,
                    at: Optional[str]) -> Optional[float]:
    """Maximum billable dollars for this call on this model.

    RUNG-INDEPENDENT by construction: thinking tokens are inside the provider's
    output cap (that is exactly why Anthropic requires max_tokens >
    budget_tokens). Therefore no rung change can move this number, and the only
    way to raise authorization is to raise the cap -- which Cheaper never does.
    """
    return pricing.cost_of_model(
        model_id, in_tok=split.get("in_tok", 0),
        cache_read=split.get("cache_read", 0),
        cache_create_5m=split.get("cache_create_5m", 0),
        cache_create_1h=split.get("cache_create_1h", 0),
        out_tok=out_cap, speed=split.get("speed"),
        service_tier=split.get("service_tier"), at=at)


def cap_cost(model_id: str, rung: str, split: dict, visible: int,
             at: Optional[str]) -> Optional[float]:
    """Worst-case dollars at this rung: visible output plus the FULL cap.

    Symmetric: used on BOTH sides of every comparison. Pricing one side at a cap
    and the other at zero is what collapses the action space; see the ceiling
    note in router.py.
    """
    t = cap_tokens(model_id, rung, at)
    if t is None:
        return None
    return pricing.cost_of_model(
        model_id, in_tok=split.get("in_tok", 0),
        cache_read=split.get("cache_read", 0),
        cache_create_5m=split.get("cache_create_5m", 0),
        cache_create_1h=split.get("cache_create_1h", 0),
        out_tok=visible + t, speed=split.get("speed"),
        service_tier=split.get("service_tier"), at=at)


def truncation_excess_bound(model_id: str, rung_to: str, at) -> Optional[float]:
    """Upper bound on how much a REDUCTION to `rung_to` could cost EXTRA.

    Zero whenever the caller's realized thinking already exceeded the new cap
    (Truncation Lemma, case 1). In the other regime the reduction was saving
    nothing anyway, and the excess cannot exceed rate_out * new_cap.

    This number is RECORDED and RENDERED. It is never netted against a saving:
    a bound and a measurement do not sum.
    """
    t = cap_tokens(model_id, rung_to, at)
    e = pricing.resolve_model(model_id, at)
    if t is None or e is None:
        return None
    r = pricing.rates_for(e)
    return (t / 1e6) * r["out"]
```

### 3.2 Catalog extension — `cli/src/peek/models.js`

Added to the entry shape doc-block and to every entry that has a published knob. **Every field must be transcribed from the provider's own docs on the `CATALOG_AS_OF` date, exactly like a rate. `min_budget` in particular is a provider fact that 400s the call when wrong.**

```js
//   reasoning          { shape, min_budget, max_budget, rungs } — the model's
//                      reasoning knob. ABSENT means UNKNOWN (fail closed: never
//                      touched, never priced at a different rung). shape:'none'
//                      means the model HAS NO knob, which is a FACT — T_cap is 0.
//                      Those two states are deliberately different; conflating
//                      them reintroduces fail-open pricing.
//                      Rung budgets below min_budget are IMPOSSIBLE on the wire
//                      and collapse to 'off' here, in data, so the cliff is not
//                      a branch someone forgets. (metrics.py's retired
//                      _THINK_TOKENS had low=600 and medium=2500 — both below
//                      Anthropic's 1024 floor. Neither was ever emittable.)

const ANTHROPIC_REASONING = {
  shape: 'anthropic_budget', min_budget: 1024, max_budget: 64000,
  rungs: { off: 0, low: 1024, medium: 4096, high: 16384, max: 32000 },
};
```

`anthropic()` gains `reasoning: ANTHROPIC_REASONING` for the models that support extended thinking; models that do not get `reasoning: { shape: 'none', min_budget: null, max_budget: null, rungs: {} }`. Every non‑Anthropic entry gets an explicit block or none at all — **no entry gets a guessed one.** `sync-prices.js` projects it for free (it serialises `CATALOG` wholesale).

### 3.3 `cli/assets/gateway/app/quality_floors.py` + `cli/src/peek/quality_floors.js`

Authored in JS, projected to `cli/assets/gateway/app/quality_floors.json` by `sync-prices.js` (one more entry in the existing `targets` array), consumed by a thin Python loader.

```js
// cli/src/peek/quality_floors.js  — SINGLE SOURCE OF TRUTH for the quality floor.
//
// A floor NEVER forces a spend increase. It only ever FORBIDS a reduction. So a
// floor costs nothing on traffic that is already above it, and the product's
// claim -- "we never touch the hard cases" -- is one SQL query away from proof.
//
// `cases` are not documentation. test_quality_floors.py is GENERATED from them:
// narrowing a pattern until it stops matching its own case fails the build in
// the same commit. Floor ids are append-only (floor-ids.golden). The whole file
// is digested and the digest is pinned; a mismatch REFUSES TO IMPORT.
const FLOORS = [
  { id: 'QF-CONC-001', ver: 1, locked: true, added: '2026-08-07',
    rationale: 'a plausible-but-wrong concurrency answer is worse than an expensive right one',
    patterns: [/\bconcurren(?:t|cy)\b/i, /\bdeadlock\b/i, /\brace condition\b/i,
               /\bmutex\b/i, /\block(?:s|ing|-free)?\b/i, /\bthread(?:s|ing|-safe)?\b/i,
               /\bsemaphore\b/i, /\baba problem\b/i, /\bmemory[- ]order/i,
               /\batomic(?:s|ity)?\b/i],
    cases: ['is this counter increment thread-safe',
            'why does this hang sometimes under load',
            'can two requests interleave here and corrupt the balance'] },

  { id: 'QF-SEC-001', ver: 1, locked: true, added: '2026-08-07',
    rationale: 'a confidently wrong security answer is unrecoverable',
    patterns: [/\bsecurity\b/i, /\bvulnerab/i, /\bexploit\b/i, /\bcrypto(?:graph)?/i,
               /\bauth(?:entication|orization)\b/i, /\bsql injection\b/i, /\bxss\b/i,
               /\bcsrf\b/i, /\bsanitiz/i],
    cases: ['is this endpoint vulnerable to SQL injection',
            'audit this login flow for a security vulnerability',
            'can one user read another user\u2019s row here'] },

  { id: 'QF-PROOF-001', ver: 1, locked: true, added: '2026-08-07',
    rationale: 'an unsound proof reads exactly like a sound one',
    patterns: [/\bproof\b/i, /\bprovably\b/i, /\bprove that\b/i, /\binvariant\b/i,
               /\bformal(?:ly)? (?:correct|verify)/i],
    cases: ['prove that this loop terminates',
            'does this invariant hold after the swap'] },

  { id: 'QF-LEGAL-001', ver: 1, locked: true, added: '2026-08-07',
    rationale: 'liability attaches to the answer, not to the model tier',
    patterns: [/\blegal(?:ly)?\b/i, /\bcontract\b/i, /\bliab(?:le|ility)\b/i, /\bregulat/i],
    cases: ['is this clause enforceable in California',
            'what is our liability if the vendor breaches'] },

  { id: 'QF-MED-001', ver: 1, locked: true, added: '2026-08-07',
    rationale: 'dosage and diagnosis errors are not recoverable by retry',
    patterns: [/\bmedical\b/i, /\bdiagnos/i, /\bdosage\b/i],
    cases: ['what dosage of ibuprofen for a 12kg child',
            'could these symptoms be a pulmonary embolism'] },

  { id: 'QF-FIN-001', ver: 1, locked: true, added: '2026-08-07',
    rationale: 'money arithmetic that is confidently wrong ships to a ledger',
    patterns: [/\btax(?:es|ation)?\b/i, /\bfinanc(?:e|ial)\b/i],
    cases: ['is this VAT refund calculation right',
            'compute the amortization schedule for this note'] },

  { id: 'QF-ARCH-001', ver: 1, locked: true, added: '2026-08-07',
    rationale: 'distributed-systems reasoning fails silently and late',
    patterns: [/\barchitect(?:ure|ing)?\b/i, /\bdistributed system/i,
               /\bconsensus\b/i, /\bsharding\b/i, /\birreversible\b/i,
               /\bproduction outage\b/i],
    cases: ['will this two-phase commit lose writes on partition',
            'how should we shard this table without downtime'] },

  // --- GRAFTED from quality-first: three categories absent from _OPUS_PATTERNS,
  //     all of them "a confidently wrong answer IS the entire harm".
  { id: 'QF-DESTRUCT-001', ver: 1, locked: true, added: '2026-08-07',
    rationale: 'the operation cannot be undone by disagreeing with the answer',
    patterns: [/\bdrop\s+table\b/i, /\btruncate\s+table\b/i, /\brm\s+-rf\b/i,
               /\bforce[- ]push\b/i, /\bdown\s+migration\b/i, /\brevoke\b/i,
               /\brotat(?:e|ing)\s+(?:the\s+)?(?:key|secret|credential)/i,
               /\bdelete\s+from\b/i, /\bDROP\s+DATABASE\b/i],
    cases: ['is it fine to just drop table sessions and recreate it',
            'write the down migration for this change',
            'can I force-push this branch'] },

  { id: 'QF-CONVERT-001', ver: 1, locked: true, added: '2026-08-07',
    rationale: 'a unit or currency slip is invisible in a fluent answer',
    patterns: [/\bconvert\b[^.\n]{0,40}\b(?:mg|kg|lb|oz|ml|mm|cm|km|mile|celsius|fahrenheit|usd|eur|gbp|jpy)\b/i,
               /\bexchange rate\b/i, /\bmg\/kg\b/i, /\bbasis points?\b/i],
    cases: ['convert 2.5 mg/kg to a dose for a 70kg adult',
            'convert 1450 EUR to USD at last month\u2019s rate'] },

  { id: 'QF-SAFE-001', ver: 1, locked: true, added: '2026-08-07',
    rationale: 'a yes/no where a confident wrong "yes" is the whole harm',
    patterns: [/\bis it safe to\b/i, /\bwill this (?:break|corrupt|lose|drop)\b/i,
               /\bcan I safely\b/i, /\bany risk (?:in|to|of)\b/i],
    cases: ['is it safe to run this migration during peak traffic',
            'will this change lose any rows',
            'can I safely restart the primary right now'] },
];

const FLOOR_DIGEST_PINNED = 'sha256:REPLACE_AT_FIRST_COMMIT';
module.exports = { FLOORS, FLOOR_DIGEST_PINNED, floorDigest };
```

```python
# cli/assets/gateway/app/quality_floors.py
"""Loader + digest guard for the generated quality-floor table.

THE DIGEST IS NOT CEREMONY. It catches an UNREVIEWED edit. The `cases` corpus
catches a reviewed edit that is nonetheless wrong. The weekly ratchet
(FLOOR_BASELINE.json) catches a regex that quietly stops matching REAL traffic,
which neither of the other two can see. Three layers, three different failure
modes. Do not delete one because another exists.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass

_PATH = os.path.join(os.path.dirname(__file__), "quality_floors.json")
with open(_PATH, encoding="utf-8") as _fh:
    _DOC = json.load(_fh)


def _canonical(doc: dict) -> str:
    return json.dumps({"floors": [
        {"id": f["id"], "ver": f["ver"], "locked": f["locked"],
         "patterns": list(f["patterns"])} for f in doc["floors"]]},
        sort_keys=True, separators=(",", ":"))


FLOOR_DIGEST = "sha256:" + hashlib.sha256(
    _canonical(_DOC).encode("utf-8")).hexdigest()

if FLOOR_DIGEST != _DOC["digest_pinned"]:
    # HARD FAIL AT IMPORT. The gateway does not start. Changing the quality floor
    # must be a deliberate two-file edit that reads in review as "the quality
    # floor changed", never as "tidied a regex".
    raise RuntimeError(
        "quality-floor digest mismatch: table is %s, pinned is %s. "
        "If this change is intended, update FLOOR_DIGEST_PINNED in "
        "cli/src/peek/quality_floors.js and re-run sync-prices.js."
        % (FLOOR_DIGEST, _DOC["digest_pinned"]))


@dataclass(frozen=True)
class FloorRule:
    id: str
    ver: int
    locked: bool
    res: tuple


FLOORS: tuple = tuple(
    FloorRule(id=f["id"], ver=f["ver"], locked=f["locked"],
              res=tuple(re.compile(p, re.I) for p in f["patterns"]))
    for f in _DOC["floors"])


@dataclass(frozen=True)
class QualityFloor:
    id: str          # '' when no floor engaged
    ver: int
    locked: bool
    digest: str      # the floor table IN FORCE when this row was decided
    defeated: bool   # a floor engaged but something overrode it -- VISIBLE, never silent


NO_FLOOR = QualityFloor(id="", ver=0, locked=False, digest=FLOOR_DIGEST, defeated=False)


def evaluate(text: str) -> QualityFloor:
    """First matching rule wins. Order in the data file is the precedence."""
    for rule in FLOORS:
        for rgx in rule.res:
            if rgx.search(text):
                return QualityFloor(id=rule.id, ver=rule.ver, locked=rule.locked,
                                    digest=FLOOR_DIGEST, defeated=False)
    return NO_FLOOR
```

### 3.4 `cli/assets/gateway/app/sufficiency.py`

```python
"""Does this request carry the information needed to answer it?

Deterministic, no model call, no meaningful added latency. Emits SIGNAL IDS
ONLY -- never the matched text. emit.js::assertPrivacySafe checks FORBIDDEN_KEYS
= ['text','prompt','path','file','cwd','dir','snippet'], i.e. it catches paths
and $HOME but would happily let a matched regex fragment -- which IS
prompt-derived text -- into an append-only log. test_sufficiency_ids_allowlist
closes that.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

SIGNAL_IDS = ("CS-DANGLING-REF", "CS-EMPTY-TOOL-RESULT", "CS-TRUNCATED-PASTE",
              "CS-CODE-Q-NO-CODE", "CS-UNRESOLVED-MENTION", "CS-EMPTY-TURN")

_DEICTIC = re.compile(
    r"\b(?:the|this|that|my)\s+"
    r"(file|error|log|stack ?trace|output|code|function|test|diff|screenshot|"
    r"snippet|attachment|config|ticket|PR)\b", re.I)
_CODE_VERB = re.compile(
    r"\b(fix|debug|why (?:does|is|isn't)|what(?:'s| is) wrong with|refactor|"
    r"optimi[sz]e|explain (?:this|the))\b", re.I)
_PATHISH = re.compile(r"[\w.-]+/[\w./-]+\.\w{1,5}\b|\b[\w-]+\.(?:py|js|ts|tsx|go|rs|java|rb|sql|sh|c|h|cpp)\b")
_TRUNC = re.compile(r"(\.\.\.\s*$|\[truncated\]|<truncated>|\(\s*\d+\s+more lines?\s*\))", re.I)
_FENCE = re.compile(r"```")
_MENTION = re.compile(r"(?:^|\s)@[\w./-]{2,}")
_STACK = re.compile(r"^\s*(?:at |File \"|Traceback|\s+\w+\.\w+\()", re.M)


@dataclass(frozen=True)
class Sufficiency:
    verdict: str                 # sufficient | uncertain | insufficient
    signals: tuple               # tuple[str, ...] of SIGNAL_IDS members
    ver: int = 1


def _blocks(body: dict):
    for msg in body.get("messages") or []:
        if not isinstance(msg, dict):
            continue
        c = msg.get("content")
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict):
                    yield b


def detect(body: dict, text: str) -> Sufficiency:
    blocks = list(_blocks(body))
    has_fence = bool(_FENCE.search(text))
    has_tool = any(b.get("type") == "tool_result" for b in blocks)
    has_media = any(b.get("type") in ("image", "document") for b in blocks)
    has_path = bool(_PATHISH.search(text))
    sig: list = []

    # 2 -- highest precision in agent traffic, and needs no heuristic at all.
    for b in blocks:
        if b.get("type") != "tool_result":
            continue
        raw = b.get("content")
        s = raw if isinstance(raw, str) else ("" if raw in (None, [], {}) else str(raw))
        if b.get("is_error") or s.strip() in ("", "[]", "{}", "null", "(no content)", "no output"):
            sig.append("CS-EMPTY-TOOL-RESULT")
            break

    # 1 -- the CONJUNCTION is essential. "fix this error" with 200 lines
    #      attached is perfectly sufficient.
    if (_DEICTIC.search(text) and not has_fence and not has_tool
            and not has_media and not has_path and len(text) < 400):
        sig.append("CS-DANGLING-REF")

    # 3
    if text.count("```") % 2 == 1 or _TRUNC.search(text):
        sig.append("CS-TRUNCATED-PASTE")

    # 4
    if (_CODE_VERB.search(text) and not has_fence and not has_tool
            and not has_path and not _STACK.search(text)):
        sig.append("CS-CODE-Q-NO-CODE")

    # 5
    if _MENTION.search(text) and not has_fence and not has_tool and not has_media:
        sig.append("CS-UNRESOLVED-MENTION")

    # 6
    msgs = body.get("messages") or []
    if msgs:
        last = msgs[-1]
        if isinstance(last, dict) and last.get("role") == "user":
            c = last.get("content")
            flat = c if isinstance(c, str) else "".join(
                b.get("text", "") for b in (c or []) if isinstance(b, dict))
            if not flat.strip() and not has_media and not has_tool:
                sig.append("CS-EMPTY-TURN")

    sig = tuple(dict.fromkeys(sig))
    hard = {"CS-EMPTY-TOOL-RESULT", "CS-EMPTY-TURN"}
    if set(sig) & hard or len(sig) >= 2:
        return Sufficiency("insufficient", sig)
    if sig:
        return Sufficiency("uncertain", sig)
    return Sufficiency("sufficient", sig)
```

**What the router DOES on `insufficient` — the policy, with its argument:**

* **Never escalate.** No model can invent the file that was not attached. Escalation buys a more expensive "which file?" — pure loss. Hard rule, not a tuned parameter.
* **Never synthesize a response body.** Cheaper is a transparent proxy. A fabricated assistant turn matches no upstream SSE sequence, invents a `stop_reason`, and is written into the harness transcript as if the model said it — poisoning the very event store every savings figure is computed from. Prohibited at any confidence.
* **Clamp the rung to `low` (`min_budget`), and HOLD the model.** Thinking without facts does not discover the missing file; it constructs a more self-consistent narrative around the gap and emerges more confident. And "I don't have enough information" is precisely the judgement cheap models are worst at — downgrading here optimises away the one capability the situation requires.
* **`uncertain` → record only. No action, in any mode, at any stage.** If a signal is not strong enough to act on, it is not strong enough to act on.
* **Floor engaged → the clamp is disabled entirely**, `sufficiency` is recorded with no effect. A text heuristic does not get to lower the bar on a category where being wrong is unrecoverable, and it does not get an exemption for being *our* heuristic.
* Response header `x-cheaper-context: insufficient; signals=CS-EMPTY-TOOL-RESULT`. Reporting, not injecting.

### 3.5 `cli/assets/gateway/app/router.py` — the new decision object

```python
STAGE = ("content", "triage", "floor", "sufficiency", "tier_ceiling",
         "authorization", "cap_dominance", "effort", "wire", "write_gate")

# CLOSED ENUM. An auditor asks "how many rows carried EFFORT_REDUCED while
# floor.id == ''" in SQL, not by regexing prose. Adding a code is a data change
# with a test; changing a string is a copy edit that silently breaks a filter.
class RCode:
    CONTENT_TIER          = "content_tier"
    TRIAGE                = "triage"
    TIER_CEILING          = "tier_ceiling"
    AUTHORIZATION_CEILING = "authorization_ceiling"
    CAP_DOMINANCE_FAIL    = "cap_dominance_fail"
    PASSTHROUGH           = "passthrough"
    FLOOR_ENGAGED         = "floor_engaged"
    FLOOR_DEFEATED        = "floor_defeated"
    INSUFFICIENT_CONTEXT  = "insufficient_context"
    EFFORT_REDUCED        = "effort_reduced"
    EFFORT_HELD           = "effort_held"
    EFFORT_SHAPE_MISMATCH = "effort_shape_mismatch"
    THINKING_IN_HISTORY   = "thinking_in_history"
    SAMPLING_CONFLICT     = "sampling_conflict"
    REASONING_UNKNOWN     = "reasoning_unknown"
    NO_OUTPUT_CAP         = "no_output_cap"
    MODE_OBSERVE          = "mode_observe"
    HOLDBACK_CONTROL      = "holdback_control"


@dataclass(frozen=True)
class Reason:
    code: str          # RCode member
    detail: str        # human text; RENDERED, never parsed
    effect: str        # "" | "tier opus->haiku" | "rung high->medium"


@dataclass(frozen=True)
class EffortSpec:
    shape: str                    # anthropic_budget | openai_enum | none | absent
    rung: str                     # off|low|medium|high|max  (catalog-declared)
    budget_tokens: Optional[int]
    enum_value: Optional[str]
    explicit: bool                # caller SAID something about reasoning.
                                  # 'absent' and 'explicitly off' are different
                                  # states; _extract_effort collapses both to
                                  # "none" today and must stop.


@dataclass(frozen=True)
class PriceProof:
    at: Optional[str]                 # the row's OWN pday. Never today_utc().
    out_cap: Optional[int]            # the caller's max_tokens; never modified
    split: dict                       # the input token split priced on
    auth_served: Optional[float]
    auth_requested: Optional[float]
    cap_served: Optional[float]
    cap_requested: Optional[float]
    excess_bound: Optional[float]     # Truncation Lemma. NEVER netted vs saving.
    priced: bool


@dataclass(frozen=True)
class Plan:
    # tier / model / reason survive as REAL attributes with UNCHANGED semantics
    # (tier is None for a PASSTHROUGH). app.py's two call sites and all 17 tests
    # in tests/test_router.py keep working with no edit.
    tier: Optional[str]
    model: str
    effort_req: EffortSpec
    effort_srv: EffortSpec
    floor: QualityFloor
    sufficiency: Sufficiency
    price: PriceProof
    reasons: tuple
    mode: str                      # observe | reduce | reduce_nocontrol
    arm: str                       # treated | control | na
    plan_ver: int = PLAN_VERSION

    @property
    def reason(self) -> str:       # DERIVED, never authored
        return render_reason(self.reasons)

    def __post_init__(self):
        # A plan that changed the rung MUST carry a reason saying so. Enforced at
        # construction, so an optimisation inserted later cannot slip past it.
        if self.effort_srv.rung != self.effort_req.rung:
            assert any(r.effect.startswith("rung ") for r in self.reasons), \
                "rung changed with no Reason recording it"
        # THE FLOOR IS A POST-CONDITION, NOT A BRANCH.
        if self.floor.locked:
            assert self.effort_srv.rung == self.effort_req.rung, \
                "locked floor %s: rung moved %s -> %s" % (
                    self.floor.id, self.effort_req.rung, self.effort_srv.rung)
```

`Decision` is kept as a 3‑field frozen dataclass constructed from a `Plan` by `Plan.as_decision()`, so anything constructing it positionally still works. The existing reason substrings (`"auto-escalate"`, `"capped"`, `"passthrough"`, `"triage"`, `"dollar ceiling"`, `"min_tier"`) are pinned by `test_reason_substrings_are_stable`.

### 3.6 The effort‑selection function

```python
def choose_effort(*, req: EffortSpec, model: str, split: dict, visible: int,
                  out_cap: Optional[int], at: Optional[str],
                  floor: QualityFloor, suff: Sufficiency, cfg, mode: str,
                  body: dict) -> tuple[EffortSpec, list]:
    """Pick the served rung. Returns (served, reasons).

    ORDER IS LOAD-BEARING and every early return is a REFUSAL, never a guess.
    The floor is checked FIRST and again as a post-condition in Plan.
    """
    R: list = []

    # --- 0. The floor. Locked => nothing below may act. Not a helper: three
    #        separate call sites guard three separate behaviours, because one
    #        shared helper is one edit away from disabling all three.
    if floor.locked:
        R.append(Reason(RCode.FLOOR_ENGAGED,
                        "quality floor %s engaged; effort untouched" % floor.id, ""))
        return req, R

    # --- 1. Observe mode: compute everything, change nothing.
    if mode == "observe":
        R.append(Reason(RCode.MODE_OBSERVE, "observe mode; body unmodified", ""))
        return req, R

    # --- 2. GRAFTED from cost-first. Anthropic requires prior `thinking` blocks
    #        be returned INTACT once tools are in play, and changing the setting
    #        mid-conversation can invalidate them. This exclusion is LARGE -- it
    #        confines this feature to first turns and non-tool chats -- and the
    #        dashboard MUST split gross from eligible opportunity because of it.
    if _conversation_has_thinking(body):
        R.append(Reason(RCode.THINKING_IN_HISTORY,
                        "conversation already contains thinking blocks", ""))
        return req, R

    # --- 3. The knob itself. ABSENT block != shape 'none'.
    rz = effort.reasoning_of(model, at)
    if rz is None:
        R.append(Reason(RCode.REASONING_UNKNOWN,
                        "no reasoning metadata for %s; failing closed" % model, ""))
        return req, R
    if rz.shape == "none":
        R.append(Reason(RCode.EFFORT_HELD, "model has no reasoning knob", ""))
        return req, R

    # --- 4. No output cap => the authorization ceiling has nothing to stand on.
    if not out_cap:
        R.append(Reason(RCode.NO_OUTPUT_CAP,
                        "no max_tokens on the request; cannot bound authorization", ""))
        return req, R

    # --- 5. Sampling conflict. Extended thinking constrains temperature/top_p
    #        and reasoning models reject some sampling params outright.
    #        ASYMMETRY: ENABLING thinking on a body carrying temperature can 400;
    #        REDUCING one the API already accepted cannot. Only the enable side
    #        is blocked.
    enabling = (effort.rung_index(req.rung) == 0)
    if enabling and _has_sampling_params(body):
        R.append(Reason(RCode.SAMPLING_CONFLICT,
                        "body sets temperature/top_p/top_k; will not enable thinking", ""))
        return req, R

    # --- 6. Target rung.
    target = req.rung
    if suff.verdict == "insufficient":
        # Clamp DOWN to the minimum non-zero rung -- never to off. The model must
        # still have room to NOTICE the gap. The model is deliberately NOT
        # downgraded: "I lack the information" is the judgement cheap models are
        # worst at, so downgrading here optimises away the capability required.
        if effort.rung_index("low") < effort.rung_index(req.rung):
            target = "low"
            R.append(Reason(RCode.INSUFFICIENT_CONTEXT,
                            "context insufficient (%s); rung clamped" % ",".join(suff.signals),
                            "rung %s->%s" % (req.rung, target)))

    if effort.rung_index(target) > effort.rung_index(req.rung):
        if not (cfg.allow_effort_raise and cfg.allow_upgrade_above_requested):
            R.append(Reason(RCode.EFFORT_HELD, "raise requires both raise flags", ""))
            return req, R

    if target == req.rung:
        R.append(Reason(RCode.EFFORT_HELD, "no rung change indicated", ""))
        return req, R

    # --- 7. Cap dominance, SYMMETRIC. Both sides priced at their FULL cap. This
    #        is the repair: pricing the plan at a cap and the caller at zero
    #        fails every partial reduction and collapses the feature.
    cs = effort.cap_cost(model, target, split, visible, at)
    cr = effort.cap_cost(model, req.rung, split, visible, at)
    if cs is None or cr is None:
        R.append(Reason(RCode.REASONING_UNKNOWN, "cell unpriceable at %s" % at, ""))
        return req, R
    if cs > cr:
        R.append(Reason(RCode.CAP_DOMINANCE_FAIL,
                        "cap cost %.6f > requested %.6f" % (cs, cr), ""))
        return req, R

    # --- 8. Reconcile to the wire. May still abandon.
    served = _to_wire(rz, target, out_cap)
    if served is None:
        R.append(Reason(RCode.EFFORT_SHAPE_MISMATCH,
                        "rung %s not representable within max_tokens=%d" % (target, out_cap), ""))
        return req, R

    R.append(Reason(RCode.EFFORT_REDUCED,
                    "rung %s -> %s (cap $%.5f <= $%.5f)" % (req.rung, target, cs, cr),
                    "rung %s->%s" % (req.rung, target)))
    return served, R
```

### 3.7 The wire reconciliation — and the 400 it must never produce

```python
RESERVED_ANSWER = 1          # Anthropic requires max_tokens > budget_tokens, STRICTLY.


def _to_wire(rz: Reasoning, rung: str, out_cap: int) -> Optional[EffortSpec]:
    """Project a rung onto the provider wire, or REFUSE.

    max_tokens IS NEVER MODIFIED. Raising it raises the caller's authorization
    (Authorization Ceiling) and changes a caller-specified response-length
    contract; lowering it truncates their answer. So the budget is clamped to
    fit INSIDE the cap the caller already set, and if it cannot fit above
    min_budget, the change is ABANDONED.

    Because we only ever REDUCE by default, and the caller's existing max_tokens
    already satisfied max_tokens > old_budget > new_budget, the reduce path
    CANNOT produce the 400 at all. Every path that can 400 is a raise, and every
    raise sits behind its own flag.
    """
    if rz.shape == "openai_enum":
        v = rz.rungs.get(rung)
        if v is None:
            return None
        return EffortSpec("openai_enum", rung, None, str(v), True)

    if rz.shape != "anthropic_budget":
        return None

    want = rz.rungs.get(rung)
    if want is None:
        return None
    if want == 0:
        return EffortSpec("anthropic_budget", "off", 0, None, True)

    hi = out_cap - RESERVED_ANSWER
    if rz.max_budget is not None:
        hi = min(hi, rz.max_budget)
    b = min(int(want), hi)
    if rz.min_budget is not None and b < rz.min_budget:
        return None                      # the CLIFF: cannot reduce a little
    if b < 1 or b >= out_cap:
        return None
    return EffortSpec("anthropic_budget", rung, b, None, True)


def validate_thinking_body(body: dict) -> Optional[str]:
    """Mirror of the provider's own constraint. Returns an error string when the
    body WOULD 400, else None.

    app.py must never forward a mutated body that fails this. If it does, the
    mutation is discarded, the ORIGINAL bytes are forwarded, and the row is
    tagged `mutation_invalid`. A 400 caused by Cheaper is indistinguishable to
    the user from an outage, which is the single worst failure this path has.
    """
    th = body.get("thinking")
    if not isinstance(th, dict) or th.get("type") != "enabled":
        return None
    b = th.get("budget_tokens")
    if not isinstance(b, int) or b <= 0:
        return "thinking.budget_tokens must be a positive integer"
    mt = body.get("max_tokens")
    if not isinstance(mt, int):
        return "max_tokens is required alongside extended thinking"
    if mt <= b:
        return "max_tokens (%d) must be greater than thinking.budget_tokens (%d)" % (mt, b)
    for k in ("temperature", "top_p", "top_k"):
        if k in body and body[k] is not None:
            return "extended thinking does not accept %s" % k
    return None
```

### 3.8 The joint dollar comparison in `decide()`

The existing `_unit_cost` / `_RANK_BASKET` dollar ceiling is **replaced**, not extended. `_RANK_BASKET` at 1M/1M moves 1.365 % under a full thinking budget — it cannot see the effort axis at all.

```python
def _model_ceiling(body, cfg, model_map, tier, split, out_cap, at, R):
    """Replaces the _RANK_BASKET dollar ceiling with the AUTHORIZATION ceiling.

    The old ceiling was correct for its job and is being widened, not repaired:
    it compared two models on a fixed 1M/1M basket, which is effort-blind (a full
    16,384-token thinking budget moves that basket by 1.365% -- below any sane
    tolerance). The authorization ceiling compares the same two models on the
    caller's OWN input split and the caller's OWN output cap, which is exactly
    the quantity the caller authorized, and is rung-independent by construction.

    Falls back to the 1M/1M basket ONLY when the caller sent no max_tokens, so a
    request with no cap behaves exactly as it does today.
    """
    req_model = body.get("model") or ""
    if cfg.allow_upgrade_above_requested:
        return tier
    if not out_cap:
        return _legacy_rank_basket_ceiling(body, cfg, model_map, tier, R)

    ar = effort.authorized_cost(req_model, split, out_cap, at)
    if ar is None:
        return tier                       # unpriceable caller: no envelope, no action
    cand = effort.authorized_cost(model_map.get(tier), split, out_cap, at)
    if cand is not None and cand <= ar:
        return tier
    for t in TIERS[:_rank(tier)][::-1]:
        c = effort.authorized_cost(model_map.get(t), split, out_cap, at)
        if c is not None and c <= ar:
            R.append(Reason(RCode.AUTHORIZATION_CEILING,
                            "dollar ceiling: %s authorizes <= requested" % model_map[t],
                            "tier %s->%s" % (tier, t)))
            return t
    R.append(Reason(RCode.PASSTHROUGH,
                    "no configured model is cheaper than requested -- passthrough", ""))
    return None
```

Plus the **shape disqualifier**, which fixes the probable live `gpt-4o` + `reasoning_effort` defect:

```python
    # A route to a model whose reasoning shape cannot honour the caller's spec is
    # DISQUALIFIED -- we walk to the next candidate, or pass through. We do NOT
    # silently strip the caller's reasoning field to make the route legal:
    # deleting an explicit caller parameter is exactly the "silently change your
    # results" failure this whole design exists to prevent.
    if req_effort.explicit and effort.reasoning_of(model_map[tier], at) is None:
        R.append(Reason(RCode.EFFORT_SHAPE_MISMATCH,
                        "%s cannot honour the caller's reasoning spec" % model_map[tier], ""))
        # ... walk down / passthrough
```

### 3.9 `app.py` — the body rewrite

```python
# --- REPLACES _extract_effort. The docstring "measure-only -- never modified"
#     dies in the SAME COMMIT as the first write mode. This repo has already been
#     bitten by a comment outliving its code.
def _requested_effort(body: dict, model: str, at: str | None) -> EffortSpec:
    """What the caller asked for. 'absent' and 'explicitly off' are DIFFERENT
    states -- only the first is safe to enable into -- and the retired
    _extract_effort collapsed both to "none"."""
    ...


def _apply_plan(body: dict, plan: Plan) -> tuple[bytes, dict]:
    """Produce the forwarded bytes. Returns (raw, mutation_report).

    FAIL CLOSED TOWARD THE CALLER: if anything about the mutation does not
    validate, the ORIGINAL body is forwarded unchanged. Leaving a request exactly
    as the caller wrote it can never be Cheaper's fault; a 400 we caused is
    indistinguishable from an outage.
    """
    original = json.dumps(body).encode()
    mut = {"model": False, "effort": False, "invalid": ""}

    if plan.tier is not None and plan.model and plan.model != body.get("model"):
        body["model"] = plan.model
        mut["model"] = True

    srv, req = plan.effort_srv, plan.effort_req
    if srv is not req and (srv.rung != req.rung or srv.budget_tokens != req.budget_tokens):
        if srv.shape == "anthropic_budget":
            if srv.rung == "off":
                # REMOVE the key rather than sending {"type":"disabled"}. Removal
                # is safer against schema drift, and disabling changes the
                # RESPONSE SHAPE (thinking blocks vanish, SSE sequence changes),
                # which is a different class of risk from a cost change.
                body.pop("thinking", None)
            else:
                body["thinking"] = {"type": "enabled",
                                    "budget_tokens": int(srv.budget_tokens)}
            # max_tokens is NOT touched. Ever. See _to_wire.
        elif srv.shape == "openai_enum":
            body["reasoning_effort"] = srv.enum_value
            body.pop("reasoning", None)
        mut["effort"] = True

    err = validate_thinking_body(body)
    if err:
        mut["invalid"] = err
        return original, mut          # discard the mutation entirely
    return json.dumps(body).encode(), mut
```

**Ordering bug this closes.** `app.py:431` and `:749` call `_extract_effort(body)` *after* `body["model"] = decision.model`. Once reasoning fields are mutable, reading the requested effort from the mutated body would record the served value as the requested one — silently zeroing the entire measurement. **The requested effort must be captured from the parsed body before `_apply_plan` runs**, and `test_requested_effort_is_captured_pre_mutation` asserts it.

---

## 4. Measurement — what is recorded, and what may be claimed

**The honest statement, first: you cannot prove from the gateway that a downgrade preserved quality. You ran one arm.** Everything below is a proxy or an experiment; the UI must never let the two be confused.

### 4.1 Additive columns on `decisions` (same `ALTER TABLE … except OperationalError: pass` idiom, **no default that asserts a fact**)

| column | meaning |
|---|---|
| `plan_json` | frozen `Plan`: reasons, floor + `floor.digest`, sufficiency ids, `PriceProof`, `at`, `plan_ver` |
| `effort_mode`, `arm` | `observe\|reduce\|reduce_nocontrol`; `treated\|control\|na` |
| `req_rung`, `srv_rung`, `req_budget`, `srv_budget` | the rung/budget on each side |
| `req_effort_explicit` | 0/1 — splits "absent" from "explicitly off" |
| `max_tokens_req` | the caller's cap. Never a second column for "served": it is never changed. |
| `rtok`, `rtok_src` | realized thinking tokens; `body \| counted \| unknown`. **Never defaulted to `body`** — verbatim the `usage_source` rule at `metrics.py:284-288`. |
| `answer_tokens_obs` | `out_tokens − rtok`, the quantity every counterfactual needs |
| `floor_id`, `floor_ver`, `floor_digest`, `floor_defeated` | `floor_defeated` is a **first-class dashboard number**, not a silent no-op |
| `suff`, `suff_sig`, `suff_ver` | verdict, comma-joined **ids only** |
| `stop_reason` | `max_tokens` means the answer was truncated — a direct quality signal, discarded today |
| `mutation_invalid` | the body-rewrite refusal reason, if any |

### 4.2 Realized thinking tokens

* **OpenAI:** `completion_tokens_details.reasoning_tokens`. `rtok_src='body'`. **It is already inside `completion_tokens`. Never add it to the cost.** `test_openai_reasoning_tokens_not_double_counted` pins that, or the first refactor re-inflates every OpenAI row.
* **Anthropic:** usage reports no thinking breakout. `_SseUsageSniffer` must count `content_block_start` where `content_block.type == "thinking"` and accumulate `thinking_delta` text length on that index, chars/4. `rtok_src='counted'`. **This is an estimate with unknown tokenisation bias and must never be pooled with `body` in the same percentile.** Until this ships, Anthropic streaming rows carry `rtok_src='unknown'` and contribute to no effort figure — a real, admitted coverage hole in the most common configuration, which is why **it is built in Stage 0, not deferred.**

### 4.3 The counterfactual rule — grafted verbatim from `cost-first`

```
counterfactual_out_tok = answer_tokens_obs + T_hat(requested_model, requested_rung)
```

**You may not reuse the served row's total `out_tokens`.** That total contains the *served* model's thinking, not the requested one's; reusing it understates the counterfactual exactly on the rows where effort was reduced — i.e. it overstates savings precisely where the product is making its new claim. `test_counterfactual_out_tok_excludes_served_thinking` uses a hand-computed fixture.

### 4.4 The estimator, and its refusal

`T_hat(model, rung, ctier)` is the **p90** of this install's own observed `rtok`, from `~/.cheaper/effort_model.json`, written by the gateway alone. **p90 on BOTH sides** — symmetric pessimism, grafted from `cost-first`, because p90-on-target/p50-on-requested is adversarially tilted toward downgrading and symmetric p90 cannot be gamed in either direction.

* `n < 30` for a cell ⇒ **COLD**. A cold cell yields **UNPRICEABLE** with a new first-class exclusion reason `estimator_cold`, alongside `estimated_usage`, `non_2xx`, `model_not_in_catalog`, `undatable`. **Not `$0.00`.** `$0.00` is a measurement; "no claim made" is not.
* The reader-checkable identity gains a sibling: `effort_priced + Σ effort_unpriced == effort_examined`.
* **The three bases never sum.** `measured`, `estimated`, `counterfactual_tokens` accumulate separately and no returned key combines them, enforced by extending `fold_rows`.
* `THINK_ESTIMATE_MISSING` fallback rate is counted and alarmed above 20 % of eligible rows in a rolling week. An estimator that silently never fires is a no-op wearing a feature's clothes — and cold-cell blocking makes that **more** likely, not less.

### 4.5 Proxies (cheap, directional, labelled as proxies with their `n`)

* **`escalation_within_session`** — did the next call in the same session request a dearer model? **Computable today from the existing `session` + `ts` columns with zero new fields.** A downgrade immediately followed by a manual escalation is a failed downgrade by definition. Highest value-per-line in this document.
* `stop_reason == "max_tokens"`, `redo_within_session`, `tool_error_next`.

Each can only ever **falsify**. A flat retry rate does not prove quality held; a retry rate that jumps 3× on reduced rows proves it did not. The dashboard states it in those terms.

### 4.6 The publishing rule

**The regression rate renders next to the savings number, or the savings number is not published.** Same discipline as `catalog.as_of` travelling with the rate.

> 47 eligible calls could have run at lower effort — $3.18 (shadow, unverified). Quality effect: **not measured**. Retry rate on reduced calls 4.1 % vs 3.8 % baseline (n=112 / 2,940); MDE 1.2 pp; no regression detected at this power.

`"Saved $3.18 with zero quality loss"` must never be printed. It is the exact shape of claim this codebase has already retracted three times (`store.py:395-398`).

### 4.7 Holdback

`reduce` mode carries a **mandatory ≥5 % control arm that cannot be set to zero.** Two independent reasons, and both must be in the comment: (a) it is the only regression estimate; (b) **once effort is being reduced, the observation table stops receiving samples at the levels no longer served, so `T_hat` for those cells ages out and freezes.** Assignment is a deterministic hash of `(session, message_index, plan_digest)`, never `random()` and never `request_id` — Claude Code retries 429s automatically and each retry gets a distinct `anthropic-request-id`, so a retry storm would contaminate both arms. Where no stable key exists, `arm='na'`.

---

## 5. Parity

**Rule: anything that DECIDES lives in exactly one runtime (Python). Anything that PRICES or is READ BY BOTH lives in both and is gated.**

### Gated (both runtimes)

1. **The `reasoning` catalog block** — `shape`, `min_budget`, `max_budget`, `rungs`. Authored in `models.js`, projected by `sync-prices.js` (free, it serialises `CATALOG` wholesale). Extend `jsAnswers`/`pyAnswers` to also return `reasoningShape(id)` and `capTokens(id, rung)` for every id × every rung and compare exactly. **`sync-prices.js`'s current probe compares only `{family, priceable, cost}` — a JS-side edit to `min_budget` reaches the gateway as a silently different clamp with every file "in sync".**
2. **The unsupported-model rule.** `cap_tokens` must return `0` for `shape:'none'` and `None` for an absent block, **in both runtimes**. Highest-severity probe of the set: a fail-open on either side manufactures a free-reasoning cell. Goes in the negative-probe list next to `claude-opus-4-9`.
3. **`quality_floors.json`.** Byte-identical projection (one more entry in `targets`), plus a behavioural probe: both runtimes classify the `cases` corpus and must return identical `(floor_id, locked)`.
4. **`~/.cheaper/effort_model.json` reader.** Written by the gateway alone; **read** by both. Three-probe read check — this reduces parity from "two implementations of a fitting procedure" to "two readers of one data file", the same move `model_prices.json` made.
5. **The existing classifier cascade.** `cli/src/peek/classify.js` mirrors `router.py` with **no gate at all** — verified. Today that only skews a report; once floors depend on those categories a divergence makes `peek` report a floor engaged on rows where the gateway never engaged one, which is a **safety** claim that is false. New `cli/scripts/check-policy-parity.js`, modelled on `check-period-parity.js`, single-process (these classifiers are time-independent — keep it fast or it gets skipped), wired into `cli` `npm test` next to `check:periods`.

### Deliberately single-runtime

6. **The decider** — floors evaluation, sufficiency, effort choice, wire reconciliation, ceiling. `peek` reads the **frozen `plan_json`**; it never recomputes. Recomputing a historical decision against today's catalog restates history, which is the bug `tzo` and the `at` parameter both exist to kill.
7. **Negative CI guard**: assert no `floors.*` / `sufficiency.*` file exists under `cli/src/peek/`, with a comment saying why. Someone will eventually port it "for consistency"; the guard turns that into a failing build.

### Hazards this creates

* `test_store_parity.py` diffs canonical JSON from both runtimes over `golden-events.json`. New Python-side event fields **must** be emitted by `emit.js` as explicit `null`s for transcript-derived rows — never added to an ignore-list. An ignore-list rots; that is the whole point of the gate.
* Every new field goes into `ROW_FIELDS` (`store.py:68`), which documents by omission what a row may never contain.
* `cli/src/peek/scan.js:20` infers reasoning potential from `REASONING_RE` on the model id for historical logs with no effort field. Once the gateway makes **real** reasoning savings, that inference must be tagged `experimental` and excluded from every dollar figure, or historical rows get credited with savings the gateway never made — on the path that prints numbers with no `~`.

---

## 6. Every test, by name, with its assertion

### 6.1 Quality floor — **the tests that must FAIL if the floor is ever weakened**

| test | assertion |
|---|---|
| `test_floor_digest_pinned_or_import_fails` | Importing `quality_floors` with a tampered `quality_floors.json` raises `RuntimeError`. Asserted by writing a mutated copy to a temp dir and re-importing. **The gateway does not start on a mismatch.** |
| `test_floor_cases_all_fire` | **Generated from the data.** For every floor × every `case`, `decide()` returns `plan.floor.id == <that floor>`. Narrowing a regex until it stops matching its own case fails the build in the same commit. |
| `test_floor_every_rule_has_cases` | Shape check: `len(cases) >= 2` per rule; a new floor with no cases fails. |
| `test_floor_ids_append_only` | `sorted(ids) ⊇ cli/test/fixtures/floor-ids.golden`. Removing a floor requires a one-line, greppable, reviewable diff to the golden. |
| `test_floor_mutation_kills_the_suite` | **The meta-test.** For each pattern index `i`, build a floor table with pattern `i` deleted and assert at least one `case` in that rule stops firing. **A guard nobody has proven can fail is not a guard.** |
| `test_floor_monotonic_under_benign_context` | For every case, prepending and appending 2 kB of benign filler, and wrapping it in a `system` block, must never lower the floor. Catches the real failure "someone anchored the regex with `^`". Directly exercises `extract_text()`'s coverage of `system` + content-block shapes. |
| `test_no_plan_reduces_effort_on_protected` | **Output invariant, not implementation.** For every case × every `(requested model, requested rung)` reachable in the catalog × every mode including `reduce_nocontrol`: `plan.effort_srv.rung == plan.effort_req.rung` and `plan.model is None or authorized(plan.model) <= authorized(requested)`. Survives a future swap of regexes for a classifier. |
| `test_floor_survives_sufficiency` | A protected prompt with `CS-EMPTY-TOOL-RESULT` firing: `suff.verdict == 'insufficient'` **and** rung unchanged. |
| `test_floor_defeated_is_recorded_never_silent` | When the authorization ceiling overrides a floor, `floor.defeated is True`, the row carries it, and `x-cheaper-quality-warning` is set. |
| `test_floor_corpus_integrity` | `CORPUS_SHA256` and row count of `floors_corpus.jsonl` match pinned constants — deleting corpus rows is a diff a human signs. |
| `test_floor_recall_and_false_positive_rate` | Over `floors_corpus.jsonl` (≥300 adversarial positives written **without** the protected vocabulary — "why does this occasionally see a stale value", "can someone else's session end up here", "does this rounding lose a cent per transaction"; ≥300 negatives that must NOT match — "the author of this book", "contract work rates", "lock the scroll position", "the finance team's slide deck"): recall ≥ 0.98, FPR ≤ 0.05. |
| `test_floor_ratchet_baseline_complete` | Every live floor id has a row in `FLOOR_BASELINE.json`. |
| `test_floor_ratchet_alarms_on_share_drop` | Synthetic 30‑day id histogram with one floor's share down 25 % ⇒ the ratchet job returns non‑zero. **This is the only layer that catches a regex quietly narrowed against real traffic; corpus and digest only catch prompts someone already imagined.** |

### 6.2 Cost model / ceiling

| test | assertion |
|---|---|
| `test_authorized_cost_is_rung_independent` | For every Anthropic model × every rung, `authorized_cost` is bit-identical. **This is the theorem.** |
| `test_authorized_ceiling_blocks_a_cost_increasing_escalation` | `gpt-4o-mini` + security text + `max_tokens` ⇒ passthrough, `tier is None`, reason contains `passthrough`. (Widens the existing `test_dollar_ceiling_blocks_a_cost_increasing_escalation`.) |
| `test_partial_rung_reduction_is_not_blocked_by_the_ceiling` | `haiku@high → haiku@medium` is **permitted**. Guards against re-introducing interval dominance, which fails this case and collapses the feature. |
| `test_cap_dominance_is_symmetric` | Both sides priced at their full cap; swapping the arms flips the verdict exactly. |
| `test_never_raises_max_tokens` | Fuzz 10 000 bodies across all modes and flags: `body_after['max_tokens'] == body_before['max_tokens']` always. |
| `test_reduce_path_cannot_produce_a_400` | For every reducible `(model, req_rung, max_tokens)` triple in the catalog, `validate_thinking_body(mutated) is None`. |
| `test_validate_thinking_body_catches_every_400_shape` | `max_tokens <= budget_tokens`; `budget < min_budget`; `temperature` present with thinking enabled; missing `max_tokens` — each returns a non-empty error. |
| `test_invalid_mutation_forwards_original_bytes` | Force `_to_wire` to emit an invalid budget; assert forwarded bytes `==` original and `mutation_invalid` is recorded. |
| `test_no_reasoning_model_never_gets_a_reasoning_cell` | For every `shape:'none'` entry, `cap_tokens(m, rung) == 0` at every rung and no plan ever emits a `thinking` key for it. |
| `test_absent_reasoning_block_fails_closed` | An entry with no `reasoning` key ⇒ `reasoning_of` is `None` ⇒ rung never modified, reason `REASONING_UNKNOWN`. Distinct from `shape:'none'`. |
| `test_pricing_uses_row_pday_never_today` | `claude-sonnet-5` at `at='2026-08-31'` vs `'2026-09-01'` differ by exactly the promo delta; no code path calls `today_utc()`. |
| `test_thinking_in_history_blocks_all_mutation` | Any `thinking` block anywhere in `messages` ⇒ body byte-identical, reason `THINKING_IN_HISTORY`. |
| `test_sampling_conflict_blocks_enable_not_reduce` | `temperature: 0.3` + rung `off` ⇒ no enable. `temperature` absent + rung `high→low` ⇒ reduction proceeds. |
| `test_shape_mismatch_disqualifies_the_route` | Anthropic caller with explicit thinking, `OPENAI_MODELS` target with `shape:'none'` ⇒ passthrough, and the caller's reasoning field is **not stripped**. |

### 6.3 Sufficiency

| test | assertion |
|---|---|
| `test_sufficiency_corpus` | `cli/test/fixtures/sufficiency-corpus.json` (~200 prompts incl. adversarial: deictic **with** a fence present, empty tool result, truncated paste, bare `@mention`, code question with a stack trace) ⇒ exact `(verdict, sorted signal ids)`. |
| `test_sufficiency_ids_allowlist` | Every emitted signal id ∈ `SIGNAL_IDS`. **Closes the gap that `assertPrivacySafe` only catches paths and `$HOME`, so a matched regex fragment — prompt-derived text — would pass every existing guard.** |
| `test_sufficiency_never_escalates` | Over the corpus × every mode: `authorized(plan.model) <= authorized(requested)` and `rung_index(srv) <= rung_index(req)` on every insufficient row. |
| `test_sufficiency_holds_the_model` | On `insufficient` with no floor, `plan.model` resolves to the caller's own model; only the rung moved. |
| `test_sufficiency_clamps_to_low_never_off` | Served rung is `low` (== `min_budget`), never `off`. |
| `test_uncertain_never_acts` | `verdict == 'uncertain'` ⇒ body byte-identical in every mode. |
| `test_gateway_never_synthesizes_a_response` | No code path in `app.py` constructs a `Response` with a model-shaped body on the `/v1/messages` or `/v1/chat/completions` routes. Structural — AST scan, same shape as `test_every_data_route_declares_the_dependency`. |

### 6.4 Decision object / back-compat

| test | assertion |
|---|---|
| `test_router.py` (all 17 existing) | **Unchanged, must pass unedited.** `tier`/`model`/`reason` are real attributes with unchanged semantics. |
| `test_reason_substrings_are_stable` | `render_reason` still emits `auto-escalate`, `capped`, `passthrough`, `triage`, `dollar ceiling`, `min_tier` in the situations that produce them, and the rendered string is ≤300 chars. |
| `test_plan_postcondition_rejects_unrecorded_rung_change` | Constructing a `Plan` with `srv.rung != req.rung` and no `rung ` effect raises. |
| `test_plan_postcondition_rejects_locked_floor_violation` | Constructing a `Plan` with `floor.locked` and a moved rung raises. |
| `test_requested_effort_is_captured_pre_mutation` | With `reduce` active, the recorded `req_rung` is the caller's, not the served one. |
| `test_absent_vs_explicitly_off_are_distinct` | `{}` ⇒ `explicit=False`; `{"thinking":{"type":"disabled"}}` ⇒ `explicit=True, rung='off'`. |

### 6.5 Measurement / reporting

| test | assertion |
|---|---|
| `test_decision_of_credits_effort_only_reduction` | Same model, `srv_rung < req_rung` ⇒ `decision_of` returns `downgrade`, **not** `kept`. Currently fails (`reporting.py:479-480`). |
| `test_decision_type_credits_effort_only_reduction` | Same for `metrics._decision_type`. |
| `test_openai_reasoning_tokens_not_double_counted` | `completion_tokens=1000, reasoning_tokens=400` ⇒ priced `out_tok == 1000`, `rtok == 400`, `answer_tokens_obs == 600`. |
| `test_anthropic_thinking_counted_from_sse` | A synthetic SSE stream with `thinking` blocks yields `rtok > 0`, `rtok_src == 'counted'`. |
| `test_rtok_src_never_defaults_to_body` | A row with no reasoning evidence stores `''`, never `'body'`. |
| `test_counterfactual_out_tok_excludes_served_thinking` | Hand-computed fixture: counterfactual uses `answer_tokens_obs + T_hat(requested)`, **not** the served `out_tokens`. |
| `test_cold_cell_is_unpriceable_not_zero` | `n < 30` ⇒ figure is `None` and `estimator_cold` increments. |
| `test_effort_priced_plus_unpriced_equals_examined` | The reader-checkable identity holds over a mixed fixture. |
| `test_three_bases_never_sum` | No key returned by `fold_rows` combines `measured` / `estimated` / `counterfactual_tokens`. |
| `test_null_effort_rows_are_excluded_not_treated_as_unchanged` | Legacy rows with `srv_rung IS NULL` are counted in `unpriced`, never as "unchanged". |
| `test_holdback_cannot_be_zero_in_reduce_mode` | `CHEAPER_EFFORT_HOLDBACK=0` in `reduce` ⇒ clamped to 0.05 with a logged warning. |
| `test_holdback_assignment_is_retry_stable` | Same `(session, msg_index, plan_digest)` ⇒ same arm across 1 000 calls. |
| `test_gross_and_eligible_opportunity_are_separate_keys` | The summary exposes both; no key sums them. |

### 6.6 Migration / safety

| test | assertion |
|---|---|
| `test_body_untouched_by_default` | Over ~200 recorded bodies, default config: `json.dumps(after) == json.dumps(before)` for every reasoning field **and** `decide()` returns exactly today's `(tier, model)` for every row in `test_router.py`. **Byte-equality is checkable; "we don't think it changes anything" is not.** |
| `test_kill_switch_restores_byte_identity` | Run the corpus through `reduce`, then `observe`, in the same process; second pass byte-identical. No state, no cache, no carry-over. |
| `test_mode_never_inferred_from_another_flag` | Setting `ROUTER_ALLOW_UPGRADE=1` alone leaves `effort_mode == 'observe'`. |

### 6.7 Parity

| test / gate | assertion |
|---|---|
| `sync-prices.js --check` (extended) | `reasoningShape(id)` and `capTokens(id, rung)` identical across runtimes for every id × rung; `quality_floors.json` byte-identical to its projection; missing `python3` still **fails**. |
| `check-policy-parity.js` (new) | Both runtimes classify `sufficiency-corpus.json` and `floors_corpus.jsonl` and emit identical `{verdict, sorted ids}` / `{floor_id, locked}`; both classify the existing router cascade corpus and emit identical `(tier, reason)` — **closes the un-gated `classify.js` mirror**. |
| `test_store_parity.py` (extended) | Golden events replayed with the new fields; `emit.js` emits explicit `null`s for transcript rows; byte-for-byte at 10 dp, no epsilon, no skip. |
| `test_no_decider_in_js` | No `floors.*` / `sufficiency.*` under `cli/src/peek/`. |
| `test_row_fields_covers_every_new_column` | Every new store field is in `ROW_FIELDS`. |

---

## 7. Default and migration path

**Default: `CHEAPER_EFFORT_MODE=observe`. No release ever changes it.** Stage transitions are explicit user acts.

| stage | env | forwarded body | ships when |
|---|---|---|---|
| **S0 OBSERVE** *(default, forever)* | `observe` | **byte-identical to today** | C1–C7 |
| **S1 SHADOW REPORT** | `observe` | byte-identical | C8. Dashboard shows gross **and eligible** opportunity, `floor_defeated`, `estimator_cold`, fallback rate. **The user sees the number before consenting to the risk.** |
| **S2 REDUCE** | `reduce` | reductions only, floors exempt, ≥5 % control arm | C9, gated on F0–F3 |
| **S3 REDUCE, NO CONTROL** | `reduce_nocontrol` | as S2, holdback off | second explicit opt-in that states the regression estimate stops updating |
| **RAISE** | `reduce` + `CHEAPER_EFFORT_ALLOW_RAISE=1` + `ROUTER_ALLOW_UPGRADE=1` | raises inside cap dominance | not before F2 |

Per-request escape hatch `x-cheaper-effort: passthrough`; existing `x-router-bypass` still bypasses everything. Response headers always state what happened: `x-router-effort-requested`, `x-router-effort-served`, `x-router-effort-applied`, `x-cheaper-quality-warning`, `x-cheaper-context`.

**Documentation obligations that are part of the change, not follow-ups.** `_extract_effort`'s "measure-only — never modified" (`app.py:72`) and `metrics.py:123-127`'s "Reasoning effort is only MEASURED here" both become false the moment `reduce` ships and must die in the same commit. `metrics.summary()`'s `reasoning_opportunities` must be **renamed, not redefined in place**: keep the old key deprecated, add `reasoning_opportunities_eligible` excluding rows where `effort_applied=1`, or the dashboard books the same saving twice.

---

## 8. What this does NOT solve

1. **It cannot prove any individual answer was as good.** Every quality signal is a proxy; the audit sampler produces a judge's opinion, which is a better proxy, not truth. The claim is always "no regression detected at this power", never "quality preserved".
2. **It cannot validate the floor.** Floor rows are excluded from the A/B by construction, because the repair proxy is structurally blind to a confidently-wrong answer the user *accepts* — exactly the failure the floor exists for. So the floor's value rests on reasoning, not evidence, permanently. A floor that is 90 % false-positive would surface only as lost savings. **This is the weakest foundation in the document and it is not dressed up.**
3. **The floor is keyword-shaped** and will miss a high-stakes request phrased with no matching vocabulary. The corpus measures the miss rate; it does not close it.
4. **It cannot measure Anthropic thinking tokens exactly.** No usage breakout exists; chars/4 over `thinking_delta` has unknown tokenisation bias. The measured layer is weakest for the majority of traffic.
5. **It cannot touch a conversation that already contains thinking blocks** — which excludes most turns of any tool-using agent session. Realistically this reaches first turns and non-tool chats. **If the dashboard does not split gross from eligible, it will materially overstate the case, and that overstatement is the most likely way this ships something worthless.**
6. **It cannot see context it is not sent** — system prompts referencing files, MCP resources, harness-injected material outside `extract_text`. Every such case is a false "insufficient". Because the response is a rung clamp rather than a block, the cost of being wrong is bounded; that mildness is what makes an imperfect detector shippable.
7. **It cannot activate on a low-volume install.** `n ≥ 30` per `(model, rung, ctier)` means most cells stay cold forever for a light user, so the *savings figure* never renders. **This is the primary ship risk: the modal single-vendor install may see nothing.** It is fail-inert, not fail-wrong, and Stage 0's free SQL reveals it before any router code is written.
8. **It cannot separate a model change from a rung change on one call.** The holdback randomizes one factor at a time, roughly doubling the volume needed for either estimate.
9. **`budget_tokens` is a cap, not a target.** Lowering a budget that was never being hit saves exactly nothing. This is handled — the ceiling is denominated in caps and provable; the savings figure is denominated in realized tokens and can refuse — but **it means the addressable saving is unknown until F0 runs, and F0 may be zero.**
10. **It does nothing for `x-router-bypass` traffic** or any harness that never reaches the gateway. For `peek`-only users everything here is observational forever.
11. **It does not address prompt-cache invalidation on a model switch — which may be worth more than this entire workstream.** See §10.

---

## 9. The falsifiers, in order. Do not write code past a failed gate.

**F0 — Consumption, not budgets. $0, one query, runnable this afternoon. RUN BEFORE ANY COMMIT.**
`requested_effort`, `out_tokens`, `usage_source`, `status`, `model` are **already columns** — verified.

```sql
SELECT model, requested_effort, COUNT(*) n, 
       AVG(out_tokens) mean_out,
       MIN(out_tokens) min_out, MAX(out_tokens) max_out
FROM decisions
WHERE usage_source='body' AND status BETWEEN 200 AND 299
GROUP BY 1,2 ORDER BY 1,2;
```
**Kill criteria, both of them:** (a) rows at `medium|high` are under ~5 % of priceable traffic ⇒ the effort axis has no money in it; (b) the median `out_tokens` delta between `high` and `none` on the same model is not materially above zero ⇒ budgets are not being consumed, lowering them saves nothing, and every dollar figure in every design considered here is inflated by the unhit ratio. **Either failure kills the feature. Do not proceed to C1.**

**F1 — Sufficiency precision. $0, one afternoon, tests the riskiest component.**
Run `sufficiency.detect` alone over the transcripts already on disk. Hand-label 100 `insufficient` rows. **Kill: precision < 90 %.** A false positive clamps a real request's rung — the only action here that degrades a good request.

**F2 — Floor coverage. $0, one query, after one week of S0.**
`SELECT floor_id, req_rung, COUNT(*) FROM decisions GROUP BY 1,2`. **Kill: floors cover > 70 % of medium/high-effort traffic.** Note the direction: `\bcontract\b`, `\block(?:s|ing|-free)?\b`, `\bfinanc(?:e|ial)\b`, `\barchitect(?:ure|ing)?\b` fire constantly and benignly on developer traffic ("the API contract", "unlock the button", "component architecture"), so a high number is **likely, not hypothetical.** This is a genuine kill gate, not a formality. The Layer-D ratchet doubles as its live feed, so it is nearly free.

**F3 — The floor's teeth. One day, $0.**
100 genuinely high-stakes prompts written deliberately to avoid the protected vocabulary. **Kill: more than ~5 get their rung reduced ⇒ the floor is decorative and the default stays off permanently regardless of F0–F2**, because the floor is the only thing between this design and the one failure the product cannot survive.

**F4 — The quality claim. The only one that costs money, and deliberately last.**
200 requests sampled from real *eligible* traffic, run at the served and requested cells, blind pairwise judging with randomised presentation order. Total cost is computable up front from the catalog. **Kill: the reduced arm loses more than 5 % of pairs (win-rate CI lower bound below 0.45) ⇒ `reduce` never leaves shadow.** State the threshold before looking at the data.

**F5 — The invariant, as a fuzz test.** 10 000 random `(caller model, caller rung, max_tokens, prompt)` triples across the whole catalog: `authorized(served) <= authorized(requested)` always; no locked-floor row served below its floor without `floor_defeated=1`; `max_tokens` never moved; default config byte-identical. Any counterexample is a shipped bug.

---

## 10. Work order — independently shippable commits, smallest-safety-first

| # | commit | risk | ships alone? |
|---|---|---|---|
| **C0** | `cli/scripts/effort-headroom.js` — runs F0's two queries against `~/.cheaper/metrics.db` and prints consumption-vs-budget by model × rung. **No product code.** Gate: F0 must pass. | none | yes |
| **C1** | **Fix `reporting.decision_of` + `metrics._decision_type`.** Both label an effort-only reduction `kept` today, so it receives no downgrade credit in the `decision` breakdown (`_DIMS`, `reporting.py:1063`), the Logs filter, `matching_views`, or any export. Pure bug fix; no new feature depends on it, but everything after it does. | none | yes |
| **C2** | **Record the truth.** Capture requested effort **pre-mutation**; split absent vs explicitly-off; add `rtok`/`rtok_src`/`answer_tokens_obs`/`max_tokens_req`/`stop_reason`; SSE `thinking` block counter; OpenAI `reasoning_tokens` recorded and asserted **not** added to cost. `ROW_FIELDS` + `emit.js` nulls + `test_store_parity` extended. **Zero behaviour change.** Fixes the Anthropic coverage hole that would otherwise starve the whole ladder. | none | yes |
| **C3** | **Quality floors as data.** `quality_floors.js` → `.json` via `sync-prices.js`; `quality_floors.py` with the import-time digest guard; the full §6.1 test battery including the mutation test and the corpus; `FLOOR_BASELINE.json` + the weekly ratchet job. `floor_id`/`floor_ver`/`floor_digest`/`floor_defeated` recorded. **Floor is recorded only; it gates nothing yet.** Gate: F3 must pass. | none | yes |
| **C4** | **Sufficiency as data.** `sufficiency.py` + corpus + allowlist test + `check-policy-parity.js` (which also closes the un-gated `classify.js` mirror). Recorded only. Gate: F1 must pass. | none | yes |
| **C5** | **`Plan` + closed `Reason` enum + `plan_json`.** `decide()` returns `Plan`; `Decision` preserved as a view; the post-conditions armed. `test_router.py`'s 17 tests pass **unedited**; substrings pinned. Still zero behaviour change. | low | yes |
| **C6** | **Catalog `reasoning` block + `effort.py` + the authorization ceiling.** Replaces `_RANK_BASKET` for requests that carry `max_tokens`; falls back to today's basket when they do not. **Deletes `_THINK_TOKENS` from every decision and dollar path**; the legacy `saved_reasoning_potential` keys are relabelled `illustrative` and deprecated, not silently redefined. Parity probes extended. `effort_mode` plumbed, default `observe`. | low | yes |
| **C7** | **Shape disqualifier.** A route to a model that cannot honour the caller's reasoning spec is refused rather than silently stripped. Fixes the probable live `gpt-4o` + `reasoning_effort` 400. **First commit with a real behaviour change** — more passthroughs on mixed `OPENAI_MODELS` maps, ~0 impact on stock Anthropic installs. | medium | yes |
| **C8** | **S1 dashboard.** Gross **and** eligible opportunity as separate keys; `estimator_cold` as a first-class exclusion; the `effort_priced + Σunpriced == examined` identity; `floor_defeated`; the fallback-rate alarm; `escalation_within_session` (zero new fields). The publishing rule enforced in the template. Gate: F2 must pass before proceeding. | none | yes |
| **C9** | **The write path.** `choose_effort` + `_to_wire` + `validate_thinking_body` + `_apply_plan`; `reduce` mode; mandatory ≥5 % holdback; `~/.cheaper/effort_model.json` writer with p90 and the `n≥30` gate. Gate: F4 must pass before the dashboard prints any effort-savings dollar. | **high** | yes |
| **C10** | **Audit + raise.** `cheaper verify` (offline paired re-run, blind judge, cost disclosed, opt-in, never in the hot path); `CHEAPER_EFFORT_ALLOW_RAISE`. | high | yes |

### Separate workstream, ahead of all of the above

**W1 — the prompt-cache migration term.** A model change discards the caller's prompt cache. On `claude-opus-5` a 200 k cached prefix reads at `$0.10` and rewrites at `$1.25` — a **$1.15 first-call penalty** against per-call downgrade savings typically an order of magnitude smaller. Today's counterfactual prices both arms on the same token split, so **on cache-heavy agent traffic the router that is already shipped can be cost-negative and the ledger cannot show it.** That is a defect in what is live, not a feature request, and it plausibly outweighs this entire ladder. **It must not ride on this feature's flag, this feature's gates, or this feature's schedule.**

---

## 11. The one line that governs everything

> **Anything that produces a dollar figure a user reads is dual-runtime and parity-gated. Anything that makes a decision is single-runtime and digest-pinned. The ceiling is denominated in caps, is provable, and contains no estimator. The savings figure is denominated in realized tokens, is measured, and is allowed to refuse. The two are different denominations on purpose and must never be summed.**