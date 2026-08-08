"""Lightweight, dependency-free monitoring for the Cheaper gateway.

Every routing decision is recorded to a SQLite file so the CLI, the desktop app,
and the /dashboard endpoint can show that routing is actually happening and how much
it's saving. SQLite (stdlib) keeps it durable across restarts with zero extra deps.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone

import periods

# Real-dollar pricing (shared with the `peek` CLI). Guarded so the gateway still
# runs if pricing.py is absent — it then falls back to the tier-weight estimate.
try:
    # NOTE: `estimate_call` and `cost_of` are deliberately NOT imported. Both resolve
    # rates at pricing.today_utc() with no way to ask for the row's own day, so any use
    # of them here restates history the moment a promotional window opens or shuts.
    # summary() used both; see the top-tier baseline and the unpriceable branch below.
    # `is_priceable` takes an `at=` (mirroring isPriceable(modelId, {at}) in pricing.js)
    # and EVERY call from this module passes the row's own day. Asking "is this model
    # priceable?" at today while pricing it at the row's date is the same frame
    # substitution `at` exists to close -- it just fails as a wrong NAME rather than a
    # wrong dollar. See the baseline/top ranking in summary().
    from pricing import (  # type: ignore
        detect_family, cost_of_model, is_priceable, representative_for,
        CATALOG_AS_OF,
    )
    _PRICING = True
except Exception:  # pragma: no cover - transitional / import-order safety
    _PRICING = False


def _pday(ts, tzo):
    """The row's own LOCAL calendar day, ``YYYY-MM-DD`` -- its price date.

    A historical figure must not move when a promo window shuts, so a row prices at the
    rates in force on ITS day. Which day that is used to be answered here with the UTC
    date while ``store.derive_row`` answered it with ``pday`` (``ts + tzo``); for a call
    logged on a UTC-7 evening the two frames named different dates, and with the
    ``claude-sonnet-5`` promotional window ending 2026-08-31 that was a 50% dollar
    difference on both input and output between ``/logs`` and ``/api/v1/logs``.

    There is now ONE frame. ``tzo`` is the offset frozen on the row at write time; a
    legacy row stored before that column existed has ``tzo IS NULL`` -- a real state,
    not a zero -- and is reconstructed by ``periods.local_offset_minutes``, the same
    helper ``reporting.py`` falls back to, so both layers land on the same date for the
    same row by construction rather than by coincidence.
    """
    try:
        ms = float(ts) * 1000.0
    except (TypeError, ValueError):
        return None
    return periods.pday_of(ms, _effective_tzo(ts, tzo))


def _effective_tzo(ts, tzo):
    """The row's UTC offset in minutes east: frozen if stored, reconstructed if NULL,
    or ``None`` when it is neither -- ``int | None``.

    Never defaults to 0. A missing offset is not "UTC" -- it is "unknown", and
    silently reading it as UTC is precisely the bug this column exists to close. The
    same reason ``periods.local_offset_minutes`` answers None rather than 0 for an
    instant whose machine offset it cannot determine: passing that None straight through
    makes the row UNDATABLE (``pday_of`` returns None, the row is counted as an
    exclusion), which is a truthful state, where a 0 would have been a fabricated frame.
    """
    if tzo is not None:
        try:
            return int(tzo)
        except (TypeError, ValueError):
            pass
    try:
        ms = float(ts) * 1000.0
    except (TypeError, ValueError):
        return None
    return periods.local_offset_minutes(ms)


# The widest epoch-SECOND window `periods.pday_of` can render as a calendar day, i.e.
# years 1..9999. `decisions.ts` is in SECONDS; the event store and periods.js use
# MILLISECONDS, and that unit confusion is built into the codebase -- a millisecond
# value written here (ts=1700000000000.0) lands in year 55840, which the read path
# cannot represent at all. The write path must refuse exactly what the read path cannot
# render, or one poisoned row takes out the whole audit log instead of itself.
TS_MIN_S = -62135596800.0        # 0001-01-01T00:00:00Z
TS_MAX_S = 253402300799.0        # 9999-12-31T23:59:59Z


def _age_days(as_of: str):
    """Whole days since the catalog was transcribed, or None if unparseable."""
    try:
        d = datetime.strptime(as_of, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        return max(0, (datetime.now(timezone.utc) - d).days)
    except Exception:
        return None


def _clean_tool(src: str) -> str:
    s = (src or "").strip()
    return s[:48] if s else "unknown"


# --- the counterfactual arm's PROMPT-CACHE STATE ------------------------------
#
# A prompt cache is keyed on (model, exact prefix), so CHANGING MODEL INVALIDATES IT.
# The served model starts cold and pays a cache CREATE for a prefix the un-switched
# baseline model would still have held and merely READ.
#
# Both legs of every subtraction in this module are priced off ONE token split -- the
# SERVED arm's `kw` -- so the baseline is charged CREATE for those tokens too. Every
# entry in model_prices.json prices a write at or above a read (75/75 verified;
# claude-opus-5 reads at 0.1x input and writes at 1.25x, a 12.5x spread, so a
# 200k-token prefix is $0.10 to read against $1.25 to rewrite). That substitution can
# only ever move the baseline UP and the claimed saving with it: the error is
# ONE-DIRECTIONAL and never understates.
#
# It is not always present, and re-pricing every switched row would be the mirror-image
# fabrication. Two shapes have to be told apart:
#
#   * SERVED ARM WARM (cache_read > 0). Its prefix was already resident, so the CREATE
#     on this call is NEW content appended since the previous turn -- content the
#     baseline model would have had to create too. Both arms pay CREATE, the served
#     split IS the counterfactual split, and the existing pricing is exactly right.
#   * SERVED ARM COLD (cache_read == 0) WITH A CREATE. The prefix was written from
#     scratch, and two histories produce that identical row: either the prefix was new
#     to the session (the baseline model was cold too and would also have paid CREATE,
#     so the figure is right), or the prefix was resident on the baseline model and the
#     SWITCH forced the rewrite (the figure is overstated by the full write-read
#     spread). Nothing recorded separates them -- no prefix hash, no cache lineage, no
#     per-block provenance; providers report ONE scalar create count per call.
#
# So the honest counterfactual for a cold-start switched row is an INTERVAL whose sign
# the evidence cannot settle. Invariant 4: the row makes NO claim, is labelled
# `cache_state_indeterminate`, and is COUNTED in counts.unpriced so the exclusion is
# visible rather than arriving as a quietly smaller total.
#
# A row that did NOT switch model is untouched to the cent -- `served == original`
# means both arms are the same model on the same split, so the two costs are equal and
# the saving is zero under every cache assumption, and the switch test below means such
# a row can never reach this branch.
#
# MUST stay behaviourally identical to
# `cli/src/peek/derive.js::cacheStateIndeterminate`. `gateway/app/store.py::derive_row`
# is a third reader of the same question over the event store and does NOT yet carry the
# rule; until it does, the two readers disagree on exactly these rows.
def _cache_state_indeterminate(served, original, cache_read, cache_create) -> bool:
    if not served or not original:
        return False                       # no counterfactual to bias
    if str(served) == str(original):
        return False                       # NO SWITCH -> nothing was invalidated
    if not (cache_create or 0) > 0:
        return False                       # nothing was written
    return not (cache_read or 0) > 0       # ...and the served arm was COLD

# Relative $/Mtok input weights for the legacy tier-weight estimate below. Only the
# RATIOS matter here, but they still have to be the ratios of models that exist:
# these are the input rates of the current Anthropic representatives in
# model_prices.json (Haiku 4.5 $1, Sonnet 5 $3, Opus 5 $5). The old 1:3:15 spread
# was the retired Opus 4 rate and overstated top-tier work threefold. The real-dollar
# figures the user actually sees come from pricing.py per row, not from this table.
DEFAULT_PRICE = {"haiku": 1.0, "sonnet": 3.0, "opus": 5.0}


def _price() -> dict:
    out = {}
    for tier, dflt in DEFAULT_PRICE.items():
        try:
            out[tier] = float(os.environ.get(f"CHEAPER_PRICE_{tier.upper()}", dflt))
        except ValueError:
            out[tier] = dflt
    return out


# --- Reasoning effort + time model (illustrative, measure-only) ---------------
# Cheaper routes the MODEL for real (realized $ savings). Reasoning effort is only
# MEASURED here: on a triage-simple request that asked for high reasoning, we show
# how many thinking tokens and how much wall-clock could be saved by lowering it —
# without altering the request. All figures are coarse, tunable ballparks.
_EFFORT_RANK = {"none": 0, "low": 1, "medium": 2, "high": 3}
# thinking tokens a given effort level typically burns (potential token saving).
_THINK_TOKENS = {"none": 0, "low": 600, "medium": 2500, "high": 8000}
# wall-clock seconds: a base per model tier + extra per reasoning effort.
_LAT_TIER = {"haiku": 1.2, "sonnet": 3.0, "opus": 7.0}
_LAT_EFFORT = {"none": 0.0, "low": 1.5, "medium": 6.0, "high": 18.0}


def normalize_effort(value) -> str:
    """Map an assortment of request shapes to none|low|medium|high."""
    if value is None:
        return "none"
    v = str(value).strip().lower()
    if v in _EFFORT_RANK:
        return v
    if v in ("minimal", "off", "disabled", "false", "0"):
        return "none"
    if v in ("max", "maximum", "xhigh", "extra"):
        return "high"
    return "none"


def _source_bucket(src: str) -> str:
    s = (src or "").lower()
    if "subagent" in s or "sidechain" in s or "sub-agent" in s:
        return "subagent"
    if s and s != "unknown":
        return "user"
    return "other"


# Cost-ordered tier ranks for the Logs decision-type derivation. Kept separate from
# any capability ranking on purpose: the only thing that matters for "downgrade vs
# escalate" is whether the SERVED tier is cheaper or dearer than what was REQUESTED.
_TIER_RANK = {"haiku": 0, "sonnet": 1, "opus": 2}


def _decision_type(requested_tier, routed_tier) -> str:
    """Classify a routed row for the Logs table.

    downgrade -> routed to a cheaper tier than requested (the money-saving case).
    escalate  -> routed to a dearer tier than requested.
    kept      -> same tier, or either side unknown (e.g. the OpenAI front-end never
                 records a requested tier, so its rows read as 'kept' rather than
                 being mislabelled as a downgrade).
    """
    rq = _TIER_RANK.get((requested_tier or "").strip().lower())
    rt = _TIER_RANK.get((routed_tier or "").strip().lower())
    if rq is None or rt is None:
        return "kept"
    if rt < rq:
        return "downgrade"
    if rt > rq:
        return "escalate"
    return "kept"


def row_is_priceable(status, usage_source) -> tuple[bool, str]:
    """May this row contribute to a DOLLAR figure? Returns (ok, reason_when_not).

    Two independent exclusions, both fail-closed:

    * ``usage_source == 'estimate'`` -- nobody reported usage for this call, so any
      figure derived from it is a guess wearing a measurement's clothes.
    * a status the gateway actually observed that is outside 2xx -- Claude Code retries
      ``overloaded_error`` and 429s automatically, and each retry gets a DISTINCT
      ``anthropic-request-id``, so the provider key cannot collapse them. A six-retry
      storm on one turn would otherwise book six times the saving for one delivered
      answer.

    Status ``0``/NULL means UNKNOWN, not "failed": every row written before the column
    was populated reads as 0, and excluding those would blank the whole existing
    ledger. Unknown-status rows are priced and counted separately so the ambiguity is
    visible rather than assumed away.
    """
    if (usage_source or "").strip().lower() == "estimate":
        return False, "estimated_usage"
    try:
        st = int(status or 0)
    except (TypeError, ValueError):
        st = 0
    if st and not (200 <= st < 300):
        return False, "non_2xx"
    return True, ""


def _period_starts(now: datetime | None = None) -> dict:
    """Epoch-second lower bounds for Today / week / month / quarter / year / all-time,
    computed in LOCAL time so the buckets line up with the user's wall clock. A row
    counts toward a period when its ts is >= that period's start."""
    now = now or datetime.now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week = today - timedelta(days=today.weekday())          # Monday-anchored week
    month = today.replace(day=1)
    quarter = today.replace(month=((now.month - 1) // 3) * 3 + 1, day=1)
    year = today.replace(month=1, day=1)
    return {
        "today": today.timestamp(),
        "week": week.timestamp(),
        "month": month.timestamp(),
        "quarter": quarter.timestamp(),
        "year": year.timestamp(),
        "all": 0.0,
    }


# --- IS THE DATA LIVE? --------------------------------------------------------
#
# A row that ARRIVED within this many seconds of now is the only evidence this module
# accepts for "traffic is flowing". It is a statement about DATA, never about a socket.
#
# The Monitor rendered a green "live" dot off the /ws connection being open. /ws only
# pushes when a request is ROUTED, so an idle gateway pushes nothing -- correct
# behaviour, dishonestly presented: a connected socket that has delivered nothing for
# 29 hours was indistinguishable from one delivering a call a second. A connection is
# evidence that the dashboard can HEAR the gateway. It is not evidence that the gateway
# has anything to say. `freshness.live` answers the second question, which is the one
# the dot was read as answering.
#
# SYMMETRIC WINDOW, on purpose. `live` asks whether the newest row is within
# LIVE_WINDOW_S of now IN EITHER DIRECTION: a machine whose clock runs a few seconds
# ahead writes rows dated in the future and those rows are genuinely live traffic. An
# UNBOUNDED future is not -- a row dated next year is a corrupt timestamp, and reading
# it as "live" would resurrect the same false-confidence shape one layer down. The
# signed `age_seconds` rides out beside the flag so a reader can tell the two apart.
LIVE_WINDOW_S = 120.0


# The acknowledgement a renderer MUST carry when it prints an unsubstantiated figure.
# Parametrised by COUNTS rather than by the dollar amount: counts are exact and carry no
# rounding hazard, where "$0.0001" in a sentence about a real claim reads as "$0.00" and
# turns the disclosure into the very understatement it exists to prevent.
_ACK_UNMEASURED = (
    "This figure is arithmetic over {priced} priced call(s), none of which carried "
    "provider-reported usage (usage_source is not 'body'). Nobody confirmed those token "
    "counts against a provider response, so Cheaper did not MEASURE this saving and "
    "does not claim it as one.")
_ACK_MIXED = (
    "This figure mixes {measured} priced call(s) that carried provider-reported usage "
    "with {unmeasured} that did not. A mixed population cannot be labelled measured, "
    "and the two halves are not separated here because doing so would re-run the dollar "
    "arithmetic rather than label it.")
_ACK_NONE = (
    "No call could be priced, so there is no saving to report. That is not the same "
    "claim as a saving of $0.00.")
# The `_PRICING`-unavailable arm: there is a published figure and there are ZERO priced
# rows behind it, so _ACK_UNMEASURED's "arithmetic over N priced call(s)" would read
# "over 0" and describe nothing. The figure is real; it just comes from somewhere else.
_ACK_LEGACY_ESTIMATE = (
    "The pricing catalog is unavailable, so this figure is the legacy TIER-WEIGHT "
    "ESTIMATE over every recorded row -- not a per-row price, and not a measurement. "
    "`catalog.priced` is false for the same reason.")


def _headline(dollars_basis: str, saved: float, priced: int, measured: int) -> dict:
    """The ONE surface on this payload a renderer may print as a MEASURED saving.

    WHY THIS EXISTS AT ALL, AND WHY `dollars.saved` IS NOT NULLED INSTEAD
    --------------------------------------------------------------------
    The owner's store holds 94 rows with ``usage_source`` NULL on every one of them --
    the gateway's measured path has never fired against it -- and four of those rows
    carry the entire $80.52 the dashboard prints under a headline that reads as
    measured. `usage_source IS NULL` does not mean the arithmetic is wrong; it means
    NOBODY EVER CONFIRMED THOSE TOKEN COUNTS AGAINST A PROVIDER RESPONSE. The numbers
    are whatever the request body implied, not what was billed.

    Two honest treatments were available and the choice is not obvious:

      * WITHHOLD (invariant 4: unpriceable -> no claim, labelled, counted). Invariant 4
        governs rows the module CANNOT COMPUTE -- no catalog rate, no derivable day, an
        undetermined counterfactual. These rows are not that. Every input to the
        subtraction is present and every rate resolves; what is missing is PROVENANCE on
        the inputs. Withholding a computable figure teaches the reader nothing about why
        it is doubted, and it would also have meant re-computing `dollars`, which the
        shared contract forbids in terms ("additive labelling, not a re-computation") --
        `dollars.saved` is consumed by `cheaper peek --tagline`, by `baselines`, by the
        period roll-up and by the cross-runtime parity gates, and silently blanking it
        would break four consumers to fix one renderer.
      * PUBLISH LABELLED. Chosen. The arithmetic stays exactly where it was and this
        block states, in the payload, what population it came from.

    A LABEL NOBODY IS FORCED TO READ IS NOT A FIX, so the label is load-bearing rather
    than advisory:

      * `saved` -- the ONLY key here a consumer may render as a measured saving -- is
        ``None`` unless every priced row carried ``usage_source == 'body'``. The lazy
        path (read the obvious key, print it) therefore renders nothing, which is the
        correct output for an unmeasured population.
      * the figure is still available, under `unsubstantiated_saved`. A renderer that
        wants to show it has to TYPE THAT WORD, which makes showing it a decision
        somebody made rather than a default nobody noticed.
      * `acknowledgement` is the sentence that must appear beside it. Non-empty exactly
        when `saved` is None.

    RESIDUAL RISK, STATED RATHER THAN HIDDEN: a legacy consumer reading `dollars.saved`
    directly still gets the unlabelled number. That is the price of not re-computing,
    and it is why `measurement.dollars_basis` exists as a sibling of the dollars -- one
    scalar, checkable in a conditional, that says whether `dollars` may be described as
    measured. dashboard.html and report.html are the two renderers that must consult it.
    """
    if dollars_basis == "measured":
        return {"saved": saved, "unsubstantiated_saved": None,
                "withheld_reason": "", "acknowledgement": ""}
    if dollars_basis == "mixed":
        return {"saved": None, "unsubstantiated_saved": saved,
                "withheld_reason": "mixed_usage",
                "acknowledgement": _ACK_MIXED.format(
                    measured=measured, unmeasured=max(0, priced - measured))}
    if dollars_basis == "none":
        # `saved` is 0.0 here and publishing it would say "we measured a saving of
        # $0.00" about a window in which nothing was priced at all -- the exact
        # "$0 vs we weren't watching" collapse reporting.py refuses one layer up.
        return {"saved": None, "unsubstantiated_saved": None,
                "withheld_reason": "no_priced_calls", "acknowledgement": _ACK_NONE}
    return {"saved": None, "unsubstantiated_saved": saved,
            "withheld_reason": "unmeasured_usage",
            "acknowledgement": (_ACK_LEGACY_ESTIMATE if priced == 0
                                else _ACK_UNMEASURED.format(priced=priced))}


# How many times record() will re-attempt a write that SQLite refused with
# OperationalError, and how long it waits between attempts (doubling each time, so
# 50ms + 100ms on top of the 5s busy timeout each attempt already carries).
#
# BOUNDED on purpose. record() runs inside the proxied request's completion callback;
# an unbounded retry would hold a routed response open behind a lock contest. Three
# attempts covers the case this exists for -- a reader (the CLI opening metrics.db)
# holding a SHARED lock right as the gateway commits -- and anything that survives all
# three is a real outage, which must be COUNTED and raised, not waited out.
WRITE_ATTEMPTS = 3
WRITE_BACKOFF_S = 0.05


class Metrics:
    def __init__(self, db_path: str | None = None):
        self.db_path = db_path or os.environ.get(
            "CHEAPER_DB", os.path.join(os.path.expanduser("~"), ".cheaper", "metrics.db"))
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._lock = threading.Lock()
        self.price = _price()
        # Writes refused because their timestamp is outside the representable calendar.
        # COUNTED, not swallowed: record() also raises, so the refusal is visible at the
        # call site AND tallied here for anyone inspecting the store afterwards. A
        # silent drop would shrink the denominator without saying so.
        self.rejected_ts = 0
        # --- durability counters (PROCESS-LOCAL; see summary()["durability"]) -------
        # Writes that SQLite refused on every attempt. The call site cannot report them:
        # app.py fires record() from `_fire()`, which is wrapped in
        # `except Exception: pass  # metrics must never break the proxied response`. So
        # the exception record() raises is swallowed one frame up and a routed call
        # would vanish from the ledger with NO trace anywhere. This counter is that
        # trace. It is not a substitute for the raise -- both happen.
        self.write_failures = 0
        # Retries that were needed but eventually succeeded. Zero drops, but a rising
        # number is the early warning that lock contention is approaching the point
        # where write_failures starts moving.
        self.write_retries = 0
        # INSERT OR IGNORE rows the partial unique index on request_id suppressed. The
        # suppression is the POINT (it is what makes a replayed write idempotent instead
        # of a double count), but `cursor.rowcount` was never inspected, so "stored" and
        # "silently discarded as a duplicate" were the same observable: both returned
        # None. A duplicate storm and a working gateway looked identical.
        self.duplicate_suppressed = 0
        # The journal mode the store actually ENDED UP IN, read back from SQLite rather
        # than assumed from the PRAGMA we sent. WAL can be refused -- a network
        # filesystem, read-only media, or another process holding the database at the
        # moment of the one-time upgrade -- and a gateway silently running on the default
        # rollback journal is exactly the state this whole change exists to make
        # visible. Surfaced in summary(); never asserted.
        self.journal_mode = ""
        # Non-empty when the WAL upgrade was REFUSED, carrying SQLite's own reason. The
        # refusal is not fatal (the store still works, just without WAL's reader/writer
        # concurrency) and it is not hidden either -- both facts ride out in
        # summary()["durability"].
        self.journal_mode_error = ""
        with closing(self._conn()) as c:
            # WAL, set ONCE here because the mode is persisted in the database header.
            #
            # The default rollback journal needs an EXCLUSIVE lock to commit, and cannot
            # take one while any reader holds SHARED. self._lock serialises the
            # gateway's OWN writers inside this single uvicorn process, so the exposure
            # is EXTERNAL: `cheaper peek`, the desktop app, or a `sqlite3` shell reading
            # ~/.cheaper/metrics.db can block the gateway's writer past the 5s busy
            # timeout, and the OperationalError that follows is swallowed by app.py.
            # Under WAL, readers and one writer proceed CONCURRENTLY -- the reader takes
            # no lock the writer needs -- so the contest that dropped the row does not
            # arise in the first place. The retry in record() is the backstop, not the fix.
            #
            # The one-time upgrade needs a moment of exclusive access, so a reader that
            # happens to hold the database as the gateway starts can refuse it with
            # SQLITE_BUSY. That must NOT take the gateway down -- app.py builds METRICS
            # at import, so raising here turns a transient lock into a dead proxy. It is
            # recorded and re-read instead: `journal_mode` then reports whatever mode is
            # genuinely in force, which is the honest answer and the visible one. This is
            # the file's existing "count it, surface it, never assume it" pattern, not a
            # swallow -- nothing is discarded, and no figure is fabricated.
            try:
                _mode = c.execute("PRAGMA journal_mode=WAL").fetchone()
            except sqlite3.OperationalError as e:
                self.journal_mode_error = str(e)[:200]
                _mode = c.execute("PRAGMA journal_mode").fetchone()
            self.journal_mode = (_mode[0] if _mode else "") or ""
            c.execute("""
                CREATE TABLE IF NOT EXISTS decisions (
                    ts REAL, tier TEXT, model TEXT, original_model TEXT,
                    requested_tier TEXT, reason TEXT, source TEXT,
                    in_tokens INTEGER, out_tokens INTEGER, status INTEGER
                )""")
            # Additive migration: reasoning effort the caller requested (measure-only).
            try:
                c.execute("ALTER TABLE decisions ADD COLUMN requested_effort TEXT")
            except sqlite3.OperationalError:
                pass  # column already exists
            # Additive migration: the prompt-cache split. Cache reads bill at ~0.1x
            # fresh input and 1-hour writes at 2x, so a row without this breakdown is
            # priced as if every input token were fresh -- badly wrong for any harness
            # that uses prompt caching, which is most of them.
            for _col in ("cache_read", "cache_create_5m", "cache_create_1h"):
                try:
                    c.execute(f"ALTER TABLE decisions ADD COLUMN {_col} INTEGER DEFAULT 0")
                except sqlite3.OperationalError:
                    pass  # column already exists
            # Additive migration: the chat/session id, so peek can attribute EXACT
            # realized savings to ONE conversation for the end-of-chat tagline.
            try:
                c.execute("ALTER TABLE decisions ADD COLUMN session TEXT")
            except sqlite3.OperationalError:
                pass  # column already exists
            # Additive migration: the PROVIDER's own idempotency key, plus how the
            # token counts on this row were obtained.
            #
            #   request_id  `anthropic-request-id` / `request-id` / `x-request-id`.
            #               Measured 1:1 with the API call over 12,741 transcript rows
            #               (0 of 5,127 request ids mapped to more than one message id).
            #               It is the join key the per-call event store dedupes on --
            #               and, critically, it SURVIVES a resume/fork/rotate, which a
            #               positional index or a content hash does not.
            #   message_id  the assistant message id, a second strong key for the
            #               buffered path where the body is in hand.
            #   usage_source 'body'    provider-reported usage  -> priceable
            #                'estimate' we had to guess         -> NEVER priced
            for _col in ("request_id", "message_id", "usage_source"):
                try:
                    c.execute(f"ALTER TABLE decisions ADD COLUMN {_col} TEXT")
                except sqlite3.OperationalError:
                    pass  # column already exists
            # Additive migration: the machine's UTC offset in MINUTES EAST at the
            # instant of THIS call (US Central summer = -300), frozen at write.
            #
            # Without it the offset had to be reconstructed at read time from the
            # machine's CURRENT zone, so a laptop that flew to another timezone
            # restated the price date -- and therefore the dollars -- of every row it
            # had already recorded. The event store (JSONL) has always frozen `tzo`;
            # this closes the same hole in SQLite.
            #
            # NO DEFAULT. Legacy rows keep tzo NULL, which is the honest value: nobody
            # recorded an offset for them. `DEFAULT 0` would assert those calls
            # happened at UTC, which is a claim, not a migration.
            try:
                c.execute("ALTER TABLE decisions ADD COLUMN tzo INTEGER")
            except sqlite3.OperationalError:
                pass  # column already exists
            # The 16 heaviest rows on the live DB are invisible to every scoped query:
            # `WHERE session = ''` does not match `session IS NULL`, so the sum of the
            # per-session totals did not equal the ungrouped total -- by 1,890,068 of
            # 1,890,408 in-tokens. Normalise the sentinel so one comparison covers both.
            c.execute("UPDATE decisions SET session = '' WHERE session IS NULL")
            # Zero indexes existed. Every query here is ORDER BY ts DESC, optionally
            # filtered by session.
            c.execute("CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts DESC)")
            c.execute("CREATE INDEX IF NOT EXISTS idx_decisions_sess "
                      "ON decisions(session, ts DESC)")
            # PARTIAL unique index: pre-migration rows all have request_id NULL and must
            # not collide with each other (SQLite treats NULLs as distinct in a plain
            # UNIQUE index, but the partial predicate makes the intent explicit and keeps
            # the index small). Paired with INSERT OR IGNORE in record(), a retried or
            # replayed write for the same provider call is a no-op instead of a double
            # count -- the single most important property of a financial record.
            c.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_decisions_rid "
                      "ON decisions(request_id) WHERE request_id IS NOT NULL")
            c.commit()

    def _conn(self):
        """One connection, with the durability pragmas this store depends on.

        `timeout=5` sets SQLite's busy_timeout to 5000ms: a blocked writer waits that
        long for the lock before raising OperationalError.

        `synchronous` is a PER-CONNECTION setting -- unlike journal_mode it is NOT
        persisted in the database header, and a fresh connection comes back at the
        FULL default. Measured on this machine: after setting NORMAL and reconnecting,
        `PRAGMA synchronous` reads 2 (FULL) again. So it has to be re-sent here, on
        every connection, or record() quietly gets none of it.

        NORMAL rather than FULL, and only because the journal is WAL: in WAL mode
        NORMAL still cannot lose a COMMITTED transaction to a process crash -- only to
        an OS/power failure, which would cost at most the last few routed calls off a
        monitoring ledger. FULL fsyncs on every commit, on a path that runs once per
        proxied request. Do not lower this to OFF: OFF can corrupt the DATABASE, not
        just lose the tail, and a corrupt ledger is unrecoverable rather than short.
        """
        c = sqlite3.connect(self.db_path, timeout=5)
        c.execute("PRAGMA synchronous=NORMAL")
        return c

    def record(self, *, tier, model, original_model, requested_tier, reason,
               source="", in_tokens=0, out_tokens=0, status=0, requested_effort="",
               session="", cache_read=0, cache_create_5m=0, cache_create_1h=0,
               request_id=None, message_id=None, usage_source=None, ts=None):
        """Append one routed call.

        `INSERT OR IGNORE` + the partial unique index on request_id makes this
        IDEMPOTENT for any call the provider gave us an id for: a retried write, a
        replayed buffer, or two code paths both recording the same forward all collapse
        to one row. Without it the store double-counts silently, which is the failure
        this whole workstream exists to eliminate.

        `in_tokens` may be None. That is a real state -- "the provider did not report
        usage" -- and it is stored as NULL rather than as a character-count guess.
        The old `len(extract_text(body)) // 4` fallback substituted the whole
        conversation's size for the FRESH input count; measured against real traffic
        that is wrong by ~34,000x, and it printed with no hedge.

        `tzo` is FROZEN here, resolved at THIS ROW'S OWN INSTANT rather than at "now":
        a backfilled or replayed write carrying an explicit `ts=` must get the offset
        that was in force then, so a DST transition -- or a machine that later changes
        timezone -- cannot restate the price date of a call already recorded.

        `ts` is RANGE-CHECKED against what the read path can render. It is in SECONDS;
        passing milliseconds (the unit periods.js and the event store use) writes a row
        in year 55840, which `periods.pday_of` cannot represent -- and every read of the
        ledger then has to carry that row. Refusing at the door raises `ValueError` at
        the call site AND increments `self.rejected_ts`, so the refusal is visible and
        counted rather than a silent drop.

        Returns True when a row was STORED and False when the partial unique index
        suppressed it as a duplicate -- and increments `self.duplicate_suppressed` on the
        latter. `cursor.rowcount` after `INSERT OR IGNORE` is 1 for a stored row and 0
        for a suppressed one (verified against this runtime: python 3.11 / sqlite
        3.38.4), and it was never inspected, so a caller could not tell an idempotent
        no-op from a write. Nor could anyone reading the store afterwards: a replay storm
        and a healthy gateway produced the same silence.

        WRITE FAILURES ARE RETRIED, THEN COUNTED, THEN RAISED. SQLite raises
        OperationalError when it cannot get the lock inside the 5s busy timeout; WAL
        (see `__init__`) removes the usual cause, `WRITE_ATTEMPTS` covers the residual
        race, and a write that still fails increments `self.write_failures` before the
        error propagates. The raise on its own is not enough: app.py fires record()
        inside `except Exception: pass  # metrics must never break the proxied
        response`, so without the counter the drop leaves no trace at any layer. Same
        pattern as `rejected_ts` -- counted AND raised, never one or the other.
        """
        us = (usage_source or "").strip().lower()
        if us not in ("body", "estimate"):
            # '' = unknown (a legacy row, or a caller that predates the column).
            # Deliberately NOT defaulted to 'body': claiming a figure is measured when
            # nobody said so is exactly the concealment shape this column exists to end.
            us = ""
        if ts is None:
            row_ts = time.time()
        else:
            try:
                row_ts = float(ts)
            except (TypeError, ValueError):
                self.rejected_ts += 1
                raise ValueError("record(ts=%r): not a number" % (ts,))
            if not (TS_MIN_S <= row_ts <= TS_MAX_S):
                self.rejected_ts += 1
                raise ValueError(
                    "record(ts=%r): outside the representable calendar "
                    "(%r..%r, epoch SECONDS). A millisecond value lands in year 55840, "
                    "which no reader can render." % (ts, TS_MIN_S, TS_MAX_S))
        row_tzo = periods.local_offset_minutes(row_ts * 1000.0)
        params = (row_ts,
                  tier, model, original_model, requested_tier,
                  reason[:300], source,
                  None if in_tokens is None else int(in_tokens),
                  None if out_tokens is None else int(out_tokens),
                  status,
                  normalize_effort(requested_effort), session or "",
                  int(cache_read or 0), int(cache_create_5m or 0), int(cache_create_1h or 0),
                  (str(request_id)[:120] or None) if request_id else None,
                  (str(message_id)[:120] or None) if message_id else None,
                  us, row_tzo)
        for attempt in range(WRITE_ATTEMPTS):
            try:
                with self._lock, closing(self._conn()) as c:
                    cur = c.execute(
                        "INSERT OR IGNORE INTO decisions "
                        "(ts, tier, model, original_model, requested_tier, reason, source, "
                        " in_tokens, out_tokens, status, requested_effort, session, "
                        " cache_read, cache_create_5m, cache_create_1h, "
                        " request_id, message_id, usage_source, tzo) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        params)
                    # Read the rowcount BEFORE commit(): commit() runs another statement
                    # on the connection and sqlite3 recomputes rowcount from the last
                    # one, so reading it afterwards answers about the COMMIT, not the
                    # INSERT.
                    stored = cur.rowcount != 0
                    c.commit()
                    # Counted only once the commit has LANDED, and inside the lock where
                    # the increment is already serialised against every other writer.
                    # Counting before the commit would tally a duplicate whose commit
                    # then failed, and the retry below would tally it a second time.
                    if not stored:
                        self.duplicate_suppressed += 1
                    if attempt:
                        self.write_retries += attempt
                return stored
            except sqlite3.OperationalError:
                # NOT swallowed, NOT logged-and-continued: retried a bounded number of
                # times, then counted and re-raised. The only thing this except decides
                # is whether to try again.
                #
                # Retrying cannot double-count. A lock error means the COMMIT did not
                # happen, and the connection closes with the transaction unwritten; on
                # top of that, `INSERT OR IGNORE` against ux_decisions_rid makes a second
                # attempt a no-op for any row the provider gave an id for. That row would
                # come back as `stored=False` and be tallied in `duplicate_suppressed`,
                # which is the truthful reading either way -- one call, one row.
                if attempt + 1 >= WRITE_ATTEMPTS:
                    with self._lock:
                        self.write_failures += 1
                    raise
                time.sleep(WRITE_BACKOFF_S * (2 ** attempt))
        # Unreachable while WRITE_ATTEMPTS >= 1: every iteration returns, raises, or
        # sleeps and retries. Here so that a future WRITE_ATTEMPTS <= 0 fails LOUDLY
        # instead of falling out of the loop and returning None, which would drop every
        # write in silence -- the exact failure shape this method was hardened against.
        raise RuntimeError(
            "record(): WRITE_ATTEMPTS=%r left no attempt to make" % (WRITE_ATTEMPTS,))

    def logs(self, *, limit: int = 100, offset: int = 0,
             session: str | None = None) -> dict:
        """Paginated, most-recent-first feed of routing decisions for the Logs table.

        Each row prices BOTH legs at their exact models so the table can show the real
        realized cost delta: `original_cost` is what the caller's requested model would
        have cost at this row's tokens, `actual_cost` is what the served model cost,
        and `savings` is their signed difference (negative on an escalation). Cache
        splits and the row's historical price date are honoured, exactly like summary()
        -- so a row's numbers here reconcile with the aggregate figures elsewhere.

        The price date is the row's ``pday`` (``ts + tzo``, its own LOCAL calendar day),
        the same frame ``store.derive_row`` prices at. Each row therefore carries its
        ``tzo`` and ``pday`` outward, so ``reporting.gateway_row_to_event`` consumes the
        values this row was priced with rather than deriving its own -- the two layers
        agree by construction, not by two implementations happening to match.

        `session` mirrors summary()'s semantics: None = whole ledger; a present value
        (including "") scopes to that chat and never silently widens.
        """
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = 100
        try:
            offset = int(offset)
        except (TypeError, ValueError):
            offset = 0
        limit = max(1, min(limit, 1000))
        offset = max(0, offset)
        where = " WHERE session = ?" if session is not None else ""
        sp = (session,) if session is not None else ()
        with closing(self._conn()) as c:
            total = c.execute("SELECT COUNT(*) FROM decisions" + where, sp).fetchone()[0] or 0
            raw = c.execute(
                "SELECT ts, tier, model, original_model, requested_tier, reason, source, "
                "in_tokens, out_tokens, "
                "COALESCE(cache_read,0), COALESCE(cache_create_5m,0), COALESCE(cache_create_1h,0), "
                "COALESCE(session,''), COALESCE(status,0), COALESCE(usage_source,''), "
                "COALESCE(request_id,''), tzo "
                "FROM decisions" + where + " ORDER BY ts DESC LIMIT ? OFFSET ?",
                sp + (limit, offset)).fetchall()
        rows = []
        for (ts, tier, served, om, rtier, reason, src, it, ot, cr, c5, c1,
             sess, status, usrc, rid, tzo) in raw:
            it = it or 0
            ot = ot or 0
            # NOT COALESCE(tzo,0): a NULL offset means "not recorded", and reading it
            # as UTC would be a fabricated claim. Reconstructed instead, by the one
            # helper reporting.py also falls back to.
            eff_tzo = _effective_tzo(ts, tzo)
            pday = _pday(ts, tzo)
            original_cost = actual_cost = savings = None
            ok, why = row_is_priceable(status, usrc)
            # A row whose own day cannot be derived is UNPRICEABLE. Passing at=None to
            # cost_of_model silently falls back to pricing.today_utc(), which is the one
            # substitution this whole frame exists to prevent: it would price a row we
            # cannot even date at today's promo state.
            if ok and pday is None:
                ok, why = False, "undatable"
            if _PRICING and ok:
                kw = dict(cache_read=cr or 0, cache_create_5m=c5 or 0,
                          cache_create_1h=c1 or 0, at=pday)
                original_cost = cost_of_model(om, it, ot, **kw)
                actual_cost = cost_of_model(served, it, ot, **kw)
                if original_cost is not None and actual_cost is not None:
                    savings = original_cost - actual_cost
                elif not why:
                    why = "model_not_in_catalog"
                # A cold-start call on a SWITCHED model has no recoverable counterfactual
                # cache state (see _cache_state_indeterminate). `actual_cost` is a FACT
                # and stays -- it is priced on the model that really ran, at that model's
                # own split. `original_cost` is the counterfactual, and it is the thing
                # that is not knowable, so it and the saving derived from it are both
                # withheld and LABELLED. The Logs table renders an em dash with the label
                # as its tooltip; it never renders $0.00 for this.
                if _cache_state_indeterminate(served, om, cr or 0,
                                              (c5 or 0) + (c1 or 0)):
                    original_cost = None
                    savings = None
                    why = why or "cache_state_indeterminate"
            rows.append({
                "ts": ts,
                # The time frame this row was PRICED in, carried outward so no consumer
                # has to re-derive it and land somewhere else. `tzo` is the effective
                # offset (frozen when the row has one, reconstructed when it does not);
                # `pday` is `ts + tzo` and is the exact `at=` the costs above used.
                "tzo": eff_tzo,
                "pday": pday,
                "source": src or "",
                "original_model": om or "",
                "routed_model": served or "",
                "decision_type": _decision_type(rtier, tier),
                "original_cost": round(original_cost, 6) if original_cost is not None else None,
                "actual_cost": round(actual_cost, 6) if actual_cost is not None else None,
                "savings": round(savings, 6) if savings is not None else None,
                # The Logs table renders an em dash with this as its tooltip, never
                # "$0.00" -- zero is a measured result and "no claim made" is not.
                "unpriced_reason": why or ("model_not_in_catalog"
                                           if (_PRICING and savings is None) else ""),
                # basis/grain are NON-HIDEABLE columns in the Logs view and appear in
                # every export row. A later "simplify the table" change that drops them
                # would silently re-mix measured and estimated figures in one column.
                "basis": "measured" if (usrc or "") == "body" else (
                    "estimated" if (usrc or "") == "estimate" else "unknown"),
                "grain": "call",
                # Extra context the Logs/Monitor UI uses but which is not part of the
                # required column set.
                "tier": tier or "",
                "requested_tier": rtier or "",
                "reason": reason or "",
                "session": sess or "",
                "status": int(status or 0),
                "request_id": rid or "",
                "in_tokens": it,
                "out_tokens": ot,
                "cache_read": cr or 0,
                "cache_create_5m": c5 or 0,
                "cache_create_1h": c1 or 0,
            })
        return {"rows": rows, "total": total}

    def summary(self, *, ts_bucket: int = 3600, max_rows: int = 5000,
                session: str | None = None) -> dict:
        # Optional per-chat scoping: `cheaper peek --tagline` passes ?session=<id> so
        # the end-of-chat line reports EXACT realized savings for one conversation
        # instead of the whole rolling ledger.
        # Distinguish None (no filter → whole ledger, e.g. the dashboard) from a
        # present session value (scope to that chat). An EMPTY string is a real value,
        # so a blank ?session= scopes to the empty-session rows — it never silently
        # falls back to the whole ledger and over-exposes other chats.
        where = " WHERE session = ?" if session is not None else ""
        sp = (session,) if session is not None else ()
        with closing(self._conn()) as c:
            rows = c.execute("SELECT tier, COUNT(*), SUM(in_tokens), SUM(out_tokens) "
                             "FROM decisions" + where + " GROUP BY tier", sp).fetchall()
            total = c.execute("SELECT COUNT(*) FROM decisions" + where, sp).fetchone()[0] or 0
            recent = c.execute(
                "SELECT ts, tier, original_model, reason, source FROM decisions" + where +
                " ORDER BY ts DESC LIMIT 20", sp).fetchall()
            # `model` is the model Cheaper actually SERVED. record() has always written
            # it; this SELECT used to omit it, which forced the cost of the routed leg
            # to be guessed from the family's tier representative instead of read from
            # the row. That guess over-reported savings on the one path that prints an
            # exact figure with no "about" qualifier.
            detail = c.execute(
                "SELECT ts, tier, original_model, in_tokens, out_tokens, source, "
                "requested_tier, requested_effort, model, "
                "COALESCE(cache_read,0), COALESCE(cache_create_5m,0), COALESCE(cache_create_1h,0), "
                "COALESCE(status,0), COALESCE(usage_source,''), tzo "
                "FROM decisions" + where + " ORDER BY ts DESC LIMIT ?",
                sp + (max_rows,)).fetchall()
            # The newest row's instant, asked of SQLite DIRECTLY rather than read off
            # `detail[0]`. `detail` is capped at `max_rows` and `MAX(ts)` is not, so the
            # two agree today and would silently diverge the moment a caller passed a
            # small cap -- and this is the one figure on the summary whose whole job is
            # to say whether anything is arriving. It is also NULL-safe in a way the
            # ORDER BY is not: SQLite sorts NULLs LAST under DESC, so `detail[0]` happens
            # to be the newest non-NULL row, but only by an ordering detail nothing
            # states. `MAX()` ignores NULLs by definition.
            newest_ts = c.execute(
                "SELECT MAX(ts) FROM decisions" + where, sp).fetchone()[0]
        by_tier = {t: {"count": n, "in_tokens": it or 0, "out_tokens": ot or 0}
                   for (t, n, it, ot) in rows}

        # --- THE MEASUREMENT CENSUS ------------------------------------------------
        #
        # WHAT POPULATION DO THE DOLLARS ABOVE ACTUALLY DESCRIBE? Every figure on this
        # summary was published without an answer, and on the owner's live store the
        # answer turns out to be "four rows nobody ever measured".
        #
        # Counted in its OWN pass, deliberately:
        #   * it runs whether or not `_PRICING` is available, so the labels never vanish
        #     in the one configuration where the dollars are a tier-weight ESTIMATE and
        #     the labelling matters most;
        #   * it touches no dollar accumulator, which is what makes this additive
        #     labelling rather than a re-computation of anything.
        #
        # SCOPE is exactly `counts.examined` -- the same `detail` rows every aggregate
        # below is built from, session-scoped and capped at `max_rows` -- so
        # `measured_calls + unmeasured_calls == counts.examined` by construction. The
        # tuple is unpacked by name rather than indexed so that a change to the SELECT
        # above breaks here loudly instead of quietly re-pointing a column.
        measured_calls = 0
        unmeasured_calls = 0
        zero_token_calls = 0
        zero_output_calls = 0
        output_bearing_calls = 0
        for (_ts, _tier, _om, _it, _ot, _src, _rtier, _reff, _served,
             _cr, _c5, _c1, _status, _usrc, _tzo) in detail:
            # NOT `in ('', 'estimate', None)`. The test is "did a provider confirm this",
            # so the ONLY passing value is 'body' and everything else -- NULL, '', the
            # documented 'estimate', and any value a future writer invents -- fails
            # closed into `unmeasured`. record() already normalises unknown inputs to '',
            # but summary() reads a FILE, not record()'s output, and the store on disk
            # predates that normalisation.
            if (_usrc or "").strip().lower() == "body":
                measured_calls += 1
            else:
                unmeasured_calls += 1
            _in = _it or 0
            _out = _ot or 0
            # THE CONTRACT'S KEY, computed exactly as the contract defines it: in+out
            # == 0. Worth stating that on the store this work was commissioned against
            # it is ZERO -- the 90 synthetic probes carry 2-13 INPUT tokens and no
            # output, so they are not zero-TOKEN rows at all. They are the rows below.
            if _in + _out == 0:
                zero_token_calls += 1
            # ...and THIS is the count that explains the Logs/Reports contradiction the
            # user actually sees: 90 of 94 rows produced no output tokens, so their cost
            # is a few input tokens each and every one of them renders as $0.00, while
            # the four rows that did produce output carry the whole $80.52. Both surfaces
            # are arithmetically right; nothing here changes either. What was missing was
            # any figure a renderer could use to SAY so.
            if _out == 0:
                zero_output_calls += 1
            else:
                output_bearing_calls += 1

        # --- Legacy tier-weight estimate (kept for back-compat) ---
        top = max(self.price, key=self.price.get)
        spent_u = billed_top_u = 0.0
        for t, d in by_tier.items():
            toks = (d["in_tokens"] + d["out_tokens"]) / 1_000_000
            spent_u += toks * self.price.get(t, 0)
            billed_top_u += toks * self.price[top]
        saved_u = billed_top_u - spent_u
        pct_u = (saved_u / billed_top_u * 100) if billed_top_u else 0.0

        # --- Real-dollar aggregation (per row) via pricing.py: what you would have
        #     paid at the model you requested vs. what Cheaper actually spent. ---
        dollars = {"saved": 0.0, "spent": 0.0, "billed_top": 0.0, "savings_pct": 0.0,
                   "gross": 0.0, "extra": 0.0}
        by_tool_acc: dict = {}
        ts_acc: dict = {}
        models_changed = 0
        models_upcharged = 0
        tokens_downgraded = 0
        # --- the two token counts the CLI could not get from here ------------------
        #
        # tokens_upcharged  THE OTHER HALF OF tokens_downgraded, and its absence was a
        #   RATCHET. `tokens_downgraded` only accumulates on the `saved > 0` branch, so a
        #   chat that was PURELY an upcharge published `tokens.downgraded == 0`. The
        #   tagline feeds that number to `ledger.record()` as `tokensCredited`, and
        #   ledger.record() gates on `tokens > 0` (cli/src/peek/ledger.js) -- so the
        #   whole chat, negative dollars and all, was a no-op against the lifetime total.
        #   The ledger could only ever move up. That is the third appearance of this
        #   exact shape in this repo (the whole-conversation routing ratchet, and
        #   `baselines.highest_tier` being clamped with max(0.0, ...)), and it is fixed
        #   the same way each time: publish the losing direction as a first-class figure.
        #
        #   NON-NEGATIVE, AND DELIBERATELY NOT NETTED AGAINST `tokens_downgraded`. The
        #   DIRECTION lives in the key name and the SIGN lives in `dollars.saved`, which
        #   is already signed. Publishing a single netted count would zero out a chat
        #   whose downgrades and upcharges happen to balance and re-open the same gate --
        #   a suppression done in the arithmetic, which is the one place it must never
        #   happen. A consumer that wants "tokens this chat routed at all" adds the two.
        #
        # tokens_priced  THE TOKEN HALF OF THE DOLLAR POPULATION. The tagline's spend
        #   sentence pairs a token count with a dollar figure, and its only available
        #   token source was `by_tier`, which is an UNBOUNDED `GROUP BY` over every row
        #   in the session while `dollars.spent` covers only `counts.priced` of them. The
        #   two halves of one sentence therefore described different populations, and the
        #   CLI could do nothing about it but LABEL the mismatch (`populationNote()` in
        #   cli/src/peek/tagline.js prints "the token count covers all N calls, the dollar
        #   figure only the M that could be priced"). A label is the right move when the
        #   figure genuinely is not available; it was available, it just was not
        #   published. Accumulated beside `dollars["spent"]` below, off the same `continue`
        #   guards, so it covers EXACTLY the rows in `counts.priced` by construction
        #   rather than by two implementations agreeing.
        tokens_upcharged = 0
        tokens_priced = 0
        # --- the DOLLAR population, counted rather than subtracted ------------------
        #
        # `counts.priced` is `examined - sum(unpriced.values())`, an inference. These two
        # are incremented on the SAME line as `dollars["spent"]`, after every `continue`
        # above it, so they cannot describe a different set of rows than the money does.
        #
        # The distinction between them is the whole point of the block: `priced_calls` is
        # how many rows put a dollar into the total, `priced_measured` is how many of
        # THOSE carried usage a provider actually reported. On the owner's store the pair
        # is (4, 0) -- the entire headline rests on four rows nobody measured.
        #
        # `counts.priced` is NOT reused here for a second reason: with `_PRICING` False
        # it reports `examined` even though the loop never ran, so it would claim a
        # priced population in the one configuration that has none.
        priced_calls = 0
        priced_measured = 0
        # Money-saving model switches ON ROWS THAT PRODUCED OUTPUT -- the honest
        # denominator for a downgrade rate. See the `measurement` block for why the
        # existing `downgrade_rate` is left exactly as it is.
        downgraded_output_bearing = 0
        downgraded_by_tier = {"haiku": 0, "sonnet": 0, "opus": 0}
        # Per-MODEL histograms. The tagline names the models it credits, because
        # "haiku tier instead of opus" was never checkable by the reader and, once the
        # catalog gained models priced above Opus, was not even ordered by cost.
        downgraded_by_model: dict = {}
        upcharged_by_model: dict = {}
        baseline_model = None
        baseline_rank = -1.0
        top_model = None
        top_rank = -1.0
        reasoning_opps = 0
        tokens_saved_potential = 0
        time_saved_model = 0.0
        time_saved_reasoning = 0.0
        by_source_acc = {b: {"calls": 0, "saved": 0.0, "spent": 0.0}
                         for b in ("user", "subagent", "other")}
        # Per-period roll-up (Today / week / month / quarter / year / all-time), for the
        # Reports "Savings by period" block. Accumulated from the same priced rows so a
        # period figure reconciles with the headline totals. Bounded by max_rows exactly
        # like every other aggregate on this summary.
        period_starts = _period_starts()
        periods_acc = {k: {"saved": 0.0, "spent": 0.0, "calls": 0} for k in period_starts}
        # Rows deliberately excluded from every dollar figure, counted so the exclusion
        # is VISIBLE. A silently shrinking denominator is how "we weren't watching"
        # becomes indistinguishable from "$0.00".
        unpriced = {"estimated_usage": 0, "non_2xx": 0, "model_not_in_catalog": 0,
                    # No derivable calendar day -> no historical rate to price at.
                    # Pricing it at today would be exactly the frame substitution the
                    # pday column exists to prevent.
                    "undatable": 0,
                    # A model switch invalidated the prompt cache and the baseline arm's
                    # cache state is not recoverable from the record, so the saving's
                    # SIGN is undetermined. See _cache_state_indeterminate.
                    "cache_state_indeterminate": 0}
        # Priced rows for which no all-frontier baseline exists on that row's own day.
        # They still contribute to saved/spent -- only `billed_top` is short -- so the
        # shortfall is reported instead of leaving `billed_top` looking complete.
        billed_top_missing = 0
        if _PRICING:
            for (ts, tier, om, it, ot, src, rtier, reff, served, cr, c5, c1,
                 status, usrc, tzo) in detail:
                ok, why = row_is_priceable(status, usrc)
                if not ok:
                    unpriced[why] = unpriced.get(why, 0) + 1
                    continue
                it = it or 0
                ot = ot or 0
                # in_tokens is the FRESH input count; cached traffic is billed separately.
                # `at` is the row's OWN local calendar day, the same date logs() and
                # store.derive_row price it at -- never today's, never the UTC one.
                kw = dict(cache_read=cr or 0, cache_create_5m=c5 or 0,
                          cache_create_1h=c1 or 0, at=_pday(ts, tzo))
                if kw["at"] is None:
                    # Undatable -> unpriceable. at=None makes cost_of_model resolve at
                    # pricing.today_utc(), so pricing this row would claim a figure at
                    # TODAY's promo state for a call we cannot even place on a calendar.
                    unpriced["undatable"] = unpriced.get("undatable", 0) + 1
                    continue
                # Price BOTH legs at their exact models. `om` is what the caller asked
                # for (the baseline); `served` is what Cheaper actually ran. The only
                # variable between them is the model, which is the only thing Cheaper
                # controls -- so it is the only thing it may claim credit for.
                spent_x = cost_of_model(served, it, ot, **kw)
                base_x = cost_of_model(om, it, ot, **kw)
                if spent_x is None or base_x is None:
                    # One side is unpriceable -> claim NOTHING for this row. It is
                    # counted in counts.unpriced and contributes to NO dollar
                    # accumulator, so dollars.spent covers exactly the rows in
                    # counts.priced and the two figures reconcile.
                    #
                    # This branch used to book `estimate_call(om, ...)["new_cost"]` into
                    # dollars.spent -- contradicting the comment above it and breaking
                    # three rules at once: the figure was resolved at pricing.today_utc()
                    # instead of this row's day, an unpriceable SERVED model inherited
                    # the REQUESTED model's rate (so /metrics made a dollar claim about a
                    # call /logs reports as actual_cost=None), and the row stayed inside
                    # dollars.spent and the savings_pct denominator while being counted
                    # as excluded -- an exclusion that was counted but never actually
                    # excluded.
                    unpriced["model_not_in_catalog"] = unpriced.get("model_not_in_catalog", 0) + 1
                    continue
                # The models are both priceable, but the COUNTERFACTUAL is not: this call
                # switched model and started COLD, so `base_x` above charged the baseline
                # a cache CREATE for a prefix that model may well have been holding and
                # would merely have READ. The subtraction's sign is undetermined by the
                # evidence (see _cache_state_indeterminate), so no dollar figure on this
                # summary may include it. Counted, never zeroed: the row contributes to
                # NO accumulator, so dollars.spent still covers exactly counts.priced and
                # the two figures reconcile.
                if _cache_state_indeterminate(served, om, cr or 0, (c5 or 0) + (c1 or 0)):
                    unpriced["cache_state_indeterminate"] = unpriced.get(
                        "cache_state_indeterminate", 0) + 1
                    continue
                spent = spent_x
                saved = base_x - spent_x          # SIGNED: a costlier route is negative
                changed = (served or "") != (om or "") and abs(saved) > 0
                # The all-frontier baseline, priced at THIS ROW'S OWN DAY. It used to go
                # through pricing.cost_of(), which takes no `at` and always resolves at
                # today_utc(); that was right only by luck, because no top representative
                # currently carries a dated window. The first promo transcribed onto one
                # would silently restate every historical row.
                billed_top = None
                _fam = detect_family(om)
                if _fam:
                    _rep = representative_for(_fam, "opus")
                    if _rep:
                        billed_top = cost_of_model(_rep, it, ot, at=kw["at"])
                if billed_top is None:
                    # No published top-tier rate for this row's family on this row's day.
                    # COUNTED, so `billed_top` is never quietly assembled from a
                    # shrinking subset and read as if it covered everything.
                    billed_top_missing += 1
                else:
                    dollars["billed_top"] += billed_top
                dollars["saved"] += saved
                dollars["spent"] += spent
                # Accumulated HERE, on the same line as the dollars and after every
                # `continue` above, because that adjacency is the whole guarantee: the
                # rows behind `tokens.priced` are the rows behind `dollars.spent`, and
                # neither can drift from the other without this statement moving.
                tokens_priced += it + ot
                # Same adjacency, same guarantee, for the measurement labels: a row that
                # moved the dollars is counted here, and it is counted as MEASURED only
                # when a provider reported its usage. `dollars_basis` is derived from
                # nothing else, so the label cannot describe a different population than
                # the figure it labels.
                priced_calls += 1
                if (usrc or "").strip().lower() == "body":
                    priced_measured += 1
                if saved > 0:
                    dollars["gross"] += saved
                elif saved < 0:
                    dollars["extra"] += -saved
                tool = _clean_tool(src)
                a = by_tool_acc.setdefault(
                    tool, {"tool": tool, "calls": 0, "saved": 0.0, "spent": 0.0, "down": 0})
                a["calls"] += 1
                a["saved"] += saved
                a["spent"] += spent
                if changed and saved > 0:
                    a["down"] += 1
                    models_changed += 1
                    tokens_downgraded += it + ot
                    downgraded_by_tier[tier] = downgraded_by_tier.get(tier, 0) + 1
                    downgraded_by_model[served] = downgraded_by_model.get(served, 0) + 1
                    # The same downgrade, restricted to calls that actually produced a
                    # completion. Incremented HERE, inside the existing branch, so it can
                    # only ever count rows `models_changed` already counted -- a subset by
                    # construction, never a parallel definition that could disagree.
                    if ot > 0:
                        downgraded_output_bearing += 1
                elif changed and saved < 0:
                    models_upcharged += 1
                    # Mirrors `tokens_downgraded` on the branch above, token for token
                    # and condition for condition. Anything that counts as a downgrade
                    # in one direction has to count as an upcharge in the other, or the
                    # ledger is asymmetric again in a way no reader can see.
                    tokens_upcharged += it + ot
                    upcharged_by_model[served] = upcharged_by_model.get(served, 0) + 1
                # The baseline is the priciest model actually REQUESTED this session,
                # ranked on a fixed 1M-in/1M-out basket. Price, not tier: capability
                # rank and price rank genuinely disagree across the catalog.
                #
                # ONLY A NAME LEAVES THIS BLOCK. `baseline_model` and `top_model` are
                # consumed as strings -- the tagline's "...instead of X" clause, in
                # cli/src/peek/tagline.js -- and no dollar figure on this summary is
                # derived from `b_rank`/`t_rank`. That is why the basket is a fixed
                # 1M/1M notional rather than the row's real tokens: it orders models, it
                # never claims money.
                #
                # It is still priced at THIS ROW'S OWN DAY. These four calls used to omit
                # `at=` entirely and so resolved at pricing.today_utc(), while every
                # other price in this same loop used at=kw["at"]. No dollar moved, but a
                # promotional window that reorders two models across its boundary would
                # make the tagline NAME the wrong one -- the ranking would be taken at
                # today's rates for a session that ran under different ones. Two frames
                # in one loop has no defensible reading, so there is now one.
                if om and is_priceable(om, kw["at"]):
                    b_rank = cost_of_model(om, 1_000_000, 1_000_000, at=kw["at"]) or 0.0
                    if b_rank > baseline_rank or (
                        b_rank == baseline_rank and (baseline_model is None or om < baseline_model)
                    ):
                        baseline_rank = b_rank
                        baseline_model = om
                if served and is_priceable(served, kw["at"]):
                    t_rank = cost_of_model(served, 1_000_000, 1_000_000, at=kw["at"]) or 0.0
                    if t_rank > top_rank:
                        top_rank = t_rank
                        top_model = served
                b = int(ts // ts_bucket) * ts_bucket
                g = ts_acc.setdefault(b, {"t": b, "saved": 0.0, "spent": 0.0, "calls": 0})
                g["saved"] += saved
                g["spent"] += spent
                g["calls"] += 1
                # Realized TIME saved from the model downgrade: requested-tier latency
                # minus the chosen tier's latency.
                at = (rtier or "").strip().lower()
                if at not in _LAT_TIER:
                    at = tier  # unknown -> no delta
                time_saved_model += max(0.0, _LAT_TIER.get(at, _LAT_TIER["sonnet"])
                                        - _LAT_TIER.get(tier, 0.0))
                # Measure-only REASONING opportunity: a triage-simple (haiku) request
                # that asked for medium/high reasoning could drop tokens + wall-clock.
                eff = normalize_effort(reff)
                if tier == "haiku" and _EFFORT_RANK.get(eff, 0) >= 2:
                    reasoning_opps += 1
                    tokens_saved_potential += _THINK_TOKENS.get(eff, 0)
                    time_saved_reasoning += max(0.0, _LAT_EFFORT.get(eff, 0.0)
                                                - _LAT_EFFORT["low"])
                bs = by_source_acc[_source_bucket(src)]
                bs["calls"] += 1
                bs["saved"] += saved
                bs["spent"] += spent
                for _pk, _pstart in period_starts.items():
                    if ts is not None and ts >= _pstart:
                        pa = periods_acc[_pk]
                        pa["saved"] += saved
                        pa["spent"] += spent
                        pa["calls"] += 1
            actual_total = dollars["saved"] + dollars["spent"]
            dollars["savings_pct"] = round(dollars["saved"] / actual_total * 100, 1) if actual_total else 0.0
            for k in ("saved", "spent", "billed_top", "gross", "extra"):
                dollars[k] = round(dollars[k], 4)
        else:
            dollars = {"gross": round(max(0.0, saved_u), 4), "extra": 0.0,
                       "saved": round(saved_u, 4), "spent": round(spent_u, 4),
                       "billed_top": round(billed_top_u, 4), "savings_pct": round(pct_u, 1)}

        # --- WHAT KIND OF NUMBER IS `dollars`? -------------------------------------
        #
        # ONE SCALAR, checkable in a single conditional, that says whether the dollars on
        # this payload may be described as measured. "measured" requires EVERY priced row
        # to have carried provider-reported usage; anything short of that is named.
        #
        # `row_is_priceable` already refuses `usage_source == 'estimate'`, so a priced row
        # is either 'body' or UNKNOWN (NULL/''). That is precisely why this is needed: an
        # unknown row sails through the exclusion gate and lands in the dollars looking
        # identical to a confirmed one. The gate answers "may this row be priced"; this
        # answers "may the result be called a measurement", and they are different
        # questions with different answers on all 94 of the owner's rows.
        #
        # The `_PRICING`-unavailable arm is NOT "none". In that configuration `dollars` is
        # the legacy tier-weight ESTIMATE over `by_tier` -- a real, non-zero, published
        # figure derived from no priced row at all -- and calling that "none" would let a
        # consumer read "no claim is being made" while a claim sits right beside it.
        # "unmeasured" is what it is. "none" is reserved for the case where there is no
        # dollar figure to describe, which is exactly `dollars.saved == 0.0` on both arms.
        if _PRICING:
            if priced_calls == 0:
                dollars_basis = "none"
            elif priced_measured == priced_calls:
                dollars_basis = "measured"
            elif priced_measured == 0:
                dollars_basis = "unmeasured"
            else:
                dollars_basis = "mixed"
        else:
            dollars_basis = "unmeasured" if total else "none"

        # --- HOW OLD IS THE NEWEST ROW? ---------------------------------------------
        #
        # `age_seconds` is SIGNED and unclamped. A negative age is a clock running ahead
        # of this process, and clamping it to 0 would erase the one signal that says so.
        #
        # `live` is derived from the ROUNDED, PUBLISHED age rather than from the raw
        # float, so a consumer that re-derives `age_seconds <= window_seconds` from this
        # payload lands on the same answer this module did. Two readers of one block
        # disagreeing about their own contents is the defect class this file spends most
        # of its comments on.
        if newest_ts is None:
            age_seconds = None
            live = False        # no rows at all is not "live"; it is "nothing to see"
        else:
            newest_ts = float(newest_ts)
            age_seconds = round(time.time() - newest_ts, 3)
            live = -LIVE_WINDOW_S <= age_seconds <= LIVE_WINDOW_S

        by_tool = sorted(
            ({"tool": a["tool"], "calls": a["calls"], "saved": round(a["saved"], 4),
              "spent": round(a["spent"], 4),
              "downgrade_rate": round(a["down"] / a["calls"] * 100, 1) if a["calls"] else 0.0}
             for a in by_tool_acc.values()),
            key=lambda x: x["saved"], reverse=True)
        points = [{"t": g["t"], "saved": round(g["saved"], 4),
                   "spent": round(g["spent"], 4), "calls": g["calls"]}
                  for g in sorted(ts_acc.values(), key=lambda x: x["t"])]

        # Provenance travels WITH the numbers. Both mispricing incidents shared a
        # second cause: no surface rendered the age of the price data, so a rate stale
        # by months was byte-indistinguishable from one verified this morning at every
        # human checkpoint. Any consumer printing a dollar figure can now print its
        # as-of date next to it, and staleness becomes visible instead of invisible.
        _catalog = {"as_of": CATALOG_AS_OF if _PRICING else None,
                    "priced": bool(_PRICING),
                    "age_days": _age_days(CATALOG_AS_OF) if _PRICING else None}
        return {
            "catalog": _catalog,
            "total": total,
            "by_tier": by_tier,
            "downgrade_rate": round(
                sum(d["count"] for t, d in by_tier.items() if t != top) / total * 100, 1
            ) if total else 0.0,
            "dollars": dollars,
            "by_tool": by_tool,
            "timeseries": {"bucket_seconds": ts_bucket, "points": points},
            "counts": {
                "intercepted": total,
                "models_changed": models_changed,
                "models_upcharged": models_upcharged,
                "reasoning_opportunities": reasoning_opps,
                # Rows that contributed NOTHING to any dollar figure, by reason. The
                # invariant a reader can check: priced + sum(unpriced.values()) equals
                # the number of rows examined (min(total, max_rows)).
                "unpriced": dict(unpriced),
                "unpriced_total": sum(unpriced.values()),
                "priced": max(0, min(total, max_rows) - sum(unpriced.values())),
                "examined": min(total, max_rows),
                # Priced rows with no all-frontier rate on their own day. > 0 means
                # `dollars.billed_top` (and therefore baselines.highest_tier) covers
                # FEWER rows than dollars.spent and must be labelled, not compared.
                "billed_top_missing": billed_top_missing,
                # An honest truncation flag: summary() has always capped its aggregates
                # at max_rows and said nothing, so a ledger past the cap silently
                # under-reported. Say when the figures are a sample.
                "truncated": total > max_rows,
            },
            # --- CAN THESE DOLLARS BE CALLED A MEASUREMENT? ------------------------
            #
            # Additive labelling of the figures above. NOTHING in this block changes an
            # existing key or a cent of existing arithmetic; every value is a count over
            # the same rows, or a name for what those rows are.
            #
            # It exists because the product published $80.52 as a measured saving from a
            # store in which `usage_source` is NULL on every one of 94 rows -- i.e. the
            # gateway's measured path had never fired even once against that database.
            # The dollars were not wrong. The CLAIM around them was, and no field on this
            # payload could contradict it.
            "measurement": {
                # --- the shared contract. These five names are fixed; the dashboard half
                # --- is built against them and must not have to guess at a spelling.
                #
                # Scope for the three counts: `counts.examined`, i.e. the session-scoped
                # rows this summary actually read (capped at `max_rows`).
                # `measured_calls + unmeasured_calls == counts.examined`, always.
                "measured_calls": measured_calls,
                # Everything that is not 'body': NULL, '', 'estimate', and anything a
                # future writer invents. Fails closed -- an unrecognised provenance is
                # never promoted to a measurement.
                "unmeasured_calls": unmeasured_calls,
                # measured | unmeasured | mixed | none. THE one field a renderer checks
                # before describing `dollars` as measured. See the derivation above.
                "dollars_basis": dollars_basis,
                # Rows that actually put a dollar into `dollars`, counted at the
                # accumulator rather than inferred by subtraction.
                "priced_calls": priced_calls,
                # Rows carrying NO TOKENS AT ALL (in + out == 0), which can only ever
                # price to $0. Named by the contract and computed exactly as the contract
                # defines it -- and worth recording that on the store this was
                # commissioned against it is 0, because the 90 synthetic probes there
                # carry 2-13 input tokens each. `zero_output_calls` is the count that
                # describes them, and it is the one the Logs/Reports contradiction needs.
                "zero_token_calls": zero_token_calls,

                # --- beyond the contract: the material the three reported symptoms need
                # --- a renderer to be able to state. Additive; the contract names above
                # --- keep exactly the semantics the contract gives them.
                #
                # The denominator for the three counts above, mirrored here so this block
                # reconciles without a reader having to cross-reference `counts`.
                "examined_calls": min(total, max_rows),
                # THE LOGS/REPORTS CONTRADICTION, IN DATA. Logs shows $0.00 on 90 of 94
                # rows while Reports shows $80.52, and BOTH ARE ARITHMETICALLY RIGHT: 90
                # rows produced no output tokens, so each costs a few input tokens and
                # renders as $0.00, and the 4 rows that did produce output carry the
                # entire figure. The arithmetic is untouched -- what is added is the pair
                # of counts that lets a surface say "90 of 94 calls returned no output
                # tokens and therefore no measurable cost" instead of leaving a user to
                # reconcile two screens that look like they disagree.
                "zero_output_calls": zero_output_calls,
                "output_bearing_calls": output_bearing_calls,
                # --- THE DOWNGRADE RATE'S DENOMINATOR ---------------------------------
                #
                # `downgrade_rate` (top level) reads 67.0% and `counts.models_changed`
                # reads 62, both dominated by probes that moved a model but moved no
                # output and no money. A rate whose denominator is mostly empty probes is
                # not informative.
                #
                # POSITION TAKEN: report the rate over rows that actually produced a
                # completion, AND publish its denominator, rather than silently redefine
                # the existing key. Two reasons the existing `downgrade_rate` is left
                # untouched: the shared contract forbids changing an existing key, and
                # that key is compared across runtimes by the parity gates -- restating it
                # here would make the gates disagree about a number neither side got
                # wrong. So the honest rate is published BESIDE it, named for its
                # population.
                #
                # WHY "produced output" is the line, and not "carried tokens": a call that
                # returned zero output tokens produced no completion. It is a probe, a
                # handshake or a health check, and crediting it as a downgrade counts a
                # routing decision that saved nothing. `in + out > 0` would keep all 90
                # probes in the denominator and change nothing about the complaint.
                #
                # A SUBSET BY CONSTRUCTION: `downgraded_output_bearing` is incremented
                # inside the branch that increments `counts.models_changed`, so it can
                # never exceed it or drift from its definition.
                "downgraded_output_bearing": downgraded_output_bearing,
                # None, never 0.0, when nothing produced output: no denominator, no rate.
                # 0.0 would assert "we routed these calls and downgraded none of them"
                # about a population that does not exist.
                "downgrade_rate_output_bearing": (
                    round(downgraded_output_bearing / output_bearing_calls * 100, 1)
                    if output_bearing_calls else None),
                # The headline a renderer may print, and the acknowledgement it must
                # print alongside. See _headline() for why `dollars.saved` itself is left
                # alone and what this buys instead.
                "headline": _headline(dollars_basis, dollars["saved"],
                                      priced_calls, priced_measured),
            },
            # --- IS ANYTHING ARRIVING? ----------------------------------------------
            #
            # About the DATA, never about the socket. The Monitor's green dot and its
            # "Active sessions" panel were read off /ws being connected; /ws only pushes
            # when a request is routed, so an idle gateway produced an open, healthy,
            # silent socket that rendered identically to a busy one. On the owner's store
            # the newest row is 29 HOURS old and `live` is False -- which is the truthful
            # answer, and the one the dot was never able to give.
            #
            # SCOPE, because it is easy to misread: this describes the rows THIS GATEWAY
            # RECORDED. A client that talks straight to api.anthropic.com (Claude Desktop
            # for macOS, for one) never reaches this proxy, so its traffic is structurally
            # invisible here and its absence from this block is not a fault in it. The
            # gateway can only see a client whose base URL points at the gateway.
            # `live: false` means "nothing is flowing THROUGH CHEAPER", never "you are
            # not working".
            "freshness": {
                # Epoch seconds of the most recent row, session-scoped like everything
                # else here, and NOT capped by `max_rows`. None when there are no rows.
                "newest_ts": newest_ts,
                # Signed and unclamped: negative means this machine's clock is behind the
                # writer's, which is a fact worth seeing rather than rounding away.
                "age_seconds": age_seconds,
                # A row arrived within `window_seconds` of now. False on an empty store.
                "live": live,
                # Published so a renderer can name the window it is asserting about
                # ("no calls in the last 2 minutes") instead of hardcoding a second copy
                # of this number and drifting from it.
                "window_seconds": LIVE_WINDOW_S,
            },
            # --- what NEVER REACHED the ledger ------------------------------------
            #
            # Everything in `counts` above describes rows that ARE in the store. These
            # describe writes that are not, and they are the only trace those writes
            # leave anywhere: app.py fires record() inside `except Exception: pass`, so
            # a refused write is invisible at the call site, invisible in the table, and
            # -- until this block existed -- invisible everywhere else too. A shrinking
            # denominator nobody announces is indistinguishable from a quiet week.
            #
            # SCOPE, stated because it is easy to misread: these are PROCESS-LOCAL
            # counters on this Metrics instance, covering writes attempted since the
            # gateway started. They are NOT stored in SQLite, NOT scoped by the
            # `session` filter (a per-chat summary still reports the process totals),
            # and they do not survive a restart. Read them as "is this gateway losing
            # writes right now", never as a historical figure about the ledger.
            "durability": {
                # The journal mode SQLite actually reported back, not the one requested.
                # Anything other than "wal" means the WAL upgrade was refused (network
                # filesystem, read-only media, a process holding the database during the
                # one-time upgrade) and the store is back on the rollback journal, where
                # an external reader's SHARED lock can starve the writer. When SQLite
                # gave a reason for refusing, it is carried alongside rather than left to
                # be guessed at.
                "journal_mode": self.journal_mode,
                "journal_mode_error": self.journal_mode_error,
                "synchronous": "NORMAL",
                "busy_timeout_ms": 5000,
                "write_attempts": WRITE_ATTEMPTS,
                # Writes SQLite refused on every attempt. Each one is a routed call
                # missing from every figure on this page.
                "write_failures": self.write_failures,
                # Retries that were needed but eventually succeeded: zero rows lost, but
                # a rising number is lock contention on its way to becoming a failure.
                "write_retries": self.write_retries,
                # INSERT OR IGNORE rows the partial unique index on request_id absorbed.
                # Working as designed -- that suppression is what makes a replayed write
                # idempotent instead of a double count -- but it must be COUNTED, or a
                # replay storm and a healthy gateway look the same from out here.
                "duplicate_suppressed": self.duplicate_suppressed,
                # Writes refused at the door for an unrepresentable timestamp.
                "rejected_ts": self.rejected_ts,
            },
            "tokens": {"saved_reasoning_potential": tokens_saved_potential,
                       "downgraded": tokens_downgraded,
                       # The DOWNGRADE's mirror image. Non-negative, never netted against
                       # `downgraded`: the direction is the key name and the sign is
                       # `dollars.saved`. A consumer wanting "tokens this chat routed"
                       # adds the two -- which is what stops a purely-upcharged chat
                       # publishing a zero token count and being dropped by a `tokens > 0`
                       # gate downstream.
                       "upcharged": tokens_upcharged,
                       # Tokens over EXACTLY the rows in `counts.priced` -- the same rows
                       # `dollars.spent` covers. Publishing it is what lets a caller pair
                       # a token count with a dollar figure from ONE population instead of
                       # labelling the mismatch.
                       #
                       # `None`, not 0, when pricing is unavailable: there is no priced
                       # population in that configuration (the dollars degrade to the
                       # legacy tier-weight estimate over `by_tier`, and `catalog.priced`
                       # already says so), and a 0 would read as "this session ran no
                       # tokens" -- a claim, where None is the honest absence of one. Same
                       # rule as `tzo`: a missing value is never quietly rendered as a
                       # plausible number.
                       #
                       # NOT the same thing as the `by_tier` token totals, and it must not
                       # be substituted for them: `by_tier` is unbounded and covers every
                       # row, this is capped at `max_rows` and excludes every unpriced
                       # reason. `counts.truncated` says when the cap bit.
                       "priced": tokens_priced if _PRICING else None},
            # Savings rolled up per wall-clock period for the Reports "by period" block.
            # Keys: today, week, month, quarter, year, all.
            "periods": {k: {"saved": round(v["saved"], 4),
                            "spent": round(v["spent"], 4), "calls": v["calls"]}
                        for k, v in periods_acc.items()},
            # Per-tier count of the DOWNGRADED (money-saving) rows — what Cheaper routed
            # to cheaper tiers, so the tagline breakdown excludes at-ceiling main-loop calls.
            "downgraded_by_tier": downgraded_by_tier,   # kept one release for the dashboard
            "downgraded_by_model": downgraded_by_model,
            "upcharged_by_model": upcharged_by_model,
            "baseline_model": baseline_model,
            "top_model": top_model or baseline_model,
            "time": {
                "saved_model_s": round(time_saved_model, 1),
                "saved_reasoning_potential_s": round(time_saved_reasoning, 1),
            },
            "by_source": {
                k: {"calls": v["calls"], "saved": round(v["saved"], 4),
                    "spent": round(v["spent"], 4)}
                for k, v in by_source_acc.items()
            },
            "baselines": {
                # Money saved vs each baseline. 'historical' is filled by the dashboard
                # from /peek (the CLI's chat-history analysis).
                "requested_default": dollars["saved"],
                # SIGNED. `max(0.0, ...)` clamped the arithmetic, so a period in which
                # Cheaper spent MORE than the all-frontier baseline read as an honest
                # measured $0.00 -- a suppression done in the math instead of at render,
                # which is the one place it must never happen. Preserve the sign here;
                # the renderer labels a negative.
                "highest_tier": round(dollars["billed_top"] - dollars["spent"], 4),
            },
            # legacy compat fields:
            "est_spend_units": round(spent_u, 3),
            "est_savings_units": round(saved_u, 3),
            "est_savings_pct": round(pct_u, 1),
            "recent": [
                {"ts": ts, "tier": tier, "original_model": om,
                 "reason": reason, "source": src}
                for (ts, tier, om, reason, src) in recent
            ],
        }
