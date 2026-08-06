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

# Real-dollar pricing (shared with the `peek` CLI). Guarded so the gateway still
# runs if pricing.py is absent — it then falls back to the tier-weight estimate.
try:
    from pricing import estimate_call, cost_of, detect_family  # type: ignore
    _PRICING = True
except Exception:  # pragma: no cover - transitional / import-order safety
    _PRICING = False


def _clean_tool(src: str) -> str:
    s = (src or "").strip()
    return s[:48] if s else "unknown"

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


# --- Reasoning effort + time model (illustrative, measure-only) ---------------
# Cheaper routes the MODEL for real (realized $ savings). Reasoning effort is only
# MEASURED here: on a triage-simple request that asked for high reasoning, we show
# how many thinking tokens and how much wall-clock could be saved by lowering it —
# without altering the request. All figures are coarse, tunable ballparks.
_EFFORT_RANK = {"none": 0, "low": 1, "medium": 2, "high": 3}
# thinking tokens a given effort level typically burns (potential token saving).
_THINK_TOKENS = {"none": 0, "low": 600, "medium": 2500, "high": 8000}
# wall-clock seconds: a base per model tier + extra per reasoning effort.
_LAT_TIER = {"haiku": 1.2, "sonnet": 3.0, "opus": 7.0}
_LAT_EFFORT = {"none": 0.0, "low": 1.5, "medium": 6.0, "high": 18.0}


def normalize_effort(value) -> str:
    """Map an assortment of request shapes to none|low|medium|high."""
    if value is None:
        return "none"
    v = str(value).strip().lower()
    if v in _EFFORT_RANK:
        return v
    if v in ("minimal", "off", "disabled", "false", "0"):
        return "none"
    if v in ("max", "maximum", "xhigh", "extra"):
        return "high"
    return "none"


