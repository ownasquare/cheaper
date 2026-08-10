'use strict';
// freshness.js / freshness_report.js: two ways this report told a user everything was
// fine while routing was not happening at all.
//
// P0.5 — A GATEWAY THAT IS NOT RUNNING RENDERED GREEN.
//   freshness.js set gwState='ok' with gwHint='not running', and freshness_report.js
//   mapped ok -> green('current'). So the row for a completely dead router read
//   `Gateway  current  not running`. Green is the one colour a reader skips — you scan
//   a status block for the thing that ISN'T green — so a stopped gateway was invisible,
//   and every request went to the vendor at list price for as long as nobody read the
//   dim tail of a green line. The /healthz probe that proves it was already being made;
//   `up: !!health` was already on the item; nothing rendered it.
//
// HIGH 5 — A GATEWAY ON A NON-DEFAULT PORT WAS INVISIBLE, AND P0.5 THEN LIED ABOUT IT.
//   runningGateway() computed its own `process.env.CHEAPER_PORT || '8787'`, so a healthy
//   gateway anywhere else could not be seen at all — and the brand-new 'stopped' state
//   turned that blindness into an amber STOPPED row plus "run: cheaper gateway start" for
//   a router that was serving the whole time. It takes nothing unusual to get there:
//   `gateway start --port 9000` records 9000, and autostart moves the default to 8788 the
//   moment 8787 is busy, in a login entry the user's shell never reads.
//
// MEDIUM 12 — ANY 200 COUNTED AS "THE CHEAPER GATEWAY".
//   The same function returned whatever answered /healthz, so an unrelated dev server on
//   the port was reported as a Cheaper gateway whose "running build predates version
//   reporting" — a build history invented for a stranger's process.
//
// P2.6 — FIVE OF THE SIX INSTALLED SURFACES WERE NEVER RE-CHECKED.
//   `cheaper install` writes six durable things into paths CLAUDE owns, and report()
//   content-verified exactly one (the plugin cache). The skill, the agents, the two
//   settings.json hook entries, the settings.json plugin keys, and the two plugin
//   registry files all live in ~/.claude — a directory a harness account switch, a
//   `claude plugin uninstall`, or another installer rewrites without asking. When they
//   go, routing silently stops, and every check kept printing "current" because the
//   bytes it compared were still correct over in ~/.cheaper.
//
// Every assertion below is against the ROW A USER SEES or the state that produces it,
// including its colour — a check whose text is right and whose colour is green is the
// bug this file exists to pin.

const os = require('os');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

// --- sandbox HOME + CLAUDE_CONFIG_DIR, BEFORE paths.js is loaded -------------
// paths.js reads these once at require time, so this must happen before the first
// require of anything that pulls it in. Nothing below may touch the real ~/.claude,
// ~/.cheaper, or a gateway on the real port.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cheaper-freshness-test-'));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX, '.claude');

const P = require('../src/paths');
const freshness = require('../src/freshness');
const freshnessReport = require('../src/freshness_report');

const ASSETS = path.join(__dirname, '..', 'assets');
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const GREEN = '\x1b[32m';
const AMBER = '\x1b[38;5;208m';
const RED = '\x1b[31m';

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, o) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(o, null, 2));
};
const row = (items, key) => {
  const i = items.find((x) => x.key === key);
  assert.ok(i, `no ${key} row in the report — the check cannot fail if it is not there`);
  return i;
};

// Reserve a port by binding and releasing it, so the /healthz probe in report() is
// GUARANTEED to be refused. Hardcoding 8787 would make these tests pass or fail
// depending on whether a real gateway happened to be up on the developer's machine —
// and the whole point of the P0.5 row is what it says when nothing is listening.
function freePortSync() {
  const srv = net.createServer();
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(String(port)));
    });
  });
}

