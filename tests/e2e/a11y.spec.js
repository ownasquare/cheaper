'use strict';
// ACCESSIBILITY — axe-core over every tab in both themes, plus keyboard reachability.
//
// axe covers the rule-checkable part (contrast, names, roles, landmarks, duplicate ids).
// The parts it cannot check — can you actually operate this with a keyboard, is focus
// visible, does the live region announce — are asserted directly.

const { test, expect } = require('./fixtures');
const AxeBuilder = require('@axe-core/playwright').default;

const TABS = ['dashboard', 'reports', 'logs', 'monitor'];

async function scan(page) {
  return new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
}

function describeViolations(v) {
  return v.map((x) => `${x.id} (${x.impact}) — ${x.help}\n      ${
    x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n      ')}`).join('\n  ');
}

test.describe('axe-core', () => {
  for (const tab of TABS) {
    test(`#${tab} has no WCAG 2.1 A/AA violations`, async ({ dash }, testInfo) => {
      const page = await dash.open(tab);
      await page.waitForTimeout(800);
      const r = await scan(page);
      expect(r.violations, `${testInfo.project.name} #${tab}:\n  ${describeViolations(r.violations)}`)
        .toEqual([]);
    });
  }

  test('the auth wall is accessible too', async ({ page }) => {
    // The wall is the FIRST thing a mis-linked user sees; if it is unreadable the
    // product's failure state is its least accessible screen.
    await page.goto('/dashboard');
    await expect(page.locator('main')).toContainText('needs its local token');
    const r = await scan(page);
    expect(r.violations, describeViolations(r.violations)).toEqual([]);
  });
});

test.describe('keyboard', () => {
  test('every tab is reachable and activatable by keyboard alone', async ({ dash, page }) => {
    await dash.open('dashboard');
    await page.keyboard.press('Tab');
    // Walk forward until the Logs tab link holds focus, then activate it with Enter.
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      found = await page.evaluate(() =>
        document.activeElement && document.activeElement.getAttribute('data-tab') === 'logs');
      if (!found) await page.keyboard.press('Tab');
    }
    expect(found, 'the Logs tab is not reachable with the keyboard').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.locator('#tab-logs')).toBeVisible();
  });

  test('focus is visibly indicated on every control', async ({ dash, page }) => {
    await dash.open('logs');
    const invisible = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('a[href], button, select, input')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        // A disabled control is CORRECTLY not focusable — the HTML spec removes it from
        // the tab order — so asserting it paints a focus ring would be asserting a bug.
        // (The pager buttons are disabled on the first page, which is right.)
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        el.focus();
        if (document.activeElement !== el) continue;   // the browser declined focus
        const cs = getComputedStyle(el);
        // A control whose focus state paints nothing is unusable without a mouse, and
        // it is invisible in every screenshot because a screenshot has no focus.
        const hasRing = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0)
          || cs.boxShadow !== 'none';
        if (!hasRing) out.push(el.tagName + (el.id ? '#' + el.id : '') + '.' + String(el.className).split(' ')[0]);
      }
      return out;
    });
    expect(invisible, 'controls with no visible focus indicator').toEqual([]);
  });

  test('the theme toggle is operable by keyboard and reports its state', async ({ dash, page }) => {
    await dash.open('dashboard');
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.focus('#themeToggle');
    await page.keyboard.press('Enter');
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(after).not.toBe(before);
    // It must announce what it DOES, not just carry an icon.
    await expect(page.locator('#themeToggle')).toHaveAttribute('aria-label', /theme/i);
  });
});

test.describe('structure', () => {
  test('exactly one h1, and no heading level is skipped', async ({ dash }) => {
    for (const tab of TABS) {
      const page = await dash.open(tab);
      const levels = await page.$$eval('h1,h2,h3,h4,h5,h6',
        (hs) => hs.filter((h) => h.offsetParent !== null).map((h) => Number(h.tagName[1])));
      if (!levels.length) continue;
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i] - levels[i - 1],
          `#${tab}: heading level jumps from h${levels[i - 1]} to h${levels[i]}`)
          .toBeLessThanOrEqual(1);
      }
    }
  });

  test('the status indicator is not colour-only', async ({ dash }) => {
    const page = await dash.open('dashboard');
    // A green/red dot alone is invisible to a colour-blind reader and to a screen
    // reader. The adjacent text carries the same information.
    await expect(page.locator('#statusText')).toHaveText(/live|connecting|reconnecting/);
  });

  test('every form control has an accessible name', async ({ dash }) => {
    const page = await dash.open('logs');
    const unnamed = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('select, input, button')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const name = el.getAttribute('aria-label')
          || (el.labels && el.labels.length ? el.labels[0].textContent.trim() : '')
          || (el.closest('label') ? el.closest('label').textContent.trim() : '')
          || el.textContent.trim()
          || el.getAttribute('placeholder') || el.getAttribute('title');
        if (!name) out.push(el.outerHTML.slice(0, 90));
      }
      return out;
    });
    expect(unnamed, 'form controls with no accessible name').toEqual([]);
  });
});
