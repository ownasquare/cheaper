# Cheaper.app end-of-chat savings line

**Date:** 2026-08-06 · **Repo:** `ownasquare.com/cheaper-app` · **Branch:** `main` (uncommitted working tree)

## What changed & why

Every completed chat now ends with a **Cheaper.app-branded savings line** instead of the
old adaptive-model-router "Handled at the Opus tier…" tier tag. The line reports the real
per-chat savings and which tiers did the work, e.g.:

```
Cheaper.app saved ~$5.60 and 276.0K tokens by using haiku tier for 8 calls, sonnet tier for 4 calls, opus tier for 3 calls.
```

Goal: at the end of **every** chat, in **every** harness Cheaper supports, the user sees —
branded to Cheaper.app — exactly what Cheaper saved them, whenever Cheaper actually did
something (skill / hook / plugin / gateway).

### Honesty model (decided with the user)

- **Real when gateway, else estimate.** If the request went through the Cheaper gateway and
  it has session-tagged rows, the numbers are **exact** (`$5.60`). Otherwise they are a
  transcript-derived **estimate**, marked with a leading `~` (`~$5.60`).
- **Never fabricate.** Unknown/unpriceable models are excluded; sub-cent savings round away
  (no "$0.00 saved"); if nothing was routed cheaper, the line degrades to
  `Cheaper.app kept this chat on the <tier> tier — no cheaper routing was warranted.` or is
  omitted entirely. This mirrors the existing peek rule "never report a saving that didn't happen."
