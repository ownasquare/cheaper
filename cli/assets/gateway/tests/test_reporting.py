"""The reporting invariants — the ones whose violation is a wrong dollar figure.

Six properties are on trial, each of which has already failed in this product at least
once:

  1. the DISJOINT ladder PARTITIONS history, so its rows sum to lifetime (the old nested
     "since" ladder did not, so six rows with a Saved column could be added to six times
     today);
  2. ``report(Jan) + report(Feb) == report(Jan u Feb)`` to the cent, which is only true
     because every session-scoped input is frozen per row and the windows are half-open;
  3. an uncovered period reports ``not_covered``, never ``$0.00`` -- "$0" and "we
     weren't watching" are different claims and only one of them is a measurement;
  4. more than 20% unpriceable tokens SUPPRESSES dollars and reports tokens;
  5. THE ABSOLUTE INVARIANT: no API response field is produced by an expression reading
     both a ``measured`` and an ``estimated`` accumulator -- including Spent and Events,
     not only Saved -- and a chat count is never added to a call count;
  6. keyset pagination returns every row exactly once across pages, with no duplicates
     and no skips, when new rows land mid-scroll.
"""

from __future__ import annotations

import contextlib
import json
import math
import os
import sys
import time
from datetime import datetime, timezone

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import periods  # noqa: E402
import reporting  # noqa: E402
import store  # noqa: E402

# A DST-observing zone that is never UTC. Offset assertions below are written against
# THESE numbers, never against whatever the host reports -- see pinned_zone().
PINNED_ZONE = "America/Los_Angeles"
PINNED_SUMMER_OFFSET = -420      # PDT


@contextlib.contextmanager
def pinned_zone(name: str = PINNED_ZONE):
    """Pin the PROCESS timezone for the body of the test.

    A legacy-row test that reads its own expectation from
    ``periods.local_offset_minutes()`` ON THE HOST cannot distinguish "reconstructed"
    from "silently read as UTC" when the host IS UTC -- the default for most CI
    runners. Negative control: with the reconstruction reverted to a plain 0, the suite
    passed under TZ=UTC and failed only under a real zone. A test must SUPPLY the frame
    it asserts about.
    """
    if not hasattr(time, "tzset"):          # Windows: no tzset, no pinning
        pytest.skip("time.tzset() unavailable; cannot pin the process timezone")
    old = os.environ.get("TZ")
    os.environ["TZ"] = name
    time.tzset()
    try:
        yield
    finally:
        if old is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = old
        time.tzset()


TZ = "UTC"
NOW = 1786112520000          # 2026-08-07T14:22:00Z — fixed, so the ladder is stable
DAY = 86400000


def utc_ms(y, mo, d, h=0, mi=0):
    return int(datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp() * 1000)


# The local day NOW falls on at UTC — so a row frozen at this day belongs to the ladder's
# `today` window and to no other. Used as the FROZEN day of a row whose `ts` is dead.
PDAY_ONLY_DAY = "2026-08-07"
# A window that provably excludes that day, on both sides.
APRIL = (utc_ms(2026, 4, 1), utc_ms(2026, 5, 1))
Y2027 = (utc_ms(2027, 1, 1), utc_ms(2027, 2, 1))


# ---------------------------------------------------------------------------
# fixture plumbing
# ---------------------------------------------------------------------------

def ev(idx, *, ts, served="claude-sonnet-5", base="claude-opus-5", conf="estimated",
       prov="transcript", session="rpt-session", in_tok=10000, out_tok=2000,
       elig=True, status=200, harness="claude-code", pday=None, cr=0, c5=0, reason=""):
    # `cr`/`c5` are the two halves of the cache-state question `store.derive_row` asks of
    # a SWITCHED row (`served != base`, which is this helper's default): a 5-minute cache
    # WRITE with no read is a cold start after a switch, whose counterfactual is an
    # interval that straddles zero, so the row is withheld and labelled
    # `cache_state_indeterminate`. Both default to 0 — no cache traffic at all — so every
    # existing caller is unaffected.
    return {
        "v": 1, "id": f"rid:req_rpt{idx:04d}", "rev": 1,
        "w": "gw" if prov == "gateway" else "cli", "inst": "testinst",
        "ts": ts, "tzo": 0, "pday": pday if pday is not None else periods.pday_of(ts, 0),
        "ingested_at": ts, "prov": prov,
        "usrc": "body", "conf": conf, "harness": harness,
        "sessions": [session], "sess": session, "sub": False,
        "served": served, "req": None, "base": base, "bsrc": "tx_session_ceiling",
        "elig": elig, "ctier": "sonnet", "cver": 3, "reason": reason,
        "in": in_tok, "out": out_tok, "cr": cr, "c5": c5, "c1": 0, "cu": 0,
        "speed": None, "svc": "standard", "status": status,
        "sfile": None, "sbase": None, "fsha": None, "vok": True,
    }


def write_segment(directory, events, name="2026-08.testinst.cli.jsonl", append=False):
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, name)
    with open(path, "a" if append else "w", encoding="utf-8") as fh:
        for e in events:
            fh.write(json.dumps(e) + "\n")
    return path


def write_state(directory, coverage=None, tombstones=None):
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, "state.json"), "w", encoding="utf-8") as fh:
        json.dump({"v": 1, "coverage": coverage or [], "tombstones": tombstones or [],
                   "ingested_files": []}, fh)


@pytest.fixture()
def events_dir(tmp_path, monkeypatch):
    d = tmp_path / "events"
    d.mkdir()
    monkeypatch.setenv("CHEAPER_EVENTS_DIR", str(d))
    return str(d)


def rows_from(directory):
    """The folded rows, event store ONLY. The gateway's own SQLite ledger is excluded
    here so these arithmetic assertions are not perturbed by rows other test modules
    recorded into the shared metrics.db."""
    return reporting.unified_rows(None, directory)["rows"]


# ---------------------------------------------------------------------------
# 1. the disjoint ladder partitions history
# ---------------------------------------------------------------------------

def test_the_disjoint_ladder_sums_to_lifetime(events_dir):
    ladder = periods.disjoint_ladder(NOW, TZ)
    assert [w["key"] for w in ladder] == ["today", "week_earlier", "month_earlier",
                                          "quarter_earlier", "year_earlier", "before"]
    events = []
    i = 0
    for w in ladder:
        anchor = (w["from"] + 3600000) if w["from"] is not None else (w["to"] - 5 * DAY)
        for k in range(2):
            i += 1
            events.append(ev(i, ts=anchor + k * 60000,
                             conf="measured" if k else "estimated",
                             served="claude-haiku-4-5" if k else "claude-sonnet-5"))
    write_segment(events_dir, events)
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])

    rows = rows_from(events_dir)
    assert len(rows) == len(events)

    report = reporting.report_periods(rows, TZ, now_ms=NOW)
    lifetime = store.fold_rows(rows)

    for basis in ("measured", "estimated"):
        for field in ("saved", "spent", "baseline", "gross", "extra"):
            laddered = sum(r[basis][field] for r in report)
            assert laddered == pytest.approx(lifetime[basis][field], abs=1e-9), \
                f"the ladder does not partition history for {basis}.{field}"
        for field in ("calls", "tokens", "credited", "offset"):
            assert sum(r[basis][field] for r in report) == lifetime[basis][field]

    # Every ladder row is populated, so the assertion above is not vacuous.
    assert all(r["measured"]["calls"] == 1 and r["estimated"]["calls"] == 1
               for r in report)

    # And the same identity against `lifetime`, which is computed INDEPENDENTLY as one
    # window over the whole range rather than as a sum of the ladder. A bug in the
    # ladder therefore surfaces as a disagreement instead of being reproduced in the
    # total and rendered as agreement.
    lifetime_window = reporting.lifetime_window(rows, TZ)
    assert not lifetime_window["dollars_suppressed"]
    for basis in ("measured", "estimated"):
        for field in ("saved", "spent", "baseline"):
            assert sum(r[basis][field] for r in report) == pytest.approx(
                lifetime_window[basis][field], abs=1e-9)
        assert sum(r[basis]["calls"] for r in report) == lifetime_window[basis]["calls"]


def test_a_suppressed_ladder_row_breaks_the_naive_sum_and_says_so(events_dir):
    """The partition invariant and the >20%-unpriceable suppression rule are BOTH
    correct and they interact: suppression is a per-window render decision, so a window
    can withhold its dollars while `lifetime` — judged over all the tokens at once — does
    not, and that window's priced rows still contribute to the lifetime figure.

    So `sum(periods[].measured.saved) == lifetime.measured.saved` holds only while every
    row reports dollars. A consumer must skip rows whose `dollars_suppressed` is true, or
    compare on `tokens`/`events`, which are never suppressed. This test pins that
    contract so nobody 'fixes' it by treating a suppressed None as 0."""
    ladder = periods.disjoint_ladder(NOW, TZ)
    today_w = [w for w in ladder if w["key"] == "today"][0]
    year_w = [w for w in ladder if w["key"] == "year_earlier"][0]
    events = [
        # A big, well-priced block far from today keeps LIFETIME under the 20% threshold.
        ev(1, ts=year_w["from"] + 3600000, in_tok=900000, out_tok=50000),
        # ...while today's window, on its own, is 100% unpriceable.
        ev(2, ts=today_w["from"] + 3600000, served="llama-4-maverick",
           in_tok=40000, out_tok=5000),
    ]
    write_segment(events_dir, events)
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    rows = rows_from(events_dir)
    report = reporting.report_periods(rows, TZ, now_ms=NOW)
    lifetime_window = reporting.lifetime_window(rows, TZ)

    today_row = [r for r in report if r["key"] == "today"][0]
    assert today_row["dollars_suppressed"] is True
    assert today_row["estimated"]["saved"] is None
    assert lifetime_window["dollars_suppressed"] is False
    assert lifetime_window["estimated"]["saved"] > 0

    # tokens and events are never suppressed, so THEY still partition exactly.
    assert sum(r["tokens"]["estimated"] for r in report) == \
        lifetime_window["tokens"]["estimated"]
    assert sum(r["events"]["estimated"] for r in report) == \
        lifetime_window["events"]["estimated"]

    # And the dollars identity holds once the suppressed rows are excluded on BOTH sides.
    priced = [r for r in report if not r["dollars_suppressed"]]
    assert sum(r["estimated"]["saved"] for r in priced) == pytest.approx(
        lifetime_window["estimated"]["saved"], abs=1e-9)


def test_the_ladder_windows_are_disjoint_and_each_instant_lands_in_exactly_one(events_dir):
    ladder = periods.disjoint_ladder(NOW, TZ)
    probes = []
    for w in ladder:
        if w["from"] is not None:
            probes += [w["from"], w["from"] + 1, w["to"] - 1]
    for t in probes:
        hits = [w["key"] for w in ladder
                if (w["from"] is None or t >= w["from"]) and (w["to"] is None or t < w["to"])]
        assert len(hits) == 1, f"instant {t} landed in {hits}"


# ---------------------------------------------------------------------------
# 2. additivity
# ---------------------------------------------------------------------------

def test_report_jan_plus_report_feb_equals_report_jan_union_feb(events_dir):
    jan = 1767225600000        # 2026-01-01T00:00:00Z
    feb = 1769904000000        # 2026-02-01T00:00:00Z
    mar = 1772323200000        # 2026-03-01T00:00:00Z
    events = []
    for i in range(6):
        events.append(ev(i + 1, ts=jan + i * 3 * DAY,
                         conf="measured" if i % 2 else "estimated",
                         served="claude-haiku-4-5" if i % 3 else "claude-fable-5"))
    for i in range(6):
        events.append(ev(i + 100, ts=feb + i * 3 * DAY,
                         conf="measured" if i % 2 else "estimated",
                         served="claude-sonnet-5" if i % 3 else "claude-fable-5"))
    write_segment(events_dir, events, name="2026-01.testinst.cli.jsonl")
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])

    rows = rows_from(events_dir)
    st = store.load_state()
    a = reporting.report_window(rows, jan, feb, st, TZ)
    b = reporting.report_window(rows, feb, mar, st, TZ)
    both = reporting.report_window(rows, jan, mar, st, TZ)

    for basis in ("measured", "estimated"):
        for field in ("saved", "spent", "baseline", "gross", "extra"):
            assert a[basis][field] + b[basis][field] == pytest.approx(
                both[basis][field], abs=1e-9), f"{basis}.{field} is not additive"
        for field in ("calls", "tokens"):
            assert a[basis][field] + b[basis][field] == both[basis][field]
    # Non-trivially: some rows really did cost MORE than their baseline.
    assert both["measured"]["extra"] > 0 or both["estimated"]["extra"] > 0


def test_the_window_is_half_open_so_the_boundary_instant_belongs_to_exactly_one(events_dir):
    boundary = 1769904000000
    write_segment(events_dir, [ev(1, ts=boundary)])
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    rows = rows_from(events_dir)
    st = store.load_state()
    before = reporting.report_window(rows, boundary - DAY, boundary, st, TZ)
    after = reporting.report_window(rows, boundary, boundary + DAY, st, TZ)
    counts = (before["estimated"]["calls"], after["estimated"]["calls"])
    assert counts == (0, 1), "`to` must be EXCLUSIVE and `from` INCLUSIVE"


# ---------------------------------------------------------------------------
# 3. not_covered, never $0.00
# ---------------------------------------------------------------------------

def test_a_period_outside_coverage_reports_not_covered_and_no_dollar_figure(events_dir):
    write_segment(events_dir, [ev(1, ts=NOW - DAY)])
    # We watched only the last two days. Anything older was never observed.
    write_state(events_dir, [{"kind": "observed", "from": NOW - 2 * DAY, "to": NOW}])
    rows = rows_from(events_dir)
    st = store.load_state()
    old = reporting.report_window(rows, NOW - 400 * DAY, NOW - 300 * DAY, st, TZ)

    assert old["status"] == "not_covered"
    assert old["measured"] is None and old["estimated"] is None
    assert "not_covered" in old["labels"]
    assert "not the same as saving $0" in " ".join(old["notes"])
    # There is no zero anywhere to be misread as a measurement.
    blob = json.dumps(old)
    assert '"saved"' not in blob and "0.0" not in blob.replace('"0.0', "")


def test_events_are_their_own_coverage_evidence(events_dir):
    """The live case: nobody has ever written a coverage heartbeat, or state.json was
    lost. A recorded call at instant T is direct evidence we were watching at T —
    stronger evidence than a declared interval — so a window full of real events is
    still reported. "not covered" over live data is as wrong as "$0.00" over no data.

    Mirrors cli/src/peek/store.js::impliedCoverage, including its one-day pad."""
    write_segment(events_dir, [ev(1, ts=NOW - DAY)])
    write_state(events_dir, [])                     # no declared coverage at all
    rows = rows_from(events_dir)
    st = store.load_state()

    # Far from any event: still not_covered, and still not $0.00.
    empty = reporting.report_window(rows, NOW - 400 * DAY, NOW - 300 * DAY, st, TZ)
    assert empty["status"] == "not_covered"
    assert empty["measured"] is None and empty["estimated"] is None

    # Over the event itself: reported, from implied coverage alone.
    live = reporting.report_window(rows, NOW - 2 * DAY, NOW, st, TZ)
    assert live["status"] == "ok"
    assert live["estimated"]["calls"] == 1

    # The pad never WIDENS a claim beyond a day either side of a contiguous run.
    imp = store.implied_coverage(rows)
    assert imp == [{"kind": "observed", "from": (NOW - DAY) - store.IMPLIED_PAD_MS,
                    "to": (NOW - DAY) + store.IMPLIED_PAD_MS}]


def test_a_partially_covered_period_says_so_and_describes_only_the_covered_sub_window(events_dir):
    write_segment(events_dir, [ev(1, ts=NOW - DAY)])
    write_state(events_dir, [{"kind": "observed", "from": NOW - 2 * DAY, "to": NOW}])
    rows = rows_from(events_dir)
    st = store.load_state()
    rep = reporting.report_window(rows, NOW - 10 * DAY, NOW, st, TZ)
    assert rep["status"] == "partial"
    assert "partial_coverage" in rep["labels"]
    assert rep["coverage"]["kind"] == "partial"
    assert "covered sub-window only" in " ".join(rep["notes"])