// A throwaway /healthz on an EPHEMERAL port. Never 8787: these tests must not bind the real
// gateway's port, and the whole subject of the HIGH 5 block below is a gateway that is
// somewhere other than the default. Resolves { srv, port }.
function fakeGateway(payload) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (!String(req.url).startsWith('/healthz')) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: String(srv.address().port) }));
  });
}
const closeServer = (g) => new Promise((r) => g.srv.close(r));

// The identity contract app.py's /healthz publishes (gateway.js::isOurGateway). A payload
// missing ANY of these fields is, correctly, not our gateway.
function ourHealth(codeSha) {
  return { ok: true, mode: 'heuristic', auth_required: true, token_private: true,
           code_sha: codeSha };
}

// Exactly what gateway.js::writePidFile writes — pid alone on the first line, `port=` on the
// second. `port === null` reproduces the LEGACY bare-pid file older builds wrote, which must
// keep working.
function writePidFile(pid, port) {
  fs.mkdirSync(P.CHEAPER_DIR, { recursive: true });
  fs.writeFileSync(P.GATEWAY_PID, port == null ? `${pid}\n` : `${pid}\nport=${port}\n`);
}

// --- fixture: exactly what a full `cheaper install --all` + `install plugin` leaves --
// Built by hand rather than by running the installer: these tests must not execute
// install.js against this machine, and the point is to assert what the CHECK says
// about a given on-disk shape, which is more precisely stated by writing that shape.
const CACHE_DST = path.join(P.PLUGINS_CACHE, P.MARKETPLACE_NAME, P.PLUGIN_NAME, '9.9.9');

function hookEntry(command) {
  return { matcher: '', hooks: [{ type: 'command', command, timeout: 10 }] };
}

function installEverything() {
  rm(path.join(SANDBOX, '.claude'));
  rm(path.join(SANDBOX, '.cheaper'));

  // skill + agents (install.js:74-95)
  fs.cpSync(path.join(ASSETS, 'plugin', 'skills', 'adaptive-model-router'),
    path.join(P.SKILLS_DIR, 'adaptive-model-router'), { recursive: true });
  fs.cpSync(path.join(ASSETS, 'plugin', 'agents'), P.AGENTS_DIR, { recursive: true });

  // the policy file the hook cats (install.js:100-102)
  fs.mkdirSync(P.CHEAPER_DIR, { recursive: true });
  fs.copyFileSync(path.join(ASSETS, 'plugin', 'hooks', 'context', 'router-policy.md'), P.HOOK_POLICY);

  // marketplace source dir + plugin cache dir the registries point at
  fs.mkdirSync(P.MARKETPLACE_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DST, { recursive: true });

  // settings.json: hooks (install.js:104-111) + plugin keys (install.js:179-186)
  const cmd = process.platform === 'win32' ? `type "${P.HOOK_POLICY}"` : `cat "${P.HOOK_POLICY}"`;
  writeJson(P.SETTINGS, {
    hooks: { SessionStart: [hookEntry(cmd)], UserPromptSubmit: [hookEntry(cmd)] },
    extraKnownMarketplaces: {
      [P.MARKETPLACE_NAME]: { source: { source: 'directory', path: P.MARKETPLACE_DIR } },
    },
    enabledPlugins: { [P.PLUGIN_ID]: true },
  });

  // the two plugin registry files (install.js:160-176)
  writeJson(P.KNOWN_MARKETPLACES, {
    [P.MARKETPLACE_NAME]: {
      source: { source: 'directory', path: P.MARKETPLACE_DIR },
      installLocation: P.MARKETPLACE_DIR,
      lastUpdated: new Date().toISOString(),
    },
  });
  writeJson(P.INSTALLED_PLUGINS, {
    version: 2,
    plugins: {
      [P.PLUGIN_ID]: [{
        scope: 'user', installPath: CACHE_DST, version: '9.9.9',
        installedAt: new Date().toISOString(), lastUpdated: new Date().toISOString(),
      }],
    },
  });
}

// ===========================================================================
// P0.5 — THE STOPPED GATEWAY
// ===========================================================================

