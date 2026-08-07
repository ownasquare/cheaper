"""Cheaper — an Anthropic-compatible model-routing gateway with built-in monitoring.

Point your client's ANTHROPIC_BASE_URL at this service. Every /v1/messages request
is inspected, routed to the cheapest capable tier (escalating on hard categories),
forwarded to the real Anthropic API, and recorded so you can SEE routing working.

Run:
    uvicorn app.app:app --host 0.0.0.0 --port 8787
Then:
    export ANTHROPIC_BASE_URL=http://localhost:8787
Monitor:
    open http://localhost:8787/dashboard   (or GET /metrics for JSON)
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

import auth
import export_fmt
import reporting
import store
from auth import require_token
from router import RouterConfig, decide, extract_text
from metrics import Metrics, normalize_effort


# ---- ingest sanitization ---------------------------------------------------
# `x-cheaper-source` and the model ids are raw, client-controlled strings that reach
# storage, the Logs view, and the report payload. A newline in `source` is a JSONL
# line-injection primitive once the per-call event log lands; a control char can
# corrupt a log line or a terminal. Strip control chars, restrict to a safe charset,
# and cap the length at ingest — never let a client header shape a stored line.
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")
_SOURCE_RE = re.compile(r"[^A-Za-z0-9._:/()+ -]")


def _sanitize_source(s) -> str:
    return _SOURCE_RE.sub("", _CTRL_RE.sub("", str(s or "")))[:64]


def _sanitize_model(m) -> str:
    return _CTRL_RE.sub("", str(m or ""))[:128]


def _harden_perms() -> None:
    """~/.cheaper holds a complete record of the user's AI usage. It was created 0755
    with world-readable 0644 files, so any other local user or process could read it.
    Tighten the dir to 0700 and the sensitive files to 0600. Best-effort, idempotent."""
    base = Path(os.path.expanduser("~")) / ".cheaper"
    try:
        if base.is_dir():
            os.chmod(base, 0o700)
        for name in ("metrics.db", "lifetime.json", "peek.json", "dash.token"):
            p = base / name
            if p.exists():
                os.chmod(p, 0o600)
    except Exception:
        pass


def _extract_effort(body: dict) -> str:
    """The reasoning effort the caller REQUESTED (measure-only — never modified).
    Handles OpenAI reasoning_effort / reasoning.effort and Anthropic extended thinking."""
    if not isinstance(body, dict):
        return "none"
    re = body.get("reasoning_effort")
    if re:
        return normalize_effort(re)
    r = body.get("reasoning")
    if isinstance(r, dict) and r.get("effort"):
        return normalize_effort(r.get("effort"))
    th = body.get("thinking")
    if isinstance(th, dict) and (th.get("type") == "enabled" or th.get("budget_tokens")):
        bt = th.get("budget_tokens") or 0
        return "high" if bt >= 8000 else "medium" if bt >= 2000 else "low"
    return "none"

UPSTREAM = os.environ.get("ANTHROPIC_UPSTREAM_URL", "https://api.anthropic.com").rstrip("/")


def _config_from_env() -> RouterConfig:
    cfg = RouterConfig()
    cfg.models = {
        "haiku": os.environ.get("ROUTER_MODEL_HAIKU", cfg.models["haiku"]),
        "sonnet": os.environ.get("ROUTER_MODEL_SONNET", cfg.models["sonnet"]),
        "opus": os.environ.get("ROUTER_MODEL_OPUS", cfg.models["opus"]),
    }
    cfg.allow_upgrade_above_requested = os.environ.get(
        "ROUTER_ALLOW_UPGRADE", "false").lower() in ("1", "true", "yes")
    cfg.min_tier = os.environ.get("ROUTER_MIN_TIER", cfg.min_tier)
    try:
        cfg.long_request_chars = int(os.environ.get("ROUTER_LONG_CHARS", cfg.long_request_chars))
    except ValueError:
        pass
    return cfg


CFG = _config_from_env()
MODE = os.environ.get("ROUTER_MODE", "heuristic").lower()  # heuristic | triage
METRICS = Metrics()

# --- Live push: one asyncio.Event per connected /ws client, set on each routed
#     request so the dashboard updates in real time (5s heartbeat as a fallback).
_ws_events: set[asyncio.Event] = set()


def _notify_metrics() -> None:
    for ev in list(_ws_events):
        ev.set()


_PEEK_JSON = Path(os.path.expanduser("~")) / ".cheaper" / "peek.json"
_DASH_PATH = Path(__file__).resolve().parent / "dashboard.html"

# OpenAI-compatible front-end (for Codex/Cursor/Copilot/OpenCode/… — any tool that
# points its OpenAI base URL here). Set these to models your account actually has.
OPENAI_UPSTREAM = os.environ.get("OPENAI_UPSTREAM_URL", "https://api.openai.com").rstrip("/")
OPENAI_MODELS = {
    "haiku": os.environ.get("OPENAI_MODEL_CHEAP", "gpt-4o-mini"),
    "sonnet": os.environ.get("OPENAI_MODEL_MID", "gpt-4o"),
    "opus": os.environ.get("OPENAI_MODEL_TOP", "o3"),
}
ANTHROPIC_MSG_URL = f"{UPSTREAM}/v1/messages"
OPENAI_CHAT_URL = f"{OPENAI_UPSTREAM}/v1/chat/completions"

app = FastAPI(title="cheaper-gateway")

# Reject requests whose Host header is not a loopback name. Paired with the loopback
# bind (cli/src/gateway.js), this is defence-in-depth against DNS-rebinding: a page
# that resolves its own domain to 127.0.0.1 still cannot read the dashboard/logs
# because the browser sends the attacker's Host and Starlette 400s it. `testserver`
# is the TestClient's host (not routable). Override CHEAPER_ALLOWED_HOSTS only when
# you deliberately expose the gateway with CHEAPER_HOST.
_ALLOWED_HOSTS = [h.strip() for h in os.environ.get(
    "CHEAPER_ALLOWED_HOSTS", "localhost,127.0.0.1,::1,testserver").split(",") if h.strip()]
if "*" not in _ALLOWED_HOSTS:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=_ALLOWED_HOSTS)

# Mint the same-machine token BEFORE hardening perms, so a first run creates the file
# 0600 and the chmod sweep then confirms it. Doing it at import means the CLI/desktop
# can read the secret the instant /healthz answers, with no start-up race.
auth.ensure_token()
_harden_perms()

_client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0))

_HOP_BY_HOP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding"}


def _fwd_headers(request: Request) -> dict:
    return {k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP}


async def _triage_tier(body: dict, headers: dict) -> str | None:
    text = extract_text(body)[:6000]
    prompt = ("Classify this request for a model router. Reply with ONE word only: "
              "haiku (simple), sonnet (moderate), or opus (hard/correctness-critical: "
              "concurrency, security, proofs, hard debugging, high-stakes, dense "
              f"synthesis).\n\nREQUEST:\n{text}")
    payload = {"model": CFG.models["haiku"], "max_tokens": 5,
               "messages": [{"role": "user", "content": prompt}]}
    try:
        r = await _client.post(f"{UPSTREAM}/v1/messages", headers=headers, json=payload)
        r.raise_for_status()
        out = "".join(b.get("text", "") for b in r.json().get("content", [])).lower()
        for tier in ("opus", "sonnet", "haiku"):
            if tier in out:
                return tier
    except Exception:
        return None
    return None


def _code_sha() -> str:
    """Fingerprint of the code this process actually IMPORTED.

    Python holds modules in memory from import time, so a gateway started before an
    upgrade keeps serving the old logic even though every file on disk is correct --
    and `cheaper install` cannot fix it, because the bytes were already right. That
    exact situation shipped wrong dollar figures on the one path that prints them
    with no hedge, and the only clue was a missing key in a JSON payload.

    Serving a digest here makes the mismatch mechanically detectable: the CLI hashes
    the same files on disk and compares. Must stay in lock-step with
    gatewayCodeHash()/GATEWAY_CODE in cli/src/freshness.js -- same file set, same
    ordering, same digest -- or the comparison silently always-differs.
    """
    import hashlib

    here = Path(__file__).resolve().parent
    h = hashlib.sha256()
    # `.html` is included: dashboard.html and report.html are read off disk and served,
    # so an edit to either changes what users see. Leaving them out meant every check
    # reported "current" while both templates were stale in the installed gateway.
    names = sorted(p.name for p in here.iterdir()
                   if p.is_file() and p.suffix in (".py", ".json", ".html"))
    for name in names:
        h.update(f"app/{name}".encode())
        h.update(b"\0")
        try:
            h.update((here / name).read_bytes())
        except Exception:
            h.update(b"UNREADABLE")
        h.update(b"\0")
    return h.hexdigest()[:16]


CODE_SHA = _code_sha()


@app.get("/healthz")
async def healthz():
    # Deliberately UNAUTHENTICATED: `cheaper status`, `waitUntilServing`, the desktop's
    # waitForGateway and every freshness check poll this before they could know a token,
    # and it discloses no usage data. `auth_required` lets a client tell "this build
    # wants a token" apart from "this build predates tokens" without guessing.
    return {"ok": True, "mode": MODE, "upstream": UPSTREAM, "models": CFG.models,
            # The build actually running, so `cheaper status` can prove freshness
            # instead of the user having to remember to restart.
            "code_sha": CODE_SHA,
            "auth_required": bool(auth.current_token()),
            "token_private": auth.token_is_private()}


@app.get("/metrics", dependencies=[Depends(require_token)])
async def metrics(request: Request):
    # ?session=<id> scopes the summary to one chat — what `cheaper peek --tagline`
    # requests so the end-of-chat line reports EXACT per-conversation savings.
    session = request.query_params.get("session")
    return JSONResponse(await asyncio.to_thread(METRICS.summary, session=session))


@app.get("/peek", dependencies=[Depends(require_token)])
async def peek():
    """Serve the historical `peek` report that the CLI / desktop refresh to
    ~/.cheaper/peek.json. Returns {available:false} until one has been generated."""
    try:
        return JSONResponse(json.loads(_PEEK_JSON.read_text()))
    except Exception:
        return JSONResponse({"available": False})


@app.get("/logs", dependencies=[Depends(require_token)])
async def logs(request: Request):
    """Paginated routing-decision log for the dashboard Logs table.

    Query params: limit (default 100, capped 1000), offset (default 0), and an
    optional session to scope to one chat (mirrors /metrics semantics: absent = whole
    ledger; present = that chat, including the empty-session bucket). Returns
    {"rows": [...], "total": N} with rows ordered most-recent-first."""
    qp = request.query_params
    try:
        limit = int(qp.get("limit", 100))
    except (TypeError, ValueError):
        limit = 100
    try:
        offset = int(qp.get("offset", 0))
    except (TypeError, ValueError):
        offset = 0
    session = qp.get("session")  # None when the param is absent -> whole ledger
    return JSONResponse(await asyncio.to_thread(
        METRICS.logs, limit=limit, offset=offset, session=session))


_REPORT_PATH = Path(__file__).resolve().parent / "report.html"


@app.get("/report", response_class=HTMLResponse, dependencies=[Depends(require_token)])
async def report():
    """A print-ready savings report with its data EMBEDDED, not fetched.

    Embedding matters for the PDF paths. `webContents.printToPDF` and the browser's
    own print dialog both capture whatever is rendered at the moment they fire; a page
    that fetches its data on load can be captured mid-flight and produce a PDF full of
    empty tables. With the JSON inlined there is nothing to race.
    """
    summary = await asyncio.to_thread(METRICS.summary)
    summary["code_sha"] = CODE_SHA
    try:
        html = _REPORT_PATH.read_text(encoding="utf-8")
    except Exception:
        return HTMLResponse("<h1>report.html is missing from this gateway build</h1>",
                            status_code=500)
    # `</script>` anywhere inside the payload would close the host <script> tag early,
    # so escape the characters that can break out. Model ids and tool names are
    # user-influenced, which makes this an injection boundary, not just tidiness.
    payload = (json.dumps(summary, default=str)
               .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))
    return HTMLResponse(html.replace("__REPORT_DATA__", payload))


# The page a browser gets when it reaches /dashboard without the local token.
#
# `Depends(require_token)` is deliberately NOT used on this one route. It raises an
# HTTPException, which FastAPI renders as `{"detail": "..."}` — so a user who bookmarked
# http://localhost:8787/dashboard was met with a wall of raw JSON. The route stays just
# as gated (status 401, no data, and none of the real dashboard's markup is served); it
# simply answers a human in HTML instead of answering a machine in JSON.
_AUTH_WALL_HTML = """<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Cheaper — this dashboard needs its local token</title>
<style>
/* --muted is 5.3:1 on --card in dark and 5.1:1 in light: this is the product's failure
   screen, so it must not also be its least legible one. */
