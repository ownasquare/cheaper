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
from datetime import datetime, timedelta, timezone

# Real-dollar pricing (shared with the `peek` CLI). Guarded so the gateway still
# runs if pricing.py is absent — it then falls back to the tier-weight estimate.
try:
    from pricing import (  # type: ignore
        estimate_call, cost_of, detect_family, cost_of_model, is_priceable,
        CATALOG_AS_OF,
    )
    _PRICING = True
except Exception:  # pragma: no cover - transitional / import-order safety
    _PRICING = False


def _day(ts):
    """UTC date a row was recorded, so it prices at the rates in force THEN rather
    than at today's -- a historical figure must not move when a promo window shuts."""
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return None


def _age_days(as_of: str):
    """Whole days since the catalog was transcribed, or None if unparseable."""
    try:
        d = datetime.strptime(as_of, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        return max(0, (datetime.now(timezone.utc) - d).days)
    except Exception:
        return None


def _clean_tool(src: str) -> str:
    s = (src or "").strip()
    return s[:48] if s else "unknown"

# Relative $/Mtok input weights for the legacy tier-weight estimate below. Only the
# RATIOS matter here, but they still have to be the ratios of models that exist:
# these are the input rates of the current Anthropic representatives in
# model_prices.json (Haiku 4.5 $1, Sonnet 5 $3, Opus 5 $5). The old 1:3:15 spread
# was the retired Opus 4 rate and overstated top-tier work threefold. The real-dollar
# figures the user actually sees come from pricing.py per row, not from this table.
DEFAULT_PRICE = {"haiku": 1.0, "sonnet": 3.0, "opus": 5.0}


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


# Cost-ordered tier ranks for the Logs decision-type derivation. Kept separate from
# any capability ranking on purpose: the only thing that matters for "downgrade vs
# escalate" is whether the SERVED tier is cheaper or dearer than what was REQUESTED.
_TIER_RANK = {"haiku": 0, "sonnet": 1, "opus": 2}


def _decision_type(requested_tier, routed_tier) -> str:
    """Classify a routed row for the Logs table.

    downgrade -> routed to a cheaper tier than requested (the money-saving case).
    escalate  -> routed to a dearer tier than requested.
    kept      -> same tier, or either side unknown (e.g. the OpenAI front-end never
                 records a requested tier, so its rows read as 'kept' rather than
                 being mislabelled as a downgrade).
    """
    rq = _TIER_RANK.get((requested_tier or "").strip().lower())
    rt = _TIER_RANK.get((routed_tier or "").strip().lower())
    if rq is None or rt is None:
        return "kept"
    if rt < rq:
        return "downgrade"
    if rt > rq:
        return "escalate"
    return "kept"


def row_is_priceable(status, usage_source) -> tuple[bool, str]:
    """May this row contribute to a DOLLAR figure? Returns (ok, reason_when_not).

    Two independent exclusions, both fail-closed:

    * ``usage_source == 'estimate'`` -- nobody reported usage for this call, so any
      figure derived from it is a guess wearing a measurement's clothes.
    * a status the gateway actually observed that is outside 2xx -- Claude Code retries
      ``overloaded_error`` and 429s automatically, and each retry gets a DISTINCT
      ``anthropic-request-id``, so the provider key cannot collapse them. A six-retry
      storm on one turn would otherwise book six times the saving for one delivered
      answer.

    Status ``0``/NULL means UNKNOWN, not "failed": every row written before the column
    was populated reads as 0, and excluding those would blank the whole existing
    ledger. Unknown-status rows are priced and counted separately so the ambiguity is
    visible rather than assumed away.
    """
    if (usage_source or "").strip().lower() == "estimate":
        return False, "estimated_usage"
    try:
        st = int(status or 0)
    except (TypeError, ValueError):
        st = 0
    if st and not (200 <= st < 300):
        return False, "non_2xx"
    return True, ""


def _period_starts(now: datetime | None = None) -> dict:
    """Epoch-second lower bounds for Today / week / month / quarter / year / all-time,
    computed in LOCAL time so the buckets line up with the user's wall clock. A row
    counts toward a period when its ts is >= that period's start."""
    now = now or datetime.now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week = today - timedelta(days=today.weekday())          # Monday-anchored week
    month = today.replace(day=1)
    quarter = today.replace(month=((now.month - 1) // 3) * 3 + 1, day=1)
    year = today.replace(month=1, day=1)
    return {
        "today": today.timestamp(),
        "week": week.timestamp(),
        "month": month.timestamp(),
        "quarter": quarter.timestamp(),
        "year": year.timestamp(),
        "all": 0.0,
    }


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
            # Additive migration: the prompt-cache split. Cache reads bill at ~0.1x
            # fresh input and 1-hour writes at 2x, so a row without this breakdown is
            # priced as if every input token were fresh -- badly wrong for any harness
            # that uses prompt caching, which is most of them.
            for _col in ("cache_read", "cache_create_5m", "cache_create_1h"):
                try:
                    c.execute(f"ALTER TABLE decisions ADD COLUMN {_col} INTEGER DEFAULT 0")
                except sqlite3.OperationalError:
                    pass  # column already exists
            # Additive migration: the chat/session id, so peek can attribute EXACT
            # realized savings to ONE conversation for the end-of-chat tagline.
            try:
                c.execute("ALTER TABLE decisions ADD COLUMN session TEXT")
            except sqlite3.OperationalError:
                pass  # column already exists
            # Additive migration: the PROVIDER's own idempotency key, plus how the
            # token counts on this row were obtained.
            #
            #   request_id  `anthropic-request-id` / `request-id` / `x-request-id`.
            #               Measured 1:1 with the API call over 12,741 transcript rows
            #               (0 of 5,127 request ids mapped to more than one message id).
            #               It is the join key the per-call event store dedupes on --
            #               and, critically, it SURVIVES a resume/fork/rotate, which a
            #               positional index or a content hash does not.
            #   message_id  the assistant message id, a second strong key for the
            #               buffered path where the body is in hand.
            #   usage_source 'body'    provider-reported usage  -> priceable
            #                'estimate' we had to guess         -> NEVER priced
            for _col in ("request_id", "message_id", "usage_source"):
                try:
                    c.execute(f"ALTER TABLE decisions ADD COLUMN {_col} TEXT")
                except sqlite3.OperationalError:
                    pass  # column already exists
            # The 16 heaviest rows on the live DB are invisible to every scoped query:
            # `WHERE session = ''` does not match `session IS NULL`, so the sum of the
            # per-session totals did not equal the ungrouped total -- by 1,890,068 of
            # 1,890,408 in-tokens. Normalise the sentinel so one comparison covers both.
            c.execute("UPDATE decisions SET session = '' WHERE session IS NULL")
            # Zero indexes existed. Every query here is ORDER BY ts DESC, optionally
            # filtered by session.
            c.execute("CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts DESC)")
            c.execute("CREATE INDEX IF NOT EXISTS idx_decisions_sess "
                      "ON decisions(session, ts DESC)")
            # PARTIAL unique index: pre-migration rows all have request_id NULL and must
            # not collide with each other (SQLite treats NULLs as distinct in a plain
            # UNIQUE index, but the partial predicate makes the intent explicit and keeps
            # the index small). Paired with INSERT OR IGNORE in record(), a retried or
            # replayed write for the same provider call is a no-op instead of a double
            # count -- the single most important property of a financial record.
            c.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_decisions_rid "
                      "ON decisions(request_id) WHERE request_id IS NOT NULL")
            c.commit()

    def _conn(self):
        return sqlite3.connect(self.db_path, timeout=5)

    def record(self, *, tier, model, original_model, requested_tier, reason,
               source="", in_tokens=0, out_tokens=0, status=0, requested_effort="",
               session="", cache_read=0, cache_create_5m=0, cache_create_1h=0,
               request_id=None, message_id=None, usage_source=None, ts=None):
        """Append one routed call.

        `INSERT OR IGNORE` + the partial unique index on request_id makes this
        IDEMPOTENT for any call the provider gave us an id for: a retried write, a
        replayed buffer, or two code paths both recording the same forward all collapse
        to one row. Without it the store double-counts silently, which is the failure
        this whole workstream exists to eliminate.

        `in_tokens` may be None. That is a real state -- "the provider did not report
        usage" -- and it is stored as NULL rather than as a character-count guess.
        The old `len(extract_text(body)) // 4` fallback substituted the whole
        conversation's size for the FRESH input count; measured against real traffic
        that is wrong by ~34,000x, and it printed with no hedge.
        """
        us = (usage_source or "").strip().lower()
        if us not in ("body", "estimate"):
            # '' = unknown (a legacy row, or a caller that predates the column).
            # Deliberately NOT defaulted to 'body': claiming a figure is measured when
            # nobody said so is exactly the concealment shape this column exists to end.
            us = ""
        with self._lock, closing(self._conn()) as c:
            c.execute(
                "INSERT OR IGNORE INTO decisions "
                "(ts, tier, model, original_model, requested_tier, reason, source, "
                " in_tokens, out_tokens, status, requested_effort, session, "
                " cache_read, cache_create_5m, cache_create_1h, "
                " request_id, message_id, usage_source) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (float(ts) if ts is not None else time.time(),
                 tier, model, original_model, requested_tier,
                 reason[:300], source,
                 None if in_tokens is None else int(in_tokens),
                 None if out_tokens is None else int(out_tokens),
                 status,
                 normalize_effort(requested_effort), session or "",
                 int(cache_read or 0), int(cache_create_5m or 0), int(cache_create_1h or 0),
                 (str(request_id)[:120] or None) if request_id else None,
                 (str(message_id)[:120] or None) if message_id else None,
                 us))
            c.commit()

    def logs(self, *, limit: int = 100, offset: int = 0,
             session: str | None = None) -> dict:
        """Paginated, most-recent-first feed of routing decisions for the Logs table.

        Each row prices BOTH legs at their exact models so the table can show the real
        realized cost delta: `original_cost` is what the caller's requested model would
        have cost at this row's tokens, `actual_cost` is what the served model cost,
        and `savings` is their signed difference (negative on an escalation). Cache
        splits and the row's historical price date are honoured, exactly like summary()
        -- so a row's numbers here reconcile with the aggregate figures elsewhere.

        `session` mirrors summary()'s semantics: None = whole ledger; a present value
        (including "") scopes to that chat and never silently widens.
        """
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = 100
        try:
            offset = int(offset)
        except (TypeError, ValueError):
            offset = 0
        limit = max(1, min(limit, 1000))
        offset = max(0, offset)
        where = " WHERE session = ?" if session is not None else ""
        sp = (session,) if session is not None else ()
        with closing(self._conn()) as c:
            total = c.execute("SELECT COUNT(*) FROM decisions" + where, sp).fetchone()[0] or 0
            raw = c.execute(
                "SELECT ts, tier, model, original_model, requested_tier, reason, source, "
                "in_tokens, out_tokens, "
                "COALESCE(cache_read,0), COALESCE(cache_create_5m,0), COALESCE(cache_create_1h,0), "
                "COALESCE(session,''), COALESCE(status,0), COALESCE(usage_source,''), "
                "COALESCE(request_id,'') "
                "FROM decisions" + where + " ORDER BY ts DESC LIMIT ? OFFSET ?",
                sp + (limit, offset)).fetchall()
        rows = []
        for (ts, tier, served, om, rtier, reason, src, it, ot, cr, c5, c1,
             sess, status, usrc, rid) in raw:
            it = it or 0
            ot = ot or 0
            original_cost = actual_cost = savings = None
            ok, why = row_is_priceable(status, usrc)
            if _PRICING and ok:
                kw = dict(cache_read=cr or 0, cache_create_5m=c5 or 0,
                          cache_create_1h=c1 or 0, at=_day(ts))
                original_cost = cost_of_model(om, it, ot, **kw)
                actual_cost = cost_of_model(served, it, ot, **kw)
                if original_cost is not None and actual_cost is not None:
                    savings = original_cost - actual_cost
                elif not why:
                    why = "model_not_in_catalog"
            rows.append({
                "ts": ts,
                "source": src or "",
                "original_model": om or "",
                "routed_model": served or "",
                "decision_type": _decision_type(rtier, tier),
                "original_cost": round(original_cost, 6) if original_cost is not None else None,
                "actual_cost": round(actual_cost, 6) if actual_cost is not None else None,
                "savings": round(savings, 6) if savings is not None else None,
                # The Logs table renders an em dash with this as its tooltip, never
                # "$0.00" -- zero is a measured result and "no claim made" is not.
                "unpriced_reason": why or ("model_not_in_catalog"
                                           if (_PRICING and savings is None) else ""),
                # basis/grain are NON-HIDEABLE columns in the Logs view and appear in
                # every export row. A later "simplify the table" change that drops them
                # would silently re-mix measured and estimated figures in one column.
                "basis": "measured" if (usrc or "") == "body" else (
                    "estimated" if (usrc or "") == "estimate" else "unknown"),
                "grain": "call",
                # Extra context the Logs/Monitor UI uses but which is not part of the
                # required column set.
                "tier": tier or "",
                "requested_tier": rtier or "",
                "reason": reason or "",
                "session": sess or "",
                "status": int(status or 0),
                "request_id": rid or "",
                "in_tokens": it,
                "out_tokens": ot,
                "cache_read": cr or 0,
                "cache_create_5m": c5 or 0,
                "cache_create_1h": c1 or 0,
            })
        return {"rows": rows, "total": total}

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
            # `model` is the model Cheaper actually SERVED. record() has always written
            # it; this SELECT used to omit it, which forced the cost of the routed leg
            # to be guessed from the family's tier representative instead of read from
            # the row. That guess over-reported savings on the one path that prints an
            # exact figure with no "about" qualifier.
            detail = c.execute(
                "SELECT ts, tier, original_model, in_tokens, out_tokens, source, "
                "requested_tier, requested_effort, model, "
                "COALESCE(cache_read,0), COALESCE(cache_create_5m,0), COALESCE(cache_create_1h,0), "
                "COALESCE(status,0), COALESCE(usage_source,'') "
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
        dollars = {"saved": 0.0, "spent": 0.0, "billed_top": 0.0, "savings_pct": 0.0,
                   "gross": 0.0, "extra": 0.0}
        by_tool_acc: dict = {}
        ts_acc: dict = {}
        models_changed = 0
        models_upcharged = 0
        tokens_downgraded = 0
        downgraded_by_tier = {"haiku": 0, "sonnet": 0, "opus": 0}
        # Per-MODEL histograms. The tagline names the models it credits, because
        # "haiku tier instead of opus" was never checkable by the reader and, once the
        # catalog gained models priced above Opus, was not even ordered by cost.
        downgraded_by_model: dict = {}
        upcharged_by_model: dict = {}
        baseline_model = None
        baseline_rank = -1.0
        top_model = None
        top_rank = -1.0
        reasoning_opps = 0
        tokens_saved_potential = 0
        time_saved_model = 0.0
        time_saved_reasoning = 0.0
        by_source_acc = {b: {"calls": 0, "saved": 0.0, "spent": 0.0}
                         for b in ("user", "subagent", "other")}
        # Per-period roll-up (Today / week / month / quarter / year / all-time), for the
        # Reports "Savings by period" block. Accumulated from the same priced rows so a
        # period figure reconciles with the headline totals. Bounded by max_rows exactly
        # like every other aggregate on this summary.
        period_starts = _period_starts()
        periods_acc = {k: {"saved": 0.0, "spent": 0.0, "calls": 0} for k in period_starts}
        # Rows deliberately excluded from every dollar figure, counted so the exclusion
        # is VISIBLE. A silently shrinking denominator is how "we weren't watching"
        # becomes indistinguishable from "$0.00".
        unpriced = {"estimated_usage": 0, "non_2xx": 0, "model_not_in_catalog": 0}
        if _PRICING:
            for (ts, tier, om, it, ot, src, rtier, reff, served, cr, c5, c1,
                 status, usrc) in detail:
                ok, why = row_is_priceable(status, usrc)
                if not ok:
                    unpriced[why] = unpriced.get(why, 0) + 1
                    continue
                it = it or 0
                ot = ot or 0
                # in_tokens is the FRESH input count; cached traffic is billed separately.
                kw = dict(cache_read=cr or 0, cache_create_5m=c5 or 0,
                          cache_create_1h=c1 or 0, at=_day(ts))
                # Price BOTH legs at their exact models. `om` is what the caller asked
                # for (the baseline); `served` is what Cheaper actually ran. The only
                # variable between them is the model, which is the only thing Cheaper
                # controls -- so it is the only thing it may claim credit for.
                spent_x = cost_of_model(served, it, ot, **kw)
                base_x = cost_of_model(om, it, ot, **kw)
                if spent_x is not None and base_x is not None:
                    spent = spent_x
                    saved = base_x - spent_x          # SIGNED: a costlier route is negative
                    changed = (served or "") != (om or "") and abs(saved) > 0
                else:
                    # One side is unpriceable -> claim nothing for this row rather than
                    # falling back to a tier average that no invoice would match.
                    est = estimate_call(om, it, ot, tier)
                    spent = est["new_cost"] if is_priceable(om) else 0.0
                    saved = 0.0
                    changed = False
                    unpriced["model_not_in_catalog"] = unpriced.get("model_not_in_catalog", 0) + 1
                billed_top = cost_of(detect_family(om) or "other", "opus", it, ot) \
                    if detect_family(om) else 0.0
                dollars["saved"] += saved
                dollars["spent"] += spent
                dollars["billed_top"] += billed_top
                if saved > 0:
                    dollars["gross"] += saved
                elif saved < 0:
                    dollars["extra"] += -saved
                tool = _clean_tool(src)
                a = by_tool_acc.setdefault(
                    tool, {"tool": tool, "calls": 0, "saved": 0.0, "spent": 0.0, "down": 0})
                a["calls"] += 1
                a["saved"] += saved
                a["spent"] += spent
                if changed and saved > 0:
                    a["down"] += 1
                    models_changed += 1
                    tokens_downgraded += it + ot
                    downgraded_by_tier[tier] = downgraded_by_tier.get(tier, 0) + 1
                    downgraded_by_model[served] = downgraded_by_model.get(served, 0) + 1
                elif changed and saved < 0:
                    models_upcharged += 1
                    upcharged_by_model[served] = upcharged_by_model.get(served, 0) + 1
                # The baseline is the priciest model actually REQUESTED this session,
                # ranked on a fixed 1M-in/1M-out basket. Price, not tier: capability
                # rank and price rank genuinely disagree across the catalog.
                if om and is_priceable(om):
                    b_rank = cost_of_model(om, 1_000_000, 1_000_000) or 0.0
                    if b_rank > baseline_rank or (
                        b_rank == baseline_rank and (baseline_model is None or om < baseline_model)
                    ):
                        baseline_rank = b_rank
                        baseline_model = om
                if served and is_priceable(served):
                    t_rank = cost_of_model(served, 1_000_000, 1_000_000) or 0.0
                    if t_rank > top_rank:
                        top_rank = t_rank
                        top_model = served
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
                for _pk, _pstart in period_starts.items():
                    if ts is not None and ts >= _pstart:
                        pa = periods_acc[_pk]
                        pa["saved"] += saved
                        pa["spent"] += spent
                        pa["calls"] += 1
            actual_total = dollars["saved"] + dollars["spent"]
            dollars["savings_pct"] = round(dollars["saved"] / actual_total * 100, 1) if actual_total else 0.0
            for k in ("saved", "spent", "billed_top", "gross", "extra"):
                dollars[k] = round(dollars[k], 4)
        else:
            dollars = {"gross": round(max(0.0, saved_u), 4), "extra": 0.0,
                       "saved": round(saved_u, 4), "spent": round(spent_u, 4),
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

        # Provenance travels WITH the numbers. Both mispricing incidents shared a
        # second cause: no surface rendered the age of the price data, so a rate stale
        # by months was byte-indistinguishable from one verified this morning at every
        # human checkpoint. Any consumer printing a dollar figure can now print its
        # as-of date next to it, and staleness becomes visible instead of invisible.
        _catalog = {"as_of": CATALOG_AS_OF if _PRICING else None,
                    "priced": bool(_PRICING),
                    "age_days": _age_days(CATALOG_AS_OF) if _PRICING else None}
        return {
            "catalog": _catalog,
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
                "models_upcharged": models_upcharged,
                "reasoning_opportunities": reasoning_opps,
                # Rows that contributed NOTHING to any dollar figure, by reason. The
                # invariant a reader can check: priced + sum(unpriced.values()) equals
                # the number of rows examined (min(total, max_rows)).
                "unpriced": dict(unpriced),
                "unpriced_total": sum(unpriced.values()),
                "priced": max(0, min(total, max_rows) - sum(unpriced.values())),
                "examined": min(total, max_rows),
                # An honest truncation flag: summary() has always capped its aggregates
                # at max_rows and said nothing, so a ledger past the cap silently
                # under-reported. Say when the figures are a sample.
                "truncated": total > max_rows,
            },
            "tokens": {"saved_reasoning_potential": tokens_saved_potential,
                       "downgraded": tokens_downgraded},
            # Savings rolled up per wall-clock period for the Reports "by period" block.
            # Keys: today, week, month, quarter, year, all.
            "periods": {k: {"saved": round(v["saved"], 4),
                            "spent": round(v["spent"], 4), "calls": v["calls"]}
                        for k, v in periods_acc.items()},
            # Per-tier count of the DOWNGRADED (money-saving) rows — what Cheaper routed
            # to cheaper tiers, so the tagline breakdown excludes at-ceiling main-loop calls.
            "downgraded_by_tier": downgraded_by_tier,   # kept one release for the dashboard
            "downgraded_by_model": downgraded_by_model,
            "upcharged_by_model": upcharged_by_model,
            "baseline_model": baseline_model,
            "top_model": top_model or baseline_model,
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
