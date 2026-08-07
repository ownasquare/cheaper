"""Pure-Python routing core for the model-router gateway.

No network or framework imports live here so the routing decision is fully
unit-testable. `classify()` looks at the request text and returns which tier a
request should run on, plus a short reason. `app.py` maps the tier to a concrete
model id and forwards the request upstream.

Design mirrors the adaptive-model-router skill:
- Cheapest tier by default.
- Auto-escalate categories (concurrency, security, proofs, ...) jump to the top
  tier regardless of surface, because a plausible-but-wrong answer there is costly.
- A "needs more info on a correctness-critical task" case is treated as hard, not
  simple.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

# Real-dollar pricing, so the requested-model ceiling can be enforced in money rather
# than in capability rank. Guarded: the router still works without it, minus the
# dollar ceiling. Keep this the ONLY thing router.py imports from pricing.
try:
    from pricing import cost_of_model  # type: ignore
    _PRICING = True
except Exception:  # pragma: no cover - import-order safety
    _PRICING = False

# A fixed basket for comparing two models' unit cost. Same rationale as the CLI's
# CEILING_BASKET: ranking on the live request's own token mix would make the decision
# depend on the request, so a long prompt could unlock an escalation a short one can't.
_RANK_BASKET = dict(in_tok=1_000_000, out_tok=1_000_000)


def _unit_cost(model_id) -> Optional[float]:
    if not _PRICING or not model_id:
        return None
    try:
        return cost_of_model(str(model_id), **_RANK_BASKET)
    except Exception:
        return None

# Tier ordering: index is the rank (higher = more capable).
TIERS = ("haiku", "sonnet", "opus")


def _rank(tier: str) -> int:
    return TIERS.index(tier)


# --- Category signals -------------------------------------------------------
# Word-boundary regexes so "auth" doesn't fire on "author", etc.

_OPUS_PATTERNS = [
    r"\bconcurren(?:t|cy)\b", r"\bdeadlock\b", r"\brace condition\b", r"\bmutex\b",
    r"\block(?:s|ing|-free)?\b", r"\bthread(?:s|ing|-safe)?\b", r"\bsemaphore\b",
    r"\baba problem\b", r"\bmemory[- ]order", r"\batomic(?:s|ity)?\b",
    r"\bsecurity\b", r"\bvulnerab", r"\bexploit\b", r"\bcrypto(?:graph)?", r"\bauth(?:entication|orization)\b",
    r"\bsql injection\b", r"\bxss\b", r"\bcsrf\b", r"\bsanitiz",
    r"\bproof\b", r"\bprovably\b", r"\bprove that\b", r"\binvariant\b", r"\bformal(?:ly)? (?:correct|verify)",
    r"\blegal(?:ly)?\b", r"\bcontract\b", r"\bliab(?:le|ility)\b", r"\bregulat",
    r"\bmedical\b", r"\bdiagnos", r"\bdosage\b", r"\btax(?:es|ation)?\b",
    r"\bfinanc(?:e|ial)\b", r"\birreversible\b", r"\bproduction outage\b",
    r"\barchitect(?:ure|ing)?\b", r"\bdistributed system", r"\bconsensus\b", r"\bsharding\b",
]

_SONNET_PATTERNS = [
    r"\brefactor\b", r"\bimplement\b", r"\bpaginat", r"\bendpoint\b", r"\bmigrat",
    r"\bsummar(?:ize|y)\b", r"\banalyz", r"\bdebug\b", r"\bwrite tests?\b",
    r"\bunit test", r"\bintegrat(?:e|ion)\b", r"\balgorithm\b", r"\boptimi[sz]e\b",
]

# Multi-step / dense signals that nudge from haiku up to sonnet.
_MULTISTEP_PATTERNS = [
    r"\bstep \d\b", r"\bfirst,.*then\b", r"\band then\b", r"\bafterwards?\b",
]

_OPUS_RES = [re.compile(p, re.I) for p in _OPUS_PATTERNS]
_SONNET_RES = [re.compile(p, re.I) for p in _SONNET_PATTERNS]
_MULTISTEP_RES = [re.compile(p, re.I) for p in _MULTISTEP_PATTERNS]

_CODE_FENCE = re.compile(r"```")


@dataclass
class RouterConfig:
    # Concrete model ids each tier maps to (set from env in app.py).
    models: dict = field(default_factory=lambda: {
        "haiku": "claude-haiku-4-5",
        "sonnet": "claude-sonnet-4-5",
        "opus": "claude-opus-4-6",
    })
    # If True, the router may pick a tier ABOVE what the client requested
    # (full adaptive behavior). If False (default), the requested model is a
    # ceiling — the router only ever downgrades or matches, never spends more
    # than the caller asked for. Safe default: no surprise cost increases.
    allow_upgrade_above_requested: bool = False
    # Text length (chars) above which a request is nudged to at least sonnet.
    long_request_chars: int = 4000
    # Floor tier — never route below this.
    min_tier: str = "haiku"


@dataclass
class Decision:
    # tier is None for a PASSTHROUGH: Cheaper declined to route and the caller's own
    # model is used unchanged. That happens when no configured model is provably
    # cheaper than what was requested, or when the requested model is unrecognized.
    tier: Optional[str]
    model: str
    reason: str


def _content_tier(text: str, cfg: RouterConfig) -> tuple[str, str]:
    """Tier implied by the request content alone (ignoring the requested model)."""
    for rgx in _OPUS_RES:
        if rgx.search(text):
            return "opus", f"auto-escalate category matched: /{rgx.pattern}/"
    hits = [r.pattern for r in _SONNET_RES if r.search(text)]
    if hits:
        return "sonnet", f"moderate task signal: /{hits[0]}/"
    if len(text) >= cfg.long_request_chars:
        return "sonnet", f"long/dense request ({len(text)} chars)"
    if _CODE_FENCE.search(text):
        return "sonnet", "contains code block"
    for rgx in _MULTISTEP_RES:
        if rgx.search(text):
            return "sonnet", "multi-step request"
    return "haiku", "simple/short request"


def extract_text(body: dict) -> str:
    """Pull the routable text out of an Anthropic Messages API request body."""
    parts: list[str] = []
    sys = body.get("system")
    if isinstance(sys, str):
        parts.append(sys)
    elif isinstance(sys, list):
        for b in sys:
            if isinstance(b, dict) and isinstance(b.get("text"), str):
                parts.append(b["text"])
    for msg in body.get("messages", []) or []:
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and isinstance(b.get("text"), str):
                    parts.append(b["text"])
    return "\n".join(parts)


def requested_tier(body: dict, cfg: RouterConfig) -> Optional[str]:
    """Map the client's requested model id/alias back to a tier, if recognizable."""
    m = (body.get("model") or "").lower()
    if not m:
        return None
    if "haiku" in m:
        return "haiku"
    if "sonnet" in m:
        return "sonnet"
    if "opus" in m:
        return "opus"
    # Reverse-map exact configured ids.
    for tier, mid in cfg.models.items():
        if m == str(mid).lower():
            return tier
    return None


