'use strict';
// SECURITY — the same-machine token, DNS-rebinding defence, and injection boundaries.
//
// Loopback is not a trust boundary on a shared machine: before this release any other
// user account or process on the box could GET localhost:8787/metrics and read the
// owner's complete per-call AI-usage record.

const { test, expect } = require('./fixtures');

const GATED = ['/metrics', '/peek', '/logs', '/report', '/dashboard',
               '/api/v1/logs', '/api/v1/reports/periods', '/api/v1/export?format=json'];

test.describe('gateway authentication', () => {
  for (const path of GATED) {
    test(`401 without a token: ${path}`, async ({ request }) => {
      const r = await request.get(path);
      expect(r.status(), `${path} answered ${r.status()} with no token`).toBe(401);
      // The refusal must be actionable, not just a status code.
      expect(await r.text()).toContain('dash.token');
    });

    test(`200 with the token: ${path}`, async ({ request, token }) => {
      const r = await request.get(path, { headers: { 'x-cheaper-token': token } });
      expect(r.status(), `${path} refused a valid token`).toBe(200);
    });
  }

  test('/healthz stays open — every freshness check polls it before it can know a token',
    async ({ request }) => {
      const r = await request.get('/healthz');
      expect(r.status()).toBe(200);
      const j = await r.json();
      expect(j.ok).toBe(true);
      expect(j.auth_required).toBe(true);
      expect(j.token_private).toBe(true);
      expect(typeof j.code_sha).toBe('string');
    });

  test('a wrong token is refused', async ({ request }) => {
    expect((await request.get('/metrics', { headers: { 'x-cheaper-token': '0'.repeat(64) } })).status()).toBe(401);
    expect((await request.get('/metrics?token=nope')).status()).toBe(401);
  });

  test('a non-loopback Host header is rejected before auth even runs (DNS rebinding)',
    async ({ request, token }) => {
      const r = await request.get('/metrics', {
        headers: { host: 'evil.example.com', 'x-cheaper-token': token },
      });
      // 400 from TrustedHostMiddleware — a page that resolves its own domain to
      // 127.0.0.1 still cannot read the dashboard, because the browser sends the
      // attacker's Host.
      expect(r.status()).toBe(400);
    });

  test('the served dashboard markup never contains the secret', async ({ request, token }) => {
    const html = await (await request.get(`/dashboard?token=${token}`)).text();
    expect(html).not.toContain(token);
    // …and no 64-hex literal at all, which would look like one.
    expect(html).not.toMatch(/[0-9a-f]{64}/);
  });

  test('the token is moved out of the address bar and into sessionStorage',
    async ({ page, token }) => {
      await page.goto(`/dashboard?token=${token}#dashboard`);
      await page.waitForLoadState('networkidle');
      // This URL gets screenshotted, pasted into issues and left on screen in demos.
      expect(page.url()).not.toContain(token);
      expect(await page.evaluate(() => sessionStorage.getItem('cheaper.token'))).toBe(token);
      // …and a plain reload still works. This is the case sessionStorage alone CANNOT
      // cover: the server cannot read it, so a Cmd-R arrived with no credential and
      // landed on the auth wall. The gateway issues an HttpOnly, SameSite=Strict
      // session cookie on the authenticated load, which the browser re-sends on a
      // navigation the page did not initiate.
      const reloaded = await page.reload();
      expect(reloaded.status(), 'a plain reload must not 401').toBe(200);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('#tabNav')).toBeVisible();
      await expect(page.locator('#authWall')).toBeHidden();
    });

  test('the session cookie is HttpOnly and SameSite=Strict', async ({ context, page, token }) => {
    await page.goto(`/dashboard?token=${token}`);
    await page.waitForLoadState('networkidle');
    const c = (await context.cookies()).find((x) => x.name === 'cheaper_token');
    expect(c, 'the authenticated load must issue a session cookie').toBeTruthy();
    // HttpOnly: an injected script on the page cannot read the secret back out.
    expect(c.httpOnly, 'the cookie must not be script-readable').toBe(true);
    // Strict: never attached to ANY cross-site request, including a top-level
    // navigation from another origin — which is what makes it safe to gate GETs on.
    expect(String(c.sameSite).toLowerCase()).toBe('strict');
    expect(c.path).toBe('/');
    // A session cookie, so it dies with the browser and cannot outlive a rotation.
    expect(c.expires === -1 || c.session === true).toBeTruthy();
  });

  test('the cookie is NEVER issued to a caller that did not already hold the token',
    async ({ context, page }) => {
      await page.goto('/dashboard');           // 401 auth wall
      const c = (await context.cookies()).find((x) => x.name === 'cheaper_token');
      expect(c, 'an unauthenticated request must not be handed the secret').toBeFalsy();
    });

  test('an un-tokened page shows a readable auth wall, not raw JSON', async ({ page }) => {
    // Two failure modes this rules out: rendering empty panels (which reads as "you
    // saved nothing" — the exact silent-zero this product exists to eliminate), and
    // rendering `{"detail": …}` as raw JSON to whoever bookmarked the URL.
    const res = await page.goto('/dashboard');
    expect(res.status()).toBe(401);
    await expect(page.locator('body')).toContainText('needs its local token');
    await expect(page.locator('body')).toContainText('cheaper dashboard');
    await expect(page.locator('body')).toContainText('dash.token');
    // The real dashboard must NOT have been served.
    expect(await page.locator('#tabNav').count()).toBe(0);
  });

  test('the websocket refuses an un-tokened client and accepts a tokened one',
    async ({ page, token, baseURL }) => {
      const closed = await page.evaluate((url) => new Promise((res) => {
        const ws = new WebSocket(url + '/ws');
        ws.onclose = (e) => res(e.code);
        ws.onmessage = () => res('GOT-DATA');
        ws.onopen = () => res('OPENED');
        setTimeout(() => res('TIMEOUT'), 5000);
      }), baseURL.replace('http', 'ws'));
      // The gateway REJECTS the handshake rather than closing an accepted socket, so no
      // WebSocket is ever established and not one frame can leak. A browser reports
      // that as 1006 (abnormal closure) because there is no close frame to read a code
      // from; the TestClient sees the 1008 the server passed (pinned in
      // gateway/tests/test_auth.py). What matters here is that it neither OPENED nor
      // delivered data — asserting the numeric code would be asserting the WEAKER
      // accept-then-close behaviour.
      expect([1006, 1008], `an un-tokened socket must not open (got ${closed})`)
        .toContain(closed);

      const got = await page.evaluate(([url, t]) => new Promise((res) => {
        const ws = new WebSocket(url + '/ws?token=' + t);
        ws.onmessage = (e) => { try { res(JSON.parse(e.data).type); } catch { res('BAD'); } };
        ws.onclose = (e) => res('closed-' + e.code);
        setTimeout(() => res('TIMEOUT'), 5000);
      }), [baseURL.replace('http', 'ws'), token]);
      expect(got).toBe('metrics');
    });
});

