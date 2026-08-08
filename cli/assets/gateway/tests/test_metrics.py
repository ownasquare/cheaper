import contextlib
import time
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
import metrics as metrics_mod  # noqa: E402
import periods  # noqa: E402
import pricing  # noqa: E402
from metrics import Metrics  # noqa: E402

# A DST-observing zone that is never UTC. Every offset assertion below is written
# against THESE two numbers rather than against whatever the host happens to be.
PINNED_ZONE = "America/Los_Angeles"
PINNED_WINTER_OFFSET = -480      # PST
PINNED_SUMMER_OFFSET = -420      # PDT


@contextlib.contextmanager
def pinned_zone(name: str = PINNED_ZONE):
    """Pin the PROCESS timezone for the body of the test.

    Three tests below guard the frozen-offset behaviour, and all three used to compute
    their expectation from ``periods.local_offset_minutes()`` ON THE HOST. On a host at
    UTC -- the default for most CI runners -- that expectation is 0, which is also
    exactly what the bug produces, so the assertion could not tell "reconstructed" from
    "silently read as UTC". Negative control: with ``_effective_tzo`` reverted to
    ``int(tzo) if tzo is not None else 0`` and ``record()`` reverted to resolving at
    ``time.time()``, the suite passed 183/183 under TZ=UTC and failed exactly these
    three under TZ=America/Los_Angeles.

    A test must SUPPLY the frame it asserts about, never read it from the machine.
    """
    if not hasattr(time, "tzset"):          # Windows: no tzset, no pinning
        pytest.skip("time.tzset() unavailable; cannot pin the process timezone")
    old = os.environ.get("TZ")
    os.environ["TZ"] = name
    time.tzset()
    try:
        yield
    finally:
        if old is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = old
        time.tzset()


def test_the_zone_pin_actually_takes_effect():
    """Guard the guard. If tzset() stopped biting, the three tests that depend on it
    would silently go back to asserting against the host's own zone."""
    winter = datetime(2026, 1, 15, 18, 0, tzinfo=timezone.utc).timestamp()
    summer = datetime(2026, 7, 15, 18, 0, tzinfo=timezone.utc).timestamp()
    with pinned_zone():
        assert periods.local_offset_minutes(winter * 1000) == PINNED_WINTER_OFFSET
        assert periods.local_offset_minutes(summer * 1000) == PINNED_SUMMER_OFFSET
        # UNCONDITIONAL: the pinned zone observes DST, so the two instants MUST differ.
        # The old guard was `if winter_offset != summer_offset:` and self-disabled on a
        # fixed-offset host.
        assert PINNED_WINTER_OFFSET != PINNED_SUMMER_OFFSET

# 23:30 on 2026-08-31 for a machine seven hours west of UTC. In UTC that instant is
# already 2026-09-01, and the claude-sonnet-5 promotional window in model_prices.json
# runs to 2026-08-31 inclusive -- so the UTC frame drops the promo and the row's own
# local frame keeps it. Same call, same tokens, 50% apart on both input and output.
PROMO_EDGE_TS = datetime(2026, 9, 1, 6, 30, tzinfo=timezone.utc).timestamp()
PROMO_EDGE_TZO = -420           # minutes EAST of UTC


def insert_row(path, *, ts, tzo, served="claude-sonnet-5", base="claude-opus-5",
               in_tok=1_000_000, out_tok=1_000_000, request_id="req_tz_1",
               session="c", status=200, usage_source="body",
               cache_read=0, cache_create_5m=0, cache_create_1h=0):
    """A decisions row written with an EXPLICIT stored offset (or None for a legacy row).

    Written straight to SQLite rather than through record() on purpose: record()
    correctly stamps the offset of the machine running the test, and these assertions
    have to hold on a machine in any zone.

    The three cache columns default to 0 -- the same figure ``COALESCE(cache_read,0)``
    produces for the NULLs a row written without them -- so every caller predating them
    is byte-for-byte unaffected. They exist for the cache-migration tests below, which
    need a row whose SPLIT (not just its totals) is under test.
    """
    with sqlite3.connect(path) as c:
        c.execute(
            "INSERT INTO decisions (ts, tier, model, original_model, requested_tier, "
            "reason, source, in_tokens, out_tokens, status, session, usage_source, "
            "request_id, tzo, cache_read, cache_create_5m, cache_create_1h) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (ts, "sonnet", served, base, "opus", "s", "t", in_tok, out_tok, status,
             session, usage_source, request_id, tzo,
             cache_read, cache_create_5m, cache_create_1h))
        c.commit()


def test_records_and_summarizes_savings():
    with tempfile.TemporaryDirectory() as d:
        m = Metrics(db_path=os.path.join(d, "m.db"))
        # 8 cheap requests that would otherwise have run on opus.
        for _ in range(8):
            m.record(tier="haiku", model="h", original_model="opus", requested_tier="opus",
                     reason="simple", in_tokens=1000, out_tokens=500)
        m.record(tier="opus", model="o", original_model="opus", requested_tier="opus",
                 reason="hard", in_tokens=1000, out_tokens=500)
        s = m.summary()
        assert s["total"] == 9
        assert s["by_tier"]["haiku"]["count"] == 8
        assert s["downgrade_rate"] > 80          # most requests were downgraded
        assert s["est_savings_pct"] > 0          # cheaper tiers => positive savings
        assert len(s["recent"]) == 9


def test_summary_scopes_to_a_single_session():
    with tempfile.TemporaryDirectory() as d:
        m = Metrics(db_path=os.path.join(d, "m.db"))
        # Two concurrent chats routing through the same gateway.
        # Model ids must be REAL catalog ids: pricing fails closed, so a placeholder
        # like "h"/"opus" is unpriceable and every dollar figure collapses to 0.
        for _ in range(5):
            m.record(tier="haiku", model="claude-haiku-4-5", original_model="claude-opus-5",
                     requested_tier="opus", reason="simple",
                     in_tokens=1000, out_tokens=500, session="chatA")
        for _ in range(2):
            m.record(tier="opus", model="claude-opus-5", original_model="claude-opus-5",
                     requested_tier="opus", reason="hard",
                     in_tokens=1000, out_tokens=500, session="chatB")
        # Global view sees everything…
        assert m.summary()["total"] == 7
        # …but the tagline asks for one chat and must get ONLY that chat.
        a = m.summary(session="chatA")
        assert a["total"] == 5
        assert a["by_tier"]["haiku"]["count"] == 5
        assert "opus" not in a["by_tier"]
        assert a["dollars"]["saved"] > 0
        b = m.summary(session="chatB")
        assert b["total"] == 2
        assert "haiku" not in b["by_tier"]
        # An unknown session is empty, never a cross-chat leak.
        assert m.summary(session="ghost")["total"] == 0


def test_none_vs_empty_session_semantics():
    # None = no filter (whole ledger, e.g. the dashboard); "" = a real value that scopes
    # to the empty-session rows and must NOT silently fall back to the whole ledger.
    with tempfile.TemporaryDirectory() as d:
        m = Metrics(db_path=os.path.join(d, "m.db"))
        for _ in range(3):
            m.record(tier="haiku", model="h", original_model="opus", requested_tier="opus",
                     reason="s", in_tokens=1000, out_tokens=500, session="chatA")
        m.record(tier="opus", model="o", original_model="opus", requested_tier="opus",
                 reason="h", in_tokens=1000, out_tokens=500)  # session defaults to ""
        assert m.summary()["total"] == 4              # None → whole ledger
        assert m.summary(session=None)["total"] == 4
        assert m.summary(session="")["total"] == 1    # "" → only the empty-session row
        assert m.summary(session="chatA")["total"] == 3


def test_saved_uses_the_served_model_not_a_tier_representative():
    """The routed leg is priced at the model actually served.

    This used to call estimate_call(original_model, ..., tier), which priced the
    routed leg at the FAMILY'S REPRESENTATIVE for that tier rather than at the
    `model` column record() already writes. Requesting claude-opus-5 and serving
    claude-sonnet-4-5 over 1M/1M reported $18.00 saved when the truth is $12.00 --
    a 50% over-report, on the one path whose figure prints with no "about" hedge.
    """
    with tempfile.TemporaryDirectory() as d:
        m = Metrics(db_path=os.path.join(d, "m.db"))
        m.record(tier="sonnet", model="claude-sonnet-4-5", original_model="claude-opus-5",
                 requested_tier="opus", reason="s",
                 in_tokens=1_000_000, out_tokens=1_000_000, session="c")
        s = m.summary(session="c")
        # opus-5 = 5 + 25 = $30 ; sonnet-4-5 = 3 + 15 = $18 ; saved = $12.00, not $18.00.
        assert abs(s["dollars"]["saved"] - 12.0) < 1e-6, s["dollars"]
        assert abs(s["dollars"]["spent"] - 18.0) < 1e-6, s["dollars"]
        # The tagline names models, so the summary must carry them.
        assert s["baseline_model"] == "claude-opus-5"
        assert s["downgraded_by_model"] == {"claude-sonnet-4-5": 1}
        assert s["upcharged_by_model"] == {}


