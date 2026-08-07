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

import json
import math
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import periods  # noqa: E402
import reporting  # noqa: E402
import store  # noqa: E402

TZ = "UTC"
NOW = 1786112520000          # 2026-08-06T14:22:00Z — fixed, so the ladder is stable
DAY = 86400000


# ---------------------------------------------------------------------------
# fixture plumbing
# ---------------------------------------------------------------------------

def ev(idx, *, ts, served="claude-sonnet-5", base="claude-opus-5", conf="estimated",
       prov="transcript", session="rpt-session", in_tok=10000, out_tok=2000,
       elig=True, status=200, harness="claude-code", pday=None, cr=0, reason=""):
    return {
        "v": 1, "id": f"rid:req_rpt{idx:04d}", "rev": 1,
        "w": "gw" if prov == "gateway" else "cli", "inst": "testinst",
        "ts": ts, "tzo": 0, "pday": pday if pday is not None else periods.pday_of(ts, 0),
        "ingested_at": ts, "prov": prov,
        "usrc": "body", "conf": conf, "harness": harness,
        "sessions": [session], "sess": session, "sub": False,
        "served": served, "req": None, "base": base, "bsrc": "tx_session_ceiling",
        "elig": elig, "ctier": "sonnet", "cver": 3, "reason": reason,
        "in": in_tok, "out": out_tok, "cr": cr, "c5": 0, "c1": 0, "cu": 0,
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
    assert rep["events"] == {"measured": 0, "estimated": 2}
    assert rep["unpriced"] == {"served_not_in_catalog": 1}
    assert "dollars_suppressed" in rep["labels"]
    note = " ".join(rep["notes"])
    assert "1 of 3 call(s) in this window" in note, "the note must be per-window and specific"
    assert "llama-4-maverick" in note, "name the models that cannot be priced"
    assert "Call and token counts are exact." in note
    assert "cheaper update" in note


def test_a_window_that_is_one_hundred_percent_unpriced_still_reports_its_counts(events_dir):
    """A window holding a single 429 and nothing else must say "1 call, 0 priced" rather
    than going blank. Blanking throws away a fact in order to hide an uncertainty."""
    write_segment(events_dir, [ev(1, ts=NOW - DAY, status=429)])
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    rows = rows_from(events_dir)
    rep = reporting.report_window(rows, NOW - 2 * DAY, NOW, store.load_state(), TZ)
    assert rep["status"] == "suppressed"
    assert rep["unpriced"] == {"non_2xx": 1}
    assert rep["events"] == {"measured": 0, "estimated": 0}
    assert rep["unpriced_calls"] == 1
    assert rep["measured"]["saved"] is None and rep["estimated"]["saved"] is None
    assert "1 of 1 call(s) in this window (100% of its tokens)" in " ".join(rep["notes"])


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
#   from / to                         epoch-ms window bounds, not quantities;
#   unpriced_ratio                    a proportion in [0,1], not a quantity.
_NOT_A_CROSS_BASIS_SUM = {"unpriced_calls", "unpriced_tokens", "undated", "tombstones",
                          "from", "to", "unpriced_ratio"}


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
    write_segment(events_dir,
                  [ev(1, ts=NOW - 3600000, conf="measured"),
                   ev(2, ts=NOW - 3601000, conf="estimated"),
                   ev(3, ts=NOW - 3602000, conf="estimated")])
    write_state(events_dir, [{"kind": "observed", "from": 0, "to": NOW + DAY}])
    body = client.get("/api/v1/reports/periods",
                      params={"session": "rpt-session", "tz": TZ},
                      headers=auth_headers).json()
    today = [p for p in body["periods"] if p["key"] == "today"][0]
    assert today["events"] == {"measured": 1, "estimated": 2}
    assert "count" not in today and "calls" not in today


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
