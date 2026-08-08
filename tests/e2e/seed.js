'use strict';
// Build a deterministic, fully isolated sandbox for the Playwright suite.
//
// NOTHING here touches the developer's real ~/.cheaper. Every store the gateway reads
// is redirected by env var, and the whole tree is rebuilt from scratch on each run so a
// screenshot comparison can never drift because yesterday's data is still present.
//
// The seed is chosen to exercise the cases that are easy to get WRONG, not just the
// happy path:
//   * events in four different ladder windows, so the disjoint partition is visible
//   * a promo-window claude-sonnet-5 row dated 2026-08-31 23:30 -07:00
//   * an UNPRICEABLE served model — must render an em dash, never $0.00
//   * a non-2xx row — recorded, never priced
//   * a NEGATIVE delta (fable-5 served against an opus-5 baseline)
//   * both measurement bases present, so the two-column treatment has something to show
//   * a legacy chat-grain row, so the third visual state renders

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
// Resolve symlinks once, at load. Two names for the same checkout must hash to the same
// sandbox, and the "is this path inside the repo?" guard below must not be defeatable by
// reaching the repo through a symlink.
const REPO_REAL = (() => {
  try { return fs.realpathSync(REPO); } catch { return REPO; }
})();

// ---------------------------------------------------------------------------------
// WHERE THE DATA SANDBOX LIVES, AND WHY EVERY STEP OF PICKING THAT PATH IS GUARDED
// ---------------------------------------------------------------------------------
// The data sandbox (auth token + metrics DB + event store) lives OUTSIDE the repo, in
// the OS temp directory — not under REPO. A stray `git clean -fdx`, a deploy automation
// walking the repo tree, or an over-broad rm in a script must not be able to reach it.
// (Test ARTIFACTS and the HTML report are a different thing: a human opens those after a
// run, so they stay under the repo, gitignored — see playwright.config.js `outputDir`
// and the html reporter's `outputFolder`. Only the DATA sandbox moves here.)
//
// Three things make that safe, and none of them is optional:
//
//  1. The name is namespaced by OS user AND by CHECKOUT. The user segment stops two
//     accounts on a shared machine from squatting on each other. The checkout segment is
//     the one that actually matters day to day: this repo deliberately runs concurrent
//     agents in git worktrees, and a run that is live in /clone-a must not be wiped by a
//     second invocation in /clone-b. `CHEAPER_E2E_SEEDED` cannot help there — it is an
//     env var inherited only inside ONE process tree, so a second `npx playwright test`
//     (even a bare `--list`) starts with it unset and would re-seed, i.e. recursively
//     delete the live run's metrics.db, dash.token, event store and seed.json mid-run.
//     Both segments are module-level constants so the path stays identical across the
//     config re-evaluation Playwright does in every worker process.
//
//  2. os.tmpdir() is CALLER-CONTROLLED (it returns $TMPDIR, then $TMP, $TEMP, then /tmp,
//     verbatim). A guard that recomputes its "is this under the temp dir?" bound from the
//     same value proves nothing: with TMPDIR=$HOME the sandbox becomes a directory in the
//     user's home and the check still passes; with TMPDIR=. it resolves back INSIDE the
//     repo, reinstating the exact exposure this layout exists to remove. So the temp root
//     is validated against facts that do NOT come from TMPDIR (the repo path, the home
//     directory, absoluteness) and a rejected value falls back to the platform default.
//
//  3. The root is created FAIL-CLOSED. `mkdirSync(p, {recursive:true, mode:0o700})` on a
//     directory that already exists silently leaves its mode alone, so on a Linux/CI
//     world-writable sticky /tmp another local user can pre-create the sandbox 0777 (or
//     as a symlink), have our delete fail with EPERM, and then read the dashboard token
//     we write into it — or redirect our writes entirely. So: the wipe is loud, the
//     mkdir is non-recursive (EEXIST throws), and the result is lstat-verified to be a
//     real directory owned by us with mode exactly 0700.
const SANDBOX_OWNER = (() => {
  try {
    const info = os.userInfo();
    // Prefer the numeric uid where the platform has one (POSIX); fall back to username
    // (e.g. Windows, or a sandboxed uid of -1) so the segment is never empty or generic.
    if (Number.isInteger(info.uid) && info.uid >= 0) return String(info.uid);
    if (info.username) return info.username.replace(/[^a-zA-Z0-9_.-]/g, '_');
  } catch { /* fall through */ }
  return 'unknown';
})();
// Short, stable, collision-resistant id for THIS checkout. Two worktrees of the same repo
// have different __dirname values and therefore different sandboxes.
const CHECKOUT_ID = crypto.createHash('sha256').update(REPO_REAL).digest('hex').slice(0, 12);
const SANDBOX_BASENAME = `cheaper-e2e-${SANDBOX_OWNER}-${CHECKOUT_ID}`;

