'use strict';
// `cheaper taglines` — wire the Cheaper.app end-of-chat savings line into EVERY
// supported harness, so each tool ends a completed chat by printing exactly what
// Cheaper saved. Claude Code gets this from the adaptive-model-router plugin; every
// other harness gets it from a small, clearly-marked, idempotent instruction block
// dropped into that tool's conventional global-instructions file.
//
// Safe by design: we only ever add/replace the block BETWEEN our own markers, never
// touching the rest of the file, and we skip harnesses that aren't set up locally
// (unless --all / --harness forces them). Re-running updates the block in place.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { c } = require('./util');

const HOME = os.homedir();
const START = '<!-- cheaper:tagline:start (managed by `cheaper taglines` — safe to delete this whole block) -->';
const END = '<!-- cheaper:tagline:end -->';

// Per-harness global instructions target. `key` is the peek harness key used to
// scope `--tagline`; `probe` existing means the harness is set up on this machine;
// `format` is 'md' (managed block appended to an AGENTS.md-style file) or 'mdc'
// (a dedicated Cursor rule file we own outright). Claude Code is intentionally
// absent — it's wired by the adaptive-model-router plugin, not here.
const TARGETS = [
  { key: 'codex', label: 'Codex / ChatGPT Work', file: path.join(HOME, '.codex', 'AGENTS.md'), probe: path.join(HOME, '.codex'), format: 'md' },
  { key: 'grok', label: 'Grok', file: path.join(HOME, '.grok', 'AGENTS.md'), probe: path.join(HOME, '.grok'), format: 'md' },
  { key: 'pi', label: 'PI.dev', file: path.join(HOME, '.pi', 'AGENTS.md'), probe: path.join(HOME, '.pi'), format: 'md' },
  { key: 'copilot', label: 'GitHub Copilot', file: path.join(HOME, '.copilot', 'AGENTS.md'), probe: path.join(HOME, '.copilot'), format: 'md' },
  { key: 'gemini', label: 'Gemini CLI', file: path.join(HOME, '.gemini', 'GEMINI.md'), probe: path.join(HOME, '.gemini'), format: 'md' },
  { key: 'opencode', label: 'OpenCode', file: path.join(HOME, '.config', 'opencode', 'AGENTS.md'), probe: path.join(HOME, '.config', 'opencode'), format: 'md' },
  { key: 'cursor', label: 'Cursor', file: path.join(HOME, '.cursor', 'rules', 'cheaper-tagline.mdc'), probe: path.join(HOME, '.cursor'), format: 'mdc' },
];

const EXAMPLE = 'Cheaper.app saved ~$0.42 and 18.3K tokens by using haiku tier for 7 calls, sonnet tier for 2 calls, opus tier for 1 call.';

function instruction(key) {
  return [
    '## Cheaper.app — end-of-chat savings line',
    '',
    'At the END of every completed reply, append the Cheaper.app savings line as the',
    'final line of your message. Do NOT compose or estimate the numbers yourself — run',
    'this and paste its output verbatim:',
    '',
    '```',
    `cheaper peek --tagline --current --harness ${key}`,
    '```',
    '',
    'If it prints nothing, Cheaper had nothing cheaper to route this chat — omit the',
    'line. Only that command\'s output is authoritative (it is exact when your requests',
    'route through the Cheaper gateway, and a `~` estimate otherwise). Example:',
    '',
    `> ${EXAMPLE}`,
  ].join('\n');
}

// The managed Markdown block (with sentinel markers) for AGENTS.md-style files.
function mdBlock(key) {
  return `${START}\n${instruction(key)}\n${END}\n`;
}

// A whole Cursor rule file (we own this file outright, so no in-file markers).
function mdcFile(key) {
  return [
    '---',
    'description: Cheaper.app end-of-chat savings line',
    'alwaysApply: true',
    '---',
    '',
    instruction(key),
    '',
  ].join('\n');
}

