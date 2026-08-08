"""The reporting read model: one pricer, one period ladder, one audit header.

WHY THE PER-ROW PRICING IS NOT RE-IMPLEMENTED HERE
--------------------------------------------------
The spec calls for extracting the per-row pricing out of ``metrics.py::logs`` so the
Logs tab and ``/logs`` can never disagree. Rather than lift the arithmetic into a
second function, this module produces ONE pricer by composition:

  * the row-exclusion POLICY is imported, not re-implemented:
    ``metrics.row_is_priceable(status, usage_source)``;
  * ``Metrics.logs()`` is reused as the gateway-row SOURCE -- this module does not
    issue its own SQL, so it cannot drift from what ``/logs`` selects, filters or
    counts;
  * each such row is converted into the SAME row shape the JSONL event store produces
    (``store.ROW_FIELDS``) and then priced by the SINGLE per-row pricer,
    ``store.derive_row``.

Consequence, stated plainly rather than hidden: ``/api/v1/logs``, ``/api/v1/reports/*``
and ``/api/v1/export`` are all rendered from ``store.derive_row``, so they cannot
disagree with each other by construction.

ONE TIME FRAME, ACROSS BOTH LAYERS
----------------------------------
The legacy ``/logs`` and ``/metrics`` endpoints used to price at ``metrics._day(ts)``
-- the **UTC** date -- while this layer priced and bucketed at ``pday``
(``ts + tzo``, the row's own LOCAL calendar day). With a promotional window on
``claude-sonnet-5`` running to 2026-08-31, a UTC-7 machine's 23:30 call on August 31st
is September 1st in UTC: the legacy endpoint dropped the promo and the newer one kept
it, a 50% dollar difference on both input and output for the same call. ``_day`` is
gone; ``metrics.py`` now prices every row at ``periods.pday_of(ts, tzo)``, the same
frame ``store.derive_row`` uses, so the two endpoints agree for calls on either side of
a UTC-midnight boundary.

The offset itself is now FROZEN on the row. ``decisions.tzo`` holds the machine's
minutes east of UTC at the instant of that call, written by ``Metrics.record()``, so a
machine that later changes timezone cannot restate the price date of history it already
recorded. Rows written before that column existed keep ``tzo IS NULL`` -- a real state,
never read as 0/UTC -- and are reconstructed by ``periods.local_offset_minutes``. That
helper lives in ``periods`` precisely because this module imports ``metrics`` and both
need the identical rule; two implementations of one rule is the defect class that
produced the UTC/pday split in the first place. ``Metrics.logs()`` also emits each
row's ``tzo`` and ``pday``, and ``gateway_row_to_event`` consumes them, so the frame is
carried rather than re-derived.

WHAT THIS MODULE WILL NOT DO
----------------------------
* It never adds a ``measured`` figure to an ``estimated`` one -- not for Saved, not for
  Spent, not for Events. ``store.fold_rows`` returns the two bases separately and no
  function here ever reads both into one expression.
* It never adds a chat-grain count to a call-grain count. Every row this module emits
  carries ``grain == 'call'``; legacy chat-grain figures are a different surface.
* It never reports ``$0.00`` for a period it cannot vouch for. Uncovered periods return
  ``not_covered``; >20% unpriceable tokens returns ``suppressed``; a store written by a
  newer Cheaper returns a refusal. ``$0`` and "we weren't watching" are different
  claims.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
from datetime import datetime, timezone

import export_fmt
import metrics as metrics_mod
import periods
import pricing
import store

# The classifier version frozen into transcript rows (cli/src/peek/emit.js
# CLASSIFIER_VERSION). It appears in Reports provenance next to catalog.as_of because
# storing `ctier` bakes the classifier's judgement into history: a classifier change no
# longer restates the past the way a catalog correction does.
CLASSIFIER_NAME = "contentTier"

# An honest cap. metrics.py::summary(max_rows=5000) already truncates every aggregate
# SILENTLY today; the Reports tab must not inherit that.
COUNT_CAP = 20000
DEFAULT_LIMIT = 100
MAX_LIMIT = 1000

_SORTS = ("ts:desc", "ts:asc")


# ---------------------------------------------------------------------------
# gateway rows (metrics.db) -> the event schema
# ---------------------------------------------------------------------------

def _local_offset_minutes(ts_ms: float) -> int | None:
    """Reconstruct a missing UTC offset. Delegates to ``periods.local_offset_minutes``.

    ``None`` when this machine's offset at that instant cannot be determined -- NOT 0.
    An unknown offset reported as UTC is the substitution the frozen ``tzo`` column
    exists to prevent; the None flows on to ``pday_of``, which answers None, and the row
    becomes a counted, visible exclusion instead of a confident wrong date.

    This is a thin alias kept for the module's own callers, NOT a second implementation.
    ``metrics.py`` needs the identical rule to reconstruct a legacy SQLite row, and
    ``reporting`` imports ``metrics``, so the rule cannot live in either of them -- it
    lives in ``periods``, which imports neither. A legacy row therefore gets the same
    offset, and so the same ``pday`` and the same dollars, whichever layer reads it.

    Only ever a FALLBACK: a row carrying a frozen ``tzo`` is authoritative and is never
    passed through here.
    """
    return periods.local_offset_minutes(ts_ms)


def _weak_key(harness, sess, served, ts_ms, in_tok, out_tok) -> str:
    """``events.js::eventKey`` K3. WEAK -- may only SUPPRESS a claim, never credit one."""
    parts = [str(harness or ""), str(sess or ""), str(served or ""),
             str(int(math.floor((ts_ms or 0) / 60000))),
             str(int(in_tok or 0)), str(int(out_tok or 0))]
    h = hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()[:24]
    return "wk:" + h


def gateway_row_to_event(row: dict) -> dict:
    """One ``Metrics.logs()`` row, in the event store's schema.

    ``base`` is the model the caller REQUESTED. That is the gateway's frozen
    counterfactual: the same call, the same date, the same SKU, the same tokens -- the
    only variable is the model, which is the only thing Cheaper controls and therefore
    the only thing it may claim credit for.

    ``tzo``/``pday`` are taken FROM THE ROW when it carries them -- ``Metrics.logs()``
    now emits the exact frame it priced at -- so this layer cannot arrive at a different
    price date than ``/logs`` did for the same call. The reconstruction below is the
    fallback for a row dict that predates those keys, and it is the same reconstruction
    ``metrics`` uses, via ``periods``.
    """
    ts_ms = float(row.get("ts") or 0) * 1000.0
    tzo = row.get("tzo")
    try:
        tzo = int(tzo) if tzo is not None else _local_offset_minutes(ts_ms)
    except (TypeError, ValueError):
        tzo = _local_offset_minutes(ts_ms)
    pday = row.get("pday") or periods.pday_of(ts_ms, tzo)
    rid = (row.get("request_id") or "").strip()
    usrc = (row.get("basis") or "")
    usrc = "body" if usrc == "measured" else ("estimate" if usrc == "estimated" else "")
    served = row.get("routed_model") or ""
    sess = row.get("session") or ""
    event_id = ("rid:" + rid) if rid else _weak_key(
        "", sess, served, ts_ms, row.get("in_tokens"), row.get("out_tokens"))
    return {
        "v": store.SCHEMA_V,
        "id": event_id,
        "rev": 1,
        "w": "gw",
        "inst": "",
        "ts": ts_ms,
        "tzo": tzo,
        "pday": pday,
        "ingested_at": ts_ms,
        "prov": "gateway",
        "usrc": usrc,
        # A gateway row is 'measured' only when the provider actually reported usage.
        "conf": "measured" if usrc == "body" else "estimated",
        # The gateway has no session or prompt visibility, so these stay empty and the
        # fold's TX_ONLY precedence lets a transcript row supply them.
        "harness": "",
        "sessions": [sess] if sess else [],
        "sess": sess,
        "sub": False,
        "served": served,
        "req": row.get("original_model") or "",
        "base": row.get("original_model") or "",
        "bsrc": "gw_requested",
        "elig": True,
        "ctier": None,
        "cver": None,
        "reason": row.get("reason") or "",
        "in": int(row.get("in_tokens") or 0),
        "out": int(row.get("out_tokens") or 0),
        "cr": int(row.get("cache_read") or 0),
        "c5": int(row.get("cache_create_5m") or 0),
        "c1": int(row.get("cache_create_1h") or 0),
        "cu": 0,
        "speed": None,
        "svc": "standard",
        "status": int(row.get("status") or 0),
        "sfile": None,
        "sbase": None,
        "fsha": None,
        "vok": True,
        # Carried through for the API view; not part of the stored schema.
        "_source": row.get("source") or "",
        "_tier": row.get("tier") or "",
        "_decision_type": row.get("decision_type") or "",
    }


def metrics_events(metrics_obj, cap: int = COUNT_CAP) -> dict:
    """Every gateway row, via ``Metrics.logs()`` -- never a second SQL statement.

    Returns ``{events, total, truncated, excluded}``.

    The exclusion POLICY is ``metrics.row_is_priceable`` -- imported, not
    re-implemented -- so this layer and ``/logs`` cannot drift on which rows may
    contribute to a dollar figure:

      * ``usage_source == 'estimate'`` -> the provider reported no usage for this call.
        ``Metrics.logs()`` renders its NULL token counts as 0, and a row of zero tokens
        priced at any rate is $0.00 -- a MEASURED result, which is precisely the claim
        nobody is entitled to make here. Such a row never becomes an event. It is
        counted, by reason, so the exclusion is visible rather than a silently shrinking
        denominator.
      * a non-2xx status -> KEPT as an event. ``derive_row`` refuses it with the same
        ``non_2xx`` reason the metrics policy uses, so it is recorded, counted, and
        never priced. Dropping it here would hide the retry storm instead of naming it.
    """
    events: list = []
    excluded: dict = {}
    total = 0
    if metrics_obj is None:
        return {"events": events, "total": 0, "truncated": False, "excluded": excluded}
    offset = 0
    seen = 0
    while len(events) < cap:
        page = metrics_obj.logs(limit=MAX_LIMIT, offset=offset, session=None)
        total = page.get("total") or 0
        rows = page.get("rows") or []
        if not rows:
            break
        for r in rows:
            usrc = {"measured": "body", "estimated": "estimate"}.get(r.get("basis"), "")
            ok, why = metrics_mod.row_is_priceable(r.get("status"), usrc)
            if not ok and why == "estimated_usage":
                excluded[why] = excluded.get(why, 0) + 1
                continue
            events.append(gateway_row_to_event(r))
        seen += len(rows)
        offset += len(rows)
        if offset >= total:
            break
    return {"events": events, "total": total, "truncated": total > seen,
            "excluded": excluded}


# ---------------------------------------------------------------------------
# the unified read
# ---------------------------------------------------------------------------

def unified_rows(metrics_obj=None, events_directory: str | None = None,
                 stale_writers=None) -> dict:
    """Event-store rows UNION gateway rows, deduped on the provider's key.

    Pre-migration gateway rows (no ``request_id``) get a WEAK key and are quarantined by
    the fold: their disjointness from the transcript rows covering the same calls is
    unprovable, so the window falls back to transcript-only and is labelled
    ``estimated``. On the current live database that is every single row, and that is
    the correct outcome -- not a bug to work around.
    """
    read = store.read_all(events_directory)
    gw = metrics_events(metrics_obj)
    folded = store.fold(list(read["rows"]) + list(gw["events"]), stale_writers)
    return {
        "rows": folded["rows"],
        "read_stats": read["stats"],
        "fold_stats": folded["stats"],
        "gateway_total": gw["total"],
        "gateway_truncated": gw["truncated"],
        # Gateway rows the metrics policy refuses to let near a dollar figure, by
        # reason. Never silently absorbed into a smaller denominator.
        "gateway_excluded": gw["excluded"],
    }


def _finite(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def in_window(r: dict, frm, to) -> bool:
    """Half-open ``[from, to)`` -- disjoint by construction, so a month is exactly the
    sum of its weeks and ``report(Jan) + report(Feb) == report(Jan u Feb)``.

    Answers on ``ts`` ALONE, and answers False for a row that has no usable ``ts`` --
    which conflates "outside the range" with "no instant to test". Callers that must
    tell those two apart use ``_window_disposition`` below; this function stays as it is
    because the row-listing surfaces (``matching_views``, ``keyset_page``) key their
    cursors on ``ts`` and cannot carry a row that has none.
    """
    ts = _finite(r.get("ts"))
    if ts is None:
        return False
    if frm is not None and ts < frm:
        return False
    if to is not None and ts >= to:
        return False
    return True


# ---------------------------------------------------------------------------
# WHERE A ROW SITS ON THE TIME AXIS -- one rule, three dispositions
# ---------------------------------------------------------------------------
#
# `ts` and `pday` are TWO INDEPENDENT FIELDS on a row and `store.merge` can null either
# one without the other: it ranks them separately, so two sources that tie on `ts` and
# disagree null `ts` and NAME it in `conflicts` while an AGREEING `pday` survives
# untouched. `store.derive_row` prices off `pday`, not off `ts`. So "this row has no
# usable instant" and "this row cannot be dated" are DIFFERENT CLAIMS, and a row that is
# the first without being the second is fully PRICEABLE.
#
# Exempting a row from the window whenever its `ts` is non-finite -- the shape that
# stopped undatable rows vanishing -- therefore waved such a row into EVERY window,
# including windows that provably exclude its own day, with no label and no count:
# breakdown(April) and breakdown(Aug) each claimed the same $0.06, and their sum was
# twice their union. That turned a silent OMISSION into a silent FABRICATION.
#
# The exemption below covers ONLY rows undatable in BOTH senses -- no finite `ts` AND no
# usable `pday` -- because those are exactly the rows `derive_row` refuses to price
# (REASON_NO_TS). They contribute ZERO dollars wherever they are counted, which is what
# makes exempting them safe; a row carrying a frozen day is dated and is tested BY THAT
# DAY, at the row's own offset.

_IN = "in"
_OUT = "out"
_UNDATABLE = "undatable"


def _pday_start_ms(pday, tzo):
    """The instant the local calendar day ``pday`` BEGAN, in the ROW'S OWN frame.

    ``periods.pday_of`` renders ``ts + tzo`` as YYYY-MM-DD, so that day begins at
    ``utc_midnight(pday) - tzo`` and ends 24h later. Returns None -- never a substituted
    instant -- when ``pday`` does not name a representable calendar day, or when no
    offset can be established at all.

    Which strings name a day is decided by ``store.iso_day_ms``, NOT re-implemented here:
    ``store.derive_row`` asks the same function before it prices the row, and a placement
    rule that accepted a day the pricer refuses (or refused one it accepts) is precisely
    how a priceable row ends up in no window at all.

    THE OFFSET IS THE ROW'S OWN, never the report's host frame: a report rendered in
    Asia/Tokyo must not restate which day a UTC-7 machine's call happened on. An ABSENT
    ``tzo`` is RECONSTRUCTED through ``periods.local_offset_minutes`` -- the same helper,
    the same rule and the same fallback ``periods.pday_of`` documents for exactly this
    case -- and never read as 0, which is the substitution the frozen ``tzo`` column
    exists to prevent. The reconstruction is resolved at the day's own MIDDAY so that a
    DST changeover (02:00-03:00 local in every zone that has one) cannot decide the
    answer.
    """
    midnight = store.iso_day_ms(pday)
    if midnight is None:
        return None
    off = None
    if tzo is not None:
        try:
            off = int(tzo)
        except (TypeError, ValueError):
            off = None
    if off is None:
        off = periods.local_offset_minutes(midnight + 43200000)
        if off is None:
            return None
    return midnight - off * 60000


def _placement(r: dict):
    """``(kind, instant)`` -- the ONE instant this row is tested against a window.

    ``kind`` is one of:

      ``ts``           a finite ``ts``: the instant itself, tested exactly as
                       ``in_window`` tests it;
      ``pday``         no finite ``ts``, but a frozen ``pday`` naming a real day whose
                       start instant can be established: the instant that day BEGAN in
                       the row's own frame. A SINGLE instant, not the day's interval --
                       see below;
      ``unplaceable``  no finite ``ts``, a ``pday`` that DOES name a representable day,
                       and no offset with which to say when that day began -- the
                       ``tzo`` was not recorded AND the machine's offset at that day is
                       not determinable (only reachable at the year-1 / year-9999
                       calendar edges, where the local wall time falls outside the
                       calendar). ``derive_row`` still prices such a row, so it must NOT
                       be granted the exemption, or it would fabricate dollars into
                       every window. It answers ``out`` everywhere instead;
      ``none``         no finite ``ts`` and no ``pday`` that names a representable
                       calendar day -- absent, empty, or a string like ``2026-13-45``
                       that names no day. ``store.iso_day_ms`` decides that, and
                       ``derive_row`` asks the SAME function before it prices, so every
                       row in this class is refused with REASON_NO_TS and contributes no
                       dollars wherever it is counted -- which is the entire
                       justification for exempting it from the window.

    WHY A SINGLE INSTANT AND NOT THE DAY'S INTERVAL. Testing ``[day_start, day_end)``
    for INTERSECTION with ``[frm, to)`` reads as the more honest choice and is not: a
    local day that straddles a window boundary then intersects BOTH neighbours and the
    row is counted twice -- report(Jan) + report(Feb) > report(Jan u Feb), the one
    failure this workstream exists to end. Requiring CONTAINMENT instead breaks the same
    identity in the other direction: neither neighbour contains it, so the row is lost
    from both while their union keeps it. Only a POINT partitions, so a point is what is
    tested; the point is the day's own start in the row's own frame, so a row whose
    frame matches the report's lands in exactly the window its day belongs to.
    """
    ts = _finite(r.get("ts"))
    if ts is not None:
        return "ts", ts
    pday = r.get("pday")
    # Asked of the SAME function `derive_row` asks. A `pday` that names no representable
    # day is not priced, so this row is provably zero-dollar and may safely take the
    # exemption -- which is what removes it from the `unplaceable` class, where it was
    # excluded from every window while still carrying dollars nothing counted.
    if store.iso_day_ms(pday) is None:
        return "none", None
    at = _pday_start_ms(pday, r.get("tzo"))
    return ("pday", at) if at is not None else ("unplaceable", None)


def _window_disposition(r: dict, frm, to) -> str:
    """``in`` / ``out`` / ``undatable`` for one row against one half-open window.

    ONE classification, used by ``report_window``, ``report_breakdown`` and
    ``report_trend`` alike, so the three endpoints cannot disagree about which rows a
    window holds. What each surface DOES with ``undatable`` differs -- and every one of
    those dispositions is counted and visible, never a silent drop:

      ``report_window``     excluded from the fold and counted in ``undated``, labelled
                            ``incomplete``;
      ``report_breakdown``  joins its own REAL group on the (non-temporal) dimension,
                            where ``fold_rows`` counts it as an unpriced call;
      ``report_trend``      the trailing, labelled ``undated`` point.

    The fourth state, ``unplaceable``, answers ``out`` for EVERY window, bounded or not,
    and is counted by ``report_window``'s ``undated``. It is now narrow: a row with no
    finite ``ts``, a ``pday`` that DOES name a representable day, and no way to say when
    that day began -- ``tzo`` absent AND ``periods.local_offset_minutes`` unable to
    reconstruct one. That happens only at the calendar edges (a year-9999 day on a
    far-eastern machine, a year-1 day on a far-western one), where the local wall time
    leaves the representable calendar. ``derive_row`` DOES price such a row, so it cannot
    be exempted -- an exempt priceable row is the fabrication this function exists to stop
    -- and it cannot be placed, because no instant can be named without inventing an
    offset. Excluding it everywhere is the only disposition that neither fabricates nor
    double-counts, and it keeps the ladder and lifetime agreeing (both exclude it).

    STATED LIMITATION, unchanged: ``report_breakdown`` and ``report_trend`` have no
    counter of their own for ``unplaceable``, so there it is an exclusion visible only
    through ``report_window``'s ``undated``. What used to ALSO fall in this class -- a
    truthy ``pday`` naming no day at all, e.g. ``"2026-13-45"`` or a numeric ``20260410``
    -- no longer does: ``store.derive_row`` refuses to price it, so it is ``none``, and
    every surface counts it through its own visible channel.
    """
    kind, at = _placement(r)
    if kind == "none":
        return _UNDATABLE
    if kind == "ts":
        # Delegated, not re-derived: two implementations of one comparison is how the
        # window means two things on two surfaces.
        return _IN if in_window(r, frm, to) else _OUT
    if at is None:                      # `unplaceable`
        return _OUT
    if frm is not None and at < frm:
        return _OUT
    if to is not None and at >= to:
        return _OUT
    return _IN


def decision_of(r: dict, d: dict) -> str:
    """downgrade / escalate / kept / unknown.

    Derived from the SIGNED delta rather than from a tier table, because capability
    rank and price rank genuinely disagree across this catalog: a "same tier" swap can
    still cost more. ``unknown`` is used when the row is unpriceable -- never ``kept``,
    which would read as a measured no-op.
    """
    base = r.get("base")
    served = r.get("served")
    if not base:
        return "kept"
    if not r.get("elig"):
        return "kept"
    if pricing.canonical(served) == pricing.canonical(base):
        return "kept"
    if not d.get("priceable"):
        return "unknown"
    delta = d.get("delta") or 0
    if delta > 0:
        return "downgrade"
    if delta < 0:
        return "escalate"
    return "kept"


def _iso(ts_ms):
    f = _finite(ts_ms)
    if f is None:
        return ""
    return datetime.fromtimestamp(f / 1000.0, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def row_view(r: dict) -> dict:
    """The API/export projection of one folded row, priced ONCE by store.derive_row.

    ``basis`` and ``grain`` are non-hideable: they are always present, they are never
    sortable-away, and they appear in every export row. Dropping them is how a per-call
    measured figure and a per-chat estimated one end up in the same column.
    """
    d = store.derive_row(r)
    priceable = bool(d["priceable"])
    return {
        "id": r.get("id") or "",
        "ts": _finite(r.get("ts")),
        "ts_iso": _iso(r.get("ts")),
        "pday": r.get("pday"),
        "tzo": r.get("tzo"),
        "ingested_at": _finite(r.get("ingested_at")),
        "basis": "measured" if r.get("conf") == "measured" else "estimated",
        "grain": "call",
        "prov": r.get("prov") or "",
        "source": r.get("_source") or r.get("prov") or "",
        "harness": r.get("harness") or "",
        "session": r.get("sess") or "",
        "sessions": list(r.get("sessions") or []),
        "served": r.get("served") or "",
        "base": r.get("base") or "",
        "requested": r.get("req") or "",
        "baseline_source": r.get("bsrc") or "",
        "decision": decision_of(r, d),
        "tier": r.get("_tier") or "",
        "classifier_tier": r.get("ctier") or "",
        "classifier_version": r.get("cver"),
        "reason": r.get("reason") or "",
        "in": store.num0(r.get("in")),
        "out": store.num0(r.get("out")),
        "cache_read": store.num0(r.get("cr")),
        "cache_create_5m": store.num0(r.get("c5")),
        "cache_create_1h": store.num0(r.get("c1")),
        "cache_create_unknown": store.num0(r.get("cu")),
        "tokens": d["tokens"],
        "speed": r.get("speed"),
        "service_tier": r.get("svc"),
        "status": store.num0(r.get("status")),
        "eligible": bool(r.get("elig")),
        "priceable": priceable,
        # Unpriceable rows carry None, NOT 0. The Logs table renders an em dash with a
        # tooltip; the export leaves the cell empty. `$0.00` is a measured result.
        "baseline_usd": d["baseline"] if priceable else None,
        "actual_usd": d["spent"] if priceable else None,
        "delta_usd": d["delta"] if priceable else None,
        "unpriced_reason": "" if priceable else d["reason"],
        "verifiable": bool(r.get("vok")),
        "conflicts": list(r.get("conflicts") or []),
        "weak_join_suppressed": bool(r.get("weak_join_suppressed")),
    }


# ---------------------------------------------------------------------------
# filters
# ---------------------------------------------------------------------------

def _parse_instant(v, tz, default=None):
    """Accept epoch-ms, epoch-seconds-as-float, or ``YYYY-MM-DD`` at LOCAL midnight in
    ``tz``. A bare date is what a human types; interpreting it as UTC would shift a
    whole day's worth of traffic on any non-UTC machine."""
    if v is None or v == "":
        return default
    s = str(v).strip()
    if len(s) == 10 and s[4] == "-" and s[7] == "-":
        try:
            z = periods.zone(tz)
            return int(datetime(int(s[:4]), int(s[5:7]), int(s[8:10]), tzinfo=z).timestamp() * 1000)
        except ValueError:
            return default
    try:
        n = float(s)
    except ValueError:
        return default
    # Anything smaller than year-2001-in-ms is almost certainly seconds.
    return int(n * 1000) if abs(n) < 1e11 else int(n)


