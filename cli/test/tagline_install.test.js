'use strict';
// Tests for the cross-harness tagline installer: the managed block must be
// idempotent, must never disturb the user's surrounding content, and must be
// cleanly removable.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../src/tagline_install');

test('managed block is idempotent and preserves surrounding content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  const f = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(f, '# My Agents\n\nExisting rule the user wrote.\n');
  T.upsertMdBlock(f, 'codex');
  T.upsertMdBlock(f, 'codex'); // second run must not duplicate
  const s = fs.readFileSync(f, 'utf8');
  assert.equal(s.split(T.START).length - 1, 1, 'exactly one start marker');
  assert.equal(s.split(T.END).length - 1, 1, 'exactly one end marker');
  assert.ok(s.includes('Existing rule the user wrote.'), 'preserved user content');
  assert.ok(s.includes('cheaper peek --tagline --current --harness codex'), 'scoped command present');

  T.removeTarget({ file: f, format: 'md' });
  const after = fs.readFileSync(f, 'utf8');
  assert.ok(!after.includes(T.START), 'block removed');
  assert.ok(after.includes('Existing rule the user wrote.'), 'user content survives removal');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('creates a fresh file when none exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl2-'));
  const f = path.join(dir, 'nested', 'AGENTS.md');
  T.upsertMdBlock(f, 'grok');
  const s = fs.readFileSync(f, 'utf8');
  assert.ok(s.startsWith(T.START));
  assert.ok(s.includes('--harness grok'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mdc rule file is well-formed for Cursor', () => {
  const mdc = T.mdcFile('cursor');
  assert.match(mdc, /^---\ndescription: /);
  assert.match(mdc, /alwaysApply: true/);
  assert.match(mdc, /--harness cursor/);
});
