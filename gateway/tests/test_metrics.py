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
