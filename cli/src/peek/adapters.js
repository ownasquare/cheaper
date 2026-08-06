'use strict';
// Harness adapters: turn each tool's on-disk chat history into a stream of
// NORMALIZED call records that peek can classify + price. A record is:
//   { harness, ts, model, inTokens, outTokens, text, source, estimated }
// where `text` is USER-AUTHORED prompt text only (never tool-output bodies — see
// pullUserText), `source` is 'user' | 'subagent', and `estimated` marks records
// whose token counts we had to infer from text length.
//
// Formats were reverse-engineered from public docs/source (see docs). Key hazards
// handled here: (1) Claude Code splits one API turn across multiple JSONL lines
// that repeat the SAME message.id + usage — we dedupe by message.id so tokens
// aren't inflated. (2) sub-agents appear either as isSidechain:true inline OR in a
// sibling <session>/subagents/agent-*.jsonl file. (3) Codex per-turn token counts
// are version-fragile and cumulative in places, so we estimate codex tokens from
// text rather than risk an N× inflation.

const path = require('path');
const { findFiles, readJsonl, readJson, expand, exists } = require('./fsutil');
const { execSync } = require('child_process');

const CAP = { maxFiles: 300 };

// ---- installed-tool detection ----------------------------------------------
// A harness counts as "installed" if its known history dir exists on disk OR
// its CLI binary is resolvable on PATH. Fails soft: any problem -> false.
function commandExists(bin) {
  if (!bin) return false;
  try {
    const checkCmd = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
    execSync(checkCmd, { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}

function historyDirFor(def) {
  if (def.key === 'claude-code') {
    return process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR + '/projects' : '~/.claude/projects';
  }
  if (def.key === 'codex') {
    return process.env.CODEX_HOME ? process.env.CODEX_HOME + '/sessions' : '~/.codex/sessions';
  }
  return def.dir || null;
}

function isInstalled(def) {
  try {
    const dir = historyDirFor(def);
    if (dir && exists(expand(dir))) return true;
    return commandExists(def.bin);
  } catch { return false; }
}

// ---- text extraction (safety-critical) -------------------------------------
// Pull only user/assistant-authored TEXT. Content may be a string or an array of
// typed blocks; we keep 'text'/'input_text'/'output_text' and DROP tool_use,
// tool_result, function_call(_output), images — those can carry command output,
// file dumps, or secrets that must never surface in a savings estimate.
function pullUserText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (typeof b === 'string') { parts.push(b); continue; }
      if (b && typeof b === 'object') {
        const t = b.type;
        if ((t === 'text' || t === 'input_text' || t === 'output_text' || t === undefined) && typeof b.text === 'string') {
          parts.push(b.text);
        }
      }
    }
    return parts.join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function parseTs(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; // sec -> ms
  const n = Date.parse(v);
  return Number.isNaN(n) ? 0 : n;
}
function estTokens(text) { return Math.max(1, Math.ceil((text || '').length / 4)); }
const IS_SUB_PATH = /(^|[\/\\])subagents[\/\\]/;

// ---- session / transcript scoping ------------------------------------------
// `peek --tagline` reports ONE conversation, not all history. These helpers pare
// a findFiles() result down to the chat we care about:
//   opts.transcript  — an exact transcript file path (what a Stop hook passes).
//   opts.session     — a session id; matches a transcript by basename stem.
//   opts.current     — the newest PRIMARY (non-subagent) transcript = active chat.
// With none of these set, scanning is unchanged (all history).
function sessionStem(file) { return path.basename(String(file)).replace(/\.jsonl?$/i, ''); }

// A single session id gathers the WHOLE conversation. Claude Code stores a chat's
// main transcript at <project>/<id>.jsonl and that SAME chat's sub-agent transcripts
// under a sibling <project>/<id>/ directory — both carry the id in their path. So
// matching on the id rolls the sub-agent (Haiku/Sonnet) savings into the chat's
// total, instead of measuring only the (usually top-tier) main loop and reporting $0.
function fileMatchesSession(file, id) {
  const f = String(file);
  return sessionStem(f) === id || f.includes(id);
}

// Which session to scope to: an id string, null (no scoping — all history), or false
// (--current asked but this harness has no top-level transcript here).
function resolveSessionId(files, opts) {
  if (opts.session) return String(opts.session);
  if (opts.transcript) {
    const first = Array.isArray(opts.transcript) ? opts.transcript[0] : opts.transcript;
    return sessionStem(first);
  }
  if (opts.current) {
    // Current chat = the newest TOP-LEVEL transcript in THIS project (never a sub-agent
    // sidecar, never another repo's concurrent chat). We then pull that id's sub-agents.
    const primary = files.filter((f) => !IS_SUB_PATH.test(f.file));
    if (!primary.length) return false;
    const slug = String(process.cwd()).replace(/[/.]/g, '-');
    const inProject = slug ? primary.filter((f) => String(f.file).includes(slug)) : [];
    const pool = inProject.length ? inProject : primary; // findFiles is newest-first
    return sessionStem(pool[0].file);
  }
  return null;
}

function filterFilesBySession(files, opts) {
  const id = resolveSessionId(files, opts || {});
  if (id === null) return files;   // unscoped
  if (id === false) return [];     // --current with nothing here
  return files.filter((f) => fileMatchesSession(f.file, id));
}

// The files a harness adapter should read under the current scope: the whole session
// (main transcript + its sub-agent transcripts), or all history when unscoped.
function scopedFiles(dir, opts, exts, findOpts) {
  const o = opts || {};
  const hit = filterFilesBySession(findFiles(dir, exts, findOpts), o);
  // Guarantee an explicit --transcript file is present even if the walk/cap missed it.
  if (o.transcript && Array.isArray(hit)) {
    for (const p of (Array.isArray(o.transcript) ? o.transcript : [o.transcript])) {
      const abs = p && expand(p);
      if (abs && exists(abs) && !hit.some((f) => f.file === abs)) hit.push({ file: abs, size: 0, mtime: 0 });
    }
  }
  return hit;
}

// ---- Claude Code (~/.claude/projects/**/*.jsonl) ---------------------------
function collectClaudeCode(opts) {
  const dir = expand(process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR + '/projects' : '~/.claude/projects');
  const records = [];
  const files = scopedFiles(dir, opts, ['.jsonl'], { maxFiles: CAP.maxFiles, sinceDays: opts.sinceDays, maxDepth: 5 });
  for (const f of files) {
    const subFile = IS_SUB_PATH.test(f.file);
    let lastUser = { text: '', ts: 0 };
    const seen = new Set(); // message.id / requestId already counted this file
    readJsonl(f.file, (o) => {
      const msg = o.message || o;
      const role = o.type === 'user' || o.type === 'assistant' ? o.type : msg.role;
      const sidechain = subFile || o.isSidechain === true;
      if (role === 'user') {
        const t = pullUserText(msg.content != null ? msg.content : o.content);
        if (t) lastUser = { text: t, ts: parseTs(o.timestamp || o.ts) };
        return;
      }
      if (role === 'assistant') {
        const model = msg.model;
        if (!model) return;
        // Dedupe: many lines of one API turn repeat the same id + usage.
        const id = msg.id || o.requestId || null;
        if (id) { if (seen.has(id)) return; seen.add(id); }
        const u = msg.usage || {};
        const hasUsage = u && (u.input_tokens != null || u.output_tokens != null);
        const inTok = hasUsage
          ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
          : estTokens(lastUser.text);
        const outTok = hasUsage ? (u.output_tokens || 0) : 0;
        records.push({
          harness: 'claude-code', ts: parseTs(o.timestamp || o.ts) || lastUser.ts,
          model, inTokens: inTok, outTokens: outTok,
          // Token breakdown for cache-aware pricing (cache reads bill at ~0.1x input,
          // cache writes at ~1.25x). Absent => treated as plain input.
          inFresh: hasUsage ? (u.input_tokens || 0) : inTok,
          cacheCreate: hasUsage ? (u.cache_creation_input_tokens || 0) : 0,
          cacheRead: hasUsage ? (u.cache_read_input_tokens || 0) : 0,
          text: lastUser.text, source: sidechain ? 'subagent' : 'user',
          estimated: !hasUsage,
        });
      }
    });
  }
  return { records, filesScanned: files.length, note: '' };
}

// ---- Codex (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) -------------------
// Lines are {timestamp, type, payload}. type: session_meta | turn_context |
// response_item | event_msg. Model lives on turn_context.payload.model; messages
// live on response_item payloads (Responses-API items). Tokens are estimated
// (codex token_count is cumulative/version-fragile — summing it would inflate).
function collectCodex(opts) {
  const dir = expand(process.env.CODEX_HOME ? process.env.CODEX_HOME + '/sessions' : '~/.codex/sessions');
  const records = [];
  const files = scopedFiles(dir, opts, ['.jsonl'], { maxFiles: CAP.maxFiles, sinceDays: opts.sinceDays });
  if (!files.length) return { records: [], filesScanned: 0, note: exists(dir) ? '' : 'no history directory found' };
  for (const f of files) {
    let model = null;
    let lastUser = '';
    readJsonl(f.file, (o) => {
      const type = o.type;
      const p = o.payload || {};
      if (type === 'session_meta') { if (typeof p.model === 'string') model = p.model; return; }
      if (type === 'turn_context') { if (typeof p.model === 'string') model = p.model; return; }
      if (type === 'response_item') {
        const item = p.type ? p : (p.item || p);
        const role = item.role || item.type;
        if (item.type && item.type !== 'message') return; // skip function_call / tool items
        const text = pullUserText(item.content);
        if (/user/i.test(role)) { if (text) lastUser = text; return; }
        if (/assistant/i.test(role)) {
          if (!model) return;
          records.push({
            harness: 'codex', ts: parseTs(o.timestamp), model,
            inTokens: estTokens(lastUser || text), outTokens: 0,
            text: lastUser || text, source: 'user', estimated: true,
          });
        }
      }
    });
  }
  return { records, filesScanned: files.length, note: records.length ? 'token counts estimated from prompt length' : 'no parseable model calls found' };
}

// ---- Generic engine (experimental) -----------------------------------------
const SUBAGENT_HINT = /(sub-?agent|sidechain|delegated|task-tool|"agent")/i;

function pushFromMessages(records, harness, messages, sessionModel, fileTs) {
  let lastUser = '';
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role || m.type || '';
    const model = m.model || m.response_model || sessionModel;
    const text = pullUserText(m.content != null ? m.content : (m.text != null ? m.text : m.parts));
    const u = m.usage || (m.message && m.message.usage) || {};
    const hasUsage = u && (u.input_tokens != null || u.output_tokens != null ||
      u.prompt_tokens != null || u.completion_tokens != null);
    if (/user|human|prompt/i.test(role)) { if (text) lastUser = text; continue; }
    if (/assistant|model|response|agent/i.test(role) || hasUsage) {
      if (!model) continue;
      const inTok = hasUsage ? (u.input_tokens || u.prompt_tokens || 0) : estTokens(lastUser || text);
      const outTok = hasUsage ? (u.output_tokens || u.completion_tokens || 0) : 0;
      records.push({
        harness, ts: parseTs(m.timestamp || m.ts) || fileTs, model,
        inTokens: inTok, outTokens: outTok, text: lastUser || text,
        source: SUBAGENT_HINT.test(role) ? 'subagent' : 'user', estimated: !hasUsage,
      });
    }
  }
}

function collectGeneric(harness, dir, opts) {
  const root = expand(dir);
  if (!exists(root) && !(opts && opts.transcript)) return { records: [], filesScanned: 0, note: 'no history directory found' };
  const records = [];
  const jsonl = scopedFiles(root, opts, ['.jsonl'], { maxFiles: CAP.maxFiles, sinceDays: opts.sinceDays });
  for (const f of jsonl) {
    let sessionModel = null;
    const turns = [];
    readJsonl(f.file, (o) => {
      if (o && o.model && typeof o.model === 'string') sessionModel = o.model;
      const inner = o.message && typeof o.message === 'object' ? o.message : o;
      turns.push(inner);
    });
    pushFromMessages(records, harness, turns, sessionModel, 0);
  }
  // An explicit --transcript path is already consumed by the .jsonl pass above;
  // don't re-read it as a .json array too.
  const json = (opts && opts.transcript) ? [] : filterFilesBySession(findFiles(root, ['.json'], { maxFiles: CAP.maxFiles, sinceDays: opts.sinceDays }), opts || {});
  for (const f of json) {
    const o = readJson(f.file);
    if (!o || typeof o !== 'object') continue;
    const arr = o.messages || o.conversation || o.turns || o.history || o.items;
    if (!Array.isArray(arr)) continue;
    pushFromMessages(records, harness, arr, o.model || o.default_model || null, f.mtime);
  }
  return { records, filesScanned: jsonl.length + json.length, note: records.length ? '' : 'no parseable model calls found' };
}

// ---- registry --------------------------------------------------------------
// status: 'supported' (verified parser, real token counts)
//         | 'experimental' (best-effort / estimated tokens)
//         | 'sqlite' (stored in a DB we don't read yet).
const HARNESSES = [
  { key: 'claude-code', label: 'Claude Code', status: 'supported', collect: collectClaudeCode, bin: 'claude' },
  { key: 'codex', label: 'Codex', status: 'experimental', collect: collectCodex, bin: 'codex' },
  { key: 'gemini', label: 'Gemini CLI', status: 'experimental', dir: '~/.gemini/tmp', bin: 'gemini' },
  { key: 'grok', label: 'Grok', status: 'experimental', dir: '~/.grok', bin: 'grok' },
  { key: 'opencode', label: 'OpenCode', status: 'experimental', dir: '~/.local/share/opencode', bin: 'opencode' },
  { key: 'copilot', label: 'Copilot', status: 'experimental', dir: '~/.copilot', bin: 'copilot' },
  { key: 'pi', label: 'PI.dev', status: 'experimental', dir: '~/.pi', bin: 'pi' },
  // No custom note: render.js prints the clean 'DB-backed (not yet readable)' fallback
  // for sqlite harnesses (matches the README sample and avoids a "Cursor … Cursor …"
  // double-word in the output).
  { key: 'cursor', label: 'Cursor', status: 'sqlite', bin: 'cursor' },
];

function collectHarness(def, opts) {
  if (def.status === 'sqlite') return { records: [], filesScanned: 0, note: def.note };
  if (def.collect) return def.collect(opts);
  if (def.dir) return collectGeneric(def.key, def.dir, opts);
  return { records: [], filesScanned: 0, note: 'no adapter' };
}

module.exports = { HARNESSES, collectHarness, isInstalled, pullUserText, parseTs, estTokens, sessionStem };
