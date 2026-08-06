---
name: adaptive-model-router
description: >-
  Route each request through a cheap model first and escalate to a stronger one
  only when the cheap model says the task actually needs it. Use this whenever
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

So instead of guessing the right model up front, this skill **triages every
request with the cheapest model first**. That cheap model does one of two things:
it either answers the request outright (when it's clearly within its ability), or
it reports back that the task needs a stronger model and says which one and why.
You only pay for a bigger model when the small one has actually looked at the
request and recommended the upgrade.

### Important mechanical note (read this)

A skill can't reach into this running session and swap the model powering the
main loop — the model you're reading this on is fixed for the session. What this
skill *can* do is route the actual work to a model of the right size by spawning
a **subagent** with an explicit `model` override (via the Agent tool). That
subagent runs on the chosen tier, does the work, and hands its result back. So
"switching models" here means "delegating the request to a subagent on the right
tier," which achieves exactly the cost behavior you want: the expensive main loop
stays thin and does only lightweight orchestration, while the bulk of the thinking
happens on whatever tier the triage step selected.

Keep the main-loop reasoning minimal. Every sentence you reason about the *content*
of the request in the main loop is spent at the session's model price. Delegate the
thinking; don't duplicate it.

## The tiers

| Tier | Model (Agent `model` value) | Use for |
|------|------------------------------|---------|
| 1 — cheapest | `haiku` | Triage every request; answer simple/factual/mechanical tasks directly. |
| 2 — mid | `sonnet` | Moderate reasoning, ordinary coding, multi-step but well-scoped work, analysis. |
| 3 — most capable | `opus` | Hard reasoning, tricky debugging, subtle correctness, ambiguous/high-stakes work, long or dense context, novel design. |

## Bundled tiered agents

Routing runs cheap by delegating the *thinking* to right-sized subagents — **not** by
changing the model that runs this skill. A skill's instructions execute in your
current session at the session model's price; there is no per-skill model switch (see
the mechanical note above). So the lever is: keep the orchestration you do in the main
loop minimal, and push the actual work down to these agents.

- **Three ready-made agents ship in `agents/`, each pinned to a tier** via the
  agent's own `model` frontmatter — which the Agent tool *does* honor — so you can
  dispatch by name instead of setting a model inline every time:
  - `router-triage` (haiku) — classify a request; answer it if trivial, else emit
    the escalation verdict.
  - `router-solver-sonnet` (sonnet) — handle moderate escalations.
  - `router-solver-opus` (opus) — handle hard / correctness-critical escalations.

  Prefer these named agents when delegating; fall back to a raw Agent-tool call with
  an explicit `model` only when a subtask needs a tier or tool set they don't cover.

## The routing procedure

Run this for **every** new user request the user wants routed. Each request starts
fresh at Tier 1 — that's the "first time, use the lowest model to understand the
request" step.

### Step 1 — Triage with Tier 1 (Haiku)

Spawn a single Haiku subagent that does double duty: it decides how hard the
request is, and if it's easy enough, it answers it in the same shot (no second
round-trip, so no wasted tokens). Give it the user's request verbatim plus the
triage contract.

Use the Agent tool:
- `subagent_type`: `general-purpose`
- `model`: `haiku`
- `prompt`: the request + the triage instructions below

Triage prompt to give the Haiku agent:

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
its "signals" section into the triage prompt for borderline domains.

### Step 2 — Act on the triage result

Read only the first line of the Haiku agent's output.

- **`ROUTER: HANDLED`** → The cheap tier answered. Relay its answer to the user.
  You're done. This is the cheapest path and should be the common case.