def test_a_costlier_route_is_a_signed_negative_not_a_dropped_row():
    """Serving something pricier than requested must subtract, not silently vanish."""
    with tempfile.TemporaryDirectory() as d:
        m = Metrics(db_path=os.path.join(d, "m.db"))
        m.record(tier="opus", model="claude-fable-5", original_model="claude-opus-5",
                 requested_tier="opus", reason="s",
                 in_tokens=1_000_000, out_tokens=1_000_000, session="c")
        s = m.summary(session="c")
        # opus-5 = $30 baseline ; fable-5 = 10 + 50 = $60 served -> -$30.
        assert abs(s["dollars"]["saved"] + 30.0) < 1e-6, s["dollars"]
        assert abs(s["dollars"]["extra"] - 30.0) < 1e-6, s["dollars"]
        assert s["counts"]["models_upcharged"] == 1
        assert s["counts"]["models_changed"] == 0
        assert s["upcharged_by_model"] == {"claude-fable-5": 1}


def test_tokens_downgraded_is_reported():
    with tempfile.TemporaryDirectory() as d:
        m = Metrics(db_path=os.path.join(d, "m.db"))
        for _ in range(4):  # opus requested, routed to haiku → downgraded
            # Real catalog ids on BOTH legs: pricing fails closed, so a placeholder
            # served-model makes the row unpriceable and it claims nothing at all.
            m.record(tier="haiku", model="claude-haiku-4-5", original_model="claude-opus-4",
                     requested_tier="opus", reason="s", in_tokens=1000, out_tokens=500, session="c")
        s = m.summary(session="c")
        assert s["tokens"]["downgraded"] == 6000  # 4 rows * (1000+500)
        assert s["downgraded_by_tier"] == {"haiku": 4, "sonnet": 0, "opus": 0}


def test_old_db_without_session_column_still_records():
    # A metrics.db created before the `session` column must migrate + accept records.
    import sqlite3
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "legacy.db")
        con = sqlite3.connect(path)
        con.execute(
            "CREATE TABLE decisions (ts REAL, tier TEXT, model TEXT, original_model TEXT,"
            " requested_tier TEXT, reason TEXT, source TEXT, in_tokens INTEGER,"
            " out_tokens INTEGER, status INTEGER)")
        con.commit(); con.close()
        m = Metrics(db_path=path)  # __init__ runs the additive ALTERs
        m.record(tier="haiku", model="h", original_model="opus", requested_tier="opus",
                 reason="simple", in_tokens=10, out_tokens=5, session="chatX")
        assert m.summary(session="chatX")["total"] == 1


def test_cache_split_reaches_the_dollar_figure():
    """A cache-read-heavy row must not be priced as if every input token were fresh.

    The decisions table used to carry only in_tokens/out_tokens, so the gateway priced
    all input at the FRESH rate. Anthropic bills a cache read at 0.1x input and a
    1-hour cache write at 2x, and Claude Code writes 1-hour entries -- so the gateway's
    unhedged dollar figures were computed from a minority of the real billing shape.
    """
    with tempfile.TemporaryDirectory() as d:
        m = Metrics(db_path=os.path.join(d, "m.db"))
        # 1M cache-read + 1M fresh out, on Opus 5 ($5 in / $25 out, read = 0.1 * 5 = $0.50).
        m.record(tier="opus", model="claude-opus-5", original_model="claude-opus-5",
                 requested_tier="opus", reason="s", in_tokens=0, out_tokens=1_000_000,
                 cache_read=1_000_000, session="c")
        s = m.summary(session="c")
        # 1M read @ $0.50 + 1M out @ $25 = $25.50 -- NOT $30 (which is the all-fresh price).
        assert abs(s["dollars"]["spent"] - 25.5) < 1e-6, s["dollars"]

        # A 1-hour cache WRITE bills at 2x input, which is more than fresh.
        m2 = Metrics(db_path=os.path.join(d, "m2.db"))
        m2.record(tier="opus", model="claude-opus-5", original_model="claude-opus-5",
                  requested_tier="opus", reason="s", in_tokens=0, out_tokens=0,
                  cache_create_1h=1_000_000, session="c")
        s2 = m2.summary(session="c")
        assert abs(s2["dollars"]["spent"] - 10.0) < 1e-6, s2["dollars"]  # 2 * $5


def test_old_rows_without_cache_columns_still_price():
    """The migration is additive; pre-existing rows read as 0 rather than NULL-poisoning."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        # Simulate a legacy row: insert without the cache columns at all.
        import sqlite3
        with sqlite3.connect(path) as c:
            c.execute(
                "INSERT INTO decisions (ts, tier, model, original_model, requested_tier, "
                "reason, source, in_tokens, out_tokens, status, session) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (time.time(), "sonnet", "claude-sonnet-4-5", "claude-opus-5", "opus",
                 "legacy", "t", 1_000_000, 1_000_000, 200, "c"))
            c.commit()
        s = m.summary(session="c")
        assert abs(s["dollars"]["spent"] - 18.0) < 1e-6, s["dollars"]
        assert abs(s["dollars"]["saved"] - 12.0) < 1e-6, s["dollars"]


# ---------------------------------------------------------------------------
# ONE TIME FRAME: /logs and /metrics price at the row's own local day
# ---------------------------------------------------------------------------

def test_the_two_frames_really_do_disagree_on_this_instant():
    """Guard the guard: if the catalog window ever moves, the tests below stop testing
    anything and would still pass. Assert the divergence exists before relying on it."""
    assert pricing.cost_of_model("claude-sonnet-5", 1_000_000, 1_000_000,
                                 at="2026-08-31") == 12.0        # promo in 2 / out 10
    assert pricing.cost_of_model("claude-sonnet-5", 1_000_000, 1_000_000,
                                 at="2026-09-01") == 18.0        # list  in 3 / out 15
    assert periods.pday_of(PROMO_EDGE_TS * 1000, PROMO_EDGE_TZO) == "2026-08-31"
    assert periods.pday_of(PROMO_EDGE_TS * 1000, 0) == "2026-09-01"


def test_logs_prices_at_the_rows_local_day_not_the_utc_day():
    """ITEM-4. `/logs` used to price at metrics._day(ts) -- the UTC calendar date --
    while store.derive_row priced at pday. This row is 2026-08-31 locally and
    2026-09-01 in UTC, so the old frame billed sonnet-5 at list ($18) instead of the
    August promo ($12) and under-reported the saving by $6 on a $30 baseline."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        insert_row(path, ts=PROMO_EDGE_TS, tzo=PROMO_EDGE_TZO)
        row = m.logs(session="c")["rows"][0]
        assert row["pday"] == "2026-08-31"
        assert row["tzo"] == PROMO_EDGE_TZO
        assert abs(row["actual_cost"] - 12.0) < 1e-6, row      # NOT 18.0 (the UTC frame)
        assert abs(row["original_cost"] - 30.0) < 1e-6, row
        assert abs(row["savings"] - 18.0) < 1e-6, row          # NOT 12.0


