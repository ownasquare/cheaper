"""Deterministic tests for the routing core. No network required: run `pytest`."""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from router import RouterConfig, decide, extract_text, requested_tier  # noqa: E402


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


def test_models_param_maps_tier_to_provider_ids():
    cfg = RouterConfig()
    oai = {"haiku": "gpt-4o-mini", "sonnet": "gpt-4o", "opus": "o3"}
    d = decide(body("what's 2+2", model="claude-opus-4-6"), cfg, models=oai)
    assert d.tier == "haiku"
    assert d.model == "gpt-4o-mini"       # resolved against the OpenAI map, not Anthropic
    d2 = decide(body("diagnose this deadlock and prove the fix", model="gpt-4o"), cfg, models=oai)
    assert d2.model == "o3"               # hard -> OpenAI top tier
