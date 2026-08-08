'use strict';
// Faithful Node port of the gateway's routing classifier (gateway/app/router.py).
// `peek` reuses the exact same decision logic the live gateway applies, so the
// "what you could have saved" estimate matches what Cheaper would really do:
//   - cheapest tier by default,
//   - auto-escalate hard categories (concurrency, security, proofs, ...) to the top,
//   - NEVER route above the model the caller actually requested (a ceiling),
//   - NEVER answer with a different vendor's model than the caller named.
//
// "KEEP THE PATTERN LISTS IN LOCK-STEP WITH router.py" USED TO BE THIS FILE'S ENTIRE
// GUARANTEE, AND IT WAS A COMMENT, NOT A GATE. The two runtimes drifted a whole
// classifier generation apart under it: router.py replaced first-match-wins with the
// scored STRONG/WEAK design and this file did not follow, so `peek` reported savings for
// a router nobody was running. scripts/check-policy-parity.js is the gate that replaces
// the comment — it asks BOTH runtimes the same routing question over a shared corpus and
// requires the same (tier, model) answer. Change either side and run it.

// models.js has no dependencies of its own, so this cannot create a require cycle.
const { resolveModel } = require('./models');

// Tier ordering: index is the rank (higher = more CAPABLE — never "more expensive").
// Capability rank and price rank genuinely disagree in this catalog, so nothing that
// computes dollars may use these ranks; see the note on CATALOG in models.js.
const TIERS = ['haiku', 'sonnet', 'opus'];
function rank(tier) { return TIERS.indexOf(tier); }

// --- Category signals -------------------------------------------------------
// THIS BLOCK IS THE SCORED CLASSIFIER, PORTED FROM router.py's _STRONG_PATTERNS /
// _WEAK_GROUPS / _RISK_CUE_PATTERN. It replaces a FIRST-MATCH-WINS cascade
// (`OPUS_PATTERNS`, one flat list, return on the first hit) that this file kept for a
// full generation after the gateway deleted it.
//
// WHY THE PYTHON SIDE IS THE ONE THAT WAS RIGHT — this is not a coin flip between two
// ports, and the direction of the fix is evidence-led:
//
//   * router.py's own header records the measurement that removed first-match-wins:
//     escalated traffic matched SEVERAL patterns at once, so every individual false
//     positive looked free to keep and the set was untunable; dropping the four
//     most-suspected patterns recovered 1.28% of spend, and reaching 31.6% needed 17 of
//     39 patterns deleted. Returning on the first match is what hid that.
//   * the bare domain words have MEASURED incidental rates of 80-96% (proof 96.0%,
//     thread 89.4%, diagnos 86.8%, security 80.2%). Under first-match-wins, one of them
//     anywhere in the text pinned the request to the top tier.
//   * the moderate band measured ANTI-predictive at a threshold of 1 (sonnet-routed
//     turns did LESS work than haiku-routed ones); at 2 the ordering comes back the
//     right way up.
//
// So `peek` was estimating against a router nobody runs, and it did so in the expensive
// direction: the old cascade called "my locker combination is 1234" an auto-escalate
// correctness-critical request, armed the quality floor on it, and then reported the
// resulting passthrough as the gateway's behaviour.
//
// The split is by how much weight ONE match can carry:
//
//   STRONG — multiword or unambiguous technical terms. One match is enough. Nobody
//   writes "SQL injection" or "ABA problem" in passing.
//
//   WEAK — bare domain words. They escalate only with corroboration: either
//   `minHardDomains` independent DOMAINS fire, or the word appears within
//   `cooccurrenceWindow` characters of a risk cue (the "domain noun + risk verb" shape).
//
// Grouping is by domain so that "thread" + "lock" (both concurrency) counts ONCE:
// corroboration has to be independent to mean anything.
// --- \b AND \w ARE NOT THE SAME CHARACTER CLASS IN THE TWO RUNTIMES ---------
// Python's `\w` and `\b` are UNICODE-AWARE for `str` patterns; JavaScript's are
// ASCII-ONLY. So `é` is a word character to Python and a word BOUNDARY to JavaScript,
// and `/\block\b/i` finds "lock" inside "élock" in Node while `re.compile(r"\block\b")`
// does not. That is not a curiosity — it is the exact false positive `\b` was added to
// prevent ("auth" must not fire on "author"), reappearing for every language that spells
// with accents, and it flips a request from the cheap tier to the top tier.
//
// MEASURED by scripts/check-policy-parity.js on its first run after the scored
// classifier was ported: 24 disagreements from this alone, e.g. "élock the door"
// classified opus by JS and haiku by Python.
//
// `uword()` compiles each pattern with Python's semantics instead: `\b` becomes an
// explicit Unicode word-boundary lookaround and `\w` becomes `[\p{L}\p{N}_]`, which is
// what CPython's SRE_UNI_IS_WORD (isalnum or underscore) resolves to for all but a
// handful of numeric-valued oddities. For pure-ASCII text the compiled form is
// character-for-character equivalent to the original, so nothing about the common case
// changes.
//
// The declared source is preserved on each compiled regex, so the reason strings and the
// parity gate's probe sampler still see the SAME literal router.py holds — a transformed
// source in a reason string would read like a different pattern set.
const UNICODE_WORD = '[\\p{L}\\p{N}_]';

