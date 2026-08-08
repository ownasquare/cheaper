---
name: adaptive-model-router
description: >-
  Run each request on the cheapest model that will actually get it right, and pay
  for a stronger one only when the request genuinely needs it. Use this whenever
  the user wants tiered / adaptive / cost-aware model selection, "use the cheapest
  model that works", automatic model switching, token or cost savings on routing,
  or a "triage first, escalate if needed" workflow. Trigger on phrases like
  "pick the model automatically", "don't waste Opus on easy stuff", "only use the
  big model when needed", "route by complexity", or "save tokens by using a
  smaller model first". Also use this when spawning subagents / delegating subtasks
  and you want each spawned agent sized to its subtask's difficulty ("which model
  should each agent use", "size the agents by task", "don't spawn everything on
  Opus", per-subtask or multi-agent model selection). The tiers are Haiku
  (cheapest), then Sonnet (mid), then Opus (most capable).
---

# Adaptive Model Router

## What this does and why

The goal is simple: **spend the fewest tokens that still get a correct, complete
answer.** Most requests don't need the most powerful model. A lot of them ("what's
this file's line count", "rephrase this sentence", "what does this error mean")
are handled perfectly by the cheapest model. Sending those to a top-tier model
burns tokens for no quality gain.

So the job is to **decide, per request, what the cheapest sufficient tier is** —
and then get the work onto that tier without spending more on the getting-there
than the tier saves. Those are two separate problems, and the second one is where
this skill used to lose money. Read the next two sections before running anything.

### Important mechanical note (read this)

A skill can't reach into this running session and swap the model powering the
main loop — the model you're reading this on is fixed for the session. What this
skill *can* do is route the actual work to a model of the right size by spawning
a **subagent** with an explicit `model` override (via the Agent tool). That
subagent runs on the chosen tier, does the work, and hands its result back. So
"switching models" here means "delegating the work to a subagent on the right
tier."

**But the boundary between you and that subagent is not free, and the toll is
charged at the session model's rate.** You are the orchestrator; everything you
do is billed at the session price, *including the act of delegating*:

- Authoring the Agent-tool prompt is **OUTPUT** from the session model — and the
  request is re-emitted into it verbatim, so you pay the top-tier output rate for
  text you already had.
- Reading the subagent's result back is **INPUT** at the session rate.
- Relaying that result to the user is **OUTPUT** at the session rate again.

So every delegation pays a fixed **boundary tax** before the cheaper worker has
saved a single token, and the tax scales with the size of the prompt and the
answer. That is the whole reason the rule below is what it is.

Keep the main-loop reasoning minimal. Every sentence you reason about the *content*
of the request in the main loop is spent at the session's model price. But note
that "minimal" is not "zero": deciding a tier is a one-line classification over
text you already have, and doing that in-loop is far cheaper than paying the
boundary tax to have someone else do it. Delegate *work*; decide *tiers* yourself.

### What delegation actually costs (the arithmetic, so you can check it)

Rates below are this product's own catalog (`cli/src/peek/models.js`), in dollars
per million tokens. Substitute your own if the catalog moves; the shape of the
conclusion does not depend on the exact figures.

| Tier | Model | Input $/Mtok | Output $/Mtok |
|------|-------|--------------|---------------|
| haiku | `claude-haiku-4-5` | 1 | 5 |
| sonnet | `claude-sonnet-4-5` | 3 | 15 |
| opus | `claude-opus-4-6` | 5 | 25 |

Worked example, all four numbers stated up front so the sum is checkable: an Opus
session, a **2,000**-token request, an **1,100**-token answer, a **500**-token
triage contract prepended to the triage prompt, and a **100**-token verdict.

**Baseline — the session model just answers it:**
2,000 × $5/M + 1,100 × $25/M = $0.0100 + $0.0275 = **$0.0375**

**One "cheap" Haiku triage pass:**

