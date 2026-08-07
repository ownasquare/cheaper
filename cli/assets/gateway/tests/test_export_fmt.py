"""Export escaping, the spreadsheet formula hazard, and the empty-vs-zero rule.

Three things are on trial here, and all three have a named failure mode:

  1. **Cell content is USER-CONTROLLED.** `reason`, `source` (a raw client header) and
     model ids may carry commas, tabs, quotes or newlines. One unescaped character
     silently shifts every later column on that row -- and a shifted CSV still opens.

  2. **Excel, LibreOffice and Sheets EVALUATE a cell beginning with = + - @ on open.**
     `=cmd|'/c calc'!A1` in a routing reason becomes code execution on the reader's
     machine.

  3. **The `_NUMERIC` test is load-bearing.** Without it the guard fires on every
     NEGATIVE delta, and `-0.0123` exports as `'-0.0123` -- the single most important
     column in the file silently stops being a number, in a product whose entire value
     is that its numbers are trusted. `saved = base_x - spent_x  # SIGNED` makes
     negatives a designed case, not an edge case.

And the rule that outranks the other three: an unpriceable row's `delta_usd` is EMPTY
in CSV/TSV and `null` in JSON. Never `0`. `0.00` is a measured result; empty is "no
claim made".
"""

from __future__ import annotations

import csv
import io
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import export_fmt  # noqa: E402

# The fixture, literally. Every one of these has been an actual exploit or an actual
# regression somewhere in the CSV-export world.
HOSTILE = [
    "=cmd|'/c calc'!A1",     # DDE command execution on open
    "@SUM(1+1)*cmd",         # Lotus-era @ prefix, still live in Excel
    "+1+1",                  # formula, not a number
    "-1+1",                  # formula that LOOKS like a negative number
    "-0.0123",               # a genuine negative number: MUST NOT be guarded
    "line one\nline two",    # embedded newline: would forge a new CSV record
    "tab\there",             # embedded tab: would forge a new TSV column
    'quote"inside',          # embedded double quote
    "plain text",
    "claude-opus-5",
]


def _read_csv(text):
    # newline='' is mandatory: universal-newline translation would rewrite \r\n INSIDE a
    # quoted field and the round-trip assertion would pass for the wrong reason.
    return list(csv.reader(io.StringIO(text, newline="")))


# ---------------------------------------------------------------------------
# 1. round trip
# ---------------------------------------------------------------------------

def test_raw_mode_round_trips_every_hostile_cell_through_pythons_csv_module():
    text = export_fmt.csv_row(HOSTILE, mode="raw")
    rows = _read_csv(text)
    assert len(rows) == 1, "an embedded newline must not forge a second record"
    assert rows[0] == HOSTILE


def test_raw_mode_round_trips_through_tsv_too():
    """TSV has no quoting standard -- Excel, pandas and cut(1) all disagree -- so the
    four row-breaking characters are backslash-escaped instead. Unambiguous, no state
    machine, and exactly reversible."""
    line = export_fmt.tsv_row(HOSTILE, mode="raw")
    assert line.endswith("\n")
    cells = line[:-1].split("\t")
    assert len(cells) == len(HOSTILE), "an embedded tab must not forge a column"

    def unescape(s):
        out, i = [], 0
        while i < len(s):
            if s[i] == "\\" and i + 1 < len(s):
                out.append({"\\": "\\", "t": "\t", "r": "\r", "n": "\n"}[s[i + 1]])
                i += 2
            else:
                out.append(s[i])
                i += 1
        return "".join(out)

    assert [unescape(c) for c in cells] == HOSTILE


# ---------------------------------------------------------------------------
# 2. the formula guard
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("hostile", ["=cmd|'/c calc'!A1", "@SUM(1+1)*cmd", "+1+1",
                                     "-1+1", "|pipe", "%percent"])
def test_safe_mode_disarms_every_formula_prefix(hostile):
    guarded = export_fmt.guard(hostile, "safe")
    assert guarded == "'" + hostile
    assert guarded[1:] == hostile, "the guard prefixes; it must never rewrite content"


