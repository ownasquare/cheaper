"""Delimited export for the Cheaper audit log.

Two hazards drive every rule here:
  1. Cell content is USER-CONTROLLED. ``reason``, ``source`` (a raw client header at
     app.py:344) and model ids may contain commas, tabs, quotes or newlines. One
     unescaped character silently shifts every later column on that row.
  2. Excel, LibreOffice and Sheets EVALUATE a cell beginning with = + - @ on open.
     ``=cmd|'/c calc'!A1`` in a ``reason`` becomes code execution on the reader's
     machine. This is an export of adversary-influencable text.

Three further properties this module is responsible for:

  * **UTF-8 BOM on CSV/TSV.** Without it Excel decodes the file as the ANSI code page
    and every non-ASCII model id is mojibake. The BOM is the first thing emitted.
  * **RFC 4180 CRLF row endings** on CSV. TSV uses LF (there is no TSV standard; LF is
    what ``cut``/``pandas`` expect).
  * **Streamed rows.** ``stream_*`` are generators: the formatted export is never
    materialised as one string. (The *row set* is in memory — the reconciliation fold
    is inherently whole-set — but the bytes are not, so a 20,000-row CSV costs one row
    of formatting at a time and the row digest is computed once, before the first byte.)

And the rule that outranks all of them:

  **An unpriceable row's ``delta_usd`` is EMPTY in CSV/TSV and ``null`` in JSON —
  never ``0``.** ``0.00`` is a measured result; empty is "no claim made". Rendering the
  second as the first is the exact concealment this product exists to end.
"""

from __future__ import annotations

import hashlib
import json
import re

EXPORT_SCHEMA = "cheaper.export.v1"

# A UTF-8 BOM, emitted as the first character of every CSV/TSV export. Excel on
# Windows otherwise decodes the bytes as the machine's ANSI code page.
BOM = "﻿"

# A cell is numeric iff it is EXACTLY a number. This test is load-bearing: without
# it the guard fires on every negative delta -- "-0.0123" would export as
# "'-0.0123" and the single most important column in the file stops being a number.
# metrics.py `saved = base_x - spent_x  # SIGNED` makes negatives a designed case.
_NUMERIC = re.compile(r"^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$")
_DANGEROUS = ("=", "+", "-", "@", "\t", "\r", "\n", "|", "%")
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def guard(s: str, mode: str = "safe") -> str:
    """mode='safe' -> spreadsheet-safe, NOT byte-reversible (stated in the header)
       mode='raw'  -> byte-exact, unsafe to double-click open"""
    s = _CTRL.sub("", s or "")
    if mode == "raw" or not s or _NUMERIC.match(s):
        return s
    # Leading whitespace does not disarm the formula parser in every product,
    # so test the first NON-blank character, not s[0].
    head = s.lstrip("\t\r\n  ")[:1]
    return ("'" + s) if head in _DANGEROUS else s


def csv_cell(v, mode: str = "safe") -> str:
    s = guard("" if v is None else str(v), mode)
    if s == "":
        return ""
    # Quote on delimiter, quote, either newline, or leading/trailing space
    # (unquoted surrounding space is silently eaten by several parsers).
    if any(ch in s for ch in ',"\r\n') or s != s.strip():
        return '"' + s.replace('"', '""') + '"'
    return s


def csv_row(vals, mode: str = "safe") -> str:
    return ",".join(csv_cell(v, mode) for v in vals) + "\r\n"      # RFC 4180: CRLF


# TSV has no quoting standard -- Excel, pandas and cut(1) all disagree -- so escape
# the four characters that can break a row. Unambiguous, no state machine, exact.
_TSV = {"\\": "\\\\", "\t": "\\t", "\r": "\\r", "\n": "\\n"}


def tsv_cell(v, mode: str = "safe") -> str:
    return "".join(_TSV.get(ch, ch) for ch in guard("" if v is None else str(v), mode))


def tsv_row(vals, mode: str = "safe") -> str:
    return "\t".join(tsv_cell(v, mode) for v in vals) + "\n"


_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")


def safe_filename(s: str) -> str:                 # Content-Disposition header injection
    return _SAFE_NAME.sub("-", s)[:120]


# ---------------------------------------------------------------------------
# The exported row
# ---------------------------------------------------------------------------
#
# `basis` and `grain` are NON-HIDEABLE and appear in EVERY export row. A later
# "simplify the table" change that drops them silently re-mixes a per-call measured
# figure with a per-chat estimated one in the same column.
EXPORT_COLUMNS = (
    "ts_iso", "ts_ms", "pday", "tz_offset_min", "ingested_at_ms",
    "basis", "grain", "source", "harness", "session", "event_id",
    "requested_model", "baseline_model", "served_model", "decision",
    "tier", "classifier_tier", "classifier_version", "reason",
    "in_tokens", "out_tokens", "cache_read", "cache_create_5m", "cache_create_1h",
    "cache_create_unknown", "total_tokens",
    "speed", "service_tier", "status", "eligible",
    "baseline_usd", "actual_usd", "delta_usd", "unpriced_reason", "verifiable",
)

