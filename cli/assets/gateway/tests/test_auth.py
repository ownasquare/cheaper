"""The same-machine token gate.

Loopback is not a trust boundary on a shared machine: before this, any other user
account or any process on the box could `GET localhost:8787/metrics` and read the
owner's complete per-call AI-usage record. These tests pin the three properties that
make that false, and the two that keep the product working:

  * every route that discloses usage data 401s without the token;
  * /healthz and the /v1 proxy stay OPEN, because every freshness check polls the
    former before it could know a token and every routed call goes through the latter;
  * the token is accepted in the query string as well as a header, because a browser
    navigating to /dashboard cannot set a header.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import httpx  # noqa: E402
import pytest  # noqa: E402

# Routes that must NEVER be reachable without the token. `/report` and `/dashboard`
# are in here deliberately: the page is as sensitive as the payload it renders.
GATED = ["/metrics", "/peek", "/logs", "/report", "/dashboard"]


@pytest.fixture()
def client(monkeypatch):
    import app as app_module

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": "msg_1", "type": "message",
                                         "role": "assistant", "content": [],
                                         "model": "claude-haiku-4-5"})

    monkeypatch.setattr(app_module, "_client",
                        httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    from fastapi.testclient import TestClient
    return TestClient(app_module.app)


@pytest.mark.parametrize("path", GATED)
def test_gated_routes_401_without_a_token(client, path):
    r = client.get(path)
    assert r.status_code == 401, f"{path} answered {r.status_code} with no token"
    # The 401 must tell the user how to fix it, not just refuse.
    assert "dash.token" in r.text


@pytest.mark.parametrize("path", GATED)
def test_gated_routes_200_with_the_header(client, auth_headers, path):
    assert client.get(path, headers=auth_headers).status_code == 200


@pytest.mark.parametrize("path", GATED)
def test_gated_routes_200_with_the_query_param(client, gw_token, path):
    # The browser path. `cheaper dashboard` opens /dashboard?token=... because a
    # navigation cannot carry a custom header.
    assert client.get(path, params={"token": gw_token}).status_code == 200


def test_a_wrong_token_is_refused(client):
    assert client.get("/metrics", headers={"x-cheaper-token": "0" * 64}).status_code == 401
    assert client.get("/metrics", params={"token": "nope"}).status_code == 401


def test_healthz_is_open_and_advertises_the_gate(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    j = r.json()
    # `auth_required` lets a client distinguish "this build wants a token" from
    # "this build predates tokens" without guessing from a 401.
    assert j["auth_required"] is True
    assert j["token_private"] is True, "dash.token must not be group/world readable"


def test_the_proxy_itself_needs_no_token(client):
    # Clients point ANTHROPIC_BASE_URL at the gateway. Gating this would break every
    # routed call, and these requests already carry the user's own provider credentials.
    r = client.post("/v1/messages",
                    headers={"x-api-key": "t", "anthropic-version": "2023-06-01"},
                    json={"model": "claude-opus-4-6", "max_tokens": 8,
                          "messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200


def test_every_data_route_declares_the_dependency():
    """Structural guard against the real regression: someone adds `/api/v1/whatever`
    and forgets the dependency. Asserting on the route table catches it at the moment
    it is written, which no per-endpoint test can do for a route that does not exist
    yet."""
    import app as app_module
    from auth import require_token

    OPEN = {"/healthz", "/v1/messages", "/v1/chat/completions", "/{path:path}", "/ws"}
    # /dashboard checks the token INSIDE the handler so it can answer a browser with an
    # HTML wall instead of `{"detail": ...}` — a bookmarked URL used to render raw JSON.
    # It is still gated; test_gated_routes_401_without_a_token proves that per-route,
    # and test_the_auth_wall_is_html_not_json proves the shape.
    IN_HANDLER = {"/dashboard"}
    missing = []
    for route in app_module.app.routes:
        path = getattr(route, "path", None)
        if not path or path in OPEN or path in IN_HANDLER:
            continue
        if not path.startswith(("/api", "/metrics", "/peek", "/logs", "/report")):
            continue
        deps = getattr(route, "dependencies", []) or []
        if not any(getattr(d, "dependency", None) is require_token for d in deps):
            missing.append(path)
    assert not missing, f"routes serving usage data without require_token: {missing}"


def test_an_authenticated_dashboard_load_issues_a_session_cookie(client, gw_token):
    """So a plain browser reload keeps working after the page scrubs its own URL.

    The page moves the token into sessionStorage and strips it from the address bar
    (that URL gets screenshotted and pasted into issues). The server cannot read
    sessionStorage, so without this cookie a Cmd-R arrived with no credential at all.
    """
    r = client.get("/dashboard", params={"token": gw_token})
    assert r.status_code == 200
    raw = r.headers.get("set-cookie", "")
    assert "cheaper_token=" in raw
    # HttpOnly: an injected script cannot exfiltrate the secret.
    assert "httponly" in raw.lower()
    # SameSite=Strict: never attached to a cross-site request, including a top-level
    # navigation from a malicious page — which is what makes gating GETs on it safe.
    assert "samesite=strict" in raw.lower().replace(" ", "")
    # And the cookie alone must then authenticate a data route.
    assert client.get("/metrics").status_code == 200


def test_the_cookie_is_never_issued_without_the_token(client):
    r = client.get("/dashboard")
    assert r.status_code == 401
    assert "cheaper_token=" not in r.headers.get("set-cookie", "")


def test_the_auth_wall_is_html_not_json(client):
    """A browser that reaches /dashboard without the token must get a readable page.

    It previously got `{"detail": "This gateway serves your private AI-usage record…"}`
    rendered as raw JSON — technically correct, completely useless to the person who
    bookmarked the URL.
    """
    r = client.get("/dashboard")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("text/html")
    assert "cheaper dashboard" in r.text
    assert "dash.token" in r.text
    # …and it must NOT be the real dashboard: no data, no app script.
    assert "tabNav" not in r.text
    assert "loadLogs" not in r.text


def test_websocket_is_closed_without_a_token(client):
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect) as ei:
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
    # 1008 = policy violation. The dashboard stops retrying on this code instead of
    # hammering the socket forever.
    assert ei.value.code == 1008


def test_websocket_accepts_a_tokened_connection(client, gw_token):
    with client.websocket_connect("/ws?token=" + gw_token) as ws:
        msg = ws.receive_json()
        assert msg["type"] == "metrics"


def test_token_file_is_0600_and_64_hex(gw_token):
    import stat
    from auth import token_path
    assert len(gw_token) == 64 and all(c in "0123456789abcdef" for c in gw_token)
    mode = os.stat(token_path()).st_mode
    assert not (mode & (stat.S_IRWXG | stat.S_IRWXO)), oct(mode)


def test_dashboard_markup_never_embeds_the_secret(client, gw_token):
    # The page receives the token via the URL and moves it into sessionStorage; the
    # SERVED bytes must never contain it, or a cached copy on disk would leak it.
    html = client.get("/dashboard", params={"token": gw_token}).text
    assert gw_token not in html
