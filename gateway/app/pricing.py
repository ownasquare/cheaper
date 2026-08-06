"""Faithful Python port of the peek CLI's classify.js + pricing.js.

Mirrors, number-for-number and regex-for-regex:
  - cli/src/peek/classify.js  (TIERS, rank, CHEAP_SIGNALS, TOP_SIGNALS, model_tier)
  - cli/src/peek/pricing.js   (FAMILIES, BUCKET, detect_family, rate, cost_of,
                                estimate_call)

so the live gateway can compute the same real-dollar savings estimate that the
`peek` CLI reports. Do not invent or "improve" any price here — if pricing.js
changes, update this file to match, don't diverge.

Pure stdlib (``re``), no external dependencies.
"""

from __future__ import annotations

import re

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


# --- pricing.js --------------------------------------------------------------

# family -> tier -> { model, in, out }  ($ per 1M tokens)
FAMILIES: dict[str, dict] = {
    "anthropic": {
        "label": "Anthropic",
        "cheap": {"model": "claude-haiku-4-5", "in": 1.0, "out": 5.0},
        "mid": {"model": "claude-sonnet-4-5", "in": 3.0, "out": 15.0},
        "top": {"model": "claude-opus-4", "in": 15.0, "out": 75.0},
    },
    "openai": {
        "label": "OpenAI",
        "cheap": {"model": "gpt-4o-mini", "in": 0.15, "out": 0.60},
        "mid": {"model": "gpt-4o", "in": 2.5, "out": 10.0},
        "top": {"model": "o3", "in": 15.0, "out": 60.0},
    },
    "google": {
        "label": "Google",
        "cheap": {"model": "gemini-1.5-flash-8b", "in": 0.075, "out": 0.30},
        "mid": {"model": "gemini-2.5-flash", "in": 0.30, "out": 2.50},
        "top": {"model": "gemini-2.5-pro", "in": 1.25, "out": 10.0},
    },
    "xai": {
        "label": "xAI",
        "cheap": {"model": "grok-3-mini", "in": 0.30, "out": 0.50},
        "mid": {"model": "grok-3", "in": 3.0, "out": 15.0},
        "top": {"model": "grok-4", "in": 5.0, "out": 25.0},
    },
    "deepseek": {
        "label": "DeepSeek",
        "cheap": {"model": "deepseek-chat", "in": 0.27, "out": 1.10},
        "mid": {"model": "deepseek-chat", "in": 0.27, "out": 1.10},
        "top": {"model": "deepseek-reasoner", "in": 0.55, "out": 2.19},
    },
    "qwen": {
        "label": "Qwen",
        "cheap": {"model": "qwen2.5-7b", "in": 0.10, "out": 0.20},
        "mid": {"model": "qwen2.5-32b", "in": 0.30, "out": 0.60},
        "top": {"model": "qwen2.5-72b", "in": 0.70, "out": 1.40},
    },
    "meta": {
        "label": "Meta",
        "cheap": {"model": "llama-3.1-8b", "in": 0.05, "out": 0.10},
        "mid": {"model": "llama-3.3-70b", "in": 0.30, "out": 0.40},
        "top": {"model": "llama-3.1-405b", "in": 2.70, "out": 2.70},
    },
    "mistral": {
        "label": "Mistral",
        "cheap": {"model": "mistral-small", "in": 0.20, "out": 0.60},
        "mid": {"model": "mistral-medium", "in": 0.40, "out": 2.00},
        "top": {"model": "mistral-large", "in": 2.00, "out": 6.00},
    },
    "other": {
        "label": "Other",
        "cheap": {"model": "small", "in": 0.20, "out": 0.60},
        "mid": {"model": "mid", "in": 1.00, "out": 3.00},
        "top": {"model": "top", "in": 5.00, "out": 15.00},
    },
}

# tier name (haiku|sonnet|opus) -> pricing bucket (cheap|mid|top)
BUCKET = {"haiku": "cheap", "sonnet": "mid", "opus": "top"}

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
    ("mistral", re.compile(r"(mistral|mixtral|codestral|ministral)", re.IGNORECASE)),
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


def rate(family: str | None, tier_name: str | None) -> dict:
    fam = FAMILIES.get(family, FAMILIES["other"]) if family is not None else FAMILIES["other"]
    bucket = BUCKET.get(tier_name) if tier_name is not None else None
    return fam.get(bucket) or fam["mid"]


def cost_of(family: str | None, tier_name: str | None, in_tok: float, out_tok: float) -> float:
    r = rate(family, tier_name)
    return (in_tok / 1e6) * r["in"] + (out_tok / 1e6) * r["out"]


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
    if not family or not actual_tier:
        return {
            "family": family or "other",
            "actual_tier": None,
            "eff_tier": None,
            "actual_cost": 0.0,
            "new_cost": 0.0,
            "saved": 0.0,
            "downgraded": False,
        }
    eff_rank = min(rank(actual_tier), rank(content_tier_name))
    eff_tier = TIERS[eff_rank]
    actual_cost = cost_of(family, actual_tier, in_tok, out_tok)
    new_cost = cost_of(family, eff_tier, in_tok, out_tok)
    saved = max(0.0, actual_cost - new_cost)
    return {
        "family": family,
        "actual_tier": actual_tier,
        "eff_tier": eff_tier,
        "actual_cost": actual_cost,
        "new_cost": new_cost,
        "saved": saved,
        "downgraded": eff_rank < rank(actual_tier),
    }


if __name__ == "__main__":
    assert detect_family("claude-opus-4") == "anthropic"
    assert detect_family("gpt-4o") == "openai"
    assert detect_family("some-random-model") is None
    assert model_tier("o3-mini") == "haiku"
    assert model_tier("claude-opus-4") == "opus"
    e = estimate_call("claude-opus-4", 1_000_000, 1_000_000, "haiku")
    assert abs(e["saved"] - 84.0) < 1e-9, e
    assert estimate_call("totally-unknown", 1_000_000, 1_000_000, "haiku")["saved"] == 0.0
    print("pricing.py self-checks passed")
