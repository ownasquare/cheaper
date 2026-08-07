'use strict';
// Lifetime savings ledger — the running "$X and Y tokens saved, all-time" total the
// tagline shows at the end of every chat. Zero-dependency, local, and IDEMPOTENT:
// it is keyed by chat/session id, so re-running the tagline for the SAME chat (the
// Stop hook and a manual append both fire for one conversation) OVERWRITES that
// chat's entry instead of adding to it. Lifetime = the sum over all recorded chats.
//
// Why a per-chat ledger and not a single running counter: a running counter would
// double-count every chat whose tagline runs more than once, and it could never
// upgrade an early ESTIMATE into the gateway's later EXACT figure for the same chat.
// Keying by session id makes both correct — last write for a key wins, no drift.

const fs = require('fs');
const path = require('path');
const { HOME } = require('./fsutil');

// Kept under the same HOME peek reads from (so CHEAPER_PEEK_HOME isolates tests and
// alternate profiles), but in its own dir — this is peek's only WRITE, and it must
// never land inside a harness history dir that peek then scans.
function ledgerPath() {
  return process.env.CHEAPER_LEDGER_FILE || path.join(HOME, '.cheaper', 'lifetime.json');
}

const MAX_CHATS = 20000; // soft cap so the file can't grow without bound

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    if (j && typeof j === 'object' && j.chats && typeof j.chats === 'object') return j;
  } catch { /* missing or malformed → start fresh */ }
  return { version: 1, chats: {} };
}

// Atomic write: temp file in the same dir + rename. rename(2) is atomic on POSIX and
// on NTFS, so a concurrent reader never sees a half-written file. Best-effort: any
// failure is swallowed (a cosmetic total must never break the chat's closing line).
function save(data) {
  const p = ledgerPath();
  try {
    // ~/.cheaper holds a complete record of the user's AI usage. Create the dir 0700
    // and the file 0600 so another local user/process can't read it (it was 0755/0644).
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* umask may have widened it */ }
    fs.renameSync(tmp, p);
  } catch { /* ignore */ }
}

function isoNow() {
  // The CLI runs in normal Node (not the workflow sandbox), so Date is available.
  try { return new Date().toISOString(); } catch { return ''; }
}

// Drop the oldest entries (by `at`) if we're over the soft cap.
function prune(chats) {
  const keys = Object.keys(chats);
  if (keys.length <= MAX_CHATS) return chats;
  keys.sort((a, b) => String(chats[a].at || '').localeCompare(String(chats[b].at || '')));
  for (const k of keys.slice(0, keys.length - MAX_CHATS)) delete chats[k];
  return chats;
}

// Record THIS chat's realized savings under its session key, then return the updated
// lifetime totals. Only a positive, real saving is written; a chat with no cheaper
// routing (usd/tokens 0) is a no-op that never erases a prior positive entry for the
// same id. We re-load immediately before writing so a concurrent write for a
// DIFFERENT chat is merged rather than clobbered (shrinks the lost-update window).
// Record THIS chat's realized figure. Signed: a chat where routed work cost MORE than
// the baseline contributes a negative amount, exactly as it does in the per-chat line.
//
// The old guard was `usd > 0 && tokens > 0`, which made the ledger a one-way ratchet:
// a chat that cost extra silently contributed nothing, and — worse — a corrected
// re-run of a chat could never OVERWRITE a stale larger figure, because the write was
// skipped whenever the new value was not positive. That turned the lifetime total into
// a high-water mark of every optimistic estimate ever computed. Any chat with a real
// key and real tokens is now written, whatever its sign.
function record(key, usd, tokens, exact) {
  if (key && tokens > 0 && Number.isFinite(usd)) {
    const data = load();
    data.chats[key] = { usd, tokens, exact: !!exact, at: isoNow() };
    prune(data.chats);
    save(data);
    return totals(data);
  }
  return totals(load());
}

// Sum every recorded chat. `exact` is true only when EVERY contributing chat's figure
// came from the gateway (an aggregate that mixes in any estimate is marked inexact).
function totals(data) {
  const d = data || load();
  let usd = 0, tokens = 0, chats = 0, exact = true;
  const c = d.chats || {};
  for (const k of Object.keys(c)) {
    const e = c[k];
    // Signed sum. Skipping negative chats here would reinstate the ratchet one level
    // up: every chat where routed work cost extra would vanish from the lifetime
    // figure, leaving a total that only ever counts the wins.
    if (e && Number.isFinite(e.usd)) {
      usd += e.usd; tokens += e.tokens || 0; chats++; if (!e.exact) exact = false;
    }
  }
  if (chats === 0) exact = false;
  return { usd, tokens, chats, exact };
}

module.exports = { record, totals, load, ledgerPath };