def test_summary_prices_at_the_rows_local_day_not_the_utc_day():
    """ITEM-4, the aggregate half. summary() passed the same UTC date to cost_of_model,
    so the dashboard's headline dollars carried the identical error."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        insert_row(path, ts=PROMO_EDGE_TS, tzo=PROMO_EDGE_TZO)
        s = m.summary(session="c")
        assert abs(s["dollars"]["spent"] - 12.0) < 1e-6, s["dollars"]
        assert abs(s["dollars"]["saved"] - 18.0) < 1e-6, s["dollars"]


def test_a_stored_offset_beats_the_machines_current_zone():
    """ITEM-5. The offset is FROZEN on the row, so a machine that has since moved
    timezone cannot restate the price date of a call it already recorded.

    +330 (Asia/Kolkata) is used deliberately: it is a half-hour zone, so any
    hour-based shortcut gets it wrong.

    The zone is PINNED rather than assumed. The final assertion used to encode the host
    zone as a precondition ("no CI host sits at +05:30"), and on a host at Asia/Kolkata
    the test hard-failed on correct code: TZ=Asia/Kolkata gave 1 failed, 182 passed on
    the unmodified implementation. Pinning turns that precondition into a controlled
    fact, and the != 330 assertion stays as a genuine invariant of the pinned zone."""
    ts = datetime(2026, 8, 31, 20, 0, tzinfo=timezone.utc).timestamp()
    with pinned_zone(), tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        insert_row(path, ts=ts, tzo=330)
        row = m.logs(session="c")["rows"][0]
        # 20:00Z + 05:30 = 01:30 on 2026-09-01 local -> the promo has ended for this row.
        assert row["tzo"] == 330
        assert row["pday"] == "2026-09-01"
        assert abs(row["actual_cost"] - 18.0) < 1e-6, row
        # The pinned machine is at -420 for this instant, so the stored +330 provably
        # came from the ROW and not from a reconstruction.
        assert periods.local_offset_minutes(ts * 1000) == PINNED_SUMMER_OFFSET
        assert periods.local_offset_minutes(ts * 1000) != 330


def test_a_legacy_row_with_no_offset_is_reconstructed_never_read_as_utc():
    """tzo IS NULL is a real state: nobody recorded an offset for that call. It is
    reconstructed with periods.local_offset_minutes -- the SAME helper reporting.py
    falls back to -- and never silently read as 0/UTC, which would be a claim.

    The zone is PINNED, so the expectation is a NUMBER this test supplies rather than
    whatever the host reports. Read from the host, the expectation is 0 on a UTC runner
    -- byte-identical to the bug -- and the assertion proves nothing."""
    ts = PROMO_EDGE_TS
    with pinned_zone(), tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        insert_row(path, ts=ts, tzo=None)
        with sqlite3.connect(path) as c:
            stored = c.execute("SELECT tzo FROM decisions").fetchone()[0]
        assert stored is None, "the migration must not backfill a fabricated offset"
        expected = periods.local_offset_minutes(ts * 1000)
        assert expected == PINNED_SUMMER_OFFSET   # -420, provably NOT 0
        row = m.logs(session="c")["rows"][0]
        assert row["tzo"] == expected
        assert row["pday"] == periods.pday_of(ts * 1000, expected)
        # The two answers are DIFFERENT DAYS and DIFFERENT DOLLARS, which is what makes
        # this test bite: reconstructed -> 2026-08-31 (promo live, $12); read as UTC ->
        # 2026-09-01 (promo expired, $18).
        assert row["pday"] == "2026-08-31"
        assert periods.pday_of(ts * 1000, 0) == "2026-09-01"
        assert abs(row["actual_cost"] - 12.0) < 1e-6, row


def test_record_freezes_the_offset_at_the_rows_own_instant_not_at_now():
    """ITEM-5, the write side. record() accepts an explicit ts= (backfill, replay), and
    the offset stored must be the one in force AT THAT INSTANT. Resolving at "now"
    would let a DST transition restate history twice a year.

    The zone is PINNED to a DST-observing one, so the DST assertion is UNCONDITIONAL.
    It used to be wrapped in `if winter_offset != summer_offset:` and therefore
    self-disabled on a fixed-offset host -- including a UTC CI runner, where resolving
    at time.time() and resolving at the row's instant give the same 0 and the test
    passes against the bug.
    """
    winter = datetime(2026, 1, 15, 18, 0, tzinfo=timezone.utc).timestamp()
    summer = datetime(2026, 7, 15, 18, 0, tzinfo=timezone.utc).timestamp()
    with pinned_zone(), tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        for i, ts in ((1, winter), (2, summer)):
            m.record(tier="sonnet", model="claude-sonnet-5",
                     original_model="claude-opus-5", requested_tier="opus", reason="s",
                     in_tokens=10, out_tokens=5, status=200, usage_source="body",
                     session="c", request_id=f"req_freeze_{i}", ts=ts)
        with sqlite3.connect(path) as c:
            got = dict(c.execute("SELECT ts, tzo FROM decisions").fetchall())
        # The explicit ts= is honoured verbatim -- not replaced by time.time().
        assert set(got) == {winter, summer}
        # Literal expectations, supplied by this test, not read back from the host.
        assert got[winter] == PINNED_WINTER_OFFSET
        assert got[summer] == PINNED_SUMMER_OFFSET
        assert got[winter] != got[summer]
        # And they match the shared reconstruction helper at those same instants.
        assert got[winter] == periods.local_offset_minutes(winter * 1000)
        assert got[summer] == periods.local_offset_minutes(summer * 1000)


# ---------------------------------------------------------------------------
# TOTALITY: one undatable row is a counted exclusion, never an outage
# ---------------------------------------------------------------------------

# metrics.db stores SECONDS. This is a MILLISECOND value -- the unit periods.js and the
# event store use -- so it lands in year 55840, which datetime cannot represent.
UNIT_SLIP_TS = 1700000000000.0


def test_pday_of_is_total_and_never_raises_on_an_unrepresentable_instant():
    """periods.pday_of is annotated `-> str | None` and every caller treats it as total.
    It briefly called datetime.utcfromtimestamp unguarded, so an out-of-range instant
    raised straight out of Metrics.logs / Metrics.summary / gateway_row_to_event and
    500'd /logs, /metrics, /api/v1/logs, /api/v1/reports/* and /api/v1/export -- the
    whole audit log, for one poisoned row."""
    assert periods.pday_of(UNIT_SLIP_TS * 1000.0, 0) is None
    assert periods.pday_of(UNIT_SLIP_TS * 1000.0, -420) is None
    assert periods.pday_of(-1e18, 0) is None
    assert periods.pday_of(float("nan"), 0) is None
    assert periods.pday_of(float("inf"), 0) is None
    assert periods.pday_of("not-a-number", 0) is None
    # ...and it still answers for everything it CAN represent.
    assert periods.pday_of(PROMO_EDGE_TS * 1000, PROMO_EDGE_TZO) == "2026-08-31"


def test_one_undatable_row_does_not_take_down_the_whole_audit_log():
    """The row is UNPRICEABLE and VISIBLY COUNTED. Every other row keeps its dollars."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        insert_row(path, ts=PROMO_EDGE_TS, tzo=PROMO_EDGE_TZO, request_id="req_good")
        insert_row(path, ts=UNIT_SLIP_TS, tzo=0, request_id="req_poisoned")

        out = m.logs(session="c")          # must not raise
        assert out["total"] == 2
        poisoned = [r for r in out["rows"] if r["request_id"] == "req_poisoned"][0]
        good = [r for r in out["rows"] if r["request_id"] == "req_good"][0]
        # A labelled non-number, never $0.00.
        assert poisoned["pday"] is None
        assert poisoned["actual_cost"] is None
        assert poisoned["original_cost"] is None
        assert poisoned["savings"] is None
        # A DISTINCT reason: "we could not date it", not "we do not know the model".
        # And emphatically not a figure priced at today, which is what at=None would
        # have produced inside cost_of_model.
        assert poisoned["unpriced_reason"] == "undatable"
        # The healthy row is untouched.
        assert good["pday"] == "2026-08-31"
        assert abs(good["actual_cost"] - 12.0) < 1e-6

        s = m.summary(session="c")         # must not raise
        assert s["counts"]["examined"] == 2
        assert s["counts"]["unpriced"]["undatable"] == 1
        assert s["counts"]["unpriced"]["model_not_in_catalog"] == 0
        assert s["counts"]["priced"] == 1
        assert abs(s["dollars"]["spent"] - 12.0) < 1e-6, s["dollars"]


