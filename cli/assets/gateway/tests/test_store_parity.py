"""CROSS-RUNTIME PARITY: the Python reader must agree with the Node reader to the cent.

``cli/src/peek/derive.js`` and ``gateway/app/store.py`` answer the same question about
the same append-only log. Two readers that disagree produce double-counting that looks
exactly like the three prior mispricing incidents -- and the drift is silent, because
each surface looks internally consistent.

So both runtimes are EXECUTED over ``cli/test/fixtures/golden-events.json``, projected
onto one canonical shape, rounded to 10 decimal places, serialised with sorted keys and
no whitespace, and compared BYTE FOR BYTE. A divergence FAILS. It does not warn, it is
not tolerated within an epsilon, and it is not skipped.

``metrics.py:75-80`` and ``scan.js:15-18`` already carry a "MUST mirror verbatim"
comment; this is the executable version of that comment for a much larger contract.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import store  # noqa: E402

# The tests directory is reached through a symlink (`gateway/` -> `cli/assets/gateway`),
# so resolve() first: plain `../../..` from the symlinked path lands outside the repo.
_HERE = Path(__file__).resolve().parent
REPO = _HERE.parents[3]
FIXTURE = REPO / "cli" / "test" / "fixtures" / "golden-events.json"
DERIVE_JS = REPO / "cli" / "src" / "peek" / "derive.js"
RECONCILE_JS = REPO / "cli" / "src" / "peek" / "reconcile.js"

# The JS half of the harness. Kept inline so the contract and its executor cannot drift
# into separate files with separate lifetimes.
_NODE_HARNESS = r"""
const fs = require('fs');
const derive = require(process.argv[1]);
const reconcile = require(process.argv[2]);
const fx = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const evs = fx.events;

// Ten decimal places, as a STRING. Comparing formatted decimals rather than doubles
// removes every shortest-round-trip and exponent-threshold difference between the two
// runtimes' number printers. `-0` and values that round to zero from below normalise
// to a plain zero, which JS's toFixed already does and Python's format does not.
function n(x) {
  if (x === null || x === undefined) return null;
  if (typeof x !== 'number' || !isFinite(x)) return null;
  let s = x.toFixed(10);
  if (/^-0\.0+$/.test(s)) s = s.slice(1);
  return s;
}
function acc(a) {
  return { saved: n(a.saved), spent: n(a.spent), baseline: n(a.baseline),
           tokens: a.tokens, calls: a.calls, credited: a.credited,
           offset: a.offset, gross: n(a.gross), extra: n(a.extra) };
}

const d = evs.map(function (e) {
  const r = derive.deriveRow(e);
  return { priceable: !!r.priceable, reason: r.reason || '', spent: n(r.spent),
           baseline: n(r.baseline), delta: n(r.delta), tokens: r.tokens || 0,
           pday: (r.pday === undefined ? null : r.pday) };
});

const f = derive.foldRows(evs);
const fr = { measured: acc(f.measured), estimated: acc(f.estimated),
             unpriced: f.unpriced, unpriced_calls: f.unpricedCalls,
             unpriced_tokens: f.unpricedTokens, unpriced_ratio: n(f.unpricedRatio),
             dollars_suppressed: !!f.dollarsSuppressed };

const g = reconcile.fold(evs);
const s = g.stats;
const fold = {
  stats: { input: s.input, folded: s.folded, weak_both: s.weakBoth,
           weak_served_conflict: s.weakServedConflict, pre_migration: s.preMigration,
           stale_writer: s.staleWriter, outlier_2x: s.outlier2x,
           field_conflicts: s.fieldConflicts, quarantined: s.quarantined },
  // Compared as a SET: JS sorts the folded rows with localeCompare, whose ICU collation
  // is not code-point order, and the row ORDER is not part of this contract.
  ids: g.rows.map(function (r) { return String(r.id); }).sort()
};