def parse_filters(qp) -> dict:
    """The shared filter contract, echoed in every response so an export is
    reproducible from its own header.

    ``from`` is INCLUSIVE, ``to`` is EXCLUSIVE. That is stated in the header block and
    enforced by ``in_window``; a closed-closed window double-counts every boundary
    instant when two adjacent periods are added.
    """
    def g(k, default=None):
        try:
            v = qp.get(k)
        except Exception:
            v = None
        return default if v is None or v == "" else v

    tz = g("tz") or "UTC"
    limit = DEFAULT_LIMIT
    try:
        limit = int(g("limit", DEFAULT_LIMIT))
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT
    limit = max(1, min(limit, MAX_LIMIT))
    min_abs = None
    try:
        if g("min_abs_usd") is not None:
            min_abs = abs(float(g("min_abs_usd")))
    except (TypeError, ValueError):
        min_abs = None
    sort = g("sort", "ts:desc")
    if sort not in _SORTS:
        sort = "ts:desc"
    return {
        "from": _parse_instant(g("from"), tz),
        "to": _parse_instant(g("to"), tz),
        "tz": tz,
        "basis": g("basis"),
        "grain": g("grain"),
        "decision": g("decision"),
        "harness": g("harness"),
        "served": g("served"),
        "base": g("base"),
        "session": g("session"),
        "q": g("q"),
        "min_abs_usd": min_abs,
        "sort": sort,
        "limit": limit,
        "cursor": g("cursor"),
    }


