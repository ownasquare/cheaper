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
//
// Being the only operation that deletes, it owes two guarantees the rest of the store
// does not:
//   * DURABILITY, not just atomicity. The sealed segment is fsynced, its rename is made
//     durable by an fsync of the DIRECTORY, and only then are the sources unlinked. The
//     read-back verification reads through the page cache, so without the file fsync it
//     proved the bytes were right in memory and then deleted the only other copy.
//   * A PER-INSTALL name, like every other segment. See segmentInstall() below.

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
  // The tombstone IS the deletion. `addTombstone` returns false when it did not reach the
  // disk — a state.json from a newer Cheaper, one this build cannot read, a lock it could
  // not take, or a failed write — and this command used to print "excluded from every
  // total" regardless. Telling a user their chat is gone when it is not is the same lie as
  // a total that quietly shrinks, aimed the other way, and it is the worse of the two
  // because they stop looking. Say what happened and exit non-zero.
  const written = store.addTombstone(t);
  if (!written) {
    const failed = Object.assign({ written: false, error: 'tombstone not persisted' }, t);
    if (json) { console.log(JSON.stringify(failed, null, 2)); process.exitCode = 1; return; }
    console.log('');
    console.log('  ' + c.red('cheaper forget: the tombstone was NOT written.'));
    console.log('  ' + c.dim(`Session ${session} is still counted in every total.`));
    console.log('  ' + c.dim('state.json in the events directory is unwritable, unreadable, locked by'));
    console.log('  ' + c.dim('another Cheaper, or written by a newer one. Nothing has been changed.'));
    console.log('');
    process.exitCode = 1;
    return;
  }
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
//
// THE DIGEST IS NECESSARY AND WAS NOT SUFFICIENT. It compares the sealed output against
// what compaction MANAGED TO READ, and every one of its three parts is symmetric under
// "we read nothing": count 0 == count 0, sha256('') == sha256(''), and six zero sums
// against six zero sums. So a month whose sources could not be parsed sealed to an empty
// file, verified clean, and was unlinked. `unaccountedWhy` and `unaccountedIds` below add
// the missing half — that what was read is everything there WAS — and only both together
// license a delete.
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

// Which install wrote a segment, read off its own name.
//
// `events.segmentPath` names every segment `<ym>.<install>.<writer>.jsonl`, which is
// events.js's structural choice #2: per-install names make a SYNCED HOME correct by
// construction, because two machines never write the same path. Compaction dropped that
// property — it sealed to `<ym>.sealed.jsonl.gz`, a name with no install in it, so two
// machines sharing a Dropbox/iCloud home compute the IDENTICAL target and each seals the
// other's live segments out from under it.
//
// (The failure is a lost race, not a "(conflicted copy)": sync clients insert their marker
// before the LAST extension, giving `2026-07.sealed.jsonl (conflicted copy).gz`, which
// fails events.js::listSegments' /\.jsonl\.gz$/i and is therefore never read at all —
// silently invisible rather than folded through dedupe.)
const SEGMENT_INSTALL = /^\d{4}-\d{2}\.([0-9a-f]{8})\./;

function segmentInstall(name) {
  const m = SEGMENT_INSTALL.exec(String(name || ''));
  return m ? m[1] : null;
}

// ---- "provably accounted for", which is the only licence to unlink ------------------
//
// THE DEFECT THIS CLOSES. `readSegment` returns a stats object — `unreadable`, `corrupt`,
// `partialTail`, `bad`, `futureSchema` — and compaction threw it away, keeping only the
// rows. Every one of those counters means the same thing to a DELETER: bytes exist in
// that file which did not become a row, so the sealed output cannot possibly represent
// them. With the stats discarded the failure was not merely unreported, it was
// SILENT AND DESTRUCTIVE, because every gate downstream is symmetric:
//
//   a source whose bytes cannot be read  ->  readSegment answers 0 rows
//   ->  fold([])                         ->  0 rows
//   ->  before = { count: 0, idsSha: sha256(''), sums: all zero }
//   ->  the sealed file is written EMPTY
//   ->  the read-back verify compares empty against empty and PASSES
//   ->  the sources are unlinked
//   ->  `sealed: [{ ym, events: 0 }]`, exit 0.
//
// The only copy of that month is gone and the tool reported success. The same collapse
// reaches the resume branch from the other side: a truncated sealed `.gz` also reads as
// zero rows, so `sameDigest(emptyBefore, emptySealed)` is TRUE and the sources are
// removed against a sealed file that inflates to nothing.
//
// So: nothing is unlinked unless EVERY BYTE of EVERY input turned into a row that entered
// the digest. Two independent ways that can fail, checked separately because they fail
// at different layers.
//
// (1) BYTES -> ROWS, per file. Each counter is a distinct real cause and each is named
//     rather than lumped, because the remedy differs: `unreadable` is a mode-bit or a
//     half-synced file; `corrupt` is a torn gzip; `partialTail` is a record cut mid-write
//     by a crash; `bad` is a line that is not JSON; `futureSchema` is a row written by a
//     NEWER Cheaper that this build refuses to parse — the single most dangerous one to
//     seal, because the rows are perfectly good and only THIS reader cannot see them.
function unaccountedWhy(st) {
  if (!st) return 'no read statistics were returned';
  if (st.unreadable) return 'its bytes could not be read at all';
  if (st.corrupt) return 'its gzip did not inflate';
  const bits = [];
  if (st.partialTail) bits.push('a torn trailing record');
  if (st.bad) bits.push(`${st.bad} unparseable line(s)`);
  if (st.futureSchema) bits.push(`${st.futureSchema} row(s) written by a NEWER Cheaper`);
  return bits.length ? bits.join(' and ') : null;
}

