'use strict';
// Bounded, defensive filesystem helpers for peek's harness adapters.
// Everything here is read-only and fails soft: a missing dir, an unreadable file,
// or a malformed line is skipped, never thrown. Work is capped (recent files
// only, per-file byte ceiling) so `peek` stays fast even on huge histories.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Where '~' resolves. Overridable so tests point at fixtures and power users can
// scan an alternate profile — without ever hard-coding the real home in logic.
const HOME = process.env.CHEAPER_PEEK_HOME || os.homedir();
const DAY = 86400 * 1000;

function expand(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

// Recursively list files under `dir` with one of `exts` (e.g. ['.jsonl','.json']).
// Returns [{ file, size, mtime }] sorted newest-first, filtered by sinceDays,
// capped at maxFiles. Directory walking is depth- and count-bounded.
function findFiles(dir, exts, opts = {}) {
  const root = expand(dir);
  const maxFiles = opts.maxFiles || 400;
  const maxDepth = opts.maxDepth || 8;
  const sinceMs = opts.sinceDays ? Date.now() - opts.sinceDays * DAY : 0;
  const out = [];
  if (!exists(root)) return out;
  const stack = [{ d: root, depth: 0 }];
  let visited = 0;
  while (stack.length && visited < 20000) {
    const { d, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      visited++;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !e.name.startsWith('.git') && e.name !== 'node_modules') {
          stack.push({ d: full, depth: depth + 1 });
        }
        continue;
      }
      if (!exts.some((x) => e.name.toLowerCase().endsWith(x))) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (sinceMs && st.mtimeMs < sinceMs) continue;
      out.push({ file: full, size: st.size, mtime: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, maxFiles);
}

// Stream a JSONL file line-by-line, invoking onObj(parsedObject) for each valid
// JSON line. Bad lines are skipped. Reading is capped at maxBytes so a runaway
// multi-GB transcript can't stall the scan.
function readJsonl(file, onObj, opts = {}) {
  const maxBytes = opts.maxBytes || 32 * 1024 * 1024;
  let raw;
  try {
    const st = fs.statSync(file);
    if (st.size > maxBytes) {
      // Read only the tail (most recent turns) of an oversized transcript.
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
      fs.closeSync(fd);
      raw = buf.toString('utf8');
      const nl = raw.indexOf('\n');
      if (nl >= 0) raw = raw.slice(nl + 1); // drop the partial first line
    } else {
      raw = fs.readFileSync(file, 'utf8');
    }
  } catch { return; }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    try { onObj(obj); } catch { /* adapter bug on one line — skip it */ }
  }
}

// Parse a whole JSON file (returns null on any problem).
function readJson(file, maxBytes = 32 * 1024 * 1024) {
  try {
    const st = fs.statSync(file);
    if (st.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

module.exports = { HOME, expand, exists, findFiles, readJsonl, readJson };