def test_record_refuses_a_timestamp_the_read_path_cannot_represent():
    """The write path must not accept what the read path cannot render. The refusal is
    VISIBLE (it raises at the call site) and COUNTED (`rejected_ts`), never a silent
    drop that shrinks the ledger with no trace."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        with pytest.raises(ValueError):
            m.record(tier="sonnet", model="claude-sonnet-5",
                     original_model="claude-opus-5", requested_tier="opus", reason="s",
                     in_tokens=10, out_tokens=5, status=200, usage_source="body",
                     session="c", request_id="req_slip", ts=UNIT_SLIP_TS)
        assert m.rejected_ts == 1
        with sqlite3.connect(path) as c:
            assert c.execute("SELECT COUNT(*) FROM decisions").fetchone()[0] == 0
        # A legitimate backfill still writes.
        m.record(tier="sonnet", model="claude-sonnet-5",
                 original_model="claude-opus-5", requested_tier="opus", reason="s",
                 in_tokens=10, out_tokens=5, status=200, usage_source="body",
                 session="c", request_id="req_ok", ts=PROMO_EDGE_TS)
        assert m.rejected_ts == 1
        assert m.summary(session="c")["total"] == 1


# ---------------------------------------------------------------------------
# An unpriceable row claims NOTHING -- and the two figures reconcile
# ---------------------------------------------------------------------------

def test_an_unpriceable_served_model_never_borrows_the_requested_models_rate():
    """The served model is absent from the catalog, so NO dollar may be claimed for this
    row -- not at the requested model's rate, and above all not at TODAY's rate.

    The old fallback booked `estimate_call(original_model, ...)["new_cost"]` into
    dollars.spent. Both estimate_call and is_priceable resolve inside resolve_model at
    pricing.today_utc(), so this row (dated 2026-09-05) was priced at the August promo:
    $12.00 against a true 2026-09-05 cost of $18.00 -- a 33% understatement that MOVED
    on 2026-09-01 with no code or data change. And /logs reported actual_cost=None for
    the very same call.
    """
    ts = datetime(2026, 9, 5, 12, 0, tzinfo=timezone.utc).timestamp()
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        insert_row(path, ts=ts, tzo=0, served="llama-4-maverick",
                   base="claude-sonnet-5", request_id="req_unpriceable")
        # The two frames genuinely disagree on this row, or the test proves nothing.
        assert pricing.cost_of_model("claude-sonnet-5", 1e6, 1e6, at="2026-09-05") == 18.0
        assert pricing.cost_of_model("claude-sonnet-5", 1e6, 1e6, at="2026-08-06") == 12.0
        assert not pricing.is_priceable("llama-4-maverick")

        s = m.summary(session="c")
        assert s["dollars"]["spent"] == 0.0, s["dollars"]
        assert s["dollars"]["saved"] == 0.0, s["dollars"]
        assert s["dollars"]["savings_pct"] == 0.0
        assert s["counts"]["unpriced"]["model_not_in_catalog"] == 1
        assert s["counts"]["priced"] == 0
        # ...and /logs already said exactly this about the same row.
        row = m.logs(session="c")["rows"][0]
        assert row["actual_cost"] is None
        assert row["unpriced_reason"] == "model_not_in_catalog"


def test_spent_covers_exactly_the_rows_counted_as_priced():
    """THE RECONCILIATION INVARIANT. Every examined row either contributes to the dollar
    accumulators or is counted in counts.unpriced -- never both, never neither. An
    exclusion that is counted but not actually excluded is worse than no count at all."""
    ts = datetime(2026, 8, 20, 12, 0, tzinfo=timezone.utc).timestamp()
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        # 2 priceable, 1 unpriceable served model, 1 estimated usage, 1 non-2xx,
        # 1 cold-start-after-a-switch whose counterfactual cache state is not derivable.
        insert_row(path, ts=ts, tzo=0, request_id="p1")
        insert_row(path, ts=ts, tzo=0, request_id="p2")
        insert_row(path, ts=ts, tzo=0, served="llama-4-maverick", request_id="u1")
        insert_row(path, ts=ts, tzo=0, usage_source="estimate", request_id="e1")
        insert_row(path, ts=ts, tzo=0, status=529, request_id="n1")
        insert_row(path, ts=ts, tzo=0, served="claude-haiku-4-5", request_id="c1",
                   in_tok=0, out_tok=1000, cache_read=0, cache_create_5m=200_000)

        s = m.summary(session="c")
        c = s["counts"]
        assert c["examined"] == 6
        assert c["unpriced"] == {"estimated_usage": 1, "non_2xx": 1,
                                 "model_not_in_catalog": 1, "undatable": 0,
                                 "cache_state_indeterminate": 1}
        assert c["priced"] == 2
        assert c["priced"] + c["unpriced_total"] == c["examined"]
        # Exactly the two priced rows are inside the dollars: sonnet-5 at 2026-08-20 is
        # $12 each, baseline opus-5 $30 each.
        assert abs(s["dollars"]["spent"] - 24.0) < 1e-6, s["dollars"]
        assert abs(s["dollars"]["saved"] - 36.0) < 1e-6, s["dollars"]
        # The per-period roll-up is fed by the same rows and must agree.
        assert s["periods"]["all"]["calls"] == c["priced"]
        assert abs(s["periods"]["all"]["spent"] - s["dollars"]["spent"]) < 1e-6


# ---------------------------------------------------------------------------
# THE COUNTERFACTUAL'S PROMPT-CACHE STATE
# ---------------------------------------------------------------------------
#
# Both legs of every subtraction in summary()/logs() are priced off ONE token split --
# the SERVED arm's. A model switch invalidates the prompt cache, so the served arm pays
# a cache CREATE for a prefix the un-switched baseline model may still have held and
# would merely have READ. Charging the baseline a CREATE for those tokens inflates it by
# the whole write/read spread, and the claimed saving with it.
#
# Rates in force on 2026-08-20, from model_prices.json:
#     claude-opus-5     in $5  out $25  cacheRead $0.50  cacheWrite $6.25
#     claude-haiku-4-5  in $1  out $5   cacheRead $0.10  cacheWrite $1.25
#
# The fixture row below (0 fresh in, 1k out, 200k written, nothing read, haiku served
# against an opus baseline) prices as:
#     spent                                          $0.255
#     baseline charged a CREATE  (what shipped)      $1.275  ->  claims +$1.020
#     baseline charged a READ    (un-switched)       $0.125  ->  implies -$0.130
# The two readings do not merely differ in size, they differ in SIGN, and nothing in the
# schema says which is true. Invariant 4: the row makes no claim and is labelled.

CACHE_TS = datetime(2026, 8, 20, 12, 0, tzinfo=timezone.utc).timestamp()


def test_a_cold_start_after_a_model_switch_withholds_the_counterfactual():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        insert_row(path, ts=CACHE_TS, tzo=0, served="claude-haiku-4-5",
                   base="claude-opus-5", in_tok=0, out_tok=1000,
                   cache_read=0, cache_create_5m=200_000, request_id="cold1")

        # First prove the interval is real, and prove its DIRECTION, from pricing.py
        # itself rather than from a transcribed constant.
        spent = pricing.cost_of_model("claude-haiku-4-5", 0, 1000,
                                      cache_create_5m=200_000, at="2026-08-20")
        base_if_cold = pricing.cost_of_model("claude-opus-5", 0, 1000,
                                             cache_create_5m=200_000, at="2026-08-20")
        base_if_warm = pricing.cost_of_model("claude-opus-5", 0, 1000,
                                             cache_read=200_000, at="2026-08-20")
        assert abs(spent - 0.255) < 1e-9
        assert abs(base_if_cold - 1.275) < 1e-9
        assert abs(base_if_warm - 0.125) < 1e-9
        # DIRECTION, asserted explicitly: pricing the baseline on the served arm's split
        # can only move it UP. A write is never cheaper than a read anywhere in the
        # catalog, so the shipped bias was one-directional -- it never understated.
        assert base_if_cold > base_if_warm
        # ...and the interval STRADDLES ZERO. Not a rounding difference: the shipped code
        # books +$1.02 of savings on a call that may have cost the user $0.13.
        assert base_if_cold - spent > 0
        assert base_if_warm - spent < 0

        s = m.summary(session="c")
        c = s["counts"]
        assert c["examined"] == 1
        assert c["priced"] == 0
        assert c["unpriced"]["cache_state_indeterminate"] == 1
        # No dollar figure on the summary may carry it -- not saved, not spent, not the
        # per-period roll-up. A withheld row is not a $0.00 row.
        assert s["dollars"]["saved"] == 0.0 and s["dollars"]["spent"] == 0.0
        assert s["periods"]["all"]["calls"] == 0

        # /logs says the same thing about the same row, per cell. `actual_cost` is a
        # FACT -- the model that ran, priced at its own split -- and survives. The
        # COUNTERFACTUAL is what is unknowable, so it and the saving are withheld.
        row = m.logs(session="c")["rows"][0]
        assert abs(row["actual_cost"] - 0.255) < 1e-9
        assert row["original_cost"] is None
        assert row["savings"] is None
        assert row["unpriced_reason"] == "cache_state_indeterminate"


def test_a_warm_switched_call_keeps_its_credit():
    """An incremental cache write on an already-warm chain is NEW content that the
    baseline model would have had to create too, so the served split IS the
    counterfactual split and the existing pricing is exactly right.

    This is the over-correction guard. In a 22,481-row snapshot of the author's store
    (2026-08-07) withholding these rows would have deleted $156.03 of correctly-earned
    credit across the 3,301 rows of this shape -- the mirror-image fabrication of the one
    being fixed.
    """
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        insert_row(path, ts=CACHE_TS, tzo=0, served="claude-haiku-4-5",
                   base="claude-opus-5", in_tok=0, out_tok=1000,
                   cache_read=200_000, cache_create_5m=20_000, request_id="warm1")
        s = m.summary(session="c")
        assert s["counts"]["priced"] == 1
        assert s["counts"]["unpriced"]["cache_state_indeterminate"] == 0
        assert abs(s["dollars"]["spent"] - 0.05) < 1e-6, s["dollars"]
        assert abs(s["dollars"]["saved"] - 0.20) < 1e-6, s["dollars"]


def test_a_session_that_never_switches_model_is_unchanged_to_the_cent():
    """THE NO-OP GUARD. Nothing was switched, so nothing was invalidated: both arms are
    the same model on the same split and the saving is zero under EVERY cache
    assumption. A guard that fired here would manufacture an anti-saving on the 14,902
    un-switched eligible rows in the author's store.
    """
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        # The IDENTICAL cold 200k write as the withheld row above -- but served on the
        # baseline model, so there was no migration to mis-price.
        insert_row(path, ts=CACHE_TS, tzo=0, served="claude-opus-5",
                   base="claude-opus-5", in_tok=0, out_tok=1000,
                   cache_read=0, cache_create_5m=200_000, request_id="same1")
        s = m.summary(session="c")
        assert s["counts"]["priced"] == 1
        assert s["counts"]["unpriced"]["cache_state_indeterminate"] == 0
        assert abs(s["dollars"]["spent"] - 1.275) < 1e-6, s["dollars"]
        assert s["dollars"]["saved"] == 0.0, s["dollars"]
        row = m.logs(session="c")["rows"][0]
        assert abs(row["actual_cost"] - 1.275) < 1e-9
        assert abs(row["original_cost"] - 1.275) < 1e-9
        assert row["savings"] == 0.0
        assert row["unpriced_reason"] == ""


def test_the_cache_state_rule_is_identical_in_both_runtimes():
    """CROSS-RUNTIME PARITY for this rule specifically.

    ``metrics.py::_cache_state_indeterminate`` and
    ``cli/src/peek/derive.js::cacheStateIndeterminate`` decide which rows carry a
    publishable saving. Two readers that disagree here republish the same defect on one
    surface while the other withholds it -- and the divergence is silent, because each
    surface stays internally consistent. So BOTH are executed over the same case table
    and compared.

    NOT COVERED BY THIS GATE: ``gateway/app/store.py::derive_row``, the third reader of
    this question (over the event store rather than SQLite). It does not yet carry the
    rule. ``tests/test_store_parity.py`` diffs it against derive.js byte-for-byte and
    currently passes only because no row in ``cli/test/fixtures/golden-events.json``
    is a cold start after a switch -- every switched fixture row with a cache write also
    carries a cache read. That is luck, not coverage.
    """
    import json
    import shutil
    import subprocess
    from pathlib import Path

    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH -- the cross-runtime parity gate cannot run")
    # resolve() first: this directory is reached through the `gateway/` symlink, so a
    # relative walk from the unresolved path lands outside the repo.
    derive_js = (Path(__file__).resolve().parent.parents[3]
                 / "cli" / "src" / "peek" / "derive.js")
    assert derive_js.exists(), derive_js

    # served, base, cache_read, cache_create
    cases = [
        ("claude-haiku-4-5", "claude-opus-5", 0, 200_000),      # cold switch -> withhold
        ("claude-haiku-4-5", "claude-opus-5", 200_000, 20_000),  # warm switch -> price
        ("claude-haiku-4-5", "claude-opus-5", 1, 200_000),       # one read is still warm
        ("claude-haiku-4-5", "claude-opus-5", 0, 0),             # no cache at all
        ("claude-opus-5", "claude-opus-5", 0, 200_000),          # NO SWITCH -> price
        ("claude-opus-5", "", 0, 200_000),                       # no baseline
        ("", "claude-opus-5", 0, 200_000),                       # no served model
        ("claude-haiku-4-5", "claude-opus-5", 0, 1),             # smallest write
    ]
    harness = (
        "const d=require(process.argv[1]);"
        "const cs=JSON.parse(process.argv[2]);"
        "process.stdout.write(JSON.stringify("
        "cs.map(c=>d.cacheStateIndeterminate(c[0],c[1],c[2],c[3]))));"
    )
    proc = subprocess.run([node, "-e", harness, str(derive_js), json.dumps(cases)],
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    js = json.loads(proc.stdout)
    py = [metrics_mod._cache_state_indeterminate(*c) for c in cases]
    assert js == py, f"cache-state rule diverged\n  node:   {js}\n  python: {py}"
    # A gate over a rule that never fires proves nothing: both answers must appear.
    assert True in py and False in py


# ---------------------------------------------------------------------------
# The all-frontier baseline: the row's own day, and a SIGNED difference
# ---------------------------------------------------------------------------

@contextlib.contextmanager
def promo_window_on(model_id: str, window: dict):
    """Transcribe a dated promotional window onto a catalog entry for the body of the
    test, then take it away again.

    Without this the `billed_top` assertion below CANNOT bite. No TOP representative in
    model_prices.json carries a dated window (the only window sits on claude-sonnet-5, a
    MID representative), so `cost_of_model(top_rep, ..., at=<row day>)` and
    `cost_of_model(top_rep, ..., at=None)` return the SAME number and an assertion
    comparing them to each other is satisfied by the defect as readily as by the fix.
    The catalog has to be made to disagree with itself across dates before a date-frame
    claim can be substantiated at all.
    """
    entry = None
    for e in pricing.CATALOG:
        if pricing.canonical(e["id"]) == pricing.canonical(model_id):
            entry = e
            break
    assert entry is not None, f"{model_id} is not in the catalog"
    had = "window" in entry
    old = entry.get("window")
    entry["window"] = window
    try:
        yield
    finally:
        if had:
            entry["window"] = old
        else:
            entry.pop("window", None)


# A local calendar day that can NEVER be today -- the whole point of the test below is
# that the row's day and today's day price differently, so the row's day must be a date
# the clock cannot wander onto. 2019-06-15 11:00 for a machine seven hours west of UTC.
OLD_DAY = "2019-06-15"
OLD_DAY_TS = datetime(2019, 6, 15, 18, 0, tzinfo=timezone.utc).timestamp()
OLD_DAY_TZO = -420
# Deliberately unlike claude-opus-5's list sheet ($5 in / $25 out) so the two frames are
# tellable apart by inspection: 1M in + 1M out is $3.00 on promo and $30.00 at list.
OLD_DAY_PROMO = {"from": "2019-01-01", "until": "2019-12-31", "in": 1.0, "out": 2.0}


def test_the_top_representative_really_does_price_differently_on_the_two_days():
    """GUARD THE GUARD. If promo_window_on() ever stopped biting -- a renamed catalog
    field, a changed representative, a resolve_model that ignores `window` -- the test
    below would go back to comparing a number against itself and would pass against the
    defect it exists to catch. Prove the disagreement BEFORE relying on it."""
    rep = pricing.representative_for("anthropic", "opus")
    assert rep == "claude-opus-5", rep
    with promo_window_on(rep, OLD_DAY_PROMO):
        on_day = pricing.cost_of_model(rep, 1_000_000, 1_000_000, at=OLD_DAY)
        at_today = pricing.cost_of_model(rep, 1_000_000, 1_000_000, at=None)
        today_explicit = pricing.cost_of_model(
            rep, 1_000_000, 1_000_000, at=pricing.today_utc())
        assert abs(on_day - 3.0) < 1e-9, on_day
        assert abs(at_today - 30.0) < 1e-9, at_today
        # at=None IS at=today_utc(): that identity is what makes the defect a date-frame
        # substitution rather than a rounding difference.
        assert at_today == today_explicit
        assert on_day != at_today
    # ...and the window is really gone again, so no later test inherits it.
    assert abs(pricing.cost_of_model(rep, 1_000_000, 1_000_000, at=OLD_DAY) - 30.0) < 1e-9


def test_billed_top_is_priced_at_the_rows_own_day_not_at_today():
    """`billed_top` used to go through pricing.cost_of(), which takes no `at` and always
    resolves at today_utc(). Passing the row's own day is not decorative: the moment a
    promotional window is transcribed onto a TOP representative, an `at=None` here
    restates every historical row's all-frontier baseline -- and therefore
    baselines.highest_tier -- at today's rates, with no code or data change to point at.

    So the catalog is made to carry exactly that window for the length of this test, and
    the row is dated inside it while today is outside it. The assertion then DEPENDS on
    `at`: it is $3.00 if the row is priced on its own day and $30.00 if it is priced at
    today, and no third answer is available.
    """
    rep = pricing.representative_for("anthropic", "opus")
    with tempfile.TemporaryDirectory() as d, promo_window_on(rep, OLD_DAY_PROMO):
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        insert_row(path, ts=OLD_DAY_TS, tzo=OLD_DAY_TZO)
        s = m.summary(session="c")
        on_day = pricing.cost_of_model(rep, 1_000_000, 1_000_000, at=OLD_DAY)
        at_today = pricing.cost_of_model(rep, 1_000_000, 1_000_000, at=None)
        assert on_day is not None and at_today is not None
        assert on_day != at_today, "guard: the two frames must disagree"
        assert abs(s["dollars"]["billed_top"] - on_day) < 1e-6, s["dollars"]
        # State the negative explicitly. "equals the right number" and "is not the wrong
        # number" read the same only while the catalog cooperates.
        assert abs(s["dollars"]["billed_top"] - at_today) > 1e-6, s["dollars"]
        assert s["counts"]["billed_top_missing"] == 0


def test_billed_top_asks_pricing_for_the_rows_own_day():
    """The same claim again, from the other side: whatever the catalog happens to hold,
    the top-representative leg must be REQUESTED at the row's own local day. A behaviour
    assertion can only see a date frame the catalog makes visible; this one sees the
    argument itself, so it keeps biting on a day when no top rep is on promo."""
    rep = pricing.representative_for("anthropic", "opus")
    seen: list = []
    real = metrics_mod.cost_of_model

    def spy(model_id, *a, **kw):
        seen.append((model_id, a, kw.get("at")))
        return real(model_id, *a, **kw)

    # Two deliberate choices, both so that a call named `rep` at these tokens can ONLY be
    # the all-frontier leg:
    #  - tokens are NOT 1M/1M, because summary() also prices a fixed 1M-in/1M-out basket
    #    to RANK models for the tagline's "...instead of X" name (it orders models, it
    #    claims no dollar). That basket is now priced at the row's own day too -- see
    #    test_the_baseline_name_is_ranked_at_the_rows_own_day -- so the token amounts,
    #    not the `at`, are what tell the two legs apart;
    #  - the requested model is claude-opus-4-8, NOT the top representative itself, so the
    #    requested-leg call cannot stand in for a missing baseline call.
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        insert_row(path, ts=OLD_DAY_TS, tzo=OLD_DAY_TZO, base="claude-opus-4-8",
                   in_tok=2_000_000, out_tok=3_000_000)
        metrics_mod.cost_of_model = spy
        try:
            m.summary(session="c")
        finally:
            metrics_mod.cost_of_model = real
    billed_top_calls = [at for (mid, a, at) in seen
                        if mid == rep and a[:2] == (2_000_000, 3_000_000)]
    assert billed_top_calls == [OLD_DAY], seen


def test_highest_tier_baseline_keeps_its_sign():
    """A period in which Cheaper spent MORE than the all-frontier baseline must READ as
    negative. `round(max(0.0, billed_top - spent), 4)` suppressed that in the ARITHMETIC,
    so an overspend was indistinguishable from a measured $0.00."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        # claude-fable-5 (10 in / 50 out) costs MORE than the opus top representative.
        insert_row(path, ts=PROMO_EDGE_TS, tzo=PROMO_EDGE_TZO,
                   served="claude-fable-5", base="claude-opus-5")
        s = m.summary(session="c")
        assert s["dollars"]["spent"] > s["dollars"]["billed_top"], s["dollars"]
        assert s["baselines"]["highest_tier"] < 0, s["baselines"]
        assert abs(s["baselines"]["highest_tier"]
                   - (s["dollars"]["billed_top"] - s["dollars"]["spent"])) < 1e-4