:root{--bg:#0a0a0c;--card:#141418;--line:#212127;--text:#f2f2f5;--muted:#9a9aa4;--green:#34d399}
@media (prefers-color-scheme: light){
  :root{--bg:#f6f6f8;--card:#fff;--line:#e4e4ea;--text:#18181b;--muted:#5b616e;--green:#047857}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  padding:24px;background:var(--bg);color:var(--text);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:560px;background:var(--card);border:1px solid var(--line);
  border-radius:14px;padding:26px 28px}
h1{margin:0 0 14px;font-size:1.2rem;letter-spacing:-0.01em}
h1 span{color:var(--green)}
p{margin:0 0 13px;color:var(--muted);font-size:0.9rem}
code{background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:1px 5px;
  font-size:0.85rem;color:var(--text)}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:13px 15px;
  margin:0 0 14px;overflow-x:auto}
pre code{border:none;background:none;padding:0;font-size:0.92rem}
</style>
<main>
  <h1>Cheap<span>er</span> — this dashboard needs its local token</h1>
  <p>The gateway keeps a complete, per-call record of your AI usage, so it only answers
     requests that carry the secret in <code>~/.cheaper/dash.token</code>. That stops
     another account or process on this machine from reading it over loopback.</p>
  <p>Reopen it with the token attached:</p>
  <pre><code>cheaper dashboard</code></pre>
  <p>Nothing is sent anywhere — the token never leaves this machine, and neither does
     any of the data behind it.</p>
</main>
"""


@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard(request: Request):
    # The page itself is gated, not just its data: an unauthenticated /dashboard would
    # hand an attacker the markup, and (worse) any future inlined bootstrap payload.
    if not auth.check(request):
        return HTMLResponse(_AUTH_WALL_HTML, status_code=401,
                            headers={"WWW-Authenticate": 'Bearer realm="cheaper"'})
    try:
        resp = HTMLResponse(_DASH_PATH.read_text(encoding="utf-8"))
    except Exception:
        resp = HTMLResponse(_DASHBOARD_HTML)  # inline fallback
    # Issue the session cookie to a caller that ALREADY held the token. The page then
    # scrubs the secret out of its own URL, and a plain browser reload still
    # authenticates — without a cookie, Cmd-R on the dashboard landed on the auth wall,
    # because the server cannot see the sessionStorage copy the page keeps.
    auth.set_session_cookie(resp)
    return resp


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    """Push a fresh metrics summary on connect, on every routed request, and at
    least every 5s. Send-only; the client never sends frames back."""
    # A WebSocket carries exactly the payload /metrics does, so it needs the same gate.
    # Depends() cannot 401 a websocket, so check by hand and close with RFC-6455 1008
    # (policy violation) BEFORE accepting — an accepted-then-closed socket would already
    # have leaked the first frame.
    if not auth.check(websocket):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    ev = asyncio.Event()
    _ws_events.add(ev)
    try:
        while True:
            payload = await asyncio.to_thread(METRICS.summary)
            await websocket.send_json({"type": "metrics", **payload})
            try:
                await asyncio.wait_for(ev.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass
            ev.clear()
    except (WebSocketDisconnect, RuntimeError):
        pass
    except Exception:
        pass
    finally:
        _ws_events.discard(ev)


@app.post("/v1/messages")
async def messages(request: Request):
    raw = await request.body()
    headers = _fwd_headers(request)
    source = _sanitize_source(request.headers.get("x-cheaper-source") or request.headers.get("user-agent", "")[:60])
    # Optional chat id the client forwards so per-chat savings can be attributed
    # exactly (the end-of-chat tagline). Absent for clients that don't send it.
    session = request.headers.get("x-cheaper-session") or request.headers.get("x-session-id") or ""

    if request.headers.get("x-router-bypass", "").lower() in ("1", "true", "yes"):
        return await _forward(ANTHROPIC_MSG_URL, raw, headers, request)

    try:
        body = json.loads(raw)
    except Exception:
        return await _forward(ANTHROPIC_MSG_URL, raw, headers, request)

    original_model = _sanitize_model(body.get("model"))
    from router import requested_tier as _req_tier
    req_tier = _req_tier(body, CFG)
    triage_tier = await _triage_tier(body, headers) if MODE == "triage" else None
    decision = decide(body, CFG, triage_tier=triage_tier)
    body["model"] = decision.model
    new_raw = json.dumps(body).encode()

    extra = {
        "x-router-tier": decision.tier or "passthrough",
        "x-router-model": decision.model,
        "x-router-original-model": str(original_model),
        "x-router-reason": decision.reason[:300],
    }
    effort = _extract_effort(body)

    def _record(u: dict) -> None:
        METRICS.record(
            tier=decision.tier or "passthrough", model=decision.model,
            original_model=str(original_model),
            requested_tier=str(req_tier), reason=decision.reason, source=source,
            # NULL, not a character-count guess. `len(extract_text(body)) // 4`
            # substituted the whole conversation's size for the FRESH input count --
            # measured wrong by ~34,000x against real traffic -- and it printed with no
            # hedge. A row with unknown usage is now stored as unknown and excluded from
            # every dollar figure by row_is_priceable().
            in_tokens=u.get("input_tokens"),
            cache_read=u.get("cache_read") or 0,
            cache_create_5m=u.get("cache_create_5m") or 0,
            cache_create_1h=u.get("cache_create_1h") or 0,
            out_tokens=u.get("output_tokens"),
            status=u.get("status", 0), requested_effort=effort,
            session=session,
            request_id=u.get("request_id"), message_id=u.get("message_id"),
            usage_source=u.get("usage_source"))
        _notify_metrics()

    resp, usage = await _forward(ANTHROPIC_MSG_URL, new_raw, headers, request,
                                 extra_response_headers=extra,
                                 stream=bool(body.get("stream")), want_usage=True,
                                 on_complete=_record)
    return resp


# The provider's own idempotency key, from the upstream response headers. It is 1:1
# with the API call (measured: 0 of 5,127 request ids mapped to more than one message
# id across 12,741 rows) and it SURVIVES a resume, a fork and a transcript rotation --
# which is exactly why the event store keys on it rather than on a positional index or
# a content hash. `_HOP_BY_HOP` does not strip any of these, so they are in scope in
# BOTH branches of _forward.
_RID_HEADERS = ("anthropic-request-id", "request-id", "x-request-id")


def _request_id(upstream) -> str | None:
    for h in _RID_HEADERS:
        v = upstream.headers.get(h)
        if v:
            return _sanitize_model(v)  # same charset/length clamp: it reaches storage
    return None


def _usage_from_body(u: dict) -> dict:
    """Normalise one provider usage block into the six-way token split we price on.

    Returns ONLY the fields this block actually reported. That is load-bearing for the
    streaming path: Anthropic splits usage across `message_start` (the input side,
    including the cache split) and `message_delta` (the running output count). A
    `message_delta` says nothing about cache reads, so defaulting its cache fields to 0
    and merging would ERASE the 45,702 cache-read tokens `message_start` reported --
    re-pricing the whole call as fresh input at 10x the real rate. Absent means absent.
    """
    out: dict = {}
    # Anthropic: input/output_tokens ; OpenAI: prompt/completion_tokens.
    # `is None` rather than `or`: a genuine 0 is a measured value, and `or` would
    # silently promote it to the next fallback.
    it = u.get("input_tokens")
    if it is None:
        it = u.get("prompt_tokens")
    if it is not None:
        out["input_tokens"] = it
    ot = u.get("output_tokens")
    if ot is None:
        ot = u.get("completion_tokens")
    if ot is not None:
        out["output_tokens"] = ot
    # Prompt-cache split. Without it every input token is billed as FRESH, and a cache
    # read costs a tenth of fresh input -- so on a Claude Code session, where most input
    # is cache reads, the gateway was computing its (unhedged) dollar figures from a
    # small minority of the real billing shape. Anthropic reports the 5m/1h write
    # breakdown under `cache_creation`; OpenAI reports cached input under
    # prompt_tokens_details.cached_tokens.
    cc = u.get("cache_creation") or {}
    det = u.get("prompt_tokens_details") or {}
    cr = u.get("cache_read_input_tokens")
    if cr is None:
        cr = det.get("cached_tokens")
    if cr is not None:
        out["cache_read"] = cr
    if "ephemeral_1h_input_tokens" in cc:
        out["cache_create_1h"] = cc.get("ephemeral_1h_input_tokens") or 0
    if "ephemeral_5m_input_tokens" in cc:
        out["cache_create_5m"] = cc.get("ephemeral_5m_input_tokens") or 0
    elif u.get("cache_creation_input_tokens") is not None:
        # Older payloads report only the total; treat the remainder as 5m, the cheaper
        # of the two write rates, so an unknown split never OVER-states the bill.
        out["cache_create_5m"] = max(
            0, (u.get("cache_creation_input_tokens") or 0)
            - (cc.get("ephemeral_1h_input_tokens") or 0))
    return out


_SSE_MAX_LINE = 1 << 20   # 1 MB: no legitimate SSE data line approaches this


class _SseUsageSniffer:
    """Reads provider usage out of a Server-Sent-Events stream WITHOUT altering it.

    This is not an optimisation -- it is the difference between the gateway measuring
    anything at all and measuring nothing. Claude Code always streams, and the streaming
    branch previously parsed no usage whatsoever, so every streamed call was stored with
    a character-count guess for `input_tokens` and a hard 0 for output. On the live DB
    that left 76 rows with 4 non-zero outputs and 0 cache reads.

    Anthropic splits usage across two events: `message_start` carries the input side
    (and the message id), `message_delta` carries the running output count -- the LAST
    one wins, because it is cumulative. OpenAI sends a single terminal chunk with a
    top-level `usage` object when `stream_options.include_usage` is set.

    Bytes are forwarded untouched; this only observes. A malformed or truncated stream
    leaves `usage_source` at 'estimate', which excludes the row from every dollar
    figure rather than contributing a half-parsed number.
    """

    __slots__ = ("_buf", "usage", "message_id", "saw_body", "overflowed")

    def __init__(self):
        self._buf = b""
        self.usage: dict = {}
        self.message_id = None
        self.saw_body = False
        self.overflowed = False

    def feed(self, chunk: bytes) -> None:
        try:
            self._buf += chunk
            while True:
                nl = self._buf.find(b"\n")
                if nl < 0:
                    # Guard against a pathological single line growing without bound.
                    if len(self._buf) > _SSE_MAX_LINE:
                        self._buf = b""
                        self.overflowed = True
                    return
                line = self._buf[:nl]
                self._buf = self._buf[nl + 1:]
                self._line(line)
        except Exception:
            # Observation must never be able to break the proxied response.
            self._buf = b""

    def _line(self, line: bytes) -> None:
        line = line.strip()
        if not line.startswith(b"data:"):
            return
        payload = line[5:].strip()
        if not payload or payload == b"[DONE]":
            return
        try:
            obj = json.loads(payload.decode("utf-8", "replace"))
        except Exception:
            return
        if not isinstance(obj, dict):
            return
        typ = obj.get("type")
        if typ == "message_start":
            msg = obj.get("message") or {}
            if isinstance(msg, dict):
                if msg.get("id"):
                    self.message_id = _sanitize_model(msg.get("id"))
                u = msg.get("usage")
                if isinstance(u, dict):
                    self._merge(_usage_from_body(u))
        elif typ == "message_delta":
            u = obj.get("usage")
            if isinstance(u, dict):
                # message_delta.usage.output_tokens is CUMULATIVE, so the last one wins.
                self._merge(_usage_from_body(u))
        else:
            # OpenAI terminal chunk: {..., "usage": {...}} with no Anthropic `type`.
            u = obj.get("usage")
            if isinstance(u, dict):
                self._merge(_usage_from_body(u))
            if obj.get("id") and not self.message_id:
                self.message_id = _sanitize_model(obj.get("id"))

    def _merge(self, u: dict) -> None:
        # `u` carries only the fields this event actually reported (see
        # _usage_from_body), so a later event can never blank an earlier one's counts.
        for k, v in u.items():
            if v is None:
                continue
            if k == "output_tokens":
                # message_delta.usage.output_tokens is CUMULATIVE. max() is both
                # correct and immune to events arriving out of order.
                self.usage[k] = max(int(v or 0), int(self.usage.get(k) or 0))
            else:
                self.usage[k] = v
            self.saw_body = True


async def _forward(url, raw, headers, request, extra_response_headers=None,
                   stream=False, want_usage=False, on_complete=None):
    """Proxy one call upstream.

    `on_complete(usage)` is invoked EXACTLY ONCE with the final usage dict. For a
    buffered response that is before returning; for a streamed one it is after the last
    byte has been relayed -- which is the only moment the token counts exist. The
    callers used to record immediately, so every streamed call was written with an
    empty usage dict no matter what the provider reported.
    """
    usage: dict = {}
    fired = False

    def _fire():
        nonlocal fired
        if fired or on_complete is None:
            return
        fired = True
        try:
            on_complete(usage)
        except Exception:
            pass  # metrics must never break the proxied response

    if stream:
        req = _client.build_request("POST", url, headers=headers, content=raw)
        upstream = await _client.send(req, stream=True)
        usage["status"] = upstream.status_code
        usage["request_id"] = _request_id(upstream)
        usage["usage_source"] = "estimate"
        resp_headers = {k: v for k, v in upstream.headers.items()
                        if k.lower() not in _HOP_BY_HOP}
        if extra_response_headers:
            resp_headers.update(extra_response_headers)

        sniffer = _SseUsageSniffer()

        async def body_iter():
            try:
                async for chunk in upstream.aiter_raw():
                    sniffer.feed(chunk)
                    yield chunk
            finally:
                # Runs on normal completion AND on client disconnect (GeneratorExit),
                # so a cancelled request still books whatever the provider had already
                # reported instead of vanishing from the ledger.
                try:
                    await upstream.aclose()
                except Exception:
                    pass
                if sniffer.saw_body:
                    usage.update(sniffer.usage)
                    usage["usage_source"] = "body"
                if sniffer.message_id:
                    usage["message_id"] = sniffer.message_id
                _fire()

        resp = StreamingResponse(body_iter(), status_code=upstream.status_code,
                                 headers=resp_headers,
                                 media_type=upstream.headers.get("content-type"))
        return (resp, usage) if want_usage else resp

    upstream = await _client.post(url, headers=headers, content=raw)
    usage["status"] = upstream.status_code
    usage["request_id"] = _request_id(upstream)
    usage["usage_source"] = "estimate"
    if want_usage:
        try:
            parsed = json.loads(upstream.content)
            u = (parsed.get("usage") or {}) if isinstance(parsed, dict) else {}
            if isinstance(parsed, dict) and parsed.get("id"):
                usage["message_id"] = _sanitize_model(parsed.get("id"))
            if u:
                usage.update(_usage_from_body(u))
                # 'body' only when the provider actually reported a token count. A
                # present-but-empty usage object is not a measurement.
                if u.get("input_tokens") is not None or u.get("output_tokens") is not None \
                        or u.get("prompt_tokens") is not None or u.get("completion_tokens") is not None:
                    usage["usage_source"] = "body"
        except Exception:
            pass
    resp_headers = {k: v for k, v in upstream.headers.items()
                    if k.lower() not in _HOP_BY_HOP}
    if extra_response_headers:
        resp_headers.update(extra_response_headers)
    resp = Response(content=upstream.content, status_code=upstream.status_code,
                    headers=resp_headers,
                    media_type=upstream.headers.get("content-type"))
    _fire()
    return (resp, usage) if want_usage else resp


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """OpenAI-compatible front-end. Same routing logic, but resolves the chosen tier
    to an OpenAI model id and forwards to the OpenAI upstream — so any tool that lets
    you set an OpenAI base URL (Codex, Cursor, Copilot, OpenCode, …) routes too."""
    raw = await request.body()
    headers = _fwd_headers(request)
    source = _sanitize_source((request.headers.get("x-cheaper-source")
              or request.headers.get("user-agent", "")[:52])) + " (openai)"
    session = request.headers.get("x-cheaper-session") or request.headers.get("x-session-id") or ""

    if request.headers.get("x-router-bypass", "").lower() in ("1", "true", "yes"):
        return await _forward(OPENAI_CHAT_URL, raw, headers, request)
    try:
        body = json.loads(raw)
    except Exception:
        return await _forward(OPENAI_CHAT_URL, raw, headers, request)

    original_model = _sanitize_model(body.get("model"))
    decision = decide(body, CFG, models=OPENAI_MODELS)
    body["model"] = decision.model
    new_raw = json.dumps(body).encode()
    extra = {
        "x-router-tier": decision.tier or "passthrough",
        "x-router-model": decision.model,
        "x-router-original-model": str(original_model),
        "x-router-reason": decision.reason[:300],
    }
    effort = _extract_effort(body)

    def _record(u: dict) -> None:
        METRICS.record(
            tier=decision.tier or "passthrough", model=decision.model,
            original_model=str(original_model),
            requested_tier="", reason=decision.reason, source=source,
            in_tokens=u.get("input_tokens"),
            cache_read=u.get("cache_read") or 0,
            cache_create_5m=u.get("cache_create_5m") or 0,
            cache_create_1h=u.get("cache_create_1h") or 0,
            out_tokens=u.get("output_tokens"), status=u.get("status", 0),
            requested_effort=effort, session=session,
            request_id=u.get("request_id"), message_id=u.get("message_id"),
            usage_source=u.get("usage_source"))
        _notify_metrics()

    resp, usage = await _forward(OPENAI_CHAT_URL, new_raw, headers, request,
                                 extra_response_headers=extra,
                                 stream=bool(body.get("stream")), want_usage=True,
                                 on_complete=_record)
    return resp


# ===========================================================================
# /api/v1 — the reporting + export namespace
# ===========================================================================
#
# DECLARED BEFORE the `/{path:path}` catch-all below, because route order decides:
# FastAPI matches in registration order, and the catch-all would otherwise proxy every
# one of these to api.anthropic.com.
#
# EVERY route here takes `dependencies=[Depends(require_token)]`. These serve the
# user's complete per-call AI-usage record — the most sensitive file the product owns —
# and `tests/test_auth.py::test_every_data_route_declares_the_dependency` asserts it
# structurally, so a new route that forgets the gate fails the suite the moment it is
# written rather than the moment it is exploited.
#
# All the numbers come from reporting.py, which prices every row exactly once through
# store.derive_row. These endpoints therefore cannot disagree with each other, and none
# of them ever adds a `measured` figure to an `estimated` one.

def _api_envelope(f: dict, unified: dict) -> dict:
    """What every /api/v1 response carries so it is reproducible from itself."""
    return {
        "filters": reporting.echo_filters(f),
        "catalog": {"as_of": pricing_as_of(), "digest": store.catalog_digest()},
        "read": unified["read_stats"],
        "fold": unified["fold_stats"],
        "gateway": {"rows": unified["gateway_total"],
                    "truncated": unified["gateway_truncated"],
                    "excluded": unified["gateway_excluded"]},
        "code_sha": CODE_SHA,
    }


def pricing_as_of():
    try:
        from pricing import CATALOG_AS_OF
        return CATALOG_AS_OF
    except Exception:
        return None


@app.get("/api/v1/logs", dependencies=[Depends(require_token)])
async def api_logs(request: Request):
    """Keyset-paged fold rows.

    Keyset, not offset: offset degrades linearly AND skips or duplicates rows when new
    traffic lands mid-scroll. The count is capped at 20,000 and reported as "20000+" —
    an honest cap beats a wrong exact number.

    `basis` (measured/estimated) and `grain` (call/chat) are NON-HIDEABLE on every row,
    together with `unpriced_reason`, so a row that makes no dollar claim says so instead
    of rendering as $0.00.
    """
    qp = request.query_params

    def work():
        f = reporting.parse_filters(qp)
        u = reporting.unified_rows(METRICS)
        views = reporting.matching_views(u["rows"], f)
        page = reporting.keyset_page(views, f["cursor"], f["limit"], f["sort"])
        out = {
            "rows": page["rows"],
            "next_cursor": page["next_cursor"],
            "has_more": page["has_more"],
            "count": reporting.honest_count(len(views)),
            "count_capped": len(views) > reporting.COUNT_CAP,
            "grain": "call",
        }
        out.update(_api_envelope(f, u))
        return out

    return JSONResponse(await asyncio.to_thread(work))


@app.get("/api/v1/reports/periods", dependencies=[Depends(require_token)])
async def api_report_periods(request: Request):
    """The DISJOINT ladder — Today · Earlier this week · … · Before this year.

    These PARTITION history, so they sum to lifetime. The old nested "since" ladder did
    not, which is why six rows with a Saved column could be added to six times today.
    Each row carries `measured` and `estimated` SEPARATELY, its `labels`, its `notes`
    and the literal printed local bounds.
    """
    qp = request.query_params

    def work():
        f = reporting.parse_filters(qp)
        u = reporting.unified_rows(METRICS)
        rows = reporting.filtered_rows(u["rows"], f, apply_window=False)
        st = store.load_state()
        out = {"tz": str(periods_zone(f["tz"])),
               "periods": reporting.report_periods(rows, f["tz"], state=st),
               # Computed as ONE window over the whole range, NOT as a sum of the ladder
               # rows, so a bug in the ladder shows up as a disagreement with the total
               # instead of being reproduced inside it.
               "lifetime": reporting.lifetime_window(rows, f["tz"], state=st),
               # The frozen chat-grain store: a THIRD visual state, never an addend to
               # either basis. Chat grain and call grain are not commensurable.
               "legacy": reporting.legacy_block(),
               # Period-over-period, with `events` on both sides so a 400% jump on three
               # events reads as noise.
               "comparisons": reporting.report_comparisons(rows, f["tz"], state=st),
               "coverage": reporting.coverage_label(st),
               "grain": "call"}
        out.update(_api_envelope(f, u))
        return out

    return JSONResponse(await asyncio.to_thread(work))


def periods_zone(tz):
    import periods as _p
    return _p.zone(tz)


@app.get("/api/v1/reports/breakdown", dependencies=[Depends(require_token)])
async def api_report_breakdown(request: Request):
    qp = request.query_params

    def work():
        f = reporting.parse_filters(qp)
        dim = qp.get("dim") or "served"
        u = reporting.unified_rows(METRICS)
        rows = reporting.filtered_rows(u["rows"], f, apply_window=False)
        out = {"dim": dim if dim in ("served", "base", "tier", "harness", "decision")
               else "served",
               "groups": reporting.report_breakdown(rows, dim, f["from"], f["to"]),
               "grain": "call"}
        out.update(_api_envelope(f, u))
        return out

    return JSONResponse(await asyncio.to_thread(work))


@app.get("/api/v1/reports/trend", dependencies=[Depends(require_token)])
async def api_report_trend(request: Request):
    qp = request.query_params

    def work():
        f = reporting.parse_filters(qp)
        bucket = qp.get("bucket") or "day"
        u = reporting.unified_rows(METRICS)
        rows = reporting.filtered_rows(u["rows"], f, apply_window=False)
        out = {"bucket": bucket if bucket in ("day", "week", "month") else "day",
               "points": reporting.report_trend(rows, bucket, f["from"], f["to"]),
               "grain": "call"}
        out.update(_api_envelope(f, u))
        return out

    return JSONResponse(await asyncio.to_thread(work))


def _export_payload(qp):
    """Build the audit header and the ordered export rows.

    The row SET is in memory because the reconciliation fold is inherently whole-set,
    and the integrity digest has to be taken over the exact rows in the exact order
    they are emitted. The export BYTES are never materialised: the writers below are
    generators and StreamingResponse consumes them one row at a time.
    """
    f = reporting.parse_filters(qp)
    fmt = (qp.get("format") or "csv").lower()
    if fmt not in ("csv", "tsv", "json", "ndjson"):
        fmt = "csv"
    guard = "raw" if (qp.get("guard") or "").lower() == "raw" else "safe"
    preamble = (qp.get("preamble") or "1") != "0"

    u = reporting.unified_rows(METRICS)
    views = reporting.matching_views(u["rows"], f)
    # `limit` defaults to 100 for the paged Logs view; an EXPORT that silently stopped
    # at 100 rows would be the worst possible artefact, so the cap only applies when the
    # caller asked for one.
    cap = f["limit"] if qp.get("limit") else reporting.COUNT_CAP
    exported = views[:cap]
    rows = [export_fmt.export_row(v) for v in exported]
    digest = export_fmt.row_digest(rows)
    meta = reporting.audit_meta(
        period_label=qp.get("period") or "custom range",
        from_ms=f["from"], to_ms=f["to"], tz=f["tz"], filters=f,
        rows_exported=len(rows), rows_matching=len(views),
        truncated=len(views) > len(rows), guard_mode=guard, digest=digest,
        build=CODE_SHA, fmt=fmt)
    meta["read"] = u["read_stats"]
    meta["fold"] = u["fold_stats"]
    meta["gateway_excluded"] = u["gateway_excluded"]
    return f, fmt, guard, preamble, meta, rows


@app.get("/api/v1/export", dependencies=[Depends(require_token)])
async def api_export(request: Request):
    """Streamed download. CSV/TSV carry a UTF-8 BOM and the ~45-line audit header
    (`preamble=0` suppresses it); `guard=raw` gives the lossless copy."""
    qp = request.query_params
    f, fmt, guard, preamble, meta, rows = await asyncio.to_thread(_export_payload, qp)
    filename = reporting.export_filename(qp.get("period") or "range", fmt)
    return StreamingResponse(
        export_fmt.stream(fmt, meta, rows, mode=guard, preamble=preamble),
        media_type=export_fmt.MEDIA_TYPES[fmt],
        headers={
            # `filename` is built through export_fmt.safe_filename, which reduces the
            # value to [A-Za-z0-9._-]: a quote or a newline here is a response-header
            # injection, and the period label is caller-supplied.
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Cheaper-Row-Digest": meta["integrity"]["row_digest"],
            "Cache-Control": "no-store",
        })


@app.get("/api/v1/report.html", response_class=HTMLResponse,
         dependencies=[Depends(require_token)])
async def api_report_html(request: Request):
    """The standalone print-optimised report — the PDF source.

    Its data is EMBEDDED in a `<script type="application/json">` block, never fetched.
    `webContents.printToPDF` and the browser's own print dialog both capture whatever is
    rendered at the instant they fire, so a page that fetches on load can be captured
    mid-flight and produce a PDF full of empty tables. With the JSON inlined there is
    nothing to race.

    NOTE on the rendered periods table: report.html is not modified by this change, so
    its "Savings by period" block still renders the NESTED `summary().periods` under its
    own printed caveat that those windows nest. The DISJOINT ladder, split by basis,
    travels in `report.periods` for the surfaces that read it.
    """
    qp = request.query_params

    def work():
        f = reporting.parse_filters(qp)
        u = reporting.unified_rows(METRICS)
        rows = reporting.filtered_rows(u["rows"], f, apply_window=False)
        st = store.load_state()
        views = reporting.matching_views(u["rows"], f)
        export_rows = [export_fmt.export_row(v) for v in views[:reporting.COUNT_CAP]]
        payload = METRICS.summary()
        payload["code_sha"] = CODE_SHA
        payload["report"] = {
            "meta": reporting.audit_meta(
                period_label=qp.get("period") or "custom range",
                from_ms=f["from"], to_ms=f["to"], tz=f["tz"], filters=f,
                rows_exported=len(export_rows), rows_matching=len(views),
                truncated=len(views) > len(export_rows),
                guard_mode="raw", digest=export_fmt.row_digest(export_rows),
                build=CODE_SHA, fmt="html", state=st),
            "periods": reporting.report_periods(rows, f["tz"], state=st),
            "breakdown": {d: reporting.report_breakdown(rows, d, f["from"], f["to"])
                          for d in ("served", "base", "tier", "harness", "decision")},
            "trend": reporting.report_trend(rows, "day", f["from"], f["to"]),
            "grain": "call",
        }
        return payload

    payload = await asyncio.to_thread(work)
    try:
        html = _REPORT_PATH.read_text(encoding="utf-8")
    except Exception:
        return HTMLResponse("<h1>report.html is missing from this gateway build</h1>",
                            status_code=500)
    # `</script>` anywhere inside the payload would close the host <script> tag early.
    # Model ids, harness names and routing reasons are user-influenced strings that
    # reach this payload, so this is an INJECTION BOUNDARY, not tidiness.
    body = (json.dumps(payload, default=str)
            .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))
    return HTMLResponse(html.replace("__REPORT_DATA__", body))


@app.api_route("/{path:path}", methods=["GET", "POST", "DELETE", "PUT", "PATCH"])
async def passthrough(path: str, request: Request):
    raw = await request.body()
    headers = _fwd_headers(request)
    url = f"{UPSTREAM}/{path}"
    upstream = await _client.request(request.method, url, headers=headers,
                                     content=raw, params=dict(request.query_params))
    resp_headers = {k: v for k, v in upstream.headers.items()
                    if k.lower() not in _HOP_BY_HOP}
    return Response(content=upstream.content, status_code=upstream.status_code,
                    headers=resp_headers,
                    media_type=upstream.headers.get("content-type"))


_DASHBOARD_HTML = """<!doctype html><html><head><meta charset=utf-8>
<title>Cheaper - monitor</title><meta name=viewport content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0b0b0d;--card:#141417;--fg:#ececf0;--mut:#8a8a94;--amber:#ff8a34;--line:#26262c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:28px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);margin-bottom:22px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.k{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.v{font-size:26px;font-weight:650;margin-top:6px}.amber{color:var(--amber)}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:600}.pill{padding:2px 8px;border-radius:999px;font-size:12px}
.haiku{background:#0e3b2e;color:#5eead4}.sonnet{background:#0e2a4d;color:#7cc0ff}.opus{background:#3b1020;color:#ff9db0}
.bar{height:8px;border-radius:6px;background:#26262c;overflow:hidden;margin-top:8px}
.bar>i{display:block;height:100%;background:var(--amber)}
</style></head><body>
<h1>Cheaper <span style=color:var(--amber)>monitor</span></h1>
<div class=sub>Live routing decisions flowing through the gateway. Refreshes every 3s.</div>
<div class=grid id=cards></div>
<div class=card><div class=k>Recent decisions</div>
<table id=recent><thead><tr><th>time</th><th>tier</th><th>requested</th><th>why</th><th>source</th></tr></thead><tbody></tbody></table></div>
<script>
async function tick(){
 const m=await (await fetch('/metrics')).json();
 const t=m.by_tier||{};
 const c=document.getElementById('cards');
 c.innerHTML=`
  <div class=card><div class=k>Total routed</div><div class=v>${m.total}</div></div>
  <div class=card><div class=k>Downgrade rate</div><div class="v amber">${m.downgrade_rate}%</div>
   <div class=bar><i style="width:${m.downgrade_rate}%"></i></div></div>
  <div class=card><div class=k>Est. savings</div><div class="v amber">${m.est_savings_pct}%</div>
   <div class=k style=margin-top:4px>${m.est_savings_units} units vs all-top-tier</div></div>
  <div class=card><div class=k>Haiku / Sonnet / Opus</div><div class=v>${(t.haiku||{}).count||0} / ${(t.sonnet||{}).count||0} / ${(t.opus||{}).count||0}</div></div>`;
 const tb=document.querySelector('#recent tbody');
 tb.innerHTML=(m.recent||[]).map(r=>`<tr>
   <td>${new Date(r.ts*1000).toLocaleTimeString()}</td>
   <td><span class="pill ${r.tier}">${r.tier}</span></td>
   <td>${r.original_model||''}</td><td>${r.reason||''}</td><td>${r.source||''}</td></tr>`).join('');
}
tick();setInterval(tick,3000);
</script></body></html>"""