def test_leading_whitespace_does_not_smuggle_a_formula_past_the_guard():
    """Leading whitespace does not disarm the formula parser in every product, so the
    guard tests the first NON-BLANK character. A plain `s[0]` test is bypassed by one
    space -- or by a non-breaking space, which looks like nothing at all."""
    for prefix in (" ", "\t", " ", "    "):
        assert export_fmt.guard(prefix + "=1+1", "safe").startswith("'")


def test_raw_mode_does_not_guard_at_all():
    assert export_fmt.guard("=cmd|'/c calc'!A1", "raw") == "=cmd|'/c calc'!A1"


# ---------------------------------------------------------------------------
# 3. _NUMERIC is load-bearing
# ---------------------------------------------------------------------------

def test_a_negative_delta_is_still_a_NUMBER_in_safe_mode():
    """THE regression this test exists for. Drop `_NUMERIC` from guard() and this fails:
    every negative delta exports as text and the column stops being arithmetic."""
    assert export_fmt.guard("-0.0123", "safe") == "-0.0123"
    cell = export_fmt.csv_cell("-0.0123", "safe")
    assert cell == "-0.0123"
    assert float(cell) == pytest.approx(-0.0123)

    # Through the real writer, and back out through a real CSV parser.
    text = export_fmt.csv_row(["-0.0123", "-1+1"], mode="safe")
    got = _read_csv(text)[0]
    assert float(got[0]) == pytest.approx(-0.0123), "the number survived"
    assert got[1] == "'-1+1", "the formula did not"


@pytest.mark.parametrize("numeric", ["0", "-0", "1", "-1", "3.14", "-0.0123",
                                     "1e6", "-2.5E-3", "1234567.891234"])
def test_every_shape_of_number_passes_the_guard_untouched(numeric):
    assert export_fmt.guard(numeric, "safe") == numeric


@pytest.mark.parametrize("not_numeric", ["-1+1", "+1", "1-1", "01", "1,000", "- 1",
                                         "-", "1.2.3", "0x10"])
def test_things_that_only_LOOK_numeric_do_not_pass(not_numeric):
    guarded = export_fmt.guard(not_numeric, "safe")
    if not_numeric[:1] in export_fmt._DANGEROUS:
        assert guarded.startswith("'"), f"{not_numeric!r} must be guarded"
    else:
        assert guarded == not_numeric


# ---------------------------------------------------------------------------
# 4. EMPTY, never zero
# ---------------------------------------------------------------------------

def _view(priceable, delta=None, baseline=None, spent=None, reason=""):
    return {
        "id": "rid:x", "ts": 1786012800123, "ts_iso": "2026-08-05T00:00:00Z",
        "pday": "2026-08-05", "tzo": -300, "ingested_at": 1786013000000,
        "basis": "estimated", "grain": "call", "source": "claude-code",
        "harness": "claude-code", "session": "s1", "served": "claude-sonnet-5",
        "base": "claude-opus-5", "requested": "", "decision": "downgrade",
        "tier": "sonnet", "classifier_tier": "sonnet", "classifier_version": 3,
        "reason": reason, "in": 100, "out": 50, "cache_read": 0,
        "cache_create_5m": 0, "cache_create_1h": 0, "cache_create_unknown": 0,
        "tokens": 150, "speed": None, "service_tier": "standard", "status": 200,
        "eligible": True, "priceable": priceable,
        "baseline_usd": baseline, "actual_usd": spent, "delta_usd": delta,
        "unpriced_reason": "" if priceable else "served_not_in_catalog",
        "verifiable": True,
    }


