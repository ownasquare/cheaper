'use strict';
// Playwright is this repo's ONLY end-to-end runner (Cypress is component-only and is
// not used here at all — this project is a CLI plus a Python gateway).
//
// The suite drives the REAL gateway process against a seeded, fully isolated sandbox:
// nothing reads or writes the developer's own ~/.cheaper, and the tree is rebuilt on
// every run so a screenshot can never pass because yesterday's data happened to match.

const path = require('path');
const fs = require('fs');
const { defineConfig, devices } = require('@playwright/test');
const { seed } = require('./tests/e2e/seed');

// Seed at CONFIG LOAD time, not in globalSetup: `webServer.env` is read when the config
// is evaluated, so the gateway has to know its sandbox paths by then.
//
// ONCE, though. Playwright re-evaluates this config in every worker process, and the
// seeder starts by wiping the sandbox — so an unguarded call deletes the store out from
// under the running gateway partway through the run, and takes the captured screenshots
// with it. The guard is an env var: workers are forked from this process and inherit it.
//
// `now` tracks the real clock rather than being frozen, because the ladder has to be
// exercised against genuine "today"/"this week" boundaries; a frozen 2026-01-01 would
// put every fixture row in "Before this year" and test nothing.
const SEEDED_FLAG = 'CHEAPER_E2E_SEEDED';
let SEED;
if (!process.env[SEEDED_FLAG]) {
  SEED = seed({ now: Date.now() });
  fs.writeFileSync(path.join(SEED.sandbox, 'seed.json'), JSON.stringify(SEED, null, 2));
  process.env[SEEDED_FLAG] = '1';
} else {
  SEED = JSON.parse(fs.readFileSync(
    path.join(require('./tests/e2e/seed').SANDBOX, 'seed.json'), 'utf8'));
}

const PORT = Number(process.env.CHEAPER_E2E_PORT || 8799);

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
  outputDir: '.playwright-tmp/artifacts',

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

  projects: [
    { name: 'desktop-dark',
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark',
             viewport: { width: 1440, height: 900 } } },
    { name: 'desktop-light',
      use: { ...devices['Desktop Chrome'], colorScheme: 'light',
             viewport: { width: 1440, height: 900 } } },
    // Mobile/tablet run Chromium's device emulation rather than WebKit. That is a
    // deliberate match to how this page is actually reached: `cheaper dashboard` opens
    // it in the default browser on a desktop, and the desktop app loads it inside
    // Electron — which is Chromium. The emulation still gives real touch input, the
    // real viewport and the real DPR, which is what the responsive assertions need.
    { name: 'tablet',
      use: { ...devices['iPad (gen 7)'], browserName: 'chromium', colorScheme: 'dark' } },
    { name: 'mobile',
      use: { ...devices['iPhone 13'], browserName: 'chromium', colorScheme: 'dark' } },
    // Reduced motion + forced colors: an accessibility surface the visual projects
    // cannot cover, and the place where a decorative-only status cue breaks.
    { name: 'a11y',
      use: { ...devices['Desktop Chrome'], colorScheme: 'light',
             reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } } },
  ],

  webServer: {
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
      // No upstream is ever reached: no test posts to /v1/messages.
      ANTHROPIC_UPSTREAM_URL: 'http://127.0.0.1:9',
      PYTHONDONTWRITEBYTECODE: '1',
    },
  },
});
