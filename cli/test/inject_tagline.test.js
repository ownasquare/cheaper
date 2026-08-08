'use strict';
// Tests for the two Claude Code hooks that publish the Cheaper.app savings line:
// the UserPromptSubmit hook that hands the model the finished line, and the Stop-hook
// backstop that prints it directly.
//
// Regression guard for the "plumbing in the chat" bug: the hook used to inject the
// literal `cheaper peek --tagline …` command and ask the model to run it. The model
// then (a) made a shell call that rendered as a visible tool block and (b) echoed the
// command as message text — so the user saw the machinery instead of just the line.
// The hook must therefore emit the RENDERED line and never anything runnable.
//
// Regression guard for the "failure text as a money claim" bug: both hooks read the
// child's `stdout` without inspecting `status`, `signal` or `error`, so a timeout
// SIGTERM, a non-zero exit or a crash published whatever bytes the child had managed
// to write — a half-written figure, or a stack frame — as the branded, authoritative
// savings line. Both must now require a CLEAN run AND well-formed output, and fall
// back to silence. See the acceptTagline() block in each hook.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN = path.join(__dirname, '..', 'assets', 'plugin');
const HOOK = path.join(PLUGIN, 'hooks', 'inject-tagline-cmd.js');
const STOP_HOOK = path.join(PLUGIN, 'hooks', 'stop-tagline.js');

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

// ---------------------------------------------------------------------------
// A FAILED RUN MUST NEVER BECOME A MONEY CLAIM
// ---------------------------------------------------------------------------
// Both hooks shell out to `cheaper peek --tagline` and publish its stdout as an
// authoritative dollar figure — the Stop hook prints it, the UserPromptSubmit hook
// tells the model to paste it verbatim. `spawnSync` returns whatever bytes the child
// wrote before it died, so unless the hook checks `status`/`signal`/`error` first, a
// timeout SIGTERM, a non-zero exit or a crash publishes garbage wearing the brand.
//
// Each fake below reproduces one such failure exactly. `fs.writeSync(1, …)` rather
// than `process.stdout.write` so the bytes are genuinely on the wire before the child
// dies — an async pipe write would make the test pass for the wrong reason.

function fakeCli(dir, name, body) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, "'use strict';\nconst fs = require('fs');\n" + body);
  return f;
}

// A well-formed line, exactly as cli/src/peek/tagline.js renders it (plain format).
const GOOD_LINE =
  'Cheaper.app saved 🟢 $0.42 and 18.3K tokens by running 7 calls on claude-haiku-4-5 '
  + 'instead of claude-opus-4-6, at list API rates. See logs: http://localhost:8787/dashboard';

const FAILURE_MODES = [
  // name, fake body, what the un-gated code would have published
  ['timeout SIGTERM mid-write',
    `fs.writeSync(1, 'Cheaper.app saved 🟢 $0.4');\nprocess.kill(process.pid, 'SIGTERM');\nsetTimeout(() => {}, 5000);\n`,
    '$0.4'],
  ['non-zero exit after a partial figure',
    `fs.writeSync(1, 'Cheaper.app saved 🟢 $1,2 and 18.3K tokens\\n');\nprocess.exit(1);\n`,
    '$1,2'],
  ['crash: stack frames land on stdout',
    `fs.writeSync(1, ${JSON.stringify(GOOD_LINE)} + '\\n');\n`
    + `fs.writeSync(1, 'Error: ENOENT: no such file or directory\\n    at Object.readFileSync (node:fs:1234:5)\\n');\n`
    + `process.exit(7);\n`,
    'at Object.readFileSync'],
  // Exit status 0, so ONLY the grammar check can stop these two.
  ['clean exit, but the output is a CLI diagnostic',
    `fs.writeSync(1, 'cheaper: gateway is running an older build; using the local estimate instead.\\n');\n`,
    'older build'],
  ['clean exit, but the LAST line is a stack frame',
    `fs.writeSync(1, ${JSON.stringify(GOOD_LINE)} + '\\n');\n`
    + `fs.writeSync(1, '    at taglineFor (/x/inject-tagline-cmd.js:70:11)\\n');\n`,
    'at taglineFor'],
  ['clean exit, but the trailing amount is truncated',
    `fs.writeSync(1, ${JSON.stringify(GOOD_LINE)} + ' This session ran 40K tokens, worth 🔴 $1.\\n');\n`,
    'worth 🔴 $1.'],
  // Valid text, failed run — ONLY the status/signal check can stop these two.
  ['perfectly valid line, but exit status 1',
    `fs.writeSync(1, ${JSON.stringify(GOOD_LINE)} + '\\n');\nprocess.exit(1);\n`,
    '$0.42'],
  ['perfectly valid line, but killed by a signal',
    `fs.writeSync(1, ${JSON.stringify(GOOD_LINE)} + '\\n');\nprocess.kill(process.pid, 'SIGTERM');\nsetTimeout(() => {}, 5000);\n`,
    '$0.42'],
  // Runaway child: spawnSync exceeds maxBuffer, sets `error`, and truncates stdout.
  ['runaway output overruns maxBuffer',
    `fs.writeSync(1, 'Cheaper.app saved 🟢 $0.4');\nfs.writeSync(1, 'x'.repeat(2 * 1024 * 1024));\n`,
    '$0.4'],
];

