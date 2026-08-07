"""Calendar period arithmetic for the reporting API.

MUST stay behaviourally identical to ``cli/src/peek/periods.js``. The pricing catalog
already drifted between the two runtimes once and shipped wrong dollars; this is the
same drift class applied to time, and it fails more quietly -- "this week" simply means
two different things on two surfaces of the same product, and neither one looks broken.

``cli/scripts/check-period-parity.js`` executes BOTH implementations over a fixture set
of instants, zones and DST/month boundaries and diffs them to the millisecond. It runs
inside ``npm test``, exactly like ``sync-prices.js --check`` does for pricing.

Windows are HALF-OPEN ``[from, to)`` in epoch MILLISECONDS, weeks are Monday-anchored
(ISO-8601), and boundaries are local midnight in the requested IANA zone.
"""

from __future__ import annotations

import calendar
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError   # stdlib on 3.9+

PERIODS = ("today", "week", "month", "quarter", "year", "all")

# A clock that ran backwards, a VM resuming from a snapshot, or a transcript carrying a
# future timestamp. Anything past now+tolerance is quarantined rather than bucketed,
# because a far-future row otherwise sits in every "since" window forever.
SKEW_TOLERANCE_MS = 24 * 3600 * 1000


def zone(tz: str | None) -> ZoneInfo:
    """Resolve an IANA name, falling back to UTC. A bad zone must not 500 a report --
    it degrades to UTC and the response echoes which zone was actually used, so the
    reader can tell."""
    if not tz:
        return ZoneInfo("UTC")
    try:
        return ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return ZoneInfo("UTC")


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def _local(ms: int, z: ZoneInfo) -> datetime:
    return datetime.fromtimestamp(ms / 1000.0, tz=z)


def _wall(y: int, mo: int, d: int, z: ZoneInfo) -> datetime:
    """Local midnight for a (possibly out-of-range) Y/M/D, normalised the way JS's
    ``Date.UTC(y, mo-1, d)`` normalises: month 13 rolls to January of the next year and
    day 0 rolls to the last day of the previous month. The JS side relies on that
    rollover for `day - back` and `month + 1`, so this MUST match it or the week and
    month bounds diverge at every boundary."""
    y += (mo - 1) // 12
    mo = (mo - 1) % 12 + 1
    base = datetime(y, mo, 1, tzinfo=z)
    # `d` may be <= 0 or > days-in-month; timedelta does the rollover.
    return base + timedelta(days=d - 1)


def _midnight(y: int, mo: int, d: int, z: ZoneInfo) -> int:
    """Epoch-ms of local 00:00 on the given (normalised) date.

    ``datetime`` with a ZoneInfo resolves a DST-ambiguous or DST-skipped wall time via
    ``fold``; the JS side converges on the same instant with its two-pass offset
    correction. The parity gate covers both spring-forward and fall-back explicitly.
    """
    w = _wall(y, mo, d, z)
    return _ms(w.replace(hour=0, minute=0, second=0, microsecond=0))