function toUnicodeWordSource(src) {
  let s = src;
  const lead = s.startsWith('\\b');
  if (lead) s = s.slice(2);
  const trail = s.endsWith('\\b');
  if (trail) s = s.slice(0, -2);
  if (s.includes('\\b')) {
    // A `\b` anywhere but the two ends cannot be rewritten by inspection, and silently
    // leaving it ASCII would put the divergence back exactly where it is hardest to see.
    throw new Error(`classify.js: interior \\b in /${src}/ — extend toUnicodeWordSource()`);
  }
  s = s.split('\\w').join(UNICODE_WORD);
  if (lead) s = `(?<!${UNICODE_WORD})` + s;
  if (trail) s += `(?!${UNICODE_WORD})`;
  return s;
}

function uword(rgx) {
  const flags = rgx.flags.includes('u') ? rgx.flags : rgx.flags + 'u';
  const re = new RegExp(toUnicodeWordSource(rgx.source), flags);
  // Non-enumerable so it never leaks into a JSON dump of a pattern list.
  Object.defineProperty(re, 'declaredSource', { value: rgx.source });
  return re;
}

const STRONG_PATTERNS = [
  // concurrency
  /\brace condition\b/i, /\bdeadlock\b/i, /\bmutex\b/i, /\bsemaphore\b/i,
  /\baba problem\b/i, /\block[- ]free\b/i, /\bmemory[- ]order/i,
  // security
  /\bsql injection\b/i, /\bxss\b/i, /\bcsrf\b/i, /\bvulnerab/i, /\bexploit\b/i,
  /\bsanitiz/i,
  // verification
  /\bprove that\b/i, /\bprovably\b/i, /\bformal(?:ly)? (?:correct|verif)/i,
  // irreversible / high-stakes
  /\bproduction outage\b/i, /\birreversible\b/i, /\bdistributed system/i,
  /\bdosage\b/i,
].map(uword);

// Insertion order is load-bearing: router.py iterates `_WEAK_GROUPS.items()`, which is
// its literal order, and the reason strings name the first matching pattern per domain.
// A JS object literal with string keys preserves insertion order, so the two agree.
const WEAK_GROUPS = {
  concurrency: [/\bconcurren(?:t|cy)\b/i, /\bthread(?:s|ing|-safe)?\b/i,
                /\block(?:s|ing)?\b/i, /\batomic(?:s|ity)?\b/i],
  security: [/\bsecurity\b/i, /\bcrypto(?:graph)?/i,
             /\bauth(?:entication|orization)\b/i],
  verification: [/\bproof\b/i, /\binvariant\b/i],
  legal: [/\blegal(?:ly)?\b/i, /\bcontract\b/i, /\bliab(?:le|ility)\b/i, /\bregulat/i],
  money: [/\bfinanc(?:e|ial)\b/i, /\btax(?:es|ation)?\b/i],
  medical: [/\bmedical\b/i, /\bdiagnos/i],
  architecture: [/\barchitect(?:ure|ing)?\b/i, /\bconsensus\b/i, /\bsharding\b/i],
};
for (const g of Object.keys(WEAK_GROUPS)) WEAK_GROUPS[g] = WEAK_GROUPS[g].map(uword);

// The "risk verb" half of the co-occurrence rule: what someone is DOING to the domain
// noun that makes being wrong expensive.
const RISK_CUE_RE = uword(new RegExp(
  '\\b(?:audit|review|safe|unsafe|secure|insecure|correct|incorrect|verify|'
  + 'guarantee|ensure|prevent|harden|threat|attack|breach|corrupt|leak|bypass|'
  + 'race|fail|break|bug|risk|violat|compliance|exploit|inject|escalat|privileg)\\w*',
  'i'));

