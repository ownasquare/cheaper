'use strict';
// The same-machine gateway token, from the CLI's side.
//
// The gateway mints 32 random bytes into ~/.cheaper/dash.token (0600) and requires it
// on every route that discloses usage data — /metrics, /peek, /logs, /report, /api/**
// and /dashboard itself. /healthz stays open so freshness checks keep working.
//
// Every legitimate opener reads the same file: `cheaper dashboard`, `cheaper monitor`,
// the end-of-chat tagline's gateway probe, and the desktop shell. Nothing else on the
// machine can, which is the whole point — loopback is not a trust boundary when other
// user accounts and other processes share the host.
//
// Read FRESH on every use, never cached across a process's lifetime: the gateway may
// mint the token after this CLI process started (first `cheaper dashboard` on a clean
// machine does exactly that), and a cached empty string would 401 forever.

const fs = require('fs');
const os = require('os');
const path = require('path');

function tokenPath() {
  return process.env.CHEAPER_TOKEN_FILE
    || path.join(os.homedir(), '.cheaper', 'dash.token');
}

// The secret, or '' when there is none yet. Never throws — a missing token must
// degrade to an un-tokened request (which the gateway answers when it also could not
// mint one) rather than crash a user-facing command.
function readToken() {
  try {
    const t = fs.readFileSync(tokenPath(), 'utf8').trim();
    return /^[0-9a-f]{16,256}$/.test(t) ? t : '';
  } catch { return ''; }
}

// Append ?token=… to a URL, preserving any existing query string AND fragment.
// The fragment matters: `cheaper logs` opens /dashboard#logs, and a naive
// `url + '?token=' + t` would produce `/dashboard#logs?token=…`, where the token
// becomes part of the fragment and is never sent to the server.
function withToken(url, tok) {
  const t = tok === undefined ? readToken() : tok;
  if (!t) return url;
  const s = String(url);
  const hashAt = s.indexOf('#');
  const base = hashAt >= 0 ? s.slice(0, hashAt) : s;
  const frag = hashAt >= 0 ? s.slice(hashAt) : '';
  const sep = base.includes('?') ? '&' : '?';
  return base + sep + 'token=' + encodeURIComponent(t) + frag;
}

// Header form, for programmatic fetches where a query string would end up in a log.
function tokenHeaders(extra) {
  const t = readToken();
  const h = Object.assign({}, extra || {});
  if (t) h['x-cheaper-token'] = t;
  return h;
}

module.exports = { tokenPath, readToken, withToken, tokenHeaders };