test('a gateway that is installed and current but NOT RUNNING is not "ok"', async () => {
  installEverything();
  fs.cpSync(path.join(ASSETS, 'gateway'), P.GATEWAY_DIR, { recursive: true });
  process.env.CHEAPER_PORT = await freePortSync();

  const rep = await freshness.report();
  const gw = row(rep.items, 'gateway');

  assert.strictEqual(gw.up, false, 'the probe must have failed for this test to mean anything');
  assert.notStrictEqual(gw.state, 'ok',
    'a router that is not running is not "current" — `up` was computed and never read');
  assert.strictEqual(gw.state, 'stopped', 'state=' + gw.state + ' hint=' + gw.hint);
  assert.match(gw.hint, /cheaper gateway start/,
    'the row a user reads must carry the command that fixes it\n' + gw.hint);
  // The distinction that must survive: stopped is one command from working, missing
  // needs an install first. Printing the wrong one of those is printing a wrong fix.
  assert.doesNotMatch(gw.hint, /cheaper install/,
    'a stopped gateway does not need reinstalling\n' + gw.hint);
});

test('a gateway that was never installed still reports missing, not stopped', async () => {
  installEverything();
  rm(P.GATEWAY_DIR);
  process.env.CHEAPER_PORT = await freePortSync();

  const gw = row((await freshness.report()).items, 'gateway');
  assert.strictEqual(gw.state, 'missing', 'state=' + gw.state + ' hint=' + gw.hint);
  assert.match(gw.hint, /cheaper install gateway/,
    'never-installed and installed-but-stopped need opposite advice\n' + gw.hint);
});

test('the PRINTED gateway row for a stopped gateway is amber, and is not green', async () => {
  installEverything();
  fs.cpSync(path.join(ASSETS, 'gateway'), P.GATEWAY_DIR, { recursive: true });
  process.env.CHEAPER_PORT = await freePortSync();

  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await freshnessReport.print(); } finally { console.log = orig; }

  const gwLine = lines.find((l) => strip(l).includes('Gateway'));
  assert.ok(gwLine, 'no Gateway row was printed\n' + lines.map(strip).join('\n'));
  // Colour IS the interface: this is the assertion that would have caught the original
  // defect, which had entirely correct WORDS ("not running") in entirely green ink.
  assert.ok(!gwLine.includes(GREEN + 'current'),
    'a stopped gateway rendered green("current") — the reader scanning for a non-green '
    + 'line never sees it\n' + JSON.stringify(gwLine));
  assert.ok(gwLine.includes(AMBER), 'the stopped row must be amber\n' + JSON.stringify(gwLine));
  assert.match(strip(gwLine), /STOPPED/, strip(gwLine));
  assert.match(strip(gwLine), /cheaper gateway start/, strip(gwLine));
});

test('summarize() names the stopped gateway and its start command', async () => {
  installEverything();
  fs.cpSync(path.join(ASSETS, 'gateway'), P.GATEWAY_DIR, { recursive: true });
  process.env.CHEAPER_PORT = await freePortSync();

  const s = freshnessReport.summarize(await freshness.report());
  assert.match(s, /Gateway/, s);
  assert.match(s, /cheaper gateway start/,
    'the one-line nudge is what other commands surface; a stopped router must reach it\n' + s);
  assert.doesNotMatch(s, /Gateway.*out of date/,
    'a stopped gateway is NOT out of date — saying so sends the user to reinstall\n' + s);
});

// ===========================================================================
// HIGH 5 — THE GATEWAY IS NOT ALWAYS ON 8787
// ===========================================================================

// Installs a current gateway, stands a healthy one up on an ephemeral port, and points the
// pid file at it — while CHEAPER_PORT names somewhere else entirely, which is precisely the
// shape of the bug: the shell never hears about the port the gateway actually bound.
async function gatewayElsewhere(pidPort) {
  installEverything();
  fs.cpSync(path.join(ASSETS, 'gateway'), P.GATEWAY_DIR, { recursive: true });
  const gw = await fakeGateway(ourHealth(freshness.gatewayCodeHash(P.GATEWAY_DIR)));
  process.env.CHEAPER_PORT = await freePortSync();   // a port with nothing on it
  if (pidPort !== false) writePidFile(process.pid, pidPort === undefined ? gw.port : pidPort);
  return gw;
}

