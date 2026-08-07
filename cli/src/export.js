'use strict';
// `cheaper export --format csv|tsv|json|ndjson [--out FILE]`
//
// Streams `/api/v1/export` straight to a file. It deliberately does NOT compute its own
// dollars: the moment a second surface derives the same figure independently it is free
// to disagree with the dashboard, and "the export doesn't match the table" is the one
// failure this whole audit surface cannot survive.
//
// Guard modes, stated plainly in the file's own header:
//   safe (default) a non-numeric cell beginning = + - @ | % gets a leading apostrophe,
//                  because Excel/LibreOffice/Sheets EVALUATE such a cell on open and
//                  `reason`, `source` and model ids are adversary-influenceable. This
//                  makes CSV/TSV NOT byte-reversible.
//   raw            byte-exact and lossless; unsafe to double-click open.
// JSON/NDJSON are always lossless.

const fs = require('fs');
const path = require('path');
const { c } = require('./util');
const api = require('./api');

const FORMATS = ['csv', 'tsv', 'json', 'ndjson'];

function parseArgs(argv) {
  const o = { format: 'csv', out: null, from: null, to: null, tz: null,
              basis: null, session: null, guard: 'safe', preamble: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') o.format = String(argv[++i] || '').toLowerCase();
    else if (a === '--out' || a === '-o') o.out = argv[++i];
    else if (a === '--from') o.from = argv[++i];
    else if (a === '--to') o.to = argv[++i];
    else if (a === '--tz') o.tz = argv[++i];
    else if (a === '--basis') o.basis = argv[++i];
    else if (a === '--session') o.session = argv[++i];
    else if (a === '--guard') o.guard = String(argv[++i] || 'safe').toLowerCase();
    else if (a === '--no-preamble') o.preamble = 0;
  }
  return o;
}

async function run(argv = []) {
  const o = parseArgs(argv);
  if (!FORMATS.includes(o.format)) {
    console.log('  ' + c.red(`--format must be one of: ${FORMATS.join(', ')}`));
    process.exitCode = 1;
    return;
  }
  if (!['safe', 'raw'].includes(o.guard)) {
    console.log('  ' + c.red('--guard must be `safe` (default) or `raw`'));
    process.exitCode = 1;
    return;
  }

  // The export is served BY THE GATEWAY, so it must be up. `ensureGatewayUp` starts it
  // if needed and health-gates it — the same lifecycle every other consumer uses.
  const ok = await require('./launch').ensureGatewayUp();
  if (!ok) { process.exitCode = 1; return; }

  const qs = api.qs({ format: o.format, from: o.from, to: o.to, tz: o.tz,
                      basis: o.basis, session: o.session, guard: o.guard,
                      preamble: o.preamble });
  let out = null;
  let bytes = 0;
  if (o.out) {
    const abs = path.resolve(o.out);
    // 0600: this file is a complete per-call record of the user's AI usage.
    out = fs.openSync(abs, 'w', 0o600);
  }
  const res = await api.getStream('/api/v1/export' + qs, (chunk) => {
    bytes += chunk.length;
    if (out !== null) fs.writeSync(out, chunk);
    else process.stdout.write(chunk);
  });
  if (out !== null) { try { fs.closeSync(out); } catch { /* ignore */ } }

  if (!res.ok) {
    console.error('  ' + c.red('export failed: ') + api.explain(res));
    process.exitCode = 1;
    return;
  }
  if (o.out) {
    console.log('');
    console.log('  ' + c.green('✓') + ` wrote ${path.resolve(o.out)} (${bytes.toLocaleString('en-US')} bytes)`);
    if (o.format !== 'json' && o.format !== 'ndjson' && o.guard === 'safe') {
      console.log('  ' + c.dim('guard=safe — non-numeric cells starting = + - @ | % carry a leading'));
      console.log('  ' + c.dim('apostrophe so a double-clicked file cannot execute a formula. That makes'));
      console.log('  ' + c.dim('this copy NOT byte-reversible; for a lossless one re-run with'));
      console.log('  ' + c.dim('  --format json   or   --guard raw'));
    }
    console.log('');
  }
}

module.exports = { run, parseArgs, FORMATS };
