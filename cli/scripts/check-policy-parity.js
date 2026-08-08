#!/usr/bin/env node
'use strict';
// Cross-runtime parity gate for ROUTING POLICY — the third of the three.
//
// scripts/sync-prices.js gates the PRICES. scripts/check-period-parity.js gates the
// CALENDAR. The CLASSIFIER — the thing that actually decides which model your request
// runs on, and therefore what the product's central claim is worth — had nothing.
//
// `cli/src/peek/classify.js` is a hand-written Node port of `gateway/app/router.py`.
// Its own header said "Keep the pattern lists in lock-step with router.py", which is a
// comment, not a gate; sync-prices' parityProbes() compares only family / priceable /
// cost and never asks either runtime a routing question. So the two were free to drift,
// and they had. WHAT THE FIRST RUN OF THIS GATE MEASURED, 2026-08-08:
//
//   GATE 1  62 of 89 model ids mapped to a different tier (69.7%).
//   GATE 2  10,401 of 30,260 routing decisions disagreed (34.4%).
//
// Three root causes, all now fixed rather than excluded — a parity gate that goes green
// by narrowing what it compares is worth less than no gate at all, because it also
// certifies the narrowing:
//
//   1. THE CEILING DID NOT EXIST FOR MOST IDS. router.requested_tier() recognised a
//      model only by a 'haiku'/'sonnet'/'opus' SUBSTRING or an exact configured id, so
//      it returned None for every OpenAI, Google, Mistral, xAI and DeepSeek model plus
//      claude-fable-5 / -mythos-5 / -mythos. None means NO requested-model ceiling, which
//      is the entire content of allow_upgrade_above_requested=False. Measured: a caller
//      naming `claude-tiny-9` and asking a deadlock question was served `claude-opus-5`.
//      FIXED on the gateway side — requested_tier() now asks the catalog, via the same
//      pricing.model_tier() that classify.modelTier() is a port of.
//
//   2. peek WAS RUNNING THE DELETED CLASSIFIER. router.py replaced first-match-wins with
//      the scored STRONG/WEAK + corroboration design after measuring the old one (weak
//      domain words have incidental rates of 80-96%; the moderate band at threshold 1
//      measured ANTI-predictive). classify.js still held the flat OPUS_PATTERNS list and
//      returned on the first hit. FIXED on the CLI side — the direction is set by the
//      evidence, not by which file is easier to edit.
//
//   3. THE GATEWAY SUBSTITUTED A DIFFERENT VENDOR'S MODEL. app.py resolves /v1/messages
//      against the ANTHROPIC map for every caller and forwards to api.anthropic.com, so
//      a client sending `grok-4.3` was answered by `claude-haiku-4-5` — and SUCCEEDED,
//      where an untouched passthrough would have been rejected upstream. peek already
//      refused to do this (pricing.js picks ROUTE_TARGET_BY_TIER[family] for the row's
//      OWN family and its header says "never to a different vendor"). FIXED on the
//      gateway side, and mirrored into classify.routeDecision() so both agree.
//
// WHAT THIS GATE COMPARES, AND WHY IT IS BEHAVIOUR AND NOT A PATTERN DIFF.
// A gate that asserted "both files hold these 40 regexes" would pin today's cascade and
// would have to be rewritten the moment anyone improves it — and worse, it would pass
// while the two runtimes turned the same regex into different verdicts. So this gate
// only ever asks both runtimes THE SAME QUESTION and requires THE SAME ANSWER:
//
//   GATE 0  the defaults.     ROUTER_DEFAULTS  vs  RouterConfig()
//           Every other gate DRIVES both runtimes from one explicit set of knobs, which
//           is what makes their answers comparable — and is exactly why a divergence in
//           the defaults is invisible to them. This one compares what a user with no
//           ROUTER_* environment variables actually runs.
//   GATE 1a tier mapping.     classify.modelTier(id)  vs  pricing.model_tier(id)
//           The pure catalog answer, which both ceilings are built on.
//   GATE 1b ceiling input.    classify.requestedTier(id, map)
//                             vs  router.requested_tier({model: id}, cfg)
//           The config-aware answer, per route map, so an operator's tier -> id
//           override is exercised on both sides too.
//   GATE 2  the whole decision.  routeDecision(text, model, cfg)  vs  decide(body, cfg)
//           over a shared corpus, comparing the (tier, model) pair — including the
//           passthrough result, where tier is null. `reason` is prose and is NOT
//           compared: it is free to be reworded.
//
// THERE IS NO "GATE 3 ON THE SERVED MODEL ID", AND THAT IS A CONCLUSION, NOT AN OMISSION.
// GATE 2 already compares the served id: the `continue` below requires `d.model ===
// pyModel`, not merely the tier. It is worth writing down because the obvious diagnosis of
// the next pricing defect will be "add a gate on the model id", and it has now been wrong
// once.
//
// MEASURED 2026-08-08. estimateCall priced a same-TIER route as if no route had happened,
// so 63 substitutions in the shipped catalog booked $0.00 against $1,851.20 of real
// movement at a 1M/1M basket (and, on an input-heavy basket, hid three real anti-savings).
// Every gate stayed green through all of it, correctly:
//   * GATE 2 — both runtimes answered `opus, gpt-5.6-sol`. They AGREED. There was no
//     cross-runtime divergence to find.
//   * sync-prices.js — both runtimes price gpt-5.6-sol identically. Also agreed.
// The gap was inside peek, BETWEEN its two halves: the router named a model and the
// estimator then priced a different one. No question asked of both runtimes can see that,
// because both halves are JS — a third parity gate would have been a third green light.
//
// The invariant that catches it is a COMPOSITION one — "the dollars follow the decision" —
// and it lives in cli/test/policy_parity.test.js ('THE COMPOSITION INVARIANT'), where
// routeDecision and estimateCall can be composed directly and no interpreter is needed.
// Putting it here would have widened a script whose entire contract is "ask both runtimes
// the same question" into one that no longer states what it checks.
//
// The corpus is likewise behavioural. Beyond a fixed set of hand-written requests, it
// SAMPLES a probe string from each pattern in BOTH runtimes' cascades (best effort — a
// sample that matches nothing is still a perfectly good parity probe). That is what makes
// this survive a rewrite of router.py: a category added to Python only produces a probe
// Python escalates and JS does not, and the gate catches the one-sided change. If the
// Python lists are renamed away entirely the sampling degrades to the hand-written corpus
// and SAYS SO, rather than quietly covering less.
//
// Usage:  node scripts/check-policy-parity.js [--check]
// Exits non-zero on ANY disagreement, and on ANY failure to run the comparison.