# ---------------------------------------------------------------------------
# The baseline/top NAME is ranked in the row's own time frame
# ---------------------------------------------------------------------------
#
# `baseline_model` and `top_model` leave summary() as STRINGS. cli/src/peek/tagline.js
# reads them as `ceilingModel` / `topModel` and prints them in the "...instead of X"
# clause; no dollar on the summary is derived from the ranking. That is why this is a
# naming bug rather than a money bug -- and why it still has to be fixed: the ranking
# used to resolve at pricing.today_utc() while every other price in the same loop used
# the row's own day, and two frames in one loop have no defensible reading.

# A promotional window that makes claude-fable-5 (list: 10 in / 50 out = $60 on the
# 1M/1M ranking basket) the CHEAPEST thing in the catalog for the whole of 2019 -- and
# therefore reverses its order against claude-opus-5 ($30) on OLD_DAY only.
FABLE_2019_PROMO = {"from": "2019-01-01", "until": "2019-12-31", "in": 0.1, "out": 0.1}


def test_the_ranking_basket_really_does_reorder_across_the_promo_boundary():
    """GUARD THE GUARD, same discipline as the billed_top pair above. If the window
    stopped biting, the test below would assert a name that both the fix and the defect
    produce. Prove the ORDER genuinely flips before relying on it."""
    with promo_window_on("claude-fable-5", FABLE_2019_PROMO):
        on_day_fable = pricing.cost_of_model("claude-fable-5", 1_000_000, 1_000_000, at=OLD_DAY)
        on_day_opus = pricing.cost_of_model("claude-opus-5", 1_000_000, 1_000_000, at=OLD_DAY)
        today_fable = pricing.cost_of_model("claude-fable-5", 1_000_000, 1_000_000, at=None)
        today_opus = pricing.cost_of_model("claude-opus-5", 1_000_000, 1_000_000, at=None)
        assert abs(on_day_fable - 0.2) < 1e-9, on_day_fable
        assert abs(today_fable - 60.0) < 1e-9, today_fable
        # The whole point: opus is dearer on the row's day, fable is dearer today.
        assert on_day_opus > on_day_fable
        assert today_fable > today_opus
    assert abs(pricing.cost_of_model("claude-fable-5", 1_000_000, 1_000_000, at=OLD_DAY)
               - 60.0) < 1e-9


