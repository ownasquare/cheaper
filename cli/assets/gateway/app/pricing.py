"""Faithful Python port of the peek CLI's classify.js + pricing.js.

Mirrors, regex-for-regex:
  - cli/src/peek/classify.js  (TIERS, rank, CHEAP_SIGNALS, TOP_SIGNALS, model_tier)
  - cli/src/peek/pricing.js   (BUCKET, detect_family, rate, cost_of, estimate_call)

so the live gateway can compute the same real-dollar savings estimate that the
`peek` CLI reports.

PRICES ARE NOT DUPLICATED HERE. They are loaded from ``model_prices.json``, which
is generated from ``cli/src/peek/models.js`` by ``cli/scripts/sync-prices.js``.
Two hand-maintained copies of a price table is precisely how this file drifted a
full model generation behind the CLI — pricing Opus 5 traffic at retired Opus 4
rates and overstating every session threefold. The gateway's figures are shown to
the user without a "~" (they are the exact path), so a divergence here is an
authoritative-looking wrong number.

To change a price: edit the JS catalog, run ``node cli/scripts/sync-prices.js``.
Never edit the JSON or hardcode a rate in this file.

Pure stdlib (``json``, ``re``), no external dependencies.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone

# --- classify.js -----------------------------------------------------------

# Tier ordering: index is the rank (higher = more capable).
TIERS = ["haiku", "sonnet", "opus"]


def rank(tier: str | None) -> int:
    """Mirror JS Array.prototype.indexOf: -1 if not present."""
    try:
        return TIERS.index(tier)  # type: ignore[arg-type]
    except ValueError:
        return -1


# Word-boundaried so "mini" doesn't fire inside "geMINI", etc.
CHEAP_SIGNALS = re.compile(
    r"(\bhaiku|\bmini\b|\bnano\b|\bflash\b|\blite\b|\bsmall\b|\binstant\b|"
    r"\b8b\b|\b7b\b|\b3b\b|\btiny\b|\bmicro\b|\bembed)",
    re.IGNORECASE,
)
TOP_SIGNALS = re.compile(
    r"(\bopus|\bultra\b|[-\s]pro\b|\breasoner\b|\bthinking\b|\bo1\b|\bo3\b|"
    r"\bo4\b|\b405b\b|\b72b\b|\blarge\b|grok-4|grok-3\b|deepseek-r1|\bqwq\b)",
    re.IGNORECASE,
)


def model_tier(model_id: str | None) -> str | None:
    """Map an arbitrary model id to a coarse capability tier (haiku|sonnet|opus).

    CATALOG FIRST, then name signals, then FAIL CLOSED -- mirroring
    ``classify.js::modelTier`` step for step. Both halves of that order matter and both
    were wrong here:

      * **Catalog first.** A tier reviewed alongside the price beats a guess from the
        name, and in this catalog the two DISAGREE for 16 of the entries -- capability
        rank and price rank genuinely diverge (see the note on CATALOG in models.js).
        ``claude-fable-5`` and ``claude-mythos-5`` are catalogued ``opus`` and read as
        ``sonnet`` from their names; every ``*-flash`` Gemini is catalogued ``sonnet``
        and read as ``haiku``; ``grok-4.3`` is catalogued ``sonnet`` and read as
        ``opus``. ``estimate_call`` derives BOTH the ceiling and the downgrade target
        from this answer, so a name-only tier priced the counterfactual against the
        wrong bucket in either direction -- inventing a downgrade that never existed, or
        erasing one that did -- while the CLI, asking the same question of the same
        catalog, answered differently.
      * **Fail closed.** The old fallback returned ``"sonnet"`` for anything the two
        regexes missed, which silently ASSERTS mid capability for every unrecognized
        model, including every model released after ``CATALOG_AS_OF``. ``None`` means
        "we cannot show a cheaper model would do", and the caller then declines to claim
        anything rather than routing on an invented capability claim.

    Cheap signals still win over top signals for an UNCATALOGUED id (e.g. "o3-mini").
    """
    m = str(model_id or "").lower()
    if not m:
        return None
    entry = resolve_model(model_id)
    if entry and entry.get("tier"):
        return entry["tier"]
    # Name signals are a fallback for models we hold no catalog entry for.
    if CHEAP_SIGNALS.search(m):
        return "haiku"
    if TOP_SIGNALS.search(m):
        return "opus"
    return None


# --- price catalog (generated; see module docstring) --------------------------

_PRICES_PATH = os.path.join(os.path.dirname(__file__), "model_prices.json")

with open(_PRICES_PATH, encoding="utf-8") as _fh:
    _CATALOG_DOC = json.load(_fh)

CATALOG: list[dict] = _CATALOG_DOC["models"]
CATALOG_AS_OF: str = _CATALOG_DOC["as_of"]
# family -> bucket -> the real model that bucket is priced as.
REPRESENTATIVE: dict[str, dict] = _CATALOG_DOC["representative"]

# tier name (haiku|sonnet|opus) -> pricing bucket (cheap|mid|top)
BUCKET = {"haiku": "cheap", "sonnet": "mid", "opus": "top"}


def normalize_id(model_id: str | None) -> str:
    """Strip provider prefixes, dated snapshots and version suffixes.

    Mirrors normalizeId() in models.js so ``us.anthropic.claude-opus-5``,
    ``claude-opus-5-20260101`` and ``claude-opus-5`` all resolve alike.
    """
    m = str(model_id or "").lower().strip()
    if not m:
        return ""
    m = re.sub(r"^[a-z0-9_-]+/", "", m)
    m = re.sub(r"^(?:[a-z]{2}\.)?anthropic\.", "", m)
    m = re.sub(r"@\d{8}$", "", m)
    m = re.sub(r"-\d{8}$", "", m)
    m = re.sub(r"-(?:latest|preview|exp)$", "", m)
    return m


def canonical(model_id: str | None) -> str:
    """Canonical comparison form. Providers mix `.` and `-`; both collapse to `-`."""
    return normalize_id(model_id).replace(".", "-")


def _entry_matches(candidate_canonical: str, entry: dict) -> bool:
    """EXACT match (after normalization), never prefix. Mirrors entryMatches() in models.js.

    Prefix matching fails OPEN: an id the catalog has never seen inherits a sibling's
    rate. `claude-opus-4-9` used to resolve to `claude-opus-4` and price at the retired
    $15/$75 -- a 3x overstatement, and the exact shape of the incident this catalog was
    built to prevent. It also made the "unknown => unpriceable" rule unreachable, and
    left no catalog diff for review or alarms to catch.

    Exact matching fails CLOSED. Legitimate spelling variants are handled by
    normalize_id() (provider prefixes, dated snapshots) or by an explicit `aliases`
    list on the entry -- never implicitly.

    THIS FUNCTION IS NOW THE SPECIFICATION, not the hot path. ``resolve_model`` looks the
    candidate up in ``_catalog_index()`` (an O(1) dict) instead of scanning; the index is
    built to satisfy exactly this predicate, and
    ``test_metrics.py::test_the_resolution_index_matches_a_brute_force_scan_id_for_id``
    proves the two agree for every id and alias in the catalog plus the fail-closed
    near-misses above. Change the predicate and you MUST change the index build with it.
    """
    if canonical(entry["id"]) == candidate_canonical:
        return True
    for alias in entry.get("aliases") or []:
        if canonical(alias) == candidate_canonical:
            return True
    return False


# --- resolution index + date-scoped memo --------------------------------------
#
# WHY THIS EXISTS (performance), and WHY THE KEY CARRIES A DATE (correctness).
#
# resolve_model() used to LINEAR-SCAN the whole catalog and re-canonicalise every entry
# id -- five regex substitutions each -- on every single call. Metrics.summary() with no
# session filter walks up to max_rows=5000 rows and resolves ~7 models per row, and the
# gateway's /ws pushes that summary on EVERY routed request plus a 5s heartbeat, per
# connected dashboard client. Measured on this machine over 5,000 synthetic rows:
# 35,000 resolve_model() calls, 677,266 per-entry comparisons, 1.185s of wall clock
# inside ONE summary().
#
# The obvious cache -- "model_id -> entry" -- would be a PRICING BUG dressed as an
# optimisation. An entry's rates are DATE-SCOPED (`window`), so the same id legitimately
# resolves to different rates on either side of a promo boundary: claude-sonnet-5's
# launch window ends 2026-08-31, and a date-blind cache warmed on 2026-08-30 would keep
# serving $2/$10 for a 2026-09-01 call -- a silent 50% understatement on both input and
# output, with no code change and no data change to point at. That is the very failure
# the `at` parameter was introduced to close. So the memo below is keyed on
# (canonical id, day) and NOTHING may collapse it to a single key.
#
# Two further properties this cache must keep, because tests and future catalog edits
# depend on them:
#   * CATALOG is mutable at runtime (the suite transcribes a promotional window onto an
#     entry for the length of a test). The index is stamped with the catalog's identity
#     and length, and every memo entry carries a COPY of the window it was computed
#     from, so an in-place edit invalidates itself on the next lookup instead of serving
#     a stale price. `invalidate_catalog_cache()` is the explicit belt-and-braces hook.
#   * Entries with NO window are date-independent by construction, so they are returned
#     straight from the index and never memoised per day -- there is no date for a cache
#     to get wrong, and no per-day garbage to accumulate.
_CACHE_EPOCH = 0
# ONE global holding (stamp, index), so the pair is published in a single assignment.
# The gateway serves /metrics and /ws from multiple threads; storing the stamp and the
# dict in two globals lets a racing reader pair a NEW stamp with an OLD index and skip
# the rebuild it needed. A single tuple cannot be torn.
_INDEX: tuple | None = None
# raw model id -> canonical form. Pure function of the id and of the module-level
# regexes, so it needs no invalidation -- only a bound, because model ids arrive from
# request traffic and the key space must not be attacker-growable.
_CANON_CACHE: dict[str, str] = {}
_CANON_CACHE_MAX = 4096
# (canonical id, day) -> (window snapshot, resolved entry). ONLY windowed entries land
# here; see the note above.
_RESOLVED: dict[tuple, tuple] = {}
_RESOLVED_MAX = 4096


def invalidate_catalog_cache() -> None:
    """Drop every memoised resolution.

    Call this after mutating ``CATALOG`` in place in a way the automatic stamping cannot
    see -- editing an existing entry's ``id`` or ``aliases``. Adding or removing an entry
    (length change), replacing the list, and adding/removing/editing a ``window`` are all
    detected without help; this is the escape hatch for everything else. Production never
    needs it: the catalog is loaded once from model_prices.json at import and is never
    written to.
    """
    global _INDEX, _CACHE_EPOCH
    _CACHE_EPOCH += 1
    _INDEX = None
    _RESOLVED.clear()
    _CANON_CACHE.clear()


def _canon_cached(model_id: str | None) -> str:
    """``canonical()`` with a bounded memo. Same answer, five fewer regex passes."""
    if not isinstance(model_id, str):
        return canonical(model_id)
    hit = _CANON_CACHE.get(model_id)
    if hit is None:
        hit = canonical(model_id)
        if len(_CANON_CACHE) >= _CANON_CACHE_MAX:
            _CANON_CACHE.clear()
        _CANON_CACHE[model_id] = hit
    return hit


def _catalog_index() -> dict[str, dict]:
    """canonical id (and alias) -> catalog entry, rebuilt when the catalog changes.

    ``setdefault`` in CATALOG order, id before aliases, reproduces the old scan's
    first-match-wins tie-break EXACTLY: the scan took the first entry whose id or alias
    matched, checking the id first, so the first writer of a key must win here too. Two
    entries claiming the same canonical id is a catalog bug either way -- the point is
    that indexing must not silently change WHICH of them gets picked.
    """
    global _INDEX
    stamp = (id(CATALOG), len(CATALOG), _CACHE_EPOCH)
    cached = _INDEX
    if cached is not None and cached[0] == stamp:
        return cached[1]
    idx: dict[str, dict] = {}
    for entry in CATALOG:
        idx.setdefault(canonical(entry["id"]), entry)
        for alias in entry.get("aliases") or []:
            idx.setdefault(canonical(alias), entry)
    _INDEX = (stamp, idx)
    return idx


def today_utc() -> str:
    """Today, UTC, as YYYY-MM-DD. The default pricing date -- see resolve_model()."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _in_window(win: dict | None, at: str | None) -> bool:
    if not win or not at:
        return False
    if win.get("from") and at < win["from"]:
        return False
    if win.get("until") and at > win["until"]:
        return False
    return True