- **`ROUTER: ESCALATE tier=sonnet`** → Spawn a Sonnet subagent
  (`subagent_type: general-purpose`, `model: sonnet`) with the original request
  plus any `notes:` the triage agent passed along (so Sonnet builds on the cheap
  tier's work instead of starting over). Relay Sonnet's answer.

- **`ROUTER: ESCALATE tier=opus`** → Same, but with `model: opus`.

Pass the triage agent's `notes:` into the escalation prompt verbatim under a
heading like "Work already done by the triage pass:". This avoids paying twice for
the same groundwork.

### Step 3 — One optional re-escalation

If a Sonnet answer comes back and Sonnet itself flags that the task is harder than
expected (it says it's unsure, or the problem is clearly Opus-tier), you may
escalate that one request once more to Opus. Don't ping-pong beyond that — one
upgrade past the triage recommendation is the ceiling. Endless re-escalation burns
the tokens this skill exists to save.

## Sizing the agents YOU spawn for subtasks

Everything above routes the *incoming* request. But the same principle applies in
the other direction: whenever you decompose a job and spawn agents to deliver
individual subtasks, **each spawned agent should run on the tier its subtask
deserves** — not all on Opus "to be safe" (wasteful) and not all on Haiku "to be
cheap" (a hard subtask gets a wrong answer). Right-sizing per subtask is the same
cost-for-correctness trade, just applied to work you generate rather than work the
user sends.

The important efficiency difference: for subtasks *you* defined, you usually don't
need a separate Haiku triage round-trip — you already know what the subtask is
because you just wrote it. So classify it directly with the rubric and set the
Agent tool's `model` parameter yourself:

- **`model: haiku`** — mechanical or low-judgment subtasks: fetching a page,
  extracting fields, reformatting, running a known command, simple lookups,
  boilerplate, collating results. Most fan-out "gather" work is here.
- **`model: sonnet`** — ordinary reasoning or well-scoped implementation: writing a
  normal function, summarizing a document, standard analysis, a straightforward
  refactor.
- **`model: opus`** — correctness-critical or subtle subtasks: the auto-escalate
  categories from the triage list (concurrency, security, proofs, hard debugging,
  high-stakes judgment, dense synthesis, novel design), or a subtask whose output
  everything else depends on and a mistake would cascade.

When a subtask's difficulty is genuinely unclear, fall back to the full pattern:
give that one subtask a dedicated **triage pass** — a cheap agent whose ONLY job is
to classify (self-handle if simple, else `ROUTER: ESCALATE`), exactly as for a user
request. Use judgment — a cheap triage is worth it for an ambiguous subtask, but
pure overhead for one you can already see is trivial.

### The reliability rule (learned the hard way)

A cheap model asked *only to classify* escalation is reliable. A cheap model asked
to *do the work while also watching for escalation* is NOT — once it's in "answer
mode" it tends to just answer, even on concurrency, proofs, security, and other
hard categories where its answer is likely wrong. So:

**Up-front sizing by the orchestrator is the real guard.** If you have any reason to
think a subtask might be hard, either size it to the right tier directly (using the
rubric) or run a dedicated classify-only triage pass. Do NOT spawn it on Haiku and
rely on Haiku to notice it's over its head — that's the one thing the cheap tier is
bad at. When genuinely unsure, size UP; a subtask promoted to Opus that turns out
easy costs some tokens, but a hard subtask silently answered by Haiku costs you a
wrong result you may not catch.

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
one-line, end-of-chat audit trail. Don't hand-write it; run:

```
cheaper peek --tagline --current --harness claude-code --format markdown
```

and append its output verbatim as the final line. It already names the tiers that
did the work plus the real tokens and dollars saved, e.g.:

> Cheaper.app saved ~$0.42 and 18.3K tokens by using haiku tier for 7 calls, sonnet tier for 2 calls, opus tier for 1 call.

If the command prints nothing, Cheaper had nothing cheaper to route this chat —
omit the line. Never compose, estimate, or round the numbers yourself; only that
command's output is authoritative. (A plugin Stop hook re-runs the same command
against this exact chat as a backstop, so the line survives even if you forget.)

## Guardrails that keep this cheap

- **Don't skip triage.** The whole point is that the cheap model looks first. Even
  a request that seems obviously hard gets a cheap triage pass — Haiku deciding
  "escalate to Opus" costs almost nothing and keeps the policy honest.
- **Don't re-reason in the main loop.** If you find yourself solving the request
  yourself in the main loop before or after delegating, stop — that's the exact
  expensive behavior this skill routes around. Orchestrate, don't compute.
- **Don't over-triage trivia.** If the user is just chatting or asks something you
  can see is a one-word factual answer, it's fine to note that a full routing pass
  isn't worth it. This skill is for substantive requests, not "hi".
- **Batch independent requests.** If the user hands you several unrelated tasks,
  triage them in parallel (multiple Haiku agents in one turn) rather than serially.
- **Respect explicit overrides.** If the user says "just use Opus for this," skip
  triage and go straight to that tier. The router serves the user, not the reverse.

## Quick reference

Incoming request: Haiku triage subagent → if `HANDLED`, cheaper answer → if
`ESCALATE`, spawn Sonnet/Opus subagent with the carried-over notes → cheaper answer →
close with the Cheaper.app savings line (`cheaper peek --tagline`).

Spawning your own subtask agents: size each one's `model` by the rubric (haiku for
mechanical, sonnet for moderate, opus for correctness-critical), triage only the
ambiguous ones, and let any spawned agent escalate mid-task with the same
`ROUTER: ESCALATE` line.
