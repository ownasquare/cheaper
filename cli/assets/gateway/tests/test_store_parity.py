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

import gzip
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

import pricing  # noqa: E402
import store  # noqa: E402

# The tests directory is reached through a symlink (`gateway/` -> `cli/assets/gateway`),
# so resolve() first: plain `../../..` from the symlinked path lands outside the repo.
_HERE = Path(__file__).resolve().parent
REPO = _HERE.parents[3]
FIXTURE = REPO / "cli" / "test" / "fixtures" / "golden-events.json"
DERIVE_JS = REPO / "cli" / "src" / "peek" / "derive.js"
RECONCILE_JS = REPO / "cli" / "src" / "peek" / "reconcile.js"
EVENTS_JS = REPO / "cli" / "src" / "peek" / "events.js"
STORE_JS = REPO / "cli" / "src" / "peek" / "store.js"
PRICING_JS = REPO / "cli" / "src" / "peek" / "pricing.js"
CLASSIFY_JS = REPO / "cli" / "src" / "peek" / "classify.js"

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
             // ROWS SEEN per basis. Diffed byte-for-byte because this field is published
             // under ONE name by both runtimes to the same consumers, and it meant ROWS
             // PRICED on the Python side while meaning ROWS SEEN here.
             events: { measured: f.events.measured, estimated: f.events.estimated },
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
            "events": {"measured": f["events"]["measured"],
                       "estimated": f["events"]["estimated"]},
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

    # THE CACHE-STATE PAIR, asserted by PREDICATE rather than by id.
    #
    # For its whole prior life the byte-for-byte gate below passed on ABSENT COVERAGE:
    # every switched fixture row that carried a cache write ALSO carried a cache read, so
    # the cold-start branch never fired on either side and a rule that was live in
    # `derive.js` and missing in `store.py` still diffed clean. That is luck, not
    # coverage, and luck is exactly what a gate is supposed to replace.
    #
    # By predicate and not by id, because an edit that keeps `rid:...c7` but adds a cache
    # read to it -- or drops its write -- restores the hole while every id-based
    # assertion still passes.
    def _switched_with_a_write(e):
        served, base = e.get("served"), e.get("base")
        if not served or not base or str(served) == str(base):
            return False
        return (e.get("c5") or 0) + (e.get("c1") or 0) + (e.get("cu") or 0) > 0

    cold = [e for e in events if _switched_with_a_write(e) and not (e.get("cr") or 0)]
    warm = [e for e in events if _switched_with_a_write(e) and (e.get("cr") or 0) > 0]
    assert cold, ("cold-start-after-switch row — the WITHHOLD branch of "
                  "cache_state_indeterminate is unreachable without one")
    assert warm, ("warm switched row — the KEEP-THE-CREDIT branch is unreachable "
                  "without one")
    # ...and the withhold branch must be reachable on a row that would OTHERWISE have
    # been priced, or it withholds nothing that was ever at stake.
    assert any(e.get("elig") is True and 200 <= int(e.get("status") or 0) < 300
               and e.get("pday") for e in cold), (
        "the cold row must be eligible, 2xx and dated — otherwise an earlier refusal "
        "reaches it first and the cache-state branch is still never executed")


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
    # `events` is a PAIR, never a scalar — the two bases stay apart in the seen counter
    # exactly as they do in the accumulators.
    assert set(f["events"]) == {"measured", "estimated"}


def test_fold_rows_counts_rows_SEEN_separately_from_rows_PRICED(events):
    """The golden fixture contains unpriceable rows by construction (see
    `test_fixture_covers_every_named_case`), so `events` must exceed `calls` on at least
    one basis. If it did not, the two fields would be interchangeable and the
    cross-runtime diff of `events` would be decorative."""
    f = store.fold_rows(events)
    seen = f["events"]["measured"] + f["events"]["estimated"]
    priced = f["measured"]["calls"] + f["estimated"]["calls"]
    assert seen == len(events), "every row is counted once, on exactly one basis"
    assert seen - priced == f["unpriced_calls"] > 0, (
        "rows SEEN minus rows PRICED is exactly the visible exclusion counter")


# ---------------------------------------------------------------------------
# the counterfactual arm's prompt-cache state — the THIRD reader of the rule
# ---------------------------------------------------------------------------

_CACHE_CTX = {"speed": None, "service_tier": "standard", "at": "2026-08-10"}


def test_a_cold_start_after_a_switch_is_WITHHELD_by_the_event_store_reader(events):
    """``store.py::derive_row`` is the third reader of this question -- ``derive.js``
    reads the same log for the CLI, ``metrics.py`` reads the gateway's SQLite ledger,
    and this one reads the EVENT STORE. While it lacked the rule the CLI withheld rows
    that ``reporting.py`` still published: the two runtimes disagreeing about money,
    which is strictly worse than both being wrong the same way, because each surface
    stays internally consistent and nothing surfaces the gap.

    The interval is proven from the PRICER here rather than asserted from memory, so the
    test states why the row is unpublishable instead of merely pinning that it is.
    """
    row = _by_id(events, "rid:req_0100000000000000000000c7")[0]
    assert (row["cr"], row["c5"], row["served"] != row["base"]) == (0, 200000, True)

    # 200k written from scratch on the routed model, nothing read: the switched arm was
    # COLD. What the un-switched baseline would have paid is the whole question.
    spent = pricing.cost_of_model("claude-haiku-4-5", in_tok=0, out_tok=1000,
                                  cache_read=0, cache_create_5m=200000,
                                  cache_create_1h=0, **_CACHE_CTX)
    base_if_cold = pricing.cost_of_model("claude-opus-5", in_tok=0, out_tok=1000,
                                         cache_read=0, cache_create_5m=200000,
                                         cache_create_1h=0, **_CACHE_CTX)
    base_if_warm = pricing.cost_of_model("claude-opus-5", in_tok=0, out_tok=1000,
                                         cache_read=200000, cache_create_5m=0,
                                         cache_create_1h=0, **_CACHE_CTX)
    # DIRECTION: pricing the baseline on the served arm's split can only move it UP.
    # Every catalog entry prices a write at or above a read, so the shipped figure was
    # biased in exactly one direction -- it never understated.
    assert base_if_cold > base_if_warm
    # ...and the interval STRADDLES ZERO. This is not a rounding difference: the same
    # bytes support a claim of +$1.02 saved and an anti-saving of -$0.13.
    assert base_if_cold - spent > 0, "the un-withheld figure claims a saving"
    assert base_if_warm - spent < 0, "the honest alternative is an anti-saving"

    d = store.derive_row(row)
    assert d["priceable"] is False
    assert d["reason"] == "cache_state_indeterminate", (
        "the label is compared byte-for-byte against derive.js and reaches the UI and "
        "the export; a different string is a different divergence")
    assert d["delta"] is None, "a withheld claim is null, never 0"
    assert d["baseline"] is None, "the indeterminate figure is not published"
    assert d["tokens"] == 201000, "the TOKENS are not in doubt and are still counted"