def test_a_store_written_by_a_newer_cheaper_refuses_rather_than_reporting_zero(events_dir):
    write_segment(events_dir, [ev(1, ts=NOW - DAY)])
    with open(os.path.join(events_dir, "state.json"), "w", encoding="utf-8") as fh:
        json.dump({"v": 99, "coverage": [], "tombstones": []}, fh)
    rows = rows_from(events_dir)
    rep = reporting.report_window(rows, NOW - DAY * 2, NOW, store.load_state(), TZ)
    assert rep["status"] == "suppressed"
    assert rep["measured"] is None and rep["estimated"] is None
    assert "store_newer_than_reader" in rep["labels"]
    # The tombstone COUNT is withheld too. `load_state` returns an empty list for this
    # disposition because it declined to read the document, not because the document
    # holds nothing -- and `0` is a claim about the user's deletions that nobody made.
    assert rep["tombstones"] is None


# `state.json` holds the `cheaper forget` tombstones. A tombstone is the record that a
# user asked for a chat to be excluded from every total, so a reader that cannot parse
# that file and reports anyway silently RE-ADMITS the data they asked to remove -- the
# totals simply go back up, with no label, no count and no way to notice. These pin the
# refusal, and pin that it is NOT extended to a merely ABSENT file (which would blank
# every first run).

@pytest.mark.parametrize("label,body", [
    ("truncated", '{"v":1,"coverage":[],"tombstones":[{"session":"sess-'),
    ("not_json", "this is not json at all"),
    ("json_null", "null"),
    ("json_array", "[]"),
    ("empty", ""),
])
def test_an_unreadable_state_file_refuses_rather_than_reporting_an_untombstoned_total(
        events_dir, label, body):
    write_segment(events_dir, [ev(1, ts=NOW - DAY)])
    with open(os.path.join(events_dir, "state.json"), "w", encoding="utf-8") as fh:
        fh.write(body)
    rows = rows_from(events_dir)
    st = store.load_state()
    assert st.get("unreadable"), f"{label} must be an UNREADABLE disposition, not empty"

    rep = reporting.report_window(rows, NOW - DAY * 2, NOW, st, TZ)
    assert rep["status"] == "suppressed", label
    assert rep["measured"] is None and rep["estimated"] is None, label
    assert "state_unreadable" in rep["labels"], label
    assert rep["tombstones"] is None, label
    joined = " ".join(rep["notes"])
    assert "state.json could not be read" in joined
    assert "tombstone" in joined, "the note must say WHAT is at risk, not just that it failed"
    # No dollar figure survives anywhere in the payload to be misread as a measurement.
    assert '"saved"' not in json.dumps(rep)


def test_the_refusal_is_exactly_what_stops_a_deleted_session_from_coming_back(events_dir):
    """The concrete harm, end to end. With the state file INTACT the tombstone is honoured
    and the window says so. Corrupt the same file and the old reader answered with the
    un-tombstoned total -- a number strictly larger than the one the user last saw, with
    nothing anywhere naming the difference."""
    write_segment(events_dir, [ev(1, ts=NOW - DAY)])
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}],
                tombstones=[{"session": "rpt-session", "from": NOW - 2 * DAY,
                             "to": NOW, "at": NOW - DAY}])
    rows = rows_from(events_dir)
    intact = reporting.report_window(rows, NOW - 2 * DAY, NOW, store.load_state(), TZ)
    assert intact["tombstones"] == 1
    assert "tombstoned" in intact["labels"]

    # Same store, same events; only the state document is now unreadable.
    path = os.path.join(events_dir, "state.json")
    with open(path, encoding="utf-8") as fh:
        whole = fh.read()
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(whole[: len(whole) // 2])
    corrupt = reporting.report_window(rows, NOW - 2 * DAY, NOW, store.load_state(), TZ)
    assert corrupt["status"] == "suppressed"
    assert "state_unreadable" in corrupt["labels"]
    # The decisive comparison: the corrupt read must NOT come back as the un-tombstoned
    # window, which is exactly what an empty-state fallback produces.
    assert corrupt["estimated"] is None
    assert "tombstoned" not in corrupt["labels"], (
        "reporting a window with neither the tombstone nor the refusal is the "
        "re-admission this branch exists to prevent")


def test_an_ABSENT_state_file_still_reports_normally(events_dir):
    """The refusal must stay narrow. A first run has no state.json at all, and
    `implied_coverage` speaks for the events themselves -- a store that never declared
    coverage has no tombstones to miss."""
    write_segment(events_dir, [ev(1, ts=NOW - DAY)])
    assert not os.path.exists(os.path.join(events_dir, "state.json"))
    rows = rows_from(events_dir)
    rep = reporting.report_window(rows, NOW - 2 * DAY, NOW, store.load_state(), TZ)
    assert rep["status"] == "ok"
    assert "state_unreadable" not in rep["labels"]
    assert rep["estimated"]["calls"] == 1


def test_a_tombstone_in_the_window_makes_the_drop_visible(events_dir):
    write_segment(events_dir, [ev(1, ts=NOW - DAY)])
    write_state(events_dir,
                [{"kind": "observed", "from": 0, "to": NOW + DAY}],
                [{"kind": "tombstone", "session": "gone", "events_removed": 4,
                  "at": NOW - DAY}])
    rows = rows_from(events_dir)
    rep = reporting.report_window(rows, NOW - 2 * DAY, NOW, store.load_state(), TZ)
    assert "tombstoned" in rep["labels"]
    assert rep["tombstones"] == 1
    assert "cheaper forget" in " ".join(rep["notes"])


def test_an_undated_row_is_excluded_AND_counted(events_dir):
    good = ev(1, ts=NOW - DAY)
    bad = ev(2, ts=None)
    bad["pday"] = None
    write_segment(events_dir, [good, bad])
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    rows = rows_from(events_dir)
    rep = reporting.report_window(rows, NOW - 2 * DAY, NOW, store.load_state(), TZ)
    assert rep["undated"] == 1
    assert "incomplete" in rep["labels"]
    assert rep["estimated"]["calls"] == 1


# ---------------------------------------------------------------------------
# 4. suppression above 20% unpriceable tokens
# ---------------------------------------------------------------------------

def test_more_than_twenty_percent_unpriceable_tokens_suppresses_dollars(events_dir):
    events = [ev(1, ts=NOW - DAY, in_tok=10000, out_tok=1000),
              ev(2, ts=NOW - DAY + 1000, in_tok=10000, out_tok=1000),
              # A model with no published list price: 40% of the window's tokens.
              ev(3, ts=NOW - DAY + 2000, served="llama-4-maverick",
                 in_tok=13000, out_tok=1000)]
    write_segment(events_dir, events)
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    rows = rows_from(events_dir)
    rep = reporting.report_window(rows, NOW - 2 * DAY, NOW, store.load_state(), TZ)

    assert rep["status"] == "suppressed"
    assert rep["dollars_suppressed"] is True
    # DOLLARS are withheld -- not quietly computed from four fifths of the evidence.
    for basis in ("measured", "estimated"):
        for field in ("saved", "spent", "baseline", "gross", "extra"):
            assert rep[basis][field] is None, f"{basis}.{field} must claim nothing"
    # ...but the COUNTS are exactly known and are not in doubt, so they stay.
    assert rep["estimated"]["calls"] == 2 and rep["estimated"]["tokens"] > 0
    assert rep["tokens"]["estimated"] > 0
    # `events` is ROWS SEEN, so it counts all THREE -- including the one whose dollars
    # could not be derived. `calls` inside the accumulator is ROWS PRICED and stays 2.
    # The two are different questions and the window answers both, so a reader can see
    # "3 events, 1 of which could not be priced" instead of a count that silently drops
    # the very row the note beneath it is about.
    assert rep["events"] == {"measured": 0, "estimated": 3}
    assert rep["events"]["estimated"] - rep["estimated"]["calls"] == rep["unpriced_calls"]
    assert rep["unpriced"] == {"served_not_in_catalog": 1}
    assert "dollars_suppressed" in rep["labels"]
    note = " ".join(rep["notes"])
    assert "1 of 3 call(s) in this window" in note, "the note must be per-window and specific"
    assert "llama-4-maverick" in note, "name the models that cannot be priced"
    assert "Call and token counts are exact." in note
    assert "cheaper update" in note


def test_the_trend_bucket_and_the_breakdown_group_withhold_what_the_window_withholds(
        events_dir):
    """The mirror of `cli/test/store.test.js`'s "a trend BUCKET withholds…".

    `fold_rows` computes `dollars_suppressed` for EVERY set of rows it folds.
    `report_window` applied it; `report_trend::_point` and `report_breakdown` computed it
    and threw it away, publishing raw accumulators with no flag at all -- byte-for-byte
    the omission `cli/src/peek/store.js` had. The day-grain bucket covers exactly the rows
    the ladder's day row covers, so one dashboard carried both claims at once:

        Aug 12 (withheld)  withheld | withheld   ...so no dollar figure is claimed.
        2026-08-12  $0.02 | $0.02  #  |  #

    Two priceable calls plus one call on a model absent from the catalog whose tokens
    dominate -- the same fixture the CLI half of this test uses.
    """
    events = [ev(1, ts=NOW - DAY, in_tok=1000, out_tok=1000),
              ev(2, ts=NOW - DAY + 1000, in_tok=1000, out_tok=1000),
              ev(3, ts=NOW - DAY + 2000, served="llama-4-maverick",
                 in_tok=500000, out_tok=500000)]
    write_segment(events_dir, events)
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    rows = rows_from(events_dir)
    frm, to = NOW - 2 * DAY, NOW
    rep = reporting.report_window(rows, frm, to, store.load_state(), TZ)
    assert rep["dollars_suppressed"] is True
    assert rep["estimated"]["saved"] is None

    points = reporting.report_trend(rows, "day", frm, to)
    assert len(points) == 1, points
    p = points[0]
    # THE BLOCKER: this point used to carry a real `saved` and NO `dollars_suppressed`
    # key at all, over the same rows the window declines to price.
    assert p["dollars_suppressed"] is True
    for field in ("saved", "spent", "baseline", "gross", "extra"):
        assert p["estimated"][field] is None, field
    # Only the DOLLARS are withheld. The counts are exact and are not in doubt.
    assert p["estimated"]["calls"] == 2
    assert p["events"] == {"measured": 0, "estimated": 3}
    assert p["unpriced_calls"] == 1
    # ...and the two surfaces agree, field for field, about what they withheld.
    assert p["dollars_suppressed"] == rep["dollars_suppressed"]
    assert p["events"] == rep["events"]

    groups = reporting.report_breakdown(rows, "served", frm, to)
    keyed = {g["key"]: g for g in groups}
    assert set(keyed) == {"claude-sonnet-5", "llama-4-maverick"}, list(keyed)
    un = keyed["llama-4-maverick"]
    assert un["dollars_suppressed"] is True
    assert un["estimated"]["saved"] is None
    assert un["unpriced_calls"] == 1
    assert un["events"] == {"measured": 0, "estimated": 1}
    # GUARD THE GUARD: the decision is per GROUP, taken on that group's own rows.
    # Suppressing every group because one row somewhere is unpriceable would erase a
    # sound figure -- concealment in the opposite direction.
    ok = keyed["claude-sonnet-5"]
    assert ok["dollars_suppressed"] is False
    assert ok["estimated"]["saved"] > 0
    assert ok["unpriced_calls"] == 0
    # The group that STATES a figure ranks above the one that declines: `None or None`
    # fed to the old sort key is not orderable, and coercing it to 0 would rank a
    # declined claim among the measured zeroes.
    assert [g["key"] for g in groups] == ["claude-sonnet-5", "llama-4-maverick"]


def test_a_window_that_is_one_hundred_percent_unpriced_still_reports_its_counts(events_dir):
    """A window holding a single 429 and nothing else must say "1 call, 0 priced" rather
    than going blank. Blanking throws away a fact in order to hide an uncertainty."""
    write_segment(events_dir, [ev(1, ts=NOW - DAY, status=429)])
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    rows = rows_from(events_dir)
    rep = reporting.report_window(rows, NOW - 2 * DAY, NOW, store.load_state(), TZ)
    assert rep["status"] == "suppressed"
    assert rep["unpriced"] == {"non_2xx": 1}
    # "1 call, 0 priced" -- the sentence in the docstring, as the payload states it.
    # `events` (rows SEEN) says 1; `calls` (rows PRICED) says 0. Reporting `calls` as
    # `events` printed "0 events" directly above this window's own note asserting one
    # call whose count is EXACT, which is the self-contradiction this file gates.
    assert rep["events"] == {"measured": 0, "estimated": 1}
    assert rep["estimated"]["calls"] == 0 and rep["measured"]["calls"] == 0
    assert rep["unpriced_calls"] == 1
    assert rep["measured"]["saved"] is None and rep["estimated"]["saved"] is None
    assert "1 of 1 call(s) in this window (100% of its tokens)" in " ".join(rep["notes"])


# ---------------------------------------------------------------------------
# 4b. `events` means ROWS SEEN — on this runtime AND on the CLI, under one name
# ---------------------------------------------------------------------------
#
# `store.fold_rows` returns TWO different counts per basis and they answer TWO different
# questions:
#
#   acc[basis]["calls"]   rows PRICED — the denominator every dollar figure rests on.
#                         Unchanged, because the dollar-bearing logic and every other
#                         consumer depends on it meaning exactly that.
#   events[basis]         rows SEEN — including the rows whose dollars could not be
#                         derived, because a call and token count is EXACT even when a
#                         dollar figure is not.
#
# `reporting.report_window` published the first under the name of the second, which made
# the gateway's `events` mean ROWS PRICED while `cli/src/peek/store.js` has always meant
# ROWS SEEN. Same field name, same key, same consumers: `cheaper reports --json` and
# `cheaper savings --json` return the GATEWAY shape when the gateway answers and the
# LOCAL shape when it does not, so the field silently changed meaning with gateway
# reachability. `cli/scripts/check-period-parity.js` now diffs it across both runtimes.

# The blocker's own window, verbatim: 2026-08-01 -> 2026-09-01, fully covered.
AUGUST = (utc_ms(2026, 8, 1), utc_ms(2026, 9, 1))
FULLY_COVERED = {"v": 1, "tombstones": [], "ingested_files": [],
                 "coverage": [{"kind": "observed", "from": 0, "to": utc_ms(2028, 1, 1)}]}


def dashboard_calls_cell(w, side):
    """`dashboard.html::basisCell(w, side, 'calls')`, transcribed.

    The page is not editable from here and is not loaded by pytest, so the exact
    expression it applies to this payload is reproduced instead. It returns
    ``(rendered_number_or_None, tooltip_count)`` — None meaning the em-dash branch.
    """
    if w.get("status") == "not_covered":
        return None, 0
    acc = w.get(side)
    evw = w.get("events") or {}
    n = evw[side] if evw.get(side) is not None else ((acc or {}).get("calls") or 0)
    if not acc and not ((evw.get(side) or 0) > 0):
        return None, 0
    return n, (w.get("unpriced_calls") or 0)


def test_a_measured_row_that_cannot_be_priced_reports_ONE_event_never_zero():
    """THE BLOCKER, reproduced: one MEASURED call whose served model is absent from the
    price catalog, in a fully covered window.

    `report_window` answered `events: {"measured": 0, "estimated": 0}` beside
    `unpriced_calls: 1` and a note asserting "1 of 1 call(s) in this window (100% of its
    tokens) ... Call and token counts are exact." Applying `dashboard.html::basisCell`
    to that payload rendered a `0` under the header "Events (measured)", carrying the
    tooltip "1 of these could not be priced" — a cell claiming zero of the very thing its
    own tooltip and the sentence directly beneath it both count as one.

    A MEASURED zero and a WITHHELD dollar figure are different claims. Only the dollars
    were ever in doubt here.
    """
    row = ev(1, ts=utc_ms(2026, 8, 6, 12), served="llama-4-maverick",
             base="claude-opus-5", conf="measured")
    rep = reporting.report_window([row], AUGUST[0], AUGUST[1], FULLY_COVERED, TZ)

    # The count. Not zero.
    assert rep["events"] == {"measured": 1, "estimated": 0}
    # The dollars, and only the dollars, are withheld.
    assert rep["dollars_suppressed"] is True
    assert rep["measured"]["saved"] is None and rep["measured"]["spent"] is None
    assert rep["measured"]["calls"] == 0, "rows PRICED keeps its own meaning"
    assert rep["unpriced_calls"] == 1
    assert rep["undated"] == 0
    assert rep["unpriced"] == {"served_not_in_catalog": 1}

    note = " ".join(rep["notes"])
    assert "1 of 1 call(s) in this window (100% of its tokens)" in note
    assert "llama-4-maverick" in note
    assert "Call and token counts are exact." in note

    # THE PAGE NO LONGER CONTRADICTS ITSELF. The cell renders the same 1 the note and the
    # tooltip both assert, and the tooltip's count can never exceed the cell's.
    n, tooltip = dashboard_calls_cell(rep, "measured")
    assert n == 1, "the cell under 'Events (measured)' must not render 0 here"
    assert tooltip == 1 and tooltip <= n, (
        "'1 of these could not be priced' on a cell showing 0 of them is the "
        "self-contradiction this test exists to stop")

    # The note's denominator IS the two event columns, so the sentence and the columns
    # above it are now the same measurement rather than two.
    assert rep["events"]["measured"] + rep["events"]["estimated"] == 1


def test_the_measured_basis_is_never_credited_to_the_estimated_one_by_the_seen_counter():
    """GUARD THE GUARD. `events` counts rows SEEN per basis — it must still split them by
    the row's own `conf`, or the fix would have turned one contradiction into a
    cross-basis sum, which is worse."""
    rows = [ev(1, ts=utc_ms(2026, 8, 6, 12), served="llama-4-maverick", conf="measured"),
            ev(2, ts=utc_ms(2026, 8, 6, 13), served="llama-4-maverick", conf="estimated"),
            ev(3, ts=utc_ms(2026, 8, 6, 14), conf="estimated")]
    rep = reporting.report_window(rows, AUGUST[0], AUGUST[1], FULLY_COVERED, TZ)
    assert rep["events"] == {"measured": 1, "estimated": 2}
    assert rep["unpriced_calls"] == 2
    # And the priced accumulators still disagree with `events` in exactly the right way.
    assert rep["measured"]["calls"] == 0 and rep["estimated"]["calls"] == 1


# ---------------------------------------------------------------------------
# a withholding must be explained by ITS OWN reason, not by the nearest one
# ---------------------------------------------------------------------------

def cold_switch(idx, *, ts, conf="estimated"):
    """A cold start after a model switch: the helper's default `served`/`base` differ, a
    5-minute cache WRITE with no read. `derive_row` withholds it as
    `cache_state_indeterminate` — the model IS in the catalog; the un-switched arm's
    cache state is what cannot be recovered."""
    return ev(idx, ts=ts, conf=conf, in_tok=0, out_tok=1000, cr=0, c5=2000)


def test_a_window_withheld_for_an_UNKNOWABLE_CACHE_STATE_is_not_called_a_catalog_gap():
    """The suppression note explained EVERY withheld window as "not in the price
    catalog ... Refresh with `cheaper update`", which was true while a missing model was
    the only way to be unpriceable and became false the moment
    `cache_state_indeterminate` shipped: claude-sonnet-5 and claude-opus-5 are both in
    the catalog and price fine. What is missing is the COUNTERFACTUAL's cache state,
    which no catalog contains and no refresh can supply.

    So the sentence sent the reader to fix something that is not broken, and then to
    watch the figure not come back. A wrong explanation of a correct withholding is
    still a false statement about money — and it is the kind that discredits the
    withholding itself, which is the part that is right.
    """
    rep = reporting.report_window([cold_switch(1, ts=utc_ms(2026, 8, 6, 12))],
                                  AUGUST[0], AUGUST[1], FULLY_COVERED, TZ)
    assert rep["dollars_suppressed"] is True
    assert rep["unpriced"] == {"cache_state_indeterminate": 1}
    # The row was SEEN. Only its dollars are in doubt.
    assert rep["events"] == {"measured": 0, "estimated": 1}
    assert rep["estimated"]["tokens"] == 0 and rep["unpriced_tokens"] == 3000

    note = " ".join(rep["notes"])
    assert "1 of 1 call(s) in this window (100% of its tokens)" in note
    # THE FALSE CLAIM, and the false instruction that followed it.
    assert "not in the price catalog" not in note, (
        "these models ARE in the catalog; the counterfactual is what is unknowable")
    assert "cheaper update" not in note, (
        "there is nothing to refresh — no catalog release can supply a cache history "
        "the provider never recorded")
    # ...replaced by this window's actual reason, in its own sentence.
    assert "cold prompt cache" in note
    assert "ARE in the catalog" in note
    assert "the evidence does not exist" in note
    assert "Call and token counts are exact." in note


def test_each_withholding_reason_gets_its_own_sentence_and_its_own_count():
    """A window can be withheld for two different reasons at once, and collapsing them
    into one sentence makes that sentence false about one of them whichever way it is
    worded. Each reason is counted and explained separately, and the `cheaper update`
    advice stays attached to the only reason it can act on."""
    rows = [ev(1, ts=utc_ms(2026, 8, 6, 12), served="llama-4-maverick"),
            cold_switch(2, ts=utc_ms(2026, 8, 6, 13)),
            ev(3, ts=utc_ms(2026, 8, 6, 14), status=429)]
    rep = reporting.report_window(rows, AUGUST[0], AUGUST[1], FULLY_COVERED, TZ)
    assert rep["dollars_suppressed"] is True
    assert rep["unpriced"] == {"served_not_in_catalog": 1,
                               "cache_state_indeterminate": 1, "non_2xx": 1}

    note = " ".join(rep["notes"])
    assert "3 of 3 call(s) in this window (100% of its tokens)" in note
    # One sentence each, each carrying its own count — not one count for all three.
    assert "1 call(s) are not in the price catalog" in note
    assert "llama-4-maverick" in note
    assert "1 call(s) switched model on a cold prompt cache" in note
    assert "1 call(s) did not return a 2xx status" in note
    # The advice appears ONCE, on the reason it can act on.
    assert note.count("cheaper update") == 1
    assert "Call and token counts are exact." in note


def test_the_catalog_wording_SURVIVES_for_a_window_that_really_is_a_catalog_gap():
    """GUARD THE GUARD. Giving the cache case its own sentence must not soften the
    catalog case into something vaguer: a genuinely missing model still names itself,
    still says the catalog is where the gap is, and still tells the reader what to run."""
    rep = reporting.report_window([ev(1, ts=utc_ms(2026, 8, 6, 12),
                                      served="llama-4-maverick", conf="measured")],
                                  AUGUST[0], AUGUST[1], FULLY_COVERED, TZ)
    note = " ".join(rep["notes"])
    assert "1 call(s) are not in the price catalog (models: llama-4-maverick)" in note
    assert "cheaper update" in note
    assert "cold prompt cache" not in note, (
        "a catalog gap must not be explained by a rule that did not fire on it")


def test_below_the_threshold_dollars_are_reported(events_dir):
    events = [ev(i, ts=NOW - DAY + i * 1000, in_tok=100000, out_tok=1000)
              for i in range(1, 6)]
    events.append(ev(9, ts=NOW - DAY + 9000, served="llama-4-maverick",
                     in_tok=1000, out_tok=100))
    write_segment(events_dir, events)
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    rows = rows_from(events_dir)
    rep = reporting.report_window(rows, NOW - 2 * DAY, NOW, store.load_state(), TZ)
    assert rep["status"] == "ok"
    assert rep["estimated"]["saved"] > 0
    assert rep["unpriced_calls"] == 1, "the exclusion is still counted and visible"


# ---------------------------------------------------------------------------
# 5. THE ABSOLUTE INVARIANT — the two bases never meet
# ---------------------------------------------------------------------------

def _walk(node, path=""):
    yield path, node
    if isinstance(node, dict):
        for k, v in node.items():
            yield from _walk(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _walk(v, f"{path}[{i}]")


def _numbers(node):
    return [v for _, v in _walk(node)
            if isinstance(v, (int, float)) and not isinstance(v, bool)]


def _basis_nodes(payload):
    return [(p, n) for p, n in _walk(payload)
            if isinstance(n, dict)
            and isinstance(n.get("measured"), dict)
            and isinstance(n.get("estimated"), dict)]


COMBINING_NAMES = {"total", "combined", "all", "both", "overall", "sum", "grand_total",
                   "total_saved", "total_spent", "total_calls", "total_events", "calls"}

# Scalars that legitimately sit beside a measured/estimated pair WITHOUT being a sum of
# them. Each is here for a stated reason, not for convenience:
#   unpriced_calls / unpriced_tokens  rows that entered NEITHER accumulator — the
#                                     visible exclusion counter, whose absence is how a
#                                     shrinking denominator becomes invisible;
#   undated / tombstones              the same, for rows excluded by time or by a
#                                     `cheaper forget`;
#   dated_by_pday                     a PROVENANCE count of rows already inside `events`
#                                     (placed by the calendar day frozen on the row
#                                     because their `ts` did not survive the merge), not
#                                     a quantity added to either basis;
#   from / to                         epoch-ms window bounds, not quantities;
#   unpriced_ratio                    a proportion in [0,1], not a quantity.
_NOT_A_CROSS_BASIS_SUM = {"unpriced_calls", "unpriced_tokens", "undated", "tombstones",
                          "from", "to", "unpriced_ratio", "dated_by_pday"}


def test_no_response_field_is_produced_from_both_a_measured_and_an_estimated_accumulator(
        client, auth_headers, events_dir):
    """`metrics.summary().dollars.saved` + `ledger.totals().usd` + `peek.totals` is a
    triple count BY CONSTRUCTION, in any combination. So the two bases accumulate
    separately and nothing may add them — not Saved, not Spent, not Events.

    Asserted structurally over the real response dict, not over the source."""
    events = []
    # Deliberately lopsided and distinctive, so a cross-basis sum would be conspicuous.
    for i in range(1, 8):
        events.append(ev(i, ts=NOW - DAY + i * 1000, conf="measured",
                         served="claude-haiku-4-5", in_tok=11000 + i, out_tok=1300 + i))
    for i in range(20, 31):
        events.append(ev(i, ts=NOW - DAY + i * 1000, conf="estimated",
                         served="claude-sonnet-5", in_tok=23000 + i, out_tok=2700 + i))
    write_segment(events_dir, events)
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])

    payload = {}
    for url in ("/api/v1/reports/periods", "/api/v1/reports/breakdown",
                "/api/v1/reports/trend", "/api/v1/logs"):
        r = client.get(url, params={"session": "rpt-session", "tz": TZ, "limit": 1000},
                       headers=auth_headers)
        assert r.status_code == 200, r.text
        payload[url] = r.json()

    all_numbers = _numbers(payload)
    nodes = _basis_nodes(payload)
    assert nodes, "the responses must actually carry the two bases separately"

    checked_money = 0
    for path, node in nodes:
        m, e = node["measured"], node["estimated"]
        siblings = {k: v for k, v in node.items()
                    if k not in ("measured", "estimated")
                    and k not in _NOT_A_CROSS_BASIS_SUM
                    and isinstance(v, (int, float)) and not isinstance(v, bool)}
        # (a) no sibling scalar is the sum of the two bases — Saved, Spent AND Events.
        for field in set(m) & set(e):
            if not isinstance(m[field], (int, float)) or isinstance(m[field], bool):
                continue
            total = m[field] + e[field]
            for name, value in siblings.items():
                assert not math.isclose(value, total, rel_tol=0, abs_tol=1e-9) \
                    or total == 0, (
                    f"{path}.{name} == measured.{field} + estimated.{field}; "
                    "the two bases were summed")
            # (b) a money sum is a distinctive float: it must appear NOWHERE at all.
            if field in ("saved", "spent", "baseline", "gross") \
                    and abs(m[field]) > 1e-6 and abs(e[field]) > 1e-6:
                checked_money += 1
                for value in all_numbers:
                    assert not (isinstance(value, float)
                                and math.isclose(value, total, rel_tol=1e-12,
                                                 abs_tol=1e-12)), (
                        f"the value {total} (measured.{field} + estimated.{field}) "
                        f"appears in the response; the two bases were summed")
        # (c) no key at this level is NAMED like a combined figure.
        assert not (set(node) & COMBINING_NAMES), \
            f"{path} exposes {sorted(set(node) & COMBINING_NAMES)} beside two bases"

    assert checked_money >= 4, "the fixture must exercise money on BOTH bases"


def test_a_chat_count_is_never_added_to_a_call_count(client, auth_headers, events_dir):
    """A chat count and a call count are never summed, even within one basis. "82
    events" from 76 gateway CALLS plus 6 ledger CHATS (which themselves contain
    thousands of calls) is the same concealment shape in a less obvious column."""
    write_segment(events_dir, [ev(i, ts=NOW - DAY + i * 1000) for i in range(1, 5)])
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])

    for url in ("/api/v1/reports/periods", "/api/v1/reports/breakdown",
                "/api/v1/reports/trend", "/api/v1/logs"):
        body = client.get(url, params={"session": "rpt-session", "tz": TZ},
                          headers=auth_headers).json()
        # `.filters.grain` echoes the REQUESTED grain filter (None here); it is a query
        # parameter, not a row's grain, so it is not part of this assertion.
        grains = [v for p, v in _walk(body)
                  if p.endswith(".grain") and not p.endswith(".filters.grain")]
        assert grains, f"{url} must declare its grain"
        assert set(grains) == {"call"}, f"{url} mixed grains: {set(grains)}"
        # The chat-grain legacy store is reported ONLY in its own `legacy` block, never
        # folded into a call-grain count.
        legacy = body.get("legacy")
        if legacy is not None:
            assert legacy["derivation"] == "frozen"
            assert legacy["chats"] == 0, "no legacy chats in this fixture"
        assert '"chat"' not in json.dumps(body)


