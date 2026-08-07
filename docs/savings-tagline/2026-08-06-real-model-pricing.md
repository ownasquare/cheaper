# Real per-model pricing for the savings tagline

**Date:** 2026-08-06
**Repo:** `cheaper-app` (branch `main`, base commit `60ba1d5`)
**Trigger:** A chat's tagline reported `~$97.25` of spend against a $200/mo
subscription. The user asked whether the token counts or the prices were wrong,
and asked that every provider's numbers come from the providers themselves.

## Answer to the reported symptom

**The token counts were right; the prices were wrong.** Repricing a real 69-call
Opus 5 session shows the old table produced **2.74x** the correct figure:

| | This session |
|---|---|
| Old table (`claude-opus-4` @ $15/$75, all cache writes 1.25x) | **$58.36** |
| Correct Opus 5 rates ($5/$25) | $19.45 |
| Correct 1-hour cache-write multiplier (2x) | **$21.29** |

Two errors in opposite directions: pricing current Opus traffic at retired Opus 4
rates overstated it by $38.91, and treating 1-hour cache writes as 5-minute writes
understated it by $1.83. Net 2.74x too high. A `~$97.25` line was therefore
roughly `~$35` of real metered value — which reconciles with a $200/mo plan.

Token accounting itself was accurate: this session was 29.66M cache-read tokens out
of 30.2M total, and cache reads bill at 10% of input. Large token counts with a
small bill are the expected shape of a long Claude Code session.

## Defects found and fixed

1. **Retired model rates.** `FAMILIES` priced the whole Anthropic "top" tier as
   `claude-opus-4` ($15/$75). Current Opus is $5/$25 — a flat 3x overstatement on
   every Claude Code session. Same class of staleness across every family:
   `gpt-4o-mini`/`o3` as the OpenAI poles, `grok-3`, `deepseek-chat`,
   `mistral-large` at $2/$6, `gemini-1.5-flash-8b`.
2. **Three price buckets could not express real prices.** Opus 4 and Opus 5 are
   both "opus tier" and 3x apart. Replaced with a per-model catalog.
3. **Cache TTL collapsed.** Anthropic bills a 5-minute cache write at 1.25x input
   and a 1-hour write at 2x. Claude Code writes 1-hour entries and records the split
   in `usage.cache_creation.ephemeral_{5m,1h}_input_tokens`; the code applied 1.25x
   to everything.
4. **Anthropic cache multipliers applied to every vendor.** OpenAI publishes an
   explicit per-model cached-input rate and charges for cache *writes* only on the
   5.6 family; Google and xAI publish cache rates and no write fee. Applying a 1.25x
   write premium to those invented a charge that does not exist.
5. **No long-context tiers.** Gemini Pro and every current Grok model roughly double
   above a 200k-token prompt.
6. **`service_tier` and `speed` ignored.** Batch is half price; Anthropic fast mode
   is a 2x SKU ($10/$50 on Opus 5). Both are recorded per call by Claude Code.
7. **Output zeroed in two adapters.** The Codex and generic adapters emitted
   `outTokens: 0` when usage was unreported. Output bills at 4-8x input, so this
   erased most of a session's cost.
8. **OpenAI-shaped cached tokens not split out.** `prompt_tokens_details.cached_tokens`
   is included in `prompt_tokens`; not subtracting it billed cache hits at the fresh
   rate (up to 40x too high on GPT-5).
9. **`FAMILIES`/`BUCKET` imported but unused** in `scan.js`.
10. **A third, shipped copy of the price table.** `cli/assets/gateway/app/pricing.py`
    is what npm publishes (see `package.json` `files`) and was maintained by hand —
    a fix to `gateway/app/` reached no user.
11. **`files` allowlist excluded `*.json`**, so the new price table would not have
    shipped and the gateway would have crashed on import.
12. **"You spent $X" is false on a subscription.** Reworded — see below.

## Reasoning / effort accounting

Verified rather than assumed: every provider bills reasoning and thinking tokens at
the **output** rate and already includes them in the reported output count
(Anthropic `output_tokens`, OpenAI `completion_tokens` with
`completion_tokens_details.reasoning_tokens` as a subset). No separate term is
needed, and adding one would double-count. Effort level therefore changes the bill
only through the output tokens it produces, which are already measured. This is now
stated in the code so the next reader does not "fix" it by adding a term.

## Wording change

Was: `You spent ~$97.25 and 41.1M tokens on this session.`
Now: `This session ran 41.1M tokens, worth ~$35.50 at list API rates.`

Most sessions run against a flat-rate subscription where no such sum is ever
charged. The number honestly measures the metered value of the tokens at published
list rates, which is the correct basis whether the user is billed per-token or on a
plan. A test asserts the line never says "you spent".

## Architecture