const path = require('path');
const { spawnSync } = require('child_process');

const C = require(path.join(__dirname, '..', 'src', 'peek', 'classify.js'));
const { CATALOG } = require(path.join(__dirname, '..', 'src', 'peek', 'models.js'));
const { ROUTE_TARGET_BY_TIER } = require(path.join(__dirname, '..', 'src', 'peek', 'pricing.js'));
// THE INTERPRETER IS RESOLVED BY THE SHIPPED CODE, not by a third copy living here — the
// same rule check-period-parity.js records at length. `pyExe()` answers {cmd, args} or
// null, so a stock python.org Windows install (where only `py -3` works) is covered.
const { pyExe, PY_CANDIDATES, launcherLabel } =
  require(path.join(__dirname, '..', 'src', 'gateway.js'));
const PY_DIR = path.join(__dirname, '..', 'assets', 'gateway', 'app');

const NO_PY = `no usable Python 3 (tried: ${PY_CANDIDATES.map(launcherLabel).join(', ')})`
  + ' — the gate did not run';

// ---- the model corpus -----------------------------------------------------------
// Every catalogued id, plus ids that must resolve to NOTHING on both sides so a
// fail-open regression (either runtime inventing a tier) is caught too, plus the
// normalisation forms (vendor prefix, dated snapshot) that both runtimes claim to strip.
const MODELS = CATALOG.map((e) => e.id).concat([
  '',                                // no model named at all
  'claude-opus-4-9',                 // plausible, uncatalogued: name says opus
  // Uncatalogued models whose NAME says "cheap". This is not a corner: every model
  // released after CATALOG_AS_OF lands here, and it is where the two runtimes used to
  // part company hardest — classify.modelTier() read the name and capped the request,
  // while requested_tier() returned None AND the dollar ceiling could not help either
  // (an unpriceable model yields no ceiling), so the gateway escalated a request that
  // named a cheap model all the way to the top tier.
  'claude-tiny-9',
  'gemini-4-flash-lite',
  'grok-5-mini',
  'gpt-5.6',                         // uncatalogued sibling of a catalogued family
  'o3-deep-research',
  'llama-4-maverick',                // recognised vendor, no published price
  'qwen-3-max',
  'totally-made-up',
  'us.anthropic.claude-opus-5',      // Bedrock-style prefix
  'claude-opus-5-20260101',          // dated snapshot
  'anthropic/claude-sonnet-5',       // router-style prefix
  'CLAUDE-OPUS-5',                   // case
]);

