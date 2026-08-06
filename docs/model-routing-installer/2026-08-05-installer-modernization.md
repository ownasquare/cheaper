# Cheaper installer — modernization for Claude plugin registry v2 (2026-08-05)

## Summary
The `cheaper` CLI installer (adaptive Claude model routing) was fixed so it
actually works on a fresh Claude account. The previous installer silently failed
against the current Claude plugin system and shipped two latent asset bugs that
disabled the tiered routing agents. All paths are now verified end-to-end against
the real `claude` CLI.

## Why it was broken
1. **Plugin never loaded.** Modern Claude uses plugin registry **v2**: plugins load
   only via a *marketplace* recorded in `~/.claude/plugins/known_marketplaces.json`
   + `installed_plugins.json` + `settings.json` (`extraKnownMarketplaces` /
   `enabledPlugins`). The old `installPlugin()` just `copyDir`-ed a bare folder into
   `~/.claude/plugins/adaptive-model-router/`, which Claude ignores. The plugin and
   its three bundled tiered agents never activated.
2. **Agents had invalid YAML frontmatter.** `agents/router-*.md` used an unquoted
   multi-line `description:` containing `<example>` blocks and blank lines. `claude
   plugin validate` reports: *"YAML frontmatter failed to parse … all frontmatter
   fields silently dropped."* That means `model: haiku|sonnet|opus` was discarded at
   runtime — the tier override (the whole mechanism) was inert. Affected both the
   plugin agents and standalone `~/.claude/agents/` copies (same source).
3. **Plugin `hooks.json` used the old schema** (`{ SessionStart: [...] }`) instead of
   the current `{ "hooks": { SessionStart: [...] } }`, so the plugin loaded with
   `Status: ✘ failed to load — Hook load failed`.

## What changed (files)
- `cli/src/install.js`
  - New `installAgents()` → installs the 3 tiered subagents into `~/.claude/agents/`.
  - `--all` / default = **skill + agents + hook + gateway** (discovered user-level
    locations; no plugin-registry dependency). `plugin` is opt-in and supersedes the
    standalone three (de-dup removes standalone skill/agents + de-wires the hook).
  - Rewrote `installPlugin()` → builds a local `directory` marketplace at
    `~/.cheaper/marketplace`, then registers it: prefers the `claude` CLI
    (`plugin marketplace add` + `plugin install`), falls back to direct v2-registry
    writes matching the exact schema the CLI produces. Cleans the legacy bare dir.
  - Safety: read-modify-write paths use `readJSONForUpdate` (throws on a
    present-but-malformed file instead of clobbering it); hook entries are matched by
    exact command identity (`isCheaperHookEntry`) not a loose `router-policy`
    substring; `claude` is invoked via `runClaude()` (shell:true on win32 so
    `claude.cmd` can run).
- `cli/src/paths.js` — added `AGENTS_DIR`, marketplace/registry paths, `PLUGIN_ID`,
  legacy-dir path.
- `cli/src/util.js` — `readJSONForUpdate` (strict), atomic `writeJSON` (temp+rename,
  one-time `.bak`), plus `removePath`, `nowIso`, `whichSync`.
- `cli/bin/cheaper.js` — `status` now reports `agents`, detects the plugin via the
  registry (not the bare dir), and reflects real hook wiring; help text updated.
- `cli/assets/plugin/agents/router-*.md` — valid `description: |-` block-scalar
  frontmatter (model/effort/name preserved).
- `cli/assets/plugin/hooks/hooks.json` — corrected to the `{ "hooks": { … } }` schema.
- `cli/assets/plugin/skills/adaptive-model-router/SKILL.md` — removed the inert
  `model: haiku`/`effort: low` frontmatter and the false "this skill runs on Haiku"
  claim (a skill runs on the session model; savings come from delegating to agents).
- Docs: `README.md`, `HANDOFF.md`, `cli/assets/plugin/README.md` updated.

## Validation / proof (real execution on macOS, Node 20, Python 3.11)
- Installer suite: **31/31**. Safety suite: **8/8**. CLI-path test: **3/3**.
  Gateway pytest: **19/19**.
- Verified with the real `claude` CLI: `claude plugin validate` passes for both the
  marketplace manifest and the plugin bundle; `claude plugin list` shows
  `adaptive-model-router@cheaper-local  Status: ✔ enabled` — via **both** the CLI
  branch and the direct-registry fallback.
