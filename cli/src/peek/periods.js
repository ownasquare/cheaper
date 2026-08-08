'use strict';
// Calendar-aligned time buckets for savings reporting. Every boundary is LOCAL time:
//   today   — since local midnight
//   week    — since the most recent Monday, 00:00 (ISO-8601 week start)
//   month   — since the 1st, 00:00
//   quarter — since the first day of the quarter (Jan/Apr/Jul/Oct), 00:00
//   year    — since Jan 1, 00:00
//   all     — everything, no lower bound
//
// TWO bucketing primitives live here and they answer different questions:
//
//   bucket()      "since <start>" windows. They NEST (week ⊇ today, month ⊇ week …),
//                 so they are correct for a single headline figure and WRONG for a
//                 ladder: six nested rows with a Saved column invite the reader to add
//                 them and count today six times, "this month vs last month" is not
//                 expressible at all, and a future-dated event lands in every window
//                 at once. Kept for headlines only.
//   bucketRange() a half-open [from, to) window. Disjoint by construction, so
//                 report(Jan) + report(Feb) === report(Jan ∪ Feb) exactly. This is the
//                 primitive for the Reports ladder, period-over-period, and export.
//
// ---- the ONE time frame -----------------------------------------------------------
// `pday` (the calendar+pricing day) is derived from `ts + tzo` in exactly one place,
// and BOTH the calendar bucket and the price date read it. They used to disagree:
// metrics.py::_day() and tagline.js priced on the UTC date while periods.js bucketed on
// LOCAL midnight. The catalog carries a dated window — claude-sonnet-5 at $2/$10 until
// 2026-08-31 against a standard $3/$15 — so on a UTC-7 machine every such call between
// 17:00 and 23:59 local on 2026-08-31 priced as September (promo expired, +50% in and
// out) while the local bucketer filed it in August. One frame, one answer.

// ---- local-midnight helpers (machine timezone) ------------------------------------
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function startOfWeek(d) {
  const mondayOffset = (d.getDay() + 6) % 7; // getDay(): 0=Sun..6=Sat -> 0=Mon..6=Sun
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - mondayOffset).getTime();
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
function startOfQuarter(d) {
  const firstMonthOfQuarter = Math.floor(d.getMonth() / 3) * 3;
  return new Date(d.getFullYear(), firstMonthOfQuarter, 1).getTime();
}
function startOfYear(d) { return new Date(d.getFullYear(), 0, 1).getTime(); }

const ORDER = ['today', 'week', 'month', 'quarter', 'year', 'all'];

// Window start epoch-ms for each period, relative to `now` (a Date; defaults to now).
function periodStarts(now) {
  const d = now instanceof Date ? now : new Date();
  return {
    today: startOfDay(d),
    week: startOfWeek(d),
    month: startOfMonth(d),
    quarter: startOfQuarter(d),
    year: startOfYear(d),
    all: -Infinity,
  };
}

// Coerce a timestamp (epoch-ms number | Date | ISO/parseable string) to epoch-ms,
// or NaN if it can't be understood.
function toMs(ts) {
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') return Date.parse(ts);
  return NaN;
}

// ---- the one time frame -----------------------------------------------------------

// Local UTC offset in MINUTES EAST of UTC at `ms` (so US Central summer = -300).
// Date#getTimezoneOffset() reports minutes WEST, hence the negation — getting the sign
// backwards silently shifts every pday by up to a day in the wrong direction.
function tzOffsetAt(ms) {
  const d = new Date(Number(ms) || 0);
  return -d.getTimezoneOffset();
}

// The representable calendar in epoch MILLISECONDS: [0001-01-01T00:00:00Z,
// 10000-01-01T00:00:00Z). Python's `datetime` covers exactly years 1..9999, so this is
// the shared domain of the one time frame. Mirrors `periods.py::CAL_MIN_MS/CAL_MAX_MS`.
const CAL_MIN_MS = -62135596800000;
const CAL_MAX_MS = 253402300800000;

