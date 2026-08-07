'use strict';
// Calendar-aligned time buckets for savings reporting. Every boundary is LOCAL time:
//   today   — since local midnight
//   week    — since the most recent Monday, 00:00 (ISO-8601 week start)
//   month   — since the 1st, 00:00
//   quarter — since the first day of the quarter (Jan/Apr/Jul/Oct), 00:00
//   year    — since Jan 1, 00:00
//   all     — everything, no lower bound
//
// Each bucket is an independent "since <start>" window (so `week` includes `today`,
// `month` includes `week`, etc. — they nest, they are not disjoint). An item counts
// in a window when its timestamp is >= that window's start. Comparisons are on
// absolute epoch-ms, so a UTC ISO timestamp buckets correctly against local
// boundaries regardless of the machine's timezone.

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

// Sum `items` into each calendar window.
//   getTs(item)     -> epoch-ms | Date | ISO string
//   getUsd(item)    -> number (signed; a chat that cost extra is negative)
//   getTokens(item) -> number (optional)
// Returns { today:{usd,tokens,count}, week:{...}, ..., all:{...} }. Amounts are
// summed with sign — a period that nets negative reports negative, never hidden.
function bucket(items, getTs, getUsd, getTokens, now) {
  const starts = periodStarts(now);
  const out = {};
  for (const k of ORDER) out[k] = { usd: 0, tokens: 0, count: 0 };
  for (const it of (items || [])) {
    const ms = toMs(getTs(it));
    if (!Number.isFinite(ms)) continue;
    const usd = Number(getUsd(it));
    const tok = Number(getTokens ? getTokens(it) : 0) || 0;
    if (!Number.isFinite(usd)) continue;
    for (const k of ORDER) {
      if (ms >= starts[k]) { out[k].usd += usd; out[k].tokens += tok; out[k].count += 1; }
    }
  }
  return out;
}

module.exports = {
  ORDER, periodStarts, bucket, toMs,
  startOfDay, startOfWeek, startOfMonth, startOfQuarter, startOfYear,
};
