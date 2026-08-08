"""Deterministic tests for the routing core. No network required: run `pytest`."""

import re
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import pytest  # noqa: E402

import pricing  # noqa: E402
import router as R  # noqa: E402
from router import (  # noqa: E402
    RouterConfig, decide, extract_text, requested_tier, routable_text,
)


def body(text, model="claude-opus-4-6", system=None):
    b = {"model": model, "messages": [{"role": "user", "content": text}]}
    if system is not None:
        b["system"] = system
    return b


# --- content classification -------------------------------------------------

def test_simple_request_routes_haiku():
    cfg = RouterConfig()
    d = decide(body("Rephrase this sentence to sound more formal."), cfg)
    assert d.tier == "haiku"
    assert d.model == cfg.models["haiku"]


def test_moderate_request_routes_sonnet():
    cfg = RouterConfig()
    d = decide(body("Refactor this module and add unit tests for the endpoint."), cfg)
    assert d.tier == "sonnet"


def test_concurrency_autoescalates_opus():
    cfg = RouterConfig()
    d = decide(body("Diagnose this deadlock between two locks and prove the fix is correct."), cfg)
    assert d.tier == "opus"
    assert "auto-escalate" in d.reason


def test_security_autoescalates_opus():
    cfg = RouterConfig()
    d = decide(body("Is this endpoint vulnerable to SQL injection?"), cfg)
    assert d.tier == "opus"


def test_proof_autoescalates_opus():
    cfg = RouterConfig()
    d = decide(body("Prove that this lock-free queue is free of the ABA problem."), cfg)
    assert d.tier == "opus"


def test_long_request_nudges_sonnet():
    cfg = RouterConfig()
    d = decide(body("summarize this. " + "x " * 3000), cfg)  # long, no hard category
    assert d.tier in ("sonnet", "opus")  # at least escalated off haiku


# --- requested-model ceiling ------------------------------------------------

def test_ceiling_downgrades_simple_even_if_opus_requested():
    cfg = RouterConfig()  # allow_upgrade_above_requested=False
    d = decide(body("What's 2+2?", model="claude-opus-4-6"), cfg)
    assert d.tier == "haiku"  # cost saver: never spends more than needed


def test_ceiling_blocks_upgrade_when_haiku_requested():
    cfg = RouterConfig()  # upgrades disabled
    d = decide(body("Diagnose this deadlock and prove the fix.", model="claude-haiku-4-5"), cfg)
    assert d.tier == "haiku"  # capped to requested; never exceeds caller's ask
    assert "capped" in d.reason


def test_upgrade_allowed_when_configured():
    cfg = RouterConfig(allow_upgrade_above_requested=True)
    d = decide(body("Diagnose this deadlock and prove the fix.", model="claude-haiku-4-5"), cfg)
    assert d.tier == "opus"  # full adaptive: content wins over requested


def test_min_tier_floor():
    cfg = RouterConfig(min_tier="sonnet")
    d = decide(body("hi", model="claude-sonnet-4-5"), cfg)
    assert d.tier == "sonnet"


# --- triage override --------------------------------------------------------

def test_triage_tier_overrides_heuristic():
    cfg = RouterConfig(allow_upgrade_above_requested=True)
    d = decide(body("looks simple"), cfg, triage_tier="opus")
    assert d.tier == "opus"
    assert "triage" in d.reason


# --- helpers ----------------------------------------------------------------

def test_extract_text_reads_system_and_messages():
    b = body("hello", system="you are helpful")
    t = extract_text(b)
    assert "helpful" in t and "hello" in t


def test_requested_tier_maps_aliases_and_ids():
    cfg = RouterConfig()
    assert requested_tier({"model": "claude-3-5-haiku"}, cfg) == "haiku"
    assert requested_tier({"model": cfg.models["opus"]}, cfg) == "opus"
    assert requested_tier({"model": "some-unknown"}, cfg) is None


