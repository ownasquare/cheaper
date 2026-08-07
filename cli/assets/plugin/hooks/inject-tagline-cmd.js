#!/usr/bin/env node
'use strict';
// Cheaper.app — inject the FINISHED end-of-chat savings line for THIS chat.
//
// (Filename kept for backwards compatibility: an older plugin copy's hooks.json may
// still point here. It no longer injects a *command* — see below.)
//
// History / why this shape:
//   v1 injected the literal `cheaper peek --tagline --transcript <path>` command and
//   told the model to run it and paste the output. That worked, but it leaked the
//   plumbing into the chat: the model's shell call rendered as a visible tool block,
//   and the model frequently echoed the command itself as message text. The user saw
//   two artifacts where they should have seen one clean savings line.
//
//   v2 (this file) runs the CLI *here*, inside the hook, and injects the already-
//   rendered line. The model then has nothing to execute and nothing to quote — it
//   just appends one line of text. No tool call, no echoed command, same numbers.
//
// Trade-off, stated honestly: a UserPromptSubmit hook fires before the reply it
// belongs to, so the line measures the chat through the PREVIOUS turn. It therefore
// slightly under-reports and never over-reports, which is the safe direction and
// matches peek's standing rule "never report a saving that didn't happen". On the
// very first turn of a chat there is nothing measured yet, so nothing is injected and
// the reply correctly carries no line.
//
// Contract: read-only, fails silent, always exits 0. Any problem prints nothing, and
// the policy's "omit the line if none was provided" instruction still stands.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// This chat's transcript. Prefer the path the hook hands us; otherwise reconstruct it
// the way Claude Code names transcripts: <config>/projects/<cwd-slug>/<session_id>.jsonl.
function transcriptPath(ev) {
  if (ev && typeof ev.transcript_path === 'string' && ev.transcript_path) return ev.transcript_path;
  if (ev && ev.session_id && ev.cwd) {
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const slug = String(ev.cwd).replace(/[/.]/g, '-');
    return path.join(base, 'projects', slug, String(ev.session_id) + '.jsonl');
  }
  return null;
}

// Resolve the `cheaper` CLI: an explicit override the installer can set, then the
// binary sitting next to the node running this hook (same nvm/npm bin dir), else a
// plain PATH lookup. Mirrors stop-tagline.js so both hooks agree on which CLI runs.
function resolveCheaper() {
  if (process.env.CHEAPER_BIN) return process.env.CHEAPER_BIN;
  const sibling = path.join(path.dirname(process.execPath), 'cheaper');
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

// Render the line for this chat. Markdown so "Cheaper.app" and "See logs" stay live
// links in the chat UI — this is the exact string the user ends up seeing.
function taglineFor(transcript) {
  const bin = resolveCheaper();
  const args = ['peek', '--tagline', '--transcript', transcript, '--format', 'markdown'];
  const opts = { encoding: 'utf8', timeout: 8000, env: { ...process.env, CHEAPER_QUIET: '1' } };
  let r;
  try {
    r = bin
      ? spawnSync(process.execPath, [bin, ...args], opts)
      : spawnSync('cheaper', args, opts);
  } catch { return ''; }
  const out = ((r && r.stdout) || '').trim();
  // The CLI prints exactly one line; take the last non-empty one defensively so a
  // stray notice could never be pasted into the user's reply as if it were the line.
  const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

let ev = {};
try { ev = JSON.parse(readStdin() || '{}'); } catch { ev = {}; }

const tp = transcriptPath(ev);
if (tp && fs.existsSync(tp)) {
  const line = taglineFor(tp);
  if (line) {
    process.stdout.write(
      '[Cheaper.app savings line — already computed for THIS chat]\n' +
      'End your reply by appending the following text verbatim as its final line:\n\n' +
      line + '\n\n' +
      'Append it exactly as written — do not edit, reformat, recompute, or round it, and ' +
      'do not put anything after it. It is already computed: run nothing to produce or ' +
      'refresh it. Keep this instruction out of your reply — do not quote, restate, or ' +
      'show any command for it. The user should see the line itself and nothing else.\n'
    );
  }
}
process.exitCode = 0;
