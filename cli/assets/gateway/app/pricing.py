"""Faithful Python port of the peek CLI's classify.js + pricing.js.

Mirrors, regex-for-regex:
  - cli/src/peek/classify.js  (TIERS, rank, CHEAP_SIGNALS, TOP_SIGNALS, model_tier)
  - cli/src/peek/pricing.js   (BUCKET, detect_family, rate, cost_of, estimate_call)

so the live gateway can compute the same real-dollar savings estimate that the
`peek` CLI reports.

PRICES ARE NOT DUPLICATED HERE. They are loaded from ``model_prices.json``, which
is generated from ``cli/src/peek/models.js`` by ``cli/scripts/sync-prices.js``.
Two hand-maintained copies of a price table is precisely how this file drifted a
full model generation behind the CLI — pricing Opus 5 traffic at retired Opus 4
rates and overstating every session threefold. The gateway's figures are shown to
the user without a "~" (they are the exact path), so a divergence here is an
authoritative-looking wrong number.

To change a price: edit the JS catalog, run ``node cli/scripts/sync-prices.js``.
Never edit the JSON or hardcode a rate in this file.

Pure stdlib (``json``, ``re``), no external dependencies.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone

# --- classify.js -----------------------------------------------------------

# Tier ordering: index is the rank (higher = more capable).
TIERS = ["haiku", "sonnet", "opus"]


def rank(tier: str | None) -> int:
    """Mirror JS Array.prototype.indexOf: -1 if not present."""
    try:
        return TIERS.index(tier)  # type: ignore[arg-type]
    except ValueError:
        return -1


# Word-boundaried so "mini" doesn't fire inside "geMINI", etc.
CHEAP_SIGNALS = re.compile(
    r"(\bhaiku|\bmini\b|\bnano\b|\bflash\b|\blite\b|\bsmall\b|\binstant\b|"
    r"\b8b\b|\b7b\b|\b3b\b|\btiny\b|\bmicro\b|\bembed)",
    re.IGNORECASE,
)
TOP_SIGNALS = re.compile(
    r"(\bopus|\bultra\b|[-\s]pro\b|\breasoner\b|\bthinking\b|\bo1\b|\bo3\b|"
    r"\bo4\b|\b405b\b|\b72b\b|\blarge\b|grok-4|grok-3\b|deepseek-r1|\bqwq\b)",
    re.IGNORECASE,
)


def model_tier(model_id: str | None) -> str | None:
    """Map an arbitrary model id to a coarse capability tier (haiku|sonnet|opus).

    Cheap signals win over top signals (e.g. "o3-mini" is cheap).
    """
    m = str(model_id or "").lower()
    if not m:
        return None
    if CHEAP_SIGNALS.search(m):
        return "haiku"
    if TOP_SIGNALS.search(m):
        return "opus"
    return "sonnet"


# --- price catalog (generated; see module docstring) --------------------------

_PRICES_PATH = os.path.join(os.path.dirname(__file__), "model_prices.json")

with open(_PRICES_PATH, encoding="utf-8") as _fh:
    _CATALOG_DOC = json.load(_fh)

CATALOG: list[dict] = _CATALOG_DOC["models"]
CATALOG_AS_OF: str = _CATALOG_DOC["as_of"]
# family -> bucket -> the real model that bucket is priced as.
REPRESENTATIVE: dict[str, dict] = _CATALOG_DOC["representative"]

# tier name (haiku|sonnet|opus) -> pricing bucket (cheap|mid|top)
BUCKET = {"haiku": "cheap", "sonnet": "mid", "opus": "top"}


def normalize_id(model_id: str | None) -> str:
    """Strip provider prefixes, dated snapshots and version suffixes.

    Mirrors normalizeId() in models.js so ``us.anthropic.claude-opus-5``,
    ``claude-opus-5-20260101`` and ``claude-opus-5`` all resolve alike.
    """
    m = str(model_id or "").lower().strip()
    if not m:
        return ""
    m = re.sub(r"^[a-z0-9_-]+/", "", m)
    m = re.sub(r"^(?:[a-z]{2}\.)?anthropic\.", "", m)
    m = re.sub(r"@\d{8}$", "", m)
    m = re.sub(r"-\d{8}$", "", m)
    m = re.sub(r"-(?:latest|preview|exp)$", "", m)
    return m


def canonical(model_id: str | None) -> str:
    """Canonical comparison form. Providers mix `.` and `-`; both collapse to `-`."""
    return normalize_id(model_id).replace(".", "-")


def _entry_matches(candidate_canonical: str, entry: dict) -> bool:
    """EXACT match (after normalization), never prefix. Mirrors entryMatches() in models.js.

    Prefix matching fails OPEN: an id the catalog has never seen inherits a sibling's
    rate. `claude-opus-4-9` used to resolve to `claude-opus-4` and price at the retired
    $15/$75 -- a 3x overstatement, and the exact shape of the incident this catalog was
    built to prevent. It also made the "unknown => unpriceable" rule unreachable, and
    left no catalog diff for review or alarms to catch.

    Exact matching fails CLOSED. Legitimate spelling variants are handled by
    normalize_id() (provider prefixes, dated snapshots) or by an explicit `aliases`
    list on the entry -- never implicitly.
    """
    if canonical(entry["id"]) == candidate_canonical:
        return True
    for alias in entry.get("aliases") or []:
        if canonical(alias) == candidate_canonical:
            return True
    return False


def today_utc() -> str:
    """Today, UTC, as YYYY-MM-DD. The default pricing date -- see resolve_model()."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _in_window(win: dict | None, at: str | None) -> bool:
    if not win or not at:
        return False
    if win.get("from") and at < win["from"]:
        return False
    if win.get("until") and at > win["until"]:
        return False
    return True