- **Realized, not prospective.** The full `cheaper peek` report is prospective ("what you'd
  save if you adopt Cheaper", from logs of un-routed runs). The tagline is **realized**:
  baseline = the chat's ceiling model (the top tier its top-level turns ran on); actual = the
  cheaper tiers Cheaper routed sub-tasks to. `savings = Σ_belowCeiling(cost@ceiling − cost@actual)`.

## New engine: `cheaper peek --tagline`

`cheaper peek --tagline [--transcript <file> | --session <id> | --current] [--harness <key>] [--json]`
prints the single branded line for ONE conversation (or nothing).

- **`cli/src/peek/tagline.js`** (new) — `realizedFromRecords()` (ceiling-vs-actual math),
  `fromGateway()` (maps a session-scoped gateway `/metrics` summary → exact numbers),
  `fetchGatewaySession()` (zero-dep local HTTP GET, short timeout, fails soft),
  `buildTagline()` (the branded string + honesty gates), `computeSavings()` (gateway-exact
  first, transcript estimate fallback), `run()`.
- **`cli/src/peek/adapters.js`** — session/`--current`/`--transcript` file scoping
  (`scopeFiles`, `scopedFiles`, `sessionStem`, `transcriptFiles`); registered **`pi.dev`**.
- **`cli/src/peek/scan.js`** — threads `session`/`current`/`transcript` through.
- **`cli/src/peek/index.js`** — parses the new flags, dispatches `--tagline` to `tagline.js`.
- **`cli/bin/cheaper.js`** — help for `peek --tagline` and the new `taglines` command.

## Claude Code wiring (plugin)

- **`router-policy.md`** (the always-on injected hook context): replaced the final sentence
  *"Tag the reply with which tier handled it"* with an instruction to append the output of
  `cheaper peek --tagline --current --harness claude-code`.
- **`hooks.json`**: added a **`Stop` hook** running **`stop-tagline.js`** (new) — a read-only,
  always-exit-0 backstop that reruns the tagline against the exact `transcript_path` Claude
  Code hands it, resolving `cheaper` via the sibling of `process.execPath`.
- **`SKILL.md` / `README.md`**: "Be transparent about routing" section reworked from tier-tag
  to the savings line.
- Applied in **all three** locations: product source `cli/assets/plugin/`, installed
  marketplace `~/.cheaper/marketplace/plugins/adaptive-model-router/`, and the live cache
  `~/.claude/plugins/cache/cheaper-local/adaptive-model-router/0.2.0/`.

## Gateway (exact per-session numbers)

- **`gateway/app/metrics.py`**: additive `session` column (ALTER-migrated for old DBs),
  `record(..., session="")`, `summary(..., session=None)` — a **parameterized** `WHERE session = ?`
  filter (no injection; no cross-session leak; `session=None` = unchanged behavior).
- **`gateway/app/app.py`**: captures `x-session-id` on both `/v1/messages` and
  `/v1/chat/completions`; `/metrics?session=` scopes the summary. (`x-cheaper-session` was
  later retired — see the 2026-08-06 local-savings-store spec — because session attribution
  now comes from the provider-request-id join plus the transcript's own `sessionId`.)
- Synced to shipped `cli/assets/gateway/` and installed `~/.cheaper/gateway/` (gateway was
  stopped; picks up on next `cheaper gateway start`).

## Cross-harness wiring: `cheaper taglines`

- **`cli/src/tagline_install.js`** (new) — writes a **managed, idempotent, clearly-marked**
  block (`<!-- cheaper:tagline:start … end -->`) into each harness's conventional global
  instructions file, telling that tool to append `cheaper peek --tagline --current --harness <key>`.
  Targets: Codex→`~/.codex/AGENTS.md`, Grok→`~/.grok/AGENTS.md`, PI.dev→`~/.pi/AGENTS.md`,
  Copilot→`~/.copilot/AGENTS.md`, Gemini→`~/.gemini/GEMINI.md`, OpenCode→
  `~/.config/opencode/AGENTS.md`, Cursor→`~/.cursor/rules/cheaper-tagline.mdc`. Claude Code is
  intentionally excluded (handled by the plugin). Flags: `--all`, `--harness <key>`, `--remove`,
  `--dry-run`. Only touches detected harnesses by default.
- **Applied on this machine** to the 5 detected harnesses: Codex, Grok, PI.dev, Copilot, Cursor.

## Affected surfaces / files

Modified: `cli/bin/cheaper.js`, `cli/package.json` (→ v0.2.0), `cli/src/peek/{adapters,index,scan}.js`,
`cli/test/peek.test.js`, `gateway/app/{app,metrics}.py`, `gateway/tests/test_metrics.py`,
and the mirrored `cli/assets/{plugin,gateway}/…`.
New: `cli/src/peek/tagline.js`, `cli/src/tagline_install.js`, `cli/test/tagline_install.test.js`,
`cli/assets/plugin/hooks/stop-tagline.js` (+ deployed copies under `~/.cheaper` and `~/.claude`).

## Validation / proof

- **Unit:** `node --test cli/test/` → **23/23 pass** (realized-savings math, ceiling logic,
  cross-family pricing, `~`-vs-exact invariant, unknown-model exclusion, sub-cent suppression,
  gateway uniform-downgrade tokens, true-top-tier brand line, session/`--transcript`/`--current`
  scoping, sub-agent-transcript inclusion, **main-loop-excluded breakdown**, installer
  idempotency + removal, Cursor `.mdc`).
- **Breakdown honesty (v0.2.3):** the line's tier breakdown lists ONLY the calls Cheaper
  routed to a cheaper tier (`savedTierHist`), never the un-routed main-loop / ceiling calls —
  a plugin/skill can't change the session model, so counting the main loop as "Cheaper using
  opus" overstated its role and made the count balloon while savings stayed flat. Now:
  `by using sonnet tier for 12 calls instead of opus`. Gateway path gets `downgraded_by_tier`.
- **Cache-aware pricing + spend line + link (v0.2.4):** transcripts count cache-read tokens in
  the input count, and those bill at ~0.1x (writes ~1.25x) — `peek` was charging every input
  token at full rate, inflating totals **~7×** ($1,038 naive vs **$148 real** for a live
  session). `pricing.costOfDetailed` now prices `inFresh/cacheCreate/cacheRead/outTok` correctly;
  this also corrected the savings itself (the shipped `~$9.25` was `~$3.23` cache-aware). The
  line now adds a whole-session-spend sentence (`You spent ~$X and N tokens on this session.`)
  and a `--format markdown|plain` option so "Cheaper.app" renders as a live link to
  https://cheaper.app in harnesses that render markdown (26/26 CLI tests).
- **Sub-agent attribution (v0.2.2):** a chat's sub-agents live under a sibling `<id>/` dir;
  `--current` and the Stop hook's `--transcript` now scope by session id so those (usually
  Sonnet/Haiku) savings roll into the chat total instead of measuring only the Opus main loop.
  Verified live on this session: `~$9.25 and 739.1K tokens … sonnet ×12, opus ×161`.
- **Gateway:** `python3 -m pytest gateway/tests` → **23/23 pass** (incl. session-scoping,
  None-vs-empty semantics, `tokens.downgraded`, legacy-DB migration).
- **Adversarial verification** (4-agent workflow, run `wf_6fd48327-7f4`): 12 findings (4 high),
  **all fixed and re-tested**. Highs: cross-family price inflation, gateway "$X and 0 tokens"
  contradiction, Stop-hook stdout-truncation, `--current` cross-project misattribution.
- **Live CLI:** `cheaper peek --tagline --transcript <fixture>` →
  `Cheaper.app saved ~$5.60 and 276.0K tokens by using haiku tier for 8 calls, sonnet tier for 4 calls, opus tier for 3 calls.`
- **Stop hook:** fed the Claude Code Stop JSON on stdin → relays the branded line; missing/garbage
  stdin → silent, exit 0.
- **Gateway-exact path:** mock gateway returning a session summary → CLI prints `$2.50` **without** `~`.
- **Global CLI:** `npm install -g cli` → `cheaper 0.2.0`; `cheaper taglines` lists all 7 targets.

## Deploy status

Local/dev only. Global `cheaper` CLI updated on this machine (v0.2.0). Harness instruction
blocks written to this machine's harness homes. **Not committed** and **not published to npm.**
Gateway not restarted (was stopped).

## Known follow-ups / limits

- **Gateway-exact needs a session header.** Claude Code / Codex don't forward `x-session-id`
  today, so the exact path stays dormant until a harness/wrapper sends it; the `~` transcript
  estimate is what renders now. (Fully built + unit-proven end to end via a mock.) Note:
  `x-cheaper-session` was retired — session attribution now comes from the provider-request-id
  join plus the transcript's own `sessionId`, never a client-supplied header.
- **Best-effort harness conventions.** Codex/Grok/PI.dev/Copilot/Cursor blocks assume each tool
  reads the AGENTS.md/`.mdc` at the written path. Confirmed-effective: **Claude Code** (plugin) and
  any harness routed through the **gateway**. Harmless if a tool ignores the file.
- **Codex sync automations** may re-sync `~/.codex/AGENTS.md`; if so, add the block to the sync
  source or re-run `cheaper taglines`.
- **Stop-hook visibility.** The primary visible mechanism is the model appending the line
  (per the injected policy); the Stop hook is a transcript-level backstop (may render as hook
  output rather than inside the message bubble).
- Not committed — commit/publish when ready (`cli/` npm publish + plugin marketplace bump).
