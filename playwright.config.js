'use strict';
// Playwright is this repo's ONLY end-to-end runner (Cypress is component-only and is
// not used here at all — this project is a CLI plus a Python gateway).
//
// The suite drives the REAL gateway process against a seeded, fully isolated sandbox:
// nothing reads or writes the developer's own ~/.cheaper, and the tree is rebuilt on
// every run so a screenshot can never pass because yesterday's data happened to match.

const path = require('path');
const { defineConfig, devices } = require('@playwright/test');
const { seed, readSeedInfo } = require('./tests/e2e/seed');

// Seed at CONFIG LOAD time, not in globalSetup: `webServer.env` is read when the config
// is evaluated, so the gateway has to know its sandbox paths by then.
//
// ONCE, though. Playwright re-evaluates this config in every worker process, and the
// seeder starts by wiping the sandbox — so an unguarded call deletes the store out from
// under the running gateway partway through the run, and takes the captured screenshots
// with it. The guard is an env var: workers are forked from this process and inherit it.
//
// That env var protects one process TREE and nothing more. Cross-invocation safety — a
// second `npx playwright test` (or a bare `--list`, which also loads this config) while
// a run is live — is the run lock's job, in tests/e2e/seed.js: the sandbox is namespaced
// per checkout, and a second invocation against the same checkout aborts loudly instead
// of wiping the live one.
//
// `now` tracks the real clock rather than being frozen, because the ladder has to be
// exercised against genuine "today"/"this week" boundaries; a frozen 2026-01-01 would
// put every fixture row in "Before this year" and test nothing.
//
// seed() writes seed.json itself (mode 0600 — it carries the dashboard token); this file
// never re-derives that path.
const SEEDED_FLAG = 'CHEAPER_E2E_SEEDED';
let SEED;
if (!process.env[SEEDED_FLAG]) {
  SEED = seed({ now: Date.now() });
  process.env[SEEDED_FLAG] = '1';
} else {
  SEED = readSeedInfo();
}

const PORT = Number(process.env.CHEAPER_E2E_PORT || 8799);

// Spec files that PERMANENTLY change the gateway's shared store (they POST a real,
// completing request to /v1/messages, and nothing in the product retracts a recorded
// call). Quarantined into the `mutating` project at the bottom of `projects` — see the
// long note there for what went wrong when they merely sorted last.
const MUTATING_SPECS = /zz-.*\.spec\.js$/;

// A closed-port stand-in used to be enough here because nothing posted to
// /v1/messages. security.spec.js's injection-boundary test now does (it has to, to
// exercise the client-side esc() calls that guard the Logs table for real — see the
// comment on that test) so the gateway needs an upstream that actually answers. See
// tests/e2e/mock-anthropic-upstream.js for what it does and does not emulate.
const MOCK_UPSTREAM_PORT = Number(process.env.MOCK_ANTHROPIC_PORT || 8798);

// The sandbox redirects HOME so nothing can reach the developer's real ~/.cheaper —
// but CPython resolves its USER site-packages from HOME too, so overriding it also
// hides fastapi/uvicorn and the server refuses to start with "No module named uvicorn".
// Resolve the real user-site path with the REAL environment first and pass it back in
// on PYTHONPATH, so module resolution and data isolation stop fighting each other.
function realUserSite() {
  const { execFileSync } = require('child_process');
  for (const exe of ['python3', 'python']) {
    try {
      const out = execFileSync(exe, ['-c',
        'import site,sys;print(site.getusersitepackages());print("\\n".join(sys.path))'],
        { encoding: 'utf8' });
      return out.split('\n').map((s) => s.trim()).filter(Boolean).join(':');
    } catch { /* try the next interpreter */ }
  }
  return '';
}
const PYPATH = realUserSite();

