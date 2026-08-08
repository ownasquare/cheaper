'use strict';
// Minimal stand-in for api.anthropic.com, started ONLY as a second Playwright `webServer`
// (see playwright.config.js) so the injection-boundary test in security.spec.js can
// exercise a REAL POST /v1/messages instead of one that can never complete.
//
// Before this file existed, `webServer.env.ANTHROPIC_UPSTREAM_URL` pointed at
// 127.0.0.1:9 — a closed port, on purpose, because the comment there said "no test
// posts to /v1/messages". security.spec.js's "an adversarial model id renders as TEXT,
// never as markup" test broke that promise: it POSTs to /v1/messages with a payload
// crafted to reach the Logs table. Against a closed port, `_client.post()` in
// cli/assets/gateway/app/app.py::_forward() raises a connection error BEFORE
// `on_complete()` (== METRICS.record) ever runs, so no row is written. The test then
// opened an EMPTY Logs table and asserted the (absent) XSS payload was absent from it —
// passing regardless of whether the client-side esc() calls in dashboard.html were
// present, removed, or broken. See security.spec.js:146-159 and its regression-proof
// comment for how that was confirmed and fixed.
//
// This server exists to close that hole: it answers every POST with just enough of a
// real Anthropic response shape (an `id` and a `usage` object) that the gateway's usage
// sniffer in `_forward()` has something to record, so `messages()` calls `_record()`
// and a row lands in the store before the test ever loads the dashboard. It does not
// emulate streaming, auth, error codes, or any other endpoint — the gateway itself is
// what is under test, not this stub.
const http = require('http');

const PORT = Number(process.env.MOCK_ANTHROPIC_PORT || 8798);

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  // The body is drained but not parsed: the gateway already applied its own model
  // substitution (router.decide()) before this request left the process, and nothing
  // this stub returns needs to reflect the caller's payload back.
  req.resume();
  req.on('end', () => {
    res.writeHead(200, {
      'content-type': 'application/json',
      // _request_id() in app.py reads this header; giving it a value exercises the
      // same code path a real upstream response would.
      'anthropic-request-id': 'mock-req-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    });
    res.end(JSON.stringify({
      id: 'msg_mock_' + Date.now(),
      type: 'message',
      role: 'assistant',
      model: 'mock-upstream-model',
      content: [{ type: 'text', text: 'mock response — this server is a Playwright test fixture' }],
      stop_reason: 'end_turn',
      // Small, fixed counts: nothing in the injection-boundary test reads these values,
      // it only needs `usage_source` to become "body" so `_record()` fires with a real
      // (not connection-refused) result.
      usage: { input_tokens: 3, output_tokens: 2 },
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  // Playwright's webServer readiness check polls the `port` option for this entry
  // (see playwright.config.js); this line is for a human reading `stdout: 'pipe'` logs.
  process.stdout.write(`mock-anthropic-upstream listening on 127.0.0.1:${PORT}\n`);
});
