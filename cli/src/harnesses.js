'use strict';
// Shared harness-DETECTION registry for `cheaper install`. Builds directly on
// the canonical HARNESSES / isInstalled / historyDirFor already defined in
// ./peek/adapters.js (the module `cheaper peek` uses for token accounting),
// so "is this AI-coding tool present on this machine" lives in exactly one
// underlying check (isInstalled: home dir exists OR CLI resolves on PATH).
// This module never writes anything — detection only, fail-soft throughout.

const { HARNESSES: BASE_HARNESSES, isInstalled, historyDirFor } = require('./peek/adapters');

// Harnesses peek/adapters.js doesn't yet track for token accounting, but that
// `cheaper install` should still be able to DETECT (home dir and/or CLI bin
// on PATH) so the end-of-chat savings-LINE instruction can be written for them
// too.
//
// Deliberately not called "routing": detecting a harness here does not route any
// of its calls, and neither does installing into it. Nothing in this codebase
// ever SETS ANTHROPIC_BASE_URL — every occurrence of that name is a print
// statement telling the user to export it themselves. All `cheaper install`
// does for a non-Claude harness is append a Markdown instruction block to its
// global-instructions file. The earlier "tagline/routing" wording had users
// reading "✓ wired" and believing their traffic was now going through the
// gateway, when nothing had been pointed at it. These are
// detection-only stand-ins — no `collect` parser, so they never affect
// `cheaper peek`'s savings math. Anything already in peek/adapters.js
// (claude-code, codex, gemini, grok, opencode, copilot, pi, cursor) is
// reused as-is, not redefined here.
const EXTRA_HARNESSES = [
  { key: 'agent', label: 'Agent', status: 'experimental', dir: '~/.agent', bin: 'agent' },
  { key: 'windsurf', label: 'Windsurf', status: 'experimental', dir: '~/.codeium/windsurf', bin: 'windsurf' },
  { key: 'continue', label: 'Continue', status: 'experimental', dir: '~/.continue', bin: null },
  { key: 'aider', label: 'Aider', status: 'experimental', dir: '~/.aider', bin: 'aider' },
  { key: 'zed', label: 'Zed', status: 'experimental', dir: '~/.config/zed', bin: 'zed' },
  { key: 'warp', label: 'Warp', status: 'experimental', dir: '~/.warp', bin: 'warp' },
  { key: 'cline', label: 'Cline', status: 'experimental', dir: '~/.cline', bin: null },
  { key: 'amazonq', label: 'Amazon Q', status: 'experimental', dir: '~/.aws/amazonq', bin: 'q' },
  { key: 'tabnine', label: 'Tabnine', status: 'experimental', dir: '~/.tabnine', bin: 'tabnine' },
  { key: 'cody', label: 'Sourcegraph Cody', status: 'experimental', dir: '~/.cody', bin: 'cody' },
  { key: 'replit', label: 'Replit', status: 'experimental', dir: '~/.config/replit', bin: 'replit' },
  { key: 'bolt', label: 'Bolt', status: 'experimental', dir: '~/.bolt', bin: null },
  { key: 'v0', label: 'v0', status: 'experimental', dir: '~/.v0', bin: null },
];

// Merge, de-duped by key. peek/adapters.js's own entries win when a key
// collides (they may carry a real `collect` parser); EXTRA_HARNESSES only
// fills in keys peek doesn't already define.
const seen = new Set(BASE_HARNESSES.map((h) => h.key));
const HARNESSES = BASE_HARNESSES.concat(EXTRA_HARNESSES.filter((h) => !seen.has(h.key)));

// Read-only, fail-soft: every known harness definition plus whether it was
// found on this machine (home/config dir present and/or its CLI on PATH).
// Never throws — one def's check failing reports `installed: false` for
// just that entry, it never aborts detection for the rest.
function detectHarnesses() {
  const out = [];
  for (const def of HARNESSES) {
    let installed = false;
    try { installed = !!isInstalled(def); } catch { installed = false; }
    out.push({ key: def.key, label: def.label || def.key, status: def.status, installed });
  }
  return out;
}

module.exports = { HARNESSES, detectHarnesses, isInstalled, historyDirFor };