def test_requested_tier_asks_the_catalog_not_a_substring():
    """THE CEILING DID NOT EXIST FOR MOST MODEL IDS.

    `requested_tier()` used to recognise a model only when its id CONTAINED
    'haiku'/'sonnet'/'opus' or exactly equalled a configured id. Measured over the 89 ids
    cli/scripts/check-policy-parity.js drives, that returned None for 62 of them -- every
    OpenAI, Google, Mistral, xAI and DeepSeek model plus claude-fable-5 / -mythos-5 /
    -mythos. None is not a harmless "don't know": it means NO requested-model ceiling is
    applied, and the ceiling is the entire content of allow_upgrade_above_requested=False.

    Each id below returned None before the catalog lookup was added, and each carries a
    different reason it must not:
    """
    cfg = RouterConfig()
    # ...catalogued, no tier word anywhere in the id.
    assert requested_tier({"model": "gpt-4o"}, cfg) == "sonnet"
    assert requested_tier({"model": "grok-4.3"}, cfg) == "sonnet"
    assert requested_tier({"model": "gemini-2.5-flash-lite"}, cfg) == "haiku"
    assert requested_tier({"model": "mistral-large-3"}, cfg) == "opus"
    # ...catalogued ANTHROPIC models the substring test also missed. These are the ones
    # that make "it only mattered for other vendors" false.
    assert requested_tier({"model": "claude-fable-5"}, cfg) == "opus"
    assert requested_tier({"model": "claude-mythos"}, cfg) == "opus"
    # ...uncatalogued, but the name is unambiguous. Every model released after
    # CATALOG_AS_OF arrives here.
    assert requested_tier({"model": "claude-tiny-9"}, cfg) == "haiku"
    assert requested_tier({"model": "gemini-4-flash-lite"}, cfg) == "haiku"
    # ...and it still FAILS CLOSED where there is nothing to go on.
    assert requested_tier({"model": "totally-made-up"}, cfg) is None
    assert requested_tier({"model": ""}, cfg) is None
    assert requested_tier({}, cfg) is None
    # The operator's own tier -> id map still outranks the catalog's silence: an id an
    # operator has DECLARED to be their sonnet tier is sonnet even when unrecognisable.
    cfg2 = RouterConfig()
    cfg2.models = dict(cfg2.models)
    cfg2.models["sonnet"] = "acme-internal-v3"
    assert requested_tier({"model": "acme-internal-v3"}, cfg2) == "sonnet"
    # And it is the SAME answer pricing.model_tier gives, which is the function
    # cli/src/peek/classify.js::modelTier is a port of. One question, one answer, so the
    # ceiling the gateway applies and the ceiling `peek` estimates cannot drift.
    for mid in ("gpt-4o", "grok-4.3", "claude-fable-5", "claude-tiny-9", "o3", "o3-mini"):
        assert requested_tier({"model": mid}, cfg) == pricing.model_tier(mid), mid


def test_an_unpriceable_cheap_model_is_no_longer_escalated():
    """The defect the two ceilings USED to leave open between them, end to end.

    `claude-tiny-9` is uncatalogued, so it has no published price and the DOLLAR ceiling
    cannot see it either. With `requested_tier()` blind to it as well, a request naming a
    model whose name literally says "tiny" was answered by the OPUS model -- an upgrade,
    with upgrades disabled, on a caller who asked for the cheapest thing they could name.
    """
    cfg = RouterConfig()
    b = {"model": "claude-tiny-9",
         "messages": [{"role": "user",
                       "content": "is this deadlock-free if I take the locks in order?"}]}
    assert not pricing.is_priceable("claude-tiny-9")   # so NO dollar ceiling exists
    d = decide(b, cfg)
    assert d.tier == "haiku", f"escalated an unpriceable cheap model: {d.reason}"
    assert d.model == cfg.models["haiku"]
    assert "capped to requested 'haiku'" in d.reason


def test_models_param_maps_tier_to_provider_ids():
    """The `models` param resolves the tier against the caller's own provider lineup.

    BOTH FIXTURES USED TO BE CROSS-VENDOR and that was the defect, not the intent: the
    old test asked for `claude-opus-4-6` on the OpenAI map and expected `gpt-4o-mini`
    back. What it meant to prove is that the map is honoured; what it actually pinned was
    the gateway answering an Anthropic request with an OpenAI model. See
    test_a_foreign_vendor_model_is_never_substituted for the rule that now forbids it.
    """
    cfg = RouterConfig()
    oai = {"haiku": "gpt-4o-mini", "sonnet": "gpt-4o", "opus": "o3"}
    d = decide(body("what's 2+2", model="gpt-5.6-sol"), cfg, models=oai)
    assert d.tier == "haiku"
    assert d.model == "gpt-4o-mini"       # resolved against the OpenAI map, not Anthropic
    d2 = decide(body("diagnose this deadlock and prove the fix", model="gpt-5.6-sol"),
                cfg, models=oai)
    assert d2.model == "o3"               # hard -> OpenAI top tier


