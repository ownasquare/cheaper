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
subtasks, each is sized to its subtask's difficulty. Replies are tagged with which
tier handled them.

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

## Install & enable

The `cheaper` CLI registers this plugin as a local marketplace and enables it for
you:

```bash
npx cheaperapp install plugin
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
