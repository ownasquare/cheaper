# Cheaper.app — local savings store: implementation spec

**Date:** 2026-08-06 · produced by a 7-agent workflow (storage-engine benchmarking, event model,
source reconciliation, reporting/export; two adversarial verifiers; synthesis).
7 critical corrections folded in.

> **Two premises in the original brief were stale and are corrected inside:** `gateway/` is now a
> symlink to `cli/assets/gateway` (no dev/shipped split), and the dashboard **already has tabs**
> (`data-tab` anchors, hash routing, a paginated Logs table on `/logs`, a Reports pane). Both
> changed mid-workflow. The reporting surface is not the missing piece; the numbers behind it are.

> One analyst agent (event model) failed on output validation; its conclusions survive via the
> synthesis and the two verifiers, but that section is thinner than the rest.

---

# Cheaper.app — Local Savings Store: Final Implementation Spec

**Date:** 2026-08-06 · **Repo:** `/Users/fortunevieyra/Documents/Github/ownasquare.com/cheaper-app` · **Verified against working tree this session**

---

## 1. Direct answer

**Yes — build one local per-call event store. But it is the second commit, not the first, and it must not be SQL.**

The reason it is not the first commit is a defect I re-verified in the working tree today:

`cli/src/peek/ledger.js:78`

```js
data.chats[key] = { usd, tokens, exact: !!exact, at: isoNow() };
```

`at` is the moment the **tagline ran**, not when the work happened. `cli/src/savings.js:34` buckets every period on that field:

```js
return bucket(chats, (e) => e.at, (e) => e.usd, (e) => e.tokens);
```

The live ledger proves the consequence. All six chats in `~/.cheaper/lifetime.json` carry an `at` between `2026-08-07T01:56Z` and `2026-08-07T05:43Z` — a four-hour band on one day, for work spanning far more. `cheaper savings` today reports **$16.1521 saved "today"** and **$0.00 for every prior day**, and re-running a tagline for an old chat *moves* its money out of the old period into the new one. "Savings yesterday" is not stable and can silently drop to zero. For a feature framed as a personal financial audit log, that is a correctness defect.

The correct value is already computed and thrown away: `tagline.js:132` calls `sessionDate(priced)` inside `realizedFromRecords` and never returns it; `tagline.js:431` calls `ledger.record()` with no timestamp.

Three further things must land before any ingest exists, because an append-only log never forgets a wrong number:

- **`adapters.js:194` first-wins dedupe.** Measured this session over the 120 newest transcripts (12,741 assistant rows, 5,129 distinct `message.id` groups, 3,928 multi-line, **751 growing, 0 shrinking**): first-wins sums **6,512,478** output tokens; last-wins and max-wins both sum **8,010,589**. A **18.7% systematic under-count**. Monotonicity (751 grow, 0 shrink) proves `MAX()` is safe and also fixes reordering.
- **`adapters.js:179`** scopes the dedupe `Set` *inside* the per-file loop. Measured: **157 `message.id`s appear in more than one file, and all 157 also appear under more than one `sessionId`** — Claude Code copies history forward on resume/fork with new session ids. Today that is a per-run estimate error; persisted, it is permanent double-counting.
- **`app.py:278`** writes `in_tokens=usage.get("input_tokens") or (text_len // 4)`, and the streaming branch (`app.py:292-309`) never parses usage at all. Measured over the same transcripts: real fresh input totals **123,485 tokens** against **4,222,943,016 cache-read tokens** — a **34,198×** ratio. Substituting the whole conversation's character count for `input_tokens` is wrong by roughly four orders of magnitude on the field it replaces, and it prints with `exact: true` and no "about" qualifier.

**And two premises in the brief are stale — do not act on them.** `gateway/` is a **symlink** to `cli/assets/gateway` (`ls -la` confirms `gateway -> cli/assets/gateway`); there is no dev/shipped dashboard split and no 7 KB drift. `cli/scripts/sync-prices.js:15-18` documents this explicitly. The dashboard **already has tabs** — `data-tab` anchors for dashboard/reports/logs/monitor at `dashboard.html:160-163`, hash routing at `:1002-1042`, a paginated Logs table wired to `/logs` at `:866-880`, a Reports pane at `:197-218`, and a correct `esc()` at `:282`. The reporting surface is not the missing piece. The numbers behind it are.

**What "yes" means concretely:** one store, three writer processes, one reader. Not a per-surface database. The desktop must not have its own — it already spawns this exact CLI at `cheaper-desktop/main.js:60`.

---

## 2. The store

### Engine: append-only JSONL, monthly segments, per writer, per install. Zero dependencies.

`cli/package.json` has **no `dependencies` key at all** (verified) and `engines.node: ">=16"`. Node here is 20.19.4 — `node:sqlite` does not exist below Node 22. Every SQL option fails at a layer that has nothing to do with query speed:

| Candidate | Disqualifier |
|---|---|
| **Single JSON document** (today's ledger) | Two concurrent writers: 319 of 600 records survived, both processes exit 0. Reproduces `ledger.js:37-45` (load→mutate→stringify→tmp→rename) exactly. Becomes permanently unwritable at ~1.62M rows (`JSON.stringify` throws past V8's 536,870,888-char cap). 250 ms/write and 920 MB RSS at 100k rows. |
| **sql.js (WASM)** | Same last-writer-wins flaw, 315/600. Persists only via whole-file `export()`, takes no file locks. It does not fix the thing it appears to fix. |
| **node-sqlite3-wasm** | Silently refuses WAL (`PRAGMA journal_mode=WAL` returns `delete`, no error). Sharing a file with Python's `sqlite3`: 0 rows in 301 seconds, DB left unopenable. |
| **better-sqlite3** | Fastest and concurrency-correct, but **no Node-20 prebuild** (v12.11.1 ships node-v127/137/141/147; there is no v115), so `npm i -g cheaper` triggers a 15.7 s node-gyp compile requiring Xcode CLT. Under Electron 31 the Node-20 binary throws `NODE_MODULE_VERSION 115 … requires 125` — exactly how `cheaper-desktop/main.js:58-61` spawns the CLI with `ELECTRON_RUN_AS_NODE`. The bind is **lazy** (`lib/database.js:48`), so an import-only smoke test passes and ships a broken DMG. |
| **Gateway over HTTP** | Fast (0.63 ms), but the owner's own sessions never route through it, so it stores nothing when the gateway is down — the normal case. |

JSONL lost **0 of 600** with a Node and a Python process appending simultaneously; 60,000 records at line sizes to 60 KB with zero torn lines; 725,000 records intact across 10 rounds of `kill -9` with zero mid-file corruption. Durable append of a 40-call batch: **4.42 ms** — 0.03% of the 15 s Stop-hook budget.

**Honest caveat:** the 4.42 ms is only the storage write. Deriving events from transcripts (`adapters.js`, `scan.js`) is the expensive part of the hook and was never measured. The 15 s budget risk lives there, not here.

### Layout

```
~/.cheaper/events/                       mode 0700
  2026-08.9a41c0d7.cli.jsonl             Node: Stop hook + CLI       0600
  2026-08.9a41c0d7.gw.jsonl              Python: gateway             0600
  2026-07.9a41c0d7.jsonl.gz              sealed, compacted, gzipped  0600
  rollup.json                            DERIVED CACHE — always safe to delete
  state.json                             coverage[], tombstones[], ingested_files[]
  .hw/<harness>.<session>.json           per-session emit cursor
  .compact.lock
~/.cheaper/install.json                  {"v":1,"install":"9a41c0d7"}   0600
~/.cheaper/legacy_chats.json             frozen lifetime.json import    0600
```

Root resolves from the existing `HOME` in `cli/src/peek/fsutil.js:13`, so `CHEAPER_PEEK_HOME` keeps isolating tests; `CHEAPER_EVENTS_DIR` overrides. It stays in its own directory under `~/.cheaper/` and never inside a harness history dir that `peek` scans — the invariant `ledger.js:17-19` already documents.

**Three structural choices, each load-bearing:**

1. **Per-writer-class files** eliminate cross-language interleaving rather than relying on `O_APPEND` atomicity between Node and CPython. That held perfectly on APFS but is not guaranteed on NFS/SMB.
2. **Per-install segment names** make synced home folders correct by construction. Two machines appending to `~/Dropbox/.cheaper/events/2026-08.cli.jsonl` through a sync client get whole-file last-writer-wins (a month silently truncated) or a `(conflicted copy)` file a reader globbing an exact name never opens. With an install id they never write the same file, and **the reader globs `*.jsonl`** so conflicted copies fold through dedupe rather than being ignored. A network-mount warning stays as a diagnostic, not as the mitigation.
3. **Segments are named by UTC month**; a local-calendar query must read the adjacent segment on each side. Deterministic, and the reader filters by `ts` regardless.

