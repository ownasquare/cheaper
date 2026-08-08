"""``periods.zone`` on a machine with NO IANA time zone database.

``zoneinfo`` is stdlib but ships no DATA. It reads the database from the operating
system (``/usr/share/zoneinfo`` and friends) or, failing that, from the ``tzdata``
PyPI package. macOS and mainstream Linux always have the OS copy, which is why this
whole class of failure is invisible on a developer machine. **Windows ships none**,
and neither does musl/Alpine.

The bug this file pins was NOT "a Windows box silently reports UTC". ``zone()``'s
fallback was ``ZoneInfo("UTC")``, and "UTC" is an ordinary key that needs the SAME
database as any other -- so on a machine without one the fallback raised the identical
``ZoneInfoNotFoundError`` it was written to absorb, and the exception escaped
``zone()`` entirely. Every reporting entry point calls ``zone()``, so the real
Windows outcome was a 500 on ``/api/v1/reports/*``, the periods ladder, the trend and
the export header: an OUTAGE, not a degradation.

The missing database is simulated rather than mocked -- ``zoneinfo.reset_tzpath`` is
pointed at an empty directory and a meta-path hook blocks the ``tzdata`` import, so
the real ``ZoneInfo`` constructor really does fail the way it does on Windows.
"""

from __future__ import annotations

import importlib
import sys
import zoneinfo

import pytest

import periods


class _BlockTzdata:
    """Meta-path finder that makes ``import tzdata`` fail, as it does on a Windows
    box that never installed it. Without this the fallback data package would satisfy
    every lookup on a developer machine and the test would prove nothing."""

    def find_spec(self, name, path=None, target=None):
        if name == "tzdata" or name.startswith("tzdata."):
            raise ImportError("simulated: no tzdata package (Windows / musl)")
        return None


@pytest.fixture()
def no_tz_database(tmp_path):
    """Point zoneinfo at an empty search path AND hide ``tzdata``. Restores both, and
    clears the ZoneInfo cache on the way in and out so neither this test nor its
    neighbours see a zone that was resolved under the other configuration."""
    saved_path = list(zoneinfo.TZPATH)
    saved_modules = {k: v for k, v in sys.modules.items()
                     if k == "tzdata" or k.startswith("tzdata.")}
    blocker = _BlockTzdata()
    sys.meta_path.insert(0, blocker)
    for k in saved_modules:
        del sys.modules[k]
    zoneinfo.reset_tzpath(to=[str(tmp_path / "no-such-tzdb")])
    zoneinfo.ZoneInfo.clear_cache()
    try:
        yield
    finally:
        sys.meta_path.remove(blocker)
        sys.modules.update(saved_modules)
        zoneinfo.reset_tzpath(to=saved_path)
        zoneinfo.ZoneInfo.clear_cache()


def test_the_simulation_is_real_the_stdlib_really_cannot_resolve_utc(no_tz_database):
    """Guard on the fixture itself. If this ever stops raising, every assertion below
    becomes vacuous -- it would be testing the ordinary happy path while claiming to
    test the Windows one."""
    with pytest.raises(zoneinfo.ZoneInfoNotFoundError):
        zoneinfo.ZoneInfo("America/Chicago")
    with pytest.raises(zoneinfo.ZoneInfoNotFoundError):
        zoneinfo.ZoneInfo("UTC")          # THE point: the fallback key fails too


def test_zone_is_total_it_never_raises(no_tz_database):
    for tz in ("America/Chicago", "UTC", None, "Not/AZone", "", "Europe/Paris"):
        z = periods.zone(tz)              # must not raise
        assert z.utcoffset(None).total_seconds() == 0


def test_zone_labels_the_degradation_instead_of_pretending(no_tz_database):
    """Invariant 7: a value that could not be produced is reported as a LABELLED
    non-answer, never as a plausible-looking one. ``str(z)`` is what
    ``period_bounds``/``disjoint_ladder`` put in their ``tz`` field and what
    ``local_bounds_label`` prints under every heading, so a bare ``UTC`` here would be
    indistinguishable from a UTC the caller asked for and the machine honoured."""
    z = periods.zone("America/Chicago")
    assert isinstance(z, periods.NoTZDatabase)
    label = str(z)
    assert "tzdb-unavailable" in label, label
    assert "America/Chicago" in label, "the label must name the zone that was DROPPED"
    assert "NOT honoured" in label, label
    assert label != "UTC", "a bare 'UTC' would read as a zone that was actually honoured"