function withFake(body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagfail-'));
  try {
    const bin = fakeCli(dir, 'fake-cheaper.js', body);
    const transcript = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(transcript, '');   // must exist; the fake ignores it
    fn({ dir, bin, transcript, payload: { session_id: 'sess', cwd: dir, transcript_path: transcript } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [label, body, tell] of FAILURE_MODES) {
  test(`stop hook publishes nothing on: ${label}`, () => {
    withFake(body, ({ bin, payload }) => {
      const r = spawnSync(process.execPath, [STOP_HOOK], {
        input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000,
        env: { ...process.env, CHEAPER_BIN: bin },
      });
      assert.equal(r.status, 0, 'the backstop must never block the stop');
      assert.equal((r.stdout || '').trim(), '',
        `published failure text as a savings line (tell: ${tell})`);
    });
  });

  test(`prompt hook injects nothing on: ${label}`, () => {
    withFake(body, ({ bin, payload }) => {
      const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000,
        env: { ...process.env, CHEAPER_BIN: bin },
      });
      assert.equal(r.status, 0, 'the hook must never block the prompt');
      const out = r.stdout || '';
      assert.ok(!/appending the following text/.test(out),
        `told the model to paste failure text (tell: ${tell})`);
      assert.equal(out.trim(), '', 'silence is the only correct fallback here');
    });
  });
}

// The other half of the contract: a CLEAN run with a WELL-FORMED line still gets
// through. Without this, "gate everything" would pass the failure tests above while
// silently deleting the feature.
test('a clean, well-formed line is still published by both hooks', () => {
  const body = `fs.writeSync(1, ${JSON.stringify(GOOD_LINE)} + '\\n');\n`;
  withFake(body, ({ bin, payload }) => {
    const stop = spawnSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CHEAPER_BIN: bin },
    });
    assert.equal(stop.status, 0);
    assert.equal((stop.stdout || '').trim(), GOOD_LINE, 'stop hook prints the good line');

    const inj = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CHEAPER_BIN: bin },
    });
    assert.equal(inj.status, 0);
    assert.ok(/appending the following text/.test(inj.stdout || ''),
      'prompt hook still injects the append instruction');
    assert.ok((inj.stdout || '').includes(GOOD_LINE), 'prompt hook carries the good line');
  });
});