test('a healthy gateway on a NON-DEFAULT port is found, not reported STOPPED', async () => {
  const gw = await gatewayElsewhere();
  try {
    const item = row((await freshness.report()).items, 'gateway');
    assert.strictEqual(item.up, true,
      'the probe must reach the port the PID FILE records, not the one the shell guesses '
      + `(pid file: ${gw.port}, CHEAPER_PORT: ${process.env.CHEAPER_PORT})`);
    assert.notStrictEqual(item.state, 'stopped',
      'this is the P0.5 row turned into a false alarm: amber STOPPED, and a `gateway start` '
      + 'that would fail to bind, printed over a gateway that is serving\n' + item.hint);
    assert.strictEqual(item.state, 'ok', 'state=' + item.state + ' hint=' + item.hint);
    assert.strictEqual(item.running, freshness.gatewayCodeHash(P.GATEWAY_DIR),
      'and the build it reported must be the one that answered');
  } finally {
    await closeServer(gw);
  }
});

test('the PRINTED row for a gateway on another port is not amber STOPPED either', async () => {
  const gw = await gatewayElsewhere();
  const lines = [];
  const orig = console.log;
  try {
    console.log = (...a) => lines.push(a.join(' '));
    await freshnessReport.print();
  } finally {
    console.log = orig;
    await closeServer(gw);
  }
  const gwLine = lines.find((l) => strip(l).includes('Gateway'));
  assert.ok(gwLine, 'no Gateway row was printed\n' + lines.map(strip).join('\n'));
  assert.doesNotMatch(strip(gwLine), /STOPPED/,
    'the row a user reads is the whole point — a healthy gateway must not be called stopped\n'
    + strip(gwLine));
  assert.doesNotMatch(strip(gwLine), /cheaper gateway start/,
    'nor be handed a command that would fail to bind the port it names\n' + strip(gwLine));
});

test('a LEGACY bare-pid file still falls back to CHEAPER_PORT', async () => {
  // Older builds wrote just the number. Those installs must keep working exactly as they
  // did: no port line means UNKNOWN, which falls through to the environment — it must never
  // be read as 8787, and must never make the pid file take precedence over nothing.
  const gw = await gatewayElsewhere(false);
  process.env.CHEAPER_PORT = gw.port;
  writePidFile(process.pid, null);
  try {
    const item = row((await freshness.report()).items, 'gateway');
    assert.strictEqual(item.up, true,
      'a pid file with no port must not shadow CHEAPER_PORT\n' + item.hint);
    assert.strictEqual(item.state, 'ok', 'state=' + item.state + ' hint=' + item.hint);
  } finally {
    await closeServer(gw);
  }
});

test('a STALE pid file does not aim the check at a port nothing is on', async () => {
  // Nothing clears gateway.pid on a crash or a reboot, so a dead pid recording port X is the
  // normal shape of a machine that has been rebooted. Preferring it would point every reader
  // away from the gateway that is actually running.
  const gw = await gatewayElsewhere(false);
  process.env.CHEAPER_PORT = gw.port;
  const deadPort = await freePortSync();
  writePidFile(2147483646, deadPort);   // a pid that cannot be live
  try {
    const item = row((await freshness.report()).items, 'gateway');
    assert.strictEqual(item.up, true,
      `a dead pid's port (${deadPort}) must not shadow the live gateway on ${gw.port}\n`
      + item.hint);
    assert.strictEqual(item.state, 'ok', 'state=' + item.state + ' hint=' + item.hint);
  } finally {
    await closeServer(gw);
  }
});