// Read a set of segments and report, per file, anything that did not become a row.
// `rows` is still returned in full so a caller can diagnose; it is the `unaccounted`
// list, not the row count, that decides whether anything may be deleted.
function readSources(files) {
  const rows = [];
  const unaccounted = [];
  for (const f of files) {
    const before = rows.length;
    const st = events.readSegment(f, (o) => rows.push(o));
    const why = unaccountedWhy(st);
    if (why) {
      unaccounted.push({ file: path.basename(f), why, rows: rows.length - before,
                         stats: st });
    }
  }
  return { rows, unaccounted };
}

// (2) ROWS -> SEALED ROWS. `fold` legitimately COLLAPSES duplicates — that is what
//     sealing is for, and a collapsed duplicate IS accounted for by its survivor. But
//     `fold` also QUARANTINES: a gateway row with no request id (case 5), two weak-key
//     rows disagreeing on `served` (case 4), the same strong key with output differing by
//     more than 2x (case 15). A quarantined row has NO survivor — nothing in the sealed
//     file represents it — and the digest is taken over the FOLDED rows, so the quarantine
//     cancels out of both sides of the comparison and the verify passes while the evidence
//     of the conflict is unlinked. Reporting is allowed to drop a row it cannot trust;
//     DELETING the only copy of it is not.
//
//     Compared on IDs, not on counts, so the message can name what went missing.
function unaccountedIds(inputRows, foldedRows) {
  const kept = new Set(foldedRows.map((r) => r.id));
  const missing = new Set();
  let noId = 0;
  for (const r of inputRows) {
    if (!r || !r.id) { noId++; continue; }
    if (!kept.has(r.id)) missing.add(r.id);
  }
  return { noId, missing: [...missing].sort() };
}