// Two legitimate emissions that carry NO dollar figure / NO brand token. Requiring
// "brand token AND a complete amount" naively would delete both, so they are pinned.
test('amount-free and lifetime-only emissions survive the grammar check', () => {
  for (const line of [
    'Cheaper.app ran this chat on claude-opus-4-6 — no routing saving to claim. '
      + 'See logs: http://localhost:8787/dashboard',
    'Lifetime savings: 🟢 $12.30 and 1.2M tokens. See logs: http://localhost:8787/dashboard',
    'Cheaper.app saved 🟢 $1,234 and 4.5M tokens by running 9 calls on claude-haiku-4-5 '
      + 'instead of claude-opus-4-6, at list API rates.',
  ]) {
    const body = `fs.writeSync(1, ${JSON.stringify(line)} + '\\n');\n`;
    withFake(body, ({ bin, payload }) => {
      const r = spawnSync(process.execPath, [STOP_HOOK], {
        input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000,
        env: { ...process.env, CHEAPER_BIN: bin },
      });
      assert.equal((r.stdout || '').trim(), line, 'legitimate line was dropped: ' + line);
    });
  }
});

// The two hooks ship as separate files into three separate installed trees, so the
// gate is duplicated on purpose (a shared require() would crash any tree that got one
// file without the other). Duplication is only safe if the copies cannot drift.
test('both hooks carry a byte-identical acceptance gate', () => {
  const slice = (file) => {
    const src = fs.readFileSync(file, 'utf8');
    const a = src.indexOf('const AMOUNT =');
    const b = src.indexOf("return looksLikeTagline(line) ? line : '';", a);
    assert.ok(a > -1 && b > a, 'acceptance gate not found in ' + file);
    return src.slice(a, b);
  };
  assert.equal(slice(HOOK), slice(STOP_HOOK),
    'inject-tagline-cmd.js and stop-tagline.js gates have drifted apart');
});

// ---------------------------------------------------------------------------
// THE SKILL'S COST ARITHMETIC MUST RECONCILE WITH THE PRICE CATALOG
// ---------------------------------------------------------------------------
// SKILL.md tells the model when delegating is worth it, and justifies the rule with
// a worked example in dollars. A document that argues from numbers is only as good
// as those numbers, and the numbers are copies of a catalog that moves — the exact
// drift that let a retired Opus rate survive in the gateway's own price table. So
// the figures are recomputed here from cli/src/peek/models.js and matched against
// the text. If a rate changes, this fails and the document gets updated with it.
const SKILL = path.join(PLUGIN, 'skills', 'adaptive-model-router', 'SKILL.md');
const RUBRIC = path.join(PLUGIN, 'skills', 'adaptive-model-router', 'references',
  'complexity-rubric.md');

test('SKILL.md no longer carries the cost-increasing triage mandate', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  const policy = fs.readFileSync(path.join(PLUGIN, 'hooks', 'context', 'router-policy.md'), 'utf8');
  // The deleted rule, and the claim that made it look free. Both may still be
  // NAMED (the document explains what it replaced and why), but neither may be
  // stated as an instruction — hence the bullet-form check.
  assert.ok(!/^- \*\*Don't skip triage\.\*\*/m.test(skill),
    "the 'Don't skip triage' guardrail must be deleted, not reworded");
  assert.ok(/break-even/i.test(skill), 'SKILL.md states the delegation break-even rule');
  assert.ok(/boundary tax/i.test(skill), 'SKILL.md names the cost of crossing the boundary');
  // The policy is injected verbatim every turn, so it is the copy that actually
  // steers behavior; it must carry the same rule, not the old one.
  assert.ok(/boundary tax/i.test(policy), 'router-policy.md carries the boundary-tax rule');
  assert.ok(!/Triage before answering/.test(policy),
    'router-policy.md must not still mandate a triage pass');
});

