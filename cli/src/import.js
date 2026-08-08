'use strict';
// `cheaper import --since <date> [--dry-run] [--harness <key>]`
//
// A DEDICATED walker, not the peek scanner. Five rules, each answering a specific way
// the obvious implementation gets history wrong:
//
// 1. **The timestamp is the event's own transcript time, never the import date.** That
//    is the entire answer to "how do you avoid a fake spike on import day": a spike is
//    impossible when `ts` is event time and the import moment lives only in
//    `ingested_at`, which nothing ever buckets on.
// 2. **A period before coverage reports `not covered`, never $0.** The importer writes a
//    `backfilled` coverage interval so the boundary is visible in every later report.
// 3. **Backfilled rows are permanently `estimated`.** They are transcript-only and the
//    gateway can never retro-join them — its rows from that era have no request id.
// 4. **Coverage is bounded by the scanner, not by the disk — so this does not use the
//    scanner.** `adapters.js` caps at 300 files and `fsutil` at 400, and `fsutil` filters
//    on **mtime**, not event time: a chat appended today drags month-old events into a
//    `--days 7` window while a 40-day-dormant file holding 35-day-old events is excluded.
//    Files over 32 MB are read tail-only. Import walks EVERY file with no cap.
// 5. **It is an explicit user action with a dry-run preview and a coverage diff.** A
//    lifetime figure that jumps by hundreds of dollars unprompted is indistinguishable
//    from a bug, and this product's entire value is that its numbers are trusted.

const fs = require('fs');
const path = require('path');
const { c } = require('./util');
const { HOME, expand, exists, fileIdentity } = require('./peek/fsutil');
const { HARNESSES } = require('./peek/adapters');
const events = require('./peek/events');
const store = require('./peek/store');
const { eventsFromRecords, assertPrivacySafe } = require('./peek/emit');

// Walk EVERY matching file under `root`. No maxFiles, no mtime filter — the two
// properties that make the peek scanner unfit for a backfill.
function walkAll(root, exts, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.git') || e.name === 'node_modules') continue;
      walkAll(full, exts, out, depth + 1);
      continue;
    }
    if (!exts.some((x) => e.name.toLowerCase().endsWith(x))) continue;
    try {
      const st = fs.statSync(full);
      out.push({ file: full, size: st.size, mtime: st.mtimeMs });
    } catch { /* unreadable — skip */ }
  }
  return out;
}

function historyRootFor(def) {
  if (def.key === 'claude-code') {
    return expand(process.env.CLAUDE_CONFIG_DIR
      ? process.env.CLAUDE_CONFIG_DIR + '/projects' : '~/.claude/projects');
  }
  if (def.key === 'codex') {
    return expand(process.env.CODEX_HOME ? process.env.CODEX_HOME + '/sessions' : '~/.codex/sessions');
  }
  return def.dir ? expand(def.dir) : null;
}

function parseArgs(argv) {
  const o = { since: null, dryRun: false, harness: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') o.since = argv[++i];
    else if (a === '--dry-run' || a === '-n') o.dryRun = true;
    else if (a === '--harness') o.harness = argv[++i];
    else if (a === '--json') o.json = true;
    else if (/^--since=/.test(a)) o.since = a.slice(8);
    else if (/^--harness=/.test(a)) o.harness = a.slice(10);
  }
  return o;
}

// Per-file record so a re-run is IDEMPOTENT and any gap is provable.
function fileLedgerKey(f) {
  const id = fileIdentity(f.file);
  return { sfile: id.sfile, sbase: id.sbase, size: f.size, mtime: Math.round(f.mtime) };
}

