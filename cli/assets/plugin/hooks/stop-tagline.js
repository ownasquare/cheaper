#!/usr/bin/env node
'use strict';
// Cheaper.app — Stop-hook backstop. When a Claude Code reply finishes, print the
// branded per-chat savings line using the EXACT transcript path Claude Code hands
// us on stdin, so the line is recorded even if the model forgot to append it.
//
// Contract: read-only, never blocks the stop, always exits 0, fails silent. The
// heavy lifting (scan + price + honesty rules) lives in the `cheaper` CLI; this
// only resolves the transcript path and relays the CLI's single line of output.
//
// RELAYS IT ONLY IF THE RUN SUCCEEDED AND THE BYTES PARSE. See acceptTagline()
// below — this hook publishes a dollar figure to the user, so failure output must
// never be able to reach the chat wearing the brand.

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

// --- What may be published as a money claim ---------------------------------
//
// This block is DUPLICATED VERBATIM in hooks/inject-tagline-cmd.js, deliberately.
// The two hooks are copied into three separate installed trees (product source,
// ~/.cheaper/marketplace/..., and Claude Code's plugin cache) and only hooks.json
// names which files run, so a shared `require()` between them would turn any copy
// that shipped one file without the other into a module-load crash on every turn.
// A twenty-line duplicate is cheaper than that failure mode; the test suite pins
// the two copies to identical behavior (see cli/test/inject_tagline.test.js).
//
// WHY IT EXISTS. `spawnSync` hands back whatever bytes the child managed to write
// BEFORE it died. It does that on the 12 s SIGTERM below, on a non-zero exit, and
// on a crash. The old code was `const line = ((r && r.stdout)||'').trim(); if
// (line) …` — it inspected neither `status`, nor `signal`, nor `error` — so a
// half-written figure ("Cheaper.app saved 🟢 $0.4") or a CLI diagnostic went
// straight into the user's chat as the branded, authoritative savings line.
//
// Two independent conditions, BOTH required — see acceptTagline():
//
//   1. CLEAN RUN. No spawn error, no terminating signal, exit status exactly 0.
//      Bytes from a killed or failing child are not a measurement, however
//      well-formed they look.
//   2. WELL-FORMED (looksLikeTagline). The bytes must still parse as this line's
//      grammar. Belt and braces on purpose: a child can exit 0 and still print
//      something that is not a savings line.
//
// Silence is always the correct fallback. A missing line is a missing feature the
// user can notice; a wrong number is a claim they have no way to check.

// A COMPLETE rendered amount. `money()` in cli/src/peek/tagline.js emits "$0.42"
// (2 dp under $100) or "$1,234" (0 dp at/above $100) — nothing else. So "$0.4",
// "$1,23", "$1234" and a bare "$" are all truncations or foreign text.
const AMOUNT = /\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?(?![\d.,])/g;

function looksLikeTagline(s) {
  if (!s) return false;
  // The brand token, in every form tagline.js renders it: plain `Cheaper.app`,
  // markdown `[Cheaper.app](…)`, and the OSC-8 ANSI wrapper — all three contain the
  // literal token. The lifetime-only emission (`buildTagline` returned '' but the
  // ledger has a running total) carries no brand token, so it is named explicitly
  // rather than being silently dropped.
  if (!/Cheaper\.app/.test(s) && !/^Lifetime savings:/.test(s)) return false;
  // EVERY `$` must begin a complete amount — not merely "one complete amount
  // exists". A line cut mid-write keeps its first, well-formed figure and truncates
  // the last one, so an any-match rule would wave exactly that case through. Lines
  // with no `$` at all are legitimate: the honest "ran this chat on <model> — no
  // routing saving to claim." emission makes no money claim and needs no amount.
  return (s.match(/\$/g) || []).length === (s.match(AMOUNT) || []).length;
}

// `r` is a spawnSync result. Anything other than a clean, well-formed run yields ''.
function acceptTagline(r) {
  if (!r || r.error || r.signal || r.status !== 0) return '';
  const out = String(r.stdout == null ? '' : r.stdout).trim();
  if (!out) return '';
  // The CLI prints exactly one line; take the last non-empty one defensively so a
  // stray notice ahead of it can never be published in its place.
  const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
  const line = lines.length ? lines[lines.length - 1] : '';
  return looksLikeTagline(line) ? line : '';
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
  const line = acceptTagline(r);
  if (line) process.stdout.write(line + '\n');
}

try { main(); } catch { /* never let the backstop break a stop */ }
// No process.exit() here: it can terminate before Node flushes the (piped) stdout
// write above, truncating the very line this backstop exists to emit. There is no
// pending async work, so Node drains stdout and exits 0 on its own.
process.exitCode = 0;