Current permissions are wrong and must change in the same release: `~/.cheaper` is `0755` with `metrics.db` and `lifetime.json` at `0644` (verified).

### Write path

```js
// cli/src/peek/events.js — the ONLY Node writer. Never throws.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HOME } = require('./fsutil');

const MAX_WRITE = 1 << 20;                       // cap one write(2) at 1 MB

function eventsDir() {
  return process.env.CHEAPER_EVENTS_DIR || path.join(HOME, '.cheaper', 'events');
}

// Stable per-install id. Two machines on a synced home never share a segment file.
function installId() {
  const p = path.join(HOME, '.cheaper', 'install.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && /^[0-9a-f]{8}$/.test(j.install)) return j.install;
  } catch { /* mint below */ }
  const id = crypto.randomBytes(4).toString('hex');
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify({ v: 1, install: id }), { mode: 0o600 });
  } catch { /* a non-persisted id still writes a valid, dedupable segment */ }
  return id;
}

function segmentPath(writer, ts) {
  const d = new Date(ts || Date.now());
  const ym = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  return path.join(eventsDir(), `${ym}.${installId()}.${writer}.jsonl`);
}

// The idempotency key. A function of the call's IDENTITY only — never of its
// measured values, never of its source, never of a positional index.
function eventKey(e) {
  if (e.requestId) return 'rid:' + e.requestId;
  if (e.messageId) return 'mid:' + e.messageId;
  const h = crypto.createHash('sha256').update([
    e.harness || '', e.sess || '', e.served || '',
    Math.floor((e.ts || 0) / 60000), e.in || 0, e.out || 0,
  ].join('\0')).digest('hex').slice(0, 24);
  return 'wk:' + h;                              // WEAK — may suppress, never credit
}

function append(rows, writer) {
  if (!rows || !rows.length) return { written: 0, torn: false };
  let fd = null, torn = false, written = 0;
  try {
    const p = segmentPath(writer || 'cli', rows[0].ts);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fd = fs.openSync(p, 'a', 0o600);             // O_APPEND
    let buf = '';
    const flush = () => {
      if (!buf) return;
      const b = Buffer.from(buf, 'utf8');
      buf = '';
      let off = 0;
      while (off < b.length) {
        // writeSync does NOT loop internally. A short write would tear a record,
        // so retry the remainder; if it makes no progress, RECORD that rather
        // than pretending the line landed.
        const n = fs.writeSync(fd, b, off, b.length - off);
        if (n <= 0) { torn = true; return; }
        off += n;
      }
    };
    for (const r of rows) {
      const line = JSON.stringify(r) + '\n';     // JSON.stringify escapes \n and \r
      if (Buffer.byteLength(buf) + Buffer.byteLength(line) > MAX_WRITE) flush();
      buf += line;
      written++;
    }
    flush();
    fs.fsyncSync(fd);
  } catch (e) {
    return { written: 0, torn, error: String((e && e.message) || e) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return { written, torn };
}

module.exports = { append, eventKey, eventsDir, segmentPath, installId };
```

Call sites wrap this in `try/catch` and swallow — matching the posture at `ledger.js:44`. An audit write must never break a chat's closing line.

### The Stop hook must append a DELTA, not the session

`cli/assets/plugin/hooks/hooks.json:26-32` registers `Stop` with `timeout: 15`; `stop-tagline.js:48` runs `peek --tagline --transcript <path>`, which re-scans the **entire** session every time. Claude Code fires `Stop` on every assistant turn, and `assets/plugin/hooks/context/router-policy.md` additionally instructs the model to emit the line at the end of every reply. A 200-turn chat with 40 calls would append ~8,000 lines to represent 40 events. The 105 MB/yr retention projection is off by one to two orders of magnitude for a heavy user, and compaction's dedupe input grows quadratically in chat length.

The cursor is exact and bounded:

```js
// ~/.cheaper/events/.hw/<harness>.<session>.json
{ "v":1, "n":37, "last_id":"rid:req_011…", "base":"claude-opus-5", "elig":true }
```

- If `base` and `elig` are unchanged and the first `n` events end at `last_id`, emit **only** events after index `n`.
- If `base` or `elig` changed — a later turn raised the session ceiling — re-emit the **whole session at `rev+1`**. That is a *visible restatement*, which is the honest answer (see §3).
- If the prefix does not match (history rewritten, transcript rotated), re-emit at `rev+1`. Dedupe absorbs it.
- If the delta is empty, **write nothing at all.**

### Crash safety, compaction, retention

The reader tolerates a **partial trailing line at all times** — a segment can be appended to while being read. This is an explicit, tested code path, not an incidental `try/catch`: split on `\n`, and if the final chunk is non-empty it is partial — skip it *and count it* as `partial_tail`.

**Compaction has a named owner.** It runs **only** from an explicit `cheaper compact` and from the desktop via `runCli` (`main.js:58-69`, out-of-process, no timeout). It must never be lazily triggered from a CLI invocation, because the hook is by far the most frequent invocation and `stop-tagline.js:52` kills its child with SIGTERM at 12 s — landing mid-compaction on the one operation that can destroy data. The compactor refuses to start when `CHEAPER_FROM_HOOK=1` is set (the hook sets it).

Compaction holds `.compact.lock`, merges a sealed month's per-writer files, dedupes by id, writes a **new** file and renames, and **verifies the new segment's deduped event count, its six token sums, and a sorted-id-set SHA-256 against the source before unlinking**.

**Retention: keep raw events forever, gzipped.** stdlib `zlib`, no dependency. Measured 16.1× at default level and 18.3× at level 9 (100k events, 28.9 MB → 1.8 MB) — but on synthetic records with repeating model/tier/reason values. Real-world is plausibly 8–12×, so treat the projection as optimistic by ~2×: call it **10–15 MB/yr at 1,000 calls/day**, not 6.6. A financial audit log that discards its evidence to save a few megabytes is not an audit log. Retention is an explicit setting defaulting to keep-everything.

### The rollup is a cache, and it is invalidated by the catalog

Sealed months come from `rollup.json`; only the current month is scanned raw. This matters: a naive full scan of 1M events costs 2,041 ms and ~1 GB RSS, and `readFileSync` throws `ERR_STRING_TOO_LONG` past 512 MB — streaming is mandatory. The partitioned read answers all period queries at 1M events across 3.6 years in **10.3 ms / 42 MB RSS** in a cold process.

A per-day *token total* cannot be re-priced. `cli/src/peek/models.js:289` selects a long-context rate tier on **per-call** input size (`if (lc && (c.inputTokens||0) > lc.over)` — it *replaces* the rates), six catalog entries carry `longContext: { over: 200000, … }`, and `:297`/`:308` apply per-call `speed === 'fast'` and `serviceTier` multipliers (batch 0.5, priority 1.8). `pricing.py:190` mirrors it. Aggregating tokens destroys all three.

So the rollup stores **derived dollars** and is thrown away wholesale when its inputs change:

```json
{ "v": 1,
  "catalog_digest": "sha256:4c1e9a02…",
  "report_tz": "America/Chicago",
  "sealed_through": "2026-07",
  "days": { "2026-07-14": { "usd": 3.4412, "tokens": 812004, "calls": 96,
                            "by_basis": { "measured": {…}, "estimated": {…} } } },
  "source_segments": [{ "name": "2026-07.9a41c0d7.jsonl.gz", "sha256": "…", "events": 4211 }] }
```

If `catalog_digest` or `report_tz` differs from the current values, the reader **ignores the rollup and rescans**. A full rebuild of seven gzipped years is seconds — acceptable for a rare event, and it is the only way a catalog correction can restate sealed history.

**The correctness assertion is not "token sums match."** Two of the three defects above preserve token sums perfectly and corrupt only dollars. The assertion is: *derived dollars and every period bucket, from rollup+current, equal a full raw rescan — run under `TZ=America/Los_Angeles`, across a DST transition and across a month boundary.*

---

## 3. Event schema

### Savings is not a per-event quantity today. Freeze it at write time.

`realizedFromRecords` (`tagline.js:125-190`) derives every call's saving from **three session-scoped values**: `ceilingModel = priciest(top-level turns of the whole session)` (`:140`), `at = sessionDate(priced)` — one date for the entire session (`:132`), and `routedAware = priced.some(r => r.source === 'subagent')`, which flips the eligibility rule for every record (`:150-152`).

So storing `ts` per event fixes *when* a call happened and leaves *what it was worth* unstable: a chat spans midnight, the 23:50 ceiling is Sonnet, the 00:10 turn runs on Opus, and every prior-day event's saving retroactively increases. And `sessionDate()` prices the whole session at one date, which already violates "price each call at its own historical date."

