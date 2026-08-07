"""Python mirror of the per-call JSONL event store reader.

This is the READ half of ``cli/src/peek/events.js`` + ``reconcile.js`` + ``derive.js``,
transcribed so the gateway's reporting API answers the same question the CLI answers,
to the cent. It MUST stay behaviourally identical to those three files:

    cli/src/peek/events.js     listSegments / readSegment / readAll / isStrongKey
    cli/src/peek/reconcile.js  rank / merge / fold  (commutative, idempotent)
    cli/src/peek/derive.js     deriveRow / foldRows

``tests/test_store_parity.py`` executes BOTH runtimes over ``cli/test/fixtures/
golden-events.json`` and diffs their canonical JSON byte-for-byte. A divergence FAILS
the suite -- it does not warn -- because a divergence between the two readers produces
double-counting that looks exactly like the three prior mispricing incidents.

Three properties this file exists to preserve, each of which has already been a bug:

  * **FAIL CLOSED.** Every branch that cannot produce an honest figure returns a
    labelled UNPRICEABLE, never 0. ``$0.00`` is a measured result; "no claim made" is
    not, and rendering the second as the first is the concealment this product ends.
  * **The two bases never touch.** ``measured`` and ``estimated`` accumulate
    SEPARATELY and this module never exposes a key that combines them.
  * **Priceability resolves at the ROW'S OWN DAY**, exactly like the price.
    ``pricing.is_priceable()`` takes no ``at``, so this module calls
    ``pricing.resolve_model(model, at=row.pday)`` directly -- see ``_priceable_at``.

Pure stdlib. No dollar figure is ever stored; dollars are derived per row, here.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from datetime import datetime, timezone

import periods
import pricing

# A segment carrying a HIGHER v is REFUSED and counted, never read as absent. The old
# ledger's `catch -> {chats:{}}` made a forward-incompatible file read as "you saved
# nothing", which is the worst possible way to be wrong about money.
SCHEMA_V = 1
STATE_V = 1

# ---- derive.js REASONS (byte-identical strings; they reach the UI and the export) ---
REASON_NON_2XX = "non_2xx"
REASON_NO_TS = "undated"
REASON_SERVED_UNPRICEABLE = "served_not_in_catalog"
REASON_BASE_UNPRICEABLE = "baseline_not_in_catalog"
REASON_NO_BASE = "no_baseline"
REASON_COST_NULL = "cost_unavailable"

REASONS = {
    "NON_2XX": REASON_NON_2XX,
    "NO_TS": REASON_NO_TS,
    "SERVED_UNPRICEABLE": REASON_SERVED_UNPRICEABLE,
    "BASE_UNPRICEABLE": REASON_BASE_UNPRICEABLE,
    "NO_BASE": REASON_NO_BASE,
    "COST_NULL": REASON_COST_NULL,
}

# The full stored row schema (cli/src/peek/emit.js). Listed so a reader can see what a
# row is allowed to contain -- and, by omission, what it may never contain: no
# filesystem path and no prompt-derived text.
ROW_FIELDS = (
    "v", "id", "rev", "w", "inst", "ts", "tzo", "pday", "ingested_at",
    "prov", "usrc", "conf", "harness", "sessions", "sess", "sub",
    "served", "req", "base", "bsrc", "elig", "ctier", "cver", "reason",
    "in", "out", "cr", "c5", "c1", "cu", "speed", "svc", "status",
    "sfile", "sbase", "fsha", "vok",
)


# ---------------------------------------------------------------------------
# JS coercion helpers -- the mirror is only faithful if the coercions match
# ---------------------------------------------------------------------------

def _num0(v):
    """JS ``x || 0`` for a token field: every falsy value becomes 0.

    Integers stay ints so ``tokens`` serialises as ``5``, not ``5.0``.
    """
    if v is None or v is False or v == "" or v == 0:
        return 0
    if v is True:
        return 1
    if isinstance(v, int):
        return v
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(f):
        return 0
    return int(f) if f.is_integer() else f


def num0(v):
    """Public alias of the JS ``x || 0`` coercion, for callers outside this module."""
    return _num0(v)


def _js_number(v):
    """JS ``Number(v)``. Returns None where JS would produce NaN."""
    if v is None or isinstance(v, (dict, list)):
        return None
    if v is True:
        return 1.0
    if v is False:
        return 0.0
    if isinstance(v, str):
        s = v.strip()
        if s == "":
            return 0.0
        try:
            f = float(s)
        except ValueError:
            return None
        return f if math.isfinite(f) else None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _strict_eq(a, b) -> bool:
    """JS ``===``. ``true === 1`` is FALSE in JS and must be false here too."""
    if isinstance(a, bool) != isinstance(b, bool):
        return False
    if isinstance(a, (list, dict)) or isinstance(b, (list, dict)):
        return a is b
    return a == b


# ---------------------------------------------------------------------------
# events.js -- segments, partial trailing lines, schema skew
# ---------------------------------------------------------------------------

def events_dir() -> str:
    return (os.environ.get("CHEAPER_EVENTS_DIR")
            or os.path.join(os.path.expanduser("~"), ".cheaper", "events"))


def is_strong_key(row_id) -> bool:
    """``rid:``/``mid:`` are provider-issued and may CREDIT a claim. ``wk:`` is a weak
    content hash and may only SUPPRESS one."""
    return bool(re.match(r"^(rid|mid):", str(row_id or "")))


_SEG_MONTH = re.compile(r"^(\d{4}-\d{2})\.")


def list_segments(directory: str | None = None) -> list:
    """Every segment on disk, newest month first.

    Globs ``*.jsonl`` DELIBERATELY -- not an exact name. Two machines on a synced home
    folder produce ``2026-08.9a41c0d7.cli (conflicted copy).jsonl``; a reader that looks
    up an exact filename never opens it and silently loses a month. Globbing folds the
    conflicted copy through dedupe instead.
    """
    d = directory or events_dir()
    try:
        names = os.listdir(d)
    except OSError:
        return []
    out = []
    for n in names:
        if not n.lower().endswith(".jsonl"):
            continue
        try:
            st = os.stat(os.path.join(d, n))
        except OSError:
            continue
        m = _SEG_MONTH.match(n)
        out.append({
            "file": os.path.join(d, n),
            "name": n,
            "ym": m.group(1) if m else None,
            "size": st.st_size,
            "mtime": st.st_mtime * 1000.0,
            # Filename is YYYY-MM.<install>.<writer>.jsonl; anything not ending
            # `.gw.jsonl` was written by the Node CLI.
            "writer": "gw" if n.lower().endswith(".gw.jsonl") else "cli",
        })
    out.sort(key=lambda s: (s["ym"] or "", s["mtime"]), reverse=True)
    return out


def read_segment(file: str, on_row) -> dict:
    """Read one segment. Tolerates a PARTIAL TRAILING LINE at all times and COUNTS it.

    A segment can be appended to while it is being read, so the last chunk after the
    final ``\\n`` may be half a record. Split on ``\\n``; if the final chunk is
    non-empty it is a partial record -- skip it AND count it as ``partial_tail``. This
    is an explicit, tested path rather than an incidental try/except: a silently
    dropped tail is indistinguishable from "there was no activity".
    """
    stats = {"rows": 0, "bad": 0, "partial_tail": 0, "future_schema": 0, "bytes": 0}
    try:
        with open(file, encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return stats
    stats["bytes"] = len(raw.encode("utf-8"))
    parts = raw.split("\n")
    tail = parts.pop()                      # '' when the file ends in \n
    if tail:
        stats["partial_tail"] = 1           # a genuinely partial last record
    for line in parts:
        s = line.strip()
        if not s:
            continue
        if s[0] != "{":
            stats["bad"] += 1
            continue
        try:
            o = json.loads(s)
        except ValueError:
            stats["bad"] += 1
            continue
        if not isinstance(o, dict):
            stats["bad"] += 1
            continue
        v = _js_number(o.get("v"))
        # A schema version higher than this reader understands is a VISIBLE REFUSAL,
        # never a zero and never "the row was absent".
        if v is not None and v > SCHEMA_V:
            stats["future_schema"] += 1
            continue
        stats["rows"] += 1
        try:
            on_row(o)
        except Exception:                   # one bad row must not end the scan
            pass
    return stats


def _segment_end_ms(ym: str) -> int:
    """The instant after which a UTC-month segment can hold nothing relevant.

    Mirrors ``Date.UTC(+ym[0:4], +ym[5:7], 2)``: the JS month argument is 0-based, so
    passing the 1-based month number lands on the SECOND of the following month. A
    UTC-month segment can hold local-calendar events one day either side, so the
    adjacent month is never skipped.
    """
    y = int(ym[:4])
    mo = int(ym[5:7])
    yy = y + mo // 12
    mm = mo % 12 + 1
    return int(datetime(yy, mm, 2, tzinfo=timezone.utc).timestamp() * 1000)


def read_all(directory: str | None = None, since_ms: int | float | None = None) -> dict:
    """Read every segment, newest month first. Returns ``{rows, stats}``."""
    d = directory or events_dir()
    segs = list_segments(d)
    rows: list = []
    stats = {"segments": 0, "rows": 0, "bad": 0, "partial_tail": 0,
             "future_schema": 0, "bytes": 0}
    for seg in segs:
        if since_ms and seg["ym"]:
            try:
                if _segment_end_ms(seg["ym"]) < since_ms:
                    continue
            except ValueError:
                pass
        stats["segments"] += 1

        def _collect(o, _seg=seg):
            o["_seg"] = _seg["name"]
            o["_w"] = o.get("w") or _seg["writer"]
            rows.append(o)

        s = read_segment(seg["file"], _collect)
        for k in ("rows", "bad", "partial_tail", "future_schema", "bytes"):
            stats[k] += s[k]
    return {"rows": rows, "stats": stats}


# ---------------------------------------------------------------------------
# derive.js -- one stored event -> its dollars
# ---------------------------------------------------------------------------

def tokens_of(r: dict) -> dict:
    r = r or {}
    return {
        "in_fresh": _num0(r.get("in")),
        "cache_create_5m": _num0(r.get("c5")),
        "cache_create_1h": _num0(r.get("c1")),
        "cache_create": _num0(r.get("cu")),
        "cache_read": _num0(r.get("cr")),
        "out_tok": _num0(r.get("out")),
    }


def total_tokens(r: dict) -> int:
    r = r or {}
    return (_num0(r.get("in")) + _num0(r.get("out")) + _num0(r.get("cr"))
            + _num0(r.get("c5")) + _num0(r.get("c1")) + _num0(r.get("cu")))


def _priceable_at(model, at) -> bool:
    """``isPriceable(model, {at})`` from pricing.js.

    ``pricing.is_priceable()`` in this runtime takes NO date and therefore resolves at
    TODAY, which put priceability and price in different time frames: a provider
    shipping a new model -- or a user not refreshing the catalog for six weeks -- could
    flip an already-read historical period from "$16.15 saved" to blank with no code
    change and no data change. ``resolve_model`` is the date-aware resolver the module
    does export, so priceability is asked at the row's own day, same as the price.
    """
    return pricing.resolve_model(model, at) is not None


def _cost(model, bk: dict, at, speed, svc):
    """``costOfModel(model, tokens, ctx)`` from pricing.js.

    ``cost_of_model`` here has no cache-write-of-UNKNOWN-TTL parameter, while the JS
    token breakdown does (``cacheCreate``). applyRates() prices an unknown-TTL write at
    the SAME ``cacheWrite`` rate as a 5-minute write (the cheaper of the two, so an
    unknown never inflates the bill), and ``inputTotal`` adds both into the same
    long-context total -- so folding ``cu`` into ``cache_create_5m`` is exact, not an
    approximation.
    """
    return pricing.cost_of_model(
        model,
        in_tok=bk["in_fresh"],
        out_tok=bk["out_tok"],
        cache_read=bk["cache_read"],
        cache_create_5m=bk["cache_create_5m"] + bk["cache_create"],
        cache_create_1h=bk["cache_create_1h"],
        speed=speed,
        service_tier=svc,
        at=at,
    )


def derive_row(r: dict) -> dict:
    """One stored event -> ``{priceable, reason, spent, baseline, delta, tokens, pday}``.

    A PURE function of the row. Every session-scoped input was frozen at write time
    (base / bsrc / elig / ctier / pday), so this cannot depend on the query window --
    which is the property that makes ``report(Jan) + report(Feb) == report(Jan u Feb)``
    true to the cent.

    ``delta`` is SIGNED: a routed call that cost MORE subtracts. There is no
    ``max(0, ...)`` anywhere -- the same ``> 0`` guard concealed the honest number in
    three separate prior incidents, and the fix each time was to preserve the sign in
    the math and suppress at RENDER.
    """
    r = r or {}
    tokens = total_tokens(r)
    out = {"priceable": False, "reason": "", "spent": None, "baseline": None,
           "delta": None, "tokens": tokens, "pday": r.get("pday")}

    if not r.get("pday"):
        out["reason"] = REASON_NO_TS
        return out

    # Retries and errors are recorded but never priced. Claude Code retries 429s and
    # overloaded_error automatically and each retry gets a DISTINCT provider request
    # id, so the idempotency key cannot collapse them: a six-retry storm on one turn
    # would book six times the saving for one delivered answer.
    status = _js_number(r.get("status"))
    if status is not None and status != 0 and not (200 <= status < 300):
        out["reason"] = REASON_NON_2XX
        return out

    at = r.get("pday")
    speed = r.get("speed") or None
    svc = r.get("svc") or None

    if not _priceable_at(r.get("served"), at):
        out["reason"] = REASON_SERVED_UNPRICEABLE
        return out

    bk = tokens_of(r)
    spent = _cost(r.get("served"), bk, at, speed, svc)
    if spent is None:
        out["reason"] = REASON_COST_NULL
        return out
    out["spent"] = spent

    if not r.get("base"):
        out["reason"] = REASON_NO_BASE
        out["priceable"] = True
        out["delta"] = 0
        return out
    if not _priceable_at(r.get("base"), at):
        out["reason"] = REASON_BASE_UNPRICEABLE
        return out

    # SAME call, SAME date, SAME SKU -- the only variable is the model, because the
    # model is the only thing Cheaper controls, and therefore the only thing it may
    # claim credit for.
    baseline = _cost(r.get("base"), bk, at, speed, svc)
    if baseline is None:
        out["reason"] = REASON_COST_NULL
        return out

    out["priceable"] = True
    out["baseline"] = baseline
    out["delta"] = (baseline - spent) if r.get("elig") else 0
    return out


def _mk_acc() -> dict:
    return {"saved": 0.0, "spent": 0.0, "baseline": 0.0, "tokens": 0, "calls": 0,
            "credited": 0, "offset": 0, "gross": 0.0, "extra": 0.0}


def fold_rows(rows) -> dict:
    """Aggregate a set of rows, keeping the two BASES strictly apart.

    THE ABSOLUTE INVARIANT: never add a figure from two sources. ``measured`` and
    ``estimated`` accumulate SEPARATELY here and this function NEVER returns a key that
    combines them. A renderer that wants one figure must pick a basis and say which.

    The same rule covers GRAIN: a chat count and a call count are never added, even
    within one basis. Legacy chat-grain rows do not enter this function at all.
    """
    acc = {"measured": _mk_acc(), "estimated": _mk_acc()}
    unpriced: dict = {}
    unpriced_tokens = 0
    total_tokens_seen = 0

    for r in (rows or []):
        d = derive_row(r)
        total_tokens_seen += d["tokens"]
        if not d["priceable"]:
            unpriced[d["reason"]] = unpriced.get(d["reason"], 0) + 1
            unpriced_tokens += d["tokens"]
            continue
        a = acc["measured"] if (r or {}).get("conf") == "measured" else acc["estimated"]
        a["calls"] += 1
        a["tokens"] += d["tokens"]
        a["spent"] += d["spent"] or 0
        a["baseline"] += d["baseline"] or 0
        delta = d["delta"] or 0
        a["saved"] += delta
        if delta > 0:
            a["gross"] += delta
            a["credited"] += 1
        elif delta < 0:
            a["extra"] += -delta
            a["offset"] += 1

    ratio = (unpriced_tokens / total_tokens_seen) if total_tokens_seen else 0
    return {
        "measured": acc["measured"],
        "estimated": acc["estimated"],
        "unpriced": unpriced,
        "unpriced_calls": sum(unpriced.values()),
        "unpriced_tokens": unpriced_tokens,
        # Report-nothing case #7: when more than a fifth of a window's tokens cannot be
        # priced, dollars are suppressed and only tokens are reported. A figure derived
        # from four fifths of the evidence, presented as if it were all of it, is the
        # shape every prior incident had.
        "unpriced_ratio": ratio,
        "dollars_suppressed": total_tokens_seen > 0 and ratio > 0.20,
    }


# ---------------------------------------------------------------------------
# reconcile.js -- union, dedupe by provider id, merge per FIELD, commutatively
# ---------------------------------------------------------------------------

TOKEN = ("in", "out", "cr", "c5", "c1", "cu")
GW_ONLY = ("req", "reason")
TX_ONLY = ("harness", "sub", "ctier", "cver")
FROZEN = ("base", "bsrc", "elig")
PLAIN = ("served", "speed", "svc", "status", "pday", "tzo", "prov", "usrc",
         "sfile", "sbase", "fsha", "vok", "inst", "w")
FIELDS = TOKEN + GW_ONLY + TX_ONLY + FROZEN + PLAIN + ("ts",)

SRC_TX = 1
SRC_GW = 2
SRC_LEGACY = 4


def mask_of(e: dict) -> int:
    prov = (e or {}).get("prov")
    if prov == "gateway":
        return SRC_GW
    if prov == "legacy":
        return SRC_LEGACY
    return SRC_TX


def rank(e: dict, f: str) -> int:
    """Per-field precedence. Higher wins.

      tokens        TX(body) > GW(body) > TX(estimate) > GW(estimate). "Prefer measured
                    over estimated" is INVALID and deliberately rejected: the gateway's
                    streamed rows carried no usage at all, so preferring the gateway
                    would have deleted real output cost and printed it as exact.
      req/reason    gateway only -- the transcript physically cannot know what was
                    asked for BEFORE routing, or why the router chose what it chose.
      harness/sub/  transcript only -- the gateway has no session or prompt visibility.
      ctier/cver
    """
    prov = (e or {}).get("prov")
    if f in TOKEN:
        if prov == "transcript":
            return 4 if (e or {}).get("usrc") == "body" else 2
        if prov == "gateway":
            return 3 if (e or {}).get("usrc") == "body" else 1
        return 0
    if f in GW_ONLY:
        return 2 if prov == "gateway" else 1
    if f in TX_ONLY:
        return 2 if prov == "transcript" else 1
    if f == "ts":
        return 2 if prov == "transcript" else 1   # closer to the user-visible moment
    return 1


def elect_owner(sessions, _ts_hint=None) -> str:
    """The owning session for a row that appears under several ids.

    A divergent sessionId on a shared provider id is the NORMAL resume/fork case (157
    measured across 120 transcripts) and must never route into the conflict path:
    treated as conflicts, the fold would either lose 4.4% of dollars or blank every
    window containing a resumed chat.
    """
    s = sorted([x for x in (sessions or []) if x])
    return s[0] if s else ""


def merge(x: dict, y: dict) -> dict:
    """COMMUTATIVE and IDEMPOTENT. Replaying any event set in any order must converge
    on the same row and the same total. That property -- not the storage engine -- is
    what makes this defensible as a financial record."""
    # A higher rev of the same row from the SAME source is a restatement (the session
    # ceiling rose and the writer re-emitted). It supersedes outright.
    xr = _num0(x.get("rev")) or 1
    yr = _num0(y.get("rev")) or 1
    if x.get("prov") == y.get("prov") and yr != xr:
        return y if yr > xr else x

    out = dict(x)
    out["conflicts"] = list(x.get("conflicts") or [])
    merged_sessions = list(x.get("sessions") or []) + list(y.get("sessions") or [])
    seen = []
    for s in merged_sessions:
        if s not in seen:
            seen.append(s)
    out["sessions"] = sorted(seen)
    out["sess"] = elect_owner(out["sessions"],
                              min(_num0(x.get("ts")), _num0(y.get("ts"))))
    out["rev"] = max(xr, yr)

    for f in FIELDS:
        rx = rank(x, f)
        ry = rank(y, f)
        xv = x.get(f)
        yv = y.get(f)
        if rx != ry:
            out[f] = xv if rx > ry else yv
        elif f in TOKEN:
            # Same precedence: take the LARGER. The transcript writes one API turn
            # across many lines and usage GROWS with each one (measured: 751 ids grew,
            # ZERO shrank), so max is both correct and immune to out-of-order lines.
            # First-wins under-counted output by 18.7%.
            out[f] = max(_num0(xv), _num0(yv))
        elif _strict_eq(xv, yv):
            out[f] = xv
        elif xv is None:
            out[f] = yv
        elif yv is None:
            out[f] = xv
        else:
            # A genuine disagreement between two sources that should both know. Null it
            # and NAME it, so the row can be suppressed rather than silently picking a
            # winner.
            out[f] = None
            if f not in out["conflicts"]:
                out["conflicts"].append(f)

    out["conflicts"].sort()
    out["source_mask"] = (x.get("source_mask") or mask_of(x)) | (y.get("source_mask") or mask_of(y))
    # 'measured' requires a GATEWAY row whose tokens came from a response BODY. A
    # transcript row is a faithful reconstruction, but it is still a reconstruction.
    out["conf"] = ("measured"
                   if (out["source_mask"] & SRC_GW) and out.get("usrc") == "body"
                   else "estimated")
    return out


def fold(events, stale_writers=None) -> dict:
    """Fold a flat list of events into one row per identity.

    Returns ``{rows, stats}``. ``stats`` carries every quarantine and suppression
    reason so a caller can LABEL its report rather than quietly report a smaller
    number.
    """
    by_id: dict = {}
    stats = {
        "input": 0, "folded": 0,
        "weak_both": 0,             # case 3: a BOTH-source row joined by a WEAK key
        "weak_served_conflict": 0,  # case 4: two weak-key rows disagreeing on `served`
        "pre_migration": 0,         # case 5: gateway rows with no request id
        "stale_writer": 0,          # case 6: quarantined writer
        "outlier_2x": 0,            # case 15: same STRONG key, `out` differs by >2x
        "field_conflicts": 0,
        "quarantined": 0,
    }
    stale = set(stale_writers or ())

    for e in (events or []):
        stats["input"] += 1
        if not e or not e.get("id"):
            continue
        # Case 6 -- a writer known to be running stale code is QUARANTINED from the
        # fold, not merged. Merging its rows would let old logic contribute to a figure
        # that prints with no hedge.
        if stale and e.get("w") in stale:
            stats["stale_writer"] += 1
            stats["quarantined"] += 1
            continue
        # Case 5 -- a gateway row from before request-id capture cannot be proven
        # disjoint from the transcript rows covering the same calls. Disjointness is
        # unprovable, so it is dropped from the fold and counted; the window falls back
        # to transcript-only and is labelled `estimated`. This was the ENTIRE 76-row
        # live DB.
        if e.get("prov") == "gateway" and not is_strong_key(e.get("id")):
            stats["pre_migration"] += 1
            stats["quarantined"] += 1
            continue

        prev = by_id.get(e["id"])
        if prev is None:
            row = dict(e)
            row["source_mask"] = mask_of(e)
            row["conflicts"] = list(e.get("conflicts") or [])
            sessions = list(e.get("sessions") or [])
            row["sessions"] = sessions if sessions else ([e["sess"]] if e.get("sess") else [])
            by_id[e["id"]] = row
            continue

        # Case 15 -- the same STRONG key with wildly different output. That is a bug in
        # one of the writers, not a merge: quarantine both halves rather than averaging
        # a lie.
        a = _num0(prev.get("out"))
        b = _num0(e.get("out"))
        if is_strong_key(e["id"]) and a > 0 and b > 0 and max(a, b) > 2 * min(a, b):
            stats["outlier_2x"] += 1
            stats["quarantined"] += 1
            prev["quarantined"] = True
            continue

        m = merge(prev, e)
        # Case 3 -- a row that claims BOTH sources but was joined by a WEAK key has not
        # been proven to be the same call. A weak key may SUPPRESS a claim; it may
        # never CREDIT one. Fall back to the transcript row alone, labelled estimated.
        if (not is_strong_key(e["id"])
                and (m["source_mask"] & SRC_GW) and (m["source_mask"] & SRC_TX)):
            stats["weak_both"] += 1
            tx = prev if prev.get("prov") == "transcript" else e
            row = dict(tx)
            row["source_mask"] = mask_of(tx)
            row["conf"] = "estimated"
            row["weak_join_suppressed"] = True
            by_id[e["id"]] = row
            continue
        # Case 4 -- two rows share a WEAK key but disagree on which model was served.
        # They are not the same call; keeping either would credit the wrong one.
        if (not is_strong_key(e["id"]) and prev.get("served") and e.get("served")
                and prev.get("served") != e.get("served")):
            stats["weak_served_conflict"] += 1
            stats["quarantined"] += 2
            by_id.pop(e["id"], None)
            continue
        if m.get("conflicts"):
            stats["field_conflicts"] += 1
        by_id[e["id"]] = m

    rows = [r for r in by_id.values() if not r.get("quarantined")]
    stats["folded"] = len(rows)
    rows.sort(key=lambda r: (_num0(r.get("ts")), str(r.get("id"))))
    return {"rows": rows, "stats": stats}


# ---------------------------------------------------------------------------
# state.json -- coverage[], tombstones[]
# ---------------------------------------------------------------------------
#
# Coverage is what makes "not covered" EXPRESSIBLE. Without it, a period before the
# store existed reads as $0.00 -- indistinguishable from a period where routing simply
# saved nothing. "$0" and "we weren't watching" are different claims, and only one of
# them is a measurement.

def state_path() -> str:
    return os.path.join(events_dir(), "state.json")


def load_state() -> dict:
    try:
        with open(state_path(), encoding="utf-8") as fh:
            j = json.load(fh)
    except (OSError, ValueError):
        return {"v": STATE_V, "coverage": [], "tombstones": [], "ingested_files": []}
    if not isinstance(j, dict):
        return {"v": STATE_V, "coverage": [], "tombstones": [], "ingested_files": []}
    v = _js_number(j.get("v"))
    if v is not None and v > STATE_V:
        # A state file from a NEWER writer is a VISIBLE REFUSAL, never a silent reset.
        return {"v": j.get("v"), "too_new": True, "coverage": [], "tombstones": [],
                "ingested_files": []}
    base = {"v": STATE_V, "coverage": [], "tombstones": [], "ingested_files": []}
    base.update(j)
    return base


# Coverage IMPLIED by the events themselves.
#
# A recorded call at instant T is direct evidence that we were watching at T -- stronger
# evidence than the declared interval, in fact. Relying on `state.coverage` alone would
# report `not_covered` for a window full of real events whenever the state file was
# lost, hand-deleted, or written by a path that predates coverage tracking, and
# "not covered" over live data is just as wrong as "$0.00" over no data.
#
# This never WIDENS a claim: it only asserts coverage for instants an event actually
# occupies, plus a one-day pad on each side of a contiguous run (a day with calls in it
# was a day we were watching).
IMPLIED_PAD_MS = 86400000


def implied_coverage(rows) -> list:
    """Mirror of ``cli/src/peek/store.js::impliedCoverage``."""
    ts = sorted(t for t in (_finite(r.get("ts")) for r in (rows or []))
                if t is not None)
    out: list = []
    for t in ts:
        if out and t - out[-1]["to"] <= 2 * IMPLIED_PAD_MS:
            out[-1]["to"] = t + IMPLIED_PAD_MS
            continue
        out.append({"kind": "observed", "from": t - IMPLIED_PAD_MS,
                    "to": t + IMPLIED_PAD_MS})
    return out


def _finite(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def coverage_for(from_ms, to_ms, st: dict | None = None, extra=None) -> dict:
    """How much of ``[from, to)`` we actually watched.

    Returns ``{kind, from, to, covered}`` where kind is one of:

      ``full``         every instant of the window is inside a recorded interval;
      ``partial``      some of it is -- report ONLY the covered sub-window, with
                       explicit bounds, never the nominal total;
      ``not_covered``  none of it is. "$0" and "we weren't watching" are different
                       claims, and only one of them is a measurement.

    ``extra`` carries the coverage implied by the rows in hand (see
    ``implied_coverage``), so a lost ``state.json`` cannot blank a window full of real
    events.
    """
    state = st if st is not None else load_state()
    lo = from_ms if from_ms is not None else -math.inf
    hi = to_ms if to_ms is not None else math.inf
    intervals = list(state.get("coverage") or []) + list(extra or [])
    hits = sorted(
        ({"kind": c.get("kind"), "from": max(_num0(c.get("from")), lo),
          "to": min(_num0(c.get("to")), hi)}
         for c in intervals
         if _num0(c.get("to")) > lo and _num0(c.get("from")) < hi),
        key=lambda c: c["from"])
    if not hits:
        return {"kind": "not_covered", "from": from_ms, "to": to_ms, "covered": []}
    merged: list = []
    for h in hits:
        if merged and h["from"] <= merged[-1]["to"]:
            merged[-1]["to"] = max(merged[-1]["to"], h["to"])
        else:
            merged.append({"from": h["from"], "to": h["to"]})
    spanned = sum(m["to"] - m["from"] for m in merged)
    want = (hi - lo) if (math.isfinite(hi) and math.isfinite(lo)) else math.inf
    full = spanned >= want - 1000 if math.isfinite(want) else False
    return {"kind": "full" if full else "partial", "from": from_ms, "to": to_ms,
            "covered": merged}


def tombstones_in(from_ms, to_ms, st: dict | None = None) -> list:
    """`cheaper forget --session <id>` writes one. Totals then visibly DROP with a
    stated reason instead of silently, and any export covering that window prints it."""
    state = st if st is not None else load_state()
    lo = from_ms if from_ms is not None else -math.inf
    hi = to_ms if to_ms is not None else math.inf
    out = []
    for t in (state.get("tombstones") or []):
        a = _num0(t.get("from") if t.get("from") is not None else t.get("at"))
        b = _num0(t.get("to") if t.get("to") is not None else t.get("at"))
        if b >= lo and a < hi:
            out.append(t)
    return out


# ---------------------------------------------------------------------------
# the frozen legacy chat-grain store
# ---------------------------------------------------------------------------
#
# Mirrors ``cli/src/peek/store.js::legacyPath / loadLegacy / legacyTotals``.
#
# Pre-store `lifetime.json` chats have no model, no token split, no per-call structure
# and a known-wrong timestamp (all six live entries carry an `at` inside one four-hour
# band, for work spanning weeks). They cannot be reconciled against transcript rows and
# cannot be re-priced, so their dollars are FROZEN and they are EXCLUDED from every
# period bucket -- putting them in a day would make the fix look done while history
# stays wrong. They are chat-GRAIN, so their count may never be added to a call count.

def legacy_path() -> str:
    override = os.environ.get("CHEAPER_LEGACY_FILE")
    if override:
        return override
    return os.path.join(os.path.dirname(os.path.normpath(events_dir())),
                        "legacy_chats.json")


def load_legacy() -> dict:
    try:
        with open(legacy_path(), encoding="utf-8") as fh:
            j = json.load(fh)
    except (OSError, ValueError):
        return {"v": 1, "chats": {}}
    if not isinstance(j, dict) or not isinstance(j.get("chats"), dict):
        return {"v": 1, "chats": {}}
    v = _js_number(j.get("v"))
    if v is not None and v > 1:
        # Forward-incompatible: a VISIBLE refusal, never "you saved nothing".
        return {"v": j.get("v"), "too_new": True, "chats": {}}
    return j


def legacy_totals() -> dict:
    j = load_legacy()
    usd = 0.0
    tokens = 0
    chats = 0
    for entry in (j.get("chats") or {}).values():
        if not isinstance(entry, dict):
            continue
        u = _js_number(entry.get("usd"))
        if u is None:
            continue
        usd += u
        tokens += int(_num0(entry.get("tokens")))
        chats += 1
    return {"usd": usd, "tokens": tokens, "chats": chats,
            "derivation": "frozen", "too_new": bool(j.get("too_new"))}


# ---------------------------------------------------------------------------

_CATALOG_PATH = os.path.join(os.path.dirname(__file__), "model_prices.json")


def catalog_digest() -> str:
    """sha256 of the price catalog actually loaded. Travels with every dollar figure so
    a rate stale by months is not byte-indistinguishable from one verified today."""
    try:
        with open(_CATALOG_PATH, "rb") as fh:
            return "sha256:" + hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return "sha256:unavailable"


def pday_of(ts_ms, tzo_minutes):
    return periods.pday_of(ts_ms, tzo_minutes)


__all__ = [
    "SCHEMA_V", "STATE_V", "REASONS", "ROW_FIELDS",
    "num0", "events_dir", "is_strong_key", "list_segments", "read_segment", "read_all",
    "tokens_of", "total_tokens", "derive_row", "fold_rows",
    "TOKEN", "GW_ONLY", "TX_ONLY", "FIELDS", "SRC_TX", "SRC_GW", "SRC_LEGACY",
    "mask_of", "rank", "elect_owner", "merge", "fold",
    "state_path", "load_state", "coverage_for", "implied_coverage", "IMPLIED_PAD_MS",
    "tombstones_in",
    "legacy_path", "load_legacy", "legacy_totals",
    "catalog_digest", "pday_of",
]