def test_an_unpriceable_rows_delta_cell_is_EMPTY_not_zero():
    row = export_fmt.export_row(_view(False))
    assert row["delta_usd"] is None
    assert row["baseline_usd"] is None and row["actual_usd"] is None
    assert row["unpriced_reason"] == "served_not_in_catalog"

    cells = _read_csv("".join(export_fmt.stream_csv({}, [row], preamble=False)))
    header, values = cells[0], cells[1]
    header[0] = header[0].lstrip("﻿")
    for col in ("delta_usd", "baseline_usd", "actual_usd"):
        cell = values[header.index(col)]
        assert cell == "", f"{col} rendered as {cell!r}; empty means 'no claim made'"
        assert cell != "0" and cell != "0.00", "0 is a MEASURED result"

    # JSON says null, not 0.
    doc = json.loads("".join(export_fmt.stream_json({}, [row], preamble=False)))
    assert doc["rows"][0]["delta_usd"] is None


def test_a_priceable_zero_delta_IS_rendered_as_zero():
    """The counterpart, and the reason `None` and `0` must stay distinguishable: a
    measured zero is a real result and must not read as 'no claim made'."""
    row = export_fmt.export_row(_view(True, delta=0.0, baseline=1.5, spent=1.5))
    assert row["delta_usd"] == "0.000000"
    cells = _read_csv("".join(export_fmt.stream_csv({}, [row], preamble=False)))
    header = [c.lstrip("﻿") for c in cells[0]]
    assert cells[1][header.index("delta_usd")] == "0.000000"


def test_a_negative_delta_survives_the_whole_pipeline_as_a_number():
    row = export_fmt.export_row(_view(True, delta=-0.0123, baseline=1.0, spent=1.0123))
    text = "".join(export_fmt.stream_csv({}, [row], preamble=False))
    cells = _read_csv(text)
    header = [c.lstrip("﻿") for c in cells[0]]
    assert float(cells[1][header.index("delta_usd")]) == pytest.approx(-0.0123)


# ---------------------------------------------------------------------------
# 5. file-level properties
# ---------------------------------------------------------------------------

def test_csv_starts_with_a_utf8_bom_and_uses_crlf():
    """Without the BOM Excel decodes the file as the machine's ANSI code page and every
    non-ASCII model id is mojibake."""
    chunks = list(export_fmt.stream_csv({}, [export_fmt.export_row(_view(True, 0.5, 1.0, 0.5))],
                                        preamble=False))
    assert chunks[0] == "﻿"
    body = "".join(chunks)
    assert body[1:].count("\r\n") == 2, "RFC 4180 rows end CRLF"
    assert "\n" not in body.replace("\r\n", "")


def test_basis_and_grain_are_present_in_every_export_row():
    """Non-hideable. A later 'simplify the table' change that drops them silently
    re-mixes a per-call measured figure with a per-chat estimated one."""
    assert "basis" in export_fmt.EXPORT_COLUMNS
    assert "grain" in export_fmt.EXPORT_COLUMNS
    row = export_fmt.export_row(_view(True, 0.5, 1.0, 0.5))
    assert row["basis"] == "estimated" and row["grain"] == "call"


def test_the_writers_stream_and_never_materialise_the_export():
    import types
    for fmt in ("csv", "tsv", "json", "ndjson"):
        gen = export_fmt.stream(fmt, {}, iter([]), preamble=False)
        assert isinstance(gen, types.GeneratorType), f"{fmt} writer must be a generator"


def test_hostile_content_in_a_reason_cannot_break_the_row_shape():
    rows = [export_fmt.export_row(_view(True, 0.5, 1.0, 0.5, reason=h)) for h in HOSTILE]
    text = "".join(export_fmt.stream_csv({}, rows, preamble=False))
    parsed = _read_csv(text)
    assert len(parsed) == 1 + len(rows), "no row forged an extra record"
    width = len(parsed[0])
    assert all(len(r) == width for r in parsed), "no row shifted a column"


def test_safe_filename_cannot_inject_a_content_disposition_header():
    evil = 'report"; foo=bar\r\nSet-Cookie: a=b\n.csv'
    got = export_fmt.safe_filename(evil)
    assert '"' not in got and "\r" not in got and "\n" not in got and ";" not in got
    assert len(got) <= 120