def test_events_are_reported_per_basis_not_as_one_number(client, auth_headers, events_dir):
    """Two assertions of one property, at two altitudes.

    THE FIXTURE SUPPLIES ITS OWN FRAME, exactly as `pinned_zone` above does for the
    timezone. `/api/v1/reports/periods` takes no `now`, so the endpoint builds its ladder
    from the WALL CLOCK while `NOW` is frozen at 2026-08-07T14:22Z. Anchoring the rows on
    `NOW` therefore made this test assert about `today` only while the real clock still
    agreed with the constant: at 2026-08-08T00:00Z the same three rows moved into
    `week_earlier`, which reported them correctly as `{"measured": 1, "estimated": 2}`
    while `today` — a window they were never in — reported the honest `{0, 0}` and this
    test read that as the rows-seen counter having been lost.

    A zero here is worth a hard look rather than a re-anchoring, because it is also what
    the regression looks like: `events` publishing rows PRICED instead of rows SEEN made
    a window render "Events (measured) = 0" directly above its own note counting one call.
    So the property is ALSO pinned against a frozen clock below, where no wall-clock drift
    can reach it.

    AND THE THIRD ROW IS UNPRICEABLE, deliberately. With three priceable rows `events`
    and `calls` hold the same three numbers, so the very regression this test is named
    after — publishing rows PRICED under the `events` key — passes it. The third row is a
    cold start after a model switch, withheld as `cache_state_indeterminate`: its dollars
    are not derivable, but it WAS SEEN, and a withholding that also deletes the row from
    the count would be the same contradiction arriving through a new door.
    """
    # The ladder the ENDPOINT will build, not the one `NOW` describes. `- 60_000` keeps
    # the rows just behind the current instant while staying inside today's window even
    # in its first minute.
    today_w = [w for w in periods.disjoint_ladder(None, TZ) if w["key"] == "today"][0]
    anchor = max(today_w["from"], int(time.time() * 1000) - 60_000)
    # Row 3 switches model (the helper's default served/base) on a COLD cache: `c5` with
    # no `cr`. Small, so the window stays under the 20% unpriceable-token threshold and
    # this test is about the COUNT rather than about suppression.
    rows = [ev(1, ts=anchor, conf="measured"),
            ev(2, ts=anchor + 1000, conf="estimated"),
            ev(3, ts=anchor + 2000, conf="estimated",
               in_tok=0, out_tok=1000, cr=0, c5=2000)]
    write_segment(events_dir, rows)
    # Coverage anchored to that same window, for the same reason: a declared interval
    # ending at `NOW + DAY` expires mid-run and turns this into a `not_covered` window
    # with no `events` key at all — a KeyError standing in for a real assertion.
    write_state(events_dir, [{"kind": "observed", "from": 0,
                              "to": today_w["to"] + DAY}])
    body = client.get("/api/v1/reports/periods",
                      params={"session": "rpt-session", "tz": TZ},
                      headers=auth_headers).json()
    today = [p for p in body["periods"] if p["key"] == "today"][0]
    assert today["events"] == {"measured": 1, "estimated": 2}
    assert "count" not in today and "calls" not in today
    # ROWS SEEN and ROWS PRICED are different numbers here, so `events` cannot be
    # satisfied by either accumulator's `calls`.
    assert today["unpriced"] == {"cache_state_indeterminate": 1}
    assert today["measured"]["calls"] == 1 and today["estimated"]["calls"] == 1
    assert today["dollars_suppressed"] is False

    # The same property against a FROZEN clock: rows anchored on `NOW`, ladder built at
    # `NOW`. No wall-clock drift can move these rows out of the window they are asserted
    # against, so a future failure here is the counter, never the calendar.
    pinned = [ev(1, ts=NOW - 3600000, conf="measured"),
              ev(2, ts=NOW - 3601000, conf="estimated"),
              ev(3, ts=NOW - 3602000, conf="estimated",
                 in_tok=0, out_tok=1000, cr=0, c5=2000)]
    ladder = reporting.report_periods(pinned, TZ, now_ms=NOW, state=FULLY_COVERED)
    pinned_today = [p for p in ladder if p["key"] == "today"][0]
    assert pinned_today["events"] == {"measured": 1, "estimated": 2}
    assert pinned_today["estimated"]["calls"] == 1
    assert "count" not in pinned_today and "calls" not in pinned_today
    # ...and the rows are in exactly ONE window, so the count above is not a coincidence
    # of a ladder that placed them twice.
    assert sum(p["events"]["measured"] + p["events"]["estimated"]
               for p in ladder) == 3


