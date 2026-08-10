# `cheaper peek` — retrospective savings estimator

## What it is

A new CLI command (and desktop/web surface) that scans a user's **existing** local
AI-coding-harness chat histories and estimates the tokens and real dollars adaptive
routing *would* have saved — before they install anything. It replays the gateway's
exact routing decision on each recorded model call.

```
cheaper peek [--days N] [--harness <key>] [--limit N] [--json]
```

## Why

The tracker page estimates savings from a hypothetical task mix. Users asked for a
one-command way to test it against their *own* history right after installing — a
concrete, personal number instead of a model.

## How it works

1. **Adapters** (`cli/src/peek/adapters.js`) locate and parse each harness's on-disk
   history into normalized call records `{harness, ts, model, inTokens, outTokens,
   text, source, estimated}`. `text` is **user-authored prompt text only** — tool_use
   / tool_result / function-call blocks are dropped at the adapter boundary so
   credential-bearing command output never enters the pipeline.
2. **Classifier** (`cli/src/peek/classify.js`) — a faithful Node port of
   `gateway/app/router.py`'s `_content_tier` + the requested-model **ceiling**
   (`effectiveTier = min(rank(actualModel), rank(contentTier))`).
3. **Pricing** (`cli/src/peek/pricing.js`) maps any model id → `{family, tier}` and
   family → `{cheap, mid, top}` real `$/Mtok` (in/out), only ever within the same family.
   Savings per call are **no longer** `cost(actualTier) − cost(effectiveTier)`: the routed
   leg is priced against the model `classify.routeDecision()` says the gateway would really
   **serve** — so a same-tier route is priced as the model substitution it is. See
   [parity-gates/same-tier-substitution-pricing.md](parity-gates/same-tier-substitution-pricing.md).
4. **Scan** (`cli/src/peek/scan.js`) rolls it up per harness + totals, with top
   downgradable examples (redacted, one-line snippets). It publishes **two** counts —
   `downgradable` (a TIER move) and `substituted` (a MODEL change, which is what the
   dollars come from) — plus three named exclusions: `unpriced` (no rate for the model that
   ran), `unpricedRoute` (no rate for the model we would route to) and the unroutable-vendor
   split. See
   [parity-gates/reconciling-downgradable-with-the-dollars.md](parity-gates/reconciling-downgradable-with-the-dollars.md).
5. **Render** (`cli/src/peek/render.js`) prints the terminal report; `--json` emits
   the raw report object. Every dollar cell is governed by `claimOf`, which decides between
   *not covered* / *withheld* / *—* / a figure. Dollars are **withheld** — never printed as
   `$0.00` — when more than 20% of the tokens seen could not be priced on **either** leg:
   `unpriced` (no rate for the model that ran) or `unpricedRoute` (no rate for the model we
   would route to). One threshold governs both, and the withholding names which leg caused
   it, because the two have different remedies.

## Harness support

| Harness | Status | Notes |
|---|---|---|
| Claude Code | **supported** | `~/.claude/projects/**/*.jsonl`; real token counts; sub-agent sidechains (`isSidechain` + sibling `subagents/`); **usage deduped by `message.id`** (one API turn spans multiple lines that repeat the same usage). |
| Codex | experimental | `~/.codex/sessions/**/rollout-*.jsonl`; model from `turn_context.payload.model`, messages from `response_item`; **tokens estimated** (codex `token_count` is cumulative/version-fragile — summing would inflate). |
| Gemini CLI / Grok / OpenCode / Copilot | experimental | generic JSONL/JSON engine; parses what it can, fabricates nothing. |
| Cursor | not yet | chats live in a SQLite `state.vscdb`; file-scan peek can't read it yet. |

## Correctness safeguards (from adversarial review)

- **Unknown models are unpriceable** — `detectFamily` returns `null` for
  unrecognized ids so peek never invents savings against arbitrary "other" rates.
- **Token dedup** by `message.id` prevents within-turn inflation (Claude Code).
- **Ceiling honored** — a hard prompt already run on a cheap model shows no "savings".
  **`saved` is NO LONGER clamped.** It was `max(0, …)`; that clamp is reachable through the
  rate *shape* (a tier's route target is not cheaper than every model above it on every
  token mix), and clamping in the arithmetic makes a route that would have cost the user
  MORE read as a neutral `$0.00` and vanish from every total. `saved` is now a **signed**
  delta, split into `gross` / `extra` so an anti-saving is reported rather than suppressed.
  Do not reintroduce the clamp.
- **Caveat surfaced** — output notes the estimate assumes the used model was the
  intended ceiling; harness-auto-selected models (titles/summaries) can nudge it.

## Surfaces

- **CLI**: `cheaper peek` — wired in `cli/bin/cheaper.js`.
- **Desktop**: "Savings peek" panel in `desktop/renderer/index.html`, via
  `peek:scan` IPC in `desktop/main.js` (runs the bundled CLI's peek core in-process),
  exposed by `desktop/preload.js`. Prompt snippets are HTML-escaped in the renderer.
- **Web**: "Test it on your real history" section on the savings tracker with the
  command + a representative terminal output (the browser can't read local files).

## Files

- New: `cli/src/peek/{index,classify,pricing,adapters,fsutil,scan,render}.js`,
  `cli/test/peek.test.js`, `cheaper-app/docs/peek.md`.
- Changed: `cli/bin/cheaper.js` (command + help + quickstart), `desktop/main.js`,
  `desktop/preload.js`, `desktop/renderer/index.html`, `README.md`; and in the site
  repo `../cheaper-web/web/index.html` (real logos) +
  `../cheaper-web/web/claude-code-savings-tracker.html` (peek section).

## Validation

- `node --test cli/test/` → 7/7 pass (classifier, model→tier, family/unpriceable,
  ceiling, savings math, `message.id` dedup, end-to-end fixture scan).
- Tests use `CHEAPER_PEEK_HOME` pointed at a temp fixture — never real user history.
- `node --check` clean on all peek + desktop JS.
- Manual CLI run against a synthetic fixture produced the expected report.

## Follow-ups

- Cursor SQLite reader (bundle a tiny zero-dep sqlite reader, open `mode=ro`).
- Real Codex token counts (parse `event_msg` `token_count.last_token_usage` carefully,
  not cumulative).
- Verify Gemini/Grok/OpenCode/Copilot generic parsing against real fixtures.
- Optional: price overrides via env (`CHEAPER_PRICE_*`) to mirror the gateway.
