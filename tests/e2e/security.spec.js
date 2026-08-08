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
      // BOTH halves run from a page THIS GATEWAY SERVED, and that is load-bearing.
      //
      // /ws is origin-bound on top of the credential check (app.py's `if not
      // auth.origin_is_self(websocket) or not auth.check(websocket)`), because a
      // WebSocket is exempt from CORS and is the one route that would hand a
      // cross-origin caller a live stream of the whole usage record. A page the suite
      // never navigated sits on `about:blank`, whose origin is OPAQUE — Chromium sends
      // `Origin: null`, the same thing a sandboxed iframe or a file:// page sends —
      // and the gateway refuses it (pinned in gateway/tests/test_auth.py::
      // test_websocket_refuses_a_null_origin). Starlette surfaces a close() made
      // BEFORE accept() as a 403 on the handshake, so this test used to fail its
      // tokened half against a completely healthy gateway. Measured, on this browser:
      //
      //   page.url() with no goto ........ about:blank   location.origin -> "null"
      //     ws?token=<valid> ............. closed-1006          <- the gate, correctly
      //   after goto('/dashboard') (401) .. origin -> http://localhost:<port>
      //     ws (no credential) ........... closed-1006
      //     ws?token=<valid> ............. OPENED
      //   after goto('/dashboard?token=') . cookie cheaper_token present
      //     ws (cookie only) ............. OPENED         <- what dashboard.html builds
      //
      // and, at the raw-handshake layer against the same app:
      //   Origin: null            + ?token=  -> 403     Origin: self + ?token= -> 101
      //   Origin: self            + cookie   -> 101     Origin: localhost:9999
      //                                                   + cookie             -> 403
      //   no Origin, header token            -> 101     no credential          -> 403
      //
      // So: do not "simplify" this back to a bare page.evaluate on about:blank. The
      // null-origin refusal is a FEATURE, and it is asserted where it can be asserted
      // without ambiguity — server-side, in test_auth.py. Here it would be untestable
      // rather than merely awkward: from a null origin nothing is ever accepted, so
      // there is no positive control, and a client-side abort would be indistinguishable
      // from the server's refusal — a test that passes without the gate existing.
      const wsBase = baseURL.replace('http', 'ws');

      // A page on the gateway's own origin that was NEVER authenticated: /dashboard
      // answers 401 with the auth wall and, per the test above, issues no cookie. So
      // this is a same-origin browser holding no credential at all.
      const wall = await page.goto('/dashboard');
      expect(wall.status()).toBe(401);
      expect(await page.evaluate(() => sessionStorage.getItem('cheaper.token'))).toBeNull();

      const closed = await page.evaluate((url) => new Promise((res) => {
        const ws = new WebSocket(url + '/ws');
        ws.onclose = (e) => res(e.code);
        ws.onmessage = () => res('GOT-DATA');
        ws.onopen = () => res('OPENED');
        setTimeout(() => res('TIMEOUT'), 5000);
      }), wsBase);
      // The gateway REJECTS the handshake rather than closing an accepted socket, so no
      // WebSocket is ever established and not one frame can leak. A browser reports
      // that as 1006 (abnormal closure) because there is no close frame to read a code
      // from; the TestClient sees the 1008 the server passed (pinned in
      // gateway/tests/test_auth.py). What matters here is that it neither OPENED nor
      // delivered data — asserting the numeric code would be asserting the WEAKER
      // accept-then-close behaviour.
      expect([1006, 1008], `an un-tokened socket must not open (got ${closed})`)
        .toContain(closed);

      // Same page, same origin, same browser — the ONLY thing that changed is the
      // credential. That is what makes the refusal above non-vacuous: if the handshake
      // were being aborted before it ever reached the gateway, this would fail too.
      const got = await page.evaluate(([url, t]) => new Promise((res) => {
        const ws = new WebSocket(url + '/ws?token=' + t);
        ws.onmessage = (e) => { try { res(JSON.parse(e.data).type); } catch { res('BAD'); } };
        ws.onclose = (e) => res('closed-' + e.code);
        setTimeout(() => res('TIMEOUT'), 5000);
      }), [wsBase, token]);
      expect(got).toBe('metrics');

      // …and the socket the REAL dashboard opens, which is none of the above: after an
      // authenticated load the page has scrubbed the token out of its own URL, so
      // dashboard.html's wsUrl() builds a bare ws://location.host/ws and the HttpOnly
      // cookie is the only credential it carries. Regressing the origin binding into
      // "cookies are never enough for /ws" would kill the live view for every real
      // user while leaving both assertions above green.
      const loaded = await page.goto(`/dashboard?token=${token}`);
      expect(loaded.status()).toBe(200);
      const live = await page.evaluate((url) => new Promise((res) => {
        const ws = new WebSocket(url + '/ws');
        ws.onmessage = (e) => { try { res(JSON.parse(e.data).type); } catch { res('BAD'); } };
        ws.onclose = (e) => res('closed-' + e.code);
        setTimeout(() => res('TIMEOUT'), 5000);
      }), wsBase);
      expect(live, 'the cookie-only socket dashboard.html actually opens must connect')
        .toBe('metrics');
    });
});

test.describe('injection boundaries', () => {
  // The one injection-boundary test that POSTs to /v1/messages — the mutating half of
  // this describe block — lives in tests/e2e/zz-injection-mutates-store.spec.js, NOT
  // here. See that file's header comment for why: it permanently adds one row to the
  // gateway's shared SQLite store for the rest of the run (there is exactly one gateway
  // process and one DB across the whole suite — see playwright.config.js's webServer and
  // its "keep writes serialised" comment), which changes row counts and page heights
  // that OTHER specs depend on staying exactly as seed.js left them — most visibly
  // visual.spec.js's pixel-diffed #logs and #monitor screenshots, which grew by one
  // table row's worth of height (1440x1425 -> 1440x1472 on #logs) and failed the
  // moment this test ran before them.
  // These two remain here because neither one mutates anything — both are plain GETs
  // against an export endpoint that already exists in the seeded data.
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
