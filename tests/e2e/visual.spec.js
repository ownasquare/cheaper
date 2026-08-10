'use strict';
// VISUAL / RESPONSIVE / DISPLAY-MODE — screenshots, plus the LAYOUT ASSERTIONS a
// screenshot alone cannot make.
//
// A screenshot proves "it looked like this", not "it looked right". So each capture is
// paired with measured checks a human reviewer would otherwise have to eyeball:
// nothing overflows the viewport horizontally, no two elements overlap, no text is
// clipped, contrast holds in both themes, and the tap targets are reachable on a phone.

const { test, expect, expectClean } = require('./fixtures');
const fs = require('fs');
const path = require('path');

const TABS = ['dashboard', 'reports', 'logs', 'monitor'];

// --- Pixel baselines are per-PLATFORM; the rest of this file is not -------------------
//
// Playwright suffixes every snapshot with process.platform, so `dashboard-mobile` on a
// Mac is a different file from `dashboard-mobile` on Linux. Every baseline this
// repository has ever committed is `-darwin`. On Linux there is nothing to compare
// against, and `toHaveScreenshot` responds to a missing baseline by WRITING one and
// FAILING — so on Linux CI all 25 captures failed with "A snapshot doesn't exist …
// writing actual".
//
// That is not a gate catching a regression. It is a gate that cannot run, and it took
// the whole publish path down with it: publish-cli.yml gates `npm publish` on ci.yml,
// which runs this suite, so the CLI could not be released by CI at all. cheaper@0.4.0
// went to npm by hand on 2026-08-08 for exactly this reason.
//
// The fix is NOT to skip these tests off-reference. Each one pairs its capture with
// MEASURED assertions — horizontal overflow, clipped text, collapsed boxes, provenance
// and basis statements — and those are platform-independent, are the checks that
// actually say "it looked RIGHT" rather than "it looked like this", and were already
// running on Linux before the screenshot killed the test. Skipping the test would throw
// away real coverage to fix a file-naming problem.
//
// So only the PIXEL COMPARISON is conditional, and only on whether a baseline exists for
// the platform in hand:
//
//   * on macOS every baseline is present, so every comparison runs exactly as before —
//     this changes nothing on the machine where the baselines are maintained;
//   * on Linux the structural assertions run and are enforced, and the capture is
//     recorded as skipped WITH ITS REASON rather than silently dropped;
//   * commit a `-linux` baseline and it is picked up automatically, with no edit here.
//
// The deletion hole this opens is closed by `baseline inventory` at the bottom of this
// file, which asserts the reference set is complete and fails on EVERY platform. Without
// it, deleting a baseline would quietly downgrade that capture to "skipped" on Linux.
const REFERENCE_PLATFORM = 'darwin';
const SNAPSHOT_DIR = path.join(__dirname, 'visual.spec.js-snapshots');

function baselineFor(name, projectName, platform) {
  return path.join(SNAPSHOT_DIR, `${name}-${projectName}-${platform}.png`);
}

// Compare pixels when this platform has a baseline; otherwise state why not.
async function expectScreenshotWhereBaselined(pageLike, name, opts, testInfo) {
  const file = baselineFor(name, testInfo.project.name, process.platform);
  if (!fs.existsSync(file)) {
    testInfo.annotations.push({
      type: 'skipped-capture',
      description:
        `no ${process.platform} baseline for ${name} (${testInfo.project.name}); pixel ` +
        `baselines are maintained on ${REFERENCE_PLATFORM}. The layout assertions in this ` +
        `test still ran and still hold. To enable it here, commit ` +
        `${path.relative(path.join(__dirname, '..', '..'), file)}.`,
    });
    return;
  }
  await expect(pageLike).toHaveScreenshot(`${name}.png`, opts);
}