// `path.relative` says nothing useful about containment on its own — turn it into one.
function isInside(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(parent, child);
  if (rel === '' || path.isAbsolute(rel)) return false;
  return !rel.split(path.sep).includes('..');
}

// Home, in every spelling we can cheaply obtain, so a check against it cannot be dodged
// by handing us the symlinked form.
const HOME_PATHS = (() => {
  const out = [];
  let h;
  try { h = os.homedir(); } catch { h = null; }
  if (h && path.isAbsolute(h)) {
    const resolved = path.resolve(h);
    if (resolved !== path.parse(resolved).root) out.push(resolved);
    try {
      const real = fs.realpathSync(resolved);
      if (real !== path.parse(real).root && !out.includes(real)) out.push(real);
    } catch { /* home may not resolve in an exotic sandbox; the literal form still counts */ }
  }
  return out;
})();

function platformDefaultTempRoot() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || process.env.SystemRoot || process.env.windir;
    return base ? path.join(base, 'Temp') : null;
  }
  return '/tmp';
}

// Returns null when `root` is an acceptable temp root, else a human-readable reason.
// Every rejection reason here is derived from something OTHER than TMPDIR.
function tempRootProblem(root) {
  if (typeof root !== 'string' || !root) return 'empty';
  if (!path.isAbsolute(root)) return `not an absolute path: ${JSON.stringify(root)}`;
  const resolved = path.resolve(root);
  let real;
  try { real = fs.realpathSync(resolved); } catch (e) { return `does not resolve (${e.code || e.message})`; }
  if (real === path.parse(real).root) return 'is the filesystem root';
  for (const home of HOME_PATHS) {
    if (real === home) return `is the home directory (${home})`;
  }
  if (real === REPO_REAL) return 'is the repo checkout itself';
  if (isInside(REPO_REAL, real)) return `is inside the repo checkout (${REPO_REAL})`;
  let st;
  try { st = fs.lstatSync(real); } catch (e) { return `cannot be stat'd (${e.code || e.message})`; }
  if (!st.isDirectory()) return 'is not a directory';
  return null;
}

const TMP_ROOT = (() => {
  const tried = [];
  const candidates = [];
  try { candidates.push(os.tmpdir()); } catch { /* os.tmpdir() should not throw, but do not die here */ }
  const fallback = platformDefaultTempRoot();
  if (fallback) candidates.push(fallback);
  for (const cand of candidates) {
    const problem = tempRootProblem(cand);
    if (!problem) {
      if (tried.length) {
        // Loud on purpose: silently relocating the sandbox is how a hostile TMPDIR turns
        // into "the tests passed but wrote somewhere nobody expected".
        console.warn(`[e2e seed] rejected temp root ${tried.join('; ')} — using ${cand} instead`);
      }
      return fs.realpathSync(path.resolve(cand));
    }
    tried.push(`${JSON.stringify(cand)} (${problem})`);
  }
  throw new Error(
    'e2e sandbox: no usable OS temp root. Rejected: ' + (tried.join('; ') || '<none offered>'));
})();

