"""Pure-Python routing core for the model-router gateway.

No network or framework imports live here so the routing decision is fully
unit-testable. `decide()` looks at the request text and returns which tier a
request should run on, plus a short reason. `app.py` forwards the request upstream.

Design mirrors the adaptive-model-router skill, with two corrections that an
empirical replay over ~47,000 real calls forced (see the block comments below):

- Cheapest tier by default.
- Auto-escalate categories (concurrency, security, proofs, ...) are a DOWNGRADE VETO,
  not an upgrade trigger. Under the shipped default (`allow_upgrade_above_requested
  = False`) the router never spends more than the caller asked for; what the hard
  categories buy you is that the router will not cut a correctness-critical request
  down to a cheap model to satisfy a money invariant. See `allow_upgrade_above_requested`
  and the quality-floor block in `decide()`.
- A "needs more info on a correctness-critical task" case is treated as hard, not simple.

WHAT THE ROUTER DOES NOT DO -- measured, not assumed. Replaying this classifier over
the author's own transcripts (817 human turns, difficulty proxied by the total output
tokens the turn really consumed) gives an AUC of 0.517: the tier cascade is a coin flip
at predicting how hard a request is, and the shipped sonnet band was actively INVERTED
(median work 37k for sonnet-routed turns vs 59k for haiku-routed ones). Twenty
alternative pattern designs were measured; the best scored 0.551. So the honest claim
is: this classifier picks up unambiguous risk vocabulary, and it is NOT a difficulty
oracle. Real difficulty prediction needs the live triage pass (`ROUTER_MODE=triage`),
which asks a cheap model instead of a regex. Do not add patterns here expecting the
ranking to improve -- that was tried and measured, and it does not.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

# Real-dollar pricing, so the requested-model ceiling can be enforced in money rather
# than in capability rank. Guarded: the router still works without it, minus the
# dollar ceiling. `representative_for` is the catalog's own tier -> model id answer;
# see `_catalog_models`.
#
# THE IMPORT LIST GREW BY TWO, DELIBERATELY. It used to say "keep these the ONLY things
# router.py imports from pricing", and that restraint is what kept `requested_tier()`
# guessing a tier from a substring while the answer sat one import away:
#   * `model_tier`    the catalog's own capability tier for an id. pricing.py's docstring
#                     already describes it as the step-for-step port of
#                     classify.js::modelTier -- so the ceiling and `peek`'s estimate of
#                     the ceiling are now literally the same function, twice.
#   * `detect_family` which vendor an id belongs to, for the vendor guard in `decide()`.
# Both are pure, catalog-backed and side-effect free. What must still NOT be imported is
# anything that prices a specific CALL: this module ranks models on a fixed basket and
# has no business knowing a request's token counts.
try:
    from pricing import (  # type: ignore
        cost_of_model, representative_for, model_tier, detect_family,
    )
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


# --- Tier -> concrete model id ----------------------------------------------
# RESOLVED FROM THE CATALOG, never hardcoded. Hardcoding produced a live quality
# collapse: the sonnet tier was pinned to `claude-sonnet-4-5` ($3/$15 = $18 on the
# ranking basket) while `claude-sonnet-5` ships a launch promo at $2/$10 = $12. So for
# every request naming `claude-sonnet-5`, the dollar ceiling below found cand_cost $18 >
# req_cost $12, walked DOWN, and served `claude-haiku-4-5` ($6) -- for 100% of that
# caller's traffic, INCLUDING requests this file's own classifier had just called
# auto-escalate.
#
# Two independent things had to change, and BOTH are load-bearing:
#   1. these ids come from the same catalog the CLI prices with, so the tier's model and
#      a caller naming that same model are quoted from ONE price sheet and therefore
#      move together across a promotional boundary. That is what makes the fix
#      date-independent: on 2026-08-31 both sides read $12, on 2026-09-01 both read $18,
#      and the comparison is `<=` either way. A fix that merely swapped in today's
#      cheaper id would silently re-break when the promo lapsed.
#   2. the quality floor in `decide()`, so that even a mis-set ROUTER_MODEL_SONNET
#      cannot resurrect the collapse -- it produces a passthrough instead.
#
# The stale opus id (`claude-opus-4-6`) was COST-NEUTRAL, not part of the collapse:
# it and `claude-opus-5` both price $5/$25. It is fixed here for staleness only.
_FALLBACK_MODELS = {
    "haiku": "claude-haiku-4-5",
    "sonnet": "claude-sonnet-5",
    "opus": "claude-opus-5",
}


def _catalog_models() -> dict:
    """tier -> model id, from the price catalog; literals only if pricing is missing.

    Re-read on every RouterConfig() construction rather than snapshotted at import, so
    a catalog refresh (`node cli/scripts/sync-prices.js`) reaches the router without a
    code change. When pricing is unavailable the dollar ceiling is disabled too, so the
    fallback literals cannot participate in a price comparison at all.
    """
    out = dict(_FALLBACK_MODELS)
    if not _PRICING:
        return out
    for tier in TIERS:
        try:
            mid = representative_for("anthropic", tier)
        except Exception:
            mid = None
        if mid:
            out[tier] = mid
    return out


# --- Category signals -------------------------------------------------------
# Word-boundary regexes so "auth" doesn't fire on "author", etc.
#
# FIRST-MATCH-WINS IS GONE, and tightening the patterns is NOT the fix. Measured on the
# author's real traffic: dropping the four most-suspected patterns
# (contract/lock/financial/architecture) recovered 1.28% of spend, because
# `_content_tier` returned on the FIRST match and escalated traffic matched several
# patterns at once -- the false positives were mutually REDUNDANT, which made every
# individual pattern look free to keep and the whole set impossible to tune. Reaching
# 31.6% needed 17 of 39 patterns deleted.
#
# So the patterns are split by how much weight one match can carry:
#
#   STRONG -- multiword or unambiguous technical terms. One match is enough. These are
#   the terms whose incidental rate is near zero: nobody writes "SQL injection" or "ABA
#   problem" in passing.
#
#   WEAK -- bare domain words with measured incidental rates of 80-96% (proof 96.0%,
#   thread 89.4%, diagnos 86.8%, security 80.2%). One match means almost nothing. They
#   escalate only with corroboration: either K independent DOMAINS fire, or the word
#   appears within `cooccurrence_window` characters of a risk cue (the "domain noun +
#   risk verb" shape). A bare word on its own no longer escalates anything.
#
# Grouping is by domain so that "thread" + "lock" (both concurrency) counts ONCE, not
# twice -- corroboration has to be independent to mean anything.
_STRONG_PATTERNS = [
    # concurrency
    r"\brace condition\b", r"\bdeadlock\b", r"\bmutex\b", r"\bsemaphore\b",
    r"\baba problem\b", r"\block[- ]free\b", r"\bmemory[- ]order",
    # security
    r"\bsql injection\b", r"\bxss\b", r"\bcsrf\b", r"\bvulnerab", r"\bexploit\b",
    r"\bsanitiz",
    # verification
    r"\bprove that\b", r"\bprovably\b", r"\bformal(?:ly)? (?:correct|verif)",
    # irreversible / high-stakes
    r"\bproduction outage\b", r"\birreversible\b", r"\bdistributed system",
    r"\bdosage\b",
]

_WEAK_GROUPS = {
    "concurrency": [r"\bconcurren(?:t|cy)\b", r"\bthread(?:s|ing|-safe)?\b",
                    r"\block(?:s|ing)?\b", r"\batomic(?:s|ity)?\b"],
    "security": [r"\bsecurity\b", r"\bcrypto(?:graph)?",
                 r"\bauth(?:entication|orization)\b"],
    "verification": [r"\bproof\b", r"\binvariant\b"],
    "legal": [r"\blegal(?:ly)?\b", r"\bcontract\b", r"\bliab(?:le|ility)\b", r"\bregulat"],
    "money": [r"\bfinanc(?:e|ial)\b", r"\btax(?:es|ation)?\b"],
    "medical": [r"\bmedical\b", r"\bdiagnos"],
    "architecture": [r"\barchitect(?:ure|ing)?\b", r"\bconsensus\b", r"\bsharding\b"],
}

# The "risk verb" half of the co-occurrence rule: what someone is DOING to the domain
# noun that makes being wrong expensive.
_RISK_CUE_PATTERN = (
    r"\b(?:audit|review|safe|unsafe|secure|insecure|correct|incorrect|verify|"
    r"guarantee|ensure|prevent|harden|threat|attack|breach|corrupt|leak|bypass|"
    r"race|fail|break|bug|risk|violat|compliance|exploit|inject|escalat|privileg)\w*"
)

_SONNET_PATTERNS = [
    r"\brefactor\b", r"\bimplement\b", r"\bpaginat", r"\bendpoint\b", r"\bmigrat",
    r"\bsummar(?:ize|y)\b", r"\banalyz", r"\bdebug\b", r"\bwrite tests?\b",
    r"\bunit test", r"\bintegrat(?:e|ion)\b", r"\balgorithm\b", r"\boptimi[sz]e\b",
]

# Multi-step / dense signals that nudge from haiku up to sonnet.
_MULTISTEP_PATTERNS = [
    r"\bstep \d\b", r"\bfirst,.*then\b", r"\band then\b", r"\bafterwards?\b",
]

_STRONG_RES = [re.compile(p, re.I) for p in _STRONG_PATTERNS]
_WEAK_RES = {g: [re.compile(p, re.I) for p in ps] for g, ps in _WEAK_GROUPS.items()}
_RISK_CUE_RE = re.compile(_RISK_CUE_PATTERN, re.I)
_SONNET_RES = [re.compile(p, re.I) for p in _SONNET_PATTERNS]
_MULTISTEP_RES = [re.compile(p, re.I) for p in _MULTISTEP_PATTERNS]

_CODE_FENCE = re.compile(r"```")


@dataclass
class RouterConfig:
    # Concrete model ids each tier maps to. Defaults resolve from the price catalog
    # (see `_catalog_models`); app.py lets ROUTER_MODEL_* override them.
    models: dict = field(default_factory=_catalog_models)
    # If True, the router may pick a tier ABOVE what the client requested
    # (full adaptive behavior). If False (default), the requested model is a
    # ceiling — the router only ever downgrades or matches, never spends more
    # than the caller asked for. Safe default: no surprise cost increases.
    #
    # THE DEFAULT STAYS FALSE, AND THAT IS A POSITION, NOT AN OVERSIGHT.
    # Under it, every one of the auto-escalate patterns is dead AS AN ESCALATION for a
    # caller who did not already ask for the top tier: 0 upgrades are reachable. The
    # product used to advertise auto-escalation it could not perform. Two honest
    # resolutions existed and this file takes the first:
    #
    #   (a) keep the default and stop advertising escalation. Spending a caller's money
    #       above what they asked for is exactly the harm this flag exists to prevent,
    #       and the classifier that would trigger the spend is a measured coin flip
    #       (AUC 0.517) -- escalating on it is close to escalating at random, so it
    #       would raise the bill without buying reliability. What the hard categories
    #       DO earn under this default is the quality floor in `decide()`: they veto a
    #       downgrade. That is fully inside the caller's consent, because the caller
    #       already agreed to pay for the model they named.
    #   (b) allow escalation inside an explicit dollar cap. Rejected: a cap is a second
    #       knob that still spends money the caller did not agree to, and it would be
    #       driven by the same coin-flip classifier.
    #
    # Operators who genuinely want full adaptive behaviour set this True (ROUTER_ALLOW_UPGRADE),
    # which is an explicit, informed opt-in. Nothing here advertises it as the default.
    allow_upgrade_above_requested: bool = False
    # Text length (chars) above which a request is nudged to at least sonnet.
    long_request_chars: int = 4000
    # Floor tier — never route below this.
    min_tier: str = "haiku"
    # --- tuning knobs for the scored classifier (see _content_tier) ------------
    # How many INDEPENDENT weak domains must fire before they escalate together.
    min_hard_domains: int = 2
    # How many independent moderate signals before the sonnet band fires. The shipped
    # value was effectively 1 (any single match), and that band measured ANTI-predictive
    # -- sonnet-routed turns did LESS work than haiku-routed ones. At 2 the ordering
    # comes back the right way up (measured: sonnet median work 90k vs haiku 54k).
    min_moderate_signals: int = 2
    # Character window for the "domain noun + risk verb" co-occurrence rule.
    cooccurrence_window: int = 120


@dataclass
class Decision:
    # tier is None for a PASSTHROUGH: Cheaper declined to route and the caller's own
    # model is used unchanged. That happens when no configured model is provably
    # cheaper than what was requested, when the requested model is unrecognized, or
    # when the only way to get under the caller's price was to breach the quality floor.
    tier: Optional[str]
    model: str
    reason: str


def _risk_cue_near(text: str, rgx, window: int) -> bool:
    """True when a risk cue sits within `window` chars of a match of `rgx`.

    The matched term itself is excluded from the scan (the two flanks are searched
    separately), so a domain word can never corroborate itself.
    """
    for m in rgx.finditer(text):
        lo = max(0, m.start() - window)
        hi = min(len(text), m.end() + window)
        if _RISK_CUE_RE.search(text[lo:m.start()]) or _RISK_CUE_RE.search(text[m.end():hi]):
            return True
    return False


def _hard_signals(text: str, cfg: RouterConfig) -> list[str]:
    """EVERY auto-escalate signal in the text, not the first one.

    Collecting all of them is what makes the pattern set tunable at all: under
    first-match-wins the function returned as soon as anything matched, so a redundant
    false positive was invisible in any measurement and deleting it changed nothing.
    """
    sigs: list[str] = []
    for rgx in _STRONG_RES:
        if rgx.search(text):
            sigs.append(f"unambiguous risk term /{rgx.pattern}/")

    # One hit per DOMAIN: two words from the same domain are one signal, not two.
    domains: list[tuple[str, "re.Pattern[str]"]] = []
    for group, rs in _WEAK_RES.items():
        for r in rs:
            if r.search(text):
                domains.append((group, r))
                break

    if len(domains) >= cfg.min_hard_domains:
        sigs.append("independent risk domains: " + "+".join(g for g, _ in domains))
    else:
        # Too few domains to corroborate each other, so fall back to the other form of
        # corroboration: the domain noun has to be near a risk verb.
        for group, r in domains:
            if _risk_cue_near(text, r, cfg.cooccurrence_window):
                sigs.append(f"{group} term /{r.pattern}/ next to a risk cue")
    return sigs


def _moderate_signals(text: str, cfg: RouterConfig) -> list[str]:
    """Every mid-tier signal in the text. Same all-signals rule as `_hard_signals`."""
    sigs = [f"/{r.pattern}/" for r in _SONNET_RES if r.search(text)]
    if len(text) >= cfg.long_request_chars:
        sigs.append(f"long/dense request ({len(text)} chars)")
    if _CODE_FENCE.search(text):
        sigs.append("contains code block")
    if any(r.search(text) for r in _MULTISTEP_RES):
        sigs.append("multi-step request")
    return sigs


def _content_tier(text: str, cfg: RouterConfig) -> tuple[str, str, bool]:
    """Tier implied by the request content alone (ignoring the requested model).

    Returns (tier, reason, hard). `hard` marks an auto-escalate classification and is
    what arms the quality floor in `decide()`; it is deliberately NOT the same thing as
    "tier == opus", because the requested-model ceiling can cap an auto-escalate request
    down to a lower tier while the floor still has to stop the dollar ceiling cutting
    further.
    """
    hard = _hard_signals(text, cfg)
    if hard:
        return "opus", "auto-escalate: " + "; ".join(hard[:3]), True
    mod = _moderate_signals(text, cfg)
    if len(mod) >= cfg.min_moderate_signals:
        return "sonnet", "moderate task signals: " + "; ".join(mod[:3]), False
    return "haiku", "simple/short request", False


def extract_text(body: dict) -> str:
    """ALL text in an Anthropic Messages API body: system prompt + every message.

    NOT FOR ROUTING -- use `routable_text()`. This is the whole-conversation accessor,
    kept because it is the honest answer to "what text is in this body". Routing on it
    is what produced the ratchet documented on `routable_text`; there are currently no
    routing callers left.
    """
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
        parts.extend(_block_text(msg.get("content")))
    return "\n".join(parts)


def _block_text(content) -> list[str]:
    """Top-level text of one message's content. Shared by both extractors."""
    if isinstance(content, str):
        return [content]
    out: list[str] = []
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and isinstance(b.get("text"), str):
                out.append(b["text"])
    return out