def test_the_baseline_name_is_ranked_at_the_rows_own_day():
    """b_rank/t_rank used to call cost_of_model(..., 1M, 1M) and is_priceable() with NO
    `at`, i.e. at pricing.today_utc(), inside a loop where every other price used
    at=kw["at"]. ONLY THE NAME is affected -- no dollar on this summary moves -- but the
    name is what the tagline prints, and across a promotional boundary the two frames
    order two models differently and the wrong one gets named.

    Both rows are dated OLD_DAY, when the promo makes claude-fable-5 the cheapest model
    in the catalog. Priced on the row's own day the priciest REQUESTED model is
    claude-opus-5; priced at today (the promo long expired) it is claude-fable-5. Two
    names, no third answer available.
    """
    with tempfile.TemporaryDirectory() as d, promo_window_on("claude-fable-5",
                                                             FABLE_2019_PROMO):
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        insert_row(path, ts=OLD_DAY_TS, tzo=OLD_DAY_TZO,
                   base="claude-opus-5", served="claude-opus-5", request_id="rank_opus")
        insert_row(path, ts=OLD_DAY_TS, tzo=OLD_DAY_TZO,
                   base="claude-fable-5", served="claude-fable-5", request_id="rank_fable")
        s = m.summary(session="c")
        assert s["baseline_model"] == "claude-opus-5", s["baseline_model"]
        assert s["top_model"] == "claude-opus-5", s["top_model"]
        # State the negative too: "equals the right name" and "is not the wrong name"
        # only read the same while the catalog cooperates.
        assert s["baseline_model"] != "claude-fable-5"
        assert s["top_model"] != "claude-fable-5"


def test_priceability_for_the_ranking_is_asked_at_the_rows_own_day():
    """The companion half of the same fix. `is_priceable(om)` with no date answers "can
    we price this model TODAY?", which is a different question from the one the loop is
    answering. A model whose only published rates live inside a window that has since
    closed is priceable ON THE ROW'S DAY and must be eligible to be named."""
    # Prove the two questions really do disagree for this model on these two days.
    with promo_window_on("claude-fable-5", FABLE_2019_PROMO):
        assert pricing.is_priceable("claude-fable-5", OLD_DAY)
        assert pricing.is_priceable("claude-fable-5", None)
        # ...and the date reaches the resolver rather than being ignored:
        assert (pricing.resolve_model("claude-fable-5", OLD_DAY)["in"]
                != pricing.resolve_model("claude-fable-5", "2026-09-01")["in"])
    assert pricing.is_priceable("claude-sonnet-5", "2026-09-01")
    assert not pricing.is_priceable("llama-4-maverick", "2026-09-01")
    assert not pricing.is_priceable("llama-4-maverick", None)


