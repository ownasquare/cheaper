'use strict';
// PERFORMANCE — budgets, not vibes.
//
// The dashboard is a local, zero-dependency page reading a local store, so the budgets
// are deliberately tight: anything slower than these numbers means something is being
// re-scanned, re-parsed or re-rendered that should not be.

const { test, expect } = require('./fixtures');

const BUDGET = {
  domContentLoaded: 1500,   // ms — no bundler, no framework, one inline script
  load: 3000,
  api: 1200,                // a partitioned read answers period queries in ~10 ms
  tabSwitch: 1200,
  transferKB: 400,          // the whole page, uncompressed
};

test.describe('page load', () => {
  test('the dashboard meets its load budget', async ({ dash, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-dark', 'measure once, on one profile');
    await dash.open('dashboard');
    const t = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      return { dcl: n.domContentLoadedEventEnd - n.startTime,
               load: n.loadEventEnd - n.startTime,
               transfer: n.transferSize || 0 };
    });
    expect(t.dcl, 'DOMContentLoaded').toBeLessThan(BUDGET.domContentLoaded);
    expect(t.load, 'load').toBeLessThan(BUDGET.load);
  });

  test('the served page stays small enough to have no dependencies', async ({ request, token }) => {
    const r = await request.get(`/dashboard?token=${token}`);
    const bytes = (await r.body()).length;
    // `dependencies: {}` is a deliberate property of this product. A page that grew
    // past this budget would mean a library got vendored in.
    expect(bytes / 1024, 'dashboard.html size in KB').toBeLessThan(BUDGET.transferKB);
  });

  test('there are no layout shifts after first paint', async ({ dash, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-dark', 'measure once, on one profile');
    await dash.open('dashboard');
    const cls = await page.evaluate(() => new Promise((res) => {
      let total = 0;
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) total += e.value;
      });
      po.observe({ type: 'layout-shift', buffered: true });
      setTimeout(() => { po.disconnect(); res(total); }, 2500);
    }));
    // The live feed replaces table bodies on every tick; a CLS above 0.1 means the
    // panels are resizing under the reader's cursor.
    expect(cls, 'cumulative layout shift').toBeLessThan(0.1);
  });
});

test.describe('API budgets', () => {
  const ENDPOINTS = ['/metrics', '/api/v1/logs?limit=100', '/api/v1/reports/periods',
                     '/api/v1/reports/breakdown?dim=served', '/api/v1/reports/trend?bucket=day'];
  for (const ep of ENDPOINTS) {
    test(`${ep} answers within budget`, async ({ request, token }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-dark', 'measure once, on one profile');
      // Warm once: the first hit pays for module import and the SQLite open.
      await request.get(ep, { headers: { 'x-cheaper-token': token } });
      const t0 = Date.now();
      const r = await request.get(ep, { headers: { 'x-cheaper-token': token } });
      const ms = Date.now() - t0;
      expect(r.status()).toBe(200);
      expect(ms, `${ep} took ${ms}ms`).toBeLessThan(BUDGET.api);
    });
  }

  test('switching tabs stays responsive', async ({ dash, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-dark', 'measure once, on one profile');
    await dash.open('dashboard');
    for (const tab of ['reports', 'logs', 'monitor']) {
      const t0 = Date.now();
      await page.click(`#tabNav a[data-tab="${tab}"]`);
      await expect(page.locator(`#tab-${tab}`)).toBeVisible();
      expect(Date.now() - t0, `switching to #${tab}`).toBeLessThan(BUDGET.tabSwitch);
    }
  });

  test('a hidden tab does not poll', async ({ dash, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-dark', 'measure once, on one profile');
    const p = await dash.open('dashboard');
    const seen = [];
    p.on('request', (r) => { if (r.url().includes('/logs')) seen.push(r.url()); });
    await p.waitForTimeout(4000);
    // refreshMonitor() early-returns for a hidden tab; without that the Monitor's
    // 500-row fetch would run every ws tick on every page, forever.
    expect(seen.length, 'the Monitor polled while it was not on screen').toBe(0);
  });
});
