'use strict';
// `cheaper forget --session <id>` and `cheaper compact`.
//
// FORGET writes a TOMBSTONE rather than rewriting history in place. Totals then visibly
// drop WITH A STATED REASON instead of silently, and any export covering that window
// prints the tombstone or refuses. A savings figure that quietly shrinks is
// indistinguishable from a bug, and an audit log whose subject can edit it without
// leaving a mark is not an audit log.
//
// COMPACT has a NAMED OWNER and runs only from an explicit invocation. It must never be
// lazily triggered from a CLI run, because the Stop hook is by far the most frequent
// invocation and it SIGTERMs its child at 12s — landing mid-compaction on the one
// operation that can destroy data. It refuses outright under CHEAPER_FROM_HOOK=1.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { c } = require('./util');
const events = require('./peek/events');
const store = require('./peek/store');
const { fold } = require('./peek/reconcile');
const { deriveRow } = require('./peek/derive');

// ---- forget -------------------------------------------------------------------

function forget(argv = []) {
  let session = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') session = argv[++i];
    else if (/^--session=/.test(argv[i])) session = argv[i].slice(10);
    else if (argv[i] === '--json') json = true;
  }
  if (!session) {
    console.log('');
    console.log('  ' + c.red('cheaper forget needs --session <id>'));
    console.log('  ' + c.dim('Find one with:  ') + c.bold('cheaper logs --json'));
    console.log('');
    process.exitCode = 1;
    return;
  }
  const { rows } = store.readRows({});
  const hit = rows.filter((r) => r.sess === session
    || (Array.isArray(r.sessions) && r.sessions.includes(session)));
  if (!hit.length) {
    console.log('  ' + c.dim(`No events found for session ${session}. Nothing to forget.`));
    return;
  }
  let usd = 0;
  let tokens = 0;
  let from = Infinity;
  let to = -Infinity;
  for (const r of hit) {
    const d = deriveRow(r);
    if (d.priceable && Number.isFinite(d.delta)) usd += d.delta;
    tokens += d.tokens;
    if (r.ts < from) from = r.ts;
    if (r.ts > to) to = r.ts;
  }
  const t = { kind: 'tombstone', session, events_removed: hit.length,
              usd_removed: Math.round(usd * 1e6) / 1e6, tokens_removed: tokens,
              from, to: to + 1, at: Date.now() };
  store.addTombstone(t);
  try { store.retireLegacyChat(session); } catch { /* best effort */ }

  if (json) { console.log(JSON.stringify(t, null, 2)); return; }
  console.log('');
  console.log('  ' + c.amber('cheaper forget') + c.dim(`  — session ${session}`));
  console.log('');
  console.log(`  ${hit.length} event(s) excluded from every total.`);
  console.log('  ' + c.dim(`They covered ${new Date(from).toISOString().slice(0, 10)} → `
    + `${new Date(to).toISOString().slice(0, 10)} and contributed `
    + `${usd < 0 ? '-' : ''}$${Math.abs(usd).toFixed(4)} and ${tokens.toLocaleString('en-US')} tokens.`));
  console.log('');
  console.log('  ' + c.dim('The raw events stay on disk; a TOMBSTONE now excludes them, so any'));
  console.log('  ' + c.dim('report or export covering this window states the deletion instead of'));
  console.log('  ' + c.dim('quietly showing a smaller number.'));
  console.log('');
}

// ---- compact ------------------------------------------------------------------

// Seal a finished month: merge its per-writer segments, dedupe, and gzip.
//
// Nothing is unlinked until the new segment's DEDUPED EVENT COUNT, its SIX TOKEN SUMS
// and a SORTED-ID-SET SHA-256 have all been verified against the source. Compaction is
// the only operation here that can destroy data, so it verifies before it deletes
// rather than after.
function verifyDigest(rows) {
  const h = crypto.createHash('sha256');
  for (const id of rows.map((r) => r.id).sort()) { h.update(id); h.update('\0'); }
  const sums = { in: 0, out: 0, cr: 0, c5: 0, c1: 0, cu: 0 };
  for (const r of rows) for (const k of Object.keys(sums)) sums[k] += Number(r[k]) || 0;
  return { count: rows.length, idsSha: h.digest('hex'), sums };
}

