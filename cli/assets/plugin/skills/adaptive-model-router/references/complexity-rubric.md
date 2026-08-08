# Complexity Rubric

Calibration for whoever is classifying — the orchestrator in-loop, the
`router-triage` agent, or the gateway's cascade. The core question is never "does
this look impressive" — it's **"what is the cheapest model that returns a correct
and complete answer?"** Length, formality, and jargon are not difficulty. A
three-paragraph request to reformat a list is Tier 1. A one-line request to prove
a lemma is Tier 3.

## The one principle: volume is not difficulty — COUPLING is

This rubric used to assert "Volume ≠ difficulty" in its tie-breakers while listing
"long, dense context that must be synthesized" as a Tier 3 signal. Both are right;
stated that way they contradict each other, and a classifier told both will follow
whichever it read last. The distinction that dissolves it:

- **Decoupled volume stays cheap.** If the input decomposes into independent,
  identical operations — reformat each line, extract a field from each record,
  rename a symbol in each file — then doubling the length doubles the work and
  changes nothing about the *judgement* required. No amount of it escalates. This
  is also the shape that fans out well to parallel cheap workers.
- **Coupled volume escalates.** If the parts constrain each other — the answer must
  stay consistent with material spread across the whole, an omission anywhere
  corrupts the result, a fact on page 1 changes what page 9 means — then length is
  a genuine multiplier on the chance of dropping or contradicting something, and
  that is what the top tier is better at.

So the Tier 3 signal is not "long". It is **"long AND jointly constrained."** Ask
"could I split this across ten workers who never talk to each other, and staple the
results together?" If yes, it is Tier 1 work however long it is. If no, size for
the coupling.

The same test settles the other surface features: **the presence of code is not
difficulty either.** "Fix this typo" with a code fence around it is Tier 1; "find
the race in this" without one is Tier 3. Classify the task, not the formatting.

## Tier 1 — Haiku (triage tier answers directly)

The cheap model should just answer. Signals:

- Factual lookup or recall with a short, unambiguous answer.
- Mechanical text work: rephrasing, summarizing short text, formatting, tone edits,
  extracting fields, simple find/replace.
- Simple, single-file code: a small function, a regex, a shell one-liner, an obvious
  syntax fix, boilerplate.
- Definitions, explanations of common concepts, straightforward how-to steps.
- Classification/routing decisions that follow a clear rule.

Worked examples:
- "What's the capital of Australia?" → HANDLED.
- "Rewrite this sentence to sound more formal: ..." → HANDLED.
- "Write a Python function that returns the nth Fibonacci number." → HANDLED.
- "Turn these bullet points into a short paragraph." → HANDLED.

## Tier 2 — Sonnet (escalate tier=sonnet)

Real reasoning or engineering, but well-scoped with a clear target. Signals:

- Ordinary coding across a few files, a normal feature, a standard refactor.
- Multi-step analysis where the steps are clear and the domain is familiar.
- Drafting substantial writing that needs structure and coherence but not deep
  originality.
- Data analysis with a defined method.
- Explaining a moderately complex system where accuracy matters but the material
  isn't subtle.

Worked examples:
- "Add pagination to this REST endpoint and update the tests." → ESCALATE sonnet.
- "Summarize these 6 meeting notes into themes with action items." → ESCALATE sonnet.
- "Walk through why this SQL query is slow and suggest indexes." → ESCALATE sonnet.

## Tier 3 — Opus (escalate tier=opus)

Hard, subtle, ambiguous, or high-stakes. A wrong answer is costly and correctness
is hard to verify. Signals:

- Tricky debugging: race conditions, heisenbugs, subtle state, security flaws.
- Multi-step math/logic/proofs where one slip invalidates the result.
- Ambiguous or underspecified requirements needing judgment and trade-off analysis.
- Novel design: architecture from scratch, open-ended strategy, hard trade-offs.
- High-stakes framing: legal, financial, medical, safety, irreversible actions.
- Long context that is **jointly constrained** — a synthesis where the parts must
  agree with each other and an omission anywhere corrupts the whole. (Long-but-
  decoupled material is Tier 1 no matter its size; see the coupling principle.)
- Anything the cheaper tiers tried and weren't confident about.

Worked examples:
- "Our service deadlocks under load maybe once a day — here are the logs and the
  thread code. Find it." → ESCALATE opus.
- "Design the sharding and consistency model for this multi-region datastore." →
  ESCALATE opus.
- "Is this contract clause enforceable and what are the risks?" → ESCALATE opus
  (and the answering tier should add the usual not-a-lawyer caveat).

## Tie-breakers

- **Low stakes + uncertain** → handle at the current tier; a small miss is cheap.
- **High stakes + uncertain** → escalate; the cost of being wrong dwarfs the tokens.
- **"Looks hard but is rote"** (long boilerplate, big but mechanical edit) → do NOT
  escalate on size alone. Volume is not difficulty; coupling is.
- **"Looks easy but is subtle"** (a one-line question hiding a deep problem) →
  escalate. Difficulty is not length, in either direction.

---

## Where this rubric and the shipped gateway DISAGREE

This document is the policy a *model* is told to apply. `cli/assets/gateway/app/
router.py` is a regex cascade that decides the same question for API traffic. They
are one product and one brand, so a reader is entitled to assume they agree. They
do not. Everything below was measured by importing the shipped `router.py` and
running it over this file's own worked examples — no estimates.

**Do not "fix" this by weakening the rubric.** Where the two differ, the items
below say which side is wrong. The gateway side is owned in `router.py`; the
changes it needs are listed at the end.

### 1. Auto-escalation is unreachable under the shipped default (gateway must change)