test('launch.js health-checks the port the gateway is ON, not the one the shell guesses', async () => {
  // launch.js has no suite of its own, and the resolver it now shares lives in this file.
  // It used to destructure gateway.PORT — a constant fixed when the module was first
  // required — so `cheaper launch` polled localhost:8787 for fifteen seconds, declared a
  // perfectly healthy gateway unhealthy, told the user to go read the log, and exited 1.
  const gw = await gatewayElsewhere();
  const lines = [];
  const orig = console.log;
  try {
    console.log = (...a) => lines.push(a.join(' '));
    const launch = require('../src/launch');
    // The pid file is what tells launch a gateway is already up, so nothing is ever spawned
    // here — this test must not start a real uvicorn.
    assert.strictEqual(launch.isGatewayRunning(), true,
      'the fixture must look running, or ensureGatewayUp would try to START a gateway');
    assert.strictEqual(await launch.ensureGatewayUp(), true,
      `a healthy gateway on ${gw.port} must satisfy the health gate (CHEAPER_PORT is `
      + `${process.env.CHEAPER_PORT})\n` + lines.map(strip).join('\n'));
  } finally {
    console.log = orig;
    await closeServer(gw);
  }
});

// ===========================================================================
// MEDIUM 12 — A 200 IS NOT AN IDENTITY
// ===========================================================================

test('a squatter answering {ok:true} is NOT reported as a Cheaper gateway', async () => {
  installEverything();
  fs.cpSync(path.join(ASSETS, 'gateway'), P.GATEWAY_DIR, { recursive: true });
  // Any dev server, tunnel or unrelated app that got to the port first can answer this.
  const squat = await fakeGateway({ ok: true });
  process.env.CHEAPER_PORT = squat.port;
  try {
    const item = row((await freshness.report()).items, 'gateway');
    assert.strictEqual(item.up, false,
      'something answered, but nothing proved it was ours — `up` claims the gateway is '
      + 'running\n' + item.hint);
    assert.strictEqual(item.state, 'stopped',
      'our gateway is not running; that is the honest row\n' + 'state=' + item.state);
    assert.doesNotMatch(item.hint, /predates version reporting/,
      'the old code invented a Cheaper build history for a stranger\'s service, purely '
      + 'because it answered 200 without a code_sha\n' + item.hint);
    assert.strictEqual(item.running, null,
      'and must not publish a running build for a process it never identified');
  } finally {
    await closeServer(squat);
  }
});

test('an OLD Cheaper gateway is still recognised as ours, via the pid file', async () => {
  // The mirror of the test above, and the reason identity cannot simply be "isOurGateway or
  // nothing": a Cheaper build that predates the /healthz identity fields IS ours and IS
  // stale, and it needs `gateway restart`, not `gateway start`.
  installEverything();
  fs.cpSync(path.join(ASSETS, 'gateway'), P.GATEWAY_DIR, { recursive: true });
  const old = await fakeGateway({ ok: true });   // no mode/auth_required/token_private/code_sha
  process.env.CHEAPER_PORT = old.port;
  // `ps -o command=` for THIS pid reports the node test runner, which correctly does not
  // look like uvicorn — and this suite must not start a real one. The one call freshness
  // makes into that check is stubbed for the duration, and restored in `finally`; stubbing
  // it is what keeps the assertion about FRESHNESS'S branch rather than about `ps`.
  const gateway = require('../src/gateway');
  const realLooks = gateway.pidLooksLikeGateway;
  gateway.pidLooksLikeGateway = (pid) => pid === process.pid;
  writePidFile(process.pid, old.port);
  try {
    const item = row((await freshness.report()).items, 'gateway');
    assert.strictEqual(item.up, true,
      'a live pid that runs our uvicorn is the evidence that an unidentified 200 is ours\n'
      + item.hint);
    assert.strictEqual(item.state, 'restart', 'state=' + item.state + ' hint=' + item.hint);
    assert.match(item.hint, /running build predates version reporting/, item.hint);
    assert.match(item.hint, /cheaper gateway restart/,
      'restart, not start: it is already running\n' + item.hint);
  } finally {
    gateway.pidLooksLikeGateway = realLooks;
    await closeServer(old);
  }
});