def _source_bucket(src: str) -> str:
    s = (src or "").lower()
    if "subagent" in s or "sidechain" in s or "sub-agent" in s:
        return "subagent"
    if s and s != "unknown":
        return "user"
    return "other"


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
            # Additive migration: reasoning effort the caller requested (measure-only).
            try:
                c.execute("ALTER TABLE decisions ADD COLUMN requested_effort TEXT")
            except sqlite3.OperationalError:
                pass  # column already exists
            # Additive migration: the chat/session id, so peek can attribute EXACT
            # realized savings to ONE conversation for the end-of-chat tagline.
            try:
                c.execute("ALTER TABLE decisions ADD COLUMN session TEXT")
            except sqlite3.OperationalError:
                pass  # column already exists
            c.commit()

    def _conn(self):
        return sqlite3.connect(self.db_path, timeout=5)

    def record(self, *, tier, model, original_model, requested_tier, reason,
               source="", in_tokens=0, out_tokens=0, status=0, requested_effort="",
               session=""):
        with self._lock, closing(self._conn()) as c:
            c.execute(
                "INSERT INTO decisions "
                "(ts, tier, model, original_model, requested_tier, reason, source, "
                " in_tokens, out_tokens, status, requested_effort, session) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (time.time(), tier, model, original_model, requested_tier,
                 reason[:300], source, in_tokens, out_tokens, status,
                 normalize_effort(requested_effort), session or ""))
            c.commit()

    def summary(self, *, ts_bucket: int = 3600, max_rows: int = 5000,
                session: str | None = None) -> dict:
        # Optional per-chat scoping: `cheaper peek --tagline` passes ?session=<id> so
        # the end-of-chat line reports EXACT realized savings for one conversation
        # instead of the whole rolling ledger.
        # Distinguish None (no filter → whole ledger, e.g. the dashboard) from a
        # present session value (scope to that chat). An EMPTY string is a real value,
        # so a blank ?session= scopes to the empty-session rows — it never silently
        # falls back to the whole ledger and over-exposes other chats.
        where = " WHERE session = ?" if session is not None else ""
        sp = (session,) if session is not None else ()
        with closing(self._conn()) as c:
            rows = c.execute("SELECT tier, COUNT(*), SUM(in_tokens), SUM(out_tokens) "
                             "FROM decisions" + where + " GROUP BY tier", sp).fetchall()
            total = c.execute("SELECT COUNT(*) FROM decisions" + where, sp).fetchone()[0] or 0
            recent = c.execute(
                "SELECT ts, tier, original_model, reason, source FROM decisions" + where +
                " ORDER BY ts DESC LIMIT 20", sp).fetchall()
            detail = c.execute(
                "SELECT ts, tier, original_model, in_tokens, out_tokens, source, "
                "requested_tier, requested_effort "
                "FROM decisions" + where + " ORDER BY ts DESC LIMIT ?",
                sp + (max_rows,)).fetchall()
        by_tier = {t: {"count": n, "in_tokens": it or 0, "out_tokens": ot or 0}
                   for (t, n, it, ot) in rows}

        # --- Legacy tier-weight estimate (kept for back-compat) ---
        top = max(self.price, key=self.price.get)
        spent_u = billed_top_u = 0.0
        for t, d in by_tier.items():
            toks = (d["in_tokens"] + d["out_tokens"]) / 1_000_000
            spent_u += toks * self.price.get(t, 0)
            billed_top_u += toks * self.price[top]
        saved_u = billed_top_u - spent_u
        pct_u = (saved_u / billed_top_u * 100) if billed_top_u else 0.0

        # --- Real-dollar aggregation (per row) via pricing.py: what you would have
        #     paid at the model you requested vs. what Cheaper actually spent. ---
        dollars = {"saved": 0.0, "spent": 0.0, "billed_top": 0.0, "savings_pct": 0.0}
        by_tool_acc: dict = {}
        ts_acc: dict = {}
        models_changed = 0
        tokens_downgraded = 0
        downgraded_by_tier = {"haiku": 0, "sonnet": 0, "opus": 0}
        reasoning_opps = 0
        tokens_saved_potential = 0
        time_saved_model = 0.0
        time_saved_reasoning = 0.0
        by_source_acc = {b: {"calls": 0, "saved": 0.0, "spent": 0.0}
                         for b in ("user", "subagent", "other")}
        if _PRICING:
            for (ts, tier, om, it, ot, src, rtier, reff) in detail:
                it = it or 0
                ot = ot or 0
                est = estimate_call(om, it, ot, tier)  # content tier = tier Cheaper chose
                saved = est["saved"]
                spent = est["new_cost"]
                billed_top = cost_of(est["family"], "opus", it, ot) if detect_family(om) else 0.0
                dollars["saved"] += saved
                dollars["spent"] += spent
                dollars["billed_top"] += billed_top
                tool = _clean_tool(src)
                a = by_tool_acc.setdefault(
                    tool, {"tool": tool, "calls": 0, "saved": 0.0, "spent": 0.0, "down": 0})
                a["calls"] += 1
                a["saved"] += saved
                a["spent"] += spent
                if est["downgraded"]:
                    a["down"] += 1
                    models_changed += 1
                    tokens_downgraded += it + ot
                    downgraded_by_tier[tier] = downgraded_by_tier.get(tier, 0) + 1
                b = int(ts // ts_bucket) * ts_bucket
                g = ts_acc.setdefault(b, {"t": b, "saved": 0.0, "spent": 0.0, "calls": 0})
                g["saved"] += saved
                g["spent"] += spent
                g["calls"] += 1
                # Realized TIME saved from the model downgrade: requested-tier latency
                # minus the chosen tier's latency.
                at = (rtier or "").strip().lower()
                if at not in _LAT_TIER:
                    at = tier  # unknown -> no delta
                time_saved_model += max(0.0, _LAT_TIER.get(at, _LAT_TIER["sonnet"])
                                        - _LAT_TIER.get(tier, 0.0))
                # Measure-only REASONING opportunity: a triage-simple (haiku) request
                # that asked for medium/high reasoning could drop tokens + wall-clock.
                eff = normalize_effort(reff)
                if tier == "haiku" and _EFFORT_RANK.get(eff, 0) >= 2:
                    reasoning_opps += 1
                    tokens_saved_potential += _THINK_TOKENS.get(eff, 0)
                    time_saved_reasoning += max(0.0, _LAT_EFFORT.get(eff, 0.0)
                                                - _LAT_EFFORT["low"])
                bs = by_source_acc[_source_bucket(src)]
                bs["calls"] += 1
                bs["saved"] += saved
                bs["spent"] += spent
            actual_total = dollars["saved"] + dollars["spent"]
            dollars["savings_pct"] = round(dollars["saved"] / actual_total * 100, 1) if actual_total else 0.0
            for k in ("saved", "spent", "billed_top"):
                dollars[k] = round(dollars[k], 4)
        else:
            dollars = {"saved": round(saved_u, 4), "spent": round(spent_u, 4),
                       "billed_top": round(billed_top_u, 4), "savings_pct": round(pct_u, 1)}

        by_tool = sorted(
            ({"tool": a["tool"], "calls": a["calls"], "saved": round(a["saved"], 4),
              "spent": round(a["spent"], 4),
              "downgrade_rate": round(a["down"] / a["calls"] * 100, 1) if a["calls"] else 0.0}
             for a in by_tool_acc.values()),
            key=lambda x: x["saved"], reverse=True)
        points = [{"t": g["t"], "saved": round(g["saved"], 4),
                   "spent": round(g["spent"], 4), "calls": g["calls"]}
                  for g in sorted(ts_acc.values(), key=lambda x: x["t"])]

        return {
            "total": total,
            "by_tier": by_tier,
            "downgrade_rate": round(
                sum(d["count"] for t, d in by_tier.items() if t != top) / total * 100, 1
            ) if total else 0.0,
            "dollars": dollars,
            "by_tool": by_tool,
            "timeseries": {"bucket_seconds": ts_bucket, "points": points},
            "counts": {
                "intercepted": total,
                "models_changed": models_changed,
                "reasoning_opportunities": reasoning_opps,
            },
            "tokens": {"saved_reasoning_potential": tokens_saved_potential,
                       "downgraded": tokens_downgraded},
            # Per-tier count of the DOWNGRADED (money-saving) rows — what Cheaper routed
            # to cheaper tiers, so the tagline breakdown excludes at-ceiling main-loop calls.
            "downgraded_by_tier": downgraded_by_tier,
            "time": {
                "saved_model_s": round(time_saved_model, 1),
                "saved_reasoning_potential_s": round(time_saved_reasoning, 1),
            },
            "by_source": {
                k: {"calls": v["calls"], "saved": round(v["saved"], 4),
                    "spent": round(v["spent"], 4)}
                for k, v in by_source_acc.items()
            },
            "baselines": {
                # Money saved vs each baseline. 'historical' is filled by the dashboard
                # from /peek (the CLI's chat-history analysis).
                "requested_default": dollars["saved"],
                "highest_tier": round(max(0.0, dollars["billed_top"] - dollars["spent"]), 4),
            },
            # legacy compat fields:
            "est_spend_units": round(spent_u, 3),
            "est_savings_units": round(saved_u, 3),
            "est_savings_pct": round(pct_u, 1),
            "recent": [
                {"ts": ts, "tier": tier, "original_model": om,
                 "reason": reason, "source": src}
                for (ts, tier, om, reason, src) in recent
            ],
        }
