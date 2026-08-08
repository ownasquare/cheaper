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


# ---------------------------------------------------------------------------
# Origin binding for the COOKIE credential.
#
# The hole this closes: SameSite=Strict computes "site" as eTLD+1 and IGNORES THE PORT,
# so a page on ANY other http://localhost:<port> is same-site with this gateway and the
# browser attaches cheaper_token to its requests. WebSockets are additionally exempt
# from CORS, so before this the attacker page could open ws://localhost:8787/ws and
# stream the victim's complete per-call usage record — a cross-origin READ, not just a
# blind write. Precondition: the cookie already exists in that browser profile, i.e.
# the user has opened the dashboard at least once. That is the normal state.
#
# The credential kind is what decides: only the cookie is attached by the browser on
# its own. A header- or query-presented token is not CSRF-reachable (the caller had to
# know the secret) and MUST keep working from anywhere, because that is the CLI, the
# desktop shell and `cheaper dashboard`.
# ---------------------------------------------------------------------------

FOREIGN = "http://localhost:9999"          # same SITE, different ORIGIN. The whole bug.


def _with_cookie(client, gw_token):
    """A client holding the session cookie and nothing else — exactly the state a
    browser is in after the dashboard has been opened once."""
    assert client.get("/dashboard", params={"token": gw_token}).status_code == 200
    assert "cheaper_token" in client.cookies
    return client


def test_websocket_refuses_a_foreign_origin_even_with_a_valid_cookie(client, gw_token):
    from starlette.websockets import WebSocketDisconnect
    _with_cookie(client, gw_token)
    with pytest.raises(WebSocketDisconnect) as ei:
        with client.websocket_connect("/ws", headers={"origin": FOREIGN}) as ws:
            ws.receive_json()
    # 1008 = policy violation, closed BEFORE accept, so not one metrics frame was sent.
    assert ei.value.code == 1008


def test_websocket_accepts_its_own_origin_with_the_cookie(client, gw_token):
    # The real dashboard: served by this gateway, reconnecting after the page scrubbed
    # the token out of its own URL, so the cookie is the only credential it has.
    _with_cookie(client, gw_token)
    with client.websocket_connect("/ws", headers={"origin": "http://testserver"}) as ws:
        assert ws.receive_json()["type"] == "metrics"


def test_websocket_still_accepts_a_headered_client_with_no_origin(client, gw_token):
    # CLI-style: no Origin at all, token in the header. Must keep working.
    with client.websocket_connect("/ws", headers={"x-cheaper-token": gw_token}) as ws:
        assert ws.receive_json()["type"] == "metrics"


def test_websocket_refuses_a_null_origin(client, gw_token):
    # "null" is what a sandboxed iframe or a file:// page sends. It is not this gateway.
    from starlette.websockets import WebSocketDisconnect
    _with_cookie(client, gw_token)
    with pytest.raises(WebSocketDisconnect) as ei:
        with client.websocket_connect("/ws", headers={"origin": "null"}) as ws:
            ws.receive_json()
    assert ei.value.code == 1008


@pytest.mark.parametrize("path", ["/metrics", "/api/v1/export", "/report"])
def test_a_cookie_from_a_foreign_origin_is_refused_on_data_routes(client, gw_token, path):
    """Defence in depth behind CORS: a cross-origin fetch() cannot READ the response
    today, but the cookie is still being attached and honoured, which is one
    misconfigured header away from a leak and is already enough for a state-changing
    request. Bind it to this origin."""
    _with_cookie(client, gw_token)
    assert client.get(path, headers={"origin": FOREIGN}).status_code == 401


def test_a_cookie_from_this_origin_still_works(client, gw_token):
    # Same-origin fetches from the dashboard (POST/preflight-shaped ones carry Origin).
    _with_cookie(client, gw_token)
    assert client.get("/metrics", headers={"origin": "http://testserver"}).status_code == 200


def test_a_header_token_works_from_any_origin(client, auth_headers):
    """The CLI and the desktop shell are NOT browsers and are not CSRF-reachable: they
    had to read ~/.cheaper/dash.token to send this at all. An embedded shell can also
    legitimately present an exotic Origin. Never gate the header on Origin."""
    assert client.get("/metrics", headers={**auth_headers, "origin": FOREIGN}).status_code == 200
    assert client.get("/metrics", headers={**auth_headers, "origin": "null"}).status_code == 200


def test_a_query_token_works_from_any_origin(client, gw_token):
    # `cheaper dashboard` opens /dashboard?token=…; a caller that can send this already
    # knows the secret, so Origin is irrelevant.
    assert client.get("/metrics", params={"token": gw_token},
                      headers={"origin": FOREIGN}).status_code == 200


def test_self_origins_covers_the_configured_port_and_the_real_one(monkeypatch):
    """Two sources, because either alone is wrong: CHEAPER_PORT is what the CLI
    launches uvicorn on, and the Host header is the only place the port ACTUALLY in use
    shows up when someone ran `uvicorn --port 9000` by hand."""
    import auth
    monkeypatch.setenv("CHEAPER_PORT", "8787")

    class _Req:
        headers = {"host": "localhost:9000"}

    o = auth.self_origins(_Req())
    assert "http://localhost:8787" in o and "http://127.0.0.1:8787" in o
    assert "http://localhost:9000" in o          # the port it is really serving on
    assert "http://localhost:9999" not in o      # the attacker's

    class _Evil:
        headers = {"host": "evil.example.com:80"}

    # A Host the app does not trust never contributes an origin (TrustedHostMiddleware
    # 400s it first, but origin_is_self must not depend on that ordering).
    assert "http://evil.example.com:80" not in auth.self_origins(_Evil())