def _money(v):
    """A dollar cell. ``None`` stays None (empty cell / JSON null) — it is NOT 0."""
    if v is None:
        return None
    return f"{float(v):.6f}"


def export_row(view: dict) -> dict:
    """Project one API row view onto the canonical export schema.

    Unpriceable rows carry ``None`` in all three money columns, which the writers
    render as an empty cell (CSV/TSV) or ``null`` (JSON). Never 0.
    """
    priceable = bool(view.get("priceable"))
    return {
        "ts_iso": view.get("ts_iso") or "",
        "ts_ms": view.get("ts"),
        "pday": view.get("pday") or "",
        "tz_offset_min": view.get("tzo"),
        "ingested_at_ms": view.get("ingested_at"),
        "basis": view.get("basis") or "",
        "grain": view.get("grain") or "",
        "source": view.get("source") or "",
        "harness": view.get("harness") or "",
        "session": view.get("session") or "",
        "event_id": view.get("id") or "",
        "requested_model": view.get("requested") or "",
        "baseline_model": view.get("base") or "",
        "served_model": view.get("served") or "",
        "decision": view.get("decision") or "",
        "tier": view.get("tier") or "",
        "classifier_tier": view.get("classifier_tier") or "",
        "classifier_version": view.get("classifier_version"),
        "reason": view.get("reason") or "",
        "in_tokens": view.get("in"),
        "out_tokens": view.get("out"),
        "cache_read": view.get("cache_read"),
        "cache_create_5m": view.get("cache_create_5m"),
        "cache_create_1h": view.get("cache_create_1h"),
        "cache_create_unknown": view.get("cache_create_unknown"),
        "total_tokens": view.get("tokens"),
        "speed": view.get("speed") or "",
        "service_tier": view.get("service_tier") or "",
        "status": view.get("status"),
        "eligible": "true" if view.get("eligible") else "false",
        # Money columns: present only when the row is priceable.
        "baseline_usd": _money(view.get("baseline_usd")) if priceable else None,
        "actual_usd": _money(view.get("actual_usd")) if priceable else None,
        "delta_usd": _money(view.get("delta_usd")) if priceable else None,
        "unpriced_reason": view.get("unpriced_reason") or "",
        "verifiable": "true" if view.get("verifiable") else "false",
    }


def canonical_row_json(row: dict) -> str:
    """The exact bytes the integrity digest is taken over. Sorted keys, no spaces."""
    return json.dumps(row, sort_keys=True, separators=(",", ":"), default=str)


