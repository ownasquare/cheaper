'use strict';
// THE THREE LIVENESS STATES, AND THE MEASUREMENT-BASIS QUALIFIER — against the real page.
//
// Both are pure functions of the /metrics payload, and one gateway can only be in one of
// those states at a time: a socket carrying a call that landed five seconds ago cannot
// simultaneously be a socket whose newest row is 29 hours old. A single seeded store
// therefore cannot exercise more than one of them per run.
//
// So these tests serve the payload themselves, over a mocked /ws. What is mocked is the
// GATEWAY, not the product's figures: the frames below are the same JSON shape app.py
// pushes, with the two additive blocks (`measurement`, `freshness`) set to the state under
// test. Nothing here invents a number for a user to read — it puts the renderer in a state
// and asserts what the renderer says about it, which is the only way to prove the page
// tells the truth in a state this machine is not currently in.
//
// The real gateway's own basis line and status text are asserted un-mocked in
// visual.spec.js (expectBasisStated) and smoke.spec.js.

const { test, expect, expectClean } = require('./fixtures');

// The stable half of a /metrics push: enough for every renderer on the Dashboard tab to
// paint without hitting an absent-figure branch, so the assertions below are about the
// state under test and not about a missing key somewhere else.
function metrics(over) {
  return Object.assign({
    type: 'metrics',
    catalog: { as_of: '2026-08-06', priced: true, age_days: 2 },
    total: 94,
    downgrade_rate: 67.0,
    dollars: { saved: 80.52, spent: 12.7, savings_pct: 86.4,
               billed_top: 93.22, gross: 80.52, extra: 0 },
    baselines: { requested_default: 80.52, highest_tier: 93.22 },
    counts: { intercepted: 94, models_changed: 63, reasoning_opportunities: 0 },
    tokens: { saved_reasoning_potential: 0 },
    time: { saved_model_s: 0, saved_reasoning_potential_s: 0 },
    by_tool: [], by_source: {}, periods: {}, recent: [],
    timeseries: { bucket_seconds: 3600, points: [] },
  }, over);
}

// Answer /ws ourselves instead of proxying to the gateway. Playwright hands the handler a
// route that is NOT connected to a server unless connectToServer() is called, so this is
// a complete stand-in: the page's own connectWS() sees a normal open socket.
async function pushOnConnect(page, payload) {
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    ws.send(JSON.stringify(payload));
  });
}

const seconds = (n) => Math.floor(Date.now() / 1000) - n;

test.describe('item (d): "live" is a claim about the DATA, not about the socket', () => {
  test('a row that arrived seconds ago reads "live", in green', async ({ dash, page, pageErrors }) => {
    await pushOnConnect(page, metrics({
      freshness: { newest_ts: seconds(4), age_seconds: 4, live: true },
    }));
    await dash.open('dashboard');
    await expect(page.locator('#statusText')).toHaveText('live');
    await expect(page.locator('#statusDot')).toHaveClass(/\bon\b/);
    await expect(page.locator('#statusDot')).not.toHaveClass(/\bidle\b/);
    expectClean(pageErrors, 'live state');
  });

  test('an OPEN socket whose newest row is a day old does not call itself live',
    async ({ dash, page, pageErrors }) => {
      // THE DEFECT. /ws re-pushes the whole summary every five seconds whether or not a
      // call was routed, so this connection is frame-for-frame identical to the one
      // above at the transport layer — and the indicator was a function of the transport
      // alone. It reported a green "live" over a database nothing had written to since
      // the previous morning.
      await pushOnConnect(page, metrics({
        freshness: { newest_ts: seconds(104400), age_seconds: 104400, live: false },
      }));
      await dash.open('dashboard');
      const text = page.locator('#statusText');
      await expect(text).toHaveText(/^connected — no traffic for /);
      await expect(text).not.toHaveText(/live/);
      // It must say HOW STALE. "connected" alone cannot distinguish a five-minute lull
      // from a machine where nothing has ever been pointed at the gateway.
      await expect(text).toHaveText(/for 1d$/);
      // Amber, not green and not the red of a dropped connection: the socket is fine,
      // the traffic is not.
      await expect(page.locator('#statusDot')).toHaveClass(/\bidle\b/);
      await expect(page.locator('#statusDot')).not.toHaveClass(/\bon\b/);
      expectClean(pageErrors, 'connected-idle state');
    });

  test('a gateway that has recorded nothing says so, rather than reporting a zero age',
    async ({ dash, page }) => {
      await pushOnConnect(page, metrics({
        freshness: { newest_ts: null, age_seconds: null, live: false },
      }));
      await dash.open('dashboard');
      await expect(page.locator('#statusText')).toHaveText('connected — nothing recorded yet');
      await expect(page.locator('#statusDot')).toHaveClass(/\bidle\b/);
    });

  test('a gateway that publishes no freshness block claims only what it knows',
    async ({ dash, page }) => {
      // The state of every installed copy until the additive block ships. Inferring
      // "live" from a completed handshake is precisely the inference that produced this
      // defect, so an older gateway degrades to a labelled unknown.
      await pushOnConnect(page, metrics({}));
      await dash.open('dashboard');
      await expect(page.locator('#statusText')).toHaveText('connected — traffic unknown');
      await expect(page.locator('#statusDot')).toHaveClass(/\bidle\b/);
      await expect(page.locator('#statusDot')).not.toHaveClass(/\bon\b/);
    });

  test('the state change is announced, not just repainted', async ({ dash, page }) => {
    // The indicator sits in a role="status" aria-live="polite" region; assigning its text
    // is what announces the transition to a screen-reader user. Prove the region is the
    // element that actually mutates, rather than a wrapper around markup nothing touches.
    await pushOnConnect(page, metrics({
      freshness: { newest_ts: seconds(30000), age_seconds: 30000, live: false },
    }));
    await dash.open('dashboard');
    const region = page.locator('.status[role="status"][aria-live="polite"]');
    await expect(region).toHaveCount(1);
    await expect(region.locator('#statusText')).toHaveText(/^connected — no traffic for /);
  });
});

