'use strict';
// Harness adapters: turn each tool's on-disk chat history into a stream of
// NORMALIZED call records that peek can classify + price. A record is:
//   { harness, ts, model, inTokens, outTokens, text, source, estimated }
// where `text` is USER-AUTHORED prompt text only (never tool-output bodies — see
// pullUserText), `source` is 'user' | 'subagent', and `estimated` marks records
// whose token counts we had to infer from text length.
//
// claude-code has a dedicated, well-understood parser (status: supported).
// The rest run through a defensive generic engine and are marked experimental —
// they extract only what they can verify and fabricate nothing.

const path = require('path');
const { findFiles, readJsonl, readJson, expand, exists } = require('./fsutil');

const CAP = { maxFiles: 300 };

// ---- text extraction (safety-critical) -------------------------------------
// Pull only user-authored text. Anthropic/OpenAI message content may be a string
// or an array of typed blocks; we keep 'text' blocks and DROP tool_use/tool_result
// blocks, images, and anything else — those can carry command output, file dumps,
// or secrets that must never be surfaced by a savings estimate.
function pullUserText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (typeof b === 'string') { parts.push(b); continue; }
      if (b && typeof b === 'object') {
        const t = b.type;
        if ((t === 'text' || t === undefined) && typeof b.text === 'string') parts.push(b.text);
        else if (t === 'input_text' && typeof b.text === 'string') parts.push(b.text);
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

// ---- Claude Code (~/.claude/projects/**/*.jsonl) ---------------------------
// Each line is a transcript event. Assistant events carry message.model and
// message.usage; sub-agent turns are flagged isSidechain:true. We classify each
// model call by the user text that preceded it in the same file.
function collectClaudeCode(opts) {
  const dir = expand('~/.claude/projects');
  const records = [];
  const files = findFiles(dir, ['.jsonl'], { maxFiles: CAP.maxFiles, sinceDays: opts.sinceDays, maxDepth: 4 });
  for (const f of files) {
    let lastUser = { text: '', ts: 0 };
    readJsonl(f.file, (o) => {
      const msg = o.message || o;
      const role = o.type === 'user' || o.type === 'assistant' ? o.type : msg.role;
      const sidechain = o.isSidechain === true;
      if (role === 'user') {
        const t = pullUserText(msg.content != null ? msg.content : o.content);
        if (t) lastUser = { text: t, ts: parseTs(o.timestamp || o.ts) };
        return;
      }
      if (role === 'assistant') {
        const model = msg.model;
        if (!model) return;
        const u = msg.usage || {};
        const hasUsage = u && (u.input_tokens != null || u.output_tokens != null);
        const inTok = hasUsage
          ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
          : estTokens(lastUser.text);
        const outTok = hasUsage ? (u.output_tokens || 0) : 0;
        records.push({
          harness: 'claude-code', ts: parseTs(o.timestamp || o.ts) || lastUser.ts,
          model, inTokens: inTok, outTokens: outTok,
          text: lastUser.text, source: sidechain ? 'subagent' : 'user',
          estimated: !hasUsage,
        });
      }
    });
  }
  return { records, filesScanned: files.length, note: '' };
}

// ---- Generic engine (experimental) -----------------------------------------
// Best-effort extraction for harnesses whose format we can't yet parse exactly.
// Reads *.jsonl (turn-per-line) and *.json (session objects), pulls model + user
// text + usage where present, and emits nothing when it can't find them.
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
    // model/assistant turn
    if (/assistant|model|response|agent/i.test(role) || hasUsage) {
      if (!model) continue;
      const inTok = hasUsage ? (u.input_tokens || u.prompt_tokens || 0) : estTokens(lastUser || text);
      const outTok = hasUsage ? (u.output_tokens || u.completion_tokens || 0) : 0;
      records.push({
        harness, ts: parseTs(m.timestamp || m.ts) || fileTs,
        model, inTokens: inTok, outTokens: outTok,
        text: lastUser || text, source: SUBAGENT_HINT.test(role) ? 'subagent' : 'user',
        estimated: !hasUsage,
      });
    }
  }
}

function collectGeneric(harness, dir, opts) {
  const root = expand(dir);
  if (!exists(root)) return { records: [], filesScanned: 0, note: 'no history directory found' };
  const records = [];
  // JSONL: line-per-turn, with a session model possibly on an early line.
  const jsonl = findFiles(root, ['.jsonl'], { maxFiles: CAP.maxFiles, sinceDays: opts.sinceDays });
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
  // JSON: whole-session objects with a messages/turns array.
  const json = findFiles(root, ['.json'], { maxFiles: CAP.maxFiles, sinceDays: opts.sinceDays });
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
// status: 'supported' (verified parser) | 'experimental' (best-effort generic)
//         | 'sqlite' (stored in a DB we don't read yet).
const HARNESSES = [
  { key: 'claude-code', label: 'Claude Code', status: 'supported', collect: collectClaudeCode },
  { key: 'codex', label: 'Codex', status: 'experimental', dir: '~/.codex' },
  { key: 'gemini', label: 'Gemini CLI', status: 'experimental', dir: '~/.gemini' },
  { key: 'grok', label: 'Grok', status: 'experimental', dir: '~/.grok' },
  { key: 'opencode', label: 'OpenCode', status: 'experimental', dir: '~/.local/share/opencode' },
  { key: 'copilot', label: 'Copilot', status: 'experimental', dir: '~/.copilot' },
  { key: 'cursor', label: 'Cursor', status: 'sqlite',
    note: 'Cursor stores chats in a SQLite DB (state.vscdb) — file-scan peek can’t read it yet.' },
];

function collectHarness(def, opts) {
  if (def.status === 'sqlite') return { records: [], filesScanned: 0, note: def.note };
  if (def.collect) return def.collect(opts);
  if (def.dir) return collectGeneric(def.key, def.dir, opts);
  return { records: [], filesScanned: 0, note: 'no adapter' };
}

module.exports = { HARNESSES, collectHarness, pullUserText, parseTs, estTokens };
