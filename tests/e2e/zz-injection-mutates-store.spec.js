'use strict';
// The `zz-` prefix is load-bearing, not decoration: `fullyParallel: false` + `workers: 1`
// in playwright.config.js already make the whole suite run single-worker, and Playwright
// discovers spec files in sorted path order — so a file that sorts alphabetically after
// every other tests/e2e/*.spec.js file is GUARANTEED to run dead last, after every other
// test in the suite has already read the gateway's shared SQLite store (one gateway
// process, one DB, for the entire run — see the webServer comment in
// playwright.config.js). If a new spec file is ever added whose name sorts after "zz-"
// (unlikely, but check), this guarantee breaks silently; grep for "zz-" in
// playwright.config.js's ordering comments before adding one.
//
// THAT WAS ONLY HALF THE FIX, and the missing half was not visible from inside this
// file. Sorting last orders the FILES within one project; it does nothing across
// PROJECTS. playwright.config.js declares five browser/viewport projects and each one
// runs the whole file list, so this spec ran five times and the row it writes survived
// into every later project. desktop-dark (first) screenshotted a clean store and
// passed; desktop-light, tablet, mobile and a11y each saw one MORE permanent Logs row
// than the project before them, and #logs and #monitor failed their pixel diffs in
// exactly those four and nowhere else. The `zz-` name is now matched by
// MUTATING_SPECS in playwright.config.js, which excludes this file from all five of
// those projects and runs it in a single `mutating` project declared last — so the
// mutation happens exactly ONCE, after every screenshot in the run. Keep the prefix
// (it is what the pattern matches) and add any new mutating spec to that pattern
// rather than to the shared set.
//
// WHY this test needs that guarantee: it is the injection-boundary test moved out of
// security.spec.js (see that file's `injection boundaries` describe block for the full
// history). It POSTs a real, completing request to /v1/messages — see
// tests/e2e/mock-anthropic-upstream.js and the `webServer` array in
// playwright.config.js for why that POST can complete at all — and the gateway's
// on_complete() callback in cli/assets/gateway/app/app.py::_forward() then writes ONE
// PERMANENT row into the shared store for the rest of the run. First version of this
// fix left the test inside security.spec.js, which — being alphabetically BEFORE
// visual.spec.js — ran first and grew #logs by one table row (1440x1425 -> 1440x1472)
// before visual.spec.js's `#logs`/`#monitor`/`#reports` screenshots were taken,
// failing three pixel-diffed baselines that have nothing to do with this test's own
// assertions. Isolating the one mutating test here, guaranteed to run last, fixes that
// without touching seed.js, the gateway, or any other agent's owned files — none of
// which expose a supported way to retract a single already-recorded call.

const { test, expect } = require('./fixtures');

test.describe('injection boundaries (mutating)', () => {
  test('an adversarial model id renders as TEXT, never as markup', async ({ page, request, token }) => {
    // `reason`, `source` and model ids are client-controlled and reach the Logs table.
    //
    // This POST used to complete against nothing: playwright.config.js's webServer sent
    // every request to ANTHROPIC_UPSTREAM_URL=http://127.0.0.1:9, a closed port, on the
    // stated assumption that "no test posts to /v1/messages". Against a closed port,
    // `_client.post()` in cli/assets/gateway/app/app.py::_forward() raises a connection
    // error BEFORE `on_complete()` (== METRICS.record) ever runs — so no Logs row was
    // EVER written here, and the two assertions below passed by inspecting an empty
    // table no matter what dashboard.html's esc() calls did or didn't do. It was a test
    // that could not fail. See tests/e2e/mock-anthropic-upstream.js and the
    // `webServer` array in playwright.config.js, which now give this POST a real 200 to
    // complete against. Proved by breaking one esc() call in a scratch copy of
    // dashboard.html and re-running this test: it failed on the img[src="x"] assertion
    // below with the broken markup actually present in the DOM (and the gateway's own
    // access log showed the resulting `GET /x 404` the injected <img> tag triggered) —
    // restoring the real file made it pass again. Not committed anywhere; see the task
    // report for the exact steps.
    const payload = '<img src=x onerror=window.__XSS__=1>';
    const posted = await request.post('/v1/messages', {
      headers: { 'x-api-key': 't', 'anthropic-version': '2023-06-01',
                 'x-cheaper-source': payload },
      data: { model: payload, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
      failOnStatusCode: false,
    });
    // If this is not 200, the mock upstream did not answer and every assertion below
    // would again be inspecting a table no row ever reached — fail loudly here instead.
    expect(posted.status(), 'the POST must complete against the mock upstream, or ' +
      'nothing below proves anything').toBe(200);

    await page.goto(`/dashboard?token=${token}#logs`);
    await page.waitForLoadState('networkidle');

    // The row this call produced must actually be present — an empty (or unrelated)
    // table would make the markup assertions below pass vacuously, which is exactly the
    // failure mode this whole test exists to close off.
    const rowCount = await page.locator('#logsBody tr').count();
    expect(rowCount, 'the adversarial call must have produced a Logs row').toBeGreaterThan(0);
    // `_sanitize_model()` (app.py) only strips control chars and clamps length — it does
    // NOT strip `<`/`>`, unlike `_sanitize_source()`. So the model id is the field that
    // actually carries the raw payload into storage, and dashboard.html's esc() at the
    // `pair` interpolation in renderLogs() is what has to neutralise it. Assert the
    // ESCAPED text is present so this test also fails if the row silently went missing
    // for some other reason (e.g. a session/source mismatch) rather than only checking
    // for the absence of markup. The model-pair cell is `truncate(…, 24)` BEFORE it is
    // escaped (renderLogs()), so only the first 23 raw characters plus an ellipsis
    // survive — this substring sits well inside that window regardless of exactly where
    // the ellipsis lands.
    await expect(page.locator('#logsBody')).toContainText('img src=x onerror=wind');

    expect(await page.evaluate(() => window.__XSS__)).toBeUndefined();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
  });
});