const SONNET_PATTERNS = [
  /\brefactor\b/i, /\bimplement\b/i, /\bpaginat/i, /\bendpoint\b/i, /\bmigrat/i,
  /\bsummar(?:ize|y)\b/i, /\banalyz/i, /\bdebug\b/i, /\bwrite tests?\b/i,
  /\bunit test/i, /\bintegrat(?:e|ion)\b/i, /\balgorithm\b/i, /\boptimi[sz]e\b/i,
].map(uword);
// Multi-step / dense signals that nudge from haiku up to sonnet.
const MULTISTEP_PATTERNS = [
  /\bstep \d\b/i, /\bfirst,.*then\b/i, /\band then\b/i, /\bafterwards?\b/i,
].map(uword);
const CODE_FENCE = /```/;
const LONG_REQUEST_CHARS = 4000;

// Tuning knobs, mirroring RouterConfig's (router.py). Exported so a caller can drive
// BOTH runtimes from one set of numbers instead of two copies of the defaults.
const MIN_HARD_DOMAINS = 2;       // independent weak domains needed to escalate together
const MIN_MODERATE_SIGNALS = 2;   // independent moderate signals needed for the sonnet band
const COOCCURRENCE_WINDOW = 120;  // chars, for the "domain noun + risk verb" rule

// A `g`-flagged twin of a pattern, for the match-position scan `riskCueNear` needs.
// Cached rather than rebuilt per call, and kept SEPARATE from the `.test()` regexes:
// a global RegExp carries `lastIndex` across calls, so sharing one object between
// `.test()` and iteration silently skips matches on every other call.
const _GLOBAL_TWIN = new Map();
function globalTwin(rgx) {
  let g = _GLOBAL_TWIN.get(rgx);
  if (!g) {
    g = new RegExp(rgx.source, rgx.flags.includes('g') ? rgx.flags : rgx.flags + 'g');
    _GLOBAL_TWIN.set(rgx, g);
  }
  g.lastIndex = 0;
  return g;
}

// Astral characters — anything outside the Basic Multilingual Plane, which in practice
// means emoji — are ONE character to Python and TWO to JavaScript. Detected by the
// presence of a high surrogate, which is the only way a JS string can encode one.
const HAS_ASTRAL = /[\uD800-\uDBFF]/;

// True when a risk cue sits within `window` chars of a match of `rgx`.
//
// The matched term itself is excluded from the scan (the two flanks are searched
// separately), so a domain word can never corroborate itself.
//
// `window` IS COUNTED IN CHARACTERS, WHICH MEANS CODE POINTS. Python slices strings by
// code point and JavaScript slices them by UTF-16 code unit, so an emoji inside the
// window consumes one unit of budget on one side and two on the other. MEASURED by
// scripts/check-policy-parity.js: "contract 🔒 audit" at cooccurrence_window=8
// corroborates in Python (the cue is wholly inside the 8-character flank) and does not
// in JavaScript (the lock glyph eats two of the eight, cutting "audit" to "audi") — 24
// disagreements from this one difference.
//
// The conversion is skipped entirely for text with no astral character, which is the
// overwhelming majority: for BMP-only text the two indexings are identical, so the fast
// path is exactly the arithmetic that was here before and costs nothing extra.
function riskCueNear(text, rgx, window) {
  const g = globalTwin(rgx);
  const astral = HAS_ASTRAL.test(text);
  // Code points, and a map from UTF-16 offset -> code-point offset. Built once per call,
  // and only when it can change an answer.
  let cps = null;
  let cpAt = null;
  if (astral) {
    cps = Array.from(text);
    cpAt = new Int32Array(text.length + 1);
    let u = 0;
    for (let k = 0; k < cps.length; k++) {
      const w = cps[k].length;          // 1, or 2 for a surrogate pair
      cpAt[u] = k;
      if (w === 2) cpAt[u + 1] = k;     // an offset INSIDE a pair maps to its own code point
      u += w;
    }
    cpAt[text.length] = cps.length;
  }
  let m;
  while ((m = g.exec(text)) !== null) {
    const u16Start = m.index;
    const u16End = m.index + m[0].length;
    let before;
    let after;
    if (astral) {
      const start = cpAt[u16Start];
      const end = cpAt[u16End];
      before = cps.slice(Math.max(0, start - window), start).join('');
      after = cps.slice(end, Math.min(cps.length, end + window)).join('');
    } else {
      before = text.slice(Math.max(0, u16Start - window), u16Start);
      after = text.slice(u16End, Math.min(text.length, u16End + window));
    }
    if (RISK_CUE_RE.test(before) || RISK_CUE_RE.test(after)) return true;
    // A zero-width match would spin forever; every pattern here consumes at least one
    // character, but the guard costs nothing and the alternative is a hung CLI.
    if (m[0].length === 0) g.lastIndex++;
  }
  return false;
}

// EVERY auto-escalate signal in the text, not the first one. Collecting all of them is
// what makes the pattern set tunable at all — under first-match-wins a redundant false
// positive was invisible in any measurement and deleting it changed nothing.
function hardSignals(text, cfg) {
  const sigs = [];
  for (const rgx of STRONG_PATTERNS) {
    // `declaredSource`, not `source`: the reason must name the pattern as router.py
    // spells it, not as uword() compiled it.
    if (rgx.test(text)) sigs.push(`unambiguous risk term /${rgx.declaredSource}/`);
  }
  // One hit per DOMAIN: two words from the same domain are one signal, not two.
  const domains = [];
  for (const group of Object.keys(WEAK_GROUPS)) {
    for (const r of WEAK_GROUPS[group]) {
      if (r.test(text)) { domains.push([group, r]); break; }
    }
  }
  if (domains.length >= cfg.minHardDomains) {
    sigs.push('independent risk domains: ' + domains.map(([g]) => g).join('+'));
  } else {
    // Too few domains to corroborate each other, so fall back to the other form of
    // corroboration: the domain noun has to be near a risk verb.
    for (const [group, r] of domains) {
      if (riskCueNear(text, r, cfg.cooccurrenceWindow)) {
        sigs.push(`${group} term /${r.declaredSource}/ next to a risk cue`);
      }
    }
  }
  return sigs;
}

// Every mid-tier signal in the text. Same all-signals rule as hardSignals().
function moderateSignals(text, cfg) {
  const sigs = [];
  for (const r of SONNET_PATTERNS) if (r.test(text)) sigs.push(`/${r.declaredSource}/`);
  if (text.length >= cfg.longRequestChars) {
    sigs.push(`long/dense request (${text.length} chars)`);
  }
  if (CODE_FENCE.test(text)) sigs.push('contains code block');
  if (MULTISTEP_PATTERNS.some((r) => r.test(text))) sigs.push('multi-step request');
  return sigs;
}

// Resolve the classifier knobs from a partial opts object. Every knob mirrors a
// RouterConfig field that app.py exposes as an environment variable, so a gateway
// configured off-default and `peek` must be driven from the same numbers — that is the
// same defect `longRequestChars` already had, generalised to the other three.
function classifierCfg(opts) {
  const o = opts || {};
  const num = (v, dflt) => (Number.isFinite(v) ? v : dflt);
  return {
    longRequestChars: num(o.longRequestChars, LONG_REQUEST_CHARS),
    minHardDomains: num(o.minHardDomains, MIN_HARD_DOMAINS),
    minModerateSignals: num(o.minModerateSignals, MIN_MODERATE_SIGNALS),
    cooccurrenceWindow: num(o.cooccurrenceWindow, COOCCURRENCE_WINDOW),
  };
}

// Tier implied by the request content alone (ignoring the requested model).
//
// `hard` marks an AUTO-ESCALATE classification — a correctness-critical category, not
// merely a busy one. It is what arms the quality floor in routeDecision(): a hard
// request may be refused a downgrade, where a merely-long one may not. It is
// deliberately NOT the same thing as "tier === 'opus'", because the requested-model
// ceiling can cap an auto-escalate request down to a lower tier while the floor still
// has to stop the dollar ceiling cutting further.
function contentTier(text, opts) {
  const t = text || '';
  const cfg = classifierCfg(opts);
  const hard = hardSignals(t, cfg);
  if (hard.length) {
    return { tier: 'opus', reason: 'auto-escalate: ' + hard.slice(0, 3).join('; '), hard: true };
  }
  const mod = moderateSignals(t, cfg);
  if (mod.length >= cfg.minModerateSignals) {
    return { tier: 'sonnet', reason: 'moderate task signals: ' + mod.slice(0, 3).join('; '), hard: false };
  }
  return { tier: 'haiku', reason: 'simple/short request', hard: false };
}

// Map an arbitrary model id back to a coarse capability tier (haiku|sonnet|opus).
// This is what "the model the caller actually used" resolves to, so the ceiling
// can be applied. Cheap signals win over top signals (e.g. "o3-mini" is cheap).
// Word-boundaried so "mini" doesn't fire inside "geMINI", etc.
//
// THESE TWO ARE DELIBERATELY NOT PUT THROUGH uword(), unlike every content pattern
// above. Their Python twins live in `pricing.py::CHEAP_SIGNALS / TOP_SIGNALS` — a file
// whose whole contract is to be a regex-for-regex mirror of this one — and running only
// the JS side through the Unicode rewrite would CREATE the divergence the rewrite exists
// to remove. The input here is a model id, not user prose: ids are ASCII by construction
// (they are URL path and JSON field values chosen by providers), so the two classes are
// equivalent over everything either function is ever asked. GATE 1a in
// scripts/check-policy-parity.js compares the two answers over the whole corpus; if a
// non-ASCII id ever becomes real, change BOTH files together.
const CHEAP_SIGNALS =/(\bhaiku|\bmini\b|\bnano\b|\bflash\b|\blite\b|\bsmall\b|\binstant\b|\b8b\b|\b7b\b|\b3b\b|\btiny\b|\bmicro\b|\bembed)/i;
const TOP_SIGNALS = /(\bopus|\bultra\b|[-\s]pro\b|\breasoner\b|\bthinking\b|\bo1\b|\bo3\b|\bo4\b|\b405b\b|\b72b\b|\blarge\b|grok-4|grok-3\b|deepseek-r1|\bqwq\b)/i;

function modelTier(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (!m) return null;
  // Catalog first: a tier reviewed alongside the price beats a guess from the name.
  const entry = resolveModel(modelId);
  if (entry && entry.tier) return entry.tier;
  // Name signals are a fallback for models we hold no catalog entry for.
  if (CHEAP_SIGNALS.test(m)) return 'haiku';
  if (TOP_SIGNALS.test(m)) return 'opus';
  // Fail CLOSED. This used to return 'sonnet', which silently asserted mid capability
  // for every unrecognized model — 22 of 75 catalog entries reached it, and so does
  // every model released after CATALOG_AS_OF. null means "we cannot show a cheaper
  // model would do", so the caller passes the request through untouched instead of
  // routing on an invented capability claim.
  return null;
}

// The effective tier Cheaper WOULD have used: the cheaper of (content tier, the
// model actually used). Never upgrades above what the caller asked for.
function effectiveTier(text, actualModel) {
  const content = contentTier(text);
  const actual = modelTier(actualModel);
  if (actual == null) return { ...content, capped: false, actualTier: null };
  if (rank(content.tier) > rank(actual)) {
    return { tier: actual, reason: content.reason + `; capped to used model '${actual}'`, capped: true, actualTier: actual };
  }
  return { ...content, capped: false, actualTier: actual };
}

// ---------------------------------------------------------------------------
// THE REST OF THE ROUTER — the parts `peek` used to leave out.
//
// effectiveTier() above models exactly ONE of the gateway's five routing rules (the
// requested-model ceiling). The live router also applies, in order:
//
//   0. THE VENDOR GUARD      a request naming vendor X is never answered with vendor Y's
//                            model; it passes through instead. See the block on it in
//                            routeDecision().
//   1. triage mode           ROUTER_MODE=triage replaces the heuristic content tier with
//                            a live cheap-model verdict (app.py:208-225, 482-483).
//   2. the requested ceiling effectiveTier()'s rule.
//   3. min_tier              ROUTER_MIN_TIER raises anything below the floor
//                            (router.py:199-201).
//   4. allow_upgrade_...     ROUTER_ALLOW_UPGRADE=true disables 2 AND 5 entirely
//                            (router.py:193, 213). It does NOT disable rule 0: the
//                            vendor guard is a correctness rule, and an operator who
//                            opted into paying more did not thereby opt into being
//                            answered by a different company's model.
//   5. THE DOLLAR CEILING    if the tier's configured model costs more per unit than the
//                            model the caller asked for, walk DOWN the tiers until one
//                            is no more expensive; if none is, PASS THROUGH and route
//                            nothing at all (router.py:203-228).
//
// AND ONE RULE THAT IS NOT IN THIS FUNCTION AT ALL, because it is not a decision — it is
// whether decide() is reached:
//
//   -1. IS THERE AN ENDPOINT?  The gateway rewrites `body["model"]` on exactly two paths,
//                            /v1/messages (app.py:491, Anthropic) and
//                            /v1/chat/completions (app.py:812, OpenAI). Traffic for any
//                            other vendor falls to the catch-all proxy (app.py:1151),
//                            which relays the request — including POSTs — verbatim and
//                            never touches `body["model"]`. decide() is never called, so
//                            no rule below runs and no dollar moves.
//                            routeDecision() deliberately does NOT model this: it answers
//                            "what would the router decide", which is a well-formed
//                            question for a Gemini request even though no Gemini request
//                            ever reaches it. pricing.js::ROUTABLE_FAMILIES carries the
//                            endpoint fact and scan.js keeps the unreachable vendors out
//                            of the headline. Putting it here instead would collapse
//                            "the router refused" and "the router was never asked" into
//                            one passthrough, and those need different remedies.
//
// Rules 3-5 are the ones that change the estimate's DIRECTION, and peek modelled none of
// them, so its number described a router that does not exist:
//
//   * missing min_tier  -> peek reports haiku-tier savings on a gateway configured with
//                          ROUTER_MIN_TIER=sonnet, which never routes that low.
//                          OVERSTATES.
//   * missing dollar    -> peek books a downgrade the gateway refuses. Both directions:
//     ceiling              it OVERSTATES the saving whenever the walk-down lands on a
//                          costlier-than-requested target, and it OVERSTATES the
//                          anti-saving (`extra`) whenever the gateway would have passed
//                          through and spent nothing extra at all.
//   * missing passthrough-> the same, in its most visible form: peek shows a dollar
//                          movement on a request the gateway declines to touch.
//   * missing upgrade   -> with ROUTER_ALLOW_UPGRADE=true the gateway may route ABOVE
//     flag                 the requested model. peek's ceiling makes that structurally
//                          unrepresentable, so it UNDERSTATES the spend.
//   * missing triage    -> unmodelable offline by construction: the verdict comes from a
//                          live model call. peek keeps the heuristic and this is the one
//                          gap that cannot be closed here; see the note on `triageTier`.
//
// routeDecision() is a faithful port of router.decide(), so `peek` and the gateway can be
// asked the same question and made to agree — that is what scripts/check-policy-parity.js
// checks. It is deliberately a PORT, not a second router: the shape, the order of the
// rules, and the passthrough result all mirror router.py line for line.

// The fixed basket two models' unit costs are compared on. Same value and same rationale
// as router.py's _RANK_BASKET (1M in / 1M out): ranking on the live request's own token
// mix would make the decision depend on the request, so a long prompt could unlock an
// escalation a short one cannot.
const CEILING_BASKET = { inFresh: 1000000, outTok: 1000000 };

// Defaults mirroring RouterConfig (router.py:87-104). `models` is resolved lazily so the
// default follows ROUTE_TARGET rather than being copied here — a fourth copy of "which
// model does tier X mean" is the exact defect this file's parity gate exists to catch.
const ROUTER_DEFAULTS = {
  models: null,
  allowUpgradeAboveRequested: false,
  longRequestChars: LONG_REQUEST_CHARS,
  minTier: 'haiku',
  minHardDomains: MIN_HARD_DOMAINS,
  minModerateSignals: MIN_MODERATE_SIGNALS,
  cooccurrenceWindow: COOCCURRENCE_WINDOW,
  // A live triage verdict, when the caller has one. peek cannot produce it (it would
  // need a model call per historical row), so peek passes nothing and gets the
  // heuristic — which is what ROUTER_MODE=heuristic, the default, also does.
  triageTier: null,
};

// pricing.js requires THIS module at load time, so a top-level require would be a cycle.
// Deferred to call time, when both modules are fully initialised.
function pricing() { return require('./pricing'); }

// The tier the CEILING is applied at, for a caller who named `requestedModel`.
//
// Two steps, and the ORDER is the whole point:
//   1. the catalog / name signals (modelTier) — a tier reviewed alongside the price.
//   2. the operator's own tier -> id map. An id the operator has DECLARED to be their
//      sonnet tier is sonnet even when the catalog has never heard of it; that
//      declaration is better evidence than anything a regex could recover from the name.
// Then FAIL CLOSED. `null` means "no requested-model ceiling is available", never
// "the ceiling passed" — the dollar ceiling is what carries the invariant from there.
//
// This mirrors router.requested_tier() exactly, which is a change of direction on the
// PYTHON side: that function used to recognise a model only by a haiku/sonnet/opus
// SUBSTRING or an exact configured id, which returned None for 62 of the 89 ids this
// file's parity gate drives — every OpenAI, Google, Mistral, xAI and DeepSeek model,
// plus claude-fable-5 / -mythos-5 / -mythos. See the note on that function.
function requestedTier(requestedModel, models) {
  const t = modelTier(requestedModel);
  if (t != null) return t;
  const m = String(requestedModel || '').toLowerCase();
  if (!m) return null;
  for (const tier of TIERS) {
    const mid = models && models[tier];
    if (mid && m === String(mid).toLowerCase()) return tier;
  }
  return null;
}

// The single vendor a tier -> id map serves, or null when it does not have one.
//
// null covers two distinct cases and both must fall through to "no vendor claim":
// a map naming a model no family pattern recognises, and a map an operator has
// deliberately MIXED across vendors (which is an explicit opt-in to cross-vendor
// serving and therefore not something to refuse on their behalf).
function mapFamily(models) {
  let fam = null;
  for (const tier of TIERS) {
    const f = pricing().detectFamily(models && models[tier]);
    if (!f) return null;
    if (fam === null) fam = f;
    else if (fam !== f) return null;
  }
  return fam;
}

function unitCost(modelId) {
  if (!modelId) return null;
  try {
    const c = pricing().costOfModel(String(modelId), CEILING_BASKET);
    return Number.isFinite(c) ? c : null;
  } catch (_e) {
    // Mirrors router.py's `except Exception: return None` — an unpriceable model means
    // "no dollar ceiling available", never "the ceiling passed".
    return null;
  }
}

function defaultModels() {
  return pricing().ROUTE_TARGET_BY_TIER.anthropic;
}

// The gateway's routing decision for one request, offline.
//   text           the routable request text (router.py's extract_text() output)
//   requestedModel the model id the caller asked for ('' / null when unknown)
//   cfg            see ROUTER_DEFAULTS
// Returns { tier, model, reason }. `tier` is null for a PASSTHROUGH: Cheaper declined to
// route and the caller's own model is used unchanged.
function routeDecision(text, requestedModel, cfg) {
  const c = Object.assign({}, ROUTER_DEFAULTS, cfg || {});
  const models = c.models || defaultModels();
  // An unknown min_tier is CLAMPED, not fatal. router.py's _rank() used to raise
  // ValueError here, which turned a typo in ROUTER_MIN_TIER into a 500 on every request;
  // both runtimes now clamp, and router.py records the same reasoning.
  const minTier = TIERS.indexOf(c.minTier) >= 0 ? c.minTier : 'haiku';

  // --- THE VENDOR GUARD -----------------------------------------------------
  // Cheaper routes DOWN within one vendor's lineup. It does not answer a request that
  // named vendor X with vendor Y's model, and this is the rule that says so.
  //
  // WHY THIS IS A CORRECTNESS RULE AND NOT A PRICING ONE. Every other rule in this
  // function trades dollars against capability, and the caller consented to that trade
  // by pointing their base URL here. Swapping the VENDOR is a different thing: the
  // caller receives a model from a company they did not name, with different training,
  // different tool-use semantics, a different context window and a different data
  // agreement. No amount of saving makes that the request they sent.
  //
  // The concrete harm is on the gateway, measured: app.py's /v1/messages front-end
  // rewrites `body["model"]` and forwards to api.anthropic.com, so a client that sent
  // `grok-4.3` used to be answered by `claude-haiku-4-5` — and the call SUCCEEDED,
  // where an untouched passthrough would have been rejected upstream as an unknown
  // model. A silent success is the worst possible signal: a harness comparing vendors
  // through Cheaper would have measured Claude for every one of them.
  //
  // This file already refused to do it on the estimate side — pricing.js picks
  // ROUTE_TARGET_BY_TIER[family] for the row's OWN family and its header says "never to
  // a different vendor" — so peek and the gateway disagreed about whether the product
  // even substitutes vendors. It does not, now, on either side.
  //
  // The guard is deliberately narrow. It fires only when BOTH families are known and
  // they differ; an unrecognised model id, or an operator's deliberately mixed map,
  // yields no vendor claim and falls through to the rules below unchanged.
  const reqFamily = pricing().detectFamily(requestedModel);
  const servedFamily = mapFamily(models);
  if (reqFamily && servedFamily && reqFamily !== servedFamily) {
    return {
      tier: null,
      model: String(requestedModel || ''),
      reason: `requested model is a '${reqFamily}' model and this route map serves`
        + ` '${servedFamily}' -- cross-vendor substitution refused, passthrough`,
    };
  }

  let tier, reason, hard;
  if (TIERS.indexOf(c.triageTier) >= 0) {
    tier = c.triageTier;
    reason = 'cheap-model triage verdict';
    // A live model saying "opus" means what the auto-escalate patterns mean, and it is
    // strictly better evidence than a regex, so it arms the same floor.
    hard = c.triageTier === 'opus';
  } else {
    const ct = contentTier(text, c);
    tier = ct.tier;
    reason = ct.reason;
    hard = !!ct.hard;
  }

  // THE QUALITY FLOOR — the tier below which this request must not be served, no matter
  // what the money says. Only an auto-escalate classification raises it above min_tier;
  // for everything else a downgrade is the entire point of the product.
  //
  // Without it, the dollar walk-down below runs all the way to haiku, which is how a
  // caller on claude-sonnet-5 got served haiku for 100% of their traffic INCLUDING their
  // security and concurrency questions. Buying a money invariant with a quality breach is
  // the one trade this product must never make. peek needs the floor for the same reason
  // in reverse: without it, peek books savings from downgrades the gateway refuses, and
  // the ones it refuses are precisely the expensive requests where the claimed saving is
  // largest.
  let floor = hard ? tier : minTier;

  // The requested-model ceiling. `requestedTier()` is the catalog-first answer, and
  // router.requested_tier() now computes the SAME thing: the substring-only test that
  // used to live there returned None for 62 of the 89 ids this file's parity gate
  // drives, so the ceiling — the entire meaning of allow_upgrade_above_requested=false —
  // simply did not exist for them. Measured consequence: a caller naming `claude-tiny-9`
  // and asking a deadlock question was served `claude-opus-5`, an upgrade, with upgrades
  // disabled, because neither ceiling could see the model.
  const req = requestedTier(requestedModel, models);
  if (req != null && !c.allowUpgradeAboveRequested) {
    if (rank(tier) > rank(req)) {
      reason = `${reason}; capped to requested '${req}' (upgrades disabled)`;
      tier = req;
    }
    // The floor drops with the cap, and only here. A caller who explicitly names a cheap
    // model has CONSENTED to that model's quality for their request; honouring that is
    // not the router trading quality for money, it is the router doing as it was told.
    // What the floor still forbids is cutting BELOW the caller's own choice unprompted.
    //
    // MEASURED: this line is currently UNREACHABLE-BY-EFFECT, and it is kept anyway.
    // `floor` is only ever raised to `tier` itself, and `tier` is capped to `req` on the
    // line above, so floor and req arrive here equal in every case the cap fires; the
    // min_tier re-raise below undoes the only other path. A mutation that deletes it
    // changes no test (proved). It stays because it is a line-for-line port of
    // router.py's decide(), and a port that silently drops a rule because the rule is
    // presently inert is exactly how these two files drifted apart in the first place —
    // the next change to `floor` on EITHER side would make it live again on only one.
    if (rank(floor) > rank(req)) floor = req;
  }

  // The min_tier floor.
  if (rank(tier) < rank(minTier)) {
    reason = `${reason}; raised to min_tier '${minTier}'`;
    tier = minTier;
  }
  if (rank(floor) < rank(minTier)) floor = minTier;

  // The DOLLAR ceiling. Tier rank stands in badly for money now that capability rank and
  // price rank disagree across the catalog (Mistral's flagship undercuts its mid model;
  // the sonnet target gemini-3.5-flash bills input above the opus-tier gemini-2.5-pro).
  const reqCost = unitCost(requestedModel);
  if (reqCost != null && !c.allowUpgradeAboveRequested) {
    const candCost = unitCost(models[tier]);
    if (candCost != null && candCost > reqCost) {
      // THE WALK-DOWN STOPS AT THE QUALITY FLOOR. (When floor === tier the slice is
      // empty by construction, so a hard request that cannot afford its own tier passes
      // through rather than being answered one tier down.)
      let landed = null;
      for (const t of TIERS.slice(rank(floor), rank(tier)).reverse()) {
        const cc = unitCost(models[t]);
        if (cc != null && cc <= reqCost) { landed = t; break; }
      }
      if (landed == null) {
        // Nothing configured is both cheaper AND at or above the quality floor. Passing
        // through is the honest move: routing here would either raise the bill while
        // claiming to lower it, or lower it by answering a correctness-critical request
        // on a model we just said was too weak.
        return {
          tier: null,
          model: String(requestedModel || ''),
          reason: `${reason}; no configured model is both cheaper than requested and`
            + ` at/above the '${floor}' quality floor -- passthrough`,
        };
      }
      reason = `${reason}; dollar ceiling: ${models[landed]} costs <= requested`;
      tier = landed;
    }
  }

  return { tier, model: models[tier], reason };
}

module.exports = {
  TIERS, rank, contentTier, modelTier, requestedTier, mapFamily, effectiveTier,
  LONG_REQUEST_CHARS, MIN_HARD_DOMAINS, MIN_MODERATE_SIGNALS, COOCCURRENCE_WINDOW,
  routeDecision, ROUTER_DEFAULTS, CEILING_BASKET,
  // Exported for scripts/check-policy-parity.js, which samples probe text from BOTH
  // runtimes' pattern lists so a pattern added to only one side is caught. The gate
  // treats these as OPTIONAL introspection (see its note), never as the thing under
  // test — it compares tier verdicts, not pattern text.
  //
  // OPUS_PATTERNS IS GONE ON PURPOSE. It was the flat first-match-wins list; keeping it
  // as an alias for STRONG_PATTERNS would have let the gate keep sampling a name that no
  // longer describes anything, and would have hidden the WEAK groups (whose corroboration
  // rule is where the two runtimes are hardest to keep in step) from the probe corpus
  // entirely.
  STRONG_PATTERNS, WEAK_GROUPS, RISK_CUE_RE, SONNET_PATTERNS, MULTISTEP_PATTERNS,
};