def test_dollar_ceiling_blocks_a_cost_increasing_escalation():
    """A cheap requested model must never be escalated into a pricier one.

    The requested-model ceiling caps the TIER; this ceiling is what stops the tier's
    configured TARGET costing more than the model the caller named. They fail on
    different ids -- the tier cap on a model the catalog and the name signals both miss,
    the dollar ceiling on a model with no published price -- so both have to hold.

    This fixture used to be `gpt-4o-mini` against the Anthropic map, which today is
    refused by the vendor guard before either ceiling is reached; the assertions still
    passed, but for a reason that had nothing to do with dollars. `claude-3-haiku`
    ($0.25/$1.25 -> $1.50 per 1M+1M) puts the question back where the docstring says it is.
    """
    cfg = RouterConfig()
    b = {"model": "claude-3-haiku",
         "messages": [{"role": "user", "content": "rename this variable"}]}
    d = decide(b, cfg)
    # Nothing configured is cheaper than $1.50 (the haiku target is $6), so routing at
    # all would RAISE the bill while claiming to lower it. Passthrough is the honest
    # outcome, and the caller keeps their own model.
    assert d.tier is None, f"expected passthrough, got tier={d.tier} model={d.model}"
    assert d.model == "claude-3-haiku"
    assert "passthrough" in d.reason


def test_dollar_ceiling_walks_down_to_a_cheaper_configured_tier():
    """When something configured IS cheaper, route to it rather than passing through."""
    cfg = RouterConfig()
    b = {"model": "claude-opus-4-1",  # $15/$75 -> $90 per 1M+1M
         "messages": [{"role": "user",
                       "content": "prove this lock-free queue is free of the ABA problem"}]}
    d = decide(b, cfg)
    # Opus-worthy content and an expensive requested model: the configured opus tier
    # ($5/$25 = $30) is well under the $90 ceiling, so it routes. The id is asserted
    # against the CATALOG rather than a literal -- pinning a literal here is what let
    # the sonnet id rot into a quality collapse without a single test noticing.
    assert d.tier == "opus"
    assert d.model == pricing.representative_for("anthropic", "opus")


def test_dollar_ceiling_leaves_ordinary_downgrades_alone():
    """The common case must be untouched: simple text on an expensive model downgrades."""
    cfg = RouterConfig()
    b = {"model": "claude-opus-4-1", "messages": [{"role": "user", "content": "rename a var"}]}
    d = decide(b, cfg)
    assert d.tier == "haiku"
    assert d.model == cfg.models["haiku"]


# ===========================================================================
# DEFECT 1 -- the ratchet
# ===========================================================================

def _long_convo(first_text, last_text, n=20):
    """A conversation whose FIRST message is hard and whose LAST is trivial."""
    msgs = [{"role": "user", "content": first_text}]
    for i in range(1, n - 1):
        role = "assistant" if i % 2 else "user"
        msgs.append({"role": role, "content": f"filler turn {i}"})
    msgs.append({"role": "user", "content": last_text})
    return msgs


def test_an_early_hard_word_does_not_pin_a_later_trivial_turn():
    """THE RATCHET. `decide()` routed on extract_text(body), which joins the system
    prompt and EVERY message, and every rule in _content_tier is a positive-match
    escalation with no decay -- so the tier was monotonically non-decreasing in
    conversation length. One matching word in message 1 pinned message 20, and every
    message after it, to the most expensive tier forever. Measured over ~47,000 real
    calls: 89.9% of them routed opus and the router saved 2.03% of spend.
    """
    cfg = RouterConfig()
    b = {"model": "claude-opus-4-6",
         "messages": _long_convo("Prove that this lock-free queue avoids the ABA problem.",
                                 "thanks, now capitalise this sentence")}
    d = decide(b, cfg)
    assert d.tier == "haiku", f"turn 20 was pinned by turn 1: {d.reason}"
    assert d.model == cfg.models["haiku"]


def test_the_system_prompt_can_never_route():
    """A client's system prompt is STATIC, so any word in it applies to 100% of that
    client's traffic. Letting it reach the classifier means one sentence in a harness
    preamble pins every request that client will ever make."""
    cfg = RouterConfig()
    sys_prompt = ("You are a careful engineer. Always consider security, deadlocks, "
                  "race conditions, SQL injection and formal proofs of correctness.")
    d = decide(body("what is 2+2", system=sys_prompt), cfg)
    assert d.tier == "haiku", f"the system prompt escalated a trivial request: {d.reason}"
    assert "deadlock" not in routable_text(body("what is 2+2", system=sys_prompt))