def resolve_model(model_id: str | None, at: str | None = None) -> dict | None:
    """Catalog entry for a model, or None when we hold no published price.

    ``at`` (YYYY-MM-DD) is the date to price AT. It deliberately does NOT default to
    CATALOG_AS_OF: a frozen default keeps an expired promotional window open forever.
    Claude Sonnet 5's launch pricing ends 2026-08-31, and with a CATALOG_AS_OF default
    every caller would keep quoting $2/$10 instead of $3/$15 indefinitely -- a silent
    ~33% understatement that no catalog refresh would fix, because the bug is in the
    date rather than the rates. Mirrors resolveModel() in models.js.

    MEMOISED, and the memo key CARRIES THE DAY -- see the block comment above
    ``_catalog_index``. The old body scanned the whole catalog and re-canonicalised every
    entry id on every call (677,266 string comparisons for one 5,000-row summary); this
    one is an O(1) dict hit plus, for the handful of entries that actually carry a
    promotional window, a (canonical id, day)-keyed lookup. Answers are byte-identical to
    the scan -- that equivalence is asserted id-for-id by
    ``test_the_resolution_index_matches_a_brute_force_scan_id_for_id``, and the date
    sensitivity by ``test_the_resolution_memo_key_includes_the_day``.

    The returned dict is SHARED, not a defensive copy -- exactly as before, where the
    no-window branch returned the CATALOG entry itself. Callers must treat it as
    read-only; ``rates_for`` already builds its own dict rather than mutating this one.
    """
    cand = _canon_cached(model_id)
    if not cand:
        return None
    best = _catalog_index().get(cand)
    if best is None:
        return None
    win = best.get("window")
    if not win:
        # No dated window: this entry's resolution cannot depend on `at` at all, so
        # there is nothing to merge, nothing to memoise per day, and no date for a
        # cache to get wrong. Read live from the index so a window transcribed onto the
        # entry later is picked up on the very next call.
        return best
    day = at or today_utc()
    key = (cand, day)
    hit = _RESOLVED.get(key)
    # hit[0] is a COPY of the window this answer was computed from. Comparing it to the
    # live one catches a window that was replaced OR edited in place, so a mutated
    # catalog can never be served a stale promotional rate. A <=7-key dict compare, on a
    # path that used to canonicalise ~80 catalog ids. The copy is SHALLOW, which is
    # sufficient because every field a window may carry is a scalar
    # (from/until/in/out/cacheRead/cacheWrite/cacheWrite1h) -- if a nested field is ever
    # added to `window` in models.js, this must become a deep snapshot or the guard stops
    # seeing edits inside it.
    if hit is not None and hit[0] == win:
        return hit[1]
    if _in_window(win, day):
        merged = dict(best)
        promo = {k: v for k, v in win.items() if k not in ("from", "until")}
        merged.update(promo)
        resolved = merged
    else:
        resolved = best
    if len(_RESOLVED) >= _RESOLVED_MAX:
        # Bounded, and cleared wholesale rather than evicted one key at a time: the
        # working set is (windowed models x days on screen), so a clear costs one cold
        # rebuild and never a wrong price.
        _RESOLVED.clear()
    _RESOLVED[key] = (dict(win), resolved)
    return resolved