# ---------------------------------------------------------------------------
# 6. keyset pagination
# ---------------------------------------------------------------------------

def test_keyset_pagination_returns_each_row_exactly_once_when_rows_land_mid_scroll(
        client, auth_headers, events_dir):
    """Offset paging skips or duplicates rows when new traffic lands mid-scroll: a row
    inserted above the cursor shifts every later page by one. A keyset cursor names the
    last row seen instead of counting rows, so the original set is enumerated exactly
    once no matter what arrives during the walk."""
    original = [ev(i, ts=NOW - 10 * DAY + i * 60000) for i in range(1, 26)]
    write_segment(events_dir, original)
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    want = {e["id"] for e in original}

    seen: list = []
    cursor = None
    inserted = 0
    for page_no in range(6):
        params = {"session": "rpt-session", "tz": TZ, "limit": 10}
        if cursor:
            params["cursor"] = cursor
        body = client.get("/api/v1/logs", params=params, headers=auth_headers).json()
        seen += [r["id"] for r in body["rows"]]
        cursor = body["next_cursor"]
        # New traffic lands between page fetches — the real mid-scroll condition.
        if page_no < 3:
            inserted += 1
            write_segment(events_dir,
                          [ev(900 + inserted, ts=NOW - DAY + inserted * 1000)],
                          append=True)
        if not cursor:
            break

    assert len(seen) == len(set(seen)), "keyset paging returned a duplicate"
    assert set(seen) >= want, f"keyset paging skipped {sorted(want - set(seen))}"
    assert len(seen) >= 25


def test_the_cursor_is_base64_of_ts_and_id_and_survives_a_round_trip():
    view = {"ts": 1786012800123, "id": "rid:req_x"}
    c = reporting.encode_cursor(view)
    assert reporting.decode_cursor(c) == {"ts": 1786012800123.0, "id": "rid:req_x"}
    assert reporting.decode_cursor("not base64 at all!!") is None
    assert reporting.decode_cursor(None) is None


def test_the_count_is_capped_honestly_rather_than_reported_wrongly():
    assert reporting.honest_count(19999) == "19999"
    assert reporting.honest_count(20000) == "20000"
    assert reporting.honest_count(20001) == "20000+"


# ---------------------------------------------------------------------------
# API surface: filters echo, non-hideable columns, export, embedded report
# ---------------------------------------------------------------------------

def test_every_response_echoes_the_filters_that_produced_it(client, auth_headers,
                                                            events_dir):
    write_segment(events_dir, [ev(1, ts=NOW - DAY)])
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    body = client.get("/api/v1/logs",
                      params={"session": "rpt-session", "tz": "America/Chicago",
                              "basis": "estimated", "limit": 5, "min_abs_usd": "0.0001"},
                      headers=auth_headers).json()
    f = body["filters"]
    assert f["session"] == "rpt-session" and f["tz"] == "America/Chicago"
    assert f["basis"] == "estimated" and f["limit"] == 5
    assert f["min_abs_usd"] == pytest.approx(0.0001)
    assert f["from_inclusive"] is True and f["to_exclusive"] is True


def test_log_rows_carry_non_hideable_basis_grain_and_unpriced_reason(client, auth_headers,
                                                                     events_dir):
    write_segment(events_dir, [ev(1, ts=NOW - DAY),
                               ev(2, ts=NOW - DAY + 1, served="llama-4-maverick")])
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    body = client.get("/api/v1/logs", params={"session": "rpt-session"},
                      headers=auth_headers).json()
    assert len(body["rows"]) == 2
    for r in body["rows"]:
        assert r["basis"] in ("measured", "estimated")
        assert r["grain"] == "call"
        assert "unpriced_reason" in r
    bad = [r for r in body["rows"] if not r["priceable"]][0]
    assert bad["unpriced_reason"] == "served_not_in_catalog"
    # Never 0.00: an unpriceable row makes NO claim.
    assert bad["delta_usd"] is None and bad["actual_usd"] is None


def test_export_streams_csv_with_a_bom_a_preamble_and_a_row_digest(client, auth_headers,
                                                                   events_dir):
    write_segment(events_dir, [ev(i, ts=NOW - DAY + i * 1000) for i in range(1, 4)])
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    r = client.get("/api/v1/export",
                   params={"format": "csv", "session": "rpt-session", "tz": TZ},
                   headers=auth_headers)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert "attachment; filename=" in r.headers["content-disposition"]
    assert '"' == r.headers["content-disposition"].split("filename=")[1][0]
    text = r.text
    assert text.startswith("﻿"), "Excel needs the BOM or it decodes as the ANSI code page"
    assert "# Cheaper.app — model-routing savings audit export" in text
    assert "THIS IS NOT AN INVOICE" in text
    assert r.headers["x-cheaper-row-digest"] in text
    assert text.count("\r\n") > 10

    plain = client.get("/api/v1/export",
                       params={"format": "csv", "session": "rpt-session",
                               "preamble": "0"},
                       headers=auth_headers).text
    assert "#" not in plain


def test_export_json_is_lossless_and_nulls_an_unpriceable_delta(client, auth_headers,
                                                                events_dir):
    write_segment(events_dir, [ev(1, ts=NOW - DAY),
                               ev(2, ts=NOW - DAY + 1, served="llama-4-maverick")])
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    doc = client.get("/api/v1/export",
                     params={"format": "json", "session": "rpt-session"},
                     headers=auth_headers).json()
    assert doc["meta"]["export_schema"] == "cheaper.export.v1"
    assert doc["meta"]["integrity"]["row_digest"]
    unpriced = [r for r in doc["rows"] if r["served_model"] == "llama-4-maverick"][0]
    assert unpriced["delta_usd"] is None
    assert unpriced["unpriced_reason"] == "served_not_in_catalog"


def test_report_html_embeds_its_data_and_escapes_the_injection_boundary(client,
                                                                        auth_headers,
                                                                        events_dir):
    """The data is EMBEDDED, never fetched: printToPDF and the print dialog capture
    whatever is rendered at that instant, so a fetching page can be caught mid-flight and
    produce empty tables. And model ids and routing reasons are user-influenced, which
    makes the embed an injection boundary."""
    hostile = "claude-</script><img src=x onerror=alert(1)>-5"
    write_segment(events_dir, [ev(1, ts=NOW - DAY, served=hostile,
                                  reason="</script><b>&amp;</b>")])
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    r = client.get("/api/v1/report.html", params={"session": "rpt-session", "tz": TZ},
                   headers=auth_headers)
    assert r.status_code == 200
    html = r.text
    assert "__REPORT_DATA__" not in html, "the payload must be embedded"
    assert '<script id="report-data" type="application/json">' in html
    assert "<img src=x onerror=alert(1)>" not in html
    assert "\\u003c/script\\u003e" in html
    assert "\\u003cimg src=x" in html
    # And the new, basis-split report data really is in there.
    payload = html.split('type="application/json">')[1].split("</script>")[0]
    data = json.loads(payload.replace("\\u003c", "<").replace("\\u003e", ">")
                      .replace("\\u0026", "&"))
    assert data["report"]["grain"] == "call"
    assert [p["key"] for p in data["report"]["periods"]][0] == "today"
    assert data["report"]["meta"]["export_schema"] == "cheaper.export.v1"


@pytest.mark.parametrize("url,params", [
    ("/api/v1/logs", {}),
    ("/api/v1/reports/periods", {}),
    ("/api/v1/reports/breakdown", {"dim": "served"}),
    ("/api/v1/reports/trend", {"bucket": "day"}),
    ("/api/v1/export", {"format": "csv"}),
    ("/api/v1/report.html", {}),
])
def test_every_api_route_is_gated_by_the_local_token(client, url, params):
    assert client.get(url, params=params).status_code == 401


@pytest.mark.parametrize("dim", ["served", "base", "tier", "harness", "decision"])
def test_breakdown_supports_every_documented_dimension(client, auth_headers, events_dir,
                                                       dim):
    write_segment(events_dir, [ev(1, ts=NOW - DAY),
                               ev(2, ts=NOW - DAY + 1, served="claude-fable-5")])
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    body = client.get("/api/v1/reports/breakdown",
                      params={"dim": dim, "session": "rpt-session"},
                      headers=auth_headers).json()
    assert body["dim"] == dim
    assert body["groups"] and all("measured" in g and "estimated" in g
                                  for g in body["groups"])


@pytest.mark.parametrize("bucket", ["day", "week", "month"])
def test_trend_buckets_on_the_rows_own_pday_never_on_ingest_time(client, auth_headers,
                                                                 events_dir, bucket):
    e1 = ev(1, ts=NOW - 40 * DAY)
    e2 = ev(2, ts=NOW - DAY)
    # `ingested_at` is deliberately the SAME recent instant for both: an import must not
    # be able to create a fake spike on import day.
    e1["ingested_at"] = e2["ingested_at"] = NOW
    write_segment(events_dir, [e1, e2], name="2026-06.testinst.cli.jsonl")
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    body = client.get("/api/v1/reports/trend",
                      params={"bucket": bucket, "session": "rpt-session"},
                      headers=auth_headers).json()
    assert body["bucket"] == bucket
    assert len(body["points"]) == 2, "two different days must not collapse into one"
    assert body["points"][0]["bucket"] < body["points"][1]["bucket"]
    # A clean series carries NO undated entry -- the exclusion row appears only when
    # there is something to exclude.
    assert all(p["undatable"] is False for p in body["points"])


def test_trend_does_not_bucket_a_row_it_cannot_date_and_counts_the_skip(events_dir):
    """`store.merge` NULLS both pday and tzo when two sources disagree about a row's
    frame, and a timestamp in the wrong unit is not a calendar date at all. Such a row
    used to be bucketed at a fabricated UTC day (`tzo or 0`). It is now skipped -- and
    COUNTED, as a labelled trailing entry, because a silently shrinking denominator is
    the same concealment as printing $0.00 for an unpriceable model."""
    good = ev(1, ts=NOW - DAY)
    # Milliseconds where the row wants... milliseconds, but three orders too many:
    # year 55840, which no calendar can render. pday and tzo both NULL, exactly what
    # merge writes on a frame conflict.
    poisoned = ev(2, ts=NOW * 1000, pday="")
    poisoned["pday"] = None
    poisoned["tzo"] = None

    points = reporting.report_trend([good, poisoned], "day", None, None)
    dated = [p for p in points if not p["undatable"]]
    undated = [p for p in points if p["undatable"]]
    assert len(dated) == 1
    assert dated[0]["bucket"] == periods.pday_of(NOW - DAY, 0)
    # The skipped row is VISIBLE, LAST, and labelled -- never folded into a real day.
    assert len(undated) == 1
    assert points[-1] is undated[0]
    assert undated[0]["bucket"] == "undated"
    # It carries no day, so store.derive_row cannot price it either -- it surfaces as a
    # counted unpriced call rather than a $0.00 in a fabricated bucket.
    assert undated[0]["unpriced_calls"] == 1
    assert undated[0]["measured"]["calls"] == 0
    assert undated[0]["estimated"]["calls"] == 0
    # And the dated day kept its own row intact.
    assert dated[0]["unpriced_calls"] == 0
    assert periods.pday_of(NOW * 1000, None) is None


@pytest.mark.parametrize("bad_ts", [None, float("nan"), "", "not-a-number"])
@pytest.mark.parametrize("frozen_pday", [None, PDAY_ONLY_DAY])
def test_trend_counts_a_row_whose_ts_is_absent_or_non_numeric(bad_ts, frozen_pday):
    """A row with no USABLE INSTANT is a different state from a row OUTSIDE the window,
    and `in_window` returns False for both.

    report_trend used to ask `in_window` FIRST, so a row whose `ts` was absent, None,
    NaN or non-numeric -- a merge artefact, a truncated import line, a JSON null --
    was dropped by that guard before `key_of` ever saw it. It reached no bucket, no
    `undated` entry, no count and no total: it left NO trace in the response at all.
    `store.fold_rows` counts exactly this row as an unpriced call, so the trend endpoint
    was reporting a strictly smaller denominator than the fold it is built on, while the
    docstring claimed such a row is "skipped and COUNTED".

    THE `pday` AXIS -- the half of the state space the first version of this test never
    entered. It hardcoded `pday = None`, so it only ever exercised rows `fold_rows`
    refuses to price anyway, and the fix it was guarding (exempt the row whenever `ts` is
    non-finite) was free to wave a PRICEABLE row into every window ever asked for. `ts`
    and `pday` are separate fields with separate merge outcomes: a row can lose its
    instant and keep the calendar day it is priced at. With `pday` PRESENT the row is
    DATED, so it must be tested against the window by that day and must DISAPPEAR from a
    window that excludes it -- otherwise trend(April) and trend(August) both report the
    same dollars and their sum is twice their union.

    Three window shapes are exercised: unbounded, a window that CONTAINS the row's day,
    and one that provably EXCLUDES it. The undatable row (no `ts`, no `pday`) is exempt
    from all three, because it carries no dollars into any of them.

    RAW FOLD vs RENDERED BUCKET -- the axis the expectations here used to miss. A bucket
    published by `report_trend` is a fold that has been through the render step: when the
    fold says `dollars_suppressed`, every dollar field comes back None. Comparing that
    bucket against `store.fold_rows(...)[basis]`, which still carries 0.0 there, can only
    pass in the windows where suppression happens not to fire, so the expectation is built
    through `_folded` -- the same fold with the withholding written out locally. The third
    fixture row below exists so that a bucket in this test is PART priced and PART not,
    which is the only shape in which the threshold can be observed to fire at all.
    """
    good = ev(1, ts=NOW - DAY)
    undatable = ev(2, ts=NOW - DAY)
    undatable["ts"] = bad_ts
    undatable["pday"] = frozen_pday
    undatable["tzo"] = 0 if frozen_pday else None
    # DATED and UNPRICEABLE, on `good`'s OWN day. Without it every bucket this test can
    # produce is wholly priceable (ratio 0) or wholly unpriceable (ratio 1), and the
    # withholding assertions below would hold for ANY threshold whatsoever -- including a
    # threshold that never fires, which is the state the render step exists to prevent.
    # With it, `good_day` holds one priced row and one unpriced row of equal token weight,
    # so that bucket is squarely over the published 20% line and its dollars must be
    # WITHHELD while its counts survive intact.
    unpriced_dated = ev(3, ts=NOW - DAY, served="llama-4-maverick")
    rows = [good, undatable, unpriced_dated]

    dated = frozen_pday is not None
    good_day = periods.pday_of(NOW - DAY, 0)
    assert good_day != PDAY_ONLY_DAY, "the two rows must occupy DIFFERENT buckets"

    # store.fold_rows is the authority on how many calls this pair contains; the trend
    # response may not quietly hold fewer -- nor, now, more.
    fold = store.fold_rows([good, undatable])
    assert fold["unpriced_calls"] == (0 if dated else 1)
    assert fold["estimated"]["calls"] == (2 if dated else 1)
    # ...and the same authority over the FULL fixture: the dated unpriceable row is a
    # counted exclusion in every case, and is never a priced contributor to either basis.
    fold_all = store.fold_rows(rows)
    assert fold_all["unpriced_calls"] == (1 if dated else 2)
    assert fold_all["estimated"]["calls"] == (2 if dated else 1)

    cases = [((None, None), rows),
             ((NOW - 2 * DAY, NOW + DAY), rows),
             # The row DATED by its frozen day is gone here; the one that can be placed
             # nowhere is still exempt, and still carries no dollars.
             (APRIL, [] if dated else [undatable])]

    for (frm, to), expected in cases:
        points = reporting.report_trend(rows, "day", frm, to)
        want: dict = {}
        for row, key in ((good, good_day),
                         (undatable, frozen_pday if dated else "undated"),
                         (unpriced_dated, good_day)):
            if any(row is e for e in expected):
                want.setdefault(key, []).append(row)
        assert {p["bucket"] for p in points} == set(want), (frm, to, points)
        for p in points:
            mine = want[p["bucket"]]
            f = store.fold_rows(mine)
            # Each bucket is EXACTLY the fold of the rows entitled to be in it -- to the
            # cent, to the call count, to the unpriced count, AND to the fold's own
            # decision about whether a dollar figure may be claimed at all.
            #
            # `_folded` is the fold RENDERED: the published bucket has been through the
            # withholding step, so the raw accumulator is not what it should equal.
            assert p["measured"] == _folded(mine, "measured"), (frm, to, p)
            assert p["estimated"] == _folded(mine, "estimated"), (frm, to, p)
            assert p["unpriced_calls"] == f["unpriced_calls"], (frm, to, p)
            # Two DIFFERENT claims, and both have to hold. First: the render layer obeyed
            # the fold it was handed -- a bucket that withholds when its own fold did not
            # ask it to, or publishes dollars when it did, fails here.
            assert p["dollars_suppressed"] is bool(f["dollars_suppressed"]), (frm, to, p)
            # Second, and NOT implied by the first: the fold obeyed the PUBLISHED RULE,
            # recomputed here from `store.derive_row` and the stated 20%-of-tokens line.
            # Without this the pair of assertions only says the fold agrees with itself,
            # and moving the threshold inside `store.fold_rows` breaks nothing.
            assert p["dollars_suppressed"] is _expect_suppressed(mine), (frm, to, p)
            assert p["undatable"] is (p["bucket"] == "undated")
        if not dated and undatable in expected:
            # THE POINT OF THE ORIGINAL TEST: the row is COUNTED, LAST, and labelled.
            assert points[-1]["bucket"] == "undated"
            assert points[-1]["unpriced_calls"] == 1
            assert points[-1]["measured"]["calls"] == 0
            assert points[-1]["estimated"]["calls"] == 0


