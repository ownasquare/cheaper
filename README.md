<div align="center">

# Cheaper

### Your AI bill, on a diet.

Adaptive model routing for AI coding tools — triage every request, run the cheapest
capable model, escalate only when it counts, and **see** it working.

[![npm](https://img.shields.io/npm/v/cheaper?color=059669&label=npm)](https://www.npmjs.com/package/cheaper)
[![downloads](https://img.shields.io/npm/dm/cheaper?color=059669)](https://www.npmjs.com/package/cheaper)
[![license](https://img.shields.io/badge/license-MIT-059669)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D16-brightgreen)](package.json)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/)
[![X](https://img.shields.io/badge/X-@_cheaper-000000?logo=x)](https://x.com/_cheaper)
[![Sponsor](https://img.shields.io/badge/Sponsor-♥-ec4899)](https://github.com/sponsors/ownasquare)

</div>

Your bill shows one number. It never tells you that most of it went to running the
**most expensive model on the easiest work**. Cheaper fixes the cause, not the
receipt: every request is classified, routine work drops to a model 5–20× cheaper,
and only the hard, correctness-critical calls stay on the frontier — with a monitor that
records the model you asked for and the model it served. Gateway figures are measured;
figures read from your local chat history are estimates, and are labelled "about".

100% local. Your own API key still flows straight through to the provider.

**Jump to:** [Quick start](#quick-start) · [See what you'd save](#see-what-youd-save--cheaper-peek) · [How routing works](#how-routing-works) · [Point any tool at it](#point-any-tool-at-it) · [Watch it work](#watch-it-work) · [Desktop app](#desktop-app) · [Supported tools](#supported-tools) · [Commands](#commands) · [Configuration](#configuration) · [How it reads your data](#how-it-reads-your-data)

---

## Quick start

```bash
# 1. See what routing WOULD have saved you — from your existing logs, before installing anything
npx cheaper peek

# 2. Install the router (skill + tiered agents + hook + gateway)
npx cheaper install --all

# 3. Start the gateway and point your tool at it
cheaper gateway start
export ANTHROPIC_BASE_URL=http://localhost:8787

# 4. Watch routing + savings in real time
cheaper monitor
```

Prefer a GUI? The [desktop app](#desktop-app) does install, gateway, savings-peek,
and the live monitor from a menu-bar window. Requires **Node ≥ 16**; the gateway
needs **Python 3** (auto-installed deps on first `gateway start`).

---

## See what you'd save — `cheaper peek`

`peek` answers *"what would this have saved me?"* **before** you change anything. It
scans your existing local chat histories (`~/.claude`, `~/.codex`, …), replays the
exact routing decision on every recorded call, and reports the tokens and real
dollars adaptive routing would have cut — split between your prompts and sub-agent
calls. **Read-only and local**: it classifies prompt text only and never emits
tool-output bodies, so credential-bearing command output is structurally excluded.

```bash
cheaper peek                        # all history, every detected harness
cheaper peek --days 30              # last 30 days (also annualizes)
cheaper peek --harness claude-code  # one harness
cheaper peek --json                 # machine-readable, for scripting/CI
```

```text
cheaper peek — what adaptive routing would have saved
scanned last 30d across your harness chat logs

harness         calls   downgradable   tokens   you'd save
● Claude Code   1,284   876 (68%)      18.4M    $41.20
◐ Codex         412     223 (54%)      5.1M     $7.80
○ Cursor        DB-backed (not yet readable)

Total   1,696 calls · 1,099 downgradable · from you 1,204 / sub-agents 492
Spent on record   $71.40
Could have saved  $49.00 (69% off)  · 14.9M tokens re-routable
Annualized        $596/yr  (extrapolated from 30d)

Biggest opportunities (top-tier calls that didn't need it):
  $0.38  opus→haiku   you        rename getUser to fetchUser across the repo
  $0.31  opus→haiku   sub-agent  list the files in src/components
```

`●` fully parsed · `◐` best-effort (tokens estimated) · `○` stored in a DB peek
doesn't read yet. Estimates use illustrative public list prices — unrecognized
models are left unpriced rather than guessed. The same engine powers the desktop
**Savings peek** panel and the web [savings tracker](https://cheaper.app/claude-code-savings-tracker.html).

---

## How routing works

Every request is classified from its text, then routed:

| Tier | Runs on | Gets the work when… |
|------|---------|---------------------|
| **Cheap** (Haiku-class) | the cheapest capable model | simple/short: edits, renames, lookups, boilerplate |
| **Mid** (Sonnet-class) | a balanced model | refactors, multi-file changes, tests, migrations, debugging, long/dense prompts |
| **Top** (Opus-class) | the frontier model | **auto-escalate categories**: concurrency, security/crypto/auth, proofs & invariants, legal/medical/finance, architecture & distributed systems |

Two rules keep it honest:

- **Ceiling** — by default Cheaper never routes *above* the model your client
  requested; it only downgrades or matches. No surprise spend. (`ROUTER_ALLOW_UPGRADE=true` opts into full adaptive upgrades.)
- **Auto-escalate** — hard categories jump straight to the top tier, bypassing a
  small model's habit of under-escalating on the calls where a wrong answer is costly.

Set `ROUTER_MODE=triage` to classify with a live cheap-model pass instead of the
built-in heuristic.

---

## Point any tool at it

The **gateway** speaks two protocols — the Anthropic Messages API *and* the
OpenAI-compatible Chat Completions API — so any tool that lets you set a custom base
URL routes through it:

```bash
# Anthropic-native tools (Claude Code, the SDKs, your apps)
export ANTHROPIC_BASE_URL=http://localhost:8787

# OpenAI-compatible tools (Codex, Cursor, Copilot, OpenCode, …)
#   point the tool's OpenAI base URL at:  http://localhost:8787/v1
```

Every call is inspected, routed to the right tier, forwarded to the real provider
with your key, and recorded. See [Supported tools](#supported-tools).

---

## Watch it work

Routing you can't see is a promise; routing you can see is a receipt.

```bash
cheaper monitor                        # live terminal: downgrade rate, tier mix, est. savings, recent decisions
open http://localhost:8787/dashboard   # same, in the browser
```

Both read the gateway's SQLite decision log, so the numbers are your real traffic —
not a model.

---

## Desktop app

A menu-bar / tray app (macOS · Windows · Linux) that wraps the whole thing:

- **Install everything** / **Uninstall** in one click — the `cheaper` CLI, the routing
  plugin (skill + 3 tiered agents + hook), and the gateway.
- **Start / stop the gateway** and open the live monitor.
- **Savings peek** panel — the same local, read-only estimate as `cheaper peek`,
  rendered in a window.

The desktop app lives in its own open-source repo —
[**cheaper-desktop**](https://github.com/ownasquare/cheaper-desktop) — which consumes
this `cheaper` package and builds the native installers (`.dmg` / `.exe` / `.deb` /
`.rpm` / `.AppImage`). It's kept separate so the routing core stays lean and the
code-signing pipeline stays out of this repo.

---

## The pieces

One idea, delivered on every surface where a model runs:

| Piece | What it is | Where it applies |
|-------|-----------|------------------|
| **Skill** | The triage-and-escalate procedure + complexity rubric | Claude app / Claude Code |
| **Agents** | Three tiered sub-agents (`router-triage`, `router-solver-sonnet`, `router-solver-opus`) the skill dispatches to | Claude app / Claude Code |
| **Hook** | Always-on policy injection each turn | Claude Code |
| **Plugin** | Skill + agents + hook as one managed unit (local marketplace) — an alternative to installing the three separately | Claude app / Claude Code |
| **Gateway** | Anthropic- **and** OpenAI-compatible proxy that routes *every* call and logs it | Claude Code, SDKs, any tool with a custom base URL |
| **CLI** | `cheaper` — installs the above, runs/monitors the gateway, and `peek`s your logs | Mac / Windows / Linux |
| **Desktop** | Menu-bar app for install + gateway + peek + live monitor — its own repo, [cheaper-desktop](https://github.com/ownasquare/cheaper-desktop) | Mac / Windows / Linux |

### The honest boundary

The **gateway** is the only piece that covers *every* surface uniformly — but it
only reaches clients that let you set a base URL. The **Claude desktop app /
claude.ai** don't expose one, so there the **plugin** (skill + hook + tiered agents)
is the lever: it can't change the base session model, but it routes *work* to
right-sized sub-agents. Together they cover the whole picture.

---

## Supported tools

Any tool that can point at a custom base URL routes through the gateway — **36 have
documented setup** (4 via the Anthropic API, 31 via the OpenAI-compatible API, plus
Gemini's native API). Routing a tool and *reading* its history are different things:
see the `peek` support table below, which covers 8 harnesses and reads 7.

> **Claude** · **Codex** · **Cursor** · **Copilot** · **Gemini** · **Goose** ·
> **OpenCode** · **Kilo Code** · **Roo Code** · **Cursor Agent** · **Kiro** ·
> **Qwen** · **Antigravity** · **Crush** · **Droid** · **Pi** · **OpenClaw** · **OMP**

See [how each one connects](https://cheaper.app/supported-tools.html). A tool that
speaks a native, non-OpenAI protocol with no compat mode needs a protocol adapter
(on the roadmap); the Anthropic and OpenAI-compatible front-ends ship today.

---

## Commands

```
cheaper <command> [options]
```

| Command | What it does |
|---|---|
| `peek [--days N] [--harness <key>] [--limit N] [--json]` | Estimate savings from your existing logs (local, read-only). |
| `install [skill agents hook gateway plugin] [--all]` | Install components. `--all` = skill+agents+hook+gateway; `plugin` = the managed bundle. |
| `gateway start` · `stop` · `status` | Run / stop / check the routing gateway. |
| `monitor` | Live routing + savings in the terminal. |
| `status` | Show what's installed and whether the gateway is running. |
| `uninstall` | Remove everything (add `--purge` to also drop `~/.cheaper`). |
| `version` · `help` | Version / help. |

<details>
<summary><b>Quickstart, one paste</b></summary>

```bash
npx cheaper peek
npx cheaper install --all      # or: npx cheaper install plugin
cheaper gateway start
export ANTHROPIC_BASE_URL=http://localhost:8787
cheaper monitor
```

`--all` installs into discovered user-level locations (`~/.claude/skills`,
`~/.claude/agents`, `settings.json` hooks). `install plugin` registers the same
skill+agents+hook as a local marketplace and enables it — pick one or the other; the
installer de-dupes if you switch.
</details>

---

## Configuration

Everything is env-configurable; defaults are safe (downgrade-only, no surprise spend).

<details>
<summary><b>Routing & gateway</b></summary>

| Variable | Default | Notes |
|---|---|---|
| `CHEAPER_PORT` | `8787` | Gateway port. |
| `ANTHROPIC_UPSTREAM_URL` | `https://api.anthropic.com` | Real Anthropic endpoint. |
| `OPENAI_UPSTREAM_URL` | `https://api.openai.com` | Real OpenAI-compatible endpoint. |
| `ROUTER_MODEL_HAIKU` / `_SONNET` / `_OPUS` | current model ids | Concrete Anthropic model per tier. |
| `OPENAI_MODEL_CHEAP` / `_MID` / `_TOP` | `gpt-4o-mini` / `gpt-4o` / `o3` | Concrete OpenAI model per tier. |
| `ROUTER_ALLOW_UPGRADE` | `false` | `true` lets the router pick *above* the requested model. |
| `ROUTER_MIN_TIER` | `haiku` | Never route below this tier. |
| `ROUTER_LONG_CHARS` | `4000` | Length that nudges a request up to at least mid. |
| `ROUTER_MODE` | `heuristic` | `triage` classifies via a live cheap-model pass. |
| `CHEAPER_PRICE_HAIKU` / `_SONNET` / `_OPUS` | `1` / `3` / `15` | Relative $/Mtok weights for the savings estimate. |
| `CHEAPER_DB` | `~/.cheaper/metrics.db` | Gateway decision log (SQLite). |
</details>

<details>
<summary><b>peek</b></summary>

| Variable | Notes |
|---|---|
| `CHEAPER_PEEK_HOME` | Override `~` for the scan (point at an alternate profile or a fixture). |
| `CLAUDE_CONFIG_DIR` | Non-default Claude Code config root. |
| `CODEX_HOME` | Non-default Codex root. |
</details>

---

## How it reads your data

`peek` is a read-only, prompt-text-only scanner. It **detects 8 harnesses and reads
chat history for 7** — Cursor keeps its history in a SQLite database `peek` does not
read yet, so it is reported as unreadable rather than quietly skipped. The end-of-chat
savings line is wired to the same 7. Support is graded honestly:

| Harness | Location | Status | Notes |
|---|---|---|---|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | ✅ supported | Real token counts; sub-agent sidechains (`isSidechain` + sibling `subagents/`); usage **deduped by `message.id`** (one turn spans multiple lines that repeat the same usage). |
| **Codex** | `~/.codex/sessions/**/rollout-*.jsonl` | ◐ experimental | Model from `turn_context`, messages from `response_item`; **tokens estimated** (codex counts are cumulative/version-fragile — summing would inflate). |
| **Gemini CLI / Grok / OpenCode / Copilot** | tool config dirs | ◐ experimental | Generic JSONL/JSON parsing; extracts what it can, fabricates nothing. |
| **Cursor** | `state.vscdb` (SQLite) | ○ not yet | DB-backed; a read-only reader is on the roadmap. |

Safeguards: tool-output bodies never enter the pipeline; unknown models are
unpriceable (no phantom savings); savings honor the never-upgrade ceiling. See
[`docs/peek.md`](docs/peek.md) and run the tests with `node --test cli/test/`.

---

## Layout

```
cheaper/                 # this repo — the open-source router
├── gateway/       # FastAPI proxy + SQLite monitor (Python; pytest)
├── cli/           # `cheaper` Node CLI + installer (bundles gateway + plugin assets)
│   └── src/peek/  # zero-dep `cheaper peek` savings estimator (node --test cli/test/)
├── docs/          # feature docs (peek, …)
├── HANDOFF.md     # how to cut a downloadable release
└── README.md
```

Two surfaces are intentionally kept in their own repos — leaner core, isolated build
pipelines: the **desktop app** at
[`cheaper-desktop`](https://github.com/ownasquare/cheaper-desktop) (Electron +
installers, consumes this package) and the **marketing site** (cheaper.app) at
`../cheaper-web/` (static HTML + Cloudflare Workers deploy).

---

## Sponsoring

Cheaper is free, local, and MIT-licensed — it *lowers* your bill instead of billing
you. Sponsorship keeps the estimates honest, adds more tools, and ships fixes faster.

<div align="center">

[![Sponsor](https://img.shields.io/badge/Sponsor%20Cheaper-♥-ec4899?style=for-the-badge)](https://github.com/sponsors/ownasquare)

</div>

If Cheaper shows you spend your bill never itemized, ⭐ the repo so other developers
find it, and consider sponsoring to keep routing across every tool honest.

---

## License

[MIT](LICENSE). An [Own a Square](https://ownasquare.com) project. "Claude",
"Codex", "Cursor" and the other tool names are their respective owners' marks,
listed to show interoperability.