def rates_for(entry: dict | None, input_tokens: float = 0.0,
              speed: str | None = None, service_tier: str | None = None) -> dict | None:
    """Effective per-token rates, after long-context / speed / service-tier rules."""
    if not entry:
        return None
    r = {
        "in": entry["in"],
        "out": entry["out"],
        "cacheRead": entry.get("cacheRead"),
        "cacheWrite": entry.get("cacheWrite"),
        "cacheWrite1h": entry.get("cacheWrite1h"),
    }

    lc = entry.get("longContext")
    if lc and input_tokens > lc["over"]:
        base_in = entry["in"]
        if r["cacheWrite"] is not None:
            r["cacheWrite"] = lc["in"] * (entry["cacheWrite"] / base_in)
        if r["cacheWrite1h"] is not None:
            r["cacheWrite1h"] = lc["in"] * (entry["cacheWrite1h"] / base_in)
        r["in"] = lc["in"]
        r["out"] = lc["out"]
        if lc.get("cacheRead") is not None:
            r["cacheRead"] = lc["cacheRead"]

    fast = (entry.get("speed") or {}).get("fast")
    if speed == "fast" and fast:
        scale = fast["in"] / r["in"]
        r = {
            "in": fast["in"],
            "out": fast["out"],
            "cacheRead": None if r["cacheRead"] is None else r["cacheRead"] * scale,
            "cacheWrite": None if r["cacheWrite"] is None else r["cacheWrite"] * scale,
            "cacheWrite1h": None if r["cacheWrite1h"] is None else r["cacheWrite1h"] * scale,
        }

    mult = 0.5 if service_tier == "batch" else 1.8 if service_tier == "priority" else 1.0
    if mult != 1.0:
        for k in ("in", "out", "cacheRead", "cacheWrite", "cacheWrite1h"):
            if r[k] is not None:
                r[k] *= mult

    # Fall back only within a model's own sheet: no published cache discount means
    # cache traffic bills at that model's input rate. Never borrow another model's.
    if r["cacheRead"] is None:
        r["cacheRead"] = r["in"]
    if r["cacheWrite"] is None:
        r["cacheWrite"] = r["in"]
    if r["cacheWrite1h"] is None:
        r["cacheWrite1h"] = r["cacheWrite"]
    return r