process.stdout.write(JSON.stringify({ derive: d, fold_rows: fr, fold: fold }));
"""

_ZERO = re.compile(r"^-0\.0+$")


def _n(x):
    """The Python half of the same projection. Must stay identical to `n()` above."""
    if x is None or isinstance(x, bool):
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    s = f"{f:.10f}"
    if _ZERO.match(s):
        s = s[1:]
    return s


def _acc(a):
    return {"saved": _n(a["saved"]), "spent": _n(a["spent"]),
            "baseline": _n(a["baseline"]), "tokens": a["tokens"], "calls": a["calls"],
            "credited": a["credited"], "offset": a["offset"],
            "gross": _n(a["gross"]), "extra": _n(a["extra"])}


def _canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


@pytest.fixture(scope="module")
def events():
    with FIXTURE.open(encoding="utf-8") as fh:
        return json.load(fh)["events"]


@pytest.fixture(scope="module")
def python_side(events):
    derived = []
    for e in events:
        d = store.derive_row(e)
        derived.append({"priceable": bool(d["priceable"]), "reason": d["reason"] or "",
                        "spent": _n(d["spent"]), "baseline": _n(d["baseline"]),
                        "delta": _n(d["delta"]), "tokens": d["tokens"] or 0,
                        "pday": d["pday"] if d["pday"] is not None else None})
    f = store.fold_rows(events)
    g = store.fold(events)
    return {
        "derive": derived,
        "fold_rows": {
            "measured": _acc(f["measured"]), "estimated": _acc(f["estimated"]),
            "unpriced": f["unpriced"], "unpriced_calls": f["unpriced_calls"],
            "unpriced_tokens": f["unpriced_tokens"],
            "unpriced_ratio": _n(f["unpriced_ratio"]),
            "dollars_suppressed": bool(f["dollars_suppressed"]),
        },
        "fold": {"stats": g["stats"],
                 "ids": sorted(str(r["id"]) for r in g["rows"])},
    }


@pytest.fixture(scope="module")
def node_side():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH — the cross-runtime parity gate cannot run")
    proc = subprocess.run(
        [node, "-e", _NODE_HARNESS, str(DERIVE_JS), str(RECONCILE_JS), str(FIXTURE)],
        capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, f"node harness failed:\n{proc.stderr}"
    return json.loads(proc.stdout)


# ---------------------------------------------------------------------------
# the gate
# ---------------------------------------------------------------------------

def test_fixture_covers_every_named_case(events):
    """The fixture is the contract. A shrunken fixture is a silently weakened gate."""
    assert len(events) >= 25, "the golden fixture must carry at least 25 events"
    served = {e.get("served") for e in events}
    bases = {e.get("base") for e in events}
    assert "claude-fable-5" in served and "claude-opus-5" in bases, "negative-delta case"
    assert "llama-4-maverick" in served, "unpriceable served model"
    assert "llama-4-maverick" in bases, "unpriceable baseline"
    assert any(e.get("pday") == "2026-08-31" and e.get("served") == "claude-sonnet-5"
               for e in events), "promotional-window row"
    assert any(int(e.get("status") or 0) >= 300 for e in events), "non-2xx row"
    assert any(e.get("elig") is False for e in events), "elig:false row"
    assert any(not e.get("pday") for e in events), "undated row"
    assert any(e.get("speed") == "fast" for e in events), "speed SKU row"
    assert any(e.get("svc") == "batch" for e in events), "batch SKU row"
    assert any((e.get("cr") or 0) > 100000 for e in events), "cache-heavy row"
    assert any((e.get("in") or 0) > 200000 for e in events), "long-context row"
    ids = [e["id"] for e in events]
    assert len(ids) != len(set(ids)), "duplicate strong id"
    weak = [i for i in ids if i.startswith("wk:")]
    assert len(weak) != len(set(weak)), "weak-key pair"
    assert any(e.get("source_mask") for e in events), "weak-key BOTH-source (case 3)"


def test_the_fold_exercises_every_quarantine_branch(python_side):
    """A parity gate over branches that never fire proves nothing. Each of these is a
    "report nothing rather than risk a double count" case from spec §4."""
    s = python_side["fold"]["stats"]
    assert s["pre_migration"] >= 1, "case 5 — gateway row with no request id"
    assert s["weak_served_conflict"] >= 1, "case 4 — weak key, disagreeing `served`"
    assert s["outlier_2x"] >= 1, "case 15 — same strong key, >2x output"
    assert s["weak_both"] >= 1, "case 3 — weak-key BOTH-source join"
    assert s["folded"] < s["input"], "the quarantines must actually remove rows"


def test_derive_row_is_byte_identical_across_runtimes(python_side, node_side, events):
    py = _canonical(python_side["derive"])
    js = _canonical(node_side["derive"])
    if py != js:
        # Name the first divergent row rather than dumping 31 objects at the reader.
        for i, (a, b) in enumerate(zip(python_side["derive"], node_side["derive"])):
            if _canonical(a) != _canonical(b):
                raise AssertionError(
                    f"derive_row diverged at event {i} (id={events[i].get('id')}, "
                    f"served={events[i].get('served')}, base={events[i].get('base')}, "
                    f"pday={events[i].get('pday')})\n"
                    f"  python: {_canonical(a)}\n  node:   {_canonical(b)}")
        raise AssertionError(f"derive_row row COUNT diverged: "
                             f"python={len(python_side['derive'])} "
                             f"node={len(node_side['derive'])}")
    assert py == js


def test_fold_rows_is_byte_identical_across_runtimes(python_side, node_side):
    py = _canonical(python_side["fold_rows"])
    js = _canonical(node_side["fold_rows"])
    assert py == js, f"foldRows diverged\n  python: {py}\n  node:   {js}"


def test_reconciliation_fold_agrees_on_quarantines_and_survivors(python_side, node_side):
    """Not required to be byte-identical row-for-row (the merged row carries `undefined`
    in JS where Python carries `None`), but the quarantine COUNTERS and the surviving id
    set are the part that decides money, and those must match exactly."""
    assert _canonical(python_side["fold"]["stats"]) == _canonical(node_side["fold"]["stats"])
    assert python_side["fold"]["ids"] == node_side["fold"]["ids"]


# ---------------------------------------------------------------------------
# Python-side properties the parity gate would not catch on its own
# (both runtimes could be identically wrong)
# ---------------------------------------------------------------------------

def _by_id(events, row_id):
    return [e for e in events if e["id"] == row_id]


def test_the_promotional_window_is_evaluated_at_the_ROWS_OWN_DAY(events):
    """claude-sonnet-5's launch pricing ($2/$10) ends 2026-08-31. The row on 08-31 must
    price at the promo and the row on 09-01 at the standard $3/$15, with no catalog
    change and no code change. Resolving at "today" instead is how an already-read
    period silently restates itself."""
    promo = store.derive_row(_by_id(events, "rid:req_0100000000000000000000a2")[0])
    after = store.derive_row(_by_id(events, "rid:req_0100000000000000000000a3")[0])
    # 100k in + 20k out: promo 0.1*2 + 0.02*10 = 0.40 ; standard 0.1*3 + 0.02*15 = 0.60
    assert promo["spent"] == pytest.approx(0.40, abs=1e-9)
    assert after["spent"] == pytest.approx(0.60, abs=1e-9)
    assert after["spent"] > promo["spent"]


def test_a_costlier_route_produces_a_NEGATIVE_delta_never_a_zero(events):
    d = store.derive_row(_by_id(events, "rid:req_0100000000000000000000a8")[0])
    assert d["priceable"] is True
    assert d["delta"] < 0, "claude-fable-5 costs more than claude-opus-5; the sign must survive"
    assert d["delta"] == pytest.approx(d["baseline"] - d["spent"], abs=1e-12)


def test_an_unpriceable_row_is_LABELLED_and_contributes_nothing(events):
    served = store.derive_row(_by_id(events, "rid:req_0100000000000000000000a4")[0])
    base = store.derive_row(_by_id(events, "rid:req_0100000000000000000000a5")[0])
    assert served["priceable"] is False and served["reason"] == "served_not_in_catalog"
    assert served["spent"] is None and served["delta"] is None
    assert base["priceable"] is False and base["reason"] == "baseline_not_in_catalog"
    # The unpriceable row is never $0.00. Zero is a measured result.
    assert base["delta"] is None


def test_a_non_2xx_row_is_recorded_but_never_priced(events):
    d = store.derive_row(_by_id(events, "rid:req_0100000000000000000000a6")[0])
    assert d["priceable"] is False and d["reason"] == "non_2xx"
    assert d["tokens"] == 22000, "its tokens are still counted; only its dollars are not"


def test_an_ineligible_row_has_spend_but_no_saving(events):
    d = store.derive_row(_by_id(events, "rid:req_0100000000000000000000a7")[0])
    assert d["priceable"] is True
    assert d["spent"] > 0 and d["baseline"] > 0
    assert d["delta"] == 0


def test_status_zero_means_unknown_not_failed(events):
    d = store.derive_row(_by_id(events, "rid:req_0100000000000000000000c1")[0])
    assert d["priceable"] is True, "status 0 is 'nobody recorded it', not 'it failed'"


def test_the_two_bases_are_never_combined_by_fold_rows(events):
    f = store.fold_rows(events)
    assert f["measured"]["calls"] > 0 and f["estimated"]["calls"] > 0
    combined = {"total", "all", "combined", "saved", "spent", "calls", "tokens",
                "overall", "sum"}
    assert not (set(f) & combined), (
        "fold_rows must expose no key that could hold a cross-basis figure; "
        f"found {sorted(set(f) & combined)}")


def test_partial_trailing_line_is_skipped_and_counted(tmp_path):
    """A segment can be appended to WHILE it is being read. The half-written last record
    must be skipped AND counted -- a silently dropped tail is indistinguishable from
    'there was no activity'."""
    seg = tmp_path / "2026-08.9a41c0d7.cli.jsonl"
    seg.write_text(
        json.dumps({"v": 1, "id": "rid:a", "ts": 1}) + "\n"
        + json.dumps({"v": 1, "id": "rid:b", "ts": 2}) + "\n"
        + '{"v":1,"id":"rid:c","ts":3,"in":99',                 # torn mid-record
        encoding="utf-8")
    seen = []
    stats = store.read_segment(str(seg), seen.append)
    assert stats["rows"] == 2 and stats["partial_tail"] == 1
    assert [r["id"] for r in seen] == ["rid:a", "rid:b"]


def test_a_future_schema_row_is_refused_and_counted_never_read_as_absent(tmp_path):
    seg = tmp_path / "2026-08.9a41c0d7.cli.jsonl"
    seg.write_text(
        json.dumps({"v": 1, "id": "rid:a", "ts": 1}) + "\n"
        + json.dumps({"v": 2, "id": "rid:future", "ts": 2}) + "\n",
        encoding="utf-8")
    seen = []
    stats = store.read_segment(str(seg), seen.append)
    assert stats["future_schema"] == 1 and stats["rows"] == 1
    assert [r["id"] for r in seen] == ["rid:a"]


def test_a_synced_folders_conflicted_copy_is_READ_not_ignored(tmp_path, monkeypatch):
    """The reader globs `*.jsonl` deliberately. A sync client's '(conflicted copy)' file
    is a whole month of a second machine's events; an exact-name lookup never opens it
    and the month silently vanishes."""
    monkeypatch.setenv("CHEAPER_EVENTS_DIR", str(tmp_path))
    (tmp_path / "2026-08.9a41c0d7.cli.jsonl").write_text(
        json.dumps({"v": 1, "id": "rid:a", "ts": 1}) + "\n", encoding="utf-8")
    (tmp_path / "2026-08.9a41c0d7.cli (conflicted copy 2026-08-06).jsonl").write_text(
        json.dumps({"v": 1, "id": "rid:b", "ts": 2}) + "\n", encoding="utf-8")
    (tmp_path / "2026-08.9a41c0d7.gw.jsonl").write_text(
        json.dumps({"v": 1, "id": "rid:c", "ts": 3}) + "\n", encoding="utf-8")
    names = {s["name"] for s in store.list_segments()}
    assert len(names) == 3
    writers = {s["name"]: s["writer"] for s in store.list_segments()}
    assert writers["2026-08.9a41c0d7.gw.jsonl"] == "gw"
    assert writers["2026-08.9a41c0d7.cli.jsonl"] == "cli"
    got = store.read_all()
    assert {r["id"] for r in got["rows"]} == {"rid:a", "rid:b", "rid:c"}