// ===========================================================================
// P2.6 — THE FIVE UNCHECKED CLAUDE-OWNED SURFACES
// ===========================================================================

test('a complete install reports every Claude-owned surface as ok', () => {
  installEverything();
  const items = freshness.claudeSurfaces();
  for (const key of ['skill', 'agents', 'hook', 'settings-plugin',
    'known-marketplaces', 'installed-plugins']) {
    const i = row(items, key);
    assert.strictEqual(i.state, 'ok',
      `${key} must be ok on a complete install, or every real finding below is noise `
      + `— state=${i.state} hint=${i.hint}`);
  }
});

test('report() actually CARRIES the Claude-owned rows — the check must be wired in', async () => {
  // Found by mutation: commenting out the single `items.push(...claudeSurfaces())` line
  // in report() left every test below green, because they all call claudeSurfaces()
  // directly. A check nothing renders is a check that does not exist — which is the
  // exact shape of the P2.6 defect being fixed here (the `up` field was computed and
  // never read for two releases).
  installEverything();
  fs.cpSync(path.join(ASSETS, 'gateway'), P.GATEWAY_DIR, { recursive: true });
  process.env.CHEAPER_PORT = await freePortSync();
  fs.rmSync(path.join(P.AGENTS_DIR, 'router-triage.md'));

  const rep = await freshness.report();
  const keys = rep.items.map((i) => i.key);
  for (const key of ['skill', 'agents', 'hook', 'settings-plugin',
    'known-marketplaces', 'installed-plugins']) {
    assert.ok(keys.includes(key), `report() dropped the ${key} row — ${keys.join(', ')}`);
  }
  assert.strictEqual(row(rep.items, 'agents').state, 'broken',
    'and the finding must survive the trip through report()');

  // …and it must reach the sentence a user actually reads.
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await freshnessReport.print(); } finally { console.log = orig; }
  const printed = strip(lines.join('\n'));
  assert.match(printed, /Agents \(~\/\.claude\/agents\)/, printed);
  assert.match(printed, /router-triage\.md/, printed);
});

test('a deleted agent file is BROKEN and the row names the file', () => {
  installEverything();
  fs.rmSync(path.join(P.AGENTS_DIR, 'router-triage.md'));

  const i = row(freshness.claudeSurfaces(), 'agents');
  assert.strictEqual(i.state, 'broken',
    'one absent tier is not "mostly installed" — it is a tier that never escalates\n'
    + i.hint);
  assert.match(i.hint, /router-triage\.md/,
    'the row must name WHICH agent is gone, or the user cannot act on it\n' + i.hint);
  assert.match(i.hint, /cheaper install agents/, i.hint);
});

test('an agent file whose bytes drifted from source is STALE (not silently ok)', () => {
  installEverything();
  fs.appendFileSync(path.join(P.AGENTS_DIR, 'router-solver-opus.md'), '\nedited by hand\n');

  const i = row(freshness.claudeSurfaces(), 'agents');
  assert.strictEqual(i.state, 'stale', 'state=' + i.state + ' hint=' + i.hint);
  assert.match(i.hint, /router-solver-opus\.md/, i.hint);
});

test('the agent list is read from source, so a new agent is covered without an edit', () => {
  installEverything();
  // Pinning the SHAPE of the check, not just its result. A hardcoded three-name list
  // would keep reporting "current" for an agent added to assets/plugin/agents later —
  // the same class of defect as peek's four hardcoded tables.
  const extra = path.join(ASSETS, 'plugin', 'agents', 'router-zzz-probe.md');
  fs.writeFileSync(extra, '# probe\n');
  try {
    const i = row(freshness.claudeSurfaces(), 'agents');
    assert.strictEqual(i.state, 'broken',
      'an agent present in source but absent from ~/.claude/agents must be reported\n' + i.hint);
    assert.match(i.hint, /router-zzz-probe\.md/, i.hint);
  } finally {
    fs.rmSync(extra);
  }
});