def echo_filters(f: dict) -> dict:
    """Exactly what was applied, in the response, so the export is reproducible."""
    return {
        "from": f.get("from"), "from_inclusive": True,
        "to": f.get("to"), "to_exclusive": True,
        "tz": f.get("tz"), "basis": f.get("basis"), "grain": f.get("grain"),
        "decision": f.get("decision"), "harness": f.get("harness"),
        "served": f.get("served"), "base": f.get("base"),
        "session": f.get("session"), "q": f.get("q"),
        "min_abs_usd": f.get("min_abs_usd"), "sort": f.get("sort"),
        "limit": f.get("limit"), "cursor": f.get("cursor"),
    }


def _match(v: dict, f: dict) -> bool:
    if f.get("basis") and v["basis"] != f["basis"]:
        return False
    if f.get("grain") and v["grain"] != f["grain"]:
        return False
    if f.get("decision") and v["decision"] != f["decision"]:
        return False
    if f.get("harness") and v["harness"] != f["harness"]:
        return False
    if f.get("served") and pricing.canonical(v["served"]) != pricing.canonical(f["served"]):
        return False
    if f.get("base") and pricing.canonical(v["base"]) != pricing.canonical(f["base"]):
        return False
    if f.get("session") and f["session"] not in (v["sessions"] or [v["session"]]):
        return False
    if f.get("q"):
        needle = str(f["q"]).lower()
        hay = " ".join(str(v.get(k) or "") for k in
                       ("id", "served", "base", "requested", "reason", "harness",
                        "session", "source", "decision", "unpriced_reason")).lower()
        if needle not in hay:
            return False
    if f.get("min_abs_usd") is not None:
        # An unpriceable row has no magnitude to compare, so a magnitude filter
        # EXCLUDES it rather than treating "no claim made" as 0.
        if not v["priceable"]:
            return False
        if abs(v["delta_usd"] or 0) < f["min_abs_usd"]:
            return False
    return True