def test_the_decision_is_stable_across_a_tool_use_loop():
    """A stateless gateway "decides once per user turn" by making the window idempotent:
    every hop of the same agentic turn must recompute the identical routable text and
    therefore the identical tier. Otherwise the model swaps mid-tool-loop."""
    cfg = RouterConfig()
    msgs = [{"role": "user", "content": "rename this variable for me"}]
    tiers = []
    for hop in range(6):
        b = {"model": "claude-opus-4-6", "messages": list(msgs)}
        tiers.append(decide(b, cfg).tier)
        msgs.append({"role": "assistant",
                     "content": [{"type": "text",
                                  "text": "Let me audit the security of this thread lock."},
                                 {"type": "tool_use", "id": f"t{hop}", "name": "read",
                                  "input": {}}]})
        msgs.append({"role": "user",
                     "content": [{"type": "tool_result", "tool_use_id": f"t{hop}",
                                  "content": "deadlock race condition proof"}]})
    assert tiers == ["haiku"] * 6, f"tier drifted across a single turn: {tiers}"


def test_a_tool_result_tail_is_not_mistaken_for_the_user_turn():
    """In a tool-use loop the LAST message is a tool_result, not a request. Routing on
    "the last message" would classify the agent loop's plumbing."""
    b = {"model": "claude-opus-4-6", "messages": [
        {"role": "user", "content": "prove this mutex is deadlock free"},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "t1",
                                           "name": "read", "input": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1",
                                      "content": "ok"}]},
    ]}
    assert "mutex" in routable_text(b)
    assert decide(b, RouterConfig()).tier == "opus"


def test_a_human_interjection_mixed_with_a_tool_result_is_a_turn():
    """A message that mixes a tool_result with real text IS a human turn -- the human
    interjected mid-loop, and that interjection is the current request."""
    b = {"model": "claude-opus-4-6", "messages": [
        {"role": "user", "content": "prove this mutex is deadlock free"},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "t1",
                                           "name": "read", "input": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1",
                                      "content": "ok"},
                                     {"type": "text", "text": "actually just say hi"}]},
    ]}
    assert routable_text(b) == "actually just say hi"
    assert decide(b, RouterConfig()).tier == "haiku"


def test_routable_text_degrades_safely_on_odd_bodies():
    assert routable_text({}) == ""
    assert routable_text({"messages": []}) == ""
    assert routable_text({"messages": "nope"}) == ""
    # An assistant-prefill body carries no user turn at all: fall back to the last
    # message rather than routing on nothing.
    assert routable_text({"messages": [{"role": "assistant", "content": "half a sen"}]}) \
        == "half a sen"
    assert decide({"model": "claude-opus-4-6", "messages": []}, RouterConfig()).tier == "haiku"


def test_extract_text_is_not_used_for_routing_anywhere():
    """extract_text is kept as the honest whole-conversation accessor, but routing on it
    is the ratchet. Nothing in the gateway may call it on a routing path again."""
    import app as app_module
    src = open(app_module.__file__, encoding="utf-8").read()
    calls = [ln for ln in src.splitlines()
             if "extract_text(" in ln and not ln.strip().startswith("#")]
    assert not calls, f"extract_text reached a routing path again: {calls}"


# ===========================================================================
# DEFECT 2 -- the sonnet-5 collapse and the quality floor
# ===========================================================================

def test_tier_ids_are_resolved_from_the_price_catalog():
    """Hardcoding them is what produced the collapse: the sonnet tier rotted to
    claude-sonnet-4-5 ($18 on the ranking basket) while callers moved to
    claude-sonnet-5 (launch promo, $12)."""
    cfg = RouterConfig()
    for tier in R.TIERS:
        assert cfg.models[tier] == pricing.representative_for("anthropic", tier)


@pytest.fixture()
def at_date(monkeypatch):
    """Price the whole decision AT a fixed UTC day, so promotional windows are testable."""
    def _set(day):
        monkeypatch.setattr(pricing, "today_utc", lambda: day)
    return _set


HARD = "audit this authentication flow for a security vulnerability"