// Regions whose pixels legitimately differ between runs and would make a screenshot
// assertion flaky rather than informative:
//   #statusText   flips connecting… -> live / connected — no traffic for N as the
//                 websocket settles, and the "for N" half counts UP against the wall
//                 clock on a 15-second repaint even when nothing else on the page moves
//   .sago         "3h ago" — recomputed against the wall clock on every render
//   #sparkWrap    a live series; its geometry moves with real time
//   #basisLine    the measurement-basis statement. Its WORDING is a function of what the
//                 gateway publishes in `measurement`, which is an additive block landing
//                 separately from this page — so the same seeded store legitimately
//                 produces "Basis unknown…" on one build and "Partly measured. 3 of 4
//                 priced calls…" on the next, with no UI change at all. Masking it drops
//                 the only coverage the product's central honesty claim had, so
//                 expectBasisStated() below asserts its TEXT directly — a stronger check
//                 than the pixels were, exactly as for #provenance.
//                 NOT fixed by masking: a wording change that alters the WRAPPED LINE
//                 COUNT changes the height of everything below it, and a full-page
//                 screenshot compares dimensions first. Expect a one-off re-baseline when
//                 the gateway starts publishing `measurement`; that is a real content
//                 change, not flake.
//   #trendWrap    bucketed on each call's own local DAY, and the fixture is seeded
//                 relative to `now`, so the day labels shift every run
//   #recentBody / #sessions   live feeds carrying wall-clock times
//   #provenance   "catalog dated 2026-08-06 (N days ago)" — N is recomputed against the
//                 wall clock, so this string changes ON ITS OWN with no code change at
//                 all. It cost a real debugging detour: every tablet #dashboard baseline
//                 started failing mid-session with identical 810x1080 dimensions and a
//                 pixel diff confined to the footer, which reads exactly like a UI
//                 regression — the catalog had simply aged from "1 day ago" to "2 days
//                 ago" (the age is derived in UTC, so it ticks over at 17:00 local, not
//                 at local midnight, which is why it landed mid-afternoon).
//                 Masking it drops the only coverage this line had, so the rendering test
//                 now asserts its TEXT directly — a stronger check than the pixels were,
//                 because it survives every re-baseline.
//                 NOT fixed by masking: past dashboard.html's STALE_DAYS threshold this
//                 element grows an extra warning sentence, and a taller footer reflows
//                 the page below it. Expect a one-off re-baseline on that day; it is a
//                 real content change, not flake.
//
// Masked, not loosened: raising maxDiffPixelRatio to swallow these would also swallow a
// real regression anywhere else on the page. Everything outside these boxes is compared
// strictly, and the LAYOUT of the masked regions is still asserted by the overflow,
// clipping and collapsed-box checks above.
function volatileRegions(page) {
  return ['#statusText', '#sparkWrap', '#trendWrap', '#recentBody', '#sessions', '.sago',
          '#provenance', '#basisLine']
    .map((sel) => page.locator(sel));
}

// The provenance line states the BASIS of every dollar on the page. It is masked out of
// the pixel comparison above (its "N days ago" moves on its own), so assert it here or
// the product's central honesty disclaimer would have no test at all.
async function expectProvenanceStated(page, where) {
  const el = page.locator('#provenance');
  await expect(el, `${where}: the pricing-basis line is missing`).toBeVisible();
  const txt = (await el.innerText()).trim();
  // Either the real basis statement, or the explicit "we could not price this" fallback —
  // never a blank line, and never a bare figure with no stated basis.
  if (/Pricing module unavailable/i.test(txt)) {
    expect(txt, `${where}: the unpriced fallback must say the figures are not dollars`)
      .toMatch(/not real dollars/i);
    return;
  }
  expect(txt, `${where}: provenance must name the catalog it priced from`)
    .toMatch(/published list prices from the catalog dated \d{4}-\d{2}-\d{2}/);
  // The limits of the claim, which is the part a reader acts on.
  expect(txt, `${where}: provenance must disclaim negotiated rates`)
    .toMatch(/negotiated discounts, credits and flat-rate plans are not modelled/);
}

// The measurement-basis statement answers "over what TOKEN COUNTS?" — the question
// #provenance's price-catalog line does not. They are independent: a page can apply an
// impeccable price catalog to token counts nobody ever measured, which is exactly the
// state that produced a confident "$80.52 saved / 86.4%" headline out of 94 rows whose
// usage_source was NULL from end to end.
//
// It is masked out of the pixel comparison (its wording moves with the gateway build, not
// with this page), so assert it here or the product's central honesty claim would have no
// test at all. It must be present on EVERY tab and must never be blank: a banner that
// appears only when something is wrong teaches a reader that its absence means nothing.
async function expectBasisStated(page, where) {
  const el = page.locator('#basisLine');
  await expect(el, `${where}: the measurement-basis statement is missing`).toBeVisible();
  const txt = (await el.innerText()).trim();
  expect(txt.length, `${where}: the basis statement rendered blank`).toBeGreaterThan(40);
  // One of the four states the contract can be in, named. Anything else — including
  // silence — is the page failing to say what its dollars rest on.
  expect(txt, `${where}: the basis statement names no basis: "${txt}"`)
    .toMatch(/^(Measured\.|Not measured\.|Partly measured\.|Basis unknown\.|No dollar figure is claimed\.)/);
  // …and when it is NOT "Measured.", the headline figures must carry the qualifier that
  // statement promises. A banner saying "not measured" over an unqualified $80.52 is the
  // original defect with a disclaimer bolted on.
  // The stat cards live inside #tab-dashboard, so this half only runs on the tab that
  // renders them — a hidden pane has no readable text.
  const onDashboard = await page.locator('#tab-dashboard.active').count();
  if (!/^Measured\./.test(txt) && onDashboard) {
    const saved = page.locator('#statCards .card', { hasText: 'Saved' }).first();
    const value = (await saved.locator('.value').innerText()).trim();
    // An ABSENT figure is already a labelled non-number and is not qualified further:
    // "about —" would turn a clean "no claim made" into a half-claim.
    if (!/^—$/.test(value)) {
      expect(value, `${where}: the basis line says "${txt.slice(0, 24)}…" but the Saved `
        + `card reads "${value}" — an unmeasured figure presented as a measured result`)
        .toMatch(/^about /);
    }
  }
}