def test_trend_still_excludes_a_datable_row_that_is_outside_the_window():
    """GUARD THE GUARD for the test above. "Never drop an undatable row" must not have
    been implemented as "never drop anything": a row with a perfectly good instant that
    falls outside the requested half-open range is still excluded, and does NOT reappear
    as an `undated` entry (which would attribute a dated row to no day)."""
    inside = ev(1, ts=NOW - DAY)
    outside = ev(2, ts=NOW - 40 * DAY)
    points = reporting.report_trend([inside, outside], "day", NOW - 2 * DAY, NOW + DAY)
    assert [p["bucket"] for p in points] == [periods.pday_of(NOW - DAY, 0)]
    assert all(p["undatable"] is False for p in points)


# The group an undatable row belongs to on each dimension. Every one of these is
# derivable WITHOUT a timestamp, which is precisely why deleting the row from the table
# was indefensible. `decision` is "unknown" rather than "kept" because the row cannot be
# priced -- see decision_of: "kept" would read as a MEASURED no-op.
_UNDATABLE_GROUP = {"served": "claude-sonnet-5", "base": "claude-opus-5",
                    "tier": "sonnet", "harness": "claude-code", "decision": "unknown"}

# The same row once it CAN be priced: only `decision` moves, from "unknown" (no claim
# possible) to the real, signed answer.
_DATABLE_GROUP = dict(_UNDATABLE_GROUP, decision="downgrade")


@pytest.mark.parametrize("dim", ["served", "base", "tier", "harness", "decision"])
@pytest.mark.parametrize("bad_ts", [None, float("nan"), "", "not-a-number"])
@pytest.mark.parametrize("frozen_pday", [None, PDAY_ONLY_DAY])
def test_breakdown_counts_a_row_whose_ts_is_absent_or_non_numeric(dim, bad_ts,
                                                                  frozen_pday):
    """The report_trend defect, one function up -- and worse, because here the grouping
    key is NON-TEMPORAL.

    `report_breakdown` asked `in_window` FIRST, and `in_window` answers False both for
    "outside the requested range" and for "has no usable instant at all". So a row whose
    `ts` was absent, None, NaN or non-numeric was deleted from EVERY group of EVERY
    dimension and left NO trace: not a group, not an `events` count, not an
    `unpriced_calls` count. `/api/v1/reports/breakdown` emits no `undated` note (unlike
    report_window) and `_api_envelope` carries no undated count, so the exclusion was not
    recoverable from the response at all -- a reader grouping by `harness` or `served`
    read a complete-looking composition table over a silently smaller denominator, which
    is the same concealment as printing $0.00 for an unpriceable model.

    Chosen fix: the undatable row joins its REAL group (option A), because every
    dimension above is derivable without a timestamp and `store.fold_rows` then counts it
    honestly as an unpriced call. A trailing labelled group would have invented a
    dimension value the row does not have.

    THE `pday` AXIS -- the half of the state space the first version of this test never
    entered, and the reason the fix above could ship as a silent FABRICATION. Every case
    hardcoded `pday = None`, which is exactly the state `fold_rows` refuses to price, so
    nothing here could observe what happens when a row loses its `ts` and KEEPS the
    calendar day it is priced at. `store.merge` produces that row routinely: it ranks
    `ts` and `pday` separately, so two sources that tie on rank and disagree on `ts` null
    it while an agreeing `pday` survives. Exempting on `ts` alone then waved a fully
    PRICEABLE row into every window ever asked for -- April, August and 2027 each
    claiming the same $0.06, with no label and no count, and `unpriced_calls == 0`
    because it was a priced CONTRIBUTOR rather than a counted exclusion.

    Three window shapes are exercised: unbounded, one that CONTAINS the row's frozen day,
    and one that provably EXCLUDES it. A row that can be placed neither way stays exempt
    from all three -- it carries no dollars into any of them, which is the whole
    justification for the exemption.

    RAW FOLD vs RENDERED GROUP -- the axis the expectations here used to miss, and the one
    that matters most on THIS surface. On four of the five dimensions the undatable row
    shares `good`'s group, so that group is half unpriceable by token weight: over the
    published 20% line, and therefore WITHHELD. A group published by `report_breakdown` has
    been through the render step and carries None in every dollar field; the raw
    `store.fold_rows(...)[basis]` still carries 0.0 there, so the two are not comparable and
    the expectation is built through `_folded` instead.
    """
    good = ev(1, ts=NOW - DAY)
    undatable = ev(2, ts=NOW - DAY)
    undatable["ts"] = bad_ts
    undatable["pday"] = frozen_pday
    undatable["tzo"] = 0 if frozen_pday else None

    dated = frozen_pday is not None
    home = _DATABLE_GROUP[dim] if dated else _UNDATABLE_GROUP[dim]

    # store.fold_rows is the authority on how many calls this pair contains; the
    # breakdown response may not quietly hold fewer -- nor, now, more.
    fold = store.fold_rows([good, undatable])
    assert fold["unpriced_calls"] == (0 if dated else 1)
    assert fold["estimated"]["calls"] == (2 if dated else 1)

    cases = [((None, None), [good, undatable]),
             ((NOW - 2 * DAY, NOW + DAY), [good, undatable]),
             (APRIL, [] if dated else [undatable])]

    for (frm, to), expected in cases:
        groups = reporting.report_breakdown([good, undatable], dim, frm, to)
        want: dict = {}
        for row, key in ((good, _DATABLE_GROUP[dim]), (undatable, home)):
            if row in expected:
                want.setdefault(key, []).append(row)
        assert {g["key"] for g in groups} == set(want), (dim, bad_ts, frm, to, groups)
        for g in groups:
            mine = want[g["key"]]
            f = store.fold_rows(mine)
            # Each group is EXACTLY the fold of the rows entitled to be in it -- including
            # the fold's own decision about whether a dollar figure may be claimed at all.
            # When the undatable row shares a group, this is what proves it added no
            # dollars: the group's figures are the fold of its datable members alone, and
            # when its unpriceable tokens dominate the group the group WITHHOLDS rather
            # than printing a figure derived from part of the evidence.
            #
            # `_folded` is the fold RENDERED. The published group has been through the
            # withholding step, so the RAW accumulator is not what it should equal: on the
            # four dimensions where the two rows share a group, the raw fold still says
            # 0.0 where the group correctly says None.
            assert g["measured"] == _folded(mine, "measured"), \
                (dim, bad_ts, frm, to, g)
            assert g["estimated"] == _folded(mine, "estimated"), \
                (dim, bad_ts, frm, to, g)
            assert g["unpriced"] == f["unpriced"], (dim, bad_ts, frm, to, g)
            assert g["unpriced_calls"] == f["unpriced_calls"], (dim, bad_ts, frm, to, g)
            # Two DIFFERENT claims. First: the render layer obeyed the fold it was handed.
            assert g["dollars_suppressed"] is bool(f["dollars_suppressed"]), \
                (dim, bad_ts, frm, to, g)
            # Second, and NOT implied by the first: the fold obeyed the PUBLISHED RULE,
            # recomputed here from `store.derive_row` and the stated 20%-of-tokens line.
            # Without this the pair only says the fold agrees with itself.
            assert g["dollars_suppressed"] is _expect_suppressed(mine), \
                (dim, bad_ts, frm, to, g)
        # Counts are summed WITHIN one basis only -- never measured + estimated.
        #
        # `events` is ROWS SEEN, so it is compared against `fold_rows(...)["events"]` and
        # NOT against the accumulator's `calls` (rows PRICED). Comparing it to `calls` was
        # only ever right while the two meant the same thing, which is exactly what made
        # the undatable row report as 0 events in the group it visibly joins.
        exp = store.fold_rows(expected)
        assert sum(g["unpriced_calls"] for g in groups) == exp["unpriced_calls"]
        for basis in ("measured", "estimated"):
            assert sum(g["events"][basis] for g in groups) == exp["events"][basis]
        # ...and the PRICED counts still reconcile on their own field, so the assertion
        # above is a change of question and not a loosening.
        for basis in ("measured", "estimated"):
            assert sum(g[basis]["calls"] for g in groups) == exp[basis]["calls"]
        if not dated and undatable in expected:
            # THE POINT OF THE ORIGINAL TEST: present, in its own real group, counted.
            grp = [g for g in groups if g["key"] == home][0]
            assert grp["unpriced"] == {store.REASON_NO_TS: 1}, (dim, bad_ts, frm, to)


@pytest.mark.parametrize("dim", ["served", "base", "tier", "harness", "decision"])
def test_breakdown_still_excludes_a_datable_row_that_is_outside_the_window(dim):
    """GUARD THE GUARD for the test above. "Never drop an undatable row" must not have
    been implemented as "never drop anything": a row with a perfectly good instant that
    falls outside the requested half-open range is still excluded from every group.

    The `outside` row is given `served == base == claude-opus-5` so it would form its OWN
    group on every one of the five dimensions if it leaked in -- the counts below catch
    it, and so does the key list.
    """
    inside = ev(1, ts=NOW - DAY)
    outside = ev(2, ts=NOW - 40 * DAY, served="claude-opus-5")
    groups = reporting.report_breakdown([inside, outside], dim, NOW - 2 * DAY, NOW + DAY)
    assert sum(g["events"]["estimated"] for g in groups) == 1, (dim, groups)
    assert sum(g["events"]["measured"] for g in groups) == 0, (dim, groups)
    assert sum(g["unpriced_calls"] for g in groups) == 0, (dim, groups)
    assert [g["key"] for g in groups] == [{"served": "claude-sonnet-5",
                                           "base": "claude-opus-5", "tier": "sonnet",
                                           "harness": "claude-code",
                                           "decision": "downgrade"}[dim]]


# ---------------------------------------------------------------------------
# 7b. a row whose `ts` DIED and whose `pday` LIVED is windowed BY THAT DAY
# ---------------------------------------------------------------------------
#
# `ts` and `pday` are separate fields with separate merge outcomes, and `derive_row`
# prices off `pday`. Exempting a row from the window whenever its `ts` is non-finite
# therefore waved a fully PRICEABLE row into every window ever asked for: breakdown(April)
# and breakdown(August) each claimed the same $0.06 while their union claimed it once, and
# `unpriced_calls` stayed 0 because the row was a priced CONTRIBUTOR rather than a counted
# exclusion. These tests pin the boundary between the two states.

# Declared coverage spanning EVERY window these tests ask for, including the 2027 one, so
# that `not_covered` is never the variable under test here: what is on trial is which
# window a row lands in, not whether the period was watched.
COVERED = {"v": 1, "coverage": [{"kind": "observed", "from": 0, "to": utc_ms(2028, 1, 1)}],
           "tombstones": [], "ingested_files": []}

# A partition of [Apr 1, Sep 1): two disjoint halves that tile the union exactly, so
# additivity is a property of the windowing and not of a gap between them.
PART_A = (utc_ms(2026, 4, 1), utc_ms(2026, 8, 1))
PART_B = (utc_ms(2026, 8, 1), utc_ms(2026, 9, 1))
PART_U = (PART_A[0], PART_B[1])


def pday_only(idx=2, *, pday=PDAY_ONLY_DAY, tzo=0, **kw):
    """A row whose ``ts`` is dead and whose frozen ``pday`` SURVIVED.

    Exactly what ``store.merge`` writes when two sources tie on rank for ``ts`` and
    disagree on its value while agreeing on ``pday`` -- proven reachable through the real
    fold in the test directly below, so this shortcut is a convenience and not a fiction.
    """
    r = ev(idx, ts=NOW, pday=pday, **kw)
    r["ts"] = None
    r["tzo"] = tzo
    return r


def _events(groups):
    return {b: sum(g["events"][b] for g in groups) for b in ("measured", "estimated")}


def _saved(groups, basis="estimated"):
    """The basis' saved, summed over the groups/points that STATE one.

    A WITHHELD group states no figure, and `(v or 0)` as a summing fallback is exactly the
    concealment this suite exists to prevent -- it turns a declined claim into a zero
    addend. So a withheld group contributes NOTHING to this sum and every caller that can
    encounter one asserts the withholding separately (see `_withheld`). Callers over row
    sets with no unpriceable rows are unaffected: nothing is skipped there.
    """
    return sum(g[basis]["saved"] for g in groups if g[basis]["saved"] is not None)


def _withheld(groups, basis="estimated"):
    """The groups/points whose dollars were declined, by their own published flag."""
    return [g for g in groups if g.get("dollars_suppressed")
            or g[basis]["saved"] is None]


# ---------------------------------------------------------------------------
# RAW fold vs RENDERED bucket -- the two-layer contract, restated on the test side
# ---------------------------------------------------------------------------
#
# `store.fold_rows` is the ARITHMETIC primitive: it returns raw numeric sums under
# `measured`/`estimated` AND a boolean `dollars_suppressed` -- "here are the sums, and
# here is whether you are allowed to publish them". `reporting._withhold_dollars` is the
# RENDER decision that acts on that boolean, and `report_window`, `report_breakdown` and
# `report_trend` all apply it. So a RENDERED bucket is never comparable to a RAW fold: the
# raw fold still carries 0.0 where the rendered bucket carries None. An expectation built
# straight from `fold_rows(...)[basis]` can therefore only pass in the windows where
# suppression happens not to fire, which is exactly the bug these three helpers close.
#
# EVERYTHING BELOW IS DELIBERATELY DUPLICATED, NOT IMPORTED.
#
#   * `_TEST_DOLLAR_FIELDS` restates `reporting._DOLLAR_FIELDS`.
#   * the nulling loop in `_folded` restates the body of `reporting._withhold_dollars`.
#   * `_expect_suppressed` restates the ratio test in `store.fold_rows`.
#
# Importing any of the three would make the expectation a function of the very code under
# test, and the assertion would then hold no matter what that code did: call
# `_withhold_dollars` to build the expectation and a bug INSIDE `_withhold_dollars`
# (nulling the wrong field, nulling none of them) is reproduced on both sides of the `==`
# and cannot be seen. Read `fold_rows(...)["dollars_suppressed"]` to decide whether to null
# and a change to the THRESHOLD is likewise invisible -- the fold agrees with itself for
# any threshold at all. The duplication is the entire point: these are an INDEPENDENT
# statement of the published rule, and they are supposed to break when the product's
# statement of it moves. If a rule below ever legitimately changes, change it here too --
# on purpose, in a commit that says so.
_TEST_DOLLAR_FIELDS = ("saved", "spent", "baseline", "gross", "extra")