module.exports = defineConfig({
  testDir: './tests/e2e',
  // Nothing in this suite is order-dependent, but the gateway is a single shared
  // process with one SQLite file, so keep writes serialised.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 45000,
  expect: {
    timeout: 10000,
    toHaveScreenshot: {
      // Anti-aliasing and font hinting differ by a pixel or two between runs; a
      // threshold this tight still catches a moved column or a changed colour.
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
    },
  },
  reporter: [['list'], ['html', { outputFolder: '.playwright-report', open: 'never' }]],
  // Test artifacts (traces, failure screenshots) are a human-facing output, unlike the
  // DATA sandbox (auth token + metrics DB), which now lives outside the repo — see
  // tests/e2e/seed.js. This directory stays under the repo, gitignored, next to
  // .playwright-report.
  outputDir: '.playwright-artifacts',

  use: {
    baseURL: `http://localhost:${PORT}`,
    // Full trace + screenshot on failure: a screenshot assertion that fails with no
    // artifact is unactionable.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10000,
    navigationTimeout: 15000,
  },

  // Every spec file that MUTATES the gateway's shared store is quarantined into the
  // `mutating` project at the end of this list, and excluded from all the others.
  //
  // Why a whole project and not just a filename that sorts last: there is ONE gateway
  // process and ONE SQLite file for the entire run, and a `zz-` prefix only guarantees
  // ordering WITHIN a project. Playwright runs the project list in order, each project
  // running the full file list, so a mutating spec in the shared set ran five times and
  // its row survived into every later project — desktop-dark's screenshots were taken
  // against a clean store and passed, while desktop-light, tablet, mobile and a11y each
  // saw one more permanent Logs row than the project before them (#logs and #monitor
  // failed their pixel diffs in exactly those four, and nowhere else — that asymmetry is
  // the fingerprint of this bug). Baselines regenerated under those conditions would
  // encode "the fourth project sees three extra rows", which is stable only for a full
  // five-project run in this exact order and wrong for `--project=tablet` on its own.
  //
  // Quarantined, the mutation happens exactly once, after every screenshot in every
  // project has been captured, and `--project=mutating` still runs it standalone.
  // A new mutating spec goes in this list and in MUTATING_SPECS below — NOT into the
  // shared set with a clever filename.
  projects: [
    { name: 'desktop-dark',
      testIgnore: MUTATING_SPECS,
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark',
             viewport: { width: 1440, height: 900 } } },
    { name: 'desktop-light',
      testIgnore: MUTATING_SPECS,
      use: { ...devices['Desktop Chrome'], colorScheme: 'light',
             viewport: { width: 1440, height: 900 } } },
    // Mobile/tablet run Chromium's device emulation rather than WebKit. That is a
    // deliberate match to how this page is actually reached: `cheaper dashboard` opens
    // it in the default browser on a desktop, and the desktop app loads it inside
    // Electron — which is Chromium. The emulation still gives real touch input, the
    // real viewport and the real DPR, which is what the responsive assertions need.
    { name: 'tablet',
      testIgnore: MUTATING_SPECS,
      use: { ...devices['iPad (gen 7)'], browserName: 'chromium', colorScheme: 'dark' } },
    { name: 'mobile',
      testIgnore: MUTATING_SPECS,
      use: { ...devices['iPhone 13'], browserName: 'chromium', colorScheme: 'dark' } },
    // Reduced motion + forced colors: an accessibility surface the visual projects
    // cannot cover, and the place where a decorative-only status cue breaks.
    { name: 'a11y',
      testIgnore: MUTATING_SPECS,
      use: { ...devices['Desktop Chrome'], colorScheme: 'light',
             reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } } },
    // LAST, and the only project that runs the mutating specs — see the note above the
    // project list. One browser configuration is enough: these tests assert on stored
    // data and escaping, not on layout, so running them per-viewport would buy nothing
    // and would multiply the permanent rows they write by five again.
    { name: 'mutating',
      testMatch: MUTATING_SPECS,
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark',
             viewport: { width: 1440, height: 900 } } },
  ],

  // Two servers: the mock Anthropic upstream (tests/e2e/mock-anthropic-upstream.js),
  // then the real gateway pointed at it. Playwright starts webServer array entries
  // concurrently and waits on EACH entry's own readiness check before running any test,
  // so the gateway does not need the mock to be up first — it only needs the mock's
  // host:port to be reachable by the time a test actually calls POST /v1/messages,
  // which is well after both pass their checks.
  webServer: [
    {
      name: 'mock-anthropic-upstream',
      command: `node ${path.join(__dirname, 'tests', 'e2e', 'mock-anthropic-upstream.js')}`,
      port: MOCK_UPSTREAM_PORT,
      reuseExistingServer: false,
      timeout: 15000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, MOCK_ANTHROPIC_PORT: String(MOCK_UPSTREAM_PORT) },
    },
    {
      name: 'gateway',
      // The real uvicorn process, not a mock. `--app-dir` mirrors cli/src/gateway.js.
      command: `python3 -m uvicorn --app-dir ${path.join(__dirname, 'cli', 'assets', 'gateway', 'app')} app:app --host 127.0.0.1 --port ${PORT}`,
      url: `http://localhost:${PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        CHEAPER_DB: SEED.db,
        CHEAPER_TOKEN_FILE: path.join(SEED.home, '.cheaper', 'dash.token'),
        CHEAPER_EVENTS_DIR: SEED.eventsDir,
        CHEAPER_LEGACY_FILE: path.join(SEED.home, '.cheaper', 'legacy_chats.json'),
        CHEAPER_PEEK_HOME: SEED.home,
        // HOME is redirected so `~/.cheaper/peek.json` and the perms sweep touch the
        // sandbox, never the developer's real usage record.
        HOME: SEED.home,
        PYTHONPATH: [PYPATH, process.env.PYTHONPATH].filter(Boolean).join(':'),
        // Points at the mock upstream webServer above, not the real Anthropic API and
        // not a closed port. security.spec.js's injection-boundary test needs a POST to
        // /v1/messages to actually complete — against a closed port, the gateway's
        // on_complete() callback in app.py::_forward() never fires, no Logs row is ever
        // written, and the test's assertions pass over an empty table no matter what
        // the dashboard's escaping code does. See tests/e2e/mock-anthropic-upstream.js.
        ANTHROPIC_UPSTREAM_URL: `http://127.0.0.1:${MOCK_UPSTREAM_PORT}`,
        PYTHONDONTWRITEBYTECODE: '1',
      },
    },
  ],
});