def test_every_public_entry_point_survives(no_tz_database):
    """These are the callers that 500'd. ``reporting`` reaches all of them."""
    b = periods.period_bounds("today", 1_700_000_000_000, "America/Chicago")
    assert b["from"] < b["to"]
    assert "tzdb-unavailable" in b["tz"]

    prev = periods.previous_period_bounds("month", 1_700_000_000_000, "America/Chicago")
    assert prev["to"] <= b["from"]

    ladder = periods.disjoint_ladder(1_700_000_000_000, "America/Chicago")
    assert len(ladder) == 6
    assert all("tzdb-unavailable" in w["tz"] for w in ladder)

    lbl = periods.local_bounds_label(b["from"], b["to"], "America/Chicago")
    assert "tzdb-unavailable" in lbl, lbl
    assert "UTC+00:00" in lbl, "the offset actually used is +00:00 and must be stated"


def test_the_ladder_still_partitions_history_without_a_database(no_tz_database):
    """The degraded frame must still be a CONSISTENT one: the disjoint ladder's whole
    job is to sum to lifetime, and a fallback that broke that would trade an outage
    for wrong numbers."""
    rows = periods.disjoint_ladder(1_700_000_000_000, "America/Chicago")
    assert rows[0]["key"] == "today"
    assert rows[-1]["from"] is None
    for a, b in zip(rows, rows[1:]):
        if a["from"] is not None and b["to"] is not None:
            assert b["to"] == a["from"], "windows must remain contiguous and non-overlapping"


def test_pday_and_offset_do_not_depend_on_the_database(no_tz_database):
    """``pday_of`` prices a row, so a missing tz database must not make a row
    undatable. It shifts by an EXPLICIT offset and otherwise reconstructs from the
    machine clock -- neither path goes through ``ZoneInfo``."""
    assert periods.pday_of(1_700_000_000_000, 0) == "2023-11-14"
    assert periods.pday_of(1_700_000_000_000, -360) == "2023-11-14"
    assert periods.local_offset_minutes(1_700_000_000_000) is not None


# --- and the ordinary machine is untouched --------------------------------

def test_a_machine_WITH_a_database_is_completely_unchanged():
    """Over-correction guard. The new fallback is reachable only when the database is
    absent; where one exists, ``zone()`` must return the same real ``ZoneInfo`` it
    always did -- including the documented degrade-to-UTC for an unknown key, which
    the JS<->Python period-parity gate compares against."""
    z = periods.zone("America/Chicago")
    assert isinstance(z, zoneinfo.ZoneInfo)
    assert str(z) == "America/Chicago"

    assert isinstance(periods.zone(None), zoneinfo.ZoneInfo)
    assert str(periods.zone(None)) == "UTC"

    # Unknown key, database present -> the documented UTC degrade, NOT the loud label.
    bad = periods.zone("Not/AZone")
    assert isinstance(bad, zoneinfo.ZoneInfo)
    assert str(bad) == "UTC"
    assert not isinstance(bad, periods.NoTZDatabase)


def test_a_non_string_zone_is_degraded_rather_than_raised():
    """``zone()`` is documented total. A non-str key raises TypeError out of ZoneInfo,
    which the old two-exception tuple did not catch."""
    for bad in (123, object(), ["UTC"]):
        assert periods.zone(bad).utcoffset(None).total_seconds() == 0


def test_tzdata_is_pinned_as_a_requirement():
    """The fallback above is the SAFETY NET, not the fix. The fix is shipping the
    database: without ``tzdata`` in requirements.txt every Windows install silently
    loses real timezone support and reports every period in the degraded frame."""
    from pathlib import Path

    req = (Path(__file__).resolve().parents[1] / "requirements.txt").read_text()
    lines = [l.strip() for l in req.splitlines()
             if l.strip() and not l.strip().startswith("#")]
    assert any(l.split("=")[0].split(">")[0].split("<")[0].strip() == "tzdata"
               for l in lines), \
        "tzdata must be a hard requirement — Windows and musl ship no system tz database\n" + req
    # Unconditional on purpose: a `; sys_platform == "win32"` marker would leave musl
    # containers broken.
    assert not any(l.startswith("tzdata") and ";" in l for l in lines), \
        "tzdata must not be gated on a platform marker"
