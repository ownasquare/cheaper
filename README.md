# Cheaper

**Your AI bill, on a diet.** Adaptive Claude model routing: triage every request,
run cheap by default, escalate only when it counts — and *see* it working.

Cheaper is one idea delivered across every surface where a Claude model runs:

| Piece | What it is | Where it applies |
|-------|-----------|------------------|
| **Skill** | The triage-and-escalate procedure + complexity rubric | Claude app / Claude Code |
| **Agents** | Three tiered subagents (`router-triage` haiku, `router-solver-sonnet`, `router-solver-opus`) the skill dispatches to | Claude app / Claude Code |
| **Hook** | Always-on policy injection each turn | Claude Code |
| **Plugin** | Skill + agents + hook packaged as one managed unit (registered as a local marketplace) — an alternative to installing the three separately | Claude app / Claude Code |
| **Gateway** | An Anthropic-compatible proxy that routes *every* API call and logs it | Claude Code, SDKs, any client that sets `ANTHROPIC_BASE_URL` |
| **CLI** | `cheaper` — installs the above and runs/monitors the gateway | Mac / Windows / Linux |
| **Desktop** | Menu-bar app to start the gateway and watch live savings | Mac / Windows / Linux |

## Quickstart

```bash
npx cheaperapp install --all      # = skill + agents + hook + gateway (the reliable set)
# or the managed plugin instead of the three separate pieces:
npx cheaperapp install plugin
cheaper gateway start
export ANTHROPIC_BASE_URL=http://localhost:8787
cheaper monitor                # live downgrade-rate + estimated savings
```

`--all` installs the skill, the three tiered agents, the hook, and the gateway into
discovered user-level locations (`~/.claude/skills`, `~/.claude/agents`, and
`settings.json` hooks) — the stable mechanisms that don't depend on the plugin
registry. `install plugin` is the same skill+agents+hook registered as a local
marketplace and enabled for you; it supersedes the standalone three, so pick one or
the other (the installer de-dupes if you switch).

## How routing works

Every request is classified. Simple work runs on the cheapest tier (Haiku);
moderate work on Sonnet; and **auto-escalate categories** — concurrency, security,
proofs, hard debugging, high-stakes judgment, dense synthesis — jump straight to
Opus, bypassing the small model's habit of under-escalating. By default the model
your client requested is a **ceiling**: Cheaper only ever downgrades, never spends
more than you asked (`ROUTER_ALLOW_UPGRADE=true` enables full adaptive upgrades).

## Layout

```
cheaper.app/
├── gateway/    # FastAPI proxy + SQLite monitor (17 tests)
├── cli/        # `cheaper` Node CLI + installer (bundles gateway + plugin assets)
├── desktop/    # Electron menu-bar app (build with electron-builder)
├── web/        # landing page (single file)
├── HANDOFF.md  # how to cut a downloadable release
└── README.md
```

## The honest boundary

The **gateway** is the only piece that covers *every* surface uniformly — but it
only reaches clients that let you set `ANTHROPIC_BASE_URL` (Claude Code, the SDKs,
your own apps). The **Claude desktop app / claude.ai** don't expose a custom base
URL, so for those the **plugin** (skill + hook + tiered agents) is the lever. No hook
or plugin can change the base session model; they route *work* to right-sized
subagents. Together they cover the whole picture. See `gateway/README.md` and the
plugin's own README for specifics.

## Status

Gateway + monitor and the CLI/installer are working and tested (run
`cd gateway && python -m pytest`). The desktop app is a build-ready scaffold —
producing signed `.dmg`/`.exe` requires building on each OS with certificates (see
`HANDOFF.md`).