// A page must never spill sideways. Horizontal overflow is the single most common
// responsive defect and it is invisible in a full-page screenshot.
//
// This USED to be `documentElement.scrollWidth <= window.innerWidth + 1`, and that
// assertion could not fail. dashboard.html sets `html,body{overflow-x:hidden}` (line 27),
// which CLIPS the overflow, and a clipped scroll container reports
// `scrollWidth === clientWidth` by definition — so the number being compared was the
// viewport width measured twice. The per-element `worst` offender below was already
// being computed, purely to decorate a message that could never be printed.
//
// The clipping is exactly what makes it worth asserting: content past the right edge is
// not scrollable-to on a touch device, it is simply GONE, with no scrollbar to hint that
// anything is missing. The tablet `#reports` capture was 821px of content in an 810px
// viewport — 11px silently cut — while this function reported the page clean.
//
// So measure the elements instead of asking the (clipped) scroller. Anything inside a
// container that scrolls ON PURPOSE is exempt: `.table-wrap` and `.trend-scroll` are
// `overflow-x:auto` precisely so a phone user can swipe to the hidden columns, and their
// contents are deliberately wider than the viewport. Everything else must fit.
async function expectNoHorizontalOverflow(page, where) {
  const o = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const inScroller = (el) => {
      for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      return false;
    };
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      // A fixed/sticky decoration positioned off-canvas (an off-screen drawer) is not
      // page overflow; only in-flow content counts.
      if (cs.position === 'fixed') continue;
      if (inScroller(el)) continue;
      const over = Math.max(r.right - vw, -r.left);
      if (over > 1) {
        const name = (n) => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') +
          (n.className ? '.' + String(n.className).split(' ')[0] : '');
        // The ancestor chain, because "SPAN.unpriced is 11px too wide" does not say
        // WHICH container failed to contain it — and the fix is almost always on a
        // parent (a fixed grid track, a nowrap cell), not on the offender itself.
        const path = [];
        for (let n = el; n && n !== document.body && path.length < 5; n = n.parentElement) {
          path.unshift(name(n));
        }
        offenders.push({
          sel: name(el), over: Math.round(over), path: path.join(' > '),
          text: (el.textContent || '').trim().slice(0, 30),
        });
      }
    }
    offenders.sort((a, b) => b.over - a.over);
    return { vw, worst: offenders[0] || null, count: offenders.length,
             top: offenders.slice(0, 6) };
  });
  expect(o.worst ? o.worst.over : 0,
    `${where}: content spills past the ${o.vw}px viewport and is CLIPPED (html has ` +
    `overflow-x:hidden, so there is no scrollbar and no way to reach it). ` +
    `${o.count} element(s); widest: ${JSON.stringify(o.top)}`).toBeLessThanOrEqual(1);
}

// Text that is cut off by its own box. `truncate` + ellipsis is fine (the CSS says so);
// silent clipping is not.
async function expectNoClippedText(page, where) {
  const clipped = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('h1,h2,th,td,button,label,.card .value,.card .label')) {
      const cs = getComputedStyle(el);
      if (cs.overflow === 'hidden' && cs.textOverflow === 'ellipsis') continue;  // deliberate
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.scrollWidth > el.clientWidth + 2 && cs.overflowX === 'hidden') {
        out.push((el.tagName + (el.id ? '#' + el.id : '')) + ' :: ' + (el.textContent || '').slice(0, 40));
      }
    }
    return out;
  });
  expect(clipped, `${where}: text is clipped without an ellipsis`).toEqual([]);
}