`RouterConfig.allow_upgrade_above_requested` defaults to `False`, and `decide()`
caps the chosen tier at the caller's requested model. Across 48 measured decisions
(this file's 16 worked examples × three plausible caller models) the router selected
a tier above the requested model **zero** times. A request that matches every
auto-escalate pattern in the cascade still comes back capped:

```
requested=claude-haiku-4-5   content_tier=opus -> routed tier=haiku
    reason: auto-escalate category matched: /\bdeadlock\b/; capped to requested 'haiku' (upgrades disabled)
```

So the cascade's "auto-escalate" is not an escalation at all under the default — it
is only a *guard against downgrading*, which is a genuinely useful thing but is not
what this rubric, `SKILL.md`, or `router-triage` describe. Worse, the observable
behavior is the exact inverse of the promise: a caller on Haiku asking about a
deadlock is answered by Haiku.

End-to-end agreement between this rubric's declared tiers and `decide()`:

| Caller model | Agrees with rubric | Routed BELOW rubric tier |
|---|---|---|
| `claude-haiku-4-5` | 5/16 (31%) | 11/16 (69%) |
| `claude-sonnet-4-5` | 9/16 (56%) | 7/16 (44%) |
| `claude-opus-4-6` | 15/16 (94%) | 1/16 (6%) |
| **all callers** | **29/48 (60%)** | **19/48 (40%)** |

The content cascade in isolation (`_content_tier`, i.e. before the ceiling) agrees
on 15/16 — so nearly all the divergence is the ceiling, not the pattern list. The
one genuine cascade miss is *"Walk through why this SQL query is slow and suggest
indexes"*: this rubric calls it Tier 2, the cascade returns haiku ("simple/short
request") because no pattern covers query-plan analysis.

*(A prior audit reported 32% disagreement on the product's worked examples. The 40%
above is this file's own re-measurement over a caller mix it states explicitly;
treat the two as consistent in kind, not as the same statistic.)*

### 2. The cascade escalates on size and on code fences (gateway must change)

Both rules directly contradict the coupling principle at the top of this file, and
both raise the bill rather than lowering it. Measured against the shipped default:

| Input | Cascade verdict | Rubric verdict |
|---|---|---|
| 6,250-char "reformat this list, one per line" | `sonnet` — *long/dense request* | Tier 1 — decoupled volume |
| one-typo fix wrapped in a code fence | `sonnet` — *contains code block* | Tier 1 |
| the literal message `hi`, behind a 4,000-char system prompt | `sonnet` — *long/dense request (4,003 chars)* | Tier 1 |

The third row is the serious one. `extract_text()` concatenates the `system` block
with the messages before `len(text) >= long_request_chars` is applied, and every
agentic client sends a system prompt far longer than 4,000 characters. **For those
clients the haiku tier is unreachable regardless of what the user asked** — the
floor is set by the harness, not by the request. That single line silently disables
the cheapest tier for the product's main traffic shape.

### 3. Category patterns fire on ordinary engineering English (gateway must change)

`router.py`'s comment says the patterns are word-boundaried "so `auth` doesn't fire
on `author`". The boundaries are there, but several patterns match common, entirely
non-escalating usage — and because these are *opus* patterns, every false positive
is an upward misroute that costs money:

| Ordinary request | Fires | Pattern |
|---|---|---|
| "Update the API contract doc for the new field." | opus | `\bcontract\b` (meant: legal contracts) |
| "Explain the architecture of this file in two sentences." | opus | `\barchitect(?:ure\|ing)?\b` |
| "What does this cryptocurrency ticker symbol stand for?" | opus | `\bcrypto(?:graph)?` (no trailing boundary) |
| "Add a sanitizer flag to the build script." | opus | `\bsanitiz` |
| "Where is the lock file for this package manager?" | opus | `\block(?:s\|ing\|-free)?\b` |
| "Diagnose why this unit test is flaky." | opus | `\bdiagnos` (meant: medical) |

Note the interaction with item 1: on a caller already requesting Opus these cost
real money, and on a caller requesting Haiku they are capped away to nothing. The
cascade is loudest exactly where it is least able to act.

### What the gateway must change for the two to agree

Owned in `cli/assets/gateway/app/router.py` — listed here so the requirement is
recorded, not because this document can make the change:

1. **Separate "never downgrade this" from "escalate this".** The auto-escalate
   categories should set a *floor* that the requested-model ceiling cannot lower,
   so a hard request is never answered by a cheaper model than the caller asked
   for. Escalating *above* the caller's model is a genuine cost increase and should
   stay opt-in — but it must then be described that way everywhere, instead of
   being promised as automatic.
2. **Stop measuring length over the system prompt.** Apply `long_request_chars` to
   the user-turn text only, or drop the length rule entirely. As shipped it makes
   the haiku tier unreachable for every client with a normal system prompt.
3. **Drop the bare code-fence escalation.** A fence says a message contains code,
   not that the task is hard. If a code signal is wanted, tie it to the verb
   ("debug", "why does this crash") rather than the delimiter.
4. **Tighten the false-positive patterns.** `contract`, `architect*`, `crypto*`,
   `sanitiz*`, `lock*` and `diagnos*` need either a trailing boundary, a required
   companion term (`smart contract` vs `contract clause`; `crypto` + `key|cipher|
   sign`), or removal. Each of these is an upward misroute on everyday text.
5. **Cover query-plan / performance analysis at Tier 2** so the one genuine content
   mismatch above closes.
6. **Keep one worked-example corpus and assert both sides against it.** These two
   policies drifted because nothing compared them. A parity check over the examples
   in this file — this rubric's declared tier vs `decide()`'s answer — would have
   caught every item above on the commit that introduced it.
