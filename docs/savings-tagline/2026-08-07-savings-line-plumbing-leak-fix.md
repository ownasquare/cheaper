# Fix: the savings-line plumbing leaked into the chat

**Date:** 2026-08-07 · **Repo:** `ownasquare.com/cheaper-app` · **Branch:** `main` (uncommitted)

## The bug

At the end of a Claude Code reply the user saw **two** things where there should have
been one:

1. the raw command `cheaper peek --tagline --transcript "…" --format markdown`, plus a
   collapsed tool block labelled *"Cheaper.app savings line (exact-chat transcript)"* — **noise**;
2. the actual branded line (`Cheaper.app saved 🟢 about $3.99 and 6.4M tokens …`) — **correct**.

Only (2) is the product. (1) is the machinery that produces it, showing through.

## Root cause

Every surface that wired the savings line asked the **model** to run a shell command and
paste its output:

- `cli/assets/plugin/hooks/inject-tagline-cmd.js` injected the literal
  `cheaper peek --tagline --transcript <path> --format markdown` and said "run EXACTLY this";
- `cli/assets/plugin/hooks/context/router-policy.md` (injected verbatim on **every** turn)
  repeated the instruction;
- `cli/assets/plugin/skills/adaptive-model-router/SKILL.md` presented it in a fenced block.

In Claude Code a model-run command is *never* invisible, so this produced two artifacts per
reply. Measured structurally against a live 660-entry transcript
(`98445d55-…jsonl`, counts only, no bodies read):

```
assistant:text        = 5   # the line itself AND the command echoed as message text
assistant:tool_use:Bash = 3   # the visible shell calls
user:tool_result      = 3
```

So both failure modes were real and concurrent: the model **ran** the command (visible tool
block) *and* **echoed** it as prose. Handing a model a command in its always-on context is
enough to make it reproduce that command in the reply.

The `Stop` hook (`stop-tagline.js`) was only ever a transcript-level backstop — its stdout is
not rendered in the message bubble, which is why the line appeared exactly once, from the
model, and not twice.

## The fix

**The hook computes the line; the model only appends text. Nothing is executed by the model.**

- **`cli/assets/plugin/hooks/inject-tagline-cmd.js`** — rewritten. It now resolves the `cheaper`
  binary itself (same `CHEAPER_BIN` → node-sibling → PATH ladder as `stop-tagline.js`), runs
  `peek --tagline --transcript <this chat> --format markdown` in-process with an 8s cap and
  `CHEAPER_QUIET=1`, and injects the **finished line** wrapped in an explicit contract: append
  verbatim, run nothing, quote nothing. Filename deliberately unchanged so an older cached
  `hooks.json` still resolves to a real file.
- **`hooks.json`** — the injector moved to `UserPromptSubmit` **only** (at `SessionStart` the
  transcript is empty, so it was a wasted subprocess); timeout 10 → 15 so the hook budget
  exceeds the script's own 8s cap. `Stop` unchanged.
- **`router-policy.md`** — the closing paragraph no longer contains a command. It states the
  run-nothing rule, the never-echo rule, and "no line injected → omit it, never invent one."
- **`SKILL.md`** — the fenced command block is gone, replaced by the same four rules.
- **`cli/src/tagline_install.js`** — other harnesses (Codex/Grok/PI.dev/Copilot/Gemini/OpenCode/
  Cursor) have no per-chat hook, so they must still run the command; the managed block now adds
  *"Run it silently … never print, echo, quote, or narrate the command itself"*, which fixes the
  echo half of the bug there too.

### Trade-off (accepted, stated honestly)

`UserPromptSubmit` fires *before* the reply it belongs to, so the injected line measures the chat
**through the previous turn**. It therefore slightly **under-reports and never over-reports** —
the safe direction, consistent with peek's standing rule *"never report a saving that didn't
happen."* On the **first turn** of a chat nothing has been measured yet, so no line is injected
and the reply correctly carries none. Cost is negligible: the CLI renders in **0.12s** on a
55.2M-token, 660-entry transcript.

The lifetime ledger is unaffected — `peek/ledger.js` is keyed by session id and last-write-wins,
so the injector and the Stop hook running for the same chat overwrite rather than double-count.

## Affected files

Modified: `cli/assets/plugin/hooks/inject-tagline-cmd.js`, `cli/assets/plugin/hooks/hooks.json`,
`cli/assets/plugin/hooks/context/router-policy.md`,
`cli/assets/plugin/skills/adaptive-model-router/SKILL.md`, `cli/src/tagline_install.js`.
New: `cli/test/inject_tagline.test.js`.

Deployed to the live locations Claude Code actually reads:
`~/.cheaper/marketplace/plugins/adaptive-model-router/`,
`~/.claude/plugins/cache/cheaper-local/adaptive-model-router/0.2.0/`, and
`~/.cheaper/router-policy.md` (the standalone hook's copy).

## Validation

- **Unit:** `node --test cli/test/` → **57/57 pass** (53 before + 4 new). The new
  `inject_tagline.test.js` asserts the injected text contains the rendered line, contains
  **no** `peek --tagline` / `--transcript` string for the model to run or echo, carries the
  run-nothing and never-quote rules, stays silent on missing/absent/empty transcripts, always
  exits 0, and that the **shipped** `router-policy.md` / `SKILL.md` contain no runnable tagline
  command (guards the always-on context, which is where the echo came from).
- **Hook driven as Claude Code drives it** (event JSON on stdin) against a real transcript →
  emits the branded line with no command; missing transcript and `{}` → empty stdout, exit 0.
- **`hooks.json`** re-parsed after editing (`python3 -m json.tool`).
- **Timing:** `/usr/bin/time -p cheaper peek --tagline --transcript <55.2M-token session>` →
  `real 0.12`.

## Deploy status

Local only. **Not committed** (the working tree also carries unrelated in-flight gateway-auth /
`api.js` / `token.js` work from another session — do not sweep those into a commit for this fix).
Not published to npm.

## Known follow-ups

- **Existing sessions keep the old hooks.** Claude Code loads plugin hooks at session start, so
  the fix takes effect in **newly started** chats.
- **Duplicate policy injection.** `~/.claude/settings.json` still wires the standalone
  `SessionStart`/`UserPromptSubmit` hooks that `cat ~/.cheaper/router-policy.md` *while* the
  plugin is enabled, so the routing policy is injected twice every turn. Both copies now carry
  the corrected text, so this is wasted context rather than a behavioural bug. The installer's
  own rule is "plugin supersedes standalone" — `cheaper install plugin` calls
  `dewireStandaloneHook()` and clears it. Left alone here because it edits global harness config
  the reported bug didn't require touching.
- **Non-Claude harnesses still execute a command.** They have no per-chat hook, so the visible-
  tool-call class of the bug can only be mitigated by instruction there, not eliminated. A
  per-harness pre-turn hook (where the harness supports one) would close it properly.
