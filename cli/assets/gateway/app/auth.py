"""Same-machine authentication for the Cheaper gateway's DATA and UI routes.

Why this exists even though the gateway binds to loopback:

    loopback bind        stops other HOSTS on the network      (shipped)
    TrustedHostMiddleware stops DNS-rebinding from a remote page (shipped)
    this module          stops other USERS/PROCESSES on THIS machine

`GET localhost:8787/metrics` from any other account on a shared Mac, or from any
process the user did not start, returns a complete per-call record of their AI
usage. Once the event store is authoritative that record is the product's whole
value; it is also the most sensitive file the product owns. Loopback is not a
trust boundary on a multi-user machine.

The token is a 32-byte secret at ``~/.cheaper/dash.token`` mode 0600. Every
legitimate opener (``cheaper dashboard``, the desktop shell, the CLI's own
fetches) can read that file; nothing else on the box can. It is accepted as the
``x-cheaper-token`` header or the ``token`` query parameter -- the query form is
required because a browser navigating to ``/dashboard`` cannot set a header.

Deliberate non-goals: this is not a defence against a process running AS the
user (it can read the file), and it is not a network auth scheme. It closes the
same-machine, different-principal hole and nothing more.
"""

from __future__ import annotations

import hmac
import os
import secrets
import stat
import threading
from pathlib import Path

from fastapi import HTTPException, Request

# Routes that must stay open:
#   /healthz  — liveness + code_sha. `cheaper status`, `waitUntilServing`, the desktop's
#               waitForGateway and every freshness check poll it BEFORE they could
#               possibly know a token, and it discloses no usage data.
#   /v1/*     — the proxy itself. Clients point ANTHROPIC_BASE_URL here; requiring a
#               token would break every routed call, and those requests already carry
#               the user's own provider credentials.
_TOKEN_LOCK = threading.Lock()
_CACHE: dict = {"path": None, "mtime_ns": None, "value": None}


def token_path() -> Path:
    """Where the secret lives. ``CHEAPER_TOKEN_FILE`` overrides for tests and for
    alternate profiles, mirroring how ``CHEAPER_PEEK_HOME`` isolates the CLI."""
    override = os.environ.get("CHEAPER_TOKEN_FILE")
    if override:
        return Path(override)
    return Path(os.path.expanduser("~")) / ".cheaper" / "dash.token"


def _read(p: Path):
    try:
        raw = p.read_text(encoding="utf-8").strip()
    except Exception:
        return None
    return raw or None


def ensure_token() -> str | None:
    """Return the shared secret, minting it on first use.

    Returns None only when the token can neither be read nor written (a read-only
    home, an exotic sandbox). Callers translate that into *fail open with a
    warning* rather than *fail closed*: bricking a user's own dashboard because a
    file could not be created would be a worse outcome than the exposure this
    guards, and the loopback bind is still in force underneath.
    """
    p = token_path()
    existing = _read(p)
    if existing:
        return existing
    tok = secrets.token_hex(32)  # 32 random BYTES -> 64 hex chars
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(p.parent, 0o700)
        except Exception:
            pass
        # O_EXCL so two processes racing on first launch cannot each believe they
        # minted the live token; the loser re-reads the winner's value.
        fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, tok.encode("utf-8"))
        finally:
            os.close(fd)
        return tok
    except FileExistsError:
        return _read(p)
    except Exception:
        return None


def current_token() -> str | None:
    """Cached read of the token file, invalidated by mtime+path so a rotated token
    takes effect without a restart (and a test that points CHEAPER_TOKEN_FILE at a
    fresh tmpdir is never served a stale cached value)."""
    p = token_path()
    try:
        st = os.stat(p)
        key = st.st_mtime_ns
    except Exception:
        st, key = None, None
    with _TOKEN_LOCK:
        if _CACHE["path"] == str(p) and _CACHE["mtime_ns"] == key and _CACHE["value"]:
            return _CACHE["value"]
    val = _read(p) or ensure_token()
    with _TOKEN_LOCK:
        _CACHE["path"] = str(p)
        try:
            _CACHE["mtime_ns"] = os.stat(p).st_mtime_ns
        except Exception:
            _CACHE["mtime_ns"] = None
        _CACHE["value"] = val
    return val


def token_is_private() -> bool:
    """True when the token file is not group/world readable. Surfaced by /healthz so
    a permissions regression is visible rather than silent."""
    try:
        mode = os.stat(token_path()).st_mode
        return not (mode & (stat.S_IRWXG | stat.S_IRWXO))
    except Exception:
        return False


# The cookie the dashboard is issued after a successful tokened load.
#
# Why a cookie at all: the page strips the token out of its own URL (it gets
# screenshotted, pasted into issues, and left on screen during demos) and keeps it in
# sessionStorage. But the SERVER cannot see sessionStorage, so a plain browser reload —
# Cmd-R, or any same-tab navigation — arrived with no credential at all and was met with
# the auth wall. A cookie is the one mechanism the browser re-sends on a navigation the
# page did not initiate.
#
# HttpOnly     script on the page cannot read it back out, so an injected script cannot
#              exfiltrate the secret even though the page is authenticated.
# SameSite=Strict  never sent on ANY cross-site request, including a top-level
#              navigation from another origin. That is what makes it safe to gate GET
#              routes on: a malicious page cannot navigate the user to
#              localhost:8787/api/v1/export and have the browser attach it.
# Path=/       every gated route, and nothing outside this origin.
# No Secure flag: the gateway is plain http on loopback by design.
COOKIE_NAME = "cheaper_token"


def presented(request: Request) -> str:
    """The token the caller presented: header, then cookie, then query string.

    Header first because that is what the CLI sends and it keeps the secret out of the
    access log. Cookie before query so a reload keeps working after the page has
    scrubbed its own URL.
    """
    return (request.headers.get("x-cheaper-token")
            or (request.cookies.get(COOKIE_NAME) if hasattr(request, "cookies") else None)
            or request.query_params.get("token")
            or "")


def check(request: Request) -> bool:
    want = current_token()
    if not want:
        # Could not read OR mint a secret. Fail open (see ensure_token) rather than
        # locking the owner out of their own machine's dashboard.
        return True
    got = presented(request)
    if not got:
        return False
    # Constant-time: a naive == leaks the shared prefix length to a local attacker
    # who can time thousands of requests against a loopback socket.
    return hmac.compare_digest(got, want)


async def require_token(request: Request) -> None:
    """FastAPI dependency. 401 with a WWW-Authenticate hint the CLI can act on."""
    if check(request):
        return
    raise HTTPException(
        status_code=401,
        detail=("This gateway serves your private AI-usage record and requires the "
                "local token at ~/.cheaper/dash.token. Open it with `cheaper dashboard`, "
                "or pass ?token=<contents> / the x-cheaper-token header."),
        headers={"WWW-Authenticate": 'Bearer realm="cheaper", charset="UTF-8"'},
    )


def set_session_cookie(response, token: str | None = None) -> None:
    """Issue the session cookie on a response that was itself authenticated.

    Called only from the /dashboard handler, and only after `check()` passed — so the
    cookie is never minted for a caller that did not already hold the secret.
    """
    tok = token or current_token()
    if not tok:
        return
    response.set_cookie(
        COOKIE_NAME, tok,
        httponly=True, samesite="strict", path="/",
        # Session cookie: it dies with the browser, matching the sessionStorage copy the
        # page keeps. A persistent cookie would outlive a token rotation.
        max_age=None, expires=None,
    )


__all__ = ["ensure_token", "current_token", "require_token", "check", "token_path",
           "presented", "token_is_private", "set_session_cookie", "COOKIE_NAME"]
