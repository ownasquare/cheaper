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
from datetime import datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError   # stdlib on 3.9+

PERIODS = ("today", "week", "month", "quarter", "year", "all")

# Everything `zoneinfo.ZoneInfo(key)` is documented to raise for a key it cannot turn
# into a zone. Enumerated rather than caught as bare `Exception` so a genuine bug
# (NameError, AttributeError) still escapes instead of being silently relabelled as
# "no timezone".
#   ZoneInfoNotFoundError -- no such key on TZPATH and no `tzdata` package (it is a
#                            subclass of KeyError, listed separately for the reader)
#   ValueError            -- malformed key (absolute path, `..`) or a corrupt TZif file
#   KeyError              -- the base of ZoneInfoNotFoundError
#   TypeError             -- a non-string key
#   OSError               -- the tzfile exists but cannot be read
_ZONE_ERRORS = (ZoneInfoNotFoundError, ValueError, KeyError, TypeError, OSError)

# A clock that ran backwards, a VM resuming from a snapshot, or a transcript carrying a
# future timestamp. Anything past now+tolerance is quarantined rather than bucketed,
# because a far-future row otherwise sits in every "since" window forever.
SKEW_TOLERANCE_MS = 24 * 3600 * 1000


class NoTZDatabase(tzinfo):
    """A fixed +00:00 zone for the case where this machine has NO tz database at all.

    ``zoneinfo`` does not ship the IANA data; it reads it from the OS (``/usr/share/
    zoneinfo``) or from the ``tzdata`` PyPI package. macOS and mainstream Linux have
    the OS copy, so every developer machine hides this. **Windows ships none**, and
    neither does musl/Alpine -- which is what the gateway's own Dockerfile builds on
    if it ever moves to an alpine base. ``tzdata`` is now a hard requirement in
    ``requirements.txt`` for exactly that reason, and this class is what happens when
    the requirement is nonetheless not met (a hand-rolled venv, a vendored install, a
    pip failure that ``installGatewayDeps`` deliberately treats as non-fatal).

    IT EXISTS BECAUSE THE OLD FALLBACK WAS NOT ONE. ``zone()`` used to answer
    ``ZoneInfo("UTC")`` when the requested key failed -- but "UTC" is an ordinary key
    that needs the SAME database, so on a machine without one the fallback raised the
    identical ``ZoneInfoNotFoundError`` it was written to absorb, and the exception
    left ``zone()`` entirely. Every reporting entry point calls ``zone()``, so
    ``/api/v1/reports/*``, the periods ladder, the trend and the export header all
    500'd -- an outage, not a degradation. (Verified by pointing ``TZPATH`` at an
    empty directory and blocking the ``tzdata`` import: ``ZoneInfo("UTC")`` raises
    ``ZoneInfoNotFoundError: 'No time zone found with key UTC'``.) ``datetime``'s
    fixed-offset machinery needs no database whatever, which is why this is a plain
    ``tzinfo`` and not another key lookup.

    IT IS DELIBERATELY LOUD. ``str(z)`` is what ``period_bounds``/``disjoint_ladder``
    put in their ``tz`` field, what ``local_bounds_label`` prints under every period
    heading and what ``reporting`` echoes into the reproduce-this-export command line.
    Returning ``datetime.timezone.utc`` would have made all of those read a confident
    ``UTC`` -- indistinguishable from a UTC the caller actually asked for and the
    machine actually honoured. That is the same substitution ``local_offset_minutes``
    refuses when it answers ``None`` rather than a fabricated ``0``, and the same rule
    as invariant 7: a figure that could not be computed is reported as a LABELLED
    non-answer, never as a plausible-looking value. The arithmetic below is honest
    (+00:00 really is what was used); the LABEL is what stops it being read as the
    requested zone.
    """

    def __init__(self, requested: str | None = None):
        # What the caller asked for, so the label can name what was dropped.
        self.requested = requested or "UTC"

    def utcoffset(self, dt) -> timedelta:
        return timedelta(0)

    def dst(self, dt) -> timedelta:
        return timedelta(0)

    def tzname(self, dt) -> str:
        return "UTC"

    def __str__(self) -> str:
        # Greppable marker + the dropped request. This string is user-visible.
        return f"UTC [tzdb-unavailable; '{self.requested}' NOT honoured]"

    def __repr__(self) -> str:
        return f"NoTZDatabase({self.requested!r})"