def is_priceable(model_id: str | None, at: str | None = None) -> bool:
    """True when published rates exist for this exact model ON A GIVEN DAY.

    ``at`` (YYYY-MM-DD) mirrors ``isPriceable(modelId, {at})`` in pricing.js, and it is
    not decorative: a caller that PRICES a row at the row's own day must ask the
    priceability question at that same day. When the two ran in different time frames --
    priceability at TODAY, the price at the row's date -- a catalog refresh, or simply
    the clock crossing a promotional boundary, could flip an already-read historical
    figure with no code change and no data change. Same question, same date.

    ``at=None`` keeps the old behaviour (resolve at today), because that is the honest
    answer to the different question "can we price this model right now?" -- which is
    what ``estimate_call`` below, and callers with no row in hand, are actually asking.
    ``store.py`` and ``reporting.py`` predate this parameter and call
    ``resolve_model(model, pday) is not None`` directly; those are the same expression.
    """
    return resolve_model(model_id, at) is not None


def representative_for(family: str | None, tier_name: str | None) -> str | None:
    fam = REPRESENTATIVE.get(family or "")
    if not fam:
        return None
    return fam.get(BUCKET.get(tier_name or "", "mid")) or fam.get("mid")

# Ordered, case-insensitive family-detection patterns (same order as pricing.js).
_FAMILY_PATTERNS: list[tuple[str, re.Pattern]] = [
    # `fable` and `mythos` name real, catalogued Anthropic top-tier models
    # (`claude-fable-5`, `claude-mythos-5`, `claude-mythos`, alias
    # `claude-mythos-preview`). They were present in the JS alternation and ABSENT here,
    # so an id carrying the codename WITHOUT the `claude-` prefix -- which is how a
    # gateway forward, a proxy rewrite or a provider-side alias can present it --
    # resolved to the anthropic family in the CLI and to None here, and the gateway
    # reported $0 saved on the path that prints no "about" qualifier. Same drift class as
    # the `magistral`/`devstral` incident recorded on the mistral line below; the JS list
    # is the correct one because the catalog holds the models.
    ("anthropic",
     re.compile(r"(claude|haiku|sonnet|opus|fable|mythos|anthropic)", re.IGNORECASE)),
    (
        "openai",
        re.compile(
            r"(gpt|davinci|babbage|chatgpt|\bo1\b|-o1|\bo3\b|-o3|\bo4\b|-o4|openai)",
            re.IGNORECASE,
        ),
    ),
    ("google", re.compile(r"(gemini|palm|bison|gemma)", re.IGNORECASE)),
    ("xai", re.compile(r"grok", re.IGNORECASE)),
    ("deepseek", re.compile(r"deepseek", re.IGNORECASE)),
    ("qwen", re.compile(r"qwen|qwq", re.IGNORECASE)),
    ("meta", re.compile(r"(llama|meta-llama)", re.IGNORECASE)),
    # Must stay in lock-step with FAMILY_PATTERNS in cli/src/peek/pricing.js. Drift here
    # is silent: a family the JS recognises but Python does not reports $0 saved on the
    # gateway path, which is the path that prints no "about" qualifier.
    ("mistral", re.compile(r"(mistral|mixtral|codestral|ministral|magistral|devstral)", re.IGNORECASE)),
]