# Design invariant #4 as published: "more than 20% unpriceable TOKENS suppresses dollars
# and reports tokens". Strictly greater, measured in tokens and not in calls, and vacuous
# for a row set carrying no tokens at all.
_SUPPRESSION_THRESHOLD = 0.20


def _expect_suppressed(rows) -> bool:
    """Whether the published rule forbids `rows` from claiming a dollar figure.

    Computed from `store.derive_row` -- the priceability primitive, which decides only
    whether a single row CAN be priced and says nothing about thresholds -- plus the 20%
    line restated above. Never from `store.fold_rows(...)["dollars_suppressed"]`, which is
    the answer under test.
    """
    seen = 0
    unpriced = 0
    for r in (rows or []):
        d = store.derive_row(r)
        seen += d["tokens"]
        if not d["priceable"]:
            unpriced += d["tokens"]
    return seen > 0 and (unpriced / seen) > _SUPPRESSION_THRESHOLD


def _folded(rows, basis):
    """The fold of `rows` on one basis, RENDERED -- i.e. with the withholding applied.

    `report_breakdown` and `report_trend` used to publish `fold_rows(...)[basis]` RAW --
    they computed `dollars_suppressed` and threw it away -- so a group or bucket whose
    tokens were more than a fifth unpriceable printed a dollar figure while the ladder row
    over the same rows said no figure was claimed. The expectation here therefore has to
    carry the same withholding, or this suite pins the defect instead of the rule.

    The sums come from `store.fold_rows` because reproducing the pricing arithmetic in the
    test would prove nothing about it. The two RENDER decisions -- whether to withhold, and
    which fields withholding empties -- are written out here instead, for the reasons in
    the block comment above. Withholding replaces a dollar with None and NEVER with 0.0:
    "$0.00" is a measured result and "no claim made" is not, and collapsing the second into
    the first is the concealment this whole suite exists to prevent.
    """
    acc = dict(store.fold_rows(rows)[basis])
    if _expect_suppressed(rows):
        for k in _TEST_DOLLAR_FIELDS:
            acc[k] = None
    return acc


def test_the_merge_path_really_produces_a_row_whose_ts_died_and_whose_pday_lived():
    """No hand-edited row: `store.fold` on two transcript lines that share a provider id
    and a rev, 1500 ms apart inside ONE local day.

    `merge` ranks `ts` and `pday` as SEPARATE fields. The two `ts` values tie on rank and
    fail `_strict_eq`, so `ts` is nulled and named in `conflicts` -- while `pday` AGREES
    and survives untouched. The resulting row has no instant and a perfectly good price
    date, which is why `derive_row` prices it and why the window has to test it.
    """
    a = ev(1, ts=NOW)
    b = ev(1, ts=NOW + 1500)
    a["id"] = b["id"] = "rid:req_conflict01"

    row = store.fold([a, b])["rows"][0]
    assert row["ts"] is None
    assert "ts" in row["conflicts"]
    assert row["pday"] == PDAY_ONLY_DAY, "the frozen day must SURVIVE the ts conflict"
    assert row["tzo"] == 0

    d = store.derive_row(row)
    assert d["priceable"] is True, "priced off `pday`, not off `ts`"
    assert d["delta"] > 0
    # ...and the fold agrees: this is a priced contributor, NOT an unpriced exclusion.
    f = store.fold_rows([row])
    assert f["unpriced_calls"] == 0
    assert f["estimated"]["calls"] == 1
    assert f["estimated"]["saved"] == pytest.approx(d["delta"], abs=1e-12)


def test_a_row_dated_only_by_its_frozen_day_appears_in_that_day_s_window_and_no_other():
    """The blocker, stated as the property it violated: one row, four windows, and the
    dollars may appear in exactly the one window that contains its own day."""
    row = pday_only()
    saved = store.fold_rows([row])["estimated"]["saved"]
    assert saved > 0, "the fixture must carry real dollars or this proves nothing"

    for (frm, to), present in ((PART_B, True), (APRIL, False), (Y2027, False),
                               ((None, None), True)):
        groups = reporting.report_breakdown([row], "served", frm, to)
        points = reporting.report_trend([row], "day", frm, to)
        rep = reporting.report_window([row], frm, to, COVERED, TZ)

        want_calls = 1 if present else 0
        want_saved = saved if present else 0.0
        assert _events(groups)["estimated"] == want_calls, (frm, to, groups)
        assert _saved(groups) == pytest.approx(want_saved, abs=1e-12), (frm, to, groups)
        assert _events(points)["estimated"] == want_calls, (frm, to, points)
        assert _saved(points) == pytest.approx(want_saved, abs=1e-12), (frm, to, points)
        assert rep["events"]["estimated"] == want_calls, (frm, to, rep)
        assert (rep["estimated"]["saved"] or 0.0) == pytest.approx(want_saved, abs=1e-12)
        # It is never a silent FABRICATION and never a silent OMISSION: when it is in,
        # it is bucketed at its own day and disclosed; when it is out, it is out of every
        # channel, including the trailing `undated` one (which would attribute a DATED
        # row to no day).
        assert [p["bucket"] for p in points] == ([PDAY_ONLY_DAY] if present else [])
        assert all(p["undatable"] is False for p in points)
        assert rep["undated"] == 0
        assert rep["dated_by_pday"] == want_calls
        assert ("dated_by_frozen_day" in rep["labels"]) is present
        assert "incomplete" not in rep["labels"]


def test_breakdown_and_trend_are_additive_over_a_partition_for_a_pday_only_row():
    """`report(A) + report(B) == report(A u B)` where A and B TILE the union, for the row
    whose only date is a frozen day. Before the fix each half claimed the whole figure and
    the sum was twice the union -- with one call counted twice.

    The fully-undatable row in the fixture is here to pin the quantities that are
    deliberately NOT additive on THESE two surfaces: it is exempt from the window (it can
    be placed nowhere, and `derive_row` refuses to price it), so it joins its own real
    group / the trailing `undated` point in EVERY window, and both its `unpriced_calls`
    and its `events` appear there as disclosure counters rather than as window quantities.

    That is sound because it carries no DOLLARS and no PRICED `calls` into any of them --
    which is what the money and accumulator assertions below check, on both bases -- and
    because the two disclosure counters move together: `events` counts it once and
    `unpriced_calls` counts the same row once, in the same group, so no surface can show
    it as an event whose exclusion is not also stated. `report_window`, whose `events` is
    the additive surface (it excludes the exempt row outright and names it in `undated`),
    is asserted additive over the same partition in
    `test_report_window_events_are_additive_over_a_partition` below.

    RAW FOLD vs RENDERED PART. Every dollar figure below is read off a RENDERED group or
    bucket, which means a part that withholds states None and not 0.0 -- so the additive
    identity is stated over the parts that CLAIM a figure, and the parts that decline are
    pinned separately by the published rule (`_expect_suppressed`), recomputed here rather
    than read back from `store.fold_rows`. Summing a declined figure with `or 0` would turn
    "no claim made" into a zero addend and make the identity hold by construction, which is
    the concealment shape this whole workstream exists to end.
    """
    rows = [
        ev(1, ts=utc_ms(2026, 5, 4, 9)),                       # dated, half A
        ev(2, ts=utc_ms(2026, 8, 3, 9), conf="measured"),      # dated, half B
        pday_only(3),                                          # frozen day only, half B
    ]
    orphan = ev(4, ts=NOW)
    orphan["ts"] = None
    orphan["pday"] = None
    orphan["tzo"] = None
    rows.append(orphan)

    for report, kind in (
            (lambda w: reporting.report_breakdown(rows, "served", w[0], w[1]),
             "breakdown"),
            (lambda w: reporting.report_trend(rows, "day", w[0], w[1]), "trend")):
        a, b, u = report(PART_A), report(PART_B), report(PART_U)
        # The exempt orphan is unpriceable and joins its own real group / the trailing
        # `undated` point in EVERY window, so that group's tokens are more than a fifth
        # unpriceable and its DOLLARS are withheld -- in all three windows alike. A
        # withheld figure is not an addend and may not be summed with `or 0`; the dollar
        # identity below is therefore asserted over the groups that STATE a figure, and
        # the withholding is asserted separately, per window, right after.
        #
        # The membership of each window is spelled out here rather than derived from the
        # response, so that the withholding can be checked against the PUBLISHED RULE
        # (`_expect_suppressed`, restated from `store.fold_rows`) instead of against the
        # fold's own conclusion. `served` puts every row of this fixture in ONE group, so
        # for the breakdown the group's rows ARE the window's rows plus the exempt orphan,
        # and the 20%-of-tokens line can be applied to it literally: 1 unpriceable row in
        # 2, in 3 and in 4 respectively, all of them over the line.
        for w, name, kept in ((a, "A", [rows[0], orphan]),
                              (b, "B", [rows[1], rows[2], orphan]),
                              (u, "U", rows)):
            assert len(_withheld(w, "estimated")) == 1, (name, w)
            assert all(g["dollars_suppressed"] is True
                       for g in _withheld(w, "estimated")), (name, w)
            if kind == "breakdown":
                assert len(w) == 1, (name, w)
                assert _expect_suppressed(kept) is True, (name, kept)
                assert w[0]["dollars_suppressed"] is _expect_suppressed(kept), (name, w)
            else:
                # On `day` the exempt orphan is alone in the trailing `undated` bucket, so
                # THAT is the part the rule declines -- and the dated buckets, which hold
                # no unpriceable row at all, must keep their figures.
                assert _expect_suppressed([orphan]) is True, (name, kind)
                for p in w:
                    assert p["dollars_suppressed"] is (p["bucket"] == "undated"), (name, p)
        for basis in ("measured", "estimated"):
            for field in ("saved", "spent", "baseline", "gross", "extra"):
                stated = lambda w: sum(g[basis][field] for g in w  # noqa: E731
                                       if g[basis][field] is not None)
                assert (stated(a) + stated(b)) == pytest.approx(stated(u), abs=1e-12), \
                    (basis, field)
            # The COUNTS survive withholding intact and are additive with nothing skipped.
            for field in ("calls", "tokens", "credited", "offset"):
                assert (sum(g[basis][field] for g in a)
                        + sum(g[basis][field] for g in b)) == sum(
                    g[basis][field] for g in u), (basis, field)
        # Non-vacuous on BOTH sides and on BOTH bases. `events` is ROWS SEEN, so each half
        # carries its own dated estimated row PLUS the window-exempt orphan, which is
        # present in all three: A has one dated estimated row, B has one, the union has
        # both, and every one of the three also carries the orphan.
        assert [_events(w)["estimated"] for w in (a, b, u)] == [2, 2, 3]
        assert _events(b)["measured"] == 1
        # Non-vacuous DOLLARS, and WHICH surface still states them is asserted rather than
        # glossed. `served` puts every row of this fixture in ONE group, so the exempt
        # unpriceable row lifts that single group over the 20%-of-tokens threshold and the
        # whole group withholds. `day` puts the same row alone in the trailing `undated`
        # bucket, so the dated buckets keep their figures and only that bucket withholds.
        # Both outcomes are the SAME rule over different partitions, and both are flagged.
        if kind == "trend":
            assert _saved(u) > 0
            assert [p["bucket"] for p in _withheld(u, "estimated")] == ["undated"]
        else:
            assert [g["key"] for g in u] == [_DATABLE_GROUP["served"]]
            assert _saved(u) == 0, "the one group withholds; nothing is claimed"
            assert u[0]["estimated"]["calls"] == 2, "and the COUNTS still stand"
        # The exempt row: same count in every window, contributing nothing to any of them.
        assert [sum(g["unpriced_calls"] for g in w) for w in (a, b, u)] == [1, 1, 1]
        # ...and it is the SAME row on both counters, so its `events` contribution never
        # appears without its exclusion appearing beside it. It is the only unpriceable
        # row in this fixture, so netting the disclosure off `events` leaves exactly the
        # windowed rows -- and THOSE are additive: 1 + 1 == 2.
        net = [_events(w)["estimated"] - sum(g["unpriced_calls"] for g in w)
               for w in (a, b, u)]
        assert net == [1, 1, 2] and net[0] + net[1] == net[2]


def test_report_window_events_are_additive_over_a_partition():
    """`events(A) + events(B) == events(A u B)` where A and B TILE the union — with an
    UNPRICEABLE row on each side, which is the whole point: before the fix those rows
    contributed 0 to every window, so the identity held vacuously for them.

    `report_window` is the additive surface for `events`: every row is placed at exactly
    ONE instant, and a row that can be placed nowhere is excluded from EVERY window
    (including lifetime) and named in `undated`. Breakdown and trend deliberately differ —
    they keep the exempt row in every window as a disclosure — and that difference is
    pinned in `test_the_breakdown_the_trend_and_the_window_reconcile_over_the_same_rows`.
    """
    rows = [
        ev(1, ts=utc_ms(2026, 5, 4, 9)),                                    # A, priced
        ev(2, ts=utc_ms(2026, 5, 5, 9), served="llama-4-maverick",          # A, UNPRICED
           conf="measured"),
        ev(3, ts=utc_ms(2026, 8, 3, 9), conf="measured"),                   # B, priced
        ev(4, ts=utc_ms(2026, 8, 4, 9), served="llama-4-maverick"),         # B, UNPRICED
        pday_only(5),                                                       # B, frozen day
    ]
    orphan = ev(6, ts=NOW)
    orphan["ts"] = None
    orphan["pday"] = None
    orphan["tzo"] = None
    rows.append(orphan)

    a, b, u = (reporting.report_window(rows, w[0], w[1], COVERED, TZ)
               for w in (PART_A, PART_B, PART_U))
    for basis in ("measured", "estimated"):
        assert a["events"][basis] + b["events"][basis] == u["events"][basis], basis
    # Non-vacuous: both halves carry rows on both bases, and unpriceable rows are among
    # them — so this is not the old identity holding because the unpriced rows were zero.
    assert a["events"] == {"measured": 1, "estimated": 1}
    assert b["events"] == {"measured": 1, "estimated": 2}
    assert u["events"] == {"measured": 2, "estimated": 3}
    assert a["unpriced_calls"] == 1 and b["unpriced_calls"] == 1
    # The row that can be placed nowhere is in NO window's `events`, on either basis, and
    # is named by `undated` in all three — so the identity is not paid for by hiding it.
    assert [w["undated"] for w in (a, b, u)] == [1, 1, 1]
    # ...and the ladder still sums to an INDEPENDENTLY computed lifetime on this field.
    ladder = reporting.report_periods(rows, TZ, now_ms=NOW, state=COVERED)
    lifetime = reporting.lifetime_window(rows, TZ, state=COVERED)
    for basis in ("measured", "estimated"):
        assert sum(w["events"][basis] for w in ladder) == lifetime["events"][basis], basis
    assert lifetime["events"] == {"measured": 2, "estimated": 3}