def zone(tz: str | None) -> tzinfo:
    """Resolve an IANA name, falling back to UTC. A bad zone must not 500 a report --
    it degrades to UTC and the response echoes which zone was actually used, so the
    reader can tell.

    TOTAL: this function NEVER raises. That is not a stylistic preference -- see
    ``NoTZDatabase`` for the outage the previous "fallback" caused on any machine
    without a tz database, where ``ZoneInfo("UTC")`` failed exactly like the key it
    was standing in for. There are now three outcomes, and each is distinguishable
    from the others by the ``tz`` string every caller already echoes:

      * the requested zone resolved      -> ``str(z)`` is that zone
      * the zone is unknown here but the database exists
                                         -> ``str(z)`` is ``UTC``, which differs from
                                            what was asked for; the documented degrade
      * there is NO database at all      -> ``str(z)`` is the loud ``NoTZDatabase``
                                            label naming the zone that was dropped

    Note the loop tries the requested key FIRST and ``UTC`` only as a second pass, so
    a machine that has a database keeps byte-identical behaviour and the JS<->Python
    period-parity gate is unaffected.
    """
    for name in ((tz, "UTC") if tz else ("UTC",)):
        try:
            return ZoneInfo(name)
        except _ZONE_ERRORS:
            continue
    return NoTZDatabase(tz)


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


# The representable calendar, in epoch MILLISECONDS: [0001-01-01T00:00:00Z,
# 10000-01-01T00:00:00Z). Python's `datetime` covers exactly years 1..9999 and
# `periods.js::pdayOf` applies the same bound after shifting. Named here because the
# RECONSTRUCTION path in `pday_of` needs the bound on the RAW instant as well -- see the
# comment there.
CAL_MIN_MS = -62135596800000
CAL_MAX_MS = 253402300800000