def resolve_model(model_id: str | None, at: str | None = None) -> dict | None:
    """Catalog entry for a model, or None when we hold no published price.

    ``at`` (YYYY-MM-DD) is the date to price AT. It deliberately does NOT default to
    CATALOG_AS_OF: a frozen default keeps an expired promotional window open forever.
    Claude Sonnet 5's launch pricing ends 2026-08-31, and with a CATALOG_AS_OF default
    every caller would keep quoting $2/$10 instead of $3/$15 indefinitely -- a silent
    ~33% understatement that no catalog refresh would fix, because the bug is in the
    date rather than the rates. Mirrors resolveModel() in models.js.
    """
    cand = canonical(model_id)
    if not cand:
        return None
    best = None
    for entry in CATALOG:
        if _entry_matches(cand, entry):
            best = entry
            break
    if best is None:
        return None
    day = at or today_utc()
    if _in_window(best.get("window"), day):
        merged = dict(best)
        promo = {k: v for k, v in best["window"].items() if k not in ("from", "until")}
        merged.update(promo)
        return merged
    return best


def rates_for(entry: dict | None, input_tokens: float = 0.0,
              speed: str | None = None, service_tier: str | None = None) -> dict | None:
    """Effective per-token rates, after long-context / speed / service-tier rules."""
    if not entry:
        return None
    r = {
        "in": entry["in"],
        "out": entry["out"],
        "cacheRead": entry.get("cacheRead"),
        "cacheWrite": entry.get("cacheWrite"),
        "cacheWrite1h": entry.get("cacheWrite1h"),
    }

    lc = entry.get("longContext")
    if lc and input_tokens > lc["over"]:
        base_in = entry["in"]
        if r["cacheWrite"] is not None:
            r["cacheWrite"] = lc["in"] * (entry["cacheWrite"] / base_in)
        if r["cacheWrite1h"] is not None:
            r["cacheWrite1h"] = lc["in"] * (entry["cacheWrite1h"] / base_in)
        r["in"] = lc["in"]
        r["out"] = lc["out"]
        if lc.get("cacheRead") is not None:
            r["cacheRead"] = lc["cacheRead"]

    fast = (entry.get("speed") or {}).get("fast")
    if speed == "fast" and fast:
        scale = fast["in"] / r["in"]
        r = {
            "in": fast["in"],
            "out": fast["out"],
            "cacheRead": None if r["cacheRead"] is None else r["cacheRead"] * scale,
            "cacheWrite": None if r["cacheWrite"] is None else r["cacheWrite"] * scale,
            "cacheWrite1h": None if r["cacheWrite1h"] is None else r["cacheWrite1h"] * scale,
        }

    mult = 0.5 if service_tier == "batch" else 1.8 if service_tier == "priority" else 1.0
    if mult != 1.0:
        for k in ("in", "out", "cacheRead", "cacheWrite", "cacheWrite1h"):
            if r[k] is not None:
                r[k] *= mult

    # Fall back only within a model's own sheet: no published cache discount means
    # cache traffic bills at that model's input rate. Never borrow another model's.
    if r["cacheRead"] is None:
        r["cacheRead"] = r["in"]
    if r["cacheWrite"] is None:
        r["cacheWrite"] = r["in"]
    if r["cacheWrite1h"] is None:
        r["cacheWrite1h"] = r["cacheWrite"]
    return r


def is_priceable(model_id: str | None) -> bool:
    """True when published rates exist for this exact model."""
    return resolve_model(model_id) is not None


def representative_for(family: str | None, tier_name: str | None) -> str | None:
    fam = REPRESENTATIVE.get(family or "")
    if not fam:
        return None
    return fam.get(BUCKET.get(tier_name or "", "mid")) or fam.get("mid")

