'use strict';
// Human-readable rendering of the freshness report, plus the one-line nudge other
// commands use. Kept separate from freshness.js so the detection logic has no
// terminal-formatting dependencies and stays trivially testable.

const { c } = require('./util');
const { report } = require('./freshness');

const MARK = {
  ok: () => c.green('current'),
  stale: () => c.amber('STALE'),
  restart: () => c.amber('RESTART NEEDED'),
  missing: () => c.dim('not installed'),
  unknown: () => c.dim('unknown'),
};

// The single most useful sentence: what is out of date and the exact command to fix it.
// Returns '' when everything that is installed is current.
function summarize(rep) {
  const bad = rep.items.filter((i) => i.state === 'stale' || i.state === 'restart');
  if (!bad.length) return '';
  // Union the remedies across components. Order matters: installing after a restart
  // would leave the freshly-started process holding the pre-install code again.
  const needInstall = bad.some((i) => (i.hint || '').includes('install'));
  const needRestart = bad.some((i) => (i.hint || '').includes('restart'));
  const cmds = [];
  if (needInstall) cmds.push('cheaper install --all');
  if (needRestart) cmds.push('cheaper gateway restart');
  return `${bad.map((i) => i.label).join(', ')} out of date — run: ${cmds.join(' && ')}`;
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

module.exports = { print, summarize };