async function run(argv = []) {
  const o = parseArgs(argv);
  if (!o.since) {
    console.log('');
    console.log('  ' + c.red('cheaper import needs --since <YYYY-MM-DD>'));
    console.log('  ' + c.dim('It is deliberately explicit: a lifetime figure that jumps by hundreds'));
    console.log('  ' + c.dim('of dollars unprompted is indistinguishable from a bug.'));
    console.log('');
    console.log('  ' + c.bold('cheaper import --since 2026-07-01 --dry-run') + c.dim('   preview first'));
    console.log('  ' + c.bold('cheaper import --since 2026-07-01'));
    console.log('');
    process.exitCode = 1;
    return;
  }
  const sinceMs = Date.parse(o.since + 'T00:00:00');
  if (!Number.isFinite(sinceMs)) {
    console.log('  ' + c.red(`--since ${o.since} is not a date I can parse (want YYYY-MM-DD).`));
    process.exitCode = 1;
    return;
  }

  const state = store.loadState();
  if (state.tooNew) {
    console.log('  ' + c.red('This savings store was written by a newer Cheaper. Upgrade before importing.'));
    process.exitCode = 1;
    return;
  }
  // A state.json that EXISTS and cannot be read is refused for the same reason, one step
  // earlier: `ingested_files` is what makes a re-run a no-op and `tombstones` is what
  // keeps forgotten sessions out of every total, and neither can be honoured from a
  // document this build cannot parse. Importing anyway would append events past a
  // tombstone we cannot see and then overwrite the file that holds it.
  if (state.unreadable) {
    console.log('  ' + c.red(`This savings store's state.json could not be read (${state.unreadable}).`));
    console.log('  ' + c.dim('It holds the coverage intervals and the `cheaper forget` tombstones, so an'));
    console.log('  ' + c.dim('import would write past deletions it cannot see. Move that file aside first;'));
    console.log('  ' + c.dim('the events themselves are untouched.'));
    process.exitCode = 1;
    return;
  }
  const already = new Set((state.ingested_files || []).map((f) => `${f.sfile}:${f.size}:${f.mtime}`));

  const defs = HARNESSES.filter((d) => (!o.harness || d.key === o.harness) && d.status !== 'sqlite');
  if (o.harness && !defs.length) {
    console.log('  ' + c.red(`Unknown harness: ${o.harness}`));
    process.exitCode = 1;
    return;
  }

  const summary = { since: o.since, dryRun: o.dryRun, harnesses: [], totals: {
    filesSeen: 0, filesNew: 0, filesSkipped: 0, sessions: 0, events: 0, written: 0,
    earliest: null, latest: null } };

  const newFileRecords = [];

  for (const def of defs) {
    const root = historyRootFor(def);
    if (!root || !exists(root)) continue;
    const files = walkAll(root, ['.jsonl']);
    const h = { key: def.key, label: def.label, filesSeen: files.length,
                filesNew: 0, filesSkipped: 0, sessions: 0, events: 0, written: 0 };

    // Group by session so the frozen counterfactual is computed over the WHOLE chat
    // (main transcript + its sub-agent sidecars), exactly as the live tagline does.
    // Importing a sub-agent file alone would make that sub-agent its own baseline and
    // manufacture a saving out of nothing.
    const bySession = new Map();
    for (const f of files) {
      summary.totals.filesSeen++;
      const key = fileLedgerKey(f);
      if (already.has(`${key.sfile}:${key.size}:${key.mtime}`)) { h.filesSkipped++; summary.totals.filesSkipped++; continue; }
      h.filesNew++; summary.totals.filesNew++;
      newFileRecords.push(key);
      // <project>/<id>.jsonl and <project>/<id>/subagents/*.jsonl share the id.
      const stem = path.basename(f.file).replace(/\.jsonl?$/i, '');
      const parent = path.basename(path.dirname(f.file));
      const sid = /^agent-/.test(stem) ? parent : stem;
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid).push(f);
    }

    for (const [sid, group] of bySession) {
      let records = [];
      try {
        records = (def.collect
          ? def.collect({ transcript: group.map((g) => g.file) })
          : { records: [] }).records || [];
      } catch { records = []; }
      // Rule 1: keep only calls whose OWN event time is at/after --since. Filtering on
      // file mtime (what the scanner does) would both over- and under-include.
      records = records.filter((r) => Number(r.ts) >= sinceMs);
      if (!records.length) continue;
      h.sessions++; summary.totals.sessions++;

      const evs = eventsFromRecords(records, {
        harness: def.key, sessionId: sid, prov: 'transcript', writer: 'cli',
      }).map((e) => Object.assign(e, {
        // Rule 3: a backfilled row is PERMANENTLY estimated. The gateway can never
        // retro-join it — its rows from that era carry no request id.
        conf: 'estimated',
        backfilled: true,
      }));
      if (!evs.length) continue;
      const bad = assertPrivacySafe(evs, HOME);
      if (bad) {
        console.log('  ' + c.red('refusing to import — ' + bad));
        process.exitCode = 1;
        return;
      }
      h.events += evs.length; summary.totals.events += evs.length;
      // An UNDATED event may not poison the coverage extent. The guard used to be
      // `=== null`, so the first event with an undefined `ts` set both bounds to
      // `undefined`; after that `earliest === null` is permanently false and
      // `e.ts < undefined` is permanently false, so every later dated event was ignored
      // and store.addCoverage('backfilled', undefined, NaN) wrote an interval with null
      // on BOTH sides. reporting.coverage_label renders an absent bound as the EMPTY
      // STRING, so the report masthead then stated the extent as "(backfilled  → )".
      // Only a finite timestamp may move a bound.
      for (const e of evs) {
        if (!Number.isFinite(e.ts)) continue;
        if (summary.totals.earliest === null || e.ts < summary.totals.earliest) summary.totals.earliest = e.ts;
        if (summary.totals.latest === null || e.ts > summary.totals.latest) summary.totals.latest = e.ts;
      }
      if (!o.dryRun) {
        const res = events.append(evs, 'cli');
        h.written += res.written; summary.totals.written += res.written;
        // Rule: a legacy chat is DELETED the moment its session is backfilled per-call.
        // That deletion IS the reconciliation check — without it the same money is
        // counted once as a frozen chat and again as a set of calls.
        try { store.retireLegacyChat(sid); } catch { /* best effort */ }
      }
    }
    summary.harnesses.push(h);
  }

  // Rule 2 + 5: record the coverage the import actually established, and the per-file
  // ledger that makes a re-run a no-op.
  if (!o.dryRun && summary.totals.written > 0) {
    // …and if NO event carried a usable timestamp, no interval is declared at all. A
    // half- or un-bounded coverage interval is not a smaller claim than none, it is an
    // unreadable one.
    if (Number.isFinite(summary.totals.earliest) && Number.isFinite(summary.totals.latest)) {
      store.addCoverage('backfilled', summary.totals.earliest, summary.totals.latest + 1);
    }
    // `loadState() → mutate → saveState()` over the WHOLE document, unserialised, is the
    // interleaving that erases a tombstone: a `cheaper forget` landing between this read
    // and this write was silently dropped when the import put its own copy of the
    // document back. Same file, same hazard as addCoverage/addTombstone, so the same
    // lock — see store.js::mutateState.
    summary.ledgerWritten = store.mutateState((st) => {
      st.ingested_files = (st.ingested_files || []).concat(newFileRecords);
    });
  }

  if (o.json) { console.log(JSON.stringify(summary, null, 2)); return; }

  const d = (ms) => (ms == null ? '—' : new Date(ms).toISOString().slice(0, 10));
  console.log('');
  console.log('  ' + c.amber('cheaper import') + c.dim(o.dryRun ? '  — DRY RUN, nothing was written' : ''));
  console.log('  ' + c.dim(`since ${o.since}`));
  console.log('');
  for (const h of summary.harnesses) {
    if (!h.filesSeen) continue;
    console.log('  ' + c.bold(h.label.padEnd(16))
      + c.dim(`${h.filesSeen} files (${h.filesNew} new, ${h.filesSkipped} already imported) · `)
      + `${h.sessions} sessions · ${h.events} events`
      + (o.dryRun ? '' : c.green(` · ${h.written} written`)));
  }
  console.log('');
  console.log('  ' + c.bold('Coverage this import adds:  ') + d(summary.totals.earliest) + ' → ' + d(summary.totals.latest));
  console.log('  ' + c.dim('Backfilled rows are permanently marked ESTIMATED — the gateway cannot'));
  console.log('  ' + c.dim('retro-join them, so no measured figure will ever be claimed for them.'));
  // The events landed; the per-file ledger did not. Saying so is the difference between a
  // known, harmless re-read and a user who is told "already imported" about files that
  // were never recorded as imported. No money moves either way — every event carries an
  // idempotent key and the fold dedupes a re-import — but the claim has to match the disk.
  if (summary.ledgerWritten === false) {
    console.log('');
    console.log('  ' + c.red('The per-file import ledger could not be written to state.json.'));
    console.log('  ' + c.dim('The events themselves ARE written. A re-run will re-read these files and'));
    console.log('  ' + c.dim('report them as new; dedupe means nothing is counted twice.'));
  }
  if (o.dryRun) {
    console.log('');
    console.log('  ' + c.dim('Run it for real:  ') + c.bold(`cheaper import --since ${o.since}`));
  } else {
    console.log('');
    console.log('  ' + c.dim('See it:  ') + c.bold('cheaper savings'));
  }
  console.log('');
}

module.exports = { run, walkAll, parseArgs };
