'use strict';
// Shared fixtures for the Playwright suite.
//
// The most important thing here is `pageErrors`: EVERY test fails if the page logged a
// console error, threw, or issued a request that failed. That turns "look at the
// screenshot for problems" into something mechanical, which is the only way it stays
// true after the tenth change.

const fs = require('fs');
const path = require('path');
const base = require('@playwright/test');

const SANDBOX = path.resolve(__dirname, '..', '..', '.playwright-tmp');

function seedInfo() {
  return JSON.parse(fs.readFileSync(path.join(SANDBOX, 'seed.json'), 'utf8'));
}

// Console noise that is genuinely not a defect. Kept deliberately SHORT and specific —
// a broad allowlist here would silently re-enable every error this fixture exists to
// catch, which is the "suppress the warning instead of fixing it" failure mode.
const IGNORABLE = [
  /favicon\.ico/i,            // no favicon is served; not a product defect
];

const test = base.test.extend({
  // The same-machine token the gateway is enforcing, read from the sandbox.
  token: async ({}, use) => { await use(seedInfo().token); },
  seed: async ({}, use) => { await use(seedInfo()); },

  // Collects everything that went wrong in the page, for assertion at the end.
  pageErrors: async ({ page }, use) => {
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error' && msg.type() !== 'warning') return;
      const text = msg.text();
      if (IGNORABLE.some((re) => re.test(text))) return;
      errors.push(`console.${msg.type()}: ${text}`);
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('requestfailed', (req) => {
      const url = req.url();
      if (IGNORABLE.some((re) => re.test(url))) return;
      errors.push(`requestfailed: ${req.method()} ${url} — ${(req.failure() || {}).errorText}`);
    });
    page.on('response', (res) => {
      const url = res.url();
      if (IGNORABLE.some((re) => re.test(url))) return;
      // A 401 is EXPECTED in the auth tests, which opt out by clearing the list.
      if (res.status() >= 400) errors.push(`HTTP ${res.status()}: ${url}`);
    });
    await use(errors);
  },

  // A page already authenticated and settled on a tab, with the live-status
  // indicator resolved so screenshots are not raced.
  dash: async ({ page, token, pageErrors }, use) => {
    const open = async (tab) => {
      await page.goto(`/dashboard?token=${token}` + (tab ? `#${tab}` : ''));
      await page.waitForLoadState('networkidle');
      // The auth wall must never appear on an authenticated load.
      await base.expect(page.locator('#authWall')).toBeHidden();
      return page;
    };
    await use({ page, open, errors: pageErrors });
  },
});

// Assert nothing went wrong in the page. Call at the end of every test that renders.
function expectClean(errors, note) {
  if (errors.length) {
    throw new Error(`${note || 'page reported errors'}:\n  - ` + errors.join('\n  - '));
  }
}

module.exports = { test, expect: base.expect, seedInfo, SANDBOX, expectClean };
