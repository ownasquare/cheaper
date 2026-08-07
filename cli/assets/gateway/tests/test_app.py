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
        captured["body"] = json.loads(request.content.decode())
        return httpx.Response(
            200,
            json={"id": "msg_1", "type": "message", "role": "assistant",
                  "content": [{"type": "text", "text": "ok"}],
                  "model": captured["body"]["model"]},
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
    assert captured["body"]["model"] == "claude-opus-4-6"


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


def test_sanitize_helpers_are_bounded_and_control_free():
    from app import _sanitize_source, _sanitize_model
    s = _sanitize_source('a\r\n{"v":1}\t<b>' + "x" * 200)
    assert not any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in s)
    assert not any(ch in s for ch in '<>{}"')
    assert len(s) <= 64
    m = _sanitize_model("claude-opus-5\ninjected" + "y" * 200)
    assert "\n" not in m and len(m) <= 128
    assert _sanitize_model(None) == "" and _sanitize_source(None) == ""