def detect_family(model_id: str | None) -> str | None:
    """Returns None for models we don't actually recognize. That is deliberate:
    an unknown model must be UNPRICEABLE (saved=0), never priced against
    arbitrary 'other' rates and reported as a saving that didn't happen.
    """
    m = str(model_id or "").lower()
    if not m:
        return None
    for family, pattern in _FAMILY_PATTERNS:
        if pattern.search(m):
            return family
    return None  # unrecognized -> unpriceable


def rate(family: str | None, tier_name: str | None) -> dict | None:
    """Per-token rates for a family+tier bucket, priced as that bucket's real model."""
    rep = representative_for(family, tier_name)
    if not rep:
        return None
    return rates_for(resolve_model(rep))


def cost_of_model(
    model_id: str | None,
    in_tok: float = 0.0,
    out_tok: float = 0.0,
    cache_read: float = 0.0,
    cache_create_5m: float = 0.0,
    cache_create_1h: float = 0.0,
    speed: str | None = None,
    service_tier: str | None = None,
    at: str | None = None,
) -> float | None:
    """Exact cost of one call on a specific model, or None if unpriceable.

    ``out_tok`` already includes reasoning/thinking tokens: every provider bills
    reasoning at the output rate and folds it into the reported output count, so a
    higher reasoning-effort setting needs no separate term here.

    ``at`` (YYYY-MM-DD) is the date the call happened, used to select promotional
    windows; defaults to today inside resolve_model().
    """
    entry = resolve_model(model_id, at)
    if entry is None:
        return None
    total_in = in_tok + cache_read + cache_create_5m + cache_create_1h
    r = rates_for(entry, input_tokens=total_in, speed=speed, service_tier=service_tier)
    return (
        (in_tok / 1e6) * r["in"]
        + (cache_create_5m / 1e6) * r["cacheWrite"]
        + (cache_create_1h / 1e6) * r["cacheWrite1h"]
        + (cache_read / 1e6) * r["cacheRead"]
        + (out_tok / 1e6) * r["out"]
    )