- `cli/src/peek/models.js` — **single source of truth.** Per-model catalog with
  `CATALOG_AS_OF`, source URLs, cache read/write rates, long-context tiers, speed
  SKUs and dated promotional windows (Sonnet 5's $2/$10 intro through 2026-08-31).
  Resolver normalizes Bedrock/Vertex prefixes and dated snapshots.
- `cli/src/peek/pricing.js` — `costOfModel()` for exact spend; family+tier buckets
  retained only for the routing counterfactual and now backed by *real* current
  models (`REPRESENTATIVE`).
- `cli/scripts/sync-prices.js` — projects the catalog into
  `gateway/app/model_prices.json`, the shipped `cli/assets/gateway/app/` copy, and
  the gateway `.py` modules. `--check` fails if any is stale.
- `gateway/app/pricing.py` — now a loader over the generated JSON. **No prices are
  duplicated in Python.** Two hand-maintained tables is what caused the drift.

## Open-weight models are deliberately unpriceable

Llama and Qwen have no single list price — the same weights cost 3-12x more on one
host than another. They resolve to a vendor (for grouping) but to `null` in the
catalog, so they contribute zero rather than a fabricated rate. Pricing them would
require the user to configure a host; that is not implemented.

## Validation

- `npm test` in `cli/`: **33/33 pass** (was 26; +7 covering per-model rates, cache
  TTL, long-context tiers, promo windows, catalog invariants, representative
  resolution, and the JS/Python sync guard).
- `python3 app/pricing.py` self-checks pass in `gateway/app/` and in the shipped
  `cli/assets/gateway/app/`.
- `node scripts/sync-prices.js --check` clean; wired into `npm test`.
- Live check: `cheaper peek --tagline --current` returns a corrected line. The global
  `cheaper` is symlinked to this repo, so the CLI fix is live immediately.

## Deploy status

- Repo changes are **uncommitted** on `main` (base `60ba1d5`). Not published to npm.
- The installed gateway at `~/.cheaper/gateway/app/` was synced (`pricing.py`,
  `metrics.py`, `model_prices.json`) and verified to import; it was stopped at the
  time, so no restart was required.
- `npm publish` is 2FA-gated and was not attempted.

## Follow-up fix same day: the resolver failed OPEN (root cause of both incidents)

An 18-agent design review (see `2026-08-06-pricing-truth-architecture.md`) found that the
per-model catalog shipped earlier in this session still carried the *mechanism* behind
both mispricing incidents. `resolveModel()` matched by **longest prefix**, so an id the
catalog had never seen silently inherited a sibling's rate. Verified against the live
catalog before fixing:

| Requested id | Resolved to | Applied | Wrong by |
|---|---|---|---|
| `claude-opus-4-9` | `claude-opus-4` | $15/$75 | **3x over** (Opus-current is $5/$25) |
| `claude-sonnet-5-2` | `claude-sonnet-5` | $2/$10 | inherits a promo window never granted |
| `gpt-5.6` | `gpt-5` | $1.25/$10 | ~4x under |
| `o3-deep-research` | `o3` | $2/$8 | different SKU |
| `gpt-5-codex` | `gpt-5` | $1.25/$10 | different SKU |

`claude-opus-4-9 → $15/$75` is the exact shape and near-exact magnitude of the 2.74x
incident. Worse, prefix matching made this module's stated rule — *"an unrecognized model
is UNPRICEABLE, never guessed"* — **unreachable**: almost nothing is ever unrecognized if
every new id can latch onto an old one. And a prefix hit produces no catalog diff, so no
review, alarm, or crawler could ever have detected it.

**Fix:** matching is now EXACT after normalization, with an explicit per-entry `aliases[]`
escape hatch. Normalization still handles provider prefixes and dated snapshots, so
`us.anthropic.claude-opus-5-20260101` resolves; anything else must be added deliberately.
Applied identically in `models.js` (`entryMatches`) and `gateway/app/pricing.py`
(`_entry_matches`), with negative fixtures in both runtimes so it cannot regress.

This fails **closed**: an unknown model is unpriceable and contributes $0. That is visible
and self-correcting. A silently-wrong rate is neither.

## Follow-ups

- **Prices need a refresh cadence.** `CATALOG_AS_OF` is `2026-08-06`. Sonnet 5's
  intro window expires **2026-08-31**, after which its rate steps $2/$10 -> $3/$15
  automatically via the window logic — but the rest of the catalog needs a manual
  re-verify against the six source URLs in `models.js`.
- Gemini context-cache **storage** ($1.00-$4.50/hour) is not attributable to a single
  call and is omitted; a session-level estimate could be added.
- Server-side tool calls (`server_tool_use.web_search_requests`) are recorded by
  Claude Code and billed per request, but are not yet priced.
- The Codex adapter still estimates tokens from text length because its own
  `token_count` events are cumulative and version-fragile; records are flagged
  `estimated` and output is now estimated rather than zeroed, but a real parser
  would be better.