function sameDigest(a, b) {
  if (a.count !== b.count || a.idsSha !== b.idsSha) return false;
  for (const k of Object.keys(a.sums)) if (a.sums[k] !== b.sums[k]) return false;
  return true;
}

function compact(argv = []) {
  const json = argv.includes('--json');
  const dry = argv.includes('--dry-run') || argv.includes('-n');
  // A hook invocation must never reach this. stop-tagline.js kills its child at 12s;
  // being SIGTERMed mid-compaction is the single worst moment in the whole store.
  if (process.env.CHEAPER_FROM_HOOK === '1') {
    console.error('cheaper compact: refusing to run from a hook (CHEAPER_FROM_HOOK=1).');
    process.exitCode = 1;
    return;
  }
  const dir = events.eventsDir();
  const lock = path.join(dir, '.compact.lock');
  let lockFd = null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    lockFd = fs.openSync(lock, 'wx');       // O_EXCL — a second compactor fails fast
    fs.writeSync(lockFd, String(process.pid));
  } catch {
    console.error('cheaper compact: another compaction holds .compact.lock.');
    process.exitCode = 1;
    return;
  }

  const result = { sealed: [], skipped: [], errors: [] };
  try {
    const nowYm = new Date().toISOString().slice(0, 7);
    const byMonth = new Map();
    for (const s of events.listSegments(dir)) {
      if (!s.ym || s.ym >= nowYm) continue;   // never touch the month still being written
      if (!byMonth.has(s.ym)) byMonth.set(s.ym, []);
      byMonth.get(s.ym).push(s);
    }
    for (const [ym, segs] of byMonth) {
      const raw = [];
      for (const s of segs) events.readSegment(s.file, (o) => raw.push(o));
      const { rows } = fold(raw);
      const before = verifyDigest(rows);
      const outPath = path.join(dir, `${ym}.sealed.jsonl.gz`);
      if (fs.existsSync(outPath)) { result.skipped.push({ ym, why: 'already sealed' }); continue; }
      if (dry) { result.sealed.push({ ym, events: rows.length, dryRun: true }); continue; }
      const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      const tmp = outPath + '.tmp';
      // stdlib zlib — no dependency. Retention default is KEEP EVERYTHING: an audit log
      // that discards its evidence to save a few megabytes is not an audit log.
      fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(body, 'utf8'), { level: 9 }), { mode: 0o600 });
      // Read the new file BACK and re-verify before anything is unlinked.
      const check = [];
      const round = zlib.gunzipSync(fs.readFileSync(tmp)).toString('utf8');
      for (const line of round.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { check.push(JSON.parse(t)); } catch { /* counted by the digest mismatch */ }
      }
      const after = verifyDigest(check);
      if (!sameDigest(before, after)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        result.errors.push({ ym, why: 'verification failed — sources left untouched',
                             before, after });
        continue;
      }
      fs.renameSync(tmp, outPath);
      for (const s of segs) { try { fs.unlinkSync(s.file); } catch { /* ignore */ } }
      result.sealed.push({ ym, events: rows.length, file: path.basename(outPath) });
    }
  } finally {
    try { if (lockFd !== null) fs.closeSync(lockFd); } catch { /* ignore */ }
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }

  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log('');
  console.log('  ' + c.amber('cheaper compact') + (dry ? c.dim('  — DRY RUN') : ''));
  console.log('');
  if (!result.sealed.length && !result.errors.length) {
    console.log('  ' + c.dim('Nothing to seal — only finished months are compacted.'));
  }
  for (const s of result.sealed) {
    console.log('  ' + c.green('✓') + ` ${s.ym}  ${s.events} events` + (s.dryRun ? c.dim(' (dry run)') : ` → ${s.file}`));
  }
  for (const s of result.skipped) console.log('  ' + c.dim(`· ${s.ym} skipped (${s.why})`));
  for (const e of result.errors) console.log('  ' + c.red(`✗ ${e.ym} ${e.why}`));
  console.log('');
  console.log('  ' + c.dim('Raw events are kept forever, gzipped. Nothing was deleted until the'));
  console.log('  ' + c.dim('sealed segment matched the sources on count, all six token sums, and'));
  console.log('  ' + c.dim('a sorted-id SHA-256.'));
  console.log('');
}

module.exports = { forget, compact, verifyDigest, sameDigest };
