'use strict';
// REGRESSION — one test per defect this workstream fixed.
//
// Each of these shipped at least once. Each looked completely normal on screen. The
// point of pinning them here is that the next person to "simplify" one of these paths
// has to argue with a named failure rather than with a comment.

const { test, expect } = require('./fixtures');

test.describe('the timezone frame', () => {
  // The catalog carries claude-sonnet-5 at a promotional $2/$10 from 2026-01-01 through
  // 2026-08-31, against a standard $3/$15. The defect: pricing resolved on the UTC date
  // while the calendar bucketed on LOCAL midnight, so one row could be priced in one
  // month and reported in another — a live ±50% error on 1M-in/1M-out.
  //
  // Both window boundaries are asserted, because they fail in OPPOSITE directions.

  test('the promo window START: a local 2025-12-31 23:30 -07:00 call is priced at the '
     + 'STANDARD rate, not the promo the UTC date would have given it',
    async ({ request, token }) => {
      const rows = (await (await request.get('/api/v1/logs?limit=1000',
        { headers: { 'x-cheaper-token': token } })).json()).rows || [];
      const row = rows.find((x) => x.session === 'sess-promo-before');
      expect(row, 'the promo-start fixture must be present').toBeTruthy();
      // Local 2025-12-31 is UTC 2026-01-01 — the first day of the promo.
      expect(row.pday, 'pday must be the LOCAL day, not the UTC one').toBe('2025-12-31');
      // 1M in + 1M out at the STANDARD $3/$15 = $18.00. A UTC-framed implementation
      // reads 2026-01-01, applies the $2/$10 promo, and reports $12.00 — a 33%
      // UNDER-statement of spend and a corresponding over-statement of the saving.
      expect(Math.abs(row.actual_usd - 18.0),
        `priced at ${row.actual_usd}, expected the standard 18.00`).toBeLessThan(1e-6);
    });

  test('the promo window END: a local 2026-08-31 23:30 -07:00 call keeps the August '
     + 'promo and buckets into August', async ({ request, token }) => {
      const rows = (await (await request.get('/api/v1/logs?limit=1000',
        { headers: { 'x-cheaper-token': token } })).json()).rows || [];
      const promo = rows.find((x) => x.session === 'sess-promo');
      // This instant is genuinely in the future until 2026-08-31, and a future-dated
      // row is correctly quarantined by the skew guard — so seeding it early would test
      // the quarantine, not the pricing. The START boundary above covers the same code
      // path from the other side and runs unconditionally.
      test.skip(!promo, 'the promo-end instant has not occurred yet; the promo-START '
        + 'case above exercises the same one-time-frame rule and always runs');
      expect(promo.pday).toBe('2026-08-31');
      // 1M in + 1M out at the promo = $12.00; the standard rate would be $18.00.
      expect(Math.abs(promo.actual_usd - 12.0), `priced at ${promo.actual_usd}`).toBeLessThan(1e-6);
    });
});

test.describe('never a silent zero', () => {
  test('an unpriceable model never contributes and never renders $0.00',
    async ({ request, token }) => {
      const rows = (await (await request.get('/api/v1/logs?limit=1000',
        { headers: { 'x-cheaper-token': token } })).json()).rows || [];
      const un = rows.find((x) => x.session === 'sess-unpriced');
      expect(un, 'the unpriceable fixture must be present').toBeTruthy();
      expect(un.actual_usd).toBeNull();
      expect(un.delta_usd).toBeNull();
      expect(un.unpriced_reason).toBeTruthy();
    });

  test('a 429 is recorded but never priced', async ({ request, token }) => {
    const rows = (await (await request.get('/api/v1/logs?limit=1000',
      { headers: { 'x-cheaper-token': token } })).json()).rows || [];
    const retry = rows.find((x) => x.session === 'sess-429');
    expect(retry, 'the retry fixture must be present').toBeTruthy();
    expect(retry.delta_usd, 'a six-retry storm must not book six savings').toBeNull();
    expect(retry.unpriced_reason).toBe('non_2xx');
  });
});