const SANDBOX = path.join(TMP_ROOT, SANDBOX_BASENAME);
// The run lock deliberately sits BESIDE the sandbox, not inside it: it has to survive the
// recursive wipe it is guarding, and it has to be creatable atomically before the wipe.
const LOCK_PATH = SANDBOX + '.lock';
const SEED_INFO_PATH = path.join(SANDBOX, 'seed.json');

// The seeder deletes SANDBOX recursively on every run. A recursive delete driven by a
// computed path is the single most dangerous line in this file, so the target is proved
// safe first — and the proof does not lean on the same env-derived value that produced
// the path. Returns null when `resolved` is safe, else the reason it is not.
function sandboxPathProblem(resolved) {
  // The order matters: the SAFETY checks that do not depend on $TMPDIR run FIRST, so a
  // rejection reason names the real hazard rather than whichever identity check happened
  // to notice a mismatch on the way past.
  if (!resolved) return 'empty path';
  if (!path.isAbsolute(resolved)) return 'not an absolute path';
  if (resolved === path.parse(resolved).root) return 'is the filesystem root';
  const parent = path.dirname(resolved);
  if (parent === resolved) return 'has no parent directory';

  // --- env-INDEPENDENT: never the repo, never inside it, never above it --------------
  if (resolved === REPO_REAL) return 'is the repo checkout itself';
  if (isInside(REPO_REAL, resolved)) return `is inside the repo checkout (${REPO_REAL})`;
  if (isInside(resolved, REPO_REAL)) return `contains the repo checkout (${REPO_REAL})`;

  // --- env-INDEPENDENT: never the home directory, never sitting directly in it -------
  for (const home of HOME_PATHS) {
    if (resolved === home) return `is the home directory (${home})`;
    if (parent === home) return `sits directly in the home directory (${home})`;
    if (isInside(resolved, home)) return `contains the home directory (${home})`;
  }

  // --- env-INDEPENDENT: never a top-level directory ---------------------------------
  if (parent === path.parse(resolved).root) return 'is a top-level directory';

  // --- identity: exactly our namespaced name, exactly one level under the temp root --
  if (path.basename(resolved) !== SANDBOX_BASENAME) {
    return `basename is not ${JSON.stringify(SANDBOX_BASENAME)}`;
  }
  if (parent !== TMP_ROOT) return `parent is not the validated temp root (${TMP_ROOT})`;
  return null;
}

function assertSafeSandboxPath(p) {
  const resolved = path.resolve(p);
  const problem = sandboxPathProblem(resolved);
  if (problem) {
    throw new Error(`refusing to delete ${JSON.stringify(resolved)}: it ${problem}`);
  }
  if (resolved !== SANDBOX) {
    throw new Error(`refusing to delete a path that is not this run's sandbox: ` +
      `${JSON.stringify(resolved)} !== ${JSON.stringify(SANDBOX)}`);
  }
  return resolved;
}

// Validate the computed sandbox at LOAD time, so a hostile environment fails before any
// caller can reach a filesystem operation.
{
  const problem = sandboxPathProblem(SANDBOX);
  if (problem) {
    throw new Error(`e2e sandbox path ${JSON.stringify(SANDBOX)} is unusable: it ${problem}`);
  }
}

// A failed wipe is NOT ignorable. The whole "rebuilt from scratch on each run" invariant —
// and with it every screenshot baseline — depends on this actually emptying the tree; and
// an EPERM here is the exact signature of somebody else's directory sitting on our name.
function rmrf(p) {
  const safe = assertSafeSandboxPath(p);
  try {
    fs.rmSync(safe, { recursive: true, force: true });
  } catch (e) {
    throw new Error(
      `e2e sandbox: failed to wipe ${safe} (${e.code || e.message}). The suite refuses to ` +
      'seed on top of a tree it could not empty — stale rows would silently rewrite the ' +
      'screenshot baselines, and a directory we cannot delete is not a directory we own.');
  }
  let leftover = null;
  try { leftover = fs.lstatSync(safe); } catch { /* gone, as intended */ }
  if (leftover) {
    throw new Error(`e2e sandbox: ${safe} still exists after the wipe; refusing to continue.`);
  }
}