| Leg | Tokens × rate | Cost |
|-----|---------------|------|
| you author the Agent prompt (request + contract) | 2,500 out × $25/M | $0.0625 |
| Haiku reads it and returns a verdict | 2,500 in × $1/M + 100 out × $5/M | $0.0030 |
| you read the verdict back | 100 in × $5/M | $0.0005 |
| **triage pass total** | | **$0.0660** |

An earlier version of this document called that "almost nothing" — because it
counted only the middle row, Haiku's own $0.0030. The pass costs **22x** that
($0.0660 ÷ $0.0030), and **1.76x** the cost of simply answering the request
outright ($0.0660 ÷ $0.0375). A step whose entire purpose is to save money costs
76% more than the thing it is deciding about, before any work is done.

**The full three-rung ladder** (Haiku triage → escalate to Sonnet → re-escalate to
Opus), same numbers, notes assumed negligible:

| # | Leg | Cost |
|---|-----|------|
| 1 | author triage prompt (2,500 out × $25/M) | $0.0625 |
| 2 | Haiku triages (2,500 in × $1/M + 100 out × $5/M) | $0.0030 |
| 3 | read verdict (100 in × $5/M) | $0.0005 |
| 4 | author Sonnet prompt (2,000 out × $25/M) | $0.0500 |
| 5 | Sonnet solves (2,000 in × $3/M + 1,100 out × $15/M) | $0.0225 |
| 6 | read Sonnet's answer (1,100 in × $5/M) | $0.0055 |
| 7 | author Opus prompt (2,000 out × $25/M) | $0.0500 |
| 8 | Opus solves (2,000 in × $5/M + 1,100 out × $25/M) | $0.0375 |
| 9 | read Opus's answer (1,100 in × $5/M) | $0.0055 |
| 10 | relay the answer to the user (1,100 out × $25/M) | $0.0275 |
| | **total** | **$0.2645** |

$0.2645 ÷ $0.0375 = **7.05x the direct cost.** And the ladder's *best* case still
loses: if Haiku answers on the first pass (`HANDLED`, nothing escalates), you pay
$0.0625 + $0.0030 + $0.0055 + $0.0275 = **$0.1035**, or **2.76x** direct — because
the answer crosses the boundary twice at the session rate no matter who wrote it.

**The break-even rule.** Write `o_in`/`o_out` for the orchestrator's rates,
`w_in`/`w_out` for the worker's, `P` for the prompt, `A` for the answer, and `W`
for the worker's **private churn** — everything it reads, runs and drafts that
never crosses back to you (file contents, tool output, its own intermediate
reasoning). Setting `direct = delegated` and solving for `W`:

```
direct    = P·o_in  + W·o_in + A·o_out
delegated = P·o_out + (P+W)·w_in + A·w_out + A·o_in + A·o_out

W · (o_in − w_in) = P · (o_out + w_in − o_in) + A · (w_out + o_in)
```

For an Opus session delegating to Haiku with the numbers above:
`W × (5−1) = 2,000 × (25+1−5) + 1,100 × (5+5)` → `4W = 42,000 + 11,000` →
**W = 13,250 tokens**. To Sonnet instead: **W = 34,000 tokens**. And when the
worker is not cheaper on input than you are (same tier, or a pricier one),
`o_in − w_in ≤ 0` and **there is no break-even at all** — that delegation cannot
save money on any input, only isolate context.

**So: delegation pays only when the subagent's private churn far exceeds the
prompt and answer that cross the boundary.** Genuine fan-out research — a worker
that reads twenty files, runs a dozen tools, and hands back a paragraph — clears
13,250 tokens easily, and clears it N times over when you fan out. A triage pass
has `W ≈ 0`: it reads your prompt and writes a verdict. It can never break even.
Delegate *reading*, not *writing*.

## The tiers