test.describe('item (b): unmeasured dollars are never presented as measured', () => {
  // The five payloads the page must qualify, including the two ways a gateway can fail to
  // say anything useful. All five must reach the same reader conclusion: this figure
  // cannot be quoted as measured.
  //
  // The counts mirror the store this workstream was commissioned against: 94 rows, four
  // of which produced output and carry the whole figure, none of which carried
  // provider-reported usage. `zero_token_calls` (in + out == 0) is 0 there;
  // `zero_output_calls` is 90 — those probes each carry input tokens, so they are priced
  // and round to $0.00 rather than being tokenless.
  const UNMEASURED = [
    ['unmeasured', { measured_calls: 0, unmeasured_calls: 94, dollars_basis: 'unmeasured',
                     priced_calls: 4, zero_token_calls: 0, examined_calls: 94,
                     zero_output_calls: 90, output_bearing_calls: 4 }],
    ['mixed', { measured_calls: 2, unmeasured_calls: 92, dollars_basis: 'mixed',
                priced_calls: 4, zero_token_calls: 0, examined_calls: 94,
                zero_output_calls: 90, output_bearing_calls: 4 }],
    ['an unrecognised basis', { dollars_basis: 'probably', priced_calls: 4 }],
  ];

  for (const [why, measurement] of UNMEASURED) {
    test(`${why}: the money headline carries a qualifier and the basis line says why`,
      async ({ dash, page, pageErrors }) => {
        await pushOnConnect(page, metrics({
          measurement,
          freshness: { newest_ts: seconds(104400), age_seconds: 104400, live: false },
        }));
        await dash.open('dashboard');

        // The three figures derived from the same token counts. Qualifying only the
        // flattering one would be its own dishonesty.
        for (const label of ['Saved', 'Spent', 'Savings %']) {
          const card = page.locator('#statCards .card', { hasText: label }).first();
          await expect(card.locator('.value'), `${label} is unqualified`)
            .toHaveText(/^about /);
        }
        // …and the figure still SURVIVES. The fix is a qualifier, not a redaction:
        // suppressing it would hide real spend.
        await expect(page.locator('#statCards .card', { hasText: 'Saved' }).first()
          .locator('.value')).toHaveText('about $80.52');

        // The banner, always present and not dismissable.
        const basis = page.locator('#basisLine');
        await expect(basis).toBeVisible();
        await expect(basis).not.toHaveText(/^Measured\./);
        expectClean(pageErrors, why);
      });
  }

  test('the zero-token rows behind the register\'s wall of $0.00 are explained',
    async ({ dash, page }) => {
      // 90 of 94 rows returned no output tokens at all. Those calls genuinely price to
      // $0.00 — the correct figure for them, not a missing one — and left unexplained the
      // column reads as a broken pricing path that someone then "fixes" by inventing a
      // number.
      const ACK = 'This figure is arithmetic over 4 priced call(s), none of which carried '
        + 'provider-reported usage (usage_source is not \'body\').';
      await pushOnConnect(page, metrics({
        measurement: Object.assign({}, UNMEASURED[0][1],
          { headline: { saved: null, unsubstantiated_saved: 80.52,
                        withheld_reason: 'unmeasured_usage', acknowledgement: ACK } }),
        freshness: { newest_ts: seconds(104400), age_seconds: 104400, live: false },
      }));
      await dash.open('logs');
      // The statement is on the tab where the reader meets the $0.00 column.
      const basis = page.locator('#basisLine');
      await expect(basis).toBeVisible();
      await expect(basis).toHaveText(/90 of 94 recorded calls returned no output tokens/);
      await expect(basis).toHaveText(/the correct figure for them/);
      // …and the gateway's OWN acknowledgement, verbatim. metrics.py calls this "the
      // acknowledgement a renderer MUST carry when it prints an unsubstantiated figure";
      // rewriting it here in different words is how one fix's two halves end up
      // describing the same population two ways.
      await expect(basis).toContainText(ACK);
    });

  test('a measured gateway is not qualified — the word still means something',
    async ({ dash, page }) => {
      // THE OVER-CORRECTION GUARD. "Always say about" would satisfy every assertion above
      // while making the qualifier meaningless: a reader who sees it over a figure the
      // product CAN substantiate stops reading it anywhere.
      await pushOnConnect(page, metrics({
        measurement: { measured_calls: 4, unmeasured_calls: 0, dollars_basis: 'measured',
                       priced_calls: 4, zero_token_calls: 0 },
        freshness: { newest_ts: seconds(4), age_seconds: 4, live: true },
      }));
      await dash.open('dashboard');
      await expect(page.locator('#statCards .card', { hasText: 'Saved' }).first()
        .locator('.value')).toHaveText('$80.52');
      await expect(page.locator('#basisLine')).toHaveText(/^Measured\./);
      await expect(page.locator('.approx')).toHaveCount(0);
    });
});

