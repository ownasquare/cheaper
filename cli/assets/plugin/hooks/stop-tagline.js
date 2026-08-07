#!/usr/bin/env node
'use strict';
// Cheaper.app — Stop-hook backstop. When a Claude Code reply finishes, print the
// branded per-chat savings line using the EXACT transcript path Claude Code hands
// us on stdin, so the line is recorded even if the model forgot to append it.
//
// Contract: read-only, never blocks the stop, always exits 0, fails silent. The
// heavy lifting (scan + price + honesty rules) lives in the `cheaper` CLI; this
// only resolves the transcript path and relays the CLI's single line of output.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function resolveTranscript(ev) {
  if (ev && ev.transcript_path) return ev.transcript_path;
  // Fallback: Claude Code stores transcripts at <config>/projects/<cwd-slug>/<id>.jsonl
  if (ev && ev.session_id && ev.cwd) {
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const slug = String(ev.cwd).replace(/[/.]/g, '-');
    return path.join(base, 'projects', slug, ev.session_id + '.jsonl');
  }
  return null;
}

// Resolve the `cheaper` CLI robustly: an explicit override the installer can set,
// then the binary sitting next to the node running this hook (same nvm/npm bin dir),
// else fall through to a PATH lookup.
function resolveCheaper() {
  if (process.env.CHEAPER_BIN) return process.env.CHEAPER_BIN;
  const sibling = path.join(path.dirname(process.execPath), 'cheaper');
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

function main() {
  let ev = {};
  try { ev = JSON.parse(readStdin() || '{}'); } catch { ev = {}; }
  const transcript = resolveTranscript(ev);
  if (!transcript || !fs.existsSync(transcript)) return;

  const bin = resolveCheaper();
  const args = ['peek', '--tagline', '--transcript', transcript];
  // CHEAPER_FROM_HOOK marks this as the hot path. The store's compactor REFUSES to run
  // when it is set: this hook fires on every assistant turn and SIGTERMs its child at
  // 12s, so a lazily-triggered compaction would be killed mid-way through the one
  // operation in the whole product that can destroy data.
  const env = Object.assign({}, process.env, { CHEAPER_FROM_HOOK: '1' });
  let r;
  try {
    r = bin
      ? spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 12000, env })
      : spawnSync('cheaper', args, { encoding: 'utf8', timeout: 12000, env });
  } catch { return; }
  const line = ((r && r.stdout) || '').trim();
  if (line) process.stdout.write(line + '\n');
}

try { main(); } catch { /* never let the backstop break a stop */ }
// No process.exit() here: it can terminate before Node flushes the (piped) stdout
// write above, truncating the very line this backstop exists to emit. There is no
// pending async work, so Node drains stdout and exits 0 on its own.
process.exitCode = 0;