// ---- the prompt corpus ----------------------------------------------------------
// Hand-written requests first: real shapes, not pattern echoes. These stay meaningful no
// matter how either cascade is rewritten.
const HAND_WRITTEN = [
  '',
  'hi',
  'what time is it in Tokyo?',
  'translate "good morning" into Portuguese',
  'give me a name for a cat',
  'is this deadlock-free if I take the locks in the same order everywhere?',
  'review my session cookie handling for security holes',
  'prove that this loop terminates',
  'what dosage of ibuprofen is safe for a 30kg child?',
  'does this clause make me liable if the vendor misses the deadline?',
  'refactor this module to use dependency injection',
  'write tests for the retry logic',
  'summarize this changelog',
  'first, parse the file, and then write the totals to stdout',
  'step 1 do the thing',
  'here is some code:\n```js\nconst x = 1;\n```\nwhat does it do?',
  'x'.repeat(C.LONG_REQUEST_CHARS),          // exactly at the long-request threshold
  'x'.repeat(C.LONG_REQUEST_CHARS - 1),      // exactly one char under it
  'y'.repeat(3999),
  // Adversarial: a hard-category word inside an innocuous one, which \b is there to stop.
  'who is the author of this book?',
  'the contractor arrives at noon',
  'my locker combination is 1234',
  'a threadbare rug',
  'gemini flash is mini and nano',            // cheap-signal words, no routing content
  'unlock the door',
  'atomicity',
  // Casing and punctuation, since one side compiles with re.I and the other with /i.
  'SECURITY REVIEW PLEASE',
  'Concurrency?',
  // --- the SCORED classifier's own decision surface -----------------------------
  // A single weak domain word must NOT escalate; two independent ones must; one plus a
  // nearby risk cue must. These are the three branches of _hard_signals(), and before
  // the scored classifier was ported into classify.js they were the largest single
  // source of disagreement in GATE 2.
  'the contract is on the table',                      // 1 weak domain, no cue
  'the contract mentions a thread',                    // 2 weak domains (legal+concurrency)
  'please review the contract',                        // 1 weak domain + risk cue
  'proof',                                             // the 96%-incidental word, bare
  'diagnos',                                           // stem-only, no boundary after
  'a tax question about a medical bill',               // money+medical
  // Exactly ONE moderate signal (must stay haiku at min_moderate_signals=2) and exactly
  // TWO (must reach sonnet). The single-signal cases are where a threshold that drifts
  // by one shows up first.
  'summarize',
  'summarize and then debug it',
  '```\nfenced only\n```',
  // Non-ASCII. Python's \w and \b are Unicode-aware by default and JavaScript's are
  // ASCII-only, so `é` is a word character on one side and a word BOUNDARY on the other.
  // Every one of these puts a non-ASCII character where a \b has to be decided.
  'élock the door',
  'naïve deadlock in the café',
  'sécurité review',
  'ロック security review',
  'contract 🔒 audit',
  'thread audit',                                 // non-breaking space
];

// Best-effort probe string for one regex source. It does not have to match — an
// unmatched probe is still a valid parity question ("do both runtimes say haiku?").
// It only has to be DERIVED from the pattern, so a pattern present on one side only
// produces an input the two runtimes answer differently.
function sampleFromPattern(src) {
  let s = String(src);
  s = s.replace(/\(\?[im]+\)/g, '');
  s = s.replace(/\\b/g, '');
  // (?:a|b)?  and  (a|b)?  -> the first alternative
  s = s.replace(/\(\?:([^()|]*)(?:\|[^()|]*)*\)\??/g, '$1');
  s = s.replace(/\(([^()|]*)(?:\|[^()|]*)*\)\??/g, '$1');
  s = s.replace(/\[\^?(.)[^\]]*\]/g, '$1');   // [sz] -> s, [- ] -> -
  s = s.replace(/\\d/g, '1');
  s = s.replace(/\\s/g, ' ');
  s = s.replace(/\.\*/g, ' something ');
  s = s.replace(/\\(.)/g, '$1');              // \. -> .
  s = s.replace(/[?*+]/g, '');
  return s.trim();
}

// The CO-OCCURRENCE WINDOW is an arithmetic boundary, and an off-by-one in either
// runtime's flank arithmetic is invisible to every other probe in this file. Python
// searches `text[m.end():m.end()+window]`; JS searches `text.slice(end, end + window)`.
// So a risk cue whose LAST character lands exactly on the window edge must corroborate,
// and one that overruns it by a single character must not.
//
// `word + ' '.repeat(k) + 'audit'` puts 'audit' at [end+k, end+k+5). With
// k = window - 5 it is wholly inside the slice; with k = window - 4 the slice cuts it to
// 'audi', which matches no risk cue. Both are emitted, and both runtimes must agree on
// both — which is a stronger statement than "they agree the rule exists".
function windowProbes(word, window) {
  return [
    `${word}${' '.repeat(Math.max(0, window - 5))}audit`,   // last char ON the edge
    `${word}${' '.repeat(Math.max(0, window - 4))}audit`,   // one char OVER the edge
  ];
}

function jsPatternSources() {
  // Optional introspection: classify.js exports its lists, but a rewrite may not.
  //
  // `declaredSource` FIRST. classify.js compiles each pattern into a Unicode-aware form
  // (`\b` -> a `[\p{L}\p{N}_]` lookaround), so `.source` is the COMPILED text and would
  // sample probes like "(?<![\p{L}\p{N}_])deadlock" — a string neither runtime's patterns
  // were written against. `declaredSource` is the literal router.py also holds, which is
  // the whole point of sampling from both sides.
  const out = [];
  const push = (r) => {
    if (!r) return;
    out.push(r.declaredSource || (r.source ? r.source : String(r)));
  };
  for (const g of [C.STRONG_PATTERNS, C.SONNET_PATTERNS, C.MULTISTEP_PATTERNS]) {
    if (Array.isArray(g)) for (const r of g) push(r);
  }
  if (C.WEAK_GROUPS && typeof C.WEAK_GROUPS === 'object') {
    for (const k of Object.keys(C.WEAK_GROUPS)) {
      const g = C.WEAK_GROUPS[k];
      if (Array.isArray(g)) for (const r of g) push(r);
    }
  }
  push(C.RISK_CUE_RE);
  return out;
}