**Resolve the session-scoped inputs at WRITE time and store them per row**, so read-time derivation is a pure per-row function. When a later turn raises the ceiling, emit `rev+1` corrections — that is what `rev` is for.

This also kills the query-window-dependent baseline. Any design that prices a row against a *ceiling derived from the scope* makes `savings(today) + savings(rest of month) ≠ savings(month)`. Measured on live session `5c74ee86`: the same 25 credited calls come to **+$0.79** against `claude-opus-5` and **−$32.69** against `claude-sonnet-5` — a 42× swing and a sign flip from nothing but which model happened to be the priciest top-level turn inside the window.

### The record

```jsonc
{
  "v": 1,
  "id": "rid:req_011CdnovAk4tJuaQtChMPLea",   // K1 > K2 > K3, see below
  "rev": 1,                                    // higher rev of same (id,prov) supersedes
  "w": "cli",                                  // writer class: cli | gw
  "inst": "9a41c0d7",

  // ---- time: ONE reference frame, stamped at write ----
  "ts":  1786012800123,                        // epoch ms UTC — when the CALL happened
  "tzo": -300,                                 // local UTC offset in minutes AT ts
  "pday": "2026-08-05",                        // calendar+pricing day, from ts+tzo
  "ingested_at": 1786013000000,                // when we LEARNED it. Never bucketed on.

  // ---- provenance ----
  "prov":  "transcript",                       // transcript | gateway | legacy
  "usrc":  "body",                             // body | estimate — was real usage present?
  "conf":  "measured",                         // measured | estimated

  // ---- identity ----
  "harness":  "claude-code",
  "sessions": ["5c74ee86-…", "fa0ec5ef-…"],    // SET — resume/fork is normal, not a conflict
  "sess":     "5c74ee86-…",                    // elected owner: earliest ts, ties lexicographic
  "sub":      true,

  // ---- the models, and the FROZEN counterfactual ----
  "served": "claude-haiku-4-5-20251001",
  "req":    null,                              // requested model — GATEWAY ONLY
  "base":   "claude-opus-5",                   // FROZEN baseline. Never derived at read time.
  "bsrc":   "tx_session_ceiling",              // gw_requested | tx_session_ceiling
  "elig":   true,                              // frozen routedAware verdict
  "ctier":  "haiku",                           // frozen classifier verdict (peek counterfactual)
  "cver":   3,                                 // classifier version — appears in provenance
  "reason": "",                                // gateway routing reason, sanitized, <=300

  // ---- tokens. NO DOLLAR FIGURE IS EVER STORED. ----
  "in": 2, "out": 313, "cr": 0, "c5": 45702, "c1": 0, "cu": 0,
  "speed": null,                               // fast | null
  "svc":   "standard",                         // standard | batch | priority
  "status": 200,

  // ---- verifiability, WITHOUT a filesystem path ----
  "sfile": "a71c3f9e0b42",                     // sha256(abs path)[:12] — NOT the path
  "sbase": "agent-ac0bf522.jsonl",             // basename only (a uuid) — safe
  "fsha":  "9a41c0d7e2",                       // sha256(file contents)[:10]
  "vok":   true                                // source still on disk and matching?
}
```

**`ctier` is not optional.** The counterfactual comes from prompt text: `scan.js:52-53` does `contentTier(r.text)` then `estimateCall(r.model, …, content.tier)`. The schema correctly stores no `text` — but with no classifier verdict either, every `prov:"transcript"` row prices to **$0 saved** on re-derivation, which is all of the owner's real usage. Store the enum and the classifier version. Tradeoff, stated honestly: this bakes the classifier's judgement in, so a classifier change no longer restates history the way a catalog correction does. `cver` appears in Reports provenance next to `catalog.as_of`.

**Privacy is an enforceable allowlist, not a caution.** No field may contain a filesystem path or prompt-derived text. `stop-tagline.js:25` already computes `String(ev.cwd).replace(/[/.]/g,'-')` — `-Users-<name>-Documents-Github-<client>` — which is exactly the field a future per-project Reports breakdown will reach for. Project grouping uses a salted hash plus a user-supplied label, never the path. **Test:** generate a log from fixtures and grep it for `os.homedir()`, the literal `Users`, and any value beginning with `/`. Fail the build on a hit. Mode `0700`/`0600`, local only, and never swept into a diagnostic bundle, crash report, or telemetry upload.

### The idempotency key

A provider-issued key already exists on both sides and nobody captures it. Verified over the 120 newest transcripts: `sessionId` present on **12,741 of 12,741** assistant rows, `message.id` on 12,741, `requestId` on 12,739 — and **0 of 5,127 requestIds map to more than one message.id**. It is 1:1 with the API call.

The gateway *is* the client making that upstream call. `upstream.headers` is in scope in **both** branches of `_forward` (`app.py:296` streaming, `:338` buffered), and `_HOP_BY_HOP` (`:98` = `{host, content-length, connection, keep-alive, transfer-encoding}`) does not strip `anthropic-request-id`.

```
K1  "rid:" + anthropic-request-id     STRONG — may merge and may credit
K2  "mid:" + message.id               STRONG
K3  "wk:"  + sha256(harness|sess|served|floor(ts/60000)|in|out)[:24]
                                      WEAK — may ONLY suppress a claim (§4)
```

**Never** a positional index and **never** `src`/`prov` in the key. `fsutil.js:57` sorts files newest-first, so touching one subagent transcript shifts every positional index; `fsutil.js:69-77` reads only the tail of files over 32 MB, so a long chat's leading calls vanish and all remaining indices shift. And an id containing the source means the same chat imported as `ledger` and as `transcript` mints two rows and doubles: the six live chats total **$16.1521**; naive re-import reads **$32.30**.

**Regression tests:** scan → capture the id set → `touch` a subagent transcript → re-scan → assert the id sets are byte-identical. Second: truncate a transcript's head past 32 MB and assert surviving ids are unchanged.

### Dollars are derived, never stored

```js
// Per row, at the row's OWN day and OWN billing SKU.
const bk  = { inFresh: r.in, cacheCreate5m: r.c5, cacheCreate1h: r.c1,
              cacheCreate: r.cu, cacheRead: r.cr, outTok: r.out };
const ctx = { at: r.pday, speed: r.speed, serviceTier: r.svc };

if (!(r.status >= 200 && r.status < 300))       return UNPRICEABLE;  // retries/errors
if (!isPriceable(r.served, { at: r.pday }))     return UNPRICEABLE;
if (!isPriceable(r.base,   { at: r.pday }))     return UNPRICEABLE;

const spent = costOfModel(r.served, bk, ctx);
const basev = costOfModel(r.base,   bk, ctx);
if (spent == null || basev == null)             return UNPRICEABLE;

const delta = r.elig ? (basev - spent) : 0;      // SIGNED — anti-savings subtract
```

`isPriceable` is evaluated at **`r.pday`, not today**. Both runtimes currently resolve it at today (`cli/src/peek/pricing.js:83` `resolveModel(modelId)` with no `at`; `gateway/app/pricing.py:229-231` the same) while `costOfModel` prices at the row's date — priceability and price in different time frames. That means a provider shipping `claude-opus-5-1`, or a user not refreshing for six weeks, can flip an already-read period from "$16.15 saved" to blank with no code change.

**Only per-CALL rows may store tokens and derive dollars.** A chat-grain row loses the five-way split, the per-call long-context threshold, and the per-call SKU. Concretely: 10 calls of 30k-in/2k-out price at $0.7200 per-call and **$1.4400** aggregated — a 100% overstatement — and the live ledger chats carry 739k–7.88M tokens each, clearing the 200k threshold by an order of magnitude. Legacy chat rows therefore store **frozen dollars**, marked `derivation: "frozen"`, and are excluded from catalog restatement with the report saying so.

---

## 4. Reconciliation rules

### "Prefer measured over estimated" is invalid. Reject it.

The gateway's streaming branch (`app.py:292-309`) sets only `usage["status"]`; `app.py:274-284` then stores `in_tokens = len(extract_text(body))//4`, `out_tokens = 0`, `cache_read = 0`. Claude Code always streams. The live DB corroborates: **76 rows, 4 with `out_tokens>0`, 0 with `cache_read>0`**. Meanwhile the transcript carries the provider's own `usage` block including `cache_creation.ephemeral_5m/1h_input_tokens`, `service_tier`, and `speed`.

Preferring the gateway would delete real output cost, inflate the savings ratio, and print it with `exact: true`. That is the three-prior-incidents failure mode reintroduced by the reconciliation rule itself.

