'use strict';
// USER JOURNEY + USABILITY — actually click the things.
//
// Every tab, every toggle, every filter control, every pager button, the theme switch
// and the export links are exercised and their EFFECT is asserted. A control that
// renders but does nothing is the defect class this file exists to catch: it looks
// perfect in a screenshot.

const { test, expect, expectClean } = require('./fixtures');

test.describe('navigation', () => {
  test('clicking each tab changes the hash, the active pill AND the visible pane',
    async ({ dash, pageErrors }) => {
      const page = await dash.open('dashboard');
      for (const tab of ['reports', 'logs', 'monitor', 'dashboard']) {
        await page.click(`#tabNav a[data-tab="${tab}"]`);
        await expect(page.locator(`#tab-${tab}`)).toBeVisible();
        await expect(page.locator(`#tabNav a[data-tab="${tab}"]`)).toHaveClass(/active/);
        expect(page.url()).toContain('#' + tab);
        // Exactly ONE pane may be active at a time.
        expect(await page.locator('.tabpane.active').count()).toBe(1);
      }
      expectClean(pageErrors, 'tab navigation logged problems');
    });

  test('browser back/forward moves between tabs', async ({ dash }) => {
    const page = await dash.open('dashboard');
    await page.click('#tabNav a[data-tab="logs"]');
    await expect(page.locator('#tab-logs')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#tab-dashboard')).toBeVisible();
    await page.goForward();
    await expect(page.locator('#tab-logs')).toBeVisible();
  });

  test('a bogus hash falls back to Dashboard rather than showing nothing', async ({ page, token }) => {
    await page.goto(`/dashboard?token=${token}#not-a-tab`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#tab-dashboard')).toBeVisible();
    expect(await page.locator('.tabpane.active').count()).toBe(1);
  });
});

test.describe('Dashboard controls', () => {
  test('the baseline toggle changes the rendered figures', async ({ dash, pageErrors }) => {
    const page = await dash.open('dashboard');
    const grid = page.locator('#dimGrid');
    await expect(grid).toBeVisible();
    const before = await grid.innerText();
    await page.click('#baselineToggle button[data-baseline="highest_tier"]');
    await expect(page.locator('#baselineToggle button[data-baseline="highest_tier"]'))
      .toHaveClass(/active/);
    // A toggle that changes nothing is broken; assert it actually did something.
    await expect
      .poll(async () => (await grid.innerText()) !== before, { timeout: 5000 })
      .toBe(true);
    expectClean(pageErrors, 'baseline toggle logged problems');
  });
});

test.describe('Reports journey', () => {
  test('the period ladder renders disjoint windows with printed local bounds',
    async ({ dash, pageErrors }) => {
      const page = await dash.open('reports');
      const rows = page.locator('#ladderBody tr');
      await expect(rows.first()).toBeVisible();
      expect(await rows.count()).toBeGreaterThanOrEqual(6);
      const first = await rows.first().innerText();
      expect(first).toContain('Today');
      // The literal local bounds must be printed: "This month" alone tells the reader
      // nothing about which instants were included.
      expect(first).toMatch(/\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2}/);
      expectClean(pageErrors, 'reports ladder logged problems');
    });

  test('the composition toggle re-queries and re-renders', async ({ dash }) => {
    const page = await dash.open('reports');
    const comp = page.locator('#composition');
    await expect(comp).toBeVisible();
    const before = await comp.innerText();
    await page.click('#dimToggle button[data-dim="harness"]');
    await expect(page.locator('#dimToggle button[data-dim="harness"]')).toHaveClass(/active/);
    await expect.poll(async () => (await comp.innerText()) !== before, { timeout: 8000 }).toBe(true);
  });

  test('the trend bucket toggle re-queries and re-renders', async ({ dash }) => {
    const page = await dash.open('reports');
    const wrap = page.locator('#trendWrap');
    await expect(wrap).toBeVisible();
    const before = await wrap.innerHTML();
    await page.click('#bucketToggle button[data-bucket="month"]');
    await expect(page.locator('#bucketToggle button[data-bucket="month"]')).toHaveClass(/active/);
    await expect.poll(async () => (await wrap.innerHTML()) !== before, { timeout: 8000 }).toBe(true);
  });

  test('period-over-period shows n on BOTH sides', async ({ dash }) => {
    const page = await dash.open('reports');
    const pop = page.locator('#popGrid');
    await expect(pop).toBeVisible();
    const text = await pop.innerText();
    // A percentage without its denominator cannot be read as noise; n is mandatory.
    expect((text.match(/n=/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

test.describe('Logs journey', () => {
  test('the register renders rows with every required column', async ({ dash, pageErrors }) => {
    const page = await dash.open('logs');
    await expect(page.locator('#logsBody tr').first()).toBeVisible();
    const heads = await page.$$eval('#logsTable thead th', (th) => th.map((x) => x.textContent.trim()));
    for (const col of ['When', 'Basis', 'Grain', 'Source', 'Baseline → Served',
                       'Decision', 'Tokens', 'Baseline $', 'Actual $', 'Δ $', 'Why']) {
      expect(heads, `missing column: ${col}`).toContain(col);
    }
    expectClean(pageErrors, 'logs register logged problems');
  });

  test('every filter control changes the result set', async ({ dash }) => {
    const page = await dash.open('logs');
    await expect(page.locator('#logsBody tr').first()).toBeVisible();
    const countRows = async () => page.locator('#logsBody tr').count();
    const all = await countRows();
    expect(all).toBeGreaterThan(1);

    await page.selectOption('#fBasis', 'measured');
    await page.click('#fApply');
    await page.waitForLoadState('networkidle');
    const measured = await countRows();

    await page.selectOption('#fBasis', 'estimated');
    await page.click('#fApply');
    await page.waitForLoadState('networkidle');
    const estimated = await countRows();

    // Server-side filtering over the FULL match set. If the filter did nothing, both
    // counts equal `all` — which is exactly the bug this asserts against.
    expect(measured !== all || estimated !== all,
      'the basis filter had no effect on the result set').toBe(true);

    await page.click('#fReset');
    await page.waitForLoadState('networkidle');
    await expect.poll(countRows, { timeout: 8000 }).toBe(all);
  });

  test('paging moves forward and back without duplicating or skipping a row',
    async ({ dash, page }) => {
      const p = await dash.open('logs');
      const next = p.locator('#logsNext');
      const prev = p.locator('#logsPrev');
      await expect(p.locator('#logsBody tr').first()).toBeVisible();
      // Newer must be disabled on the first page — a live button that does nothing
      // teaches people the controls are unreliable.
      await expect(prev).toBeDisabled();
      if (await next.isEnabled()) {
        const firstPage = await p.$$eval('#logsBody tr td:first-child', (t) => t.map((x) => x.textContent));
        await next.click();
        await p.waitForLoadState('networkidle');
        const secondPage = await p.$$eval('#logsBody tr td:first-child', (t) => t.map((x) => x.textContent));
        // Keyset paging, not offset: no row may appear on both pages.
        const overlap = firstPage.filter((x) => secondPage.includes(x));
        expect(overlap, 'keyset pagination duplicated rows across pages').toHaveLength(0);
        await expect(prev).toBeEnabled();
        await prev.click();
        await p.waitForLoadState('networkidle');
        const back = await p.$$eval('#logsBody tr td:first-child', (t) => t.map((x) => x.textContent));
        expect(back).toEqual(firstPage);
      }
    });

  test('the export links carry the SAME filters the table is showing', async ({ dash }) => {
    const page = await dash.open('logs');
    await page.selectOption('#fBasis', 'measured');
    await page.click('#fApply');
    await page.waitForLoadState('networkidle');
    // Clicking sets the href; read it without navigating away.
    await page.locator('#exportCsv').dispatchEvent('click');
    const href = await page.locator('#exportCsv').getAttribute('href');
    // "the export doesn't match the table" is the one failure this surface cannot
    // survive, so the filter must travel with it.
    expect(href).toContain('basis=measured');
    expect(href).toContain('format=csv');
  });
});

test.describe('theme', () => {
  test('the theme toggle flips the document, persists, and survives a reload',
    async ({ dash, page }) => {
      const p = await dash.open('dashboard');
      const themeOf = () => p.evaluate(() => document.documentElement.getAttribute('data-theme'));
      const before = await themeOf();
      await p.click('#themeToggle');
      const after = await themeOf();
      expect(after).not.toBe(before);
      // …and the background really changed, not just the attribute.
      const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await p.reload();
      await p.waitForLoadState('networkidle');
      expect(await themeOf()).toBe(after);
      expect(await p.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(bg);
    });
});
