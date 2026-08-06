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
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse

from router import RouterConfig, decide, extract_text
from metrics import Metrics, normalize_effort


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


@app.get("/healthz")
async def healthz():
    return {"ok": True, "mode": MODE, "upstream": UPSTREAM, "models": CFG.models}


@app.get("/metrics")
async def metrics(request: Request):
    # ?session=<id> scopes the summary to one chat — what `cheaper peek --tagline`
    # requests so the end-of-chat line reports EXACT per-conversation savings.
    session = request.query_params.get("session")
    return JSONResponse(await asyncio.to_thread(METRICS.summary, session=session))


@app.get("/peek")
async def peek():
    """Serve the historical `peek` report that the CLI / desktop refresh to
    ~/.cheaper/peek.json. Returns {available:false} until one has been generated."""
    try:
        return JSONResponse(json.loads(_PEEK_JSON.read_text()))
    except Exception:
        return JSONResponse({"available": False})


@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard():
    try:
        return HTMLResponse(_DASH_PATH.read_text(encoding="utf-8"))
    except Exception:
        return HTMLResponse(_DASHBOARD_HTML)  # inline fallback


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    """Push a fresh metrics summary on connect, on every routed request, and at
    least every 5s. Send-only; the client never sends frames back."""
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
    source = request.headers.get("x-cheaper-source") or request.headers.get("user-agent", "")[:60]
    # Optional chat id the client forwards so per-chat savings can be attributed
    # exactly (the end-of-chat tagline). Absent for clients that don't send it.
    session = request.headers.get("x-cheaper-session") or request.headers.get("x-session-id") or ""

    if request.headers.get("x-router-bypass", "").lower() in ("1", "true", "yes"):
        return await _forward(ANTHROPIC_MSG_URL, raw, headers, request)

    try:
        body = json.loads(raw)
    except Exception:
        return await _forward(ANTHROPIC_MSG_URL, raw, headers, request)

    original_model = body.get("model")
    from router import requested_tier as _req_tier
    req_tier = _req_tier(body, CFG)
    triage_tier = await _triage_tier(body, headers) if MODE == "triage" else None
    decision = decide(body, CFG, triage_tier=triage_tier)
    body["model"] = decision.model
    new_raw = json.dumps(body).encode()
    text_len = len(extract_text(body))

    extra = {
        "x-router-tier": decision.tier,
        "x-router-model": decision.model,
        "x-router-original-model": str(original_model),
        "x-router-reason": decision.reason[:300],
    }
    resp, usage = await _forward(ANTHROPIC_MSG_URL, new_raw, headers, request,
                                 extra_response_headers=extra,
                                 stream=bool(body.get("stream")), want_usage=True)
    METRICS.record(
        tier=decision.tier, model=decision.model, original_model=str(original_model),
        requested_tier=str(req_tier), reason=decision.reason, source=source,
        in_tokens=usage.get("input_tokens") or (text_len // 4),
        out_tokens=usage.get("output_tokens") or 0,
        status=usage.get("status", 0), requested_effort=_extract_effort(body),
        session=session)
    _notify_metrics()
    return resp


async def _forward(url, raw, headers, request, extra_response_headers=None,
                   stream=False, want_usage=False):
    usage: dict = {}
    if stream:
        req = _client.build_request("POST", url, headers=headers, content=raw)
        upstream = await _client.send(req, stream=True)
        usage["status"] = upstream.status_code
        resp_headers = {k: v for k, v in upstream.headers.items()
                        if k.lower() not in _HOP_BY_HOP}
        if extra_response_headers:
            resp_headers.update(extra_response_headers)

        async def body_iter():
            async for chunk in upstream.aiter_raw():
                yield chunk
            await upstream.aclose()

        resp = StreamingResponse(body_iter(), status_code=upstream.status_code,
                                 headers=resp_headers,
                                 media_type=upstream.headers.get("content-type"))
        return (resp, usage) if want_usage else resp

    upstream = await _client.post(url, headers=headers, content=raw)
    usage["status"] = upstream.status_code
    if want_usage:
        try:
            u = json.loads(upstream.content).get("usage", {}) or {}
            # Anthropic: input/output_tokens ; OpenAI: prompt/completion_tokens
            usage["input_tokens"] = u.get("input_tokens") or u.get("prompt_tokens")
            usage["output_tokens"] = u.get("output_tokens") or u.get("completion_tokens")
        except Exception:
            pass
    resp_headers = {k: v for k, v in upstream.headers.items()
                    if k.lower() not in _HOP_BY_HOP}
    if extra_response_headers:
        resp_headers.update(extra_response_headers)
    resp = Response(content=upstream.content, status_code=upstream.status_code,
                    headers=resp_headers,
                    media_type=upstream.headers.get("content-type"))
    return (resp, usage) if want_usage else resp


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """OpenAI-compatible front-end. Same routing logic, but resolves the chosen tier
    to an OpenAI model id and forwards to the OpenAI upstream — so any tool that lets
    you set an OpenAI base URL (Codex, Cursor, Copilot, OpenCode, …) routes too."""
    raw = await request.body()
    headers = _fwd_headers(request)
    source = (request.headers.get("x-cheaper-source")
              or request.headers.get("user-agent", "")[:52]) + " (openai)"
    session = request.headers.get("x-cheaper-session") or request.headers.get("x-session-id") or ""

    if request.headers.get("x-router-bypass", "").lower() in ("1", "true", "yes"):
        return await _forward(OPENAI_CHAT_URL, raw, headers, request)
    try:
        body = json.loads(raw)
    except Exception:
        return await _forward(OPENAI_CHAT_URL, raw, headers, request)

    original_model = body.get("model")
    decision = decide(body, CFG, models=OPENAI_MODELS)
    body["model"] = decision.model
    new_raw = json.dumps(body).encode()
    text_len = len(extract_text(body))
    extra = {
        "x-router-tier": decision.tier,
        "x-router-model": decision.model,
        "x-router-original-model": str(original_model),
        "x-router-reason": decision.reason[:300],
    }
    resp, usage = await _forward(OPENAI_CHAT_URL, new_raw, headers, request,
                                 extra_response_headers=extra,
                                 stream=bool(body.get("stream")), want_usage=True)
    METRICS.record(
        tier=decision.tier, model=decision.model, original_model=str(original_model),
        requested_tier="", reason=decision.reason, source=source,
        in_tokens=usage.get("input_tokens") or (text_len // 4),
        out_tokens=usage.get("output_tokens") or 0, status=usage.get("status", 0),
        requested_effort=_extract_effort(body), session=session)
    _notify_metrics()
    return resp


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
