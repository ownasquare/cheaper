import time
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
from metrics import Metrics  # noqa: E402


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