def test_a_deliberately_exposed_gateway_keeps_its_own_origin():
    """CHEAPER_ALLOWED_HOSTS=* means the operator turned Host checking off on purpose
    (it goes with CHEAPER_HOST). The origin check must then not silently kill the live
    /ws socket on the very address they chose to serve — it cannot be the last line of
    defence for a config that explicitly removed the first one."""
    import app as app_module
    import auth

    class _Lan:
        headers = {"host": "192.168.1.5:8787"}

    # Default config: a non-loopback Host contributes nothing.
    assert "http://192.168.1.5:8787" not in auth.self_origins(_Lan())
    try:
        auth.set_trusted_hostnames(["*"])
        assert "http://192.168.1.5:8787" in auth.self_origins(_Lan())
    finally:
        # Module-level state: restore or every later test inherits it.
        auth.set_trusted_hostnames(app_module._ALLOWED_HOSTS)
    assert "http://192.168.1.5:8787" not in auth.self_origins(_Lan())


# ---------------------------------------------------------------------------
# Fail CLOSED on a token file that exists but is unusable.
#
# `check()` used to `return True` — an unauthenticated pass on EVERY gated route —
# whenever current_token() was None, and current_token() is None for a present-but-EMPTY
# file, not only for the read-only-home case the policy was written for. O_EXCL then
# meant ensure_token could never repair it: the file exists, so the mint was skipped on
# every start, forever. A zero-byte dash.token was a permanent, silent auth bypass.
# ---------------------------------------------------------------------------

def _hex64(s: str) -> bool:
    return len(s) == 64 and all(c in "0123456789abcdef" for c in s)


@pytest.mark.parametrize("content", ["", "   \n\t "])
def test_an_empty_token_file_fails_closed_and_is_repaired(client, monkeypatch, tmp_path,
                                                          content):
    """Zero-byte (a crash between the O_CREAT and the write, a truncating editor, a
    restored-empty backup) and whitespace-only both count as 'no secret'."""
    import stat as _stat
    p = tmp_path / "dash.token"
    p.write_text(content)
    monkeypatch.setenv("CHEAPER_TOKEN_FILE", str(p))

    # THE regression: this answered 200 with no credential at all.
    assert client.get("/metrics").status_code == 401
    # …and the file is repaired in place, atomically, 0600 — not left broken for the
    # next start to trip over again.
    tok = p.read_text(encoding="utf-8").strip()
    assert _hex64(tok), repr(tok)
    mode = os.stat(p).st_mode
    assert not (mode & (_stat.S_IRWXG | _stat.S_IRWXO)), oct(mode)
    assert _stat.S_ISREG(mode)
    # The repaired secret is the live one.
    assert client.get("/metrics", headers={"x-cheaper-token": tok}).status_code == 200
    # No temp file left behind next to it.
    assert [q.name for q in tmp_path.iterdir()] == ["dash.token"]


def test_an_unusable_non_file_token_path_fails_closed_and_is_not_replaced(
        client, monkeypatch, tmp_path):
    """A token path that exists but is not a readable regular file (here: a directory;
    in the field: a file owned by another user, or one whose mode was clobbered) yields
    no secret and cannot be safely auto-replaced. It must refuse, not open."""
    p = tmp_path / "dash.token"
    p.mkdir()
    monkeypatch.setenv("CHEAPER_TOKEN_FILE", str(p))
    assert client.get("/metrics").status_code == 401
    assert p.is_dir(), "a token path we cannot inspect must never be silently replaced"
    # /healthz must not advertise an open gateway while the gate is in fact shut.
    assert client.get("/healthz").json()["auth_required"] is True


def test_a_dangling_symlink_token_path_fails_closed(client, monkeypatch, tmp_path):
    """Same bug as the zero-byte file, one indirection along: O_EXCL refuses to create
    over a dangling symlink (EEXIST), so no token can ever be minted there — and a
    `Path.exists()` presence check follows the link, reports "absent", and hands that
    state the fail-OPEN branch."""
    p = tmp_path / "dash.token"
    p.symlink_to(tmp_path / "gone")
    monkeypatch.setenv("CHEAPER_TOKEN_FILE", str(p))
    assert client.get("/metrics").status_code == 401
    assert p.is_symlink(), "a token path we cannot interpret must not be replaced"


def test_an_uncreatable_token_still_degrades_to_the_documented_fail_open(
        client, monkeypatch, tmp_path):
    """The case the fail-open policy was actually written for: no token file exists and
    none can be created (a read-only home, an exotic sandbox). Bricking the owner's own
    dashboard is worse than the exposure this guards, and the loopback bind still
    holds. Modelled here by a parent path that is a file, so no uid can create it."""
    blocker = tmp_path / "not-a-directory"
    blocker.write_text("x")
    monkeypatch.setenv("CHEAPER_TOKEN_FILE", str(blocker / "dash.token"))
    assert client.get("/metrics").status_code == 200
    assert client.get("/healthz").json()["auth_required"] is False
