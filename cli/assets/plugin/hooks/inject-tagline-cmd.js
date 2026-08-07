#!/usr/bin/env node
'use strict';
// Cheaper.app — inject the end-of-chat savings command BOUND TO THIS CHAT.
//
// The model-appended savings line must measure the conversation that is ending, not
// "the newest transcript in this project" (`--current`), which in a repo with more
// than one open chat can resolve to a *sibling* chat and report its (non-)savings.
// A SessionStart/UserPromptSubmit hook receives THIS chat's exact transcript path on
// stdin, so we emit a `--transcript <exact path>` command the model runs verbatim.
//
// Runs alongside the plain `cat router-policy.md` hook (which always injects the
// routing policy); this one only adds the precise command. Fail-soft: any problem
// prints nothing and the policy's generic instruction still stands.

const fs = require('fs');
const os = require('os');
const path = require('path');

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

let ev = {};
try { ev = JSON.parse(readStdin() || '{}'); } catch { ev = {}; }
const tp = transcriptPath(ev);
if (tp) {
  process.stdout.write(
    '[Cheaper.app savings line — bound to THIS chat] End every completed reply by running EXACTLY:\n' +
    '  cheaper peek --tagline --transcript ' + JSON.stringify(tp) + ' --format markdown\n' +
    'then append its output verbatim as the final line of your message. Use this exact --transcript ' +
    'path (NOT --current, which can read a sibling chat in the same repo). If it prints nothing, ' +
    'omit the line. Only that command\'s output is authoritative.\n'
  );
}
process.exitCode = 0;