- Safety proofs: a malformed `settings.json` / `installed_plugins.json` is refused
  (left byte-identical); a user's own hook mentioning `router-policy` is preserved;
  unrelated `settings.json` keys (permissions, enabledPlugins, model) survive.
- 5-defect adversarial review (13 agents) confirmed + fixed all findings; 4 other
  claims were verified as false and rejected.

## Live deploy status
- Installed on this machine's real account via
  `node cli/bin/cheaper.js install plugin gateway`.
  `claude plugin list` → `adaptive-model-router@cheaper-local  Status: ✔ enabled`,
  and all 10 pre-existing user plugins remained enabled (registry merge preserved
  them). Gateway files at `~/.cheaper/gateway` (not started).
- Takes effect in **newly started** Claude sessions.

## Known follow-ups
- `shopify@claude-plugins-official` fails to load in this environment — **pre-existing
  and unrelated** (official marketplace renamed it to `shopify-plugin`). Tracked as a
  separate task.
- `pluginRegistered()` is version-agnostic, so a future plugin **version bump**
  re-run via the fallback path would short-circuit rather than update. Not an issue at
  the current pinned v0.2.0; revisit if the plugin version changes (prefer the CLI
  `plugin update` path, or make `pluginRegistered()` version-aware).
- npm publish of `cheaper` and the signed desktop installers remain per `HANDOFF.md`
  (unchanged by this work); the CLI runs fine from the local repo in the meantime.

## Follow-on: uninstall + cross-platform "install everything" (same day)

Added so the native installers (Win/macOS/Linux) can install **everything** and ship a
simple uninstall.

- **`cheaper uninstall [components] [--purge]`** (`cli/src/uninstall.js`) — reverses every
  install action: removes the skill, agents, hook (de-wire + policy file), plugin
  (`claude plugin uninstall` + `marketplace remove`, with a direct-registry fallback +
  marketplace/cache cleanup), gateway (stops it first), and the CLI launcher. Only ever
  touches this tool's own artifacts; `--purge` also deletes `~/.cheaper`.
  Verified: **21/21** — removes exactly our artifacts, **preserves** unrelated
  plugins/marketplaces/hooks/settings, real `claude plugin list` no longer shows it,
  `--purge` works, idempotent.
- **`cli` install component + `cheaper` launcher** (`cli/src/clilink.js`) — copies a
  self-contained CLI to `~/.cheaper/cli` and writes an executable `cheaper` launcher
  (`~/.local/bin/cheaper` on unix; `%LOCALAPPDATA%\cheaper\bin\cheaper.cmd` on Windows)
  so the desktop delivery provides the command line without npm. Verified **17/17**
  (launcher runs and reports status; uninstall removes it).
- **Programmatic `install()` / `status()`** exported from `install.js` so the desktop app
  shares one engine with the CLI.
- **Desktop app** (`desktop/main.js`, `preload.js`, `renderer/index.html`) — menu-bar/tray
  app with **Install everything** (`cli` + `plugin` + `gateway`) and **Uninstall**, plus a
  status panel and the live gateway monitor. Bundles the whole `cli` as an Electron
  `extraResource`; runs it via `ELECTRON_RUN_AS_NODE`; fixes `PATH` at launch so
  `claude`/`node`/`python3` resolve when opened from Finder/Explorer.
  `desktop/package.json` build config targets `.dmg` (arm64+x64), `.exe` (NSIS),
  `.deb`/`.rpm`/`.AppImage`. **Note:** the Electron GUI itself was not run in-sandbox
  (no Electron/GUI); all JS passes `node --check` and the CLI engine it drives is fully
  tested. Signed binaries are produced on each OS via the tag-triggered release workflow.
- **Removing the app itself** stays an OS action (Trash / Add-or-Remove Programs / package
  manager); the in-app Uninstall (or `cheaper uninstall`) clears the Claude-side artifacts.

### Hardening pass (adversarial review of the new code)

A 13-agent adversarial review of the uninstall/launcher/desktop code confirmed 8
defects (0 rejected); all fixed and re-tested:
- **[high]** Desktop `startGateway()` ran `pip install` synchronously on the Electron
  main thread → froze the UI. Now async (pip child → uvicorn on close).