// Write `rows` to `outPath` durably and verify the round trip against `digest` BEFORE the
// name is published. Returns NULL on success, or a `result.errors` entry (minus its `ym`)
// describing what stopped it. It never unlinks a source — that stays with the caller, and
// only after this has returned null.
//
// The syscall ORDER is the durability guarantee and is asserted by compact.test.js:
//   write -> fsync the FILE -> rename -> fsync the DIRECTORY -> (caller) unlink.
function sealTo(dir, outPath, rows, digest) {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const tmp = outPath + '.tmp';
  // stdlib zlib — no dependency. Retention default is KEEP EVERYTHING: an audit log
  // that discards its evidence to save a few megabytes is not an audit log.
  //
  // DURABILITY, and why `writeFileSync` was not enough. It returns as soon as the
  // bytes are in the PAGE CACHE, and the read-back verify below reads them straight
  // back OUT of that cache — so it proved the bytes were correct in MEMORY, not on
  // disk, and the very next statements unlink the only other copy of them. On ext4
  // data=ordered the data blocks happen to flush ahead of the rename's metadata
  // transaction, which narrows the window; it does not close it, and this is the one
  // operation in the whole store that DELETES the source of what it just wrote.
  // So: write → fsync the FILE → rename → fsync the DIRECTORY (a rename publishes a
  // NAME, and the name lives in the directory) → only then unlink.
  const gz = zlib.gzipSync(Buffer.from(body, 'utf8'), { level: 9 });
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    let off = 0;
    while (off < gz.length) {
      // writeSync does not loop internally; a short write would truncate the segment
      // whose sources are about to be deleted. Retry the remainder, and refuse to go
      // on if it makes no progress rather than sealing a partial file.
      const n = fs.writeSync(fd, gz, off, gz.length - off);
      if (n <= 0) throw new Error('short write');
      off += n;
    }
    fs.fsyncSync(fd);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { why: 'write failed — sources left untouched',
             error: String((e && e.message) || e) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  // Read the new file BACK and re-verify before anything is unlinked.
  const check = [];
  let round;
  try {
    round = zlib.gunzipSync(fs.readFileSync(tmp)).toString('utf8');
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { why: 'the sealed segment could not be read back — sources left untouched',
             error: String((e && e.message) || e) };
  }
  for (const line of round.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { check.push(JSON.parse(t)); } catch { /* counted by the digest mismatch */ }
  }
  const after = verifyDigest(check);
  if (!sameDigest(digest, after)) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { why: 'verification failed — sources left untouched', before: digest, after };
  }
  fs.renameSync(tmp, outPath);
  store.fsyncDir(dir);                    // the NAME is durable before anything dies
  return null;
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
    const inst = events.installId();
    const byMonth = new Map();
    const foreign = new Map();
    for (const s of events.listSegments(dir)) {
      if (!s.ym || s.ym >= nowYm) continue;   // never touch the month still being written
      // A SEALED segment is an output, never a source. Folding it back in and re-sealing
      // it would put the same events through the digest twice.
      if (s.gz) continue;
      // Seal only what THIS install wrote. Another machine on a synced home may still be
      // appending to its own segment for a month that is finished in OUR clock, and a
      // segment whose name carries no install id cannot be proven to be ours at all.
      // Both are LEFT for their own install to seal — and both are reported, because a
      // segment silently never compacted is indistinguishable from one that was.
      if (segmentInstall(s.name) !== inst) {
        foreign.set(s.ym, (foreign.get(s.ym) || 0) + 1);
        continue;
      }
      if (!byMonth.has(s.ym)) byMonth.set(s.ym, []);
      byMonth.get(s.ym).push(s);
    }
    for (const [ym, n] of foreign) {
      result.skipped.push({ ym, segments: n,
        why: `${n} segment(s) not written by this install (${inst}) — left for theirs` });
    }
    for (const [ym, segs] of byMonth) {
      // The install id is part of the name, exactly as it is for a live segment.
      const outPath = path.join(dir, `${ym}.${inst}.sealed.jsonl.gz`);
      const hasSealed = fs.existsSync(outPath);

      // GATE 1 — every byte of every input became a row, or this month is not touched.
      // The stats used to be discarded here; see unaccountedWhy() for what that cost.
      //
      // AN EXISTING SEALED SEGMENT IS AN INPUT TO THIS DECISION, so it is held to the same
      // standard as the live sources and reported in the SAME entry. A truncated `.gz`
      // reads as zero rows, and zero rows compare equal to a source set that also read as
      // zero — which is how a corrupt seal and an unreadable source together unlinked a
      // month. Both files are named, because a reader who is told only about the source
      // will re-run compaction against the same broken seal.
      const src = readSources(segs.map((s) => s.file));
      const sealedRead = hasSealed ? readSources([outPath]) : { rows: [], unaccounted: [] };
      const unaccounted = src.unaccounted.concat(sealedRead.unaccounted);
      if (unaccounted.length) {
        result.errors.push({ ym, unaccounted,
          why: 'a segment for this month could not be fully accounted for — nothing '
             + 'sealed, nothing removed' });
        continue;
      }
      const raw = src.rows;
      const unlinkSources = () => {
        for (const s of segs) { try { fs.unlinkSync(s.file); } catch { /* ignore */ } }
        store.fsyncDir(dir);                  // …and so are the removals
      };

      if (hasSealed) {
        // The sealed file exists AND sources for its month are still here. Either a
        // previous run died between its rename and its unlinks — the window this
        // function's fsync ordering deliberately widens — or something wrote NEW events
        // into a month that was already sealed.
        const sealedRows = sealedRead.rows;
        const sealed = verifyDigest(sealedRows);

        // WHAT THE UNION IS FOR, and why this is no longer a permanent skip.
        //
        // It used to compare `fold(sources)` against the sealed file and, on any
        // disagreement, skip the month FOREVER with `why: '…do not fold to the same
        // events'`. That was wrong in both directions:
        //
        //   * a backfill that wrote NEW events into a sealed month could never be
        //     compacted again — the segments accumulated indefinitely and every later run
        //     printed the same line with no remedy a user could actually perform;
        //   * a crash partway through the unlink loop, which the comment above claims is
        //     the resumable case, left FEWER sources than the seal contains, so
        //     `sameDigest(before, sealed)` was false and even the interrupted compaction
        //     it was written to finish got stuck.
        //
        // Both are the same question — does the sealed file already account for
        // everything still on disk? — and it is answered by folding the sources and the
        // seal TOGETHER. `fold` is what every reader already applies to this exact
        // overlap, so the union is not a new interpretation of the data; it is the one
        // `readAll` produces. The union is a SUPERSET of the seal by construction, so
        // re-sealing can only ever add events, and the same digest + full-accounting
        // gates below still stand between it and any unlink.
        const both = raw.concat(sealedRows);
        const merged = fold(both).rows;
        const lost = unaccountedIds(both, merged);
        if (lost.noId || lost.missing.length) {
          result.errors.push({ ym, why: 'folding the sources with the existing sealed '
            + 'segment did not account for every event — nothing re-sealed, nothing '
            + 'removed', dropped_ids: lost.missing.slice(0, 12),
            dropped: lost.missing.length, rows_without_id: lost.noId });
          continue;
        }
        const union = verifyDigest(merged);
        if (sameDigest(union, sealed)) {
          // Nothing new: the seal already contains every event in the segments still
          // present. Finish the interrupted compaction.
          if (dry) {
            result.skipped.push({ ym, why: 'already sealed — sources verified against it, '
              + 'would remove them', dryRun: true });
            continue;
          }
          unlinkSources();
          result.skipped.push({ ym, why: 'already sealed — verified sources removed' });
          continue;
        }
        // The seal does NOT account for everything. Re-seal from the union. Loud on
        // purpose: a sealed month changing size is exactly the event a reader must be
        // able to see, so both digests travel with the entry and `resealed` is explicit.
        if (dry) {
          result.sealed.push({ ym, events: merged.length, resealed: true, dryRun: true,
            sealed_before: sealed, sealed_after: union });
          continue;
        }
        const reErr = sealTo(dir, outPath, merged, union);
        if (reErr) { result.errors.push(Object.assign({ ym }, reErr)); continue; }
        unlinkSources();
        result.sealed.push({ ym, events: merged.length, file: path.basename(outPath),
          resealed: true, sealed_before: sealed, sealed_after: union });
        continue;
      }

      const { rows } = fold(raw);
      // GATE 2 — the fold represented every source row. `fold` may collapse a duplicate
      // (its survivor accounts for it) but it may also QUARANTINE, and a quarantined row
      // has no survivor at all.
      const lost = unaccountedIds(raw, rows);
      if (lost.noId || lost.missing.length) {
        result.errors.push({ ym, why: 'the fold did not account for every source event — '
          + 'nothing sealed, nothing removed', dropped_ids: lost.missing.slice(0, 12),
          dropped: lost.missing.length, rows_without_id: lost.noId });
        continue;
      }
      const before = verifyDigest(rows);
      if (dry) { result.sealed.push({ ym, events: rows.length, dryRun: true }); continue; }
      const err = sealTo(dir, outPath, rows, before);
      if (err) { result.errors.push(Object.assign({ ym }, err)); continue; }
      unlinkSources();
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
    // A month that was ALREADY sealed and has now been sealed again is a change to a file
    // this tool otherwise treats as final. Never let that pass as an ordinary seal.
    if (s.resealed) {
      console.log('    ' + c.amber('re-sealed')
        + c.dim(` — the previous seal held ${s.sealed_before.count} event(s); folding it `)
        + c.dim(`with the segments still present gives ${s.sealed_after.count}.`));
    }
  }
  for (const s of result.skipped) console.log('  ' + c.dim(`· ${s.ym} skipped (${s.why})`));
  for (const e of result.errors) {
    console.log('  ' + c.red(`✗ ${e.ym} ${e.why}`));
    // NAME the file. "a source could not be accounted for" with no filename is a report
    // the user cannot act on, and this branch exists precisely because the alternative
    // was deleting it.
    for (const u of e.unaccounted || []) {
      console.log('    ' + c.red(`↳ ${u.file}`) + c.dim(` — ${u.why}`));
    }
    if (e.dropped) {
      console.log('    ' + c.red(`↳ ${e.dropped} event(s) had no place in the fold`)
        + c.dim(`: ${e.dropped_ids.join(', ')}${e.dropped > e.dropped_ids.length ? ', …' : ''}`));
    }
    if (e.rows_without_id) {
      console.log('    ' + c.red(`↳ ${e.rows_without_id} row(s) carry no id at all`));
    }
  }
  console.log('');
  console.log('  ' + c.dim('Raw events are kept forever, gzipped. Nothing was deleted until the'));
  console.log('  ' + c.dim('sealed segment matched the sources on count, all six token sums, and'));
  console.log('  ' + c.dim('a sorted-id SHA-256 — and until every byte of every source had'));
  console.log('  ' + c.dim('provably become one of the events inside it.'));
  console.log('');
}

module.exports = { forget, compact, verifyDigest, sameDigest, segmentInstall,
                   unaccountedWhy, unaccountedIds };
