'use strict';
// One authenticated HTTP client for every CLI → gateway call.
//
// Three properties every caller needs and nobody should re-implement:
//   1. the same-machine token is attached as a HEADER (never a query string, so it
//      cannot end up in a shell history, a proxy log, or a screenshot of a URL bar);
//   2. failures resolve to a typed result instead of throwing, because these run
//      inside user-facing commands and inside the end-of-chat hook, where an
//      unhandled rejection would eat the user's closing line;
//   3. a hard response-size ceiling, so a pathological /api/v1/logs?limit=… can't
//      balloon the CLI's memory.
//
// It talks to 127.0.0.1 explicitly rather than `localhost`: on a dual-stack box
// `localhost` can resolve to ::1 first while uvicorn bound only 127.0.0.1, which
// surfaces as an intermittent ECONNREFUSED that looks like a dead gateway.

const http = require('http');
const { tokenHeaders } = require('./token');

const MAX_BYTES = 64 * 1024 * 1024;

function port() { return process.env.CHEAPER_PORT || '8787'; }
function base() { return `http://localhost:${port()}`; }

// GET `path` and parse JSON. Resolves { ok, status, body, error } — never rejects.
function getJson(path, opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = http.get({
        host: '127.0.0.1', port: port(), path,
        headers: tokenHeaders({ accept: 'application/json' }),
        timeout: opts.timeoutMs || 5000,
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          data += d;
          if (data.length > MAX_BYTES) { req.destroy(); finish({ ok: false, status: res.statusCode, error: 'response too large' }); }
        });
        res.on('end', () => {
          if (res.statusCode === 401) {
            return finish({ ok: false, status: 401, error: 'unauthorized' });
          }
          if (res.statusCode !== 200) {
            return finish({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}` });
          }
          try { finish({ ok: true, status: 200, body: JSON.parse(data) }); }
          catch (e) { finish({ ok: false, status: 200, error: 'invalid JSON: ' + (e && e.message) }); }
        });
      });
    } catch (e) { return finish({ ok: false, status: 0, error: String((e && e.message) || e) }); }
    req.on('error', (e) => finish({ ok: false, status: 0, error: String((e && e.code) || e.message || e) }));
    req.on('timeout', () => { req.destroy(); finish({ ok: false, status: 0, error: 'timeout' }); });
  });
}

// GET `path` and stream the raw bytes to `onChunk`. Used by `cheaper export`, which
// must not materialise a multi-hundred-MB CSV in memory just to write it to a file.
function getStream(path, onChunk, opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = http.get({
        host: '127.0.0.1', port: port(), path,
        headers: tokenHeaders({}),
        timeout: opts.timeoutMs || 120000,
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return finish({ ok: false, status: res.statusCode,
            error: res.statusCode === 401 ? 'unauthorized' : `HTTP ${res.statusCode}` });
        }
        res.on('data', (chunk) => { try { onChunk(chunk); } catch (e) { req.destroy(); finish({ ok: false, status: 200, error: String(e && e.message) }); } });
        res.on('end', () => finish({ ok: true, status: 200, headers: res.headers }));
      });
    } catch (e) { return finish({ ok: false, status: 0, error: String((e && e.message) || e) }); }
    req.on('error', (e) => finish({ ok: false, status: 0, error: String((e && e.code) || e.message || e) }));
    req.on('timeout', () => { req.destroy(); finish({ ok: false, status: 0, error: 'timeout' }); });
  });
}

// The one place that turns a failed gateway call into words a user can act on.
// Distinguishing 401 from "not running" matters: the remedies are different and
// "cheaper gateway start" on an already-running gateway teaches people the message
// is noise.
function explain(res) {
  if (!res || res.ok) return '';
  if (res.status === 401) {
    return 'the gateway rejected this request (missing or stale ~/.cheaper/dash.token). '
      + 'Fix with: cheaper gateway restart';
  }
  if (res.status === 0) {
    return `the gateway isn't answering on port ${port()}. Start it with: cheaper gateway start`;
  }
  return res.error || `HTTP ${res.status}`;
}

// Build a query string from a plain object, dropping null/undefined/'' values so a
// filter the user did not set never reaches the server as an empty-string filter
// (which the API treats as a REAL value — an empty session id is a real session).
function qs(params) {
  const parts = [];
  for (const k of Object.keys(params || {})) {
    const v = params[k];
    if (v === null || v === undefined || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

module.exports = { getJson, getStream, explain, qs, base, port };