- **[high]** `uninstall` called `process.kill(pid)` from a persistent pidfile with no
  identity check → could SIGTERM an unrelated process after PID reuse. Now rejects
  `pid<=1`, probes with `kill(pid,0)`, and verifies the process is uvicorn (`ps`/
  `tasklist`) before signalling.
- **[med]** Long-lived gateway `spawn` had no `'error'` listener → ENOENT crashed the
  app. Added.
- **[med]** Gateway orphaned on quit (Cmd+Q bypassed the tray handler). Added
  `app.on('before-quit', stopGateway)`.
- **[med]** `cli` launcher baked an absolute (possibly nvm/fnm) Node path → misleading
  "Node not found" for GUI installs and staleness after a Node switch. Launcher now
  resolves Node at **run time** (`command -v node` / `where node`) with a fallback,
  and install no longer hard-fails when Node isn't visible at install time.
- **[low]** PATH-membership hint was falsely suppressed for desktop installs → now
  always shown.
- **[low]** A malformed shared registry aborted plugin-uninstall before the
  filesystem scrub → marketplace/cache orphaned. Removals now run first; per-file
  de-registration is isolated so one malformed file doesn't block the others.

Test tally after fixes: install 31/31, safety 8/8, uninstall 21/21, cli 17/17,
hardening2 9/9, gateway pytest 19/19 (**105** assertions), all `node --check` clean.

### npm distribution run-pass (caught a real UX bug)

Verified the actual publish path by `npm pack`-ing the tarball and installing it the way
`npx`/`npm i -g` would (sandboxed). Findings + fixes:
- **`npx cheaper install --all` would have FAILED.** The package is named `cheaper`
  but its only bin was `cheaper`, so `npx cheaper …` → `command not found` (npm does not
  fall back to a differently-named single bin). **Fix:** added a `cheaper` bin alias in
  `cli/package.json` (`bin: { cheaper, cheaper }` → same script). Re-verified:
  `npx cheaper --version` → `cheaper 0.1.0`, and installing the tarball + running
  `install --all` lands skill/agents/hook/gateway.
- **Tarball hygiene:** it shipped `__pycache__/*.pyc` (from an earlier gateway pytest run
  polluting `cli/assets/gateway`) and the gateway test suite. **Fix:** cleaned the source,
  added `cli/.npmignore`, and switched `files` to an explicit glob allowlist
  (`assets/gateway/app/*.py` + requirements + .env.example, `assets/plugin`) — a `files`
  allowlist ignores `.npmignore` for its entries, so globs are the deterministic control.
  Tarball now 30 files / 44 kB (was 39 / 72 kB); run-pass 8/8.
- **Still required to actually use `npx cheaper`:** the package is NOT published (npm
  `404`). Publish via `cd cli && npm publish` or the tag-triggered `publish-npm` job, and
  claim the name (or scope it) before someone else does.

Concurrent note: another agent added a `peek` command (`cli/src/peek.js`, plus desktop
`peek:scan`/`open:external` IPC + a "Savings peek" renderer panel) and refined
`desktop/package.json`/`bin/cheaper.js` during this work; those changes were preserved.

### Live account change + code-signing pipeline

- **Removed** the stale `shopify@claude-plugins-official` plugin from the user's real
  `~/.claude` at their explicit request (`claude plugin uninstall`; verified gone). It was
  failing to load (renamed upstream to `shopify-plugin`), unrelated to this work.
- **Clarified scope**: the routing plugin/skill/agents/hook are installed for **Claude
  Code only** (`~/.claude`), NOT for the other harness homes on the machine
  (`~/.codex`/`~/.cursor`/`~/.grok`/`~/.copilot`). The only cross-harness lever is the
  gateway (`ANTHROPIC_BASE_URL`), currently installed but stopped.
