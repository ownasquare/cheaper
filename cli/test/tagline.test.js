'use strict';
// The tagline's HONESTY GATES — the three ways the closing line of a chat could assert
// something nobody verified:
//
//   1. It printed a savings figure with no word about the gateway being DEAD, while a
//      merely stale gateway got an explicit warning. The user read "Cheaper.app saved $84"
//      and concluded routing was working.
//   2. It appended a "See logs" link to http://localhost:8787/dashboard unconditionally.
//      The reported bug: they clicked it and got ERR_CONNECTION_REFUSED.
//   3. It credited Cheaper — "saved … by running X instead of Y" — for a model mix the
//      harness itself chose, in every harness that does not tag sub-agent work.
//
// …and the fourth, which turned (1) into a false alarm on EVERY chat: the notice named a
// hardcoded :8787, so a user whose gateway is healthy on another port was told at the end of
// every single chat that no gateway was reachable and that they should start one.
//
// Nothing here touches the network beyond 127.0.0.1 servers this file starts and stops, and
// every path (~/.cheaper, the ledger, the token file, the harness history root) is injected
// into a temp dir.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const httpMod = require('http');

// --- sandbox HOME BEFORE paths.js is loaded ----------------------------------------
// The tagline now resolves its port from ~/.cheaper/gateway.pid before falling back to
// CHEAPER_PORT, and paths.js reads the home directory once at require time. Without this,
// every test below would read the DEVELOPER'S real pid file — so the suite would pass or
// fail depending on whether a real gateway happened to be running, and a test that sets
// CHEAPER_PORT to a dead port could quietly probe a live gateway on 8787 instead.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'tagline-home-'));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;

const P = require('../src/paths');
const TAG = path.join(__dirname, '..', 'src', 'peek', 'tagline.js');
const { realizedFromRecords, fromGateway, buildTagline,
        PROBE, gatewayIsListening, gatewayFallbackNotice, dashboardUrl } = require(TAG);

// ---- fixtures ---------------------------------------------------------------------

// A chat whose transcript estimate is a confident +$84 on 2.0M tokens: a 1M/1M Opus turn
// and a 1M/1M Haiku call. `sidechain` decides the ONLY thing that differs between the two
// P2.4 cases — whether the cheap call is tagged as delegated (Cheaper routed it) or as
// another top-level turn (the harness picked it).
function chatLines(sidechain) {
  return [
    { type: 'user', message: { role: 'user', content: 'rename foo' }, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'assistant', isSidechain: false, message: { id: 't1', role: 'assistant', model: 'claude-opus-4',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1e6, output_tokens: 1e6 } },
      timestamp: '2026-01-01T00:00:01Z' },
    { type: 'assistant', isSidechain: !!sidechain, message: { id: 't2', role: 'assistant', model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1e6, output_tokens: 1e6 } },
      timestamp: '2026-01-01T00:00:02Z' },
  ];
}

// A current-build gateway summary that measures a real $2.00 saving for that chat.
function liveSummary() {
  return {
    catalog: { priced: true, as_of: '2026-08-06', age_days: 1 },
    total: 2,
    baseline_model: 'claude-opus-5',
    top_model: 'claude-opus-5',
    by_tier: { opus: { count: 1, in_tokens: 1e6, out_tokens: 5e5 },
               haiku: { count: 1, in_tokens: 4e5, out_tokens: 1e5 } },
    dollars: { saved: 2, spent: 5, gross: 2, extra: 0, billed_top: 7, savings_pct: 28.6 },
    counts: { models_changed: 1, models_upcharged: 0,
              examined: 2, priced: 2, unpriced_total: 0, truncated: false },
    tokens: { downgraded: 500000 },
    downgraded_by_model: { 'claude-haiku-4-5': 1 },
    upcharged_by_model: {},
  };
}

