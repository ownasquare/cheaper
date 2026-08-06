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
        for _ in range(5):
            m.record(tier="haiku", model="h", original_model="opus", requested_tier="opus",
                     reason="simple", in_tokens=1000, out_tokens=500, session="chatA")
        for _ in range(2):
            m.record(tier="opus", model="o", original_model="opus", requested_tier="opus",
                     reason="hard", in_tokens=1000, out_tokens=500, session="chatB")
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


def test_tokens_downgraded_is_reported():
    with tempfile.TemporaryDirectory() as d:
        m = Metrics(db_path=os.path.join(d, "m.db"))
        for _ in range(4):  # opus requested, routed to haiku → downgraded
            m.record(tier="haiku", model="h", original_model="claude-opus-4",
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