def cost_of(family: str | None, tier_name: str | None, in_tok: float, out_tok: float) -> float:
    """Bucket cost, used only where a concrete model id is unavailable."""
    rep = representative_for(family, tier_name)
    if not rep:
        return 0.0
    return cost_of_model(rep, in_tok=in_tok, out_tok=out_tok) or 0.0


def estimate_call(
    actual_model: str | None,
    in_tok: float,
    out_tok: float,
    content_tier_name: str | None,
    at: str | None = None,
) -> dict:
    """Core per-call estimate for the PROSPECTIVE report ("what you would save if you
    adopted Cheaper"). ``content_tier_name`` is the tier the classifier picked from the
    prompt text. Mirror of ``pricing.js::estimateCall``.

    TWO QUESTIONS, TWO DATES -- and each subtraction stays inside ONE of them:

      ``at`` is the row's OWN local calendar day (``pday``). It prices ``actual_cost``:
      the HISTORICAL fact of what that call really cost, at the rates in force the day it
      happened. This is the figure reported as "Spent on record", and it must not move
      when a promotional window opens or shuts -- a session recorded inside Sonnet 5's
      $2/$10 launch window kept that rate, and restating it at today's $3/$15 would
      rewrite a number the user has already read and acted on. Callers that omit ``at``
      get today, exactly as before this parameter existed.

      ``saved`` is the PROSPECTIVE counterfactual -- "adopt Cheaper and this shape of
      work costs you less" -- so BOTH of its legs price at TODAY (forward-looking work
      prices at today; only retrospective work prices at the call's date).
      ``baseline_cost`` is therefore the requested model at TODAY, deliberately SEPARATE
      from ``actual_cost``: subtracting a today-priced counterfactual from a day-priced
      historical cost would be the exact frame substitution the ``at`` parameter exists
      to prevent. With no ``at`` the two are identical, which is why this split is
      invisible to every caller that does not date its rows.

    SIGNED, NOT CLAMPED. ``saved`` used to be ``max(0.0, actual_cost - new_cost)``. The
    clamp is REACHABLE -- not by the "a cheap model named opus" route (``model_tier``
    consults the catalog first, so a name regex only ever classifies an UNCATALOGUED
    model, which is unpriceable and returns early), but through the rate SHAPE. A tier's
    route target is not cheaper than every model of the tier above it on every token mix:
    the sonnet target ``gemini-3.5-flash`` bills input at $1.50/Mtok while the opus-tier
    ``gemini-2.5-pro`` bills it at $1.25, so an input-heavy call (100k in / 10k out)
    costs $0.225 on the pro and $0.240 on the "cheaper" flash. The inversion lives in the
    rate SHAPE and is invisible to a blended 1M-in/1M-out comparison, which is why it
    survived every spot check. Clamping it to 0 is a suppression performed in the
    ARITHMETIC, the one place it must never happen -- it makes a route that would have
    cost the user MORE read as a neutral $0.00 and removes it from every total. The
    signed delta is returned and split into ``gross``/``extra`` here (the shape
    ``store.fold_rows`` accumulates) so the caller can report the anti-saving instead of
    losing it.
    """
    family = detect_family(actual_model)
    actual_tier = model_tier(actual_model)  # haiku|sonnet|opus, or None
    priceable = is_priceable(actual_model, at)
    if not family or not actual_tier or not priceable:
        return {
            "family": family or "other",
            "actual_tier": None,
            "eff_tier": None,
            "actual_cost": 0.0,
            "baseline_cost": 0.0,
            "new_cost": 0.0,
            "saved": 0.0,
            "gross": 0.0,
            "extra": 0.0,
            "downgraded": False,
            "priceable": False,
        }
    eff_rank = min(rank(actual_tier), rank(content_tier_name))
    eff_tier = TIERS[eff_rank]
    # HISTORICAL leg -- the row's own day.
    actual_cost = cost_of_model(actual_model, in_tok=in_tok, out_tok=out_tok, at=at) or 0.0
    # PROSPECTIVE legs -- both at TODAY.
    baseline_cost = cost_of_model(actual_model, in_tok=in_tok, out_tok=out_tok) or 0.0
    # The cheaper leg is a different model, so it is priced as that tier's
    # representative in the SAME family -- never cross-vendor.
    new_cost = (
        baseline_cost
        if eff_rank == rank(actual_tier)
        else cost_of(family, eff_tier, in_tok, out_tok)
    )
    saved = baseline_cost - new_cost      # SIGNED: a costlier route is negative
    return {
        "family": family,
        "actual_tier": actual_tier,
        "eff_tier": eff_tier,
        "actual_cost": actual_cost,
        "baseline_cost": baseline_cost,
        "new_cost": new_cost,
        "saved": saved,
        "gross": max(0.0, saved),
        "extra": max(0.0, -saved),
        "downgraded": eff_rank < rank(actual_tier),
        "priceable": True,
    }