test('a hook entry that no longer references router-policy is BROKEN, naming the event', () => {
  installEverything();
  const s = readJson(P.SETTINGS);
  // The realistic corruption: the entry survives, the command it runs does not.
  s.hooks.UserPromptSubmit = [hookEntry('echo "some other tool took this slot"')];
  writeJson(P.SETTINGS, s);

  const i = row(freshness.claudeSurfaces(), 'hook');
  assert.strictEqual(i.state, 'broken',
    'half-wired hooks inject the policy on session start and never again\n' + i.hint);
  assert.match(i.hint, /UserPromptSubmit/,
    'the row must name the event that lost its entry\n' + i.hint);
  assert.doesNotMatch(i.hint, /SessionStart/,
    'and must not accuse the event that is still correctly wired\n' + i.hint);
});

test('hooks wired to a policy file that is gone is BROKEN, not ok', () => {
  installEverything();
  fs.rmSync(P.HOOK_POLICY);

  const i = row(freshness.claudeSurfaces(), 'hook');
  assert.strictEqual(i.state, 'broken',
    '`cat` on a missing file injects an EMPTY policy and Claude tolerates it, so this '
    + 'failure is completely silent while settings.json still looks right\n' + i.hint);
  assert.match(i.hint, /router-policy\.md/, i.hint);
});

test('a dropped enabledPlugins key is BROKEN and the row names enabledPlugins', () => {
  installEverything();
  const s = readJson(P.SETTINGS);
  delete s.enabledPlugins;
  writeJson(P.SETTINGS, s);

  const i = row(freshness.claudeSurfaces(), 'settings-plugin');
  assert.strictEqual(i.state, 'broken',
    'the registry still lists the plugin, so Claude reports it installed and never '
    + 'loads it\n' + i.hint);
  assert.match(i.hint, /enabledPlugins/,
    'the row must name the key that is gone\n' + i.hint);
  assert.match(i.hint, /cheaper install plugin/, i.hint);
});

test('enabledPlugins set to false is BROKEN, and says so rather than "gone"', () => {
  installEverything();
  const s = readJson(P.SETTINGS);
  s.enabledPlugins[P.PLUGIN_ID] = false;
  writeJson(P.SETTINGS, s);

  const i = row(freshness.claudeSurfaces(), 'settings-plugin');
  assert.strictEqual(i.state, 'broken', i.hint);
  assert.match(i.hint, /false, not true/,
    'disabled and deleted are different edits and need different words\n' + i.hint);
});

test('a marketplace registry pointing at a deleted directory is BROKEN', () => {
  installEverything();
  rm(P.MARKETPLACE_DIR);

  const i = row(freshness.claudeSurfaces(), 'known-marketplaces');
  assert.strictEqual(i.state, 'broken',
    'Claude believes the marketplace is known, finds nothing to load, and says nothing\n'
    + i.hint);
  assert.match(i.hint, /installLocation/, i.hint);
});

test('a plugin registry entry whose installPath is gone is BROKEN', () => {
  installEverything();
  rm(CACHE_DST);

  const i = row(freshness.claudeSurfaces(), 'installed-plugins');
  assert.strictEqual(i.state, 'broken', i.hint);
  assert.match(i.hint, /installPath/, i.hint);
});

test('a skill whose bytes drifted from source is STALE', () => {
  installEverything();
  fs.writeFileSync(path.join(P.SKILLS_DIR, 'adaptive-model-router', 'SKILL.md'), '# gutted\n');

  const i = row(freshness.claudeSurfaces(), 'skill');
  assert.strictEqual(i.state, 'stale', 'state=' + i.state + ' hint=' + i.hint);
});

// ---- "could not check" must never read as "fine" ---------------------------