test.describe('rendering', () => {
  for (const tab of TABS) {
    test(`#${tab} lays out correctly`, async ({ dash, pageErrors }, testInfo) => {
      const page = await dash.open(tab);
      // Let the ws/poll cycle settle so a capture is not raced against a re-render.
      await page.waitForTimeout(1200);

      await expectNoHorizontalOverflow(page, `${testInfo.project.name} #${tab}`);
      await expectNoClippedText(page, `${testInfo.project.name} #${tab}`);
      await expectProvenanceStated(page, `${testInfo.project.name} #${tab}`);
      await expectBasisStated(page, `${testInfo.project.name} #${tab}`);

      // Nothing may sit outside the viewport on the left, and nothing may collapse to
      // zero height — both render as "a section is missing" rather than as an error.
      //
      // Scoped to the ACTIVE pane: a `.panel` inside a hidden tab has a 0x0 rect even
      // though its own computed display is not `none` (the ANCESTOR is hidden), so an
      // unscoped query reports every off-screen tab as "collapsed".
      const broken = await page.evaluate(() => {
        const out = [];
        const pane = document.querySelector('.tabpane.active');
        if (!pane) return ['no active tab pane'];
        for (const el of pane.querySelectorAll('.panel, .card')) {
          if (el.offsetParent === null) continue;       // genuinely not rendered
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.left < -1) out.push('offscreen-left: ' + (el.id || el.className));
          if (r.height < 4) out.push('collapsed: ' + (el.id || el.className));
        }
        return out;
      });
      expect(broken, `${testInfo.project.name} #${tab}: broken boxes`).toEqual([]);

      await expectScreenshotWhereBaselined(page, tab, {
        fullPage: true, mask: volatileRegions(page),
      }, testInfo);
      expectClean(pageErrors, `${testInfo.project.name} #${tab}`);
    });
  }
});

test.describe('display modes', () => {
  test('light and dark both meet the WCAG AA contrast floor on body text',
    async ({ dash, page }) => {
      const measure = async () => page.evaluate(() => {
        const lum = (c) => {
          const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (a, b) => {
          const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
          return (x + 0.05) / (y + 0.05);
        };
        // Walk up for the nearest painted background — a transparent parent otherwise
        // reports rgba(0,0,0,0) and every ratio comes out perfect and meaningless.
        const bgOf = (el) => {
          let n = el;
          while (n && n !== document.documentElement) {
            const c = getComputedStyle(n).backgroundColor;
            if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
            n = n.parentElement;
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        const bad = [];
        const els = document.querySelectorAll(
          '.muted, th, td, .card .label, .card .value, .empty-note, .h2note, .basis-pill, .nodata');
        for (const el of els) {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const txt = (el.textContent || '').trim();
          if (!txt) continue;
          const r = ratio(cs.color, bgOf(el));
          const size = parseFloat(cs.fontSize);
          const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
          const floor = large ? 3.0 : 4.5;
          if (r < floor) bad.push(`${el.className || el.tagName} "${txt.slice(0, 24)}" ${r.toFixed(2)}:1 < ${floor}`);
        }
        return bad.slice(0, 12);
      });

      for (const theme of ['dark', 'light']) {
        await dash.open('reports');
        await page.evaluate((t) => {
          document.documentElement.setAttribute('data-theme', t);
          try { localStorage.setItem('cheaper-theme', t); } catch (e) {}
        }, theme);
        await page.waitForTimeout(300);
        const bad = await measure();
        expect(bad, `${theme} theme fails WCAG AA contrast`).toEqual([]);
      }
    });

  test('the dark and light captures actually differ', async ({ dash, page }) => {
    // A theme toggle that flips an attribute but paints nothing is a real bug that
    // every per-theme screenshot would happily record as "correct".
    await dash.open('dashboard');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(200);
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.waitForTimeout(200);
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(dark).not.toBe(light);
  });

  test('print preview keeps every pane and drops the chrome', async ({ dash, page }, testInfo) => {
    const p = await dash.open('reports');
    await p.emulateMedia({ media: 'print' });
    await p.waitForTimeout(300);
    // Browser print-to-PDF is the supported PDF path, so a printed report that silently
    // omitted three of four tabs would be worse than no print support at all.
    for (const tab of TABS) {
      await expect(p.locator(`#tab-${tab}`)).toBeVisible();
    }
    await expect(p.locator('.topnav')).toBeHidden();
    await expect(p.locator('.logs-filters')).toBeHidden();
    await expectScreenshotWhereBaselined(p, 'print-reports', {
      fullPage: true, mask: volatileRegions(p),
    }, testInfo);
    await p.emulateMedia({ media: 'screen' });
  });

  test('a real PDF renders with content on every page', async ({ dash, page, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'page.pdf() is Chromium-only');
    const p = await dash.open('reports');
    await p.emulateMedia({ media: 'print' });
    const pdf = await p.pdf({ format: 'A4', printBackground: true });
    // A PDF that is technically valid but empty is the failure mode a hand-rolled
    // writer has; assert it carries real bytes and a real page tree.
    expect(pdf.length).toBeGreaterThan(20000);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    await testInfo.attach('reports.pdf', { body: pdf, contentType: 'application/pdf' });
    await p.emulateMedia({ media: 'screen' });
  });
});

test.describe('touch targets', () => {
  test('every interactive control is at least 24px tall', async ({ dash }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'tap-target sizing is a mobile concern');
    const page = await dash.open('logs');
    const small = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('a[href], button, select, input')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;      // hidden
        if (r.height < 24) out.push(`${el.tagName}${el.id ? '#' + el.id : ''} ${Math.round(r.height)}px`);
      }
      return out;
    });
    // WCAG 2.2 AA "Target Size (Minimum)" is 24x24 CSS px.
    expect(small, 'controls below the 24px minimum tap target').toEqual([]);
  });
});

