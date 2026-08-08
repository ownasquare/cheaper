# Adaptive Model Router (plugin)

Bundles two things so they install and activate together:

1. **The `adaptive-model-router` skill** — the full triage-and-escalate procedure:
   route each request through the cheapest model first, escalate to a stronger one
   only when warranted, with auto-escalate categories and per-subtask sizing for
   spawned agents.
2. **An always-on hook** — a `SessionStart` + `UserPromptSubmit` hook that injects
   the routing policy every turn, so the behavior is active without waiting for the
   skill's description to trigger.

## What it does when enabled

For every new session (and every prompt within it), the hook puts the routing
policy in front of Claude. Claude then triages: simple requests are handled at the
cheapest level; correctness-critical or complex ones are delegated to a
stronger-model subagent (Haiku → Sonnet → Opus). When Claude spawns agents for
subtasks, each is sized to its subtask's difficulty. Every completed reply ends
with the **Cheaper.app savings line** — the real tokens and dollars this chat saved
and which tiers did the work (via `cheaper peek --tagline`), with a `Stop`-hook
backstop so it lands even if the model forgets.

## Honest limits

- **A hook cannot change the session model.** No hook can — Claude Code/Cowork has
  no field that sets the model. This plugin enforces the routing *policy*; the
  actual tier change happens by delegating work to subagents with a per-agent model
  override, as the skill describes.
- **It applies to new sessions, not already-open ones.** Hooks load when a session
  starts, so enabling the plugin affects sessions opened afterward. Restart/refresh
  an existing chat for it to pick the plugin up.

## Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Skill | `skills/adaptive-model-router/` | The routing procedure + complexity rubric. Runs in your session like any skill; it keeps the main loop thin and delegates the actual work to the tiered agents. |
| Agents | `agents/` | Three ready-made tiered solvers to dispatch to by name: `router-triage` (haiku), `router-solver-sonnet` (sonnet), `router-solver-opus` (opus). |
| Hook | `hooks/hooks.json` | Injects `hooks/context/router-policy.md` on SessionStart + UserPromptSubmit |

## Versioning discipline (read before editing anything in this directory)

This plugin exists as **three copies**, and the one that actually runs is the last
one in the list:

| Copy | Path | Written by |
|------|------|------------|
| Product source | `cli/assets/plugin/` | you, in the repo |
| Marketplace | `~/.cheaper/marketplace/plugins/adaptive-model-router/` | `cheaper install plugin` |
| Claude Code cache | `~/.claude/plugins/cache/cheaper-local/adaptive-model-router/<version>/` | `claude plugin install` |

The cache directory is **named after the version in `.claude-plugin/plugin.json`**.
So editing a file here without bumping that version leaves the running copy stale
at the same path, with no signal anywhere that it is stale. That is not
hypothetical: at the time this section was written, `hooks/stop-tagline.js` already
differed between the source and both installed copies while all three declared
`0.2.0` — the fix was in the repo and the bug was still running.

**The rule: any change to a file in this directory requires a version bump in
`.claude-plugin/plugin.json` and a refreshed `.claude-plugin/content-manifest.json`.**

`content-manifest.json` records the declared version, a SHA-256 over every shipped
file (the manifest itself excluded, and Claude Code's `.in_use/` runtime lockfiles
excluded so an installed copy can be checked in place), and the digest of every
version previously published. `cli/test/inject_tagline.test.js` asserts all three:
that the manifest's version matches `plugin.json`, that the digest matches the tree,
and that no already-published version is being re-shipped with different content.
Editing without bumping therefore fails the test suite instead of silently shipping.

To refresh after a legitimate change: run the suite, copy the computed digest out of
the failure message, move the OLD `{version: digest}` pair into `published`, and set
the new `version` + `sha256`. Then `cheaper install plugin` to propagate.

### What v0.2.0 added

The bundled agents use `model`/`effort` frontmatter to pin their tier declaratively —
which the Agent tool honors — so routing doesn't depend only on the orchestrator
remembering to set a model on each Agent-tool call. (The skill itself has no `model`
field: a skill always runs on the session model, so the savings come from delegating
work down to the agents, not from the skill running "on Haiku.") This widens coverage
within the plugin layer — but
note it still cannot change the *base session model* or reach background/utility
calls, scheduled tasks, or non-plugin surfaces. For routing that covers *every*
surface uniformly, use the companion LLM-gateway router (a proxy in front of the
API).

### What v0.3.0 changed

Three corrections, all of them things the plugin was previously getting wrong in the
user's favour-sounding direction:

1. **The triage mandate is gone.** The skill used to require a cheap-model triage
   pass on every request, on the grounds that "Haiku deciding 'escalate to Opus'
   costs almost nothing". That priced only Haiku's tokens. The orchestrator is the
   session model and pays top-tier OUTPUT to author each Agent-tool prompt (the
   request is re-emitted verbatim) and top-tier INPUT to read the result back — so
   the pass costs 22x what was claimed, and 1.76x simply answering the request.
   `SKILL.md` now shows the full arithmetic and replaces the mandate with a
   break-even rule: delegate when the subagent's private churn dwarfs what crosses
   the boundary, which is fan-out research, not routing.
2. **The hooks can no longer publish failure text as a money claim.**
   `stop-tagline.js` and `inject-tagline-cmd.js` read the CLI's stdout without
   checking `status`, `signal` or `error`, so a timeout SIGTERM, a non-zero exit or
   a crash emitted a half-written figure — or a stack frame — as the branded savings
   line. Both now require a clean run *and* well-formed output, and fall back to
   silence.
3. **The rubric states where it disagrees with the gateway.** The model-side rubric
   and `router.py`'s regex cascade are two policies under one brand; the rubric now
   carries the measured divergence and the list of changes the gateway needs. See
   `skills/adaptive-model-router/references/complexity-rubric.md`.

## Install & enable

The `cheaper` CLI registers this plugin as a local marketplace and enables it for
you:

```bash
npx cheaper install plugin
```

Under the hood that builds a one-plugin marketplace at `~/.cheaper/marketplace`,
then runs `claude plugin marketplace add` + `claude plugin install` (falling back to
writing the plugin registry directly when the `claude` CLI isn't on PATH), and sets
`enabledPlugins["adaptive-model-router@cheaper-local"] = true`. Verify with:

```bash
claude plugin list        # -> adaptive-model-router@cheaper-local   Status: ✔ enabled
```

New sessions will run with routing active. To confirm it's working, start a new chat
and send a hard prompt (e.g., a concurrency-bug question) — the reply should note it
was escalated to a stronger tier.

## Cost note

The hook injects a short policy every turn, so there's a small constant per-turn
overhead in exchange for guaranteed activation. If you'd rather only route on
substantive work, use the skill alone (disable the hook).
