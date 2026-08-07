"""Provider request-id capture, streamed-usage parsing, and the fail-closed price gate.

Three defects this pins shut, all of which produced confidently-wrong money:

1. Nobody read `anthropic-request-id`. It is the provider's own 1:1 idempotency key
   (0 of 5,127 mapped to more than one message id over 12,741 measured rows) and the
   only join key that survives a resume/fork/rotate. Without it the event store cannot
   dedupe, so replay = double count.
2. The streaming branch parsed no usage at all, and Claude Code always streams. Every
   streamed call was stored with `len(text)//4` for input (wrong by ~34,000x against
   real traffic) and a hard 0 for output -- then printed with no "about" hedge.
3. Retries and errors were priced. Claude Code retries 429/overloaded automatically
   and each retry gets a DISTINCT request id, so the provider key cannot collapse them;
   a six-retry storm booked six times the saving for one delivered answer.
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import httpx  # noqa: E402
import pytest  # noqa: E402

from metrics import Metrics, row_is_priceable  # noqa: E402


def _sse(events):
    async def agen():
        for e in events:
            yield e
    return agen()


@pytest.fixture()
def recorded(monkeypatch):
    """Capture what METRICS.record() is called with, instead of writing a DB."""
    import app as app_module
    calls = []
    monkeypatch.setattr(app_module.METRICS, "record", lambda **kw: calls.append(kw))
    return calls


def _client(monkeypatch, handler):
    import app as app_module
    monkeypatch.setattr(app_module, "_client",
                        httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    from fastapi.testclient import TestClient
    return TestClient(app_module.app)


# ---- buffered branch --------------------------------------------------------

def test_buffered_call_captures_request_id_message_id_and_body_usage(monkeypatch, recorded):
    def handler(request):
        return httpx.Response(
            200,
            headers={"anthropic-request-id": "req_011CdnovAk4tJuaQtChMPLea"},
            json={"id": "msg_abc123", "type": "message", "role": "assistant",
                  "content": [], "model": "claude-haiku-4-5",
                  "usage": {"input_tokens": 12, "output_tokens": 313,
                            "cache_read_input_tokens": 45702,
                            "cache_creation": {"ephemeral_1h_input_tokens": 100,
                                               "ephemeral_5m_input_tokens": 7}}})

    c = _client(monkeypatch, handler)
    r = c.post("/v1/messages",
               headers={"x-api-key": "t", "anthropic-version": "2023-06-01"},
               json={"model": "claude-opus-4-6", "max_tokens": 8,
                     "messages": [{"role": "user", "content": "What's 2+2?"}]})
    assert r.status_code == 200
    assert len(recorded) == 1
    kw = recorded[0]
    assert kw["request_id"] == "req_011CdnovAk4tJuaQtChMPLea"
    assert kw["message_id"] == "msg_abc123"
    assert kw["usage_source"] == "body"
    assert kw["in_tokens"] == 12 and kw["out_tokens"] == 313
    assert kw["cache_read"] == 45702
    assert kw["cache_create_1h"] == 100 and kw["cache_create_5m"] == 7


def test_missing_usage_stores_null_tokens_not_a_character_count(monkeypatch, recorded):
    # The old code wrote `len(extract_text(body)) // 4` here. A long conversation with
    # no reported usage would book millions of "fresh input" tokens that never existed.
    def handler(request):
        return httpx.Response(200, json={"id": "msg_x", "content": [],
                                         "model": "claude-haiku-4-5"})

    c = _client(monkeypatch, handler)
    long_prompt = "x" * 40000
    c.post("/v1/messages",
           headers={"x-api-key": "t", "anthropic-version": "2023-06-01"},
           json={"model": "claude-opus-4-6", "max_tokens": 8,
                 "messages": [{"role": "user", "content": long_prompt}]})
    kw = recorded[0]
    assert kw["in_tokens"] is None, "an unreported token count must be NULL, not a guess"
    assert kw["out_tokens"] is None
    assert kw["usage_source"] == "estimate"


def test_openai_style_request_id_header_is_read(monkeypatch, recorded):
    def handler(request):
        return httpx.Response(200, headers={"x-request-id": "req_openai_1"},
                              json={"id": "chatcmpl-9", "choices": [],
                                    "usage": {"prompt_tokens": 5, "completion_tokens": 7,
                                              "prompt_tokens_details": {"cached_tokens": 3}}})

    c = _client(monkeypatch, handler)
    c.post("/v1/chat/completions", headers={"authorization": "Bearer t"},
           json={"model": "gpt-4o", "max_tokens": 8,
                 "messages": [{"role": "user", "content": "whats 2+2"}]})
    kw = recorded[0]
    assert kw["request_id"] == "req_openai_1"
    assert kw["usage_source"] == "body"
    assert kw["in_tokens"] == 5 and kw["out_tokens"] == 7 and kw["cache_read"] == 3


# ---- streaming branch -------------------------------------------------------

ANTHROPIC_STREAM = [
    b'event: message_start\n'
    b'data: {"type":"message_start","message":{"id":"msg_stream_1","usage":'
    b'{"input_tokens":2,"cache_read_input_tokens":45702,'
    b'"cache_creation":{"ephemeral_5m_input_tokens":11,"ephemeral_1h_input_tokens":0},'
    b'"output_tokens":1}}}\n\n',
    b'event: content_block_delta\n'
    b'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
    b'event: message_delta\n'
    b'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},'
    b'"usage":{"output_tokens":150}}\n\n',
    b'event: message_delta\n'
    b'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":313}}\n\n',
    b'event: message_stop\ndata: {"type":"message_stop"}\n\n',
]


def test_streamed_call_is_measured_not_estimated(monkeypatch, recorded):
    def handler(request):
        return httpx.Response(200,
                              headers={"anthropic-request-id": "req_stream_9",
                                       "content-type": "text/event-stream"},
                              content=_sse(ANTHROPIC_STREAM))

    c = _client(monkeypatch, handler)
    r = c.post("/v1/messages",
               headers={"x-api-key": "t", "anthropic-version": "2023-06-01"},
               json={"model": "claude-opus-4-6", "max_tokens": 8, "stream": True,
                     "messages": [{"role": "user", "content": "What's 2+2?"}]})
    assert r.status_code == 200
    # The proxied bytes must be byte-identical -- the sniffer only observes.
    assert b"".join(ANTHROPIC_STREAM) == r.content
    assert len(recorded) == 1, "record must fire exactly once, after the stream ends"
    kw = recorded[0]
    assert kw["usage_source"] == "body"
    assert kw["request_id"] == "req_stream_9"
    assert kw["message_id"] == "msg_stream_1"
    assert kw["in_tokens"] == 2
    # message_delta.usage.output_tokens is CUMULATIVE: the LAST one is the total.
    assert kw["out_tokens"] == 313
    assert kw["cache_read"] == 45702
    assert kw["cache_create_5m"] == 11


def test_sse_split_across_arbitrary_chunk_boundaries_still_parses(monkeypatch, recorded):
    # A real socket does not deliver one SSE event per chunk. Feed it one byte at a
    # time: the line buffer must reassemble it exactly.
    whole = b"".join(ANTHROPIC_STREAM)
    pieces = [whole[i:i + 1] for i in range(len(whole))]

    def handler(request):
        return httpx.Response(200, headers={"content-type": "text/event-stream"},
                              content=_sse(pieces))

    c = _client(monkeypatch, handler)
    c.post("/v1/messages",
           headers={"x-api-key": "t", "anthropic-version": "2023-06-01"},
           json={"model": "claude-opus-4-6", "max_tokens": 8, "stream": True,
                 "messages": [{"role": "user", "content": "hi"}]})
    kw = recorded[0]
    assert kw["usage_source"] == "body" and kw["out_tokens"] == 313


def test_malformed_stream_degrades_to_estimate_never_a_partial_number(monkeypatch, recorded):
    def handler(request):
        return httpx.Response(200, headers={"content-type": "text/event-stream"},
                              content=_sse([b'data: {"type":"message_start"\n\n',
                                            b'data: not json at all\n\n']))

    c = _client(monkeypatch, handler)
    c.post("/v1/messages",
           headers={"x-api-key": "t", "anthropic-version": "2023-06-01"},
           json={"model": "claude-opus-4-6", "max_tokens": 8, "stream": True,
                 "messages": [{"role": "user", "content": "hi"}]})
    kw = recorded[0]
    assert kw["usage_source"] == "estimate"
    assert kw["in_tokens"] is None and kw["out_tokens"] is None


def test_openai_terminal_usage_chunk_is_read(monkeypatch, recorded):
    def handler(request):
        return httpx.Response(200, headers={"content-type": "text/event-stream"},
                              content=_sse([
                                  b'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"h"}}]}\n\n',
                                  b'data: {"id":"chatcmpl-1","choices":[],'
                                  b'"usage":{"prompt_tokens":9,"completion_tokens":21}}\n\n',
                                  b'data: [DONE]\n\n']))

    c = _client(monkeypatch, handler)
    c.post("/v1/chat/completions", headers={"authorization": "Bearer t"},
           json={"model": "gpt-4o", "stream": True,
                 "messages": [{"role": "user", "content": "hi"}]})
    kw = recorded[0]
    assert kw["usage_source"] == "body"
    assert kw["in_tokens"] == 9 and kw["out_tokens"] == 21


# ---- the fail-closed price gate --------------------------------------------

def test_row_is_priceable_rules():
    assert row_is_priceable(200, "body") == (True, "")
    assert row_is_priceable(204, "body") == (True, "")
    # UNKNOWN status (every pre-migration row) is priced, so the existing ledger does
    # not blank; a status the gateway actually observed is checked strictly.
    assert row_is_priceable(0, "body") == (True, "")
    assert row_is_priceable(None, "") == (True, "")
    assert row_is_priceable(429, "body") == (False, "non_2xx")
    assert row_is_priceable(500, "body") == (False, "non_2xx")
    assert row_is_priceable(200, "estimate") == (False, "estimated_usage")


def test_retry_storm_does_not_book_six_savings():
    with tempfile.TemporaryDirectory() as d:
        m = Metrics(db_path=os.path.join(d, "m.db"))
        for i in range(6):                     # five 429s then the real answer
            m.record(tier="haiku", model="claude-haiku-4-5",
                     original_model="claude-opus-5", requested_tier="opus", reason="s",
                     in_tokens=1_000_000, out_tokens=1_000_000,
                     status=429 if i < 5 else 200, usage_source="body",
                     request_id=f"req_{i}", session="c")
        s = m.summary(session="c")
        # opus-5 $30 vs haiku-4-5 ($1 + $5) = $24 saved -- ONCE, not six times.
        assert abs(s["dollars"]["saved"] - 24.0) < 1e-6, s["dollars"]
        assert s["counts"]["unpriced"]["non_2xx"] == 5
        assert s["counts"]["priced"] == 1
        assert s["counts"]["examined"] == 6


def test_estimated_rows_contribute_no_dollars_and_are_counted():
    with tempfile.TemporaryDirectory() as d:
        m = Metrics(db_path=os.path.join(d, "m.db"))
        m.record(tier="haiku", model="claude-haiku-4-5", original_model="claude-opus-5",
                 requested_tier="opus", reason="s", in_tokens=None, out_tokens=None,
                 status=200, usage_source="estimate", request_id="r1", session="c")
        s = m.summary(session="c")
        assert s["dollars"]["saved"] == 0.0
        assert s["counts"]["unpriced"]["estimated_usage"] == 1
        assert s["counts"]["priced"] == 0


def test_duplicate_request_id_is_ignored_not_double_counted():
    with tempfile.TemporaryDirectory() as d:
        m = Metrics(db_path=os.path.join(d, "m.db"))
        for _ in range(3):        # the same provider call recorded three times
            m.record(tier="haiku", model="claude-haiku-4-5",
                     original_model="claude-opus-5", requested_tier="opus", reason="s",
                     in_tokens=1_000_000, out_tokens=1_000_000, status=200,
                     usage_source="body", request_id="req_same", session="c")
        s = m.summary(session="c")
        assert s["total"] == 1, "the partial unique index must collapse the replay"
        assert abs(s["dollars"]["saved"] - 24.0) < 1e-6, s["dollars"]


def test_rows_without_a_request_id_are_never_collapsed_together():
    # The partial index must not turn every pre-migration NULL row into one row.
    with tempfile.TemporaryDirectory() as d:
        m = Metrics(db_path=os.path.join(d, "m.db"))
        for _ in range(4):
            m.record(tier="haiku", model="claude-haiku-4-5",
                     original_model="claude-opus-5", requested_tier="opus", reason="s",
                     in_tokens=10, out_tokens=5, status=200, session="c")
        assert m.summary(session="c")["total"] == 4


def test_null_session_rows_are_normalised_so_scoped_sums_reconcile():
    """The live DB had 16 rows with session IS NULL holding 1,890,068 of 1,890,408
    in-tokens. `WHERE session = ''` matched none of them, so the sum of the
    per-session totals could never equal the ungrouped total."""
    import sqlite3
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        Metrics(db_path=path)                       # create the schema
        with sqlite3.connect(path) as c:
            c.execute("INSERT INTO decisions (ts, tier, model, original_model, "
                      "requested_tier, reason, source, in_tokens, out_tokens, status, "
                      "session) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)",
                      (1.0, "opus", "claude-opus-5", "claude-opus-5", "opus", "legacy",
                       "t", 1_890_068, 1_170_000, 200))
            c.commit()
        m = Metrics(db_path=path)                   # re-open: migration backfills NULL
        whole = m.summary()
        parts = {}
        with sqlite3.connect(path) as c:
            sessions = [r[0] for r in c.execute("SELECT DISTINCT session FROM decisions")]
        assert None not in sessions, "session IS NULL must be normalised to ''"
        for s in sessions:
            parts[s] = m.summary(session=s)
        assert sum(p["total"] for p in parts.values()) == whole["total"]
        for tier in whole["by_tier"]:
            got = sum(p["by_tier"].get(tier, {}).get("in_tokens", 0) for p in parts.values())
            assert got == whole["by_tier"][tier]["in_tokens"]