def test_the_breakdown_the_trend_and_the_window_reconcile_over_the_same_rows(events_dir):
    """Three endpoints, one row set, one window: they may not disagree about what the
    window holds. `/api/v1/reports/window` still applied `in_window` first, so it reported
    0 events and `undated: 1` for the exact window in which `/breakdown` reported $0.06 and
    one estimated call -- on the SAME row -- while `_api_envelope` stamped both responses
    with the requested from/to. Whichever the reader believed, the other was an affirmative
    claim its sibling contradicted.

    RAW FOLD vs RENDERED PART, and the reason the three surfaces can differ HONESTLY. The
    window excludes the exempt orphan, so it prices a set with no unpriceable rows in it and
    states a figure. Breakdown and trend KEEP that orphan, so the part holding it is over the
    published 20%-of-tokens line and has been through the render step: it states None, not
    0.0. The reconciliation is therefore over the parts that CLAIM a figure, the declining
    parts are identified by the published rule recomputed here (`_expect_suppressed`) rather
    than by the fold's own flag, and nothing is ever summed with `or 0`.
    """
    rows = [
        ev(1, ts=utc_ms(2026, 5, 4, 9)),
        ev(2, ts=utc_ms(2026, 8, 3, 9), conf="measured"),
        pday_only(3),
    ]
    orphan = ev(4, ts=NOW)
    orphan["ts"] = None
    orphan["pday"] = None
    orphan["tzo"] = None
    rows.append(orphan)

    # The rows `report_breakdown` is entitled to keep in each window: the WINDOWED ones plus
    # the window-exempt orphan, which joins every window. Spelled out here, not read back
    # off the response, so the assertions below are an independent statement about which
    # part may claim a dollar figure and which may not.
    kept_by_window = {PART_A: [rows[0]], PART_B: [rows[1], rows[2]],
                      PART_U: rows[:3], APRIL: [], (None, None): rows[:3]}

    for frm, to in (PART_A, PART_B, PART_U, APRIL, (None, None)):
        groups = reporting.report_breakdown(rows, "served", frm, to)
        points = reporting.report_trend(rows, "day", frm, to)
        rep = reporting.report_window(rows, frm, to, COVERED, TZ)
        assert rep["dollars_suppressed"] is False, (frm, to)

        # `served` puts every row of this fixture in ONE group, so the 20%-of-tokens rule
        # applies to that group literally: it always holds the orphan, whose tokens are
        # 1 in 2, 1 in 3, 1 in 4 or the whole group depending on the window -- over the line
        # every time. This is the claim that makes the reconciliation below non-vacuous:
        # without it, a build in which NOTHING ever withholds satisfies every assertion in
        # this test, because the "declined" branch would simply never be entered.
        kept = kept_by_window[(frm, to)] + [orphan]
        assert len(groups) == 1, (frm, to, groups)
        assert _expect_suppressed(kept) is True, (frm, to)
        assert groups[0]["dollars_suppressed"] is _expect_suppressed(kept), (frm, to)
        # ...and the withholding actually reached the published dollars, rather than being
        # merely announced by the flag: the group equals its own fold, RENDERED.
        for basis in ("measured", "estimated"):
            assert groups[0][basis] == _folded(kept, basis), (frm, to, basis)

        # The window EXCLUDES the row that can be placed nowhere and names it in
        # `undated`; breakdown and trend KEEP it, in its own real group and in the
        # trailing labelled `undated` point respectively, and name it in
        # `unpriced_calls`. That difference is the documented, deliberate disposition
        # (see `_window_disposition`), so with `events` now meaning ROWS SEEN the three
        # surfaces reconcile at a stated OFFSET of exactly that row rather than at zero.
        # The offset is the SAME number `report_window` prints as `undated`, on the same
        # payload, so no surface asserts a count another one contradicts.
        assert rep["undated"] == 1 and "incomplete" in rep["labels"]
        exempt = {"measured": 0, "estimated": rep["undated"]}   # the orphan is estimated

        for basis in ("measured", "estimated"):
            assert _events(groups)[basis] == rep["events"][basis] + exempt[basis], \
                (frm, to, basis)
            assert _events(points)[basis] == rep["events"][basis] + exempt[basis], \
                (frm, to, basis)
            # The PRICED counts reconcile exactly, with no offset at all: the exempt row
            # is unpriceable, so it enters neither accumulator on any of the three.
            assert sum(g[basis]["calls"] for g in groups) == rep[basis]["calls"], \
                (frm, to, basis)
            assert sum(p[basis]["calls"] for p in points) == rep[basis]["calls"], \
                (frm, to, basis)
            # THE DOLLARS. The window prices its own set; breakdown and trend also hold
            # the window-exempt row, and where that row's unpriceable tokens dominate a
            # group or a bucket, that part DECLINES to price rather than printing a
            # figure derived from part of the evidence. A declined figure is not an
            # addend and is never summed with `or 0` -- so the reconciliation is stated
            # over the parts that DO claim a figure, and every part that declines has to
            # carry both its flag and its reason.
            for section, label in ((groups, "breakdown"), (points, "trend")):
                declined = _withheld(section, basis)
                for part in declined:
                    assert part["dollars_suppressed"] is True, (frm, to, label, part)
                    assert part["unpriced_calls"] >= 1, (frm, to, label, part)
                priced_in_declined = sum(p[basis]["calls"] for p in declined)
                if priced_in_declined == 0:
                    # Nothing the WINDOW priced sits inside a declining part, so the
                    # parts that do claim a figure must reproduce the window's exactly.
                    assert _saved(section, basis) == pytest.approx(
                        rep[basis]["saved"], abs=1e-12), (frm, to, basis, label)
                else:
                    # ...otherwise the section claims strictly LESS than the window, and
                    # the whole shortfall sits inside flagged parts whose priced calls
                    # are published beside the flag: an absence with a stated reason,
                    # never a fabricated zero and never a silently smaller total.
                    assert _saved(section, basis) <= rep[basis]["saved"] + 1e-12, \
                        (frm, to, basis, label)
                    assert priced_in_declined <= rep[basis]["calls"], \
                        (frm, to, basis, label)

        # ...and it is named by every surface, through each surface's own visible
        # channel -- never dropped, and never counted as a PRICED call.
        assert sum(g["unpriced_calls"] for g in groups) == 1
        assert [p["bucket"] for p in points][-1] == "undated"
        assert points[-1]["events"]["estimated"] == 1, \
            "the trailing point exists only because a row is in it; it may not report 0"


@pytest.mark.parametrize("bad", ["2026-13-45", "2026-02-30", 20260410, "0000-01-01",
                                 " 2026-08-05", "2026-8-5", "26-08-05", True])
def test_a_pday_that_names_no_day_is_REFUSED_by_the_pricer_never_priced(bad):
    """`store.derive_row` used to test only that `pday` was TRUTHY.

    `store.read_segment` validates only that a line is a JSON dict at or below SCHEMA_V,
    so a hand-edited, corrupted or third-party-written segment reaches the pricer. A row
    carrying `pday: "2026-13-45"` was therefore PRICED, while `_placement` could put it on
    no day at all -- its dollars appeared in `fold_rows` and in NO window, NO group, NO
    bucket and NO exclusion counter. Refusing to date it here is what makes the window
    exemption provably zero-dollar."""
    assert store.iso_day_ms(bad) is None
    d = store.derive_row(ev(1, ts=None, pday=bad))
    assert d["priceable"] is False
    assert d["reason"] == store.REASON_NO_TS
    # null, not 0. "$0.00" is a measured result; "no claim made" is not.
    assert d["delta"] is None and d["spent"] is None and d["baseline"] is None


def test_a_real_calendar_day_still_prices_so_the_refusal_is_a_narrowed_domain():
    """The half of the claim above that must be able to FAIL. A guard that refuses
    everything would pass every assertion in the test above and price nothing at all."""
    for good in ("2026-08-05", "0001-01-01", "9999-12-31", "2024-02-29"):
        assert store.iso_day_ms(good) is not None
        assert store.derive_row(ev(1, ts=None, pday=good))["priceable"] is True
    # ...and the boundary is the CALENDAR, not the string: 2026 is not a leap year.
    assert store.iso_day_ms("2026-02-29") is None


def test_an_unpriceable_malformed_day_is_counted_in_exactly_one_place_on_every_surface():
    """The MAJOR, stated as the property it violated.

    Over [good, malformed] at LIFETIME scope, `store.fold_rows` reported 0.10 while
    `lifetime_window` reported 0.06: `fold_rows` priced the malformed row and every
    window excluded it, so the two readings of the same two rows differed by exactly its
    dollars and nothing anywhere named the gap. It appeared in no group, no bucket and no
    counter -- `unpriced_calls` was 0 on all three endpoints.

    RAW FOLD vs RENDERED SURFACE. `store.fold_rows` is the arithmetic primitive and returns
    both the sums and the verdict on whether they may be shown; the three endpoints render
    that verdict by nulling every dollar field. So the malformed row does not merely fail to
    ADD dollars -- where its tokens carry a part over the published 20% line it REMOVES that
    part's dollars, which is why the breakdown group below states None while the window,
    which excludes the row outright, still states a figure. Both are correct and neither is
    "$0.00": a measured null result and a declined claim are different statements.
    """
    good = ev(1, ts=NOW)
    bad = ev(2, ts=NOW, pday="2026-13-45")
    bad["ts"] = None
    rows = [good, bad]
    saved = store.fold_rows([good])["estimated"]["saved"]
    assert saved > 0, "the fixture must carry real dollars or this proves nothing"

    # 1. the two readings of the same rows now agree, to the cent.
    assert store.fold_rows(rows)["estimated"]["saved"] == pytest.approx(saved, abs=1e-12)
    lifetime = reporting.lifetime_window(rows, TZ, state=COVERED)
    assert lifetime["estimated"]["saved"] == pytest.approx(saved, abs=1e-12)
    assert lifetime["estimated"]["calls"] == 1

    # 2. it contributes no dollars to any window, and it is COUNTED on every surface,
    #    through that surface's own visible channel -- never a silent omission.
    for frm, to in (PART_B, PART_U, APRIL, (None, None)):
        rep = reporting.report_window(rows, frm, to, COVERED, TZ)
        groups = reporting.report_breakdown(rows, "served", frm, to)
        points = reporting.report_trend(rows, "day", frm, to)
        assert rep["undated"] == 1, (frm, to)
        assert "incomplete" in rep["labels"]
        assert sum(g["unpriced_calls"] for g in groups) == 1, (frm, to)
        # The malformed row is exempt from the window and so joins EVERY breakdown group,
        # and `served` puts both rows in one group -- so that group is half unpriceable by
        # token weight (all of it, in April), over the published 20% line, and its DOLLARS
        # are withheld while its counts survive. Asserted against the rule recomputed here,
        # never against the fold's own flag, and asserted on the published dollars and not
        # only on the flag.
        kept = ([] if (frm, to) == APRIL else [good]) + [bad]
        assert len(groups) == 1, (frm, to, groups)
        assert _expect_suppressed(kept) is True, (frm, to)
        assert groups[0]["dollars_suppressed"] is _expect_suppressed(kept), (frm, to)
        for basis in ("measured", "estimated"):
            assert groups[0][basis] == _folded(kept, basis), (frm, to, basis)
        # ...and the WINDOW, which excludes the row outright, is not suppressed and does
        # state its figure. The two surfaces differ, both correctly, and the difference is
        # exactly the row -- which is the whole point of this test.
        assert rep["dollars_suppressed"] is False, (frm, to)
        windowed = [] if (frm, to) == APRIL else [good]
        assert _expect_suppressed(windowed) is False, (frm, to)
        assert [p["bucket"] for p in points][-1] == "undated", (frm, to)
        assert points[-1]["unpriced_calls"] == 1
        # It entered NEITHER accumulator, on either basis, in any window -- so the PRICED
        # counts are 1 where the good row is in scope and 0 in April, and the malformed
        # row adds nothing to either.
        priced = sum(p[b]["calls"] for p in points for b in ("measured", "estimated"))
        assert priced == (1 if (frm, to) != APRIL else 0), (frm, to)
        # ...while `events` (ROWS SEEN) counts it once, in the trailing labelled `undated`
        # point and nowhere else. A bucket that exists only because a row is in it may not
        # report that it holds none.
        assert points[-1]["events"] == {"measured": 0, "estimated": 1}, (frm, to)
        assert _events(points)["estimated"] + _events(points)["measured"] == (
            2 if (frm, to) != APRIL else 1), (frm, to)
        assert _saved(points) == pytest.approx(
            saved if (frm, to) != APRIL else 0.0, abs=1e-12)


def test_a_frozen_day_is_placed_at_the_rows_own_offset_never_at_the_hosts():
    """A `pday` is a LOCAL calendar day, so the instant it began depends on the offset
    frozen on the row. Reading it in the report's frame would restate which window a
    UTC-7 machine's call belongs to; reading it as UTC would be the same 0-substitution
    the frozen `tzo` column exists to prevent, one layer up."""
    west = pday_only(1, tzo=-420)          # day begins 2026-08-07T07:00Z
    east = pday_only(2, tzo=330)           # day begins 2026-08-06T18:30Z

    def calls(row, frm, to):
        return _events(reporting.report_breakdown([row], "served", frm, to))["estimated"]

    # The UTC reading (00:00Z) would put `west` here. Its own offset does not.
    assert calls(west, utc_ms(2026, 8, 7), utc_ms(2026, 8, 7, 7)) == 0
    assert calls(west, utc_ms(2026, 8, 7, 7), utc_ms(2026, 8, 7, 8)) == 1
    # ...and eastward, the same rule sends the row into the PREVIOUS UTC day.
    assert calls(east, utc_ms(2026, 8, 6, 18), utc_ms(2026, 8, 6, 19)) == 1
    assert calls(east, utc_ms(2026, 8, 7), utc_ms(2026, 8, 8)) == 0
    # Half-open, so the boundary instant belongs to exactly one of two adjacent windows.
    assert calls(west, utc_ms(2026, 8, 7, 6), utc_ms(2026, 8, 7, 7)) == 0
    assert calls(west, utc_ms(2026, 8, 7, 7), utc_ms(2026, 8, 7, 7)) == 0


def test_adjacent_windows_that_split_the_rows_own_day_still_see_it_exactly_once():
    """WHY THE ROW IS PLACED AT A POINT AND NOT TESTED AS ITS DAY'S INTERVAL.

    `west`'s local day runs [Aug 7 07:00Z, Aug 8 07:00Z) and the two windows below cut
    straight through it. INTERSECTING the day with each window puts the row in BOTH, so
    report(W1) + report(W2) is twice report(W1 u W2) -- the exact failure this workstream
    exists to end, reintroduced by the more generous-looking test. Requiring the day to be
    CONTAINED puts it in NEITHER, so the identity breaks the other way and a real call is
    lost from both halves while their union keeps it. Only a point partitions, so a point
    is what is tested -- the instant the row's own day began, in the row's own frame.
    """
    west = pday_only(1, tzo=-420)
    w1 = (utc_ms(2026, 8, 7), utc_ms(2026, 8, 8))
    w2 = (utc_ms(2026, 8, 8), utc_ms(2026, 8, 9))
    union = (w1[0], w2[1])
    saved = store.fold_rows([west])["estimated"]["saved"]
    assert saved > 0

    for kind, count, money in (
            ("breakdown",
             lambda w: _events(reporting.report_breakdown([west], "served",
                                                          w[0], w[1]))["estimated"],
             lambda w: _saved(reporting.report_breakdown([west], "served", w[0], w[1]))),
            ("trend",
             lambda w: _events(reporting.report_trend([west], "day",
                                                      w[0], w[1]))["estimated"],
             lambda w: _saved(reporting.report_trend([west], "day", w[0], w[1]))),
            ("window",
             lambda w: reporting.report_window([west], w[0], w[1], COVERED,
                                               TZ)["events"]["estimated"],
             lambda w: reporting.report_window([west], w[0], w[1],
                                               COVERED, TZ)["estimated"]["saved"])):
        assert count(w1) + count(w2) == count(union) == 1, kind
        assert money(w1) + money(w2) == pytest.approx(money(union), abs=1e-12), kind
        assert money(union) == pytest.approx(saved, abs=1e-12), kind


def test_a_frozen_day_with_no_frozen_offset_is_reconstructed_never_read_as_utc():
    """`store.merge` can null `tzo` while `pday` survives. The offset is then
    RECONSTRUCTED through `periods.local_offset_minutes` -- the same helper, the same
    documented fallback `periods.pday_of` uses for exactly this case -- and never read as
    0. The zone is PINNED, because on a UTC runner the reconstruction and the
    0-substitution are byte-identical and the assertion would distinguish nothing."""
    with pinned_zone():                     # America/Los_Angeles, -420 in August
        row = pday_only(1, tzo=None)

        def calls(frm, to):
            return _events(reporting.report_breakdown([row], "served",
                                                      frm, to))["estimated"]

        # Read as UTC the day begins at 00:00Z and the row would land here. It does not.
        assert calls(utc_ms(2026, 8, 7), utc_ms(2026, 8, 7, 7)) == 0
        # Reconstructed at -420 it begins at 07:00Z, and there it is.
        assert calls(utc_ms(2026, 8, 7, 7), utc_ms(2026, 8, 7, 8)) == 1
        # Supplied, not discovered: -420 is provably not the fabricated 0.
        assert periods.local_offset_minutes(utc_ms(2026, 8, 7, 12)) == PINNED_SUMMER_OFFSET