// ---- python side ----------------------------------------------------------------
// One process answers everything: its own pattern sources (so JS can build probes from
// them), the GATE 1 tier maps, and the GATE 2 decisions.
//
// THE NAMES READ HERE ARE THE ONES router.py REALLY USES. They were `_OPUS_PATTERNS` /
// `_SONNET_PATTERNS` / `_MULTISTEP_PATTERNS`, and `_OPUS_PATTERNS` had already been
// split into `_STRONG_PATTERNS` + `_WEAK_GROUPS` — so `getattr(..., None)` quietly
// returned nothing for it and the gate sampled 17 patterns where it believed it sampled
// 40. The `sources: 0 from router.py` warning below exists because of that: a rename
// must DEGRADE LOUDLY, never silently narrow the corpus.
const PY_SOURCES = `
import json, sys
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
import router
out = []
for name in ('_STRONG_PATTERNS', '_SONNET_PATTERNS', '_MULTISTEP_PATTERNS'):
    got = getattr(router, name, None)
    if got:
        out.extend([str(p) for p in got])
groups = getattr(router, '_WEAK_GROUPS', None)
if groups:
    for _g, _ps in groups.items():
        out.extend([str(p) for p in _ps])
cue = getattr(router, '_RISK_CUE_PATTERN', None)
if cue:
    out.append(str(cue))
print(json.dumps(out))
`;

const PY_ANSWERS = `
import json, sys
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
import pricing
from router import RouterConfig, decide, requested_tier
payload = json.loads(sys.stdin.read())
maps = payload['maps']
cfgs = payload['cfgs']
model_ids = payload['model_ids']

# GATE 0 -- the DEFAULTS. Every other gate here drives both runtimes from one explicit
# set of knobs, which is what makes them comparable -- and which is exactly why a
# divergence in the DEFAULTS is invisible to them. A gateway started with no environment
# overrides runs RouterConfig()'s values while peek runs ROUTER_DEFAULTS, so a default
# that drifts affects every user while every driven decision still agrees.
_d = RouterConfig()
defaults = {
    'long_request_chars': _d.long_request_chars,
    'min_tier': _d.min_tier,
    'allow_upgrade_above_requested': _d.allow_upgrade_above_requested,
    'min_hard_domains': _d.min_hard_domains,
    'min_moderate_signals': _d.min_moderate_signals,
    'cooccurrence_window': _d.cooccurrence_window,
    'models': dict(_d.models),
}

# GATE 1a -- the pure catalog answer, config-free.
catalog_tier = {m: pricing.model_tier(m) for m in model_ids}

def _cfg(spec, models):
    c = RouterConfig()
    c.models = models
    c.allow_upgrade_above_requested = spec['allow_upgrade_above_requested']
    c.min_tier = spec['min_tier']
    c.long_request_chars = spec['long_request_chars']
    c.min_hard_domains = spec['min_hard_domains']
    c.min_moderate_signals = spec['min_moderate_signals']
    c.cooccurrence_window = spec['cooccurrence_window']
    return c

# GATE 1b -- the config-aware ceiling input, once per route map.
ceiling = []
for mi, mp in enumerate(maps):
    c = _cfg(cfgs[0], mp['models'])
    ceiling.append([requested_tier({'model': m}, c) for m in model_ids])

decisions = []
for bi, (ci, mi) in enumerate(payload['combos']):
    cfg = _cfg(cfgs[ci], maps[mi]['models'])
    for pi, text in enumerate(payload['prompts']):
        for xi, model in enumerate(model_ids):
            body = {'model': model, 'messages': [{'role': 'user', 'content': text}]}
            d = decide(body, cfg)
            decisions.append([bi, pi, xi, d.tier, d.model])
print(json.dumps({'defaults': defaults, 'catalog_tier': catalog_tier,
                  'ceiling': ceiling, 'decisions': decisions}))
`;

