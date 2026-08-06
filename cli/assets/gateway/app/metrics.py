"""Lightweight, dependency-free monitoring for the Cheaper gateway.

Every routing decision is recorded to a SQLite file so the CLI, the desktop app,
and the /dashboard endpoint can show that routing is actually happening and how much
it's saving. SQLite (stdlib) keeps it durable across restarts with zero extra deps.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time
from contextlib import closing

# Rough relative $/Mtok weights, only used to ESTIMATE savings vs "always top tier".
# Override with env if you have exact numbers; the ratios are what matter here.
DEFAULT_PRICE = {"haiku": 1.0, "sonnet": 3.0, "opus": 15.0}


def _price() -> dict:
    out = {}
    for tier, dflt in DEFAULT_PRICE.items():
        try:
            out[tier] = float(os.environ.get(f"CHEAPER_PRICE_{tier.upper()}", dflt))
        except ValueError:
            out[tier] = dflt
    return out


class Metrics:
    def __init__(self, db_path: str | None = None):
        self.db_path = db_path or os.environ.get(
            "CHEAPER_DB", os.path.join(os.path.expanduser("~"), ".cheaper", "metrics.db"))
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._lock = threading.Lock()
        self.price = _price()
        with closing(self._conn()) as c:
            c.execute("""
                CREATE TABLE IF NOT EXISTS decisions (
                    ts REAL, tier TEXT, model TEXT, original_model TEXT,
                    requested_tier TEXT, reason TEXT, source TEXT,
                    in_tokens INTEGER, out_tokens INTEGER, status INTEGER
                )""")
            c.commit()

    def _conn(self):
        return sqlite3.connect(self.db_path, timeout=5)

    def record(self, *, tier, model, original_model, requested_tier, reason,
               source="", in_tokens=0, out_tokens=0, status=0):
        with self._lock, closing(self._conn()) as c:
            c.execute(
                "INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?)",
                (time.time(), tier, model, original_model, requested_tier,
                 reason[:300], source, in_tokens, out_tokens, status))
            c.commit()

    def summary(self) -> dict:
        with closing(self._conn()) as c:
            rows = c.execute("SELECT tier, COUNT(*), SUM(in_tokens), SUM(out_tokens) "
                             "FROM decisions GROUP BY tier").fetchall()
            total = c.execute("SELECT COUNT(*) FROM decisions").fetchone()[0] or 0
            recent = c.execute(
                "SELECT ts, tier, original_model, reason, source FROM decisions "
                "ORDER BY ts DESC LIMIT 20").fetchall()
        by_tier = {t: {"count": n, "in_tokens": it or 0, "out_tokens": ot or 0}
                   for (t, n, it, ot) in rows}
        # Estimated savings vs. running everything at the top tier.
        top = max(self.price, key=self.price.get)
        spent = billed_top = 0.0
        for t, d in by_tier.items():
            toks = (d["in_tokens"] + d["out_tokens"]) / 1_000_000
            spent += toks * self.price.get(t, 0)
            billed_top += toks * self.price[top]
        saved = billed_top - spent
        pct = (saved / billed_top * 100) if billed_top else 0.0
        return {
            "total": total,
            "by_tier": by_tier,
            "downgrade_rate": round(
                sum(d["count"] for t, d in by_tier.items() if t != top) / total * 100, 1
            ) if total else 0.0,
            "est_spend_units": round(spent, 3),
            "est_savings_units": round(saved, 3),
            "est_savings_pct": round(pct, 1),
            "recent": [
                {"ts": ts, "tier": tier, "original_model": om,
                 "reason": reason, "source": src}
                for (ts, tier, om, reason, src) in recent
            ],
        }