def _is_tool_echo(msg: dict) -> bool:
    """True when a user message is purely the transport for tool results.

    In the Anthropic Messages API a tool result comes back as a *user* message whose
    content is `tool_result` blocks. That is the agent loop's plumbing, not a new human
    request, so it is not a turn boundary. A message that mixes a tool_result with real
    text IS a turn (the human interjected mid-loop), and an empty content list is
    skipped rather than treated as a boundary.
    """
    c = msg.get("content")
    if not isinstance(c, list):
        return False
    if not c:
        return True
    return all(isinstance(b, dict) and b.get("type") == "tool_result" for b in c)


def routable_text(body: dict) -> str:
    """The text the routing decision is allowed to see: the CURRENT user turn.

    THE RATCHET THIS REPLACES. `decide()` used to route on `extract_text(body)`, which
    joins the system prompt and EVERY message in the conversation, and every rule in
    `_content_tier` is a positive-match escalation with no decay. The tier was therefore
    monotonically non-decreasing in conversation length: one matching word anywhere in
    history pinned every later turn to the most expensive tier forever. Measured over
    ~47,000 real calls, 89.9% of them routed opus and the router saved 2.03%; scoping
    the text to the current turn took the same traffic to 28.7% saved, and that was
    before any other change in this file.

    TWO RULES, both load-bearing:

    1. THE SYSTEM PROMPT IS NEVER ROUTABLE. A client's system prompt is static, so any
       word in it applies to 100% of that client's traffic. Letting it reach the
       classifier means one unlucky sentence in a harness preamble pins every request
       that client will ever make. There is no version of that which is correct.

    2. THE UNIT IS THE LATEST HUMAN USER TURN. In a tool-use loop the last message is a
       `tool_result`, not a user request, so "the last message" is the wrong unit --
       it would classify plumbing. Scanning back to the last non-echo user message
       gives the human's actual request, and it does so IDEMPOTENTLY: every hop of the
       same agentic turn recomputes the identical window and therefore the identical
       tier. That is how a stateless gateway "decides once per user turn" without
       holding per-turn state, and it also stops the model from swapping mid-tool-loop.

       The trailing assistant/tool messages of the in-flight turn are deliberately
       EXCLUDED. Block extraction only reads top-level `text` blocks, so tool_result
       payloads were never visible anyway; what "everything after the user turn" would
       actually add is the ASSISTANT's own prose -- model-generated text feeding back
       into the router. That is the ratchet again at turn scale: one chatty sentence
       from a cheap model would pin the remaining hops of a 100-hop turn to the top
       tier. Measured, including it re-escalated 66.2% of calls to opus versus the
       human turn alone.

    Falls back to the last message of any kind when a body carries no human turn (an
    assistant-prefill or an all-echo body), and to "" for an empty body -- which
    classifies as haiku, the cheap default.
    """
    msgs = body.get("messages")
    if not isinstance(msgs, list):
        return ""
    idx = None
    for i in range(len(msgs) - 1, -1, -1):
        m = msgs[i]
        if isinstance(m, dict) and m.get("role") == "user" and not _is_tool_echo(m):
            idx = i
            break
    if idx is None:
        for i in range(len(msgs) - 1, -1, -1):
            if isinstance(msgs[i], dict):
                idx = i
                break
    if idx is None:
        return ""
    return "\n".join(_block_text(msgs[idx].get("content")))