def test_row_digest_is_order_sensitive_and_content_sensitive():
    """`row_digest` is what turns a printout into evidence: a reader re-runs the
    `reproduce` line and checks byte-for-byte that nothing was edited."""
    a = export_fmt.export_row(_view(True, 0.5, 1.0, 0.5))
    b = export_fmt.export_row(_view(True, 0.25, 1.0, 0.75))
    assert export_fmt.row_digest([a, b]) != export_fmt.row_digest([b, a])
    assert export_fmt.row_digest([a, b]) == export_fmt.row_digest([a, b])
    c = dict(a)
    c["delta_usd"] = "9.999999"
    assert export_fmt.row_digest([a]) != export_fmt.row_digest([c])


# ---------------------------------------------------------------------------
# 6. the audit header
# ---------------------------------------------------------------------------

@pytest.fixture()
def meta():
    import reporting
    return reporting.audit_meta(
        period_label="This month", from_ms=1785974400000, to_ms=1786579200000,
        tz="America/Chicago",
        filters={"from": 1785974400000, "to": 1786579200000, "tz": "America/Chicago",
                 "basis": None, "limit": 100, "sort": "ts:desc"},
        rows_exported=3, rows_matching=3, truncated=False,
        state={"v": 1, "coverage": [], "tombstones": []},
        guard_mode="safe", digest="9f2b6c41a10d", build="3f9a1c77e10b4d52",
        fmt="csv", now_ms=1786100000000)


def test_the_preamble_is_valid_csv_and_carries_every_required_disclosure(meta):
    lines = export_fmt.preamble_lines(meta)
    assert all(ln.startswith("#") for ln in lines)
    assert all("\n" not in ln and "\r" not in ln for ln in lines), \
        "a preamble line with a newline would break out of its single cell"
    blob = "\n".join(lines)
    for required in ("export_schema", "generated_at", "generated_by", "period_start",
                     "INCLUSIVE", "period_end", "EXCLUSIVE", "timezone",
                     "period_basis", "week_anchor", "coverage", "classifier",
                     "rows_exported", "rows_matching", "truncated",
                     "METHOD", "MEASUREMENT BASIS", "PRICE PROVENANCE",
                     "catalog_digest", "THIS IS NOT AN INVOICE", "INTEGRITY",
                     "row_digest", "tombstones", "guard_mode", "reproduce"):
        assert required in blob, f"the audit header lost `{required}`"
    assert "SIGNED" in blob and "never 0.00" in blob
    # Still parseable as CSV: one single-cell record per preamble line.
    text = "".join(export_fmt.stream_csv(meta, [], preamble=True))
    parsed = _read_csv(text)
    assert len(parsed) == len(lines) + 1     # + the column header row
    assert all(len(r) == 1 for r in parsed[:len(lines)])


def test_one_dict_renders_the_csv_preamble_the_json_meta_and_the_cover_page(meta):
    """All three are rendered from ONE audit_meta() dict, so they cannot disagree."""
    csv_text = "".join(export_fmt.stream_csv(meta, [], preamble=True))
    json_doc = json.loads("".join(export_fmt.stream_json(meta, [], preamble=True)))
    assert json_doc["meta"]["integrity"]["row_digest"] == meta["integrity"]["row_digest"]
    assert meta["integrity"]["row_digest"] in csv_text
    assert json_doc["meta"]["period_start"] == meta["period_start"]
    assert meta["period_start"] in csv_text
    ndjson_first = next(iter(export_fmt.stream_ndjson(meta, [], preamble=True)))
    assert json.loads(ndjson_first)["meta"]["export_schema"] == meta["export_schema"]


def test_preamble_zero_suppresses_the_header_entirely(meta):
    text = "".join(export_fmt.stream_csv(meta, [], preamble=False))
    assert "#" not in text
    assert text.startswith("﻿" + export_fmt.EXPORT_COLUMNS[0])


def test_the_guard_note_tells_the_reader_the_file_is_not_byte_reversible(meta):
    assert "NOT" in meta["integrity"]["guard_note"]
    assert "--guard raw" in meta["integrity"]["guard_note"]
    assert "--format json" in meta["integrity"]["guard_note"]
    assert meta["reproduce"].startswith("cheaper export --format csv")
    assert "--guard safe" in meta["reproduce"]