// Insert or replace our managed block in an AGENTS.md-style file, leaving the rest
// of the user's file untouched.
function upsertMdBlock(file, key) {
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { cur = ''; }
  const block = mdBlock(key);
  const s = cur.indexOf(START);
  let next;
  if (s !== -1) {
    const e = cur.indexOf(END, s);
    if (e !== -1) {
      const tail = cur.slice(e + END.length).replace(/^\n/, '');
      next = cur.slice(0, s) + block + tail;
    } else {
      // Malformed (a start marker with no end) — don't guess where it ends and risk
      // eating the user's content; leave the file as-is and append a fresh block.
      next = cur.replace(/\s*$/, '') + '\n\n' + block;
    }
  } else if (cur.trim()) {
    next = cur.replace(/\s*$/, '') + '\n\n' + block;
  } else {
    next = block;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
}

function writeTarget(t) {
  if (t.format === 'mdc') {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.writeFileSync(t.file, mdcFile(t.key));
  } else {
    upsertMdBlock(t.file, t.key);
  }
  return t.file;
}

// Remove our managed block / owned file (used by `cheaper taglines --remove`).
function removeTarget(t) {
  if (t.format === 'mdc') {
    try { if (fs.existsSync(t.file)) { fs.unlinkSync(t.file); return true; } } catch { /* ignore */ }
    return false;
  }
  let cur = '';
  try { cur = fs.readFileSync(t.file, 'utf8'); } catch { return false; }
  const s = cur.indexOf(START);
  if (s === -1) return false;
  const e = cur.indexOf(END, s);
  if (e === -1) return false; // malformed (start with no end) — don't truncate to EOF
  const next = (cur.slice(0, s) + cur.slice(e + END.length)).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  fs.writeFileSync(t.file, next);
  return true;
}

function selectTargets(argv) {
  const i = argv.indexOf('--harness');
  const only = i !== -1 ? (argv[i + 1] || '').toLowerCase() : null;
  const all = argv.includes('--all');
  return TARGETS.filter((t) => {
    if (only) return t.key === only;
    if (all) return true;
    return fs.existsSync(t.probe); // default: only harnesses set up locally
  });
}

function run(argv = []) {
  const remove = argv.includes('--remove') || argv.includes('--uninstall');
  const dry = argv.includes('--dry-run');
  const chosen = selectTargets(argv);

  console.log(c.amber('\n  Cheaper.app savings-line wiring') +
    c.dim('  — end every chat with what Cheaper saved\n'));
  if (!chosen.length) {
    console.log(c.dim('  No matching harnesses detected. Use --all to wire every known harness,'));
    console.log(c.dim('  or --harness <codex|grok|pi|copilot|gemini|opencode|cursor>.\n'));
    return [];
  }

  const results = [];
  for (const t of chosen) {
    const detected = fs.existsSync(t.probe);
    try {
      if (dry) {
        results.push({ key: t.key, file: t.file, action: 'would-' + (remove ? 'remove' : 'write'), detected });
        console.log('  ' + c.dim('•') + ' ' + t.label.padEnd(22) + c.dim((remove ? 'would remove ' : 'would write  ') + t.file));
      } else if (remove) {
        const did = removeTarget(t);
        results.push({ key: t.key, file: t.file, action: did ? 'removed' : 'absent', detected });
        console.log('  ' + (did ? c.green('✓') : c.dim('–')) + ' ' + t.label.padEnd(22) + c.dim((did ? 'removed from ' : 'nothing in  ') + t.file));
      } else {
        const f = writeTarget(t);
        results.push({ key: t.key, file: f, action: 'wrote', detected });
        console.log('  ' + c.green('✓') + ' ' + t.label.padEnd(22) + c.dim((detected ? 'wired  ' : 'staged ') + f));
      }
    } catch (e) {
      results.push({ key: t.key, file: t.file, error: e.message, detected });
      console.log('  ' + c.red('✗') + ' ' + t.label.padEnd(22) + c.red(e.message));
    }
  }
  if (!dry && !remove) {
    console.log(c.dim('\n  Each harness now appends the Cheaper.app savings line at end of chat via'));
    console.log(c.dim('  `cheaper peek --tagline`. Claude Code is handled by the adaptive-model-router'));
    console.log(c.dim('  plugin (run `cheaper install plugin`). Re-run any time to refresh; `--remove` undoes it.\n'));
  } else {
    console.log('');
  }
  return results;
}

module.exports = { run, TARGETS, instruction, mdBlock, mdcFile, upsertMdBlock, writeTarget, removeTarget, START, END };
