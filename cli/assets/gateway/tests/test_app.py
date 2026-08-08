"""Integration test for the forwarder: verifies the gateway rewrites the model and
adds routing headers, using a mocked upstream (no real network / API key)."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import httpx  # noqa: E402
import pytest  # noqa: E402


@pytest.fixture()
def client_and_capture(monkeypatch):
    import app as app_module

    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        # The headers that ACTUALLY left this machine. Captured because the forwarder
        # used to copy every inbound header verbatim and shipped the local session
        # cookie to api.anthropic.com; see test_the_proxy_never_forwards_local_secrets.
        captured["headers"] = dict(request.headers)
        try:
            captured["body"] = json.loads(request.content.decode())
        except Exception:
            captured["body"] = None   # the catch-all proxy also carries GETs / no body
        return httpx.Response(
            200,
            json={"id": "msg_1", "type": "message", "role": "assistant",
                  "content": [{"type": "text", "text": "ok"}],
                  "model": (captured["body"] or {}).get("model")},
        )

    mock = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(app_module, "_client", mock)

    from fastapi.testclient import TestClient
    return TestClient(app_module.app), captured


def _post(client, text, model="claude-opus-4-6"):
    return client.post(
        "/v1/messages",
        headers={"x-api-key": "test", "anthropic-version": "2023-06-01"},
        json={"model": model, "max_tokens": 16,
              "messages": [{"role": "user", "content": text}]},
    )


def test_simple_request_is_downgraded_to_haiku(client_and_capture):
    client, captured = client_and_capture
    r = _post(client, "What's 2+2?", model="claude-opus-4-6")
    assert r.status_code == 200
    assert r.headers["x-router-tier"] == "haiku"
    assert captured["body"]["model"] == "claude-haiku-4-5"  # actually forwarded downgraded
    assert r.headers["x-router-original-model"] == "claude-opus-4-6"


def test_hard_request_stays_opus(client_and_capture):
    client, captured = client_and_capture
    r = _post(client, "Diagnose this deadlock and prove the fix is correct.")
    assert r.headers["x-router-tier"] == "opus"
    # Asserted against the CATALOG, not a literal id. Pinning a literal here is exactly
    # what let the sonnet tier id rot into a live quality collapse with a green suite.
    import pricing
    assert captured["body"]["model"] == pricing.representative_for("anthropic", "opus")


def test_bypass_header_forwards_untouched(client_and_capture):
    client, captured = client_and_capture
    r = client.post(
        "/v1/messages",
        headers={"x-api-key": "t", "anthropic-version": "2023-06-01", "x-router-bypass": "true"},
        json={"model": "claude-opus-4-6", "max_tokens": 8,
              "messages": [{"role": "user", "content": "What's 2+2?"}]},
    )
    assert "x-router-tier" not in r.headers
    assert captured["body"]["model"] == "claude-opus-4-6"  # not downgraded


def test_openai_chat_completions_routes(client_and_capture):
    client, captured = client_and_capture
    r = client.post("/v1/chat/completions",
                    headers={"authorization": "Bearer t"},
                    json={"model": "gpt-4o", "max_tokens": 16,
                          "messages": [{"role": "user", "content": "whats 2+2"}]})
    assert r.status_code == 200
    assert r.headers["x-router-tier"] == "haiku"
    assert captured["body"]["model"] == "gpt-4o-mini"   # rewritten to OpenAI cheap tier
    assert r.headers["x-router-original-model"] == "gpt-4o"


# ---- the ratchet, at the HTTP boundary -------------------------------------

def _convo(first, last, n=20):
    msgs = [{"role": "user", "content": first}]
    for i in range(1, n - 1):
        msgs.append({"role": "assistant" if i % 2 else "user", "content": f"filler {i}"})
    msgs.append({"role": "user", "content": last})
    return msgs


def test_a_long_conversation_is_not_ratcheted(client_and_capture):
    """End-to-end proof of the ratchet fix. The gateway routed on the whole
    conversation, and every rule is a positive-match escalation with no decay, so one
    hard word in message 1 pinned message 20 -- and every message after it -- to the
    top tier for the life of the session. Measured over ~47,000 real calls: 89.9%
    routed opus, 2.03% saved. Scoped to the current turn: 28.7% saved."""
    client, captured = client_and_capture
    import pricing
    r = client.post("/v1/messages",
                    headers={"x-api-key": "t", "anthropic-version": "2023-06-01"},
                    json={"model": "claude-opus-4-6", "max_tokens": 16,
                          "messages": _convo("Prove this lock-free queue avoids the ABA problem.",
                                             "thanks, now capitalise this sentence")})
    assert r.status_code == 200
    assert r.headers["x-router-tier"] == "haiku", r.headers["x-router-reason"]
    assert captured["body"]["model"] == pricing.representative_for("anthropic", "haiku")


def test_the_system_prompt_cannot_route(client_and_capture):
    """A static system prompt applies to 100% of a client's traffic, so one word in a
    harness preamble could pin every request that client would ever make."""
    client, captured = client_and_capture
    r = client.post("/v1/messages",
                    headers={"x-api-key": "t", "anthropic-version": "2023-06-01"},
                    json={"model": "claude-opus-4-6", "max_tokens": 16,
                          "system": "You are careful about security, deadlocks, race "
                                    "conditions, SQL injection and formal proofs.",
                          "messages": [{"role": "user", "content": "what is 2+2"}]})
    assert r.headers["x-router-tier"] == "haiku", r.headers["x-router-reason"]


def test_triage_mode_sends_only_the_current_turn_to_the_classifier(monkeypatch):
    """The triage path shared the ratchet AND had a truncation bug on top of it: it sent
    `extract_text(body)[:6000]`, so on any long conversation the 6 kB the cheap model
    actually saw was the system prompt and the OLDEST messages -- the request being
    classified was cut off entirely."""
    import app as app_module
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content.decode()))
        return httpx.Response(200, json={"id": "m", "type": "message", "role": "assistant",
                                         "content": [{"type": "text", "text": "haiku"}]})

    monkeypatch.setattr(app_module, "_client",
                        httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(app_module, "MODE", "triage")

    from fastapi.testclient import TestClient
    TestClient(app_module.app).post(
        "/v1/messages", headers={"x-api-key": "t", "anthropic-version": "2023-06-01"},
        json={"model": "claude-opus-4-6", "max_tokens": 16,
              "system": "SYSTEMPROMPTMARKER security deadlock proof",
              "messages": _convo("HISTORYMARKER prove this mutex is deadlock free",
                                 "CURRENTMARKER capitalise this")})

    triage_prompt = seen[0]["messages"][0]["content"]
    assert "CURRENTMARKER" in triage_prompt
    assert "SYSTEMPROMPTMARKER" not in triage_prompt
    assert "HISTORYMARKER" not in triage_prompt


# ---- security hardening ----------------------------------------------------

def test_rejects_untrusted_host(client_and_capture):
    # DNS-rebinding defence: a request whose Host is not a loopback name is 400'd,
    # even reaching the always-open health route. Loopback hosts still work.
    client, _ = client_and_capture
    assert client.get("/healthz").status_code == 200                      # testserver: allowed
    assert client.get("/healthz", headers={"host": "evil.example.com"}).status_code == 400
    assert client.get("/metrics", headers={"host": "attacker.test"}).status_code == 400


def test_source_header_is_sanitized_at_ingest(client_and_capture, monkeypatch):
    # x-cheaper-source is a raw client header; a newline in it is a JSONL line-injection
    # primitive. The value that reaches storage must carry no control chars or
    # structural characters.
    import app as app_module
    rec = {}
    monkeypatch.setattr(app_module.METRICS, "record", lambda **kw: rec.update(kw))
    client, _ = client_and_capture
    client.post("/v1/messages",
                headers={"x-api-key": "t", "anthropic-version": "2023-06-01",
                         "x-cheaper-source": 'evil\n{"v":1,"in":999999999}\t<x>'},
                json={"model": "claude-opus-4-6", "max_tokens": 8,
                      "messages": [{"role": "user", "content": "hi"}]})
    s = rec.get("source", "")
    assert "\n" not in s and "\t" not in s
    assert not any(ch in s for ch in '<>{}"')


def test_x_cheaper_session_header_is_ignored(client_and_capture, monkeypatch):
    # x-cheaper-session was retired: nothing in the repo writes it any more, and
    # session attribution must come only from x-session-id (the surviving
    # third-party client contract), never from this header.
    import app as app_module
    rec = {}
    monkeypatch.setattr(app_module.METRICS, "record", lambda **kw: rec.update(kw))
    client, _ = client_and_capture
    client.post("/v1/messages",
                headers={"x-api-key": "t", "anthropic-version": "2023-06-01",
                         "x-cheaper-session": "abc"},
                json={"model": "claude-opus-4-6", "max_tokens": 8,
                      "messages": [{"role": "user", "content": "hi"}]})
    assert rec.get("session") == ""


def test_x_session_id_header_still_attributes_session(client_and_capture, monkeypatch):
    import app as app_module
    rec = {}
    monkeypatch.setattr(app_module.METRICS, "record", lambda **kw: rec.update(kw))
    client, _ = client_and_capture
    client.post("/v1/messages",
                headers={"x-api-key": "t", "anthropic-version": "2023-06-01",
                         "x-session-id": "abc"},
                json={"model": "claude-opus-4-6", "max_tokens": 8,
                      "messages": [{"role": "user", "content": "hi"}]})
    assert rec.get("session") == "abc"


SECRET = "deadbeef" * 8   # stands in for the local dash.token value


@pytest.mark.parametrize("method,path,kwargs", [
    # The catch-all proxy — the route the leak was reported on.
    ("get", "/v1/models", {}),
    # …and the routed paths, which share _fwd_headers and had exactly the same hole.
    ("post", "/v1/messages", {"json": {"model": "claude-opus-4-6", "max_tokens": 8,
                                       "messages": [{"role": "user", "content": "hi"}]}}),
])
def test_the_proxy_never_forwards_local_secrets_upstream(client_and_capture, method,
                                                         path, kwargs):
    """`Cookie` reached api.anthropic.com verbatim.

    _fwd_headers stripped only five hop-by-hop names, so the browser's cheaper_token
    session cookie — the credential that unlocks this machine's entire AI-usage record —
    was copied onto the outbound request, together with Referer (which discloses local
    URLs, token query strings included) and x-cheaper-token itself. The value confers
    nothing off-machine, but a local secret must not be handed to a third party at all.
    """
    client, captured = client_and_capture
    r = getattr(client, method)(path, headers={
        "cookie": f"cheaper_token={SECRET}; theme=dark",
        "referer": f"http://localhost:8787/dashboard?token={SECRET}",
        "origin": "http://localhost:8787",
        "x-cheaper-token": SECRET,
        "x-api-key": "provider-key",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
    }, **kwargs)
    assert r.status_code == 200
    sent = {k.lower(): v for k, v in captured["headers"].items()}
    for leaked in ("cookie", "referer", "origin", "x-cheaper-token"):
        assert leaked not in sent, f"{leaked} was forwarded upstream: {sent.get(leaked)!r}"
    assert not any(SECRET in v for v in sent.values()), sent
    # …while every header the provider actually needs still gets through, or this
    # "fix" would just break routing.
    assert sent["x-api-key"] == "provider-key"
    assert sent["anthropic-version"] == "2023-06-01"
    assert sent["anthropic-beta"] == "prompt-caching-2024-07-31"


def test_the_openai_front_end_still_forwards_its_own_credentials(client_and_capture):
    # The allowlist must not quietly break the OpenAI-compatible path: bearer auth and
    # the org/project scoping headers are how that upstream authenticates at all.
    client, captured = client_and_capture
    r = client.post("/v1/chat/completions",
                    headers={"authorization": "Bearer sk-test",
                             "openai-organization": "org-1",
                             "openai-project": "proj-1",
                             "cookie": f"cheaper_token={SECRET}"},
                    json={"model": "gpt-4o", "max_tokens": 8,
                          "messages": [{"role": "user", "content": "whats 2+2"}]})
    assert r.status_code == 200
    sent = {k.lower(): v for k, v in captured["headers"].items()}
    assert sent["authorization"] == "Bearer sk-test"
    assert sent["openai-organization"] == "org-1" and sent["openai-project"] == "proj-1"
    assert "cookie" not in sent


def test_the_proxy_never_forwards_the_dashboard_token_query_param(client_and_capture):
    # Same leak, different channel: ?token=<dash.token> is the query-string form of the
    # local credential (auth.presented reads it), and the catch-all forwarded the query
    # string verbatim — straight into a third party's access log.
    client, captured = client_and_capture
    r = client.get("/v1/models", params={"token": SECRET, "limit": "3"},
                   headers={"x-api-key": "k"})
    assert r.status_code == 200
    assert SECRET not in captured["url"], captured["url"]
    assert "limit=3" in captured["url"]        # real params still pass through


def test_no_allowed_host_entry_is_dead_config():
    """`::1` sat in this list for a while doing nothing.

    TrustedHostMiddleware compares `host.split(":")[0]`, so the only legal spelling of
    an IPv6 literal in a Host header — `[::1]:8787` — normalises to `"["` and can never
    equal `"::1"`. Any entry containing a colon (or a bracket) is therefore unmatchable
    by construction: it reads as protection that does not exist. Not a vulnerability
    (the gateway binds 127.0.0.1, so an IPv6 loopback connection never reaches the
    middleware) — dead config, which is its own kind of bug.
    """
    import app as app_module
    dead = [h for h in app_module._ALLOWED_HOSTS if ":" in h or h.startswith("[")]
    assert not dead, (f"unmatchable allowed-host entries {dead}: TrustedHostMiddleware "
                      "compares host.split(':')[0], so these can never match a Host header")


def test_ipv6_literal_hosts_are_unsupported_not_silently_allowed():
    """Pins the documented behaviour that made `::1` dead: a bracketed IPv6 literal
    Host is rejected. If IPv6 loopback is ever really wanted, this test is the place
    that has to change first — and it must change together with the bind address."""
    import app as app_module
    from fastapi.testclient import TestClient
    c = TestClient(app_module.app)
    assert c.get("/healthz", headers={"host": "[::1]:8787"}).status_code == 400
    assert c.get("/healthz", headers={"host": "localhost:8787"}).status_code == 200


def test_sanitize_helpers_are_bounded_and_control_free():
    from app import _sanitize_source, _sanitize_model
    s = _sanitize_source('a\r\n{"v":1}\t<b>' + "x" * 200)
    assert not any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in s)
    assert not any(ch in s for ch in '<>{}"')
    assert len(s) <= 64
    m = _sanitize_model("claude-opus-5\ninjected" + "y" * 200)
    assert "\n" not in m and len(m) <= 128
    assert _sanitize_model(None) == "" and _sanitize_source(None) == ""