// Create the sandbox root fail-closed. NON-recursive on purpose: `recursive: true` treats
// a pre-existing directory as success and leaves its mode untouched, which is precisely
// the hole another local user pre-creating /tmp/<our-name> 0777 walks through.
function makeSandboxRoot() {
  fs.mkdirSync(SANDBOX, { mode: 0o700 });   // EEXIST throws — nothing may pre-exist here
  if (typeof process.getuid === 'function') {
    // mkdir's mode is masked by umask; an exotic umask must not silently widen this.
    fs.chmodSync(SANDBOX, 0o700);
  }
  assertPrivateDir(SANDBOX);
}

function assertPrivateDir(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) {
    throw new Error(`e2e sandbox: ${p} is missing right after creation (${e.code || e.message})`);
  }
  if (st.isSymbolicLink()) throw new Error(`e2e sandbox: ${p} is a symlink; refusing to use it`);
  if (!st.isDirectory()) throw new Error(`e2e sandbox: ${p} is not a directory`);
  // POSIX only — process.getuid is undefined on Windows, where ACLs already scope the
  // per-user temp dir and there is no mode to check.
  if (typeof process.getuid === 'function') {
    const uid = process.getuid();
    if (st.uid !== uid) {
      throw new Error(`e2e sandbox: ${p} is owned by uid ${st.uid}, not ${uid}; refusing to use it`);
    }
    const mode = st.mode & 0o7777;
    if (mode !== 0o700) {
      throw new Error(`e2e sandbox: ${p} has mode 0${mode.toString(8)}, expected 0700`);
    }
  }
}

// --- the run lock ------------------------------------------------------------------
// One exclusive holder per (user, checkout) for the lifetime of the process that seeded.
// A second invocation now fails LOUDLY instead of recursively deleting a live run's
// token, database and event store out from under it.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // alive, just not ours to signal
}

let lockHeld = false;

function releaseRunLock() {
  if (!lockHeld) return;
  lockHeld = false;
  try {
    const holder = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (holder.pid !== process.pid) return;   // someone reclaimed it; not ours to remove
  } catch { return; }
  try { fs.unlinkSync(LOCK_PATH); } catch { /* best effort on the way out */ }
}

function acquireRunLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' is O_CREAT|O_EXCL: atomic, and it refuses an existing path INCLUDING a
      // dangling symlink, so this cannot be turned into an arbitrary write.
      const fd = fs.openSync(LOCK_PATH, 'wx', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({
          pid: process.pid, startedAt: Date.now(), repo: REPO_REAL, sandbox: SANDBOX,
        }));
      } finally { fs.closeSync(fd); }
      lockHeld = true;
      // 'exit' only — deliberately NO signal handlers. Playwright installs its own
      // SIGINT handling to tear the uvicorn webServer down, and a handler of ours that
      // raced it could leave an orphaned gateway holding the port. A lock leaked by
      // Ctrl-C or SIGKILL is not a wedge: the next run sees the holder pid is dead and
      // reclaims it (the stale-reclaim path below).
      process.once('exit', releaseRunLock);
      return LOCK_PATH;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw new Error(`e2e sandbox: cannot create run lock ${LOCK_PATH} (${e.code || e.message})`);
      }
    }

    // Occupied. Fail closed unless the holder is PROVABLY gone.
    let lst;
    try { lst = fs.lstatSync(LOCK_PATH); } catch { continue; }   // vanished — retry
    if (!lst.isFile()) {
      throw new Error(`e2e sandbox: run lock ${LOCK_PATH} is not a regular file. ` +
        `Refusing to wipe ${SANDBOX}. Inspect and remove it by hand.`);
    }
    if (typeof process.getuid === 'function' && lst.uid !== process.getuid()) {
      throw new Error(`e2e sandbox: run lock ${LOCK_PATH} is owned by uid ${lst.uid}, ` +
        `not ${process.getuid()}. Refusing to wipe ${SANDBOX}.`);
    }
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')); } catch { /* unreadable */ }
    if (!holder || !Number.isInteger(holder.pid)) {
      throw new Error(`e2e sandbox: run lock ${LOCK_PATH} is unreadable, so this run cannot ` +
        `prove nobody else owns ${SANDBOX}. Remove the lock by hand once you are sure.`);
    }
    if (holder.pid !== process.pid && pidAlive(holder.pid)) {
      throw new Error(
        `e2e sandbox: another Playwright run (pid ${holder.pid}, started ` +
        `${new Date(holder.startedAt).toISOString()}) already owns ${SANDBOX}. ` +
        'Seeding starts by recursively deleting that directory, which would destroy the ' +
        "live run's metrics.db, dash.token and event store mid-run — so this run is " +
        `stopping instead. Wait for it to finish, or delete ${LOCK_PATH} if you are ` +
        'certain that process is gone.');
    }
    // Provably stale (holder is dead, or it is this very process re-seeding): reclaim.
    try { fs.unlinkSync(LOCK_PATH); } catch (e) {
      throw new Error(`e2e sandbox: cannot clear the stale run lock ${LOCK_PATH} (${e.code || e.message})`);
    }
  }
  throw new Error(`e2e sandbox: could not acquire the run lock ${LOCK_PATH}`);
}

// seed.json carries the dashboard TOKEN, so it is written 0600 and read back through one
// place — no caller re-derives the path.
function readSeedInfo() {
  return JSON.parse(fs.readFileSync(SEED_INFO_PATH, 'utf8'));
}

function ev(over) {
  const base = {
    v: 1, rev: 1, w: 'cli', inst: 'e2e00001',
    tzo: 0, prov: 'transcript', usrc: 'body', conf: 'estimated',
    harness: 'claude-code', sub: true,
    served: 'claude-haiku-4-5', req: null, base: 'claude-opus-5',
    bsrc: 'tx_session_ceiling', elig: true, ctier: 'haiku', cver: 3, reason: '',
    in: 120000, out: 8000, cr: 450000, c5: 12000, c1: 0, cu: 0,
    speed: null, svc: 'standard', status: 200,
    sfile: 'a71c3f9e0b42', sbase: 'agent-ac0bf522.jsonl', fsha: '9a41c0d7e2', vok: true,
  };
  const e = Object.assign(base, over);
  e.pday = new Date(e.ts + e.tzo * 60000).toISOString().slice(0, 10);
  e.ingested_at = e.ts + 1000;
  if (!e.sessions) e.sessions = [e.sess || 'sess-e2e-1'];
  if (!e.sess) e.sess = e.sessions[0];
  if (!e.id) e.id = 'rid:' + crypto.createHash('sha256')
    .update(String(e.ts) + e.served + e.sess + String(e.in) + String(e.out))
    .digest('hex').slice(0, 24);
  return e;
}