def local_offset_minutes(ts_ms: int | float) -> int | None:
    """Minutes EAST of UTC on THIS MACHINE at that instant (US Central summer = -300),
    or ``None`` when this machine's offset at that instant CANNOT BE DETERMINED.

    Mirrors ``cli/src/peek/periods.js::tzOffsetAt``, which negates
    ``Date#getTimezoneOffset()`` because that reports minutes WEST -- getting the sign
    backwards silently shifts every pday by up to a day in the wrong direction.

    This is a RECONSTRUCTION, and only ever a fallback. An offset frozen on the row at
    write time is authoritative; this function is what a row that has none has to settle
    for. It resolves at the ROW'S OWN INSTANT rather than at "now", so a DST transition
    does not restate history -- but it cannot know that the machine has since moved
    timezone, which is exactly why the offset is now stored.

    It lives HERE, in the one module that imports neither ``metrics`` nor ``reporting``,
    because ``reporting`` imports ``metrics`` and both layers must reconstruct a legacy
    row identically. Two implementations of one rule is this project's recurring defect
    class; the ``pday``/UTC-date split was the last instance of it.

    ``None`` IS THE POINT OF THE RETURN TYPE. This used to answer ``0`` when it could
    not compute an offset -- an UNKNOWN reported as a MEASURED UTC, which is the exact
    substitution the frozen ``tzo`` column exists to prevent, one layer further down.
    And it was OBSERVABLE: on the year-1 / year-10000 calendar edges Python substituted
    0 and rendered a confident ``0001-01-01`` while ``periods.js::pdayOf`` shifted by the
    machine's real offset and returned null -- the two runtimes giving different answers
    to a price-date question, the drift class this module exists to close.
    ``pday_of`` propagates the None as an undatable row.

    The offset is resolved through an AWARE UTC datetime rather than a naive local one.
    The naive form (``fromtimestamp(s).astimezone()``) fails on this platform for every
    instant in the first ~day of year 1 even when the LOCAL wall time is perfectly
    representable, which made this function's domain a property of libc rather than of
    the calendar. The aware form fails exactly when the UTC instant or the local wall
    time falls outside years 1..9999 -- the same condition ``pdayOf`` applies to the
    SHIFTED instant. That is what lets the two runtimes agree on WHERE the answer stops
    existing, not merely on what it is inside the range.
    """
    try:
        dt = datetime.fromtimestamp(float(ts_ms) / 1000.0, tz=timezone.utc).astimezone()
        off = dt.utcoffset()
        return int(off.total_seconds() // 60) if off else 0
    except (OverflowError, OSError, ValueError, TypeError):
        return None


def pday_of(ts_ms: int | float, tzo_minutes: int | None = None) -> str | None:
    """The calendar+pricing day for an event: ``ts + tzo`` rendered as YYYY-MM-DD.

    ONE frame for both the calendar bucket and the price date. They used to disagree,
    and the catalog's dated windows made that a live 50% mispricing rather than a
    cosmetic one.

    TOTAL. It returns ``None`` for anything it cannot represent and NEVER raises --
    the annotation has always said ``str | None`` and every caller (``metrics._pday``,
    ``reporting.report_trend``, ``store``) treats it as total. It briefly was not:
    ``datetime.utcfromtimestamp`` was called unguarded, so ONE row carrying a
    seconds/milliseconds unit slip (``metrics.db`` stores SECONDS, the event store and
    ``periods.js`` store MILLISECONDS) raised ``ValueError``/``OverflowError``/``OSError``
    out of ``Metrics.logs``, ``Metrics.summary`` and ``reporting.gateway_row_to_event``
    and 500'd the ENTIRE audit log -- ``/logs``, ``/metrics``, ``/api/v1/logs``,
    ``/api/v1/reports/*`` and ``/api/v1/export`` -- not just that row. An undatable row
    must be a COUNTED, visible exclusion, never an outage.

    ``tzo_minutes is None`` means the offset was NOT RECORDED -- a legacy row, or a row
    whose sources disagreed and whose ``tzo`` ``store.merge`` therefore nulled. It is
    NOT "UTC". Reading it as 0 was the exact substitution the frozen-offset column
    exists to prevent, and it is a real 50% mispricing across the claude-sonnet-5 promo
    boundary. It is RECONSTRUCTED from this machine's zone at the row's own instant --
    the documented fallback, identical to ``periods.js::pdayOf``, which reconstructs via
    ``tzOffsetAt(ms)``. ``0`` remains a legitimate EXPLICIT value and is honoured as
    such; ``or 0`` could not tell the two apart, which is why it is gone.
    """
    try:
        ms = float(ts_ms)
    except (TypeError, ValueError):
        return None
    off = None
    if tzo_minutes is not None:
        try:
            off = int(tzo_minutes)          # truncates, like JS Math.trunc(Number(tzo))
        except (TypeError, ValueError):
            off = None
    if off is None:
        # RECONSTRUCTION PATH. Two guards, both mirrored in `periods.js::pdayOf`, both
        # there because the reconstructed offset is the ONE input the two runtimes cannot
        # be assumed to agree on outside the calendar:
        #
        #  1. the RAW instant must itself be a representable UTC time. Above year 9999
        #     JS happily reconstructs a westward offset and pulls the instant back to a
        #     confident '9999-12-31', while Python cannot represent the instant at all.
        #     Whether a date EXISTS must not depend on which runtime asked, nor on which
        #     side of UTC the machine happens to sit.
        #     HONEST NOTE, because a comment claiming more than the code does is the
        #     defect that put this block here: on THIS runtime the check is REDUNDANT.
        #     `local_offset_minutes` resolves through an aware UTC datetime and so
        #     already fails for exactly these instants -- deleting this line breaks no
        #     test, in any zone. It is written out because the rule has to read as ONE
        #     rule in BOTH files; in `periods.js` the equivalent line IS load-bearing
        #     (deleting it there reintroduces the '9999-12-31' divergence, and the parity
        #     gate fails on 8 answers). Here it is a mirror, not the guard.
        #  2. the offset must actually be DETERMINABLE. THIS is the load-bearing half on
        #     this runtime: `local_offset_minutes` answers None rather than a fabricated
        #     0 when it cannot compute one, and None means undatable -- the row becomes a
        #     counted, visible exclusion instead of a confident '0001-01-01'.
        #
        # An EXPLICIT `tzo` bypasses both: it is a recorded fact about the row, not a
        # reading of this machine, and both runtimes shift by it identically.
        if not (CAL_MIN_MS <= ms < CAL_MAX_MS):
            return None
        off = local_offset_minutes(ms)
        if off is None:
            return None
    try:
        shifted = datetime.utcfromtimestamp(ms / 1000.0 + off * 60)
        return shifted.strftime("%Y-%m-%d")
    except (OverflowError, OSError, ValueError):
        # Outside the representable calendar (year 1..9999). `periods.js::pdayOf`
        # applies the SAME bound and also returns null, so neither runtime invents a
        # year-55840 date for a row whose timestamp is in the wrong unit.
        return None


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


__all__ = ["PERIODS", "SKEW_TOLERANCE_MS", "CAL_MIN_MS", "CAL_MAX_MS", "period_bounds",
           "previous_period_bounds", "disjoint_ladder", "pday_of",
           "local_offset_minutes", "zone", "NoTZDatabase", "local_bounds_label"]
