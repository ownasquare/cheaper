'use strict';
// Human-readable rendering of the freshness report, plus the one-line nudge other
// commands use. Kept separate from freshness.js so the detection logic has no
// terminal-formatting dependencies and stays trivially testable.

const { c } = require('./util');
const { report } = require('./freshness');

// COLOUR IS THE WHOLE INTERFACE HERE. A reader scans this block for something that is
// not green and stops there; anything rendered green is, in practice, not read. So a
// state that needs action must never be green, and a state that could not be CHECKED
// must never be green either:
//
//   stopped     the gateway is installed and current but is not running. This was
//               `ok` -> green('current') with the words "not running" dimmed beside
//               it, which is how a completely dead router read as healthy.
//   broken      present but structurally wrong — a wiped settings key, a registry
//               entry pointing at a deleted directory. Red, because unlike 'stale'
//               nothing is merely out of date: the feature is off.
//   unverified  the check COULD NOT RUN (unreadable/unparseable file). Amber, never
//               green and never dim: "could not determine" must not read as "fine",
//               and it is not the same claim as "broken" either.
const MARK = {
  ok: () => c.green('current'),
  stale: () => c.amber('STALE'),
  restart: () => c.amber('RESTART NEEDED'),
  stopped: () => c.amber('STOPPED'),
  broken: () => c.red('BROKEN'),
  unverified: () => c.amber('CANNOT VERIFY'),
  missing: () => c.dim('not installed'),
  unknown: () => c.dim('unknown'),
};

// States that mean "a human has to do something", as opposed to 'missing' (a component
// this user never asked for) and 'ok'.
const NEEDS_ACTION = new Set(['stale', 'restart', 'stopped', 'broken', 'unverified']);

// The single most useful sentence: what needs attention and the exact command to fix it.
// Returns '' when everything that is installed is current, running, and verifiable.
//
// Staleness keeps its own aggregated sentence because its remedy is shared across
// components ("install then restart", in that order). The rest carry their own remedy
// in their hint and are named individually — an aggregated "out of date" line would be
// a lie about a gateway that is merely stopped, or about a check that never ran.
function summarize(rep) {
  const stale = rep.items.filter((i) => i.state === 'stale' || i.state === 'restart');
  const parts = [];
  if (stale.length) {
    // Union the remedies across components. Order matters: installing after a restart
    // would leave the freshly-started process holding the pre-install code again.
    const needInstall = stale.some((i) => (i.hint || '').includes('install'));
    const needRestart = stale.some((i) => (i.hint || '').includes('restart'));
    const cmds = [];
    if (needInstall) cmds.push('cheaper install --all');
    if (needRestart) cmds.push('cheaper gateway restart');
    parts.push(`${stale.map((i) => i.label).join(', ')} out of date — run: ${cmds.join(' && ')}`);
  }
  for (const i of rep.items) {
    if (i.state === 'stale' || i.state === 'restart') continue;
    if (NEEDS_ACTION.has(i.state)) parts.push(`${i.label}: ${i.hint}`);
  }
  return parts.join('; ');
}

async function print(opts = {}) {
  const rep = await report();
  console.log('');
  console.log(c.dim('  freshness') + c.dim('  — is what is RUNNING what you BUILT?'));
  for (const i of rep.items) {
    const mark = (MARK[i.state] || MARK.unknown)();
    console.log('  ' + i.label.padEnd(28) + mark + c.dim('  ' + i.hint));
    if (opts.verbose) {
      console.log(c.dim('      source=' + (i.source || '-')
        + ' installed=' + (i.installed || '-')
        + (i.running !== undefined ? ' running=' + (i.running || '-') : '')));
    }
  }
  // A registry copy shadowing the working tree means every `install --all` deploys
  // someone else's build while your edits sit unused — silent and very confusing.
  if (rep.cli && !rep.cli.linked) {
    console.log('  ' + c.amber('note') + c.dim(' the running `cheaper` has no assets/ dir — '
      + 'it may be a published copy shadowing your checkout (' + rep.cli.dir + ')'));
  }
  const s = summarize(rep);
  if (s) console.log('\n  ' + c.amber('!') + ' ' + s);
  return rep;
}

// MARK is exported so a test can assert the COLOUR a state renders in, not merely its
// words. The P0.5 defect had entirely correct words ("not running") in green ink, and a
// text-only assertion would have passed on it.
module.exports = { print, summarize, MARK, NEEDS_ACTION };