// `now` is pinned by the caller so the ladder windows are reproducible run to run.
function buildEvents(now) {
  const DAY = 86400000;
  const rows = [];

  // --- Today: a normal routed sub-agent call, plus one kept main-loop turn. --------
  rows.push(ev({ ts: now - 3 * 3600000, sess: 'sess-today-1' }));
  rows.push(ev({ ts: now - 2 * 3600000, sess: 'sess-today-1',
                 served: 'claude-opus-5', elig: false, ctier: 'opus', sub: false,
                 in: 40000, out: 3000, cr: 900000, c5: 30000 }));
  // A MEASURED row — the gateway observed it from a response body. Rendered in its own
  // column, never added to the estimated ones.
  rows.push(ev({ ts: now - 90 * 60000, sess: 'sess-today-1', prov: 'gateway',
                 conf: 'measured', req: 'claude-opus-5', reason: 'simple lookup',
                 served: 'claude-haiku-4-5', in: 900, out: 1200, cr: 210000, c5: 0 }));

  // --- Earlier this week ------------------------------------------------------------
  for (let i = 1; i <= 3; i++) {
    rows.push(ev({ ts: now - i * DAY - 5 * 3600000, sess: 'sess-week-' + i,
                   in: 60000 + i * 1000, out: 4000 + i * 100, cr: 300000 }));
  }
  // A NEGATIVE delta: routed work that cost MORE than the baseline. The sign must
  // survive to the screen; a max(0, …) anywhere would hide it.
  rows.push(ev({ ts: now - 2 * DAY - 3600000, sess: 'sess-week-neg',
                 served: 'claude-fable-5', base: 'claude-opus-5', ctier: 'opus',
                 in: 200000, out: 40000, cr: 0, c5: 0 }));

  // --- Earlier this month -----------------------------------------------------------
  for (let i = 8; i <= 12; i++) {
    rows.push(ev({ ts: now - i * DAY, sess: 'sess-month-' + i,
                   served: 'claude-sonnet-5', ctier: 'sonnet',
                   in: 30000, out: 9000, cr: 800000, c5: 20000 }));
  }

  // --- Edge cases -------------------------------------------------------------------
  // UNPRICEABLE served model: the cell must be an em dash with a tooltip, NEVER $0.00.
  rows.push(ev({ ts: now - 4 * DAY, sess: 'sess-unpriced',
                 served: 'some-unreleased-model-x9', ctier: 'sonnet' }));
  // Non-2xx: recorded, never priced. Claude Code retries automatically and each retry
  // gets a distinct provider id, so the key cannot collapse them.
  rows.push(ev({ ts: now - 5 * DAY, sess: 'sess-429', status: 429 }));
  // ---- the timezone-frame regression, as live data --------------------------------
  //
  // The catalog carries claude-sonnet-5 at a promotional $2/$10 from 2026-01-01 through
  // 2026-08-31, against a standard $3/$15. The defect was that pricing resolved on the
  // UTC date while the calendar bucketed on LOCAL midnight, so a call could be priced
  // in one month and reported in another — a live ±50% error on 1M-in/1M-out.
  //
  // BOTH boundaries are seeded, because they fail in OPPOSITE directions and a fixture
  // that only covers one proves half the fix:
  //
  //   window START — local 2025-12-31 23:30 -07:00 is UTC 2026-01-01 06:30.
  //     LOCAL day (2025-12-31) is OUTSIDE the promo -> correct price is $18.00.
  //     A UTC-based implementation reads 2026-01-01, inside it, and charges $12.00.
  //     This one is in the PAST, so it always runs.
  //
  //   window END — local 2026-08-31 23:30 -07:00 is UTC 2026-09-01 06:30.
  //     LOCAL day is INSIDE the promo -> correct price is $12.00; UTC reads September
  //     and charges $18.00. Seeded only once that instant has passed, since a
  //     future-dated row is (correctly) quarantined by the skew guard.
  const promoStartTs = Date.parse('2025-12-31T23:30:00-07:00');
  rows.push(ev({ ts: promoStartTs, tzo: -420, sess: 'sess-promo-before',
                 served: 'claude-sonnet-5', base: 'claude-opus-5', ctier: 'sonnet',
                 in: 1000000, out: 1000000, cr: 0, c5: 0 }));
  const promoEndTs = Date.parse('2026-08-31T23:30:00-07:00');
  if (Number.isFinite(promoEndTs) && promoEndTs < now) {
    rows.push(ev({ ts: promoEndTs, tzo: -420, sess: 'sess-promo',
                   served: 'claude-sonnet-5', base: 'claude-opus-5', ctier: 'sonnet',
                   in: 1000000, out: 1000000, cr: 0, c5: 0 }));
  }
  // Last year, so "Before this year" is not an empty row.
  rows.push(ev({ ts: now - 400 * DAY, sess: 'sess-old', in: 20000, out: 2000, cr: 100000 }));

  return rows;
}