# ---------------------------------------------------------------------------
# resolve_model() is memoised -- and the memo key carries the DAY
# ---------------------------------------------------------------------------
#
# summary() with no session filter resolves ~7 models per row over up to max_rows=5000
# rows, and /ws pushes that summary on every routed request plus a 5s heartbeat, per
# connected dashboard client. Before the index + memo, one such summary cost 35,000
# resolve_model() calls and 677,266 catalog-entry comparisons (1.185s wall clock here);
# after, the same 35,000 calls do ZERO comparisons and 0.054s. The tests below pin both
# halves: that the work really is gone, and that removing it did not flatten the date
# out of the price.


def _count_entry_comparisons(fn):
    """Run `fn` with pricing._entry_matches instrumented; return (result, comparisons).

    Comparisons, not seconds. A wall-clock assertion on a shared CI box is a coin flip;
    the number of catalog-entry comparisons a summary performs is deterministic, is the
    exact quantity the memo removes, and moves by five orders of magnitude between the
    two implementations.
    """
    n = {"v": 0}
    real = pricing._entry_matches

    def counting(cand, entry):
        n["v"] += 1
        return real(cand, entry)

    pricing._entry_matches = counting
    try:
        return fn(), n["v"]
    finally:
        pricing._entry_matches = real


def test_summary_does_not_rescan_the_catalog_once_per_priced_leg():
    """THE PERFORMANCE REGRESSION TEST. 5,000 rows, ~7 model resolutions each. The old
    linear scan canonicalised every catalog id on every one of them; measured here at
    677,266 entry comparisons for this exact fixture. The index answers from a dict, so
    the only comparisons left are the ones a test double introduces -- zero.

    The bound is deliberately generous (one comparison per examined row would still be
    ~5,000): this test exists to catch a REINTRODUCED per-call scan, not to police a
    constant factor.
    """
    ts = datetime(2026, 8, 20, 12, 0, tzinfo=timezone.utc).timestamp()
    served = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "gpt-5",
              "gemini-2.5-pro"]
    base = ["claude-opus-5", "claude-sonnet-5", "gpt-5"]
    rows = 5000
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        with sqlite3.connect(path) as c:
            c.executemany(
                "INSERT INTO decisions (ts, tier, model, original_model, requested_tier, "
                "reason, source, in_tokens, out_tokens, status, session, usage_source, "
                "request_id, tzo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [(ts - i, "sonnet", served[i % len(served)], base[i % len(base)], "opus",
                  "r", "t", 1000 + i, 500 + i, 200, "c", "body", "perf_%d" % i, -420)
                 for i in range(rows)])
            c.commit()
        # Warm once so the measurement is of steady state, not of the first build.
        m.summary(session="c", max_rows=rows)
        s, comparisons = _count_entry_comparisons(
            lambda: m.summary(session="c", max_rows=rows))
    assert s["counts"]["examined"] == rows
    assert s["counts"]["priced"] == rows
    assert comparisons <= rows, (
        "resolve_model is scanning the catalog per call again: %d entry comparisons "
        "for %d rows" % (comparisons, rows))


def test_the_resolution_memo_key_includes_the_day():
    """A memo keyed on the model id ALONE would be a pricing bug wearing an
    optimisation's clothes: claude-sonnet-5's launch window ends 2026-08-31, so a cache
    warmed on 2026-08-31 would keep quoting $2/$10 for a 2026-09-01 call -- a silent 50%
    understatement on both input and output.

    Asked in BOTH warming orders, because a single-key cache is correct for whichever
    date happens to be asked first, and a test that only warms one way would pass
    against the defect half the time.
    """
    want = {"2026-08-31": 12.0, "2026-09-01": 18.0}
    for first, second in (("2026-08-31", "2026-09-01"), ("2026-09-01", "2026-08-31")):
        for day in (first, second):
            got = pricing.cost_of_model("claude-sonnet-5", 1_000_000, 1_000_000, at=day)
            assert abs(got - want[day]) < 1e-9, (first, second, day, got)
    # The same claim at the resolver, where the wrong answer would be a whole entry.
    inside = pricing.resolve_model("claude-sonnet-5", "2026-08-31")
    outside = pricing.resolve_model("claude-sonnet-5", "2026-09-01")
    assert inside["in"] == 2 and inside["out"] == 10, inside
    assert outside["in"] == 3 and outside["out"] == 15, outside


def test_the_resolution_index_matches_a_brute_force_scan_id_for_id():
    """The index replaced a linear scan over `_entry_matches`, which is now the
    SPECIFICATION rather than the hot path. Prove they agree -- by entry IDENTITY, not by
    equality, because two entries with equal rates would hide a changed tie-break that a
    later price edit would then expose.

    Includes the fail-closed near-misses: an id the catalog has never seen must resolve
    to nothing in BOTH implementations. An index built with any prefix or fuzzy fallback
    is exactly the failure `_entry_matches` was written to prevent.
    """
    ids = []
    for e in pricing.CATALOG:
        ids.append(e["id"])
        ids.extend(e.get("aliases") or [])
    ids += ["claude-opus-4-9", "claude-sonnet-5-2", "gpt-5.6", "gpt-5-codex",
            "o3-deep-research", "claude-opus-6", "grok-5", "llama-4-maverick",
            "us.anthropic.claude-opus-5", "claude-opus-5-20260101",
            "CLAUDE-OPUS-5", "openrouter/claude-opus-5", "", None]
    for model_id in ids:
        cand = pricing.canonical(model_id)
        scan = None
        if cand:
            for entry in pricing.CATALOG:
                if pricing._entry_matches(cand, entry):
                    scan = entry
                    break
        indexed = pricing._catalog_index().get(cand) if cand else None
        assert indexed is scan, model_id


def test_an_in_place_catalog_edit_is_never_served_from_a_stale_memo():
    """The suite transcribes promotional windows onto catalog entries at runtime
    (promo_window_on), so the memo has to notice. Warm it on the row's day BEFORE the
    edit, edit, read again, then leave the block and read a third time. A memo that
    trusted its key alone would return the pre-edit price at step two and the promo price
    at step three -- both wrong, and both invisible.
    """
    list_price = pricing.cost_of_model("claude-fable-5", 1_000_000, 1_000_000, at=OLD_DAY)
    assert abs(list_price - 60.0) < 1e-9, list_price          # warm: no window
    with promo_window_on("claude-fable-5", FABLE_2019_PROMO):
        promo = pricing.cost_of_model("claude-fable-5", 1_000_000, 1_000_000, at=OLD_DAY)
        assert abs(promo - 0.2) < 1e-9, promo                 # window seen immediately
    after = pricing.cost_of_model("claude-fable-5", 1_000_000, 1_000_000, at=OLD_DAY)
    assert abs(after - 60.0) < 1e-9, after                    # ...and given back again
    # The explicit hook clears everything without changing any answer.
    pricing.invalidate_catalog_cache()
    assert abs(pricing.cost_of_model("claude-fable-5", 1_000_000, 1_000_000, at=OLD_DAY)
               - 60.0) < 1e-9


# ---------------------------------------------------------------------------
# Durability: a write either LANDS or is COUNTED. There is no third outcome.
# ---------------------------------------------------------------------------
#
# app.py fires record() from `_fire()`, inside
#     except Exception: pass  # metrics must never break the proxied response
# so an exception raised here is swallowed one frame up. That is the right call for the
# PROXY -- a monitoring write must never break a user's request -- but it means the
# counters below are the ONLY trace a lost write leaves anywhere. record() therefore
# both raises AND counts, exactly like `rejected_ts`.

RECORD_KW = dict(tier="haiku", model="claude-haiku-4-5",
                 original_model="claude-opus-5", requested_tier="opus",
                 reason="simple", in_tokens=1000, out_tokens=500,
                 status=200, usage_source="body", session="c")


def test_the_store_runs_in_wal_with_a_bounded_sync():
    """WAL is not a preference here, it is the fix for a measured starvation. Under the
    default rollback journal a commit needs an EXCLUSIVE lock and cannot take one while
    any reader holds SHARED; measured on this machine, a reader holding an open read
    transaction refused the writer with "database is locked" after the full busy timeout,
    and the row was gone. Under WAL the same reader costs the writer 0.000s.

    `synchronous` is asserted on a FRESH connection on purpose: unlike journal_mode it is
    NOT persisted in the database header, so a connection that does not re-send it comes
    back at the FULL default and record() gets none of the setting.
    """
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        assert m.journal_mode == "wal", m.journal_mode
        # Read it back off the FILE, not off the object that claims to have set it.
        c = sqlite3.connect(path)
        try:
            assert c.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        finally:
            c.close()
        c2 = m._conn()
        try:
            assert c2.execute("PRAGMA synchronous").fetchone()[0] == 1   # NORMAL
            assert c2.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
        finally:
            c2.close()
        dur = m.summary()["durability"]
        assert dur["journal_mode"] == "wal"
        assert dur["journal_mode_error"] == ""
        assert dur["synchronous"] == "NORMAL"
        assert dur["busy_timeout_ms"] == 5000