def requested_tier(body: dict, cfg: RouterConfig) -> Optional[str]:
    """Map the client's requested model id/alias back to a tier, if recognizable.

    THE CATALOG ANSWERS THIS, NOT A SUBSTRING. This function used to recognise a model
    only when its id CONTAINED 'haiku' / 'sonnet' / 'opus', or exactly equalled one of the
    configured ids. MEASURED over the 89 ids `cli/scripts/check-policy-parity.js` drives,
    that returned None for 62 of them (69.7%) -- every OpenAI, Google, Mistral, xAI and
    DeepSeek model in the catalog, plus claude-fable-5 / claude-mythos-5 / claude-mythos.

    None here is not a harmless "don't know": it means NO REQUESTED-MODEL CEILING IS
    APPLIED, and the ceiling is the entire content of `allow_upgrade_above_requested =
    False`. The invariant therefore did not hold for those 62 ids, and the dollar ceiling
    could not cover for it whenever the requested model is also unpriceable, because an
    unpriceable model yields no ceiling either. Both holes open together, on exactly the
    ids most likely to be a model newer than the catalog. Measured example, before this
    change: `{"model": "claude-tiny-9"}` asking a deadlock question was served
    `claude-opus-5` -- an UPGRADE, with upgrades disabled, for a caller whose model name
    literally says "tiny".

    So the order is now:
      1. `pricing.model_tier()` -- catalog first, then unambiguous name signals, then
         fail closed. It is the same function `classify.js::modelTier` is a port of, so
         the ceiling the gateway applies and the ceiling `peek` estimates cannot drift.
      2. the operator's own tier -> id map. An id an operator has DECLARED to be their
         sonnet tier is sonnet even when the catalog has never heard of it; that
         declaration outranks anything recoverable from the name. Kept from the previous
         implementation, and it is why this takes `cfg` rather than being a thin alias.
      3. None. Fail CLOSED -- "we hold no capability claim for this id".

    The old substring test survives ONLY as the no-pricing fallback. When `pricing` fails
    to import, the dollar ceiling is disabled too (see `_unit_cost`), so dropping the
    substring test as well would leave a request with NO ceiling of any kind; a degraded
    Anthropic-only ceiling is strictly better than none. That branch is unreachable in
    every shipped configuration and both parity gates run with pricing present, so it
    cannot mask a divergence.
    """
    raw = body.get("model") or ""
    m = str(raw).lower()
    if not m:
        return None
    if _PRICING:
        tier = model_tier(raw)
        if tier:
            return tier
    else:  # pragma: no cover - only when pricing failed to import
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


