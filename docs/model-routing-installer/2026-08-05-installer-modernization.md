# Cheaper installer — modernization for Claude plugin registry v2 (2026-08-05)

## Summary
The `cheaperapp` CLI installer (adaptive Claude model routing) was fixed so it
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
- npm publish of `cheaperapp` and the signed desktop installers remain per `HANDOFF.md`
  (unchanged by this work); the CLI runs fine from the local repo in the meantime.