test.describe('item (a): the savings chart states its own scale', () => {
  const HOUR = 3600;

  test('a drawable series carries dated ends, a zero baseline and its bucket width',
    async ({ dash, page, pageErrors }) => {
      const t0 = Math.floor(seconds(6 * HOUR) / HOUR) * HOUR;
      await pushOnConnect(page, metrics({
        measurement: { measured_calls: 4, unmeasured_calls: 0, dollars_basis: 'measured',
                       priced_calls: 4, zero_token_calls: 0 },
        freshness: { newest_ts: seconds(30), age_seconds: 30, live: true },
        timeseries: { bucket_seconds: HOUR, points: [
          { t: t0, saved: 1.25, spent: 0.4, calls: 3 },
          { t: t0 + HOUR, saved: 2.5, spent: 0.6, calls: 5 },
          { t: t0 + 2 * HOUR, saved: 0.75, spent: 0.2, calls: 2 },
        ] },
      }));
      await dash.open('dashboard');
      const wrap = page.locator('#sparkWrap');
      await expect(wrap.locator('svg.spark')).toBeVisible();
      // A shape with no scale is decoration that looks like evidence. Every one of these
      // was absent from the bare <path> this replaced.
      await expect(wrap.locator('svg.spark line.zero'), 'no zero baseline').toHaveCount(1);
      // allTextContents, not allInnerTexts: `innerText` is an HTMLElement property and is
      // undefined on an SVG <text> node, so the inner-text reader would return a list of
      // empty strings and every assertion below would pass or fail for the wrong reason.
      const labels = (await wrap.locator('svg.spark text').allTextContents())
        .map((s) => s.trim());
      expect(labels, `axis text was ${JSON.stringify(labels)}`).toContain('$2.50');
      expect(labels, `axis text was ${JSON.stringify(labels)}`).toContain('$0.00');
      // Two dated ends, in the reader's own timezone, plus the bucket width.
      expect(labels.filter((s) => /^[A-Z][a-z]{2} \d+, \d\d:\d\d$/.test(s)).length,
        `no dated axis labels; got ${JSON.stringify(labels)}`).toBe(2);
      await expect(wrap.locator('.spark-cap')).toHaveText(/Each point spans 1 hour\./);
      await expect(wrap.locator('.spark-cap')).toHaveText(/3 points/);
      expectClean(pageErrors, 'spark with axes');
    });

  test('two points is not a trend — the panel says so instead of drawing a shape',
    async ({ dash, page }) => {
      const t0 = Math.floor(seconds(4 * HOUR) / HOUR) * HOUR;
      await pushOnConnect(page, metrics({
        timeseries: { bucket_seconds: HOUR, points: [
          { t: t0, saved: 1, spent: 0.4, calls: 3 },
          { t: t0 + HOUR, saved: 2, spent: 0.6, calls: 5 },
        ] },
      }));
      await dash.open('dashboard');
      const wrap = page.locator('#sparkWrap');
      await expect(wrap.locator('svg.spark')).toHaveCount(0);
      await expect(wrap).toHaveText(/not enough to draw a trend/);
      await expect(wrap).toHaveText(/two points is a line, not a direction/);
      // …and the buckets it does have are still stated. Declining to draw is not a
      // licence to withhold the data.
      await expect(wrap).toHaveText(/\$1\.00 saved/);
      await expect(wrap).toHaveText(/\$2\.00 saved/);
    });
});