test('an unparseable settings.json is CANNOT VERIFY — never ok, never "not installed"', () => {
  installEverything();
  fs.writeFileSync(P.SETTINGS, '{ "hooks": { oops\n');

  const items = freshness.claudeSurfaces();
  for (const key of ['hook', 'settings-plugin']) {
    const i = row(items, key);
    assert.strictEqual(i.state, 'unverified',
      `${key} must say the check could not RUN — 'ok' claims a pass that never happened `
      + `and 'missing' claims a fact it does not know — state=${i.state} hint=${i.hint}`);
    assert.match(i.hint, /malformed|unreadable/, i.hint);
  }
});

test('CANNOT VERIFY prints amber and reaches the summary line', () => {
  installEverything();
  fs.writeFileSync(P.SETTINGS, '{ "hooks": { oops\n');

  const rep = { items: freshness.claudeSurfaces() };
  const s = freshnessReport.summarize(rep);
  assert.match(s, /Hook/, 'an un-runnable check must not be silent\n' + s);

  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    // Render through the same MARK table the real report uses.
    for (const i of rep.items) console.log(i.key, freshnessReport.MARK[i.state]());
  } finally { console.log = orig; }
  const hookLine = lines.find((l) => l.startsWith('hook '));
  assert.ok(hookLine.includes(AMBER),
    'amber, not dim and not green: "could not determine" is a finding\n' + JSON.stringify(hookLine));
  assert.match(strip(hookLine), /CANNOT VERIFY/, strip(hookLine));
});

test('BROKEN prints red', () => {
  installEverything();
  const s = readJson(P.SETTINGS);
  delete s.enabledPlugins;
  writeJson(P.SETTINGS, s);
  const i = row(freshness.claudeSurfaces(), 'settings-plugin');
  const rendered = freshnessReport.MARK[i.state]();
  assert.ok(rendered.includes(RED), JSON.stringify(rendered));
});

// ---- the false alarms this must NOT raise ---------------------------------

test('with the plugin registered, the removed standalone copies are NOT a finding', () => {
  installEverything();
  // Exactly what `cheaper install plugin` does: it deletes the standalone skill,
  // agents and hook because the plugin bundles all three (install.js:196-201). A check
  // that complains here would put a permanent red row on every plugin user's screen,
  // and a warning that is always on is a warning nobody reads.
  rm(path.join(P.SKILLS_DIR, 'adaptive-model-router'));
  rm(P.AGENTS_DIR);
  const s = readJson(P.SETTINGS);
  delete s.hooks;
  writeJson(P.SETTINGS, s);

  const items = freshness.claudeSurfaces();
  for (const key of ['skill', 'agents', 'hook']) {
    const i = row(items, key);
    assert.strictEqual(i.state, 'ok', `${key}: state=${i.state} hint=${i.hint}`);
    assert.match(i.hint, /plugin bundle/, i.hint);
  }
  assert.strictEqual(freshnessReport.summarize({ items }), '',
    'a plugin-only install must produce NO nudge at all');
});

test('without the plugin, an absent skill/agents/hook is "not installed", not BROKEN', () => {
  installEverything();
  rm(P.INSTALLED_PLUGINS);                       // no plugin registered
  rm(path.join(P.SKILLS_DIR, 'adaptive-model-router'));
  rm(P.AGENTS_DIR);
  const s = readJson(P.SETTINGS);
  delete s.hooks;
  writeJson(P.SETTINGS, s);

  const items = freshness.claudeSurfaces();
  for (const key of ['skill', 'agents', 'hook']) {
    const i = row(items, key);
    assert.strictEqual(i.state, 'missing',
      `a component this user never installed is not an alarm — ${key} state=${i.state}`);
  }
});

test('installed_plugins.json holding only OTHER plugins is "not installed", not BROKEN', () => {
  installEverything();
  writeJson(P.INSTALLED_PLUGINS, { version: 2, plugins: { 'somebody-else@their-market': [{}] } });

  const i = row(freshness.claudeSurfaces(), 'installed-plugins');
  assert.strictEqual(i.state, 'missing',
    'the file belongs to Claude and legitimately holds other people\'s plugins\n' + i.hint);
});

test.after(() => { rm(SANDBOX); });