@pytest.mark.parametrize("day", ["2026-08-31", "2026-09-01"])
def test_a_sonnet_5_caller_is_never_collapsed_to_haiku(at_date, day):
    """THE COLLAPSE. RouterConfig pinned sonnet to claude-sonnet-4-5 ($3/$15 = $18)
    while claude-sonnet-5 was on a launch promo at $2/$10 = $12. For ANY request naming
    claude-sonnet-5 the dollar ceiling found cand $18 > req $12, walked DOWN, and served
    claude-haiku-4-5 ($6) -- for 100% of that caller's traffic, INCLUDING requests this
    router's own classifier had just called auto-escalate.

    Parametrised ACROSS the promo boundary (2026-08-31 -> $12, 2026-09-01 -> $18) because
    the collapse was time-boxed: a fix whose correctness depends on today's date would
    look green today and rot on 2026-09-01. Resolving both sides of the comparison from
    one catalog is what makes it date-independent -- they move together.
    """
    at_date(day)
    b = {"model": "claude-sonnet-5", "messages": [{"role": "user", "content": HARD}]}
    d = decide(b, RouterConfig())
    assert d.tier != "haiku", f"collapsed to haiku on {day}: {d.reason}"
    assert d.tier == "sonnet"


def test_the_quality_floor_prefers_passthrough_over_a_downgrade(at_date):
    """Walking down past the quality floor to satisfy a money invariant is the one trade
    this product must never make. Pinned INSIDE the promo window, which is the
    configuration the collapse actually shipped in: a mis-set ROUTER_MODEL_SONNET
    ($18) against a caller on claude-sonnet-5 ($12) with auto-escalate content. The old
    code answered that on haiku. The floor makes it a passthrough instead.
    """
    at_date("2026-06-01")
    cfg = RouterConfig()
    cfg.models = dict(cfg.models)
    cfg.models["sonnet"] = "claude-sonnet-4-5"        # the stale id, as an env override
    b = {"model": "claude-sonnet-5", "messages": [{"role": "user", "content": HARD}]}
    d = decide(b, cfg)
    assert d.tier is None, f"expected passthrough, got tier={d.tier} model={d.model}"
    assert d.model == "claude-sonnet-5"               # caller keeps their own model
    assert "quality floor" in d.reason


def test_the_floor_does_not_block_an_ordinary_downgrade(at_date):
    """The floor must not become a blanket 'never downgrade'. Non-hard content on the
    same mis-set config still routes down normally."""
    at_date("2026-06-01")
    cfg = RouterConfig()
    cfg.models = dict(cfg.models)
    cfg.models["sonnet"] = "claude-sonnet-4-5"
    b = {"model": "claude-sonnet-5", "messages": [{"role": "user", "content": "rename a var"}]}
    d = decide(b, cfg)
    assert d.tier == "haiku"


@pytest.mark.parametrize("day", ["2026-08-31", "2026-09-01"])
def test_the_floor_never_becomes_a_blanket_no_downgrade(at_date, day):
    """The discriminating case for the floor: NON-hard content that genuinely NEEDS the
    walk-down. The caller is on o3 ($2/$8 = $10), the sonnet band fires, and the sonnet
    target gpt-5.4 ($17.50) costs more than $10 -- so the dollar ceiling must still walk
    down to the haiku target gpt-5-mini ($2.25). If the floor were armed on ordinary
    content it would come out as a passthrough here, and the router would stop saving
    money on the majority of traffic while every other test stayed green.

    THE MAP IS THE OPENAI ONE, and that is forced, not decorative. The caller was already
    `o3`; running it against the ANTHROPIC map made this a cross-vendor request, which the
    vendor guard now refuses. It cannot simply move to an Anthropic caller either: on the
    shipped Anthropic map the walk-down never LANDS for any same-vendor caller (the only
    models cheaper than the $12/$18 sonnet target are the haiku-tier ones, which the tier
    cap has already pinned to haiku, leaving an empty walk-down slice and a passthrough).
    So the reachable same-vendor walk-down is on the OpenAI front-end's own map, which is
    a real shipped configuration -- app.py resolves /v1/chat/completions against it.

    The date sweep stays: it proves the outcome does not depend on the claude-sonnet-5
    promotional window, which is the boundary that silently changed this file's answers
    once already.
    """
    at_date(day)
    oai = {t: pricing.representative_for("openai", t) for t in R.TIERS}
    b = {"model": "o3",
         "messages": [{"role": "user", "content": "summarize and refactor this endpoint"}]}
    d = decide(b, RouterConfig(), models=oai)
    assert d.tier == "haiku", f"the floor blocked an ordinary downgrade: {d.reason}"
    assert d.model == oai["haiku"]
    assert "dollar ceiling" in d.reason