test.describe('baseline inventory', () => {
  // THE GUARD THAT PAYS FOR THE CONDITIONAL CAPTURE ABOVE.
  //
  // Making the pixel comparison conditional on "does a baseline exist for this platform"
  // opens one hole: DELETE a baseline and the capture silently downgrades to a skip
  // instead of failing. Off the reference platform nothing would notice, and the suite
  // would stay green while its screenshot coverage quietly drained away.
  //
  // So the reference set is asserted directly, from disk, with no browser involved —
  // which means this runs and FAILS ON EVERY PLATFORM, including the Linux CI where the
  // captures themselves are skipped. Deleting a baseline breaks the build everywhere.
  //
  // It reads the expected names from the same TABS constant the capturing tests loop
  // over, so adding a tab moves both together. PROJECTS is listed literally because it
  // mirrors playwright.config.js's project list, which this file cannot see — the count
  // assertion below is what catches the two drifting apart.
  const PROJECTS = ['desktop-dark', 'desktop-light', 'tablet', 'mobile', 'a11y'];
  const CAPTURES = [...TABS, 'print-reports'];

  test('every reference-platform baseline is present', () => {
    const missing = [];
    for (const name of CAPTURES) {
      for (const project of PROJECTS) {
        const f = baselineFor(name, project, REFERENCE_PLATFORM);
        if (!fs.existsSync(f)) missing.push(path.basename(f));
      }
    }
    expect(missing,
      `${REFERENCE_PLATFORM} baselines are missing. A capture with no baseline for the ` +
      `platform it runs on is SKIPPED, not failed, so a deleted baseline would drain ` +
      `screenshot coverage silently. Restore it, or regenerate on ${REFERENCE_PLATFORM} ` +
      `with: npx playwright test visual.spec.js --update-snapshots`).toEqual([]);
  });

  test('no baseline exists that nothing captures', () => {
    // The other direction. A renamed tab or a retired project leaves an orphan PNG that
    // is never compared against anything, and an orphan is indistinguishable from a
    // baseline that simply has not been reached yet — so the set stops describing what
    // the suite actually checks.
    const expected = new Set();
    for (const name of CAPTURES) {
      for (const project of PROJECTS) {
        expected.add(`${name}-${project}-${REFERENCE_PLATFORM}.png`);
      }
    }
    const onDisk = fs.existsSync(SNAPSHOT_DIR) ? fs.readdirSync(SNAPSHOT_DIR) : [];
    const orphans = onDisk
      .filter((f) => f.endsWith(`-${REFERENCE_PLATFORM}.png`))
      .filter((f) => !expected.has(f));
    expect(orphans,
      'baseline PNG(s) that no test captures — a renamed tab or a retired project leaves ' +
      'these behind, and they read as coverage that does not exist').toEqual([]);
  });

  test('the inventory itself is not vacuous', () => {
    // Both assertions above pass trivially if CAPTURES or PROJECTS is empty — an empty
    // expectation set finds nothing missing and nothing orphaned. Pin the shape, not a
    // number that a legitimate new tab would have to chase: the count is DERIVED from
    // the two lists, so this only fires when one of them is empty or the directory has
    // been emptied.
    expect(CAPTURES.length, 'no captures declared').toBeGreaterThan(0);
    expect(PROJECTS.length, 'no capturing projects declared').toBeGreaterThan(0);
    const onDisk = fs.existsSync(SNAPSHOT_DIR)
      ? fs.readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith('.png')) : [];
    expect(onDisk.length,
      'the snapshot directory holds no PNG at all — every capture would silently skip')
      .toBeGreaterThanOrEqual(CAPTURES.length * PROJECTS.length);
  });
});