| Tier | Model (Agent `model` value) | Use for |
|------|------------------------------|---------|
| 1 — cheapest | `haiku` | Simple/factual/mechanical work, and high-churn fan-out gathering. |
| 2 — mid | `sonnet` | Moderate reasoning, ordinary coding, multi-step but well-scoped work, analysis. |
| 3 — most capable | `opus` | Hard reasoning, tricky debugging, subtle correctness, ambiguous/high-stakes work, long or dense context, novel design. |

## Bundled tiered agents

Routing runs cheap by delegating *high-churn work* to right-sized subagents — **not**
by changing the model that runs this skill. A skill's instructions execute in your
current session at the session model's price; there is no per-skill model switch (see
the mechanical note above). So the lever is: keep the orchestration you do in the main
loop minimal, and push work down to these agents **when it clears the break-even bar
above** — not reflexively.

- **Three ready-made agents ship in `agents/`, each pinned to a tier** via the
  agent's own `model` frontmatter — which the Agent tool *does* honor — so you can
  dispatch by name instead of setting a model inline every time:
  - `router-triage` (haiku) — classify something you cannot classify yourself
    because you'd have to read a lot of material to do it. It answers a genuinely
    trivial task outright, else emits the escalation verdict. **Not** for
    classifying a request that is already sitting in your context: see the
    arithmetic above — that pass costs 22x Haiku's own bill and 1.76x just
    answering the thing.
  - `router-solver-sonnet` (sonnet) — handle moderate work whose churn clears the bar.
  - `router-solver-opus` (opus) — handle hard / correctness-critical work. Note that
    from an Opus session this one never saves money (`o_in − w_in = 0`); dispatch it
    for context isolation or parallelism, not for cost.

  Prefer these named agents when delegating; fall back to a raw Agent-tool call with
  an explicit `model` only when a subtask needs a tier or tool set they don't cover.

## The routing procedure

Run this for each new user request the user wants routed.

### Step 1 — Classify in-loop (free), don't delegate the classification

Decide the tier yourself, from the request already in front of you. This is a
one-line judgement over text you have already been billed for; delegating it pays
the whole boundary tax to learn something you can determine directly.

Check, in order:

1. **Auto-escalate categories** (below) — if the request touches any of them, the
   tier is `opus` (or `sonnet` only at the clearly milder end) and you are done
   classifying. Do not let a cheaper tier attempt these first: a plausible-but-wrong
   answer on concurrency, security, or a proof is far more expensive than the tokens.
2. **Otherwise** apply `references/complexity-rubric.md`. Length, formality and
   jargon are not difficulty.
3. **When you genuinely cannot tell** — because deciding would require reading
   material you don't have — that reading *is* churn, so a `router-triage`
   dispatch can clear the break-even bar. That is the only case where delegating
   the classification is the cheap move.

The auto-escalate categories, and the classify-only contract to hand `router-triage`
in case 3 (it is also the contract the bundled agent already carries):