def test_an_explicit_cheap_request_still_wins_over_the_floor():
    """The floor forbids the ROUTER cutting below the caller's own choice. It does not
    override the caller: naming haiku is consent to haiku's quality for that request."""
    cfg = RouterConfig()
    d = decide(body(HARD, model="claude-haiku-4-5"), cfg)
    assert d.tier == "haiku"
    assert "capped" in d.reason


# ===========================================================================
# DEFECT 3 -- escalation is unreachable; the honest resolution
# ===========================================================================

@pytest.mark.parametrize("text", [
    "prove that this lock-free queue is free of the ABA problem",
    "audit this endpoint for SQL injection",
    "diagnose the deadlock between these two mutexes",
    "rename a variable",
    "summarize and refactor this endpoint and write unit tests",
])
@pytest.mark.parametrize("asked", ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-6"])
def test_the_default_never_spends_above_what_the_caller_asked_for(text, asked):
    """The POSITION this file takes on the dead-escalation defect: keep the default
    (no surprise spend) and stop advertising escalation, rather than turning upgrades on.
    That is only honest if the invariant actually holds for every input, so assert it
    as a property rather than trusting the comment."""
    cfg = RouterConfig()
    d = decide(body(text, model=asked), cfg)
    if d.tier is None:
        return                                     # passthrough spends exactly the ask
    assert R._rank(d.tier) <= R._rank(requested_tier({"model": asked}, cfg))


def test_a_cheap_requested_model_with_hard_content_passes_through():
    """The caller's own model is cheaper than every configured tier at or above the cap,
    so there is nothing to route to that would not RAISE the bill. Passthrough is the
    only honest answer, and it must not become a downgrade or an upgrade."""
    cfg = RouterConfig()
    b = {"model": "claude-3-haiku",              # $0.25/$1.25 -> $1.50 per 1M+1M
         "messages": [{"role": "user", "content": HARD}]}
    d = decide(b, cfg)
    assert d.tier is None, f"expected passthrough, got tier={d.tier} model={d.model}"
    assert d.model == "claude-3-haiku"


def test_a_hard_classification_is_a_downgrade_veto_not_an_upgrade():
    """What the auto-escalate categories buy under the shipped default: they cannot
    raise the tier, but they stop the dollar ceiling cutting below it.

    The veto fixture was `gpt-4o-mini`, which the vendor guard now refuses before any of
    this is reached -- the assertion still held while testing nothing it claimed to.
    `claude-3-haiku` ($1.50) is the same shape inside one vendor: cheaper than every
    configured tier, hard content, so the walk-down has nowhere legal to land.
    """
    cfg = RouterConfig()
    up = decide(body(HARD, model="claude-haiku-4-5"), cfg)
    assert up.tier == "haiku"                      # no upgrade
    veto = decide({"model": "claude-3-haiku",
                   "messages": [{"role": "user", "content": HARD}]}, cfg)
    assert veto.tier is None                       # but no quality-breaching downgrade
    assert "quality floor" in veto.reason


# ===========================================================================
# THE VENDOR GUARD -- the gateway used to answer with a different company's model
# ===========================================================================

# The tier -> id maps app.py really resolves against: /v1/messages uses the Anthropic
# one, /v1/chat/completions uses the OpenAI one. Read from the catalog rather than
# written out, so a route-target change reaches these tests instead of rotting past them.
def _map(family):
    return {t: pricing.representative_for(family, t) for t in R.TIERS}


@pytest.mark.parametrize("asked,family", [
    ("grok-4.3", "xai"),
    ("mistral-medium-3.5", "mistral"),
    ("gemini-2.5-pro", "google"),
    ("gpt-5.6-terra", "openai"),
    ("deepseek-v4-pro", "deepseek"),
])
def test_a_foreign_vendor_model_is_never_substituted(asked, family):
    """A request naming vendor X must not be answered by vendor Y's model.

    WHAT THIS DID ON THE WIRE. app.py's /v1/messages resolves every caller against the
    ANTHROPIC map, rewrites `body["model"]` to the routed id and forwards to
    api.anthropic.com. So a client that sent `grok-4.3` was served `claude-haiku-4-5`,
    and the call SUCCEEDED -- where an untouched passthrough would have been rejected
    upstream as an unknown model. A silent success is the worst available signal: nothing
    in the response tells a caller comparing vendors that it just measured Claude for all
    of them.

    Every other rule in `decide()` trades dollars against capability, and the caller
    consented to that by pointing their base URL here. Changing the VENDOR is not that
    trade -- different training, different tool-use semantics, a different context window
    and a different data agreement. cli/src/peek/pricing.js already refused to model it
    ("never to a different vendor", plus a test), so the two runtimes disagreed about
    whether the product substitutes vendors at all.
    """
    b = {"model": asked, "messages": [{"role": "user", "content": "rename this variable"}]}
    d = decide(b, RouterConfig())
    assert d.tier is None, f"expected passthrough, got tier={d.tier} model={d.model}"
    assert d.model == asked, "the caller must keep their own model id"
    assert f"'{family}'" in d.reason and "'anthropic'" in d.reason
    assert "cross-vendor" in d.reason


def test_the_openai_front_end_refuses_the_mirror_image():
    """The same rule pointed the other way, and this direction was WORSE before the fix:
    the old substring test recognised 'opus' inside `claude-opus-5`, so it mapped to tier
    opus and was served OPENAI_MODELS['opus'] against api.openai.com -- a fully
    "successful" Anthropic request answered by OpenAI."""
    d = decide(body("rename this variable", model="claude-opus-5"),
               RouterConfig(), models=_map("openai"))
    assert d.tier is None, f"expected passthrough, got tier={d.tier} model={d.model}"
    assert d.model == "claude-opus-5"
    assert "cross-vendor" in d.reason


def test_the_vendor_guard_survives_allow_upgrade():
    """ROUTER_ALLOW_UPGRADE disables both COST ceilings. It does not license serving a
    different company's model: an operator who opted into spending more did not thereby
    opt into a substitution they cannot see."""
    cfg = RouterConfig(allow_upgrade_above_requested=True)
    d = decide(body("diagnose this deadlock and prove the fix", model="grok-4.3"), cfg)
    assert d.tier is None, f"expected passthrough, got tier={d.tier} model={d.model}"
    assert "cross-vendor" in d.reason


def test_the_vendor_guard_is_narrow():
    """It fires only when BOTH families are known and they differ. Everything else falls
    through to the ordinary rules -- a guard that refused whenever it was UNSURE would
    turn every new model id into a passthrough and quietly stop the product working."""
    cfg = RouterConfig()
    simple = "rename this variable"
    # same vendor -> routes normally
    assert decide(body(simple, model="claude-opus-5"), cfg).tier == "haiku"
    # unrecognised requested id -> no vendor claim to protect
    assert decide(body(simple, model="totally-made-up"), cfg).tier == "haiku"
    # no model named at all -> likewise
    assert decide({"messages": [{"role": "user", "content": simple}]}, cfg).tier == "haiku"
    # an operator's deliberately MIXED map carries no single-vendor claim either, so a
    # configuration they chose on purpose keeps working.
    mixed = {"haiku": "claude-haiku-4-5", "sonnet": "gpt-5.4", "opus": "claude-opus-5"}
    assert R._map_family(mixed) is None
    assert decide(body(simple, model="grok-4.3"), cfg, models=mixed).tier == "haiku"
    # ...and so does a map naming a target no family pattern recognises.
    unknown = {"haiku": "totally-made-up", "sonnet": "claude-sonnet-5",
               "opus": "claude-opus-5"}
    assert R._map_family(unknown) is None
    assert decide(body(simple, model="grok-4.3"), cfg, models=unknown) is not None


def test_a_typo_in_router_min_tier_clamps_instead_of_crashing():
    """ROUTER_MIN_TIER is read straight from the environment with no validation
    (app.py::_config_from_env), and `_rank()` raises ValueError on a tier name it does not
    know -- so one typo turned EVERY request into a 500 from inside the routing core,
    with the traceback pointing at TIERS.index rather than at the operator's config.
    cli/src/peek/classify.js already clamped, so `peek` estimated a working router while
    the gateway returned errors; both clamp now."""
    cfg = RouterConfig(min_tier="sonett")
    d = decide(body("rename this variable", model="claude-opus-5"), cfg)
    assert d.tier == "haiku", d.reason      # clamped to the cheap default, not raised
    # A VALID min_tier is of course still honoured.
    assert decide(body("rename this variable", model="claude-opus-5"),
                  RouterConfig(min_tier="sonnet")).tier == "sonnet"


# ===========================================================================
# DEFECT 4 -- first-match-wins made the patterns untunable
# ===========================================================================

@pytest.mark.parametrize("word,sentence", [
    ("proof",     "can you read the proof of delivery email and file it"),
    ("thread",    "summarise this email thread for me"),
    ("diagnos",   "the mechanic sent a diagnostic printout, retype it"),
    ("security",  "reword the security deposit clause to be friendlier"),
])
def test_a_bare_high_incidental_word_no_longer_escalates_alone(word, sentence):
    """Measured incidental rates on real traffic: proof 96.0%, thread 89.4%,
    diagnos 86.8%, security 80.2%. Under first-match-wins any ONE of them returned
    'opus' immediately, and because escalated traffic matched several at once the false
    positives were mutually REDUNDANT -- deleting one changed almost nothing (the four
    together recovered 1.28%), which is what made the set impossible to tune."""
    cfg = RouterConfig()
    tier, _reason, hard = R._content_tier(sentence, cfg)
    assert not hard, f"/{word}/ still escalates on its own"
    assert tier != "opus"


def test_two_independent_risk_domains_still_escalate():
    cfg = RouterConfig()
    _t, reason, hard = R._content_tier(
        "the contract says the diagnosis must be logged", cfg)      # legal + medical
    assert hard and "independent risk domains" in reason


def test_a_domain_noun_next_to_a_risk_verb_escalates():
    """A single domain can still escalate, but only in the "domain noun + risk verb"
    shape -- which is the difference between someone ASKING about authentication and
    someone merely mentioning it."""
    cfg = RouterConfig()
    _t, reason, hard = R._content_tier(
        "review the authentication flow and make sure it is safe", cfg)
    assert hard and "risk cue" in reason
    # ...and the same noun with no risk verb anywhere near it does not.
    _t2, _r2, hard2 = R._content_tier(
        "add an authentication flow diagram to the readme", cfg)
    assert not hard2


def test_a_domain_noun_cannot_corroborate_itself():
    """The co-occurrence scan searches the two FLANKS of the match and never the match
    itself, so a domain word that happens to contain a risk cue cannot vouch for its own
    occurrence."""
    rgx = re.compile(r"\bauditlock\b")     # contrived: the token contains the cue 'audit'
    assert not R._risk_cue_near("the auditlock is here", rgx, 120)
    assert R._risk_cue_near("please review the auditlock", rgx, 120)


def _hard(text, cfg):
    return R._content_tier(text, cfg)[2]


def test_all_signals_are_collected_not_just_the_first():
    """THE TUNABILITY PROPERTY. first-match-wins returned on the first hit, so a
    redundant pattern was invisible to any measurement and deleting it moved nothing.
    Collecting every signal is what makes a per-pattern marginal meaningful."""
    cfg = RouterConfig()
    sigs = R._hard_signals(
        "prove that this lock-free mutex avoids the ABA problem and a race condition", cfg)
    assert len(sigs) >= 4, sigs


def test_the_sonnet_band_needs_corroboration_too():
    """The shipped band fired on any single match and measured ANTI-predictive: turns it
    sent to sonnet did LESS real work (median 37k output tokens) than turns it sent to
    haiku (59k). Requiring two independent signals puts the ordering back the right way
    up (measured: sonnet 90k vs haiku 54k)."""
    cfg = RouterConfig()
    assert R._content_tier("can you summarize this", cfg)[0] == "haiku"      # 1 signal
    assert R._content_tier("summarize and refactor this endpoint", cfg)[0] == "sonnet"


@pytest.mark.parametrize("text", [
    "is this endpoint vulnerable to SQL injection",
    "prove that this lock-free queue is free of the ABA problem",
    "diagnose the deadlock between these two mutexes",
    "is this token comparison vulnerable to a timing attack and an XSS payload",
    "this is a production outage, the writes are irreversible",
    "check this CSRF token flow",
    "we need to sanitize this input before it reaches the query",
    "audit this authentication flow for a security vulnerability",
    "explain the memory-ordering guarantees of this atomic counter",
    "review the crypto key rotation and make sure nothing leaks",
])
def test_quality_is_not_regressed_on_canonical_hard_requests(text):
    """The redesign routes ~6 points less traffic to opus, so the burden of proof is on
    it: every unambiguous correctness-critical shape must still classify hard. A
    confidently wrong answer on one of these costs more than the routing ever saves."""
    assert _hard(text, RouterConfig()), text