def period_bounds(name: str, now_ms: int | float | None = None,
                  tz: str | None = None) -> dict:
    """Half-open ``{from, to}`` epoch-ms bounds for the named period containing now."""
    z = zone(tz)
    now = int(now_ms) if now_ms is not None else int(datetime.now(tz=z).timestamp() * 1000)
    if name == "all":
        return {"from": None, "to": None, "tz": str(z)}
    p = _local(now, z)
    if name == "today":
        return {"from": _midnight(p.year, p.month, p.day, z),
                "to": _midnight(p.year, p.month, p.day + 1, z), "tz": str(z)}
    if name == "week":
        back = p.weekday()                      # Monday = 0
        return {"from": _midnight(p.year, p.month, p.day - back, z),
                "to": _midnight(p.year, p.month, p.day - back + 7, z), "tz": str(z)}
    if name == "month":
        return {"from": _midnight(p.year, p.month, 1, z),
                "to": _midnight(p.year, p.month + 1, 1, z), "tz": str(z)}
    if name == "quarter":
        q0 = ((p.month - 1) // 3) * 3 + 1
        return {"from": _midnight(p.year, q0, 1, z),
                "to": _midnight(p.year, q0 + 3, 1, z), "tz": str(z)}
    if name == "year":
        return {"from": _midnight(p.year, 1, 1, z),
                "to": _midnight(p.year + 1, 1, 1, z), "tz": str(z)}
    d0 = _midnight(p.year, p.month, p.day, z)
    return {"from": d0, "to": d0, "tz": str(z)}


def previous_period_bounds(name: str, now_ms: int | float | None = None,
                           tz: str | None = None) -> dict:
    """The period before this one — "last month", "last week" — for period-over-period."""
    cur = period_bounds(name, now_ms, tz)
    if cur["from"] is None:
        return cur
    return period_bounds(name, cur["from"] - 1, tz)


def disjoint_ladder(now_ms: int | float | None = None, tz: str | None = None) -> list:
    """Non-overlapping windows that PARTITION all of history.

    Today · Earlier this week · Earlier this month · Earlier this quarter ·
    Earlier this year · Before this year.

    These sum to the lifetime total. The nested "since" ladder does not, which is why
    the old Reports table could be added up to six times today's savings.
    """
    z = zone(tz)
    now = int(now_ms) if now_ms is not None else int(datetime.now(tz=z).timestamp() * 1000)
    b = {k: period_bounds(k, now, tz) for k in ("today", "week", "month", "quarter", "year")}
    rows = [
        ("today", "Today", b["today"]["from"], b["today"]["to"]),
        ("week_earlier", "Earlier this week", b["week"]["from"], b["today"]["from"]),
        ("month_earlier", "Earlier this month", b["month"]["from"], b["week"]["from"]),
        ("quarter_earlier", "Earlier this quarter", b["quarter"]["from"], b["month"]["from"]),
        ("year_earlier", "Earlier this year", b["year"]["from"], b["quarter"]["from"]),
        ("before", "Before this year", None, b["year"]["from"]),
    ]
    out = []
    for key, label, frm, to in rows:
        # A collapsed window (it is Monday, so "earlier this week" is empty) is kept
        # with from == to rather than dropped, so the ladder always has the same shape
        # and a zero row is visibly zero rather than missing.
        if frm is not None and to is not None and to < frm:
            to = frm
        out.append({"key": key, "label": label, "from": frm, "to": to, "tz": str(z)})
    return out


def pday_of(ts_ms: int | float, tzo_minutes: int | None) -> str | None:
    """The calendar+pricing day for an event: ``ts + tzo`` rendered as YYYY-MM-DD.

    ONE frame for both the calendar bucket and the price date. They used to disagree,
    and the catalog's dated windows made that a live 50% mispricing rather than a
    cosmetic one.
    """
    try:
        ms = float(ts_ms)
    except (TypeError, ValueError):
        return None
    off = int(tzo_minutes or 0)
    shifted = datetime.utcfromtimestamp(ms / 1000.0 + off * 60)
    return shifted.strftime("%Y-%m-%d")


def local_bounds_label(frm: int | None, to: int | None, tz: str | None) -> str:
    """The literal local bounds printed under a period heading, e.g.
    ``2026-08-01 00:00 → 2026-08-07 00:00 (America/Chicago, UTC-05:00)``.

    Printed because a period label alone is not checkable: "This month" tells the
    reader nothing about which instants were included, and an export has to be
    reproducible from its own header.
    """
    z = zone(tz)
    def fmt(v):
        if v is None:
            return "—"
        return _local(int(v), z).strftime("%Y-%m-%d %H:%M")
    off = _local(int(to if to is not None else (frm or 0)), z).utcoffset() or timedelta(0)
    total = int(off.total_seconds())
    sign = "+" if total >= 0 else "-"
    total = abs(total)
    return (f"{fmt(frm)} → {fmt(to)} ({z}, UTC{sign}{total // 3600:02d}:{(total % 3600) // 60:02d})")


__all__ = ["PERIODS", "SKEW_TOLERANCE_MS", "period_bounds", "previous_period_bounds",
           "disjoint_ladder", "pday_of", "zone", "local_bounds_label"]