function runPy(py, script, input) {
  const r = spawnSync(py.cmd, [...py.args, '-c', script],
    { input: input || '', encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.status === 0) return JSON.parse(r.stdout);
  // The launcher already answered `--version`, so it EXISTS: anything failing now is the
  // module blowing up, and that IS a failure, not a skip.
  console.error(`  policy parity FAILED (${launcherLabel(py)}):`);
  console.error(((r.stderr || '') + String(r.error || '')).trim());
  return null;
}

// ---- the configs both runtimes are driven through -------------------------------
// Each one turns on a rule `peek` used to have no counterpart for at all. The last four
// drive the SCORED classifier's knobs, which are RouterConfig fields app.py exposes as
// environment variables — a gateway tuned off-default and a `peek` hardcoded to the
// defaults is the exact defect `long_request_chars` already had, and there are three
// more knobs now.
const CFGS = [
  { label: 'default (heuristic, ceiling on, min_tier=haiku)',
    allow_upgrade_above_requested: false, min_tier: 'haiku',
    long_request_chars: C.LONG_REQUEST_CHARS, min_hard_domains: C.MIN_HARD_DOMAINS,
    min_moderate_signals: C.MIN_MODERATE_SIGNALS,
    cooccurrence_window: C.COOCCURRENCE_WINDOW },
  { label: 'ROUTER_MIN_TIER=sonnet',
    allow_upgrade_above_requested: false, min_tier: 'sonnet',
    long_request_chars: C.LONG_REQUEST_CHARS, min_hard_domains: C.MIN_HARD_DOMAINS,
    min_moderate_signals: C.MIN_MODERATE_SIGNALS,
    cooccurrence_window: C.COOCCURRENCE_WINDOW },
  { label: 'ROUTER_ALLOW_UPGRADE=true (both ceilings disabled)',
    allow_upgrade_above_requested: true, min_tier: 'haiku',
    long_request_chars: C.LONG_REQUEST_CHARS, min_hard_domains: C.MIN_HARD_DOMAINS,
    min_moderate_signals: C.MIN_MODERATE_SIGNALS,
    cooccurrence_window: C.COOCCURRENCE_WINDOW },
  { label: 'ROUTER_LONG_CHARS=2000',
    allow_upgrade_above_requested: false, min_tier: 'haiku',
    long_request_chars: 2000, min_hard_domains: C.MIN_HARD_DOMAINS,
    min_moderate_signals: C.MIN_MODERATE_SIGNALS,
    cooccurrence_window: C.COOCCURRENCE_WINDOW },
  { label: 'min_hard_domains=1 (any single weak domain escalates)',
    allow_upgrade_above_requested: false, min_tier: 'haiku',
    long_request_chars: C.LONG_REQUEST_CHARS, min_hard_domains: 1,
    min_moderate_signals: C.MIN_MODERATE_SIGNALS,
    cooccurrence_window: C.COOCCURRENCE_WINDOW },
  { label: 'min_moderate_signals=1 (the pre-scoring sonnet band)',
    allow_upgrade_above_requested: false, min_tier: 'haiku',
    long_request_chars: C.LONG_REQUEST_CHARS, min_hard_domains: C.MIN_HARD_DOMAINS,
    min_moderate_signals: 1, cooccurrence_window: C.COOCCURRENCE_WINDOW },
  { label: 'cooccurrence_window=8 (the flank arithmetic, at a tiny radius)',
    allow_upgrade_above_requested: false, min_tier: 'haiku',
    long_request_chars: C.LONG_REQUEST_CHARS, min_hard_domains: C.MIN_HARD_DOMAINS,
    min_moderate_signals: C.MIN_MODERATE_SIGNALS, cooccurrence_window: 8 },
  // A TYPO IN ROUTER_MIN_TIER. app.py reads it straight from the environment with no
  // validation, and router.py's _rank() raises ValueError on a tier it does not know —
  // so this used to be a 500 on every request while `peek` clamped and estimated a
  // working router. Both clamp now, and this config is what keeps them clamping.
  { label: "ROUTER_MIN_TIER='sonett' (typo — must CLAMP, not crash)",
    allow_upgrade_above_requested: false, min_tier: 'sonett',
    long_request_chars: C.LONG_REQUEST_CHARS, min_hard_domains: C.MIN_HARD_DOMAINS,
    min_moderate_signals: C.MIN_MODERATE_SIGNALS,
    cooccurrence_window: C.COOCCURRENCE_WINDOW },
];

// ---- the route maps both runtimes are driven through ----------------------------
// app.py picks the map by FRONT-END, not by the caller's model: /v1/messages resolves
// against the Anthropic map and /v1/chat/completions against OPENAI_MODELS. So every
// map must be driven over the WHOLE model corpus, which is what exercises the vendor
// guard in both directions (a Claude id against the OpenAI map, and every other vendor's
// id against the Anthropic map).
const MAPS = [
  { label: 'anthropic targets (/v1/messages)', models: ROUTE_TARGET_BY_TIER.anthropic },
  { label: 'openai targets (/v1/chat/completions)', models: ROUTE_TARGET_BY_TIER.openai },
  { label: 'xai targets', models: ROUTE_TARGET_BY_TIER.xai },
  // An operator who has deliberately pointed ROUTER_MODEL_* across vendors. The vendor
  // guard must NOT fire here: a mixed map carries no single-vendor claim to protect, and
  // refusing on the operator's behalf would break a configuration they chose on purpose.
  { label: 'MIXED map (operator ROUTER_MODEL_* override across vendors)',
    models: { haiku: 'claude-haiku-4-5', sonnet: 'gpt-5.4', opus: 'claude-opus-5' } },
  // A map naming a model no family pattern recognises — the other way `mapFamily()`
  // answers null. Both runtimes must fall through to the ordinary rules.
  { label: 'UNRECOGNISED-target map',
    models: { haiku: 'totally-made-up', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5' } },
];

// Which (config, map) pairs actually run. The full cross product is 40 combinations and
// buys almost nothing: the config knobs act on the CONTENT tier and the maps act on the
// vendor guard and the dollar ceiling, so they are close to independent. Every config is
// exercised on the front-end map that ships, and every map is exercised on the default
// config.
const COMBOS = [];
for (let ci = 0; ci < CFGS.length; ci++) COMBOS.push([ci, 0]);
for (let mi = 1; mi < MAPS.length; mi++) COMBOS.push([0, mi]);

// ---- NAMED, COUNTED EXCLUSIONS --------------------------------------------------
// A residual class the gate deliberately does not compare must be declared HERE, with a
// reason, and it is reported with its hit count on every run. That is the only shape of
// exclusion this file accepts: an exclusion that cannot be counted is indistinguishable
// from a bug, and one that is not printed grows silently.
//
// The list is EMPTY, and that is the measured outcome, not an aspiration — all three
// root causes above were fixed rather than scoped away, and the run prints
// "exclusions: none" so the mechanism stays visible.
const EXCLUSIONS = [
  // { id: 'short-name', why: 'one line', match: ({prompt, model, cfg, map}) => boolean },
];

// The SHAPE of a disagreement, with concrete model ids abstracted to their ROLE.
//
// This used to interpolate the model id, which SHATTERED one root cause into one shape
// per model: the vendor-substitution class showed up as twenty separate "23x" lines
// ("js=null/grok-4.3 vs haiku/claude-haiku-4-5", "js=null/mistral-medium-3.5 vs ...")
// and read like twenty small problems instead of one large one. It is worth more than
// cosmetics — the head of a shape-sorted list is what a reader diagnoses from, and an
// over-specific key puts the wrong thing at the top.
function role(tier, model, requestedModel, map) {
  if (tier === null || tier === undefined) {
    return model === String(requestedModel || '') ? 'passthrough(requested)'
      : `passthrough('${model}')`;
  }
  return model === map[tier] ? `${tier}:target` : `${tier}:'${model}'`;
}

function main(argv) {
  for (const a of (argv || [])) {
    // `--check` is accepted for symmetry with the other two gates, which have a
    // report-only mode this one does not need (it never writes anything). An unknown
    // flag EXITS rather than being ignored: a typo'd flag in a CI line must not look
    // like a passing gate.
    if (a !== '--check') {
      console.error(`policy parity: unknown argument '${a}' (usage: [--check])`);
      return 2;
    }
  }

  const py = pyExe();
  if (!py) {
    // A parity gate that silently does not run is decoration, but a missing interpreter
    // is not a routing defect. Say so loudly and exit non-zero so CI cannot mistake an
    // unrun gate for a passing one.
    console.error(`policy parity: DID NOT RUN — ${NO_PY}`);
    return 1;
  }

  const pySources = runPy(py, PY_SOURCES);
  if (pySources === null) return 1;
  const jsSources = jsPatternSources();
  const probes = new Set(HAND_WRITTEN);
  for (const src of jsSources.concat(pySources)) {
    const s = sampleFromPattern(src);
    if (s) probes.add(s);
  }
  // The code fence is a literal in both runtimes rather than a listed pattern.
  probes.add('```\nx\n```');
  // Window-boundary probes, built from the weak-domain words BOTH runtimes actually
  // hold, at each cooccurrence_window the configs drive.
  const weakWords = new Set();
  if (C.WEAK_GROUPS) {
    for (const k of Object.keys(C.WEAK_GROUPS)) {
      const w0 = C.WEAK_GROUPS[k][0];
      const s = sampleFromPattern(w0.declaredSource || w0.source);
      if (s) weakWords.add(s);
    }
  }
  for (const w of ['contract', 'thread', 'security']) weakWords.add(w);
  for (const w of weakWords) {
    for (const win of new Set(CFGS.map((c) => c.cooccurrence_window))) {
      for (const p of windowProbes(w, win)) probes.add(p);
    }
  }
  const prompts = [...probes];

  const nDecisions = prompts.length * MODELS.length * COMBOS.length;
  console.log(`policy parity corpus: ${prompts.length} prompts × ${MODELS.length} models`
    + ` × ${COMBOS.length} (config, map) combinations = ${nDecisions} decisions`);
  console.log(`  probe sources: ${jsSources.length} from classify.js, `
    + `${pySources.length} from router.py`
    + (pySources.length ? '' : ' (router.py pattern lists NOT introspectable —'
        + ' coverage degraded to the hand-written corpus)'));

  const answers = runPy(py, PY_ANSWERS, JSON.stringify({
    maps: MAPS.map((m) => ({ label: m.label, models: m.models })),
    model_ids: MODELS, prompts, cfgs: CFGS, combos: COMBOS,
  }));
  if (answers === null) return 1;

  let failures = 0;
  const excluded = new Map(EXCLUSIONS.map((e) => [e.id, 0]));
  function isExcluded(row) {
    for (const e of EXCLUSIONS) {
      if (e.match(row)) { excluded.set(e.id, excluded.get(e.id) + 1); return true; }
    }
    return false;
  }

  // ---- GATE 0: the DEFAULTS ------------------------------------------------------
  // Every gate below drives both runtimes from ONE explicit set of knobs, which is what
  // makes their answers comparable — and is precisely why a divergence in the defaults
  // is invisible to them. A gateway started with no ROUTER_* variables runs
  // RouterConfig()'s values and `peek` runs ROUTER_DEFAULTS', so a default that drifts
  // hits every user while all the driven decisions still agree. This gap was found by
  // mutating router.py's `min_moderate_signals` default and watching the gate pass; the
  // mutation test in test/policy_parity.test.js keeps it found.
  const D = C.ROUTER_DEFAULTS;
  const defaultPairs = [
    ['long_request_chars', D.longRequestChars, answers.defaults.long_request_chars],
    ['min_tier', D.minTier, answers.defaults.min_tier],
    ['allow_upgrade_above_requested', D.allowUpgradeAboveRequested,
      answers.defaults.allow_upgrade_above_requested],
    ['min_hard_domains', D.minHardDomains, answers.defaults.min_hard_domains],
    ['min_moderate_signals', D.minModerateSignals, answers.defaults.min_moderate_signals],
    ['cooccurrence_window', D.cooccurrenceWindow, answers.defaults.cooccurrence_window],
  ];
  // The tier -> model id default is the same question three tables used to answer
  // independently, so it is compared as a whole rather than knob by knob.
  const jsModels = ROUTE_TARGET_BY_TIER.anthropic;
  for (const t of C.TIERS) {
    defaultPairs.push([`models.${t}`, jsModels[t], answers.defaults.models[t]]);
  }
  const defRows = defaultPairs.filter(([, js, p]) => js !== p);
  if (defRows.length) {
    console.error(`\nGATE 0 — DEFAULTS: ${defRows.length} of ${defaultPairs.length}`
      + ' differ between an un-overridden gateway and an un-overridden peek');
    for (const [k, js, p] of defRows) {
      console.error(`  ${k.padEnd(30)} classify.js=${JSON.stringify(js)}`
        + `   router.py=${JSON.stringify(p)}`);
    }
    console.error('  FIX: these are the values a user with no ROUTER_* environment'
      + ' variables actually runs. They must be the same number in both files.');
    failures += defRows.length;
  } else {
    console.log(`GATE 0 — DEFAULTS: ${defaultPairs.length} un-overridden values agree`);
  }

  // ---- GATE 1a: the pure catalog tier map ----------------------------------------
  // classify.modelTier() and pricing.model_tier() are two ports of one function, and
  // BOTH ceilings are built on top of them. If these disagree nothing below can be
  // trusted, so it is checked first and separately from the config-aware answer.
  const catRows = [];
  for (const id of MODELS) {
    const js = C.modelTier(id);
    const raw = answers.catalog_tier[id];
    const p = raw === undefined ? null : raw;
    if (js !== p) catRows.push([id, js, p]);
  }
  if (catRows.length) {
    console.error(`\nGATE 1a — CATALOG TIER: ${catRows.length} of ${MODELS.length}`
      + ` ids disagree (${((catRows.length / MODELS.length) * 100).toFixed(1)}%)`);
    for (const [id, js, p] of catRows) {
      console.error(`  ${String(id || '(none)').padEnd(28)} classify.modelTier=`
        + `${String(js)}   pricing.model_tier=${String(p)}`);
    }
    console.error('  FIX: pricing.py::model_tier and classify.js::modelTier are ports of'
      + ' one another — catalog first, then the CHEAP/TOP name signals, then null. Bring'
      + ' the two back in step; do NOT add a special case to one side.');
    failures += catRows.length;
  } else {
    console.log(`GATE 1a — CATALOG TIER: ${MODELS.length} ids agree`);
  }

  // ---- GATE 1b: the config-aware ceiling input -----------------------------------
  let ceilRows = 0;
  for (let mi = 0; mi < MAPS.length; mi++) {
    const rows = [];
    for (let xi = 0; xi < MODELS.length; xi++) {
      const id = MODELS[xi];
      const js = C.requestedTier(id, MAPS[mi].models);
      const raw = answers.ceiling[mi][xi];
      const p = raw === undefined ? null : raw;
      if (js !== p) rows.push([id, js, p]);
    }
    if (!rows.length) continue;
    console.error(`\nGATE 1b — CEILING INPUT [${MAPS[mi].label}]: ${rows.length} of `
      + `${MODELS.length} ids disagree`);
    for (const [id, js, p] of rows) {
      console.error(`  ${String(id || '(none)').padEnd(28)} classify.requestedTier=`
        + `${String(js)}   router.requested_tier=${String(p)}`);
    }
    ceilRows += rows.length;
  }
  if (ceilRows) {
    console.error('  FIX: both must be (1) the catalog tier, (2) the operator\'s own'
      + ' tier -> id map for an id the catalog misses, (3) null. null means NO'
      + ' requested-model ceiling is applied — it is never a harmless "don\'t know".');
    failures += ceilRows;
  } else {
    console.log(`GATE 1b — CEILING INPUT: ${MODELS.length} ids agree across all `
      + `${MAPS.length} route maps`);
  }

  // ---- GATE 2: the whole decision ------------------------------------------------
  const byCombo = COMBOS.map(() => []);
  for (const [bi, pi, xi, pyTier, pyModel] of answers.decisions) {
    const [ci, mi] = COMBOS[bi];
    const map = MAPS[mi].models;
    const d = C.routeDecision(prompts[pi], MODELS[xi], {
      models: map,
      allowUpgradeAboveRequested: CFGS[ci].allow_upgrade_above_requested,
      minTier: CFGS[ci].min_tier,
      longRequestChars: CFGS[ci].long_request_chars,
      minHardDomains: CFGS[ci].min_hard_domains,
      minModerateSignals: CFGS[ci].min_moderate_signals,
      cooccurrenceWindow: CFGS[ci].cooccurrence_window,
    });
    const jsTier = d.tier === undefined ? null : d.tier;
    const p = pyTier === undefined ? null : pyTier;
    if (jsTier === p && d.model === pyModel) continue;
    const row = { prompt: prompts[pi], model: MODELS[xi],
      cfg: CFGS[ci].label, map: MAPS[mi].label,
      js: [jsTier, d.model], py: [p, pyModel] };
    if (isExcluded(row)) continue;
    byCombo[bi].push(row);
  }
  const total = byCombo.reduce((n, rows) => n + rows.length, 0);
  if (total) {
    console.error(`\nGATE 2 — ROUTING DECISION: ${total} of `
      + `${answers.decisions.length} decisions disagree`);
    // Group by the SHAPE of the disagreement across every combination first, so the
    // reader sees root causes ranked by size rather than one block per config.
    const all = new Map();
    for (let bi = 0; bi < COMBOS.length; bi++) {
      for (const r of byCombo[bi]) {
        const map = MAPS[COMBOS[bi][1]].models;
        const k = `${role(r.js[0], r.js[1], r.model, map)}  vs  `
          + `${role(r.py[0], r.py[1], r.model, map)}`;
        if (!all.has(k)) all.set(k, { n: 0, ex: r, combos: new Set() });
        const e = all.get(k);
        e.n++;
        e.combos.add(bi);
      }
    }
    console.error(`  ${all.size} distinct disagreement SHAPE(s), largest first:`);
    for (const [k, v] of [...all].sort((a, b) => b[1].n - a[1].n)) {
      const p = v.ex.prompt.length > 48 ? v.ex.prompt.slice(0, 45) + '...' : v.ex.prompt;
      console.error(`    ${String(v.n).padStart(6)}x  js=${k}`);
      console.error(`            in ${v.combos.size} of ${COMBOS.length} combinations;`
        + ` e.g. model='${v.ex.model}' prompt=${JSON.stringify(p)}`);
      console.error(`            cfg=[${v.ex.cfg}] map=[${v.ex.map}]`);
    }
    console.error('  per combination:');
    for (let bi = 0; bi < COMBOS.length; bi++) {
      if (!byCombo[bi].length) continue;
      const [ci, mi] = COMBOS[bi];
      console.error(`    ${String(byCombo[bi].length).padStart(6)}  `
        + `cfg=[${CFGS[ci].label}] map=[${MAPS[mi].label}]`);
    }
    failures += total;
  } else {
    console.log(`GATE 2 — ROUTING DECISION: ${answers.decisions.length} decisions agree`);
  }

  // Exclusions are reported on EVERY run, passing or failing, and a declared exclusion
  // that never fires is reported too — a stale exclusion is a claim about the code that
  // has quietly stopped being true.
  if (!EXCLUSIONS.length) {
    console.log('exclusions: none — every decision in the corpus is compared');
  } else {
    console.log(`exclusions: ${EXCLUSIONS.length} declared`);
    for (const e of EXCLUSIONS) {
      console.log(`  ${String(excluded.get(e.id)).padStart(6)}x  ${e.id} — ${e.why}`);
    }
  }

  if (failures) {
    console.error(`\n${failures} policy parity failure(s). DO NOT make this green by`
      + ' relaxing the comparison — the two runtimes really do route differently, and'
      + " every disagreement above is an estimate that describes a router the user's"
      + ' gateway is not running.');
    return 1;
  }
  console.log('routing policy is in sync across both runtimes');
  return 0;
}

// `main` RETURNS the exit code instead of calling process.exit itself, so a test can
// drive it in-process and assert the code. The wrapper is what maps it onto the real
// process — a gate wired into `npm test` that always exits 0 is not a gate, and the
// only way to know is to check.
if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main };