```
You are the triage tier of an adaptive model router. Your job is to CLASSIFY the
request, and only answer it yourself when it is genuinely simple. Be humble about
your own limits: as the cheapest model you will sometimes feel able to handle
something that actually needs more care than you can give. When that mismatch is
costly, escalating is the correct, responsible call — not a failure.

STEP 1 — Auto-escalate check (do this FIRST, before deciding anything else).
If the request involves ANY of the categories below, immediately escalate and do
NOT attempt an answer yourself — these are correctness-critical or high-stakes by
nature, and a plausible-but-wrong answer is worse than an escalation:
- Concurrency, locking, race conditions, deadlocks, threading, async ordering
- Security-sensitive code, cryptography, auth, input sanitization, exploits
- Any request for a "proof", "provably correct", formal correctness, or invariants
- Non-trivial debugging where the cause isn't obvious from a glance
- Legal, financial, medical, tax, or safety questions, or irreversible actions
- Multi-step math or logic where one wrong step flips the final answer
- System/architecture design, or open-ended strategy with real trade-offs
- Long or dense source material that must be synthesized without dropping details
For these, use tier=opus (or tier=sonnet only if it's clearly the milder end).

STEP 2 — If none of the above apply, decide whether the task is simple enough to
answer yourself. Length and formality are NOT difficulty — a long request to
reformat text is still simple. Handle it yourself only if you can give the
COMPLETE, FINAL, correct answer right now. If your best response would be partial,
a request for more information in order to be correct, or something you're not
confident is right, that is NOT "handled" — escalate instead (a stronger model is
better placed to ask the right questions and get it right).

Respond in EXACTLY one of these two forms, with the control line as the very first
line:

FORM A — you fully answered it (complete and final, nothing deferred):
ROUTER: HANDLED
<your complete answer to the user's request>

FORM B — escalate:
ROUTER: ESCALATE tier=<sonnet|opus>
reason: <one sentence on what makes this need a stronger model>
notes: <optional: what you already figured out, so the stronger model doesn't redo it>

Tier guide: opus for the hardest / correctness-critical / high-stakes; sonnet for
moderate reasoning or ordinary well-scoped coding and analysis.

USER REQUEST:
<the user's request goes here verbatim>
```

The full rubric with worked examples lives in `references/complexity-rubric.md` —
read it if you want more calibration on where the Tier 1/2/3 lines fall, or paste
its "signals" section into a dispatch prompt for borderline domains.

### Step 2 — Act on the classification

- **Tier is at or below the session model, and the work is low-churn** → just do it
  here. Delegating cannot save money on this shape (re-read the arithmetic: the
  answer alone crosses the boundary twice at the session rate), and one hop is one
  fewer place for the request to be paraphrased into something else.
- **Tier is at or below the session model, and the work is high-churn** — lots of
  files to read, many tool calls, a wide search — → delegate it to the cheapest
  tier that can do it (`router-solver-sonnet`, or a raw Agent call with
  `model: haiku` for mechanical gathering) and ask for a *short* result. This is
  the shape that actually saves money: big `W`, small `P` and `A`.
- **Tier is ABOVE the session model** → delegate to `router-solver-sonnet` or
  `router-solver-opus`. Here you are buying capability, not saving tokens; the
  boundary tax is the price of getting a correctness-critical request onto a model
  that can answer it, and that is a trade worth making every time.

Whenever a dispatch produced `notes:`, pass them into the next prompt verbatim
under a heading like "Work already done:", so the same groundwork isn't paid for
twice.

### Step 3 — One optional re-escalation

