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

A browser session is additionally issued the ``cheaper_token`` cookie so a plain
reload keeps working (see COOKIE_NAME). Because a cookie is attached by the browser
rather than by the caller, it is the one credential that is CSRF-reachable, so it is
ORIGIN-BOUND: it authenticates only when the request's Origin is this gateway's own.
That is what stops a page on another http://localhost:<port> — which SameSite=Strict
considers same-site, because "site" ignores the port — from opening ws://…/ws and
streaming the whole usage record. See `origin_is_self`.

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


def token_file_present(p: Path | None = None) -> bool:
    """Is there a token file on disk AT ALL — readable or not?

    This is the distinction `check()` turns into fail-open vs fail-closed, so it must
    answer "a file is there" even when we cannot read a secret out of it (a zero-byte
    file, a whitespace-only file, a file owned by another user).

    lexists, NOT exists: a DANGLING SYMLINK at the token path is something, and
    O_EXCL refuses to create over it (EEXIST), so ensure_token can never mint there.
    `exists()` follows the link, reports False, and would have handed that state the
    fail-OPEN branch — the same bug as the zero-byte file, one indirection along.
    Both lstat and the enclosing except also answer False when the *parent* is
    unreachable, which is exactly the "no token could be created at all" case that
    fail-open is for.
    """
    p = p or token_path()
    try:
        return os.path.lexists(str(p))
    except Exception:
        return False


def _is_empty_token_file(p: Path) -> bool:
    """True for a regular file that exists but demonstrably holds no secret.

    Only the cases we can SEE are empty qualify: size 0, or readable whitespace. A
    file we cannot read (EACCES — it belongs to another user, or the mode was
    clobbered) is deliberately NOT auto-replaced: silently overwriting a token we
    cannot inspect is a worse failure than refusing, and `check()` fails closed on it.
    """
    try:
        st = os.stat(p)
    except Exception:
        return False
    if not stat.S_ISREG(st.st_mode):
        return False
    if st.st_size == 0:
        return True
    try:
        return not p.read_text(encoding="utf-8").strip()
    except Exception:
        return False


def _mint_over_empty(p: Path, tok: str) -> str | None:
    """Atomically replace a present-but-empty token file.

    O_EXCL alone can never repair one: the file EXISTS, so the mint below is skipped
    on every single start, forever. Before this, a zero-byte ``dash.token`` — a crash
    between the O_CREAT and the os.write, a truncating editor, a restored-empty
    backup — left `current_token()` returning None permanently, and the old
    `check()` read that as "no secret could be created" and let EVERY gated route
    through unauthenticated. Write to a sibling temp file 0600 and os.replace it, so
    the swap is atomic (a reader sees the old file or the new one, never a partial)
    and the repair actually sticks.
    """
    tmp = p.parent / f".{p.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
    try:
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, tok.encode("utf-8"))
        finally:
            os.close(fd)
        os.replace(str(tmp), str(p))
    except Exception:
        try:
            os.unlink(str(tmp))
        except Exception:
            pass
        return None
    # Two processes can repair concurrently and os.replace has no loser-detection, so
    # re-read: whatever landed on disk is the live secret and every process must agree
    # with it. (Same intent as the O_EXCL loser re-reading the winner's value.)
    return _read(p) or tok


