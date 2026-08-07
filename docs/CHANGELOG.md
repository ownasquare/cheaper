# Changelog

## 0.3.0 — the savings store: per-call, event-time, and honest about what it doesn't know

**Read this first: some periods that used to show a dollar figure now show a label
instead, and "today" will usually get smaller.** Both changes are corrections.

### The headline defect: savings were bucketed by when the TAGLINE ran

`cheaper savings` bucketed every chat on `at` — the moment the end-of-chat line last
printed — not on when the calls happened. On a real machine all six recorded chats
carried an `at` inside a single four-hour band, for work spanning weeks, so the command
reported **100% of lifetime savings under "today"** and $0.00 for every prior day. Worse,
re-running an old chat's tagline *moved* its money out of the old period into the new
one, so "savings yesterday" was not stable and could silently drop to zero.

This could not be patched in the chat-grain ledger: it stored one timestamp and one
frozen dollar figure for a multi-day, multi-million-token conversation. So there is now a
**per-call event store** (`~/.cheaper/events/`, append-only JSONL, zero dependencies) and
every figure is derived from it.

### What changed

- **One time frame.** Each event stores `ts`, the UTC offset in force at `ts`, and a
  derived `pday`. The calendar bucket, the price date and the priceability check all read
  `pday`. They used to disagree — pricing on the UTC date, bucketing on local midnight —
  and with `claude-sonnet-5` on a promotional rate through 2026-08-31, that was a live
  ±50% error on any call after 17:00 local on a UTC-7 machine.
- **Disjoint period windows.** The ladder is now Today · Earlier this week · Earlier this
  month · Earlier this quarter · Earlier this year · Before this year. These **partition**
  history, so they add up to lifetime. The old nested "since" windows meant a reader who
  added the column counted today six times.
- **Dollars are derived, never stored.** Events carry only tokens plus a frozen
  counterfactual (baseline model, eligibility, classifier verdict), so a catalog
  correction restates history instead of being unable to reach it.
- **Idempotent by the provider's own key.** Rows are deduped on
  `anthropic-request-id`, which the gateway now captures on both the buffered and the
  streamed path. Replaying a tagline, re-importing, or a synced-folder conflicted copy
  can no longer double-count.
- **Streamed calls are finally measured.** The gateway parsed no usage at all while
  streaming — and Claude Code always streams — so every streamed row was stored with a
  character-count guess for input and a hard 0 for output. It now reads the provider's
  own `message_start`/`message_delta` usage out of the SSE stream without altering a byte.
- **Retries are never priced.** A non-2xx response is recorded and excluded. Claude Code
  retries 429s automatically and each retry gets a distinct request id, so a six-retry
  storm used to book six times the saving for one delivered answer.

### What now refuses to show a number

Every one of these renders a labelled non-number, never `$0.00`:

- a period **before the store was watching** → *not covered* (with the date range)
- a partially covered period → only the covered sub-window, with its bounds printed
- a window where **more than 20% of the tokens are unpriceable** → dollars withheld,
  call and token counts still exact, and the reason named
- a model absent from the price catalog → an em dash with a tooltip, and an **empty**
  cell in CSV/TSV exports (`null` in JSON) — never `0`
- a deleted session (`cheaper forget`) → totals drop **with a stated reason**

**Measured and estimated are never summed.** They get separate columns for Saved, Spent
*and* Events, because adding a per-call measured figure to a per-chat estimated one is
the same concealment in a place where the separation is less visible.

### Security

- The gateway now requires a local token (`~/.cheaper/dash.token`, 0600) on `/metrics`,
  `/peek`, `/logs`, `/report`, `/dashboard`, `/ws` and every `/api/v1/*` route. Loopback
  is not a trust boundary on a shared machine — any other account could read the full
  usage record. `/healthz` and the proxy routes stay open.
- The dashboard moves the token into `sessionStorage`, strips it from the address bar,
  and is issued an `HttpOnly; SameSite=Strict` session cookie so a plain reload still
  works.
- CSV/TSV exports guard spreadsheet formula injection (`= + - @ | %`) while keeping
  negative deltas as real numbers.

### New commands

`cheaper import --since <date> [--dry-run]` · `cheaper forget --session <id>` ·
`cheaper compact` · `cheaper export --format csv|tsv|json|ndjson` ·
`cheaper logs|reports|monitor|dashboard --json|--terminal` (the no-flag default still
opens the browser).

### New surfaces

`/api/v1/{logs, reports/periods, reports/breakdown, reports/trend, export, report.html}`,
a rebuilt Logs audit register and Reports tab, a `cheaper://` desktop deep link, and a
3-OS release matrix.

---

## 0.3.0 — pricing correctness

**Read this first: your reported savings will go down, and the old numbers were wrong.**