test('the dollar figures in SKILL.md are the ones the catalog implies', () => {
  const { CATALOG } = require(path.join(__dirname, '..', 'src', 'peek', 'models.js'));
  const rate = (id) => {
    const e = CATALOG.find((x) => x.id === id);
    assert.ok(e, 'catalog entry missing: ' + id);
    return { in: e.in, out: e.out };
  };
  const OPUS = rate('claude-opus-4-6');
  const SONNET = rate('claude-sonnet-4-5');
  const HAIKU = rate('claude-haiku-4-5');

  // The four inputs the document states up front, so the sums below are the
  // reader's own sums and not a second, hidden model.
  const P = 2000, C = 500, V = 100, A = 1100;
  const u = (tok, perM) => tok * perM;            // micro-dollars
  const usd = (micro) => '$' + (micro / 1e6).toFixed(4);

  const direct = u(P, OPUS.in) + u(A, OPUS.out);
  const triage = u(P + C, OPUS.out)                                   // author prompt
    + u(P + C, HAIKU.in) + u(V, HAIKU.out)                            // haiku runs
    + u(V, OPUS.in);                                                  // read verdict
  const ladder = triage
    + u(P, OPUS.out) + u(P, SONNET.in) + u(A, SONNET.out) + u(A, OPUS.in)
    + u(P, OPUS.out) + u(P, OPUS.in) + u(A, OPUS.out) + u(A, OPUS.in)
    + u(A, OPUS.out);
  const handled = u(P + C, OPUS.out) + u(P + C, HAIKU.in) + u(A, HAIKU.out)
    + u(A, OPUS.in) + u(A, OPUS.out);
  // W·(o_in − w_in) = P·(o_out + w_in − o_in) + A·(w_out + o_in)
  const breakEven = (w) =>
    (P * (OPUS.out + w.in - OPUS.in) + A * (w.out + OPUS.in)) / (OPUS.in - w.in);

  const skill = fs.readFileSync(SKILL, 'utf8');
  const must = (needle, why) =>
    assert.ok(skill.includes(needle), `${why}: SKILL.md is missing "${needle}"`);

  const haikuOnly = u(P + C, HAIKU.in) + u(V, HAIKU.out);

  // Every derived figure must be PRESENT...
  const dollars = [direct, triage, ladder, handled].map(usd);
  const legs = [                                    // the per-leg rows of both tables
    u(P + C, OPUS.out), haikuOnly, u(V, OPUS.in), u(P, OPUS.out),
    u(P, SONNET.in) + u(A, SONNET.out), u(A, OPUS.in),
    u(P, OPUS.in) + u(A, OPUS.out), u(A, OPUS.out),
    u(P, OPUS.in),                                  // the baseline's own two halves,
    u(A, OPUS.out),                                 // shown as "$0.0100 + $0.0275"
  ].map(usd);
  const multipliers = [
    (triage / haikuOnly).toFixed(0) + 'x',      // 22x   — the misstatement factor
    (triage / direct).toFixed(2) + 'x',         // 1.76x — triage vs answering directly
    (ladder / direct).toFixed(2) + 'x',         // 7.05x — the three-rung ladder
    (handled / direct).toFixed(2) + 'x',        // 2.76x — the ladder's BEST case
  ];
  const churn = [breakEven(HAIKU), breakEven(SONNET)].map((w) => Math.round(w).toLocaleString());

  for (const d of dollars) must(d, 'derived dollar figure');
  for (const m of multipliers) must(m, 'derived multiplier');
  for (const w of churn) must(w, 'derived break-even churn');

  // ...AND nothing of the same shape may appear that is NOT derived. Presence alone
  // is too weak: these figures each occur two or three times in the prose, so a
  // single-site typo ("$0.0660" -> "$0.0060" in the table, the summary left intact)
  // passes an includes() check while shipping a table that no longer adds up.
  const allOf = (re) => Array.from(new Set(skill.match(re) || []));
  const stray = (found, allowed, what) => {
    const bad = found.filter((v) => !allowed.includes(v));
    assert.deepEqual(bad, [], `SKILL.md states ${what} the catalog does not imply: ${bad.join(', ')}`);
  };
  stray(allOf(/\$\d+\.\d{4}/g), dollars.concat(legs), 'dollar figures');
  stray(allOf(/\b\d+(?:\.\d+)?x\b/g), multipliers, 'multipliers');
  stray(allOf(/\b\d{1,3}(?:,\d{3})+(?= tokens\b)/g), churn, 'token break-even figures');

  // And the rates themselves, so the table in the document can't drift from the
  // catalog it claims to quote.
  for (const [id, r] of [['claude-haiku-4-5', HAIKU], ['claude-sonnet-4-5', SONNET],
    ['claude-opus-4-6', OPUS]]) {
    must(`| \`${id}\` | ${r.in} | ${r.out} |`, `rate row for ${id}`);
  }
});