If a Sonnet answer comes back and Sonnet itself flags that the task is harder than
expected (it says it's unsure, or the problem is clearly Opus-tier), you may
escalate that one request once more to Opus. Don't ping-pong beyond that — one
upgrade past the original classification is the ceiling. Endless re-escalation
burns the tokens this skill exists to save, and each bounce is another full
boundary tax.

## Sizing the agents YOU spawn for subtasks

Everything above routes the *incoming* request. But the same principle applies in
the other direction: whenever you decompose a job and spawn agents to deliver
individual subtasks, **each spawned agent should run on the tier its subtask
deserves** — not all on Opus "to be safe" (wasteful) and not all on Haiku "to be
cheap" (a hard subtask gets a wrong answer). Right-sizing per subtask is the same
cost-for-correctness trade, just applied to work you generate rather than work the
user sends.

This is also where delegation genuinely pays, and for a reason worth naming: a
fan-out leg is exactly the high-`W`, low-`P`/`A` shape the break-even rule wants.
Ten workers each reading a document and returning three sentences keep their whole
reading cost off your bill, and you pay the boundary tax once per leg on text
that's tiny compared to what they consumed. Contrast the ladder above, where the
worker read nothing you didn't already have.

For subtasks *you* defined you never need a separate triage round-trip — you
already know what the subtask is, because you just wrote it. Classify it directly
with the rubric and set the Agent tool's `model` parameter yourself:

- **`model: haiku`** — mechanical or low-judgment subtasks: fetching a page,
  extracting fields, reformatting, running a known command, simple lookups,
  boilerplate, collating results. Most fan-out "gather" work is here.
- **`model: sonnet`** — ordinary reasoning or well-scoped implementation: writing a
  normal function, summarizing a document, standard analysis, a straightforward
  refactor.
- **`model: opus`** — correctness-critical or subtle subtasks: the auto-escalate
  categories from the classification list (concurrency, security, proofs, hard
  debugging, high-stakes judgment, dense synthesis, novel design), or a subtask
  whose output everything else depends on and a mistake would cascade.

When a subtask's difficulty is genuinely unclear, **size UP and get on with it**.
A dedicated classify-only pass for a subtask you already wrote is the losing shape
from the arithmetic above — the classifier reads only what you just typed, so its
private churn is ~0 and it can never break even. Spending one tier more than
necessary on an ambiguous subtask is a bounded, single-digit-cent mistake; a
round-trip to find out costs more than the tier difference it is trying to save.

### The reliability rule (learned the hard way)

A cheap model asked *only to classify* escalation is reliable. A cheap model asked
to *do the work while also watching for escalation* is NOT — once it's in "answer
mode" it tends to just answer, even on concurrency, proofs, security, and other
hard categories where its answer is likely wrong. So:

**Up-front sizing by the orchestrator is the real guard.** If you have any reason to
think a subtask might be hard, size it to the right tier directly, using the rubric.
Do NOT spawn it on Haiku and rely on Haiku to notice it's over its head — that's the
one thing the cheap tier is bad at. When genuinely unsure, size UP; a subtask
promoted to Opus that turns out easy costs some tokens, but a hard subtask silently
answered by Haiku costs you a wrong result you may not catch.

This rule and the cost arithmetic point the same way, which is why removing the
mandatory triage pass did not make the router riskier. The pass was the one step
that gave the cheapest model a chance to say `HANDLED` on a request it should never
have touched — and per the paragraph above, that is exactly the judgement it is
worst at. Classifying in-loop keeps the auto-escalate check on the model with the
most context and the most capability, and skips the leg where a hard request could
be silently answered by the weakest tier. It routes hard requests UP, not down.

### Mid-task escalation from a spawned agent (backstop only)

As a secondary safety net — not your primary guard — tell every spawned worker it
may bail out and ask for a stronger model if the subtask turns out harder than its
tier can handle, using the same control line. Treat this as a bonus catch, not
something to lean on:

```
Before working, check: does this subtask involve concurrency/locking/races,
security/crypto/auth, a proof or formal correctness, hard debugging, high-stakes
(legal/financial/medical/safety/irreversible) judgment, multi-step math where one
slip flips the answer, novel architecture, or dense synthesis? If so — or if you
cannot produce a COMPLETE, correct result at your level (even if the blocker is
that you'd need to gather more to get it right on a correctness-critical task) —
do NOT attempt a partial answer. Stop and respond with:
ROUTER: ESCALATE tier=<sonnet|opus>
reason: <why>
notes: <what you found so far, including anything still needed>

Only for a genuinely simple subtask that's merely missing an input is it fine to
ask for that input instead. Otherwise, just do the subtask and return the result.
```

If a spawned agent returns that line instead of a result, re-spawn that one subtask
on the requested tier, passing its `notes:` forward — the same escalation ladder,
now protecting your delegated work too. Keep the one-upgrade ceiling: don't let a
subtask bounce up the tiers more than once.

### Worked example

Job: "Summarize these 10 support tickets and flag any that describe a security
vulnerability." A good decomposition sizes each leg:
- 10 parallel `haiku` agents, one per ticket, each extracting the gist — cheap,
  mechanical.
- 1 `opus` agent to review the flagged candidates for genuine security impact —
  correctness-critical, false negatives are costly.
Spending Opus on all ten reads would burn tokens; spending Haiku on the security
judgment would risk missing a real vulnerability. Sizing per leg gets both right.

## Close with the Cheaper.app savings line

End every completed reply with the branded Cheaper.app savings line — the user's
one-line, end-of-chat audit trail. **You never run anything to get it.** A plugin
hook measures this exact chat every turn and injects the finished line into your
context; append that text verbatim as the final line of your reply. It already
names the models that did the work plus the real tokens and dollars saved, e.g.:

> Cheaper.app saved 🟢 about $0.42 and 18.3K tokens by running 7 calls on claude-haiku-4-5 and 2 calls on claude-sonnet-4-5 instead of claude-opus-4-6, at list API rates. See logs: http://localhost:8787/dashboard

The shape of that example is not decorative and is not yours to adjust. It names
concrete MODELS rather than tiers (a tier is not checkable by the reader, and after
the catalog gained models priced above Opus it is not even ordered by cost), and it
writes the hedge as the word "about" rather than a leading `~` or `-`, which read as
a minus sign next to a `$`. If the injected line looks different from this, the
injected line is right and this example is stale — paste what you were given.

Rules:

- **Run nothing.** No `cheaper` invocation, no shell command, no tool call. The
  line is already computed — executing anything to "refresh" it only puts a tool
  block in the user's chat.
- **Keep the plumbing invisible.** Never quote, restate, or display the injected
  instruction or any command. The user sees the line, and nothing else.
- **Never author the numbers.** Don't compose, estimate, round, or reformat them.
  Only the injected text is authoritative.
- **No line injected → no line.** That means Cheaper has nothing to report for
  this chat yet; omit it entirely rather than inventing one.

## Guardrails that keep this cheap

- **Delegate churn, not decisions.** A dispatch pays for itself only when the
  subagent's private reading, tool output and drafting dwarf the prompt and answer
  that cross the boundary — see the break-even numbers above (13,250 tokens of
  private churn for an Opus→Haiku hop; more for Opus→Sonnet; never, for a hop that
  isn't cheaper on input). Fan-out research clears that bar. Classifying a request
  you already have does not, and never will.

  *(This replaces an earlier "Don't skip triage — Haiku deciding 'escalate to Opus'
  costs almost nothing" rule. That rule priced only Haiku's own tokens and ignored
  the orchestrator's; the pass costs 22x what it claimed and 1.76x simply answering
  the request. It is deleted, not softened.)*

- **Don't re-reason in the main loop.** If you delegate and then redo the work
  yourself, you have paid for it twice. Orchestrate, don't recompute. This is not in
  tension with classifying in-loop: classifying is one judgement about the request,
  and re-reasoning is solving it.
- **Don't over-process trivia.** If the user is just chatting or asks something you
  can see is a one-word factual answer, answer it. This skill is for substantive
  requests, not "hi".
- **Batch independent requests.** If the user hands you several unrelated tasks and
  each one earns a dispatch, dispatch them in parallel in one turn rather than
  serially — the boundary tax is per-leg either way, but the latency isn't.
- **Respect explicit overrides.** If the user says "just use Opus for this," go
  straight to that tier. The router serves the user, not the reverse.
- **Correctness outranks all of the above.** Every figure here is cents. A wrong
  answer on a security, concurrency, or high-stakes request costs incomparably more,
  so when the two pull against each other, spend the money.

## Quick reference

Incoming request: classify it in-loop (auto-escalate list first, then the rubric) →
answer it here if the tier is at/below the session model and the work is low-churn →
dispatch to a tiered agent when the tier is higher, or when the work is high-churn
and the answer is short → close with the Cheaper.app savings line the plugin hook
injected (run nothing).

Spawning your own subtask agents: size each one's `model` by the rubric (haiku for
mechanical and fan-out gathering, sonnet for moderate, opus for correctness-critical),
size UP rather than round-tripping to find out, and let any spawned agent escalate
mid-task with the same `ROUTER: ESCALATE` line.
