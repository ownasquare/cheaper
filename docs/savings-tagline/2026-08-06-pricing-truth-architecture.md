# Pricing Truth for Cheaper.app — Final Recommendation

**Date:** 2026-08-06 · **Status:** decision document · **Scope:** cheaper-app (cli, gateway), cheaper-web, cheaper-desktop, new `cheaperapi` Worker

---

## 1. The answer

**Yes — there is a reliable way to stop lying about spend, cost, and savings. It is not a crawler.**

A crawler fixes *"our numbers got old."* Neither of your two incidents was caused by numbers getting old. Both were caused by two structural properties of the pricing path, and a crawler fixes neither one:

**Root cause #1 — identity resolution fails open.** `cli/src/peek/models.js:180-217` resolves a model id by *longest prefix match* (`looseStartsWith`). An id the catalog has never seen silently inherits a sibling entry's rate. I verified this against your live catalog:

| Requested id | Resolves to | Rate applied | Reality |
|---|---|---|---|
| `claude-opus-4-9` | `claude-opus-4` | $15 / $75 | Opus-family current is $5/$25 → **3.0x overstatement** |
| `gpt-5.6-luna-272k` | `gpt-5.6-luna` | $0.2 / $1.2 | 272k variant is $0.4/$1.8 → **2x understatement** |
| `gpt-5.6` | `gpt-5` | $1.25 / $10 | 5.6 family is ~$5/$30 → **4x understatement** |
| `claude-sonnet-5-2` | `claude-sonnet-5` | $2 / $10 | inherits a **promotional window it was never granted** |
| `o3-deep-research` | `o3` | $2 / $8 | different SKU entirely |

Your codebase already states the correct rule — *"an unrecognized model is UNPRICEABLE and contributes zero, never a guessed rate"* (`pricing.js:22-23`). Prefix matching means almost nothing is ever unrecognized, so the honesty rule is unreachable. `claude-opus-4-9 → claude-opus-4 at $15/$75` is the exact shape and near-exact magnitude of the 2.74x incident. **This will produce incident #3 with or without a crawler, and a crawler cannot see it, because a prefix hit generates zero catalog deltas — there is no diff for quorum, invariants, review, or signing to inspect.**

**Root cause #2 — no surface renders the age or provenance of a number.** `CATALOG_AS_OF` appears in exactly zero user-facing places. Not in `render.js`, not in `tagline.js`, not in `dashboard.html`, not in the desktop renderer, not in `/healthz`. Two independent snapshot paths exist with no updater anywhere in `cli/src/`: the gateway's table is frozen at `cheaper install gateway` (`install.js:105-109`), and the desktop's is frozen at DMG build time. A rate that is stale by six months is byte-indistinguishable, at every human checkpoint, from a rate verified this morning.

**What a crawler actually buys you, honestly stated:** it shortens the window between a provider changing a price and you knowing. That window was never your failure mode. And a crawler with write authority *industrializes* the failure — it converts a manual error rate into an automated one at global scale, on a schedule, with the appearance of rigor attached.

**What actually fixes it, in priority order:**