def test_a_WARM_switched_call_keeps_its_credit(events):
    """The over-correction is the mirror-image fabrication, and it would be larger: in
    the author's 22,481-row snapshot 3,301 of the 3,380 switched cache-bearing rows were
    warm, carrying $156.03 of correctly-earned credit against the $14.13 at issue.

    A cache write on a WARM arm is content appended since the previous turn -- content
    the baseline model would have had to create too -- so the served split IS the
    counterfactual split and the existing pricing is exactly right.
    """
    d = store.derive_row(_by_id(events, "rid:req_0100000000000000000000c8")[0])
    assert d["priceable"] is True, d["reason"]
    assert d["reason"] == ""
    assert d["spent"] == pytest.approx(0.05, abs=1e-9)
    assert d["baseline"] == pytest.approx(0.25, abs=1e-9)
    assert d["delta"] == pytest.approx(0.20, abs=1e-9)


def test_NO_OP_GUARD_a_session_that_never_switches_is_unchanged_TO_THE_CENT(events):
    """The load-bearing half of the rule. The identical cold 200k write, but the call ran
    ON the baseline: nothing was invalidated because nothing was switched, both arms are
    the same model on the same split, and the delta is zero under EVERY cache assumption.

    A guard that fired here would manufacture an anti-saving on 14,902 of the author's
    18,285 eligible rows -- vastly more money than the defect it fixes, moved in the
    opposite direction. The switch test is what confines the withholding to rows whose
    counterfactual is genuinely unknowable.
    """
    cold = _by_id(events, "rid:req_0100000000000000000000c7")[0]
    for elig in (True, False):
        row = dict(cold, served="claude-opus-5", base="claude-opus-5", elig=elig)
        d = store.derive_row(row)
        assert d["priceable"] is True, f"elig={elig}: {d['reason']}"
        assert d["reason"] == ""
        assert d["spent"] == pytest.approx(1.275, abs=1e-9)
        assert d["baseline"] == pytest.approx(1.275, abs=1e-9)
        assert d["delta"] == 0, "a no-op must stay a no-op"

    # The other three ways out of the predicate, each its own labelled case rather than a
    # cache withholding: no write at all, no baseline, and a switch that read its cache.
    no_write = store.derive_row(dict(cold, c5=0))
    assert no_write["priceable"] is True and no_write["reason"] == ""
    no_base = store.derive_row(dict(cold, base=None))
    assert no_base["reason"] == "no_baseline", "no baseline is its own labelled case"
    warm = store.derive_row(dict(cold, cr=1))
    assert warm["priceable"] is True, "ONE read is still a warm arm"


def test_the_withheld_row_is_COUNTED_and_enters_no_accumulator(events):
    """Invariant 4 end to end: the exclusion is VISIBLE, not a quietly smaller total.

    The withheld row is still SEEN, its tokens are still counted, and its dollars reach
    neither accumulator -- so ``spent`` keeps covering exactly the rows reported as
    priced, and a reader can see how much was withheld instead of inferring it.
    """
    cold = _by_id(events, "rid:req_0100000000000000000000c7")[0]
    warm = _by_id(events, "rid:req_0100000000000000000000c8")[0]
    f = store.fold_rows([cold, warm])
    assert f["unpriced"] == {"cache_state_indeterminate": 1}
    assert f["unpriced_calls"] == 1
    assert f["events"]["estimated"] == 2, "both rows were SEEN; only one was priced"
    assert f["estimated"]["calls"] == 1
    assert f["estimated"]["saved"] == pytest.approx(0.20, abs=1e-9)
    assert f["estimated"]["spent"] == pytest.approx(0.05, abs=1e-9)
    assert f["unpriced_tokens"] == 201000

    # And the whole-fixture fold agrees: the reason appears exactly where the rows are.
    whole = store.fold_rows(events)
    assert whole["unpriced"]["cache_state_indeterminate"] == 1