test.describe('item (c): the Monitor states the boundary of what it can observe', () => {
  test('the scope is stated whether or not the list has rows', async ({ dash, page }) => {
    await dash.open('monitor');
    const scope = page.locator('#sessionsScope');
    await expect(scope).toBeVisible();
    // A reader with two Claude Desktop threads open needs to be told those threads are
    // not eligible for this list, not left to conclude the panel is broken.
    // \s+ between words: this copy is wrapped for readability in the source, and
    // toHaveText compares textContent, which keeps the newline and the indentation a
    // browser collapses on screen.
    await expect(scope).toHaveText(/Claude\s+Desktop/);
    await expect(scope).toHaveText(/api\.anthropic\.com/);
    await expect(scope).toHaveText(/cannot\s+appear here/);
    // The line that makes a client visible, carrying THIS gateway's own address rather
    // than a documentation constant that would be wrong on a non-default port.
    const cmd = page.locator('#sessionsScope code.baseurl');
    await expect(cmd).toHaveText(new RegExp(
      '^export ANTHROPIC_BASE_URL=' + page.url().replace(/^(https?:\/\/[^/]+).*$/, '$1')
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
  });

  test('an empty session list says a direct client will never appear', async ({ dash, page }) => {
    // Served over a mocked /logs so the list is genuinely empty — the seeded store has
    // rows, and this is the state a fresh install is in.
    // A REGEX, not a glob: Playwright's URL globs give `?` its own meaning, so a literal
    // query string in a glob pattern does not match what it looks like it matches.
    await page.route(/\/logs\?limit=500/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
                      body: JSON.stringify({ rows: [] }) }));
    await dash.open('monitor');
    const sessions = page.locator('#sessions');
    await expect(sessions).toHaveText(/No chat has been routed through this gateway/);
    await expect(sessions).toHaveText(/cannot be listed here/);
    await expect(sessions).toHaveText(/export ANTHROPIC_BASE_URL=/);
    // The old wording invited a reader to wait for something that was never coming.
    await expect(sessions).not.toHaveText(/no sessions yet/i);
  });

  test('a row with no session id says what that means', async ({ dash, page }) => {
    const now = Math.floor(Date.now() / 1000);
    // A REGEX, not a glob: Playwright's URL globs give `?` its own meaning, so a literal
    // query string in a glob pattern does not match what it looks like it matches.
    await page.route(/\/logs\?limit=500/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        rows: [
          { session: '', source: 'testclient', ts: now - 104400, savings: 0, actual_cost: 0 },
          { session: '', source: 'testclient', ts: now - 104500, savings: 0, actual_cost: 0 },
        ],
      }) }));
    await dash.open('monitor');
    const sessions = page.locator('#sessions');
    // "(no session id)" stated a symptom and left the reader to guess the cause; the
    // guess is usually "the dashboard is broken".
    await expect(sessions).not.toHaveText(/\(no session id\)/);
    await expect(sessions).toHaveText(/client sent no session header/);
    // …and a list whose newest row is a day old says that nothing is live, rather than
    // leaving a grey dot to imply it.
    await expect(sessions).toHaveText(/Nothing is routing through the gateway right now/);
    await expect(sessions).toHaveText(/1d ago/);
  });
});