# Ordered, case-insensitive family-detection patterns (same order as pricing.js).
_FAMILY_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("anthropic", re.compile(r"(claude|haiku|sonnet|opus|anthropic)", re.IGNORECASE)),
    (
        "openai",
        re.compile(
            r"(gpt|davinci|babbage|chatgpt|\bo1\b|-o1|\bo3\b|-o3|\bo4\b|-o4|openai)",
            re.IGNORECASE,
        ),
    ),
    ("google", re.compile(r"(gemini|palm|bison|gemma)", re.IGNORECASE)),
    ("xai", re.compile(r"grok", re.IGNORECASE)),
    ("deepseek", re.compile(r"deepseek", re.IGNORECASE)),
    ("qwen", re.compile(r"qwen|qwq", re.IGNORECASE)),
    ("meta", re.compile(r"(llama|meta-llama)", re.IGNORECASE)),
    # Must stay in lock-step with FAMILY_PATTERNS in cli/src/peek/pricing.js. Drift here
    # is silent: a family the JS recognises but Python does not reports $0 saved on the
    # gateway path, which is the path that prints no "about" qualifier.
    ("mistral", re.compile(r"(mistral|mixtral|codestral|ministral|magistral|devstral)", re.IGNORECASE)),
]


def detect_family(model_id: str | None) -> str | None:
    """Returns None for models we don't actually recognize. That is deliberate:
    an unknown model must be UNPRICEABLE (saved=0), never priced against
    arbitrary 'other' rates and reported as a saving that didn't happen.
    """
    m = str(model_id or "").lower()
    if not m:
        return None
    for family, pattern in _FAMILY_PATTERNS:
        if pattern.search(m):
            return family
    return None  # unrecognized -> unpriceable


def rate(family: str | None, tier_name: str | None) -> dict | None:
    """Per-token rates for a family+tier bucket, priced as that bucket's real model."""
    rep = representative_for(family, tier_name)
    if not rep:
        return None
    return rates_for(resolve_model(rep))


def cost_of_model(
    model_id: str | None,
    in_tok: float = 0.0,
    out_tok: float = 0.0,
    cache_read: float = 0.0,
    cache_create_5m: float = 0.0,
    cache_create_1h: float = 0.0,
    speed: str | None = None,
    service_tier: str | None = None,
    at: str | None = None,
) -> float | None:
    """Exact cost of one call on a specific model, or None if unpriceable.

    ``out_tok`` already includes reasoning/thinking tokens: every provider bills
    reasoning at the output rate and folds it into the reported output count, so a
    higher reasoning-effort setting needs no separate term here.

    ``at`` (YYYY-MM-DD) is the date the call happened, used to select promotional
    windows; defaults to today inside resolve_model().
    """
    entry = resolve_model(model_id, at)
    if entry is None:
        return None
    total_in = in_tok + cache_read + cache_create_5m + cache_create_1h
    r = rates_for(entry, input_tokens=total_in, speed=speed, service_tier=service_tier)
    return (
        (in_tok / 1e6) * r["in"]
        + (cache_create_5m / 1e6) * r["cacheWrite"]
        + (cache_create_1h / 1e6) * r["cacheWrite1h"]
        + (cache_read / 1e6) * r["cacheRead"]
        + (out_tok / 1e6) * r["out"]
    )


def cost_of(family: str | None, tier_name: str | None, in_tok: float, out_tok: float) -> float:
    """Bucket cost, used only where a concrete model id is unavailable."""
    rep = representative_for(family, tier_name)
    if not rep:
        return 0.0
    return cost_of_model(rep, in_tok=in_tok, out_tok=out_tok) or 0.0


def estimate_call(
    actual_model: str | None,
    in_tok: float,
    out_tok: float,
    content_tier_name: str | None,
) -> dict:
    """Core per-call estimate. content_tier_name is the tier the classifier
    picked from the prompt text. Returns nulls when the model is unknown
    (can't price safely).
    """
    family = detect_family(actual_model)
    actual_tier = model_tier(actual_model)  # haiku|sonnet|opus, or None
    if not family or not actual_tier or not is_priceable(actual_model):
        return {
            "family": family or "other",
            "actual_tier": None,
            "eff_tier": None,
            "actual_cost": 0.0,
            "new_cost": 0.0,
            "saved": 0.0,
            "downgraded": False,
            "priceable": False,
        }
    eff_rank = min(rank(actual_tier), rank(content_tier_name))
    eff_tier = TIERS[eff_rank]
    # The leg that actually ran is priced against the real model; only the cheaper
    # counterfactual falls back to the same family's representative model.
    actual_cost = cost_of_model(actual_model, in_tok=in_tok, out_tok=out_tok) or 0.0
    new_cost = (
        actual_cost
        if eff_rank == rank(actual_tier)
        else cost_of(family, eff_tier, in_tok, out_tok)
    )
    saved = max(0.0, actual_cost - new_cost)
    return {
        "family": family,
        "actual_tier": actual_tier,
        "eff_tier": eff_tier,
        "actual_cost": actual_cost,
        "new_cost": new_cost,
        "saved": saved,
        "downgraded": eff_rank < rank(actual_tier),
        "priceable": True,
    }