def test_the_cache_state_predicate_itself_agrees_with_derive_js():
    """The predicate, over the coercion states the two languages disagree about.

    ``test_derive_row_is_byte_identical_across_runtimes`` gates the rule as WIRED into
    the pricer; this gates the rule ITSELF, including the inputs no fixture row can
    reach -- a string token count (JS coerces numerically, Python's ``>`` would raise), a
    boolean, a null model id. ``store.py`` mirrors ``metrics.py``'s predicate, and both
    mirror ``derive.js``; a gate over only one of the three leaves two free to drift.
    """
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH — the cross-runtime parity gate cannot run")
    # served, base, cache_read, cache_create
    cases = [
        ["claude-haiku-4-5", "claude-opus-5", 0, 200000],    # cold switch -> withhold
        ["claude-haiku-4-5", "claude-opus-5", 200000, 20000],  # warm switch -> price
        ["claude-haiku-4-5", "claude-opus-5", 1, 200000],      # ONE read is still warm
        ["claude-haiku-4-5", "claude-opus-5", 0, 0],           # no cache at all
        ["claude-opus-5", "claude-opus-5", 0, 200000],         # NO SWITCH -> price
        ["claude-opus-5", None, 0, 200000],                    # no baseline
        [None, "claude-opus-5", 0, 200000],                    # no served model
        ["claude-opus-5", "", 0, 200000],                      # empty baseline
        ["claude-haiku-4-5", "claude-opus-5", 0, 1],           # smallest write
        ["claude-haiku-4-5", "claude-opus-5", "0", "200000"],  # numeric strings
        ["claude-haiku-4-5", "claude-opus-5", None, 200000],   # absent read field
        ["claude-haiku-4-5", "claude-opus-5", 0, "not-a-number"],  # NaN write
        ["claude-haiku-4-5", "claude-opus-5", False, True],    # booleans
    ]
    harness = (
        "const d=require(process.argv[1]);"
        "const cs=JSON.parse(process.argv[2]);"
        "process.stdout.write(JSON.stringify("
        "cs.map(c=>d.cacheStateIndeterminate(c[0],c[1],c[2],c[3]))));"
    )
    proc = subprocess.run([node, "-e", harness, str(DERIVE_JS), json.dumps(cases)],
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    js = json.loads(proc.stdout)
    py = [store.cache_state_indeterminate(*c) for c in cases]
    assert js == py, f"cache-state rule diverged\n  node:   {js}\n  python: {py}"
    # A gate over a rule that never fires proves nothing: both answers must appear.
    assert True in py and False in py


# ---------------------------------------------------------------------------
# which strings name a CALENDAR DAY — asked of both runtimes, over the same inputs
# ---------------------------------------------------------------------------

# Every value here is a state the two runtimes coerce DIFFERENTLY by default, which is
# what makes the gate worth having rather than decorative:
#   '2026-13-45' / '2026-02-30'  Date.UTC ROLLS OVER into a perfectly good instant in the
#                                next month/year; Python's datetime() raises;
#   20260410                     a number, not a string — str()/String() both give eight
#                                characters, and `if not r["pday"]` accepted it as truthy;
#   '0001-01-01' / '0099-12-31'  Date.UTC maps a two-digit year onto 1900+y, so JS would
#                                have REFUSED a day Python accepts (the parity gate caught
#                                exactly this while this change was being written);
#   '0000-01-01'                 JS can represent year 0; Python's calendar starts at 1;
#   True / '' / None / ' 2026-08-05' / '2026-8-5'
#                                truthiness, whitespace and zero-padding.
_DAY_CASES = ["2026-08-05", "0001-01-01", "0099-12-31", "9999-12-31", "2024-02-29",
              "2026-02-29", "2026-13-45", "2026-02-30", "0000-01-01", "10000-01-01",
              "2026-8-5", "26-08-05", " 2026-08-05", "2026-08-05 ", "2026-08-05T00:00:00Z",
              "", "not-a-day", 20260410, 0, True, False, None, 2026.0]

_DAY_HARNESS = r"""
const derive = require(process.argv[1]);
const cases = JSON.parse(process.argv[2]);
const out = cases.map(function (c) {
  const ms = derive.isoDayMs(c);
  const d = derive.deriveRow({ pday: c, served: 'claude-haiku-4-5', base: 'claude-opus-5',
                               elig: true, status: 200, in: 1000, out: 1000, conf: 'estimated' });
  return { iso_day_ms: ms === null ? null : String(ms),
           priceable: !!d.priceable, reason: d.reason || '' };
});
process.stdout.write(JSON.stringify(out));
"""


def test_both_runtimes_refuse_exactly_the_same_malformed_pday():
    """A `pday` that names no representable calendar day must be refused by BOTH pricers,
    and a real day must be accepted by both.

    This is the same drift class as the window-placement divergence: `derive_row` prices
    off `pday`, so a day one runtime accepts and the other refuses is a row that carries
    dollars on one surface and none on the other. `cli/scripts/check-period-parity.js`
    gates the WINDOW consequences of that; this gates the predicate itself, over the exact
    coercion states the two languages disagree about.
    """
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH — the cross-runtime parity gate cannot run")
    proc = subprocess.run(
        [node, "-e", _DAY_HARNESS, str(DERIVE_JS), json.dumps(_DAY_CASES)],
        capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, f"node harness failed:\n{proc.stderr}"
    js = json.loads(proc.stdout)

    py = []
    for c in _DAY_CASES:
        ms = store.iso_day_ms(c)
        d = store.derive_row({"pday": c, "served": "claude-haiku-4-5",
                              "base": "claude-opus-5", "elig": True, "status": 200,
                              "in": 1000, "out": 1000, "conf": "estimated"})
        py.append({"iso_day_ms": None if ms is None else str(ms),
                   "priceable": bool(d["priceable"]), "reason": d["reason"] or ""})

    for i, case in enumerate(_DAY_CASES):
        assert _canonical(py[i]) == _canonical(js[i]), (
            f"the two runtimes disagree about pday={case!r}\n"
            f"  python: {_canonical(py[i])}\n  node:   {_canonical(js[i])}")

    # NON-VACUOUS on both halves: the fixture must contain days that ARE refused and days
    # that are NOT, or two identically-broken runtimes pass this test.
    assert sum(1 for r in py if r["priceable"]) >= 4, "real days must still price"
    refused = [r for r in py if not r["priceable"]]
    assert len(refused) >= 10
    assert all(r["reason"] == store.REASON_NO_TS for r in refused)


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


# ---------------------------------------------------------------------------
# a segment that could not be READ is COUNTED, not read as an empty month
# ---------------------------------------------------------------------------
#
# `read_segment` used to answer a single `except OSError: return stats` -- 0 rows, no
# label -- while `read_all` still incremented `segments`. "1 segment read, 0 rows" then
# meant EITHER "a genuinely quiet month" OR "a segment this process could not open", and
# nothing on any surface could tell them apart. Same class of silence as a dropped tail.
#
# The JS reader (`events.js::readSegment`) splits that catch into `unreadable` and
# `corrupt` and propagates both through `readAll`. These gates require this runtime to
# carry the SAME counters, under the SAME names, with the SAME values on the same bytes
# -- a Python-side counter named anything else would make the parity story a lie while
# every test still passed.

def _node(script: str, *args, env=None):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH — the cross-runtime parity gate cannot run")
    full = dict(os.environ)
    full.update(env or {})
    proc = subprocess.run([node, "-e", script, *[str(a) for a in args]],
                          capture_output=True, text=True, timeout=120, env=full)
    assert proc.returncode == 0, f"node harness failed:\n{proc.stderr}"
    return json.loads(proc.stdout)


_SEG_HARNESS = r"""
const events = require(process.argv[1]);
const files = JSON.parse(process.argv[2]);
const out = files.map(function (f) {
  let n = 0;
  const s = events.readSegment(f, function () { n++; });
  return { stats: s, delivered: n };
});
process.stdout.write(JSON.stringify(out));
"""

_CAMEL = re.compile(r"(?<!^)(?=[A-Z])")


def _snake(k: str) -> str:
    """`partialTail` -> `partial_tail`. The two runtimes differ in CASE convention by
    house style, and only in case: every counter must exist on both sides under the same
    word sequence, so this mapping is total and the key SETS must then match exactly."""
    return _CAMEL.sub("_", k).lower()


def _seg_fixture(tmp_path: Path) -> list:
    """One directory holding every disposition `read_segment` can reach."""
    good = tmp_path / "2026-08.9a41c0d7.cli.jsonl"
    good.write_text(
        json.dumps({"v": 1, "id": "rid:a", "ts": 1}) + "\n"
        + "not json at all\n"
        + json.dumps({"v": 2, "id": "rid:future", "ts": 2}) + "\n"
        + json.dumps({"v": 1, "id": "rid:b", "ts": 3}) + "\n"
        + '{"v":1,"id":"rid:torn"',                       # torn mid-record
        encoding="utf-8")

    # A DIRECTORY where a segment should be — a bad restore, a sync client, a name
    # collision. Chosen over chmod(0) deliberately: chmod is a no-op for root, which is
    # how most CI containers run, and a test that silently passes as root is not a gate.
    (tmp_path / "2026-07.9a41c0d7.cli.jsonl").mkdir()

    sealed = tmp_path / "2026-06.9a41c0d7.cli.jsonl.gz"
    sealed.write_bytes(gzip.compress(
        (json.dumps({"v": 1, "id": "rid:sealed", "ts": 4}) + "\n").encode("utf-8")))

    torn_gz = tmp_path / "2026-05.9a41c0d7.cli.jsonl.gz"
    torn_gz.write_bytes(gzip.compress(b'{"v":1,"id":"rid:x"}\n')[:12])

    empty = tmp_path / "2026-04.9a41c0d7.cli.jsonl"
    empty.write_text("", encoding="utf-8")

    return [str(good), str(tmp_path / "2026-07.9a41c0d7.cli.jsonl"), str(sealed),
            str(torn_gz), str(empty)]


def test_read_segment_stats_are_byte_identical_across_runtimes(tmp_path):
    files = _seg_fixture(tmp_path)
    js = _node(_SEG_HARNESS, EVENTS_JS, json.dumps(files))

    py = []
    for f in files:
        n = 0

        def _count(_o):
            nonlocal n
            n += 1

        py.append({"stats": store.read_segment(f, _count), "delivered": n})

    for i, f in enumerate(files):
        a = dict(py[i]["stats"])
        b = {_snake(k): v for k, v in js[i]["stats"].items()}
        assert _canonical(a) == _canonical(b), (
            f"read_segment diverged on {os.path.basename(f)}\n"
            f"  python: {_canonical(a)}\n  node:   {_canonical(b)}")
        assert py[i]["delivered"] == js[i]["delivered"], f
        # The two names this whole change exists for must be present VERBATIM, not
        # merely equal under the case mapping.
        assert "unreadable" in a and "unreadable" in js[i]["stats"]
        assert "corrupt" in a and "corrupt" in js[i]["stats"]

    # NON-VACUOUS: each of the five dispositions really fired, or the diff above compared
    # five identical zeroed dicts and proved nothing.
    s = [p["stats"] for p in py]
    assert s[0]["rows"] == 2 and s[0]["bad"] == 1 and s[0]["partial_tail"] == 1 \
        and s[0]["future_schema"] == 1
    assert s[1]["unreadable"] == 1 and s[1]["rows"] == 0
    assert s[2]["rows"] == 1, "a SEALED month must be read, not skipped"
    assert s[3]["corrupt"] == 1 and s[3]["rows"] == 0
    assert s[4] == {"rows": 0, "bad": 0, "partial_tail": 0, "future_schema": 0,
                    "bytes": 0, "unreadable": 0, "corrupt": 0}, \
        "an EMPTY month is all-zero — which is exactly why 'unreadable' cannot be one"


def test_an_unreadable_segment_is_distinguishable_from_a_quiet_one(tmp_path, monkeypatch):
    """The whole point, stated as the reader sees it: a month nobody could open and a
    month with nothing in it must not produce the same three numbers."""
    monkeypatch.setenv("CHEAPER_EVENTS_DIR", str(tmp_path))
    (tmp_path / "2026-08.9a41c0d7.cli.jsonl").write_text("", encoding="utf-8")
    quiet = store.read_all()
    assert quiet["stats"]["segments"] == 1 and quiet["stats"]["rows"] == 0
    assert quiet["stats"]["unreadable"] == 0 and quiet["stats"]["corrupt"] == 0

    (tmp_path / "2026-07.9a41c0d7.cli.jsonl").mkdir()
    (tmp_path / "2026-06.9a41c0d7.cli.jsonl.gz").write_bytes(b"\x1f\x8b\x08nonsense")
    got = store.read_all()
    assert got["stats"]["segments"] == 3, "the segment is still COUNTED"
    assert got["stats"]["rows"] == 0
    # ...and the two extra segments no longer look like two extra quiet months.
    assert got["stats"]["unreadable"] == 1, got["stats"]
    assert got["stats"]["corrupt"] == 1, got["stats"]


def test_read_all_stats_keys_match_the_js_reader(tmp_path, monkeypatch):
    """`read_all` must not absorb what `read_segment` labelled. `segments` is already
    incremented before the read, so a counter that stops at `read_segment` leaves the
    aggregate asserting exactly the thing the label exists to deny."""
    monkeypatch.setenv("CHEAPER_EVENTS_DIR", str(tmp_path))
    _seg_fixture(tmp_path)
    py = store.read_all()["stats"]
    js = _node(
        r"""
        const events = require(process.argv[1]);
        process.stdout.write(JSON.stringify(events.readAll({ dir: process.argv[2] }).stats));
        """,
        EVENTS_JS, str(tmp_path))
    assert _canonical(py) == _canonical({_snake(k): v for k, v in js.items()}), (
        f"read_all stats diverged\n  python: {_canonical(py)}\n"
        f"  node:   {_canonical({_snake(k): v for k, v in js.items()})}")
    assert py["unreadable"] == 1 and py["corrupt"] == 1, py


def test_a_sealed_gateway_month_keeps_its_writer(tmp_path, monkeypatch):
    """`.gw.jsonl.gz`, not just `.gw.jsonl`. `writer` is what `fold`'s stale-writer
    quarantine keys on, so a sealed gateway month attributed to the CLI is a row that
    survives a quarantine it should not have."""
    monkeypatch.setenv("CHEAPER_EVENTS_DIR", str(tmp_path))
    body = (json.dumps({"v": 1, "id": "rid:g", "ts": 1}) + "\n").encode("utf-8")
    (tmp_path / "2026-08.9a41c0d7.gw.jsonl.gz").write_bytes(gzip.compress(body))
    (tmp_path / "2026-08.9a41c0d7.cli.jsonl.gz").write_bytes(gzip.compress(
        (json.dumps({"v": 1, "id": "rid:c", "ts": 2}) + "\n").encode("utf-8")))
    writers = {s["name"]: s["writer"] for s in store.list_segments()}
    assert writers["2026-08.9a41c0d7.gw.jsonl.gz"] == "gw"
    assert writers["2026-08.9a41c0d7.cli.jsonl.gz"] == "cli"
    got = store.read_all()
    assert {r["id"]: r["_w"] for r in got["rows"]} == {"rid:g": "gw", "rid:c": "cli"}


def test_a_non_utf8_byte_does_not_take_the_whole_read_down(tmp_path, monkeypatch):
    """`open(..., encoding='utf-8')` raises UnicodeDecodeError -- a ValueError, NOT an
    OSError -- so a single stray byte escaped the guard and propagated out of
    `read_all`, out of `unified_rows`, and out of the reporting endpoint. The CLI reads
    the same file and merely mangles one line."""
    monkeypatch.setenv("CHEAPER_EVENTS_DIR", str(tmp_path))
    seg = tmp_path / "2026-08.9a41c0d7.cli.jsonl"
    seg.write_bytes(
        json.dumps({"v": 1, "id": "rid:a", "ts": 1}).encode("utf-8") + b"\n"
        + b"\xff\n"
        + json.dumps({"v": 1, "id": "rid:b", "ts": 2}).encode("utf-8") + b"\n")
    got = store.read_all()                       # must not raise
    assert {r["id"] for r in got["rows"]} == {"rid:a", "rid:b"}
    assert got["stats"]["bad"] == 1, "the mangled line is COUNTED, not silently skipped"
    assert got["stats"]["unreadable"] == 0, "a mangled line is not an unopenable file"


# ---------------------------------------------------------------------------
# state.json: ABSENT vs UNREADABLE vs TOO NEW, kept distinct in both runtimes
# ---------------------------------------------------------------------------
#
# One `except (OSError, ValueError)` returning an empty document collapsed three claims
# with opposite consequences. The dangerous one is UNREADABLE: that file holds the
# `cheaper forget` TOMBSTONES, so reading it as "no tombstones" silently RE-ADMITS data
# the user asked to have removed, and the totals simply go back up.

_STATE_HARNESS = r"""
const store = require(process.argv[1]);
const st = store.loadState();
process.stdout.write(JSON.stringify({
  unreadable: st.unreadable === undefined ? null : String(st.unreadable),
  too_new: !!st.tooNew,
  coverage: (st.coverage || []).length,
  tombstones: (st.tombstones || []).length,
}));
"""


def _py_state():
    st = store.load_state()
    return {"unreadable": None if st.get("unreadable") is None else str(st["unreadable"]),
            "too_new": bool(st.get("too_new")),
            "coverage": len(st.get("coverage") or []),
            "tombstones": len(st.get("tombstones") or [])}


_TOMB = {"session": "sess-deleted", "at": 1786000000000}

# (label, what to write at <dir>/state.json, the disposition BOTH runtimes must reach)
_STATE_CASES = [
    ("absent", None, {"unreadable": None, "too_new": False}),
    ("unparseable", b'{"v":1,"tombstones":[{"session":"sess-del"',
     {"unreadable": "unparseable", "too_new": False}),
    ("json_null", b"null", {"unreadable": "not_an_object", "too_new": False}),
    ("json_array", b'[{"v":1}]', {"unreadable": "not_an_object", "too_new": False}),
    ("empty_file", b"", {"unreadable": "unparseable", "too_new": False}),
    ("too_new", b'{"v":99,"tombstones":[]}', {"unreadable": None, "too_new": True}),
]


@pytest.mark.parametrize("label,body,want", _STATE_CASES,
                         ids=[c[0] for c in _STATE_CASES])
def test_load_state_reaches_the_same_disposition_in_both_runtimes(
        tmp_path, monkeypatch, label, body, want):
    monkeypatch.setenv("CHEAPER_EVENTS_DIR", str(tmp_path))
    if body is not None:
        (tmp_path / "state.json").write_bytes(body)
    py = _py_state()
    js = _node(_STATE_HARNESS, STORE_JS, env={"CHEAPER_EVENTS_DIR": str(tmp_path)})
    assert _canonical(py) == _canonical(js), (
        f"load_state diverged for {label}\n"
        f"  python: {_canonical(py)}\n  node:   {_canonical(js)}")
    assert py["unreadable"] == want["unreadable"], py
    assert py["too_new"] == want["too_new"], py


def test_a_state_json_that_is_a_DIRECTORY_reports_the_errno_not_an_empty_state(
        tmp_path, monkeypatch):
    """A bad restore, a sync client, a name collision. `EISDIR` is the reason the person
    holding the terminal needs; "no tombstones" is a claim nobody made."""
    monkeypatch.setenv("CHEAPER_EVENTS_DIR", str(tmp_path))
    (tmp_path / "state.json").mkdir()
    py = _py_state()
    js = _node(_STATE_HARNESS, STORE_JS, env={"CHEAPER_EVENTS_DIR": str(tmp_path)})
    assert py["unreadable"] == "EISDIR", py
    assert _canonical(py) == _canonical(js)


def test_an_ABSENT_state_is_benign_and_is_NOT_conflated_with_an_unreadable_one(
        tmp_path, monkeypatch):
    """The whole reason the three dispositions are kept apart: a first run must report
    normally. Collapsing them the other way -- treating ABSENT as a refusal -- would
    blank every new install."""
    monkeypatch.setenv("CHEAPER_EVENTS_DIR", str(tmp_path))
    assert store.load_state() == {"v": store.STATE_V, "coverage": [], "tombstones": [],
                                  "ingested_files": []}
    assert "unreadable" not in store.load_state()

    # ...and a state file holding a TOMBSTONE, then corrupted, must NOT come back as the
    # same document as the absent one. That equality is the re-admission.
    (tmp_path / "state.json").write_text(
        json.dumps({"v": 1, "coverage": [], "tombstones": [_TOMB]})[:-4],
        encoding="utf-8")
    corrupt = store.load_state()
    assert corrupt.get("unreadable") == "unparseable"
    assert corrupt != {"v": store.STATE_V, "coverage": [], "tombstones": [],
                       "ingested_files": []}


# ---------------------------------------------------------------------------
# pricing: the same estimate, in both runtimes, on the same dates
# ---------------------------------------------------------------------------

_ESTIMATE_HARNESS = r"""
const pricing = require(process.argv[1]);
const cases = JSON.parse(process.argv[2]);
function n(x) {
  if (typeof x !== 'number' || !isFinite(x)) return null;
  let s = x.toFixed(10);
  if (/^-0\.0+$/.test(s)) s = s.slice(1);
  return s;
}
const out = cases.map(function (c) {
  const r = pricing.estimateCall(c[0], c[1], c[2], c[3], c[4] ? { at: c[4] } : undefined);
  return { family: r.family, actual_tier: r.actualTier, eff_tier: r.effTier,
           actual_cost: n(r.actualCost), baseline_cost: n(r.baselineCost),
           new_cost: n(r.newCost), saved: n(r.saved), gross: n(r.gross),
           extra: n(r.extra), downgraded: !!r.downgraded, priceable: !!r.priceable };
});
process.stdout.write(JSON.stringify(out));
"""

# Each row is a state the two runtimes could answer differently, and several are states
# they DID answer differently:
#   gemini-2.5-pro / sonnet        the reachable NEGATIVE — the route target bills input
#                                  at $1.50/Mtok against the pro's $1.25, so an
#                                  input-heavy call costs MORE on the "cheaper" model.
#                                  The same pair at 1M/1M shows a SAVING, which is why
#                                  the inversion survived every blended spot check.
#   claude-fable-5 / claude-mythos-5   catalogued `opus`, named `sonnet`. A name-only
#                                  tier picked the wrong ceiling AND the wrong target.
#   gemini-3.5-flash               catalogued `sonnet`, named `haiku`.
#   grok-4.3                       catalogued `sonnet`, named `opus`.
#   claude-sonnet-5 @ 2026-09-01   the promo has lapsed at the ROW's day and is still
#                                  live today, so the historical leg and the prospective
#                                  leg MUST disagree — a frame substitution shows up as a
#                                  saving on a call that was never downgraded.
#   llama-4-maverick / totally-unknown   unpriceable: a labelled refusal, not a $0 claim.
_ESTIMATE_CASES = [
    ["gemini-2.5-pro", 100000, 10000, "sonnet", None],
    ["gemini-2.5-pro", 1000000, 1000000, "sonnet", None],
    ["gemini-2.5-pro", 100000, 10000, "haiku", None],
    ["gemini-3.5-flash", 100000, 10000, "haiku", None],
    ["gemini-3.1-pro", 300000, 20000, "sonnet", None],
    ["claude-fable-5", 100000, 10000, "sonnet", None],
    ["claude-mythos-5", 100000, 10000, "haiku", None],
    ["claude-opus-4", 1000000, 1000000, "haiku", None],
    ["claude-opus-5", 1000000, 1000000, "sonnet", None],
    ["claude-sonnet-5", 1000000, 1000000, "sonnet", "2026-09-01"],
    ["claude-sonnet-5", 1000000, 1000000, "haiku", "2026-09-01"],
    ["claude-sonnet-5", 1000000, 1000000, "haiku", "2026-08-06"],
    ["grok-4.3", 100000, 10000, "haiku", None],
    ["grok-build-0.1", 100000, 10000, "haiku", None],
    ["gpt-5.6-luna", 100000, 10000, "haiku", None],
    ["mistral-nemo", 100000, 10000, "haiku", None],
    ["llama-4-maverick", 1000000, 1000000, "haiku", None],
    ["totally-unknown", 1000000, 1000000, "haiku", None],
    ["fable-5", 100000, 10000, "sonnet", None],
]


@pytest.fixture(scope="module")
def estimates():
    js = _node(_ESTIMATE_HARNESS, PRICING_JS, json.dumps(_ESTIMATE_CASES))
    py = []
    for model, i, o, tier, at in _ESTIMATE_CASES:
        r = pricing.estimate_call(model, i, o, tier, at)
        py.append({"family": r["family"], "actual_tier": r["actual_tier"],
                   "eff_tier": r["eff_tier"], "actual_cost": _n(r["actual_cost"]),
                   "baseline_cost": _n(r["baseline_cost"]),
                   "new_cost": _n(r["new_cost"]), "saved": _n(r["saved"]),
                   "gross": _n(r["gross"]), "extra": _n(r["extra"]),
                   "downgraded": bool(r["downgraded"]),
                   "priceable": bool(r["priceable"])})
    return py, js


def test_estimate_call_is_byte_identical_across_runtimes(estimates):
    py, js = estimates
    for i, case in enumerate(_ESTIMATE_CASES):
        assert _canonical(py[i]) == _canonical(js[i]), (
            f"estimate_call diverged for {case}\n"
            f"  python: {_canonical(py[i])}\n  node:   {_canonical(js[i])}")


def test_a_costlier_ROUTE_is_reported_as_an_anti_saving_never_clamped_to_zero(estimates):
    """`max(0, ...)` in the arithmetic is a suppression performed where it can never be
    undone: the route that would have cost the user MORE reads as a neutral $0.00 and
    leaves every total. The delta is signed and split into gross/extra at the edge.

    The inversion is in the rate SHAPE, not in a mis-tiered name: gemini-2.5-pro bills
    input at $1.25/Mtok and the sonnet route target gemini-3.5-flash at $1.50."""
    py, js = estimates
    heavy = py[_ESTIMATE_CASES.index(["gemini-2.5-pro", 100000, 10000, "sonnet", None])]
    assert heavy["priceable"] is True and heavy["downgraded"] is True
    assert float(heavy["saved"]) < 0, heavy
    assert float(heavy["saved"]) == pytest.approx(0.225 - 0.24, abs=1e-9)
    assert float(heavy["gross"]) == 0.0
    assert float(heavy["extra"]) == pytest.approx(0.015, abs=1e-9)

    # The SAME pair on a blended mix saves money. Both are true; a report that keeps only
    # the second is the one telling the story wrong.
    blended = py[_ESTIMATE_CASES.index(
        ["gemini-2.5-pro", 1000000, 1000000, "sonnet", None])]
    assert float(blended["saved"]) > 0, blended


def test_the_historical_leg_and_the_counterfactual_do_not_share_a_date(estimates):
    """`actual_cost` answers "what did this call cost?" at the ROW'S day. `saved` answers
    "what would adopting Cheaper save?" and both of ITS legs price at TODAY. Subtracting
    a today-priced counterfactual from a day-priced historical cost is the frame
    substitution `at` exists to prevent -- and it is INVISIBLE except on a row whose day
    sits on the far side of a promotional boundary."""
    py, _ = estimates
    lapsed = py[_ESTIMATE_CASES.index(
        ["claude-sonnet-5", 1000000, 1000000, "sonnet", "2026-09-01"])]
    # 2026-09-01: the launch promo has lapsed at the row's own day ($3/$15 = $18)...
    assert float(lapsed["actual_cost"]) == pytest.approx(18.0, abs=1e-9), lapsed
    # ...while the prospective baseline still prices at today's rate ($2/$10 = $12).
    assert float(lapsed["baseline_cost"]) == pytest.approx(12.0, abs=1e-9), lapsed
    # No downgrade, so no saving — whatever the two dates say.
    assert float(lapsed["saved"]) == 0.0, lapsed
    assert float(lapsed["gross"]) == 0.0 and float(lapsed["extra"]) == 0.0

    # With a downgrade, the saving is computed ENTIRELY inside the prospective frame:
    # 12 (baseline today) - 6 (haiku target today) = 6, NOT 18 - 6 = 12.
    down = py[_ESTIMATE_CASES.index(
        ["claude-sonnet-5", 1000000, 1000000, "haiku", "2026-09-01"])]
    assert float(down["actual_cost"]) == pytest.approx(18.0, abs=1e-9), down
    assert float(down["saved"]) == pytest.approx(6.0, abs=1e-9), down


def test_an_unpriceable_model_is_a_labelled_refusal_not_a_zero_saving(estimates):
    py, _ = estimates
    for case in (["llama-4-maverick", 1000000, 1000000, "haiku", None],
                 ["totally-unknown", 1000000, 1000000, "haiku", None]):
        r = py[_ESTIMATE_CASES.index(case)]
        assert r["priceable"] is False, case
        assert r["actual_tier"] is None and r["eff_tier"] is None, case
        assert r["downgraded"] is False, case


# ---------------------------------------------------------------------------
# the FAMILY REGEX and the TIER RULE themselves, not just the catalog's ids
# ---------------------------------------------------------------------------
#
# `cli/scripts/sync-prices.js` probes every id IN THE CATALOG plus a handful of known
# unknowns. That gate cannot see this class of drift at all: `fable` and `mythos` were in
# the JS alternation and missing from the Python one, and every catalogue id carrying
# them ALSO carries `claude-`, which both runtimes already matched. The alternation
# itself has to be the probe list -- the same hole that let `magistral`/`devstral` reach
# production resolving to a family in one runtime and to nothing in the other.

_TOKEN = re.compile(r"[a-z0-9][a-z0-9.\-]*")
_JS_FAMILY_LINE = re.compile(r"if \(/(.+?)/\.test\(m\)\) return '([a-z]+)';")


def _alternation_tokens(pattern: str) -> set:
    """Every literal alternative in a family pattern, stripped of regex furniture."""
    body = pattern.strip()
    if body.startswith("(") and body.endswith(")"):
        body = body[1:-1]
    out = set()
    for alt in body.split("|"):
        alt = alt.replace(r"\b", "").replace(r"[-\s]", "").replace("\\", "").strip()
        m = _TOKEN.fullmatch(alt)
        if m:
            out.add(alt)
    return out


def _family_probe_tokens() -> list:
    """The UNION of both runtimes' alternations, so a token present in either one is
    probed against both. A one-sided probe list can only ever confirm its own side."""
    toks = set()
    src = PRICING_JS.read_text(encoding="utf-8")
    for body, _family in _JS_FAMILY_LINE.findall(src):
        toks |= _alternation_tokens(body)
    for _family, rgx in pricing._FAMILY_PATTERNS:
        toks |= _alternation_tokens(rgx.pattern)
    return sorted(toks)


_FAMILY_HARNESS = r"""
const pricing = require(process.argv[1]);
const ids = JSON.parse(process.argv[2]);
const out = {};
for (const id of ids) out[id] = pricing.detectFamily(id) || null;
process.stdout.write(JSON.stringify(out));
"""


def test_the_family_alternation_itself_agrees_across_runtimes():
    toks = _family_probe_tokens()
    # Probe the bare token AND a realistic dressed-up form, because an id reaches this
    # function through a gateway forward, a proxy rewrite or a provider alias, not only
    # as the catalog spells it.
    ids = toks + [t + "-5" for t in toks] + ["preview-" + t for t in toks]
    js = _node(_FAMILY_HARNESS, PRICING_JS, json.dumps(ids))
    py = {i: pricing.detect_family(i) for i in ids}
    bad = [i for i in ids if py[i] != js[i]]
    assert not bad, ("the family regexes disagree on "
                     + ", ".join(f"{i!r} (python={py[i]!r}, node={js[i]!r})"
                                 for i in bad[:12]))

    # NON-VACUOUS on both halves: the probe list must actually carry the tokens whose
    # absence caused the two recorded incidents, and most tokens must resolve.
    assert {"fable", "mythos", "magistral", "devstral"} <= set(toks), sorted(toks)
    assert sum(1 for i in ids if py[i]) >= len(toks), "most probes must name a family"


_TIER_HARNESS = r"""
const classify = require(process.argv[1]);
const ids = JSON.parse(process.argv[2]);
const out = {};
for (const id of ids) out[id] = classify.modelTier(id) || null;
process.stdout.write(JSON.stringify(out));
"""


def test_model_tier_agrees_across_runtimes_over_the_whole_catalog():
    """`model_tier` decides BOTH the ceiling and the downgrade target inside
    `estimate_call`, so a tier the two runtimes disagree about is a counterfactual priced
    against a different bucket on each surface.

    It read tier off the NAME alone here while the CLI read the reviewed catalog first --
    and the two disagree for 16 of the catalog's own entries, because capability rank and
    price rank genuinely diverge in this lineup."""
    ids = [e["id"] for e in pricing.CATALOG]
    for e in pricing.CATALOG:
        ids += list(e.get("aliases") or [])
    ids += ["o3-mini", "some-random-model", "claude-opus-4-9", "gpt-5.6",
            "us.anthropic.claude-opus-5", "claude-opus-5-20260101", "llama-4-maverick",
            "qwen-3-max", "", "fable-5"]
    js = _node(_TIER_HARNESS, CLASSIFY_JS, json.dumps(ids))
    py = {i: pricing.model_tier(i) for i in ids}
    bad = [i for i in ids if py[i] != js[i]]
    assert not bad, ("model_tier disagrees on "
                     + ", ".join(f"{i!r} (python={py[i]!r}, node={js[i]!r})"
                                 for i in bad[:16]))

    # NON-VACUOUS: the catalog must really contain entries whose NAME says otherwise, or
    # a name-only implementation would pass this gate unchanged.
    named = []
    for e in pricing.CATALOG:
        m = str(e["id"]).lower()
        if pricing.CHEAP_SIGNALS.search(m):
            guess = "haiku"
        elif pricing.TOP_SIGNALS.search(m):
            guess = "opus"
        else:
            guess = None
        if guess != e.get("tier"):
            named.append(e["id"])
    assert len(named) >= 10, f"only {len(named)} entries disagree with their own name"
    # ...and an uncatalogued id with no signal FAILS CLOSED rather than claiming `sonnet`.
    assert py["some-random-model"] is None and js["some-random-model"] is None