This release replaces the pricing engine. Cheaper's whole value is that you can trust
the number it prints at the end of a chat, and three separate defects meant you
couldn't. All three are fixed, all three made savings look *bigger* than they were, and
we would rather tell you that plainly than quietly ship smaller numbers.

### What was wrong

**Retired Opus rates were applied to current Opus work.** The price table carried a
single hardcoded `opus` bucket at $15/$75 per Mtok — Claude Opus 4's rate. Opus 5 costs
$5/$25. Every Opus session was valued at **2.74× its real metered cost**.

**Unknown models silently inherited a neighbour's price.** Model ids resolved by longest
prefix match, so an id the catalog had never seen adopted the nearest older entry's
rate. `claude-opus-4-9` resolved to `claude-opus-4` and priced at the retired $15/$75 —
the same 3× error, reachable by any newly released model. This also made the codebase's
own stated rule ("an unrecognized model is unpriceable, never guessed") unreachable,
because almost nothing was ever unrecognized.

**The savings comparison used capability, not cost.** A model's tier
(haiku/sonnet/opus) was inferred from regexes over its *name*, and the savings math
then treated tier rank as a stand-in for price rank. Those disagree in 38 places in the
current catalog: `claude-fable-5` is a top-class model at $60/Mtok blended while
`claude-opus-5` is a top-class model at $30, and Mistral's flagship costs less than its
mid model. Consequences: the baseline could be chosen inconsistently (the same session
could report **$24.00 or $84.00 purely from the order lines appeared in the log file**),
work that cost *more* than the baseline was silently discarded instead of subtracted,
and a single fast-mode turn priced every other call's counterfactual at the 2× fast SKU.

### What changed

- **Per-model price catalog.** Every rate is transcribed from the provider's own pricing
  page, with the transcription date recorded. No interpolation, no family averages.
- **Cache, long-context, batch and fast-mode rates are modelled per model.** In
  particular, Claude Code writes **1-hour** cache entries, which bill at 2× input, not
  the 1.25× that 5-minute writes cost. This was previously undercounted.
- **Model resolution fails closed.** An id the catalog does not know is *unpriceable* and
  contributes $0. Provider prefixes and dated snapshots still resolve
  (`us.anthropic.claude-opus-5-20260101`); anything else must be added deliberately.
- **Savings are computed in dollars, from the catalog.** Tier is now a capability class
  used only for routing, is declared in the catalog next to the price rather than guessed
  from the model's name, and never touches a dollar figure.
- **Work that cost more than the baseline is subtracted and named**, not dropped.
- **Baselines are order-independent**, ranked on a fixed basket at the session's own date.
- **Promotional windows are evaluated against the date each call happened**, defaulting
  to today rather than the catalog's build date. Claude Sonnet 5's launch pricing ends
  2026-08-31; previously every surface would have kept quoting the promo rate forever.
- **Gateway figures are priced at the model actually served.** The gateway had been
  pricing the routed leg at a family tier *representative* rather than the model in the
  row — a 50% over-report, on the one path whose figures print with no hedge.
- **The end-of-chat line names models, not tiers.** "12 calls on claude-sonnet-5 instead
  of claude-opus-5" is checkable; "sonnet tier instead of opus" was not.
- **"You spent $X" is gone.** Most sessions run against a flat-rate subscription where
  that sum is never charged. The line now reports the *metered value at list API rates*,
  which is the honest reading whether you are billed per token or on a plan.
- **Estimated figures read "about $X".** The previous `~$X` rendered as `-$X` next to the
  dollar sign, making both spend and savings look negative.
- **The lifetime ledger is signed.** A chat where routed work cost extra now subtracts,
  and a corrected re-run overwrites its earlier figure. It was previously a one-way
  ratchet that could only ever record a high-water mark of optimistic estimates.

### Also

- The marketing site's footer displayed a "savings" figure generated by
  `Math.random()`, incrementing on a timer and resetting on page load. It has been
  removed. It was never connected to any data.
- The savings calculators now state that they are illustrative, and their 80% factor is
  derived from two published prices (Opus 5 → Haiku 4.5 at list, equal tokens) rather
  than asserted.
- Tool counts are reconciled: **36** tools have documented setup, `peek` **detects 8**
  harnesses and **reads 7**. The site previously published 36, 20, 18, 8 and 7
  interchangeably.
- Cross-runtime parity is now enforced in CI: the Node and Python pricing engines must
  return identical answers for every catalog id, or the build fails.

### If you compare against a provider invoice

Cheaper models public list prices. It cannot see negotiated rates, committed-use
discounts, credits, or free tiers, and Gemini's per-hour context-cache storage is not
attributable to a single call and is omitted. Figures marked "about" are estimated from
your local chat history; unmarked figures come from the gateway, which observes both the
model requested and the model served.