if __name__ == "__main__":
    assert detect_family("claude-opus-4") == "anthropic"
    assert detect_family("gpt-4o") == "openai"
    assert detect_family("some-random-model") is None
    # The codename ALONE, without the `claude-` prefix, must still name the family --
    # `claude-fable-5` / `claude-mythos-5` are catalogued Anthropic models and these
    # tokens were in the JS alternation only.
    assert detect_family("fable-5") == "anthropic"
    assert detect_family("mythos-5") == "anthropic"
    assert model_tier("o3-mini") == "haiku"
    assert model_tier("claude-opus-4") == "opus"
    # CATALOG FIRST: the name says sonnet/haiku, the reviewed catalog says otherwise, and
    # the catalog wins -- in both directions.
    assert model_tier("claude-fable-5") == "opus", "named sonnet, catalogued opus"
    assert model_tier("gemini-3.5-flash") == "sonnet", "named haiku, catalogued sonnet"
    assert model_tier("grok-4.3") == "sonnet", "named opus, catalogued sonnet"
    # ...and FAIL CLOSED for an id with no catalog entry and no name signal.
    assert model_tier("some-random-model") is None

    # Retired Opus 4 really is $15/$75; the current Opus 5 is $5/$25. Pricing one as
    # the other is the drift this file existed to prevent.
    assert abs(cost_of_model("claude-opus-4", 1e6, 1e6) - 90.0) < 1e-9
    assert abs(cost_of_model("claude-opus-5", 1e6, 1e6) - 30.0) < 1e-9
    e = estimate_call("claude-opus-4", 1_000_000, 1_000_000, "haiku")
    assert abs(e["saved"] - 84.0) < 1e-9, e

    # Cache: read 0.1x, 5m write 1.25x, 1h write 2x of the model's own input rate.
    assert abs(cost_of_model("claude-opus-5", cache_read=1e6) - 0.5) < 1e-9
    assert abs(cost_of_model("claude-opus-5", cache_create_5m=1e6) - 6.25) < 1e-9
    assert abs(cost_of_model("claude-opus-5", cache_create_1h=1e6) - 10.0) < 1e-9

    # Long-context tier, speed SKU and service tier all change the rate.
    assert abs(cost_of_model("gemini-2.5-pro", in_tok=1e5) - 0.125) < 1e-9
    assert abs(cost_of_model("gemini-2.5-pro", in_tok=3e5) - 0.75) < 1e-9
    assert abs(cost_of_model("claude-opus-5", 1e6, 1e6, speed="fast") - 60.0) < 1e-9
    assert abs(cost_of_model("claude-opus-5", 1e6, 1e6, service_tier="batch") - 15.0) < 1e-9

    # Prefixed / dated ids resolve; open-weight models stay unpriceable.
    assert abs(cost_of_model("us.anthropic.claude-opus-5", 1e6, 1e6) - 30.0) < 1e-9
    assert abs(cost_of_model("claude-opus-5-20260101", 1e6, 1e6) - 30.0) < 1e-9
    assert cost_of_model("llama-4-maverick", 1e6, 1e6) is None
    assert not is_priceable("llama-4-maverick")

    # FAIL CLOSED: an unknown id must never inherit a sibling's rate by prefix.
    # `claude-opus-4-9` inheriting `claude-opus-4` priced a hypothetical new Opus at
    # the retired $15/$75 -- a 3x overstatement with no catalog diff to review.
    # Must stay byte-identical in behaviour to entryMatches() in models.js.
    for unknown in ("claude-opus-4-9", "claude-sonnet-5-2", "gpt-5.6",
                    "gpt-5-codex", "o3-deep-research", "claude-opus-6", "grok-5"):
        assert not is_priceable(unknown), unknown + " must be unpriceable"
        assert cost_of_model(unknown, 1e6, 1e6) is None, unknown + " must price as None"

    # Promotional windows are evaluated against the date the call happened, and the
    # DEFAULT is today -- never CATALOG_AS_OF, which would hold an expired window open
    # forever. Sonnet 5's launch pricing ($2/$10) ends 2026-08-31; from 2026-09-01 the
    # standard $3/$15 must apply with no catalog change.
    assert abs(cost_of_model("claude-sonnet-5", 1e6, 1e6, at="2026-08-06") - 12.0) < 1e-9
    assert abs(cost_of_model("claude-sonnet-5", 1e6, 1e6, at="2026-08-31") - 12.0) < 1e-9
    assert abs(cost_of_model("claude-sonnet-5", 1e6, 1e6, at="2026-09-01") - 18.0) < 1e-9
    assert today_utc() >= "2026-01-01" and len(today_utc()) == 10
    assert estimate_call("totally-unknown", 1_000_000, 1_000_000, "haiku")["saved"] == 0.0
    assert estimate_call("llama-4-maverick", 1_000_000, 1_000_000, "haiku")["saved"] == 0.0

    # SIGNED, NOT CLAMPED. Reachable through the rate SHAPE, not through a mis-tiered
    # name: gemini-2.5-pro bills input at $1.25/Mtok and its sonnet route target
    # gemini-3.5-flash at $1.50, so an input-heavy call costs MORE on the "cheaper" model.
    # A blended 1M-in/1M-out comparison hides it ($11.25 vs $10.50 -- a saving), which is
    # why this check is written at the mix that exposes it.
    _neg = estimate_call("gemini-2.5-pro", 100_000, 10_000, "sonnet")
    assert _neg["downgraded"] and _neg["priceable"]
    assert _neg["saved"] < 0, _neg
    assert abs(_neg["saved"] - (0.225 - 0.24)) < 1e-9, _neg
    assert _neg["gross"] == 0.0 and abs(_neg["extra"] - 0.015) < 1e-9, _neg
    assert estimate_call("gemini-2.5-pro", 1_000_000, 1_000_000, "sonnet")["saved"] > 0, \
        "the blended mix hides the inversion -- keep BOTH mixes in this check"

    # TWO QUESTIONS, TWO DATES. `actual_cost` is the row's own day; both legs of `saved`
    # are TODAY. On 2026-09-01 Sonnet 5's promo has lapsed ($18) while today's price is
    # still the promo ($12) -- so a frame substitution here shows up as a non-zero saving
    # on a call that was never downgraded.
    _hist = estimate_call("claude-sonnet-5", 1_000_000, 1_000_000, "sonnet", "2026-09-01")
    assert abs(_hist["actual_cost"] - 18.0) < 1e-9, _hist
    assert abs(_hist["baseline_cost"] - 12.0) < 1e-9, _hist
    assert _hist["saved"] == 0.0, "no downgrade means no saving, whatever the dates"

    # THE MEMO MUST NOT FLATTEN THE DATE. Repeat the promo-boundary checks above in the
    # order that a single-key cache would get wrong -- warm on one side of the boundary,
    # then ask for the other -- and in the reverse order too, so neither warming order
    # can be the one that happens to work.
    for _first, _second in (("2026-08-31", "2026-09-01"), ("2026-09-01", "2026-08-31")):
        _want = {"2026-08-31": 12.0, "2026-09-01": 18.0}
        assert abs(cost_of_model("claude-sonnet-5", 1e6, 1e6, at=_first)
                   - _want[_first]) < 1e-9, _first
        assert abs(cost_of_model("claude-sonnet-5", 1e6, 1e6, at=_second)
                   - _want[_second]) < 1e-9, (_first, _second)
    # Priceability is asked at the same date as the price.
    assert is_priceable("claude-sonnet-5", "2026-09-01")
    assert not is_priceable("llama-4-maverick", "2026-09-01")

    # The O(1) index picks the SAME entry OBJECT the brute-force scan picked, for every
    # id and alias the catalog publishes. Identity, not equality: two entries with equal
    # rates would hide a tie-break change that a later price edit would then expose.
    for _e in CATALOG:
        for _id in [_e["id"]] + list(_e.get("aliases") or []):
            _scan = None
            for _cand in CATALOG:
                if _entry_matches(canonical(_id), _cand):
                    _scan = _cand
                    break
            assert _catalog_index().get(canonical(_id)) is _scan, _id

    print("pricing.py self-checks passed (catalog as of %s)" % CATALOG_AS_OF)