def ensure_token() -> str | None:
    """Return the shared secret, minting it on first use.

    Returns None only when the token can neither be read nor written (a read-only
    home, an exotic sandbox). Callers translate that into *fail open with a
    warning* rather than *fail closed*: bricking a user's own dashboard because a
    file could not be created would be a worse outcome than the exposure this
    guards, and the loopback bind is still in force underneath.

    That fail-open policy is ONLY for "no token could be created". A token file that
    exists but yields no secret is a different thing entirely and must not be
    conflated with it — see `_mint_over_empty` (repair) and `check` (fail closed).
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
        # A present-but-empty file is treated as ABSENT and replaced in place; O_EXCL
        # would raise FileExistsError forever and never repair it.
        if _is_empty_token_file(p):
            return _mint_over_empty(p, tok)
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
# SameSite=Strict  never sent on a cross-SITE request, including a top-level
#              navigation from another origin. That stops evil.example from
#              navigating the user to localhost:8787/api/v1/export.
#
#              It is NOT, on its own, enough to make cookie-gating safe, and the
#              paragraph that used to claim so was wrong in two ways:
#                * "site" is computed as eTLD+1 and IGNORES THE PORT, so every
#                  http://localhost:<any-port> page is SAME-SITE with this gateway and
#                  the browser attaches the cookie to its requests;
#                * WebSockets are not subject to CORS, so a page on any other
#                  localhost port could open ws://localhost:8787/ws, have the browser
#                  attach this cookie, and stream the victim's complete per-call usage
#                  record back to itself. Nothing in the same-origin policy stops it.
#              Hence `origin_is_self()` below: the cookie authenticates only when the
#              request's Origin is this gateway's own. See its docstring for the
#              precondition and the exact threat model.
# Path=/       every gated route, and nothing outside this origin.
# No Secure flag: the gateway is plain http on loopback by design.
COOKIE_NAME = "cheaper_token"

# ---- origin binding --------------------------------------------------------
#
# THREAT: a page the user visits on ANY other http://localhost:<port> (a dev server, a
# local docs site, a `npx` scratch app, anything they were talked into opening) is
# same-SITE with this gateway, so SameSite=Strict does not hold the cookie back. That
# page cannot READ a cross-origin fetch response (no CORS headers are sent), but a
# WebSocket is exempt from CORS entirely: ws://localhost:8787/ws would be accepted, the
# browser would attach cheaper_token, and every metrics frame — the whole usage record —
# would be delivered to the attacker's JS.
#
# PRECONDITION (why this is a real bug and not a theoretical one): the cheaper_token
# cookie has to already exist in that browser profile, i.e. the user has opened the
# dashboard at least once in the same browser. That is the normal state for anyone
# using the product, and the cookie is a session cookie, so "has opened the dashboard
# in this browser session" is the whole bar.
#
# DEFENCE: bind the cookie to this gateway's own origin. A browser sets Origin itself
# and a page cannot forge it; a browser also cannot forge Host. Anything that presents
# the cookie from another origin is refused.
#
# Deliberately NOT applied to a token presented as a header or a query param: those
# are not CSRF-reachable (the caller had to know the secret) and they are what the CLI,
# the desktop shell and `cheaper dashboard` use — several of which send no Origin at
# all, and a shell-embedded page may legitimately send a non-http one.
_LOOPBACK_ORIGIN_HOSTS = ("localhost", "127.0.0.1")

# What TrustedHostMiddleware is enforcing in app.py. app.py pushes its list in at
# import so the two can never drift; the loopback names are always included because a
# custom CHEAPER_ALLOWED_HOSTS must never be able to *shrink* the set of origins the
# real dashboard is served from.
_TRUSTED_HOSTNAMES: set[str] = set(_LOOPBACK_ORIGIN_HOSTS)
_TRUST_ANY_HOST = False


def set_trusted_hostnames(names) -> None:
    """Told by app.py what Host values the app accepts, so `origin_is_self` can trust
    the Host header it derives an origin from.

    A `*` entry means the operator switched Host checking OFF on purpose
    (CHEAPER_ALLOWED_HOSTS=*, which goes with CHEAPER_HOST for a deliberately exposed
    gateway). Honour that here too: refusing to derive an origin from the Host would
    silently kill the live /ws socket on the very address they chose to serve, and the
    origin binding still holds — the Origin must equal the host the browser actually
    connected to. It cannot be the last line of defence for a configuration that
    explicitly removed the first one.
    """
    global _TRUSTED_HOSTNAMES, _TRUST_ANY_HOST
    vals = [str(n).strip() for n in (names or []) if str(n).strip()]
    _TRUST_ANY_HOST = "*" in vals
    _TRUSTED_HOSTNAMES = {v.lower() for v in vals} | set(_LOOPBACK_ORIGIN_HOSTS)


def _hostname_of(netloc: str) -> str:
    """Host without the port. Handles the bracketed IPv6 literal form (`[::1]:8787`),
    which a plain split(':') would mangle."""
    if netloc.startswith("["):
        end = netloc.find("]")
        return netloc[1:end] if end != -1 else netloc
    return netloc.split(":", 1)[0]


def self_origins(request) -> set[str]:
    """Every serialization of THIS gateway's own origin.

    Two independent sources, because either alone gets it wrong:

      * CHEAPER_PORT (default 8787) — what `cheaper gateway start` launches uvicorn on,
        and the value the desktop/CLI build their URLs from.
      * the request's own Host header — the only place the port ACTUALLY in use shows
        up when someone ran `uvicorn --port 9000` by hand or a shell picked a free
        port. A browser cannot forge Host, and TrustedHostMiddleware has already
        rejected any Host that is not an allowed name, so this is safe to derive from —
        and leaving it out would fail closed on a legitimate user's own dashboard,
        which is exactly the outcome the fail-open policy elsewhere exists to avoid.
    """
    port = (os.environ.get("CHEAPER_PORT") or "8787").strip()
    out = {f"http://{h}:{port}" for h in _LOOPBACK_ORIGIN_HOSTS}
    host = (request.headers.get("host") or "").strip().lower()
    if host and (_TRUST_ANY_HOST or _hostname_of(host) in _TRUSTED_HOSTNAMES):
        # Both schemes: the page is served over plain http today, but dashboard.html
        # already builds wss:// when it finds itself on https (someone terminating TLS
        # in front of the gateway), and that origin is still this same gateway.
        out.add(f"http://{host}")
        out.add(f"https://{host}")
    return out


def origin_is_self(request) -> bool:
    """True unless the caller is demonstrably a DIFFERENT web origin.

    Absent Origin => True. That is not a hole: a browser always sends Origin on a
    WebSocket handshake and on every cross-origin fetch, so absence means either a
    non-browser client (the CLI, `curl`, the desktop shell — none of which have the
    cookie unless they read the token file, at which point they are already the user)
    or a same-origin top-level GET navigation, which is precisely the plain browser
    reload the cookie exists to keep working.

    "null" (a sandboxed iframe, a file:// page) is NOT this gateway and is refused.
    """
    raw = request.headers.get("origin")
    if not raw:
        return True
    return raw.strip().lower().rstrip("/") in self_origins(request)


def presented_with_kind(request: Request) -> tuple[str, str]:
    """(token, how-it-was-presented) — "header" | "cookie" | "query" | "".

    The KIND matters: only the cookie is attached by the browser automatically, so
    only the cookie needs the origin binding above. Splitting it out here keeps that
    decision in one place instead of re-sniffing headers at each call site.
    """
    tok = request.headers.get("x-cheaper-token")
    if tok:
        return tok, "header"
    ck = request.cookies.get(COOKIE_NAME) if hasattr(request, "cookies") else None
    if ck:
        return ck, "cookie"
    q = request.query_params.get("token")
    if q:
        return q, "query"
    return "", ""


def presented(request: Request) -> str:
    """The token the caller presented: header, then cookie, then query string.

    Header first because that is what the CLI sends and it keeps the secret out of the
    access log. Cookie before query so a reload keeps working after the page has
    scrubbed its own URL.
    """
    return presented_with_kind(request)[0]


def enforcing() -> bool:
    """True when the gate is actually refusing unauthenticated callers.

    Not the same as `bool(current_token())`: a present-but-unusable token file gives no
    secret yet still enforces (fail closed, see `check`). /healthz reports THIS, so
    `auth_required` never advertises an open gateway that is in fact shut.
    """
    return bool(current_token()) or token_file_present()


def check(request: Request) -> bool:
    want = current_token()
    if not want:
        if token_file_present():
            # A token file EXISTS but yields no secret: zero-byte, whitespace-only, or
            # unreadable because it belongs to another user. FAIL CLOSED. This used to
            # return True here — an unauthenticated pass on every gated route — because
            # it could not tell this apart from "no token could be created". A
            # zero-byte dash.token was therefore a permanent, silent auth bypass:
            # O_EXCL meant ensure_token could never repair the file, so every
            # subsequent start reproduced it. ensure_token now repairs the empty case
            # (so this branch is mostly the unreadable one), and anything it could not
            # repair refuses rather than opens.
            return False
        # No token file at all and none could be created (a read-only home, an exotic
        # sandbox). Fail open (see ensure_token) rather than locking the owner out of
        # their own machine's dashboard; the loopback bind is still in force.
        return True
    got, kind = presented_with_kind(request)
    if not got:
        return False
    if kind == "cookie" and not origin_is_self(request):
        # The browser attached this on its own from another origin. See the origin
        # binding block above: SameSite=Strict ignores the port, so "another origin"
        # includes every other http://localhost:<port> page.
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
           "presented", "presented_with_kind", "token_is_private", "set_session_cookie",
           "COOKIE_NAME", "origin_is_self", "self_origins", "set_trusted_hostnames",
           "token_file_present", "enforcing"]