1. Make an unpriced thing **unpriceable**, not approximately priced. (Root cause #1.)
2. Make **age and provenance visible** on every surface that prints a dollar. (Root cause #2.)
3. Store **tokens, derive dollars** — so every number you have ever published is recomputable and restatable when you are wrong again.
4. Never let a machine **assert** a number a human has not read. Automation may only *propose* or *degrade*.

Items 1, 2 and 4-as-CI-gates require **no new infrastructure and no Cloudflare**. That is Phase 0 and it is where almost all the safety is.

---

## 2. Recommended architecture: **Ledger**

> **The price catalog is a signed release artifact, not a database. Automation may propose a price or withdraw one; only a human merge can assert one. Clients price entirely from a local file and the network is a strict, verified, out-of-band upgrade.**

```
GitHub Actions (daily 04:17 UTC)
  fetch 8 sources ──► normalize ──► quorum + invariants ──► diff
                                                            │
        ┌───────────────────────────────────────────────────┤
        │ no rate change                    rate change     │
        ▼                                                   ▼
  RE-ATTEST (automated)                        open/update ONE PR
  same rates, new verified_at                  branch: catalog/pending
  CI asserts rate bytes identical              body: replay-corpus $ delta
        │                                                   │
        │                                          HUMAN MERGE (gate)
        └──────────────────┬────────────────────────────────┘
                           ▼
              CI: sync-prices --check, golden vectors (JS+Py),
              replay coverage gate, canonicalize (JCS), sha256,
              Ed25519 sign (key in GH Environment, never in a Worker)
                           ▼
        upload immutable blob + .sig ──► READ BACK over public net ──►
        verify ──► flip signed pointer ──► append hash-chained history
                           ▼
        api.cheaper.app  (Workers static assets: free, unlimited, ~330 colos)
                           ▼
        CLI / gateway / desktop / marketing site
        price from LOCAL file, always; refresh detached, ≤1/24h, verified
```

**Cloudflare footprint (deliberately small):** one new Worker `cheaperapi` on `api.cheaper.app`, one D1, one R2 bucket (raw source archive, written from Actions), one cron (daily stats snapshot + health). **No KV. No Durable Objects. No Analytics Engine. No Workflows. No WebSockets.** Reasoning in §10.

---

## 3. Four corrections to your proposal

### 3.1 `GET /tools/<tool>/` returning pricing is the wrong resource — and it is the bug you just fixed

Pricing is a property of **`(provider_route, model_id, sku, region, effective_from)`**. It is never a property of a tool. Your own code agrees: `models.js` is keyed by model id and family; `adapters.js:332-344` (`HARNESSES`) carries **no price field at all**.

The one place in your entire stack where a *tool* is given a price is `cheaper-web/web/claude-code-savings-tracker.html:299-312`, which assigns each tool a `{frontier, mid, cheap}` model and price. That is why it prices **Cursor as Anthropic-only** and **Codex as OpenAI-only**, against a table (`:270-298`) containing **Claude Opus 4 at $75, GPT-4o, o3, and Gemini 1.5**. This is the exact bug you just fixed in the CLI and gateway, still live on your most-visited surface. Modelling price under a tool key in the API would re-create it as a contract.

**Correct shape.** `/v1/tools/{tool}` returns a *mapping* and `pricing: null`, always:

```json
GET https://api.cheaper.app/v1/tools/claude-code
{
  "tool": "claude-code", "label": "Claude Code", "vendor": "Anthropic",
  "protocol": "anthropic-messages",
  "routable": true,
  "observability": "transcript",
  "adapter": {
    "status": "supported",
    "source": "~/.claude/projects/**/*.jsonl",
    "token_counts": "native",
    "usage_fields": ["input_tokens","output_tokens","cache_read_input_tokens",
                     "cache_creation.ephemeral_5m_input_tokens",
                     "cache_creation.ephemeral_1h_input_tokens","service_tier","speed"]
  },
  "writes_1h_cache": true,
  "tagline_wired": true,
  "default_routes": ["anthropic"],
  "observed_model_ids": ["claude-opus-5","claude-sonnet-5","claude-haiku-4-5"],
  "pricing": null,
  "pricing_ref": "https://api.cheaper.app/v1/providers/{route}/models/{id}",
  "pricing_note": "Price is a property of provider+model+SKU+route, never of a tool."
}
```

A routable-but-unreadable tool returns honest emptiness — `"adapter": null, "observed_model_ids": [], "default_routes": []` — never a fabricated frontier/mid/cheap triple. Unknown tool → `404 {"error":"unknown_tool"}`. Enforce the honesty rule at the API boundary too.

### 3.2 WebSockets are not warranted — and your own instinct was right, more strongly than you stated

You wrote *"pricing changes rarely so socket may not always be needed."* It's stronger than that. WebSockets lose on all four axes simultaneously:

- **Cost is inverted.** Every WebSocket message is a billed Durable Object request ($0.15/M), and the connection itself is a billed request. Hibernation stops *duration* charges but not *per-message* charges. To deliver roughly one message a week, a connection idles ~604,800 seconds. The competing design — `GET` with `If-None-Match` against a **Workers static asset** — costs **$0**: static asset requests are free, unlimited, and do not count against billable Worker requests.
- **Push does not shorten the critical path.** Before a catalog is usable a client must verify an Ed25519 signature, a sha256, a monotonic sequence, a `min_client` floor, and blast-radius sanity gates. The *trust step* is the latency, not the transport.
- **It is a privacy regression.** A long-lived connection is a stable session identifier bound to an IP for its lifetime, linking every message over it into one trajectory — undoing the entire identifier-free telemetry design.
- **It is a correctness regression.** Push encourages apply-on-arrival, which is precisely how one bad publish becomes a global wrong number in seconds. The whole design wants adoption to be slow, gated, and refusable.

**Telemetry over WebSockets is worse still**: a single DO becomes a global single-region write bottleneck and every POST becomes a billed DO request, to carry one message per install per day.

**What replaces the thing you actually wanted (fast correction):** a signed `alerts.json` at `max-age=300`, carrying `revoked[]` and `disputed[]`, fetched in the same daily check as the catalog pointer — plus a **`not_after` self-expiry baked inside the signed catalog**, which is the only recall mechanism that reaches an offline, firewalled, or pinned client with no network at all. I am telling you plainly: the realistic propagation SLA for a correction is **one client refresh cycle (≤24h + jitter)**, not minutes. Anything faster requires an npm patch release. Do not build a socket to buy a claim you cannot honour anyway.

If you ever *do* need one-way push (a live desktop counter), use **SSE from a stateless Worker**, not a Durable Object: HTTP-triggered Workers have no wall-clock limit while the client stays connected and bill only CPU, so an idle stream is ~0 CPU. It must never be able to deliver a price.

### 3.3 A crawler must never write production prices

This is the load-bearing decision in the whole design.

The crawler's **only** write authorities are: (a) archive raw source bytes to R2, (b) open or update **one** pull request. It holds **no** Ed25519 signing key, **no** wrangler deploy credential, **no** npm token, and **no** write path to `model_prices.json`. There is no auto-merge rule and no confidence threshold that bypasses review — any such threshold is a promise that quorum plus invariants can substitute for a human, which is exactly the claim two incidents falsified.

Three hard requirements that make this real rather than aspirational, because a "human gate" defeated by review fatigue is not a gate:

1. **The bot's write surface is mechanically restricted, not review-restricted.** A GitHub repository ruleset permits the bot to write only `cli/src/peek/models.json`. A *required* status check asserts the PR's changed-file set is a subset of `{cli/src/peek/models.json}` and fails otherwise. CODEOWNERS requires a separate human on `.github/**` and `cli/scripts/**`. Without this, a PR that is 380 lines of legitimate price churn plus three lines in `publish.yml` gets merged by a reviewer who is looking at numbers.
2. **The crawler never emits code.** Today `models.js` is JavaScript source and model ids are free-form JSON keys from a community-editable MIT repo taking ~25 commits/month. A crafted id such as `claude-x'); require('child_process').execSync(...); anthropic('y` becomes executable at `require()` time — in CI, where the signing key lives, and in every user's Stop hook. **Fix:** `models.json` becomes the authored artifact, `models.js` a thin `JSON.parse` loader, and ingest hard-allowlists ids to `^[a-z0-9][a-z0-9._:-]{0,63}$`. Never ship regex *source strings* in the served catalog either — ship literal token lists compiled client-side, or a hostile `(a+)+@` becomes a ReDoS inside the gateway's per-request `detect_family`.
3. **Sign what was reviewed.** The signature attests the bytes came from your CI — not that they match the diff a human approved. Between merge and signature sit `sync-prices.js` and its dependency tree. A compromised transitive dev-dep that multiplies every `out` rate by 3.0 passes review (the PR diff was correct), passes the golden corpus (regenerated in the same process), and passes every client gate (3x < the 10x threshold). **Fix:** the PR CI records the resulting catalog sha256 as a required status check *before* merge; the signing job is a separate job with a separate token that **refuses to sign any sha not equal to the pre-merge recorded sha**. Generation and signing become two jobs and the sha is the contract between them.

**Run the ingest in GitHub Actions, not in a Cloudflare Worker.** A single `cheaperapi` Worker holding the cron, the ingest logic, the provider API keys, a repo-write PAT, *and* an unauthenticated public `POST /v1/usage` puts your highest-value credential in the same isolate as your lowest-trust input. Actions gives you a scoped short-lived `GITHUB_TOKEN`, provider keys next to the signing key under environment protection, real retry semantics (Cron Trigger retry behaviour is undocumented — `controller.noRetry()` exists but no doc states count or backoff), no 15-minute CPU ceiling, no Workflows step-billing exposure (billing starts **2026-08-10**), and a public per-run audit log that feeds your transparency log for free. It is less work than the Workflows design, not more.

### 3.4 The proposed telemetry field set is not anonymous

Row-level k-anonymity of your 16 fields is **1**, not "small." Three fields are continuous — money used/saved (IEEE754 floats; note `tagline.js:283-288` emits *full precision* on the `--json` path, not the rounded display value), memory consumed (bytes), and time (sub-day) — and **any one of them alone makes a typical row unique.**

The programming-languages list is the single worst field. An unordered set over ~50 values is structurally identical to the browser plugin list (15.4 bits) and font list (13.9 bits) that dominated entropy in Eckersley's Panopticlick study. Real language sets are Zipfian: `{js,ts,json,html,css}` is thousands of people; `{Rust,Zig,Nix,Erlang,OCaml}` is one person. It also joins cleanly to public GitHub language bars.

Free-text `tool` is an uncontrolled channel — your gateway's `_clean_tool` (`metrics.py:25-27`) only truncates to 48 chars, so it will eventually carry project, agent, and customer names.

And the highest *implementation* hazard: `scan.js:65-68` already pushes `{reason: content.reason, text: snippet(r.text)}` — up to 90 characters of the user's **verbatim prompt** (the masker at `scan.js:24-28` strips only 28+-char alphanumeric blobs; it does not strip names, emails, hostnames, ticket ids, or paths) plus a classifier reason that embeds the matched regex source, and `classify.js:22-23` includes `\bmedical\b`, `\bdiagnos`, `\blegal\b`, `\btax\b`, `\bfinanc`. Transmitting `"auto-escalate category: \bmedical\b"` is an inference about health — **GDPR Art. 9 special-category data**. The obvious implementation (upload `scan()`'s report) ships it.

**Disposition of your 16 fields:** 5 rejected outright, 1 replaced by an enum, 8 kept only heavily coarsened, 1 (reasoning) survives close to as-proposed. Full spec in §8.

Separately: ePrivacy Art. 5(3) requires prior opt-in **regardless of whether the payload is anonymous**, because the CLI reads `~/.claude/projects/*.jsonl` ("gaining access" to terminal equipment) and writes `~/.cheaper` ("storing"). Analytics is not "strictly necessary for a service explicitly requested," so legitimate interest is unavailable.

---

## 4. The catalog artifact

### 4.1 Three schema changes from today's `models.js`

**(a) Price becomes a time-series, not a scalar.** `peek` defaults to `sinceDays: 0` (`scan.js:92`, `index.js:11`) — **the entire transcript archive, months deep, is the default scan.** `gpt-5.6-luna` went $1/$6 → $0.2/$1.2 on **2026-07-30** under an unchanged model id. Every session before that date is currently priced 5x low, with no `~`, and then annualized (`scan.js:135` multiplies by `365/sinceDays`). A single "current rate plus one promo window" cannot express this. Replace `window` with an ordered, non-overlapping `rates[]`; a promo is just the first interval.

**(b) `tier` becomes an explicit field with a price-rank assertion.** Today it is a name heuristic (`classify.js:60-69`). `claude-fable-5` is priced $10/$50 — **double Opus 5** — and `model_tier('claude-fable-5')` returns `'sonnet'`. Every savings figure computed against that ceiling is wrong, and a crawler adding a model inherits the bug. CI asserts `out(opus) ≥ out(sonnet) ≥ out(haiku)` within each family. **This assertion will fail on day one against fable/mythos — that is the assertion working, and it requires a human decision (see §11).**

**(c) `route` and `region` join the primary key.** Identical `gpt-5.6-luna`: $0.1/$0.6 OpenAI direct, $0.22/$1.32 Bedrock, $1.00/$6.00 Azure, $1.10/$6.60 Azure EU. **A 10x error class, currently entirely unmodeled** — larger than the incident you just fixed. LiteLLM independently ships `regional_processing_uplift_multiplier_eu` and ten separate keys for `claude-opus-5`. An unknown route is **UNPRICEABLE**, not assumed-direct, unless the entry carries a human-set `route_price_uniform: true`. (The naive rule "unpriceable only if known routes differ in price" fails open on exactly the newest models, where the catalog knows one route.)

### 4.2 Matching: exact plus explicit aliases. This is the fix for root cause #1.

```js
// cli/src/peek/resolve.js
export function resolveModel(id, { at }) {          // `at` REQUIRED, three-valued
  const norm = normalize(id);
  const entry = CATALOG.byId.get(norm) || CATALOG.byAlias.get(norm);
  if (!entry) return { priceable: false, reason: 'unknown_model', id: norm };
  if (at == null) return { priceable: false, reason: 'no_timestamp', id: norm };
  const t = (at === 'now') ? Date.now()
          : (at === 'catalog') ? Date.parse(CATALOG.as_of + 'T00:00:00Z')
          : Date.parse(at);
  const iv = entry.rates.find(r => t >= r.from_ms && (r.until_ms == null || t < r.until_ms));
  if (!iv) return { priceable: false, reason: 'no_rate_for_date', id: norm, at };
  const boundary = entry.rates.some(r =>
    Math.abs(t - r.from_ms) < 864e5 || (r.until_ms && Math.abs(t - r.until_ms) < 864e5));
  return { priceable: true, entry, rates: iv, boundary, verified_at: entry.verified_at };
}
```

Rules, all enforced by test:

- **No prefix fallback.** `aliases[]` and `prefixes[]` are per-entry, human-authored, and set in a reviewed PR.
- **`at` is required and three-valued** — an ISO instant, `'now'`, or `'catalog'` — and it **never throws**. A record with no timestamp yields `{priceable:false, reason:'no_timestamp'}`, counted and surfaced. This matters because `peek`'s premise is parsing transcripts you do not control: Codex tokens are already inferred (`adapters.js:244-252`), the Cursor adapter reads nothing, and truncated JSONL is routine. A throwing required argument turns one bad line into a non-zero exit from `spawnSync` inside the Stop hook and the tagline silently disappears from every chat turn. Wrap the hook's call so it always exits 0.
- **Intervals are half-open `[from, until)` with explicit instants carrying the provider's billing timezone.** Bare `YYYY-MM-DD` compared with string ordering gives you four different answers for one call: `new Date('2026-09-01T00:30:00Z')` truncates to `2026-09-01` in UTC and `2026-08-31` in local. Sonnet-5 steps $2/$10 → $3/$15 on **2026-09-01 — 26 days from today** — so a Tokyo user's session at 08:00 JST on Sep 1 is still 16:00 PT Aug 31 on Anthropic's invoice. Store `"from": "2026-09-01T00:00:00-07:00"`. Calls within ±24h of an edge get `boundary: true` and print the existing `~`.
- **Golden fixtures, byte-identical in JS and Python**, at T−1h / T / T+1h of every boundary, run with `TZ` set to UTC, `America/Los_Angeles`, and `Asia/Tokyo`. Plus negative cases asserting `claude-opus-4-9`, `gpt-5.6-luna-272k`, `o3-deep-research`, `claude-sonnet-5-2` all resolve **unpriceable**, and a fixture file of synthetic successors (`<each id>-9`, `<id>-preview`) asserting the same.

**Honest cost:** on day one a real fraction of live sessions becomes unpriceable and reported dollars drop. That is the correct direction of error for a savings claim, it matches the rule your codebase already states, and it needs release notes that say so plainly rather than looking like a regression.

### 4.3 Artifact shape

```json
GET https://api.cheaper.app/v1/catalog/v/2026-08-06-9f2a1c4b7e10.json
{
  "schema": 1,
  "version": "2026-08-06.3+9f2a1c4b7e10",
  "version_seq": 412,
  "as_of": "2026-08-06",
  "not_after": "2027-02-02",
  "generated_at": "2026-08-06T04:31:09Z",
  "source_commit": "a1b2c3d",
  "prev_sha256": "5c11ab...",
  "tz_note": "All effective instants carry the provider's billing timezone. Intervals are [from, until).",
  "routes": {
    "anthropic":  {"kind":"direct","region":null,"uplift":null},
    "bedrock-us": {"kind":"reseller","region":"us","uplift":null},
    "vertex":     {"kind":"reseller","region":null,"uplift":null},
    "azure":      {"kind":"reseller","region":"us","uplift":null},
    "azure-eu":   {"kind":"reseller","region":"eu","uplift":1.1},
    "openai":     {"kind":"direct","region":null,"uplift":null},
    "xai":        {"kind":"direct","region":null,"uplift":null}
  },
  "models": [
    {
      "id": "claude-sonnet-5", "family": "anthropic", "route": "anthropic",
      "tier": "sonnet", "tier_source": "price_rank",
      "aliases": [], "prefixes": [],
      "status": "active", "priceable": true,
      "route_price_uniform": false,
      "prompt_cache_min_tokens": 512,
      "reasoning": {"efforts":["low","medium","high","xhigh","max"],"billing":"output_rate"},
      "rates": [
        { "from":"2026-01-01T00:00:00-08:00", "until":"2026-09-01T00:00:00-07:00",
          "label":"launch promotional",
          "in":2, "out":10, "cacheRead":0.2, "cacheWrite":2.5, "cacheWrite1h":4,
          "provenance": {
            "in":  {"quorum":3,"classes":["community","community","curated"],
                    "sources":["litellm@2026-08-06","models.dev@2026-08-06","llm-prices@2026-08-05"]},
            "out": {"quorum":3,"classes":["community","community","curated"],
                    "sources":["litellm@2026-08-06","models.dev@2026-08-06","llm-prices@2026-08-05"]},
            "cacheWrite1h": {"quorum":2,"classes":["community","human_read"],
                    "derived":{"from":"in","factor":2.0,"basis":"ANTHROPIC_CACHE.write1h"},
                    "sources":["litellm@2026-08-06",
                               "anthropic-docs#sha256:7d31c0…@2026-08-04"]}
          }},
        { "from":"2026-09-01T00:00:00-07:00", "until":null,
          "in":3, "out":15, "cacheRead":0.3, "cacheWrite":3.75, "cacheWrite1h":6,
          "provenance": {"in":{"quorum":2,"classes":["curated","human_read"],
                               "sources":["llm-prices@2026-08-05","anthropic-docs#sha256:7d31c0…"]}} }
      ],
      "skus": {},
      "longContext": null,
      "verified_at": "2026-08-06"
    }
  ],
  "unpriceable": [
    {"match":"prefix","value":"llama-","reason":"open_weight_no_canonical_host_price","observed_spread":58.4},
    {"match":"prefix","value":"qwen",  "reason":"open_weight_no_canonical_host_price","observed_spread":100.0},
    {"match":"prefix","value":"ft:",   "reason":"fine_tune_org_scoped"}
  ],
  "routing_targets": {
    "anthropic": {"haiku":"claude-haiku-4-5","sonnet":"claude-sonnet-5","opus":"claude-opus-5"},
    "openai":    {"haiku":"gpt-5-mini","sonnet":"gpt-5.4","opus":"gpt-5.6-sol"}
  },
  "classifiers": {
    "family_tokens": [
      ["anthropic",["claude","haiku","sonnet","opus","fable","mythos","anthropic"]],
      ["mistral",  ["mistral","mixtral","codestral","ministral","magistral","devstral"]]
    ],
    "reasoning_think_tokens": {"none":0,"low":250,"medium":1200,"high":4000},
    "reasoning_note": "measure-only; billed at the output rate for anthropic/openai/google"
  }
}
```

Two things this schema encodes that your current one cannot:

- **`provenance` is per-dimension, with a `derived` marker.** Your current draft would attach `{quorum:3, sources:[litellm, models.dev, anthropic.docs]}` to `cacheWrite1h` — but **models.dev's cost schema has no `cache_write_1h` field**, so two of the three never observed that number. Fabricated attribution is worse than absent attribution, because a reviewer and an auditor both stop looking. CI asserts every source listed for a dimension actually carried that dimension in that run.
- **`reasoning.billing`.** Your stated invariant — *reasoning always bills at the output rate* — is **provably false**. Perplexity prices `sonar-deep-research` reasoning at **$3/M against $8/M output (0.375x)**, plus citation tokens at $2/M, corroborated independently by OpenRouter's `internal_reasoning` and LiteLLM's `output_cost_per_reasoning_token` (55 entries carry it). It holds for Anthropic/OpenAI/Google; encode it as the default, never as a universal.

### 4.4 The signed pointer, alerts, and transparency log

```json
GET https://api.cheaper.app/v1/catalog/latest.json      (+ latest.json.sig)
{
  "schema": 1,
  "issued_at": "2026-08-06T04:31:40Z",
  "version": "2026-08-06.3+9f2a1c4b7e10",
  "version_seq": 412,
  "as_of": "2026-08-06",
  "sha256": "9f2a1c4b7e10c3d5…",
  "url": "https://api.cheaper.app/v1/catalog/v/2026-08-06-9f2a1c4b7e10.json",
  "sig_url": "https://api.cheaper.app/v1/catalog/v/2026-08-06-9f2a1c4b7e10.json.sig",
  "min_client": "0.3.0",
  "signing_key_id": "cat-2026a"
}
```

```json
GET https://api.cheaper.app/v1/catalog/alerts.json      (+ alerts.json.sig)
{ "schema":1, "issued_at":"2026-08-06T11:02:00Z",
  "revoked":  [{"version":"2026-07-30.1+aa17be93f004","reason":"opus cacheWrite1h 4x high"}],
  "disputed": [{"route":"mistral","id":"magistral-medium","reason":"source_disagreement",
                "detail":"litellm 2.00/6.00 vs models.dev 0.50/1.50 @2026-08-06"}] }
```

```json
GET https://api.cheaper.app/v1/catalog/history.json      (+ .sig)
{ "schema":1, "head":"9f2a1c4b7e10…",
  "entries":[{"seq":412,"sha256":"9f2a…","prev_sha256":"5c11…","as_of":"2026-08-06",
              "git_commit":"a1b2c3d","pr":"cheaper-app#412","reviewers":["…"],
              "workflow_run":"https://github.com/…/actions/runs/…",
              "published_at":"2026-08-06T04:33:02Z"}] }
```

**The pointer and the alerts file must be signed.** Your draft signed only the catalog body while leaving `revoked[]`, `min_client`, and the content pointer outside the envelope. Anyone who can serve that one 600-byte file — a leaked assets deploy token, a corporate TLS-inspecting proxy, a stale edge copy — can set `min_client: "99.0.0"` and freeze every client's updates **forever, silently** (declining an update is indistinguishable from there being no update), or revoke the current good version to force every client back to a six-month-old bundled copy. `issued_at` plus a client rule refusing any pointer older than **30 days** bounds the freeze attack; the signature makes revocation a deliberate signed act.

**`history.json` is hash-chained** (`prev_sha256`) so a silent re-sign of an existing `as_of`, or a removed version, is detectable by you *or by a third party*.

### 4.5 Cache strategy — exact headers

**Cloudflare's default CDN cache decides by file extension and `.json` is not on the default list.** This is the single most common wrong assumption for this use case. Declare it explicitly.

```
# apps/api/public/_headers

/v1/catalog/latest.json
  Cache-Control: public, max-age=300, must-revalidate
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff

/v1/catalog/alerts.json
  Cache-Control: public, max-age=300, must-revalidate
  Access-Control-Allow-Origin: *

/v1/catalog/v/*
  Cache-Control: public, max-age=31536000, immutable
  Access-Control-Allow-Origin: *

/v1/catalog/history.json
  Cache-Control: public, max-age=3600
  Access-Control-Allow-Origin: *

/v1/stats/*
  Cache-Control: public, max-age=3600, stale-while-revalidate=86400
  Access-Control-Allow-Origin: *

/.well-known/*
  Cache-Control: public, max-age=3600
  Access-Control-Allow-Origin: *
```

**No `stale-while-revalidate` and no long `stale-if-error` on `latest.json` or `alerts.json`.** You rejected KV because a correction would serve a retired rate globally for 60+ seconds; `stale-if-error=604800` on the pointer permits **seven days** of the same failure on the same axis — and publishing the fix *is* a deploy, which is exactly when a 5xx is most likely. The pointer is 600 bytes on a free path; availability is not the constraint.

```jsonc
// apps/api/wrangler.jsonc
{
  "name": "cheaperapi",
  "account_id": "84a701a23afcd1b863bbf7f1b29bafa2",   // explicit: CLOUDFLARE_ACCOUNT_ID points at the WRONG account
  "main": "src/index.ts",
  "compatibility_date": "2026-08-05",
  "workers_dev": false,
  "preview_urls": false,
  "routes": [{ "pattern": "api.cheaper.app", "custom_domain": true }],
  "assets": {
    "directory": "./public",
    "not_found_handling": "none",
    "run_worker_first": ["/v1/providers/*","/v1/models/*","/v1/tools*","/v1/routing/*",
                         "/v1/reasoning/*","/v1/usage/*","/v1/health",
                         "!/v1/catalog/*","!/v1/stats/*","!/v1/replay/*","!/.well-known/*"]
  },
  "triggers": { "crons": ["7 1 * * *"] },              // daily stats snapshot + health rollup
  "d1_databases": [{ "binding": "LEDGER", "database_name": "cheaper-ledger" }],
  "observability": { "enabled": true, "head_sampling_rate": 0.1 }
}
```

`/v1/catalog/*` is **negated out of `run_worker_first`** so it resolves as a static asset — free, unlimited, tiered-cached, not billable. A deploy-time assertion must `curl` the catalog URL and confirm it was served as an asset, rather than trusting the glob. Use a **separate** Worker from `cheaperapp` (which is assets-only with no `main` and deploys on the marketing site's cadence): a crawler or API bug must not be able to take down cheaper.app, and the catalog must not disappear because a static-site build cleaned its output directory. `api.cheaper.app` is inside the `cheaper.app` zone, so your existing zone-bound token covers it.

**Publish is not atomic — make it verified.** Order: upload immutable blob + `.sig` → **fetch both back over the public internet from outside the deploy and verify sha256 + signature** → only then flip `latest.json` → only then append to `history.json` and D1. Derive `/v1/health`'s catalog fields from the **fetched** pointer, not from D1, so your health endpoint cannot lie about what is being served. Add an hourly external canary (a scheduled Action on different infrastructure) that fetches, follows, verifies, and pages on any break — because every client-side failure mode is deliberately silent.

### 4.6 Signing and verification

- **Ed25519**, detached 64-byte signature over **RFC 8785 (JCS) canonical bytes**. Signed in **GitHub Actions inside a protected Environment with required reviewers**; the private key never enters a Worker or any edge machine. Workers Web Crypto supports Ed25519 with no compatibility flag if you ever need edge verification — you don't.
- Node verifies natively: `crypto.verify(null, bytes, pubKey, sig)`. Python via `cryptography`.
- **Key set with `kid`, published at `/.well-known/cheaper-catalog-keys.json`, carrying `current` and a pre-published `next` key with ≥90-day overlap.** The CLI pins the key set as a constant and accepts a *new* key id only if the new key-set document is itself signed by a currently-pinned key.
- **The pinned key ships inside the artifact it protects** (npm tarball, DMG, R2 installer). That reduces the scheme to a checksum against the far more likely attack — a compromised npm publish token. Close it: enable **`npm publish --provenance`** (Sigstore/SLSA attestation binding the tarball to a public Actions run), require **signed git tags and protected branches**, publish the hash-chained transparency log, have `cheaper prices show` print the sha256 so any user can compare, and **cross-check the bundled catalog's sha against the transparency log on first successful refresh, warning loudly if absent.**

### 4.7 Client resolution order and the Stop-hook latency budget

The tightest budget in your product: `hooks.json:26-36` gives the Stop hook **15s**, wrapping a **12s** `spawnSync`, wrapping the existing **600ms** loopback fetch with silent-null fallback (`tagline.js:176-196`). **Nothing in this design adds a byte to that path.**

```
1. $CHEAPER_CATALOG        explicit file. MUST verify against the pinned key OR an
                           operator key in $CHEAPER_CATALOG_KEY. Unsigned requires
                           CHEAPER_CATALOG_UNSAFE=1, which suppresses ALL dollar output.
2. ~/.cheaper/catalog/pin  pinned version, honoured forever; refresh is a no-op.
3. ~/.cheaper/catalog/current.json   newest verified download (all §4.8 gates passed).
4. cli/src/peek/models.json          shipped in the npm package. The floor. Always valid.
```

Then overlay `~/.cheaper/catalog/alerts.json`. **The overlay may only set `priceable:false` / `disputed:true`; a merge function unit-test asserts no rate field can be introduced by an overlay**, and the client **rejects an overlay touching more than 15% of the catalog** (see §5.3).

Every step is a local file read. **`peek`, `peek --tagline`, the Stop hook, desktop `refreshPeek`, and gateway pricing all work with the network unplugged forever**, and CI proves it — with tests for the *hostile* offline cases (TCP-accept-then-stall, iptables `DROP`), not just blocked DNS, which fails fast and is the friendly case.

**Do not accept `CHEAPER_CATALOG` unsigned by default.** It sits at highest precedence with lowest verification; a committed `.envrc`, a devcontainer, a Dockerfile `ENV`, or a compromised shell rc then controls every dollar the machine prints. Stamp `catalog_trust: "signed" | "operator_key" | "unsigned"` into `peek --json`, `--tagline --json`, `/healthz` and `/metrics`, and suppress dollars entirely when unsigned. Enterprise mirrors get a *different key*, not *no key*.

**Refresh needs a real host.** `cheaper monitor` is a foreground TUI that errors unless the gateway is already running — it is a demo command, not a daemon, and the desktop app is an optional DMG. Without a host, the entire signed-network apparatus is dead code for the majority of installs.

```js
// Detached, once per 24h, jittered. Runs AFTER any cheaper CLI invocation exits.
// NEVER inside peek's or the Stop hook's own process.
const lock = `${CHEAPER_DIR}/catalog/.refresh.lock`;
try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch { return; }
fs.writeFileSync(stateFile, JSON.stringify({ last_attempt: Date.now() }));  // BEFORE spawn
const child = spawn(process.execPath, [refreshBin], { detached: true, stdio: 'ignore' });
child.unref();
```

`stdio: 'ignore'` is load-bearing and must be asserted by an end-to-end test (Stop hook wall-clock < 1.5s while a slow refresh is in flight): `spawnSync` in the hook drains piped stdout and will block until the **last** writer closes the pipe. Write the timestamp *before* spawning under an exclusive-create lock, or six concurrent Claude Code windows finishing a turn in the same second each spawn a Node process and a TLS handshake at the exact moment the user is waiting.

Refresh algorithm, with **explicit timeouts everywhere** (`AbortSignal.timeout`: 2s connect, 5s total, 2 attempts, then give up 24h; two consecutive failures set a 24h suppression flag so a filtered corporate network stops trying):

```
GET latest.json (If-None-Match) → 304 stop
  → verify pointer signature; reject if issued_at older than 30 days
  → version_seq strictly greater (or bundled min_version_seq floor for a fresh install)
  → semver-compare min_client with a real comparator (0.9.0 < 0.10.0 — LEXICOGRAPHIC IS WRONG)
  → GET immutable blob + .sig → verify sha256 matches the URL fragment → verify Ed25519
  → schema integer understood; as_of newer and not >2 days future; not in alerts.revoked[]
  → BLAST RADIUS: no model's in/out rate moved >1.5x; token-weighted aggregate of `out`
    across the routing_targets set moved <25%; model count did not drop absent a
    `removed[]` manifest naming each id; out ≥ in and 0.005 ≤ rate ≤ 500 for every entry
  → write ~/.cheaper/catalog/<sha12>.json, atomic rename current.json, keep last 3
Any failure at any step: leave everything untouched, record last_refresh_error, exit 0.
```

**The 10x blast-radius threshold in your draft is decorative.** Every real event sits below it: the Opus incident was 2.74x, the luna cut was 5x, the Sonnet-5 expiry is 1.5x. A gate calibrated above every true positive produces none. 1.5x with a human-typed `cheaper catalog refresh --accept-change <sha>` is the right setting, and the aggregate gate catches the uniform-multiplier attack that a per-model gate cannot see.

**`min_version_seq` in the bundled catalog** is what stops a replay-freeze against a fresh install, a wiped `~/.cheaper`, a CI container, or a Docker image — all of which start at seq 0, where monotonicity provides no floor. Ship the revocation list in the npm package too, so `npm i -g cheaper@latest` is a second independent recall channel.

**Gateway.** Keep the module-import `open()` of the shipped `model_prices.json` (`pricing.py:76`) so the gateway starts with zero network — that is the floor. At import, *attempt* `~/.cheaper/catalog/current.json` (written by the CLI, never fetched by the gateway); verify; replace the in-memory table if newer. Reload via an mtime check inside `summary()`, which already runs under `asyncio.to_thread` (`app.py:135, :165`) — **never on the `/v1/messages` path**. While you are there: `METRICS.record` does a blocking `sqlite3` INSERT inline in the async handler (`app.py:212-223`, `metrics.py:117-126`); move it to `asyncio.to_thread` or an `asyncio.Queue`. `router.py:67-71` and `app.py:87-91` read `routing_targets` from the catalog instead of hardcoding `claude-opus-4-6` / `o3`. And settle the name first: `docs.html:139` documents `OPENAI_MODEL_CHEAP/MID/FRONTIER` while `app.py:90` reads `OPENAI_MODEL_TOP`, so anyone following your docs silently keeps `o3` as their top tier.

**Desktop.** `main.js` reads `~/.cheaper/catalog/current.json` through the same order before falling back to the bundled CLI module (today its catalog is frozen at **DMG build time** — a second staleness path). The existing 180s `refreshPeek` interval triggers the detached refresh at most once per 24h. Add a `catalog` channel to the `preload.js` bridge.

**Pinning semantics — decide this explicitly, because it is one command away from the moment of maximum user frustration.** A pin **suppresses the hard-expiry refusal but never suppresses the staleness label.** A pinned expired catalog still prices, but every output carries `catalog: {pinned:true, as_of, oldest_verified_at, age_days}` and the tagline appends a marker. Pinning requires typing the sha. Pinned installs are excluded from the public counter and send no telemetry. Otherwise `cheaper catalog pin` becomes the documented workaround for the staleness control it bypasses — which is the original bug with an official CLI command.

### 4.8 Staleness alarm — per-entry, re-attested, jittered

Three corrections to the obvious design:

**(a) Staleness is per-entry, not catalog-wide.** Any merged PR — one Mistral model, a comment typo — bumps a catalog-wide `as_of` and resets the freshness clock for all 55 entries. The entry that is actually wrong never ages. **Compute thresholds over `min(verified_at)` across the entries that actually priced this session**, and render it that way: `oldest rate used: 2026-05-02 (claude-opus-5), 96 days`. `verified_at` advances **only** when a source affirmatively carried that model in that run; silence is not verification. llm-prices and genai-prices publish the per-model checked dates you need.

**(b) Publish a re-attestation on every successful ingest run, delta or not.** If publication is conditional on a delta, then "prices are genuinely stable" and "the crawler broke three weeks ago" produce the identical observable, and a fixed calendar fuse burns silently underneath both. The re-attestation job changes only `verified_at`, `as_of`, `sources[]` and `not_after`; **CI asserts the rate values are byte-identical to the previous release and aborts into a PR if any value moved.** That is a mechanically-checkable constraint, so automated signing of an unchanged catalog is safe.

**(c) Jitter the hard limits per install** (`+ hash(install_dir) % 14 days`) so a fleet degrades over two weeks instead of at one instant.

| Condition | Behaviour |
|---|---|
| `oldest_verified_at` > 45d | Banner on `peek`, `cheaper catalog status`, dashboard, desktop, `/healthz: degraded` |
| `oldest_verified_at` > 120d **for a given entry** | **That entry** becomes unpriceable (`reason: rate_expired`). Failure is per-model and gradual. |
| catalog `not_after` passed (as_of + 180d) | Refuse all dollar output; print token counts; name the exact `npm i -g cheaper@latest` command. Works offline, pinned, and firewalled — no network required. |
| entry in `alerts.disputed[]` | Keep pricing at the last human-approved rate, label `disputed` with the spread, **exclude from the public counter**. |
| entry in `alerts.revoked[]` or bundled sha revoked | Never silently fall back to revoked bytes. Print tokens plus an actionable upgrade message. |

Also render `as_of` and `oldest_verified_at` in `peek`, `peek --json`, `--tagline --json`, `/healthz`, `/metrics`, the dashboard, the desktop header, and next to the public counter. And retire the two strings that are now false: `scan.js:139` (`"Illustrative public list $/Mtok; ratios drive the estimate."`) and `cheaper-desktop/renderer/index.html:129`. They predate your exact-pricing rewrite and undercut the positioning it bought.

---

## 5. Ingest: sources, quorum, invariants, review gate

### 5.1 Sources

| id | class | role | license | may establish a rate? |
|---|---|---|---|---|
| `litellm` | community | **primary rates** — only source natively carrying `cache_creation_input_token_cost_above_1hr`, `prompt_cache_min_tokens`, long-context breakpoints, flex/priority/batch, `output_cost_per_reasoning_token`, EU uplift | MIT | with a non-community corroborator |
| `models.dev` | community | corroborator, 6,149 models, CI schema-validated. **No `cache_write_1h` field** | MIT | corroboration only |
| `llm-prices` (simonw) | curated | **effective-dating** — the only source that dated the 2026-07-30 OpenAI cut and the 2026-09-01 Sonnet-5 step | MIT/Apache-2.0 | yes, for dates |
| `genai-prices` (pydantic) | curated | `prices_checked` dates, source URLs, and `extractors` — an independent encoding of your own `adapters.js` usage parsing, diffed against it | MIT | corroboration |
| `xai-direct` | provider_direct | `GET https://api.x.ai/v1/language-models` — the **only** official machine-readable price feed that exists | provider | **not alone** (see below) |
| `anthropic/openai/google models` | provider_direct | **existence and capabilities only, never prices.** `capabilities.effort`, `created_at`, context limits | provider | no |
| `*-docs` | human_read | archived provider pricing page + sha256, attached to the PR | — | yes, and required for cache multipliers |
| ~~`openrouter`~~ | — | **quarantined.** ToS forbids crawlers scraping/copying Site information and forbids access to develop a competing service. Its top-level `pricing` also reads **2x low** on the gpt-5.6 family (its `openai` tag equals LiteLLM's *batch* rate) — an error in the savings-inflating direction | — | no |
| ~~`helicone`~~ | — | **excluded.** 1,129 models, **zero rows** for `claude-opus-5`, `claude-sonnet-5`, `gpt-5.6-sol`, `gpt-5.6-luna`; sample row is `claude-2` | — | no |

Anthropic `/v1/models` returns id, capabilities, created_at, display_name, max_input_tokens, max_tokens. OpenAI's own `openapi.yaml` defines `Model` as exactly `id/created/object/owned_by` (grep of 2.8 MB: 0 hits for `cost_per`, 0 for `per_million`). Google's `models.list` returns limits and sampling defaults. Every `.well-known/pricing.json` probe 404s. **"Crawl the pricing page" therefore means "parse marketing HTML"** — and the fields that actually decide whether an estimate is right are exactly the ones a page renders as footnotes.

**xAI unit conversion — get this right and pin a test.** xAI publishes **USD cents per 100,000,000 tokens**. Therefore `$/Mtok = cents / 10,000` (÷100 cents→dollars, ÷100 for 100M→1M). A divisor of **100,000** — which appears in at least one draft of this design — yields a **10x understatement** and passes every ratio-preserving invariant. Pin a round-trip test with a hand-computed expected value from a published Grok rate as a merge precondition. **And remove xAI's "authoritative alone" status**: LiteLLM and models.dev both carry xAI, so quorum is free, and a disagreement between your parse and theirs is precisely the signal a unit bug produces.

### 5.2 Quorum — measure independence, don't assume it

LiteLLM and models.dev are both community transcriptions of the same provider pages, by overlapping contributors, plausibly cross-referencing. **Exact agreement to the cent is weak evidence of independence and strong evidence of copying.** A vendor erratum or an ambiguous footnote propagates into both within 48h and quorum passes at 0.00% spread — the strongest possible merge signal.

Rules:

1. Every observation records `source_class ∈ {provider_direct, community, curated, human_read}`.
2. A **new model** requires ≥2 sources present.
3. A **rate change** requires ≥2 sources agreeing within 0.5% **and at least one non-`community` vote.** All-community votes → `NEEDS_CORROBORATION`, never a number.
4. **Anthropic cache dimensions and any `cacheWrite1h` change additionally require a `human_read` vote** — an archived provider page URL plus its sha256, attached to the PR. This is not optional friction: `cacheWrite1h` is the rate that dominates real Claude Code sessions, models.dev cannot vote on it at all, and the remaining sources are one aggregator plus two small hobby repos. It is your thinnest quorum on your most load-bearing number, and pretending otherwise means the rule gets waived under launch pressure.
5. **Derivation is a first-class confirmation class.** For Anthropic, LiteLLM's absolute value must equal `multiplier × quorum-verified in` within tolerance (read 0.1x, 5m 1.25x, 1h 2.0x) — that is a genuinely independent assertion because it comes from a different claim. Mark the cell `derived` in the artifact.
6. **Backtest independence and publish it.** Diff 90 days of change timestamps across LiteLLM, models.dev, and llm-prices. Near-zero lag means near-zero independence; a source pair with a ~0 disagreement rate across hundreds of facts collapses to one lineage.
7. **Publish a per-dimension coverage matrix** as a build artifact, so single-sourced dimensions are visible before an incident rather than during one.
8. A source that is *silent* about a dimension does not corroborate it and does not refresh its `verified_at`.

### 5.3 Structural invariants — hard rejects

```
0.005 ≤ usd_per_mtok ≤ 500                 # tighter than 0.001–1000; catches unit errors
out ≥ in                                    # every known family
cacheRead ≤ in ; cacheWrite ≥ in ; cacheWrite1h ≥ cacheWrite
anthropic: cacheRead/cacheWrite/cacheWrite1h == in × {0.1, 1.25, 2.0} ± 0.5%   # family-wide, so
                                            # a per-model deviation is a PARSE ERROR by definition
longContext tier rates ≥ base tier rates
rates[] intervals are non-overlapping, ascending, half-open, and never shrink or delete
    an interval present in ANY prior published catalog        # append-only IN THE ARTIFACT
model id matches ^[a-z0-9][a-z0-9._:-]{0,63}$
route ∈ routes{}
0 means ABSENT, never FREE
tier ordering: out(opus) ≥ out(sonnet) ≥ out(haiku) within each family
DELTA MAGNITUDE: |new / current_confirmed| > 3.0 → hard P0, never auto-confirmed
COMPLETENESS: a proposed model carries the same dimension SET as its previous confirmed
    version, or the difference is itself a reviewed change
PARTIAL RUNS: PR generation reads only facts where last_seen_run.outcome = 'ok'
```

The **delta-magnitude invariant** is the one that catches unit errors, generation mismatches, and the Opus-4-at-$75 substitution alike — every ratio-preserving check is blind to a uniform scale error by construction, and a 6-order-of-magnitude range check passes anything.

The **artifact-level append-only rule on `rates[]`** is what stops the restatement bug: LiteLLM, models.dev, and OpenRouter all report `claude-sonnet-5` as a flat 2/10 with no expiry, and a wholesale overwrite would delete your correctly-dated 2026-09-01 step and silently create a **1.5x understatement** on that date. A source with no expiry metadata may only corroborate the *currently effective* interval; it can never create, shorten, or delete one.

### 5.4 The review gate

**One durable PR branch, `catalog/pending`.** The daily job updates it; it does not open a new PR each day. Ten near-identical bot PRs during a 10-day holiday is how you train a human to rubber-stamp bot PRs, which is the precondition for the file-set attack. Escalate on **PR age** (re-ping 24h, page 72h) and surface *"a pending price change has been unreviewed for N days"* in the same places you render staleness — the product's own output is the only alarm that reliably gets read.

**The PR body is a rendered table, not a raw diff:**

| route | model | dim | old | new | Δ% | sources (class) | replay Δ$ | coverage |
|---|---|---|---|---|---|---|---|---|
| openai | gpt-5.6-luna | in | 1.00 | 0.20 | −80% | litellm(c), llm-prices(cu) | −$0.031/session | 4 goldens |
| anthropic | claude-fable-5 | out | 50 | 50 | 0% | — | — | **NO GOLDEN COVERAGE — impact unmeasured** |

**Two things your draft got backwards:**

1. **The `INFLATES_SAVINGS` label must be derived from the sign of the aggregate golden-corpus *savings* delta, not from the sign of the rate change.** Savings = ceiling cost − actual cost. A rate going *down* on the cheap tier *inflates* savings. And the 2.74x incident was a rate *increase* on the ceiling model — under a rate-sign heuristic it gets `favorable_to_us = 0` and the light-touch single-approval lane. Compute the label from the corpus, store `savings_delta_pct` next to `magnitude_pct`, put it first, and add a CI assertion that the label and the delta agree so nobody can hand-set it.
2. **A large change must still produce a PR.** Suppressing the diff into an "explicit alert" for >2x changes routes your largest, most consequential corrections into the most-ignored object in any engineering org — while the catalog keeps serving the old rate. The crawler already holds no merge credential, so suppression buys nothing. **Always open the PR; add required reviewers and a blocking `NEEDS-PROVIDER-PAGE-SNAPSHOT` label.**

**Replay coverage is a merge gate, not a report.** For every `(route, model, sku, dimension)` the PR touches, either a real frozen record exercises it, or CI synthesizes a canonical vector (1M in / 1M out, a long-context vector above each declared threshold, a 1h-cache-heavy vector) and prints its dollar delta. **CI fails on any touched key with no coverage row.** A reviewer must never see a blank cell that means "untested" rendered identically to one that means "no impact."

**Liveness detectors — alarm on absence, not only on findings.** Your draft's two signals both degrade to *silence*: a 401 on `/v1/models` and "no new models today" produce the same observable, and the telemetry `unlisted`-share signal has an opt-in denominator you cannot see. Three fixes: (1) *"every enabled source returned 200 in the last 48h"* is itself the health invariant, and its violation is a P1 page; (2) add a third detector needing **no** provider auth and **no** telemetry — diff the model-id list in LiteLLM/models.dev against the catalog daily; (3) two consecutive `partial` runs fail the workflow loudly.

### 5.5 Public auditability — you are the party with the incentive to inflate

Internal controls alone are a weaker position than the status quo, because they add the appearance of rigor without verifiability. Publish the inputs, all of which you already generate:

- `GET /v1/catalog/history.json` — hash-chained transparency log (sha256, git commit, PR, reviewers, Actions run URL).
- `GET /v1/replay/corpus.json` and `/v1/replay/expected.json` — the golden corpus and its expected dollar outputs, so anyone can run your estimator on fixed inputs and reproduce your numbers exactly.
- `GET /v1/stats/tokens.json` — the daily bucketed token aggregates, so a third party can recompute the savings counter from tokens plus the public catalog and get your number.
- Mirror the MIT-licensed raw source snapshots at their content hashes.
- Publish the invoice-reconciliation result as a signed statement with the delta, not merely a claim that you do it.

This is two to three days of work and it is simultaneously the highest-return marketing asset in the design, because verifiability is the differentiator you are claiming.

---

## 6. D1 schema

```sql
-- D1: cheaper-ledger
-- NEVER on the client price read path. D1 bills rows SCANNED, not returned, and read
-- replication covers 6 regions vs ~330 edge locations for static assets. The catalog is
-- 12,203 bytes and belongs in the Worker bundle / as a static asset, not in a database.
PRAGMA foreign_keys = ON;

-- ─────────────────────────── ingest evidence ───────────────────────────
CREATE TABLE source (
  id                  TEXT PRIMARY KEY,
  url                 TEXT NOT NULL,
  license             TEXT,
  source_class        TEXT NOT NULL CHECK (source_class IN
                        ('provider_direct','community','curated','human_read')),
  lineage             TEXT NOT NULL,        -- independence group; quorum needs 2 DISTINCT
  enabled             INTEGER NOT NULL DEFAULT 1,
  may_establish_rate  INTEGER NOT NULL DEFAULT 0
);
-- seed: openrouter enabled=0 (ToS). helicone not inserted (0 current-gen coverage).

CREATE TABLE ingest_run (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  actions_run   TEXT,                       -- public GitHub Actions run URL
  outcome       TEXT CHECK (outcome IN ('ok','partial','failed')),
  sources_ok    INTEGER NOT NULL DEFAULT 0,
  sources_tried INTEGER NOT NULL DEFAULT 0,
  deltas        INTEGER NOT NULL DEFAULT 0,
  pr_url        TEXT,
  reattested    INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);

CREATE TABLE snapshot (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES ingest_run(id),
  source_id   TEXT    NOT NULL REFERENCES source(id),
  fetched_at  TEXT    NOT NULL,
  http_status INTEGER,
  sha256      TEXT,
  r2_key      TEXT,                         -- raw/<source>/<date>/<sha256>.json.gz
  parse_ok    INTEGER NOT NULL DEFAULT 0,
  parse_error TEXT,
  models_seen INTEGER
);
CREATE INDEX snapshot_src_time ON snapshot(source_id, fetched_at DESC);
-- NEVER archive a non-2xx body; strip Authorization/Cookie before writing to R2.
-- A 401 body or a header-echoing redirect persists a provider API key into object storage.

CREATE TABLE observation (
  run_id          INTEGER NOT NULL REFERENCES ingest_run(id),
  source_id       TEXT    NOT NULL REFERENCES source(id),
  provider_route  TEXT    NOT NULL,
  model_id        TEXT    NOT NULL,
  sku             TEXT    NOT NULL DEFAULT 'standard',
  region          TEXT    NOT NULL DEFAULT 'global',
  dimension       TEXT    NOT NULL,   -- in|out|cache_read|cache_write_5m|cache_write_1h
                                      -- |lc_in|lc_out|reasoning|citation|search_per_query
  usd_per_mtok    REAL,               -- NULL = source asserts ABSENT. never 0-means-free.
  effective_from  TEXT,
  effective_until TEXT,
  raw_ptr         TEXT,               -- '<r2_key>#/json/pointer'
  invariant_ok    INTEGER NOT NULL DEFAULT 1,
  invariant_fail  TEXT,
  PRIMARY KEY (run_id, source_id, provider_route, model_id, sku, region, dimension)
);
CREATE INDEX obs_cell ON observation(provider_route, model_id, sku, region, dimension, run_id DESC);

CREATE TABLE cell_verdict (
  run_id         INTEGER NOT NULL REFERENCES ingest_run(id),
  provider_route TEXT NOT NULL, model_id TEXT NOT NULL,
  sku TEXT NOT NULL, region TEXT NOT NULL, dimension TEXT NOT NULL,
  verdict        TEXT NOT NULL CHECK (verdict IN
                   ('agree','disagree','single_source','needs_corroboration','absent')),
  agreed_value   REAL,
  n_sources      INTEGER NOT NULL,
  classes        TEXT NOT NULL,       -- JSON array of source_class values
  distinct_lineages INTEGER NOT NULL,
  spread_pct     REAL,
  detail         TEXT,                -- JSON {source_id: value}
  PRIMARY KEY (run_id, provider_route, model_id, sku, region, dimension)
);

-- ─────────────────────── confirmed, human-approved truth ───────────────────────
CREATE TABLE price_fact (                     -- APPEND-ONLY. never UPDATEd in place.
  fact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_route  TEXT NOT NULL, model_id TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT 'standard', region TEXT NOT NULL DEFAULT 'global',
  dimension       TEXT NOT NULL,
  usd_per_mtok    REAL NOT NULL,
  effective_from  TEXT NOT NULL,              -- ISO instant WITH provider billing offset
  effective_until TEXT,
  derived_from    TEXT,                       -- JSON {from:'in',factor:2.0,basis:'…'} or NULL
  quorum_n        INTEGER NOT NULL,
  source_ids      TEXT NOT NULL,              -- JSON array
  source_classes  TEXT NOT NULL,              -- JSON array
  approved_pr     TEXT NOT NULL,
  approved_at     TEXT NOT NULL,
  approvals       INTEGER NOT NULL DEFAULT 1,
  published_in    TEXT REFERENCES catalog_release(version),
  superseded_by   INTEGER REFERENCES price_fact(fact_id),
  UNIQUE (provider_route, model_id, sku, region, dimension, effective_from)
);
CREATE INDEX fact_lookup ON price_fact(model_id, provider_route, sku, region, dimension, effective_from DESC);

CREATE TABLE model_meta (
  provider_route TEXT NOT NULL, model_id TEXT NOT NULL,
  family         TEXT NOT NULL,
  tier           TEXT CHECK (tier IN ('haiku','sonnet','opus')),
  tier_source    TEXT CHECK (tier_source IN ('override','price_rank','inferred')),
  aliases        TEXT NOT NULL DEFAULT '[]', -- JSON. human-authored. NO PREFIX HEURISTIC.
  prefixes       TEXT NOT NULL DEFAULT '[]',
  route_price_uniform INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER,
  reasoning_efforts TEXT,                     -- JSON, from the PROVIDER's own /v1/models
  reasoning_billing TEXT NOT NULL DEFAULT 'output_rate',
  prompt_cache_min_tokens INTEGER,
  open_weight    INTEGER NOT NULL DEFAULT 0,
  unpriceable_reason TEXT,
  verified_at    TEXT,                        -- advances ONLY on affirmative source presence
  first_seen     TEXT,
  last_seen_provider_api TEXT,
  deprecated_at  TEXT,
  PRIMARY KEY (provider_route, model_id)
);

CREATE TABLE routing_target (
  provider TEXT NOT NULL, tier TEXT NOT NULL CHECK (tier IN ('haiku','sonnet','opus')),
  model_id TEXT NOT NULL, effective_from TEXT NOT NULL, review_id INTEGER,
  PRIMARY KEY (provider, tier, effective_from)
);

CREATE TABLE review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_run INTEGER REFERENCES ingest_run(id), opened_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('new_model','rate_change','retirement','source_disagreement','invariant_violation',
     'provider_model_missing_from_catalog','catalog_model_missing_from_provider',
     'routing_target_change','unit_conversion','no_replay_coverage')),
  provider_route TEXT, model_id TEXT, sku TEXT, dimension TEXT,
  old_value REAL, new_value REAL,
  magnitude_pct  REAL,
  savings_delta_pct REAL,                     -- FROM THE REPLAY CORPUS. drives the label.
  inflates_savings  INTEGER NOT NULL DEFAULT 0,   -- = (savings_delta_pct > threshold)
  requires_approvals INTEGER NOT NULL DEFAULT 1,
  requires_provider_snapshot INTEGER NOT NULL DEFAULT 0,
  evidence TEXT, replay_delta TEXT, replay_coverage TEXT,
  state TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN ('open','approved','rejected','superseded','merged')),
  priority TEXT NOT NULL DEFAULT 'P2',
  decided_by TEXT, decided_at TEXT, note TEXT
);
CREATE INDEX review_open ON review(state, priority, opened_at);

CREATE TABLE catalog_release (
  version         TEXT PRIMARY KEY,           -- '2026-08-06.3+9f2a1c4b7e10'
  version_seq     INTEGER NOT NULL UNIQUE,    -- CI asserts increment is EXACTLY 1
  as_of           TEXT NOT NULL,
  not_after       TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  prev_sha256     TEXT,                       -- hash chain
  bytes           INTEGER NOT NULL,
  signing_key_id  TEXT NOT NULL,
  signature       TEXT NOT NULL,
  git_commit      TEXT NOT NULL,
  pr_url          TEXT, reviewers TEXT, actions_run TEXT,
  reattestation   INTEGER NOT NULL DEFAULT 0,
  readback_verified_at TEXT NOT NULL,         -- fetched over the PUBLIC net and verified
  published_at    TEXT NOT NULL,
  revoked_at      TEXT, revoked_reason TEXT,
  r2_key          TEXT
);

-- ────────── telemetry: MARGINAL AGGREGATES ONLY. no per-event table, ever. ──────────
-- Staged first; folded only when the day reaches K distinct accepted reports (K=50),
-- otherwise the "aggregation" is a verbatim INSERT with the column names moved.
CREATE TABLE usage_stage (
  stage_id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL, body TEXT NOT NULL, received_day TEXT NOT NULL
);
CREATE INDEX usage_stage_day ON usage_stage(day);

CREATE TABLE usage_counter (            -- pure marginal: (day, dim, value) -> n
  day TEXT NOT NULL, dim TEXT NOT NULL, value TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, dim, value)
) WITHOUT ROWID;

CREATE TABLE usage_tokens (             -- the ONE joint dimension, sufficient to price
  day    TEXT NOT NULL,
  key    TEXT NOT NULL,   -- '<family>:<tier>|<kind>'  or  'avoided:<from>><to>|<kind>'
  bucket TEXT NOT NULL,   -- member of the 9-value log ladder
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key, bucket)
) WITHOUT ROWID;

CREATE TABLE usage_day (
  day TEXT PRIMARY KEY,
  reports_accepted INTEGER NOT NULL DEFAULT 0,
  reports_coerced  INTEGER NOT NULL DEFAULT 0,
  reports_rejected INTEGER NOT NULL DEFAULT 0,
  any_estimated    INTEGER NOT NULL DEFAULT 0,
  any_unpriceable  INTEGER NOT NULL DEFAULT 0,
  any_unknown_route INTEGER NOT NULL DEFAULT 0,
  folded_at        TEXT
);

CREATE TABLE reject_reason (            -- bounded enum ONLY. never a body fragment.
  day TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN
    ('unknown_os','bad_day','bad_cli','bad_bucket','oversize','bad_pow','schema','over_cap')),
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, reason)
) WITHOUT ROWID;

CREATE TABLE install_denominator (      -- independently observed. bounds the counter.
  day TEXT PRIMARY KEY,
  npm_downloads INTEGER NOT NULL DEFAULT 0,
  installer_fetches INTEGER NOT NULL DEFAULT 0,
  source_note TEXT
);

CREATE TABLE savings_day (              -- dollars are DERIVED. never received, never stored raw.
  day TEXT NOT NULL,
  catalog_version TEXT NOT NULL REFERENCES catalog_release(version),
  usd_low REAL NOT NULL, usd_point REAL NOT NULL, usd_high REAL NOT NULL,
  tokens_priced INTEGER NOT NULL, tokens_unpriceable INTEGER NOT NULL,
  install_days_counted INTEGER NOT NULL, install_days_capped INTEGER NOT NULL,
  method_version TEXT NOT NULL, epsilon REAL NOT NULL, clamp_usd REAL NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 0, frozen_reason TEXT,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (day, catalog_version)      -- a recompute writes a NEW row, never an UPDATE
);

CREATE TABLE restatement (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, reason TEXT NOT NULL,
  from_catalog TEXT NOT NULL, to_catalog TEXT NOT NULL, days_affected INTEGER NOT NULL,
  usd_before REAL NOT NULL, usd_after REAL NOT NULL, delta_pct REAL NOT NULL,
  approved_by TEXT                         -- REQUIRED when delta_pct > 0 (upward)
);

-- D1 caps BOUND PARAMETERS at 100 PER QUERY. A 100-row insert at 16 columns is 1,600
-- parameters and fails. All telemetry writes are db.batch() of ≤20 statements,
-- ≤6 bound params each, one statement per counter row.
```

---

## 7. Worker API endpoints

```
GET  /v1/catalog/latest.json          static · signed pointer          max-age=300, must-revalidate
GET  /v1/catalog/latest.json.sig      static
GET  /v1/catalog/alerts.json[.sig]    static · revoked[] + disputed[]  max-age=300, must-revalidate
GET  /v1/catalog/v/<as_of>-<sha12>.json[.sig]   static · immutable      max-age=31536000, immutable
GET  /v1/catalog/history.json[.sig]   static · hash-chained log         max-age=3600
GET  /.well-known/cheaper-catalog-keys.json     static                  max-age=3600
GET  /v1/replay/corpus.json, /v1/replay/expected.json   static · public auditability
GET  /v1/stats/savings.json           static · cron-written, DAILY      max-age=3600
GET  /v1/stats/tokens.json            static · daily bucketed aggregates

GET  /v1/providers/{route}/models/{id}?at=&sku=   worker  max-age=3600, ETag: W/"<version>"
GET  /v1/models/{id}                  worker · ALL routes as an array, never blended
GET  /v1/tools , /v1/tools/{tool}     worker  max-age=3600
GET  /v1/routing/targets              worker
GET  /v1/reasoning/{provider}         worker
POST /v1/usage/1/{day}/{pow}          worker · 204 · no-store · path-encoded (see §8.6)
GET  /v1/health                       worker · no-store
```

```json
GET /v1/providers/anthropic/models/claude-sonnet-5?at=2026-09-15
{
  "route":"anthropic","id":"claude-sonnet-5",
  "requested_at":"2026-09-15","resolved_at_utc_day":"2026-09-15",
  "catalog_version":"2026-08-06.3+9f2a1c4b7e10","as_of":"2026-08-06",
  "verified_at":"2026-08-06","unit":"usd_per_mtok",
  "price":{"in":3,"out":15,"cacheRead":0.3,"cacheWrite":3.75,"cacheWrite1h":6},
  "effective_from":"2026-09-01T00:00:00-07:00","effective_until":null,
  "boundary":false,
  "tier":"sonnet","tier_source":"price_rank",
  "reasoning":{"billing":"output_rate","efforts":["low","medium","high","xhigh","max"]},
  "provenance":{"in":{"quorum":2,"classes":["curated","human_read"],
                      "sources":["llm-prices@2026-08-05","anthropic-docs#sha256:7d31c0…"]}},
  "warnings":[]
}
```

```json
404 — never a guess
{ "error":"unpriceable", "reason":"no_published_list_price_for_model_on_route",
  "route":"together","id":"llama-3.3-70b",
  "detail":"open-weight model; observed host spread 58.4x",
  "catalog_version":"2026-08-06.3+9f2a1c4b7e10" }
```

**Canonicalize before caching.** `at` defaults to request time; if you key the Cache API on raw `url.search`, `?at=2026-08-06T12:00:0{0..9}Z` is an unbounded keyspace and every distinct value is a billable Worker invocation plus a cache write, while evicting warm entries. Parse `at`, **truncate to a UTC day** (prices have day-granularity effective dates at finest), allowlist and sort query params, clamp `at` to `[earliest effective_from, today+365d]`, and key on the canonical tuple `(catalog_version, route, id, at_day, sku)`. Echo the canonical value so callers see the quantization. Honestly: the catalog is 12 KB in the bundle and resolution is a map lookup — consider not memoizing at all.

```json
GET /v1/tools
{ "catalog_version":"2026-08-06.3+9f2a1c4b7e10",
  "counts": { "routable": 36, "readable": 8, "tagline_wired": 7 },
  "definitions": {
    "routable":"Can send OpenAI/Anthropic-protocol traffic through the Cheaper gateway by setting a base URL. Effectively unbounded; 36 are documented and verified.",
    "readable":"Has a peek adapter that reads the tool's own transcripts and reports real token counts.",
    "tagline_wired":"Has end-of-chat savings-tagline wiring installed by `cheaper install`." },
  "tools":[
    {"key":"claude-code","label":"Claude Code","routable":true,"readable":"supported","tagline_wired":true},
    {"key":"cursor","label":"Cursor","routable":true,"readable":"sqlite","tagline_wired":true},
    {"key":"librechat","label":"LibreChat","routable":true,"readable":"none","tagline_wired":false}
  ] }
```

Every published tool count on the site derives from this one generated JSON, under `sync-prices --check`. See §12.

---

## 8. Telemetry

**My recommendation: ship the pricing plane first and defer telemetry to Phase 4.** It is greenfield (nothing in your codebase collects, transmits, or consents to anything today), it is release-blocked by a privacy page that does not exist, a DPIA, a legal entity determination, and copy corrections across four repos — and it contributes *nothing* to the problem you actually asked about. If you ship it, here is the exact specification.

### 8.1 Approved payload — counts and enums only, no continuous values, no identifier

```json
POST /v1/usage/1/2026-08-05/000a3f1c9b2e4d67
{
  "v": 1,
  "notice": "1.0",
  "day": "2026-08-05",
  "os": "macos",
  "cli_channel": "stable",
  "catalog_age": "current",
  "by_harness":  { "claude-code": "11-25", "codex": "1-2" },
  "tier_tokens": {
    "anthropic:opus|in_fresh":"16-64k",   "anthropic:opus|out":"4-16k",
    "anthropic:opus|cache_read":"64k-256k","anthropic:opus|cache_write_1h":"16-64k",
    "anthropic:sonnet|in_fresh":"64k-256k","anthropic:sonnet|out":"16-64k",
    "other|in_fresh":"4-16k",             "other|out":"1-4k"
  },
  "avoided": {
    "avoided:opus>sonnet|in":"64k-256k",  "avoided:opus>sonnet|out":"16-64k",
    "avoided:sonnet>haiku|in":"16-64k",   "avoided:sonnet>haiku|out":"4-16k"
  },
  "reasoning": { "none":"26-100","low":"1-2","medium":"6-10","high":"1-2" },
  "chat_len":  { "short":"11-25","medium":"11-25","long":"3-5" },
  "any_estimated": true,
  "any_unpriceable": false,
  "any_unknown_route": false
}
```

**Ladders (both fixed, both closed enums):**

```
counts:  0 | 1-2 | 3-5 | 6-10 | 11-25 | 26-100 | 100+
tokens:  <1k | 1-4k | 4-16k | 16-64k | 64k-256k | 256k-1M | 1-4M | 4-16M | >16M
```

**Coarsening rules:**

| Field | Rule |
|---|---|
| `day` | UTC day only. No finer resolution, ever. Server clamps to ±1 day and never stamps its own clock. |
| `os` | family: `macos \| windows \| linux \| other`. Never version, arch, or distro string. |
| `cli_channel` | `stable \| prerelease \| old`. Never full semver, never build sha. |
| `catalog_age` | `current \| 1-45d \| >45d`. **Never the sha, never the date.** |
| `by_harness` | count map over the 8 registered adapter keys + `other`, each value a count bucket. **A map, not a scalar** — a developer using claude-code, codex and cursor the same day must produce ONE report, not three from one IP within milliseconds. |
| `tier_tokens` | `<family>:<tier>\|<kind>` → token bucket. Capped at the top **2** (family,tier) pairs plus `other`. Model-level ids are **not transmitted** — the server prices from the tier's `routing_targets` representative and publishes the approximation as part of the method. |
| `avoided` | tier-pair keys only, never model-pair keys. |
| `reasoning` | 4-value enum from `metrics.py:53`, counts bucketed. |
| `chat_len` | 3 buckets derived purely from **turn count**. No classifier, no keyword branch. |
| `any_*` | booleans, not counts. |
| every count | bucketed. **Discreteness is not low cardinality** — a 20-coordinate integer vector is as unique as a float. |

**Measure the joint, don't assert it.** Ship a CI script that computes the joint domain size of the payload schema, fails above a stated budget, and — before the privacy page goes live — runs the real schema over the team's actual local `peek` data and prints the **observed** k. If you cannot state the bits, you cannot use the word "anonymous."

### 8.2 Rejected outright, with reasons

| Field | Verdict |
|---|---|
| **money used / money saved** | Rejected as transmitted values. IEEE754 floats are near-unique per row (`--json` emits full precision, not the rounded display value), they hand a poisoned client an unbounded lever on the public counter, and transmitting them forecloses restatement. Server recomputes. **Three wins from one decision.** |
| **memory consumed** | Rejected. Continuous, near-unique per event, a device-class fingerprint, and no named product decision depends on it. |
| **time (sub-day)** | Rejected. 16-27 bits, leaks timezone, and is the join key that makes GitHub-commit-timestamp linkage work. |
| **programming languages (list)** | Rejected. Highest-entropy field in the proposal; Panopticlick-class object. If a stated decision ever needs it: at most ONE top language from a fixed ~20 allowlist, everything else `other`, and never by walking the filesystem. |
| **free-text `tool`** | Rejected. `metrics.py:25-27` only truncates to 48 chars; as a wire field it will carry project, agent, and customer names. Replaced by the harness enum. |
| **raw model ids** | Rejected. Fine-tune ids embed org names (`ft:gpt-…:acme-corp:…`). Tier-level only. |
| **classifier `reason` / prompt snippets** | Rejected, hard. `scan.js:65-68` + `classify.js:43` would ship Art. 9 health inferences. |
| **`complexity` from the escalation classifier** | Rejected. Its regexes include `\bmedical\b`, `\bdiagnos`, `\btax\b`, `\bfinanc`, so even the bare tier is a noisy Art. 9 proxy at `sessions:1`. Replaced by turn-count-derived `chat_len`. |
| **`catalog_sha12`** | Rejected. Pinning + immutable content addressing + staggered adoption make it a **stable, long-tailed, semantically meaningful pseudonym** — stronger than a UUID. Replaced by `catalog_age`. |
| **any install id** — hashed machine id, MAC, hostname, salted derivative | Rejected. Hashing preserves cardinality (`H(hostname)` is exactly as identifying as `hostname`); a salt in a shipped binary is public; a server-held salt is textbook Art. 4(5) pseudonymisation *with a key you control*, i.e. full GDPR. Local daily pre-aggregation makes dedupe a purely local question. |
| **IP** | Never read, never logged, never stored. The Worker does not touch `CF-Connecting-IP`, `X-Forwarded-For`, `request.cf.*`, or `User-Agent`. |

### 8.3 Consent copy

**Installer — an UNTICKED standalone checkbox, never bundled with licence/ToS:**

> **Help improve Cheaper (optional)**
> Share aggregate, non-identifying usage statistics: which AI tool and model tier you used, roughly how many tokens (as ranges), and Cheaper's estimated savings. Sent once a day, as ranges rather than exact numbers. **Never your prompts, code, file names, project names, or IP address.**
> ☐ Yes, send aggregate usage statistics.
> Change any time with `cheaper telemetry off`. · [What exactly is sent](https://cheaper.app/privacy#payload)

**CLI — prompt only when `stdin` AND `stdout` are TTYs and no CI env is detected:**

```
Cheaper can send aggregate, non-identifying usage statistics once a day:
which tool and model tier you used, token counts as ranges, and Cheaper's
estimated savings. Never your prompts, code, file names, or IP address.
Full details: https://cheaper.app/privacy

Send aggregate usage statistics? [y/N] (30s, defaults to no)
```

Note the wording: **"aggregate, non-identifying," not "anonymous."** Use "anonymous" only after you have published the measured k. The word is a claim; an unsubstantiated claim about privacy on a product whose differentiator is not overstating things is the same failure class as the savings number.

### 8.4 Default state and withdrawal

- **Default OFF everywhere, including on upgrade of existing installs.** Never auto-enable.
- `[y/N]`; only typed `y`/`yes` counts; 30s timeout → **no**. `[Y/n]`, Enter-to-accept, and timeout-falls-through-to-on are all invalid affirmative action (*Planet49*, C-673/17).
- **No TTY** (`curl|sh`, Homebrew, npx, Docker, scripted install) → never prompted, **never enabled**.
- `CHEAPER_TELEMETRY=0` and `DO_NOT_TRACK=1` honoured unconditionally. `CHEAPER_TELEMETRY=1` is required as an explicit second signal in any non-interactive context.
- **Re-evaluate the environment at SEND time, not only at prompt time.** A consent file baked into a Docker image, an AMI, a devcontainer, or a dotfiles repo otherwise enables collection for every container forever, with no prompt anywhere. Refuse to send if CI/container is detected, or if the recorded uid does not match the current one, or if the file predates the current boot in a container. Do not re-prompt — just stay off, and have `cheaper telemetry status` say **why**.
- **The gateway must not contribute** unless it is loopback-bound and was started by a process that proved interactive consent on that invocation. Otherwise one admin's checkbox uploads twelve colleagues' model mix and spend shape.
- Refusal is **sticky and terminal**. Consent state is an **append-only JSONL** of `{decision, at, notice_version, uid}` — not a mutable boolean — so `cheaper telemetry status` can print the full history and the user can see any change they did not make. A `notice_version` bump may re-ask only users who previously **granted**, once per version. Never prompt from `cheaper install` re-runs.
- `cheaper telemetry preview` prints the **literal payload from real local data** — the cheapest possible trust device, and it forces your own team to look at what is being sent. `cheaper telemetry off` stops sending, deletes the queue, prints a timestamped confirmation, exits 0 if already off.
- **Banned dark patterns:** pre-ticked boxes, bundling with ToS, asymmetric button weight, guilt framing (*"help us keep Cheaper free"* implies detriment for refusal — Art. 7(4)), degrading **any** feature including the tagline when declined, and burying withdrawal behind a web account.

### 8.5 Transport and local queue

- **Append-only JSONL**, one `O_APPEND` line per contributor: `~/.cheaper/telemetry/<utc-day>.jsonl`. Node (`peek`, several concurrently per Claude Code turn) and Python (gateway) both write it; an unlocked read-modify-write silently loses sessions and a truncated flush leaves invalid JSON that the next reader discards — silently, because everything in this subsystem fails silent by design. Sum on flush; drop a partial trailing line; report `queue_lines_dropped` so silent loss is measurable.
- **Send at a deterministic time derived from a locally generated, never-transmitted random offset**, uniform across the 24h after the day boundary. Arrival time otherwise reconstructs the first-work-moment-of-day — better resolution than the field you deleted for being too identifying.
- **Pad the JSON body to a fixed 2 KiB.** Unpadded length varies with key count and leaks how many model tiers you used, over TLS, to a passive observer.
- **One queued day per flush**, minimum hours apart. A 5-day backlog draining in one burst from one IP is a trajectory — you already rejected 30-day backfill for exactly this reason. Entries older than 7 days are dropped unsent; delete each file immediately on 204.
- Detached, `unref()`ed, 2s timeout, silent failure. Never from the Stop hook, never from the tagline, never from the gateway request path.

### 8.6 Server side

- **Path-encoded proof-of-work**: `POST /v1/usage/1/{day}/{pow}`. Putting it in the path lets a WAF rule reject malformed submissions **before** a Worker invocation is billed. An unauthenticated, unbounded, per-invocation-billed write endpoint is a metered credit-card drain with no spend cap: 50k req/s ≈ $1,296/day in Worker requests alone.
- **Never reject a whole report for an unrecognized enum.** Coerce that one dimension to `other` and increment `reports_coerced`. Reject-whole + silent 204 + client-deletes-queue composes into invisible, perfectly correlated, unrecoverable data loss the moment you ship a 9th adapter or bump `cli_channel` before deploying the allowlist — and the counter then shows a decline that looks exactly like churn. Keep reject-and-drop only for structural violations (bad bucket string, oversize, malformed PoW). Version the allowlist by `v` and deploy the Worker strictly before the CLI that emits new values. **POST one synthetic canary report per day from CI and alert if it does not land.**
- **K-gate.** Stage reports; fold into `usage_counter` / `usage_tokens` only once a day reaches **≥50** accepted reports (widen to ISO week during ramp); discard staging on fold. At N=1 an UPSERT is a verbatim INSERT with the column names moved into the value position — launch week reconstructs a single user's entire payload byte-for-byte, and the k≥50 rule in your draft applies only to *published* breakdowns, never to the stored table.
- **No body logging on the error path, ever.** Increment a bounded `reject_reason` enum only. Add a CI lint rule forbidding any logging call inside the usage handler that takes a request-derived argument — rejected payloads are, by selection, the anomalous ones, and they carry org-identifying strings.
- Named-column `INSERT`s, never a spread of the request body. `head_sampling_rate: 0` on `/v1/usage`; Logpush exclusion asserted in infrastructure-as-code with a CI check, not as a runbook note.

### 8.7 The public savings counter — bounding and disclosure

**Bound it by something an attacker cannot forge.** Every per-report control (clamp, winsorisation, PoW, rate limit) bounds *magnitude*; none bounds *volume*, and only volume is needed once magnitude is capped. Your draft's rate-limit binding is keyed on the PoW stamp, which is unique per submission by construction — the limiter never fires. And 20-bit hashcash is ~20-50ms in optimized C, so one cheap VPS mints ~1M forged install-days/day against a real population of ~18,000.

**The fix is a denominator you observe independently:**

```
counted_install_days(day) = min( reports_accepted(day),
                                 1.5 × (npm_downloads(day) + installer_fetches(day)) )
```

Publish the denominator and the cap. The counter can then be **suppressed** by an attacker but never **inflated** — the safe direction, consistent with everything else here. Keep PoW bound to a rotating daily seed served as a free static asset (so it cannot be precomputed) as a spam speed bump, and stop describing it as an integrity control.

**Layer on:** per-install-day clamp of $50 (also the DP sensitivity bound); winsorised sum at p99; local Laplace noise at scale clamp/ε with ε and clamp published; **daily** publication from a snapshot (never live, never 10-minute — a monotonically increasing counter polled before and after one user's send is a per-user readout); 3 significant figures; installs published bucketed; freeze on a **trend** test against a 28-day baseline, not a step test, serving last-known-good with `"frozen": true`.

```json
GET /v1/stats/savings.json
{
  "schema": 1, "as_of_day": "2026-08-05", "published_at": "2026-08-06T01:00:00Z",
  "metric": "estimated_value_of_avoided_tokens_list_price_basis",
  "display_label": "Estimated value of avoided tokens (list-price basis)",
  "value_usd": { "point": 418000, "low": 214000, "high": 796000, "sig_figs": 3 },
  "coverage": { "tokens_priced_pct": 61, "note": "Percentage of measured tokens with a
                published list price on an identified provider route." },
  "install_days": { "counted": "17000-18000", "cap_applied": false,
                    "denominator_source": "npm daily downloads + installer fetches" },
  "method": {
    "version": "1.2",
    "catalog_version": "2026-08-06.3+9f2a1c4b7e10", "catalog_as_of": "2026-08-06",
    "point_estimate": "log-uniform midpoint within each token bucket",
    "bounds": "sum of bucket lower bounds / sum of bucket upper bounds",
    "aggregate": "winsorised sum at p99",
    "clamp_usd_per_install_day": 50,
    "dp": { "mechanism": "laplace", "epsilon_per_30d_epoch": 1.0, "applied": "locally" },
    "tier_approximation": "Priced at each tier's representative model from routing_targets.",
    "excluded": ["sessions with estimated token counts",
                 "models with no published list price",
                 "calls whose provider route could not be identified",
                 "install-days above the 4-16M token bucket",
                 "pinned and unsigned-catalog installs"],
    "suppression": "breakdown cells with fewer than 50 contributing install-days render '<50'"
  },
  "disclaimer": "Estimated, not billed. Computed at published list API rates from self-reported, opted-in installs. Many users are on flat-rate subscription plans where actual cash savings differ, and may be zero.",
  "restatements": [
    { "at":"2026-07-31","reason":"catalog correction: claude-opus-* priced at retired Opus 4 rates",
      "delta_pct":-63.5,"approved_by":null } ],
  "frozen": false
}
```

**Disclosure requirements, release-blocking:**

- **Rename the metric.** Not "saved." *"Estimated value of avoided tokens (list-price basis)."* Your own code says it: `peek` is prospective — *"what you WOULD save if you adopt Cheaper"* — from logs of runs that did **not** route, and `tagline.js:224-229` notes most sessions run against a flat-rate subscription where **no such sum is ever charged**. For a Max subscriber the real cash saving may be exactly $0. If legal review gets only one change, make it the label.
- **Publish a range, not a point**, with the method adjacent at **equal visual weight** — not a footnote, not a hover. And do not market the bucketing as free precision: the ladder is 4x-wide, so the honest bound is ~4x, and the top bucket must be closed (that is why the ladder now extends to `4-16M` and everything above is excluded with a count — a Claude Code user with 1h caching clears 1M tokens/day on cache reads alone, so an unbounded top bucket contains exactly the users who dominate the sum).
- **Publish `tokens_priced` vs `tokens_unpriceable`** side by side and compute the headline over priced tokens only. After route-aware pricing, unpriceable will be the larger exclusion category, and a reader will naturally read `usd / tokens_total` as an effective rate.
- **Exclude any install-day with `any_estimated: true`.** Codex tokens are inferred from text length (`adapters.js:244-252`) and the generic fallback is `ceil(chars/4)` (`adapters.js:84`). A `~` on a per-session tagline is honest; aggregation silently erases it, and a chars/4 inference must never become a public dollar.
- **Restatement prices day D at `at = D`.** Never at the current catalog's `as_of` — that would reprice eight months of Sonnet-5 traffic from $2/$10 to $3/$15 on 2026-11-01 and inflate the published figure 50% automatically and unreviewed, which is precisely the failure this design exists to prevent. A recompute writes a **new** `savings_day` row. **Any restatement that moves the figure upward requires human approval**, matching the review asymmetry.
- **Reconcile against real provider invoices** for a handful of consenting accounts pre-launch and quarterly, and publish the delta as a signed statement. No disclosure language substitutes for substantiation.
- **`https://cheaper.app/privacy` must exist and be linked from the prompt before the release that ships the prompt.** There is no privacy page today. It must carry: controller entity and contact; the exact field list in the same words the prompt uses; separated purposes (product analytics vs the public counter — arguably two consents); legal basis (consent + ePrivacy Art. 5(3)); subprocessors (Cloudflare Workers/D1, region); retention (per-event: none; aggregates: indefinite, non-personal); transfers; an honest **Art. 11** statement — including the Art. 11(2) caveat that a subject who supplies identifying information (which `cheaper telemetry preview` hands them) revives the rights; the **CCPA §1798.140(m)** public no-reidentification commitment; the literal JSON of a real payload; a note that the catalog-freshness check runs daily **even when telemetry is off**; and a dated changelog.
- **Sequence the compliance claims behind the facts.** Do not publish the §1798.140(m) commitment or the "anonymous" wording until the K-gate ships and the joint entropy is measured with a written risk assessment. A deidentification claim that was untrue when published is an FTC §5 exposure on the same domain as the savings claim.
- **Correct the copy that telemetry falsifies, in the same release:** `README.md:35`, `cli/src/peek/index.js:3-5` ("WITHOUT sending anything anywhere"), `tagline.js:17-18` ("Fully local + read-only"), and `claude-code-savings-tracker.html:188` ("Nothing leaves your machine"). Keep `peek` strictly local and name telemetry a separate subsystem so each sentence stays literally true where it is written — but scope the site claim to *"peek transmits no data about you"*, because a background catalog check spawned from a `cheaper` invocation is still a network call.

---

## 9. Phased plan

### Phase 0 — this week, no new infrastructure, ~3 engineer-days. **This is where the safety is.**

Every item is a local edit to repos you already own. No Cloudflare, no consent, no legal, no npm publish gate on the fixes themselves.

1. **Kill prefix inheritance.** Exact-id + human-authored `aliases[]`/`prefixes[]`. Unknown → unpriceable. Ship the negative fixture (`claude-opus-4-9`, `gpt-5.6-luna-272k`, `o3-deep-research`, `claude-sonnet-5-2`, and `<each catalog id>-9`) asserting all resolve unpriceable. **This alone closes the mechanism behind both incidents.**
2. **Render `as_of` and per-entry `oldest_verified_at`** in `peek`, `peek --json`, `--tagline --json`, `/healthz`, `/metrics`, the dashboard, and the desktop header. Today they appear in zero user-facing places.
3. **Fix the promo-window date bug.** Three-valued `at`, required, never throwing; `no_timestamp` → unpriceable; Stop-hook wrapper always exits 0. Sonnet-5's window ends **2026-08-31 — 25 days from today** — and after that every surface would keep quoting $2/$10 instead of $3/$15 forever. Measured: $12 vs $18 on 1M/1M.
4. **Generate the classifiers, `tier`, and `routing_targets`** via `sync-prices.js --check`; fix the live JS↔Python drift (`magistral`/`devstral` return `mistral` in JS and `None` in `pricing.py:225`, so the gateway reports **$0 saved** for them; `fable|mythos` likewise missing from the Python anthropic branch). Add golden fixtures run byte-identically in both runtimes.
5. **`models.js` → thin loader over `models.json`.** Removes the codegen-injection class permanently.
6. **Delete the marketing tracker's private price table.** Inline the generated JSON at build time; put it under `--check`. Right now the CLI and gateway are correct while your most-visited page ships Claude Opus 4 at $75 and prices Cursor as Anthropic-only.
7. **Add the CI gates that will fail today** — delta-magnitude >3x, tier price-rank ordering, id charset, `out ≥ in`, Anthropic cache multipliers, artifact-level `rates[]` append-only. The fable/mythos failure is the assertion working (see §11).
8. **Correct the four false copy strings and the `OPENAI_MODEL_*` docs/env mismatch.**
9. **Move `METRICS.record`'s blocking SQLite INSERT off the async handler.**

### Phase 1 — 1-2 weeks: correct semantics
Price as `rates[]` time-series with tz-explicit half-open intervals; backfill `effective_from` from llm-prices `price_history` and genai-prices `prices_checked`; route/region in the primary key with fail-closed unknown-route; boundary hedging; the golden replay corpus (~50 real anonymized sessions) with the coverage gate; peek publishes **two** figures (retrospective at each record's `ts`, prospective at now) with the marketing claim explicitly labelled.

### Phase 2 — 1-2 weeks: the signed artifact and the refresh host
`build-catalog.js` with JCS canonicalization; Ed25519 signing in a protected GitHub Environment; `cheaperapi` Worker + `api.cheaper.app` custom domain + `_headers`; signed pointer, signed alerts, hash-chained history, key set with `next`; the detached jittered refresh host with lockfile and hard timeouts; client adoption gates including `min_version_seq` and the 1.5x blast radius; `not_after`; pin semantics; `catalog_trust` stamping; post-deploy read-back verification and the external canary. The read-only endpoints (`/v1/providers`, `/v1/tools`, `/v1/routing`) fall out nearly free.

### Phase 3 — 1-2 weeks: ingest and the review gate
GitHub Actions daily job; the 8 sources with classes; quorum with lineage and the derivation class; invariants; the single `catalog/pending` PR branch with the rendered table and replay delta; the restricted ruleset and changed-file CI check; the sha contract between generation and signing; daily re-attestation with the byte-identical assertion; the three liveness detectors; the independence backtest; public auditability artifacts.

### Phase 4 — only if you decide the counter is worth it
Telemetry, consent, privacy page, DPIA, ROPA, DPA, K-gate, entropy measurement, denominator wiring, counter publication. Gated on §11 decisions.

---

## 10. What NOT to build

| Don't build | Why |
|---|---|
| **KV for the catalog** | Documented propagation of *"up to 60 seconds or more,"* `cacheTtl` min 30s, and `get()` that *"may return stale values."* After a price correction you would knowingly serve the retired rate globally with no hash the client could compare. Also bills every read including 404s. Wrong on correctness first, cost second. |
| **D1 on the client read path** | Bills rows **scanned**, not returned — a 5,000-row scan bills 5,000 reads regardless of output. Read replication covers 6 regions vs ~330 edge locations. Structurally an order of magnitude worse for a 12 KB globally-read blob, before cost. |
| **R2 on the hot read path** | Class B at $0.36/M with no edge caching of its own. Correct for raw archives; wrong tier for a 12 KB hot read. |
| **Cache API in front of the catalog** | Per-datacenter with no replication (~330 cold misses), and `cache.put` is explicitly incompatible with tiered caching. Static assets already get tiered caching. |
| **WebSockets / Durable Objects for prices** | §3.2. Every message a billed DO request to deliver ~one message a week; a stable IP-bound session identifier; encourages apply-on-arrival. |
| **A Durable Object savings counter** | Single-region write bottleneck, and the counter is published daily precisely so differencing cannot leak one contribution. A D1 row and a cron-written static asset suffice. |
| **Analytics Engine** | It silently reconstitutes a **timestamped per-event store** with 3-month retention and no row deletion — contradicting the "we retain no individual events" sentence your own privacy policy must carry, and re-creating the sub-day timestamp you deleted from the payload. It also downsamples by index and exposes `_sample_interval`, so a naive `SUM` is wrong. It silently **drops** any data point with more than one index. And its SQL API needs an account-scoped `Account Analytics: Read` token that your zone-bound cheaper.app token does not cover. Everything it would answer is answerable from `usage_counter`. |
| **Cloudflare Workflows for ingest** | GitHub Actions is strictly better here: scoped short-lived token, no 15-min CPU ceiling, real retry semantics, no 1 MiB step-output handoff, no PAT-in-Worker escalation, no provider keys in an internet-facing isolate, and a public run log. |
| **Auto-merging crawler PRs above a confidence threshold** | Any such threshold is a promise that quorum plus invariants can substitute for a human — the claim two incidents falsified. |
| **`/tools/<tool>/` returning prices** | §3.1. |
| **HTML crawling as the primary source** | §5.1. Retained as class-C corroboration that can contradict but never establish. |
| **OpenRouter as an ingest source** | ToS prohibit crawlers scraping/copying Site information and prohibit access to develop a competing service. Its top-level `pricing` also reads 2x low on the gpt-5.6 family — in the savings-inflating direction. Its metadata is genuinely the best available, so it is worth a written permission request; not worth silently building on. |
| **Helicone** | Zero current-generation coverage. Including it in a quorum lets two stale sources outvote one fresh one. |
| **A single canonical price per model id** | 10x route spread on identical closed model ids; 58-167x on open weights. |
| **Any install identifier** | §8.2. |
| **Dollars on the telemetry wire** | §8.2. |
| **A live public savings ticker** | Textbook DP continual-observation leak. |
| **Server-side telemetry dedupe** | Requires the identifier the design deliberately lacks. Handled by client-side once-per-day state plus the denominator cap. |
| **PoW as a rate quota, or a rate-limit binding keyed on the PoW stamp** | The stamp is unique per submission by construction, so the limiter never fires. And PoW cannot enforce a per-*identity* quota when there is no identity. If you ever genuinely need one, Privacy Pass / VOPRF blind tokens are the only construction that delivers it unlinkably. |
| **Merging the API into `cheaperapp`** | Assets-only, no `main`, marketing deploy cadence; a crawler or API bug must not be in cheaper.app's blast radius, and a static-site build must not be able to delete your catalog. |
| **Signing in a Worker** | Even though Workers Web Crypto supports Ed25519 with no compatibility flag, the property worth buying is that **no edge compromise can produce a client-trusted catalog**. |

---

## 11. The "36 tools" claim — a truth-in-marketing issue on the same theme

Your site currently publishes **three mutually inconsistent counts** for the same thing:

| Surface | Claim |
|---|---|
| `docs.html:3`, `docs.html:65` | *"any of 36+ AI tools"*, `placeholder="Filter 36 tools…"` |
| `docs.html:153-192` (`var TOOLS`) | a literal 36-row roster: 31 openai-compatible, 4 anthropic, 1 adapter |
| `supported-tools.html:34-50` | 20 tiles |
| `index.html:220`, `index.html:242-259` | *"Supported tools — 18 and counting"*, 18 ticker tiles |
| `cheaper-app/README.md` | *"18 and counting"* |
| `cli/src/peek/adapters.js:332-344` | **8** adapters — 1 `supported`, 6 `experimental`, 1 (`cursor`) `sqlite` that reads nothing |
| `tagline_install.js:26-34` | **7** tagline-wired targets |

The 36 is *substantiated* as a roster — it is a real list of tools you can point a base URL at (LangChain, LiteLLM, SillyTavern, the OpenAI SDK). But 22 of the 36 have no adapter, so Cheaper cannot read or price them. (Incidentally, `index.html:264-267` clones the 18 ticker tiles once for the marquee loop, yielding exactly 36 DOM nodes — a plausible origin for a mis-recalled 36.)

This is the same class of claim as the savings counter, on the same domain, and **substantiation credibility is one reputational surface, not one per claim.** A rigorous methodology page defending a savings number, sitting next to an indefensible tool count, buys nothing.

**Fix:** define three counts, publish them from `/v1/tools` (§7), and derive **every** number on the site — `index.html`, `supported-tools.html`, `docs.html`, `README.md` — from the same generated JSON under `sync-prices --check`, so they can never disagree again:

- **routable: 36** — can point a base URL at the gateway. Genuinely unbounded; 36 documented and verified.
- **readable: 8** — has a peek adapter that reads the tool's own transcripts.
- **tagline-wired: 7** — has end-of-chat wiring.

Ship this in the same release as the pricing-honesty work. It is a half-day of edits.

---

## 12. Decisions and authorizations only you can make

**Blocking Phase 0:**

1. **`claude-fable-5` / `claude-mythos-5`.** The tier price-rank assertion fails on day one: both are priced $10/$50 — **double Opus 5's $5/$25** — and both classify as `sonnet`. Someone has to decide what they actually are before Phase 0 lands. If they are above-Opus SKUs, the tier vocabulary needs a fourth value or an explicit override.
2. **Accept that reported savings will drop.** Killing prefix inheritance, adding route-awareness, and enforcing per-entry staleness all reduce coverage. Numbers go down. This needs release notes you write, not an engineer.
3. **Approve the copy corrections** — `README.md:35`, `peek/index.js:3-5`, `tagline.js:17-18`, `claude-code-savings-tracker.html:188`, `scan.js:139`, `cheaper-desktop/renderer/index.html:129` — and pick a definition for the tool counts.
4. **Settle `OPENAI_MODEL_CHEAP/MID/FRONTIER` vs `OPENAI_MODEL_TOP`** before any generated config writes those names.

**Blocking Phase 2/3:**

5. **How many humans have merge rights?** The design requires two approvers for savings-inflating changes. **If you are a solo founder, two approvals from one account is theatre — say so and substitute a real control:** a mandatory 24h cooling-off plus a required archived provider-page screenshot with its sha256 in the PR, plus the external auditor from §5.5. Do not ship a two-approver rule you cannot honour.
6. **Ed25519 key custody.** Who holds it, which GitHub Environment, which required reviewers, the rotation cadence, and pre-publishing the `next` key. A lost key with no pre-published successor strands every installed client on its bundled catalog until they upgrade.
7. **npm provenance and branch protection.** Enabling `npm publish --provenance`, signed tags, and protected branches with required reviews needs org-level settings and your npm 2FA. Without it, the pinned public key ships inside the artifact it protects and the signature is a checksum against the most likely real attack.
8. **Provider API keys for liveness checks** (Anthropic, OpenAI, Google, xAI). Which account, scoped how, rotated when. They must live in GitHub Actions secrets, never in a Worker, and never in argv — per your workspace's secret-safe execution rule, any local script that touches them runs through `/Users/fortunevieyra/.claude/bin/claude-secret-safe-exec.py`, and no step may enumerate the environment.
9. **Cloudflare provisioning.** Creating `cheaperapi`, the `api.cheaper.app` custom domain, D1 `cheaper-ledger`, and the R2 archive bucket. **Pass `account_id: "84a701a23afcd1b863bbf7f1b29bafa2"` explicitly in `wrangler.jsonc`** — your `CLOUDFLARE_ACCOUNT_ID` env var points at the wrong account. Your API token's zone permissions are bound to `cheaper.app`, which covers `api.cheaper.app`.
10. **OpenRouter.** Its `reasoning.supported_efforts`, per-endpoint tier resolution, and `expiration_date` are the best metadata available anywhere. Do you want to send a written permission request? Until you have one, it stays disabled.

**Blocking Phase 4 (telemetry) — all four are hard blockers:**

11. **Ship telemetry at all?** My recommendation is: not in the first three phases. It answers no part of the question you asked.
12. **Which legal entity is the controller, and where is it established?** Determines lead supervisory authority, whether an Art. 27 EU representative is required, and the transfer analysis for D1 region selection. This blocks the privacy page, which blocks the consent prompt, which blocks the feature.
13. **Is the public counter worth an unauthenticated write endpoint?** It brings an unbounded billing surface with no spend cap, a Sybil problem you can only bound (not solve), and a quantified performance claim you must substantiate. **The alternative:** estimate the number from npm download counts times a median per-install figure derived from a small explicitly-consented panel, with **no ingest surface at all.** That is defensible, cheap, and arguably more honest.
14. **Who reconciles against a real invoice?** Someone must consent to share an actual provider bill, pre-launch and quarterly. Without at least a handful of accounts checked against real charges, the public figure has **no substantiation** and no amount of disclosure language substitutes for it.

**One judgment call I will make for you, because the evidence is one-sided:** do not build the crawler first. Build Phase 0. Both incidents were caused by a resolver that fails open and by numbers with no visible age — and three days of local edits closes both, permanently, before a single byte of new infrastructure exists.

---

# Appendix A — Completeness critique (material gaps found after synthesis)

Verified the recommendation against the live source. Material gaps below.

---

**1. Phase 0's resolver fix is JS-only; the gateway keeps prefix inheritance, and the tagline prefers the gateway's number.**
`gateway/app/pricing.py:105-142` contains a hand-written duplicate of the entire matcher — `_loose_startswith`, `_in_window`, `resolve_model` — byte-equivalent in behaviour to `models.js`. It is *not* generated. `sync-prices.js` copies `pricing.py` verbatim; it does not derive its logic. Meanwhile `tagline.js:176-196` calls the local gateway first and marks the result `exact: true` (`tagline.js:170`), so for any user running the gateway the dollar figure on every Claude Code Stop comes from Python, not from `resolve.js`.
**Correction:** Phase 0 item 1 must name `gateway/app/pricing.py` alongside `cli/src/peek/resolve.js`, and the golden negative fixtures (`claude-opus-4-9`, `gpt-5.6-luna-272k`, `o3-deep-research`, `claude-sonnet-5-2`) must execute in **both** runtimes in the same CI job. Same applies to `detect_family`, which already drifts: `pricing.py:225` mistral regex is `(mistral|mixtral|codestral|ministral)` — JS has `|magistral|devstral`.

**2. `sync-prices.js --check` cannot carry the load the document puts on it, and is already failing silently.**
Its target list is four hardcoded entries (`sync-prices.js:39-46`): two `model_prices.json` copies, `pricing.py`, `metrics.py`. `router.py`, `app.py`, and `dashboard.html` are shipped by `package.json` `files` but are **not** in the list. `cli/assets/gateway/app/dashboard.html` is 26,052 bytes / Aug 6 08:46 while `gateway/app/dashboard.html` is 26,945 / Aug 6 19:00 — the exact drift class the script exists to prevent, live right now, and `--check` passes. The recommendation then routes routing_targets (§4.7), classifiers/tier (§9.4), the `as_of` banner (§9.2), and every site tool count (§11) through this gate.
**Correction:** add `router.py`, `app.py`, `dashboard.html`, and the generated web JSON to the target list, and add a CI assertion that every path matched by `package.json` `files` under `assets/gateway/` appears in `targets[]` — otherwise the next shipped file drifts the same way.

**3. `alerts.json` has no producer, and the stated credential rules make it unproducible.**
§4.4 introduces a signed `alerts.json` at `max-age=300` carrying `revoked[]`/`disputed[]`, and §3.2 sells it as the replacement for push. §3.3 states the crawler's *only* write authorities are R2 and one PR — no signing key, no deploy credential. The human merge path produces a release, not a 5-minute alert. So nothing in the design can actually publish an alert.
**Correction:** specify it explicitly — a separate `publish-alert` GitHub Actions workflow, `workflow_dispatch` only, gated on the same protected Environment as signing, writing only `alerts.json` + `.sig`. State that alert MTTR is therefore "one human running one workflow," not automatic. And state whether `disputed[]` can be raised automatically by the crawler at all (§5.2 rule 3 produces `NEEDS_CORROBORATION` verdicts that currently have nowhere to go).

**4. `ratesFor`'s runtime multipliers sit entirely outside the provenance apparatus.**
`models.js:224-256` applies four numbers with no catalog entry, no source, no quorum, and no invariant: `serviceTier === 'batch' → ×0.5`, `'priority' → ×1.8`, the fast-SKU rescale `scale = f.in / r.in` applied to already-long-context-adjusted rates, and long-context cache derivation `r.cacheWrite = lc.in * (entry.cacheWrite / entry.in)`. `adapters.js` reads `service_tier` off real transcripts, so priority-tier sessions are being priced at a hardcoded 1.8x with full confidence and no `~`. §4.3's per-dimension `provenance` and `derived` markers stop at `rates[]` and never reach these.
**Correction:** move `batch`/`priority` multipliers into per-model `skus{}` in the catalog (they are provider- and model-specific, not universal), give the long-context cache and fast-SKU derivations explicit `derived: {from, factor, basis}` markers, and add them to §5.3's invariant list and §5.4's replay-coverage gate. Until sourced, a `service_tier` the catalog does not carry should be `priceable: false`, not silently multiplied.

**5. Node floor contradicts the refresh implementation.**
`cli/package.json` declares `"engines": {"node": ">=16"}` and the package is zero-dependency. §4.7's refresh uses `AbortSignal.timeout` (Node 17.3+) and implies `fetch` (18+). Ed25519 via `crypto.verify` is fine on 16.
**Correction:** either raise the engines floor to `>=18` in the Phase 2 release (and say so in release notes — it drops users), or implement refresh on `https.request` + manual timers to preserve the 16 floor. Pick one now; it changes the refresh code you write.

**6. The consent-independent catalog GET is left as a first-party beacon on the same zone as ingest.**
§4.7's refresh algorithm sends `If-None-Match` — a client-state token — and §4.5 puts `/v1/catalog/*` and `POST /v1/usage/...` on the same hostname, same Worker, same zone, same Cloudflare account. §8.7 discloses the daily check in the privacy page (good) but the IP + timestamp join between a poll from a non-consenting user and a POST from a consenting one is never closed, and Cloudflare zone analytics / Security Events on the WAF rule §8.6 adopts sit outside the in-Worker protections.
**Correction:** drop `If-None-Match` in favour of comparing `version_seq` after an unconditional GET (the pointer is 600 bytes on a free path), send a version-free User-Agent, jitter the catalog poll across a 24h window rather than firing it on the work-start invocation, and require the usage flush to be ≥N hours from any catalog fetch. If ingest stays on `api.cheaper.app`, say plainly in the privacy page that Cloudflare processes IP for both paths as a joint controller.

**7. §4.7's refresh host contradicts itself on the Stop-hook path.**
"kicked at most once per 24h from any `cheaper` invocation" vs "NEVER inside peek's or the Stop hook's own process." The Stop hook (`assets/plugin/hooks/hooks.json`, 15s) `spawnSync`s the `cheaper` CLI, so `cheaper peek --tagline` **is** a `cheaper` invocation — the spawn happens inside it.
**Correction:** state the rule as an explicit exclusion: the detached spawn is skipped when `argv` contains `--tagline`, or when `CLAUDE_PLUGIN_ROOT`/a hook env marker is set. Otherwise the lockfile only bounds frequency, not which process pays the fork.

**8. No Workers spend control on the unauthenticated write endpoint.**
§8.6 quantifies the drain (~$1,296/day at 50k req/s) and adds path-encoded PoW + a WAF rule, but names no spend alert and no pre-decided response. Workers has no spend cap.
**Correction:** add a Cloudflare notification on Workers request volume, and pre-commit the response in the runbook: disable the `/v1/usage` route entirely and freeze the counter at last-known-good. §8.7's `frozen` flag already supports it.

**9. `pull_request`-triggered workflows with secrets are never forbidden.**
§3.3 restricts the bot's *write surface* and separates generation from signing, but the escalation path is a workflow trigger, not a file path: any `pull_request` / `pull_request_target` workflow in `cheaper-app` with repository-secret access runs attacker-influenced refs alongside the signing key and npm token.
**Correction:** add to §3.3 as a fourth hard requirement — no workflow triggered by `pull_request` or `pull_request_target` may reference `secrets.*`; signing, npm publish, and deploy run only on `push` to a protected branch or on a tag, behind a GitHub Environment with required reviewers. Add a CI lint over `.github/workflows/**` asserting it.

**10. Restatement re-noising is unspecified, which halves the published ε per restatement.**
§8.7 commits to Laplace noise and publishes `epsilon_per_30d_epoch: 1.0`, and the `restatement` table records before/after — but nothing says the corrected series reuses the original noise draw. A fresh draw over the same underlying days is a second independent release of the same data.
**Correction:** store the noise seed on `savings_day`, re-derive the identical draw on restatement, and either maintain a real privacy-loss ledger or stop publishing ε (§8.7 already argues an unsound ε is worse than none).

**11. `version_seq` has a CI guard but no client-side recovery.**
§4.7 asserts the increment is exactly 1 in CI — correct and sufficient for the common case — but if a bad seq ever ships behind a valid signature, every client that saw it is permanently wedged and the 30-day `issued_at` rule does not help (a legitimate fresh pointer with a lower seq is still refused).
**Correction:** add the bounded escape hatch — a client that has refused every pointer for >14 consecutive days accepts the newest validly-signed catalog regardless of `version_seq`, records the anomaly, and surfaces it in `cheaper catalog status`.

**12. Two smaller factual corrections.**
`cheaper update` does not exist — `bin/cheaper.js` has `install`, `uninstall`, `gateway`, `monitor`, `launch`, `init`, `peek`, `taglines`, `status`, `version`, `help`. §3.2, §4.7 and §10 all cite it as an existing network-permitted surface. Say it is new in Phase 2. And the Phase 0 sizing of "~3 engineer-days" excludes: the Python-side resolver rewrite (item 1 above), byte-identical two-runtime golden fixtures, the `models.js → models.json` migration plus `sync-prices.js` rewiring, the marketing-table removal, and seven CI gates that fail on merge day — five days is a more defensible number, and §12 decision 1 (fable/mythos) blocks the tier assertion before any of it lands.

**Sections that are complete:** §3.1 (tool/price resource shape), §3.2 (WebSocket rejection), §4.5 (cache headers — the `.json`-not-default-cached point is correct and the `stale-if-error` cap is right), §5.1 (source table, including the xAI ÷10,000 divisor), §5.3 (invariants), §10 (what not to build), §11 (tool counts).

---

_Produced by an 18-agent design workflow: 4 recon agents (repo surfaces, Cloudflare primitives, machine-readable price sources, privacy law), 3 independent architectures, 9 adversarial reviews across 3 lenses (wrong-price / privacy / availability-integrity), 23 critical attacks found and folded in, then a completeness critique._