def test_the_ladder_still_partitions_history_when_a_row_is_dated_only_by_a_frozen_day():
    """The disjoint ladder is the shape that must never double-count, so the new
    placement is tested against it directly: the row lands in exactly ONE ladder window,
    and the ladder still sums to the independently computed lifetime total."""
    rows = [ev(1, ts=NOW - 3600000), ev(2, ts=utc_ms(2026, 5, 4, 9), conf="measured"),
            pday_only(3)]
    ladder = reporting.report_periods(rows, TZ, now_ms=NOW, state=COVERED)
    lifetime = reporting.lifetime_window(rows, TZ, state=COVERED)

    hits = [r["key"] for r in ladder if r["dated_by_pday"]]
    assert hits == ["today"], hits
    assert sum(r["dated_by_pday"] for r in ladder) == 1, "placed in exactly one window"
    assert lifetime["dated_by_pday"] == 1

    for basis in ("measured", "estimated"):
        for field in ("saved", "spent", "baseline"):
            assert sum(r[basis][field] for r in ladder) == pytest.approx(
                lifetime[basis][field], abs=1e-12), f"{basis}.{field}"
        assert sum(r[basis]["calls"] for r in ladder) == lifetime[basis]["calls"]
    assert lifetime["estimated"]["calls"] == 2 and lifetime["measured"]["calls"] == 1


def test_a_missing_offset_is_reconstructed_never_read_as_utc_by_pday_of():
    """`int(tzo or 0)` read a MISSING offset as UTC, which is the exact substitution the
    frozen-offset column exists to prevent, and it diverged from periods.js::pdayOf.
    An explicit 0 is a legitimate value and stays distinguishable from absence."""
    ms = 1756700000000        # 2025-09-01T00:13:20Z; 2025-08-31 at UTC-7
    with pinned_zone():
        assert periods.local_offset_minutes(ms) == PINNED_SUMMER_OFFSET
        assert periods.pday_of(ms, None) == "2025-08-31"     # reconstructed
        assert periods.pday_of(ms, 0) == "2025-09-01"        # explicit UTC, honoured
        assert periods.pday_of(ms, None) != periods.pday_of(ms, 0)


def test_an_undeterminable_machine_offset_is_None_never_a_fabricated_zero():
    """`local_offset_minutes` used to answer 0 when it could not compute an offset --
    an UNKNOWN reported as a MEASURED UTC, which is the exact substitution the frozen
    `tzo` column exists to prevent, one layer further down.

    It was not academic: it made the two runtimes disagree. At the year-1 calendar edge
    Python substituted 0 and rendered a confident '0001-01-01' while `periods.js::pdayOf`
    shifted by the machine's real offset and returned null; at the year-10000 edge the
    disagreement ran the other way. `cli/scripts/check-period-parity.js` now carries
    those exact instants as fixtures and fails on either.
    """
    assert periods.local_offset_minutes(periods.CAL_MAX_MS) is None
    assert periods.local_offset_minutes(1.7e15) is None       # seconds/ms unit slip
    # ...and it still answers a real number for a real instant, so the None above is a
    # narrowed domain and not a broken function.
    assert isinstance(periods.local_offset_minutes(1756700000000), int)


def test_a_reconstructed_offset_is_refused_outside_the_calendar():
    """Companion to `periods.test.js::a RECONSTRUCTED offset is refused outside the
    calendar`. Machine-zone independent -- the refusal is decided by the raw instant,
    before any offset is read -- which is the property that lets both runtimes assert a
    literal null and therefore agree in every zone the parity gate runs."""
    for absent in (None, "", "abc"):
        assert periods.pday_of(periods.CAL_MAX_MS, absent) is None
        assert periods.pday_of(periods.CAL_MIN_MS - 1, absent) is None
    # The EXPLICIT path is UNTOUCHED, and that is the half of the claim this test can
    # watch fail: a recorded offset is a fact about the ROW, not a reading of this
    # machine, so the calendar guard must sit INSIDE the reconstruction branch. Hoisting
    # it above the `tzo` branch -- the obvious over-correction -- turns the third
    # assertion below into None, and the two runtimes would then disagree again, the
    # other way round (periods.js gates only its reconstruction branch too).
    assert periods.pday_of(periods.CAL_MAX_MS - 1, -480) == "9999-12-31"
    assert periods.pday_of(periods.CAL_MIN_MS, 0) == "0001-01-01"
    # Raw instant OUTSIDE the calendar, offset EXPLICIT: still an answer, because the
    # offset carries it back inside. Both runtimes have always agreed here.
    assert periods.pday_of(periods.CAL_MAX_MS, -480) == "9999-12-31"


# ---------------------------------------------------------------------------
# lifetime · legacy · comparisons
# ---------------------------------------------------------------------------

def _write_legacy(events_dir, chats, version=1):
    path = os.path.join(os.path.dirname(os.path.normpath(events_dir)),
                        "legacy_chats.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"v": version, "imported_at": NOW, "chats": chats}, fh)
    return path


def test_the_periods_response_carries_lifetime_legacy_and_comparisons(client,
                                                                      auth_headers,
                                                                      events_dir):
    write_segment(events_dir, [ev(1, ts=NOW - 3600000, conf="measured"),
                               ev(2, ts=NOW - 7200000, conf="estimated")])
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    _write_legacy(events_dir, {
        "3d0afc92": {"usd": 3.7122, "tokens": 6343704, "exact": False,
                     "derivation": "frozen"},
        "8c60b680": {"usd": 1.2044, "tokens": 739001, "exact": False,
                     "derivation": "frozen"},
    })
    body = client.get("/api/v1/reports/periods",
                      params={"session": "rpt-session", "tz": "America/Los_Angeles"},
                      headers=auth_headers).json()

    assert set(body) >= {"periods", "lifetime", "legacy", "comparisons"}

    # 1. lifetime — same shape as a ladder entry, computed as ONE window.
    lt = body["lifetime"]
    assert lt["key"] == "lifetime"
    assert {"status", "measured", "estimated", "labels", "notes", "unpriced"} <= set(lt)
    assert lt["events"] == {"measured": 1, "estimated": 1}

    # 2. legacy — chat grain, frozen dollars, reported ONLY here.
    lg = body["legacy"]
    assert set(lg) == {"usd", "tokens", "chats", "derivation", "note"}
    assert lg["usd"] == pytest.approx(4.9166, abs=1e-9)
    assert lg["tokens"] == 7082705 and lg["chats"] == 2
    assert lg["derivation"] == "frozen"
    assert "CHAT" in lg["note"] and "excluded" in lg["note"]
    # It is NEVER folded into either basis, nor into lifetime.
    assert lt["measured"]["spent"] != pytest.approx(lg["usd"])
    for period in body["periods"]:
        for basis in ("measured", "estimated"):
            if period[basis]:
                assert period[basis].get("saved") != pytest.approx(lg["usd"])

    # 3. comparisons — an explicit n on BOTH sides.
    comp = body["comparisons"]
    assert set(comp) == {"month", "week"}
    for name, block in comp.items():
        assert set(block) == {"current", "previous"}
        for side in ("current", "previous"):
            w = block[side]
            assert set(w["bounds"]) == {"from", "to"}
            assert w["bounds"]["from"] < w["bounds"]["to"]
            assert set(w["events"]) == {"measured", "estimated"}
        assert block["previous"]["bounds"]["to"] <= block["current"]["bounds"]["from"]


def test_the_legacy_block_never_reports_zero_for_a_store_it_cannot_read(events_dir,
                                                                        monkeypatch):
    """A forward-incompatible legacy file must surface a REFUSAL, not "$0 saved" —
    ledger.js's catch-all `{chats:{}}` is exactly how a newer file read as zero."""
    _write_legacy(events_dir, {"x": {"usd": 5.0, "tokens": 10}}, version=99)
    block = reporting.legacy_block()
    assert block["usd"] is None and block["chats"] is None
    assert "newer Cheaper" in block["note"] and "not $0" in block["note"]


def test_the_legacy_block_is_empty_and_honest_when_there_is_no_legacy_file(events_dir):
    block = reporting.legacy_block()
    assert block == {"usd": 0.0, "tokens": 0, "chats": 0, "derivation": "frozen",
                     "note": block["note"]}
    assert block["chats"] == 0


def test_a_pre_migration_gateway_row_is_quarantined_not_merged(events_dir):
    """Case 5. A gateway row with no request id cannot be proven disjoint from the
    transcript rows covering the same calls, so it is dropped from the fold and counted.
    That is today's ENTIRE live database, and it is the correct outcome."""
    good = ev(1, ts=NOW - DAY, prov="gateway", conf="measured")
    weak = ev(2, ts=NOW - DAY + 1, prov="gateway", conf="measured")
    weak["id"] = "wk:" + "d" * 24
    write_segment(events_dir, [good, weak])
    u = reporting.unified_rows(None, events_dir)
    assert u["fold_stats"]["pre_migration"] == 1
    assert {r["id"] for r in u["rows"]} == {good["id"]}


# ---------------------------------------------------------------------------
# 7. ONE TIME FRAME: /logs and /api/v1 price the same row at the same day
# ---------------------------------------------------------------------------

# 23:30 on 2026-08-31 for a machine seven hours west of UTC. That instant is already
# 2026-09-01 in UTC, and the claude-sonnet-5 promotional window in model_prices.json
# runs to 2026-08-31 inclusive -- verified by the assertions in the first test below
# rather than assumed, because a catalog edit would otherwise silently defuse all of
# these without failing anything.
GW_EDGE_TS = 1788244200.0        # epoch SECONDS, the unit metrics.db stores
GW_EDGE_TZO = -420               # minutes EAST of UTC


def gw_metrics(tmp_path, *, tzo, ts=GW_EDGE_TS, served="claude-sonnet-5",
               base="claude-opus-5", request_id="req_gw_tz_1"):
    """A Metrics store holding exactly ONE gateway row, with an explicit stored offset.

    Written straight to SQLite because record() stamps the offset of the machine
    running the test, and this row has to be a UTC-7 evening on every host. A real
    request_id keeps the row out of the fold's pre-migration quarantine, so it survives
    to be priced by both layers.
    """
    import sqlite3

    import metrics as metrics_mod

    path = str(tmp_path / "gw.db")
    m = metrics_mod.Metrics(db_path=path)
    with sqlite3.connect(path) as c:
        c.execute(
            "INSERT INTO decisions (ts, tier, model, original_model, requested_tier, "
            "reason, source, in_tokens, out_tokens, status, session, usage_source, "
            "request_id, tzo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (ts, "sonnet", served, base, "opus", "s", "gw", 1_000_000, 1_000_000,
             200, "gw-sess", "body", request_id, tzo))
        c.commit()
    return m


def test_the_gateway_row_reports_the_same_dollars_from_logs_and_from_the_api_v1_path(
        tmp_path, events_dir):
    """THE ACCEPTANCE TEST for ITEM-4.

    One gateway row, recorded at 2026-08-31T23:30-07:00. `/logs` priced it at the UTC
    calendar date (2026-09-01, promo expired, sonnet-5 at list) while `/api/v1/*` priced
    it at pday (2026-08-31, promo live). Two endpoints of one product quoted $12 and $18
    of spend for the same call, and $18 and $12 of saving, with no hedge on either.

    The divergence between the two frames is asserted first, so this test cannot quietly
    stop testing anything if the catalog window moves.
    """
    import pricing

    # The two frames genuinely disagree on this instant. If either of these fails the
    # fixture is stale -- fix the fixture, do not relax the equality below.
    assert pricing.cost_of_model("claude-sonnet-5", 1_000_000, 1_000_000,
                                 at="2026-08-31") == 12.0
    assert pricing.cost_of_model("claude-sonnet-5", 1_000_000, 1_000_000,
                                 at="2026-09-01") == 18.0
    assert periods.pday_of(GW_EDGE_TS * 1000, GW_EDGE_TZO) == "2026-08-31"
    assert periods.pday_of(GW_EDGE_TS * 1000, 0) == "2026-09-01"

    m = gw_metrics(tmp_path, tzo=GW_EDGE_TZO)

    legacy = m.logs(session=None)["rows"][0]
    rows = reporting.unified_rows(m, events_dir)["rows"]
    assert len(rows) == 1, rows
    view = reporting.row_view(rows[0])

    # Same frame on both sides...
    assert legacy["pday"] == view["pday"] == "2026-08-31"
    assert legacy["tzo"] == view["tzo"] == GW_EDGE_TZO
    # ...therefore the same dollars, to the cent, on all three money columns.
    assert legacy["actual_cost"] == pytest.approx(view["actual_usd"], abs=1e-9)
    assert legacy["original_cost"] == pytest.approx(view["baseline_usd"], abs=1e-9)
    assert legacy["savings"] == pytest.approx(view["delta_usd"], abs=1e-9)
    # And it is the LOCAL-day answer, not the UTC-day one that used to be printed.
    assert legacy["actual_cost"] == pytest.approx(12.0, abs=1e-9)
    assert legacy["savings"] == pytest.approx(18.0, abs=1e-9)


def test_a_legacy_gateway_row_with_no_frozen_offset_is_reconstructed_identically(
        tmp_path, events_dir):
    """A row written before the tzo column existed carries NULL -- a real state, never
    read as UTC. Both layers reconstruct it through periods.local_offset_minutes, so
    they land on the same day and the same dollars whatever zone the host is in.

    The zone is PINNED. Reading the expectation off the host made this test pass on a
    UTC runner against an implementation that simply substituted 0 -- the two are
    byte-identical there, so the assertion distinguished nothing."""
    with pinned_zone():
        m = gw_metrics(tmp_path, tzo=None)
        expected_tzo = periods.local_offset_minutes(GW_EDGE_TS * 1000)
        # Supplied, not discovered: -420 is provably NOT the fabricated 0.
        assert expected_tzo == PINNED_SUMMER_OFFSET

        legacy = m.logs(session=None)["rows"][0]
        view = reporting.row_view(reporting.unified_rows(m, events_dir)["rows"][0])

        assert legacy["tzo"] == view["tzo"] == expected_tzo
        assert legacy["pday"] == view["pday"] == periods.pday_of(GW_EDGE_TS * 1000,
                                                                expected_tzo)
        # Reconstructed -> 2026-08-31, promo live, $12. Read as UTC -> 2026-09-01,
        # promo expired, $18. Different days AND different dollars, so the assertion
        # cannot be satisfied by the bug.
        assert legacy["pday"] == "2026-08-31"
        assert periods.pday_of(GW_EDGE_TS * 1000, 0) == "2026-09-01"
        assert legacy["actual_cost"] == pytest.approx(12.0, abs=1e-9)
        assert legacy["actual_cost"] == pytest.approx(view["actual_usd"], abs=1e-9)
        assert legacy["savings"] == pytest.approx(view["delta_usd"], abs=1e-9)


def test_gateway_row_to_event_prefers_the_rows_frozen_frame_over_reconstruction():
    """The row's own tzo/pday win. Reconstruction is the fallback for a row dict that
    predates those keys -- not a second opinion that can override a stored fact."""
    base = {"ts": GW_EDGE_TS, "routed_model": "claude-sonnet-5",
            "original_model": "claude-opus-5", "request_id": "req_pref_1",
            "basis": "measured", "in_tokens": 10, "out_tokens": 5, "status": 200}

    frozen = reporting.gateway_row_to_event(dict(base, tzo=330, pday="2026-09-01"))
    assert frozen["tzo"] == 330 and frozen["pday"] == "2026-09-01"

    # A half-hour zone no host sits in, supplied WITHOUT a pday: the offset is still
    # honoured and the day is derived from it, never from the machine.
    derived = reporting.gateway_row_to_event(dict(base, tzo=330))
    assert derived["pday"] == periods.pday_of(GW_EDGE_TS * 1000, 330)

    # No frame at all -> the shared reconstruction, matching what metrics.py would do.
    absent = reporting.gateway_row_to_event(dict(base))
    fallback = periods.local_offset_minutes(GW_EDGE_TS * 1000)
    assert absent["tzo"] == fallback
    assert absent["pday"] == periods.pday_of(GW_EDGE_TS * 1000, fallback)


@pytest.fixture()
def client(monkeypatch):
    import app as app_module

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": "msg_1", "type": "message",
                                         "role": "assistant", "content": [],
                                         "model": "claude-haiku-4-5"})

    monkeypatch.setattr(app_module, "_client",
                        httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    from fastapi.testclient import TestClient
    return TestClient(app_module.app)
