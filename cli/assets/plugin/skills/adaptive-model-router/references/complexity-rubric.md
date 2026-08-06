# Complexity Rubric

Calibration for the triage tier. The core question is never "does this look
impressive" — it's **"what is the cheapest model that returns a correct and
complete answer?"** Length, formality, and jargon are not difficulty. A
three-paragraph request to reformat a list is Tier 1. A one-line request to prove
a lemma is Tier 3.

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
- Long, dense context that must be synthesized carefully without dropping details.
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
  escalate on size alone. Volume ≠ difficulty.
- **"Looks easy but is subtle"** (a one-line question hiding a deep problem) →
  escalate. Difficulty ≠ length.