def decide(body: dict, cfg: RouterConfig, triage_tier: Optional[str] = None,
           models: Optional[dict] = None) -> Decision:
    """Choose the tier for this request and resolve it to a concrete model id.

    triage_tier: optional override from a live cheap-model triage pass (app.py may
    supply it in "triage" mode); when given it replaces the heuristic content tier.
    models: tier -> model-id map to resolve against (defaults to cfg.models). Pass a
    provider-specific map (e.g. OpenAI model ids) when routing a non-Anthropic client.
    """
    model_map = models or cfg.models
    text = extract_text(body)
    if triage_tier in TIERS:
        tier, reason = triage_tier, "cheap-model triage verdict"
    else:
        tier, reason = _content_tier(text, cfg)

    # Apply the requested-model ceiling unless upgrades are explicitly allowed.
    req = requested_tier(body, cfg)
    if req is not None and not cfg.allow_upgrade_above_requested:
        if _rank(tier) > _rank(req):
            reason = f"{reason}; capped to requested '{req}' (upgrades disabled)"
            tier = req

    # Enforce the floor.
    if _rank(tier) < _rank(cfg.min_tier):
        tier = cfg.min_tier
        reason = f"{reason}; raised to min_tier '{cfg.min_tier}'"

    # --- The DOLLAR ceiling ---------------------------------------------------
    # The tier cap above only fires when requested_tier() recognized the caller's
    # model. It returns None for anything without a haiku/sonnet/opus substring that
    # is not an exact configured id -- so a request naming `gpt-4o-mini` with
    # security-flavoured text got NO ceiling at all and was escalated to the opus
    # model, directly violating allow_upgrade_above_requested=False and INCREASING
    # the caller's cost. The invariant was always about money; tier rank was only
    # ever standing in for it, and it stands in badly now that capability rank and
    # price rank disagree across the catalog.
    req_cost = _unit_cost(body.get("model"))
    if req_cost is not None and not cfg.allow_upgrade_above_requested:
        cand_cost = _unit_cost(model_map.get(tier))
        if cand_cost is not None and cand_cost > req_cost:
            # Walk DOWN the tiers until one is genuinely no more expensive.
            for t in TIERS[:_rank(tier)][::-1]:
                c = _unit_cost(model_map.get(t))
                if c is not None and c <= req_cost:
                    reason = f"{reason}; dollar ceiling: {model_map[t]} costs <= requested"
                    tier = t
                    break
            else:
                # Nothing configured is cheaper. Passing through is the honest move:
                # routing here would raise the bill while claiming to lower it.
                return Decision(tier=None, model=(body.get("model") or ""),
                                reason=f"{reason}; no configured model is cheaper "
                                       f"than requested -- passthrough")

    return Decision(tier=tier, model=model_map[tier], reason=reason)
