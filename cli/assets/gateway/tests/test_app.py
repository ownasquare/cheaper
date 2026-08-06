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