test.describe('injection boundaries', () => {
  test('an adversarial model id renders as TEXT, never as markup', async ({ page, request, token }) => {
    // `reason`, `source` and model ids are client-controlled and reach the Logs table.
    const payload = '<img src=x onerror=window.__XSS__=1>';
    await request.post('/v1/messages', {
      headers: { 'x-api-key': 't', 'anthropic-version': '2023-06-01',
                 'x-cheaper-source': payload },
      data: { model: payload, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
      failOnStatusCode: false,
    });
    await page.goto(`/dashboard?token=${token}#logs`);
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => window.__XSS__)).toBeUndefined();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
  });

  test('the CSV export guards spreadsheet formulas', async ({ request, token }) => {
    const r = await request.get('/api/v1/export?format=csv', {
      headers: { 'x-cheaper-token': token },
    });
    expect(r.status()).toBe(200);
    const body = await r.text();
    // No unguarded cell may begin with a formula trigger. Excel, LibreOffice and Sheets
    // all EVALUATE such a cell on open, and this is an export of adversary-influenceable
    // text — `=cmd|'/c calc'!A1` in a `reason` would be code execution on the reader's
    // machine.
    for (const line of body.split('\r\n')) {
      if (!line || line.startsWith('#')) continue;
      for (const cell of line.split(',')) {
        const c = cell.replace(/^"|"$/g, '');
        if (!c) continue;
        const isNumber = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(c);
        if (isNumber) continue;   // a negative delta MUST stay a number
        expect(['=', '+', '@'].includes(c[0]),
          `unguarded formula cell: ${JSON.stringify(c)}`).toBe(false);
      }
    }
  });

  test('the export declares a safe filename and a UTF-8 charset', async ({ request, token }) => {
    const r = await request.get('/api/v1/export?format=csv', {
      headers: { 'x-cheaper-token': token },
    });
    const cd = r.headers()['content-disposition'] || '';
    // Content-Disposition header injection: a filename may not carry CR/LF or quotes.
    expect(cd).not.toMatch(/[\r\n]/);
    expect(r.headers()['content-type'] || '').toMatch(/utf-8/i);
  });
});