if __name__ == "__main__":
    assert detect_family("claude-opus-4") == "anthropic"
    assert detect_family("gpt-4o") == "openai"
    assert detect_family("some-random-model") is None
    assert model_tier("o3-mini") == "haiku"
    assert model_tier("claude-opus-4") == "opus"

    # Retired Opus 4 really is $15/$75; the current Opus 5 is $5/$25. Pricing one as
    # the other is the drift this file existed to prevent.
    assert abs(cost_of_model("claude-opus-4", 1e6, 1e6) - 90.0) < 1e-9
    assert abs(cost_of_model("claude-opus-5", 1e6, 1e6) - 30.0) < 1e-9
    e = estimate_call("claude-opus-4", 1_000_000, 1_000_000, "haiku")
    assert abs(e["saved"] - 84.0) < 1e-9, e

    # Cache: read 0.1x, 5m write 1.25x, 1h write 2x of the model's own input rate.
    assert abs(cost_of_model("claude-opus-5", cache_read=1e6) - 0.5) < 1e-9
    assert abs(cost_of_model("claude-opus-5", cache_create_5m=1e6) - 6.25) < 1e-9
    assert abs(cost_of_model("claude-opus-5", cache_create_1h=1e6) - 10.0) < 1e-9

    # Long-context tier, speed SKU and service tier all change the rate.
    assert abs(cost_of_model("gemini-2.5-pro", in_tok=1e5) - 0.125) < 1e-9
    assert abs(cost_of_model("gemini-2.5-pro", in_tok=3e5) - 0.75) < 1e-9
    assert abs(cost_of_model("claude-opus-5", 1e6, 1e6, speed="fast") - 60.0) < 1e-9
    assert abs(cost_of_model("claude-opus-5", 1e6, 1e6, service_tier="batch") - 15.0) < 1e-9

    # Prefixed / dated ids resolve; open-weight models stay unpriceable.
    assert abs(cost_of_model("us.anthropic.claude-opus-5", 1e6, 1e6) - 30.0) < 1e-9
    assert abs(cost_of_model("claude-opus-5-20260101", 1e6, 1e6) - 30.0) < 1e-9
    assert cost_of_model("llama-4-maverick", 1e6, 1e6) is None
    assert not is_priceable("llama-4-maverick")

    # FAIL CLOSED: an unknown id must never inherit a sibling's rate by prefix.
    # `claude-opus-4-9` inheriting `claude-opus-4` priced a hypothetical new Opus at
    # the retired $15/$75 -- a 3x overstatement with no catalog diff to review.
    # Must stay byte-identical in behaviour to entryMatches() in models.js.
    for unknown in ("claude-opus-4-9", "claude-sonnet-5-2", "gpt-5.6",
                    "gpt-5-codex", "o3-deep-research", "claude-opus-6", "grok-5"):
        assert not is_priceable(unknown), unknown + " must be unpriceable"
        assert cost_of_model(unknown, 1e6, 1e6) is None, unknown + " must price as None"

    # Promotional windows are evaluated against the date the call happened, and the
    # DEFAULT is today -- never CATALOG_AS_OF, which would hold an expired window open
    # forever. Sonnet 5's launch pricing ($2/$10) ends 2026-08-31; from 2026-09-01 the
    # standard $3/$15 must apply with no catalog change.
    assert abs(cost_of_model("claude-sonnet-5", 1e6, 1e6, at="2026-08-06") - 12.0) < 1e-9
    assert abs(cost_of_model("claude-sonnet-5", 1e6, 1e6, at="2026-08-31") - 12.0) < 1e-9
    assert abs(cost_of_model("claude-sonnet-5", 1e6, 1e6, at="2026-09-01") - 18.0) < 1e-9
    assert today_utc() >= "2026-01-01" and len(today_utc()) == 10
    assert estimate_call("totally-unknown", 1_000_000, 1_000_000, "haiku")["saved"] == 0.0
    assert estimate_call("llama-4-maverick", 1_000_000, 1_000_000, "haiku")["saved"] == 0.0

    print("pricing.py self-checks passed (catalog as of %s)" % CATALOG_AS_OF)