class _WalRefusingConn:
    """A real connection that refuses exactly one statement: the WAL upgrade.

    Wrapped rather than monkeypatched because `sqlite3.Connection.execute` is read-only,
    and subclassed into Metrics rather than patched onto the module because `_conn()` is
    called from inside `__init__`, before an instance exists to patch.
    """

    def __init__(self, inner):
        self._inner = inner

    def execute(self, sql, *rest):
        if "journal_mode=WAL" in sql:
            raise sqlite3.OperationalError("database is locked")
        return self._inner.execute(sql, *rest)

    def __getattr__(self, name):
        return getattr(self._inner, name)


class _WalRefusingMetrics(Metrics):
    def _conn(self):
        return _WalRefusingConn(Metrics._conn(self))


def test_a_refused_wal_upgrade_is_reported_and_does_not_kill_the_gateway():
    """The one-time WAL upgrade needs a moment of exclusive access, so a process holding
    the database as the gateway starts can refuse it with SQLITE_BUSY. app.py builds
    METRICS at import time, so raising there would turn a transient lock into a dead
    proxy -- but hiding the refusal would leave the store quietly back on the rollback
    journal, which is the exact state this change exists to make visible.

    So: construction survives, and the mode ACTUALLY in force is read back and reported
    with SQLite's own reason attached. Nothing is discarded and nothing is asserted.
    """
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = _WalRefusingMetrics(db_path=path)
        assert m.journal_mode == "delete", m.journal_mode      # the SQLite default
        assert "locked" in m.journal_mode_error
        dur = m.summary()["durability"]
        assert dur["journal_mode"] == "delete"
        assert dur["journal_mode_error"] == m.journal_mode_error
        # ...and the store is still usable, which is the reason for not raising.
        assert m.record(request_id="after_refusal", **RECORD_KW) is True
        assert m.logs(session="c")["total"] == 1


def test_an_external_reader_cannot_starve_the_writer():
    """THE DURABILITY REGRESSION TEST, written as the real exposure rather than as the
    pragma. self._lock already serialises the gateway's OWN writers inside one uvicorn
    process, so the threat model is EXTERNAL: `cheaper peek`, the desktop app or a
    sqlite3 shell reading ~/.cheaper/metrics.db while the gateway commits.

    A second connection holds an open read transaction for the whole of the write. Under
    WAL the writer never contends with it. Under the rollback journal the commit blocks
    for the busy timeout, on all three attempts, and then raises -- into app.py's
    `except Exception: pass`, where the routed call disappears.
    """
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        m.record(request_id="seed", **RECORD_KW)
        reader = sqlite3.connect(path, timeout=1, isolation_level=None)
        try:
            reader.execute("BEGIN")
            # The SELECT is what actually takes the lock; BEGIN alone is deferred.
            reader.execute("SELECT COUNT(*) FROM decisions").fetchone()
            t0 = time.perf_counter()
            stored = m.record(request_id="under_reader", **RECORD_KW)
            elapsed = time.perf_counter() - t0
        finally:
            reader.execute("ROLLBACK")
            reader.close()
        assert stored is True
        # Generous by two orders of magnitude against the 5s busy timeout the rollback
        # journal would burn -- this asserts "did not contend", not a latency budget.
        assert elapsed < 1.0, "writer waited %.3fs behind an external reader" % elapsed
        assert m.write_failures == 0
        assert m.write_retries == 0
        assert m.logs(session="c")["total"] == 2


class _AlwaysLocked:
    """A connection stand-in that refuses exactly the way a lock contest does."""

    def __init__(self):
        self.attempts = 0

    def execute(self, *_a, **_kw):
        self.attempts += 1
        raise sqlite3.OperationalError("database is locked")

    def commit(self):                       # pragma: no cover - never reached
        raise AssertionError("commit() after a refused execute()")

    def close(self):
        pass


def test_a_write_that_never_lands_is_counted_and_raised_never_silent():
    """A refused write used to leave NO trace: record() raised, app.py's `_fire()`
    swallowed the exception, and the routed call was simply missing from every figure the
    dashboard drew. A shrinking denominator nobody announces reads exactly like a quiet
    week. It is now retried a bounded number of times, then COUNTED, then re-raised --
    all three, not one of them.
    """
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        fake = _AlwaysLocked()
        m._conn = lambda: fake
        try:
            with pytest.raises(sqlite3.OperationalError):
                m.record(request_id="never_lands", **RECORD_KW)
        finally:
            del m._conn                 # unshadow the real method
        assert fake.attempts == metrics_mod.WRITE_ATTEMPTS, fake.attempts
        assert m.write_failures == 1
        assert m.write_retries == 0     # nothing ever succeeded, so nothing "retried OK"
        assert m.logs(session="c")["total"] == 0
        # ...and it is VISIBLE, which is the whole point of counting it.
        assert m.summary()["durability"]["write_failures"] == 1


def test_a_transient_lock_is_retried_and_the_row_still_lands():
    """The bounded retry is the backstop behind WAL, for the residual race WAL does not
    remove (a checkpoint, an exclusive-locking client). One refusal must not cost a row,
    and the fact that a retry was needed must still be legible."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        real_conn = m._conn
        calls = {"n": 0}

        def flaky():
            calls["n"] += 1
            if calls["n"] == 1:
                raise sqlite3.OperationalError("database is locked")
            return real_conn()

        m._conn = flaky
        try:
            stored = m.record(request_id="retried", **RECORD_KW)
        finally:
            del m._conn
        assert stored is True
        assert calls["n"] == 2
        assert m.write_retries == 1
        assert m.write_failures == 0
        assert m.logs(session="c")["total"] == 1
        assert m.summary()["durability"]["write_retries"] == 1


def test_a_suppressed_duplicate_is_counted_not_indistinguishable_from_a_write():
    """INSERT OR IGNORE against the partial unique index on request_id is what makes a
    replayed write idempotent instead of a double count -- the single most important
    property of a financial record. But `cursor.rowcount` was never inspected, so
    "stored" and "silently discarded" were the same observable at every layer: record()
    returned None either way and nothing was tallied. A replay storm and a healthy
    gateway looked identical from outside.
    """
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        assert m.record(request_id="rid_1", **RECORD_KW) is True
        assert m.record(request_id="rid_1", **RECORD_KW) is False
        assert m.duplicate_suppressed == 1
        assert m.logs(session="c")["total"] == 1
        assert m.summary(session="c")["durability"]["duplicate_suppressed"] == 1
        # A row with NO provider id is NOT a duplicate. The unique index is PARTIAL
        # (`WHERE request_id IS NOT NULL`) precisely so that pre-migration rows, which
        # all have request_id NULL, do not collapse into one another.
        assert m.record(request_id=None, **RECORD_KW) is True
        assert m.record(request_id=None, **RECORD_KW) is True
        assert m.duplicate_suppressed == 1
        assert m.logs(session="c")["total"] == 3
        # The suppression must not be mistaken for a failure, nor vice versa.
        assert m.write_failures == 0


def test_the_durability_block_says_what_it_is_scoped_to():
    """The counters are PROCESS-LOCAL and NOT session-scoped: they describe writes this
    gateway attempted since it started, not rows in the store. A reader who takes a
    per-chat summary's `durability` for a per-chat figure would be reading it wrong, so
    pin the behaviour rather than leaving it to the comment."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "m.db")
        m = Metrics(db_path=path)
        m.record(request_id="dup", **dict(RECORD_KW, session="chatA"))
        m.record(request_id="dup", **dict(RECORD_KW, session="chatA"))
        for scope in (None, "chatA", "chatB", ""):
            s = m.summary() if scope is None else m.summary(session=scope)
            assert s["durability"]["duplicate_suppressed"] == 1, scope
            assert s["durability"]["write_failures"] == 0, scope
            assert s["durability"]["rejected_ts"] == 0, scope
        # rejected_ts was already counted but never surfaced anywhere; it is the same
        # class of invisible drop and now rides in the same block.
        with pytest.raises(ValueError):
            m.record(request_id="ms_units", ts=1700000000000.0, **RECORD_KW)
        assert m.summary()["durability"]["rejected_ts"] == 1