def _map_family(model_map: dict) -> Optional[str]:
    """The single vendor a tier -> id map serves, or None when it does not have one.

    None covers two distinct cases and both must fall through to "no vendor claim": a map
    naming a model no family pattern recognises, and a map an operator has deliberately
    MIXED across vendors (an explicit opt-in to cross-vendor serving, and therefore not
    something to refuse on their behalf).
    """
    if not _PRICING:
        return None
    fam = None
    for tier in TIERS:
        f = detect_family(model_map.get(tier))
        if not f:
            return None
        if fam is None:
            fam = f
        elif fam != f:
            return None
    return fam


def decide(body: dict, cfg: RouterConfig, triage_tier: Optional[str] = None,
           models: Optional[dict] = None) -> Decision:
    """Choose the tier for this request and resolve it to a concrete model id.

    triage_tier: optional override from a live cheap-model triage pass (app.py may
    supply it in "triage" mode); when given it replaces the heuristic content tier.
    models: tier -> model-id map to resolve against (defaults to cfg.models). Pass a
    provider-specific map (e.g. OpenAI model ids) when routing a non-Anthropic client.
    NOTE that this map also decides WHICH VENDOR this call may be answered by: a request
    naming a model from a different vendor than the map serves is passed through
    untouched rather than substituted. See the vendor guard below.
    """
    model_map = models or cfg.models

    # An unknown min_tier is CLAMPED, not fatal. `_rank()` raises ValueError on a tier
    # name it does not know, and `cfg.min_tier` comes straight from the ROUTER_MIN_TIER
    # environment variable with no validation (app.py) -- so a typo turned every single
    # request into a 500 from inside the routing core, with the traceback pointing at
    # TIERS.index rather than at the operator's config. Clamping to the cheap default is
    # the survivable reading and it is what classify.js already did, so this also closes
    # a cross-runtime divergence: peek estimated a working router while the gateway was
    # returning errors.
    min_tier = cfg.min_tier if cfg.min_tier in TIERS else TIERS[0]

    # --- THE VENDOR GUARD -----------------------------------------------------
    # Cheaper routes DOWN within one vendor's lineup. It does not answer a request that
    # named vendor X with vendor Y's model.
    #
    # WHY THIS IS A CORRECTNESS RULE AND NOT A PRICING ONE. Every other rule below trades
    # dollars against capability, and the caller consented to that trade by pointing their
    # base URL at this gateway. Swapping the VENDOR is a different thing: the caller
    # receives a model from a company they did not name, with different training,
    # different tool-use semantics, a different context window and a different data
    # agreement. No amount of saving makes that the request they sent.
    #
    # WHAT IT ACTUALLY DID, on the wire, before this guard existed:
    #   * app.py's /v1/messages resolves against the ANTHROPIC map for every caller,
    #     rewrites body["model"], and forwards to api.anthropic.com. A client sending
    #     `grok-4.3` was answered by `claude-haiku-4-5` -- and the call SUCCEEDED, where
    #     an untouched passthrough would have been rejected upstream as an unknown model.
    #     A silent success is the worst possible signal: nothing in the response tells a
    #     benchmark harness it just measured Claude instead of Grok.
    #   * /v1/chat/completions is the mirror image and was worse, because the OLD
    #     `requested_tier()` recognised the substring: `claude-opus-5` mapped to tier
    #     'opus' and was served OPENAI_MODELS['opus'] against api.openai.com.
    #
    # The CLI already refused to do this on the estimate side -- cli/src/peek/pricing.js
    # picks ROUTE_TARGET_BY_TIER[family] for the row's own family, its header says "never
    # to a different vendor", and `estimateCall never routes across vendors` is a test.
    # So the two runtimes disagreed about whether the product substitutes vendors at all.
    # It does not, now, on either side.
    #
    # The guard is deliberately narrow: it fires only when BOTH families are known and
    # they differ. An unrecognised model id, or an operator's deliberately mixed map,
    # yields no vendor claim and falls through unchanged. It is also NOT disabled by
    # allow_upgrade_above_requested -- an operator who opted into paying more did not
    # thereby opt into being answered by a different company's model.
    req_family = detect_family(body.get("model")) if _PRICING else None
    served_family = _map_family(model_map)
    if req_family and served_family and req_family != served_family:
        return Decision(
            tier=None, model=(body.get("model") or ""),
            reason=f"requested model is a '{req_family}' model and this route map serves "
                   f"'{served_family}' -- cross-vendor substitution refused, passthrough")

    text = routable_text(body)
    if triage_tier in TIERS:
        tier, reason = triage_tier, "cheap-model triage verdict"
        # A live model saying "opus" means the same thing the hard patterns mean, and
        # it is strictly better evidence than a regex, so it arms the same floor.
        hard = triage_tier == "opus"
    else:
        tier, reason, hard = _content_tier(text, cfg)

    # --- The QUALITY floor ----------------------------------------------------
    # The tier below which this request must not be served, no matter what the money
    # says. Only an auto-escalate classification raises it above min_tier: for
    # everything else a downgrade is the entire point of the product.
    floor = tier if hard else min_tier

    # Apply the requested-model ceiling unless upgrades are explicitly allowed.
    req = requested_tier(body, cfg)
    if req is not None and not cfg.allow_upgrade_above_requested:
        if _rank(tier) > _rank(req):
            reason = f"{reason}; capped to requested '{req}' (upgrades disabled)"
            tier = req
        # NOTE: the floor is deliberately NOT lowered to `req` here, and it does not need
        # to be. A caller who explicitly names a cheap model has CONSENTED to that
        # model's quality, and the cap above already delivers that consent by moving
        # `tier`. Lowering the floor as well would be a no-op: the walk-down below only
        # runs while rank(floor) < rank(tier), and after a cap rank(tier) <= rank(req) <
        # rank(floor), so the slice is empty either way and the outcome is a passthrough.
        # (Checked exhaustively over all reachable content/requested/min_tier/hard
        # states: 0 of 72 differ.) An earlier draft did lower it; that line survived
        # mutation testing untouched, which is what exposed it as dead. Pinned by
        # test_a_cheap_requested_model_with_hard_content_passes_through.

    # Enforce the floor.
    if _rank(tier) < _rank(min_tier):
        tier = min_tier
        reason = f"{reason}; raised to min_tier '{min_tier}'"
    if _rank(floor) < _rank(min_tier):
        floor = min_tier

    # --- The DOLLAR ceiling ---------------------------------------------------
    # The tier cap above only fires when requested_tier() recognized the caller's
    # model. It USED TO return None for anything without a haiku/sonnet/opus substring
    # that was not an exact configured id -- so a request naming `gpt-4o-mini` with
    # security-flavoured text got NO ceiling at all and was escalated to the opus
    # model, directly violating allow_upgrade_above_requested=False and INCREASING
    # the caller's cost. The invariant was always about money; tier rank was only
    # ever standing in for it, and it stands in badly now that capability rank and
    # price rank disagree across the catalog.
    #
    # requested_tier() now consults the catalog, so the tier cap covers 62 more ids and
    # this ceiling is no longer the only thing standing between an unrecognised id and an
    # upgrade. THAT IS NOT A REASON TO WEAKEN IT. The two ceilings fail on DIFFERENT ids:
    # the tier cap fails on a model the catalog and the name signals both miss, and the
    # dollar ceiling fails on a model with no published price. `claude-tiny-9` is the
    # first (before this change) and `llama-4-maverick` is the second, and only having
    # both means a request has to defeat two independent checks to get an upgrade nobody
    # asked for.
    #
    # THE WALK-DOWN STOPS AT THE QUALITY FLOOR. It used to walk all the way to haiku,
    # which is how a caller on `claude-sonnet-5` got served haiku for 100% of their
    # traffic including their security and concurrency questions. Buying a money
    # invariant with a quality breach is the one trade this product must never make: a
    # confidently wrong answer on a security or concurrency request costs more than any
    # routing saves. When the floor blocks every cheaper tier, PASSTHROUGH is the
    # honest outcome -- the caller keeps their own model, and Cheaper claims nothing.
    req_cost = _unit_cost(body.get("model"))
    if req_cost is not None and not cfg.allow_upgrade_above_requested:
        cand_cost = _unit_cost(model_map.get(tier))
        if cand_cost is not None and cand_cost > req_cost:
            # Walk DOWN the tiers until one is genuinely no more expensive, never
            # below `floor`. (When floor == tier this slice is empty by construction.)
            for t in TIERS[_rank(floor):_rank(tier)][::-1]:
                c = _unit_cost(model_map.get(t))
                if c is not None and c <= req_cost:
                    reason = f"{reason}; dollar ceiling: {model_map[t]} costs <= requested"
                    tier = t
                    break
            else:
                # Nothing configured is both cheaper AND at or above the quality floor.
                # Passing through is the honest move: routing here would either raise
                # the bill while claiming to lower it, or lower it by answering a
                # correctness-critical request on a model we just said was too weak.
                return Decision(tier=None, model=(body.get("model") or ""),
                                reason=f"{reason}; no configured model is both cheaper "
                                       f"than requested and at/above the '{floor}' "
                                       f"quality floor -- passthrough")

    return Decision(tier=tier, model=model_map[tier], reason=reason)
