# Cheaper.app — Phase 0 execution spec

**Date:** 2026-08-06 · **Status:** implementation spec · produced by a 7-agent workflow
(tier/price analysis, advertising-substantiation research, counter-integrity + npm methodology,
release-note drafting; then two adversarial verifiers; then synthesis). 5 critical corrections were folded in.

> The adversarial pass **falsified one claim in the brief it was given**: the engine does NOT
> report a positive saving for a cost-increasing route. `tagline.js` already computes
> `baseline - spent` from the catalog and drops negatives. That framing was wrong and is
> struck. The real defects (D1-D10 below) are different, and were each measured against the
> live tree.

---

Verified against the live tree before writing. Corrections folded in; disputed claims re-measured. `cli` suite is **39/39 green** and `sync-prices --check` reports **in sync** (the "36/36, 1 stale" state in the brief is stale). `gateway/tests` is **RED: 1 failed / 22 passed** — `test_summary_scopes_to_a_single_session` fails `assert 0.0 > 0`, which is itself a live finding (§2.5). Every dollar figure below came out of a prototype run against the real modules; scripts are in `/private/tmp/claude-501/-Users-fortunevieyra-Documents-Github-ownasquare-com/5c74ee86-c3c0-4dfd-ad2c-0381633daf7f/scratchpad/`.

---

# 1. Direct answers

**Q1 — Can a custom signature / CSRF-style request token make each request unique, and would that let us keep an authenticated-ish public counter? No.** A CSRF token derives its security from being issued by a server to an already-authenticated browser session that same-origin policy prevents an attacker from reading. A CLI has no cookie jar, no ambient session, and no third-party origin, so the mechanism has nothing to attach to. And `cli/package.json` ships `"src"` in `files[]` under MIT — any key you embed is plaintext in the tarball, extractable with `npm pack cheaper && tar -xzOf cheaper-*.tgz | grep`. A per-request nonce buys **uniqueness**, not **authenticity**: it stops a *captured* request being replayed, and does nothing against someone minting fresh, correctly-signed reports in a loop, which is the entire threat to a public counter. Keep it, but keep it for what it actually is — an idempotency key and a rate-limit handle. There is no cryptographic path from "unauthenticated open-source client" to "authenticated write"; Privacy Pass gives unlinkability but pushes the problem onto issuance, Prio gives input-range proofs the $50 clamp already gives you for free, and attestation is not merely expensive but *inapplicable* to an MIT npm package. The real answer is structural: stop asking one dataset to be both trustworthy and anonymous (§3).

**Q2 — Can we just state that savings are ESTIMATED, instead of reconciling against real invoices? No as a substitute; yes as a required addition — and you have the cost backwards.** Two duties attach independently: hold a reasonable basis *before* publication, and disclose that the figure is modelled. "Estimated" performs the second and skips the first, and an estimate is itself an objective claim (it asserts a methodology exists and is reasonable). The FTC has already run this experiment — 16 CFR 255.2 records that hedge disclaimers were tested and did not reduce the misleading impression, and prescribes publishing the typical figure instead, with a *savings number* as its own worked example. ASA's Centrica Hive ruling found both failures against one advertiser simultaneously on modelled savings figures. But you do **not** need customer invoices — that is a privacy surface far larger than the claim is worth and it contradicts your own no-telemetry architecture. You need **your own provider invoices, reconciled monthly against the cost engine**: roughly two hours a month, and it is the strongest evidence available because an invoice is the provider's authoritative record. Add the word *and* do the reconciliation; neither alone is sufficient. Not legal advice — §6 lists what needs counsel.

---

# 2. Tier redesign — implementation spec

## 2.0 What is actually broken (the brief's headline finding is wrong; do not ship it)

`realizedFromRecords` **already** computes dollars from the catalog. `tagline.js:117-119` is verbatim:

```js
const baseline = costOfModel(ceilingModel, bk, ceilingCtx);
const save = baseline == null ? 0 : baseline - spent; // vs the ceiling model
if (save > 0) {
```

So the claim "the engine reports a positive saving for a route that increased cost" is **false** — `claude-opus-5 → claude-fable-5` yields `save < 0` and is dropped. If you publish a remediation aimed at a sign error that does not exist, the first competent reader who opens `tagline.js` concludes you did not read your own code. Strike it.

The real defects, all measured against the live tree:

| # | Defect | File:line | Effect |
|---|---|---|---|
| D1 | Ceiling chosen by **tier rank**, strict `>`, no sort | `tagline.js:90-94` | Anthropic's opus tier spans **$30 → $90** on a 1M/1M basket. The same session reports **$24.00 or $84.00** depending on JSONL append order. |
| D2 | Credit gated on `rank(t) < ceilingRank` | `tagline.js:113` | A genuinely cheaper call that ranks equal or higher earns **nothing**. 40 within-family price-rank inversions make this reachable. |
| D3 | `if (save > 0)` discards anti-savings | `tagline.js:119` | Shape J reports **$72.00** while a `claude-fable-5` sub-agent burned **$30.00** extra. Honest net: **$42.00**. |
| D4 | Baseline priced with the **ceiling record's** SKU and date | `tagline.js:93 → :117` | One main-loop turn on `speed:'fast'` prices every sub-agent baseline at the 2× SKU: **$54.00** vs **$24.00**. |
| D5 | `modelTier()` falls through to `'sonnet'` | `classify.js:68` | **28 of 75** catalog entries reach it; only 6 are literally Sonnet, so **22 of 75 (29%)** are silently mis-tiered — `gpt-5.6-sol` ($35 blended), `claude-fable-5` ($60). Fails **open** in exactly the way `resolveModel` was rewritten to fail **closed**. |
| D6 | Gateway prices the routed leg as the family **representative** | `metrics.py:146-150, :182` | `detail` SELECT omits the `model` column that `record()` at `:114-126` already writes. Requested `claude-opus-5` → routed `claude-sonnet-4-5`: reports **$18.00** saved, truth **$12.00**. A **50% over-report on the path that prints no `~`**. |
| D7 | `requested_tier()` returns `None` → **no ceiling applied** | `router.py:131-146, :166-170` | A request naming `gpt-4o-mini` with security-flavoured text routes to `cfg.models['opus']`, violating `allow_upgrade_above_requested: False`. Cost-increase bug. |
| D8 | JS/Python family drift | `pricing.js:58` vs `pricing.py:255` | `magistral-*`, `devstral-*` → `'mistral'` in JS, **`None`** in Python. Gateway savings silently zero for those users. *(The `fable|mythos` half of this claim is false — Python's `(claude|…)` already matches. Do not "fix" it.)* |
| D9 | Ledger is a one-way ratchet | `ledger.js:67` | `if (key && usd > 0 && tokens > 0)` means a negative chat contributes nothing **and a corrected re-run cannot overwrite a stale larger figure**. Same concealment as D3, one module over. |
| D10 | Unpriceable main loop invents a ceiling | `tagline.js:89` | `ceilingSrc = pool.length ? pool : priced` — with no priceable top-level turn, a sub-agent becomes its own baseline. |

**Decision on the tier question: tier leaves the money path entirely. It stays for routing.** Tier answers *how capable*; it must never answer *how much*. After this change it survives in exactly four places — `contentTier()`/`_content_tier()`, `RouterConfig.models` + `decide()`, `requested_tier()`, and `LAT_TIER`/`_LAT_TIER` — none of which produce a dollar figure.

**Decision on vocabulary:** the words `haiku|sonnet|opus` must not appear in any sentence containing a dollar figure. They stay as the router's three internal slot names and env vars (`ROUTER_MODEL_HAIKU|SONNET|OPUS`) — renaming them to light/standard/heavy churns two runtimes, a SQLite column, the dashboard and every user's config while fixing **zero** numbers. Defer that alias to 0.3.1 as an inert additive change.

## 2.1 `cli/src/peek/models.js` — declare the tier next to the price

Add a `tier` field to all 75 entries. Rationale: this is the one file already treated as a reviewed correctness artifact, with `CATALOG_AS_OF` and a `--check` sync gate. Adding `claude-fable-5` now *forces* the author to state its tier, and the review that catches a price typo catches a tier error. A 4th tier value fixes nothing (the defect is ordinal-as-price, not granularity); per-family `price_rank` throws away the exact difference `costOfModel` already computes and cannot serve the cross-family ceiling rule.

```diff
-function anthropic(id, inRate, outRate, extra) {
+function anthropic(id, tier, inRate, outRate, extra) {
   return Object.assign({
-    id, family: 'anthropic', in: inRate, out: outRate,
+    id, family: 'anthropic', tier, in: inRate, out: outRate,
...
-  anthropic('claude-fable-5',  10, 50),
-  anthropic('claude-mythos-5', 10, 50),
-  anthropic('claude-opus-5',    5, 25, { speed: { fast: { in: 10, out: 50 } } }),
+  anthropic('claude-fable-5',  'opus',   10, 50),  // $60 blended — a TOP model
+  anthropic('claude-mythos-5', 'opus',   10, 50),  // $60 blended
+  anthropic('claude-opus-5',   'opus',    5, 25, { speed: { fast: { in: 10, out: 50 } } }),
+  anthropic('claude-sonnet-5', 'sonnet',  3, 15, { window: {...} }),
+  anthropic('claude-haiku-4-5','haiku',   1,  5),
...
-  { id: 'gpt-5.6-sol',  family: 'openai', in: 5,   out: 30,  cacheRead: 0.5,  cacheWrite: 6.25 },
-  { id: 'gpt-5.6-luna', family: 'openai', in: 0.2, out: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
-  { id: 'o3',           family: 'openai', in: 2,   out: 8,   cacheRead: 0.5 },
-  { id: 'o3-mini',      family: 'openai', in: 1.1, out: 4.4, cacheRead: 0.55 },
+  { id: 'gpt-5.6-sol',  family: 'openai', tier: 'opus',   in: 5,   out: 30,  cacheRead: 0.5,  cacheWrite: 6.25 },
+  { id: 'gpt-5.6-luna', family: 'openai', tier: 'haiku',  in: 0.2, out: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
+  { id: 'o3',           family: 'openai', tier: 'sonnet', in: 2,   out: 8,   cacheRead: 0.5 },   // $10 blended
+  { id: 'o3-mini',      family: 'openai', tier: 'haiku',  in: 1.1, out: 4.4, cacheRead: 0.55 },
...
+  { id: 'mistral-large-3',    family: 'mistral', tier: 'sonnet', in: 0.5, out: 1.5 },  // $2 — no longer top
+  { id: 'mistral-medium-3.5', family: 'mistral', tier: 'sonnet', in: 1.5, out: 7.5 },
+  { id: 'magistral-small',    family: 'mistral', tier: 'haiku',  in: 0.5, out: 1.5 },
```

`sync-prices.js` needs **no change** — it serialises `CATALOG` wholesale, so `tier` reaches `model_prices.json` and both mirrors automatically.

**Also rename the latent duplicate:** `claude-mythos-preview` normalizes to `claude-mythos` (`models.js:176` strips `-preview`). Make the entry id `claude-mythos` with `aliases: ['claude-mythos-preview']`.

**Ship §2.1 as its own release.** It is inert until `classify.js` reads it, so a bad tier value surfaces in review rather than in production dollars.

## 2.2 `cli/src/peek/classify.js` — catalog-first, `null` default

```diff
+const { resolveModel } = require('./models');   // models.js has no deps → no cycle
+
+// CAPABILITY tier ONLY. Never a price proxy: savings compare catalog dollars
+// directly (see tagline.js). Order: catalog-declared, name signals, then null.
 function modelTier(modelId) {
   const m = String(modelId || '').toLowerCase();
   if (!m) return null;
+  const entry = resolveModel(modelId);
+  if (entry && entry.tier) return entry.tier;   // reviewed alongside the price
   if (CHEAP_SIGNALS.test(m)) return 'haiku';
   if (TOP_SIGNALS.test(m)) return 'opus';
-  return 'sonnet';
+  // Fail CLOSED. 'sonnet' silently claimed mid capability for 22 of 75 catalog
+  // entries and for every model newer than CATALOG_AS_OF. null means "we cannot
+  // prove a cheaper model would do — pass the request through untouched".
+  return null;
 }
```

`effectiveTier` already handles `actual == null` (`:76`). `scan.js:74` already guards `if (usedTier)`. **`scan.js:76` indexes `LAT_TIER[effTier]` unguarded — add a null guard.** `pricing.js:160-165` `estimateCall` already bails on `!actualTier`.

## 2.3 `cli/src/peek/tagline.js` — the core rewrite

Three functions change together: `realizedFromRecords`, `fromGateway`, `buildTagline`. **Changing only the first breaks the gateway path** — `buildTagline` is shared, and a new-shape reader against old-shape `fromGateway` output prints `ran this chat on undefined`, suppressing a genuine exact saving on precisely the users who installed the gateway.

```js
// ---- realized savings, in dollars. No tier is involved. ---------------------
//
// CEILING RULE (deliberate; change this comment if you change the rule):
// the baseline is the PRICIEST model the session's TOP-LEVEL turns ran on,
// ranked on a fixed CEILING_BASKET at the session's own date. Three properties:
//   * price, not capability. A name-derived tier put claude-fable-5 ($60 per
//     1M in + 1M out) BELOW claude-opus-5 ($30). 40 such inversions exist today.
//   * a FIXED basket. Ranking on the session's own aggregate tokens would make
//     the ceiling depend on the calls being credited — adding one cache-heavy
//     sub-agent could retroactively change a different sub-agent's credit.
//   * the SESSION's date, not today. Ranking at wall-clock time moves a
//     historical session's reported saving when a promo window expires.
// Ties break on the canonical id, so the result never depends on record order
// (it used to: the same session reported $24.00 or $84.00 by append order).
const CEILING_BASKET = { inFresh: 1e6, cacheCreate5m: 0, cacheCreate1h: 0,
                         cacheCreate: 0, cacheRead: 0, outTok: 1e6 };

function sessionDate(priced) {
  let d;
  for (const r of priced) { const c = billingCtx(r).at; if (c && (!d || c > d)) d = c; }
  return d;
}
function priciest(records, idOf, at) {
  let best = -1, winner = null;
  for (const r of [...records].sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1))) {
    const c = costOfModel(idOf(r), CEILING_BASKET, { at });
    if (c != null && c > best) { best = c; winner = idOf(r); }
  }
  return winner;
}

function realizedFromRecords(records) {
  // A model we hold no published price for is skipped outright.
  // NOTE: the old `&& modelTier(r.model)` conjunct here was dead code — modelTier
  // only returned null for an empty id, which isPriceable already rejects. With
  // modelTier now failing closed it would ALSO have silently dropped every model
  // newer than CATALOG_AS_OF. It is gone; priceability is the only gate.
  const priced = (records || []).filter((r) => isPriceable(r.model));
  if (!priced.length) return null;
  const idOf = (r) => resolveModel(r.model).id;      // canonical catalog id
  const at = sessionDate(priced);

  const pool = priced.filter((r) => r.source !== 'subagent');
  // No priceable TOP-LEVEL turn means there is no ceiling, and therefore no claim.
  // The old fallback (`pool.length ? pool : priced`) let a sub-agent become its own
  // baseline, so an uncatalogued main loop + two flavours of Haiku manufactured a
  // saving out of nothing. Unpriceable must fail closed one layer up too.
  if (!pool.length) return null;
  const ceilingModel = priciest(pool, idOf, at);
  if (!ceilingModel) return null;
  const topModel = priciest(priced, idOf, at);       // may be a sub-agent above the ceiling

  // ELIGIBLE = work Cheaper plausibly ROUTED, never the user's own model choice.
  // Only claude-code tags sidechains; codex hardcodes source:'user' (adapters.js:273)
  // and the five generic harnesses test SUBAGENT_HINT against a role string that is
  // 'assistant', so it never fires. Gating on source alone would zero out 7 of 8
  // harnesses. So: if THIS session carries sub-agent attribution, trust it; otherwise
  // fall back to today's semantics (every call not on the ceiling model).
  const routedAware = priced.some((r) => r.source === 'subagent');
  const eligible = routedAware ? priced.filter((r) => r.source === 'subagent')
                               : priced.filter((r) => idOf(r) !== ceilingModel);

  const savedByModel = {}, extraByModel = {};
  let net = 0, gross = 0, extraCost = 0, wouldHave = 0;
  let tokensCredited = 0, creditedCalls = 0, offsetCalls = 0;
  let totalSpent = 0, totalTokens = 0, anyEstimated = false;
  for (const r of priced) {
    if (r.estimated) anyEstimated = true;
    totalSpent += costOfModel(r.model, tokenBreakdown(r), billingCtx(r)) || 0;
    totalTokens += (r.inTokens || 0) + (r.outTokens || 0);
  }
  for (const r of eligible) {
    const id = idOf(r);
    if (id === ceilingModel) continue;               // ran AT the baseline
    const bk = tokenBreakdown(r), ctx = billingCtx(r);
    const spent = costOfModel(r.model, bk, ctx) || 0;
    // SAME call, SAME date, SAME SKU — the ONLY variable is the model. Cheaper
    // controls the model and nothing else, so it may claim nothing else. The old
    // code passed the CEILING RECORD's ctx here, so one fast-mode main-loop turn
    // priced every sub-agent baseline at the 2x SKU ($54.00 instead of $24.00).
    const baseline = costOfModel(ceilingModel, bk, ctx);
    if (baseline == null) continue;
    const d = baseline - spent;
    net += d; wouldHave += baseline;
    // tokensCredited covers the SAME call set as `net`. Accumulating it only on the
    // positive branch made the two halves of the printed sentence disagree.
    tokensCredited += (r.inTokens || 0) + (r.outTokens || 0);
    if (d > 0) { gross += d; creditedCalls++; savedByModel[id] = (savedByModel[id] || 0) + 1; }
    else if (d < 0) { extraCost += -d; offsetCalls++; extraByModel[id] = (extraByModel[id] || 0) + 1; }
  }
  return { ceilingModel, topModel, dollarsSaved: net, gross, extraCost, wouldHave,
           savedPct: wouldHave > 0 ? Math.round((net / wouldHave) * 100) : 0,
           tokensCredited, creditedCalls, offsetCalls, savedByModel, extraByModel,
           totalSpent, totalTokens, calls: priced.length,
           estimatedTokens: anyEstimated, exact: false };
}
```

`fromGateway` — same vocabulary, and it **degrades to null** rather than emitting a half-shape:

```js
function fromGateway(summary) {
  if (!summary || !summary.dollars) return null;
  // A gateway older than 0.3.0 cannot feed the model-named sentence. Returning null
  // falls back to the transcript estimate (a "~" figure) rather than interpolating
  // undefined into user-visible copy. Tell users to restart the gateway on upgrade.
  if (!summary.baseline_model || !summary.downgraded_by_model) return null;
  const dol = summary.dollars;
  const tot = summary.by_tier || {};
  let totalTokens = 0;
  for (const t of Object.keys(tot)) totalTokens += (tot[t].in_tokens || 0) + (tot[t].out_tokens || 0);
  return {
    ceilingModel: summary.baseline_model,
    topModel: summary.top_model || summary.baseline_model,
    dollarsSaved: dol.saved || 0, gross: dol.gross || 0, extraCost: dol.extra || 0,
    wouldHave: dol.billed_top || 0, savedPct: dol.savings_pct || 0,
    tokensCredited: (summary.tokens && summary.tokens.downgraded) || 0,
    creditedCalls: (summary.counts && summary.counts.models_changed) || 0,
    offsetCalls: (summary.counts && summary.counts.models_upcharged) || 0,
    savedByModel: summary.downgraded_by_model || {},
    extraByModel: summary.upcharged_by_model || {},
    totalSpent: dol.spent || 0, totalTokens,
    calls: summary.total || 0, exact: true,
  };
}
```

`buildTagline` — models, never tiers; the offset is **rendered**, not silently computed:

```js
function modelParts(hist) {
  return Object.entries(hist || {})
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([m, n]) => `${n} call${n === 1 ? '' : 's'} on ${m}`);
}

function buildTagline(r, brand, format) {
  if (!r) return '';
  brand = brand || 'Cheaper.app';
  const spend = spendSentence(r, format);
  const names = Object.keys(r.savedByModel || {});
  const shown = modelParts(r.savedByModel).slice(0, 3);
  if (names.length > 3) shown.push(`${names.length - 3} other model${names.length - 3 === 1 ? '' : 's'}`);

  const realSaving = r.dollarsSaved >= SHOW_MIN_USD && r.creditedCalls > 0 &&
    r.tokensCredited > 0 && shown.length > 0 && r.ceilingModel;
  if (realSaving) {
    const amt = (r.exact ? '' : '~') + money(r.dollarsSaved);
    const off = modelParts(r.extraByModel);
    // The anti-saving is NAMED. Netting it into the headline without showing it
    // leaves a breakdown that cannot be reconciled with the figure it explains.
    const offset = off.length ? ` — after ${money(r.extraCost)} more on ${joinAnd(off)}` : '';
    return `${brand} saved ${tint(amt, 'save', format)} and ${fmtTokens(r.tokensCredited)} tokens ` +
      `by running ${joinAnd(shown)} instead of ${r.ceilingModel}${offset}, at list API rates.${spend}`;
  }
  if (r.dollarsSaved <= -SHOW_MIN_USD && r.ceilingModel && Object.keys(r.extraByModel || {}).length) {
    return `${brand} claims no saving on this chat — routed work cost ` +
      `${money(-r.dollarsSaved)} more than ${r.ceilingModel} would have.${spend}`;
  }
  const kept = r.topModel || r.ceilingModel;
  if (kept) return `${brand} ran this chat on ${kept} — no routing saving to claim.${spend}`;
  return spend ? spend.trimStart() : '';   // never interpolate undefined
}
```

## 2.4 `cli/src/peek/ledger.js` — stop the ratchet

```diff
 function record(key, usd, tokens, exact) {
-  if (key && usd > 0 && tokens > 0) {
-    const data = load();
-    data.chats[key] = { usd, tokens, exact: !!exact, at: isoNow() };
-    prune(data.chats); save(data);
-    return totals(data);
-  }
-  return totals(load());
+  if (!key) return totals(load());
+  // ALWAYS overwrite this chat's entry — including with zero or a NEGATIVE net.
+  // The old `usd > 0 && tokens > 0` guard made the lifetime total a one-way
+  // ratchet: a chat that COST money contributed nothing, and a corrected re-run
+  // could not overwrite an earlier, larger, wrong figure — the write was skipped
+  // entirely and the stale value survived. Same concealment as `if (save > 0)`.
+  const data = load();
+  data.chats[key] = { usd, tokens, exact: !!exact, at: isoNow() };
+  prune(data.chats); save(data);
+  return totals(data);
 }

 function totals(data) {
   const d = data || load();
-  let usd = 0, tokens = 0, chats = 0, exact = true;
+  let usd = 0, tokens = 0, chats = 0, measured = 0, exact = true;
   const c = d.chats || {};
   for (const k of Object.keys(c)) {
-    const e = c[k];
-    if (e && e.usd > 0) { usd += e.usd; tokens += e.tokens || 0; chats++; if (!e.exact) exact = false; }
+    const e = c[k]; if (!e) continue;
+    usd += e.usd || 0; tokens += e.tokens || 0; chats++;
+    if (e.exact) measured++; else exact = false;
   }
   if (chats === 0) exact = false;
-  return { usd, tokens, chats, exact };
+  return { usd, tokens, chats, measured, exact };
 }
```

And the lifetime sentence — split by measurement class, and suppress rather than show a negative:

```js
function lifetimeSentence(tot, format) {
  // A negative running total is suppressed, not displayed: "Lifetime savings: -$4"
  // is a worse artifact than silence, and the cumulative claim is the strongest
  // thing on screen. It reappears the moment the running net is positive again.
  if (!tot || !(tot.usd >= SHOW_MIN_USD) || !(tot.tokens > 0)) return '';
  const amt = (tot.exact ? '' : '~') + money(tot.usd);
  const split = tot.exact ? '' : ` (${tot.measured} measured, ${tot.chats - tot.measured} estimated)`;
  return ` Lifetime: ${tint(amt, 'save', format)} and ${fmtTokens(tot.tokens)} tokens ` +
    `less than ceiling-model cost across ${tot.chats} chats${split}.`;
}
```

**One-time migration:** existing `~/.cheaper/lifetime.json` entries were written under the old positives-only rule and cannot be corrected in place. On first 0.3.0 run, if `version === 1`, rewrite as `{version: 2, chats: {}}` and print once: `Lifetime total reset — 0.3.0 changed how savings are computed. See cheaper.app/method.` A discontinuity you announce is defensible; a silently mixed series is not.

## 2.5 Gateway Python — **both mirrors**

`gateway/app/` and `cli/assets/gateway/app/` are byte-identical. Every edit lands twice, or extend the `sync-prices.js --check` gate to cover `*.py` as it already covers `model_prices.json`. **Do this first**, so the gate catches you.

**Fix the pre-existing RED test before touching anything else.** `tests/test_metrics.py::test_summary_scopes_to_a_single_session` fails `assert 0.0 > 0` because the fixture records `original_model="opus"`, which stopped being priceable when prefix inheritance was removed. That is a real finding, not just a fixture bug: **any `original_model` that is not an exact catalog id now yields $0.00 saved on the exact path.** Update the fixture to `original_model="claude-opus-5", model="claude-haiku-4-5"`, and add a separate test asserting an unpriceable `original_model` contributes exactly zero and increments an `unpriceable` counter.

**`metrics.py`:**

```diff
+from datetime import datetime, timezone
+
+def _day(ts):
+    """UTC date a row was recorded, so it prices at the rates in force THEN."""
+    try:
+        return datetime.fromtimestamp(float(ts), tz=timezone.utc).strftime("%Y-%m-%d")
+    except Exception:
+        return None
...
             detail = c.execute(
                 "SELECT ts, tier, original_model, in_tokens, out_tokens, source, "
-                "requested_tier, requested_effort "
+                "requested_tier, requested_effort, model "
                 "FROM decisions" + where + " ORDER BY ts DESC LIMIT ?", sp + (max_rows,)).fetchall()
...
-        downgraded_by_tier = {"haiku": 0, "sonnet": 0, "opus": 0}
+        downgraded_by_tier = {"haiku": 0, "sonnet": 0, "opus": 0}   # kept 1 release, then drop
+        downgraded_by_model: dict = {}
+        upcharged_by_model: dict = {}
+        baseline_hist: dict = {}
+        unpriceable = 0
+        gross = extra = 0.0
+        models_upcharged = 0
         if _PRICING:
-            for (ts, tier, om, it, ot, src, rtier, reff) in detail:
-                it = it or 0
-                ot = ot or 0
-                est = estimate_call(om, it, ot, tier)
-                saved = est["saved"]
-                spent = est["new_cost"]
-                billed_top = cost_of(est["family"], "opus", it, ot) if detect_family(om) else 0.0
+            for (ts, tier, om, it, ot, src, rtier, reff, routed) in detail:
+                it = it or 0
+                ot = ot or 0
+                at = _day(ts)
+                # Accumulate the COUNT-only aggregates first, so an unpriceable row
+                # still appears in the per-tool table and the time series. Otherwise
+                # sum(by_tool.calls) stops matching summary["total"] (an independent
+                # COUNT(*)) and the dashboard silently disagrees with itself.
+                tool = _clean_tool(src)
+                a = by_tool_acc.setdefault(
+                    tool, {"tool": tool, "calls": 0, "saved": 0.0, "spent": 0.0, "down": 0})
+                a["calls"] += 1
+                b = int(ts // ts_bucket) * ts_bucket
+                g = ts_acc.setdefault(b, {"t": b, "saved": 0.0, "spent": 0.0, "calls": 0})
+                g["calls"] += 1
+                # BOTH legs from the catalog, at the rates in force on the day the
+                # call ran. `om` is what the caller asked for; `routed` is what
+                # Cheaper actually called. Neither is a tier, a representative, nor
+                # an average. The old representative path over-reported by 50% on
+                # Anthropic sonnet routes (claude-sonnet-5's promo window vs the
+                # claude-sonnet-4-5 the router actually calls).
+                baseline = cost_of_model(om, in_tok=it, out_tok=ot, at=at)
+                spent = cost_of_model(routed, in_tok=it, out_tok=ot, at=at)
+                if baseline is None or spent is None:
+                    unpriceable += 1          # counted, never guessed
+                    continue
+                saved = baseline - spent      # SIGNED. No max(0, ...).
+                billed_top = baseline
+                baseline_hist[om] = baseline_hist.get(om, 0) + 1
                 dollars["saved"] += saved
                 dollars["spent"] += spent
                 dollars["billed_top"] += billed_top
-                tool = _clean_tool(src)
-                a = by_tool_acc.setdefault(...)
-                a["calls"] += 1
                 a["saved"] += saved
                 a["spent"] += spent
-                if est["downgraded"]:
+                if saved > 0:
+                    gross += saved
                     a["down"] += 1
                     models_changed += 1
                     tokens_downgraded += it + ot
                     downgraded_by_tier[tier] = downgraded_by_tier.get(tier, 0) + 1
+                    downgraded_by_model[routed] = downgraded_by_model.get(routed, 0) + 1
+                elif saved < 0:
+                    extra += -saved
+                    models_upcharged += 1
+                    tokens_downgraded += it + ot
+                    upcharged_by_model[routed] = upcharged_by_model.get(routed, 0) + 1
-                b = int(ts // ts_bucket) * ts_bucket
-                g = ts_acc.setdefault(...)
                 g["saved"] += saved
                 g["spent"] += spent
-                g["calls"] += 1
```

Then in the returned dict:

```python
"baseline_model": max(baseline_hist, key=baseline_hist.get) if baseline_hist else None,
"top_model":      max(baseline_hist, key=baseline_hist.get) if baseline_hist else None,
"downgraded_by_model": downgraded_by_model,
"upcharged_by_model":  upcharged_by_model,
"unpriceable": unpriceable,
"counts": {..., "models_upcharged": models_upcharged},
"dollars": {..., "gross": gross, "extra": extra},
```

`estimate_call` leaves the metrics path entirely. `by_tier` **stays** — it is a genuine routing diagnostic for the dashboard chart and is no longer load-bearing for dollars.

**Also, name what the exact path cannot see.** `app.py:218` records only `usage['input_tokens']`, which for Anthropic *excludes* `cache_read_input_tokens` and `cache_creation_input_tokens`, and `decisions` has no cache columns. Until that is threaded through, the gateway figure is computed from a minority of the tokens actually billed. **Either add `cache_read` / `cache_create_5m` / `cache_create_1h` columns to `decisions` and thread them through `record()`, or keep the `~` on the gateway path.** Shipping a no-tilde figure that cannot see cache tokens is the single most attackable thing in the codebase after the ticker. My recommendation: add the columns in this release — it is three columns and one call site, and the alternative surrenders the product's best claim.

**`pricing.py` — the one real drift:**

```diff
-    ("mistral",   re.compile(r"(mistral|mixtral|codestral|ministral)", re.IGNORECASE)),
+    ("mistral",   re.compile(r"(mistral|mixtral|codestral|ministral|magistral|devstral)", re.IGNORECASE)),
```

Do **not** add `fable|mythos` to the anthropic pattern — verified, `(claude|…)` already matches both. `model_tier()` gets the same catalog-first + `None` treatment as the JS.

**`router.py` — enforce the ceiling in dollars:**

```python
def requested_ceiling(body: dict, cfg: RouterConfig):
    """Capability tier AND unit cost of the model the caller named.
    requested_tier() returns None for any id without haiku/sonnet/opus that is not
    an exact cfg.models value — and decide() then applied NO ceiling at all, so
    `gpt-4o-mini` + security-flavoured text routed to cfg.models['opus'], directly
    violating allow_upgrade_above_requested=False. The real invariant was always a
    DOLLAR ceiling; tier rank was only ever a proxy for it."""
    m = (body.get("model") or "")
    return requested_tier(body, cfg), cost_of_model(m, in_tok=1e6, out_tok=1e6)

# in decide(), after the existing tier cap:
req_tier, req_cost = requested_ceiling(body, cfg)
if req_cost is not None:
    cand = cost_of_model(model_map[tier], in_tok=1e6, out_tok=1e6)
    if cand is not None and cand > req_cost:
        for t in TIERS[:_rank(tier)][::-1]:            # walk DOWN until we're cheaper
            c = cost_of_model(model_map[t], in_tok=1e6, out_tok=1e6)
            if c is not None and c <= req_cost:
                tier = t
                reason += f"; dollar ceiling: {model_map[t]} <= requested"
                break
        else:
            return Decision(tier=None, model=(body.get("model") or ""),
                            reason="no configured model is cheaper; passthrough")
if req_tier is None and req_cost is None:
    return Decision(tier=None, model=(body.get("model") or ""),
                    reason="unrecognized model; passthrough (cannot prove a saving)")
```

`REPRESENTATIVE` is misnamed and now has exactly one legitimate caller: the **prospective** counterfactual in `estimateCall` (`scan.js:53`), which imagines a model Cheaper *would* have picked. That is a routing question. **Re-key it off the router's configured model map and rename it `ROUTE_TARGET`** — and note two live bugs it hides: `xai` has `cheap === mid === 'grok-4.3'` and `deepseek` has `cheap === mid === 'deepseek-v4-flash'`, so a haiku-tier downgrade in either family is structurally incapable of showing a saving. That is a *deflation* defect in the surface that feeds the marketing pages.

## 2.6 Tests

**`cli/test/peek.test.js` — add:**

1. `every catalog entry declares a tier in TIERS` — iterate `CATALOG`, assert `TIERS.includes(e.tier)`. This is the gate that makes the catalog-declared design self-enforcing.
2. `catalog tier never contradicts price within a family` — for each family, assert no lower-tier entry outprices a higher-tier one on a 1M/1M basket. **Regression test for all 40 violations. Do not ship §2.1 without it.**
3. `modelTier is catalog-first and fails closed` — `modelTier('claude-fable-5') === 'opus'`; `modelTier('gpt-5.6-sol') === 'opus'`; `modelTier('some-brand-new-model') === null`; explicitly assert it is **not** `'sonnet'`.
4. `ceiling is the priciest pool model, not the highest-ranked` — `[fable-5 user, opus-5 subagent]` ⇒ `ceilingModel === 'claude-fable-5'`, saved **$30.00**.
5. `ceiling is order-independent` — G1 and G2, identical `dollarsSaved` and `ceilingModel`.
6. `ceiling does not depend on when you run peek` — freeze `Date.now()` either side of 2026-08-31 for a session dated 2026-06-15; assert identical `ceilingModel` **and** identical `dollarsSaved`.
7. `baseline uses the call's own SKU and date` — ceiling turn `speed:'fast'` ⇒ **$24.00**, not $54.00.
8. `anti-savings are netted AND named` — shape J ⇒ `dollarsSaved === 42`, line contains `after $30.00 more on 1 call on claude-fable-5`, line does **not** contain `$72`.
9. `a session that routed UP claims no saving` — shape B ⇒ `dollarsSaved === -30`, line matches `/claims no saving/`.
10. `no priceable top-level turn ⇒ null` — shape K ⇒ `realizedFromRecords(...) === null`. Extends the existing "unknown models never invent a saving" test to the ceiling side.
11. `every harness still reports a saving on a routed session` — loop over `HARNESSES`, build a records array with that harness's own source attribution, assert `dollarsSaved > 0`. **This is the guard against zeroing out 7 of 8 harnesses.**
12. `the tagline names models, never tiers` — on a GPT-only session assert `!/\b(haiku|sonnet|opus) tier\b/.test(line)`.
13. `no tagline output ever contains "undefined"` — run every `buildTagline` fixture in the suite through `assert.ok(!/undefined/.test(line))`.
14. `tokensCredited covers the same calls as dollarsSaved` — assert `dollarsSaved` equals the sum of per-call deltas over exactly the calls named in the string.
15. `ledger records signed nets and always overwrites` — `record(k, +10, 1e6)`, `record(k, -5, 1e6)`, assert `totals().usd === -5`.
16. `existing dollar anchors are unchanged` — re-assert **$156.00** (`:137`), **$11.50** (`:438`), and `savedTierHist.sonnet === 12` → `savedByModel['claude-sonnet-4-5'] === 12` (`:166`).

**`gateway/tests/` — add:**

17. `metrics prices the routed model, not the representative` — `original_model='claude-opus-5', model='claude-sonnet-4-5'` ⇒ `dollars.saved == 12.0`, not `18.0`.
18. `a historical row is priced at the rates in force then` — a row timestamped inside the Sonnet 5 promo keeps its figure when "today" is after 2026-08-31.
19. `an unpriceable row contributes nothing but is still counted` — `dollars.saved` and `dollars.spent` unmoved, `unpriceable == 1`, `sum(by_tool.calls) == total`.
20. `cross-runtime parity` — a fixture list of ~20 ids asserted to give identical `(family, tier, priceable, cost)` in JS and Python; run from `npm test` via `execFileSync('python3', …)`. **The only durable defence against the magistral/devstral class of drift.**

**Tests that must change (5 of 39):** `:143`, `:166`, `:323`, `:408` assert the tier-vocabulary string; `:443-449` asserts `dollarsSaved === 0` for a haiku-ceiling/opus-subagent session, which becomes **−$84.00** internally (the user-visible outcome — no saving claimed — is identical). Every other hand-built `buildTagline` fixture carries the old result shape; **keep `tierHist`/`savedTierHist` on the returned object for one release** so the shape change is separable from the math change.

## 2.7 Blast radius — measured, not estimated

Prototype run against the real modules. 1M in / 1M out per call unless noted.

| Session shape | Now | After | Δ |
|---|---|---|---|
| **F. opus-5 main + haiku + sonnet-5 subs** (common Claude Code shape) | **$42.00** | **$42.00** | **unchanged** |
| T128 opus-4 main + haiku + sonnet-4-5 subs *(existing test)* | $156.00 | $156.00 | unchanged |
| T426 gemini-2.5-pro ceiling + haiku sub *(cross-family, existing test)* | $11.50 | $11.50 | unchanged |
| T166 168× opus-4 main + 7 opus subs + 12 sonnet subs *(existing test)* | $5.04 | $5.04 | unchanged |
| **L. Codex shape — no sub-agent attribution** | **$100.05** | **$100.05** | **unchanged** |
| **M. Gemini shape — no sub-agent attribution** | **$43.00** | **$43.00** | **unchanged** |
| A. fable-5 main + 2× opus-5 subs | $0.00 | $60.00 | **+$60.00** |
| C. gpt-5.6-sol main + o3 sub | $0.00 | $25.00 | +$25.00 |
| E. mistral-medium-3.5 main + large-3 sub | $0.00 | $7.00 | +$7.00 |
| G1. opus-5 then opus-4-1 user turns + haiku sub | $24.00 | $84.00 | +$60.00 |
| G2. **same session, records reordered** | **$84.00** | **$84.00** | +$0.00 |
| J. opus-5 main + 1 fable-5 sub + 3 haiku subs | $72.00 | $42.00 | **−$30.00** |
| H. ceiling turn ran `speed:'fast'` | $54.00 | $24.00 | −$30.00 |
| B. opus-5 main + fable-5 sub (routed UP) | $0.00 | −$30.00 | **sign flip** |
| D. gpt-5.6-luna main + o3-mini sub | $0.00 | −$4.10 | sign flip |
| I. codestral main + magistral-small sub | $0.00 | −$0.80 | sign flip |
| K. uncatalogued main loop + haiku subs | $0.00 | **no claim** | claim withdrawn |

**Reading it:** the common shape and all six non-Claude-Code harness shapes are **unchanged** — this is a no-op for the overwhelming majority of real sessions. Increases (A, C, E) are savings that genuinely happened and were suppressed by the rank gate. Decreases (J, H) are over-claims. Sign flips (B, D, I) are sessions where routing *cost* money and the line said "no cheaper routing was warranted" — no longer a false saving, no longer a false all-clear.

**G1/G2 is the one to show a skeptic.** Identical session, records in a different order: **$24.00 vs $84.00 today**, both **$84.00** after. That is 3.5× of reported savings riding on JSONL append order, and it has nothing to do with `fable`.

**Gateway:** requested `claude-opus-5` → routed `claude-sonnet-4-5` (the router's own default) currently reports **$18.00** saved; truth is **$12.00**. Verified: representative `claude-sonnet-5` = $12.00 on the basket (inside its promo window to 2026-08-31), routed `claude-sonnet-4-5` = $18.00, baseline `claude-opus-5` = $30.00. **Fix this before any legal framing matters: the path that drops the tilde is currently the least accurate one.**

## 2.8 Rollout order

1. Extend `sync-prices --check` to cover `*.py`. *(No behaviour change; catches every later mistake.)*
2. `models.js` catalog `tier` + tests 1–2. **Ship alone.** Inert until §2.2 reads it.
3. Fix the RED gateway test + `pricing.py` magistral/devstral + test 20.
4. `classify.js` null default + test 3; guard `scan.js:76`.
5. `tagline.js` (all three functions together) + tests 4–14, 16.
6. `ledger.js` + test 15 + the v2 migration notice.
7. Gateway `metrics.py` (both mirrors) + cache columns in `decisions` + tests 17–19.
8. `router.py` dollar ceiling.
9. `sync-prices.js` regen; dashboard reads `downgraded_by_model`.
10. Rename `REPRESENTATIVE` → `ROUTE_TARGET`, keyed off the router map; fix the xai/deepseek collapsed buckets.

---

# 3. Counter decision

## 3.1 The decision

**Do not build the public unauthenticated POST ingest, in any form, with or without a signature.** Ship the panel-based figure. Per the directive, npm-downloads × panel-median is specified in full below as the fallback — with the honest caveat that **its blocking dependency is the denominator, not the panel**, and the fallback should not be published until a denominator exists.

Measured poisoning economics, against a real population of ~18k install-days/day:

| PoW bits | Honest client cost | 16-core VPS (~$50/mo) | 1024 rented cores |
|---|---|---|---|
| 20 | 0.4 s | 26,367,187/day (**1,465×**) | 1.69B/day |
| 28 | 107 s | 102,996/day (5.7×) | 6.6M/day (366×) |
| 32 | 1,718 s | 6,437/day (0.4×) | 412K/day (**22.9×**) |

Holding one cheap VPS below the real population costs an honest laptop **7–29 CPU-minutes/day** and still loses 23–92× to a rented cluster. PoW is dead as an integrity control at any usable difficulty.

The only mechanism that bounds inflation **regardless of attacker budget** is an independently-observed denominator cap — `counted = min(reports, 1.5 × observed_installs)` holds overstatement at exactly **1.50×** against 10⁴ or 10⁸ forged reports, at **zero anonymity cost**, because it never needs to know *which* reports are real. **That principle must also be applied to the design you actually ship** — npm downloads are the denominator of the published figure, and `while true; do npm install cheaper; done` moves them for free. Guards are in §3.3.

Building the ingest would also falsify three currently-true shipped claims: `cli/src/peek/index.js:3` ("WITHOUT sending anything anywhere" — verified, every HTTP reference in `src/` targets `127.0.0.1`), `tagline.js:17`, and `claude-code-savings-tracker.html:188`. Trading that sentence for a **15.7%** improvement in the error budget is a bad trade twice over. Revisit only when there is a paid authenticated tier, at which point a server-issued per-account credential and a billing relationship dissolve the problem.

## 3.2 What to publish in v1

The measured thing, not a modelled aggregate:

```
Median install: $38/mo lower model spend

Measured across 214 consented installs, 1–31 July 2026. Median, not mean.
Baseline: the same work priced at each install's own session-ceiling model at
published list rates. Your result depends on your workload.      [How we measure →]
```

It has a denominator, a date, a median (medians resist the outlier problem that would otherwise dominate the panel), and a named baseline. It needs **no** `h`, **no** `k`, **no** retention curve, and **no** active-fraction — the four quantities that carry 79% of the aggregate's variance and that a panel of retained users cannot measure. It is the only figure in this entire position that is measured end to end.

**Lead with the median, subordinate the interval.** Do not publish a range-led headline: under 16 CFR 255.2 the prescribed cure is a *typical figure*, and a published upper bound is a maximum-performance claim, which imports the FTC's 2012 "all or almost all consumers" standard onto the least-substantiated number in the model.

## 3.3 The fallback, specified

```
D(d)  = npm downloads on day d                       (range endpoint, d ≤ today−2)
B(d)  = automation floor                             ASSUMED — see caveat
H(d)  = D(d) − B(d)                                  human-attributable fetches
I(d)  = H(d) / k                                     k = fetches per install   [PANEL]
A(d)  = Σ_{j=0..27} I(d−j) · R(j)                    R = retention curve       [PANEL]
S(d)  = A(d) · M                                     M = median $/active-day   [PANEL]
public_total(T) = Σ_{d ≤ T} min( S(d), CAP(d) )
```

Registry endpoints, both verified live:

```
GET https://api.npmjs.org/downloads/range/{YYYY-MM-DD}:{YYYY-MM-DD}/{pkg}
GET https://api.npmjs.org/versions/{pkg}/last-week      ← drop dead versions
```
Lag ~1 day; the current UTC day is partial. Always compute on `d ≤ today−2`. `cheaper` currently returns `{"error":"package cheaper not found"}` — consistent with 0.2.5 unpublished.

**Worked example.** 42,000 downloads over 28 days → D = 1,500/day.

| Factor | 95% range | Centre (geometric) | σ_ln |
|---|---|---|---|
| human share (1 − B/D) | 0.55 – 0.75 | 0.6423 | 0.0791 |
| 1/k | 1/3.0 – 1/1.3 | 0.5064 | 0.2133 |
| ρ (active fraction) | 0.25 – 0.60 | 0.3873 | 0.2233 |
| M ($/active-day) | 2.10 – 3.60 | 2.7495 | 0.1375 |

```
central daily = 1500 × 0.6423 × 0.5064 × 0.3873 × 2.7495 = $519.49/day
σ_ln(total)   = √(0.0791² + 0.2133² + 0.2233² + 0.1375²)  = 0.3472
95% factor    = exp(1.96 × 0.3472) = ×1.97
over 90 days  = $23,674 .. $92,336   (central $46,754)
```

**Variance decomposition — the decisive result.** 1/k contributes **37.8%**, ρ **41.4%**, the panel median only **15.7%**, human share 5.2%. Growing the panel 10× moves the 95% span from **3.9× to 3.5×**. Fixing the denominator moves it to **1.7×**. *(These σ's are combined as √Σσ² which assumes independence; k and ρ are the same underlying quantity viewed twice — heavy users invoke more **and** are more likely active — so the true span is wider than stated. Widen it, do not narrow it.)*

**Six guards, all mandatory:**

1. **Cap the denominator against a second independent observable** with a different attack cost — Cloudflare request counts to the install page, or a hard-coded plausible-growth ceiling. Publish `min()` of the two. This is the one budget-independent control and the recommended architecture is where it belongs.
2. **Use a trimmed or median daily count over the window, never a sum**, so one spike cannot move the total.
3. **Build-time plausibility gate:** if day-over-day change exceeds a committed band, the GitHub Action **fails and does not publish**. Freeze-and-alarm at the last validated value; never fail open.
4. **Commit the raw `api.npmjs.org` response beside the derived figure.** The computation is then reproducible from the record, and the git history *is* your dated substantiation worksheet, at zero extra cost.
5. **Pin every action by full commit SHA; never `pull_request_target`; scope the token to the single file path; protect the workflow file with CODEOWNERS.** At a monthly cadence, seriously consider computing offline and committing by hand — the automation buys almost nothing and costs you the entire supply-chain surface.
6. **Recompute the whole series whenever the catalog changes, and say so.** Publish a monotone value plus a dated methodology version; if a correction reduces it, freeze and restate under a new version rather than silently decrementing.

**The `h` caveat, stated plainly because it is the same defect as `s*r*0.8`.** The automation floor `B = (E − h·W)/(1 − h)` is **one equation with two unknowns**. `h` (weekend human retention) is unmeasurable from download counts, and the 1/(1−h) factor is 2.86× at h=0.35 — the published figure is a function of a number you pick. It is also wrong in a known direction: most CI is commit-triggered and therefore weekday-heavy, so the flat-automation assumption understates B, overstates human installs, and **overstates savings**. On the real `npm` series (W = 2,983,244; E = 1,572,933) the implied automated weekday share swings 27.3% → 44.4% across h = 0.35 → 0.15. **Do not publish a figure that depends on `h`.** If it ships as an interim, `/method` must label it an assumed parameter, state that the model is unidentifiable without it, state the upward bias, and **show the published figure at both ends of the range, never at a chosen centre.** Re-derive W and E from `cheaper`'s own series first; require ≥12 weekend observations.

**Panel sizing — count PANELISTS, not panel-weeks.** `n = 1.20 · (2.4565 · σ / r)²`, where σ is the log-sd of per-install-day savings and the 1.20 is a measured finite-sample correction. At σ = 1.0: n = 116 for ±25%, n = 182 for ±20%. Weeks from the same panelist are **not independent** — at m=4 and ICC 0.6 the design effect is ≈2.8, so 120 panel-weeks carries the information of ~43 observations and ±27% becomes ≈±45%. Feed `medianCI` **one row per panelist** (the median of their weekly values), assert that in the module header, and measure ICC from the first collection cycle rather than assuming it.

Write `cli/scripts/panel-median.js` — distribution-free, zero-dep, Thompson sign-test interval (coverage ≥ 1−α for any continuous distribution; nominal 95% achieves 97.79% at n=120, and publishing the *achieved* figure is free credibility). Winsorise at the $50 per-install-day clamp before any aggregate — the same constant doubles as a DP sensitivity bound if noise is ever added. Add `cheaper panel export` reading `~/.cheaper/lifetime.json`, which is already a per-session-keyed idempotent ledger — **the panel needs no new instrumentation**, and the command must **print, never auto-send**.

## 3.4 If an ingest is built anyway — the abuse-bounding stack, with anonymity cost stated

| Rank | Control | Integrity gained | Anonymity cost |
|---|---|---|---|
| 1 | Independently-observed denominator cap | Bounds overstatement at the cap ratio vs **any** budget | **None** — never attributes anything |
| 2 | Server recomputes dollars from bucketed tokens; client never sends money | Removes the unbounded lever and a near-unique float | **Negative** (improves privacy) |
| 3 | $50 per-install-day clamp | Bounds magnitude | None |
| 4 | Winsorise at p99 / trimmed mean | Bounds one contributor's leverage | **Negative** (bounded influence *is* privacy) |
| 5 | Daily snapshot, never live | Kills the poll-before/poll-after per-user readout | **Negative** |
| 6 | k-anonymity gate (fold at k ≥ 50/day) | Modest | **Negative** |
| 7 | Cloudflare **WAF** rate limiting at the edge | Bounds casual scripted volume | ~zero — CF is already the processor; **never key on IP inside the Worker**, that is you processing personal data |
| 8 | Statistical outlier / coordination detection | Catches naive bursts only | Low but nonzero — needs more per-report structure, longer |
| 9 | Proof of work | ≈0 at usable difficulty | Nonzero — solve time is a device fingerprint |
| — | **Reject:** Turnstile, per-install tokens, attestation | Turnstile breaks CI/SSH installs; per-install tokens give ~zero Sybil resistance at full anonymity cost; attestation is inapplicable to an MIT npm package | — |

---

# 4. Finished copy

## 4a. Release notes — `docs/CHANGELOG.md`, the npm README release section, and the GitHub release body

> # cheaper 0.3.0 — savings are measured in dollars, not tiers
>
> **Your reported savings may move in either direction. Most sessions will not change at all.**
>
> ## What changed
>
> Cheaper used to decide whether a call saved you money by comparing *capability tiers* inferred from the model's name. Model names stopped tracking model prices: some "mid-tier" models now cost more than "top-tier" ones. We found **40 places in our own price catalog** where the name-based ordering contradicted the actual price, and **22 of 75 models** were getting a capability label purely by falling through a regex.
>
> Savings are now computed **directly from published per-token prices** — what the call cost on the model that ran it, versus what the same tokens would have cost on your session's baseline model. No tier is involved in any dollar figure.
>
> ## What you'll see
>
> - **The end-of-chat line names models, not tiers.** Before: *"by using haiku tier for 6 calls instead of opus"* — which, on a pure GPT session, printed Anthropic vocabulary over OpenAI traffic. Now: *"saved ~$0.42 and 1.2M tokens by running 6 calls on claude-haiku-4-5 instead of claude-opus-5, at list API rates."*
> - **Sessions where a sub-task ran on something more expensive than your main model no longer report a saving.** Previously the extra cost was silently dropped and the remaining savings were still claimed. A session with one $30 over-spend and $72 of genuine savings reported $72; it now reports $42 and names the $30.
> - **Reported savings no longer depend on the order records appear in your logs.** The same session used to be able to report **$24 or $84** depending on which line landed first in the transcript. Anthropic's "opus tier" spans a 3× price range, and the old rule picked whichever one it saw first.
> - **Two accuracy fixes may lower your number.** Baselines are no longer priced at premium-speed rates because one turn happened to use fast mode. And the gateway now prices the model it actually called rather than a stand-in — that fix alone corrects a **50% over-report** on Anthropic mid-tier routes.
> - **A model we don't recognise no longer defaults to "mid-tier".** Cheaper leaves the request alone rather than guessing, and a session whose main loop ran on an uncatalogued model now claims nothing at all instead of pricing one flavour of Haiku against another.
> - **Your lifetime total resets once.** The old ledger only ever recorded chats that saved money, and would not overwrite an earlier figure with a corrected one — so it could only go up. It now records the honest signed result for every chat, and shows how many chats were measured versus estimated. The existing total cannot be corrected in place, so it starts fresh.
>
> **Typical impact: none.** A standard Claude Code session (Opus main loop, Haiku/Sonnet sub-agents) reports exactly the same figure as before — $42.00 before, $42.00 after. Codex and Gemini CLI sessions are unchanged. Numbers move only in the cases above.
>
> ## Under the hood
>
> Every model in the price catalog now declares its capability tier explicitly, next to its price, reviewed together — so the review that catches a price typo catches a tier error, and a test fails if any tier ever contradicts a price within a family. Tiers still drive **routing** — picking a cheaper model for a simple task — which is what they were always for.
>
> The router also enforces its ceiling in dollars now. It previously applied **no** ceiling at all to any model name it didn't recognise, which could route a request that named a cheap model up to your most expensive one. That is fixed.
>
> **If you run the gateway, restart it.** The price table it loads changed, and an older gateway can't feed the new sentence — the CLI will quietly fall back to the transcript estimate until you do.
>
> All figures are estimates computed from public list prices (catalog 2026-08-06). Run `cheaper peek --json` to see every input.
>
> ```
> npm i -g cheaper@0.3.0
> cheaper peek --tagline --current
> ```

## 4b. "How we price" — `cheaper-web/web/docs.html` → new `DOCS.pricing`, mirrored to `cheaper-app/docs/pricing.md`

```js
  pricing:{title:"How we price",html:
    "<h1>How we price</h1>"+
    "<p class='lead'>Every dollar figure comes from one per-model catalog. Nothing is interpolated, averaged, or inferred from a similar model.</p>"+
    "<h2>The catalog</h2>"+
    "<p>75 models across Anthropic, OpenAI, Google, xAI, DeepSeek and Mistral. Each entry holds that model's own published list price per million tokens &mdash; input, output, cache read, cache write (5-minute and 1-hour), long-context tiers, premium-latency SKUs and dated promotional windows &mdash; transcribed by hand from the provider's own pricing page. A build step projects it into the gateway's table and the tests fail if the copies drift.</p>"+
    "<h2>The as-of date</h2>"+
    "<p>Every catalog carries a <span class='kbd'>CATALOG_AS_OF</span> date; today's is <b>2026-08-06</b>. Scheduled changes step on time by themselves &mdash; Claude Sonnet 5's launch pricing ends 2026-08-31 and the standard $3/$15 applies from 2026-09-01 automatically. Calls are priced at the rates in force <b>on the day they ran</b>, not today's rates.</p>"+
    "<h2>Fail closed</h2>"+
    "<div class='callout'>If we don't hold a published price for the exact model that ran, that call contributes <b>$0</b> and is skipped. We never price it at a similar model's rate.</div>"+
    "<p>Matching is exact after normalization, which handles only spellings that are genuinely the same model (<span class='kbd'>us.anthropic.claude-opus-5-20260101</span> &rarr; <span class='kbd'>claude-opus-5</span>). An uncatalogued model makes your total go <b>down</b>, never up &mdash; a visible zero is a bug you can report; a silently wrong rate is one nobody can see. Open-weight models (Llama, Qwen, self-hosted Mistral) have no single list price and are permanently unpriceable.</p>"+
    "<h2>Two classes of figure</h2>"+
    "<p><b>Measured</b> &mdash; the gateway was in the request path and recorded both the model requested and the model served. The delta is arithmetic over two known prices. Shown without a <span class='kbd'>~</span>.<br>"+
    "<b>Estimated</b> &mdash; computed from your local transcript. Cheaper infers the session's baseline model and assumes the cheaper calls would otherwise have run there. Shown with a <span class='kbd'>~</span>.</p>"+
    "<h2>What the baseline is</h2>"+
    "<p>The <b>priciest model your session's top-level turns ran on</b>, ranked at published rates on a fixed 1M-in / 1M-out basket at your session's own date. Fixed, because ranking on the session's own token mix would let one extra sub-task retroactively change another's credit. Dated to the session, because ranking at today's rates would move a historical figure when a promotional window expires. Ties break on the model id, so the result never depends on the order lines appear in your logs.</p>"+
    "<h2>&ldquo;Worth $X at list API rates&rdquo;</h2>"+
    "<p>Most people reading a Cheaper line are on a subscription. You are not being charged that number and we are not claiming you are. It is the <b>metered value</b> of the tokens that session moved: your tool's exact token counts &times; the public per-token price of the exact models that ran, with the cache, long-context and service-tier rules your provider would apply. On a flat-rate plan it is what you got for your fee.</p>"+
    "<p>It is <b>not your invoice</b> &mdash; we never see your invoice, and negotiated rates, credits and free tiers are invisible to us. It is <b>not a savings claim</b> &mdash; savings are a separate comparison against the baseline above.</p>"+
    "<h2>What this does not prove</h2>"+
    "<p>An estimated figure assumes you would otherwise have run that work on the baseline model. If you would have picked something cheaper yourself, your real saving is lower. Measured figures do not depend on that assumption. Some harnesses run small-model calls natively without Cheaper; where a harness tells us which calls were delegated, we credit only those.</p>"+
    "<h2>How we verify the pricing engine</h2>"+
    "<p>Monthly, we reconcile Cheaper's computed cost against our own provider invoices for the same period. Latest reconciliation: <b>&lt;DATE&gt;</b>. Computed cost tracked invoiced cost within <b>&lt;N&gt;%</b> across &lt;M&gt; account-months on &lt;LIST&gt;. Providers not covered are marked price-verified only, and we do not publish family-level savings for them. Reconciliation proves our arithmetic matches what providers bill; it does not prove the counterfactual above.</p>"+
    "<h2>Known limitations</h2>"+
    "<ul><li>List prices only. Enterprise discounts, committed-use rates and flat-rate subscriptions are not modelled.</li>"+
    "<li>Gemini context-cache <i>storage</i> ($1.00&ndash;$4.50/hour) is not attributable to a single call and is omitted.</li>"+
    "<li>Server-side tool calls are recorded but not yet priced.</li>"+
    "<li>Codex tokens are estimated from text length; its own token events are cumulative and version-fragile.</li></ul>"+
    "<h2>Corrections</h2>"+
    "<p>We have found and corrected three errors that overstated savings.<br>"+
    "<b>2026-&lt;XX&gt;</b> &mdash; a retired Opus 4 rate ($15/$75) was applied to Opus 5 work, overstating by 2.74&times;.<br>"+
    "<b>2026-&lt;XX&gt;</b> &mdash; prefix matching resolved <span class='kbd'>claude-opus-4-9</span> to <span class='kbd'>claude-opus-4</span>. Prefix inheritance was removed; unmatched models now fail closed.<br>"+
    "<b>2026-08</b> &mdash; the baseline was chosen by a capability label derived from the model's name rather than by price, and calls that cost more than the baseline were dropped instead of subtracted. Both are fixed in 0.3.0.</p>"+
    "<p>Spot a wrong price? Open a PR against <span class='kbd'>cli/src/peek/models.js</span> with the provider URL.</p>"},
```

```js
var DOC_ORDER=["overview","install","gateway","routing","pricing","config"];
```

## 4c. The savings counter — label and disclosure

**First, delete the random number generator.** `cheaper-web/web/index.html:331` is live in production:

```js
  // playful live "savings" ticker in the footer, like codeburn's cost meter
  let s=0; setInterval(()=>{ s+=Math.random()*0.9;
    document.getElementById('saved').textContent='$'+s.toFixed(2); },1200);
```

It feeds `<span id="saved">$0.00</span> saved` at `:313`, has no input, and resets on every page load. **This is the single largest exposure in either repo, and it answers Q2 by itself: a disclaimer qualifies a good-faith estimate produced by a stated method — applied to a PRNG it becomes a second misrepresentation, because "estimated" asserts an estimation process exists.** Replace `index.html:313`:

```html
    <div style="color:var(--mut);font-size:13.5px">Copyright &copy; 2026 <b style="color:var(--soft)">Own a Square</b></div>
```
and delete `index.html:330-332` entirely.

**Then, when the panel exists — the v1 counter:**

```html
<div class="counter">
  <div class="figure">Median install: <b>$38/mo</b> lower model spend</div>
  <p class="basis">Measured across 214 consented installs, 1–31 July 2026. Median, not mean
  (95% interval $29–$51). Baseline: the same work priced at each install's own session-ceiling
  model at published list rates, catalog 2026-08-06. Your result depends on your workload.
  <a class="link" href="/method">How we measure →</a></p>
</div>
```

**If an aggregate is published later**, the disclosure sits in the same visual block at comparable weight — never a footnote, hover, or link:

```
Modelled: ~$4.2M lower model spend across the install base

Not a sum of measured savings. Estimate = median per-install monthly saving measured from
214 consented installs ($38) × ~9,200 installs estimated from npm download counts × 12 months.
Known biases, all pointing the same way: npm downloads over-count installs (CI, mirrors,
npx re-fetches); consented installs are self-selected; and our estimate of how many downloads
correspond to one active user is an assumption we cannot observe, shown here at its midpoint.
Full method, inputs, assumptions and biases: cheaper.app/method   ·   Method v1, 2026-08-06.
```

**Never say:** "users have saved $X" (a factual claim about people), "$X saved this month" (a metered claim), or any figure to a precision the method cannot support. Round to three significant figures. Never tick per-second — that is a metering affordance and reads as a lie about a modelled figure. Step it when the inputs are recomputed and timestamp it.

**Fix the three calculators, which are the closest structural match in the codebase to a matter the FTC has actually charged.** `cursor-savings.html:43`, `codex-savings.html:43`, and `ai-tokens-savings-tracker.html:43` are all `var saved=s*r*0.8;` with advertiser-chosen defaults and the footnote at `:34` that 16 CFR 255.2 records as tested and ineffective. In all three:

```html
<p class="fnote">Illustrative estimate — not a prediction for your workload. Assumes routed
calls cost 80% less than your ceiling model. Basis: across 214 consented installs in July 2026,
the median routed call cost 81% less than that install's ceiling model (interquartile range
62–89%). Your mix will differ. <a class="link" href="/method">Method →</a></p>
```

Change the routine-share default from the advertiser-flattering 70% to the measured median. **Derive `0.8` from data and date it, or delete the calculator.**

**And resolve the establishment claim before anything else touches the counter.** `measured, not promised` appears at `cursor-savings.html:24`, `codex-savings.html:24`, `ai-tokens-savings-tracker.html:24` **and** `cheaper-app/README.md:24`; `A monitor, not a promise` at `index.html:193`. Those assert a level of substantiation the transcript path does not possess, and the mismatch is provable from your own MIT-licensed source. Replace all five with:

```
The gateway records the model you requested and the model it served, so gateway
figures are measured. Figures read from your local transcript are estimates and
are marked with a ~.
```

## 4d. The three tool-count strings

Three numbers, defined once and derived at render time so they cannot drift again:

- **36 — tools with documented setup.** Exactly `TOOLS.length` in `docs.html` (verified: 36 entries, ids `claude-code … gemini-native`). The last is adapter-pending, so **"documented", never "routable"**.
- **8 — harnesses `cheaper peek` detects.** Verified `HARNESSES` = `claude-code, codex, gemini, grok, opencode, copilot, pi, cursor`.
- **7 — harnesses read end to end.** Cursor is `status:'sqlite'`; `collectHarness` returns `[]`. The tagline is wired to the same 7.

**① `cheaper-web/web/docs.html:3`**
```
content="Install Cheaper, point any of 36 documented AI tools at the gateway, and watch the savings. Per-tool setup for Claude Code, Cursor, Codex, and more."
```

**② `cheaper-web/web/docs.html:65`** — derive, don't hard-code:
```html
<input class="dn-search" id="toolsearch" placeholder="Filter tools…" aria-label="Filter tools">
```
and after `toollist.innerHTML=TOOLS.map(toolItemHTML).join("");`:
```js
toolsearch.placeholder="Filter "+TOOLS.length+" tools…";
```

**③ `cheaper-web/web/index.html:220`**
```
      Supported tools — 36 documented
```

Two more surfaces publish a count and must match:

**④ `cheaper-web/web/supported-tools.html`** — append to the `<p class="lead">`:
```html
<b>36 tools have documented setup</b>: 4 via the Anthropic API, 31 via the OpenAI-compatible API,
and Google's native Gemini API, which needs an adapter and uses Gemini's OpenAI-compatible mode today.
```
and after the second `toolgrid`:
```html
<p class="fnote">The most-asked-for tools, not the full list. All <b>36</b>, each with its exact
base-URL setting, are in the <a class="link" href="docs.html">docs</a>.</p>
```

**⑤ `cheaper-app/README.md` (~:196)**
```markdown
Any tool that can point at a custom base URL routes through the gateway. **36 tools have
documented setup** — 4 via the Anthropic API, 31 via the OpenAI-compatible API, and Google's
native Gemini API via a planned adapter. The most-asked-for:
```
and under `` `peek` is a read-only, prompt-text-only scanner. Support is graded honestly: ``:
```markdown
It detects **8 harnesses** and reads chat history for **7** of them — Cursor keeps its history in a
SQLite database `peek` does not read yet, so it is reported as unreadable rather than skipped. The
end-of-chat savings line is wired to the same 7.
```
Add PI.dev to the harness table row, and fix the false pricing claim at README:90 — `"illustrative public list prices"` → `"each model's own published list price as of the catalog date (CATALOG_AS_OF)"`.

---

# 5. Ordered task list

Each item is independently verifiable. Items 1–3 are independent of everything else and should ship today.

| # | Task | Verify |
|---|---|---|
| 1 | Delete the `Math.random()` ticker: `cheaper-web/web/index.html:313` and `:330-332` | `grep -c Math.random web/index.html` → 0; footer renders with no figure |
| 2 | Replace the five `measured, not promised` / `not a promise` strings (4 web pages + README:24) | grep returns 0 hits |
| 3 | Add the illustrative caveat to `cursor-savings.html`, `codex-savings.html`, `ai-tokens-savings-tracker.html`; change defaults off 70% | Rendered page shows the caveat above the number |
| 4 | Extend `cli/scripts/sync-prices.js --check` to cover `gateway/app/*.py` ↔ `cli/assets/gateway/app/*.py` | `npm test` still green; touch one mirror → `--check` fails |
| 5 | Fix `gateway/tests/test_metrics.py::test_summary_scopes_to_a_single_session` fixture (`original_model="claude-opus-5"`, `model="claude-haiku-4-5"`) | `pytest gateway/tests/` → 23 passed |
| 6 | `pricing.py` mistral pattern += `magistral\|devstral`; add cross-runtime parity test (test 20) | `detect_family('magistral-small') == 'mistral'` in both runtimes |
| 7 | **Ship §2.1 alone:** `tier` on all 75 catalog entries + tests 1–2; rename `claude-mythos-preview` → id `claude-mythos` + alias; regen mirrors | `npm test` green, **no dollar figure moves** |
| 8 | `classify.js` catalog-first + `null` default + test 3; null-guard `scan.js:76` | test 3 green; `modelTier('some-new-model') === null` |
| 9 | Rewrite `realizedFromRecords`, `fromGateway`, `buildTagline` together + tests 4–14, 16 | 16 new tests green; all 4 existing dollar anchors hold |
| 10 | `ledger.js` signed nets + always-overwrite + `measured` count + test 15; v2 migration notice | `record(k,+10);record(k,-5)` → total −5 |
| 11 | `lifetimeSentence` split by measurement class; suppress when negative | Line reads `Lifetime: ~$418 … across 190 chats (142 measured, 48 estimated).` |
| 12 | Add `cache_read`/`cache_create_5m`/`cache_create_1h` columns to `decisions`; thread through `record()` and `app.py:218` | New rows carry cache splits; old rows read as 0 |
| 13 | `metrics.py` rewrite (both mirrors) + tests 17–19 | `saved == 12.0` not `18.0`; `sum(by_tool.calls) == total` |
| 14 | `router.py` dollar ceiling + passthrough on unrecognized | `gpt-4o-mini` + security text no longer routes to opus |
| 15 | Dashboard reads `downgraded_by_model`; keep `downgraded_by_tier` one release | Chart renders model names |
| 16 | Rename `REPRESENTATIVE` → `ROUTE_TARGET` keyed off the router map; fix xai/deepseek collapsed buckets | A haiku downgrade in xai/deepseek now shows a non-zero saving |
| 17 | Tool counts: the five edits in §4d | `grep "18 and counting"` → 0; `grep "36+"` → 0 |
| 18 | Publish `/method` (§4b) including the corrections log | Page live; three corrections listed |
| 19 | Run the **first invoice reconciliation** on your own provider accounts, one month | Dated worksheet; accuracy band recorded |
| 20 | Bump to `0.3.0`; publish release notes (§4a); `npm publish` (2FA, by hand) | `npm view cheaper version` → 0.3.0 |
| 21 | Build `cli/scripts/panel-median.js` + `cheaper panel export`; recruit panel | `panel-median` returns `{n, median, lo, hi, achieved}` |
| 22 | Publish the median-per-install figure only. **No aggregate until a denominator exists.** | Counter live with n, date, baseline, method link |

---

# 6. Decisions still requiring the founder

**Engineering — pick one, I have recommended each:**

1. **Ceiling rule.** Max-cost among top-level models on a fixed basket at the session date *(my recommendation — mechanical translation of today's documented semantics; G1 goes $24 → $84)* versus modal-by-tokens *(more conservative, reports less, but changes product semantics at the same time as a correctness fix)*. Whichever you pick goes in the `tagline.js` header comment.
2. **The `CEILING_BASKET` constant.** I specified 1M fresh in / 1M out. A cache-heavy real session ranks models on a mix that doesn't match its traffic. The alternative — rank per credited call — is more accurate per call but the printed line can then name a different baseline for different calls. I chose one named baseline. Confirm.
3. **Sub-agent credit.** My rule credits sub-agent calls when the harness supplies attribution and falls back to non-ceiling calls when it doesn't. This *excludes* Claude Code's own non-sidechain Haiku calls (title generation) from your savings claim — more honest, visibly smaller numbers for some Claude Code users. Confirm you want that.
4. **Lifetime ledger.** I specified signed nets with the sentence suppressed when the running total is negative, plus a one-time v2 reset. The alternative is a monotone floor-at-zero, which overstates. Confirm the reset.
5. **`~` versus the word "estimated".** I kept the tilde in the line and put "Estimated" in the `/method` prose and the footer block. Most users will not parse a tilde. Both, or one?
6. **Cache columns on `decisions` (task 12).** If you don't ship them, **restore the `~` on the gateway path** — a no-tilde figure computed from a minority of billed tokens is your worst claim, and it is the one you can least afford.
7. **Version.** I wrote everything as 0.3.0. `package.json` is at 0.2.5 unpublished and `changelog.html` shows only 0.1.0 — confirm whether any 0.2.x reached npm, because the changelog needs either the intervening entries or an explicit note about the gap.

**Counter and data:**

8. **Publish the median-per-install measured figure only in v1** (my recommendation) versus a modelled aggregate. The measured figure is smaller and defensible; the aggregate is larger and is not.
9. **The daily-ping denominator.** It is the single highest-value upgrade (3.9× span → 1.7×) but it turns a service-necessity request into something that also functions as analytics — and the ePrivacy Art. 5(3) exemption is **purpose**-scoped, so counting those requests for a marketing figure needs consent, not disclosure. Also note the freshness check **is not shipped today** — every HTTP reference in `src/` targets localhost. My recommendation if you want it: make the count **opt-in** and publish the opt-in rate, so the denominator is a measured lower bound rather than a census.
10. **Panel target:** 120 panelists (±27%, faster) or 250 (±16%). Given the variance decomposition, 120 is defensible and 250 buys little unless the denominator is also fixed.
11. **The npm deflator / `h`.** There is no defensible default. Pick it, publish it, publish the reasoning, and publish the figure at **both** ends of the range.
12. **Panel enrollment:** at install, at first tagline, or via an explicit `cheaper share`. This determines panel size and therefore whether the median is stable enough to publish.
13. **Which provider families you hold live spend on.** Families without own-spend must be marked price-verified-only with no family-level savings published. Name the list.
14. **The accuracy band you will commit to publicly** (e.g. "within ±3% across N account-months"). You must keep meeting it — pick a band you can hold, not the best number you have seen once.
15. **Fund the monthly invoice reconciliation** (~2 hours/month). This is the gating evidence for every public figure. Declining it means no public figure should ship.
16. **Publish the corrections log?** I recommend yes on both credibility and reasonable-basis grounds, and I have drafted it with all three entries.

**Needs actual legal counsel — I am not your lawyer:**

- **Final wording of the savings claim and the estimate disclaimer.** I have flagged the engineering exposure; the wording decision is not mine.
- **Lanham Act §43(a).** Pages named `cursor-savings.html`, `codex-savings.html` and `claude-code-savings-tracker.html` name other products in a savings claim — that is comparative advertising. A competitor need not prove consumer deception for a literally false claim and can move fast for an injunction. **More probable than FTC enforcement at your scale.** Also triggers CAP 3.33/3.35, and a trademark/affiliation question about "Cursor savings tracker".
- **US state UDAP class exposure** (California UCL/FAL/CLRA) — the realistic private-plaintiff vector.
- **Any use of these figures in investor materials.** Different regime entirely: securities-fraud territory, no "estimated" safe harbour, materially worse consequences. Get counsel *first*.
- **Whether the CLI tagline falls inside CAP Code scope** as a marketing communication versus product functionality. I have given you the conservative treatment; the scope question is genuinely arguable.
- **Panel data:** who the named controller is; whether panelists participate personally or as employees (per-day AI spend for a named developer at a named employer is, in aggregate, the *employer's* confidential financial information — most developers cannot consent on their employer's behalf, and recruiting them to export it is a tortious-interference and trade-secret exposure with a corporate plaintiff who has standing); and the direct conflict between GDPR Art. 17 erasure and the advertising-substantiation retention duty. Resolve that **in writing before publication** — pseudonymised per-panelist worksheets so the substantiation record survives erasure of the identity mapping.
- **A standing rule to write down before launch, because it will be violated by reflex during the first good week:** do not republish user savings screenshots as testimonials, in any channel. `~/.cheaper/lifetime.json` is a plain JSON file any process running as that user can edit, and republishing it attaches 16 CFR 255 endorsement duties to a number you cannot verify.

**Calibration, so none of this reads as alarmism:** an FTC action against a tool your size is unlikely. The realistic risk is that a competent engineer opens `classify.js`, finds the regex-derived tiers and the 40 price inversions, and posts that Cheaper's savings counter is fabricated. For a product whose entire value proposition is trusting its numbers, that is closer to existential than a regulator's letter. The commercial risk and the legal risk point in exactly the same direction, which is convenient: fix the engine, reconcile against your own invoice, name the baseline, publish the smaller true number.
