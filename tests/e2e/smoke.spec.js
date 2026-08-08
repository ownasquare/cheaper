'use strict';
// SMOKE — does every surface load, render real content, and log nothing?
//
// The `pageErrors` fixture fails these on any console error, page exception, failed
// request, or 4xx/5xx response. That is what makes "check the page for problems"
// mechanical instead of a promise.

const { test, expect, expectClean } = require('./fixtures');

const TABS = ['dashboard', 'reports', 'logs', 'monitor'];

test.describe('smoke', () => {
  test('healthz answers before anything else', async ({ request }) => {
    const j = await (await request.get('/healthz')).json();
    expect(j.ok).toBe(true);
    expect(j.code_sha).toMatch(/^[0-9a-f]{16}$/);
  });

  for (const tab of TABS) {
    test(`#${tab} renders with no console error, no failed request, no 4xx`,
      async ({ dash, pageErrors }) => {
        const page = await dash.open(tab);
        // The tab really is the active one — a hash router that silently falls back to
        // Dashboard would make every other assertion here vacuous.
        await expect(page.locator(`#tabNav a[data-tab="${tab}"]`)).toHaveClass(/active/);
        await expect(page.locator(`#tab-${tab}`)).toHaveClass(/active/);
        await expect(page.locator(`#tab-${tab}`)).toBeVisible();
        expectClean(pageErrors, `#${tab} logged problems`);
      });
  }

  test('the Dashboard tab shows real numbers, not placeholders', async ({ dash }) => {
    const page = await dash.open('dashboard');
    await expect(page.locator('#statCards .card').first()).toBeVisible();
    const text = await page.locator('#statCards').innerText();
    expect(text).not.toMatch(/NaN|undefined|null/);
    expect(text.length).toBeGreaterThan(10);
  });

  test('the live status indicator reaches a settled state', async ({ dash }) => {
    const page = await dash.open('dashboard');
    // "connecting…" forever is a real failure that a screenshot alone would not flag.
    //
    // The settled set is now THREE states, not two. "live" is a claim about the DATA — a
    // row arrived inside the liveness window — and /ws re-pushes the whole summary every
    // five seconds whether or not a call was routed, so a connected-but-idle gateway is
    // indistinguishable from a live one at the transport layer. It says "connected — …"
    // instead, which is the state this suite's own fixture is in: the newest seeded row
    // is minutes old by the time a test runs, so asserting "live" here would be asserting
    // the defect. Each of the three is pinned individually in liveness.spec.js.
    await expect(page.locator('#statusText'))
      .toHaveText(/^(live|reconnecting…|connected — .+)$/, { timeout: 15000 });
  });

  test('no rendered text anywhere contains NaN, undefined or [object Object]',
    async ({ dash }) => {
      for (const tab of TABS) {
        const page = await dash.open(tab);
        const body = await page.locator('main').innerText();
        for (const bad of ['NaN', 'undefined', '[object Object]', 'Infinity']) {
          expect(body, `#${tab} rendered "${bad}"`).not.toContain(bad);
        }
      }
    });

  test('every internal link resolves (no dead nav)', async ({ dash, request, token }) => {
    const page = await dash.open('dashboard');
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
    for (const href of hrefs) {
      if (!href || !href.startsWith('/')) continue;
      const url = href.includes('token=') ? href : href + (href.includes('?') ? '&' : '?') + 'token=' + token;
      const r = await request.get(url);
      expect(r.status(), `dead internal link: ${href}`).toBeLessThan(400);
    }
  });
});