// A port with nothing on it: bind, read the assigned port, release it. A hardcoded port
// number would be a coin flip against whatever else is running on the machine, and this
// suite's whole subject is telling "refused" apart from "answered".
function freePort() {
  return new Promise((resolve) => {
    const srv = httpMod.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// A throwaway localhost gateway. `mode` picks WHAT it answers with, which is the axis the
// probe has to distinguish. Counts requests so "reuse the probe, do not issue a second one"
// is an assertion rather than a hope.
function fakeGateway(mode, body) {
  const state = { requests: 0, srv: null };
  return new Promise((resolve) => {
    const srv = httpMod.createServer((req, res) => {
      state.requests++;
      if (mode === 'reject') { res.writeHead(401); return res.end('no'); }
      if (mode === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{not json'); }
      if (mode === 'hang') return;   // never answers — exercises the probe's own timeout
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    srv.listen(0, '127.0.0.1', () => { state.srv = srv; resolve(state); });
  });
}

const MODS = ['fsutil', 'adapters', 'scan', 'ledger', 'tagline'];
function freshTagline() {
  for (const m of MODS) delete require.cache[require.resolve('../src/peek/' + m)];
  return require(TAG);
}

// Run the real `tagline.run()` against a temp chat and a controlled gateway, capturing BOTH
// streams: stdout carries the line, stderr carries the notice, and the whole point of P0.1
// is that those two must agree about whether anything was measured.
//
// opts: { sidechain, gateway: 'ok'|'reject'|'malformed'|'hang'|null, summary, env, run,
//         viaPidFile }
// `viaPidFile` reproduces the HIGH 5 shape: the gateway is on one port, the pid file records
// it, and CHEAPER_PORT — all the shell ever knows — names a port with nothing on it.
async function runTagline(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagline-honesty-'));
  const proj = path.join(dir, '.claude', 'projects', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 'sesH.jsonl');
  fs.writeFileSync(file, chatLines(opts.sidechain).map((l) => JSON.stringify(l)).join('\n') + '\n');

  const gw = opts.gateway ? await fakeGateway(opts.gateway, opts.summary || liveSummary()) : null;
  const dead = gw ? null : await freePort();

  const keys = ['CHEAPER_PEEK_HOME', 'CHEAPER_LEDGER_FILE', 'CHEAPER_PORT', 'CHEAPER_TOKEN_FILE',
                'CHEAPER_DASHBOARD_URL', 'CHEAPER_QUIET'];
  const prev = {}; for (const k of keys) prev[k] = process.env[k];
  process.env.CHEAPER_PEEK_HOME = dir;
  process.env.CHEAPER_LEDGER_FILE = path.join(dir, 'lifetime.json');
  process.env.CHEAPER_PORT = String(gw ? gw.srv.address().port : dead);
  // Never read (and therefore never transmit) the real ~/.cheaper/dash.token.
  process.env.CHEAPER_TOKEN_FILE = path.join(dir, 'no-such.token');
  delete process.env.CHEAPER_DASHBOARD_URL;
  delete process.env.CHEAPER_QUIET;
  if (opts.viaPidFile && gw) {
    // Written exactly as gateway.js::writePidFile writes it: pid on the first line, `port=`
    // on the second. Our own pid, because the resolver ignores a pid file whose process is
    // gone — a stale file records where a gateway USED to be.
    process.env.CHEAPER_PORT = String(await freePort());
    fs.mkdirSync(P.CHEAPER_DIR, { recursive: true });
    fs.writeFileSync(P.GATEWAY_PID, `${process.pid}\nport=${gw.srv.address().port}\n`);
  }
  for (const [k, v] of Object.entries(opts.env || {})) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  const out = []; const err = [];
  const oLog = console.log; const oErr = console.error;
  console.log = (s) => out.push(String(s));
  console.error = (s) => err.push(String(s));
  try {
    const tag = freshTagline();
    await tag.run(Object.assign({ transcript: file, json: true }, opts.run || {}));
    return { json: JSON.parse(out[out.length - 1]), stderr: err.join('\n'),
             requests: gw ? gw.requests : 0, port: process.env.CHEAPER_PORT,
             // Where the gateway really is, which `port` only equals when nothing moved it.
             gatewayPort: gw ? String(gw.srv.address().port) : null };
  } finally {
    console.log = oLog; console.error = oErr;
    if (gw) await new Promise((r) => gw.srv.close(r));
    fs.rmSync(P.GATEWAY_PID, { force: true });
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
    for (const m of MODS) delete require.cache[require.resolve('../src/peek/' + m)];
  }
}

// ---- P0.1: an UNREACHABLE gateway is stated, not passed over in silence --------------

test('P0.1: a dead gateway gets a notice of the same class as the stale-build warning', async () => {
  // The asymmetry that was the defect: a REACHABLE-but-stale gateway printed
  // "gateway is running an older build; ... Fix with: cheaper gateway restart", while an
  // unreachable one printed nothing at all — so the strictly worse case was the quiet one.
  const r = await runTagline({ sidechain: true, gateway: null });
  assert.equal(r.json.source, 'estimate', 'a dead gateway must fall back: ' + r.json.source);
  assert.equal(r.json.gateway.probe, PROBE.UNREACHABLE, 'probe=' + r.json.gateway.probe);
  assert.match(r.stderr, /^cheaper: gateway not reachable on :\d+ — this figure is a local estimate, not measured routing\. Start it with: cheaper gateway start$/,
    'the notice must name the port, the nature of the figure, and the fix: ' + JSON.stringify(r.stderr));
  assert.ok(r.stderr.includes(':' + r.port), 'the notice must name the PROBED port: ' + r.stderr);
  // The stdout number and its hedging are untouched — this change adds a warning, it does
  // not move money.
  assert.match(r.json.line, /saved 🟢 about \$84\.00 and 2\.0M tokens/, r.json.line);
});

test('P0.1: CHEAPER_QUIET gates the new notice exactly as it gates the stale-build one', async () => {
  const r = await runTagline({ sidechain: true, gateway: null, env: { CHEAPER_QUIET: '1' } });
  assert.equal(r.json.gateway.probe, PROBE.UNREACHABLE, 'the probe still runs when quiet');
  assert.equal(r.stderr, '', 'quiet mode must print nothing: ' + JSON.stringify(r.stderr));
});

test('P0.1: a LIVE gateway is never accused of being down', async () => {
  const r = await runTagline({ sidechain: true, gateway: 'ok' });
  assert.equal(r.json.source, 'gateway', 'source=' + r.json.source);
  assert.equal(r.json.gateway.probe, PROBE.ANSWERED);
  assert.equal(r.stderr, '', 'a working gateway warrants no notice: ' + JSON.stringify(r.stderr));
});

test('P0.1: a gateway that answers 401 is reported as unreadable, not as absent', async () => {
  // "Could not determine" must not read as "fine", but it must not read as the WRONG
  // failure either: a live gateway with a stale token is not fixed by `gateway start`.
  const r = await runTagline({ sidechain: true, gateway: 'reject' });
  assert.equal(r.json.gateway.probe, PROBE.REJECTED, 'probe=' + r.json.gateway.probe);
  assert.equal(r.json.gateway.status, 401);
  assert.match(r.stderr, /answered HTTP 401, so its measurements could not be read/, r.stderr);
  assert.ok(!/not reachable/.test(r.stderr), 'a listening gateway is not unreachable: ' + r.stderr);
  assert.ok(!/gateway start/.test(r.stderr), 'must not tell them to start what is running: ' + r.stderr);
  assert.equal(r.json.source, 'estimate', 'unreadable metrics still fall back to the estimate');
});

test('P0.1: NO SESSION ID means the probe never ran — and claims nothing in either direction', async () => {
  // `--current` resolves no session id, so no request is made. That is not evidence the
  // gateway is down; printing "not reachable" here would be a fabricated diagnosis.
  const r = await runTagline({ sidechain: true, gateway: null, run: { transcript: undefined, current: true } });
  assert.equal(r.json.gateway.probe, PROBE.NOT_PROBED, 'probe=' + r.json.gateway.probe);
  assert.equal(r.stderr, '', 'an unasked question has no answer to report: ' + JSON.stringify(r.stderr));
  assert.ok(!/See logs/.test(r.json.full), 'nor may it claim the dashboard resolves: ' + r.json.full);
});

test('no session id but a LIVE gateway still gets the logs link — the invocation style is '
   + 'not a fact about the gateway', async () => {
    // The bug: with neither --session nor --transcript there is no session id, so
    // computeSavings issued nothing, the outcome stayed NOT_PROBED, and dashboardUrl()
    // suppressed the link — against a gateway answering on that very port. A hand-run
    // `cheaper peek --tagline` hid a dashboard that was demonstrably up, and the owner read
    // that as "the logs link disappeared".
    const r = await runTagline({ sidechain: true, gateway: 'ok',
                                 run: { transcript: undefined, current: true } });
    assert.equal(r.json.gateway.probe, PROBE.LIVE,
      'a liveness check that answered must be reported as its own outcome, not as NOT_PROBED '
      + 'and not as ANSWERED (there is no summary): probe=' + r.json.gateway.probe);
    assert.match(r.json.full, /See logs/,
      'the link is still suppressed against a gateway that answered: ' + r.json.full);
    assert.equal(r.stderr, '',
      'a gateway we confirmed is UP has no fallback to explain: ' + JSON.stringify(r.stderr));
    // Exactly ONE request. Zero was the bug; two would be the duplicated GET that
    // dashboardUrl()'s comment forbids on the Stop hook's hot path.
    assert.equal(r.requests, 1,
      `the no-session path made ${r.requests} request(s); it must make exactly one`);
  });

test('a liveness probe that FAILS stays NOT_PROBED — it must not invent a diagnosis', async () => {
  // The upgrade-only rule. gatewayFallbackNotice() exists to explain why the MEASUREMENT fell
  // back to an estimate; on this path no measurement was ever attempted, so a failed liveness
  // check must not start printing "gateway not reachable — this figure is a local estimate,
  // not measured routing". That silence is what the P0.1 test above pins, and widening the
  // probe must not cost it.
  const r = await runTagline({ sidechain: true, gateway: null,
                               run: { transcript: undefined, current: true } });
  assert.equal(r.json.gateway.probe, PROBE.NOT_PROBED,
    'a failed liveness check leaked into the reported outcome: ' + r.json.gateway.probe);
  assert.equal(r.stderr, '', 'it fabricated a diagnosis: ' + JSON.stringify(r.stderr));
  assert.ok(!/See logs/.test(r.json.full), 'and still must not claim the page resolves');
});

test('the liveness probe asks /healthz, never the token-gated /metrics', async () => {
  // /healthz is unauthenticated, so this path can never 401 and can never be tempted to read
  // a summary it did not ask for. It also keeps the real ~/.cheaper/dash.token out of a
  // request made purely to decide whether to print a link.
  const paths = [];
  const srv = httpMod.createServer((req, res) => {
    paths.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const prevPort = process.env.CHEAPER_PORT;
  process.env.CHEAPER_PORT = String(srv.address().port);
  try {
    const tag = freshTagline();
    const out = await tag.probeGatewayLiveness();
    assert.equal(out.outcome, PROBE.LIVE);
    assert.deepEqual(paths, ['/healthz'],
      'the liveness probe hit ' + JSON.stringify(paths) + ' instead of /healthz alone');
  } finally {
    if (prevPort === undefined) delete process.env.CHEAPER_PORT;
    else process.env.CHEAPER_PORT = prevPort;
    await new Promise((r) => srv.close(r));
  }
});

test('P0.1: the notice distinguishes refused, timed out, unreadable and never-asked', async () => {
  // Four different remedies, so four different sentences. Collapsing them is what made the
  // original bug invisible.
  const port = process.env.CHEAPER_PORT; process.env.CHEAPER_PORT = '18787';
  try {
    assert.match(gatewayFallbackNotice({ outcome: PROBE.UNREACHABLE }),
      /^cheaper: gateway not reachable on :18787 .* Start it with: cheaper gateway start$/);
    assert.match(gatewayFallbackNotice({ outcome: PROBE.TIMEOUT, timeoutMs: 600 }),
      /^cheaper: gateway on :18787 did not answer within 600 ms — this figure is a local estimate, not measured routing\.$/);
    assert.ok(!/gateway start/.test(gatewayFallbackNotice({ outcome: PROBE.TIMEOUT, timeoutMs: 600 })),
      'a slow gateway may well be running');
    assert.match(gatewayFallbackNotice({ outcome: PROBE.REJECTED, status: 500 }), /answered HTTP 500/);
    assert.match(gatewayFallbackNotice({ outcome: PROBE.MALFORMED }), /could not parse/);
    assert.equal(gatewayFallbackNotice({ outcome: PROBE.ANSWERED }), '');
    assert.equal(gatewayFallbackNotice({ outcome: PROBE.NOT_PROBED }), '');
    assert.equal(gatewayFallbackNotice(null), '');
  } finally {
    if (port === undefined) delete process.env.CHEAPER_PORT; else process.env.CHEAPER_PORT = port;
  }
});

test('P0.1: a gateway that never answers is TIMED OUT, not declared absent', async () => {
  // A real socket that accepts and then says nothing — the only way to reach the probe's own
  // timeout branch. Classifying this as UNREACHABLE would tell a user whose gateway is alive
  // but busy to start a second one.
  const r = await runTagline({ sidechain: true, gateway: 'hang' });
  assert.equal(r.json.gateway.probe, PROBE.TIMEOUT, 'probe=' + r.json.gateway.probe);
  assert.match(r.stderr, /did not answer within 600 ms/, r.stderr);
  assert.ok(!/not reachable/.test(r.stderr), 'a live socket is not unreachable: ' + r.stderr);
  assert.equal(r.json.source, 'estimate');
  // Unknown, so no link: the probe never got far enough to prove the page resolves.
  assert.ok(!/See logs/.test(r.json.full), r.json.full);
});

// ---- P0.2: the "See logs" link is a claim, and needs evidence -------------------------

test('P0.2: a dead gateway prints NO "See logs" link — the ERR_CONNECTION_REFUSED bug', async () => {
  const r = await runTagline({ sidechain: true, gateway: null });
  assert.ok(r.json.full.length > 0, 'the line itself still prints');
  assert.ok(!/See logs/.test(r.json.full), 'no link may be offered: ' + r.json.full);
  assert.ok(!/localhost/.test(r.json.full), 'not even a bare URL: ' + r.json.full);
  assert.equal(r.json.gateway.listening, false);
});

test('P0.2: a gateway that answered gets the link, pointing at the port that answered', async () => {
  const r = await runTagline({ sidechain: true, gateway: 'ok' });
  assert.equal(r.json.gateway.listening, true);
  assert.ok(r.json.full.endsWith(` See logs: http://localhost:${r.port}/dashboard`),
    'link must be present and on the probed port: ' + r.json.full);
});

test('P0.2: LISTENING is the bar, not READABLE — a 401 gateway still serves its dashboard', async () => {
  // Requiring a parseable /metrics would hide the dashboard from exactly the users whose
  // gateway is up but whose token is stale — the people most in need of opening it.
  const r = await runTagline({ sidechain: true, gateway: 'reject' });
  assert.equal(r.json.gateway.listening, true, 'a 401 proves a live listener');
  assert.match(r.json.full, / See logs: http:\/\/localhost:\d+\/dashboard$/, r.json.full);
});

test('P0.2: an operator-declared dashboard URL is printed even with no local gateway', async () => {
  // CHEAPER_DASHBOARD_URL may name a host this probe never touched; gating the operator's
  // own assertion on 127.0.0.1 would suppress a link that works.
  const r = await runTagline({ sidechain: true, gateway: null,
    env: { CHEAPER_DASHBOARD_URL: 'https://dash.example.test/x' } });
  assert.equal(r.json.gateway.probe, PROBE.UNREACHABLE);
  assert.ok(r.json.full.endsWith(' See logs: https://dash.example.test/x'), r.json.full);
});

test('P0.2: the link gate costs NO extra request — the probe is reused', async () => {
  const r = await runTagline({ sidechain: true, gateway: 'ok' });
  assert.equal(r.requests, 1, 'exactly one GET to the gateway, got ' + r.requests);
});

test('P0.2: dashboardUrl refuses every probe outcome that is not a live listener', () => {
  const port = process.env.CHEAPER_PORT; const dash = process.env.CHEAPER_DASHBOARD_URL;
  process.env.CHEAPER_PORT = '18787'; delete process.env.CHEAPER_DASHBOARD_URL;
  try {
    assert.equal(dashboardUrl({}, { outcome: PROBE.ANSWERED }), 'http://localhost:18787/dashboard');
    assert.equal(dashboardUrl({}, { outcome: PROBE.REJECTED }), 'http://localhost:18787/dashboard');
    assert.equal(dashboardUrl({}, { outcome: PROBE.MALFORMED }), 'http://localhost:18787/dashboard');
    assert.equal(dashboardUrl({}, { outcome: PROBE.UNREACHABLE }), '');
    assert.equal(dashboardUrl({}, { outcome: PROBE.TIMEOUT }), '', 'a timeout is not evidence of a live page');
    assert.equal(dashboardUrl({}, { outcome: PROBE.NOT_PROBED }), '');
    assert.equal(dashboardUrl({}, undefined), '', 'no probe at all must never render a link');
    assert.equal(dashboardUrl({}, {}), '');
    // The operator's own URL is exempt from the local probe.
    assert.equal(dashboardUrl({ logsUrl: 'http://x.test/d' }, { outcome: PROBE.UNREACHABLE }), 'http://x.test/d');
    assert.equal(gatewayIsListening(PROBE.UNREACHABLE), false);
    assert.equal(gatewayIsListening(PROBE.ANSWERED), true);
  } finally {
    if (port === undefined) delete process.env.CHEAPER_PORT; else process.env.CHEAPER_PORT = port;
    if (dash === undefined) delete process.env.CHEAPER_DASHBOARD_URL; else process.env.CHEAPER_DASHBOARD_URL = dash;
  }
});

// ---- HIGH 5: the gateway is not always on 8787 ---------------------------------------

test('HIGH 5: a gateway on another port is neither accused nor unmeasured', async () => {
  // The defect, end to end: the gateway is up and answering, the pid file says so, and the
  // shell's CHEAPER_PORT names somewhere else — which is what `gateway start --port N` and
  // an autostart entry moved off a busy 8787 both leave behind. The old reader saw only the
  // environment, so it fell back to the transcript estimate AND printed "gateway not
  // reachable … Start it with: cheaper gateway start" on stderr at the end of every chat.
  const r = await runTagline({ sidechain: true, gateway: 'ok', viaPidFile: true });
  assert.notEqual(r.gatewayPort, r.port, 'the two ports must differ or this proves nothing');
  assert.equal(r.stderr, '',
    'a running gateway must never be told to start itself — and this notice prints at the '
    + 'end of EVERY chat: ' + JSON.stringify(r.stderr));
  assert.equal(r.requests, 1, 'the metrics request must have gone to the gateway, got '
    + r.requests + ' request(s) — CHEAPER_PORT was ' + r.port);
  assert.equal(r.json.gateway.probe, PROBE.ANSWERED, 'probe=' + r.json.gateway.probe);
  assert.equal(r.json.gateway.port, r.gatewayPort,
    'the JSON must name the port that was actually probed');
  assert.equal(r.json.source, 'gateway',
    'and its EXACT numbers must be used, not a local estimate: ' + r.json.source);
  assert.ok(r.json.full.endsWith(` See logs: http://localhost:${r.gatewayPort}/dashboard`),
    'the link must point at the port that answered: ' + r.json.full);
});

test('HIGH 5: a STALE pid file does not send the tagline to a dead port', async () => {
  // Nothing clears gateway.pid on a crash or a reboot. A dead pid recording port X must fall
  // through to CHEAPER_PORT, or a rebooted machine would report every chat against a port
  // nothing is on — the same false alarm, in the other direction.
  const dead = await freePort();
  fs.mkdirSync(P.CHEAPER_DIR, { recursive: true });
  fs.writeFileSync(P.GATEWAY_PID, `2147483646\nport=${dead}\n`);   // a pid that cannot be live
  try {
    // runTagline points CHEAPER_PORT at the live fake gateway, as every other test here does.
    const r = await runTagline({ sidechain: true, gateway: 'ok' });
    assert.equal(r.json.gateway.probe, PROBE.ANSWERED,
      `a dead pid's port (${dead}) must not shadow the live gateway on ${r.port} — probe=`
      + r.json.gateway.probe);
    assert.equal(r.json.gateway.port, r.port, 'the probed port must be CHEAPER_PORT');
    assert.equal(r.json.source, 'gateway', 'source=' + r.json.source);
    assert.equal(r.stderr, '', 'and no notice at all: ' + JSON.stringify(r.stderr));
  } finally {
    fs.rmSync(P.GATEWAY_PID, { force: true });
  }
});

// ---- P2.4: credit requires attribution, not just a model mix -------------------------

test('P2.4: routingAttributed is FALSE when no record is tagged as sub-agent work', () => {
  // Codex hardcodes source:'user' on every record (adapters.js::collectCodex), so this is
  // every Codex session that ever ran, not an edge case.
  const codexish = [
    { model: 'claude-opus-4', source: 'user', inTokens: 1e6, inFresh: 1e6, outTokens: 1e6, estimated: true },
    { model: 'claude-haiku-4-5', source: 'user', inTokens: 1e6, inFresh: 1e6, outTokens: 1e6, estimated: true },
  ];
  const r = realizedFromRecords(codexish);
  assert.equal(r.routingAttributed, false, 'a bare model mix attributes nothing');
  // The DIFFERENCE is still measured — suppressing the number was never the fix.
  assert.ok(Math.abs(r.dollarsSaved - 84) < 1e-6, 'dollarsSaved=' + r.dollarsSaved);
  assert.equal(r.creditedCalls, 1);

  const routed = realizedFromRecords([
    { model: 'claude-opus-4', source: 'user', inTokens: 1e6, inFresh: 1e6, outTokens: 1e6 },
    { model: 'claude-haiku-4-5', source: 'subagent', inTokens: 1e6, inFresh: 1e6, outTokens: 1e6 },
  ]);
  assert.equal(routed.routingAttributed, true, 'a tagged sub-agent IS the evidence');
});

test('P2.4: fromGateway marks its own measurement attributed', () => {
  // The gateway counts rows where the model SERVED differed from the model REQUESTED — a
  // substitution only the gateway can have performed.
  const g = fromGateway(liveSummary());
  assert.equal(g.routingAttributed, true);
});

test('P2.4: an unattributed chat states the model mix and REFUSES the credit', () => {
  const r = realizedFromRecords([
    { model: 'claude-opus-4', source: 'user', inTokens: 1e6, inFresh: 1e6, outTokens: 1e6 },
    { model: 'claude-haiku-4-5', source: 'user', inTokens: 1e6, inFresh: 1e6, outTokens: 1e6 },
  ]);
  const line = buildTagline(r);
  // The past-tense credit is GONE — not hedged. "Cheaper.app saved … by running X instead
  // of Y" next to a hedge still reads as a claim.
  assert.ok(!/Cheaper\.app saved/.test(line), 'no credit may be claimed: ' + line);
  assert.ok(!/by running/.test(line), 'no causal phrasing may survive: ' + line);
  // The number is NOT dropped: the cost difference is real and the reader is owed it.
  assert.match(line, /about \$84\.00 and 2\.0M tokens under what claude-opus-4 would have cost/, line);
  assert.match(line, /No call in this chat is tagged as routed work, so Cheaper claims no credit for it\./, line);
  // The whole-session sentence is unaffected by attribution.
  assert.match(line, / This session ran 4\.0M tokens, worth 🔴 about \$96\.00 at list API rates\.$/, line);
});

test('P2.4: an ATTRIBUTED chat keeps the credit, word for word', () => {
  const r = realizedFromRecords([
    { model: 'claude-opus-4', source: 'user', inTokens: 1e6, inFresh: 1e6, outTokens: 1e6 },
    { model: 'claude-haiku-4-5', source: 'subagent', inTokens: 1e6, inFresh: 1e6, outTokens: 1e6 },
  ]);
  assert.match(buildTagline(r),
    /^Cheaper\.app saved 🟢 about \$84\.00 and 2\.0M tokens by running 1 call on claude-haiku-4-5 instead of claude-opus-4, at list API rates\./,
    buildTagline(r));
});

test('P2.4: buildTagline FAILS CLOSED on a shape that never established attribution', () => {
  // An unestablished cause must not render as an established one. Both producers in the
  // module set the field, so an absent one can only come from a shape nobody vouched for.
  const bare = { ceilingModel: 'claude-opus-4', topModel: 'claude-opus-4', dollarsSaved: 5,
    tokensCredited: 1e6, creditedCalls: 1, savedByModel: { 'claude-sonnet-4-5': 1 },
    extraByModel: {}, extraCost: 0, totalSpent: 10, totalTokens: 2e6, exact: false };
  assert.ok(!/Cheaper\.app saved/.test(buildTagline(bare)), buildTagline(bare));
  assert.ok(/claims no credit/.test(buildTagline(bare)), buildTagline(bare));
  // Explicit true is the only thing that unlocks the credit — not a truthy string, not 1.
  assert.match(buildTagline(Object.assign({}, bare, { routingAttributed: true })),
    /^Cheaper\.app saved 🟢 about \$5\.00 /);
  assert.ok(!/Cheaper\.app saved/.test(buildTagline(Object.assign({}, bare, { routingAttributed: 'yes' }))));
});

test('P2.4: the anti-saving line does not BLAME Cheaper for an unattributed mix either', () => {
  // The mirror image. Wrong in the user's favour is still wrong, and the missing evidence
  // is identical.
  const loss = { ceilingModel: 'claude-haiku-4-5', topModel: 'claude-opus-4', dollarsSaved: -84,
    tokensCredited: 2e6, creditedCalls: 0, offsetCalls: 1, savedByModel: {},
    extraByModel: { 'claude-opus-4': 1 }, extraCost: 84, totalSpent: 96, totalTokens: 4e6, exact: false };
  assert.match(buildTagline(loss),
    /^Cheaper\.app claims no saving on this chat — the models this chat used cost \$84\.00 more than claude-haiku-4-5 would have\./,
    buildTagline(loss));
  assert.match(buildTagline(Object.assign({}, loss, { routingAttributed: true })),
    /^Cheaper\.app claims no saving on this chat — routed work cost \$84\.00 more than claude-haiku-4-5 would have\./);
});

test('P2.4 end-to-end: a real un-sidechained chat prints no credit; a sidechained one does', async () => {
  // Both arms take the TRANSCRIPT path (gateway: null) so the ONLY difference between them
  // is the isSidechain flag on the cheap call — the evidence, not the source.
  const bare = await runTagline({ sidechain: false, gateway: null });
  assert.equal(bare.json.result.routingAttributed, false, 'no sidechain → no attribution');
  assert.ok(!/Cheaper\.app saved/.test(bare.json.line), 'credit leaked into the real line: ' + bare.json.line);
  assert.match(bare.json.line, /claims no credit for it\./, bare.json.line);
  assert.match(bare.json.line, /about \$84\.00 and 2\.0M tokens/, 'the figure survives: ' + bare.json.line);

  const routed = await runTagline({ sidechain: true, gateway: null });
  assert.equal(routed.json.result.routingAttributed, true);
  assert.match(routed.json.line, /^Cheaper\.app saved 🟢 about \$84\.00 and 2\.0M tokens by running 1 call on claude-haiku-4-5 instead of claude-opus-4/,
    routed.json.line);
});

// A gateway measurement is attributed by construction, so the SAME un-sidechained chat is
// credited when the gateway watched it — the flag tracks evidence, not the transcript.
test('P2.4: a gateway-measured un-sidechained chat IS credited — the gateway is the evidence', async () => {
  const r = await runTagline({ sidechain: false, gateway: 'ok' });
  assert.equal(r.json.source, 'gateway');
  assert.equal(r.json.result.routingAttributed, true);
  assert.match(r.json.line, /^Cheaper\.app saved 🟢 \$2\.00 and 500\.0K tokens by running 1 call on claude-haiku-4-5 instead of claude-opus-5/,
    r.json.line);
});

// The sandbox HOME this file installed at load time, and anything the resolver wrote under it.
test.after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });
