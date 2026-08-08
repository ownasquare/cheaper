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
//
// "Any problem prints nothing" is enforced by acceptTagline() below, not assumed.
// The text injected here is copied verbatim into the user's reply as an
// authoritative dollar figure, so a failed run must reach the chat as silence.

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

// --- What may be published as a money claim ---------------------------------
//
// This block is DUPLICATED VERBATIM in hooks/stop-tagline.js, deliberately. The two
// hooks are copied into three separate installed trees (product source,
// ~/.cheaper/marketplace/..., and Claude Code's plugin cache) and only hooks.json
// names which files run, so a shared `require()` between them would turn any copy
// that shipped one file without the other into a module-load crash on every turn.
// A twenty-line duplicate is cheaper than that failure mode; the test suite pins the
// two copies to identical behavior (see cli/test/inject_tagline.test.js).
//
// WHY IT EXISTS. `spawnSync` hands back whatever bytes the child managed to write
// BEFORE it died — on the 8 s timeout below, on a non-zero exit, and on a crash. The
// old code read `r.stdout` and inspected neither `status`, nor `signal`, nor `error`.
// The "take the last non-empty line" rule below made that strictly worse HERE than in
// the Stop hook: on a crash the last non-empty line of the child's output is the last
// STACK FRAME, which was then injected as the finished savings line for the model to
// paste verbatim into the user's reply.
//
// Two independent conditions, BOTH required — see acceptTagline():
//
//   1. CLEAN RUN. No spawn error, no terminating signal, exit status exactly 0.
//      Bytes from a killed or failing child are not a measurement, however
//      well-formed they look. This runs FIRST, which is what disarms the
//      last-line rule: a crash never gets as far as line selection.
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
  return acceptTagline(r);
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
