'use strict';
// Capture-only spec: writes full-page PNGs to `.playwright-shots/` for HUMAN review.
//
// Deliberately separate from visual.spec.js, which ASSERTS. This one only records, so a
// reviewer (or an agent) can open the images and look for the things no assertion
// catches: a heading that reads wrong, a column that is technically aligned but visually
// crowded, a colour that is legible but ugly, an empty state that is honest but unhelpful.
//
// Run with:  npx playwright test tests/e2e/capture.spec.js --project=<name>

const fs = require('fs');
const path = require('path');
const { test } = require('./fixtures');

// Deliberately outside the data sandbox (an OS-temp-dir path the seeder wipes on every
// config evaluation — see tests/e2e/seed.js): captures written there would vanish before
// a human got to look at them. This directory is a human-facing artifact, so it stays
// under the repo (gitignored), same as the HTML report.
const OUT = path.resolve(__dirname, '..', '..', '.playwright-shots');
const TABS = ['dashboard', 'reports', 'logs', 'monitor'];

test.describe('capture', () => {
  test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });

  for (const tab of TABS) {
    test(`capture #${tab}`, async ({ dash, page }, testInfo) => {
      await dash.open(tab);
      await page.waitForTimeout(1500);
      await page.screenshot({
        path: path.join(OUT, `${testInfo.project.name}-${tab}.png`),
        fullPage: true,
      });
    });
  }

  test('capture the auth wall', async ({ page }, testInfo) => {
    await page.goto('/dashboard');
    await page.waitForTimeout(600);
    await page.screenshot({
      path: path.join(OUT, `${testInfo.project.name}-authwall.png`), fullPage: true });
  });

  test('capture print preview', async ({ dash, page }, testInfo) => {
    await dash.open('reports');
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(600);
    await page.screenshot({
      path: path.join(OUT, `${testInfo.project.name}-print.png`), fullPage: true });
    await page.emulateMedia({ media: 'screen' });
  });

  test('capture the empty-filter state', async ({ dash, page }, testInfo) => {
    await dash.open('logs');
    await page.fill('#fFrom', '2019-01-01');
    await page.fill('#fTo', '2019-01-02');
    await page.click('#fApply');
    await page.waitForTimeout(900);
    await page.screenshot({
      path: path.join(OUT, `${testInfo.project.name}-logs-empty.png`), fullPage: true });
  });
});