Per-session source election also fails: it needs a session id the gateway does not have (verified: **76 of 76 rows have `session` NULL or `''`**, so `tagline.js:386`'s `/metrics?session=<uuid>` matches nothing and the gateway-exact path **has never once fired in production** — all six ledger entries are `exact:false`), and the unit of overlap is a *call*, not a chat.

### Adopted: union, dedupe by provider id, merge per FIELD, commutatively

| Field | Precedence (highest first) | Why |
|---|---|---|
| `req`, `reason` | **gateway only** | the transcript physically cannot know what was asked for before routing |
| `served` | gateway, transcript | agree in practice; the gateway is authoritative on what it forwarded |
| `harness`, `sub`, `ctier`, `cver` | **transcript only** | the gateway has no session or prompt visibility |
| `sessions` | **set union — never a conflict** | resume/fork is normal (157 measured) |
| `ts` | transcript, gateway | closer to the user-visible moment; the gateway's `time.time()` at response completion is kept as `observed_at` |
| `in`,`out`,`cr`,`c5`,`c1`,`cu` | **TX(body) → GW(body) → TX(estimate) → GW(estimate)** | the whole point above |
| `base`,`bsrc`,`elig` | frozen at write; higher `rev` wins within a `prov` | never re-derived |
| `speed`, `svc` | transcript(body), gateway(body) | billing-modifier SKUs only the transcript reports reliably |

```js
const TOKEN = ['in', 'out', 'cr', 'c5', 'c1', 'cu'];
const GW_ONLY = ['req', 'reason'];
const TX_ONLY = ['harness', 'sub', 'ctier', 'cver'];

function rank(e, f) {
  if (TOKEN.includes(f)) {
    if (e.prov === 'transcript') return e.usrc === 'body' ? 4 : 2;
    if (e.prov === 'gateway')    return e.usrc === 'body' ? 3 : 1;
    return 0;
  }
  if (GW_ONLY.includes(f)) return e.prov === 'gateway'    ? 2 : 1;
  if (TX_ONLY.includes(f)) return e.prov === 'transcript' ? 2 : 1;
  return 1;
}

// COMMUTATIVE and IDEMPOTENT. Replaying any event set in any order must converge
// on the same row and the same total. That property — not the storage engine —
// is what makes this defensible as a financial record.
function merge(x, y) {
  if (x.prov === y.prov && y.rev !== x.rev) return y.rev > x.rev ? y : x;  // restatement
  const out = { ...x, conflicts: [...(x.conflicts || [])] };
  out.sessions = [...new Set([...(x.sessions || []), ...(y.sessions || [])])].sort();
  out.sess = electOwner(out.sessions, Math.min(x.ts, y.ts));   // earliest ts, ties lexicographic
  for (const f of FIELDS) {
    if (f === 'sessions' || f === 'sess') continue;
    const rx = rank(x, f), ry = rank(y, f);
    if (rx !== ry)            out[f] = rx > ry ? x[f] : y[f];
    else if (TOKEN.includes(f)) out[f] = Math.max(x[f] || 0, y[f] || 0);   // fixes first-wins too
    else if (x[f] === y[f])   out[f] = x[f];
    else { out[f] = null; out.conflicts.push(f); }
  }
  out.source_mask = (x.source_mask | y.source_mask);
  out.conf = (out.source_mask & GW) && out.usrc === 'body' ? 'measured' : 'estimated';
  return out;
}
```

A divergent `sessionId` on a shared provider id is the **normal resume case** and must never route into the conflict/suppression path. Measured across a 40-day scan: 330 duplicate calls worth $84.73 — 4.4% of a globally-deduped $1,913.20. Routed as conflicts, the fold would either lose 4.4% of dollars or blank every window containing a resumed chat.

### The absolute invariant

**Never add a figure from two sources.** `metrics.summary().dollars.saved` + `ledger.totals().usd` + `peek.totals.dollarsSaved` is a double count by construction, in any combination. `dashboard.html:344-353` already gets this right by treating `historical` as an alternate *baseline selector*, not an addend. Encode it as a test: **assert that no rendered cell and no API response field is produced by an expression reading both a `measured` and an `estimated` accumulator** — including Spent and Events, not only Saved. And keep `grain` in that test: a chat count and a call count must never be summed even within one basis.

**And `peek` never enters the store.** `scan.js` computes what routing *would have* saved on calls that were **not** routed. That is a counterfactual, not an event.

### Report NOTHING rather than risk a double count

Every case returns a labelled non-number, never `$0.00`:

1. **Period entirely outside coverage** → `not_covered` with the date range. `$0` and "we weren't watching" are different claims.
2. **Period partially covered** → report only the covered sub-window with explicit bounds. Never the nominal total.
3. **Any row has `source_mask = BOTH` but was joined by a WEAK key** → suppress the merged figure. Fall back to transcript-only, labelled `estimated`, or nothing.
4. **Two rows share a WEAK key but disagree on `served`** → conflict, drop both. If conflicted rows exceed 1% of the window's dollars, suppress the window.
5. **Pre-migration gateway rows (no `request_id`) coexist with transcript rows** → disjointness is unprovable → transcript-only, labelled. *This is today's entire 76-row DB.*
6. **Stale writer** — `catalog.priced == false`, or `/healthz.code_sha` disagrees with the on-disk hash. `tagline.js:379 gatewayIsCurrent()` already catches this; extend it so a stale writer's rows are **quarantined from the fold**, not merged.
7. **Unpriceable > 20% of the window's tokens** → suppress dollars, report tokens. Make it **sticky and explanatory**, never a silent blank: record each served period's `as_of` and unpriced ratio, and on a later read render *"restated: N% of this window is now unpriceable (models: …); refresh with `cheaper update`"* next to the last-known figure.
8. **Missing/unparseable `ts`** → excluded from all buckets **and** counted as `undated`; any report with `undated > 0` is labelled `incomplete`. Today `periods.js:64` silently `continue`s and the total quietly shrinks.
9. **Status outside 2xx** → not priceable at all. `status` is stored today and referenced by **nothing** (`metrics.py:230-271`, `:274+` have no WHERE, no filter, no grouping). Claude Code retries `overloaded_error` and 429s automatically; a 6-retry storm on one turn books 6× the saving for zero delivered work. Retries return **distinct** `anthropic-request-id` values, so the provider key does not collapse them — the status filter is required regardless.
10. **Clock ran backwards past an exported boundary** → the period is `restated` and cannot be served as `final` until acknowledged.
11. **A session in the window is still open** (transcript mtime within N seconds) → `provisional`. Never export a period containing an open session as `final`.
12. **A tombstone falls inside the exported window** → the export carries the tombstone note or refuses.
13. **Lifetime ≤ 0** → stay silent. Already correct at `tagline.js:414-418`. Keep.
14. **`tokensCredited == 0` while dollars ≠ 0, or vice versa** → suppress. The two halves of the printed sentence must reconcile or neither prints.
15. **Same STRONG key, `out` differs by more than 2× between sources** → a bug, not a merge. Quarantine and count; suppress the window if quarantined dollars exceed 1%.

### Timezone: one frame, or a 50% error on a dated day

`metrics.py:33 _day()` uses `tz=timezone.utc` for price selection; `tagline.js:79` uses `.toISOString().slice(0,10)` — also UTC. But `periods.js:16-26` and `metrics.py:132-149` both bucket on **local** midnight. The catalog has a live dated window: `models.js:86-89`, `claude-sonnet-5`, `{from:'2026-01-01', until:'2026-08-31', in:2, out:10, cacheRead:0.2, cacheWrite:2.5, cacheWrite1h:4}` against a standard $3/$15.

On a UTC-7 machine, every `claude-sonnet-5` call between 17:00 and 23:59 local on 2026-08-31 gets `_day() = '2026-09-01'` — promo expired for pricing — while the local bucketer files it in August. Those calls report inside "This month (August)" at **+50% input and +50% output**. That is 25 days away.

**Fix:** `pday` is derived from `ts + tzo` in exactly one implementation, and both the calendar bucket and the price date read it. **Test:** price a `claude-sonnet-5` call at `2026-08-31T23:30:00-07:00`; assert it gets $2/$10 and lands in the August bucket. It currently gets $3/$15.

Also add `bucketRange(items, from, to)` with **half-open `[from, to)`** semantics. `periods.js:69` is `if (ms >= starts[k])` with `all: -Infinity` and no upper bound, so the six windows **nest** — today ⊂ week ⊂ month ⊂ … A ladder of six rows with a Saved column invites a reader to add them and count today six times, "this month vs last month" is not expressible at all, and a future-dated event lands in every window at once. Keep `bucket()` for headline "since" figures; use `bucketRange` for the ladder and all comparisons. Reject or quarantine any `ts > now + skew_tolerance`. And change `ledger.prune()` (`ledger.js:56`, sorts on `at`) to sort on the same field the buckets read.

---

## 5. Migration

### `lifetime.json` → a separate, frozen legacy store

Legacy chats have no model, no token split, no per-call structure, and a known-wrong timestamp. They cannot be reconciled against transcript rows and cannot be re-priced. Do not put them in the event log.

`~/.cheaper/legacy_chats.json`:

```json
{ "v": 1, "imported_at": 1786013000000,
  "chats": { "3d0afc92-…": { "usd": 3.7122, "tokens": 6343704, "exact": false,
                             "at": "2026-08-07T01:56:42.842Z",
                             "derivation": "frozen", "bucket_confidence": "unknown" } } }
```

- Dollars are **frozen**, never re-derived, and explicitly excluded from catalog restatement.
- **Excluded from period buckets by default** — their timestamps are known-wrong, so putting them in a day makes the fix look done while history stays wrong. They count toward **lifetime** with a visible `provisional` marker and a third visual state in Reports beyond measured/estimated.
- A legacy chat is **deleted the moment its session is backfilled** per-call from its transcript. That is the reconciliation check.
- Live drift already exists: chat `8c60b680` stores $3.8832 while a fresh recompute of the same session gives $4.4978 — **$0.6146 (15.8%) already wrong** inside today's $16.1521.

**Dual-WRITE `lifetime.json` for one deprecation window, not read-only.** A user who hits a bug and runs `npm i -g cheaper@0.2.5` reads `lifetime.json` via `savings.js:32-34`; if the new CLI stopped writing it, lifetime drops by a month with no error. Worse, `ledger.js:26-32` catches everything and returns `{version:1, chats:{}}` on any shape it does not recognise — a forward-incompatible ledger reads as **zero savings**, not as an error. Bump `version` and make `load()` distinguish *unparseable* (start fresh) from *newer than I understand* (surface "this ledger was written by a newer Cheaper — upgrade"). Same rule for the event log: a `v` higher than the reader's produces a visible refusal, never a zero.

### `metrics.db` — keep it, do not retire it

It is the proxy's own operational log and the Monitor tab's live feed. It also dual-writes `gw` events. Four migrations, all additive, all before any union view exists:

```python
# gateway/app/metrics.py :: Metrics.__init__, after the existing ALTERs (:166-185)
for _col in ("request_id", "message_id", "usage_source"):
    try: c.execute(f"ALTER TABLE decisions ADD COLUMN {_col} TEXT")
    except sqlite3.OperationalError: pass

# The 16 heaviest rows are invisible to every scoped query. Verified on the live DB:
#   76 rows, 16 with session IS NULL, 60 with session=''.
#   The NULL rows hold 1,890,068 of 1,890,408 in-tokens and 1,170,000 of 1,170,000
#   out-tokens. `WHERE session = ''` (metrics.py:231, :283) matches only the 60,
#   so Σ(per-session totals) != ungrouped total by construction.
c.execute("UPDATE decisions SET session = '' WHERE session IS NULL")

# Zero indexes exist today (verified: sqlite_master type='index' returns []).
c.execute("CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts DESC)")
c.execute("CREATE INDEX IF NOT EXISTS idx_decisions_sess ON decisions(session, ts DESC)")
# PARTIAL unique — the legacy NULL rows must not collide. Pair with INSERT OR IGNORE.
c.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_decisions_rid "
          "ON decisions(request_id) WHERE request_id IS NOT NULL")
c.commit()
```

Invariant test: for every distinct session value, `SUM(scoped) == unscoped` on count, `in_tokens` and `out_tokens`.

Capturing the key is two columns and a few lines:

```python
# gateway/app/app.py :: _forward — BOTH branches, before returning
rid = (upstream.headers.get("anthropic-request-id")
       or upstream.headers.get("request-id")
       or upstream.headers.get("x-request-id"))          # OpenAI front-end
usage["request_id"] = rid
# buffered branch only (~:315, inside the existing try):
usage["message_id"] = json.loads(upstream.content).get("id")
```

And `x-cheaper-session` is retired entirely: `app.py:246` and `:357` only *read* it, nothing in the repo writes it, and session attribution now comes free by join on the provider id plus `sessionId` read from inside the transcript record (present on 12,741/12,741). `adapters.js:119-121` resolves `--current` by cwd-slug match plus newest-file, which can select another harness's concurrent chat in the same project — **key on `(harness, sessionId)` read from the record, never on the filename.**

### Backfill: explicit, dry-run first, no file cap

```
cheaper import --since 2026-07-01 [--dry-run] [--harness claude-code]
```

Five rules:

1. **Timestamp is the event's own transcript `timestamp`.** Never the import date. That is the entire answer to "how do you avoid a fake spike on import day" — a spike is impossible when `ts` is event time and the import date lives only in `ingested_at`.
2. **A period before coverage reports `not covered`, never `$0`.** `coverage(source, harness, from_ts, to_ts, kind ∈ {observed, backfilled, not_covered})` in `state.json`. Any requested period not fully inside a coverage interval reports `partial` with its exact covered sub-window. The UI renders `not_covered` as a distinct visual state, never an empty chart that reads as zero. The gateway writes a coverage heartbeat on the existing 5 s `/ws` tick (`app.py:227`) so "not proxied", "gateway was down", and "row was lost" never collapse into one.
3. **Backfilled rows are permanently `estimated`.** They are transcript-only and the gateway can never retro-join them — its rows for that era have no request id.
4. **Coverage is bounded by the scanner, not the disk.** `adapters.js:21 CAP.maxFiles = 300` and `fsutil.js:30` default 400, but this machine has **1,013 transcript files reaching back to 2026-07-03**. Worse, `fsutil.js:53` filters on **mtime**, not event time, so a chat appended today drags month-old events into a `--days 7` window while a 40-day-dormant file holding 35-day-old events is excluded; and `fsutil.js:69-77` reads only the tail of any file over 32 MB. Import is a **dedicated importer with no file cap**, walking every file, recording `{sfile, sbase, size, mtime, fsha}` per file consumed so re-running is idempotent and any gap is provable.
5. **Import is an explicit user action with a dry-run preview and a coverage diff.** A lifetime figure that jumps by hundreds of dollars overnight without being asked for is indistinguishable from a bug, and this product's entire value is that its numbers are trusted.

### Deletion, rotation, purge

The store keeps its events when a transcript disappears. `/clear`, harness retention, and disk cleanup are the harness's business; if the store forgot, "savings in March" would change every time a March file rotated.

- **`verifiable` is a first-class field, separate from retention.** When the source file is gone, the row stays with `vok:false` and exports render it `unverifiable (source rotated)`.
- **Rotate-then-restore does not duplicate** — guaranteed by the STRONG-key upsert. This is the single most important reason the key is provider-issued and not a content hash.
- **`cheaper forget --session <id>`** writes a tombstone `{kind:"tombstone", session, events_removed, usd_removed, at}`. Totals then visibly drop *with a stated reason* instead of silently, and any export covering that window prints it or refuses.

---

## 6. Reporting surface

**Serve everything from the Python gateway.** The dashboard is already served from `:8787` (`app.py:207-212`). A second Node server means a second port, cross-origin config, a second lifecycle (`main.js:118 waitForGateway`, `launch.js:53 ensureGatewayUp`, `main.js:285 before-quit` all health-gate one process), and an HTTP+query layer inside a package whose `dependencies` is `{}` and must stay that way. CLI-owned data already reaches the browser through the filesystem: `/peek` serves `~/.cheaper/peek.json` (`app.py:81, :175-182`), written by `launch.js:75` and `main.js:263`. Extend that pattern; the bridge is the filesystem, not a socket.

`cheaper export` shells to the endpoint via the existing `ensureGatewayUp()` and streams bytes to a file. The moment it computes its own dollars it becomes a second source of truth that can disagree with the dashboard.

### Security must ship with the store, not after it

`cli/src/gateway.js:76` spawns uvicorn with `--host 0.0.0.0`, and `app.py` has **no `add_middleware`, no `Depends`, no auth of any kind** (verified). Today `/logs`, `/metrics` and `/peek` are already reachable from every host on the LAN — nobody has noticed because the store is nearly empty. The moment the event log is authoritative and Reports/export are served from that process, any device on the office or coffee-shop network can GET a complete per-call record of the user's AI usage; with no Host-header validation a DNS-rebinding page reads it from a remote origin.

In the same release: default the bind to `127.0.0.1` (keep `--host` as an explicit opt-in that prints a warning), add `TrustedHostMiddleware` pinned to localhost, and require a local token — 32 random bytes at `~/.cheaper/dash.token` mode 0600, injected into the URL `cheaper dashboard` opens — on `/logs`, `/metrics`, `/peek` and every `/api/*` route.

Ingest validation is now an integrity boundary. `app.py:243` reads `request.headers.get("x-cheaper-source")` **uncapped** (the `[:60]` applies only to the user-agent fallback), and `model`/`original_model` come straight from the request body. Sanitize at ingest: `source` to `[A-Za-z0-9._:/-]` and ≤64 chars; models to ≤128 chars on the catalog-normalization charset; strip **all** control characters. A raw newline in `source` is a JSONL line-injection primitive. Node's `JSON.stringify` escapes it, so the Python writer must use `json.dumps` and must never f-string or concatenate a log line. Fixture test: `source = 'a\n{"v":1,"in":999999999}'` → exactly one event parsed.

### API

Keep `/metrics`, `/peek`, `/logs` exactly as they are — `cheaper-desktop/renderer/index.html:142` polls `/metrics` and the dashboard's `loadLogs` (`:866`) uses `/logs`. Add a versioned namespace:

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/logs` | keyset-paged fold rows |
| `GET /api/v1/reports/periods?tz=` | **disjoint** calendar periods, split by basis |
| `GET /api/v1/reports/breakdown?dim=served\|base\|tier\|harness\|decision` | grouped aggregates |
| `GET /api/v1/reports/trend?bucket=day\|week\|month` | dated series |
| `GET /api/v1/export?format=csv\|tsv\|json\|ndjson` | streamed download |
| `GET /api/v1/report.html` | standalone print-optimised report (the PDF source) |

Shared filter contract, echoed in every response so an export is reproducible from its own header: `from` (inclusive), `to` (**exclusive**), `tz` (IANA — `zoneinfo` is stdlib on 3.11), `basis`, `grain`, `decision`, `harness`, `served`, `base`, `session`, `q`, `min_abs_usd`, `sort`, `limit` (default 100, cap 1000), `cursor`.

**Keyset pagination, not offset.** Offset degrades linearly and skips or duplicates rows when new traffic lands mid-scroll. Cursor is `base64([occurred_end, rid])` with a long-hand row comparison (`ts < ? OR (ts = ? AND rid < ?)`) so it works on every SQLite build. Count is capped at 20,000 and reported as `20,000+` — an honest cap beats a wrong exact number, and `metrics.py:274 summary(max_rows=5000)` already truncates every aggregate silently today, which the Reports tab must not inherit.

**Extract `_price_row` out of `metrics.py:243-271` into `reporting.py` and have `Metrics.logs` call it.** Do not fork it — the Logs tab and `/logs` must never disagree. Note also that `metrics.py:231` uses a raw `WHERE session = ?` while any union view using `COALESCE(session,'')` would match the 16 NULL rows: two endpoints, same product, same filter, a **5,560× difference in tokens**. The `session IS NULL` backfill in §5 must land first.

Adding `.py` files needs no build-config change — `sync-prices.js` derives its mirror from the directory and `_code_sha()` (`app.py:143`) hashes all `.py`/`.json`. **But `.html` is in neither fingerprint** (`app.py:144`, `freshness.js:71`), and `gateway.js:65` self-heals a stale install by comparing exactly that hash — so an HTML-only dashboard change does **not** trigger the reinstall. Widen both sides to `(py|json|html)` **in one commit**, or the comparison always-differs (`app.py:136` says so explicitly), and add a test that starts the gateway and asserts `/healthz.code_sha` equals the CLI's computed hash.

### Logs tab — the audit register

Extend the existing `showTab`/`loadLogs` implementation (`dashboard.html:1001-1017`, `:866-880`). Do **not** add a parallel `<nav class="tabs" id="tabs">` — both handlers would fire on `hashchange`.

Columns: **When** (local, full ISO + offset in `title=`; chat-grain rows show `start → end`) · **Basis** (`measured`/`estimated` pill) · **Grain** (`call`/`chat`) · **Source** · **Baseline → Served** · **Decision** · **Tokens** (`in / out`, cache split in `title=`) · **Baseline $** · **Actual $** · **Δ $** (signed, red when negative) · **Why**.

`basis` and `grain` are **non-hideable and not sortable-away, and present in every export row.** A future "simplify the table" change that drops them re-introduces the concealment bug. Unpriceable renders as an em dash with `title="Model not in the price catalog — no figure is claimed"` — never `$0.00`, which reads as a measured null result.

Empty state matters, because a measured-only table renders blank on this machine today (76 rows, 74 of them `testclient`/`testclient (openai)`/`cursor (openai)`): *"No events in this range. Measured rows need the gateway in the request path (`export ANTHROPIC_BASE_URL=http://localhost:8787`); estimated rows appear after an end-of-chat tagline runs."*

All filtering and sorting is **server-side over the full match set**. Sorting 100 loaded rows while 20,000 match is a lie about what the sort means.

### Reports tab — disjoint periods, never a cross-basis sum

Four blocks: the **period ladder** (disjoint `[from,to)` windows with the literal local bounds printed under the heading — `This month = 2026-08-01 00:00 → 2026-08-06 14:22 (America/Chicago, UTC-05:00)`); **period-over-period** with an explicit `n` on both sides so a 400% jump on 3 events reads as noise; **composition** by served model / baseline model / tier / harness; and a **dated trend** distinct from the Dashboard's 1h live sparkline.

Saved, **Spent, and Events all get the two-column measured/estimated treatment, or they are omitted.** Adding a per-call measured figure to a per-chat estimated figure — "82 events" from 76 gateway *calls* plus 6 ledger *chats* that themselves contain thousands of calls — is the same concealment shape in a column where the separation is less visually obvious.

`period_bounds()` in Python must be parity-tested against `cli/src/peek/periods.js` (Monday-anchored week, local midnight) the way `sync-prices.js:114-136` already parity-tests pricing across the two runtimes. Otherwise "this week" means two different things on two surfaces of the same product.

### Export — escaping, and the formula hazard

```python
# gateway/app/export_fmt.py
"""Delimited export for the Cheaper audit log.

Two hazards drive every rule here:
  1. Cell content is USER-CONTROLLED. `reason`, `source` (a raw client header at
     app.py:243) and model ids may contain commas, tabs, quotes or newlines. One
     unescaped character silently shifts every later column on that row.
  2. Excel, LibreOffice and Sheets EVALUATE a cell beginning with = + - @ on open.
     `=cmd|'/c calc'!A1` in a `reason` becomes code execution on the reader's
     machine. This is an export of adversary-influencable text.
"""
import re

# A cell is numeric iff it is EXACTLY a number. This test is load-bearing: without
# it the guard fires on every negative delta -- "-0.0123" would export as
# "'-0.0123" and the single most important column in the file stops being a number.
# metrics.py:362 `saved = base_x - spent_x  # SIGNED` makes negatives a designed case.
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
    head = s.lstrip("\t\r\n \u00a0")[:1]
    return ("'" + s) if head in _DANGEROUS else s

def csv_cell(v, mode="safe") -> str:
    s = guard("" if v is None else str(v), mode)
    if s == "":
        return ""
    # Quote on delimiter, quote, either newline, or leading/trailing space
    # (unquoted surrounding space is silently eaten by several parsers).
    if any(ch in s for ch in ',"\r\n') or s != s.strip():
        return '"' + s.replace('"', '""') + '"'
    return s

def csv_row(vals, mode="safe") -> str:
    return ",".join(csv_cell(v, mode) for v in vals) + "\r\n"      # RFC 4180: CRLF

# TSV has no quoting standard -- Excel, pandas and cut(1) all disagree -- so escape
# the four characters that can break a row. Unambiguous, no state machine, exact.
_TSV = {"\\": "\\\\", "\t": "\\t", "\r": "\\r", "\n": "\\n"}

def tsv_cell(v, mode="safe") -> str:
    return "".join(_TSV.get(ch, ch) for ch in guard("" if v is None else str(v), mode))

def tsv_row(vals, mode="safe") -> str:
    return "\t".join(tsv_cell(v, mode) for v in vals) + "\n"

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")
def safe_filename(s: str) -> str:                 # Content-Disposition header injection
    return _SAFE_NAME.sub("-", s)[:120]
```

Emit a **UTF-8 BOM** on CSV/TSV — without it Excel decodes as the ANSI code page and every non-ASCII model id is mojibake. Stream rows; never materialise.

**Round-tripping, honestly:** JSON/NDJSON lossless (canonical row objects). TSV lossless — but only at `guard=raw`; `safe` adds a leading apostrophe. CSV **lossy in `safe` mode**: RFC 4180 quoting is reversible, the formula guard is not. Documented in the header with the exact command to re-export losslessly. An unpriceable row's `delta_usd` is **empty in CSV/TSV and `null` in JSON — never `0`**. `0.00` is a measured result; empty is "no claim made."

Ship a test whose fixture literally contains `=cmd|'/c calc'!A1`, `@SUM(1+1)*cmd`, `+1+1`, `-1+1`, `-0.0123`, an embedded newline, an embedded tab, and an embedded double-quote; assert the round trip through a CSV parser yields the originals and that `-0.0123` is still a number.

### PDF — the decision, stated plainly

| Option | Verdict |
|---|---|
| `reportlab` in the gateway | **No.** `requirements.txt` is four packages and `main.js:93` runs `pip install -r` **before uvicorn starts** — a first-run download already gates app startup. reportlab pulls Pillow, a wheel that fails to build wherever there is no prebuilt. Startup latency and install failure on the critical path, for a button. |
| Hand-rolled PDF writer | **No.** Font metrics, table pagination, widow control, non-Latin glyphs. Its failure mode is a *silently truncated audit document* — the worst possible outcome for this surface. |
| A JS PDF lib in the dashboard | **No.** `dependencies: {}` is a deliberate property, and vendoring ~250 KB of minified library into a file read straight off disk at `app.py:210` forfeits it. |
| Puppeteer / headless Chrome | **No.** A multi-hundred-MB signed browser binary inside a hardened-runtime, notarised, cross-built DMG — the exact packaging failure class that disqualified better-sqlite3, arriving through a different door. |
| **Browser print-to-PDF** | **Yes, the baseline.** Zero dependencies, every browser, and the browser's own header/footer stamps the source URL and print date — provenance a reader can trust more than something we drew. Cost: one dialog click, and the user can disable those headers. |
| **`webContents.printToPDF`** | **Yes, the one-click desktop path.** Electron 31 already has it. No new dependency, no signing or notarisation impact. |

**Ship a print stylesheet + `/api/v1/report.html` + a desktop `printToPDF` handler.** Roughly a day. `/api/v1/report.html` embeds its data as a `<script type="application/json">` block rather than fetching, so `printToPDF` has nothing to race.

One constraint the proposals missed: `main.js:164` does `win.loadURL('http://localhost:'+PORT+'/dashboard')`, and `main.js:251-255` states outright that the remotely-loaded page cannot reach the preload bridge. **So the dashboard's PDF button calls `window.print()`, full stop** — and the desktop exposes "Save report as PDF" from its own tray/menu, which opens a hidden `BrowserWindow` on `/api/v1/report.html`, calls `printToPDF` with `displayHeaderFooter: true` (a 40-page audit export without page numbers is not a document anyone can cite), and **destroys the window in a `finally`** — an offscreen window leaks otherwise.

### The audit header block

Emitted verbatim as `#`-prefixed single-cell rows in CSV/TSV (still valid CSV; `preamble=0` suppresses), as `meta` in JSON, and as the PDF cover page. **All three are rendered from one `audit_meta()` dict**, so they cannot disagree.

```
# ==================================================================================
# Cheaper.app — model-routing savings audit export
# ==================================================================================
# export_schema        cheaper.export.v1
# generated_at         2026-08-06T19:22:31.442Z   (local 14:22:31 -05:00)
# generated_by         cheaper CLI 0.2.5 · gateway build 3f9a1c77e10b4d52
#
# --- SCOPE ------------------------------------------------------------------------
# period               This month
# period_start         2026-08-01T00:00:00-05:00      INCLUSIVE
# period_end           2026-08-06T14:22:31-05:00      EXCLUSIVE
# timezone             America/Chicago (UTC-05:00 at period_end; DST in effect)
# period_basis         `ts` — WHEN THE CALL HAPPENED. `ingested_at` is exported per
#                      row for audit but never assigns a row to a period.
# week_anchor          ISO-8601 (weeks begin Monday 00:00 local)
# coverage             observed 2026-08-01 → 2026-08-06 ; backfilled 2026-07-03 →
#                      2026-07-31 (estimated) ; NOT COVERED before 2026-07-03
# classifier           contentTier v3   (frozen per row as `ctier`)
# rows_exported        1,842      rows_matching 1,842      truncated no
#
# --- METHOD -----------------------------------------------------------------------
# Each row is priced TWICE, at that row's OWN date and OWN billing SKU, at list rates:
#   baseline_usd = cost of the row's frozen baseline model, at this row's tokens
#   actual_usd   = cost of the model Cheaper actually served, at this row's tokens
#   delta_usd    = baseline_usd - actual_usd     SIGNED
# A negative delta means the routed call cost MORE. Negative rows are INCLUDED and
# SUBTRACTED from every total in this file. No total here counts only the wins.
# Cache-read and 5-minute / 1-hour cache-write tokens are priced at their own rates.
# Long-context tiers and fast / batch / priority SKUs are applied PER CALL.
# A model absent from the catalog is UNPRICEABLE: its cost columns are EMPTY (null in
# JSON), never 0.00, and it contributes nothing. No rate is ever guessed.
# Non-2xx responses (retries, errors) are recorded but never priced.
#
# --- MEASUREMENT BASIS (per row, column `basis`) -----------------------------------
# measured    Observed by the Cheaper gateway from provider-reported usage. grain=call.
# estimated   Reconstructed from local harness transcripts. grain=call.
# legacy      Pre-store per-chat aggregate. Dollars FROZEN as computed at the time,
#             timestamp imprecise, excluded from period buckets. grain=chat.
# The three bases carry SEPARATE totals and are never summed. If you need one number,
# state which basis it came from.
#
# --- PRICE PROVENANCE -------------------------------------------------------------
# price_catalog        cheaper model_prices as_of 2026-08-06  (age 0 days)
# catalog_digest       sha256:4c1e9a02…8b37
# List rates only. Negotiated discounts, committed-spend rates, credits, free tiers,
# flat-rate subscription plans, promotional windows outside their dates, taxes and
# provider-side rounding are NOT modelled.
#
# --- THIS IS NOT AN INVOICE -------------------------------------------------------
# Figures are list-price METERED VALUE — an estimate of what the usage in this file
# would list for. Not amounts billed, not amounts paid, not a statement of account.
# Reconcile against your provider invoice before any accounting, reimbursement or tax use.
#
# --- INTEGRITY --------------------------------------------------------------------
# row_digest           sha256 over the canonical JSON of every exported row, in the
#                      order emitted = 9f2b6c41…a10d
# tombstones           none in this window
# guard_mode           safe — non-numeric cells beginning with = + - @ | %% carry a
#                      leading apostrophe to prevent spreadsheet formula execution.
#                      This export is therefore NOT byte-reversible. For a lossless
#                      copy re-run with --format json (or --guard raw).
# reproduce            cheaper export --format csv --from 2026-08-01 --to 2026-08-06 \
#                        --tz America/Chicago --basis all --guard safe
# ==================================================================================
```

`row_digest` is what turns a printout into evidence: a reader re-runs `reproduce` and checks byte-for-byte that nothing was edited.

---

## 7. Ordered task list

Smallest-safety-first. Every item is independently verifiable and independently shippable.

### P0 — correctness, no store involved. Each is one commit plus one test.

| # | Change | Test that proves it |
|---|---|---|
| 1 | `adapters.js:194` first-wins → `MAX()`; hoist `seen` (`:179`) out of the per-file loop | Fixture: 3 lines per `message.id` with growing usage → one record at max out. Second fixture: same `message.id` in two files → one record. Recovers the measured 18.7% under-count and the 4.4% cross-file over-count. |
| 2 | `ledger.js:76` drop the `tokens > 0` ratchet → `Number.isFinite(usd) && Number.isFinite(tokens)`; add a third state distinguishing "computed 0" from "could not compute" | Record $5, then record $0 for the same key → total is $0. Today it stays $5 forever, so a catalog correction can never restate. |
| 3 | Thread the real timespan: return `firstTs`/`lastTs` from `realizedFromRecords` (the value exists at `tagline.js:132`), pass through `tagline.js:431`, store `startedAt`/`endedAt`, bucket `savings.js:34` on `endedAt \|\| at`, sort `ledger.prune()` on the same field | `cheaper savings --json` no longer reports 100% of lifetime under "today". Legacy rows without `endedAt` render `provisional`. |
| 4 | `tagline.js:396` split source election from magnitude: `const g = fromGateway(summary); if (g) return g;` — move the `SHOW_MIN_USD` test entirely into `buildTagline` (it is already there at `:342`/`:359` and already handles negatives) | A gateway summary of −$4.00 prints "claims no saving … cost $4.00 more", not a positive transcript estimate. |
| 5 | `app.py:278`/`:384`: `or` → explicit `is None`; write `in_tokens` NULL rather than `text_len//4`; stamp `usage_source` **unconditionally** (`'body'` iff `input_tokens is not None`, else `'estimate'`) in both `_forward` branches | A streamed call records `usage_source='estimate'` and NULL tokens, and is excluded from every dollar figure. |
| 6 | `metrics.py`: backfill `session IS NULL → ''`; `NOT NULL DEFAULT ''`; add `idx_decisions_ts`, `idx_decisions_sess`; filter dollars on `200 <= status < 300` | For every distinct session value, `SUM(scoped) == unscoped` on count, `in_tokens`, `out_tokens`. Currently 60 vs 76 rows and 340 vs 1,890,408 tokens. |
| 7 | Bind `127.0.0.1` by default (`gateway.js:76`), `TrustedHostMiddleware`, `~/.cheaper/dash.token` (0600) on `/logs`,`/metrics`,`/peek`,`/api/*`; sanitize `x-cheaper-source` (`app.py:243`); chmod `~/.cheaper` 0700 and its files 0600 | Request from a non-loopback interface is refused. Fixture header `a\n{"v":1,…}` yields exactly one event. |
| 8 | One timezone frame: `pday` from `ts + tzo`; both the calendar bucket and the price date read it | Price a `claude-sonnet-5` call at `2026-08-31T23:30:00-07:00`: asserts $2/$10 (the `models.js:87` promo) and the August bucket. Currently $3/$15. **This fires in 25 days.** |
| 9 | Add `bucketRange(items, from, to)` with half-open `[from,to)`; reject `ts > now + skew`; keep `bucket()` for "since" headlines only | `report(Jan) + report(Feb) == report(Jan ∪ Feb)` to the cent. |

### P1 — the join key

10. Capture `anthropic-request-id` (both `_forward` branches) and `message_id` (buffered); add `request_id`/`message_id`/`usage_source` columns, the **partial** unique index, and `INSERT OR IGNORE`.
11. Parse SSE `message_start` / `message_delta` usage while proxying, so streamed calls become `usage_source='body'`.
12. Read `sessionId` from inside the transcript record; key on `(harness, sessionId)`; retire `x-cheaper-session` (`app.py:246`, `:357`).

### P2 — the store

13. `cli/src/peek/events.js` — writer, install id, segment naming, capped checked `writeSync`, fsync.
14. Freeze `base` / `bsrc` / `elig` / `ctier` / `cver` / `pday` at write time in `tagline.js`; emit `rev+1` when the session ceiling rises.
15. Stop-hook delta cursor in `.hw/`. Set `CHEAPER_FROM_HOOK=1`.
16. Reader + fold + commutative merge; explicit tested partial-trailing-line path.
17. `rollup.json` with `catalog_digest` + `report_tz` invalidation; assert rollup+current == raw rescan on **dollars and buckets**, under `TZ=America/Los_Angeles`, across a DST transition and a month boundary.
18. Python `gw` writer + a **shared golden-fixture test both runtimes execute**. `metrics.py:75-80` and `scan.js:15-18` already carry a "MUST mirror verbatim" comment; a second, larger shared contract doubles that drift surface, and a divergence produces double-counting that looks exactly like the three prior incidents.
19. `cheaper import` with `--dry-run`, no file cap, per-file idempotence records, coverage table.
20. `cheaper forget --session` + tombstones. `cheaper compact` (explicit only, refuses under `CHEAPER_FROM_HOOK`, verifies count + token sums + id-set hash before unlink).
21. `legacy_chats.json` import; dual-write `lifetime.json` for one release; version-skew refusal in `load()`.

### P3 — surfaces

22. Repoint the existing Logs table at `/api/v1/logs`; add non-hideable `basis`/`grain`; keyset paging; the `not_covered` visual state.
23. Rebuild the period ladder on disjoint windows with printed bounds; two-column measured/estimated on **Saved, Spent and Events**; parity-test `period_bounds()` against `periods.js`.
24. `/api/v1/export` + `export_fmt.py` + the header block; formula-injection fixture test.
25. Print stylesheet + `/api/v1/report.html` + desktop `printToPDF`; dashboard PDF button falls back to `window.print()`.
26. Widen `_code_sha()` and `freshness.js:71` to `(py|json|html)` **in one commit**, with a live `/healthz.code_sha` equality test.

**Stop-hook budget.** The tagline never folds. It appends its own delta and reads `rollup.json`. If the rollup is stale, print the per-chat line and **omit** the lifetime sentence. Prefer silence to a stale number.

---

## 8. What NOT to build

- **A SQL engine.** better-sqlite3, `node:sqlite`, sql.js, node-sqlite3-wasm. Revisit better-sqlite3 only when **all three** hold: `engines.node` rises to ≥22 so a prebuild exists; the desktop runs `electron-rebuild` for ABI 125 and a correctly-signed `.node` is verified through hardened-runtime + notarisation for both arm64 and x64, or the desktop stops spawning the CLI under `ELECTRON_RUN_AS_NODE`; and read patterns genuinely outgrow scan-and-aggregate — ad-hoc multi-dimensional filtering over >5M events, not the fixed queries the segmented log answers in 10 ms.
- **A second Node HTTP server.** Second port, cross-origin, second lifecycle, first CLI dependency.
- **Chat-grain rows with derived dollars.** Golden test: price one real session per-call and as an aggregate; assert the aggregate path is not offered.
- **`peek` output in the event store.** It is a counterfactual about calls that were never routed.
- **Any PDF library or headless browser.** See the table in §6.
- **A charting library.** The hand-rolled SVG spark at `dashboard.html:529-557` is the precedent; trend bars are ~30 lines of the same.
- **Virtualised / infinite-scroll log rows.** Keyset paging with an explicit "Load more" is honest about what is on screen. Virtualisation is where "the export doesn't match the table" lives, and matching is this surface's whole job.
- **Client-side filtering or sorting of the loaded page.**
- **Saved reports, scheduled exports, emailed PDFs.** Each adds persistent config, a scheduler, and — for email — an egress path out of a tool whose selling point is that nothing is sent anywhere.
- **Editable rows, manual adjustments, annotations.** An audit log the subject can edit is not an audit log. Reconciliation notes, if ever wanted, go in a separate append-only annotations stream that never mutates an event.
- **A custom SQL / query-builder pane.** An arbitrary-SQL box on a localhost service reachable from any page in the browser is a security problem, not just scope.
- **Multi-currency, tax categories, expense-report mapping, invoice reconciliation.** These require invoice-accurate figures; these are list-price estimates and the header says so.
- **Streaming Logs over `/ws`.** Monitor is the live view. A live-updating audit register moves rows under the cursor and destabilises any cursor-based page.
- **Proportional splitting of a midnight-spanning chat.** Per-call events make it moot. Never invent a usage distribution nobody measured.
- **Backfilling `endedAt` for the six existing ledger entries.** Their true span is unrecoverable. Mark them `provisional`, show a distinct visual state, let them age out as their sessions are backfilled per-call.
- **Widening `_code_sha()` on only one side.** `app.py:136` warns that this makes the comparison always-differ.
- **Retiring `metrics.db`.** It is the proxy's operational log and the Monitor feed. It dual-writes `gw` events; it does not go away.

## Decisions only the founder can make

1. **Report `not covered` for pre-store periods, or hide them from the UI entirely?** Both are honest. `$0` is not an option. Recommendation: render `not covered` — hiding makes the coverage boundary invisible.
2. **Backfill horizon and trigger.** All 1,013 transcript files back to 2026-07-03, a bounded window, or opt-in only. Recommendation: opt-in `cheaper import --since` with `--dry-run`, never a first-launch migration. A lifetime figure that jumps hundreds of dollars unprompted is indistinguishable from a bug.
3. **Do legacy `lifetime.json` chats appear in period buckets at all?** Their timestamps are known-wrong. Recommendation: excluded from periods, counted toward lifetime, visibly marked. The alternative makes the fix look done while history stays wrong.
4. **Retention default.** Keep raw events forever gzipped (~10–15 MB/yr at 1,000 calls/day, on a deliberately pessimistic ratio) versus a rolling raw window with older detail collapsed to rollup totals. Recommendation: keep everything; make retention an explicit setting.
5. **Raise `engines.node` from `>=16`?** Keeping `>=16` permanently forecloses better-sqlite3 (no prebuilds below ABI v127 / Node 22). Raising it later is a breaking change for existing installs. Recommendation: leave it — the segmented log answers the fixed queries in 10 ms and the constraint is doing useful work.
6. **Bind `127.0.0.1` by default**, breaking anyone currently pointing a second machine at their gateway. Recommendation: yes, with `--host` as an explicit opt-in that prints a warning. The store makes the current default a genuine privacy regression.
7. **Export default `guard=safe`** (leading apostrophe on dangerous non-numeric cells, not byte-reversible) with `guard=raw` and JSON as the lossless paths. The alternative makes a double-clicked CSV a code-execution vector.
8. **Emit the ~45-line audit header in CSV/TSV by default** (`preamble=0` suppresses). Some spreadsheet workflows dislike a preamble; an audit export without provenance is the thing this section exists to prevent.
9. **The hardest one.** Marking historical periods permanently `estimated`, pre-coverage periods `not covered`, and legacy chats `provisional` will make the product look **less impressive** than today's unqualified numbers. That is the correct trade, and it needs to be made deliberately now rather than discovered in review after the Reports tab ships.