function seed(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  // Claim the (user, checkout) lock BEFORE the recursive delete, not after.
  acquireRunLock();
  rmrf(SANDBOX);
  makeSandboxRoot();
  const home = path.join(SANDBOX, 'home');
  const eventsDir = path.join(home, '.cheaper', 'events');
  // Recursive is fine below the root: makeSandboxRoot() just proved the root is a fresh,
  // 0700, self-owned directory, so nothing under it can pre-exist.
  fs.mkdirSync(eventsDir, { recursive: true, mode: 0o700 });

  // --- the per-call event store ---------------------------------------------------
  const rows = buildEvents(now);
  const byMonth = new Map();
  for (const r of rows) {
    const d = new Date(r.ts);
    const ym = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    const w = r.prov === 'gateway' ? 'gw' : 'cli';
    const key = `${ym}.e2e00001.${w}.jsonl`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(r);
  }
  for (const [name, rs] of byMonth) {
    fs.writeFileSync(path.join(eventsDir, name),
      rs.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  }

  // Coverage, WITH A DELIBERATE GAP.
  //
  // Two intervals, not one: an old backfilled island around the 400-day-old event, and
  // the recent observed run. Everything between them — most of this calendar year — is
  // genuinely NOT COVERED, which is the state the product must be able to express and
  // must never render as "$0.00 saved". A single from-earliest-to-latest interval would
  // declare the whole year watched and make that path untestable.
  const ts = rows.map((r) => r.ts).sort((a, b) => a - b);
  const oldest = ts[0];
  const newest = ts[ts.length - 1];
  // 20 days back: far enough to cover every recent fixture row, close enough that the
  // "Earlier this year" ladder window (Jan 1 → Jul 1) falls entirely OUTSIDE it and
  // reports `not_covered` — the state the suite has to be able to observe.
  const recentStart = now - 20 * 86400000;
  fs.writeFileSync(path.join(eventsDir, 'state.json'), JSON.stringify({
    v: 1,
    coverage: [
      { kind: 'backfilled', from: oldest - 3600000, to: oldest + 3600000, harness: 'claude-code' },
      { kind: 'observed', from: recentStart, to: newest + 86400000, harness: 'claude-code' },
    ],
    tombstones: [],
    ingested_files: [],
  }), { mode: 0o600 });

  // --- the legacy chat-grain store: a THIRD visual state, never summed with the two
  //     bases above. Dollars frozen, timestamp known-imprecise, no period bucket.
  fs.writeFileSync(path.join(home, '.cheaper', 'legacy_chats.json'), JSON.stringify({
    v: 1, imported_at: now,
    chats: {
      '3d0afc92-legacy-a': { usd: 3.7122, tokens: 6343704, exact: false,
                             at: new Date(now - 30 * 86400000).toISOString(),
                             derivation: 'frozen', bucket_confidence: 'unknown' },
      '8c60b680-legacy-b': { usd: 1.2044, tokens: 2110900, exact: false,
                             at: new Date(now - 31 * 86400000).toISOString(),
                             derivation: 'frozen', bucket_confidence: 'unknown' },
    },
  }), { mode: 0o600 });

  // --- the proxy's own metrics.db, so Dashboard/Monitor have live rows -------------
  const db = path.join(home, '.cheaper', 'metrics.db');
  const py = `
import os, sys, time
sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'cli', 'assets', 'gateway', 'app'))})
os.environ['CHEAPER_DB'] = ${JSON.stringify(db)}
from metrics import Metrics
m = Metrics(db_path=${JSON.stringify(db)})
now = ${Math.floor(now / 1000)}
rows = [
  # usage_source NULL, deliberately. This is the state of EVERY row on the machine that
  # produced the "unmeasured dollars published as measured" defect: nothing on that
  # gateway had ever carried provider-reported usage, so its headline saving was
  # reconstructed from what each request asked for rather than read off the bill.
  #
  # NULL is priceable (see metrics.row_is_priceable — only 'estimate' and a non-2xx status
  # are excluded), so this row still contributes exactly the same dollars it did as
  # 'body'. What it changes is the BASIS: with one priced row unmeasured, summary()'s
  # dollars_basis is "mixed" rather than "measured", which is the state the dashboard has
  # to qualify. A fixture that is 100% 'body' can only ever exercise the flattering path.
  ('haiku','claude-haiku-4-5','claude-opus-5','opus','simple lookup','claude-code',900,1200,200,None,'req_e2e_1',210000,0,0),
  ('haiku','claude-haiku-4-5','claude-opus-5','opus','simple lookup','claude-code',1100,900,200,'body','req_e2e_2',180000,0,0),
  ('sonnet','claude-sonnet-5','claude-opus-5','opus','moderate refactor','claude-code',30000,9000,200,'body','req_e2e_3',800000,20000,0),
  ('opus','claude-opus-5','claude-opus-5','opus','correctness-critical','claude-code',40000,3000,200,'body','req_e2e_4',900000,30000,0),
  ('haiku','claude-haiku-4-5','claude-opus-5','opus','retry storm','claude-code',0,0,429,'body','req_e2e_5',0,0,0),
  ('sonnet','claude-sonnet-5','claude-opus-5','opus','streamed, usage unknown','cursor (openai)',None,None,200,'estimate','req_e2e_6',0,0,0),
]
for i,(tier,model,om,rt,reason,src,it,ot,st,us,rid,cr,c5,c1) in enumerate(rows):
    m.record(tier=tier, model=model, original_model=om, requested_tier=rt, reason=reason,
             source=src, in_tokens=it, out_tokens=ot, status=st, usage_source=us,
             request_id=rid, cache_read=cr, cache_create_5m=c5, cache_create_1h=c1,
             session='sess-today-1', requested_effort='none', ts=now - (len(rows)-i)*300)
print('seeded', m.summary()['total'])
`;
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error('metrics.db seed failed:\n' + (r.stderr || r.stdout));
  }

  // The gateway mints dash.token itself on import; pre-create it so the Playwright
  // fixture can read a stable value without racing start-up.
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(home, '.cheaper', 'dash.token'), token, { mode: 0o600 });

  const info = {
    sandbox: SANDBOX, home, eventsDir, db, token, now, events: rows.length, lock: LOCK_PATH,
  };
  // Written here rather than by the caller so the 0600 can never be forgotten: this file
  // contains `token`, the same-machine credential the gateway enforces.
  fs.writeFileSync(SEED_INFO_PATH, JSON.stringify(info, null, 2), { mode: 0o600 });
  return info;
}

module.exports = {
  seed, buildEvents, readSeedInfo,
  SANDBOX, SANDBOX_BASENAME, LOCK_PATH, SEED_INFO_PATH, TMP_ROOT, REPO_REAL, CHECKOUT_ID,
  // Exported for the guard tests only — exercised directly so each rejection can be
  // proved without needing a hostile filesystem.
  __guards: {
    sandboxPathProblem, tempRootProblem, isInside,
    assertSafeSandboxPath, assertPrivateDir, makeSandboxRoot, rmrf, acquireRunLock,
  },
};

if (require.main === module) {
  const out = seed();
  console.log(JSON.stringify(out, null, 2));
}