test.describe('the sign survives', () => {
  test('a routed call that cost MORE renders as a negative, in red', async ({ dash, request, token }) => {
    const rows = (await (await request.get('/api/v1/logs?limit=1000',
      { headers: { 'x-cheaper-token': token } })).json()).rows || [];
    const neg = rows.find((x) => x.session === 'sess-week-neg');
    expect(neg, 'the anti-saving fixture must be present').toBeTruthy();
    // No max(0, …) anywhere: the same `> 0` guard concealed the honest number in three
    // separate prior incidents.
    expect(neg.delta_usd).toBeLessThan(0);

    const page = await dash.open('logs');
    await expect(page.locator('#logsBody tr').first()).toBeVisible();
    const hasNeg = await page.locator('#logsBody td.money-neg').count();
    expect(hasNeg, 'a negative delta must be visibly negative in the register')
      .toBeGreaterThan(0);
  });
});

test.describe('measured vs estimated', () => {
  test('the two bases are both present and are never combined into one cell',
    async ({ dash }) => {
      const page = await dash.open('logs');
      await expect(page.locator('#logsBody tr').first()).toBeVisible();
      const pills = await page.$$eval('#logsBody .basis-pill', (ps) => ps.map((p) => p.textContent.trim()));
      expect(new Set(pills).size, 'the fixture must exercise BOTH bases').toBeGreaterThan(1);
      expect(pills.every((p) => p === 'measured' || p === 'estimated' || p === 'unknown')).toBe(true);
    });

  test('legacy chat-grain rows are a THIRD state, excluded from every period',
    async ({ dash }) => {
      const page = await dash.open('reports');
      await expect(page.locator('#ladderBody tr').first()).toBeVisible();
      const legacy = page.locator('#ladderBody tr.legacy');
      await expect(legacy).toBeVisible();
      const txt = await legacy.innerText();
      // Their timestamps are known-wrong, so putting them in a day would make the fix
      // look done while history stayed wrong.
      expect(txt).toMatch(/frozen/i);
      expect(txt).toMatch(/excluded from every period/i);
      expect(txt).toMatch(/never added to either basis/i);
    });
});

test.describe('freshness', () => {
  test('/healthz.code_sha equals the hash the CLI computes over the same files',
    async ({ request }) => {
      const { spawnSync } = require('child_process');
      const path = require('path');
      const j = await (await request.get('/healthz')).json();
      const cliPath = path.resolve(__dirname, '..', '..', 'cli', 'src', 'freshness.js');
      const gwPath = path.resolve(__dirname, '..', '..', 'cli', 'assets', 'gateway');
      const r = spawnSync(process.execPath, ['-e',
        `process.stdout.write(String(require(${JSON.stringify(cliPath)}).gatewayCodeHash(${JSON.stringify(gwPath)})))`],
        { encoding: 'utf8' });
      expect(r.status).toBe(0);
      // The two hashers must cover the SAME file set in the SAME order, or `cheaper
      // status` and the self-heal on `gateway start` always-differ — a permanent false
      // alarm, which is worse than no check because people learn to ignore it.
      expect(j.code_sha, 'gateway/_code_sha() and freshness.js/gatewayCodeHash() disagree')
        .toBe(r.stdout.trim());
    });
});

test.describe('empty and error states', () => {
  test('a filter that matches nothing explains itself instead of rendering blank',
    async ({ dash, page }) => {
      await dash.open('logs');
      await expect(page.locator('#logsBody tr').first()).toBeVisible();
      await page.fill('#fFrom', '2019-01-01');
      await page.fill('#fTo', '2019-01-02');
      await page.click('#fApply');
      // `networkidle` can resolve before the filtered fetch even starts, so poll on the
      // OUTCOME rather than on a network heuristic.
      await expect.poll(async () => page.locator('#logsBody tr').count(),
        { timeout: 10000 }).toBe(1);
      const body = await page.locator('#logsBody').innerText();
      // A blank register reads as "you saved nothing". It must say what would put rows
      // there instead.
      expect(body).toMatch(/No events in this range/i);
      expect(body).toMatch(/ANTHROPIC_BASE_URL/);
      expect(body).toMatch(/cheaper import/);
    });
});
