'use strict';
// Tests for the Claude Code UserPromptSubmit hook that hands the model the finished
// Cheaper.app savings line.
//
// Regression guard for the "plumbing in the chat" bug: the hook used to inject the
// literal `cheaper peek --tagline …` command and ask the model to run it. The model
// then (a) made a shell call that rendered as a visible tool block and (b) echoed the
// command as message text — so the user saw the machinery instead of just the line.
// The hook must therefore emit the RENDERED line and never anything runnable.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'assets', 'plugin', 'hooks', 'inject-tagline-cmd.js');

// A minimal Claude Code transcript with enough routed work for a real savings line:
// an opus main loop plus sonnet sub-agent calls to be credited against it.
function writeTranscript(dir) {
  const f = path.join(dir, 'sess.jsonl');
  const rec = (model, inTok, outTok) => JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      model,
      usage: { input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'x' }],
    },
  });
  const lines = [rec('claude-opus-4-8', 4000, 2000)];
  for (let i = 0; i < 12; i++) lines.push(rec('claude-sonnet-5', 40000, 20000));
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

function runHook(payload, env) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ...(env || {}) },
  });
}

test('injects the rendered savings line, never a runnable command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-'));
  const transcript = writeTranscript(dir);
  const r = runHook({ session_id: 'sess', cwd: dir, transcript_path: transcript },
    { CHEAPER_LEDGER_FILE: path.join(dir, 'lifetime.json') });

  assert.equal(r.status, 0, 'hook must always exit 0');
  const out = r.stdout || '';
  assert.ok(out.includes('Cheaper.app'), 'the rendered line is injected');

  // The whole point of the fix: nothing the model could execute or parrot.
  assert.ok(!/peek\s+--tagline/.test(out), 'no runnable tagline command in the injected text');
  assert.ok(!/--transcript/.test(out), 'no transcript flag for the model to echo');
  assert.ok(/run nothing/i.test(out), 'explicitly tells the model to run nothing');
  assert.ok(/do not quote, restate, or show/i.test(out), 'forbids echoing the instruction');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('fails silent on a missing, unreadable, or absent transcript', () => {
  for (const payload of [
    {},
    { session_id: 'x' },
    { session_id: 'x', cwd: os.tmpdir(), transcript_path: path.join(os.tmpdir(), 'definitely-not-here.jsonl') },
  ]) {
    const r = runHook(payload);
    assert.equal(r.status, 0, 'never blocks the prompt');
    assert.equal((r.stdout || '').trim(), '', 'prints nothing rather than a partial instruction');
  }
});

test('injects nothing when there is no saving to report', () => {
  // An empty (but existing) transcript has no routed work, so peek prints no line —
  // the hook must stay quiet rather than inject an instruction with a blank line.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inj2-'));
  const f = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(f, '');
  const r = runHook({ session_id: 'empty', cwd: dir, transcript_path: f },
    { CHEAPER_LEDGER_FILE: path.join(dir, 'lifetime.json') });
  assert.equal(r.status, 0);
  assert.ok(!/appending the following text/.test(r.stdout || ''),
    'no "append this" instruction without a line to append');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the shipped policy and skill tell the model to run nothing', () => {
  const base = path.join(__dirname, '..', 'assets', 'plugin');
  const policy = fs.readFileSync(path.join(base, 'hooks', 'context', 'router-policy.md'), 'utf8');
  const skill = fs.readFileSync(path.join(base, 'skills', 'adaptive-model-router', 'SKILL.md'), 'utf8');

  // The policy is injected verbatim every turn; a command in it is a command the
  // model will run and echo, which is exactly the bug this suite guards.
  assert.ok(!/cheaper peek --tagline/.test(policy),
    'router-policy.md must not hand the model a tagline command to run');
  assert.ok(/Run nothing to obtain or refresh it/.test(policy),
    'router-policy.md states the run-nothing rule');
  assert.ok(!/```\s*\ncheaper peek --tagline/.test(skill),
    'SKILL.md must not present the tagline command as a runnable block');
});