- **Signing pipeline** (`SIGNING.md` + `desktop/buildResources/`): CI already *produces*
  all binaries on tag push; *signing* needs user-supplied certs as GitHub secrets. Wired
  both hooks, each env-gated (no-op without creds, so unsigned builds still succeed) and
  verified by dry-run:
  - macOS notarization — `notarize.js` afterSign hook + `hardenedRuntime` + entitlements;
    workflow passes `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`. **Decision:
    ship macOS unsigned for now** (no Apple Developer account yet); scaffolding is ready.
  - Windows — **Azure Trusted Signing** (`sign.js` `win.sign` hook via
    `trusted-signing-cli`); workflow installs the tool on the Windows runner when
    `AZURE_CLIENT_ID` is set and passes `TRUSTED_SIGNING_*` + `AZURE_*` secrets. **Decision:
    chosen + wired.** Not runnable/testable in-sandbox (needs a Windows runner + the user's
    Azure Trusted Signing account); YAML + hook syntax validated, hooks confirmed to skip
    cleanly without creds.
  - macOS notarization also supports the **App Store Connect API-key** path (preferred over
    the Apple-ID password): secrets `APPLE_API_KEY_P8`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`;
    a mac-only workflow step writes the `.p8` to a temp file and exports `APPLE_API_KEY`.
  - **Dry-run**: `workflow_dispatch` (Actions → Release → Run workflow, `dry_run` default
    true) builds UNSIGNED installers on all three OSes and uploads them as run artifacts.
    The `release` (GitHub Release + R2) and `publish-npm` jobs are gated with
    `if: startsWith(github.ref, 'refs/tags/')`, so manual runs never publish — real releases
    happen only on a `v*` tag push. Workflow YAML validated (12/12 checks).

### Live install + full-command QA — 2026-08-06 (npm publish blocked)

Attempted to publish `cheaper` to npm on the user's request. **Blocked**: the machine is
not logged into npm (`npm whoami` → `ENEEDAUTH`); logging in requires the user's credentials
(an action the assistant may not perform). The package is verified publish-ready
(`npm publish --dry-run`: 30 files, 44 kB, both `cheaper`/`cheaper` bins). To publish:
`cd cli && npm publish --access public` after `npm login`, or set `NPM_TOKEN` + push a
`v0.1.0` tag.

Installed the CLI globally from the local package (`npm install -g <tarball>` into the
writable nvm prefix — no sudo/auth) and exhaustively tested every README command live:
- `--help` / `--version` / `status` ✅
- `peek` + `--json`/`--days`/`--harness`/`--limit` ✅ (6/6) — proven to DROP a `tool_result`
  secret from both JSON and human output while keeping user prompts (sanitizer verified).
- `install --all` / `install plugin` / `install cli` / `uninstall` (+`--purge`) ✅ (global
  smoke 11/11; plugin registers + `claude plugin validate`/`list` clean; uninstall preserves
  other plugins).
- `gateway start`/`stop`/`status` ✅; endpoints `/healthz` `/metrics` `/dashboard`
  `/v1/messages` (Anthropic) + `/v1/chat/completions` (OpenAI-compat) ✅ (7/7 via a mock
  upstream — no real API calls or keys). Routing verified: opus+simple→haiku; proof→stays
  opus; gpt-4o→gpt-4o-mini; `/metrics` logs the decisions.
- `monitor` ✅. All config env vars wired (`ROUTER_MODE`, `ROUTER_ALLOW_UPGRADE`,
  `ROUTER_MODEL_*`, `CHEAPER_DB`, `CHEAPER_PORT`, `CHEAPER_PEEK_HOME`, upstream URLs).

Fixes made during QA (things that didn't work):
1. **`cheaper` bin alias** — package name ≠ bin name, so `npx cheaper` → `command not
   found`. Added `bin.cheaper` → same script.
2. **`gateway start` pip portability** — `--break-system-packages` errors on old/venv pip.
   `cli/src/gateway.js` now tries a plain `pip install` first and only falls back to the flag
   for externally-managed (Homebrew/PEP-668) pythons.
3. **peek Cursor line** — the audit's one confirmed doc/output mismatch: removed the redundant
   `note` on the Cursor harness def (`cli/src/peek/adapters.js`) so `peek` prints the clean
   `DB-backed (not yet readable)` (render.js's sqlite fallback), matching README line 78.

A 5-agent README-vs-code audit found the README otherwise accurate (Cursor line was the only
confirmed discrepancy).

**Repo restructure (concurrent, mid-session):** the `cheaper/` monorepo was split into
**`cheaper-app`** (this CLI — canonical), **`cheaper-desktop`** (Electron app), and
**`cheaper-web`** (marketing site). All installer/uninstall/peek/gateway fixes live in
`cheaper-app/cli`. The desktop signing pipeline (`notarize.js`/`sign.js`/entitlements) and the
signed-installer release workflow moved to `cheaper-desktop`; `cheaper-app` publishes only the
CLI to npm. Paths in earlier sections that read `cheaper/…` now resolve under `cheaper-app/…`.
