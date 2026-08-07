'use strict';
// COMPLIANCE — the honesty invariants, enforced against the RENDERED page.
//
// These are the claims the product makes about its own numbers. Each one has already
// been violated at least once in this codebase's history, and each violation looked
// completely normal on screen:
//
//   1. never add a figure from two sources (measured + estimated is a double count)
//   2. dollars are derived, never stored
//   3. price each row at its OWN day, not today
//   4. fail closed — unpriceable means no claim, labelled, counted
//   5. no filesystem path and no prompt text ever leaves the machine or reaches the UI
//   6. every "report nothing" case renders a labelled non-number, NEVER $0.00

const { test, expect } = require('./fixtures');

test.describe('honesty invariants', () => {
  test('an unpriceable cell renders an em dash with an explanation, never $0.00',
    async ({ dash }) => {
      const page = await dash.open('logs');
      await expect(page.locator('#logsBody tr').first()).toBeVisible();
      const cells = await page.$$eval('#logsBody tr', (trs) => trs.map((tr) => {
        const td = Array.from(tr.querySelectorAll('td'));
        return {
          why: (td[10] && td[10].textContent || '').trim(),
          baseline: (td[7] && td[7].textContent || '').trim(),
          actual: (td[8] && td[8].textContent || '').trim(),
          delta: (td[9] && td[9].textContent || '').trim(),
          deltaTitle: (td[9] && td[9].getAttribute('title')) || '',
        };
      }));
      expect(cells.length).toBeGreaterThan(0);
      const dashCells = cells.filter((c) => c.delta === '—');
      // The seed deliberately contains an unpriceable model and a 429.
      expect(dashCells.length, 'the fixture must exercise the unpriceable path').toBeGreaterThan(0);
      for (const c of dashCells) {
        // "$0.00" is a MEASURED result. "No figure is claimed" is not. Rendering the
        // second as the first is the concealment this register exists to end.
        expect(c.delta).not.toBe('$0.00');
        expect(c.deltaTitle, 'an em dash must explain itself').toMatch(/no figure is claimed|not in the price catalog/i);
      }
    });

  test('basis and grain are present on EVERY row and marked non-hideable',
    async ({ dash }) => {
      const page = await dash.open('logs');
      await expect(page.locator('#logsBody tr').first()).toBeVisible();
      const n = await page.locator('#logsBody tr').count();
      expect(await page.locator('#logsBody tr .basis-pill').count()).toBe(n);
      expect(await page.locator('#logsBody tr .grain-pill').count()).toBe(n);
      // The header lock marks them as structural, so a later "simplify the table"
      // change has to argue with a test rather than silently re-mix the two bases.
      expect(await page.locator('#logsTable thead th.locked').count()).toBe(2);
    });

  test('the ladder never presents measured and estimated as one figure', async ({ dash }) => {
    const page = await dash.open('reports');
    await expect(page.locator('#ladderBody tr').first()).toBeVisible();
    const heads = await page.$$eval('table.ladder thead th', (th) => th.map((x) => x.textContent.trim()));
    // Saved, Spent AND Events each get the two-column treatment. "82 events" from 76
    // gateway CALLS plus 6 ledger CHATS is the same concealment as adding their
    // dollars, in a column where the separation is less visually obvious.
    for (const c of ['Saved (measured)', 'Saved (estimated)', 'Spent (measured)',
                     'Spent (estimated)', 'Events (measured)', 'Events (estimated)']) {
      expect(heads, `missing two-column header: ${c}`).toContain(c);
    }
    // And no header may offer a combined total.
    for (const h of heads) {
      expect(h, `a combined column would invite a cross-basis sum: ${h}`)
        .not.toMatch(/^(Saved|Spent|Events|Total)$/);
    }
  });

  test('the ladder rows are a PARTITION of history', async ({ request, token }) => {
    const r = await request.get('/api/v1/reports/periods', {
      headers: { 'x-cheaper-token': token },
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.periods.length).toBe(6);
    expect(j.lifetime, 'the ladder needs a lifetime total to be checkable').toBeTruthy();

    // CALLS and TOKENS are the partition invariant that always holds: they are exact in
    // every window, including one whose DOLLARS are withheld for being >20%
    // unpriceable. Asserting on dollars alone would make this test fail the moment
    // suppression fires — i.e. exactly when the honesty machinery is working.
    for (const side of ['measured', 'estimated']) {
      const calls = j.periods.reduce((n, w) => n + ((w[side] && w[side].calls) || 0), 0);
      const lt = (j.lifetime[side] && j.lifetime[side].calls) || 0;
      expect(calls, `the ${side} ladder does not partition lifetime by call count`).toBe(lt);
      const toks = j.periods.reduce((n, w) => n + ((w[side] && w[side].tokens) || 0), 0);
      expect(toks, `the ${side} ladder does not partition lifetime by tokens`)
        .toBe((j.lifetime[side] && j.lifetime[side].tokens) || 0);
    }

    // And where NOTHING is suppressed, the dollars must partition to the cent too.
    const clean = j.periods.filter((w) => !(w.labels || []).includes('dollars_suppressed'));
    if (clean.length === j.periods.length) {
      for (const side of ['measured', 'estimated']) {
        const sum = clean.reduce((n, w) => n + ((w[side] && w[side].saved) || 0), 0);
        expect(Math.abs(sum - ((j.lifetime[side] && j.lifetime[side].saved) || 0)))
          .toBeLessThan(1e-6);
      }
    } else {
      // A suppressed window must still declare its counts rather than going blank —
      // only the money is withheld.
      for (const w of j.periods.filter((x) => (x.labels || []).includes('dollars_suppressed'))) {
        const any = (w.measured && w.measured.calls) + (w.estimated && w.estimated.calls);
        expect(Number.isFinite(any), `${w.key} lost its call counts to suppression`).toBe(true);
        expect((w.notes || []).join(' '), `${w.key} suppressed dollars without saying why`)
          .toMatch(/not in the price catalog/i);
      }
    }
  });

  test('the legacy chat-grain figure is never placed in a basis column', async ({ dash }) => {
    const page = await dash.open('reports');
    await expect(page.locator('#ladderBody tr').first()).toBeVisible();
    const legacy = page.locator('#ladderBody tr.legacy');
    if (await legacy.count() === 0) return;   // no legacy store on this machine
    // It spans the money columns as prose, so it cannot be read down a column and added
    // to the Lifetime row above it — which would be both a cross-grain and a
    // cross-basis double count.
    const spans = await legacy.locator('td[colspan]').count();
    expect(spans, 'the legacy row must span the basis columns, not occupy one').toBeGreaterThan(0);
    await expect(legacy).toContainText(/excluded from every period/i);
  });

  test('a period the store did not fully watch SAYS SO, and never fabricates a figure '
     + 'for the part it missed', async ({ request, token, page }) => {
      // The seeded coverage has a deliberate GAP: a backfilled island around the
      // 400-day-old event, then a recent observed run, with a stretch in between that
      // nobody watched.
      //
      // The pure `not_covered` branch (a window with NO events and NO coverage at all)
      // is pinned by dedicated unit tests on BOTH runtimes —
      // cli/test/store.test.js "a period with no coverage reports NOT COVERED, not
      // $0.00" and gateway/tests/test_reporting.py
      // ::test_a_period_outside_coverage_reports_not_covered_and_no_dollar_figure —
      // because an event ANYWHERE in a ladder window is itself proof of observation, so
      // a realistic browser fixture will normally produce `partial` rather than a fully
      // blank window. What this test owns is the RENDERED behaviour: an incompletely
      // covered window must declare it, and must never present its figure as complete.
      const r = await request.get('/api/v1/reports/periods',
        { headers: { 'x-cheaper-token': token } });
      expect(r.status()).toBe(200);
      const j = await r.json();

      const incomplete = j.periods.filter((w) => w.status === 'not_covered' || w.status === 'partial');
      expect(incomplete.length,
        'the fixture must exercise an incomplete-coverage window: ' +
        JSON.stringify(j.periods.map((w) => [w.key, w.status]))).toBeGreaterThan(0);

      for (const w of incomplete) {
        const label = (w.labels || []).join(' ');
        const note = (w.notes || []).join(' ');
        expect(label + note, `${w.key} hid its incomplete coverage`)
          .toMatch(/not_covered|partial_coverage|covered/i);
        if (w.status === 'not_covered') {
          // "$0" and "we weren't watching" are different claims. A window with no
          // observation at all must refuse to produce a number rather than produce a
          // zero.
          expect(w.measured, `${w.key} reported a figure for an unwatched period`).toBeNull();
          expect(w.estimated).toBeNull();
          expect(note).toMatch(/not the same as saving \$0/i);
        } else {
          // A partial window reports only its covered sub-window, and says which.
          expect(note).toMatch(/only part of this period is covered/i);
          expect(w.coverage && w.coverage.covered, `${w.key} claims partial with no sub-window`)
            .toBeTruthy();
        }
      }

      // …and the rendered table must carry that state, not just the JSON.
      await page.goto(`/dashboard?token=${token}#reports`);
      await page.waitForLoadState('networkidle');
      const notes = await page.locator('#ladderBody tr.rownote').allInnerTexts();
      expect(notes.join(' '), 'the ladder rendered no coverage note at all')
        .toMatch(/covered|price catalog/i);
    });

  test('no rendered page and no API response leaks a filesystem path or a home dir',
    async ({ dash, request, token }) => {
      const home = process.env.HOME || '/Users';
      for (const tab of ['dashboard', 'reports', 'logs', 'monitor']) {
        const page = await dash.open(tab);
        const text = await page.locator('body').innerText();
        expect(text, `#${tab} rendered a home directory`).not.toContain(home);
        expect(text, `#${tab} rendered a /Users path`).not.toMatch(/\/Users\/[A-Za-z]/);
      }
      for (const ep of ['/api/v1/logs', '/api/v1/reports/periods', '/metrics', '/logs']) {
        const body = await (await request.get(ep, { headers: { 'x-cheaper-token': token } })).text();
        expect(body, `${ep} leaked a path`).not.toMatch(/\/Users\/[A-Za-z]/);
        expect(body, `${ep} leaked the home dir`).not.toContain(home);
      }
    });

  test('the export carries its audit provenance header', async ({ request, token }) => {
    const csv = await (await request.get('/api/v1/export?format=csv',
      { headers: { 'x-cheaper-token': token } })).text();
    // `row_digest` is what turns a printout into evidence: a reader re-runs `reproduce`
    // and checks byte-for-byte that nothing was edited.
    for (const key of ['export_schema', 'period_start', 'period_end', 'timezone',
                       'price_catalog', 'NOT AN INVOICE', 'row_digest', 'reproduce']) {
      expect(csv, `the audit header is missing ${key}`).toContain(key);
    }
    // INCLUSIVE start / EXCLUSIVE end must be stated, not implied.
    expect(csv).toMatch(/INCLUSIVE/);
    expect(csv).toMatch(/EXCLUSIVE/);
  });

  test('an unpriceable row exports an EMPTY delta cell, never 0', async ({ request, token }) => {
    const csv = await (await request.get('/api/v1/export?format=csv',
      { headers: { 'x-cheaper-token': token } })).text();
    // Strip the UTF-8 BOM (present so Excel does not decode as its ANSI code page) and
    // the audit preamble, whose lines are `#`-prefixed single CSV CELLS — and therefore
    // legitimately quoted, so a bare `startsWith('#')` misses most of them.
    const firstCell = (l) => l.replace(/^﻿/, '').replace(/^"/, '')[0];
    const lines = csv.replace(/^﻿/, '').split('\r\n')
      .filter((l) => l && firstCell(l) !== '#');
    expect(lines.length, 'the export has no data rows').toBeGreaterThan(1);
    const head = lines[0].split(',').map((h) => h.replace(/^"|"$/g, ''));
    const di = head.indexOf('delta_usd');
    const ri = head.indexOf('unpriced_reason');
    expect(di, `the export must carry a delta_usd column; got ${head.join('|')}`)
      .toBeGreaterThanOrEqual(0);
    expect(ri, 'and an unpriced_reason column, or the claim is uncheckable')
      .toBeGreaterThanOrEqual(0);
    let sawUnpriceable = 0;
    for (const line of lines.slice(1)) {
      const cells = line.split(',');
      if ((cells[ri] || '').replace(/"/g, '').trim()) {
        sawUnpriceable++;
        const d = (cells[di] || '').replace(/"/g, '').trim();
        // `0.00` is a MEASURED result. Empty is "no claim made". A spreadsheet that
        // sums the column must not silently include the rows we declined to price.
        expect(d, 'an unpriceable row must export an EMPTY delta, never 0').toBe('');
      }
    }
    expect(sawUnpriceable, 'the fixture must contain an unpriceable row').toBeGreaterThan(0);
  });

  test('JSON export is lossless: an unpriceable delta is null, not 0', async ({ request, token }) => {
    const j = await (await request.get('/api/v1/export?format=json',
      { headers: { 'x-cheaper-token': token } })).json();
    const rows = j.rows || j;
    expect(Array.isArray(rows)).toBe(true);
    for (const r of rows) {
      if (r.unpriced_reason) {
        expect(r.delta_usd, 'null means no claim; 0 means a measured zero').toBeNull();
      }
    }
  });
});