def filtered_rows(rows, f: dict, apply_window: bool = True) -> list:
    """The raw folded rows that match, for the aggregate surfaces.

    ``apply_window`` is False for the period ladder and the trend series: those define
    their OWN windows, and pre-clipping to the query window would silently empty every
    ladder row that lies outside it.
    """
    out = []
    for r in rows:
        if apply_window and not in_window(r, f.get("from"), f.get("to")):
            continue
        if not _match(row_view(r), f):
            continue
        out.append(r)
    return out


def matching_views(rows, f: dict) -> list:
    """Every row that matches, as views, sorted server-side over the FULL match set.

    Sorting a loaded page while thousands match is a lie about what the sort means, so
    filtering and sorting happen here and never in the browser.
    """
    out = [row_view(r) for r in rows if in_window(r, f.get("from"), f.get("to"))]
    out = [v for v in out if _match(v, f)]
    reverse = f.get("sort", "ts:desc") == "ts:desc"
    out.sort(key=lambda v: (v["ts"] if v["ts"] is not None else -math.inf, str(v["id"])),
             reverse=reverse)
    return out


# ---------------------------------------------------------------------------
# keyset pagination
# ---------------------------------------------------------------------------

def encode_cursor(v: dict) -> str:
    raw = json.dumps([v["ts"], v["id"]], separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def decode_cursor(c):
    if not c:
        return None
    try:
        pad = "=" * (-len(c) % 4)
        raw = base64.urlsafe_b64decode((str(c) + pad).encode("ascii"))
        val = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    if not isinstance(val, list) or len(val) != 2:
        return None
    return {"ts": _finite(val[0]), "id": str(val[1])}


def keyset_page(views: list, cursor, limit: int, sort: str = "ts:desc") -> dict:
    """Keyset, never offset.

    Offset degrades linearly AND skips or duplicates rows when new traffic lands
    mid-scroll: a row inserted above the cursor shifts every later page by one. The
    long-hand comparison ``ts < ? OR (ts = ? AND id < ?)`` (reversed for ascending) is
    stable under insertion because it names the last row seen rather than counting rows.
    """
    c = decode_cursor(cursor)
    if c is not None:
        ct, ci = c["ts"], c["id"]
        if sort == "ts:asc":
            views = [v for v in views
                     if (v["ts"] or -math.inf) > (ct if ct is not None else -math.inf)
                     or ((v["ts"] or -math.inf) == (ct if ct is not None else -math.inf)
                         and str(v["id"]) > ci)]
        else:
            views = [v for v in views
                     if (v["ts"] or -math.inf) < (ct if ct is not None else math.inf)
                     or ((v["ts"] or -math.inf) == (ct if ct is not None else math.inf)
                         and str(v["id"]) < ci)]
    page = views[:limit]
    return {
        "rows": page,
        "next_cursor": encode_cursor(page[-1]) if len(views) > limit and page else None,
        "has_more": len(views) > limit,
    }


def honest_count(n_matching: int) -> str:
    """An honest cap beats a wrong exact number. ``metrics.py::summary(max_rows=5000)``
    already truncates every aggregate silently; the Reports tab must not inherit it."""
    return f"{COUNT_CAP}+" if n_matching > COUNT_CAP else str(n_matching)


# ---------------------------------------------------------------------------
# report windows
# ---------------------------------------------------------------------------

_NOT_COVERED_NOTE = ("Cheaper was not watching during this period. "
                     "That is not the same as saving $0.")


def report_window(rows, frm, to, state=None, tz=None, open_sessions=None,
                  implied=None) -> dict:
    """One half-open window ``[from, to)``. Returns a SHAPE, not a number.

    ``measured`` and ``estimated`` come back SEPARATELY and are never summed. A renderer
    that wants one number must choose a basis and say which one it chose.
    """
    st = state if state is not None else store.load_state()
    # The events in hand are their OWN coverage evidence: a recorded call at instant T
    # proves we were watching at T, which is stronger than a declared interval. Without
    # this, a lost or hand-deleted state.json makes a window full of real events report
    # `not_covered` -- and "not covered" over live data is just as wrong as "$0.00" over
    # no data.
    imp = implied if implied is not None else store.implied_coverage(rows)
    cov = store.coverage_for(frm, to, st, imp)
    tombs = store.tombstones_in(frm, to, st)
    labels: list = []
    notes: list = []

    # BOTH refusals below report `tombstones: None`, never `len(tombs)`.
    # `store.load_state` returns an EMPTY tombstone list for both dispositions -- not
    # because the store holds none, but because this reader declined to interpret the
    # document that holds them. Publishing that as `0` states a fact about the user's
    # deletions that was never read, in the one field whose whole job is to make a
    # deliberate exclusion visible (invariant 7: a "report nothing" case returns a
    # labelled non-number, never a number).
    if st.get("too_new"):
        return {"status": "suppressed", "from": frm, "to": to,
                "measured": None, "estimated": None,
                "labels": ["store_newer_than_reader"],
                "notes": ["This savings store was written by a newer Cheaper. "
                          "Upgrade with `npm i -g cheaper` — refusing to guess at its "
                          "contents."],
                "coverage": cov, "tombstones": None,
                "catalog": _catalog_block()}

    # The SAME refusal for a state file that EXISTS and could not be read. It holds the
    # `cheaper forget` tombstones, so reporting past it would publish totals that may
    # include events the user asked to have excluded -- the deletion silently undone,
    # with the figures simply going back up and nothing anywhere saying why. An ABSENT
    # state file is NOT this case and reports normally: `implied_coverage` speaks for the
    # events themselves, and a store that never declared coverage has no tombstones to
    # miss. Mirror of `cli/src/peek/store.js::reportWindow`'s `st.unreadable` branch; the
    # two must not disagree, or `cheaper savings` refuses while the dashboard reports.
    if st.get("unreadable"):
        return {"status": "suppressed", "from": frm, "to": to,
                "measured": None, "estimated": None,
                "labels": ["state_unreadable"],
                "notes": ["The savings store's state.json could not be read "
                          f"({st['unreadable']}), so its coverage intervals and its "
                          "`cheaper forget` tombstones are unknown. Refusing to report "
                          "totals that might include events a tombstone excludes. Move "
                          "that file aside to start a fresh one — the events themselves "
                          "are untouched."],
                "coverage": cov, "tombstones": None,
                "catalog": _catalog_block()}

    # NOT `in_window` alone. A row whose `ts` was nulled by a merge conflict but whose
    # `pday` survived is PRICEABLE and is placed by its own frozen day, exactly as
    # `report_breakdown` and `report_trend` place it -- otherwise this endpoint reports
    # 0 events for a window in which its siblings report a dollar figure, on the same
    # row, and `_api_envelope` stamps the requested from/to on both.
    windowed = [r for r in rows if _window_disposition(r, frm, to) == _IN]

    if cov["kind"] == "not_covered":
        return {"status": "not_covered", "from": frm, "to": to,
                "measured": None, "estimated": None, "coverage": cov,
                "tombstones": len(tombs), "dollars_suppressed": False,
                "labels": ["not_covered"], "notes": [_NOT_COVERED_NOTE],
                "catalog": _catalog_block()}

    if cov["kind"] == "partial":
        labels.append("partial_coverage")
        notes.append("Only part of this period is covered; the figures below describe "
                     "the covered sub-window only.")

    folded = store.fold_rows(windowed)

    # Case 8 -- an undated row is excluded from every bucket AND counted. periods.js
    # used to `continue` silently, so a report could lose rows and still look complete.
    #
    # "No usable timestamp" is NOT the test, and using it as one made this counter claim
    # an exclusion that no longer happens: a row with a surviving `pday` is placed in its
    # own window above. What is counted here is a row with NO INSTANT TO TEST AT ALL --
    # no finite `ts` and no usable frozen day -- which is excluded from this window, from
    # every other window, and from lifetime. `derive_row` refuses to price exactly those
    # rows, so nothing is being withheld from the dollars by counting them here.
    undated = sum(1 for r in rows if _placement(r)[1] is None)
    if undated > 0:
        labels.append("incomplete")
        notes.append(f"{undated} event(s) have no usable timestamp and no usable frozen "
                     "day, and are excluded.")

    # ...and the converse is DISCLOSED rather than assumed: a row placed by its frozen
    # day carries less evidence than one placed by its own instant, and a reader is
    # entitled to know how many of them a figure rests on. This is provenance, not an
    # exclusion -- these rows ARE in `windowed` and ARE priced, at their own day.
    dated_by_pday = sum(1 for r in windowed if _placement(r)[0] == "pday")
    if dated_by_pday > 0:
        labels.append("dated_by_frozen_day")
        notes.append(f"{dated_by_pday} event(s) have no usable timestamp and are placed "
                     "in this period by the calendar day frozen on the row, at the "
                     "row's own recorded UTC offset — the same day they are priced at.")

    # Case 7 -- more than a fifth of the window's tokens unpriceable: suppress DOLLARS
    # and report TOKENS. Sticky and explanatory, never a silent blank.
    if folded["dollars_suppressed"]:
        labels.append("dollars_suppressed")
        notes.append(_suppression_note(windowed, folded))

    if tombs:
        labels.append("tombstoned")
        notes.append(f"{len(tombs)} session(s) were deleted with `cheaper forget`; "
                     "their events are excluded from these totals.")

    if open_sessions:
        labels.append("provisional")
        notes.append("A session in this window is still open; these figures are "
                     "provisional.")

    return {
        "status": ("suppressed" if folded["dollars_suppressed"]
                   else ("partial" if cov["kind"] == "partial" else "ok")),
        "from": frm, "to": to, "coverage": cov, "tombstones": len(tombs),
        "dollars_suppressed": bool(folded["dollars_suppressed"]),
        # The two bases are returned SEPARATELY and are never summed. When dollars are
        # suppressed the ACCUMULATORS still come back with their call and token counts:
        # those are exactly known and are not in doubt -- only the dollars are, and only
        # the dollars are nulled. Blanking the whole object threw away a fact to hide an
        # uncertainty, which is its own kind of dishonesty: a window holding one 429 and
        # nothing else must still be able to say "1 call, 0 priced" rather than go blank.
        "measured": _withhold_dollars(folded["measured"], folded["dollars_suppressed"]),
        "estimated": _withhold_dollars(folded["estimated"], folded["dollars_suppressed"]),
        "tokens": {"measured": folded["measured"]["tokens"],
                   "estimated": folded["estimated"]["tokens"]},
        # ROWS SEEN in this window, per basis -- NOT `folded[basis]["calls"]`, which counts
        # only the rows that could be PRICED. Reading `calls` here made this endpoint
        # answer `events: {"measured": 0, "estimated": 0}` for a window holding one
        # unpriceable call, directly above its own note asserting "1 of 1 call(s) in this
        # window ... Call and token counts are exact" -- and dashboard.html renders that
        # zero under the header "Events (measured)" with a tooltip reading "1 of these
        # could not be priced". It also made `events` mean ROWS PRICED here and ROWS SEEN
        # in `cli/src/peek/store.js`, one field name with two meanings, published under the
        # same key to the same consumers depending only on gateway reachability.
        # `check-period-parity.js` now diffs this field across both runtimes.
        "events": folded["events"],
        "grain": "call",
        "unpriced": folded["unpriced"],
        "unpriced_calls": folded["unpriced_calls"],
        "unpriced_tokens": folded["unpriced_tokens"],
        "unpriced_ratio": folded["unpriced_ratio"],
        "undated": undated,
        # NOT an addend to either basis and not a sum of them: a provenance count of
        # rows already inside `events`, disclosed so the reader can see how much of the
        # figure rests on a frozen day rather than on an instant.
        "dated_by_pday": dated_by_pday,
        "labels": labels, "notes": notes,
        "catalog": _catalog_block(),
    }


# The five DOLLAR fields. Everything else in an accumulator is an exact count.
_DOLLAR_FIELDS = ("saved", "spent", "baseline", "gross", "extra")


def _withhold_dollars(acc: dict, suppressed: bool) -> dict:
    if not suppressed:
        return acc
    out = dict(acc)
    for k in _DOLLAR_FIELDS:
        out[k] = None
    return out


# The reasons that mean THE CATALOG CANNOT PRICE THIS MODEL -- the only ones `cheaper
# update` can do anything about.
_CATALOG_REASONS = (store.REASON_SERVED_UNPRICEABLE, store.REASON_BASE_UNPRICEABLE)

# ...and the ones that do not. Spelt out rather than inferred by subtraction so a new
# reason string added to `store.REASONS` lands in the honest "other" sentence below
# instead of being silently absorbed into a catalog claim that is false about it.
_OTHER_REASON_PROSE = {
    store.REASON_NON_2XX: "did not return a 2xx status, and a failed or retried call "
                          "is recorded but never priced",
    store.REASON_NO_TS: "carry no usable timestamp and no usable frozen day",
    store.REASON_COST_NULL: "priced to no figure at all, which is a catalog defect "
                            "rather than a missing model",
}


def _suppression_note(windowed, folded) -> str:
    """Per-window and specific. The dashboard renders these notes under the table, and a
    generic percentage sentence leaves the reader unable to tell which row it belongs
    to -- or how much of the window it describes.

    ONE SENTENCE PER REASON, because the reasons are not the same claim. This function
    used to describe every withheld window as "not in the price catalog ... Refresh with
    `cheaper update`", which was true while a missing model was the only way to be
    unpriceable. It stopped being true when `cache_state_indeterminate` arrived: those
    models ARE in the catalog and priced fine -- what is missing is the COUNTERFACTUAL's
    cache state, which no catalog contains and no refresh can supply. Telling a user to
    run `cheaper update` there sends them to fix something that is not broken and then
    to watch the figure not come back, which reads as the tool being wrong about its own
    data. A wrong explanation of a correct withholding is still a false statement about
    money, and it is the kind that destroys trust in the correct part.
    """
    total_calls = len(windowed)
    unpriced_calls = folded["unpriced_calls"]
    pct = round(folded["unpriced_ratio"] * 100)
    unpriced = folded["unpriced"] or {}

    # The offending model ids. A `cache_state_indeterminate` row contributes none by
    # construction -- both of its models resolve, which is exactly why its own sentence
    # must not say otherwise.
    models = []
    for r in windowed:
        d = store.derive_row(r)
        if d["priceable"]:
            continue
        for m in (r.get("served"), r.get("base")):
            if m and not _priceable_now(m, r.get("pday")) and m not in models:
                models.append(m)
    tail = ""
    if models:
        shown = ", ".join(models[:5])
        more = f" and {len(models) - 5} more" if len(models) > 5 else ""
        tail = f" (models: {shown}{more})"

    catalog_n = sum(unpriced.get(k, 0) for k in _CATALOG_REASONS)
    cache_n = unpriced.get(store.REASON_CACHE_INDETERMINATE, 0)

    parts = [f"{unpriced_calls} of {total_calls} call(s) in this window ({pct}% of its "
             f"tokens) could not be priced, so no dollar figure is claimed."]
    if catalog_n:
        parts.append(f"{catalog_n} call(s) are not in the price catalog{tail} — refresh "
                     "with `cheaper update`.")
    if cache_n:
        # Its OWN sentence, and deliberately not a "refresh" one. The withholding is not
        # a gap in what Cheaper knows about prices; it is a gap in what the provider
        # records about caches, and it will not close by updating anything.
        parts.append(
            f"{cache_n} call(s) switched model on a cold prompt cache: those models ARE "
            "in the catalog, but switching invalidates the cache, and nothing recorded "
            "says whether the un-switched baseline would have paid a cache write or a "
            "cache read — so the counterfactual is an interval whose sign the evidence "
            "cannot settle, and no figure is claimed for them. Nothing to refresh; the "
            "evidence does not exist.")
    for reason, prose in _OTHER_REASON_PROSE.items():
        n = unpriced.get(reason, 0)
        if n:
            parts.append(f"{n} call(s) {prose}.")
    # Any reason this function has not been taught is named rather than swallowed: an
    # unexplained count is still visible, where a silently dropped one is not.
    known = set(_CATALOG_REASONS) | {store.REASON_CACHE_INDETERMINATE} \
        | set(_OTHER_REASON_PROSE)
    rest = {k: v for k, v in unpriced.items() if k not in known and v}
    if rest:
        listed = ", ".join(f"{v} {k}" for k, v in sorted(rest.items()))
        parts.append(f"The remainder were withheld for: {listed}.")
    parts.append("Call and token counts are exact.")
    return " ".join(parts)


def _priceable_now(model, pday) -> bool:
    return pricing.resolve_model(model, pday) is not None


def _catalog_block() -> dict:
    return {"as_of": pricing.CATALOG_AS_OF,
            "digest": store.catalog_digest(),
            "age_days": _catalog_age_days()}


def _catalog_age_days():
    try:
        d = datetime.strptime(pricing.CATALOG_AS_OF, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        return max(0, (datetime.now(timezone.utc) - d).days)
    except (TypeError, ValueError):
        return None


def report_periods(rows, tz=None, now_ms=None, state=None) -> list:
    """The DISJOINT ladder: Today · Earlier this week · … · Before this year.

    These PARTITION history, so they sum to lifetime -- the property the old nested
    "since" ladder lacked, which is why six rows could be added to six times today.
    """
    st = state if state is not None else store.load_state()
    # Computed ONCE over the whole row set and shared by every window, so two ladder
    # rows can never disagree about whether the same instant was observed.
    imp = store.implied_coverage(rows)
    out = []
    for w in periods.disjoint_ladder(now_ms, tz):
        rep = report_window(rows, w["from"], w["to"], st, tz, implied=imp)
        rep["key"] = w["key"]
        rep["label"] = w["label"]
        rep["tz"] = w["tz"]
        # A period label alone is not checkable: "This month" tells the reader nothing
        # about which instants were included.
        rep["bounds_label"] = periods.local_bounds_label(w["from"], w["to"], tz)
        out.append(rep)
    return out


def lifetime_window(rows, tz=None, state=None) -> dict:
    """Everything, as ONE window -- deliberately NOT the sum of the ladder rows.

    Computing the total independently is the point: a bug in the ladder then shows up as
    a DISAGREEMENT between the two, instead of being faithfully reproduced in the total
    and rendered as agreement.

    Caveat a caller must respect: the ladder rows and this total are both correct, but
    ``sum(ladder[].measured.saved) == lifetime.measured.saved`` only holds when NO row is
    ``dollars_suppressed``. Suppression is a per-window render decision (>20% of THAT
    window's tokens unpriceable), so a window can suppress while lifetime does not, and
    its priced rows still contribute to lifetime. Compare on ``tokens``/``events`` -- which
    are never suppressed -- or skip rows whose ``dollars_suppressed`` is true.
    """
    st = state if state is not None else store.load_state()
    out = report_window(rows, None, None, st, tz,
                        implied=store.implied_coverage(rows))
    out["key"] = "lifetime"
    out["label"] = "Lifetime"
    out["bounds_label"] = periods.local_bounds_label(None, None, tz)
    return out


_LEGACY_NOTE = (
    "Pre-store per-chat aggregates imported from lifetime.json. Dollars are FROZEN as "
    "computed at the time and are never re-priced, the timestamps are known-imprecise, "
    "and the grain is CHAT, not call — so these are excluded from every period window "
    "and from both bases, and are reported only here."
)

_LEGACY_TOO_NEW_NOTE = (
    "This legacy chat store was written by a newer Cheaper. Refusing to guess at its "
    "contents — upgrade with `npm i -g cheaper`. No figure is claimed; this is not $0."
)


def legacy_block() -> dict:
    """The frozen chat-grain store, reported as a THIRD state beside the two bases.

    It is never added to ``measured`` or ``estimated``: those are per-CALL and these are
    per-CHAT, and one live chat here holds thousands of calls. Adding them is the same
    concealment shape as a cross-basis dollar sum, in a column where it is far less
    visible.
    """
    t = store.legacy_totals()
    if t["too_new"]:
        return {"usd": None, "tokens": None, "chats": None,
                "derivation": "frozen", "note": _LEGACY_TOO_NEW_NOTE}
    return {"usd": t["usd"], "tokens": t["tokens"], "chats": t["chats"],
            "derivation": "frozen", "note": _LEGACY_NOTE}


_COMPARISON_PERIODS = ("month", "week")


def report_comparisons(rows, tz=None, now_ms=None, state=None) -> dict:
    """Period-over-period, with an explicit ``n`` on BOTH sides.

    ``events`` travels with every window precisely so a 400% jump on 3 events reads as
    the noise it is rather than as a result.
    """
    st = state if state is not None else store.load_state()
    imp = store.implied_coverage(rows)
    out: dict = {}
    for name in _COMPARISON_PERIODS:
        cur = periods.period_bounds(name, now_ms, tz)
        prev = periods.previous_period_bounds(name, now_ms, tz)
        block = {}
        for which, b in (("current", cur), ("previous", prev)):
            w = report_window(rows, b["from"], b["to"], st, tz, implied=imp)
            w["bounds"] = {"from": b["from"], "to": b["to"]}
            w["bounds_label"] = periods.local_bounds_label(b["from"], b["to"], tz)
            block[which] = w
        out[name] = block
    return out


_DIMS = ("served", "base", "tier", "harness", "decision")


def report_breakdown(rows, dim: str, frm=None, to=None) -> list:
    """Grouped aggregates. Dollars stay split by basis all the way through, because a
    per-call measured figure and a per-chat estimated one in the same column is the same
    concealment shape in a place where the separation is less visually obvious.

    ``frm``/``to`` filter every row that can be PLACED on the time axis -- by its own
    ``ts``, or, when that was nulled by a merge conflict, by the calendar day frozen on
    the row at the row's own offset. Only a row that can be placed NEITHER way is exempt
    from the window. Every dimension here is NON-TEMPORAL, so such a row still has a real
    ``served``, ``base``, ``tier``, ``harness`` and ``decision``: it joins its own group
    and is counted there, rather than being deleted from every group by a range it cannot
    be tested against -- and ``derive_row`` refuses to price it, so it adds no dollars to
    the group it joins.
    """
    if dim not in _DIMS:
        dim = "served"

    def key_of(r):
        if dim == "served":
            return r.get("served") or "(unknown)"
        if dim == "base":
            return r.get("base") or "(none)"
        if dim == "tier":
            return r.get("ctier") or r.get("_tier") or "(unclassified)"
        if dim == "harness":
            return r.get("harness") or "(unknown)"
        return decision_of(r, store.derive_row(r))

    groups: dict = {}
    for r in rows:
        # SAME SHAPE AS report_trend, and for the same reason -- except that here the
        # grouping key is NON-TEMPORAL, so the case is even clearer. `in_window` answers
        # False both for "this row's instant is outside the requested range" and for
        # "this row has no usable instant at all" (`ts` absent, None, NaN or non-numeric
        # -- a merge artefact, a truncated import line, a JSON null). Asking it FIRST
        # collapsed those two different claims into one `continue`, and an undatable row
        # was deleted from EVERY group of EVERY dimension with no trace: not a group, not
        # an `events` count, not an `unpriced_calls` count. Nothing in the response or the
        # envelope recorded it, so a reader grouping by `harness` or `served` -- both
        # perfectly derivable for a row whose timestamp is unusable -- read a
        # complete-looking composition table built on a silently smaller denominator.
        #
        # Exempting a row on `ts` ALONE then overshot in the opposite direction: `pday`
        # is a SEPARATE field that survives its own merge, `derive_row` prices off it,
        # and so a row with a dead `ts` and a live `pday` was waved into every window --
        # April and August each claiming the same $0.06 that belongs to one of them. The
        # exemption is therefore decided by DATABILITY, not by `ts`: see
        # `_window_disposition`. A row that can be placed either way is tested; only a
        # row that can be placed NEITHER way joins its group unconditionally, and
        # `store.fold_rows` counts that one honestly as an unpriced call.
        if _window_disposition(r, frm, to) == _OUT:
            continue
        groups.setdefault(key_of(r), []).append(r)
    out = []
    for k, rs in groups.items():
        f = store.fold_rows(rs)
        # Case 7, applied HERE TOO -- byte-for-byte the omission
        # `cli/src/peek/store.js::reportBreakdown` had. `fold_rows` computes
        # `dollars_suppressed` for every set of rows it folds, and this function computed
        # it and threw it away: a group whose tokens were more than a fifth unpriceable
        # published its raw accumulators as if they described the whole group, and the
        # ladder row over the same rows said "no dollar figure is claimed" while this
        # group printed one. Only the DOLLARS are withheld; `events`, `calls`, `tokens`
        # and `unpriced_calls` are exact and survive.
        out.append({"key": k, "grain": "call",
                    "measured": _withhold_dollars(f["measured"],
                                                  f["dollars_suppressed"]),
                    "estimated": _withhold_dollars(f["estimated"],
                                                   f["dollars_suppressed"]),
                    # The flag a renderer keys off, spelt and meaning exactly what
                    # `report_window` publishes under the same name.
                    "dollars_suppressed": bool(f["dollars_suppressed"]),
                    # Events, like Saved and Spent, get the two-column treatment or they
                    # are omitted. A single `calls: len(rs)` here WOULD be a cross-basis
                    # count -- measured calls plus estimated calls in one cell, which is
                    # the same concealment shape as a cross-basis dollar sum in a place
                    # where the separation is far less visually obvious.
                    #
                    # ROWS SEEN, not `f[basis]["calls"]` (rows PRICED) -- see
                    # `report_window`. A group exists because rows landed in it, so a group
                    # reporting 0 events beside a non-zero `unpriced_calls` contradicts its
                    # own presence. `unpriced_calls` stays a SUBSET counter of `events`,
                    # not an addend to it.
                    "events": f["events"],
                    # NOT an addend to either basis: these rows entered NEITHER
                    # accumulator. Counted so the exclusion is visible rather than a
                    # silently shrinking denominator.
                    "unpriced_calls": f["unpriced_calls"],
                    "unpriced": f["unpriced"]})
    # Sorted by the ESTIMATED saving when that is the only basis present, otherwise by
    # measured -- NEVER by their sum.
    #
    # A WITHHELD group has no magnitude to be ordered by. `None or None` is None, and
    # comparing None to a float raises -- so such groups sort LAST, as groups making no
    # claim, and are never coerced to a 0 that would rank them among the measured zeroes.
    out.sort(key=lambda g: (_group_sort_value(g) is not None,
                            _group_sort_value(g) if _group_sort_value(g) is not None
                            else 0.0),
             reverse=True)
    return out


def _group_sort_value(g):
    """Mirrors cli/src/peek/store.js::groupSortValue -- the same falsy fallback the old
    ``g["measured"]["saved"] or g["estimated"]["saved"]`` had, made None-aware."""
    m = (g.get("measured") or {}).get("saved")
    e = (g.get("estimated") or {}).get("saved")
    v = m if m else e
    return None if v is None else v


_BUCKETS = ("day", "week", "month")


def report_trend(rows, bucket: str = "day", frm=None, to=None) -> list:
    """A dated series bucketed on ``pday`` -- the row's own local calendar day, never on
    ingest time. ``ingested_at`` exists for audit and never assigns a row to a period.

    A row this function CANNOT date is skipped and COUNTED, never bucketed at a
    fabricated day. ``store.merge`` nulls both ``pday`` and ``tzo`` when two sources
    disagree about a row's frame (the disagreement is recorded in ``conflicts``), and a
    timestamp in the wrong unit is not a representable calendar date at all. Those rows
    surface as ONE trailing, labelled ``undated`` entry -- their calls and dollars are
    still visible, they are simply attributed to no day. The entry is emitted ONLY when
    such rows exist, so a clean series is byte-identical to before.

    ``frm``/``to`` filter every row that can be PLACED on the time axis -- by its own
    ``ts``, or, when that was nulled by a merge conflict, by the calendar day frozen on
    the row, at the row's own offset. A row carrying a ``pday`` is DATED: it is tested
    against the window by that day and bucketed at that day, so a 2027 request can no
    longer emit a bucket labelled ``2026-08-06``. Only a row that can be placed NEITHER
    way is exempt from the window, and that row lands in the trailing ``undated`` entry
    where ``derive_row`` refuses to price it -- see the loop below.
    """
    if bucket not in _BUCKETS:
        bucket = "day"

    def key_of(r):
        # NOT `r.get("tzo") or 0`: a missing offset is reconstructed by pday_of (the
        # documented fallback, identical on both runtimes), and an explicit 0 is
        # honoured as the real value it is.
        d = r.get("pday") or periods.pday_of(r.get("ts"), r.get("tzo"))
        if not d:
            return None
        if bucket == "month":
            return d[:7]
        if bucket == "week":
            try:
                noon = int(datetime(int(d[:4]), int(d[5:7]), int(d[8:10]), 12,
                                    tzinfo=timezone.utc).timestamp() * 1000)
            except ValueError:
                return None
            b = periods.period_bounds("week", noon, "UTC")
            return periods.pday_of(b["from"], 0)
        return d

    groups: dict = {}
    undated: list = []
    for r in rows:
        # WINDOW AND DATABILITY ARE TWO DIFFERENT QUESTIONS, and `in_window` cannot be
        # asked first without collapsing them. `in_window` answers False both for "this
        # row's instant is outside the requested range" and for "this row has no usable
        # instant at all" (`ts` absent, None, NaN, or non-numeric -- a merge artefact, a
        # truncated import line, a JSON null). Asking it first meant the second kind was
        # dropped by that `continue` and never reached `key_of`, never reached
        # `undated`, and so left NO trace in the response: not a bucket, not a count, not
        # a dollar. `store.fold_rows` counts such a row as an unpriced call; this loop
        # has to give it the chance to, or the docstring's promise that an undatable row
        # is "skipped and COUNTED" is a claim the function contradicts.
        #
        # Exempting on `ts` ALONE then overshot in the other direction. `pday` is a
        # SEPARATE field with its own merge outcome, and `key_of` buckets on it, so a row
        # with a dead `ts` and a live `pday` was exempted from the window and then
        # bucketed at its own day INSIDE a window that excludes that day: a request for
        # January 2027 emitted a bucket labelled 2026-08-06 carrying real dollars, and
        # the same dollars appeared again in every other window asked for. The window is
        # therefore applied on DATABILITY -- see `_window_disposition` -- so a dated row
        # is tested by whichever frame it still has, and only a row that can be placed
        # NEITHER way is exempt. That one has no day to be bucketed at either, so it
        # lands in `undated` below, exactly as the docstring promises.
        disp = _window_disposition(r, frm, to)
        if disp == _OUT:
            continue
        k = None if disp == _UNDATABLE else key_of(r)
        if not k:
            undated.append(r)
            continue
        # Reachable with no finite `ts`: a row can carry a `pday` frozen at write time
        # while its instant is unusable. It IS dated -- it has already been TESTED
        # against the window by that day, at its own offset -- so it is attributed to
        # its own frozen day and labelled with that day in the output, where a reader
        # can see it, rather than silently deleted for failing a test it cannot take.
        groups.setdefault(k, []).append(r)

    def _point(key, group, undatable=False):
        f = store.fold_rows(group)
        # NO scalar `calls` here. It would equal measured.calls + estimated.calls, and
        # a field produced by reading BOTH a measured and an estimated accumulator is
        # the one thing this API may never emit -- the invariant is asserted
        # structurally over the live response in test_reporting.py. Two columns or
        # nothing; `events` is the two columns.
        # Case 7 applies to a BUCKET exactly as it applies to a window, and the day-grain
        # bucket covers exactly the rows the ladder's Today row covers -- so publishing
        # the raw accumulators put "withheld ... so no dollar figure is claimed" and
        # "$0.02 | $0.02" on one screen for the SAME calls. Only the DOLLARS are
        # withheld; the counts are exact and survive.
        return {"bucket": key, "grain": "call", "undatable": undatable,
                "measured": _withhold_dollars(f["measured"], f["dollars_suppressed"]),
                "estimated": _withhold_dollars(f["estimated"], f["dollars_suppressed"]),
                "dollars_suppressed": bool(f["dollars_suppressed"]),
                # Two columns or nothing — see report_breakdown. ROWS SEEN, not rows
                # PRICED: the trailing `undated` point holds rows `derive_row` refuses to
                # price, so reading `calls` here made that point report 0 measured and 0
                # estimated events beside its own non-zero `unpriced_calls` — a bucket that
                # exists only because rows are in it, asserting that it holds none.
                "events": f["events"],
                "unpriced_calls": f["unpriced_calls"]}

    out = [_point(k, groups[k]) for k in sorted(groups)]
    if undated:
        # LAST, and flagged. It carries no date because none could be derived; a
        # renderer must label it rather than plot it, and a reader must not add it to a
        # dated total. Dropping it silently would shrink the denominator with no trace,
        # which is the same concealment as printing $0.00 for an unpriceable model.
        out.append(_point("undated", undated, undatable=True))
    return out


# ---------------------------------------------------------------------------
# the audit header block -- ONE dict, three renderings
# ---------------------------------------------------------------------------

_METHOD = (
    "Each row is priced TWICE, at that row's OWN date and OWN billing SKU, at list "
    "rates: baseline_usd = cost of the row's frozen baseline model at this row's "
    "tokens; actual_usd = cost of the model Cheaper actually served, at this row's "
    "tokens; delta_usd = baseline_usd - actual_usd, SIGNED. A negative delta means the "
    "routed call cost MORE. Negative rows are INCLUDED and SUBTRACTED from every total "
    "in this file; no total here counts only the wins. Cache-read and 5-minute / "
    "1-hour cache-write tokens are priced at their own rates. Long-context tiers and "
    "fast / batch / priority SKUs are applied PER CALL. A model absent from the catalog "
    "is UNPRICEABLE: its cost columns are EMPTY (null in JSON), never 0.00, and it "
    "contributes nothing. No rate is ever guessed. Non-2xx responses (retries, errors) "
    "are recorded but never priced."
)

_MEASUREMENT_BASIS = (
    "measured  — observed by the Cheaper gateway from provider-reported usage; "
    "grain=call. estimated — reconstructed from local harness transcripts, or a "
    "gateway row whose usage nobody reported; grain=call. legacy — pre-store per-chat "
    "aggregate, dollars FROZEN as computed at the time, timestamp imprecise, excluded "
    "from period buckets; grain=chat, and it does not appear in this file. The bases "
    "carry SEPARATE totals and are never summed. If you need one number, state which "
    "basis it came from."
)

_PRICE_NOTE = (
    "List rates only. Negotiated discounts, committed-spend rates, credits, free tiers, "
    "flat-rate subscription plans, promotional windows outside their dates, taxes and "
    "provider-side rounding are NOT modelled."
)

_NOT_AN_INVOICE = (
    "Figures are list-price METERED VALUE — an estimate of what the usage in this file "
    "would list for. Not amounts billed, not amounts paid, not a statement of account. "
    "Reconcile against your provider invoice before any accounting, reimbursement or "
    "tax use."
)

_GUARD_NOTE_SAFE = (
    "safe — non-numeric cells beginning with = + - @ | %% carry a leading apostrophe to "
    "prevent spreadsheet formula execution. This export is therefore NOT "
    "byte-reversible. For a lossless copy re-run with --format json (or --guard raw)."
)

_GUARD_NOTE_RAW = (
    "raw — cells are byte-exact apart from stripped control characters. This file is "
    "NOT safe to open by double-click in Excel / LibreOffice / Sheets: a cell beginning "
    "with = + - @ may be evaluated as a formula."
)

_PERIOD_BASIS = (
    "`ts` — WHEN THE CALL HAPPENED. `ingested_at` is exported per row for audit but "
    "never assigns a row to a period."
)


def _offset_iso(ms, tz):
    if ms is None:
        return "—"
    z = periods.zone(tz)
    return datetime.fromtimestamp(float(ms) / 1000.0, tz=z).isoformat()


def coverage_label(state: dict) -> str:
    intervals = (state or {}).get("coverage") or []
    if not intervals:
        return ("No coverage interval was declared by a writer; coverage is IMPLIED by "
                "the recorded events themselves (each call, plus one day either side of "
                "a contiguous run). A period with neither a declared interval nor a "
                "nearby event reports `not_covered`, never $0.00.")
    parts = []
    for c in sorted(intervals, key=lambda c: store.num0(c.get("from"))):
        parts.append(f"{c.get('kind') or 'observed'} "
                     f"{_iso(c.get('from'))} → {_iso(c.get('to'))}")
    return " ; ".join(parts)


def audit_meta(*, period_label, from_ms, to_ms, tz, filters, rows_exported,
               rows_matching, truncated, state=None, guard_mode="safe",
               digest=None, build=None, fmt="csv", now_ms=None) -> dict:
    """ONE dict. The CSV/TSV preamble, the JSON ``meta`` block and the report cover page
    are ALL rendered from it, so they cannot disagree."""
    st = state if state is not None else store.load_state()
    now = float(now_ms) if now_ms is not None else datetime.now(timezone.utc).timestamp() * 1000
    z = periods.zone(tz)
    tombs = store.tombstones_in(from_ms, to_ms, st)
    return {
        "export_schema": export_fmt.EXPORT_SCHEMA,
        "generated_at": _iso(now),
        "generated_at_local": datetime.fromtimestamp(now / 1000.0, tz=z).isoformat(),
        "generated_by": f"cheaper gateway build {build or 'unknown'}",
        "period": period_label,
        "period_start": _offset_iso(from_ms, tz),
        "period_start_inclusive": True,
        "period_end": _offset_iso(to_ms, tz),
        "period_end_exclusive": True,
        "period_bounds_label": periods.local_bounds_label(from_ms, to_ms, tz),
        "timezone": str(z),
        "period_basis": _PERIOD_BASIS,
        "week_anchor": "ISO-8601 (weeks begin Monday 00:00 local)",
        "coverage": st.get("coverage") or [],
        "coverage_label": coverage_label(st),
        "classifier": f"{CLASSIFIER_NAME} (frozen per row as `ctier`/`cver`)",
        "rows_exported": rows_exported,
        "rows_matching": rows_matching,
        "truncated": bool(truncated),
        "method": _METHOD,
        "measurement_basis": _MEASUREMENT_BASIS,
        "price_provenance": {
            "as_of": pricing.CATALOG_AS_OF,
            "age_days": _catalog_age_days(),
            "digest": store.catalog_digest(),
            "note": _PRICE_NOTE,
        },
        "not_an_invoice": _NOT_AN_INVOICE,
        "integrity": {
            "row_digest": digest,
            "row_digest_method": ("sha256 over the canonical JSON of every exported "
                                  "row, in the order emitted"),
            "tombstones": (f"{len(tombs)} in this window" if tombs
                           else "none in this window"),
            "tombstone_detail": tombs,
            "guard_mode": guard_mode,
            "guard_note": _GUARD_NOTE_SAFE if guard_mode == "safe" else _GUARD_NOTE_RAW,
        },
        "filters": echo_filters(filters or {}),
        "reproduce": _reproduce(fmt, from_ms, to_ms, tz, filters, guard_mode),
    }


def _reproduce(fmt, from_ms, to_ms, tz, filters, guard_mode) -> str:
    f = filters or {}
    parts = [f"cheaper export --format {fmt}"]
    if from_ms is not None:
        parts.append("--from " + _offset_iso(from_ms, tz))
    if to_ms is not None:
        parts.append("--to " + _offset_iso(to_ms, tz))
    parts.append(f"--tz {periods.zone(tz)}")
    parts.append(f"--basis {f.get('basis') or 'all'}")
    for k in ("harness", "served", "base", "session", "decision", "q"):
        if f.get(k):
            parts.append(f"--{k} {f[k]}")
    if f.get("min_abs_usd") is not None:
        parts.append(f"--min-abs-usd {f['min_abs_usd']}")
    parts.append(f"--guard {guard_mode}")
    return " ".join(parts)


def export_filename(period_label, fmt) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return export_fmt.safe_filename(
        f"cheaper-{period_label or 'export'}-{stamp}.{fmt}")


__all__ = [
    "CLASSIFIER_NAME", "COUNT_CAP", "DEFAULT_LIMIT", "MAX_LIMIT",
    "gateway_row_to_event", "metrics_events", "unified_rows", "in_window",
    "decision_of", "row_view", "parse_filters", "echo_filters", "matching_views",
    "filtered_rows",
    "encode_cursor", "decode_cursor", "keyset_page", "honest_count",
    "report_window", "report_periods", "report_breakdown", "report_trend",
    "lifetime_window", "legacy_block", "report_comparisons",
    "audit_meta", "coverage_label", "export_filename",
]