def row_digest(rows) -> str:
    """sha256 over the canonical JSON of every exported row, IN THE ORDER EMITTED.

    This is what turns a printout into evidence: a reader re-runs the `reproduce`
    command line from the header and checks byte-for-byte that nothing was edited.
    """
    h = hashlib.sha256()
    for r in rows:
        h.update(canonical_row_json(r).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


# ---------------------------------------------------------------------------
# The audit header block
# ---------------------------------------------------------------------------

_RULE = "=" * 82


def _section(title: str) -> str:
    body = f"--- {title} "
    return body + "-" * max(0, 82 - len(body))


def _wrap(text: str, width: int = 80):
    words = str(text).split()
    line = ""
    out = []
    for w in words:
        if line and len(line) + 1 + len(w) > width:
            out.append(line)
            line = w
        else:
            line = (line + " " + w) if line else w
    if line:
        out.append(line)
    return out or [""]


def preamble_lines(meta: dict):
    """Render the audit header from ONE ``audit_meta()`` dict.

    The CSV/TSV preamble, the JSON ``meta`` block and the report cover page are all
    rendered from this same dict, so they cannot disagree with each other or with the
    rows they describe.
    """
    m = meta or {}

    def kv(k, v):
        return f"# {k:<20} {'' if v is None else v}"

    lines = [
        f"# {_RULE}",
        "# Cheaper.app — model-routing savings audit export",
        f"# {_RULE}",
        kv("export_schema", m.get("export_schema")),
        kv("generated_at", f"{m.get('generated_at')}   (local {m.get('generated_at_local')})"),
        kv("generated_by", m.get("generated_by")),
        "#",
        "# " + _section("SCOPE"),
        kv("period", m.get("period")),
        kv("period_start", f"{m.get('period_start')}      INCLUSIVE"),
        kv("period_end", f"{m.get('period_end')}      EXCLUSIVE"),
        kv("period_bounds", m.get("period_bounds_label")),
        kv("timezone", m.get("timezone")),
    ]
    for i, ln in enumerate(_wrap(m.get("period_basis"), 58)):
        lines.append(kv("period_basis" if i == 0 else "", ln))
    lines.append(kv("week_anchor", m.get("week_anchor")))
    for i, ln in enumerate(_wrap(m.get("coverage_label"), 58)):
        lines.append(kv("coverage" if i == 0 else "", ln))
    lines.append(kv("classifier", m.get("classifier")))
    lines.append(kv("rows_exported",
                    f"{m.get('rows_exported')}      rows_matching {m.get('rows_matching')}"
                    f"      truncated {'yes' if m.get('truncated') else 'no'}"))
    lines.append("#")
    lines.append("# " + _section("METHOD"))
    for ln in _wrap(m.get("method"), 80):
        lines.append("# " + ln)
    lines.append("#")
    lines.append("# " + _section("MEASUREMENT BASIS (per row, column `basis`)"))
    for ln in _wrap(m.get("measurement_basis"), 80):
        lines.append("# " + ln)
    lines.append("#")
    lines.append("# " + _section("PRICE PROVENANCE"))
    prov = m.get("price_provenance") or {}
    lines.append(kv("price_catalog",
                    f"cheaper model_prices as_of {prov.get('as_of')}"
                    f"  (age {prov.get('age_days')} days)"))
    lines.append(kv("catalog_digest", prov.get("digest")))
    for ln in _wrap(prov.get("note"), 80):
        lines.append("# " + ln)
    lines.append("#")
    lines.append("# " + _section("THIS IS NOT AN INVOICE"))
    for ln in _wrap(m.get("not_an_invoice"), 80):
        lines.append("# " + ln)
    lines.append("#")
    lines.append("# " + _section("INTEGRITY"))
    integ = m.get("integrity") or {}
    lines.append(kv("row_digest", integ.get("row_digest")))
    lines.append(kv("tombstones", integ.get("tombstones")))
    for i, ln in enumerate(_wrap(integ.get("guard_note"), 58)):
        lines.append(kv("guard_mode" if i == 0 else "", ln))
    lines.append(kv("reproduce", m.get("reproduce")))
    lines.append(f"# {_RULE}")
    # No preamble line may contain a newline: it would break out of its single cell.
    return [ln.replace("\r", " ").replace("\n", " ") for ln in lines]


# ---------------------------------------------------------------------------
# Streaming writers
# ---------------------------------------------------------------------------

def stream_csv(meta: dict, rows, mode: str = "safe", preamble: bool = True):
    """Yield an RFC 4180 CSV one row at a time, BOM first."""
    yield BOM
    if preamble:
        for line in preamble_lines(meta):
            # `raw` for the preamble: it is our own text, it starts with '#', and a
            # leading apostrophe on a provenance line would be noise, not safety.
            yield csv_row([line], mode="raw")
    yield csv_row(EXPORT_COLUMNS, mode="raw")
    for r in rows:
        yield csv_row([r.get(c) for c in EXPORT_COLUMNS], mode=mode)


def stream_tsv(meta: dict, rows, mode: str = "safe", preamble: bool = True):
    yield BOM
    if preamble:
        for line in preamble_lines(meta):
            yield tsv_row([line], mode="raw")
    yield tsv_row(EXPORT_COLUMNS, mode="raw")
    for r in rows:
        yield tsv_row([r.get(c) for c in EXPORT_COLUMNS], mode=mode)


def stream_json(meta: dict, rows, preamble: bool = True):
    """A single JSON document, streamed. Lossless: no formula guard is applied, and an
    unpriceable money column is `null`."""
    yield '{"meta":' + (json.dumps(meta, default=str) if preamble else "null") + ',"rows":['
    first = True
    for r in rows:
        yield ("" if first else ",") + json.dumps(r, default=str)
        first = False
    yield "]}"


def stream_ndjson(meta: dict, rows, preamble: bool = True):
    """Newline-delimited JSON. The meta block is the first line when the preamble is on."""
    if preamble:
        yield json.dumps({"meta": meta}, default=str) + "\n"
    for r in rows:
        yield json.dumps(r, default=str) + "\n"


MEDIA_TYPES = {
    "csv": "text/csv; charset=utf-8",
    "tsv": "text/tab-separated-values; charset=utf-8",
    "json": "application/json; charset=utf-8",
    "ndjson": "application/x-ndjson; charset=utf-8",
}


def stream(fmt: str, meta: dict, rows, mode: str = "safe", preamble: bool = True):
    if fmt == "tsv":
        return stream_tsv(meta, rows, mode=mode, preamble=preamble)
    if fmt == "json":
        return stream_json(meta, rows, preamble=preamble)
    if fmt == "ndjson":
        return stream_ndjson(meta, rows, preamble=preamble)
    return stream_csv(meta, rows, mode=mode, preamble=preamble)


__all__ = [
    "EXPORT_SCHEMA", "BOM", "EXPORT_COLUMNS", "MEDIA_TYPES",
    "guard", "csv_cell", "csv_row", "tsv_cell", "tsv_row", "safe_filename",
    "export_row", "canonical_row_json", "row_digest", "preamble_lines",
    "stream", "stream_csv", "stream_tsv", "stream_json", "stream_ndjson",
]