// The calendar+pricing day for an event. `tzo` is frozen at WRITE time so a machine
// that later moves timezone cannot restate history, and so a DST transition is
// resolved with the offset that was actually in force at the instant of the call.
//
// A MISSING offset (null / undefined / '') means "nobody recorded one" — a legacy row,
// or a row whose sources disagreed so `store.merge` nulled the field. It is NOT UTC.
// This used to read `Number.isFinite(Number(tzo))`, and `Number(null)` is 0, so a
// NULLED offset silently became UTC while an UNDEFINED one was reconstructed — two
// answers for one state, and across the claude-sonnet-5 promo boundary that is the same
// 50% split the frozen-offset column was added to close. An explicit 0 is still a
// legitimate value and is still honoured; only the absent case reconstructs.
//
// MUST stay behaviourally identical to `gateway/app/periods.py::pday_of`, including
// the year 1..9999 bound (Python's datetime range) and the null return outside it —
// `cli/scripts/check-period-parity.js` diffs the two over the fixture set.
function pdayOf(ts, tzo) {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return null;
  const missing = tzo === null || tzo === undefined
    || (typeof tzo === 'string' && tzo.trim() === '');
  const n = missing ? NaN : Number(tzo);
  // Math.trunc mirrors Python's int(): a fractional offset must not shift the two
  // runtimes onto different milliseconds.
  let off;
  if (Number.isFinite(n)) {
    off = Math.trunc(n);
  } else {
    // RECONSTRUCTION PATH. The reconstructed offset is the ONE input the two runtimes
    // cannot be assumed to agree on outside the calendar, so it is gated — the same two
    // guards `periods.py::pday_of` applies:
    //  1. the RAW instant must itself be a representable UTC time. At 10000-01-01T00:00Z
    //     JS would otherwise reconstruct a westward machine offset and pull the instant
    //     back to a confident '9999-12-31' while Python, which cannot represent the
    //     instant at all, answers null. Whether a date EXISTS must not depend on which
    //     runtime asked, nor on which side of UTC the machine sits.
    //  2. the offset must actually be determinable. HONEST NOTE: on THIS runtime that
    //     second check is REDUNDANT — `ms` is already finite and, past guard 1, always
    //     inside the JS Date range, so `tzOffsetAt` cannot return NaN here. It is
    //     written out because in `periods.py` the equivalent check IS load-bearing
    //     (`local_offset_minutes` answers None rather than a fabricated 0), and the rule
    //     has to read as ONE rule in BOTH files. Guard 1 is the load-bearing half here:
    //     deleting it fails the parity gate on 8 answers.
    // An EXPLICIT `tzo` bypasses both: it is a recorded fact about the row rather than a
    // reading of this machine, and both runtimes shift by it identically.
    if (!(ms >= CAL_MIN_MS && ms < CAL_MAX_MS)) return null;
    off = tzOffsetAt(ms);
    if (!Number.isFinite(off)) return null;
  }
  // Shift into the local frame, then read the date parts in UTC. This is exact for any
  // offset, including the :30 and :45 zones a naive hour-based shift breaks.
  const shifted = new Date(ms + off * 60000);
  const y = shifted.getUTCFullYear();
  // A seconds/milliseconds unit slip lands in year 55840. Neither runtime may invent a
  // date for it: Python cannot represent it at all, so both return null and the row
  // becomes a COUNTED, visible exclusion instead of a confident wrong bucket.
  if (!Number.isFinite(y) || y < 1 || y > 9999) return null;
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${m}-${d}`;
}

// ---- IANA-zone arithmetic (shared contract with gateway/app/periods.py) ------------
// Reports let the user pick a timezone, and the same window must mean the same thing
// on both surfaces. Zero-dependency: Intl carries the tz database.

function zonedParts(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out = {};
  for (const p of dtf.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    year: +out.year, month: +out.month, day: +out.day,
    // Intl can render midnight as hour "24" in the h23/h24 boundary case.
    hour: (+out.hour) % 24, minute: +out.minute, second: +out.second,
  };
}

// Minutes east of UTC in `tz` at instant `ms`.
function zoneOffset(ms, tz) {
  const p = zonedParts(ms, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUTC - Math.floor(ms / 1000) * 1000) / 60000);
}

// Epoch-ms for a WALL-CLOCK time in `tz`. Two passes converge across a DST jump: the
// first guess uses the offset at the naive instant, the second re-reads the offset at
// that corrected instant. A single pass is off by an hour for the ~1h/year window
// immediately after a spring-forward, which is exactly where a day boundary sits.
function fromZoned(y, mo, d, h, mi, s, tz) {
  const naive = Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0);
  let guess = naive - zoneOffset(naive, tz) * 60000;
  const off2 = zoneOffset(guess, tz);
  const second = naive - off2 * 60000;
  if (second !== guess) guess = second;
  return guess;
}

// Half-open [from, to) bounds for a named calendar period containing `nowMs`, in `tz`.
// `tz` defaults to the machine zone. Weeks are Monday-anchored (ISO-8601).
//
// MUST stay behaviourally identical to period_bounds() in gateway/app/periods.py —
// `cli/scripts/check-period-parity.js` executes both and diffs them, the same way
// sync-prices.js already gates the price catalog. Otherwise "this week" means two
// different things on two surfaces of the same product.
const PERIODS = ['today', 'week', 'month', 'quarter', 'year', 'all'];

function periodBounds(name, nowMs, tz) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (name === 'all') return { from: -Infinity, to: Infinity, tz: zone };
  const p = zonedParts(now, zone);
  const day0 = fromZoned(p.year, p.month, p.day, 0, 0, 0, zone);
  switch (name) {
    case 'today':
      return { from: day0, to: fromZoned(p.year, p.month, p.day + 1, 0, 0, 0, zone), tz: zone };
    case 'week': {
      // Monday-anchored. getUTCDay() on the shifted wall clock gives the LOCAL weekday.
      const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0=Sun
      const back = (wd + 6) % 7;
      return {
        from: fromZoned(p.year, p.month, p.day - back, 0, 0, 0, zone),
        to: fromZoned(p.year, p.month, p.day - back + 7, 0, 0, 0, zone), tz: zone,
      };
    }
    case 'month':
      return {
        from: fromZoned(p.year, p.month, 1, 0, 0, 0, zone),
        to: fromZoned(p.year, p.month + 1, 1, 0, 0, 0, zone), tz: zone,
      };
    case 'quarter': {
      const q0 = Math.floor((p.month - 1) / 3) * 3 + 1;
      return {
        from: fromZoned(p.year, q0, 1, 0, 0, 0, zone),
        to: fromZoned(p.year, q0 + 3, 1, 0, 0, 0, zone), tz: zone,
      };
    }
    case 'year':
      return {
        from: fromZoned(p.year, 1, 1, 0, 0, 0, zone),
        to: fromZoned(p.year + 1, 1, 1, 0, 0, 0, zone), tz: zone,
      };
    default:
      return { from: day0, to: day0, tz: zone };
  }
}

// The previous instance of a period — "last month", "last week" — for period-over-period.
function previousPeriodBounds(name, nowMs, tz) {
  const cur = periodBounds(name, nowMs, tz);
  if (!Number.isFinite(cur.from)) return cur;
  // Step back to one millisecond before this period started and re-derive: correct
  // across month lengths, leap years and DST without any calendar arithmetic here.
  return periodBounds(name, cur.from - 1, tz || cur.tz);
}

// A ladder of NON-OVERLAPPING windows that partitions all of history:
//   Today · Earlier this week · Earlier this month · Earlier this quarter ·
//   Earlier this year · Before this year
// These SUM to the lifetime total, which is the property the nested ladder lacked —
// and the reason the old Reports table could be added up to six times today's savings.
function disjointLadder(nowMs, tz) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const b = {};
  for (const k of ['today', 'week', 'month', 'quarter', 'year']) b[k] = periodBounds(k, now, zone);
  const rows = [
    { key: 'today', label: 'Today', from: b.today.from, to: b.today.to },
    { key: 'week_earlier', label: 'Earlier this week', from: b.week.from, to: b.today.from },
    { key: 'month_earlier', label: 'Earlier this month', from: b.month.from, to: b.week.from },
    { key: 'quarter_earlier', label: 'Earlier this quarter', from: b.quarter.from, to: b.month.from },
    { key: 'year_earlier', label: 'Earlier this year', from: b.year.from, to: b.quarter.from },
    { key: 'before', label: 'Before this year', from: -Infinity, to: b.year.from },
  ];
  // A period whose window has collapsed (it is Monday, so "earlier this week" is
  // empty) is reported with from === to rather than dropped, so the ladder always has
  // the same shape and a zero row is visibly zero rather than missing.
  return rows.map((r) => Object.assign({ tz: zone }, r, { to: Math.max(r.from, r.to) }));
}

// ---- bucketing ---------------------------------------------------------------------

// Sum `items` into each calendar window.
//   getTs(item)     -> epoch-ms | Date | ISO string
//   getUsd(item)    -> number (signed; a chat that cost extra is negative)
//   getTokens(item) -> number (optional)
// Returns { today:{usd,tokens,count}, week:{...}, ..., all:{...} }. Amounts are
// summed with sign — a period that nets negative reports negative, never hidden.
//
// `undated` counts items whose timestamp could not be understood. They are excluded
// from every window — as before — but they are no longer SILENT: periods.js used to
// `continue` and the total quietly shrank, so a report could lose rows and still look
// complete. Any consumer with undated > 0 must label its report incomplete.
function bucket(items, getTs, getUsd, getTokens, now) {
  const starts = periodStarts(now);
  const out = {};
  for (const k of ORDER) out[k] = { usd: 0, tokens: 0, count: 0 };
  out.undated = { usd: 0, tokens: 0, count: 0 };
  for (const it of (items || [])) {
    const ms = toMs(getTs(it));
    const usd = Number(getUsd(it));
    const tok = Number(getTokens ? getTokens(it) : 0) || 0;
    if (!Number.isFinite(ms) || !Number.isFinite(usd)) {
      out.undated.count += 1;
      if (Number.isFinite(usd)) { out.undated.usd += usd; out.undated.tokens += tok; }
      continue;
    }
    for (const k of ORDER) {
      if (ms >= starts[k]) { out[k].usd += usd; out[k].tokens += tok; out[k].count += 1; }
    }
  }
  return out;
}

// Clocks run backwards (NTP steps, a VM resuming from a snapshot, a manual set) and a
// transcript can carry a timestamp from the future. A far-future row would otherwise
// sit in every "since" window forever and never age out of any of them.
const SKEW_TOLERANCE_MS = 24 * 3600 * 1000;

// Sum `items` over the half-open window [from, to). Disjoint by construction:
//   bucketRange(x, jan) + bucketRange(x, feb) === bucketRange(x, jan..feb), to the cent.
//
// Returns { usd, tokens, count, undated, future, unvalued }. The last three are the
// honest accounting for rows that could not be fully placed, and they are three
// SEPARATE facts — conflating them is how a report loses rows and still looks complete:
//
//   undated   no usable timestamp   -> in no window at all; the report is `incomplete`
//   future    beyond now + skew     -> quarantined (a clock step or a bad transcript);
//                                      without this a far-future row sits in every
//                                      "since" window forever and never ages out
//   unvalued  in the window, but no derivable dollar figure (an unpriceable model) ->
//                                      COUNTED as a call and its tokens counted, but
//                                      contributing nothing to `usd`. A caller that
//                                      renders `usd` while `unvalued > 0` is showing a
//                                      figure derived from part of the evidence, so it
//                                      must label or suppress — see derive.foldRows.
function bucketRange(items, from, to, opts) {
  const o = opts || {};
  const getTs = o.getTs || ((e) => e.ts);
  const getUsd = o.getUsd || ((e) => e.usd);
  const getTokens = o.getTokens || ((e) => e.tokens);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const skew = Number.isFinite(o.skewMs) ? o.skewMs : SKEW_TOLERANCE_MS;
  const lo = from === undefined || from === null ? -Infinity : Number(from);
  const hi = to === undefined || to === null ? Infinity : Number(to);
  const out = { usd: 0, tokens: 0, count: 0, undated: 0, future: 0, unvalued: 0 };
  for (const it of (items || [])) {
    const ms = toMs(getTs(it));
    if (!Number.isFinite(ms)) { out.undated += 1; continue; }
    if (ms > now + skew) { out.future += 1; continue; }   // quarantined, not counted
    if (ms < lo || ms >= hi) continue;                    // HALF-OPEN: [from, to)
    out.count += 1;
    out.tokens += Number(getTokens(it)) || 0;
    const usd = Number(getUsd(it));
    // A row that HAPPENED but cannot be priced still happened. Dropping it from `count`
    // would shrink the denominator silently, which is the same concealment as reporting
    // $0.00 for an unpriceable model.
    if (!Number.isFinite(usd)) { out.unvalued += 1; continue; }
    out.usd += usd;
  }
  return out;
}

module.exports = {
  ORDER, PERIODS, periodStarts, bucket, bucketRange, toMs,
  startOfDay, startOfWeek, startOfMonth, startOfQuarter, startOfYear,
  pdayOf, tzOffsetAt, zonedParts, zoneOffset, fromZoned, CAL_MIN_MS, CAL_MAX_MS,
  periodBounds, previousPeriodBounds, disjointLadder, SKEW_TOLERANCE_MS,
};