test('the rubric states its one principle without contradicting itself', () => {
  const rubric = fs.readFileSync(RUBRIC, 'utf8');
  // The old text asserted "Volume ≠ difficulty" in the tie-breakers while listing
  // bare "long, dense context" as a Tier 3 signal. Coupling is what resolves it.
  assert.ok(/coupling/i.test(rubric), 'the rubric names coupling as the real signal');
  assert.ok(!/^- Long, dense context that must be synthesized/m.test(rubric),
    'the bare length-based Tier 3 signal must be qualified by coupling');
  // And it must record where the gateway cannot do what it describes, so nobody
  // "fixes" the divergence by quietly weakening the rubric.
  assert.ok(/allow_upgrade_above_requested/.test(rubric),
    'the rubric flags the config that makes auto-escalation unreachable');
  assert.ok(/What the gateway must change/i.test(rubric),
    'the rubric carries the list of gateway changes needed for the two to agree');
});

// ---------------------------------------------------------------------------
// VERSION-BUMP DISCIPLINE FOR THE THREE INSTALLED COPIES
// ---------------------------------------------------------------------------
// The plugin exists three times: here, in ~/.cheaper/marketplace/..., and in Claude
// Code's plugin cache — and the cache directory is NAMED after the version in
// plugin.json. Editing a file without bumping that version leaves the copy that
// actually runs stale at the same path, with no signal anywhere. That is not
// hypothetical: hooks/stop-tagline.js was already diverging between the source and
// both installed copies while all three declared 0.2.0.
//
// content-manifest.json pins the tree to its declared version. Any edit changes the
// digest; the only way to make this suite green again is to record the new digest
// AND move the old version into `published`, which is the bump.
const MANIFEST = path.join(PLUGIN, '.claude-plugin', 'content-manifest.json');

// Excluded from the digest: the manifest itself (it records the digest), and Claude
// Code's `.in_use/<pid>` runtime lockfiles, so an INSTALLED copy hashes identically
// to the source and can be verified in place.
function pluginDigest(root) {
  const crypto = require('crypto');
  const files = [];
  (function walk(dir, base) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === '.DS_Store' || e.name === '.in_use') continue;
      const rel = base ? base + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (rel !== '.claude-plugin/content-manifest.json') files.push(rel);
    }
  })(root, '');
  files.sort();
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    h.update(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex'));
    h.update('\n');
  }
  return { sha256: h.digest('hex'), files: files.length };
}

test('the plugin tree matches its declared version and content manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const declared = JSON.parse(fs.readFileSync(
    path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const got = pluginDigest(PLUGIN);

  assert.equal(manifest.version, declared,
    'content-manifest.json and plugin.json declare different versions');
  // The digest assert comes FIRST and carries the whole remedy, including the new
  // file count: a bare "the file count changed" that fires ahead of it would hide
  // the one value the author actually needs to paste back.
  assert.equal(got.sha256, manifest.sha256,
    'the plugin tree changed. Bump "version" in .claude-plugin/plugin.json, move the '
    + 'OLD {version: sha256} pair into "published", and set version/sha256/files to '
    + `"${declared}" / "${got.sha256}" / ${got.files} — see the versioning section in `
    + 'the plugin README.');
  assert.equal(got.files, manifest.files,
    `the shipped file count changed: manifest says ${manifest.files}, tree has ${got.files}`);
});

test('an already-published version is never re-shipped with different content', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const published = manifest.published || {};
  assert.ok(!Object.prototype.hasOwnProperty.call(published, manifest.version),
    `version ${manifest.version} was already published with digest ${published[manifest.version]}; `
    + 'bump the version rather than re-shipping it with new content');
  // Every historical digest must differ from the current one too — an "unchanged"
  // bump means the version signal is being spent for nothing.
  for (const [v, sha] of Object.entries(published)) {
    assert.notEqual(sha, manifest.sha256,
      `this tree is byte-identical to published version ${v}; nothing needed a bump`);
  }
});
